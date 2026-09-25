import { useEffect, useState } from "react";
import { Button, Chip, Input, Label, Switch, TextField, toast } from "@heroui/react";

import type {
  ExecutionActionDraft,
  ExecutionActionResult,
  ExecutionCapability,
} from "../../../shared/execution-contracts";
import type { TargetSummary } from "../../../shared/target-contracts";
import { OPERATOR_DATA_LIMITS } from "../../../shared/operator-data-contracts";
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";
import { ExecutionActionForm } from "./target-execution-forms";
import type { ProcessExecutionRecord } from "./process-execution-history";

const PROCESS_FORM_ID = "execution-process-form";
type OutputStream = "stdout" | "stderr";

interface ProcessExecutionViewProps {
  capability: ExecutionCapability | undefined;
  target: TargetSummary;
  isPreparing: boolean;
  isExecuting: boolean;
  history: readonly ProcessExecutionRecord[];
  selectedId: string | undefined;
  savingStream: OutputStream | undefined;
  addingToLoot: boolean;
  onPrepare: (draft: ExecutionActionDraft) => Promise<void>;
  onSelect: (id: string) => void;
  onClear: (id: string) => void;
  onClearAll: () => void;
  onRefresh: (record: ProcessExecutionRecord) => void;
  onSave: (result: ExecutionActionResult, stream: OutputStream) => void;
  onAddToLoot: (result: ExecutionActionResult, stream: OutputStream, name: string) => void;
}

