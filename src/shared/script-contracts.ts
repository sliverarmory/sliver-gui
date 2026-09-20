export const SCRIPT_LIMITS = Object.freeze({
  sourceBytes: 512 * 1024,
  nameCharacters: 200,
  scripts: 1_000,
  manifestBytes: 512 * 1024,
} as const);

export const HELLO_WORLD_SCRIPT_NAME = "Hello World";
export const HELLO_WORLD_SCRIPT_SOURCE = 'console.log("Hello, world!");\n';

export interface ScriptSummary {
  id: string;
  name: string;
  revision: string;
}

export interface ScriptDocument extends ScriptSummary {
  source: string;
}

export interface ScriptCatalog {
  scripts: ScriptSummary[];
  warnings: string[];
}

export interface ScriptRuntimeAsset {
  version: string;
  sha256: string;
  bytes: Uint8Array;
}

export interface ReadScriptInput { id: string }
export interface CreateScriptInput { name: string; source: string }
export interface ExportScriptInput { name: string; source: string }
export interface ExportScriptResult { canceled: boolean }
export type ImportScriptResult = { canceled: true } | { canceled: false; script: ScriptDocument };
export interface SaveScriptInput { id: string; source: string; expectedRevision: string }
export interface RenameScriptInput { id: string; name: string; expectedRevision: string }
export interface DeleteScriptInput { id: string; expectedRevision: string }

export function parseScriptId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new TypeError("Script ID must be a canonical UUID v4");
  }
  return value;
}

export function parseScriptName(value: unknown): string {
  if (typeof value !== "string" || value.length > SCRIPT_LIMITS.nameCharacters || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`Script name must contain at most ${SCRIPT_LIMITS.nameCharacters} characters without control characters`);
  }
  const name = value.trim();
  if (!name) throw new TypeError("Script name is required");
  return name;
}

export function parseScriptSource(value: unknown): string {
  if (typeof value !== "string" || value.length > SCRIPT_LIMITS.sourceBytes) {
    throw new TypeError("Script source exceeds the 512 KiB limit");
  }
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > SCRIPT_LIMITS.sourceBytes || new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !== value) {
    throw new TypeError("Script source must be valid UTF-8 within the 512 KiB limit");
  }
  return value;
}

export function parseScriptRevision(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError("Script revision is invalid");
  }
  return value;
}

export function parseReadScriptInput(value: unknown): ReadScriptInput {
  const input = record(value, ["id"]);
  return { id: parseScriptId(input["id"]) };
}

export function parseCreateScriptInput(value: unknown): CreateScriptInput {
  const input = record(value, ["name", "source"]);
  return { name: parseScriptName(input["name"]), source: parseScriptSource(input["source"]) };
}

export function parseExportScriptInput(value: unknown): ExportScriptInput {
  const input = record(value, ["name", "source"]);
  return { name: parseScriptName(input["name"]), source: parseScriptSource(input["source"]) };
}

export function parseSaveScriptInput(value: unknown): SaveScriptInput {
  const input = record(value, ["id", "source", "expectedRevision"]);
  return { id: parseScriptId(input["id"]), source: parseScriptSource(input["source"]), expectedRevision: parseScriptRevision(input["expectedRevision"]) };
}

export function parseRenameScriptInput(value: unknown): RenameScriptInput {
  const input = record(value, ["id", "name", "expectedRevision"]);
  return { id: parseScriptId(input["id"]), name: parseScriptName(input["name"]), expectedRevision: parseScriptRevision(input["expectedRevision"]) };
}

export function parseDeleteScriptInput(value: unknown): DeleteScriptInput {
  const input = record(value, ["id", "expectedRevision"]);
  return { id: parseScriptId(input["id"]), expectedRevision: parseScriptRevision(input["expectedRevision"]) };
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid script input");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new TypeError("Invalid script input fields");
  }
  return input;
}
