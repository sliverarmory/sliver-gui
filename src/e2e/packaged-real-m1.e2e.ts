import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
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
import { basename, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import {
  SliverClient,
  clientpb,
  parseConfig,
  type SliverClientConfig,
} from "sliver-script";

import { artifactFormatFromProto, buildImplantConfig } from "../main/implant-config.js";
import type { SliverDesktopAPI, SliverSnapshot } from "../shared/contracts.js";
import { cloneGenerateInput, defaultGenerateInput } from "../shared/generate-defaults.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import { decodeReconfigureTaskRequest } from "./beacon-task-wire.js";

const ENABLED = process.env["SLIVER_GUI_M1_REAL_E2E"] === "1";
const CONFIG_PATH = process.env["SLIVER_GUI_E2E_CONFIG"]?.trim();
const LISTENER_PORT_TEXT = process.env["SLIVER_GUI_E2E_LISTENER_PORT"]?.trim();
const OPTED_IN = ENABLED && Boolean(CONFIG_PATH) && Boolean(LISTENER_PORT_TEXT);
const MAX_OPERATOR_CONFIG_BYTES = 4 * 1024 * 1024;
const TARGET_WAIT_MS = 90_000;
const OPERATION_WAIT_MS = 90_000;

/**
 * Destructive opt-in only. This test creates two generated implants and runs
 * them locally against a loopback HTTPS listener. Every cleanup operation is
 * bound to a captured test-owned ID or name; there is intentionally no global
 * server clean, wildcard process kill, or broad profile/build removal.
 */
test(
  "packaged M1 app drives real session and beacon operations with exact cleanup",
  {
    skip: OPTED_IN
      ? false
      : "Set SLIVER_GUI_M1_REAL_E2E=1, SLIVER_GUI_E2E_CONFIG, and SLIVER_GUI_E2E_LISTENER_PORT to opt in",
    timeout: 30 * 60_000,
  },
  async () => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const sourceConfigPath = requiredConfigPath();
    const listenerPort = requiredListenerPort();
    const executablePath = await findPackagedExecutable(repositoryRoot);
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-packaged-real-m1-"));
    const isolatedHome = join(temporaryRoot, "home");
    const savedConfigDirectory = join(isolatedHome, ".sliver-client", "configs");
    const userDataDirectory = join(temporaryRoot, "user-data");
    const copiedConfigPath = join(savedConfigDirectory, "m1-real-operator.cfg");
    const runtimeDirectory = join(temporaryRoot, "implants");
    const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
    const suffix = `${Date.now().toString(36)}-${process.pid.toString(36)}`.slice(-14);
    const sessionProfileName = `m1sp-${suffix}`;
    const beaconProfileName = `m1bp-${suffix}`;
    const sessionBuildName = `m1ss-${suffix}`;
    const beaconBuildName = `m1bb-${suffix}`;

    const configBytes = await readBoundedConfig(sourceConfigPath);
    let config: SliverClientConfig;
    try {
      config = parseConfig(configBytes);
      if (config.wg !== undefined) {
        throw new Error("The M1 real harness currently accepts mTLS operator configurations only");
      }
      if (!new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(config.lhost.toLowerCase())) {
        throw new Error("The M1 real harness requires a loopback Sliver server because its test listener is loopback-only");
      }
      await Promise.all([
        mkdir(savedConfigDirectory, { recursive: true }),
        mkdir(userDataDirectory, { recursive: true }),
        mkdir(runtimeDirectory, { recursive: true }),
        mkdir(artifactDirectory, { recursive: true }),
      ]);
      await writeFile(copiedConfigPath, configBytes, { mode: 0o600 });
    } finally {
      configBytes.fill(0);
    }
    if (process.platform !== "win32") {
      assert.equal((await stat(copiedConfigPath)).mode & 0o777, 0o600);
      await access(executablePath, constants.X_OK);
    }

    const cleanup: OwnedResources = {
      jobId: undefined,
      listenerPort,
      listenerStartAttempted: false,
      sessionId: undefined,
      beaconId: undefined,
      openedSessionIds: new Set(),
      openedSessionIdentity: undefined,
      sessionName: sessionBuildName,
      beaconName: beaconBuildName,
      baselineSessionIds: new Set(),
      baselineBeaconIds: new Set(),
      profileNames: new Set(),
      buildNames: new Set(),
      processes: [],
    };
    const client = new SliverClient(config);
    let electronApplication: ElectronApplication | undefined;
    let primaryFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      await client.connect();
      const baseline = await captureBaseline(client);
      cleanup.baselineSessionIds = new Set(baseline.sessionIds);
      cleanup.baselineBeaconIds = new Set(baseline.beaconIds);
      assert.ok(
        !baseline.jobsByPort.has(listenerPort),
        `listener port ${listenerPort} is already represented by a server job`,
      );
      assert.ok(!baseline.profileNames.has(sessionProfileName));
      assert.ok(!baseline.profileNames.has(beaconProfileName));
      assert.ok(!baseline.buildNames.has(sessionBuildName));
      assert.ok(!baseline.buildNames.has(beaconBuildName));

      const [certificate, key] = await Promise.all([
        readFile(join(repositoryRoot, "src/e2e/fixtures/server.crt.fixture")),
        readFile(join(repositoryRoot, "src/e2e/fixtures/server-key.fixture")),
      ]);
      try {
        cleanup.listenerStartAttempted = true;
        const listener = await client.startHTTPSListenerWithOptions(
          {
            host: "127.0.0.1",
            port: listenerPort,
            cert: certificate,
            key,
            randomizeJARM: true,
            enforceOTP: false,
          },
          30,
        );
        cleanup.jobId = listener.JobID;
      } finally {
        certificate.fill(0);
        key.fill(0);
      }

      const compiler = await client.getCompiler(30);
      const target = selectNativeExecutableTarget(compiler);
      const c2 = `https://127.0.0.1:${listenerPort}`;
      const sessionInput = cloneGenerateInput(defaultGenerateInput);
      Object.assign(sessionInput, {
        name: sessionBuildName,
        implantType: "session" as const,
        os: target.GOOS,
        arch: target.GOARCH,
        format: artifactFormatFromProto(target.Format),
        c2,
        reconnectSeconds: 2,
        pollTimeoutSeconds: 60,
        obfuscateSymbols: false,
      });
      const beaconInput = cloneGenerateInput(sessionInput);
      Object.assign(beaconInput, {
        name: beaconBuildName,
        implantType: "beacon" as const,
        beaconIntervalSeconds: 8,
        beaconJitterSeconds: 0,
      });
      const sessionConfig = buildImplantConfig(sessionInput);
      const beaconConfig = buildImplantConfig(beaconInput);

      cleanup.profileNames.add(sessionProfileName);
      await client.saveImplantProfile(clientpb.ImplantProfile.create({
        ID: "",
        Name: sessionProfileName,
        Config: sessionConfig,
      }), 30);
      cleanup.profileNames.add(beaconProfileName);
      await client.saveImplantProfile(clientpb.ImplantProfile.create({
        ID: "",
        Name: beaconProfileName,
        Config: beaconConfig,
      }), 30);
      cleanup.buildNames.add(sessionBuildName);
      const sessionBuild = await client.generateImplant(sessionConfig, sessionBuildName, 15 * 60);
      cleanup.buildNames.add(sessionBuild.ImplantName || sessionBuildName);
      cleanup.sessionName = sessionBuild.ImplantName || sessionBuildName;
      cleanup.buildNames.add(beaconBuildName);
      const beaconBuild = await client.generateImplant(beaconConfig, beaconBuildName, 15 * 60);
      cleanup.buildNames.add(beaconBuild.ImplantName || beaconBuildName);
      cleanup.beaconName = beaconBuild.ImplantName || beaconBuildName;
      const sessionPath = await writeExecutable(runtimeDirectory, "m1-session", requireGeneratedData(sessionBuild));
      const beaconPath = await writeExecutable(runtimeDirectory, "m1-beacon", requireGeneratedData(beaconBuild));

      electronApplication = await launchPackagedApplication({
        executablePath,
        isolatedHome,
        repositoryRoot,
        userDataDirectory,
      });
      const page = await electronApplication.firstWindow();
      const consoleMessages: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (message) => consoleMessages.push(message.text()));
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await connectSavedConfig(page);

      // Start after the GUI is subscribed so arrival is proven through the
      // production event/reconciliation path, not only by initial inventory.
      cleanup.processes.push(spawnOwnedImplant(sessionPath), spawnOwnedImplant(beaconPath));
      const arrivals = await waitForOwnedTargets(
        page,
        baseline.sessionIds,
        baseline.beaconIds,
        sessionBuild.ImplantName || sessionBuildName,
        beaconBuild.ImplantName || beaconBuildName,
        (mode, id) => {
          if (mode === "session") cleanup.sessionId = id;
          else cleanup.beaconId = id;
        },
      );
      cleanup.sessionId = arrivals.sessionId;
      cleanup.beaconId = arrivals.beaconId;

      await page.locator('[aria-label="Sessions"]:visible').click();
      await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
      const sessionsGrid = page.locator('[aria-label="Sliver sessions"]');
      await sessionsGrid.getByText(cleanup.sessionName, { exact: true }).waitFor();
      assert.equal(await sessionsGrid.getByText(cleanup.beaconName, { exact: true }).count(), 0);
      await verifySessionOperations(page, arrivals.sessionRef, suffix);

      await page.locator('[aria-label="Beacons"]:visible').click();
      await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
      const beaconsGrid = page.locator('[aria-label="Sliver beacons"]');
      await beaconsGrid.getByText(cleanup.beaconName, { exact: true }).waitFor();
      assert.equal(await beaconsGrid.getByText(cleanup.sessionName, { exact: true }).count(), 0);
      await verifyBeaconOperations(page, client, arrivals.beaconId, suffix, (identity, sessionId) => {
        cleanup.openedSessionIdentity = identity;
        if (sessionId) cleanup.openedSessionIds.add(sessionId);
      });

      const snapshotText = JSON.stringify(await rendererSnapshot(page));
      const bodyText = await page.locator("body").innerText();
      const screenshot = await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, `packaged-real-m1-${process.platform}-${process.arch}.png`),
      });
      for (const forbidden of [
        config.token,
        config.private_key,
        sourceConfigPath,
        copiedConfigPath,
      ]) {
        if (!forbidden) continue;
        const visible = [snapshotText, bodyText, ...consoleMessages, ...pageErrors].join("\n");
        assert.ok(!visible.includes(forbidden), `renderer exposed ${sensitiveLabel(forbidden, config)}`);
        assert.equal(screenshot.includes(Buffer.from(forbidden)), false);
      }
      assert.deepEqual(pageErrors, []);
    } catch (error) {
      primaryFailure = error;
    } finally {
      if (electronApplication) {
        try {
          await electronApplication.close();
        } catch (error) {
          cleanupFailures.push(new Error("Packaged M1 application teardown failed", { cause: error }));
        }
      }
      try {
        await cleanupOwnedResources(client, cleanup);
      } catch (error) {
        cleanupFailures.push(error);
      }
      try {
        await client.disconnect();
      } catch (error) {
        cleanupFailures.push(new Error("M1 cleanup client did not disconnect", { cause: error }));
      }
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(new Error("M1 isolated temporary directory cleanup failed", { cause: error }));
      }
    }

    if (primaryFailure !== undefined) {
      if (cleanupFailures.length > 0) {
        throw new AggregateError([primaryFailure, ...cleanupFailures], "M1 real E2E failed and exact cleanup was incomplete");
      }
      throw primaryFailure;
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(cleanupFailures, "M1 real E2E exact cleanup was incomplete");
    }
  },
);

