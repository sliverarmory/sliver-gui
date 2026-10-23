// @vitest-environment node
import { describe, expect, it } from "vitest";
import { beagleImportRecord } from "./beagle-project-data.js";
import { emptyBeagleProjectData, parseBeagleProjectData } from "../shared/beagle-projects.js";

describe("collection provenance", () => {
  it("distinguishes successful, failed and unknown probes and preserves bounded warning totals", () => {
    const record = beagleImportRecord("replace", [{ name: "range.zip", sha256: "a".repeat(64), bytes: 42 }], {
      nodes: 814, edges: 8889, ingest: { records: 872, retainedFieldsCount: 17, warnings: ["warning"], warningsTruncated: 4,
        collectionQuality: { Sessions: { collected: 2, failed: 1, unknown: 3, failureReasons: { AccessDenied: 1 } } },
        files: [{ metadata: { collectorversion: "2.0" } }] },
    });
    expect(record).toMatchObject({ operation: "replace", status: "complete", warningCount: 5, retainedFields: 17, collectors: ["2.0"] });
    expect(record.coverage["Sessions"]).toEqual({ collected: 2, failed: 1, unknown: 3, failureReasons: { AccessDenied: 1 } });
    expect(record.coverage["LocalGroups"]?.collected).toBe(0);
    expect(parseBeagleProjectData({ ...emptyBeagleProjectData(), history: [record] }).history).toEqual([record]);
  });
  it("validates restored metadata and preserves failures without falsely reporting successful imports", () => {
    const record = beagleImportRecord("merge", [], undefined, { cancelled: true, message: "cancelled" });
    expect(record.status).toBe("cancelled");
    const data = { ...emptyBeagleProjectData(), history: [record] };
    expect(() => parseBeagleProjectData({ ...data, history: [record, record] })).toThrow("Duplicate");
    expect(() => parseBeagleProjectData({ ...data, history: [{ ...record, warningCount: undefined }] })).toThrow();
    expect(() => parseBeagleProjectData({ ...data, history: [{ ...record, coverage: { Sessions: { collected: 0, failed: 1, unknown: 0, failureReasons: { failure: -1 } } } }] })).toThrow();
    expect(() => parseBeagleProjectData({ ...data, historyLimit: 200 })).toThrow();
  });
});
