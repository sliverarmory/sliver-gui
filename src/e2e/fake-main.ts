import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { app } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import {
  clientpb,
  sliverpb,
  type LocalForwardState,
  type PortForward,
  type ReversePortForward,
  type ReversePortForwardInfo,
  type ReversePortForwardState,
  type SliverClientConfig,
  type Socks5Proxy,
} from "sliver-script";

import {
  startApplication,
  type ApplicationCloudDeploymentController,
} from "../main/application.js";
import { createAppProtocolHandler } from "../main/app-protocol.js";
import type {
  NativePty,
  NativePtyDisposable,
  NativePtyExitEvent,
  NativePtyFactory,
  NativePtySpawnOptions,
} from "../main/console-runtime.js";
import type { ConsolePortRuntime } from "../main/console-port-session.js";
import { SshIdentityStore } from "../main/ssh-identity-store.js";
import {
  ConnectionRegistry,
  type SliverClientAdapter,
} from "../main/connection-registry.js";
import { BEACON_TEXT_READ_PROBE_BYTES } from "../main/sliver-client-adapter.js";
import { loadTerminalRuntime } from "../main/terminal-runtime.js";
import { resolveManagedServerFromDeployments } from "../main/managed-server-resolver.js";
import type { ManagedSshTarget } from "../shared/ssh-contracts.js";
import type {
  LocalRedirectorOverview,
  SoftwareInstallProgress,
  SoftwareInstallProgressSnapshot,
} from "../shared/software-deployment-contracts.js";
import { SESSION_WORKBENCH_MAX_ARTIFACT_BYTES } from "../shared/session-contracts.js";
import {
  E2E_AWS_CREDENTIAL_ID,
  E2E_AWS_DEPLOYMENT,
  E2E_AWS_DEPLOYMENT_ID,
  E2E_AWS_DEPLOYMENT_NAME,
  E2E_AWS_FIREWALL,
  E2E_AZURE_CREDENTIAL_ID,
  E2E_AZURE_DEPLOYMENT,
  E2E_AZURE_DEPLOYMENT_ID,
  E2E_AZURE_DEPLOYMENT_NAME,
  E2E_AZURE_FIREWALL,
  E2E_AZURE_SUBSCRIPTION_ID,
  E2E_AZURE_TENANT_ID,
} from "./cloud-deployment-fixture.js";
import {
  fakeBeaconEnvTaskResult,
  fakeBeaconGrepTaskResult,
  fakeBeaconIfconfigTaskResult,
  fakeBeaconLsTaskResult,
  fakeBeaconMemfilesTaskResult,
  fakeBeaconMountTaskResult,
  fakeBeaconNetstatTaskResult,
  fakeBeaconPsTaskResult,
  fakeBeaconPwdTaskResult,
  fakeBeaconTextTaskResult,
  fakeBeaconWhoamiTaskResult,
} from "./beacon-interact-fixture.js";
import { createCloudDnsFixture } from "./cloud-dns-fixture.js";

interface FakeMainState {
  configFactoryCalls: number;
  dialogCalls: number;
  methods: string[];
  uploads: Array<{
    path: string;
    fileName: string;
    destination: string;
    size: number;
    sha256: string;
    isIOC: boolean;
    isDirectory: boolean;
    overwrite: boolean;
  }>;
  disconnects: number;
  ssh: Array<{ writes: string[]; closed: boolean }>;
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
  reconfigureRequests: Array<{
    beaconId: string;
    options: Parameters<SliverClientAdapter["reconfigureBeacon"]>[1];
    timeoutSeconds: number | undefined;
  }>;
  tasks: Array<{
    id: string;
    beaconId: string;
    state: string;
    description: string;
  }>;
  processCalls: Array<{
    sessionId: string;
    options: Parameters<SliverClientAdapter["executeSession"]>[1];
    timeoutSeconds: number | undefined;
  }>;
  beaconProcessCalls: Array<{
    beaconId: string;
    options: Parameters<SliverClientAdapter["executeBeacon"]>[1];
  }>;
  assemblyCalls: Array<{
    targetMode: "session" | "beacon";
    targetId: string;
    assemblySha256: string;
    options: Parameters<SliverClientAdapter["executeAssemblySession"]>[2];
    timeoutSeconds: number | undefined;
  }>;
  bofCalls: Array<{
    targetMode: "session" | "beacon";
    targetId: string;
    objectSha256: string;
    objectHex: string;
    argumentsHex: string;
    entrypoint: string;
    timeoutSeconds: number;
  }>;
  legacyBofCalls: Array<{
    phase: "register" | "call";
    targetMode: "session" | "beacon";
    targetId: string;
    loaderHex: string;
    init?: string;
    os?: string;
    argumentsHex?: string;
    exportName?: string;
    timeoutSeconds: number;
  }>;
  processResponseHeld: boolean;
  m4Audit: {
    callCounts: Record<string, number>;
    artifactInputs: number;
    artifactInputBytes: number;
    credentialInputs: number;
    credentialInputBytes: number;
    zeroizedCopies: number;
    remoteServiceStarts: number;
    remoteServiceRemovals: number;
    retainedSensitiveInputs: number;
  };
  console: {
    spawns: Array<{
      executable: string;
      args: string[];
      cwd: string;
      rootDirectory: string;
      clientRootDirectory: string;
      configPath: string;
      historyPath: string;
      disableConsoleLogs: string;
      configEntries: string[];
      configSha256: string;
      writes: string[];
      resizes: Array<{ columns: number; rows: number }>;
      kills: number;
    }>;
    writes: string[];
    resizes: Array<{ columns: number; rows: number }>;
    kills: number;
  };
}

interface FakeMainControl {
  setEventStreamStatus(status: "connecting" | "connected" | "retrying" | "stopped"): void;
  completeTask(taskId: string, emitEvent?: boolean): void;
  holdNextConsoleExit(): void;
  releaseConsoleExitHold(): void;
  holdNextProcessResponse(): void;
  releaseProcessResponseHold(): void;
}

declare global {
  // This global exists only in the separately compiled fake Electron main.
  // It is inspected externally by Playwright and is never part of dist/.
  var __SLIVER_GUI_E2E_STATE__: FakeMainState;
  var __SLIVER_GUI_E2E_CONTROL__: FakeMainControl;
  var __SLIVER_GUI_PROTOCOL_E2E_HANDLER__: typeof createAppProtocolHandler;
}

const repositoryRoot = requiredArgument("--repository-root=");
const M2_FILE_CONTENT = "FAKE_M2_FILE_CONTENT_DO_NOT_JOURNAL";
const SSH_IDENTITY_PRIVATE_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "E2E_SSH_IDENTITY_PRIVATE_KEY_DO_NOT_RENDER",
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");
const state: FakeMainState = {
  configFactoryCalls: 0,
  dialogCalls: 0,
  methods: [],
  uploads: [],
  disconnects: 0,
  ssh: [],
  holdNextBeaconTask: false,
  sessionName: "m1-session",
  beaconName: "m1-beacon",
  environment: Object.fromEntries([
    ["HOME", "/Users/e2e"],
    ["SHELL", "/bin/zsh"],
    ["SLIVER_GUI_M2_API_TOKEN", "FAKE_M2_ENV_SECRET_DO_NOT_RENDER"],
    ...Array.from({ length: 105 }, (_, index) => [
      `M2_PAGE_${String(index + 1).padStart(3, "0")}`,
      `deterministic-value-${index + 1}`,
    ]),
  ]),
  openSessionRequests: [],
  reconfigureRequests: [],
  tasks: [],
  processCalls: [],
  beaconProcessCalls: [],
  assemblyCalls: [],
  bofCalls: [],
  legacyBofCalls: [],
  processResponseHeld: false,
  m4Audit: {
    callCounts: {},
    artifactInputs: 0,
    artifactInputBytes: 0,
    credentialInputs: 0,
    credentialInputBytes: 0,
    zeroizedCopies: 0,
    remoteServiceStarts: 0,
    remoteServiceRemovals: 0,
    retainedSensitiveInputs: 0,
  },
  console: {
    spawns: [],
    writes: [],
    resizes: [],
    kills: 0,
  },
};
globalThis.__SLIVER_GUI_E2E_STATE__ = state;
globalThis.__SLIVER_GUI_PROTOCOL_E2E_HANDLER__ = createAppProtocolHandler;
let holdNextConsoleExit = false;
let heldConsoleExit: (() => void) | undefined;
let holdNextProcessResponse = false;
let heldProcessResponse: (() => void) | undefined;
let advanceSessionCheckinOnNextRead = false;
const consoleClientRootDirectory = requiredArgument("--console-client-root-directory=");
const sshIdentityDirectoryArgument = process.argv.find((argument) => (
  argument.startsWith("--ssh-identity-directory=")
));
const sshIdentityStore = new SshIdentityStore(
  sshIdentityDirectoryArgument?.slice("--ssh-identity-directory=".length) ??
    join(requiredArgument("--user-data-directory="), "ssh-identities"),
);
// Optional display-only provenance for the dedicated Overview journey. Existing
// E2E callers keep the unassociated fixture and never load cloud credentials.
const overviewCloudArgument = process.argv.find((argument) => argument.startsWith("--overview-cloud-fixture="));
const overviewPivotFixture = process.argv.includes("--overview-pivot-fixture");
const overviewEgressFixture = process.argv.includes("--overview-egress-fixture");
const overviewSoftwareFixture = process.argv.includes("--overview-software-fixture");
const registryLayoutFixture = process.argv.includes("--registry-layout-fixture");
const bofExecutionFixture = process.argv.includes("--bof-execution-fixture");
const filesLayoutFixture = process.argv.includes("--files-layout-fixture");
const beaconsTableFixture = process.argv.includes("--beacons-table-fixture");
const beaconManagementDenialFixture = process.argv.includes("--beacon-management-denial-fixture");
const beaconExecutionFixture = process.argv.includes("--beacon-execution-fixture");
const beaconBC03Fixture = process.argv.includes("--beacon-bc03-fixture");
if (registryLayoutFixture && overviewPivotFixture) {
  throw new Error("The Registry layout and Overview pivot fixtures cannot be enabled together");
}
if (overviewEgressFixture && (registryLayoutFixture || overviewPivotFixture)) {
  throw new Error("The Overview egress fixture cannot be combined with other topology fixtures");
}
const overviewCloudRecord = overviewCloudArgument === "--overview-cloud-fixture=aws"
  ? E2E_AWS_DEPLOYMENT
  : overviewCloudArgument === "--overview-cloud-fixture=azure" ? E2E_AZURE_DEPLOYMENT : null;
if (overviewCloudArgument && !overviewCloudRecord) throw new Error("Unknown Overview cloud fixture");
const overviewCloudDeployment = overviewCloudRecord ? {
  ...overviewCloudRecord,
  operatorConfigDigest: createHash("sha256").update(readFileSync(
    join(requiredArgument("--saved-config-directory="), "overview-fixture.cfg"),
  )).digest("hex"),
} : null;
const overviewRedirector: LocalRedirectorOverview = {
  id: "99999999-9999-4999-8999-999999999999",
  recipeId: "caddy",
  status: "active",
  publicUrl: "https://c2.example.test",
  publicIp: "198.51.100.24",
  domains: ["c2.example.test"],
  listener: { ownership: "managed", kind: "http", host: "127.0.0.1", port: 8000, jobId: 8, domain: "" },
  lastCheckedAt: "2026-09-24T12:00:00.000Z",
};
let overviewSoftwareInstallProgress: SoftwareInstallProgressSnapshot | null = null;

const softwareFixturePause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 100));

