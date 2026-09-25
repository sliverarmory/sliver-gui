import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { SliverClient, parseConfig, type SliverClientConfig } from "sliver-script";

import type { SliverDesktopAPI, SliverSnapshot } from "../shared/contracts.js";

const ENABLED = process.env["SLIVER_GUI_M4_PROCESS_REAL_E2E"] === "1";
const ALLOW_REMOTE = process.env["SLIVER_GUI_M4_PROCESS_REAL_E2E_ALLOW_REMOTE"] === "1";
const CONFIG_PATH = process.env["SLIVER_GUI_E2E_CONFIG"]?.trim();
const SESSION_ID = process.env["SLIVER_GUI_E2E_SESSION_ID"]?.trim();
const SESSION_NAME = process.env["SLIVER_GUI_E2E_SESSION_NAME"]?.trim();
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;
const TASKLIST_PATH = "C:\\Windows\\System32\\tasklist.exe";

/**
 * Opt-in only: runs one read-only Windows system command on one exact active
 * session. The standard Electron suite does not include this file.
 */
test("built Electron Process view captures tasklist from an exact live Windows session", {
  skip: ENABLED
    ? false
    : "Set SLIVER_GUI_M4_PROCESS_REAL_E2E=1, SLIVER_GUI_E2E_CONFIG, and an exact session selector to opt in",
  timeout: 180_000,
}, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const configPath = requiredConfigPath();
  validateTargetSelector();

  let temporaryRoot: string | undefined;
  let application: ElectronApplication | undefined;
  let client: SliverClient | undefined;
  let stage = "read operator configuration";
  let failure: Error | undefined;
  let cleanupFailed = false;
  try {
    const configBytes = await readBoundedConfig(configPath);
    let config: SliverClientConfig;
    try {
      stage = "validate mTLS configuration";
      config = parseConfig(configBytes);
      assert.equal(config.wg, undefined, "mTLS is required");
      const configuredHost = config.lhost.toLowerCase();
      const literalHost = configuredHost === "[::1]" ? "::1" : configuredHost;
      if (!ALLOW_REMOTE && literalHost !== "127.0.0.1" && literalHost !== "::1") {
        stage = "require remote-server opt-in";
        throw new Error("SLIVER_GUI_M4_PROCESS_REAL_E2E_ALLOW_REMOTE=1 is required for non-loopback mTLS");
      }

      stage = "create isolated application data";
      temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-real-process-windows-"));
      const clientRoot = join(temporaryRoot, "home", ".sliver-client");
      const savedConfigs = join(clientRoot, "configs");
      await Promise.all([
        mkdir(savedConfigs, { recursive: true }),
        mkdir(join(temporaryRoot, "user-data"), { recursive: true }),
      ]);
      await writeFile(join(savedConfigs, "m4-real-process.cfg"), configBytes, { mode: 0o600 });
    } finally {
      configBytes.fill(0);
    }

    stage = "find exact active Windows session";
    client = new SliverClient(config);
    await client.connect();
    const session = selectAuthorizedSession((await client.getSessions(30)).Sessions);

    stage = "launch built Electron application";
    application = await launchBuiltApplication(repositoryRoot, temporaryRoot);
    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    let rendererErrorCount = 0;
    page.on("pageerror", () => { rendererErrorCount += 1; });

    stage = "connect saved operator configuration";
    await connectSavedConfig(page);

    stage = "select exact session in the GUI";
    await openAuthorizedSession(page, session);
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    const form = page.getByRole("region", { name: "Run a process", exact: true });
    const processView = page.getByRole("region", {
      name: "Process execution history and output",
      exact: true,
    });
    await form.waitFor();
    assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, session.id);

    stage = "verify default Process options";
    assert.equal(await form.getByRole("switch", { name: /Capture output/u }).isChecked(), true);
    assert.equal(await form.getByRole("switch", { name: /Run in background/u }).isChecked(), false);
    assert.equal(await form.getByRole("textbox", { name: "Arguments" }).inputValue(), "");

    stage = "run tasklist through Process view";
    await form.getByRole("textbox", { name: "Executable path" }).fill(TASKLIST_PATH);
    // Recheck immediately before dispatch in case the target disappeared or changed.
    const current = selectAuthorizedSession((await client.getSessions(30)).Sessions);
    assert.equal(current.id, session.id);
    assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, session.id);
    await form.getByRole("button", { name: "Run", exact: true }).click();
    assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?" }).count(), 0);

    stage = "verify completed Process result and captured stdout";
    await form.waitFor({ state: "hidden" });
    await processView.getByText("Completed", { exact: true }).waitFor({ timeout: 90_000 });
    const details = processView.locator('dl[aria-label="Execution details"]');
    assert.match(await details.innerText(), /Exit code\s+0\b/u);
    const transcript = page.getByLabel("Execution output transcript", { exact: true });
    await transcript.waitFor({ timeout: 30_000 });
    assert.ok((await transcript.textContent())?.trim(), "tasklist must return nonempty stdout");
    await processView.locator('[aria-label="Execution output terminal"] canvas').waitFor();
    const history = processView.getByRole("navigation", { name: "Process execution history" });
    assert.equal(await history.getByRole("row").count(), 2);
    assert.equal(rendererErrorCount, 0, "renderer page errors are not expected");
  } catch {
    // Playwright errors can include locator text, and Sliver errors can include
    // server addresses. Keep failure output limited to a known-safe stage.
    failure = new Error(`Live Windows Process E2E failed during ${stage}.`);
  } finally {
    try { await application?.close(); } catch { cleanupFailed = true; }
    try { await client?.disconnect(); } catch { cleanupFailed = true; }
    if (temporaryRoot) {
      try { await rm(temporaryRoot, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
  }
  if (failure) throw failure;
  if (cleanupFailed) throw new Error("Live Windows Process E2E could not clean up isolated resources.");
});

interface AuthorizedSession {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
}

function requiredConfigPath(): string {
  if (!CONFIG_PATH || !isAbsolute(CONFIG_PATH)) {
    throw new Error("SLIVER_GUI_E2E_CONFIG must be an absolute mTLS operator config path");
  }
  return CONFIG_PATH;
}

function validateTargetSelector(): void {
  if (!SESSION_ID && !SESSION_NAME) {
    throw new Error("SLIVER_GUI_E2E_SESSION_ID or SLIVER_GUI_E2E_SESSION_NAME is required");
  }
  for (const value of [SESSION_ID, SESSION_NAME]) {
    if (value !== undefined && (value.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
      throw new Error("The exact session selector must be bounded printable text");
    }
  }
}

async function readBoundedConfig(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > MAX_OPERATOR_CONFIG_BYTES) {
    throw new Error("SLIVER_GUI_E2E_CONFIG must name a nonempty regular file within the size limit");
  }
  return readFile(path);
}

function selectAuthorizedSession(sessions: Awaited<ReturnType<SliverClient["getSessions"]>>["Sessions"]): AuthorizedSession {
  const matches = SESSION_ID
    ? sessions.filter((session) => session.ID === SESSION_ID)
    : sessions.filter((session) => session.Name === SESSION_NAME);
  assert.equal(matches.length, 1, "the selector must match exactly one session");
  const session = matches[0]!;
  if (SESSION_NAME) assert.equal(session.Name, SESSION_NAME, "ID and name must match the same session");
  assert.equal(session.IsDead, false, "the selected session must be active");
  assert.ok(session.OS.toLowerCase().includes("windows"), "the selected session must run Windows");
  assert.ok(session.ID.trim(), "the selected session must have an ID");
  return { id: session.ID, name: session.Name, hostname: session.Hostname };
}

async function launchBuiltApplication(repositoryRoot: string, temporaryRoot: string): Promise<ElectronApplication> {
  const isolatedHome = join(temporaryRoot, "home");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && !entry[0].startsWith("SLIVER_GUI_"),
    ),
  );
  return electron.launch({
    args: ["--enable-sandbox", repositoryRoot, `--user-data-dir=${join(temporaryRoot, "user-data")}`],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: repositoryRoot,
    env: {
      ...environment,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      XDG_CONFIG_HOME: join(isolatedHome, ".config"),
      SLIVER_CLIENT_ROOT_DIR: join(isolatedHome, ".sliver-client"),
      ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
    },
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function connectSavedConfig(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /saved configurations/iu });
  await dialog.waitFor();
  const option = dialog.getByRole("option", { name: /m4-real-process/iu });
  await option.waitFor();
  const connectButton = dialog.getByRole("button", { name: /^connect$/iu });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await option.isEnabled()) {
      if ((await option.getAttribute("aria-selected")) !== "true") await option.click();
      if (await connectButton.isEnabled()) break;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  assert.equal(await connectButton.isEnabled(), true, "the saved configuration must become selectable");
  await connectButton.click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^Current server:/iu }).waitFor({ timeout: 30_000 });
  const mismatch = page.getByRole("dialog", { name: "Server version mismatch" });
  const mismatchVisible = await mismatch.waitFor({ state: "visible", timeout: 5_000 }).then(
    () => true,
    () => false,
  );
  if (mismatchVisible) {
    await mismatch.getByRole("button", { name: "Continue" }).click();
    await mismatch.waitFor({ state: "hidden" });
  }
}

async function openAuthorizedSession(page: Page, session: AuthorizedSession): Promise<void> {
  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Filter sessions", exact: true }).fill(session.id);
  const grid = page.getByRole("grid", { name: "Sliver sessions", exact: true });
  const row = grid.getByRole("row").filter({ hasText: session.id });
  await row.waitFor();
  assert.equal(await row.count(), 1, "the GUI filter must resolve to one exact row");
  await row.getByRole("button", { name: /^Interact with /u }).click();
  await page.getByRole("heading", { name: session.name || session.hostname || session.id, exact: true }).waitFor();
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.mode, "session");
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, session.id);
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return api.getSnapshot();
  });
}
