# M4 execution and privilege verification

Date: 2026-08-15
Status: **Delivered; awaiting operator acceptance**

The operator accepted the bounded session-shell M3 scope and explicitly
authorized M4 on 2026-08-15. This record covers the delivered execution,
post-exploitation, and privilege workbench. Automated delivery does not itself
accept the milestone or unlock M5.

## Delivered scope

The closed M4 catalog contains 19 operation IDs: 17 reviewed actions and two
bounded reads. It is rendered in the session **Execution** tab and in the
beacon **Execution** sheet without exposing a renderer-selectable RPC method.

| Family | Session | Beacon | Target platforms |
| --- | --- | --- | --- |
| Process execution and background children | reviewed execution and bounded output/read | exact decoded output/read | Windows, Linux, Darwin |
| Assembly | reviewed native artifact | exact decoded output | Windows |
| Raw shellcode | reviewed native artifact | task submitted; completion unverifiable | Windows, Linux, Darwin |
| Sideload and reflective DLL | reviewed native artifact | exact decoded output | Sideload: Windows/Linux/Darwin; reflective DLL: Windows |
| Migrate | reviewed action | exact decoded success/PID | Windows |
| Metasploit generate/execute and inject | reviewed action | task submitted; completion unverifiable | Windows, Linux, Darwin |
| Psexec | reviewed composite | unavailable | Windows session |
| SSH | reviewed credential-bearing action | unavailable | Windows, Linux, Darwin session |
| Executable backdoor and DLL hijack | reviewed destructive action | unavailable | Windows session |
| Privilege inventory | bounded read | exact decoded, task-bound paged read | Windows |
| Run-as, make-token, impersonate, and revert | reviewed identity action | exact decoded identity action | Windows |
| Get-system | reviewed action | unavailable | Windows session |

The 19 corresponding pinned Sliver command nodes are classified
`in-progress`, not `complete`, in the parity annotations. Stable evidence IDs
link each row to the test families below while preserving the remaining
mode, option, and real-target gaps.

## Architecture boundary

- Renderer input is parsed into a closed discriminated union. Unknown operation
  IDs, fields, modes, platforms, architectures, artifact roles, and result
  handles fail closed before dispatch.
- Electron main authors the capability catalog from the exact selected
  `TargetRef`, backend epoch, connection incarnation, authoritative target
  summary, and operation descriptor. Renderer navigation cannot widen it.
- Every action uses a main-issued, one-use review plan with a 60-second TTL.
  Plans are bound to the exact window, backend, connection, target fingerprint,
  operation, reviewed fields, and artifact roles. Target or connection drift
  revokes the plan before dispatch.
- Native input bytes stay in a main-only artifact store. Handles bind the exact
  owner, backend, epoch, incarnation, target, operation, and role. Input handles
  are one-use and expire after 60 seconds; retained result handles expire after
  five minutes.
- Artifact limits are 64 MiB per item, 128 MiB per window, and 256 MiB for the
  process. The registry separately limits each window to four prepared plans,
  128 retained results, four active requests, and the process to 16 active
  requests.
- Each session stdout or stderr stream is bounded to 1 MiB before it can become
  a main-owned result; the separately retained concatenated result is therefore
  at most 2 MiB. Only content-free metadata crosses the renderer boundary;
  native save reads an exact retained handle in main and uses an atomic save
  intent.
- Session RPCs return a completed, failed, partial, or outcome-unknown
  disposition. A lost response after possible dispatch is never replayed.
- Beacon actions enter the existing main-owned operation journal as external
  operations and claim the exact returned task ID. A completed task summary is
  not accepted as execution success. A matching task invalidation fetches the
  exact same task, verifies beacon, local request, operation, and server
  description, then uses
  only that operation's protobuf codec with a bounded envelope. Fetched request
  and response bytes are cleared. This path is separate from the M1 typed task
  decoder.
- Decoded beacon stdout and stderr use the same 1 MiB-per-stream retention and
  native-save boundary as session results. Beacon children and privilege pages
  carry a versioned cursor bound to the exact task and never redispatch the
  operation.
- Malformed, oversized, mismatched, or semantically unverifiable beacon content
  becomes a fixed outcome-unknown disposition. A target `Response.Err` or a
  negative migration success flag becomes a fixed failed result without remote
  text.
- Pending M4 tasks expose reviewed, single-flight, best-effort cancellation;
  authoritative task state wins races, and cancellation never resubmits the
  original action.
- The vendored Sliver client exposes named M4 methods only. It constructs
  canonical protobuf requests with bounded timeouts and clears owned binary or
  mutable credential-buffer copies after the call settles.

## Credential and destructive-action boundary

- Password fields stay uncontrolled in the renderer. Preparation transfers a
  one-operation `Uint8Array`; every mutable byte copy is cleared at its ownership
  boundary. The protobuf API ultimately requires a JavaScript string, which is
  scoped to the one call and never persisted, logged, summarized, or returned;
  immutable JavaScript strings cannot be explicitly zeroized.
- SSH private keys and Kerberos keytabs are chosen with a native dialog. Review
  shows a safe basename, byte count, and SHA-256 digest, never the native path or
  file contents.
