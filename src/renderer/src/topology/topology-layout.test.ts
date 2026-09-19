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
});
