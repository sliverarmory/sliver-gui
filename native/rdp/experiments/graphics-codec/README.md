# R0: bounded graphics WASM experiment

This experiment compiles the **same pinned IronRDP RDP6 bitmap decoder** to native
Rust and `wasm32-unknown-unknown`. It generates deterministic planar-RLE desktop
fixtures, checks pixel hashes, measures decoding and the explicit WASM-to-JS
output copy, and checks dimension/input limits and one malformed stream. It is
development evidence, not packaged runtime code or a supported graphics ABI.

## Reproduce

From the GUI repository, with the pinned Rust 1.94.1 toolchain and its
`wasm32-unknown-unknown` standard library installed:

```sh
cargo +1.94.1 run --release --locked --manifest-path native/rdp/experiments/graphics-codec/Cargo.toml -- /tmp/rdp-graphics-fixtures
cargo +1.94.1 build --release --locked --lib --target wasm32-unknown-unknown --manifest-path native/rdp/experiments/graphics-codec/Cargo.toml
node native/rdp/experiments/graphics-codec/benchmark.mjs native/rdp/experiments/graphics-codec/target/wasm32-unknown-unknown/release/rdp_graphics_experiment.wasm /tmp/rdp-graphics-fixtures
```

No credentials, network connection, DOM, JavaScript glue library, or host imports
are required. Inputs are capped at 16 MiB, dimensions at 8192 per axis and
16 million pixels. The decoder reuses its allocation; callers clear the output
because IronRDP's RGB24 method appends to its destination. Output is RGB24, while
the production helper emits RGBA8. Production would also require a hard linear
memory ceiling, worker lifecycle/abort, broader parser tests and bounded DTOs.

## Observed result

Measured on macOS 27.0.1 arm64, Node 26.12.0, Rust 1.94.1, release thin LTO,
without an explicit WASM SIMD feature. These measurements used fork pin
`de2556aa0e93d1e5e3191e4ff8b0a817338351e6`. Each case has 10 warm-up iterations;
the smaller cases have 60 measured iterations and 4K has 30. These are synthetic
flat desktop fixtures, not a live-session performance claim. Other builds were
running on the host, so rerun on isolated target hardware for an acceptance gate.
The current Cargo pin also includes subsequent static/dynamic channel reassembly
hardening; that change does not alter this bitmap codec.

| Fixture | Compressed bytes | RGB bytes | Native p95 decode | WASM p95 decode | WASM p95 output copy |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1280×800 | 128,203 | 3,072,000 | 1.59 ms | 5.39 ms | 0.51 ms |
| 1920×1080 | 265,609 | 6,220,800 | 3.17 ms | 9.64 ms | 0.80 ms |
| 3840×2160 | 1,087,075 | 24,883,200 | 12.64 ms | 33.27 ms | 1.12 ms |

Native round-trip and native/WASM output hashes matched for every fixture.
Oversized input/dimensions and the malformed fixture were rejected. The module
was 1,537,171 bytes without stripping, SHA-256
`fa3e2bb421ce66c50ba59dd2485f779236c6e7cc472159b99698afc062fe19be`.
Peak observed linear memory after the three cases was 69,992,448 bytes, excluding
the JS copies. Canvas/GPU upload, process IPC, worker communication, RGBA
conversion, GC, and session protocol processing are not measured.

## Decision and remaining seam

The codec compiles and produces identical pixels in WASM. This validates a
narrow future offload seam. It does **not** validate moving an active IronRDP
session to the sandboxed renderer. At 4K, the measured WASM decoder alone exceeds
a 16.7 ms 60 Hz frame budget. The shipped baseline therefore keeps the native
session and framebuffer authoritative, with bounded dirty RGBA tiles to canvas.
The native fallback does not depend on this experiment.

Before any production WASM switch, extract and test a graphics command boundary
after native transport/security/channel processing. It must preserve shared bulk
decompression state, fast-path fragmentation, graphics caches, surface/EGFX
ordering, reset/reactivation and frame acknowledgement semantics. Native channel
state, credentials and TLS/CredSSP must remain native. Raw decrypted RDP traffic
or a serialized `ConnectionResult` is not an acceptable replacement for that
boundary. This experiment covers only the self-contained RDP6 bitmap codec;
it does not cover RemoteFX, EGFX, AVC/H.264, classic drawing orders or recovery.

Promotion requires deterministic native/WASM equality on representative
graphics captures; resize, reconnect and lost-worker recovery; bounded memory
and queue tests under a stalled renderer; measurements of complete IPC-to-canvas
latency at 1080p and 4K on all shipped platform/architecture slices; and a native
fallback when the WASM path cannot meet the agreed latency or recovery budget.
