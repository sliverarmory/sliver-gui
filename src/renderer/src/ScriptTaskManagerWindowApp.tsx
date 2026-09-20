import { useEffect, useRef, useState } from "react";
import { Button, Chip, SearchField, Tooltip } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCode, faCopy, faPlay, faStop } from "@fortawesome/free-solid-svg-icons";

import type { ScriptTaskCommand, ScriptTaskManagerSnapshot } from "../../shared/script-task-manager-contracts";
import type { ScriptRunStatus } from "../../shared/script-runtime-protocol";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { ScriptOutputTerminal, scriptOutputText } from "./components/ScriptOutputTerminal";

const STATUS_LABELS: Record<ScriptRunStatus, string> = {
  starting: "Starting", running: "Running", completed: "Completed", failed: "Failed",
  stopped: "Stopped", "timed-out": "Timed out", "output-limit": "Output limit reached",
};

export function ScriptTaskManagerWindowApp(): React.JSX.Element {
  const api = window.scriptTasks;
  const [snapshot, setSnapshot] = useState<ScriptTaskManagerSnapshot>();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState<string>();
  const [copied, setCopied] = useState(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    if (!api) { setError("Task Manager is unavailable. Reopen it from Script Editor."); return; }
    let active = true;
    let receivedChange = false;
    const unsubscribe = api.onChanged((next) => {
      if (!active) return;
      receivedChange = true;
      setSnapshot(next);
      setCopied(false);
    });
    void api.getState().then((result) => {
      if (!active || receivedChange) return;
      if (!result.ok || !result.value) throw new Error(result.error ?? "Script tasks could not be loaded.");
      setSnapshot(result.value);
    }).catch((cause: unknown) => {
      if (active && !receivedChange) setError(messageOf(cause));
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [api]);

  const command = async (input: ScriptTaskCommand): Promise<void> => {
    if (!api) return;
    setError(undefined);
    setSending(input.id);
    try {
      const result = await api.command(input);
      if (!result.ok) throw new Error(result.error ?? "The script action could not be completed.");
    } catch (cause) {
      if (mounted.current) setError(messageOf(cause));
    } finally { if (mounted.current) setSending(undefined); }
  };
  const copyOutput = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(scriptOutputText(snapshot?.records ?? []));
      if (mounted.current) setCopied(true);
    } catch { if (mounted.current) setError("Could not copy output. Please try again."); }
  };
  const selected = snapshot?.scripts.find((script) => script.id === snapshot.selectedId);
  const listed = snapshot?.scripts.filter((script) => script.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) ?? [];
  const runningCount = snapshot?.scripts.filter((script) => isRunning(script.state?.status)).length ?? 0;
  const state = selected?.state;
  const notice = error ?? snapshot?.error;

  return <AuxiliaryWindowFrame ariaLabel="Script Task Manager" className="flex flex-col overflow-hidden">
    <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-4">
      <h1 className="text-lg font-semibold tracking-tight">Task Manager</h1>
      <Chip size="sm" variant="soft">{runningCount} running</Chip>
    </header>
    {notice ? <p role="alert" className="shrink-0 px-5 pb-3 text-sm text-danger">{notice}</p> : null}
    <div className="script-task-manager-workspace">
      <aside aria-label="Scripts" className="script-editor-library border-r border-separator">
        <div className="px-3 pb-3"><SearchField aria-label="Search scripts" value={query} onChange={setQuery}>
          <SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder="Search scripts" /><SearchField.ClearButton /></SearchField.Group>
        </SearchField></div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {!snapshot ? <p role="status" className="p-3 text-sm text-muted">Loading scripts…</p> : listed.length === 0
            ? <p className="p-3 text-sm text-muted">{query ? "No matching scripts." : "Create or import a script in Script Editor."}</p>
            : listed.map((script) => {
              const running = isRunning(script.state?.status);
              return <div key={script.id} className="flex min-w-0 items-center gap-1 py-0.5">
                <Button aria-label={`Select ${script.name}`} aria-current={script.id === snapshot.selectedId}
                  className="h-auto min-w-0 flex-1 justify-start py-2" variant={script.id === snapshot.selectedId ? "secondary" : "ghost"}
                  isDisabled={snapshot.pending} onPress={() => void command({ type: "select", id: script.id })}>
                  <FontAwesomeIcon aria-hidden className="shrink-0 text-muted" icon={faCode} />
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate">{script.name}</span>
                    <span className="block text-xs text-muted">{script.state ? STATUS_LABELS[script.state.status] : "Ready"}{script.dirty ? " · Unsaved" : ""}</span>
                  </span>
                </Button>
                <Tooltip delay={250}>
                  <Button aria-label={`${running ? "Stop" : "Run"} ${script.name}`} isIconOnly size="sm"
                    variant={running ? "danger-soft" : "ghost"} isDisabled={sending === script.id || (!running && snapshot.pending)}
                    onPress={() => void command({ type: running ? "stop" : "run", id: script.id })}>
                    <FontAwesomeIcon aria-hidden icon={running ? faStop : faPlay} />
                  </Button>
                  <Tooltip.Content>{running ? "Stop" : "Run"} {script.name}</Tooltip.Content>
                </Tooltip>
              </div>;
            })}
        </div>
        <p className="shrink-0 px-4 pb-3 text-xs text-muted">Up to 4 scripts can run at once. Output is kept for the 16 most recently run scripts.</p>
      </aside>
      <section aria-label="Script console" className="script-editor-output">
        <div className="script-editor-output__toolbar">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold">{selected?.name ?? "Select a script"}</h2>
            <p role="status" className="text-xs text-muted">{state ? `${STATUS_LABELS[state.status]} · ${state.elapsedMs} ms` : "Ready"}</p>
          </div>
          {snapshot?.run?.unsaved ? <Chip size="sm" variant="soft">Unsaved draft</Chip> : null}
          <Button size="sm" variant="ghost" isDisabled={!snapshot?.records.length} onPress={() => void copyOutput()}>
            <FontAwesomeIcon aria-hidden icon={faCopy} />{copied ? "Copied" : "Copy output"}
          </Button>
          <Button size="sm" variant="ghost" isDisabled={!selected || !snapshot?.records.length}
            onPress={() => { if (selected) void command({ type: "clear", id: selected.id }); }}>Clear</Button>
        </div>
        {state?.message ? <p className={`px-4 pb-2 text-xs ${state.status === "failed" ? "text-danger" : "text-muted"}`}>{state.message}</p> : null}
        {snapshot?.run?.editedSinceRun ? <p className="px-4 pb-2 text-xs text-muted">The script has changed since this run.</p> : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {api && snapshot ? <ScriptOutputTerminal records={snapshot.records} resetKey={`${snapshot.selectedId ?? "empty"}:${snapshot.outputReset}`} runtimeApi={api} /> : null}
        </div>
      </section>
    </div>
  </AuxiliaryWindowFrame>;
}

function isRunning(status: ScriptRunStatus | undefined): boolean { return status === "starting" || status === "running"; }
function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : "The script action could not be completed."; }
