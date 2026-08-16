import { sliverpb } from "sliver-script";

import type {
  ExecutionChildSummary,
  ExecutionChildrenResult,
  ExecutionOperationId,
  ExecutionPrivilegeSummary,
  ExecutionPrivilegesResult,
  ExecutionReadResult,
  RunExecutionReadInput,
} from "../shared/execution-contracts.js";
import { EXECUTION_LIMITS } from "../shared/execution-contracts.js";
import { executionOperationDescriptor } from "./execution-operation-registry.js";
import {
  EXECUTION_WORKBENCH_MAX_READ_ITEMS,
  EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
  ExecutionRemoteRejectedError,
  type ExecutionWorkbenchActionResult,
} from "./execution-workbench.js";

/**
 * A process result can contain independently bounded stdout and stderr fields.
 * Keep a small protobuf-envelope allowance while rejecting unbounded payloads
 * before any decoder allocation or normalization work.
 */
export const EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES =
  (2 * EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES) + (64 * 1_024);

export const EXECUTION_BEACON_TASK_DECODE_MESSAGE =
  "The beacon task result could not be decoded safely";
export const EXECUTION_BEACON_TASK_MISMATCH_MESSAGE =
  "The beacon task description did not match the reviewed operation";
export const EXECUTION_BEACON_READ_INPUT_MESSAGE =
  "The execution read page request is invalid or stale";
export const EXECUTION_BEACON_TASK_UNVERIFIABLE_MESSAGE =
  "The beacon task response cannot prove whether the target operation succeeded";

export type ExecutionBeaconTaskDecodeReason =
  | "description-mismatch"
  | "invalid-response"
  | "invalid-read-input"
  | "unverifiable-response";

/** Fixed-message structural failure. Remote Response.Err text uses the
 * separate fixed-message ExecutionRemoteRejectedError boundary. */
export class ExecutionBeaconTaskDecodeError extends Error {
  constructor(readonly reason: ExecutionBeaconTaskDecodeReason) {
    super(
      reason === "description-mismatch"
        ? EXECUTION_BEACON_TASK_MISMATCH_MESSAGE
        : reason === "invalid-read-input"
          ? EXECUTION_BEACON_READ_INPUT_MESSAGE
          : reason === "unverifiable-response"
            ? EXECUTION_BEACON_TASK_UNVERIFIABLE_MESSAGE
            : EXECUTION_BEACON_TASK_DECODE_MESSAGE,
    );
    this.name = "ExecutionBeaconTaskDecodeError";
  }
}

export interface DecodeExecutionBeaconTaskInput {
  readonly operationId: ExecutionOperationId;
  readonly description: string;
  /** Caller-owned encoded response. It is always zeroized before return. */
  readonly response: Uint8Array;
  /** Required for read operations and forbidden for action operations. */
  readonly readInput?: RunExecutionReadInput;
}

export type DecodedExecutionBeaconTask =
  | { readonly kind: "action"; readonly value: ExecutionWorkbenchActionResult }
  | { readonly kind: "read"; readonly value: ExecutionReadResult };

/** Exact server task descriptions after server-side request transformation. */
export const EXECUTION_BEACON_TASK_DESCRIPTIONS = Object.freeze({
  "execution.process": Object.freeze(["ExecuteReq", "ExecuteWindowsReq"]),
  "execution.children": Object.freeze(["ExecuteChildrenReq"]),
  "execution.assembly": Object.freeze([
    "InvokeExecuteAssemblyReq",
    "InvokeInProcExecuteAssemblyReq",
  ]),
  "execution.shellcode": Object.freeze(["TaskReq"]),
  "execution.sideload": Object.freeze(["SideloadReq"]),
  "execution.spawn-dll": Object.freeze(["SpawnDllReq"]),
  "execution.migrate": Object.freeze(["InvokeMigrateReq"]),
  "execution.msf": Object.freeze(["TaskReq"]),
  "execution.msf-inject": Object.freeze(["TaskReq"]),
  "privilege.get": Object.freeze(["GetPrivsReq"]),
  "privilege.run-as": Object.freeze(["RunAsReq"]),
  "privilege.make-token": Object.freeze(["MakeTokenReq"]),
  "privilege.impersonate": Object.freeze(["ImpersonateReq"]),
  "privilege.revert": Object.freeze(["RevToSelfReq"]),
} as const satisfies Readonly<Partial<Record<ExecutionOperationId, readonly string[]>>>);

