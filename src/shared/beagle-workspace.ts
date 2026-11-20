import {
  BEAGLE_PROJECT_ID, BEAGLE_RESULT_LIMITS, parseBeagleJson, parseBeagleQueryInput,
  type BeagleJsonObject, type BeagleQueryResult,
} from "./beagle-contracts.js";
import { BEAGLE_PATH_EDGE_KINDS } from "./beagle-investigations.js";

export const BEAGLE_WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;
export const BEAGLE_CUSTOM_QUERY_LIMIT = 500;
export const BEAGLE_HISTORY_LIMIT = 30;
export interface BeagleCustomQuery { id: string; name: string; description: string; category: string; cypher: string; parameters: string }
export interface BeaglePathDraft { source: string; target: string; via: string[]; relationshipKinds: string[]; all: boolean; maxHops: string }
export interface BeagleGraphView { layout: "horizontal" | "vertical" | "circle"; nodeLabels: boolean; edgeLabels: boolean }
export interface BeagleTableView { columns: string[]; sort: { column: string; direction: "asc" | "desc" } | null }
export interface BeagleHistoryEntry {
  id: string;
  title: string;
  createdAt: string;
  result: BeagleQueryResult;
  selection: { kind: "node" | "edge"; id: string } | null;
  sidebarTab: "search" | "queries" | "paths";
  resultTab: "graph" | "table" | "objects";
  editor: { cypher: string; parameters: string; name: string; description: string; category: string; savedId?: string };
  path: BeaglePathDraft;
  graph: BeagleGraphView;
  table: BeagleTableView;
}
export interface BeagleWorkspace {
  version: 1;
  projectId: string;
  legacyMigrated: boolean;
  queries: BeagleCustomQuery[];
  history: { entries: BeagleHistoryEntry[]; index: number };
}
export function emptyBeagleWorkspace(projectId: string): BeagleWorkspace {
  return { version: 1, projectId, legacyMigrated: false, queries: [], history: { entries: [], index: -1 } };
}
export function defaultBeaglePathDraft(): BeaglePathDraft { return { source: "", target: "", via: [], relationshipKinds: [...BEAGLE_PATH_EDGE_KINDS], all: false, maxHops: "12" }; }
export function defaultBeagleGraphView(): BeagleGraphView { return { layout: "horizontal", nodeLabels: true, edgeLabels: true }; }

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError("Invalid investigation data");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)) throw new TypeError("Invalid investigation text");
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw new TypeError("Invalid investigation flag"); return value; }
function integer(value: unknown, min: number, max: number): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError("Invalid investigation count"); return Number(value); }
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw new TypeError("Investigation list exceeds its limit"); return value; }
function member<T extends string>(value: unknown, allowed: readonly T[]): T { if (typeof value !== "string" || !allowed.includes(value as T)) throw new TypeError("Invalid investigation choice"); return value as T; }
function strings(value: unknown, max: number, length = 512): string[] {
  const result = list(value, max).map((item) => string(item, length));
  if (new Set(result).size !== result.length) throw new TypeError("Duplicate investigation values");
  return result;
}
export function parseBeagleCustomQueries(value: unknown): BeagleCustomQuery[] {
  const result = list(value, BEAGLE_CUSTOM_QUERY_LIMIT).map((entry): BeagleCustomQuery => {
    const item = record(entry, ["id", "name", "description", "category", "cypher", "parameters"]);
    const cypher = string(item["cypher"], 100_000), parameters = string(item["parameters"], 65_536, true);
    parseBeagleQueryInput({ cypher, parameters: JSON.parse(parameters.trim() || "{}") });
    return { id: string(item["id"], 128), name: string(item["name"], 160), description: string(item["description"], 4_000, true),
      category: string(item["category"], 160, true), cypher, parameters };
  });
  if (new Set(result.map((item) => item.id)).size !== result.length) throw new TypeError("Duplicate saved query IDs");
  return result;
}

