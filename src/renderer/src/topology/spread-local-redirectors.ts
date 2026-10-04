import type { LayoutNode } from "./topology-layout-input";

interface LayoutStructure {
  nodes: readonly { id: string; parentId?: string }[];
  edges: readonly { source: string; target: string; kind: string }[];
}

const CARD_GAP = 32;
const GROUP_BOTTOM_PADDING = 28;

/** Leave a clear lane from the server to session enclosures above local redirectors. */
export function spreadLocalRedirectors(layout: LayoutNode[], structure: LayoutStructure): LayoutNode[] {
  const redirects = structure.edges.filter((edge) => edge.kind === "server-redirector");
  if (!redirects.length) return layout;

  const positions = new Map(layout.map((node) => [node.id, { ...node }]));
  const parents = new Map(structure.nodes.map((node) => [node.id, node.parentId]));
  const absoluteY = (id: string): number => {
    const node = positions.get(id);
    if (!node) return 0;
    const parentId = parents.get(id);
    return node.y + (parentId ? absoluteY(parentId) : 0);
  };
  const groups = new Map<string, typeof redirects>();
  for (const edge of redirects) {
    const parentId = parents.get(edge.target);
    if (!parentId || !positions.has(parentId) || !positions.has(edge.source) || !positions.has(edge.target)) continue;
    const links = groups.get(parentId) ?? [];
    links.push(edge);
    groups.set(parentId, links);
  }

  for (const [parentId, links] of groups) {
    const parentTop = absoluteY(parentId);
    const redirectorIds = new Set(links.map((edge) => edge.target));
    const siblingBottom = structure.nodes
      .filter((node) => node.parentId === parentId && !redirectorIds.has(node.id))
      .reduce((bottom, node) => Math.max(bottom, (positions.get(node.id)?.y ?? 0) + (positions.get(node.id)?.height ?? 0)), 0);
    const laneBottom = links.reduce((bottom, link) => {
      const server = positions.get(link.source)!;
      const sourceCenter = absoluteY(link.source) + server.height / 2;
      const egressCenters = structure.edges
        .filter((edge) => edge.kind === "egress-connection" && edge.source === link.source)
        .map((edge) => positions.get(edge.target))
        .filter((node): node is LayoutNode => node !== undefined)
        .map((node) => absoluteY(node.id) + node.height / 2);
      return Math.max(bottom, sourceCenter - parentTop, ...egressCenters.map((center) => center - parentTop));
    }, 0);
    let nextTop = Math.max(siblingBottom, laneBottom) + CARD_GAP;
    for (const id of [...redirectorIds].sort((left, right) => {
      const a = positions.get(left)!;
      const b = positions.get(right)!;
      return a.y - b.y || left.localeCompare(right);
    })) {
      const node = positions.get(id)!;
      node.y = Math.max(node.y, nextTop);
      nextTop = node.y + node.height + CARD_GAP;
    }
  }

  // Moving a child may enlarge its cloud, and a nested cloud can in turn
  // enlarge its parent. Preserve ELK's existing size whenever it is enough.
  const depth = (id: string): number => {
    const parentId = parents.get(id);
    return parentId ? 1 + depth(parentId) : 0;
  };
  for (const node of [...positions.values()].sort((a, b) => depth(b.id) - depth(a.id))) {
    const parentId = parents.get(node.id);
    const parent = parentId ? positions.get(parentId) : undefined;
    if (parent) parent.height = Math.max(parent.height, node.y + node.height + GROUP_BOTTOM_PADDING);
  }
  return layout.map((node) => positions.get(node.id)!);
}
