import type {
  ExecutionArtifactRequirement,
  ExecutionCapability,
  ExecutionCapabilityReason,
  ExecutionOperationId,
  ExecutionRiskClass,
} from "../shared/execution-contracts.js";
import { EXECUTION_OPERATION_IDS } from "../shared/execution-contracts.js";
import type { TargetMode, TargetSummary } from "../shared/target-contracts.js";

export type ExecutionCategory = "process" | "payloads" | "remote" | "identity";

export interface ExecutionOperationDescriptor {
  readonly id: ExecutionOperationId;
  readonly category: ExecutionCategory;
  readonly modes: readonly TargetMode[];
  readonly platforms: readonly string[];
  readonly risk: ExecutionRiskClass;
  readonly confirmationRequired: boolean;
  readonly credentialBearing: boolean;
  readonly timeoutSeconds: number;
  readonly artifacts: readonly ExecutionArtifactRequirement[];
  readonly submittedMessage: string;
  readonly completedMessage: string;
  readonly failedMessage: string;
}

const MIB = 1_024 * 1_024;
const ALL_PLATFORMS = Object.freeze(["windows", "linux", "darwin"] as const);
const BOTH_MODES = Object.freeze(["session", "beacon"] as const);
const WINDOWS = Object.freeze(["windows"] as const);
const SESSION = Object.freeze(["session"] as const);

function artifact(
  role: ExecutionArtifactRequirement["role"],
  label: string,
  extensions: readonly string[],
  maximumBytes = 64 * MIB,
  required = true,
): ExecutionArtifactRequirement {
  return Object.freeze({ role, label, required, maximumBytes, acceptedExtensions: [...extensions] });
}

function descriptor(
  id: ExecutionOperationId,
  category: ExecutionCategory,
  modes: readonly TargetMode[],
  platforms: readonly string[],
  risk: ExecutionRiskClass,
  options: {
    credentialBearing?: boolean;
    confirmationRequired?: boolean;
    timeoutSeconds?: number;
    artifacts?: readonly ExecutionArtifactRequirement[];
    completedMessage: string;
  },
): ExecutionOperationDescriptor {
  return Object.freeze({
    id,
    category,
    modes,
    platforms,
    risk,
    confirmationRequired: options.confirmationRequired ?? risk !== "read-only",
    credentialBearing: options.credentialBearing ?? risk === "credential-bearing",
    timeoutSeconds: options.timeoutSeconds ?? 60,
    artifacts: Object.freeze([...(options.artifacts ?? [])]),
    submittedMessage: "The reviewed operation was submitted to the selected target.",
    completedMessage: options.completedMessage,
    failedMessage: "The selected target rejected the reviewed operation.",
  });
}

