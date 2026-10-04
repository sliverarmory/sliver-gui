import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { ProcessExecutionHistorySnapshot, ProcessExecutionRecord } from "../../../shared/execution-contracts";
import type { TargetRef } from "../../../shared/target-contracts";
import { useProcessExecutionHistory } from "./process-execution-history";

const target: TargetRef = {
  mode: "session",
  id: "session-one",
  backendEpoch: 7,
  domainRevision: 2,
  fingerprint: "a".repeat(64),
};

afterEach(() => cleanup());

function record(id: string): ProcessExecutionRecord {
  return {
    id,
    startedAt: "2026-09-25T00:00:00.000Z",
    path: "/usr/bin/id",
    args: ["-u"],
    state: "completed",
    stdout: { data: new TextEncoder().encode(id), truncated: false },
  };
}

function historyMock(initial: ProcessExecutionHistorySnapshot) {
  let snapshot = initial;
  const listeners = new Set<(target: TargetRef, revision: number) => void>();
  const listProcessExecutionHistory = vi.fn(async () => ({ ok: true as const, value: ipcSnapshot(snapshot) }));
  const onProcessExecutionHistoryChanged = vi.fn((listener: (target: TargetRef, revision: number) => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  });
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: { listProcessExecutionHistory, onProcessExecutionHistoryChanged } as unknown as SliverDesktopAPI,
  });
  return {
    listProcessExecutionHistory,
    onProcessExecutionHistoryChanged,
    publish(next: ProcessExecutionHistorySnapshot) {
      snapshot = next;
      for (const listener of listeners) listener(next.target, next.revision);
    },
    listenerCount: () => listeners.size,
  };
}

function ipcSnapshot(snapshot: ProcessExecutionHistorySnapshot): ProcessExecutionHistorySnapshot {
  return {
    ...snapshot,
    records: snapshot.records.map((item) => ({
      ...item,
      ...(item.stdout ? { stdout: { ...item.stdout, data: Uint8Array.from(item.stdout.data) } } : {}),
      ...(item.stderr ? { stderr: { ...item.stderr, data: Uint8Array.from(item.stderr.data) } } : {}),
    })),
  };
}

