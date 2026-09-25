import { useEffect, useState } from "react";
import { Button, Chip, Switch, Tooltip, toast } from "@heroui/react";
import { ChatListView, Segment } from "@heroui-pro/react";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBoxOpen,
  faCircleCheck,
  faCircleExclamation,
  faCircleQuestion,
  faClock,
  faCopy,
  faDownload,
  faPlay,
  faPlus,
  faRotate,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";

import type {
  ExecutionActionDraft,
  ExecutionActionResult,
  ExecutionCapability,
} from "../../../shared/execution-contracts";
import type { TargetSummary } from "../../../shared/target-contracts";
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";
import { ExecutionActionForm } from "./target-execution-forms";
import type { ProcessExecutionRecord } from "./process-execution-history";

const PROCESS_FORM_ID = "execution-process-form";
const NEW_EXECUTION_KEY = "new-execution";
const EXECUTION_KEY_PREFIX = "execution:";
type OutputStream = "stdout" | "stderr";

interface ProcessExecutionViewProps {
  capability: ExecutionCapability | undefined;
  target: TargetSummary;
  isPreparing: boolean;
  isExecuting: boolean;
  isRefreshing: boolean;
  history: readonly ProcessExecutionRecord[];
  selectedId: string | null | undefined;
  savingStream: OutputStream | undefined;
  addingToLoot: boolean;
  onPrepare: (draft: ExecutionActionDraft) => Promise<void>;
  onSelect: (id: string | null) => void;
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
  isRefreshing,
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
  const selectedIndex = history.findIndex((record) => record.id === selectedId);
  const selected = selectedId === null ? undefined : history[selectedIndex < 0 ? 0 : selectedIndex];
  const showingNew = selected === undefined;
  const selectedHistoryKey = showingNew ? NEW_EXECUTION_KEY : `${EXECUTION_KEY_PREFIX}${selected.id}`;
  const output = stream === "stdout" ? selected?.stdout : selected?.stderr;
  const outputMetadata = selected?.result?.output?.find((item) => item.stream === stream);
  const canSave = Boolean(outputMetadata && Date.parse(outputMetadata.expiresAt) > Date.now());

