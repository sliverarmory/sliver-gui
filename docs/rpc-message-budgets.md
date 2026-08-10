# RPC message budgets

Sliver GUI uses five authenticated gRPC channels to the same operator server.
Channel separation prevents small control and inventory methods from inheriting
the allocation required by payload generation and download responses.

| Domain | Maximum send | Maximum receive | Current traffic |
| --- | ---: | ---: | --- |
| Control | 8 MiB | 16 MiB | version, events, operators, jobs, listeners, target mutations, and task cancellation |
| Inventory | 4 MiB | 32 MiB | sessions, beacons, beacon-task metadata, compiler targets, implant builds, profiles, websites, and loot metadata |
| Task content | 1 MiB | 80 KiB | explicitly selected M1 beacon-task request/response content, bounded to a 64 KiB decoded preview plus protobuf framing |
| Workbench artifact | 66 MiB | 66 MiB | M2 session screenshots, single-file downloads/uploads, process dumps, and registry-hive reads, each with a 64 MiB decoded cap |
| Artifact | 256 MiB | 256 MiB | generated implants, stages, archived-build downloads, and other legacy bounded artifact payloads |

The limits are installed as `grpc.max_send_message_length` and
`grpc.max_receive_message_length` channel options. `@grpc/grpc-js` rejects an
oversized inbound message from its framed byte length before passing it to the
generated protobuf deserializer. The renderer never receives artifact bytes;
the Electron main process writes current artifacts through native save dialogs.

Both artifact ceilings are intentionally finite. Raising either requires a
reviewed change to `RPC_MESSAGE_BUDGETS`, regression coverage, and a
memory-impact review. The M2 session wrapper also validates the decoded payload
at 64 MiB so gzip expansion cannot consume the channel's framing headroom.
Future streaming features must use the separate bounded streaming plane from
the roadmap rather than increasing these unary limits.

## M1 typed RPC boundary

The handwritten wrapper exposes named methods for M1 inventory and presence,
target rename/kill/close/remove, ping, environment set/unset, beacon
reconfiguration and session conversion, and beacon-task list/fetch/cancel.
Each method constructs its protobuf request directly and selects one of the
four pre-M2 reviewed channel domains. There is no method that accepts an RPC
method name or forwards an arbitrary request object.

The Electron main-process adapter narrows this further. M1 renderer-submittable
operations are the closed IDs `target.ping`, `target.rename`,
`target.env-set`, `target.env-unset`, `beacon.reconfigure`, and
`beacon.open-session`; destructive lifecycle calls use separately validated
one-use action plans. Typed `getEnv` wrappers are retained for bounded
main-process verification seams. No administrative RPC surface is added.
WireGuard-enabled operator configurations remain deferred; this does not alter
independently classified implant-side WireGuard workflows.

## Session-first M2 typed RPC boundary

M2 adds explicit session wrappers for token ownership and environment reads,
network interfaces and connections, working-directory and bounded filesystem
operations, process and Windows service inventory/actions, Windows registry
operations, and the five binary workbench artifact families listed above. Each
wrapper accepts a typed parameter set and a main-owned session ID. There is no
wrapper or adapter method that accepts an RPC method name or arbitrary protobuf
request object, and beacon-mode M2 wrappers have not been added.

The renderer can invoke only the closed `SessionWorkbenchInput` union. Electron
main revalidates the exact active session, backend epoch, connection
incarnation, session fingerprint, and authoritative target platform before
dispatch. Recursive/replacement file actions, process termination, service
stop, and registry mutations require a separately prepared one-use plan. Plans
expire after 60 seconds, are limited to four outstanding plans per window, and
are invalidated by target or connection drift. Conflict-aware text and hex
editing remain unavailable even though their future action IDs are reserved.

Binary bytes never cross preload or renderer IPC. Downloads, process dumps, and
registry hives open the native save dialog before the remote call, then publish
through a private atomic write; uploads open and bound-read one regular local
file before dispatch. Screenshot bytes are kept in a main-only capability store
with a five-minute default lifetime, an 8 MiB signed-image preview cap, and
window/session/backend ownership checks. The store allows at most eight items
or 128 MiB per owner and 32 items or 256 MiB globally. Renderer-visible results
contain only safe basenames, byte counts, SHA-256 digests, bounded preview data,
and opaque handles—never local paths or raw buffers.

These are still unary operations: they report pre-submit cancellation and
terminal results, not network chunk progress or mid-transfer cancellation.
True chunking remains blocked on an upstream-supported streaming RPC and must
not be simulated with repeated renderer IPC buffer copies.

## Request timeout encoding

Public wrapper timeout arguments remain non-negative whole seconds. The local
transport deadline uses that value directly, while `commonpb.Request.Timeout`
is encoded as a protobuf int64 nanosecond string. Zero remains unset, and a
positive value is encoded as `seconds * 1,000,000,000 - 1`, matching Sliver's
canonical Go request construction while ensuring the server deadline expires
just before the local transport deadline. Unsafe integers, negative values,
fractions, and values outside protobuf int64 are rejected before an RPC is
submitted.
