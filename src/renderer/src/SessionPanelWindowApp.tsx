import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

import type {
  OperationResult,
  SliverSnapshot,
  WindowLaunchContext,
} from "../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../shared/target-contracts";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { ConnectionProvider } from "./components/ConnectionProvider";
import type { SessionWorkspacePanelContext, SessionWorkspaceRoute } from "./pages/SessionWorkspacePage";
import { SessionFilesPanel, SessionRegistryPanel } from "./pages/session-workbench-panels";
import { TargetExecutionWorkbench } from "./pages/TargetExecutionWorkbench";

type SessionPanelLaunch = Extract<WindowLaunchContext, { kind: "session-panel" }>;

interface ReadySessionPanel {
  readonly route: SessionWorkspaceRoute;
  readonly session: SessionSummary;
  readonly target: TargetRef;
}

let pendingLaunchContext: Promise<OperationResult<WindowLaunchContext>> | undefined;

export function SessionPanelWindowApp(): React.JSX.Element {
  const [launchContext, setLaunchContext] = useState<SessionPanelLaunch>();
  const [snapshot, setSnapshot] = useState<SliverSnapshot>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = window.sliver.onSnapshotChanged((next) => {
      receivedEvent = true;
      if (mounted) setSnapshot(next);
    });
    void claimLaunchContext().then((result) => {
      if (!mounted) return;
      if (
        !result.ok ||
        !result.value ||
        result.value.kind !== "session-panel" ||
        !isSessionPanelKind(result.value.panel)
      ) {
        setError(result.error ?? "This window is not authorized to host a session panel");
        return;
      }
      if (
        result.value.snapshot.targetContext.activeTarget?.domainRevision !== result.value.target.domainRevision ||
        !resolveReadySessionPanel(result.value.snapshot, result.value)
      ) {
        setError("The dedicated panel context did not match its main-owned session");
        return;
      }
      setLaunchContext(result.value);
      if (!receivedEvent) setSnapshot(result.value.snapshot);
      setError(undefined);
    }).catch(() => {
      if (mounted) setError("The dedicated session panel could not be loaded");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const ready = useMemo(
    () => launchContext && snapshot ? resolveReadySessionPanel(snapshot, launchContext) : undefined,
    [launchContext, snapshot],
  );

  useEffect(() => {
    if (!ready || !launchContext) return;
    const panelName = panelTitle(launchContext.panel);
    document.title = `${panelName} — ${ready.session.name || ready.session.hostname || ready.session.id}`;
  }, [launchContext, ready]);

  let content: React.JSX.Element;
  if (error) {
    content = <PanelWindowState title="Session panel unavailable" description={error} />;
  } else if (!launchContext || !snapshot) {
    content = (
      <div className="grid h-full min-h-48 place-items-center" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>Opening session panel…</span>
        </div>
      </div>
    );
  } else if (!ready) {
    content = (
      <PanelWindowState
        title="Session no longer available"
        description="The exact session or backend connection changed. Open a new window from a live session."
      />
    );
  } else {
    const panelContext: SessionWorkspacePanelContext = {
      route: ready.route,
      session: ready.session,
      snapshot,
      onSnapshot: setSnapshot,
      onOperationSubmitted: () => false,
      isTargetTransitionPending: false,
    };
    content = launchContext.panel === "execution"
      ? <TargetExecutionWorkbench expectedTarget={ready.target} presentation="dedicated" targetIdentity={sessionRouteIdentity(ready.route)} />
      : launchContext.panel === "files"
        ? <SessionFilesPanel {...panelContext} />
        : <SessionRegistryPanel {...panelContext} />;
  }

  const panel = launchContext?.panel;
  return (
    <ConnectionProvider connection={snapshot?.connection}>
      <AuxiliaryWindowFrame ariaLabel={panel ? `Standalone ${panelTitle(panel)} window` : "Standalone session panel window"}>
        <div
          className={`h-full min-h-0 px-4 pb-4 pt-4 ${panel === "execution" ? "overflow-y-auto" : "overflow-hidden"}`}
        >
          {content}
        </div>
      </AuxiliaryWindowFrame>
    </ConnectionProvider>
  );
}

function claimLaunchContext(): Promise<OperationResult<WindowLaunchContext>> {
  pendingLaunchContext ??= window.sliver.claimSessionPanelWindow();
  return pendingLaunchContext;
}

function resolveReadySessionPanel(snapshot: SliverSnapshot, context: SessionPanelLaunch): ReadySessionPanel | undefined {
  const target = snapshot.targetContext.activeTarget;
  const summary = snapshot.targetContext.activeTargetSummary;
  const launchConnection = context.snapshot.connection;
  const connection = snapshot.connection;
  if (
    context.target.mode !== "session" ||
    target?.mode !== "session" ||
    summary?.mode !== "session" ||
    summary.liveness !== "active" ||
    summary.id !== context.target.id ||
    target.id !== context.target.id ||
    target.backendEpoch !== context.target.backendEpoch ||
    target.fingerprint !== context.target.fingerprint ||
    connection.epoch === undefined ||
    connection.epoch !== context.target.backendEpoch ||
    launchConnection.epoch !== connection.epoch ||
    (connection.incarnation ?? 0) !== (launchConnection.incarnation ?? 0) ||
    (context.panel === "registry" && !summary.os.toLocaleLowerCase().includes("windows"))
  ) return undefined;

  return {
    route: {
      sessionId: target.id,
      backendEpoch: connection.epoch,
      connectionIncarnation: connection.incarnation ?? 0,
      targetFingerprint: target.fingerprint,
    },
    session: summary,
    target,
  };
}

function sessionRouteIdentity(route: SessionWorkspaceRoute): string {
  return `${route.backendEpoch}:${route.connectionIncarnation}:session:${route.sessionId}:${route.targetFingerprint}`;
}

function panelTitle(panel: SessionPanelLaunch["panel"]): string {
  switch (panel) {
    case "execution": return "Execution";
    case "files": return "Files";
    case "registry": return "Registry";
  }
}

function isSessionPanelKind(value: unknown): value is SessionPanelLaunch["panel"] {
  return value === "execution" || value === "files" || value === "registry";
}

function PanelWindowState({ title, description }: { readonly title: string; readonly description: string }): React.JSX.Element {
  return (
    <section className="grid h-full min-h-48 place-items-center" aria-label={title}>
      <div className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </div>
    </section>
  );
}

export function resetSessionPanelWindowClaimForTest(): void {
  pendingLaunchContext = undefined;
}
