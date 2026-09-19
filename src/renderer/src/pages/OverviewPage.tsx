import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Chip, Label, ListBox, SearchField, Select, toast } from "@heroui/react";
import { faCopy, faList, faPen, faPlay, faRotate, faShieldHalved, faStop, faTerminal, faTrashCan, faUserPlus } from "@fortawesome/free-solid-svg-icons";
import type { ManagedServerReference, SliverSnapshot } from "../../../shared/contracts";
import type { CloudDeploymentNavigationRequest } from "../../../shared/cloud-deployment-ipc";
import type { BeaconSummary, SessionSummary, TargetRef } from "../../../shared/target-contracts";
import type { TopologyDocument, TopologyEdge, TopologyNode, TopologyProperty } from "../../../shared/topology-contracts";
import { ApplicationContextMenuScope, type ApplicationContextMenuAction } from "../components/ApplicationContextMenu";
import { useSessionContextActions } from "../components/useSessionContextActions";
import { sessionContextMenuActions } from "../components/session-context-menu-actions";
import { isUsableConnection } from "../connection-status";
import { createOverviewTopology, overviewTopologyScopeId } from "../topology/overview-topology";
import { projectTopology } from "../topology/topology-projection";
import { TopologyGraph, type TopologySelection } from "../topology/TopologyGraph";
import { TopologyIcon } from "../topology/TopologyIcon";

interface OverviewPageProps {
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
  onNavigate: (view: "operations" | "sessions" | "beacons") => void;
  onOpenSession?: (session: SessionSummary, target: TargetRef) => void;
  onOpenBeacon?: (beacon: BeaconSummary, target: TargetRef) => void;
}

export function OverviewPage({ snapshot, onSnapshot, onNavigate, onOpenSession, onOpenBeacon }: OverviewPageProps) {
  const { actionsForTarget, dialogs } = useSessionContextActions({
    snapshot, onSnapshot,
    ...(onOpenSession ? { onOpenSession } : {}),
    ...(onOpenBeacon ? { onOpenBeacon } : {}),
  });
  const previous = useRef<SliverSnapshot | null>(null);
  const source = useMemo(() => {
    if (overviewTopologyScopeId(snapshot) !== "disconnected") {
      previous.current = snapshot;
      return snapshot;
    }
    if (!previous.current) return snapshot;
    return {
      ...previous.current,
      connection: { ...previous.current.connection, status: snapshot.connection.status },
      eventStream: snapshot.eventStream,
    };
  }, [snapshot]);
  const topology = useMemo(() => createOverviewTopology(source), [source]);
  const decorateNode = useCallback((node: TopologyNode, content: ReactNode): ReactNode => {
    const currentScope = overviewTopologyScopeId(snapshot) === topology.scope.id;
    if (node.kind === "server" && node.resource?.kind === "server") {
      return <ApplicationContextMenuScope builtInPolicy="inspect-only" actions={serverContextMenuActions({
        managed: currentScope ? snapshot.connection.managedServer : null,
        canViewJobs: currentScope && isUsableConnection(snapshot.connection.status),
        onViewJobs: () => onNavigate("operations"),
      })}>{content}</ApplicationContextMenuScope>;
    }
    // Resolve display identities against the current main-issued inventory. The
    // JSON model never carries action capabilities, including in retained views.
    // Stale event telemetry does not revoke a target's main-issued reference.
    if ((node.kind !== "session" && node.kind !== "beacon") ||
      (node.resource?.kind !== "session" && node.resource?.kind !== "beacon")) return content;
    const mode = node.resource.kind;
    const target = currentScope && isUsableConnection(snapshot.connection.status)
      ? snapshot.targetContext.selectableTargets.find((ref) =>
          ref.mode === mode && ref.id === node.resource?.id && ref.backendEpoch === snapshot.connection.epoch)
      : undefined;
    const actions = target ? actionsForTarget(target) : [];
    return <ApplicationContextMenuScope actions={actions.length ? actions : sessionContextMenuActions({
      target: undefined, mode, activeTarget: null, capabilities: [], disabled: true,
      showUnavailable: true, onAction: () => undefined,
    })}>{content}</ApplicationContextMenuScope>;
  }, [actionsForTarget, onNavigate, snapshot, topology.scope.id]);
  return <>
    <OverviewDocument key={topology.scope.id} document={topology} onNavigate={onNavigate} decorateNode={decorateNode} />
    {dialogs}
  </>;
}

