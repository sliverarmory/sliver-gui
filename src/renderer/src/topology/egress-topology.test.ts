import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { DomainCollection, SliverSnapshot } from "../../../shared/contracts";
import type { BeaconSummary, SessionSummary } from "../../../shared/target-contracts";
import type { TopologyDocument, TopologyNode } from "../../../shared/topology-contracts";
import { createOverviewTopology } from "./overview-topology";
import { topologyLayoutInput } from "./topology-layout-input";
import { projectTopology, TOPOLOGY_COLLECTION_THRESHOLD } from "./topology-projection";
import type { TopologyFilters } from "./topology-projection";

const timestamp = "2026-09-23T20:00:00.000Z";
const defaults: TopologyFilters = { query: "", kinds: "default", statuses: "all", expanded: new Set() };

function session(id: string, remoteAddress = "192.0.2.10:4444", values: Partial<SessionSummary> = {}): SessionSummary {
  return {
    mode: "session", id, name: id, hostname: `${id}-host`, hostId: `${id}-host-id`, username: "user",
    os: "linux", arch: "amd64", transport: "mtls", remoteAddress, activeC2: "mtls://198.51.100.1:8888",
    executable: "client", version: "1.0.0", locale: "en-US", integrity: "", burned: false,
    liveness: "active", lastCheckinAt: timestamp, ...values,
  };
}

function beacon(id: string, remoteAddress = "192.0.2.10:5000"): BeaconSummary {
  return { ...session(id, remoteAddress), mode: "beacon", transport: "https", checkinStatus: "on-time" };
}

function domain<T>(items: T[]): DomainCollection<T> {
  return { status: items.length ? "ready" : "empty", revision: 1, updatedAt: timestamp, items, page: { limit: 500, total: items.length, truncated: false } };
}

function snapshot(sessions: SessionSummary[], beacons: BeaconSummary[] = []): SliverSnapshot {
  const result = disconnectedSnapshot();
  result.connection = { status: "connected", server: "198.51.100.1:31337", configName: "overview.cfg", managedServer: null };
  result.eventStream = { status: "connected", attempt: 0 };
  result.domains.sessions = domain(sessions);
  result.domains.beacons = domain(beacons);
  result.lastUpdated = timestamp;
  return result;
}

function byResource(document: TopologyDocument, id: string): TopologyNode {
  const found = document.nodes.find((node) => node.resource?.id === id);
  expect(found).toBeDefined();
  return found!;
}

function enclosures(document: TopologyDocument): readonly TopologyNode[] {
  return document.nodes.filter((node) => node.kind === "egress");
}

