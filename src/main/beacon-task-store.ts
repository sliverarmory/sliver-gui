import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { sliverpb, type clientpb } from "sliver-script";

import type {
  BeaconTaskDetail,
  BeaconTaskExecutionOutput,
  BeaconTaskPage,
  BeaconTaskResponse,
  BeaconTaskState,
  BeaconTaskSummary,
  OperationOwnership,
  TargetOperationId,
  TargetOperationInput,
} from "../shared/operation-contracts.js";
import { isSensitiveSessionEnvironmentName } from "../shared/session-contracts.js";
import { isExecutionReadOperationId, type ExecutionOperationId, type ExecutionReadOperationId, type ExecutionReadResult } from "../shared/execution-contracts.js";
import { decodeBofOutput, decodeBofTask } from "./bof-workbench.js";
import { decodeExecutionBeaconTask, EXECUTION_BEACON_TASK_DESCRIPTIONS, EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES } from "./execution-beacon-task.js";
import { ExecutionRemoteRejectedError } from "./execution-workbench.js";
import { decodeHistoricalBeaconTask } from "./historical-beacon-task.js";
import { verifyBeaconReadRequest } from "./beacon-read-request.js";
import { decodeBeaconTaskResponse, pageBeaconTaskResponse } from "./beacon-task-response.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const MAX_TASKS = 500;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_DESCRIPTION = 256;
const MAX_DECODE_BYTES = 64 * 1024;
const MAX_FILE_RESPONSE_BYTES = 128 * 1024;
const MAX_TEXT_FILE_BYTES = 65_536;
const MAX_CURSOR_SNAPSHOTS = 32;
const MAX_CURSOR_SNAPSHOTS_PER_OWNER = 4;
const CURSOR_SNAPSHOT_TTL_MS = 60_000;
const MAX_CONCURRENT_TASK_DETAILS = 8;
const MAX_CONCURRENT_TASK_CANCELLATIONS = 8;
const MAX_CONCURRENT_TASK_REFRESHES = 16;
const MAX_TASK_CATALOGS = 512;
const MAX_RESULT_ROWS = 256;
const MAX_RESULT_TEXT = 4_096;
const MAX_RESULT_NESTED_ITEMS = 64;
const TASK_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const CANCELLABLE_TASK_DESCRIPTIONS = new Set([
  "Ping",
  "SetEnvReq",
  "UnsetEnvReq",
  "OpenSession",
  "ExecuteReq",
  "ExecuteWindowsReq",
  "ExecuteChildrenReq",
  "InvokeExecuteAssemblyReq",
  "InvokeInProcExecuteAssemblyReq",
  "TaskReq",
  "SideloadReq",
  "SpawnDllReq",
  "InvokeMigrateReq",
  "RunAsReq",
  "MakeTokenReq",
  "ImpersonateReq",
  "RevToSelfReq",
  "GetPrivsReq",
  "PwdReq",
  "LsReq",
  "PsReq",
  "IfconfigReq",
  "EnvReq",
  "CurrentTokenOwnerReq",
  "NetstatReq",
  "MountReq",
  "MemfilesListReq",
  "DownloadReq",
  "GrepReq",
  "RegistryReadReq",
  "RegistrySubKeyListReq",
  "RegistryListValuesReq",
  "ServicesReq",
  "ServiceDetailReq",
]);

interface InternalTask {
  taskId: string;
  beaconId: string;
  state: BeaconTaskState;
  serverState: string;
  description: string;
  createdAt?: string;
  sentAt?: string;
  completedAt?: string;
  resultAvailable: boolean;
}

interface TaskCatalog {
  revision: number;
  total: number;
  truncated: boolean;
  items: InternalTask[];
  byId: Map<string, InternalTask>;
  retainedTaskIds: Set<string>;
  lastAccessed: number;
}

interface RefreshState {
  dirty: boolean;
  invalidated: boolean;
  promise: Promise<void>;
  pinnedTaskIds: Set<string>;
  retainedTaskIds: Set<string>;
}

interface CursorSnapshot {
  beaconId: string;
  ownerKey: string;
  accessKey: string;
  items: InternalTask[];
  total: number;
  truncated: boolean;
  expiresAt: number;
}

export interface TaskCursorScope {
  ownerKey: string;
  accessKey: string;
}

const UNSCOPED_CURSOR: TaskCursorScope = Object.freeze({
  ownerKey: "unscoped",
  accessKey: "unscoped",
});

export type TaskOwnershipResolver = (taskId: string, beaconId: string) => {
  ownership: OperationOwnership;
  localRequestId?: string;
  operationId?: TargetOperationId;
  executionOperationId?: ExecutionOperationId | "bof.execute";
  processWaited?: boolean;
  expectedPingNonce?: number | undefined;
  expectedRequest?: TargetOperationInput;
};

const EXPECTED_DESCRIPTION_BY_OPERATION: Readonly<Partial<Record<TargetOperationId, string>>> = Object.freeze({
  "target.ping": "Ping",
  "target.env-set": "SetEnvReq",
  "target.env-unset": "UnsetEnvReq",
  "beacon.reconfigure": "ReconfigureReq",
  "beacon.open-session": "OpenSession",
  "beacon.filesystem.pwd": "PwdReq",
  "beacon.filesystem.ls": "LsReq",
  "beacon.process.list": "PsReq",
  "beacon.network.interfaces": "IfconfigReq",
  "beacon.environment.list": "EnvReq",
  "beacon.identity.whoami": "CurrentTokenOwnerReq",
  "beacon.network.netstat": "NetstatReq",
  "beacon.filesystem.mount": "MountReq",
  "beacon.filesystem.memfiles": "MemfilesListReq",
  "beacon.filesystem.cat": "DownloadReq",
  "beacon.filesystem.head": "DownloadReq",
  "beacon.filesystem.tail": "DownloadReq",
  "beacon.filesystem.grep": "GrepReq",
  "beacon.registry.read": "RegistryReadReq",
  "beacon.registry.list-subkeys": "RegistrySubKeyListReq",
  "beacon.registry.list-values": "RegistryListValuesReq",
  "beacon.registry.write": "RegistryWriteReq",
  "beacon.registry.create": "RegistryCreateKeyReq",
  "beacon.registry.delete": "RegistryDeleteKeyReq",
  "beacon.service.list": "ServicesReq",
  "beacon.service.info": "ServiceDetailReq",
  "beacon.service.start": "StartServiceByNameReq",
  "beacon.service.stop": "StopServiceReq",
});

const NEW_M2_OPERATION_IDS = new Set<TargetOperationId>([
  "beacon.environment.list", "beacon.identity.whoami", "beacon.network.netstat",
  "beacon.filesystem.mount", "beacon.filesystem.memfiles", "beacon.filesystem.cat",
  "beacon.filesystem.head", "beacon.filesystem.tail", "beacon.filesystem.grep",
  "beacon.registry.read", "beacon.registry.list-subkeys", "beacon.registry.list-values",
  "beacon.registry.write", "beacon.registry.create", "beacon.registry.delete",
  "beacon.service.list", "beacon.service.info", "beacon.service.start", "beacon.service.stop",
]);

const BC08_OPERATION_IDS = new Set<TargetOperationId>([
  "beacon.registry.read", "beacon.registry.list-subkeys", "beacon.registry.list-values",
  "beacon.registry.write", "beacon.registry.create", "beacon.registry.delete",
  "beacon.service.list", "beacon.service.info", "beacon.service.start", "beacon.service.stop",
]);

const EXTERNAL_OPERATION_BY_DESCRIPTION = new Map<string, TargetOperationId>(
  Object.entries(EXPECTED_DESCRIPTION_BY_OPERATION)
    .filter(([operationId, description], _index, entries) =>
      !NEW_M2_OPERATION_IDS.has(operationId as TargetOperationId) &&
      entries.filter(([, candidate]) => candidate === description).length === 1)
    .map(([operationId, description]) => [description, operationId as TargetOperationId]),
);

const EXTERNAL_EXECUTION_BY_DESCRIPTION = new Map<string, ExecutionOperationId>([
  ["ExecuteReq", "execution.process"],
  ["ExecuteWindowsReq", "execution.process"],
  ["InvokeExecuteAssemblyReq", "execution.assembly"],
  ["InvokeInProcExecuteAssemblyReq", "execution.assembly"],
  ["SideloadReq", "execution.sideload"],
  ["SpawnDllReq", "execution.spawn-dll"],
  ["InvokeMigrateReq", "execution.migrate"],
  ["RunAsReq", "privilege.run-as"],
]);

