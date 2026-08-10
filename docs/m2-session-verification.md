# M2 session-first verification

Date: 2026-08-09
Status: **Session tranche implemented; M2 remains in progress**

This document records evidence for the first session-only M2 tranche. It is not
an M2 acceptance record. Beacon-mode M2 workflows, text and hex editing,
cross-mode/cross-platform coverage, and the remaining transfer fault matrix are
still required by `ROADMAP.md`.

## Delivered operator path

- Activating a row in **Live Sessions** selects the exact authoritative target
  and navigates to a dedicated session workbench. The old inline
  selected-session detail card is no longer the session interaction surface.
- The workbench has Overview, Files, Processes, Environment, Windows Registry,
  and Activity panels. Windows-only controls are absent on Linux and macOS
  sessions; screenshot capture is currently limited to Windows and Linux.
- Overview reads bounded network/interface state and Windows token ownership,
  and can capture a signed, bounded screenshot preview with an explicit native
  save step.
- Files resolves the current working directory, browses bounded directory pages,
  creates folders, opens a native file for single-file upload, saves
  single-file downloads through a native dialog, and confirms removals with an
  exact target/resource summary.
- Processes provides bounded filterable inventory, native-save process dumps
  where supported, and plan-confirmed termination. Windows sessions also expose
  service list/detail/start and plan-confirmed stop.
- Environment values matching the sensitive-name policy are redacted by main;
  revealing one exact variable is a separate, explicit, short-lived result.
- Windows Registry provides bounded hive/key browsing, value reads, and native
  hive save. Typed, plan-confirmed write/create/delete dispatch exists in main,
  but those mutations are intentionally not advertised in the current read-only
  registry panel.

## Main-process boundary

The renderer submits one member of the closed `SessionWorkbenchInput` union or
prepares one member of the closed `PrepareSessionDestructiveActionInput` union.
It cannot supply a backend identity, target/session ID, RPC method name,
protobuf request, local filesystem path, or raw binary buffer.

Before every operation, Electron main verifies the current window binding,
backend epoch, connection incarnation, authoritative active session, session
fingerprint, liveness, and platform. Destructive/replacement operations are
prepared as opaque one-use plans with a 60-second lifetime and a maximum of four
outstanding plans per window. Execution consumes the plan before dispatch;
connection or target drift produces `target-disappeared`, and uncertainty after
dispatch produces `outcome-unknown` without automatic replay.

Standard workbench requests are admitted at eight per window and 32 globally;
artifact-class requests use the tighter limits of two per window and four
globally. Admissions remain held across reconnect until the physical request
settles. Process-termination review binds a main-derived process fingerprint and
rechecks the authoritative process inventory immediately before dispatch, so a
vanished or observably reused PID is not terminated.

Conflict-aware text overwrite and patch-oriented hex editing have reserved
contract IDs for future work, but preparation rejects both actions. They are not
part of this tranche's renderer surface or parity claims.

## Artifact and transfer boundary

- Session screenshot, download, upload, process-dump, and registry-hive RPCs use
  a separate 66 MiB send/receive channel and enforce a 64 MiB decoded cap.
- Downloads, process dumps, and registry hives open the native save dialog before
  the remote RPC. A canceled dialog submits no remote request.
- Uploads use a native open dialog and a bounded regular-file read in main before
  dispatch. Selected paths and bytes do not cross preload IPC.
- Native saves use private atomic writes. Renderer results contain safe
  basenames, sizes, SHA-256 digests, status, and opaque handles only.
- Save destinations are canonicalized and reservations are serialized. A
  synchronous latest-intent check immediately before the atomic rename prevents
  a late response from overwriting a newer save intent, including parent-symlink
  aliases covered by the regression suite. Selected local paths and raw native
  or remote error strings are replaced with fixed boundary errors before IPC.
- Screenshot data is scoped to the exact window/backend/epoch/connection/session
  identity, expires after five minutes by default, and has an 8 MiB signed-image
  preview cap. Main validates the encoded format plus width and height (at most
  8,192 pixels on either axis) and total area (at most 33,554,432 pixels) before
  publishing a renderer preview. Store limits are eight items/128 MiB per window
  and 32 items/256 MiB globally; removal, expiry, rebind, disconnect, and window
  close clear the owned bytes.
