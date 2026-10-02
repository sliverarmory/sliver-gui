# Beacon command coverage roadmap

- Date: 2026-09-28
- Scope: the interactive beacon view and the asynchronous task/output path behind it.
- Protocol baseline: `f8430cecf7ceb5cb332c84fb36aba9b75188802d`.

This is a hand-maintained delivery tracker for the [beacon-visible command inventory](operator-parity.md). The parity report is generated from pinned upstream discovery and reviewed annotations; its `in-progress` labels and test IDs do not prove that a command works in the beacon UI. The [M2 session verification](m2-session-verification.md) explicitly deferred beacon execution, and the [M4 verification](m4-verification.md) records its own delivery and acceptance limits. This roadmap does not change either milestone's acceptance status.

## Starting point

- At the BC-01 baseline, the interactive autocomplete offered **Execution** and four M2 reads: `pwd`, `ls`, `ps`, and `ifconfig`. The queue and task-output tabs already displayed completed results. These were shipped UI paths, not a claim of full option or live-target parity.
- At that baseline, the typed target-operation dispatcher had six additional M1 controls (`ping`, `rename`, environment set/unset, beacon reconfigure, and open session) without entries in the interactive command picker. BC-02 places these actions in that same picker. Beacon kill and task lifecycle controls have separate existing surfaces.
- The execution registry allows 14 of its 19 operations on beacons. The current beacon Execution composer exposes the existing action modes and BOF support; `execution.children`, `privilege.get`, `privilege.run-as`, `privilege.make-token`, `privilege.impersonate`, and `privilege.revert` still need interactive controls and corresponding task-output presentation. Five registry operations are currently session-only in this GUI delivery; four of those appear beacon-visible in the pinned command tree and need a separate feasibility decision.
- The pinned parity report has **45 beacon-visible M2 command-tree rows**. Four have interactive entries, leaving **41 rows without a direct entry**. Parent/group nodes and commands sharing an underlying RPC must be deduplicated before treating that number as an implementation count. The command tree also does not prove that a beacon runtime supports every listed operation or platform.

The full pinned *visibility* ledger has 92 beacon-labeled tree rows: M1 13, M2 45, M4 18, M5 9, and M8 7. That is neither a count of remaining tasks nor a runtime support guarantee. This document is the separate *delivery* ledger for the interactive view. BOF commands are dynamic and are not part of the static row count.

## How progress is recorded

Each package below has an ID for an issue or PR. `Planned` means no delivery claim. `Existing` means a usable path is present but its stated remaining work is open. Use `In progress` while one or more completion checks remain. Move a package to `Implemented` only after its exact listed behavior and automated checks land; move it to `Verified` only after the relevant disposable-target and packaged-app evidence is linked. Record the commit/PR, test run, target OS, and date in the Evidence column when changing status. Track input UI, typed main dispatch, task-ID correlation, decoded output, automated tests, and live/platform proof separately in that evidence; a green check in one dimension does not close the others. `Blocked` requires a documented protocol/runtime or external prerequisite. Do not turn a parity row to `complete` merely because `npm run parity:check` passes: that check validates the inventory's structure.

