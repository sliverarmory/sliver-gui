import { useEffect, useMemo, useState } from "react";
import { Spinner } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTerminal, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";

import type {
  OperationResult,
  SliverSnapshot,
  WindowLaunchContext,
} from "../../shared/contracts";
import type { SessionSummary } from "../../shared/target-contracts";
import {
  SessionTerminalPanel,
  type SessionTerminalRoute,
} from "./pages/SessionTerminalPanel";

interface ReadySessionShellWindow {
  readonly route: SessionTerminalRoute;
  readonly session: SessionSummary;
  readonly snapshot: SliverSnapshot;
  readonly preferredResourceId?: string;
}

let pendingLaunchContext: Promise<OperationResult<WindowLaunchContext>> | undefined;

export function SessionShellWindowApp(): React.JSX.Element {
  const [launchContext, setLaunchContext] = useState<WindowLaunchContext>();
  const [snapshot, setSnapshot] = useState<SliverSnapshot>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let mounted = true;
    const unsubscribe = window.sliver.onSnapshotChanged((next) => {
      if (mounted) setSnapshot(next);
    });
    void claimLaunchContext().then((result) => {
      if (!mounted) return;
      if (!result.ok || !result.value || result.value.kind !== "session-shell") {
        setError(result.error ?? "This window is not authorized to host managed shells");
        return;
      }
      setLaunchContext(result.value);
      setSnapshot(result.value.snapshot);
      setError(undefined);
    }).catch(() => {
      if (mounted) setError("Managed shells could not be transferred to this window");
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const ready = useMemo(
    () => launchContext?.kind === "session-shell" && snapshot
      ? resolveReadySessionShellWindow(snapshot, launchContext.preferredResourceId)
      : undefined,
    [launchContext, snapshot],
  );

  if (error) return <DedicatedWindowState title="Managed shells unavailable" description={error} danger />;
  if (!launchContext || !snapshot) {
    return (
      <main className="grid min-h-screen place-items-center bg-background" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>Transferring managed shells…</span>
        </div>
      </main>
    );
  }
  if (!ready) {
    return (
      <DedicatedWindowState
        title="Session no longer available"
        description="The exact session or backend connection changed. Managed shell access was closed for this window."
        danger
      />
    );
  }

  return (
    <main className="h-screen min-h-0 overflow-hidden bg-background" aria-label="Managed shell window">
      <SessionTerminalPanel
        presentation="dedicated"
        route={ready.route}
        session={ready.session}
        {...(ready.preferredResourceId === undefined
          ? {}
          : { preferredResourceId: ready.preferredResourceId })}
      />
    </main>
  );
}

function claimLaunchContext(): Promise<OperationResult<WindowLaunchContext>> {
  pendingLaunchContext ??= window.sliver.claimSessionShellWindow();
  return pendingLaunchContext;
}

function resolveReadySessionShellWindow(
  snapshot: SliverSnapshot,
  preferredResourceId?: string,
): ReadySessionShellWindow | undefined {
  const target = snapshot.targetContext.activeTarget;
  const summary = snapshot.targetContext.activeTargetSummary;
  const backendEpoch = snapshot.connection.epoch;
  if (
    target?.mode !== "session" ||
    summary?.mode !== "session" ||
    summary.id !== target.id ||
    summary.liveness !== "active" ||
    backendEpoch === undefined ||
    target.backendEpoch !== backendEpoch
  ) return undefined;
  return {
    route: {
      sessionId: target.id,
      backendEpoch,
      connectionIncarnation: snapshot.connection.incarnation ?? 0,
      targetFingerprint: target.fingerprint,
    },
    session: summary,
    snapshot,
    ...(preferredResourceId === undefined ? {} : { preferredResourceId }),
  };
}

function DedicatedWindowState({
  title,
  description,
  danger = false,
}: {
  readonly title: string;
  readonly description: string;
  readonly danger?: boolean;
}): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8">
      <section className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12" aria-label={title}>
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <FontAwesomeIcon aria-hidden icon={danger ? faTriangleExclamation : faTerminal} />
            </EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </section>
    </main>
  );
}

export function resetSessionShellWindowClaimForTest(): void {
  pendingLaunchContext = undefined;
}
