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
  | "openSessionFromBeacon"
  | "pwdBeacon"
  | "lsBeacon"
  | "psBeacon"
  | "ifconfigBeacon"
  | "envBeacon"
  | "whoamiBeacon"
  | "netstatBeacon"
  | "mountBeacon"
  | "memfilesBeacon"
  | "catBeacon"
  | "headBeacon"
  | "tailBeacon"
  | "grepBeacon"
  | "registryReadBeacon"
  | "registryListSubkeysBeacon"
  | "registryListValuesBeacon"
  | "registryWriteBeacon"
  | "registryCreateBeacon"
  | "registryDeleteBeacon"
  | "servicesBeacon"
  | "serviceDetailBeacon"
  | "serviceStartBeacon"
  | "serviceStopBeacon";

export type OperationRequestEncoderId =
  | "ping"
  | "rename-target"
  | "set-environment"
  | "unset-environment"
  | "reconfigure-beacon"
  | "open-beacon-session"
  | "beacon-working-directory"
  | "beacon-directory-listing"
  | "beacon-process-list"
  | "beacon-network-interfaces"
  | "beacon-environment-list"
  | "beacon-whoami"
  | "beacon-netstat"
  | "beacon-mount"
  | "beacon-memfiles"
  | "beacon-cat"
  | "beacon-head"
  | "beacon-tail"
  | "beacon-grep"
  | "beacon-registry-read"
  | "beacon-registry-list-subkeys"
  | "beacon-registry-list-values"
  | "beacon-registry-write"
  | "beacon-registry-create"
  | "beacon-registry-delete"
  | "beacon-service-list"
  | "beacon-service-info"
  | "beacon-service-start"
  | "beacon-service-stop";

export type OperationResponseDecoderId =
  | "ping"
  | "rename-target"
  | "environment-mutation"
  | "reconfigure-beacon"
  | "open-beacon-session"
  | "beacon-working-directory"
  | "beacon-directory-listing"
  | "beacon-process-list"
  | "beacon-network-interfaces"
  | "beacon-environment-list"
  | "beacon-whoami"
  | "beacon-netstat"
  | "beacon-mount"
  | "beacon-memfiles"
  | "beacon-cat"
  | "beacon-head"
  | "beacon-tail"
  | "beacon-grep"
  | "beacon-registry-read"
  | "beacon-registry-list-subkeys"
  | "beacon-registry-list-values"
  | "beacon-registry-write"
  | "beacon-registry-create"
  | "beacon-registry-delete"
  | "beacon-service-list"
  | "beacon-service-info"
  | "beacon-service-start"
  | "beacon-service-stop";

export type OperationExecutionMode = "synchronous-response" | "asynchronous-beacon-task";

export type OperationCancellationPolicy = "not-supported" | "best-effort-beacon-task";

export type OperationReconciliationPolicy =
  | "none"
  | "beacon-task-state"
  | "target-refresh"
  | "environment-read"
  | "task-delivery-only";

export type OperationConfirmationPolicy = "none" | "target-action-plan" | "beacon-mutation-plan";

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

const FILE_READ_RESULT_BOUNDS = Object.freeze({
  ...SMALL_RESULT_BOUNDS,
  maximumDecodedBytes: 128 * 1_024,
} as const satisfies OperationResultBounds);

const MUTATION_IDEMPOTENCY = Object.freeze({
  class: "unconfirmed-mutation",
  maxAutomaticRetries: 0,
} as const satisfies OperationIdempotencyPolicy);