| ID | Deliverable | Status | Depends on | Evidence |
| --- | --- | --- | --- | --- |
| BC-00 | Existing queue/output, four M2 reads, Execution actions and BOF | Existing | — | [Beacon interaction](../src/renderer/src/pages/BeaconInteractionWorkspace.tsx), [M4 verification](m4-verification.md) |
| BC-01 | Exact protocol and capability matrix for remaining beacon commands | Implemented | Pinned baseline | [Assessment](beacon-command-matrix.md), [main-owned matrix](../src/main/beacon-command-matrix.ts), [tests](../src/main/beacon-command-matrix.test.ts). 2026-09-28: typecheck, 22 focused tests, protocol and parity checks passed. Existing dispatch unchanged; awaiting user review. |
| BC-02 | Six existing M1 controls in the beacon command picker | Implemented | BC-01 | [Delivery record](bc-02-verification.md). 2026-10-01 local worktree from `b62b4c4` (commit/PR pending): typecheck; 4,261 passed / 3 skipped Vitest; 112/112 focused picker UI; 6/6 focused picker and Overview Electron in 64.7 seconds; protocol and parity checks passed. The earlier full Electron suite has three repeatable native focus failures. Darwin/arm64 HTTPS fixture; live-target and packaged-app proof remain open. |
| BC-03 | Six backend-supported M4 operations exposed with typed outputs | Planned | BC-01 | — |
| BC-03A | Feasibility decision for four beacon-visible M4 operations currently session-only in the GUI | Planned | BC-01 | — |
| BC-04 | Shared bounded M2 beacon task/response boundary | Planned | BC-01 | — |
| BC-05 | M2 read and inspection commands, plus option/paging follow-up for the existing four | Planned | BC-04 | — |
| BC-06 | M2 transfers, native artifacts, and editor workflows | Planned | BC-04, BC-05 | — |
| BC-07 | M2 filesystem, memfile, and process mutations | Planned | BC-04, BC-05 | — |
| BC-08 | Windows Registry and service reads, then reviewed mutations | Planned | BC-04 | — |
| BC-09 | Decide beacon eligibility of M5 networking and M8 extension rows | Planned | BC-01, pinned runtime evidence | — |
| BC-10 | Cross-platform, fault, and packaged-app certification for delivered slices | Planned | Applicable packages above | — |

## Work packages and completion checks

**BC-01 — Define the actual command surface.** For each remaining parity row, record whether it is an invokable command or a navigation/group node; map its pinned request/response, meaningful options, OS/architecture and transport restrictions, task description, maximum response size, and whether completion can be proved. Check runtime gates explicitly: the session workbench, for example, treats memfiles/chmod/chown as Linux-only, Registry/services as Windows-only, and screenshot/process dump as Linux/Windows. Reuse authoritative target metadata for identity facts where appropriate rather than queueing redundant tasks. The output is a reviewed, closed operation matrix that drives capability decisions in Electron main. A command with uncertain runtime support stays gated until tested.

**BC-02 — Expose existing management controls.** Add `ping`, `rename`, environment set/unset, beacon reconfigure, and open-session as discoverable choices in the existing beacon command picker alongside Execution and the four M2 reads. Dispatch them through the existing typed target-operation path. Keep exact-target capability checks and the existing per-operation confirmation policies; track any proposed review-policy change separately. Completion means each choice has its input form in the beacon interaction view, reports the operation's actual synchronous or queued state, and has focused UI and Electron coverage. Existing kill and task controls remain on their current surfaces unless a specific UX change is chosen.

**BC-03 — Complete the supported beacon Execution surface.** Add children and Windows privilege inventory as bounded reads; add the four Windows identity actions with the existing one-use review and credential boundary. Extend task history with a task-bound read-result variant and provenance, so a completed children/privilege task can be decoded, paged, and rendered in **Task output** after a jump from **Task queue**. The existing task-store path only accepts execution actions, so a renderer-only change will not close this gap. Preserve the current `outcome-unknown` treatment for shellcode and Metasploit TaskReq responses whose success cannot be proved.

**BC-03A — Decide the currently session-only M4 operations.** The pinned tree marks `psexec`, `ssh`, `backdoor`, and `dll-hijack` beacon-visible, while their current GUI capability descriptors require a session. Examine each pinned RPC or workflow and beacon runtime path, including cleanup and credential/artifact ownership, before changing a capability or promising output. Record a supported implementation package or an evidence-backed deferral for each. `get-system` is session-only in both the pinned tree and current GUI scope.

**BC-04 — Establish the M2 asynchronous boundary.** Extend the closed operation contracts and named client adapters rather than exposing RPC method names or protobuf bytes to the renderer. Main must author the operation's capability from the exact selected target, connection incarnation, and backend epoch; claim the returned task ID; check the beacon, request, description, and operation on fetch; decode only the matching bounded response; and keep cancellation, duplicate acknowledgements, reconnects, lost replies, and malformed results honest. Unknown outcomes must not be reported as success. This package is complete when contract/engine/store tests cover those failure paths and the output pane needs no raw protobuf.

