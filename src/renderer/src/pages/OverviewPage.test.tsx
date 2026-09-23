import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "@heroui/react";
import { disconnectedSnapshot, type OperationResult, type SliverSnapshot } from "../../../shared/contracts";
import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import type { TopologyDocument, TopologyNode } from "../../../shared/topology-contracts";
import { renderWithApplicationContextMenu } from "../application-context-menu-test-utils";
import { OverviewDocument, OverviewPage } from "./OverviewPage";

vi.mock("../topology/TopologyGraph", () => ({
  TopologyGraph: ({ document, selection, inspectorOpen, onSelect, decorateNode }: {
    document: TopologyDocument; onSelect: (selection: { type: "node" | "edge"; id: string }) => void;
    selection: { type: "node" | "edge"; id: string } | null; inspectorOpen: boolean;
    decorateNode?: (node: TopologyNode, content: ReactNode) => ReactNode;
  }) => <div aria-label="Test graph" data-scope={document.scope.id} data-inspector-open={inspectorOpen}
    data-selection={selection ? `${selection.type}:${selection.id}` : ""}>
    {document.nodes.map((node) => {
      const content = <button onClick={() => onSelect({ type: "node", id: node.id })}>{node.label}</button>;
      return <div key={node.id}>{decorateNode ? decorateNode(node, content) : content}</div>;
    })}
    {document.edges.map((edge) => <button key={edge.id} onClick={() => onSelect({ type: "edge", id: edge.id })}>Inspect connection {edge.label}</button>)}
  </div>,
}));

afterEach(cleanup);

function sessionSnapshot(): SliverSnapshot {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected", managedServer: null, server: "example.test:31337", configName: "example", epoch: 7 };
  snapshot.eventStream = { status: "connected", attempt: 0 };
  const session: SessionSummary = {
    mode: "session", id: "session-one", name: "workstation", hostname: "session-host", hostId: "host-one",
    username: "operator", os: "linux", arch: "amd64", transport: "mtls", remoteAddress: "192.0.2.10:4444",
    activeC2: "mtls://example.test:8888", executable: "client", version: "1.7.6", locale: "en-US",
    integrity: "Medium", burned: false, liveness: "active",
  };
  snapshot.domains.sessions = { status: "ready", revision: 1, updatedAt: "2026-09-18T12:00:00.000Z", items: [session],
    page: { limit: 100, total: 1, truncated: false } };
  snapshot.sessions = [session];
  snapshot.targetContext.selectableTargets = [{ mode: "session", id: session.id, backendEpoch: 7,
    domainRevision: 1, fingerprint: "a".repeat(64) }];
  return snapshot;
}

