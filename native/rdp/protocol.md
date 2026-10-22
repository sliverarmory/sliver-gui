# Native RDP protocol, version 1

The packaged helper owns one RDP connection. Main starts the fixed executable
without a shell, inherits private stdin/stdout/stderr pipes, sends one `connect`
command, and closes/kills it on application shutdown. EOF cancels the connection.
No credentials belong in arguments, environment variables, startup files or logs.

Commands are UTF-8 NDJSON, at most 2 MiB per line. Unknown fields and variants
are rejected. JSON numbers are bounded by their typed Rust fields. Main binds
this private stream to its session/attempt; session IDs are not command fields.

| Command `type` | Fields |
| --- | --- |
| `connect` | `host` (bare hostname/IP), `port`, `username`, `password`, optional `domain`, optional `signInMode` (`nla` or `remote-screen`, defaults to NLA), optional `connectAddress` (`{host,port}` as described below), `width`, `height`, `clipboard`, optional `pinnedFingerprint` (64 hex SHA-256), optional `keyboardLayout` (Windows HKL) |
| `trustDecision` | `requestId` (decimal string from challenge), `accept` |
| `input` | `events` (up to 64) |
| `releaseAll` | none |
| `resize` | `width`, `height`, `scaleFactor` (100–500) |
| `clipboardSend` | `text` (up to 1 MiB UTF-8, no NUL) |
| `clipboardRequest` | none; explicit receive only |
| `clipboardFilesOffer` | `offerId`, `files`: up to 64 `{name,size}` records; basenames only, 256 MiB combined |
| `clipboardFilesRequest` | `requestId`; explicitly request the current remote file descriptors |
| `clipboardFileRead` | `requestId`, `clipboardId`, `index`, `offset`, `length` (1–262144 bytes, within the advertised size) |
| `clipboardFileResponse` | `requestId` from `clipboardFileRequest`, either `data` (base64, at most 256 KiB decoded) or `error:true` |
| `clipboardFilesCancel` | revoke local offers and cancel file reads; retain the latest remote format advertisement for retry |
| `snapshot` | none; aborts unsent old presentation and requests full current desktop/cursor |
| `ack` | `seq` of a received frame tile |
| `disconnect` | none |

`remote-screen` requires empty username, password, and domain, negotiates TLS
without CredSSP, and disables autologon. A server requiring NLA returns
`state:failed` with `code:nla-required`; no mode changes or retries occur.

`connectAddress` is a main-owned TCP dial override. Its host must be exactly
`127.0.0.1` or `::1` and its port must be 1–65535; extra fields are rejected.
The original `host` and `port` still identify the RDP server for TLS, certificate
events, and CredSSP. The helper never resolves or falls back to that original
host when an override is present, and does not enable UDP. Main owns proxy
authentication, destination resolution through SOCKS, and route cancellation.

Input event `kind` is `key` (`scanCode`: u8, `extended`, `down`), `unicode`
(`codePoint`: Unicode scalar, `down`), or `mouse` (`x`, `y`, optional `button`:
`left`/`middle`/`right`/`back`/`forward`, required `down` with a button, optional
`wheel` in signed RDP units, optional `horizontal`). Button transitions and keys
are ordered; main may coalesce unsent motion. Native releases held input on
`releaseAll`; main must send it on focus loss/detach.

Output is a sequence of binary packets:

```
[u32 little-endian JSON header length][u32 little-endian payload length]
[UTF-8 JSON object][binary payload]
```

Header cap is 2 MiB; binary payload cap is 256 KiB. Stderr never contains
protocol output or upstream trace logs. Output events:

- `ready`: `protocol`, `version`, `revision`, `buildIdentity`.
- `state`: `state` (`connecting`, `authenticating`, `active`, `failed`,
  `disconnected`) and optional bounded `code`.
- `certificate`: `requestId` (string), `endpoint`, `fingerprint`,
  `certificateDer` (base64), `validationKind`, `canOverride`.
- `peerCertificate`: `endpoint`, `fingerprint`, `certificateDer`,
  `validationKind`, emitted after every authorized certificate decision.
- `frame`: `seq`, `frameId`, `geometry`, `width`, `height`, `x`, `y`,
  `tileWidth`, `tileHeight`, `full`, `first`, `last`; payload is tightly packed
  RGBA8 with alpha 255 and exactly `tileWidth * tileHeight * 4` bytes.
- `cursor`: `kind` (`default`, `hidden`, `position`, `bitmap`); position has
  `x`, `y`; bitmap has `width`, `height`, `hotspotX`, `hotspotY` and RGBA8 payload.
- `clipboardReady`, `clipboardAvailable` (`available`), `clipboard` (`text`).
- `clipboardFilesCapability`: `supported`, from negotiated streaming support.
- `clipboardFilesAvailable`: `available`, remote file format availability.
- `clipboardFiles`: `requestId`, `clipboardId`, `files` (`name`, `size`).
- `clipboardFileRequest`: `requestId`, `offerId`, `index`, `offset`, `length`;
  asks main to read a range from an explicitly offered local file.
