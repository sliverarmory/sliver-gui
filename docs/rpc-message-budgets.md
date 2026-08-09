# RPC message budgets

Sliver GUI uses three authenticated gRPC channels to the same operator server.
Channel separation prevents small control and inventory methods from inheriting
the allocation required by payload generation and download responses.

| Domain | Maximum send | Maximum receive | Current traffic |
| --- | ---: | ---: | --- |
| Control | 8 MiB | 16 MiB | version, events, jobs, listener and metadata mutations |
| Inventory | 4 MiB | 32 MiB | compiler targets, implant builds, profiles, websites, loot metadata |
| Artifact | 256 MiB | 256 MiB | generated implants, stages, build downloads, task/file and content payloads |

The limits are installed as `grpc.max_send_message_length` and
`grpc.max_receive_message_length` channel options. `@grpc/grpc-js` rejects an
oversized inbound message from its framed byte length before passing it to the
generated protobuf deserializer. The renderer never receives artifact bytes;
the Electron main process writes current artifacts through native save dialogs.

The artifact ceiling is intentionally finite. Raising it requires a reviewed
change to `RPC_MESSAGE_BUDGETS`, regression coverage, and a memory-impact review.
Future streaming features must use the separate bounded streaming plane from
the roadmap rather than increasing these unary limits.
