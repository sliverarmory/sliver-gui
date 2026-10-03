export const SESSION_WORKBENCH_DEFAULT_PAGE_LIMIT = 100 as const;
export const SESSION_WORKBENCH_MAX_PAGE_LIMIT = 500 as const;
export const SESSION_WORKBENCH_MAX_CURSOR_LENGTH = 256 as const;
export const SESSION_WORKBENCH_MAX_PATH_LENGTH = 4_096 as const;
export const SESSION_WORKBENCH_MAX_TEXT_LENGTH = 65_536 as const;
export const SESSION_WORKBENCH_MAX_ARTIFACT_BYTES = 67_108_864 as const;
/** Leaves one byte inside sliver-script's artifact cap to detect truncation. */
export const SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES = 67_108_863 as const;
export const SESSION_EDITOR_MAX_BYTES = 65_536 as const;
export const SESSION_DROPPED_UPLOAD_IPC_CHANNEL = "sliver:session-workbench:upload-dropped" as const;

const SESSION_DROPPED_UPLOAD_MAX_LOCAL_PATH_LENGTH = 32_768;

/** Renderer-authored remote options for one native-backed dropped file. */
export interface SessionDroppedUploadInput {
  remotePath: string;
  isIOC: boolean;
  isDirectory: false;
  overwrite: false;
}

/** Private preload-to-main envelope. The source path must never be exposed to the renderer. */
export interface SessionDroppedUploadIpcRequest {
  sourcePath: string;
  input: SessionDroppedUploadInput;
}

export const SESSION_WORKBENCH_QUERY_IDS = [
  "session.identity.current-token-owner",
  "session.environment.list",
  "session.environment.reveal",
  "session.network.interfaces",
  "session.network.connections",
  "session.filesystem.pwd",
  "session.filesystem.ls",
  "session.filesystem.cat",
  "session.filesystem.head",
  "session.filesystem.tail",
  "session.filesystem.read-hex",
  "session.filesystem.grep",
  "session.filesystem.mounts",
  "session.filesystem.memfiles.list",
  "session.process.list",
  "session.service.list",
  "session.service.detail",
  "session.registry.read",
  "session.registry.list-subkeys",
  "session.registry.list-values",
] as const;

export const SESSION_WORKBENCH_MUTATION_IDS = [
  "session.filesystem.cd",
  "session.filesystem.mkdir",
  "session.filesystem.memfiles.add",
  "session.filesystem.chmod",
  "session.filesystem.chown",
  "session.filesystem.chtimes",
  "session.service.start",
] as const;

export const SESSION_WORKBENCH_ARTIFACT_IDS = [
  "session.screenshot.capture",
  "session.artifact.save",
  "session.filesystem.download",
  "session.filesystem.add-to-loot",
  "session.filesystem.upload-open",
  "session.filesystem.stage-text",
  "session.filesystem.stage-hex",
  "session.process.dump",
  "session.registry.read-hive",
] as const;

export const SESSION_DESTRUCTIVE_ACTION_IDS = [
  "session.filesystem.cp",
  "session.filesystem.mv",
  "session.filesystem.rm",
  "session.filesystem.chmod-recursive",
  "session.filesystem.chown-recursive",
  "session.filesystem.memfiles.rm",
  "session.filesystem.upload-overwrite",
  "session.filesystem.edit-text-overwrite",
  "session.filesystem.patch-hex",
  "session.process.terminate",
  "session.service.stop",
  "session.registry.write",
  "session.registry.create-key",
  "session.registry.delete-key",
] as const;

export type SessionWorkbenchQueryId = (typeof SESSION_WORKBENCH_QUERY_IDS)[number];
export type SessionWorkbenchMutationId = (typeof SESSION_WORKBENCH_MUTATION_IDS)[number];
export type SessionWorkbenchArtifactId = (typeof SESSION_WORKBENCH_ARTIFACT_IDS)[number];
export type SessionDestructiveActionId = (typeof SESSION_DESTRUCTIVE_ACTION_IDS)[number];
export type SessionWorkbenchOperationId =
  | SessionWorkbenchQueryId
  | SessionWorkbenchMutationId
  | SessionWorkbenchArtifactId
  | SessionDestructiveActionId;

export type SessionTargetPlatform = "windows" | "linux" | "darwin";
export type SessionRegistryHive = "HKCU" | "HKLM" | "HKCR" | "HKU" | "HKCC";

export interface SessionPageRequest {
  cursor?: string;
  limit?: number;
}

export interface SessionSearchPageRequest extends SessionPageRequest {
  query?: string;
}

export interface SessionPageSummary {
  limit: number;
  total: number;
  truncated: boolean;
  nextCursor?: string;
}

export interface SessionBoundedPage<T> {
  items: T[];
  page: SessionPageSummary;
}

export interface SessionIdentityDetail {
  tokenOwner: string;
  username: string;
  uid?: string;
  gid?: string;
  pid?: number;
  executable: string;
  hostname: string;
  os: string;
  arch: string;
}

export type SessionEnvironmentEntry =
  | {
      name: string;
      sensitive: false;
      redacted: false;
      value: string;
    }
  | {
      name: string;
      sensitive: true;
      redacted: true;
    };

export interface SessionEnvironmentRevealResult {
  name: string;
  value: string;
  sensitive: boolean;
  revealedAt: string;
  expiresAt: string;
}