interface OwnedResources {
  jobId: number | undefined;
  listenerPort: number;
  listenerStartAttempted: boolean;
  sessionId: string | undefined;
  beaconId: string | undefined;
  openedSessionIds: Set<string>;
  openedSessionIdentity: OpenedSessionIdentity | undefined;
  sessionName: string;
  beaconName: string;
  baselineSessionIds: Set<string>;
  baselineBeaconIds: Set<string>;
  profileNames: Set<string>;
  buildNames: Set<string>;
  processes: ChildProcess[];
}

interface OpenedSessionIdentity {
  name: string;
  hostId: string;
  pid: number | undefined;
}

interface Baseline {
  jobsByPort: Map<number, number>;
  sessionIds: Set<string>;
  beaconIds: Set<string>;
  profileNames: Set<string>;
  buildNames: Set<string>;
}

async function captureBaseline(client: SliverClient): Promise<Baseline> {
  const [jobs, sessions, beacons, profiles, builds] = await Promise.all([
    client.jobs(),
    client.getSessions(),
    client.getBeacons(),
    client.implantProfiles(),
    client.implantBuilds(),
  ]);
  return {
    jobsByPort: new Map(jobs.map((job) => [job.Port, job.ID])),
    sessionIds: new Set(sessions.Sessions.map((session) => session.ID)),
    beaconIds: new Set(beacons.Beacons.map((beacon) => beacon.ID)),
    profileNames: new Set(profiles.Profiles.map((profile) => profile.Name)),
    buildNames: new Set(Object.keys(builds.Configs)),
  };
}

