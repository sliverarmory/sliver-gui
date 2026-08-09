import { app } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { clientpb, type SliverClientConfig } from "sliver-script";

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
}

declare global {
  // This global exists only in the separately compiled fake Electron main.
  // It is inspected externally by Playwright and is never part of dist/.
  var __SLIVER_GUI_E2E_STATE__: FakeMainState;
}

const repositoryRoot = requiredArgument("--repository-root=");
const state: FakeMainState = {
  configFactoryCalls: 0,
  dialogCalls: 0,
  methods: [],
  disconnects: 0,
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
  };
}

function requiredArgument(prefix: string): string {
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing required ${prefix.slice(2, -1)} argument`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
