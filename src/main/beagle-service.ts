import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  BEAGLE_PROJECT_ID, BEAGLE_RESULT_LIMITS, BEAGLE_SEARCH_PAGE_SIZE, BEAGLE_NEIGHBORHOOD_PAGE_SIZE, parseBeagleComposeInput, parseBeagleCreateProjectInput,
  parseBeagleEntityInput, parseBeagleJson, parseBeagleNeighborhoodInput, parseBeaglePathsInput, parseBeagleQueryInput,
  parseBeagleSavedQueryInput, parseBeagleSearchInput, parseBeagleSelectProjectInput, parseBeagleTagInput,
  type BeagleComposeInput, type BeagleCreateProjectInput, type BeagleEdge, type BeagleEntityInput,
  type BeagleGraph, type BeagleJsonObject, type BeagleJsonValue, type BeagleMutationResult,
  type BeagleNode, type BeagleNeighborhoodInput, type BeagleNeighborhoodResult, type BeaglePathsInput, type BeagleProject, type BeagleQueryInput,
  type BeagleQueryResult, type BeagleSavedQuery, type BeagleSavedQueryInput, type BeagleSearchInput, type BeagleSearchResult,
  type BeagleSelectProjectInput, type BeagleState, type BeagleStats, type BeagleTagInput,
} from "../shared/beagle-contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";
import { buildBeagleNeighborhoodQuery, isBeagleTraversalInvestigation, runBeagleTraversalInvestigation } from "./beagle-investigations.js";
import { normalizeBeagleAnalysisDiagnostics, parseBeagleAnalysisDiagnostics } from "./beagle-analysis-diagnostics.js";
import { BEAGLE_PATH_EDGE_KINDS } from "../shared/beagle-investigations.js";
import type { BeagleRuntimeCommand } from "../shared/beagle-runtime-contracts.js";
import { createBeagleRuntime, type BeagleRuntimeClient } from "./beagle-runtime.js";
import { beagleExecutableVerifier, beagleRuntimeEnvironment, type BeagleExecutableIdentity, type BeagleExecutableVerifier } from "./beagle-runtime-loader.js";

const QUERY_TIMEOUT_MS = 40_000;
const WORKFLOW_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_PROJECTS = 100;
interface ProjectConfiguration {
  version: 2;
  binaryPath: string | null;
  binarySha256: string | null;
  selectedProjectId: string;
  projects: BeagleProject[];
}
export interface BeagleServiceOptions {
  userDataPath: string;
  environment?: NodeJS.ProcessEnv;
  createRuntime?: typeof createBeagleRuntime;
  verifier?: BeagleExecutableVerifier;
}

/** One serialized owner for every project's database, including reads and project switches. */
export class BeagleService {
  private readonly rootPath: string;
  private readonly configurationPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly createRuntime: typeof createBeagleRuntime;
  private readonly verifier: BeagleExecutableVerifier;
  private configuration: ProjectConfiguration | null = null;
  private catalog: BeagleSavedQuery[] | null = null;
  private binary: BeagleExecutableIdentity | null = null;
  private client: BeagleRuntimeClient | undefined;
  private clientDatabase: string | undefined;
  private readonly clients = new Set<BeagleRuntimeClient>();
  private runtime: BeagleState["runtime"] = { available: false, version: null, source: null };
  private pending: Promise<unknown> = Promise.resolve();
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(options: BeagleServiceOptions) {
    if (!isAbsolute(options.userDataPath)) throw new TypeError("Beagle user data path must be absolute");
    this.rootPath = join(options.userDataPath, "beagle");
    this.configurationPath = join(this.rootPath, "projects.json");
    this.environment = { ...process.env, ...options.environment };
    this.createRuntime = options.createRuntime ?? createBeagleRuntime;
    this.verifier = options.verifier ?? beagleExecutableVerifier;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    await Promise.all([...this.clients].map((client) => client.stop()));
    this.clients.clear();
  }

  getState(): Promise<BeagleState> { return this.serial(() => this.state()); }

  createProject(value: BeagleCreateProjectInput): Promise<BeagleState> {
    const input = parseBeagleCreateProjectInput(value);
    return this.serial(async () => {
      const configuration = await this.load();
      if (configuration.projects.length >= MAX_PROJECTS) throw new Error("The Beagle project limit has been reached");
      if (configuration.projects.some((project) => project.name.toLowerCase() === input.name.toLowerCase())) {
        throw new Error("A Beagle project with this name already exists");
      }
      const project: BeagleProject = { id: randomUUID(), name: input.name, createdAt: new Date().toISOString() };
      await this.save({ ...configuration, projects: [...configuration.projects, project], selectedProjectId: project.id });
      return this.state();
    });
  }

