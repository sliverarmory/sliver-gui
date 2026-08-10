import { createHash, randomUUID } from "node:crypto";

import type {
  BeaconTaskState,
  OperationActorSummary,
  OperationBackendSummary,
  OperationDisposition,
  OperationPageRequest,
  TargetOperationId,
  TargetOperationInput,
  TargetOperationPage,
  TargetOperationRecord,
  TargetOperationState,
} from "../shared/operation-contracts.js";
import { parseTargetOperationInput } from "../shared/operation-contracts.js";
import type { SessionWorkbenchOperationId } from "../shared/session-contracts.js";
import type {
  TargetCapabilityId,
  TargetCapabilityState,
  TargetRef,
  TargetSummary,
} from "../shared/target-contracts.js";
import {
  getOperationDescriptor,
  type CompiledModeBinding,
  type CompiledOperationDescriptor,
} from "./operation-registry.js";
import {
  getSessionOperationDescriptor,
  type SessionOperationDescriptor,
} from "./session-operation-registry.js";
import type { SliverClientAdapter } from "./sliver-client-adapter.js";

const DEFAULT_TERMINAL_RECORD_LIMIT = 200;
const DEFAULT_RECOVERABLE_TASK_RECORD_LIMIT = 100;
const DEFAULT_RECOVERABLE_TASK_TTL_MILLISECONDS = 24 * 60 * 60 * 1_000;
const DEFAULT_ACTIVE_OPERATION_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 100;
const MAX_MESSAGE_CHARACTERS = 512;
const TASK_IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/u;

const TERMINAL_STATES: ReadonlySet<TargetOperationState> = new Set([
  "completed",
  "failed",
  "canceled",
  "partial",
  "outcome-unknown",
  "target-disappeared",
]);

export interface ResolvedOperationTarget {
  ref: TargetRef;
  summary: TargetSummary;
  backend: OperationBackendSummary;
  actor?: OperationActorSummary;
  /** Exact server-reported endpoint retained only in the main process. */
  authoritativeActiveC2?: string;
}

export interface OperationTaskReconciliation {
  taskId: string;
  beaconId: string;
  state: BeaconTaskState | "sent";
  disposition?: OperationDisposition;
  error?: string;
}

export class TaskCancellationDispatchError extends Error {
  constructor(message: string, readonly dispatchStarted: boolean) {
    super(message);
    this.name = "TaskCancellationDispatchError";
  }
}

export interface OperationEngineHost {
  client: Pick<
    SliverClientAdapter,
    | "pingSession"
    | "pingBeacon"
    | "renameSession"
    | "renameBeacon"
    | "setEnvSession"
    | "setEnvBeacon"
    | "unsetEnvSession"
    | "unsetEnvBeacon"
    | "getEnvSession"
    | "reconfigureBeacon"
    | "openSessionFromBeacon"
  >;
  ownerWindowId: number;
  resolveActiveTarget(): ResolvedOperationTarget | null | Promise<ResolvedOperationTarget | null>;
  assertTarget(target: TargetRef): ResolvedOperationTarget | Promise<ResolvedOperationTarget>;
  resolveJournaledTarget(target: TargetRef): ResolvedOperationTarget | Promise<ResolvedOperationTarget>;
  reserveTaskClaim(requestId: string): boolean;
  releaseTaskClaimReservation(requestId: string): void;
  claimTask(
    taskId: string,
    requestId: string,
    operationId: TargetOperationId,
    beaconId: string,
    expectedPingNonce?: number,
  ): boolean;
  settleTaskClaim(taskId: string, requestId: string): void;
  capability(
    target: ResolvedOperationTarget,
    capabilityId: TargetCapabilityId,
  ): TargetCapabilityState | boolean | Promise<TargetCapabilityState | boolean>;
  refreshTargets(): void | Promise<void>;
  cancelTask(target: TargetRef, taskId: string): void | Promise<void>;
  onChanged?(record: Readonly<TargetOperationRecord>): void;
  now?(): Date | number;
  idFactory?(): string;
  terminalRecordLimit?: number;
  recoverableTaskRecordLimit?: number;
  recoverableTaskTtlMilliseconds?: number;
  activeOperationLimit?: number;
}

interface InternalOperation {
  sequence: number;
  record: TargetOperationRecord;
  descriptor: CompiledOperationDescriptor;
  dispatchIssued: boolean;
  cancelWhenTaskKnown: boolean;
  cancellationIssued: boolean;
  cancellationPromise?: Promise<void>;
  pingNonce?: number;
  expectedTargetName?: string;
  environmentReconciliation?: {
    name: string;
    expectedValueHash?: string;
    expectsAbsent: boolean;
    caseInsensitiveNames: boolean;
  };
}

interface ExternalOperation {
  sequence: number;
  record: TargetOperationRecord;
  submitted: boolean;
  descriptor: Readonly<SessionOperationDescriptor>;
}

type EnvironmentReconciliation = NonNullable<InternalOperation["environmentReconciliation"]>;

/**
 * A per-window, main-process operation journal and dispatcher.
 *
 * Renderer input can select only a compiled operation ID. The active target,
 * capability decision, adapter method, retry policy, decoding, ownership, and
 * task correlation all remain authoritative in the main process.
 */
export class OperationEngine {
  private readonly operations = new Map<string, InternalOperation>();
  private readonly externalOperations = new Map<string, ExternalOperation>();
  private readonly taskRequests = new Map<string, string>();
  private readonly terminalRecordLimit: number;
  private readonly recoverableTaskRecordLimit: number;
  private readonly recoverableTaskTtlMilliseconds: number;
  private readonly activeOperationLimit: number;
  private nextSequence = 0;
  private pendingAdmissions = 0;
  private closed = false;

  constructor(private readonly host: OperationEngineHost) {
    if (!Number.isSafeInteger(host.ownerWindowId) || host.ownerWindowId <= 0) {
      throw new TypeError("ownerWindowId must be a positive integer");
    }
    const terminalRecordLimit = host.terminalRecordLimit ?? DEFAULT_TERMINAL_RECORD_LIMIT;
    if (!Number.isSafeInteger(terminalRecordLimit) || terminalRecordLimit < 1) {
      throw new TypeError("terminalRecordLimit must be a positive integer");
    }
    this.terminalRecordLimit = terminalRecordLimit;
    const recoverableTaskRecordLimit = host.recoverableTaskRecordLimit ?? DEFAULT_RECOVERABLE_TASK_RECORD_LIMIT;
    if (!Number.isSafeInteger(recoverableTaskRecordLimit) || recoverableTaskRecordLimit < 1) {
      throw new TypeError("recoverableTaskRecordLimit must be a positive integer");
    }
    this.recoverableTaskRecordLimit = recoverableTaskRecordLimit;
    const recoverableTaskTtlMilliseconds = host.recoverableTaskTtlMilliseconds ??
      DEFAULT_RECOVERABLE_TASK_TTL_MILLISECONDS;
    if (!Number.isSafeInteger(recoverableTaskTtlMilliseconds) || recoverableTaskTtlMilliseconds < 1) {
      throw new TypeError("recoverableTaskTtlMilliseconds must be a positive integer");
    }
    this.recoverableTaskTtlMilliseconds = recoverableTaskTtlMilliseconds;
    const activeOperationLimit = host.activeOperationLimit ?? DEFAULT_ACTIVE_OPERATION_LIMIT;
    if (!Number.isSafeInteger(activeOperationLimit) || activeOperationLimit < 1) {
      throw new TypeError("activeOperationLimit must be a positive integer");
    }
    this.activeOperationLimit = activeOperationLimit;
  }

