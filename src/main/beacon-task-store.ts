import { randomUUID } from "node:crypto";

import { sliverpb, type clientpb } from "sliver-script";

import type {
  BeaconTaskDetail,
  BeaconTaskPage,
  BeaconTaskState,
  BeaconTaskSummary,
  OperationOwnership,
  TargetOperationId,
} from "../shared/operation-contracts.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const MAX_TASKS = 500;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_DESCRIPTION = 256;
const MAX_DECODE_BYTES = 64 * 1024;
const MAX_CURSOR_SNAPSHOTS = 32;
const MAX_CURSOR_SNAPSHOTS_PER_OWNER = 4;
const CURSOR_SNAPSHOT_TTL_MS = 60_000;
const MAX_CONCURRENT_TASK_DETAILS = 8;
const MAX_CONCURRENT_TASK_CANCELLATIONS = 8;
const MAX_CONCURRENT_TASK_REFRESHES = 16;
const MAX_TASK_CATALOGS = 512;
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
  expectedPingNonce?: number | undefined;
};

const EXPECTED_DESCRIPTION_BY_OPERATION: Readonly<Partial<Record<TargetOperationId, string>>> = Object.freeze({
  "target.ping": "Ping",
  "target.env-set": "SetEnvReq",
  "target.env-unset": "UnsetEnvReq",
  "beacon.reconfigure": "ReconfigureReq",
  "beacon.open-session": "OpenSession",
});

const EXTERNAL_OPERATION_BY_DESCRIPTION = new Map<string, TargetOperationId>(
  Object.entries(EXPECTED_DESCRIPTION_BY_OPERATION).map(([operationId, description]) => [
    description,
    operationId as TargetOperationId,
  ]),
);

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

/** Shared, metadata-only task inventory. Raw protobuf payloads are fetched and
 * decoded only for an explicitly selected task, then zeroized immediately. */
export class BeaconTaskStore {
  private readonly catalogs = new Map<string, TaskCatalog>();
  private readonly refreshes = new Map<string, RefreshState>();
  private readonly cursorSnapshots = new Map<string, CursorSnapshot>();
  private readonly cancelFlights = new Map<string, Promise<InternalTask>>();
  private detailAdmissions = 0;
  private refreshAdmissions = 0;
  private storeGeneration = 0;
  private catalogClock = 0;

  constructor(private readonly client: Pick<SliverClientAdapter, "getBeaconTasks" | "fetchBeaconTask" | "cancelBeaconTask">) {}

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
    if (!task.resultAvailable) return base;

    const operationId = attribution.operationId ?? EXTERNAL_OPERATION_BY_DESCRIPTION.get(task.description);
    if (!operationId) return base;
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
      content = await this.client.fetchBeaconTask(task.taskId);
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
      if (content.Response.length > MAX_DECODE_BYTES || content.Request.length > MAX_DECODE_BYTES) {
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
      if (content.Response.length === 0 && !requiresExactlyEmptyResponse(operationId)) {
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
        text: "The beacon acknowledged and scheduled the interactive-session request. This does not prove a session connected; a session is shown only after authoritative inventory refresh.",
        truncated: false,
      };
    }
    case "target.rename":
      return {
        kind: "structured-detail" as const,
        title: "Target renamed",
        fields: [{ label: "Result", value: "Inventory refresh required" }],
        truncated: false,
      };
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
