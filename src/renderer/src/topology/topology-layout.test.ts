import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import { createOverviewTopology } from "./overview-topology";
import { layoutTopology } from "./topology-layout";
import { topologyLayoutInput } from "./topology-layout-input";
import type { LayoutNode, TopologyLayoutInput } from "./topology-layout-input";

function find(nodes: LayoutNode[], id: string): LayoutNode {
  const found = nodes.find((node) => node.id === id);
  expect(found).toBeDefined();
  return found!;
}

describe("topology worker input", () => {
  it("includes only node identity, hierarchy, and layout edges", () => {
    const source = disconnectedSnapshot();
    source.connection = { status: "connected", managedServer: { provider: "aws", deploymentId: "deployment-1", name: "Sensitive deployment label" }, operator: "Operator display name", server: "example.test", configName: "secret-config-label.cfg" };
    const document = createOverviewTopology(source);
    const input = topologyLayoutInput({ ...document, edges: [...document.edges, { ...document.edges[0]!, id: "containment", role: "containment" }] });
    expect(input.nodes.every((node) => Object.keys(node).every((key) => ["id", "role", "parentId"].includes(key)))).toBe(true);
    expect(input.edges.every((edge) => Object.keys(edge).every((key) => ["id", "source", "target"].includes(key)))).toBe(true);
    expect(input.edges.some((edge) => edge.id === "containment")).toBe(false);
    expect(JSON.stringify(input)).not.toContain("Sensitive deployment label");
    expect(JSON.stringify(input)).not.toContain("Operator display name");
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });

  it("forwards only numeric label geometry for IP connections while retaining display text in the UI", () => {
    const source = disconnectedSnapshot();
    source.connection = { status: "connected", managedServer: null, server: "control.example.test" };
    const document = createOverviewTopology(source);
    const label = "2001:db8:abcd:1234:abcd:1234:abcd:1234 · HTTPS / mTLS";
    const input = topologyLayoutInput({ ...document, edges: [
      ...document.edges,
      { ...document.edges[0]!, id: "egress-link", kind: "egress-connection", label },
    ] });
    const bundled = input.edges.find((edge) => edge.id === "egress-link")!;
    expect(typeof bundled.labelWidth).toBe("number");
    expect(bundled.labelWidth).toBeGreaterThan(300);
    expect(input.edges.filter((edge) => edge.id !== "egress-link").every((edge) => edge.labelWidth === undefined)).toBe(true);
    expect(input.edges.every((edge) => Object.keys(edge).every((key) => ["id", "source", "target", "labelWidth"].includes(key)))).toBe(true);
    expect(JSON.stringify(input)).not.toContain(label);
    expect(JSON.stringify(input)).not.toContain("egress-connection");
    expect(JSON.parse(JSON.stringify(input))).toEqual(input);
  });
});

