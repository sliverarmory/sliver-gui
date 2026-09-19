import { faArrowRight, faPen, faSkullCrossbones, faStop, faUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import type { SliverSnapshot } from "../../../shared/contracts";
import type { TargetMode, TargetRef } from "../../../shared/target-contracts";
import { capabilityFor } from "../pages/target-page-model";
import type { ApplicationContextMenuAction } from "./ApplicationContextMenu";

export type SessionContextActionId = "target.interact" | "target.interact-popout" | "target.rename" | "session.close" | "target.kill";

export function sessionContextTargetIdentity(target: TargetRef | null | undefined): string | undefined {
  return target ? `${target.backendEpoch}:${target.mode}:${target.id}:${target.fingerprint}` : undefined;
}

/** Shared menu definitions keep target actions consistent across inventory views. */
export function sessionContextMenuActions({ target, mode = target?.mode ?? "session", activeTarget, capabilities, disabled, onAction, showUnavailable = false }: {
  target: TargetRef | null | undefined;
  mode?: TargetMode;
  activeTarget: TargetRef | null;
  capabilities: SliverSnapshot["targetContext"]["capabilities"];
  disabled: boolean;
  /** Display inert target entries when a visible node has no current authority. */
  showUnavailable?: boolean;
  onAction: (target: TargetRef, action: SessionContextActionId) => void | Promise<void>;
}): ApplicationContextMenuAction[] {
  if (!target && !showUnavailable) return [];
  const unavailable = disabled || !target;
  const hasCurrentCapabilities = sessionContextTargetIdentity(target) === sessionContextTargetIdentity(activeTarget);
  const interactionActions: ApplicationContextMenuAction[] = [{
    id: "target.interact",
    label: "Interact",
    icon: faArrowRight,
    isDisabled: unavailable,
    onAction: () => target ? onAction(target, "target.interact") : undefined,
  }, {
    id: "target.interact-popout",
    label: "Interact",
    ariaLabel: "Interact in new window",
    icon: faUpRightFromSquare,
    isDisabled: unavailable,
    onAction: () => target ? onAction(target, "target.interact-popout") : undefined,
  }];
  if (mode === "beacon") return interactionActions;
  return [...interactionActions, {
    id: "session.rename",
    label: "Rename",
    icon: faPen,
    isDisabled: unavailable,
    onAction: () => target ? onAction(target, "target.rename") : undefined,
  }, {
    id: "session.close",
    label: "Close Session",
    icon: faStop,
    variant: "danger",
    isDisabled: unavailable || (hasCurrentCapabilities && !capabilityFor(capabilities, "session.close")?.available),
    onAction: () => target ? onAction(target, "session.close") : undefined,
  }, {
    id: "session.kill",
    label: "Kill Session",
    icon: faSkullCrossbones,
    variant: "danger",
    isDisabled: unavailable || (hasCurrentCapabilities && !capabilityFor(capabilities, "target.terminate")?.available),
    onAction: () => target ? onAction(target, "target.kill") : undefined,
  }];
}
