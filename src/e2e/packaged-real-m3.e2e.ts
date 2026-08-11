import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  SliverClient,
  clientpb,
  parseConfig,
  type SliverClientConfig,
} from "sliver-script";

import type { SliverDesktopAPI, SliverSnapshot } from "../shared/contracts.js";
import type {
  SessionShellResource,
  SessionShellResourceAction,
  SessionShellResourceList,
} from "../shared/stream-contracts.js";

const ENABLED = process.env["SLIVER_GUI_M3_REAL_E2E"] === "1";
const CONFIG_PATH = process.env["SLIVER_GUI_E2E_CONFIG"]?.trim();
const SESSION_ID = process.env["SLIVER_GUI_E2E_SESSION_ID"]?.trim();
const SESSION_NAME = process.env["SLIVER_GUI_E2E_SESSION_NAME"]?.trim();
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;
const SHELL_WAIT_MILLISECONDS = 30_000;
const RENDERER_PROBE_TEXT_LIMIT = 256 * 1024;
const execFileAsync = promisify(execFile);

test("M3 shell ownership recognizes only reviewed and upstream fallback executables", () => {
  assert.equal(isExpectedShellExecutable("darwin", "bash"), true);
  assert.equal(isExpectedShellExecutable("linux", "sh"), true);
  assert.equal(isExpectedShellExecutable("windows", "powershell.exe"), true);
  assert.equal(isExpectedShellExecutable("windows", "cmd.exe"), true);
  assert.equal(isExpectedShellExecutable("darwin", "zsh"), false);
  assert.equal(isExpectedShellExecutable("windows", "pwsh.exe"), false);
  assert.equal(syntheticCommand("cmd.exe", "SLIVERGUIM3PROBE"), "echo SLIVERGU^IM3PROBE");
  assert.equal(
    packagedArchiveCandidateForExecutable(
      "/tmp/release/mac-arm64/Sliver GUI.app/Contents/MacOS/Sliver GUI",
      "darwin",
    ),
    "/tmp/release/mac-arm64/Sliver GUI.app/Contents/Resources/app.asar",
  );
  assert.equal(
    packagedArchiveCandidateForExecutable("C:\\release\\win-unpacked\\Sliver GUI.exe", "win32"),
    "C:\\release\\win-unpacked\\resources\\app.asar",
  );
  assert.equal(
    packagedArchiveCandidateForExecutable("/tmp/release/linux-unpacked/sliver-gui", "linux"),
    "/tmp/release/linux-unpacked/resources/app.asar",
  );
  assert.throws(
    () => packagedArchiveCandidateForExecutable("/tmp/Sliver GUI", "darwin"),
    /reviewed packaged application layout/u,
  );
});

/**
 * Destructive opt-in only: this test starts one child shell on one exact,
 * pre-authorized active session. It never creates, kills, or removes a Sliver
 * session. Failure cleanup may invoke Kill only through an exact managed-shell
 * resource captured in this isolated window, so main uses the PID bound to the
 * actual Shell response. No baseline or inferred concurrent process is ever
 * passed to a destructive RPC.
 */