function selectNativeExecutableTarget(compiler: clientpb.Compiler): clientpb.CompilerTarget {
  const goos = process.platform === "win32" ? "windows" : process.platform;
  const goarch = process.arch === "x64" ? "amd64" : process.arch;
  const target = compiler.Targets.find((candidate) =>
    candidate.GOOS === goos &&
    candidate.GOARCH === goarch &&
    candidate.Format === clientpb.OutputFormat.EXECUTABLE,
  );
  if (!target) throw new Error(`The server cannot build a native executable for ${goos}/${goarch}`);
  return target;
}

function requireGeneratedData(build: clientpb.Generate): Buffer {
  if (!build.File || build.File.Data.length < 1_000) {
    throw new Error(`Sliver did not return executable bytes for ${build.ImplantName || "the requested build"}`);
  }
  return build.File.Data;
}

async function writeExecutable(directory: string, name: string, source: Buffer): Promise<string> {
  const path = join(directory, process.platform === "win32" ? `${name}.exe` : name);
  try {
    await writeFile(path, source, { mode: 0o700 });
  } finally {
    source.fill(0);
  }
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o700);
  return path;
}

function spawnOwnedImplant(path: string): ChildProcess {
  const child = spawn(path, [], { stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  return child;
}

async function connectSavedConfig(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: /saved configurations/i });
  await dialog.waitFor();
  const option = dialog.getByRole("option", { name: /m1-real-operator/i });
  await option.waitFor();
  if ((await option.getAttribute("aria-selected")) !== "true") await option.click();
  await dialog.getByRole("button", { name: /^connect$/i }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor({ timeout: 30_000 });
  const mismatch = page.getByRole("dialog", { name: "Server build mismatch" });
  if (await mismatch.count()) {
    await mismatch.getByRole("button", { name: "Continue" }).click();
    await mismatch.waitFor({ state: "hidden" });
  }
}

async function waitForOwnedTargets(
  page: Page,
  baselineSessions: ReadonlySet<string>,
  baselineBeacons: ReadonlySet<string>,
  sessionName: string,
  beaconName: string,
  onObserved: (mode: "session" | "beacon", id: string) => void,
): Promise<{ sessionId: string; beaconId: string; sessionRef: TargetRef; beaconRef: TargetRef }> {
  const deadline = Date.now() + TARGET_WAIT_MS;
  while (Date.now() < deadline) {
    const refreshed = await invokeSliver(page, "refresh");
    if (!refreshed.ok || !refreshed.value) {
      await page.waitForTimeout(250);
      continue;
    }
    const snapshot = refreshed.value;
    const session = snapshot.sessions.find((candidate) =>
      !baselineSessions.has(candidate.id) && candidate.name === sessionName,
    );
    const beacon = snapshot.beacons.find((candidate) =>
      !baselineBeacons.has(candidate.id) && candidate.name === beaconName,
    );
    const sessionRef = session
      ? snapshot.targetContext.selectableTargets.find((candidate) => candidate.mode === "session" && candidate.id === session.id)
      : undefined;
    const beaconRef = beacon
      ? snapshot.targetContext.selectableTargets.find((candidate) => candidate.mode === "beacon" && candidate.id === beacon.id)
      : undefined;
    if (session) onObserved("session", session.id);
    if (beacon) onObserved("beacon", beacon.id);
    if (session && beacon && sessionRef && beaconRef) {
      return { sessionId: session.id, beaconId: beacon.id, sessionRef, beaconRef };
    }
    await page.waitForTimeout(250);
  }
  throw new Error("The test-owned session and beacon did not arrive within 90 seconds");
}

async function verifySessionOperations(page: Page, target: TargetRef, suffix: string): Promise<void> {
  const selected = await invokeSliver(page, "selectTarget", target);
  assert.equal(selected.ok, true, selected.error ?? "session selection failed");
  const ping = requireOperation(await invokeSliver(page, "submitTargetOperation", { operationId: "target.ping" }));
  assert.equal(ping.state, "completed");
  assert.equal(ping.mode, "session");
  assert.equal(ping.disposition?.kind, "structured-detail");
  const mutation = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: `SLIVER_GUI_M1_${suffix.replaceAll("-", "_").toUpperCase()}`,
    value: "real-session-mutation",
  }));
  assert.equal(mutation.state, "completed");
}

