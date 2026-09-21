import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, BaseEdge, Handle, MiniMap,
  Position, applyNodeChanges, getSmoothStepPath, useNodesInitialized, useReactFlow, useStore,
  type Edge, type EdgeProps, type Node, type NodeProps, type OnEdgesChange, type OnNodesChange, type Viewport,
} from "@xyflow/react";
import { Button } from "@heroui/react";
import ELK, { type ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import type { TopologyDocument, TopologyEdge, TopologyNode } from "../../../shared/topology-contracts";
import { createElkGraph, extractTopologyLayout, topologyLayoutInput, type LayoutNode, type TopologyLayoutInput } from "./topology-layout-input";
import { TopologyIcon } from "./TopologyIcon";

type NodeDecorator = (node: TopologyNode, content: ReactNode) => ReactNode;
type GraphNode = Node<{ resource: TopologyNode; decorateNode?: NodeDecorator }, "resource" | "enclosure">;
type GraphEdge = Edge<{ relationship: TopologyEdge }, "relationship">;
export type TopologySelection = { type: "node" | "edge"; id: string } | null;
interface CachedViewport {
  value: Viewport;
  source: "automatic" | "user";
  structureKey: string;
}
interface GeometryCache { layouts: Map<string, LayoutNode[]>; viewport?: CachedViewport }
// Window-local display state only. No infrastructure data is written to disk.
const geometryCache = new Map<string, GeometryCache>();

// React Flow interpolates identifiers into DOM selectors. Keep its identifiers
// selector-safe while preserving arbitrary JSON identities in resource data.
function flowElementId(id: string): string { return encodeURIComponent(id); }

function cacheForScope(scopeId: string): GeometryCache {
  const existing = geometryCache.get(scopeId);
  if (existing) return existing;
  const cache: GeometryCache = { layouts: new Map() };
  geometryCache.set(scopeId, cache);
  while (geometryCache.size > 8) geometryCache.delete(geometryCache.keys().next().value!);
  return cache;
}

function cacheGeometry(scopeId: string, key: string, nodes: LayoutNode[]): GeometryCache {
  const cache = cacheForScope(scopeId);
  cache.layouts.delete(key);
  cache.layouts.set(key, nodes);
  while (cache.layouts.size > 24) cache.layouts.delete(cache.layouts.keys().next().value!);
  return cache;
}

const ResourceNode = memo(function ResourceNode({ data, selected }: NodeProps<GraphNode>) {
  const node = data.resource;
  const compact = useStore((state) => state.transform[2] < 0.55);
  const content = (
    <div className="topology-node" data-testid="topology-node" data-selected={selected} data-status={node.status}
      data-freshness={node.freshness} data-compact={compact}>
      {node.kind === "session" ? <svg className="topology-node__lightning" aria-hidden="true" focusable="false"
        viewBox="-14 -14 264 140" preserveAspectRatio="none">
        <path pathLength="100" d="M -7 42 L -10 32 L -5 28 L -9 18 L 2 9 L 3 1 L 20 -5 L 36 -3 L 44 -10 L 51 -4 L 72 -7 L 80 -3 L 96 -8 L 108 -6" />
        <path pathLength="100" d="M 128 -6 L 143 -9 L 150 -3 L 166 -7 L 176 -4 L 187 -10 L 196 -4 L 218 -5 L 229 3 L 235 5 L 241 21 L 238 28 L 245 36 L 243 43" />
        <path pathLength="100" d="M 243 70 L 247 80 L 240 86 L 244 94 L 234 102 L 230 112 L 212 117 L 201 114 L 190 122 L 182 116 L 165 120 L 151 115 L 140 121 L 128 118" />
        <path pathLength="100" d="M 108 118 L 95 121 L 85 115 L 70 120 L 59 116 L 46 122 L 37 116 L 19 118 L 6 111 L 0 110 L -6 96 L -3 86 L -10 80 L -7 70" />
      </svg> : null}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="topology-node__identity">
        <span className="topology-node__icon"><TopologyIcon name={node.icon} /></span>
        <div className="topology-node__text">
          <span className="topology-node__kind">
            {node.kind === "session" || node.kind === "beacon"
              ? <TopologyIcon name={node.kind} className="topology-node__kind-icon" /> : null}
            {node.kind.replace(/[-_]/gu, " ")}
          </span>
          <strong title={node.label}>{node.label}</strong>
        </div>
      </div>
      <p className="topology-node__subtitle" title={node.subtitle}>{node.subtitle || node.statusLabel}</p>
      <div className="topology-node__status"><span className="topology-status-dot" />
        {node.freshness === "current" ? node.statusLabel : `${node.statusLabel} · ${node.freshness}`}
      </div>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
  return data.decorateNode ? data.decorateNode(node, content) : content;
});

const EnclosureNode = memo(function EnclosureNode({ data, selected }: NodeProps<GraphNode>) {
  const node = data.resource;
  const content = <div className="topology-enclosure" data-testid="topology-node" data-provider={node.provider} data-selected={selected}>
    <div className="topology-enclosure__heading">
      <span className="topology-enclosure__icon"><TopologyIcon name={node.icon} /></span>
      <div><strong title={node.label}>{node.label}</strong><p title={node.subtitle || node.statusLabel}>{node.subtitle || node.statusLabel}</p></div>
    </div>
  </div>;
  return data.decorateNode ? data.decorateNode(node, content) : content;
});

const RelationshipEdge = memo(function RelationshipEdge(props: EdgeProps<GraphEdge>) {
  const edge = props.data?.relationship;
  const previousActivity = useRef(edge?.activityAt);
  const [pulsing, setPulsing] = useState(false);
  useEffect(() => {
    setPulsing(false);
    if (!edge?.activityAt || previousActivity.current === edge.activityAt) return;
    const previousTime = previousActivity.current ? Date.parse(previousActivity.current) : 0;
    previousActivity.current = edge.activityAt;
    if (edge.role !== "communication" || edge.freshness !== "current" || !(Date.parse(edge.activityAt) > previousTime)) return;
    setPulsing(true);
    const timer = window.setTimeout(() => setPulsing(false), 1400);
    return () => window.clearTimeout(timer);
  }, [edge?.activityAt, edge?.freshness]);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: props.sourceX, sourceY: props.sourceY, targetX: props.targetX, targetY: props.targetY,
    sourcePosition: props.sourcePosition, targetPosition: props.targetPosition, borderRadius: 18,
  });
  return <BaseEdge id={props.id} path={path} label={edge?.label} labelX={labelX} labelY={labelY}
    interactionWidth={24} className={`topology-edge topology-edge--${edge?.role === "communication" ? edge.state : "association"}${pulsing ? " topology-edge--pulse" : ""}`}
    labelShowBg labelBgPadding={[7, 4]} labelBgBorderRadius={5} />;
});

