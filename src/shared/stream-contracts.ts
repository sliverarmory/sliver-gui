export const STREAM_PROTOCOL_VERSION = 1 as const;
export const STREAM_RENDERER_PORT_MESSAGE = "sliver:stream:port" as const;

const KiB = 1_024;
const MiB = 1_024 * KiB;

export const STREAM_MAX_FRAME_BYTES = 16 * KiB;
export const STREAM_INITIAL_CREDIT_BYTES = 64 * KiB;
export const STREAM_MAX_CREDIT_GRANT_BYTES = 64 * KiB;
export const STREAM_MAX_CREDIT_BYTES = 128 * KiB;
export const STREAM_MAX_QUEUE_BYTES = 128 * KiB;
export const STREAM_MAX_DETACHED_SCROLLBACK_BYTES = 256 * KiB;
export const STREAM_RESERVED_BYTES_PER_RESOURCE = 512 * KiB;
export const STREAM_MAX_STREAMS_PER_WINDOW = 8 as const;
export const STREAM_MAX_STREAMS_PER_BACKEND = 32 as const;
export const STREAM_MAX_STREAMS_PER_PROCESS = 64 as const;
export const STREAM_MAX_RESERVED_BYTES_PER_WINDOW = 4 * MiB;
export const STREAM_MAX_RESERVED_BYTES_PER_BACKEND = 16 * MiB;
export const STREAM_MAX_RESERVED_BYTES_PER_PROCESS = 32 * MiB;
export const STREAM_TICKET_TTL_MILLISECONDS = 15_000 as const;
export const STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000 as const;
export const STREAM_WRITE_TIMEOUT_MILLISECONDS = 15_000 as const;
export const STREAM_CREDIT_TIMEOUT_MILLISECONDS = 30_000 as const;
export const STREAM_IDLE_TIMEOUT_MILLISECONDS = 30 * 60 * 1_000;
export const STREAM_DETACHED_TTL_MILLISECONDS = 5 * 60 * 1_000;
export const STREAM_CLOSING_GRACE_MILLISECONDS = 2_000 as const;
export const STREAM_CONTROL_FRAMES_PER_SECOND = 64 as const;
export const STREAM_CONTROL_FRAME_BURST = 128 as const;
export const STREAM_MAX_SHELL_PATH_LENGTH = 4_096 as const;
export const STREAM_MAX_TERMINAL_DIMENSION = 1_000 as const;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FORBIDDEN_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/u;
const MAX_UINT64 = 18_446_744_073_709_551_615n;

export const STREAM_CLOSE_REASONS = [
  "completed",
  "operator-close",
  "operator-detach",
  "remote-close",
  "port-closed",
  "window-closed",
  "renderer-gone",
  "navigation",
  "backend-disconnected",
  "backend-rebound",
  "target-disappeared",
  "target-rebound",
  "handshake-timeout",
  "idle-timeout",
  "credit-timeout",
  "write-timeout",
  "quota-exceeded",
  "protocol-error",
  "transport-error",
  "detached-buffer-exhausted",
  "application-shutdown",
] as const;

export type StreamCloseReason = (typeof STREAM_CLOSE_REASONS)[number];
export type StreamCloseDisposition = "closed" | "detached" | "outcome-unknown";
export type StreamPressure = "normal" | "high";
export type SessionShellPty = "disabled" | "requested-unconfirmed";
export type SessionShellResourceState =
  | "prepared"
  | "handshaking"
  | "opening"
  | "attached"
  | "detached"
  | "closing";

export interface PrepareSessionShellInput {
  /** Omitted to request the implant's platform-default shell. */
  readonly path?: string;
  readonly requestPty: boolean;
  readonly rows?: number;
  readonly columns?: number;
}

/** Intentionally empty: shell inventory is always scoped by the trusted sender. */
export type ListSessionShellsInput = Readonly<Record<never, never>>;

export type SessionShellResourceAction = "attach" | "detach" | "close" | "kill";

export interface SessionShellResourceActionInput {
  readonly resourceId: string;
  readonly action: SessionShellResourceAction;
}

export interface StreamAttachmentTicket {
  readonly attachmentToken: string;
  readonly expiresAt: string;
}