const UNKNOWN_OWNERSHIP = Object.freeze({
  origin: "unknown",
  actor: { attribution: "unknown" },
} as const satisfies OperationOwnership);

export class BeaconTaskCancellationError extends Error {
  constructor(message: string, readonly dispatchStarted: boolean) {
    super(message);
    this.name = "BeaconTaskCancellationError";
  }
}

/** Shared, metadata-only task inventory. Detail requests fetch and decode one
 * bounded server-saved payload at a time, then zeroize its raw bytes. */
export class BeaconTaskStore {
  private readonly catalogs = new Map<string, TaskCatalog>();
  private readonly refreshes = new Map<string, RefreshState>();
  private readonly cursorSnapshots = new Map<string, CursorSnapshot>();
  private readonly cancelFlights = new Map<string, Promise<InternalTask>>();
  private detailAdmissions = 0;
  private refreshAdmissions = 0;
  private storeGeneration = 0;
  private catalogClock = 0;

  constructor(private readonly client: Pick<SliverClientAdapter,
    "getBeaconTasks" | "fetchBeaconTaskContent" | "fetchBofBeaconTask" | "cancelBeaconTask">) {}

  async refresh(
    beaconId: string,
    pinnedTaskIds: Iterable<string> = [],
    retainedTaskIds: Iterable<string> = pinnedTaskIds,
  ): Promise<void> {
    const normalizedBeaconId = requireIdentifier(beaconId, "beacon ID");
    const normalizedPins = [...pinnedTaskIds].map((taskId) => requireIdentifier(taskId, "task ID"));
    const normalizedRetained = [...retainedTaskIds].map((taskId) => requireIdentifier(taskId, "task ID"));
    const active = this.refreshes.get(normalizedBeaconId);
    if (active) {
      for (const taskId of normalizedPins) active.pinnedTaskIds.add(taskId);
      for (const taskId of normalizedRetained) active.retainedTaskIds.add(taskId);
      active.dirty = true;
      return active.promise;
    }
    if (this.refreshAdmissions >= MAX_CONCURRENT_TASK_REFRESHES) {
      throw new Error("Too many distinct beacon task inventories are already being refreshed; wait for one to finish");
    }
    this.refreshAdmissions += 1;

    const state: RefreshState = {
      dirty: false,
      invalidated: false,
      promise: Promise.resolve(),
      pinnedTaskIds: new Set(normalizedPins),
      retainedTaskIds: new Set(normalizedRetained),
    };
    const storeGeneration = this.storeGeneration;
    state.promise = this.refreshUntilClean(normalizedBeaconId, state, storeGeneration)
      .finally(() => {
        this.refreshAdmissions -= 1;
        if (this.refreshes.get(normalizedBeaconId) === state) {
          this.refreshes.delete(normalizedBeaconId);
        }
      });
    this.refreshes.set(normalizedBeaconId, state);
    return state.promise;
  }

