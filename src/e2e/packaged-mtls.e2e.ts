import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import {
  PACKAGED_FIXTURE_EVENT_SECRET,
  PACKAGED_FIXTURE_TOKEN,
  startMtlsFixture,
  type MtlsFixture,
  verifyFixtureAuthenticationBoundary,
} from "./mtls-fixture.js";
import { redactDiagnosticText, stringifyRedactedDiagnostics } from "./diagnostic-redaction.js";

test("packaged production app completes current mTLS read and mutation flows", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const executablePath = await findPackagedExecutable(repositoryRoot);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-packaged-e2e-"));
  const isolatedHome = join(temporaryRoot, "home");
  const savedConfigDirectory = join(isolatedHome, ".sliver-client", "configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const configPath = join(savedConfigDirectory, "m0-packaged-operator.cfg");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  const fixture = await startMtlsFixture(repositoryRoot);
  const diagnosticRedactions = [
    PACKAGED_FIXTURE_TOKEN,
    PACKAGED_FIXTURE_EVENT_SECRET,
    fixture.caCertificate,
    fixture.clientCertificate,
    fixture.clientPrivateKey,
    configPath,
    temporaryRoot,
  ];
  await verifyFixtureAuthenticationBoundary(fixture);
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(configPath, packagedOperatorConfig(fixture), { mode: 0o600 });
  if (process.platform !== "win32") {
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, "operator config must be mode 0600");
    await access(executablePath, constants.X_OK);
  }

  let electronApplication: ElectronApplication | undefined;
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  try {
    const cleanEnvironment = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    try {
      electronApplication = await electron.launch({
        executablePath,
        args: ["--enable-sandbox", `--user-data-dir=${userDataDirectory}`],
        bypassCSP: false,
        chromiumSandbox: true,
        cwd: repositoryRoot,
        env: {
          ...cleanEnvironment,
          HOME: isolatedHome,
          USERPROFILE: isolatedHome,
          XDG_CONFIG_HOME: join(isolatedHome, ".config"),
          // A packaged application must ignore this development-only redirect.
          ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
        },
      } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    } catch (error) {
      await writePackagedDiagnosticArtifact(
        artifactDirectory,
        { phase: "launch", launchError: errorMessage(error) },
        diagnosticRedactions,
      ).catch((diagnosticError) => {
        console.error("Failed to write packaged launch diagnostics", errorMessage(diagnosticError));
      });
      throw error;
    }
    let page: Page;
    try {
      page = await electronApplication.firstWindow();
    } catch (error) {
      await writePackagedStartupDiagnostics({
        artifactDirectory,
        electronApplication,
        error,
        redactions: diagnosticRedactions,
      }).catch((diagnosticError) => {
        console.error("Failed to write packaged startup diagnostics", errorMessage(diagnosticError));
      });
      throw error;
    }
    // Keep overlay teardown deterministic; this smoke validates packaged RPC
    // behavior rather than animation timing on headless platform runners.
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    const productionState = await electronApplication.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        appPath: app.getAppPath(),
        executablePath: process.execPath,
        isPackaged: app.isPackaged,
        rendererUrl: window?.webContents.getURL(),
      };
    });
    assert.equal(productionState.isPackaged, true);
    assert.match(productionState.appPath, /app\.asar$/u);
    assert.match(productionState.rendererUrl ?? "", /^file:/u);
    assert.equal(await realpath(productionState.executablePath), await realpath(executablePath));

    const savedConfigsDialog = page.getByRole("dialog", { name: /saved configurations/i });
    await savedConfigsDialog.waitFor();
    const savedOption = savedConfigsDialog.getByRole("option", { name: /m0-packaged-operator/i });
    await savedOption.waitFor();
    if ((await savedOption.getAttribute("aria-selected")) !== "true") await savedOption.click();
    await savedConfigsDialog.getByRole("button", { name: /^connect$/i }).click();
    try {
      await savedConfigsDialog.waitFor({ state: "hidden" });
    } catch (error) {
      const body = (await page.locator("body").innerText()).slice(0, 4_000);
      throw new Error(
        redactDiagnosticText(
          `Packaged saved configuration did not connect. RPCs=${fixture.state.calls.join(",") || "none"}; ` +
            `pageErrors=${pageErrors.join(" | ") || "none"}; console=${consoleMessages.join(" | ") || "none"}; ` +
            `body=${body}`,
          diagnosticRedactions,
          12_000,
        ),
        { cause: error },
      );
    }
    try {
      await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor({ timeout: 10_000 });
    } catch (error) {
      const body = (await page.locator("body").innerText()).slice(0, 4_000);
      throw new Error(
        redactDiagnosticText(
          `Packaged app did not connect. RPCs=${fixture.state.calls.join(",") || "none"}; ` +
            `pageErrors=${pageErrors.join(" | ") || "none"}; console=${consoleMessages.join(" | ") || "none"}; ` +
            `body=${body}`,
          diagnosticRedactions,
          12_000,
        ),
        { cause: error },
      );
    }
    assert.equal(await page.getByRole("dialog", { name: "Server build mismatch" }).count(), 0);
    await page.getByText("#80", { exact: true }).waitFor();

    await verifyPackagedSliverConsole({
      artifactDirectory,
      diagnosticRedactions,
      electronApplication,
      fixture,
      sourcePage: page,
    });

    await startAndStopPackagedListener(page);
    for (const method of [
      "getVersion",
      "events",
      "tunnelData",
      "getJobs",
      "implantBuilds",
      "implantProfiles",
      "getCompiler",
      "startMTLSListener",
      "killJob",
    ]) {
      assert.ok(fixture.state.calls.includes(method), `protocol fixture did not observe ${method}`);
    }
    assert.ok(fixture.state.authenticatedCalls >= fixture.state.calls.length);
    assert.equal(fixture.state.rejectedTokenCalls, 1, "fixture must reject an invalid bearer token");
    assert.deepEqual(fixture.state.listenerRequests, [{ host: "127.0.0.1", port: 19999 }]);
    assert.deepEqual(fixture.state.killedJobs, [81]);

    const snapshotText = await page.evaluate(async () => {
      const browserGlobal = globalThis as unknown as {
        sliver: { getSnapshot(): Promise<unknown> };
      };
      return JSON.stringify(await browserGlobal.sliver.getSnapshot());
    });
    const bodyText = await page.locator("body").innerText();
    const screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, `packaged-mtls-${process.platform}-${process.arch}.png`),
    });
    const visibleText = [bodyText, snapshotText, ...consoleMessages].join("\n");
    for (const forbidden of [
      PACKAGED_FIXTURE_TOKEN,
      PACKAGED_FIXTURE_EVENT_SECRET,
      fixture.clientPrivateKey,
      configPath,
      temporaryRoot,
    ]) {
      assert.ok(!visibleText.includes(forbidden), `packaged renderer exposed ${secretLabel(forbidden)}`);
      assert.equal(screenshot.includes(Buffer.from(forbidden)), false);
    }
    assert.deepEqual(pageErrors, []);

    await page.getByRole("button", { name: /^Current server:/i }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await page.getByText("No server connected", { exact: true }).waitFor();
  } finally {
    await electronApplication?.close().catch(() => undefined);
    await fixture.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

interface TerminalCanvasSummary {
  readonly width: number;
  readonly height: number;
  readonly inkPixels: number;
  readonly hash: number;
}

async function verifyPackagedSliverConsole({
  artifactDirectory,
  diagnosticRedactions,
  electronApplication,
  fixture,
  sourcePage,
}: {
  artifactDirectory: string;
  diagnosticRedactions: string[];
  electronApplication: ElectronApplication;
  fixture: MtlsFixture;
  sourcePage: Page;
}): Promise<void> {
  const existingWindows = new Set(electronApplication.windows());
  const initialWindowCount = existingWindows.size;
  const rootsBefore = await listConsoleRootNames();
  const initialGetVersionCalls = fixtureCallCount(fixture, "getVersion");
  const initialEventCalls = fixtureCallCount(fixture, "events");
  const initialTunnelCalls = fixtureCallCount(fixture, "tunnelData");
  let consolePage: Page | undefined;
  let privateRootName: string | undefined;
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];

  try {
    await sourcePage.locator('button[aria-label="Open Sliver console"]').click();
    consolePage = await waitForConsoleWindow(electronApplication, existingWindows);
    await consolePage.emulateMedia({ reducedMotion: "reduce" });
    consolePage.on("console", (message) => consoleMessages.push(message.text()));
    consolePage.on("pageerror", (error) => pageErrors.push(error.message));

    assert.equal(new URL(consolePage.url()).search, "?surface=console");
    await consolePage.getByRole("main", { name: "Sliver client console window", exact: true }).waitFor();
    await consolePage.getByText("Active configuration: m0-packaged-operator", { exact: true }).waitFor();
    await consolePage.getByText("Connected", { exact: true }).waitFor();

    const terminal = consolePage.getByRole("textbox", {
      name: "Sliver client console using m0-packaged-operator",
      exact: true,
    });
    await terminal.waitFor({ timeout: 30_000 });
    await consolePage.locator('[data-terminal-state="ready"]').waitFor({ timeout: 30_000 });
    await waitForFixtureCalls(fixture, {
      events: initialEventCalls + 1,
      getVersion: initialGetVersionCalls + 1,
      tunnelData: initialTunnelCalls + 1,
    });

    privateRootName = await waitForAdditionalConsoleRoot(rootsBefore);
    const privateRoot = join(tmpdir(), privateRootName);
    assert.equal(
      await pathExists(join(privateRoot, "logs", "console")),
      false,
      "the embedded console must not create JSON or asciicast transcript storage",
    );

    const promptCanvas = await waitForTerminalInk(terminal, 750);
    assert.ok(promptCanvas.width > 0 && promptCanvas.height > 0);

    const versionCallsBeforeCommand = fixtureCallCount(fixture, "getVersion");
    await terminal.pressSequentially("version");
    const canvasBeforeEnter = await terminalCanvasSummary(terminal);
    await terminal.press("Enter");
    await waitForFixtureCalls(fixture, { getVersion: versionCallsBeforeCommand + 1 });
    const versionCanvas = await waitForTerminalInk(
      terminal,
      canvasBeforeEnter.inkPixels + 250,
    );
    assert.notEqual(
      versionCanvas.hash,
      canvasBeforeEnter.hash,
      "the upstream version response must update Ghostty's canvas",
    );
    assert.equal(
      await pathExists(join(privateRoot, "logs", "console")),
      false,
      "running a console command must not create an operator transcript",
    );

    const screenshot = await consolePage.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, `packaged-sliver-console-${process.platform}-${process.arch}.png`),
    });
    for (const forbidden of diagnosticRedactions) {
      if (forbidden) assert.equal(screenshot.includes(Buffer.from(forbidden)), false);
    }
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    const body = consolePage && !consolePage.isClosed()
      ? await consolePage.locator("body").innerText().catch(() => "")
      : "";
    throw new Error(
      redactDiagnosticText(
        `Packaged Sliver console smoke failed. RPCs=${fixture.state.calls.join(",") || "none"}; ` +
          `pageErrors=${pageErrors.join(" | ") || "none"}; ` +
          `console=${consoleMessages.join(" | ") || "none"}; body=${body}; failure=${errorMessage(error)}`,
        diagnosticRedactions,
        12_000,
      ),
    );
  } finally {
    await consolePage?.close().catch(() => undefined);
  }

  assert.ok(privateRootName, "the packaged native console must create one private root");
  await waitForConsoleRootRemoval(privateRootName);
  await waitForWindowCount(electronApplication, initialWindowCount);
}

