import type {
  BeaconTaskDetail,
  BeaconTaskPage,
  BeaconTaskSummary,
  CancelBeaconTaskInput,
  CancelTargetOperationInput,
  GetBeaconTaskInput,
  ListBeaconTasksInput,
  OperationPageRequest,
  TargetOperationInput,
  TargetOperationPage,
  TargetOperationRecord,
} from "./operation-contracts.js";
import type {
  BeaconSummary,
  ExecuteTargetActionPlanInput,
  OperatorPresenceSummary,
  PrepareTargetActionInput,
  SessionSummary,
  TargetCatalogPage,
  TargetCatalogPageRequest,
  TargetActionExecutionResult,
  TargetActionPlan,
  TargetDomains,
  TargetRef,
  WindowTargetContext,
} from "./target-contracts.js";
import type {
  ExecuteSessionDestructiveActionPlanInput,
  PrepareSessionDestructiveActionInput,
  SessionDestructiveActionOutcome,
  SessionDestructiveActionPreparation,
  SessionWorkbenchInput,
  SessionWorkbenchInvocationResult,
} from "./session-contracts.js";
import type {
  ListSessionShellsInput,
  PrepareSessionShellInput,
  SessionShellPlan,
  SessionShellResourceActionInput,
  SessionShellResourceActionResult,
  SessionShellResourceList,
  TerminalRuntimeAsset,
} from "./stream-contracts.js";
import type { SliverReleaseDownloadEvent } from "./release-contracts.js";
import type { ApplicationUpdateState } from "./application-update-contracts.js";
import type { CloudProvider } from "./cloud-deployment-contracts.js";
import type { CloudDeploymentNavigationRequest } from "./cloud-deployment-ipc.js";
import type {
  ApplicationSettingsState,
  ApplicationSettingsUpdateInput,
  ResolvedApplicationIcon,
} from "./application-settings-contracts.js";
import type {
  ExecuteExecutionPlanInput,
  ExecutionActionPlan,
  ExecutionActionResult,
  ExecutionCatalog,
  ExecutionReadResult,
  ExecutionResultRequest,
  PrepareExecutionActionInput,
  RunExecutionReadInput,
  SaveExecutionResultInput,
  SaveExecutionResultResult,
} from "./execution-contracts.js";
import type {
  ConsoleTabCloseResult,
  ConsoleTabLaunchContext,
  ConsoleWindowLaunchContext,
} from "./console-contracts.js";
import type {
  AddCredentialInput,
  AddLootInput,
  CopyCredentialSecretInput,
  CredentialCatalogPage,
  CredentialClipboardResult,
  CredentialSecretReveal,
  ListCredentialsInput,
  ListLootInput,
  LootCatalogPage,
  LootDetail,
  LootDownloadResult,
  LootSummary,
  RenameLootInput,
  RevealCredentialSecretInput,
} from "./operator-data-contracts.js";

import type {
  CreateScriptInput,
  DeleteScriptInput,
  ExportScriptInput,
  ExportScriptResult,
  ImportScriptResult,
  ReadScriptInput,
  RenameScriptInput,
  SaveScriptInput,
  ScriptCatalog,
  ScriptDocument,
  ScriptRuntimeAsset,
} from "./script-contracts.js";

