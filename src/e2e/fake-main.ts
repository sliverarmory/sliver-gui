import { app } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { clientpb, sliverpb, type SliverClientConfig } from "sliver-script";

import { startApplication } from "../main/application.js";
import {
  ConnectionRegistry,
  type SliverClientAdapter,
} from "../main/connection-registry.js";
import { SLIVER_PROTOCOL_BASELINE_COMMIT } from "../shared/contracts.js";

interface FakeMainState {
  configFactoryCalls: number;
  dialogCalls: number;
  methods: string[];
  disconnects: number;
  connectedConfig?: {
    operator: string;
    host: string;
    port: number;
  };
  holdNextBeaconTask: boolean;
  sessionName: string;
  beaconName: string;
  environment: Record<string, string>;
  openSessionRequests: Array<{
    beaconId: string;
    c2s: string[];
    delayNanoseconds: string;
  }>;
  tasks: Array<{
    id: string;
    beaconId: string;
    state: string;
    description: string;
  }>;
}

interface FakeMainControl {
  setEventStreamStatus(status: "connected" | "retrying"): void;
  completeTask(taskId: string, emitEvent?: boolean): void;
}

declare global {
  // This global exists only in the separately compiled fake Electron main.
  // It is inspected externally by Playwright and is never part of dist/.
  var __SLIVER_GUI_E2E_STATE__: FakeMainState;
  var __SLIVER_GUI_E2E_CONTROL__: FakeMainControl;
}

const repositoryRoot = requiredArgument("--repository-root=");
const state: FakeMainState = {
  configFactoryCalls: 0,
  dialogCalls: 0,
  methods: [],
  disconnects: 0,
  holdNextBeaconTask: false,
  sessionName: "m1-session",
  beaconName: "m1-beacon",
  environment: {},
  openSessionRequests: [],
  tasks: [],
};
globalThis.__SLIVER_GUI_E2E_STATE__ = state;

const registry = new ConnectionRegistry({
  savedConfigDirectory: requiredArgument("--saved-config-directory="),
  managedConfigDirectory: requiredArgument("--managed-config-directory="),
  clientFactory: (config) => {
    state.configFactoryCalls += 1;
    state.connectedConfig = {
      operator: config.operator,
      host: config.lhost,
      port: config.lport,
    };
    return createFakeClient(config, state);
  },
});

app.setPath("userData", requiredArgument("--user-data-directory="));
void startApplication({
  registry,
  rendererEntryPath: `${repositoryRoot}/dist/renderer/index.html`,
  preloadPath: `${repositoryRoot}/dist/preload/index.cjs`,
}).catch((error: unknown) => {
  process.stderr.write(`E2E application failed: ${errorMessage(error)}\n`);
  app.exit(1);
});

