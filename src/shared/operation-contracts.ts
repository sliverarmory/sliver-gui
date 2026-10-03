import type { PageResult } from "./contracts.js";
import type { ExecutionOperationId, ExecutionReadResult } from "./execution-contracts.js";
import { parseRegistryWriteValue, type SessionRegistryHive, type SessionRegistryWriteValue, type SessionWorkbenchOperationId } from "./session-contracts.js";
import type { TargetMode, TargetRef } from "./target-contracts.js";

export type { TargetMode, TargetRef } from "./target-contracts.js";

export const TARGET_OPERATION_IDS = Object.freeze([
  "target.ping",
  "target.rename",
  "target.env-set",
  "target.env-unset",
  "beacon.reconfigure",
  "beacon.open-session",
  "beacon.filesystem.pwd",
  "beacon.filesystem.ls",
  "beacon.process.list",
  "beacon.network.interfaces",
  "beacon.environment.list",
  "beacon.identity.whoami",
  "beacon.network.netstat",
  "beacon.filesystem.mount",
  "beacon.filesystem.memfiles",
  "beacon.filesystem.cat",
  "beacon.filesystem.head",
  "beacon.filesystem.tail",
  "beacon.filesystem.grep",
  "beacon.registry.read",
  "beacon.registry.list-subkeys",
  "beacon.registry.list-values",
  "beacon.registry.write",
  "beacon.registry.create",
  "beacon.registry.delete",
  "beacon.service.list",
  "beacon.service.info",
  "beacon.service.start",
  "beacon.service.stop",
] as const);

export const BEACON_MUTATION_OPERATION_IDS = Object.freeze([
  "beacon.registry.write",
  "beacon.registry.create",
  "beacon.registry.delete",
  "beacon.service.start",
  "beacon.service.stop",
] as const);

export type TargetOperationId = (typeof TARGET_OPERATION_IDS)[number];

/**
 * Every operation identifier that may appear in the main-owned activity
 * journal. `TargetOperationId` remains the smaller renderer-submittable M1
 * dispatcher surface; session workbench identifiers are journal-only here and
 * keep their own closed input parser.
 */
export type OperationRecordId = TargetOperationId | SessionWorkbenchOperationId | ExecutionOperationId;

export interface PingOperationInput {
  operationId: "target.ping";
}

export interface RenameTargetOperationInput {
  operationId: "target.rename";
  name: string;
}

export interface SetEnvironmentOperationInput {
  operationId: "target.env-set";
  name: string;
  value: string;
}

export interface UnsetEnvironmentOperationInput {
  operationId: "target.env-unset";
  name: string;
}

export interface ReconfigureBeaconOperationInput {
  operationId: "beacon.reconfigure";
  reconnectIntervalSeconds?: number;
  intervalSeconds?: number;
  jitterSeconds?: number;
}

export interface OpenBeaconSessionOperationInput {
  operationId: "beacon.open-session";
  delaySeconds: number;
}

export interface BeaconWorkingDirectoryOperationInput {
  operationId: "beacon.filesystem.pwd";
}

export interface BeaconDirectoryListingOperationInput {
  operationId: "beacon.filesystem.ls";
  path: string;
}

export interface BeaconProcessListOperationInput {
  operationId: "beacon.process.list";
  fullInfo: boolean;
}

export interface BeaconNetworkInterfacesOperationInput {
  operationId: "beacon.network.interfaces";
}

export interface BeaconEnvironmentListOperationInput {
  operationId: "beacon.environment.list";
  name?: string;
}

export interface BeaconNetstatOperationInput {
  operationId: "beacon.network.netstat";
  tcp: boolean;
  udp: boolean;
  ip4: boolean;
  ip6: boolean;
  listen: boolean;
}

export interface BeaconTextFileOperationInput {
  operationId: "beacon.filesystem.cat";
  path: string;
}

export interface BeaconFileEdgeOperationInput {
  operationId: "beacon.filesystem.head" | "beacon.filesystem.tail";
  path: string;
  bytes?: number;
  lines?: number;
}

export interface BeaconGrepOperationInput {
  operationId: "beacon.filesystem.grep";
  path: string;
  pattern: string;
  recursive: boolean;
  before: number;
  after: number;
}

export interface BeaconRegistryLocation {
  hive: SessionRegistryHive;
  path: string;
  hostname?: string;
}

