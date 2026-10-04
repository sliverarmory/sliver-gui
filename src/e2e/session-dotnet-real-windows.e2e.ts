import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { SliverClient, parseConfig, type SliverClientConfig } from "sliver-script";

import type { SliverDesktopAPI, SliverSnapshot } from "../shared/contracts.js";

const ENABLED = process.env["SLIVER_GUI_DOTNET_REAL_E2E"] === "1";
const ALLOW_REMOTE = process.env["SLIVER_GUI_DOTNET_REAL_E2E_ALLOW_REMOTE"] === "1";
const CONFIG_PATH = process.env["SLIVER_GUI_E2E_CONFIG"]?.trim();
const ASSEMBLY_PATH = process.env["SLIVER_GUI_DOTNET_E2E_ASSEMBLY"]?.trim();
const SESSION_ID = process.env["SLIVER_GUI_E2E_SESSION_ID"]?.trim();
const SESSION_NAME = process.env["SLIVER_GUI_E2E_SESSION_NAME"]?.trim();
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1_024 * 1_024;
const MAX_ASSEMBLY_BYTES = 64 * 1_024 * 1_024;
const ARGV = "alpha beta --count=7";
const EXPECTED_OUTPUT = [
  "SLIVER_GUI_ARG_ECHO_BEGIN",
  "COUNT=3",
  "ARG[0]=alpha",
  "ARG[1]=beta",
  "ARG[2]=--count=7",
  "SLIVER_GUI_ARG_ECHO_END",
];

/** Opt-in only. The standard Electron suite uses a deterministic fake backend. */
test("built Electron .NET view executes Armory and opened EXE with CLI arguments on an exact live Windows session", {
  skip: ENABLED ? false : "Set SLIVER_GUI_DOTNET_REAL_E2E=1, the operator config, exact session selector, and benign EXE path to opt in",
  timeout: 300_000,
}, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const configPath = requiredPath(CONFIG_PATH, "SLIVER_GUI_E2E_CONFIG");
  const assemblyPath = requiredPath(ASSEMBLY_PATH, "SLIVER_GUI_DOTNET_E2E_ASSEMBLY");
  validateTargetSelector();

  let temporaryRoot: string | undefined;
  let application: ElectronApplication | undefined;
  let client: SliverClient | undefined;
  let stage = "read operator configuration";
  let failure: Error | undefined;
  let cleanupFailed = false;
  try {
    const configBytes = await readBoundedFile(configPath, MAX_OPERATOR_CONFIG_BYTES);
    let config: SliverClientConfig;
    try {
      stage = "validate mTLS configuration";
      config = parseConfig(configBytes);
      assert.equal(config.wg, undefined, "mTLS is required");
      const host = config.lhost.toLowerCase();
      const literalHost = host === "[::1]" ? "::1" : host;
      if (!ALLOW_REMOTE && literalHost !== "127.0.0.1" && literalHost !== "::1") {
        throw new Error("Remote mTLS requires an explicit opt-in");
      }

      stage = "create isolated application data";
      temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-real-dotnet-windows-"));
      const clientRoot = join(temporaryRoot, "home", ".sliver-client");
      const savedConfigs = join(clientRoot, "configs");
      await Promise.all([
        mkdir(savedConfigs, { recursive: true }),
        mkdir(join(temporaryRoot, "user-data"), { recursive: true }),
      ]);
      await writeFile(join(savedConfigs, "dotnet-live-operator.cfg"), configBytes, { mode: 0o600 });
    } finally {
      configBytes.fill(0);
    }

    stage = "find exact active Windows session";
    client = new SliverClient(config);
    await client.connect();
    const session = selectAuthorizedSession((await client.getSessions(30)).Sessions);

    stage = "install test-owned Armory alias";
    const fixtureBytes = await readBoundedFile(assemblyPath, MAX_ASSEMBLY_BYTES);
    try {
      await writeIsolatedAlias(join(temporaryRoot, "home", ".sliver-client"), fixtureBytes, session.arch);
    } finally {
      fixtureBytes.fill(0);
    }

    stage = "launch built Electron application";
    application = await launchBuiltApplication(repositoryRoot, temporaryRoot);
    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    let rendererErrorCount = 0;
    page.on("pageerror", () => { rendererErrorCount += 1; });

    stage = "connect saved operator configuration";
    await connectSavedConfig(page);
    stage = "select exact Windows session in GUI";
    await openAuthorizedSession(page, session);
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: ".NET", exact: true }).click();
    const workspace = page.getByRole("region", { name: ".NET assembly execution", exact: true });
    const form = workspace.getByRole("region", { name: "Execute a .NET assembly", exact: true });
    await form.waitFor();

    stage = "select isolated Armory assembly";
    await form.locator('[data-slot="autocomplete-trigger"]').click();
    await page.getByRole("searchbox", { name: "Search assemblies", exact: true }).fill("gui-arg-echo");
    await page.getByRole("option", { name: /gui-arg-echo/u }).click();
    await form.getByRole("textbox", { name: "Assembly arguments", exact: true }).fill(ARGV);

    stage = "execute Armory assembly on exact session";
    await executeAssembly(client, page, form, session);
    const firstRequest = await waitForArgEcho(page, workspace, session.id, "armory");

    stage = "open local test assembly";
    await workspace.getByRole("navigation", { name: ".NET execution history", exact: true })
      .getByRole("row", { name: "New Execution", exact: true }).click();
    await form.waitFor();
    await application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selectedPath] })) as typeof dialog.showOpenDialog;
    }, assemblyPath);
    await form.getByRole("button", { name: "Open assembly file", exact: true }).click();
    await form.getByRole("textbox", { name: "Assembly arguments", exact: true }).fill(ARGV);

    stage = "execute opened assembly on exact session";
    await executeAssembly(client, page, form, session);
    const secondRequest = await waitForArgEcho(page, workspace, session.id, "file", firstRequest);
    assert.notEqual(secondRequest, firstRequest, "each source route must execute a distinct request");
    assert.equal(rendererErrorCount, 0, "renderer page errors are not expected");
  } catch {
    // Framework and Sliver errors may contain operator endpoints or remote output.
    failure = new Error(`Live Windows .NET E2E failed during ${stage}.`);
  } finally {
    try { await application?.close(); } catch { cleanupFailed = true; }
    try { await client?.disconnect(); } catch { cleanupFailed = true; }
    if (temporaryRoot) {
      try { await rm(temporaryRoot, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
  }
  if (failure) throw failure;
  if (cleanupFailed) throw new Error("Live Windows .NET E2E could not clean up isolated resources.");
});

interface AuthorizedSession {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly arch: string;
}

function requiredPath(value: string | undefined, name: string): string {
  if (!value || !isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

function validateTargetSelector(): void {
  if (!SESSION_ID && !SESSION_NAME) throw new Error("An exact Windows session ID or name is required");
  for (const value of [SESSION_ID, SESSION_NAME]) {
    if (value !== undefined && (value.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
      throw new Error("The exact session selector must be bounded printable text");
    }
  }
}

async function readBoundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > maximumBytes) {
    throw new Error("A required local file is not a bounded nonempty regular file");
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
  assert.equal(session.OS.trim().toLowerCase(), "windows", "the selected session must run Windows");
  assert.ok(session.Arch === "amd64" || session.Arch === "386", "the session architecture must support .NET execution");
  return { id: session.ID, name: session.Name, hostname: session.Hostname, arch: session.Arch };
}

async function writeIsolatedAlias(clientRoot: string, assemblyBytes: Buffer, arch: string): Promise<void> {
  const directory = join(clientRoot, "aliases", "gui-arg-echo");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SliverGuiArgEcho.exe"), assemblyBytes, { mode: 0o600 });
  await writeFile(join(directory, "alias.json"), JSON.stringify({
    name: "GUI argument echo",
    command_name: "gui-arg-echo",
    version: "1.0.0",
    help: "Test-owned benign .NET argument echo",
    is_assembly: true,
    files: [{ os: "windows", arch, path: "/SliverGuiArgEcho.exe" }],
  }), { mode: 0o600 });
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
    },
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function connectSavedConfig(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /saved configurations/iu });
  await dialog.waitFor();
  const option = dialog.getByRole("option", { name: /dotnet-live-operator/iu });
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
  const snapshot = await rendererSnapshot(page);
  assert.equal(snapshot.targetContext.activeTarget?.mode, "session");
  assert.equal(snapshot.targetContext.activeTarget?.id, session.id);
}

async function assertExactSession(client: SliverClient, page: Page, expected: AuthorizedSession): Promise<void> {
  const current = selectAuthorizedSession((await client.getSessions(30)).Sessions);
  assert.equal(current.id, expected.id);
  const active = (await rendererSnapshot(page)).targetContext.activeTarget;
  assert.equal(active?.mode, "session");
  assert.equal(active.id, expected.id);
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return api.getSnapshot();
  });
}

