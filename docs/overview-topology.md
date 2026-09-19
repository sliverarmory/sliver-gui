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

- The cloud enclosure comes from the explicit managed deployment association,
  but represents its shared infrastructure scope: an AWS VPC or Azure resource
  group. It displays provider/network metadata (VPC ID/CIDR and region, or Azure
  subscription, resource group, and VNet metadata). Its label and scoped identity
  use that network/group rather than a VM name. Unknown scopes fall back to the
  provider label without guessing a network or sharing an unverified identity.
- The enclosed server owns deployment/instance identity, size, cached state and
  health, instance region/location, availability zone, subnet, and IP addresses.
  It retains live server connectivity separately from cached instance state.
  Azure VM location is not presented as a resource-group location; an existing
  VNet in another group is identified separately. Additional server/resources
  can share the same enclosure without assigning their attributes to the cloud.
- Cloud and instance metadata are allowlisted from cached local deployment
  records; selecting nodes never contacts a cloud provider or reads credentials.
  Runtime network IDs take precedence over configured fallbacks. CIDRs are
  available for locally managed networks; missing values remain absent. Cache
  timestamps do not imply live provider health. Unmanaged hosting remains unknown.
- Every reported operator has a separate presence node, including offline
  operators. The local client remains distinct because a matching display name
  does not establish roster identity. Presence edges are associations, not
  traffic measurements or target ownership.
- External builders and crackstations have distinct service nodes and icons.
  Builders use their unique registered name; crackstations use their host UUID,
  so identical display names remain separate. Their server associations are
  relationships, not measured traffic or job activity. Presence means registered
  for a builder and connected for a crackstation. Neither service exposes target
  actions. The inspector contains only identity, platform, reported operator,
  and optional station version metadata.
- Service inventories come from the passive `Builders` and `Crackstations`
  registry RPCs, with a 500-record limit per type. They refresh with full inventory,
  periodic reconciliation, reconnects, and relevant presence events. Builder
  registration has no dedicated event, so periodic refresh remains necessary.
  Successful refreshes remove absent services; failures preserve last-known
  records without failing otherwise successful core inventory reads. No build,
  crack, benchmark, or registration operation is initiated by Overview.
- Session routes use the server's passive pivot graph when available. Exact
  parent/child peers become edges, including nested relays and branches. Peers
  missing a current session record remain visible as non-actionable relay
  placeholders. The client does not infer hops from transport or address text.
  Beacon routes and sessions absent from the pivot inventory retain explicitly
  labeled logical relationships to the server; their intermediate hops remain
  unknown. Listener inventory remains server metadata.
- Pivot inventory refreshes with full inventory and background session updates,
  and is bounded to 500 entries. An optional route refresh failure does not fail
  otherwise successful session inventory reads. The
  renderer and normalizer have no fixed hop count; transport decoding limits
  still apply. A truncated graph reports partial inventory, and failed refreshes retain
  last-known routes. Malformed graphs are rejected rather than guessed. Reading
  this inventory never creates, changes, or removes a pivot.
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
projection preserves the complete upstream communication path and parent
enclosures while filtering, with cycle-safe traversal. Other associations retain
one hop of context.
Large homogeneous leaf collections collapse into summaries, with their
individual records available on expansion. Intermediate relays and branching
nodes stay explicit. Unknown kinds retain a generic card
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

The event client reports `connecting` until its first event arrives, even on a
quiet connection. Overview labels this as awaiting events and keeps successfully
refreshed inventory current. A stopped or retrying stream still produces a
warning and marks relationships as last known.
The notice area appears only for warnings; informational notices stay in the
topology document without displaying a banner.

## Validation

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run test:e2e:overview`
- `npm run test:e2e:protocol`

The Overview Electron tests use synthetic unmanaged, AWS, and Azure records,
the actual bundled ELK worker, and the production CSP. It exercises graph/list
switching, filters, inspection, layout controls, and both interaction navigation
paths for sessions and beacons. It checks that no target
commands or cloud actions occur. Screenshots are written to
`artifacts/overview-e2e/`. The protocol test also verifies a same-origin module
worker and its static import from an ASAR archive.
AWS/Azure inspector checks assert that cloud/network metadata and instance
metadata appear on their respective nodes, while preserving cloud containment.

The separate topology journey supplies three operators and a branched five-hop
route with a sessionless relay, plus two builders and two crackstations sharing
a display name. It checks service identity, inspector metadata, type filters,
list rendering, the rendered parent edges, complete
upstream context when filtering the deepest session, and the existing session
menu. It audits fixture calls to ensure only passive inventory is read.
