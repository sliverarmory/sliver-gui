import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  PROCESS_EXECUTION_HISTORY_MAX_ENTRIES,
  PROCESS_EXECUTION_HISTORY_MAX_OUTPUT_BYTES,
  addProcessExecution,
  clearProcessExecution,
  updateProcessExecution,
  useProcessExecutionHistory,
  type ProcessExecutionRecord,
} from "./process-execution-history";

const keys = new Set<string>();

afterEach(() => {
  for (const key of keys) clearProcessExecution(key);
  keys.clear();
});

function key(name: string): string {
  const value = `process-history-test-${name}`;
  keys.add(value);
  return value;
}

function record(id: string, output?: Uint8Array): ProcessExecutionRecord {
  return {
    id,
    startedAt: "2026-09-25T00:00:00.000Z",
    path: "/usr/bin/id",
    args: ["-u"],
    state: "running",
    ...(output ? { stdout: { data: output, truncated: false } } : {}),
  };
}

describe("process execution history", () => {
  it("retains newest-first snapshots across unmount and separates target keys", () => {
    const firstKey = key("target-a");
    const secondKey = key("target-b");
    const first = renderHook(({ targetKey }) => useProcessExecutionHistory(targetKey), {
      initialProps: { targetKey: firstKey as string | undefined },
    });
    const other = renderHook(() => useProcessExecutionHistory(secondKey));

    expect(first.result.current).toEqual([]);
    const emptySnapshot = first.result.current;
    first.rerender({ targetKey: firstKey });
    expect(first.result.current).toBe(emptySnapshot);

    act(() => {
      addProcessExecution(firstKey, record("one"));
      addProcessExecution(firstKey, record("two"));
      addProcessExecution(secondKey, record("other"));
    });
    expect(first.result.current.map(({ id }) => id)).toEqual(["two", "one"]);
    expect(other.result.current.map(({ id }) => id)).toEqual(["other"]);

    first.unmount();
    const remounted = renderHook(() => useProcessExecutionHistory(firstKey));
    expect(remounted.result.current.map(({ id }) => id)).toEqual(["two", "one"]);
    remounted.rerender();
    expect(remounted.result.current.map(({ id }) => id)).toEqual(["two", "one"]);
  });

  it("clones output and arguments, clears replaced bytes, and ignores a late update after deletion", () => {
    const targetKey = key("clear-one");
    const history = renderHook(() => useProcessExecutionHistory(targetKey));
    const input = record("one", Uint8Array.from([65, 66]));

    act(() => addProcessExecution(targetKey, input));
    const initial = history.result.current[0]!;
    input.stdout!.data.fill(90);
    (input.args as string[])[0] = "changed";
    expect([...initial.stdout!.data]).toEqual([65, 66]);
    expect(initial.args).toEqual(["-u"]);

    act(() => updateProcessExecution(targetKey, "one", {
      state: "completed",
      stderr: { data: Uint8Array.from([67]), truncated: true },
    }));
    expect([...initial.stdout!.data]).toEqual([0, 0]);
    const updated = history.result.current[0]!;
    expect(updated.state).toBe("completed");
    expect([...updated.stdout!.data]).toEqual([65, 66]);
    expect(updated.stderr?.truncated).toBe(true);

    act(() => clearProcessExecution(targetKey, "one"));
    expect([...updated.stdout!.data]).toEqual([0, 0]);
    expect([...updated.stderr!.data]).toEqual([0]);
    expect(history.result.current).toEqual([]);

    act(() => updateProcessExecution(targetKey, "one", { state: "failed", error: "late" }));
    expect(history.result.current).toEqual([]);
  });

  it("clears all invocations for one target while preserving another target", () => {
    const firstKey = key("clear-all-a");
    const secondKey = key("clear-all-b");
    const first = renderHook(() => useProcessExecutionHistory(firstKey));
    const second = renderHook(() => useProcessExecutionHistory(secondKey));

    act(() => {
      addProcessExecution(firstKey, record("a1"));
      addProcessExecution(firstKey, record("a2"));
      addProcessExecution(secondKey, record("b1"));
    });
    act(() => clearProcessExecution(firstKey));

    expect(first.result.current).toEqual([]);
    expect(second.result.current.map(({ id }) => id)).toEqual(["b1"]);
    act(() => updateProcessExecution(firstKey, "a1", { state: "completed" }));
    expect(first.result.current).toEqual([]);
  });

  it("evicts the oldest invocation across target keys at the entry limit", () => {
    const firstKey = key("entry-limit-a");
    const secondKey = key("entry-limit-b");
    const first = renderHook(() => useProcessExecutionHistory(firstKey));
    const second = renderHook(() => useProcessExecutionHistory(secondKey));

    act(() => {
      for (let index = 0; index < PROCESS_EXECUTION_HISTORY_MAX_ENTRIES; index += 1) {
        addProcessExecution(firstKey, record(`a-${index}`));
      }
      addProcessExecution(secondKey, record("b-0"));
    });

    expect(first.result.current).toHaveLength(PROCESS_EXECUTION_HISTORY_MAX_ENTRIES - 1);
    expect(first.result.current.at(-1)?.id).toBe("a-1");
    expect(second.result.current.map(({ id }) => id)).toEqual(["b-0"]);
  });

  it("evicts and clears the oldest output when the global byte limit is exceeded", () => {
    const firstKey = key("byte-limit-a");
    const secondKey = key("byte-limit-b");
    const first = renderHook(() => useProcessExecutionHistory(firstKey));
    const second = renderHook(() => useProcessExecutionHistory(secondKey));
    const mib = 1_024 * 1_024;
    expect(PROCESS_EXECUTION_HISTORY_MAX_OUTPUT_BYTES).toBe(32 * mib);

    act(() => addProcessExecution(firstKey, record("large-a", new Uint8Array(17 * mib).fill(65))));
    const evictedBytes = first.result.current[0]!.stdout!.data;
    act(() => addProcessExecution(secondKey, record("large-b", new Uint8Array(16 * mib).fill(66))));

    expect(first.result.current).toEqual([]);
    expect(evictedBytes[0]).toBe(0);
    expect(evictedBytes.at(-1)).toBe(0);
    expect(second.result.current[0]?.stdout?.data[0]).toBe(66);
    act(() => updateProcessExecution(firstKey, "large-a", { state: "completed" }));
    expect(first.result.current).toEqual([]);
  });
});
