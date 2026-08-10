# RPC message budgets

Sliver GUI uses four authenticated gRPC channels to the same operator server.
Channel separation prevents small control and inventory methods from inheriting
the allocation required by payload generation and download responses.

| Domain | Maximum send | Maximum receive | Current traffic |
| --- | ---: | ---: | --- |
| Control | 8 MiB | 16 MiB | version, events, operators, jobs, listeners, target mutations, and task cancellation |
| Inventory | 4 MiB | 32 MiB | sessions, beacons, beacon-task metadata, compiler targets, implant builds, profiles, websites, and loot metadata |
| Task content | 1 MiB | 80 KiB | explicitly selected M1 beacon-task request/response content, bounded to a 64 KiB decoded preview plus protobuf framing |
| Artifact | 256 MiB | 256 MiB | generated implants, stages, build downloads, and other bounded artifact payloads |

The limits are installed as `grpc.max_send_message_length` and
`grpc.max_receive_message_length` channel options. `@grpc/grpc-js` rejects an
oversized inbound message from its framed byte length before passing it to the
generated protobuf deserializer. The renderer never receives artifact bytes;
the Electron main process writes current artifacts through native save dialogs.

The artifact ceiling is intentionally finite. Raising it requires a reviewed
change to `RPC_MESSAGE_BUDGETS`, regression coverage, and a memory-impact review.
Future streaming features must use the separate bounded streaming plane from
the roadmap rather than increasing these unary limits.

## M1 typed RPC boundary

The handwritten wrapper exposes named methods for M1 inventory and presence,
target rename/kill/close/remove, ping, environment set/unset, beacon
reconfiguration and session conversion, and beacon-task list/fetch/cancel.
Each method constructs its protobuf request directly and selects one of the
four reviewed channels above. There is no method that accepts an RPC method
name or forwards an arbitrary request object.

The Electron main-process adapter narrows this further. Renderer-submittable
operations are the closed IDs `target.ping`, `target.rename`,
`target.env-set`, `target.env-unset`, `beacon.reconfigure`, and
`beacon.open-session`; destructive lifecycle calls use separately validated
one-use action plans. Typed `getEnv` wrappers are retained for bounded
main-process verification seams, but environment listing remains an M2 parity
workflow and is not a renderer-submittable M1 operation. No administrative RPC
surface is added. WireGuard-enabled operator configurations remain deferred;
this does not alter independently classified implant-side WireGuard workflows.

## Request timeout encoding

Public wrapper timeout arguments remain non-negative whole seconds. The local
transport deadline uses that value directly, while `commonpb.Request.Timeout`
is encoded as a protobuf int64 nanosecond string. Zero remains unset, and a
positive value is encoded as `seconds * 1,000,000,000 - 1`, matching Sliver's
canonical Go request construction while ensuring the server deadline expires
just before the local transport deadline. Unsafe integers, negative values,
fractions, and values outside protobuf int64 are rejected before an RPC is
submitted.