async function verifyBeaconOperations(
  page: Page,
  client: SliverClient,
  beaconId: string,
  suffix: string,
  onOpenedSessionObserved: (identity: OpenedSessionIdentity, sessionId?: string) => void,
): Promise<void> {
  const initialSnapshot = await rendererSnapshot(page);
  const target = initialSnapshot.targetContext.selectableTargets.find((candidate) =>
    candidate.mode === "beacon" && candidate.id === beaconId,
  );
  assert.ok(target, "the real beacon must remain selectable after session operations refresh inventory");
  const beacon = initialSnapshot.beacons.find((candidate) => candidate.id === beaconId);
  assert.ok(beacon, "the real beacon must remain present in authoritative inventory");
  const openedSessionIdentity: OpenedSessionIdentity = {
    name: beacon.name,
    hostId: beacon.hostId,
    pid: beacon.pid,
  };
  onOpenedSessionObserved(openedSessionIdentity);
  const selected = await invokeSliver(page, "selectTarget", target);
  assert.equal(selected.ok, true, selected.error ?? "beacon selection failed");
  const ping = requireOperation(await invokeSliver(page, "submitTargetOperation", { operationId: "target.ping" }));
  assert.ok(ping.taskId, "real beacon ping must return a task ID");
  const completedPing = await waitForOperation(page, ping.requestId, ["completed"], OPERATION_WAIT_MS);
  assert.equal(completedPing.disposition?.kind, "structured-detail");

  const mutation = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: `SLIVER_GUI_M1_B_${suffix.replaceAll("-", "_").toUpperCase()}`,
    value: "real-beacon-mutation",
  }));
  assert.ok(mutation.taskId);
  await waitForOperation(page, mutation.requestId, ["completed"], OPERATION_WAIT_MS);

  const reconfigure = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "beacon.reconfigure",
    reconnectIntervalSeconds: 3,
  }));
  assert.ok(reconfigure.taskId, "real beacon reconfigure must return a task ID");
  const completedReconfigure = await waitForOperation(
    page,
    reconfigure.requestId,
    ["completed"],
    OPERATION_WAIT_MS,
  );
  assert.equal(completedReconfigure.disposition?.kind, "structured-detail");
  if (completedReconfigure.disposition?.kind === "structured-detail") {
    assert.equal(completedReconfigure.disposition.title, "Beacon reconfigured");
    assert.deepEqual(completedReconfigure.disposition.fields, [
      { label: "Result", value: "Configuration delivered" },
    ]);
  }
  const exactReconfigureTask = await client.fetchBeaconTask(reconfigure.taskId, 30);
  let decodedTaskRequest: ReturnType<typeof decodeReconfigureTaskRequest> | undefined;
  try {
    assert.equal(exactReconfigureTask.ID, reconfigure.taskId);
    assert.equal(exactReconfigureTask.BeaconID, beaconId);
    assert.equal(exactReconfigureTask.State.toLowerCase(), "completed");
    decodedTaskRequest = decodeReconfigureTaskRequest(exactReconfigureTask.Request);
    const decodedRequest = decodedTaskRequest.reconfigure;
    assert.equal(decodedRequest.ReconnectInterval, "3000000000");
    assert.equal(decodedRequest.BeaconInterval, "0");
    assert.equal(decodedRequest.BeaconJitter, "0");
    assert.equal(decodedRequest.C2URI, "");
  } finally {
    decodedTaskRequest?.envelope.Data.fill(0);
    exactReconfigureTask.Request.fill(0);
    exactReconfigureTask.Response.fill(0);
  }

  const sessionIdsBeforeOpen = new Set((await rendererSnapshot(page)).sessions.map((session) => session.id));
  const openSession = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "beacon.open-session",
    delaySeconds: 0,
  }));
  assert.ok(openSession.taskId, "real beacon open-session must return a task ID");
  const completedOpenSession = await waitForOperation(
    page,
    openSession.requestId,
    ["completed"],
    OPERATION_WAIT_MS,
  );
  assert.equal(completedOpenSession.disposition?.kind, "inline-text");
  if (completedOpenSession.disposition?.kind === "inline-text") {
    assert.match(completedOpenSession.disposition.text, /acknowledged and scheduled/iu);
  }
  const openedSessionId = await waitForOpenedSession(
    page,
    sessionIdsBeforeOpen,
    openedSessionIdentity,
    (sessionId) => onOpenedSessionObserved(openedSessionIdentity, sessionId),
  );
  onOpenedSessionObserved(openedSessionIdentity, openedSessionId);
  const normalizedOpenedSession = (await rendererSnapshot(page)).sessions.find(
    (session) => session.id === openedSessionId,
  );
  assert.ok(normalizedOpenedSession, "the opened session must remain in normalized GUI inventory");
  assert.equal(normalizedOpenedSession.reconnectIntervalMs, 3_000);
  const authoritativeOpenedSession = (await client.getSessions()).Sessions.find(
    (session) => session.ID === openedSessionId,
  );
  assert.ok(authoritativeOpenedSession, "the GUI-observed opened session must exist in server inventory");
  assert.equal(authoritativeOpenedSession.Name, openedSessionIdentity.name);
  assert.equal(authoritativeOpenedSession.UUID, openedSessionIdentity.hostId);
  assert.equal(authoritativeOpenedSession.PID, openedSessionIdentity.pid);
  assert.equal(authoritativeOpenedSession.ReconnectInterval, "3000000000");

  const tasks = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
  assert.equal(tasks.ok, true, tasks.error ?? "beacon task listing failed");
  assert.ok(tasks.value?.items.some((task) =>
    task.taskId === ping.taskId &&
    task.localRequestId === ping.requestId &&
    task.ownership.origin === "local"),
  );
  assert.ok(tasks.value?.items.some((task) =>
    task.taskId === reconfigure.taskId &&
    task.localRequestId === reconfigure.requestId &&
    task.state === "completed" &&
    task.ownership.origin === "local"),
  );
  assert.ok(tasks.value?.items.some((task) =>
    task.taskId === openSession.taskId &&
    task.localRequestId === openSession.requestId &&
    task.state === "completed" &&
    task.ownership.origin === "local"),
  );

  let cancelFailure = "the task was dispatched before cancellation";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForCancellationWindow(client, beaconId);
    const candidate = requireOperation(await invokeSliver(page, "submitTargetOperation", { operationId: "target.ping" }));
    if (!candidate.taskId) continue;
    const cancellation = await invokeSliver(page, "cancelTargetOperation", { requestId: candidate.requestId });
    const terminal = cancellation.ok && cancellation.value &&
      ["completed", "canceled", "failed", "outcome-unknown"].includes(cancellation.value.state)
      ? cancellation.value
      : await waitForOperation(
          page,
          candidate.requestId,
          ["completed", "canceled", "failed", "outcome-unknown"],
          OPERATION_WAIT_MS,
        );
    if (terminal?.state === "canceled") {
      const refreshed = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
      assert.equal(refreshed.ok, true, refreshed.error ?? "canceled task refresh failed");
      assert.equal(
        refreshed.value?.items.find((task) => task.taskId === candidate.taskId)?.state,
        "canceled",
        "the authoritative task inventory must confirm cancellation",
      );
      return;
    }
    cancelFailure = cancellation.error ?? `cancellation ended in ${terminal?.state ?? cancellation.value?.state ?? "unknown"}`;
  }
  throw new Error(`Could not catch a real pending beacon task in three attempts: ${cancelFailure}`);
}