test(
  "packaged M3 app drives one authorized real session shell with exact cleanup",
  {
    skip: ENABLED
      ? false
      : "Set SLIVER_GUI_M3_REAL_E2E=1, SLIVER_GUI_E2E_CONFIG, and SLIVER_GUI_E2E_SESSION_ID or SLIVER_GUI_E2E_SESSION_NAME to opt in",
    timeout: 10 * 60_000,
  },
  async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const sourceConfigPath = requiredConfigPath();
    validateConfiguredTargetSelector();
    const packagedApplication = await findPackagedApplication(repositoryRoot);
    const { executablePath } = packagedApplication;
    await verifyExactPackagedArchive(repositoryRoot, packagedApplication.archivePath);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-packaged-real-m3-"));
    const isolatedHome = join(temporaryRoot, "home");
    const savedConfigDirectory = join(isolatedHome, ".sliver-client", "configs");
    const userDataDirectory = join(temporaryRoot, "user-data");
    const copiedConfigPath = join(savedConfigDirectory, "m3-real-operator.cfg");

    const configBytes = await readBoundedConfig(sourceConfigPath);
    let config: SliverClientConfig;
    try {
      config = parseConfig(configBytes);
      assertLoopbackMtlsConfig(config);
      await Promise.all([
        mkdir(savedConfigDirectory, { recursive: true }),
        mkdir(userDataDirectory, { recursive: true }),
      ]);
      await writeFile(copiedConfigPath, configBytes, { mode: 0o600 });
    } catch (error) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "M3 real E2E setup failed and its isolated data could not be removed",
        );
      }
      throw error;
    } finally {
      configBytes.fill(0);
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(copiedConfigPath)).mode & 0o777, 0o600);
      await access(executablePath, constants.X_OK);
    }

    const client = new SliverClient(config);
    let electronApplication: ElectronApplication | undefined;
    let page: Page | undefined;
    let authorizedSession: AuthorizedSession | undefined;
    let baselineProcessIds = new Set<number>();
    let baselineProcessInventoryCaptured = false;
    let ownedShellProcess: OwnedShellProcess | undefined;
    let baselineManagedShellsConfirmedEmpty = false;
    const ownedResourceIds = new Set<string>();
    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];

    try {
      await client.connect();
      authorizedSession = selectAuthorizedActiveSession((await client.getSessions(30)).Sessions);
      baselineProcessIds = await captureBaselineProcessIds(client, authorizedSession);
      baselineProcessInventoryCaptured = true;

      electronApplication = await launchPackagedApplication({
        executablePath,
        isolatedHome,
        repositoryRoot,
        userDataDirectory,
      });
      page = await electronApplication.firstWindow();
      page.on("console", (message) => consoleMessages.push(message.text()));
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await connectSavedConfig(page);
      await openAuthorizedSessionWorkspace(page, authorizedSession);
      await page.getByRole("tab", { name: "Terminal", exact: true }).click();
      await page.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();

      const initialInventory = await listManagedShells(page);
      assert.deepEqual(initialInventory.resources, [], "the isolated window must begin without managed shells");
      assert.equal(initialInventory.metrics.activeStreams, 0);
      baselineManagedShellsConfirmedEmpty = true;
      await installRendererStreamProbe(page);

      await page.getByRole("button", { name: "New shell", exact: true }).first().click();
      const terminalLabel = `Interactive shell for ${sessionDisplayName(authorizedSession)}`;
      const terminal = page.getByRole("textbox", { name: terminalLabel, exact: true });
      await terminal.waitFor({ timeout: SHELL_WAIT_MILLISECONDS });
      await page.locator('[data-terminal-state="ready"]').waitFor({ timeout: SHELL_WAIT_MILLISECONDS });
      await page.getByText("Attached", { exact: true }).first().waitFor();

      const openedInventory = await waitForManagedShellCount(page, 1);
      const resource = openedInventory.resources[0]!;
      ownedResourceIds.add(resource.resourceId);
      ownedShellProcess = await waitForOwnedShellProcess(
        client,
        authorizedSession,
        baselineProcessIds,
      );
      await assertSessionShellSemantics(page, authorizedSession, resource);

      const firstMarker = syntheticMarker("OPEN");
      await sendSyntheticCommandAndVerifyOutput(
        page,
        terminal,
        ownedShellProcess.executable,
        firstMarker,
      );
      await waitForNonZeroTerminalMetric(page, "Bytes in");
      await waitForNonZeroTerminalMetric(page, "Bytes out");

      if (resource.canResize) {
        const resizeCount = await readResizeFrameCount(page);
        await resizeApplicationWindow(electronApplication);
        await waitForResizeFrameCount(page, resizeCount + 1);
        await page.getByText(/Resize requested · unconfirmed/u).first().waitFor();
        const resizedMarker = syntheticMarker("RESIZED");
        await sendSyntheticCommandAndVerifyOutput(
          page,
          terminal,
          ownedShellProcess.executable,
          resizedMarker,
        );
      } else {
        assert.equal(await readResizeFrameCount(page), 0, "a non-PTY shell must not emit resize frames");
        await page.getByText(/Windows resize unavailable/u).first().waitFor();
      }

      await page.getByRole("button", { name: "Detach", exact: true }).click();
      await page.getByText("Shell is not attached", { exact: true }).waitFor();
      assert.equal(await terminal.count(), 0, "detach must dispose the payload-bearing terminal surface");
      const detached = await waitForManagedResourceState(page, resource.resourceId, "detached");
      assert.equal(detached.resourceId, resource.resourceId);
      await assertRemoteProcessPresent(client, authorizedSession, ownedShellProcess);

      await page.getByRole("button", { name: "Attach", exact: true }).first().click();
      const reattachedTerminal = page.getByRole("textbox", { name: terminalLabel, exact: true });
      await reattachedTerminal.waitFor({ timeout: SHELL_WAIT_MILLISECONDS });
      await page.locator('[data-terminal-state="ready"]').waitFor({ timeout: SHELL_WAIT_MILLISECONDS });
      await page.getByText("Attached", { exact: true }).first().waitFor();
      const reattachedMarker = syntheticMarker("REATTACHED");
      await sendSyntheticCommandAndVerifyOutput(
        page,
        reattachedTerminal,
        ownedShellProcess.executable,
        reattachedMarker,
      );
      await assertRemoteProcessPresent(client, authorizedSession, ownedShellProcess);

      await page.getByRole("toolbar", { name: "Terminal actions", exact: true })
        .getByRole("button", { name: "Close", exact: true })
        .click();
      const closeReview = page.getByRole("alertdialog", {
        name: "Close this managed shell?",
        exact: true,
      });
      await closeReview.waitFor();
      assert.match(await closeReview.innerText(), /does not confirm remote process termination/iu);
      await closeReview.getByRole("button", { name: "Close shell", exact: true }).click();
      await waitForManagedResourceAbsent(page, resource.resourceId);
      ownedResourceIds.delete(resource.resourceId);
      await waitForRemoteProcessAbsent(client, authorizedSession, ownedShellProcess);
      await assertManagedShellInventoryEmpty(page);
      await assertAuthorizedSessionUnchanged(client, authorizedSession);

      const visibleText = [
        await page.locator("body").innerText(),
        JSON.stringify(await rendererSnapshot(page)),
        ...consoleMessages,
        ...pageErrors,
      ].join("\n");
      for (const forbidden of [
        config.token,
        config.private_key,
        sourceConfigPath,
        copiedConfigPath,
      ]) {
        if (forbidden) assert.ok(!visibleText.includes(forbidden), "the packaged renderer exposed operator material");
      }
      assert.deepEqual(pageErrors, []);
      await clearRendererStreamProbe(page);
    } catch (error) {
      primaryFailure = error;
    } finally {
      if (page && baselineManagedShellsConfirmedEmpty) {
        try {
          const cleanupResources = (await listManagedShells(page)).resources;
          for (const resource of cleanupResources) {
            ownedResourceIds.add(resource.resourceId);
          }
          for (const resource of cleanupResources) {
            await actOnExactManagedResource(
              page,
              resource.resourceId,
              resource.canKill ? "kill" : "close",
            );
          }
          await assertManagedShellInventoryEmpty(page);
        } catch (error) {
          cleanupFailures.push(new Error("Exact M3 managed-shell cleanup could not be verified", { cause: error }));
        }
      }
      if (authorizedSession && ownedShellProcess) {
        try {
          await waitForRemoteProcessAbsent(client, authorizedSession, ownedShellProcess);
        } catch (error) {
          cleanupFailures.push(new Error("The exact M3 shell process did not exit after managed-resource cleanup", { cause: error }));
        }
      }
      if (authorizedSession && baselineProcessInventoryCaptured && !ownedShellProcess) {
        try {
          await waitForNoNewShellChildren(client, authorizedSession, baselineProcessIds);
        } catch (error) {
          cleanupFailures.push(new Error("M3 could not prove that no untracked shell child remained", { cause: error }));
        }
      }
      if (authorizedSession) {
        try {
          await assertAuthorizedSessionUnchanged(client, authorizedSession);
        } catch (error) {
          cleanupFailures.push(new Error("The authorized baseline session did not remain unchanged", { cause: error }));
        }
      }
      if (electronApplication) {
        try {
          await electronApplication.close();
        } catch (error) {
          cleanupFailures.push(new Error("Packaged M3 application teardown failed", { cause: error }));
        }
      }
      try {
        await client.disconnect();
      } catch (error) {
        cleanupFailures.push(new Error("M3 cleanup client did not disconnect", { cause: error }));
      }
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(new Error("M3 isolated temporary directory cleanup failed", { cause: error }));
      }
    }

    if (primaryFailure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [primaryFailure, ...cleanupFailures],
          "M3 real E2E failed and exact cleanup was incomplete",
        );
      }
      throw primaryFailure;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "M3 real E2E exact cleanup was incomplete");
    }
  },
);

