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
| `connect` | `host` (bare hostname/IP), `port`, `username`, `password`, optional `domain`, `width`, `height`, `clipboard`, optional `pinnedFingerprint` (64 hex SHA-256), optional `keyboardLayout` (Windows HKL) |
| `trustDecision` | `requestId` (decimal string from challenge), `accept` |
| `input` | `events` (up to 64) |
| `releaseAll` | none |
| `resize` | `width`, `height`, `scaleFactor` (100–500) |
| `clipboardSend` | `text` (up to 1 MiB UTF-8, no NUL) |
| `clipboardRequest` | none; explicit receive only |
| `snapshot` | none; aborts unsent old presentation and requests full current desktop/cursor |
| `ack` | `seq` of a received frame tile |
| `disconnect` | none |

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

`--version`, `--build-info`, and `--self-test` are offline invocations. The last
two return JSON, with `--self-test` reporting `{"ok":true,"protocol":1}` on success.
Build metadata uses `SLIVER_RDP_BUILD_ID`, `SLIVER_RDP_BUILD_TARGET`, and
`SLIVER_RDP_SOURCE_REVISION` at compile time only; runtime environment values do
not change it.
