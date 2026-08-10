import type { PageResult } from "./contracts.js";
import type { SessionWorkbenchOperationId } from "./session-contracts.js";
import type { TargetMode, TargetRef } from "./target-contracts.js";

export type { TargetMode, TargetRef } from "./target-contracts.js";

export const TARGET_OPERATION_IDS = Object.freeze([
  "target.ping",
  "target.rename",
  "target.env-set",
  "target.env-unset",
  "beacon.reconfigure",
  "beacon.open-session",
] as const);

export type TargetOperationId = (typeof TARGET_OPERATION_IDS)[number];

/**
 * Every operation identifier that may appear in the main-owned activity
 * journal. `TargetOperationId` remains the smaller renderer-submittable M1
 * dispatcher surface; session workbench identifiers are journal-only here and
 * keep their own closed input parser.
 */
export type OperationRecordId = TargetOperationId | SessionWorkbenchOperationId;

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
  | OpenBeaconSessionOperationInput;

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

/** Decoded, bounded metadata only. Raw protobuf request/response bytes are never shared. */
export interface BeaconTaskDetail extends BeaconTaskSummary {
  operationId?: TargetOperationId;
  disposition?: OperationDisposition;
  error?: string;
  errorKind?: "target-reported" | "decode-uncertain";
}

export type ListBeaconTasksInput = OperationPageRequest;

export type BeaconTaskPage = PageResult<BeaconTaskSummary>;

export interface GetBeaconTaskInput {
  taskId: string;
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
  }
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
