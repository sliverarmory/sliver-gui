# BC-08 beacon Registry and service delivery record

Date: 2026-10-02 (Pacific)
Status: **Implemented; awaiting live Windows target and packaged-app verification**
Source: local working tree from `a08642940cd77240fe25b699a1f8f0eaf8758628` (commit/PR pending)

BC-08 adds ten Windows-only choices to the interactive **Beacon command** picker: Registry value read, subkey and value-name lists, reviewed write/create/delete, service list/detail, and reviewed start/stop. The Registry parent remains navigation only. `registry.read.hive` still belongs to BC-06 because its compressed binary output needs the native artifact workflow.

The renderer sends closed, typed inputs. Electron main checks the selected beacon and backend, queues each command through a named adapter, and records the exact task ID and request. **Task output** decodes only a matching, completed task with the expected description, saved request, response shape, and size. A response preview is limited to 64 KiB encoded, 256 rows, and bounded text fields; a Registry write value is limited to 16 KiB. String, binary, DWORD, and QWORD writes have explicit encodings. The input parser rejects malformed Unicode text and canonicalizes QWORD decimal input before review so the saved protobuf request can be verified against the value the operator approved.

Each mutation requires a one-use, two-minute review tied to the selected beacon and backend. Registry delete is labeled as an *entry* because the pinned handler deletes a same-named value before trying a subkey. An uncertain mutation dispatch is not replayed. Registry mutation task results contain a handler response; successful service start/stop tasks contain zero response bytes in the pinned Windows handler. Both are reported as handler outcomes requiring a later requery. Task completion alone leaves the mutation journal in `partial`, without claiming the remote state changed.

## Automated evidence

- `npm run typecheck` passed for main/preload, renderer, and E2E TypeScript.
- `npm test -- --maxWorkers=4` passed: 4,382 tests passed, three skipped (4,385 total); focused BC-08 parser, adapter, request-verifier, decoder, operation, IPC, and renderer tests are included.
- `npm run protocol:check` passed against the pinned Sliver input and installed `sliver-script@2.0.0-rc.5`; `npm run parity:check` passed all 269 reviewed static nodes.
- `npm run build:e2e-app` passed. The focused `BC-08 beacon Registry` Electron journey in `src/e2e/beacons-table.e2e.ts` passed one of one. It exercises non-Windows denial, Registry reads, service list/detail, binary write review without pre-confirm dispatch, a zero-byte service stop result, and task-bound output using the fake Electron main.
- `git diff --check` passed.

The Electron journey uses a deterministic fixture. It does not establish that a live Windows beacon supports every Registry value type or remote-host option, independently prove a durable Registry or service change, or verify a packaged application. Those checks remain under [BC-10](beacon-command-roadmap.md) before BC-08 can move to **Verified**. The pinned Registry read result reports only a string value, with no Registry type; the UI labels the type as unreported. Binary write input uses bounded hexadecimal text; the console's local `registry.write --path` file input is not in this slice. List pagination covers the bounded decoded preview only because these RPCs have no server continuation token.