async function waitForOpenedSession(
  page: Page,
  sessionIdsBeforeOpen: ReadonlySet<string>,
  identity: OpenedSessionIdentity,
  onObserved: (sessionId: string) => void,
): Promise<string> {
  const deadline = Date.now() + TARGET_WAIT_MS;
  while (Date.now() < deadline) {
    const refreshed = await invokeSliver(page, "refresh");
    if (!refreshed.ok || !refreshed.value) {
      await page.waitForTimeout(250);
      continue;
    }
    const matches = refreshed.value.sessions.filter((session) =>
      !sessionIdsBeforeOpen.has(session.id) &&
      session.name === identity.name &&
      session.hostId === identity.hostId &&
      session.pid === identity.pid,
    );
    for (const match of matches) onObserved(match.id);
    if (matches.length === 1) return matches[0]!.id;
    if (matches.length > 1) {
      throw new Error(
        `Open-session produced ${matches.length} exact beacon-identity sessions; cleanup captured every ID but verification expected one`,
      );
    }
    await page.waitForTimeout(250);
  }
  throw new Error("The acknowledged open-session task did not appear in authoritative session inventory");
}

async function waitForCancellationWindow(client: SliverClient, beaconId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const beacon = (await client.getBeacons()).Beacons.find((candidate) => candidate.ID === beaconId);
    if (!beacon) throw new Error("The test-owned beacon disappeared before cancellation");
    const nextCheckinMs = Number(beacon.NextCheckin) * 1_000;
    if (Number.isFinite(nextCheckinMs) && nextCheckinMs - Date.now() > 6_000) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("The real beacon did not expose a safe pending-task cancellation window");
}