type AuthorizedSession = Readonly<Pick<
  clientpb.Session,
  "ID" | "Name" | "Hostname" | "UUID" | "PID" | "OS" | "Arch" | "Filename"
>>;

interface OwnedShellProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly executable: string;
}

function assertLoopbackMtlsConfig(config: SliverClientConfig): void {
  if (config.wg !== undefined) {
    throw new Error("The M3 real harness accepts mTLS operator configurations only; WireGuard is not claimed");
  }
  const configuredHost = config.lhost.toLowerCase();
  const literalHost = configuredHost === "[::1]" ? "::1" : configuredHost;
  if (literalHost !== "127.0.0.1" && literalHost !== "::1") {
    throw new Error("The M3 real harness requires a literal loopback Sliver server address");
  }
}

function selectAuthorizedActiveSession(sessions: readonly clientpb.Session[]): AuthorizedSession {
  const requestedId = optionalSafeSelector(SESSION_ID, "SLIVER_GUI_E2E_SESSION_ID");
  const requestedName = optionalSafeSelector(SESSION_NAME, "SLIVER_GUI_E2E_SESSION_NAME");
  if (!requestedId && !requestedName) throw new Error("An exact session ID or unique session name is required");

  const matches = requestedId
    ? sessions.filter((session) => session.ID === requestedId)
    : sessions.filter((session) => session.Name === requestedName);
  if (matches.length !== 1) {
    throw new Error("The configured session selector must resolve to exactly one server session");
  }
  const session = matches[0]!;
  if (requestedName && session.Name !== requestedName) {
    throw new Error("The configured session ID and name do not identify the same target");
  }
  if (session.IsDead) throw new Error("The explicitly authorized session is not active");
  if (!session.ID.trim() || session.PID <= 0) {
    throw new Error("The authorized session lacks the identity needed for exact process cleanup verification");
  }
  return Object.freeze({
    ID: session.ID,
    Name: session.Name,
    Hostname: session.Hostname,
    UUID: session.UUID,
    PID: session.PID,
    OS: session.OS,
    Arch: session.Arch,
    Filename: session.Filename,
  });
}

