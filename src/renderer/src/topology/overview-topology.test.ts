import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { DomainCollection, SliverSnapshot } from "../../../shared/contracts";
import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import type { TopologyNode } from "../../../shared/topology-contracts";
import {
  createOverviewTopology,
  DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS,
  overviewTopologyScopeId,
} from "./overview-topology";
import type { TopologyContributor } from "./overview-topology";

const timestamp = "2026-09-18T12:00:00.000Z";

const session: SessionSummary = {
  mode: "session",
  id: "shared-target-id",
  name: "workstation",
  hostname: "office-windows",
  hostId: "host-1",
  username: "operator",
  os: "windows",
  arch: "amd64",
  transport: "mtls",
  remoteAddress: "192.0.2.20:4444",
  activeC2: "mtls://example.test:8888",
  executable: "client.exe",
  version: "1.7.6",
  locale: "en-US",
  integrity: "Medium",
  burned: false,
  liveness: "active",
  lastCheckinAt: timestamp,
};

const beacon: BeaconSummary = {
  ...session,
  mode: "beacon",
  hostname: "office-linux",
  os: "linux",
  transport: "https",
  checkinStatus: "on-time",
  nextCheckinAt: "2026-09-18T12:01:00.000Z",
};

function domain<T>(items: T[]): DomainCollection<T> {
  return { status: items.length ? "ready" : "empty", revision: 1, updatedAt: timestamp, items, page: { limit: 500, total: items.length, truncated: false } };
}

function snapshot(): SliverSnapshot {
  const value = disconnectedSnapshot();
  value.connection = { status: "connected", server: "example.test:31337", configName: "office.cfg", operator: "operator", epoch: 12, incarnation: 3, managedServer: null };
  value.eventStream = { status: "connected", attempt: 0 };
  value.lastUpdated = timestamp;
  value.domains.sessions = domain([session]);
  value.domains.beacons = domain([beacon]);
  value.domains.jobs = domain([{ id: 4, name: "HTTPS", description: "HTTP listener", protocol: "tcp", port: 443, domains: ["example.test"], profileName: "" }]);
  value.sessions = value.domains.sessions.items;
  value.beacons = value.domains.beacons.items;
  value.jobs = value.domains.jobs.items;
  return value;
}

function byKind(nodes: readonly TopologyNode[], kind: string): TopologyNode {
  const node = nodes.find((candidate) => candidate.kind === kind);
  expect(node).toBeDefined();
  return node!;
}