export const IPC_INVOKE = {
  listScripts: "sliver:scripts:list",
  readScript: "sliver:scripts:read",
  createScript: "sliver:scripts:create",
  saveScript: "sliver:scripts:save",
  renameScript: "sliver:scripts:rename",
  deleteScript: "sliver:scripts:delete",
  exportScript: "sliver:scripts:export",
  importScript: "sliver:scripts:import",
  getScriptRuntime: "sliver:scripts:runtime",
  setScriptEditorDirty: "sliver:scripts:editor-dirty",
  chooseConfig: "sliver:connection:choose-config",
  importConfig: "sliver:connection:import-config",
  listSavedConfigs: "sliver:connection:list-saved-configs",
  connectSavedConfig: "sliver:connection:connect-saved-config",
  removeSavedConfig: "sliver:connection:remove-saved-config",
  disconnect: "sliver:connection:disconnect",
  getSnapshot: "sliver:snapshot:get",
  refresh: "sliver:snapshot:refresh",
  listLocalNetworkInterfaces: "sliver:network-interfaces:list-local",
  openWindow: "sliver:window:open",
  openCloudDeploymentWindow: "sliver:window:open-cloud-deployment",
  copyManagedServerSshCommand: "sliver:managed-server:copy-ssh-command",
  copyManagedServerPublicIp: "sliver:managed-server:copy-public-ip",
  openInteractionWindow: "sliver:window:open-interaction",
  claimInteractionWindow: "sliver:window:claim-interaction",
  exitApp: "sliver:application:exit",
  getApplicationSettings: "sliver:application-settings:get",
  getApplicationIcon: "sliver:application-icon:get",
  updateApplicationSettings: "sliver:application-settings:update",
  setKeyboardShortcutRecording: "sliver:keyboard-shortcuts:recording",
  getApplicationUpdateState: "sliver:application-update:get",
  checkForApplicationUpdates: "sliver:application-update:check",
  restartToApplyApplicationUpdate: "sliver:application-update:restart",
  openSessionShellWindow: "sliver:window:open-session-shells",
  claimSessionShellWindow: "sliver:window:claim-session-shells",
  openConsoleWindow: "sliver:window:open-console",
  claimConsoleWindow: "sliver:window:claim-console",
  createConsoleTab: "sliver:console-tab:create",
  closeConsoleTab: "sliver:console-tab:close",
  chooseCertificatePair: "sliver:listener:choose-certificate-pair",
  startListener: "sliver:listener:start",
  prepareStopJob: "sliver:job:prepare-stop",
  prepareStopAllJobs: "sliver:job:prepare-stop-all",
  executeStopPlan: "sliver:job:execute-stop-plan",
  generate: "sliver:generate:create",
  generateFromProfile: "sliver:generate:from-profile",
  downloadBuild: "sliver:build:download",
  deleteBuild: "sliver:build:delete",
  setStagedBuilds: "sliver:build:set-staged",
  saveProfile: "sliver:profile:save",
  deleteProfile: "sliver:profile:delete",
  listLoot: "sliver:loot:list",
  addLoot: "sliver:loot:add-local",
  getLootDetail: "sliver:loot:detail",
  downloadLoot: "sliver:loot:download",
  renameLoot: "sliver:loot:rename",
  deleteLoot: "sliver:loot:delete",
  listCredentials: "sliver:credential:list",
  revealCredentialSecret: "sliver:credential:reveal-secret",
  addCredential: "sliver:credential:add",
  deleteCredential: "sliver:credential:delete",
  copyCredentialSecret: "sliver:credential:copy-secret",
  clearCredentialClipboard: "sliver:credential:clear-clipboard",
  listTargets: "sliver:target:list",
  selectTarget: "sliver:target:select",
  backgroundTarget: "sliver:target:background",
  setBeaconWatch: "sliver:target:set-beacon-watch",
  submitTargetOperation: "sliver:operation:submit",
  listTargetOperations: "sliver:operation:list",
  getTargetOperation: "sliver:operation:get",
  cancelTargetOperation: "sliver:operation:cancel",
  prepareTargetAction: "sliver:target:prepare-action",
  executeTargetActionPlan: "sliver:target:execute-action-plan",
  listBeaconTasks: "sliver:beacon-task:list",
  getBeaconTask: "sliver:beacon-task:get",
  cancelBeaconTask: "sliver:beacon-task:cancel",
  runSessionWorkbench: "sliver:session-workbench:run",
  prepareSessionDestructiveAction: "sliver:session-workbench:prepare-action",
  executeSessionDestructiveActionPlan: "sliver:session-workbench:execute-action-plan",
  prepareSessionShell: "sliver:session-shell:prepare",
  listSessionShells: "sliver:session-shell:list",
  actOnSessionShell: "sliver:session-shell:act",
  getTerminalRuntime: "sliver:terminal-runtime:get",
  listExecutionCatalog: "sliver:execution:catalog",
  runExecutionRead: "sliver:execution:read",
  prepareExecutionAction: "sliver:execution:prepare",
  executeExecutionPlan: "sliver:execution:execute-plan",
  discardExecutionPlan: "sliver:execution:discard-plan",
  getExecutionResult: "sliver:execution:result",
  saveExecutionResult: "sliver:execution:save-result",
} as const;

export const IPC_STREAM = {
  attach: "sliver:stream:attach",
  attachConsole: "sliver:console-stream:attach",
} as const;

export const IPC_EVENTS = {
  scriptsChanged: "sliver:scripts:changed",
  cloudDeploymentThemeChanged: "sliver:cloud-deployment:theme-changed",
  snapshotChanged: "sliver:snapshot:changed",
  operationChanged: "sliver:operation:changed",
  beaconTasksInvalidated: "sliver:beacon-task:invalidated",
  sessionShellsChanged: "sliver:session-shell:changed",
  releaseDownloadChanged: "sliver:release-download:changed",
  applicationUpdateChanged: "sliver:application-update:changed",
  applicationSettingsChanged: "sliver:application-settings:changed",
  applicationIconChanged: "sliver:application-icon:changed",
  commandPaletteRequested: "sliver:command-palette:requested",
  consoleNewTabRequested: "sliver:console:new-tab-requested",
  consoleCloseTabRequested: "sliver:console:close-tab-requested",
  consoleSelectTabRequested: "sliver:console:select-tab-requested",
  consoleSettingsRequested: "sliver:console:settings-requested",
} as const;