function validateConfiguredTargetSelector(): void {
  const id = optionalSafeSelector(SESSION_ID, "SLIVER_GUI_E2E_SESSION_ID");
  const name = optionalSafeSelector(SESSION_NAME, "SLIVER_GUI_E2E_SESSION_NAME");
  if (!id && !name) {
    throw new Error("SLIVER_GUI_E2E_SESSION_ID or SLIVER_GUI_E2E_SESSION_NAME is required when M3 real E2E is enabled");
  }
}

function optionalSafeSelector(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (!value || value.length > 1_024 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error(`${label} must be a bounded printable exact selector`);
  }
  return value;
}

async function captureBaselineProcessIds(
  client: SliverClient,
  session: AuthorizedSession,
): Promise<Set<number>> {
  const inventory = await client.psSession(session.ID, true, 30);
  if (inventory.Response?.Err?.trim()) throw new Error("The authorized session rejected process inventory");
  return new Set(inventory.Processes.map((process) => process.Pid));
}

async function waitForOwnedShellProcess(
  client: SliverClient,
  session: AuthorizedSession,
  baselineProcessIds: ReadonlySet<number>,
): Promise<OwnedShellProcess> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const candidate = await findUniqueNewShellProcess(client, session, baselineProcessIds);
    if (candidate) return candidate;
    await delay(250);
  }
  throw new Error(
    "The public process inventory did not expose one exact new shell child; Sliver has no public tunnel or shell inventory fallback",
  );
}

async function findUniqueNewShellProcess(
  client: SliverClient,
  session: AuthorizedSession,
  baselineProcessIds: ReadonlySet<number>,
): Promise<OwnedShellProcess | undefined> {
  const inventory = await client.psSession(session.ID, true, 30);
  if (inventory.Response?.Err?.trim()) throw new Error("The authorized session rejected process inventory");
  const candidates = inventory.Processes.filter((process) =>
    !baselineProcessIds.has(process.Pid) &&
    process.Ppid === session.PID &&
    isExpectedShellExecutable(
      session.OS,
      remoteExecutableName(process.Executable, process.CmdLine[0]),
    ),
  );
  if (candidates.length > 1) {
    throw new Error("More than one new exact shell-process candidate appeared; ownership is ambiguous");
  }
  const candidate = candidates[0];
  return candidate
    ? Object.freeze({
        pid: candidate.Pid,
        ppid: candidate.Ppid,
        executable: remoteExecutableName(candidate.Executable, candidate.CmdLine[0]),
      })
    : undefined;
}

async function assertRemoteProcessPresent(
  client: SliverClient,
  session: AuthorizedSession,
  process: OwnedShellProcess,
): Promise<void> {
  const inventory = await client.psSession(session.ID, true, 30);
  if (inventory.Response?.Err?.trim()) throw new Error("The authorized session rejected process inventory");
  assert.ok(inventory.Processes.some((candidate) =>
    candidate.Pid === process.pid &&
    candidate.Ppid === process.ppid &&
    remoteExecutableName(candidate.Executable, candidate.CmdLine[0]) === process.executable,
  ), "the exact managed shell process disappeared unexpectedly");
}