- `clipboardFileChunk`: `requestId`, `error`; a successful response contains
  the exact requested range in its binary payload; an error has no payload.
- `clipboardFilesError`: optional `requestId`, sanitized `code`. Offer failures
  use the `offerId` as `requestId`. These failures do not disconnect RDP.
- `clipboardFileUploadProgress`: `offerId`, `transferId` (`upload-N`), `phase`
  (`transferring`, `completed`, `failed`, `canceled`), `transferredBytes`,
  `totalBytes`, `completedFiles`, `totalFiles`. The ID identifies one observed
  upload cycle for an offer; a repeated paste can start another cycle.
- `resizeFallback`: server requires a connection restart for requested geometry.
- `error`: sanitized `code`; never format arbitrary upstream errors.
- `terminated`: `code`.

Certificate kinds: `valid`, `unknownIssuer`, `expired`, `notValidYet`,
`nameMismatch`, `pinMismatch`, `hardFailure`. The typed fork hook checks every
certificate, including PKI-valid ones. Unknown/cryptographic failures cannot be
overridden. A changed pin always requires review, including a CA-valid replacement.
Trust decisions expire after 60 seconds and are bound to a single pending ID.
Main is responsible for persistence and must never auto-accept arbitrary errors.

Frame sequences are monotonically increasing. Main/viewer acknowledges tiles
when accepted into its bounded assembly buffer; the native limit is 8 MiB and
128 unacknowledged packets. Never wait until an entire large frame is received
to return credit. Commit an assembled `frameId` atomically only on `last`;
`first` of a newer batch replaces an incomplete older batch. A full snapshot
initializes a geometry, then deltas apply to it. Native consumes every RDP delta
into its current framebuffer, so presentation coalescing does not lose pixels.
Main additionally binds packets to its viewer attachment generation and revokes
old attachments before granting a replacement. Dimensions are limited to 8192
per axis and 16 million pixels. Buffers are not assumed zero-copy across pipes.
The native fork also limits incoming static/dynamic channel message reassembly
to 64 MiB before channel-backend validation; the clipboard text limit is 1 MiB.

File copy uses CLIPRDR streaming with `FileGroupDescriptorW`; it does not enable
drive redirection or access the native OS clipboard. Main owns all filesystem
handles, private temporary storage, and writes. Native sees only
basenames, sizes, opaque IDs and bytes. File IDs are 1–128 ASCII letters, digits,
hyphens or underscores. Collections contain only regular, root-level files;
directories, relative paths, reserved Windows device names, duplicate names
(case insensitive), and collections larger than 256 MiB are rejected.

Main bounds operations with timeouts and sends `clipboardFilesCancel` on focus
loss, viewer revocation, cancellation and disconnect. Cancellation changes the
remote `clipboardId`, so stale reads cannot use a previous descriptor list.
An unanswered descriptor/text request remains a tombstone until its response
arrives: the CLIPRDR format reply has no wire request ID. Another format request
is rejected as busy until that reply drains. File locks are not negotiated;
clipboard changes cancel in-flight transfers instead of retaining old files.

At most 16 reads per direction can be outstanding. Main/native file payloads
are limited to 256 KiB. To support peers requesting larger ranges, native can
assemble one CLIPRDR reply from multiple sequential main reads (at most 4 MiB
per remote request, 16 MiB reserved across all such requests). Every main read
gets a fresh request ID. Unknown, duplicate, oversized or short responses never
advance a transfer. No payload or path is sent to the renderer.

Upload progress starts only when the peer requests file SIZE/RANGE data. Byte
counts track the union of successfully queued FILECONTENTS ranges, so overlapping
reads and retries do not inflate progress. Counters advance after the response
is accepted by the RDP input queue; completion means all advertised bytes have
been handed to the transport, not that the remote filesystem persisted them.
Intermediate progress is limited to ten events per second; start and terminal
events are immediate. An active cycle emits at most one terminal event.

Zero-length files count as complete at cycle start. The pinned IronRDP API
answers file descriptors inline without a backend callback, so a descriptor-only
paste containing exclusively empty files may produce no upload progress event.
A subsequent nonempty byte-range request after completion begins a new
`transferId`. SIZE, EOF and zero-length range probes do not restart progress;
neither does an identical retry of the final request within 100 ms. CLIPRDR provides no
paste-operation identifier, so later retries and repeated pastes are otherwise
indistinguishable. Exact coverage uses compact intervals and switches fragmented
files to one bit per byte, bounded to 32 MiB across a maximum-size collection.
The peer does not report an abandoned paste; an incomplete upload stays active
until clipboard ownership, focus, or connection changes cancel it.

`--version`, `--build-info`, and `--self-test` are offline invocations. The last
two return JSON, with `--self-test` reporting `{"ok":true,"protocol":1}` on success.
Build metadata uses `SLIVER_RDP_BUILD_ID`, `SLIVER_RDP_BUILD_TARGET`, and
`SLIVER_RDP_SOURCE_REVISION` at compile time only; runtime environment values do
not change it.