/** Accept CE's transferable {name,description,query} and query-library JSON, plus our lossless envelope. */
export function parseBeaglePortableQueries(value: unknown): BeagleCustomQuery[] {
  const parsed = parseBeagleJson(value, 200_000);
  let entries: unknown[];
  if (Array.isArray(parsed)) entries = parsed;
  else {
    const item = parsed && typeof parsed === "object" ? parsed : {};
    entries = Array.isArray(item["queries"]) ? item["queries"] : [item];
  }
  return parseBeagleCustomQueries(entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Invalid query library entry");
    const item = entry as Record<string, unknown>;
    const cypher = item["cypher"] ?? item["query"];
    const parameters = item["parameters"];
    if (parameters !== undefined && parameters !== null && typeof parameters !== "string" && (typeof parameters !== "object" || Array.isArray(parameters))) throw new TypeError("Query parameters must be an object or JSON text");
    return { id: typeof item["id"] === "string" ? item["id"] : `import-${index + 1}`, name: item["name"], description: item["description"] ?? "",
      category: item["category"] ?? "Imported", cypher,
      parameters: typeof parameters === "string" ? parameters : parameters && !Array.isArray(parameters) ? JSON.stringify(parameters) : "{}" };
  }));
}
export function exportBeaglePortableQueries(queries: readonly BeagleCustomQuery[]): BeagleJsonObject {
  return { version: 1, queries: parseBeagleCustomQueries(queries).map((query) => ({ id: query.id, name: query.name, description: query.description,
    category: query.category, query: query.cypher, parameters: JSON.parse(query.parameters.trim() || "{}") as BeagleJsonObject })) };
}

