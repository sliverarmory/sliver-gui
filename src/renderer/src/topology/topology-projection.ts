import type { TopologyDocument, TopologyEdge, TopologyFreshness, TopologyNode, TopologyStatus } from "../../../shared/topology-contracts";
import { groupEgressTopology } from "./egress-topology";

export const TOPOLOGY_COLLECTION_THRESHOLD = 12;
export const OFFLINE_OPERATOR_FILTER_KIND = "operator-offline";

export type TopologyFilterSelection = "all" | ReadonlySet<string>;

export interface TopologyFilters {
  query: string;
  /** Default includes newly observed types but hides offline operators. */
  kinds: TopologyFilterSelection | "default";
  statuses: TopologyFilterSelection;
  expanded: ReadonlySet<string>;
}

function aggregateFreshness(items: readonly { freshness: TopologyFreshness }[]): TopologyFreshness {
  if (items.every((item) => item.freshness === "current")) return "current";
  return items.some((item) => item.freshness === "stale") ? "stale" : "unknown";
}

function aggregateStatus(members: readonly TopologyNode[]): TopologyStatus {
  if (members.some((node) => node.status === "warning")) return "warning";
  if (members.every((node) => node.status === "healthy")) return "healthy";
  if (members.every((node) => node.status === "inactive")) return "inactive";
  return "unknown";
}

