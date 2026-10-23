// @vitest-environment node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BEAGLE_RESULT_LIMITS, type BeagleJsonValue } from "../shared/beagle-contracts.js";
import { assertBeagleGraphQuery, BeagleService, normalizeBeagleQueryResult, normalizeBeagleSnapshot } from "./beagle-service.js";
import type { BeagleRuntimeClient } from "./beagle-runtime.js";
import type { BeagleExecutableVerifier } from "./beagle-runtime-loader.js";
import { BEAGLE_RUNTIME_MAX_REQUEST_BYTES, BEAGLE_RUNTIME_MAX_RESPONSE_BYTES, BEAGLE_RUNTIME_OPERATIONS, BEAGLE_RUNTIME_REQUIRED_OPERATIONS, type BeagleRuntimeCommand, type BeagleRuntimeReady } from "../shared/beagle-runtime-contracts.js";

const statistics = { nodes: 2, edges: 1, labels: { Base: 2, User: 1, Group: 1 }, relationships: { MemberOf: 1 } };
const user = { id: 42, labels: ["Base", "User"], properties: { objectid: "U", name: "ALICE" } };
const group = { id: 7, labels: ["Base", "Group"], properties: { objectid: "G", name: "ADMINS" } };
const relationship = { id: 80, startNode: 42, endNode: 7, type: "MemberOf", properties: { isacl: false } };
const snapshot = {
  nodes: [{ objectid: "U", labels: user.labels, properties: user.properties }, { objectid: "G", labels: group.labels, properties: group.properties }],
  edges: [{ source: "U", target: "G", kind: "MemberOf", derived: true, properties: { isacl: false } }],
};
const capabilityProbe = { ...statistics, capabilities: { schema_version: 1, features: Object.fromEntries(["parameters", "shortest_path", "variable_length_paths", "named_paths", "optional_match", "with_where", "call_subquery", "union", "existential_subquery_full", "list_comprehension", "quantifiers"].map((key) => [key, true])) } };
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
  const digest = "a".repeat(64);
  const ready: BeagleRuntimeReady = { type: "ready", protocol: 1, name: "beagle", version: "0.1.0",
    operations: BEAGLE_RUNTIME_OPERATIONS,
    limits: { requestBytes: BEAGLE_RUNTIME_MAX_REQUEST_BYTES, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES } };
  type FakeClient = BeagleRuntimeClient & {
    closed: boolean;
    database?: string;
    request: ReturnType<typeof vi.fn<BeagleRuntimeClient["request"]>>;
    stop: ReturnType<typeof vi.fn<BeagleRuntimeClient["stop"]>>;
  };
  let root: string;
  let request: ReturnType<typeof vi.fn<BeagleRuntimeClient["request"]>>;
  let createRuntime: ReturnType<typeof vi.fn<(path: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => BeagleRuntimeClient>>;
  let verifier: { capture: ReturnType<typeof vi.fn<BeagleExecutableVerifier["capture"]>>; verify: ReturnType<typeof vi.fn<BeagleExecutableVerifier["verify"]>> };
  let clients: FakeClient[];
  let probe: BeagleJsonValue;
  let service: BeagleService;
  let services: BeagleService[];

  function makeClient(readiness = Promise.resolve(ready)): FakeClient {
    let database: string | undefined;
    const client: FakeClient = {
      ready: readiness, closed: false,
      request: vi.fn(async (command, options) => {
        if (command.type === "open") { database = command.database; client.database = database; return null; }
        if (command.type === "closeDatabase") { database = undefined; delete client.database; return null; }
        if (command.type === "backup") await copyFile(database!, command.path, 1);
        if (command.type === "stats" && database === ":memory:") return probe;
        return request(command, options);
      }),
      stop: vi.fn(async () => { client.closed = true; }),
    };
    clients.push(client);
    return client;
  }
  function newService(environment: NodeJS.ProcessEnv = { SLIVER_BEAGLE_BINARY: "/chosen/beagle", SLIVER_BEAGLE_SHA256: digest }): BeagleService {
    const instance = new BeagleService({ userDataPath: root, createRuntime, verifier, environment });
    services.push(instance);
    return instance;
  }
  function queries(): Extract<BeagleRuntimeCommand, { type: "query" }>[] {
    return request.mock.calls.map(([command]) => command).filter((command): command is Extract<BeagleRuntimeCommand, { type: "query" }> => command.type === "query");
  }
  function activeClient(): FakeClient { return clients.at(-1)!; }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "beagle-service-test-"));
    clients = []; services = []; probe = capabilityProbe;
    request = vi.fn(async (command) => {
      if (command.type === "stats") return statistics;
      if (command.type === "export" || command.type === "compose") return snapshot;
      if (command.type === "ingest" || command.type === "analyze" || command.type === "tag") return { complete: true };
      return { columns: ["n"], rows: [{ n: user }] };
    });
    createRuntime = vi.fn(() => makeClient());
    verifier = {
      capture: vi.fn(async (path) => ({ path, sha256: digest, size: 42 })),
      verify: vi.fn(async (path, sha256) => {
        if (!isAbsolute(path) || sha256.length !== 64 || !/^[a-f0-9]{64}$/iu.test(sha256)) throw new Error("Unverified executable");
        return { path, sha256, size: 42 };
      }),
    };
    service = newService();
  });
  afterEach(async () => { await Promise.all(services.map((instance) => instance.dispose())); await rm(root, { recursive: true, force: true }); });

  it("creates persistent isolated projects and stops the previous owner before changing databases", async () => {
    const first = await service.getState();
    expect(first.projects[0]?.name).toBe("Default");
    const firstClient = activeClient();
    const next = await service.createProject({ name: "GOAD/../../lab" });
    expect(next.selectedProjectId).not.toBe(first.selectedProjectId);
    expect(firstClient.stop).toHaveBeenCalledOnce();
    expect(activeClient().request.mock.calls[0]?.[0]).toMatchObject({ type: "open", database: join(root, "beagle", next.selectedProjectId, "graph.db") });
    await service.query({ cypher: "RETURN 2" });
    await service.selectProject({ id: first.selectedProjectId });
    expect((await service.query({ cypher: "RETURN 1" })).projectId).toBe(first.selectedProjectId);
    expect(activeClient().request.mock.calls[0]?.[0]).toMatchObject({ type: "open", database: join(root, "beagle", first.selectedProjectId, "graph.db") });
    expect((await newService().getState()).projects).toEqual(next.projects);
    await expect(service.selectProject({ id: "12345678-1234-4123-8123-123456789abc" })).rejects.toThrow("Unknown Beagle project");
    await expect(service.createProject({ name: "default" })).rejects.toThrow("already exists");
  });

  it("removes only abandoned private regular staging files once per project on startup", async () => {
    const state = await service.getState(), directory = join(root, "beagle", state.selectedProjectId);
    await service.dispose();
    const id = "11111111-1111-4111-8111-111111111111";
    const abandoned = [`.mutation-${id}.db`, `.mutation-${id}.db-wal`, `.mutation-${id}.db-shm`, `.mutation-${id}.db-journal`, `.backup-${id}.db`, `.backup-${id}.db-journal`, `.empty-${id}.json`];
    for (const name of abandoned) await writeFile(join(directory, name), "abandoned");
    const preserved = ["graph.db", "graph.db-wal", "workspace.json", "project-data.json", ".mutation-user.db", `.mutation-${id}.db.extra`, `.backup-${id}.json`, `.empty-${id}.json.backup`, ".mutation-11111111-1111-1111-8111-111111111111.db"];
    for (const name of preserved) await writeFile(join(directory, name), "preserved");
    const linkName = ".mutation-22222222-2222-4222-8222-222222222222.db", target = join(root, "outside.db");
    await writeFile(target, "symlink target"); await symlink(target, join(directory, linkName));
    const directoryName = ".backup-33333333-3333-4333-8333-333333333333.db";
    await mkdir(join(directory, directoryName)); await writeFile(join(directory, directoryName, "keep"), "directory contents");
    const restarted = newService(); await restarted.getState();
    const names = await readdir(directory);
    expect(abandoned.every((name) => !names.includes(name))).toBe(true);
    for (const name of preserved) expect(await readFile(join(directory, name), "utf8")).toBe("preserved");
    expect((await lstat(join(directory, linkName))).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("symlink target");
    expect(await readFile(join(directory, directoryName, "keep"), "utf8")).toBe("directory contents");
    // Recovery must not run again while this owner may have live staging files.
    const current = join(directory, `.mutation-${id}.db`); await writeFile(current, "current process stage");
    await restarted.getState();
    const second = await restarted.createProject({ name: "Second" });
    const secondDirectory = join(root, "beagle", second.selectedProjectId);
    await restarted.selectProject({ id: state.selectedProjectId });
    expect(await readFile(current, "utf8")).toBe("current process stage");
    await restarted.dispose();
    await writeFile(join(secondDirectory, `.empty-${id}.json`), "abandoned second project");
    const nextStart = newService(); await nextStart.selectProject({ id: second.selectedProjectId });
    expect(await readdir(secondDirectory)).not.toContain(`.empty-${id}.json`);
  });

  it("recovers before creating an empty collection input on the first operation", async () => {
    const state = await service.getState(); await service.dispose();
    const restarted = newService(), directory = join(root, "beagle", state.selectedProjectId);
    const orphan = join(directory, ".empty-11111111-1111-4111-8111-111111111111.json");
    await writeFile(orphan, "abandoned");
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command, options) => {
      if (command.type === "importSnapshot") {
        expect(JSON.parse(await readFile(command.path, "utf8"))).toEqual({ nodes: [], edges: [] });
        expect(await readdir(directory)).not.toContain(orphan.split("/").at(-1));
        return { complete: true };
      }
      return fallback(command, options);
    });
    await restarted.cleanup({ scope: "collected" });
    expect((await readdir(directory)).some((name) => name.startsWith(".empty-") || name.startsWith(".mutation-"))).toBe(false);
  });

  it("keeps one helper and database open across consecutive operations", async () => {
    await service.getState();
    const client = activeClient();
    await service.query({ cypher: "RETURN 1" });
    await service.entity({ objectid: "U" });
    await service.tag({ objectid: "U", tag: "owned", enabled: true });
    expect(createRuntime).toHaveBeenCalledTimes(2); // One compatibility probe and one project owner.
    expect(client.request.mock.calls.filter(([command]) => command.type === "open")).toHaveLength(3); // Original, staged copy, published database.
    expect(client.request.mock.calls.filter(([command]) => command.type === "closeDatabase")).toHaveLength(2);
    expect(client.stop).not.toHaveBeenCalled();
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
  });

  it("waits for the previous helper to close before starting the next project owner", async () => {
    await service.getState();
    let finish!: () => void;
    const client = activeClient();
    client.stop.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = () => { client.closed = true; resolve(); }; }));
    const changing = service.createProject({ name: "Second" });
    await vi.waitFor(() => expect(client.stop).toHaveBeenCalledOnce());
    expect(createRuntime).toHaveBeenCalledTimes(2);
    finish();
    await changing;
    expect(createRuntime).toHaveBeenCalledTimes(3);
  });

  it("passes hostile-looking Cypher, identifiers and file names as typed data", async () => {
    await service.query({ cypher: "--db /tmp/evil; $(touch /tmp/beagle-no)", parameters: { name: "'; rm -rf /" } });
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "query", cypher: "--db /tmp/evil; $(touch /tmp/beagle-no)", parameters: { name: "'; rm -rf /" } });
    await service.search({ term: "--db=escape;`id`" });
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "query", parameters: { term: "--db=escape;`id`", offset: 0, limit: 101 }, cypher: expect.stringContaining("ORDER BY n.name, n.objectid SKIP $offset LIMIT $limit") });
    await service.paths({ source: "--db=escape", target: "$(id)", all: true, maxHops: 3 });
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "query", parameters: { source: "--db=escape", target: "$(id)" }, cypher: expect.stringMatching(/^MATCH p=allShortestPaths\(.+\*1\.\.3\]/u) });
    const path = join(root, "collection;$(id).zip");
    await writeFile(path, "selected file");
    await service.importFiles([path]);
    expect(request.mock.calls.find(([command]) => command.type === "ingest")?.[0]).toEqual({ type: "ingest", paths: [path], analyze: true, mode: "merge", compactReports: true, historyLimit: 50 });
  });

  it("returns bounded search pages without leaking the lookahead row into the graph", async () => {
    const nodes = Array.from({ length: 101 }, (_, index) => ({ id: index, labels: ["Base", "User"], properties: { objectid: `U-${index}`, name: "SAME NAME" } }));
    const pages = [nodes, nodes.slice(100)];
    request.mockImplementation(async () => ({ columns: ["n"], rows: pages.shift()!.map((n) => ({ n })) }));
    const first = await service.search({ term: "same" });
    expect(first).toMatchObject({ page: { offset: 0, limit: 100, hasMore: true }, totalRows: 100, truncated: false });
    expect(first.rows).toHaveLength(100);
    expect(first.graph.nodes).toHaveLength(100);
    expect(first.graph.nodes.some((node) => node.objectid === "U-100")).toBe(false);
    const next = await service.search({ term: "same", offset: 100 });
    expect(next).toMatchObject({ page: { offset: 100, limit: 100, hasMore: false }, totalRows: 1, truncated: false });
    expect(next.graph.nodes.map((node) => node.objectid)).toEqual(["U-100"]);
    expect(queries().map((command) => command.parameters)).toEqual([{ term: "same", offset: 0, limit: 101 }, { term: "same", offset: 100, limit: 101 }]);
  });

  it("pages neighborhoods with a count while keeping the lookahead out of the displayed graph", async () => {
    const rows = Array.from({ length: 251 }, (_, index) => ({ n: user, m: { ...group, id: index + 100, properties: { objectid: `G${index}`, name: "Same" } }, r: { ...relationship, id: index + 1000, endNode: index + 100 } }));
    request.mockImplementation(async (command) => command.type === "query" && command.cypher.includes(" AS total")
      ? { columns: ["total"], rows: [{ total: 1727 }] } : { columns: ["n", "r", "m"], rows });
    const result = await service.neighborhood({ objectid: "U", offset: 250 });
    expect(result.page).toEqual({ offset: 250, limit: 250, total: 1727, hasMore: true });
    expect(result.rows).toHaveLength(250);
    expect(result.graph.edges).toHaveLength(250);
    expect(result.graph.nodes.some((node) => node.objectid === "G250")).toBe(false);
    expect(result.truncated).toBe(false);
    expect(queries()).toHaveLength(2);
    expect(queries()[1]?.parameters).toEqual({ objectid: "U", offset: 250, limit: 251 });
  });

  it("applies typed path filters to every ordered leg and returns no misleading partial route", async () => {
    let calls = 0;
    request.mockImplementation(async () => ({ columns: ["p"], rows: ++calls === 1 ? [{ p: { nodes: [user, group], relationships: [relationship] } }] : [] }));
    const result = await service.paths({ source: "U", via: ["G"], target: "C", relationshipKinds: ["MemberOf", "AdminTo"], maxHops: 5 });
    expect(result.graph).toEqual({ nodes: [], edges: [] });
    expect(queries().map((command) => command.parameters)).toEqual([{ source: "U", target: "G" }, { source: "G", target: "C" }]);
    expect(queries().every((command) => command.cypher.includes("[:MemberOf|AdminTo*1..5]"))).toBe(true);
  });

  it("runs foreign-principal adjacency traversal and returns counted object pages", async () => {
    const computer = { id: 99, labels: ["Base", "Computer"], properties: { objectid: "C", name: "Computer" } };
    const admin = { id: 91, startNode: 7, endNode: 99, type: "AdminTo", properties: {} };
    request.mockImplementation(async (command) => {
      const current = command.type === "query" ? command.parameters["current"] : undefined;
      const rows = current === undefined ? [{ source: group, edge: admin, target: computer, traverse: true, foreign: false }]
        : current === "G" ? [{ source: user, edge: relationship, target: group }] : [];
      return { columns: ["source", "edge", "target", "traverse", "foreign"], rows };
    });
    const result = await service.neighborhood({ objectid: "D", view: "domain-foreign_admins" });
    expect(result.page).toEqual({ offset: 0, limit: 250, total: 1, hasMore: false });
    expect(result.rows).toHaveLength(1);
    expect(result.graph.nodes.map((node) => node.objectid).sort()).toEqual(["C", "G", "U"]);
    expect(result.graph.edges.map((edge) => edge.kind).sort()).toEqual(["AdminTo", "MemberOf"]);
  });

  it("uses the selectable CE relationship set when path filters are omitted", async () => {
    await service.paths({ source: "U", target: "G" });
    expect(queries().at(-1)?.cypher).toContain("ProtectAdminGroups");
    expect(queries().at(-1)?.cypher).toContain("WriteDacl");
    expect(queries().at(-1)?.cypher).not.toMatch(/AD_ATTACK_PATHS|WriteDACL|CanApplyGPO|ContainsIdentity|GPOAppliesTo|PropagatesACEsTo/u);
  });

  it("persists analysis ambiguity warnings per project and retains them across unrelated operations", async () => {
    const first = await service.getState();
    request.mockImplementation(async (command) => {
      if (command.type === "stats") return statistics;
      if (command.type === "analyze") return { local_group_ambiguities: [{ computer: "C", suffix: "-544", relationship_kind: "AdminTo", selected_group: "C-544", candidate_groups: { "C-544": ["U"], "D-544": ["OTHER"] } }] };
      return { complete: true };
    });
    const analyzed = await service.analyze();
    expect(analyzed.state.diagnostics?.localGroupAmbiguities[0]).toMatchObject({ computer: "C", relationshipKind: "AdminTo", selectedGroup: "C-544" });
    expect(analyzed.state.diagnostics?.errors).toEqual([]);
    expect((await service.tag({ objectid: "U", tag: "owned", enabled: true })).state.diagnostics).toEqual(analyzed.state.diagnostics);
    expect((await service.createProject({ name: "Other" })).diagnostics).toBeUndefined();
    expect((await service.selectProject({ id: first.selectedProjectId })).diagnostics).toEqual(analyzed.state.diagnostics);
    request.mockImplementation(async (command) => { if (command.type === "analyze") throw new Error("output lost after native operation"); return statistics; });
    await expect(service.analyze()).rejects.toThrow("output lost");
    expect((await service.getState()).diagnostics).toEqual(analyzed.state.diagnostics); // Failed stage never replaced the committed graph or its diagnostics.
    await writeFile(join(root, "beagle", first.selectedProjectId, "analysis-diagnostics.json"), "invalid json");
    expect((await service.getState()).diagnostics?.errors).toHaveLength(1);
  });

  it.each([0, 100])("marks a complete search page of %s rows as having no next page", async (count) => {
    request.mockImplementation(async () => ({ columns: ["n"], rows: Array.from({ length: count }, (_, id) => ({ n: { id, labels: ["User"], properties: { objectid: `U-${id}` } } })) }));
    const result = await service.search({ term: "U-", offset: 200 });
    expect(result.page).toEqual({ offset: 200, limit: 100, hasMore: false });
    expect(result.rows).toHaveLength(count);
    expect(result.totalRows).toBe(count);
    expect(result.truncated).toBe(false);
  });

  it("rejects custom file reads before starting a child and rejects unsafe saved sources", async () => {
    expect(() => service.query({ cypher: "LOAD CSV FROM $file AS row RETURN row", parameters: { file: "/tmp/private" } })).toThrow("File access");
    expect(createRuntime).not.toHaveBeenCalled();
    request.mockResolvedValue({ parameterized_query: "CALL apoc.periodic.iterate($producer, $action, {})" });
    await expect(service.runSavedQuery({ id: "unsafe", parameters: { producer: "LOAD CSV FROM '/tmp/private' AS row RETURN row", action: "RETURN row" } })).rejects.toThrow("File access");
    expect(request.mock.calls.some(([command]) => command.type === "savedQuery")).toBe(false);
  });

  it("checks current saved query source while preserving native bound-parameter execution", async () => {
    request.mockImplementation(async (command) => command.type === "savedQueryInfo"
      ? { parameterized_query: "RETURN $name AS name" } : { columns: ["name"], rows: [{ name: "LOAD CSV" }] });
    expect((await service.runSavedQuery({ id: "safe", parameters: { name: "LOAD CSV" } })).rows).toEqual([{ name: "LOAD CSV" }]);
    expect(request.mock.calls.at(-2)?.[0]).toEqual({ type: "savedQueryInfo", id: "safe" });
    expect(request.mock.calls.at(-1)?.[0]).toEqual({ type: "savedQuery", id: "safe", parameters: { name: "LOAD CSV" } });
  });

  it("serializes reads, mutations and project changes, and continues after failed work", async () => {
    await service.getState();
    const order: string[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    request.mockImplementation(async (command) => {
      order.push(command.type);
      if (command.type === "ingest") { await barrier; throw new Error("bad collection"); }
      if (command.type === "stats") return statistics;
      return { columns: ["n"], rows: [] };
    });
    const path = join(root, "data.zip");
    await writeFile(path, "selected file");
    const failed = service.importFiles([path]).catch((error: unknown) => error);
    const query = service.query({ cypher: "RETURN 1" });
    const create = service.createProject({ name: "Second" });
    await vi.waitFor(() => expect(order).toEqual(["backup", "ingest"]));
    release();
    expect(await failed).toEqual(new Error("bad collection"));
    const queryResult = await query;
    const newProject = await create;
    expect(order).toEqual(["backup", "ingest", "query", "stats"]);
    expect(queryResult.projectId).not.toBe(newProject.selectedProjectId);
  });

  it("hydrates relationship-only results in the same persistent helper and database", async () => {
    request.mockImplementation(async (command) => command.type === "query" && command.cypher === "MATCH (n) WHERE id(n) IN $ids RETURN n"
      ? { columns: ["n"], rows: [{ n: user }, { n: group }] } : { columns: ["r"], rows: [{ r: relationship }] });
    const result = await service.query({ cypher: "MATCH ()-[r]->() RETURN r" });
    expect(result.graph.nodes.map((node) => node.objectid)).toEqual(["U", "G"]);
    expect(result.graph.edges[0]).toMatchObject({ source: "U", target: "G", kind: "MemberOf" });
    expect(queries().at(-1)?.parameters).toEqual({ ids: [42, 7] });
    expect(activeClient().request.mock.calls.filter(([command]) => command.type === "query")).toHaveLength(2);
    expect(activeClient().request.mock.calls.filter(([command]) => command.type === "open")).toHaveLength(1);
  });

  it("loads all 177 authoritative template schemas in one cached catalog request", async () => {
    const enriched = { guid: "template", name: "Computer template", query: "MATCH (n) WHERE n.name = 'HOSTNAME' RETURN n",
      parameterized_query: "MATCH (n) WHERE n.name = $hostname RETURN n", parameters: { hostname: "string" } };
    const catalogData = Array.from({ length: 177 }, (_, index) => ({ ...enriched, guid: `template-${index}` }));
    request.mockImplementation(async (command) => command.type === "stats" ? statistics : catalogData);
    const catalog = await service.getQueries();
    expect(catalog).toHaveLength(177);
    expect(catalog[0]).toEqual({ id: "template-0", name: enriched.name, description: "", category: "Other", cypher: enriched.parameterized_query, parameters: ["hostname"] });
    expect(request).toHaveBeenCalledExactlyOnceWith({ type: "catalog" }, expect.objectContaining({ timeout: 40_000 }));
    catalog[0]!.parameters.push("mutated");
    expect((await service.getQueries())[0]?.parameters).toEqual(["hostname"]);
    expect(request).toHaveBeenCalledOnce();
    await service.configureBinary("/native/another-beagle");
    await service.getQueries();
    expect(request.mock.calls.filter(([command]) => command.type === "catalog")).toHaveLength(2);
  });

  it("keeps export complete even when display limits apply", async () => {
    const nodes = Array.from({ length: BEAGLE_RESULT_LIMITS.nodes + 1 }, (_, index) => ({ objectid: String(index), labels: ["User"], properties: {} }));
    request.mockResolvedValue({ nodes, edges: [] });
    expect((await service.exportGraph()).nodes).toHaveLength(nodes.length);
  });

  it("reports missing runtime and recovers after explicit executable selection, saving the captured pin", async () => {
    verifier.verify.mockRejectedValue(new Error("private loader path and diagnostics"));
    expect((await service.getState()).runtime).toMatchObject({ available: false, error: expect.not.stringContaining("private loader") });
    await expect(service.query({ cypher: "RETURN 1" })).rejects.toThrow("Choose a Beagle executable");
    expect(createRuntime).not.toHaveBeenCalled();
    verifier.verify.mockImplementation(async (path, sha256) => ({ path, sha256, size: 42 }));
    expect((await service.configureBinary("/native/beagle")).runtime).toEqual({ available: true, version: "beagle 0.1.0", source: "Selected executable", operations: BEAGLE_RUNTIME_OPERATIONS });
    expect(verifier.capture).toHaveBeenCalledExactlyOnceWith("/native/beagle");
    expect(JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8"))).toMatchObject({ version: 2, binaryPath: "/native/beagle", binarySha256: digest });
    expect(() => service.configureBinary("relative-path")).toThrow("absolute path");
  });

  it("rejects incompatible ready handshakes and missing query capabilities before opening a project", async () => {
    createRuntime.mockImplementationOnce(() => makeClient(Promise.reject(new Error("Incompatible Beagle runtime protocol; update the Beagle executable"))));
    await expect(service.configureBinary("/native/future-beagle")).rejects.toThrow("Incompatible Beagle runtime protocol");
    expect(clients[0]?.request).not.toHaveBeenCalled();
    expect(clients[0]?.stop).toHaveBeenCalledOnce();
    probe = { ...capabilityProbe, capabilities: { schema_version: 1, features: { parameters: true } } };
    await expect(service.configureBinary("/native/incomplete-beagle")).rejects.toThrow("query capabilities");
    expect(clients.flatMap((client) => client.request.mock.calls).filter(([command]) => command.type === "open").every(([command]) => command.type === "open" && command.database === ":memory:")).toBe(true);
    expect(JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8"))).toMatchObject({ binaryPath: null, binarySha256: null });
  });

  it.each([
    { SLIVER_BEAGLE_BINARY: undefined, SLIVER_BEAGLE_SHA256: undefined, PATH: "/untrusted" },
    { SLIVER_BEAGLE_BINARY: "/untrusted/beagle", SLIVER_BEAGLE_SHA256: undefined },
    { SLIVER_BEAGLE_BINARY: "beagle", SLIVER_BEAGLE_SHA256: digest },
  ])("does not fall back to PATH or execute an unpinned environment candidate: %j", async (environment) => {
    expect((await newService(environment).getState()).runtime.available).toBe(false);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(verifier.capture).not.toHaveBeenCalled();
  });

  it("verifies the explicit environment pin before each launch and removes private environment values", async () => {
    const isolated = newService({ SLIVER_BEAGLE_BINARY: "/chosen/beagle", SLIVER_BEAGLE_SHA256: digest, HOME: "/home/operator", PATH: "/untrusted", AWS_SECRET_ACCESS_KEY: "secret", DYLD_INSERT_LIBRARIES: "injected", GRAPHQLITE_EXTENSION_PATH: "unsafe" });
    await isolated.getState();
    expect(verifier.verify).toHaveBeenCalledTimes(3); // Discovery, ephemeral probe, project process.
    expect(verifier.verify.mock.calls.every(([path, pin]) => path === "/chosen/beagle" && pin === digest)).toBe(true);
    for (const [, options] of createRuntime.mock.calls) {
      expect(options.env).toMatchObject({ HOME: "/home/operator" });
      for (const key of ["PATH", "AWS_SECRET_ACCESS_KEY", "DYLD_INSERT_LIBRARIES", "GRAPHQLITE_EXTENSION_PATH", "SLIVER_BEAGLE_BINARY", "SLIVER_BEAGLE_SHA256"]) expect(options.env).not.toHaveProperty(key);
    }
  });

  it("preserves legacy project metadata and requires reselecting an unpinned saved executable", async () => {
    const state = await service.getState();
    const legacy = { version: 1, binaryPath: "/legacy/beagle", selectedProjectId: state.selectedProjectId, projects: state.projects };
    await service.dispose();
    await writeFile(join(root, "beagle", "projects.json"), JSON.stringify(legacy));
    createRuntime.mockClear(); verifier.verify.mockClear();
    const migrated = newService();
    const before = await migrated.getState();
    expect(before.projects).toEqual(state.projects);
    expect(before.runtime.available).toBe(false);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8"))).toEqual(legacy);
    await migrated.configureBinary("/legacy/beagle");
    expect(JSON.parse(await readFile(join(root, "beagle", "projects.json"), "utf8"))).toMatchObject({ version: 2, binaryPath: "/legacy/beagle", binarySha256: digest, projects: state.projects });
  });

  it("rechecks the saved pin after restart and rejects a changed helper before spawning", async () => {
    await service.configureBinary("/native/beagle");
    await service.dispose();
    createRuntime.mockClear(); verifier.capture.mockClear();
    verifier.verify.mockRejectedValue(new Error("Executable bytes changed"));
    expect((await newService().getState()).runtime.available).toBe(false);
    expect(verifier.verify).toHaveBeenLastCalledWith("/native/beagle", digest);
    expect(createRuntime).not.toHaveBeenCalled();
    expect(verifier.capture).not.toHaveBeenCalled();
  });

  it("never replays a failed mutation and re-verifies before restarting a closed helper", async () => {
    await service.getState();
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command, options) => {
      if (command.type === "tag") { activeClient().closed = true; throw new Error("connection lost; outcome unknown"); }
      return fallback(command, options);
    });
    await expect(service.tag({ objectid: "U", tag: "owned", enabled: true })).rejects.toThrow("outcome unknown");
    expect(request.mock.calls.filter(([command]) => command.type === "tag")).toHaveLength(1);
    const launches = createRuntime.mock.calls.length;
    verifier.verify.mockRejectedValueOnce(new Error("Executable bytes changed"));
    await expect(service.query({ cypher: "RETURN 1" })).rejects.toThrow("Executable bytes changed");
    expect(createRuntime).toHaveBeenCalledTimes(launches);
    await service.query({ cypher: "RETURN 2" });
    expect(createRuntime).toHaveBeenCalledTimes(launches + 1);
    expect(request.mock.calls.filter(([command]) => command.type === "tag")).toHaveLength(1);
  });

  it("cancels a staged mutation without publishing native changes or continuing validation", async () => {
    const state = await service.getState();
    const directory = join(root, "beagle", state.selectedProjectId), database = join(directory, "graph.db");
    await writeFile(database, "committed bytes");
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command, options) => {
      if (command.type !== "analyze") return fallback(command, options);
      expect(activeClient().database).not.toBe(database);
      await writeFile(activeClient().database!, "native stage changed");
      return new Promise((resolve) => options.signal!.addEventListener("abort", () => resolve({ complete: true }), { once: true }));
    });
    const running = service.analyze().catch((error: unknown) => error);
    await vi.waitFor(() => expect(request.mock.calls.at(-1)?.[0].type).toBe("analyze"));
    const operation = service.getOperation()!;
    expect(service.cancelOperation({ id: "11111111-1111-4111-8111-111111111111" })).toEqual({ cancelled: false });
    expect(service.cancelOperation({ id: operation.id })).toEqual({ cancelled: true });
    expect(await running).toEqual(new Error("AD Explorer operation cancelled; the committed project was preserved"));
    expect(request.mock.calls.at(-1)?.[0].type).toBe("analyze");
    expect(await readFile(database, "utf8")).toBe("committed bytes");
    expect((await readdir(directory)).some((name) => name.startsWith(".mutation-"))).toBe(false);
    expect(service.getOperation()).toBeNull();
    expect((await service.getState()).projectData?.history.at(-1)?.status).toBe("cancelled");
    expect(request.mock.calls.filter(([command]) => command.type === "analyze")).toHaveLength(1);
  });

  it("rolls back a completed native mutation when staged statistics cannot be verified", async () => {
    const state = await service.getState();
    const database = join(root, "beagle", state.selectedProjectId, "graph.db");
    await writeFile(database, "committed bytes");
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command, options) => {
      if (command.type === "analyze") { await writeFile(activeClient().database!, "unverified changes"); return { complete: true }; }
      if (command.type === "stats" && activeClient().database !== database) return { nodes: -1 };
      return fallback(command, options);
    });
    await expect(service.analyze()).rejects.toThrow("Invalid Beagle count");
    expect(await readFile(database, "utf8")).toBe("committed bytes");
    expect((await service.getState()).projectData?.history.at(-1)?.status).toBe("failed");
  });

  it("rechecks selected collection hashes before publishing an import", async () => {
    const state = await service.getState();
    const database = join(root, "beagle", state.selectedProjectId, "graph.db"), path = join(root, "collection.json");
    await writeFile(database, "committed bytes"); await writeFile(path, "original selected file");
    const fallback = request.getMockImplementation()!;
    request.mockImplementation(async (command, options) => {
      if (command.type === "ingest") { await writeFile(path, "changed while importing"); await writeFile(activeClient().database!, "stage"); return { complete: true }; }
      return fallback(command, options);
    });
    await expect(service.importFiles([path])).rejects.toThrow(/changed/u);
    expect(await readFile(database, "utf8")).toBe("committed bytes");
    expect((await service.getState()).projectData?.history.at(-1)?.status).toBe("failed");
  });

  it("keeps legacy helper reads available and rejects unsupported staged mutations before sending them", async () => {
    createRuntime.mockImplementation(() => makeClient(Promise.resolve({ ...ready, operations: BEAGLE_RUNTIME_REQUIRED_OPERATIONS })));
    expect((await service.query({ cypher: "RETURN 1" })).rows).toHaveLength(1);
    await expect(service.analyze()).rejects.toThrow("does not support backup");
    expect(request.mock.calls.some(([command]) => command.type === "backup" || command.type === "analyze")).toBe(false);
    expect((await service.query({ cypher: "RETURN 2" })).rows).toHaveLength(1);
    expect((await service.getState()).runtime.operations).toEqual(BEAGLE_RUNTIME_REQUIRED_OPERATIONS);
  });

  it("rejects malformed runtime values, propagates operation errors and applies per-operation deadlines", async () => {
    await service.getState();
    request.mockResolvedValueOnce({ invalid: undefined } as unknown as BeagleJsonValue);
    await expect(service.query({ cypher: "RETURN 1" })).rejects.toThrow("Invalid Beagle JSON");
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ timeout: 40_000 });
    request.mockRejectedValueOnce(new Error("unsupported syntax"));
    await expect(service.query({ cypher: "RETURN unsupported()" })).rejects.toThrow("unsupported syntax");
    await service.analyze();
    expect(request.mock.calls.find(([command]) => command.type === "analyze")?.[1].timeout).toBe(300_000);
  });

  it("does not replace corrupt project configuration with an empty database", async () => {
    await service.getState();
    await writeFile(join(root, "beagle", "projects.json"), '{"version":0}');
    await expect(newService().getState()).rejects.toThrow("project configuration");
    expect(await readFile(join(root, "beagle", "projects.json"), "utf8")).toBe('{"version":0}');
  });

  it("aborts the active request, awaits child termination and rejects pending work on disposal", async () => {
    await service.getState();
    request.mockImplementation(async (_command, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const running = service.query({ cypher: "RETURN 1" }).catch((error: unknown) => error);
    const pending = service.getState().catch((error: unknown) => error);
    await vi.waitFor(() => expect(request.mock.calls.at(-1)?.[0].type).toBe("query"));
    await service.dispose();
    expect(await running).toEqual(new Error("Beagle service is closed"));
    expect(await pending).toEqual(new Error("Beagle service is closed"));
    expect(activeClient().stop).toHaveBeenCalled();
    expect(clients.every((client) => client.closed)).toBe(true);
  });
});
