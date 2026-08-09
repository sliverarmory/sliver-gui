import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import {
  PACKAGED_FIXTURE_EVENT_SECRET,
  PACKAGED_FIXTURE_TOKEN,
  startMtlsFixture,
  verifyFixtureAuthenticationBoundary,
} from "./mtls-fixture.js";

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
    const page = await electronApplication.firstWindow();
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

    const connectDialog = page.getByRole("dialog", { name: /connect to sliver/i });
    await connectDialog.waitFor();
    const savedOption = connectDialog.getByRole("option", { name: /m0-packaged-operator/i });
    await savedOption.waitFor();
    if ((await savedOption.getAttribute("aria-selected")) !== "true") await savedOption.click();
    await connectDialog.getByRole("button", { name: /^connect$/i }).click();
    try {
      await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor({ timeout: 10_000 });
    } catch (error) {
      const body = (await page.locator("body").innerText()).slice(0, 4_000);
      throw new Error(
        `Packaged app did not connect. RPCs=${fixture.state.calls.join(",") || "none"}; ` +
        `pageErrors=${pageErrors.join(" | ") || "none"}; console=${consoleMessages.join(" | ") || "none"}; ` +
        `body=${body}`,
        { cause: error },
      );
    }
    assert.equal(await page.getByRole("dialog", { name: "Server build mismatch" }).count(), 0);
    await page.getByText("#80", { exact: true }).waitFor();

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