  /** Creates a journal record after resolving the active target, then dispatches it. */
  async submit(untrustedInput: TargetOperationInput): Promise<TargetOperationRecord> {
    this.assertOpen();
    this.pruneTerminalRecords();
    const input = parseTargetOperationInput(untrustedInput);
    const releaseAdmission = this.reserveActiveOperation();
    let activeTarget: ResolvedOperationTarget;
    let descriptor: CompiledOperationDescriptor;
    let internal: InternalOperation;
    try {
      const resolvedTarget = await this.host.resolveActiveTarget();
      if (!resolvedTarget) {
        throw new Error("Select an available target before starting an operation");
      }
      validateResolvedTarget(resolvedTarget);
      activeTarget = resolvedTarget;
      descriptor = getOperationDescriptor(input.operationId);
      const requestId = this.createRequestId();
      const timestamp = this.timestamp();
      internal = {
        sequence: this.allocateSequence(),
        descriptor,
        dispatchIssued: false,
        cancelWhenTaskKnown: false,
        cancellationIssued: false,
        record: {
          requestId,
          operationId: descriptor.id,
          target: cloneTargetRef(activeTarget.ref),
          targetName: boundedText(activeTarget.summary.name, MAX_MESSAGE_CHARACTERS),
          backend: cloneBackend(activeTarget.backend),
          ownership: {
            origin: "local",
            ownerWindowId: this.host.ownerWindowId,
            actor: activeTarget.actor
              ? cloneActor(activeTarget.actor)
              : { attribution: "unknown" },
          },
          mode: activeTarget.ref.mode,
          cancellation: descriptor.bindings[activeTarget.ref.mode]?.cancellation ?? "not-supported",
          state: "queued",
          attempts: 0,
          progress: progressForState("queued"),
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        ...environmentReconciliation(input, activeTarget.summary.os),
        ...(input.operationId === "target.rename" ? { expectedTargetName: input.name } : {}),
      };
      this.operations.set(requestId, internal);
    } catch (error) {
      releaseAdmission();
      throw error;
    }
    releaseAdmission();
    this.emit(internal);

    try {
      const binding = descriptor.bindings[activeTarget.ref.mode];
      if (!binding || !descriptor.modes.includes(activeTarget.ref.mode)) {
        return this.finish(internal, "failed", "This operation does not support the selected target type");
      }
      if (!(await this.hasCapability(activeTarget, descriptor.capabilityId))) {
        return this.finish(internal, "failed", "This operation is not currently available for the selected target");
      }

      // Give a caller that immediately changes its mind a deterministic local
      // cancellation point before any server request can be issued.
      await Promise.resolve();
      if (internal.record.state === "canceled" || this.closed) {
        return this.publicRecord(internal.record);
      }

      return await this.dispatchWithPolicy(internal, input, binding);
    } catch (error) {
      if (isTerminal(internal.record.state)) {
        return this.publicRecord(internal.record);
      }
      return this.finish(internal, "failed", errorMessage(error));
    }
  }

  /**
   * Starts a main-owned journal record for a closed operation surface that is
   * executed outside the M1 protobuf dispatcher (currently the session
   * workbench). The caller may only transition this record; renderer input
   * never supplies request IDs, targets, actors, or backend identity.
   */
  beginExternal(
    operationId: SessionWorkbenchOperationId,
    target: ResolvedOperationTarget,
  ): TargetOperationRecord {
    this.assertOpen();
    this.pruneTerminalRecords();
    validateResolvedTarget(target);
    if (target.ref.mode !== "session") {
      throw new Error("Session workbench activity must be bound to a session target");
    }
    const releaseAdmission = this.reserveActiveOperation();
    try {
      const descriptor = getSessionOperationDescriptor(operationId);
      const requestId = this.createRequestId();
      const timestamp = this.timestamp();
      const external: ExternalOperation = {
        sequence: this.allocateSequence(),
        submitted: false,
        descriptor,
        record: {
          requestId,
          operationId,
          target: cloneTargetRef(target.ref),
          targetName: boundedText(target.summary.name, MAX_MESSAGE_CHARACTERS),
          backend: cloneBackend(target.backend),
          ownership: {
            origin: "local",
            ownerWindowId: this.host.ownerWindowId,
            actor: target.actor ? cloneActor(target.actor) : { attribution: "unknown" },
          },
          mode: target.ref.mode,
          cancellation: descriptor.cancellation,
          state: "submitting",
          attempts: 0,
          progress: progressForState("submitting"),
          createdAt: timestamp,
          updatedAt: timestamp,
          message: descriptor.startMessage,
        },
      };
      this.externalOperations.set(requestId, external);
      this.emitRecord(external.record);
      return this.publicRecord(external.record);
    } finally {
      releaseAdmission();
    }
  }

  markExternalSubmitted(requestId: string): TargetOperationRecord {
    const external = this.requireExternalOperation(requestId);
    if (isTerminal(external.record.state)) return this.publicRecord(external.record);
    this.assertOpen();
    if (!external.submitted) {
      external.submitted = true;
      external.record.attempts += 1;
      external.record.submittedAt = this.timestamp();
    }
    this.transitionExternal(external, "running", external.descriptor.startMessage);
    return this.publicRecord(external.record);
  }

  finishExternal(
    requestId: string,
    state: Extract<
      TargetOperationState,
      "completed" | "failed" | "canceled" | "partial" | "outcome-unknown" | "target-disappeared"
    >,
  ): TargetOperationRecord {
    const external = this.requireExternalOperation(requestId);
    if (isTerminal(external.record.state)) return this.publicRecord(external.record);
    if (state === "outcome-unknown") {
      if (!external.submitted) {
        throw new Error("An operation cannot have an unknown outcome before submission");
      }
      if (!external.descriptor.outcomeUnknownAfterSubmission) {
        throw new Error("This operation cannot have an unknown remote-state outcome");
      }
    }
    external.record.finishedAt = this.timestamp();
    this.transitionExternal(external, state, externalTerminalMessage(external.descriptor, state));
    this.pruneTerminalRecords();
    return this.publicRecord(external.record);
  }

  /**
   * Resolve target-loss uncertainty after the already-submitted external RPC
   * itself returns a decoded, exact success or target rejection. Callers must
   * separately prove that the backend connection which dispatched the RPC is
   * still current.
   */
  resolveExternalOutcome(
    requestId: string,
    state: Extract<TargetOperationState, "completed" | "failed">,
  ): TargetOperationRecord {
    const external = this.requireExternalOperation(requestId);
    if (this.closed) return this.publicRecord(external.record);
    if (
      !external.submitted ||
      !external.descriptor.outcomeUnknownAfterSubmission ||
      external.record.state !== "outcome-unknown"
    ) {
      throw new Error("Only a submitted external operation with an unknown outcome can be recovered");
    }
    external.record.finishedAt = this.timestamp();
    external.record.state = state;
    external.record.progress = progressForState(state);
    external.record.updatedAt = this.timestamp();
    external.record.message = boundedText(
      externalTerminalMessage(external.descriptor, state),
      MAX_MESSAGE_CHARACTERS,
    );
    this.emitRecord(external.record);
    this.pruneTerminalRecords();
    return this.publicRecord(external.record);
  }

  list(request: OperationPageRequest = {}): TargetOperationPage {
    this.pruneTerminalRecords();
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
      throw new TypeError(`Operation page limit must be between 1 and ${MAX_PAGE_LIMIT}`);
    }
    const records = [
      ...[...this.operations.values()].map(({ record, sequence }) => ({ record, sequence })),
      ...[...this.externalOperations.values()].map(({ record, sequence }) => ({ record, sequence })),
    ].sort((left, right) => right.sequence - left.sequence);
    const offset = operationCursorOffset(request.cursor, records);
    const page = records.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const nextAnchor = page.at(-1)?.record.requestId;
    return deepFreeze({
      items: page.map(({ record }) => cloneRecord(record)),
      page: {
        limit,
        total: records.length,
        truncated: nextOffset < records.length,
        ...(nextOffset < records.length && nextAnchor
          ? { nextCursor: operationCursor(nextAnchor) }
          : {}),
      },
    });
  }

