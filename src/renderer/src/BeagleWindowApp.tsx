import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Input, Label, Spinner, Tabs, TextArea, TextField, Tooltip } from "@heroui/react";
import { CellSwitch } from "@heroui-pro/react/cell-switch";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsRotate, faBookBookmark, faCircleNodes, faCode, faDownload,
  faFolderOpen, faMagnifyingGlass, faPlay, faPlus, faSave, faSliders,
  faTrash, faUpload, faXmark,
} from "@fortawesome/free-solid-svg-icons";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import type {
  BeagleJsonObject, BeagleMutationResult, BeagleNeighborhoodResult, BeagleNode,
  BeagleQueryResult, BeagleSavedQuery, BeagleSearchResult, BeagleState,
} from "../../shared/beagle-contracts";
import { BEAGLE_RESULT_LIMITS } from "../../shared/beagle-contracts";
import type { OperationResult } from "../../shared/contracts";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { BeagleGraph, NodeIcon } from "./beagle/BeagleGraph";
import { BeagleNeighborhoodControls } from "./beagle/BeagleNeighborhoodControls";
import { BeaglePathControls } from "./beagle/BeaglePathControls";
import { BeagleAnalysisWarnings } from "./beagle/BeagleAnalysisWarnings";
import { BEAGLE_DRILLDOWNS } from "../../shared/beagle-investigations";
import {
  initialParameters, nodeKind, nodeName, nodeTagged, parseParameters,
  type BeagleSelection,
} from "./beagle/beagle-model";
import { BeagleResultTable, normalizeTableView } from "./beagle/BeagleResultTable";
import { BeagleEdgeInspector, BeagleProperties as Properties } from "./beagle/BeagleEdgeInspector";
import { useBeagleWorkspace, appendInvestigation } from "./beagle/useBeagleWorkspace";
import { BeagleProjectPanel } from "./beagle/BeagleProjectPanel";
import { BeagleRulesPanel } from "./beagle/BeagleRulesPanel";
import { defaultBeagleGraphView, defaultBeaglePathDraft, parseBeagleCustomQueries, type BeagleHistoryEntry, type BeagleTableView } from "../../shared/beagle-workspace";
import type { BeagleOperationState } from "../../shared/beagle-projects";
import "./beagle/beagle.css";

const DEFAULT_QUERY = "MATCH (n:Domain) RETURN n LIMIT 100";
type SidebarTab = "search" | "queries" | "paths";
type ResultTab = "graph" | "table" | "objects";
type QueryAction = () => Promise<OperationResult<BeagleQueryResult>>;

