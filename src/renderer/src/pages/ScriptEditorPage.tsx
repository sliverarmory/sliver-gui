import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Button, Chip, Dropdown, Input, Label, Modal, SearchField, TextField, Tooltip } from "@heroui/react";
import { Resizable } from "@heroui-pro/react/resizable";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCode, faCopy, faEllipsisVertical, faFileImport, faPlay, faPlus, faStop } from "@fortawesome/free-solid-svg-icons";

import type { OperationResult } from "../../../shared/contracts";
import { SCRIPT_LIMITS, parseScriptSource, type ScriptCatalog, type ScriptDocument } from "../../../shared/script-contracts";
import type { ScriptConsoleRecord, ScriptRunState } from "../../../shared/script-runtime-protocol";
import { useApplicationSettings } from "../components/ApplicationSettingsProvider";
import { CodeEditor } from "../components/CodeEditor";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ScriptOutputTerminal, scriptOutputText } from "../components/ScriptOutputTerminal";
import { ScriptRunner } from "../scripting/script-runner";

interface ScriptDraft extends ScriptDocument {
  savedSource: string;
  conflict?: string;
}

interface RunSnapshot {
  scriptId: string;
  name: string;
  source: string;
  unsaved: boolean;
}

type NameAction = "new" | "rename" | "duplicate";
const EMPTY_CATALOG: ScriptCatalog = { scripts: [], warnings: [] };
const RUN_LABELS: Record<ScriptRunState["status"], string> = {
  starting: "Starting", running: "Running", completed: "Completed", failed: "Failed",
  stopped: "Stopped", "timed-out": "Timed out", "output-limit": "Output limit reached",
};

