import { Toast, toast } from "@heroui/react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BEAGLE_RESULT_LIMITS, BEAGLE_SEARCH_PAGE_SIZE, type BeagleAPI, type BeagleNeighborhoodResult, type BeagleNode, type BeagleQueryResult, type BeagleSearchResult, type BeagleState } from "../../../shared/beagle-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import { BEAGLE_PATH_EDGE_KINDS } from "../../../shared/beagle-investigations";
import { emptyBeagleWorkspace, type BeagleWorkspace } from "../../../shared/beagle-workspace";
import { BeagleWindowApp } from "../BeagleWindowApp";
import { queryStorageKey, type BeagleSelection } from "./beagle-model";

vi.mock("./BeagleGraph", () => ({
  NodeIcon: () => <span aria-hidden="true">Object</span>,
  BeagleGraph: ({ result, onSelect }: { result: BeagleQueryResult; onSelect: (value: BeagleSelection) => void }) => <div aria-label="Active Directory graph">
    {result.graph.nodes.map((node) => <button key={node.objectid} onClick={() => onSelect({ kind: "node", id: node.objectid })}>Graph {node.properties["name"] as string}</button>)}
    {result.graph.edges.map((edge) => <button key={edge.id} onClick={() => onSelect({ kind: "edge", id: edge.id })}>Edge {edge.kind}</button>)}
  </div>,
}));

const projectA = "11111111-1111-4111-8111-111111111111";
const projectB = "22222222-2222-4222-8222-222222222222";
const userNode: BeagleNode = { objectid: "S-1-5-21-1000", labels: ["Base", "User"], properties: { name: "ARYA@NORTH.SEVENKINGDOMS.LOCAL", enabled: true, owned: false } };
const groupNode: BeagleNode = { objectid: "S-1-5-21-512", labels: ["Group", "Base"], properties: { name: "DOMAIN ADMINS@NORTH.SEVENKINGDOMS.LOCAL", system_tags: "admin_tier_0" } };
let currentState: BeagleState;
let workspaces = new Map<string, BeagleWorkspace>();
let api: ReturnType<typeof createAPI>;
function graphResult(projectId = projectA): BeagleQueryResult {
  return { projectId, columns: ["p"], rows: [{ p: "one path" }], elapsedMs: 8, totalRows: 1, truncated: false,
    limits: { rows: 5_000, nodes: 1_500, edges: 3_000 }, graph: { nodes: [userNode, groupNode], edges: [{ id: "edge-1", source: userNode.objectid, target: groupNode.objectid, kind: "MemberOf", properties: {}, derived: null }] } };
}
function scalarResult(value = 42, projectId = projectA): BeagleQueryResult {
  return { ...graphResult(projectId), columns: ["count"], rows: [{ count: value }], graph: { nodes: [], edges: [] } };
}
function searchResult(nodes: BeagleNode[] = [userNode, groupNode], offset = 0, hasMore = false, projectId = projectA): BeagleSearchResult {
  return { ...graphResult(projectId), graph: { nodes, edges: [] }, totalRows: nodes.length,
    page: { offset, limit: BEAGLE_SEARCH_PAGE_SIZE, hasMore } };
}
function neighborhoodResult(value = graphResult(), offset = 0, total = value.totalRows, view = "relationships"): BeagleNeighborhoodResult {
  return { ...value, objectid: userNode.objectid, view, page: { offset, limit: 250, total, hasMore: offset + value.totalRows < total } };
}
function createAPI() {
  return {
    getState: vi.fn<BeagleAPI["getState"]>(async () => ({ ok: true as const, value: currentState })),
    createProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    selectProject: vi.fn(async ({ id }: { id: string }) => { currentState = { ...currentState, selectedProjectId: id }; return { ok: true as const, value: currentState }; }),
    chooseBinary: vi.fn(async () => ({ ok: true as const, value: currentState })),
    importFiles: vi.fn<BeagleAPI["importFiles"]>(async () => ({ ok: true as const, value: { state: currentState, report: { imported: 100 } } })),
    analyze: vi.fn<BeagleAPI["analyze"]>(async () => ({ ok: true as const, value: { state: currentState, report: { derived: 25 } } })),
    query: vi.fn<BeagleAPI["query"]>(async () => ({ ok: true as const, value: graphResult() })),
    getQueries: vi.fn<BeagleAPI["getQueries"]>(async () => ({ ok: true as const, value: [{ id: "tier-zero", name: "Tier Zero principals", description: "Find privileged directory objects.", category: "Active Directory", cypher: "MATCH (n) WHERE n.name = $name RETURN n", parameters: ["name"] }] })),
    runSavedQuery: vi.fn<BeagleAPI["runSavedQuery"]>(async () => ({ ok: true as const, value: graphResult() })),
    search: vi.fn<BeagleAPI["search"]>(async () => ({ ok: true as const, value: searchResult() })),
    entity: vi.fn<BeagleAPI["entity"]>(async () => ({ ok: true as const, value: graphResult() })),
    neighborhood: vi.fn<BeagleAPI["neighborhood"]>(async () => ({ ok: true as const, value: neighborhoodResult() })),
    paths: vi.fn<BeagleAPI["paths"]>(async () => ({ ok: true as const, value: graphResult() })),
    tag: vi.fn<BeagleAPI["tag"]>(async () => ({ ok: true as const, value: { state: currentState, report: {} } })),
    compose: vi.fn<BeagleAPI["compose"]>(async () => ({ ok: true as const, value: graphResult() })),
    exportGraph: vi.fn(async () => ({ ok: true as const, value: { cancelled: false } })),
    renameProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    archiveProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    restoreArchivedProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    cleanup: vi.fn(async () => ({ ok: true as const, value: { state: currentState, report: {} } })),
    setRetention: vi.fn(async () => ({ ok: true as const, value: currentState })),
    backupProject: vi.fn(async () => ({ ok: true as const, value: { cancelled: false } })),
    restoreProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    getWorkspace: vi.fn<BeagleAPI["getWorkspace"]>(async () => ({ ok: true as const, value: workspaces.get(currentState.selectedProjectId) ?? emptyBeagleWorkspace(currentState.selectedProjectId) })),
    saveWorkspace: vi.fn<BeagleAPI["saveWorkspace"]>(async ({ workspace }) => { workspaces.set(workspace.projectId, workspace); return { ok: true as const, value: workspace }; }),
    importQueries: vi.fn<BeagleAPI["importQueries"]>(async () => ({ ok: true as const, value: { cancelled: false, queries: [] } })),
    exportQueries: vi.fn(async () => ({ ok: true as const, value: { cancelled: false } })),
    exportResult: vi.fn<BeagleAPI["exportResult"]>(async () => ({ ok: true as const, value: { cancelled: false } })),
    relayTargets: vi.fn<BeagleAPI["relayTargets"]>(async () => ({ ok: true as const, value: graphResult() })),
    aclOrigins: vi.fn<BeagleAPI["aclOrigins"]>(async () => ({ ok: true as const, value: graphResult() })),
    getRules: vi.fn(async () => ({ ok: true as const, value: { groups: [] } })),
    previewRules: vi.fn(async () => ({ ok: true as const, value: { selected: {}, counts: {}, missingObjectids: [], missingTotal: 0, truncated: false } })),
    applyRules: vi.fn<BeagleAPI["applyRules"]>(async () => ({ ok: true as const, value: { state: currentState, report: {} } })),
    getOperation: vi.fn<BeagleAPI["getOperation"]>(async () => ({ ok: true as const, value: null })),
    cancelOperation: vi.fn(async () => ({ ok: true as const, value: { cancelled: true } })),
    getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
    onApplicationSettingsChanged: vi.fn(() => () => undefined),
  } satisfies BeagleAPI;
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "hasPointerCapture", { configurable: true, value: () => false });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const key of ["getAnimations", "setPointerCapture", "releasePointerCapture", "hasPointerCapture"]) Reflect.deleteProperty(Element.prototype, key);
});
beforeEach(() => {
  currentState = { runtime: { available: true, version: "1.0", source: "/test/beagle" }, selectedProjectId: projectA,
    projects: [{ id: projectA, name: "GOAD", createdAt: "2026-10-23" }, { id: projectB, name: "Other lab", createdAt: "2026-10-23" }],
    stats: { nodes: 100, edges: 250, labels: { Base: 100, User: 50, Group: 50 }, relationships: { MemberOf: 250 } } };
  workspaces = new Map();
  api = createAPI();
  Object.defineProperty(window, "beagle", { configurable: true, value: api });
  localStorage.clear();
});
afterEach(() => { cleanup(); toast.clear(); Reflect.deleteProperty(window, "beagle"); vi.restoreAllMocks(); });

