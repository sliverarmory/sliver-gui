import type { BeagleJsonObject, BeagleJsonValue, BeagleNode, BeagleQueryResult } from "../../../shared/beagle-contracts";

export type BeagleSelection = { kind: "node" | "edge"; id: string } | null;
export interface CustomQuery { id: string; name: string; cypher: string; parameters: string }

export function nodeName(node: BeagleNode): string {
  for (const key of ["name", "displayname", "samaccountname", "objectid"]) {
    const value = node.properties[key];
    if (typeof value === "string" && value) return value;
  }
  return node.objectid;
}

export function nodeKind(node: BeagleNode): string {
  const preferred = ["User", "Computer", "Group", "Domain", "OU", "GPO", "Container", "CertTemplate", "EnterpriseCA", "RootCA", "NTAuthStore", "AIACA", "IssuancePolicy"];
  return preferred.find((kind) => node.labels.includes(kind)) ?? node.labels.find((kind) => kind !== "Base") ?? "Object";
}

export function nodeTagged(node: BeagleNode, tag: "owned" | "admin_tier_0"): boolean {
  const tags = node.properties["system_tags"];
  // Beagle persists tag changes in system_tags and Tag_* labels. An imported
  // legacy boolean must not override an explicitly cleared system tag.
  if (typeof tags === "string") return tags.split(/\s+/u).includes(tag);
  if (Array.isArray(tags)) return tags.includes(tag);
  if (node.labels.includes(tag === "owned" ? "Tag_Owned" : "Tag_Tier_Zero")) return true;
  return node.properties[tag] === true;
}

export function displayValue(value: BeagleJsonValue | undefined): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function parseParameters(text: string): BeagleJsonObject {
  const value: unknown = JSON.parse(text.trim() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Parameters must be a JSON object, such as {\"name\": \"DOMAIN ADMINS\"}.");
  return value as BeagleJsonObject;
}

export function initialParameters(names: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(names.map((name) => [name, ""])), null, 2);
}

export function graphIdentity(result: BeagleQueryResult): string {
  return JSON.stringify({
    nodes: result.graph.nodes.map((node) => node.objectid).sort(),
    edges: result.graph.edges.map((edge) => [edge.id, edge.source, edge.target]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
  });
}

export function queryStorageKey(projectId: string): string { return `beagle.custom-queries.v1:${projectId}`; }

export function readCustomQueries(projectId: string): CustomQuery[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(queryStorageKey(projectId)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is CustomQuery => typeof entry === "object" && entry !== null &&
      typeof entry.id === "string" && typeof entry.name === "string" && typeof entry.cypher === "string" && typeof entry.parameters === "string").slice(0, 100);
  } catch { return []; }
}

export function saveCustomQueries(projectId: string, queries: CustomQuery[]): void {
  localStorage.setItem(queryStorageKey(projectId), JSON.stringify(queries.slice(0, 100)));
}
