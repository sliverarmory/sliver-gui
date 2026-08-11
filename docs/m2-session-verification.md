# M2 session-first verification

Date: 2026-08-10
Status: **Operator accepted the delivered session-first scope**

This document records the session-only M2 tranche accepted by the operator on
2026-08-10, which explicitly unlocked M3. This is scoped acceptance, not a claim
that deferred beacon paths, Windows/Linux certification, the central
authoritative capability service, mutation-stable cursors, loot dispositions,
or unchecked parity rows are complete.

## Delivered operator path

- Activating a row in **Live Sessions** selects the exact authoritative target
  and navigates to a dedicated workbench. The former inline selected-session
  component is no longer the interaction surface.
- Overview presents bounded identity, interface, connection, and platform-gated
  token-owner data. Windows and Linux sessions can capture a signed, bounded
  screenshot preview and save it through a main-owned native dialog.
- Files has Browser, Search, and Storage modes. Browser supports bounded
  directory continuation, path navigation, mkdir, native single-file
  upload/download, reviewed remove/copy/move, metadata controls, and a file
  inspector with Cat, Head, Tail, and Hex views.
- Complete files up to 64 KiB can be edited as UTF-8 or validated even-length
  hex. Bytes are staged in the main-owned artifact store, then saved only through
  a digest-bound, expiring, one-use reviewed overwrite plan. The compare-before-
  write narrows the race window but is not an atomic remote compare-and-swap;
  registered offset-oriented hex patch parity remains pending.
- Search exposes bounded grep results and continuation. Storage exposes bounded
  mount inventory on all supported session platforms and Linux memory-file
  list/add/reviewed-remove controls.
- Processes provides bounded list/tree presentation, continuation, server-side
  filtering, detail, platform-gated native-save dumps, and reviewed termination.
  Windows sessions also expose service list/detail/start and reviewed stop.
- Environment inventory supports continuation. Sensitive names are redacted by
  main; revealing one exact value is an explicit, short-lived operation.
- Windows Registry provides bounded subkey/value continuation, value reads,
  native hive save, typed string/binary/DWORD/QWORD writes, key creation, and
  reviewed delete mutations.
- Activity merges M1 and workbench operations for the exact session. It records
  operation identity, state, ownership, and timing without file/editor content,
  environment secrets, binary bytes, local paths, or raw remote errors.

## Main-process boundary

The renderer submits one member of the closed `SessionWorkbenchInput` union or
prepares one member of the closed `PrepareSessionDestructiveActionInput` union.
It cannot supply a backend identity, target/session ID, RPC method name,
protobuf request, local filesystem path, or raw binary buffer.

Before every request, Electron main verifies the owning window, backend epoch,
connection incarnation, exact active session reference and fingerprint,
liveness, and platform. An exact active-target change or authoritative target
loss revokes that window's workbench plans, timers, and session-artifact bytes.
Slow picker, process-inventory, and refresh results recheck the same target
identity before publishing a plan or renderer result.

Destructive and replacement operations use opaque one-use plans with a
60-second lifetime and at most four outstanding plans per window. Execution
consumes the plan before dispatch. Confirmed success is journaled as completed
before any stale-selection display guard; a result for a no-longer-selected
target is suppressed. A transport loss after a dispatched remote mutation can
produce structured `outcome-unknown` and is never replayed automatically.
Confirmed reads and pre-dispatch failures remain ordinary failures.

Standard workbench requests are admitted at eight per window and 32 globally;
artifact-class requests use the tighter limits of two per window and four
globally. Admissions remain held across reconnect until the physical request
settles. Reviewed process termination binds a main-derived process fingerprint
and rechecks authoritative inventory immediately before dispatch.

Current operation availability is a closed platform matrix combined with exact
runtime target checks. It does not yet implement the roadmap's central
capability service combining server/protobuf version, target mode, OS/arch, C2,
and provider availability. M2 workbench pagination currently uses bounded
numeric offsets rather than mutation-stable anchors; a changing remote inventory
can duplicate or skip items between pages.

## Artifact and transfer boundary

- Screenshot, download, upload, process-dump, and registry-hive RPCs use a
  separate 66 MiB send/receive channel and enforce a 64 MiB decoded cap.
