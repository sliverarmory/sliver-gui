import { execFile } from "node:child_process";
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

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 40_000;
const WORKFLOW_TIMEOUT_MS = 5 * 60_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_PROJECTS = 100;
interface ProjectConfiguration {
  version: 1;
  binaryPath: string | null;
  selectedProjectId: string;
  projects: BeagleProject[];
}
export interface BeagleCommandOptions {
  timeout: number;
  maxBuffer: number;
  signal: AbortSignal;
  cwd: string;
  env: NodeJS.ProcessEnv;
}
export type BeagleCommandRunner = (
  binary: string, args: readonly string[], options: BeagleCommandOptions,
) => Promise<{ stdout: string; stderr: string }>;
export interface BeagleServiceOptions {
  userDataPath: string;
  resourcesPath?: string;
  environment?: NodeJS.ProcessEnv;
  runner?: BeagleCommandRunner;
}

/** Arguments remain distinct OS arguments. Neither Cypher nor file names are interpreted by a shell. */
const runCommand: BeagleCommandRunner = (binary, args, options) => new Promise((resolve, reject) => {
  execFile(binary, [...args], {
    ...options, encoding: "utf8", windowsHide: true, shell: false, killSignal: "SIGKILL",
  }, (error, stdout, stderr) => {
    if (error) {
      let reason = stderr.trim();
      try {
        const diagnostic: unknown = JSON.parse(reason);
        if (typeof diagnostic === "object" && diagnostic !== null && "error" in diagnostic && typeof diagnostic.error === "string") {
          reason = diagnostic.error;
        }
      } catch { /* stderr may contain native process diagnostics. */ }
      if (error.killed) reason = `Beagle exceeded its ${Math.round(options.timeout / 1_000)} second deadline`;
      if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") reason = "Beagle output exceeds the 32 MiB limit; narrow the query";
      reject(new Error((reason || error.message).slice(0, 4_096)));
    } else resolve({ stdout, stderr });
  });
});

/** One serialized owner for every project's database, including reads and project switches. */
export class BeagleService {
  private readonly options: BeagleServiceOptions;
  private readonly rootPath: string;
  private readonly configurationPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runner: BeagleCommandRunner;
  private configuration: ProjectConfiguration | null = null;
  private catalog: BeagleSavedQuery[] | null = null;
  private binary: string | null = null;
  private runtime: BeagleState["runtime"] = { available: false, version: null, source: null };
  private pending: Promise<unknown> = Promise.resolve();
  private controller: AbortController | null = null;
  private disposed = false;

  constructor(options: BeagleServiceOptions) {
    if (!isAbsolute(options.userDataPath)) throw new TypeError("Beagle user data path must be absolute");
    this.options = options;
    this.rootPath = join(options.userDataPath, "beagle");
    this.configurationPath = join(this.rootPath, "projects.json");
    this.environment = { ...process.env, ...options.environment };
    this.runner = options.runner ?? runCommand;
  }

