// @vitest-environment node

import { clientpb } from "sliver-script";
import { describe, expect, it } from "vitest";

import { MAX_INFRASTRUCTURE_SERVICES, normalizeCrackstations, normalizeExternalBuilders } from "./infrastructure-services.js";

function builder(name: string): clientpb.Builder {
  return clientpb.Builder.create({ Name: name, GOOS: "linux", GOARCH: "amd64", OperatorName: "builder-operator" });
}

function station(hostUUID: string, name = "Crackstation"): clientpb.Crackstation {
  return clientpb.Crackstation.create({ HostUUID: hostUUID, Name: name, GOOS: "linux", GOARCH: "amd64",
    OperatorName: "station-operator", Version: "1.2.3" });
}

describe("passive infrastructure service normalization", () => {
  it("accepts explicitly empty inventories", () => {
    const empty = { items: [], page: { limit: 500, total: 0, truncated: false } };
    expect(normalizeExternalBuilders({ Builders: [] })).toEqual(empty);
    expect(normalizeCrackstations({ Crackstations: [] })).toEqual(empty);
  });

  it("preserves exact builder identities and sorts independently of input order", () => {
    const result = normalizeExternalBuilders({ Builders: [builder("zeta"), builder(" Team Builder "), builder("alpha")] });
    expect(result.items).toEqual([
      { id: " Team Builder ", name: "Team Builder", os: "linux", arch: "amd64", operatorName: "builder-operator" },
      { id: "alpha", name: "alpha", os: "linux", arch: "amd64", operatorName: "builder-operator" },
      { id: "zeta", name: "zeta", os: "linux", arch: "amd64", operatorName: "builder-operator" },
    ]);
    expect(result.page).toEqual({ limit: 500, total: 3, truncated: false });
    expect(normalizeExternalBuilders({ Builders: [builder("alpha"), builder("zeta"), builder(" Team Builder ")] }))
      .toEqual(result);
  });

  it("keeps crackstations with duplicate display names separate by exact host identity", () => {
    const result = normalizeCrackstations({ Crackstations: [station("host-b", "worker"), station("HOST-A", "worker")] });
    expect(result.items).toEqual([
      { id: "HOST-A", name: "worker", os: "linux", arch: "amd64", operatorName: "station-operator", version: "1.2.3" },
      { id: "host-b", name: "worker", os: "linux", arch: "amd64", operatorName: "station-operator", version: "1.2.3" },
    ]);
  });

  it("falls back to station identity for missing display names and omits empty versions", () => {
    const value = station("host-a", "\n\u202e");
    value.Version = "";
    expect(normalizeCrackstations({ Crackstations: [value] }).items[0]).toEqual({
      id: "host-a", name: "host-a", os: "linux", arch: "amd64", operatorName: "station-operator",
    });
  });

  it("does not conflate identities whose sanitized labels are the same", () => {
    expect(normalizeExternalBuilders({ Builders: [builder("builder  one"), builder("builder one")] }).items)
      .toMatchObject([{ id: "builder  one", name: "builder one" }, { id: "builder one", name: "builder one" }]);
  });

  it("rejects duplicate builder identities or station hosts instead of returning ambiguous nodes", () => {
    expect(() => normalizeExternalBuilders({ Builders: [builder("same"), builder("same")] })).toThrow("duplicate identity");
    expect(() => normalizeCrackstations({ Crackstations: [station("same", "one"), station("same", "two")] }))
      .toThrow("duplicate identity");
  });

  it.each(["", "   ", "line\nbreak", "hidden\u202ename", "null\u0000name", "\ud800", "x".repeat(257), 123, null, undefined])(
    "rejects invalid builder identity %j", (name) => {
      expect(() => normalizeExternalBuilders({ Builders: [{ ...builder("valid"), Name: name }] } as clientpb.Builders))
        .toThrow("invalid identity");
    },
  );

  it.each(["", " ", "host id", " padded", "trailing ", "hidden\u202eid", "\ud800", "x".repeat(257), 123, null, undefined])(
    "rejects invalid crackstation identity %j", (hostUUID) => {
      expect(() => normalizeCrackstations({ Crackstations: [{ ...station("valid"), HostUUID: hostUUID }] } as clientpb.Crackstations))
        .toThrow("invalid identity");
    },
  );

  it("accepts the exact identity bound without truncating identities", () => {
    const id = "x".repeat(256);
    expect(normalizeExternalBuilders({ Builders: [builder(id)] }).items[0]!.id).toBe(id);
    expect(normalizeCrackstations({ Crackstations: [station(id)] }).items[0]!.id).toBe(id);
  });

  it.each([null, [], {}, { Builders: null }, { Builders: {} }, { Builders: [null] }, { Builders: [[]] }, { Builders: [{}] }])(
    "rejects malformed builder inventory %j", (value) => {
      expect(() => normalizeExternalBuilders(value as clientpb.Builders)).toThrow(/^External builder inventory /u);
    },
  );

  it.each([null, [], {}, { Crackstations: null }, { Crackstations: {} }, { Crackstations: [null] }, { Crackstations: [[]] }, { Crackstations: [{}] }])(
    "rejects malformed crackstation inventory %j", (value) => {
      expect(() => normalizeCrackstations(value as clientpb.Crackstations)).toThrow(/^Crackstation inventory /u);
    },
  );

  it("bounds and sanitizes display metadata and does not mutate source objects", () => {
    const value = station("host-a", " station\u0000\u202e  name " + "😀".repeat(300));
    value.GOOS = "  linux\n";
    value.GOARCH = " amd64\u0000 ";
    value.OperatorName = " operator\t name ";
    value.Version = " 1.2.3\n" + "x".repeat(300);
    const before = JSON.stringify(value);
    const item = normalizeCrackstations({ Crackstations: [value] }).items[0]!;
    expect(item.name).toMatch(/^station name /u);
    expect([...item.name]).toHaveLength(256);
    expect(item).toMatchObject({ os: "linux", arch: "amd64", operatorName: "operator name" });
    expect([...item.version!]).toHaveLength(256);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("drops non-string optional display fields instead of coercing objects into labels", () => {
    const value = { ...station("host-a"), Name: {}, GOOS: 123, GOARCH: null, OperatorName: [], Version: {} };
    expect(normalizeCrackstations({ Crackstations: [value] } as unknown as clientpb.Crackstations).items[0])
      .toEqual({ id: "host-a", name: "host-a", os: "", arch: "", operatorName: "" });
  });

  it("emits only JSON-safe allowlisted display metadata", () => {
    const rawBuilder = { ...builder("worker"), Version: "must-not-copy", Templates: ["private-template"],
      Targets: [{ private: "private-target" }], CrossCompilers: [{ private: "private-compiler" }],
      Credentials: { token: "private-token" } };
    const rawStation = { ...station("host-a"), ID: "private-database-id", Benchmarks: { 1: "private-benchmark" },
      CUDA: [{ private: "private-hardware" }], Status: { CurrentCrackJobID: "private-job" },
      HashcatVersion: "private-hashcat", Command: "private-command" };
    const result = {
      builders: normalizeExternalBuilders({ Builders: [rawBuilder] } as unknown as clientpb.Builders),
      crackstations: normalizeCrackstations({ Crackstations: [rawStation] } as unknown as clientpb.Crackstations),
    };
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("must-not-copy");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(Object.keys(result.builders.items[0]!)).toEqual(["id", "name", "os", "arch", "operatorName"]);
    expect(Object.keys(result.crackstations.items[0]!)).toEqual(["id", "name", "os", "arch", "operatorName", "version"]);
  });

  it("reports the exact bound as complete and larger collections as a bounded prefix", () => {
    const builders = Array.from({ length: MAX_INFRASTRUCTURE_SERVICES }, (_, index) => builder(`builder-${index}`));
    const stations = Array.from({ length: MAX_INFRASTRUCTURE_SERVICES }, (_, index) => station(`host-${index}`));
    expect(normalizeExternalBuilders({ Builders: builders }).page).toEqual({ limit: 500, total: 500, truncated: false });
    expect(normalizeCrackstations({ Crackstations: stations }).page).toEqual({ limit: 500, total: 500, truncated: false });
    Object.defineProperty(builders, MAX_INFRASTRUCTURE_SERVICES, { get: () => { throw new Error("Beyond builder limit"); } });
    Object.defineProperty(stations, MAX_INFRASTRUCTURE_SERVICES, { get: () => { throw new Error("Beyond station limit"); } });
    for (const result of [normalizeExternalBuilders({ Builders: builders }), normalizeCrackstations({ Crackstations: stations })]) {
      expect(result.page).toEqual({ limit: 500, total: 501, truncated: true });
      expect(result.items).toHaveLength(500);
    }
  });

  it("still rejects a duplicate inside a truncated displayed prefix", () => {
    const builders = Array.from({ length: 501 }, (_, index) => builder(`builder-${index}`));
    builders[499] = builder("builder-0");
    expect(() => normalizeExternalBuilders({ Builders: builders })).toThrow("duplicate identity");
  });
});
