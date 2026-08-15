import { useEffect, useState } from "react";
import { Spinner } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpRightFromSquare, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

import type {
  OperationResult,
  SliverSnapshot,
  WindowLaunchContext,
} from "../../shared/contracts";
import type { TargetRef } from "../../shared/target-contracts";
import {
  SessionWorkspacePage,
  type SessionWorkspaceRoute,
} from "./pages/SessionWorkspacePage";
import { TargetsPage } from "./pages/TargetsPage";

let pendingInteractionLaunchContext: Promise<OperationResult<WindowLaunchContext>> | undefined;

export function InteractionWindowApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SliverSnapshot>();
  const [launchTarget, setLaunchTarget] = useState<InteractionLaunchTarget>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = window.sliver.onSnapshotChanged((next) => {
      receivedEvent = true;
      if (mounted) setSnapshot(next);
    });
    void claimInteractionLaunchContext().then((result) => {
      if (!mounted) return;
      if (!result.ok || !result.value || result.value.kind !== "interaction") {
        setError(result.error ?? "This window is not authorized to host an interaction workspace");
        return;
      }
      const target = interactionLaunchTarget(result.value);
      if (!target) {
        setError("The dedicated interaction context did not match its main-owned target");
        return;
      }
      setLaunchTarget(target);
      if (!receivedEvent) setSnapshot(result.value.snapshot);
      setError(undefined);
    }).catch(() => {
      if (mounted) setError("The dedicated interaction context could not be loaded");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    const summary = snapshot?.targetContext.activeTargetSummary;
    const active = snapshot?.targetContext.activeTarget;
    if (!summary || !active || !launchTargetMatches(launchTarget, active, summary.mode, summary.id)) return;
    document.title = `Interact — ${summary.name || summary.hostname || summary.id}`;
  }, [launchTarget, snapshot?.targetContext.activeTarget, snapshot?.targetContext.activeTargetSummary]);

  let content: React.JSX.Element;
  if (error) {
    content = <InteractionWindowState title="Interaction unavailable" description={error} />;
  } else if (!snapshot) {
    content = (
      <div className="grid min-h-72 place-items-center" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>Opening interaction workspace…</span>
        </div>
      </div>
    );
  } else if (launchTarget?.mode === "session") {
    content = (
      <SessionWorkspacePage
        allowPopOut={false}
        route={launchTarget.route}
        session={snapshot.targetContext.activeTargetSummary?.mode === "session"
          ? snapshot.targetContext.activeTargetSummary
          : null}
        snapshot={snapshot}
        onSessionChange={(next, route) => {
          setSnapshot(next);
          setLaunchTarget({ mode: "session", route });
        }}
        onSnapshot={setSnapshot}
      />
    );
  } else if (launchTarget?.mode === "beacon") {
    content = (
      <TargetsPage
        expectedTarget={launchTarget.target}
        mode="beacon"
        presentation="dedicated"
        snapshot={snapshot}
        onSnapshot={setSnapshot}
      />
    );
  } else {
    content = (
      <InteractionWindowState
        title="Target no longer available"
        description="The exact session or beacon is no longer selected on this backend. Open a new interaction window from a live target."
      />
    );
  }

  return (
    <main className="app-main interaction-window" aria-label="Dedicated interaction window">
      <div className="interaction-window__content">{content}</div>
    </main>
  );
}

export function resetInteractionWindowClaimForTest(): void {
  pendingInteractionLaunchContext = undefined;
}

function claimInteractionLaunchContext(): Promise<OperationResult<WindowLaunchContext>> {
  pendingInteractionLaunchContext ??= window.sliver.claimInteractionWindow();
  return pendingInteractionLaunchContext;
}

type InteractionLaunchTarget =
  | { readonly mode: "session"; readonly route: SessionWorkspaceRoute }
  | { readonly mode: "beacon"; readonly target: TargetRef };

function interactionLaunchTarget(context: Extract<WindowLaunchContext, { kind: "interaction" }>): InteractionLaunchTarget | undefined {
  const active = context.snapshot.targetContext.activeTarget;
  const summary = context.snapshot.targetContext.activeTargetSummary;
  if (
    !active ||
    !summary ||
    active.mode !== context.target.mode ||
    active.id !== context.target.id ||
    active.backendEpoch !== context.target.backendEpoch ||
    active.fingerprint !== context.target.fingerprint ||
    summary.mode !== context.target.mode ||
    summary.id !== context.target.id
  ) return undefined;
  if (context.target.mode === "beacon") return { mode: "beacon", target: context.target };
  const route = routeFromSnapshot(context.snapshot);
  return route ? { mode: "session", route } : undefined;
}

function launchTargetMatches(
  launchTarget: InteractionLaunchTarget | undefined,
  active: TargetRef,
  summaryMode: TargetRef["mode"],
  summaryId: string,
): boolean {
  if (!launchTarget || active.mode !== summaryMode || active.id !== summaryId) return false;
  if (launchTarget.mode === "beacon") {
    return active.mode === "beacon" &&
      active.id === launchTarget.target.id &&
      active.backendEpoch === launchTarget.target.backendEpoch &&
      active.fingerprint === launchTarget.target.fingerprint;
  }
  return active.mode === "session" &&
    active.id === launchTarget.route.sessionId &&
    active.backendEpoch === launchTarget.route.backendEpoch &&
    active.fingerprint === launchTarget.route.targetFingerprint;
}

export function routeFromSnapshot(snapshot: SliverSnapshot): SessionWorkspaceRoute | undefined {
  const target = snapshot.targetContext.activeTarget;
  const summary = snapshot.targetContext.activeTargetSummary;
  const backendEpoch = snapshot.connection.epoch;
  if (
    target?.mode !== "session" ||
    summary?.mode !== "session" ||
    summary.id !== target.id ||
    backendEpoch === undefined ||
    target.backendEpoch !== backendEpoch
  ) return undefined;
  return {
    sessionId: target.id,
    backendEpoch,
    connectionIncarnation: snapshot.connection.incarnation ?? 0,
    targetFingerprint: target.fingerprint,
  };
}

function InteractionWindowState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}): React.JSX.Element {
  return (
    <section className="grid min-h-[calc(100vh-4rem)] place-items-center" aria-label={title}>
      <div className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <FontAwesomeIcon aria-hidden icon={title.includes("unavailable") ? faTriangleExclamation : faArrowUpRightFromSquare} />
            </EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </div>
    </section>
  );
}