  list(
    beaconId: string,
    request: { cursor?: string; limit?: number } = {},
    resolveOwnership: TaskOwnershipResolver = () => ({ ownership: UNKNOWN_OWNERSHIP }),
    cursorScope: TaskCursorScope = UNSCOPED_CURSOR,
  ): BeaconTaskPage {
    const normalizedBeaconId = requireIdentifier(beaconId, "beacon ID");
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new Error(`Task page limit must be between 1 and ${MAX_PAGE_LIMIT}`);
    }
    this.pruneCursorSnapshots();
    const continuation = request.cursor
      ? this.cursorSnapshot(request.cursor, normalizedBeaconId, cursorScope)
      : undefined;
    const catalog = continuation ? undefined : this.requireCatalog(normalizedBeaconId);
    const items = continuation?.snapshot.items ?? catalog!.items;
    const total = continuation?.snapshot.total ?? catalog!.total;
    const truncated = continuation?.snapshot.truncated ?? catalog!.truncated;
    const offset = continuation?.offset ?? 0;
    const selected = items.slice(offset, offset + limit);
    const nextOffset = offset + selected.length;
    let nextCursor: string | undefined;
    if (nextOffset < items.length) {
      const token = continuation?.token ?? this.saveCursorSnapshot({
        beaconId: normalizedBeaconId,
        ownerKey: cursorScope.ownerKey,
        accessKey: cursorScope.accessKey,
        items: items.map((item) => ({ ...item })),
        total,
        truncated,
        expiresAt: Date.now() + CURSOR_SNAPSHOT_TTL_MS,
      });
      nextCursor = taskCursor(token, nextOffset);
    } else if (continuation) {
      this.cursorSnapshots.delete(continuation.token);
    }
    return {
      items: selected.map((item) => projectTask(item, resolveOwnership(item.taskId, item.beaconId))),
      page: {
        limit,
        total,
        truncated: truncated || nextOffset < items.length,
        ...(nextCursor ? { nextCursor } : {}),
      },
    };
  }

  async detail(
    beaconId: string,
    taskId: string,
    resolveOwnership: TaskOwnershipResolver = () => ({ ownership: UNKNOWN_OWNERSHIP }),
  ): Promise<BeaconTaskDetail> {
    const task = this.requireTask(beaconId, taskId);
    const attribution = resolveOwnership(task.taskId, task.beaconId);
    const base = projectTask(task, attribution);
    const executionOperationId = attribution.executionOperationId ?? (
      attribution.operationId ? undefined : EXTERNAL_EXECUTION_BY_DESCRIPTION.get(task.description)
    );
    if (executionOperationId) {
      return this.executionDetail(task, base, executionOperationId, attribution);
    }
    const operationId = attribution.operationId ?? EXTERNAL_OPERATION_BY_DESCRIPTION.get(task.description);
    if (!task.resultAvailable) {
      if (task.state === "completed" && operationId && BC08_OPERATION_IDS.has(operationId)) {
        return detailError(base, operationId, "decode-uncertain", "The completed Registry or service task has no result available");
      }
      return base;
    }
    if (!operationId) return this.historicalDetail(task, base);
    if (BC08_OPERATION_IDS.has(operationId) && !attribution.expectedRequest) {
      return detailError(base, operationId, "decode-uncertain", "The reviewed Registry or service request is unavailable");
    }
    const expectedDescription = EXPECTED_DESCRIPTION_BY_OPERATION[operationId];
    if (attribution.operationId && task.description !== expectedDescription) {
      return detailError(
        base,
        operationId,
        "decode-uncertain",
        "The task description did not match the locally submitted operation",
      );
    }

    if (this.detailAdmissions >= MAX_CONCURRENT_TASK_DETAILS) {
      throw new Error("Too many beacon task details are already being fetched; wait for one to finish");
    }
    this.detailAdmissions += 1;
    try {

    let content: clientpb.BeaconTask;
    try {
      content = await this.client.fetchBeaconTaskContent(task.beaconId, task.taskId, task.description);
    } catch {
      return detailError(
        base,
        operationId,
        "decode-uncertain",
        "The beacon task result could not be fetched",
      );
    }
    try {
      if (content.ID !== task.taskId || content.BeaconID !== task.beaconId) {
        return detailError(
          base,
          operationId,
          "decode-uncertain",
          "The server returned task content for a different resource",
        );
      }
      if (attribution.expectedRequest &&
        (content.Description !== task.description || content.State.trim().toLowerCase() !== "completed")) {
        return detailError(base, operationId, "decode-uncertain", "The server returned task content for a different task state or description");
      }
      if (attribution.expectedRequest) {
        try {
          if (attribution.expectedRequest.operationId !== operationId) throw new Error("Operation mismatch");
          verifyBeaconReadRequest(attribution.expectedRequest, content.Request);
        } catch {
          return detailError(base, operationId, "decode-uncertain", "The saved task request did not match the selected command");
        }
      }
      if (content.Response.length > maximumResponseBytes(operationId)) {
        if (!attribution.operationId) {
          const fallback = decodeHistoricalBeaconTask(task.description, content.Request, content.Response);
          if (fallback.disposition) return { ...base, operationId, ...fallback };
        }
        return detailError(
          base,
          operationId,
          "decode-uncertain",
          "The beacon task result is too large to preview safely",
        );
      }
      if (requiresExactlyEmptyResponse(operationId) && content.Response.length !== 0) {
        return detailError(
          base,
          operationId,
          "decode-uncertain",
          "The beacon task result did not match the expected empty response",
        );
      }
      if (
        content.Response.length === 0 &&
        !requiresExactlyEmptyResponse(operationId) &&
        !allowsEmptyDecodedResponse(operationId, attribution.expectedRequest)
      ) {
        return detailError(
          base,
          operationId,
          "decode-uncertain",
          "The beacon task result did not include a decodable response",
        );
      }
      try {
        const disposition = decodeDisposition(operationId, content.Response, attribution.expectedPingNonce);
        return { ...base, operationId, disposition };
      } catch (error) {
        const targetReported = error instanceof TargetReportedTaskError;
        if (!targetReported && !attribution.operationId) {
          const fallback = decodeHistoricalBeaconTask(task.description, content.Request, content.Response);
          if (fallback.disposition) return { ...base, operationId, ...fallback };
        }
        return detailError(
          base,
          operationId,
          targetReported ? "target-reported" : "decode-uncertain",
          targetReported
            ? "The beacon task response reported an error"
            : "The beacon task result could not be decoded safely",
        );
      }
    } finally {
      content.Request.fill(0);
      content.Response.fill(0);
    }
    } finally {
      this.detailAdmissions -= 1;
    }
  }

  /** Fetch complete response pages on demand without retaining sensitive saved
   * payloads in the metadata catalog or applying the task preview's limits. */
  async response(
    beaconId: string,
    taskId: string,
    offset = 0,
    resolveOwnership: TaskOwnershipResolver = () => ({ ownership: UNKNOWN_OWNERSHIP }),
  ): Promise<BeaconTaskResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("The task response page offset is invalid");
    const task = this.requireTask(beaconId, taskId);
    if (!task.resultAvailable || task.state !== "completed") {
      throw new Error("The selected task does not have a completed response available");
    }
    const attribution = resolveOwnership(task.taskId, task.beaconId);
    if (attribution.operationId && task.description !== EXPECTED_DESCRIPTION_BY_OPERATION[attribution.operationId]) {
      throw new Error("The task description did not match the locally submitted operation");
    }
    if (attribution.executionOperationId) {
      const descriptions = attribution.executionOperationId === "bof.execute" ? ["CallExtensionReq"]
        : EXECUTION_BEACON_TASK_DESCRIPTIONS[attribution.executionOperationId as keyof typeof EXECUTION_BEACON_TASK_DESCRIPTIONS];
      if (!descriptions || !(descriptions as readonly string[]).includes(task.description)) {
        throw new Error("The task description did not match the locally submitted operation");
      }
    }
    if (attribution.operationId && BC08_OPERATION_IDS.has(attribution.operationId) && !attribution.expectedRequest) {
      throw new Error("The reviewed Registry or service request is unavailable");
    }
    if (this.detailAdmissions >= MAX_CONCURRENT_TASK_DETAILS) {
      throw new Error("Too many beacon task details are already being fetched; wait for one to finish");
    }
    this.detailAdmissions += 1;
    const generation = this.storeGeneration;
    try {
      const content = await this.client.fetchBeaconTaskContent(task.beaconId, task.taskId, task.description);
      try {
        if (content.ID !== task.taskId || content.BeaconID !== task.beaconId ||
          content.Description !== task.description || content.State.trim().toLowerCase() !== "completed") {
          throw new Error("The server returned task content for a different resource, state, or description");
        }
        const current = this.requireTask(task.beaconId, task.taskId);
        if (generation !== this.storeGeneration || current.state !== "completed" ||
          current.description !== task.description || current.createdAt !== task.createdAt || current.completedAt !== task.completedAt) {
          throw new Error("The selected task changed while its complete response was being fetched");
        }
        if (attribution.expectedRequest) {
          if (attribution.expectedRequest.operationId !== attribution.operationId) {
            throw new Error("The saved task request did not match the selected command");
          }
          try { verifyBeaconReadRequest(attribution.expectedRequest, content.Request); }
          catch { throw new Error("The saved task request did not match the selected command"); }
        }
        if (attribution.operationId && requiresExactlyEmptyResponse(attribution.operationId) && content.Response.length !== 0) {
          throw new Error("The beacon task result did not match the expected empty response");
        }
        const decoded = decodeBeaconTaskResponse(task.description, content.Request, content.Response, attribution.expectedPingNonce);
        return pageBeaconTaskResponse(task.beaconId, task.taskId, decoded, offset);
      } finally {
        content.Request.fill(0);
        content.Response.fill(0);
      }
    } finally {
      this.detailAdmissions -= 1;
    }
  }

  private async historicalDetail(task: InternalTask, base: BeaconTaskSummary): Promise<BeaconTaskDetail> {
    if (this.detailAdmissions >= MAX_CONCURRENT_TASK_DETAILS) {
      throw new Error("Too many beacon task details are already being fetched; wait for one to finish");
    }
    this.detailAdmissions += 1;
    try {
      let content: clientpb.BeaconTask;
      try {
        content = await this.client.fetchBeaconTaskContent(task.beaconId, task.taskId, task.description);
      } catch {
        return { ...base, errorKind: "decode-uncertain", error: "The beacon task result could not be fetched" };
      }
      try {
        if (content.ID !== task.taskId || content.BeaconID !== task.beaconId ||
          content.Description !== task.description || content.State.trim().toLowerCase() !== "completed") {
          return { ...base, errorKind: "decode-uncertain", error: "The server returned task content for a different resource" };
        }
        try {
          return { ...base, ...decodeHistoricalBeaconTask(task.description, content.Request, content.Response) };
        } catch {
          return { ...base, errorKind: "decode-uncertain", error: "The beacon task result could not be decoded safely" };
        }
      } finally {
        content.Request.fill(0);
        content.Response.fill(0);
      }
    } finally {
      this.detailAdmissions -= 1;
    }
  }

  private async executionDetail(
    task: InternalTask,
    base: BeaconTaskSummary,
    operationId: BeaconTaskExecutionOutput["operationId"],
    attribution: ReturnType<TaskOwnershipResolver>,
  ): Promise<BeaconTaskDetail> {
    const readOperationId = operationId !== "bof.execute" && isExecutionReadOperationId(operationId)
      ? operationId : undefined;
    const skeleton = readOperationId
      ? task.state === "pending" || task.state === "sent"
        ? { ...base, executionRead: submittedExecutionReadResult(readOperationId, task.taskId) }
        : base
      : { ...base, execution: { operationId } };
    const descriptions = operationId === "bof.execute"
      ? ["CallExtensionReq"]
      : EXECUTION_BEACON_TASK_DESCRIPTIONS[operationId as keyof typeof EXECUTION_BEACON_TASK_DESCRIPTIONS];
    if (!descriptions || !(descriptions as readonly string[]).includes(task.description)) {
      return executionDetailError(base, operationId, "decode-uncertain", "The task description did not match the locally submitted operation");
    }
    if (!task.resultAvailable) return skeleton;
    if (this.detailAdmissions >= MAX_CONCURRENT_TASK_DETAILS) {
      throw new Error("Too many beacon task details are already being fetched; wait for one to finish");
    }
    this.detailAdmissions += 1;
    try {
      let content: clientpb.BeaconTask;
      try {
        content = operationId === "bof.execute"
          ? await this.client.fetchBofBeaconTask(task.beaconId, task.taskId, "CallExtensionReq")
          : await this.client.fetchBeaconTaskContent(task.beaconId, task.taskId, task.description);
      }
      catch { return executionDetailError(base, operationId, "decode-uncertain", "The beacon task result could not be fetched"); }
      try {
        if (content.ID !== task.taskId || content.BeaconID !== task.beaconId) {
          return executionDetailError(base, operationId, "decode-uncertain", "The server returned task content for a different resource");
        }
        if (content.State.trim().toLowerCase() !== "completed") {
          return executionDetailError(base, operationId, "decode-uncertain", "The fetched task did not contain a completed result");
        }
        if (content.Description !== task.description) {
          return executionDetailError(base, operationId, "decode-uncertain", "The fetched task description did not match the task inventory");
        }
        try {
          if (operationId === "bof.execute") {
            const response = decodeBofTask(content.Response);
            const encoded = sliverpb.CallExtension.encode(response).finish();
            try {
              if (encoded.length !== content.Response.length || encoded.some((byte, index) => byte !== content.Response[index])) {
                throw new Error("Invalid BOF response encoding");
              }
            } finally { encoded.fill(0); }
            if (response.Response?.Async || response.Response?.BeaconID || response.Response?.TaskID) {
              throw new Error("BOF response is not a completed envelope");
            }
            const captured = decodeBofOutput(response);
            if (response.Response?.Err) {
              return executionDetailError(base, operationId, "target-reported", "The beacon task response reported an error", captured);
            }
            return { ...base, execution: { operationId, ...captured } };
          }
          if (!attribution.executionOperationId && content.Response.length > EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES) {
            const fallback = decodeHistoricalBeaconTask(task.description, content.Request, content.Response);
            if (fallback.disposition) return { ...base, ...fallback };
          }
          const decoded = decodeExecutionBeaconTask({
            operationId, description: task.description, response: content.Response,
            ...(readOperationId ? { readInput: { operationId: readOperationId, taskId: task.taskId } } : {}),
            processWaited: attribution.executionOperationId === "execution.process" && attribution.processWaited === true,
          });
          if (readOperationId) {
            if (decoded.kind !== "read" || decoded.value.operationId !== readOperationId || decoded.value.taskId !== task.taskId) {
              throw new Error("The execution result did not contain the correlated read result");
            }
            return { ...base, executionRead: decoded.value };
          }
          if (decoded.kind !== "action") throw new Error("The execution result did not contain an action result");
          const result = decoded.value;
          return {
            ...base,
            execution: {
              operationId,
              ...(result.pid === undefined ? {} : { pid: result.pid }),
              ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
              ...(result.stdout === undefined ? {} : { stdout: { data: result.stdout, truncated: result.stdoutTruncated ?? false } }),
              ...(result.stderr === undefined ? {} : { stderr: { data: result.stderr, truncated: result.stderrTruncated ?? false } }),
            },
          };
        } catch (error) {
          const targetReported = error instanceof ExecutionRemoteRejectedError;
          return executionDetailError(base, operationId, targetReported ? "target-reported" : "decode-uncertain",
            targetReported ? "The beacon task response reported an error" : "The beacon task result could not be decoded safely");
        }
      } finally {
        // Artifact-bearing requests may exceed the generic preview limit. They
        // are never decoded or exposed, and are destroyed on every path.
        content.Request.fill(0);
        content.Response.fill(0);
      }
    } finally { this.detailAdmissions -= 1; }
  }

  async cancel(
    beaconId: string,
    taskId: string,
    resolveOwnership: TaskOwnershipResolver = () => ({ ownership: UNKNOWN_OWNERSHIP }),
  ): Promise<BeaconTaskSummary> {
    const task = this.requireTask(beaconId, taskId);
    if (task.serverState === "canceled") {
      return projectTask(task, resolveOwnership(task.taskId, task.beaconId));
    }
    if (task.serverState !== "pending") {
      throw new BeaconTaskCancellationError(
        "Only pending beacon tasks can be canceled; the task may already have been dispatched",
        false,
      );
    }
    const cancellation = taskCancellationState(task);
    if (!cancellation.available) {
      throw new BeaconTaskCancellationError(
        cancellation.reason ?? "This beacon task is not safe to cancel",
        false,
      );
    }
    const key = `${task.beaconId}:${task.taskId}`;
    let flight = this.cancelFlights.get(key);
    if (!flight) {
      if (this.cancelFlights.size >= MAX_CONCURRENT_TASK_CANCELLATIONS) {
        throw new BeaconTaskCancellationError(
          "Too many beacon task cancellations are already in flight; wait for one to finish",
          false,
        );
      }
      flight = this.cancelTaskOnce(task).finally(() => {
        if (this.cancelFlights.get(key) === flight) this.cancelFlights.delete(key);
      });
      this.cancelFlights.set(key, flight);
    }
    let canceled: InternalTask;
    try {
      canceled = await flight;
    } catch (error) {
      if (error instanceof BeaconTaskCancellationError) throw error;
      throw new BeaconTaskCancellationError(
        "The task cancellation was dispatched, but its outcome could not be confirmed",
        true,
      );
    }
    return projectTask(canceled, resolveOwnership(canceled.taskId, canceled.beaconId));
  }

  private async cancelTaskOnce(task: InternalTask): Promise<InternalTask> {
    const canceled = await this.client.cancelBeaconTask(task.taskId);
    try {
      if (canceled.ID !== task.taskId || canceled.BeaconID !== task.beaconId) {
        throw new Error("The server canceled a different beacon task");
      }
      if (canceled.State.toLowerCase() !== "canceled") {
        throw new Error("The cancellation outcome is unknown; refresh the task inventory");
      }
      const normalized = normalizeTask(canceled, task.beaconId);
      const catalog = this.catalogs.get(task.beaconId);
      if (catalog?.byId.has(normalized.taskId)) {
        const items = catalog.items.map((candidate) => candidate.taskId === normalized.taskId ? normalized : candidate);
        this.catalogs.set(task.beaconId, {
          ...catalog,
          revision: catalog.revision + 1,
          items,
          byId: new Map(items.map((candidate) => [candidate.taskId, candidate])),
        });
      }
      return normalized;
    } finally {
      zeroizeTaskContent(canceled);
    }
  }

  task(
    beaconId: string,
    taskId: string,
    resolveOwnership: TaskOwnershipResolver = () => ({ ownership: UNKNOWN_OWNERSHIP }),
  ): BeaconTaskSummary {
    const task = this.requireTask(beaconId, taskId);
    return projectTask(task, resolveOwnership(task.taskId, task.beaconId));
  }

  containsTask(beaconId: string, taskId: string): boolean {
    const normalizedBeaconId = requireIdentifier(beaconId, "beacon ID");
    const normalizedTaskId = requireIdentifier(taskId, "task ID");
    return this.catalogs.get(normalizedBeaconId)?.byId.has(normalizedTaskId) === true;
  }

  removeBeacon(beaconId: string): void {
    const normalizedBeaconId = requireIdentifier(beaconId, "beacon ID");
    this.invalidateBeacon(normalizedBeaconId);
  }

  /** Remove task catalogs only when the caller has a complete authoritative
   * beacon ID set. Callers must not use a truncated or failed inventory. */
  pruneAbsentBeacons(authoritativeBeaconIds: Iterable<string>): void {
    const retained = new Set(
      [...authoritativeBeaconIds].map((beaconId) => requireIdentifier(beaconId, "beacon ID")),
    );
    const known = new Set([...this.catalogs.keys(), ...this.refreshes.keys()]);
    for (const beaconId of known) {
      if (!retained.has(beaconId)) this.invalidateBeacon(beaconId);
    }
  }

  private invalidateBeacon(normalizedBeaconId: string): void {
    this.catalogs.delete(normalizedBeaconId);
    for (const [token, snapshot] of this.cursorSnapshots) {
      if (snapshot.beaconId === normalizedBeaconId) this.cursorSnapshots.delete(token);
    }
    const active = this.refreshes.get(normalizedBeaconId);
    if (active) active.invalidated = true;
    this.refreshes.delete(normalizedBeaconId);
  }

  clear(): void {
    this.catalogs.clear();
    this.cursorSnapshots.clear();
    this.storeGeneration += 1;
    this.refreshes.clear();
  }

  private saveCursorSnapshot(snapshot: CursorSnapshot): string {
    this.pruneCursorSnapshots();
    const owned = [...this.cursorSnapshots]
      .filter(([, candidate]) => candidate.ownerKey === snapshot.ownerKey)
      .map(([token]) => token);
    while (owned.length >= MAX_CURSOR_SNAPSHOTS_PER_OWNER) {
      const oldest = owned.shift();
      if (!oldest) break;
      this.cursorSnapshots.delete(oldest);
    }
    if (this.cursorSnapshots.size >= MAX_CURSOR_SNAPSHOTS) {
      throw new Error("Too many task page cursors are active; finish or restart an existing page");
    }
    const token = randomUUID();
    this.cursorSnapshots.set(token, snapshot);
    return token;
  }

  private cursorSnapshot(
    cursor: string,
    beaconId: string,
    scope: TaskCursorScope,
  ): { token: string; offset: number; snapshot: CursorSnapshot } {
    const match = /^task:v2:([a-f0-9-]{36}):(0|[1-9][0-9]{0,8})$/u.exec(cursor);
    if (!match) throw new Error("Invalid task page cursor");
    const token = match[1]!;
    const snapshot = this.cursorSnapshots.get(token);
    if (!snapshot || snapshot.expiresAt <= Date.now()) {
      this.cursorSnapshots.delete(token);
      throw new Error("Task page cursor is stale; refresh the first page");
    }
    if (
      snapshot.beaconId !== beaconId ||
      snapshot.ownerKey !== scope.ownerKey ||
      snapshot.accessKey !== scope.accessKey
    ) {
      throw new Error("Task page cursor is stale; refresh the first page");
    }
    const offset = Number(match[2]);
    if (!Number.isSafeInteger(offset) || offset < 1 || offset >= snapshot.items.length) {
      throw new Error("Invalid task page cursor");
    }
    return { token, offset, snapshot };
  }

  private pruneCursorSnapshots(): void {
    const now = Date.now();
    for (const [token, snapshot] of this.cursorSnapshots) {
      if (snapshot.expiresAt <= now) this.cursorSnapshots.delete(token);
    }
  }

  private async refreshUntilClean(
    beaconId: string,
    state: RefreshState,
    storeGeneration: number,
  ): Promise<void> {
    while (this.isRefreshCurrent(state, storeGeneration)) {
      state.dirty = false;
      let response: clientpb.BeaconTasks;
      try {
        response = await this.client.getBeaconTasks(beaconId);
      } catch (error) {
        if (!this.isRefreshCurrent(state, storeGeneration)) return;
        if (state.dirty) continue;
        throw error;
      }

      try {
        if (!this.isRefreshCurrent(state, storeGeneration)) return;
        // A caller requested fresher data while this request was in flight. Do
        // not expose this now-stale snapshot, even transiently.
        if (state.dirty) continue;

        const byId = new Map<string, InternalTask>();
        for (const task of response.Tasks) {
          const normalized = normalizeTask(task, beaconId);
          if (byId.has(normalized.taskId)) throw new Error(`Duplicate beacon task '${normalized.taskId}'`);
          byId.set(normalized.taskId, normalized);
        }
        const all = [...byId.values()].sort((left, right) => compareTasks(left, right, state.pinnedTaskIds));
        const previous = this.catalogs.get(beaconId);
        const items = all.slice(0, MAX_TASKS);
        const total = all.length;
        const truncated = all.length > items.length;
        this.catalogs.set(beaconId, {
          revision: previous && sameTaskCatalog(previous, items, total, truncated)
            ? previous.revision
            : (previous?.revision ?? 0) + 1,
          total,
          truncated,
          items,
          byId: new Map(items.map((item) => [item.taskId, item])),
          retainedTaskIds: new Set(state.retainedTaskIds),
          lastAccessed: ++this.catalogClock,
        });
        this.pruneCatalogs(beaconId);
        return;
      } finally {
        for (const task of response.Tasks) zeroizeTaskContent(task);
      }
    }
  }

  private isRefreshCurrent(state: RefreshState, storeGeneration: number): boolean {
    return this.storeGeneration === storeGeneration && !state.invalidated;
  }

  private requireCatalog(beaconId: string): TaskCatalog {
    const normalized = requireIdentifier(beaconId, "beacon ID");
    const catalog = this.catalogs.get(normalized);
    if (!catalog) throw new Error("Refresh the selected beacon's task inventory first");
    catalog.lastAccessed = ++this.catalogClock;
    return catalog;
  }

  private pruneCatalogs(currentBeaconId: string): void {
    while (this.catalogs.size > MAX_TASK_CATALOGS) {
      const cursorBeacons = new Set([...this.cursorSnapshots.values()].map(({ beaconId }) => beaconId));
      const candidates = [...this.catalogs.entries()]
        .filter(([beaconId, catalog]) =>
          beaconId !== currentBeaconId &&
          catalog.retainedTaskIds.size === 0 &&
          !this.refreshes.has(beaconId) &&
          !cursorBeacons.has(beaconId) &&
          ![...this.cancelFlights.keys()].some((key) => key.startsWith(`${beaconId}:`))
        )
        .sort(([, left], [, right]) => left.lastAccessed - right.lastAccessed);
      const oldest = candidates[0]?.[0];
      if (!oldest) {
        this.catalogs.delete(currentBeaconId);
        throw new Error("The bounded beacon task catalog is full of inventories required for active reconciliation");
      }
      this.catalogs.delete(oldest);
      for (const [token, snapshot] of this.cursorSnapshots) {
        if (snapshot.beaconId === oldest) this.cursorSnapshots.delete(token);
      }
    }
  }

  private requireTask(beaconId: string, taskId: string): InternalTask {
    const catalog = this.requireCatalog(beaconId);
    const normalizedTaskId = requireIdentifier(taskId, "task ID");
    const task = catalog.byId.get(normalizedTaskId);
    if (!task) throw new Error("Unknown task for the selected beacon");
    return task;
  }
}

