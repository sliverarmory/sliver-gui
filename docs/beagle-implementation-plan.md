# Beagle AD Explorer

Implement a standalone AD analysis window in the existing Sliver Desktop application using Beagle as its local backend. The entry point is View → AD Explorer. The Go Sliver repository is not the UI integration target.

## Delivery plan

1. **Backend and project boundary:** maintain separate project databases beneath Electron userData, verify the bundled Beagle executable or an explicitly selected override, serialize process operations, validate typed requests, and keep native dialogs/filesystem/process access in main. Use a separate sandboxed preload and persistent partition with the existing strict CSP.
2. **Operator workflows:** import SharpHound ZIP/JSON with analysis; search entities; execute official AD queries and custom parameterized read-only Cypher; save custom queries by project; inspect graph/table results; inspect object properties; apply owned/tier-zero tags; find shortest paths; explain derived edges; export a canonical graph.
3. **Graph UI:** use HeroUI controls and React Flow, with directed relationship labels, graph layout, zoom/fit/minimap, selected object/edge details, bounded rendering, and explicit empty/error/truncation states.
4. **Real compatibility:** import the same private GOAD archive independently through Beagle and pinned BloodHound CE 9.8.0. Compare raw/analyzed graph identity and properties, then compare CE API projections and direct Neo4j query results. Keep empty cases and shortest-path tie differences visible. Private graph data stays outside source control.
5. **Verification:** regression tests for contracts, process lifecycle, normalization, isolated IPC, renderer interactions, preload bundles and window/menu integration; TypeScript and production build; native Electron import/query/graph workflow using the real backend. Record exact current results and limitations in the verification document.

## Scope and acceptance

This delivers local AD investigation workflows; it does not claim complete BloodHound product parity. Beagle's read-only Cypher language, 177-query catalog and AD analysis capabilities define the backend boundary. Azure, multi-user service administration, collector deployment and unrestricted Neo4j Cypher are outside this window. Large result sets must report truncation. Compatibility is certified only for the pinned corpus and collected dataset actually executed.

The implementation preserves the existing HeroUI, React Flow, FontAwesome, application settings, sandboxing, and native window conventions. No private collections, database snapshots or generated runtime binaries belong in version control.