export function BeagleWindowApp(): React.JSX.Element {
  const api = window.beagle;
  const [state, setState] = useState<BeagleState>();
  const [catalog, setCatalog] = useState<BeagleSavedQuery[]>([]);

  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("search");
  const [resultTab, setResultTab] = useState<ResultTab>("graph");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<BeagleNode[]>([]);
  const [searchPage, setSearchPage] = useState<BeagleSearchResult["page"]>();
  const [searched, setSearched] = useState(false);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string>();
  const [queryFilter, setQueryFilter] = useState("");
  const [category, setCategory] = useState("");
  const [cypher, setCypher] = useState(DEFAULT_QUERY);
  const [parameters, setParameters] = useState("{}");
  const [queryName, setQueryName] = useState("");
  const [queryDescription, setQueryDescription] = useState("");
  const [queryCategory, setQueryCategory] = useState("");
  const [managementOpen, setManagementOpen] = useState(false);
  const [operation, setOperation] = useState<BeagleOperationState | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState<string>();
  const [queryBusy, setQueryBusy] = useState<string>();
  const [result, setResult] = useState<BeagleQueryResult>();
  const [resultTitle, setResultTitle] = useState("Query results");
  const [selection, setSelection] = useState<BeagleSelection>(null);
  const [pathDraft, setPathDraft] = useState(defaultBeaglePathDraft);
  const pathSource = pathDraft.source, pathTarget = pathDraft.target;
  const setPathSource = (source: string) => setPathDraft((previous) => ({ ...previous, source }));
  const setPathTarget = (target: string) => setPathDraft((previous) => ({ ...previous, target }));
  const [graphView, setGraphView] = useState(defaultBeagleGraphView);
  const [tableView, setTableView] = useState<BeagleTableView>({ columns: [], sort: null });
  const [neighborhood, setNeighborhood] = useState<BeagleNeighborhoodResult>();
  const [neighborhoodBusy, setNeighborhoodBusy] = useState(false);
  const [report, setReport] = useState<BeagleMutationResult["report"]>();
  const [reportOpen, setReportOpen] = useState(false);
  const generation = useRef(0);
  const querySequence = useRef(0);
  const searchSequence = useRef(0);
  const neighborhoodSequence = useRef(0);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const resultRef = useRef(result);
  resultRef.current = result;
  const mutationPending = useRef(false);
  const projectRef = useRef("");
  const mounted = useRef(true);
  projectRef.current = state?.selectedProjectId ?? "";

  useEffect(() => {
    mounted.current = true;
    let active = true;
    if (!api) { setLoading(false); return () => { active = false; mounted.current = false; }; }
    void Promise.all([api.getState(), api.getQueries()]).then(([snapshot, queries]) => {
      if (!active) return;
      if (snapshot.ok) setState(snapshot.value); else setError(snapshot.error);
      if (queries.ok) setCatalog(queries.value); else setError(queries.error);
    }).catch((cause: unknown) => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; generation.current++; };
  }, [api]);


  useEffect(() => { neighborhoodSequence.current++; setNeighborhood(undefined); setNeighborhoodBusy(false); }, [selection?.kind, selection?.id]);

  const investigation = useBeagleWorkspace(api, state?.selectedProjectId ?? "", setError);
  const customQueries = investigation.workspace?.queries ?? [];
  const history = investigation.workspace?.history;
  const restoredProject = useRef("");
  const restoring = useRef(false);
  const context = useRef({ selection, sidebarTab, resultTab, editor: { cypher, parameters, name: queryName, description: queryDescription, category: queryCategory,
    ...(selectedSavedId ? { savedId: selectedSavedId } : {}) }, path: pathDraft, graph: graphView, table: tableView });
  context.current = { selection, sidebarTab, resultTab, editor: { cypher, parameters, name: queryName, description: queryDescription, category: queryCategory,
    ...(selectedSavedId ? { savedId: selectedSavedId } : {}) }, path: pathDraft, graph: graphView, table: tableView };
  function restoreEntry(entry: BeagleHistoryEntry) {
    querySequence.current++; neighborhoodSequence.current++; setQueryBusy(undefined); setNeighborhood(undefined); setNeighborhoodBusy(false);
    restoring.current = true;
    setResult(entry.result); resultRef.current = entry.result; setResultTitle(entry.title); setSelection(entry.selection);
    setSidebarTab(entry.sidebarTab); setResultTab(entry.resultTab); setCypher(entry.editor.cypher); setParameters(entry.editor.parameters);
    setQueryName(entry.editor.name); setQueryDescription(entry.editor.description); setQueryCategory(entry.editor.category); setSelectedSavedId(entry.editor.savedId);
    setPathDraft(entry.path); setGraphView(entry.graph); setTableView(entry.table);
  }
  useEffect(() => {
    const workspace = investigation.workspace;
    if (!workspace || restoredProject.current === workspace.projectId) return;
    restoredProject.current = workspace.projectId;
    const entry = workspace.history.entries[workspace.history.index];
    if (entry) { restoreEntry(entry); setNotice("Resumed the last investigation. Results are a saved snapshot; run the query to refresh them."); }
  }, [investigation.workspace]);
  useEffect(() => {
    if (restoring.current) { restoring.current = false; return; }
    if (!result || !history?.entries.length || history.entries[history.index]?.result !== result) return;
    // Presentation changes belong to the displayed snapshot. Editor and path
    // drafts belong to the next execution, and must not rewrite its inputs.
    const { selection, sidebarTab, resultTab, graph, table } = context.current;
    investigation.update((previous) => ({ ...previous, history: { ...previous.history, entries: previous.history.entries.map((entry, index) =>
      index === previous.history.index ? { ...entry, selection, sidebarTab, resultTab, graph, table } : entry) } }));
  }, [selection, sidebarTab, resultTab, graphView, tableView]);
  useEffect(() => {
    if (!api?.getOperation || (!busy && !queryBusy && !neighborhoodBusy)) { setOperation(null); return; }
    let active = true;
    const poll = async () => { try { const response = await api.getOperation(); if (active && response.ok) setOperation(response.value); } catch { /* The operation's own response reports failures. */ } };
    void poll(); const timer = window.setInterval(() => { void poll(); }, 500);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, busy, queryBusy, neighborhoodBusy]);
  function showResult(next: BeagleQueryResult, title: string, nextSelection: BeagleSelection = null, tab: ResultTab = next.graph.nodes.length ? "graph" : "table", snapshot = context.current) {
    const table = normalizeTableView(next, context.current.table);
    setResult(next); resultRef.current = next; setResultTitle(title); setSelection(nextSelection); setResultTab(tab);
    setTableView(table);
    investigation.update((previous) => appendInvestigation(previous, { id: crypto.randomUUID(), title, createdAt: new Date().toISOString(),
      result: next, ...snapshot, selection: nextSelection, resultTab: tab, table }));
  }
  function navigateHistory(index: number) {
    const entry = history?.entries[index]; if (!entry) return;
    restoreEntry(entry); investigation.update((previous) => ({ ...previous, history: { ...previous.history, index } }));
  }

  const resetProjectView = useCallback(() => {
    generation.current++; querySequence.current++; searchSequence.current++; neighborhoodSequence.current++;
    setResult(undefined); setSelection(null); setSearch(""); setSearchResults([]); setSearchPage(undefined); setSearched(false); setSearchError(undefined);
    setQueryBusy(undefined); setSearchBusy(false); setError(undefined); setNotice(undefined);
    setPathDraft(defaultBeaglePathDraft()); setGraphView(defaultBeagleGraphView()); setTableView({ columns: [], sort: null }); restoredProject.current = ""; setReport(undefined); setReportOpen(false);
    setNeighborhood(undefined); setNeighborhoodBusy(false);
    setCypher(DEFAULT_QUERY); setParameters("{}"); setSelectedSavedId(undefined); setQueryName(""); setQueryDescription(""); setQueryCategory("");
  }, []);

  async function updateState(label: string, action: () => Promise<OperationResult<BeagleState>>, switchProject = false, reloadCatalog = false) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(label); setError(undefined); setNotice(undefined);
    if (switchProject) { generation.current++; querySequence.current++; searchSequence.current++; neighborhoodSequence.current++; setQueryBusy(undefined); setSearchBusy(false); setNeighborhoodBusy(false); }
    try {
      if (switchProject) { await investigation.flush(); resetProjectView(); }
      const response = await action();
      if (!mounted.current) return;
      if (!response.ok) throw new Error(response.error);
      setState(response.value);
      if (switchProject) { setNewProjectOpen(false); setProjectName(""); }
      // The first catalog request can fail before an executable is selected.
      // Refresh it with the newly selected runtime instead of requiring a new window.
      if (api && response.value.runtime.available && (reloadCatalog || catalog.length === 0)) {
        const queries = await api.getQueries();
        if (!mounted.current) return;
        if (!queries.ok) throw new Error(queries.error);
        setCatalog(queries.value);
      }
    } catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { mutationPending.current = false; if (mounted.current) setBusy(undefined); }
  }

  async function mutate(label: string, action: () => Promise<OperationResult<BeagleMutationResult>>, refreshOnFailure = false) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    const epoch = generation.current;
    const projectId = projectRef.current;
    setBusy(label); setError(undefined); setNotice(undefined);
    try {
      const response = await action();
      if (!mounted.current || epoch !== generation.current) return;
      if (!response.ok) throw new Error(response.error);
      setState(response.value.state); setReport(response.value.report);
      setNotice(`${label} finished.`);
      return response.value;
    } catch (cause) {
      if (!mounted.current || epoch !== generation.current || projectId !== projectRef.current) return;
      setError(errorText(cause));
      if (refreshOnFailure && api) {
        setReport(undefined); setReportOpen(false);
        // A failed native operation may already have changed the graph or invalidated its diagnostics.
        // Do not keep displaying an old clean report while recovering the authoritative state.
        setState((previous) => previous?.selectedProjectId === projectId ? { ...previous, diagnostics: {
          version: 1, localGroupAmbiguities: [], errors: ["The latest import or analysis did not complete. Run Analyze to verify this project."],
        } } : previous);
        try {
          const refreshed = await api.getState();
          if (mounted.current && epoch === generation.current && projectId === projectRef.current && refreshed.ok && refreshed.value.selectedProjectId === projectId) {
            setState(refreshed.value);
          }
        } catch { /* Preserve the operation error and uncertainty notice when refreshing also fails. */ }
      }
    }
    finally { mutationPending.current = false; if (mounted.current) setBusy(undefined); }
    return undefined;
  }

  async function runQuery(label: string, action: QueryAction, merge = false) {
    const epoch = generation.current;
    const snapshot = context.current;
    const sequence = ++querySequence.current;
    neighborhoodSequence.current++; setNeighborhood(undefined); setNeighborhoodBusy(false);
    setQueryBusy(label); setError(undefined); setNotice(undefined);
    try {
      const response = await action();
      if (!mounted.current || epoch !== generation.current || sequence !== querySequence.current) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectRef.current) throw new Error("The project changed before the query completed. Run the query again.");
      showResult(merge && resultRef.current ? mergeResults(resultRef.current, response.value) : response.value, label, merge ? selectionRef.current : null, undefined, snapshot);
    } catch (cause) { if (mounted.current && epoch === generation.current && sequence === querySequence.current) setError(errorText(cause)); }
    finally { if (mounted.current && epoch === generation.current && sequence === querySequence.current) setQueryBusy(undefined); }
  }

  async function loadNeighborhood(node: BeagleNode, view: string, offset: number) {
    if (!api || busy) return;
    const epoch = generation.current;
    const snapshot = context.current;
    const sequence = ++neighborhoodSequence.current;
    const query = ++querySequence.current;
    setNeighborhoodBusy(true); setError(undefined); setNotice(undefined);
    try {
      const response = await api.neighborhood({ objectid: node.objectid, view, offset });
      if (!mounted.current || epoch !== generation.current || sequence !== neighborhoodSequence.current || query !== querySequence.current ||
        selectionRef.current?.kind !== "node" || selectionRef.current.id !== node.objectid) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectRef.current || response.value.objectid !== node.objectid || response.value.view !== view) return;
      setNeighborhood(response.value);
      showResult(resultRef.current ? mergeResults(resultRef.current, response.value) : response.value,
        `${BEAGLE_DRILLDOWNS.find((item) => item.id === view)?.label ?? "Relationships"} of ${nodeName(node)}`, selectionRef.current, "graph", snapshot);
    } catch (cause) { if (mounted.current && epoch === generation.current && sequence === neighborhoodSequence.current && query === querySequence.current) setError(errorText(cause)); }
    finally { if (mounted.current && epoch === generation.current && sequence === neighborhoodSequence.current) setNeighborhoodBusy(false); }
  }

  function executeEditor() {
    if (!api || busy || !cypher.trim()) return;
    let parsed: BeagleJsonObject;
    try { parsed = parseParameters(parameters); } catch (cause) { setError(`Invalid parameters: ${errorText(cause)}`); return; }
    const official = catalog.find((query) => query.id === selectedSavedId && query.cypher === cypher);
    void runQuery(official?.name ?? "Custom query", () => official
      ? api.runSavedQuery({ id: official.id, parameters: parsed })
      : api.query({ cypher, parameters: parsed }));
  }

  function changeSearch(value: string) {
    searchSequence.current++;
    setSearch(value); setSearchResults([]); setSearchPage(undefined); setSearched(false); setSearchError(undefined); setSearchBusy(false);
  }

  async function searchObjects(offset = 0) {
    if (!api || !search.trim() || busy) return;
    const epoch = generation.current;
    const sequence = ++searchSequence.current;
    if (offset === 0) { setSearchResults([]); setSearchPage(undefined); }
    setSearchBusy(true); setSearchError(undefined); setSearched(true);
    try {
      const response = await api.search({ term: search.trim(), offset });
      if (!mounted.current || epoch !== generation.current || sequence !== searchSequence.current) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectRef.current) return;
      setSearchResults(response.value.graph.nodes);
      setSearchPage(response.value.page);
      if (response.value.truncated) setSearchError("Search results reached the display limit. Use a more specific name or object ID.");
    } catch (cause) { if (mounted.current && epoch === generation.current && sequence === searchSequence.current) setSearchError(errorText(cause)); }
    finally { if (mounted.current && epoch === generation.current && sequence === searchSequence.current) setSearchBusy(false); }
  }

  function inspectSearchNode(node: BeagleNode) {
    if (!state) return;
    const current = resultRef.current;
    if (current?.projectId === state.selectedProjectId && current.graph.nodes.length >= BEAGLE_RESULT_LIMITS.nodes &&
      !current.graph.nodes.some((entry) => entry.objectid === node.objectid)) {
      setError(`The graph display limit is ${BEAGLE_RESULT_LIMITS.nodes.toLocaleString()} objects. Run a narrower query before adding another object.`);
      return;
    }
    setError(undefined);
    const previous = resultRef.current;
    const next = previous?.projectId === state.selectedProjectId ? {
      ...previous, graph: { ...previous.graph, nodes: previous.graph.nodes.some((entry) => entry.objectid === node.objectid)
        ? previous.graph.nodes.map((entry) => entry.objectid === node.objectid ? node : entry)
        : [...previous.graph.nodes, node].slice(0, BEAGLE_RESULT_LIMITS.nodes) },
    } : emptyResult(state.selectedProjectId, [node]);
    showResult(next, `Inspect ${nodeName(node)}`, { kind: "node", id: node.objectid }, "graph");
  }

  async function inspectDiagnosticObject(objectid: string) {
    if (!api || busy) return;
    const epoch = generation.current;
    const sequence = ++querySequence.current;
    neighborhoodSequence.current++; setNeighborhoodBusy(false); setNeighborhood(undefined);
    setQueryBusy("Opening object"); setError(undefined);
    try {
      const response = await api.entity({ objectid });
      if (!mounted.current || epoch !== generation.current || sequence !== querySequence.current) return;
      if (!response.ok) throw new Error(response.error);
      if (response.value.projectId !== projectRef.current) return;
      const node = response.value.graph.nodes.find((item) => item.objectid === objectid);
      if (!node) throw new Error("This object is no longer in the project.");
      inspectSearchNode(node);
    } catch (cause) { if (mounted.current && epoch === generation.current && sequence === querySequence.current) setError(errorText(cause)); }
    finally { if (mounted.current && epoch === generation.current && sequence === querySequence.current) setQueryBusy(undefined); }
  }

  function saveQuery() {
    if (!state || !cypher.trim() || !queryName.trim() || !investigation.workspace) return;
    try {
      const name = queryName.trim();
      const existing = customQueries.find((query) => query.name === name);
      const next = parseBeagleCustomQueries([{ id: existing?.id ?? crypto.randomUUID(), name, description: queryDescription, category: queryCategory,
        cypher, parameters }, ...customQueries.filter((query) => query.name !== name)]);
      investigation.update((previous) => ({ ...previous, queries: next }));
      setNotice(`Saved “${name}” in this project.`); setReport(undefined); setReportOpen(false); setError(undefined);
    } catch (cause) { setError(`The query could not be saved: ${errorText(cause)}`); }
  }
  function removeQuery(id: string) { investigation.update((previous) => ({ ...previous, queries: previous.queries.filter((query) => query.id !== id) })); }
  async function portableQueries(action: "import" | "export") {
    if (!api || busy || !investigation.workspace) return;
    const epoch = generation.current;
    setBusy(action === "import" ? "Importing queries" : "Exporting queries"); setError(undefined);
    try {
      if (action === "import") {
        const response = await api.importQueries();
        if (epoch !== generation.current || !mounted.current) return;
        if (!response.ok) throw new Error(response.error);
        if (!response.value.cancelled) {
          const entries = response.value.queries.map((query) => ({ ...query, id: crypto.randomUUID() }));
          const next = parseBeagleCustomQueries([...customQueries, ...entries]);
          investigation.update((previous) => ({ ...previous, queries: next }));
          setNotice(`Imported ${entries.length} saved queries.`);
        }
      } else {
        const response = await api.exportQueries({ queries: customQueries });
        if (epoch !== generation.current || !mounted.current) return;
        if (!response.ok) throw new Error(response.error);
        if (!response.value.cancelled) setNotice("Saved query library exported.");
      }
    } catch (cause) { if (epoch === generation.current && mounted.current) setError(errorText(cause)); }
    finally { if (epoch === generation.current && mounted.current) setBusy(undefined); }
  }
  async function exportResult(format: "json" | "csv", columns?: string[]) {
    if (!api || !result || busy) return;
    const epoch = generation.current;
    setBusy("Exporting result"); setError(undefined);
    try {
      const response = await api.exportResult({ format, title: resultTitle, result, ...(columns ? { columns } : {}), ...(format === "csv" && tableView.sort ? { sort: tableView.sort } : {}) });
      if (epoch !== generation.current || !mounted.current) return;
      if (!response.ok) throw new Error(response.error);
      if (!response.value.cancelled) setNotice(`Current result exported as ${format.toUpperCase()}${result.truncated ? " (display-limited snapshot)" : ""}.`);
    } catch (cause) { if (epoch === generation.current && mounted.current) setError(errorText(cause)); }
    finally { if (epoch === generation.current && mounted.current) setBusy(undefined); }
  }

  async function updateTag(node: BeagleNode, tag: "owned" | "admin_tier_0", enabled: boolean) {
    if (!api) return;
    const epoch = generation.current;
    const changed = await mutate("Tag update", () => api.tag({ objectid: node.objectid, tag, enabled }));
    if (!changed || epoch !== generation.current) return;
    try {
      const refreshed = await api.entity({ objectid: node.objectid });
      if (!mounted.current || epoch !== generation.current) return;
      if (!refreshed.ok) throw new Error(refreshed.error);
      if (refreshed.value.projectId !== projectRef.current) return;
      const entity = refreshed.value.graph.nodes.find((item) => item.objectid === node.objectid);
      if (!entity) throw new Error("The updated object was not returned. Refresh its query to see the current tags.");
      const update = (item: BeagleNode): BeagleNode => item.objectid === entity.objectid ? entity : item;
      const previous = resultRef.current;
      if (previous) {
        const next = { ...previous, graph: { ...previous.graph, nodes: previous.graph.nodes.map(update) } };
        setResult(next); resultRef.current = next;
        investigation.update((workspace) => ({ ...workspace, history: { ...workspace.history, entries: workspace.history.entries.map((entry, index) =>
          index === workspace.history.index ? { ...entry, result: next } : entry) } }));
      }
      setSearchResults((previous) => previous.map(update));
    } catch (cause) { if (mounted.current && epoch === generation.current) setError(`The tag was updated, but object details could not be refreshed: ${errorText(cause)}`); }
  }

  const ready = Boolean(state?.runtime.available && state.selectedProjectId);
  const disabled = !ready || Boolean(busy) || investigation.loading;
  const selectedNode = selection?.kind === "node" ? result?.graph.nodes.find((node) => node.objectid === selection.id) : undefined;
  const selectedEdge = selection?.kind === "edge" ? result?.graph.edges.find((edge) => edge.id === selection.id) : undefined;
  const categories = useMemo(() => [...new Set([...catalog, ...customQueries].map((query) => query.category).filter(Boolean))].sort(), [catalog, customQueries]);
  const visibleQueries = catalog.filter((query) => (!category || query.category === category) &&
    `${query.name} ${query.description} ${query.category}`.toLowerCase().includes(queryFilter.toLowerCase()));

  if (!api) return <AuxiliaryWindowFrame><Empty title="AD Explorer unavailable" description="The desktop bridge did not load. Close this window and open AD Explorer again." /></AuxiliaryWindowFrame>;

  return <AuxiliaryWindowFrame className="beagle-workspace" ariaLabel="AD Explorer">
    <header className="beagle-header">
      <div className="beagle-heading"><FontAwesomeIcon icon={faCircleNodes} className="text-accent" /><h1>AD Explorer</h1>
        <Chip size="sm" variant="soft" color={state?.runtime.available ? "success" : "default"}>{loading ? "Starting…" : state?.runtime.available ? "Beagle ready" : "Backend unavailable"}</Chip></div>
      <div className="beagle-toolbar">
        <NativeSelect className="beagle-project-select" variant="secondary"><NativeSelect.Trigger aria-label="Project" value={state?.selectedProjectId ?? ""}
          disabled={Boolean(busy) || loading} onChange={(event) => { const id = event.target.value; void updateState("Opening project", () => api.selectProject({ id }), true); }}>
          {!state?.projects.length ? <NativeSelect.Option value="">No project</NativeSelect.Option> : null}
          {state?.projects.map((project) => <NativeSelect.Option key={project.id} value={project.id}>{project.name}</NativeSelect.Option>)}<NativeSelect.Indicator />
        </NativeSelect.Trigger></NativeSelect>
        <IconButton label="New project" icon={faPlus} disabled={Boolean(busy) || loading} onPress={() => setNewProjectOpen((open) => !open)} />
        <div className="beagle-toolbar__actions">
          <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => { void mutate("Import", () => api.importFiles(), true); }}><FontAwesomeIcon icon={faUpload} />Import data</Button>
          <Button size="sm" variant="secondary" isDisabled={disabled || !state?.stats?.nodes} onPress={() => { void mutate("Analysis", () => api.analyze(), true); }}><FontAwesomeIcon icon={faCircleNodes} />Analyze</Button>
          <Button size="sm" variant="tertiary" isDisabled={disabled || !state?.stats?.nodes} onPress={() => {
            if (mutationPending.current) return;
            mutationPending.current = true; setBusy("Exporting graph"); setError(undefined);
            void api.exportGraph().then((response) => { if (!mounted.current) return; if (!response.ok) setError(response.error); else if (!response.value.cancelled) setNotice("Project graph exported."); })
              .catch((cause: unknown) => { if (mounted.current) setError(errorText(cause)); }).finally(() => { mutationPending.current = false; if (mounted.current) setBusy(undefined); });
          }}><FontAwesomeIcon icon={faDownload} />Export</Button>
          <Button size="sm" variant="tertiary" aria-expanded={managementOpen} onPress={() => setManagementOpen((open) => !open)}>Project tools</Button>
          <IconButton label="Beagle runtime settings" icon={faSliders} disabled={Boolean(busy)} onPress={() => setRuntimeOpen((open) => !open)} />
          <IconButton label="Refresh project" icon={faArrowsRotate} disabled={Boolean(busy) || loading} onPress={() => { void updateState("Refreshing", () => api.getState()); }} />
        </div>
      </div>
      <div className="beagle-summary" aria-label="Project summary">
        <span><strong>{state?.stats?.nodes.toLocaleString() ?? "—"}</strong> objects</span>
        <span><strong>{state?.stats?.edges.toLocaleString() ?? "—"}</strong> relationships</span>
        <span><strong>{Object.keys(state?.stats?.labels ?? {}).filter((name) => name !== "Base").length}</strong> object types</span>
        {busy ? <span role="status" className="beagle-busy"><Spinner size="sm" />{busy}…</span> : null}
        {operation ? <span className="beagle-busy" role="status">{operation.phase}{operation.cancellable ? <Button size="sm" variant="tertiary" onPress={() => {
          void api.cancelOperation({ id: operation.id }).then((response) => { if (!response.ok) setError(response.error); }).catch((cause: unknown) => setError(errorText(cause)));
        }}>Cancel operation</Button> : null}</span> : null}
      </div>
    </header>
    {newProjectOpen ? <form className="beagle-inline-panel" onSubmit={(event) => { event.preventDefault(); if (projectName.trim()) void updateState("Creating project", () => api.createProject({ name: projectName.trim() }), true); }}>
      <TextField className="beagle-project-name" value={projectName} onChange={setProjectName} isDisabled={Boolean(busy)}><Label>Project name</Label><Input maxLength={80} placeholder="GOAD lab" autoFocus /></TextField>
      <Button size="sm" type="submit" isDisabled={!projectName.trim() || Boolean(busy)}>Create project</Button>
      <Button size="sm" variant="tertiary" onPress={() => setNewProjectOpen(false)}>Cancel</Button>
    </form> : null}
    {runtimeOpen || (!loading && !state?.runtime.available) ? <div className="beagle-inline-panel beagle-runtime">
      <div><strong>Beagle backend</strong><p>{state?.runtime.error ?? (state?.runtime.version ? `Version ${state.runtime.version}` : "Choose a Beagle executable to import and query Active Directory data.")}</p>
        {state?.runtime.source ? <code>{state.runtime.source}</code> : null}</div>
      <Button size="sm" variant="secondary" isDisabled={Boolean(busy)} onPress={() => { void updateState("Selecting Beagle", () => api.chooseBinary(), false, true); }}><FontAwesomeIcon icon={faFolderOpen} />Choose Beagle</Button>
    </div> : null}
    {error ? <div className="beagle-message beagle-message--error" role="alert"><span>{error}</span><IconButton label="Dismiss error" icon={faXmark} onPress={() => setError(undefined)} /></div> : null}
    {notice ? <div className="beagle-message" role="status"><span>{notice}</span>{report !== undefined ? <Button size="sm" variant="tertiary" onPress={() => setReportOpen((open) => !open)}>{reportOpen ? "Hide report" : "View report"}</Button> : null}
      <IconButton label="Dismiss notification" icon={faXmark} onPress={() => setNotice(undefined)} /></div> : null}
    {reportOpen && report !== undefined ? <pre className="beagle-operation-report" aria-label="Operation report">{JSON.stringify(report, null, 2)}</pre> : null}
    {ready && Boolean(state?.stats?.nodes || state?.diagnostics?.errors.length || state?.diagnostics?.localGroupAmbiguities.length) ? <div className="beagle-analysis-diagnostics"><BeagleAnalysisWarnings diagnostics={state?.diagnostics}
      disabled={disabled || Boolean(queryBusy)} onInspectObject={(objectid) => { void inspectDiagnosticObject(objectid); }} /></div> : null}
    {managementOpen && state ? <div className="beagle-management-panel">
      <BeagleProjectPanel api={api} state={state} busy={Boolean(busy || queryBusy || neighborhoodBusy)} beforeAction={investigation.flush} onBusyChange={(working) => { mutationPending.current = working; setBusy(working ? "Project operation" : undefined); }}
        onState={(next) => { if (next.selectedProjectId !== projectRef.current) resetProjectView(); setState(next); }} onError={setError} onNotice={setNotice} />
      <BeagleRulesPanel api={api} projectId={state.selectedProjectId} labels={Object.keys(state.stats?.labels ?? {})} disabled={disabled || Boolean(queryBusy || neighborhoodBusy)}
        onBusyChange={(working) => { mutationPending.current = working; setBusy(working ? "Rule operation" : undefined); }}
        onApplied={(value) => { setState(value.state); setReport(value.report); setNotice("Rules saved and applied."); }} onInspectObject={(id) => { void inspectDiagnosticObject(id); }} />
    </div> : null}
    <div className="beagle-body">
      <aside className="beagle-sidebar" aria-label="Directory exploration">
        <Tabs selectedKey={sidebarTab} onSelectionChange={(key) => setSidebarTab(String(key) as SidebarTab)} className="beagle-sidebar-tabs">
          <Tabs.ListContainer><Tabs.List aria-label="Explore directory"><Tab id="search" label="Search" /><Tab id="queries" label="Queries" /><Tab id="paths" label="Paths" /></Tabs.List></Tabs.ListContainer>
          <Tabs.Panel id="search" className="beagle-sidebar-panel">
            <form onSubmit={(event) => { event.preventDefault(); void searchObjects(); }} className="beagle-search-form">
              <TextField value={search} onChange={changeSearch} isDisabled={disabled}><Label>Find an object</Label><Input placeholder="Name or object ID" maxLength={256} /></TextField>
              <Button size="sm" type="submit" variant="secondary" isDisabled={disabled || !search.trim()} isPending={searchBusy}><FontAwesomeIcon icon={faMagnifyingGlass} />Search</Button>
            </form>
            {searchError ? <p role="alert" className="text-danger text-sm">{searchError}</p> : null}
            {searchBusy ? <p className="beagle-muted" role="status">Searching directory…</p> : searched && !searchResults.length && !searchError ? <p className="beagle-muted">{searchPage?.offset ? "No more objects found. Return to the previous page or search again." : "No objects found. Try a shorter name or an exact object ID."}</p> : !searched ? <p className="beagle-muted">Search users, groups, computers, domains, and certificate services.</p> : null}
            {searchPage ? <nav className="beagle-search-pagination" aria-label="Search results pages">
              <p className="beagle-muted" role="status">{searchResults.length ? `Objects ${(searchPage.offset + 1).toLocaleString()}–${(searchPage.offset + searchResults.length).toLocaleString()}` : "No objects on this page"} · {searchPage.hasMore ? "More available" : "End of results"}</p>
              <div><Button size="sm" variant="tertiary" aria-label="Previous search results" isDisabled={disabled || searchBusy || searchPage.offset === 0}
                onPress={() => { void searchObjects(Math.max(0, searchPage.offset - searchPage.limit)); }}>Previous</Button>
                <Button size="sm" variant="tertiary" aria-label="Next search results" isDisabled={disabled || searchBusy || !searchPage.hasMore}
                  onPress={() => { void searchObjects(searchPage.offset + searchPage.limit); }}>Next</Button></div>
            </nav> : null}
            <div className="beagle-search-results">{searchResults.map((node) => <ObjectButton key={node.objectid} node={node} onPress={() => inspectSearchNode(node)} />)}</div>
          </Tabs.Panel>
          <Tabs.Panel id="queries" className="beagle-sidebar-panel">
            <TextField aria-label="Filter saved queries" value={queryFilter} onChange={setQueryFilter}><Input aria-label="Filter saved queries" placeholder="Filter queries" /></TextField>
            <NativeSelect variant="secondary"><NativeSelect.Trigger aria-label="Query category" value={category} onChange={(event) => setCategory(event.target.value)}>
              <NativeSelect.Option value="">All categories</NativeSelect.Option>{categories.map((item) => <NativeSelect.Option key={item} value={item}>{item}</NativeSelect.Option>)}<NativeSelect.Indicator />
            </NativeSelect.Trigger></NativeSelect>
            <div className="beagle-query-portability"><Button size="sm" variant="tertiary" isDisabled={disabled || investigation.loading} onPress={() => { void portableQueries("import"); }}>Import queries</Button>
              <Button size="sm" variant="tertiary" isDisabled={disabled || !customQueries.length} onPress={() => { void portableQueries("export"); }}>Export queries</Button></div>
            {customQueries.length ? <section><h2 className="beagle-section-label">My queries</h2>{customQueries.filter((query) => (!category || category === query.category) && `${query.name} ${query.description} ${query.category}`.toLowerCase().includes(queryFilter.toLowerCase())).map((query) => <div key={query.id} className="beagle-custom-query">
              <Button variant="ghost" onPress={() => { setCypher(query.cypher); setParameters(query.parameters); setQueryName(query.name); setQueryDescription(query.description); setQueryCategory(query.category); setSelectedSavedId(undefined); }}><span><strong>{query.name}</strong><small>{query.description || query.category}</small></span></Button>
              <IconButton label={`Remove saved query ${query.name}`} icon={faTrash} onPress={() => removeQuery(query.id)} />
            </div>)}</section> : null}
            <h2 className="beagle-section-label">BloodHound query library <span>{visibleQueries.length}</span></h2>
            <div className="beagle-query-list">{visibleQueries.map((query) => <Button key={query.id} variant="ghost" className="beagle-query-item" aria-label={`Load query ${query.name}`} aria-pressed={selectedSavedId === query.id} onPress={() => {
              setCypher(query.cypher); setParameters(initialParameters(query.parameters)); setSelectedSavedId(query.id); setQueryName(query.name); setQueryDescription(query.description); setQueryCategory(query.category);
            }}><span><strong>{query.name}</strong><small>{query.description || query.category}</small>{query.parameters.length ? <em>Parameters: {query.parameters.join(", ")}</em> : null}</span></Button>)}</div>
            {!visibleQueries.length ? <p className="beagle-muted">No queries match this filter.</p> : null}
          </Tabs.Panel>
          <Tabs.Panel id="paths" className="beagle-sidebar-panel" shouldForceMount>
            <BeaglePathControls key={state?.selectedProjectId} api={api} projectId={state?.selectedProjectId ?? ""} source={pathSource} target={pathTarget}
              draft={pathDraft} onDraftChange={setPathDraft} onSourceChange={setPathSource} onTargetChange={setPathTarget} disabled={disabled || Boolean(queryBusy)} loading={Boolean(queryBusy)}
              onRun={(input) => { void runQuery(input.all ? "All shortest paths" : "Shortest path", () => api.paths(input)); }} />
          </Tabs.Panel>
        </Tabs>
      </aside>
      <section className="beagle-center" aria-label="Query workspace">
        <div className="beagle-query-editor">
          <div className="beagle-editor-heading"><h2><FontAwesomeIcon icon={faCode} />Cypher</h2><span>⌘ / Ctrl + Enter to run</span>
            <Button size="sm" isDisabled={disabled || !cypher.trim() || Boolean(queryBusy)} isPending={Boolean(queryBusy)} onPress={executeEditor}><FontAwesomeIcon icon={faPlay} />Run query</Button></div>
          <div className="beagle-editor-fields" onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!queryBusy) executeEditor(); } }}>
            <TextField value={cypher} onChange={(value) => { setCypher(value); setSelectedSavedId(undefined); }} className="beagle-cypher-field" aria-label="Cypher query"><TextArea aria-label="Cypher query" spellCheck={false} rows={4} /></TextField>
            <TextField value={parameters} onChange={setParameters} className="beagle-parameters-field"><Label>Parameters (JSON)</Label><TextArea aria-label="Query parameters" spellCheck={false} rows={3} /></TextField>
          </div>
          <div className="beagle-save-query"><TextField aria-label="Saved query name" value={queryName} onChange={setQueryName}><Input aria-label="Saved query name" placeholder="Name this query" maxLength={160} /></TextField>
            <TextField aria-label="Saved query category" value={queryCategory} onChange={setQueryCategory}><Input aria-label="Saved query category" placeholder="Category" maxLength={160} /></TextField>
            <TextField aria-label="Saved query description" value={queryDescription} onChange={setQueryDescription}><Input aria-label="Saved query description" placeholder="Description" maxLength={4000} /></TextField>
            <Button size="sm" variant="tertiary" isDisabled={!investigation.workspace || !queryName.trim() || !cypher.trim()} onPress={saveQuery}><FontAwesomeIcon icon={faSave} />Save query</Button></div>
        </div>
        {history?.entries.length ? <nav className="beagle-history" aria-label="Investigation history">
          <Button size="sm" variant="tertiary" aria-label="Back in investigation" isDisabled={history.index <= 0 || Boolean(busy)} onPress={() => navigateHistory(history.index - 1)}>Back</Button>
          <Button size="sm" variant="tertiary" aria-label="Forward in investigation" isDisabled={history.index >= history.entries.length - 1 || Boolean(busy)} onPress={() => navigateHistory(history.index + 1)}>Forward</Button>
          <NativeSelect variant="secondary"><NativeSelect.Trigger aria-label="Resume investigation" value={String(history.index)} disabled={Boolean(busy)} onChange={(event) => navigateHistory(Number(event.target.value))}>
            {history.entries.map((entry, index) => <NativeSelect.Option key={entry.id} value={String(index)}>{index + 1}. {entry.title} · {new Date(entry.createdAt).toLocaleTimeString()}</NativeSelect.Option>)}<NativeSelect.Indicator />
          </NativeSelect.Trigger></NativeSelect>
          <span className="beagle-muted">Saved snapshots</span>
        </nav> : null}
        <div className="beagle-result-area" aria-busy={Boolean(queryBusy)}>
          {result ? <Tabs className="beagle-result-tabs" selectedKey={resultTab} onSelectionChange={(key) => setResultTab(String(key) as ResultTab)}>
            <div className="beagle-result-heading"><Tabs.ListContainer><Tabs.List aria-label="Query result view"><Tab id="graph" label="Graph" /><Tab id="table" label="Table" /><Tab id="objects" label="Objects" /></Tabs.List></Tabs.ListContainer>
              <Button size="sm" variant="tertiary" isDisabled={Boolean(busy)} onPress={() => { void exportResult("json"); }}>Export result JSON</Button>
              <span className="beagle-result-summary" title={resultTitle}>{queryBusy ? `${queryBusy}…` : `${result.totalRows.toLocaleString()} rows · ${result.elapsedMs.toLocaleString()} ms`}</span></div>
            {result.truncated ? <p className="beagle-limit-warning" role="status">Results reached a display limit ({result.limits.rows.toLocaleString()} rows, {result.limits.nodes.toLocaleString()} objects, {result.limits.edges.toLocaleString()} relationships). Add a narrower filter or LIMIT.</p> : null}
            <Tabs.Panel id="graph" className="beagle-graph-panel">{result.graph.nodes.length ? <BeagleGraph result={result} selection={selection} onSelect={setSelection} view={graphView} onViewChange={setGraphView} /> : <Empty title="No graph objects" description={result.rows.length ? "This query returned scalar values. Open Table to inspect the results." : "The query returned no matching objects or paths."} />}</Tabs.Panel>
            <Tabs.Panel id="table" className="beagle-table-panel"><BeagleResultTable result={result} view={tableView} onViewChange={setTableView} disabled={Boolean(busy)} onExport={(columns) => { void exportResult("csv", columns); }} /></Tabs.Panel>
            <Tabs.Panel id="objects" className="beagle-objects-panel">{result.graph.nodes.length ? result.graph.nodes.map((node) => <ObjectButton key={node.objectid} node={node} onPress={() => setSelection({ kind: "node", id: node.objectid })} />) : <Empty title="No objects" description="No directory objects were returned by this query." />}</Tabs.Panel>
          </Tabs> : <Empty title={loading ? "Opening directory workspace" : state?.stats?.nodes ? "Explore your directory" : "Import Active Directory data"}
            description={loading ? "Loading Beagle and your projects…" : state?.stats?.nodes ? "Search for an object, choose a BloodHound query, or run your own Cypher." : "Import a BloodHound collection ZIP or JSON files, then analyze the graph to derive relationships."}
            action={!loading && ready && !state?.stats?.nodes ? <Button variant="secondary" isDisabled={Boolean(busy)} onPress={() => { void mutate("Import", () => api.importFiles(), true); }}><FontAwesomeIcon icon={faUpload} />Import collection</Button> : undefined} />}
          {queryBusy && !result ? <div className="beagle-query-progress" role="status"><Spinner size="sm" />{queryBusy}…</div> : null}
        </div>
      </section>
      {selectedNode || selectedEdge ? <aside className="beagle-inspector" aria-label="Object inspector">
        <div className="beagle-inspector-heading"><h2>{selectedNode ? "Object details" : "Relationship details"}</h2><IconButton label="Close inspector" icon={faXmark} onPress={() => setSelection(null)} /></div>
        {selectedNode ? <>
          <div className="beagle-inspector-identity"><span data-kind={nodeKind(selectedNode)} className="beagle-object-icon"><NodeIcon node={selectedNode} /></span><div><h3>{nodeName(selectedNode)}</h3><span>{nodeKind(selectedNode)}</span></div></div>
          <code className="beagle-object-id">{selectedNode.objectid}</code>
          <div className="beagle-inspector-tags">
            <CellSwitch className="beagle-tag-row" size="sm" aria-label="Owned" isSelected={nodeTagged(selectedNode, "owned")} isDisabled={disabled} onChange={(enabled) => { void updateTag(selectedNode, "owned", enabled); }}>
              <CellSwitch.Trigger><CellSwitch.Label>Owned</CellSwitch.Label><CellSwitch.Control className="ml-auto shrink-0" /></CellSwitch.Trigger>
            </CellSwitch>
            <CellSwitch className="beagle-tag-row" size="sm" aria-label="Tier Zero" isSelected={nodeTagged(selectedNode, "admin_tier_0")} isDisabled={disabled} onChange={(enabled) => { void updateTag(selectedNode, "admin_tier_0", enabled); }}>
              <CellSwitch.Trigger><CellSwitch.Label>Tier Zero</CellSwitch.Label><CellSwitch.Control className="ml-auto shrink-0" /></CellSwitch.Trigger>
            </CellSwitch>
          </div>
          <div className="beagle-inspector-actions"><Button size="sm" variant="secondary" isDisabled={disabled || Boolean(queryBusy)} onPress={() => { setPathSource(selectedNode.objectid); setSidebarTab("paths"); }}>Set source</Button>
            <Button size="sm" variant="secondary" isDisabled={disabled || Boolean(queryBusy)} onPress={() => { setPathTarget(selectedNode.objectid); setSidebarTab("paths"); }}>Set target</Button>
          </div>
          <BeagleNeighborhoodControls key={`${state?.selectedProjectId}:${selectedNode.objectid}`} node={selectedNode} result={neighborhood} loading={neighborhoodBusy}
            disabled={disabled || Boolean(queryBusy)} onLoad={(view, offset) => { void loadNeighborhood(selectedNode, view, offset); }} />
          <h3 className="beagle-section-label">Properties</h3><Properties values={selectedNode.properties} />
        </> : selectedEdge && result ? <BeagleEdgeInspector key={`${result.projectId}:${selectedEdge.id}`} edge={selectedEdge} result={result} api={api} disabled={disabled || Boolean(queryBusy)}
          onInspectObject={(id) => { void inspectDiagnosticObject(id); }} onOpen={(value, title) => { querySequence.current++; setQueryBusy(undefined); showResult(value, title); }} /> : null}
      </aside> : null}
    </div>
  </AuxiliaryWindowFrame>;
}

