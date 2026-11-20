import { describe, expect, it } from "vitest";
import { parseBeagleRuleConfiguration, parseBeagleRulesInput } from "./beagle-rules.js";

const group = { label: "Tag_Owned", seeds: [{ type: "objectid", value: "id" }] };
describe("Beagle rule boundary", () => {
  it("loads old native defaults and preserves equal-priority order", () => {
    expect(parseBeagleRuleConfiguration({ groups: [group, { ...group, label: "Tag_Tier_Zero" }] }).groups).toEqual([
      { ...group, enabled: true, priority: 0, tier: false, exclusions: [], expansion: "none" },
      { ...group, label: "Tag_Tier_Zero", enabled: true, priority: 0, tier: false, exclusions: [], expansion: "none" },
    ]);
  });
  it("retains disabled rules, Cypher and priority without evaluating them", () => {
    const configuration = { groups: [{ ...group, enabled: false, priority: 8, tier: true, expansion: "parents", exclusions: ["a", "a"], seeds: [{ type: "cypher", value: "MATCH (n)\nRETURN n" }] }] };
    expect(parseBeagleRulesInput({ configuration }).configuration.groups[0]).toEqual({ ...configuration.groups[0], exclusions: ["a"] });
  });
  it.each([
    { groups: [group, group] }, { groups: [{ ...group, label: "Tag_bad:`)" }] },
    { groups: [{ ...group, enabled: "yes" }] }, { groups: [{ ...group, priority: -1 }] },
    { groups: [{ ...group, priority: 1.5 }] }, { groups: [{ ...group, expansion: "both" }] },
    { groups: [{ ...group, seeds: [{ type: "cypher", value: "\0bad" }] }] },
    { groups: [{ ...group, seeds: [{ type: "objectid", value: "a".repeat(513) }] }] },
    { groups: [{ ...group, exclusions: Array.from({ length: 1025 }, (_, i) => `${i}`) }] },
    { groups: [{ ...group, seeds: Array.from({ length: 129 }, () => ({ type: "objectid", value: "id" })) }] },
    { groups: [{ ...group, seeds: Array.from({ length: 5 }, () => ({ type: "cypher", value: "a".repeat(65_536) })) }] },
    { groups: [{ ...group, database: "/secret/path" }] },
  ])("rejects malformed or oversized configuration %#", (input) => {
    expect(() => parseBeagleRuleConfiguration(input)).toThrow();
  });
  it("rejects unexpected IPC fields", () => { expect(() => parseBeagleRulesInput({ configuration: { groups: [] }, path: "x" })).toThrow(); });
});