- Review payloads contain no password, private-key bytes, keytab bytes, raw
  shellcode, assembly, DLL, or executable content.
- The review dialog names the exact backend, target name, target mode/ID, risk,
  safe fields, requested identity, native-artifact metadata, and operation-owned
  warning. Destructive, credential-bearing, and high-OPSEC actions cannot bypass
  it.
- Current token identity is requested through the named target RPC before a
  synchronous session identity change. A missing or rejected preflight fails
  review preparation rather than substituting editable operator metadata.
  Beacon reviews label current identity as not reported because its asynchronous
  RPC cannot prove the value before the one-use review is issued.
- Backend `Response.Err`, exception text, native paths, command content, and
  credential content do not enter result messages, toasts, snapshots, Activity,
  the external operation journal, or fake-client audit state.
- Psexec is a main-owned composite: produce or select the executable, upload to
  the reviewed administrative-share path, start the reviewed service, then
  attempt bounded cleanup. Cleanup failure yields `partial`; it is never
  mislabeled as full success.

## Stable automated evidence IDs

These IDs are deliberately stable parity evidence references. Test titles may
be clarified without changing the annotation contract.

| Evidence ID | Coverage |
| --- | --- |
| `m4-contract-registry-dispatch` | `src/shared/execution-contracts.test.ts`, `src/main/execution-operation-registry.test.ts`, and the exhaustive 17-action dispatcher case in `src/main/execution-workbench.test.ts` |
| `m4-canonical-wrapper-requests` | `src/main/sliver-client-m4-wrappers.test.ts`: canonical execute, binary, migration, Metasploit, identity, SSH, remote-service, bound, and rejection fixtures |
| `m4-exact-target-reviewed-execution` | `src/main/connection-registry.test.ts`: exact session plan, one-use execution, bounded output/save, target rejection, and outcome uncertainty |
| `m4-native-artifact-zeroization` | `src/main/execution-artifact-store.test.ts`, dispatcher buffer ownership cases, renderer native-metadata case, and Electron native-key journey |
| `m4-secret-artifact-zeroization` | Credential contract, dispatch, registry, renderer, fake-main audit, and Electron DOM/screenshot/path exclusion cases |
| `m4-psexec-composite-cleanup` | Psexec composite dispatch ownership, canonical remote-service wrappers, target-error classification, and partial cleanup disposition |
| `m4-bounded-read-dispatch` | Children and privilege paging, platform validation, session dispatch, and beacon task-submission cases |
| `m4-external-beacon-task-reconciliation` | External task claim, cross-window/cross-beacon denial, reviewed single-flight cancellation, summary reconciliation, expiry, no replay, and no-M1-decoder cases |
| `m4-exact-beacon-result-decoding` | `src/main/execution-beacon-task.test.ts` and registry integration cases: exact task/description/operation binding, pinned protobuf codecs and invariants, envelopeless success, task-bound paging, bounded output/save, negative migration, fixed target errors, safe refusal of unverifiable `TaskReq`, and request/response zeroization |
| `m4-renderer-action-surfaces` | Every catalog action opens a typed configuration surface; capability reasons, review, execution, live result updates, save, focus, and stale-plan disposal are covered |
| `m4-renderer-read-surfaces` | Bounded child/privilege views, continuation, queued beacon state, completion, empty, and error presentation |
| `m4-electron-current-slice` | Production renderer/preload/IPC journey for session children, native-key SSH review/execute/save, stale-target revocation, and beacon submission |

## Integrated validation record

The final implementation and vendored overlay produced this validation record:

- `npm run typecheck`: **passed**
- `npm test` outside the restricted sandbox: **80 files and 927 tests passed;
  one file and two tests skipped; 6.28 seconds**. A restricted-sandbox run hit
  the expected `EPERM` denial in three loopback-socket cases; those same cases
  passed in the unsandboxed run.
- `npm run test:e2e:electron`: **passed 1 of 1**; test body 22.407 seconds,
  total 22.549 seconds; production app build plus Node, web, and E2E TypeScript
  checks passed
- Focused integrated M4 validation: **15 files and 427 tests passed**
- `npm run build`: **passed as part of the package lane**
- `npm run build:client`: **passed**
- `npm run protocol:check -- --sliver-source ./sliver --wrapper-source
  /tmp/sliver-gui-m4-wrapper-base --allow-node-drift`: **passed on the Node 26
  developer host**; the locked Node 24 CI lane remains authoritative
- `npm run protocol:ghostty`: **passed; the pinned `ghostty-web` 0.4.0 runtime
  hash was verified**
- `npm run parity:check -- --source ./sliver --regenerate`: **passed; 261
  generated nodes and 261 reviewed annotations**
- `npm run package`: **passed** the build, release-content scan,
  `electron-builder --dir`, and packaged-content scan; one `app.asar` was
  present and E2E/secret fixtures were absent
- `npm run test:e2e:packaged`: **passed 1 of 1** against the exact packaged
  `app.asar` over deterministic production mTLS; test body 2.289 seconds, total
  2.472 seconds
