import type { DomainCollection, SliverSnapshot } from "../../../shared/contracts";
import type { TargetSummary } from "../../../shared/target-contracts";
import { TOPOLOGY_SCHEMA_VERSION } from "../../../shared/topology-contracts";
import { operatorTopologyContributor } from "./operator-topology";
import { createPivotTopology } from "./pivot-topology";
import { serviceTopologyContributor } from "./service-topology";
import type {
  TopologyDocument,
  TopologyEdge,
  TopologyFreshness,
  TopologyNode,
  TopologyNotice,
  TopologyProperty,
  TopologyStatus,
} from "../../../shared/topology-contracts";

export interface TopologyContribution {
  readonly nodes?: readonly TopologyNode[];
  readonly edges?: readonly TopologyEdge[];
  readonly notices?: readonly TopologyNotice[];
}

export interface TopologyContext {
  readonly snapshot: SliverSnapshot;
  readonly scopeId: string;
  readonly connected: boolean;
  readonly hasServer: boolean;
  readonly ids: { readonly client: string; readonly server: string; readonly cloud: string };
}

/** Pure adapters can add new resource types without changing graph rendering. */
export type TopologyContributor = (context: TopologyContext) => TopologyContribution;

export interface OverviewTopologyOptions {
  /** Defaults to DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS; append to extend them. */
  readonly contributors?: readonly TopologyContributor[];
}