/** Drafts stay in this window's memory while the application switches pages. */
export function ScriptEditorPage({ active }: { readonly active: boolean }): React.JSX.Element {
  const settings = useApplicationSettings();
  const [catalog, setCatalog] = useState<ScriptCatalog>(EMPTY_CATALOG);
  const [drafts, setDrafts] = useState<Record<string, ScriptDraft>>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [nameAction, setNameAction] = useState<NameAction>();
  const [nameTarget, setNameTarget] = useState<ScriptDraft>();
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string>();
  const [deleteTarget, setDeleteTarget] = useState<ScriptDraft>();
  const [reloadTarget, setReloadTarget] = useState<ScriptDraft>();
  const [records, setRecords] = useState<readonly ScriptConsoleRecord[]>([]);
  const [outputReset, setOutputReset] = useState(0);
  const [runState, setRunState] = useState<ScriptRunState>();
  const [runSnapshot, setRunSnapshot] = useState<RunSnapshot>();
  const [runLoading, setRunLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [wide, setWide] = useState(() => window.matchMedia?.("(min-width: 960px)").matches ?? true);
  const mounted = useRef(false);
  const activeRef = useRef(active);
  const draftsRef = useRef(drafts);
  const selectedIdRef = useRef(selectedId);
  const pendingRef = useRef(false);
  const refreshAfterMutation = useRef(false);
  const catalogRequest = useRef(0);
  const documentRequest = useRef(0);
  const runRequest = useRef(0);
  const runBusy = useRef(false);
  const loadingRuntime = useRef(false);
  const runner = useRef<ScriptRunner | undefined>(undefined);
  activeRef.current = active;
  draftsRef.current = drafts;
  selectedIdRef.current = selectedId;
  const selected = selectedId ? drafts[selectedId] : undefined;
  const lastLoadedDraft = useRef<ScriptDraft | undefined>(undefined);
  if (selected) lastLoadedDraft.current = selected;
  const editorDocument = selected ?? lastLoadedDraft.current;
  const dirty = Boolean(selected && selected.source !== selected.savedSource);
  const hasDirtyDrafts = Object.values(drafts).some((draft) => draft.source !== draft.savedSource);
  const dirtyRef = useRef(hasDirtyDrafts);
  dirtyRef.current = hasDirtyDrafts;
  const running = runLoading || runState?.status === "starting" || runState?.status === "running";
  const editedSinceRun = Boolean(runSnapshot && selected && selected.source !== runSnapshot.source);

  const refreshCatalog = useCallback(async (): Promise<void> => {
    if (pendingRef.current) { refreshAfterMutation.current = true; return; }
    const request = ++catalogRequest.current;
    try {
      const value = unwrap(await window.sliver.listScripts());
      if (!mounted.current || request !== catalogRequest.current) return;
      setCatalog(value);
      setDrafts((current) => {
        const next = { ...current };
        for (const [id, draft] of Object.entries(current)) {
          const summary = value.scripts.find((script) => script.id === id);
          if (summary?.revision === draft.revision) continue;
          if (draft.source !== draft.savedSource) {
            next[id] = { ...draft, conflict: summary
              ? "This script changed in another window. Reload it or save your draft as a copy."
              : "This script was deleted in another window. Save your draft as a copy to keep it." };
          } else {
            delete next[id];
          }
        }
        return next;
      });
      setSelectedId((current) => {
        if (current && (value.scripts.some((script) => script.id === current) ||
          isDirty(draftsRef.current[current]))) return current;
        return value.scripts[0]?.id;
      });
    } catch (cause) {
      if (mounted.current && request === catalogRequest.current) setError(messageOf(cause));
    } finally {
      if (mounted.current && request === catalogRequest.current) setLoading(false);
    }
  }, []);

  const stopRun = useCallback(() => {
    runRequest.current += 1;
    runner.current?.stop();
    if (loadingRuntime.current) setRunState({ status: "stopped", elapsedMs: 0 });
    loadingRuntime.current = false;
    runBusy.current = false;
    setRunLoading(false);
  }, []);

  useEffect(() => {
    mounted.current = true;
    runner.current = new ScriptRunner({
      onOutput: (next) => { if (mounted.current) setRecords((current) => [...current, ...next]); },
      onState: (next) => {
        runBusy.current = next.status === "starting" || next.status === "running";
        if (mounted.current) setRunState(next);
      },
    });
    void refreshCatalog();
    const unsubscribe = window.sliver.onScriptsChanged(() => void refreshCatalog());
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "Unsaved script changes";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", stopRun);
    return () => {
      mounted.current = false;
      catalogRequest.current += 1;
      documentRequest.current += 1;
      runRequest.current += 1;
      runner.current?.dispose();
      runner.current = undefined;
      unsubscribe();
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", stopRun);
    };
  }, [refreshCatalog, stopRun]);

  useEffect(() => {
    void window.sliver.setScriptEditorDirty(hasDirtyDrafts).then(unwrap).catch(() => {
      if (mounted.current) setError("Could not update unsaved-change protection. Save your scripts before closing the window.");
    });
  }, [hasDirtyDrafts]);

  useEffect(() => { if (!active) stopRun(); }, [active, stopRun]);
  useEffect(() => {
    const media = window.matchMedia?.("(min-width: 960px)");
    if (!media) return;
    const update = (): void => setWide(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!selectedId || draftsRef.current[selectedId]) return;
    const request = ++documentRequest.current;
    void window.sliver.readScript({ id: selectedId }).then((result) => {
      const document = unwrap(result);
      if (!mounted.current || request !== documentRequest.current) return;
      setDrafts((current) => ({ ...current, [document.id]: { ...document, savedSource: document.source } }));
    }).catch((cause: unknown) => {
      if (mounted.current && request === documentRequest.current) setError(messageOf(cause));
    });
    return () => { documentRequest.current += 1; };
  }, [selectedId, catalog]);

  const clearOutput = (): void => {
    setRecords([]);
    setOutputReset((current) => current + 1);
    setCopied(false);
  };
  const selectScript = (id: string): void => {
    if (pendingRef.current || id === selectedIdRef.current) return;
    stopRun();
    clearOutput();
    setRunState(undefined);
    setRunSnapshot(undefined);
    setError(undefined);
    setSelectedId(id);
  };
  const acceptDocument = (document: ScriptDocument, source = document.source): void => {
    setDrafts((current) => ({ ...current, [document.id]: { ...document, source, savedSource: document.source } }));
    setCatalog((current) => ({ ...current, scripts: [
      ...current.scripts.filter((script) => script.id !== document.id),
      { id: document.id, name: document.name, revision: document.revision },
    ].sort((left, right) => left.name.localeCompare(right.name)) }));
  };
  const beginMutation = (): boolean => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    catalogRequest.current += 1;
    setPending(true);
    setError(undefined);
    return true;
  };
  const endMutation = (): void => {
    pendingRef.current = false;
    if (mounted.current) setPending(false);
    if (refreshAfterMutation.current && mounted.current) {
      refreshAfterMutation.current = false;
      void refreshCatalog();
    }
  };
  const save = async (): Promise<void> => {
    const draft = selectedIdRef.current ? draftsRef.current[selectedIdRef.current] : undefined;
    if (!activeRef.current || !isDirty(draft) || draft.conflict || !beginMutation()) return;
    try {
      const saved = unwrap(await window.sliver.saveScript({ id: draft.id, source: draft.source, expectedRevision: draft.revision }));
      if (mounted.current) acceptDocument(saved, draftsRef.current[draft.id]?.source ?? saved.source);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally { endMutation(); }
  };
  const exportScript = async (): Promise<void> => {
    const draft = selectedIdRef.current ? draftsRef.current[selectedIdRef.current] : undefined;
    if (!activeRef.current || !draft || !beginMutation()) return;
    try {
      unwrap(await window.sliver.exportScript({ name: draft.name, source: draft.source }));
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally { endMutation(); }
  };
  const importScript = async (): Promise<void> => {
    if (!activeRef.current || !beginMutation()) return;
    try {
      const result = unwrap(await window.sliver.importScript());
      if (result.canceled || !mounted.current) return;
      stopRun();
      clearOutput();
      setRunState(undefined);
      setRunSnapshot(undefined);
      acceptDocument(result.script);
      setSelectedId(result.script.id);
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally { endMutation(); }
  };
  const run = async (): Promise<void> => {
    const draft = selectedIdRef.current ? draftsRef.current[selectedIdRef.current] : undefined;
    if (!activeRef.current || !draft || runBusy.current || pendingRef.current) return;
    runBusy.current = true;
    loadingRuntime.current = true;
    const request = ++runRequest.current;
    const snapshot: RunSnapshot = { source: draft.source, scriptId: draft.id, name: draft.name, unsaved: isDirty(draft) };
    setRunSnapshot(snapshot);
    clearOutput();
    setRunLoading(true);
    setRunState({ status: "starting", elapsedMs: 0 });
    try {
      parseScriptSource(snapshot.source);
      const asset = unwrap(await window.sliver.getScriptRuntime());
      if (!mounted.current || !activeRef.current || request !== runRequest.current) return;
      runner.current?.run({ source: snapshot.source, scriptId: snapshot.scriptId, wasmBytes: asset.bytes });
    } catch (cause) {
      if (mounted.current && request === runRequest.current) {
        runBusy.current = false;
        setRunState({ status: "failed", elapsedMs: 0, message: messageOf(cause) });
      }
    } finally {
      if (mounted.current && request === runRequest.current) {
        loadingRuntime.current = false;
        setRunLoading(false);
      }
    }
  };
  const openNameDialog = (action: NameAction): void => {
    setNameAction(action);
    setNameTarget(action === "new" ? undefined : selected);
    setName(action === "rename" ? selected?.name ?? "" : action === "duplicate" ? `${selected?.name ?? "Script"} copy` : "Untitled script");
    setNameError(undefined);
  };
  const submitName = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!nameAction || !name.trim() || !beginMutation()) return;
    try {
      if (nameAction !== "new" && !nameTarget) throw new Error("The script is no longer available. Close this dialog and select a script.");
      const document = nameAction === "rename"
        ? unwrap(await window.sliver.renameScript({ id: nameTarget!.id, name, expectedRevision: nameTarget!.revision }))
        : unwrap(await window.sliver.createScript({ name, source: nameAction === "duplicate" ? nameTarget!.source : "" }));
      if (!mounted.current) return;
      acceptDocument(document, nameAction === "rename" ? draftsRef.current[document.id]?.source ?? document.source : document.source);
      if (nameAction !== "rename") {
        stopRun();
        clearOutput();
        setRunState(undefined);
        setRunSnapshot(undefined);
        setSelectedId(document.id);
      }
      setNameAction(undefined);
    } catch (cause) {
      if (mounted.current) setNameError(messageOf(cause));
    } finally { endMutation(); }
  };
  const deleteScript = async (): Promise<boolean> => {
    if (!deleteTarget || !beginMutation()) return false;
    try {
      const id = deleteTarget.id;
      unwrap(await window.sliver.deleteScript({ id, expectedRevision: deleteTarget.revision }));
      if (!mounted.current) return true;
      if (selectedIdRef.current === id) {
        stopRun();
        clearOutput();
        setRunState(undefined);
        setRunSnapshot(undefined);
      }
      setDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
      setCatalog((current) => ({ ...current, scripts: current.scripts.filter((script) => script.id !== id) }));
      setSelectedId((current) => current === id ? catalog.scripts.find((script) => script.id !== id)?.id : current);
      return true;
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
      return false;
    } finally { endMutation(); }
  };
  const reloadScript = async (): Promise<boolean> => {
    if (!reloadTarget || !beginMutation()) return false;
    try {
      const document = unwrap(await window.sliver.readScript({ id: reloadTarget.id }));
      if (mounted.current) acceptDocument(document);
      return true;
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
      return false;
    } finally { endMutation(); }
  };
  const copyOutput = async (): Promise<void> => {
    try {
      if (!navigator.clipboard?.writeText || (navigator.userActivation && !navigator.userActivation.isActive)) {
        throw new Error("Clipboard access is unavailable. Try Copy output again.");
      }
      await navigator.clipboard.writeText(scriptOutputText(records));
      if (mounted.current) setCopied(true);
    } catch (cause) { if (mounted.current) setError(messageOf(cause)); }
  };

  const listedScripts = [...catalog.scripts];
  for (const draft of Object.values(drafts)) {
    if (isDirty(draft) && !listedScripts.some((script) => script.id === draft.id)) listedScripts.push(draft);
  }
  const filteredScripts = listedScripts.filter((script) => script.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const importButton = <Tooltip delay={250}>
    <Button aria-label="Import script" isIconOnly size="sm" variant="ghost" isDisabled={pending} onPress={() => void importScript()}><FontAwesomeIcon icon={faFileImport} /></Button>
    <Tooltip.Content>Import script</Tooltip.Content>
  </Tooltip>;
  const library = <aside aria-label="Saved scripts" className="script-editor-library">
    <div className="flex items-center justify-between gap-3 px-4 pt-4">
      <h2 className="text-sm font-semibold">Scripts</h2>
      <div className="flex items-center gap-1">{importButton}<Button size="sm" variant="ghost" isDisabled={pending} onPress={() => openNameDialog("new")}><FontAwesomeIcon icon={faPlus} /> New</Button></div>
    </div>
    <div className="px-4 py-3"><SearchField aria-label="Search scripts" value={query} onChange={setQuery}>
      <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Search scripts" /><SearchField.ClearButton /></SearchField.Group>
    </SearchField></div>
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {loading ? <p className="px-2 py-3 text-sm text-muted">Loading scripts…</p> : filteredScripts.length === 0
        ? <p className="px-2 py-3 text-sm text-muted">{query ? "No matching scripts." : "Create a script to begin."}</p>
        : filteredScripts.map((script) => <Button key={script.id} aria-label={`Open ${script.name}`}
          aria-current={selectedId === script.id} className="script-editor-library__item"
          isDisabled={pending} variant={selectedId === script.id ? "secondary" : "ghost"} onPress={() => selectScript(script.id)}>
          <FontAwesomeIcon className="shrink-0 text-muted" icon={faCode} />
          <span className="min-w-0 flex-1 truncate text-left">{script.name}</span>
          {isDirty(drafts[script.id]) ? <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        </Button>)}
    </div>
  </aside>;
  const workspace = <div className="script-editor-workspace">
    <div className="script-editor-toolbar">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-sm font-semibold">{selected?.name ?? "Select a script"}</h2>
        <p className="text-xs text-muted">{dirty ? "Unsaved changes" : selected ? "Saved" : "JavaScript"}</p>
      </div>
      <Button size="sm" variant="secondary" isDisabled={!selected || !dirty || pending || Boolean(selected.conflict)} isPending={pending} onPress={() => void save()}>Save</Button>
      {running ? <Button size="sm" variant="danger-soft" onPress={stopRun}><FontAwesomeIcon icon={faStop} /> Stop</Button>
        : <Button size="sm" isDisabled={!selected || pending || !active} onPress={() => void run()}><FontAwesomeIcon icon={faPlay} /> Run</Button>}
      <Tooltip delay={250}><Dropdown>
        <Button aria-label="Script actions" isIconOnly size="sm" variant="ghost" isDisabled={!selected || pending}><FontAwesomeIcon icon={faEllipsisVertical} /></Button>
        <Dropdown.Popover><Dropdown.Menu aria-label="Script actions">
          <Dropdown.Item id="rename" isDisabled={Boolean(selected?.conflict)} onAction={() => openNameDialog("rename")}>Rename</Dropdown.Item>
          <Dropdown.Item id="duplicate" onAction={() => openNameDialog("duplicate")}>Duplicate</Dropdown.Item>
          <Dropdown.Item id="export" onAction={() => void exportScript()}>Export…</Dropdown.Item>
          <Dropdown.Item id="reload" onAction={() => setReloadTarget(selected)}>Reload from disk</Dropdown.Item>
          <Dropdown.Item id="delete" variant="danger" onAction={() => setDeleteTarget(selected)}>Delete</Dropdown.Item>
        </Dropdown.Menu></Dropdown.Popover>
      </Dropdown><Tooltip.Content>Script actions</Tooltip.Content></Tooltip>
    </div>
    {selected?.conflict ? <div role="alert" className="script-editor-notice text-warning"><span>{selected.conflict}</span><Button size="sm" variant="ghost" onPress={() => openNameDialog("duplicate")}>Save as copy</Button></div> : null}
    <div className="min-h-0 flex-1">
      <Resizable id="script-editor-content" autoSaveId="sliver:script-editor-content" orientation="vertical">
        <Resizable.Panel defaultSize={65} minSize="120px">
          <div className="relative h-full min-h-0" aria-busy={Boolean(selectedId && !selected)}>
            {editorDocument ? <div className="h-full min-h-0" aria-hidden={!selected} inert={!selected}><CodeEditor value={editorDocument.source} modelKey={`script:${editorDocument.id}`} language="javascript" profile="script" readOnly={!selected}
              ariaLabel="Script source" theme={settings?.resolvedTheme ?? "dark"} onSave={() => void save()} onRun={() => void run()}
              onChange={(source) => {
                if (!selected) return;
                setDrafts((current) => current[selected.id] ? { ...current, [selected.id]: { ...current[selected.id]!, source } } : current);
              }} /></div> : null}
            {!selected ? <div className="absolute inset-0 grid place-items-center bg-background p-6 text-sm text-muted">{selectedId ? "Loading script…" : "Select a script or create a new one."}</div> : null}
          </div>
        </Resizable.Panel>
        <Resizable.Handle aria-label="Resize script output" type="line" variant="secondary" withIndicator />
        <Resizable.Panel defaultSize={35} minSize="110px">
          <section aria-label="Script output" className="script-editor-output">
            <div className="script-editor-output__toolbar"><h3 className="text-sm font-medium">Output</h3>
              {runSnapshot ? <span className="max-w-48 truncate text-xs text-muted" title={runSnapshot.name}>{runSnapshot.name}</span> : null}
              <span aria-live="polite" className="mr-auto text-xs text-muted">{runState ? RUN_LABELS[runState.status] : "Ready"}{runState && !running ? ` · ${runState.elapsedMs} ms` : ""}</span>
              {editedSinceRun ? <Chip size="sm" color="warning" variant="soft">Edited since run</Chip> : runSnapshot?.unsaved ? <Chip size="sm" variant="soft">Unsaved snapshot</Chip> : null}
              <Button size="sm" variant="ghost" isDisabled={records.length === 0} onPress={() => void copyOutput()}><FontAwesomeIcon icon={faCopy} /> {copied ? "Copied" : "Copy output"}</Button>
              <Button size="sm" variant="ghost" isDisabled={records.length === 0} onPress={clearOutput}>Clear</Button>
            </div>
            {runState?.message ? <p role="alert" className="px-4 py-2 text-sm text-danger">{runState.message}</p> : null}
            <ScriptOutputTerminal records={records} resetKey={outputReset} className="min-h-0 flex-1" />
          </section>
        </Resizable.Panel>
      </Resizable>
    </div>
  </div>;

  return <section className="script-editor-page" hidden={!active} inert={!active} aria-label="Script Editor">
    <header className="script-editor-header"><div><h1 className="text-xl font-semibold tracking-tight">Script Editor</h1><p className="mt-1 text-sm text-muted">Write JavaScript and see its console output.</p></div><Chip size="sm" variant="soft">Local scripts</Chip></header>
    {error ? <div role="alert" className="script-editor-notice text-danger"><span>{error}</span><Button size="sm" variant="ghost" onPress={() => { setError(undefined); void refreshCatalog(); }}>Retry</Button></div> : null}
    {catalog.warnings.length ? <div role="status" aria-label="Script library notices" className="max-h-36 shrink-0 overflow-y-auto">{catalog.warnings.map((warning, index) => <p key={`${index}:${warning}`} className="script-editor-notice text-warning">{warning}</p>)}</div> : null}
    <div className="min-h-0 flex-1">
      {wide ? <Resizable id="script-editor-workspace" autoSaveId="sliver:script-editor-workspace" orientation="horizontal">
        <Resizable.Panel defaultSize="250px" minSize="200px" maxSize="360px" groupResizeBehavior="preserve-pixel-size">{library}</Resizable.Panel>
        <Resizable.Handle aria-label="Resize script library" type="line" variant="secondary" withIndicator />
        <Resizable.Panel minSize="340px">{workspace}</Resizable.Panel>
      </Resizable> : <div className="flex h-full min-h-0 flex-col"><div className="flex items-center gap-3 px-4 py-2">
        <select aria-label="Select script" className="script-editor-picker" value={selectedId ?? ""} disabled={pending} onChange={(event) => selectScript(event.target.value)}>
          {listedScripts.length === 0 ? <option value="">No scripts</option> : listedScripts.map((script) => <option key={script.id} value={script.id}>{script.name}{isDirty(drafts[script.id]) ? " • Unsaved" : ""}</option>)}
        </select>{importButton}<Button size="sm" variant="secondary" isDisabled={pending} onPress={() => openNameDialog("new")}>New</Button>
      </div><div className="min-h-0 flex-1">{workspace}</div></div>}
    </div>
    <Modal.Backdrop isOpen={active && Boolean(nameAction)} onOpenChange={(open) => { if (!open && !pending) setNameAction(undefined); }} isDismissable={!pending} isKeyboardDismissDisabled={pending} variant="blur">
      <Modal.Container size="sm"><Modal.Dialog><Modal.CloseTrigger isDisabled={pending} /><Modal.Header><Modal.Heading>{nameAction === "rename" ? "Rename script" : nameAction === "duplicate" ? "Save a copy" : "New script"}</Modal.Heading></Modal.Header>
        <Modal.Body><form id="script-name-form" onSubmit={(event) => void submitName(event)}><TextField isRequired isDisabled={pending} value={name} onChange={setName} variant="secondary"><Label>Script name</Label><Input autoFocus maxLength={SCRIPT_LIMITS.nameCharacters} onFocus={(event) => event.currentTarget.select()} /></TextField>{nameError ? <p role="alert" className="mt-2 text-sm text-danger">{nameError}</p> : null}</form></Modal.Body>
        <Modal.Footer><Button variant="secondary" isDisabled={pending} onPress={() => setNameAction(undefined)}>Cancel</Button><Button type="submit" form="script-name-form" isDisabled={!name.trim() || pending} isPending={pending}>{nameAction === "rename" ? "Rename" : nameAction === "duplicate" ? "Save copy" : "Create"}</Button></Modal.Footer>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop>
    <ConfirmDialog isOpen={active && Boolean(deleteTarget)} onOpenChange={(open) => { if (!open) setDeleteTarget(undefined); }} title="Delete script?" description={`Delete “${deleteTarget?.name ?? "this script"}” from this computer?${isDirty(deleteTarget) ? " Its unsaved changes will also be discarded." : ""}`} confirmLabel="Delete" isPending={pending} onConfirm={deleteScript} />
    <ConfirmDialog isOpen={active && Boolean(reloadTarget)} onOpenChange={(open) => { if (!open) setReloadTarget(undefined); }} title="Reload script?" description={`Replace the draft of “${reloadTarget?.name ?? "this script"}” with the saved script on disk? Unsaved changes will be discarded.`} confirmLabel="Reload" isPending={pending} onConfirm={reloadScript} />
  </section>;
}

function unwrap<T>(result: OperationResult<T>): T {
  if (!result.ok) throw new Error(result.error ?? "The script operation failed.");
  return result.value as T;
}
function isDirty(draft: ScriptDraft | undefined): draft is ScriptDraft {
  return Boolean(draft && draft.source !== draft.savedSource);
}
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The script operation failed. Please try again.";
}
