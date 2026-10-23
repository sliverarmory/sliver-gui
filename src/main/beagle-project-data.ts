import { randomUUID } from "node:crypto";
import type { BeagleImportRecord, BeagleCollectionCoverage } from "../shared/beagle-projects.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const categories = ["Sessions", "PrivilegedSessions", "RegistrySessions", "LocalGroups"];

/** Summarize quality, never interpret a missing relationship as successful collection. */
export function beagleImportRecord(
  operation: BeagleImportRecord["operation"], files: BeagleImportRecord["files"], report?: unknown,
  failure?: { cancelled: boolean; message: string },
): BeagleImportRecord {
  const value = object(report);
  const ingest = object(value["ingest"]);
  const rawWarnings = Array.isArray(ingest["warnings"]) ? ingest["warnings"].filter((v): v is string => typeof v === "string") : [];
  const coverage: Record<string, BeagleCollectionCoverage> = {};
  const compact = object(ingest["collectionQuality"]);
  for (const name of categories) {
    const quality = object(compact[name]);
    const item: BeagleCollectionCoverage = { collected: count(quality["collected"]), failed: count(quality["failed"]), unknown: count(quality["unknown"]), failureReasons: Object.create(null) as Record<string, number> };
    for (const [reason, amount] of Object.entries(object(quality["failureReasons"])).slice(0, 100)) item.failureReasons[reason.slice(0, 512)] = count(amount);
    coverage[name] = item;
  }
  if (!Object.keys(compact).length && Array.isArray(ingest["source_records"])) {
    for (const raw of ingest["source_records"]) {
      const data = object(object(raw)["data"]);
      for (const name of categories) {
        const values = name === "LocalGroups" && Array.isArray(data[name]) ? data[name] : [data[name]];
        for (const rawValue of values) {
          const observation = object(rawValue);
          const item = coverage[name]!;
          if (observation["Collected"] === true) item.collected++;
          else if (observation["Collected"] === false) {
            item.failed++;
            const reason = typeof observation["FailureReason"] === "string" ? observation["FailureReason"].slice(0, 512) : "Unspecified";
            if (Object.keys(item.failureReasons).length < 100 || Object.hasOwn(item.failureReasons, reason)) item.failureReasons[reason] = (item.failureReasons[reason] ?? 0) + 1;
          } else if (rawValue !== undefined) item.unknown++;
        }
      }
    }
  }
  const nativeFiles = Array.isArray(ingest["files"]) ? ingest["files"] : [];
  const collectors = [...new Set(nativeFiles.map((entry) => object(object(entry)["metadata"])["collectorversion"]).filter((v): v is string => typeof v === "string").map((v) => v.slice(0, 128)))].slice(0, 100);
  return {
    id: randomUUID(), at: new Date().toISOString(), operation, status: failure ? failure.cancelled ? "cancelled" : "failed" : "complete", files,
    ...(value["nodes"] === undefined ? {} : { nodes: count(value["nodes"]) }),
    ...(value["edges"] === undefined ? {} : { edges: count(value["edges"]) }),
    ...(ingest["records"] === undefined ? {} : { records: count(ingest["records"]) }),
    warnings: rawWarnings.slice(0, 200).map((v) => v.slice(0, 4096)), warningCount: rawWarnings.length + count(ingest["warningsTruncated"]),
    retainedFields: count(ingest["retainedFieldsCount"]) || (Array.isArray(ingest["retained_fields"]) ? ingest["retained_fields"].length : 0),
    coverage, collectors, ...(failure ? { message: failure.message.slice(0, 4096) } : {}),
  };
}
