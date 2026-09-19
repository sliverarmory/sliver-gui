import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { SliverSnapshot } from "../../../shared/contracts";
import type { OperatorPresenceSummary } from "../../../shared/target-contracts";
import type { TopologyContext } from "./overview-topology";
import { operatorTopologyContributor } from "./operator-topology";

const updatedAt = "2026-09-18T21:00:00.000Z";
const roster: OperatorPresenceSummary[] = [
  { id: "operator-a", name: "alice", online: true },
  { id: "operator-b", name: "bob", online: true },
  { id: "operator-c", name: "alice", online: false },
];

function context(items: OperatorPresenceSummary[] = roster): TopologyContext {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected", managedServer: null, server: "example.test", operator: "alice" };
  snapshot.eventStream = { status: "connected", attempt: 0 };
  snapshot.domains.operators = {
    status: items.length ? "ready" : "empty",
    items,
    page: { limit: 500, total: items.length, truncated: false },
    revision: 7,
    updatedAt,
  };
  return { snapshot, scopeId: "scope-one", connected: true, hasServer: true, ids: { client: "local-client", server: "central-server", cloud: "cloud-enclosure" } };
}

describe("operator topology contributor", () => {
  it("represents every roster identity including duplicate names and the local operator name", () => {
    const input = context();
    const before = JSON.stringify(input.snapshot);
    const contribution = operatorTopologyContributor(input);
    expect(contribution.nodes).toHaveLength(3);
    expect(contribution.nodes?.map(({ label }) => label)).toEqual(["alice", "bob", "alice"]);
    expect(new Set(contribution.nodes?.map(({ id }) => id)).size).toBe(3);
    expect(contribution.nodes?.every((node) => node.kind === "operator" && node.icon === "operator")).toBe(true);
    expect(contribution.nodes?.some((node) => node.id === input.ids.client || node.kind === "client")).toBe(false);
    expect(contribution.nodes?.[0]).toMatchObject({ status: "healthy", statusLabel: "Online", freshness: "current" });
    expect(contribution.nodes?.[2]).toMatchObject({ status: "inactive", statusLabel: "Offline", freshness: "current" });
    expect(JSON.parse(JSON.stringify(contribution))).toEqual(contribution);
    expect(JSON.stringify(input.snapshot)).toBe(before);
  });

  it("keeps presence separate from traffic, endpoint topology, and target ownership", () => {
    const input = context();
    const contribution = operatorTopologyContributor(input);
    for (const edge of contribution.edges ?? []) {
      expect(edge).toMatchObject({ role: "relationship", kind: "operator-presence", target: input.ids.server, state: "unknown" });
      expect(contribution.nodes?.some((node) => node.id === edge.source)).toBe(true);
      expect(edge).not.toHaveProperty("transport");
      expect(edge).not.toHaveProperty("activityAt");
      expect(edge.description).toContain("Endpoint address, traffic, and target ownership are not reported");
    }
    expect(contribution.nodes?.every((node) => node.parentId === undefined)).toBe(true);
    expect(contribution.nodes?.[0]?.properties).toContainEqual({ label: "Inventory updated", value: updatedAt });
  });

  it("has stable identity across roster ordering, renames, check-in refreshes, and reconnect epochs", () => {
    const input = context();
    const first = operatorTopologyContributor(input);
    const reordered = context([...roster].reverse().map((operator) => ({ ...operator, name: `new-${operator.name}` })));
    reordered.snapshot.connection.epoch = 99;
    reordered.snapshot.connection.incarnation = 8;
    reordered.snapshot.domains.operators.revision = 8;
    reordered.snapshot.domains.operators.updatedAt = "2026-09-18T21:02:00.000Z";
    const next = operatorTopologyContributor(reordered);
    expect(new Set(next.nodes?.map(({ id }) => id))).toEqual(new Set(first.nodes?.map(({ id }) => id)));
    expect(new Set(next.edges?.map(({ id }) => id))).toEqual(new Set(first.edges?.map(({ id }) => id)));
    const otherScope = operatorTopologyContributor({ ...input, scopeId: "scope-two" });
    expect(otherScope.nodes?.[0]?.id).not.toBe(first.nodes?.[0]?.id);
  });

  it("uses opaque IDs without conflating similar names or path-like identities", () => {
    const contribution = operatorTopologyContributor(context([
      { id: "one/two", name: "same", online: true },
      { id: "one%2Ftwo", name: "same", online: true },
      { id: 'operator["three"]', name: "", online: true },
    ]));
    expect(new Set(contribution.nodes?.map(({ id }) => id)).size).toBe(3);
    expect(contribution.nodes?.[2]?.label).toBe('operator["three"]');
    expect(contribution.nodes?.[2]?.resource).toEqual({ kind: "operator", id: 'operator["three"]' });
  });

  it.each(["disconnected", "reconnecting"] as const)("marks both online and offline reports last known when %s", (status) => {
    const input = context();
    input.snapshot.connection.status = status;
    const contribution = operatorTopologyContributor({ ...input, connected: false });
    expect(contribution.nodes?.every((node) => node.status === "unknown" && node.freshness === "stale")).toBe(true);
    expect(contribution.nodes?.[0]?.statusLabel).toBe("Last known: online");
    expect(contribution.nodes?.[2]?.statusLabel).toBe("Last known: offline");
    expect(contribution.edges?.every((edge) => edge.state === "unknown" && edge.freshness === "stale")).toBe(true);
  });

  it.each(["retrying", "stopped"] as const)("marks presence stale when live updates are %s", (status) => {
    const input = context();
    input.snapshot.eventStream.status = status;
    expect(operatorTopologyContributor(input).nodes?.every((node) => node.freshness === "stale")).toBe(true);
  });

  it("keeps successfully refreshed presence current while waiting for the first event", () => {
    const input = context();
    input.snapshot.eventStream.status = "connecting";
    expect(operatorTopologyContributor(input).nodes?.every((node) => node.freshness === "current")).toBe(true);
  });

  it("renders an authoritative empty inventory without inventing the local operator", () => {
    expect(operatorTopologyContributor(context([]))).toEqual({ nodes: [], edges: [], notices: [] });
    const input = context();
    expect(operatorTopologyContributor({ ...input, hasServer: false })).toEqual({ nodes: [], edges: [], notices: [] });
  });

  it("reports bounded partial inventories and uses the authoritative domain rather than legacy rows", () => {
    const input = context(roster.slice(0, 1));
    input.snapshot.operators = [...roster, { id: "not-in-domain", name: "legacy", online: true }];
    input.snapshot.domains.operators.page = { limit: 1, total: 7, truncated: true };
    const contribution = operatorTopologyContributor(input);
    expect(contribution.nodes).toHaveLength(1);
    expect(contribution.notices).toContainEqual({ id: "operators:partial", severity: "info", message: "Showing 1 of 7 operators; this inventory is partial." });
    expect(JSON.stringify(contribution)).not.toContain("not-in-domain");
  });

  it.each(["loading", "error", "unsupported"] as const)("reports %s inventory and preserves retained rows as last known", (status) => {
    const input = context();
    input.snapshot.domains.operators.status = status;
    input.snapshot.domains.operators.error = "Private backend diagnostic";
    const contribution = operatorTopologyContributor(input);
    expect(contribution.nodes?.every((node) => node.freshness === "stale" && node.status === "unknown")).toBe(true);
    expect(contribution.notices).toContainEqual(expect.objectContaining({ id: `operators:${status}` }));
    expect(JSON.stringify(contribution)).not.toContain("Private backend diagnostic");
  });

  it("reports loading or failed empty inventories without fabricating a presence node", () => {
    for (const status of ["idle", "loading", "error"] satisfies SliverSnapshot["domains"]["operators"]["status"][]) {
      const input = context([]);
      input.snapshot.domains.operators.status = status;
      delete input.snapshot.domains.operators.updatedAt;
      const contribution = operatorTopologyContributor(input);
      expect(contribution.nodes).toEqual([]);
      expect(contribution.edges).toEqual([]);
      expect(contribution.notices).toHaveLength(1);
    }
  });
});
