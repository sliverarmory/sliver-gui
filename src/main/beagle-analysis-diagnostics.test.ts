// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeBeagleAnalysisDiagnostics, parseBeagleAnalysisDiagnostics } from "./beagle-analysis-diagnostics.js";

function choice(computer = "computer") {
  return { computer, suffix: "-544", relationship_kind: "AdminTo", selected_group: `${computer}-544`,
    candidate_groups: { [`${computer}-544`]: ["selected-member"], "builtin-544": ["other-member"] } };
}

describe("Beagle analysis diagnostics", () => {
  it("preserves the chosen group and separate direct memberships from analyze and ingest envelopes", () => {
    const expected = { version: 1, errors: [], localGroupAmbiguities: [{ computer: "computer", suffix: "-544", relationshipKind: "AdminTo", selectedGroup: "computer-544",
      candidateGroups: [{ objectid: "computer-544", directMembers: ["selected-member"] }, { objectid: "builtin-544", directMembers: ["other-member"] }] }] };
    const report = { local_group_ambiguities: [choice()] };
    expect(normalizeBeagleAnalysisDiagnostics(report)).toEqual(expected);
    expect(normalizeBeagleAnalysisDiagnostics({ analysis: report, ingest: {} })).toEqual(expected);
    expect(parseBeagleAnalysisDiagnostics(expected)).toEqual(expected);
  });

  it("accepts all four native local privilege kinds and empty direct memberships", () => {
    for (const [suffix, kind] of [["-544", "AdminTo"], ["-580", "CanPSRemote"], ["-562", "ExecuteDCOM"], ["-555", "CanRDP"]]) {
      const report = { local_group_ambiguities: [{ computer: "pc", suffix, relationship_kind: kind, selected_group: `pc${suffix}`, candidate_groups: { [`pc${suffix}`]: [], [`builtin${suffix}`]: [] } }] };
      expect(normalizeBeagleAnalysisDiagnostics(report).localGroupAmbiguities[0]?.relationshipKind).toBe(kind);
      expect(normalizeBeagleAnalysisDiagnostics(report).errors).toEqual([]);
    }
  });

  it("distinguishes a valid clean report from unavailable or unsupported diagnostics", () => {
    expect(normalizeBeagleAnalysisDiagnostics({ analysis: { local_group_ambiguities: [] } })).toEqual({ version: 1, localGroupAmbiguities: [], errors: [] });
    for (const report of [null, {}, { analysis: null }, { analysis: {} }, { local_group_ambiguities: "missing" }]) {
      expect(normalizeBeagleAnalysisDiagnostics(report).errors.length).toBeGreaterThan(0);
    }
    expect(parseBeagleAnalysisDiagnostics({ version: 2, localGroupAmbiguities: [], errors: [] }).errors).not.toEqual([]);
  });

  it("preserves valid choices while reporting malformed membership, identity, selection and privilege data", () => {
    const invalid = [
      { ...choice(), selected_group: "unknown-544" },
      { ...choice(), relationship_kind: "CanRDP" },
      { ...choice(), candidate_groups: { "computer-544": ["member", "member"], "builtin-544": [] } },
      { ...choice(), candidate_groups: { "computer-544": ["bad\nidentity"], "builtin-544": [] } },
      { ...choice(), candidate_groups: { "computer-544": [], "builtin-555": [] } },
      { ...choice(), candidate_groups: { "computer-544": [] } },
    ];
    const result = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: [choice("good"), ...invalid] });
    expect(result.localGroupAmbiguities).toHaveLength(1);
    expect(result.localGroupAmbiguities[0]?.computer).toBe("good");
    expect(result.errors).toHaveLength(invalid.length);
  });

  it("never silently truncates oversized choices or members", () => {
    const result = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: Array.from({ length: 101 }, (_, index) => choice(`computer-${index}`)) });
    expect(result.localGroupAmbiguities).toHaveLength(100);
    expect(result.errors).toEqual([expect.stringContaining("additional choices were omitted")]);
    const oversized = { ...choice(), candidate_groups: { "computer-544": Array.from({ length: 251 }, (_, index) => `user-${index}`), "builtin-544": [] } };
    const members = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: [oversized, choice("good")] });
    expect(members.localGroupAmbiguities).toHaveLength(1);
    expect(members.errors).toEqual([expect.stringContaining("could not be shown completely")]);
  });

  it("bounds total retained strings and validation errors", () => {
    const members = Array.from({ length: 250 }, (_, index) => `user-${index}-${"x".repeat(490)}`);
    const oversized = Array.from({ length: 5 }, (_, index) => ({ ...choice(`pc${index}`), candidate_groups: { [`pc${index}-544`]: members, "builtin-544": members } }));
    const result = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: oversized });
    expect(result.localGroupAmbiguities).toHaveLength(1);
    expect(result.errors).toContain("Analysis diagnostics exceed the display size limit; some choices were omitted.");
    const failures = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: Array.from({ length: 100 }, () => null) });
    expect(failures.errors).toHaveLength(16);
    expect(failures.errors.at(-1)).toContain("Additional diagnostic validation errors");
  });

  it("rejects duplicate ambiguities and revalidates persisted warnings without treating them as clean", () => {
    const normalized = normalizeBeagleAnalysisDiagnostics({ local_group_ambiguities: [choice(), choice()] });
    expect(normalized.localGroupAmbiguities).toHaveLength(1);
    expect(parseBeagleAnalysisDiagnostics(normalized)).toEqual(normalized);
    expect(parseBeagleAnalysisDiagnostics({ ...normalized, errors: [null] }).errors).toEqual(["Stored analysis diagnostics contain an invalid error message."]);
    const duplicate = normalized.localGroupAmbiguities[0]!;
    expect(parseBeagleAnalysisDiagnostics({ version: 1, errors: [], localGroupAmbiguities: [{ ...duplicate, candidateGroups: [duplicate.candidateGroups[0], duplicate.candidateGroups[0]] }] }).errors).not.toEqual([]);
  });
});
