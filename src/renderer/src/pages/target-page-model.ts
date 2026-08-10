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
  TargetOperationId,
  TargetOperationRecord,
  TargetOperationState,
} from "../../../shared/operation-contracts";

export type TargetModeFilter = "all" | TargetMode;

const OPERATION_LABELS: Readonly<Record<TargetOperationId, string>> = {
  "target.ping": "Ping",
  "target.rename": "Rename",
  "target.env-set": "Set environment variable",
  "target.env-unset": "Unset environment variable",
  "beacon.reconfigure": "Reconfigure beacon",
  "beacon.open-session": "Open session",
};

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

export function operationLabel(operationId: TargetOperationId): string {
  return OPERATION_LABELS[operationId];
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
