import type {
  ApplicationSettingsState,
} from "./application-settings-contracts.js";
import type {
  ConnectionSummary,
  DomainStatus,
  OperationResult,
} from "./contracts.js";
import type { SessionLiveness, TargetRef } from "./target-contracts.js";

export const NETWORK_FORWARDING_IPC_INVOKE = Object.freeze({
  getContext: "sliver:network-forwarding:context:get",
  list: "sliver:network-forwarding:list",
  startPortForward: "sliver:network-forwarding:port-forward:start",
  stopPortForward: "sliver:network-forwarding:port-forward:stop",
  startReversePortForward: "sliver:network-forwarding:reverse-port-forward:start",
  stopReversePortForward: "sliver:network-forwarding:reverse-port-forward:stop",
  startSocks5Proxy: "sliver:network-forwarding:socks5:start",
  stopSocks5Proxy: "sliver:network-forwarding:socks5:stop",
  getApplicationSettings: "sliver:network-forwarding:application-settings:get",
});

export const NETWORK_FORWARDING_IPC_EVENTS = Object.freeze({
  changed: "sliver:network-forwarding:changed",
  navigationRequested: "sliver:network-forwarding:navigation-requested",
  applicationSettingsChanged: "sliver:application-settings:changed",
});

export const NETWORK_TAB_IDS = ["port-forward", "reverse-port-forward", "socks5"] as const;
export type NetworkTabId = (typeof NETWORK_TAB_IDS)[number];

export const NETWORK_FORWARDING_LIMITS = Object.freeze({
  hostCharacters: 255,
  operationTimeoutSeconds: 300,
  reverseInventorySessions: 256,
  portForwardConnections: 64,
  portForwardBufferBytes: 4 * 1024 * 1024,
  portForwardTotalBufferBytes: 32 * 1024 * 1024,
  socks5Connections: 256,
  socks5BufferBytes: 64 * 1024 * 1024,
  socks5CredentialBytes: 255,
});

export const NETWORK_FORWARDING_DEFAULTS = Object.freeze({
  localBindHost: "127.0.0.1",
  reverseBindHost: "0.0.0.0",
  localBindPort: 0,
  keepAliveSeconds: 30,
  connectTimeoutSeconds: 30,
  closeTimeoutSeconds: 5,
  portForwardConnections: 32,
  portForwardBufferBytes: 512 * 1024,
  socks5Connections: 256,
  socks5BufferBytes: 8 * 1024 * 1024,
});

export interface NetworkAddress {
  readonly host: string;
  readonly port: number;
}

export interface ListNetworkForwardsInput {
  readonly reverseTargets?: readonly TargetRef[];
}

export interface StartPortForwardInput {
  readonly session: TargetRef;
  readonly bind: NetworkAddress;
  readonly destination: NetworkAddress;
  readonly keepAliveSeconds: number;
  readonly connectTimeoutSeconds: number;
  readonly closeTimeoutSeconds: number;
  readonly maxConnections: number;
  readonly maxBufferedBytesPerConnection: number;
}

export interface StartReversePortForwardInput {
  readonly session: TargetRef;
  readonly bind: NetworkAddress;
  readonly destination: NetworkAddress;
  readonly keepAliveSeconds: number;
}

export interface Socks5AuthenticationInput {
  readonly username: string;
  readonly password: string;
}

export interface StartSocks5ProxyInput {
  readonly session: TargetRef;
  readonly bind: NetworkAddress;
  readonly authentication?: Socks5AuthenticationInput;
  readonly connectTimeoutSeconds: number;
  readonly closeTimeoutSeconds: number;
  readonly maxConnections: number;
  readonly maxBufferedBytesPerConnection: number;
}

export interface StopReversePortForwardInput {
  readonly session: TargetRef;
  readonly listenerId: number;
  readonly expectedBind: NetworkAddress | null;
  readonly expectedDestination: NetworkAddress | null;
}

export type NetworkLocalForwardStatus = "starting" | "listening" | "closing" | "closed" | "failed";
export type NetworkLocalForwardReason =
  | "requested"
  | "aborted"
  | "client-disconnected"
  | "listener-error"
  | "transport-disconnected";

