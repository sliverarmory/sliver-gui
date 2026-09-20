import {
  SCRIPT_LIMITS, isScriptConsoleLevel,
  type ScriptConsoleRecord, type ScriptRunState,
} from "../../../shared/script-runtime-protocol";

interface RunnerCallbacks {
  onOutput(records: readonly ScriptConsoleRecord[]): void;
  onState(state: ScriptRunState): void;
}
type WorkerPort = Pick<Worker, "onmessage" | "onerror" | "onmessageerror" | "postMessage" | "terminate">;
const encoder = new TextEncoder();

/** Host-side watchdog survives a blocked interpreter or a stalled builtin. */
export class ScriptRunner {
  private current: { worker: WorkerPort; id: string; started: number; sequence: number; bytes: number; ready: boolean } | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly callbacks: RunnerCallbacks,
    private readonly createWorker: () => WorkerPort = () => new Worker(new URL("./script.worker.ts", import.meta.url), { type: "module" }),
  ) {}

  run(input: { source: string; scriptId: string; wasmBytes: Uint8Array }): void {
    if (this.current) throw new Error("A script is already running");
    if (input.source.length > SCRIPT_LIMITS.sourceBytes || encoder.encode(input.source).byteLength > SCRIPT_LIMITS.sourceBytes) {
      throw new Error("Script exceeds the 512 KiB source limit");
    }
    const worker = this.createWorker();
    const run = { worker, id: crypto.randomUUID(), started: performance.now(), sequence: 0, bytes: 0, ready: false };
    this.current = run;
    this.callbacks.onState({ status: "starting", elapsedMs: 0 });
    this.timer = setTimeout(() => this.finish("failed", "Script runtime initialization timed out."), SCRIPT_LIMITS.startupMs);
    worker.onerror = (event) => {
      event.preventDefault();
      if (this.current === run) this.finish("failed", "Script runtime failed and was discarded.");
    };
    worker.onmessageerror = () => { if (this.current === run) this.finish("failed", "Invalid script runtime message."); };
    worker.onmessage = ({ data }: MessageEvent<unknown>) => {
      if (this.current !== run || !isRecord(data) || data["runId"] !== run.id) return;
      switch (data["type"]) {
        case "ready":
          if (run.ready) { this.finish("failed", "Invalid script runtime state."); return; }
          run.ready = true;
          run.started = performance.now();
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.finish("timed-out", "Execution exceeded the five-second limit."), SCRIPT_LIMITS.executionMs);
          this.callbacks.onState({ status: "running", elapsedMs: 0 });
          break;
        case "output": {
          const records = data["records"];
          if (!run.ready || !Array.isArray(records) || records.length > SCRIPT_LIMITS.batchRecords) {
            this.finish("failed", "Invalid script output."); return;
          }
          const accepted: ScriptConsoleRecord[] = [];
          for (const record of records) {
            if (!isRecord(record) || record["sequence"] !== run.sequence ||
              !isScriptConsoleLevel(record["level"]) || typeof record["text"] !== "string" ||
              record["text"].length > SCRIPT_LIMITS.recordBytes) {
              this.finish("failed", "Invalid script output."); return;
            }
            const size = encoder.encode(record["text"]).byteLength + 1;
            if (size > SCRIPT_LIMITS.recordBytes + 1 || run.bytes + size > SCRIPT_LIMITS.outputBytes ||
              run.sequence >= SCRIPT_LIMITS.outputRecords) {
              this.finish("output-limit", "Output limit reached. Execution stopped."); return;
            }
            run.bytes += size;
            accepted.push({ sequence: run.sequence++, level: record["level"], text: record["text"] });
          }
          this.callbacks.onOutput(accepted);
          break;
        }
        case "complete": {
          const state = data["state"];
          if (!isRecord(state) || !["completed", "failed", "timed-out", "output-limit"].includes(String(state["status"])) ||
            (state["message"] !== undefined && (typeof state["message"] !== "string" || state["message"].length > SCRIPT_LIMITS.recordBytes))) {
            this.finish("failed", "Invalid script completion."); return;
          }
          this.finish(state["status"] as ScriptRunState["status"], state["message"] as string | undefined);
          break;
        }
        default: this.finish("failed", "Unknown script runtime message.");
      }
    };
    try {
      const bytes = Uint8Array.from(input.wasmBytes);
      worker.postMessage({ runId: run.id, scriptId: input.scriptId, source: input.source, wasmBytes: bytes }, [bytes.buffer]);
    } catch {
      this.finish("failed", "Could not start the script runtime.");
    }
  }

  stop(): void { this.finish("stopped", "Execution stopped."); }
  dispose(): void { this.stop(); }

  private finish(status: ScriptRunState["status"], message?: string): void {
    const run = this.current;
    if (!run) return;
    this.current = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    run.worker.onmessage = null;
    run.worker.onerror = null;
    run.worker.onmessageerror = null;
    run.worker.terminate();
    this.callbacks.onState({ status, elapsedMs: Math.max(0, Math.round(performance.now() - run.started)), ...(message ? { message } : {}) });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