const ASYNC_READ_IDEMPOTENCY = Object.freeze({
  class: "idempotent-read",
  // Enqueuing is itself a side effect. A lost acknowledgement must never
  // create a duplicate task, even though the implant operation is read-only.
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
  "beacon.filesystem.pwd": {
    id: "beacon.filesystem.pwd",
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: ASYNC_READ_IDEMPOTENCY,
    confirmation: "none",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "pwdBeacon",
        requestEncoder: "beacon-working-directory",
        responseDecoder: "beacon-working-directory",
        execution: "asynchronous-beacon-task",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "beacon.filesystem.ls": {
    id: "beacon.filesystem.ls",
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: ASYNC_READ_IDEMPOTENCY,
    confirmation: "none",
    disposition: "table",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "lsBeacon",
        requestEncoder: "beacon-directory-listing",
        responseDecoder: "beacon-directory-listing",
        execution: "asynchronous-beacon-task",
        timeout: SIXTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "beacon.process.list": {
    id: "beacon.process.list",
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: ASYNC_READ_IDEMPOTENCY,
    confirmation: "none",
    disposition: "table",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "psBeacon",
        requestEncoder: "beacon-process-list",
        responseDecoder: "beacon-process-list",
        execution: "asynchronous-beacon-task",
        timeout: SIXTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "beacon.network.interfaces": {
    id: "beacon.network.interfaces",
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: ASYNC_READ_IDEMPOTENCY,
    confirmation: "none",
    disposition: "table",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod: "ifconfigBeacon",
        requestEncoder: "beacon-network-interfaces",
        responseDecoder: "beacon-network-interfaces",
        execution: "asynchronous-beacon-task",
        timeout: THIRTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  },
  "beacon.environment.list": beaconRead("beacon.environment.list", "envBeacon", "beacon-environment-list", "table", 30),
  "beacon.identity.whoami": beaconRead("beacon.identity.whoami", "whoamiBeacon", "beacon-whoami", "structured-detail", 30),
  "beacon.network.netstat": beaconRead("beacon.network.netstat", "netstatBeacon", "beacon-netstat", "table", 60),
  "beacon.filesystem.mount": beaconRead("beacon.filesystem.mount", "mountBeacon", "beacon-mount", "table", 30),
  "beacon.filesystem.memfiles": beaconRead("beacon.filesystem.memfiles", "memfilesBeacon", "beacon-memfiles", "table", 30),
  "beacon.filesystem.cat": beaconRead("beacon.filesystem.cat", "catBeacon", "beacon-cat", "inline-text", 60),
  "beacon.filesystem.head": beaconRead("beacon.filesystem.head", "headBeacon", "beacon-head", "inline-text", 60),
  "beacon.filesystem.tail": beaconRead("beacon.filesystem.tail", "tailBeacon", "beacon-tail", "inline-text", 60),
  "beacon.filesystem.grep": beaconRead("beacon.filesystem.grep", "grepBeacon", "beacon-grep", "table", 60),
  "beacon.registry.read": beaconRead("beacon.registry.read", "registryReadBeacon", "beacon-registry-read", "structured-detail", 60),
  "beacon.registry.list-subkeys": beaconRead("beacon.registry.list-subkeys", "registryListSubkeysBeacon", "beacon-registry-list-subkeys", "table", 60),
  "beacon.registry.list-values": beaconRead("beacon.registry.list-values", "registryListValuesBeacon", "beacon-registry-list-values", "table", 60),
  "beacon.registry.write": beaconMutation("beacon.registry.write", "registryWriteBeacon", "beacon-registry-write"),
  "beacon.registry.create": beaconMutation("beacon.registry.create", "registryCreateBeacon", "beacon-registry-create"),
  "beacon.registry.delete": beaconMutation("beacon.registry.delete", "registryDeleteBeacon", "beacon-registry-delete"),
  "beacon.service.list": beaconRead("beacon.service.list", "servicesBeacon", "beacon-service-list", "table", 60),
  "beacon.service.info": beaconRead("beacon.service.info", "serviceDetailBeacon", "beacon-service-info", "structured-detail", 60),
  "beacon.service.start": beaconMutation("beacon.service.start", "serviceStartBeacon", "beacon-service-start"),
  "beacon.service.stop": beaconMutation("beacon.service.stop", "serviceStopBeacon", "beacon-service-stop"),
} as const satisfies CompleteOperationRegistry;

function beaconMutation<Id extends TargetOperationId>(
  id: Id,
  adapterMethod: OperationAdapterMethodId,
  codec: OperationRequestEncoderId & OperationResponseDecoderId,
): CompiledOperationDescriptor & { readonly id: Id } {
  return {
    id,
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: MUTATION_IDEMPOTENCY,
    confirmation: "beacon-mutation-plan",
    disposition: "structured-detail",
    resultBounds: SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod,
        requestEncoder: codec,
        responseDecoder: codec,
        execution: "asynchronous-beacon-task",
        timeout: SIXTY_SECOND_TIMEOUT,
        cancellation: "not-supported",
        reconciliation: "beacon-task-state",
      },
    },
  };
}

function beaconRead<Id extends TargetOperationId>(
  id: Id,
  adapterMethod: OperationAdapterMethodId,
  codec: OperationRequestEncoderId & OperationResponseDecoderId,
  disposition: OperationDispositionKind,
  timeoutSeconds: 30 | 60,
): CompiledOperationDescriptor & { readonly id: Id } {
  return {
    id,
    modes: ["beacon"],
    capabilityId: "target.task.execute",
    idempotency: ASYNC_READ_IDEMPOTENCY,
    confirmation: "none",
    disposition,
    resultBounds: disposition === "inline-text" ? FILE_READ_RESULT_BOUNDS : SMALL_RESULT_BOUNDS,
    bindings: {
      beacon: {
        adapterMethod,
        requestEncoder: codec,
        responseDecoder: codec,
        execution: "asynchronous-beacon-task",
        timeout: timeoutSeconds === 30 ? THIRTY_SECOND_TIMEOUT : SIXTY_SECOND_TIMEOUT,
        cancellation: "best-effort-beacon-task",
        reconciliation: "beacon-task-state",
      },
    },
  };
}

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