async function writePackagedStartupDiagnostics({
  artifactDirectory,
  electronApplication,
  error,
  redactions,
}: {
  artifactDirectory: string;
  electronApplication: ElectronApplication;
  error: unknown;
  redactions: string[];
}): Promise<void> {
  let applicationState: unknown;
  try {
    applicationState = await withTimeout(
      electronApplication.evaluate(({ app, BrowserWindow }) => ({
        appPath: app.getAppPath(),
        appReady: app.isReady(),
        executablePath: process.execPath,
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        windows: BrowserWindow.getAllWindows().map((window) => ({
          crashed: window.webContents.isCrashed(),
          destroyed: window.isDestroyed(),
          rendererUrl: window.webContents.getURL(),
        })),
      })),
      5_000,
    );
  } catch (diagnosticError) {
    applicationState = { diagnosticError: errorMessage(diagnosticError) };
  }

  await writePackagedDiagnosticArtifact(
    artifactDirectory,
    {
      applicationState,
      launchError: errorMessage(error),
      phase: "first-window",
    },
    redactions,
  );
}

async function writePackagedDiagnosticArtifact(
  artifactDirectory: string,
  payload: Record<string, unknown>,
  redactions: string[],
): Promise<void> {
  const diagnostics = stringifyRedactedDiagnostics(
    {
      ...payload,
      platform: process.platform,
      architecture: process.arch,
    },
    redactions,
  );
  await writeFile(
    join(artifactDirectory, `packaged-startup-${process.platform}-${process.arch}.json`),
    `${diagnostics}\n`,
    { mode: 0o600 },
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Diagnostic capture timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function startAndStopPackagedListener(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New listener" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a listener" });
  await dialog.getByRole("textbox", { name: "Bind host" }).fill("127.0.0.1");
  await dialog.getByRole("textbox", { name: "Listener port" }).fill("19999");
  await dialog.getByRole("button", { name: "Start listener" }).click();
  await page.getByText("#81", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Stop job 81" }).click();
  const confirmation = page.getByRole("alertdialog", { name: /stop this reviewed server job/i });
  const confirmationText = await confirmation.innerText();
  for (const expected of [
    "127.0.0.1:",
    "packaged-fixture-operator",
    "m0-packaged-operator",
    "Job #81",
    "port 19999",
  ]) {
    assert.ok(confirmationText.includes(expected), `packaged stop confirmation omitted ${expected}`);
  }
  await confirmation.getByRole("button", { name: "Stop job #81" }).click();
  await page.getByText("#81", { exact: true }).waitFor({ state: "detached" });
}

function fixtureCallCount(fixture: MtlsFixture, method: string): number {
  return fixture.state.calls.filter((candidate) => candidate === method).length;
}

async function waitForFixtureCalls(
  fixture: MtlsFixture,
  expected: Readonly<Record<string, number>>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (Object.entries(expected).every(([method, count]) => fixtureCallCount(fixture, method) >= count)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const observed = Object.keys(expected)
    .map((method) => `${method}=${fixtureCallCount(fixture, method)}`)
    .join(", ");
  throw new Error(`Timed out waiting for native-console RPCs; observed ${observed}`);
}

async function waitForConsoleWindow(
  electronApplication: ElectronApplication,
  existingWindows: ReadonlySet<Page>,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const consolePage = electronApplication.windows().find((candidate) => {
      if (existingWindows.has(candidate) || candidate.isClosed()) return false;
      try {
        return new URL(candidate.url()).search === "?surface=console";
      } catch {
        return false;
      }
    });
    if (consolePage) return consolePage;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the packaged Sliver console window");
}

async function terminalCanvasSummary(terminal: Locator): Promise<TerminalCanvasSummary> {
  const canvas = terminal.locator("canvas");
  await canvas.waitFor();
  return canvas.evaluate((element) => {
    const surface = element as unknown as {
      width: number;
      height: number;
      getContext(
        contextId: "2d",
        options: { willReadFrequently: true },
      ): { getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } } | null;
    };
    const context = surface.getContext("2d", { willReadFrequently: true });
    if (!context || surface.width < 1 || surface.height < 1) throw new Error("Ghostty canvas is unavailable");
    const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
    const background = [pixels[0]!, pixels[1]!, pixels[2]!, pixels[3]!] as const;
    let inkPixels = 0;
    let hash = 2_166_136_261;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index]!;
      const green = pixels[index + 1]!;
      const blue = pixels[index + 2]!;
      const alpha = pixels[index + 3]!;
      if (
        Math.abs(red - background[0]) +
          Math.abs(green - background[1]) +
          Math.abs(blue - background[2]) +
          Math.abs(alpha - background[3]) > 12
      ) inkPixels += 1;
      hash = Math.imul(hash ^ red, 16_777_619);
      hash = Math.imul(hash ^ green, 16_777_619);
      hash = Math.imul(hash ^ blue, 16_777_619);
      hash = Math.imul(hash ^ alpha, 16_777_619);
    }
    return { width: surface.width, height: surface.height, inkPixels, hash: hash >>> 0 };
  });
}

