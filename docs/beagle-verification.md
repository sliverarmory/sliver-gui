# Beagle compatibility verification

The real GOAD SharpHound collection was imported independently into Beagle and a fresh BloodHound CE service on October 22, 2026 (America/Los_Angeles). Both raw ingestion and analyzed graphs matched, and real Cypher queries were compared with the actual CE API and its Neo4j database.

## Pinned inputs

| Input | Version / identity |
| --- | --- |
| Beagle source | `6dc34300f67d025dccd4c7fef36cf31210c46a42`, version `0.1.0` |
| Executed macOS Beagle binary SHA-256 | `61e22ffc5d12e9dc6d1014c17a01ab8843e132ff4dd6aa2c9c76df7c5c23a10e` |
| BloodHound CE | `9.8.0`, source `1759e1638435595def27eb3ff3c5a6fc32832ddc` |
| BloodHound image digest | `sha256:88aeb60228d8ad09a8ac1cdcea8218b4aabe3d9ac642f2f66d50a6b144f4d301` |
| Neo4j | `4.4.42`, image `sha256:73b5a47eb9952f47fcc42fcc80bdd6bd0d6b71eea9a1a345c216675498c790e4` |
| PostgreSQL | `18`, image `sha256:1267c7e692de235fda2a50dbcdbcbca4672ea6a0298576a6bd9d07cafc319b32` |
| Python Neo4j driver | `5.28.2` |
| Original private GOAD ZIP SHA-256 | `d64e7ff60f95b93308a0f674c9e94562c457cf8a184b56a5b7184155f9d7d1b3` |
| Official 177-entry AD catalog SHA-256 | `878494e95e4f9474f67a3263f14bd953eca904e8b0ebf7c3040955393214b725` |

The binary hash identifies the executable actually tested. The source revision and binary hash are recorded separately; this validation does not claim a reproducible source-to-binary build.

## Fresh results

CE accepted all 15 SharpHound JSON files, with zero failed or partially failed files.

| Comparison | Result |
| --- | --- |
| Independent raw import | Exact normalized graph: 790 nodes, 6,569 relationships |
| Independent analyzed graph | Exact normalized graph: 814 nodes, 8,889 relationships |
| CE API / Neo4j / Beagle projection suite | 16 / 16 passed; 15 nonempty |
| Full bound catalog: exact nonempty | 76 queries |
| Full bound catalog: equal empty | 91 queries; positive behavior not exercised |
| Full bound catalog: equivalent shortest-path ties | 6 queries |
| Full bound catalog: independently verified limited shortest-path selections | 4 queries |
| Errors, timeouts, mismatches | 0 |
| Graph and execution artifacts unchanged throughout catalog comparison | Both true |

The raw and analyzed comparisons check all AD identities, labels, directed endpoints, relationship types, properties and numeric JSON types. They exclude only operational `firstseen`, `lastseen`, `lastcollected` properties and Beagle's internal `derived` flag. Equivalent UTC encodings are normalized; duplicate identities fail the comparison. No local-group ambiguity exception was used.

The strict query sweep used a second Beagle database imported from the exact fresh CE snapshot. It compares every graph property, including timestamps, without omissions. Row multiplicity, ordered lists and path sequences are preserved. Alternate shortest-path results require independent path validity and minimum-length checks; limited selections also verify each returned endpoint pair against the original predicates in Neo4j. Four catalog templates were bound to actual values in the tested collection.

Four scalar queries also matched directly on the independently imported Beagle database, CE API and Neo4j:

| Cypher | Result in all three |
| --- | ---: |
| `MATCH (u:User) RETURN count(u) AS users` | 54 |
| `MATCH p=(:User)-[:MemberOf*1..3]->(:Group) RETURN count(p) AS membership_paths` | 452 |
| `MATCH p=(a)-[r]->(b) WHERE r.isacl RETURN count(p) AS acl_paths` | 7,581 |
| `MATCH (n:Tag_Tier_Zero) RETURN count(n) AS tier_zero` | 203 |

The API suite additionally exercised 134 direct membership paths, five trust paths, 15 session paths and 38 AD CS paths. Its NTLM case was empty and does not establish positive NTLM coverage. CE's graph API flattens rows and paths; exact row/path coverage comes from the separate direct Neo4j comparison.