/** Fixed, verified bytes loaded by Electron main; the renderer never selects an asset path. */
export interface TerminalRuntimeAsset {
  readonly version: "0.4.0";
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface StreamMetrics {
  readonly bytesFromRenderer: string;
  readonly bytesToRenderer: string;
  readonly framesFromRenderer: string;
  readonly framesToRenderer: string;
  readonly queuedInputBytes: number;
  readonly queuedOutputBytes: number;
  readonly inFlightInputBytes: number;
  readonly inputCreditBytes: number;
  readonly outputCreditBytes: number;
  readonly highWaterInputBytes: number;
  readonly highWaterOutputBytes: number;
  readonly pressure: StreamPressure;
  readonly createdAt: string;
  readonly lastActivityAt: string;
}

export interface StreamAggregateMetrics {
  readonly activeStreams: number;
  readonly attachedStreams: number;
  readonly detachedStreams: number;
  readonly reservedBytes: number;
  readonly queuedBytes: number;
  readonly inFlightBytes: number;
  readonly highWaterReservedBytes: number;
  readonly highWaterQueuedBytes: number;
  readonly highWaterInFlightBytes: number;
  readonly openedStreams: string;
  readonly rejectedStreams: string;
  readonly closedStreams: string;
  readonly closesByReason: Readonly<Partial<Record<StreamCloseReason, string>>>;
}

export interface SessionShellResource {
  readonly resourceId: string;
  readonly kind: "session-shell";
  readonly state: SessionShellResourceState;
  readonly pty: SessionShellPty;
  readonly canResize: boolean;
  readonly canKill: boolean;
  readonly createdAt: string;
  readonly lastActivityAt: string;
  readonly detachedExpiresAt?: string;
  readonly metrics: StreamMetrics;
}

export interface SessionShellPlan {
  readonly resourceId: string;
  readonly kind: "session-shell";
  readonly pty: SessionShellPty;
  readonly canResize: boolean;
  readonly createdAt: string;
  readonly attachment: StreamAttachmentTicket;
}

export interface SessionShellResourceList {
  readonly resources: readonly SessionShellResource[];
  readonly metrics: StreamAggregateMetrics;
}

export interface SessionShellResourceActionResult {
  readonly action: SessionShellResourceAction;
  readonly resourceId: string;
  readonly resource?: SessionShellResource;
  readonly attachment?: StreamAttachmentTicket;
}

export interface StreamAttachRequest {
  readonly v: typeof STREAM_PROTOCOL_VERSION;
  readonly attachmentToken: string;
}

interface StreamFrameBase {
  readonly v: typeof STREAM_PROTOCOL_VERSION;
  readonly streamId: string;
}

export interface StreamClientStartFrame extends StreamFrameBase {
  readonly type: "start";
  readonly receiveCreditBytes: number;
}

export interface StreamClientDataFrame extends StreamFrameBase {
  readonly type: "data";
  readonly sequence: number;
  readonly data: ArrayBuffer;
}

export interface StreamClientCreditFrame extends StreamFrameBase {
  readonly type: "credit";
  readonly bytes: number;
}

export interface StreamClientResizeFrame extends StreamFrameBase {
  readonly type: "resize";
  readonly rows: number;
  readonly columns: number;
}

export interface StreamClientCloseFrame extends StreamFrameBase {
  readonly type: "close";
  readonly disposition: "close" | "detach";
}

export type StreamClientFrame =
  | StreamClientStartFrame
  | StreamClientDataFrame
  | StreamClientCreditFrame
  | StreamClientResizeFrame
  | StreamClientCloseFrame;

export interface StreamReadyLimits {
  readonly maxFrameBytes: number;
  readonly maxCreditBytes: number;
  readonly inputCreditBytes: number;
  readonly handshakeTimeoutMilliseconds: number;
  readonly idleTimeoutMilliseconds: number;
}

export interface StreamReadyFrame extends StreamFrameBase {
  readonly type: "ready";
  readonly limits: StreamReadyLimits;
}

export interface StreamOpenedFrame extends StreamFrameBase {
  readonly type: "opened";
  readonly resource: {
    readonly resourceId: string;
    readonly kind: "session-shell";
    readonly pty: SessionShellPty;
  };
  readonly inputCreditBytes: number;
}

export interface StreamServerDataFrame extends StreamFrameBase {
  readonly type: "data";
  readonly sequence: number;
  readonly data: ArrayBuffer;
}

export interface StreamServerCreditFrame extends StreamFrameBase {
  readonly type: "credit";
  readonly bytes: number;
}

export interface StreamPressureFrame extends StreamFrameBase {
  readonly type: "pressure";
  readonly level: StreamPressure;
  readonly queuedBytes: number;
}

export interface StreamClosedFrame extends StreamFrameBase {
  readonly type: "closed";
  readonly reason: StreamCloseReason;
  readonly disposition: StreamCloseDisposition;
  readonly metrics: StreamMetrics;
}

export type StreamServerFrame =
  | StreamReadyFrame
  | StreamOpenedFrame
  | StreamServerDataFrame
  | StreamServerCreditFrame
  | StreamPressureFrame
  | StreamClosedFrame;

export class StreamContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "StreamContractError";
  }
}

