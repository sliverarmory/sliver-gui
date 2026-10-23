# Beagle / AD Explorer gap analysis against BloodHound CE

> Follow-up: P1 remediation and the P2 implementation are tracked separately. See [P2 roadmap and local verification](beagle-p2-roadmap.md) for implemented workflows, measured limits, and remaining scope choices. The findings below describe the original assessment.


Assessment date: October 23, 2026. This is an implementation and evidence review, not a new full CE oracle run. No application code was changed.

This document preserves the assessment baseline. Subsequent P1 implementation and local acceptance results are tracked in [the P1 roadmap](beagle-p1-roadmap.md); the findings below describe the pre-implementation state. CI compatibility work remains deferred by request.

Beagle implements a substantial part of CE's AD ingestion and analysis model. AD Explorer provides a working local investigation workflow, but it is not yet a complete CE Explore replacement. The most consequential gaps are neighborhood completeness, contextual investigation controls, data lifecycle, and reproducible compatibility testing. An overall parity percentage would conceal these differences.

## Baselines and evidence

| Component | Baseline |
| --- | --- |
| Sliver GUI | `237470f6b2991a780c0a65d3d41374373146f071` |
| Current Beagle source | `3a89bba4645b5b235ef12028ad9cdb0534043015`, version 0.1.0 |
| Previously executed Beagle | Source pin `6dc34300f67d025dccd4c7fef36cf31210c46a42`; executable SHA-256 `61e22ffc5d12e9dc6d1014c17a01ab8843e132ff4dd6aa2c9c76df7c5c23a10e` |
| BloodHound CE | [Stable v9.8.0](https://github.com/SpecterOps/BloodHound/releases/tag/v9.8.0), source `1759e1638435595def27eb3ff3c5a6fc32832ddc` |
| Query catalog | 177 AD queries; SHA-256 `878494e95e4f9474f67a3263f14bd953eca904e8b0ebf7c3040955393214b725` |

CE 9.8.0 was the latest stable release when checked; 9.9 release candidates were excluded. The local legacy BloodHound 4.x checkout was also excluded. Beagle's current revision changes native build/distribution inputs but has no Rust `src/` changes relative to the executed source pin. This does not establish that a newly built executable has the same behavior or provenance.

The [existing verification record](/Users/moloch/git/sliver-gui/docs/beagle-verification.md:9) distinguishes two collections:

- **Independent CE comparison:** earlier GOAD ZIP `d64e7ff60f95b93308a0f674c9e94562c457cf8a184b56a5b7184155f9d7d1b3`. Raw graphs matched at 790 nodes / 6,569 edges; analyzed graphs matched at 814 / 8,889, with the documented operational timestamp normalization. The 16-case API/projection suite passed, with 15 nonempty cases.
- **Fresh sliver-range desktop verification:** SharpHound 2.17.1 ZIP `8a13419e1fd550e27beddf57ebfdb2f95ad25c827f67eaadeed35aa24541b80a`, containing 15 schema-v6 files and 872 source records. This verified the production Electron import/investigation path and the search/graph-limit fixes. It did **not** repeat the independent CE oracle comparison.

The 177-query comparison comprises **76 exact nonempty results, 91 equal empty results, six equivalent shortest-path ties, and four independently verified limited shortest-path selections**. Thus 86 queries have nonempty evidence; “177 exact positive matches” would be incorrect. Empty GOAD results do not prove the corresponding algorithms work for positive inputs.

There is additional positive backend evidence: local synthetic fixtures captured from CE include three analyzed graphs and **49 composition/relay cases**, with nonempty coverage across all 13 AD composition kinds and all four relay-target kinds. These include NTLM relay and AD CS cases absent from GOAD. However, the current Beagle Git allowlist excludes these oracle tests/fixtures and helper tools; older local documentation calling them checked-in is stale. They are retained local evidence, not a reproducible clean-checkout CI guarantee. See [fixture provenance](/Users/moloch/git/Beagle/tests/fixtures/oracle/metadata.json:1) and [current tracking rules](https://github.com/sliverarmory/Beagle/blob/3a89bba4645b5b235ef12028ad9cdb0534043015/.gitignore#L57).

## What is already implemented

| Capability | Finding and boundary |
| --- | --- |
| AD collection ingestion | Schema-v5/v6 handling covers all 19 CE AD node kinds, all 26 CE ingest ACL relationship kinds, and the 17 non-Azure basic ingest categories, including sessions. Inventory coverage is not proof for every field combination. |
| AD analysis | Native stages cover local privileges, DCSync, LAPS, trusts, ownership, AD CS, NTLM relay and default Tier Zero tagging. A concrete local-group ambiguity remains, described below. |
| Composition and relay targets | Native dispatch covers all 13 CE AD composition kinds and four relay-target kinds. Composition is exposed in AD Explorer; relay targets are not. |
| Querying | Official 177-entry AD catalog, parameters, custom read-only Cypher, scalar tables, graph results, entity search and shortest/all-shortest attack paths. This establishes the pinned corpus, not unrestricted Neo4j compatibility. |
| Desktop workflow | Isolated projects, import plus analysis, object/edge inspection, Owned/Tier Zero tagging, graph/table views, local custom queries and full canonical graph export. |
| Previously reported limits | Object search now has bounded 100-result pages with explicit continuation. The 1,500-node graph cap applies to search additions and expansion, with dangling edges removed and visible warnings. Both fixes have production Electron evidence. |

Backend source inventories and caveats are documented locally in [analysis coverage](/Users/moloch/git/Beagle/docs/analysis-coverage.md:5). The desktop contracts are in [beagle-contracts.ts](/Users/moloch/git/sliver-gui/src/shared/beagle-contracts.ts:70).

## Priority gaps

P1 denotes work to prioritize before claiming dependable CE-style AD investigation. P2 denotes important workflow or operational completeness. These are implementation priorities, not vulnerability severity ratings.

### P1: Relationship expansion still silently omits data

The inspector's [expansion query](/Users/moloch/git/sliver-gui/src/renderer/src/BeagleWindowApp.tsx:388) ends with `LIMIT 250`, without ordering, a continuation token, lookahead or a total count. The [normalizer](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:581) only detects its separate 5,000-row / 1,500-node / 3,000-edge display limits, so a query stopped at 250 appears complete.

This is confirmed on the fresh dataset: **eight nodes have more than 250 incident relationships**. The largest has **1,727**; executing the exact native expansion query returns **250**, omitting **1,477 (85.5%)** without a truncation marker. It is separate from the repaired object-search pagination and graph-cap bypass.

**Acceptance:** bounded, stable neighborhood pages or an explicit incomplete-neighborhood indicator; verify all 1,727 relationships are reachable without eagerly loading them, while preserving graph caps. This review executed the query and inspected the renderer/service path; it did not perform another native UI run. A canonical export from a temporary copy confirmed the retained baseline graph remained identical at 814 nodes / 8,889 edges despite native database housekeeping changing its storage hash.

### P1: Investigation controls are substantially behind CE

| Area | CE 9.8 behavior | Our gap |
| --- | --- | --- |
| Pathfinding | Endpoint autocomplete, swapping, up to four ordered nodes, and relationship filters that constrain the actual search. | Two object-ID fields; fixed `AD_ATTACK_PATHS` kinds; no selectable edge kinds. Shortest/all-shortest and hop bounds already work. |
| Contextual node queries | 71 relationship-query actions across 15 AD/generic sections, including membership, sessions, local privileges, object control, trust and PKI navigation. | One generic expansion action plus raw properties. Operators must write queries for most follow-up investigations. |

CE's filters are not merely visual: its [shortest-path API](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/go/openapi/src/paths/graph.graphs.shortest-path.yaml#L40) accepts relationship kinds and traversability. Compare our [path contract](/Users/moloch/git/sliver-gui/src/shared/beagle-contracts.ts:65), [native helper](https://github.com/sliverarmory/Beagle/blob/3a89bba4645b5b235ef12028ad9cdb0534043015/src/engine.rs#L383), [inspector](/Users/moloch/git/sliver-gui/src/renderer/src/BeagleWindowApp.tsx:375), and CE's [contextual query definitions](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/javascript/bh-shared-ui/src/utils/content.ts#L716).

**Acceptance:** expose typed path filters and the highest-value contextual queries first, with counts and bounded pagination. Compare returned identities/relationships against CE. An excluded edge type must change traversal, not just disappear from the drawn result. Validate each contextual query's semantics rather than treating the 71-action inventory as 71 already-tested queries.

### P1: One known native analysis divergence affects privileges

When multiple eligible local groups attach to a computer, Beagle prefers the computer-scoped group ID and then lexical order. CE takes the first database match without ordering. A recorded upstream fixture produced **3,490 CE edges versus 3,488 Beagle edges**, with **four differing `AdminTo` edges**; all other normalized records matched. This is not a mismatch in the strict GOAD comparison, which required no exception.

The deterministic Beagle choice is understandable, but different privileges can yield different paths. See [selection logic](https://github.com/sliverarmory/Beagle/blob/3a89bba4645b5b235ef12028ad9cdb0534043015/src/analysis.rs#L114), [CE selection](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/go/analysis/ad/post.go#L491), and [recorded divergence](/Users/moloch/git/Beagle/docs/analysis-coverage.md:51).

**Acceptance:** retain an explicit compatibility boundary, surface affected computers and candidate groups in the import/analysis UI, and test downstream path effects. Do not label an ambiguity-accepted comparison exact or silently union candidate privileges.

### P1: Compatibility evidence is not a release gate

- **GUI CI omits Beagle's native scenario.** The [standard Electron command](/Users/moloch/git/sliver-gui/package.json:39), used by [CI](/Users/moloch/git/sliver-gui/.github/workflows/build-and-release.yml:125), excludes it. The dedicated [test](/Users/moloch/git/sliver-gui/src/e2e/beagle-window.e2e.ts:27) skips without externally provided binary/collection inputs and uses the test main process. Separate manual production-main evidence exists.
- **Oracle tooling and synthetic evidence are local-only.** The GUI [compatibility verifier documentation](/Users/moloch/git/sliver-gui/docs/beagle-verification.md:56) requires three unpublished helpers; current Beagle tracking also excludes the retained oracle fixtures/tests. Public native unit tests do exist, but they are not an independent CE oracle.
- **Runtime compatibility is not enforced.** [Runtime discovery](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:306) accepts any single-line `beagle ...` version response, without a supported version/capability contract. A version string alone does not identify the tested executable.
- **Execution coverage is narrower than declared support.** Desktop evidence is macOS and a small lab; native build workflows do not establish packaged GUI/runtime integration on each platform. The final verifier's newer input-immutability guard also lacks a retained execution result.

**Acceptance:** ship a redistributable positive/negative AD fixture suite and public oracle runner; require native integration with zero skips in CI; preserve exact source, executable, catalog and CE pins; verify packaged applications on supported OS/architectures. Include a current fresh-collection oracle run and a version/capability handshake with clear incompatible-runtime errors.

### P2: Data quality, retention and recovery are incomplete

CE exposes import history and collection-quality information, including session/local-group completeness, beyond object totals. It also offers [selective cleanup](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/go/openapi/src/paths/data-quality.clear-database.yaml#L20) for relationship kinds such as sessions, collected data and history. See the official [data-quality workflow](https://bloodhound.specterops.io/collect-data/data-quality).

Our GUI always merges imports, automatically analyzes, and keeps only the latest operation report as raw JSON. Projects can be created/selected but not renamed/deleted; there is a 100-project limit. There is no retention policy, session cleanup, dataset replacement flow, import history or complete project backup/restore. Native Beagle already supports replace ingestion and snapshot import, so part of this gap is exposure rather than a new backend. Native merge/replace alone does not provide selective stale-data cleanup.

Import warnings deserve a summary rather than only “Import finished”: the fresh collection included retained-only/nullable fields and collector probe failures. An absent relationship must not be presented as proof that collection was complete. Native ingestion is transactional by source inspection; no partial-commit defect was demonstrated.

There is also an intentional freshness difference: CE stamps derived edges with operational `lastseen` values; Beagle preserves collection timestamps but does not synthesize these on derived records. The normalized graph comparison excludes those timestamps, so it does not establish freshness-query parity. See [CE edge creation](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/packages/go/analysis/post/operation.go#L35) and [Beagle analysis behavior](/Users/moloch/git/Beagle/docs/analysis-coverage.md:75).

**Acceptance:** surface collection coverage and warning counts, persist import provenance, expose replacement/cleanup with explicit scope, and round-trip graph, tags, queries and provenance together. Through the real desktop path, verify malformed input and interrupted imports preserve committed data and allow recovery. Relevant code: [import service](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:136), [API surface](/Users/moloch/git/sliver-gui/src/shared/beagle-contracts.ts:70), [operation feedback](/Users/moloch/git/sliver-gui/src/renderer/src/BeagleWindowApp.tsx:122).

### P2: Several native capabilities and CE workflows stop at the UI boundary

| Workflow | Current gap | Work required |
| --- | --- | --- |
| Edge explanation | Properties and composition exist; relationship guidance, ACL inheritance origins and relay-target inspection do not. | Add content and inheritance query mappings. Expose the existing native `relay_targets` API through typed IPC. |
| Existing zone/label rules | Only per-object Owned/Tier Zero switches are exposed. | Expose native object/Cypher seeds, directional expansion, exclusions and precedence, with persistent rule enablement and preview. |
| Saved queries | Up to 100 per-project localStorage entries; no description/category editing or portable import/export. | Add CE/query-library-compatible interchange and include queries in backups. Shared-user permissions are optional for a local product. |
| Investigation history | A query or opened composition replaces the current graph; no navigation history or resumable investigation. | Preserve query/parameters/selection/filter state and support back/forward. |
| Result sharing | Export writes the complete project graph, not the selected result; no CSV export or configurable table columns/sort. | Add current-result JSON and table export, separate from project backup. |
| Graph controls | Zoom, fit, arrange and minimap exist; graph find, label controls and alternate layouts are absent. | Add the controls useful for local investigations; do not count Enterprise-only layouts as CE gaps. |

Our relevant code is [EdgeInspector](/Users/moloch/git/sliver-gui/src/renderer/src/BeagleWindowApp.tsx:399), [custom-query storage](/Users/moloch/git/sliver-gui/src/renderer/src/beagle/beagle-model.ts:52), [native asset groups](https://github.com/sliverarmory/Beagle/blob/3a89bba4645b5b235ef12028ad9cdb0534043015/src/asset_groups.rs#L16), and [graph controls](/Users/moloch/git/sliver-gui/src/renderer/src/beagle/BeagleGraph.tsx:184). CE references include [saved-query workflows](https://bloodhound.specterops.io/analyze-data/explore/cypher-search), [exploration controls](https://bloodhound.specterops.io/analyze-data/explore/search), and the pinned [CE privilege-zone provider](https://github.com/SpecterOps/BloodHound/blob/1759e1638435595def27eb3ff3c5a6fc32832ddc/cmd/ui/src/views/PrivilegeZones/PrivilegeZonesProvider.tsx#L70). The CE comparison here covers managing existing zone/label rules, not arbitrary custom-zone creation or certification.

### P2: Scale and cancellation need explicit product contracts

The measured dataset has 814 objects / 8,889 relationships. The 1,500-node cap test used read-only display aliases, not a 1,500-object directory. There is no large-directory throughput or memory benchmark.

The service buffers complete native JSON output before applying display limits. Its **32 MiB output cap** and **two-million-entry decode ceiling** also apply to full graph export, so a sufficiently large export fails even though it is described as complete. Queries have bounded execution time, but all operations serialize and there is no user cancellation or progress channel; workflows can occupy the service for five minutes. See [service limits](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:18), [execution](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:313), and [decode](/Users/moloch/git/sliver-gui/src/main/beagle-service.ts:480).

**Acceptance:** define supported dataset sizes; measure dense graphs, large properties, import/analysis memory and latency, and renderer responsiveness. Test exports beyond 32 MiB, adding streaming or a clearly stated maximum. Exercise cancellation, child cleanup, rollback and the next successful operation. Keep display limits; do not mistake them for bounded backend memory or execution cost.

## Scope choices and remaining uncertainty

Azure/OpenGraph ingestion, hybrid analysis, a hosted REST service, multi-user authentication/authorization, shared query permissions and collector deployment are absent. They are deliberate exclusions from the [local AD scope](/Users/moloch/git/sliver-gui/docs/beagle-implementation-plan.md:15), not blockers for that scope. They become substantial separate workstreams only if the goal changes to full CE replacement.

Enterprise risk scoring/remediation, ETAC, arbitrary privilege-zone creation, certification, and Enterprise-only graph layouts are not charged as CE gaps. CE's own Cypher support is constrained; unrestricted Neo4j/APOC is not the acceptance target. Local probes found unsupported function-property forms in Beagle, but they were not compared with the CE API and are not classified here as confirmed CE-contract failures. Further language conformance should target CE's [documented supported syntax](https://bloodhound.specterops.io/analyze-data/explore/cypher-supported) and real operator queries.

Recommended implementation order:

1. Correct expansion completeness and expose analysis/import ambiguity warnings.
2. Add path-edge filtering and paged contextual node drilldowns.
3. Make positive oracle fixtures and native GUI checks reproducible CI gates; enforce runtime compatibility.
4. Add project replacement/cleanup/backup and durable import diagnostics.
5. Expose relay targets and rule management; add query interchange, investigation history and current-result export.
6. Establish scale/export/cancellation contracts before claiming large-directory readiness.

This assessment used source inspection, official CE documentation, retained execution evidence, fixture inventories and a targeted native expansion probe. It did not rerun the entire application suite, launch a new CE service, or verify a newly packaged cross-platform release.
