import type { ApplicationSettingsState } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";

export type BeagleJsonValue = null | boolean | number | string | BeagleJsonValue[] | BeagleJsonObject;
export interface BeagleJsonObject { [key: string]: BeagleJsonValue }

export interface BeagleNode {
  objectid: string;
  labels: string[];
  properties: BeagleJsonObject;
}
export interface BeagleEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  properties: BeagleJsonObject;
  /** null when a Cypher relationship value omits analysis provenance. */
  derived: boolean | null;
}
export interface BeagleGraph { nodes: BeagleNode[]; edges: BeagleEdge[] }
export interface BeagleProject { id: string; name: string; createdAt: string }
export interface BeagleStats {
  nodes: number;
  edges: number;
  labels: Record<string, number>;
  relationships: Record<string, number>;
}
export interface BeagleState {
  runtime: { available: boolean; version: string | null; source: string | null; error?: string };
  projects: BeagleProject[];
  selectedProjectId: string;
  stats: BeagleStats | null;
}
export interface BeagleQueryResult {
  projectId: string;
  columns: string[];
  rows: BeagleJsonObject[];
  graph: BeagleGraph;
  elapsedMs: number;
  totalRows: number;
  truncated: boolean;
  limits: { rows: number; nodes: number; edges: number };
}
export interface BeagleSearchResult extends BeagleQueryResult {
  /** Search reads one bounded page; totalRows describes this page, not all matches. */
  page: { offset: number; limit: number; hasMore: boolean };
}
export interface BeagleMutationResult { state: BeagleState; report: BeagleJsonValue }
export interface BeagleSavedQuery {
  id: string;
  name: string;
  description: string;
  category: string;
  cypher: string;
  parameters: string[];
}

export interface BeagleCreateProjectInput { name: string }
export interface BeagleSelectProjectInput { id: string }
export interface BeagleQueryInput { cypher: string; parameters?: BeagleJsonObject }
export interface BeagleSavedQueryInput { id: string; parameters?: BeagleJsonObject }
export interface BeagleSearchInput { term: string; offset?: number }
export interface BeagleEntityInput { objectid: string }
export interface BeaglePathsInput { source: string; target: string; all?: boolean; maxHops?: number }
export interface BeagleTagInput { objectid: string; tag: "owned" | "admin_tier_0"; enabled: boolean }
export interface BeagleComposeInput { source: string; target: string; kind: string }

/** Paths and executable selection are supplied by native dialogs in main, never by the renderer. */
export interface BeagleAPI {
  getState(): Promise<OperationResult<BeagleState>>;
  createProject(input: BeagleCreateProjectInput): Promise<OperationResult<BeagleState>>;
  selectProject(input: BeagleSelectProjectInput): Promise<OperationResult<BeagleState>>;
  chooseBinary(): Promise<OperationResult<BeagleState>>;
  importFiles(): Promise<OperationResult<BeagleMutationResult>>;
  analyze(): Promise<OperationResult<BeagleMutationResult>>;
  query(input: BeagleQueryInput): Promise<OperationResult<BeagleQueryResult>>;
  getQueries(): Promise<OperationResult<BeagleSavedQuery[]>>;
  runSavedQuery(input: BeagleSavedQueryInput): Promise<OperationResult<BeagleQueryResult>>;
  search(input: BeagleSearchInput): Promise<OperationResult<BeagleSearchResult>>;
  entity(input: BeagleEntityInput): Promise<OperationResult<BeagleQueryResult>>;
  paths(input: BeaglePathsInput): Promise<OperationResult<BeagleQueryResult>>;
  tag(input: BeagleTagInput): Promise<OperationResult<BeagleMutationResult>>;
  compose(input: BeagleComposeInput): Promise<OperationResult<BeagleQueryResult>>;
  exportGraph(): Promise<OperationResult<{ cancelled: boolean }>>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onApplicationSettingsChanged(listener: (settings: ApplicationSettingsState) => void): () => void;
}

export const BEAGLE_IPC_INVOKE = Object.freeze({
  getState: "sliver:beagle:state",
  createProject: "sliver:beagle:project:create",
  selectProject: "sliver:beagle:project:select",
  chooseBinary: "sliver:beagle:binary:choose",
  importFiles: "sliver:beagle:import",
  analyze: "sliver:beagle:analyze",
  query: "sliver:beagle:query",
  getQueries: "sliver:beagle:queries",
  runSavedQuery: "sliver:beagle:query:saved",
  search: "sliver:beagle:search",
  entity: "sliver:beagle:entity",
  paths: "sliver:beagle:paths",
  tag: "sliver:beagle:tag",
  compose: "sliver:beagle:compose",
  exportGraph: "sliver:beagle:export",
  getApplicationSettings: "sliver:beagle:application-settings:get",
});