export type BeaconRegistryOperationInput =
  | ({ operationId: "beacon.registry.read"; key: string } & BeaconRegistryLocation)
  | ({ operationId: "beacon.registry.list-subkeys" } & BeaconRegistryLocation)
  | ({ operationId: "beacon.registry.list-values" } & BeaconRegistryLocation)
  | ({ operationId: "beacon.registry.write"; key: string; value: SessionRegistryWriteValue } & BeaconRegistryLocation)
  | ({ operationId: "beacon.registry.create"; key: string } & BeaconRegistryLocation)
  | ({ operationId: "beacon.registry.delete"; key: string } & BeaconRegistryLocation);

export type BeaconServiceOperationInput =
  | { operationId: "beacon.service.list"; hostname?: string }
  | { operationId: "beacon.service.info"; name: string; hostname?: string }
  | { operationId: "beacon.service.start"; name: string; hostname?: string }
  | { operationId: "beacon.service.stop"; name: string; hostname?: string };

export type BeaconMutationOperationInput = Extract<BeaconRegistryOperationInput | BeaconServiceOperationInput,
  { operationId: "beacon.registry.write" | "beacon.registry.create" | "beacon.registry.delete" |
    "beacon.service.start" | "beacon.service.stop" }>;

export interface BeaconMutationPlan {
  token: string;
  expiresAt: string;
  target: TargetRef;
  targetName: string;
  backend: OperationBackendSummary;
  operationId: BeaconMutationOperationInput["operationId"];
  summary: string;
  fields: StructuredDetailField[];
  payloadSha256: string;
}

export interface BeaconMutationTokenInput { token: string }

/**
 * The complete renderer-submittable operation surface. The selected target is
 * intentionally absent: the main process resolves it from the calling
 * window's authoritative target context.
 */
export type TargetOperationInput =
  | PingOperationInput
  | RenameTargetOperationInput
  | SetEnvironmentOperationInput
  | UnsetEnvironmentOperationInput
  | ReconfigureBeaconOperationInput
  | OpenBeaconSessionOperationInput
  | BeaconWorkingDirectoryOperationInput
  | BeaconDirectoryListingOperationInput
  | BeaconProcessListOperationInput
  | BeaconNetworkInterfacesOperationInput
  | BeaconEnvironmentListOperationInput
  | { operationId: "beacon.identity.whoami" |
      "beacon.filesystem.mount" | "beacon.filesystem.memfiles" }
  | BeaconNetstatOperationInput
  | BeaconTextFileOperationInput
  | BeaconFileEdgeOperationInput
  | BeaconGrepOperationInput
  | BeaconRegistryOperationInput
  | BeaconServiceOperationInput;

export const TARGET_OPERATION_STATES = Object.freeze([
  "queued",
  "submitting",
  "submitted",
  "running",
  "cancel-requested",
  "completed",
  "failed",
  "canceled",
  "partial",
  "outcome-unknown",
  "target-disappeared",
] as const);

export type TargetOperationState = (typeof TARGET_OPERATION_STATES)[number];

export type OperationActorSummary =
  | {
      attribution: "verified";
      name: string;
    }
  | {
      attribution: "unknown";
    };

export type OperationOwnership =
  | {
      origin: "local";
      ownerWindowId: number;
      actor: OperationActorSummary;
    }
  | {
      origin: "external";
      actor: OperationActorSummary;
    }
  | {
      origin: "unknown";
      actor: { attribution: "unknown" };
    };

export interface OperationBackendSummary {
  configId: string;
  configName: string;
  server: string;
  operator: string;
  epoch: number;
}

export interface OperationProgressSummary {
  completedUnits: number;
  totalUnits?: number;
  message?: string;
}

export type OperationScalar = string | number | boolean | null;

export interface InlineTextDisposition {
  kind: "inline-text";
  text: string;
  truncated: boolean;
}

export interface TableDisposition {
  kind: "table";
  columns: string[];
  rows: OperationScalar[][];
  truncated: boolean;
}

export interface StructuredDetailField {
  label: string;
  value: OperationScalar;
}

export interface StructuredDetailDisposition {
  kind: "structured-detail";
  title: string;
  fields: StructuredDetailField[];
  truncated: boolean;
}

/**
 * An opaque, short-lived main-process capability. It is not a filesystem path
 * and cannot be used to select an arbitrary file or backend resource.
 */