describe("Overview target context menu", () => {
  it("keeps node selection and the session context menu available while the sidebar is disabled", async () => {
    const user = userEvent.setup();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={sessionSnapshot()} onNavigate={vi.fn()}
      onSnapshot={vi.fn()} onOpenSession={vi.fn()} />);
    await user.click(screen.getByRole("switch", { name: "Disable sidebar" }));
    const node = screen.getByRole("button", { name: "session-host" });
    await user.click(node);
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Test graph")).toHaveAttribute("data-selection", expect.stringContaining("session-one"));
    fireEvent.contextMenu(node);
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Interact" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Interact in new window" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).not.toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
  });

  it.each(["connected", "degraded", "reconnecting"] as const)("keeps the session menu while %s and event updates are stale", async (status) => {
    const user = userEvent.setup();
    const snapshot = sessionSnapshot();
    snapshot.connection.status = status;
    snapshot.eventStream = { status: status === "reconnecting" ? "retrying" : "stopped", attempt: 0 };
    const onSnapshot = vi.fn();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={onSnapshot} onOpenSession={vi.fn()} />);
    const node = screen.getByRole("button", { name: "session-host" });
    await user.click(node);
    expect(within(screen.getByRole("complementary", { name: "Infrastructure details" })).getByText("stale")).toBeInTheDocument();
    fireEvent.contextMenu(node);
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Interact" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Interact in new window" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Close Session" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Kill Session" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).not.toHaveAttribute("aria-disabled", "true");
    expect(onSnapshot).not.toHaveBeenCalled();
  });

  it("uses the session menu only for a current session with a main-issued reference", async () => {
    const user = userEvent.setup();
    const snapshot = sessionSnapshot();
    const props = { onNavigate: vi.fn(), onSnapshot: vi.fn() };
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "session-host" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Interact", "Interact", "Rename", "Close Session", "Kill Session", "Inspect Element",
    ]);
    expect(props.onSnapshot).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());

    rendered.rerender(<OverviewPage snapshot={{ ...snapshot, targetContext: { ...snapshot.targetContext, selectableTargets: [] } }} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "session-host" }));
    rendered.contextMenu.emit();
    const missingReferenceMenu = await screen.findByRole("menu");
    for (const name of ["Interact", "Interact in new window", "Rename", "Close Session", "Kill Session"]) {
      expect(within(missingReferenceMenu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("keeps unavailable session actions disabled on retained nodes after disconnect", async () => {
    const props = { onNavigate: vi.fn(), onSnapshot: vi.fn() };
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={sessionSnapshot()} {...props} />);
    rendered.rerender(<OverviewPage snapshot={disconnectedSnapshot()} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "session-host" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    for (const name of ["Interact", "Interact in new window", "Rename", "Close Session", "Kill Session"]) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
  });

  it("offers both interactions on beacon nodes and disables them when their reference disappears", async () => {
    const user = userEvent.setup();
    const snapshot = sessionSnapshot();
    const beacon: BeaconSummary = { ...snapshot.sessions[0]!, mode: "beacon", id: "beacon-one", hostname: "beacon-host",
      checkinStatus: "on-time", intervalMs: 60_000, jitterMs: 0, taskCount: 0, completedTaskCount: 0, nonCompletedTaskCount: 0 };
    snapshot.domains.beacons = { ...snapshot.domains.sessions, items: [beacon] };
    snapshot.beacons = [beacon];
    snapshot.targetContext.selectableTargets.push({ ...snapshot.targetContext.selectableTargets[0]!, mode: "beacon", id: beacon.id });
    const props = { onNavigate: vi.fn(), onSnapshot: vi.fn(), onOpenBeacon: vi.fn() };
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "beacon-host" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Interact", "Interact", "Inspect Element",
    ]);
    for (const name of ["Interact", "Interact in new window"]) {
      expect(within(menu).getByRole("menuitem", { name })).not.toHaveAttribute("aria-disabled", "true");
    }
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    rendered.rerender(<OverviewPage snapshot={{ ...snapshot, targetContext: { ...snapshot.targetContext, selectableTargets: [] } }} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "beacon-host" }));
    rendered.contextMenu.emit();
    const missingReferenceMenu = await screen.findByRole("menu");
    for (const name of ["Interact", "Interact in new window"]) {
      expect(within(missingReferenceMenu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    expect(within(missingReferenceMenu).queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
  });
});

function managedServerSnapshot(state = "running"): SliverSnapshot {
  const snapshot = sessionSnapshot();
  snapshot.connection.managedServer = {
    deploymentId: "77777777-7777-4777-8777-777777777777",
    provider: state === "deallocated" ? "azure" : "aws",
    name: "managed-control",
    overview: {
      region: "us-west-2", size: "t3.micro", instanceState: state,
      publicIpAddress: "198.51.100.24", privateIpAddress: "10.0.0.4",
      updatedAt: "2026-09-19T12:00:00.000Z",
    },
  };
  return snapshot;
}

describe("Overview server context menu", () => {
  const openCloudDeploymentWindow = vi.fn(async (_request: unknown) => ({ ok: true }));
  const copyManagedServerSshCommand = vi.fn(async (_request: unknown): Promise<OperationResult> => ({ ok: true }));
  const copyManagedServerPublicIp = vi.fn(async (_request: unknown): Promise<OperationResult> => ({ ok: true }));
  beforeEach(() => {
    openCloudDeploymentWindow.mockReset().mockResolvedValue({ ok: true });
    copyManagedServerSshCommand.mockReset().mockResolvedValue({ ok: true });
    copyManagedServerPublicIp.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal("sliver", { openCloudDeploymentWindow, copyManagedServerSshCommand, copyManagedServerPublicIp });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("groups access, metadata, and lifecycle actions and opens Jobs/Listeners", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={managedServerSnapshot()} onNavigate={onNavigate} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "View Jobs/Listeners", "SSH", "Copy SSH Command", "Firewall", "Add Operator", "Rename", "Copy Public IP", "Stop", "Reboot", "Terminate", "Inspect Element",
    ]);
    expect(Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((item) =>
      item.getAttribute("role") === "separator" ? "separator" : item.textContent,
    )).toEqual([
      "View Jobs/Listeners", "SSH", "Copy SSH Command", "Firewall", "Add Operator", "separator", "Rename", "Copy Public IP", "separator", "Stop", "Reboot", "Terminate", "separator", "Inspect Element",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "View Jobs/Listeners" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledExactlyOnceWith("operations"));
    expect(openCloudDeploymentWindow).not.toHaveBeenCalled();
  });

  it.each([
    ["SSH", "ssh"], ["Firewall", "firewall"], ["Add Operator", "operator"], ["Rename", "rename"],
    ["Stop", "stop"], ["Reboot", "reboot"], ["Terminate", "terminate"],
  ])("routes %s to the current managed deployment's existing cloud flow", async (label, action) => {
    const user = userEvent.setup();
    const snapshot = managedServerSnapshot();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    await user.click(within(menu).getByRole("menuitem", { name: label }));
    await waitFor(() => expect(openCloudDeploymentWindow).toHaveBeenCalledExactlyOnceWith(action === "firewall"
      ? { view: "firewall", deploymentId: snapshot.connection.managedServer!.deploymentId }
      : { view: "deployments", deploymentId: snapshot.connection.managedServer!.deploymentId, action }));
  });

  it.each(["stopped", "deallocated"])("offers Start while %s and reconnecting, and disables running-only actions", async (state) => {
    const user = userEvent.setup();
    const snapshot = managedServerSnapshot(state);
    snapshot.connection.status = "reconnecting";
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    for (const name of ["SSH", "Copy SSH Command", "Add Operator", "Reboot"]) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    for (const name of ["Rename", "Copy Public IP"]) {
      expect(within(menu).getByRole("menuitem", { name })).not.toHaveAttribute("aria-disabled", "true");
    }
    expect(within(menu).queryByRole("menuitem", { name: "Stop" })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: "Start" }));
    await waitFor(() => expect(openCloudDeploymentWindow).toHaveBeenCalledExactlyOnceWith({
      view: "deployments", deploymentId: snapshot.connection.managedServer!.deploymentId, action: "start",
    }));
  });

  it("disables cloud actions for an unmanaged server", async () => {
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={sessionSnapshot()} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "example.test:31337" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "View Jobs/Listeners" })).not.toHaveAttribute("aria-disabled", "true");
    for (const name of ["SSH", "Copy SSH Command", "Firewall", "Add Operator", "Rename", "Copy Public IP", "Start", "Reboot", "Terminate"]) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    expect(openCloudDeploymentWindow).not.toHaveBeenCalled();
  });

  it("disables retained server actions after their current association is lost", async () => {
    const props = { onNavigate: vi.fn(), onSnapshot: vi.fn() };
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={managedServerSnapshot()} {...props} />);
    rendered.rerender(<OverviewPage snapshot={disconnectedSnapshot()} {...props} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    for (const name of ["View Jobs/Listeners", "SSH", "Copy SSH Command", "Firewall", "Add Operator", "Rename", "Copy Public IP", "Start", "Reboot", "Terminate"]) {
      expect(within(menu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    expect(openCloudDeploymentWindow).not.toHaveBeenCalled();
  });

  it("shows a toast when opening a server action fails", async () => {
    const user = userEvent.setup();
    const danger = vi.spyOn(toast, "danger");
    openCloudDeploymentWindow.mockRejectedValueOnce(new Error("The association changed"));
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={managedServerSnapshot()} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Firewall" }));
    await waitFor(() => expect(danger).toHaveBeenCalledWith("Could not open server action", { description: "The association changed" }));
  });

  it("copies the associated deployment's SSH command and announces success only after the copy completes", async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success");
    const danger = vi.spyOn(toast, "danger");
    let completeCopy!: (result: OperationResult) => void;
    copyManagedServerSshCommand.mockImplementationOnce(() => new Promise((resolve) => { completeCopy = resolve; }));
    const snapshot = managedServerSnapshot();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy SSH Command" }));

    await waitFor(() => expect(copyManagedServerSshCommand).toHaveBeenCalledExactlyOnceWith({
      deploymentId: snapshot.connection.managedServer!.deploymentId,
    }));
    expect(success).not.toHaveBeenCalled();
    await act(async () => { completeCopy({ ok: true }); });
    await waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith("SSH command copied to clipboard"));
    expect(danger).not.toHaveBeenCalled();
    expect(openCloudDeploymentWindow).not.toHaveBeenCalled();
  });

  it.each(["response", "rejection"])("reports an SSH command copy %s failure without a success toast", async (failure) => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success");
    const danger = vi.spyOn(toast, "danger");
    if (failure === "response") copyManagedServerSshCommand.mockResolvedValueOnce({ ok: false, error: "The association changed" });
    else copyManagedServerSshCommand.mockRejectedValueOnce(new Error("The association changed"));
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={managedServerSnapshot()} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy SSH Command" }));
    await waitFor(() => expect(danger).toHaveBeenCalledExactlyOnceWith("Could not copy SSH command", { description: "The association changed" }));
    expect(success).not.toHaveBeenCalled();
  });

  it("copies the associated deployment's public IP and announces success only after the copy completes", async () => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success");
    const danger = vi.spyOn(toast, "danger");
    let completeCopy!: (result: OperationResult) => void;
    copyManagedServerPublicIp.mockImplementationOnce(() => new Promise((resolve) => { completeCopy = resolve; }));
    const snapshot = managedServerSnapshot();
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy Public IP" }));

    await waitFor(() => expect(copyManagedServerPublicIp).toHaveBeenCalledExactlyOnceWith({
      deploymentId: snapshot.connection.managedServer!.deploymentId,
    }));
    expect(success).not.toHaveBeenCalled();
    await act(async () => { completeCopy({ ok: true }); });
    await waitFor(() => expect(success).toHaveBeenCalledExactlyOnceWith("Public IP copied to clipboard"));
    expect(danger).not.toHaveBeenCalled();
    expect(openCloudDeploymentWindow).not.toHaveBeenCalled();
  });

  it.each(["response", "rejection"])("reports a public IP copy %s failure without a success toast", async (failure) => {
    const user = userEvent.setup();
    const success = vi.spyOn(toast, "success");
    const danger = vi.spyOn(toast, "danger");
    if (failure === "response") copyManagedServerPublicIp.mockResolvedValueOnce({ ok: false, error: "No public IP is available" });
    else copyManagedServerPublicIp.mockRejectedValueOnce(new Error("No public IP is available"));
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={managedServerSnapshot()} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "Copy Public IP" }));
    await waitFor(() => expect(danger).toHaveBeenCalledExactlyOnceWith("Could not copy public IP", { description: "No public IP is available" }));
    expect(success).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("disables Copy Public IP when the current public IP is %s", async (publicIpAddress) => {
    const snapshot = managedServerSnapshot();
    snapshot.connection.managedServer = { ...snapshot.connection.managedServer!,
      overview: { ...snapshot.connection.managedServer!.overview!, publicIpAddress } };
    const rendered = renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    fireEvent.contextMenu(screen.getByRole("button", { name: "managed-control" }));
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Copy Public IP" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).not.toHaveAttribute("aria-disabled", "true");
    expect(copyManagedServerPublicIp).not.toHaveBeenCalled();
  });
});

