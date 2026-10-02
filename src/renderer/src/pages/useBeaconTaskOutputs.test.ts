import { createElement, StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { BeaconTaskDetail, BeaconTaskSummary } from "../../../shared/operation-contracts";
import { useBeaconTaskOutputs } from "./useBeaconTaskOutputs";

afterEach(() => cleanup());

type TaskResult = Awaited<ReturnType<SliverDesktopAPI["getBeaconTask"]>>;

function task(taskId: string, overrides: Partial<BeaconTaskSummary> = {}): BeaconTaskSummary {
  return {
    taskId,
    beaconId: "beacon-one",
    state: "completed",
    description: taskId,
    createdAt: "2026-09-26T20:00:00.000Z",
    resultAvailable: true,
    cancellation: { available: false },
    ownership: { origin: "unknown", actor: { attribution: "unknown" } },
    ...overrides,
  };
}

function detail(summary: BeaconTaskSummary, text = summary.taskId): BeaconTaskDetail {
  return { ...summary, disposition: { kind: "inline-text", text, truncated: false } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function installAPI(getBeaconTask: SliverDesktopAPI["getBeaconTask"]) {
  Object.defineProperty(window, "sliver", { configurable: true, value: { getBeaconTask } });
}

describe("useBeaconTaskOutputs", () => {
  it("waits to fetch saved task content until the output view is active", async () => {
    const saved = task("historical-output");
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockResolvedValue({
      ok: true, value: detail(saved, "saved output"),
    });
    installAPI(getBeaconTask);
    const view = renderHook(({ enabled }) => useBeaconTaskOutputs("exact-one", [saved], enabled), {
      initialProps: { enabled: false },
    });

    expect(view.result.current.entries).toHaveLength(1);
    expect(getBeaconTask).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.result.current.entries[0]?.detail?.disposition).toMatchObject({ text: "saved output" }));
  });

  it("keeps untouched history idle while fetching and refreshing an opened task", async () => {
    const opened = task("opened");
    const untouched = task("untouched");
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(async ({ taskId }) => ({
      ok: true, value: detail(taskId === opened.taskId ? opened : untouched),
    }));
    installAPI(getBeaconTask);
    const view = renderHook(({ enabled, tasks }) => useBeaconTaskOutputs("exact-one", tasks, enabled, false), {
      initialProps: { enabled: false, tasks: [opened, untouched] },
    });

    expect(view.result.current.entries).toHaveLength(2);
    expect(getBeaconTask).not.toHaveBeenCalled();
    act(() => view.result.current.loadOutput(opened));
    expect(getBeaconTask).not.toHaveBeenCalled();
    view.rerender({ enabled: true, tasks: [opened, untouched] });
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledOnce());
    expect(getBeaconTask).toHaveBeenCalledWith({ taskId: opened.taskId });

    const revised = { ...opened, completedAt: "2026-09-26T20:01:00.000Z" };
    view.rerender({ enabled: true, tasks: [revised, untouched] });
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(2));
    expect(getBeaconTask).not.toHaveBeenCalledWith({ taskId: untouched.taskId });
  });

  it("preserves explicitly opened output while newer background completions exceed the cache budget", async () => {
    const tasks = Array.from({ length: 33 }, (_, index) => task(`background-${index}`));
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(async ({ taskId }) => ({
      ok: true, value: executionDetail(tasks.find((summary) => summary.taskId === taskId)!, 1_024 * 1_024),
    }));
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), { initialProps: { tasks: tasks.slice(0, 16) } });
    await waitFor(() => expect(view.result.current.entries.every((entry) => entry.detail)).toBe(true));
    const opened = view.result.current.entries.find((entry) => entry.task.taskId === tasks[0]!.taskId)!.detail!;
    act(() => view.result.current.loadOutput(tasks[0]!));
    view.rerender({ tasks });
    await waitFor(() => expect(getBeaconTask).toHaveBeenCalledTimes(33));
    await waitFor(() => expect(view.result.current.entries.every((entry) => !entry.isLoading)).toBe(true));

    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[0]!.taskId)?.detail).toBe(opened);
    expect(opened.execution?.stdout?.data[0]).toBe(65);
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[32]!.taskId)?.detail).toBeDefined();
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[1]!.taskId)?.error).toContain("released from memory");
    expect(cachedBytes(view.result.current.entries.map((entry) => entry.detail))).toBe(32 * 1_024 * 1_024);
    view.rerender({ tasks: tasks.map((summary) => ({ ...summary })) });
    await act(async () => undefined);
    expect(getBeaconTask).toHaveBeenCalledTimes(33);
  });

  it("bounds execution cache to 32 MiB, keeps recently opened output, and reloads only an explicitly retried released entry", async () => {
    const tasks = Array.from({ length: 17 }, (_, index) => task(`large-${index}`));
    const returned: BeaconTaskDetail[] = [];
    const generic = task("generic-history");
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(async ({ taskId }) => {
      if (taskId === generic.taskId) return { ok: true, value: detail(generic, "unaffected filesystem output") };
      const decoded = executionDetail(tasks.find((summary) => summary.taskId === taskId)!, 1_024 * 1_024);
      returned.push(decoded);
      return { ok: true, value: decoded };
    });
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), {
      initialProps: { tasks: [...tasks.slice(0, 16), generic] },
    });
    await waitFor(() => expect(view.result.current.entries.every((entry) => entry.detail)).toBe(true));
    const first = returned.find((value) => value.taskId === tasks[0]!.taskId)!;
    const oldest = returned.find((value) => value.taskId === tasks[1]!.taskId)!;
    act(() => view.result.current.loadOutput(tasks[0]!));
    expect(getBeaconTask).toHaveBeenCalledTimes(17);

    view.rerender({ tasks: [...tasks, generic] });
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[1]!.taskId)?.error)
      .toBe("This output was released from memory. Load it again to view it."));
    expect(view.result.current.entries).toHaveLength(18);
    expect(cachedBytes(view.result.current.entries.map((entry) => entry.detail))).toBe(32 * 1_024 * 1_024);
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[0]!.taskId)?.detail).toBe(first);
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[16]!.taskId)?.detail).toBeDefined();
    expect(view.result.current.entries.find((entry) => entry.task.taskId === generic.taskId)?.detail?.disposition).toMatchObject({ text: "unaffected filesystem output" });
    expect(oldest.execution?.stdout?.data.every((byte) => byte === 0)).toBe(true);
    expect(oldest.execution?.stderr?.data.every((byte) => byte === 0)).toBe(true);
    expect(first.execution?.stdout?.data[0]).toBe(65);

    view.rerender({ tasks: [...tasks.map((summary) => ({ ...summary })), generic] });
    await act(async () => undefined);
    expect(getBeaconTask).toHaveBeenCalledTimes(18);
    act(() => view.result.current.loadOutput(tasks[1]!, true));
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[1]!.taskId)?.detail).toBeDefined());
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[1]!.taskId)?.error).toBeUndefined();
    expect(view.result.current.entries.find((entry) => entry.task.taskId === tasks[2]!.taskId)?.error).toContain("released from memory");
    expect(cachedBytes(view.result.current.entries.map((entry) => entry.detail))).toBe(32 * 1_024 * 1_024);
    expect(getBeaconTask).toHaveBeenCalledTimes(19);
    view.rerender({ tasks: [...tasks, generic] });
    await act(async () => undefined);
    expect(getBeaconTask).toHaveBeenCalledTimes(19);
    view.unmount();
    await Promise.resolve();
    expect(returned.every((value) => value.execution?.stdout?.data.every((byte) => byte === 0))).toBe(true);
  });

  it("zeroizes retired identity output and stale responses while retaining the current identity bytes", async () => {
    const firstTask = task("same-task");
    const secondTask = task("same-task", { beaconId: "beacon-two" });
    const first = executionDetail(firstTask, 16);
    const stale = executionDetail(firstTask, 16);
    const current = executionDetail(secondTask, 16);
    const staleGate = deferred<TaskResult>();
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>()
      .mockResolvedValueOnce({ ok: true, value: first })
      .mockReturnValueOnce(staleGate.promise)
      .mockResolvedValueOnce({ ok: true, value: current });
    installAPI(getBeaconTask);
    const view = renderHook(({ identity, tasks }) => useBeaconTaskOutputs(identity, tasks), {
      initialProps: { identity: "exact-one", tasks: [firstTask] },
    });
    await waitFor(() => expect(view.result.current.entries[0]?.detail).toBe(first));
    act(() => view.result.current.loadOutput(firstTask, true));
    expect(first.execution?.stdout?.data.every((byte) => byte === 0)).toBe(true);
    view.rerender({ identity: "exact-two", tasks: [secondTask] });
    await waitFor(() => expect(view.result.current.entries[0]?.detail).toBe(current));
    await act(async () => staleGate.resolve({ ok: true, value: stale }));
    expect(stale.execution?.stdout?.data.every((byte) => byte === 0)).toBe(true);
    expect(stale.execution?.stderr?.data.every((byte) => byte === 0)).toBe(true);
    expect(current.execution?.stdout?.data[0]).toBe(65);
    view.unmount();
    await Promise.resolve();
    expect(current.execution?.stdout?.data.every((byte) => byte === 0)).toBe(true);
  });

  it("keeps accepted execution output intact through Strict Mode effect replay and clears it on final unmount", async () => {
    const summary = task("strict-output");
    const decoded = executionDetail(summary, 16);
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockResolvedValue({ ok: true, value: decoded });
    installAPI(getBeaconTask);
    const view = renderHook(() => useBeaconTaskOutputs("exact-one", [summary]), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    await waitFor(() => expect(view.result.current.entries[0]?.detail).toBe(decoded));
    await Promise.resolve();
    expect(decoded.execution?.stdout?.data[0]).toBe(65);
    expect(getBeaconTask).toHaveBeenCalledOnce();
    view.unmount();
    await Promise.resolve();
    expect(decoded.execution?.stdout?.data.every((byte) => byte === 0)).toBe(true);
    expect(decoded.execution?.stderr?.data.every((byte) => byte === 0)).toBe(true);
  });

  it("bounds concurrent details, creates placeholders, and prioritizes a clicked queued output", async () => {
    const tasks = Array.from({ length: 7 }, (_, index) => task(`task-${index}`));
    const gates = new Map(tasks.map((summary) => [summary.taskId, deferred<TaskResult>()]));
    let active = 0;
    let maximum = 0;
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(({ taskId }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      return gates.get(taskId)!.promise.finally(() => { active -= 1; });
    });
    installAPI(getBeaconTask);
    const view = renderHook(() => useBeaconTaskOutputs("exact-one", tasks));

    expect(getBeaconTask).toHaveBeenCalledTimes(4);
    expect(view.result.current.entries).toHaveLength(7);
    expect(view.result.current.entries.every((entry) => entry.isLoading)).toBe(true);
    act(() => view.result.current.loadOutput(tasks[6]!));
    expect(getBeaconTask).toHaveBeenCalledTimes(4);
    await act(async () => gates.get("task-0")!.resolve({ ok: true, value: detail(tasks[0]!) }));
    expect(getBeaconTask.mock.calls[4]?.[0]).toEqual({ taskId: "task-6" });
    await act(async () => {
      for (const summary of tasks) gates.get(summary.taskId)!.resolve({ ok: true, value: detail(summary) });
    });
    await waitFor(() => expect(view.result.current.entries.every((entry) => entry.detail && !entry.isLoading)).toBe(true));
    expect(getBeaconTask).toHaveBeenCalledTimes(7);
    expect(maximum).toBe(4);
  });

  it("loads pending tasks only on request, retains history, and refreshes pending-to-terminal revisions", async () => {
    const pending = task("pending", { state: "pending", resultAvailable: false });
    const older = task("older", { createdAt: "2026-09-25T20:00:00.000Z" });
    const canceled = task("canceled", { state: "canceled", resultAvailable: false });
    let summaries = [pending, older, canceled];
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(async ({ taskId }) =>
      ({ ok: true, value: detail(summaries.find((summary) => summary.taskId === taskId)!) })
    );
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), { initialProps: { tasks: summaries } });
    await waitFor(() => expect(view.result.current.entries.filter((entry) => entry.detail)).toHaveLength(2));
    expect(getBeaconTask).not.toHaveBeenCalledWith({ taskId: pending.taskId });
    act(() => view.result.current.loadOutput(pending));
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === pending.taskId)?.detail).toBeDefined());

    const sent = { ...pending, state: "sent" as const, sentAt: "2026-09-26T20:00:30.000Z" };
    summaries = [sent];
    view.rerender({ tasks: summaries });
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === pending.taskId)?.detail?.state).toBe("sent"));
    const completed = { ...sent, state: "completed" as const, resultAvailable: true, completedAt: "2026-09-26T20:01:00.000Z" };
    summaries = [completed];
    view.rerender({ tasks: summaries });
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === pending.taskId)?.detail?.state).toBe("completed"));
    expect(view.result.current.entries.map((entry) => entry.task.taskId)).toEqual(["canceled", "pending", "older"]);
    expect(getBeaconTask.mock.calls.filter(([input]) => input.taskId === pending.taskId)).toHaveLength(3);
  });

  it("keeps errors per task without retry loops and retries only when requested", async () => {
    const failed = task("failed", { state: "failed", resultAvailable: false });
    const good = task("good");
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(async ({ taskId }) =>
      taskId === failed.taskId ? { ok: false, error: "Cannot fetch this output" } : { ok: true, value: detail(good) }
    );
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), { initialProps: { tasks: [failed, good] } });
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === failed.taskId)?.error).toBe("Cannot fetch this output"));
    expect(view.result.current.entries.find((entry) => entry.task.taskId === good.taskId)?.detail).toBeDefined();
    view.rerender({ tasks: [{ ...failed, description: "Renamed task" }, { ...good }] });
    act(() => view.result.current.loadOutput(failed));
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
    getBeaconTask.mockResolvedValue({ ok: true, value: detail(failed) });
    act(() => view.result.current.loadOutput(failed, true));
    await waitFor(() => expect(view.result.current.entries.find((entry) => entry.task.taskId === failed.taskId)?.detail).toBeDefined());
    expect(view.result.current.entries.find((entry) => entry.task.taskId === failed.taskId)?.error).toBeUndefined();
    expect(getBeaconTask).toHaveBeenCalledTimes(3);
  });

  it("discards an older per-task revision that resolves after its completed output", async () => {
    const pending = task("same-task", { state: "pending", resultAvailable: false });
    const completed = { ...pending, state: "completed" as const, resultAvailable: true };
    const oldResult = deferred<TaskResult>();
    const newResult = deferred<TaskResult>();
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>()
      .mockReturnValueOnce(oldResult.promise).mockReturnValueOnce(newResult.promise);
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), { initialProps: { tasks: [pending] } });
    act(() => view.result.current.loadOutput(pending));
    view.rerender({ tasks: [completed] });
    expect(getBeaconTask).toHaveBeenCalledTimes(2);
    await act(async () => newResult.resolve({ ok: true, value: detail(completed, "new result") }));
    await act(async () => oldResult.resolve({ ok: true, value: detail(pending, "old result") }));
    expect(view.result.current.entries[0]?.detail?.disposition).toMatchObject({ text: "new result" });
    expect(view.result.current.entries[0]?.task.state).toBe("completed");
  });

  it("rejects stale exact-target and A-to-B-to-A responses", async () => {
    const one = task("same-task");
    const two = task("same-task", { beaconId: "beacon-two" });
    const gates = Array.from({ length: 3 }, () => deferred<TaskResult>());
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>()
      .mockReturnValueOnce(gates[0]!.promise).mockReturnValueOnce(gates[1]!.promise).mockReturnValueOnce(gates[2]!.promise);
    installAPI(getBeaconTask);
    const view = renderHook(({ identity, tasks }) => useBeaconTaskOutputs(identity, tasks), {
      initialProps: { identity: "exact-one", tasks: [one] },
    });
    view.rerender({ identity: "exact-two", tasks: [two] });
    view.rerender({ identity: "exact-one", tasks: [one] });
    await act(async () => gates[0]!.resolve({ ok: true, value: detail(one, "stale A") }));
    expect(view.result.current.entries[0]?.detail).toBeUndefined();
    await act(async () => gates[2]!.resolve({ ok: true, value: detail(one, "current A") }));
    await act(async () => gates[1]!.resolve({ ok: true, value: detail(two, "stale B") }));
    expect(view.result.current.entries[0]?.detail?.disposition).toMatchObject({ text: "current A" });
    expect(view.result.current.entries).toHaveLength(1);
  });

  it("counts retired requests toward the concurrency limit and discards their queued work on target switch", async () => {
    const retiredTasks = Array.from({ length: 6 }, (_, index) => task(`retired-${index}`));
    const currentTasks = Array.from({ length: 5 }, (_, index) => task(`current-${index}`, { beaconId: "beacon-two" }));
    const gates = new Map([...retiredTasks, ...currentTasks].map((summary) => [summary.taskId, deferred<TaskResult>()]));
    let active = 0;
    let maximum = 0;
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(({ taskId }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      return gates.get(taskId)!.promise.finally(() => { active -= 1; });
    });
    installAPI(getBeaconTask);
    const view = renderHook(({ identity, tasks }) => useBeaconTaskOutputs(identity, tasks), {
      initialProps: { identity: "exact-one", tasks: retiredTasks },
    });
    expect(getBeaconTask).toHaveBeenCalledTimes(4);

    view.rerender({ identity: "exact-two", tasks: currentTasks });
    expect(getBeaconTask).toHaveBeenCalledTimes(4);
    expect(view.result.current.entries.map((entry) => entry.task.taskId)).toEqual(currentTasks.map((summary) => summary.taskId));

    await act(async () => gates.get(retiredTasks[0]!.taskId)!.resolve({ ok: true, value: detail(retiredTasks[0]!) }));
    expect(getBeaconTask).toHaveBeenCalledTimes(5);
    expect(getBeaconTask.mock.calls[4]?.[0]).toEqual({ taskId: currentTasks[0]!.taskId });
    expect(view.result.current.entries.every((entry) => !entry.detail)).toBe(true);

    await act(async () => {
      for (const summary of [...retiredTasks, ...currentTasks]) {
        gates.get(summary.taskId)!.resolve({ ok: true, value: detail(summary) });
      }
    });
    await waitFor(() => expect(view.result.current.entries.every((entry) => entry.detail && !entry.isLoading)).toBe(true));
    expect(getBeaconTask).toHaveBeenCalledTimes(9);
    expect(getBeaconTask).not.toHaveBeenCalledWith({ taskId: retiredTasks[4]!.taskId });
    expect(getBeaconTask).not.toHaveBeenCalledWith({ taskId: retiredTasks[5]!.taskId });
    expect(maximum).toBe(4);
    expect(active).toBe(0);
  });

  it("releases a scheduler slot after a transport rejection and recovers only the explicitly retried output", async () => {
    const tasks = Array.from({ length: 5 }, (_, index) => task(`task-${index}`));
    const gates = new Map(tasks.map((summary) => [summary.taskId, deferred<TaskResult>()]));
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(({ taskId }) => gates.get(taskId)!.promise);
    installAPI(getBeaconTask);
    const view = renderHook(({ tasks }) => useBeaconTaskOutputs("exact-one", tasks), { initialProps: { tasks } });
    expect(getBeaconTask).toHaveBeenCalledTimes(4);

    await act(async () => gates.get(tasks[0]!.taskId)!.reject(new Error("Connection closed")));
    expect(view.result.current.entries[0]).toMatchObject({ error: "Connection closed", isLoading: false });
    expect(view.result.current.entries[0]?.detail).toBeUndefined();
    expect(getBeaconTask).toHaveBeenCalledTimes(5);
    expect(getBeaconTask.mock.calls[4]?.[0]).toEqual({ taskId: tasks[4]!.taskId });

    await act(async () => {
      for (const summary of tasks.slice(1)) gates.get(summary.taskId)!.resolve({ ok: true, value: detail(summary) });
    });
    expect(view.result.current.entries.slice(1).every((entry) => entry.detail && !entry.isLoading)).toBe(true);
    view.rerender({ tasks: tasks.map((summary) => ({ ...summary })) });
    expect(getBeaconTask).toHaveBeenCalledTimes(5);

    getBeaconTask.mockResolvedValueOnce({ ok: true, value: detail(tasks[0]!, "Recovered output") });
    act(() => view.result.current.loadOutput(tasks[0]!, true));
    await waitFor(() => expect(view.result.current.entries[0]?.detail?.disposition).toMatchObject({ text: "Recovered output" }));
    expect(view.result.current.entries[0]).toMatchObject({ error: undefined, isLoading: false });
    expect(getBeaconTask).toHaveBeenCalledTimes(6);
  });

  it.each(["task", "beacon"])("rejects and zeroizes a response for a different %s", async (mismatch) => {
    const requested = task("requested");
    const response = executionDetail({ ...requested, ...(mismatch === "task" ? { taskId: "other" } : { beaconId: "other" }) }, 16);
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockResolvedValue({ ok: true, value: response });
    installAPI(getBeaconTask);
    const view = renderHook(() => useBeaconTaskOutputs("exact-one", [requested]));
    await waitFor(() => expect(view.result.current.entries[0]?.error).toBe("The server returned output for a different task."));
    expect(view.result.current.entries[0]?.detail).toBeUndefined();
    expect(response.execution?.stdout?.data).toEqual(new Uint8Array(16));
    expect(response.execution?.stderr?.data).toEqual(new Uint8Array(16));
    expect(getBeaconTask).toHaveBeenCalledOnce();
  });

  it("deduplicates requests during Strict Mode effect replay and does not drain queued work after unmount", async () => {
    const tasks = Array.from({ length: 6 }, (_, index) => task(`task-${index}`));
    const gates = tasks.map(() => deferred<TaskResult>());
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockImplementation(({ taskId }) =>
      gates[Number(taskId.split("-")[1])]!.promise
    );
    installAPI(getBeaconTask);
    const view = renderHook(() => useBeaconTaskOutputs("exact-one", tasks), {
      wrapper: ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children),
    });
    expect(getBeaconTask).toHaveBeenCalledTimes(4);
    view.unmount();
    await act(async () => {
      for (const [index, gate] of gates.entries()) gate.resolve({ ok: true, value: detail(tasks[index]!) });
    });
    expect(getBeaconTask).toHaveBeenCalledTimes(4);
  });
});

function executionDetail(summary: BeaconTaskSummary, streamBytes: number): BeaconTaskDetail {
  return { ...summary, execution: {
    operationId: "execution.process",
    stdout: { data: new Uint8Array(streamBytes).fill(65), truncated: false },
    stderr: { data: new Uint8Array(streamBytes).fill(66), truncated: false },
  } };
}

function cachedBytes(details: Array<BeaconTaskDetail | undefined>): number {
  return details.reduce((total, value) => total + (value?.execution?.stdout?.data.byteLength ?? 0)
    + (value?.execution?.stderr?.data.byteLength ?? 0), 0);
}
