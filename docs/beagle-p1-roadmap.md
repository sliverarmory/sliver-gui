# Beagle P1 implementation roadmap

This roadmap addresses the P1 findings in `beagle-gap-analysis.md`. Compatibility testing remains local and point in time, as requested. It does not add CI jobs, publish private oracle tooling/data, or claim continuous compatibility certification.

## Milestones

| Milestone | Implementation | Local acceptance | Status |
| --- | --- | --- | --- |
| P1.1 Neighborhood completeness | Typed, ordered 250-relationship pages with totals and continuation; preserve graph display caps and reject stale pages. | All 1,727 high-degree relationships matched the canonical export across seven pages. Native Next/Previous and the 1,500-object cap passed. | Complete |
| P1.2 Investigation controls | All 71 CE contextual actions with counts and bounded pages; paged endpoint lookup, four ordered endpoints, reversal and 62 selectable path relationships. | All 71 actions matched CE target identities and counts: 55 nonempty, 16 empty. Native Electron demonstrated membership drilldowns, endpoint page two, ordered paths and exclusion filters. | Complete |
| P1.3 Ambiguous privileges | Persist diagnostics per project and explain affected computers, privilege kinds, chosen groups and alternatives. Invalidate stale diagnostics before import/analysis and recover UI state on failure. | Two positive fixtures covered four privilege kinds and 16 downstream path assertions. Native GUI warnings, inspection, reload, project isolation and malformed-import recovery passed. | Complete |
| P1.4 Runtime compatibility boundary | Enforce the Beagle 0.1.x interface, required commands, capability schema and query features, with incompatible-runtime errors. | The pinned executable passed the handshake; unsupported versions, commands and capabilities are covered by local regression tests. Fresh sliver-range independently matched CE's analyzed graph. | Complete |

## Validation approach

- Keep the existing fresh sliver-range collection and operator project intact; use isolated project/database copies for native probes and synthetic cases.
- Record the exact GUI revision plus working-tree changes, native executable hash, catalog hash, CE reference and collection hash with each milestone's local results.
- Run relevant contract/service/IPC/renderer regression suites as each interface lands, then typecheck/build and exercise the actual Electron preload/IPC/native service path.
- Distinguish independent CE comparisons, canonical dataset comparisons, synthetic positive cases and mocked regression tests. Report empty cases and untested platform/scale boundaries explicitly.
- Keep generated databases, directory identities, oracle reports and screenshots in ignored private artifacts. Commit only source, non-sensitive tests and aggregate documentation.
- The CI compatibility/public-oracle workstream from the gap analysis is deferred by request. P2 features remain outside this implementation.

## Results

Acceptance was performed locally on macOS on October 23, 2026, against the production Electron main/preload/IPC path and an isolated copy of the existing sliver-range collection. The exact input pins and detailed acceptance record are in [Beagle verification](beagle-verification.md#p1-local-acceptance).

- The fresh collection was independently ingested into CE 9.8.0. All 15 files were accepted; the normalized analyzed graph matched Beagle at **814 objects and 8,889 relationships**, without an ambiguity exception.
- Neighborhood pages expose a total and continuation. Contextual pages count distinct target objects and return supporting graph evidence. The 29 terminal-node actions and two foreign-principal actions use bounded adjacency traversal to preserve CE's behavior on convergent and cyclic graphs; exhausting a resource limit fails explicitly rather than returning a partial total.
- Pathfinding applies the selected edge kinds to every ordered leg. The complete selection uses the same explicit 62-kind set as a partial selection; it does not switch to a different native alias. A missing leg returns no partial itinerary. Native positive coverage includes the canonical `WriteDacl` spelling.
- Ambiguity reporting is a compatibility boundary, not a change to native selection. Beagle still chooses deterministically where CE may choose another eligible group. The UI exposes that difference, and never combines candidate privileges.
- Compatibility tests and private oracle evidence remain local. No CI jobs, release gates, fixture publication, packaging certification or external service integration were added. Windows/Linux packaging and large-directory performance remain unverified; the existing P2 roadmap still applies.

Review follow-ups also corrected stale diagnostics after failed operations, complete path-filter selection, the ACL relationship spelling, repeated-node terminal semantics, path-copy memory growth, and a past-end pager range. Final validation passed the production build, both TypeScript projects, nine preload checks and **5,919 tests**, including the opt-in native fixture; three tests were skipped. Generated databases, reports and screenshots remain outside tracked source. Disposable CE containers, volumes and credentials were removed after the comparison.
