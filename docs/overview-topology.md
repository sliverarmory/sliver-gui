# Overview topology

The Overview uses a versioned JSON display model between application state and
graph rendering. `src/shared/topology-contracts.ts` has no React Flow or ELK
dependency. A document contains a connection scope, source timestamp, nodes,
edges, and inventory notices. The graph and list read the same document.

`src/renderer/src/topology/overview-topology.ts` adapts the bounded connection
snapshot. It does not fetch inventory, perform network probes, or execute
actions. Domain collections are authoritative, and their loaded/total counts
and freshness remain visible. Node IDs include the server/configuration scope,
resource kind, and resource ID. Epochs, display names, and check-in timestamps do
not affect identity.

## Adding infrastructure types

Add a pure `TopologyContributor` and include it alongside
`DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS` when building the document:

```ts
const document = createOverviewTopology(snapshot, {
  contributors: [
    ...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS,
    additionalInfrastructureContributor,
  ],
});
```

A contributor receives the snapshot, stable scope, connection state, and core
node IDs. It returns nodes, edges, and/or notices. Use a namespace and stable
resource identifier for each new ID. The builder rejects duplicate IDs, missing
edge endpoints, invalid parents, and containment cycles.

Kinds and icon keys are open strings. Every node must provide a readable label,
status label, and plain display properties so an unknown kind can use the generic
card. Specialized icon/node renderers are optional enhancements. A `resource`
reference is a display/navigation identity; it is not a target execution
capability. Do not include credentials, commands, HTML, external asset URLs, or
opaque source objects. Properties are JSON scalar values.

Use `role: "group"` with a child's `parentId` for visual containment. This does
not imply communication. Edges explicitly distinguish `communication`,
`containment`, and other `relationship` roles; renderers must not style every
edge as traffic. New contributors that know physical routing can add those
relationships explicitly and document their source.

## Current data semantics

- The cloud enclosure comes from the explicit managed deployment association.
  Its cached region, size, instance state, and addresses are display metadata;
  they are not live provider-health measurements. An unmanaged server has
  unknown hosting. Server connectivity and cached VM state remain separate.
- Session and beacon edges represent server-reported logical communication.
  Intermediate hops and exact listener attribution are not inferred, including
  for pivot transports. Listener inventory remains server metadata.
- An active session is `live`; a dead session is `inactive`; a beacon is
  `periodic`. Overdue beacons carry a warning on their node. Reported activity
  timestamps are available for brief observed-activity indicators. There are no
  invented bandwidth, packet-rate, direction, or latency measurements.
- Disconnected connections, unavailable event streams, and stale/failed domains
  make affected remote relationships `unknown` and mark records last known.
  They do not imply remote hosts have died. Empty snapshots with no server
  identity never render retained target records.
- A page may retain the prior snapshot for a last-known view after disconnect,
  provided it retains that snapshot's server identity and marks the connection
  unavailable. It must discard that retained context when switching servers.

There is no persisted graph import/export format or external plugin execution
in this first version. Schema version 1 is an internal JSON-safe boundary ready
for additional trusted adapters.

## Rendering and layout

`OverviewDocument` consumes a `TopologyDocument` with an optional node decorator. Search, type/status
filters, the inspector, and the accessible list all use that document. The
projection preserves one hop of context and parent enclosures while filtering.
Large homogeneous leaf collections collapse into summaries, with their
individual records available on expansion. Unknown kinds retain a generic card
and icon; the renderer does not require a switch case for each infrastructure
type.

React Flow renders the projected document. ELK runs in a dedicated, locally
bundled Web Worker. The renderer uses the lightweight ELK API, and passes only
IDs, containment, edges, and geometry to the worker. The worker cannot access
the preload API or Node. The CSP permits workers from the app's own origin with
`worker-src 'self'`; no blob or remote-worker sources are allowed.

Layouts are recalculated when graph structure changes or Reset layout is
selected. Status and check-in updates do not trigger a layout. Drag/keyboard
positions and the viewport are retained in bounded, window-local caches; no
infrastructure data is persisted to browser storage. A failed or timed-out
layout leaves the List view available.

The first completed layout fits the measured graph to the viewport. Subsequent
status updates preserve the viewport, and the zoom controls retain accessible
names while displaying `+` and `−`.

The application decorates session and beacon nodes with the shared target-table
context menu. Both start with **Interact** in the current window and **Interact**
with the pop-out icon for a standalone interaction window. The latter has the
accessible name **Interact in new window**. It resolves the display resource ID
against current main-issued target references outside the JSON model and confirms
the exact target before navigation. Session Rename and lifecycle review dialogs
reuse the existing UI; right-clicking alone never selects or changes a target.
Stale event telemetry does not hide these actions when the backend remains
connected, degraded, or reconnecting and still issues a matching target reference.
These views share the application's connection-usability rule. Retained nodes
after disconnect, or nodes without a current reference while inventory refreshes,
keep the same menu with disabled actions; display IDs never grant action authority.

## Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e:overview`
- `npm run test:e2e:protocol`

The Overview Electron test uses synthetic unmanaged, AWS, and Azure records,
the actual bundled ELK worker, and the production CSP. It exercises graph/list
switching, filters, inspection, layout controls, and both interaction navigation
paths for sessions and beacons. It checks that no target
commands or cloud actions occur. Screenshots are written to
`artifacts/overview-e2e/`. The protocol test also verifies a same-origin module
worker and its static import from an ASAR archive.