export interface SafeArtifactHandle {
  handle: string;
  suggestedFileName: string;
  mediaType: string;
  size: number;
  expiresAt: string;
}

export interface NativeSaveDisposition extends SafeArtifactHandle {
  kind: "native-save";
}

export interface LootSaveDisposition extends SafeArtifactHandle {
  kind: "loot-save";
  lootName: string;
}

export interface BinaryPreviewDisposition {
  kind: "binary-preview";
  previewHandle: string;
  mediaType: string;
  size: number;
  expiresAt: string;
}

export interface StreamAttachmentDisposition {
  kind: "stream-attachment";
  streamHandle: string;
  suggestedFileName: string;
  mediaType: string;
  expiresAt: string;
}

export const OPERATION_DISPOSITION_KINDS = Object.freeze([
  "inline-text",
  "table",
  "structured-detail",
  "native-save",
  "loot-save",
  "binary-preview",
  "stream-attachment",
] as const);

export type OperationDispositionKind = (typeof OPERATION_DISPOSITION_KINDS)[number];

export type OperationDisposition =
  | InlineTextDisposition
  | TableDisposition
  | StructuredDetailDisposition
  | NativeSaveDisposition
  | LootSaveDisposition
  | BinaryPreviewDisposition
  | StreamAttachmentDisposition;

export interface TargetOperationRecord {
  readonly requestId: string;
  readonly operationId: OperationRecordId;
  readonly target: TargetRef;
  readonly targetName: string;
  readonly backend: OperationBackendSummary;
  readonly ownership: OperationOwnership;
  readonly mode: TargetMode;
  readonly cancellation?: "not-supported" | "best-effort-beacon-task";
  state: TargetOperationState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
  deadlineAt?: string;
  finishedAt?: string;
  taskId?: string;
  progress?: OperationProgressSummary;
  message?: string;
  disposition?: OperationDisposition;
}

export interface OperationPageRequest {
  cursor?: string;
  limit?: number;
}

export type TargetOperationPage = PageResult<TargetOperationRecord>;

export interface CancelTargetOperationInput {
  requestId: string;
}

export const BEACON_TASK_STATES = Object.freeze([
  "pending",
  "sent",
  "completed",
  "canceled",
  "failed",
  "unknown",
] as const);

export type BeaconTaskState = (typeof BEACON_TASK_STATES)[number];

export interface BeaconTaskCancellationState {
  available: boolean;
  reason?: string;
}

export interface BeaconTaskSummary {
  readonly taskId: string;
  readonly beaconId: string;
  state: BeaconTaskState;
  description: string;
  createdAt?: string;
  sentAt?: string;
  completedAt?: string;
  resultAvailable: boolean;
  cancellation: BeaconTaskCancellationState;
  localRequestId?: string;
  ownership: OperationOwnership;
}

/** Decoded, bounded result fields and output. Full raw protobuf request/response buffers are never shared. */
export interface BeaconTaskDetail extends BeaconTaskSummary {
  operationId?: TargetOperationId;
  execution?: BeaconTaskExecutionOutput;
  /** Main-decoded, task-bound first page of an execution inventory. */
  executionRead?: ExecutionReadResult;
  disposition?: OperationDisposition;
  error?: string;
  errorKind?: "target-reported" | "decode-uncertain";
}

/** Independent bounded execution streams; encoded task requests and responses stay in main. */
export interface BeaconTaskExecutionOutput {
  operationId: ExecutionOperationId | "bof.execute";
  pid?: number;
  exitCode?: number;
  stdout?: { data: Uint8Array; truncated: boolean };
  stderr?: { data: Uint8Array; truncated: boolean };
  outputError?: string;
}

export type ListBeaconTasksInput = OperationPageRequest;

export type BeaconTaskPage = PageResult<BeaconTaskSummary>;

export interface GetBeaconTaskInput {
  taskId: string;
}

export interface GetBeaconTaskResponseInput extends GetBeaconTaskInput {
  offset?: number;
}

/** A page of the complete main-decoded response, independent of preview limits. */
export interface BeaconTaskResponse {
  readonly beaconId: string;
  readonly taskId: string;
  format: "text" | "json" | "hex";
  text: string;
  offset: number;
  totalCharacters: number;
  nextOffset?: number;
}

export interface CancelBeaconTaskInput {
  taskId: string;
}

export interface TargetOperationChangedEvent {
  type: "operation-changed";
  operation: TargetOperationRecord;
}