export interface SessionNetworkInterface {
  index: number;
  name: string;
  macAddress: string;
  addresses: string[];
}

export interface SessionSocketAddress {
  address: string;
  port: number;
}

export interface SessionNetworkConnection {
  protocol: string;
  state: string;
  uid?: number;
  local?: SessionSocketAddress;
  remote?: SessionSocketAddress;
  process?: SessionProcess;
}

export interface SessionWorkingDirectoryResult {
  path: string;
}

export interface SessionFileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: string;
  modifiedAt?: string;
  mode: string;
  linkTarget?: string;
  uid?: string;
  gid?: string;
}

export interface SessionDirectoryListing extends SessionBoundedPage<SessionFileEntry> {
  path: string;
  exists: boolean;
  timezone?: string;
  timezoneOffsetMinutes?: number;
}

export interface SessionTextFileView {
  path: string;
  mode: "cat" | "head" | "tail";
  encoding: "utf-8";
  content: string;
  bytesRead: number;
  truncated: boolean;
  /** Present only when the returned bytes are the complete remote file. */
  sha256?: string;
}

export interface SessionHexFileView {
  path: string;
  hex: string;
  bytesRead: number;
  truncated: boolean;
  /** Present only when the returned bytes are the complete remote file. */
  sha256?: string;
}

export interface SessionGrepPosition {
  start: number;
  end: number;
}

export interface SessionGrepMatch {
  path: string;
  lineNumber: string;
  line: string;
  positions: SessionGrepPosition[];
  linesBefore: string[];
  linesAfter: string[];
  binary: boolean;
}

export interface SessionMount {
  volumeName: string;
  volumeType: string;
  mountPoint: string;
  label: string;
  filesystem: string;
  usedBytes: string;
  freeBytes: string;
  totalBytes: string;
  options: string;
}

export interface SessionMemoryFile {
  fd: string;
  name: string;
  sizeBytes: string;
}

export interface SessionProcess {
  pid: number;
  parentPid: number;
  executable: string;
  owner: string;
  architecture: string;
  sessionId?: number;
  commandLine: string[];
}

export interface SessionService {
  name: string;
  displayName: string;
  description: string;
  status: number;
  startupType: number;
  binaryPath: string;
  account: string;
  message?: string;
}

export interface SessionRegistryReadResult {
  hive: SessionRegistryHive;
  path: string;
  key: string;
  type: "unknown" | SessionRegistryWriteValue["type"];
  value: string;
}

export interface SessionMutationResult {
  changed: boolean;
  message: string;
  path?: string;
  source?: string;
  destination?: string;
  bytesWritten?: string;
  fd?: string;
}

