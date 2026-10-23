import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BEAGLE_RESULT_LIMITS, BEAGLE_SEARCH_PAGE_SIZE, type BeagleAPI, type BeagleNode, type BeagleQueryResult, type BeagleSearchResult, type BeagleState } from "../../../shared/beagle-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
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
function createAPI() {
  return {
    getState: vi.fn(async () => ({ ok: true as const, value: currentState })),
    createProject: vi.fn(async () => ({ ok: true as const, value: currentState })),
    selectProject: vi.fn(async ({ id }: { id: string }) => ({ ok: true as const, value: { ...currentState, selectedProjectId: id } })),
    chooseBinary: vi.fn(async () => ({ ok: true as const, value: currentState })),
    importFiles: vi.fn(async () => ({ ok: true as const, value: { state: currentState, report: { imported: 100 } } })),
    analyze: vi.fn(async () => ({ ok: true as const, value: { state: currentState, report: { derived: 25 } } })),
    query: vi.fn<BeagleAPI["query"]>(async () => ({ ok: true as const, value: graphResult() })),
    getQueries: vi.fn<BeagleAPI["getQueries"]>(async () => ({ ok: true as const, value: [{ id: "tier-zero", name: "Tier Zero principals", description: "Find privileged directory objects.", category: "Active Directory", cypher: "MATCH (n) WHERE n.name = $name RETURN n", parameters: ["name"] }] })),
    runSavedQuery: vi.fn<BeagleAPI["runSavedQuery"]>(async () => ({ ok: true as const, value: graphResult() })),
    search: vi.fn<BeagleAPI["search"]>(async () => ({ ok: true as const, value: searchResult() })),
    entity: vi.fn<BeagleAPI["entity"]>(async () => ({ ok: true as const, value: graphResult() })),
    paths: vi.fn<BeagleAPI["paths"]>(async () => ({ ok: true as const, value: graphResult() })),
    tag: vi.fn<BeagleAPI["tag"]>(async () => ({ ok: true as const, value: { state: currentState, report: {} } })),
    compose: vi.fn<BeagleAPI["compose"]>(async () => ({ ok: true as const, value: graphResult() })),
    exportGraph: vi.fn(async () => ({ ok: true as const, value: { cancelled: false } })),
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
  api = createAPI();
  Object.defineProperty(window, "beagle", { configurable: true, value: api });
  localStorage.clear();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "beagle"); vi.restoreAllMocks(); });

async function mount() { render(<BeagleWindowApp />); await screen.findByText("Beagle ready"); }

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
    expect(await screen.findByRole("alert")).toHaveTextContent("Parameters must be a JSON object");
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
    expect(localStorage.getItem(queryStorageKey(projectA))).toContain("Enabled users");
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
    expect(screen.getByLabelText("Source object ID")).toHaveValue(userNode.objectid);
    fireEvent.change(screen.getByLabelText("Target object ID"), { target: { value: groupNode.objectid } });
    fireEvent.change(screen.getByRole("combobox", { name: "Path mode" }), { target: { value: "all" } });
    await userEvent.click(screen.getByRole("button", { name: "Find paths" }));
    await waitFor(() => expect(api.paths).toHaveBeenCalledWith({ source: userNode.objectid, target: groupNode.objectid, all: true, maxHops: 12 }));
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Search timed out");
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
    expect(screen.getByRole("alert")).toHaveTextContent("The graph display limit is 1,500 objects");
    const graph = screen.getByLabelText("Active Directory graph");
    expect(within(graph).getAllByRole("button")).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
    expect(within(graph).queryByRole("button", { name: "Graph Outside graph" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: `Inspect ${userNode.properties["name"]}` }));
    expect(screen.getByRole("heading", { name: "Object details" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(within(graph).getAllByRole("button")).toHaveLength(BEAGLE_RESULT_LIMITS.nodes);
  });

  it("omits expanded relationships when their endpoints exceed the graph object limit", async () => {
    const nodes = [userNode, ...Array.from({ length: BEAGLE_RESULT_LIMITS.nodes - 2 }, (_, index): BeagleNode => ({
      objectid: `graph-${index}`, labels: ["User"], properties: { name: `Graph user ${index}` },
    }))];
    const retained: BeagleNode = { objectid: "retained-neighbor", labels: ["Group"], properties: { name: "Retained neighbor" } };
    const omitted: BeagleNode = { objectid: "omitted-neighbor", labels: ["Group"], properties: { name: "Omitted neighbor" } };
    api.query.mockResolvedValueOnce({ ok: true, value: { ...graphResult(), graph: { nodes, edges: [] } } });
    api.query.mockResolvedValueOnce({ ok: true, value: { ...graphResult(), graph: { nodes: [userNode, retained, omitted], edges: [
      { id: "retained-edge", source: userNode.objectid, target: retained.objectid, kind: "MemberOf", properties: {}, derived: null },
      { id: "omitted-edge", source: userNode.objectid, target: omitted.objectid, kind: "GenericAll", properties: {}, derived: null },
    ] } } });
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
    expect(await screen.findByRole("alert")).toHaveTextContent("Cypher syntax error near WRONG");
    expect(screen.queryByRole("table", { name: "Cypher results" })).not.toBeInTheDocument();
  });

  it("uses the native import/export bridges and shows the import report", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Import data" }));
    await waitFor(() => expect(api.importFiles).toHaveBeenCalledTimes(1));
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(screen.getByLabelText("Operation report")).toHaveTextContent('"imported": 100');
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(api.exportGraph).toHaveBeenCalledTimes(1));
  });

  it("clears an old operation report when a saved-query notice replaces it", async () => {
    await mount();
    await userEvent.click(screen.getByRole("button", { name: "Import data" }));
    await userEvent.click(await screen.findByRole("button", { name: "View report" }));
    expect(screen.getByLabelText("Operation report")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Saved query name"), { target: { value: "GOAD memberships" } });
    await userEvent.click(screen.getByRole("button", { name: "Save query" }));
    expect(screen.getByText("Saved “GOAD memberships” in this project.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /report/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Operation report")).not.toBeInTheDocument();
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
    render(<BeagleWindowApp />);
    await screen.findByText("Backend unavailable");
    expect(await screen.findByText("Beagle executable not found")).toBeVisible();
    expect(screen.getByRole("button", { name: "Run query" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Choose Beagle" }));
    expect(api.chooseBinary).toHaveBeenCalledTimes(1);
  });

  it("reloads the query catalog after selecting an available runtime", async () => {
    const available = currentState;
    currentState = { ...currentState, runtime: { available: false, version: null, source: null, error: "Choose Beagle" } };
    api.getQueries.mockResolvedValueOnce({ ok: false, error: "Runtime unavailable" });
    api.chooseBinary.mockResolvedValue({ ok: true, value: available });
    render(<BeagleWindowApp />);
    await screen.findByText("Backend unavailable");
    await userEvent.click(screen.getByRole("button", { name: "Choose Beagle" }));
    await waitFor(() => expect(api.getQueries).toHaveBeenCalledTimes(2));
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
});