/** The session's execute command, output, and this run's bounded history. */
export function ProcessExecutionView({
  capability,
  target,
  isPreparing,
  isExecuting,
  history,
  selectedId,
  savingStream,
  addingToLoot,
  onPrepare,
  onSelect,
  onClear,
  onClearAll,
  onRefresh,
  onSave,
  onAddToLoot,
}: ProcessExecutionViewProps): React.JSX.Element {
  const [stream, setStream] = useState<OutputStream>("stdout");
  const [ignoreStderr, setIgnoreStderr] = useState(false);
  const [lootName, setLootName] = useState("");
  const selectedIndex = Math.max(0, history.findIndex((record) => record.id === selectedId));
  const selected = history[selectedIndex];
  const output = stream === "stdout" ? selected?.stdout : selected?.stderr;
  const outputMetadata = selected?.result?.output?.find((item) => item.stream === stream);
  const canSave = Boolean(outputMetadata && Date.parse(outputMetadata.expiresAt) > Date.now());

  useEffect(() => {
    setStream("stdout");
    setLootName("");
  }, [selected?.id]);
  useEffect(() => { if (ignoreStderr) setStream("stdout"); }, [ignoreStderr]);

  const copyOutput = async (): Promise<void> => {
    if (!output?.data.byteLength) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(output.data));
      toast.success("Output copied");
    } catch {
      toast.danger("Could not copy output", { description: "Select text in the terminal and use Copy instead." });
    }
  };

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4">
      <section aria-label="Run a process" className="min-w-0 rounded-2xl border border-separator bg-surface-secondary p-4">
        <div className="mb-3">
          <h3 className="text-base font-semibold text-foreground">Run a process</h3>
        </div>
        {!capability ? (
          <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
            Process execution is unavailable for this target.
          </p>
        ) : !capability.available ? (
          <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
            {capability.reason?.message ?? "Process execution is unavailable for this target."}
          </p>
        ) : (
          <>
            <ExecutionActionForm
              key={`${target.mode}:${target.id}`}
              capability={capability}
              compactProcess
              formId={PROCESS_FORM_ID}
              isPreparing={isPreparing || isExecuting}
              operationId="execution.process"
              target={target}
              onPrepare={onPrepare}
            />
            <div className="mt-3 flex justify-end">
              <Button
                className="w-full sm:w-auto"
                form={PROCESS_FORM_ID}
                isPending={isPreparing}
                isDisabled={isExecuting}
                type="submit"
                variant="primary"
              >
                {isPreparing ? "Preparing review…" : "Review command"}
              </Button>
            </div>
          </>
        )}
      </section>

      <section aria-label="Process execution history and output" className="min-w-0 rounded-2xl border border-separator bg-surface-secondary p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-foreground">Output</h3>
          <Button isDisabled={history.length === 0} size="sm" variant="tertiary" onPress={onClearAll}>Clear history</Button>
        </div>

        {history.length > 0 ? (
          <div className="mt-3 grid min-w-0 gap-4 lg:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
            <aside className="min-w-0 border-b border-separator pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4">
              <h4 className="text-xs font-semibold text-muted">History · {history.length}</h4>
              <nav aria-label="Process execution history" className="mt-2 flex max-h-80 flex-col gap-1.5 overflow-y-auto pr-1 lg:max-h-[36rem]">
                {history.map((record) => (
                  <button
                    aria-current={record.id === selected?.id ? "true" : undefined}
                    className={`w-full min-w-0 cursor-[var(--cursor-interactive)] rounded-lg border px-2.5 py-2 text-left ${record.id === selected?.id ? "border-accent bg-accent-soft" : "border-separator bg-surface hover:bg-surface-tertiary"}`}
                    key={record.id}
                    type="button"
                    onClick={() => onSelect(record.id)}
                  >
                    <span className="block truncate font-mono text-xs text-foreground">{commandLabel(record)}</span>
                    <span className="mt-1 block truncate text-[11px] text-muted">{new Date(record.startedAt).toLocaleTimeString()} · {stateLabel(record)}</span>
                  </button>
                ))}
              </nav>
              <div className="mt-2 flex gap-1">
                <Button isDisabled={selectedIndex >= history.length - 1} size="sm" variant="tertiary" onPress={() => onSelect(history[selectedIndex + 1]!.id)}>Older</Button>
                <Button isDisabled={selectedIndex <= 0} size="sm" variant="tertiary" onPress={() => onSelect(history[selectedIndex - 1]!.id)}>Newer</Button>
              </div>
            </aside>

            {selected ? (
              <div className="min-w-0">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="break-all font-mono text-sm font-medium text-foreground">{commandLabel(selected)}</h4>
                      <Chip color={stateColor(selected)} size="sm" variant="soft">{stateLabel(selected)}</Chip>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{new Date(selected.startedAt).toLocaleString()}</p>
                  </div>
                  <Button size="sm" variant="tertiary" onPress={() => onClear(selected.id)}>Clear selected</Button>
                </div>

                <dl aria-label="Execution details" className="mt-2 grid grid-cols-2 gap-2 rounded-xl bg-surface px-3 py-2 text-xs sm:grid-cols-4">
                  <Detail label="Exit code" value={selected.result?.exitCode === undefined ? "Not reported" : String(selected.result.exitCode)} />
                  <Detail label="Process ID" value={selected.result?.pid === undefined ? "Not reported" : String(selected.result.pid)} />
                  <Detail label="State" value={stateLabel(selected)} />
                  <Detail label="Request" value={selected.result?.requestId ?? "Pending"} />
                </dl>
                {selected.error || selected.outputError ? (
                  <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="alert">
                    {selected.error ?? selected.outputError}
                  </p>
                ) : null}
                {selected.result?.message ? <p className="mt-2 text-xs text-muted">{selected.result.message}</p> : null}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant={stream === "stdout" ? "primary" : "tertiary"} onPress={() => setStream("stdout")}>Stdout</Button>
                    {!ignoreStderr ? <Button size="sm" variant={stream === "stderr" ? "primary" : "tertiary"} onPress={() => setStream("stderr")}>Stderr</Button> : null}
                  </div>
                  <Switch isSelected={ignoreStderr} onChange={setIgnoreStderr}>
                    <Switch.Content className="text-xs text-muted">Ignore stderr</Switch.Content>
                    <Switch.Control><Switch.Thumb /></Switch.Control>
                  </Switch>
                </div>
                <div className="mt-2 min-h-80 overflow-hidden rounded-xl bg-surface">
                  {output?.data.byteLength ? (
                    <ExecutionOutputTerminal
                      bytes={output.data}
                      className="h-80"
                      resetKey={`${selected.id}:${stream}`}
                    />
                  ) : (
                    <div className="flex min-h-80 items-center justify-center px-5 text-center text-sm text-muted">
                      {selected.state === "running" || selected.state === "submitted"
                        ? "Waiting for the process result."
                        : outputMetadata && !output && !selected.outputError
                          ? `Loading captured ${stream}…`
                        : selected.result && !selected.result.output?.length
                          ? "This invocation returned no captured output."
                          : `No ${stream} was returned for this invocation.`}
                    </div>
                  )}
                </div>
                {output?.truncated ? <p className="mt-2 text-xs text-warning">The captured {stream} was truncated at the output limit.</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button isDisabled={!output?.data.byteLength} size="sm" variant="tertiary" onPress={() => void copyOutput()}>Copy output</Button>
                  <Button isDisabled={!canSave} isPending={savingStream === stream} size="sm" variant="tertiary" onPress={() => selected.result && onSave(selected.result, stream)}>Save {stream}</Button>
                  {selected.result && (selected.state === "outcome-unknown" || selected.state === "submitted") ? (
                    <Button size="sm" variant="outline" onPress={() => onRefresh(selected)}>Refresh result</Button>
                  ) : null}
                </div>
                {output?.data.byteLength ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-surface p-3">
                    <TextField className="min-w-48 flex-1" name="lootName" variant="secondary">
                      <Label>Loot name (optional)</Label>
                      <Input maxLength={OPERATOR_DATA_LIMITS.nameCharacters} value={lootName} onChange={(event) => setLootName(event.target.value)} />
                    </TextField>
                    <Button
                      isDisabled={!canSave}
                      isPending={addingToLoot}
                      size="sm"
                      variant="outline"
                      onPress={() => selected.result && onAddToLoot(selected.result, stream, lootName.trim())}
                    >
                      Add {stream} to Loot
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="mt-3 flex min-h-56 items-center justify-center rounded-xl bg-surface px-5 text-center text-sm text-muted">
            Run a process to see its output and execution history here.
          </div>
        )}
      </section>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="mt-1 break-all font-mono text-foreground">{value}</dd></div>;
}

function commandLabel(record: ProcessExecutionRecord): string {
  return [record.path, ...record.args.map((arg) => /\s|["']/u.test(arg) || !arg ? JSON.stringify(arg) : arg)].join(" ");
}

function stateLabel(record: ProcessExecutionRecord): string {
  if (record.state === "request-failed") return "Request failed";
  if (record.state === "outcome-unknown") return "Outcome unknown";
  if (record.state === "target-disappeared") return "Target disappeared";
  if (record.state === "running") return "Running";
  if (record.state === "completed" && record.result?.exitCode !== undefined && record.result.exitCode !== 0) {
    return `Exited ${record.result.exitCode}`;
  }
  return record.state.charAt(0).toUpperCase() + record.state.slice(1);
}

function stateColor(record: ProcessExecutionRecord): "success" | "warning" | "danger" {
  if (record.state === "completed") return record.result?.exitCode ? "danger" : "success";
  if (record.state === "running" || record.state === "submitted" || record.state === "outcome-unknown") return "warning";
  return "danger";
}
