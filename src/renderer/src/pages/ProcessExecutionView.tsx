import { useEffect, useRef, useState } from "react";
import { Button, Chip, ScrollShadow, Switch, Tooltip, toast } from "@heroui/react";
import { Segment } from "@heroui-pro/react";
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
  faRotate,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";

import type {
  ExecutionActionDraft,
  ExecutionActionResult,
  ExecutionCapability,
} from "../../../shared/execution-contracts";
import type { TargetSummary } from "../../../shared/target-contracts";
import { ExecutionHistorySidebar } from "../components/ExecutionHistorySidebar";
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
  const historyRef = useRef(history);
  historyRef.current = history;
  const addingToLootRef = useRef(addingToLoot);
  addingToLootRef.current = addingToLoot;
  const selectedIndex = history.findIndex((record) => record.id === selectedId);
  const selected = selectedId === null ? undefined : history[selectedIndex < 0 ? 0 : selectedIndex];
  const showingNew = selected === undefined;
  const output = stream === "stdout" ? selected?.stdout : selected?.stderr;
  const outputMetadata = selected?.result?.output?.find((item) => item.stream === stream);
  const canSave = Boolean(outputMetadata && Date.parse(outputMetadata.expiresAt) > Date.now());
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStream("stdout");
  }, [selected?.id]);
  useEffect(() => { if (ignoreStderr) setStream("stdout"); }, [ignoreStderr]);
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    const content = scrollContentRef.current;
    if (!viewport || !content) return;
    const observer = new ResizeObserver(() => viewport.dispatchEvent(new Event("scroll")));
    observer.observe(content);
    return () => observer.disconnect();
  }, [showingNew, selected?.id]);

  const copyBytes = async (bytes: Uint8Array | undefined): Promise<void> => {
    if (!bytes?.byteLength) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(bytes));
      toast.success("Output copied");
    } catch {
      toast.danger("Could not copy output", { description: "Select text in the terminal and use Copy instead." });
    }
  };
  const copyOutput = (): Promise<void> => copyBytes(output?.data);
  const copyHistoryOutput = (id: string): Promise<void> =>
    copyBytes(historyRef.current.find((record) => record.id === id)?.stdout?.data);
  const addHistoryStdoutToLoot = (id: string): void => {
    const record = historyRef.current.find((item) => item.id === id);
    if (record?.result && !addingToLootRef.current && canAddStdoutToLoot(record)) {
      onAddToLoot(record.result, "stdout", "");
    }
  };

  return (
    <section
      aria-label="Process execution history and output"
      className="mt-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(20rem,1fr)] overflow-y-auto rounded-2xl border border-separator bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden"
    >
      <ExecutionHistorySidebar
        label="Process execution history"
        newExecutionKey="new-execution"
        executionKeyPrefix="execution:"
        items={history.map((record) => {
          const status = historyStatusIcon(record);
          return {
            id: record.id,
            title: commandLabel(record),
            startedAt: record.startedAt,
            stateLabel: stateLabel(record),
            statusIcon: status.icon,
            statusColor: status.color,
            contextActions: [
              {
                id: "copy-output",
                label: "Copy output",
                icon: faCopy,
                isDisabled: !record.stdout?.data.byteLength,
                onAction: () => copyHistoryOutput(record.id),
              },
              {
                id: "add-stdout-to-loot",
                label: "Add stdout to Loot",
                icon: faBoxOpen,
                isDisabled: addingToLoot || !canAddStdoutToLoot(record),
                onAction: () => addHistoryStdoutToLoot(record.id),
              },
            ],
          };
        })}
        selectedId={selected?.id}
        onClearAll={onClearAll}
        onSelect={onSelect}
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-visible sm:overflow-hidden">
        {showingNew ? (
          <section aria-label="Execute a subprocess" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 bg-surface p-4 sm:p-5">
              <h3 className="text-base font-semibold text-foreground">Execute a subprocess</h3>
              {capability?.available ? (
                <Button
                  form={PROCESS_FORM_ID}
                  isPending={isPreparing || isExecuting}
                  isDisabled={isPreparing || isExecuting || isRefreshing}
                  type="submit"
                  variant="primary"
                >
                  <FontAwesomeIcon aria-hidden className="size-3.5" icon={faPlay} />
                  Execute
                </Button>
              ) : null}
            </header>
            <ScrollShadow
              ref={scrollViewportRef}
              aria-label="Process execution content"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-4 sm:px-5 sm:pb-5"
              hideScrollBar={false}
              orientation="vertical"
              role="region"
              size={24}
              tabIndex={0}
            >
              <div ref={scrollContentRef}>
                {!capability ? (
                  <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
                    Process execution is unavailable for this target.
                  </p>
                ) : !capability.available ? (
                  <p className="rounded-xl bg-warning-soft px-4 py-3 text-sm text-warning-soft-foreground">
                    {capability.reason?.message ?? "Process execution is unavailable for this target."}
                  </p>
                ) : (
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
                )}
              </div>
            </ScrollShadow>
          </section>
        ) : selected ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="sticky top-0 z-10 flex shrink-0 flex-wrap items-start justify-between gap-2 bg-surface p-4 pb-3 sm:p-5 sm:pb-4">
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
            </header>

            <ScrollShadow
              ref={scrollViewportRef}
              aria-label="Process execution content"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 sm:px-5"
              hideScrollBar={false}
              orientation="vertical"
              role="region"
              size={24}
              tabIndex={0}
            >
              <div ref={scrollContentRef} className="flex min-h-full min-w-0 flex-col">
                <dl aria-label="Execution details" className="grid gap-3 rounded-xl bg-surface-secondary p-3 text-xs sm:grid-cols-[minmax(0,7rem)_minmax(0,8rem)_minmax(0,1fr)]">
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
                <div className="-mr-4 mt-2 flex min-h-40 flex-1 flex-col overflow-hidden rounded-xl bg-surface-secondary sm:-mr-5">
                  {output?.data.byteLength ? (
                    <ExecutionOutputTerminal
                      bytes={output.data}
                      className="min-h-0 flex-1"
                      resetKey={`${selected.id}:${stream}`}
                    />
                  ) : (
                    <div className="flex min-h-40 flex-1 items-center justify-center px-5 text-center text-sm text-muted">
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
                {output?.truncated ? <p className="mt-2 pb-4 text-xs text-warning sm:pb-5">The captured {stream} was truncated at the output limit.</p> : null}
              </div>
            </ScrollShadow>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function canAddStdoutToLoot(record: ProcessExecutionRecord): boolean {
  if (!record.stdout?.data.byteLength || !record.result) return false;
  const metadata = record.result.output?.find((item) => item.stream === "stdout");
  return Boolean(metadata && Date.parse(metadata.expiresAt) > Date.now());
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
