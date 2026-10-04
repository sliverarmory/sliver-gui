// @vitest-environment node

import { clientpb } from "sliver-script";
import { describe, expect, it } from "vitest";

import { MAX_PIVOT_TOPOLOGY_ENTRIES, normalizePivotTopology } from "./pivot-topology.js";

function entry(peerId: string, children: clientpb.PivotGraphEntry[] = [], sessionId?: string): clientpb.PivotGraphEntry {
  return { PeerID: peerId, Name: `peer ${peerId}`, Children: children,
    ...(sessionId ? { Session: clientpb.Session.create({ ID: sessionId, Name: `session ${sessionId}` }) } : {}) };
}

describe("passive pivot topology normalization", () => {
  it("preserves nested branches, root boundaries, and signed int64 IDs without numeric coercion", () => {
    const graph = { Children: [
      entry("9223372036854775807", [entry("-9223372036854775808", [entry("3", [], "third")], "second"), entry("4")], "first"),
      entry("5", [], "other-root"),
    ] };
    expect(normalizePivotTopology(graph)).toEqual({ entries: [
      { peerId: "9223372036854775807", parentPeerId: null, sessionId: "first", name: "peer 9223372036854775807" },
      { peerId: "-9223372036854775808", parentPeerId: "9223372036854775807", sessionId: "second", name: "peer -9223372036854775808" },
      { peerId: "3", parentPeerId: "-9223372036854775808", sessionId: "third", name: "peer 3" },
      { peerId: "4", parentPeerId: "9223372036854775807", name: "peer 4" },
      { peerId: "5", parentPeerId: null, sessionId: "other-root", name: "peer 5" },
    ], truncated: false });
  });

  it("retains a sessionless intermediate peer instead of collapsing its child onto an ancestor", () => {
    const result = normalizePivotTopology({ Children: [entry("1", [entry("2", [entry("3", [], "child")])], "parent")] });
    expect(result.entries[1]).toEqual({ peerId: "2", parentPeerId: "1", name: "peer 2" });
    expect(result.entries[2]).toMatchObject({ peerId: "3", parentPeerId: "2", sessionId: "child" });
  });

  it("exports only bounded display names and session IDs, without mutating the source", () => {
    const peer = entry("1", [], "session-1");
    peer.Name = "";
    peer.Session!.Name = " relay\u0000\u202e name " + "😀".repeat(300);
    peer.Session!.ProxyURL = "https://private-user:private-password@example.invalid";
    peer.Session!.ActiveC2 = "https://private-user:private-password@example.invalid/c2";
    const before = JSON.stringify(peer);
    const result = normalizePivotTopology({ Children: [peer] });
    expect(Object.keys(result.entries[0]!)).toEqual(["peerId", "parentPeerId", "name", "sessionId"]);
    expect([...result.entries[0]!.name]).toHaveLength(256);
    expect(result.entries[0]!.name).toMatch(/^relay name /u);
    expect(JSON.stringify(result)).not.toContain("private-password");
    expect(JSON.stringify(peer)).toBe(before);
  });

  it("supports deep input iteratively and explicitly truncates without dropping ancestors", () => {
    const root = entry("1");
    let previous = root;
    for (let index = 2; index <= 10_000; index += 1) {
      const child = entry(String(index));
      previous.Children.push(child);
      previous = child;
    }
    const result = normalizePivotTopology({ Children: [root] });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(MAX_PIVOT_TOPOLOGY_ENTRIES);
    expect(result.entries.at(-1)).toMatchObject({ peerId: "500", parentPeerId: "499" });
    expect(result.entries.every((peer, index) => index === 0 || peer.parentPeerId === result.entries[index - 1]!.peerId)).toBe(true);
  });

  it("distinguishes a complete collection at its exact bound from an unvisited sibling", () => {
    const children = Array.from({ length: MAX_PIVOT_TOPOLOGY_ENTRIES }, (_, index) => entry(String(index + 1)));
    expect(normalizePivotTopology({ Children: children }).truncated).toBe(false);
    Object.defineProperty(children, MAX_PIVOT_TOPOLOGY_ENTRIES, {
      get: () => { throw new Error("Traversal exceeded its bound"); },
    });
    expect(normalizePivotTopology({ Children: children }).truncated).toBe(true);
  });

  it("accepts an explicitly empty graph", () => {
    expect(normalizePivotTopology({ Children: [] })).toEqual({ entries: [], truncated: false });
  });

  it.each(["", "0", "-0", "01", "+1", " 1", "1 ", "1.5", "1e3", "9223372036854775808", "-9223372036854775809"])(
    "rejects malformed or out-of-range peer ID %j", (peerId) => {
      expect(() => normalizePivotTopology({ Children: [entry(peerId)] })).toThrow("invalid peer ID");
    },
  );

  it.each(["", "two words", "line\nbreak", "hidden\u202eid", "x".repeat(129)])("rejects ambiguous session ID %j", (sessionId) => {
    const peer = entry("1", [], "placeholder");
    peer.Session!.ID = sessionId;
    expect(() => normalizePivotTopology({ Children: [peer] })).toThrow("invalid session ID");
  });

  it("rejects duplicate peers and conflicting parent assignments", () => {
    expect(() => normalizePivotTopology({ Children: [entry("1"), entry("1")] })).toThrow("duplicate peer");
    expect(() => normalizePivotTopology({ Children: [entry("1", [entry("3")]), entry("2", [entry("3")])] }))
      .toThrow("conflicting parent");
  });

  it("rejects one session assigned to more than one peer", () => {
    expect(() => normalizePivotTopology({ Children: [entry("1", [], "same-session"), entry("2", [], "same-session")] }))
      .toThrow("conflicting session reference");
  });

  it("rejects an object cycle without recursive traversal", () => {
    const parent = entry("1");
    const child = entry("2", [parent]);
    parent.Children.push(child);
    expect(() => normalizePivotTopology({ Children: [parent] })).toThrow("cycle");
  });

  it.each([null, {}, { Children: null }, { Children: [null] }, { Children: [{ PeerID: "1", Children: {} }] }])(
    "rejects malformed graph structure without returning partial routes", (graph) => {
      expect(() => normalizePivotTopology(graph as unknown as clientpb.PivotGraph)).toThrow(/^Pivot topology /u);
    },
  );
});
