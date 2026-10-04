import { useEffect, useMemo, useRef, useState } from "react";
import { Button, toast } from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCopy } from "@fortawesome/free-solid-svg-icons";

import type { BeaconTaskDetail } from "../../../shared/operation-contracts";
import { escapeTerminalOutput } from "../../../shared/terminal-output";
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";

type OutputStream = "stdout" | "stderr";
const ACCESSIBLE_TRANSCRIPT_BYTES = 64 * 1_024;

export function BeaconExecutionTaskOutput({ task }: { task: BeaconTaskDetail }): React.JSX.Element {
  return <ExecutionTaskOutput key={JSON.stringify([task.beaconId, task.taskId, task.execution?.operationId])} task={task} />;
}

function ExecutionTaskOutput({ task }: { task: BeaconTaskDetail }): React.JSX.Element {
  const execution = task.execution;
  const [stream, setStream] = useState<OutputStream>(
    execution?.stdout?.data.byteLength || !execution?.stderr?.data.byteLength ? "stdout" : "stderr",
  );
  const output = execution?.[stream];
  const paneRef = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const transcript = useMemo(() => {
    if (!output) return "";
    const text = escapeTerminalOutput(new TextDecoder().decode(output.data.subarray(0, ACCESSIBLE_TRANSCRIPT_BYTES)));
    return output.data.byteLength > ACCESSIBLE_TRANSCRIPT_BYTES
      ? `${text}\n[Accessible transcript limited to the first 64 KiB.]`
      : text;
  }, [output]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || typeof IntersectionObserver === "undefined") return;
    let active = true;
    const observer = new IntersectionObserver(([entry]) => {
      if (active && entry) setIsVisible(entry.isIntersecting);
    }, { root: pane.closest('[aria-label="Beacon task outputs"]'), rootMargin: "200px 0px", threshold: 0 });
    observer.observe(pane);
    // Queue navigation focuses the containing article before scrolling it.
    // Mount immediately for keyboard access instead of waiting for a frame.
    const article = pane.closest("article[data-task-id]");
    const reveal = (): void => setIsVisible(true);
    article?.addEventListener("focusin", reveal);
    return () => {
      active = false;
      observer.disconnect();
      article?.removeEventListener("focusin", reveal);
    };
  }, []);

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
    <section aria-label="Beacon execution output" className="flex min-w-0 flex-col gap-3">
      {execution?.pid !== undefined || execution?.exitCode !== undefined ? (
        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          {execution.pid !== undefined ? <ResultField label="PID" value={execution.pid} /> : null}
          {execution.exitCode !== undefined ? <ResultField label="Exit code" value={execution.exitCode} /> : null}
        </dl>
      ) : null}
      {execution?.outputError ? (
        <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="alert">{execution.outputError}</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segment
          aria-label="Captured output stream"
          selectedKey={stream}
          size="sm"
          variant="ghost"
          onSelectionChange={(key) => setStream(String(key) as OutputStream)}
        >
          <Segment.Item id="stdout">Stdout</Segment.Item>
          <Segment.Item id="stderr">Stderr</Segment.Item>
        </Segment>
        <Button isDisabled={!output?.data.byteLength} size="sm" variant="tertiary" onPress={() => void copyOutput()}>
          <FontAwesomeIcon aria-hidden icon={faCopy} /> Copy output
        </Button>
      </div>
      <div className="flex h-64 min-h-0 flex-col overflow-hidden rounded-xl bg-surface-secondary" ref={paneRef}>
        {output?.data.byteLength ? (
          isVisible ? (
            <ExecutionOutputTerminal bytes={output.data} className="min-h-0 flex-1" resetKey={`${task.beaconId}:${task.taskId}:${stream}`} />
          ) : (
            <>
              <p aria-hidden className="flex h-full items-center justify-center px-5 text-center text-sm text-muted">Loading output…</p>
              <pre className="sr-only" aria-label="Execution output transcript">{transcript}</pre>
            </>
          )
        ) : (
          <p className="flex h-full items-center justify-center px-5 text-center text-sm text-muted" role="status">{emptyOutputMessage(task, stream)}</p>
        )}
      </div>
      {output?.truncated ? <p className="text-xs text-warning" role="note">The captured {stream} was truncated at the output limit.</p> : null}
    </section>
  );
}

function ResultField({ label, value }: { label: string; value: number }): React.JSX.Element {
  return <div className="flex items-baseline gap-2"><dt className="text-muted">{label}</dt><dd className="font-mono text-foreground">{value}</dd></div>;
}

function emptyOutputMessage(task: BeaconTaskDetail, stream: OutputStream): string {
  if (task.state === "pending" || task.state === "sent") return "Waiting for the beacon execution result.";
  if (task.execution?.outputError) return `Captured ${stream} is unavailable.`;
  if (task.state === "canceled") return `The task was canceled. No ${stream} was captured.`;
  if (task.state === "failed") return `The task failed. No ${stream} was captured.`;
  return `No ${stream} was returned for this task.`;
}
