import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BeagleAPI, BeagleEdge, BeagleQueryResult } from "../../../shared/beagle-contracts";
import { defaultBeagleGraphView, defaultBeaglePathDraft, emptyBeagleWorkspace, type BeagleHistoryEntry, type BeagleTableView } from "../../../shared/beagle-workspace";
import { BeagleResultTable, sortResultRows } from "./BeagleResultTable";
import { BeagleEdgeInspector } from "./BeagleEdgeInspector";
import { appendInvestigation } from "./useBeagleWorkspace";

afterEach(cleanup);
const project = "11111111-1111-4111-8111-111111111111";
const result: BeagleQueryResult = { projectId: project, columns: ["name", "count"], rows: [{ name: "Alpha", count: 10 }, { name: "Beta", count: 2 }],
  graph: { nodes: [{ objectid: "a", labels: ["User"], properties: { name: "Alpha" } }, { objectid: "b", labels: ["Computer"], properties: { name: "Beta" } }], edges: [] },
  totalRows: 2, elapsedMs: 1, truncated: false, limits: { rows: 5000, nodes: 1500, edges: 3000 } };
function entry(id: string): BeagleHistoryEntry { return { id, title: id, createdAt: "2026-10-23T00:00:00Z", result, selection: { kind: "node", id: "a" },
  sidebarTab: "paths", resultTab: "graph", editor: { cypher: "RETURN $n", parameters: '{"n":1}', name: "", description: "", category: "" },
  path: { ...defaultBeaglePathDraft(), source: "a", target: "b", via: ["c"], relationshipKinds: ["MemberOf"] }, graph: defaultBeagleGraphView(), table: { columns: ["name"], sort: null } }; }

describe("investigation history", () => {
  it("branches after going back and bounds the retained snapshots", () => {
    let workspace = emptyBeagleWorkspace(project);
    for (let index = 0; index < 35; index++) workspace = appendInvestigation(workspace, entry(String(index)));
    expect(workspace.history.entries).toHaveLength(30);
    expect(workspace.history.entries[0]?.id).toBe("5");
    workspace = { ...workspace, history: { ...workspace.history, index: 2 } };
    workspace = appendInvestigation(workspace, entry("branch"));
    expect(workspace.history.entries.map((item) => item.id)).toEqual(["5", "6", "7", "branch"]);
    expect(workspace.history.index).toBe(3);
    expect(workspace.history.entries[3]?.path.relationshipKinds).toEqual(["MemberOf"]);
  });
});
describe("result sharing", () => {
  it("sorts numeric values across the entire result and keeps missing values last", () => {
    expect(sortResultRows([{ count: 10 }, { count: null }, { count: 2 }, {}], { column: "count", direction: "asc" })).toEqual([{ count: 2 }, { count: 10 }, { count: null }, {}]);
    expect(sortResultRows([{ count: 2 }, { count: 10 }, { count: null }], { column: "count", direction: "desc" })).toEqual([{ count: 10 }, { count: 2 }, { count: null }]);
  });
  it("exports the selected columns and full sorted rows, including rows beyond the first page", async () => {
    const exported = vi.fn();
    const data = { ...result, rows: Array.from({ length: 60 }, (_, index) => ({ name: `Object ${index}`, count: 60 - index })) };
    function Harness() {
      const [view, setView] = useState<BeagleTableView>({ columns: [], sort: null });
      return <BeagleResultTable result={data} view={view} onViewChange={setView} onExport={exported} />;
    }
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Sort by count" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")[1]).toHaveTextContent("Object 59");
    await userEvent.click(screen.getByRole("button", { name: "Columns (2/2)" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "name" }));
    expect(screen.queryByRole("columnheader", { name: /name/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Export table CSV" }));
    expect(exported.mock.lastCall?.[0]).toEqual(["count"]);
    expect(exported.mock.lastCall?.[1]).toHaveLength(60);
    expect(exported.mock.lastCall?.[1][0]).toEqual({ name: "Object 59", count: 1 });
  });
});
describe("relationship evidence", () => {
  const base: BeagleEdge = { id: "edge", source: "a", target: "b", kind: "GenericAll", properties: {}, derived: false };
  it("only offers ACL origins for inherited ACL evidence, and opens the returned graph", async () => {
    const api = { aclOrigins: vi.fn(async () => ({ ok: true as const, value: result })) } as unknown as BeagleAPI;
    const open = vi.fn(), inspect = vi.fn();
    const { rerender } = render(<BeagleEdgeInspector edge={base} result={result} api={api} disabled={false} onOpen={open} onInspectObject={inspect} />);
    expect(screen.queryByRole("button", { name: "Show ACL origins" })).not.toBeInTheDocument();
    rerender(<BeagleEdgeInspector edge={{ ...base, properties: { isacl: true, isinherited: true, inheritancehash: "hash" } }} result={result} api={api} disabled={false} onOpen={open} onInspectObject={inspect} />);
    await userEvent.click(screen.getByRole("button", { name: "Show ACL origins" }));
    expect(api.aclOrigins).toHaveBeenCalledWith({ source: "a", target: "b", kind: "GenericAll" });
    await userEvent.click(await screen.findByRole("button", { name: "Open acl origins graph" }));
    expect(open).toHaveBeenCalledWith(result, "GenericAll acl origins");
  });
  it("discards relay-target results after selecting a different relationship", async () => {
    let resolve!: (response: { ok: true; value: BeagleQueryResult }) => void;
    const api = { relayTargets: vi.fn(() => new Promise((done) => { resolve = done; })) } as unknown as BeagleAPI;
    const props = { result, api, disabled: false, onOpen: vi.fn(), onInspectObject: vi.fn() };
    const { rerender } = render(<BeagleEdgeInspector {...props} edge={{ ...base, kind: "CoerceAndRelayNTLMToSMB" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Show relay targets" }));
    expect(api.relayTargets).toHaveBeenCalledWith({ source: "a", target: "b", kind: "CoerceAndRelayNTLMToSMB" });
    rerender(<BeagleEdgeInspector {...props} edge={{ ...base, id: "other" }} />);
    await act(async () => resolve({ ok: true, value: result }));
    expect(screen.queryByRole("button", { name: "Open relay targets graph" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show relay targets" })).not.toBeInTheDocument();
  });
});