export const IPC = {
  ...IPC_INVOKE,
  ...IPC_EVENTS,
  ...IPC_STREAM,
} as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE];

export const DEFAULT_C2_SCHEME = "mtls" as const;
export const SLIVER_PROTOCOL_BASELINE_COMMIT = "f8430cecf7ceb5cb332c84fb36aba9b75188802d" as const;
export const SLIVER_PROTOCOL_COMPATIBILITY = {
  major: 1,
  minor: 7,
  series: "1.7.x",
} as const;

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "incompatible";
export type EventStreamStatus = "stopped" | "connecting" | "connected" | "retrying";
export type ServerCompatibility = "unknown" | "supported" | "degraded" | "unsupported";

export interface ServerCapabilitySummary {
  compatibility: ServerCompatibility;
  baselineCommit: typeof SLIVER_PROTOCOL_BASELINE_COMMIT;
  serverVersion?: string;
  reason?: string;
  currentSlice: {
    jobs: boolean;
    listeners: boolean;
    generation: boolean;
    builds: boolean;
    profiles: boolean;
    events: boolean;
    targets: boolean;
    tasks: boolean;
  };
}

/** Cached shared cloud/network identity, separate from the hosted instance. */
export type ManagedCloudOverview = {
  readonly provider: "aws";
  readonly vpcId?: string;
  /** Configured managed-network CIDR; not a live provider observation. */
  readonly vpcCidr?: string;
} | {
  readonly provider: "azure";
  readonly subscriptionId?: string;
  readonly resourceGroupName?: string;
  readonly resourceGroupId?: string;
  readonly virtualNetworkId?: string;
  readonly virtualNetworkName?: string;
  /** A VNet may belong to a different group than the hosted VM. */
  readonly virtualNetworkResourceGroup?: string;
  /** Configured managed-network CIDR; not a live provider observation. */
  readonly virtualNetworkCidr?: string;
};

/** Cached display metadata; reading it never refreshes a cloud provider. */
export interface ManagedServerOverview {
  readonly cloud?: ManagedCloudOverview;
  readonly region: string;
  readonly size: string;
  readonly instanceId?: string;
  readonly instanceName?: string;
  readonly availabilityZone?: string;
  readonly subnetId?: string;
  readonly instanceState: string;
  readonly health?: string;
  readonly publicIpAddress: string | null;
  readonly privateIpAddress: string | null;
  /** Time the local deployment record changed, not a live provider observation. */
  readonly updatedAt: string;
}

export interface ManagedServerReference {
  readonly deploymentId: string;
  readonly provider: CloudProvider;
  readonly name: string;
  readonly overview?: ManagedServerOverview;
}

export interface CopyManagedServerPublicIpInput {
  readonly deploymentId: string;
}

export interface CopyManagedServerSshCommandInput {
  readonly deploymentId: string;
}

export interface ConnectionSummary {
  status: ConnectionStatus;
  /** Local deployment associated with the config used for this connection. */
  managedServer: ManagedServerReference | null;
  operator?: string;
  server?: string;
  configName?: string;
  version?: string;
  error?: string;
  epoch?: number;
  /** Per-window connection attempt. This changes even when reconnecting to the
   * same shared backend epoch, allowing renderer requests to quarantine stale
   * results without exposing a secret. */
  incarnation?: number;
  capabilities?: ServerCapabilitySummary;
}

export type SavedConfigTransport = "mtls" | "wireguard";
export type SavedConfigOrigin = "managed" | "preexisting";

export interface SavedConfigSummary {
  id: string;
  fileName: string;
  displayName: string;
  operator: string;
  lhost: string;
  lport: number;
  transport: SavedConfigTransport;
  modifiedAt: string;
  origin: SavedConfigOrigin;
  removal: "delete-managed-copy" | "detach";
  availability: "available" | "deferred";
  unavailableReason?: string;
}

export interface ImportConfigInput {
  displayName: string;
}

export interface RemoveSavedConfigInput {
  id: string;
}

export interface EventStreamSummary {
  status: EventStreamStatus;
  attempt: number;
  error?: string;
}

export interface JobSummary {
  id: number;
  name: string;
  description: string;
  protocol: string;
  port: number;
  domains: string[];
  profileName: string;
}

export type ManagedListenerFirewallProtocol = "tcp" | "udp";

export type ManagedListenerFirewallStatus =
  | "not-requested"
  | "applied"
  | "already-covered"
  | "removed"
  | "not-found"
  | "retained"
  | "failed"
  | "outcome-unknown";

export interface ManagedListenerFirewallOutcome {
  status: ManagedListenerFirewallStatus;
  ruleCount: number;
  error?: string;
}

export type NetworkInterfaceAddressScope = "global" | "private" | "loopback";

export interface LocalNetworkInterfaceAddress {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  scope: NetworkInterfaceAddressScope;
}

