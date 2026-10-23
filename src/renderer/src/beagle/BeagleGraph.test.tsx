import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import type { Edge, Node, ReactFlowProps } from "@xyflow/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeagleEdge, BeagleNode, BeagleQueryResult } from "../../../shared/beagle-contracts";
import { BeagleGraph } from "./BeagleGraph";
import type { BeagleSelection } from "./beagle-model";

type DirectoryNode = Node<{ entity: BeagleNode }, "directory">;
type DirectoryEdge = Edge<{ relationship: BeagleEdge; parallelIndex: number }, "relationship">;
const mock = vi.hoisted(() => ({ props: null as ReactFlowProps<DirectoryNode, DirectoryEdge> | null,
  flow: { fitView: vi.fn(async () => true), zoomIn: vi.fn(), zoomOut: vi.fn() } }));
vi.mock("@xyflow/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@xyflow/react")>();
  return { ...original, ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    ReactFlow: (props: ReactFlowProps<DirectoryNode, DirectoryEdge>) => { mock.props = props; return <div>Flow canvas</div>; },
    useReactFlow: () => mock.flow, useNodesInitialized: () => false };
});
vi.mock("elkjs/lib/elk-api.js", () => ({ default: class {
  async layout(graph: { children: { id: string }[] }) { return { children: graph.children.map((node, index) => ({ ...node, x: index * 300, y: 0 })) }; }
  terminateWorker() {}
} }));
afterEach(() => { cleanup(); mock.props = null; vi.clearAllMocks(); });

const node: BeagleNode = { objectid: 'S-1-5-21-a ["quoted"]', labels: ["Base", "User"], properties: { name: "ARYA" } };
const edge: BeagleEdge = { id: '["source","MemberOf","target"]', source: node.objectid, target: node.objectid, kind: "MemberOf", properties: {}, derived: true };
const result: BeagleQueryResult = { projectId: "project", graph: { nodes: [node], edges: [edge] }, rows: [], columns: [], totalRows: 0, elapsedMs: 1, truncated: false, limits: { rows: 5000, nodes: 1500, edges: 3000 } };

describe("BeagleGraph", () => {
  it("keeps selector-safe display IDs separate from domain identities and directed relationships", async () => {
    render(<BeagleGraph result={result} selection={null} onSelect={() => undefined} />);
    await waitFor(() => expect(mock.props?.nodes).toHaveLength(1));
    expect(mock.props?.nodes?.[0]?.id).toBe(encodeURIComponent(node.objectid));
    expect(mock.props?.nodes?.[0]?.data.entity.objectid).toBe(node.objectid);
    expect(mock.props?.edges?.[0]).toMatchObject({ source: encodeURIComponent(node.objectid), target: encodeURIComponent(node.objectid), markerEnd: { type: "arrowclosed" } });
    expect(mock.props?.nodesConnectable).toBe(false);
    expect(mock.props?.deleteKeyCode).toBeNull();
  });
  it("routes keyboard selection changes to the inspector and protects newer edge selection", async () => {
    const select = vi.fn();
    function Harness() {
      const [selection, setSelection] = useState<BeagleSelection>(null);
      return <BeagleGraph result={result} selection={selection} onSelect={(value) => { select(value); setSelection(value); }} />;
    }
    render(<Harness />);
    await waitFor(() => expect(mock.props?.nodes).toHaveLength(1));
    act(() => mock.props?.onNodesChange?.([{ type: "select", id: encodeURIComponent(node.objectid), selected: true }]));
    expect(select).toHaveBeenLastCalledWith({ kind: "node", id: node.objectid });
    act(() => {
      mock.props?.onEdgesChange?.([{ type: "select", id: encodeURIComponent(edge.id), selected: true }]);
      mock.props?.onNodesChange?.([{ type: "select", id: encodeURIComponent(node.objectid), selected: false }]);
    });
    expect(select).toHaveBeenLastCalledWith({ kind: "edge", id: edge.id });
    act(() => mock.props?.onEdgesChange?.([{ type: "select", id: encodeURIComponent(edge.id), selected: false }]));
    expect(select).toHaveBeenLastCalledWith(null);
  });
});
