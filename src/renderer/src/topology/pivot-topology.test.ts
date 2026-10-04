import { describe, expect, it } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import type { DomainStatus } from "../../../shared/contracts";
import type { SessionSummary } from "../../../shared/target-contracts";
import type { PivotTopologyEntry } from "../../../shared/topology-contracts";
import type { TopologyContext } from "./overview-topology";
import { createPivotTopology } from "./pivot-topology";

const updatedAt = "2026-09-18T22:00:00.000Z";

function session(id: string, transport: SessionSummary["transport"] = "tcppivot"): SessionSummary {
  return {
    mode: "session", id, name: `session-${id}`, hostname: `host-${id}`, hostId: `host-id-${id}`,
    username: "user", os: "linux", arch: "amd64", transport, remoteAddress: "192.0.2.8:5000",
    activeC2: "mtls://private-user:private-secret@example.test", executable: "client", version: "1.7.6",
    locale: "en-US", integrity: "", burned: false, liveness: "active", lastCheckinAt: updatedAt,
  };
}

const hierarchy: PivotTopologyEntry[] = [
  { peerId: "1", parentPeerId: null, sessionId: "root", name: "root relay" },
  { peerId: "2", parentPeerId: "1", sessionId: "child", name: "child relay" },
  { peerId: "3", parentPeerId: "2", sessionId: "grandchild", name: "third relay" },
  { peerId: "4", parentPeerId: "3", sessionId: "leaf", name: "fourth relay" },
  { peerId: "5", parentPeerId: "2", sessionId: "branch", name: "branch relay" },
];

function context(entries = hierarchy, items = [session("root", "mtls"), session("child"), session("grandchild", "namedpipe"), session("leaf"), session("branch", "unknown")]): TopologyContext {
  const snapshot = disconnectedSnapshot();
  snapshot.connection = { status: "connected", server: "example.test", operator: "operator", managedServer: null };
  snapshot.eventStream = { status: "connected", attempt: 0 };
  snapshot.domains.sessions = {
    status: items.length ? "ready" : "empty", revision: 8, updatedAt, items,
    page: { limit: 500, total: items.length, truncated: false },
  };
  snapshot.pivotTopology = { status: entries.length ? "ready" : "empty", revision: 9, updatedAt, entries, truncated: false };
  return { snapshot, scopeId: "scope", connected: true, hasServer: true, ids: { client: "client", server: "server", cloud: "cloud" } };
}

