import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "@heroui/react";
import type { SliverSnapshot } from "../../../shared/contracts";
import type { BeaconSummary, SessionSummary, TargetActionExecutionResult, TargetActionPlan, TargetRef } from "../../../shared/target-contracts";
import { DestructiveReviewModal } from "../pages/TargetsPage";
import { capabilityFor } from "../pages/target-page-model";
import { isUsableConnection } from "../connection-status";
import type { ApplicationContextMenuAction } from "./ApplicationContextMenu";
import { RenameSessionModal } from "./RenameSessionModal";
import { sessionContextMenuActions, sessionContextTargetIdentity, type SessionContextActionId } from "./session-context-menu-actions";

interface SessionInteraction {
  target: TargetRef;
  incarnation: string;
  request: number;
  action: Exclude<SessionContextActionId, "target.interact" | "target.interact-popout">;
  plan?: TargetActionPlan;
  result?: TargetActionExecutionResult;
}

function incarnation(snapshot: SliverSnapshot): string {
  return JSON.stringify([snapshot.connection.epoch, snapshot.connection.incarnation ?? 0,
    snapshot.connection.server, snapshot.connection.configName]);
}

function connected(snapshot: SliverSnapshot): boolean {
  return snapshot.connection.epoch !== undefined
    && isUsableConnection(snapshot.connection.status);
}

function selectable(snapshot: SliverSnapshot, target: TargetRef): boolean {
  return snapshot.connection.epoch === target.backendEpoch
    && snapshot.targetContext.selectableTargets.some((ref) => sessionContextTargetIdentity(ref) === sessionContextTargetIdentity(target))
    && (target.mode === "session" ? snapshot.domains.sessions.items : snapshot.domains.beacons.items)
      .some((summary) => summary.id === target.id);
}

