# BC-04 boundary and BC-05 beacon read delivery

Date: 2026-10-01  
Protocol baseline: `f8430cecf7ceb5cb332c84fb36aba9b75188802d`  
Status: **BC-04 and BC-05 implemented in the local source.** Live-target and packaged-app verification remain open.

## Delivered behavior

- The existing **Beacon command** picker now offers `env`, `getpid`, `getuid`, `getgid`, `whoami`, `netstat`, `mount`, `memfiles`, `cat`, `head`, `tail`, and `grep`. PID, UID, GID, and non-Windows username show the latest server inventory value and its check-in time without fabricating a task. Windows `whoami` queues a token-owner task; `memfiles` is Linux-only.
- Nine new asynchronous reads use closed, typed inputs and named main-process client adapters. The operation engine checks the exact selected target and the reviewed command capability before dispatch. The four earlier M2 reads also receive exact command checks while retaining their established transport eligibility. A queued acknowledgement retains its task ID; completion is decoded only after the saved task matches the claimed beacon, description, locally submitted operation and request options.
- The saved request is a Sliver `Envelope`. The server clears nested `Request.BeaconID` and `Request.SessionID` before storage; task identity is bound by the outer `BeaconTask.BeaconID`, claimed task ID, request type, and local operation record. The existing `pwd`, `ls`, `ps`, and `ifconfig` reads now receive the same saved-request provenance check.
- The task store returns bounded text, tables, or identity details to **Task output**. It checks response errors, limits encoded file results and decoded gzip bytes, uses strict UTF-8 for whole-file text, and zeroizes fetched raw buffers. A head/tail slice ending inside a UTF-8 character receives a bounded exact-byte hex preview. Environment values with recognized sensitive names are masked in retained task history. Table results have local 50-row filtering and paging tied to that task.
- The four earlier reads retain their command picker route. `ls` output has name, modified-time, and size sort with reverse order; `ps` output has PID, executable, and owner filters, a process tree, and a command-line column toggle; `ifconfig` output has the pinned client's default address filter and a show-all switch. These controls operate on at most 256 decoded rows from the selected task.

## Automated evidence

- `npm run build:e2e-app` passed, including `npm run typecheck` and the production Electron build.
- `npm test -- --maxWorkers=4` passed: **4,326 passed, 3 skipped** across 239 files. The first unconstrained run exposed three outdated registry assertions, which were updated, plus a BOF UI test that passed in isolation and on the bounded full run.
- `node --test .e2e-dist/src/e2e/beacons-table.e2e.js` passed **4/4** fixture journeys. The BC-05 journey submits all nine new task reads, checks exact task IDs and decoded output, tests inventory-only identity display, and switches to Windows and Linux fixtures for platform-specific reads. The journeys also exercise directory sort, process filter/tree, and interface show-all output controls.
- `npm run protocol:check` passed: installed client provenance, 269 command nodes, and 269 reviewed parity annotations.
- `git diff --check` passed.

## Remaining limits

- Local result paging, sorting, and filtering cover only the first 256 decoded rows. The pinned list RPCs provide no remote continuation, so the GUI cannot navigate entries beyond that bounded preview. The fixture's canned head/tail text verifies task routing and output rendering, not the implant's slice algorithm.
- `tail` exposes bounded byte mode only. The pinned line-mode implementation reads an entire file before slicing, and byte-mode tail can fail on a file shorter than the requested count. Text preview is limited to the reviewed file/result bounds.
- The pinned implant reads a full line into memory before applying the requested byte cap for `cat` and `head`. The GUI bounds the returned response and decoded preview, but cannot cap that target-side temporary allocation. Empty responses for locally submitted `ps`, `ifconfig`, and `netstat` reads are classified as uncertain because the pinned handlers can emit the same bytes on collection errors and valid zero-row results. The pinned `ps` handler can also return partial rows without a detectable error, so the displayed inventory is not proof of completeness.
- These are deterministic fixtures, not live beacon proof. BC-10 still requires disposable targets on applicable operating systems, denial and fault cases, and packaged-app verification before either package can be marked **Verified**.