async function waitForTerminalInk(
  terminal: Locator,
  minimumInkPixels: number,
  timeoutMs = 10_000,
): Promise<TerminalCanvasSummary> {
  const deadline = Date.now() + timeoutMs;
  let latest = await terminalCanvasSummary(terminal);
  while (Date.now() < deadline) {
    latest = await terminalCanvasSummary(terminal);
    if (latest.inkPixels >= minimumInkPixels) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Ghostty did not render the expected upstream-client output; observed ${latest.inkPixels} ink pixels`,
  );
}

async function listConsoleRootNames(): Promise<Set<string>> {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("sliver-gui-console-"))
      .map((entry) => entry.name),
  );
}

async function waitForAdditionalConsoleRoot(
  before: ReadonlySet<string>,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const additional = [...await listConsoleRootNames()].filter((name) => !before.has(name));
    if (additional.length === 1) return additional[0]!;
    if (additional.length > 1) throw new Error("Multiple new private console roots appeared");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The packaged console did not create a private root");
}

async function waitForConsoleRootRemoval(rootName: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await listConsoleRootNames()).has(rootName)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("The packaged console private root was not removed after its window closed");
}

async function waitForWindowCount(
  electronApplication: ElectronApplication,
  expectedCount: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    latest = electronApplication.windows().filter((candidate) => !candidate.isClosed()).length;
    if (latest === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Packaged application window count did not return to ${expectedCount}; latest was ${latest}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function findPackagedExecutable(repositoryRoot: string): Promise<string> {
  const configured = process.env["SLIVER_GUI_PACKAGED_EXECUTABLE"];
  if (configured) return resolve(configured);

  const releaseDirectory = join(repositoryRoot, "release");
  const files = await listFiles(releaseDirectory);
  const matches = files.filter((path) => {
    const normalized = path.replaceAll("\\", "/");
    if (process.platform === "darwin") return normalized.endsWith(".app/Contents/MacOS/Sliver GUI");
    if (process.platform === "win32") return /\/win-unpacked\/Sliver GUI\.exe$/iu.test(normalized);
    return /\/linux-unpacked\/sliver-gui$/u.test(normalized);
  });
  if (matches.length === 0) {
    throw new Error(`No packaged ${process.platform} Sliver GUI executable was found under ${releaseDirectory}`);
  }
  const dated = await Promise.all(
    matches.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })),
  );
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  return dated[0]!.path;
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function packagedOperatorConfig(fixture: {
  port: number;
  caCertificate: string;
  clientCertificate: string;
  clientPrivateKey: string;
}): string {
  return JSON.stringify({
    operator: "packaged-fixture-operator",
    lhost: "127.0.0.1",
    lport: fixture.port,
    ca_certificate: fixture.caCertificate,
    certificate: fixture.clientCertificate,
    private_key: fixture.clientPrivateKey,
    token: PACKAGED_FIXTURE_TOKEN,
  });
}

function secretLabel(value: string): string {
  if (value === PACKAGED_FIXTURE_TOKEN) return "operator token";
  if (value === PACKAGED_FIXTURE_EVENT_SECRET) return "event payload";
  if (value.includes("PRIVATE KEY")) return "client private key";
  return basename(value);
}