  get(requestId: string): TargetOperationRecord | undefined {
    this.pruneTerminalRecords();
    const internal = this.operations.get(requestId);
    const external = this.externalOperations.get(requestId);
    return internal
      ? this.publicRecord(internal.record)
      : external
        ? this.publicRecord(external.record)
        : undefined;
  }

  findByTask(taskId: string, beaconId: string): TargetOperationRecord | undefined {
    this.pruneTerminalRecords();
    const requestId = this.taskRequests.get(taskId);
    const internal = requestId ? this.operations.get(requestId) : undefined;
    return internal?.record.mode === "beacon" && internal.record.target.id === beaconId
      ? this.publicRecord(internal.record)
      : undefined;
  }

  expectedPingNonceForTask(taskId: string, beaconId: string): number | undefined {
    this.pruneTerminalRecords();
    const requestId = this.taskRequests.get(taskId);
    const internal = requestId ? this.operations.get(requestId) : undefined;
    return internal?.record.mode === "beacon" && internal.record.target.id === beaconId
      ? internal.pingNonce
      : undefined;
  }

  async cancel(requestId: string): Promise<TargetOperationRecord> {
    this.assertOpen();
    const external = this.externalOperations.get(requestId);
    if (external) {
      if (isTerminal(external.record.state)) return this.publicRecord(external.record);
      throw new Error("This operation cannot be canceled");
    }
    const internal = this.requireOperation(requestId);
    if (isTerminal(internal.record.state)) {
      return this.publicRecord(internal.record);
    }

    if (!internal.dispatchIssued) {
      return this.finish(internal, "canceled", "Canceled before submission");
    }

    const binding = internal.descriptor.bindings[internal.record.mode];
    if (!binding || binding.cancellation !== "best-effort-beacon-task") {
      throw new Error("This operation can no longer be canceled");
    }

    internal.cancelWhenTaskKnown = true;
    this.transition(
      internal,
      "cancel-requested",
      "Cancellation requested; the task may already have been dispatched",
    );
    if (internal.record.taskId) {
      await this.requestTaskCancellationOnce(internal);
    }
    return this.publicRecord(internal.record);
  }

  async reconcileTask(reconciliation: OperationTaskReconciliation): Promise<TargetOperationRecord | undefined> {
    const requestId = this.taskRequests.get(reconciliation.taskId);
    if (!requestId) return undefined;
    const internal = this.operations.get(requestId);
    if (!internal || (isTerminal(internal.record.state) && internal.record.state !== "outcome-unknown")) {
      return internal ? this.publicRecord(internal.record) : undefined;
    }
    if (internal.record.mode !== "beacon" || internal.record.target.id !== reconciliation.beaconId) {
      return undefined;
    }
    if (this.closed) return this.publicRecord(internal.record);

    switch (reconciliation.state) {
      case "pending":
      case "sent":
        if (internal.record.state !== "outcome-unknown") {
          this.transition(internal, "running", "The beacon task is awaiting completion");
        }
        break;
      case "completed":
        if (reconciliation.disposition) {
          internal.record.disposition = boundDisposition(
            reconciliation.disposition,
            internal.descriptor.resultBounds.maximumTextCharacters,
            internal.descriptor.resultBounds.maximumTableRows,
            internal.descriptor.resultBounds.maximumStructuredFields,
          );
        }
        {
          const reconciliationError = await this.reconcileAfterSuccess(internal);
          if (this.closed) return this.publicRecord(internal.record);
          if (reconciliationError) {
            this.finish(internal, "partial", reconciliationError);
          } else {
            this.finish(internal, "completed", "The beacon task completed");
          }
        }
        break;
      case "canceled":
        this.finish(internal, "canceled", "The beacon task was canceled");
        break;
      case "failed":
        this.finish(
          internal,
          "failed",
          internal.descriptor.idempotency.class === "idempotent-read"
            ? (reconciliation.error ?? "The beacon task failed")
            : "The beacon task failed",
        );
        break;
      case "unknown":
        break;
    }
    return this.publicRecord(internal.record);
  }

  /** Records uncertainty after transport loss without resubmitting. A task that
   * is later observed completed/canceled/failed may still reconcile exactly. */
  markTaskOutcomeUnknown(
    taskId: string,
    beaconId: string,
    reason = "The connection was interrupted after submission",
  ): TargetOperationRecord | undefined {
    const requestId = this.taskRequests.get(taskId);
    if (!requestId) return undefined;
    const internal = this.operations.get(requestId);
    if (internal?.record.mode !== "beacon" || internal.record.target.id !== beaconId) return undefined;
    if (!internal || isTerminal(internal.record.state)) return internal ? this.publicRecord(internal.record) : undefined;
    internal.record.finishedAt = this.timestamp();
    this.transition(internal, "outcome-unknown", reason);
    this.pruneTerminalRecords();
    return this.publicRecord(internal.record);
  }

  expireOverdueTasks(): number {
    this.assertOpen();
    const now = this.nowMilliseconds();
    let changed = 0;
    for (const internal of this.operations.values()) {
      const deadline = internal.record.deadlineAt ? Date.parse(internal.record.deadlineAt) : Number.NaN;
      if (
        internal.record.taskId &&
        !isTerminal(internal.record.state) &&
        Number.isFinite(deadline) &&
        deadline <= now
      ) {
        this.markTaskOutcomeUnknown(
          internal.record.taskId,
          internal.record.target.id,
          "The beacon task did not reach a terminal state before its reconciliation deadline; awaiting an event or explicit refresh",
        );
        changed += 1;
      }
    }
    return changed;
  }