export function parsePrepareSessionShellInput(value: unknown): PrepareSessionShellInput {
  const record = requireRecord(value, "session shell input");
  requireExactKeys(record, ["path", "requestPty", "rows", "columns"], ["requestPty"], "session shell input");
  if (typeof record["requestPty"] !== "boolean") invalid("session shell requestPty must be a boolean");

  const path = record["path"] === undefined
    ? undefined
    : requireSafeText(record["path"], "session shell path", 1, STREAM_MAX_SHELL_PATH_LENGTH);
  const rows = record["rows"] === undefined
    ? undefined
    : requireInteger(record["rows"], "session shell rows", 1, STREAM_MAX_TERMINAL_DIMENSION);
  const columns = record["columns"] === undefined
    ? undefined
    : requireInteger(record["columns"], "session shell columns", 1, STREAM_MAX_TERMINAL_DIMENSION);
  if ((rows === undefined) !== (columns === undefined)) {
    invalid("session shell rows and columns must be provided together");
  }
  if (!record["requestPty"] && rows !== undefined) {
    invalid("session shell dimensions require requestPty");
  }
  return Object.freeze({
    requestPty: record["requestPty"],
    ...(path !== undefined ? { path } : {}),
    ...(rows !== undefined && columns !== undefined ? { rows, columns } : {}),
  });
}

export function parseListSessionShellsInput(value: unknown): ListSessionShellsInput {
  const record = requireRecord(value, "session shell list input");
  requireExactKeys(record, [], [], "session shell list input");
  return Object.freeze({});
}

export function parseSessionShellResourceActionInput(value: unknown): SessionShellResourceActionInput {
  const record = requireRecord(value, "session shell resource action");
  requireExactKeys(record, ["resourceId", "action"], ["resourceId", "action"], "session shell resource action");
  const resourceId = requireOpaqueId(record["resourceId"], "session shell resourceId");
  const action = record["action"];
  if (action !== "attach" && action !== "detach" && action !== "close" && action !== "kill") {
    invalid("session shell action is unsupported");
  }
  return Object.freeze({ resourceId, action });
}

export function parseStreamAttachRequest(value: unknown): StreamAttachRequest {
  const record = requireRecord(value, "stream attach request");
  requireExactKeys(record, ["v", "attachmentToken"], ["v", "attachmentToken"], "stream attach request");
  requireProtocolVersion(record["v"]);
  return Object.freeze({
    v: STREAM_PROTOCOL_VERSION,
    attachmentToken: requireOpaqueId(record["attachmentToken"], "stream attachmentToken"),
  });
}

export function parseStreamCorrelationId(value: unknown): string {
  if (typeof value !== "string" || (!OPAQUE_ID_PATTERN.test(value) && !UUID_V4_PATTERN.test(value))) {
    invalid("stream correlation ID is invalid");
  }
  return value;
}

