export type BeagleRuleExpansion = "none" | "all" | "children" | "parents";
export interface BeagleRuleSeed { type: "objectid" | "cypher"; value: string }
export interface BeagleAssetGroup {
  label: string;
  seeds: BeagleRuleSeed[];
  expansion: BeagleRuleExpansion;
  exclusions: string[];
  tier: boolean;
  enabled: boolean;
  /** Lower priorities win overlapping tier membership; equal priorities retain list order. */
  priority: number;
}
export interface BeagleAssetGroupConfiguration { groups: BeagleAssetGroup[] }
export type BeagleRuleConfiguration = BeagleAssetGroupConfiguration;
export interface BeagleRulesInput { configuration: BeagleRuleConfiguration }
export interface BeagleRulePreview {
  selected: Record<string, string[]>;
  counts: Record<string, number>;
  missingObjectids: string[];
  missingTotal: number;
  truncated: boolean;
}
export const BEAGLE_RULE_LIMITS = Object.freeze({ groups: 32, seeds: 128, exclusions: 1_024, bytes: 262_144, preview: 100 });
export const BEAGLE_RULE_LABEL = /^Tag_[A-Za-z0-9_]{1,124}$/u;

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Object.keys(value).some((key) => !fields.includes(key))) throw new TypeError("Invalid Beagle rule configuration");
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, multiline = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u : /[\x00-\x1f\x7f]/u).test(value)) throw new TypeError("Invalid Beagle rule text");
  return value;
}
/** Also accepts older native configurations, retaining their original order and defaults. */
export function parseBeagleRuleConfiguration(value: unknown): BeagleRuleConfiguration {
  const input = object(value, ["groups"]);
  if (!Array.isArray(input["groups"]) || input["groups"].length > BEAGLE_RULE_LIMITS.groups) throw new TypeError("A project supports at most 32 label rules");
  const labels = new Set<string>();
  const groups = input["groups"].map((entry: unknown): BeagleAssetGroup => {
    const group = object(entry, ["label", "seeds", "expansion", "exclusions", "tier", "enabled", "priority"]);
    const label = text(group["label"], 128);
    if (!BEAGLE_RULE_LABEL.test(label) || labels.has(label)) throw new TypeError("Label rules need distinct Tag_ labels");
    labels.add(label);
    if (!Array.isArray(group["seeds"]) || group["seeds"].length > BEAGLE_RULE_LIMITS.seeds) throw new TypeError("A label rule supports at most 128 selectors");
    const seeds = group["seeds"].map((item: unknown): BeagleRuleSeed => {
      const seed = object(item, ["type", "value"]);
      const type = seed["type"];
      if (type !== "objectid" && type !== "cypher") throw new TypeError("Invalid Beagle selector type");
      return { type, value: text(seed["value"], type === "cypher" ? 65_536 : 512, type === "cypher") };
    });
    const expansion = group["expansion"] ?? "none";
    if (expansion !== "none" && expansion !== "all" && expansion !== "children" && expansion !== "parents") throw new TypeError("Invalid Beagle rule expansion");
    const exclusions = group["exclusions"] ?? [];
    if (!Array.isArray(exclusions) || exclusions.length > BEAGLE_RULE_LIMITS.exclusions) throw new TypeError("A label rule supports at most 1,024 exclusions");
    const tier = group["tier"] ?? false;
    const enabled = group["enabled"] ?? true;
    const priority = group["priority"] ?? 0;
    if (typeof tier !== "boolean" || typeof enabled !== "boolean" || typeof priority !== "number" || !Number.isSafeInteger(priority) || priority < 0 || priority > 1_000_000) throw new TypeError("Invalid Beagle rule enablement or priority");
    return { label, seeds, expansion, exclusions: [...new Set(exclusions.map((id: unknown) => text(id, 512)))], tier, enabled, priority };
  });
  const configuration = { groups };
  if (new TextEncoder().encode(JSON.stringify(configuration)).byteLength > BEAGLE_RULE_LIMITS.bytes) throw new TypeError("Beagle rule configuration exceeds 256 KiB");
  return configuration;
}
export function parseBeagleRulesInput(value: unknown): BeagleRulesInput {
  const input = object(value, ["configuration"]);
  return { configuration: parseBeagleRuleConfiguration(input["configuration"]) };
}
export function beagleRuleLabels(labels: readonly string[], configuration: BeagleRuleConfiguration): string[] {
  return [...new Set(["Tag_Owned", "Tag_Tier_Zero", ...labels, ...configuration.groups.map((group) => group.label)])].filter((label) => BEAGLE_RULE_LABEL.test(label)).sort();
}