function ObjectButton({ node, onPress }: { node: BeagleNode; onPress: () => void }) {
  return <Button variant="ghost" className="beagle-object-button" onPress={onPress} aria-label={`Inspect ${nodeName(node)}`}>
    <span className="beagle-object-icon" data-kind={nodeKind(node)}><NodeIcon node={node} /></span><span><strong>{nodeName(node)}</strong><small>{nodeKind(node)} · {node.objectid}</small></span>
  </Button>;
}
function Tab({ id, label }: { id: string; label: string }) { return <Tabs.Tab id={id}>{label}<Tabs.Indicator /></Tabs.Tab>; }
function IconButton({ label, icon, onPress, disabled = false }: { label: string; icon: IconDefinition; onPress: () => void; disabled?: boolean }) {
  return <Tooltip delay={250}><Button size="sm" variant="tertiary" isIconOnly aria-label={label} isDisabled={disabled} onPress={onPress}><FontAwesomeIcon icon={icon} /></Button><Tooltip.Content>{label}</Tooltip.Content></Tooltip>;
}
function Empty({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="beagle-empty"><EmptyState><EmptyState.Header><EmptyState.Media variant="icon"><FontAwesomeIcon icon={faBookBookmark} /></EmptyState.Media><EmptyState.Title>{title}</EmptyState.Title>
    <EmptyState.Description>{description}</EmptyState.Description></EmptyState.Header>{action ? <EmptyState.Content>{action}</EmptyState.Content> : null}</EmptyState></div>;
}
function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : "The Beagle operation failed."; }
function emptyResult(projectId: string, nodes: BeagleNode[]): BeagleQueryResult {
  return { projectId, columns: [], rows: [], graph: { nodes, edges: [] }, elapsedMs: 0, totalRows: 0, truncated: false, limits: { ...BEAGLE_RESULT_LIMITS } };
}
function mergeResults(previous: BeagleQueryResult, next: BeagleQueryResult): BeagleQueryResult {
  const nodes = new Map(previous.graph.nodes.map((node) => [node.objectid, node]));
  const edges = new Map(previous.graph.edges.map((edge) => [edge.id, edge]));
  for (const node of next.graph.nodes) nodes.set(node.objectid, node);
  for (const edge of next.graph.edges) edges.set(edge.id, edge);
  const retainedNodes = [...nodes.values()].slice(0, Math.min(next.limits.nodes, BEAGLE_RESULT_LIMITS.nodes));
  const retainedIds = new Set(retainedNodes.map((node) => node.objectid));
  const retainedEdges = [...edges.values()].filter((edge) => retainedIds.has(edge.source) && retainedIds.has(edge.target))
    .slice(0, Math.min(next.limits.edges, BEAGLE_RESULT_LIMITS.edges));
  return { ...next, graph: { nodes: retainedNodes, edges: retainedEdges },
    truncated: next.truncated || previous.truncated || nodes.size > retainedNodes.length || edges.size > retainedEdges.length };
}
