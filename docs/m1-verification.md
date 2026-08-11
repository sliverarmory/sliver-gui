# M1 verification evidence

- Date: 2026-08-09
- Milestone state: complete; operator accepted
- M2 state: session-first scope accepted on 2026-08-10; M3 unlocked
- Local package host: macOS arm64
- Actual server: loopback `127.0.0.1:53137`, Sliver 1.7.6 dirty

## Protocol and provenance

The final protocol gate used the exact locked Node 24.0.0 and npm 11.19.0
toolchain with isolated, pinned Sliver and wrapper sources. It did not use the
adjacent mutable server checkout as protocol evidence.

```text
261/261 reachable static commands and reviewed annotations passed
5/5 protobuf files passed byte and descriptor-semantic verification
10 snapshot + 4 reviewed handwritten overlay + 5 generated files verified
Vendored source bundle and handwritten overlay verification passed
```

The M1 annotations cover the target, presence, session, beacon, operation, and
task surface. Renderer input selects only a closed compiled operation ID; it
cannot choose an arbitrary protobuf message, RPC method, or administrative
operation.

## Application checks

```text
npm run typecheck
  Node/main and renderer TypeScript projects passed

npm test
  38 test files passed, 1 opt-in file skipped
  393 tests passed, 2 opt-in tests skipped

M1 focused regression suite
  12 files and 245 tests passed
  nested beacon-task envelope wire tests: 2 passed

npm run test:e2e:m1
  1 passed, 0 failed, 0 skipped
  production renderer -> frozen preload -> trusted IPC -> injected client
  test 3.940 s; total 4.048 s

npm run package
  typecheck, production build, release-content verifier, electron-builder,
  and complete app.asar source/provenance/exclusion scan passed

npm run test:e2e:packaged
  1 passed, 0 failed, 0 skipped
  final packaged app against the deterministic loopback mTLS fixture
  total 3.691 s

npm run test:e2e:packaged-real-m1
  1 passed, 0 failed, 0 skipped
  final packaged app against the actual loopback Sliver server
  total 65.332 s
```

The full unit suite was run outside the filesystem sandbox because its two
message-budget integration tests intentionally bind temporary loopback gRPC
sockets. Both allocation-boundary tests passed there.

## Actual-server M1 coverage

The opt-in real-server harness used the freshly packaged production executable,
an isolated private copy of the mTLS operator configuration, and a test-owned
HTTPS listener on loopback port `55243`. It created one uniquely named session
build and one uniquely named beacon build and recorded exact server-issued
resource IDs before mutation or cleanup.

The passing run verified:

- authoritative session, beacon, operator, capability, and target selection
  state through the real renderer, preload, IPC handlers, and main registry;
- visible, mode-isolated Sessions and Beacons navigation, grids, detail, and
  maintenance surfaces under the Interact sidebar group;
- a synchronous session ping and environment mutation;
- an asynchronous beacon ping and environment mutation with exact local task
  ownership, typed completion, history, and detail;
- authoritative cancellation of a real pending beacon task without replay;
- typed beacon timing reconfiguration, including an exact nested
  `ReconfigureReq` wire value of `3000000000` nanoseconds;
- beacon-to-session conversion over the main-owned current `ActiveC2`, followed
  by authoritative discovery of the exact converted session and confirmation
  of its normalized `3000` ms reconnect interval;
- renderer and screenshot non-exposure of the operator token, private key,
  source configuration path, and isolated copied configuration path.

Task request verification unwraps the pinned Sliver beacon-task envelope before
decoding the inner request. Golden bytes and wrong-message-type tests fail
closed at this boundary; task request, envelope-data, and response buffers are
zeroized after inspection.

Cleanup is part of the test result rather than best-effort logging. The harness
removed only its captured listener, profiles, builds, original session, beacon,
converted sessions, and child processes. After the pass, port `55243` had no
TCP or UDP owner, no `m1-session` or `m1-beacon` process remained, and the
original Sliver server was still listening on `127.0.0.1:53137` as PID 11232.

## Package and screenshot evidence

The final unpacked macOS arm64 archive is:

```text
release/mac-arm64/Sliver GUI.app/Contents/Resources/app.asar
size: 11,445,876 bytes
SHA-256: 6ac117ab8c65f7fc8e9b6bdffc4a0ccfc6b5ea871180ec208cbb59b8aa4e5eae
```

The archive verifier found no E2E fixtures, source maps, or known test-secret
markers and confirmed the packaged license, vendored client source, parity,
protocol, and provenance evidence.

The real-server screenshot is generated locally at
`artifacts/e2e/packaged-real-m1-darwin-arm64.png`:

```text
size: 462,640 bytes
SHA-256: 8a1327b827acea210b96bc04301b3281205b8f25234391331f3520c45f14492d
```

## Fault, ownership, and disposition evidence

Focused unit and Electron coverage includes duplicate request IDs, bounded
concurrent admission, timeout after submission, cancellation-before-dispatch,
cancellation-versus-completion in both orders, response loss, outcome
reconciliation without replay, stale backend epochs, target disappearance,
large paged catalogs, two-window target/ownership isolation, and reconnect plus
navigation persistence.

Focused renderer coverage separately verifies mode-scoped server-side search,
paging, opposite-domain error isolation, stale-response quarantine, collapsed
tooltips, and mobile navigation closure for both dedicated dashboards.

The operation model defines bounded standard dispositions for inline text and
tables, structured detail, native save, loot save, binary preview, and stream
attachment. M1 exercises inline-text and structured-detail results; the save,
preview, and stream workflows remain consumers for their later milestones.

Operator presence is read-only. Local configuration metadata is not presented
as verified actor attribution, and non-local tasks remain external/unknown
unless authenticated protocol metadata proves an actor.

## C2 and certification boundaries

M1 timing reconfiguration and beacon-to-session conversion use only the exact
main-owned current `ActiveC2`. Arbitrary renderer-authored C2 URIs and alternate
endpoint selection remain deferred until Sliver exposes an authoritative,
stable endpoint-option identity. Implant-side WireGuard remains supported when
it is the reported current endpoint; only WireGuard-enabled operator
configurations remain deferred.

This evidence validates the current macOS arm64 development host and the
workflow/build definitions. It does not claim installed-package certification
on the minimum-runtime matrix. Dedicated macOS Ventura 13.7.8 arm64 and Intel,
Windows 11 24H2 x64, and Ubuntu 22.04.5 x64 install lanes remain pending under
ADR 0001. The local package is unsigned.

## Operator handoff

The operator explicitly accepted M1 on 2026-08-09. The actual loopback Sliver
server remains available for follow-on verification, and M2 is unlocked with
the session interaction workbench as its first operator-directed tranche.