function normalizeTask(task: clientpb.BeaconTask, expectedBeaconId: string): InternalTask {
  const taskId = requireIdentifier(task.ID, "task ID");
  const beaconId = requireIdentifier(task.BeaconID, "beacon ID");
  if (beaconId !== expectedBeaconId) throw new Error("The server returned a task for a different beacon");
  const serverState = boundedText(task.State.toLowerCase(), 32);
  return {
    taskId,
    beaconId,
    state: taskState(serverState),
    serverState,
    description: boundedText(task.Description, MAX_DESCRIPTION),
    ...optionalTimestamp("createdAt", task.CreatedAt),
    ...optionalTimestamp("sentAt", task.SentAt),
    ...optionalTimestamp("completedAt", task.CompletedAt),
    resultAvailable: serverState === "completed",
  };
}

function projectTask(
  task: InternalTask,
  attribution: ReturnType<TaskOwnershipResolver>,
): BeaconTaskSummary {
  return {
    taskId: task.taskId,
    beaconId: task.beaconId,
    state: task.state,
    description: task.description,
    ...(task.createdAt ? { createdAt: task.createdAt } : {}),
    ...(task.sentAt ? { sentAt: task.sentAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    resultAvailable: task.resultAvailable,
    cancellation: taskCancellationState(task),
    ...(attribution.localRequestId ? { localRequestId: attribution.localRequestId } : {}),
    ownership: attribution.ownership,
  };
}

function taskCancellationState(task: InternalTask): BeaconTaskSummary["cancellation"] {
  if (task.serverState !== "pending") {
    return {
      available: false,
      reason: "Only pending tasks can be canceled",
    };
  }
  if (CANCELLABLE_TASK_DESCRIPTIONS.has(task.description)) return { available: true };
  if (task.description === "ReconfigureReq") {
    return {
      available: false,
      reason: "Reconfigure tasks cannot be canceled safely because server timing metadata changes when the task is queued",
    };
  }
  return {
    available: false,
    reason: "Cancellation is unavailable because this task type has not been reviewed for enqueue-time side effects",
  };
}

function decodeDisposition(
  operationId: TargetOperationId,
  response: Buffer,
  expectedPingNonce?: number,
) {
  switch (operationId) {
    case "target.ping": {
      const decoded = sliverpb.Ping.decode(response);
      assertResponse(decoded.Response?.Err);
      if (expectedPingNonce !== undefined && decoded.Nonce !== expectedPingNonce) {
        throw new Error("The ping response did not match the submitted request");
      }
      return {
        kind: "structured-detail" as const,
        title: "Ping response",
        fields: [{ label: "Nonce", value: decoded.Nonce }],
        truncated: false,
      };
    }
    case "target.env-set": {
      const decoded = sliverpb.SetEnv.decode(response);
      assertEmbeddedResponse(decoded.Response);
      return {
        kind: "structured-detail" as const,
        title: "Environment updated",
        fields: [{ label: "Result", value: "Variable set" }],
        truncated: false,
      };
    }
    case "target.env-unset": {
      const decoded = sliverpb.UnsetEnv.decode(response);
      assertEmbeddedResponse(decoded.Response);
      return {
        kind: "structured-detail" as const,
        title: "Environment updated",
        fields: [{ label: "Result", value: "Variable removed" }],
        truncated: false,
      };
    }
    case "beacon.reconfigure": {
      const decoded = sliverpb.Reconfigure.decode(response);
      assertResponse(decoded.Response?.Err);
      return {
        kind: "structured-detail" as const,
        title: "Beacon reconfigured",
        fields: [{ label: "Result", value: "Configuration delivered" }],
        truncated: false,
      };
    }
    case "beacon.open-session": {
      const decoded = sliverpb.OpenSession.decode(response);
      assertResponse(decoded.Response?.Err);
      return {
        kind: "inline-text" as const,
        text: "The beacon acknowledged and scheduled the interactive-session request.",
        truncated: false,
      };
    }
    case "beacon.filesystem.pwd": {
      const decoded = sliverpb.Pwd.decode(response);
      // Canonical implant success payloads for these read commands omit the
      // embedded Response entirely; only a present error envelope is a
      // target-reported failure.
      assertResponse(decoded.Response?.Err);
      if (!decoded.Path) throw new Error("The working directory result was empty");
      const path = boundedResultText(decoded.Path, MAX_RESULT_TEXT);
      return {
        kind: "structured-detail" as const,
        title: "Working directory",
        fields: [{ label: "Path", value: path.value }],
        truncated: path.changed,
      };
    }
    case "beacon.filesystem.ls": {
      const decoded = sliverpb.Ls.decode(response);
      assertResponse(decoded.Response?.Err);
      let truncated = decoded.Files.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = MAX_RESULT_TEXT): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const rows = decoded.Files.slice(0, MAX_RESULT_ROWS).map((file) => [
        text(file.Name, 512),
        file.IsDir ? "Directory" : "File",
        text(file.Size, 128),
        text(file.ModTime, 128),
        text(file.Mode, 128),
        text(file.Link),
        text(file.Uid, 128),
        text(file.Gid, 128),
      ]);
      return {
        kind: "table" as const,
        columns: ["Name", "Type", "Size", "Modified", "Mode", "Link", "UID", "GID"],
        rows,
        truncated,
      };
    }
    case "beacon.process.list": {
      const decoded = sliverpb.Ps.decode(response);
      assertResponse(decoded.Response?.Err);
      let truncated = decoded.Processes.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = MAX_RESULT_TEXT): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const rows = decoded.Processes.slice(0, MAX_RESULT_ROWS).map((process) => {
        const commandLineItems = process.CmdLine.slice(0, MAX_RESULT_NESTED_ITEMS);
        if (commandLineItems.length !== process.CmdLine.length) truncated = true;
        return [
          nonNegativeInteger(process.Pid),
          nonNegativeInteger(process.Ppid),
          text(process.Executable),
          text(process.Owner, 512),
          text(process.Architecture, 128),
          nonNegativeInteger(process.SessionID),
          text(commandLineItems.join(" ")),
        ];
      });
      return {
        kind: "table" as const,
        columns: ["PID", "PPID", "Executable", "Owner", "Architecture", "Session", "Command line"],
        rows,
        truncated,
      };
    }
    case "beacon.network.interfaces": {
      const decoded = sliverpb.Ifconfig.decode(response);
      assertResponse(decoded.Response?.Err);
      let truncated = decoded.NetInterfaces.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = MAX_RESULT_TEXT): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const rows = decoded.NetInterfaces.slice(0, MAX_RESULT_ROWS).map((networkInterface) => {
        const addresses = networkInterface.IPAddresses.slice(0, MAX_RESULT_NESTED_ITEMS);
        if (addresses.length !== networkInterface.IPAddresses.length) truncated = true;
        return [
          nonNegativeInteger(networkInterface.Index),
          text(networkInterface.Name, 512),
          text(networkInterface.MAC, 128),
          text(addresses.join(", ")),
        ];
      });
      return {
        kind: "table" as const,
        columns: ["Index", "Name", "MAC", "Addresses"],
        rows,
        truncated,
      };
    }
    case "beacon.environment.list": {
      const decoded = decodeCanonical(sliverpb.EnvInfo, response);
      assertResponse(decoded.Response?.Err);
      if (response.length > 0 && decoded.Variables.length === 0 && !decoded.Response) {
        throw new Error("The environment result contained no recognized fields");
      }
      let truncated = decoded.Variables.length > MAX_RESULT_ROWS;
      const rows = decoded.Variables.slice(0, MAX_RESULT_ROWS).map((variable) => {
        const name = boundedResultText(variable.Key, 512);
        const sensitive = isSensitiveSessionEnvironmentName(variable.Key);
        const value = sensitive ? { value: "[redacted]", changed: false } : boundedResultText(variable.Value, MAX_RESULT_TEXT);
        truncated ||= name.changed || value.changed;
        return [name.value, value.value, sensitive ? "Yes" : "No"];
      });
      return { kind: "table" as const, columns: ["Name", "Value", "Sensitive"], rows, truncated };
    }
    case "beacon.identity.whoami": {
      const decoded = decodeCanonical(sliverpb.CurrentTokenOwner, response);
      assertResponse(decoded.Response?.Err);
      if (!decoded.Output && !decoded.Response) throw new Error("The token owner result was empty");
      const owner = boundedResultText(decoded.Output, MAX_RESULT_TEXT);
      return { kind: "structured-detail" as const, title: "Current token owner",
        fields: [{ label: "Identity", value: owner.value }], truncated: owner.changed };
    }
    case "beacon.network.netstat": {
      const decoded = decodeCanonical(sliverpb.Netstat, response);
      assertResponse(decoded.Response?.Err);
      if (response.length > 0 && decoded.Entries.length === 0 && !decoded.Response) {
        throw new Error("The network result contained no recognized fields");
      }
      let truncated = decoded.Entries.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = MAX_RESULT_TEXT): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const address = (value: { Ip: string; Port: number } | undefined): string =>
        value ? text(`${value.Ip}:${nonNegativeInteger(value.Port)}`, 512) : "";
      const rows = decoded.Entries.slice(0, MAX_RESULT_ROWS).map((entry) => [
        text(entry.Protocol, 64), address(entry.LocalAddr), address(entry.RemoteAddr),
        text(entry.SkState, 128), nonNegativeInteger(entry.UID),
        entry.Process ? nonNegativeInteger(entry.Process.Pid) : "",
        entry.Process ? text(entry.Process.Executable, 512) : "",
      ]);
      return { kind: "table" as const,
        columns: ["Protocol", "Local", "Remote", "State", "UID", "PID", "Process"], rows, truncated };
    }
    case "beacon.filesystem.mount": {
      const decoded = decodeCanonical(sliverpb.Mount, response);
      assertResponse(decoded.Response?.Err);
      if (response.length > 0 && decoded.Info.length === 0 && !decoded.Response) {
        throw new Error("The mount result contained no recognized fields");
      }
      let truncated = decoded.Info.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = 512): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const rows = decoded.Info.slice(0, MAX_RESULT_ROWS).map((item) => [
        text(item.VolumeName), text(item.VolumeType, 128), text(item.MountPoint),
        text(item.FileSystem, 128), text(item.Label), text(item.UsedSpace, 128),
        text(item.FreeSpace, 128), text(item.TotalSpace, 128), text(item.MountOptions),
      ]);
      return { kind: "table" as const,
        columns: ["Volume", "Type", "Mount point", "Filesystem", "Label", "Used", "Free", "Total", "Options"],
        rows, truncated };
    }
    case "beacon.filesystem.memfiles": {
      const decoded = decodeCanonical(sliverpb.Ls, response);
      assertResponse(decoded.Response?.Err);
      if (!decoded.Exists) throw new TargetReportedTaskError("The beacon could not list memory files");
      if (response.length > 0 && decoded.Files.length === 0 && !decoded.Path && !decoded.Response) {
        throw new Error("The memory file result contained no recognized fields");
      }
      let truncated = decoded.Files.length > MAX_RESULT_ROWS;
      const text = (value: string, maximum = 512): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const rows = decoded.Files.slice(0, MAX_RESULT_ROWS).map((file) => [
        text(file.Name), file.IsDir ? "Directory" : "File", text(file.Size, 128),
        text(file.ModTime, 128), text(file.Mode, 128), text(file.Link),
      ]);
      return { kind: "table" as const, columns: ["Name", "Type", "Size", "Modified", "Mode", "Link"], rows, truncated };
    }
    case "beacon.filesystem.cat":
    case "beacon.filesystem.head":
    case "beacon.filesystem.tail":
      return decodeTextFileDisposition(operationId, response);
    case "beacon.filesystem.grep": {
      const decoded = decodeCanonical(sliverpb.Grep, response);
      assertResponse(decoded.Response?.Err);
      if (response.length > 0 && Object.keys(decoded.Results).length === 0 &&
        !decoded.SearchPathAbsolute && !decoded.Response) {
        throw new Error("The search result contained no recognized fields");
      }
      let truncated = Object.values(decoded.Results).reduce(
        (count, file) => count + file.FileResults.length, 0,
      ) > MAX_RESULT_ROWS;
      const rows: (string | boolean)[][] = [];
      for (const path of Object.keys(decoded.Results).sort()) {
        const file = decoded.Results[path];
        if (!file) continue;
        for (const match of file.FileResults) {
          if (rows.length >= MAX_RESULT_ROWS) { truncated = true; break; }
          const values = [path, match.LineNumber, match.Line,
            match.LinesBefore.slice(0, MAX_RESULT_NESTED_ITEMS).join("\n"),
            match.LinesAfter.slice(0, MAX_RESULT_NESTED_ITEMS).join("\n")];
          if (match.LinesBefore.length > MAX_RESULT_NESTED_ITEMS || match.LinesAfter.length > MAX_RESULT_NESTED_ITEMS) truncated = true;
          const bounded = values.map((value) => boundedResultText(value, MAX_RESULT_TEXT));
          truncated ||= bounded.some((value) => value.changed);
          rows.push([...bounded.map((value) => value.value), file.IsBinary]);
        }
        if (rows.length >= MAX_RESULT_ROWS) break;
      }
      return { kind: "table" as const, columns: ["Path", "Line", "Match", "Before", "After", "Binary"], rows, truncated };
    }
    case "beacon.registry.read":
    case "beacon.registry.list-subkeys":
    case "beacon.registry.list-values":
    case "beacon.registry.write":
    case "beacon.registry.create":
    case "beacon.registry.delete":
    case "beacon.service.list":
    case "beacon.service.info":
    case "beacon.service.start":
    case "beacon.service.stop":
      return decodeBc08Disposition(operationId, response);
    case "target.rename":
      return {
        kind: "structured-detail" as const,
        title: "Target renamed",
        fields: [{ label: "Result", value: "Inventory refresh required" }],
        truncated: false,
      };
  }
}

