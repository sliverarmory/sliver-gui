import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { ReactFlowProps, Viewport } from "@xyflow/react";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TopologyDocument } from "../../../shared/topology-contracts";
import { TopologyGraph } from "./TopologyGraph";

const mock = vi.hoisted(() => ({
  props: null as ReactFlowProps | null,
  initialized: true,
  geometryReady: true,
  viewport: { x: 0, y: 0, zoom: 1 },
  flow: {
    viewportInitialized: true,
    setViewport: vi.fn(async (_viewport: Viewport) => true),
    getViewport: vi.fn(() => ({ x: 0, y: 0, zoom: 1 })),
    fitView: vi.fn(async () => true),
    zoomIn: vi.fn(async () => true),
    zoomOut: vi.fn(async () => true),
  },
}));

vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    ReactFlow: (props: ReactFlowProps) => {
      mock.props = props;
      return <div data-testid="flow">{props.nodes?.map((node) => <div key={node.id} data-testid={`node-${node.id}`} aria-label={node.ariaLabel} onClick={(event) => props.onNodeClick?.(event, node)}>{`${node.position.x},${node.position.y}`}</div>)}{props.edges?.map((edge) => <button key={edge.id} data-testid={`edge-${edge.id}`} onClick={(event) => props.onEdgeClick?.(event, edge)}>{edge.id}</button>)}{props.children}</div>;
    },
    Background: () => null,
    MiniMap: () => null,
    useReactFlow: () => mock.flow,
    useNodesInitialized: () => mock.initialized,
    useStore: () => mock.geometryReady,
  };
});

vi.mock("@heroui/react", () => ({
  Button: ({ children, onPress, isDisabled, "aria-label": ariaLabel }: { children: ReactNode; onPress: () => void; isDisabled?: boolean; "aria-label"?: string }) => <button aria-label={ariaLabel} disabled={isDisabled} onClick={onPress}>{children}</button>,
}));

interface ElkWorkerRequest { id: number; cmd: string; graph?: ElkNode }
interface ElkWorkerResponse { id: number; data?: ElkNode }

class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnPost = false;
  onmessage: ((event: MessageEvent<ElkWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: ElkWorkerRequest;
  terminate = vi.fn();
  postMessage = vi.fn((request: ElkWorkerRequest) => {
    if (request.cmd === "register") {
      this.onmessage?.({ data: { id: request.id } } as MessageEvent<ElkWorkerResponse>);
      return;
    }
    if (FakeWorker.throwOnPost) throw new Error("Worker messaging failed");
    this.request = request;
  });
  constructor() { FakeWorker.instances.push(this); }
  complete(id = this.request!.id) {
    const graph = this.request!.graph!;
    const arrange = (node: ElkNode, index: number): ElkNode => ({
      ...node, x: index * 300, y: 25,
      ...(node.children ? { children: node.children.map(arrange) } : {}),
    });
    this.onmessage?.({ data: { id, data: { ...graph, children: graph.children?.map(arrange) } } } as MessageEvent<ElkWorkerResponse>);
  }
}

async function complete(worker: FakeWorker, id?: number): Promise<void> {
  await act(async () => {
    worker.complete(id);
    await vi.advanceTimersByTimeAsync(1);
  });
}

function queuedAnimationFrames(): { flush: () => Promise<void> } {
  let nextId = 0;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { callbacks.delete(id); });
  return {
    flush: async () => {
      await act(async () => {
        const pending = [...callbacks];
        callbacks.clear();
        for (const [, callback] of pending) callback(16);
      });
    },
  };
}

