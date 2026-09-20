import { describe, expect, it } from "vitest";

import type { TopologyDocument, TopologyEdge, TopologyNode } from "../../../shared/topology-contracts";
import { projectTopology, TOPOLOGY_COLLECTION_THRESHOLD } from "./topology-projection";
import type { TopologyFilters } from "./topology-projection";

const defaults: TopologyFilters = { query: "", kinds: "default", statuses: "all", expanded: new Set() };

function node(id: string, values: Partial<TopologyNode> = {}): TopologyNode {
  return { id, kind: "future-kind", role: "resource", label: id, icon: "future-icon", status: "healthy", statusLabel: "Available", freshness: "current", properties: [], ...values };
}

function edge(id: string, source: string, target: string, values: Partial<TopologyEdge> = {}): TopologyEdge {
  return { id, kind: "future-link", role: "relationship", source, target, label: "Related", state: "live", freshness: "current", description: "Verified relationship", activityAt: "2026-09-18T12:00:00.000Z", properties: [], ...values };
}

function communication(id: string, source: string, target: string): TopologyEdge {
  return edge(id, source, target, { role: "communication", label: "Reported channel" });
}

function document(nodes: TopologyNode[], edges: TopologyEdge[]): TopologyDocument {
  return { schemaVersion: 1, scope: { id: "scope", label: "test", connected: true }, updatedAt: null, nodes, edges, notices: [] };
}

function star(count = TOPOLOGY_COLLECTION_THRESHOLD + 1): TopologyDocument {
  return document(
    [node("hub", { kind: "server" }), ...Array.from({ length: count }, (_, i) => node(`resource-${i}`))],
    Array.from({ length: count }, (_, i) => edge(`edge-${i}`, "hub", `resource-${i}`)),
  );
}

