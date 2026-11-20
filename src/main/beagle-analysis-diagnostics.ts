import type { BeagleAnalysisDiagnostics, BeagleLocalGroupAmbiguity } from "../shared/beagle-diagnostics.js";

const RELATIONSHIPS = { "-544": "AdminTo", "-580": "CanPSRemote", "-562": "ExecuteDCOM", "-555": "CanRDP" } as const;
const LIMITS = { ambiguities: 100, candidates: 50, members: 250, identityLength: 512, characters: 262_144, errors: 16 } as const;

function record(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function identity(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > LIMITS.identityLength || /[\x00-\x1f\x7f]/u.test(value)) {
    throw new TypeError("Invalid object identity");
  }
  return value;
}

function candidate(objectid: unknown, members: unknown): BeagleLocalGroupAmbiguity["candidateGroups"][number] {
  if (!Array.isArray(members) || members.length > LIMITS.members) throw new TypeError("Invalid direct members");
  const directMembers = members.map(identity);
  if (new Set(directMembers).size !== directMembers.length) throw new TypeError("Duplicate direct member");
  return { objectid: identity(objectid), directMembers };
}

function ambiguity(value: unknown, native: boolean): BeagleLocalGroupAmbiguity {
  if (!record(value)) throw new TypeError("Invalid ambiguity");
  const computer = identity(value["computer"]);
  const suffix = value["suffix"];
  if (typeof suffix !== "string" || !Object.hasOwn(RELATIONSHIPS, suffix)) throw new TypeError("Invalid group suffix");
  const typedSuffix = suffix as BeagleLocalGroupAmbiguity["suffix"];
  const relationshipKind = RELATIONSHIPS[typedSuffix];
  if (value[native ? "relationship_kind" : "relationshipKind"] !== relationshipKind) throw new TypeError("Invalid privilege kind");
  const selectedGroup = identity(value[native ? "selected_group" : "selectedGroup"]);
  const candidates = value[native ? "candidate_groups" : "candidateGroups"];
  let candidateGroups: BeagleLocalGroupAmbiguity["candidateGroups"];
  if (native) {
    if (!record(candidates)) throw new TypeError("Invalid candidate groups");
    const ids = Object.keys(candidates);
    if (ids.length < 2 || ids.length > LIMITS.candidates) throw new TypeError("Invalid candidate group count");
    candidateGroups = ids.map((id) => candidate(id, candidates[id]));
  } else {
    if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > LIMITS.candidates) throw new TypeError("Invalid candidate groups");
    candidateGroups = candidates.map((item: unknown) => {
      if (!record(item)) throw new TypeError("Invalid candidate group");
      return candidate(item["objectid"], item["directMembers"]);
    });
  }
  const ids = new Set(candidateGroups.map((group) => group.objectid));
  if (ids.size !== candidateGroups.length || !ids.has(selectedGroup)) throw new TypeError("Invalid selected group");
  if (candidateGroups.some((group) => !group.objectid.endsWith(typedSuffix))) throw new TypeError("Candidate suffix mismatch");
  return { computer, suffix: typedSuffix, relationshipKind, selectedGroup, candidateGroups };
}

function parse(value: unknown, native: boolean): BeagleAnalysisDiagnostics {
  const result: BeagleAnalysisDiagnostics = { version: 1, localGroupAmbiguities: [], errors: [] };
  const error = (message: string): void => {
    if (result.errors.length < LIMITS.errors - 1) result.errors.push(message);
    else if (result.errors.length === LIMITS.errors - 1) result.errors.push("Additional diagnostic validation errors were omitted.");
  };
  if (!record(value) || (!native && value["version"] !== 1)) {
    error("Analysis diagnostics are unavailable or use an unsupported format. Run Analyze with a compatible Beagle runtime.");
    return result;
  }
  if (!native) {
    const errors = value["errors"];
    if (!Array.isArray(errors)) error("Stored analysis diagnostics have an invalid error list.");
    else {
      for (const item of errors.slice(0, LIMITS.errors)) {
        if (typeof item === "string" && item.trim() && item.length <= 256 && !/[\x00-\x1f\x7f]/u.test(item)) error(item);
        else error("Stored analysis diagnostics contain an invalid error message.");
      }
      if (errors.length > LIMITS.errors) error("Additional stored diagnostic errors were omitted.");
    }
  }
  const entries = value[native ? "local_group_ambiguities" : "localGroupAmbiguities"];
  if (!Array.isArray(entries)) {
    error("The analysis report does not contain valid local-group ambiguity diagnostics. Run Analyze with a compatible Beagle runtime.");
    return result;
  }
  if (entries.length > LIMITS.ambiguities) error(`Only the first ${LIMITS.ambiguities} local-group ambiguities could be checked; additional choices were omitted.`);
  let characters = 0;
  const seen = new Set<string>();
  for (const [index, entry] of entries.slice(0, LIMITS.ambiguities).entries()) {
    try {
      const parsed = ambiguity(entry, native);
      const key = JSON.stringify([parsed.computer, parsed.suffix]);
      if (seen.has(key)) throw new TypeError("Duplicate ambiguity");
      const size = parsed.computer.length + parsed.selectedGroup.length + parsed.candidateGroups.reduce((sum, group) => sum + group.objectid.length + group.directMembers.reduce((count, member) => count + member.length, 0), 0);
      if (characters + size > LIMITS.characters) {
        error("Analysis diagnostics exceed the display size limit; some choices were omitted.");
        break;
      }
      characters += size;
      seen.add(key);
      result.localGroupAmbiguities.push(parsed);
    } catch {
      error(`Local-group ambiguity ${index + 1} was invalid or exceeded display limits and could not be shown completely.`);
    }
  }
  return result;
}

/** Accepts native analyze/ingest envelopes or the contained AnalysisReport. */
export function normalizeBeagleAnalysisDiagnostics(report: unknown): BeagleAnalysisDiagnostics {
  return parse(record(report) && Object.hasOwn(report, "analysis") ? report["analysis"] : report, true);
}

/** Revalidates the bounded persisted representation before returning it to the renderer. */
export function parseBeagleAnalysisDiagnostics(value: unknown): BeagleAnalysisDiagnostics {
  return parse(value, false);
}
