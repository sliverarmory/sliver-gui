// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assertBeagleRuleLabels, normalizeBeagleRulePreview } from "./beagle-rules.js";
import { parseBeagleRuleConfiguration } from "../shared/beagle-rules.js";

const preview = { selected: { Tag_Owned: ["user"] }, counts: { Tag_Owned: 2 }, missing_objectids: ["missing"], missing_total: 1, truncated: true };
describe("Beagle native rule reports", () => {
  it("preserves exact counts while identifying bounded samples", () => {
    expect(normalizeBeagleRulePreview(preview)).toEqual({ selected: { Tag_Owned: ["user"] }, counts: { Tag_Owned: 2 }, missingObjectids: ["missing"], missingTotal: 1, truncated: true });
  });
  it.each([
    { ...preview, truncated: false }, { ...preview, counts: { Tag_Owned: 0 } },
    { ...preview, counts: { Tag_Other: 2 } }, { ...preview, missing_total: 0 },
    { ...preview, selected: { Tag_Owned: ["user", "user"] } },
    { ...preview, selected: { Tag_Owned: Array.from({ length: 101 }, (_, i) => String(i)) } },
  ])("rejects inconsistent reports %# instead of claiming a complete preview", (input) => { expect(() => normalizeBeagleRulePreview(input)).toThrow(); });
  it("permits built-ins, observed labels and prior saved rules only", () => {
    const config = (label: string) => parseBeagleRuleConfiguration({ groups: [{ label, seeds: [] }] });
    expect(() => assertBeagleRuleLabels(config("Tag_Owned"), [], { groups: [] })).not.toThrow();
    expect(() => assertBeagleRuleLabels(config("Tag_Existing"), ["Tag_Existing"], { groups: [] })).not.toThrow();
    expect(() => assertBeagleRuleLabels(config("Tag_Saved"), [], config("Tag_Saved"))).not.toThrow();
    expect(() => assertBeagleRuleLabels(config("Tag_New"), [], { groups: [] })).toThrow("already present");
  });
});
