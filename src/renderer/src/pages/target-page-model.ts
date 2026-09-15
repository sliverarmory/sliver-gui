import type {
  BeaconSummary,
  TargetCapabilityId,
  TargetCapabilityState,
  TargetMode,
  TargetSummary,
} from "../../../shared/target-contracts";
import { targetMatchesCatalogQuery } from "../../../shared/target-contracts";
import type {
  BeaconTaskState,
  OperationRecordId,
  TargetOperationId,
  TargetOperationRecord,
  TargetOperationState,
} from "../../../shared/operation-contracts";
import { isTargetOperationId } from "../../../shared/operation-contracts";
import { isExecutionOperationId } from "../../../shared/execution-contracts";
import type { SessionWorkbenchOperationId } from "../../../shared/session-contracts";
import { executionActionPresentation } from "./target-execution-model";

export type TargetModeFilter = "all" | TargetMode;

const OPERATION_LABELS: Readonly<Record<TargetOperationId, string>> = {
  "target.ping": "Ping",
  "target.rename": "Rename",
  "target.env-set": "Set environment variable",
  "target.env-unset": "Unset environment variable",
  "beacon.reconfigure": "Reconfigure beacon",
  "beacon.open-session": "Open session",
  "beacon.filesystem.pwd": "Read working directory",
  "beacon.filesystem.ls": "List directory",
  "beacon.process.list": "List processes",
  "beacon.network.interfaces": "List network interfaces",
};

const SESSION_OPERATION_LABELS = {
  "session.identity.current-token-owner": "Read current token owner",
  "session.environment.list": "List environment variables",
  "session.environment.reveal": "Reveal environment variable",
  "session.network.interfaces": "List network interfaces",
  "session.network.connections": "List network connections",
  "session.filesystem.pwd": "Read working directory",
  "session.filesystem.ls": "List directory",
  "session.filesystem.cat": "Read file",
  "session.filesystem.head": "Read file head",
  "session.filesystem.tail": "Read file tail",
  "session.filesystem.read-hex": "Read file as hex",
  "session.filesystem.grep": "Search files",
  "session.filesystem.mounts": "List mounts",
  "session.filesystem.memfiles.list": "List memory files",
  "session.process.list": "List processes",
  "session.service.list": "List services",
  "session.service.detail": "Read service details",
  "session.registry.read": "Read registry value",
  "session.registry.list-subkeys": "List registry subkeys",
  "session.registry.list-values": "List registry values",
  "session.filesystem.cd": "Change working directory",
  "session.filesystem.mkdir": "Create directory",
  "session.filesystem.memfiles.add": "Add memory file",
  "session.filesystem.chmod": "Change file mode",
  "session.filesystem.chown": "Change file ownership",
  "session.filesystem.chtimes": "Change file timestamps",
  "session.service.start": "Start service",
  "session.screenshot.capture": "Capture screenshot",
  "session.artifact.save": "Save captured artifact",
  "session.filesystem.download": "Download file",
  "session.filesystem.upload-open": "Upload file",
  "session.filesystem.stage-text": "Stage text changes",
  "session.filesystem.stage-hex": "Stage hex changes",
  "session.process.dump": "Dump process",
  "session.registry.read-hive": "Save registry hive",
  "session.filesystem.cp": "Copy file",
  "session.filesystem.mv": "Move file",
  "session.filesystem.rm": "Remove file",
  "session.filesystem.chmod-recursive": "Change file modes recursively",
  "session.filesystem.chown-recursive": "Change file ownership recursively",
  "session.filesystem.memfiles.rm": "Remove memory file",
  "session.filesystem.upload-overwrite": "Overwrite file",
  "session.filesystem.edit-text-overwrite": "Save text file",
  "session.filesystem.patch-hex": "Save hex changes",
  "session.process.terminate": "Terminate process",
  "session.service.stop": "Stop service",
  "session.registry.write": "Write registry value",
  "session.registry.create-key": "Create registry key",
  "session.registry.delete-key": "Delete registry key",
} as const satisfies Readonly<Record<SessionWorkbenchOperationId, string>>;

export function targetRowKey(target: Pick<TargetSummary, "mode" | "id">): string {
  return `${target.mode}:${target.id}`;
}

export function filterTargets(
  targets: readonly TargetSummary[],
  mode: TargetModeFilter,
  query: string,
): TargetSummary[] {
  return targets.filter((target) => {
    if (mode !== "all" && target.mode !== mode) return false;
    return targetMatchesCatalogQuery(target, query);
  });
}

export function targetStatus(target: TargetSummary): {
  label: string;
  color: "success" | "danger" | "warning" | "default";
} {
  if (target.mode === "session") {
    return target.liveness === "active"
      ? { label: "Active", color: "success" }
      : { label: "Dead", color: "danger" };
  }
  if (target.checkinStatus === "on-time") return { label: "On time", color: "success" };
  if (target.checkinStatus === "overdue") return { label: "Overdue", color: "warning" };
  return { label: "Unknown", color: "default" };
}

export function targetTimingLabel(target: TargetSummary): string {
  if (target.mode === "beacon" && target.nextCheckinAt) {
    return `Next ${formatTimestamp(target.nextCheckinAt)}`;
  }
  if (target.lastCheckinAt) return `Seen ${formatTimestamp(target.lastCheckinAt)}`;
  return "No check-in reported";
}

export function beaconTaskCountLabel(beacon: BeaconSummary): string {
  const total = beacon.taskCount ?? 0;
  const nonCompleted = beacon.nonCompletedTaskCount ?? 0;
  return nonCompleted > 0 ? `${nonCompleted} non-completed / ${total} total` : `${total} total`;
}

export function operationLabel(operationId: OperationRecordId): string {
  if (isTargetOperationId(operationId)) return OPERATION_LABELS[operationId];
  if (isExecutionOperationId(operationId)) return executionActionPresentation(operationId).label;
  return SESSION_OPERATION_LABELS[operationId];
}

export function operationStateLabel(state: TargetOperationState): string {
  return state.split("-").map(capitalize).join(" ");
}

export function operationStateColor(
  state: TargetOperationState,
): "success" | "danger" | "warning" | "accent" | "default" {
  if (state === "completed") return "success";
  if (state === "failed" || state === "target-disappeared") return "danger";
  if (state === "partial" || state === "outcome-unknown") return "warning";
  if (state === "queued" || state === "submitting" || state === "submitted" || state === "running") {
    return "accent";
  }
  return "default";
}

export function taskStateColor(
  state: BeaconTaskState,
): "success" | "danger" | "warning" | "accent" | "default" {
  if (state === "completed") return "success";
  if (state === "failed") return "danger";
  if (state === "pending") return "accent";
  if (state === "unknown") return "warning";
  return "default";
}

export function isOperationCancelable(
  operation: Pick<TargetOperationRecord, "state"> &
    Pick<Partial<TargetOperationRecord>, "cancellation">,
): boolean {
  return operation.cancellation === "best-effort-beacon-task" &&
    ["queued", "submitting", "submitted", "running"].includes(operation.state);
}

export function capabilityFor(
  capabilities: readonly TargetCapabilityState[],
  id: TargetCapabilityId,
): TargetCapabilityState | undefined {
  return capabilities.find((capability) => capability.id === id);
}

export function formatTimestamp(value?: string): string {
  if (!value) return "Not reported";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function formatDuration(milliseconds?: number): string {
  if (milliseconds === undefined) return "Not reported";
  if (milliseconds < 1_000) return `${milliseconds} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} min`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}