  selectProject(value: BeagleSelectProjectInput): Promise<BeagleState> {
    const input = parseBeagleSelectProjectInput(value);
    return this.serial(async () => {
      const configuration = await this.load();
      if (!configuration.projects.some((project) => project.id === input.id)) throw new Error("Unknown Beagle project");
      await this.save({ ...configuration, selectedProjectId: input.id });
      return this.state();
    });
  }

  /** This path must come from a main-process native executable picker. */
  configureBinary(path: string): Promise<BeagleState> {
    validateAbsolutePath(path);
    return this.serial(async () => {
      const configuration = await this.load();
      // A native file selection grants initial trust. Record the bytes before
      // executing, then verify that pin again before every helper launch.
      const identity = await this.verifier.capture(path);
      const version = await this.inspectBinary(identity);
      await this.closeClient();
      await this.save({ ...configuration, binaryPath: identity.path, binarySha256: identity.sha256 });
      this.binary = identity;
      this.catalog = null;
      this.runtime = { available: true, version, source: "Selected executable" };
      return this.state();
    });
  }

  /** File paths are selected by a native dialog and are never accepted over renderer IPC. */
  importFiles(paths: readonly string[]): Promise<BeagleMutationResult> {
    if (paths.length === 0 || paths.length > 100) throw new TypeError("Select between 1 and 100 collection files");
    paths.forEach(validateAbsolutePath);
    return this.serial(() => this.mutate({ type: "ingest", paths: [...paths], analyze: true }));
  }

  analyze(): Promise<BeagleMutationResult> { return this.serial(() => this.mutate({ type: "analyze" })); }

  query(value: BeagleQueryInput): Promise<BeagleQueryResult> {
    const input = parseBeagleQueryInput(value);
    assertBeagleGraphQuery(input.cypher);
    return this.serial(() => this.queryCommand({ type: "query", cypher: input.cypher, parameters: input.parameters ?? {} }));
  }

  runSavedQuery(value: BeagleSavedQueryInput): Promise<BeagleQueryResult> {
    const input = parseBeagleSavedQueryInput(value);
    return this.serial(async () => {
      // Validate the current runtime's authoritative source on every execution, including
      // when the UI has not loaded the catalog. Parameter values remain bound JSON data.
      const query = object(await this.execute({ type: "savedQueryInfo", id: input.id }, VERSION_TIMEOUT_MS), "saved query metadata");
      assertBeagleGraphQuery(requiredString(query["parameterized_query"], "parameterized saved query source"));
      return this.queryCommand({ type: "savedQuery", id: input.id, parameters: input.parameters ?? {} });
    });
  }

  getQueries(): Promise<BeagleSavedQuery[]> {
    return this.serial(async () => {
      if (this.catalog) return structuredClone(this.catalog);
      const value = await this.execute({ type: "catalog" });
      if (!Array.isArray(value) || value.length > 1_000) throw new Error("Invalid Beagle saved query catalog");
      const catalog: BeagleSavedQuery[] = [];
      for (const entry of value) {
        // The helper returns authoritative bound-template metadata in one reply.
        const query = object(entry, "saved query metadata");
        const id = requiredString(query["guid"], "saved query ID");
        const cypher = requiredString(query["parameterized_query"], "parameterized saved query source");
        const parameters = object(query["parameters"], "saved query parameter schema");
        catalog.push({
          id,
          name: requiredString(query["name"], "saved query name"),
          description: typeof query["description"] === "string" ? query["description"] : "",
          category: typeof query["category"] === "string" ? query["category"] : "Other",
          cypher,
          parameters: Object.keys(parameters),
        });
      }
      this.catalog = catalog;
      return structuredClone(catalog);
    });
  }