export function parseStreamClientFrame(value: unknown): StreamClientFrame {
  const record = requireRecord(value, "stream frame");
  const type = record["type"];
  if (typeof type !== "string") invalid("stream frame type must be a string");
  requireProtocolVersion(record["v"]);
  const streamId = requireOpaqueId(record["streamId"], "stream frame streamId");

  switch (type) {
    case "start": {
      requireExactKeys(record, ["v", "type", "streamId", "receiveCreditBytes"], undefined, "stream start frame");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        receiveCreditBytes: requireInteger(
          record["receiveCreditBytes"],
          "stream start receiveCreditBytes",
          1,
          STREAM_MAX_CREDIT_BYTES,
        ),
      });
    }
    case "data": {
      requireExactKeys(record, ["v", "type", "streamId", "sequence", "data"], undefined, "stream data frame");
      if (!(record["data"] instanceof ArrayBuffer)) invalid("stream data must be an ArrayBuffer");
      if (record["data"].byteLength < 1 || record["data"].byteLength > STREAM_MAX_FRAME_BYTES) {
        invalid(`stream data must contain 1-${STREAM_MAX_FRAME_BYTES} bytes`);
      }
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        sequence: requireInteger(record["sequence"], "stream data sequence", 0, Number.MAX_SAFE_INTEGER),
        data: record["data"],
      });
    }
    case "credit": {
      requireExactKeys(record, ["v", "type", "streamId", "bytes"], undefined, "stream credit frame");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        bytes: requireInteger(record["bytes"], "stream credit bytes", 1, STREAM_MAX_CREDIT_GRANT_BYTES),
      });
    }
    case "resize": {
      requireExactKeys(record, ["v", "type", "streamId", "rows", "columns"], undefined, "stream resize frame");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        rows: requireInteger(record["rows"], "stream resize rows", 1, STREAM_MAX_TERMINAL_DIMENSION),
        columns: requireInteger(record["columns"], "stream resize columns", 1, STREAM_MAX_TERMINAL_DIMENSION),
      });
    }
    case "close": {
      requireExactKeys(record, ["v", "type", "streamId", "disposition"], undefined, "stream close frame");
      if (record["disposition"] !== "close" && record["disposition"] !== "detach") {
        invalid("stream close disposition is unsupported");
      }
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        disposition: record["disposition"],
      });
    }
    default:
      invalid("stream frame type is unsupported");
  }
}

