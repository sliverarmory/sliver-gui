import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BeaconTaskDetail, BeaconTaskSummary } from "../../../shared/operation-contracts";

export interface BeaconTaskOutputEntry {
  task: BeaconTaskSummary;
  detail: BeaconTaskDetail | undefined;
  isLoading: boolean;
  error: string | undefined;
}

interface OutputRecord {
  entry: BeaconTaskOutputEntry;
  summaryKey: string;
  revision: string;
  attemptedRevision: string | undefined;
  requestSequence: number;
}

interface OutputStore {
  records: Map<string, OutputRecord>;
  disposed: boolean;
}

interface OutputRequest {
  store: OutputStore;
  record: OutputRecord;
  task: BeaconTaskSummary;
  revision: string;
  requestSequence: number;
}

interface OutputScheduler {
  activeCount: number;
  queue: OutputRequest[];
  currentStore: OutputStore;
  isActive: boolean;
  notify: () => void;
}

const MAX_CONCURRENT_OUTPUTS = 4;

/** Keeps decoded output history local to one exact beacon identity. */
export function useBeaconTaskOutputs(targetIdentity: string, tasks: BeaconTaskSummary[]): {
  entries: BeaconTaskOutputEntry[];
  loadOutput: (task: BeaconTaskSummary, retry?: boolean) => void;
} {
  const [, setVersion] = useState(0);
  const store = useMemo<OutputStore>(() => ({ records: new Map(), disposed: false }), [targetIdentity]);
  const schedulerRef = useRef<OutputScheduler>({
    activeCount: 0,
    queue: [],
    currentStore: store,
    isActive: false,
    notify: () => setVersion((version) => version + 1),
  });
  const scheduler = schedulerRef.current;
  // Store identity, rather than the target string alone, also rejects A -> B -> A responses.
  scheduler.currentStore = store;

  useEffect(() => {
    scheduler.isActive = true;
    store.disposed = false;
    pump(scheduler);
    return () => {
      store.disposed = true;
      scheduler.isActive = false;
      scheduler.queue = scheduler.queue.filter((request) => {
        if (request.store !== store) return true;
        if (request.record.requestSequence === request.requestSequence) {
          request.record.requestSequence += 1;
          request.record.attemptedRevision = undefined;
          request.record.entry = { ...request.record.entry, isLoading: false };
        }
        return false;
      });
    };
  }, [scheduler, store]);

  useEffect(() => {
    let changed = false;
    for (const task of tasks) {
      if (!store.records.has(task.taskId) && !hasOutput(task)) continue;
      const previous = store.records.get(task.taskId)?.entry;
      const record = reconcileTask(store, task);
      // Once a queued task is opened, keep its status current before it produces output.
      enqueue(scheduler, store, record, false, false);
      if (record.entry !== previous) changed = true;
    }
    if (changed) notify(scheduler, store);
    pump(scheduler);
  }, [scheduler, store, tasks]);

  const loadOutput = useCallback((task: BeaconTaskSummary, retry = false): void => {
    if (!isCurrentStore(scheduler, store)) return;
    const record = reconcileTask(store, task);
    enqueue(scheduler, store, record, retry, true);
    notify(scheduler, store);
    pump(scheduler);
  }, [scheduler, store]);

  const entries = [...store.records.values()].map((record) => record.entry).sort((left, right) =>
    taskTime(right.task) - taskTime(left.task) || left.task.taskId.localeCompare(right.task.taskId)
  );
  return { entries, loadOutput };
}

function hasOutput(task: BeaconTaskSummary): boolean {
  return task.resultAvailable || task.state === "completed" || task.state === "failed" || task.state === "canceled";
}

function taskRevision(task: BeaconTaskSummary): string {
  return JSON.stringify([
    task.state,
    task.resultAvailable,
    task.sentAt,
    task.completedAt,
    "error" in task ? task.error : undefined,
  ]);
}