function scopedId(scopeId: string, kind: string, id: string): string {
  return `${scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

export function overviewTopologyScopeId(snapshot: SliverSnapshot): string {
  const { connection } = snapshot;
  if (!connection.server && !connection.configName && !connection.managedServer) return "disconnected";
  return `connection:${encodeURIComponent(JSON.stringify([
    connection.server ?? "",
    connection.configName ?? "",
    connection.managedServer?.deploymentId ?? "",
  ]))}`;
}

function isConnected(snapshot: SliverSnapshot): boolean {
  return snapshot.connection.status === "connected" || snapshot.connection.status === "degraded";
}

function domainFreshness(context: TopologyContext, domain: DomainCollection<unknown>): TopologyFreshness {
  const eventStatus = context.snapshot.eventStream.status;
  // The client remains "connecting" until the first event arrives. A quiet
  // initial stream does not invalidate successfully refreshed inventory.
  if (!context.connected || eventStatus === "retrying" || eventStatus === "stopped") return "stale";
  if (domain.status === "ready" || domain.status === "empty") return "current";
  return domain.items.length > 0 || domain.updatedAt ? "stale" : "unknown";
}

function property(label: string, value: string | number | boolean | null | undefined): TopologyProperty[] {
  return value === undefined || value === "" || value === null ? [] : [{ label, value }];
}

function titleCase(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1).replaceAll("-", " ") : "Unknown";
}

function providerName(provider: string): string {
  return provider === "aws" ? "AWS" : provider === "azure" ? "Azure" : titleCase(provider);
}

function osIcon(os: string): string {
  if (os.toLowerCase().startsWith("windows")) return "windows";
  if (os.toLowerCase() === "linux") return "linux";
  if (["darwin", "macos", "ios"].includes(os.toLowerCase())) return "apple";
  return "computer";
}

function transportLabel(transport: string): string {
  if (transport === "mtls") return "mTLS";
  if (transport === "wg") return "WireGuard";
  if (transport === "namedpipe") return "Named pipe";
  if (transport === "tcppivot") return "TCP pivot";
  return transport === "unknown" ? "Unknown transport" : transport.toUpperCase();
}

function inventoryNotices(context: TopologyContext, name: string, domain: DomainCollection<unknown>): TopologyNotice[] {
  const notices: TopologyNotice[] = [];
  if (domain.page.truncated || domain.items.length < domain.page.total) {
    notices.push({
      id: `${name}:partial`, severity: "info",
      message: `Showing ${domain.items.length} of ${domain.page.total} ${name}; this inventory is partial.`,
    });
  }
  if (domain.status === "error") {
    notices.push({ id: `${name}:error`, severity: "warning", message: `${titleCase(name)} could not be refreshed; any displayed records are last known.` });
  } else if (domain.status === "unsupported") {
    notices.push({ id: `${name}:unsupported`, severity: "info", message: `${titleCase(name)} are unavailable from this server.` });
  } else if (context.connected && (domain.status === "idle" || domain.status === "loading")) {
    notices.push({ id: `${name}:loading`, severity: "info", message: `${titleCase(name)} inventory is loading${domain.items.length ? "; displayed records are last known" : ""}.` });
  }
  return notices;
}

export const connectionTopologyContributor: TopologyContributor = (context) => {
  const { snapshot, connected, hasServer, ids } = context;
  const { connection } = snapshot;
  const managed = connection.managedServer;
  const nodes: TopologyNode[] = [{
    id: ids.client,
    kind: "client",
    role: "resource",
    label: "This client",
    subtitle: connection.operator ?? "Operator console",
    icon: "client",
    status: connected ? "healthy" : "inactive",
    statusLabel: connected ? "Connected" : titleCase(connection.status),
    freshness: "current",
    properties: [
      ...property("Operator", connection.operator),
      ...property("Configuration", connection.configName),
      { label: "Connection", value: titleCase(connection.status) },
    ],
  }];
  const edges: TopologyEdge[] = [];
  const notices: TopologyNotice[] = [];
  if (!hasServer) {
    notices.push({ id: "connection:empty", severity: "info", message: "Connect to a server to view its infrastructure." });
    return { nodes, edges, notices };
  }
  if (managed) {
    const summary = managed.overview;
    nodes.push({
      id: ids.cloud,
      kind: "cloud",
      role: "group",
      label: managed.name,
      subtitle: [providerName(managed.provider), summary?.region].filter(Boolean).join(" · "),
      icon: managed.provider,
      provider: managed.provider,
      status: "unknown",
      statusLabel: summary?.instanceState ? `Last known: ${summary.instanceState}` : "Managed deployment",
      // Cloud record updates are not a live provider-health observation.
      freshness: "unknown",
      properties: [
        { label: "Provider", value: providerName(managed.provider) },
        ...property("Region", summary?.region),
        ...property("Instance size", summary?.size),
        ...property("Instance state (cached)", summary?.instanceState),
        ...property("Instance health (cached)", summary?.health),
        ...property("Public IP", summary?.publicIpAddress),
        ...property("Private IP", summary?.privateIpAddress),
        ...property("Cloud metadata updated", summary?.updatedAt),
      ],
      resource: { kind: "cloud-deployment", id: managed.deploymentId },
    });
  }
  const jobs = snapshot.domains.jobs;
  const listenerFreshness = domainFreshness(context, jobs);
  nodes.push({
    id: ids.server,
    kind: "server",
    role: "resource",
    ...(managed ? { parentId: ids.cloud } : {}),
    label: connection.server ?? managed?.name ?? connection.configName ?? "Sliver server",
    subtitle: managed ? `${providerName(managed.provider)} · Managed server` : "Hosting unknown",
    icon: "server",
    status: connection.status === "connected" ? "healthy" : connection.status === "degraded" ? "warning" : "unknown",
    statusLabel: titleCase(connection.status),
    freshness: connected ? "current" : "stale",
    properties: [
      ...property("Server", connection.server),
      ...property("Server version", connection.version),
      { label: "Connectivity", value: titleCase(connection.status) },
      { label: "Hosting", value: managed ? `${providerName(managed.provider)} · ${managed.name}` : "Unknown" },
      { label: "Listener inventory", value: `${jobs.items.length} of ${jobs.page.total}${listenerFreshness !== "current" ? " · last known" : ""}` },
      ...jobs.items.map((job) => ({
        label: `Listener ${job.id}`,
        value: [job.name || job.protocol || "Unknown protocol", job.port > 0 ? `port ${job.port}` : "", job.domains.join(", ")].filter(Boolean).join(" · "),
      })),
    ],
    resource: { kind: "server", id: connection.server ?? managed?.deploymentId ?? connection.configName ?? "server" },
  });
  edges.push({
    id: scopedId(context.scopeId, "communication", "client-server"),
    kind: "operator-connection",
    role: "communication",
    source: ids.client,
    target: ids.server,
    label: "Operator",
    state: connected ? "live" : "unknown",
    freshness: connected ? "current" : "stale",
    description: "Operator connection to the selected server. Traffic volume and latency are not measured.",
    properties: [{ label: "Connection", value: titleCase(connection.status) }],
  });
  if (!connected) {
    notices.push({ id: "connection:stale", severity: "warning", message: "Server connection is unavailable. Displayed infrastructure is last known; remote state is not confirmed." });
  } else if (snapshot.eventStream.status === "connecting") {
    notices.push({ id: "events:pending", severity: "info", message: "Waiting for the first live event. Inventory continues to refresh periodically." });
  } else if (snapshot.eventStream.status !== "connected") {
    notices.push({ id: "events:stale", severity: "warning", message: "Live updates are unavailable. Target relationships are last known until the event stream reconnects." });
  }
  notices.push(...inventoryNotices(context, "listeners", jobs));
  return { nodes, edges, notices };
};

function targetStatus(target: TargetSummary, freshness: TopologyFreshness): { status: TopologyStatus; statusLabel: string } {
  const label = target.mode === "session" ? titleCase(target.liveness) : titleCase(target.checkinStatus);
  if (freshness !== "current") return { status: "unknown", statusLabel: `Last known: ${label.toLowerCase()}` };
  if (target.mode === "session") return { status: target.liveness === "active" ? "healthy" : "inactive", statusLabel: label };
  return { status: target.checkinStatus === "on-time" ? "healthy" : target.checkinStatus === "overdue" ? "warning" : "unknown", statusLabel: label };
}

export const targetTopologyContributor: TopologyContributor = (context) => {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const notices: TopologyNotice[] = [];
  if (!context.hasServer) return { nodes, edges, notices };
  const pivots = createPivotTopology(context);
  nodes.push(...pivots.nodes);
  edges.push(...pivots.edges);
  notices.push(...pivots.notices);
  const domains = [
    { name: "sessions", domain: context.snapshot.domains.sessions },
    { name: "beacons", domain: context.snapshot.domains.beacons },
  ] as const;
  for (const { name, domain } of domains) {
    const freshness = domainFreshness(context, domain);
    notices.push(...inventoryNotices(context, name, domain));
    for (const target of domain.items) {
      const id = scopedId(context.scopeId, target.mode, target.id);
      const transport = transportLabel(target.transport);
      nodes.push({
        id,
        kind: target.mode,
        role: "resource",
        label: target.hostname || target.name || target.id,
        subtitle: [titleCase(target.mode), target.os, target.arch].filter(Boolean).join(" · "),
        icon: osIcon(target.os),
        ...targetStatus(target, freshness),
        freshness,
        properties: [
          { label: "Type", value: titleCase(target.mode) },
          { label: "ID", value: target.id },
          ...property("Name", target.name),
          ...property("Hostname", target.hostname),
          ...property("OS", target.os),
          ...property("Architecture", target.arch),
          ...property("User", target.username),
          { label: "Transport", value: transport },
          ...property("Remote address", target.remoteAddress),
          ...property("Last check-in", target.lastCheckinAt),
          ...property("Inventory updated", domain.updatedAt),
          ...(target.mode === "beacon" ? property("Next expected check-in", target.nextCheckinAt) : []),
        ],
        resource: { kind: target.mode, id: target.id },
      });
      if (target.mode === "session" && pivots.mappedSessionIds.has(target.id)) continue;
      edges.push({
        id: scopedId(context.scopeId, "communication", `${target.mode}:${target.id}`),
        kind: "target-communication",
        role: "communication",
        source: context.ids.server,
        target: id,
        label: transport,
        state: freshness !== "current" ? "unknown" : target.mode === "beacon" ? "periodic" : target.liveness === "active" ? "live" : "inactive",
        freshness,
        transport: target.transport,
        ...(target.lastCheckinAt ? { activityAt: target.lastCheckinAt } : {}),
        description: "Reported logical communication relationship with the server. Intermediate hops and listener attribution are unknown; this is not a verified physical route.",
        properties: [
          { label: "Transport", value: transport },
          { label: "Relationship", value: "Reported by server" },
          ...property("Last check-in", target.lastCheckinAt),
          { label: "Traffic measurements", value: "Unavailable" },
        ],
      });
    }
  }
  return { nodes, edges, notices };
};

export const DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS: readonly TopologyContributor[] = [
  connectionTopologyContributor,
  operatorTopologyContributor,
  serviceTopologyContributor,
  targetTopologyContributor,
];

/** Validate extension boundaries before a graph library consumes the document. */
function validateReferences(nodes: readonly TopologyNode[], edges: readonly TopologyEdge[], notices: readonly TopologyNotice[]): void {
  const nodesById = new Map<string, TopologyNode>();
  for (const node of nodes) {
    if (nodesById.has(node.id)) throw new Error(`Duplicate topology node: ${node.id}`);
    nodesById.set(node.id, node);
  }
  for (const node of nodes) {
    const ancestors = new Set([node.id]);
    let parentId = node.parentId;
    while (parentId !== undefined) {
      if (ancestors.has(parentId)) throw new Error(`Cyclic topology containment: ${node.id}`);
      ancestors.add(parentId);
      const parent = nodesById.get(parentId);
      if (!parent || parent.role !== "group") throw new Error(`Invalid topology parent: ${parentId}`);
      parentId = parent.parentId;
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) throw new Error(`Duplicate topology edge: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) throw new Error(`Missing topology endpoint: ${edge.id}`);
  }
  if (new Set(notices.map(({ id }) => id)).size !== notices.length) throw new Error("Duplicate topology notice");
}

