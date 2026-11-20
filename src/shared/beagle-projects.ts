import { BEAGLE_PROJECT_ID, parseBeagleJson, type BeagleJsonObject } from "./beagle-contracts.js";

export interface BeagleImportInput { mode: "merge" | "replace" }
export interface BeagleRenameProjectInput { id: string; name: string }
export interface BeagleProjectIdInput { id: string }
export interface BeagleCleanupInput { scope: "sessions" | "collected" }
export type BeagleHistoryRetention = 10 | 25 | 50 | 100;
export interface BeagleRetentionInput { historyLimit: BeagleHistoryRetention }
export interface BeagleCollectionCoverage { collected: number; failed: number; unknown: number; failureReasons: Record<string, number> }
export interface BeagleImportRecord {
  id: string;
  at: string;
  operation: "merge" | "replace" | "analyze" | "sessions" | "collected" | "rules";
  status: "complete" | "failed" | "cancelled";
  files: { name: string; sha256: string; bytes: number }[];
  nodes?: number;
  edges?: number;
  records?: number;
  warnings: string[];
  warningCount: number;
  retainedFields: number;
  coverage: Record<string, BeagleCollectionCoverage>;
  collectors: string[];
  message?: string;
}
export interface BeagleProjectData {
  version: 1;
  historyLimit: BeagleHistoryRetention;
  history: BeagleImportRecord[];
  error?: string;
}
export interface BeagleOperationState {
  id: string;
  label: string;
  phase: string;
  startedAt: number;
  cancellable: boolean;
}
export const BEAGLE_STORAGE_LIMITS = Object.freeze({
  workspaceBytes: 16 * 1024 * 1024,
  projectDataBytes: 4 * 1024 * 1024,
  backupMetadataBytes: 24 * 1024 * 1024,
  backupDatabaseBytes: 8 * 1024 * 1024 * 1024,
  snapshotBytes: 1024 * 1024 * 1024,
});

