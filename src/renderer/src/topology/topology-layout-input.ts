import type { TopologyDocument } from "../../../shared/topology-contracts";
import type { ElkNode } from "elkjs/lib/elk-api.js";

export interface LayoutNode {
  id: string;
  /** Position relative to the enclosing group, or the canvas for root nodes. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Workers receive geometry and identity only; display metadata stays in the UI. */
export interface TopologyLayoutInput {
  nodes: { id: string; role: string; parentId?: string }[];
  edges: { id: string; source: string; target: string; labelWidth?: number }[];
}

/** Kept separate from the ELK module to avoid importing ELK on the UI thread. */
export function topologyLayoutInput(document: TopologyDocument): TopologyLayoutInput {
  return {
    nodes: document.nodes.map(({ id, role, parentId }) => ({ id, role, ...(parentId ? { parentId } : {}) })),
    edges: document.edges.filter((edge) => edge.role !== "containment")
      .map(({ id, source, target, kind, label }) => ({ id, source, target,
        // Reserve room for labels placed between resource cards without
        // sending display text to the worker. Seven pixels per glyph is
        // conservative at our 10px font.
        ...(["egress-connection", "server-redirector"].includes(kind) ? { labelWidth: Array.from(label).length * 7 + 14 } : {}),
      })),
  };
}

/** Construct hierarchy geometry without importing the ELK layout engine. */
export function createElkGraph(input: TopologyLayoutInput): ElkNode {
  const betweenLayers = String(Math.max(100, ...input.edges.map((edge) => (edge.labelWidth ?? 0) + 48)));
  const nodes = new Map<string, ElkNode>(input.nodes.map((node) => [node.id, {
    id: node.id,
    ...(node.role === "group"
      ? { children: [], width: 292, height: 228, layoutOptions: {
        "elk.padding": "[top=88,left=28,bottom=28,right=28]",
        "elk.layered.spacing.nodeNodeBetweenLayers": betweenLayers,
      } }
      : { width: 236, height: 112 }),
  }]));
  const children: ElkNode[] = [];
  for (const node of input.nodes) {
    const item = nodes.get(node.id)!;
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent?.children) parent.children.push(item);
    else children.push(item);
  }
  return {
    id: "topology-root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.spacing.nodeNode": "32",
      "elk.layered.spacing.nodeNodeBetweenLayers": betweenLayers,
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": "[top=32,left=32,bottom=32,right=32]",
    },
    children,
    edges: input.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  };
}

/** ELK child coordinates remain relative to their parent for React Flow. */
export function extractTopologyLayout(graph: ElkNode): LayoutNode[] {
  const result: LayoutNode[] = [];
  const visit = (node: ElkNode): void => {
    if (node.id !== graph.id) result.push({
      id: node.id, x: node.x ?? 0, y: node.y ?? 0, width: node.width ?? 236, height: node.height ?? 112,
    });
    node.children?.forEach(visit);
  };
  visit(graph);
  return result;
}
