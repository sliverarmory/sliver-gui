import { useCallback, useSyncExternalStore } from "react";

import type {
  ExecutionActionResult,
  ExecutionResultState,
} from "../../../shared/execution-contracts";

export const PROCESS_EXECUTION_HISTORY_MAX_ENTRIES = 50;
export const PROCESS_EXECUTION_HISTORY_MAX_OUTPUT_BYTES = 32 * 1_024 * 1_024;

export interface ProcessExecutionOutput {
  readonly data: Uint8Array;
  readonly truncated: boolean;
}

export interface ProcessExecutionRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly path: string;
  readonly args: readonly string[];
  readonly state: "running" | "request-failed" | ExecutionResultState;
  readonly result?: ExecutionActionResult;
  readonly error?: string;
  readonly stdout?: ProcessExecutionOutput;
  readonly stderr?: ProcessExecutionOutput;
  readonly outputError?: string;
}

export type ProcessExecutionPatch = Partial<Pick<ProcessExecutionRecord,
  "state" | "result" | "error" | "stdout" | "stderr" | "outputError"
>>;

interface HistoryEntry {
  readonly order: number;
  readonly record: ProcessExecutionRecord;
}

interface HistoryBucket {
  entries: HistoryEntry[];
  snapshot: readonly ProcessExecutionRecord[];
  readonly listeners: Set<() => void>;
}

const EMPTY_HISTORY: readonly ProcessExecutionRecord[] = Object.freeze([]);
const histories = new Map<string, HistoryBucket>();
let entryCount = 0;
let outputByteCount = 0;
let nextOrder = 0;

/** The newest invocation is first. History lives only as long as this renderer. */
export function useProcessExecutionHistory(key: string | undefined): readonly ProcessExecutionRecord[] {
  const subscribe = useCallback((listener: () => void) => subscribeToHistory(key, listener), [key]);
  const getSnapshot = useCallback(() => historySnapshot(key), [key]);
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_HISTORY);
}

export function addProcessExecution(key: string, record: ProcessExecutionRecord): void {
  const bucket = historyBucket(key);
  if (bucket.entries.some((entry) => entry.record.id === record.id)) return;

  const owned = cloneRecord(record);
  bucket.entries.unshift({ order: ++nextOrder, record: owned });
  entryCount += 1;
  outputByteCount += outputBytes(owned);
  const changed = new Set<HistoryBucket>([bucket]);
  evictOldestUntilBounded(changed);
  publish(changed);
}

/** A late result for a cleared or evicted invocation is ignored. */
export function updateProcessExecution(key: string, id: string, patch: ProcessExecutionPatch): void {
  const bucket = histories.get(key);
  if (!bucket) return;
  const index = bucket.entries.findIndex((entry) => entry.record.id === id);
  if (index < 0) return;

  const previous = bucket.entries[index]!;
  const owned = cloneRecord({ ...previous.record, ...patch });
  bucket.entries[index] = { order: previous.order, record: owned };
  outputByteCount += outputBytes(owned) - outputBytes(previous.record);
  clearOutput(previous.record);
  const changed = new Set<HistoryBucket>([bucket]);
  evictOldestUntilBounded(changed);
  publish(changed);
}

/** Pass an ID to remove one invocation, or omit it to clear this target's history. */
export function clearProcessExecution(key: string, id?: string): void {
  const bucket = histories.get(key);
  if (!bucket) return;
  if (id === undefined) {
    if (bucket.entries.length === 0) return;
    for (const entry of bucket.entries) release(entry.record);
    bucket.entries = [];
  } else {
    const index = bucket.entries.findIndex((entry) => entry.record.id === id);
    if (index < 0) return;
    const [removed] = bucket.entries.splice(index, 1);
    release(removed!.record);
  }
  publish(new Set([bucket]));
}

function subscribeToHistory(key: string | undefined, listener: () => void): () => void {
  if (key === undefined) return () => undefined;
  const bucket = historyBucket(key);
  bucket.listeners.add(listener);
  return () => {
    bucket.listeners.delete(listener);
    if (bucket.entries.length === 0 && bucket.listeners.size === 0) histories.delete(key);
  };
}

function historySnapshot(key: string | undefined): readonly ProcessExecutionRecord[] {
  return key === undefined ? EMPTY_HISTORY : histories.get(key)?.snapshot ?? EMPTY_HISTORY;
}

function historyBucket(key: string): HistoryBucket {
  let bucket = histories.get(key);
  if (!bucket) {
    bucket = { entries: [], snapshot: EMPTY_HISTORY, listeners: new Set() };
    histories.set(key, bucket);
  }
  return bucket;
}

function evictOldestUntilBounded(changed: Set<HistoryBucket>): void {
  while (
    entryCount > PROCESS_EXECUTION_HISTORY_MAX_ENTRIES ||
    outputByteCount > PROCESS_EXECUTION_HISTORY_MAX_OUTPUT_BYTES
  ) {
    let oldestBucket: HistoryBucket | undefined;
    let oldestOrder = Number.POSITIVE_INFINITY;
    for (const bucket of histories.values()) {
      const candidate = bucket.entries.at(-1);
      if (candidate && candidate.order < oldestOrder) {
        oldestOrder = candidate.order;
        oldestBucket = bucket;
      }
    }
    if (!oldestBucket) break;
    const removed = oldestBucket.entries.pop()!;
    release(removed.record);
    changed.add(oldestBucket);
  }
}

function publish(changed: Set<HistoryBucket>): void {
  for (const bucket of changed) {
    bucket.snapshot = bucket.entries.length > 0
      ? Object.freeze(bucket.entries.map(({ record }) => record))
      : EMPTY_HISTORY;
    for (const listener of bucket.listeners) listener();
    if (bucket.entries.length === 0 && bucket.listeners.size === 0) {
      for (const [key, candidate] of histories) {
        if (candidate === bucket) {
          histories.delete(key);
          break;
        }
      }
    }
  }
}

function release(record: ProcessExecutionRecord): void {
  entryCount -= 1;
  outputByteCount -= outputBytes(record);
  clearOutput(record);
}

function outputBytes(record: ProcessExecutionRecord): number {
  return (record.stdout?.data.byteLength ?? 0) + (record.stderr?.data.byteLength ?? 0);
}

function clearOutput(record: ProcessExecutionRecord): void {
  record.stdout?.data.fill(0);
  record.stderr?.data.fill(0);
}

function cloneRecord(record: ProcessExecutionRecord): ProcessExecutionRecord {
  return Object.freeze({
    ...record,
    args: Object.freeze([...record.args]),
    ...(record.result ? { result: cloneResult(record.result) } : {}),
    ...(record.stdout ? { stdout: cloneOutput(record.stdout) } : {}),
    ...(record.stderr ? { stderr: cloneOutput(record.stderr) } : {}),
  });
}

function cloneOutput(output: ProcessExecutionOutput): ProcessExecutionOutput {
  return Object.freeze({ data: Uint8Array.from(output.data), truncated: output.truncated });
}

function cloneResult(result: ExecutionActionResult): ExecutionActionResult {
  return Object.freeze({
    ...result,
    ...(result.output ? {
      output: result.output.map((stream) => Object.freeze({ ...stream })),
    } : {}),
  });
}