function input(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || Object.keys(value).some((key) => !keys.includes(key))) throw new TypeError("Invalid project request");
  return value as Record<string, unknown>;
}
export function parseBeagleProjectIdInput(value: unknown): BeagleProjectIdInput {
  const item = input(value, ["id"]);
  if (typeof item["id"] !== "string" || !BEAGLE_PROJECT_ID.test(item["id"])) throw new TypeError("Invalid project ID");
  return { id: item["id"] };
}
export function parseBeagleRenameProjectInput(value: unknown): BeagleRenameProjectInput {
  const item = input(value, ["id", "name"]);
  const { id } = parseBeagleProjectIdInput({ id: item["id"] });
  if (typeof item["name"] !== "string" || !item["name"].trim() || item["name"].length > 80 || /[\x00-\x1f\x7f]/u.test(item["name"])) throw new TypeError("Invalid project name");
  return { id, name: item["name"].trim() };
}
export function parseBeagleImportInput(value: unknown): BeagleImportInput {
  const item = input(value, ["mode"]);
  if (item["mode"] !== "merge" && item["mode"] !== "replace") throw new TypeError("Choose merge or replace");
  return { mode: item["mode"] };
}
export function parseBeagleCleanupInput(value: unknown): BeagleCleanupInput {
  const item = input(value, ["scope"]);
  if (item["scope"] !== "sessions" && item["scope"] !== "collected") throw new TypeError("Choose a cleanup scope");
  return { scope: item["scope"] };
}
export function parseBeagleRetentionInput(value: unknown): BeagleRetentionInput {
  const item = input(value, ["historyLimit"]);
  if (typeof item["historyLimit"] !== "number" || ![10, 25, 50, 100].includes(item["historyLimit"])) throw new TypeError("Choose an import-history limit of 10, 25, 50 or 100");
  return { historyLimit: item["historyLimit"] as BeagleHistoryRetention };
}
export function emptyBeagleProjectData(): BeagleProjectData { return { version: 1, historyLimit: 50, history: [] }; }
export function parseBeagleProjectData(value: unknown): BeagleProjectData {
  const item = input(parseBeagleJson(value, 500_000), ["version", "historyLimit", "history", "error"]);
  const { historyLimit } = parseBeagleRetentionInput({ historyLimit: item["historyLimit"] });
  if (item["version"] !== 1 || !Array.isArray(item["history"]) || item["history"].length > historyLimit || JSON.stringify(item).length > BEAGLE_STORAGE_LIMITS.projectDataBytes) throw new TypeError("Invalid project history");
  if (item["error"] !== undefined && (typeof item["error"] !== "string" || item["error"].length > 4096)) throw new TypeError("Invalid project history error");
  const ids = new Set<string>();
  for (const entry of item["history"] as BeagleJsonObject[]) {
    input(entry, ["id", "at", "operation", "status", "files", "nodes", "edges", "records", "warnings", "warningCount", "retainedFields", "coverage", "collectors", "message"]);
    if (!entry || typeof entry !== "object" || typeof entry["id"] !== "string" || !BEAGLE_PROJECT_ID.test(entry["id"]) || typeof entry["at"] !== "string" || !Number.isFinite(Date.parse(entry["at"])) ||
      !["merge", "replace", "analyze", "sessions", "collected", "rules"].includes(String(entry["operation"])) || !["complete", "failed", "cancelled"].includes(String(entry["status"])) ||
      !Array.isArray(entry["files"]) || entry["files"].length > 100 || !Array.isArray(entry["warnings"]) || entry["warnings"].length > 200 ||
      !Array.isArray(entry["collectors"]) || entry["collectors"].length > 100 || entry["collectors"].some((v) => typeof v !== "string" || v.length > 128) || !entry["coverage"] || typeof entry["coverage"] !== "object" || Array.isArray(entry["coverage"])) throw new TypeError("Invalid project history record");
    if (ids.has(entry["id"])) throw new TypeError("Duplicate history identity");
    ids.add(entry["id"]);
    if (entry["message"] !== undefined && (typeof entry["message"] !== "string" || entry["message"].length > 4096)) throw new TypeError("Invalid project history message");
    if (entry["warningCount"] === undefined || entry["retainedFields"] === undefined) throw new TypeError("Missing project history counts");
    for (const name of ["nodes", "edges", "records", "warningCount", "retainedFields"]) {
      const count = entry[name];
      if (count !== undefined && (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new TypeError("Invalid project history count");
    }
    if (entry["warnings"].some((v) => typeof v !== "string" || v.length > 4096)) throw new TypeError("Invalid import warning");
    for (const file of entry["files"] as BeagleJsonObject[]) {
      input(file, ["name", "sha256", "bytes"]);
      if (!file || typeof file["name"] !== "string" || file["name"].length > 512 || typeof file["sha256"] !== "string" || !/^[a-f0-9]{64}$/u.test(file["sha256"]) || typeof file["bytes"] !== "number" || !Number.isSafeInteger(file["bytes"]) || file["bytes"] < 0) throw new TypeError("Invalid import provenance");
    }
    input(entry["coverage"], ["Sessions", "PrivilegedSessions", "RegistrySessions", "LocalGroups"]);
    for (const coverage of Object.values(entry["coverage"]) as BeagleJsonObject[]) {
      input(coverage, ["collected", "failed", "unknown", "failureReasons"]);
      if (!coverage || typeof coverage !== "object" || ["collected", "failed", "unknown"].some((name) => typeof coverage[name] !== "number" || !Number.isSafeInteger(coverage[name]) || (coverage[name] as number) < 0) || !coverage["failureReasons"] || typeof coverage["failureReasons"] !== "object" || Array.isArray(coverage["failureReasons"])) throw new TypeError("Invalid collection coverage");
      const reasons = Object.entries(coverage["failureReasons"]);
      if (reasons.length > 100 || reasons.some(([reason, count]) => reason.length > 512 || typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)) throw new TypeError("Invalid collection failure reason");
    }
  }
  return item as unknown as BeagleProjectData;
}