const nodeTypes = { resource: ResourceNode, enclosure: EnclosureNode };
const edgeTypes = { relationship: RelationshipEdge };

interface TopologyGraphProps {
  document: TopologyDocument;
  selection: TopologySelection;
  onSelect: (selection: TopologySelection) => void;
  /** Optional UI decoration; never included in the JSON topology document. */
  decorateNode?: NodeDecorator;
}

export function TopologyGraph(props: TopologyGraphProps) {
  return <ReactFlowProvider key={props.document.scope.id}><GraphCanvas {...props} /></ReactFlowProvider>;
}

function GraphCanvas({ document, selection, onSelect, decorateNode }: TopologyGraphProps) {
  const flow = useReactFlow<GraphNode, GraphEdge>();
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const nodesRef = useRef(nodes);
  const [geometry, setGeometry] = useState<LayoutNode[]>([]);
  const [layoutError, setLayoutError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(0);
  const [fitRevision, setFitRevision] = useState(0);
  const graph = topologyLayoutInput(document);
  // Snapshot ordering changes are metadata updates, not a new layout request.
  graph.nodes.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  graph.edges.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const structureKey = JSON.stringify(graph);
  const scopeId = document.scope.id;
  const resetRef = useRef(0);
  const viewportEstablished = useRef(Boolean(geometryCache.get(scopeId)?.viewport));
  const [userViewport, setUserViewport] = useState(geometryCache.get(scopeId)?.viewport?.source === "user");
  const fitStructureKey = useRef(structureKey);
  const rememberViewport = useCallback((source: CachedViewport["source"] = "user", key = structureKey) => {
    viewportEstablished.current = true;
    cacheForScope(scopeId).viewport = { value: flow.getViewport(), source, structureKey: key };
    if (source === "user") setUserViewport(true);
  }, [flow, scopeId, structureKey]);
  const rememberAutomaticViewport = useCallback(() => {
    const source = cacheForScope(scopeId).viewport?.source === "user" ? "user" : "automatic";
    rememberViewport(source, fitStructureKey.current);
  }, [rememberViewport, scopeId]);

  useEffect(() => {
    let settled = false;
    const cached = geometryCache.get(scopeId);
    const force = resetRef.current !== reset;
    resetRef.current = reset;
    const cachedLayout = cached?.layouts.get(structureKey);
    if (cachedLayout && !force) {
      setBusy(false);
      setLayoutError(undefined);
      setGeometry(cachedLayout);
      if (cached?.viewport && (cached.viewport.source === "user" || cached.viewport.structureKey === structureKey)) {
        void flow.setViewport(cached.viewport.value);
      } else {
        fitStructureKey.current = structureKey;
        setFitRevision((value) => value + 1);
      }
      return;
    }
    setBusy(true);
    setLayoutError(undefined);
    if (!graph.nodes.length) {
      setBusy(false);
      setGeometry([]);
      cacheGeometry(scopeId, structureKey, []);
      return;
    }
    let engine: ElkEngine | undefined;
    let worker: Worker | undefined;
    const terminate = () => {
      if (engine) engine.terminateWorker();
      else worker?.terminate();
    };
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      terminate();
      setBusy(false);
      setLayoutError("Layout took too long. Filter the graph or use the List view.");
    }, 20_000);
    const failed = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      terminate();
      setBusy(false);
      setLayoutError("Automatic layout is unavailable. The List view remains available.");
    };
    try {
      engine = new ELK({
        algorithms: ["layered"],
        workerFactory: () => {
          worker = new Worker(new URL("./elk-layout.worker.ts", import.meta.url), { type: "module" });
          worker.onerror = failed;
          worker.onmessageerror = failed;
          return worker;
        },
      });
      void engine.layout(createElkGraph(JSON.parse(structureKey) as TopologyLayoutInput)).then((result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        setBusy(false);
        terminate();
        const next = extractTopologyLayout(result);
        setGeometry(next);
        const cache = cacheGeometry(scopeId, structureKey, next);
        if (cache.viewport && !force && (cache.viewport.source === "user" || cache.viewport.structureKey === structureKey)) {
          void flow.setViewport(cache.viewport.value);
        } else {
          fitStructureKey.current = structureKey;
          setFitRevision((value) => value + 1);
        }
      }, failed);
    } catch {
      failed();
    }
    return () => { settled = true; window.clearTimeout(timeout); terminate(); };
  }, [scopeId, structureKey, reset, flow]);

  useEffect(() => () => {
    const cache = cacheForScope(scopeId);
    if (nodesRef.current.length && viewportEstablished.current && cache.viewport) {
      cache.viewport = { ...cache.viewport, value: flow.getViewport() };
    }
  }, [flow, scopeId]);

  useEffect(() => {
    const positions = new Map(geometry.map((node) => [node.id, node]));
    // ELK returns parents first, as required by React Flow's containment model.
    const resources = new Map(document.nodes.map((node) => [node.id, node]));
    const currentNodes = new Map(nodesRef.current.map((node) => [node.data.resource.id, node]));
    const next = geometry.flatMap((position): GraphNode[] => {
      const resource = resources.get(position.id);
      if (!resource) return [];
      const current = currentNodes.get(resource.id);
      return [{
        id: flowElementId(resource.id), type: resource.role === "group" ? "enclosure" : "resource",
        data: { resource, ...(decorateNode ? { decorateNode } : {}) }, position: current?.dragging ? current.position : { x: position.x, y: position.y },
        dragging: current?.dragging ?? false,
        width: position.width, height: position.height,
        style: { width: position.width, height: position.height },
        ...(resource.parentId && positions.has(resource.parentId) && resources.has(resource.parentId) ? { parentId: flowElementId(resource.parentId), extent: "parent" as const } : {}),
        selected: selection?.type === "node" && selection.id === resource.id,
        ariaLabel: `${resource.label}, ${resource.kind}, ${resource.statusLabel}, ${resource.freshness}`,
      }];
    });
    nodesRef.current = next;
    setNodes(next);
  }, [document.nodes, geometry, selection, decorateNode]);

  const edges = useMemo((): GraphEdge[] => document.edges.filter((edge) => edge.role !== "containment").map((relationship) => ({
    id: flowElementId(relationship.id), source: flowElementId(relationship.source), target: flowElementId(relationship.target),
    type: "relationship", data: { relationship },
    selected: selection?.type === "edge" && selection.id === relationship.id,
    className: `topology-relationship topology-relationship--${relationship.freshness}`,
    ariaLabel: `${relationship.label}: ${relationship.description}`,
  })), [document.edges, selection]);
  const rememberNodes = useCallback((current: GraphNode[]) => {
    const next = current.map((node) => ({ id: node.data.resource.id, x: node.position.x, y: node.position.y,
      width: node.width ?? 236, height: node.height ?? 112 }));
    setGeometry(next);
    cacheGeometry(scopeId, structureKey, next);
  }, [scopeId, structureKey]);
  const onNodesChange: OnNodesChange<GraphNode> = useCallback((changes) => {
    const next = applyNodeChanges(changes, nodesRef.current);
    nodesRef.current = next;
    setNodes(next);
    if (changes.some((change) => change.type === "position" && change.dragging !== true)) rememberNodes(next);
    const selected = changes.find((change) => change.type === "select" && change.selected);
    const selectedResource = selected?.type === "select" ? next.find((node) => node.id === selected.id)?.data.resource : undefined;
    if (selectedResource) onSelect({ type: "node", id: selectedResource.id });
    else if (selection?.type === "node" && changes.some((change) => change.type === "select" && !change.selected && change.id === flowElementId(selection.id))) onSelect(null);
  }, [onSelect, rememberNodes, selection]);
  const onEdgesChange: OnEdgesChange<GraphEdge> = useCallback((changes) => {
    const selected = changes.find((change) => change.type === "select" && change.selected);
    const selectedRelationship = selected?.type === "select" ? document.edges.find((edge) => flowElementId(edge.id) === selected.id) : undefined;
    if (selectedRelationship) onSelect({ type: "edge", id: selectedRelationship.id });
    else if (selection?.type === "edge" && changes.some((change) => change.type === "select" && !change.selected && change.id === flowElementId(selection.id))) onSelect(null);
  }, [document.edges, onSelect, selection]);

  return <div className="topology-graph" data-testid="topology-graph" aria-label="Infrastructure topology" aria-busy={busy}>
    <ReactFlow<GraphNode, GraphEdge>
      nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
      onNodeDragStop={() => rememberNodes(nodesRef.current)}
      onNodeClick={(_event, node) => onSelect({ type: "node", id: node.data.resource.id })}
      onEdgeClick={(_event, edge) => { if (edge.data) onSelect({ type: "edge", id: edge.data.relationship.id }); }}
      onPaneClick={() => onSelect(null)}
      onMoveEnd={(event, viewport) => {
        // Startup can emit the untouched default transform before ELK finishes.
        // Only a real gesture or an established viewport should be restored.
        if (event || viewportEstablished.current) {
          viewportEstablished.current = true;
          const cache = cacheForScope(scopeId);
          if (event) {
            cache.viewport = { value: viewport, source: "user", structureKey };
            setUserViewport(true);
          } else if (cache.viewport) cache.viewport = { ...cache.viewport, value: viewport };
        }
      }}
      nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      minZoom={0.15} maxZoom={1.8} fitView={false} multiSelectionKeyCode={null}
      ariaLabelConfig={{
        "node.a11yDescription.default": "Press Enter to inspect. Use arrow keys to adjust its display position. Press Escape to deselect.",
        "edge.a11yDescription.default": "Press Enter to inspect this relationship. Press Escape to deselect.",
      }}
    >
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      {nodes.length > 16 ? <MiniMap pannable zoomable nodeColor="var(--color-surface-secondary)" maskColor="color-mix(in srgb, var(--color-background) 70%, transparent)" /> : null}
      <FitAfterLayout revision={fitRevision} expectedLayout={geometry} enabled={!userViewport} onFitted={rememberAutomaticViewport} />
    </ReactFlow>
    <div className="topology-graph__controls">
      <Button isIconOnly size="sm" variant="secondary" aria-label="Zoom out" onPress={() => {
        rememberViewport();
        void flow.zoomOut().then(() => rememberViewport());
      }}><span aria-hidden="true">−</span></Button>
      <Button isIconOnly size="sm" variant="secondary" aria-label="Zoom in" onPress={() => {
        rememberViewport();
        void flow.zoomIn().then(() => rememberViewport());
      }}><span aria-hidden="true">+</span></Button>
      <Button size="sm" variant="secondary" onPress={() => {
        rememberViewport();
        void flow.fitView({ padding: 0.18, maxZoom: 1 }).then(() => rememberViewport());
      }}>Fit view</Button>
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => {
        setUserViewport(false);
        const cache = cacheForScope(scopeId);
        if (cache.viewport) cache.viewport = { ...cache.viewport, source: "automatic" };
        setReset((value) => value + 1);
      }}>Reset layout</Button>
    </div>
    {busy ? <div className="topology-graph__message" role="status">Arranging infrastructure…</div> : null}
    {layoutError ? <div className="topology-graph__message" role="alert">{layoutError}</div> : null}
    {!busy && !layoutError && !document.nodes.length ? <div className="topology-graph__message">No matching infrastructure.</div> : null}
  </div>;
}

