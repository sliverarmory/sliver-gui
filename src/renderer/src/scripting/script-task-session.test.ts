import { describe, expect, it, vi } from "vitest";
import type { ScriptConsoleRecord, ScriptRunState } from "../../../shared/script-runtime-protocol";
import { ScriptRunner } from "./script-runner";
import { ScriptTaskSession, type ScriptRunSnapshot } from "./script-task-session";

function snapshot(scriptId: string): ScriptRunSnapshot { return { scriptId, name: scriptId, source: `console.log("${scriptId}");`, unsaved: false }; }
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
function setup(loadRuntime = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1]))) {
  const runners: { callbacks: ConstructorParameters<typeof ScriptRunner>[0]; run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const changed = vi.fn();
  const session = new ScriptTaskSession(loadRuntime, changed, (callbacks) => {
    const runner = {
      callbacks,
      run: vi.fn(() => callbacks.onState({ status: "running", elapsedMs: 0 })),
      stop: vi.fn(() => callbacks.onState({ status: "stopped", elapsedMs: 1 })),
      dispose: vi.fn(),
    };
    runners.push(runner);
    return runner as unknown as ScriptRunner;
  });
  return { session, runners, changed, loadRuntime };
}
const output: readonly ScriptConsoleRecord[] = [{ sequence: 0, level: "log", text: "retained output" }];
const completed: ScriptRunState = { status: "completed", elapsedMs: 10 };

describe("ScriptTaskSession", () => {
  it("retains independent source snapshots, consoles, and running states per script", async () => {
    const { session, runners } = setup();
    const first = { ...snapshot("first"), unsaved: true };
    await session.run(first);
    runners[0]!.callbacks.onOutput(output);
    await session.run(snapshot("second"));
    runners[1]!.callbacks.onOutput([{ sequence: 0, level: "warn", text: "second output" }]);
    expect(session.get("first")?.snapshot).toEqual(first);
    expect(session.get("first")?.records).toEqual(output);
    expect(session.get("second")?.records[0]?.text).toBe("second output");
    session.stop("second");
    expect(session.isRunning("first")).toBe(true);
    expect(session.get("second")?.state.status).toBe("stopped");
    expect(runners[0]!.stop).not.toHaveBeenCalled();
  });

  it("counts runtime loads toward the concurrency limit and suppresses duplicate launches", async () => {
    const runtime = deferred<Uint8Array>();
    const { session, runners, loadRuntime } = setup(vi.fn(() => runtime.promise));
    const starts = ["a", "b", "c", "d"].map((id) => session.run(snapshot(id)));
    await session.run(snapshot("a"));
    await expect(session.run(snapshot("e"))).rejects.toThrow("Up to 4 scripts");
    expect(loadRuntime).toHaveBeenCalledTimes(4);
    expect(runners).toHaveLength(0);
    runtime.resolve(new Uint8Array([1]));
    await Promise.all(starts);
    expect(runners).toHaveLength(4);
    session.stop("b");
    await session.run(snapshot("e"));
    expect(session.isRunning("e")).toBe(true);
    expect(session.isRunning("a")).toBe(true);
  });

  it("invalidates stopped startup before rerun and ignores stale worker callbacks", async () => {
    const runtime = deferred<Uint8Array>();
    const loadRuntime = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1])).mockImplementationOnce(() => runtime.promise);
    const { session, runners } = setup(loadRuntime);
    const old = session.run(snapshot("a"));
    session.stop("a");
    await session.run({ ...snapshot("a"), source: "new source" });
    runtime.resolve(new Uint8Array([1]));
    await old;
    expect(runners).toHaveLength(1);
    expect(runners[0]!.run).toHaveBeenCalledWith(expect.objectContaining({ source: "new source" }));
    runners[0]!.callbacks.onState(completed);
    await session.run(snapshot("a"));
    runners[0]!.callbacks.onOutput(output);
    runners[0]!.callbacks.onState({ status: "failed", elapsedMs: 10 });
    expect(session.get("a")?.records).toEqual([]);
    expect(session.get("a")?.state.status).toBe("running");
  });

  it("evicts the oldest completed results after 16 runs without evicting an active task", async () => {
    const { session, runners } = setup();
    await session.run(snapshot("active"));
    runners[0]!.callbacks.onOutput(output);
    for (let index = 0; index < 16; index += 1) {
      await session.run(snapshot(String(index)));
      runners[index + 1]!.callbacks.onState(completed);
    }
    expect(session.get("0")).toBeUndefined();
    expect(session.get("1")?.state.status).toBe("completed");
    expect(session.get("15")?.state.status).toBe("completed");
    expect(session.get("active")?.records).toEqual(output);
    expect(session.isRunning("active")).toBe(true);
    expect(runners[0]!.dispose).not.toHaveBeenCalled();
  });

  it("clears only the chosen console and removes only the deleted task", async () => {
    const { session, runners } = setup();
    await session.run(snapshot("a"));
    await session.run(snapshot("b"));
    for (const runner of runners) runner.callbacks.onOutput(output);
    const reset = session.get("a")!.outputReset;
    session.clear("a");
    expect(session.get("a")?.records).toEqual([]);
    expect(session.get("a")!.outputReset).toBeGreaterThan(reset);
    expect(session.isRunning("a")).toBe(true);
    expect(session.get("b")?.records).toEqual(output);
    session.remove("a");
    expect(runners[0]!.dispose).toHaveBeenCalledOnce();
    expect(runners[1]!.dispose).not.toHaveBeenCalled();
    expect(session.get("a")).toBeUndefined();
    expect(session.isRunning("b")).toBe(true);
  });

  it("disposes all workers and invalidates pending loads when the owner closes", async () => {
    const runtime = deferred<Uint8Array>();
    const loadRuntime = vi.fn<() => Promise<Uint8Array>>(async () => new Uint8Array([1])).mockImplementationOnce(() => runtime.promise);
    const { session, runners, changed } = setup(loadRuntime);
    const pending = session.run(snapshot("loading"));
    await session.run(snapshot("running"));
    session.dispose();
    changed.mockClear();
    runtime.resolve(new Uint8Array([1]));
    await pending;
    expect(runners).toHaveLength(1);
    expect(runners[0]!.dispose).toHaveBeenCalledOnce();
    runners[0]!.callbacks.onOutput(output);
    expect(changed).not.toHaveBeenCalled();
  });
});