describe("overview topology adapter", () => {
  it("produces a JSON document using only bounded, safe display fields", () => {
    const source = snapshot();
    source.connection.error = "private diagnostic not needed by graph";
    source.domains.sessions.items = [{ ...session, activeC2: "https://user:private-password@example.test/?token=private-token" }];
    const document = createOverviewTopology(source);
    const json = JSON.stringify(document);
    expect(JSON.parse(json)).toEqual(document);
    expect(document.schemaVersion).toBe(1);
    expect(document.updatedAt).toBe(timestamp);
    expect(json).not.toContain("private-password");
    expect(json).not.toContain("private-token");
    expect(json).not.toContain("private diagnostic");
    expect(document.nodes.map((node) => node.kind)).toEqual(["client", "server", "session", "beacon"]);
    expect(document.nodes.every((node) => node.properties.every(({ value }) => value === null || ["string", "number", "boolean"].includes(typeof value)))).toBe(true);
  });

  it("uses stable identities across updates, reorderings, and reconnect epochs", () => {
    const source = snapshot();
    const first = createOverviewTopology(source);
    source.connection.epoch = 13;
    source.connection.incarnation = 4;
    source.lastUpdated = "2026-09-18T12:02:00.000Z";
    source.domains.sessions.items = [{ ...session, hostname: "renamed-host", lastCheckinAt: source.lastUpdated }];
    const next = createOverviewTopology(source);
    expect(next.scope.id).toBe(first.scope.id);
    expect(next.nodes.map(({ id }) => id)).toEqual(first.nodes.map(({ id }) => id));
    expect(next.edges.map(({ id }) => id)).toEqual(first.edges.map(({ id }) => id));
    expect(byKind(next.nodes, "session").label).toBe("renamed-host");
    expect(byKind(next.nodes, "session").id).not.toBe(byKind(next.nodes, "beacon").id);
  });

  it("scopes identities to the server and config rather than target ids alone", () => {
    const first = snapshot();
    const otherServer = snapshot();
    otherServer.connection.server = "other.example.test:31337";
    const otherConfig = snapshot();
    otherConfig.connection.configName = "other.cfg";
    expect(overviewTopologyScopeId(first)).not.toBe(overviewTopologyScopeId(otherServer));
    expect(overviewTopologyScopeId(first)).not.toBe(overviewTopologyScopeId(otherConfig));
    expect(byKind(createOverviewTopology(first).nodes, "session").id).not.toBe(byKind(createOverviewTopology(otherServer).nodes, "session").id);
  });

  it("keeps AWS network metadata on the cloud and cached instance data on the enclosed server", () => {
    const source = snapshot();
    source.connection.managedServer = {
      provider: "aws", deploymentId: "deployment-1", name: "Office infrastructure",
      overview: { region: "us-west-2", size: "t3.small", instanceState: "running", health: "ok", publicIpAddress: "203.0.113.10", privateIpAddress: "10.0.0.10", updatedAt: timestamp,
        cloud: { provider: "aws", vpcId: "vpc-123", vpcCidr: "10.0.0.0/16" },
        instanceId: "i-123", instanceName: "Office infrastructure", availabilityZone: "us-west-2a", subnetId: "subnet-123" },
    };
    const document = createOverviewTopology(source);
    const cloud = byKind(document.nodes, "cloud");
    const server = byKind(document.nodes, "server");
    expect(cloud).toMatchObject({ role: "group", provider: "aws", icon: "aws", label: "vpc-123", subtitle: "AWS · us-west-2", freshness: "unknown", statusLabel: "VPC" });
    expect(server).toMatchObject({ parentId: cloud.id, status: "healthy", statusLabel: "Connected" });
    expect(cloud).not.toHaveProperty("resource");
    expect(cloud.properties).toEqual([
      { label: "Provider", value: "AWS" }, { label: "Region", value: "us-west-2" },
      { label: "VPC ID", value: "vpc-123" }, { label: "VPC CIDR", value: "10.0.0.0/16" },
      { label: "Cloud metadata updated", value: timestamp },
    ]);
    expect(server.properties).toEqual(expect.arrayContaining([
      { label: "Deployment", value: "Office infrastructure" }, { label: "Instance ID", value: "i-123" },
      { label: "Instance name", value: "Office infrastructure" }, { label: "Availability zone", value: "us-west-2a" },
      { label: "Subnet ID", value: "subnet-123" }, { label: "Instance size", value: "t3.small" },
      { label: "Instance state (cached)", value: "running" }, { label: "Instance health (cached)", value: "ok" },
      { label: "Public IP", value: "203.0.113.10" }, { label: "Private IP", value: "10.0.0.10" },
      { label: "Instance metadata updated", value: timestamp },
    ]));
    expect(document.edges.every((edge) => edge.source !== cloud.id && edge.target !== cloud.id)).toBe(true);

    source.connection.managedServer = { ...source.connection.managedServer!, name: "Renamed VM",
      overview: { ...source.connection.managedServer!.overview!, size: "t3.medium", instanceState: "stopped", health: "impaired", publicIpAddress: "203.0.113.99" } };
    expect(byKind(createOverviewTopology(source).nodes, "cloud")).toEqual(cloud);
    source.connection.managedServer = { ...source.connection.managedServer,
      overview: { ...source.connection.managedServer.overview!, cloud: { provider: "aws", vpcId: "vpc-other" } } };
    expect(byKind(createOverviewTopology(source).nodes, "cloud").id).not.toBe(cloud.id);
  });

  it("uses Azure resource-group scope without attributing VM location, state, or addresses to it", () => {
    const source = snapshot();
    const resourceGroupId = "/subscriptions/sub-1/resourceGroups/team";
    source.connection.managedServer = {
      provider: "azure", deploymentId: "azure-1", name: "App VM", overview: {
        region: "eastus", size: "Standard_B2s", instanceState: "deallocated", publicIpAddress: "203.0.113.20",
        privateIpAddress: "10.1.0.4", updatedAt: timestamp, instanceId: `${resourceGroupId}/providers/Microsoft.Compute/virtualMachines/app`,
        instanceName: "app", subnetId: "subnet-arm-id", cloud: {
          provider: "azure", subscriptionId: "sub-1", resourceGroupName: "team", resourceGroupId,
          virtualNetworkName: "shared-vnet", virtualNetworkId: "vnet-arm-id", virtualNetworkResourceGroup: "networks", virtualNetworkCidr: "10.1.0.0/16",
        },
      },
    };
    const document = createOverviewTopology(source);
    const cloud = byKind(document.nodes, "cloud");
    const server = byKind(document.nodes, "server");
    expect(cloud).toMatchObject({ label: "team", subtitle: "Azure · Resource group", statusLabel: "Resource group", freshness: "unknown" });
    expect(cloud.properties).toEqual([
      { label: "Provider", value: "Azure" }, { label: "Subscription ID", value: "sub-1" },
      { label: "Resource group", value: "team" }, { label: "Resource group ID", value: resourceGroupId },
      { label: "Virtual network", value: "shared-vnet" }, { label: "Virtual network ID", value: "vnet-arm-id" },
      { label: "Virtual network resource group", value: "networks" }, { label: "Virtual network CIDR", value: "10.1.0.0/16" },
      { label: "Cloud metadata updated", value: timestamp },
    ]);
    expect(server.properties).toEqual(expect.arrayContaining([
      { label: "Location", value: "eastus" }, { label: "Instance size", value: "Standard_B2s" },
      { label: "Instance state (cached)", value: "deallocated" }, { label: "Public IP", value: "203.0.113.20" },
    ]));
    const extraResource: TopologyContributor = ({ ids, scopeId }) => ({ nodes: [{
      id: `${scopeId}/other-server`, parentId: ids.cloud, kind: "server", role: "resource", label: "Second VM",
      icon: "server", status: "unknown", statusLabel: "Unknown", freshness: "unknown", properties: [{ label: "Instance size", value: "Other size" }],
    }] });
    const expanded = createOverviewTopology(source, { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, extraResource] });
    expect(expanded.nodes.filter((node) => node.parentId === cloud.id)).toHaveLength(2);
    expect(byKind(expanded.nodes, "cloud")).toEqual(cloud);
  });

  it("renders associated deployments with missing cloud metadata and unmanaged hosting honestly", () => {
    const source = snapshot();
    expect(byKind(createOverviewTopology(source).nodes, "server").subtitle).toBe("Hosting unknown");
    source.connection.managedServer = { provider: "azure", deploymentId: "azure-1", name: "Imported Azure deployment" };
    const cloud = byKind(createOverviewTopology(source).nodes, "cloud");
    expect(cloud).toMatchObject({ provider: "azure", label: "Azure", subtitle: "Azure", statusLabel: "Cloud" });
    expect(cloud.properties).toEqual([{ label: "Provider", value: "Azure" }]);
  });

  it("keeps listener inventory as metadata and never invents listener attribution or pivot hops", () => {
    const source = snapshot();
    source.domains.sessions.items = [{ ...session, transport: "tcppivot" }];
    const document = createOverviewTopology(source);
    const server = byKind(document.nodes, "server");
    const remote = byKind(document.nodes, "session");
    expect(server.properties).toContainEqual({ label: "Listener 4", value: "HTTPS · port 443 · example.test" });
    expect(document.nodes.some((node) => node.kind === "listener")).toBe(false);
    expect(document.edges.find((edge) => edge.target === remote.id)).toMatchObject({ source: server.id, label: "TCP pivot", role: "communication", description: expect.stringContaining("Intermediate hops and listener attribution are unknown") });
    expect(document.edges.every((edge) => !Object.hasOwn(edge, "bandwidth") && !Object.hasOwn(edge, "latency"))).toBe(true);
  });

  it("combines operator presence and nested routes without duplicate server shortcuts or relay actions", () => {
    const source = snapshot();
    const nested = [
      { ...session, id: "entry", hostname: "entry-host" },
      { ...session, id: "middle", hostname: "middle-host", transport: "tcppivot" as const },
      { ...session, id: "deep", hostname: "deep-host", transport: "namedpipe" as const },
      { ...session, id: "branch", hostname: "branch-host", transport: "tcppivot" as const },
    ];
    source.domains.sessions = domain(nested);
    source.domains.operators = domain([
      { id: "operator-a", name: "alice", online: true },
      { id: "operator-b", name: "bob", online: true },
      { id: "operator-c", name: "carol", online: false },
    ]);
    source.pivotTopology = {
      status: "ready", revision: 1, updatedAt: timestamp, truncated: false,
      entries: [
        { peerId: "1", parentPeerId: null, sessionId: "entry", name: "entry" },
        { peerId: "2", parentPeerId: "1", name: "unavailable relay" },
        { peerId: "3", parentPeerId: "2", sessionId: "middle", name: "middle" },
        { peerId: "4", parentPeerId: "3", sessionId: "deep", name: "deep" },
        { peerId: "5", parentPeerId: "1", sessionId: "branch", name: "branch" },
      ],
    };
    const document = createOverviewTopology(source);
    const server = byKind(document.nodes, "server");
    const relay = byKind(document.nodes, "relay");
    const sessionNode = (id: string) => document.nodes.find((node) => node.resource?.kind === "session" && node.resource.id === id)!;
    expect(document.nodes.filter((node) => node.kind === "operator")).toHaveLength(3);
    expect(document.nodes.filter((node) => node.kind === "client")).toHaveLength(1);
    expect(document.edges.filter((edge) => edge.kind === "operator-presence")).toHaveLength(3);
    expect(relay).not.toHaveProperty("resource");
    const hops = document.edges.filter((edge) => edge.kind === "pivot-hop");
    expect(hops.map(({ source, target }) => [source, target])).toEqual([
      [server.id, sessionNode("entry").id],
      [sessionNode("entry").id, relay.id],
      [relay.id, sessionNode("middle").id],
      [sessionNode("middle").id, sessionNode("deep").id],
      [sessionNode("entry").id, sessionNode("branch").id],
    ]);
    for (const target of nested) {
      expect(document.edges.filter((edge) => edge.target === sessionNode(target.id).id)).toHaveLength(1);
    }
    expect(document.edges.find((edge) => edge.target === byKind(document.nodes, "beacon").id)).toMatchObject({
      source: server.id, description: expect.stringContaining("Intermediate hops and listener attribution are unknown"),
    });
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("distinguishes active, dead, periodic, and overdue reports without inferring traffic rates", () => {
    const source = snapshot();
    let document = createOverviewTopology(source);
    expect(document.edges.find((edge) => edge.target === byKind(document.nodes, "session").id)?.state).toBe("live");
    expect(document.edges.find((edge) => edge.target === byKind(document.nodes, "beacon").id)).toMatchObject({ state: "periodic", activityAt: timestamp });
    source.domains.sessions.items = [{ ...session, liveness: "dead" }];
    source.domains.beacons.items = [{ ...beacon, checkinStatus: "overdue" }];
    document = createOverviewTopology(source);
    expect(byKind(document.nodes, "session")).toMatchObject({ status: "inactive", statusLabel: "Dead" });
    expect(byKind(document.nodes, "beacon")).toMatchObject({ status: "warning", statusLabel: "Overdue" });
    expect(document.edges.find((edge) => edge.target === byKind(document.nodes, "session").id)?.state).toBe("inactive");
  });

  it.each(["disconnected", "reconnecting", "incompatible"] as const)("marks retained data stale when %s without asserting remote death", (status) => {
    const source = snapshot();
    source.connection.status = status;
    const document = createOverviewTopology(source);
    expect(document.scope.connected).toBe(false);
    expect(byKind(document.nodes, "session")).toMatchObject({ status: "unknown", freshness: "stale", statusLabel: "Last known: active" });
    expect(byKind(document.nodes, "beacon")).toMatchObject({ status: "unknown", freshness: "stale", statusLabel: "Last known: on time" });
    expect(document.edges.every((edge) => edge.state === "unknown" && edge.freshness === "stale")).toBe(true);
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "connection:stale" }));
  });

  it("uses domain and event freshness independently from server connectivity", () => {
    const source = snapshot();
    source.domains.sessions.status = "error";
    let document = createOverviewTopology(source);
    expect(byKind(document.nodes, "server").status).toBe("healthy");
    expect(byKind(document.nodes, "session").freshness).toBe("stale");
    expect(byKind(document.nodes, "beacon").freshness).toBe("current");
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "sessions:error" }));
    source.eventStream.status = "retrying";
    document = createOverviewTopology(source);
    expect(byKind(document.nodes, "beacon").freshness).toBe("stale");
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "events:stale" }));
  });

  it("keeps refreshed inventory current while a quiet initial stream awaits its first event", () => {
    const source = snapshot();
    source.eventStream = { status: "connecting", attempt: 0 };
    let document = createOverviewTopology(source);
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "events:pending", severity: "info" }));
    expect(document.notices.some((notice) => notice.id === "events:stale")).toBe(false);
    expect(byKind(document.nodes, "session")).toMatchObject({ freshness: "current", statusLabel: "Active" });
    expect(byKind(document.nodes, "beacon")).toMatchObject({ freshness: "current", statusLabel: "On time" });

    source.domains.sessions.status = "error";
    document = createOverviewTopology(source);
    expect(byKind(document.nodes, "session").freshness).toBe("stale");
    expect(byKind(document.nodes, "beacon").freshness).toBe("current");

    source.eventStream.status = "connected";
    document = createOverviewTopology(source);
    expect(document.notices.some((notice) => notice.id.startsWith("events:"))).toBe(false);
  });

  it.each(["retrying", "stopped"] as const)("still warns and marks inventory stale when events are %s", (status) => {
    const source = snapshot();
    source.eventStream = { status, attempt: 1, error: "Stream interrupted" };
    const document = createOverviewTopology(source);
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "events:stale", severity: "warning" }));
    expect(document.notices.some((notice) => notice.id === "events:pending")).toBe(false);
    expect(byKind(document.nodes, "session").freshness).toBe("stale");
    expect(byKind(document.nodes, "beacon").freshness).toBe("stale");
  });

  it("reports partial, loading, and unsupported inventories", () => {
    const source = snapshot();
    source.domains.sessions.page = { limit: 1, total: 42, truncated: true };
    source.domains.sessions.status = "loading";
    source.domains.beacons = { ...domain<BeaconSummary>([]), status: "unsupported" };
    const document = createOverviewTopology(source);
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "sessions:partial", message: "Showing 1 of 42 sessions; this inventory is partial." }));
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "sessions:loading" }));
    expect(document.notices).toContainEqual(expect.objectContaining({ id: "beacons:unsupported" }));
    expect(byKind(document.nodes, "session").freshness).toBe("stale");
    expect(document.nodes.some((node) => node.kind === "beacon")).toBe(false);
  });

  it("does not carry target data into a disconnected snapshot without a server identity", () => {
    const source = disconnectedSnapshot();
    source.domains.sessions = domain([session]);
    const document = createOverviewTopology(source);
    expect(document.scope).toEqual({ id: "disconnected", label: "No server connected", connected: false });
    expect(document.nodes.map(({ kind }) => kind)).toEqual(["client"]);
    expect(document.edges).toEqual([]);
    expect(document.updatedAt).toBeNull();
  });
});