  search(value: BeagleSearchInput): Promise<BeagleSearchResult> {
    const input = parseBeagleSearchInput(value);
    const offset = input.offset ?? 0;
    return this.serial(async () => {
      // The pinned CLI's search command has no offset. Keep its matching semantics,
      // with an identity tie-break and one extra row to detect the next page.
      const result = await this.queryCommand({ type: "query", parameters: { term: input.term, offset, limit: BEAGLE_SEARCH_PAGE_SIZE + 1 },
        cypher: "MATCH (n) WHERE toUpper(n.name) CONTAINS toUpper($term) OR toUpper(n.objectid) CONTAINS toUpper($term) RETURN n ORDER BY n.name, n.objectid SKIP $offset LIMIT $limit" });
      const page = normalizeBeagleQueryResult({ columns: result.columns, rows: result.rows.slice(0, BEAGLE_SEARCH_PAGE_SIZE) }, result.projectId);
      return {
        ...page, elapsedMs: result.elapsedMs,
        page: { offset, limit: BEAGLE_SEARCH_PAGE_SIZE, hasMore: result.totalRows > BEAGLE_SEARCH_PAGE_SIZE },
      };
    });
  }

  entity(value: BeagleEntityInput): Promise<BeagleQueryResult> {
    const input = parseBeagleEntityInput(value);
    return this.serial(() => this.queryCommand({ type: "entity", objectid: input.objectid }));
  }

  neighborhood(value: BeagleNeighborhoodInput): Promise<BeagleNeighborhoodResult> {
    const input = parseBeagleNeighborhoodInput(value);
    const view = input.view ?? "relationships";
    const offset = input.offset ?? 0;
    return this.serial(async () => {
      const startedAt = performance.now();
      if (isBeagleTraversalInvestigation(view)) {
        let projectId = "";
        const result = await runBeagleTraversalInvestigation(view, input.objectid, offset, BEAGLE_NEIGHBORHOOD_PAGE_SIZE, async (cypher, parameters) => {
          const batch = await this.queryCommand({ type: "query", parameters, cypher });
          projectId = batch.projectId;
          if (batch.truncated) throw new Error("Beagle traversal page was truncated; no partial result was returned");
          return batch.rows;
        });
        const page = normalizeBeagleQueryResult({ columns: ["target", "nodes", "edges"], rows: result.rows }, projectId);
        return { ...page, elapsedMs: Math.round(performance.now() - startedAt), objectid: input.objectid, view,
          page: { offset, limit: BEAGLE_NEIGHBORHOOD_PAGE_SIZE, total: result.total, hasMore: result.hasMore } };
      }
      const { countCypher, pageCypher } = buildBeagleNeighborhoodQuery(view);
      const count = await this.queryCommand({ type: "query", parameters: { objectid: input.objectid }, cypher: countCypher });
      const total = count.rows[0]?.["total"];
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new Error("Invalid relationship count returned by Beagle");
      const result = await this.queryCommand({ type: "query", parameters: { objectid: input.objectid, offset, limit: BEAGLE_NEIGHBORHOOD_PAGE_SIZE + 1 }, cypher: pageCypher });
      const page = normalizeBeagleQueryResult({ columns: result.columns, rows: result.rows.slice(0, BEAGLE_NEIGHBORHOOD_PAGE_SIZE) }, result.projectId);
      return {
        ...page, elapsedMs: Math.round(performance.now() - startedAt), objectid: input.objectid, view,
        page: { offset, limit: BEAGLE_NEIGHBORHOOD_PAGE_SIZE, total, hasMore: result.totalRows > BEAGLE_NEIGHBORHOOD_PAGE_SIZE },
      };
    });
  }

  paths(value: BeaglePathsInput): Promise<BeagleQueryResult> {
    const input = parseBeaglePathsInput(value);
    return this.serial(async () => {
      const startedAt = performance.now();
      const endpoints = [input.source, ...input.via ?? [], input.target];
      // The native AD_ATTACK_PATHS alias differs from CE's selectable set.
      // Omitted filters and all-selected filters must describe the same search.
      const kinds = (input.relationshipKinds ?? BEAGLE_PATH_EDGE_KINDS).join("|");
      const cypher = `MATCH p=${input.all ? "allShortestPaths" : "shortestPath"}((s {objectid:$source})-[:${kinds}*1..${input.maxHops ?? 12}]->(t {objectid:$target})) RETURN p`;
      const rows: BeagleJsonObject[] = [];
      let projectId = "";
      let truncated = false;
      // Each ordered leg must exist. Combine their real path evidence without a
      // Cartesian product of alternatives or a misleading partial itinerary.
      for (let index = 0; index < endpoints.length - 1; index++) {
        const leg = await this.queryCommand({ type: "query", parameters: { source: endpoints[index]!, target: endpoints[index + 1]! }, cypher });
        projectId = leg.projectId;
        if (!leg.rows.length) return { ...leg, elapsedMs: Math.round(performance.now() - startedAt) };
        rows.push(...leg.rows);
        truncated ||= leg.truncated;
      }
      const result = normalizeBeagleQueryResult({ columns: ["p"], rows }, projectId);
      return { ...result, truncated: result.truncated || truncated, elapsedMs: Math.round(performance.now() - startedAt) };
    });
  }