function renderApp() { return render(<><BeagleWindowApp /><Toast.Provider maxVisibleToasts={4} placement="bottom" /></>); }
async function mount() { renderApp(); await screen.findByText("Beagle ready"); }
async function openDiagnostics() {
  await userEvent.click(screen.getByRole("button", { name: /^Analysis diagnostics/ }));
  return screen.findByRole("dialog", { name: "Analysis diagnostics" });
}
async function closeDialog(name: string) {
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name })).not.toBeInTheDocument());
}

describe("BeagleWindowApp", () => {
  it("runs real bridge queries with JSON parameters and renders scalar rows", async () => {
    api.query.mockResolvedValue({ ok: true, value: scalarResult() });
    await mount();
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n:User) WHERE n.enabled = $enabled RETURN count(n) AS count" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"enabled":true}' } });
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(api.query).toHaveBeenCalledWith({ cypher: "MATCH (n:User) WHERE n.enabled = $enabled RETURN count(n) AS count", parameters: { enabled: true } });
    const table = await screen.findByRole("table", { name: "Cypher results" });
    expect(within(table).getByText("42")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Table" })).toHaveAttribute("aria-selected", "true");
  });

  it("rejects non-object query parameters before invoking the backend", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: "[1,2]" } });
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alertdialog", { name: /Parameters must be a JSON object/ })).toBeVisible();
    expect(api.query).not.toHaveBeenCalled();
  });

  it("loads the official catalog query and executes it using its stable ID", async () => {
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    await userEvent.click(await screen.findByRole("button", { name: /Load query Tier Zero principals/ }));
    expect(screen.getByLabelText("Cypher query")).toHaveValue("MATCH (n) WHERE n.name = $name RETURN n");
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"name":"DOMAIN ADMINS"}' } });
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(api.runSavedQuery).toHaveBeenCalledWith({ id: "tier-zero", parameters: { name: "DOMAIN ADMINS" } }));
    expect(api.query).not.toHaveBeenCalled();
  });

  it("saves and reloads named queries per project", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Saved query name"), { target: { value: "Enabled users" } });
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n:User) RETURN n" } });
    await userEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(workspaces.get(projectA)?.queries[0]?.name).toBe("Enabled users"));
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "RETURN 1" } });
    await userEvent.click(screen.getByRole("button", { name: "Enabled users" }));
    expect(screen.getByLabelText("Cypher query")).toHaveValue("MATCH (n:User) RETURN n");
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enabled users" })).not.toBeInTheDocument());
    expect(localStorage.getItem(queryStorageKey(projectB))).toBeNull();
  });

  it("searches objects, marks ownership, selects path endpoints and runs all-shortest paths", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "arya" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: `Inspect ${userNode.properties["name"]}` }));
    expect(api.search).toHaveBeenCalledWith({ term: "arya", offset: 0 });
    await userEvent.click(screen.getByRole("switch", { name: "Owned" }));
    await waitFor(() => expect(api.tag).toHaveBeenCalledWith({ objectid: userNode.objectid, tag: "owned", enabled: true }));
    await userEvent.click(screen.getByRole("button", { name: "Set source" }));
    expect(screen.getByRole("combobox", { name: "Source object ID" })).toHaveValue(userNode.objectid);
    fireEvent.change(screen.getByRole("combobox", { name: "Target object ID" }), { target: { value: groupNode.objectid } });
    fireEvent.change(screen.getByRole("combobox", { name: "Path mode" }), { target: { value: "all" } });
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    await waitFor(() => expect(api.paths).toHaveBeenCalledWith({ source: userNode.objectid, target: groupNode.objectid, all: true, maxHops: 12, relationshipKinds: [...BEAGLE_PATH_EDGE_KINDS] }));
  });

  it("discards query results that finish after a project switch", async () => {
    let resolveQuery!: (result: OperationResult<BeagleQueryResult>) => void;
    api.query.mockReturnValue(new Promise((resolve) => { resolveQuery = resolve; }));
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(api.selectProject).toHaveBeenCalledWith({ id: projectB }));
    await act(async () => resolveQuery({ ok: true, value: scalarResult(987654321) }));
    expect(screen.queryByText("987654321")).not.toBeInTheDocument();
    expect(screen.queryByRole("table", { name: "Cypher results" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB);
  });

  it("loads search pages on demand and replaces the displayed page", async () => {
    const first = Array.from({ length: BEAGLE_SEARCH_PAGE_SIZE }, (_, index): BeagleNode => ({
      objectid: `search-${index}`, labels: ["User"], properties: { name: `Search user ${index}` },
    }));
    api.search.mockImplementation(async ({ offset = 0 }) => ({ ok: true, value: offset === 0
      ? searchResult(first, 0, true) : searchResult([userNode], BEAGLE_SEARCH_PAGE_SIZE) }));
    await mount();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "user" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Objects 1–100 · More available")).toBeVisible();
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Previous search results" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next search results" }));
    expect(await screen.findByText("Objects 101–101 · End of results")).toBeVisible();
    expect(api.search).toHaveBeenLastCalledWith({ term: "user", offset: BEAGLE_SEARCH_PAGE_SIZE });
    expect(screen.queryByRole("button", { name: "Inspect Search user 0" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next search results" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Previous search results" }));
    expect(await screen.findByText("Objects 1–100 · More available")).toBeVisible();
    expect(api.search).toHaveBeenCalledTimes(3);
    expect(api.search).toHaveBeenLastCalledWith({ term: "user", offset: 0 });
  });

  it("resets pagination when the search changes and discards the old pending page", async () => {
    let resolvePage!: (result: OperationResult<BeagleSearchResult>) => void;
    api.search.mockResolvedValueOnce({ ok: true, value: searchResult([userNode], 0, true) });
    api.search.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    api.search.mockResolvedValueOnce({ ok: true, value: searchResult([groupNode]) });
    await mount();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "arya" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next search results" }));
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "admins" } });
    expect(screen.queryByRole("navigation", { name: "Search results pages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Inspect ${userNode.properties["name"]}` })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("button", { name: `Inspect ${groupNode.properties["name"]}` })).toBeVisible();
    expect(api.search).toHaveBeenLastCalledWith({ term: "admins", offset: 0 });
    await act(async () => resolvePage({ ok: true, value: searchResult([userNode], BEAGLE_SEARCH_PAGE_SIZE) }));
    expect(screen.getByText("Objects 1–1 · End of results")).toBeVisible();
    expect(screen.queryByRole("button", { name: `Inspect ${userNode.properties["name"]}` })).not.toBeInTheDocument();
  });

  it("clears search pagination on project changes and ignores the previous project's page", async () => {
    let resolvePage!: (result: OperationResult<BeagleSearchResult>) => void;
    api.search.mockResolvedValueOnce({ ok: true, value: searchResult([userNode], 0, true) });
    api.search.mockImplementationOnce(() => new Promise((resolve) => { resolvePage = resolve; }));
    api.search.mockResolvedValueOnce({ ok: true, value: searchResult([groupNode], 0, false, projectB) });
    await mount();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "arya" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next search results" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    expect(screen.getByLabelText("Find an object")).toHaveValue("");
    await act(async () => resolvePage({ ok: true, value: searchResult([userNode], BEAGLE_SEARCH_PAGE_SIZE) }));
    expect(screen.queryByRole("navigation", { name: "Search results pages" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Inspect ${userNode.properties["name"]}` })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "admins" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByRole("button", { name: `Inspect ${groupNode.properties["name"]}` })).toBeVisible();
    expect(api.search).toHaveBeenLastCalledWith({ term: "admins", offset: 0 });
  });

  it("retains the current search page when loading the next page fails", async () => {
    api.search.mockResolvedValueOnce({ ok: true, value: searchResult([userNode], 0, true) });
    api.search.mockResolvedValueOnce({ ok: false, error: "Search timed out" });
    await mount();
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "arya" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Next search results" }));
    expect(await screen.findByRole("alertdialog", { name: "Search timed out" })).toBeVisible();
    expect(screen.getByText("Objects 1–1 · More available")).toBeVisible();
    expect(screen.getByRole("button", { name: `Inspect ${userNode.properties["name"]}` })).toBeVisible();
    expect(screen.getByRole("button", { name: "Next search results" })).toBeEnabled();
  });

  it("blocks graph additions at the shared object limit while existing objects remain inspectable", async () => {
    const nodes = [userNode, ...Array.from({ length: BEAGLE_RESULT_LIMITS.nodes - 2 }, (_, index): BeagleNode => ({
      objectid: `graph-${index}`, labels: ["User"], properties: { name: `Graph user ${index}` },
    }))];
    const last: BeagleNode = { objectid: "last-graph-slot", labels: ["User"], properties: { name: "Last graph slot" } };
    const extra: BeagleNode = { objectid: "outside-graph", labels: ["User"], properties: { name: "Outside graph" } };
    api.query.mockResolvedValue({ ok: true, value: { ...graphResult(), graph: { nodes, edges: [] } } });
    api.search.mockResolvedValue({ ok: true, value: searchResult([last, extra, userNode]) });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("button", { name: `Graph Graph user ${BEAGLE_RESULT_LIMITS.nodes - 3}` });
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "user" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await userEvent.click(await screen.findByRole("button", { name: "Inspect Last graph slot" }));
    expect(screen.getByRole("button", { name: "Graph Last graph slot" })).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Inspect Outside graph" }));
    const limitToast = await screen.findByRole("alertdialog", { name: /The graph display limit is 1,500 objects/ });
    expect(limitToast).toBeVisible();
    const graph = screen.getByLabelText("Active Directory graph");
    expect(within(graph).getAllByRole("button")).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
    expect(within(graph).queryByRole("button", { name: "Graph Outside graph" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Inspect ${userNode.properties["name"]}` }));
    expect(screen.getByRole("heading", { name: "Object details" })).toBeVisible();
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: /The graph display limit is 1,500 objects/ })).not.toBeInTheDocument());
    expect(within(graph).getAllByRole("button")).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
  });

  it("omits expanded relationships when their endpoints exceed the graph object limit", async () => {
    const nodes = [userNode, ...Array.from({ length: BEAGLE_RESULT_LIMITS.nodes - 2 }, (_, index): BeagleNode => ({
      objectid: `graph-${index}`, labels: ["User"], properties: { name: `Graph user ${index}` },
    }))];
    const retained: BeagleNode = { objectid: "retained-neighbor", labels: ["Group"], properties: { name: "Retained neighbor" } };
    const omitted: BeagleNode = { objectid: "omitted-neighbor", labels: ["Group"], properties: { name: "Omitted neighbor" } };
    api.query.mockResolvedValueOnce({ ok: true, value: { ...graphResult(), graph: { nodes, edges: [] } } });
    api.neighborhood.mockResolvedValueOnce({ ok: true, value: neighborhoodResult({ ...graphResult(), graph: { nodes: [userNode, retained, omitted], edges: [
      { id: "retained-edge", source: userNode.objectid, target: retained.objectid, kind: "MemberOf", properties: {}, derived: null },
      { id: "omitted-edge", source: userNode.objectid, target: omitted.objectid, kind: "GenericAll", properties: {}, derived: null },
    ] } }) });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    await userEvent.click(screen.getByRole("button", { name: "Expand relationships" }));
    expect(await screen.findByRole("button", { name: "Graph Retained neighbor" })).toBeVisible();
    const graph = screen.getByLabelText("Active Directory graph");
    expect(within(graph).getAllByRole("button", { name: /^Graph /u })).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
    expect(within(graph).getByRole("button", { name: "Edge MemberOf" })).toBeVisible();
    expect(within(graph).queryByRole("button", { name: "Graph Omitted neighbor" })).not.toBeInTheDocument();
    expect(within(graph).queryByRole("button", { name: "Edge GenericAll" })).not.toBeInTheDocument();
    expect(screen.getByText(/Results reached a display limit/u)).toBeVisible();
  });

  it("keeps query errors visible without inventing data", async () => {
    api.query.mockResolvedValue({ ok: false, error: "Cypher syntax error near WRONG" });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("alertdialog", { name: "Cypher syntax error near WRONG" })).toBeVisible();
    expect(screen.queryByRole("table", { name: "Cypher results" })).not.toBeInTheDocument();
  });

  it("pages a complete neighborhood on demand and merges each bounded page", async () => {
    const nextNode: BeagleNode = { objectid: "next-neighbor", labels: ["Group"], properties: { name: "Next neighbor" } };
    const first = neighborhoodResult({ ...graphResult(), totalRows: 250 }, 0, 251);
    const last = neighborhoodResult({ ...graphResult(), graph: { nodes: [userNode, nextNode], edges: [] } }, 250, 251);
    api.neighborhood.mockImplementation(async ({ offset = 0 }) => ({ ok: true, value: offset ? last : first }));
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    expect(api.neighborhood).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Expand relationships" }));
    expect(await screen.findByText("Relationships 1–250 of 251 · More available")).toBeVisible();
    expect(api.neighborhood).toHaveBeenCalledTimes(1);
    expect(api.neighborhood).toHaveBeenCalledWith({ objectid: userNode.objectid, view: "relationships", offset: 0 });
    expect(screen.getByRole("button", { name: "Previous investigation results" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Next investigation results" }));
    expect(await screen.findByText("Relationships 251–251 of 251 · End of results")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next investigation results" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Graph Next neighbor" })).toBeVisible();
    expect(screen.getByRole("button", { name: `Graph ${groupNode.properties["name"]}` })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Previous investigation results" }));
    expect(await screen.findByText("Relationships 1–250 of 251 · More available")).toBeVisible();
    expect(api.neighborhood).toHaveBeenCalledTimes(3);
  });

  it("offers kind-specific investigations and fetches only the chosen view", async () => {
    api.neighborhood.mockResolvedValue({ ok: true, value: neighborhoodResult(graphResult(), 0, 1, "user-member_of") });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    const selector = screen.getByRole("combobox", { name: "Investigation" });
    expect(within(selector).getByRole("option", { name: "Member Of" })).toBeInTheDocument();
    expect(within(selector).queryByRole("option", { name: "Local Admins" })).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: "user-member_of" } });
    expect(api.neighborhood).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Show member of" }));
    expect(await screen.findByText("Objects 1–1 of 1 · End of results")).toBeVisible();
    expect(api.neighborhood).toHaveBeenCalledWith({ objectid: userNode.objectid, view: "user-member_of", offset: 0 });
    fireEvent.change(selector, { target: { value: "relationships" } });
    expect(screen.queryByRole("navigation", { name: "Investigation pages" })).not.toBeInTheDocument();
  });

  it("shows an empty page when the investigation total shrinks below the requested offset", async () => {
    api.neighborhood.mockResolvedValueOnce({ ok: true, value: neighborhoodResult({ ...graphResult(), totalRows: 250 }, 0, 251) });
    api.neighborhood.mockResolvedValueOnce({ ok: true, value: neighborhoodResult({ ...graphResult(), totalRows: 0, rows: [], graph: { nodes: [], edges: [] } }, 250, 200) });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    await userEvent.click(screen.getByRole("button", { name: "Expand relationships" }));
    await screen.findByText("Relationships 1–250 of 251 · More available");
    await userEvent.click(screen.getByRole("button", { name: "Next investigation results" }));
    expect(await screen.findByText("No results on this page · 200 relationships total · End of results")).toBeVisible();
    expect(screen.queryByText(/251–200/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous investigation results" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next investigation results" })).toBeDisabled();
  });

  it.each(["selection", "project", "query"] as const)("discards a neighborhood response after a newer %s", async (change) => {
    let resolvePage!: (result: OperationResult<BeagleNeighborhoodResult>) => void;
    api.neighborhood.mockReturnValue(new Promise((resolve) => { resolvePage = resolve; }));
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    await userEvent.click(screen.getByRole("button", { name: "Expand relationships" }));
    if (change === "selection") await userEvent.click(screen.getByRole("button", { name: `Graph ${groupNode.properties["name"]}` }));
    else if (change === "project") {
      fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
      await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    } else {
      api.query.mockResolvedValue({ ok: true, value: scalarResult(123456) });
      await userEvent.click(screen.getByRole("button", { name: "Run query" }));
      await screen.findByText("123456");
    }
    const late: BeagleNode = { objectid: "late", labels: ["Group"], properties: { name: "Outdated neighbor" } };
    await act(async () => resolvePage({ ok: true, value: neighborhoodResult({ ...graphResult(), graph: { nodes: [userNode, late], edges: [] } }) }));
    expect(screen.queryByRole("button", { name: "Graph Outdated neighbor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Investigation pages" })).not.toBeInTheDocument();
    if (change === "query") expect(screen.getByText("123456")).toBeVisible();
  });

  it("sends ordered waypoints and selected edge types to traversal", async () => {
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source object ID" }), { target: { value: "source-id" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Target object ID" }), { target: { value: "target-id" } });
    await userEvent.click(screen.getByRole("button", { name: "Add waypoint" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Via 1 object ID" }), { target: { value: "first-via" } });
    await userEvent.click(screen.getByRole("button", { name: "Add waypoint" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Via 2 object ID" }), { target: { value: "second-via" } });
    expect(screen.getByRole("button", { name: "Add waypoint" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Move Via 2 object ID up" }));
    await userEvent.click(screen.getByRole("button", { name: /^Relationship types/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear types" }));
    expect(screen.getByRole("button", { name: "Find paths" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "MemberOf" }));
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    expect(screen.getByRole("combobox", { name: "Via 1 object ID" })).toHaveValue("second-via");
    expect(screen.getByRole("checkbox", { name: "MemberOf" })).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    expect(api.paths).toHaveBeenLastCalledWith({ source: "source-id", target: "target-id", via: ["second-via", "first-via"], relationshipKinds: ["MemberOf"], all: false, maxHops: 12 });
    await userEvent.click(screen.getByRole("button", { name: "Reverse route" }));
    expect(screen.getByRole("combobox", { name: "Source object ID" })).toHaveValue("target-id");
    expect(screen.getByRole("combobox", { name: "Via 1 object ID" })).toHaveValue("first-via");
    await userEvent.click(screen.getByRole("button", { name: "Remove via 2" }));
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    expect(api.paths).toHaveBeenLastCalledWith({ source: "target-id", target: "source-id", via: ["first-via"], relationshipKinds: ["MemberOf"], all: false, maxHops: 12 });
    await userEvent.click(screen.getByRole("button", { name: "Select all types" }));
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    expect(api.paths).toHaveBeenLastCalledWith({ source: "target-id", target: "source-id", via: ["first-via"], relationshipKinds: [...BEAGLE_PATH_EDGE_KINDS], all: false, maxHops: 12 });
    expect(api.paths.mock.lastCall?.[0].relationshipKinds).toHaveLength(62);
    expect(api.paths.mock.lastCall?.[0].relationshipKinds).toContain("ProtectAdminGroups");
    expect(api.paths.mock.lastCall?.[0].relationshipKinds).not.toContain("CanApplyGPO");
  });

  it("autocompletes path endpoints with explicit additional search pages", async () => {
    const first = Array.from({ length: 100 }, (_, index): BeagleNode => ({ objectid: `endpoint-${index}`, labels: ["User"], properties: { name: `Endpoint user ${index}` } }));
    api.search.mockImplementation(async ({ offset = 0 }) => ({ ok: true, value: offset ? searchResult([userNode], 100) : searchResult(first, 0, true) }));
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    const source = screen.getByRole("combobox", { name: "Source object ID" });
    await userEvent.type(source, "user");
    await screen.findByRole("option", { name: /Endpoint user 0/ });
    expect(api.search).toHaveBeenCalledTimes(1);
    expect(api.search).toHaveBeenCalledWith({ term: "user", offset: 0 });
    await userEvent.click(screen.getByRole("button", { name: "Load more source object id matches" }));
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith({ term: "user", offset: 100 }));
    await userEvent.click(source);
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.click(await screen.findByRole("option", { name: new RegExp(String(userNode.properties["name"]).replaceAll(".", "\\.")) }));
    expect(source).toHaveValue(userNode.objectid);
    fireEvent.change(screen.getByRole("combobox", { name: "Target object ID" }), { target: { value: groupNode.objectid } });
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    expect(api.paths).toHaveBeenCalledWith({ source: userNode.objectid, target: groupNode.objectid, all: false, maxHops: 12, relationshipKinds: [...BEAGLE_PATH_EDGE_KINDS] });
  });

  it("drops stale endpoint autocomplete after a new term and project switch", async () => {
    let resolveOld!: (result: OperationResult<BeagleSearchResult>) => void;
    api.search.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    api.search.mockResolvedValue({ ok: true, value: searchResult([groupNode]) });
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    const source = screen.getByRole("combobox", { name: "Source object ID" });
    await userEvent.type(source, "arya");
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    await userEvent.clear(source);
    await userEvent.type(source, "admins");
    await screen.findByRole("option", { name: /DOMAIN ADMINS/ });
    await act(async () => resolveOld({ ok: true, value: searchResult([userNode]) }));
    expect(screen.queryByRole("option", { name: /ARYA/ })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    fireEvent.change(await screen.findByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    expect(screen.getByRole("combobox", { name: "Source object ID" })).toHaveValue("");
    expect(screen.queryByRole("option", { name: /DOMAIN ADMINS/ })).not.toBeInTheDocument();
  });

  it("ignores an endpoint search that completes after switching projects", async () => {
    let resolveSearch!: (result: OperationResult<BeagleSearchResult>) => void;
    api.search.mockReturnValue(new Promise((resolve) => { resolveSearch = resolve; }));
    await mount();
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    await userEvent.type(screen.getByRole("combobox", { name: "Source object ID" }), "arya");
    await waitFor(() => expect(api.search).toHaveBeenCalledTimes(1));
    await userEvent.keyboard("{Escape}");
    fireEvent.change(await screen.findByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    await act(async () => resolveSearch({ ok: true, value: searchResult([userNode]) }));
    expect(screen.queryByRole("option", { name: /ARYA/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Source object ID" })).toHaveValue("");
  });

  it.each([
    ["Inspect affected computer", userNode.objectid],
    [`Inspect group ${groupNode.objectid}`, groupNode.objectid],
  ])("keeps analysis choices available through queries and closes the dialog for %s", async (button, objectid) => {
    currentState = { ...currentState, diagnostics: { version: 1, errors: [], localGroupAmbiguities: [{
      computer: userNode.objectid, suffix: "-544", relationshipKind: "AdminTo", selectedGroup: groupNode.objectid,
      candidateGroups: [{ objectid: groupNode.objectid, directMembers: [userNode.objectid] }, { objectid: "other-group", directMembers: [] }],
    }] } };
    await mount();
    expect(screen.queryByRole("dialog", { name: "Analysis diagnostics" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Analysis diagnostics/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` });
    const diagnostics = await openDiagnostics();
    await userEvent.click(within(diagnostics).getByRole("button", { name: `AdminTo on ${userNode.objectid}` }));
    await userEvent.click(within(diagnostics).getByRole("button", { name: button }));
    await waitFor(() => expect(api.entity).toHaveBeenCalledWith({ objectid }));
    expect(await screen.findByRole("heading", { name: "Object details" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Analysis diagnostics" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Analysis diagnostics/ })).toBeVisible();
    expect(await openDiagnostics()).toHaveTextContent("1 ambiguous local-group choice");
  });

  it("uses the native import/export bridges and shows the import report", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Import data" }));
    await waitFor(() => expect(api.importFiles).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(await screen.findByRole("dialog", { name: "Operation report" })).toHaveTextContent('"imported": 100');
    await closeDialog("Operation report");
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(api.exportGraph).toHaveBeenCalledTimes(1));
  });

  it.each(["Analyze", "Import data"] as const)("refreshes persisted uncertainty after failed %s and retains the operation error", async (button) => {
    currentState = { ...currentState, diagnostics: { version: 1, localGroupAmbiguities: [], errors: [] } };
    await mount();
    expect(screen.queryByRole("dialog", { name: "Analysis diagnostics" })).not.toBeInTheDocument();
    const action = button === "Analyze" ? api.analyze : api.importFiles;
    action.mockImplementationOnce(async () => {
      currentState = { ...currentState, diagnostics: { version: 1, localGroupAmbiguities: [], errors: ["Analysis failed after replacing derived edges."] } };
      return { ok: false, error: "Native analysis process exited with code 1" };
    });
    await userEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(api.getState).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("alertdialog", { name: "Native analysis process exited with code 1" })).toBeVisible();
    expect(await openDiagnostics()).toHaveTextContent("Analysis failed after replacing derived edges.");
    expect(screen.queryByText(/finished\./)).not.toBeInTheDocument();
  });

  it.each(["failure", "other-project"] as const)("keeps uncertainty and the original failure when recovery returns %s", async (recovery) => {
    currentState = { ...currentState, diagnostics: { version: 1, errors: [], localGroupAmbiguities: [{
      computer: userNode.objectid, suffix: "-544", relationshipKind: "AdminTo", selectedGroup: groupNode.objectid,
      candidateGroups: [{ objectid: groupNode.objectid, directMembers: [] }, { objectid: "old-candidate", directMembers: [] }],
    }] } };
    await mount();
    expect(await openDiagnostics()).toHaveTextContent("1 ambiguous local-group choice");
    await closeDialog("Analysis diagnostics");
    api.analyze.mockRejectedValueOnce(new Error("Original analysis error"));
    if (recovery === "failure") api.getState.mockRejectedValueOnce(new Error("Refresh also failed"));
    else api.getState.mockResolvedValueOnce({ ok: true, value: { ...currentState, selectedProjectId: projectB, diagnostics: { version: 1, errors: [], localGroupAmbiguities: [] } } });
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
    expect(screen.getByRole("alertdialog", { name: "Original analysis error" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectA);
    expect(await openDiagnostics()).toHaveTextContent("The latest import or analysis did not complete. Run Analyze to verify this project.");
    expect(screen.queryByText("1 ambiguous local-group choice")).not.toBeInTheDocument();
    expect(screen.queryByText("Refresh also failed")).not.toBeInTheDocument();
  });

  it("shows failed import uncertainty even when the project was previously empty", async () => {
    currentState = { ...currentState, stats: { nodes: 0, edges: 0, labels: {}, relationships: {} }, diagnostics: { version: 1, errors: [], localGroupAmbiguities: [] } };
    await mount();
    api.importFiles.mockResolvedValueOnce({ ok: false, error: "Import failed" });
    api.getState.mockResolvedValueOnce({ ok: false, error: "Could not refresh project" });
    await userEvent.click(screen.getByRole("button", { name: "Import collection" }));
    expect(await screen.findByRole("alertdialog", { name: "Import failed" })).toBeVisible();
    expect(await openDiagnostics()).toHaveTextContent("The latest import or analysis did not complete. Run Analyze to verify this project.");
    expect(screen.queryByText("Could not refresh project")).not.toBeInTheDocument();
  });

  it("retains the last operation report after dismissing its toast and saving a query", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Import data" }));
    const notice = await screen.findByRole("alertdialog", { name: "Import finished." });
    await userEvent.click(within(notice).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Import finished." })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "View last report" }));
    expect(await screen.findByRole("dialog", { name: "Operation report" })).toHaveTextContent('"imported": 100');
    await closeDialog("Operation report");
    fireEvent.change(screen.getByLabelText("Saved query name"), { target: { value: "GOAD memberships" } });
    await userEvent.click(screen.getByRole("button", { name: "Save query" }));
    expect(await screen.findByRole("alertdialog", { name: "Saved “GOAD memberships” in this project." })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "Operation report" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "View last report" }));
    expect(await screen.findByRole("dialog", { name: "Operation report" })).toHaveTextContent('"imported": 100');
  });

  it("loads edge composition without mislabeling unknown origins", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: "Edge MemberOf" }));
    expect(screen.queryByText("Collected relationship")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show composition" }));
    await waitFor(() => expect(api.compose).toHaveBeenCalledWith({ source: userNode.objectid, target: groupNode.objectid, kind: "MemberOf" }));
    expect(await screen.findByRole("button", { name: "Open composition graph" })).toBeVisible();
  });

  it("offers native runtime selection when Beagle is unavailable", async () => {
    currentState.runtime = { available: false, version: null, source: null, error: "Beagle executable not found" };
    renderApp();
    await screen.findByText("Backend unavailable");
    const dialog = await screen.findByRole("dialog", { name: "Beagle runtime settings" });
    expect(dialog).toHaveTextContent("Beagle executable not found");
    await closeDialog("Beagle runtime settings");
    expect(screen.getByRole("button", { name: "Run query" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Beagle runtime settings" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Beagle runtime settings" })).getByRole("button", { name: "Choose Beagle" }));
    expect(api.chooseBinary).toHaveBeenCalledTimes(1);
  });

  it("reloads the query catalog after selecting an available runtime", async () => {
    const available = currentState;
    currentState = { ...currentState, runtime: { available: false, version: null, source: null, error: "Choose Beagle" } };
    api.getQueries.mockResolvedValueOnce({ ok: false, error: "Runtime unavailable" });
    api.chooseBinary.mockResolvedValue({ ok: true, value: available });
    renderApp();
    await screen.findByText("Backend unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Choose Beagle" }));
    await waitFor(() => expect(api.getQueries).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Beagle runtime settings" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    expect(await screen.findByRole("button", { name: "Load query Tier Zero principals" })).toBeVisible();
  });

  it("refreshes authoritative entity tags after removing legacy ownership", async () => {
    const owned = { ...userNode, labels: ["Base", "User", "Tag_Owned"], properties: { ...userNode.properties, owned: true, system_tags: "owned" } };
    api.query.mockResolvedValue({ ok: true, value: { ...graphResult(), graph: { nodes: [owned], edges: [] } } });
    api.entity.mockResolvedValue({ ok: true, value: { ...graphResult(), graph: { nodes: [{ ...owned, labels: ["Base", "User"], properties: { ...owned.properties, system_tags: "" } }], edges: [] } } });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    expect(screen.getByRole("switch", { name: "Owned" })).toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Owned" }));
    await waitFor(() => expect(api.entity).toHaveBeenCalledWith({ objectid: owned.objectid }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Owned" })).not.toBeChecked());
    expect(api.tag).toHaveBeenCalledWith({ objectid: owned.objectid, tag: "owned", enabled: false });
  });

  it("opens analysis reports from a success toast without moving or remounting the query workspace", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    const graph = await screen.findByLabelText("Active Directory graph");
    const workspace = screen.getByRole("region", { name: "Query workspace" });
    const editor = screen.getByLabelText("Cypher query");
    fireEvent.change(editor, { target: { value: "MATCH (n:User) RETURN n" } });
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const notice = await screen.findByRole("alertdialog", { name: "Analysis finished." });
    expect(workspace).not.toContainElement(notice);
    expect(screen.queryByRole("dialog", { name: "Operation report" })).not.toBeInTheDocument();
    await userEvent.click(within(notice).getByRole("button", { name: "View report" }));
    const report = await screen.findByRole("dialog", { name: "Operation report" });
    expect(report).toHaveTextContent('"derived": 25');
    expect(workspace).not.toContainElement(report);
    await closeDialog("Operation report");
    expect(screen.getByRole("region", { name: "Query workspace" })).toBe(workspace);
    expect(screen.getByLabelText("Cypher query")).toBe(editor);
    expect(editor).toHaveValue("MATCH (n:User) RETURN n");
    expect(screen.getByLabelText("Active Directory graph")).toBe(graph);
    expect(document.querySelector(".beagle-message, .beagle-inline-panel")).toBeNull();
  });

  it("shows search failure in a dismissible toast while retaining the investigation", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    const graph = await screen.findByLabelText("Active Directory graph");
    const workspace = screen.getByRole("region", { name: "Query workspace" });
    const editor = screen.getByLabelText("Cypher query");
    api.search.mockResolvedValueOnce({ ok: false, error: "Directory search failed" });
    fireEvent.change(screen.getByLabelText("Find an object"), { target: { value: "arya" } });
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    const error = await screen.findByRole("alertdialog", { name: "Directory search failed" });
    expect(workspace).not.toContainElement(error);
    expect(document.querySelector(".beagle-message, .beagle-inline-panel")).toBeNull();
    await userEvent.click(within(error).getByRole("button", { name: /close/i }));
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Directory search failed" })).not.toBeInTheDocument());
    expect(screen.getByLabelText("Active Directory graph")).toBe(graph);
    expect(screen.getByLabelText("Cypher query")).toBe(editor);
  });

  it("creates projects from a modal and allows cancellation without changing the workspace", async () => {
    await mount();
    const workspace = screen.getByRole("region", { name: "Query workspace" });
    const editor = screen.getByLabelText("Cypher query");
    fireEvent.change(editor, { target: { value: "RETURN 17" } });
    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    let dialog = await screen.findByRole("dialog", { name: "New project" });
    expect(workspace).not.toContainElement(dialog);
    expect(within(dialog).getByRole("button", { name: "Create project" })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), { target: { value: "Cancelled lab" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument());
    expect(api.createProject).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Cypher query")).toBe(editor);
    expect(editor).toHaveValue("RETURN 17");
    await userEvent.click(screen.getByRole("button", { name: "New project" }));
    dialog = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Project name" }), { target: { value: "  Fresh lab  " } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Create project" }));
    await waitFor(() => expect(api.createProject).toHaveBeenCalledWith({ name: "Fresh lab" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New project" })).not.toBeInTheDocument());
    expect(document.querySelector(".beagle-message, .beagle-inline-panel")).toBeNull();
  });

  it("keeps project tools in a separate modal with data and rules tabs", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    const graph = await screen.findByLabelText("Active Directory graph");
    const workspace = screen.getByRole("region", { name: "Query workspace" });
    const editor = screen.getByLabelText("Cypher query");
    await userEvent.click(screen.getByRole("button", { name: "Project tools" }));
    const dialog = await screen.findByRole("dialog", { name: "Project tools" });
    expect(workspace).not.toContainElement(dialog);
    expect(within(dialog).getByRole("tab", { name: "Project data" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(within(dialog).getByRole("tab", { name: "Asset group rules" }));
    expect(within(dialog).getByRole("tab", { name: "Asset group rules" })).toHaveAttribute("aria-selected", "true");
    expect(await within(dialog).findByRole("button", { name: "Preview all rules" })).toBeEnabled();
    await closeDialog("Project tools");
    expect(screen.getByLabelText("Active Directory graph")).toBe(graph);
    expect(screen.getByLabelText("Cypher query")).toBe(editor);
    expect(document.querySelector(".beagle-message, .beagle-inline-panel")).toBeNull();
  });

  it.each([false, true])("distinguishes unchecked and clean diagnostics in the modal (checked=%s)", async (checked) => {
    if (checked) currentState = { ...currentState, diagnostics: { version: 1, errors: [], localGroupAmbiguities: [] } };
    await mount();
    const workspace = screen.getByRole("region", { name: "Query workspace" });
    expect(screen.queryByRole("dialog", { name: "Analysis diagnostics" })).not.toBeInTheDocument();
    const dialog = await openDiagnostics();
    expect(workspace).not.toContainElement(dialog);
    expect(dialog).toHaveTextContent(checked ? "No analysis warnings were reported." : "Analysis choices have not been checked. Run Analyze to check this project.");
    await closeDialog("Analysis diagnostics");
    expect(screen.getByRole("region", { name: "Query workspace" })).toBe(workspace);
  });

  it("removes report notifications and the last report when switching projects", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    const notice = await screen.findByRole("alertdialog", { name: "Analysis finished." });
    const action = within(notice).getByRole("button", { name: "View report" });
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    fireEvent.click(action);
    expect(screen.queryByRole("dialog", { name: "Operation report" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View last report" })).toBeDisabled();
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Analysis finished." })).not.toBeInTheDocument());
  });
});

describe("persistent investigations", () => {
  it("migrates legacy queries once and preserves portable descriptions, categories and parameters", async () => {
    localStorage.setItem(queryStorageKey(projectA), JSON.stringify([{ id: "legacy", name: "Legacy query", cypher: "RETURN $value", parameters: '{"value":7}' }]));
    await mount();
    await waitFor(() => expect(workspaces.get(projectA)?.legacyMigrated).toBe(true));
    expect(workspaces.get(projectA)?.queries[0]).toMatchObject({ id: "legacy", category: "My queries", description: "", parameters: '{"value":7}' });
    fireEvent.change(screen.getByLabelText("Saved query name"), { target: { value: "Portable query" } });
    fireEvent.change(screen.getByLabelText("Saved query category"), { target: { value: "Access review" } });
    fireEvent.change(screen.getByLabelText("Saved query description"), { target: { value: "Review the specified identity." } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"name":"Arya"}' } });
    await userEvent.click(screen.getByRole("button", { name: "Save query" }));
    await waitFor(() => expect(workspaces.get(projectA)?.queries[0]?.description).toBe("Review the specified identity."));
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    await userEvent.click(screen.getByRole("button", { name: "Export queries" }));
    expect(api.exportQueries).toHaveBeenCalledWith({ queries: workspaces.get(projectA)?.queries });
    api.importQueries.mockResolvedValueOnce({ ok: true, value: { cancelled: false, queries: [{ id: "legacy", name: "Imported", description: "From CE", category: "Imported", cypher: "RETURN 1", parameters: "{}" }] } });
    await userEvent.click(screen.getByRole("button", { name: "Import queries" }));
    await waitFor(() => expect(workspaces.get(projectA)?.queries).toHaveLength(3));
    expect(workspaces.get(projectA)?.queries[2]?.id).not.toBe("legacy");
    cleanup();
    renderApp();
    await waitFor(() => expect(api.getWorkspace).toHaveBeenCalledTimes(2));
    expect(workspaces.get(projectA)?.queries.filter((query) => query.id === "legacy")).toHaveLength(1);
  });

  it("restores executed query inputs, selected object and ordered path filters with back/forward and reopen", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n:Domain) RETURN n" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"checkpoint":1}' } });
    await userEvent.click(screen.getByRole("tab", { name: "Paths" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Source object ID" }), { target: { value: userNode.objectid } });
    fireEvent.change(screen.getByRole("combobox", { name: "Target object ID" }), { target: { value: groupNode.objectid } });
    await userEvent.click(screen.getByRole("button", { name: "Add waypoint" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Via 1 object ID" }), { target: { value: "waypoint" } });
    await userEvent.click(screen.getByRole("button", { name: /Relationship types/ }));
    await userEvent.click(screen.getByRole("button", { name: "Clear types" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "MemberOf" }));
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await userEvent.click(await screen.findByRole("button", { name: `Graph ${userNode.properties["name"]}` }));
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "RETURN $checkpoint AS count" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"checkpoint":123}' } });
    fireEvent.change(screen.getByRole("combobox", { name: "Via 1 object ID" }), { target: { value: "different-waypoint" } });
    await userEvent.click(screen.getByRole("button", { name: "Select all types" }));
    api.query.mockResolvedValueOnce({ ok: true, value: scalarResult(123) });
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByText("123");
    await userEvent.click(screen.getByRole("button", { name: "Back in investigation" }));
    expect(screen.getByLabelText("Cypher query")).toHaveValue("MATCH (n:Domain) RETURN n");
    expect(screen.getByLabelText("Query parameters")).toHaveValue('{"checkpoint":1}');
    expect(screen.getByRole("combobox", { name: "Via 1 object ID" })).toHaveValue("waypoint");
    expect(screen.getByRole("button", { name: /Relationship types \(1\/62\)/ })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Object details" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Forward in investigation" }));
    expect(await screen.findByText("123")).toBeVisible();
    expect(screen.getByLabelText("Cypher query")).toHaveValue("RETURN $checkpoint AS count");
    expect(screen.getByLabelText("Query parameters")).toHaveValue('{"checkpoint":123}');
    expect(screen.getByRole("combobox", { name: "Via 1 object ID" })).toHaveValue("different-waypoint");
    await waitFor(() => expect(workspaces.get(projectA)?.history.index).toBe(1));
    cleanup(); renderApp();
    expect(await screen.findByText("123")).toBeVisible();
    expect(screen.getByLabelText("Cypher query")).toHaveValue("RETURN $checkpoint AS count");
    expect(screen.getByLabelText("Query parameters")).toHaveValue('{"checkpoint":123}');
    expect(screen.getByRole("button", { name: "Forward in investigation" })).toBeDisabled();
    expect(screen.getByText(/Resumed the last investigation/)).toBeVisible();
    expect(api.query).toHaveBeenCalledTimes(2);
  });

  it("records inputs at execution time when the editor changes before the result arrives", async () => {
    let resolve!: (value: OperationResult<BeagleQueryResult>) => void;
    api.query.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await mount();
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "RETURN $checkpoint AS count" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: '{"checkpoint":77}' } });
    await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    fireEvent.change(screen.getByLabelText("Cypher query"), { target: { value: "MATCH (n) RETURN n" } });
    fireEvent.change(screen.getByLabelText("Query parameters"), { target: { value: "{}" } });
    await act(async () => resolve({ ok: true, value: scalarResult(77) }));
    await waitFor(() => expect(workspaces.get(projectA)?.history.entries[0]?.editor).toMatchObject({ cypher: "RETURN $checkpoint AS count", parameters: '{"checkpoint":77}' }));
    expect(screen.getByLabelText("Cypher query")).toHaveValue("MATCH (n) RETURN n");
    cleanup(); renderApp();
    expect(await screen.findByText("77")).toBeVisible();
    expect(screen.getByLabelText("Cypher query")).toHaveValue("RETURN $checkpoint AS count");
    expect(screen.getByLabelText("Query parameters")).toHaveValue('{"checkpoint":77}');
  });

  it("exports only the current result and passes selected table columns and sorting to main", async () => {
    api.query.mockResolvedValueOnce({ ok: true, value: { ...scalarResult(), columns: ["name", "count"], rows: [{ name: "Alpha", count: 9 }, { name: "Beta", count: 2 }] } });
    await mount(); await userEvent.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("table");
    await userEvent.click(screen.getByRole("button", { name: "Sort by count" }));
    await userEvent.click(screen.getByRole("button", { name: "Columns (2/2)" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "name" }));
    await userEvent.click(screen.getByRole("button", { name: "Export table CSV" }));
    expect(api.exportResult).toHaveBeenLastCalledWith(expect.objectContaining({ format: "csv", columns: ["count"], sort: { column: "count", direction: "asc" } }));
    await userEvent.click(screen.getByRole("button", { name: "Export result JSON" }));
    expect(api.exportResult).toHaveBeenLastCalledWith(expect.objectContaining({ format: "json", result: expect.objectContaining({ rows: [{ name: "Alpha", count: 9 }, { name: "Beta", count: 2 }] }) }));
    expect(api.exportGraph).not.toHaveBeenCalled();
  });

  it("ignores workspace loading from an old project", async () => {
    let resolve!: (value: OperationResult<BeagleWorkspace>) => void;
    api.getWorkspace.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await mount();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectB));
    await act(async () => resolve({ ok: true, value: { ...emptyBeagleWorkspace(projectA), queries: [{ id: "old", name: "Old project query", description: "", category: "", cypher: "RETURN 1", parameters: "{}" }] } }));
    await userEvent.click(screen.getByRole("tab", { name: "Queries" }));
    expect(screen.queryByRole("button", { name: "Old project query" })).not.toBeInTheDocument();
    expect(api.saveWorkspace.mock.calls.every(([input]) => input.projectId === projectB)).toBe(true);
  });
});

describe("operation controls", () => {
  it("keeps project tools open during a rule operation and exposes its matching cancellation", async () => {
    let resolve!: (value: Awaited<ReturnType<BeagleAPI["applyRules"]>>) => void;
    api.applyRules.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    api.getOperation.mockResolvedValue({ ok: true, value: { id: "rule-op", label: "Applying rules", phase: "Deriving relationships", startedAt: 123, cancellable: true } });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Project tools" }));
    const dialog = await screen.findByRole("dialog", { name: "Project tools" });
    await userEvent.click(within(dialog).getByRole("tab", { name: "Asset group rules" }));
    const apply = within(dialog).getByRole("button", { name: "Save and apply rules" });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.click(apply);
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel operation" })).toBeEnabled());
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Project tools" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel operation" }));
    expect(api.cancelOperation).toHaveBeenCalledWith({ id: "rule-op" });
    await act(async () => resolve({ ok: false, error: "Rule operation cancelled" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Close" })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Project tools" })).not.toBeInTheDocument());
  });

  it("shows native progress and cancels the matching operation", async () => {
    let resolve!: (value: OperationResult<{ state: BeagleState; report: {} }>) => void;
    api.analyze.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    api.getOperation.mockResolvedValue({ ok: true, value: { id: "op-123", label: "Analysis", phase: "Deriving relationships", startedAt: 123, cancellable: true } });
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("Deriving relationships")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Cancel operation" }));
    expect(api.cancelOperation).toHaveBeenCalledWith({ id: "op-123" });
    await act(async () => resolve({ ok: false, error: "Analysis cancelled" }));
    expect(await screen.findByRole("alertdialog", { name: "Analysis cancelled" })).toBeVisible();
  });
  it("keeps the current project open when investigation saving fails", async () => {
    await mount();
    api.saveWorkspace.mockResolvedValue({ ok: false, error: "Disk is full" });
    fireEvent.change(screen.getByLabelText("Saved query name"), { target: { value: "Unsaved" } });
    await userEvent.click(screen.getByRole("button", { name: "Save query" }));
    expect(await screen.findByRole("alertdialog", { name: /Disk is full/ })).toBeVisible();
    fireEvent.change(screen.getByRole("combobox", { name: "Project" }), { target: { value: projectB } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Analyze" })).toBeEnabled());
    expect(api.selectProject).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue(projectA);
    expect(screen.getByLabelText("Saved query name")).toHaveValue("Unsaved");
  });
});

it("drops stale table sorting when a subsequent query changes the result schema", async () => {
  api.query.mockResolvedValueOnce({ ok: true, value: scalarResult(17) }).mockResolvedValueOnce({ ok: true, value: { ...scalarResult(), columns: ["name"], rows: [{ name: "Arya" }] } });
  await mount(); await userEvent.click(screen.getByRole("button", { name: "Run query" }));
  await userEvent.click(await screen.findByRole("button", { name: "Sort by count" }));
  await userEvent.click(screen.getByRole("button", { name: "Run query" }));
  await screen.findByRole("button", { name: "Sort by name" });
  await userEvent.click(screen.getByRole("button", { name: "Export table CSV" }));
  expect(api.exportResult.mock.lastCall?.[0]).not.toHaveProperty("sort");
  expect(api.exportResult.mock.lastCall?.[0].columns).toEqual(["name"]);
});