async function waitForRemoteProcessAbsent(
  client: SliverClient,
  session: AuthorizedSession,
  process: OwnedShellProcess,
): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const inventory = await client.psSession(session.ID, true, 30);
    if (inventory.Response?.Err?.trim()) throw new Error("The authorized session rejected process inventory");
    if (!inventory.Processes.some((candidate) => candidate.Pid === process.pid)) return;
    await delay(250);
  }
  throw new Error("The exact shell PID remains present after managed-handle close");
}

async function waitForNoNewShellChildren(
  client: SliverClient,
  session: AuthorizedSession,
  baselineProcessIds: ReadonlySet<number>,
): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const inventory = await client.psSession(session.ID, true, 30);
    if (inventory.Response?.Err?.trim()) throw new Error("The authorized session rejected process inventory");
    const remaining = inventory.Processes.some((process) =>
      !baselineProcessIds.has(process.Pid) &&
      process.Ppid === session.PID &&
      isExpectedShellExecutable(
        session.OS,
        remoteExecutableName(process.Executable, process.CmdLine[0]),
      ),
    );
    if (!remaining) return;
    await delay(250);
  }
  throw new Error("A new direct shell child remains after all exact managed resources were closed");
}

function remoteExecutableName(executable: string, argv0: string | undefined): string {
  const value = executable.trim() || argv0?.trim() || "";
  return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

function isExpectedShellExecutable(os: string, executable: string): boolean {
  return isWindows(os)
    ? executable === "powershell.exe" || executable === "cmd.exe"
    : executable === "bash" || executable === "sh";
}

async function openAuthorizedSessionWorkspace(page: Page, session: AuthorizedSession): Promise<void> {
  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("searchbox", { name: "Filter sessions", exact: true }).fill(session.ID);
  const grid = page.getByRole("grid", { name: "Sliver sessions", exact: true });
  const row = grid.getByRole("row").filter({ hasText: session.ID });
  await row.waitFor();
  assert.equal(await row.count(), 1, "the GUI session filter must resolve to one exact row");
  await row.getByRole("button", { name: /^Interact with /u }).click();
  await page.getByRole("heading", { name: sessionDisplayName(session), exact: true }).waitFor();
  await page.getByLabel("Identity").getByText(session.ID, { exact: true }).waitFor();
  const snapshot = await rendererSnapshot(page);
  assert.equal(snapshot.targetContext.activeTarget?.mode, "session");
  assert.equal(snapshot.targetContext.activeTarget?.id, session.ID);
}

function sessionDisplayName(session: AuthorizedSession): string {
  return session.Name || session.Hostname || session.ID;
}

async function assertSessionShellSemantics(
  page: Page,
  session: AuthorizedSession,
  resource: SessionShellResource,
): Promise<void> {
  if (isWindows(session.OS)) {
    assert.equal(resource.pty, "disabled");
    assert.equal(resource.canResize, false);
    await page.getByText(/Non-PTY/u).first().waitFor();
    return;
  }
  assert.equal(resource.pty, "requested-unconfirmed");
  assert.equal(resource.canResize, true);
  await page.getByText(/PTY requested · unconfirmed/u).first().waitFor();
}

function isWindows(os: string): boolean {
  return os.toLowerCase().includes("windows");
}

function syntheticMarker(stage: string): string {
  return `SLIVERGUIM3${stage}${Date.now().toString(36).toUpperCase()}${process.pid.toString(36).toUpperCase()}`;
}

function syntheticCommand(executable: string, marker: string): string {
  const split = Math.floor(marker.length / 2);
  const left = marker.slice(0, split);
  const right = marker.slice(split);
  if (executable === "cmd.exe") return `echo ${left}^${right}`;
  if (executable === "powershell.exe") return `Write-Output ('${left}' + '${right}')`;
  return `printf '%s%s\\n' '${left}' '${right}'`;
}

async function sendSyntheticCommandAndVerifyOutput(
  page: Page,
  terminal: ReturnType<Page["getByRole"]>,
  executable: string,
  marker: string,
): Promise<void> {
  await clearRenderedGlyphs(page);
  await terminal.pressSequentially(syntheticCommand(executable, marker));
  await terminal.press("Enter");
  await waitForRenderedMarker(page, marker);
}

interface RendererStreamProbe {
  glyphs: string;
  resizeFrames: Array<{ rows: number; columns: number }>;
}

type RendererFillText = (
  this: unknown,
  text: string,
  x: number,
  y: number,
  maxWidth?: number,
) => void;

type RendererPostMessage = (
  this: unknown,
  message: unknown,
  options?: unknown,
) => void;

async function installRendererStreamProbe(page: Page): Promise<void> {
  await page.evaluate(({ textLimit }) => {
    const browserGlobal = globalThis as unknown as {
      __SLIVER_GUI_M3_REAL_PROBE__?: RendererStreamProbe;
      CanvasRenderingContext2D: { prototype: { fillText: RendererFillText } };
      MessagePort: { prototype: { postMessage: RendererPostMessage } };
    };
    if (browserGlobal.__SLIVER_GUI_M3_REAL_PROBE__) {
      browserGlobal.__SLIVER_GUI_M3_REAL_PROBE__.glyphs = "";
      browserGlobal.__SLIVER_GUI_M3_REAL_PROBE__.resizeFrames.length = 0;
      return;
    }
    const probe: RendererStreamProbe = { glyphs: "", resizeFrames: [] };
    browserGlobal.__SLIVER_GUI_M3_REAL_PROBE__ = probe;

    const canvasPrototype = browserGlobal.CanvasRenderingContext2D.prototype;
    const originalFillText = canvasPrototype.fillText;
    canvasPrototype.fillText = function observedFillText(
      this: unknown,
      text: string,
      x: number,
      y: number,
      maxWidth?: number,
    ): void {
      probe.glyphs = `${probe.glyphs}${text}`.slice(-textLimit);
      Reflect.apply(
        originalFillText,
        this,
        maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth],
      );
    };

    const messagePortPrototype = browserGlobal.MessagePort.prototype;
    const originalPostMessage = messagePortPrototype.postMessage;
    messagePortPrototype.postMessage = function observedPostMessage(
      this: unknown,
      message: unknown,
      options?: unknown,
    ): void {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "resize"
      ) {
        const frame = message as { rows?: unknown; columns?: unknown };
        if (typeof frame.rows === "number" && typeof frame.columns === "number") {
          probe.resizeFrames.push({ rows: frame.rows, columns: frame.columns });
        }
      }
      Reflect.apply(
        originalPostMessage,
        this,
        options === undefined ? [message] : [message, options],
      );
    };
  }, { textLimit: RENDERER_PROBE_TEXT_LIMIT });
}