- The current transfers are unary. They do not claim byte progress, true
  chunking, or mid-transfer cancellation.

## Verification evidence

The final focused security and workbench regression command passed on
2026-08-09:

```sh
npm test -- \
  --run \
  src/shared/session-contracts.test.ts \
  src/main/sliver-client-session-wrappers.test.ts \
  src/main/session-artifact-store.test.ts \
  src/main/session-workbench.test.ts \
  src/main/connection-registry.test.ts \
  src/main/secure-file.test.ts \
  src/main/rpc-message-budget.test.ts \
  src/renderer/src/pages/SessionWorkspacePage.test.tsx \
  src/renderer/src/pages/session-workbench-panels.test.tsx
```

Result: **9 test files and 150 tests passed**. This covers closed parsers and
platform gates; explicit wrapper dispatch and artifact budgets; main-owned
artifact scope, expiry, capacity, signature, and zeroization; bounded workbench
normalization and native cancellation; dedicated route behavior; panel loading
and error paths, environment reveal, screenshot save, file removal review,
process/service controls, Windows registry reads, exact target and process
revalidation, expiring one-use plans, global and per-window admission, native
save ordering, and path/error containment.

The final full application suite also passed:

```sh
npm run typecheck
npm test
```

Result: **44 test files passed and one was skipped; 471 tests passed and two
were skipped (473 total)**. The skipped cases are the existing opt-in lanes,
not new M2 regressions.

The deterministic Electron lane rebuilt the client, main, preload, renderer,
and injected fake backend, then passed the complete session-workbench flow:

```sh
npm run test:e2e:electron
```

Result: **1 test passed, zero failed, zero skipped** in 5.36 seconds. It proves
session-row navigation, absence of the legacy selected-session card, Overview,
Files create and reviewed delete, Processes and filtering, Environment
redaction and explicit reveal, Activity, back navigation, an already-selected
session's explicit Interact action, and stale-workbench quarantine after the
session closes.

The handwritten wrapper overlay and hashes were regenerated from the locked
published wrapper base. The complete protocol check then passed under the
locked Node 24.0.0, npm 11.19.0, Go 1.25.8, and protoc 35.1 toolchain:

```sh
npm run protocol:check -- \
  --sliver-source <pinned-sliver-source> \
  --wrapper-source <pinned-published-wrapper-source>
```

Result: **261 command nodes regenerated and 261 annotations validated; five
protobuf outputs matched byte-for-byte and semantically; the four-file
handwritten overlay replayed; the bundle, retained source allowlist, and all
provenance hashes passed**.

`npm run package` produced a fresh unsigned macOS arm64 application from this
source. The packaged artifacts were inspected and hashed:

- `app.asar`: `27b5fa10df26c01586a57db2935c8998e9874dc77ed697a4be7f01b2b25d1b27`
- executable: `34465676648bf5e5892e8f7791929be7ee01973a5317260f4f741ab7110cfef6`

The package contains no E2E harness or fixture secrets. It is unsigned because
no valid Developer ID identity was available in this environment.

Finally, a native Darwin/arm64 session implant was compiled from the local
Sliver server, started against an exact loopback-only HTTPS listener, and
observed as an authoritative live session. The long-lived manual fixture owns
its exact listener job, build, child process, and session identifiers; it does
not create a saved profile, does not relaunch after an operator action, and
cleans up only those exact resources on signal or its fixed TTL. This is manual
test availability evidence, not cross-platform M2 acceptance.

## Remaining before M2 completion

- Add supported beacon-mode M2 operations and prove synchronous session versus
  asynchronous beacon behavior.
- Surface or explicitly defer the remaining closed filesystem metadata,
  mount/memory-file, copy/move, and registry mutation controls.
- Implement safe text and hex editors, or record their final milestone boundary.
- Add process-tree presentation and the remaining loot dispositions.
- Extend the delivered session timeout, target-loss, destination-alias,
  temporary-cleanup, and late-response fault coverage across the remaining
  platforms and eventual beacon-mode paths.
- Add authorized real-server session evidence for the remaining supported target
  operating systems and finish the outstanding transfer fault matrix.
