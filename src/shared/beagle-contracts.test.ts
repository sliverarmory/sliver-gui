import { describe, expect, it } from "vitest";

import {
  BEAGLE_IPC_INVOKE, parseBeagleComposeInput, parseBeagleCreateProjectInput, parseBeagleEntityInput,
  parseBeagleJson, parseBeagleNeighborhoodInput, parseBeaglePathsInput, parseBeagleQueryInput, parseBeagleSavedQueryInput,
  parseBeagleSearchInput, parseBeagleSelectProjectInput, parseBeagleTagInput,
} from "./beagle-contracts.js";

describe("Beagle IPC contracts", () => {
  it("bounds neighborhood pages and accepts only the pinned contextual views", () => {
    expect(parseBeagleNeighborhoodInput({ objectid: "U", view: "user-member_of", offset: 250 })).toEqual({ objectid: "U", view: "user-member_of", offset: 250 });
    for (const extra of [{ view: "MATCH (n) RETURN n" }, { offset: -1 }, { offset: 1.5 }, { offset: Infinity }, { limit: 99999 }]) {
      expect(() => parseBeagleNeighborhoodInput({ objectid: "U", ...extra })).toThrow(TypeError);
    }
  });
  it("validates ordered endpoints and traversal relationships without accepting Cypher identifiers", () => {
    const input = { source: "U", via: ["G1", "G2"], target: "C", relationshipKinds: ["MemberOf", "AdminTo"] };
    expect(parseBeaglePathsInput(input)).toEqual(input);
    for (const extra of [{ via: ["G", "G", "G"] }, { via: [null] }, { relationshipKinds: [] },
      { relationshipKinds: ["MemberOf", "MemberOf"] }, { relationshipKinds: ["MemberOf]->(n) DELETE n //"] }, { relationshipKinds: ["NotAnAttackPathKind"] }]) {
      expect(() => parseBeaglePathsInput({ source: "U", target: "C", ...extra })).toThrow(TypeError);
    }
  });
  it("uses unique isolated channels and provides no renderer filesystem or process access", () => {
    const channels = Object.values(BEAGLE_IPC_INVOKE);
    expect(new Set(channels).size).toBe(channels.length);
    expect(channels.every((channel) => channel.startsWith("sliver:beagle:"))).toBe(true);
    for (const extra of [{ path: "/tmp/other.db" }, { binary: "sh" }, { args: ["-c", "id"] }, { shell: true }]) {
      expect(() => parseBeagleQueryInput({ cypher: "RETURN 1", ...extra })).toThrow(TypeError);
    }
  });

  it("keeps JSON parameter types and multiline Cypher intact", () => {
    const parameters = { name: "ALICE\";$(id)", enabled: true, limit: 12, null: null, nested: { ids: [1, "2"] } };
    const cypher = "MATCH (n)\nWHERE n.name = $name\nRETURN n";
    expect(parseBeagleQueryInput({ cypher, parameters })).toEqual({ cypher, parameters });
    expect(parseBeagleSavedQueryInput({ id: "official-query", parameters })).toEqual({ id: "official-query", parameters });
  });

  it("rejects malformed, cyclic, non-JSON and oversized parameters", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const parameters of [null, [], "{}", 1, { value: NaN }, { value: Infinity }, { value: undefined }, { value: 1n }, cyclic, new Date(), { value: "x".repeat(65_536) }]) {
      expect(() => parseBeagleQueryInput({ cypher: "RETURN 1", parameters })).toThrow(TypeError);
    }
    expect(() => parseBeagleJson({ value: () => 1 })).toThrow(TypeError);
    let nested: unknown = {};
    for (let index = 0; index < 40; index++) nested = { nested };
    expect(() => parseBeagleJson(nested)).toThrow(TypeError);
  });

  it("bounds query and saved-query parameters by serialized UTF-8 bytes, including object keys", () => {
    const exact = { value: `${"界".repeat(21_841)}x` };
    expect(new TextEncoder().encode(JSON.stringify(exact))).toHaveLength(65_536);
    expect(parseBeagleQueryInput({ cypher: "RETURN $value", parameters: exact }).parameters).toEqual(exact);
    expect(parseBeagleSavedQueryInput({ id: "official-query", parameters: exact }).parameters).toEqual(exact);
    for (const parameters of [{ value: `${exact.value}x` }, { value: "界".repeat(30_000) }, { ["界".repeat(30_000)]: true }]) {
      // Each input fits the former UTF-16 character check but exceeds the native byte cap.
      expect(JSON.stringify(parameters).length).toBeLessThan(65_536);
      expect(() => parseBeagleQueryInput({ cypher: "RETURN $value", parameters })).toThrow(/64 KiB/u);
      expect(() => parseBeagleSavedQueryInput({ id: "official-query", parameters })).toThrow(/64 KiB/u);
    }
  });

  it("preserves valid Cypher map keys without prototype pollution", () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value","prototype":1}');
    const result = parseBeagleJson(input);
    expect(result).toEqual(input);
    if (typeof result !== "object" || result === null) throw new Error("Expected a JSON object");
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect("polluted" in {}).toBe(false);
  });

  it("allows opaque object identities but rejects project path traversal", () => {
    expect(parseBeagleEntityInput({ objectid: "S-1-5-21-123" })).toEqual({ objectid: "S-1-5-21-123" });
    expect(parseBeagleCreateProjectInput({ name: "  GOAD lab  " })).toEqual({ name: "GOAD lab" });
    expect(parseBeagleSelectProjectInput({ id: "456789ab-cdef-4123-8123-456789abcdef" })).toEqual({ id: "456789ab-cdef-4123-8123-456789abcdef" });
    for (const id of ["../database", "/tmp/db", "x", "", "456789ab-cdef-1123-8123-456789abcdef"]) {
      expect(() => parseBeagleSelectProjectInput({ id })).toThrow(TypeError);
    }
  });

  it("accepts only explicitly supported tags and bounded path options", () => {
    expect(parseBeagleTagInput({ objectid: "U", tag: "owned", enabled: false })).toEqual({ objectid: "U", tag: "owned", enabled: false });
    expect(parseBeaglePathsInput({ source: "U", target: "G", all: true, maxHops: 12 })).toEqual({ source: "U", target: "G", all: true, maxHops: 12 });
    expect(parseBeagleComposeInput({ source: "U", target: "G", kind: "MemberOf" })).toEqual({ source: "U", target: "G", kind: "MemberOf" });
    for (const tag of ["Tier0", "admin", "", null]) expect(() => parseBeagleTagInput({ objectid: "U", tag, enabled: true })).toThrow(TypeError);
    for (const enabled of ["true", 1, null]) expect(() => parseBeagleTagInput({ objectid: "U", tag: "owned", enabled })).toThrow(TypeError);
    for (const maxHops of [0, 65, 1.5, NaN, "12", null]) expect(() => parseBeaglePathsInput({ source: "U", target: "G", maxHops })).toThrow(TypeError);
    expect(() => parseBeaglePathsInput({ source: "U", target: "G", all: "true" })).toThrow(TypeError);
  });

  it("accepts bounded search offsets while keeping page size under main-process control", () => {
    expect(parseBeagleSearchInput({ term: "ALICE" })).toEqual({ term: "ALICE" });
    expect(parseBeagleSearchInput({ term: "ALICE", offset: 0 })).toEqual({ term: "ALICE", offset: 0 });
    expect(parseBeagleSearchInput({ term: "ALICE", offset: 100 })).toEqual({ term: "ALICE", offset: 100 });
    for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", null]) {
      expect(() => parseBeagleSearchInput({ term: "ALICE", offset })).toThrow(TypeError);
    }
    expect(() => parseBeagleSearchInput({ term: "ALICE", limit: 10_000 })).toThrow(TypeError);
  });

  const parsers = [
    [parseBeagleCreateProjectInput, { name: "Lab" }],
    [parseBeagleSearchInput, { term: "ALICE" }],
    [parseBeagleEntityInput, { objectid: "U" }],
    [parseBeagleTagInput, { objectid: "U", tag: "owned", enabled: true }],
    [parseBeagleComposeInput, { source: "U", target: "G", kind: "MemberOf" }],
  ] as const;
  it.each(parsers)("rejects unexpected fields and malformed requests for %s", (parse, value) => {
    for (const invalid of [null, [], true, "text", undefined, {}]) expect(() => parse(invalid)).toThrow(TypeError);
    expect(() => parse({ ...value, projectPath: "/tmp/escape" })).toThrow(TypeError);
  });
});
