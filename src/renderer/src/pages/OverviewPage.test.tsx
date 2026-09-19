import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { disconnectedSnapshot, type SliverSnapshot } from "../../../shared/contracts";
import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import type { TopologyDocument, TopologyNode } from "../../../shared/topology-contracts";
import { renderWithApplicationContextMenu } from "../application-context-menu-test-utils";
import { OverviewDocument, OverviewPage } from "./OverviewPage";

vi.mock("../topology/TopologyGraph", () => ({
  TopologyGraph: ({ document, onSelect, decorateNode }: {
    document: TopologyDocument; onSelect: (selection: { type: "node" | "edge"; id: string }) => void;
    decorateNode?: (node: TopologyNode, content: ReactNode) => ReactNode;
  }) => <div aria-label="Test graph" data-scope={document.scope.id}>
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

function topology(): TopologyDocument {
  return {
    schemaVersion: 1, scope: { id: "example", label: "Example", connected: true },
    updatedAt: "2026-09-18T12:00:00.000Z", edges: [], notices: [],
    nodes: [{ id: "future", kind: "queue-cluster", role: "resource", label: "Regional queue", icon: "new-icon",
      status: "healthy", statusLabel: "Available", freshness: "current", properties: [{ label: "Region", value: "west" }] }],
  };
}

describe("Overview document rendering", () => {
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
    const { rerender } = render(<OverviewPage snapshot={first} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
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

  it("shows the verified provider and cached cloud metadata without fetching cloud resources", async () => {
    const user = userEvent.setup();
    const snapshot = disconnectedSnapshot();
    snapshot.connection = { status: "connected", server: "cloud.example:31337", managedServer: {
      deploymentId: "managed", provider: "aws", name: "Test deployment", overview: {
        region: "us-west-2", size: "t3.small", instanceState: "running", health: "ok",
        publicIpAddress: "192.0.2.20", privateIpAddress: "10.0.1.4", updatedAt: "2026-09-18T10:00:00Z",
      },
    } };
    render(<OverviewPage snapshot={snapshot} onNavigate={vi.fn()} onSnapshot={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Test deployment" }));
    const inspector = screen.getByRole("complementary");
    expect(within(inspector).getByText("AWS")).toBeInTheDocument();
    expect(within(inspector).getByText("us-west-2")).toBeInTheDocument();
    expect(within(inspector).getByText("Instance state (cached)")).toBeInTheDocument();
    expect(within(inspector).getByText("192.0.2.20")).toBeInTheDocument();
  });
});