export interface NetworkLocalForwardState {
  readonly status: NetworkLocalForwardStatus;
  readonly activeConnections: number;
  readonly totalConnections: number;
  readonly bytesToTarget: number;
  readonly bytesFromTarget: number;
  readonly reason?: NetworkLocalForwardReason;
}

export interface NetworkPortForwardSummary {
  readonly kind: "port-forward";
  readonly id: string;
  readonly sessionId: string;
  readonly bind: NetworkAddress;
  readonly destination: NetworkAddress;
  readonly state: NetworkLocalForwardState;
  readonly createdAt: string;
}

export interface NetworkSocks5ProxySummary {
  readonly kind: "socks5";
  readonly id: string;
  readonly sessionId: string;
  readonly bind: NetworkAddress;
  readonly authentication: "none" | "username-password";
  readonly state: NetworkLocalForwardState;
  readonly createdAt: string;
}

export interface NetworkReversePortForwardSummary {
  readonly kind: "reverse-port-forward";
  readonly listenerId: number;
  readonly sessionId: string;
  readonly bind: NetworkAddress | null;
  readonly destination: NetworkAddress | null;
  readonly status: "listening";
}

export interface NetworkReversePortForwardInventory {
  readonly status: "idle" | "ready" | "error";
  readonly items: readonly NetworkReversePortForwardSummary[];
  readonly error?: string;
}

export interface NetworkForwardingSnapshot {
  readonly portForwards: readonly NetworkPortForwardSummary[];
  readonly reversePortForwards: NetworkReversePortForwardInventory;
  readonly socks5Proxies: readonly NetworkSocks5ProxySummary[];
  readonly updatedAt: string;
}

export interface NetworkSessionSummary {
  readonly id: string;
  readonly name: string;
  readonly hostname: string;
  readonly username: string;
  readonly os: string;
  readonly arch: string;
  readonly liveness: SessionLiveness;
}

export interface NetworkSessionEntry {
  readonly session: NetworkSessionSummary;
  readonly ref: TargetRef;
}

export interface NetworkSessionInventory {
  readonly status: DomainStatus;
  readonly items: readonly NetworkSessionEntry[];
  readonly updatedAt?: string;
  readonly error?: string;
}

export interface NetworkWindowContext {
  readonly connection: ConnectionSummary;
  readonly sessions: NetworkSessionInventory;
}

export interface NetworkForwardingAPI {
  getContext(): Promise<OperationResult<NetworkWindowContext>>;
  list(input: ListNetworkForwardsInput): Promise<OperationResult<NetworkForwardingSnapshot>>;
  startPortForward(input: StartPortForwardInput): Promise<OperationResult<NetworkPortForwardSummary>>;
  stopPortForward(id: string): Promise<OperationResult>;
  startReversePortForward(
    input: StartReversePortForwardInput,
  ): Promise<OperationResult<NetworkReversePortForwardSummary>>;
  stopReversePortForward(input: StopReversePortForwardInput): Promise<OperationResult>;
  startSocks5Proxy(input: StartSocks5ProxyInput): Promise<OperationResult<NetworkSocks5ProxySummary>>;
  stopSocks5Proxy(id: string): Promise<OperationResult>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onChanged(listener: () => void): () => void;
  onNavigationRequested(listener: (tab: NetworkTabId) => void): () => void;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
}

export function isNetworkTabId(value: unknown): value is NetworkTabId {
  return typeof value === "string" && (NETWORK_TAB_IDS as readonly string[]).includes(value);
}

export function parseNetworkTabId(value: unknown): NetworkTabId {
  if (!isNetworkTabId(value)) throw new TypeError("Invalid Network tab");
  return value;
}

export function parseListNetworkForwardsInput(value: unknown): ListNetworkForwardsInput {
  const record = exactRecord(value, ["reverseTargets"], true, "network inventory input");
  const reverseTargets = record["reverseTargets"];
  if (reverseTargets === undefined) return Object.freeze({});
  if (!Array.isArray(reverseTargets) || reverseTargets.length > NETWORK_FORWARDING_LIMITS.reverseInventorySessions) {
    throw new TypeError("Invalid reverse inventory sessions");
  }
  const parsed = reverseTargets.map(parseSessionRef);
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    throw new TypeError("Reverse inventory sessions must be unique");
  }
  return Object.freeze({ reverseTargets: Object.freeze(parsed) });
}

