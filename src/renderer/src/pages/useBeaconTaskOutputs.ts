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
  lastUsed: number;
  opened: boolean;
}

interface OutputStore {
  records: Map<string, OutputRecord>;
  disposed: boolean;
  clock: number;
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
const MAX_CACHED_EXECUTION_BYTES = 32 * 1_024 * 1_024;
const RELEASED_OUTPUT_MESSAGE = "This output was released from memory. Load it again to view it.";

/** Keeps decoded output history local to one exact beacon identity. */
export function useBeaconTaskOutputs(targetIdentity: string, tasks: BeaconTaskSummary[]): {
  entries: BeaconTaskOutputEntry[];
  loadOutput: (task: BeaconTaskSummary, retry?: boolean) => void;
} {
  const [, setVersion] = useState(0);
  const store = useMemo<OutputStore>(() => ({ records: new Map(), disposed: false, clock: 0 }), [targetIdentity]);
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
      // Strict Mode immediately replays this effect using the same store.
      // Release bytes only if that store remains retired after the replay.
      queueMicrotask(() => {
        if (!store.disposed) return;
        for (const record of store.records.values()) clearExecutionBytes(record.entry.detail);
        store.records.clear();
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
    record.lastUsed = ++store.clock;
    record.opened = true;
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
      lastUsed: 0,
      opened: false,
    };
    store.records.set(task.taskId, record);
  } else if (record.revision !== revision) {
    clearExecutionBytes(record.entry.detail);
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
  clearExecutionBytes(record.entry.detail);
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
    if (!isCurrentRequest(scheduler, request)) {
      if (result.ok) clearExecutionBytes(result.value);
      return;
    }
    if (!result.ok || !result.value) {
      request.record.entry = {
        ...request.record.entry,
        isLoading: false,
        error: result.error ?? "Could not load task output.",
      };
    } else if (result.value.taskId !== request.task.taskId || result.value.beaconId !== request.task.beaconId) {
      clearExecutionBytes(result.value);
      request.record.entry = {
        ...request.record.entry,
        isLoading: false,
        error: "The server returned output for a different task.",
      };
    } else {
      clearExecutionBytes(request.record.entry.detail, result.value);
      request.record.entry = { ...request.record.entry, detail: result.value, isLoading: false, error: undefined };
      request.record.lastUsed = ++request.store.clock;
      boundExecutionCache(request.store, request.record);
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

function clearExecutionBytes(detail: BeaconTaskDetail | undefined, retained?: BeaconTaskDetail): void {
  const retainedBuffers = [retained?.execution?.stdout?.data, retained?.execution?.stderr?.data];
  for (const bytes of [detail?.execution?.stdout?.data, detail?.execution?.stderr?.data]) {
    if (bytes && !retainedBuffers.includes(bytes)) bytes.fill(0);
  }
}

function executionBytes(record: OutputRecord): number {
  const execution = record.entry.detail?.execution;
  return (execution?.stdout?.data.byteLength ?? 0) + (execution?.stderr?.data.byteLength ?? 0);
}

function boundExecutionCache(store: OutputStore, accepted: OutputRecord): void {
  let total = [...store.records.values()].reduce((sum, record) => sum + executionBytes(record), 0);
  if (total <= MAX_CACHED_EXECUTION_BYTES) return;
  const candidates = [...store.records.values()]
    .filter((record) => record !== accepted && executionBytes(record) > 0)
    .sort((left, right) => Number(left.opened) - Number(right.opened) || left.lastUsed - right.lastUsed);
  for (const record of candidates) {
    total -= executionBytes(record);
    clearExecutionBytes(record.entry.detail);
    record.entry = { ...record.entry, detail: undefined, error: RELEASED_OUTPUT_MESSAGE };
    // Keep attemptedRevision so inventory refresh cannot immediately fetch
    // released bytes again. Queue selection or Retry explicitly reloads them.
    if (total <= MAX_CACHED_EXECUTION_BYTES) break;
  }
}
