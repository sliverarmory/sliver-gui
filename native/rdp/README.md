# Sliver GUI RDP helper

`sliver-rdp` owns a single direct TCP/TLS/CredSSP RDP session. The parent process
communicates over private pipes using [protocol version 1](protocol.md). The
helper contains the credentials and protocol/graphics state; the renderer
receives bounded RGBA frames, cursor updates and explicit clipboard results.

The Cargo lockfile and source manifest pin the Sliver Armory IronRDP fork. Its
embedding changes supply an all-certificate policy hook, typed overridable
validation errors, a custom clipboard feature without native OS clipboard
libraries, and framebuffer allocation limits. No audio, native windows, drive
redirection or arbitrary dynamic plugins are enabled.

Resize completion follows both classic reactivation and EGFX framebuffer size
changes. The helper opts out of IronRDP's automatic resize fallback reconnection;
unsupported or timed-out resize requests require an explicit GUI reconnect.

The fork caps inbound static/dynamic channel message reassembly at 64 MiB,
including compressed static fragments, before completed messages reach backend
validation. Clipboard content has the tighter 1 MiB limit. Graphics caches and
codec state retain IronRDP's independent limits; the frame/presentation limits
are not a global process memory quota.

```sh
cargo +1.94.1 test --locked --manifest-path native/rdp/Cargo.toml
cargo +1.94.1 build --locked --manifest-path native/rdp/Cargo.toml
native/rdp/target/debug/sliver-rdp --self-test
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
disconnect. EOF and broken stdout cancel the session. Clipboard transfer is
Unicode text and explicit in both directions; file/OS clipboard access is absent.

TLS certificate decisions precede CredSSP authentication. Matching saved pins
are still checked on every certificate; hard verification errors cannot be
overridden. Changed pins require a new decision even for CA-valid certificates.
Private command buffers and retained clipboard strings are zeroized where owned
by this crate; upstream credential copies are not promised to be zeroized.

An isolated [graphics WASM experiment](experiments/graphics-codec/README.md)
records the measured alternative. It is not shipped or loaded by the helper.