export type BeaconTasksInvalidationReason =
  | "initial-refresh"
  | "server-event"
  | "explicit-refresh"
  | "reconnect"
  | "operation-submitted"
  | "cancel-requested";

export interface BeaconTasksInvalidatedEvent {
  type: "beacon-tasks-invalidated";
  beacon: TargetRef;
  reason: BeaconTasksInvalidationReason;
}

export type OperationEvent = TargetOperationChangedEvent | BeaconTasksInvalidatedEvent;

export const OPERATION_INPUT_LIMITS = Object.freeze({
  renameLength: 32,
  environmentNameLength: 256,
  environmentValueLength: 16_384,
  beaconPathLength: 4_096,
  beaconPatternLength: 1_024,
  beaconTextBytes: 65_536,
  beaconTextLines: 4_096,
  beaconGrepContextLines: 64,
  beaconRegistryPathLength: 4_096,
  beaconRegistryKeyLength: 512,
  beaconRegistryValueBytes: 16_384,
  beaconHostnameLength: 255,
  beaconServiceNameLength: 256,
  maximumIntervalSeconds: 604_800,
  maximumDelaySeconds: 86_400,
  pageCursorLength: 256,
  pageLimit: 100,
  identifierLength: 128,
} as const);

const TARGET_NAME_PATTERN = /^(?!\.{1,2}$)(?!\.\.)[A-Za-z0-9._-]{1,32}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

export function isTargetOperationId(value: unknown): value is TargetOperationId {
  return typeof value === "string" && (TARGET_OPERATION_IDS as readonly string[]).includes(value);
}

export function isBeaconMutationOperationId(value: unknown): value is BeaconMutationOperationInput["operationId"] {
  return typeof value === "string" && (BEACON_MUTATION_OPERATION_IDS as readonly string[]).includes(value);
}

export function parseBeaconMutationInput(value: unknown): BeaconMutationOperationInput {
  const input = parseTargetOperationInput(value);
  if (!isBeaconMutationOperationId(input.operationId)) throw new TypeError("This command does not require beacon mutation review");
  return input as BeaconMutationOperationInput;
}

export function parseBeaconMutationTokenInput(value: unknown): BeaconMutationTokenInput {
  const record = requirePlainRecord(value, "beacon mutation token");
  requireExactKeys(record, ["token"]);
  return { token: parseIdentifier(record["token"], "token") };
}

