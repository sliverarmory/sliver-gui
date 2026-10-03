import { useEffect, useState } from "react";
import { Button, Modal } from "@heroui/react";

import type { BeaconTaskResponse, BeaconTaskSummary } from "../../../shared/operation-contracts";
import { BeaconFullResponse } from "./BeaconFullResponse";
import { buildBeaconFullResponse, type BeaconFullResponseModel } from "./beacon-full-response-model";

const MAX_COMPLETE_RESPONSE_CHARACTERS = 64 * 1024 * 1024;
const MAX_RESPONSE_PAGES = 1_025;

/** Full output exists only while the dialog is open. */
export function BeaconTaskDetails({ task }: { task: BeaconTaskSummary }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onPress={() => setIsOpen(true)}>Details</Button>
      {isOpen ? <BeaconTaskResponseDialog key={`${task.beaconId}:${task.taskId}`} task={task} onClose={() => setIsOpen(false)} /> : null}
    </>
  );
}

function BeaconTaskResponseDialog({ task, onClose }: {
  task: BeaconTaskSummary;
  onClose: () => void;
}): React.JSX.Element {
  const [retry, setRetry] = useState(0);
  const [output, setOutput] = useState<BeaconFullResponseModel>();
  const [error, setError] = useState<string>();
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let active = true;
    setOutput(undefined);
    setError(undefined);
    setProgress(0);
    void (async () => {
      const parts: string[] = [];
      let offset = 0;
      let format: BeaconTaskResponse["format"] | undefined;
      let totalCharacters: number | undefined;
      try {
        for (let index = 0; index < MAX_RESPONSE_PAGES; index += 1) {
          const result = await window.sliver.getBeaconTaskResponse({ taskId: task.taskId, offset });
          if (!active) return;
          if (!result.ok || !result.value) throw new Error(result.error ?? "Could not load the task output.");
          const page = result.value;
          if (page.taskId !== task.taskId || page.beaconId !== task.beaconId || page.offset !== offset) {
            throw new Error("The server returned a response for a different task or page.");
          }
          if (!Number.isSafeInteger(page.totalCharacters) || page.totalCharacters < 0 ||
            page.totalCharacters > MAX_COMPLETE_RESPONSE_CHARACTERS ||
            (totalCharacters !== undefined && page.totalCharacters !== totalCharacters) ||
            (format !== undefined && page.format !== format)) {
            throw new Error("The task response changed while it was loading. Retry to load it again.");
          }
          format = page.format;
          totalCharacters = page.totalCharacters;
          const end = offset + page.text.length;
          if (end > totalCharacters || (page.nextOffset !== undefined &&
            (page.nextOffset !== end || end <= offset || end >= totalCharacters))) {
            throw new Error("The server returned an incomplete task response.");
          }
          parts.push(page.text);
          if (page.nextOffset === undefined) {
            if (end !== totalCharacters) throw new Error("The server returned an incomplete task response.");
            setOutput(buildBeaconFullResponse(task, { format, text: parts.join("") }));
            return;
          }
          setProgress(Math.floor(end / totalCharacters * 100));
          offset = page.nextOffset;
        }
        throw new Error("The task response could not be fully loaded.");
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load the task output.");
      } finally {
        parts.length = 0;
      }
    })();
    return () => { active = false; };
  }, [task.beaconId, task.taskId, task.description, retry]);

  return (
    <Modal.Backdrop isOpen variant="blur" onOpenChange={(open) => { if (!open) onClose(); }}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="w-[calc(100vw-3rem)] max-w-[1280px] sm:max-w-[1280px]">
          <Modal.CloseTrigger aria-label="Dismiss details" />
          <Modal.Header className="pr-10">
            <Modal.Heading>Task details</Modal.Heading>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
              <span className="text-muted">Task GUID</span>
              <span className="break-all font-mono text-muted">{task.taskId}</span>
            </div>
          </Modal.Header>
          <Modal.Body className="min-h-0 min-w-0 space-y-4">
            {!output && !error ? <p className="py-8 text-sm text-muted" role="status">Loading task output…{progress > 0 ? ` ${progress}%` : ""}</p> : null}
            {error ? (
              <div className="space-y-3 py-4">
                <p className="text-sm text-danger" role="alert">{error}</p>
                <Button size="sm" variant="tertiary" onPress={() => setRetry((current) => current + 1)}>Retry</Button>
              </div>
            ) : null}
            {output ? <BeaconFullResponse model={output} /> : null}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="secondary">Close</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