function FitAfterLayout({ revision, expectedLayout, enabled, onFitted }: {
  revision: number;
  expectedLayout: readonly LayoutNode[];
  enabled: boolean;
  onFitted: () => void;
}) {
  const initialized = useNodesInitialized();
  const { fitView, viewportInitialized } = useReactFlow();
  const geometryReady = useStore((state) => state.width > 0 && state.height > 0
    && expectedLayout.length > 0 && state.nodeLookup.size === expectedLayout.length
    && expectedLayout.every((expected) => {
      const actual = state.nodeLookup.get(flowElementId(expected.id));
      return actual?.position.x === expected.x && actual.position.y === expected.y;
    }));
  const fittedRevision = useRef(0);
  const pendingRevision = useRef(0);
  const latestRevision = useRef(revision);
  const onFittedRef = useRef(onFitted);
  const enabledRef = useRef(enabled);
  const mounted = useRef(true);
  latestRevision.current = revision;
  onFittedRef.current = onFitted;
  enabledRef.current = enabled;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!enabled || !initialized || !viewportInitialized || !geometryReady || !revision
      || fittedRevision.current === revision || pendingRevision.current === revision) return;
    const frame = requestAnimationFrame(() => {
      pendingRevision.current = revision;
      void fitView({ padding: 0.18, maxZoom: 1 }).then((fitted) => {
        if (pendingRevision.current === revision) pendingRevision.current = 0;
        if (!mounted.current || !enabledRef.current || latestRevision.current !== revision || !fitted) return;
        fittedRevision.current = revision;
        onFittedRef.current();
      }, () => {
        if (pendingRevision.current === revision) pendingRevision.current = 0;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, fitView, geometryReady, initialized, revision, viewportInitialized]);
  return null;
}