/**
 * Decodes only M4 beacon responses whose locally correlated operation and
 * server description agree. The encoded response is destroyed on every exit;
 * returned output buffers are independent bounded copies.
 */
export function decodeExecutionBeaconTask(
  input: DecodeExecutionBeaconTaskInput,
): DecodedExecutionBeaconTask {
  try {
    assertDescription(input.operationId, input.description);
    assertResponseSize(input.response);
    assertReadInput(input.operationId, input.readInput);

    try {
      return decodeBoundResponse(input);
    } catch (error) {
      if (error instanceof ExecutionRemoteRejectedError || error instanceof ExecutionBeaconTaskDecodeError) {
        throw error;
      }
      throw new ExecutionBeaconTaskDecodeError("invalid-response");
    }
  } finally {
    input.response.fill(0);
  }
}

function decodeBoundResponse(input: DecodeExecutionBeaconTaskInput): DecodedExecutionBeaconTask {
  const { operationId, response } = input;
  switch (operationId) {
    case "execution.process": {
      const decoded = sliverpb.Execute.decode(response);
      assertCanonicalResponse(response, sliverpb.Execute.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      const pid = positivePid(decoded.Pid);
      if (pid === undefined) throw new ExecutionBeaconTaskDecodeError("invalid-response");
      return action(operationId, {
        pid,
        stdout: decoded.Stdout,
        stderr: decoded.Stderr,
      });
    }
    case "execution.children": {
      const decoded = sliverpb.ExecuteChildren.decode(response);
      assertCanonicalResponse(response, sliverpb.ExecuteChildren.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, true);
      return { kind: "read", value: normalizeChildren(decoded, input.readInput!) };
    }
    case "execution.assembly": {
      const decoded = sliverpb.ExecuteAssembly.decode(response);
      assertCanonicalResponse(response, sliverpb.ExecuteAssembly.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId, { stdout: decoded.Output });
    }
    case "execution.shellcode":
    case "execution.msf":
    case "execution.msf-inject": {
      // The pinned implant task handler returns an empty payload for both
      // success and failure, while the separate handler error is not retained
      // in the beacon task response. Task state therefore cannot prove the
      // reviewed effect and must remain explicitly uncertain.
      throw new ExecutionBeaconTaskDecodeError("unverifiable-response");
    }
    case "execution.sideload": {
      const decoded = sliverpb.Sideload.decode(response);
      assertCanonicalResponse(response, sliverpb.Sideload.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, true);
      return action(operationId, { stdout: decoded.Result });
    }
    case "execution.spawn-dll": {
      const decoded = sliverpb.SpawnDll.decode(response);
      assertCanonicalResponse(response, sliverpb.SpawnDll.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId, { stdout: decoded.Result });
    }
    case "execution.migrate": {
      const decoded = sliverpb.Migrate.decode(response);
      assertCanonicalResponse(response, sliverpb.Migrate.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      const pid = positivePid(decoded.Pid);
      if (!decoded.Success || pid === undefined) throw new ExecutionRemoteRejectedError();
      return action(operationId, { pid });
    }
    case "privilege.get": {
      const decoded = sliverpb.GetPrivs.decode(response);
      assertCanonicalResponse(response, sliverpb.GetPrivs.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, true);
      return { kind: "read", value: normalizePrivileges(decoded, input.readInput!) };
    }
    case "privilege.run-as": {
      const decoded = sliverpb.RunAs.decode(response);
      assertCanonicalResponse(response, sliverpb.RunAs.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId, { stdout: decoded.Output });
    }
    case "privilege.make-token": {
      const decoded = sliverpb.MakeToken.decode(response);
      assertCanonicalResponse(response, sliverpb.MakeToken.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId);
    }
    case "privilege.impersonate": {
      const decoded = sliverpb.Impersonate.decode(response);
      assertCanonicalResponse(response, sliverpb.Impersonate.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId);
    }
    case "privilege.revert": {
      const decoded = sliverpb.RevToSelf.decode(response);
      assertCanonicalResponse(response, sliverpb.RevToSelf.encode(decoded).finish());
      assertCompletedEnvelope(decoded.Response, false);
      return action(operationId);
    }
    case "execution.psexec":
    case "execution.ssh":
    case "execution.backdoor":
    case "execution.dll-hijack":
    case "privilege.get-system":
      throw new ExecutionBeaconTaskDecodeError("description-mismatch");
  }
}

function action(
  operationId: ExecutionOperationId,
  values: { pid?: number; stdout?: Uint8Array | string; stderr?: Uint8Array | string } = {},
): DecodedExecutionBeaconTask {
  const stdout = values.stdout === undefined || byteLength(values.stdout) === 0
    ? undefined
    : boundedOutput(values.stdout);
  const stderr = values.stderr === undefined || byteLength(values.stderr) === 0
    ? undefined
    : boundedOutput(values.stderr);
  return {
    kind: "action",
    value: Object.freeze({
      ...(values.pid === undefined ? {} : { pid: values.pid }),
      ...(stdout === undefined ? {} : { stdout: stdout.data, stdoutTruncated: stdout.truncated }),
      ...(stderr === undefined ? {} : { stderr: stderr.data, stderrTruncated: stderr.truncated }),
      summary: executionOperationDescriptor(operationId).completedMessage,
    }),
  };
}

function normalizeChildren(
  response: sliverpb.ExecuteChildren,
  input: RunExecutionReadInput,
): ExecutionChildrenResult {
  const items: ExecutionChildSummary[] = [];
  for (const child of response.Children.slice(0, EXECUTION_WORKBENCH_MAX_READ_ITEMS)) {
    const pid = positivePid(child.Pid);
    if (pid === undefined) continue;
    const startedAt = safeDate(child.StartTime);
    const exitedAt = safeDate(child.ExitTime);
    const error = boundedOptionalText(child.Error, 512);
    items.push(Object.freeze({
      pid,
      path: boundedText(child.Path, EXECUTION_LIMITS.path),
      args: child.Args.slice(0, 32).map((item) => boundedText(item, EXECUTION_LIMITS.shortString)),
      ...(startedAt ? { startedAt } : {}),
      exited: child.Exited,
      ...(child.Exited && Number.isSafeInteger(child.ExitCode) ? { exitCode: child.ExitCode } : {}),
      ...(exitedAt ? { exitedAt } : {}),
      stdoutBytes: byteLength(child.Stdout),
      stderrBytes: byteLength(child.Stderr),
      ...(error ? { error } : {}),
    }));
  }
  const page = pageItems(items, input, response.Children.length > EXECUTION_WORKBENCH_MAX_READ_ITEMS);
  return Object.freeze({
    operationId: "execution.children",
    state: "completed",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    items: page.items,
    total: items.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
  });
}

function normalizePrivileges(
  response: sliverpb.GetPrivs,
  input: RunExecutionReadInput,
): ExecutionPrivilegesResult {
  const privileges: ExecutionPrivilegeSummary[] = [];
  for (const item of response.PrivInfo.slice(0, EXECUTION_WORKBENCH_MAX_READ_ITEMS)) {
    const name = boundedText(item.Name, EXECUTION_LIMITS.shortString);
    if (!name) continue;
    privileges.push(Object.freeze({
      name,
      description: boundedText(item.Description, 512),
      enabled: item.Enabled,
      enabledByDefault: item.EnabledByDefault,
      removed: item.Removed,
      usedForAccess: item.UsedForAccess,
    }));
  }
  const page = pageItems(privileges, input, response.PrivInfo.length > EXECUTION_WORKBENCH_MAX_READ_ITEMS);
  return Object.freeze({
    operationId: "privilege.get",
    state: "completed",
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    processName: boundedText(response.ProcessName, EXECUTION_LIMITS.shortString),
    processIntegrity: boundedText(response.ProcessIntegrity, EXECUTION_LIMITS.shortString),
    privileges: page.items,
    total: privileges.length,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    truncated: page.truncated,
  });
}

function pageItems<Item>(
  items: readonly Item[],
  input: RunExecutionReadInput,
  sourceTruncated: boolean,
): { items: Item[]; nextCursor?: string; truncated: boolean } {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > EXECUTION_LIMITS.pageLimit) {
    throw new ExecutionBeaconTaskDecodeError("invalid-read-input");
  }
  const offset = readCursor(input.cursor, input.operationId);
  if (offset > items.length) throw new ExecutionBeaconTaskDecodeError("invalid-read-input");
  const end = Math.min(items.length, offset + limit);
  const nextCursor = end < items.length
    ? `execution-read:v2:${input.operationId}:${input.taskId}:${end}`
    : undefined;
  return {
    items: items.slice(offset, end),
    ...(nextCursor ? { nextCursor } : {}),
    truncated: sourceTruncated || nextCursor !== undefined,
  };
}

function readCursor(value: string | undefined, operationId: RunExecutionReadInput["operationId"]): number {
  if (value === undefined) return 0;
  const match = /^execution-read:v2:([^:]+):([A-Za-z0-9_-]{1,128}):([0-9]+)$/u.exec(value);
  if (!match || match[1] !== operationId) {
    throw new ExecutionBeaconTaskDecodeError("invalid-read-input");
  }
  const offset = Number(match[3]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ExecutionBeaconTaskDecodeError("invalid-read-input");
  }
  return offset;
}

function assertDescription(operationId: ExecutionOperationId, description: string): void {
  const descriptions = EXECUTION_BEACON_TASK_DESCRIPTIONS[operationId as keyof typeof EXECUTION_BEACON_TASK_DESCRIPTIONS];
  if (!descriptions || !(descriptions as readonly string[]).includes(description)) {
    throw new ExecutionBeaconTaskDecodeError("description-mismatch");
  }
}

function assertResponseSize(response: Uint8Array): void {
  if (!(response instanceof Uint8Array) || response.byteLength > EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES) {
    throw new ExecutionBeaconTaskDecodeError("invalid-response");
  }
}

function assertCanonicalResponse(response: Uint8Array, encoded: Uint8Array): void {
  if (
    response.byteLength !== encoded.byteLength ||
    response.some((byte, index) => byte !== encoded[index])
  ) throw new ExecutionBeaconTaskDecodeError("invalid-response");
}

function assertReadInput(
  operationId: ExecutionOperationId,
  readInput: RunExecutionReadInput | undefined,
): void {
  const isRead = operationId === "execution.children" || operationId === "privilege.get";
  if (
    isRead !== (readInput !== undefined) ||
    (readInput && (
      readInput.operationId !== operationId ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(readInput.taskId ?? "") ||
      (readInput.cursor !== undefined &&
        !readInput.cursor.startsWith(`execution-read:v2:${operationId}:${readInput.taskId}:`))
    ))
  ) {
    throw new ExecutionBeaconTaskDecodeError("invalid-read-input");
  }
}

function assertCompletedEnvelope(response: {
  Err: string;
  Async: boolean;
  BeaconID: string;
  TaskID: string;
} | undefined, required: boolean): void {
  if (!response) {
    if (required) throw new ExecutionBeaconTaskDecodeError("invalid-response");
    return;
  }
  if (response.Err) throw new ExecutionRemoteRejectedError();
  if (response.Async || response.BeaconID || response.TaskID) {
    throw new ExecutionBeaconTaskDecodeError("invalid-response");
  }
}

function boundedOutput(value: Uint8Array | string): { data: Buffer; truncated: boolean } {
  if (typeof value !== "string") {
    return {
      data: Buffer.from(value.subarray(0, EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES)),
      truncated: value.byteLength > EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
    };
  }
  const encodedBytes = Buffer.byteLength(value, "utf8");
  const data = Buffer.alloc(Math.min(encodedBytes, EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES));
  const written = data.write(value, 0, data.length, "utf8");
  return {
    data: written === data.length ? data : Buffer.from(data.subarray(0, written)),
    truncated: encodedBytes > EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES,
  };
}

function positivePid(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 && value <= EXECUTION_LIMITS.pid ? value : undefined;
}

function safeDate(value: string): string | undefined {
  if (!/^[0-9]{1,16}$/u.test(value) || value === "0") return undefined;
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function boundedText(value: string, maximumCharacters: number): string {
  return [...value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, "")]
    .slice(0, maximumCharacters)
    .join("");
}

function boundedOptionalText(value: string, maximumCharacters: number): string | undefined {
  const bounded = boundedText(value, maximumCharacters);
  return bounded || undefined;
}

function byteLength(value: Uint8Array | string): number {
  return typeof value === "string"
    ? Math.min(Buffer.byteLength(value, "utf8"), Number.MAX_SAFE_INTEGER)
    : Math.min(value.byteLength, Number.MAX_SAFE_INTEGER);
}
