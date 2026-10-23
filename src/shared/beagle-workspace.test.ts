import { describe, expect, it } from "vitest";
import { BEAGLE_RESULT_LIMITS, type BeagleQueryResult } from "./beagle-contracts.js";
import { defaultBeagleGraphView, defaultBeaglePathDraft, emptyBeagleWorkspace, exportBeaglePortableQueries, parseBeaglePortableQueries, parseBeagleResultSnapshot, parseBeagleWorkspace, type BeagleHistoryEntry } from "./beagle-workspace.js";
import { parseBeagleCancelOperationInput, parseBeagleExportQueriesInput, parseBeagleExportResultInput, parseBeagleSaveWorkspaceInput } from "./beagle-workspace-inputs.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const result: BeagleQueryResult = { projectId, columns: ["name", "count"], rows: [{ name: "value", count: 1 }], graph: { nodes: [{ objectid: "one", labels: ["User"], properties: {} }], edges: [] }, elapsedMs: 1, totalRows: 1, truncated: false, limits: BEAGLE_RESULT_LIMITS };
const entry: BeagleHistoryEntry = { id: "history", title: "Query", createdAt: "2026-10-23T00:00:00.000Z", result, selection: { kind: "node", id: "one" }, sidebarTab: "queries", resultTab: "table", editor: { cypher: "RETURN 1", parameters: "{}", name: "Name", description: "Description", category: "Category" }, path: defaultBeaglePathDraft(), graph: defaultBeagleGraphView(), table: { columns: ["name"], sort: { column: "name", direction: "desc" } } };

describe("portable Beagle investigations", () => {
  it("round-trips queries without losing metadata or parameters and accepts CE query entries", () => {
    const queries = parseBeaglePortableQueries([{ name: "Users", description: "Description", category: "Category", query: "RETURN $value", parameters: { value: "quoted' value" } }]);
    expect(parseBeaglePortableQueries(exportBeaglePortableQueries(queries))).toEqual(queries);
    expect(queries[0]?.parameters).toBe('{"value":"quoted\' value"}');
  });
  it.each([[], false, 1, true])("rejects invalid parameter shape %j rather than silently dropping it", (parameters) => {
    expect(() => parseBeaglePortableQueries({ name: "Broken", query: "RETURN $value", parameters })).toThrow();
  });
  it("retains a complete bounded investigation and validates project identity", () => {
    const workspace = { ...emptyBeagleWorkspace(projectId), queries: parseBeaglePortableQueries({ name: "Query", query: "RETURN 1" }), history: { entries: [entry], index: 0 } };
    expect(parseBeagleWorkspace(workspace)).toEqual(workspace);
    expect(parseBeagleSaveWorkspaceInput({ projectId, workspace })).toEqual({ projectId, workspace });
    expect(() => parseBeagleSaveWorkspaceInput({ projectId: otherId, workspace })).toThrow("another project");
    expect(() => parseBeagleWorkspace({ ...workspace, projectId: otherId })).toThrow("another project");
    expect(() => parseBeagleWorkspace({ ...workspace, history: { entries: [entry, entry], index: 0 } })).toThrow("Duplicate investigation");
    expect(() => parseBeagleWorkspace({ ...workspace, history: { entries: [entry], index: 1 } })).toThrow();
  });
  it("rejects oversized graphs, missing endpoints, duplicate objects and unknown traversal kinds", () => {
    expect(() => parseBeagleResultSnapshot({ ...result, graph: { nodes: Array.from({ length: 1501 }, (_, i) => ({ objectid: String(i), labels: [], properties: {} })), edges: [] } })).toThrow();
    expect(() => parseBeagleResultSnapshot({ ...result, graph: { nodes: result.graph.nodes, edges: [{ id: "e", source: "one", target: "missing", kind: "MemberOf", derived: false, properties: {} }] } })).toThrow("endpoints");
    expect(() => parseBeagleResultSnapshot({ ...result, graph: { nodes: [...result.graph.nodes, ...result.graph.nodes], edges: [] } })).toThrow("Duplicate graph objects");
    expect(() => parseBeagleWorkspace({ ...emptyBeagleWorkspace(projectId), history: { entries: [{ ...entry, path: { ...entry.path, relationshipKinds: ["ArbitraryKind"] } }], index: 0 } })).toThrow();
  });
  it("limits export metadata to actual columns and forbids renderer paths", () => {
    const input = { format: "csv", title: "Result", result, columns: ["name"], sort: { column: "count", direction: "desc" } };
    expect(parseBeagleExportResultInput(input)).toEqual(input);
    for (const bad of [{ ...input, path: "/tmp/forbidden" }, { ...input, columns: ["missing"] }, { ...input, columns: ["name", "name"] }, { ...input, sort: { column: "name", direction: "arbitrary" } }]) expect(() => parseBeagleExportResultInput(bad)).toThrow();
    expect(() => parseBeagleExportQueriesInput({ queries: [], path: "/tmp/forbidden" })).toThrow();
    expect(parseBeagleCancelOperationInput({ id: projectId })).toEqual({ id: projectId });
    expect(() => parseBeagleCancelOperationInput({ id: projectId, projectId })).toThrow();
  });
});
