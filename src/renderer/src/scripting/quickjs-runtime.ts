import { newQuickJSWASMModule, newVariant, RELEASE_SYNC, type QuickJSHandle } from "quickjs-emscripten";

import {
  SCRIPT_LIMITS, escapeScriptOutput, isScriptConsoleLevel,
  type ScriptConsoleRecord, type ScriptRunState, type ScriptWorkerRequest,
} from "../../../shared/script-runtime-protocol";
import { CONSOLE_BOOTSTRAP } from "./console-bootstrap";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ScriptRuntimeCallbacks {
  ready(): void;
  output(records: readonly ScriptConsoleRecord[]): void;
}

/** Called exclusively by the packaged worker (and isolated unit tests). */
export async function evaluateScript(
  request: ScriptWorkerRequest,
  callbacks: ScriptRuntimeCallbacks,
): Promise<ScriptRunState> {
  if (!UUID.test(request.runId) || !UUID.test(request.scriptId) ||
    typeof request.source !== "string" || request.source.length > SCRIPT_LIMITS.sourceBytes ||
    encoder.encode(request.source).byteLength > SCRIPT_LIMITS.sourceBytes ||
    !(request.wasmBytes instanceof Uint8Array) || request.wasmBytes.byteLength > 1024 * 1024) {
    throw new Error("Invalid script run request");
  }
  const wasmMemory = new WebAssembly.Memory({ initial: 256, maximum: SCRIPT_LIMITS.wasmMemoryPages });
  // The pinned Emscripten loader supports print/printErr, which its narrower
  // TypeScript options omit. Never leak guest-induced allocator diagnostics.
  const emscriptenModule = { wasmMemory, print: () => undefined, printErr: () => undefined };
  const wasm = await newQuickJSWASMModule(newVariant(RELEASE_SYNC, {
    wasmBinary: Uint8Array.from(request.wasmBytes).buffer,
    wasmMemory,
    emscriptenModule,
  }));
  if (wasm.getWasmMemory() !== wasmMemory) throw new Error("Script runtime did not accept bounded memory");
  const started = performance.now();
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(SCRIPT_LIMITS.heapBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  runtime.removeModuleLoader();
  let outputLimit = false;
  let timedOut = false;
  runtime.setInterruptHandler(() => {
    timedOut ||= performance.now() - started >= SCRIPT_LIMITS.executionMs;
    return timedOut || outputLimit;
  });
  const vm = runtime.newContext();
  let sequence = 0;
  let bytes = 0;
  let batch: ScriptConsoleRecord[] = [];
  let renderError: QuickJSHandle | undefined;
  const flush = (): void => {
    if (batch.length === 0) return;
    callbacks.output(batch);
    batch = [];
  };
  const finish = (status: ScriptRunState["status"], message?: string): ScriptRunState => ({
    status,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    ...(message ? { message: boundedText(message) } : {}),
  });
  const describe = (error: QuickJSHandle): string => {
    if (!renderError || timedOut || outputLimit) return "Script execution failed";
    // Formatting is also guest execution: it shares the same interrupt deadline.
    const result = vm.callFunction(renderError, vm.undefined, error);
    try {
      return result.error || vm.typeof(result.value) !== "string"
        ? "Script execution failed" : boundedText(vm.getString(result.value));
    } finally { result.dispose(); }
  };
  const failed = (message: string): ScriptRunState => outputLimit
    ? finish("output-limit", "Output limit reached. Execution stopped.")
    : timedOut ? finish("timed-out", "Execution exceeded the five-second limit.") : finish("failed", message);
  try {
    const emit = vm.newFunction("emitConsoleText", (level, text) => {
      // Only primitive strings may cross this bridge. Never dump guest objects.
      if (!level || !text || vm.typeof(level) !== "string" || vm.typeof(text) !== "string" || outputLimit) return;
      const consoleLevel = vm.getString(level);
      if (!isScriptConsoleLevel(consoleLevel)) return;
      const safeText = boundedText(vm.getString(text));
      const recordBytes = encoder.encode(safeText).byteLength + 1;
      if (bytes + recordBytes > SCRIPT_LIMITS.outputBytes || sequence >= SCRIPT_LIMITS.outputRecords) {
        outputLimit = true;
        return;
      }
      bytes += recordBytes;
      batch.push({ sequence: sequence++, level: consoleLevel, text: safeText });
      if (batch.length >= SCRIPT_LIMITS.batchRecords) flush();
    });
    try {
      const bootstrap = vm.evalCode(CONSOLE_BOOTSTRAP, "console-bootstrap.js", { type: "global" });
      try {
        if (bootstrap.error) return failed("Could not initialize the script console");
        const installed = vm.callFunction(bootstrap.value, vm.undefined, emit);
        if (installed.error) {
          installed.dispose();
          return failed("Could not initialize the script console");
        }
        renderError = installed.value;
      } finally { bootstrap.dispose(); }
    } finally { emit.dispose(); }
    callbacks.ready();
    // This is the ONLY evaluation site for user text. No host eval/Function,
    // Blob scripts, native VM, script elements, imports, or Node APIs are used.
    const evaluated = vm.evalCode(request.source, `script-${request.scriptId}.js`, { type: "global" });
    try {
      if (evaluated.error) return failed(describe(evaluated.error));
      while (runtime.hasPendingJob() && !outputLimit && !timedOut) {
        timedOut = performance.now() - started >= SCRIPT_LIMITS.executionMs;
        if (timedOut) break;
        const jobs = runtime.executePendingJobs(64);
        try {
          if (jobs.error) return failed(describe(jobs.error));
        } finally { jobs.dispose(); }
      }
      if (outputLimit || timedOut) return failed("Script execution stopped");
      const completion = vm.getPromiseState(evaluated.value);
      if (completion.type === "pending") {
        return failed("The script returned a pending promise. Timers and external I/O are unavailable.");
      }
      if (completion.type === "rejected") {
        try { return failed(describe(completion.error)); } finally { completion.error.dispose(); }
      }
      if (!completion.notAPromise) completion.value.dispose();
      return finish("completed");
    } finally { evaluated.dispose(); }
  } catch (error) {
    return failed(error instanceof Error ? error.message : "Script runtime failed");
  } finally {
    flush();
    // Some QuickJS OOM paths also abort during teardown. The caller always
    // terminates this single-use worker; never retain or reuse a damaged module.
    try { renderError?.dispose(); } catch { /* The worker owns the entire heap. */ }
    try { vm.dispose(); } catch { /* Discard on interpreter/allocator failure. */ }
    try { runtime.dispose(); } catch { /* Discard on interpreter/allocator failure. */ }
  }
}

function boundedText(text: string): string {
  const safe = escapeScriptOutput(text);
  const bytes = encoder.encode(safe);
  if (bytes.byteLength <= SCRIPT_LIMITS.recordBytes) return safe;
  return decoder.decode(bytes.subarray(0, SCRIPT_LIMITS.recordBytes - 32)) + "… [truncated]";
}
