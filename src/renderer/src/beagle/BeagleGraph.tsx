import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Background, BackgroundVariant, BaseEdge, Handle, MarkerType, MiniMap, Position,
  ReactFlow, ReactFlowProvider, getBezierPath, useNodesInitialized, useNodesState, useReactFlow,
  type Edge, type EdgeProps, type Node, type NodeProps, type OnEdgesChange, type OnNodesChange,
} from "@xyflow/react";
import ELK, { type ELK as ElkEngine } from "elkjs/lib/elk-api.js";
import { Button, ComboBox, Input, Label, ListBox, Tooltip } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsToCircle, faCertificate, faCircleNodes, faComputer, faCrown, faFolder,
  faGlobe, faLayerGroup, faMagnifyingGlassMinus, faMagnifyingGlassPlus,
  faShieldHalved, faSitemap, faUser, faUsers,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type { BeagleEdge, BeagleNode, BeagleQueryResult } from "../../../shared/beagle-contracts";
import { defaultBeagleGraphView, type BeagleGraphView } from "../../../shared/beagle-workspace";
import { graphIdentity, nodeKind, nodeName, nodeTagged, type BeagleSelection } from "./beagle-model";

type DirectoryNode = Node<{ entity: BeagleNode; showLabel: boolean; vertical: boolean }, "directory">;
type DirectoryEdge = Edge<{ relationship: BeagleEdge; parallelIndex: number; showLabel: boolean }, "relationship">;
const kindIcons: Record<string, IconDefinition> = {
  User: faUser, Computer: faComputer, Group: faUsers, Domain: faGlobe, OU: faFolder,
  GPO: faShieldHalved, Container: faFolder, CertTemplate: faCertificate, EnterpriseCA: faCertificate,
  RootCA: faCertificate, NTAuthStore: faCertificate, AIACA: faCertificate, IssuancePolicy: faCertificate,
};
export function NodeIcon({ node }: { node: BeagleNode }) {
  return <FontAwesomeIcon icon={kindIcons[nodeKind(node)] ?? faCircleNodes} />;
}

const ObjectNode = memo(function ObjectNode({ data, selected }: NodeProps<DirectoryNode>) {
  const { entity } = data;
  const kind = nodeKind(entity);
  return <div className="beagle-node" data-kind={kind} data-selected={selected} data-labels={data.showLabel} data-testid="beagle-node">
    <Handle type="target" position={data.vertical ? Position.Top : Position.Left} isConnectable={false} />
    <span className="beagle-node__icon"><NodeIcon node={entity} /></span>
    {data.showLabel ? <div className="beagle-node__identity"><span>{kind}</span><strong title={nodeName(entity)}>{nodeName(entity)}</strong>
      <small title={entity.objectid}>{entity.objectid}</small></div> : null}
    {nodeTagged(entity, "admin_tier_0") ? <span className="beagle-node__tag" title="Tier Zero"><FontAwesomeIcon icon={faCrown} /></span>
      : nodeTagged(entity, "owned") ? <span className="beagle-node__tag" title="Owned"><FontAwesomeIcon icon={faShieldHalved} /></span> : null}
    <Handle type="source" position={data.vertical ? Position.Bottom : Position.Right} isConnectable={false} />
  </div>;
});

const RelationshipEdge = memo(function RelationshipEdge(props: EdgeProps<DirectoryEdge>) {
  const relation = props.data?.relationship;
  const offset = props.data?.parallelIndex ?? 0;
  let [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX, sourceY: props.sourceY + offset * 7, targetX: props.targetX, targetY: props.targetY + offset * 7,
    sourcePosition: props.sourcePosition, targetPosition: props.targetPosition, curvature: 0.25 + offset * 0.12,
  });
  if (props.source === props.target) {
    const lift = 70 + offset * 30;
    path = `M ${props.sourceX},${props.sourceY} C ${props.sourceX + lift},${props.sourceY - lift * 2} ${props.targetX - lift},${props.targetY - lift * 2} ${props.targetX},${props.targetY}`;
    labelX = (props.sourceX + props.targetX) / 2;
    labelY = props.sourceY - lift * 1.5;
  }
  return <BaseEdge id={props.id} path={path} {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})} label={props.data?.showLabel ? relation?.kind : undefined}
    labelX={labelX} labelY={labelY} labelShowBg labelBgPadding={[7, 4]} labelBgBorderRadius={5}
    interactionWidth={24} className={`beagle-edge${relation?.derived ? " beagle-edge--derived" : ""}${props.selected ? " beagle-edge--selected" : ""}`} />;
});
const nodeTypes = { directory: ObjectNode };
const edgeTypes = { relationship: RelationshipEdge };