async function clearRenderedGlyphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (globalThis as unknown as {
      __SLIVER_GUI_M3_REAL_PROBE__: RendererStreamProbe;
    }).__SLIVER_GUI_M3_REAL_PROBE__;
    probe.glyphs = "";
  });
}

async function clearRendererStreamProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const probe = (globalThis as unknown as {
      __SLIVER_GUI_M3_REAL_PROBE__?: RendererStreamProbe;
    }).__SLIVER_GUI_M3_REAL_PROBE__;
    if (!probe) return;
    probe.glyphs = "";
    probe.resizeFrames.length = 0;
  });
}

async function waitForRenderedMarker(page: Page, marker: string): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const observed = await page.evaluate((expected) => (
      (globalThis as unknown as { __SLIVER_GUI_M3_REAL_PROBE__: RendererStreamProbe })
        .__SLIVER_GUI_M3_REAL_PROBE__.glyphs.includes(expected)
    ), marker);
    if (observed) return;
    await delay(50);
  }
  throw new Error("The exact synthetic command output was not rendered by Ghostty");
}

async function readResizeFrameCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    (globalThis as unknown as { __SLIVER_GUI_M3_REAL_PROBE__: RendererStreamProbe })
      .__SLIVER_GUI_M3_REAL_PROBE__.resizeFrames.length
  ));
}

async function waitForResizeFrameCount(page: Page, minimum: number): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await readResizeFrameCount(page) >= minimum) return;
    await delay(50);
  }
  throw new Error("The attached PTY did not emit the expected bounded resize frame");
}

async function resizeApplicationWindow(application: ElectronApplication): Promise<void> {
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected one packaged application window");
    const [width = 1_440, height = 920] = window.getSize();
    window.setSize(Math.max(960, width - 160), Math.max(680, height - 80));
  });
}

async function waitForNonZeroTerminalMetric(
  page: Page,
  label: "Bytes in" | "Bytes out",
): Promise<void> {
  const metric = page.getByText(label, { exact: true }).locator("..").locator("dd");
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const latest = (await metric.textContent().catch(() => null))?.trim();
    if (latest && latest !== "0") return;
    await delay(50);
  }
  throw new Error(`${label} did not become non-zero`);
}

async function listManagedShells(page: Page): Promise<SessionShellResourceList> {
  const result = await invokeSliver(page, "listSessionShells", {});
  assert.equal(result.ok, true, result.error ?? "managed-shell inventory failed");
  assert.ok(result.value);
  return result.value;
}