  useEffect(() => {
    setStream("stdout");
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
    <section
      aria-label="Process execution history and output"
      className="mt-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(20rem,1fr)] overflow-y-auto rounded-2xl border border-separator bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden"
    >
      <aside className="flex min-h-0 min-w-0 flex-col border-b border-separator bg-background p-3 sm:border-b-0 sm:border-r sm:p-4">
        <nav aria-label="Process execution history" className="min-h-0 sm:flex-1 sm:overflow-hidden">
          <ChatListView
            aria-label="Process execution history"
            className="max-h-40 space-y-1 overflow-y-auto pr-1 sm:h-full sm:max-h-full"
            selectedKeys={new Set([selectedHistoryKey])}
            selectionBehavior="replace"
            selectionMode="single"
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const key = keys.values().next().value;
              if (key === NEW_EXECUTION_KEY) onSelect(null);
              else if (typeof key === "string" && key.startsWith(EXECUTION_KEY_PREFIX)) {
                onSelect(key.slice(EXECUTION_KEY_PREFIX.length));
              }
            }}
          >
            <ChatListView.Item
              className="sticky top-0 z-10 rounded-xl"
              id={NEW_EXECUTION_KEY}
              style={{
                backgroundColor: showingNew ? "var(--color-surface)" : "var(--color-background)",
                borderBottomColor: "transparent",
                boxShadow: showingNew ? "var(--shadow-surface)" : undefined,
              }}
              textValue="New Execution"
            >
              <ChatListView.ItemContent>
                <ChatListView.Icon>
                  <FontAwesomeIcon aria-hidden className="size-3.5 text-accent" icon={faPlus} />
                </ChatListView.Icon>
                <ChatListView.Text>
                  <ChatListView.Title>New Execution</ChatListView.Title>
                </ChatListView.Text>
              </ChatListView.ItemContent>
            </ChatListView.Item>
            {history.map((record) => {
              const command = commandLabel(record);
              const isSelected = record.id === selected?.id;
              const statusIcon = historyStatusIcon(record);
              return (
                <ChatListView.Item
                  className="rounded-xl"
                  id={`${EXECUTION_KEY_PREFIX}${record.id}`}
                  key={record.id}
                  style={{
                    backgroundColor: isSelected ? "var(--color-surface)" : undefined,
                    borderBottomColor: "transparent",
                    boxShadow: isSelected ? "var(--shadow-surface)" : undefined,
                  }}
                  textValue={command}
                >
                  <ChatListView.ItemContent>
                    <ChatListView.Icon>
                      <FontAwesomeIcon aria-hidden className={`size-3.5 ${statusIcon.color}`} icon={statusIcon.icon} />
                    </ChatListView.Icon>
                    <ChatListView.Text>
                      <ChatListView.Title className="font-mono text-xs" title={command}>{command}</ChatListView.Title>
                      <ChatListView.Preview>
                        {new Date(record.startedAt).toLocaleTimeString()} · {stateLabel(record)}
                      </ChatListView.Preview>
                    </ChatListView.Text>
                  </ChatListView.ItemContent>
                </ChatListView.Item>
              );
            })}
          </ChatListView>
        </nav>
        {history.length === 0 ? <p className="px-4 pt-2 text-xs text-muted">No executions yet.</p> : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
          <span className="text-xs text-muted">History · {history.length}</span>
          <Button isDisabled={history.length === 0} size="sm" variant="danger-soft" onPress={onClearAll}>
            <FontAwesomeIcon aria-hidden className="size-3" icon={faTrashCan} />
            Clear history
          </Button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto p-4 sm:p-5">
        {showingNew ? (
          <section aria-label="Run a process" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-foreground">Run a process</h3>
              {capability?.available ? (
                <Button
                  form={PROCESS_FORM_ID}
                  isPending={isPreparing || isExecuting}
                  isDisabled={isPreparing || isExecuting || isRefreshing}
                  type="submit"
                  variant="primary"
                >
                  <FontAwesomeIcon aria-hidden className="size-3.5" icon={faPlay} />
                  Run
                </Button>
              ) : null}
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
              </>
            )}
          </section>
        ) : selected ? (
          <div className="flex min-h-full min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-all font-mono text-sm font-medium text-foreground">{commandLabel(selected)}</h3>
                  <Chip color={stateColor(selected)} size="sm" variant="soft">{stateLabel(selected)}</Chip>
                </div>
                <p className="mt-0.5 text-xs text-muted">{new Date(selected.startedAt).toLocaleString()}</p>
              </div>
              <Tooltip delay={250}>
                <Button aria-label="Clear selected" isIconOnly size="sm" variant="danger-soft" onPress={() => onClear(selected.id)}>
                  <FontAwesomeIcon aria-hidden className="size-3" icon={faTrashCan} />
                </Button>
                <Tooltip.Content>Clear selected</Tooltip.Content>
              </Tooltip>
            </div>

            <dl aria-label="Execution details" className="mt-3 grid gap-3 rounded-xl bg-surface-secondary p-3 text-xs sm:grid-cols-[minmax(0,7rem)_minmax(0,8rem)_minmax(0,1fr)]">
              <Detail label="Exit code" value={selected.result?.exitCode === undefined ? "Not reported" : String(selected.result.exitCode)} />
              <Detail label="Process ID" value={selected.result?.pid === undefined ? "Not reported" : String(selected.result.pid)} />
              <Detail label="Request" value={selected.result?.requestId ?? "Pending"} />
            </dl>
            {selected.error || selected.outputError ? (
              <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="alert">
                {selected.error ?? selected.outputError}
              </p>
            ) : null}
            {selected.result?.message && !(selected.state === "completed" && selected.result.message === "Process execution completed.") ? (
              <p className="mt-2 text-xs text-muted">{selected.result.message}</p>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Segment
                  aria-label="Captured output stream"
                  selectedKey={stream}
                  size="sm"
                  variant="ghost"
                  onSelectionChange={(key) => setStream(String(key) as OutputStream)}
                >
                  <Segment.Item id="stdout">Stdout</Segment.Item>
                  {!ignoreStderr ? <Segment.Item id="stderr">Stderr</Segment.Item> : null}
                </Segment>
                <div aria-label="Output actions" className="flex flex-wrap items-center gap-2" role="group">
                  <Button className="h-7 px-2.5 text-xs" isDisabled={!output?.data.byteLength} size="sm" variant="tertiary" onPress={() => void copyOutput()}>
                    <FontAwesomeIcon aria-hidden className="size-3.5" icon={faCopy} />
                    Copy output
                  </Button>
                  <Button className="h-7 px-2.5 text-xs" isDisabled={!canSave} isPending={savingStream === stream} size="sm" variant="tertiary" onPress={() => selected.result && onSave(selected.result, stream)}>
                    <FontAwesomeIcon aria-hidden className="size-3.5" icon={faDownload} />
                    Save {stream}
                  </Button>
                  {output?.data.byteLength ? (
                    <Button
                      className="h-7 px-2.5 text-xs"
                      isDisabled={!canSave}
                      isPending={addingToLoot}
                      size="sm"
                      variant="outline"
                      onPress={() => selected.result && onAddToLoot(selected.result, stream, "")}
                    >
                      <FontAwesomeIcon aria-hidden className="size-3.5" icon={faBoxOpen} />
                      Add {stream} to Loot
                    </Button>
                  ) : null}
                  {selected.result && (selected.state === "outcome-unknown" || selected.state === "submitted") ? (
                    <Button className="h-7 px-2.5 text-xs" size="sm" variant="outline" onPress={() => onRefresh(selected)}>
                      <FontAwesomeIcon aria-hidden className="size-3.5" icon={faRotate} />
                      Refresh result
                    </Button>
                  ) : null}
                </div>
              </div>
              <Switch className="flex items-center gap-2" isSelected={ignoreStderr} style={{ flexDirection: "row" }} onChange={setIgnoreStderr}>
                <Switch.Content className="text-xs text-muted">Ignore stderr</Switch.Content>
                <Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch>
            </div>
            <div className="mt-2 min-h-40 flex-1 overflow-hidden rounded-xl bg-surface-secondary">
              {output?.data.byteLength ? (
                <ExecutionOutputTerminal
                  bytes={output.data}
                  className="h-full min-h-0"
                  resetKey={`${selected.id}:${stream}`}
                />
              ) : (
                <div className="flex h-full min-h-40 items-center justify-center px-5 text-center text-sm text-muted">
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
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="mt-1 break-all font-mono text-foreground">{value}</dd></div>;
}

function commandLabel(record: ProcessExecutionRecord): string {
  return [record.path, ...record.args.map((arg) => /\s|["']/u.test(arg) || !arg ? JSON.stringify(arg) : arg)].join(" ");
}

function historyStatusIcon(record: ProcessExecutionRecord): { icon: IconDefinition; color: string } {
  if (record.state === "running" || record.state === "submitted") {
    return { icon: faClock, color: "text-warning" };
  }
  if (record.state === "outcome-unknown") {
    return { icon: faCircleQuestion, color: "text-warning" };
  }
  if (record.state === "completed") {
    return record.result?.exitCode !== undefined && record.result.exitCode !== 0
      ? { icon: faCircleExclamation, color: "text-danger" }
      : { icon: faCircleCheck, color: "text-success" };
  }
  return { icon: faCircleExclamation, color: "text-danger" };
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