## Reproduce with a private collection

The verifier requires Docker with Compose, Python 3.11+, a built Beagle executable, and the pinned Beagle source checkout. Its output must be a new directory outside the source tree; it creates that directory with mode 0700. It never overwrites prior evidence.

**External dependency:** Beagle's `tools/oracle.py`, `tools/oracle_api_parity.py` and `tools/query_parity.py` are retained local compatibility tooling and are currently excluded from the public Beagle repository. A fresh public checkout alone is insufficient. Supply the validated local tool bundle alongside the source checkout. The verifier checks each helper's SHA-256 before importing or executing it, in addition to the source revision and catalog hashes. It fails with a named missing-input or checksum error if this bundle is unavailable or differs.

The separate `--bindings` JSON supplies actual values from the collection for all four query templates. It is required so unbound placeholders cannot silently count as verified queries. Its format is documented by the Beagle query harness; retain it with private collection evidence.

```sh
python3 -m venv /tmp/beagle-compatibility-python
/tmp/beagle-compatibility-python/bin/pip install neo4j==5.28.2

# Set these to existing private inputs. The output directory must not exist.
BEAGLE_SOURCE=/path/to/Beagle
COLLECTION=/private/path/to/collection.zip
BINDINGS=/private/path/to/query-bindings.json
OUTPUT=/tmp/sliver-gui-beagle-compatibility

PATH="/tmp/beagle-compatibility-python/bin:$PATH" \
  npm run test:beagle:compatibility -- \
  --beagle-source "$BEAGLE_SOURCE" \
  --collection "$COLLECTION" \
  --bindings "$BINDINGS" \
  --output "$OUTPUT"
```

`--binary /path/to/beagle` overrides the default `$BEAGLE_SOURCE/target/release/beagle`. This allows comparison of the precise standalone executable configured in the desktop application. Python must have `neo4j==5.28.2` installed; no credentials are accepted on the command line.

The runner independently ingests the original collection, captures raw CE data with analysis disabled, enables CE analysis, compares both complete graphs, then runs the 16-query API suite and all 177 catalog queries. It uses a unique disposable Compose project, three loopback-only ports and generated credentials. It never connects to an existing operator BloodHound deployment. Cleanup runs in `finally`, removes only that project's containers and volumes, verifies they are gone, then deletes temporary credentials. If cleanup fails, the command fails and retains its private state and cleanup diagnostics for recovery.

Output includes `summary.json`, raw/analyzed comparison reports, the independent `goad.db`, a separate `oracle-queries.db`, detailed `api.json` / `queries.json`, captured graphs and private logs. Console progress includes only counts, classifications and report paths. Do not commit the output directory: graphs, query bindings and detailed reports contain lab identities.

The command fails on graph/query mismatches, missing corpus cases, unproven placeholders, changed graphs/artifacts, or incomplete cleanup. Empty and equivalent-path cases remain separately classified; a successful run does not report them as exact positive coverage.

The reusable verifier was itself run against a second fresh oracle on the same date and reproduced the counts and query classifications above. Its private `summary.json` records a successful result and zero remaining owned containers or volumes.

## Desktop integration verification

The macOS integration passed TypeScript checks, the production build and validation of all nine sandboxed preload bundles. The complete application regression suite passed 5,859 tests across 285 files, with three tests skipped in two files. This includes the native service, IPC authorization, preload isolation, window/menu behavior and React UI.

The native Electron test (`npm run test:e2e:beagle`) used the executable and original collection identified above. It opened the standalone window from the application menu, created an isolated project, imported and analyzed the collection, loaded all 177 saved queries, ran real scalar and graph Cypher, selected nodes and relationships (including keyboard selection), saved a custom query, rejected write and file-loading Cypher, exported the complete graph, and verified persistence after reload. It also checked the 1,000-pixel window layout and reported zero page errors or Content Security Policy violations. This test passed without skips; its temporary application data was removed afterward.

To run that integration test against an existing private collection:

```sh
SLIVER_BEAGLE_E2E_BINARY=/path/to/beagle \
SLIVER_BEAGLE_E2E_COLLECTION=/private/path/to/collection.zip \
  npm run test:e2e:beagle
```

This fixture expects the recorded GOAD counts and identities. Successful screenshots are saved under the ignored `artifacts/e2e/` directory. The independent native service check additionally exercised entity lookup, relationship-only result hydration, pathfinding, owned/tier-zero tag changes, AD CS composition, reanalysis, project switching and recovery after malformed Cypher.

The pinned engine's read-only authorization permits `LOAD CSV` file reads, so the desktop service additionally rejects file-loading and dynamic-query entry points before execution. Regression cases cover case variations, comments, escaped strings and quoted identifiers. Native sentinel-file probes were rejected, and all 177 authoritative saved-query sources plus the four bound templates remained supported.

## Search pagination and graph limits

The pagination and graph-limit fixes were verified on October 22, 2026 (America/Los_Angeles), using the freshly collected sliver-range ZIP with SHA-256 `8a13419e1fd550e27beddf57ebfdb2f95ad25c827f67eaadeed35aa24541b80a`. The retained project contains 814 objects and 8,889 relationships. These checks used the rebuilt production Electron entry, the real preload/IPC/service path, and the pinned Beagle executable above.

Search returns 100 objects per page, with one additional backend row used only to determine whether another page exists. Matching remains case-insensitive on name and object ID; ordering includes object ID to stabilize ties. Previous/Next controls show the displayed range and whether more results exist. A new term or project invalidates pending pages.

- Native service enumeration returned all 812 `local` matches across nine pages and all 110 `north` matches across two pages, without duplicates or omissions. Results matched independent native queries and the original CLI's matching semantics. Case variations, quotes, backslashes and option-like terms remained bound data.
- In the production UI, `north` showed `Objects 1–100 · More available`, then `Objects 101–110 · End of results` with Next disabled. WINTERFELL opened successfully from the second page. Previous navigation and a new three-result KINGSLANDING search also passed.
- Since the dataset contains fewer than 1,500 objects, the boundary check used read-only result maps derived from its objects. It did not insert test objects into the database. Loading 1,499 distinct display aliases and selecting the real KINGSLANDING computer filled the 1,500th slot. Selecting another search result showed an explicit limit error and retained exactly 1,500 objects. Existing objects remained inspectable.
- Relationship expansion with one remaining slot retained 1,500 objects and three valid computer-to-domain edges (`DCFor`, `DCSync`, `GoldenCert`), with a visible truncation warning. Edges whose endpoints were omitted were discarded.
- A read-only backup of the retained project matched its pre-fix GUI export exactly after these checks: all node/edge identities, properties, JSON types and operational timestamps, with no exclusions.

The boundary projection is reproducible in the query editor:

```cypher
MATCH (n) UNWIND [0,1] AS replica
RETURN {objectid:'limit-probe-'+toString(replica)+'-'+n.objectid,
        labels:['LimitProbe'], properties:{name:n.name}} AS probe
LIMIT 1499
```

For the expansion check, use `LIMIT 1498`, select the real KINGSLANDING computer from search, then expand its relationships. Replace the projection with an ordinary query afterward.

Validation passed `npm run build:e2e-app` (including both TypeScript projects and nine sandboxed preload bundles) and the full `npm test` suite: 5,870 passed, three skipped, across 285 passed and two skipped files. Automated regressions cover page boundaries, stale responses, page failure recovery, search insertion at the cap, and expansion endpoint filtering. Private native/UI evidence is retained under the ignored `artifacts/beagle-pagination-20261023T054657Z/` directory. The normal domain/DC graph was restored and left open with the second search page visible.

## Evidence boundaries

This verifies the pinned backend, recorded AD dataset/query corpus and native macOS desktop integration. It does not prove unrestricted Cypher, every BloodHound CE feature, or positive algorithms whose queries returned no data. Distribution packaging and native execution on other operating systems were not exercised. Beagle remains an external executable selected by the operator or supplied through `SLIVER_BEAGLE_BINARY`; this change does not bundle a cross-platform Beagle release. This run's disposable containers, volumes and credentials were removed after verification; private databases and reports were retained outside the source tree.