/** View-only projection: never mutates source identities or invents routes. */
export function projectTopology(source: TopologyDocument, filters: TopologyFilters): {
  document: TopologyDocument;
  groups: ReadonlyMap<string, readonly TopologyNode[]>;
  matchCount: number;
} {
  const query = filters.query.trim().toLocaleLowerCase();
  const byId = new Map(source.nodes.map((node) => [node.id, node]));
  // Categorical selections are a hard visibility boundary. Search context can
  // only add nodes that satisfy both selected dimensions.
  const permitted = source.nodes.filter((node) => {
    const kind = node.filterKind ?? node.kind;
    const selectedKind = filters.kinds === "default" ? kind !== OFFLINE_OPERATOR_FILTER_KIND
      : filters.kinds === "all" || filters.kinds.has(kind);
    return selectedKind && (filters.statuses === "all" || filters.statuses.has(node.status));
  });
  const permittedIds = new Set(permitted.map((node) => node.id));
  const unresolved = new Set<string>();
  const communicationSources = new Set<string>();
  const incomingCommunication = new Map<string, string[]>();
  const knownEdges = source.edges.filter((edge) => {
    if (edge.role === "communication") communicationSources.add(edge.source);
    if (!byId.has(edge.source) || !byId.has(edge.target)) {
      unresolved.add(edge.source);
      unresolved.add(edge.target);
      return false;
    }
    if (!permittedIds.has(edge.source) || !permittedIds.has(edge.target)) return false;
    if (edge.role === "communication") {
      const upstream = incomingCommunication.get(edge.target) ?? [];
      upstream.push(edge.source);
      incomingCommunication.set(edge.target, upstream);
    }
    return true;
  });
  const filtering = Boolean(query || (filters.kinds !== "all" && filters.kinds !== "default") || filters.statuses !== "all");
  const matches = permitted.filter((node) =>
    !query || [node.label, node.subtitle, node.kind, node.provider,
      ...node.properties.map((property) => `${property.label} ${property.value ?? ""}`)]
      .join(" ").toLocaleLowerCase().includes(query));
  const matchedIds = new Set(matches.map((node) => node.id));
  const included = new Set(matches.map((node) => node.id));
  // Matching an enclosure retains its contents, but those contents do not
  // become new filter matches or recursively pull in unrelated neighbors.
  if (filtering) for (const node of permitted) {
    let parent = node.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      if (matchedIds.has(parent)) { included.add(node.id); break; }
      parent = byId.get(parent)?.parentId;
    }
  }
  if (filtering) {
    // Keep immediate neighbors, then every reported upstream communication
    // path to an actual match. Context nodes do not expand unrelated branches.
    for (const edge of knownEdges) {
      if (matchedIds.has(edge.source) || matchedIds.has(edge.target)) {
        included.add(edge.source);
        included.add(edge.target);
      }
    }
    const visited = new Set(matchedIds);
    const pending = [...matchedIds];
    for (let index = 0; index < pending.length; index += 1) {
      for (const upstream of incomingCommunication.get(pending[index]!) ?? []) {
        included.add(upstream);
        if (visited.has(upstream)) continue;
        visited.add(upstream);
        pending.push(upstream);
      }
    }
  }
  // Preserve visual enclosures for the complete path without inventing
  // containment or bridging a missing node in a partial document.
  for (const id of [...included]) {
    let parent = byId.get(id)?.parentId;
    const seen = new Set<string>();
    while (parent && byId.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      if (permittedIds.has(parent)) included.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }
  const nodes = source.nodes.filter((node) => included.has(node.id)).map((node) => {
    if (!node.parentId || included.has(node.parentId)) return node;
    const standalone = { ...node };
    delete standalone.parentId;
    return standalone;
  });
  const edges = knownEdges.filter((edge) => included.has(edge.source) && included.has(edge.target));
  const groups = new Map<string, readonly TopologyNode[]>();
  if (filtering) return { document: groupEgressTopology({ ...source, nodes, edges }, source, groups), groups, matchCount: matches.length };

  const buckets = new Map<string, TopologyNode[]>();
  const linksByNode = new Map<string, TopologyEdge[]>();
  for (const edge of edges) {
    for (const id of new Set([edge.source, edge.target])) {
      const links = linksByNode.get(id) ?? [];
      links.push(edge);
      linksByNode.set(id, links);
    }
  }
  const parents = new Set(nodes.map((node) => node.parentId));
  for (const node of nodes) {
    // Only terminal communication targets can form a leaf collection. Keep
    // roots, relays, and resources with unresolved links explicit, even when
    // the currently visible inventory leaves them with a single known edge.
    if (node.role === "group" || parents.has(node.id) || communicationSources.has(node.id) || unresolved.has(node.id)) continue;
    const links = linksByNode.get(node.id) ?? [];
    if (links.length !== 1) continue;
    const edge = links[0]!;
    const peer = edge.source === node.id ? edge.target : edge.source;
    const direction = edge.source === node.id ? "outgoing" : "incoming";
    const id = `collection:${JSON.stringify([node.kind, node.icon, node.provider, node.parentId, node.egressIp, peer, direction, edge.role, edge.kind, edge.transport, edge.label])}`;
    const bucket = buckets.get(id) ?? [];
    bucket.push(node);
    buckets.set(id, bucket);
  }
  const replacements = new Map<string, string>();
  const aggregates: TopologyNode[] = [];
  for (const [id, members] of buckets) {
    if (members.length <= TOPOLOGY_COLLECTION_THRESHOLD || filters.expanded.has(id)) continue;
    groups.set(id, members);
    members.forEach((node) => replacements.set(node.id, id));
    const first = members[0]!;
    const warnings = members.filter((node) => node.status === "warning").length;
    aggregates.push({
      id, kind: first.kind, role: "resource", icon: first.icon,
      ...(first.parentId ? { parentId: first.parentId } : {}),
      ...(first.egressIp ? { egressIp: first.egressIp } : {}),
      label: `${members.length} ${first.kind === "beacon" ? "beacons" : first.kind === "session" ? "sessions" : "resources"}`,
      subtitle: "Select to expand this collection",
      status: aggregateStatus(members),
      statusLabel: warnings ? `${warnings} need attention` : "Grouped resources",
      freshness: aggregateFreshness(members),
      properties: [
        { label: "Resources", value: members.length }, { label: "Kind", value: first.kind },
        { label: "Healthy", value: members.filter((node) => node.status === "healthy").length },
        { label: "Warning", value: warnings },
        { label: "Inactive", value: members.filter((node) => node.status === "inactive").length },
        { label: "Unknown", value: members.filter((node) => node.status === "unknown").length },
      ],
    });
  }
  const projectedEdges = new Map<string, TopologyEdge>();
  const aggregateMembers = new Map<string, TopologyEdge[]>();
  for (const edge of edges) {
    const sourceId = replacements.get(edge.source) ?? edge.source;
    const targetId = replacements.get(edge.target) ?? edge.target;
    const grouped = sourceId !== edge.source || targetId !== edge.target;
    if (!grouped) { projectedEdges.set(edge.id, edge); continue; }
    const id = `collection-edge:${JSON.stringify([sourceId, targetId, edge.role, edge.kind, edge.transport])}`;
    const members = aggregateMembers.get(id) ?? [];
    members.push(edge);
    aggregateMembers.set(id, members);
    projectedEdges.set(id, {
      id, source: sourceId, target: targetId, kind: edge.kind, role: edge.role,
      label: edge.label,
      ...(edge.transport ? { transport: edge.transport } : {}),
      state: members.every((item) => item.state === members[0]!.state) ? members[0]!.state : "unknown",
      freshness: aggregateFreshness(members),
      description: `Grouped ${edge.role === "communication" ? "reported communication links" : "resource relationships"}. Expand the collection to inspect each link.`,
      properties: [
        { label: "Relationship", value: edge.role === "communication" ? "Grouped communication" : "Grouped association" },
        { label: "Links", value: members.length },
      ],
    });
  }
  return {
    document: groupEgressTopology({ ...source, nodes: [...nodes.filter((node) => !replacements.has(node.id)), ...aggregates], edges: [...projectedEdges.values()] }, source, groups),
    groups, matchCount: matches.length,
  };
}