export function parseStartPortForwardInput(value: unknown): StartPortForwardInput {
  const record = exactRecord(value, [
    "session",
    "bind",
    "destination",
    "keepAliveSeconds",
    "connectTimeoutSeconds",
    "closeTimeoutSeconds",
    "maxConnections",
    "maxBufferedBytesPerConnection",
  ], false, "port forward input");
  const maxConnections = boundedInteger(
    record["maxConnections"],
    1,
    NETWORK_FORWARDING_LIMITS.portForwardConnections,
    "Port forward connection limit",
  );
  const maxBufferedBytesPerConnection = boundedInteger(
    record["maxBufferedBytesPerConnection"],
    1,
    NETWORK_FORWARDING_LIMITS.portForwardBufferBytes,
    "Port forward buffer limit",
  );
  if (maxConnections * maxBufferedBytesPerConnection > NETWORK_FORWARDING_LIMITS.portForwardTotalBufferBytes) {
    throw new TypeError("Port forward aggregate buffer limit is too large");
  }
  return Object.freeze({
    session: parseSessionRef(record["session"]),
    bind: parseAddress(record["bind"], true, "Port forward bind"),
    destination: parseAddress(record["destination"], false, "Port forward destination"),
    keepAliveSeconds: keepAlive(record["keepAliveSeconds"]),
    connectTimeoutSeconds: timeout(record["connectTimeoutSeconds"], "Port forward connect timeout"),
    closeTimeoutSeconds: timeout(record["closeTimeoutSeconds"], "Port forward close timeout"),
    maxConnections,
    maxBufferedBytesPerConnection,
  });
}

export function parseStartReversePortForwardInput(value: unknown): StartReversePortForwardInput {
  const record = exactRecord(
    value,
    ["session", "bind", "destination", "keepAliveSeconds"],
    false,
    "reverse port forward input",
  );
  return Object.freeze({
    session: parseSessionRef(record["session"]),
    bind: parseAddress(record["bind"], false, "Reverse port forward bind"),
    destination: parseAddress(record["destination"], false, "Reverse port forward destination"),
    keepAliveSeconds: keepAlive(record["keepAliveSeconds"]),
  });
}

export function parseStartSocks5ProxyInput(value: unknown): StartSocks5ProxyInput {
  const record = exactRecord(value, [
    "session",
    "bind",
    "authentication",
    "connectTimeoutSeconds",
    "closeTimeoutSeconds",
    "maxConnections",
    "maxBufferedBytesPerConnection",
  ], true, "SOCKS5 proxy input");
  const authentication = record["authentication"] === undefined
    ? undefined
    : parseSocks5Authentication(record["authentication"]);
  return Object.freeze({
    session: parseSessionRef(record["session"]),
    bind: parseAddress(record["bind"], true, "SOCKS5 bind"),
    ...(authentication ? { authentication } : {}),
    connectTimeoutSeconds: timeout(record["connectTimeoutSeconds"], "SOCKS5 connect timeout"),
    closeTimeoutSeconds: timeout(record["closeTimeoutSeconds"], "SOCKS5 close timeout"),
    maxConnections: boundedInteger(
      record["maxConnections"],
      1,
      NETWORK_FORWARDING_LIMITS.socks5Connections,
      "SOCKS5 connection limit",
    ),
    maxBufferedBytesPerConnection: boundedInteger(
      record["maxBufferedBytesPerConnection"],
      1,
      NETWORK_FORWARDING_LIMITS.socks5BufferBytes,
      "SOCKS5 buffer limit",
    ),
  });
}

