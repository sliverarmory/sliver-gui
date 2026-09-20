import type { ApplicationSettingsState } from "./application-settings-contracts.js";
import type { OperationResult } from "./contracts.js";
import { parseScriptId, parseScriptName, SCRIPT_LIMITS as STORAGE_LIMITS } from "./script-contracts.js";
import { isScriptConsoleLevel, SCRIPT_LIMITS, type ScriptConsoleRecord, type ScriptRunState } from "./script-runtime-protocol.js";
import type { TerminalRuntimeAsset } from "./stream-contracts.js";

export const SCRIPT_TASK_LIMITS = Object.freeze({
  maxConcurrentRuns: 4, retainedOutputs: 16, pendingCommands: 16,
  // A full saved catalog can coexist with dirty drafts deleted in another window.
  displayScripts: 2 * STORAGE_LIMITS.scripts,
});
export const SCRIPT_TASK_IPC = Object.freeze({
  open: "sliver:script-tasks:open",
  getState: "sliver:script-tasks:state:get",
  publish: "sliver:script-tasks:publish",
  command: "sliver:script-tasks:command",
  ownerReady: "sliver:script-tasks:owner-ready",
  changed: "sliver:script-tasks:changed",
  commandRequested: "sliver:script-tasks:command-requested",
  hostRequested: "sliver:script-tasks:host-requested",
  editRequested: "sliver:script-tasks:edit-requested",
  getTerminalRuntime: "sliver:script-tasks:terminal-runtime:get",
  getApplicationSettings: "sliver:script-tasks:application-settings:get",
});

export interface ScriptTaskSummary {
  readonly id: string;
  readonly name: string;
  readonly dirty: boolean;
  readonly conflict: boolean;
  readonly state?: ScriptRunState;
}
export interface ScriptTaskManagerSnapshot {
  readonly scripts: readonly ScriptTaskSummary[];
  readonly selectedId?: string;
  readonly records: readonly ScriptConsoleRecord[];
  readonly outputReset: number;
  readonly run?: { readonly name: string; readonly unsaved: boolean; readonly editedSinceRun: boolean };
  readonly pending: boolean;
  readonly error?: string;
}
export interface ScriptTaskCommand {
  readonly type: "select" | "run" | "stop" | "clear";
  readonly id: string;
}
export interface ScriptTaskManagerAPI {
  open(): Promise<OperationResult>;
  getState(): Promise<OperationResult<ScriptTaskManagerSnapshot>>;
  publish(snapshot: ScriptTaskManagerSnapshot): Promise<OperationResult>;
  command(command: ScriptTaskCommand): Promise<OperationResult>;
  ownerReady(): Promise<OperationResult>;
  onChanged(listener: (snapshot: ScriptTaskManagerSnapshot) => void): () => void;
  onCommand(listener: (command: ScriptTaskCommand) => void): () => void;
  onHostRequested(listener: () => void): () => void;
  onEditRequested(listener: (id: string) => void): () => void;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
}

export const EMPTY_SCRIPT_TASK_SNAPSHOT: ScriptTaskManagerSnapshot = Object.freeze({
  scripts: Object.freeze([]), records: Object.freeze([]), outputReset: 0, pending: true,
});

export function parseScriptTaskCommand(value: unknown): ScriptTaskCommand {
  const input = fields(value, ["type", "id"]);
  if (typeof input["type"] !== "string" || !["select", "run", "stop", "clear"].includes(input["type"])) throw new TypeError("Invalid script task command");
  return { type: input["type"] as ScriptTaskCommand["type"], id: parseScriptId(input["id"]) };
}

/** The relay only accepts bounded display data, never source, paths, or runtime capabilities. */
export function parseScriptTaskSnapshot(value: unknown): ScriptTaskManagerSnapshot {
  const input = fields(value, ["scripts", "records", "outputReset", "pending"], ["selectedId", "run", "error"]);
  const rawScripts = input["scripts"];
  if (!Array.isArray(rawScripts) || rawScripts.length > SCRIPT_TASK_LIMITS.displayScripts) throw new TypeError("Invalid script task list");
  const ids = new Set<string>();
  const scripts = rawScripts.map((raw): ScriptTaskSummary => {
    const item = fields(raw, ["id", "name", "dirty", "conflict"], ["state"]);
    const id = parseScriptId(item["id"]);
    if (ids.has(id)) throw new TypeError("Duplicate script task");
    ids.add(id);
    return { id, name: parseScriptName(item["name"]), dirty: boolean(item["dirty"]), conflict: boolean(item["conflict"]),
      ...(item["state"] === undefined ? {} : { state: parseState(item["state"]) }) };
  });
  const selectedId = input["selectedId"] === undefined ? undefined : parseScriptId(input["selectedId"]);
  if (selectedId !== undefined && !ids.has(selectedId)) throw new TypeError("Unknown selected script task");
  const rawRecords = input["records"];
  if (!Array.isArray(rawRecords) || rawRecords.length > SCRIPT_LIMITS.outputRecords) throw new TypeError("Too much script task output");
  let bytes = 0;
  let sequence = -1;
  const records = rawRecords.map((raw): ScriptConsoleRecord => {
    const item = fields(raw, ["sequence", "level", "text"]);
    const next = integer(item["sequence"]);
    if (next <= sequence || !isScriptConsoleLevel(item["level"])) throw new TypeError("Invalid script task output");
    sequence = next;
    const text = boundedText(item["text"], SCRIPT_LIMITS.recordBytes);
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > SCRIPT_LIMITS.outputBytes) throw new TypeError("Too much script task output");
    return { sequence, level: item["level"], text };
  });
  let run: ScriptTaskManagerSnapshot["run"];
  if (input["run"] !== undefined) {
    const item = fields(input["run"], ["name", "unsaved", "editedSinceRun"]);
    run = { name: parseScriptName(item["name"]), unsaved: boolean(item["unsaved"]), editedSinceRun: boolean(item["editedSinceRun"]) };
  }
  if (selectedId === undefined && (records.length > 0 || run !== undefined)) throw new TypeError("Output requires a selected script");
  return { scripts, records, outputReset: integer(input["outputReset"]), pending: boolean(input["pending"]),
    ...(selectedId === undefined ? {} : { selectedId }), ...(run === undefined ? {} : { run }),
    ...(input["error"] === undefined ? {} : { error: boundedText(input["error"], 4096) }) };
}

function parseState(value: unknown): ScriptRunState {
  const input = fields(value, ["status", "elapsedMs"], ["message"]);
  if (typeof input["status"] !== "string" || !["starting", "running", "completed", "failed", "stopped", "timed-out", "output-limit"].includes(input["status"]) ||
    typeof input["elapsedMs"] !== "number" || !Number.isFinite(input["elapsedMs"]) || input["elapsedMs"] < 0 || input["elapsedMs"] > 86_400_000) {
    throw new TypeError("Invalid script task run state");
  }
  return { status: input["status"] as ScriptRunState["status"], elapsedMs: input["elapsedMs"],
    ...(input["message"] === undefined ? {} : { message: boundedText(input["message"], SCRIPT_LIMITS.recordBytes) }) };
}
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid script task payload");
  const input = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(input, key)) || Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError("Invalid script task fields");
  }
  return input;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new TypeError("Invalid script task flag"); return value; }
function integer(value: unknown): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new TypeError("Invalid script task counter"); return value; }
function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max || new TextEncoder().encode(value).byteLength > max) throw new TypeError("Script task text is too long");
  return value;
}