  markTargetUnavailable(target: TargetRef, reason = "The selected target is no longer available"): number {
    let changed = 0;
    for (const internal of [...this.operations.values()]) {
      if (!isTerminal(internal.record.state) && sameTargetIdentity(internal.record.target, target)) {
        this.finish(internal, "target-disappeared", reason);
        changed += 1;
      }
    }
    for (const external of [...this.externalOperations.values()]) {
      if (!isTerminal(external.record.state) && sameTargetIdentity(external.record.target, target)) {
        const state = external.submitted && external.descriptor.outcomeUnknownAfterSubmission
          ? "outcome-unknown"
          : "target-disappeared";
        external.record.finishedAt = this.timestamp();
        this.transitionExternal(
          external,
          state,
          externalTerminalMessage(external.descriptor, state),
        );
        changed += 1;
      }
    }
    this.pruneTerminalRecords();
    return changed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const internal of this.operations.values()) {
      if (isTerminal(internal.record.state)) continue;
      if (internal.dispatchIssued) {
        this.finish(internal, "outcome-unknown", "The owning window closed before the outcome was confirmed");
      } else {
        this.finish(internal, "canceled", "The owning window closed before submission");
      }
    }
    for (const external of this.externalOperations.values()) {
      if (isTerminal(external.record.state)) continue;
      external.record.finishedAt = this.timestamp();
      this.transitionExternal(
        external,
        external.submitted && external.descriptor.outcomeUnknownAfterSubmission ? "outcome-unknown" : "canceled",
        external.submitted && external.descriptor.outcomeUnknownAfterSubmission
          ? "The owning window closed before the outcome was confirmed"
          : "The owning window closed before the operation completed",
      );
    }
    this.pruneTerminalRecords();
  }

  private async dispatchWithPolicy(
    internal: InternalOperation,
    input: TargetOperationInput,
    binding: CompiledModeBinding,
  ): Promise<TargetOperationRecord> {
    // An asynchronous beacon read still creates a server task. If the RPC
    // response is lost after enqueue, replay could create a duplicate task even
    // though the remote operation itself is read-only. Retry only synchronous
    // reads where no queue insertion is involved.
    const maximumAttempts = 1 + (
      binding.execution === "synchronous-response"
        ? internal.descriptor.idempotency.maxAutomaticRetries
        : 0
    );
    while (internal.record.attempts < maximumAttempts) {
      const target = await this.revalidateForDispatch(internal);
      if (!target) return this.publicRecord(internal.record);
      if (internal.record.state === "canceled" || this.closed) return this.publicRecord(internal.record);

      let taskReservation = false;
      const releaseTaskReservation = (): void => {
        if (!taskReservation) return;
        taskReservation = false;
        this.host.releaseTaskClaimReservation(internal.record.requestId);
      };
      if (binding.execution === "asynchronous-beacon-task") {
        if (!this.host.reserveTaskClaim(internal.record.requestId)) {
          return this.finish(
            internal,
            "failed",
            "The backend has reached its bounded active beacon-task limit; wait for task reconciliation before submitting another operation",
          );
        }
        taskReservation = true;
      }

      internal.record.attempts += 1;
      internal.dispatchIssued = true;
      internal.record.submittedAt ??= this.timestamp();
      this.transition(internal, "submitting");

      try {
        const response = await this.dispatchExplicit(internal, input, target, binding);
        if (isTerminal(internal.record.state)) {
          if (
            this.closed &&
            internal.record.state === "outcome-unknown" &&
            binding.execution === "asynchronous-beacon-task"
          ) {
            const lateTaskId = exactTaskId(response, target.ref.id);
            if (lateTaskId && !this.taskRequests.has(lateTaskId)) {
              internal.record.taskId = lateTaskId;
              internal.record.deadlineAt = this.futureTimestamp(binding.timeout.timeoutSeconds);
              this.taskRequests.set(lateTaskId, internal.record.requestId);
            }
          }
          releaseTaskReservation();
          return this.publicRecord(internal.record);
        }
        assertImplantResponse(response);

        if (binding.execution === "asynchronous-beacon-task") {
          const taskId = exactTaskId(response, target.ref.id);
          if (!taskId) {
            releaseTaskReservation();
            return this.finish(
              internal,
              "outcome-unknown",
              "The request may have been queued, but the server did not return an exact beacon task ID",
            );
          }
          const existingRequestId = this.taskRequests.get(taskId);
          if (existingRequestId && existingRequestId !== internal.record.requestId) {
            releaseTaskReservation();
            return this.finish(
              internal,
              "outcome-unknown",
              "The server returned a duplicate task ID already correlated to another request",
            );
          }
          if (!this.host.claimTask(
            taskId,
            internal.record.requestId,
            internal.descriptor.id,
            internal.record.target.id,
            internal.pingNonce,
          )) {
            releaseTaskReservation();
            return this.finish(
              internal,
              "outcome-unknown",
              "The server returned a task ID already claimed by another window or request",
            );
          }
          taskReservation = false;
          internal.record.taskId = taskId;
          internal.record.deadlineAt = this.futureTimestamp(binding.timeout.timeoutSeconds);
          this.taskRequests.set(taskId, internal.record.requestId);
          if (internal.cancelWhenTaskKnown) {
            this.transition(
              internal,
              "cancel-requested",
              "Cancellation requested; the task may already have been dispatched",
            );
            try {
              await this.requestTaskCancellationOnce(internal);
            } catch {
              // Cancellation is a separate best-effort request. Its failure
              // must never trigger the safe-read retry policy and enqueue a
              // second copy of the original beacon task.
            }
          } else {
            this.transition(internal, "submitted", "The operation was queued as a beacon task");
          }
          await this.refreshAfterSubmission(internal);
          return this.publicRecord(internal.record);
        }

        internal.record.disposition = decodeSynchronousDisposition(
          input,
          response,
          internal.descriptor.resultBounds.maximumTextCharacters,
          internal.pingNonce,
        );
        const reconciliationError = await this.reconcileAfterSuccess(internal);
        if (this.closed) return this.publicRecord(internal.record);
        if (reconciliationError) {
          return this.finish(internal, "partial", reconciliationError);
        }
        this.finish(internal, "completed", successMessage(input.operationId));
        return this.publicRecord(internal.record);
      } catch (error) {
        releaseTaskReservation();
        if (isTerminal(internal.record.state)) {
          return this.publicRecord(internal.record);
        }
        if (error instanceof ImplantResponseError) {
          return this.finish(
            internal,
            "failed",
            internal.descriptor.idempotency.class === "idempotent-read"
              ? error.message
              : "The target rejected the operation",
          );
        }
        if (binding.execution === "asynchronous-beacon-task") {
          return this.finish(
            internal,
            "outcome-unknown",
            "The beacon request may have been queued, but no exact task ID was confirmed",
          );
        }
        if (
          internal.descriptor.idempotency.class === "idempotent-read" &&
          internal.record.attempts < maximumAttempts
        ) {
          internal.dispatchIssued = false;
          this.transition(internal, "queued", "The read failed before a result; retrying once");
          continue;
        }
        if (internal.descriptor.idempotency.class === "idempotent-read") {
          return this.finish(internal, "failed", errorMessage(error));
        }
        const reconciledMutation = binding.execution === "synchronous-response"
          ? await this.reconcileUnconfirmedMutation(internal)
          : false;
        if (this.closed) return this.publicRecord(internal.record);
        if (reconciledMutation) {
          internal.record.disposition = reconciledMutationDisposition(input.operationId);
          return this.finish(
            internal,
            "completed",
            "The requested state was confirmed after the operation response was lost",
          );
        }
        return this.finish(internal, "outcome-unknown", mutationFailureMessage(error));
      }
    }
    return this.finish(internal, "failed", "The operation exhausted its retry policy");
  }

  private async revalidateForDispatch(internal: InternalOperation): Promise<ResolvedOperationTarget | null> {
    let current: ResolvedOperationTarget;
    try {
      current = await this.host.assertTarget(cloneTargetRef(internal.record.target));
      validateResolvedTarget(current);
    } catch (error) {
      this.finish(internal, "target-disappeared", errorMessage(error));
      return null;
    }
    if (!sameTargetIdentity(current.ref, internal.record.target)) {
      this.finish(internal, "target-disappeared", "The selected target changed before dispatch");
      return null;
    }
    if (!(await this.hasCapability(current, internal.descriptor.capabilityId))) {
      this.finish(internal, "failed", "The target capability changed before dispatch");
      return null;
    }
    if (internal.descriptor.id === "beacon.open-session") {
      try {
        requireAuthoritativeActiveC2(current);
      } catch (error) {
        this.finish(internal, "failed", errorMessage(error));
        return null;
      }
    }
    return current;
  }

  private async dispatchExplicit(
    internal: InternalOperation,
    input: TargetOperationInput,
    target: ResolvedOperationTarget,
    binding: CompiledModeBinding,
  ): Promise<unknown> {
    const timeout = binding.timeout.timeoutSeconds;
    const targetRef = target.ref;
    switch (input.operationId) {
      case "target.ping": {
        const nonce = internal.pingNonce ??= nonceForRequest(targetRef.id, this.operations.size);
        return targetRef.mode === "session"
          ? this.host.client.pingSession(targetRef.id, nonce, timeout)
          : this.host.client.pingBeacon(targetRef.id, nonce, timeout);
      }
      case "target.rename":
        return targetRef.mode === "session"
          ? this.host.client.renameSession(targetRef.id, input.name, timeout)
          : this.host.client.renameBeacon(targetRef.id, input.name, timeout);
      case "target.env-set":
        return targetRef.mode === "session"
          ? this.host.client.setEnvSession(targetRef.id, input.name, input.value, timeout)
          : this.host.client.setEnvBeacon(targetRef.id, input.name, input.value, timeout);
      case "target.env-unset":
        return targetRef.mode === "session"
          ? this.host.client.unsetEnvSession(targetRef.id, input.name, timeout)
          : this.host.client.unsetEnvBeacon(targetRef.id, input.name, timeout);
      case "beacon.reconfigure":
        return this.host.client.reconfigureBeacon(
          targetRef.id,
          {
            ...(input.reconnectIntervalSeconds === undefined
              ? {}
              : { reconnectIntervalNanoseconds: secondsToNanoseconds(input.reconnectIntervalSeconds) }),
            ...(input.intervalSeconds === undefined
              ? {}
              : { intervalNanoseconds: secondsToNanoseconds(input.intervalSeconds) }),
            ...(input.jitterSeconds === undefined
              ? {}
              : { jitterNanoseconds: secondsToNanoseconds(input.jitterSeconds) }),
          },
          timeout,
        );
      case "beacon.open-session":
        return this.host.client.openSessionFromBeacon(
          targetRef.id,
          [requireAuthoritativeActiveC2(target)],
          secondsToNanoseconds(input.delaySeconds),
          timeout,
        );
    }
  }

  private async requestTaskCancellation(internal: InternalOperation): Promise<void> {
    const taskId = internal.record.taskId;
    if (!taskId || isTerminal(internal.record.state)) return;
    try {
      await this.host.cancelTask(cloneTargetRef(internal.record.target), taskId);
      if (internal.record.state === "cancel-requested") {
        this.transition(
          internal,
          "cancel-requested",
          "Cancellation requested; refresh will confirm whether the task was already dispatched",
        );
      }
    } catch (error) {
      if (isTerminal(internal.record.state)) return;
      if (internal.record.state === "cancel-requested") {
        this.transition(
          internal,
          "cancel-requested",
          `Cancellation is not yet confirmed: ${errorMessage(error)}`,
        );
      }
      throw error;
    }
  }

  private async requestTaskCancellationOnce(internal: InternalOperation): Promise<void> {
    if (internal.cancellationPromise) return internal.cancellationPromise;
    if (internal.cancellationIssued) return;
    internal.cancellationIssued = true;
    const pending = this.requestTaskCancellation(internal)
      .catch((error: unknown) => {
        if (error instanceof TaskCancellationDispatchError && !error.dispatchStarted) {
          internal.cancellationIssued = false;
        }
        throw error;
      })
      .finally(() => {
        if (internal.cancellationPromise === pending) delete internal.cancellationPromise;
      });
    internal.cancellationPromise = pending;
    return pending;
  }

  private async refreshAfterSubmission(internal: InternalOperation): Promise<void> {
    if (internal.record.mode !== "beacon") return;
    await ignoreRefreshError(this.host.refreshTargets);
  }

  private async reconcileAfterSuccess(internal: InternalOperation): Promise<string | undefined> {
    const binding = internal.descriptor.bindings[internal.record.mode];
    try {
      if (binding?.reconciliation === "target-refresh") {
        await this.host.refreshTargets();
      } else if (binding?.reconciliation === "environment-read") {
        await this.verifySessionEnvironment(internal, binding.timeout.timeoutSeconds);
      }
      return undefined;
    } catch {
      return binding?.reconciliation === "environment-read"
        ? "The server accepted the mutation, but its environment postcondition could not be verified"
        : "The server accepted the mutation, but authoritative target refresh did not complete";
    }
  }

  private async reconcileUnconfirmedMutation(internal: InternalOperation): Promise<boolean> {
    const binding = internal.descriptor.bindings[internal.record.mode];
    if (!binding) return false;
    try {
      if (binding.reconciliation === "environment-read") {
        await this.verifySessionEnvironment(internal, binding.timeout.timeoutSeconds);
        return true;
      }
      if (binding.reconciliation === "target-refresh" && internal.expectedTargetName !== undefined) {
        await this.host.refreshTargets();
        const refreshed = await this.host.resolveJournaledTarget(cloneTargetRef(internal.record.target));
        validateResolvedTarget(refreshed);
        return sameTargetIdentity(refreshed.ref, internal.record.target) &&
          refreshed.summary.name === internal.expectedTargetName;
      }
    } catch {
      return false;
    }
    return false;
  }

  private async verifySessionEnvironment(internal: InternalOperation, timeoutSeconds: number): Promise<void> {
    const expected = internal.environmentReconciliation;
    if (!expected || internal.record.mode !== "session") {
      throw new Error("Environment reconciliation metadata is unavailable");
    }
    const current = await this.host.resolveJournaledTarget(cloneTargetRef(internal.record.target));
    validateResolvedTarget(current);
    if (!sameTargetIdentity(current.ref, internal.record.target)) {
      throw new Error("The environment operation target changed before readback");
    }
    const response = await this.host.client.getEnvSession(
      internal.record.target.id,
      "",
      timeoutSeconds,
    );
    assertImplantResponse(response);
    const matches = response.Variables.filter((variable) =>
      expected.caseInsensitiveNames
        ? foldEnvironmentName(variable.Key) === foldEnvironmentName(expected.name)
        : variable.Key === expected.name
    );
    if (matches.length > 1) {
      throw new Error("Environment readback returned ambiguous variable names");
    }
    const match = matches[0];
    if (expected.expectsAbsent) {
      if (match) throw new Error("Environment variable still exists");
      return;
    }
    if (!match || !expected.expectedValueHash || hashValue(match.Value) !== expected.expectedValueHash) {
      throw new Error("Environment variable value did not match");
    }
  }

  private async hasCapability(
    target: ResolvedOperationTarget,
    capabilityId: TargetCapabilityId,
  ): Promise<boolean> {
    const result = await this.host.capability(cloneResolvedTarget(target), capabilityId);
    return typeof result === "boolean"
      ? result
      : result.id === capabilityId && result.available;
  }

  private finish(
    internal: InternalOperation,
    state: Extract<
      TargetOperationState,
      "completed" | "failed" | "canceled" | "partial" | "outcome-unknown" | "target-disappeared"
    >,
    message: string,
  ): TargetOperationRecord {
    if (this.closed && internal.record.state === "outcome-unknown" && state !== "outcome-unknown") {
      return this.publicRecord(internal.record);
    }
    if (isTerminal(internal.record.state) && internal.record.state !== "outcome-unknown") {
      return this.publicRecord(internal.record);
    }
    if (
      internal.record.state === "outcome-unknown" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "canceled" &&
      state !== "partial"
    ) {
      return this.publicRecord(internal.record);
    }
    internal.record.finishedAt = this.timestamp();
    this.transition(internal, state, message);
    if (internal.record.taskId && state !== "outcome-unknown") {
      this.host.settleTaskClaim(internal.record.taskId, internal.record.requestId);
    }
    this.pruneTerminalRecords();
    return this.publicRecord(internal.record);
  }

  private transition(
    internal: InternalOperation,
    state: TargetOperationState,
    message?: string,
  ): void {
    if (isTerminal(internal.record.state) && internal.record.state !== "outcome-unknown") return;
    if (
      internal.record.state === "outcome-unknown" &&
      state !== "completed" &&
      state !== "failed" &&
      state !== "canceled" &&
      state !== "partial"
    ) return;
    internal.record.state = state;
    internal.record.progress = progressForState(state);
    internal.record.updatedAt = this.timestamp();
    if (message === undefined) {
      delete internal.record.message;
    } else {
      internal.record.message = boundedText(message, MAX_MESSAGE_CHARACTERS);
    }
    this.emit(internal);
  }

  private emit(internal: InternalOperation): void {
    this.emitRecord(internal.record);
  }

  private emitRecord(record: TargetOperationRecord): void {
    if (!this.host.onChanged) return;
    try {
      this.host.onChanged(this.publicRecord(record));
    } catch {
      // A renderer notification failure must not change a server operation.
    }
  }

  private pruneTerminalRecords(): void {
    const now = this.nowMilliseconds();
    const recoverableTaskRequestIds = [...this.operations]
      .filter(([, operation]) => operation.record.state === "outcome-unknown" && operation.record.taskId)
      .map(([requestId]) => requestId);
    const expiredRecoverableRequestIds = recoverableTaskRequestIds.filter((requestId) => {
      const operation = this.operations.get(requestId);
      const retainedFrom = operation?.record.finishedAt ?? operation?.record.updatedAt;
      const retainedFromMilliseconds = retainedFrom ? Date.parse(retainedFrom) : Number.NaN;
      return Number.isFinite(retainedFromMilliseconds) &&
        retainedFromMilliseconds + this.recoverableTaskTtlMilliseconds <= now;
    });
    for (const requestId of expiredRecoverableRequestIds) this.deleteOperation(requestId);

    const retainedRecoverableRequestIds = recoverableTaskRequestIds.filter((requestId) =>
      !expiredRecoverableRequestIds.includes(requestId)
    );
    const recoverableRemoveCount = retainedRecoverableRequestIds.length - this.recoverableTaskRecordLimit;
    for (const requestId of retainedRecoverableRequestIds.slice(0, Math.max(0, recoverableRemoveCount))) {
      this.deleteOperation(requestId);
    }

    const terminalRecords = [
      ...[...this.operations]
        .filter(([, operation]) =>
          isTerminal(operation.record.state) &&
          !(operation.record.state === "outcome-unknown" && operation.record.taskId)
        )
        .map(([requestId, operation]) => ({
          kind: "managed" as const,
          requestId,
          updatedAt: operation.record.updatedAt,
          sequence: operation.sequence,
        })),
      ...[...this.externalOperations]
        .filter(([, operation]) => isTerminal(operation.record.state))
        .map(([requestId, operation]) => ({
          kind: "external" as const,
          requestId,
          updatedAt: operation.record.updatedAt,
          sequence: operation.sequence,
        })),
    ].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.sequence - right.sequence);
    const removeCount = terminalRecords.length - this.terminalRecordLimit;
    for (const entry of terminalRecords.slice(0, Math.max(0, removeCount))) {
      if (entry.kind === "external") this.externalOperations.delete(entry.requestId);
      else this.deleteOperation(entry.requestId);
    }
  }

  private deleteOperation(requestId: string): void {
    const operation = this.operations.get(requestId);
    if (operation?.record.taskId) {
      this.host.settleTaskClaim(operation.record.taskId, operation.record.requestId);
      this.taskRequests.delete(operation.record.taskId);
    }
    this.operations.delete(requestId);
  }

  private requireOperation(requestId: string): InternalOperation {
    const internal = this.operations.get(requestId);
    if (!internal) throw new Error("Unknown operation request ID for this window");
    return internal;
  }

  private requireExternalOperation(requestId: string): ExternalOperation {
    const external = this.externalOperations.get(requestId);
    if (!external) throw new Error("Unknown external operation request ID for this window");
    return external;
  }

  private transitionExternal(
    external: ExternalOperation,
    state: TargetOperationState,
    message?: string,
  ): void {
    if (isTerminal(external.record.state)) return;
    external.record.state = state;
    external.record.progress = progressForState(state);
    external.record.updatedAt = this.timestamp();
    if (message === undefined) delete external.record.message;
    else external.record.message = boundedText(message, MAX_MESSAGE_CHARACTERS);
    this.emitRecord(external.record);
  }

  private reserveActiveOperation(): () => void {
    const activeCount =
      [...this.operations.values()].filter(({ record }) => !isTerminal(record.state)).length +
      [...this.externalOperations.values()].filter(({ record }) => !isTerminal(record.state)).length;
    if (activeCount + this.pendingAdmissions >= this.activeOperationLimit) {
      throw new Error(
        `This window already has ${this.activeOperationLimit} active operations; wait for one to finish before submitting another`,
      );
    }
    this.pendingAdmissions += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.pendingAdmissions -= 1;
    };
  }

  private createRequestId(): string {
    const requestId = (this.host.idFactory ?? randomUUID)();
    if (!TASK_IDENTIFIER.test(requestId)) {
      throw new Error("The operation request ID generator returned an invalid identifier");
    }
    if (this.operations.has(requestId) || this.externalOperations.has(requestId)) {
      throw new Error("Duplicate operation request ID");
    }
    return requestId;
  }

  private allocateSequence(): number {
    this.nextSequence += 1;
    if (!Number.isSafeInteger(this.nextSequence)) {
      throw new Error("The operation sequence is exhausted");
    }
    return this.nextSequence;
  }

  private timestamp(): string {
    return new Date(this.nowMilliseconds()).toISOString();
  }

  private futureTimestamp(seconds: number): string {
    return new Date(this.nowMilliseconds() + seconds * 1_000).toISOString();
  }

  private nowMilliseconds(): number {
    const rawValue = (this.host.now ?? Date.now)();
    const value = rawValue instanceof Date ? rawValue.getTime() : rawValue;
    if (!Number.isFinite(value)) throw new Error("The operation clock returned an invalid date");
    return value;
  }

  private publicRecord(record: TargetOperationRecord): TargetOperationRecord {
    return deepFreeze(cloneRecord(record));
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The operation engine is closed");
  }
}

class ImplantResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImplantResponseError";
  }
}

function assertImplantResponse(value: unknown): void {
  if (!isRecord(value)) return;
  const response = value["Response"];
  if (!isRecord(response)) return;
  const error = response["Err"];
  if (typeof error === "string" && error.trim().length > 0) {
    throw new ImplantResponseError(boundedText(error, MAX_MESSAGE_CHARACTERS));
  }
}

function exactTaskId(value: unknown, expectedBeaconId: string): string | undefined {
  if (!isRecord(value) || !isRecord(value["Response"])) return undefined;
  const response = value["Response"];
  if (response["Async"] !== true || response["BeaconID"] !== expectedBeaconId) return undefined;
  const taskId = response["TaskID"];
  return typeof taskId === "string" && TASK_IDENTIFIER.test(taskId) ? taskId : undefined;
}

function decodeSynchronousDisposition(
  input: TargetOperationInput,
  response: unknown,
  maximumTextCharacters: number,
  expectedPingNonce?: number,
): OperationDisposition {
  switch (input.operationId) {
    case "target.ping": {
      const nonce = isRecord(response) && typeof response["Nonce"] === "number"
        ? response["Nonce"]
        : null;
      if (expectedPingNonce === undefined || nonce !== expectedPingNonce) {
        throw new Error("The target returned an unexpected ping nonce");
      }
      return {
        kind: "structured-detail",
        title: "Ping response",
        fields: [{ label: "Nonce", value: nonce }],
        truncated: false,
      };
    }
    case "target.rename":
      return structuredResult("Target renamed", "The target name was updated");
    case "target.env-set":
      return structuredResult("Environment updated", "Variable set");
    case "target.env-unset":
      return structuredResult("Environment updated", "Variable removed");
    case "beacon.reconfigure":
      return structuredResult("Beacon reconfigured", "Configuration submitted");
    case "beacon.open-session":
      return {
        kind: "inline-text",
        text: boundedText("Session conversion submitted", maximumTextCharacters),
        truncated: false,
      };
  }
}

