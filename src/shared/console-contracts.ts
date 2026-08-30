export const CONSOLE_PROTOCOL_VERSION = 1 as const;
export const CONSOLE_RENDERER_PORT_MESSAGE = "sliver:console-stream:port" as const;

const KiB = 1_024;

export const CONSOLE_MAX_FRAME_BYTES = 16 * KiB;
export const CONSOLE_INITIAL_CREDIT_BYTES = 64 * KiB;
export const CONSOLE_MAX_CREDIT_GRANT_BYTES = 64 * KiB;
export const CONSOLE_MAX_CREDIT_BYTES = 128 * KiB;
export const CONSOLE_MAX_QUEUE_BYTES = 128 * KiB;
// node-pty has no public write-drain signal. This lifetime admission ceiling
// deterministically bounds its private asynchronous input queue if a child
// stops reading while a renderer continues to send data.
export const CONSOLE_MAX_SESSION_INPUT_BYTES = 16 * 1_024 * KiB;
export const CONSOLE_MAX_TERMINAL_DIMENSION = 1_000 as const;
export const CONSOLE_MAX_TABS_PER_WINDOW = 10 as const;
export const CONSOLE_ATTACHMENT_TTL_MILLISECONDS = 15_000 as const;
export const CONSOLE_HANDSHAKE_TIMEOUT_MILLISECONDS = 5_000 as const;
export const CONSOLE_WINDOW_OPEN_REQUEST_ERROR =
  "Sliver Desktop could not request a console window. Restart Sliver Desktop, then try again. Reference: CONSOLE_OPEN_REQUEST_FAILED";

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export const CONSOLE_CLOSE_REASONS = [
  "completed",
  "operator-close",
  "window-closed",
  "renderer-gone",
  "navigation",
  "handshake-timeout",
  "protocol-error",
  "transport-error",
  "application-shutdown",
] as const;

export type ConsoleCloseReason = (typeof CONSOLE_CLOSE_REASONS)[number];

export interface ConsoleTabLaunchContext {
  readonly tabId: string;
  readonly attachmentToken: string;
  readonly label: string;
}

export interface ConsoleWindowLaunchContext {
  readonly kind: "console";
  readonly configName: string;
  readonly shortcutModifier: "Command" | "Control";
  readonly initialTab: ConsoleTabLaunchContext;
}

export interface ConsoleTabCloseResult {
  readonly remainingTabs: number;
}

export interface ConsoleAttachRequest {
  readonly v: typeof CONSOLE_PROTOCOL_VERSION;
  readonly attachmentToken: string;
}

interface ConsoleFrameBase {
  readonly v: typeof CONSOLE_PROTOCOL_VERSION;
  readonly streamId: string;
}

export interface ConsoleClientStartFrame extends ConsoleFrameBase {
  readonly type: "start";
  readonly receiveCreditBytes: number;
}

export interface ConsoleClientDataFrame extends ConsoleFrameBase {
  readonly type: "data";
  readonly sequence: number;
  readonly data: ArrayBuffer;
}

export interface ConsoleClientCreditFrame extends ConsoleFrameBase {
  readonly type: "credit";
  readonly bytes: number;
}

export interface ConsoleClientResizeFrame extends ConsoleFrameBase {
  readonly type: "resize";
  readonly rows: number;
  readonly columns: number;
}

export interface ConsoleClientCloseFrame extends ConsoleFrameBase {
  readonly type: "close";
}

export type ConsoleClientFrame =
  | ConsoleClientStartFrame
  | ConsoleClientDataFrame
  | ConsoleClientCreditFrame
  | ConsoleClientResizeFrame
  | ConsoleClientCloseFrame;

export interface ConsoleReadyFrame extends ConsoleFrameBase {
  readonly type: "ready";
  readonly limits: {
    readonly maxFrameBytes: number;
    readonly maxCreditBytes: number;
    readonly inputCreditBytes: number;
  };
}

export interface ConsoleServerDataFrame extends ConsoleFrameBase {
  readonly type: "data";
  readonly sequence: number;
  readonly data: ArrayBuffer;
}

export interface ConsoleServerCreditFrame extends ConsoleFrameBase {
  readonly type: "credit";
  readonly bytes: number;
}

export interface ConsoleClosedFrame extends ConsoleFrameBase {
  readonly type: "closed";
  readonly reason: ConsoleCloseReason;
  readonly exitCode?: number;
}

export type ConsoleServerFrame =
  | ConsoleReadyFrame
  | ConsoleServerDataFrame
  | ConsoleServerCreditFrame
  | ConsoleClosedFrame;

export class ConsoleContractError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ConsoleContractError";
  }
}

export function isOpaqueConsoleId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

export function parseConsoleTabId(value: unknown): string {
  return requireOpaqueId(value, "console tab ID");
}

export function parseConsoleTabShortcutIndex(value: unknown): number {
  return requireInteger(
    value,
    "console tab shortcut index",
    0,
    CONSOLE_MAX_TABS_PER_WINDOW - 1,
  );
}

export function parseConsoleAttachRequest(value: unknown): ConsoleAttachRequest {
  const record = requireRecord(value, "console attach request");
  requireExactKeys(record, ["v", "attachmentToken"], "console attach request");
  requireVersion(record["v"]);
  return Object.freeze({
    v: CONSOLE_PROTOCOL_VERSION,
    attachmentToken: requireOpaqueId(record["attachmentToken"], "console attachment token"),
  });
}

