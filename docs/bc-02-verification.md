# BC-02 beacon command picker delivery record

Date: 2026-10-01
Status: **Implemented; awaiting live-target and packaged-app verification**

BC-02 covers six existing typed M1 operations in the interactive beacon view:
`ping`, `rename`, environment set/unset, beacon reconfigure, and open session.
They belong in the existing searchable beacon command picker alongside Execution
and the four M2 reads. Each choice shows its relevant inputs in the same command
form and uses the current target-operation dispatcher with its exact-target
capabilities and confirmation policies. The package adds no renderer-selectable
RPC. The existing kill and task lifecycle controls retain their current surfaces.

## Completion checks

- [x] All six controls are discoverable in the existing beacon command picker
  and usable in the beacon interaction view, including its dedicated window.
- [x] The UI reports the submitted operation's actual state: synchronous rename
  can complete immediately; beacon tasks carry an exact task ID when the server
  acknowledges queue insertion. A lost or uncertain acknowledgement is not
  presented as success.
- [x] Current-target capability reasons remain visible. Open-session requires an
  authoritative supported C2 endpoint; target or backend rebinding cannot make
  an old submission appear under a new target.
- [x] Focused renderer tests and fixture-backed Electron coverage exercise all
  six controls, their relevant inputs, denied states, and state presentation.
- [x] Typechecking, relevant unit tests, focused fixture-backed Electron E2E,
  protocol, and parity checks pass. Record exact command results and source
  revision below.

## Existing operation semantics

| Control | Current dispatcher outcome | Result limit |
| --- | --- | --- |
| Ping | Beacon task with exact task ID | A queued task is not a completed ping. |
| Rename | Synchronous response and target refresh | Completion follows the existing reconciliation result. |
| Environment set/unset | Beacon task with exact task ID | Submission does not prove the new environment value. |
| Reconfigure | Beacon task with exact task ID and target refresh | The task result does not independently prove later beacon timing. |
| Open session | Beacon task with exact task ID | Task delivery does not prove that a new session connected. |

These outcomes follow the existing operation registry and task decoder; BC-02
does not alter their request, response, confirmation, or retry policies.

## Evidence and remaining verification

As of 2026-10-01, `npm run typecheck` passes for the Node and web TypeScript
projects. `npm run protocol:check` passes with 269 discovered command nodes and
269 reviewed annotations plus installed-client provenance; `npm run parity:check`
passes with 269 of 269 rows. The corrected picker passes 112 of 112 focused
`TargetsPage.test.tsx` tests, and `npm run build:e2e-app` passes. The final-build
focused command
`node --test --test-concurrency=1 .e2e-dist/src/e2e/overview.e2e.js .e2e-dist/src/e2e/beacons-table.e2e.js`
passes all six journeys in 64.7 seconds (2026-10-01 19:30:19–19:31:54 PDT).
The BC-02 journey exercises all six choices through the corrected command
picker, exact task IDs and task descriptions, synchronous rename, typed timing
changes, the main-owned open-session C2 endpoint, denied open-session
capability, and target-switch result isolation. It also checks the queued task
in **Task output**. The final `npm test` run started at 2026-10-01 19:32:16
PDT and passed in 29.68 seconds: 236 test files passed and two skipped; 4,261
tests passed and three skipped (4,264 total). `git diff --check` passes.
The test fixture's beacon reports Darwin/arm64 over HTTPS; it is a
deterministic fixture, not a live implant.

The pre-fix full `npm run test:e2e:electron` run ended 33 passed and four
failed of 37 in 278.3 seconds. Its Overview **Task queue** heading expectation
was corrected and the Overview journey passed in the final-build focused run.
Three native shortcut/focus failures remain outside the BC-02 path and repeated
in isolated runs: `electron-current-slice.e2e.ts` and
`window-navigation.e2e.ts` timed out waiting for **Cancel changing shortcut for
Open command palette**; `keyboard-shortcuts.e2e.ts` reported **Owned shortcut
window did not receive native focus**. The broader suite has not passed in
full for this local worktree.

The local worktree starts from `b62b4c4`; the BC-02 change has no commit or PR
yet. **Verified** additionally requires authorized disposable-target and
packaged-app evidence for the delivered slice under
[BC-10](beacon-command-roadmap.md). No live-target or packaged-app result is
claimed in this record yet.
