import { afterEach, describe, expect, it, vi } from "vitest";
import { SCRIPT_LIMITS, type ScriptRunState } from "../../../shared/script-runtime-protocol";
import { ScriptRunner } from "./script-runner";

class FakeWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  event(value: unknown): void { this.onmessage?.call(this as unknown as Worker, new MessageEvent("message", { data: value })); }
}
const source = { source: 'console.log("hello")', scriptId: "187b26af-a0ba-4da4-a96e-1f807b5a454f", wasmBytes: new Uint8Array([0]) };
function fixture() {
  const workers: FakeWorker[] = [];
  const output = vi.fn();
  const states: ScriptRunState[] = [];
  const runner = new ScriptRunner({ onOutput: output, onState: (state) => states.push(state) }, () => {
    const worker = new FakeWorker(); workers.push(worker); return worker;
  });
  runner.run(source);
  const worker = workers[0]!;
  const id: string = worker.postMessage.mock.calls[0]![0].runId;
  return { runner, worker, workers, id, output, states };
}
afterEach(() => vi.useRealTimers());
describe("ScriptRunner watchdog and message boundary", () => {
  it("terminates an unresponsive worker on Stop and can start a fresh run", () => {
    const f = fixture();
    const stale = f.worker.onmessage;
    f.runner.stop();
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(f.states.at(-1)?.status).toBe("stopped");
    f.runner.run(source);
    stale?.call(f.worker as unknown as Worker, new MessageEvent("message", { data: { runId: f.id, type: "complete", state: { status: "completed" } } }));
    expect(f.states.at(-1)?.status).toBe("starting");
    expect(f.workers).toHaveLength(2);
    f.runner.dispose();
  });
  it("enforces an independent deadline even when the interpreter sends no messages", () => {
    vi.useFakeTimers();
    const f = fixture();
    f.worker.event({ runId: f.id, type: "ready" });
    vi.advanceTimersByTime(SCRIPT_LIMITS.executionMs);
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(f.states.at(-1)?.status).toBe("timed-out");
  });
  it("bounds initialization and rejects invalid output sequence and levels", () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.advanceTimersByTime(SCRIPT_LIMITS.startupMs);
    expect(f.states.at(-1)?.status).toBe("failed");
    const g = fixture();
    g.worker.event({ runId: g.id, type: "ready" });
    g.worker.event({ runId: g.id, type: "output", records: [{ sequence: 1, level: "log", text: "wrong sequence" }] });
    expect(g.output).not.toHaveBeenCalled();
    expect(g.worker.terminate).toHaveBeenCalledOnce();
  });
  it("ignores stale IDs and terminates after valid completion", () => {
    const f = fixture();
    f.worker.event({ runId: "stale", type: "ready" });
    expect(f.states.at(-1)?.status).toBe("starting");
    f.worker.event({ runId: f.id, type: "ready" });
    f.worker.event({ runId: f.id, type: "output", records: [{ sequence: 0, level: "log", text: "hello" }] });
    expect(f.output).toHaveBeenCalledWith([{ sequence: 0, level: "log", text: "hello" }]);
    f.worker.event({ runId: f.id, type: "complete", state: { status: "completed" } });
    expect(f.states.at(-1)?.status).toBe("completed");
    expect(f.worker.terminate).toHaveBeenCalledOnce();
  });
});