describe("real ELK topology layout", () => {
  it("handles an empty graph without invoking layout", async () => {
    await expect(layoutTopology({ nodes: [], edges: [] })).resolves.toEqual([]);
  });

  it("places nested cloud resources within their parent coordinates and lays out crossing communication", async () => {
    const input: TopologyLayoutInput = {
      nodes: [
        { id: "client", role: "resource" },
        { id: "cloud", role: "group" },
        { id: "network", role: "group", parentId: "cloud" },
        { id: "server", role: "resource", parentId: "network" },
        { id: "remote", role: "resource" },
      ],
      edges: [
        { id: "operator", source: "client", target: "server" },
        { id: "reported", source: "server", target: "remote" },
      ],
    };
    const result = await layoutTopology(input);
    expect(new Set(result.map(({ id }) => id))).toEqual(new Set(input.nodes.map(({ id }) => id)));
    for (const node of result) {
      expect([node.x, node.y, node.width, node.height].every(Number.isFinite)).toBe(true);
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
    const cloud = find(result, "cloud");
    const network = find(result, "network");
    const server = find(result, "server");
    expect(network.x).toBeGreaterThanOrEqual(28);
    expect(network.y).toBeGreaterThanOrEqual(88);
    expect(network.x + network.width).toBeLessThanOrEqual(cloud.width);
    expect(network.y + network.height).toBeLessThanOrEqual(cloud.height);
    expect(server.x).toBeGreaterThanOrEqual(28);
    expect(server.y).toBeGreaterThanOrEqual(88);
    expect(server.x + server.width).toBeLessThanOrEqual(network.width);
    expect(server.y + server.height).toBeLessThanOrEqual(network.height);
    expect(cloud.x + network.x + server.x).toBeGreaterThan(find(result, "client").x);
    expect(find(result, "remote").x).toBeGreaterThan(cloud.x + network.x + server.x);
  });

  it("provides visible geometry for a group with no children and standalone resources", async () => {
    const result = await layoutTopology({ nodes: [{ id: "empty-cloud", role: "group" }, { id: "standalone", role: "resource" }], edges: [] });
    expect(find(result, "empty-cloud").width).toBeGreaterThanOrEqual(236);
    expect(find(result, "empty-cloud").height).toBeGreaterThanOrEqual(112);
    expect(find(result, "standalone")).toMatchObject({ width: 236, height: 112 });
  });

  it("lays out separate IP enclosures connected to a cloud-enclosed server", async () => {
    const input: TopologyLayoutInput = {
      nodes: [
        { id: "client", role: "resource" },
        { id: "cloud", role: "group" },
        { id: "server", role: "resource", parentId: "cloud" },
        { id: "egress-a", role: "group" },
        { id: "session-a", role: "resource", parentId: "egress-a" },
        { id: "beacon-a", role: "resource", parentId: "egress-a" },
        { id: "egress-b", role: "group" },
        { id: "session-b", role: "resource", parentId: "egress-b" },
      ],
      edges: [
        { id: "operator", source: "client", target: "server" },
        { id: "address-a", source: "server", target: "egress-a", labelWidth: 260 },
        { id: "address-b", source: "server", target: "egress-b", labelWidth: 140 },
      ],
    };
    const result = await layoutTopology(input);
    expect(new Set(result.map(({ id }) => id))).toEqual(new Set(input.nodes.map(({ id }) => id)));
    for (const node of input.nodes.filter((item) => item.parentId)) {
      const child = find(result, node.id);
      const parent = find(result, node.parentId!);
      expect(child.x).toBeGreaterThanOrEqual(28);
      expect(child.y).toBeGreaterThanOrEqual(88);
      expect(child.x + child.width).toBeLessThanOrEqual(parent.width);
      expect(child.y + child.height).toBeLessThanOrEqual(parent.height);
    }
    const cloud = find(result, "cloud");
    const a = find(result, "egress-a");
    const b = find(result, "egress-b");
    // Both separate connections have enough horizontal room for the longest
    // address label and its clearance, including the cloud enclosure boundary.
    expect(a.x - cloud.x - cloud.width).toBeGreaterThanOrEqual(260 + 48);
    expect(b.x - cloud.x - cloud.width).toBeGreaterThanOrEqual(260 + 48);
    expect(a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
  });

  it("retains an outgoing relay path from a session inside an IP enclosure", async () => {
    const input: TopologyLayoutInput = {
      nodes: [
        { id: "server", role: "resource" },
        { id: "egress", role: "group" },
        { id: "entry", role: "resource", parentId: "egress" },
        { id: "peer", role: "resource", parentId: "egress" },
        { id: "relay", role: "resource" },
        { id: "child", role: "resource" },
      ],
      edges: [
        { id: "address", source: "server", target: "egress" },
        { id: "entry-relay", source: "entry", target: "relay" },
        { id: "relay-child", source: "relay", target: "child" },
      ],
    };
    const result = await layoutTopology(input);
    expect(new Set(result.map(({ id }) => id))).toEqual(new Set(input.nodes.map(({ id }) => id)));
    const group = find(result, "egress");
    const entry = find(result, "entry");
    const relay = find(result, "relay");
    expect(entry.x + entry.width).toBeLessThanOrEqual(group.width);
    expect(entry.y + entry.height).toBeLessThanOrEqual(group.height);
    expect(group.x).toBeGreaterThan(find(result, "server").x);
    expect(relay.x).toBeGreaterThan(group.x + entry.x + entry.width);
    expect(find(result, "child").x).toBeGreaterThan(relay.x + relay.width);
  });

  it("lays out a multi-hop communication chain and its branching path without dropping intermediate nodes", async () => {
    const input: TopologyLayoutInput = {
      nodes: ["root", "a", "b", "c", "leaf", "branch", "branch-leaf"].map((id) => ({ id, role: "resource" })),
      edges: [
        { id: "root-a", source: "root", target: "a" },
        { id: "a-b", source: "a", target: "b" },
        { id: "b-c", source: "b", target: "c" },
        { id: "c-leaf", source: "c", target: "leaf" },
        { id: "a-branch", source: "a", target: "branch" },
        { id: "branch-leaf", source: "branch", target: "branch-leaf" },
      ],
    };
    const result = await layoutTopology(input);
    expect(new Set(result.map(({ id }) => id))).toEqual(new Set(input.nodes.map(({ id }) => id)));
    for (const edge of input.edges) {
      const from = find(result, edge.source);
      const to = find(result, edge.target);
      expect(to.x).toBeGreaterThan(from.x + from.width);
    }
    const b = find(result, "b");
    const branch = find(result, "branch");
    expect(b.y + b.height <= branch.y || branch.y + branch.height <= b.y).toBe(true);
  });
});