async function waitForManagedShellCount(page: Page, count: number): Promise<SessionShellResourceList> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const inventory = await listManagedShells(page);
    if (inventory.resources.length === count) return inventory;
    await delay(50);
  }
  throw new Error(`Managed-shell inventory did not reach exactly ${count} resources`);
}

async function waitForManagedResourceState(
  page: Page,
  resourceId: string,
  state: SessionShellResource["state"],
): Promise<SessionShellResource> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    const resource = (await listManagedShells(page)).resources.find((candidate) =>
      candidate.resourceId === resourceId,
    );
    if (resource?.state === state) return resource;
    await delay(50);
  }
  throw new Error(`The exact managed shell did not reach ${state}`);
}

async function waitForManagedResourceAbsent(page: Page, resourceId: string): Promise<void> {
  const deadline = Date.now() + SHELL_WAIT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (!(await listManagedShells(page)).resources.some((resource) => resource.resourceId === resourceId)) return;
    await delay(50);
  }
  throw new Error("The exact managed shell resource remains present after close");
}

async function actOnExactManagedResource(
  page: Page,
  resourceId: string,
  action: Extract<SessionShellResourceAction, "close" | "kill">,
): Promise<void> {
  if (!(await listManagedShells(page)).resources.some((resource) => resource.resourceId === resourceId)) return;
  const result = await invokeSliver(page, "actOnSessionShell", { resourceId, action });
  assert.equal(result.ok, true, result.error ?? `exact managed-shell ${action} failed`);
  await waitForManagedResourceAbsent(page, resourceId);
}

async function assertManagedShellInventoryEmpty(page: Page): Promise<void> {
  const inventory = await waitForManagedShellCount(page, 0);
  assert.equal(inventory.metrics.activeStreams, 0);
  assert.equal(inventory.metrics.attachedStreams, 0);
  assert.equal(inventory.metrics.detachedStreams, 0);
  assert.equal(inventory.metrics.reservedBytes, 0);
  assert.equal(inventory.metrics.queuedBytes, 0);
  assert.equal(inventory.metrics.inFlightBytes, 0);
}

/**
 * Upstream exposes CreateTunnel/CloseTunnel but no operator RPC for enumerating
 * live tunnels or shell handles. Exact manager-resource removal, exact remote
 * child-PID disappearance, and unchanged session identity are therefore the
 * strongest no-orphan assertions available without reaching into server-only
 * state or exposing a raw tunnel ID to the renderer.
 */
async function assertAuthorizedSessionUnchanged(
  client: SliverClient,
  expected: AuthorizedSession,
): Promise<void> {
  const match = (await client.getSessions(30)).Sessions.find((session) => session.ID === expected.ID);
  assert.ok(match, "the authorized baseline session disappeared");
  assert.equal(match.IsDead, false);
  assert.deepEqual(
    {
      ID: match.ID,
      Name: match.Name,
      Hostname: match.Hostname,
      UUID: match.UUID,
      PID: match.PID,
      OS: match.OS,
      Arch: match.Arch,
      Filename: match.Filename,
    },
    expected,
  );
}

type SliverMethod = keyof SliverDesktopAPI;
type SliverMethodArgs<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: infer Args) => unknown ? Args : never;
type SliverMethodResult<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: never[]) => infer Result ? Awaited<Result> : never;

async function invokeSliver<Method extends SliverMethod>(
  page: Page,
  method: Method,
  ...args: SliverMethodArgs<Method>
): Promise<SliverMethodResult<Method>> {
  return page.evaluate(async ({ method: rendererMethod, args: rendererArgs }) => {
    const api = (globalThis as unknown as {
      sliver: Record<string, (...values: unknown[]) => Promise<unknown>>;
    }).sliver;
    return api[rendererMethod]!(...rendererArgs);
  }, { method, args }) as Promise<SliverMethodResult<Method>>;
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return invokeSliver(page, "getSnapshot");
}

async function connectSavedConfig(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /connect to sliver/iu });
  await dialog.waitFor();
  const option = dialog.getByRole("option", { name: /m3-real-operator/iu });
  await option.waitFor();
  if ((await option.getAttribute("aria-selected")) !== "true") await option.click();
  await dialog.getByRole("button", { name: /^connect$/iu }).click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor({ timeout: 30_000 });
  const mismatch = page.getByRole("dialog", { name: "Server build mismatch" });
  let mismatchVisible = false;
  try {
    await mismatch.waitFor({ state: "visible", timeout: 5_000 });
    mismatchVisible = true;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
  }
  if (mismatchVisible) {
    await mismatch.getByRole("button", { name: "Continue" }).click();
    await mismatch.waitFor({ state: "hidden" });
  }
}

