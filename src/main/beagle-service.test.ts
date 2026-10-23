// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BEAGLE_RESULT_LIMITS, type BeagleJsonValue } from "../shared/beagle-contracts.js";
import { assertBeagleGraphQuery, BeagleService, normalizeBeagleQueryResult, normalizeBeagleSnapshot, type BeagleCommandRunner } from "./beagle-service.js";

const statistics = { nodes: 2, edges: 1, labels: { Base: 2, User: 1, Group: 1 }, relationships: { MemberOf: 1 } };
const user = { id: 42, labels: ["Base", "User"], properties: { objectid: "U", name: "ALICE" } };
const group = { id: 7, labels: ["Base", "Group"], properties: { objectid: "G", name: "ADMINS" } };
const relationship = { id: 80, startNode: 42, endNode: 7, type: "MemberOf", properties: { isacl: false } };
const snapshot = {
  nodes: [{ objectid: "U", labels: user.labels, properties: user.properties }, { objectid: "G", labels: group.labels, properties: group.properties }],
  edges: [{ source: "U", target: "G", kind: "MemberOf", derived: true, properties: { isacl: false } }],
};
function response(value: BeagleJsonValue): { stdout: string; stderr: string } { return { stdout: JSON.stringify(value), stderr: "" }; }
const capabilityProbe = { ...statistics, capabilities: { schema_version: 1, features: Object.fromEntries(["parameters", "shortest_path", "variable_length_paths", "named_paths", "optional_match", "with_where", "call_subquery", "union", "existential_subquery_full", "list_comprehension", "quantifiers"].map((key) => [key, true])) } };
const runtimeHelp = "Commands:\n" + ["ingest", "analyze", "query", "queries", "stats", "entity", "paths", "compose", "tag", "export"].map((command) => `  ${command} help`).join("\n") + "\n --db --query-timeout";
function runtimeResponse(args: readonly string[]): { stdout: string; stderr: string } | undefined {
  if (args[0] === "--version") return { stdout: "beagle 0.1.0", stderr: "" };
  if (args[0] === "--help") return { stdout: runtimeHelp, stderr: "" };
  if (args[1] === ":memory:") return response(capabilityProbe);
  return undefined;
}


describe("Beagle graph query boundary", () => {
  it.each([
    "LOAD CSV FROM '/tmp/private' AS row RETURN row",
    "load/**/CsV WITH HEADERS FROM $file AS row RETURN row",
    "LOAD // line\r\n CSV FROM $file AS row RETURN row",
    "CALL { LOAD CSV FROM $file AS row RETURN row } RETURN row",
    "/* nested start /* first end */ LOAD CSV FROM $file AS row RETURN row // */",
    "CALL apoc.periodic.iterate($producer, $action, {})",
    "CALL APOC /* gap */ . `periodic` . `iterate` ($producer, $action, {})",
    "CALL `apoc.periodic.iterate`($producer, $action, {})",
    "CALL `apoc`.`cypher`.`run`($source, {}) YIELD value RETURN value",
    "RETURN apoc.do.when(true, $source, '', {})",
    "RETURN `readfile`($file)",
    "RETURN `load_csv`($file)",
    "RETURN `writefile`($file, $data)",
    "RETURN load_extension($file)",
    "RETURN apoc.load.json($file)",
    "CALL apoc.export.csv.all($file, {})",
    "RETURN cypher_result($source, $params)",
  ])("rejects file and dynamic-query entry points: %s", (source) => {
    expect(() => assertBeagleGraphQuery(source)).toThrow(/File access/u);
  });

  it.each([
    "MATCH (n) WHERE n.name = $name RETURN n",
    "RETURN 'LOAD CSV FROM a file' AS text",
    'RETURN "apoc.periodic.iterate($source)" AS text',
    "RETURN 'it\\'s LOAD CSV' AS text",
    "RETURN 'first' 'LOAD CSV' AS text",
    "MATCH (n:`LOAD CSV`) RETURN n.`readfile`",
    "RETURN `back``tick` AS value",
    "// LOAD CSV FROM x\nRETURN 1",
    "/* LOAD CSV FROM x */ RETURN 1",
    "RETURN apoc.text.indexOf('one', 'n') AS position",
    "CALL (n) { WITH n RETURN n.name AS name } RETURN name",
    "CALL pageRank() YIELD node, score RETURN node, score",
  ])("preserves graph queries and literal/comment text: %s", (source) => {
    expect(() => assertBeagleGraphQuery(source)).not.toThrow();
  });

  it.each(["RETURN 'unterminated", 'RETURN "unterminated', "RETURN `unterminated", "/* unterminated"])("fails closed for incomplete lexical constructs: %s", (source) => {
    expect(() => assertBeagleGraphQuery(source)).toThrow(/Unterminated Cypher/u);
  });
});