export interface LocalNetworkInterfaceInventory {
  hostname: string;
  addresses: LocalNetworkInterfaceAddress[];
}

export interface BuildSummary {
  name: string;
  configId: string;
  target: string;
  format: ArtifactFormat;
  implantType: ImplantType;
  c2: string[];
  staged: boolean;
}

export interface ProfileSummary {
  id: string;
  name: string;
  target: string;
  format: ArtifactFormat;
  implantType: ImplantType;
  c2: string[];
}

export interface CompilerTargetSummary {
  os: string;
  arch: string;
  format: ArtifactFormat;
  supported: boolean;
}

export type DomainStatus = "idle" | "loading" | "ready" | "empty" | "error" | "unsupported";

export interface PageSummary {
  limit: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface PageResult<T> {
  items: T[];
  page: PageSummary;
}

export interface DomainCollection<T> extends PageResult<T> {
  status: DomainStatus;
  revision: number;
  updatedAt?: string;
  error?: string;
}

export interface SnapshotDomains {
  jobs: DomainCollection<JobSummary>;
  builds: DomainCollection<BuildSummary>;
  profiles: DomainCollection<ProfileSummary>;
  compiler: DomainCollection<CompilerTargetSummary>;
  sessions: TargetDomains["sessions"];
  beacons: TargetDomains["beacons"];
  operators: TargetDomains["operators"];
}

export interface RecentEventSummary {
  id: string;
  type: string;
  at: string;
  message: string;
  isError: boolean;
}

export interface SliverSnapshot {
  /** Passive server-reported service inventory for infrastructure views. */
  infrastructureServices?: import("./topology-contracts.js").InfrastructureServicesSnapshot;
  /** Bounded display-only hierarchy reported by the server's passive graph RPC. */
  pivotTopology?: import("./topology-contracts.js").PivotTopologySnapshot;
  connection: ConnectionSummary;
  eventStream: EventStreamSummary;
  jobs: JobSummary[];
  builds: BuildSummary[];
  profiles: ProfileSummary[];
  compilerTargets: CompilerTargetSummary[];
  sessions: SessionSummary[];
  beacons: BeaconSummary[];
  operators: OperatorPresenceSummary[];
  targetContext: WindowTargetContext;
  recentEvents: RecentEventSummary[];
  domains: SnapshotDomains;
  lastUpdated?: string;
}

export interface JobStopBackendSummary {
  server: string;
  operator: string;
  configName: string;
  epoch: number;
  sharedWindowCount: number;
}

export interface JobStopManagedFirewallImpact {
  server: ManagedServerReference;
  protocol: ManagedListenerFirewallProtocol;
  port: number;
}

export interface JobStopImpact {
  backend: JobStopBackendSummary;
  jobs: JobSummary[];
  stopsAll: boolean;
  managedFirewall: JobStopManagedFirewallImpact | null;
  warning: string;
}

export interface JobStopPlan {
  token: string;
  expiresAt: string;
  impact: JobStopImpact;
}

export type ImplantType = "session" | "beacon";
export type ArtifactFormat = "executable" | "shared" | "shellcode" | "service" | "archive";
export type ConnectionStrategy = "" | "s" | "r" | "rd";

export interface ShellcodeOptions {
  compress: boolean;
  entropy: 1 | 2 | 3;
  exitOption: 1 | 2 | 3;
  bypass: 1 | 2 | 3;
  headers: 1 | 2;
  runInThread: boolean;
  unicode: boolean;
  originalEntryPoint: number;
}

export interface GenerateInput {
  name: string;
  implantType: ImplantType;
  os: string;
  arch: string;
  format: ArtifactFormat;
  templateName: string;
  c2: string;
  connectionStrategy: ConnectionStrategy;
  reconnectSeconds: number;
  pollTimeoutSeconds: number;
  maxConnectionErrors: number;
  beaconIntervalSeconds: number;
  beaconJitterSeconds: number;
  debug: boolean;
  evasion: boolean;
  obfuscateSymbols: boolean;
  netGo: boolean;
  runAtLoad: boolean;
  exports: string;
  canaryDomains: string;
  httpC2Profile: string;
  wgPeerTunIp: string;
  wgKeyExchangePort: number;
  wgTcpCommsPort: number;
  limitDomainJoined: boolean;
  limitDatetime: string;
  limitHostname: string;
  limitUsername: string;
  limitFileExists: string;
  limitLocale: string;
  shellcode: ShellcodeOptions;
}

export interface GenerateFromProfileInput {
  profileName: string;
  name: string;
}

export interface SaveProfileInput {
  profileName: string;
  config: GenerateInput;
  overwrite: boolean;
}

export interface SavedArtifact {
  fileName: string;
  size: number;
  implantName: string;
  buildId: string;
  saved: boolean;
}

export interface CertificatePairSelection {
  token: string;
  certificateName: string;
  keyName: string;
}

export interface MTLSListenerInput {
  kind: "mtls";
  host: string;
  port: number;
}

export interface WireGuardListenerInput {
  kind: "wireguard";
  host: string;
  port: number;
  tunnelIp: string;
  tcpCommsPort: number;
  keyExchangePort: number;
}

export interface DNSListenerInput {
  kind: "dns";
  host: string;
  port: number;
  domains: string;
  canaries: boolean;
  enforceOtp: boolean;
}

export interface HTTPListenerInput {
  kind: "http" | "https";
  host: string;
  port: number;
  domain: string;
  website: string;
  enforceOtp: boolean;
  longPollTimeoutSeconds: number;
  longPollJitterSeconds: number;
  acme: boolean;
  randomizeJarm: boolean;
  certificateToken: string;
}

export type StageCompression = "none" | "zlib" | "gzip" | "deflate";

export interface StageListenerInput {
  kind: "stage";
  host: string;
  port: number;
  profileName: string;
  compression: StageCompression;
  aesKey: string;
  aesIv: string;
  rc4Key: string;
}

export type ListenerInput =
  | MTLSListenerInput
  | WireGuardListenerInput
  | DNSListenerInput
  | HTTPListenerInput
  | StageListenerInput;

export interface StartListenerRequest {
  listener: ListenerInput;
  addManagedFirewallRule: boolean;
}

export interface StartListenerResult {
  job: JobSummary;
  firewall: ManagedListenerFirewallOutcome;
}

export interface ExecuteJobStopPlanInput {
  token: string;
  removeManagedFirewallRule: boolean;
}

export interface JobStopExecutionResult {
  stoppedJobIds: number[];
  failedJobIds: number[];
  firewall: ManagedListenerFirewallOutcome;
}

export interface OperationFailure {
  ok: false;
  error: string;
  value?: never;
}

export interface OperationSuccess<T> {
  ok: true;
  value: T;
  error?: never;
}

export interface EmptyOperationSuccess {
  ok: true;
  value?: never;
  error?: never;
}

export type OperationResultWithValue<T> = OperationFailure | OperationSuccess<T>;

export type OperationResult<T = never> = [T] extends [never]
  ? OperationFailure | EmptyOperationSuccess
  : OperationResultWithValue<T>;

export interface OpenWindowInput {
  inheritConnection: boolean;
}

export interface OpenSessionShellWindowInput {
  readonly preferredResourceId?: string;
}

export type WindowLaunchContext =
  | { readonly kind: "workspace" }
  | {
      readonly kind: "interaction";
      readonly snapshot: SliverSnapshot;
      readonly target: TargetRef;
    }
  | {
      readonly kind: "session-shell";
      readonly snapshot: SliverSnapshot;
      readonly preferredResourceId?: string;
    }
  | ConsoleWindowLaunchContext;

interface IpcInvokeDefinition {
  args: readonly unknown[];
  result: unknown;
}

type CompleteIpcInvokeContract<Contract extends Record<IpcInvokeChannel, IpcInvokeDefinition>> = Contract;

export type IpcInvokeContract = CompleteIpcInvokeContract<{
  [IPC.chooseConfig]: {
    args: [];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.importConfig]: {
    args: [input: ImportConfigInput];
    result: OperationResult<SavedConfigSummary>;
  };
  [IPC.listSavedConfigs]: {
    args: [];
    result: OperationResult<SavedConfigSummary[]>;
  };
  [IPC.connectSavedConfig]: {
    args: [id: string];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.removeSavedConfig]: {
    args: [input: RemoveSavedConfigInput];
    result: OperationResult;
  };
  [IPC.disconnect]: {
    args: [];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.getSnapshot]: {
    args: [];
    result: SliverSnapshot;
  };
  [IPC.refresh]: {
    args: [];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.listLocalNetworkInterfaces]: {
    args: [];
    result: OperationResult<LocalNetworkInterfaceInventory>;
  };
  [IPC.openWindow]: {
    args: [input: OpenWindowInput];
    result: OperationResult;
  };
  [IPC.openCloudDeploymentWindow]: {
    args: [request?: CloudDeploymentNavigationRequest];
    result: OperationResult;
  };
  [IPC.copyManagedServerPublicIp]: {
    args: [input: CopyManagedServerPublicIpInput];
    result: OperationResult;
  };
  [IPC.copyManagedServerSshCommand]: {
    args: [input: CopyManagedServerSshCommandInput];
    result: OperationResult;
  };
  [IPC.openInteractionWindow]: {
    args: [];
    result: OperationResult;
  };
  [IPC.claimInteractionWindow]: {
    args: [];
    result: OperationResult<WindowLaunchContext>;
  };
  [IPC.exitApp]: {
    args: [];
    result: OperationResult;
  };
  [IPC.getApplicationSettings]: {
    args: [];
    result: ApplicationSettingsState;
  };
  [IPC.getApplicationIcon]: {
    args: [];
    result: ResolvedApplicationIcon;
  };
  [IPC.updateApplicationSettings]: {
    args: [input: ApplicationSettingsUpdateInput];
    result: OperationResult<ApplicationSettingsState>;
  };
  [IPC.setKeyboardShortcutRecording]: {
    args: [isRecording: boolean];
    result: void;
  };
  [IPC.getApplicationUpdateState]: {
    args: [];
    result: ApplicationUpdateState;
  };
  [IPC.checkForApplicationUpdates]: {
    args: [];
    result: OperationResult<ApplicationUpdateState>;
  };
  [IPC.restartToApplyApplicationUpdate]: {
    args: [];
    result: OperationResult;
  };
  [IPC.openSessionShellWindow]: {
    args: [input: OpenSessionShellWindowInput];
    result: OperationResult;
  };
  [IPC.claimSessionShellWindow]: {
    args: [];
    result: OperationResult<WindowLaunchContext>;
  };
  [IPC.openConsoleWindow]: {
    args: [];
    result: OperationResult;
  };
  [IPC.claimConsoleWindow]: {
    args: [];
    result: OperationResult<ConsoleWindowLaunchContext>;
  };
  [IPC.createConsoleTab]: {
    args: [];
    result: OperationResult<ConsoleTabLaunchContext>;
  };
  [IPC.closeConsoleTab]: {
    args: [tabId: string];
    result: OperationResult<ConsoleTabCloseResult>;
  };
  [IPC.chooseCertificatePair]: {
    args: [];
    result: OperationResult<CertificatePairSelection>;
  };
  [IPC.startListener]: {
    args: [input: StartListenerRequest];
    result: OperationResult<StartListenerResult>;
  };
  [IPC.prepareStopJob]: {
    args: [jobId: number];
    result: OperationResult<JobStopPlan>;
  };
  [IPC.prepareStopAllJobs]: {
    args: [];
    result: OperationResult<JobStopPlan>;
  };
  [IPC.executeStopPlan]: {
    args: [input: ExecuteJobStopPlanInput];
    result: OperationResult<JobStopExecutionResult>;
  };
  [IPC.generate]: {
    args: [input: GenerateInput];
    result: OperationResult<SavedArtifact>;
  };
  [IPC.generateFromProfile]: {
    args: [input: GenerateFromProfileInput];
    result: OperationResult<SavedArtifact>;
  };
  [IPC.downloadBuild]: {
    args: [buildName: string];
    result: OperationResult<SavedArtifact>;
  };
  [IPC.deleteBuild]: {
    args: [buildName: string];
    result: OperationResult;
  };
  [IPC.setStagedBuilds]: {
    args: [buildNames: string[]];
    result: OperationResult;
  };
  [IPC.saveProfile]: {
    args: [input: SaveProfileInput];
    result: OperationResult<ProfileSummary>;
  };
  [IPC.deleteProfile]: {
    args: [profileName: string];
    result: OperationResult;
  };
  [IPC.listLoot]: {
    args: [input: ListLootInput];
    result: OperationResult<LootCatalogPage>;
  };
  [IPC.addLoot]: {
    args: [input: AddLootInput];
    result: OperationResult<LootSummary>;
  };
  [IPC.getLootDetail]: {
    args: [lootId: string];
    result: OperationResult<LootDetail>;
  };
  [IPC.downloadLoot]: {
    args: [lootId: string];
    result: OperationResult<LootDownloadResult>;
  };
  [IPC.renameLoot]: {
    args: [input: RenameLootInput];
    result: OperationResult<LootSummary>;
  };
  [IPC.deleteLoot]: {
    args: [lootId: string];
    result: OperationResult;
  };
  [IPC.listCredentials]: {
    args: [input: ListCredentialsInput];
    result: OperationResult<CredentialCatalogPage>;
  };
  [IPC.revealCredentialSecret]: {
    args: [input: RevealCredentialSecretInput];
    result: OperationResult<CredentialSecretReveal>;
  };
  [IPC.addCredential]: {
    args: [input: AddCredentialInput];
    result: OperationResult;
  };
  [IPC.deleteCredential]: {
    args: [credentialId: string];
    result: OperationResult;
  };
  [IPC.copyCredentialSecret]: {
    args: [input: CopyCredentialSecretInput];
    result: OperationResult<CredentialClipboardResult>;
  };
  [IPC.clearCredentialClipboard]: {
    args: [];
    result: OperationResult;
  };
  [IPC.listTargets]: {
    args: [request: TargetCatalogPageRequest];
    result: OperationResult<TargetCatalogPage>;
  };
  [IPC.selectTarget]: {
    args: [target: TargetRef];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.backgroundTarget]: {
    args: [];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.setBeaconWatch]: {
    args: [input: { enabled: boolean }];
    result: OperationResult<SliverSnapshot>;
  };
  [IPC.submitTargetOperation]: {
    args: [input: TargetOperationInput];
    result: OperationResult<TargetOperationRecord>;
  };
  [IPC.listTargetOperations]: {
    args: [request: OperationPageRequest];
    result: OperationResult<TargetOperationPage>;
  };
  [IPC.getTargetOperation]: {
    args: [input: CancelTargetOperationInput];
    result: OperationResult<TargetOperationRecord>;
  };
  [IPC.cancelTargetOperation]: {
    args: [input: CancelTargetOperationInput];
    result: OperationResult<TargetOperationRecord>;
  };
  [IPC.prepareTargetAction]: {
    args: [input: PrepareTargetActionInput];
    result: OperationResult<TargetActionPlan>;
  };
  [IPC.executeTargetActionPlan]: {
    args: [input: ExecuteTargetActionPlanInput];
    result: OperationResult<TargetActionExecutionResult>;
  };
  [IPC.listBeaconTasks]: {
    args: [input: ListBeaconTasksInput];
    result: OperationResult<BeaconTaskPage>;
  };
  [IPC.getBeaconTask]: {
    args: [input: GetBeaconTaskInput];
    result: OperationResult<BeaconTaskDetail>;
  };
  [IPC.cancelBeaconTask]: {
    args: [input: CancelBeaconTaskInput];
    result: OperationResult<BeaconTaskSummary>;
  };
  [IPC.runSessionWorkbench]: {
    args: [input: SessionWorkbenchInput];
    result: OperationResult<SessionWorkbenchInvocationResult>;
  };
  [IPC.prepareSessionDestructiveAction]: {
    args: [input: PrepareSessionDestructiveActionInput];
    result: OperationResult<SessionDestructiveActionPreparation>;
  };
  [IPC.executeSessionDestructiveActionPlan]: {
    args: [input: ExecuteSessionDestructiveActionPlanInput];
    result: OperationResult<SessionDestructiveActionOutcome>;
  };
  [IPC.prepareSessionShell]: {
    args: [input: PrepareSessionShellInput];
    result: OperationResult<SessionShellPlan>;
  };
  [IPC.listSessionShells]: {
    args: [input: ListSessionShellsInput];
    result: OperationResult<SessionShellResourceList>;
  };
  [IPC.actOnSessionShell]: {
    args: [input: SessionShellResourceActionInput];
    result: OperationResult<SessionShellResourceActionResult>;
  };
  [IPC.listScripts]: { args: []; result: OperationResult<ScriptCatalog> };
  [IPC.readScript]: { args: [input: ReadScriptInput]; result: OperationResult<ScriptDocument> };
  [IPC.createScript]: { args: [input: CreateScriptInput]; result: OperationResult<ScriptDocument> };
  [IPC.saveScript]: { args: [input: SaveScriptInput]; result: OperationResult<ScriptDocument> };
  [IPC.renameScript]: { args: [input: RenameScriptInput]; result: OperationResult<ScriptDocument> };
  [IPC.deleteScript]: { args: [input: DeleteScriptInput]; result: OperationResult<void> };
  [IPC.exportScript]: { args: [input: ExportScriptInput]; result: OperationResult<ExportScriptResult> };
  [IPC.importScript]: { args: []; result: OperationResult<ImportScriptResult> };
  [IPC.getScriptRuntime]: { args: []; result: OperationResult<ScriptRuntimeAsset> };
  [IPC.setScriptEditorDirty]: { args: [isDirty: boolean]; result: OperationResult };
  [IPC.getTerminalRuntime]: {
    args: [];
    result: OperationResult<TerminalRuntimeAsset>;
  };
  [IPC.listExecutionCatalog]: {
    args: [];
    result: OperationResult<ExecutionCatalog>;
  };
  [IPC.runExecutionRead]: {
    args: [input: RunExecutionReadInput];
    result: OperationResult<ExecutionReadResult>;
  };
  [IPC.prepareExecutionAction]: {
    args: [input: PrepareExecutionActionInput];
    result: OperationResult<ExecutionActionPlan>;
  };
  [IPC.executeExecutionPlan]: {
    args: [input: ExecuteExecutionPlanInput];
    result: OperationResult<ExecutionActionResult>;
  };
  [IPC.discardExecutionPlan]: {
    args: [input: ExecuteExecutionPlanInput];
    result: OperationResult;
  };
  [IPC.getExecutionResult]: {
    args: [input: ExecutionResultRequest];
    result: OperationResult<ExecutionActionResult>;
  };
  [IPC.saveExecutionResult]: {
    args: [input: SaveExecutionResultInput];
    result: OperationResult<SaveExecutionResultResult>;
  };
}>;

export type IpcInvokeArgs<Channel extends IpcInvokeChannel> = IpcInvokeContract[Channel]["args"];
export type IpcInvokeResult<Channel extends IpcInvokeChannel> = IpcInvokeContract[Channel]["result"];
export type IpcInvokeMethod<Channel extends IpcInvokeChannel> = (
  ...args: IpcInvokeArgs<Channel>
) => Promise<IpcInvokeResult<Channel>>;

export type SliverDesktopInvokeAPI = {
  [Method in keyof typeof IPC_INVOKE]: IpcInvokeMethod<(typeof IPC_INVOKE)[Method]>;
};

export type SliverDesktopAPI = SliverDesktopInvokeAPI & {
  onScriptsChanged: (listener: () => void) => () => void;
  /**
   * Transfer one narrow MessagePort capability to the trusted main process.
   * The port is delivered back to this document through a fixed window-message
   * envelope; no ipcRenderer or raw backend object crosses the preload bridge.
  */
  openStream: (attachmentToken: string, correlationId: string) => void;
  /** Transfer the dedicated native-client console port capability. */
  openConsoleStream: (attachmentToken: string, correlationId: string) => void;
  onSnapshotChanged: (listener: (snapshot: SliverSnapshot) => void) => () => void;
  onOperationChanged: (listener: (operation: TargetOperationRecord) => void) => () => void;
  onBeaconTasksInvalidated: (listener: (target: TargetRef) => void) => () => void;
  onSessionShellsChanged: (listener: (preferredResourceId?: string) => void) => () => void;
  onReleaseDownloadChanged: (listener: (event: SliverReleaseDownloadEvent) => void) => () => void;
  onApplicationUpdateChanged: (listener: (state: ApplicationUpdateState) => void) => () => void;
  onApplicationSettingsChanged: (listener: (state: ApplicationSettingsState) => void) => () => void;
  onApplicationIconChanged: (listener: (icon: ResolvedApplicationIcon) => void) => () => void;
  onCommandPaletteRequested: (listener: () => void) => () => void;
  onConsoleNewTabRequested: (listener: () => void) => () => void;
  onConsoleCloseTabRequested: (listener: () => void) => () => void;
  onConsoleSelectTabRequested: (listener: (index: number) => void) => () => void;
  onConsoleSettingsRequested: (listener: () => void) => () => void;
};

type SliverDesktopNonInvokeAPIKey = Exclude<keyof SliverDesktopAPI, keyof SliverDesktopInvokeAPI>;

function defineSliverDesktopNonInvokeAPIKeys<
  const Keys extends readonly SliverDesktopNonInvokeAPIKey[],
>(
  keys: Keys & (
    Exclude<SliverDesktopNonInvokeAPIKey, Keys[number]> extends never
      ? unknown
      : readonly ["Missing SliverDesktopAPI keys", Exclude<SliverDesktopNonInvokeAPIKey, Keys[number]>]
  ),
): Keys {
  return keys;
}

/**
 * Explicit security allowlist for preload capabilities that do not use invoke IPC.
 * The helper makes additions to SliverDesktopAPI fail typechecking until this list
 * is deliberately reviewed and updated.
 */
export const SLIVER_DESKTOP_NON_INVOKE_API_KEYS = defineSliverDesktopNonInvokeAPIKeys([
  "onScriptsChanged",
  "openStream",
  "openConsoleStream",
  "onSnapshotChanged",
  "onOperationChanged",
  "onBeaconTasksInvalidated",
  "onSessionShellsChanged",
  "onReleaseDownloadChanged",
  "onApplicationUpdateChanged",
  "onApplicationSettingsChanged",
  "onApplicationIconChanged",
  "onCommandPaletteRequested",
  "onConsoleNewTabRequested",
  "onConsoleCloseTabRequested",
  "onConsoleSelectTabRequested",
  "onConsoleSettingsRequested",
] as const);

export function disconnectedSnapshot(error?: string): SliverSnapshot {
  const emptyDomain = <T>(): DomainCollection<T> => ({
    status: "idle",
    revision: 0,
    items: [],
    page: { limit: 0, total: 0, truncated: false },
  });
  return {
    connection: {
      status: "disconnected",
      managedServer: null,
      ...(error ? { error } : {}),
    },
    eventStream: { status: "stopped", attempt: 0 },
    jobs: [],
    builds: [],
    profiles: [],
    compilerTargets: [],
    sessions: [],
    beacons: [],
    operators: [],
    targetContext: {
      status: "none",
      activeTarget: null,
      activeTargetSummary: null,
      selectableTargets: [],
      capabilities: [],
      beaconWatch: false,
    },
    recentEvents: [],
    domains: {
      jobs: emptyDomain(),
      builds: emptyDomain(),
      profiles: emptyDomain(),
      compiler: emptyDomain(),
      sessions: emptyDomain(),
      beacons: emptyDomain(),
      operators: emptyDomain(),
    },
  };
}
