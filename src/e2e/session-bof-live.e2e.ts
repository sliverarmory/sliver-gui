import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { SliverClient, clientpb, parseConfig } from "sliver-script";

import { artifactFormatFromProto, buildImplantConfig } from "../main/implant-config.js";
import type { BofCommand } from "../shared/bof-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import { cloneGenerateInput, defaultGenerateInput } from "../shared/generate-defaults.js";

const ENABLED = process.env["SLIVER_GUI_BOF_LIVE_E2E"] === "1";
const execFileAsync = promisify(execFile);

/**
 * Fully isolated, explicit opt-in. The supplied binary is started with a new
 * SLIVER_ROOT_DIR; its operator config, listener, generated Darwin session,
 * and GUI client root exist only under this test's temporary directory. No
 * existing operator config, Sliver server, target, or Armory file is changed.
 */
test("production GUI executes two installed BOFs on a test-owned loopback Sliver session", {
  skip: ENABLED ? false : "Set SLIVER_GUI_BOF_LIVE_E2E=1, SLIVER_GUI_BOF_E2E_SERVER_BINARY, and SLIVER_GUI_BOF_E2E_ARMORY_ROOT to opt in",
  timeout: 30 * 60_000,
}, async () => {
  assert.equal(process.platform, "darwin", "The live BOF fixture requires a Darwin host");
  assert.equal(process.arch, "arm64", "The live BOF fixture requires an arm64 host");
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const binaryPath = await requiredRegularExecutable("SLIVER_GUI_BOF_E2E_SERVER_BINARY");
  const armoryRoot = await requiredDirectory("SLIVER_GUI_BOF_E2E_ARMORY_ROOT");
  await access(join(repositoryRoot, "dist", "main", "index.js"), constants.R_OK);

  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-bof-live-"));
  const isolatedHome = join(temporaryRoot, "home");
  const serverRoot = join(temporaryRoot, "server");
  const clientRoot = join(temporaryRoot, "client");
  const configDirectory = join(clientRoot, "configs");
  const operatorConfigPath = join(configDirectory, "bof-live-operator.cfg");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const probeDirectory = join(temporaryRoot, "probe");
  const implantPath = join(temporaryRoot, "implants", "bof-live-session");
  const marker = `bof-live-${process.pid}-${Date.now().toString(36)}.txt`;
  const sessionName = `boflive-${process.pid}-${Date.now().toString(36)}`;
  const testEnvironment = isolatedEnvironment(isolatedHome, serverRoot);

  let server: ChildProcess | undefined;
  let implant: ChildProcess | undefined;
  let application: ElectronApplication | undefined;
  let client: SliverClient | undefined;
  let primaryFailure: unknown;
  const cleanupFailures: unknown[] = [];
  try {
    await Promise.all([
      mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
      mkdir(serverRoot, { recursive: true, mode: 0o700 }),
      mkdir(configDirectory, { recursive: true, mode: 0o700 }),
      mkdir(userDataDirectory, { recursive: true, mode: 0o700 }),
      mkdir(probeDirectory, { recursive: true, mode: 0o700 }),
      mkdir(join(temporaryRoot, "implants"), { recursive: true, mode: 0o700 }),
      mkdir(join(temporaryRoot, "go-cache"), { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(join(probeDirectory, marker), "test-owned BOF argument proof\n", { mode: 0o600 });
    await Promise.all([
      copyInstalledBof(armoryRoot, clientRoot, "sa-dir", "sa-dir"),
      copyInstalledBof(armoryRoot, clientRoot, "sa-nslookup", "sa-nslookup"),
    ]);

    const operatorPort = await freeLoopbackPort();
    let c2Port = await freeLoopbackPort();
    while (c2Port === operatorPort) c2Port = await freeLoopbackPort();
    server = spawn(binaryPath, ["daemon", "--lhost", "127.0.0.1", "--lport", String(operatorPort)], {
      cwd: temporaryRoot,
      env: { ...testEnvironment, GOCACHE: join(temporaryRoot, "go-cache") },
      stdio: "ignore",
      windowsHide: true,
    });
    server.once("error", () => undefined);
    await waitForLoopbackPort(operatorPort, server, 120_000);

    await execFileAsync(binaryPath, [
      "operator", "--name", "bof-live-operator", "--lhost", "127.0.0.1",
      "--lport", String(operatorPort), "--permissions", "all", "--save", operatorConfigPath,
    ], { cwd: temporaryRoot, env: testEnvironment, timeout: 120_000, maxBuffer: 1_000_000 });
    const configBytes = await readFile(operatorConfigPath);
    assert.ok(configBytes.length > 0 && configBytes.length < 4 * 1_024 * 1_024);
    const config = parseConfig(configBytes);
    configBytes.fill(0);
    assert.equal(config.lhost, "127.0.0.1");
    assert.equal(config.lport, operatorPort);
    assert.equal(config.wg, undefined);
    assert.equal((await stat(operatorConfigPath)).mode & 0o777, 0o600);

    client = new SliverClient(config);
    await client.connect();
    assert.deepEqual((await client.getSessions()).Sessions, [], "the isolated Sliver root must start without sessions");
    const listener = await client.startMTLSListener("127.0.0.1", c2Port, 30);
    assert.ok(listener.JobID > 0, "the test listener must have an exact job ID");
    const compiler = await client.getCompiler(30);
    const target = compiler.Targets.find((candidate) =>
      candidate.GOOS === "darwin" && candidate.GOARCH === "arm64" &&
      candidate.Format === clientpb.OutputFormat.EXECUTABLE);
    assert.ok(target, "the isolated server must support Darwin/arm64 executable builds");
    const generateInput = cloneGenerateInput(defaultGenerateInput);
    Object.assign(generateInput, {
      name: sessionName,
      implantType: "session" as const,
      os: "darwin",
      arch: "arm64",
      format: artifactFormatFromProto(target.Format),
      c2: `mtls://127.0.0.1:${c2Port}`,
      reconnectSeconds: 2,
      pollTimeoutSeconds: 60,
      obfuscateSymbols: false,
    });
    const generated = await client.generateImplant(buildImplantConfig(generateInput), sessionName, 15 * 60);
    assert.ok(generated.File?.Data && generated.File.Data.length > 1_000, "the server must return an executable implant");
    await writeFile(implantPath, generated.File.Data, { mode: 0o700 });
    generated.File.Data.fill(0);

    application = await launchProductionApplication(repositoryRoot, isolatedHome, clientRoot, userDataDirectory);
    const page = await application.firstWindow();
    page.setDefaultTimeout(30_000);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await connectSavedOperator(page);

    implant = spawn(implantPath, [], { cwd: probeDirectory, env: testEnvironment, stdio: "ignore", windowsHide: true });
    implant.once("error", () => undefined);
    const sessionId = await waitForExactSession(client, sessionName, implant, 90_000);
    const session = (await client.getSessions()).Sessions.find((candidate) => candidate.ID === sessionId);
    assert.ok(session, "the exact test-owned session must remain present");
    assert.equal(session.OS.toLowerCase(), "darwin");
    assert.equal(session.Arch.toLowerCase(), "arm64");

    await page.locator('[aria-label="Sessions"]:visible').click();
    await waitForRendererSession(page, sessionId, sessionName, 90_000);
    await page.getByRole("button", { name: `Interact with ${sessionName}`, exact: true }).click();
    await page.getByRole("heading", { name: sessionName, exact: true }).waitFor();
    const selected = await invokeSliver(page, "getSnapshot");
    assert.equal(selected.targetContext.activeTarget?.id, sessionId, "the GUI must select only the test-owned session");
    assert.equal(selected.targetContext.activeTarget?.mode, "session");
    const catalog = await invokeSliver(page, "listInstalledBofs");
    assert.equal(catalog.ok, true, catalog.error ?? "BOF catalog failed");
    assert.equal(catalog.value?.target.id, sessionId);
    for (const commandId of ["sa-dir/sa-dir", "sa-nslookup/sa-nslookup"]) {
      const command: BofCommand | undefined = catalog.value?.commands.find((candidate) => candidate.id === commandId);
      assert.ok(command?.available, `${commandId} must be available on the exact live session: ${command?.reason ?? "missing"}`);
    }

    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();
    const workspace = page.getByRole("region", { name: "BOF execution history and output" });
    const history = workspace.getByRole("navigation", { name: "BOF execution history" });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF" });
    const selector = form.getByRole("combobox", { name: "Armory BOF" });
    await selector.selectOption("sa-dir/sa-dir");
    await form.getByRole("textbox", { name: /targetdir/u }).fill(probeDirectory);
    await form.getByRole("spinbutton", { name: /subdirs/u }).fill("0");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    const dirOutput = await waitForTranscript(workspace, marker, 90_000);
    assert.match(dirOutput, /Contents of/u);
    await workspace.getByRole("button", { name: "Copy output" }).click();
    assert.ok((await application.evaluate(({ clipboard }) => clipboard.readText())).includes(marker));

    await history.getByRole("row", { name: "New Execution", exact: true }).click();
    await selector.selectOption("sa-nslookup/sa-nslookup");
    await form.getByRole("textbox", { name: /hostname/u }).fill("localhost");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    const dnsOutput = await waitForTranscript(workspace, "DNS results for localhost", 90_000);
    assert.match(dnsOutput, /127\.0\.0\.1/u);
    await workspace.getByRole("button", { name: "Copy output" }).click();
    assert.ok((await application.evaluate(({ clipboard }) => clipboard.readText())).includes("DNS results for localhost"));
    assert.equal(await history.getByRole("row").count(), 3, "both real BOF runs must be retained in history");
    assert.deepEqual(pageErrors, []);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (application) {
      try { await application.close(); }
      catch (error) { cleanupFailures.push(new Error("Could not close the test-owned GUI", { cause: error })); }
    }
    if (implant) {
      try { await stopOwnedProcess(implant, "session implant"); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (client) {
      try { await client.disconnect(); }
      catch (error) { cleanupFailures.push(new Error("Could not disconnect the test-owned operator", { cause: error })); }
    }
    if (server) {
      try { await stopOwnedProcess(server, "Sliver server"); }
      catch (error) { cleanupFailures.push(error); }
    }
    try { await rm(temporaryRoot, { recursive: true, force: true }); }
    catch (error) { cleanupFailures.push(new Error("Could not remove the test-owned temporary root", { cause: error })); }
  }
  if (primaryFailure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures],
      "Live BOF E2E failed or exact cleanup was incomplete",
    );
  }
});

function isolatedEnvironment(home: string, serverRoot: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    typeof value === "string" && !name.startsWith("SLIVER_GUI_") &&
    !name.startsWith("SLIVER_CLIENT_") && name !== "SLIVER_ROOT_DIR"));
  return {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SLIVER_ROOT_DIR: serverRoot,
  };
}

async function requiredRegularExecutable(name: string): Promise<string> {
  const configured = process.env[name]?.trim();
  if (!configured || !isAbsolute(configured)) throw new Error(`${name} must be an absolute path`);
  const info = await lstat(configured);
  if (!info.isFile()) throw new Error(`${name} must name a regular file, not a symlink`);
  await access(configured, constants.X_OK);
  return configured;
}

async function requiredDirectory(name: string): Promise<string> {
  const configured = process.env[name]?.trim();
  if (!configured || !isAbsolute(configured)) throw new Error(`${name} must be an absolute path`);
  const info = await lstat(configured);
  if (!info.isDirectory()) throw new Error(`${name} must name a directory, not a symlink`);
  return realpath(configured);
}

async function copyInstalledBof(armoryRoot: string, clientRoot: string, packageName: string, commandName: string): Promise<void> {
  const sourceDirectory = join(armoryRoot, packageName);
  const manifestPath = join(sourceDirectory, "extension.json");
  const manifestInfo = await lstat(manifestPath);
  if (!manifestInfo.isFile() || manifestInfo.size > 1_000_000) throw new Error(`${packageName} must have a regular Armory manifest`);
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    commands?: { command_name?: string; bof_executor?: string; files?: { os?: string; arch?: string; path?: string }[] }[];
  };
  const command = manifest.commands?.find((candidate) => candidate.command_name === commandName);
  assert.equal(command?.bof_executor, "reflektor", `${packageName} must use the direct Reflektor BOF path`);
  const object = command.files?.find((candidate) => candidate.os === "darwin" && candidate.arch === "arm64");
  if (!object?.path) throw new Error(`${packageName} does not install a Darwin/arm64 BOF object`);
  const objectRelative = object.path.replace(/^\/+/, "");
  const segments = objectRelative.split(/[\\/]/u);
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${packageName} has an unsafe object path`);
  }
  const sourceObject = await realpath(join(sourceDirectory, objectRelative));
  const sourceReal = await realpath(sourceDirectory);
  const offset = relative(sourceReal, sourceObject);
  if (offset.startsWith(`..${sep}`) || offset === ".." || isAbsolute(offset)) throw new Error(`${packageName} object escapes its installation`);
  const objectInfo = await lstat(sourceObject);
  if (!objectInfo.isFile() || objectInfo.size < 1 || objectInfo.size > 32 * 1_024 * 1_024) {
    throw new Error(`${packageName} must install a regular BOF object within the size limit`);
  }
  const destinationDirectory = join(clientRoot, "extensions", packageName);
  await mkdir(join(destinationDirectory, ...segments.slice(0, -1)), { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(destinationDirectory, "extension.json"), manifestBytes, { mode: 0o600 }),
    writeFile(join(destinationDirectory, ...segments), await readFile(sourceObject), { mode: 0o600 }),
  ]);
}

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

async function waitForLoopbackPort(port: number, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("The isolated Sliver server exited before its operator listener opened");
    const open = await new Promise<boolean>((resolveOpen) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolveOpen(true); });
      socket.once("error", () => { socket.destroy(); resolveOpen(false); });
    });
    if (open) return;
    await delay(250);
  }
  throw new Error("The isolated Sliver server did not open its loopback operator listener within the deadline");
}

async function waitForExactSession(client: SliverClient, name: string, process: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error("The test-owned implant exited before check-in");
    const matches = (await client.getSessions()).Sessions.filter((session) => session.Name === name);
    if (matches.length > 1) throw new Error(`More than one session matched the exact generated name ${name}`);
    if (matches.length === 1) return matches[0]!.ID;
    await delay(500);
  }
  throw new Error("The test-owned Darwin/arm64 session did not check in within the deadline");
}

async function launchProductionApplication(repositoryRoot: string, home: string, clientRoot: string, userData: string): Promise<ElectronApplication> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name, value]) =>
    typeof value === "string" && !name.startsWith("SLIVER_GUI_") && !name.startsWith("SLIVER_CLIENT_") && name !== "SLIVER_ROOT_DIR"));
  return electron.launch({
    args: ["--enable-sandbox", repositoryRoot, `--user-data-dir=${userData}`],
    bypassCSP: false,
    chromiumSandbox: true,
    cwd: repositoryRoot,
    env: {
      ...inherited,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      SLIVER_CLIENT_ROOT_DIR: clientRoot,
    },
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function connectSavedOperator(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.waitFor();
  const option = dialog.getByRole("option", { name: /bof-live-operator/u });
  await option.waitFor();
  if ((await option.getAttribute("aria-selected")) !== "true") await option.click();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  const mismatch = page.getByRole("dialog", { name: "Server version mismatch" });
  if (await mismatch.count()) {
    await mismatch.getByRole("button", { name: "Continue" }).click();
    await mismatch.waitFor({ state: "hidden" });
  }
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  if (await mismatch.count()) {
    await mismatch.getByRole("button", { name: "Continue" }).click();
    await mismatch.waitFor({ state: "hidden" });
  }
}

async function waitForRendererSession(page: Page, id: string, name: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const refreshed = await invokeSliver(page, "refresh");
    if (refreshed.ok && refreshed.value?.sessions.some((session) => session.id === id && session.name === name)) return;
    await delay(500);
  }
  throw new Error(`The GUI did not render exact test-owned session ${id}`);
}

async function waitForTranscript(workspace: Locator, expected: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const transcript = workspace.getByLabel("Execution output transcript");
  while (Date.now() < deadline) {
    const content = await transcript.textContent().catch(() => null);
    if (content?.includes(expected)) {
      await workspace.locator('[aria-label="Execution output terminal"] canvas').waitFor();
      return content;
    }
    await delay(250);
  }
  throw new Error(`BOF output did not contain ${JSON.stringify(expected)}. Workspace: ${(await workspace.innerText()).slice(0, 2_000)}`);
}

type SliverMethod = keyof SliverDesktopAPI;
type SliverMethodArgs<Method extends SliverMethod> = SliverDesktopAPI[Method] extends (...args: infer Args) => unknown ? Args : never;
type SliverMethodResult<Method extends SliverMethod> = SliverDesktopAPI[Method] extends (...args: never[]) => infer Result ? Awaited<Result> : never;

async function invokeSliver<Method extends SliverMethod>(page: Page, method: Method, ...args: SliverMethodArgs<Method>): Promise<SliverMethodResult<Method>> {
  return page.evaluate(async ({ method: rendererMethod, args: rendererArgs }) => {
    const api = (globalThis as unknown as { sliver: Record<string, (...values: unknown[]) => Promise<unknown>> }).sliver;
    return api[rendererMethod]!(...rendererArgs);
  }, { method, args }) as Promise<SliverMethodResult<Method>>;
}

async function stopOwnedProcess(child: ChildProcess, label: string): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;
  child.kill("SIGKILL");
  if (await waitForExit(child, 5_000)) return;
  throw new Error(`The exact test-owned ${label} PID ${child.pid} did not exit`);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => { child.off("exit", exited); resolveExit(false); }, timeoutMs);
    const exited = () => { clearTimeout(timer); resolveExit(true); };
    child.once("exit", exited);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