interface GraphProps { result: BeagleQueryResult; selection: BeagleSelection; onSelect: (value: BeagleSelection) => void; view?: BeagleGraphView; onViewChange?: (view: BeagleGraphView) => void }
export function BeagleGraph(props: GraphProps) {
  return <ReactFlowProvider key={props.result.projectId}><GraphCanvas {...props} /></ReactFlowProvider>;
}

function GraphCanvas({ result, selection, onSelect, view: suppliedView, onViewChange }: GraphProps) {
  const [localView, setLocalView] = useState(defaultBeagleGraphView);
  const view = suppliedView ?? localView;
  const changeView = (next: BeagleGraphView) => { setLocalView(next); onViewChange?.(next); };
  const flow = useReactFlow<DirectoryNode, DirectoryEdge>();
  const [nodes, setNodes, onNodesChange] = useNodesState<DirectoryNode>([]);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [fitRevision, setFitRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const geometry = useRef(new Map<string, { x: number; y: number }>());
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const select = (value: BeagleSelection) => { selectionRef.current = value; onSelect(value); };
  const structure = graphIdentity(result);
  const latestResult = useRef(result);
  latestResult.current = result;

  useEffect(() => {
    const next = result.graph.nodes.map((entity, index): DirectoryNode => ({
      id: encodeURIComponent(entity.objectid), type: "directory", data: { entity, showLabel: view.nodeLabels, vertical: view.layout === "vertical" },
      position: geometry.current.get(entity.objectid) ?? { x: (index % 5) * 280, y: Math.floor(index / 5) * 130 },
      selected: selection?.kind === "node" && selection.id === entity.objectid,
      ariaLabel: `${nodeKind(entity)}: ${nodeName(entity)}`,
    }));
    setNodes(next);
  }, [result.graph.nodes, selection, setNodes, view.nodeLabels, view.layout]);

  useEffect(() => {
    if (view.layout === "circle") {
      const graphNodes = latestResult.current.graph.nodes;
      const radius = Math.max(200, graphNodes.length * (view.nodeLabels ? 260 : 90) / (2 * Math.PI));
      geometry.current = new Map(graphNodes.map((node, index) => [node.objectid, { x: Math.cos(index * 2 * Math.PI / graphNodes.length) * radius, y: Math.sin(index * 2 * Math.PI / graphNodes.length) * radius }]));
      setNodes((current) => current.map((node) => ({ ...node, position: geometry.current.get(node.data.entity.objectid) ?? node.position })));
      setBusy(false); setError(undefined); setFitRevision((value) => value + 1);
      return;
    }
    let active = true;
    let engine: ElkEngine | undefined;
    let worker: Worker | undefined;
    setBusy(true); setError(undefined);
    const stop = () => { if (engine) engine.terminateWorker(); else worker?.terminate(); };
    const fail = () => {
      if (!active) return;
      active = false; stop(); setBusy(false);
      setError("Automatic layout is unavailable. Drag objects to arrange the graph.");
      setFitRevision((value) => value + 1);
    };
    const timer = window.setTimeout(fail, 15_000);
    try {
      engine = new ELK({ algorithms: ["layered"], workerFactory: () => {
        worker = new Worker(new URL("./beagle-layout.worker.ts", import.meta.url), { type: "module" });
        worker.onerror = fail; worker.onmessageerror = fail;
        return worker;
      } });
      const graph = latestResult.current.graph;
      const known = new Set(graph.nodes.map((node) => node.objectid));
      void engine.layout({
        id: "directory", layoutOptions: {
          "elk.algorithm": "layered", "elk.direction": view.layout === "vertical" ? "DOWN" : "RIGHT", "elk.spacing.nodeNode": "54",
          "elk.layered.spacing.nodeNodeBetweenLayers": "130", "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
        },
        children: graph.nodes.map((node) => ({ id: encodeURIComponent(node.objectid), width: view.nodeLabels ? 236 : 64, height: view.nodeLabels ? 84 : 64 })),
        edges: graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target)).map((edge) => ({
          id: encodeURIComponent(edge.id), sources: [encodeURIComponent(edge.source)], targets: [encodeURIComponent(edge.target)],
        })),
      }).then((layout) => {
        if (!active) return;
        active = false; window.clearTimeout(timer); stop();
        geometry.current = new Map((layout.children ?? []).map((node) => [decodeURIComponent(node.id), { x: node.x ?? 0, y: node.y ?? 0 }]));
        setNodes((current) => current.map((node) => ({ ...node, position: geometry.current.get(node.data.entity.objectid) ?? node.position })));
        setBusy(false); setFitRevision((value) => value + 1);
      }).catch(fail);
    } catch { fail(); }
    return () => { active = false; window.clearTimeout(timer); stop(); };
  }, [structure, layoutRevision, setNodes, view.layout, view.nodeLabels]);

  const edges = useMemo(() => {
    const known = new Set(result.graph.nodes.map((node) => node.objectid));
    const parallel = new Map<string, number>();
    return result.graph.edges.filter((edge) => known.has(edge.source) && known.has(edge.target)).map((relationship): DirectoryEdge => {
      const key = JSON.stringify([relationship.source, relationship.target]);
      const parallelIndex = parallel.get(key) ?? 0;
      parallel.set(key, parallelIndex + 1);
      return {
        id: encodeURIComponent(relationship.id), source: encodeURIComponent(relationship.source), target: encodeURIComponent(relationship.target),
        type: "relationship", data: { relationship, parallelIndex, showLabel: view.edgeLabels }, selected: selection?.kind === "edge" && selection.id === relationship.id,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "var(--color-muted)" },
        ariaLabel: `${relationship.kind}: ${relationship.source} to ${relationship.target}`,
      };
    });
  }, [result.graph, selection, view.edgeLabels]);

  const changeNodes: OnNodesChange<DirectoryNode> = (changes) => {
    onNodesChange(changes);
    for (const change of changes) {
      if (change.type === "position" && change.position) geometry.current.set(decodeURIComponent(change.id), change.position);
    }
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") select({ kind: "node", id: decodeURIComponent(selected.id) });
    else {
      const current = selectionRef.current;
      if (current?.kind === "node" && changes.some((change) => change.type === "select" && !change.selected && decodeURIComponent(change.id) === current.id)) select(null);
    }
  };
  const changeEdges: OnEdgesChange<DirectoryEdge> = (changes) => {
    const selected = changes.find((change) => change.type === "select" && change.selected);
    if (selected?.type === "select") select({ kind: "edge", id: decodeURIComponent(selected.id) });
    else {
      const current = selectionRef.current;
      if (current?.kind === "edge" && changes.some((change) => change.type === "select" && !change.selected && decodeURIComponent(change.id) === current.id)) select(null);
    }
  };

  return <div className="beagle-graph" aria-label="Active Directory graph" aria-busy={busy} data-testid="beagle-graph">
    <ReactFlow<DirectoryNode, DirectoryEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={changeNodes} onEdgesChange={changeEdges} onNodeDragStop={(_event, node) => { geometry.current.set(node.data.entity.objectid, node.position); }}
      onNodeClick={(_event, node) => select({ kind: "node", id: node.data.entity.objectid })}
      onEdgeClick={(_event, edge) => { if (edge.data) select({ kind: "edge", id: edge.data.relationship.id }); }}
      onPaneClick={() => select(null)} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null}
      minZoom={0.08} maxZoom={2} multiSelectionKeyCode={null} fitView={false}
      ariaLabelConfig={{ "node.a11yDescription.default": "Press Enter to inspect this object. Use arrow keys to adjust its position.",
        "edge.a11yDescription.default": "Press Enter to inspect this relationship." }}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
      {nodes.length > 10 ? <MiniMap pannable zoomable nodeColor="var(--color-surface-secondary)" maskColor="color-mix(in srgb, var(--color-background) 70%, transparent)" /> : null}
      <FitGraph revision={fitRevision} />
    </ReactFlow>
    <div className="beagle-graph__find"><ComboBox onSelectionChange={(id) => {
      if (id === null) return;
      select({ kind: "node", id: String(id) });
      void flow.fitView({ nodes: [{ id: encodeURIComponent(String(id)) }], padding: 0.7, maxZoom: 1.5, duration: 200 });
    }}><Label>Find in current graph</Label><ComboBox.InputGroup><Input placeholder="Name or object ID" /><ComboBox.Trigger /></ComboBox.InputGroup>
      <ComboBox.Popover className="beagle-endpoint-popover"><ListBox>{result.graph.nodes.map((node) => <ListBox.Item key={node.objectid} id={node.objectid} textValue={`${nodeName(node)} ${node.objectid}`}><Label>{nodeName(node)}</Label><span className="beagle-muted">{node.objectid}</span></ListBox.Item>)}</ListBox></ComboBox.Popover>
    </ComboBox></div>
    <div className="beagle-graph__tools">
      <GraphButton label="Zoom out" icon={faMagnifyingGlassMinus} onPress={() => { void flow.zoomOut(); }} />
      <GraphButton label="Zoom in" icon={faMagnifyingGlassPlus} onPress={() => { void flow.zoomIn(); }} />
      <GraphButton label="Fit graph" icon={faArrowsToCircle} onPress={() => { void flow.fitView({ padding: 0.18, maxZoom: 1 }); }} />
      <GraphButton label="Arrange graph" icon={faSitemap} onPress={() => setLayoutRevision((value) => value + 1)} />
      <NativeSelect variant="secondary"><NativeSelect.Trigger aria-label="Graph layout" value={view.layout} onChange={(event) => changeView({ ...view, layout: event.target.value as BeagleGraphView["layout"] })}>
        <NativeSelect.Option value="horizontal">Horizontal</NativeSelect.Option><NativeSelect.Option value="vertical">Vertical</NativeSelect.Option><NativeSelect.Option value="circle">Circle</NativeSelect.Option><NativeSelect.Indicator />
      </NativeSelect.Trigger></NativeSelect>
      <Button size="sm" variant="tertiary" aria-label="Show object labels" aria-pressed={view.nodeLabels} onPress={() => changeView({ ...view, nodeLabels: !view.nodeLabels })}>Objects</Button>
      <Button size="sm" variant="tertiary" aria-label="Show relationship labels" aria-pressed={view.edgeLabels} onPress={() => changeView({ ...view, edgeLabels: !view.edgeLabels })}>Relationships</Button>
    </div>
    <div className="beagle-graph__legend"><FontAwesomeIcon icon={faLayerGroup} />{nodes.length.toLocaleString()} objects · {edges.length.toLocaleString()} relationships</div>
    {busy || error ? <div className="beagle-graph__notice" role="status">{busy ? "Arranging graph…" : error}</div> : null}
  </div>;
}

function FitGraph({ revision }: { revision: number }) {
  const flow = useReactFlow();
  const initialized = useNodesInitialized();
  useEffect(() => {
    if (!initialized || revision === 0) return;
    const frame = requestAnimationFrame(() => { void flow.fitView({ padding: 0.18, maxZoom: 1 }); });
    return () => cancelAnimationFrame(frame);
  }, [initialized, revision, flow]);
  return null;
}

function GraphButton({ label, icon, onPress }: { label: string; icon: IconDefinition; onPress: () => void }) {
  return <Tooltip delay={250}><Button size="sm" variant="secondary" isIconOnly aria-label={label} onPress={onPress}><FontAwesomeIcon icon={icon} /></Button>
    <Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}