function serverContextMenuActions({ managed, canViewJobs, onViewJobs }: {
  managed: ManagedServerReference | null;
  canViewJobs: boolean;
  onViewJobs: () => void;
}): ApplicationContextMenuAction[] {
  const state = managed?.overview?.instanceState;
  const running = state === "running";
  const stopped = state === "stopped" || state === "deallocated";
  const canCopyPublicIp = Boolean(managed?.overview?.publicIpAddress?.trim());
  const lifecycleAction = running ? "stop" : "start";
  type CloudAction = Extract<CloudDeploymentNavigationRequest, { view: "deployments" }>["action"] | "firewall";
  const cloudAction = (
    action: CloudAction,
    label: string,
    icon: ApplicationContextMenuAction["icon"],
    disabled = false,
  ): ApplicationContextMenuAction => ({
    id: `server.${action}`,
    label,
    ...(icon ? { icon } : {}),
    isDisabled: !managed || disabled,
    onAction: async () => {
      if (!managed || disabled) return;
      const request: CloudDeploymentNavigationRequest = action === "firewall"
        ? { view: "firewall", deploymentId: managed.deploymentId }
        : { view: "deployments", deploymentId: managed.deploymentId, action };
      try {
        const result = await window.sliver.openCloudDeploymentWindow(request);
        if (!result.ok) toast.danger("Could not open server action", { description: result.error });
      } catch (error) {
        toast.danger("Could not open server action", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  return [{
    id: "server.jobs",
    label: "View Jobs/Listeners",
    icon: faList,
    isDisabled: !canViewJobs,
    onAction: () => { if (canViewJobs) onViewJobs(); },
  },
  cloudAction("ssh", "SSH", faTerminal, state !== undefined && !running),
  cloudAction("firewall", "Firewall", faShieldHalved),
  cloudAction("operator", "Add Operator", faUserPlus, state !== undefined && !running),
  { ...cloudAction("rename", "Rename", faPen), separatorBefore: true },
  {
    id: "server.copy-public-ip",
    label: "Copy Public IP",
    icon: faCopy,
    isDisabled: !managed || !canCopyPublicIp,
    onAction: async () => {
      if (!managed || !canCopyPublicIp) return;
      try {
        const result = await window.sliver.copyManagedServerPublicIp({ deploymentId: managed.deploymentId });
        if (result.ok) toast.success("Public IP copied to clipboard");
        else toast.danger("Could not copy public IP", { description: result.error });
      } catch (error) {
        toast.danger("Could not copy public IP", {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
  },
  { ...cloudAction(lifecycleAction, running ? "Stop" : "Start", running ? faStop : faPlay, !running && !stopped), separatorBefore: true },
  cloudAction("reboot", "Reboot", faRotate, !running),
  { ...cloudAction("terminate", "Terminate", faTrashCan), variant: "danger" },
  ];
}

/** The view consumes the JSON document only; it knows nothing about RPCs or providers. */
export function OverviewDocument({ document, onNavigate, decorateNode }: {
  document: TopologyDocument;
  onNavigate?: OverviewPageProps["onNavigate"];
  decorateNode?: (node: TopologyNode, content: ReactNode) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState("all");
  const [presentation, setPresentation] = useState<"graph" | "list">("graph");
  const [selection, setSelection] = useState<TopologySelection>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const projection = useMemo(() => projectTopology(document, { query, kind, status, expanded }),
    [document, query, kind, status, expanded]);
  const kinds = useMemo(() => [...new Set(document.nodes.map((node) => node.kind))].sort(), [document.nodes]);
  const selectedNode = selection?.type === "node" ? projection.document.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.type === "edge" ? projection.document.edges.find((edge) => edge.id === selection.id) : undefined;
  const members = selectedNode ? projection.groups.get(selectedNode.id) : undefined;
  useEffect(() => {
    if (selection && !selectedNode && !selectedEdge) setSelection(null);
  }, [selection, selectedNode, selectedEdge]);

  const filtering = Boolean(query || kind !== "all" || status !== "all");
  const visibleNotices = document.notices.filter((notice) => notice.severity === "warning");
  const resourceCount = document.nodes.filter((node) => node.role === "resource").length;
  const updated = document.updatedAt ? new Date(document.updatedAt) : null;
  const updatedLabel = updated && Number.isFinite(updated.getTime()) ? updated.toLocaleTimeString() : "Not yet observed";

  return <section className="overview-page" aria-label="Overview">
    <div className="overview-page__heading">
      <div><h1>Overview</h1><p>Infrastructure and reported connections</p></div>
      <div className="overview-page__summary"><span>{resourceCount} resources</span>
        <Chip size="sm" color={document.scope.connected ? "success" : "default"} variant="soft">
          {document.scope.connected ? "Connected" : "Last known state"}
        </Chip>
      </div>
    </div>
    <div className="overview-toolbar">
      <SearchField aria-label="Search infrastructure" value={query} onChange={setQuery} className="overview-search" variant="secondary">
        <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Search infrastructure…" /><SearchField.ClearButton /></SearchField.Group>
      </SearchField>
      <OverviewFilter label="Infrastructure type" value={kind} onChange={setKind}
        options={[["all", "All types"], ...kinds.map((value): [string, string] => [value, titleCase(value)])]} />
      <OverviewFilter label="Status" value={status} onChange={setStatus}
        options={[["all", "All states"], ["healthy", "Healthy"], ["warning", "Needs attention"], ["inactive", "Inactive"], ["unknown", "Unknown"]]} />
      <div className="overview-view-controls" role="group" aria-label="Overview presentation">
        <Button size="sm" variant={presentation === "graph" ? "secondary" : "ghost"} aria-pressed={presentation === "graph"} onPress={() => setPresentation("graph")}>Graph</Button>
        <Button size="sm" variant={presentation === "list" ? "secondary" : "ghost"} aria-pressed={presentation === "list"} onPress={() => setPresentation("list")}>List</Button>
      </div>
    </div>
    {filtering ? <div className="overview-filter-summary" role="status">
      <span>{projection.matchCount} matches · connection context included</span>
      <Button size="sm" variant="ghost" onPress={() => { setQuery(""); setKind("all"); setStatus("all"); }}>Clear filters</Button>
    </div> : null}
    {visibleNotices.length ? <div className="overview-notices" aria-label="Topology data status">
      {visibleNotices.map((notice) => <p key={notice.id} data-severity={notice.severity}>{notice.message}</p>)}
    </div> : null}
    <div className="overview-workspace">
      <div className="overview-workspace__view">
        {presentation === "graph"
          ? <TopologyGraph document={projection.document} selection={selection} onSelect={setSelection}
              {...(decorateNode ? { decorateNode } : {})} />
          : <TopologyList document={projection.document} selection={selection} onSelect={setSelection} />}
      </div>
      {selectedNode || selectedEdge ? <aside className="overview-inspector" aria-label="Infrastructure details">
        <div className="overview-inspector__heading"><h2>{selectedNode ? "Resource details" : "Connection details"}</h2>
          <Button size="sm" variant="ghost" onPress={() => setSelection(null)}>Close</Button>
        </div>
        {selectedNode ? <>
          <div className="overview-inspector__identity"><span><TopologyIcon name={selectedNode.icon} /></span>
            <div><p>{titleCase(selectedNode.kind)}</p><h3>{selectedNode.label}</h3></div>
          </div>
          {selectedNode.subtitle ? <p className="overview-inspector__description">{selectedNode.subtitle}</p> : null}
          <PropertyList properties={[
            { label: "Status", value: selectedNode.statusLabel },
            { label: "Data", value: selectedNode.freshness },
            ...selectedNode.properties,
          ]} />
          {members ? <Button variant="secondary" onPress={() => {
            setExpanded((current) => new Set([...current, selectedNode.id])); setSelection(null);
          }}>Expand {members.length} resources</Button> : null}
          {onNavigate && selectedNode.resource?.kind === "session" ? <Button variant="secondary" onPress={() => onNavigate("sessions")}>Browse sessions</Button> : null}
          {onNavigate && selectedNode.resource?.kind === "beacon" ? <Button variant="secondary" onPress={() => onNavigate("beacons")}>Browse beacons</Button> : null}
          {onNavigate && selectedNode.resource?.kind === "server" ? <Button variant="secondary" onPress={() => onNavigate("operations")}>View jobs & listeners</Button> : null}
        </> : null}
        {selectedEdge ? <ConnectionDetails edge={selectedEdge} document={projection.document} /> : null}
      </aside> : null}
    </div>
    <div className="overview-footer">
      <div className="overview-legend"><span><i className="overview-legend__line" />Live connection</span><span><i className="overview-legend__line overview-legend__line--periodic" />Periodic check-in</span>
        {projection.document.edges.some((edge) => edge.role === "relationship") ? <span><i className="overview-legend__line overview-legend__line--association" />Association</span> : null}
        <span>Pulse = observed activity</span></div>
      {expanded.size ? <Button size="sm" variant="ghost" onPress={() => { setExpanded(new Set()); setSelection(null); }}>Collapse collections</Button> : null}
      <span title={document.updatedAt ?? undefined}>Updated {updatedLabel}</span>
    </div>
  </section>;
}

function OverviewFilter({ label, value, onChange, options }: {
  label: string; value: string; onChange: (value: string) => void; options: [string, string][];
}) {
  return <Select aria-label={label} className="overview-filter" value={value} onChange={(value) => onChange(String(value ?? "all"))} variant="secondary">
    <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
    <Select.Popover><ListBox aria-label={label}>{options.map(([id, text]) =>
      <ListBox.Item key={id} id={id} textValue={text}><Label>{text}</Label><ListBox.ItemIndicator /></ListBox.Item>)}
    </ListBox></Select.Popover>
  </Select>;
}

function TopologyList({ document, selection, onSelect }: {
  document: TopologyDocument; selection: TopologySelection; onSelect: (selection: TopologySelection) => void;
}) {
  return <div className="overview-list"><table aria-label="Infrastructure resources">
    <thead><tr><th>Resource</th><th>Type</th><th>Status</th><th>Data</th></tr></thead>
    <tbody>{document.nodes.map((node) => <tr key={node.id} data-selected={selection?.type === "node" && selection.id === node.id}>
      <td><Button variant="ghost" onPress={() => onSelect({ type: "node", id: node.id })}><TopologyIcon name={node.icon} /><span>{node.label}</span></Button></td>
      <td>{titleCase(node.kind)}</td><td>{node.statusLabel}</td><td>{node.freshness}</td>
    </tr>)}</tbody>
  </table>
    {!document.nodes.length ? <p className="overview-list__empty">No matching infrastructure.</p> : null}
    {document.edges.length ? <div className="overview-list__connections"><h2>Connections</h2>{document.edges.filter((edge) => edge.role !== "containment").map((edge) => <Button key={edge.id} variant="ghost" onPress={() => onSelect({ type: "edge", id: edge.id })}>
      {document.nodes.find((node) => node.id === edge.source)?.label} — {edge.label} — {document.nodes.find((node) => node.id === edge.target)?.label}
    </Button>)}</div> : null}
  </div>;
}

function ConnectionDetails({ edge, document }: { edge: TopologyEdge; document: TopologyDocument }) {
  return <><h3>{edge.label}</h3><p className="overview-inspector__description">{edge.description}</p>
    <PropertyList properties={[
      { label: "From", value: document.nodes.find((node) => node.id === edge.source)?.label ?? edge.source },
      { label: "To", value: document.nodes.find((node) => node.id === edge.target)?.label ?? edge.target },
      { label: "State", value: edge.state }, { label: "Data", value: edge.freshness },
      ...(edge.activityAt ? [{ label: "Last observed activity", value: edge.activityAt }] : []), ...edge.properties,
    ]} />
  </>;
}

function PropertyList({ properties }: { properties: readonly TopologyProperty[] }) {
  return <dl className="overview-properties">{properties.map((property, index) => <div key={`${index}:${property.label}`}>
    <dt>{property.label}</dt><dd>{property.value === null ? "Not reported" : String(property.value)}</dd>
  </div>)}</dl>;
}

function titleCase(value: string): string { return value.replace(/(^|[-_\s])\S/g, (text) => text.replace(/[-_]/g, " ").toUpperCase()); }