  dispose(): void {
    this.disposed = true;
    this.controller?.abort();
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
      const version = await this.inspectBinary(path);
      await this.save({ ...configuration, binaryPath: path });
      this.binary = path;
      this.catalog = null;
      this.runtime = { available: true, version, source: "Selected executable" };
      return this.state();
    });
  }

  /** File paths are selected by a native dialog and are never accepted over renderer IPC. */
  importFiles(paths: readonly string[]): Promise<BeagleMutationResult> {
    if (paths.length === 0 || paths.length > 100) throw new TypeError("Select between 1 and 100 collection files");
    paths.forEach(validateAbsolutePath);
    return this.serial(() => this.mutate(["ingest", "--analyze", "--", ...paths]));
  }

  analyze(): Promise<BeagleMutationResult> { return this.serial(() => this.mutate(["analyze"])); }

  query(value: BeagleQueryInput): Promise<BeagleQueryResult> {
    const input = parseBeagleQueryInput(value);
    assertBeagleGraphQuery(input.cypher);
    return this.serial(() => this.queryCommand(["query", "--params", JSON.stringify(input.parameters ?? {}), "--", input.cypher]));
  }

  runSavedQuery(value: BeagleSavedQueryInput): Promise<BeagleQueryResult> {
    const input = parseBeagleSavedQueryInput(value);
    return this.serial(async () => {
      // Validate the current runtime's authoritative source on every execution, including
      // when the UI has not loaded the catalog. Parameter values remain bound JSON data.
      const query = object(await this.execute(["queries", "--", input.id], VERSION_TIMEOUT_MS), "saved query metadata");
      assertBeagleGraphQuery(requiredString(query["parameterized_query"], "parameterized saved query source"));
      return this.queryCommand(["query", `--saved=${input.id}`, "--params", JSON.stringify(input.parameters ?? {})]);
    });
  }

  getQueries(): Promise<BeagleSavedQuery[]> {
    return this.serial(async () => {
      if (this.catalog) return structuredClone(this.catalog);
      const startedAt = performance.now();
      const value = await this.execute(["queries"]);
      if (!Array.isArray(value) || value.length > 1_000) throw new Error("Invalid Beagle saved query catalog");
      const catalog: BeagleSavedQuery[] = [];
      for (const entry of value) {
        const id = requiredString(object(entry, "saved query")["guid"], "saved query ID");
        const remaining = QUERY_TIMEOUT_MS - (performance.now() - startedAt);
        if (remaining <= 0) throw new Error("Beagle saved query catalog exceeded its deadline");
        // The raw catalog contains literal templates. Only this backend endpoint supplies
        // authoritative parameter names and the Cypher actually used by query --saved.
        const query = object(await this.execute(["queries", "--", id], Math.max(1, Math.floor(Math.min(VERSION_TIMEOUT_MS, remaining)))), "saved query metadata");
        if (query["guid"] !== id) throw new Error("Beagle saved query metadata identity mismatch");
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
      const result = await this.queryCommand([
        "query", "--params", JSON.stringify({ term: input.term, offset, limit: BEAGLE_SEARCH_PAGE_SIZE + 1 }), "--",
        "MATCH (n) WHERE toUpper(n.name) CONTAINS toUpper($term) OR toUpper(n.objectid) CONTAINS toUpper($term) RETURN n ORDER BY n.name, n.objectid SKIP $offset LIMIT $limit",
      ]);
      const page = normalizeBeagleQueryResult({ columns: result.columns, rows: result.rows.slice(0, BEAGLE_SEARCH_PAGE_SIZE) }, result.projectId);
      return {
        ...page, elapsedMs: result.elapsedMs,
        page: { offset, limit: BEAGLE_SEARCH_PAGE_SIZE, hasMore: result.totalRows > BEAGLE_SEARCH_PAGE_SIZE },
      };
    });
  }

  entity(value: BeagleEntityInput): Promise<BeagleQueryResult> {
    const input = parseBeagleEntityInput(value);
    return this.serial(() => this.queryCommand(["entity", "--", input.objectid]));
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
          const batch = await this.queryCommand(["query", "--params", JSON.stringify(parameters), "--", cypher]);
          projectId = batch.projectId;
          if (batch.truncated) throw new Error("Beagle traversal page was truncated; no partial result was returned");
          return batch.rows;
        });
        const page = normalizeBeagleQueryResult({ columns: ["target", "nodes", "edges"], rows: result.rows }, projectId);
        return { ...page, elapsedMs: Math.round(performance.now() - startedAt), objectid: input.objectid, view,
          page: { offset, limit: BEAGLE_NEIGHBORHOOD_PAGE_SIZE, total: result.total, hasMore: result.hasMore } };
      }
      const { countCypher, pageCypher } = buildBeagleNeighborhoodQuery(view);
      const count = await this.queryCommand(["query", "--params", JSON.stringify({ objectid: input.objectid }), "--", countCypher]);
      const total = count.rows[0]?.["total"];
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) throw new Error("Invalid relationship count returned by Beagle");
      const result = await this.queryCommand(["query", "--params", JSON.stringify({ objectid: input.objectid, offset, limit: BEAGLE_NEIGHBORHOOD_PAGE_SIZE + 1 }), "--", pageCypher]);
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
        const leg = await this.queryCommand(["query", "--params", JSON.stringify({ source: endpoints[index], target: endpoints[index + 1] }), "--", cypher]);
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
    return this.serial(() => this.mutate(["tag", ...(input.enabled ? [] : ["--remove"]), "--", input.objectid, input.tag]));
  }

  compose(value: BeagleComposeInput): Promise<BeagleQueryResult> {
    const input = parseBeagleComposeInput(value);
    return this.serial(() => this.queryCommand(["compose", `--source=${input.source}`, `--target=${input.target}`, `--kind=${input.kind}`]));
  }

  /** Complete canonical snapshot for native export; graph display limits do not apply. */
  exportGraph(): Promise<BeagleGraph> {
    return this.serial(async () => normalizeBeagleSnapshot(await this.execute(["export"])));
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
      if (value["version"] !== 1 || !Array.isArray(value["projects"]) || value["projects"].length === 0 || value["projects"].length > MAX_PROJECTS) {
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
      this.configuration = { version: 1, binaryPath, selectedProjectId, projects };
      return this.configuration;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const project = { id: randomUUID(), name: "Default", createdAt: new Date().toISOString() };
      const configuration: ProjectConfiguration = { version: 1, binaryPath: null, selectedProjectId: project.id, projects: [project] };
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
    const executable = process.platform === "win32" ? "beagle.exe" : "beagle";
    const candidates = configuration.binaryPath ? [{ path: configuration.binaryPath, source: "Selected executable" }] : [
      ...(this.environment["SLIVER_BEAGLE_BINARY"] ? [{ path: this.environment["SLIVER_BEAGLE_BINARY"]!, source: "SLIVER_BEAGLE_BINARY" }] : []),
      ...(this.options.resourcesPath ? [{ path: join(this.options.resourcesPath, "beagle", executable), source: "Bundled runtime" }] : []),
      { path: executable, source: "PATH" },
    ];
    let incompatibility: string | undefined;
    for (const candidate of candidates) {
      try {
        const version = await this.inspectBinary(candidate.path);
        this.binary = candidate.path;
        this.runtime = { available: true, version, source: candidate.source };
        return;
      } catch (error) {
        // Only expose our interface diagnostics; native spawn errors may contain private paths.
        if (error instanceof Error && /^(Unsupported|Incompatible) Beagle runtime/u.test(error.message)) incompatibility ??= error.message;
      }
    }
    this.runtime = { available: false, version: null, source: null, error: incompatibility ?? "Beagle was not found or could not run. Choose a Beagle executable." };
  }

  private async inspectBinary(binary: string): Promise<string> {
    const result = await this.run(binary, ["--version"], VERSION_TIMEOUT_MS);
    const version = result.stdout.trim();
    if (!/^beagle\s+[^\r\n]+$/iu.test(version) || version.length > 256) throw new Error("The selected executable is not a Beagle runtime");
    if (!/^beagle 0\.1\.\d+$/u.test(version)) throw new Error("Unsupported Beagle runtime. AD Explorer currently supports the Beagle 0.1.x interface; choose a compatible executable.");
    const help = await this.run(binary, ["--help"], VERSION_TIMEOUT_MS);
    const commands = ["ingest", "analyze", "query", "queries", "stats", "entity", "paths", "compose", "tag", "export"];
    if (commands.some((command) => !new RegExp(`^\\s+${command}\\s`, "mu").test(help.stdout)) ||
        !help.stdout.includes("--db") || !help.stdout.includes("--query-timeout")) {
      throw new Error("Incompatible Beagle runtime: required AD Explorer commands are missing. Choose a current Beagle 0.1.x executable.");
    }
    // Probe only an ephemeral in-memory database before touching an operator project.
    const probe = object(decode((await this.run(binary, ["--db", ":memory:", "--query-timeout", "3", "stats"], VERSION_TIMEOUT_MS)).stdout), "runtime capabilities");
    const capabilities = object(probe["capabilities"], "runtime capabilities");
    const features = object(capabilities["features"], "runtime query features");
    if (capabilities["schema_version"] !== 1 || ["parameters", "shortest_path", "variable_length_paths", "named_paths", "optional_match", "with_where", "call_subquery", "union", "existential_subquery_full", "list_comprehension", "quantifiers"]
      .some((feature) => features[feature] !== true)) {
      throw new Error("Incompatible Beagle runtime: required graph query capabilities are unavailable. Choose a current Beagle 0.1.x executable.");
    }
    return version;
  }

  private async run(binary: string, args: readonly string[], timeout: number): Promise<{ stdout: string; stderr: string }> {
    if (this.disposed) throw new Error("Beagle service is closed");
    const controller = new AbortController();
    this.controller = controller;
    try {
      const result = await this.runner(binary, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, signal: controller.signal, cwd: this.rootPath, env: this.environment });
      if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES) throw new Error("Beagle output exceeds the 32 MiB limit; narrow the query");
      return result;
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

  private async execute(args: string[], timeout = QUERY_TIMEOUT_MS): Promise<BeagleJsonValue> {
    await this.discover();
    if (!this.binary) throw new Error(this.runtime.error ?? "Beagle runtime is unavailable");
    const path = await this.database();
    const result = await this.run(this.binary, ["--db", path, "--query-timeout", "30", ...args], timeout);
    const value = decode(result.stdout);
    if (isObject(value) && typeof value["error"] === "string") throw new Error(value["error"].slice(0, 4_096));
    return value;
  }

  private async state(): Promise<BeagleState> {
    const configuration = await this.load();
    await this.discover();
    const stats = this.binary ? normalizeStats(await this.execute(["stats"])) : null;
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

  private async mutate(args: string[]): Promise<BeagleMutationResult> {
    const recordsAnalysis = args[0] === "ingest" || args[0] === "analyze";
    const configuration = await this.load();
    const diagnosticsPath = join(this.rootPath, configuration.selectedProjectId, "analysis-diagnostics.json");
    if (recordsAnalysis) {
      await this.database();
      // A child can commit before its output is lost or rejected. Never retain an
      // older clean report when completion of the latest analysis is uncertain.
      await writePrivateFileAtomic(diagnosticsPath, Buffer.from(JSON.stringify({ version: 1, localGroupAmbiguities: [],
        errors: ["The latest analysis has not completed with verified diagnostics. Run Analyze again before relying on local-group privilege choices."] })));
    }
    const report = await this.execute(args, WORKFLOW_TIMEOUT_MS);
    if (recordsAnalysis) {
      const diagnostics = normalizeBeagleAnalysisDiagnostics(report);
      await writePrivateFileAtomic(diagnosticsPath, Buffer.from(JSON.stringify(diagnostics)));
    }
    return { report, state: await this.state() };
  }

  private async queryCommand(args: string[]): Promise<BeagleQueryResult> {
    const configuration = await this.load();
    const startedAt = performance.now();
    const value = await this.execute(args);
    const result = normalizeBeagleQueryResult(value, configuration.selectedProjectId);
    const missing = collectGraph(result.rows).missingNodeIds.slice(0, BEAGLE_RESULT_LIMITS.nodes);
    if (missing.length > 0) {
      // Relationship-only results use engine-local IDs. Resolve them inside this same serialized
      // project operation, so graph identities always remain BloodHound object IDs.
      const nodes = await this.execute(["query", "--params", JSON.stringify({ ids: missing }), "--", "MATCH (n) WHERE id(n) IN $ids RETURN n"]);
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
