import type { BeagleJsonObject } from "./beagle-contracts.js";
import type { BeagleAssetGroupConfiguration } from "./beagle-rules.js";

export const BEAGLE_RUNTIME_PROTOCOL = 1 as const;
/** Wire limits include the terminating newline. */
export const BEAGLE_RUNTIME_MAX_REQUEST_BYTES = 1024 * 1024;
export const BEAGLE_RUNTIME_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const BEAGLE_RUNTIME_REQUIRED_OPERATIONS = [
  "open", "stats", "query", "savedQuery", "catalog", "savedQueryInfo", "entity", "ingest",
  "analyze", "tag", "compose", "export", "paths", "shutdown",
] as const;
export const BEAGLE_RUNTIME_OPTIONAL_OPERATIONS = [
  "importSnapshot", "exportToFile", "backup", "cleanup", "getAssetGroups", "previewAssetGroups", "applyAssetGroups", "relayTargets", "closeDatabase", "setImportHistoryRetention",
] as const;
export const BEAGLE_RUNTIME_OPERATIONS = [...BEAGLE_RUNTIME_REQUIRED_OPERATIONS, ...BEAGLE_RUNTIME_OPTIONAL_OPERATIONS] as const;

/** Main owns database paths and file selections. The renderer never receives this API. */
export type BeagleRuntimeCommand =
  | { type: "open"; database: string; queryTimeoutMs: number }
  | { type: "closeDatabase" }
  | { type: "setImportHistoryRetention"; limit: number }
  | { type: "stats" }
  | { type: "query"; cypher: string; parameters: BeagleJsonObject }
  | { type: "savedQuery"; id: string; parameters: BeagleJsonObject }
  | { type: "catalog" }
  | { type: "savedQueryInfo"; id: string }
  | { type: "entity"; objectid: string }
  | { type: "ingest"; paths: readonly string[]; analyze: boolean; mode?: "merge" | "replace"; compactReports?: boolean; historyLimit?: number }
  | { type: "analyze"; compactReports?: boolean }
  | { type: "tag"; objectid: string; tag: "owned" | "admin_tier_0"; enabled: boolean }
  | { type: "compose"; source: string; target: string; kind: string }
  | { type: "export" }
  | { type: "importSnapshot"; path: string; analyze: boolean; compactReports?: boolean }
  | { type: "exportToFile"; path: string; kind?: "current" | "raw" }
  | { type: "backup"; path: string }
  | { type: "cleanup"; kinds: readonly string[] }
  | { type: "getAssetGroups" }
  | { type: "previewAssetGroups"; configuration: BeagleAssetGroupConfiguration }
  | { type: "applyAssetGroups"; configuration: BeagleAssetGroupConfiguration }
  | { type: "relayTargets"; source: string; target: string; kind: string }
  | { type: "paths"; source: string; target: string; all: boolean; maxHops: number }
  | { type: "shutdown" };

export interface BeagleRuntimeReady {
  readonly type: "ready";
  readonly protocol: typeof BEAGLE_RUNTIME_PROTOCOL;
  readonly name: "beagle";
  readonly version: string;
  readonly operations: readonly BeagleRuntimeCommand["type"][];
  readonly limits: { readonly requestBytes: number; readonly responseBytes: number };
}