export function parseTargetOperationInput(value: unknown): TargetOperationInput {
  const record = requirePlainRecord(value, "operation input");
  const operationId = record["operationId"];
  if (!isTargetOperationId(operationId)) {
    throw new TypeError("operationId is not an allowed target operation");
  }

  switch (operationId) {
    case "target.ping":
      requireExactKeys(record, ["operationId"]);
      return { operationId };
    case "target.rename": {
      requireExactKeys(record, ["operationId", "name"]);
      const name = requireString(record["name"], "name", OPERATION_INPUT_LIMITS.renameLength);
      if (!TARGET_NAME_PATTERN.test(name)) {
        throw new TypeError("name must use 1-32 letters, numbers, dots, dashes, or underscores");
      }
      return { operationId, name };
    }
    case "target.env-set": {
      requireExactKeys(record, ["operationId", "name", "value"]);
      const name = parseEnvironmentName(record["name"]);
      const environmentValue = requireString(
        record["value"],
        "value",
        OPERATION_INPUT_LIMITS.environmentValueLength,
        true,
      );
      if (environmentValue.includes("\0")) {
        throw new TypeError("value must not contain NUL characters");
      }
      return { operationId, name, value: environmentValue };
    }
    case "target.env-unset":
      requireExactKeys(record, ["operationId", "name"]);
      return { operationId, name: parseEnvironmentName(record["name"]) };
    case "beacon.reconfigure":
      return parseBeaconReconfigureInput(record);
    case "beacon.open-session":
      return parseOpenBeaconSessionInput(record);
    case "beacon.filesystem.pwd":
    case "beacon.network.interfaces":
    case "beacon.identity.whoami":
    case "beacon.filesystem.mount":
    case "beacon.filesystem.memfiles":
      requireExactKeys(record, ["operationId"]);
      return { operationId };
    case "beacon.environment.list": {
      requireAllowedKeys(record, ["operationId", "name"]);
      return { operationId, ...(record["name"] === undefined ? {} : { name: parseEnvironmentName(record["name"]) }) };
    }
    case "beacon.filesystem.ls": {
      requireExactKeys(record, ["operationId", "path"]);
      const path = requireString(record["path"], "path", OPERATION_INPUT_LIMITS.beaconPathLength);
      if (path.includes("\0")) throw new TypeError("path must not contain NUL characters");
      return { operationId, path };
    }
    case "beacon.process.list":
      requireExactKeys(record, ["operationId", "fullInfo"]);
      if (typeof record["fullInfo"] !== "boolean") throw new TypeError("fullInfo must be a boolean");
      return { operationId, fullInfo: record["fullInfo"] };
    case "beacon.network.netstat": {
      requireExactKeys(record, ["operationId", "tcp", "udp", "ip4", "ip6", "listen"]);
      for (const name of ["tcp", "udp", "ip4", "ip6", "listen"] as const) {
        if (typeof record[name] !== "boolean") throw new TypeError(`${name} must be a boolean`);
      }
      return { operationId, tcp: record["tcp"] as boolean, udp: record["udp"] as boolean,
        ip4: record["ip4"] as boolean, ip6: record["ip6"] as boolean, listen: record["listen"] as boolean };
    }
    case "beacon.filesystem.cat":
      requireExactKeys(record, ["operationId", "path"]);
      return { operationId, path: parseBeaconPath(record["path"]) };
    case "beacon.filesystem.head":
    case "beacon.filesystem.tail": {
      requireAllowedKeys(record, ["operationId", "path", "bytes", "lines"]);
      const path = parseBeaconPath(record["path"]);
      if (record["bytes"] !== undefined && record["lines"] !== undefined) {
        throw new TypeError("choose either bytes or lines");
      }
      const bytes = record["bytes"] === undefined ? undefined :
        requireInteger(record["bytes"], "bytes", 1, OPERATION_INPUT_LIMITS.beaconTextBytes);
      const lines = record["lines"] === undefined ? undefined :
        requireInteger(record["lines"], "lines", 1, OPERATION_INPUT_LIMITS.beaconTextLines);
      if (bytes === undefined && lines === undefined) throw new TypeError("choose a byte or line count");
      if (operationId === "beacon.filesystem.tail" && lines !== undefined) {
        throw new TypeError("beacon tail line mode is unavailable because the target reads the entire file first");
      }
      return { operationId, path, ...(bytes === undefined ? {} : { bytes }), ...(lines === undefined ? {} : { lines }) };
    }
    case "beacon.filesystem.grep": {
      requireExactKeys(record, ["operationId", "path", "pattern", "recursive", "before", "after"]);
      const path = parseBeaconPath(record["path"]);
      const pattern = requireString(record["pattern"], "pattern", OPERATION_INPUT_LIMITS.beaconPatternLength);
      if (pattern.includes("\0")) throw new TypeError("pattern must not contain NUL characters");
      if (typeof record["recursive"] !== "boolean") throw new TypeError("recursive must be a boolean");
      const before = requireInteger(record["before"], "before", 0, OPERATION_INPUT_LIMITS.beaconGrepContextLines);
      const after = requireInteger(record["after"], "after", 0, OPERATION_INPUT_LIMITS.beaconGrepContextLines);
      return { operationId, path, pattern, recursive: record["recursive"], before, after };
    }
    case "beacon.registry.read":
    case "beacon.registry.list-subkeys":
    case "beacon.registry.list-values":
    case "beacon.registry.write":
    case "beacon.registry.create":
    case "beacon.registry.delete":
      return parseBeaconRegistryInput(operationId, record);
    case "beacon.service.list":
    case "beacon.service.info":
    case "beacon.service.start":
    case "beacon.service.stop":
      return parseBeaconServiceInput(operationId, record);
  }
}