/** Renderer-safe capability for main-owned bytes. It is never a filesystem path. */
export interface SessionStoredArtifact {
  handle: string;
  suggestedBasename: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

export interface SessionArtifactPreview {
  mediaType: "image/jpeg" | "image/png" | "image/webp";
  dataUrl: string;
  size: number;
  width?: number;
  height?: number;
}

export interface SessionCapturedArtifactResult {
  status: "captured";
  artifact: SessionStoredArtifact;
  preview: SessionArtifactPreview;
}

export type SessionNativeSaveResult =
  | {
      status: "saved";
      suggestedBasename: string;
      size: number;
      sha256: string;
    }
  | {
      status: "canceled";
    };

export interface SessionLootAddResult {
  status: "added";
  fileName: string;
  fileType: "text" | "binary";
  size: number;
  sha256: string;
}

export type SessionNativeOpenUploadResult =
  | {
      status: "uploaded";
      remotePath: string;
      suggestedBasename: string;
      size: number;
      sha256: string;
      message: string;
    }
  | {
      status: "canceled";
    };

export interface SessionStagedEditorArtifactResult {
  status: "staged";
  artifact: SessionStoredArtifact;
}

export interface SessionWorkbenchInputMap {
  "session.identity.current-token-owner": { operationId: "session.identity.current-token-owner" };
  "session.environment.list": { operationId: "session.environment.list" } & SessionPageRequest;
  "session.environment.reveal": { operationId: "session.environment.reveal"; name: string };
  "session.network.interfaces": { operationId: "session.network.interfaces" } & SessionPageRequest;
  "session.network.connections": {
    operationId: "session.network.connections";
    tcp: boolean;
    udp: boolean;
    ip4: boolean;
    ip6: boolean;
    listening: boolean;
  } & SessionPageRequest;
  "session.filesystem.pwd": { operationId: "session.filesystem.pwd" };
  "session.filesystem.ls": { operationId: "session.filesystem.ls"; path: string } & SessionPageRequest;
  "session.filesystem.cat": {
    operationId: "session.filesystem.cat";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.head": {
    operationId: "session.filesystem.head";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.tail": {
    operationId: "session.filesystem.tail";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.read-hex": {
    operationId: "session.filesystem.read-hex";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.grep": {
    operationId: "session.filesystem.grep";
    path: string;
    pattern: string;
    recursive: boolean;
    linesBefore: number;
    linesAfter: number;
  } & SessionPageRequest;
  "session.filesystem.mounts": { operationId: "session.filesystem.mounts" } & SessionPageRequest;
  "session.filesystem.memfiles.list": { operationId: "session.filesystem.memfiles.list" } & SessionPageRequest;
  "session.process.list": { operationId: "session.process.list"; fullInfo: boolean } & SessionSearchPageRequest;
  "session.service.list": { operationId: "session.service.list" } & SessionSearchPageRequest;
  "session.service.detail": { operationId: "session.service.detail"; name: string };
  "session.registry.read": {
    operationId: "session.registry.read";
    hive: SessionRegistryHive;
    path: string;
    key: string;
  };
  "session.registry.list-subkeys": {
    operationId: "session.registry.list-subkeys";
    hive: SessionRegistryHive;
    path: string;
  } & SessionPageRequest;
  "session.registry.list-values": {
    operationId: "session.registry.list-values";
    hive: SessionRegistryHive;
    path: string;
  } & SessionPageRequest;
  "session.filesystem.cd": { operationId: "session.filesystem.cd"; path: string };
  "session.filesystem.mkdir": { operationId: "session.filesystem.mkdir"; path: string };
  "session.filesystem.memfiles.add": { operationId: "session.filesystem.memfiles.add" };
  "session.filesystem.chmod": {
    operationId: "session.filesystem.chmod";
    path: string;
    fileMode: string;
    recursive: false;
  };
  "session.filesystem.chown": {
    operationId: "session.filesystem.chown";
    path: string;
    uid: string;
    gid: string;
    recursive: false;
  };
  "session.filesystem.chtimes": {
    operationId: "session.filesystem.chtimes";
    path: string;
    accessTime: string;
    modificationTime: string;
  };
  "session.service.start": { operationId: "session.service.start"; name: string };
  "session.screenshot.capture": { operationId: "session.screenshot.capture" };
  "session.artifact.save": { operationId: "session.artifact.save"; handle: string };
  "session.filesystem.download": {
    operationId: "session.filesystem.download";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.add-to-loot": {
    operationId: "session.filesystem.add-to-loot";
    path: string;
    maxBytes: number;
  };
  "session.filesystem.upload-open": {
    operationId: "session.filesystem.upload-open";
    remotePath: string;
    isIOC: boolean;
    isDirectory: false;
    overwrite: false;
  };
  "session.filesystem.stage-text": {
    operationId: "session.filesystem.stage-text";
    content: string;
    encoding: "utf-8";
  };
  "session.filesystem.stage-hex": {
    operationId: "session.filesystem.stage-hex";
    hex: string;
  };
  "session.process.dump": {
    operationId: "session.process.dump";
    pid: number;
    dumpTimeoutSeconds: number;
  };
  "session.registry.read-hive": {
    operationId: "session.registry.read-hive";
    rootHive: SessionRegistryHive;
    requestedHive: string;
    maxBytes: number;
  };
}

export type SessionWorkbenchQueryInput = SessionWorkbenchInputMap[SessionWorkbenchQueryId];
export type SessionWorkbenchMutationInput = SessionWorkbenchInputMap[SessionWorkbenchMutationId];
export type SessionWorkbenchArtifactInput = SessionWorkbenchInputMap[SessionWorkbenchArtifactId];
export type SessionWorkbenchInput = SessionWorkbenchInputMap[
  SessionWorkbenchQueryId | SessionWorkbenchMutationId | SessionWorkbenchArtifactId
];
export type SessionWorkbenchInputFor<I extends keyof SessionWorkbenchInputMap> = SessionWorkbenchInputMap[I];

export type SessionRegistryWriteValue =
  | { type: "string"; value: string }
  | { type: "binary"; hex: string }
  | { type: "dword"; value: number }
  | { type: "qword"; value: string };

export type PrepareSessionDestructiveActionInput =
  | { actionId: "session.filesystem.cp"; source: string; destination: string }
  | { actionId: "session.filesystem.mv"; source: string; destination: string }
  | { actionId: "session.filesystem.rm"; path: string; recursive: boolean; force: boolean }
  | { actionId: "session.filesystem.chmod-recursive"; path: string; fileMode: string; recursive: true }
  | { actionId: "session.filesystem.chown-recursive"; path: string; uid: string; gid: string; recursive: true }
  | { actionId: "session.filesystem.memfiles.rm"; fd: string }
  | {
      actionId: "session.filesystem.upload-overwrite";
      remotePath: string;
      isIOC: boolean;
      isDirectory: false;
      overwrite: true;
    }
  | {
      actionId: "session.filesystem.edit-text-overwrite";
      contentHandle: string;
      remotePath: string;
      encoding: "utf-8";
      expectedSha256: string;
    }
  | {
      actionId: "session.filesystem.patch-hex";
      patchHandle: string;
      remotePath: string;
      expectedSha256: string;
    }
  | { actionId: "session.process.terminate"; pid: number; force: boolean }
  | { actionId: "session.service.stop"; name: string }
  | {
      actionId: "session.registry.write";
      hive: SessionRegistryHive;
      path: string;
      key: string;
      value: SessionRegistryWriteValue;
    }
  | { actionId: "session.registry.create-key"; hive: SessionRegistryHive; path: string; key: string }
  | { actionId: "session.registry.delete-key"; hive: SessionRegistryHive; path: string; key: string };

export interface SessionDestructiveActionPlan {
  token: string;
  expiresAt: string;
  payloadDigest: string;
  action: PrepareSessionDestructiveActionInput;
  target: {
    backend: {
      id: string;
      displayName: string;
    };
    sessionId: string;
    fingerprint: string;
    name: string;
    hostname: string;
    os: string;
  };
  warning: string;
  /** Main-derived identity bound to a process-termination plan to prevent PID reuse. */
  resource?: {
    kind: "process";
    pid: number;
    parentPid: number;
    executable: string;
    owner: string;
    architecture: string;
  };
  /** Present when prepare opened a native file and bound its bytes to the plan token. */
  artifact?: {
    suggestedBasename: string;
    size: number;
    sha256: string;
  };
}

export type SessionDestructiveActionPreparation =
  | {
      status: "prepared";
      plan: SessionDestructiveActionPlan;
    }
  | {
      status: "canceled";
    };

export interface ExecuteSessionDestructiveActionPlanInput {
  token: string;
}

export interface SessionDestructiveActionOutcome {
  actionId: SessionDestructiveActionId;
  status: "succeeded" | "failed" | "outcome-unknown" | "target-disappeared";
  message: string;
  payloadDigest: string;
}

export interface SessionWorkbenchResultMap {
  "session.identity.current-token-owner": SessionIdentityDetail;
  "session.environment.list": SessionBoundedPage<SessionEnvironmentEntry>;
  "session.environment.reveal": SessionEnvironmentRevealResult;
  "session.network.interfaces": SessionBoundedPage<SessionNetworkInterface>;
  "session.network.connections": SessionBoundedPage<SessionNetworkConnection>;
  "session.filesystem.pwd": SessionWorkingDirectoryResult;
  "session.filesystem.ls": SessionDirectoryListing;
  "session.filesystem.cat": SessionTextFileView;
  "session.filesystem.head": SessionTextFileView;
  "session.filesystem.tail": SessionTextFileView;
  "session.filesystem.read-hex": SessionHexFileView;
  "session.filesystem.grep": SessionBoundedPage<SessionGrepMatch>;
  "session.filesystem.mounts": SessionBoundedPage<SessionMount>;
  "session.filesystem.memfiles.list": SessionBoundedPage<SessionMemoryFile>;
  "session.process.list": SessionBoundedPage<SessionProcess>;
  "session.service.list": SessionBoundedPage<SessionService>;
  "session.service.detail": SessionService;
  "session.registry.read": SessionRegistryReadResult;
  "session.registry.list-subkeys": SessionBoundedPage<string>;
  "session.registry.list-values": SessionBoundedPage<string>;
  "session.filesystem.cd": SessionWorkingDirectoryResult;
  "session.filesystem.mkdir": SessionMutationResult;
  "session.filesystem.memfiles.add": SessionMutationResult;
  "session.filesystem.chmod": SessionMutationResult;
  "session.filesystem.chown": SessionMutationResult;
  "session.filesystem.chtimes": SessionMutationResult;
  "session.service.start": SessionService;
  "session.screenshot.capture": SessionCapturedArtifactResult;
  "session.artifact.save": SessionNativeSaveResult;
  "session.filesystem.download": SessionNativeSaveResult;
  "session.filesystem.add-to-loot": SessionLootAddResult;
  "session.filesystem.upload-open": SessionNativeOpenUploadResult;
  "session.filesystem.stage-text": SessionStagedEditorArtifactResult;
  "session.filesystem.stage-hex": SessionStagedEditorArtifactResult;
  "session.process.dump": SessionNativeSaveResult;
  "session.registry.read-hive": SessionNativeSaveResult;
  "session.filesystem.cp": SessionDestructiveActionOutcome;
  "session.filesystem.mv": SessionDestructiveActionOutcome;
  "session.filesystem.rm": SessionDestructiveActionOutcome;
  "session.filesystem.chmod-recursive": SessionDestructiveActionOutcome;
  "session.filesystem.chown-recursive": SessionDestructiveActionOutcome;
  "session.filesystem.memfiles.rm": SessionDestructiveActionOutcome;
  "session.filesystem.upload-overwrite": SessionDestructiveActionOutcome;
  "session.filesystem.edit-text-overwrite": SessionDestructiveActionOutcome;
  "session.filesystem.patch-hex": SessionDestructiveActionOutcome;
  "session.process.terminate": SessionDestructiveActionOutcome;
  "session.service.stop": SessionDestructiveActionOutcome;
  "session.registry.write": SessionDestructiveActionOutcome;
  "session.registry.create-key": SessionDestructiveActionOutcome;
  "session.registry.delete-key": SessionDestructiveActionOutcome;
}

export type SessionWorkbenchQueryResultMap = Pick<SessionWorkbenchResultMap, SessionWorkbenchQueryId>;
export type SessionWorkbenchMutationResultMap = Pick<SessionWorkbenchResultMap, SessionWorkbenchMutationId>;
export type SessionWorkbenchArtifactResultMap = Pick<SessionWorkbenchResultMap, SessionWorkbenchArtifactId>;
export type SessionDestructiveActionResultMap = Pick<SessionWorkbenchResultMap, SessionDestructiveActionId>;
export type SessionWorkbenchResultFor<I extends SessionWorkbenchOperationId> = SessionWorkbenchResultMap[I];
export type SessionWorkbenchResult = {
  [I in SessionWorkbenchOperationId]: { operationId: I; value: SessionWorkbenchResultMap[I] };
}[SessionWorkbenchOperationId];

export type SessionWorkbenchOutcomeUnknownOperationId =
  | SessionWorkbenchMutationId
  | "session.filesystem.add-to-loot"
  | "session.filesystem.upload-open";

export type SessionWorkbenchInvocationResult =
  | {
      status: "completed";
      result: SessionWorkbenchResult;
    }
  | {
      status: "outcome-unknown";
      operationId: SessionWorkbenchOutcomeUnknownOperationId;
      message: string;
    }
  | {
      status: "failed";
      operationId: SessionWorkbenchOutcomeUnknownOperationId;
      message: string;
    };

const ALL_PLATFORMS = ["windows", "linux", "darwin"] as const;
const WINDOWS_ONLY = ["windows"] as const;
const LINUX_ONLY = ["linux"] as const;
const LINUX_AND_WINDOWS = ["linux", "windows"] as const;

export const SESSION_WORKBENCH_PLATFORM_REQUIREMENTS: Readonly<
  Record<SessionWorkbenchOperationId, readonly SessionTargetPlatform[]>
> = Object.freeze({
  "session.identity.current-token-owner": WINDOWS_ONLY,
  "session.environment.list": ALL_PLATFORMS,
  "session.environment.reveal": ALL_PLATFORMS,
  "session.network.interfaces": ALL_PLATFORMS,
  "session.network.connections": ALL_PLATFORMS,
  "session.filesystem.pwd": ALL_PLATFORMS,
  "session.filesystem.ls": ALL_PLATFORMS,
  "session.filesystem.cat": ALL_PLATFORMS,
  "session.filesystem.head": ALL_PLATFORMS,
  "session.filesystem.tail": ALL_PLATFORMS,
  "session.filesystem.read-hex": ALL_PLATFORMS,
  "session.filesystem.grep": ALL_PLATFORMS,
  "session.filesystem.mounts": ALL_PLATFORMS,
  "session.filesystem.memfiles.list": LINUX_ONLY,
  "session.process.list": ALL_PLATFORMS,
  "session.service.list": WINDOWS_ONLY,
  "session.service.detail": WINDOWS_ONLY,
  "session.registry.read": WINDOWS_ONLY,
  "session.registry.list-subkeys": WINDOWS_ONLY,
  "session.registry.list-values": WINDOWS_ONLY,
  "session.filesystem.cd": ALL_PLATFORMS,
  "session.filesystem.mkdir": ALL_PLATFORMS,
  "session.filesystem.memfiles.add": LINUX_ONLY,
  "session.filesystem.chmod": LINUX_ONLY,
  "session.filesystem.chown": LINUX_ONLY,
  "session.filesystem.chtimes": ALL_PLATFORMS,
  "session.service.start": WINDOWS_ONLY,
  "session.screenshot.capture": LINUX_AND_WINDOWS,
  "session.artifact.save": ALL_PLATFORMS,
  "session.filesystem.download": ALL_PLATFORMS,
  "session.filesystem.add-to-loot": ALL_PLATFORMS,
  "session.filesystem.upload-open": ALL_PLATFORMS,
  "session.filesystem.stage-text": ALL_PLATFORMS,
  "session.filesystem.stage-hex": ALL_PLATFORMS,
  "session.process.dump": LINUX_AND_WINDOWS,
  "session.registry.read-hive": WINDOWS_ONLY,
  "session.filesystem.cp": ALL_PLATFORMS,
  "session.filesystem.mv": ALL_PLATFORMS,
  "session.filesystem.rm": ALL_PLATFORMS,
  "session.filesystem.chmod-recursive": LINUX_ONLY,
  "session.filesystem.chown-recursive": LINUX_ONLY,
  "session.filesystem.memfiles.rm": LINUX_ONLY,
  "session.filesystem.upload-overwrite": ALL_PLATFORMS,
  "session.filesystem.edit-text-overwrite": ALL_PLATFORMS,
  "session.filesystem.patch-hex": ALL_PLATFORMS,
  "session.process.terminate": ALL_PLATFORMS,
  "session.service.stop": WINDOWS_ONLY,
  "session.registry.write": WINDOWS_ONLY,
  "session.registry.create-key": WINDOWS_ONLY,
  "session.registry.delete-key": WINDOWS_ONLY,
});

export function sessionOperationSupportsPlatform(
  operationId: SessionWorkbenchOperationId,
  platform: string,
): boolean {
  return SESSION_WORKBENCH_PLATFORM_REQUIREMENTS[operationId].includes(platform as SessionTargetPlatform);
}

const SENSITIVE_ENVIRONMENT_NAME = /(?:^|_)(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?|COOKIE)(?:$|_)/iu;

export function isSensitiveSessionEnvironmentName(name: string): boolean {
  return SENSITIVE_ENVIRONMENT_NAME.test(name);
}

export function redactSessionEnvironment(
  variables: ReadonlyArray<{ name: string; value: string }>,
): SessionEnvironmentEntry[] {
  return variables.map(({ name, value }) => isSensitiveSessionEnvironmentName(name)
    ? { name, sensitive: true, redacted: true }
    : { name, value, sensitive: false, redacted: false });
}

export function parseSessionWorkbenchInput(value: unknown): SessionWorkbenchInput {
  const record = objectRecord(value, "Session workbench input");
  const operationId = requiredString(record, "operationId", 96) as SessionWorkbenchOperationId;
  if (!isDirectOperationId(operationId)) throw new Error("Unknown session workbench operation");
  const parsed = parseDirectInput(operationId, record);
  assertExactKeys(record, Object.keys(parsed));
  return parsed;
}

export function parseSessionDroppedUploadInput(value: unknown): SessionDroppedUploadInput {
  const record = objectRecord(value, "Dropped session upload input");
  const parsed: SessionDroppedUploadInput = {
    remotePath: requiredPath(record, "remotePath"),
    isIOC: requiredBoolean(record, "isIOC"),
    isDirectory: requiredFalse(record, "isDirectory"),
    overwrite: requiredFalse(record, "overwrite"),
  };
  assertExactKeys(record, Object.keys(parsed));
  return parsed;
}

export function parseSessionDroppedUploadIpcRequest(value: unknown): SessionDroppedUploadIpcRequest {
  const record = objectRecord(value, "Dropped session upload IPC request");
  const parsed: SessionDroppedUploadIpcRequest = {
    sourcePath: requiredString(record, "sourcePath", SESSION_DROPPED_UPLOAD_MAX_LOCAL_PATH_LENGTH),
    input: parseSessionDroppedUploadInput(record["input"]),
  };
  assertExactKeys(record, Object.keys(parsed));
  return parsed;
}

export function parsePrepareSessionDestructiveActionInput(value: unknown): PrepareSessionDestructiveActionInput {
  const record = objectRecord(value, "Session destructive action input");
  const actionId = requiredString(record, "actionId", 96) as SessionDestructiveActionId;
  if (!(SESSION_DESTRUCTIVE_ACTION_IDS as readonly string[]).includes(actionId)) {
    throw new Error("Unknown session destructive action");
  }
  const parsed = parseDestructiveInput(actionId, record);
  assertExactKeys(record, Object.keys(parsed));
  return parsed;
}

export function parseExecuteSessionDestructiveActionPlanInput(
  value: unknown,
): ExecuteSessionDestructiveActionPlanInput {
  const record = objectRecord(value, "Session destructive execution input");
  const parsed = { token: requiredString(record, "token", 512) };
  assertExactKeys(record, ["token"]);
  return parsed;
}

function parseDirectInput(
  operationId: keyof SessionWorkbenchInputMap,
  record: Record<string, unknown>,
): SessionWorkbenchInput {
  const page = () => parsePage(record);
  const searchPage = () => ({ ...page(), ...optionalStringField(record, "query", 256) });
  switch (operationId) {
    case "session.identity.current-token-owner":
    case "session.filesystem.pwd":
    case "session.filesystem.memfiles.add":
      return { operationId };
    case "session.environment.list":
    case "session.network.interfaces":
    case "session.filesystem.mounts":
    case "session.filesystem.memfiles.list":
      return { operationId, ...page() };
    case "session.environment.reveal":
      return { operationId, name: requiredString(record, "name", 512) };
    case "session.network.connections":
      return {
        operationId,
        tcp: requiredBoolean(record, "tcp"),
        udp: requiredBoolean(record, "udp"),
        ip4: requiredBoolean(record, "ip4"),
        ip6: requiredBoolean(record, "ip6"),
        listening: requiredBoolean(record, "listening"),
        ...page(),
      };
    case "session.filesystem.ls":
      return { operationId, path: requiredPath(record, "path"), ...page() };
    case "session.filesystem.cat":
    case "session.filesystem.head":
    case "session.filesystem.tail":
    case "session.filesystem.read-hex":
      return {
        operationId,
        path: requiredPath(record, "path"),
        maxBytes: requiredInteger(record, "maxBytes", 1, SESSION_EDITOR_MAX_BYTES),
      };
    case "session.filesystem.grep":
      return {
        operationId,
        path: requiredPath(record, "path"),
        pattern: requiredString(record, "pattern", 1_024),
        recursive: requiredBoolean(record, "recursive"),
        linesBefore: requiredInteger(record, "linesBefore", 0, 100),
        linesAfter: requiredInteger(record, "linesAfter", 0, 100),
        ...page(),
      };
    case "session.process.list":
      return { operationId, fullInfo: requiredBoolean(record, "fullInfo"), ...searchPage() };
    case "session.service.list":
      return { operationId, ...searchPage() };
    case "session.service.detail":
    case "session.service.start":
      return { operationId, name: requiredString(record, "name", 512) };
    case "session.registry.read":
      return {
        operationId,
        hive: requiredHive(record, "hive"),
        path: requiredRegistryPath(record, "path"),
        key: requiredRegistryValueName(record, "key"),
      };
    case "session.registry.list-subkeys":
    case "session.registry.list-values":
      return {
        operationId,
        hive: requiredHive(record, "hive"),
        path: requiredRegistryPath(record, "path"),
        ...page(),
      };
    case "session.filesystem.cd":
    case "session.filesystem.mkdir":
      return { operationId, path: requiredPath(record, "path") };
    case "session.filesystem.chmod":
      return {
        operationId,
        path: requiredPath(record, "path"),
        fileMode: requiredString(record, "fileMode", 32),
        recursive: requiredFalse(record, "recursive"),
      };
    case "session.filesystem.chown":
      return {
        operationId,
        path: requiredPath(record, "path"),
        uid: requiredString(record, "uid", 64),
        gid: requiredString(record, "gid", 64),
        recursive: requiredFalse(record, "recursive"),
      };
    case "session.filesystem.chtimes":
      return {
        operationId,
        path: requiredPath(record, "path"),
        accessTime: requiredString(record, "accessTime", 64),
        modificationTime: requiredString(record, "modificationTime", 64),
      };
    case "session.screenshot.capture":
      return { operationId };
    case "session.artifact.save":
      return { operationId, handle: requiredArtifactHandle(record, "handle") };
    case "session.filesystem.download":
    case "session.filesystem.add-to-loot":
      return {
        operationId,
        path: requiredPath(record, "path"),
        maxBytes: requiredInteger(record, "maxBytes", 1, SESSION_WORKBENCH_MAX_COMPLETE_FILE_BYTES),
      };
    case "session.filesystem.upload-open":
      return {
        operationId,
        remotePath: requiredPath(record, "remotePath"),
        isIOC: requiredBoolean(record, "isIOC"),
        isDirectory: requiredFalse(record, "isDirectory"),
        overwrite: requiredFalse(record, "overwrite"),
      };
    case "session.filesystem.stage-text":
      return {
        operationId,
        content: requiredUtf8EditorText(record, "content"),
        encoding: requiredLiteral(record, "encoding", "utf-8"),
      };
    case "session.filesystem.stage-hex":
      return { operationId, hex: requiredEditorHex(record, "hex") };
    case "session.process.dump":
      return {
        operationId,
        pid: requiredInteger(record, "pid", 1, 0x7fff_ffff),
        dumpTimeoutSeconds: requiredInteger(record, "dumpTimeoutSeconds", 1, 3_600),
      };
    case "session.registry.read-hive":
      return {
        operationId,
        rootHive: requiredHive(record, "rootHive"),
        requestedHive: requiredString(record, "requestedHive", SESSION_WORKBENCH_MAX_PATH_LENGTH),
        maxBytes: requiredInteger(record, "maxBytes", 1, SESSION_WORKBENCH_MAX_ARTIFACT_BYTES),
      };
  }
}

function parseDestructiveInput(
  actionId: SessionDestructiveActionId,
  record: Record<string, unknown>,
): PrepareSessionDestructiveActionInput {
  switch (actionId) {
    case "session.filesystem.cp":
    case "session.filesystem.mv":
      return { actionId, source: requiredPath(record, "source"), destination: requiredPath(record, "destination") };
    case "session.filesystem.rm":
      return {
        actionId,
        path: requiredPath(record, "path"),
        recursive: requiredBoolean(record, "recursive"),
        force: requiredBoolean(record, "force"),
      };
    case "session.filesystem.chmod-recursive":
      return {
        actionId,
        path: requiredPath(record, "path"),
        fileMode: requiredString(record, "fileMode", 32),
        recursive: requiredTrue(record, "recursive"),
      };
    case "session.filesystem.chown-recursive":
      return {
        actionId,
        path: requiredPath(record, "path"),
        uid: requiredString(record, "uid", 64),
        gid: requiredString(record, "gid", 64),
        recursive: requiredTrue(record, "recursive"),
      };
    case "session.filesystem.memfiles.rm":
      return { actionId, fd: requiredString(record, "fd", 128) };
    case "session.filesystem.upload-overwrite":
      return {
        actionId,
        remotePath: requiredPath(record, "remotePath"),
        isIOC: requiredBoolean(record, "isIOC"),
        isDirectory: requiredFalse(record, "isDirectory"),
        overwrite: requiredTrue(record, "overwrite"),
      };
    case "session.filesystem.edit-text-overwrite":
      return {
        actionId,
        contentHandle: requiredArtifactHandle(record, "contentHandle"),
        remotePath: requiredPath(record, "remotePath"),
        encoding: requiredLiteral(record, "encoding", "utf-8"),
        expectedSha256: requiredSha256(record, "expectedSha256"),
      };
    case "session.filesystem.patch-hex":
      return {
        actionId,
        patchHandle: requiredArtifactHandle(record, "patchHandle"),
        remotePath: requiredPath(record, "remotePath"),
        expectedSha256: requiredSha256(record, "expectedSha256"),
      };
    case "session.process.terminate":
      return { actionId, pid: requiredInteger(record, "pid", 1, 0x7fff_ffff), force: requiredBoolean(record, "force") };
    case "session.service.stop":
      return { actionId, name: requiredString(record, "name", 512) };
    case "session.registry.write":
      return {
        actionId,
        hive: requiredHive(record, "hive"),
        path: requiredRegistryPath(record, "path"),
        key: requiredRegistryValueName(record, "key"),
        value: parseRegistryWriteValue(record["value"]),
      };
    case "session.registry.create-key":
    case "session.registry.delete-key":
      return {
        actionId,
        hive: requiredHive(record, "hive"),
        path: requiredRegistryPath(record, "path"),
        key: requiredString(record, "key", 512),
      };
  }
}

export function parseRegistryWriteValue(value: unknown): SessionRegistryWriteValue {
  const record = objectRecord(value, "Registry value");
  const type = requiredString(record, "type", 16);
  switch (type) {
    case "string": {
      const parsed = { type, value: requiredPossiblyEmptyString(record, "value", SESSION_WORKBENCH_MAX_TEXT_LENGTH) } as const;
      assertExactKeys(record, ["type", "value"]);
      return parsed;
    }
    case "binary": {
      const hex = requiredPossiblyEmptyString(record, "hex", SESSION_WORKBENCH_MAX_TEXT_LENGTH);
      if (!/^(?:[0-9a-f]{2})*$/iu.test(hex)) throw new Error("Registry binary value must be even-length hexadecimal");
      assertExactKeys(record, ["type", "hex"]);
      return { type, hex };
    }
    case "dword": {
      const parsed = { type, value: requiredInteger(record, "value", 0, 0xffff_ffff) } as const;
      assertExactKeys(record, ["type", "value"]);
      return parsed;
    }
    case "qword": {
      const qword = requiredString(record, "value", 20);
      if (!/^\d+$/u.test(qword) || BigInt(qword) > 0xffff_ffff_ffff_ffffn) {
        throw new Error("Registry QWORD value must be an unsigned 64-bit decimal integer");
      }
      assertExactKeys(record, ["type", "value"]);
      return { type, value: qword };
    }
    default:
      throw new Error("Unsupported registry value type");
  }
}

function parsePage(record: Record<string, unknown>): SessionPageRequest {
  return {
    ...optionalStringField(record, "cursor", SESSION_WORKBENCH_MAX_CURSOR_LENGTH),
    ...optionalIntegerField(record, "limit", 1, SESSION_WORKBENCH_MAX_PAGE_LIMIT),
  };
}

function isDirectOperationId(value: string): value is keyof SessionWorkbenchInputMap {
  return [
    ...SESSION_WORKBENCH_QUERY_IDS,
    ...SESSION_WORKBENCH_MUTATION_IDS,
    ...SESSION_WORKBENCH_ARTIFACT_IDS,
  ].includes(value as never);
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return record;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const allowed = new Set(expected);
  const extras = Object.keys(record).filter((key) => !allowed.has(key));
  if (extras.length > 0) throw new Error(`Unexpected session input field: ${extras[0]}`);
}

function requiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function requiredPath(record: Record<string, unknown>, key: string): string {
  return requiredString(record, key, SESSION_WORKBENCH_MAX_PATH_LENGTH);
}

function requiredRegistryPath(record: Record<string, unknown>, key: string): string {
  return requiredPossiblyEmptyString(record, key, SESSION_WORKBENCH_MAX_PATH_LENGTH);
}

function requiredRegistryValueName(record: Record<string, unknown>, key: string): string {
  return requiredPossiblyEmptyString(record, key, 512);
}

function requiredPossiblyEmptyString(record: Record<string, unknown>, key: string, maxLength: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${key} must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  if (typeof record[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  return record[key];
}

function requiredTrue(record: Record<string, unknown>, key: string): true {
  if (record[key] !== true) throw new Error(`${key} must be true`);
  return true;
}

function requiredFalse(record: Record<string, unknown>, key: string): false {
  if (record[key] !== false) throw new Error(`${key} must be false`);
  return false;
}

function requiredInteger(record: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${key} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function optionalStringField(record: Record<string, unknown>, key: string, maxLength: number): Record<string, string> {
  if (record[key] === undefined) return {};
  return { [key]: requiredString(record, key, maxLength) };
}

function optionalIntegerField(
  record: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): Record<string, number> {
  if (record[key] === undefined) return {};
  return { [key]: requiredInteger(record, key, min, max) };
}

function requiredHive(record: Record<string, unknown>, key: string): SessionRegistryHive {
  const value = requiredString(record, key, 4);
  if (!(new Set<string>(["HKCU", "HKLM", "HKCR", "HKU", "HKCC"])).has(value)) {
    throw new Error(`${key} is not a supported registry hive`);
  }
  return value as SessionRegistryHive;
}

function requiredArtifactHandle(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 128);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) throw new Error(`${key} is not a valid session artifact handle`);
  return value;
}

function requiredLiteral<T extends string>(record: Record<string, unknown>, key: string, expected: T): T {
  if (record[key] !== expected) throw new Error(`${key} must equal ${expected}`);
  return expected;
}

function requiredSha256(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 64);
  if (!/^[0-9a-f]{64}$/iu.test(value)) throw new Error(`${key} must be a SHA-256 digest`);
  return value.toLocaleLowerCase();
}

function requiredUtf8EditorText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be UTF-8 text`);
  const byteLength = strictUtf8ByteLength(value);
  if (byteLength > SESSION_EDITOR_MAX_BYTES) {
    throw new Error(`${key} must not exceed ${SESSION_EDITOR_MAX_BYTES} UTF-8 bytes`);
  }
  return value;
}

function requiredEditorHex(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length > SESSION_EDITOR_MAX_BYTES * 2) {
    throw new Error(`${key} must encode at most ${SESSION_EDITOR_MAX_BYTES} bytes`);
  }
  if (!/^(?:[0-9a-f]{2})*$/iu.test(value)) {
    throw new Error(`${key} must be even-length hexadecimal`);
  }
  return value.toLocaleLowerCase();
}

function strictUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (first <= 0x7f) {
      bytes += 1;
    } else if (first <= 0x7ff) {
      bytes += 2;
    } else if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(index + 1);
      if (!(second >= 0xdc00 && second <= 0xdfff)) throw new Error("content must be valid UTF-8 text");
      bytes += 4;
      index += 1;
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      throw new Error("content must be valid UTF-8 text");
    } else {
      bytes += 3;
    }
    if (bytes > SESSION_EDITOR_MAX_BYTES) return bytes;
  }
  return bytes;
}