- Signed installed-app/real-target lane: **deferred**; this host reported zero
  signing identities, so the unpacked app is intentionally unsigned

The deterministic M4 session evidence image is
`artifacts/e2e/m4-session-execution.png`: **407,915 bytes**, SHA-256
`17090a3a7f676ab1fb80e5b47b2e5af1bd3d40ba9a6167952da0227bb711e1c3`.

The unpacked arm64 package evidence is:

- `release/mac-arm64/Sliver GUI.app/Contents/Resources/app.asar`:
  **15,216,360 bytes**, SHA-256
  `c5ad8174af6e60d0ac7f42757a7cf0df234eda0ba879bad6b5f9dc280387edaa`
- `release/mac-arm64/Sliver GUI.app/Contents/MacOS/Sliver GUI`:
  **33,968 bytes**, SHA-256
  `34465676648bf5e5892e8f7791929be7ee01973a5317260f4f741ab7110cfef6`

The parity generator currently reproduces **261 reachable static command
nodes**, passes the representative alias/extension contamination audit, and
keeps all **261 reviewed annotations** aligned to the pinned local Sliver
commit and tree. The final protocol run reproduced **five generated protobuf
files**, replayed **eight handwritten overlay files**, and verified **six
retained snapshot files** plus the prerequisite-bound Git bundle.

## Operator acceptance checklist

1. Connect to an authorized disposable backend and select one active session.
   Open **Execution** and confirm unavailable cards explain target mode/platform
   restrictions without offering a bypass.
2. Run **Background children** and confirm bounded rows, queued-to-complete live
   updates, empty, and error states remain within the Execution surface.
3. Review a process execution. Confirm the backend, target name, exact mode/ID,
   executable, argument count, environment count, output policy, timeout, and
   risk warning are correct before executing.
4. Execute a bounded-output session action. Save stdout or stderr through the
   native dialog and confirm a repeated result read never reveals a native path.
5. Choose a native assembly, shellcode, shared library, DLL, executable, private
   key, or keytab as appropriate. Confirm Review shows only basename, size, and
   digest; cancel once and confirm no plan or bytes remain usable.
6. Exercise a credential-bearing action. Confirm the credential field clears
   immediately after preparation and the value never appears in Review, toasts,
   Activity, screenshots, or a later form.
7. On Windows, review an identity-changing action. Confirm the current token
   identity and requested identity are both visible. Refuse the review and
   confirm focus returns to the originating card.
8. Prepare an action, then change the exact target or backend before execution.
   Confirm Review closes and the stale plan cannot dispatch after switching
   back.
9. Submit an allowed beacon action. Confirm the GUI reports **Submitted** with
   bounded metadata instead of waiting synchronously. Complete a process action
   and confirm its task event makes only exact decoded output available for save.
   Cancel another exact pending disposable task, confirm the review names the
   task and target, then reconnect and confirm ownership remains isolated
   without a second action dispatch.
10. Exercise psexec only on an authorized disposable Windows host. Confirm a
    cleanup failure reports **Partial**, never full success.
11. Confirm Psexec, SSH, backdoor, DLL hijack, and get-system are unavailable on
    beacon targets, and Windows-only operations are unavailable on Linux and
    Darwin targets.
12. Explicitly accept or reject M4. Do not begin M5 on automated evidence alone.

## Explicit limitations and deferred parity

- Psexec, SSH, executable backdoor, DLL hijack, and get-system are session-only
  in this delivery even where the upstream command tree exposes a broader mode.
- Supported beacon results use exact operation-specific protobuf decoders and
  bounded output save; arbitrary task descriptions or payloads are never
  decoded through this path.
- The pinned implant returns indistinguishable empty `TaskReq` bytes for beacon
  shellcode, Metasploit, and Metasploit-inject success and failure. These three
  operations dispatch and correlate normally but remain outcome-unknown after
  task completion unless the protocol gains a verifiable result.
- Pending beacon tasks support reviewed best-effort cancellation, but a task
  completion race remains authoritative and does not prove remote rollback.
- Submitted synchronous session RPCs do not have a protocol-safe cancellation
  path. Pre-dispatch reviews can be discarded, and transport uncertainty is
  recorded without replay.
- Raw shellcode covers declared architecture, PID/current process, RWX, and
  timeout. Interactive streaming and upstream shikata/transform/bypass/process
  option parity remain open.
- Upstream loot, name, skip-loot, and command-specific save dispositions are not
  all mapped. Decoded result save is local and main-owned; it does not claim
  remote loot parity.
- A combined local result is the bounded stdout bytes followed by the bounded
  stderr bytes; it does not reconstruct the target's temporal interleaving.
- Get-system dispatch is implemented, but authoritative correlation to the
  newly created session remains certification work.
- Psexec cleanup is best effort and can leave a remote executable or service;
  the partial disposition and warning are the only safe claim.
- Unit, component, fake-client, and deterministic Electron evidence do not
  replace the authorized Windows/Linux/Darwin target and native-package matrix.
- M5 forwarding, SOCKS, WireGuard networking, and pivots remain unstarted.
