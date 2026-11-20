# Beagle P2 implementation and local verification

This implements the three P2 workstreams in [the gap analysis](beagle-gap-analysis.md), following the P1 changes. Compatibility checks remain local and point in time. No compatibility CI gate is added.

| Order | Workstream | Implementation | Acceptance |
| --- | --- | --- | --- |
| 1 | Data quality and recovery | Collection coverage, warnings, file SHA-256 provenance, bounded import history, explicit merge/replace, session/all-collected cleanup, rename, archive/recover, complete project backup/restore | Real sliver-range import; malformed and cancelled replacement preserve the committed graph; complete backup restores graph, tags, rules, query library, investigation history and provenance |
| 2 | Investigation workflows | Relationship guidance, ACL origins, relay targets, label-rule preview/apply, query descriptions/categories and JSON/CE ZIP interchange, persisted back/forward history, current-result JSON/CSV, table sort/columns, graph find/labels/layouts | Positive and negative native relationship/rule fixtures; renderer interaction tests; production desktop checks |
| 3 | Scale and process lifecycle | Main-process operation status/cancellation, recoverable staged mutations, bounded native file export, compact import diagnostics, optional typed helper operations | Real helper reuse, cancellation/restart, rollback, export exceeding 32 MiB, dense/large-property measurements |

## Persistent helper contract

All graph operations use the verified `helper-stdio` process and typed JSON requests. No operation invokes the CLI, shell, or an external archive utility. The original 14 protocol-1 operations remain required; 10 additive operations are advertised explicitly, for 24 operations in this helper. An older helper can still serve supported queries, while unsupported operations produce an update error.

A selected project retains one helper across successive queries and mutations. Recoverable writes copy the database using SQLite's online backup, release the database connection, open the private staged database in the same helper, validate the result, release its connection, and atomically publish the database. The next request opens the published database in that helper. This closes SQLite handles before replacement, including on Windows. Older helpers without the optional connection-release operation are stopped before replacement. A project switch, cancellation, timeout, or transport failure retires the helper; a later explicit operation verifies the executable again before restart. Failed mutations are never replayed.

Cancellation uses an operation ID, so a stale cancel request cannot abort later work. It is checked between traversal legs and file-copy chunks. Once atomic publication begins, cancellation is disabled. Native cancellation terminates and reaps the process. A cancelled staged mutation cannot replace the previous committed database. At first project open, exact private staging filenames left by a previous crash are removed; committed files, unrelated names, directories and symlinks are preserved.

## Storage and product limits

- Display limits remain 1,500 nodes, 3,000 relationships, and 5,000 rows. Search and neighborhood results remain paged. Current-result exports accept at most 16 MiB of input and produce at most 32 MiB. JSON preserves the displayed result's truncation metadata; CSV exports include only selected columns and the current sort order.
- Native responses remain bounded to 32 MiB and requests to 1 MiB. Complete graph exports use a main-owned file destination and support at most 1 GiB. The native serializer still materializes graph data in helper memory; file streaming does not establish bounded backend memory.
- Project backup is a versioned manifest plus streamed SQLite database bytes, verified by SHA-256. The database limit is 8 GiB and the metadata limit is 24 MiB. Native dialogs own all filesystem paths; private temporary files are published only after the renderer's trusted identity is rechecked. Restore always creates a separate project.
- Workspace storage is limited to 16 MiB, 500 saved queries, and 30 history entries. History contains result snapshots, the query/parameters and path filters used for execution, selected objects/edges, and graph/table presentation. Editing a subsequent query cannot relabel an earlier result. Unsaved editor changes are replaced when navigating to another snapshot. Larger old snapshots are pruned; an oversized active snapshot produces an explicit save error.
- Import history retains the selected 10, 25, 50, or 100 operations; visible summaries are additionally bounded to 4 MiB. The same persisted policy prunes native source reports on import or an explicit retention change. Retained reports remain in complete backups; cleanup of graph data does not erase historical reports. Archived projects retain their data and can be restored; archive is the recoverable removal workflow.
- Query interchange accepts JSON and bounded stored/deflated CE ZIP entries without extracting paths to disk. CRC, entry sizes, entry count, and aggregate decompression limits are validated. CSV string cells that could be interpreted as formulas are neutralized.
- Collection coverage distinguishes successful, failed and unknown probes. A missing relationship is not evidence of complete collection. Derived edges retain Beagle's existing timestamp semantics; they do not synthesize CE operational `lastseen` values.