  tag(value: BeagleTagInput): Promise<BeagleMutationResult> {
    const input = parseBeagleTagInput(value);
    return this.serial(() => this.mutate({ type: "tag", objectid: input.objectid, tag: input.tag, enabled: input.enabled }));
  }

  compose(value: BeagleComposeInput): Promise<BeagleQueryResult> {
    const input = parseBeagleComposeInput(value);
    return this.serial(() => this.queryCommand({ type: "compose", ...input }));
  }

  /** Complete canonical snapshot for native export; graph display limits do not apply. */
  exportGraph(): Promise<BeagleGraph> {
    return this.serial(async () => normalizeBeagleSnapshot(await this.execute({ type: "export" })));
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      if (this.disposed) throw new Error("Beagle service is closed");
      return operation();
    });
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<ProjectConfiguration> {
    if (this.configuration) return this.configuration;
    await privateDirectory(this.rootPath);
    try {
      const file = await readBoundedRegularFile(this.configurationPath, { label: "Beagle projects", maxBytes: 1024 * 1024 });
      const value = object(decode(file.data.toString("utf8")), "project configuration");
      if ((value["version"] !== 1 && value["version"] !== 2) || !Array.isArray(value["projects"]) || value["projects"].length === 0 || value["projects"].length > MAX_PROJECTS) {
        throw new Error("Invalid Beagle project configuration");
      }
      const projects = value["projects"].map((entry): BeagleProject => {
        const project = object(entry, "project");
        const { id } = parseBeagleSelectProjectInput({ id: project["id"] });
        const { name } = parseBeagleCreateProjectInput({ name: project["name"] });
        const createdAt = requiredString(project["createdAt"], "project creation time");
        if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Invalid Beagle project creation time");
        return { id, name, createdAt };
      });
      const selectedProjectId = requiredString(value["selectedProjectId"], "selected project");
      if (new Set(projects.map((project) => project.id)).size !== projects.length || !projects.some((project) => project.id === selectedProjectId)) {
        throw new Error("Invalid Beagle project identities");
      }
      const binaryPath = value["binaryPath"];
      if (binaryPath !== null) validateAbsolutePath(binaryPath);
      const binarySha256 = value["version"] === 1 ? null : value["binarySha256"];
      if (binarySha256 !== null && (typeof binarySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(binarySha256))) throw new Error("Invalid Beagle executable pin");
      this.configuration = { version: 2, binaryPath, binarySha256, selectedProjectId, projects };
      return this.configuration;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const project = { id: randomUUID(), name: "Default", createdAt: new Date().toISOString() };
      const configuration: ProjectConfiguration = { version: 2, binaryPath: null, binarySha256: null, selectedProjectId: project.id, projects: [project] };
      await this.save(configuration);
      return configuration;
    }
  }

  private async save(configuration: ProjectConfiguration): Promise<void> {
    await writePrivateFileAtomic(this.configurationPath, Buffer.from(JSON.stringify(configuration, null, 2)));
    this.configuration = configuration;
  }

  private async discover(): Promise<void> {
    if (this.binary) return;
    const configuration = await this.load();
    const path = configuration.binaryPath ?? this.environment["SLIVER_BEAGLE_BINARY"];
    const sha256 = configuration.binaryPath ? configuration.binarySha256 : this.environment["SLIVER_BEAGLE_SHA256"];
    if (!path || !sha256) {
      this.runtime = { available: false, version: null, source: null,
        error: "Beagle requires a verified executable. Choose a Beagle executable to pin it, or configure SLIVER_BEAGLE_BINARY and SLIVER_BEAGLE_SHA256." };
      return;
    }
    try {
      const identity = await this.verifier.verify(path, sha256);
      const version = await this.inspectBinary(identity);
      if (this.disposed) throw new Error("Beagle service is closed");
      this.binary = identity;
      this.runtime = { available: true, version, source: configuration.binaryPath ? "Selected executable" : "SLIVER_BEAGLE_BINARY" };
    } catch (error) {
      const compatibility = error instanceof Error && /^(Unsupported|Incompatible) Beagle runtime/u.test(error.message) ? error.message : undefined;
      this.runtime = { available: false, version: null, source: null,
        error: compatibility ?? "Beagle executable verification or startup failed. Choose a Beagle executable to verify it again." };
    }
  }

  private async inspectBinary(identity: BeagleExecutableIdentity): Promise<string> {
    const client = await this.startClient(identity);
    try {
      const ready = await client.ready;
      // Probe an ephemeral database before any operator project is opened.
      await this.request(client, { type: "open", database: ":memory:", queryTimeoutMs: 3_000 }, VERSION_TIMEOUT_MS);
      const probe = object(await this.request(client, { type: "stats" }, VERSION_TIMEOUT_MS), "runtime capabilities");
      const capabilities = object(probe["capabilities"], "runtime capabilities");
      const features = object(capabilities["features"], "runtime query features");
      if (capabilities["schema_version"] !== 1 || ["parameters", "shortest_path", "variable_length_paths", "named_paths", "optional_match", "with_where", "call_subquery", "union", "existential_subquery_full", "list_comprehension", "quantifiers"]
        .some((feature) => features[feature] !== true)) {
        throw new Error("Incompatible Beagle runtime: required graph query capabilities are unavailable. Choose a current Beagle 0.1.x executable.");
      }
      return `beagle ${ready.version}`;
    } finally {
      await client.stop(); this.clients.delete(client);
    }
  }

  private async startClient(identity: BeagleExecutableIdentity): Promise<BeagleRuntimeClient> {
    if (this.disposed) throw new Error("Beagle service is closed");
    const verified = await this.verifier.verify(identity.path, identity.sha256);
    if (this.disposed) throw new Error("Beagle service is closed");
    const client = this.createRuntime(verified.path, { cwd: this.rootPath, env: beagleRuntimeEnvironment(this.environment) });
    this.clients.add(client);
    try { await client.ready; return client; }
    catch (error) { await client.stop(); this.clients.delete(client); throw error; }
  }

  private async closeClient(): Promise<void> {
    const client = this.client;
    this.client = undefined; this.clientDatabase = undefined;
    if (client) { await client.stop(); this.clients.delete(client); }
  }

  private async request(client: BeagleRuntimeClient, command: BeagleRuntimeCommand, timeout: number): Promise<BeagleJsonValue> {
    if (this.disposed) throw new Error("Beagle service is closed");
    const controller = new AbortController();
    this.controller = controller;
    try {
      return parseBeagleJson(await client.request(command, { timeout, signal: controller.signal }), 2_000_000);
    } finally { this.controller = null; }
  }

  private async database(): Promise<string> {
    const { selectedProjectId } = await this.load();
    if (!BEAGLE_PROJECT_ID.test(selectedProjectId)) throw new Error("Invalid Beagle project identity");
    const directory = join(this.rootPath, selectedProjectId);
    await privateDirectory(directory);
    const path = join(directory, "graph.db");
    try { const file = await open(path, "wx", 0o600); await file.close(); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Beagle database must be a regular file");
    if (process.platform !== "win32") await chmod(path, 0o600);
    return path;
  }

  private async execute(command: BeagleRuntimeCommand, timeout = QUERY_TIMEOUT_MS): Promise<BeagleJsonValue> {
    await this.discover();
    if (!this.binary) throw new Error(this.runtime.error ?? "Beagle runtime is unavailable");
    const path = await this.database();
    if (this.client?.closed || this.clientDatabase !== path) await this.closeClient();
    if (!this.client) {
      const client = await this.startClient(this.binary);
      try { await this.request(client, { type: "open", database: path, queryTimeoutMs: 30_000 }, VERSION_TIMEOUT_MS); }
      catch (error) { await client.stop(); this.clients.delete(client); throw error; }
      this.client = client; this.clientDatabase = path;
    }
    // A failed mutation is never replayed. A later explicit request can start a
    // fresh verified helper if the previous process exited or was terminated.
    try { return await this.request(this.client, command, timeout); }
    finally { if (this.client?.closed) await this.closeClient(); }
  }

  private async state(): Promise<BeagleState> {
    const configuration = await this.load();
    await this.discover();
    const stats = this.binary ? normalizeStats(await this.execute({ type: "stats" })) : null;
    let diagnostics: BeagleState["diagnostics"];
    try {
      const file = await readBoundedRegularFile(join(this.rootPath, configuration.selectedProjectId, "analysis-diagnostics.json"), { label: "Analysis diagnostics", maxBytes: 1024 * 1024 });
      diagnostics = parseBeagleAnalysisDiagnostics(JSON.parse(file.data.toString("utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics = { version: 1, localGroupAmbiguities: [], errors: ["Saved analysis diagnostics could not be read. Analyze this project again to check ambiguous privileges."] };
    }
    return { runtime: { ...this.runtime }, projects: configuration.projects.map((project) => ({ ...project })), selectedProjectId: configuration.selectedProjectId, stats,
      ...(diagnostics === undefined ? {} : { diagnostics }) };
  }

  private async mutate(command: BeagleRuntimeCommand): Promise<BeagleMutationResult> {
    const recordsAnalysis = command.type === "ingest" || command.type === "analyze";
    const configuration = await this.load();
    const diagnosticsPath = join(this.rootPath, configuration.selectedProjectId, "analysis-diagnostics.json");
    if (recordsAnalysis) {
      await this.database();
      // A child can commit before its output is lost or rejected. Never retain an
      // older clean report when completion of the latest analysis is uncertain.
      await writePrivateFileAtomic(diagnosticsPath, Buffer.from(JSON.stringify({ version: 1, localGroupAmbiguities: [],
        errors: ["The latest analysis has not completed with verified diagnostics. Run Analyze again before relying on local-group privilege choices."] })));
    }
    const report = await this.execute(command, WORKFLOW_TIMEOUT_MS);
    if (recordsAnalysis) {
      const diagnostics = normalizeBeagleAnalysisDiagnostics(report);
      await writePrivateFileAtomic(diagnosticsPath, Buffer.from(JSON.stringify(diagnostics)));
    }
    return { report, state: await this.state() };
  }

  private async queryCommand(command: BeagleRuntimeCommand): Promise<BeagleQueryResult> {
    const configuration = await this.load();
    const startedAt = performance.now();
    const value = await this.execute(command);
    const result = normalizeBeagleQueryResult(value, configuration.selectedProjectId);
    const missing = collectGraph(result.rows).missingNodeIds.slice(0, BEAGLE_RESULT_LIMITS.nodes);
    if (missing.length > 0) {
      // Relationship-only results use engine-local IDs. Resolve them inside this same serialized
      // project operation, so graph identities always remain BloodHound object IDs.
      const nodes = await this.execute({ type: "query", parameters: { ids: missing }, cypher: "MATCH (n) WHERE id(n) IN $ids RETURN n" });
      const hydrated = collectGraph([result.rows, nodes]);
      const limited = limitGraph(hydrated.graph);
      result.graph = limited.graph;
      result.truncated ||= limited.truncated || hydrated.missingNodeIds.length > 0;
    }
    result.elapsedMs = Math.round(performance.now() - startedAt);
    return result;
  }
}

interface CypherBoundaryToken { value: string; kind: "word" | "quoted" | "symbol" }
const UNSAFE_CYPHER_FUNCTIONS = new Set([
  "load_csv", "readfile", "writefile", "load_extension", "cypher", "cypher_result", "cypher_rows",
]);
const UNSAFE_CYPHER_NAMESPACES = ["apoc.load.", "apoc.import.", "apoc.export.", "apoc.cypher.", "apoc.do.", "apoc.periodic."];

/**
 * The supported Beagle engine's SQL authorizer prevents graph writes, but LOAD CSV reads
 * files before SQL authorization and apoc.periodic.iterate evaluates Cypher from strings.
 * Keep those capabilities outside this renderer bridge. This lexer follows the vendored
 * scanner's string, backtick and nonnested comment rules; strings are never reinterpreted
 * as query text. SQL-style doubled quotes are two adjacent literals in that scanner.
 */
export function assertBeagleGraphQuery(source: string): void {
  const tokens: CypherBoundaryToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const character = source[offset]!;
    const next = source[offset + 1];
    if (/\s/u.test(character)) { offset++; continue; }
    if (character === "/" && next === "/") {
      offset += 2;
      while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") offset++;
      continue;
    }
    if (character === "/" && next === "*") {
      const end = source.indexOf("*/", offset + 2);
      if (end < 0) throw new Error("Unterminated Cypher comment");
      offset = end + 2;
      continue;
    }
    if (character === "'" || character === '"') {
      const quote = character;
      offset++;
      let terminated = false;
      while (offset < source.length) {
        const current = source[offset++]!;
        if (current === "\\") { offset++; continue; }
        if (current === quote) { terminated = true; break; }
      }
      if (!terminated) throw new Error("Unterminated Cypher string");
      tokens.push({ value: "literal", kind: "symbol" });
      continue;
    }
    if (character === "`") {
      offset++;
      let value = "";
      let terminated = false;
      while (offset < source.length) {
        const current = source[offset++]!;
        if (current !== "`") value += current;
        else if (source[offset] === "`") { value += "`"; offset++; }
        else { terminated = true; break; }
      }
      if (!terminated) throw new Error("Unterminated Cypher identifier");
      tokens.push({ value: value.toLowerCase(), kind: "quoted" });
      continue;
    }
    if (/[A-Za-z_]/u.test(character)) {
      const start = offset++;
      while (offset < source.length && /[A-Za-z0-9_]/u.test(source[offset]!)) offset++;
      tokens.push({ value: source.slice(start, offset).toLowerCase(), kind: "word" });
      continue;
    }
    tokens.push({ value: character, kind: "symbol" });
    offset++;
  }
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.kind === "word" && token.value === "load" && tokens[index + 1]?.kind === "word" && tokens[index + 1]?.value === "csv") {
      throw new Error("File access through LOAD CSV is unavailable in AD Explorer. Use Import collection to choose files.");
    }
    if (token.kind === "symbol") continue;
    let name = token.value;
    let end = index + 1;
    while (tokens[end]?.value === "." && tokens[end + 1] && tokens[end + 1]!.kind !== "symbol") {
      name += `.${tokens[end + 1]!.value}`;
      end += 2;
    }
    if (tokens[end]?.value === "(" && (UNSAFE_CYPHER_FUNCTIONS.has(name) || UNSAFE_CYPHER_NAMESPACES.some((prefix) => name.startsWith(prefix)))) {
      throw new Error("File access and dynamic Cypher execution are unavailable in AD Explorer queries.");
    }
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Beagle data directory must be a regular directory");
  if (process.platform !== "win32") await chmod(path, 0o700);
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isNotFound(error: unknown): boolean { return hasCode(error, "ENOENT"); }
function validateAbsolutePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096 || /[\x00\r\n]/u.test(path)) {
    throw new TypeError("Beagle native file selection must be an absolute path");
  }
}
function decode(source: string): BeagleJsonValue {
  try { return parseBeagleJson(JSON.parse(source) as unknown, 2_000_000); }
  catch { throw new Error("Beagle returned invalid or oversized JSON"); }
}
function isObject(value: BeagleJsonValue | undefined): value is BeagleJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: BeagleJsonValue | undefined, label: string): BeagleJsonObject {
  if (!isObject(value)) throw new Error(`Invalid Beagle ${label}`);
  return value;
}
function requiredString(value: BeagleJsonValue | undefined, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`Invalid Beagle ${label}`);
  return value;
}
function normalizeStats(value: BeagleJsonValue): BeagleStats {
  const stats = object(value, "statistics");
  const count = (value: BeagleJsonValue | undefined): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Beagle count");
    return value;
  };
  const counts = (value: BeagleJsonValue | undefined): Record<string, number> => Object.fromEntries(
    Object.entries(object(value, "statistics counts")).map(([name, value]) => [name, count(value)]),
  );
  return { nodes: count(stats["nodes"]), edges: count(stats["edges"]), labels: counts(stats["labels"]), relationships: counts(stats["relationships"]) };
}