describe("topology contributions", () => {
  const futureContributor: TopologyContributor = ({ ids, scopeId }) => ({
    nodes: [{
      id: `${scopeId}/future-resource`, kind: "future-resource", role: "resource",
      label: "New infrastructure", icon: "future-icon", status: "unknown", statusLabel: "Unknown",
      freshness: "unknown", properties: [{ label: "Display field", value: "Preserved" }],
    }],
    edges: [{
      id: `${scopeId}/future-relationship`, kind: "future-link", role: "relationship",
      source: ids.server, target: `${scopeId}/future-resource`, label: "Associated resource",
      state: "unknown", freshness: "unknown", description: "A metadata relationship; no traffic implied.", properties: [],
    }],
  });

  it("preserves unknown kinds and icon keys as generic renderable display data", () => {
    const document = createOverviewTopology(snapshot(), { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, futureContributor] });
    expect(byKind(document.nodes, "future-resource")).toMatchObject({ label: "New infrastructure", icon: "future-icon", role: "resource" });
    expect(document.edges.find(({ kind }) => kind === "future-link")?.role).toBe("relationship");
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("rejects colliding contribution identities and missing references before rendering", () => {
    expect(() => createOverviewTopology(snapshot(), { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, futureContributor, futureContributor] })).toThrow("Duplicate topology node");
    expect(() => createOverviewTopology(snapshot(), { contributors: [futureContributor] })).toThrow("Missing topology endpoint");
    const invalidParent: TopologyContributor = (context) => ({ nodes: futureContributor(context).nodes!.map((node) => ({ ...node, parentId: "missing-group" })) });
    expect(() => createOverviewTopology(snapshot(), { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, invalidParent] })).toThrow("Invalid topology parent");
  });

  it("rejects containment cycles and non-group parents", () => {
    const cyclic: TopologyContributor = (context) => ({ nodes: futureContributor(context).nodes!.map((node) => ({ ...node, role: "group", parentId: node.id })) });
    expect(() => createOverviewTopology(snapshot(), { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, cyclic] })).toThrow("Cyclic topology containment");
    const nonGroup: TopologyContributor = (context) => ({ nodes: futureContributor(context).nodes!.map((node) => ({ ...node, parentId: context.ids.server })) });
    expect(() => createOverviewTopology(snapshot(), { contributors: [...DEFAULT_OVERVIEW_TOPOLOGY_CONTRIBUTORS, nonGroup] })).toThrow("Invalid topology parent");
  });
});