function parseBeaconRegistryInput(
  operationId: BeaconRegistryOperationInput["operationId"],
  record: Record<string, unknown>,
): BeaconRegistryOperationInput {
  const needsKey = operationId !== "beacon.registry.list-subkeys" && operationId !== "beacon.registry.list-values";
  const needsValue = operationId === "beacon.registry.write";
  requireAllowedKeys(record, ["operationId", "hive", "path", "hostname", ...(needsKey ? ["key"] : []), ...(needsValue ? ["value"] : [])]);
  const hive = requireString(record["hive"], "hive", 4);
  if (!["HKCU", "HKLM", "HKCR", "HKU", "HKCC"].includes(hive)) throw new TypeError("hive is not supported");
  const path = requireString(record["path"], "path", OPERATION_INPUT_LIMITS.beaconRegistryPathLength, true);
  if (path.includes("\0")) throw new TypeError("path must not contain NUL characters");
  assertWellFormedUtf16(path, "path");
  const hostname = parseOptionalBeaconHostname(record["hostname"]);
  const location: BeaconRegistryLocation = { hive: hive as SessionRegistryHive, path, ...(hostname ? { hostname } : {}) };
  if (!needsKey) return { operationId, ...location } as BeaconRegistryOperationInput;
  const key = requireString(record["key"], "key", OPERATION_INPUT_LIMITS.beaconRegistryKeyLength,
    operationId === "beacon.registry.read" || operationId === "beacon.registry.write");
  if (key.includes("\0")) throw new TypeError("key must not contain NUL characters");
  assertWellFormedUtf16(key, "key");
  if (!needsValue) return { operationId, ...location, key } as BeaconRegistryOperationInput;
  if (record["value"] === undefined) throw new TypeError("value is required");
  const parsedValue = parseRegistryWriteValue(record["value"]);
  // Protobuf uint64 decoding produces canonical decimal text. Keep the
  // reviewed value in that form so saved-request verification remains exact
  // when the operator enters leading zeroes.
  const value = parsedValue.type === "qword"
    ? { type: "qword" as const, value: BigInt(parsedValue.value).toString() }
    : parsedValue;
  if (value.type === "string") {
    if (value.value.includes("\0")) throw new TypeError("Registry string value must not contain NUL characters");
    assertWellFormedUtf16(value.value, "Registry string value");
  }
  const bytes = value.type === "binary" ? value.hex.length / 2 : value.type === "string" ?
    new TextEncoder().encode(value.value).length : 8;
  if (bytes > OPERATION_INPUT_LIMITS.beaconRegistryValueBytes) throw new TypeError("Registry value exceeds the beacon write limit");
  return { operationId, ...location, key, value };
}

function parseBeaconServiceInput(
  operationId: BeaconServiceOperationInput["operationId"],
  record: Record<string, unknown>,
): BeaconServiceOperationInput {
  const needsName = operationId !== "beacon.service.list";
  requireAllowedKeys(record, ["operationId", "hostname", ...(needsName ? ["name"] : [])]);
  const hostname = parseOptionalBeaconHostname(record["hostname"]);
  if (!needsName) return { operationId, ...(hostname ? { hostname } : {}) };
  const name = requireString(record["name"], "name", OPERATION_INPUT_LIMITS.beaconServiceNameLength);
  if (name.includes("\0")) throw new TypeError("name must not contain NUL characters");
  assertWellFormedUtf16(name, "name");
  return { operationId, name, ...(hostname ? { hostname } : {}) } as BeaconServiceOperationInput;
}

function parseOptionalBeaconHostname(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const hostname = requireString(value, "hostname", OPERATION_INPUT_LIMITS.beaconHostnameLength);
  if (hostname.includes("\0")) throw new TypeError("hostname must not contain NUL characters");
  assertWellFormedUtf16(hostname, "hostname");
  return hostname;
}