function topology(): TopologyDocument {
  return {
    schemaVersion: 1, scope: { id: "example", label: "Example", connected: true },
    updatedAt: "2026-09-18T12:00:00.000Z", edges: [], notices: [],
    nodes: [{ id: "future", kind: "queue-cluster", role: "resource", label: "Regional queue", icon: "new-icon",
      status: "healthy", statusLabel: "Available", freshness: "current", properties: [{ label: "Region", value: "west" }] }],
  };
}

describe("Overview document rendering", () => {
  it.each(["node", "edge"] as const)("closes and suppresses the graph sidebar while preserving %s selection and re-enables current details", async (firstType) => {
    const user = userEvent.setup();
    const base = topology();
    const document: TopologyDocument = {
      ...base,
      nodes: [...base.nodes, { ...base.nodes[0]!, id: "other", label: "Other queue" }],
      edges: [{ id: "link", source: "future", target: "other", kind: "queue-link", role: "relationship",
        label: "Queue link", state: "unknown", freshness: "current", description: "Reported relationship", properties: [] }],
    };
    render(<OverviewDocument document={document} />);
    const toggle = screen.getByRole("switch", { name: "Disable sidebar" });
    const graph = screen.getByLabelText("Test graph");
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeEnabled();
    expect(graph).toHaveAttribute("data-inspector-open", "false");
    const firstName = firstType === "node" ? "Regional queue" : "Inspect connection Queue link";
    const firstSelection = firstType === "node" ? "node:future" : "edge:link";
    const nextName = firstType === "node" ? "Inspect connection Queue link" : "Other queue";
    const nextSelection = firstType === "node" ? "edge:link" : "node:other";
    await user.click(screen.getByRole("button", { name: firstName }));
    expect(screen.getByRole("complementary", { name: "Infrastructure details" })).toBeInTheDocument();
    expect(graph).toHaveAttribute("data-inspector-open", "true");
    await user.click(toggle);
    expect(toggle).toBeChecked();
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    expect(graph).toHaveAttribute("data-inspector-open", "false");
    expect(graph).toHaveAttribute("data-selection", firstSelection);
    await user.click(screen.getByRole("button", { name: nextName }));
    expect(graph).toHaveAttribute("data-selection", nextSelection);
    expect(graph).toHaveAttribute("data-inspector-open", "false");
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    await user.click(toggle);
    const inspector = screen.getByRole("complementary", { name: "Infrastructure details" });
    expect(within(inspector).getByRole("heading", { name: firstType === "node" ? "Connection details" : "Resource details" })).toBeInTheDocument();
    expect(graph).toHaveAttribute("data-inspector-open", "true");
    expect(graph).toHaveAttribute("data-selection", nextSelection);
    await user.click(within(inspector).getByRole("button", { name: "Close" }));
    expect(graph).toHaveAttribute("data-inspector-open", "false");
    expect(graph).toHaveAttribute("data-selection", "");
  });

  it("allows List details and disables the sidebar toggle there while preserving its Graph setting", async () => {
    const user = userEvent.setup();
    render(<OverviewDocument document={topology()} />);
    await user.click(screen.getByRole("button", { name: "Regional queue" }));
    await user.click(screen.getByRole("switch", { name: "Disable sidebar" }));
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List" }));
    const toggle = screen.getByRole("switch", { name: "Disable sidebar" });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    let inspector = screen.getByRole("complementary", { name: "Infrastructure details" });
    await user.click(within(inspector).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole("table", { name: "Infrastructure resources" })).getByRole("button", { name: "Regional queue" }));
    inspector = screen.getByRole("complementary", { name: "Infrastructure details" });
    expect(within(inspector).getByRole("heading", { name: "Regional queue" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Graph" }));
    expect(toggle).toBeEnabled();
    expect(toggle).toBeChecked();
    expect(screen.queryByRole("complementary", { name: "Infrastructure details" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Test graph")).toHaveAttribute("data-inspector-open", "false");
    expect(screen.getByLabelText("Test graph")).toHaveAttribute("data-selection", "node:future");
    await user.click(toggle);
    expect(screen.getByLabelText("Test graph")).toHaveAttribute("data-inspector-open", "true");
    expect(screen.getByRole("complementary", { name: "Infrastructure details" })).toBeInTheDocument();
  });

  it("combines selected types and states in both graph and list without restoring excluded neighbors", async () => {
    const user = userEvent.setup();
    const base = topology();
    const source: TopologyDocument = {
      ...base,
      nodes: [
        { ...base.nodes[0]!, id: "server", kind: "server", label: "Control server" },
        { ...base.nodes[0]!, id: "online", kind: "operator", label: "Online operator" },
        { ...base.nodes[0]!, id: "offline", kind: "operator", filterKind: "operator-offline", label: "Offline operator", status: "inactive" },
        { ...base.nodes[0]!, id: "warning", kind: "operator", label: "Warning operator", status: "warning" },
        { ...base.nodes[0]!, id: "client", kind: "client", label: "This client" },
      ],
      edges: [{ id: "presence", source: "client", target: "server", kind: "presence", role: "relationship",
        label: "Presence", state: "unknown", freshness: "current", description: "Presence", properties: [] }],
    };
    render(<OverviewDocument document={source} />);
    expect(screen.queryByRole("button", { name: "Offline operator" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Infrastructure type/ }));
    const types = screen.getByRole("listbox", { name: "Infrastructure type" });
    expect(types).toHaveAttribute("aria-multiselectable", "true");
    expect(within(types).getByRole("option", { name: "Operator (Offline)" })).toHaveAttribute("aria-selected", "false");
    await user.click(within(types).getByRole("option", { name: "Client" }));
    expect(types).toBeInTheDocument();
    expect(within(types).getByRole("option", { name: "Operator" })).toHaveAttribute("aria-selected", "true");
    expect(within(types).getByRole("option", { name: "Server" })).toHaveAttribute("aria-selected", "true");
    expect(within(types).getByRole("option", { name: "All types" })).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Infrastructure type/ })).toHaveTextContent("2 types selected");

    await user.click(screen.getByRole("button", { name: /Status/ }));
    const states = screen.getByRole("listbox", { name: "Status" });
    await user.click(within(states).getByRole("option", { name: "All states" }));
    await user.click(within(states).getByRole("option", { name: "Healthy" }));
    await user.click(within(states).getByRole("option", { name: "Inactive" }));
    expect(states).toBeInTheDocument();
    await user.keyboard("{Escape}");
    const graph = within(screen.getByLabelText("Test graph"));
    expect(graph.getAllByRole("button").map((item) => item.textContent)).toEqual(["Control server", "Online operator"]);
    await user.click(screen.getByRole("button", { name: /Infrastructure type/ }));
    await user.click(screen.getByRole("option", { name: "Operator (Offline)" }));
    await user.keyboard("{Escape}");
    expect(graph.getAllByRole("button").map((item) => item.textContent)).toEqual(["Control server", "Online operator", "Offline operator"]);
    expect(screen.getByRole("button", { name: /Status/ })).toHaveTextContent("2 states selected");
    await user.click(screen.getByRole("button", { name: "List" }));
    const rows = within(screen.getByRole("table", { name: "Infrastructure resources" })).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.textContent).join(" ")).not.toMatch(/Warning operator|This client/);
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.queryByRole("button", { name: "Offline operator" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Online operator" })).toBeInTheDocument();
  });

  it("supports empty selections, keyboard toggles, and resetting both filters", async () => {
    const user = userEvent.setup();
    render(<OverviewDocument document={topology()} />);
    await user.click(screen.getByRole("button", { name: "Regional queue" }));
    await user.click(screen.getByRole("button", { name: /Infrastructure type/ }));
    await user.click(screen.getByRole("option", { name: "All types" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: /Infrastructure type/ })).toHaveTextContent("No types");
    expect(within(screen.getByLabelText("Test graph")).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Status/ }));
    await user.keyboard("{Home} {Escape}");
    expect(screen.getByRole("button", { name: /Status/ })).toHaveTextContent("No states");
    await user.type(screen.getByRole("searchbox", { name: "Search infrastructure" }), "missing");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: /Infrastructure type/ })).toHaveTextContent("All types");
    expect(screen.getByRole("button", { name: /Status/ })).toHaveTextContent("All states");
    expect(screen.getByRole("searchbox", { name: "Search infrastructure" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Regional queue" })).toBeInTheDocument();
  });

  it("includes new types by default, keeps last-known offline operators hidden, and preserves an explicit subset on refresh", async () => {
    const user = userEvent.setup();
    const source = topology();
    const added: TopologyDocument = { ...source, nodes: [...source.nodes,
      { ...source.nodes[0]!, id: "server", kind: "server", label: "Control server" },
      { ...source.nodes[0]!, id: "offline", kind: "operator", filterKind: "operator-offline", label: "Offline operator",
        status: "unknown", statusLabel: "Last known: offline", freshness: "stale" },
    ] };
    const { rerender } = render(<OverviewDocument document={source} />);
    rerender(<OverviewDocument document={added} />);
    expect(screen.getByRole("button", { name: "Control server" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Offline operator" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Infrastructure type/ }));
    expect(screen.getByRole("option", { name: "Server" })).toHaveAttribute("aria-selected", "true");
    await user.click(screen.getByRole("option", { name: "Server" }));
    await user.keyboard("{Escape}");
    rerender(<OverviewDocument document={{ ...added, nodes: [...added.nodes,
      { ...source.nodes[0]!, id: "new-service", kind: "new-service", label: "New service" },
    ] }} />);
    expect(screen.getByRole("button", { name: "Regional queue" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Control server" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New service" })).not.toBeInTheDocument();
  });

  it("resolves a collapsed connection's endpoints to visible resource labels", async () => {
    const user = userEvent.setup();
    const source = topology();
    const leaves = Array.from({ length: 13 }, (_, index) => ({
      ...source.nodes[0]!, id: `queue-${index}`, label: `Queue ${index}`,
    }));
    const document: TopologyDocument = {
      ...source,
      nodes: [{ ...source.nodes[0]!, id: "server", kind: "server", label: "Central server" }, ...leaves],
      edges: leaves.map((node) => ({
        id: `link-${node.id}`, source: "server", target: node.id, kind: "queue-access", role: "relationship",
        label: "Queue link", state: "live", freshness: "current", description: "Reported relationship", properties: [],
      })),
    };
    render(<OverviewDocument document={document} />);

    await user.click(screen.getByRole("button", { name: "Inspect connection Queue link" }));

    const inspector = screen.getByRole("complementary", { name: "Infrastructure details" });
    expect(within(inspector).getByText("Central server")).toBeInTheDocument();
    expect(within(inspector).getByText("13 resources")).toBeInTheDocument();
    expect(inspector).not.toHaveTextContent("collection:");
  });

  it("renders and inspects unknown future resource kinds in both graph and accessible list", async () => {
    const user = userEvent.setup();
    render(<OverviewDocument document={topology()} />);
    await user.click(screen.getByRole("button", { name: "Regional queue" }));
    const inspector = screen.getByRole("complementary", { name: "Infrastructure details" });
    expect(within(inspector).getByText("Queue Cluster")).toBeInTheDocument();
    expect(within(inspector).getByText("west")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "List" }));
    expect(within(screen.getByRole("table", { name: "Infrastructure resources" })).getByText("Regional queue")).toBeInTheDocument();
    await user.click(within(inspector).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("filters metadata, clears a hidden selection, and shows only warning notices", async () => {
    const user = userEvent.setup();
    const source = topology();
    const partialNotice = { id: "partial", severity: "info" as const, message: "Showing 1 of 30 resources; this inventory is partial." };
    const { rerender } = render(<OverviewDocument document={{ ...source, notices: [partialNotice] }} />);
    expect(screen.queryByLabelText("Topology data status")).not.toBeInTheDocument();
    rerender(<OverviewDocument document={{ ...source, notices: [partialNotice,
      { id: "sessions:error", severity: "warning", message: "Sessions could not be refreshed." },
    ] }} />);
    await user.click(screen.getByRole("button", { name: "Regional queue" }));
    await user.type(screen.getByRole("searchbox", { name: "Search infrastructure" }), "missing");
    expect(screen.getByText(/0 matches/)).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByText(/Showing 1 of 30/)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Topology data status")).toHaveTextContent("Sessions could not be refreshed.");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await user.type(screen.getByRole("searchbox", { name: "Search infrastructure" }), "west");
    expect(screen.getByRole("button", { name: "Regional queue" })).toBeInTheDocument();
  });

  it("renders source labels as text and supports JSON serialization without renderer objects", async () => {
    const user = userEvent.setup();
    const document = topology();
    const label = '<script>alert("sample")</script>';
    const node = { ...document.nodes[0]!, label };
    const serialized = JSON.parse(JSON.stringify({ ...document, nodes: [node] })) as TopologyDocument;
    const { container } = render(<OverviewDocument document={serialized} />);
    await user.click(screen.getByRole("button", { name: label }));
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("heading", { name: label })).toBeInTheDocument();
  });
});

describe("Overview connection context", () => {
  it("retains a stale display on disconnect and drops it when a different server arrives", async () => {
    const user = userEvent.setup();
    const first = disconnectedSnapshot();
    first.connection = { status: "connected", managedServer: null, server: "first.example:31337", configName: "first" };
    const { rerender } = renderWithApplicationContextMenu(<OverviewPage snapshot={first} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    rerender(<OverviewPage snapshot={disconnectedSnapshot()} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "first.example:31337" }));
    expect(within(screen.getByRole("complementary")).getByText("stale")).toBeInTheDocument();
    const second = disconnectedSnapshot();
    second.connection = { status: "connected", managedServer: null, server: "second.example:31337", configName: "second" };
    rerender(<OverviewPage snapshot={second} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "first.example:31337" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "second.example:31337" })).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
  });

  it("shows cloud metadata separately from the selected server's cached instance details", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected", server: "cloud.example:31337", managedServer: {
      deploymentId: "managed", provider: "aws", name: "Test deployment", overview: {
        region: "us-west-2", size: "t3.small", instanceState: "running", health: "ok",
        publicIpAddress: "192.0.2.20", privateIpAddress: "10.0.1.4", updatedAt: "2026-09-18T10:00:00Z",
        cloud: { provider: "aws", vpcId: "vpc-123" },
      },
    } };
    renderWithApplicationContextMenu(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "vpc-123" }));
    const inspector = screen.getByRole("complementary");
    expect(within(inspector).getByText("AWS")).toBeInTheDocument();
    expect(within(inspector).getByText("us-west-2")).toBeInTheDocument();
    expect(within(inspector).getByText("VPC ID")).toBeInTheDocument();
    expect(within(inspector).queryByText("Instance state (cached)")).not.toBeInTheDocument();
    expect(within(inspector).queryByText("192.0.2.20")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test deployment" }));
    expect(within(inspector).getByText("Instance state (cached)")).toBeInTheDocument();
    expect(within(inspector).getByText("192.0.2.20")).toBeInTheDocument();
    expect(within(inspector).queryByText("VPC ID")).not.toBeInTheDocument();
  });
});