let scopeCount = 0;
function fixture(): TopologyDocument {
  return {
    schemaVersion: 1,
    scope: { id: `lifecycle-${++scopeCount}`, label: "Example server", connected: true },
    updatedAt: "2026-09-18T12:00:00.000Z",
    nodes: ["server", "target"].map((id) => ({ id, label: id, kind: id, role: "resource", icon: "server", status: "healthy", statusLabel: "Available", freshness: "current", properties: [] })),
    edges: [{ id: "relationship", source: "server", target: "target", kind: "reported", role: "communication", label: "mTLS", state: "live", freshness: "current", description: "Reported communication", properties: [] }],
    notices: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWorker.instances = [];
  FakeWorker.throwOnPost = false;
  mock.props = null;
  mock.initialized = true;
  mock.geometryReady = true;
  mock.flow.viewportInitialized = true;
  mock.viewport = { x: 0, y: 0, zoom: 1 };
  vi.clearAllMocks();
  mock.flow.getViewport.mockImplementation(() => mock.viewport);
  mock.flow.setViewport.mockImplementation(async (viewport) => { mock.viewport = viewport; return true; });
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("TopologyGraph display lifecycle", () => {
  it("shows an honest List fallback when workers are unavailable and skips workers for empty graphs", () => {
    vi.stubGlobal("Worker", undefined);
    const doc = fixture();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic layout is unavailable. The List view remains available.");
    expect(screen.getByTestId("topology-graph")).toHaveAttribute("aria-busy", "false");
    view.rerender(<TopologyGraph document={{ ...doc, nodes: [], edges: [] }} selection={null} onSelect={vi.fn()} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("No matching infrastructure.")).toBeInTheDocument();
  });

  it("retains keyboard position changes, labels, and layout across metadata and ordering updates", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalled();
    act(() => mock.props!.onNodesChange!([{ type: "position", id: "target", position: { x: 460, y: 90 }, dragging: false }]));
    expect(screen.getByTestId("node-target")).toHaveTextContent("460,90");
    const updated = { ...doc, nodes: [...doc.nodes].reverse().map((node) => ({ ...node, label: `${node.label} updated` })) };
    view.rerender(<TopologyGraph document={updated} selection={{ type: "node", id: "target" }} onSelect={onSelect} />);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(screen.getByTestId("node-target")).toHaveTextContent("460,90");
    expect(screen.getByTestId("node-target")).toHaveAttribute("aria-label", expect.stringContaining("target updated"));
  });

  it("preserves active dragging while data changes and remembers the completed position", async () => {
    const doc = fixture();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} />);
    await complete(FakeWorker.instances[0]!);
    act(() => mock.props!.onNodesChange!([{ type: "position", id: "target", position: { x: 510, y: 95 }, dragging: true }]));
    view.rerender(<TopologyGraph document={{ ...doc, nodes: doc.nodes.map((node) => ({ ...node, statusLabel: "Updated" })) }} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("node-target")).toHaveTextContent("510,95");
    act(() => mock.props!.onNodesChange!([{ type: "position", id: "target", position: { x: 515, y: 100 }, dragging: false }]));
    view.rerender(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} />);
    expect(screen.getByTestId("node-target")).toHaveTextContent("515,100");
  });

  it("supports keyboard node/edge selection and Escape deselection", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    act(() => mock.props!.onNodesChange!([{ type: "select", id: "target", selected: true }]));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "node", id: "target" });
    view.rerender(<TopologyGraph document={doc} selection={{ type: "node", id: "target" }} onSelect={onSelect} />);
    act(() => mock.props!.onNodesChange!([{ type: "select", id: "target", selected: false }]));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    act(() => mock.props!.onEdgesChange!([{ type: "select", id: "relationship", selected: true }]));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "edge", id: "relationship" });
    view.rerender(<TopologyGraph document={doc} selection={{ type: "edge", id: "relationship" }} onSelect={onSelect} />);
    act(() => mock.props!.onEdgesChange!([{ type: "select", id: "relationship", selected: false }]));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(mock.props?.onlyRenderVisibleElements).not.toBe(true);
  });

  it("keeps a newly selected edge when the old node is deselected in the same update", async () => {
    const onSelect = vi.fn();
    render(<TopologyGraph document={fixture()} selection={{ type: "node", id: "target" }} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const { onEdgesChange, onNodesChange } = mock.props!;
    act(() => {
      onEdgesChange!([{ type: "select", id: "relationship", selected: true }]);
      onNodesChange!([{ type: "select", id: "target", selected: false }]);
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ type: "edge", id: "relationship" });
  });

  it("keeps a newly selected node when the old edge is deselected in the same update", async () => {
    const onSelect = vi.fn();
    render(<TopologyGraph document={fixture()} selection={{ type: "edge", id: "relationship" }} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const { onEdgesChange, onNodesChange } = mock.props!;
    act(() => {
      onNodesChange!([{ type: "select", id: "target", selected: true }]);
      onEdgesChange!([{ type: "select", id: "relationship", selected: false }]);
    });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ type: "node", id: "target" });
  });

  it("binds arbitrary JSON identities safely while keeping selection and geometry identities original", async () => {
    const base = fixture();
    const groupId = 'cloud/["west"]';
    const serverId = 'server/"name"[0]';
    const targetId = 'collection:["future", "route/a"]';
    const edgeId = 'edge/"relationship"[1]';
    const doc: TopologyDocument = {
      ...base,
      nodes: [
        { ...base.nodes[0]!, id: groupId, role: "group" },
        { ...base.nodes[0]!, id: serverId, parentId: groupId },
        { ...base.nodes[1]!, id: targetId },
      ],
      edges: [{ ...base.edges[0]!, id: edgeId, source: serverId, target: targetId }],
    };
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const encodedTarget = encodeURIComponent(targetId);
    expect(mock.props!.nodes?.find(({ id }) => id === encodeURIComponent(serverId))?.parentId).toBe(encodeURIComponent(groupId));
    expect(mock.props!.edges?.[0]).toMatchObject({ id: encodeURIComponent(edgeId), source: encodeURIComponent(serverId), target: encodedTarget });
    act(() => mock.props!.onNodesChange!([{ type: "select", id: encodedTarget, selected: true }]));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "node", id: targetId });
    act(() => mock.props!.onEdgesChange!([{ type: "select", id: encodeURIComponent(edgeId), selected: true }]));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "edge", id: edgeId });
    fireEvent.click(screen.getByTestId(`node-${encodedTarget}`));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "node", id: targetId });
    fireEvent.click(screen.getByTestId(`edge-${encodeURIComponent(edgeId)}`));
    expect(onSelect).toHaveBeenLastCalledWith({ type: "edge", id: edgeId });
    act(() => mock.props!.onNodesChange!([{ type: "position", id: encodedTarget, position: { x: 625, y: 150 }, dragging: false }]));
    view.rerender(<TopologyGraph document={{ ...doc, nodes: doc.nodes.map((node) => ({ ...node, statusLabel: "Updated" })) }} selection={{ type: "node", id: targetId }} onSelect={onSelect} />);
    expect(screen.getByTestId(`node-${encodedTarget}`)).toHaveTextContent("625,150");
    view.unmount();
    render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(screen.getByTestId(`node-${encodedTarget}`)).toHaveTextContent("625,150");
  });

  it("remembers viewport and each filter layout across graph/list remounts", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    let view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    act(() => mock.props!.onNodesChange!([{ type: "position", id: "target", position: { x: 500, y: 180 }, dragging: false }]));
    const viewport = { x: 80, y: 50, zoom: 0.7 };
    mock.viewport = viewport;
    act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), viewport));
    const filtered = { ...doc, nodes: doc.nodes.slice(0, 1), edges: [] };
    view.rerender(<TopologyGraph document={filtered} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[1]!);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(viewport);
    view.rerender(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(screen.getByTestId("node-target")).toHaveTextContent("500,180");
    view.unmount();
    view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(viewport);
    expect(screen.getByTestId("node-target")).toHaveTextContent("500,180");
    view.unmount();
  });

  it("ignores stale worker responses and cleans workers up when switching scopes", async () => {
    const doc = fixture();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} />);
    const oldWorker = FakeWorker.instances[0]!;
    const nextDoc = { ...fixture(), nodes: [fixture().nodes[0]!] };
    view.rerender(<TopologyGraph document={{ ...nextDoc, edges: [] }} selection={null} onSelect={vi.fn()} />);
    expect(oldWorker.terminate).toHaveBeenCalled();
    await complete(oldWorker);
    expect(screen.queryByTestId("node-target")).not.toBeInTheDocument();
    const active = FakeWorker.instances[1]!;
    await complete(active, 999);
    expect(screen.getByTestId("topology-graph")).toHaveAttribute("aria-busy", "true");
    await complete(active);
    expect(screen.getByTestId("topology-graph")).toHaveAttribute("aria-busy", "false");
    view.unmount();
    expect(active.terminate).toHaveBeenCalled();
  });

  it("ignores late success after timeout and handles postMessage failure", async () => {
    vi.useFakeTimers();
    const view = render(<TopologyGraph document={fixture()} selection={null} onSelect={vi.fn()} />);
    const worker = FakeWorker.instances[0]!;
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole("alert")).toHaveTextContent("Layout took too long");
    await complete(worker);
    expect(screen.queryByTestId("node-target")).not.toBeInTheDocument();
    expect(worker.terminate).toHaveBeenCalled();
    view.unmount();
    FakeWorker.throwOnPost = true;
    render(<TopologyGraph document={fixture()} selection={null} onSelect={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByRole("alert")).toHaveTextContent("Automatic layout is unavailable");
    expect(FakeWorker.instances[1]!.terminate).toHaveBeenCalled();
  });

  it("does not fit again for initialization changes or metadata updates, and allows explicit reset", async () => {
    const doc = fixture();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} />);
    await complete(FakeWorker.instances[0]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    mock.initialized = false;
    view.rerender(<TopologyGraph document={{ ...doc }} selection={null} onSelect={vi.fn()} />);
    mock.initialized = true;
    view.rerender(<TopologyGraph document={{ ...doc }} selection={null} onSelect={vi.fn()} />);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(FakeWorker.instances).toHaveLength(2);
    await complete(FakeWorker.instances[1]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
  });

  it("fits the initial async layout only after geometry and viewport are ready, ignoring startup transforms", async () => {
    const doc = fixture();
    mock.initialized = false;
    mock.geometryReady = false;
    mock.flow.viewportInitialized = false;
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    // React Flow may report its initial untouched transform before ELK finishes.
    act(() => mock.props!.onMoveEnd!(null, { x: 0, y: 0, zoom: 1 }));
    await complete(FakeWorker.instances[0]!);
    expect(mock.flow.fitView).not.toHaveBeenCalled();
    expect(mock.flow.setViewport).not.toHaveBeenCalled();
    mock.flow.viewportInitialized = true;
    view.rerender(<TopologyGraph document={{ ...doc }} selection={null} onSelect={onSelect} />);
    expect(mock.flow.fitView).not.toHaveBeenCalled();
    mock.initialized = true;
    view.rerender(<TopologyGraph document={{ ...doc }} selection={null} onSelect={onSelect} />);
    expect(mock.flow.fitView).not.toHaveBeenCalled();
    mock.geometryReady = true;
    await act(async () => {
      view.rerender(<TopologyGraph document={{ ...doc }} selection={null} onSelect={onSelect} />);
    });
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    expect(mock.flow.fitView).toHaveBeenCalledWith({ padding: 0.18, maxZoom: 1 });
    const chosenViewport = { x: 105, y: 80, zoom: 0.45 };
    mock.viewport = chosenViewport;
    act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), chosenViewport));
    view.rerender(<TopologyGraph document={{ ...doc, nodes: doc.nodes.map((node) => ({ ...node, statusLabel: "New status" })) }} selection={null} onSelect={onSelect} />);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(chosenViewport);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
  });

  it("shows + and minus zoom symbols with accessible names and working controls", async () => {
    render(<TopologyGraph document={fixture()} selection={null} onSelect={vi.fn()} />);
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    expect(zoomIn).toHaveTextContent("+");
    expect(zoomOut).toHaveTextContent("−");
    await act(async () => { fireEvent.click(zoomIn); fireEvent.click(zoomOut); });
    expect(mock.flow.zoomIn).toHaveBeenCalledTimes(1);
    expect(mock.flow.zoomOut).toHaveBeenCalledTimes(1);
  });

  it("fits once when details open after a user viewport, keeps open updates still, and fits again on reopen", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const chosenViewport = { x: 240, y: 75, zoom: 0.55 };
    mock.viewport = chosenViewport;
    act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), chosenViewport));
    await act(async () => {
      view.rerender(<TopologyGraph document={doc} selection={{ type: "node", id: "target" }} inspectorOpen onSelect={onSelect} />);
    });
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    const updated = { ...doc, nodes: doc.nodes.map((node) => ({ ...node, statusLabel: "Fresh check-in" })) };
    await act(async () => {
      view.rerender(<TopologyGraph document={updated} selection={{ type: "edge", id: "relationship" }} inspectorOpen onSelect={onSelect} />);
    });
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    await act(async () => {
      view.rerender(<TopologyGraph document={updated} selection={null} inspectorOpen={false} onSelect={onSelect} />);
    });
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    await act(async () => {
      view.rerender(<TopologyGraph document={updated} selection={{ type: "node", id: "server" }} inspectorOpen onSelect={onSelect} />);
    });
    expect(mock.flow.fitView).toHaveBeenCalledTimes(3);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it("fits a cached remount with details already open despite a restored user viewport", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const chosenViewport = { x: 125, y: 90, zoom: 0.6 };
    mock.viewport = chosenViewport;
    act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), chosenViewport));
    view.unmount();
    await act(async () => {
      render(<TopologyGraph document={doc} selection={{ type: "node", id: "target" }} inspectorOpen onSelect={onSelect} />);
    });
    expect(FakeWorker.instances).toHaveLength(1);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(chosenViewport);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
  });

  it("waits for measured geometry and two animation frames before fitting an opened inspector", async () => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const frames = queuedAnimationFrames();
    mock.geometryReady = false;
    view.rerender(<TopologyGraph document={doc} selection={{ type: "node", id: "target" }} inspectorOpen onSelect={onSelect} />);
    await frames.flush();
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    mock.geometryReady = true;
    view.rerender(<TopologyGraph document={{ ...doc }} selection={{ type: "node", id: "target" }} inspectorOpen onSelect={onSelect} />);
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
  });

  it.each(["automatic", "user"] as const)("cancels an inspector fit closed between frames with an %s viewport", async (viewportSource) => {
    const doc = fixture();
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={doc} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    if (viewportSource === "user") {
      act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), mock.viewport));
    }
    const frames = queuedAnimationFrames();
    view.rerender(<TopologyGraph document={doc} selection={{ type: "node", id: "target" }} inspectorOpen onSelect={onSelect} />);
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    view.rerender(<TopologyGraph document={doc} selection={null} inspectorOpen={false} onSelect={onSelect} />);
    await frames.flush();
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
  });

  it.each([
    { inspectorLeft: 600, padding: { top: "20px", bottom: "20px", left: "20px", right: "220px" } },
    { inspectorLeft: 820, padding: 0.18 },
  ])("reserves only overlapping inspector space when its left edge is $inspectorLeft", async ({ inspectorLeft, padding }) => {
    const doc = fixture();
    const onSelect = vi.fn();
    const content = (inspectorOpen: boolean) => <div className="overview-workspace">
      <TopologyGraph document={doc} selection={inspectorOpen ? { type: "node", id: "target" } : null} inspectorOpen={inspectorOpen} onSelect={onSelect} />
      {inspectorOpen ? <aside className="overview-inspector" data-testid="inspector" /> : null}
    </div>;
    const view = render(content(false));
    await complete(FakeWorker.instances[0]!);
    const frames = queuedAnimationFrames();
    view.rerender(content(true));
    vi.spyOn(screen.getByTestId("topology-graph"), "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.spyOn(screen.getByTestId("inspector"), "getBoundingClientRect").mockReturnValue(new DOMRect(inspectorLeft, 0, 300, 600));
    await frames.flush();
    await frames.flush();
    expect(mock.flow.fitView).toHaveBeenLastCalledWith({ padding, maxZoom: 1 });
  });

  it("refits automatically as initial inventory arrives, then keeps same-structure status updates still", async () => {
    const base = fixture();
    const client = { ...base.nodes[0]!, id: "client", kind: "client" };
    const operator = { ...base.edges[0]!, id: "operator", source: "client", target: "server" };
    const initial = { ...base, nodes: [client, base.nodes[0]!], edges: [operator] };
    const full = { ...base, nodes: [client, ...base.nodes], edges: [operator, ...base.edges] };
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={initial} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(1);
    // An automatic pan notification keeps automatic provenance.
    act(() => mock.props!.onMoveEnd!(null, { x: 20, y: 30, zoom: 1 }));
    view.rerender(<TopologyGraph document={full} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[1]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    expect(mock.flow.setViewport).not.toHaveBeenCalled();
    view.rerender(<TopologyGraph document={{ ...full, nodes: full.nodes.map((node) => ({ ...node, statusLabel: "New check-in" })) }} selection={null} onSelect={onSelect} />);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    view.unmount();
    render(<TopologyGraph document={full} selection={null} onSelect={onSelect} />);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(2);
    expect(mock.flow.setViewport).toHaveBeenCalled();
  });

  it.each(["gesture", "zoom", "manual fit"] as const)("preserves an explicit %s viewport when later inventory appears", async (adjustment) => {
    const full = fixture();
    const initial = { ...full, nodes: full.nodes.slice(0, 1), edges: [] };
    const onSelect = vi.fn();
    const view = render(<TopologyGraph document={initial} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[0]!);
    const chosenViewport = { x: 140, y: 110, zoom: 0.65 };
    mock.viewport = chosenViewport;
    if (adjustment === "gesture") {
      act(() => mock.props!.onMoveEnd!(new MouseEvent("mouseup"), chosenViewport));
    } else {
      await act(async () => fireEvent.click(screen.getByRole("button", { name: adjustment === "zoom" ? "Zoom in" : "Fit view" })));
    }
    const fitCount = adjustment === "manual fit" ? 2 : 1;
    expect(mock.flow.fitView).toHaveBeenCalledTimes(fitCount);
    view.rerender(<TopologyGraph document={full} selection={null} onSelect={onSelect} />);
    await complete(FakeWorker.instances[1]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(fitCount);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(chosenViewport);
    view.unmount();
    render(<TopologyGraph document={full} selection={null} onSelect={onSelect} />);
    expect(mock.flow.setViewport).toHaveBeenLastCalledWith(chosenViewport);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(fitCount);
    fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
    await complete(FakeWorker.instances[2]!);
    expect(mock.flow.fitView).toHaveBeenCalledTimes(fitCount + 1);
  });

  it("keeps optional node decoration in UI data without altering the JSON document", async () => {
    const doc = fixture();
    const before = JSON.stringify(doc);
    const decorateNode = vi.fn((_node, content: ReactNode) => content);
    render(<TopologyGraph document={doc} selection={null} onSelect={vi.fn()} decorateNode={decorateNode} />);
    await complete(FakeWorker.instances[0]!);
    expect(mock.props?.nodes?.every((node) => node.data["decorateNode"] === decorateNode)).toBe(true);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
