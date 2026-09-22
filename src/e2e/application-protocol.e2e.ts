import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createPackage } from "@electron/asar";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { CloudDeploymentAPI } from "../shared/cloud-deployment-ipc.js";
import type { ApplicationZoomAPI } from "../shared/application-zoom-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";

const RENDERER_URL = "sliver://app/index.html";
const CLOUD_URL = `${RENDERER_URL}?surface=cloud-deployment`;

interface PolicyViolation {
  directive: string;
  blockedURI: string;
}

interface ProtocolBrowser {
  sliver: SliverDesktopAPI;
  cloudDeployment: CloudDeploymentAPI;
  applicationZoom: ApplicationZoomAPI;
  __protocolViolations: PolicyViolation[];
  location: { href: string; origin: string };
  document: {
    addEventListener(type: string, listener: (event: {
      effectiveDirective: string;
      blockedURI: string;
    }) => void): void;
    fonts: { load(value: string): Promise<unknown[]>; check(value: string): boolean };
    styleSheets: ArrayLike<{ href: string | null; cssRules: ArrayLike<unknown> }>;
  };
  WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> };
}

test("sliver protocol serves built assets and isolated windows with strict CSP and trusted IPC", {
  timeout: 60_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-protocol-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "client-root");
  const outsideFile = join(temporaryRoot, "outside-renderer.txt");
  const rendererArchive = join(temporaryRoot, "renderer.asar");
  await Promise.all([
    ...[savedConfigDirectory, managedConfigDirectory, userDataDirectory, consoleClientRootDirectory]
      .map((directory) => mkdir(directory, { recursive: true })),
    writeFile(outsideFile, "benign protocol confinement fixture", { mode: 0o600 }),
  ]);

  let application: ElectronApplication | undefined;
  let applicationProcess: ChildProcess | undefined;
  let stage = "launch";
  const diagnostics = process.env["SLIVER_GUI_PROTOCOL_DIAGNOSTICS"] === "1";
  const mark = (value: string): void => {
    stage = value;
    if (diagnostics) process.stderr.write(`[protocol] ${value}\n`);
  };
  context.signal.addEventListener("abort", () => {
    if (applicationProcess?.exitCode === null && applicationProcess.signalCode === null) {
      process.stderr.write(`[protocol] test ended during ${stage}; terminating its remaining fixture process\n`);
      applicationProcess.kill("SIGKILL");
    }
  }, { once: true });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  try {
    mark("seed saved host zoom");
    await seedSavedHostZoom(temporaryRoot, userDataDirectory);
    mark("launch");
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
        `--console-client-root-directory=${consoleClientRootDirectory}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    applicationProcess = application.process();
    if (diagnostics) applicationProcess.stderr?.on("data", (data: Buffer) => process.stderr.write(data));
    mark("first window");
    const page = await application.firstWindow();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    const mainWindow = await application.browserWindow(page);
    assert.equal(await mainWindow.evaluate((window) => window.webContents.getZoomFactor()), 1,
      "the main app starts at 100% zoom despite its saved 110% host zoom");
    assert.equal(await page.evaluate(() => (globalThis as unknown as ProtocolBrowser).applicationZoom.getFactor()), 1,
      "the renderer reports 100% zoom after startup normalization");
    await page.context().addInitScript(() => {
      const browser = globalThis as unknown as ProtocolBrowser;
      browser.__protocolViolations = [];
      browser.document.addEventListener("securitypolicyviolation", (event) => {
        browser.__protocolViolations.push({
          directive: event.effectiveDirective,
          blockedURI: event.blockedURI,
        });
      });
    });
    // Reload after attaching the observer so module startup and component style
    // creation are covered by the same CSP enforced for the production app.
    await page.reload();
    mark("initial renderer assets and policy");
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    assert.equal(await mainWindow.evaluate((window) => window.webContents.getZoomFactor()), 1,
      "reloading keeps the default 100% zoom");
    assert.equal(page.url(), RENDERER_URL);
    await assertBuiltAssets(page);
    await assertStrictPolicy(page);

    mark("manual zoom");
    await mainWindow.evaluate((window) => window.webContents.setZoomFactor(1.1));
    await page.reload();
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    assert.equal(await mainWindow.evaluate((window) => window.webContents.getZoomFactor()), 1.1,
      "reloading preserves a manually selected zoom level");
    await mainWindow.evaluate((window) => window.webContents.setZoomFactor(1));

    mark("settings and terminal runtime");
    const settingsResult = await page.evaluate(async () => {
      const { sliver, location } = globalThis as unknown as ProtocolBrowser;
      const settings = await sliver.getApplicationSettings();
      const update = await sliver.updateApplicationSettings({
        expectedRevision: settings.revision,
        settings: {
          theme: "light",
          appIcon: settings.appIcon,
          reduceMotion: true,
          commandPaletteShortcut: settings.commandPaletteShortcut,
          keyboardShortcuts: settings.keyboardShortcuts,
          terminal: settings.terminal,
        },
      });
      const runtime = await sliver.getTerminalRuntime();
      if (!runtime.ok) throw new Error(runtime.error);
      await (globalThis as unknown as ProtocolBrowser).WebAssembly.compile(runtime.value.bytes);
      return {
        origin: location.origin,
        bridgeFrozen: Object.isFrozen(sliver),
        update,
        wasmBytes: runtime.value.bytes.byteLength,
      };
    });
    assert.equal(settingsResult.origin, "sliver://app");
    assert.equal(settingsResult.bridgeFrozen, true);
    assert.equal(settingsResult.update.ok, true);
    assert.ok(settingsResult.wasmBytes > 0);
    await page.locator("html.light[data-reduce-motion='true']").waitFor();

    mark("cloud window");
    const cloudOpened = application.waitForEvent("window");
    await page.getByRole("button", { name: "Cloud Deployment", exact: true }).click();
    const cloudPage = await cloudOpened;
    cloudPage.on("pageerror", (error) => pageErrors.push(error.message));
    cloudPage.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await cloudPage.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor();
    assert.equal(cloudPage.url(), CLOUD_URL);
    await assertBuiltAssets(cloudPage);
    await assertStrictPolicy(cloudPage);
    const cloudState = await cloudPage.evaluate(async () => {
      const browser = globalThis as unknown as ProtocolBrowser;
      const snapshot = await browser.cloudDeployment.getSnapshot();
      const runtime = await browser.cloudDeployment.getTerminalRuntime();
      if (!runtime.ok) throw new Error(runtime.error);
      await browser.WebAssembly.compile(runtime.value.bytes);
      return {
        origin: browser.location.origin,
        bridgeFrozen: Object.isFrozen(browser.cloudDeployment),
        mainBridgeType: typeof browser.sliver,
        snapshotAvailable: snapshot.ok,
      };
    });
    assert.deepEqual(cloudState, {
      origin: "sliver://app",
      bridgeFrozen: true,
      mainBridgeType: "undefined",
      snapshotAvailable: true,
    });
    const sessions = await application.evaluate(async ({ BrowserWindow, session }, urls) => {
      const mainWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === urls.main);
      const cloudWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === urls.cloud);
      if (!mainWindow || !cloudWindow) throw new Error("Expected both renderer windows");
      return {
        separateSessions: mainWindow.webContents.session !== cloudWindow.webContents.session,
        cloudPartition: cloudWindow.webContents.session === session.fromPartition("sliver-cloud-deployment"),
        mainHandler: await mainWindow.webContents.session.protocol.isProtocolHandled("sliver"),
        cloudHandler: await cloudWindow.webContents.session.protocol.isProtocolHandled("sliver"),
      };
    }, { main: RENDERER_URL, cloud: CLOUD_URL });
    assert.deepEqual(sessions, {
      separateSessions: true,
      cloudPartition: true,
      mainHandler: true,
      cloudHandler: true,
    });
    mark("ASAR assets");
    await createPackage(join(repositoryRoot, "dist/renderer"), rendererArchive);
    const cssPath = await page.locator('link[rel="stylesheet"]').getAttribute("href");
    assert.ok(cssPath);
    const archiveResponses = await application.evaluate(async ({ net, session }, input) => {
      const archiveSession = session.fromPartition("sliver-protocol-asar-e2e");
      archiveSession.protocol.handle("sliver", globalThis.__SLIVER_GUI_PROTOCOL_E2E_HANDLER__(
        input.archive,
        (url) => net.fetch(url),
      ));
      try {
        return await Promise.all([input.indexUrl, input.cssUrl].map(async (url) => {
          const response = await archiveSession.fetch(url);
          return {
            status: response.status,
            contentType: response.headers.get("content-type"),
            csp: response.headers.get("content-security-policy"),
            contentLength: (await response.arrayBuffer()).byteLength,
          };
        }));
      } finally {
        archiveSession.protocol.unhandle("sliver");
      }
    }, {
      archive: rendererArchive,
      indexUrl: RENDERER_URL,
      cssUrl: new URL(cssPath, RENDERER_URL).href,
    });
    assert.deepEqual(archiveResponses.map((response) => response.status), [200, 200]);
    assert.deepEqual(archiveResponses.map((response) => response.contentType), [
      "text/html; charset=utf-8",
      "text/css; charset=utf-8",
    ]);
    for (const response of archiveResponses) {
      assert.ok(response.contentLength > 0, "ASAR assets must contain their file bytes");
      assert.ok(response.csp);
      assert.deepEqual(response.csp.match(/'[^']*unsafe[^']*'/gu), ["'wasm-unsafe-eval'"]);
    }
    mark("ASAR module worker");
    await assertPackagedModuleWorker(application, temporaryRoot);

    mark("final policy assertions");
    for (const renderer of [page, cloudPage]) {
      const violations = await renderer.evaluate(() => (
        globalThis as unknown as ProtocolBrowser
      ).__protocolViolations);
      assert.deepEqual(violations, [],
        `unexpected CSP violation in ${renderer.url()}; style elements: ${JSON.stringify(await renderer.locator("style").allTextContents())}`);
      assert.equal(await renderer.evaluate(async (url) => {
        try {
          await fetch(url);
          return false;
        } catch {
          return true;
        }
      }, pathToFileURL(outsideFile).href), true, "direct file reads must be denied");
    }
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    process.stderr.write(`[protocol] failed during ${stage}\n${consoleErrors.join("\n")}\n`);
    throw error;
  } finally {
    mark("application close");
    try {
      if (application) await closeProtocolApplication(application);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
});

async function closeProtocolApplication(application: ElectronApplication): Promise<void> {
  const applicationProcess = application.process();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      application.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          applicationProcess.kill("SIGKILL");
          reject(new Error("Protocol E2E application did not quit within 10 seconds"));
        }, 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function assertBuiltAssets(page: Page): Promise<void> {
  const moduleUrl = await page.locator('script[type="module"][src]').getAttribute("src");
  assert.ok(moduleUrl);
  assert.equal(new URL(moduleUrl, page.url()).protocol, "sliver:");
  assert.equal(new URL(moduleUrl, page.url()).host, "app");
  const stylesheets = await page.evaluate(() => Array.from(
    (globalThis as unknown as ProtocolBrowser).document.styleSheets,
    (sheet) => ({ href: sheet.href, ruleCount: sheet.cssRules.length }),
  ).filter((sheet) => sheet.href !== null));
  assert.ok(stylesheets.length > 0, "built external CSS must load");
  for (const stylesheet of stylesheets) {
    assert.equal(new URL(stylesheet.href!).protocol, "sliver:");
    assert.equal(new URL(stylesheet.href!).host, "app");
    assert.ok(stylesheet.ruleCount > 0);
  }
  const fonts = await page.evaluate(async (families) => {
    const { fonts } = (globalThis as unknown as ProtocolBrowser).document;
    return Promise.all(families.map(async (family) => (
      (await fonts.load(`13px "${family}"`)).length > 0 && fonts.check(`13px "${family}"`)
    )));
  }, ["Fira Code", "JetBrains Mono", "Cascadia Mono", "Source Code Pro"]);
  assert.deepEqual(fonts, [true, true, true, true]);
}

async function assertStrictPolicy(page: Page): Promise<void> {
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.ok(csp);
  assert.match(csp, /(?:^|;)\s*default-src 'none'(?:;|$)/u);
  assert.deepEqual(csp.match(/'[^']*unsafe[^']*'/gu), ["'wasm-unsafe-eval'"]);
  assert.match(csp, /(?:^|;)\s*connect-src 'none'(?:;|$)/u);
  assert.match(csp, /(?:^|;)\s*style-src 'self'(?: 'sha256-[A-Za-z0-9+/=]+')*(?:;|$)/u);
  assert.match(csp, /(?:^|;)\s*worker-src 'self'(?:;|$)/u);
}

async function seedSavedHostZoom(temporaryRoot: string, userDataDirectory: string): Promise<void> {
  const seedPath = join(temporaryRoot, "seed-zoom.cjs");
  // Playwright applies temporary frame zoom. Seed persisted host zoom in a
  // separate native Electron process before attaching browser automation.
  await writeFile(seedPath, `
    const { app, BrowserWindow, protocol, session } = require("electron");
    app.setPath("userData", process.argv.at(-1));
    app.setPath("sessionData", process.argv.at(-1));
    protocol.registerSchemesAsPrivileged([{
      scheme: "sliver",
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    }]);
    void app.whenReady().then(async () => {
      session.defaultSession.protocol.handle("sliver", () => new Response("<!doctype html><title>Zoom fixture</title>"));
      const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      await window.loadURL("sliver://app/index.html");
      window.webContents.setZoomLevel(0.5);
      app.quit();
    }).catch((error) => {
      console.error(error);
      app.exit(1);
    });
  `, { mode: 0o600 });
  const electronExecutable = createRequire(import.meta.url)("electron") as string;
  await promisify(execFile)(electronExecutable, ["--enable-sandbox", seedPath, userDataDirectory], { timeout: 15_000 });
  const preferences = JSON.parse(await readFile(join(userDataDirectory, "Preferences"), "utf8")) as {
    partition?: { per_host_zoom_levels?: Record<string, { app?: unknown }> };
  };
  assert.ok(Object.values(preferences.partition?.per_host_zoom_levels ?? {}).some((hosts) => hosts.app === 0.5),
    "the temporary profile must contain saved 110% zoom for the app host before launch");
}

async function assertPackagedModuleWorker(application: ElectronApplication, temporaryRoot: string): Promise<void> {
  const rendererDirectory = join(temporaryRoot, "worker-renderer");
  const archive = join(temporaryRoot, "worker-renderer.asar");
  await mkdir(rendererDirectory);
  await Promise.all([
    writeFile(join(rendererDirectory, "index.html"),
      '<!doctype html><title>Worker fixture</title><pre>Waiting</pre><script type="module" src="./entry.mjs"></script>'),
    writeFile(join(rendererDirectory, "entry.mjs"), `
      const worker = new Worker(new URL("./layout.worker.mjs", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }) => {
        document.querySelector("pre").textContent = JSON.stringify(data);
        worker.terminate();
      };
      worker.onerror = (event) => { document.querySelector("pre").textContent = event.message; };
      worker.postMessage([2, 3]);
    `),
    writeFile(join(rendererDirectory, "layout.worker.mjs"), `
      import { sum } from "./sum.mjs";
      self.onmessage = ({ data }) => self.postMessage({
        result: sum(data),
        origin: self.location.origin,
        nodeIntegration: typeof require !== "undefined" || typeof process !== "undefined",
      });
    `),
    writeFile(join(rendererDirectory, "sum.mjs"),
      "export const sum = (values) => values.reduce((total, value) => total + value, 0);"),
  ]);
  await createPackage(rendererDirectory, archive);

  const windowOpened = application.waitForEvent("window");
  const windowId = await application.evaluate(async ({ BrowserWindow, net, session }, archivePath) => {
    const workerSession = session.fromPartition("sliver-protocol-worker-e2e");
    workerSession.protocol.handle("sliver", globalThis.__SLIVER_GUI_PROTOCOL_E2E_HANDLER__(
      archivePath,
      (url) => net.fetch(url),
    ));
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        session: workerSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
      },
    });
    await window.loadURL("sliver://app/index.html");
    return window.id;
  }, archive);
  try {
    const page = await windowOpened;
    await page.locator("pre").filter({ hasText: '"result":5' }).waitFor({ timeout: 10_000 });
    assert.deepEqual(JSON.parse(await page.locator("pre").innerText()), {
      result: 5,
      origin: "sliver://app",
      nodeIntegration: false,
    });
    const violations = await page.evaluate(() => (
      globalThis as unknown as ProtocolBrowser
    ).__protocolViolations);
    assert.deepEqual(violations, [], "packaged module workers must load without relaxing the script or connection policy");
  } finally {
    await application.evaluate(({ BrowserWindow, session }, id) => {
      BrowserWindow.fromId(id)?.destroy();
      session.fromPartition("sliver-protocol-worker-e2e").protocol.unhandle("sliver");
    }, windowId);
  }
}