## Local evidence

The retained range collection is `sliver-range_20261023073610_goad.zip`, SHA-256 `8a13419e1fd550e27beddf57ebfdb2f95ad25c827f67eaadeed35aa24541b80a`. It imports to 814 objects and 8,889 relationships. Private datasets and generated verification artifacts remain ignored.

Local service verification covers merge, replacement, paginated search, manual tags, rule preview/apply, query interchange, result exports, malformed input recovery, selective session cleanup, complete backup/restore, rename/archive/recovery, query cancellation, interrupted replacement rollback, a successful next replacement, complete file export, and clearing collected data while retaining queries/rules.

Native relationship fixtures verify positive ACL inheritance, protected intermediate/target objects, protected origins, mismatched hashes, non-inherited edges, invalid container labels, and relay-target behavior. Rule fixtures verify object/Cypher selectors, expansion direction, exclusions, priority and stable ties, disabled selectors, preview non-mutation, persistent configuration, reanalysis, and rollback on invalid selectors.

### Verification completed 2026-10-23 (macOS arm64)

- Final native executable SHA-256: `0a132314766efdca0031071725fc42a886754e9c179a844192d4e7d3eb512715`. Native source changes are in the sibling Beagle checkout; its source/test changes must accompany the GUI changes.
- `npm run build` passed, including both TypeScript projects and all nine sandboxed preload checks.
- `npm test`: 301 files passed, two skipped; 6,068 tests passed, four existing skips. Focused service, storage, project-panel and history tests also passed after subsequent recovery/history fixes.
- `SLIVER_BEAGLE_E2E_BINARY=... npm run test:beagle:helper`: one real native boundary test passed, zero skips; it retains one project helper across query, import, tag and analysis operations, then verifies project switching and restart.
- Native helper: 12 integration tests and six protocol unit tests passed. Native retention, rule and positive/negative edge fixtures also passed. These are local source/runtime checks; no cross-platform packaging or compatibility CI claim is made.
- Production desktop/native-dialog checks passed: retained ZIP import, query metadata save, circle layout and graph find, sorted CSV export, Back/Forward history, complete backup/restore into a separate project, restart/resume, malformed import, cancellation of an active range import, and a successful next count query returning 814 objects. Querying 5,001 relationships displayed an explicit limit warning and only 3,000 relationships; search remained paged.
- Independent original-ZIP quality verification: 872 source records; Sessions 3 successful/2 denied, PrivilegedSessions 1 successful/4 denied, RegistrySessions 5 successful, LocalGroups 84 successful. The final desktop displayed 84 local-group probes.

| Measured dataset | Import | Analyze | Complete export | Peak helper RSS |
| --- | ---: | ---: | ---: | ---: |
| 2,000 actual objects / 40,000 distinct relationships | 5.12 s | 4.51 s | 2.48 s | about 173 MB |
| 100 objects with 35 MB of properties | 0.50 s | 0.53 s | 0.06 s (35,021,122 bytes) | about 525 MB |

These are measured local envelopes, not guarantees for larger directories. Large properties can require substantially more helper memory than the resulting file size. Query cancellation terminated and reaped the busy helper in approximately 1.03 seconds, and the next helper opened an identical canonical range graph.

Private evidence is retained under `artifacts/beagle-p2-runtime/`, `artifacts/beagle-p2-service/run-1792775879893/`, `artifacts/beagle-rules-edge-details-20261023/`, and `artifacts/beagle-p2-desktop/`. Source-report retention prunes history, not the current raw graph. Permanent project deletion is not provided; archive/recovery is the chosen removal workflow.
