import type { PivotTopologyEntry, TopologyEdge, TopologyFreshness, TopologyNode, TopologyNotice, TopologyProperty } from "../../../shared/topology-contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import type { TopologyContext } from "./overview-topology";

export interface PivotTopologyContribution {
  readonly nodes: TopologyNode[];
  readonly edges: TopologyEdge[];
  readonly notices: TopologyNotice[];
  readonly mappedSessionIds: ReadonlySet<string>;
}

function scopedId(context: TopologyContext, kind: string, id: string): string {
  return `${context.scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

/** Reject ambiguous hierarchies instead of reconnecting orphaned peers to the server. */
function hasValidHierarchy(entries: readonly PivotTopologyEntry[]): boolean {
  if (entries.length > 500) return false;
  const peers = new Map<string, PivotTopologyEntry>();
  const sessions = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.peerId !== "string" || !entry.peerId || peers.has(entry.peerId)
      || (entry.parentPeerId !== null && (typeof entry.parentPeerId !== "string" || !entry.parentPeerId))) return false;
    if (entry.sessionId !== undefined) {
      if (typeof entry.sessionId !== "string" || !entry.sessionId || sessions.has(entry.sessionId)) return false;
      sessions.add(entry.sessionId);
    }
    peers.set(entry.peerId, entry);
  }
  const visited = new Set<string>();
  for (const entry of entries) {
    const path = new Set<string>();
    let peerId: string | null = entry.peerId;
    while (peerId !== null && !visited.has(peerId)) {
      if (path.has(peerId)) return false;
      const peer = peers.get(peerId);
      if (!peer) return false;
      path.add(peerId);
      peerId = peer.parentPeerId;
    }
    for (const id of path) visited.add(id);
  }
  return true;
}

function freshness(context: TopologyContext): TopologyFreshness {
  const { pivotTopology, eventStream, domains } = context.snapshot;
  const graphReady = pivotTopology?.status === "ready" || pivotTopology?.status === "empty";
  const sessionsReady = domains.sessions.status === "ready" || domains.sessions.status === "empty";
  return context.connected && (eventStream.status === "connected" || eventStream.status === "connecting")
    && graphReady && sessionsReady ? "current" : "stale";
}

function transportLabel(transport: SessionSummary["transport"] | undefined): string {
  if (!transport || transport === "unknown") return "Reported hop";
  if (transport === "mtls") return "mTLS";
  if (transport === "wg") return "WireGuard";
  if (transport === "namedpipe") return "Named pipe";
  if (transport === "tcppivot") return "TCP pivot";
  return transport.toUpperCase();
}

/** Adapt only passive, explicit parent relationships; embedded references grant no action authority. */
export function createPivotTopology(context: TopologyContext): PivotTopologyContribution {
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const notices: TopologyNotice[] = [];
  const mappedSessionIds = new Set<string>();
  const result = { nodes, edges, notices, mappedSessionIds };
  const graph = context.snapshot.pivotTopology;
  if (!context.hasServer || !graph) return result;
  if (graph.status === "error") {
    notices.push({ id: "pivot-topology:error", severity: "warning", message: "Reported routes could not be refreshed; any displayed hops are last known." });
  } else if (graph.status === "unsupported") {
    notices.push({ id: "pivot-topology:unsupported", severity: "info", message: "Reported routes are unavailable from this server; connections show logical server relationships." });
    return result;
  } else if (context.connected && (graph.status === "idle" || graph.status === "loading")) {
    notices.push({ id: "pivot-topology:loading", severity: "info", message: `Reported routes are loading${graph.entries.length ? "; displayed hops are last known" : ""}.` });
  }
  if (graph.truncated) {
    notices.push({ id: "pivot-topology:truncated", severity: "warning", message: "Reported routes are partial; additional hops may be missing from this view." });
  }
  if (!hasValidHierarchy(graph.entries)) {
    notices.push({ id: "pivot-topology:invalid", severity: "warning", message: "Reported routes contain ambiguous or missing links; connections show logical server relationships." });
    return result;
  }
  const currentFreshness = freshness(context);
  const sessions = new Map(context.snapshot.domains.sessions.items.map((session) => [session.id, session]));
  const peerNodeIds = new Map<string, string>();
  for (const peer of graph.entries) {
    const session = peer.sessionId ? sessions.get(peer.sessionId) : undefined;
    if (session) {
      peerNodeIds.set(peer.peerId, scopedId(context, "session", session.id));
      mappedSessionIds.add(session.id);
    } else {
      const id = scopedId(context, "relay", peer.peerId);
      peerNodeIds.set(peer.peerId, id);
      nodes.push({
        id,
        kind: "relay",
        role: "resource",
        label: peer.name || `Relay ${peer.peerId}`,
        subtitle: "Reported relay",
        icon: "relay",
        status: "unknown",
        statusLabel: currentFreshness === "current" ? "Reported relay" : "Last known relay",
        freshness: currentFreshness,
        properties: [
          { label: "Peer ID", value: peer.peerId },
          ...(peer.sessionId ? [{ label: "Session ID", value: peer.sessionId }] : []),
          ...(graph.updatedAt ? [{ label: "Topology updated", value: graph.updatedAt }] : []),
        ],
      });
    }
  }
  for (const peer of graph.entries) {
    const session = peer.sessionId ? sessions.get(peer.sessionId) : undefined;
    const transport = session?.transport !== "unknown" ? session?.transport : undefined;
    const properties: TopologyProperty[] = [
      { label: "Peer ID", value: peer.peerId },
      { label: "Parent peer ID", value: peer.parentPeerId },
      ...(peer.sessionId ? [{ label: "Session ID", value: peer.sessionId }] : []),
      ...(graph.updatedAt ? [{ label: "Topology updated", value: graph.updatedAt }] : []),
    ];
    edges.push({
      id: scopedId(context, "pivot-hop", peer.peerId),
      kind: "pivot-hop",
      role: "communication",
      source: peer.parentPeerId === null ? context.ids.server : peerNodeIds.get(peer.parentPeerId)!,
      target: peerNodeIds.get(peer.peerId)!,
      label: transportLabel(transport),
      state: currentFreshness !== "current" || !session ? "unknown" : session.liveness === "active" ? "live" : "inactive",
      freshness: currentFreshness,
      ...(transport ? { transport } : {}),
      description: "Exact parent hop reported by the server. Session status describes the child; traffic rate and listener attribution are not reported.",
      properties,
    });
  }
  return result;
}