const registry = {
  "execution.process": descriptor("execution.process", "process", BOTH_MODES, ALL_PLATFORMS, "high-opsec", {
    completedMessage: "Process execution completed.",
  }),
  "execution.children": descriptor("execution.children", "process", BOTH_MODES, ALL_PLATFORMS, "read-only", {
    confirmationRequired: false,
    completedMessage: "Background process inventory refreshed.",
  }),
  "execution.assembly": descriptor("execution.assembly", "payloads", BOTH_MODES, WINDOWS, "high-opsec", {
    artifacts: [artifact("assembly", ".NET assembly", [".exe", ".dll"])],
    completedMessage: "Assembly execution completed.",
  }),
  "execution.shellcode": descriptor("execution.shellcode", "payloads", BOTH_MODES, ALL_PLATFORMS, "high-opsec", {
    artifacts: [artifact("shellcode", "Raw shellcode", [".bin", ".raw", ".shellcode"])],
    completedMessage: "Shellcode execution completed.",
  }),
  "execution.sideload": descriptor("execution.sideload", "payloads", BOTH_MODES, ALL_PLATFORMS, "high-opsec", {
    artifacts: [artifact("shared-library", "Shared library", [".dll", ".so", ".dylib"])],
    completedMessage: "Shared library execution completed.",
  }),
  "execution.spawn-dll": descriptor("execution.spawn-dll", "payloads", BOTH_MODES, WINDOWS, "high-opsec", {
    artifacts: [artifact("reflective-dll", "Reflective DLL", [".dll"])],
    completedMessage: "Reflective DLL execution completed.",
  }),
  "execution.migrate": descriptor("execution.migrate", "process", BOTH_MODES, WINDOWS, "destructive", {
    completedMessage: "Migration request completed.",
  }),
  "execution.msf": descriptor("execution.msf", "payloads", BOTH_MODES, ALL_PLATFORMS, "high-opsec", {
    completedMessage: "Metasploit payload execution completed.",
  }),
  "execution.msf-inject": descriptor("execution.msf-inject", "payloads", BOTH_MODES, ALL_PLATFORMS, "high-opsec", {
    completedMessage: "Metasploit payload injection completed.",
  }),
  "execution.psexec": descriptor("execution.psexec", "remote", SESSION, WINDOWS, "destructive", {
    artifacts: [artifact("service-executable", "Service executable", [".exe"], 64 * MIB, false)],
    timeoutSeconds: 180,
    completedMessage: "Remote service workflow completed.",
  }),
  "execution.ssh": descriptor("execution.ssh", "remote", SESSION, ALL_PLATFORMS, "credential-bearing", {
    credentialBearing: true,
    artifacts: [
      artifact("ssh-private-key", "SSH private key", [".pem", ".key"], 1 * MIB, false),
      artifact("kerberos-keytab", "Kerberos keytab", [".keytab"], 4 * MIB, false),
    ],
    completedMessage: "Remote SSH command completed.",
  }),
  "execution.backdoor": descriptor("execution.backdoor", "payloads", SESSION, WINDOWS, "destructive", {
    timeoutSeconds: 180,
    completedMessage: "Executable backdoor workflow completed.",
  }),
  "execution.dll-hijack": descriptor("execution.dll-hijack", "payloads", SESSION, WINDOWS, "destructive", {
    artifacts: [
      artifact("hijack-reference-dll", "Reference DLL", [".dll"], 64 * MIB, false),
      artifact("hijack-target-dll", "Target DLL", [".dll"], 64 * MIB, false),
    ],
    timeoutSeconds: 180,
    completedMessage: "DLL hijack workflow completed.",
  }),
  "privilege.get": descriptor("privilege.get", "identity", BOTH_MODES, WINDOWS, "read-only", {
    confirmationRequired: false,
    completedMessage: "Privilege inventory refreshed.",
  }),
  "privilege.run-as": descriptor("privilege.run-as", "identity", BOTH_MODES, WINDOWS, "credential-bearing", {
    credentialBearing: true,
    timeoutSeconds: 30,
    completedMessage: "Run-as request completed.",
  }),
  "privilege.make-token": descriptor("privilege.make-token", "identity", BOTH_MODES, WINDOWS, "credential-bearing", {
    credentialBearing: true,
    completedMessage: "Token creation request completed.",
  }),
  "privilege.impersonate": descriptor("privilege.impersonate", "identity", BOTH_MODES, WINDOWS, "high-opsec", {
    timeoutSeconds: 30,
    completedMessage: "Impersonation request completed.",
  }),
  "privilege.revert": descriptor("privilege.revert", "identity", BOTH_MODES, WINDOWS, "high-opsec", {
    timeoutSeconds: 30,
    completedMessage: "Token identity was reverted.",
  }),
  "privilege.get-system": descriptor("privilege.get-system", "identity", SESSION, WINDOWS, "high-opsec", {
    timeoutSeconds: 180,
    completedMessage: "SYSTEM session request completed.",
  }),
} as const satisfies Readonly<Record<ExecutionOperationId, ExecutionOperationDescriptor>>;

export const EXECUTION_OPERATION_REGISTRY = Object.freeze(registry);

export function executionOperationDescriptor(operationId: ExecutionOperationId): ExecutionOperationDescriptor {
  return EXECUTION_OPERATION_REGISTRY[operationId];
}

export function executionCapabilitiesForTarget(target: TargetSummary): ExecutionCapability[] {
  return EXECUTION_OPERATION_IDS.map((operationId) => executionCapabilityForTarget(operationId, target));
}

export function executionCapabilityForTarget(
  operationId: ExecutionOperationId,
  target: TargetSummary,
): ExecutionCapability {
  const operation = executionOperationDescriptor(operationId);
  const reason = capabilityReason(operation, target);
  return Object.freeze({
    operationId,
    available: reason === undefined,
    modes: [...operation.modes],
    platforms: [...operation.platforms],
    risk: operation.risk,
    confirmationRequired: operation.confirmationRequired,
    credentialBearing: operation.credentialBearing,
    artifacts: operation.artifacts.map((item) => ({ ...item, acceptedExtensions: [...item.acceptedExtensions] })),
    ...(reason === undefined ? {} : { reason }),
  });
}

export function assertExecutionOperationSupported(
  operationId: ExecutionOperationId,
  target: TargetSummary,
): ExecutionOperationDescriptor {
  const operation = executionOperationDescriptor(operationId);
  const reason = capabilityReason(operation, target);
  if (reason) throw new Error(reason.message);
  return operation;
}

function capabilityReason(
  operation: ExecutionOperationDescriptor,
  target: TargetSummary,
): ExecutionCapabilityReason | undefined {
  if (!operation.modes.includes(target.mode)) {
    return target.mode === "session"
      ? { code: "requires-beacon", message: "This operation requires a beacon target." }
      : { code: "requires-session", message: "This operation requires an active session." };
  }
  if (target.mode === "session" && target.liveness !== "active") {
    return { code: "target-unavailable", message: "This operation requires an active session." };
  }
  const platform = target.os.trim().toLowerCase();
  if (!operation.platforms.includes(platform)) {
    if (operation.platforms.length === 1 && operation.platforms[0] === "windows") {
      return { code: "requires-windows", message: "This operation is available only on Windows targets." };
    }
    return { code: "unsupported-platform", message: `This operation is unavailable on ${platform || "unknown"} targets.` };
  }
  return undefined;
}
