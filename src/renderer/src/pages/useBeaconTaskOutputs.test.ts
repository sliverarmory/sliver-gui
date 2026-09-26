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
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function installAPI(getBeaconTask: SliverDesktopAPI["getBeaconTask"]) {
  Object.defineProperty(window, "sliver", { configurable: true, value: { getBeaconTask } });
}

describe("useBeaconTaskOutputs", () => {
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

  it("rejects stale exact-target and A-to-B-to-A responses while preserving the concurrency limit", async () => {
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

  it.each(["task", "beacon"])("rejects a response for a different %s", async (mismatch) => {
    const requested = task("requested");
    const response = detail({ ...requested, ...(mismatch === "task" ? { taskId: "other" } : { beaconId: "other" }) });
    const getBeaconTask = vi.fn<SliverDesktopAPI["getBeaconTask"]>().mockResolvedValue({ ok: true, value: response });
    installAPI(getBeaconTask);
    const view = renderHook(() => useBeaconTaskOutputs("exact-one", [requested]));
    await waitFor(() => expect(view.result.current.entries[0]?.error).toBe("The server returned output for a different task."));
    expect(view.result.current.entries[0]?.detail).toBeUndefined();
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