function taskTime(task: BeaconTaskSummary): number {
  const time = task.createdAt ? Date.parse(task.createdAt) : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function reconcileTask(store: OutputStore, task: BeaconTaskSummary): OutputRecord {
  const revision = taskRevision(task);
  const summaryKey = JSON.stringify(task);
  let record = store.records.get(task.taskId);
  if (!record) {
    record = {
      entry: { task, detail: undefined, isLoading: false, error: undefined },
      summaryKey,
      revision,
      attemptedRevision: undefined,
      requestSequence: 0,
    };
    store.records.set(task.taskId, record);
  } else if (record.revision !== revision) {
    record.requestSequence += 1;
    record.revision = revision;
    record.summaryKey = summaryKey;
    record.attemptedRevision = undefined;
    record.entry = { task, detail: undefined, isLoading: false, error: undefined };
  } else if (record.summaryKey !== summaryKey) {
    record.summaryKey = summaryKey;
    record.entry = { ...record.entry, task };
  }
  return record;
}

function enqueue(
  scheduler: OutputScheduler,
  store: OutputStore,
  record: OutputRecord,
  retry: boolean,
  priority: boolean,
): void {
  if (record.attemptedRevision === record.revision && (!retry || record.entry.isLoading)) {
    if (priority) {
      const index = scheduler.queue.findIndex((request) => request.store === store &&
        request.record === record && request.requestSequence === record.requestSequence);
      if (index > 0) scheduler.queue.unshift(...scheduler.queue.splice(index, 1));
    }
    return;
  }
  record.requestSequence += 1;
  record.attemptedRevision = record.revision;
  record.entry = { ...record.entry, detail: undefined, isLoading: true, error: undefined };
  const request: OutputRequest = {
    store,
    record,
    task: record.entry.task,
    revision: record.revision,
    requestSequence: record.requestSequence,
  };
  if (priority) scheduler.queue.unshift(request);
  else scheduler.queue.push(request);
}

function isCurrentStore(scheduler: OutputScheduler, store: OutputStore): boolean {
  return scheduler.isActive && scheduler.currentStore === store && !store.disposed;
}

function isCurrentRequest(scheduler: OutputScheduler, request: OutputRequest): boolean {
  return isCurrentStore(scheduler, request.store) &&
    request.record.requestSequence === request.requestSequence &&
    request.record.revision === request.revision;
}

function notify(scheduler: OutputScheduler, store: OutputStore): void {
  if (isCurrentStore(scheduler, store)) scheduler.notify();
}

function pump(scheduler: OutputScheduler): void {
  while (scheduler.isActive && scheduler.activeCount < MAX_CONCURRENT_OUTPUTS && scheduler.queue.length > 0) {
    const request = scheduler.queue.shift();
    if (!request || !isCurrentRequest(scheduler, request)) continue;
    scheduler.activeCount += 1;
    void fetchOutput(scheduler, request);
  }
}

async function fetchOutput(scheduler: OutputScheduler, request: OutputRequest): Promise<void> {
  try {
    const result = await window.sliver.getBeaconTask({ taskId: request.task.taskId });
    if (!isCurrentRequest(scheduler, request)) return;
    if (!result.ok || !result.value) {
      request.record.entry = {
        ...request.record.entry,
        isLoading: false,
        error: result.error ?? "Could not load task output.",
      };
    } else if (result.value.taskId !== request.task.taskId || result.value.beaconId !== request.task.beaconId) {
      request.record.entry = {
        ...request.record.entry,
        isLoading: false,
        error: "The server returned output for a different task.",
      };
    } else {
      request.record.entry = { ...request.record.entry, detail: result.value, isLoading: false, error: undefined };
    }
    notify(scheduler, request.store);
  } catch (error) {
    if (!isCurrentRequest(scheduler, request)) return;
    request.record.entry = {
      ...request.record.entry,
      isLoading: false,
      error: error instanceof Error ? error.message : "Could not load task output.",
    };
    notify(scheduler, request.store);
  } finally {
    // Obsolete requests still occupy their slot until they settle, even after an identity switch.
    scheduler.activeCount -= 1;
    pump(scheduler);
  }
}