function structuredResult(title: string, result: string): OperationDisposition {
  return {
    kind: "structured-detail",
    title,
    fields: [{ label: "Result", value: result }],
    truncated: false,
  };
}

function reconciledMutationDisposition(operationId: TargetOperationInput["operationId"]): OperationDisposition {
  switch (operationId) {
    case "target.rename":
      return structuredResult("Target renamed", "The target name was verified by authoritative refresh");
    case "target.env-set":
      return structuredResult("Environment updated", "The variable value was verified by readback");
    case "target.env-unset":
      return structuredResult("Environment updated", "Variable absence was verified by readback");
    case "target.ping":
    case "beacon.reconfigure":
    case "beacon.open-session":
      return structuredResult("Operation reconciled", "The requested state was verified");
  }
}

function boundDisposition(
  disposition: OperationDisposition,
  maximumTextCharacters: number,
  maximumTableRows: number,
  maximumStructuredFields: number,
): OperationDisposition {
  switch (disposition.kind) {
    case "inline-text": {
      const text = boundedText(disposition.text, maximumTextCharacters);
      return { ...disposition, text, truncated: disposition.truncated || text !== disposition.text };
    }
    case "table": {
      const rows = disposition.rows.slice(0, maximumTableRows).map((row) => [...row]);
      return {
        ...disposition,
        columns: disposition.columns.map((column) => boundedText(column, 128)),
        rows,
        truncated: disposition.truncated || rows.length !== disposition.rows.length,
      };
    }
    case "structured-detail": {
      const fields = disposition.fields.slice(0, maximumStructuredFields).map((field) => ({
        label: boundedText(field.label, 128),
        value: typeof field.value === "string"
          ? boundedText(field.value, maximumTextCharacters)
          : field.value,
      }));
      return {
        ...disposition,
        title: boundedText(disposition.title, 256),
        fields,
        truncated: disposition.truncated || fields.length !== disposition.fields.length,
      };
    }
    case "native-save":
    case "loot-save":
    case "binary-preview":
    case "stream-attachment":
      return { ...disposition };
  }
}

