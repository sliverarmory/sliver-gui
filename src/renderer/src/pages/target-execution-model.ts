import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faBolt,
  faCodeBranch,
  faComputer,
  faFileCode,
  faKey,
  faList,
  faMicrochip,
  faNetworkWired,
  faPlay,
  faRotate,
  faShieldHalved,
  faSkullCrossbones,
  faTerminal,
  faUserGroup,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";

import type {
  ExecutionCapability,
  ExecutionOperationId,
  ExecutionRiskClass,
} from "../../../shared/execution-contracts";
import type { TargetSummary } from "../../../shared/target-contracts";

export type ExecutionCategoryId = "process" | "payloads" | "remote" | "identity";

export interface ExecutionCategoryPresentation {
  id: ExecutionCategoryId;
  label: string;
  description: string;
}

export interface ExecutionActionPresentation {
  category: ExecutionCategoryId;
  label: string;
  description: string;
  icon: IconDefinition;
}

export const EXECUTION_CATEGORIES: readonly ExecutionCategoryPresentation[] = Object.freeze([
  {
    id: "process",
    label: "Process",
    description: "Start programs, inspect tracked children, and move into another process.",
  },
  {
    id: "payloads",
    label: "Payloads",
    description: "Load, inject, or stage reviewed native payloads on the selected target.",
  },
  {
    id: "remote",
    label: "Remote",
    description: "Reach another host through reviewed service or SSH workflows.",
  },
  {
    id: "identity",
    label: "Identity",
    description: "Inspect privileges and make explicit, reviewed token or identity changes.",
  },
]);

const ACTION_PRESENTATION = Object.freeze({
  "execution.process": {
    category: "process",
    label: "Execute process",
    description: "Start a program with explicit arguments, environment, and output handling.",
    icon: faTerminal,
  },
  "execution.children": {
    category: "process",
    label: "Background children",
    description: "Inspect the bounded inventory of tracked background processes.",
    icon: faList,
  },
  "execution.assembly": {
    category: "payloads",
    label: "Execute assembly",
    description: "Choose and run a .NET assembly with architecture-aware options.",
    icon: faFileCode,
  },
  "execution.shellcode": {
    category: "payloads",
    label: "Execute shellcode",
    description: "Choose reviewed shellcode and execute or inject it into a process.",
    icon: faBolt,
  },
  "execution.sideload": {
    category: "payloads",
    label: "Sideload library",
    description: "Choose a shared library and execute its entry point in a host process.",
    icon: faCodeBranch,
  },
  "execution.spawn-dll": {
    category: "payloads",
    label: "Spawn reflective DLL",
    description: "Choose a reflective DLL and execute its exported loader.",
    icon: faFileCode,
  },
  "execution.migrate": {
    category: "process",
    label: "Migrate process",
    description: "Move the implant into one explicitly selected Windows process.",
    icon: faRotate,
  },
  "execution.msf": {
    category: "payloads",
    label: "Run Metasploit payload",
    description: "Generate and execute a reviewed Metasploit payload in the current process.",
    icon: faSkullCrossbones,
  },
  "execution.msf-inject": {
    category: "payloads",
    label: "Inject Metasploit payload",
    description: "Generate a payload and inject it into one explicit process ID.",
    icon: faMicrochip,
  },
  "execution.psexec": {
    category: "remote",
    label: "Remote service",
    description: "Create a reviewed service workflow on one Windows host.",
    icon: faComputer,
  },
  "execution.ssh": {
    category: "remote",
    label: "SSH command",
    description: "Run an explicit command using one-operation authentication material.",
    icon: faNetworkWired,
  },
  "execution.backdoor": {
    category: "payloads",
    label: "Backdoor executable",
    description: "Modify one remote Windows executable using a selected implant profile.",
    icon: faWrench,
  },
  "execution.dll-hijack": {
    category: "payloads",
    label: "DLL hijack",
    description: "Prepare a reviewed DLL hijack at one explicit target location.",
    icon: faCodeBranch,
  },
  "privilege.get": {
    category: "identity",
    label: "Inspect privileges",
    description: "Read the current process integrity and bounded Windows privilege inventory.",
    icon: faShieldHalved,
  },
  "privilege.run-as": {
    category: "identity",
    label: "Run as user",
    description: "Start one process using credentials that are never persisted.",
    icon: faPlay,
  },
  "privilege.make-token": {
    category: "identity",
    label: "Make token",
    description: "Create a reviewed Windows logon session with one-operation credentials.",
    icon: faKey,
  },
  "privilege.impersonate": {
    category: "identity",
    label: "Impersonate user",
    description: "Adopt one explicitly named logged-in user token.",
    icon: faUserGroup,
  },
  "privilege.revert": {
    category: "identity",
    label: "Revert identity",
    description: "Discard the stolen token and return to the implant process identity.",
    icon: faRotate,
  },
  "privilege.get-system": {
    category: "identity",
    label: "Get SYSTEM",
    description: "Request a new reviewed session running as NT AUTHORITY\\SYSTEM.",
    icon: faShieldHalved,
  },
} satisfies Readonly<Record<ExecutionOperationId, ExecutionActionPresentation>>);

export function executionActionPresentation(operationId: ExecutionOperationId): ExecutionActionPresentation {
  return ACTION_PRESENTATION[operationId];
}

export function executionCategoryPresentation(category: ExecutionCategoryId): ExecutionCategoryPresentation {
  return EXECUTION_CATEGORIES.find((candidate) => candidate.id === category) ?? EXECUTION_CATEGORIES[0]!;
}

/** The main-issued mode/platform arrays are authoritative. This renderer check
 * only removes structurally unsupported operations from normal navigation. */
export function executionCapabilitySupportsTarget(
  capability: ExecutionCapability,
  target: TargetSummary,
): boolean {
  const platform = target.os.trim().toLocaleLowerCase();
  return capability.modes.includes(target.mode) && capability.platforms.includes(platform);
}

export function executionRiskLabel(risk: ExecutionRiskClass): string {
  switch (risk) {
    case "read-only":
      return "Read only";
    case "mutating":
      return "Mutating";
    case "destructive":
      return "Destructive";
    case "credential-bearing":
      return "Credentials";
    case "high-opsec":
      return "High OPSEC";
  }
}

export function executionRiskColor(
  risk: ExecutionRiskClass,
): "default" | "danger" | "warning" {
  if (risk === "destructive") return "danger";
  if (risk === "credential-bearing" || risk === "high-opsec") return "warning";
  return "default";
}

export function defaultExecutionTimeout(operationId: ExecutionOperationId): number {
  switch (operationId) {
    case "privilege.run-as":
    case "privilege.impersonate":
    case "privilege.revert":
      return 30;
    case "execution.psexec":
    case "execution.backdoor":
    case "execution.dll-hijack":
    case "privilege.get-system":
      return 180;
    default:
      return 60;
  }
}

export function defaultHostProcess(platform: string): string {
  switch (platform.trim().toLocaleLowerCase()) {
    case "windows":
      return "C:\\Windows\\System32\\notepad.exe";
    case "darwin":
      return "/bin/zsh";
    default:
      return "/bin/sh";
  }
}

export function defaultShellcodeArchitecture(architecture: string): "386" | "amd64" | "arm64" {
  const normalized = architecture.trim().toLocaleLowerCase();
  if (normalized === "386" || normalized === "x86") return "386";
  if (normalized === "arm64" || normalized === "aarch64") return "arm64";
  return "amd64";
}
