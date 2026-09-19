import { describe, expect, it } from "vitest";

import type { TopologyDocument, TopologyEdge, TopologyNode } from "../../../shared/topology-contracts";
import { projectTopology, TOPOLOGY_COLLECTION_THRESHOLD } from "./topology-projection";
import type { TopologyFilters } from "./topology-projection";

const defaults: TopologyFilters = { query: "", kind: "all", status: "all", expanded: new Set() };

function node(id: string, values: Partial<TopologyNode> = {}): TopologyNode {
  return { id, kind: "future-kind", role: "resource", label: id, icon: "future-icon", status: "healthy", statusLabel: "Available", freshness: "current", properties: [], ...values };
}

function edge(id: string, source: string, target: string, values: Partial<TopologyEdge> = {}): TopologyEdge {
  return { id, kind: "future-link", role: "relationship", source, target, label: "Related", state: "live", freshness: "current", description: "Verified relationship", activityAt: "2026-09-18T12:00:00.000Z", properties: [], ...values };
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

  it("filters using generic properties and retains only one-hop and ancestor context", () => {
    const source = document([
      node("outer", { role: "group" }),
      node("cloud", { role: "group", parentId: "outer" }),
      node("server", { kind: "server", parentId: "cloud" }),
      node("match", { status: "warning", properties: [{ label: "Region", value: "NEEDLE" }] }),
      node("other"), node("client"),
    ], [edge("first", "server", "match"), edge("other-link", "server", "other"), edge("operator", "client", "server")]);
    const result = projectTopology(source, { ...defaults, query: " needle ", kind: "future-kind", status: "warning" });
    expect(result.matchCount).toBe(1);
    expect(result.document.nodes.map(({ id }) => id)).toEqual(["outer", "cloud", "server", "match"]);
    expect(result.document.edges.map(({ id }) => id)).toEqual(["first"]);
    expect(result.groups.size).toBe(0);
  });

  it("retains descendants of matching groups without recursively adding their network peers", () => {
    const source = document([
      node("cloud", { role: "group", kind: "cloud" }),
      node("nested", { role: "group", parentId: "cloud" }),
      node("server", { kind: "server", parentId: "nested" }),
      node("remote"),
    ], [edge("link", "server", "remote")]);
    const result = projectTopology(source, { ...defaults, kind: "cloud" });
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
    const allLeaves = projectTopology(source, { ...defaults, kind: "future-kind" });
    expect(allLeaves.document.nodes).toEqual(source.nodes);
    expect(allLeaves.groups.size).toBe(0);
    expect(allLeaves.matchCount).toBe(13);
  });
});