function assertWellFormedUtf16(value: string, name: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(++index);
      if (following < 0xdc00 || following > 0xdfff || Number.isNaN(following)) {
        throw new TypeError(`${name} must contain well-formed Unicode text`);
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${name} must contain well-formed Unicode text`);
    }
  }
}

function parseBeaconPath(value: unknown): string {
  const path = requireString(value, "path", OPERATION_INPUT_LIMITS.beaconPathLength);
  if (path.includes("\0")) throw new TypeError("path must not contain NUL characters");
  return path;
}

export function parseOperationPageRequest(value: unknown): OperationPageRequest {
  if (value === undefined) {
    return {};
  }
  const record = requirePlainRecord(value, "page request");
  requireAllowedKeys(record, ["cursor", "limit"]);
  const parsed: OperationPageRequest = {};
  if (record["cursor"] !== undefined) {
    parsed.cursor = requireString(record["cursor"], "cursor", OPERATION_INPUT_LIMITS.pageCursorLength);
  }
  if (record["limit"] !== undefined) {
    parsed.limit = requireInteger(record["limit"], "limit", 1, OPERATION_INPUT_LIMITS.pageLimit);
  }
  return parsed;
}

export function parseCancelTargetOperationInput(value: unknown): CancelTargetOperationInput {
  const record = requirePlainRecord(value, "cancel operation input");
  requireExactKeys(record, ["requestId"]);
  return { requestId: parseIdentifier(record["requestId"], "requestId") };
}

export function parseGetBeaconTaskInput(value: unknown): GetBeaconTaskInput {
  const record = requirePlainRecord(value, "get beacon task input");
  requireExactKeys(record, ["taskId"]);
  return { taskId: parseIdentifier(record["taskId"], "taskId") };
}

export function parseGetBeaconTaskResponseInput(value: unknown): GetBeaconTaskResponseInput {
  const record = requirePlainRecord(value, "get beacon task response input");
  requireAllowedKeys(record, ["taskId", "offset"]);
  const parsed: GetBeaconTaskResponseInput = { taskId: parseIdentifier(record["taskId"], "taskId") };
  if (record["offset"] !== undefined) {
    parsed.offset = requireInteger(record["offset"], "offset", 0, Number.MAX_SAFE_INTEGER);
  }
  return parsed;
}

export function parseCancelBeaconTaskInput(value: unknown): CancelBeaconTaskInput {
  const record = requirePlainRecord(value, "cancel beacon task input");
  requireExactKeys(record, ["taskId"]);
  return { taskId: parseIdentifier(record["taskId"], "taskId") };
}

function parseBeaconReconfigureInput(record: Record<string, unknown>): ReconfigureBeaconOperationInput {
  requireAllowedKeys(record, [
    "operationId",
    "reconnectIntervalSeconds",
    "intervalSeconds",
    "jitterSeconds",
  ]);
  const parsed: ReconfigureBeaconOperationInput = { operationId: "beacon.reconfigure" };
  if (record["reconnectIntervalSeconds"] !== undefined) {
    parsed.reconnectIntervalSeconds = requireInteger(
      record["reconnectIntervalSeconds"],
      "reconnectIntervalSeconds",
      1,
      OPERATION_INPUT_LIMITS.maximumIntervalSeconds,
    );
  }
  if (record["intervalSeconds"] !== undefined) {
    parsed.intervalSeconds = requireInteger(
      record["intervalSeconds"],
      "intervalSeconds",
      1,
      OPERATION_INPUT_LIMITS.maximumIntervalSeconds,
    );
  }
  if (record["jitterSeconds"] !== undefined) {
    parsed.jitterSeconds = requireInteger(
      record["jitterSeconds"],
      "jitterSeconds",
      1,
      OPERATION_INPUT_LIMITS.maximumIntervalSeconds,
    );
  }
  if (Object.keys(parsed).length === 1) {
    throw new TypeError("beacon.reconfigure requires at least one changed value");
  }
  return parsed;
}

function parseOpenBeaconSessionInput(record: Record<string, unknown>): OpenBeaconSessionOperationInput {
  requireExactKeys(record, ["operationId", "delaySeconds"]);
  return {
    operationId: "beacon.open-session",
    delaySeconds: requireInteger(
      record["delaySeconds"],
      "delaySeconds",
      0,
      OPERATION_INPUT_LIMITS.maximumDelaySeconds,
    ),
  };
}

function parseEnvironmentName(value: unknown): string {
  const name = requireString(value, "name", OPERATION_INPUT_LIMITS.environmentNameLength);
  if (name.includes("=") || name.includes("\0")) {
    throw new TypeError("environment variable name must not contain '=' or NUL characters");
  }
  return name;
}

function parseIdentifier(value: unknown, name: string): string {
  const identifier = requireString(value, name, OPERATION_INPUT_LIMITS.identifierLength);
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new TypeError(`${name} contains unsupported characters`);
  }
  return identifier;
}

function requirePlainRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new TypeError(`expected exactly these fields: ${expected.join(", ")}`);
  }
}

function requireAllowedKeys(record: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new TypeError(`unexpected field: ${unexpected[0]}`);
  }
}

function requireString(value: unknown, name: string, maximumLength: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximumLength) {
    const range = allowEmpty ? `0-${maximumLength}` : `1-${maximumLength}`;
    throw new TypeError(`${name} must be a string with ${range} characters`);
  }
  return value;
}

function requireInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}