export function parseBeagleResultSnapshot(value: unknown, projectId?: string): BeagleQueryResult {
  const item = record(value, ["projectId", "columns", "rows", "graph", "elapsedMs", "totalRows", "truncated", "limits", "objectid", "view", "page"]);
  const resultProject = string(item["projectId"], 128);
  if (!BEAGLE_PROJECT_ID.test(resultProject) || (projectId !== undefined && resultProject !== projectId)) throw new TypeError("Investigation belongs to another project");
  const graph = record(item["graph"], ["nodes", "edges"]);
  const nodes = list(graph["nodes"], BEAGLE_RESULT_LIMITS.nodes).map((entry) => {
    const node = record(entry, ["objectid", "labels", "properties"]);
    const properties = parseBeagleJson(node["properties"]);
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new TypeError("Invalid object properties");
    return { objectid: string(node["objectid"], 512), labels: strings(node["labels"], 100), properties };
  });
  const ids = new Set(nodes.map((node) => node.objectid));
  if (ids.size !== nodes.length) throw new TypeError("Duplicate graph objects");
  const edges = list(graph["edges"], BEAGLE_RESULT_LIMITS.edges).map((entry) => {
    const edge = record(entry, ["id", "source", "target", "kind", "properties", "derived"]);
    const source = string(edge["source"], 512), target = string(edge["target"], 512);
    if (!ids.has(source) || !ids.has(target)) throw new TypeError("Relationship endpoints are missing");
    const properties = parseBeagleJson(edge["properties"]);
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) throw new TypeError("Invalid relationship properties");
    return { id: string(edge["id"], 2_048), source, target, kind: string(edge["kind"], 128), properties, derived: edge["derived"] === null ? null : bool(edge["derived"]) };
  });
  if (new Set(edges.map((edge) => edge.id)).size !== edges.length) throw new TypeError("Duplicate graph relationships");
  const rows = list(item["rows"], BEAGLE_RESULT_LIMITS.rows).map((row) => {
    const parsed = parseBeagleJson(row);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("Invalid result row");
    return parsed;
  });
  const limits = record(item["limits"], ["rows", "nodes", "edges"]);
  return { projectId: resultProject, columns: strings(item["columns"], 256, 512), rows, graph: { nodes, edges },
    elapsedMs: integer(item["elapsedMs"], 0, Number.MAX_SAFE_INTEGER), totalRows: integer(item["totalRows"], 0, Number.MAX_SAFE_INTEGER), truncated: bool(item["truncated"]),
    limits: { rows: integer(limits["rows"], 1, BEAGLE_RESULT_LIMITS.rows), nodes: integer(limits["nodes"], 1, BEAGLE_RESULT_LIMITS.nodes), edges: integer(limits["edges"], 1, BEAGLE_RESULT_LIMITS.edges) } };
}
export function parseBeaglePathDraft(value: unknown): BeaglePathDraft {
  const item = record(value, ["source", "target", "via", "relationshipKinds", "all", "maxHops"]);
  return { source: string(item["source"], 512, true), target: string(item["target"], 512, true), via: list(item["via"], 2).map((entry) => string(entry, 512, true)),
    relationshipKinds: strings(item["relationshipKinds"], BEAGLE_PATH_EDGE_KINDS.length).map((kind) => member(kind, BEAGLE_PATH_EDGE_KINDS)), all: bool(item["all"]), maxHops: string(item["maxHops"], 8, true) };
}
export function parseBeagleWorkspace(value: unknown): BeagleWorkspace {
  const parsed = parseBeagleJson(value, 1_000_000);
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > BEAGLE_WORKSPACE_MAX_BYTES) throw new TypeError("Investigation workspace exceeds 16 MiB");
  const item = record(parsed, ["version", "projectId", "legacyMigrated", "queries", "history"]);
  if (item["version"] !== 1) throw new TypeError("Unsupported investigation workspace version");
  const projectId = string(item["projectId"], 128);
  if (!BEAGLE_PROJECT_ID.test(projectId)) throw new TypeError("Invalid investigation project");
  const history = record(item["history"], ["entries", "index"]);
  const entries = list(history["entries"], BEAGLE_HISTORY_LIMIT).map((entry): BeagleHistoryEntry => {
    const row = record(entry, ["id", "title", "createdAt", "result", "selection", "sidebarTab", "resultTab", "editor", "path", "graph", "table"]);
    const editor = record(row["editor"], ["cypher", "parameters", "name", "description", "category", "savedId"]);
    const graph = record(row["graph"], ["layout", "nodeLabels", "edgeLabels"]);
    const table = record(row["table"], ["columns", "sort"]);
    const selection = row["selection"] === null ? null : record(row["selection"], ["kind", "id"]);
    const sort = table["sort"] === null ? null : record(table["sort"], ["column", "direction"]);
    const createdAt = string(row["createdAt"], 40);
    if (!Number.isFinite(Date.parse(createdAt))) throw new TypeError("Invalid investigation date");
    return { id: string(row["id"], 128), title: string(row["title"], 512), createdAt, result: parseBeagleResultSnapshot(row["result"], projectId),
      selection: selection ? { kind: member(selection["kind"], ["node", "edge"]), id: string(selection["id"], 2_048) } : null,
      sidebarTab: member(row["sidebarTab"], ["search", "queries", "paths"]), resultTab: member(row["resultTab"], ["graph", "table", "objects"]),
      editor: { cypher: string(editor["cypher"], 100_000, true), parameters: string(editor["parameters"], 65_536, true), name: string(editor["name"], 160, true),
        description: string(editor["description"], 4_000, true), category: string(editor["category"], 160, true), ...(editor["savedId"] === undefined ? {} : { savedId: string(editor["savedId"], 128) }) },
      path: parseBeaglePathDraft(row["path"]), graph: { layout: member(graph["layout"], ["horizontal", "vertical", "circle"]), nodeLabels: bool(graph["nodeLabels"]), edgeLabels: bool(graph["edgeLabels"]) },
      table: { columns: strings(table["columns"], 256), sort: sort ? { column: string(sort["column"], 512), direction: member(sort["direction"], ["asc", "desc"]) } : null } };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new TypeError("Duplicate investigation IDs");
  return { version: 1, projectId, legacyMigrated: bool(item["legacyMigrated"]), queries: parseBeagleCustomQueries(item["queries"]),
    history: { entries, index: integer(history["index"], entries.length ? 0 : -1, entries.length - 1) } };
}
