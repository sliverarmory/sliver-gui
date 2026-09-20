/** Trusted configuration, never configurable by guest source or worker messages. */
export const SCRIPT_LIMITS = Object.freeze({
  executionMs: 5_000,
  startupMs: 15_000,
  sourceBytes: 512 * 1024,
  heapBytes: 64 * 1024 * 1024,
  stackBytes: 512 * 1024,
  wasmMemoryPages: 2048, // 128 MiB, including interpreter/allocator overhead.
  recordBytes: 16 * 1024,
  outputBytes: 1024 * 1024,
  outputRecords: 4096,
  batchRecords: 32,
});

export const SCRIPT_CONSOLE_LEVELS = ["log", "info", "debug", "warn", "error"] as const;
export type ScriptConsoleLevel = typeof SCRIPT_CONSOLE_LEVELS[number];
export interface ScriptConsoleRecord {
  readonly sequence: number;
  readonly level: ScriptConsoleLevel;
  readonly text: string;
}
export type ScriptRunStatus = "starting" | "running" | "completed" | "failed" | "stopped" | "timed-out" | "output-limit";
export interface ScriptRunState {
  readonly status: ScriptRunStatus;
  readonly elapsedMs: number;
  readonly message?: string;
}
export interface ScriptWorkerRequest {
  readonly runId: string;
  readonly scriptId: string;
  readonly source: string;
  readonly wasmBytes: Uint8Array;
}
export type ScriptWorkerEvent =
  | { readonly runId: string; readonly type: "ready" }
  | { readonly runId: string; readonly type: "output"; readonly records: readonly ScriptConsoleRecord[] }
  | { readonly runId: string; readonly type: "complete"; readonly state: ScriptRunState };

export function isScriptConsoleLevel(value: unknown): value is ScriptConsoleLevel {
  return typeof value === "string" && (SCRIPT_CONSOLE_LEVELS as readonly string[]).includes(value);
}

/** Logs remain text: no guest ESC, OSC, CSI, title/clipboard/link controls. */
export function escapeScriptOutput(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