async function cleanupOwnedResources(client: SliverClient, owned: OwnedResources): Promise<void> {
  const failures: unknown[] = [];
  try {
    await captureOpenedSessionIds(client, owned);
  } catch (error) {
    failures.push(new Error("Could not refresh exact opened-session IDs for cleanup", { cause: error }));
  }
  if (!owned.sessionId) {
    try {
      const candidates = (await client.getSessions()).Sessions.filter((session) =>
        !owned.baselineSessionIds.has(session.ID) && session.Name === owned.sessionName,
      );
      if (candidates.length > 1) throw new Error("more than one exact-name candidate was found");
      owned.sessionId = candidates[0]?.ID;
    } catch (error) {
      failures.push(new Error(`Could not resolve the exact session named ${owned.sessionName}`, { cause: error }));
    }
  }
  if (!owned.beaconId) {
    try {
      const candidates = (await client.getBeacons()).Beacons.filter((beacon) =>
        !owned.baselineBeaconIds.has(beacon.ID) && beacon.Name === owned.beaconName,
      );
      if (candidates.length > 1) throw new Error("more than one exact-name candidate was found");
      owned.beaconId = candidates[0]?.ID;
    } catch (error) {
      failures.push(new Error(`Could not resolve the exact beacon named ${owned.beaconName}`, { cause: error }));
    }
  }
  // Ask live implants to terminate first, then stop only the exact child PIDs
  // before removing their captured server records. This prevents a beacon
  // from registering again after its row was removed.
  if (owned.sessionId) {
    try {
      if ((await client.getSessions()).Sessions.some((session) => session.ID === owned.sessionId)) {
        await client.killSession(owned.sessionId, false, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not request termination of exact session ${owned.sessionId}`, { cause: error }));
    }
  }
  if (owned.beaconId) {
    try {
      if ((await client.getBeacons()).Beacons.some((beacon) => beacon.ID === owned.beaconId)) {
        await client.killBeacon(owned.beaconId, false, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not request termination of exact beacon ${owned.beaconId}`, { cause: error }));
    }
  }
  for (const child of owned.processes) {
    try {
      await terminateOwnedProcess(child);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await captureOpenedSessionIds(client, owned);
  } catch (error) {
    failures.push(new Error("Could not finalize exact opened-session IDs for cleanup", { cause: error }));
  }
  if (owned.sessionId) {
    try {
      if ((await client.getSessions()).Sessions.some((session) => session.ID === owned.sessionId)) {
        await client.closeSession(owned.sessionId, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not close exact session record ${owned.sessionId}`, { cause: error }));
    }
  }
  for (const sessionId of owned.openedSessionIds) {
    try {
      if ((await client.getSessions()).Sessions.some((session) => session.ID === sessionId)) {
        await client.closeSession(sessionId, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not close exact opened session record ${sessionId}`, { cause: error }));
    }
  }
  if (owned.beaconId) {
    try {
      if ((await client.getBeacons()).Beacons.some((beacon) => beacon.ID === owned.beaconId)) {
        await client.rmBeacon(owned.beaconId, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not remove exact beacon record ${owned.beaconId}`, { cause: error }));
    }
  }
  if (owned.jobId === undefined && owned.listenerStartAttempted) {
    failures.push(new Error(
      `The listener request on port ${owned.listenerPort} returned no job ID; cleanup refused to infer one from shared server state`,
    ));
  }
  if (owned.jobId !== undefined) {
    try {
      const job = (await client.jobs()).find((candidate) => candidate.ID === owned.jobId);
      if (job) {
        const stopped = await client.killJob(owned.jobId, 30);
        if (!stopped.Success) throw new Error("server refused the exact listener stop");
      }
    } catch (error) {
      failures.push(new Error(`Could not stop exact listener job ${owned.jobId}`, { cause: error }));
    }
  }
  for (const name of owned.profileNames) {
    try {
      if ((await client.implantProfiles()).Profiles.some((profile) => profile.Name === name)) {
        await client.deleteImplantProfile(name, 30);
      }
    } catch (error) {
      failures.push(new Error(`Could not delete exact profile ${name}`, { cause: error }));
    }
  }
  for (const name of owned.buildNames) {
    try {
      if ((await client.implantBuilds()).Configs[name]) await client.deleteImplantBuild(name, 30);
    } catch (error) {
      failures.push(new Error(`Could not delete exact build ${name}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Exact M1 real-server cleanup failed");
}

async function captureOpenedSessionIds(client: SliverClient, owned: OwnedResources): Promise<void> {
  const identity = owned.openedSessionIdentity;
  if (!identity) return;
  for (const session of (await client.getSessions()).Sessions) {
    if (
      !owned.baselineSessionIds.has(session.ID) &&
      session.Name === identity.name &&
      session.UUID === identity.hostId &&
      session.PID === identity.pid
    ) {
      owned.openedSessionIds.add(session.ID);
    }
  }
}

async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  if (await promiseWithin(exited, 5_000)) return;
  child.kill("SIGKILL");
  if (!(await promiseWithin(exited, 5_000))) {
    throw new Error(`Exact implant process ${child.pid ?? "unknown"} did not exit`);
  }
}

async function promiseWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForOperation(
  page: Page,
  requestId: string,
  accepted: readonly TargetOperationRecord["state"][],
  timeoutMs: number,
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  let latest: TargetOperationRecord | undefined;
  while (Date.now() < deadline) {
    const result = await invokeSliver(page, "getTargetOperation", { requestId });
    if (result.ok && result.value) {
      latest = result.value;
      if (accepted.includes(latest.state)) return latest;
      if (["failed", "canceled", "partial", "outcome-unknown", "target-disappeared"].includes(latest.state)) break;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`Operation ${requestId} did not reach ${accepted.join(" or ")}; latest=${latest?.state ?? "missing"}`);
}

function requireOperation(result: Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>): TargetOperationRecord {
  assert.equal(result.ok, true, result.error ?? "operation submission failed");
  assert.ok(result.value);
  return result.value;
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
    const api = (globalThis as unknown as { sliver: Record<string, (...values: unknown[]) => Promise<unknown>> }).sliver;
    return api[rendererMethod]!(...rendererArgs);
  }, { method, args }) as Promise<SliverMethodResult<Method>>;
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return invokeSliver(page, "getSnapshot");
}

async function launchPackagedApplication(input: {
  executablePath: string;
  isolatedHome: string;
  repositoryRoot: string;
  userDataDirectory: string;
}): Promise<ElectronApplication> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      typeof entry[1] === "string" && !entry[0].startsWith("SLIVER_GUI_")),
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

function requiredListenerPort(): number {
  if (!LISTENER_PORT_TEXT || !/^\d+$/u.test(LISTENER_PORT_TEXT)) {
    throw new Error("SLIVER_GUI_E2E_LISTENER_PORT must be an unused numeric port");
  }
  const port = Number(LISTENER_PORT_TEXT);
  // Current Sliver server validation rejects 65535, so this harness refuses it
  // up front instead of creating unrelated state before a known failure.
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_534) {
    throw new Error("SLIVER_GUI_E2E_LISTENER_PORT must be between 1 and 65534");
  }
  return port;
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
  if (matches.length === 0) throw new Error(`No packaged application found under ${releaseDirectory}`);
  const dated = await Promise.all(matches.map(async (path) => ({ path, time: (await stat(path)).mtimeMs })));
  dated.sort((left, right) => right.time - left.time || left.path.localeCompare(right.path));
  await access(dated[0]!.path, constants.X_OK);
  return realpath(dated[0]!.path);
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

function sensitiveLabel(value: string, config: SliverClientConfig): string {
  if (value === config.token) return "operator token";
  if (value === config.private_key) return "operator private key";
  return basename(value);
}
