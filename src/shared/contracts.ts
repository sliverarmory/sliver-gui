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

export const IPC_INVOKE = {
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
  openInteractionWindow: "sliver:window:open-interaction",
  claimInteractionWindow: "sliver:window:claim-interaction",
  exitApp: "sliver:application:exit",
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
  snapshotChanged: "sliver:snapshot:changed",
  operationChanged: "sliver:operation:changed",
  beaconTasksInvalidated: "sliver:beacon-task:invalidated",
  sessionShellsChanged: "sliver:session-shell:changed",
  releaseDownloadChanged: "sliver:release-download:changed",
  applicationUpdateChanged: "sliver:application-update:changed",
  consoleNewTabRequested: "sliver:console:new-tab-requested",
  consoleCloseTabRequested: "sliver:console:close-tab-requested",
  consoleSettingsRequested: "sliver:console:settings-requested",
} as const;

export const IPC = {
  ...IPC_INVOKE,
  ...IPC_EVENTS,
  ...IPC_STREAM,
} as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE];

export const DEFAULT_C2_SCHEME = "mtls" as const;
export const SLIVER_PROTOCOL_BASELINE_COMMIT = "ca685f5eed64c3327c0e57504928cfd2d2e96bea" as const;

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

export interface ConnectionSummary {
  status: ConnectionStatus;
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

export interface JobStopImpact {
  backend: JobStopBackendSummary;
  jobs: JobSummary[];
  stopsAll: boolean;
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
    args: [input: ListenerInput];
    result: OperationResult<JobSummary>;
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
    args: [token: string];
    result: OperationResult;
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
  onConsoleNewTabRequested: (listener: () => void) => () => void;
  onConsoleCloseTabRequested: (listener: () => void) => () => void;
  onConsoleSettingsRequested: (listener: () => void) => () => void;
};

export function disconnectedSnapshot(error?: string): SliverSnapshot {
  const emptyDomain = <T>(): DomainCollection<T> => ({
    status: "idle",
    revision: 0,
    items: [],
    page: { limit: 0, total: 0, truncated: false },
  });
  return {
    connection: error ? { status: "disconnected", error } : { status: "disconnected" },
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
