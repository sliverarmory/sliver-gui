export const IPC_INVOKE = {
  chooseConfig: "sliver:connection:choose-config",
  importConfig: "sliver:connection:import-config",
  listSavedConfigs: "sliver:connection:list-saved-configs",
  connectSavedConfig: "sliver:connection:connect-saved-config",
  removeSavedConfig: "sliver:connection:remove-saved-config",
  disconnect: "sliver:connection:disconnect",
  getSnapshot: "sliver:snapshot:get",
  refresh: "sliver:snapshot:refresh",
  openWindow: "sliver:window:open",
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
} as const;

export const IPC_EVENTS = {
  snapshotChanged: "sliver:snapshot:changed",
} as const;

export const IPC = {
  ...IPC_INVOKE,
  ...IPC_EVENTS,
} as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE)[keyof typeof IPC_INVOKE];

export const DEFAULT_C2_SCHEME = "mtls" as const;
export const SLIVER_PROTOCOL_BASELINE_COMMIT = "9ff9b55352eb1c8f2ff6a906bb691e9cee5bcaa9" as const;

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
  [IPC.openWindow]: {
    args: [input: OpenWindowInput];
    result: OperationResult;
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
  onSnapshotChanged: (listener: (snapshot: SliverSnapshot) => void) => () => void;
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
    recentEvents: [],
    domains: {
      jobs: emptyDomain(),
      builds: emptyDomain(),
      profiles: emptyDomain(),
      compiler: emptyDomain(),
    },
  };
}
