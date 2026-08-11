import { isIP } from "node:net";

const KiB = 1024;
const MiB = 1024 * KiB;
const IP_LITERAL_TLS_AUTHORITY = "sliver";

/** Maximum decoded payload accepted by the bounded endpoint-workbench helpers. */
export const WORKBENCH_ARTIFACT_MAX_PAYLOAD_BYTES = 64 * MiB;
/**
 * Leave room for gzip expansion overhead, protobuf length prefixes, request
 * metadata, and response metadata without granting the workbench the legacy
 * 256 MiB artifact allocation.
 */
export const WORKBENCH_ARTIFACT_RPC_MESSAGE_BYTES = 66 * MiB;
/** Maximum terminal/tunnel data carried by one protobuf frame. */
export const TUNNEL_STREAM_MAX_PAYLOAD_BYTES = 64 * KiB;
/** Room for the bounded payload plus tunnel identifiers and protobuf framing. */
export const TUNNEL_STREAM_RPC_MESSAGE_BYTES = 66 * KiB;

export const RPC_MESSAGE_DOMAINS = [
  "control",
  "inventory",
  "task-content",
  "tunnel-stream",
  "workbench-artifact",
  "artifact",
] as const;
export type RpcMessageDomain = (typeof RPC_MESSAGE_DOMAINS)[number];

/**
 * Channel-level limits are enforced by grpc-js before inbound protobuf payloads
 * are decoded. Keep control traffic deliberately small, allow bounded summary
 * inventories, and isolate the current binary artifact RPCs on their own
 * channel instead of granting every RPC an artifact-sized allocation.
 */
export const RPC_MESSAGE_BUDGETS = Object.freeze({
  control: Object.freeze({
    maxSendBytes: 8 * MiB,
    maxReceiveBytes: 16 * MiB,
  }),
  inventory: Object.freeze({
    maxSendBytes: 4 * MiB,
    maxReceiveBytes: 32 * MiB,
  }),
  // Beacon task detail in the desktop client accepts at most a 64 KiB decoded
  // operation response. Keep protobuf framing and the small request envelope
  // on a separate channel so this path can never inherit artifact allocations.
  "task-content": Object.freeze({
    maxSendBytes: 1 * MiB,
    maxReceiveBytes: 80 * KiB,
  }),
  // M3 interactive streams use small, independently bounded frames. Never
  // grant a long-lived duplex tunnel an inventory or artifact-sized decoder.
  "tunnel-stream": Object.freeze({
    maxSendBytes: TUNNEL_STREAM_RPC_MESSAGE_BYTES,
    maxReceiveBytes: TUNNEL_STREAM_RPC_MESSAGE_BYTES,
  }),
  // M2 endpoint-workbench binary RPCs are hard-capped at 64 MiB decoded. Keep
  // them isolated so neither control traffic nor these helpers inherit the
  // broader legacy InteractiveSession/InteractiveBeacon artifact allowance.
  "workbench-artifact": Object.freeze({
    maxSendBytes: WORKBENCH_ARTIFACT_RPC_MESSAGE_BYTES,
    maxReceiveBytes: WORKBENCH_ARTIFACT_RPC_MESSAGE_BYTES,
  }),
  artifact: Object.freeze({
    maxSendBytes: 256 * MiB,
    maxReceiveBytes: 256 * MiB,
  }),
} satisfies Record<RpcMessageDomain, { maxSendBytes: number; maxReceiveBytes: number }>);

export function rpcMessageChannelOptions(
  domain: RpcMessageDomain,
  authorityOverride?: string,
): Readonly<Record<string, number | string>> {
  const budget = RPC_MESSAGE_BUDGETS[domain];
  return Object.freeze({
    "grpc.max_send_message_length": budget.maxSendBytes,
    "grpc.max_receive_message_length": budget.maxReceiveBytes,
    ...(authorityOverride
      ? {
          "grpc.ssl_target_name_override": authorityOverride,
          "grpc.default_authority": authorityOverride,
        }
      : {}),
  });
}

/**
 * Node rejects IP literals as TLS SNI values. grpc-js still derives SNI from
 * an IP-literal target even when Sliver's CA-only identity check is in use, so
 * provide a stable DNS-form authority for direct IP targets. A loopback proxy
 * also needs the original DNS authority when the configured host is a name.
 */
export function rpcTlsAuthorityOverride(host: string, throughProxy: boolean): string | undefined {
  const normalized = host.trim().replace(/^\[|\]$/gu, "");
  if (isIP(normalized) !== 0) return IP_LITERAL_TLS_AUTHORITY;
  return throughProxy && normalized ? normalized : undefined;
}