describe("Beagle result normalization", () => {
  it("normalizes nested paths with stable object IDs and actual relationship direction", () => {
    const value = { columns: ["p"], rows: [{ p: { nodes: [group, user], rels: [relationship] } }, { p: { nodes: [user, group], rels: [relationship] } }] };
    const result = normalizeBeagleQueryResult(value, "project");
    expect(result.graph.nodes.map((node) => node.objectid)).toEqual(["G", "U"]);
    expect(result.graph.edges).toEqual([{ id: '["U","MemberOf","G"]', source: "U", target: "G", kind: "MemberOf", properties: { isacl: false }, derived: null }]);
    expect(result.projectId).toBe("project");
    expect(result.totalRows).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("preserves ordered columns, scalar values, and empty results", () => {
    const value = { columns: ["count", "nested"], rows: [{ count: 5, nested: [true, null, { name: "ALICE" }] }] };
    const result = normalizeBeagleQueryResult(value, "project");
    expect(result.rows).toEqual(value.rows);
    expect(result.graph).toEqual({ nodes: [], edges: [] });
    expect(normalizeBeagleQueryResult({ columns: ["name"], rows: [] }, "project").columns).toEqual(["name"]);
    expect(() => normalizeBeagleQueryResult({ columns: [1], rows: [] }, "project")).toThrow("query envelope");
  });

  it("extracts nodes from collections and deduplicates repeated identities", () => {
    const result = normalizeBeagleQueryResult({ columns: ["collection"], rows: [{ collection: [user, { nested: [group, user] }] }] }, "project");
    expect(result.graph.nodes).toHaveLength(2);
  });

  it("caps rows and graph sizes without returning dangling edges", () => {
    const nodes = Array.from({ length: BEAGLE_RESULT_LIMITS.nodes + 1 }, (_, index) => ({ objectid: String(index), labels: ["User"], properties: {} }));
    const result = normalizeBeagleQueryResult({ columns: ["n"], rows: nodes.map((n) => ({ n })) }, "project");
    expect(result.graph.nodes).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
    expect(result.truncated).toBe(true);
    const connected = normalizeBeagleQueryResult({ nodes, edges: [{ source: "0", target: String(nodes.length - 1), kind: "MemberOf", properties: {} }] }, "project");
    expect(connected.graph.edges).toHaveLength(0);
    expect(connected.truncated).toBe(true);
    const scalar = normalizeBeagleQueryResult({ columns: ["n"], rows: Array.from({ length: BEAGLE_RESULT_LIMITS.rows + 1 }, () => ({ n: 1 })) }, "project");
    expect(scalar.rows).toHaveLength(BEAGLE_RESULT_LIMITS.rows);
    expect(scalar.totalRows).toBe(BEAGLE_RESULT_LIMITS.rows + 1);
    expect(scalar.truncated).toBe(true);
  });

  it("exports complete canonical snapshots and rejects broken endpoint references", () => {
    expect(normalizeBeagleSnapshot(snapshot).edges[0]?.derived).toBe(true);
    expect(normalizeBeagleQueryResult(snapshot, "project").graph.nodes).toHaveLength(2);
    expect(() => normalizeBeagleSnapshot({ ...snapshot, nodes: [snapshot.nodes[0]!] })).toThrow("missing endpoints");
    expect(() => normalizeBeagleSnapshot({ ...snapshot, nodes: [...snapshot.nodes, snapshot.nodes[0]!] })).toThrow("duplicate");
  });
});

describe("Beagle service", () => {
  let root: string;
  let runner: ReturnType<typeof vi.fn<BeagleCommandRunner>>;
  let service: BeagleService;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beagle-service-test-"));
    runner = vi.fn<BeagleCommandRunner>(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      if (args[4] === "stats") return response(statistics);
      if (args[4] === "export" || args[4] === "compose") return response(snapshot);
      if (args[4] === "ingest" || args[4] === "analyze" || args[4] === "tag") return response({ complete: true });
      return response({ columns: ["n"], rows: [{ n: user }] });
    });
    service = new BeagleService({ userDataPath: root, runner, environment: { SLIVER_BEAGLE_BINARY: "/chosen/beagle" } });
  });
  afterEach(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });

  it("creates persistent isolated projects with opaque directory identities", async () => {
    const first = await service.getState();
    expect(first.projects[0]?.name).toBe("Default");
    const next = await service.createProject({ name: "GOAD/../../lab" });
    expect(next.selectedProjectId).not.toBe(first.selectedProjectId);
    await service.query({ cypher: "RETURN 2" });
    const selectedCall = runner.mock.calls.at(-1)!;
    expect(selectedCall[1][1]).toBe(join(root, "beagle", next.selectedProjectId, "graph.db"));
    await service.selectProject({ id: first.selectedProjectId });
    const result = await service.query({ cypher: "RETURN 1" });
    expect(result.projectId).toBe(first.selectedProjectId);
    expect(runner.mock.calls.at(-1)?.[1][1]).toBe(join(root, "beagle", first.selectedProjectId, "graph.db"));
    const reloaded = new BeagleService({ userDataPath: root, runner, environment: { SLIVER_BEAGLE_BINARY: "/chosen/beagle" } });
    expect((await reloaded.getState()).projects).toEqual(next.projects);
    reloaded.dispose();
    await expect(service.selectProject({ id: "12345678-1234-4123-8123-123456789abc" })).rejects.toThrow("Unknown Beagle project");
    await expect(service.createProject({ name: "default" })).rejects.toThrow("already exists");
  });

  it("passes Cypher and hostile-looking data as distinct positional/option values", async () => {
    await service.query({ cypher: "--db /tmp/evil; $(touch /tmp/beagle-no)", parameters: { name: "'; rm -rf /" } });
    expect(runner.mock.calls.at(-1)?.[1].slice(4)).toEqual(["query", "--params", '{"name":"\'; rm -rf /"}', "--", "--db /tmp/evil; $(touch /tmp/beagle-no)"]);
    await service.search({ term: "--db=escape;`id`" });
    expect(runner.mock.calls.at(-1)?.[1].slice(4)).toEqual([
      "query", "--params", '{"term":"--db=escape;`id`","offset":0,"limit":101}', "--",
      expect.stringContaining("ORDER BY n.name, n.objectid SKIP $offset LIMIT $limit"),
    ]);
    await service.paths({ source: "--db=escape", target: "$(id)", all: true, maxHops: 3 });
    expect(runner.mock.calls.at(-1)?.[1].slice(4)).toEqual([
      "query", "--params", '{"source":"--db=escape","target":"$(id)"}', "--",
      expect.stringMatching(/^MATCH p=allShortestPaths\(.+\*1\.\.3\]/u),
    ]);
    await service.importFiles(["/tmp/collection;$(id).zip"]);
    expect(runner.mock.calls.find((call) => call[1][4] === "ingest")?.[1].slice(4)).toEqual(["ingest", "--analyze", "--", "/tmp/collection;$(id).zip"]);
  });

  it("returns bounded search pages without leaking the lookahead row into the graph", async () => {
    const nodes = Array.from({ length: 101 }, (_, index) => ({
      id: index, labels: ["Base", "User"], properties: { objectid: `U-${index}`, name: "SAME NAME" },
    }));
    const pages = [nodes, nodes.slice(100)];
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      return response({ columns: ["n"], rows: pages.shift()!.map((n) => ({ n })) });
    });
    const first = await service.search({ term: "same" });
    expect(first).toMatchObject({ page: { offset: 0, limit: 100, hasMore: true }, totalRows: 100, truncated: false });
    expect(first.rows).toHaveLength(100);
    expect(first.graph.nodes).toHaveLength(100);
    expect(first.graph.nodes.some((node) => node.objectid === "U-100")).toBe(false);
    const next = await service.search({ term: "same", offset: 100 });
    expect(next).toMatchObject({ page: { offset: 100, limit: 100, hasMore: false }, totalRows: 1, truncated: false });
    expect(next.graph.nodes.map((node) => node.objectid)).toEqual(["U-100"]);
    const queries = runner.mock.calls.filter((call) => call[1][4] === "query");
    expect(queries).toHaveLength(2);
    expect(queries.map((call) => JSON.parse(call[1][6]!))).toEqual([
      { term: "same", offset: 0, limit: 101 }, { term: "same", offset: 100, limit: 101 },
    ]);
  });
  it("pages neighborhoods with a count while keeping the lookahead out of the displayed graph", async () => {
    const rows = Array.from({ length: 251 }, (_, index) => ({ n: user, m: { ...group, id: index + 100, properties: { objectid: `G${index}`, name: "Same" } },
      r: { ...relationship, id: index + 1000, endNode: index + 100 } }));
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      if (args.at(-1)?.includes(" AS total")) return response({ columns: ["total"], rows: [{ total: 1727 }] });
      return response({ columns: ["n", "r", "m"], rows });
    });
    const result = await service.neighborhood({ objectid: "U", offset: 250 });
    expect(result.page).toEqual({ offset: 250, limit: 250, total: 1727, hasMore: true });
    expect(result.rows).toHaveLength(250);
    expect(result.graph.edges).toHaveLength(250);
    expect(result.graph.nodes.some((node) => node.objectid === "G250")).toBe(false);
    expect(result.truncated).toBe(false);
    const queries = runner.mock.calls.filter((call) => call[1][4] === "query");
    expect(queries).toHaveLength(2);
    expect(JSON.parse(queries[1]![1][6]!)).toEqual({ objectid: "U", offset: 250, limit: 251 });
  });
  it("applies typed path filters to every ordered leg and returns no misleading partial route", async () => {
    let calls = 0;
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      calls++;
      return response({ columns: ["p"], rows: calls === 1 ? [{ p: { nodes: [user, group], relationships: [relationship] } }] : [] });
    });
    const result = await service.paths({ source: "U", via: ["G"], target: "C", relationshipKinds: ["MemberOf", "AdminTo"], maxHops: 5 });
    expect(result.graph).toEqual({ nodes: [], edges: [] });
    const queries = runner.mock.calls.filter((call) => call[1][4] === "query");
    expect(queries.map((call) => JSON.parse(call[1][6]!))).toEqual([{ source: "U", target: "G" }, { source: "G", target: "C" }]);
    expect(queries.every((call) => call[1].at(-1)?.includes("[:MemberOf|AdminTo*1..5]"))).toBe(true);
  });
  it("runs foreign-principal adjacency traversal and returns counted object pages", async () => {
    const computer = { id: 99, labels: ["Base", "Computer"], properties: { objectid: "C", name: "Computer" } };
    const admin = { id: 91, startNode: 7, endNode: 99, type: "AdminTo", properties: {} };
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      const parameters = JSON.parse(args[6]!) as { current?: string };
      const rows = parameters.current === undefined ? [{ source: group, edge: admin, target: computer, traverse: true, foreign: false }]
        : parameters.current === "G" ? [{ source: user, edge: relationship, target: group }] : [];
      return response({ columns: ["source", "edge", "target", "traverse", "foreign"], rows });
    });
    const result = await service.neighborhood({ objectid: "D", view: "domain-foreign_admins" });
    expect(result.page).toEqual({ offset: 0, limit: 250, total: 1, hasMore: false });
    expect(result.rows).toHaveLength(1);
    expect(result.graph.nodes.map((node) => node.objectid).sort()).toEqual(["C", "G", "U"]);
    expect(result.graph.edges.map((edge) => edge.kind).sort()).toEqual(["AdminTo", "MemberOf"]);
  });
  it("uses the selectable CE relationship set when path filters are omitted", async () => {
    await service.paths({ source: "U", target: "G" });
    const cypher = runner.mock.calls.at(-1)![1].at(-1)!;
    expect(cypher).toContain("ProtectAdminGroups");
    expect(cypher).toContain("WriteDacl");
    expect(cypher).not.toMatch(/AD_ATTACK_PATHS|WriteDACL|CanApplyGPO|ContainsIdentity|GPOAppliesTo|PropagatesACEsTo/u);
  });
  it("persists analysis ambiguity warnings per project and retains them across unrelated operations", async () => {
    const first = await service.getState();
    runner.mockImplementation(async (_binary, args) => {
      if (args[4] === "stats") return response(statistics);
      if (args[4] === "analyze") return response({ local_group_ambiguities: [{ computer: "C", suffix: "-544", relationship_kind: "AdminTo", selected_group: "C-544", candidate_groups: { "C-544": ["U"], "D-544": ["OTHER"] } }] });
      return response({ complete: true });
    });
    const analyzed = await service.analyze();
    expect(analyzed.state.diagnostics?.localGroupAmbiguities[0]).toMatchObject({ computer: "C", relationshipKind: "AdminTo", selectedGroup: "C-544" });
    expect(analyzed.state.diagnostics?.errors).toEqual([]);
    expect((await service.tag({ objectid: "U", tag: "owned", enabled: true })).state.diagnostics).toEqual(analyzed.state.diagnostics);
    expect((await service.createProject({ name: "Other" })).diagnostics).toBeUndefined();
    expect((await service.selectProject({ id: first.selectedProjectId })).diagnostics).toEqual(analyzed.state.diagnostics);
    runner.mockImplementation(async (_binary, args) => {
      if (args[4] === "analyze") throw new Error("output lost after native operation");
      return response(statistics);
    });
    await expect(service.analyze()).rejects.toThrow("output lost");
    expect((await service.getState()).diagnostics?.errors[0]).toContain("not completed with verified diagnostics");
    await writeFile(join(root, "beagle", first.selectedProjectId, "analysis-diagnostics.json"), "invalid json");
    expect((await service.getState()).diagnostics?.errors).toHaveLength(1);
  });

  it.each([0, 100])("marks a complete search page of %s rows as having no next page", async (count) => {
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      return response({ columns: ["n"], rows: Array.from({ length: count }, (_, id) => ({
        n: { id, labels: ["User"], properties: { objectid: `U-${id}` } },
      })) });
    });
    const result = await service.search({ term: "U-", offset: 200 });
    expect(result.page).toEqual({ offset: 200, limit: 100, hasMore: false });
    expect(result.rows).toHaveLength(count);
    expect(result.totalRows).toBe(count);
    expect(result.truncated).toBe(false);
  });

  it("rejects custom file reads before starting a child and rejects unsafe saved sources", async () => {
    expect(() => service.query({ cypher: "LOAD CSV FROM $file AS row RETURN row", parameters: { file: "/tmp/private" } })).toThrow("File access");
    expect(runner).not.toHaveBeenCalled();
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      return response({ parameterized_query: "CALL apoc.periodic.iterate($producer, $action, {})" });
    });
    await expect(service.runSavedQuery({ id: "unsafe", parameters: { producer: "LOAD CSV FROM '/tmp/private' AS row RETURN row", action: "RETURN row" } })).rejects.toThrow("File access");
    expect(runner.mock.calls.some((call) => call[1][4] === "query")).toBe(false);
  });

  it("checks current saved query source while preserving native bound-parameter execution", async () => {
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      if (args[4] === "queries") return response({ parameterized_query: "RETURN $name AS name" });
      return response({ columns: ["name"], rows: [{ name: "LOAD CSV" }] });
    });
    expect((await service.runSavedQuery({ id: "safe", parameters: { name: "LOAD CSV" } })).rows).toEqual([{ name: "LOAD CSV" }]);
    expect(runner.mock.calls.at(-2)?.[1].slice(4)).toEqual(["queries", "--", "safe"]);
    expect(runner.mock.calls.at(-1)?.[1].slice(4)).toEqual(["query", "--saved=safe", "--params", '{"name":"LOAD CSV"}']);
  });

  it("serializes reads, mutations and project changes, and continues after failed work", async () => {
    await service.getState();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    runner.mockImplementation(async (_binary, args) => {
      order.push(args[4]!);
      if (args[4] === "ingest") { await barrier; throw new Error("bad collection"); }
      if (args[4] === "stats") return response(statistics);
      return response({ columns: ["n"], rows: [] });
    });
    const failed = service.importFiles(["/tmp/data.zip"]).catch((error: unknown) => error);
    const query = service.query({ cypher: "RETURN 1" });
    const create = service.createProject({ name: "Second" });
    await vi.waitFor(() => expect(order).toEqual(["ingest"]));
    release?.();
    expect(await failed).toEqual(new Error("bad collection"));
    const queryResult = await query;
    const newProject = await create;
    expect(order).toEqual(["ingest", "query", "stats"]);
    expect(queryResult.projectId).not.toBe(newProject.selectedProjectId);
  });

  it("hydrates relationship-only query results within the same database operation", async () => {
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      if (args.at(-1) === "MATCH (n) WHERE id(n) IN $ids RETURN n") return response({ columns: ["n"], rows: [{ n: user }, { n: group }] });
      return response({ columns: ["r"], rows: [{ r: relationship }] });
    });
    const result = await service.query({ cypher: "MATCH ()-[r]->() RETURN r" });
    expect(result.graph.nodes.map((node) => node.objectid)).toEqual(["U", "G"]);
    expect(result.graph.edges[0]).toMatchObject({ source: "U", target: "G", kind: "MemberOf" });
    expect(runner.mock.calls.at(-1)?.[1]).toContain('{"ids":[42,7]}');
    expect(runner.mock.calls.at(-1)?.[1][1]).toBe(runner.mock.calls.at(-2)?.[1][1]);
  });

  it("loads backend template schemas instead of inferring parameters from literal placeholders", async () => {
    const raw = { guid: "template", name: "Computer template", query: "MATCH (n) WHERE n.name = 'HOSTNAME' RETURN n" };
    const enriched = { ...raw, parameterized_query: "MATCH (n) WHERE n.name = $hostname RETURN n", parameters: { hostname: "string" } };
    runner.mockImplementation(async (_binary, args) => {
      const probe = runtimeResponse(args); if (probe) return probe;
      if (args[4] === "stats") return response(statistics);
      return response(args[5] === "--" ? enriched : [raw]);
    });
    const catalog = await service.getQueries();
    expect(catalog).toEqual([{ id: "template", name: raw.name, description: "", category: "Other", cypher: enriched.parameterized_query, parameters: ["hostname"] }]);
    expect(runner.mock.calls.at(-1)?.[1].slice(4)).toEqual(["queries", "--", "template"]);
    const calls = runner.mock.calls.length;
    catalog[0]!.parameters.push("mutated");
    expect((await service.getQueries())[0]?.parameters).toEqual(["hostname"]);
    expect(runner).toHaveBeenCalledTimes(calls);
    await service.configureBinary("/native/another-beagle");
    await service.getQueries();
    expect(runner.mock.calls.filter((call) => call[1][4] === "queries")).toHaveLength(4);
  });

  it("keeps export complete even when display limits apply", async () => {
    const nodes = Array.from({ length: BEAGLE_RESULT_LIMITS.nodes + 1 }, (_, index) => ({ objectid: String(index), labels: ["User"], properties: {} }));
    runner.mockImplementation(async (_binary, args) => runtimeResponse(args) ?? response({ nodes, edges: [] }));
    expect((await service.exportGraph()).nodes).toHaveLength(nodes.length);
  });

  it("reports missing runtime and can recover using a selected executable", async () => {
    runner.mockImplementation(async () => { throw new Error("not found"); });
    expect((await service.getState()).runtime.available).toBe(false);
    await expect(service.query({ cypher: "RETURN 1" })).rejects.toThrow("Choose a Beagle executable");
    runner.mockImplementation(async (binary, args) => {
      if (binary !== "/native/beagle") throw new Error("not found");
      return runtimeResponse(args) ?? response(statistics);
    });
    expect((await service.configureBinary("/native/beagle")).runtime).toEqual({ available: true, version: "beagle 0.1.0", source: "Selected executable" });
    const saved: unknown = JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8"));
    expect(saved).toMatchObject({ binaryPath: "/native/beagle" });
    expect(() => service.configureBinary("relative-path")).toThrow("absolute path");
  });
  it("rejects unsupported runtime versions and missing query capabilities before opening a project", async () => {
    runner.mockImplementation(async () => ({ stdout: "beagle 9.0.0", stderr: "" }));
    await expect(service.configureBinary("/native/future-beagle")).rejects.toThrow("supports the Beagle 0.1.x interface");
    expect(runner.mock.calls.every((call) => call[1][0] === "--version")).toBe(true);
    runner.mockClear();
    runner.mockImplementation(async (_binary, args) => args[1] === ":memory:"
      ? response({ ...capabilityProbe, capabilities: { schema_version: 1, features: { parameters: true } } })
      : runtimeResponse(args)!);
    await expect(service.configureBinary("/native/incomplete-beagle")).rejects.toThrow("query capabilities");
    expect(runner.mock.calls.filter((call) => call[1][0] === "--db").every((call) => call[1][1] === ":memory:")).toBe(true);
    runner.mockImplementation(async (_binary, args) => args[0] === "--help" ? { stdout: "no commands", stderr: "" } : runtimeResponse(args)!);
    await expect(service.configureBinary("/native/missing-commands")).rejects.toThrow("commands are missing");
  });

  it("discovers packaged runtime without a developer-specific path", async () => {
    const packaged = new BeagleService({ userDataPath: root, resourcesPath: "/app/resources", environment: { SLIVER_BEAGLE_BINARY: undefined }, runner });
    await packaged.getState();
    expect(runner.mock.calls[0]?.[0]).toBe(join("/app/resources", "beagle", process.platform === "win32" ? "beagle.exe" : "beagle"));
    expect((await packaged.getState()).runtime.source).toBe("Bundled runtime");
    packaged.dispose();
  });

  it("rejects malformed process output and applies deadlines and memory bounds", async () => {
    await service.getState();
    runner.mockResolvedValueOnce({ stdout: "not JSON", stderr: "" });
    await expect(service.query({ cypher: "RETURN 1" })).rejects.toThrow("invalid or oversized JSON");
    const queryOptions = runner.mock.calls.at(-1)?.[2];
    expect(queryOptions).toMatchObject({ timeout: 40_000, maxBuffer: 32 * 1024 * 1024 });
    runner.mockResolvedValueOnce(response({ error: "unsupported syntax" }));
    await expect(service.query({ cypher: "RETURN unsupported()" })).rejects.toThrow("unsupported syntax");
    await service.analyze();
    expect(runner.mock.calls.find((call) => call[1][4] === "analyze")?.[2].timeout).toBe(300_000);
  });

  it("does not replace corrupt project configuration with an empty database", async () => {
    await service.getState();
    await writeFile(join(root, "beagle", "projects.json"), '{"version":0}');
    const broken = new BeagleService({ userDataPath: root, runner });
    await expect(broken.getState()).rejects.toThrow("project configuration");
    expect(await readFile(join(root, "beagle", "projects.json"), "utf8")).toBe('{"version":0}');
    broken.dispose();
  });

  it("aborts the active child and rejects pending work on disposal", async () => {
    await service.getState();
    runner.mockImplementation(async (_binary, _args, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const running = service.query({ cypher: "RETURN 1" }).catch((error: unknown) => error);
    const pending = service.getState().catch((error: unknown) => error);
    await vi.waitFor(() => expect(runner.mock.calls.at(-1)?.[1][4]).toBe("query"));
    service.dispose();
    expect(await running).toEqual(new Error("aborted"));
    expect(await pending).toEqual(new Error("Beagle service is closed"));
  });
});
