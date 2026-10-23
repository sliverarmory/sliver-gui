import { useEffect, useState } from "react";
import { Button, Input, Label, TextField } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { BeagleAPI, BeagleState } from "../../../shared/beagle-contracts";
import { parseBeagleRetentionInput, type BeagleCleanupInput, type BeagleImportRecord } from "../../../shared/beagle-projects";

export interface BeagleProjectPanelProps {
  api: BeagleAPI;
  state: BeagleState;
  busy: boolean;
  beforeAction?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onState: (state: BeagleState) => void;
  onError: (error: string) => void;
  onNotice: (message: string) => void;
}

export function BeagleProjectPanel({ api, state, busy, beforeAction, onBusyChange, onState, onError, onNotice }: BeagleProjectPanelProps) {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  const [name, setName] = useState(project?.name ?? "");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [scope, setScope] = useState<BeagleCleanupInput["scope"]>("sessions");
  const [confirmation, setConfirmation] = useState<string>();
  const [working, setWorking] = useState(false);
  const locked = busy || working;
  const nativeAvailable = state.runtime.available;
  const p2Available = nativeAvailable && state.runtime.operations?.includes("backup");
  const latest = state.projectData?.history.find((entry) => entry.status === "complete" && (entry.operation === "merge" || entry.operation === "replace"));
  useEffect(() => { setName(project?.name ?? ""); setConfirmation(undefined); }, [project?.id, project?.name]);

  async function run(action: () => Promise<void>) {
    if (locked) return;
    setWorking(true); onBusyChange?.(true); setConfirmation(undefined);
    try { await beforeAction?.(); await action(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : "Project operation failed"); }
    finally { setWorking(false); onBusyChange?.(false); }
  }
  async function importCollection() {
    const response = await api.importFiles({ mode });
    if (!response.ok) throw new Error(response.error);
    onState(response.value.state);
    if (response.value.report) onNotice(mode === "merge" ? "Collection merged and analyzed. Review collection quality below." : "Collected data replaced and analyzed. Review collection quality below.");
  }
  async function clean() {
    const response = await api.cleanup({ scope });
    if (!response.ok) throw new Error(response.error);
    onState(response.value.state); onNotice(scope === "sessions" ? "Collected sessions removed and project analyzed." : "Collected graph cleared. Queries, rules and provenance are retained.");
  }
  async function archive() {
    const response = await api.archiveProject({ id: state.selectedProjectId });
    if (!response.ok) throw new Error(response.error);
    onState(response.value); onNotice("Project archived. Restore it below whenever needed.");
  }

  return <section aria-label="Project management" className="flex flex-col gap-4 text-sm">
    <div className="flex items-end gap-2">
      <TextField value={name} onChange={setName} isDisabled={locked} className="min-w-0 flex-1"><Label>Project name</Label><Input maxLength={80} /></TextField>
      <Button size="sm" variant="secondary" isDisabled={locked || !name.trim() || name.trim() === project?.name} onPress={() => void run(async () => {
        const response = await api.renameProject({ id: state.selectedProjectId, name });
        if (!response.ok) throw new Error(response.error);
        onState(response.value); onNotice("Project renamed.");
      })}>Rename</Button>
    </div>
    <NativeSelect variant="secondary"><Label>Collection import</Label><NativeSelect.Trigger aria-label="Collection import mode" value={mode} disabled={locked} onChange={(event) => setMode(event.target.value as typeof mode)}>
      <NativeSelect.Option value="merge">Merge with collected data</NativeSelect.Option><NativeSelect.Option value="replace">Replace collected data</NativeSelect.Option><NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    <p className="text-xs text-muted">Replace removes the previous collected graph. Rules and manual tag overrides apply to matching objects. Back up the project to retain a complete copy.</p>
    <Button size="sm" variant="secondary" isDisabled={locked || !p2Available} onPress={() => mode === "replace" ? setConfirmation("replace") : void run(importCollection)}>Choose collection files</Button>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" isDisabled={locked || !p2Available} onPress={() => void run(async () => { const response = await api.backupProject(); if (!response.ok) throw new Error(response.error); if (!response.value.cancelled) onNotice("Complete project backup saved, including graph, tags, rules, queries, investigation history and provenance."); })}>Back up project</Button>
      <Button size="sm" variant="secondary" isDisabled={locked || !nativeAvailable} onPress={() => void run(async () => { const response = await api.restoreProject(); if (!response.ok) throw new Error(response.error); onState(response.value); onNotice("Project backup opened."); })}>Restore backup</Button>
    </div>
    <p className="text-xs text-muted">Backups support databases up to 8 GiB. Graph snapshots support up to 1 GiB; query responses remain bounded at 32 MiB. Large datasets may need narrower queries.</p>
    {!p2Available && nativeAvailable ? <p role="status" className="text-warning">Choose an updated Beagle helper to enable recoverable imports and project backups.</p> : null}
    <NativeSelect variant="secondary"><Label>Cleanup scope</Label><NativeSelect.Trigger aria-label="Cleanup scope" value={scope} disabled={locked} onChange={(event) => setScope(event.target.value as typeof scope)}>
      <NativeSelect.Option value="sessions">Collected sessions only</NativeSelect.Option><NativeSelect.Option value="collected">All collected graph data</NativeSelect.Option><NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    <div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" isDisabled={locked || !p2Available} onPress={() => setConfirmation("cleanup")}>Clean selected data</Button><Button size="sm" variant="secondary" isDisabled={locked} onPress={() => setConfirmation("archive")}>Archive project</Button></div>
    {confirmation ? <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/30 p-3">
      <p>{confirmation === "replace" ? "Replace the current collected graph with the files you select? Queries, rules, manual overrides and history are retained." : confirmation === "archive" ? "Archive this project? Its data stays available for recovery below." : scope === "sessions" ? "Remove all collected HasSession relationships and rerun analysis?" : "Clear every collected object and relationship? Queries, rules and history are retained."}</p>
      <div className="flex gap-2"><Button size="sm" variant="danger" onPress={() => void run(confirmation === "replace" ? importCollection : confirmation === "archive" ? archive : clean)}>Confirm {confirmation}</Button><Button size="sm" variant="secondary" onPress={() => setConfirmation(undefined)}>Cancel</Button></div>
    </div> : null}
    {(state.archivedProjects?.length ?? 0) > 0 ? <details><summary className="cursor-pointer">Archived projects ({state.archivedProjects!.length})</summary><ul className="mt-3 flex flex-col gap-2">{state.archivedProjects!.map((item) => <li key={item.id} className="flex items-center justify-between gap-2"><span className="truncate">{item.name}</span><Button size="sm" variant="secondary" isDisabled={locked} aria-label={`Restore ${item.name}`} onPress={() => void run(async () => { const response = await api.restoreArchivedProject({ id: item.id }); if (!response.ok) throw new Error(response.error); onState(response.value); onNotice("Archived project restored."); })}>Restore</Button></li>)}</ul></details> : null}
    <NativeSelect variant="secondary"><Label>Import history retention</Label><NativeSelect.Trigger aria-label="Import history retention" value={state.projectData?.historyLimit ?? 50} disabled={locked} onChange={(event) => { const historyLimit = Number(event.target.value); void run(async () => { const response = await api.setRetention(parseBeagleRetentionInput({ historyLimit })); if (!response.ok) throw new Error(response.error); onState(response.value); }); }}>
      {[10, 25, 50, 100].map((limit) => <NativeSelect.Option key={limit} value={limit}>{limit} operations</NativeSelect.Option>)}<NativeSelect.Indicator />
    </NativeSelect.Trigger></NativeSelect>
    <p className="text-xs text-muted">Keeps the selected number of recent native source reports and visible operations. Visible provenance is also bounded to 4 MiB. Retained reports are included in backups.</p>
    {state.projectData?.error ? <p role="alert" className="text-warning">{state.projectData.error}</p> : null}
    {latest ? <div className="flex flex-col gap-2"><h3 className="font-medium">Latest collection quality</h3><Quality record={latest} /><p className="text-xs text-muted">Counts describe reported probes. Missing or unknown collection does not establish that a relationship is absent. Derived edges do not synthesize CE lastseen timestamps.</p></div> : <p className="text-muted">Import a collection to record coverage and provenance.</p>}
    <details><summary className="cursor-pointer">Import and analysis history ({state.projectData?.history.length ?? 0})</summary><div className="mt-3 flex flex-col gap-3">{state.projectData?.history.map((entry) => <details key={entry.id} className="rounded-lg border border-border p-3"><summary className="cursor-pointer">{new Date(entry.at).toLocaleString()} · {entry.operation} · {entry.status}</summary><div className="mt-3 flex flex-col gap-2"><Quality record={entry} />{entry.message ? <p role="status">{entry.message}</p> : null}{entry.files.map((file, index) => <p key={`${file.sha256}-${index}`} className="break-all text-xs">{file.name} · {file.bytes.toLocaleString()} bytes<br />SHA-256: {file.sha256}</p>)}{entry.warnings.map((warning, index) => <p key={index} className="break-words text-xs text-warning">{warning}</p>)}{entry.warningCount > entry.warnings.length ? <p>{entry.warningCount - entry.warnings.length} additional warnings omitted from this bounded report.</p> : null}</div></details>)}</div></details>
  </section>;
}

function Quality({ record }: { record: BeagleImportRecord }) {
  return <><p>{record.records?.toLocaleString() ?? "—"} records · {record.warningCount.toLocaleString()} warnings · {record.retainedFields.toLocaleString()} retained fields</p>{record.collectors.length ? <p className="text-xs">Collector versions: {record.collectors.join(", ")}</p> : null}<div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>Probe</th><th>Collected</th><th>Failed</th><th>Unknown</th></tr></thead><tbody>{Object.entries(record.coverage).map(([name, coverage]) => <tr key={name}><td className="py-1">{name}</td><td>{coverage.collected}</td><td>{coverage.failed}</td><td>{coverage.unknown}</td></tr>)}</tbody></table></div>{Object.entries(record.coverage).flatMap(([name, coverage]) => Object.entries(coverage.failureReasons).map(([reason, amount]) => <p className="break-words text-xs text-warning" key={`${name}:${reason}`}>{name}: {reason} ({amount})</p>))}</>;
}
