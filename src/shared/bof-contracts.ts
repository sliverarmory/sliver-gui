import type { TargetRef } from "./target-contracts.js";

export type BofArgumentType = "string" | "wstring" | "int" | "integer" | "short" | "file";

export interface BofArgumentDefinition {
  readonly name: string;
  readonly description: string;
  readonly type: BofArgumentType;
  readonly optional: boolean;
  readonly default?: string | number;
  readonly choices?: readonly (string | number)[];
}

export interface BofCommand {
  readonly id: string;
  readonly packageName: string;
  readonly commandName: string;
  readonly description: string;
  readonly arguments: readonly BofArgumentDefinition[];
  readonly available: boolean;
  readonly reason?: string;
}

export interface BofCatalog {
  readonly target: TargetRef;
  readonly commands: readonly BofCommand[];
  readonly warnings: readonly string[];
}

/** Native directory selection; the local path remains in Electron main. */
export interface BofDirectorySelection {
  readonly catalog: BofCatalog;
  readonly selectedCommandId: string;
}

export interface BofArgumentFileSelection {
  readonly token: string;
  readonly fileName: string;
  readonly size: number;
}

export interface ChooseBofArgumentFileInput {
  readonly commandId: string;
  readonly index: number;
}

export interface RunBofInput {
  readonly commandId: string;
  /** Values follow manifest order. Null applies the manifest default or zero value. */
  readonly arguments: readonly (string | number | null)[];
  readonly timeoutSeconds: number;
}

export interface BofExecutionOutput {
  readonly data: Uint8Array;
  readonly truncated: boolean;
}

export interface BofExecutionRecord {
  readonly id: string;
  readonly startedAt: string;
  readonly commandId: string;
  readonly commandName: string;
  readonly state: "running" | "submitted" | "completed" | "failed" | "outcome-unknown" | "request-failed";
  readonly taskId?: string;
  readonly stdout?: BofExecutionOutput;
  readonly stderr?: BofExecutionOutput;
  readonly error?: string;
}

export interface BofExecutionHistorySnapshot {
  readonly target: TargetRef;
  readonly revision: number;
  readonly records: readonly BofExecutionRecord[];
}

export interface BofExecutionRecordInput { readonly id: string }
export interface ClearBofExecutionHistoryInput { readonly id?: string }
export interface BofOutputInput {
  readonly id: string;
  readonly stream: "stdout" | "stderr" | "combined";
}
export interface AddBofOutputToLootInput extends BofOutputInput { readonly name: string }

const COMMAND_ID = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/u;
const TOKEN = /^[A-Za-z0-9_-]{1,256}$/u;

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid BOF request");
  const record = value as Record<string, unknown>;
  if (required.some((field) => !(field in record)) || Object.keys(record).some((field) => !required.includes(field) && !optional.includes(field))) {
    throw new TypeError("Invalid BOF request");
  }
  return record;
}

function commandId(value: unknown): string {
  if (typeof value !== "string" || value.length > 512 || !COMMAND_ID.test(value)) throw new TypeError("Invalid BOF command ID");
  return value;
}

function token(value: unknown): string {
  if (typeof value !== "string" || !TOKEN.test(value)) throw new TypeError("Invalid BOF record ID");
  return value;
}

export function parseChooseBofArgumentFileInput(value: unknown): ChooseBofArgumentFileInput {
  const record = object(value, ["commandId", "index"]);
  if (!Number.isInteger(record["index"]) || (record["index"] as number) < 0 || (record["index"] as number) >= 128) throw new TypeError("Invalid BOF argument index");
  return { commandId: commandId(record["commandId"]), index: record["index"] as number };
}

export function parseRunBofInput(value: unknown): RunBofInput {
  const record = object(value, ["commandId", "arguments", "timeoutSeconds"]);
  if (!Array.isArray(record["arguments"]) || record["arguments"].length > 128 ||
    record["arguments"].some((argument: unknown) => argument !== null &&
      !(typeof argument === "string" && argument.length <= 65_536 && !argument.includes("\0")) &&
      !(typeof argument === "number" && Number.isSafeInteger(argument)))) throw new TypeError("Invalid BOF arguments");
  if (!Number.isInteger(record["timeoutSeconds"]) || (record["timeoutSeconds"] as number) < 1 || (record["timeoutSeconds"] as number) > 3_600) {
    throw new TypeError("Invalid BOF timeout");
  }
  return { commandId: commandId(record["commandId"]), arguments: [...record["arguments"]] as (string | number | null)[], timeoutSeconds: record["timeoutSeconds"] as number };
}

export function parseBofExecutionRecordInput(value: unknown): BofExecutionRecordInput {
  const record = object(value, ["id"]);
  return { id: token(record["id"]) };
}

export function parseClearBofExecutionHistoryInput(value: unknown): ClearBofExecutionHistoryInput {
  const record = object(value, [], ["id"]);
  return record["id"] === undefined ? {} : { id: token(record["id"]) };
}

export function parseBofOutputInput(value: unknown): BofOutputInput {
  const record = object(value, ["id", "stream"]);
  if (record["stream"] !== "stdout" && record["stream"] !== "stderr" && record["stream"] !== "combined") throw new TypeError("Invalid BOF output stream");
  return { id: token(record["id"]), stream: record["stream"] };
}

export function parseAddBofOutputToLootInput(value: unknown): AddBofOutputToLootInput {
  const record = object(value, ["id", "stream", "name"]);
  const output = parseBofOutputInput({ id: record["id"], stream: record["stream"] });
  if (typeof record["name"] !== "string" || record["name"].length > 256 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(record["name"])) {
    throw new TypeError("Invalid BOF loot name");
  }
  return { ...output, name: record["name"] };
}
