import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { IPC_INVOKE } from "../shared/contracts.js";

const PRIVATE_KEY_SECRET = "FAKE_PRIVATE_KEY_M0_DO_NOT_RENDER";
const TOKEN_SECRET = "FAKE_TOKEN_M0_DO_NOT_RENDER";
const EVENT_SECRET = "FAKE_EVENT_SECRET_M0_DO_NOT_RENDER";

test("real renderer reaches an injected fake only through frozen preload and trusted IPC", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-electron-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const selectedConfigPath = join(temporaryRoot, "chosen-m0-operator.cfg");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(selectedConfigPath, fakeOperatorConfig(), { mode: 0o600 });

  let electronApplication: ElectronApplication | undefined;
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  try {
    electronApplication = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await electronApplication.firstWindow();
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await assertRendererSecurity(electronApplication, page);
    await page.getByRole("dialog", { name: /connect to sliver/i }).waitFor();

    // Replace the native chooser from outside the app immediately before the
    // production renderer invokes it. No production switch or debug IPC is
    // needed for this deterministic selection.
    await electronApplication.evaluate(({ dialog }, configPath) => {
      dialog.showOpenDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: false, filePaths: [configPath] };
      };
    }, selectedConfigPath);
    await page.getByRole("button", { name: /choose.*file|connect (?:from |external )file/i }).click();

    await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Server build mismatch" }).count(), 0);
    await page.getByText("#41", { exact: true }).waitFor();
    await page.getByText("Seeded mTLS listener", { exact: true }).waitFor();

    const stateAfterConnect = await readFakeState(electronApplication);
    assert.equal(stateAfterConnect.configFactoryCalls, 1);
    assert.equal(stateAfterConnect.dialogCalls, 1);
    assert.deepEqual(stateAfterConnect.connectedConfig, {
      operator: "m0-e2e-operator",
      host: "127.0.0.1",
      port: 31337,
    });
    for (const method of ["connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler"]) {
      assert.ok(stateAfterConnect.methods.includes(method), `expected ConnectionRegistry to call ${method}`);
    }

    await startAndStopMtlsListener(page);
    const stateAfterStop = await readFakeState(electronApplication);
    assert.ok(stateAfterStop.methods.includes("startMTLSListener"));
    assert.ok(stateAfterStop.methods.includes("killJob"));

    const snapshotText = await page.evaluate(async () => {
      const browserGlobal = globalThis as unknown as {
        sliver: { getSnapshot(): Promise<unknown> };
      };
      return JSON.stringify(await browserGlobal.sliver.getSnapshot());
    });
    const bodyText = await page.locator("body").innerText();
    const screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "current-slice.png"),
    });
    const observableText = [bodyText, snapshotText, ...consoleMessages].join("\n");
    for (const forbidden of [PRIVATE_KEY_SECRET, TOKEN_SECRET, EVENT_SECRET, selectedConfigPath]) {
      assert.ok(!observableText.includes(forbidden), `renderer-visible text exposed ${forbidden}`);
      assert.equal(screenshot.includes(Buffer.from(forbidden)), false, `screenshot bytes exposed ${forbidden}`);
    }
    assert.deepEqual(pageErrors, []);

    await page.getByRole("button", { name: /^Current server:/i }).click();
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await page.getByText("No server connected", { exact: true }).waitFor();
    assert.equal((await readFakeState(electronApplication)).disconnects, 1);
  } finally {
    await electronApplication?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertRendererSecurity(electronApplication: ElectronApplication, page: Page): Promise<void> {
  const expectedApiKeys = [...Object.keys(IPC_INVOKE), "onSnapshotChanged"].sort();
  const rendererState = await page.evaluate(async () => {
    const browserGlobal = globalThis as unknown as {
      sliver: object;
      process?: unknown;
      require?: unknown;
    };
    let externalFetchBlocked = false;
    try {
      await fetch("https://example.invalid/sliver-gui-e2e");
    } catch {
      externalFetchBlocked = true;
    }
    return {
      apiFrozen: Object.isFrozen(browserGlobal.sliver),
      apiKeys: Object.keys(browserGlobal.sliver).sort(),
      externalFetchBlocked,
      nodeProcessType: typeof browserGlobal.process,
      nodeRequireType: typeof browserGlobal.require,
    };
  });
  assert.deepEqual(rendererState.apiKeys, expectedApiKeys);
  assert.equal(rendererState.apiFrozen, true);
  assert.equal(rendererState.externalFetchBlocked, true);
  assert.equal(rendererState.nodeProcessType, "undefined");
  assert.equal(rendererState.nodeRequireType, "undefined");

  const preferences = await electronApplication.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected an application window");
    const prefs = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      contextIsolation: prefs["contextIsolation"],
      nodeIntegration: prefs["nodeIntegration"],
      nodeIntegrationInWorker: prefs["nodeIntegrationInWorker"] ?? false,
      nodeIntegrationInSubFrames: prefs["nodeIntegrationInSubFrames"],
      sandbox: prefs["sandbox"],
      webSecurity: prefs["webSecurity"],
      webviewTag: prefs["webviewTag"],
    };
  });
  assert.deepEqual(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
}

async function startAndStopMtlsListener(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New listener" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a listener" });
  await dialog.getByRole("textbox", { name: "Bind host" }).fill("127.0.0.1");
  const port = dialog.getByRole("textbox", { name: "Listener port" });
  await port.fill("18888");
  await dialog.getByRole("button", { name: "Start listener" }).click();
  await page.getByText("#42", { exact: true }).waitFor();
  await page.getByText("Playwright-created mTLS listener", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Stop job 42" }).click();
  const confirmation = page.getByRole("alertdialog", { name: /stop this reviewed server job/i });
  await confirmation.waitFor();
  const confirmationText = await confirmation.innerText();
  for (const expected of [
    "127.0.0.1:31337",
    "m0-e2e-operator",
    "chosen-m0-operator.cfg",
    "Shared by 1 application window",
    "Job #42",
    "port 18888",
  ]) {
    assert.ok(confirmationText.includes(expected), `stop confirmation omitted ${expected}`);
  }
  await confirmation.getByRole("button", { name: "Stop job #42" }).click();
  await page.getByText("#42", { exact: true }).waitFor({ state: "detached" });
}

async function readFakeState(electronApplication: ElectronApplication): Promise<FakeStateSnapshot> {
  return electronApplication.evaluate(() => structuredClone(globalThis.__SLIVER_GUI_E2E_STATE__));
}

interface FakeStateSnapshot {
  configFactoryCalls: number;
  dialogCalls: number;
  methods: string[];
  disconnects: number;
  connectedConfig?: { operator: string; host: string; port: number };
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "m0-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_CA_M0_DO_NOT_RENDER",
    certificate: "FAKE_CERT_M0_DO_NOT_RENDER",
    private_key: PRIVATE_KEY_SECRET,
    token: TOKEN_SECRET,
  });
}
