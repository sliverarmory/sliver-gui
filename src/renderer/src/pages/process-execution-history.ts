import { useCallback, useEffect, useRef, useState } from "react";

import type { ProcessExecutionRecord } from "../../../shared/execution-contracts";
import type { TargetRef } from "../../../shared/target-contracts";

export type { ProcessExecutionRecord } from "../../../shared/execution-contracts";

const EMPTY_HISTORY: readonly ProcessExecutionRecord[] = Object.freeze([]);

interface HistoryView {
  readonly key: string;
  readonly revision: number;
  readonly records: readonly ProcessExecutionRecord[];
  readonly error?: string;
}

/** Reads the main-owned history shared by windows showing this exact session. */
export function useProcessExecutionHistory(
  target: TargetRef | undefined,
  contextIdentity: string,
): { records: readonly ProcessExecutionRecord[]; error?: string; refresh: () => Promise<void> } {
  const key = target?.mode === "session"
    ? JSON.stringify([contextIdentity, target.mode, target.id, target.backendEpoch, target.fingerprint])
    : undefined;
  const [view, setView] = useState<HistoryView>();
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  // Each accepted IPC snapshot owns its bytes. Release the previous snapshot
  // after React has committed its replacement, including on unmount.
  useEffect(() => () => clearOutput(view?.records), [view?.records]);

  useEffect(() => {
    setView((current) => current?.key === key ? current : undefined);
    if (!key || !target) {
      refreshRef.current = async () => undefined;
      return;
    }

    let active = true;
    let loading = false;
    let queued = false;
    let notifiedRevision = 0;
    let acceptedRevision = view?.key === key ? view.revision : -1;
    const expected = target;
    const load = async (): Promise<void> => {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      try {
        do {
          queued = false;
          try {
            const response = await window.sliver.listProcessExecutionHistory();
            if (!active) {
              if (response.ok && response.value) clearOutput(response.value.records);
              return;
            }
            if (!response.ok || !response.value) {
              setView((current) => ({
                key,
                revision: current?.key === key ? current.revision : 0,
                records: current?.key === key ? current.records : EMPTY_HISTORY,
                error: response.error ?? "Execution history is unavailable",
              }));
              continue;
            }
            const snapshot = response.value;
            if (!sameTargetIdentity(snapshot.target, expected)) {
              clearOutput(snapshot.records);
              continue;
            }
            // A change event can overtake an older list response. The queued
            // request below will fetch the revision announced by that event.
            if (snapshot.revision < notifiedRevision || snapshot.revision < acceptedRevision) {
              clearOutput(snapshot.records);
              continue;
            }
            let ownedRecords: readonly ProcessExecutionRecord[];
            try {
              ownedRecords = cloneRecords(snapshot.records);
            } finally {
              // Electron already structured-cloned this response into the
              // renderer. Keep only the copy owned by the mounted view.
              clearOutput(snapshot.records);
            }
            acceptedRevision = snapshot.revision;
            setView({ key, revision: snapshot.revision, records: ownedRecords });
          } catch (error) {
            if (!active) return;
            setView((current) => ({
              key,
              revision: current?.key === key ? current.revision : 0,
              records: current?.key === key ? current.records : EMPTY_HISTORY,
              error: error instanceof Error ? error.message : "Execution history is unavailable",
            }));
          }
        } while (active && queued);
      } finally {
        loading = false;
      }
    };
    refreshRef.current = load;
    const unsubscribe = window.sliver.onProcessExecutionHistoryChanged((changedTarget, revision) => {
      if (!active || !sameTargetIdentity(changedTarget, expected)) return;
      notifiedRevision = Math.max(notifiedRevision, revision);
      void load();
    });
    void load();
    return () => {
      active = false;
      refreshRef.current = async () => undefined;
      unsubscribe();
    };
  }, [key]);

  if (view && view.key === key) {
    return { records: view.records, ...(view.error ? { error: view.error } : {}), refresh };
  }
  return { records: EMPTY_HISTORY, refresh };
}

function cloneRecords(records: readonly ProcessExecutionRecord[]): readonly ProcessExecutionRecord[] {
  return records.map((record) => ({
    ...record,
    args: [...record.args],
    ...(record.result ? { result: {
      ...record.result,
      ...(record.result.output ? { output: record.result.output.map((item) => ({ ...item })) } : {}),
    } } : {}),
    ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
    ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
  }));
}

function clearOutput(records: readonly ProcessExecutionRecord[] | undefined): void {
  for (const record of records ?? EMPTY_HISTORY) {
    record.stdout?.data.fill(0);
    record.stderr?.data.fill(0);
  }
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode &&
    left.id === right.id &&
    left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}