describe("passive reported pivot topology", () => {
  it("preserves four levels and a branch without substituting direct server routes", () => {
    const input = context();
    const before = JSON.stringify(input.snapshot);
    const result = createPivotTopology(input);
    expect(result.nodes).toEqual([]);
    expect(result.notices).toEqual([]);
    expect(result.mappedSessionIds).toEqual(new Set(["root", "child", "grandchild", "leaf", "branch"]));
    expect(result.edges.map(({ id, source, target }) => ({ id, source, target }))).toEqual([
      { id: "scope/pivot-hop/1", source: "server", target: "scope/session/root" },
      { id: "scope/pivot-hop/2", source: "scope/session/root", target: "scope/session/child" },
      { id: "scope/pivot-hop/3", source: "scope/session/child", target: "scope/session/grandchild" },
      { id: "scope/pivot-hop/4", source: "scope/session/grandchild", target: "scope/session/leaf" },
      { id: "scope/pivot-hop/5", source: "scope/session/child", target: "scope/session/branch" },
    ]);
    expect(result.edges.map(({ label }) => label)).toEqual(["mTLS", "TCP pivot", "Named pipe", "TCP pivot", "Reported hop"]);
    expect(result.edges.every((edge) => edge.role === "communication" && edge.freshness === "current" && edge.state === "live")).toBe(true);
    expect(result.edges[4]).not.toHaveProperty("transport");
    expect(result.edges.every((edge) => !Object.hasOwn(edge, "activityAt"))).toBe(true);
    expect(result.edges[2]?.properties).toContainEqual({ label: "Parent peer ID", value: "2" });
    expect(result.edges[0]?.properties).toContainEqual({ label: "Topology updated", value: updatedAt });
    expect(JSON.stringify(input.snapshot)).toBe(before);
    expect(JSON.stringify(result.edges)).not.toContain("private-secret");
  });

  it("uses peer-scoped placeholders for missing inventory and sessionless relays without action authority", () => {
    const entries: PivotTopologyEntry[] = [
      { peerId: "11", parentPeerId: null, name: "edge <relay>" },
      { peerId: "12", parentPeerId: "11", sessionId: "missing", name: "" },
      { peerId: "13", parentPeerId: "12", sessionId: "present", name: "observed" },
    ];
    const input = context(entries, [session("present")]);
    const result = createPivotTopology(input);
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({ id: "scope/relay/11", kind: "relay", icon: "relay", label: "edge <relay>", status: "unknown", freshness: "current" });
    expect(result.nodes[1]).toMatchObject({ id: "scope/relay/12", label: "Relay 12", statusLabel: "Reported relay" });
    expect(result.nodes[1]?.properties).toContainEqual({ label: "Session ID", value: "missing" });
    expect(result.nodes[0]?.properties).toContainEqual({ label: "Peer ID", value: "11" });
    expect(result.nodes.every((node) => !Object.hasOwn(node, "resource") && !Object.hasOwn(node, "targetRef") && !Object.hasOwn(node, "parentId"))).toBe(true);
    expect(result.edges.map(({ source, target, state }) => ({ source, target, state }))).toEqual([
      { source: "server", target: "scope/relay/11", state: "unknown" },
      { source: "scope/relay/11", target: "scope/relay/12", state: "unknown" },
      { source: "scope/relay/12", target: "scope/session/present", state: "live" },
    ]);
    expect(result.mappedSessionIds).toEqual(new Set(["present"]));
    const display = { nodes: result.nodes, edges: result.edges, notices: result.notices };
    expect(JSON.parse(JSON.stringify(display))).toEqual(display);
  });

  it("never resolves embedded session references from legacy rows or beacon inventory", () => {
    const input = context([{ peerId: "1", parentPeerId: null, sessionId: "same", name: "relay" }], []);
    input.snapshot.sessions = [session("same")];
    input.snapshot.domains.beacons.items = [{ ...session("same"), mode: "beacon", checkinStatus: "on-time" }];
    const result = createPivotTopology(input);
    expect(result.nodes[0]?.id).toBe("scope/relay/1");
    expect(result.mappedSessionIds.size).toBe(0);
    expect(result.edges[0]).toMatchObject({ target: "scope/relay/1", label: "Reported hop", state: "unknown" });
    expect(JSON.stringify(result)).not.toContain("scope/beacon/");
  });

  it("has stable identities across order, display changes, source revisions, and reconnect epochs", () => {
    const input = context(hierarchy, []);
    const first = createPivotTopology(input);
    const reordered = context([...hierarchy].reverse().map((entry) => ({ ...entry, name: "renamed" })), []);
    reordered.snapshot.connection.epoch = 99;
    reordered.snapshot.pivotTopology = { ...reordered.snapshot.pivotTopology!, revision: 200, updatedAt: "later" };
    const next = createPivotTopology(reordered);
    expect(new Set(next.nodes.map(({ id }) => id))).toEqual(new Set(first.nodes.map(({ id }) => id)));
    expect(new Set(next.edges.map(({ id }) => id))).toEqual(new Set(first.edges.map(({ id }) => id)));
    expect(createPivotTopology({ ...input, scopeId: "other" }).nodes[0]?.id).not.toBe(first.nodes[0]?.id);
  });

  it("encodes session identity in the same namespace as ordinary session nodes", () => {
    const id = 'session/with["quotes"]';
    const result = createPivotTopology(context([{ peerId: "-9007199254740999", parentPeerId: null, sessionId: id, name: "" }], [session(id)]));
    expect(result.edges[0]).toMatchObject({ id: "scope/pivot-hop/-9007199254740999", target: `scope/session/${encodeURIComponent(id)}` });
    expect(result.mappedSessionIds).toEqual(new Set([id]));
  });

  it.each(["connected", "connecting"] as const)("accepts fresh reported topology while the event stream is %s", (status) => {
    const input = context();
    input.snapshot.eventStream.status = status;
    expect(createPivotTopology(input).edges.every((edge) => edge.freshness === "current")).toBe(true);
  });

  it.each(["retrying", "stopped"] as const)("marks retained graph edges unknown and stale while the stream is %s", (status) => {
    const input = context(hierarchy, []);
    input.snapshot.eventStream.status = status;
    const result = createPivotTopology(input);
    expect(result.edges.every((edge) => edge.freshness === "stale" && edge.state === "unknown")).toBe(true);
    expect(result.nodes.every((node) => node.statusLabel === "Last known relay" && node.freshness === "stale")).toBe(true);
  });

  it("preserves last-known parent links on disconnect without claiming live edges", () => {
    const result = createPivotTopology({ ...context(), connected: false });
    expect(result.edges).toHaveLength(5);
    expect(result.mappedSessionIds.size).toBe(5);
    expect(result.edges.every((edge) => edge.freshness === "stale" && edge.state === "unknown")).toBe(true);
  });

  it.each(["idle", "loading", "error", "unsupported"] satisfies DomainStatus[])("requires current session inventory when its status is %s", (status) => {
    const input = context();
    input.snapshot.domains.sessions.status = status;
    const result = createPivotTopology(input);
    expect(result.edges.every((edge) => edge.freshness === "stale" && edge.state === "unknown")).toBe(true);
    expect(result.mappedSessionIds.size).toBe(5);
  });

  it.each(["loading", "error"] as const)("keeps retained graph hops stale when topology is %s", (status) => {
    const input = context();
    input.snapshot.pivotTopology = { ...input.snapshot.pivotTopology!, status, error: "private backend diagnostic" };
    const result = createPivotTopology(input);
    expect(result.edges.every((edge) => edge.freshness === "stale" && edge.state === "unknown")).toBe(true);
    expect(result.notices).toContainEqual(expect.objectContaining({ id: `pivot-topology:${status}`, severity: status === "error" ? "warning" : "info" }));
    expect(JSON.stringify(result)).not.toContain("private backend diagnostic");
  });

  it("uses dead session status only on its known child hop", () => {
    const input = context();
    input.snapshot.domains.sessions.items = input.snapshot.domains.sessions.items.map((item) => item.id === "leaf" ? { ...item, liveness: "dead" } : item);
    const result = createPivotTopology(input);
    expect(result.edges.find((edge) => edge.target === "scope/session/leaf")).toMatchObject({ state: "inactive", freshness: "current" });
    expect(result.edges.find((edge) => edge.target === "scope/session/branch")?.state).toBe("live");
  });

  it("does not map missing, empty, or unsupported graphs so ordinary relationships remain available", () => {
    const missing = context();
    delete missing.snapshot.pivotTopology;
    for (const input of [missing, context([]), { ...context(), hasServer: false }]) {
      expect(createPivotTopology(input)).toEqual({ nodes: [], edges: [], notices: [], mappedSessionIds: new Set() });
    }
    const unsupported = context();
    unsupported.snapshot.pivotTopology = { ...unsupported.snapshot.pivotTopology!, status: "unsupported" };
    expect(createPivotTopology(unsupported)).toMatchObject({ nodes: [], edges: [], mappedSessionIds: new Set(), notices: [{ id: "pivot-topology:unsupported", severity: "info", message: expect.any(String) }] });
  });

  it("warns when a valid bounded graph is partial or an empty graph fails to refresh", () => {
    const partial = context();
    partial.snapshot.pivotTopology = { ...partial.snapshot.pivotTopology!, truncated: true };
    expect(createPivotTopology(partial).notices).toContainEqual(expect.objectContaining({ id: "pivot-topology:truncated", severity: "warning" }));
    expect(createPivotTopology(partial).edges).toHaveLength(5);
    const failed = context([]);
    failed.snapshot.pivotTopology = { ...failed.snapshot.pivotTopology!, status: "error" };
    expect(createPivotTopology(failed)).toMatchObject({ nodes: [], edges: [], mappedSessionIds: new Set(), notices: [{ id: "pivot-topology:error", severity: "warning", message: expect.any(String) }] });
  });

  it.each([
    { reason: "missing parent", entries: [{ peerId: "2", parentPeerId: "missing", sessionId: "child", name: "" }] },
    { reason: "duplicate peer", entries: [...hierarchy, { ...hierarchy[1]!, parentPeerId: null }] },
    { reason: "duplicate session mapping", entries: [...hierarchy, { peerId: "6", parentPeerId: null, sessionId: "child", name: "" }] },
    { reason: "self cycle", entries: [{ peerId: "1", parentPeerId: "1", sessionId: "root", name: "" }] },
    { reason: "disconnected cycle", entries: [hierarchy[0]!, { peerId: "2", parentPeerId: "3", name: "" }, { peerId: "3", parentPeerId: "2", name: "" }] },
    { reason: "empty peer identity", entries: [{ peerId: "", parentPeerId: null, name: "" }] },
  ])("rejects $reason without fabricating routes or hiding ordinary session relationships", ({ entries }) => {
    const result = createPivotTopology(context(entries));
    expect(result).toMatchObject({ nodes: [], edges: [], mappedSessionIds: new Set(), notices: [{ id: "pivot-topology:invalid", severity: "warning", message: expect.any(String) }] });
  });

  it("handles maximum-depth inventory iteratively and rejects an unexpectedly unbounded graph", () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({ peerId: String(index + 1), parentPeerId: index ? String(index) : null, name: "" }));
    const result = createPivotTopology(context(entries, []));
    expect(result.nodes).toHaveLength(500);
    expect(result.edges[499]).toMatchObject({ source: "scope/relay/499", target: "scope/relay/500" });
    const oversized = createPivotTopology(context([...entries, { peerId: "501", parentPeerId: "500", name: "" }], []));
    expect(oversized.edges).toEqual([]);
    expect(oversized.notices).toContainEqual(expect.objectContaining({ id: "pivot-topology:invalid" }));
  });
});