function selected(snapshot: SliverSnapshot, target: TargetRef): boolean {
  return snapshot.targetContext.status === "selected"
    && sessionContextTargetIdentity(snapshot.targetContext.activeTarget) === sessionContextTargetIdentity(target)
    && snapshot.targetContext.activeTargetSummary?.mode === target.mode
    && snapshot.targetContext.activeTargetSummary.id === target.id;
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** Existing interaction navigation and session dialogs, bound to a live main-issued inventory ref. */
export function useSessionContextActions({ snapshot, onSnapshot, onOpenSession, onOpenBeacon }: {
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
  onOpenSession?: (session: SessionSummary, target: TargetRef) => void;
  onOpenBeacon?: (beacon: BeaconSummary, target: TargetRef) => void;
}): { actionsForTarget: (target: TargetRef) => ApplicationContextMenuAction[]; dialogs: ReactNode } {
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const navigationRef = useRef({ onOpenSession, onOpenBeacon });
  navigationRef.current = { onOpenSession, onOpenBeacon };
  const mounted = useRef(false);
  const sequence = useRef(0);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [interaction, setInteraction] = useState<SessionInteraction>();
  const backend = incarnation(snapshot);
  const usable = connected(snapshot);
  const contextKey = `${backend}:${usable}`;
  const contextVersion = useRef({ key: contextKey });
  if (contextVersion.current.key !== contextKey) contextVersion.current = { key: contextKey };
  const version = contextVersion.current;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; busyRef.current = false; };
  }, []);

  useEffect(() => {
    sequence.current += 1;
    busyRef.current = false;
    setBusy(false);
    setExecuting(false);
    setInteraction(undefined);
  }, [backend, usable]);

  const scopeCurrent = useCallback((expected: string): boolean => mounted.current
    && connected(snapshotRef.current) && incarnation(snapshotRef.current) === expected, []);
  const requestCurrent = useCallback((expected: string, request: number): boolean =>
    scopeCurrent(expected) && sequence.current === request, [scopeCurrent]);

  const refresh = useCallback(async (expected: string): Promise<void> => {
    if (!scopeCurrent(expected)) return;
    const before = snapshotRef.current;
    try {
      const result = await window.sliver.refresh();
      if (!scopeCurrent(expected) || snapshotRef.current !== before) return;
      if (result.ok && result.value && incarnation(result.value) === expected) onSnapshotRef.current(result.value);
    } catch (error) {
      if (scopeCurrent(expected)) toast.danger("Could not refresh targets", { description: errorMessage(error) });
    }
  }, [scopeCurrent]);

  const runAction = useCallback(async (target: TargetRef, action: SessionContextActionId, expected: string): Promise<void> => {
    if (busyRef.current || !scopeCurrent(expected) || !selectable(snapshotRef.current, target)) return;
    const navigation = action === "target.interact" || action === "target.interact-popout";
    if (!navigation && target.mode !== "session") return;
    if (action === "target.interact"
      && !(target.mode === "session" ? navigationRef.current.onOpenSession : navigationRef.current.onOpenBeacon)) return;
    const request = ++sequence.current;
    busyRef.current = true;
    setBusy(true);
    setInteraction(undefined);
    try {
      const response = await window.sliver.selectTarget(target);
      if (!requestCurrent(expected, request) || !selectable(snapshotRef.current, target)) return;
      if (!response.ok || !response.value) {
        toast.danger(`Could not select ${target.mode}`, { description: response.error });
        return;
      }
      const confirmed = response.value;
      if (!connected(confirmed) || incarnation(confirmed) !== expected || !selected(confirmed, target)) {
        toast.warning("Target changed", { description: "The server did not confirm the selected target. Select it again from the live inventory." });
        return;
      }
      const previous = snapshotRef.current;
      onSnapshotRef.current(confirmed);
      if (!requestCurrent(expected, request) || !selectable(snapshotRef.current, target)
        || (snapshotRef.current !== previous && !selected(snapshotRef.current, target))) return;
      if (action === "target.interact") {
        const summary = confirmed.targetContext.activeTargetSummary!;
        const ref = confirmed.targetContext.activeTarget!;
        if (summary.mode === "session") navigationRef.current.onOpenSession?.(summary, ref);
        else navigationRef.current.onOpenBeacon?.(summary, ref);
        return;
      }
      if (action === "target.interact-popout") {
        const result = await window.sliver.openInteractionWindow();
        if (requestCurrent(expected, request) && !result.ok) {
          toast.danger("Could not pop out interaction", { description: result.error });
        }
        return;
      }
      const current: SessionInteraction = { target: confirmed.targetContext.activeTarget!, incarnation: expected, request, action };
      if (action === "target.rename") {
        setInteraction(current);
        return;
      }
      const capability = capabilityFor(confirmed.targetContext.capabilities, action === "target.kill" ? "target.terminate" : "session.close");
      if (!capability?.available) {
        toast.warning("Session action unavailable", { description: capability?.reason?.message });
        return;
      }
      const plan = await window.sliver.prepareTargetAction({ actionId: action });
      if (!requestCurrent(expected, request) || !selectable(snapshotRef.current, target)
        || (snapshotRef.current !== previous && !selected(snapshotRef.current, target))) return;
      if (!plan.ok || !plan.value) {
        toast.danger("Could not review action", { description: plan.error });
        return;
      }
      const impact = plan.value.impact;
      if (impact.actionId !== action || impact.backend.epoch !== target.backendEpoch
        || impact.totalTargets !== 1 || impact.truncated || impact.targets.length !== 1
        || impact.targets[0]?.mode !== "session" || impact.targets[0].id !== target.id) {
        toast.warning("Session changed", { description: "The review did not match the selected session. Select it again from the live inventory." });
        return;
      }
      setInteraction({ ...current, plan: plan.value });
    } catch (error) {
      if (requestCurrent(expected, request)) toast.danger(navigation ? "Could not open interaction" : "Could not review session action", { description: errorMessage(error) });
    } finally {
      if (requestCurrent(expected, request)) { busyRef.current = false; setBusy(false); }
    }
  }, [requestCurrent, scopeCurrent]);

  const execute = useCallback(async (current: SessionInteraction): Promise<void> => {
    if (!current.plan || current.result || busyRef.current || !requestCurrent(current.incarnation, current.request)
      || !selected(snapshotRef.current, current.target) || !selectable(snapshotRef.current, current.target)) return;
    const capability = capabilityFor(snapshotRef.current.targetContext.capabilities,
      current.action === "target.kill" ? "target.terminate" : "session.close");
    if (!capability?.available || !(Date.parse(current.plan.expiresAt) > Date.now())) {
      setInteraction(undefined);
      toast.warning("Session action unavailable", { description: capability?.reason?.message ?? "The review expired. Review the action again." });
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setExecuting(true);
    try {
      const result = await window.sliver.executeTargetActionPlan({ token: current.plan.token });
      if (!requestCurrent(current.incarnation, current.request)) return;
      if (!result.ok || !result.value) {
        toast.danger("Target action failed", { description: result.error });
        return;
      }
      setInteraction({ ...current, result: result.value });
      const failures = result.value.outcomes.filter((outcome) => outcome.status !== "succeeded");
      if (failures.length) toast.warning("Target action needs review", { description: `${failures.length} outcome${failures.length === 1 ? "" : "s"} were not confirmed.` });
      else toast.success("Target action complete", { description: `${result.value.outcomes.length} target result recorded.` });
      await refresh(current.incarnation);
    } catch (error) {
      if (requestCurrent(current.incarnation, current.request)) toast.danger("Target action failed", { description: errorMessage(error) });
    } finally {
      if (requestCurrent(current.incarnation, current.request)) {
        busyRef.current = false; setBusy(false); setExecuting(false);
      }
    }
  }, [refresh, requestCurrent]);

  const actionsForTarget = useCallback((target: TargetRef): ApplicationContextMenuAction[] => {
    if (!selectable(snapshot, target)) return [];
    return sessionContextMenuActions({ target, activeTarget: snapshot.targetContext.activeTarget,
      capabilities: snapshot.targetContext.capabilities, disabled: !usable || busy,
      onAction: (ref, action) => {
        if (contextVersion.current === version) return runAction(ref, action, backend);
        return undefined;
      } }).map((action) => action.id === "target.interact"
        && !(target.mode === "session" ? onOpenSession : onOpenBeacon)
        ? { ...action, isDisabled: true } : action);
  }, [backend, busy, onOpenBeacon, onOpenSession, runAction, snapshot, usable, version]);

  const current = interaction && usable && interaction.incarnation === backend
    && (interaction.result || executing || (selected(snapshot, interaction.target) && selectable(snapshot, interaction.target)))
    ? interaction : undefined;
  useEffect(() => {
    if (interaction && !current) { sequence.current += 1; setInteraction(undefined); }
  }, [current, interaction]);

  const close = (): void => {
    if (busyRef.current) return;
    sequence.current += 1;
    setInteraction(undefined);
  };
  const active = snapshot.targetContext.activeTargetSummary;
  const dialogs = <>
    {current?.action === "target.rename" && active?.mode === "session" ? <RenameSessionModal
      key={`${current.incarnation}:${sessionContextTargetIdentity(current.target)}`}
      session={active} targetIdentity={`${current.incarnation}:${sessionContextTargetIdentity(current.target)}`}
      capabilities={snapshot.targetContext.capabilities} onClose={close}
      onSubmitted={(operation) => {
        if (!requestCurrent(current.incarnation, current.request) || !selected(snapshotRef.current, current.target)
          || sessionContextTargetIdentity(operation.target) !== sessionContextTargetIdentity(current.target)) return false;
        void refresh(current.incarnation);
        return true;
      }} /> : null}
    <DestructiveReviewModal plan={current?.plan} result={current?.result} isExecuting={executing}
      onConfirm={() => { if (current) void execute(current); }}
      onOpenChange={(open) => { if (!open) close(); }} />
  </>;
  return { actionsForTarget, dialogs };
}