export function parseStopReversePortForwardInput(value: unknown): StopReversePortForwardInput {
  const record = exactRecord(
    value,
    ["session", "listenerId", "expectedBind", "expectedDestination"],
    false,
    "reverse port forward stop input",
  );
  const expectedBind = record["expectedBind"] === null
    ? null
    : parseAddress(record["expectedBind"], false, "Expected reverse bind");
  const expectedDestination = record["expectedDestination"] === null
    ? null
    : parseAddress(record["expectedDestination"], false, "Expected reverse destination");
  if ((expectedBind === null) !== (expectedDestination === null)) {
    throw new TypeError("Reverse port forward identity metadata is incomplete");
  }
  return Object.freeze({
    session: parseSessionRef(record["session"]),
    listenerId: boundedInteger(record["listenerId"], 1, 0xffff_ffff, "Reverse port forward listener ID"),
    expectedBind,
    expectedDestination,
  });
}

export function parsePortForwardId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) throw new TypeError("Invalid port forward ID");
  return value;
}

export function parseSocks5ProxyId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^socks5-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  ) throw new TypeError("Invalid SOCKS5 proxy ID");
  return value;
}

function parseSocks5Authentication(value: unknown): Socks5AuthenticationInput {
  const record = exactRecord(value, ["username", "password"], false, "SOCKS5 authentication");
  const username = credential(record["username"], "SOCKS5 username");
  const password = credential(record["password"], "SOCKS5 password");
  return Object.freeze({ username, password });
}

function parseAddress(value: unknown, allowZeroPort: boolean, label: string): NetworkAddress {
  const record = exactRecord(value, ["host", "port"], false, label);
  if (typeof record["host"] !== "string") throw new TypeError(`${label} host is invalid`);
  let host = record["host"].trim();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (
    !host ||
    host.length > NETWORK_FORWARDING_LIMITS.hostCharacters ||
    /\s|[\u0000-\u001f\u007f]/u.test(host)
  ) throw new TypeError(`${label} host is invalid`);
  return Object.freeze({
    host,
    port: boundedInteger(record["port"], allowZeroPort ? 0 : 1, 65_535, `${label} port`),
  });
}

function parseSessionRef(value: unknown): TargetRef {
  const record = exactRecord(
    value,
    ["mode", "id", "backendEpoch", "domainRevision", "fingerprint"],
    false,
    "session reference",
  );
  if (
    record["mode"] !== "session" ||
    typeof record["id"] !== "string" ||
    !record["id"].trim() ||
    record["id"].length > 128 ||
    !Number.isSafeInteger(record["backendEpoch"]) ||
    Number(record["backendEpoch"]) < 1 ||
    !Number.isSafeInteger(record["domainRevision"]) ||
    Number(record["domainRevision"]) < 0 ||
    typeof record["fingerprint"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record["fingerprint"])
  ) throw new TypeError("Invalid session reference");
  return Object.freeze({
    mode: "session",
    id: record["id"].trim(),
    backendEpoch: Number(record["backendEpoch"]),
    domainRevision: Number(record["domainRevision"]),
    fingerprint: record["fingerprint"],
  });
}

function credential(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} is invalid`);
  const length = utf8ByteLength(value);
  if (length < 1 || length > NETWORK_FORWARDING_LIMITS.socks5CredentialBytes) {
    throw new TypeError(`${label} must contain 1 to ${NETWORK_FORWARDING_LIMITS.socks5CredentialBytes} UTF-8 bytes`);
  }
  return value;
}

function timeout(value: unknown, label: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > NETWORK_FORWARDING_LIMITS.operationTimeoutSeconds
  ) throw new TypeError(`${label} must be greater than 0 and at most ${NETWORK_FORWARDING_LIMITS.operationTimeoutSeconds} seconds`);
  return value;
}

function keepAlive(value: unknown): number {
  return boundedInteger(value, -1, 0x7fff_ffff, "Keepalive");
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  optionalKeys: boolean,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !allowedKeys.includes(key))) throw new TypeError(`Invalid ${label}`);
  if (!optionalKeys && allowedKeys.some((key) => !keys.includes(key))) throw new TypeError(`Invalid ${label}`);
  if (optionalKeys) {
    const required = allowedKeys.filter((key) => key !== "reverseTargets" && key !== "authentication");
    if (required.some((key) => !keys.includes(key))) throw new TypeError(`Invalid ${label}`);
  }
  return record;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}