function successMessage(operationId: TargetOperationInput["operationId"]): string {
  switch (operationId) {
    case "target.ping":
      return "The target responded";
    case "target.rename":
      return "The target was renamed";
    case "target.env-set":
      return "The environment variable was set";
    case "target.env-unset":
      return "The environment variable was removed";
    case "beacon.reconfigure":
      return "The beacon configuration was submitted";
    case "beacon.open-session":
      return "The session conversion was submitted";
  }
}

function externalTerminalMessage(
  descriptor: Readonly<SessionOperationDescriptor>,
  state: Extract<
    TargetOperationState,
    "completed" | "failed" | "canceled" | "partial" | "outcome-unknown" | "target-disappeared"
  >,
): string {
  switch (state) {
    case "completed":
      return descriptor.completionMessage;
    case "failed":
      return "The session operation failed";
    case "canceled":
      return "The session operation was canceled";
    case "partial":
      return "The session operation completed with incomplete confirmation";
    case "outcome-unknown":
      return "The session operation was dispatched, but its outcome could not be confirmed";
    case "target-disappeared":
      return "The session target became unavailable before the operation completed";
  }
}

function progressForState(state: TargetOperationState): NonNullable<TargetOperationRecord["progress"]> {
  switch (state) {
    case "queued":
      return { completedUnits: 0, totalUnits: 3, message: "Waiting for authoritative dispatch" };
    case "submitting":
      return { completedUnits: 1, totalUnits: 3, message: "Submitting to the selected target" };
    case "submitted":
      return { completedUnits: 2, totalUnits: 3, message: "Waiting for beacon task delivery" };
    case "running":
      return { completedUnits: 2, totalUnits: 3, message: "Waiting for authoritative task completion" };
    case "cancel-requested":
      return { completedUnits: 2, totalUnits: 3, message: "Waiting for authoritative cancellation state" };
    case "completed":
    case "failed":
    case "canceled":
    case "partial":
    case "outcome-unknown":
    case "target-disappeared":
      return { completedUnits: 3, totalUnits: 3, message: operationStateProgressMessage(state) };
  }
}

