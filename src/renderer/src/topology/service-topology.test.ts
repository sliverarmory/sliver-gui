import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { disconnectedSnapshot, type DomainCollection } from "../../../shared/contracts";
import type { InfrastructureServiceSummary } from "../../../shared/topology-contracts";
import { createOverviewTopology, type TopologyContext } from "./overview-topology";
import { serviceTopologyContributor } from "./service-topology";
import { projectTopology } from "./topology-projection";
import { TopologyIcon } from "./TopologyIcon";

const updatedAt = "2026-09-18T23:00:00.000Z";
const builders: InfrastructureServiceSummary[] = [
  { id: "builder/linux", name: "builder/linux", os: "linux", arch: "amd64", operatorName: "alice" },
  { id: "builder%2Flinux", name: "builder%2Flinux", os: "windows", arch: "arm64", operatorName: "bob" },
];
const stations: InfrastructureServiceSummary[] = [
  { id: "host-a", name: "shared-name", os: "linux", arch: "amd64", operatorName: "alice", version: "1.0.0" },
  { id: "host-b", name: "shared-name", os: "darwin", arch: "arm64", operatorName: "bob", version: "2.0.0" },
];

function domain(items: InfrastructureServiceSummary[]): DomainCollection<InfrastructureServiceSummary> {
  return { status: items.length ? "ready" : "empty", items, revision: 4, updatedAt, page: { limit: 500, total: items.length, truncated: false } };
}

function context(builderItems = builders, stationItems = stations): TopologyContext {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected", managedServer: null, server: "example.test", operator: "alice" };
  snapshot.eventStream = { status: "connected", attempt: 0 };
  snapshot.infrastructureServices = { builders: domain(builderItems), crackstations: domain(stationItems) };
  return { snapshot, scopeId: "scope-one", connected: true, hasServer: true, ids: { client: "local-client", server: "central-server", cloud: "cloud-enclosure" } };
}