export const BEAGLE_RESULT_LIMITS = Object.freeze({ rows: 5_000, nodes: 1_500, edges: 3_000 });
export const BEAGLE_SEARCH_PAGE_SIZE = 100;
export const BEAGLE_PROJECT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

function request(value: unknown, fields: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError("Invalid Beagle request");
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 512, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u).test(value)) {
    throw new TypeError("Invalid Beagle text");
  }
  return value;
}

/** Copies bounded JSON data without invoking prototype setters. */
export function parseBeagleJson(value: unknown, maxEntries = 100_000): BeagleJsonValue {
  const seen = new Set<object>();
  let entries = 0;
  function parse(item: unknown, depth: number): BeagleJsonValue {
    if (++entries > maxEntries || depth > 32) throw new TypeError("Beagle JSON exceeds structural limits");
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.length <= 1_000_000) return item;
    if (typeof item !== "object" || item === null || seen.has(item)) throw new TypeError("Invalid Beagle JSON");
    seen.add(item);
    let result: BeagleJsonValue;
    if (Array.isArray(item)) result = item.map((entry: unknown) => parse(entry, depth + 1));
    else {
      const prototype: unknown = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid Beagle JSON object");
      const object: BeagleJsonObject = {};
      for (const [key, entry] of Object.entries(item)) {
        Object.defineProperty(object, key, { value: parse(entry, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      result = object;
    }
    seen.delete(item);
    return result;
  }
  return parse(value, 0);
}
function parameters(value: unknown): { parameters?: BeagleJsonObject } {
  if (value === undefined) return {};
  const parsed = parseBeagleJson(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed).length > 65_536) {
    throw new TypeError("Beagle parameters must be a JSON object of at most 64 KiB");
  }
  return { parameters: parsed };
}
export function parseBeagleCreateProjectInput(value: unknown): BeagleCreateProjectInput {
  const input = request(value, ["name"]);
  return { name: text(input["name"], 80).trim() };
}
export function parseBeagleSelectProjectInput(value: unknown): BeagleSelectProjectInput {
  const input = request(value, ["id"]);
  const id = text(input["id"]);
  if (!BEAGLE_PROJECT_ID.test(id)) throw new TypeError("Invalid Beagle project ID");
  return { id };
}
export function parseBeagleQueryInput(value: unknown): BeagleQueryInput {
  const input = request(value, ["cypher", "parameters"]);
  return { cypher: text(input["cypher"], 65_536, true), ...parameters(input["parameters"]) };
}
export function parseBeagleSavedQueryInput(value: unknown): BeagleSavedQueryInput {
  const input = request(value, ["id", "parameters"]);
  return { id: text(input["id"]), ...parameters(input["parameters"]) };
}
export function parseBeagleSearchInput(value: unknown): BeagleSearchInput {
  const input = request(value, ["term", "offset"]);
  const offset = input["offset"];
  if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)) {
    throw new TypeError("Beagle search offset must be a nonnegative safe integer");
  }
  return { term: text(input["term"], 256), ...(offset === undefined ? {} : { offset }) };
}
export function parseBeagleEntityInput(value: unknown): BeagleEntityInput {
  const input = request(value, ["objectid"]);
  return { objectid: text(input["objectid"]) };
}
export function parseBeaglePathsInput(value: unknown): BeaglePathsInput {
  const input = request(value, ["source", "target", "all", "maxHops"]);
  const all = input["all"];
  const maxHops = input["maxHops"];
  if (all !== undefined && typeof all !== "boolean") throw new TypeError("Invalid Beagle path selection");
  if (maxHops !== undefined && (typeof maxHops !== "number" || !Number.isInteger(maxHops) || maxHops < 1 || maxHops > 64)) {
    throw new TypeError("Beagle max hops must be between 1 and 64");
  }
  return {
    source: text(input["source"]), target: text(input["target"]),
    ...(all === undefined ? {} : { all }), ...(maxHops === undefined ? {} : { maxHops }),
  };
}
export function parseBeagleTagInput(value: unknown): BeagleTagInput {
  const input = request(value, ["objectid", "tag", "enabled"]);
  const tag = input["tag"];
  const enabled = input["enabled"];
  if (tag !== "owned" && tag !== "admin_tier_0") throw new TypeError("Invalid Beagle tag");
  if (typeof enabled !== "boolean") throw new TypeError("Invalid Beagle tag state");
  return { objectid: text(input["objectid"]), tag, enabled };
}
export function parseBeagleComposeInput(value: unknown): BeagleComposeInput {
  const input = request(value, ["source", "target", "kind"]);
  return { source: text(input["source"]), target: text(input["target"]), kind: text(input["kind"], 128) };
}