async function launchPackagedApplication(input: {
  executablePath: string;
  isolatedHome: string;
  repositoryRoot: string;
  userDataDirectory: string;
}): Promise<ElectronApplication> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && !entry[0].startsWith("SLIVER_GUI_"),
    ),
  );
  return electron.launch({
    executablePath: input.executablePath,
    args: ["--enable-sandbox", `--user-data-dir=${input.userDataDirectory}`],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: input.repositoryRoot,
    env: {
      ...environment,
      HOME: input.isolatedHome,
      USERPROFILE: input.isolatedHome,
      XDG_CONFIG_HOME: join(input.isolatedHome, ".config"),
      ELECTRON_RENDERER_URL: "http://127.0.0.1:65535/",
    },
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function readBoundedConfig(path: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("SLIVER_GUI_E2E_CONFIG must name a regular file");
  if (info.size < 1 || info.size > MAX_OPERATOR_CONFIG_BYTES) {
    throw new Error(`SLIVER_GUI_E2E_CONFIG must be between 1 and ${MAX_OPERATOR_CONFIG_BYTES} bytes`);
  }
  return readFile(path);
}

function requiredConfigPath(): string {
  if (!CONFIG_PATH || !isAbsolute(CONFIG_PATH)) {
    throw new Error("SLIVER_GUI_E2E_CONFIG must be an absolute mTLS operator config path");
  }
  return CONFIG_PATH;
}

interface PackagedApplication {
  executablePath: string;
  archivePath: string;
}

async function findPackagedApplication(repositoryRoot: string): Promise<PackagedApplication> {
  const configured = process.env["SLIVER_GUI_PACKAGED_EXECUTABLE"];
  let candidate: string;
  if (configured) {
    if (!isAbsolute(configured)) {
      throw new Error("SLIVER_GUI_PACKAGED_EXECUTABLE must be an absolute packaged application path");
    }
    candidate = configured;
  } else {
    const releaseDirectory = join(repositoryRoot, "release");
    const files = await listFiles(releaseDirectory);
    const matches = files.filter((path) => {
      try {
        packagedArchiveCandidateForExecutable(path, process.platform);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length === 0) throw new Error(`No packaged application found under ${releaseDirectory}`);
    const dated = await Promise.all(matches.map(async (path) => ({ path, time: (await stat(path)).mtimeMs })));
    dated.sort((left, right) => right.time - left.time || left.path.localeCompare(right.path));
    candidate = dated[0]!.path;
  }

  const executablePath = await realpath(candidate);
  const executableMetadata = await stat(executablePath);
  if (!executableMetadata.isFile()) throw new Error("The packaged executable must be a regular file");
  await access(executablePath, constants.X_OK);

  const archiveCandidate = packagedArchiveCandidateForExecutable(executablePath, process.platform);
  const archivePath = await realpath(archiveCandidate);
  const archiveMetadata = await stat(archivePath);
  if (!archiveMetadata.isFile()) throw new Error("The packaged app.asar must be a regular file");
  return { executablePath, archivePath };
}

function packagedArchiveCandidateForExecutable(executablePath: string, platform: NodeJS.Platform): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const executableName = pathApi.basename(executablePath);
  const executableDirectory = pathApi.dirname(executablePath);

  if (platform === "darwin") {
    const contentsDirectory = pathApi.dirname(executableDirectory);
    const applicationDirectory = pathApi.dirname(contentsDirectory);
    if (
      executableName !== "Sliver GUI"
      || basename(executableDirectory) !== "MacOS"
      || basename(contentsDirectory) !== "Contents"
      || !basename(applicationDirectory).endsWith(".app")
    ) {
      throw new Error("Executable is outside the reviewed packaged application layout");
    }
    return pathApi.join(contentsDirectory, "Resources", "app.asar");
  }

  const releaseDirectoryName = pathApi.basename(executableDirectory);
  const expectedExecutable = platform === "win32" ? "sliver gui.exe" : "sliver-gui";
  const expectedReleaseDirectory = platform === "win32" ? /^win(?:-[^/\\]+)?$/iu : /^linux(?:-[^/]+)?$/u;
  if (executableName.toLowerCase() !== expectedExecutable || !expectedReleaseDirectory.test(releaseDirectoryName)) {
    throw new Error("Executable is outside the reviewed packaged application layout");
  }
  return pathApi.join(executableDirectory, "resources", "app.asar");
}

async function verifyExactPackagedArchive(repositoryRoot: string, archivePath: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [join(repositoryRoot, "scripts", "verifyReleaseContent.mjs"), "--packaged", "--archive", archivePath],
    { cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 },
  );
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