function decodeBc08Disposition(
  operationId: Extract<TargetOperationId, `beacon.registry.${string}` | `beacon.service.${string}`>,
  response: Buffer,
) {
  switch (operationId) {
    case "beacon.registry.read": {
      const decoded = decodeCanonical(sliverpb.RegistryRead, response);
      try {
        assertEmbeddedResponse(decoded.Response);
        // The pinned response carries only Value and Response. The generated
        // client accepts newer Binary/Type fields, but this route has no reviewed
        // binary result disposition.
        if (decoded.Binary.length !== 0 || decoded.Type !== sliverpb.RegistryType.Unknown) {
          throw new Error("The Registry read returned an unreviewed value shape");
        }
        const value = boundedResultText(decoded.Value, MAX_RESULT_TEXT);
        return {
          kind: "structured-detail" as const,
          title: "Registry value",
          fields: [{ label: "Type", value: "Not reported by target" }, { label: "Value", value: value.value }],
          truncated: value.changed,
        };
      } finally {
        decoded.Binary.fill(0);
      }
    }
    case "beacon.registry.list-subkeys": {
      const decoded = decodeCanonical(sliverpb.RegistrySubKeyList, response);
      assertEmbeddedResponse(decoded.Response);
      let truncated = decoded.Subkeys.length > MAX_RESULT_ROWS;
      const rows = decoded.Subkeys.slice(0, MAX_RESULT_ROWS).map((key) => {
        const name = boundedResultText(key, 512);
        truncated ||= name.changed;
        return [name.value];
      });
      return { kind: "table" as const, columns: ["Subkey"], rows, truncated };
    }
    case "beacon.registry.list-values": {
      const decoded = decodeCanonical(sliverpb.RegistryValuesList, response);
      assertEmbeddedResponse(decoded.Response);
      let truncated = decoded.ValueNames.length > MAX_RESULT_ROWS;
      const rows = decoded.ValueNames.slice(0, MAX_RESULT_ROWS).map((value) => {
        const name = boundedResultText(value, 512);
        truncated ||= name.changed;
        return [name.value];
      });
      return { kind: "table" as const, columns: ["Value name"], rows, truncated };
    }
    case "beacon.service.list": {
      const decoded = decodeCanonical(sliverpb.Services, response);
      assertEmbeddedResponse(decoded.Response);
      if (decoded.Error && decoded.Details.length === 0) {
        throw new TargetReportedTaskError("The beacon could not list services");
      }
      let truncated = decoded.Details.length > MAX_RESULT_ROWS;
      const warning = decoded.Error ? "Inventory may be incomplete" : "";
      const rows = decoded.Details.slice(0, MAX_RESULT_ROWS).map((service) => {
        const text = (value: string, maximum = 512): string => {
          const bounded = boundedResultText(value, maximum);
          truncated ||= bounded.changed;
          return bounded.value;
        };
        return [
          text(service.Name), text(service.DisplayName), serviceStateLabel(service.Status),
          serviceStartupLabel(service.StartupType), text(service.BinPath),
          text(service.Account), text(service.Description, MAX_RESULT_TEXT), warning,
        ];
      });
      return {
        kind: "table" as const,
        columns: ["Name", "Display name", "Status", "Startup", "Binary path", "Account", "Description", "Warning"],
        rows,
        truncated,
      };
    }
    case "beacon.service.info": {
      const decoded = decodeCanonical(sliverpb.ServiceDetail, response);
      assertEmbeddedResponse(decoded.Response);
      if (!decoded.Detail) throw new TargetReportedTaskError("The beacon returned no service details");
      let truncated = false;
      const text = (value: string, maximum = MAX_RESULT_TEXT): string => {
        const bounded = boundedResultText(value, maximum);
        truncated ||= bounded.changed;
        return bounded.value;
      };
      const service = decoded.Detail;
      return {
        kind: "structured-detail" as const,
        title: "Service details",
        fields: [
          { label: "Name", value: text(service.Name, 512) },
          { label: "Display name", value: text(service.DisplayName, 512) },
          { label: "Status", value: serviceStateLabel(service.Status) },
          { label: "Startup", value: serviceStartupLabel(service.StartupType) },
          { label: "Binary path", value: text(service.BinPath) },
          { label: "Account", value: text(service.Account, 512) },
          { label: "Description", value: text(service.Description) },
          { label: "Warning", value: decoded.Message ? "Details may be incomplete" : "None" },
        ],
        truncated,
      };
    }
    case "beacon.registry.write":
      return acknowledgedBc08Mutation("Registry write", sliverpb.RegistryWrite, response);
    case "beacon.registry.create":
      return acknowledgedBc08Mutation("Registry create", sliverpb.RegistryCreateKey, response);
    case "beacon.registry.delete":
      return acknowledgedBc08Mutation("Registry delete", sliverpb.RegistryDeleteKey, response);
    case "beacon.service.start":
      if (response.length === 0) return emptyServiceMutationDisposition("Service start");
      return acknowledgedBc08Mutation("Service start", sliverpb.ServiceInfo, response);
    case "beacon.service.stop":
      if (response.length === 0) return emptyServiceMutationDisposition("Service stop");
      return acknowledgedBc08Mutation("Service stop", sliverpb.ServiceInfo, response);
  }
}

