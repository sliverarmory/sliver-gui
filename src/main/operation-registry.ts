import type {
  OperationDispositionKind,
  TargetMode,
  TargetOperationId,
} from "../shared/operation-contracts.js";
import { isTargetOperationId } from "../shared/operation-contracts.js";
import type { TargetCapabilityId } from "../shared/target-contracts.js";

export type OperationAdapterMethodId =
  | "pingSession"
  | "pingBeacon"
  | "renameSession"
  | "renameBeacon"
  | "setEnvSession"
  | "setEnvBeacon"
  | "unsetEnvSession"
  | "unsetEnvBeacon"
  | "reconfigureBeacon"
  | "openSessionFromBeacon";

export type OperationRequestEncoderId =
  | "ping"
  | "rename-target"
  | "set-environment"
  | "unset-environment"
  | "reconfigure-beacon"
  | "open-beacon-session";

export type OperationResponseDecoderId =
  | "ping"
  | "rename-target"
  | "environment-mutation"
  | "reconfigure-beacon"
  | "open-beacon-session";

export type OperationExecutionMode = "synchronous-response" | "asynchronous-beacon-task";

export type OperationCancellationPolicy = "not-supported" | "best-effort-beacon-task";

export type OperationReconciliationPolicy =
  | "none"
  | "beacon-task-state"
  | "target-refresh"
  | "environment-read"
  | "task-delivery-only";

export type OperationConfirmationPolicy = "none" | "target-action-plan";

export type OperationIdempotencyPolicy =
  | {
      readonly class: "idempotent-read";
      readonly maxAutomaticRetries: 0 | 1;
    }
  | {
      readonly class: "server-idempotency-key";
      readonly maxAutomaticRetries: 0 | 1;
    }
  | {
      readonly class: "unconfirmed-mutation";
      readonly maxAutomaticRetries: 0;
    };

export interface OperationTimeoutPolicy {
  readonly timeoutSeconds: number;
  readonly afterSubmission: "outcome-unknown";
}

export interface OperationResultBounds {
  readonly maximumDecodedBytes: number;
  readonly maximumTextCharacters: number;
  readonly maximumTableRows: number;
  readonly maximumStructuredFields: number;
}

export interface CompiledModeBinding {
  readonly adapterMethod: OperationAdapterMethodId;
  readonly requestEncoder: OperationRequestEncoderId;
  readonly responseDecoder: OperationResponseDecoderId;
  readonly execution: OperationExecutionMode;
  readonly timeout: OperationTimeoutPolicy;
  readonly cancellation: OperationCancellationPolicy;
  readonly reconciliation: OperationReconciliationPolicy;
}

export interface CompiledOperationDescriptor {
  readonly id: TargetOperationId;
  readonly modes: readonly TargetMode[];
  readonly capabilityId: TargetCapabilityId;
  readonly idempotency: OperationIdempotencyPolicy;
  readonly confirmation: OperationConfirmationPolicy;
  readonly disposition: OperationDispositionKind;
  readonly resultBounds: OperationResultBounds;
  readonly bindings: Readonly<Partial<Record<TargetMode, CompiledModeBinding>>>;
}

type CompleteOperationRegistry = Readonly<{
  [OperationId in TargetOperationId]: CompiledOperationDescriptor & { readonly id: OperationId };
}>;

const THIRTY_SECOND_TIMEOUT = Object.freeze({
  timeoutSeconds: 30,
  afterSubmission: "outcome-unknown",
} as const satisfies OperationTimeoutPolicy);

const SIXTY_SECOND_TIMEOUT = Object.freeze({
  timeoutSeconds: 60,
  afterSubmission: "outcome-unknown",
} as const satisfies OperationTimeoutPolicy);

const SMALL_RESULT_BOUNDS = Object.freeze({
  maximumDecodedBytes: 64 * 1_024,
  maximumTextCharacters: 16_384,
  maximumTableRows: 256,
  maximumStructuredFields: 64,
} as const satisfies OperationResultBounds);

const MUTATION_IDEMPOTENCY = Object.freeze({
  class: "unconfirmed-mutation",
  maxAutomaticRetries: 0,
} as const satisfies OperationIdempotencyPolicy);

const registry = {
  "target.ping": {
    id: "target.ping",
    modes: ["session", "beacon"],
    capabilityId: "target.ping",
    idempotency: {
      class: "idempotent-read",
      maxAutomaticRetries: 1,
    },
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      session: {
        adapterMethod: "pingSession",
        requestEncoder: "ping",
        responseDecoder: "ping",
        execution: "synchronous-response",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "none",
      },
      beacon: {
        adapterMethod: "pingBeacon",
        requestEncoder: "ping",
        responseDecoder: "ping",
        execution: "asynchronous-beacon-task",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "target.rename": {
    id: "target.rename",
    modes: ["session", "beacon"],
    capabilityId: "target.rename",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      session: {
        adapterMethod: "renameSession",
        requestEncoder: "rename-target",
        responseDecoder: "rename-target",
        execution: "synchronous-response",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "target-refresh",
      },
      beacon: {
        adapterMethod: "renameBeacon",
        requestEncoder: "rename-target",
        responseDecoder: "rename-target",
        execution: "synchronous-response",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "target-refresh",
      },
    },
  },
  "target.env-set": {
    id: "target.env-set",
    modes: ["session", "beacon"],
    capabilityId: "target.environment.write",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      session: {
        adapterMethod: "setEnvSession",
        requestEncoder: "set-environment",
        responseDecoder: "environment-mutation",
        execution: "synchronous-response",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "environment-read",
      },
      beacon: {
        adapterMethod: "setEnvBeacon",
        requestEncoder: "set-environment",
        responseDecoder: "environment-mutation",
        execution: "asynchronous-beacon-task",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "target.env-unset": {
    id: "target.env-unset",
    modes: ["session", "beacon"],
    capabilityId: "target.environment.write",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      session: {
        adapterMethod: "unsetEnvSession",
        requestEncoder: "unset-environment",
        responseDecoder: "environment-mutation",
        execution: "synchronous-response",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "environment-read",
      },
      beacon: {
        adapterMethod: "unsetEnvBeacon",
        requestEncoder: "unset-environment",
        responseDecoder: "environment-mutation",
        execution: "asynchronous-beacon-task",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "beacon.reconfigure": {
    id: "beacon.reconfigure",
    modes: ["beacon"],
    capabilityId: "beacon.reconfigure",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "reconfigureBeacon",
        requestEncoder: "reconfigure-beacon",
        responseDecoder: "reconfigure-beacon",
        execution: "asynchronous-beacon-task",
        timeout: SIXTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "target-refresh",
      },
    },
  },
  "beacon.open-session": {
    id: "beacon.open-session",
    modes: ["beacon"],
    capabilityId: "beacon.open-session",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "none",
    disposition: "inline-text",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "openSessionFromBeacon",
        requestEncoder: "open-beacon-session",
        responseDecoder: "open-beacon-session",
        execution: "asynchronous-beacon-task",
        timeout: SIXTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "task-delivery-only",
      },
    },
  },
} as const satisfies CompleteOperationRegistry;

export const OPERATION_REGISTRY: CompleteOperationRegistry = deepFreeze(registry);

export function getOperationDescriptor(operationId: TargetOperationId): CompiledOperationDescriptor {
  return OPERATION_REGISTRY[operationId];
}

export function findOperationDescriptor(value: unknown): CompiledOperationDescriptor | undefined {
  return isTargetOperationId(value) ? OPERATION_REGISTRY[value] : undefined;
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