describe("egress grouping through overview projection", () => {
  it("bundles mixed sessions and beacons by IP while keeping different addresses distinct", () => {
    const source = createOverviewTopology(snapshot([
      session("first"), session("second", "tcp://192.0.2.10:49000"), session("other", "192.0.2.11:4444"),
    ], [beacon("periodic")]));
    const projected = projectTopology(source, defaults).document;
    const groups = enclosures(projected);
    expect(groups.map((node) => node.label)).toEqual(["192.0.2.10", "192.0.2.11"]);
    const shared = groups[0]!;
    expect(shared).toMatchObject({ role: "group", subtitle: "Egress IP · 3 nodes", egressIp: "192.0.2.10" });
    expect(shared).not.toHaveProperty("resource");
    for (const id of ["first", "second", "periodic"]) {
      expect(byResource(projected, id)).toMatchObject({ id: byResource(source, id).id, parentId: shared.id });
    }
    expect(byResource(projected, "other").parentId).toBe(groups[1]!.id);
    const bundles = projected.edges.filter((edge) => edge.kind === "egress-connection");
    expect(bundles).toHaveLength(2);
    expect(bundles.find((edge) => edge.target === shared.id)).toMatchObject({ label: "192.0.2.10 · HTTPS / mTLS", state: "unknown", freshness: "current" });
    expect(bundles.find((edge) => edge.target === shared.id)?.properties).toContainEqual({ label: "Connections", value: 3 });
    expect(projected.edges.some((edge) => edge.kind === "target-communication")).toBe(false);
  });

  it("uses canonical IPv6 metadata for grouping and normalized address search", () => {
    const source = createOverviewTopology(snapshot([
      session("expanded", "[2001:0DB8:0000:0000:0000:0000:0000:000A]:4444"),
      session("compressed", "tcp://[2001:db8::a]:5000"), session("unrelated", "192.0.2.11:4444"),
    ]));
    const projected = projectTopology(source, { ...defaults, query: "2001:db8::a" });
    expect(projected.matchCount).toBe(2);
    expect(enclosures(projected.document).map((node) => node.label)).toEqual(["2001:db8::a"]);
    expect(projected.document.nodes.filter((node) => node.kind === "session").map((node) => node.resource?.id)).toEqual(["expanded", "compressed"]);
    expect(projected.document.edges.filter((edge) => edge.kind === "egress-connection")).toHaveLength(1);
    expect(projected.document.nodes.some((node) => node.kind === "server")).toBe(true);
  });

  it("retains individual logical connections when a reported address is unavailable", () => {
    const source = createOverviewTopology(snapshot([
      session("empty", ""), session("redacted", "[redacted endpoint]"), session("hostname", "example.test:443"),
    ]));
    const projected = projectTopology(source, defaults).document;
    expect(enclosures(projected)).toHaveLength(0);
    expect(projected.edges).toEqual(source.edges);
    expect(projected.nodes).toEqual(source.nodes);
    expect(source.nodes.every((node) => node.egressIp === undefined)).toBe(true);
  });

  it("keeps address and bundle identities stable across ports, updates, and inventory ordering", () => {
    const initial = snapshot([session("first"), session("second", "192.0.2.11:5000")], [beacon("periodic")]);
    const before = projectTopology(createOverviewTopology(initial), defaults).document;
    initial.connection.epoch = 99;
    initial.domains.sessions.items = [
      session("second", "192.0.2.11:52000"), session("first", "192.0.2.10:54000", { hostname: "renamed", lastCheckinAt: "2026-09-23T20:10:00.000Z" }),
    ];
    const after = projectTopology(createOverviewTopology(initial), defaults).document;
    expect(enclosures(after).map((node) => node.id)).toEqual(enclosures(before).map((node) => node.id));
    expect(after.edges.map((edge) => edge.id).sort()).toEqual(before.edges.map((edge) => edge.id).sort());
    expect(byResource(after, "first").id).toBe(byResource(before, "first").id);
  });

  it("does not promote stale or mixed connections into a live address bundle", () => {
    const initial = snapshot([session("first")], [beacon("periodic")]);
    const mixed = projectTopology(createOverviewTopology(initial), defaults).document;
    expect(mixed.edges.find((edge) => edge.kind === "egress-connection")).toMatchObject({ state: "unknown", freshness: "current" });
    initial.domains.sessions.status = "error";
    const stale = projectTopology(createOverviewTopology(initial), defaults).document;
    expect(enclosures(stale)[0]).toMatchObject({ status: "unknown", freshness: "stale", statusLabel: "Last known address" });
    expect(stale.edges.find((edge) => edge.kind === "egress-connection")).toMatchObject({ state: "unknown", freshness: "stale" });
    expect(byResource(stale, "periodic")).toMatchObject({ status: "healthy", freshness: "current" });
  });

  it("preserves the newest reported activity while updates leave bundle identity and layout unchanged", () => {
    const initial = snapshot([
      session("older"), session("newer", "192.0.2.10:5000", { lastCheckinAt: "2026-09-23T20:05:00.000Z" }),
    ]);
    const before = projectTopology(createOverviewTopology(initial), defaults).document;
    const beforeBundle = before.edges.find((edge) => edge.kind === "egress-connection")!;
    expect(beforeBundle.activityAt).toBe("2026-09-23T20:05:00.000Z");
    initial.domains.sessions.items[0] = session("older", "192.0.2.10:4444", { lastCheckinAt: "2026-09-23T20:10:00.000Z" });
    const after = projectTopology(createOverviewTopology(initial), defaults).document;
    expect(after.edges.find((edge) => edge.kind === "egress-connection")).toMatchObject({
      id: beforeBundle.id, activityAt: "2026-09-23T20:10:00.000Z",
    });
    expect(topologyLayoutInput(after)).toEqual(topologyLayoutInput(before));
  });

  it("does not infer activity from node properties when member links have no valid observation", () => {
    const source = createOverviewTopology(snapshot([session("first"), session("second")]));
    const withoutObservations = {
      ...source,
      edges: source.edges.map((edge) => ({ ...edge, activityAt: "invalid timestamp" })),
    };
    const projected = projectTopology(withoutObservations, defaults).document;
    expect(byResource(source, "first").properties).toContainEqual({ label: "Last check-in", value: timestamp });
    expect(projected.edges.find((edge) => edge.kind === "egress-connection")).not.toHaveProperty("activityAt");
  });

  it("does not mutate snapshot, source document, or target identity when grouping", () => {
    const initial = snapshot([session("first"), session("second")], [beacon("periodic")]);
    const snapshotBefore = JSON.stringify(initial);
    const source = createOverviewTopology(initial);
    const sourceBefore = JSON.stringify(source);
    const projected = projectTopology(source, defaults).document;
    expect(JSON.stringify(initial)).toBe(snapshotBefore);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(source.nodes.every((node) => node.parentId === undefined)).toBe(true);
    expect(JSON.parse(JSON.stringify(projected))).toEqual(projected);
  });

  it("retains IP organization for hard type and status filters without restoring excluded resources", () => {
    const source = createOverviewTopology(snapshot([
      session("active"), session("dead", "192.0.2.10:6000", { liveness: "dead" }),
    ], [beacon("periodic")]));
    const projected = projectTopology(source, { ...defaults, kinds: new Set(["session"]), statuses: new Set(["healthy"]) });
    expect(projected.matchCount).toBe(1);
    expect(projected.document.nodes.map((node) => node.kind).sort()).toEqual(["egress", "session"]);
    const group = enclosures(projected.document)[0]!;
    expect(byResource(projected.document, "active").parentId).toBe(group.id);
    expect(group.properties).toContainEqual({ label: "Nodes", value: 1 });
    expect(projected.document.edges).toEqual([]);
    expect(projectTopology(source, { ...defaults, kinds: new Set() }).document.nodes).toEqual([]);
  });

  it("collapses large collections within each IP and retains member counts when expanding", () => {
    const count = TOPOLOGY_COLLECTION_THRESHOLD + 1;
    const source = createOverviewTopology(snapshot(["192.0.2.10", "192.0.2.11"].flatMap((ip, index) =>
      Array.from({ length: count }, (_, member) => session(`group-${index}-${member}`, `${ip}:${5000 + member}`)))));
    const collapsed = projectTopology(source, defaults);
    expect(collapsed.groups.size).toBe(2);
    expect(enclosures(collapsed.document)).toHaveLength(2);
    for (const [id, members] of collapsed.groups) {
      expect(members).toHaveLength(count);
      expect(new Set(members.map((node) => node.egressIp)).size).toBe(1);
      const collection = collapsed.document.nodes.find((node) => node.id === id)!;
      expect(collection.parentId).toBe(enclosures(collapsed.document).find((node) => node.egressIp === members[0]!.egressIp)!.id);
    }
    for (const group of enclosures(collapsed.document)) expect(group.properties).toContainEqual({ label: "Nodes", value: count });
    for (const edge of collapsed.document.edges.filter((item) => item.kind === "egress-connection")) expect(edge).not.toHaveProperty("activityAt");
    const expanded = projectTopology(source, { ...defaults, expanded: new Set(collapsed.groups.keys()) });
    expect(expanded.groups.size).toBe(0);
    expect(expanded.document.nodes.filter((node) => node.kind === "session")).toHaveLength(count * 2);
    expect(enclosures(expanded.document).map((node) => node.id)).toEqual(enclosures(collapsed.document).map((node) => node.id));
    expect(expanded.document.edges.filter((edge) => edge.kind === "egress-connection").map((edge) => edge.id))
      .toEqual(collapsed.document.edges.filter((edge) => edge.kind === "egress-connection").map((edge) => edge.id));
  });

  it("groups a reported entry session but leaves downstream relay and child hops untouched", () => {
    const initial = snapshot([session("entry"), session("child", "192.0.2.10:5500", { transport: "tcppivot" })]);
    initial.pivotTopology = {
      status: "ready", revision: 1, updatedAt: timestamp, truncated: false,
      entries: [
        { peerId: "entry-peer", parentPeerId: null, sessionId: "entry", name: "entry" },
        { peerId: "missing-peer", parentPeerId: "entry-peer", name: "relay" },
        { peerId: "child-peer", parentPeerId: "missing-peer", sessionId: "child", name: "child" },
      ],
    };
    const source = createOverviewTopology(initial);
    const projected = projectTopology(source, defaults).document;
    const child = byResource(projected, "child");
    expect(child.parentId).toBeUndefined();
    expect(byResource(projected, "entry").parentId).toBe(enclosures(projected)[0]!.id);
    expect(enclosures(projected)[0]!.properties).toContainEqual({ label: "Nodes", value: 1 });
    const downstream = source.edges.filter((edge) => edge.kind === "pivot-hop" && edge.target !== byResource(source, "entry").id);
    expect(downstream).toHaveLength(2);
    for (const edge of downstream) expect(projected.edges.find((item) => item.id === edge.id)).toEqual(edge);
    expect(projected.edges.filter((edge) => edge.target === child.id)).toHaveLength(1);
    expect(projected.edges.filter((edge) => edge.kind === "egress-connection")).toHaveLength(1);
  });
});