function emptyServiceMutationDisposition(title: string) {
  // The pinned Windows handler marshals an empty ServiceInfo on success and
  // sets Response.Err only on failure. A completed, exact task with no bytes
  // therefore reports no handler error, but provides no service state readback.
  return {
    kind: "structured-detail" as const,
    title: `${title} task`,
    fields: [
      { label: "Handler", value: "Returned without an error" },
      { label: "Remote state", value: "Not verified; requery the target" },
    ],
    truncated: false,
  };
}

function acknowledgedBc08Mutation<Value extends { Response?: { Err: string } | undefined }>(
  title: string,
  codec: { decode(bytes: Uint8Array): Value; encode(value: Value): { finish(): Uint8Array } },
  response: Buffer,
) {
  const decoded = decodeCanonical(codec, response);
  assertEmbeddedResponse(decoded.Response);
  return {
    kind: "structured-detail" as const,
    title: `${title} task`,
    fields: [
      { label: "Handler", value: "Acknowledged" },
      { label: "Remote state", value: "Not verified; requery the target" },
    ],
    truncated: false,
  };
}

function serviceStateLabel(status: number): string {
  return ({ 1: "Stopped", 2: "Starting", 3: "Stopping", 4: "Running",
    5: "Continuing", 6: "Pausing", 7: "Paused" } as Record<number, string>)[status] ?? `Unknown (${status})`;
}