interface CollectedGraph { graph: BeagleGraph; missingNodeIds: number[] }
function collectGraph(value: BeagleJsonValue): CollectedGraph {
  const nodes = new Map<string, BeagleNode>();
  const identities = new Map<number, string>();
  const relationships: BeagleJsonObject[] = [];
  function visit(value: BeagleJsonValue): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!isObject(value)) return;
    const properties = value["properties"];
    const objectid = value["objectid"] ?? (isObject(properties) ? properties["objectid"] : undefined);
    const labels = value["labels"];
    if (typeof objectid === "string" && Array.isArray(labels) && labels.every((label) => typeof label === "string") && isObject(properties)) {
      nodes.set(objectid, { objectid, labels: labels as string[], properties: { ...properties } });
      const id = value["id"];
      if (typeof id === "number" && Number.isSafeInteger(id)) identities.set(id, objectid);
      return;
    }
    if ((typeof value["kind"] === "string" && typeof value["source"] === "string" && typeof value["target"] === "string") ||
        (typeof value["type"] === "string" && typeof value["startNode"] === "number" && typeof value["endNode"] === "number")) {
      relationships.push(value);
      return;
    }
    Object.values(value).forEach(visit);
  }
  visit(value);
  const missing = new Set<number>();
  const edges = new Map<string, BeagleEdge>();
  for (const relationship of relationships) {
    const start = relationship["startNode"];
    const end = relationship["endNode"];
    const source = typeof relationship["source"] === "string" ? relationship["source"] : typeof start === "number" ? identities.get(start) : undefined;
    const target = typeof relationship["target"] === "string" ? relationship["target"] : typeof end === "number" ? identities.get(end) : undefined;
    if (source === undefined && typeof start === "number") missing.add(start);
    if (target === undefined && typeof end === "number") missing.add(end);
    if (source === undefined || target === undefined) continue;
    const kind = requiredString(relationship["kind"] ?? relationship["type"], "relationship kind");
    const id = JSON.stringify([source, kind, target]);
    edges.set(id, { id, source, target, kind, properties: isObject(relationship["properties"]) ? { ...relationship["properties"] } : {}, derived: typeof relationship["derived"] === "boolean" ? relationship["derived"] : null });
  }
  return { graph: { nodes: [...nodes.values()], edges: [...edges.values()] }, missingNodeIds: [...missing] };
}