export function parseConsoleClientFrame(value: unknown): ConsoleClientFrame {
  const record = requireRecord(value, "console client frame");
  requireVersion(record["v"]);
  const streamId = requireOpaqueId(record["streamId"], "console stream ID");
  const type = record["type"];
  switch (type) {
    case "start":
      requireExactKeys(record, ["v", "type", "streamId", "receiveCreditBytes"], "console start frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        receiveCreditBytes: requireInteger(
          record["receiveCreditBytes"],
          "console receive credit",
          1,
          CONSOLE_MAX_CREDIT_BYTES,
        ),
      });
    case "data":
      requireExactKeys(record, ["v", "type", "streamId", "sequence", "data"], "console data frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        sequence: requireInteger(record["sequence"], "console input sequence", 0, Number.MAX_SAFE_INTEGER),
        data: requireFrameData(record["data"]),
      });
    case "credit":
      requireExactKeys(record, ["v", "type", "streamId", "bytes"], "console credit frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        bytes: requireInteger(record["bytes"], "console credit bytes", 1, CONSOLE_MAX_CREDIT_GRANT_BYTES),
      });
    case "resize":
      requireExactKeys(record, ["v", "type", "streamId", "rows", "columns"], "console resize frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        rows: requireInteger(record["rows"], "console rows", 1, CONSOLE_MAX_TERMINAL_DIMENSION),
        columns: requireInteger(record["columns"], "console columns", 1, CONSOLE_MAX_TERMINAL_DIMENSION),
      });
    case "close":
      requireExactKeys(record, ["v", "type", "streamId"], "console close frame");
      return Object.freeze({ v: CONSOLE_PROTOCOL_VERSION, type, streamId });
    default:
      invalid("console client frame type is unsupported");
  }
}

export function parseConsoleServerFrame(value: unknown): ConsoleServerFrame {
  const record = requireRecord(value, "console server frame");
  requireVersion(record["v"]);
  const streamId = requireOpaqueId(record["streamId"], "console stream ID");
  const type = record["type"];
  switch (type) {
    case "ready": {
      requireExactKeys(record, ["v", "type", "streamId", "limits"], "console ready frame");
      const limits = requireRecord(record["limits"], "console limits");
      requireExactKeys(limits, ["maxFrameBytes", "maxCreditBytes", "inputCreditBytes"], "console limits");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        limits: Object.freeze({
          maxFrameBytes: requireInteger(limits["maxFrameBytes"], "console maximum frame bytes", 1, CONSOLE_MAX_FRAME_BYTES),
          maxCreditBytes: requireInteger(limits["maxCreditBytes"], "console maximum credit bytes", 1, CONSOLE_MAX_CREDIT_BYTES),
          inputCreditBytes: requireInteger(limits["inputCreditBytes"], "console input credit bytes", 1, CONSOLE_MAX_CREDIT_BYTES),
        }),
      });
    }
    case "data":
      requireExactKeys(record, ["v", "type", "streamId", "sequence", "data"], "console data frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        sequence: requireInteger(record["sequence"], "console output sequence", 0, Number.MAX_SAFE_INTEGER),
        data: requireFrameData(record["data"]),
      });
    case "credit":
      requireExactKeys(record, ["v", "type", "streamId", "bytes"], "console credit frame");
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        bytes: requireInteger(record["bytes"], "console credit bytes", 1, CONSOLE_MAX_CREDIT_GRANT_BYTES),
      });
    case "closed": {
      requireExactKeys(record, ["v", "type", "streamId", "reason", "exitCode"], "console closed frame", ["exitCode"]);
      const reason = record["reason"];
      if (typeof reason !== "string" || !CONSOLE_CLOSE_REASONS.includes(reason as ConsoleCloseReason)) {
        invalid("console close reason is unsupported");
      }
      const exitCode = record["exitCode"] === undefined
        ? undefined
        : requireInteger(record["exitCode"], "console exit code", -2_147_483_648, 2_147_483_647);
      return Object.freeze({
        v: CONSOLE_PROTOCOL_VERSION,
        type,
        streamId,
        reason: reason as ConsoleCloseReason,
        ...(exitCode === undefined ? {} : { exitCode }),
      });
    }
    default:
      invalid("console server frame type is unsupported");
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(record);
  if (keys.some((key) => !allowed.includes(key)) || allowed.some((key) => !optional.includes(key) && !(key in record))) {
    invalid(`${label} has an invalid shape`);
  }
}

function requireVersion(value: unknown): void {
  if (value !== CONSOLE_PROTOCOL_VERSION) invalid("console protocol version is unsupported");
}

function requireOpaqueId(value: unknown, label: string): string {
  if (!isOpaqueConsoleId(value)) invalid(`${label} is invalid`);
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function requireFrameData(value: unknown): ArrayBuffer {
  if (!(value instanceof ArrayBuffer) || value.byteLength < 1 || value.byteLength > CONSOLE_MAX_FRAME_BYTES) {
    invalid(`console data must contain 1-${CONSOLE_MAX_FRAME_BYTES} bytes`);
  }
  return value;
}

function invalid(message: string): never {
  throw new ConsoleContractError(message);
}