describe("service topology contributor", () => {
  it("represents builder registrations and distinct crackstations sharing a display name", () => {
    const result = serviceTopologyContributor(context());
    expect(result.nodes).toHaveLength(4);
    expect(new Set(result.nodes?.map(({ id }) => id)).size).toBe(4);
    expect(result.nodes?.[0]).toMatchObject({
      id: "scope-one/external-builder/builder%2Flinux", kind: "external-builder", icon: "external-builder",
      label: "builder/linux", subtitle: "linux · amd64", freshness: "current", status: "healthy", statusLabel: "Registered",
    });
    expect(result.nodes?.[1]?.id).toBe("scope-one/external-builder/builder%252Flinux");
    expect(result.nodes?.slice(2).map(({ label }) => label)).toEqual(["shared-name", "shared-name"]);
    expect(result.nodes?.[2]).toMatchObject({ kind: "crackstation", icon: "crackstation", status: "healthy", statusLabel: "Connected" });
    expect(result.nodes?.[2]?.properties).toContainEqual({ label: "Host UUID", value: "host-a" });
    expect(result.nodes?.[3]?.properties).toContainEqual({ label: "Version", value: "2.0.0" });
  });

  it("associates services with the server without manufacturing traffic or operator ownership", () => {
    const input = context();
    const result = serviceTopologyContributor(input);
    for (const edge of result.edges ?? []) {
      expect(edge).toMatchObject({ role: "relationship", target: input.ids.server, state: "unknown", freshness: "current" });
      expect(result.nodes?.some(({ id }) => id === edge.source)).toBe(true);
      expect(edge).not.toHaveProperty("transport");
      expect(edge).not.toHaveProperty("activityAt");
      expect(edge.description).toContain("operator identity relationships are not reported");
    }
    expect(result.edges?.[0]).toMatchObject({ id: "scope-one/external-builder-registration/builder%2Flinux", kind: "external-builder-registration", label: "Builder registration" });
    expect(result.edges?.[2]).toMatchObject({ id: "scope-one/crackstation-connection/host-a", kind: "crackstation-connection", label: "Crackstation connection" });
    expect(result.nodes?.every((node) => node.parentId === undefined && node.resource === undefined)).toBe(true);
    expect(result.nodes?.[0]?.properties).toContainEqual({ label: "Reported operator", value: "alice" });
  });

  it("keeps identity stable through refreshes, reordering and station renames, and isolates server scopes", () => {
    const original = serviceTopologyContributor(context());
    const nextInput = context([...builders].reverse(), [...stations].reverse().map((station) => ({ ...station, name: "renamed" })));
    nextInput.snapshot.connection.epoch = 9;
    nextInput.snapshot.infrastructureServices!.builders.revision = 99;
    const next = serviceTopologyContributor(nextInput);
    expect(new Set(next.nodes?.map(({ id }) => id))).toEqual(new Set(original.nodes?.map(({ id }) => id)));
    expect(new Set(next.edges?.map(({ id }) => id))).toEqual(new Set(original.edges?.map(({ id }) => id)));
    const other = serviceTopologyContributor({ ...context(), scopeId: "scope-two" });
    expect(other.nodes?.every(({ id }) => !original.nodes?.some((node) => node.id === id))).toBe(true);
  });

  it("isolates identical identity values across service kinds", () => {
    const service = { id: "same", name: "same", os: "", arch: "", operatorName: "" };
    const result = serviceTopologyContributor(context([service], [service]));
    expect(result.nodes?.[0]?.id).not.toBe(result.nodes?.[1]?.id);
    expect(result.edges?.[0]?.id).not.toBe(result.edges?.[1]?.id);
  });

  it("uses only JSON-safe display metadata and leaves source data unchanged", () => {
    const extra = { ...stations[0]!, task: "private task", config: "private config", targetRef: { token: "private token" } };
    const input = context(builders, [extra]);
    const before = JSON.stringify(input.snapshot);
    const result = serviceTopologyContributor(input);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(JSON.stringify(input.snapshot)).toBe(before);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result.nodes?.every((node) => !("resource" in node))).toBe(true);
    expect(result.nodes?.[0]?.properties).toContainEqual({ label: "Inventory updated", value: updatedAt });
  });

  it.each(["disconnected", "reconnecting"] as const)("preserves only last-known service presence when %s", (status) => {
    const input = context();
    input.snapshot.connection.status = status;
    const result = serviceTopologyContributor({ ...input, connected: false });
    expect(result.nodes?.every((node) => node.status === "unknown" && node.freshness === "stale")).toBe(true);
    expect(result.nodes?.[0]?.statusLabel).toBe("Last known: registered");
    expect(result.nodes?.[2]?.statusLabel).toBe("Last known: connected");
    expect(result.edges?.every((edge) => edge.freshness === "stale" && edge.state === "unknown")).toBe(true);
  });

  it.each(["retrying", "stopped"] as const)("marks service presence stale when events are %s", (status) => {
    const input = context();
    input.snapshot.eventStream.status = status;
    expect(serviceTopologyContributor(input).nodes?.every((node) => node.freshness === "stale")).toBe(true);
  });

  it("treats ready inventory as current while a quiet event stream awaits its first event", () => {
    const input = context();
    input.snapshot.eventStream.status = "connecting";
    expect(serviceTopologyContributor(input).nodes?.every((node) => node.freshness === "current")).toBe(true);
  });

  it.each(["loading", "error", "unsupported"] as const)("marks retained %s inventory stale without exposing backend diagnostics", (status) => {
    const input = context();
    input.snapshot.infrastructureServices!.builders.status = status;
    input.snapshot.infrastructureServices!.builders.error = "private backend diagnostic";
    const result = serviceTopologyContributor(input);
    expect(result.nodes?.filter(({ kind }) => kind === "external-builder").every((node) => node.freshness === "stale" && node.status === "unknown")).toBe(true);
    expect(result.nodes?.filter(({ kind }) => kind === "crackstation").every((node) => node.freshness === "current")).toBe(true);
    expect(result.notices).toContainEqual(expect.objectContaining({ id: `builders:${status}`, severity: status === "error" ? "warning" : "info" }));
    expect(JSON.stringify(result)).not.toContain("private backend diagnostic");
  });

  it("handles absent, empty, and disconnected inventories without fabricating resources", () => {
    expect(serviceTopologyContributor(context([], []))).toEqual({ nodes: [], edges: [], notices: [] });
    const input = context();
    expect(serviceTopologyContributor({ ...input, hasServer: false })).toEqual({ nodes: [], edges: [], notices: [] });
    delete input.snapshot.infrastructureServices;
    expect(serviceTopologyContributor(input)).toEqual({ nodes: [], edges: [], notices: [] });
  });

  it("reports unavailable and loading empty inventories as informational notices", () => {
    const input = context([], []);
    input.snapshot.infrastructureServices!.builders.status = "unsupported";
    input.snapshot.infrastructureServices!.crackstations.status = "loading";
    const result = serviceTopologyContributor(input);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
    expect(result.notices).toEqual([
      { id: "builders:unsupported", severity: "info", message: "External builder inventory is unavailable from this server." },
      { id: "crackstations:loading", severity: "info", message: "Crackstation inventory is loading." },
    ]);
  });

  it("reports independently bounded inventory counts without inventing missing nodes", () => {
    const input = context(builders.slice(0, 1), stations.slice(0, 1));
    input.snapshot.infrastructureServices!.builders.page = { limit: 1, total: 7, truncated: true };
    input.snapshot.infrastructureServices!.crackstations.page = { limit: 1, total: 5, truncated: false };
    const result = serviceTopologyContributor(input);
    expect(result.nodes).toHaveLength(2);
    expect(result.notices).toEqual([
      { id: "builders:partial", severity: "info", message: "Showing 1 of 7 external builders; this inventory is partial." },
      { id: "crackstations:partial", severity: "info", message: "Showing 1 of 5 crackstations; this inventory is partial." },
    ]);
  });

  it("omits missing optional metadata and falls back to a stable identity label", () => {
    const result = serviceTopologyContributor(context([], [{ id: "host-id", name: "", os: "", arch: "", operatorName: "" }]));
    expect(result.nodes?.[0]).toMatchObject({ label: "host-id", subtitle: "Server-reported crackstation" });
    expect(result.nodes?.[0]?.properties).toEqual([
      { label: "Host UUID", value: "host-id" }, { label: "Connection", value: "Connected" }, { label: "Inventory updated", value: updatedAt },
    ]);
  });

  it("integrates into the default graph and supports type and metadata filters with server context", () => {
    const source = createOverviewTopology(context().snapshot);
    expect(source.nodes.filter(({ kind }) => kind === "external-builder")).toHaveLength(2);
    expect(source.nodes.filter(({ kind }) => kind === "crackstation")).toHaveLength(2);
    const filtered = projectTopology(source, { kind: "crackstation", query: "2.0.0", status: "healthy", expanded: new Set() });
    expect(filtered.matchCount).toBe(1);
    expect(filtered.document.nodes.map(({ kind }) => kind).sort()).toEqual(["crackstation", "server"]);
    expect(filtered.document.edges).toHaveLength(1);
    expect(filtered.document.edges[0]).toMatchObject({ role: "relationship", kind: "crackstation-connection" });
  });

  it("uses distinct local service iconography instead of the generic fallback", () => {
    const builder = renderToStaticMarkup(createElement(TopologyIcon, { name: "external-builder" }));
    const station = renderToStaticMarkup(createElement(TopologyIcon, { name: "crackstation" }));
    expect(builder).toContain('data-icon="hammer"');
    expect(station).toContain('data-icon="microchip"');
    expect(builder).not.toContain('data-icon="cube"');
    expect(station).not.toContain('data-icon="cube"');
  });
});
