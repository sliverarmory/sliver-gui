import type { clientpb } from "sliver-script";

import type { PivotTopologyEntry } from "../shared/topology-contracts.js";

export const MAX_PIVOT_TOPOLOGY_ENTRIES = 500;
const MAX_SESSION_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MIN_PEER_ID = -(1n << 63n);
const MAX_PEER_ID = (1n << 63n) - 1n;

/** Normalize only the server's observed hierarchy; embedded sessions confer no action authority. */
export function normalizePivotTopology(graph: clientpb.PivotGraph): {
  entries: PivotTopologyEntry[];
  truncated: boolean;
} {
  if (!isObject(graph)) throw new Error("Pivot topology is not a graph");
  const entries: PivotTopologyEntry[] = [];
  const seenPeers = new Set<string>();
  const seenSessions = new Set<string>();
  const seenEntries = new WeakSet<object>();
  const stack = [{ children: childrenOf(graph.Children), index: 0, parentPeerId: null as string | null }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.children.length) {
      stack.pop();
      continue;
    }
    if (entries.length >= MAX_PIVOT_TOPOLOGY_ENTRIES) return { entries, truncated: true };

    const candidate = frame.children[frame.index++];
    if (!isObject(candidate)) throw new Error("Pivot topology contains an invalid entry");
    if (seenEntries.has(candidate)) throw new Error("Pivot topology contains a cycle or repeated entry");
    seenEntries.add(candidate);

    const peerId = normalizePeerId(candidate["PeerID"]);
    if (seenPeers.has(peerId)) throw new Error("Pivot topology contains a duplicate peer or conflicting parent");
    seenPeers.add(peerId);
    const children = childrenOf(candidate["Children"]);
    const session = candidate["Session"];
    let sessionId: string | undefined;
    if (session !== undefined && session !== null) {
      if (!isObject(session)) throw new Error("Pivot topology contains an invalid session reference");
      sessionId = normalizeSessionId(session["ID"]);
      if (seenSessions.has(sessionId)) throw new Error("Pivot topology contains a conflicting session reference");
      seenSessions.add(sessionId);
    }
    const name = displayName(candidate["Name"]) || (isObject(session) ? displayName(session["Name"]) : "");
    entries.push({ peerId, parentPeerId: frame.parentPeerId, name, ...(sessionId ? { sessionId } : {}) });
    if (children.length > 0) stack.push({ children, index: 0, parentPeerId: peerId });
  }

  return { entries, truncated: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function childrenOf(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("Pivot topology contains an invalid children collection");
  return value;
}

function normalizePeerId(value: unknown): string {
  if (typeof value !== "string" || value.length > 20 || !/^-?[1-9][0-9]*$/u.test(value)) {
    throw new Error("Pivot topology contains an invalid peer ID");
  }
  const parsed = BigInt(value);
  if (parsed < MIN_PEER_ID || parsed > MAX_PEER_ID) throw new Error("Pivot topology contains an invalid peer ID");
  return value;
}

function normalizeSessionId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_SESSION_ID_LENGTH
    || /[\s\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Pivot topology contains an invalid session ID");
  return value;
}

function displayName(value: unknown): string {
  if (typeof value !== "string") return "";
  return [...value.slice(0, MAX_NAME_LENGTH * 4).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()]
    .slice(0, MAX_NAME_LENGTH).join("");
}