function createFakeClient(config: SliverClientConfig, testState: FakeMainState): SliverClientAdapter {
  const eventSubject = new Subject<clientpb.Event>();
  const eventStreamState = new BehaviorSubject<{
    status: "stopped" | "connecting" | "connected" | "retrying";
    attempt: number;
    error?: string;
  }>({
    status: "stopped",
    attempt: 0,
  });
  let nextJobId = 42;
  let nextTaskId = 1;
  let jobs: clientpb.Job[] = [
    {
      ID: 41,
      Name: "mtls",
      Description: "Seeded mTLS listener",
      Protocol: "mtls",
      Port: 31337,
      Domains: [],
      ProfileName: "",
    },
  ];
  let sessions = [seedSession(testState.sessionName)];
  let beacons = [seedBeacon(testState.beaconName)];
  const tasks = new Map<string, clientpb.BeaconTask>();

  globalThis.__SLIVER_GUI_E2E_CONTROL__ = {
    setEventStreamStatus(status) {
      eventStreamState.next(status === "connected"
        ? { status: "connected", attempt: 0 }
        : { status: "retrying", attempt: 1, error: "Injected event stream interruption" });
    },
    completeTask(taskId, emitEvent = true) {
      const task = tasks.get(taskId);
      if (!task) throw new Error("Unknown fake beacon task");
      if (task.State === "canceled") throw new Error("Cannot complete a canceled fake beacon task");
      task.State = "completed";
      task.SentAt = task.SentAt === "0" ? epochSeconds() : task.SentAt;
      task.CompletedAt = epochSeconds();
      synchronizeTasks();
      if (emitEvent) eventSubject.next(fakeEvent("beacon-taskresult"));
    },
  };

  const record = (method: string): void => {
    testState.methods.push(method);
  };
  const unsupported = (method: string): never => {
    record(method);
    throw new Error(`The fake backend does not implement ${method}`);
  };

  return {
    event$: eventSubject.asObservable(),
    eventStreamState$: eventStreamState.asObservable(),
    async connect() {
      record("connect");
      if (config.token !== "FAKE_TOKEN_M0_DO_NOT_RENDER") {
        throw new Error("The fake backend received an unexpected token");
      }
      eventStreamState.next({ status: "connected", attempt: 0 });
      return this;
    },
    async disconnect() {
      record("disconnect");
      testState.disconnects += 1;
      eventStreamState.next({ status: "stopped", attempt: 0 });
    },
    async getVersion() {
      record("getVersion");
      return {
        Major: 1,
        Minor: 6,
        Patch: 2,
        Commit: SLIVER_PROTOCOL_BASELINE_COMMIT,
        Dirty: false,
        CompiledAt: "2026-08-09T00:00:00Z",
        OS: process.platform,
        Arch: process.arch,
      };
    },
    async jobs() {
      record("jobs");
      return jobs.map((job) => ({ ...job, Domains: [...job.Domains] }));
    },
    async implantBuilds() {
      record("implantBuilds");
      return { Configs: {}, ResourceIDs: {}, staged: {} };
    },
    async implantProfiles() {
      record("implantProfiles");
      return { Profiles: [] };
    },
    async getCompiler() {
      record("getCompiler");
      return {
        GOOS: process.platform,
        GOARCH: process.arch,
        Targets: [
          { GOOS: "linux", GOARCH: "amd64", Format: clientpb.OutputFormat.EXECUTABLE },
        ],
        CrossCompilers: [],
        UnsupportedTargets: [],
      };
    },
    async getOperators() {
      record("getOperators");
      return clientpb.Operators.create({
        Operators: [
          { Name: config.operator, Online: true },
          { Name: "m1-read-only-observer", Online: true },
        ],
      });
    },
    async getSessions() {
      record("getSessions");
      return clientpb.Sessions.create({ Sessions: sessions.map(cloneSession) });
    },
    async getBeacons() {
      record("getBeacons");
      return clientpb.Beacons.create({ Beacons: beacons.map(cloneBeacon) });
    },
    async startMTLSListener(host: string, port: number) {
      record("startMTLSListener");
      const job: clientpb.Job = {
        ID: nextJobId++,
        Name: "mtls",
        Description: "Playwright-created mTLS listener",
        Protocol: "mtls",
        Port: port,
        Domains: host ? [host] : [],
        ProfileName: "",
      };
      jobs = [...jobs, job];
      eventSubject.next({
        EventType: "job-started",
        Job: job,
        Data: Buffer.from("FAKE_EVENT_SECRET_M0_DO_NOT_RENDER"),
        Err: "",
      });
      return { ID: String(job.ID), Type: "mtls", JobID: job.ID, MTLSConf: { Host: host, Port: port } };
    },
    async killJob(jobId: number) {
      record("killJob");
      const job = jobs.find((candidate) => candidate.ID === jobId);
      jobs = jobs.filter((candidate) => candidate.ID !== jobId);
      eventSubject.next({
        EventType: "job-stopped",
        ...(job ? { Job: job } : {}),
        Data: Buffer.from("FAKE_EVENT_SECRET_M0_DO_NOT_RENDER"),
        Err: "",
      });
      return { ID: jobId, Success: job !== undefined };
    },
    async startWGListener() { return unsupported("startWGListener"); },
    async startDNSListener() { return unsupported("startDNSListener"); },
    async startHTTPListenerWithOptions() { return unsupported("startHTTPListenerWithOptions"); },
    async startHTTPSListenerWithOptions() { return unsupported("startHTTPSListenerWithOptions"); },
    async startTCPStagerListenerWithOptions() { return unsupported("startTCPStagerListenerWithOptions"); },
    async generateUniqueIP() { return unsupported("generateUniqueIP"); },
    async generateImplant() { return unsupported("generateImplant"); },
    async regenerateImplant() { return unsupported("regenerateImplant"); },
    async deleteImplantBuild() { return unsupported("deleteImplantBuild"); },
    async stageImplantBuild() { return unsupported("stageImplantBuild"); },
    async saveImplantProfile() { return unsupported("saveImplantProfile"); },
    async deleteImplantProfile() { return unsupported("deleteImplantProfile"); },
    async renameSession(sessionId: string, name: string) {
      record("renameSession");
      sessions = sessions.map((session) => session.ID === sessionId ? { ...session, Name: name } : session);
      testState.sessionName = name;
      emitSessionEvent("session-updated", sessions.find((session) => session.ID === sessionId));
      return {};
    },
    async renameBeacon(beaconId: string, name: string) {
      record("renameBeacon");
      beacons = beacons.map((beacon) => beacon.ID === beaconId ? { ...beacon, Name: name } : beacon);
      testState.beaconName = name;
      eventSubject.next(fakeEvent("beacon-registered"));
      return {};
    },
    async pingSession(sessionId: string, nonce: number) {
      record("pingSession");
      requireSession(sessionId);
      return sliverpb.Ping.create({ Nonce: nonce, Response: response(false) });
    },
    async pingBeacon(beaconId: string, nonce: number) {
      record("pingBeacon");
      requireBeacon(beaconId);
      return sliverpb.Ping.create({
        Nonce: nonce,
        Response: queueTask(
          beaconId,
          "Ping",
          Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: nonce, Response: response(false) })).finish()),
        ),
      });
    },
    async getEnvSession(sessionId: string, name = "") {
      record("getEnvSession");
      requireSession(sessionId);
      return environmentResponse(name);
    },
    async getEnvBeacon(beaconId: string, name = "") {
      record("getEnvBeacon");
      requireBeacon(beaconId);
      return environmentResponse(name);
    },
    async setEnvSession(sessionId: string, key: string, value: string) {
      record("setEnvSession");
      requireSession(sessionId);
      testState.environment[key] = value;
      return sliverpb.SetEnv.create({ Response: response(false) });
    },
    async setEnvBeacon(beaconId: string, key: string, value: string) {
      record("setEnvBeacon");
      requireBeacon(beaconId);
      testState.environment[key] = value;
      return sliverpb.SetEnv.create({
        Response: queueTask(
          beaconId,
          "SetEnvReq",
          Buffer.from(sliverpb.SetEnv.encode(sliverpb.SetEnv.create({ Response: response(false) })).finish()),
        ),
      });
    },
    async unsetEnvSession(sessionId: string, name: string) {
      record("unsetEnvSession");
      requireSession(sessionId);
      delete testState.environment[name];
      return sliverpb.UnsetEnv.create({ Response: response(false) });
    },
    async unsetEnvBeacon(beaconId: string, name: string) {
      record("unsetEnvBeacon");
      requireBeacon(beaconId);
      delete testState.environment[name];
      return sliverpb.UnsetEnv.create({
        Response: queueTask(
          beaconId,
          "UnsetEnvReq",
          Buffer.from(sliverpb.UnsetEnv.encode(sliverpb.UnsetEnv.create({ Response: response(false) })).finish()),
        ),
      });
    },
    async killSession(sessionId: string) {
      record("killSession");
      const session = requireSession(sessionId);
      sessions = sessions.filter((candidate) => candidate.ID !== sessionId);
      emitSessionEvent("session-disconnected", session);
      return {};
    },
    async killBeacon(beaconId: string) {
      record("killBeacon");
      requireBeacon(beaconId);
      return {};
    },
    async reconfigureBeacon(beaconId: string) {
      record("reconfigureBeacon");
      requireBeacon(beaconId);
      return sliverpb.Reconfigure.create({
        Response: queueTask(
          beaconId,
          "ReconfigureReq",
          Buffer.alloc(0),
        ),
      });
    },
    async openSessionFromBeacon(beaconId: string, c2s: string[], delayNanoseconds = "0") {
      record("openSessionFromBeacon");
      requireBeacon(beaconId);
      testState.openSessionRequests.push({ beaconId, c2s: [...c2s], delayNanoseconds });
      return sliverpb.OpenSession.create({
        C2s: [...c2s],
        Delay: delayNanoseconds,
        Response: queueTask(
          beaconId,
          "OpenSession",
          Buffer.alloc(0),
        ),
      });
    },
    async closeSession(sessionId: string) {
      record("closeSession");
      const session = requireSession(sessionId);
      sessions = sessions.filter((candidate) => candidate.ID !== sessionId);
      emitSessionEvent("session-disconnected", session);
      return {};
    },
    async getBeaconTasks(beaconId: string) {
      record("getBeaconTasks");
      requireBeacon(beaconId);
      return clientpb.BeaconTasks.create({
        BeaconID: beaconId,
        Tasks: [...tasks.values()]
          .filter((task) => task.BeaconID === beaconId)
          .map(cloneTask),
      });
    },
    async fetchBeaconTask(taskId: string) {
      record("fetchBeaconTask");
      const task = tasks.get(taskId);
      if (!task) throw new Error("Unknown fake beacon task");
      return cloneTask(task);
    },
    async cancelBeaconTask(taskId: string) {
      record("cancelBeaconTask");
      const task = tasks.get(taskId);
      if (!task) throw new Error("Unknown fake beacon task");
      if (task.State !== "pending") return cloneTask(task);
      task.State = "canceled";
      synchronizeTasks();
      eventSubject.next(fakeEvent("beacon-taskresult"));
      return cloneTask(task);
    },
    async rmBeacon(beaconId: string) {
      record("rmBeacon");
      requireBeacon(beaconId);
      beacons = beacons.filter((candidate) => candidate.ID !== beaconId);
      for (const [taskId, task] of tasks) {
        if (task.BeaconID === beaconId) tasks.delete(taskId);
      }
      synchronizeTasks();
      eventSubject.next(fakeEvent("beacon-registered"));
    },
  };

  function requireSession(sessionId: string): clientpb.Session {
    const session = sessions.find((candidate) => candidate.ID === sessionId);
    if (!session) throw new Error("Unknown fake session");
    return session;
  }

  function requireBeacon(beaconId: string): clientpb.Beacon {
    const beacon = beacons.find((candidate) => candidate.ID === beaconId);
    if (!beacon) throw new Error("Unknown fake beacon");
    return beacon;
  }

  function environmentResponse(name: string): sliverpb.EnvInfo {
    const entries = Object.entries(testState.environment)
      .filter(([key]) => !name || key === name)
      .map(([Key, Value]) => ({ Key, Value }));
    return sliverpb.EnvInfo.create({ Variables: entries, Response: response(false) });
  }

  function queueTask(beaconId: string, description: string, result: Buffer) {
    const id = `m1_task_${nextTaskId++}`;
    const createdAt = epochSeconds();
    const task = clientpb.BeaconTask.create({
      ID: id,
      BeaconID: beaconId,
      CreatedAt: createdAt,
      State: "pending",
      SentAt: "0",
      CompletedAt: "0",
      Request: Buffer.from("FAKE_TASK_REQUEST_SECRET_M1_DO_NOT_RENDER"),
      Response: result,
      Description: description,
    });
    tasks.set(id, task);
    synchronizeTasks();
    const hold = testState.holdNextBeaconTask;
    testState.holdNextBeaconTask = false;
    if (!hold) {
      setTimeout(() => {
        if (task.State !== "pending") return;
        task.State = "sent";
        task.SentAt = epochSeconds();
        synchronizeTasks();
      }, 75).unref();
      setTimeout(() => {
        if (task.State === "canceled") return;
        task.State = "completed";
        task.SentAt ||= epochSeconds();
        task.CompletedAt = epochSeconds();
        synchronizeTasks();
        eventSubject.next(fakeEvent("beacon-taskresult"));
      }, 225).unref();
    }
    return response(true, beaconId, id);
  }

  function synchronizeTasks(): void {
    testState.tasks = [...tasks.values()].map((task) => ({
      id: task.ID,
      beaconId: task.BeaconID,
      state: task.State,
      description: task.Description,
    }));
    beacons = beacons.map((beacon) => {
      const beaconTasks = [...tasks.values()].filter((task) => task.BeaconID === beacon.ID);
      return {
        ...beacon,
        TasksCount: String(beaconTasks.length),
        TasksCountCompleted: String(beaconTasks.filter((task) => task.State === "completed").length),
      };
    });
  }

  function emitSessionEvent(eventType: string, session?: clientpb.Session): void {
    eventSubject.next({
      ...fakeEvent(eventType),
      ...(session ? { Session: cloneSession(session) } : {}),
    });
  }

  function fakeEvent(eventType: string): clientpb.Event {
    return clientpb.Event.create({ EventType: eventType, Data: Buffer.from("FAKE_EVENT_SECRET_M0_DO_NOT_RENDER") });
  }
}