function operationStateProgressMessage(state: TargetOperationState): string {
  switch (state) {
    case "completed": return "Operation completed";
    case "failed": return "Operation failed";
    case "canceled": return "Operation canceled";
    case "partial": return "Operation completed partially";
    case "outcome-unknown": return "Operation outcome remains unknown";
    case "target-disappeared": return "Target became unavailable";
    case "queued":
    case "submitting":
    case "submitted":
    case "running":
    case "cancel-requested":
      return "Operation in progress";
  }
}

function environmentReconciliation(
  input: TargetOperationInput,
  targetOperatingSystem: string,
): { environmentReconciliation: EnvironmentReconciliation } | Record<string, never> {
  const caseInsensitiveNames = targetOperatingSystem.trim().toLowerCase() === "windows";
  if (input.operationId === "target.env-set") {
    return {
      environmentReconciliation: {
        name: input.name,
        expectedValueHash: hashValue(input.value),
        expectsAbsent: false,
        caseInsensitiveNames,
      },
    };
  }
  if (input.operationId === "target.env-unset") {
    return {
      environmentReconciliation: {
        name: input.name,
        expectsAbsent: true,
        caseInsensitiveNames,
      },
    };
  }
  return {};
}

function foldEnvironmentName(value: string): string {
  return value.toLocaleUpperCase("en-US");
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutationFailureMessage(error: unknown): string {
  void error;
  return "The request was dispatched, but its outcome is unknown";
}

function errorMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : "The operation failed", MAX_MESSAGE_CHARACTERS);
}

function boundedText(value: string, maximumCharacters: number): string {
  return [...value]
    .slice(0, maximumCharacters)
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function secondsToNanoseconds(seconds: number): string {
  return (BigInt(seconds) * 1_000_000_000n).toString();
}

function nonceForRequest(targetId: string, operationCount: number): number {
  let hash = operationCount >>> 0;
  for (const codePoint of targetId) {
    hash = Math.imul(hash ^ codePoint.codePointAt(0)!, 0x45d9f3b) >>> 0;
  }
  // Ping.Nonce is a protobuf int32. Keep the deterministic nonce in the
  // non-negative signed range so every generated value can be encoded by the
  // vendored protobuf runtime.
  return hash & 0x7fff_ffff;
}

function operationCursorOffset(
  cursor: string | undefined,
  records: readonly { record: Pick<TargetOperationRecord, "requestId"> }[],
): number {
  if (cursor === undefined) return 0;
  const match = /^operation:v1:([A-Za-z0-9_-]{1,128})$/u.exec(cursor);
  if (!match) throw new TypeError("Invalid operation page cursor");
  const anchorIndex = records.findIndex(({ record }) => record.requestId === match[1]);
  if (anchorIndex < 0) {
    throw new Error("Operation page cursor is stale; refresh the first page");
  }
  return anchorIndex + 1;
}

function operationCursor(requestId: string): string {
  return `operation:v1:${requestId}`;
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode
    && left.id === right.id
    && left.backendEpoch === right.backendEpoch
    && left.fingerprint === right.fingerprint;
}

function validateResolvedTarget(target: ResolvedOperationTarget): void {
  if (target.ref.mode !== target.summary.mode || target.ref.id !== target.summary.id) {
    throw new Error("The resolved target summary does not match its authoritative reference");
  }
  if (target.ref.backendEpoch !== target.backend.epoch) {
    throw new Error("The resolved target belongs to a different backend epoch");
  }
}

function cloneTargetRef(target: TargetRef): TargetRef {
  return { ...target };
}

function cloneActor(actor: OperationActorSummary): OperationActorSummary {
  return actor.attribution === "verified"
    ? { attribution: "verified", name: boundedText(actor.name, 128) }
    : { attribution: "unknown" };
}

function cloneBackend(backend: OperationBackendSummary): OperationBackendSummary {
  return { ...backend };
}

function cloneResolvedTarget(target: ResolvedOperationTarget): ResolvedOperationTarget {
  return {
    ref: cloneTargetRef(target.ref),
    summary: { ...target.summary },
    backend: cloneBackend(target.backend),
    ...(target.actor ? { actor: cloneActor(target.actor) } : {}),
    ...(target.authoritativeActiveC2 ? { authoritativeActiveC2: target.authoritativeActiveC2 } : {}),
  };
}

export function isAuthoritativeActiveC2Usable(
  target: Pick<ResolvedOperationTarget, "summary" | "authoritativeActiveC2">,
): boolean {
  try {
    requireAuthoritativeActiveC2(target);
    return true;
  } catch {
    return false;
  }
}

function requireAuthoritativeActiveC2(
  target: Pick<ResolvedOperationTarget, "summary" | "authoritativeActiveC2">,
): string {
  const candidate = target.authoritativeActiveC2;
  if (!candidate || [...candidate].length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(candidate)) {
    throw new Error("The selected beacon has no safe authoritative C2 endpoint for session conversion");
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("The selected beacon's authoritative C2 endpoint is malformed");
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const supported = new Set(["mtls", "http", "https", "dns", "wg", "namedpipe", "tcppivot"]);
  if (!supported.has(scheme) || !parsed.hostname) {
    throw new Error("The selected beacon's authoritative C2 endpoint is not supported for session conversion");
  }
  if (target.summary.transport !== scheme) {
    throw new Error("The selected beacon's authoritative C2 endpoint does not match its reported transport");
  }
  return candidate;
}

function cloneRecord(record: TargetOperationRecord): TargetOperationRecord {
  return structuredClone(record);
}

function isTerminal(state: TargetOperationState): boolean {
  return TERMINAL_STATES.has(state);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function ignoreRefreshError(refresh: () => void | Promise<void>): Promise<void> {
  try {
    await refresh();
  } catch {
    // Inventory refresh is reconciliation, not proof the operation failed.
  }
}