const registry = new ConnectionRegistry({
  savedConfigDirectory: requiredArgument("--saved-config-directory="),
  managedConfigDirectory: requiredArgument("--managed-config-directory="),
  clientRootDirectory: consoleClientRootDirectory,
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

const cloudDeploymentController: ApplicationCloudDeploymentController = {
  ...createCloudDnsFixture(process.argv.includes("--dns-fixture")),
  ...(overviewCloudDeployment ? {
    resolveManagedServer: (digest: string) => {
      const server = resolveManagedServerFromDeployments(digest, [overviewCloudDeployment]);
      return overviewSoftwareFixture && server?.overview
        ? { ...server, overview: { ...server.overview, redirectors: [overviewRedirector] } }
        : server;
    },
  } : {}),
  listSshTargets: async () => ({
    ok: true,
    value: [fakeSshTarget(E2E_AWS_DEPLOYMENT_ID), fakeSshTarget(E2E_AZURE_DEPLOYMENT_ID)],
  }),
  materializeSshIdentity: async (target) => {
    const expected = target.deploymentId === E2E_AWS_DEPLOYMENT_ID ||
        target.deploymentId === E2E_AZURE_DEPLOYMENT_ID
      ? fakeSshTarget(target.deploymentId)
      : undefined;
    if (!expected || !sameFakeSshTarget(target, expected)) {
      return { ok: false, error: "Unknown local SSH fixture" };
    }
    try {
      return {
        ok: true,
        value: await sshIdentityStore.materialize({
          managedName: expected.name,
          deploymentId: expected.deploymentId,
          privateKey: SSH_IDENTITY_PRIVATE_KEY,
        }),
      };
    } catch {
      return { ok: false, error: "The local SSH identity could not be materialized" };
    }
  },
  startSshSession: async (deploymentId) => {
    if (deploymentId !== E2E_AWS_DEPLOYMENT_ID && deploymentId !== E2E_AZURE_DEPLOYMENT_ID) {
      return { ok: false, error: "Unknown local SSH fixture" };
    }
    const record = { writes: [] as string[], closed: false };
    state.ssh.push(record);
    const subscribers = new Set<Parameters<ConsolePortRuntime["subscribe"]>[0]>();
    const runtime: ConsolePortRuntime = {
      subscribe(subscriber) {
        subscribers.add(subscriber);
        queueMicrotask(() => {
          if (!record.closed && subscribers.has(subscriber)) {
            subscriber.onOutput(Buffer.from("Managed SSH E2E ready\r\n"));
          }
        });
        return () => subscribers.delete(subscriber);
      },
      write(data) { record.writes.push(Buffer.from(data).toString("utf8")); },
      resize() {},
      pauseOutput() {},
      resumeOutput() {},
      async close() {
        if (record.closed) return;
        record.closed = true;
        for (const subscriber of subscribers) subscriber.onExit({ exitCode: 0 });
      },
    };
    return { ok: true, value: { target: fakeSshTarget(deploymentId), runtime } };
  },
  getTerminalRuntime: async () => ({ ok: true, value: await loadTerminalRuntime() }),
  detectCurrentEgressIpv4: () => ({
    ok: true,
    value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
  }),
  getSnapshot: () => ({
    ok: true,
    value: {
      state: {
        v: 1,
        revision: 1,
        deployments: [E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT],
      },
      credentials: [
        {
          id: E2E_AWS_CREDENTIAL_ID,
          provider: "aws",
          label: "E2E AWS profile",
          persistence: "secure",
          createdAt: "2026-09-06T18:00:00.000Z",
          defaultRegion: "us-west-2",
          sshUsername: "ubuntu",
          profileName: "default",
        },
        {
          id: E2E_AZURE_CREDENTIAL_ID,
          provider: "azure",
          label: "E2E Azure CLI",
          persistence: "secure",
          createdAt: "2026-09-06T18:10:00.000Z",
          defaultLocation: "eastus",
          subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
          tenantId: E2E_AZURE_TENANT_ID,
          sshUsername: "azureuser",
        },
      ],
      secureCredentialStorage: true,
      refreshErrors: [],
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      azureAccounts: [{
        subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
        name: "E2E Subscription",
        tenantId: E2E_AZURE_TENANT_ID,
        homeTenantId: E2E_AZURE_TENANT_ID,
        isDefault: true,
        cloudName: "AzureCloud",
      }],
      azureAccountDiscoveryError: null,
      provisioningTranscripts: [],
    },
  }),
  getProvisioningTranscripts: () => ({
    ok: true,
    value: { provisioningTranscripts: [] },
  }),
  refreshDeployments: () => ({
    ok: true,
    value: {
      state: { v: 1, revision: 1, deployments: [E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT] },
      refreshErrors: [],
    },
  }),
  chooseSshPrivateKey: () => ({ ok: false, error: "The E2E key picker is unavailable" }),
  getSoftwareState: () => ({ ok: true, value: { v: 1, revision: 0, records: [] } }),
  getSoftwareInstallProgress: (deploymentId) => ({
    ok: true,
    value: overviewSoftwareFixture && deploymentId === E2E_AWS_DEPLOYMENT_ID
      ? overviewSoftwareInstallProgress : null,
  }),
  listSoftwareListeners: () => ({ ok: true, value: [] }),
  installLocalRedirector: async (input, onProgress) => {
    if (!overviewSoftwareFixture || input.deploymentId !== E2E_AWS_DEPLOYMENT_ID ||
        input.expectedRevision !== 0 || input.recipeId !== "caddy" ||
        input.dnsRecords?.zoneId !== "ZEXAMPLE" || input.dnsRecords.names.length !== 1 ||
        input.dnsRecords.names[0] !== "c2" || input.domains.length !== 1 ||
        input.domains[0] !== "c2.example.test" ||
        input.publicIp !== E2E_AWS_DEPLOYMENT.runtime.publicIpAddress ||
        input.listener.mode !== "create" || input.listener.port !== 8000) {
      return { ok: false, error: "Cloud mutations are disabled in this E2E fixture" };
    }
    const failure = "E2E fixture stopped at verification; no cloud or SSH changes were made";
    overviewSoftwareInstallProgress = {
      deploymentId: input.deploymentId,
      recipeId: input.recipeId,
      status: "running",
      truncated: false,
      outputSequenceStart: 0,
      events: [],
    };
    const emit = (event: Omit<SoftwareInstallProgress, "deploymentId">): void => {
      const progress: SoftwareInstallProgress = { deploymentId: input.deploymentId, ...event };
      overviewSoftwareInstallProgress = {
        ...overviewSoftwareInstallProgress!,
        status: progress.status === "failed" ? "failed" : "running",
        events: [...overviewSoftwareInstallProgress!.events, progress],
      };
      onProgress?.(progress);
    };
    emit({ step: "dns", status: "running", message: "Creating A record for c2.example.test" });
    await softwareFixturePause();
    emit({ step: "dns", status: "complete", message: "c2.example.test points to this server" });
    emit({ step: "listener", status: "running", message: "Preparing localhost Sliver listener" });
    await softwareFixturePause();
    emit({ step: "listener", status: "complete", message: "Sliver HTTP listener is ready on 127.0.0.1:8000" });
    emit({ step: "firewall", status: "running", message: "Opening public redirector ports" });
    await softwareFixturePause();
    emit({ step: "firewall", status: "complete", message: "Public ingress is ready on TCP 80 and 443" });
    emit({ step: "ssh", status: "running", message: "Installing Caddy over SSH" });
    emit({ step: "ssh", status: "running", output: {
      stream: "stdout",
      chunk: new TextEncoder().encode("E2E fixture: installing Caddy package\r\nE2E fixture: service configured\r\n"),
    } });
    await softwareFixturePause();
    emit({ step: "ssh", status: "complete", message: "Caddy installation finished" });
    emit({ step: "verify", status: "running", message: "Verifying the public redirector endpoint" });
    await softwareFixturePause();
    emit({ step: "verify", status: "failed", message: failure });
    return { ok: false, error: failure };
  },
  removeLocalRedirector: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  createCredential: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  loginAwsCredential: () => ({ ok: false, error: "AWS login is disabled in this E2E fixture" }),
  beginAzureLogin: () => ({ ok: false, error: "Azure login is disabled in this E2E fixture" }),
  loginAzureCredential: () => ({ ok: false, error: "Azure login is disabled in this E2E fixture" }),
  cancelAzureLogin: () => undefined,
  deleteCredential: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  testCredential: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  discoverAwsOptions: (input) => {
    if (input.credentialId !== E2E_AWS_CREDENTIAL_ID || input.region !== "us-west-2") {
      return { ok: false, error: "The E2E AWS discovery request was not renderer-safe" };
    }
    return {
      ok: true,
      value: {
        region: "us-west-2",
        instanceTypes: [
          { name: "t3.micro", architecture: "x86_64", vCpuCount: 2, memoryMiB: 1_024, processor: "Intel Xeon", description: "Burstable x86 compute" },
          { name: "t3.small", architecture: "x86_64", vCpuCount: 2, memoryMiB: 2_048, processor: "Intel Xeon", description: "Burstable x86 compute" },
          { name: "t3.medium", architecture: "x86_64", vCpuCount: 2, memoryMiB: 4_096, processor: "Intel Xeon", description: "Burstable x86 compute" },
          { name: "t3.large", architecture: "x86_64", vCpuCount: 2, memoryMiB: 8_192, processor: "Intel Xeon", description: "Burstable x86 compute" },
          { name: "t3.xlarge", architecture: "x86_64", vCpuCount: 4, memoryMiB: 16_384, processor: "Intel Xeon", description: "Burstable x86 compute" },
          { name: "t4g.micro", architecture: "arm64", vCpuCount: 2, memoryMiB: 1_024, processor: "AWS Graviton2", description: "Burstable Arm compute" },
          { name: "t4g.small", architecture: "arm64", vCpuCount: 2, memoryMiB: 2_048, processor: "AWS Graviton2", description: "Burstable Arm compute" },
          { name: "t4g.medium", architecture: "arm64", vCpuCount: 2, memoryMiB: 4_096, processor: "AWS Graviton2", description: "Burstable Arm compute" },
          { name: "t4g.large", architecture: "arm64", vCpuCount: 2, memoryMiB: 8_192, processor: "AWS Graviton2", description: "Burstable Arm compute" },
          { name: "t4g.xlarge", architecture: "arm64", vCpuCount: 4, memoryMiB: 16_384, processor: "AWS Graviton2", description: "Burstable Arm compute" },
        ],
        images: [
          { id: "ami-11111111111111111", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server", description: "Ubuntu Server 24.04 LTS", architecture: "x86_64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
          { id: "ami-22222222222222222", name: "al2023-ami-2023-x86_64", description: "Amazon Linux 2023", architecture: "x86_64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
          { id: "ami-aaaaaaaaaaaaaaaaa", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-arm64-server", description: "Ubuntu Server 24.04 LTS", architecture: "arm64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
          { id: "ami-bbbbbbbbbbbbbbbbb", name: "al2023-ami-2023-arm64", description: "Amazon Linux 2023", architecture: "arm64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
        ],
        vpcs: [
          { id: "vpc-0123456789abcdef0", name: "default", cidrBlock: "172.31.0.0/16", isDefault: true },
          { id: "vpc-11111111111111111", name: "operations", cidrBlock: "10.20.0.0/16", isDefault: false },
        ],
        subnets: [
          { id: "subnet-0123456789abcdef0", name: "default-public", vpcId: "vpc-0123456789abcdef0", availabilityZone: "us-west-2a", cidrBlock: "172.31.16.0/20", mapPublicIpOnLaunch: true },
          { id: "subnet-11111111111111111", name: "operations-private", vpcId: "vpc-11111111111111111", availabilityZone: "us-west-2b", cidrBlock: "10.20.1.0/24", mapPublicIpOnLaunch: false },
        ],
        keyPairs: [
          { name: "operator-existing", id: "key-0123456789abcdef0", fingerprint: "SHA256:abcdefghijklmnopqrstuv", keyType: "ed25519", isCredentialMatch: true },
          { name: "unusable-key", id: "key-11111111111111111", fingerprint: "SHA256:does-not-match", keyType: "rsa", isCredentialMatch: false },
        ],
        credentialKey: {
          type: "ed25519",
          fingerprint: "SHA256:abcdefghijklmnopqrstuv",
          matchingKeyPairNames: ["operator-existing"],
        },
      },
    };
  },
  discoverAzureAccounts: () => ({
    ok: true,
    value: [{
      subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
      name: "E2E Subscription",
      tenantId: E2E_AZURE_TENANT_ID,
      homeTenantId: E2E_AZURE_TENANT_ID,
      isDefault: true,
      cloudName: "AzureCloud",
    }],
  }),
  discoverAzureOptions: (input) => {
    if (input.credentialId !== E2E_AZURE_CREDENTIAL_ID || input.location !== "eastus") {
      return { ok: false, error: "The E2E Azure discovery request was not renderer-safe" };
    }
    return {
      ok: true,
      value: {
        location: "eastus",
        vmSizes: [{ name: "Standard_B2s", vCpuCount: 2, memoryMiB: 4_096 }],
        images: [{
          reference: "Canonical:ubuntu-24_04-lts:server:latest",
          label: "Ubuntu Server 24.04 LTS",
          architecture: "x64" as const,
          sshUsername: "azureuser",
        }],
        virtualNetworks: [],
        subnets: [],
      },
    };
  },
  createDeployment: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  generateOperatorConfig: () => ({
    ok: false,
    error: "Cloud mutations are disabled in this E2E fixture",
    mutationState: "not-started",
  }),
  runLifecycleAction: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  renameDeployment: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  updateFirewall: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  listFirewallRules: ({ deploymentId }) => {
    if (deploymentId === E2E_AWS_DEPLOYMENT.id) return { ok: true, value: E2E_AWS_FIREWALL };
    if (deploymentId === E2E_AZURE_DEPLOYMENT.id) return { ok: true, value: E2E_AZURE_FIREWALL };
    return { ok: false, error: "Unknown E2E cloud deployment" };
  },
  createFirewallRule: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  updateFirewallRule: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  deleteFirewallRule: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  ensureIngress: async () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  removeIngress: async () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  prepareDestroyDeployment: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
  executeDestroyDeployment: () => ({ ok: false, error: "Cloud mutations are disabled in this E2E fixture" }),
};

app.setPath("userData", requiredArgument("--user-data-directory="));
void startApplication({
  registry,
  applicationAssetsDirectory: `${repositoryRoot}/build`,
  consoleClientExecutable: process.execPath,
  consoleClientRootDirectory,
  consolePtyFactory: createFakeConsolePtyFactory(state, consoleClientRootDirectory),
  rendererEntryPath: `${repositoryRoot}/dist/renderer/index.html`,
  preloadPath: `${repositoryRoot}/dist/preload/index.cjs`,
  sshPreloadPath: `${repositoryRoot}/dist/preload/ssh.cjs`,
  cloudDeploymentPreloadPath: `${repositoryRoot}/dist/preload/cloud-deployment.cjs`,
  networkPreloadPath: `${repositoryRoot}/dist/preload/network.cjs`,
  textEditorPreloadPath: `${repositoryRoot}/dist/preload/text-editor.cjs`,
  armoryPreloadPath: `${repositoryRoot}/dist/preload/armory.cjs`,
  cloudDeploymentController,
}).catch((error: unknown) => {
  process.stderr.write(`E2E application failed: ${errorMessage(error)}\n`);
  app.exit(1);
});

function fakeSshTarget(deploymentId: string): ManagedSshTarget {
  const azure = deploymentId === E2E_AZURE_DEPLOYMENT_ID;
  return {
    deploymentId,
    name: azure ? E2E_AZURE_DEPLOYMENT_NAME : E2E_AWS_DEPLOYMENT_NAME,
    provider: azure ? "azure" : "aws",
    host: azure ? "203.0.113.42" : "192.0.2.10",
    port: 22,
    username: azure ? "azureuser" : "fixture",
    status: "running",
    connectable: true,
  };
}

function sameFakeSshTarget(left: ManagedSshTarget, right: ManagedSshTarget): boolean {
  return left.deploymentId === right.deploymentId &&
    left.name === right.name &&
    left.provider === right.provider &&
    left.host === right.host &&
    left.port === right.port &&
    left.username === right.username &&
    left.status === right.status &&
    left.connectable === right.connectable &&
    left.unavailableReason === right.unavailableReason;
}

function createFakeConsolePtyFactory(
  testState: FakeMainState,
  expectedClientRootDirectory: string,
): NativePtyFactory {
  return Object.freeze({
    spawn(file: string, args: string[], options: NativePtySpawnOptions): NativePty {
      const rootDirectory = options.cwd;
      const clientRootDirectory = options.env["SLIVER_CLIENT_ROOT_DIR"];
      const configPath = options.env["SLIVER_CLIENT_CONFIG"];
      const historyPath = options.env["SLIVER_CLIENT_HISTORY_FILE"];
      const disableConsoleLogs = options.env["SLIVER_CLIENT_DISABLE_CONSOLE_LOGS"];
      if (!clientRootDirectory || clientRootDirectory !== expectedClientRootDirectory) {
        throw new Error("Fake console received an invalid shared client root");
      }
      const configsDirectory = join(rootDirectory, "configs");
      if (!configPath || configPath !== join(configsDirectory, "active.cfg")) {
        throw new Error("Fake console received an invalid private active config path");
      }
      if (!historyPath || historyPath !== join(rootDirectory, "history")) {
        throw new Error("Fake console received an invalid private history path");
      }
      if (disableConsoleLogs !== "1") {
        throw new Error("Fake console did not disable transcript logging");
      }
      const configEntries = readdirSync(configsDirectory).sort();
      const activeConfig = readFileSync(configPath);
      let configSha256: string;
      try {
        configSha256 = createHash("sha256").update(activeConfig).digest("hex");
      } finally {
        activeConfig.fill(0);
      }
      const spawnRecord = {
        executable: file,
        args: [...args],
        cwd: options.cwd,
        rootDirectory,
        clientRootDirectory,
        configPath,
        historyPath,
        disableConsoleLogs,
        configEntries,
        configSha256,
        writes: [] as string[],
        resizes: [] as Array<{ columns: number; rows: number }>,
        kills: 0,
      };
      testState.console.spawns.push(spawnRecord);

      const dataListeners = new Set<(data: string) => void>();
      const exitListeners = new Set<(event: NativePtyExitEvent) => void>();
      let killed = false;
      return {
        write(data) {
          const text = Buffer.isBuffer(data) ? data.toString("utf8") : data;
          spawnRecord.writes.push(text);
          testState.console.writes.push(text);
        },
        resize(columns, rows) {
          spawnRecord.resizes.push({ columns, rows });
          testState.console.resizes.push({ columns, rows });
        },
        pause() {},
        resume() {},
        kill() {
          if (killed) return;
          killed = true;
          spawnRecord.kills += 1;
          testState.console.kills += 1;
          const deliverExit = (): void => {
            for (const listener of exitListeners) listener({ exitCode: 0 });
          };
          if (holdNextConsoleExit) {
            holdNextConsoleExit = false;
            heldConsoleExit = deliverExit;
          } else {
            queueMicrotask(deliverExit);
          }
        },
        onData(listener) {
          dataListeners.add(listener);
          queueMicrotask(() => {
            if (dataListeners.has(listener) && !killed) listener("Sliver E2E console ready\r\n");
          });
          return disposable(() => dataListeners.delete(listener));
        },
        onExit(listener) {
          exitListeners.add(listener);
          return disposable(() => exitListeners.delete(listener));
        },
      };
    },
  });
}

function disposable(dispose: () => void): NativePtyDisposable {
  let active = true;
  return {
    dispose() {
      if (!active) return;
      active = false;
      dispose();
    },
  };
}

function localForwardState(
  status: LocalForwardState["status"],
  reason?: LocalForwardState["reason"],
): LocalForwardState {
  return Object.freeze({
    status,
    activeConnections: 0,
    totalConnections: 0,
    bytesToTarget: 0,
    bytesFromTarget: 0,
    ...(reason ? { reason } : {}),
  });
}

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
  let nextShellId = 1;
  let nextEphemeralPort = 45_550;
  let nextReverseListenerId = 7_001;
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
  let sessions = registryLayoutFixture
    ? [seedRegistryLayoutSession(testState.sessionName)]
    : overviewPivotFixture ? seedOverviewPivotSessions()
      : overviewEgressFixture ? seedOverviewEgressSessions() : [seedSession(testState.sessionName)];
  let beacons = overviewPivotFixture || registryLayoutFixture ? []
    : overviewEgressFixture ? [{
      ...seedBeacon("egress-beacon"),
      ID: "overview_egress_beacon",
      Hostname: "overview-egress-beacon",
      UUID: "overview-egress-beacon-host-id",
      RemoteAddress: "198.51.100.10:43001",
    }] : [seedBeacon(testState.beaconName)];
  if (beaconsTableFixture) {
    beacons.push(clientpb.Beacon.create({
      ...seedBeacon("m2-beacon"),
      ID: "m2_beacon",
      ...(beaconManagementDenialFixture ? { ActiveC2: "" } : {}),
      Hostname: "m2-beacon-host",
      UUID: "m2-beacon-host-id",
      RemoteAddress: "127.0.0.1:41003",
      PID: 41003,
      Filename: "/private/tmp/m2-beacon",
    }));
  }
  if (beaconExecutionFixture) {
    for (const platform of ["windows", "linux"] as const) {
      beacons.push(clientpb.Beacon.create({
        ...seedBeacon(`${platform}-execution-beacon`),
        ID: `${platform}_execution_beacon`,
        Hostname: `${platform}-execution-host`,
        UUID: `${platform}-execution-host-id`,
        OS: platform,
        Arch: "amd64",
        Filename: platform === "windows" ? "C:\\ProgramData\\execution-beacon.exe" : "/tmp/execution-beacon",
      }));
    }
  }
  let lootStore: clientpb.Loot[] = [
    clientpb.Loot.create({
      ID: "591a16d2-e138-4a21-b38f-f166aa23e044",
      Name: "incident-notes",
      FileType: clientpb.FileType.TEXT,
      OriginHostUUID: "76955e80-e700-4bc1-84d0-4e8090d5b900",
      Size: "74",
      File: {
        Name: "incident-notes.txt",
        Data: Buffer.from("Deterministic loot preview.\nNo renderer-authored filesystem path is required.\n"),
      },
    }),
    clientpb.Loot.create({
      ID: "47f75f14-8849-4ea6-b9b8-3c6246eb643d",
      Name: "browser-memory",
      FileType: clientpb.FileType.BINARY,
      OriginHostUUID: "65c591f4-3a87-419f-bc26-c8598650742c",
      Size: "8192",
      File: { Name: "browser-memory.bin", Data: Buffer.alloc(8192, 0xa5) },
    }),
  ];
  let credentialStore: clientpb.Credential[] = [
    clientpb.Credential.create({
      ID: "8f45c4cd-8309-46de-88b8-1f08b92e9541",
      Username: "ACME\\alice",
      Plaintext: "FAKE_CREDENTIAL_SECRET_DO_NOT_RENDER_BY_DEFAULT",
      Hash: "8846f7eaee8fb117ad06bdd830b7586c",
      HashType: clientpb.HashType.NTLM,
      IsCracked: true,
      OriginHostUUID: "65c591f4-3a87-419f-bc26-c8598650742c",
      Collection: "workstation triage",
    }),
    clientpb.Credential.create({
      ID: "9f84127a-ed9d-4316-afb0-50cd604410f2",
      Username: "svc-backup",
      Hash: "d41d8cd98f00b204e9800998ecf8427e",
      HashType: clientpb.HashType.MD5,
      OriginHostUUID: "76955e80-e700-4bc1-84d0-4e8090d5b900",
      Collection: "manual",
    }),
  ];
  let workspaceFiles = filesLayoutFixture ? Array.from({ length: 105 }, (_, index) => {
    const isDirectory = index < 80;
    const number = String(index + 1).padStart(3, "0");
    return fakeFile(
      isDirectory ? `E2EFolder${number}` : `E2EFile${number}.txt`,
      isDirectory,
      isDirectory ? "0" : "2048",
      isDirectory ? "drwxr-xr-x" : "-rw-r--r--",
    );
  }) : [
    fakeFile(
      "notes.txt",
      false,
      String(Buffer.byteLength(`${M2_FILE_CONTENT}\nsecond deterministic line\n`, "utf8")),
      "-rw-r--r--",
    ),
    fakeFile("projects", true, "0", "drwxr-xr-x"),
  ];
  const remoteFiles = new Map<string, Buffer>([
    ["/Users/e2e/workspace/notes.txt", Buffer.from(`${M2_FILE_CONTENT}\nsecond deterministic line\n`, "utf8")],
    ["/Users/e2e/workspace/projects/readme.md", Buffer.from("deterministic project readme\n", "utf8")],
  ]);
  if (filesLayoutFixture) {
    for (let index = 81; index <= 105; index += 1) {
      const number = String(index).padStart(3, "0");
      remoteFiles.set(`/Users/e2e/workspace/E2EFile${number}.txt`, Buffer.alloc(2_048, 0x41));
    }
  }
  let memoryFiles = [
    fakeFile("73", false, "4096", "-rw-------", "m2-memory-cache.bin"),
  ];
  const processInventory = [
    fakeProcess(1, "launchd", 0),
    fakeProcess(41001, "sliver-m2-session", 1),
    fakeProcess(41012, "zsh", 41001),
    ...Array.from({ length: 105 }, (_, index) =>
      fakeProcess(42_000 + index, `m2-worker-${String(index + 1).padStart(3, "0")}`, 41001)),
  ];
  const tasks = new Map<string, clientpb.BeaconTask>();
  const portForwards = new Map<string, PortForward>();
  const socks5Proxies = new Map<string, Socks5Proxy>();
  const reversePortForwards = new Map<number, ReversePortForwardInfo>();

  globalThis.__SLIVER_GUI_E2E_CONTROL__ = {
    setEventStreamStatus(status) {
      eventStreamState.next(status === "connected" || status === "connecting"
        ? { status, attempt: 0 }
        : { status, attempt: 1, error: "Injected event stream interruption" });
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
    holdNextConsoleExit() {
      if (holdNextConsoleExit || heldConsoleExit) throw new Error("A fake console exit is already held");
      holdNextConsoleExit = true;
    },
    releaseConsoleExitHold() {
      holdNextConsoleExit = false;
      const release = heldConsoleExit;
      heldConsoleExit = undefined;
      if (release) queueMicrotask(release);
    },
    holdNextProcessResponse() {
      if (!registryLayoutFixture) throw new Error("Process response holds require the Windows fixture");
      if (holdNextProcessResponse || heldProcessResponse) throw new Error("A fake process response is already held");
      holdNextProcessResponse = true;
      advanceSessionCheckinOnNextRead = true;
    },
    releaseProcessResponseHold() {
      holdNextProcessResponse = false;
      advanceSessionCheckinOnNextRead = false;
      const release = heldProcessResponse;
      heldProcessResponse = undefined;
      if (release) queueMicrotask(release);
    },
  };

  const record = (method: string): void => {
    testState.methods.push(method);
  };
  const recordM4 = (method: string): void => {
    record(method);
    testState.m4Audit.callCounts[method] = (testState.m4Audit.callCounts[method] ?? 0) + 1;
  };
  const inspectArtifact = (
    value: Buffer | undefined,
    label: string,
    maximumBytes = 64 * 1_024 * 1_024,
    required = true,
  ): void => {
    if (value === undefined || value.length === 0) {
      if (required) throw new Error(`${label} is required by the deterministic fake`);
      return;
    }
    if (value.length > maximumBytes) throw new Error(`${label} exceeds the deterministic fake input limit`);
    const ownedCopy = Buffer.from(value);
    try {
      testState.m4Audit.artifactInputs += 1;
      testState.m4Audit.artifactInputBytes += ownedCopy.length;
    } finally {
      ownedCopy.fill(0);
      testState.m4Audit.zeroizedCopies += 1;
    }
  };
  const inspectCredentialBuffer = (
    value: Buffer | undefined,
    label: string,
    maximumBytes = 64 * 1_024,
  ): void => {
    if (value === undefined || value.length === 0) return;
    if (value.length > maximumBytes) throw new Error(`${label} exceeds the deterministic fake credential limit`);
    const ownedCopy = Buffer.from(value);
    try {
      testState.m4Audit.credentialInputs += 1;
      testState.m4Audit.credentialInputBytes += ownedCopy.length;
    } finally {
      ownedCopy.fill(0);
      testState.m4Audit.zeroizedCopies += 1;
    }
  };
  const inspectCredentialText = (value: string | undefined, label: string, required = false): void => {
    const byteLength = Buffer.byteLength(value ?? "", "utf8");
    if (required && byteLength === 0) throw new Error(`${label} is required by the deterministic fake`);
    if (byteLength === 0) return;
    if (byteLength > 64 * 1_024) throw new Error(`${label} exceeds the deterministic fake credential limit`);
    const ownedCopy = Buffer.from(value!, "utf8");
    try {
      testState.m4Audit.credentialInputs += 1;
      testState.m4Audit.credentialInputBytes += ownedCopy.length;
    } finally {
      ownedCopy.fill(0);
      testState.m4Audit.zeroizedCopies += 1;
    }
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
      await Promise.all([
        ...[...portForwards.values()].map((forward) => forward.close()),
        ...[...socks5Proxies.values()].map((proxy) => proxy.close()),
      ]);
      eventStreamState.next({ status: "stopped", attempt: 0 });
    },
    async startShellSession(sessionId, options) {
      record("startShellSession");
      requireSession(sessionId);
      const output = new FakeShellOutput();
      const shellId = `fake-shell-${nextShellId++}`;
      let commandBuffer = "";
      // Deliberately buffer the prompt before the main process can return the
      // attachment ticket. The Electron journey therefore exercises the
      // detached early-output path instead of relying on a favorable race.
      record("shell.early-output");
      output.push(`Sliver GUI M3 shell (${shellId})\r\ne2e-user@m1-session-host $ `);
      return {
        id: shellId,
        pid: 41_012,
        path: options.path,
        ptyRequested: options.pty,
        output,
        async write(chunk: Uint8Array | string) {
          record("shell.write");
          const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
          output.push(text.replace(/\r\n|\r|\n/gu, "\r\n"));
          const commands = `${commandBuffer}${text}`.split(/\r\n|\r|\n/gu);
          commandBuffer = commands.pop() ?? "";
          for (const commandText of commands) {
            const command = commandText.trim();
            if (!command) {
              output.push("e2e-user@m1-session-host $ ");
            } else if (/^whoami$/iu.test(command)) {
              record("shell.command.whoami");
              output.push("e2e-user\r\ne2e-user@m1-session-host $ ");
            } else if (/^pwd$/iu.test(command)) {
              record("shell.command.pwd");
              output.push("/Users/e2e/workspace\r\ne2e-user@m1-session-host $ ");
            } else if (/^m3-hostile-output$/iu.test(command)) {
              record("shell.command.hostile-output");
              output.push([
                "Host-effect probes quarantined\r\n",
                "\u001b]0;hostile terminal title\u0007",
                "\u001b]8;;https://terminal-output.invalid/blocked\u001b\\hostile-link\u001b]8;;\u001b\\",
                "\u001b]52;c;TUFDSElORV9DTElQQk9BUkRfUFJPQkU=\u0007",
                "\u001bP$qhostile-device-control\u001b\\",
                "\u001b_Gf=100;HOSTILE_KITTY_TRANSFER\u001b\\",
                "\u001b]1337;File=name=cHJvYmUudHh0:SE9TVElMRV9ET1dOTE9BRF9QUk9CRQ==\u0007",
                "\u0007e2e-user@m1-session-host $ ",
              ].join(""));
            } else if (/^(exit|logout)$/iu.test(command)) {
              record("shell.command.exit");
              output.push("logout\r\n");
              output.close();
            } else {
              output.push(`command not found: ${command.slice(0, 80)}\r\ne2e-user@m1-session-host $ `);
            }
          }
        },
        async resize() {
          record("shell.resize");
        },
        async close() {
          record("shell.close");
          output.close();
        },
      };
    },
    async getVersion() {
      record("getVersion");
      return {
        Major: 1,
        Minor: 7,
        Patch: 99,
        Commit: "e2e-fixture-build",
        Dirty: true,
        CompiledAt: "2026-08-09T00:00:00Z",
        OS: process.platform,
        Arch: process.arch,
      };
    },
    async jobs() {
      record("jobs");
      return jobs.map((job) => ({ ...job, Domains: [...job.Domains] }));
    },
    async startPortForward(sessionId, options) {
      record("startPortForward");
      requireSession(sessionId);
      const id = randomUUID();
      const state = new BehaviorSubject<LocalForwardState>(localForwardState("listening"));
      const connection = new Subject<never>();
      let current = state.value;
      const subscription = state.subscribe((next) => { current = next; });
      const forward: PortForward = {
        id,
        sessionId,
        bind: { ...options.bind, port: options.bind.port === 0 ? nextEphemeralPort++ : options.bind.port },
        target: { ...options.target },
        get state() { return current; },
        state$: state.asObservable(),
        connection$: connection.asObservable(),
        async close() {
          if (!portForwards.has(id)) return;
          record("stopPortForward");
          current = localForwardState("closed", "requested");
          state.next(current);
          state.complete();
          connection.complete();
          subscription.unsubscribe();
          portForwards.delete(id);
        },
      };
      portForwards.set(id, forward);
      return forward;
    },
    listPortForwards() {
      record("listPortForwards");
      return Object.freeze([...portForwards.values()]);
    },
    async stopPortForward(id) {
      await portForwards.get(id)?.close();
    },
    async startSocks5Proxy(sessionId, options) {
      record("startSocks5Proxy");
      requireSession(sessionId);
      const id = `socks5-${randomUUID()}`;
      const state = new BehaviorSubject<LocalForwardState>(localForwardState("listening"));
      const connection = new Subject<never>();
      let current = state.value;
      const subscription = state.subscribe((next) => { current = next; });
      const proxy: Socks5Proxy = {
        id,
        sessionId,
        bind: { ...options.bind, port: options.bind.port === 0 ? nextEphemeralPort++ : options.bind.port },
        get state() { return current; },
        state$: state.asObservable(),
        connection$: connection.asObservable(),
        async close() {
          if (!socks5Proxies.has(id)) return;
          record("stopSocks5Proxy");
          current = localForwardState("closed", "requested");
          state.next(current);
          state.complete();
          connection.complete();
          subscription.unsubscribe();
          socks5Proxies.delete(id);
        },
      };
      socks5Proxies.set(id, proxy);
      return proxy;
    },
    listSocks5Proxies() {
      record("listSocks5Proxies");
      return Object.freeze([...socks5Proxies.values()]);
    },
    async stopSocks5Proxy(id) {
      await socks5Proxies.get(id)?.close();
    },
    async startReversePortForward(sessionId, options) {
      record("startReversePortForward");
      requireSession(sessionId);
      const id = nextReverseListenerId++;
      const info: ReversePortForwardInfo = {
        id,
        sessionId,
        bind: { ...options.bind },
        target: { ...options.target },
      };
      reversePortForwards.set(id, info);
      const state = new BehaviorSubject<ReversePortForwardState>({ status: "listening" });
      let current = state.value;
      const subscription = state.subscribe((next) => { current = next; });
      const forward: ReversePortForward = {
        ...info,
        bind: info.bind!,
        target: info.target!,
        get state() { return current; },
        state$: state.asObservable(),
        async refresh() { return current; },
        async close() {
          if (!reversePortForwards.has(id)) return;
          record("stopReversePortForward");
          reversePortForwards.delete(id);
          current = { status: "stopped", reason: "requested" };
          state.next(current);
          state.complete();
          subscription.unsubscribe();
        },
      };
      return forward;
    },
    async listReversePortForwards(sessionId) {
      record("listReversePortForwards");
      requireSession(sessionId);
      return Object.freeze([...reversePortForwards.values()].filter((forward) => forward.sessionId === sessionId));
    },
    async stopReversePortForward(sessionId, listenerId) {
      record("stopReversePortForward");
      requireSession(sessionId);
      const current = reversePortForwards.get(listenerId);
      if (current?.sessionId === sessionId) reversePortForwards.delete(listenerId);
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
        Operators: overviewPivotFixture ? [
          { Name: config.operator, Online: true },
          { Name: "overview-online-observer", Online: true },
          { Name: "overview-offline-observer", Online: false },
        ] : [
          { Name: config.operator, Online: true },
          { Name: "m1-read-only-observer", Online: true },
        ],
      });
    },
    async getSessions() {
      record("getSessions");
      if (registryLayoutFixture && advanceSessionCheckinOnNextRead) {
        advanceSessionCheckinOnNextRead = false;
        sessions = sessions.map((session) => ({
          ...session,
          LastCheckin: String(BigInt(session.LastCheckin) + 1n),
        }));
      }
      return clientpb.Sessions.create({ Sessions: sessions.map(cloneSession) });
    },
    async getPivotGraph() {
      record("getPivotGraph");
      return overviewPivotFixture ? seedOverviewPivotGraph(sessions) : clientpb.PivotGraph.create({ Children: [] });
    },
    async getExternalBuilders() {
      record("getExternalBuilders");
      return clientpb.Builders.create({ Builders: overviewPivotFixture ? [
        { Name: "overview-builder-linux", OperatorName: config.operator, GOOS: "linux", GOARCH: "amd64" },
        { Name: "overview-builder-windows", OperatorName: "overview-online-observer", GOOS: "windows", GOARCH: "amd64" },
      ] : [] });
    },
    async getCrackstations() {
      record("getCrackstations");
      return clientpb.Crackstations.create({ Crackstations: overviewPivotFixture ? [
        {
          Name: "overview-crackstation", HostUUID: "8fd48f35-c2c2-4d62-8584-8cd274486301",
          OperatorName: config.operator, GOOS: "linux", GOARCH: "amd64", Version: "fixture-1.0",
        },
        {
          Name: "overview-crackstation", HostUUID: "8fd48f35-c2c2-4d62-8584-8cd274486302",
          OperatorName: "overview-online-observer", GOOS: "darwin", GOARCH: "arm64", Version: "fixture-2.0",
        },
      ] : [] });
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
    async lootAll() {
      record("lootAll");
      return lootStore.map((loot) => clientpb.Loot.create({
        ...loot,
        File: loot.File ? { ...loot.File, Data: Buffer.alloc(0) } : undefined,
      }));
    },
    async lootAdd(loot) {
      record("lootAdd");
      const stored = clientpb.Loot.create({
        ...loot,
        ID: randomUUID(),
        Size: String(loot.File?.Data.byteLength ?? 0),
        File: loot.File ? { ...loot.File, Data: Buffer.from(loot.File.Data) } : undefined,
      });
      lootStore = [...lootStore, stored];
      eventSubject.next(fakeEvent("loot-added"));
      return clientpb.Loot.create({
        ...stored,
        File: stored.File ? { ...stored.File, Data: Buffer.from(stored.File.Data) } : undefined,
      });
    },
    async lootUpdate(loot) {
      record("lootUpdate");
      const stored = lootStore.find((candidate) => candidate.ID === loot.ID);
      if (!stored) throw new Error("Unknown deterministic loot");
      stored.Name = loot.Name;
      eventSubject.next(fakeEvent("loot-added"));
      return clientpb.Loot.create({ ...stored, File: undefined });
    },
    async lootRemove(lootId) {
      record("lootRemove");
      lootStore = lootStore.filter((loot) => loot.ID !== lootId);
      eventSubject.next(fakeEvent("loot-removed"));
    },
    async lootContent(lootId) {
      record("lootContent");
      const loot = lootStore.find((candidate) => candidate.ID === lootId);
      if (!loot) throw new Error("Unknown deterministic loot");
      return clientpb.Loot.create({
        ...loot,
        File: loot.File ? { ...loot.File, Data: Buffer.from(loot.File.Data) } : undefined,
      });
    },
    async credentialsAll() {
      record("credentialsAll");
      return credentialStore.map((credential) => clientpb.Credential.create(credential));
    },
    async credentialById(credentialId) {
      record("credentialById");
      const credential = credentialStore.find((candidate) => candidate.ID === credentialId);
      if (!credential) throw new Error("Unknown deterministic credential");
      return clientpb.Credential.create(credential);
    },
    async credentialAdd(credential) {
      record("credentialAdd");
      credentialStore = [...credentialStore, clientpb.Credential.create({ ...credential, ID: randomUUID() })];
    },
    async credentialRemove(credentialId) {
      record("credentialRemove");
      credentialStore = credentialStore.filter((credential) => credential.ID !== credentialId);
    },
    async credentialSniffHashType(hash) {
      record("credentialSniffHashType");
      if (/^[0-9a-f]{32}$/iu.test(hash)) return clientpb.HashType.MD5;
      return clientpb.HashType.INVALID;
    },
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
    async envBeacon(beaconId: string, name: string) {
      record("envBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconEnvTaskResult(name);
      return sliverpb.EnvInfo.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          66, sliverpb.EnvReq.encode(sliverpb.EnvReq.create({ Name: name, Request: fakeBeaconRequest(beaconId) })).finish(),
        )),
      });
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
    async currentTokenOwnerSession(sessionId: string) {
      recordM4("currentTokenOwnerSession");
      requireSession(sessionId);
      return sliverpb.CurrentTokenOwner.create({
        Output: "e2e-user",
        Response: response(false),
      });
    },
    async currentTokenOwnerBeacon(beaconId: string) {
      recordM4("currentTokenOwnerBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.CurrentTokenOwner.create({
        Output: "e2e-user",
        Response: response(false),
      });
      return sliverpb.CurrentTokenOwner.create({
        Response: queueTask(
          beaconId,
          "CurrentTokenOwnerReq",
          Buffer.from(sliverpb.CurrentTokenOwner.encode(completed).finish()),
        ),
      });
    },
    async whoamiBeacon(beaconId: string) {
      record("whoamiBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconWhoamiTaskResult();
      return sliverpb.CurrentTokenOwner.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          100, sliverpb.CurrentTokenOwnerReq.encode(sliverpb.CurrentTokenOwnerReq.create({ Request: fakeBeaconRequest(beaconId) })).finish(),
        )),
      });
    },
    async listEnvSession(sessionId: string) {
      record("listEnvSession");
      requireSession(sessionId);
      return environmentResponse("");
    },
    async revealEnvSession(sessionId: string, name: string) {
      record("revealEnvSession");
      requireSession(sessionId);
      return environmentResponse(name);
    },
    async ifconfigSession(sessionId: string) {
      record("ifconfigSession");
      requireSession(sessionId);
      return sliverpb.Ifconfig.create({
        NetInterfaces: [{
          Index: 1,
          Name: "lo0",
          MAC: "00:00:00:00:00:00",
          IPAddresses: ["127.0.0.1/8", "::1/128"],
        }, {
          Index: 7,
          Name: "en0",
          MAC: "02:00:00:00:00:07",
          IPAddresses: ["192.0.2.25/24"],
        }],
        Response: response(false),
      });
    },
    async ifconfigBeacon(beaconId: string) {
      record("ifconfigBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconIfconfigTaskResult();
      return sliverpb.Ifconfig.create({
        Response: queueTask(beaconId, fixture.description, fixture.result),
      });
    },
    async netstatSession(sessionId: string) {
      record("netstatSession");
      requireSession(sessionId);
      return sliverpb.Netstat.create({
        Entries: [{
          LocalAddr: { Ip: "192.0.2.25", Port: 41001 },
          RemoteAddr: { Ip: "198.51.100.8", Port: 31337 },
          SkState: "ESTABLISHED",
          UID: 501,
          Protocol: "tcp4",
          Process: fakeProcess(41001, "sliver-m2-session"),
        }],
        Response: response(false),
      });
    },
    async netstatBeacon(beaconId: string, options: { tcp: boolean; udp: boolean; ip4: boolean; ip6: boolean; listen: boolean }) {
      record("netstatBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconNetstatTaskResult();
      return sliverpb.Netstat.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          49, sliverpb.NetstatReq.encode(sliverpb.NetstatReq.create({
            TCP: options.tcp, UDP: options.udp, IP4: options.ip4, IP6: options.ip6,
            Listening: options.listen, Request: fakeBeaconRequest(beaconId),
          })).finish(),
        )),
      });
    },
    async pwdSession(sessionId: string) {
      record("pwdSession");
      requireSession(sessionId);
      return sliverpb.Pwd.create({ Path: "/Users/e2e/workspace", Response: response(false) });
    },
    async pwdBeacon(beaconId: string) {
      record("pwdBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconPwdTaskResult();
      return sliverpb.Pwd.create({
        Response: queueTask(beaconId, fixture.description, fixture.result),
      });
    },
    async mountBeacon(beaconId: string) {
      record("mountBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconMountTaskResult();
      return sliverpb.Mount.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          134, sliverpb.MountReq.encode(sliverpb.MountReq.create({ Request: fakeBeaconRequest(beaconId) })).finish(),
        )),
      });
    },
    async memfilesBeacon(beaconId: string) {
      record("memfilesBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconMemfilesTaskResult();
      return sliverpb.Ls.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          115, sliverpb.MemfilesListReq.encode(sliverpb.MemfilesListReq.create({ Request: fakeBeaconRequest(beaconId) })).finish(),
        )),
      });
    },
    async catBeacon(beaconId: string, path: string) {
      record("catBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconTextTaskResult(path, "deterministic BC-05 cat output\n");
      return sliverpb.Download.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, fakeBeaconDownloadRequest(beaconId, path, String(BEACON_TEXT_READ_PROBE_BYTES), "0")),
      });
    },
    async headBeacon(beaconId: string, path: string, options: { bytes?: number; lines?: number }) {
      record("headBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconTextTaskResult(path, "deterministic BC-05 head output\n");
      return sliverpb.Download.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, fakeBeaconDownloadRequest(
          beaconId, path,
          String(options.bytes ?? BEACON_TEXT_READ_PROBE_BYTES),
          String(options.lines ?? 0),
        )),
      });
    },
    async tailBeacon(beaconId: string, path: string, options: { bytes?: number; lines?: number }) {
      record("tailBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconTextTaskResult(path, "deterministic BC-05 tail output\n");
      return sliverpb.Download.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, fakeBeaconDownloadRequest(
          beaconId, path, String(-options.bytes!), "0",
        )),
      });
    },
    async grepBeacon(beaconId: string, options: { path: string; pattern: string; recursive: boolean; before: number; after: number }) {
      record("grepBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconGrepTaskResult(options.path, options.pattern);
      return sliverpb.Grep.create({
        Response: queueTask(beaconId, fixture.description, fixture.result, beaconTaskRequest(
          129, sliverpb.GrepReq.encode(sliverpb.GrepReq.create({
            Path: options.path,
            SearchPattern: options.pattern,
            Recursive: options.recursive,
            LinesBefore: options.before,
            LinesAfter: options.after,
            Request: fakeBeaconRequest(beaconId),
          })).finish(),
        )),
      });
    },
    async cdSession(sessionId: string, path: string) {
      record("cdSession");
      requireSession(sessionId);
      return sliverpb.Pwd.create({ Path: path, Response: response(false) });
    },
    async lsSession(sessionId: string, path: string) {
      record("lsSession");
      requireSession(sessionId);
      const requestedPath = path || "/Users/e2e/workspace";
      const files = requestedPath === "/Users/e2e/workspace"
        ? workspaceFiles
        : requestedPath === "/Users/e2e/workspace/projects"
          ? [fakeFile("readme.md", false, String(remoteFiles.get(`${requestedPath}/readme.md`)?.length ?? 0), "-rw-r--r--")]
          : [];
      return sliverpb.Ls.create({
        Path: requestedPath,
        Exists: true,
        Files: files.map((file) => ({ ...file })),
        timezone: "America/Los_Angeles",
        timezoneOffset: -420,
        Response: response(false),
      });
    },
    async lsBeacon(beaconId: string, path: string) {
      record("lsBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconLsTaskResult(path);
      return sliverpb.Ls.create({
        Response: queueTask(beaconId, fixture.description, fixture.result),
      });
    },
    async downloadFileSession(
      sessionId: string,
      path: string,
      options: { maxBytes?: number; fromEnd?: boolean } = {},
    ) {
      const maximumBytes = options.maxBytes ?? SESSION_WORKBENCH_MAX_ARTIFACT_BYTES;
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > SESSION_WORKBENCH_MAX_ARTIFACT_BYTES) {
        throw new Error(`Artifact byte limit exceeds ${SESSION_WORKBENCH_MAX_ARTIFACT_BYTES} bytes`);
      }
      record("downloadFileSession");
      requireSession(sessionId);
      const source = remoteFiles.get(path);
      if (!source) {
        return sliverpb.Download.create({
          Path: path,
          Exists: false,
          IsDir: false,
          Data: Buffer.alloc(0),
          Response: response(false),
        });
      }
      const start = options.fromEnd ? Math.max(0, source.length - maximumBytes) : 0;
      const stop = options.fromEnd ? source.length : Math.min(source.length, maximumBytes);
      return sliverpb.Download.create({
        Path: path,
        Exists: true,
        IsDir: false,
        Start: String(start),
        Stop: String(stop),
        Data: Buffer.from(source.subarray(start, stop)),
        ReadFiles: 1,
        Response: response(false),
      });
    },
    async uploadSession(
      sessionId: string,
      path: string,
      data: Buffer,
      options: { isIOC?: boolean; fileName?: string; isDirectory?: boolean; overwrite?: boolean } = {},
    ) {
      record("uploadSession");
      requireSession(sessionId);
      if (options.isDirectory) throw new Error("The deterministic fake accepts only bounded file uploads");
      const destination = options.fileName ? `${path.replace(/\/$/u, "")}/${options.fileName}` : path;
      const ownedCopy = Buffer.from(data);
      state.uploads.push({
        path,
        fileName: options.fileName ?? "",
        destination,
        size: ownedCopy.length,
        sha256: createHash("sha256").update(ownedCopy).digest("hex"),
        isIOC: options.isIOC ?? false,
        isDirectory: options.isDirectory ?? false,
        overwrite: options.overwrite ?? false,
      });
      remoteFiles.set(destination, ownedCopy);
      upsertWorkspaceFile(destination, ownedCopy.length);
      return sliverpb.Upload.create({
        Path: destination,
        WrittenFiles: 1,
        UnwriteableFiles: 0,
        Response: response(false),
      });
    },
    async grepSession(sessionId: string, path: string, pattern: string) {
      record("grepSession");
      requireSession(sessionId);
      const matches = pattern
        ? Object.fromEntries(Array.from({ length: 105 }, (_, index) => [
            `${path.replace(/\/$/u, "")}/match-${String(index + 1).padStart(3, "0")}.txt`,
            {
              FileResults: [{
                LineNumber: String(index + 1),
                Positions: [{ Start: 0, End: pattern.length }],
                Line: `${pattern} appears in deterministic M2 test data ${index + 1}`,
                LinesBefore: index === 0 ? [] : [`before ${index + 1}`],
                LinesAfter: index === 104 ? [] : [`after ${index + 1}`],
              }],
              IsBinary: false,
            },
          ]))
        : {};
      return sliverpb.Grep.create({
        SearchPathAbsolute: path,
        Results: matches,
        Response: response(false),
      });
    },
    async cpSession(sessionId: string, source: string, destination: string) {
      record("cpSession");
      requireSession(sessionId);
      const sourceData = remoteFiles.get(source);
      if (sourceData) {
        const copy = Buffer.from(sourceData);
        remoteFiles.set(destination, copy);
        upsertWorkspaceFile(destination, copy.length);
      }
      return sliverpb.Cp.create({
        Src: source,
        Dst: destination,
        BytesWritten: String(sourceData?.length ?? 0),
        Response: response(false),
      });
    },
    async mvSession(sessionId: string, source: string, destination: string) {
      record("mvSession");
      requireSession(sessionId);
      const sourceData = remoteFiles.get(source);
      if (sourceData) {
        remoteFiles.delete(source);
        remoteFiles.set(destination, sourceData);
        removeWorkspaceFile(source);
        upsertWorkspaceFile(destination, sourceData.length);
      }
      return sliverpb.Mv.create({ Src: source, Dst: destination, Response: response(false) });
    },
    async mkdirSession(sessionId: string, path: string) {
      record("mkdirSession");
      requireSession(sessionId);
      const name = path.split("/").filter(Boolean).at(-1) ?? "new-folder";
      if (!workspaceFiles.some((file) => file.Name === name)) {
        workspaceFiles = [...workspaceFiles, fakeFile(name, true, "0", "drwxr-xr-x")];
      }
      return sliverpb.Mkdir.create({ Path: path, Response: response(false) });
    },
    async rmSession(sessionId: string, path: string) {
      record("rmSession");
      requireSession(sessionId);
      const name = path.split("/").filter(Boolean).at(-1) ?? "";
      workspaceFiles = workspaceFiles.filter((file) => file.Name !== name);
      remoteFiles.delete(path);
      return sliverpb.Rm.create({ Path: path, Response: response(false) });
    },
    async mountsSession(sessionId: string) {
      record("mountsSession");
      requireSession(sessionId);
      return sliverpb.Mount.create({
        Info: [{
          VolumeName: "disk3s1",
          VolumeType: "apfs",
          MountPoint: "/",
          Label: "Macintosh HD",
          FileSystem: "apfs",
          UsedSpace: "1048576",
          FreeSpace: "2097152",
          TotalSpace: "3145728",
          MountOptions: "rw",
        }],
        Response: response(false),
      });
    },
    async memfilesListSession(sessionId: string) {
      record("memfilesListSession");
      requireSession(sessionId);
      return sliverpb.Ls.create({
        Path: "/proc/self/fd",
        Exists: true,
        Files: memoryFiles.map((file) => ({ ...file })),
        timezone: "America/Los_Angeles",
        timezoneOffset: -420,
        Response: response(false),
      });
    },
    async memfilesAddSession(sessionId: string) {
      record("memfilesAddSession");
      requireSession(sessionId);
      const fd = String(73 + memoryFiles.length);
      memoryFiles = [...memoryFiles, fakeFile(fd, false, "0", "-rw-------", `m2-memory-${fd}.bin`)];
      return sliverpb.MemfilesAdd.create({ Fd: fd, Response: response(false) });
    },
    async memfilesRmSession(sessionId: string, fd: string) {
      record("memfilesRmSession");
      requireSession(sessionId);
      memoryFiles = memoryFiles.filter((file) => file.Name !== fd);
      return sliverpb.MemfilesRm.create({ Fd: fd, Response: response(false) });
    },
    async chmodSession(sessionId: string, path: string, fileMode: string) {
      record("chmodSession");
      requireSession(sessionId);
      const name = remoteBasename(path);
      workspaceFiles = workspaceFiles.map((file) => file.Name === name ? { ...file, Mode: fileMode } : file);
      return sliverpb.Chmod.create({ Path: path, Response: response(false) });
    },
    async chownSession(sessionId: string, path: string, uid: string, gid: string) {
      record("chownSession");
      requireSession(sessionId);
      const name = remoteBasename(path);
      workspaceFiles = workspaceFiles.map((file) => file.Name === name ? { ...file, Uid: uid, Gid: gid } : file);
      return sliverpb.Chown.create({ Path: path, Response: response(false) });
    },
    async chtimesSession(sessionId: string, path: string, _accessTime: string, modificationTime: string) {
      record("chtimesSession");
      requireSession(sessionId);
      const name = remoteBasename(path);
      workspaceFiles = workspaceFiles.map((file) =>
        file.Name === name ? { ...file, ModTime: modificationTime } : file);
      return sliverpb.Chtimes.create({ Path: path, Response: response(false) });
    },
    async psSession(sessionId: string) {
      record("psSession");
      requireSession(sessionId);
      return sliverpb.Ps.create({
        Processes: processInventory.map((process) => ({ ...process, CmdLine: [...process.CmdLine] })),
        Response: response(false),
      });
    },
    async psBeacon(beaconId: string, fullInfo: boolean) {
      record("psBeacon");
      requireBeacon(beaconId);
      const fixture = fakeBeaconPsTaskResult(fullInfo);
      return sliverpb.Ps.create({
        Response: queueTask(beaconId, fixture.description, fixture.result),
      });
    },
    async terminateSessionProcess() { return unsupported("terminateSessionProcess"); },
    async processDumpSession(sessionId: string, pid: number) {
      record("processDumpSession");
      requireSession(sessionId);
      return sliverpb.ProcessDump.create({
        Data: Buffer.from(`deterministic process dump for ${pid}`, "utf8"),
        Response: response(false),
      });
    },
    async screenshotSession(sessionId: string) {
      record("screenshotSession");
      requireSession(sessionId);
      return sliverpb.Screenshot.create({
        Data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII=", "base64"),
        Response: response(false),
      });
    },
    async servicesSession() { return unsupported("servicesSession"); },
    async serviceDetailSession() { return unsupported("serviceDetailSession"); },
    async startServiceSession() { return unsupported("startServiceSession"); },
    async stopServiceSession() { return unsupported("stopServiceSession"); },
    async registryReadSession(sessionId: string, _hive: string, _path: string, key: string) {
      if (!registryLayoutFixture) return unsupported("registryReadSession");
      record("registryReadSession");
      requireSession(sessionId);
      return sliverpb.RegistryRead.create({
        Value: `registry-layout-data-${key || "default"}`,
        Binary: Buffer.alloc(0),
        Type: sliverpb.RegistryType.String,
        Response: response(false),
      });
    },
    async registryListSubkeysSession(sessionId: string, _hive: string, path: string) {
      if (!registryLayoutFixture) return unsupported("registryListSubkeysSession");
      record("registryListSubkeysSession");
      requireSession(sessionId);
      return sliverpb.RegistrySubKeyList.create({
        Subkeys: path === "" ? registryLayoutNames("E2EKey") : [],
        Response: response(false),
      });
    },
    async registryListValuesSession(sessionId: string, _hive: string, path: string) {
      if (!registryLayoutFixture) return unsupported("registryListValuesSession");
      record("registryListValuesSession");
      requireSession(sessionId);
      return sliverpb.RegistryValuesList.create({
        ValueNames: path === "" ? registryLayoutNames("E2EValue") : [],
        Response: response(false),
      });
    },
    async registryReadHiveSession() { return unsupported("registryReadHiveSession"); },
    async registryWriteSession() { return unsupported("registryWriteSession"); },
    async registryCreateKeySession() { return unsupported("registryCreateKeySession"); },
    async registryDeleteKeySession() { return unsupported("registryDeleteKeySession"); },
    async executeSession(sessionId, options, timeoutSeconds) {
      recordM4("executeSession");
      requireSession(sessionId);
      if (registryLayoutFixture) {
        testState.processCalls.push({
          sessionId,
          options: { ...options, args: [...(options.args ?? [])], env: { ...options.env } },
          timeoutSeconds,
        });
        if (holdNextProcessResponse) {
          holdNextProcessResponse = false;
          await new Promise<void>((resolve) => {
            heldProcessResponse = resolve;
            testState.processResponseHeld = true;
          });
          testState.processResponseHeld = false;
        }
      }
      return sliverpb.Execute.create({
        Status: 0,
        Stdout: options.background || options.output === false
          ? Buffer.alloc(0)
          : Buffer.from("deterministic M4 process stdout\n", "utf8"),
        Stderr: Buffer.alloc(0),
        Pid: 43_001,
        Response: response(false),
      });
    },
    async executeBeacon(beaconId, options) {
      recordM4("executeBeacon");
      const beacon = requireBeacon(beaconId);
      if (beaconExecutionFixture) {
        testState.beaconProcessCalls.push({
          beaconId,
          options: { ...options, args: [...(options.args ?? [])], env: { ...options.env } },
        });
      }
      const completed = sliverpb.Execute.create({
        Status: 0,
        Stdout: options.background || options.output === false
          ? Buffer.alloc(0)
          : Buffer.from("deterministic M4 process stdout\n", "utf8"),
        Stderr: beaconExecutionFixture && !options.background && options.output !== false
          ? Buffer.from("deterministic beacon process stderr\n", "utf8")
          : Buffer.alloc(0),
        Pid: 43_002,
        Response: response(false),
      });
      return sliverpb.Execute.create({
        Response: queueTask(
          beaconId,
          beaconExecutionFixture && beacon.OS === "windows" ? "ExecuteWindowsReq" : "ExecuteReq",
          Buffer.from(sliverpb.Execute.encode(completed).finish()),
        ),
      });
    },
    async callBofSession(sessionId, object, argumentsBuffer, entrypoint, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("callBofSession");
      recordM4("callBofSession");
      requireSession(sessionId);
      return fakeBofResponse("session", sessionId, object, argumentsBuffer, entrypoint, timeoutSeconds);
    },
    async callBofBeacon(beaconId, object, argumentsBuffer, entrypoint, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("callBofBeacon");
      recordM4("callBofBeacon");
      requireBeacon(beaconId);
      const completed = fakeBofResponse("beacon", beaconId, object, argumentsBuffer, entrypoint, timeoutSeconds);
      return sliverpb.CallExtension.create({
        Response: queueTask(beaconId, "CallExtensionReq", Buffer.from(sliverpb.CallExtension.encode(completed).finish())),
      });
    },
    async registerBofLoaderSession(sessionId, loader, init, os, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("registerBofLoaderSession");
      recordM4("registerBofLoaderSession");
      requireSession(sessionId);
      state.legacyBofCalls.push({
        phase: "register", targetMode: "session", targetId: sessionId,
        loaderHex: loader.toString("hex"), init, os, timeoutSeconds,
      });
      return sliverpb.RegisterExtension.create({ Response: response(false) });
    },
    async registerBofLoaderBeacon(beaconId, loader, init, os, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("registerBofLoaderBeacon");
      recordM4("registerBofLoaderBeacon");
      requireBeacon(beaconId);
      state.legacyBofCalls.push({
        phase: "register", targetMode: "beacon", targetId: beaconId,
        loaderHex: loader.toString("hex"), init, os, timeoutSeconds,
      });
      const completed = sliverpb.RegisterExtension.create({ Response: response(false) });
      return sliverpb.RegisterExtension.create({
        Response: queueTask(beaconId, "RegisterExtensionReq", Buffer.from(sliverpb.RegisterExtension.encode(completed).finish())),
      });
    },
    async callLegacyBofSession(sessionId, loader, argumentsBuffer, exportName, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("callLegacyBofSession");
      recordM4("callLegacyBofSession");
      requireSession(sessionId);
      state.legacyBofCalls.push({
        phase: "call", targetMode: "session", targetId: sessionId,
        loaderHex: loader.toString("hex"), argumentsHex: argumentsBuffer.toString("hex"),
        exportName, timeoutSeconds,
      });
      return sliverpb.CallExtension.create({
        Output: Buffer.from("deterministic legacy BOF stdout\n", "utf8"),
        Response: response(false),
      });
    },
    async callLegacyBofBeacon(beaconId, loader, argumentsBuffer, exportName, timeoutSeconds) {
      if (!bofExecutionFixture) return unsupported("callLegacyBofBeacon");
      recordM4("callLegacyBofBeacon");
      requireBeacon(beaconId);
      state.legacyBofCalls.push({
        phase: "call", targetMode: "beacon", targetId: beaconId,
        loaderHex: loader.toString("hex"), argumentsHex: argumentsBuffer.toString("hex"),
        exportName, timeoutSeconds,
      });
      const completed = sliverpb.CallExtension.create({
        Output: Buffer.from("deterministic legacy BOF stdout\n", "utf8"),
        Response: response(false),
      });
      return sliverpb.CallExtension.create({
        Response: queueTask(beaconId, "CallExtensionReq", Buffer.from(sliverpb.CallExtension.encode(completed).finish())),
      });
    },
    async executeChildrenSession(sessionId) {
      recordM4("executeChildrenSession");
      requireSession(sessionId);
      return sliverpb.ExecuteChildren.create({
        Children: fakeExecutionChildren(),
        Response: response(false),
      });
    },
    async executeChildrenBeacon(beaconId) {
      recordM4("executeChildrenBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.ExecuteChildren.create({
        Children: beaconBC03Fixture ? fakePagedExecutionChildren() : fakeExecutionChildren(),
        Response: response(false),
      });
      return sliverpb.ExecuteChildren.create({
        Response: queueTask(
          beaconId,
          "ExecuteChildrenReq",
          Buffer.from(sliverpb.ExecuteChildren.encode(completed).finish()),
        ),
      });
    },
    async executeAssemblySession(sessionId, assembly, options, timeoutSeconds) {
      recordM4("executeAssemblySession");
      requireSession(sessionId);
      inspectArtifact(assembly, "Assembly");
      testState.assemblyCalls.push({
        targetMode: "session", targetId: sessionId,
        assemblySha256: createHash("sha256").update(assembly).digest("hex"),
        options: { ...options, arguments: [...(options?.arguments ?? [])], processArgs: [...(options?.processArgs ?? [])] },
        timeoutSeconds,
      });
      return sliverpb.ExecuteAssembly.create({
        Output: Buffer.from("deterministic M4 assembly output\n", "utf8"),
        Response: response(false),
      });
    },
    async executeAssemblyBeacon(beaconId, assembly, options, timeoutSeconds) {
      recordM4("executeAssemblyBeacon");
      requireBeacon(beaconId);
      inspectArtifact(assembly, "Assembly");
      testState.assemblyCalls.push({
        targetMode: "beacon", targetId: beaconId,
        assemblySha256: createHash("sha256").update(assembly).digest("hex"),
        options: { ...options, arguments: [...(options?.arguments ?? [])], processArgs: [...(options?.processArgs ?? [])] },
        timeoutSeconds,
      });
      const completed = sliverpb.ExecuteAssembly.create({
        Output: Buffer.from("deterministic M4 assembly output\n", "utf8"),
        Response: response(false),
      });
      return sliverpb.ExecuteAssembly.create({
        Response: queueTask(
          beaconId,
          options?.inProcess ? "InvokeInProcExecuteAssemblyReq" : "InvokeExecuteAssemblyReq",
          Buffer.from(sliverpb.ExecuteAssembly.encode(completed).finish()),
        ),
      });
    },
    async executeShellcodeSession(sessionId, shellcode) {
      recordM4("executeShellcodeSession");
      requireSession(sessionId);
      inspectArtifact(shellcode, "Shellcode");
      return sliverpb.Task.create({ Response: response(false) });
    },
    async executeShellcodeBeacon(beaconId, shellcode) {
      recordM4("executeShellcodeBeacon");
      requireBeacon(beaconId);
      inspectArtifact(shellcode, "Shellcode");
      const completed = sliverpb.Task.create({ Response: response(false) });
      return sliverpb.Task.create({
        Response: queueTask(
          beaconId,
          "TaskReq",
          Buffer.from(sliverpb.Task.encode(completed).finish()),
        ),
      });
    },
    async sideloadSession(sessionId, data) {
      recordM4("sideloadSession");
      requireSession(sessionId);
      inspectArtifact(data, "Sideload library");
      return sliverpb.Sideload.create({
        Result: "deterministic M4 sideload output\n",
        Response: response(false),
      });
    },
    async sideloadBeacon(beaconId, data) {
      recordM4("sideloadBeacon");
      requireBeacon(beaconId);
      inspectArtifact(data, "Sideload library");
      const completed = sliverpb.Sideload.create({
        Result: "deterministic M4 sideload output\n",
        Response: response(false),
      });
      return sliverpb.Sideload.create({
        Response: queueTask(
          beaconId,
          "SideloadReq",
          Buffer.from(sliverpb.Sideload.encode(completed).finish()),
        ),
      });
    },
    async spawnDllSession(sessionId, data) {
      recordM4("spawnDllSession");
      requireSession(sessionId);
      inspectArtifact(data, "Reflective DLL");
      return sliverpb.SpawnDll.create({
        Result: "deterministic M4 reflective DLL output\n",
        Response: response(false),
      });
    },
    async spawnDllBeacon(beaconId, data) {
      recordM4("spawnDllBeacon");
      requireBeacon(beaconId);
      inspectArtifact(data, "Reflective DLL");
      const completed = sliverpb.SpawnDll.create({
        Result: "deterministic M4 reflective DLL output\n",
        Response: response(false),
      });
      return sliverpb.SpawnDll.create({
        Response: queueTask(
          beaconId,
          "SpawnDllReq",
          Buffer.from(sliverpb.SpawnDll.encode(completed).finish()),
        ),
      });
    },
    async getShellcodeEncoderMap() {
      recordM4("getShellcodeEncoderMap");
      return clientpb.ShellcodeEncoderMap.create({
        Encoders: {
          amd64: {
            Encoders: { xor: clientpb.ShellcodeEncoder.XOR },
            Descriptions: { xor: "Deterministic XOR encoder" },
          },
        },
      });
    },
    async migrateSession(sessionId, options) {
      recordM4("migrateSession");
      requireSession(sessionId);
      return sliverpb.Migrate.create({
        Success: true,
        Pid: options.pid || 43_010,
        Response: response(false),
      });
    },
    async migrateBeacon(beaconId, options) {
      recordM4("migrateBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.Migrate.create({
        Success: true,
        Pid: options.pid || 43_011,
        Response: response(false),
      });
      return sliverpb.Migrate.create({
        Response: queueTask(
          beaconId,
          "InvokeMigrateReq",
          Buffer.from(sliverpb.Migrate.encode(completed).finish()),
        ),
      });
    },
    async msfSession(sessionId) {
      recordM4("msfSession");
      requireSession(sessionId);
      return sliverpb.Task.create({ Response: response(false) });
    },
    async msfBeacon(beaconId) {
      recordM4("msfBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.Task.create({ Response: response(false) });
      return sliverpb.Task.create({
        Response: queueTask(
          beaconId,
          "TaskReq",
          Buffer.from(sliverpb.Task.encode(completed).finish()),
        ),
      });
    },
    async msfRemoteSession(sessionId) {
      recordM4("msfRemoteSession");
      requireSession(sessionId);
      return sliverpb.Task.create({ Response: response(false) });
    },
    async msfRemoteBeacon(beaconId) {
      recordM4("msfRemoteBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.Task.create({ Response: response(false) });
      return sliverpb.Task.create({
        Response: queueTask(
          beaconId,
          "TaskReq",
          Buffer.from(sliverpb.Task.encode(completed).finish()),
        ),
      });
    },
    async runSshSession(sessionId, options) {
      recordM4("runSshSession");
      requireSession(sessionId);
      inspectCredentialText(options.password, "SSH password");
      inspectArtifact(options.privateKey, "SSH private key", 1 * 1_024 * 1_024, false);
      inspectArtifact(options.kerberosKeytab, "Kerberos keytab", 4 * 1_024 * 1_024, false);
      inspectCredentialBuffer(options.privateKey, "SSH private key", 1 * 1_024 * 1_024);
      inspectCredentialBuffer(options.kerberosKeytab, "Kerberos keytab", 4 * 1_024 * 1_024);
      return sliverpb.SSHCommand.create({
        StdOut: "deterministic M4 SSH stdout\n",
        StdErr: "",
        Response: response(false),
      });
    },
    async runAsSession(sessionId, options) {
      recordM4("runAsSession");
      requireSession(sessionId);
      inspectCredentialText(options.password, "Run-as password");
      return sliverpb.RunAs.create({
        Output: "deterministic M4 run-as output\n",
        Response: response(false),
      });
    },
    async runAsBeacon(beaconId, options) {
      recordM4("runAsBeacon");
      requireBeacon(beaconId);
      inspectCredentialText(options.password, "Run-as password");
      const completed = sliverpb.RunAs.create({
        Output: "deterministic M4 run-as output\n",
        Response: response(false),
      });
      return sliverpb.RunAs.create({
        Response: queueTask(
          beaconId,
          "RunAsReq",
          Buffer.from(sliverpb.RunAs.encode(completed).finish()),
        ),
      });
    },
    async makeTokenSession(sessionId, options) {
      recordM4("makeTokenSession");
      requireSession(sessionId);
      inspectCredentialText(options.password, "Token password", true);
      return sliverpb.MakeToken.create({ Response: response(false) });
    },
    async makeTokenBeacon(beaconId, options) {
      recordM4("makeTokenBeacon");
      requireBeacon(beaconId);
      inspectCredentialText(options.password, "Token password", true);
      const completed = sliverpb.MakeToken.create({ Response: response(false) });
      return sliverpb.MakeToken.create({
        Response: queueTask(
          beaconId,
          "MakeTokenReq",
          Buffer.from(sliverpb.MakeToken.encode(completed).finish()),
        ),
      });
    },
    async impersonateSession(sessionId) {
      recordM4("impersonateSession");
      requireSession(sessionId);
      return sliverpb.Impersonate.create({ Response: response(false) });
    },
    async impersonateBeacon(beaconId) {
      recordM4("impersonateBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.Impersonate.create({ Response: response(false) });
      return sliverpb.Impersonate.create({
        Response: queueTask(
          beaconId,
          "ImpersonateReq",
          Buffer.from(sliverpb.Impersonate.encode(completed).finish()),
        ),
      });
    },
    async revToSelfSession(sessionId) {
      recordM4("revToSelfSession");
      requireSession(sessionId);
      return sliverpb.RevToSelf.create({ Response: response(false) });
    },
    async revToSelfBeacon(beaconId) {
      recordM4("revToSelfBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.RevToSelf.create({ Response: response(false) });
      return sliverpb.RevToSelf.create({
        Response: queueTask(
          beaconId,
          "RevToSelfReq",
          Buffer.from(sliverpb.RevToSelf.encode(completed).finish()),
        ),
      });
    },
    async getSystemSession(sessionId) {
      recordM4("getSystemSession");
      requireSession(sessionId);
      return sliverpb.GetSystem.create({ Response: response(false) });
    },
    async getPrivsSession(sessionId) {
      recordM4("getPrivsSession");
      requireSession(sessionId);
      return sliverpb.GetPrivs.create({
        PrivInfo: fakePrivileges(),
        ProcessIntegrity: "High",
        ProcessName: "sliver-m4-session.exe",
        Response: response(false),
      });
    },
    async getPrivsBeacon(beaconId) {
      recordM4("getPrivsBeacon");
      requireBeacon(beaconId);
      const completed = sliverpb.GetPrivs.create({
        PrivInfo: beaconBC03Fixture ? fakePagedPrivileges() : fakePrivileges(),
        ProcessIntegrity: "High",
        ProcessName: "sliver-m4-beacon.exe",
        Response: response(false),
      });
      return sliverpb.GetPrivs.create({
        Response: queueTask(
          beaconId,
          "GetPrivsReq",
          Buffer.from(sliverpb.GetPrivs.encode(completed).finish()),
        ),
      });
    },
    async backdoorSession(sessionId) {
      recordM4("backdoorSession");
      requireSession(sessionId);
      return clientpb.Backdoor.create({ Response: response(false) });
    },
    async hijackDllSession(sessionId, options) {
      recordM4("hijackDllSession");
      requireSession(sessionId);
      inspectArtifact(options.referenceDll, "DLL hijack reference DLL", 64 * 1_024 * 1_024, false);
      inspectArtifact(options.targetDll, "DLL hijack target DLL", 64 * 1_024 * 1_024, false);
      return clientpb.DllHijack.create({ Response: response(false) });
    },
    async startRemoteServiceSession(sessionId) {
      recordM4("startRemoteServiceSession");
      requireSession(sessionId);
      testState.m4Audit.remoteServiceStarts += 1;
      return sliverpb.ServiceInfo.create({ Response: response(false) });
    },
    async removeRemoteServiceSession(sessionId) {
      recordM4("removeRemoteServiceSession");
      requireSession(sessionId);
      testState.m4Audit.remoteServiceRemovals += 1;
      return sliverpb.ServiceInfo.create({ Response: response(false) });
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
    async reconfigureBeacon(
      beaconId: string,
      options: Parameters<SliverClientAdapter["reconfigureBeacon"]>[1],
      timeoutSeconds?: number,
    ) {
      record("reconfigureBeacon");
      requireBeacon(beaconId);
      testState.reconfigureRequests.push({ beaconId, options: { ...options }, timeoutSeconds });
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
    async fetchBeaconTaskContent(beaconId: string, taskId: string, description: string) {
      record("fetchBeaconTaskContent");
      const task = tasks.get(taskId);
      if (!task || task.BeaconID !== beaconId || task.Description !== description) {
        throw new Error("Unknown fake beacon task");
      }
      return cloneTask(task);
    },
    async fetchBofBeaconTask(beaconId: string, taskId: string, description: "CallExtensionReq" | "RegisterExtensionReq") {
      record("fetchBofBeaconTask");
      const task = tasks.get(taskId);
      if (!task || task.BeaconID !== beaconId || task.Description !== description) {
        throw new Error("Unknown fake BOF beacon task");
      }
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

  function upsertWorkspaceFile(path: string, size: number): void {
    if (remoteParent(path) !== "/Users/e2e/workspace") return;
    const name = remoteBasename(path);
    const next = fakeFile(name, false, String(size), "-rw-r--r--");
    workspaceFiles = [...workspaceFiles.filter((file) => file.Name !== name), next];
  }

  function removeWorkspaceFile(path: string): void {
    if (remoteParent(path) !== "/Users/e2e/workspace") return;
    const name = remoteBasename(path);
    workspaceFiles = workspaceFiles.filter((file) => file.Name !== name);
  }

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

  function fakeBeaconRequest(beaconId: string) {
    return {
      Async: true,
      BeaconID: beaconId,
      SessionID: "",
      Timeout: "60000000000",
    };
  }

  function beaconTaskRequest(type: number, data: Uint8Array): Buffer {
    return Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
      Type: type,
      Data: Buffer.from(data),
    })).finish());
  }

  function fakeBeaconDownloadRequest(beaconId: string, path: string, maxBytes: string, maxLines: string): Buffer {
    return beaconTaskRequest(7, sliverpb.DownloadReq.encode(sliverpb.DownloadReq.create({
      Path: path,
      RestrictedToFile: true,
      Recurse: false,
      MaxBytes: maxBytes,
      MaxLines: maxLines,
      Request: fakeBeaconRequest(beaconId),
    })).finish());
  }

  function queueTask(beaconId: string, description: string, result: Buffer, request?: Buffer) {
    const id = `m1_task_${nextTaskId++}`;
    const createdAt = epochSeconds();
    const task = clientpb.BeaconTask.create({
      ID: id,
      BeaconID: beaconId,
      CreatedAt: createdAt,
      State: "pending",
      SentAt: "0",
      CompletedAt: "0",
      Request: request ?? Buffer.from("FAKE_TASK_REQUEST_SECRET_M1_DO_NOT_RENDER"),
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

function seedOverviewEgressSessions(): clientpb.Session[] {
  return [
    { name: "alpha", address: "198.51.100.10:41001" },
    { name: "beta", address: "198.51.100.10:42001" },
    { name: "gamma", address: "203.0.113.20:41001" },
  ].map(({ name, address }) => ({
    ...seedSession(`egress-${name}`),
    ID: `overview_egress_${name}`,
    Hostname: `overview-egress-${name}`,
    UUID: `overview-egress-${name}-host-id`,
    RemoteAddress: address,
  }));
}

function seedOverviewPivotSessions(): clientpb.Session[] {
  return ["relay-a", "relay-b", "relay-c", "deepest", "branch"].map((name, index) => ({
    ...seedSession(name),
    ID: `overview_${name}`,
    Hostname: `overview-${name}`,
    UUID: `overview-${name}-host-id`,
    Transport: index === 0 ? "mtls" : "tcppivot",
    ActiveC2: index === 0 ? "mtls://192.0.2.1:31337" : `tcppivot://192.0.2.${index + 1}:31337`,
  }));
}

function seedOverviewPivotGraph(sessions: readonly clientpb.Session[]): clientpb.PivotGraph {
  const withSession = (peerId: string, name: string, children: clientpb.PivotGraphEntry[] = []): clientpb.PivotGraphEntry => {
    const session = sessions.find((candidate) => candidate.ID === `overview_${name}`);
    if (!session) throw new Error("Missing synthetic Overview session");
    return clientpb.PivotGraphEntry.create({ PeerID: peerId, Name: name, Session: cloneSession(session), Children: children });
  };
  return clientpb.PivotGraph.create({
    Children: [withSession("101", "relay-a", [
      withSession("102", "relay-b", [
        clientpb.PivotGraphEntry.create({
          PeerID: "103",
          Name: "Sessionless relay",
          Children: [withSession("104", "relay-c", [withSession("105", "deepest")])],
        }),
        withSession("106", "branch"),
      ]),
    ])],
  });
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
    Capabilities: bofExecutionFixture ? "1" : "0",
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

function seedRegistryLayoutSession(name: string): clientpb.Session {
  const session = seedSession(name);
  return clientpb.Session.create({
    ...session,
    Hostname: "registry-layout-host",
    Username: "REGISTRY\\e2e-user",
    OS: "windows",
    Arch: "amd64",
    Filename: "C:\\ProgramData\\m1-session.exe",
  });
}

function registryLayoutNames(prefix: string): string[] {
  return Array.from(
    { length: 105 },
    (_, index) => `${prefix}${String(index + 1).padStart(3, "0")}`,
  );
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
    Capabilities: bofExecutionFixture ? "1" : "0",
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

function fakeFile(name: string, isDirectory: boolean, size: string, mode: string, link = "") {
  return {
    Name: name,
    IsDir: isDirectory,
    Size: size,
    ModTime: "1786305600",
    Mode: mode,
    Link: link,
    Uid: "501",
    Gid: "20",
  };
}

function remoteBasename(path: string): string {
  return path.replace(/\/+$/u, "").split("/").at(-1) ?? "";
}

function remoteParent(path: string): string {
  const normalized = path.replace(/\/+$/u, "");
  const separator = normalized.lastIndexOf("/");
  return separator <= 0 ? "/" : normalized.slice(0, separator);
}

function fakeProcess(pid: number, executable: string, parentPid = 1) {
  return {
    Pid: pid,
    Ppid: parentPid,
    Executable: executable,
    Owner: "e2e-user",
    Architecture: "arm64",
    SessionID: 1,
    CmdLine: [`/usr/local/bin/${executable}`, "--m2-e2e"],
  };
}

function fakeExecutionChildren(): sliverpb.ExecuteChild[] {
  return [
    sliverpb.ExecuteChild.create({
      Pid: 43_101,
      Path: "/usr/bin/printf",
      Args: ["deterministic-child-one"],
      StartTime: "2026-08-15T19:00:00.000Z",
      Exited: true,
      ExitCode: 0,
      ExitTime: "2026-08-15T19:00:01.000Z",
      Stdout: "deterministic child output\n",
      Stderr: "",
      Error: "",
    }),
    sliverpb.ExecuteChild.create({
      Pid: 43_102,
      Path: "/usr/bin/sleep",
      Args: ["30"],
      StartTime: "2026-08-15T19:01:00.000Z",
      Exited: false,
      ExitCode: 0,
      ExitTime: "",
      Stdout: "",
      Stderr: "",
      Error: "",
    }),
  ];
}

function fakePagedExecutionChildren(): sliverpb.ExecuteChild[] {
  return [
    ...fakeExecutionChildren().map((child) => sliverpb.ExecuteChild.create({
      ...child,
      StartTime: String(Math.floor(Date.parse(child.StartTime) / 1_000)),
      ExitTime: child.ExitTime ? String(Math.floor(Date.parse(child.ExitTime) / 1_000)) : "0",
    })),
    ...Array.from({ length: 50 }, (_, index) => sliverpb.ExecuteChild.create({
      Pid: 43_103 + index,
      Path: `/usr/bin/fixture-child-${index + 1}`,
      Args: [],
      Exited: false,
    })),
  ];
}

function fakePrivileges(): sliverpb.WindowsPrivilegeEntry[] {
  return [
    sliverpb.WindowsPrivilegeEntry.create({
      Name: "SeDebugPrivilege",
      Description: "Debug programs",
      Enabled: true,
      EnabledByDefault: false,
      Removed: false,
      UsedForAccess: true,
    }),
    sliverpb.WindowsPrivilegeEntry.create({
      Name: "SeImpersonatePrivilege",
      Description: "Impersonate a client after authentication",
      Enabled: true,
      EnabledByDefault: true,
      Removed: false,
      UsedForAccess: false,
    }),
  ];
}

function fakePagedPrivileges(): sliverpb.WindowsPrivilegeEntry[] {
  return [
    ...fakePrivileges(),
    ...Array.from({ length: 50 }, (_, index) => sliverpb.WindowsPrivilegeEntry.create({
      Name: `FixturePrivilege${index + 1}`,
      Description: `Fixture privilege ${index + 1}`,
      Enabled: false,
    })),
  ];
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

function fakeBofResponse(
  targetMode: "session" | "beacon",
  targetId: string,
  object: Buffer,
  argumentsBuffer: Buffer,
  entrypoint: string,
  timeoutSeconds: number,
): sliverpb.CallExtension {
  const marker = object.toString("utf8");
  if (marker !== "inert-sa-dir-bof-object" && marker !== "inert-sa-nslookup-bof-object") {
    throw new Error("The deterministic fake received an unexpected BOF object");
  }
  if (entrypoint !== "go" || argumentsBuffer.length < 4 ||
      argumentsBuffer.readUInt32LE(0) !== argumentsBuffer.length - 4) {
    throw new Error("The deterministic fake received an invalid BOF invocation");
  }
  state.bofCalls.push({
    targetMode,
    targetId,
    objectSha256: createHash("sha256").update(object).digest("hex"),
    objectHex: object.toString("hex"),
    argumentsHex: argumentsBuffer.toString("hex"),
    entrypoint,
    timeoutSeconds,
  });
  const kind = marker === "inert-sa-dir-bof-object" ? "sa-dir" : "sa-nslookup";
  return sliverpb.CallExtension.create({
    BOFOutputs: [
      { Type: 0, Data: Buffer.from(`deterministic ${kind} stdout\n`, "utf8") },
      ...(kind === "sa-nslookup"
        ? [{ Type: 0x0d, Data: Buffer.from("deterministic sa-nslookup stderr\n", "utf8") }]
        : []),
    ],
    Response: response(false),
  });
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

class FakeShellOutput implements AsyncIterable<Uint8Array> {
  private readonly queue: Uint8Array[] = [];
  private waiter: ((result: IteratorResult<Uint8Array>) => void) | undefined;
  private closed = false;

  push(value: string): void {
    if (this.closed) return;
    const bytes = Uint8Array.from(Buffer.from(value, "utf8"));
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: bytes, done: false });
      return;
    }
    this.queue.push(bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const next = this.queue.shift();
        if (next) return Promise.resolve({ value: next, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<Uint8Array>>((resolve) => {
          this.waiter = resolve;
        });
      },
      return: async () => {
        this.close();
        for (const bytes of this.queue.splice(0)) bytes.fill(0);
        return { value: undefined, done: true };
      },
    };
  }
}