function seedSession(name: string): clientpb.Session {
  const now = Number(epochSeconds());
  return clientpb.Session.create({
    ID: "m1_session",
    Name: name,
    Hostname: "m1-session-host",
    UUID: "m1-session-host-id",
    Username: "e2e-user",
    OS: "darwin",
    Arch: "arm64",
    Transport: "mtls",
    RemoteAddress: "127.0.0.1:41001",
    PID: 41001,
    Filename: "/private/tmp/m1-session",
    LastCheckin: String(now),
    ActiveC2: "mtls://operator:FAKE_TARGET_SECRET_M1_DO_NOT_RENDER@127.0.0.1:4444/secret-path",
    Version: "1.7.6",
    IsDead: false,
    ReconnectInterval: "60000000000",
    Burned: false,
    Locale: "en-US",
    FirstContact: String(now - 30),
    Integrity: "Medium",
  });
}

function seedBeacon(name: string): clientpb.Beacon {
  const now = Number(epochSeconds());
  return clientpb.Beacon.create({
    ID: "m1_beacon",
    Name: name,
    Hostname: "m1-beacon-host",
    UUID: "m1-beacon-host-id",
    Username: "e2e-user",
    OS: "darwin",
    Arch: "arm64",
    Transport: "https",
    RemoteAddress: "127.0.0.1:41002",
    PID: 41002,
    Filename: "/private/tmp/m1-beacon",
    LastCheckin: String(now),
    ActiveC2: "https://operator:FAKE_TARGET_SECRET_M1_DO_NOT_RENDER@127.0.0.1:4445/secret-path",
    Version: "1.7.6",
    IsDead: false,
    ReconnectInterval: "2000000000",
    Interval: "8000000000",
    Jitter: "0",
    Burned: false,
    NextCheckin: String(now + 3_600),
    TasksCount: "0",
    TasksCountCompleted: "0",
    Locale: "en-US",
    FirstContact: String(now - 30),
    Integrity: "Medium",
  });
}

function cloneSession(session: clientpb.Session): clientpb.Session {
  return clientpb.Session.create(session);
}

function cloneBeacon(beacon: clientpb.Beacon): clientpb.Beacon {
  return clientpb.Beacon.create(beacon);
}

function cloneTask(task: clientpb.BeaconTask): clientpb.BeaconTask {
  return clientpb.BeaconTask.create({
    ...task,
    Request: Buffer.from(task.Request),
    Response: Buffer.from(task.Response),
  });
}

function response(isAsync: boolean, beaconId = "", taskId = "") {
  return { Err: "", Async: isAsync, BeaconID: beaconId, TaskID: taskId };
}

function epochSeconds(): string {
  return String(Math.floor(Date.now() / 1_000));
}

function requiredArgument(prefix: string): string {
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing required ${prefix.slice(2, -1)} argument`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
