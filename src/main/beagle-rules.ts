import { BEAGLE_RULE_LABEL, BEAGLE_RULE_LIMITS, beagleRuleLabels, type BeagleRuleConfiguration, type BeagleRulePreview } from "../shared/beagle-rules.js";

/** Existing project labels and saved rules are editable; this flow does not create arbitrary zones. */
export function assertBeagleRuleLabels(configuration: BeagleRuleConfiguration, labels: readonly string[], saved: BeagleRuleConfiguration): void {
  const allowed = new Set(beagleRuleLabels(labels, saved));
  if (configuration.groups.some((group) => !allowed.has(group.label))) throw new TypeError("Choose a label already present in this project");
}
export function normalizeBeagleRulePreview(value: unknown): BeagleRulePreview {
  function record(item: unknown): Record<string, unknown> {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Invalid Beagle rule preview");
    return item as Record<string, unknown>;
  }
  function count(item: unknown): number {
    if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw new TypeError("Invalid Beagle rule preview count");
    return item;
  }
  function ids(item: unknown): string[] {
    if (!Array.isArray(item) || item.length > BEAGLE_RULE_LIMITS.preview || item.some((id: unknown) => typeof id !== "string" || !id.trim() || id.length > 512 || /[\x00-\x1f\x7f]/u.test(id))) throw new TypeError("Invalid Beagle rule preview identities");
    const values = item as string[];
    if (new Set(values).size !== values.length) throw new TypeError("Duplicate Beagle rule preview identity");
    return [...values];
  }
  const input = record(value);
  const nativeSelected = record(input["selected"]);
  const nativeCounts = record(input["counts"]);
  const labels = Object.keys(nativeSelected);
  if (labels.length > BEAGLE_RULE_LIMITS.groups || labels.length !== Object.keys(nativeCounts).length || labels.some((label) => !BEAGLE_RULE_LABEL.test(label))) throw new TypeError("Invalid Beagle rule preview labels");
  const selected: Record<string, string[]> = {};
  const counts: Record<string, number> = {};
  let shortened = false;
  for (const label of labels) {
    selected[label] = ids(nativeSelected[label]); counts[label] = count(nativeCounts[label]);
    if (counts[label]! < selected[label]!.length) throw new TypeError("Inconsistent Beagle rule preview count");
    shortened ||= counts[label]! > selected[label]!.length;
  }
  const missingObjectids = ids(input["missing_objectids"]);
  const missingTotal = count(input["missing_total"]);
  if (missingTotal < missingObjectids.length || typeof input["truncated"] !== "boolean") throw new TypeError("Inconsistent Beagle rule preview truncation");
  shortened ||= missingTotal > missingObjectids.length;
  if (input["truncated"] !== shortened) throw new TypeError("Inconsistent Beagle rule preview truncation");
  return { selected, counts, missingObjectids, missingTotal, truncated: shortened };
}