describe("topology projection", () => {
  it("collapses unknown resource kinds without mutating source records or inventing activity", () => {
    const source = star();
    const before = JSON.stringify(source);
    const projection = projectTopology(source, defaults);
    expect(projection.groups.size).toBe(1);
    expect(projection.document.nodes).toHaveLength(2);
    expect(projection.document.edges).toHaveLength(1);
    const aggregate = projection.document.nodes.find(({ id }) => id !== "hub")!;
    expect(aggregate).toMatchObject({ kind: "future-kind", icon: "future-icon", label: "13 resources", status: "healthy" });
    expect(aggregate.properties).toContainEqual({ label: "Healthy", value: 13 });
    expect(projection.groups.get(aggregate.id)?.map(({ id }) => id)).toEqual(source.nodes.slice(1).map(({ id }) => id));
    expect(projection.document.edges[0]).toMatchObject({ role: "relationship", properties: [{ label: "Relationship", value: "Grouped association" }, { label: "Links", value: 13 }] });
    expect(Object.hasOwn(projection.document.edges[0]!, "activityAt")).toBe(false);
    expect(JSON.parse(JSON.stringify(projection.document))).toEqual(projection.document);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("uses the threshold and preserves original identities when a collection is expanded", () => {
    expect(projectTopology(star(TOPOLOGY_COLLECTION_THRESHOLD), defaults).groups.size).toBe(0);
    const source = star();
    const collapsed = projectTopology(source, defaults);
    const expanded = projectTopology(source, { ...defaults, expanded: new Set(collapsed.groups.keys()) });
    expect(expanded.document.nodes).toEqual(source.nodes);
    expect(expanded.document.edges).toEqual(source.edges);
    expect(expanded.groups.size).toBe(0);
  });

  it("keeps mixed edge states and freshness conservative and independent of input order", () => {
    const source = star();
    const values = ["live", "periodic", "unknown", "inactive"] as const;
    const mixed = { ...source, edges: source.edges.map((item, index) => ({ ...item, state: values[index % values.length]!, freshness: index === 0 ? "unknown" as const : "current" as const })) };
    const forward = projectTopology(mixed, defaults);
    const reversed = projectTopology({ ...mixed, nodes: [...mixed.nodes].reverse(), edges: [...mixed.edges].reverse() }, defaults);
    expect(forward.document.edges).toEqual(reversed.document.edges);
    expect(forward.document.edges[0]).toMatchObject({ state: "unknown", freshness: "unknown" });
    const stale = projectTopology({ ...mixed, edges: mixed.edges.map((item, index) => index === 1 ? { ...item, freshness: "stale" } : item) }, defaults);
    expect(stale.document.edges[0]?.freshness).toBe("stale");
  });

  it("summarizes warning and stale nodes in a collection", () => {
    const source = star();
    const projected = projectTopology({ ...source, nodes: source.nodes.map((item, index) => index === 1 ? { ...item, status: "warning", freshness: "stale" } : item) }, defaults);
    expect(projected.document.nodes.find(({ id }) => id !== "hub")).toMatchObject({ status: "warning", statusLabel: "1 need attention", freshness: "stale" });
  });

  it.each(["direction", "transport", "role", "kind", "label", "parent"] as const)("does not merge separate %s relationships into apparent shared routes", (dimension) => {
    const source = star(14);
    let nodes = [...source.nodes];
    let edges = [...source.edges];
    if (dimension === "parent") {
      nodes = [...nodes.map((item, index) => index > 0 ? { ...item, parentId: index <= 7 ? "group-a" : "group-b" } : item), node("group-a", { role: "group" }), node("group-b", { role: "group" })];
    } else edges = edges.map((item, index) => {
      if (index < 7) return item;
      if (dimension === "direction") return { ...item, source: item.target, target: item.source };
      if (dimension === "transport") return { ...item, transport: "https" };
      if (dimension === "role") return { ...item, role: "communication" };
      if (dimension === "kind") return { ...item, kind: "different-relationship" };
      return { ...item, label: "Different semantics" };
    });
    const projected = projectTopology({ ...source, nodes, edges }, defaults);
    expect(projected.groups.size).toBe(0);
    expect(projected.document.edges).toEqual(edges);
  });

  it("does not collapse nodes with multiple neighbors", () => {
    const source = star();
    const extra = node("other-hub", { kind: "server" });
    const edges = [...source.edges, ...source.nodes.slice(1).map((item) => edge(`extra-${item.id}`, extra.id, item.id))];
    expect(projectTopology({ ...source, nodes: [...source.nodes, extra], edges }, defaults).groups.size).toBe(0);
  });

  it("filters using generic properties and retains one-hop relationship and ancestor context", () => {
    const source = document([
      node("outer", { role: "group" }),
      node("cloud", { role: "group", parentId: "outer" }),
      node("server", { kind: "server", parentId: "cloud" }),
      node("match", { status: "warning", properties: [{ label: "Region", value: "NEEDLE" }] }),
      node("other"), node("client"),
    ], [edge("first", "server", "match"), edge("other-link", "server", "other"), edge("operator", "client", "server")]);
    const result = projectTopology(source, {
      ...defaults, query: " needle ", kinds: new Set(["future-kind", "server"]), statuses: new Set(["healthy", "warning"]),
    });
    expect(result.matchCount).toBe(1);
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["outer", "cloud", "server", "match"]);
    expect(result.document.edges.map(({ id }) => id)).toEqual(["first"]);
    expect(result.groups.size).toBe(0);
  });

  it.each([false, true])("retains every upstream communication hop and its enclosures independent of edge order (reverse=%s)", (reverse) => {
    const links = [
      communication("operator", "client", "root"),
      communication("first-hop", "root", "relay-a"),
      communication("second-hop", "relay-a", "relay-b"),
      communication("third-hop", "relay-b", "match"),
      communication("other-branch", "relay-a", "other"),
    ];
    const source = document([
      node("outer", { role: "group" }),
      node("cloud", { role: "group", parentId: "outer" }),
      node("client"), node("root", { parentId: "cloud" }),
      node("relay-a"), node("relay-b"),
      node("match", { status: "warning", properties: [{ label: "Location", value: "Needle" }] }),
      node("other"),
    ], reverse ? [...links].reverse() : links);
    const before = JSON.stringify(source);
    const result = projectTopology(source, { ...defaults, query: "needle" });
    expect(result.matchCount).toBe(1);
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["outer", "cloud", "client", "root", "relay-a", "relay-b", "match"]);
    expect(new Set(result.document.edges.map(({ id }) => id))).toEqual(new Set(["operator", "first-hop", "second-hop", "third-hop"]));
    expect(result.document.edges.every((item) => source.edges.includes(item))).toBe(true);
    expect(result.groups.size).toBe(0);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps every reported upstream branch to a match without pulling in unrelated downstream branches", () => {
    const source = document([
      node("root"), node("relay"), node("left"), node("right"),
      node("match", { label: "Needle" }), node("unrelated"),
      node("immediate-child"), node("deeper-child"),
    ], [
      communication("first", "root", "relay"),
      communication("left-branch", "relay", "left"),
      communication("right-branch", "relay", "right"),
      communication("left-route", "left", "match"),
      communication("right-route", "right", "match"),
      communication("unrelated-route", "left", "unrelated"),
      communication("child", "match", "immediate-child"),
      communication("grandchild", "immediate-child", "deeper-child"),
    ]);
    const result = projectTopology(source, { ...defaults, query: "needle" });
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["root", "relay", "left", "right", "match", "immediate-child"]);
    expect(result.document.edges.map(({ id }) => id)).toEqual(["first", "left-branch", "right-branch", "left-route", "right-route", "child"]);
    expect(result.matchCount).toBe(1);
  });

  it("terminates upstream filtering through communication cycles and self-links", () => {
    const source = document([
      node("root"), node("a"), node("b"), node("match", { label: "Needle" }), node("other"),
    ], [
      communication("root-a", "root", "a"), communication("a-b", "a", "b"),
      communication("b-match", "b", "match"), communication("cycle", "match", "a"),
      communication("self", "match", "match"), communication("other", "b", "other"),
    ]);
    const result = projectTopology(source, { ...defaults, query: "needle" });
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["root", "a", "b", "match"]);
    expect(result.document.edges.map(({ id }) => id)).toEqual(["root-a", "a-b", "b-match", "cycle", "self"]);
    expect(result.matchCount).toBe(1);
  });

  it("omits missing endpoints without inventing a route across the gap", () => {
    const source = document([node("root"), node("relay"), node("match", { label: "Needle" })], [
      communication("known", "root", "relay"),
      communication("missing-child", "relay", "missing"),
      communication("missing-parent", "missing", "match"),
      communication("other-missing", "match", "also-missing"),
    ]);
    const result = projectTopology(source, { ...defaults, query: "needle" });
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["match"]);
    expect(result.document.edges).toEqual([]);
    expect(projectTopology(source, defaults).document.edges.map(({ id }) => id)).toEqual(["known"]);
  });

  it("collapses terminal children separately at each parent while retaining the relay chain", () => {
    const count = TOPOLOGY_COLLECTION_THRESHOLD + 1;
    const rootLeaves = Array.from({ length: count }, (_, i) => node(`root-leaf-${i}`));
    const relayLeaves = Array.from({ length: count }, (_, i) => node(`relay-leaf-${i}`));
    const chain = [communication("first", "root", "relay-a"), communication("second", "relay-a", "relay-b")];
    const source = document([node("root"), node("relay-a"), node("relay-b"), ...rootLeaves, ...relayLeaves], [
      ...chain,
      ...rootLeaves.map((item) => communication(`edge-${item.id}`, "root", item.id)),
      ...relayLeaves.map((item) => communication(`edge-${item.id}`, "relay-b", item.id)),
    ]);
    const result = projectTopology(source, defaults);
    expect(result.groups.size).toBe(2);
    expect(result.document.nodes).toHaveLength(5);
    expect(result.document.nodes.slice(0, 3)).toEqual(source.nodes.slice(0, 3));
    expect(result.document.edges.slice(0, 2)).toEqual(chain);
    expect(result.document.edges).toHaveLength(4);
    for (const [id, members] of result.groups) {
      const peer = members[0]!.id.startsWith("root-") ? "root" : "relay-b";
      expect(members).toEqual(peer === "root" ? rootLeaves : relayLeaves);
      expect(result.document.edges.find((item) => item.target === id)?.source).toBe(peer);
    }
    const expanded = projectTopology(source, { ...defaults, expanded: new Set(result.groups.keys()) });
    expect(expanded.document.nodes).toEqual(source.nodes);
    expect(expanded.document.edges).toEqual(source.edges);
  });

  it("never combines upstream roots that each have one outgoing communication link", () => {
    const roots = Array.from({ length: TOPOLOGY_COLLECTION_THRESHOLD + 1 }, (_, i) => node(`root-${i}`));
    const source = document([...roots, node("destination")], roots.map((item) => communication(`edge-${item.id}`, item.id, "destination")));
    const result = projectTopology(source, defaults);
    expect(result.groups.size).toBe(0);
    expect(result.document.nodes).toEqual(source.nodes);
    expect(result.document.edges).toEqual(source.edges);
  });

  it("keeps intermediate branching resources explicit even when they have the same presentation as leaves", () => {
    const relays = Array.from({ length: TOPOLOGY_COLLECTION_THRESHOLD + 1 }, (_, i) => node(`relay-${i}`));
    const source = document([node("root"), ...relays, node("destination")], relays.flatMap((item) => [
      communication(`incoming-${item.id}`, "root", item.id),
      communication(`outgoing-${item.id}`, item.id, "destination"),
    ]));
    const result = projectTopology(source, defaults);
    expect(result.groups.size).toBe(0);
    expect(result.document.nodes).toEqual(source.nodes);
    expect(result.document.edges).toEqual(source.edges);
  });

  it("does not treat partially known relays as terminal collection members", () => {
    const relays = Array.from({ length: TOPOLOGY_COLLECTION_THRESHOLD + 1 }, (_, i) => node(`relay-${i}`));
    const knownLinks = relays.map((item) => communication(`incoming-${item.id}`, "root", item.id));
    const source = document([node("root"), ...relays], [
      ...knownLinks,
      ...relays.map((item) => communication(`outgoing-${item.id}`, item.id, `missing-${item.id}`)),
    ]);
    const result = projectTopology(source, defaults);
    expect(result.groups.size).toBe(0);
    expect(result.document.nodes).toEqual(source.nodes);
    expect(result.document.edges).toEqual(knownLinks);
  });

  it("retains descendants of matching groups without recursively adding their network peers", () => {
    const source = document([
      node("cloud", { role: "group", kind: "cloud" }),
      node("nested", { role: "group", parentId: "cloud" }),
      node("server", { kind: "server", parentId: "nested" }),
      node("remote"),
    ], [edge("link", "server", "remote")]);
    const result = projectTopology(source, { ...defaults, query: "cloud" });
    expect(result.matchCount).toBe(1);
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["cloud", "nested", "server"]);
    expect(result.document.edges).toEqual([]);
  });

  it("returns an empty projection when nothing matches and leaves matching leaves expanded", () => {
    const source = star();
    const none = projectTopology(source, { ...defaults, query: "absent" });
    expect(none.document.nodes).toEqual([]);
    expect(none.document.edges).toEqual([]);
    expect(none.matchCount).toBe(0);
    const allLeaves = projectTopology(source, { ...defaults, kinds: new Set(["future-kind"]) });
    expect(allLeaves.document.nodes).toEqual(source.nodes.slice(1));
    expect(allLeaves.document.edges).toEqual([]);
    expect(allLeaves.groups.size).toBe(0);
    expect(allLeaves.matchCount).toBe(13);
  });

  it("unions selected types while excluding connected nodes of unselected types", () => {
    const source = document([
      node("client", { kind: "client" }), node("server", { kind: "server" }),
      node("operator", { kind: "operator" }), node("future", { kind: "future-kind" }),
      node("offline", { kind: "operator", filterKind: "operator-offline", status: "inactive" }),
      node("stale-offline", { kind: "operator", filterKind: "operator-offline", status: "unknown", freshness: "stale" }),
    ], [communication("client-server", "client", "server"), edge("server-operator", "server", "operator"),
      edge("server-offline", "server", "offline"), edge("server-stale-offline", "server", "stale-offline")]);
    const result = projectTopology(source, { ...defaults, kinds: new Set(["client", "server"]) });
    expect(result.document.nodes).toEqual(source.nodes.slice(0, 2));
    expect(result.document.edges).toEqual(source.edges.slice(0, 1));
    expect(result.matchCount).toBe(2);
    const defaultProjection = projectTopology(source, defaults);
    expect(defaultProjection.document.nodes).toEqual(source.nodes.slice(0, 4));
    expect(defaultProjection.document.edges).toEqual(source.edges.slice(0, 2));
    expect(projectTopology(source, { ...defaults, query: "server" }).document.nodes).not.toContain(source.nodes[4]);
    expect(projectTopology(source, { ...defaults, kinds: "all" }).document.nodes).toEqual(source.nodes);
    expect(projectTopology(source, { ...defaults, kinds: new Set(["operator"]) }).document.nodes).toEqual([source.nodes[2]]);
    const offlineOnly = projectTopology(source, { ...defaults, kinds: new Set(["operator-offline"]) });
    expect(offlineOnly.document.nodes).toEqual(source.nodes.slice(4));
    expect(offlineOnly.document.edges).toEqual([]);
  });

  it("unions selected states and intersects the result with selected types", () => {
    const source = document([
      node("healthy-server", { kind: "server", status: "healthy" }),
      node("warning-server", { kind: "server", status: "warning" }),
      node("inactive-server", { kind: "server", status: "inactive" }),
      node("healthy-client", { kind: "client", status: "healthy" }),
      node("unknown-client", { kind: "client", status: "unknown" }),
      node("warning-operator", { kind: "operator", status: "warning" }),
    ], []);
    const statuses = new Set(["healthy", "warning"]);
    const statesOnly = projectTopology(source, { ...defaults, statuses });
    expect(statesOnly.document.nodes.map(({ id }) => id)).toEqual(["healthy-server", "warning-server", "healthy-client", "warning-operator"]);
    expect(statesOnly.matchCount).toBe(4);
    const combined = projectTopology(source, { ...defaults, kinds: new Set(["server", "client"]), statuses });
    expect(combined.document.nodes.map(({ id }) => id)).toEqual(["healthy-server", "warning-server", "healthy-client"]);
    expect(combined.matchCount).toBe(3);
  });

  it.each(["kinds", "statuses"] as const)("shows no nodes when no %s are selected", (dimension) => {
    const source = document([node("parent", { role: "group" }), node("child", { parentId: "parent" })], [edge("link", "parent", "child")]);
    const result = projectTopology(source, { ...defaults, [dimension]: new Set<string>() });
    expect(result.document.nodes).toEqual([]);
    expect(result.document.edges).toEqual([]);
    expect(result.matchCount).toBe(0);
    expect(result.groups.size).toBe(0);
  });

  it("never restores unselected types through matching enclosures, neighbors, or ancestors", () => {
    const source = document([
      node("cloud", { role: "group", kind: "cloud", label: "Needle cloud" }),
      node("server", { kind: "server", parentId: "cloud", label: "Needle server" }),
      node("nested", { role: "group", kind: "cloud", parentId: "server" }),
      node("client", { kind: "client" }),
      node("match", { kind: "server", label: "Needle match" }),
      node("operator", { kind: "operator" }),
    ], [communication("client-server", "client", "server"), edge("server-operator", "server", "operator")]);
    const before = JSON.stringify(source);
    const result = projectTopology(source, { ...defaults, query: "needle", kinds: new Set(["server"]) });
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["server", "match"]);
    expect(result.document.nodes[0]).not.toHaveProperty("parentId");
    expect(result.document.nodes[1]).toBe(source.nodes[4]);
    expect(result.document.edges).toEqual([]);
    expect(result.matchCount).toBe(2);
    expect(JSON.stringify(source)).toBe(before);

    const groupsOnly = projectTopology(source, { ...defaults, query: "needle", kinds: new Set(["cloud"]) });
    expect(groupsOnly.document.nodes.map(({ id }) => id)).toEqual(["cloud", "nested"]);
    expect(groupsOnly.document.nodes[1]).not.toHaveProperty("parentId");
    expect(groupsOnly.matchCount).toBe(1);
  });

  it("never restores unselected states or bridges an excluded communication hop for search context", () => {
    const source = document([
      node("upstream", { status: "healthy" }),
      node("hidden-relay", { status: "inactive" }),
      node("group", { role: "group", status: "inactive" }),
      node("match", { label: "Needle", status: "warning", parentId: "group" }),
      node("permitted-child", { status: "healthy" }),
      node("hidden-child", { status: "unknown" }),
    ], [
      communication("upstream-relay", "upstream", "hidden-relay"),
      communication("relay-match", "hidden-relay", "match"),
      edge("permitted-link", "match", "permitted-child"),
      edge("hidden-link", "match", "hidden-child"),
    ]);
    const result = projectTopology(source, { ...defaults, query: "needle", statuses: new Set(["healthy", "warning"]) });
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["match", "permitted-child"]);
    expect(result.document.nodes[0]).not.toHaveProperty("parentId");
    expect(result.document.edges).toEqual([source.edges[2]]);
    expect(result.matchCount).toBe(1);
  });
});