describe("shared process execution history view", () => {
  it("hydrates on mount and follows main-owned changes across mounted views", async () => {
    const api = historyMock({ target, revision: 1, records: [record("first")] });
    const left = renderHook(() => useProcessExecutionHistory(target, "same-session"));
    const right = renderHook(() => useProcessExecutionHistory(target, "same-session"));

    await waitFor(() => expect(left.result.current.records.map(({ id }) => id)).toEqual(["first"]));
    expect(right.result.current.records.map(({ id }) => id)).toEqual(["first"]);
    expect(api.listenerCount()).toBe(2);
    const oldLeftOutput = left.result.current.records[0]!.stdout!.data;
    const oldRightOutput = right.result.current.records[0]!.stdout!.data;

    act(() => api.publish({ target: { ...target, domainRevision: 3 }, revision: 2, records: [record("second"), record("first")] }));
    await waitFor(() => expect(left.result.current.records.map(({ id }) => id)).toEqual(["second", "first"]));
    expect(right.result.current.records.map(({ id }) => id)).toEqual(["second", "first"]);
    await waitFor(() => expect([...oldLeftOutput]).toEqual([0, 0, 0, 0, 0]));
    expect([...oldRightOutput]).toEqual([0, 0, 0, 0, 0]);
    const currentOutput = right.result.current.records[0]!.stdout!.data;
    expect(new TextDecoder().decode(currentOutput)).toBe("second");

    left.unmount();
    expect(api.listenerCount()).toBe(1);
    right.unmount();
    expect(api.listenerCount()).toBe(0);
    expect([...currentOutput]).toEqual(new Array(6).fill(0));
  });

  it("clears retired bytes on history clear and exact-session switch without mutating the next snapshot", async () => {
    const first = record("private");
    const api = historyMock({ target, revision: 1, records: [first] });
    const history = renderHook(({ selected }) => useProcessExecutionHistory(selected, "route"), {
      initialProps: { selected: target },
    });
    await waitFor(() => expect(history.result.current.records).toHaveLength(1));
    const firstBytes = history.result.current.records[0]!.stdout!.data;
    expect(firstBytes).not.toBe(first.stdout!.data);

    act(() => api.publish({ target, revision: 2, records: [] }));
    await waitFor(() => expect(history.result.current.records).toHaveLength(0));
    expect([...firstBytes]).toEqual(new Array(7).fill(0));
    expect(new TextDecoder().decode(first.stdout!.data)).toBe("private");

    act(() => api.publish({ target, revision: 3, records: [record("second")] }));
    await waitFor(() => expect(history.result.current.records[0]?.id).toBe("second"));
    const secondBytes = history.result.current.records[0]!.stdout!.data;
    const changed = { ...target, fingerprint: "b".repeat(64) };
    history.rerender({ selected: changed });
    await waitFor(() => expect(history.result.current.records).toHaveLength(0));
    await waitFor(() => expect([...secondBytes]).toEqual(new Array(6).fill(0)));
  });

  it("scrubs the temporary IPC copy after accepting or rejecting a snapshot", async () => {
    const received = record("accepted");
    const api = historyMock({ target, revision: 0, records: [] });
    api.listProcessExecutionHistory.mockResolvedValueOnce({
      ok: true,
      value: { target, revision: 1, records: [received] },
    });
    const history = renderHook(() => useProcessExecutionHistory(target, "route"));
    await waitFor(() => expect(history.result.current.records[0]?.id).toBe("accepted"));
    expect([...received.stdout!.data]).toEqual(new Array(8).fill(0));
    expect(new TextDecoder().decode(history.result.current.records[0]!.stdout!.data)).toBe("accepted");

    const rejected = record("rejected");
    const wrongTarget = { ...target, fingerprint: "b".repeat(64) };
    api.listProcessExecutionHistory.mockResolvedValueOnce({
      ok: true,
      value: { target: wrongTarget, revision: 2, records: [rejected] },
    });
    await act(async () => history.result.current.refresh());
    expect([...rejected.stdout!.data]).toEqual(new Array(8).fill(0));
    expect(history.result.current.records[0]?.id).toBe("accepted");
  });

  it("ignores unrelated targets and an older list response that an event overtakes", async () => {
    const stale = deferred<{ ok: true; value: ProcessExecutionHistorySnapshot }>();
    const api = historyMock({ target, revision: 2, records: [record("new")] });
    api.listProcessExecutionHistory.mockReturnValueOnce(stale.promise);
    const history = renderHook(() => useProcessExecutionHistory(target, "same-session"));

    act(() => api.publish({ target: { ...target, fingerprint: "b".repeat(64) }, revision: 10, records: [record("wrong-target")] }));
    expect(api.listProcessExecutionHistory).toHaveBeenCalledOnce();
    act(() => api.publish({ target, revision: 2, records: [record("new")] }));
    const staleRecord = record("old");
    await act(async () => stale.resolve({ ok: true, value: { target, revision: 1, records: [staleRecord] } }));

    await waitFor(() => expect(history.result.current.records.map(({ id }) => id)).toEqual(["new"]));
    expect(api.listProcessExecutionHistory).toHaveBeenCalledTimes(2);
    expect([...staleRecord.stdout!.data]).toEqual([0, 0, 0]);
  });

  it("quarantines an in-flight response after the exact session changes", async () => {
    const stale = deferred<{ ok: true; value: ProcessExecutionHistorySnapshot }>();
    const changed = { ...target, fingerprint: "b".repeat(64) };
    const api = historyMock({ target: changed, revision: 1, records: [record("changed")] });
    api.listProcessExecutionHistory.mockReturnValueOnce(stale.promise);
    const history = renderHook(({ selected }) => useProcessExecutionHistory(selected, "route"), {
      initialProps: { selected: target },
    });

    history.rerender({ selected: changed });
    await waitFor(() => expect(history.result.current.records.map(({ id }) => id)).toEqual(["changed"]));
    const oldRecord = record("old");
    await act(async () => stale.resolve({ ok: true, value: { target, revision: 5, records: [oldRecord] } }));
    expect(history.result.current.records.map(({ id }) => id)).toEqual(["changed"]);
    expect([...oldRecord.stdout!.data]).toEqual([0, 0, 0]);
  });

  it("scrubs a late IPC response after the view unmounts", async () => {
    const late = deferred<{ ok: true; value: ProcessExecutionHistorySnapshot }>();
    const api = historyMock({ target, revision: 0, records: [] });
    api.listProcessExecutionHistory.mockReturnValueOnce(late.promise);
    const history = renderHook(() => useProcessExecutionHistory(target, "route"));
    history.unmount();

    const orphaned = record("secret");
    await act(async () => late.resolve({ ok: true, value: { target, revision: 1, records: [orphaned] } }));
    expect([...orphaned.stdout!.data]).toEqual(new Array(6).fill(0));
  });

  it("keeps the latest accepted records while a refresh fails", async () => {
    const api = historyMock({ target, revision: 1, records: [record("first")] });
    const history = renderHook(() => useProcessExecutionHistory(target, "route"));
    await waitFor(() => expect(history.result.current.records).toHaveLength(1));
    api.listProcessExecutionHistory.mockResolvedValueOnce({ ok: false, error: "History unavailable" } as never);

    await act(async () => history.result.current.refresh());
    expect(history.result.current.records.map(({ id }) => id)).toEqual(["first"]);
    expect(history.result.current.error).toBe("History unavailable");
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
