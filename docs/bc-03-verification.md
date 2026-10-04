# BC-03 beacon Execution command delivery record

Date: 2026-10-01
Status: **Implemented; awaiting live-target and packaged-app verification**

BC-03 adds six M4 choices to the existing searchable **Beacon command** picker. **Background children** and **Windows privileges** queue read-only tasks. **Run as**, **Make token**, **Impersonate**, and **Revert identity** use the existing typed execution preparation, one-use review, and credential boundary. The latter five choices are Windows-only; background children is available on the supported beacon platforms. The four session-gated M4 candidates remain in BC-03A.

The two read results retain their exact beacon task ID and locally recorded operation provenance. **Task queue** opens their decoded **Task output** entry, with 50-item pages loaded from that same task. The main-owned decoder checks task identity, the recorded operation, description, completion state, response envelope, and encoded size before returning typed fields. Action results keep their existing bounded execution output treatment. A queued acknowledgement does not claim the remote effect succeeded; shellcode and Metasploit `TaskReq` results retain the existing `outcome-unknown` handling.

## Automated evidence

- `npm run typecheck` passed.
- `npm test` passed: 4,274 tests passed, three skipped (4,277 total).
- `npm run protocol:check` and `npm run parity:check` passed against the pinned inventory.
- `npm run build:e2e-app` passed.
- The focused `BC-03` journey in `src/e2e/beacons-table.e2e.ts` passed (one of one). It uses the fake Electron main and a Windows beacon fixture, checks six picker choices, two exact-task read histories, task-bound **Load more** for both inventories, and a reviewed credential-bearing `Run as` task. It verifies no task is dispatched before review and that the test password is absent from the visible UI.
- The full `beacons-table.e2e.ts` fixture suite passed three of three journeys in 31.6 seconds after the final BC-03 gate assertion, including the existing beacon workspace and BC-02 management flows.

These checks use deterministic fixtures. They do not establish live target support on every OS or transport, prove a durable Windows identity change after check-in, or verify a packaged application. Those checks are required before moving BC-03 to **Verified** under [BC-10](beacon-command-roadmap.md).