export function createOverviewTopology(snapshot: SliverSnapshot, options: OverviewTopologyOptions = {}): TopologyDocument {
  const scopeId = overviewTopologyScopeId(snapshot);
  const connected = isConnected(snapshot);
  const context: TopologyContext = {
    snapshot,
    scopeId,
    connected,
    hasServer: scopeId !== "disconnected",
    ids: {
      client: scopedId(scopeId, "client", "local"),
      server: scopedId(scopeId, "server", "current"),
      cloud: scopedId(scopeId, "cloud", snapshot.connection.managedServer?.deploymentId ?? "unknown"),
    },
  };
  const contributions = (options.contributors ?? DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS).map((contribute) => contribute(context));
  const nodes = contributions.flatMap((contribution) => contribution.nodes ?? []);
  const edges = contributions.flatMap((contribution) => contribution.edges ?? []);
  const notices = contributions.flatMap((contribution) => contribution.notices ?? []);
  validateReferences(nodes, edges, notices);
  return {
    schemaVersion: TOPOLOGY_SCHEMA_VERSION,
    scope: { id: scopeId, label: snapshot.connection.server ?? snapshot.connection.managedServer?.name ?? "No server connected", connected },
    updatedAt: snapshot.lastUpdated ?? null,
    nodes,
    edges,
    notices,
  };
}
