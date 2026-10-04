import type { TopologyDocument, TopologyEdge, TopologyFreshness, TopologyNode } from "../../../shared/topology-contracts";

function freshness(items: readonly { freshness: TopologyFreshness }[]): TopologyFreshness {
  if (items.every((item) => item.freshness === "current")) return "current";
  return items.some((item) => item.freshness === "stale") ? "stale" : "unknown";
}

/** Bundle the visible server relationships by reported IP, without inventing a hop. */
export function groupEgressTopology(
  document: TopologyDocument,
  source: TopologyDocument,
  collections: ReadonlyMap<string, readonly TopologyNode[]>,
): TopologyDocument {
  const sourceNodes = new Map(source.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, TopologyEdge[]>();
  for (const edge of source.edges) {
    if (edge.role !== "communication") continue;
    const links = incoming.get(edge.target) ?? [];
    links.push(edge);
    incoming.set(edge.target, links);
  }
  const isServerTarget = (node: TopologyNode): boolean => {
    const links = incoming.get(node.id) ?? [];
    return links.length > 0 && links.every((edge) => sourceNodes.get(edge.source)?.kind === "server");
  };
  const buckets = new Map<string, TopologyNode[]>();
  for (const node of document.nodes) {
    if (!node.egressIp || node.parentId || (node.kind !== "session" && node.kind !== "beacon")) continue;
    // Reported relay children retain their exact paths and containment. An IP
    // shared with a direct target is not evidence of a common upstream route.
    if (!(collections.get(node.id) ?? [node]).every(isServerTarget)) continue;
    const members = buckets.get(node.egressIp) ?? [];
    members.push(node);
    buckets.set(node.egressIp, members);
  }
  if (!buckets.size) return document;

  const parents = new Map<string, string>();
  const enclosures: TopologyNode[] = [];
  for (const [ip, members] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
    const id = `${source.scope.id}/egress/${encodeURIComponent(ip)}`;
    const resources = members.flatMap((node) => collections.get(node.id) ?? [node]);
    members.forEach((node) => parents.set(node.id, id));
    const currentFreshness = freshness(resources);
    enclosures.push({
      id, kind: "egress", role: "group", label: ip, icon: "egress", egressIp: ip,
      subtitle: `Egress IP · ${resources.length} ${resources.length === 1 ? "node" : "nodes"}`,
      status: currentFreshness !== "current" ? "unknown"
        : resources.some((node) => node.status === "warning") ? "warning"
        : resources.every((node) => node.status === "healthy") ? "healthy"
        : resources.every((node) => node.status === "inactive") ? "inactive" : "unknown",
      statusLabel: currentFreshness === "current" ? "Reported address" : "Last known address",
      freshness: currentFreshness,
      properties: [
        { label: "Egress IP", value: ip },
        { label: "Nodes", value: resources.length },
        { label: "Grouping", value: "Shared reported remote IP; this is not a verified gateway or physical route." },
      ],
    });
  }

  const edges: TopologyEdge[] = [];
  const bundles = new Map<string, TopologyEdge[]>();
  for (const edge of document.edges) {
    const parent = parents.get(edge.target);
    if (!parent || edge.role !== "communication" || sourceNodes.get(edge.source)?.kind !== "server") {
      edges.push(edge);
      continue;
    }
    const id = `${source.scope.id}/egress-connection/${encodeURIComponent(JSON.stringify([edge.source, parent]))}`;
    const members = bundles.get(id) ?? [];
    members.push(edge);
    bundles.set(id, members);
  }
  const visibleNodes = new Map(document.nodes.map((node) => [node.id, node]));
  for (const [id, members] of [...bundles].sort(([left], [right]) => left.localeCompare(right))) {
    const first = members[0]!;
    const target = parents.get(first.target)!;
    const ip = visibleNodes.get(first.target)!.egressIp!;
    const transports = [...new Set(members.map((edge) => edge.label))].sort().join(" / ");
    const resources = members.flatMap((edge) => collections.get(edge.target) ?? [visibleNodes.get(edge.target)!]);
    const currentFreshness = freshness(members);
    const activityAt = members.map((edge) => edge.activityAt)
      .filter((value): value is string => value !== undefined && Number.isFinite(Date.parse(value)))
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
    edges.push({
      id, kind: "egress-connection", role: "communication", source: first.source, target,
      label: `${ip} · ${transports}`,
      state: currentFreshness === "current" && members.every((edge) => edge.state === first.state) ? first.state : "unknown",
      freshness: currentFreshness,
      ...(activityAt ? { activityAt } : {}),
      ...(members.every((edge) => edge.transport === first.transport) && first.transport ? { transport: first.transport } : {}),
      description: "Reported server connections grouped by remote IP. Individual nodes retain their identities; sharing an IP does not establish a gateway or physical route.",
      properties: [
        { label: "Egress IP", value: ip },
        { label: "Connections", value: resources.length },
        { label: "Transports", value: transports },
        ...resources.sort((left, right) => left.id.localeCompare(right.id)).map((node) => ({ label: `${node.kind === "beacon" ? "Beacon" : "Session"} · ${node.label}`, value: node.resource?.id ?? node.id })),
      ],
    });
  }
  return {
    ...document,
    nodes: [...enclosures, ...document.nodes.map((node) => parents.has(node.id) ? { ...node, parentId: parents.get(node.id)! } : node)],
    edges,
  };
}