- Downloads, process dumps, and registry hives open the native save dialog
  before remote dispatch. Cancellation submits no remote request.
- Uploads read one bounded regular file in main. Selected paths and raw bytes do
  not cross preload IPC. Editor bytes remain in a scoped main-owned store and
  cross IPC only as bounded metadata plus an unguessable handle.
- Native saves use private atomic writes, canonical destination reservations,
  and a latest-intent check immediately before publication. A late older result
  cannot overwrite a newer save, including canonical parent-symlink aliases.
- Store entries are bound to window/backend/epoch/connection/session identity,
  expire, and are removed on use, rejection, rebind, disconnect, or window
  teardown. Rejected and transferred buffers are zeroized.
- Renderer results contain safe basenames, sizes, SHA-256 digests, status, and
  opaque handles only. Local paths, content, and target-controlled errors are
  excluded from snapshots and Activity.
- These transfers are unary. They do not claim byte progress, network chunking,
  or mid-transfer cancellation. Native-save dispositions are delivered; remote
  loot-save dispositions remain open M2 parity work.

## Verification evidence

Focused contract, wrapper, artifact-store, workbench, registry, secure-file,
operation-engine, and renderer regression suites were exercised throughout the
session tranche. The final integrated application suite is the authoritative
count:

```sh
npm run typecheck
npm test
```

Result: **46 test files passed and one was skipped (47 total); 553 tests passed
and two were skipped (555 total)** in the final 5.44-second test run. The opt-in
actual-server lanes remain skipped by default.

The deterministic Electron lane rebuilt the client, main, preload, and renderer
and exercised the production accessibility surface through frozen preload and
trusted IPC:

```sh
npm run test:e2e:electron
```

Result: **1 test passed, zero failed, zero skipped** in 11.51 seconds. It proves
dedicated session navigation; all four file views; staged reviewed text save;
search and storage; process continuation/list/tree/filter; environment
continuation and reveal; a completed save row in Activity; back navigation;
exact-target stale-workbench quarantine; Darwin feature gating; and absence of
content, secrets, and paths from Activity and the deterministic visual capture.

The pinned parity/protocol lane regenerates the command inventory from Sliver
`9ff9b55352eb1c8f2ff6a906bb691e9cee5bcaa9`, replays the reviewed wrapper
overlay from public base `837fb21c5291eef6285c2e168eef0620b99a5394`, and
verifies the vendored allowlist and hashes:

```sh
npm run parity:check -- --source <pinned-sliver-source> --regenerate
npm run protocol:check -- \
  --sliver-source <pinned-sliver-source> \
  --wrapper-source <pinned-published-wrapper-source>
```

Result: **261 command nodes regenerated and 261 annotations validated; five
protobuf outputs matched byte-for-byte and semantically; the four-file
handwritten overlay replayed; and the bundle, source allowlist, and provenance
hashes passed**.

A fresh unsigned macOS arm64 package also passed the packaged-content check:

- `app.asar`: `879da88fcb44d3565ed3a70f2a449a2d973901dc1fce45d1313456a92bf53f00`
  (11,965,721 bytes)
- executable: `34465676648bf5e5892e8f7791929be7ee01973a5317260f4f741ab7110cfef6`
  (33,968 bytes)

A native Darwin/arm64 session implant was separately compiled, started against
an exact loopback-only HTTPS listener, and observed as an authoritative live
session. This is useful session availability evidence, not cross-platform M2
acceptance.

## Deferred after session-first acceptance

- Add supported beacon-mode M2 operations and prove synchronous session versus
  asynchronous beacon behavior for each applicable family.
- Exercise the delivered platform-gated paths against authorized disposable
  Windows and Linux targets, including transfer and mutation faults.
- Replace the static workbench platform matrix with the central authoritative
  capability service and cross-target capability tests.
- Replace numeric offset continuation with mutation-stable anchor cursors.
- Add explicit loot dispositions for screenshots, file views/downloads, process
  dumps, and Registry hives where the server supports them.
- Finish registered option parity that is intentionally narrower in this
  tranche, including line-count views, broader editor encodings, and
  offset-oriented hex patching.