function serviceStartupLabel(startup: number): string {
  return ({ 0: "Boot", 1: "System", 2: "Automatic", 3: "Manual", 4: "Disabled" } as Record<number, string>)[startup] ??
    `Unknown (${startup})`;
}

function maximumResponseBytes(operationId: TargetOperationId): number {
  return operationId === "beacon.filesystem.cat" || operationId === "beacon.filesystem.head" ||
    operationId === "beacon.filesystem.tail" ? MAX_FILE_RESPONSE_BYTES : MAX_DECODE_BYTES;
}

function decodeCanonical<Value>(
  codec: { decode(bytes: Uint8Array): Value; encode(value: Value): { finish(): Uint8Array } },
  bytes: Buffer,
): Value {
  const decoded = codec.decode(bytes);
  const canonical = codec.encode(decoded).finish();
  try {
    if (canonical.length !== bytes.length || canonical.some((byte, index) => byte !== bytes[index])) {
      throw new Error("The task response did not match its expected protobuf type");
    }
  } finally {
    canonical.fill(0);
  }
  return decoded;
}

function decodeTextFileDisposition(
  operationId: "beacon.filesystem.cat" | "beacon.filesystem.head" | "beacon.filesystem.tail",
  response: Buffer,
) {
  const decoded = decodeCanonical(sliverpb.Download, response);
  assertResponse(decoded.Response?.Err);
  if (!decoded.Exists || decoded.IsDir) throw new TargetReportedTaskError("The requested file is unavailable");
  let inflated: Buffer | undefined;
  try {
    let bytes: Buffer;
    if (decoded.Encoder === "gzip") {
      inflated = gunzipSync(decoded.Data, { maxOutputLength: MAX_TEXT_FILE_BYTES + 1 });
      bytes = inflated;
    } else throw new Error("Unsupported file response encoding");
    if (bytes.length > MAX_TEXT_FILE_BYTES) throw new Error("The file response exceeded the bounded preview");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      if (operationId === "beacon.filesystem.cat") throw error;
      // Byte-count head/tail can legitimately cut through a UTF-8 code point.
      // Preserve the exact returned bytes as a bounded hex preview rather than
      // reporting a valid target response as an uncertain protobuf decode.
      const maximumHexBytes = Math.floor((MAX_RESULT_TEXT - 28) / 2);
      const hex = bytes.subarray(0, maximumHexBytes).toString("hex");
      return {
        kind: "inline-text" as const,
        text: `Non-UTF-8 byte slice (hex): ${hex}`,
        truncated: bytes.length > maximumHexBytes,
      };
    }
    const bounded = boundedInlineText(text, MAX_RESULT_TEXT);
    return {
      kind: "inline-text" as const,
      text: bounded.value,
      truncated: bounded.changed,
    };
  } finally {
    decoded.Data.fill(0);
    inflated?.fill(0);
  }
}