function limitGraph(graph: BeagleGraph): { graph: BeagleGraph; truncated: boolean } {
  const nodes = graph.nodes.slice(0, BEAGLE_RESULT_LIMITS.nodes);
  const identities = new Set(nodes.map((node) => node.objectid));
  const edges = graph.edges.filter((edge) => identities.has(edge.source) && identities.has(edge.target)).slice(0, BEAGLE_RESULT_LIMITS.edges);
  return { graph: { nodes, edges }, truncated: nodes.length !== graph.nodes.length || edges.length !== graph.edges.length };
}

export function normalizeBeagleSnapshot(value: BeagleJsonValue): BeagleGraph {
  const snapshot = object(value, "graph snapshot");
  if (!Array.isArray(snapshot["nodes"]) || !Array.isArray(snapshot["edges"])) throw new Error("Invalid Beagle graph snapshot");
  const { graph, missingNodeIds } = collectGraph(snapshot);
  if (missingNodeIds.length || graph.nodes.length !== snapshot["nodes"].length || graph.edges.length !== snapshot["edges"].length) {
    throw new Error("Invalid or duplicate Beagle graph identities");
  }
  const identities = new Set(graph.nodes.map((node) => node.objectid));
  if (graph.edges.some((edge) => !identities.has(edge.source) || !identities.has(edge.target))) throw new Error("Beagle graph contains missing endpoints");
  // Canonical snapshots define omitted provenance as false; Cypher values do not.
  graph.edges = graph.edges.map((edge) => ({ ...edge, derived: edge.derived ?? false }));
  return graph;
}