The 45 M2 rows are partitioned below so every row has an owner. The four existing entries stay in BC-00 and receive their remaining option, filtering, and paging work in BC-05. Platform labels in the generated parity tree are candidates; BC-01 must confirm the runtime gate before a control is enabled.

| Package | M2 command-tree rows | What closes the package |
| --- | --- | --- |
| BC-00 / BC-05 | `pwd`, `ls`, `ps`, `ifconfig` | Preserve the current result views; finish supported options, bounded paging/filtering, and task-bound page navigation. |
| BC-05 | `env`, `getgid`, `getpid`, `getuid`, `whoami`, `netstat`, `mount`, `memfiles`, `cat`, `head`, `tail`, `grep` | Typed read-only inputs and bounded tables/text; identify facts sourced from current target metadata versus a new task; explicit freshness and platform behavior. |
| BC-06 | `download`, `upload`, `screenshot`, `procdump`, `edit`, `hex-edit`, `registry.read.hive` | Main-owned pickers, bytes, and scoped result handles; bounded binary retrieval and native save; editor read/write review and failure handling. |
| BC-07 | `cd`, `chmod`, `chown`, `chtimes`, `cp`, `memfiles.add`, `memfiles.rm`, `mkdir`, `mv`, `rm`, `terminate` | Per-command capability and risk classification; one-use review for destructive/replacement actions; no replay after uncertain dispatch. |
| BC-08 | `registry`, `registry.create`, `registry.delete`, `registry.list-subkeys`, `registry.list-values`, `registry.read`, `registry.write`, `services`, `services.info`, `services.start`, `services.stop` | Windows-only read views first, then reviewed writes/start/stop with typed value encodings and exact task results. |

**BC-06 — Treat binary results separately from text previews.** The existing task preview is not an artifact-transfer channel. Native input and output bytes stay in Electron main under bounded, expiring, exact-owner handles; save uses a native path and atomic write. Cover size limits, malformed payloads, target/window rebinding, cancellation, and reconnection. Track optional loot disposition independently of basic command delivery.

**BC-07 and BC-08 — Stage mutations after their read context.** File and process changes, Registry edits, and service actions need platform-specific capability checks and a review surface appropriate to their risk. Do not equate a queued task or a completed task envelope with a verified remote change. Make any unsupported beacon action unavailable with an explicit reason instead of silently invoking the session path.

**BC-09 — Reconcile later inventory without inventing beacon support.** Treat the nine M5 pivot and WireGuard-SOCKS tree rows as a runtime audit, not an automatic queue backlog. Of the seven M8 beacon-labeled rows, `ai`, `aka` (including create/delete), and `docs` are operator-facing workflows rather than implant beacon tasks; `ai` can use server RPCs, so it is not simply client-local. Evaluate the two `wasm` rows as remote candidates. Check the pinned implementation and actual beacon transport before scheduling either family. Record `supported`, `session-only`, `operator-workflow`, or `blocked` with evidence. Existing M5 forwarding work and its acceptance status remain tracked in the [operator parity report](operator-parity.md).

**BC-10 — Certify each delivered slice.** For a package to become `Verified`, run `npm run typecheck`, focused Vitest, fixture-backed Electron journeys, `npm run protocol:check`, and `npm run parity:check`; then exercise applicable commands on authorized disposable targets for each supported target OS and verify packaged-app behavior. Capture success, denial, oversized/malformed response, task/cancel race, and reconnect cases relevant to that slice. Record command/option/platform coverage and remaining limits in a verification document before updating reviewed parity annotations. Structural checks and a successful queue submission alone are insufficient.

## Maintenance rule

Keep this tracker about **interactive beacon command coverage**. Update the row status and evidence in the same change that delivers a slice. If a pinned baseline changes, first regenerate and review the [protocol inventory](../protocol/README.md), then reconcile this command matrix and platform gates. Document unsupported or unverifiable operations explicitly; do not broaden the renderer IPC surface to make a parity count look complete.
