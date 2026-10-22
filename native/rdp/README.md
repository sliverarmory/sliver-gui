# Sliver GUI RDP helper

`sliver-rdp` owns a single direct TCP/TLS/CredSSP RDP session. The parent process
communicates over private pipes using [protocol version 1](protocol.md). The
helper contains the credentials and protocol/graphics state; the renderer
receives bounded RGBA frames, cursor updates and explicit clipboard results.

The source manifest pins an exact commit on the Sliver Armory IronRDP fork's
default branch, `master`, plus the digest and resulting Git tree of the tracked
patch in `patches/`. Build and test wrappers prepare the ignored `vendor/ironrdp`
checkout without modifying Cargo's global cache. They verify its base commit,
patch, index tree, and file contents before using its Cargo path dependencies.
Changed or extra staged files fail verification; remove the generated
`native/rdp/vendor/ironrdp` directory to recreate it after updating the reviewed
patch. The Cargo lockfile pins the remaining dependencies. The
branch name in provenance records where reviewed updates are taken from. Its
embedding changes supply an all-certificate policy hook, typed overridable
validation errors, a custom clipboard feature without native OS clipboard
libraries, and framebuffer allocation limits. No audio, native windows, drive
redirection or arbitrary dynamic plugins are enabled.

Resize completion follows both classic reactivation and EGFX framebuffer size
changes. The helper opts out of IronRDP's automatic resize fallback reconnection;
unsupported or timed-out resize requests require an explicit GUI reconnect.

The fork caps inbound static/dynamic channel message reassembly at 64 MiB,
including compressed static fragments, before completed messages reach backend
validation. Clipboard text has the tighter 1 MiB limit. File collections are
limited to 64 regular files and 256 MiB total, transferred through 256 KiB host
chunks with bounded native aggregation. Graphics caches and
codec state retain IronRDP's independent limits; the frame/presentation limits
are not a global process memory quota.

```sh
npm run test:rdp:native
npm run build:rdp:host
native/rdp/bin/sliver-rdp --self-test
```

Use the repository RDP build/provenance scripts for distributable binaries.
Ordinary development builds use `development` build identity and are not
interchangeable with verified packaged binaries. The release profile leaves
symbols intact because Rust 1.94.1's Mach-O strip can create an invalid LINKEDIT
string pool on macOS 27; the build scripts retain the deployment target.

The helper limits frame dimensions and presentation credits before allocating
or queueing output. It applies every upstream desktop update to its current
framebuffer, coalesces presentation damage, and supports a full snapshot for a
new viewer attachment. Key/button state is tracked for release on focus loss and
disconnect. EOF and broken stdout cancel the session. Clipboard transfer supports
explicit Unicode text and regular files in both directions. Main owns file
selection, destination selection, filesystem handles and writes; native receives
only basenames, sizes and bounded chunks. Directories and clipboard locks are
not supported. Clipboard changes and cancellation invalidate pending transfers.
The helper never accesses the filesystem or native OS clipboard for transfers.
Upload progress reports unique byte ranges accepted by the RDP input queue, with
bounded coverage tracking and throttled events. Completion does not acknowledge
remote filesystem persistence. The pinned backend cannot observe descriptor-only
copies of empty files; they may finish without a native progress notification.

TLS certificate decisions precede CredSSP authentication. Matching saved pins
are still checked on every certificate; hard verification errors cannot be
overridden. Changed pins require a new decision even for CA-valid certificates.
Private command buffers and retained clipboard strings are zeroized where owned
by this crate; upstream credential copies are not promised to be zeroized.

An optional `connectAddress` dials only a numeric loopback endpoint owned by main.
The logical host and port remain the TLS certificate and CredSSP identity. The
tracked overlay disables UDP for an override and never retries the logical
destination if the loopback connection fails. Proxy credentials and SOCKS
negotiation remain in main; the helper receives no proxy credentials.

An isolated [graphics WASM experiment](experiments/graphics-codec/README.md)
records the measured alternative. It is not shipped or loaded by the helper.