/** Converts nodes, relationships, paths, nested collections and scalar-only results without guessing IDs. */
export function normalizeBeagleQueryResult(value: BeagleJsonValue, projectId: string): BeagleQueryResult {
  const envelope = object(value, "query result");
  if (Array.isArray(envelope["nodes"]) && Array.isArray(envelope["edges"])) {
    const graph = normalizeBeagleSnapshot(envelope);
    const limited = limitGraph(graph);
    return { projectId, columns: [], rows: [], graph: limited.graph, totalRows: 0, elapsedMs: 0, truncated: limited.truncated, limits: { ...BEAGLE_RESULT_LIMITS } };
  }
  const columns = envelope["columns"];
  const values = envelope["rows"];
  if (!Array.isArray(columns) || !columns.every((column) => typeof column === "string") || !Array.isArray(values)) throw new Error("Invalid Beagle query envelope");
  const rows = values.slice(0, BEAGLE_RESULT_LIMITS.rows).map((row) => object(row, "result row"));
  const collected = collectGraph(rows);
  const limited = limitGraph(collected.graph);
  return {
    projectId, columns: columns as string[], rows, graph: limited.graph, elapsedMs: 0, totalRows: values.length,
    truncated: values.length > rows.length || limited.truncated, limits: { ...BEAGLE_RESULT_LIMITS },
  };
}