class TargetReportedTaskError extends Error {}

function assertResponse(error: string | undefined): void {
  if (error) throw new TargetReportedTaskError("The beacon task response reported an error");
}

function assertEmbeddedResponse(response: { Err?: string } | undefined): void {
  if (!response) throw new Error("The beacon task result did not contain its response envelope");
  assertResponse(response.Err);
}

function requiresExactlyEmptyResponse(operationId: TargetOperationId): boolean {
  return operationId === "beacon.reconfigure" || operationId === "beacon.open-session";
}

function allowsEmptyDecodedResponse(operationId: TargetOperationId, expectedRequest?: TargetOperationInput): boolean {
  // An empty full environment listing is valid. For process, interface, and
  // socket listings, the pinned handlers can also emit no response on failure,
  // so an empty payload cannot establish a successful zero-row result.
  if (operationId === "beacon.service.start" || operationId === "beacon.service.stop") {
    return expectedRequest?.operationId === operationId;
  }
  return operationId === "beacon.environment.list" &&
    expectedRequest?.operationId === "beacon.environment.list" && expectedRequest.name === undefined;
}

function detailError(
  base: BeaconTaskSummary,
  operationId: TargetOperationId,
  errorKind: NonNullable<BeaconTaskDetail["errorKind"]>,
  error: string,
): BeaconTaskDetail {
  return {
    ...base,
    operationId,
    errorKind,
    error: boundedText(error, MAX_DESCRIPTION),
  };
}

function executionDetailError(
  base: BeaconTaskSummary,
  operationId: BeaconTaskExecutionOutput["operationId"],
  errorKind: NonNullable<BeaconTaskDetail["errorKind"]>,
  error: string,
  captured: Pick<BeaconTaskExecutionOutput, "stdout" | "stderr"> = {},
): BeaconTaskDetail {
  if (operationId !== "bof.execute" && isExecutionReadOperationId(operationId)) {
    return { ...base, errorKind, error };
  }
  return { ...base, execution: { operationId, ...captured, outputError: error }, errorKind, error };
}

function submittedExecutionReadResult(
  operationId: ExecutionReadOperationId,
  taskId: string,
): ExecutionReadResult {
  return operationId === "execution.children"
    ? { operationId, state: "submitted", taskId, items: [], total: 0, truncated: false }
    : { operationId, state: "submitted", taskId, processName: "", processIntegrity: "", privileges: [], total: 0, truncated: false };
}

function taskState(state: string): BeaconTaskState {
  if (state === "pending" || state === "sent") return state;
  if (state === "completed") return "completed";
  if (state === "canceled") return "canceled";
  if (state === "failed") return "failed";
  return "unknown";
}

function optionalTimestamp<Key extends "createdAt" | "sentAt" | "completedAt">(
  key: Key,
  seconds: string,
): Partial<Record<Key, string>> {
  if (!/^[0-9]{1,16}$/u.test(seconds) || seconds === "0") return {};
  const milliseconds = Number(seconds) * 1000;
  if (!Number.isSafeInteger(milliseconds)) return {};
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) return {};
  return { [key]: date.toISOString() } as Partial<Record<Key, string>>;
}

function compareTasks(left: InternalTask, right: InternalTask, pinnedTaskIds: ReadonlySet<string>): number {
  const pinPriority = Number(!pinnedTaskIds.has(left.taskId)) - Number(!pinnedTaskIds.has(right.taskId));
  const statePriority = activeTaskPriority(left) - activeTaskPriority(right);
  return pinPriority || statePriority
    || (right.createdAt ?? "").localeCompare(left.createdAt ?? "")
    || left.taskId.localeCompare(right.taskId);
}

function sameTaskCatalog(
  previous: TaskCatalog,
  items: readonly InternalTask[],
  total: number,
  truncated: boolean,
): boolean {
  return previous.total === total &&
    previous.truncated === truncated &&
    previous.items.length === items.length &&
    previous.items.every((item, index) => sameInternalTask(item, items[index]));
}

function sameInternalTask(left: InternalTask, right: InternalTask | undefined): boolean {
  if (!right) return false;
  return left.taskId === right.taskId &&
    left.beaconId === right.beaconId &&
    left.state === right.state &&
    left.serverState === right.serverState &&
    left.description === right.description &&
    left.createdAt === right.createdAt &&
    left.sentAt === right.sentAt &&
    left.completedAt === right.completedAt &&
    left.resultAvailable === right.resultAvailable;
}

function activeTaskPriority(task: InternalTask): number {
  return task.state === "pending" || task.state === "sent" ? 0 : 1;
}

function zeroizeTaskContent(task: Pick<clientpb.BeaconTask, "Request" | "Response">): void {
  task.Request.fill(0);
  task.Response.fill(0);
}

function taskCursor(token: string, offset: number): string {
  return `task:v2:${token}:${offset}`;
}

function requireIdentifier(value: string, label: string): string {
  if (!TASK_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function boundedText(value: string, maximum: number): string {
  return [...value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim()].slice(0, maximum).join("");
}

function boundedResultText(value: string, maximum: number): { value: string; changed: boolean } {
  const normalized = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  const bounded = [...normalized].slice(0, maximum).join("");
  return { value: bounded, changed: bounded !== normalized };
}

function boundedInlineText(value: string, maximum: number): { value: string; changed: boolean } {
  const normalized = value.replace(/\r\n?/gu, "\n").replace(/[\p{Cc}\p{Cf}]/gu,
    (character) => character === "\n" || character === "\t" ? character : " ");
  const bounded = [...normalized].slice(0, maximum).join("");
  return { value: bounded, changed: bounded !== normalized };
}

function nonNegativeInteger(value: number): number | null {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
