export const IPC = {
  chooseConfig: "sliver:connection:choose-config",
  listSavedConfigs: "sliver:connection:list-saved-configs",
  connectSavedConfig: "sliver:connection:connect-saved-config",
  disconnect: "sliver:connection:disconnect",
  getSnapshot: "sliver:snapshot:get",
  snapshotChanged: "sliver:snapshot:changed",
  refresh: "sliver:snapshot:refresh",
  openWindow: "sliver:window:open",
  chooseCertificatePair: "sliver:listener:choose-certificate-pair",
  startListener: "sliver:listener:start",
  killJob: "sliver:job:kill",
  killAllJobs: "sliver:job:kill-all",
  generate: "sliver:generate:create",
  generateFromProfile: "sliver:generate:from-profile",
  downloadBuild: "sliver:build:download",
  deleteBuild: "sliver:build:delete",
  setStagedBuilds: "sliver:build:set-staged",
  saveProfile: "sliver:profile:save",
  deleteProfile: "sliver:profile:delete",
} as const;

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";
export type EventStreamStatus = "stopped" | "connecting" | "connected" | "retrying";

export interface ConnectionSummary {
  status: ConnectionStatus;
  operator?: string;
  server?: string;
  configName?: string;
  version?: string;
  error?: string;
}

export type SavedConfigTransport = "mtls" | "wireguard";

export interface SavedConfigSummary {
  id: string;
  fileName: string;
  displayName: string;
  operator: string;
  lhost: string;
  lport: number;
  transport: SavedConfigTransport;
  modifiedAt: string;
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
  lastUpdated?: string;
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

export interface OperationResult<T = undefined> {
  ok: boolean;
  value?: T;
  error?: string;
}

export interface OpenWindowInput {
  inheritConnection: boolean;
}

export interface SliverDesktopAPI {
  chooseConfig(): Promise<OperationResult<SliverSnapshot>>;
  listSavedConfigs(): Promise<OperationResult<SavedConfigSummary[]>>;
  connectSavedConfig(id: string): Promise<OperationResult<SliverSnapshot>>;
  disconnect(): Promise<OperationResult<SliverSnapshot>>;
  getSnapshot(): Promise<SliverSnapshot>;
  refresh(): Promise<OperationResult<SliverSnapshot>>;
  openWindow(input: OpenWindowInput): Promise<OperationResult>;
  chooseCertificatePair(): Promise<OperationResult<CertificatePairSelection>>;
  startListener(input: ListenerInput): Promise<OperationResult<JobSummary>>;
  killJob(jobId: number): Promise<OperationResult>;
  killAllJobs(): Promise<OperationResult>;
  generate(input: GenerateInput): Promise<OperationResult<SavedArtifact>>;
  generateFromProfile(input: GenerateFromProfileInput): Promise<OperationResult<SavedArtifact>>;
  downloadBuild(buildName: string): Promise<OperationResult<SavedArtifact>>;
  deleteBuild(buildName: string): Promise<OperationResult>;
  setStagedBuilds(buildNames: string[]): Promise<OperationResult>;
  saveProfile(input: SaveProfileInput): Promise<OperationResult<ProfileSummary>>;
  deleteProfile(profileName: string): Promise<OperationResult>;
  onSnapshotChanged(listener: (snapshot: SliverSnapshot) => void): () => void;
}

export function disconnectedSnapshot(error?: string): SliverSnapshot {
  return {
    connection: error ? { status: "error", error } : { status: "disconnected" },
    eventStream: { status: "stopped", attempt: 0 },
    jobs: [],
    builds: [],
    profiles: [],
    compilerTargets: [],
    recentEvents: [],
  };
}