export function parseStreamServerFrame(value: unknown): StreamServerFrame {
  const record = requireRecord(value, "stream server frame");
  const type = record["type"];
  if (typeof type !== "string") invalid("stream server frame type must be a string");
  requireProtocolVersion(record["v"]);
  const streamId = requireOpaqueId(record["streamId"], "stream server frame streamId");

  switch (type) {
    case "ready": {
      requireExactKeys(record, ["v", "type", "streamId", "limits"], undefined, "stream ready frame");
      const limits = requireRecord(record["limits"], "stream ready limits");
      requireExactKeys(
        limits,
        [
          "maxFrameBytes",
          "maxCreditBytes",
          "inputCreditBytes",
          "handshakeTimeoutMilliseconds",
          "idleTimeoutMilliseconds",
        ],
        undefined,
        "stream ready limits",
      );
      const maxFrameBytes = requireInteger(
        limits["maxFrameBytes"],
        "stream ready maxFrameBytes",
        1,
        STREAM_MAX_FRAME_BYTES,
      );
      const maxCreditBytes = requireInteger(
        limits["maxCreditBytes"],
        "stream ready maxCreditBytes",
        1,
        STREAM_MAX_CREDIT_BYTES,
      );
      const inputCreditBytes = requireInteger(
        limits["inputCreditBytes"],
        "stream ready inputCreditBytes",
        0,
        maxCreditBytes,
      );
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        limits: Object.freeze({
          maxFrameBytes,
          maxCreditBytes,
          inputCreditBytes,
          handshakeTimeoutMilliseconds: requireInteger(
            limits["handshakeTimeoutMilliseconds"],
            "stream ready handshakeTimeoutMilliseconds",
            1,
            STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
          ),
          idleTimeoutMilliseconds: requireInteger(
            limits["idleTimeoutMilliseconds"],
            "stream ready idleTimeoutMilliseconds",
            1,
            STREAM_IDLE_TIMEOUT_MILLISECONDS,
          ),
        }),
      });
    }
    case "opened": {
      requireExactKeys(
        record,
        ["v", "type", "streamId", "resource", "inputCreditBytes"],
        undefined,
        "stream opened frame",
      );
      const resource = requireRecord(record["resource"], "stream opened resource");
      requireExactKeys(
        resource,
        ["resourceId", "kind", "pty"],
        undefined,
        "stream opened resource",
      );
      if (resource["kind"] !== "session-shell") invalid("stream opened resource kind is unsupported");
      const pty = requireSessionShellPty(resource["pty"], "stream opened resource pty");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        resource: Object.freeze({
          resourceId: requireOpaqueId(resource["resourceId"], "stream opened resourceId"),
          kind: "session-shell",
          pty,
        }),
        inputCreditBytes: requireInteger(
          record["inputCreditBytes"],
          "stream opened inputCreditBytes",
          0,
          STREAM_MAX_CREDIT_BYTES,
        ),
      });
    }
    case "data": {
      requireExactKeys(
        record,
        ["v", "type", "streamId", "sequence", "data"],
        undefined,
        "stream server data frame",
      );
      const data = requireBoundedArrayBuffer(record["data"], "stream server data");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        sequence: requireInteger(record["sequence"], "stream server data sequence", 0, Number.MAX_SAFE_INTEGER),
        data,
      });
    }
    case "credit": {
      requireExactKeys(
        record,
        ["v", "type", "streamId", "bytes"],
        undefined,
        "stream server credit frame",
      );
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        bytes: requireInteger(record["bytes"], "stream server credit bytes", 1, STREAM_MAX_CREDIT_GRANT_BYTES),
      });
    }
    case "pressure": {
      requireExactKeys(
        record,
        ["v", "type", "streamId", "level", "queuedBytes"],
        undefined,
        "stream pressure frame",
      );
      const level = record["level"];
      if (level !== "normal" && level !== "high") invalid("stream pressure level is unsupported");
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        level,
        queuedBytes: requireInteger(
          record["queuedBytes"],
          "stream pressure queuedBytes",
          0,
          STREAM_RESERVED_BYTES_PER_RESOURCE,
        ),
      });
    }
    case "closed": {
      requireExactKeys(
        record,
        ["v", "type", "streamId", "reason", "disposition", "metrics"],
        undefined,
        "stream closed frame",
      );
      const reason = requireCloseReason(record["reason"]);
      const disposition = record["disposition"];
      if (disposition !== "closed" && disposition !== "detached" && disposition !== "outcome-unknown") {
        invalid("stream close disposition is unsupported");
      }
      if ((reason === "operator-detach") !== (disposition === "detached")) {
        invalid("stream detach reason and disposition do not match");
      }
      return Object.freeze({
        v: STREAM_PROTOCOL_VERSION,
        type,
        streamId,
        reason,
        disposition,
        metrics: parseStreamMetrics(record["metrics"]),
      });
    }
    default:
      invalid("stream server frame type is unsupported");
  }
}

export function isOpaqueStreamId(value: string): boolean {
  return OPAQUE_ID_PATTERN.test(value);
}