async function executeAssembly(client: SliverClient, page: Page, form: Locator, session: AuthorizedSession): Promise<void> {
  await assertExactSession(client, page, session);
  assert.equal(await form.getByRole("button", { name: "Review", exact: true }).count(), 0);
  await form.getByRole("button", { name: "Execute", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true }).count(), 0);
}

async function waitForArgEcho(
  page: Page,
  workspace: Locator,
  sessionId: string,
  sourceKind: "armory" | "file",
  previousRequest?: string,
): Promise<string> {
  const details = workspace.getByRole("region", { name: ".NET execution details", exact: true });
  const output = workspace.getByRole("region", { name: ".NET execution output", exact: true });
  const transcript = output.getByLabel("Execution output transcript");
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const latest = await page.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const response = await api.listDotNetExecutionHistory();
      if (!response.ok || !response.value) return undefined;
      try {
        const record = response.value.records[0];
        return record ? {
          targetMode: response.value.target.mode,
          targetId: response.value.target.id,
          id: record.id,
          sourceKind: record.sourceKind,
          state: record.state,
        } : undefined;
      } finally {
        for (const record of response.value.records) {
          record.stdout?.data.fill(0);
          record.stderr?.data.fill(0);
        }
      }
    }).catch(() => undefined);
    if (latest && latest.targetMode === "session" && latest.targetId === sessionId &&
      latest.id !== previousRequest && latest.sourceKind === sourceKind && latest.state === "completed" &&
      await details.isVisible().catch(() => false)) {
      const stdout = await transcript.textContent().catch(() => "");
      if (stdout && EXPECTED_OUTPUT.every((line) => stdout.includes(line))) {
        for (const line of EXPECTED_OUTPUT) {
          assert.ok(stdout.split(/\r?\n/u).includes(line), "the assembly must print each indexed CLI argument");
        }
        return latest.id;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("The exact .NET CLI argument echo did not appear in the GUI output");
}
