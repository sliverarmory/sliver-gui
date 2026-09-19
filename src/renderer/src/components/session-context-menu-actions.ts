import { faPen, faSkullCrossbones, faStop } from "@fortawesome/free-solid-svg-icons";
import type { SliverSnapshot } from "../../../shared/contracts";
import type { TargetRef } from "../../../shared/target-contracts";
import { capabilityFor } from "../pages/target-page-model";
import type { ApplicationContextMenuAction } from "./ApplicationContextMenu";

export type SessionContextActionId = "target.rename" | "session.close" | "target.kill";

export function sessionContextTargetIdentity(target: TargetRef | null | undefined): string | undefined {
  return target ? `${target.backendEpoch}:${target.mode}:${target.id}:${target.fingerprint}` : undefined;
}

/** Shared menu definitions keep session actions consistent across inventory views. */
export function sessionContextMenuActions({ target, activeTarget, capabilities, disabled, onAction }: {
  target: TargetRef | null | undefined;
  activeTarget: TargetRef | null;
  capabilities: SliverSnapshot["targetContext"]["capabilities"];
  disabled: boolean;
  onAction: (target: TargetRef, action: SessionContextActionId) => void | Promise<void>;
}): ApplicationContextMenuAction[] {
  if (target?.mode !== "session") return [];
  const hasCurrentCapabilities = sessionContextTargetIdentity(target) === sessionContextTargetIdentity(activeTarget);
  return [{
    id: "session.rename",
    label: "Rename",
    icon: faPen,
    isDisabled: disabled,
    onAction: () => onAction(target, "target.rename"),
  }, {
    id: "session.close",
    label: "Close Session",
    icon: faStop,
    variant: "danger",
    isDisabled: disabled || (hasCurrentCapabilities && !capabilityFor(capabilities, "session.close")?.available),
    onAction: () => onAction(target, "session.close"),
  }, {
    id: "session.kill",
    label: "Kill Session",
    icon: faSkullCrossbones,
    variant: "danger",
    isDisabled: disabled || (hasCurrentCapabilities && !capabilityFor(capabilities, "target.terminate")?.available),
    onAction: () => onAction(target, "target.kill"),
  }];
}