function parseStreamMetrics(value: unknown): StreamMetrics {
  const record = requireRecord(value, "stream metrics");
  requireExactKeys(
    record,
    [
      "bytesFromRenderer",
      "bytesToRenderer",
      "framesFromRenderer",
      "framesToRenderer",
      "queuedInputBytes",
      "queuedOutputBytes",
      "inFlightInputBytes",
      "inputCreditBytes",
      "outputCreditBytes",
      "highWaterInputBytes",
      "highWaterOutputBytes",
      "pressure",
      "createdAt",
      "lastActivityAt",
    ],
    undefined,
    "stream metrics",
  );
  const pressure = record["pressure"];
  if (pressure !== "normal" && pressure !== "high") invalid("stream metrics pressure is unsupported");
  const createdAt = requireIsoDate(record["createdAt"], "stream metrics createdAt");
  const lastActivityAt = requireIsoDate(record["lastActivityAt"], "stream metrics lastActivityAt");
  if (Date.parse(lastActivityAt) < Date.parse(createdAt)) {
    invalid("stream metrics lastActivityAt precedes createdAt");
  }
  return Object.freeze({
    bytesFromRenderer: requireUnsignedDecimal(record["bytesFromRenderer"], "stream metrics bytesFromRenderer"),
    bytesToRenderer: requireUnsignedDecimal(record["bytesToRenderer"], "stream metrics bytesToRenderer"),
    framesFromRenderer: requireUnsignedDecimal(record["framesFromRenderer"], "stream metrics framesFromRenderer"),
    framesToRenderer: requireUnsignedDecimal(record["framesToRenderer"], "stream metrics framesToRenderer"),
    queuedInputBytes: requireInteger(
      record["queuedInputBytes"],
      "stream metrics queuedInputBytes",
      0,
      STREAM_MAX_QUEUE_BYTES,
    ),
    queuedOutputBytes: requireInteger(
      record["queuedOutputBytes"],
      "stream metrics queuedOutputBytes",
      0,
      STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
    ),
    inFlightInputBytes: requireInteger(
      record["inFlightInputBytes"],
      "stream metrics inFlightInputBytes",
      0,
      STREAM_MAX_FRAME_BYTES,
    ),
    inputCreditBytes: requireInteger(
      record["inputCreditBytes"],
      "stream metrics inputCreditBytes",
      0,
      STREAM_MAX_CREDIT_BYTES,
    ),
    outputCreditBytes: requireInteger(
      record["outputCreditBytes"],
      "stream metrics outputCreditBytes",
      0,
      STREAM_MAX_CREDIT_BYTES,
    ),
    highWaterInputBytes: requireInteger(
      record["highWaterInputBytes"],
      "stream metrics highWaterInputBytes",
      0,
      STREAM_MAX_QUEUE_BYTES,
    ),
    highWaterOutputBytes: requireInteger(
      record["highWaterOutputBytes"],
      "stream metrics highWaterOutputBytes",
      0,
      STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
    ),
    pressure,
    createdAt,
    lastActivityAt,
  });
}

function requireBoundedArrayBuffer(value: unknown, label: string): ArrayBuffer {
  if (!(value instanceof ArrayBuffer)) invalid(`${label} must be an ArrayBuffer`);
  if (value.byteLength < 1 || value.byteLength > STREAM_MAX_FRAME_BYTES) {
    invalid(`${label} must contain 1-${STREAM_MAX_FRAME_BYTES} bytes`);
  }
  return value;
}

function requireSessionShellPty(value: unknown, label: string): SessionShellPty {
  if (value !== "disabled" && value !== "requested-unconfirmed") invalid(`${label} is unsupported`);
  return value;
}

function requireCloseReason(value: unknown): StreamCloseReason {
  if (typeof value !== "string" || !(STREAM_CLOSE_REASONS as readonly string[]).includes(value)) {
    invalid("stream close reason is unsupported");
  }
  return value as StreamCloseReason;
}

function requireUnsignedDecimal(value: unknown, label: string): string {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_PATTERN.test(value) || BigInt(value) > MAX_UINT64) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function requireIsoDate(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 32) invalid(`${label} is invalid`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid(`${label} is invalid`);
  return value;
}

function requireProtocolVersion(value: unknown): asserts value is typeof STREAM_PROTOCOL_VERSION {
  if (value !== STREAM_PROTOCOL_VERSION) invalid(`stream protocol version must be ${STREAM_PROTOCOL_VERSION}`);
}

function requireOpaqueId(value: unknown, label: string): string {
  if (typeof value !== "string" || !OPAQUE_ID_PATTERN.test(value)) invalid(`${label} is invalid`);
  return value;
}

function requireSafeText(value: unknown, label: string, minimumLength: number, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    FORBIDDEN_TEXT_PATTERN.test(value)
  ) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] | undefined,
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`Unexpected ${label} field '${key}'`);
  }
  for (const key of requiredKeys ?? allowedKeys) {
    if (!Object.hasOwn(value, key)) invalid(`${label} is missing '${key}'`);
  }
}

function invalid(message: string): never {
  throw new StreamContractError(message);
}
