// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import { observePromiseSettlement, type OwnedApplicationForCleanup } from "./packaged-application-update-support.js";
import {
  cleanupPackagedUpdate,
  completeNativeUpdateTransition,
  finishPackagedUpdateLaunch,
  requireObservedApplicationClose,
} from "./packaged-update-lifecycle.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function application(close: () => Promise<void>): OwnedApplicationForCleanup {
  return { close, process: () => ({ exitCode: null, signalCode: null, stdio: [], kill: vi.fn(() => true) }) };
}

function transition() {
  const closed = deferred<void>();
  const proved = deferred<void>();
  const calls: string[] = [];
  const options = {
    observeClose: () => { calls.push("observe"); return closed.promise; },
    requestUpdate: async () => { calls.push("click"); },
    waitForOriginalExit: async () => { calls.push("original exit"); },
    waitForUpdatedExecutable: async () => { calls.push("updated executable"); return "/updated"; },
    updatedExecutable: (path: string) => { calls.push(`record ${path}`); },
    waitForRelaunch: async (path: string) => { calls.push(`relaunch ${path}`); return 42; },
    trackRelaunch: (pid: number | undefined) => { calls.push(`track ${pid}`); },
    terminateRelaunch: async (pid: number, path: string) => { calls.push(`terminate ${pid} ${path}`); },
    proveProcessAbsence: async () => { calls.push("absence"); proved.resolve(); },
    closeTimeoutMs: 1_000,
  };
  return { calls, closed, proved, options };
}

describe("native updater transition", () => {
  it("observes close before clicking but proves the native process lifecycle before awaiting it", async () => {
    const f = transition();
    let complete = false;
    const operation = completeNativeUpdateTransition(f.options).then((value) => { complete = true; return value; });
    await f.proved.promise;
    await Promise.resolve();
    expect(f.calls).toEqual([
      "observe", "click", "original exit", "updated executable", "record /updated", "relaunch /updated",
      "track 42", "terminate 42 /updated", "absence", "track undefined",
    ]);
    expect(complete).toBe(false);
    f.closed.resolve();
    await expect(operation).resolves.toBe("/updated");
  });

  it("retains the tracked relaunch when native absence proof fails", async () => {
    const f = transition();
    f.options.proveProcessAbsence = async () => { throw new Error("helper survived"); };
    await expect(completeNativeUpdateTransition(f.options)).rejects.toThrow("helper survived");
    expect(f.calls).toContain("track 42");
    expect(f.calls).not.toContain("track undefined");
  });

  it("observes early close rejection without skipping native shutdown proofs", async () => {
    const f = transition();
    f.closed.reject(new Error("transport failed"));
    await expect(completeNativeUpdateTransition(f.options)).rejects.toThrow("Controlled Playwright application close failed: transport failed");
    expect(f.calls).toContain("absence");
    expect(f.calls.at(-1)).toBe("track undefined");
  });

  it("times out a transport that never settles and removes its deadline timer", async () => {
    vi.useFakeTimers();
    const operation = requireObservedApplicationClose(new Promise(() => undefined), 1_000);
    const assertion = expect(operation).rejects.toThrow("Timed out waiting for the controlled Playwright");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the deadline when a close observation succeeds", async () => {
    vi.useFakeTimers();
    await requireObservedApplicationClose(observePromiseSettlement(Promise.resolve()), 1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("partial updater launch", () => {
  it("returns initialized state without closing a successfully launched application", async () => {
    const close = vi.fn(async () => undefined);
    const result = { page: "ready" };
    await expect(finishPackagedUpdateLaunch(application(close), async () => result, 100)).resolves.toBe(result);
    expect(close).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps the initialization error after bounded cleanup (cleanup fails: %s)", async (cleanupFails) => {
    const original = new Error("first window failed");
    const close = vi.fn(async () => { if (cleanupFails) throw new Error("close failed"); });
    const report = vi.fn();
    await expect(finishPackagedUpdateLaunch(application(close), async () => { throw original; }, 100, report)).rejects.toBe(original);
    expect(close).toHaveBeenCalledOnce();
    if (cleanupFails) {
      expect((original as Error & { cleanupError?: Error }).cleanupError?.message).toContain("close failed");
      expect(report).toHaveBeenCalledOnce();
    } else expect(original).not.toHaveProperty("cleanupError");
  });
});

function cleanup() {
  const calls: string[] = [];
  const options = {
    forcedRelaunch: 42 as number | undefined,
    terminateRelaunch: async (pid: number) => { calls.push(`terminate ${pid}`); },
    applications: [
      ["N", application(async () => { calls.push("close N"); })],
      ["N-1", application(async () => { calls.push("close N-1"); })],
    ] as Array<readonly [string, OwnedApplicationForCleanup | undefined]>,
    cleanupTimeoutMs: 100,
    terminateRemaining: async () => { calls.push("remaining absent"); },
    removeTemporaryRoot: async () => { calls.push("remove root"); },
    testFailed: false,
    testFailure: new Error("original failure"),
    report: vi.fn(),
  };
  return { calls, options };
}

describe("packaged updater teardown", () => {
  it("terminates an inherited relaunch before closing transports and proving absence before removal", async () => {
    const f = cleanup();
    await cleanupPackagedUpdate(f.options);
    expect(f.calls).toEqual(["terminate 42", "close N", "close N-1", "remaining absent", "remove root"]);
  });

  it("drains independent cleanup actions after transport errors", async () => {
    const f = cleanup();
    f.options.terminateRelaunch = async () => { throw new Error("relaunch vanished"); };
    f.options.applications[0] = ["N", application(async () => { throw new Error("transport failure"); })];
    await expect(cleanupPackagedUpdate(f.options)).rejects.toThrow("Packaged updater E2E cleanup failed");
    expect(f.calls).toEqual(["close N-1", "remaining absent", "remove root"]);
    expect(f.options.report).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("retains disk evidence when absence is unproved (original failure: %s)", async (testFailed) => {
    const f = cleanup();
    f.options.testFailed = testFailed;
    f.options.terminateRemaining = async () => { throw new Error("inventory failed"); };
    const operation = cleanupPackagedUpdate(f.options);
    if (testFailed) {
      await expect(operation).resolves.toBeUndefined();
      const attached = (f.options.testFailure as Error & { cleanupError?: AggregateError }).cleanupError;
      expect(attached).toBeInstanceOf(AggregateError);
      expect(attached?.errors).toEqual([expect.objectContaining({ message: "inventory failed" })]);
    } else await expect(operation).rejects.toThrow("Packaged updater E2E cleanup failed");
    expect(f.calls).not.toContain("remove root");
    expect(f.options.report).toHaveBeenCalledWith(expect.stringContaining("Retaining the packaged updater temporary directory"));
  });

  it("reports directory removal failures after proving process absence", async () => {
    const f = cleanup();
    f.options.forcedRelaunch = undefined;
    f.options.applications = [["N", undefined], ["N-1", undefined]];
    f.options.removeTemporaryRoot = async () => { throw new Error("disk failure"); };
    await expect(cleanupPackagedUpdate(f.options)).rejects.toMatchObject({ errors: [expect.objectContaining({ message: "disk failure" })] });
    expect(f.calls).toEqual(["remaining absent"]);
  });
});
