import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AlertDialog,
  Breadcrumbs,
  Button,
  Chip,
  Description,
  Dropdown,
  Label,
  ScrollShadow,
  Tabs,
  Tooltip,
  toast,
} from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faApple, faLinux, faWindows } from "@fortawesome/free-brands-svg-icons";
import {
  faArrowLeft,
  faArrowUpRightFromSquare,
  faChevronDown,
  faChevronRight,
  faClockRotateLeft,
  faComputer,
  faCode,
  faFolderOpen,
  faList,
  faMicrochip,
  faNetworkWired,
  faPen,
  faSkullCrossbones,
  faStop,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

import type { SessionPanelWindowKind, SliverSnapshot } from "../../../shared/contracts";
import type {
  DestructiveTargetActionId,
  SessionSummary,
  TargetActionExecutionResult,
  TargetActionPlan,
  TargetRef,
} from "../../../shared/target-contracts";
import type { TargetOperationId, TargetOperationRecord } from "../../../shared/operation-contracts";
import {
  capabilityFor,
  formatTimestamp,
  operationLabel,
  operationStateColor,
  operationStateLabel,
  targetRowKey,
  targetStatus,
} from "./target-page-model";
import {
  DestructiveReviewModal,
  OperationComposer,
  OperationDetailModal,
  openOperationDetail,
} from "./TargetsPage";
import { defaultSessionWorkspacePanels } from "./session-workbench-panels";
import { SessionTerminalPanel } from "./SessionTerminalPanel";
import { TargetExecutionWorkbench } from "./TargetExecutionWorkbench";
import { RenameSessionModal } from "../components/RenameSessionModal";

const sessionOperatingSystemIcons = new Map([
  ["windows", faWindows],
  ["linux", faLinux],
  ["darwin", faApple],
  ["macos", faApple],
]);

const OVERVIEW_OPERATION_IDS = ["target.ping"] as const satisfies readonly TargetOperationId[];
const SESSION_ACTIVITY_PAGE_SIZE = 100;

export interface SessionWorkspaceRoute {
  sessionId: string;
  backendEpoch: number;
  connectionIncarnation: number;
  targetFingerprint: string;
}

export type SessionWorkspacePanelId =
  | "overview"
  | "files"
  | "processes"
  | "network"
  | "execution"
  | "environment"
  | "terminal"
  | "activity"
  | "registry";

export interface SessionWorkspacePanelContext {
  route: SessionWorkspaceRoute;
  session: SessionSummary;
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
  onOperationSubmitted: (operation: TargetOperationRecord) => boolean;
  onPopOutPanel?: (panel: SessionPanelWindowKind) => Promise<void>;
  isTargetTransitionPending: boolean;
  onGoToProcess?: (pid: number) => void;
  processNavigation?: { pid: number; requestId: number };
}

export type SessionWorkspacePanelRenderer = (context: SessionWorkspacePanelContext) => ReactNode;

/** Renderer-only extension seam for the typed M2 adapters. The workspace owns
 * navigation and target quarantine; feature panels can consume audited APIs
 * without coupling the route shell to their transport details. */
export type SessionWorkspacePanels = Partial<Record<SessionWorkspacePanelId, SessionWorkspacePanelRenderer>>;

export interface SessionWorkspacePageProps {
  route: SessionWorkspaceRoute;
  session: SessionSummary | null;
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
  onBack?: () => void;
  onSessionChange?: (snapshot: SliverSnapshot, route: SessionWorkspaceRoute) => void;
  allowPopOut?: boolean;
  presentation?: "embedded" | "dedicated";
  panels?: SessionWorkspacePanels;
}

export function SessionWorkspacePage({
  route,
  session,
  snapshot,
  onSnapshot,
  onBack,
  onSessionChange,
  allowPopOut = true,
  presentation = "embedded",
  panels = {},
}: SessionWorkspacePageProps): React.JSX.Element {
  const routeIdentity = sessionWorkspaceRouteIdentity(route);
  const routeIdentityRef = useRef(routeIdentity);
  routeIdentityRef.current = routeIdentity;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const selectionSnapshotIdentity = sessionSelectionSnapshotIdentity(snapshot);
  const isCurrent = isAuthoritativeSessionRoute(snapshot, session, route);
  const isCurrentRef = useRef(isCurrent);
  isCurrentRef.current = isCurrent;
  const currentSession = isCurrent ? session : null;
  const [operations, setOperations] = useState<TargetOperationRecord[]>([]);
  const operationsRef = useRef<TargetOperationRecord[]>([]);
  operationsRef.current = operations;
  const [visibleOperationLimit, setVisibleOperationLimit] = useState(SESSION_ACTIVITY_PAGE_SIZE);
  const visibleOperationLimitRef = useRef(SESSION_ACTIVITY_PAGE_SIZE);
  visibleOperationLimitRef.current = visibleOperationLimit;
  const [nextOperationCursor, setNextOperationCursor] = useState<string>();
  const nextOperationCursorRef = useRef<string | undefined>(undefined);
  nextOperationCursorRef.current = nextOperationCursor;
  const [operationsError, setOperationsError] = useState<string>();
  const [isLoadingOperations, setIsLoadingOperations] = useState(false);
  const [isLoadingMoreOperations, setIsLoadingMoreOperations] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<TargetOperationRecord>();
  const [selectedOperationRouteIdentity, setSelectedOperationRouteIdentity] = useState<string>();
  const [reviewPlan, setReviewPlan] = useState<TargetActionPlan>();
  const [actionResult, setActionResult] = useState<TargetActionExecutionResult>();
  const [isPreparingAction, setIsPreparingAction] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const [terminalVisitedRouteIdentity, setTerminalVisitedRouteIdentity] = useState<string>();
  const [selectedPanel, setSelectedPanel] = useState("overview");
  const supportsRegistry = Boolean(session?.os.toLocaleLowerCase().includes("windows"));
  const visiblePanel = selectedPanel === "registry" && !supportsRegistry ? "overview" : selectedPanel;
  const [processNavigation, setProcessNavigation] = useState<{ routeIdentity: string; pid: number; requestId: number }>();
  const [renameRouteIdentity, setRenameRouteIdentity] = useState<string>();
  const [pendingSessionSwitch, setPendingSessionSwitch] = useState<PendingSessionSwitch>();
  const [isCheckingSessionShells, setIsCheckingSessionShells] = useState(false);
  const [isSwitchingSession, setIsSwitchingSession] = useState(false);
  const [isPoppingOutInteraction, setIsPoppingOutInteraction] = useState(false);
  const [isWorkspaceHeaderStuck, setIsWorkspaceHeaderStuck] = useState(false);
  const isTargetTransitionPending = isCheckingSessionShells || isSwitchingSession;
  const targetTransitionPendingRef = useRef(isTargetTransitionPending);
  targetTransitionPendingRef.current = isTargetTransitionPending;
  const workspaceScrollMarkerRef = useRef<HTMLDivElement>(null);
  const operationsRequestSequence = useRef(0);
  const operationDetailRequestSequence = useRef(0);
  const shellPreflightRequestSequence = useRef(0);
  const sessionSelectionRequestSequence = useRef(0);
  const pendingSessionSelectionRef = useRef<PendingSessionSelection | undefined>(undefined);
  const interactionWindowRequestSequence = useRef(0);

  const mergeOperation = useCallback((operation: TargetOperationRecord) => {
    if (!operationBelongsToRoute(operation, route)) return;
    const next = mergeUniqueOperations(operationsRef.current, [operation]);
    operationsRef.current = next;
    setOperations(next);
    setSelectedOperation((current) => current?.requestId === operation.requestId ? operation : current);
  }, [route.backendEpoch, route.sessionId, route.targetFingerprint]);

  const acceptSubmittedOperation = useCallback((operation: TargetOperationRecord): boolean => {
    if (
      !isCurrentRef.current ||
      isTargetTransitionPending ||
      routeIdentity !== routeIdentityRef.current ||
      !operationBelongsToRoute(operation, route)
    ) return false;
    mergeOperation(operation);
    return true;
  }, [isTargetTransitionPending, mergeOperation, route.backendEpoch, route.sessionId, route.targetFingerprint, routeIdentity]);

  const loadOperations = useCallback(async (targetVisibleLimit = SESSION_ACTIVITY_PAGE_SIZE, append = false) => {
    if (!isCurrentRef.current) return;
    const expectedRouteIdentity = routeIdentity;
    const requestSequence = ++operationsRequestSequence.current;
    if (append) setIsLoadingMoreOperations(true);
    else setIsLoadingOperations(true);
    let matching = append ? [...operationsRef.current] : [];
    let pageCursor = append ? nextOperationCursorRef.current : undefined;
    let shouldRequestFirstPage = !append;
    const visitedCursors = new Set<string>();
    const requestIsCurrent = () =>
      requestSequence === operationsRequestSequence.current &&
      expectedRouteIdentity === routeIdentityRef.current;
    const commit = (error?: string) => {
      const merged = mergeUniqueOperations(matching, operationsRef.current);
      operationsRef.current = merged;
      visibleOperationLimitRef.current = targetVisibleLimit;
      nextOperationCursorRef.current = pageCursor;
      setOperations(merged);
      setVisibleOperationLimit(targetVisibleLimit);
      setNextOperationCursor(pageCursor);
      setOperationsError(error);
    };
    try {
      // Operation history is global to the window. Keep advancing through it
      // until this session has a complete visible page plus one look-ahead row,
      // or the global history ends. The look-ahead keeps Load older precise.
      while (
        matching.length <= targetVisibleLimit &&
        (shouldRequestFirstPage || pageCursor !== undefined)
      ) {
        if (pageCursor !== undefined) {
          if (visitedCursors.has(pageCursor)) {
            commit("Session activity pagination repeated a cursor");
            return;
          }
          visitedCursors.add(pageCursor);
        }
        shouldRequestFirstPage = false;
        const result = await window.sliver.listTargetOperations({
          limit: SESSION_ACTIVITY_PAGE_SIZE,
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
        });
        if (!requestIsCurrent()) return;
        if (!result.ok || !result.value) {
          commit(result.error ?? "Session activity is unavailable");
          return;
        }
        matching = mergeUniqueOperations(
          matching,
          result.value.items.filter((operation) => operationBelongsToRoute(operation, route)),
        );
        pageCursor = result.value.page.nextCursor;
      }
      commit();
    } catch (error) {
      if (requestIsCurrent()) commit(errorMessage(error));
    } finally {
      if (
        requestSequence === operationsRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current
      ) {
        if (append) setIsLoadingMoreOperations(false);
        else setIsLoadingOperations(false);
      }
    }
  }, [route.backendEpoch, route.sessionId, route.targetFingerprint, routeIdentity]);

  useEffect(() => {
    operationsRequestSequence.current += 1;
    operationDetailRequestSequence.current += 1;
    shellPreflightRequestSequence.current += 1;
    interactionWindowRequestSequence.current += 1;
    setOperations([]);
    operationsRef.current = [];
    setVisibleOperationLimit(SESSION_ACTIVITY_PAGE_SIZE);
    visibleOperationLimitRef.current = SESSION_ACTIVITY_PAGE_SIZE;
    setNextOperationCursor(undefined);
    nextOperationCursorRef.current = undefined;
    setOperationsError(undefined);
    setSelectedOperation(undefined);
    setSelectedOperationRouteIdentity(undefined);
    setReviewPlan(undefined);
    setActionResult(undefined);
    setIsPreparingAction(false);
    setIsExecutingAction(false);
    setPendingSessionSwitch(undefined);
    setIsCheckingSessionShells(false);
    setIsPoppingOutInteraction(false);
    setRenameRouteIdentity(undefined);
    if (isCurrent) void loadOperations();
  }, [isCurrent, loadOperations, routeIdentity]);

  useEffect(() => {
    const pending = pendingSessionSelectionRef.current;
    if (
      pending &&
      pending.sourceRouteIdentity === routeIdentity &&
      sessionSelectionSnapshotAllowsCompletion(snapshotRef.current, pending)
    ) return;
    sessionSelectionRequestSequence.current += 1;
    pendingSessionSelectionRef.current = undefined;
    setIsSwitchingSession(false);
  }, [routeIdentity, selectionSnapshotIdentity]);

  useEffect(() => {
    if (!isCurrent) return;
    const subscribedIdentity = routeIdentity;
    return window.sliver.onOperationChanged((operation) => {
      if (subscribedIdentity === routeIdentityRef.current) mergeOperation(operation);
    });
  }, [isCurrent, mergeOperation, routeIdentity]);

  useEffect(() => {
    if (presentation !== "embedded" || !isCurrent) {
      setIsWorkspaceHeaderStuck(false);
      return;
    }
    const marker = workspaceScrollMarkerRef.current;
    const viewport = marker?.closest(".app-content");
    if (!marker || !viewport) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry) {
        setIsWorkspaceHeaderStuck(entry.boundingClientRect.top < (entry.rootBounds?.top ?? 0));
      }
    }, { root: viewport, threshold: [0, 1] });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [isCurrent, presentation, routeIdentity]);

  const prepareAction = useCallback(async (actionId: DestructiveTargetActionId) => {
    if (!isCurrentRef.current) return;
    const expectedRouteIdentity = routeIdentity;
    setIsPreparingAction(true);
    setActionResult(undefined);
    try {
      const result = await window.sliver.prepareTargetAction({ actionId });
      if (expectedRouteIdentity !== routeIdentityRef.current) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not review action", { description: result.error });
        return;
      }
      setReviewPlan(result.value);
    } catch (error) {
      if (expectedRouteIdentity === routeIdentityRef.current) {
        toast.danger("Could not review action", { description: errorMessage(error) });
      }
    } finally {
      if (expectedRouteIdentity === routeIdentityRef.current) setIsPreparingAction(false);
    }
  }, [routeIdentity]);

  const executeAction = useCallback(async () => {
    if (!reviewPlan || !isCurrentRef.current) return;
    const expectedRouteIdentity = routeIdentity;
    setIsExecutingAction(true);
    try {
      const result = await window.sliver.executeTargetActionPlan({ token: reviewPlan.token });
      if (expectedRouteIdentity !== routeIdentityRef.current) return;
      if (!result.ok || !result.value) {
        toast.danger("Target action failed", { description: result.error });
        return;
      }
      setActionResult(result.value);
      const failures = result.value.outcomes.filter((outcome) => outcome.status !== "succeeded");
      if (failures.length === 0) {
        toast.success("Target action complete", {
          description: `${result.value.outcomes.length} target result recorded.`,
        });
      } else {
        toast.warning("Target action needs review", {
          description: `${failures.length} outcome${failures.length === 1 ? "" : "s"} were not confirmed.`,
        });
      }
      const refreshed = await window.sliver.refresh();
      if (
        expectedRouteIdentity === routeIdentityRef.current &&
        refreshed.ok &&
        refreshed.value
      ) onSnapshot(refreshed.value);
    } catch (error) {
      if (expectedRouteIdentity === routeIdentityRef.current) {
        toast.danger("Target action failed", { description: errorMessage(error) });
      }
    } finally {
      if (expectedRouteIdentity === routeIdentityRef.current) setIsExecutingAction(false);
    }
  }, [onSnapshot, reviewPlan, routeIdentity]);

  const popOutManagedShells = useCallback(async (preferredResourceId?: string): Promise<void> => {
    if (!isCurrentRef.current) throw new Error("The active session changed before managed shells could be popped out");
    const result = await window.sliver.openSessionShellWindow(
      preferredResourceId === undefined ? {} : { preferredResourceId },
    );
    if (!result.ok) throw new Error(result.error ?? "Managed shells could not be popped out");
  }, []);

  const sessionMenu = useMemo(
    () => buildSessionMenu(snapshot),
    [snapshot],
  );

  const selectSession = useCallback(async (option: SessionSwitchOption): Promise<void> => {
    if (!isCurrentRef.current || !onSessionChange || option.ref.id === route.sessionId) return;
    const sourceRef = snapshotRef.current.targetContext.activeTarget;
    if (!sourceRef || !targetRefMatchesSessionRoute(sourceRef, route)) return;
    const expectedRouteIdentity = routeIdentity;
    const requestSequence = ++sessionSelectionRequestSequence.current;
    const pendingSelection: PendingSessionSelection = {
      requestSequence,
      requestedRef: option.ref,
      sourceRef,
      sourceRoute: route,
      sourceRouteIdentity: expectedRouteIdentity,
    };
    pendingSessionSelectionRef.current = pendingSelection;
    const requestCanCommit = (): boolean => {
      const pending = pendingSessionSelectionRef.current;
      return requestSequence === sessionSelectionRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current &&
        pending?.requestSequence === requestSequence &&
        pending.sourceRouteIdentity === expectedRouteIdentity &&
        sessionSelectionSnapshotAllowsCompletion(snapshotRef.current, pending);
    };
    setIsSwitchingSession(true);
    try {
      const result = await window.sliver.selectTarget(option.ref);
      if (!requestCanCommit()) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not switch session", { description: result.error });
        return;
      }
      const nextRoute = routeFromExactSessionSelection(result.value, option.ref);
      if (!nextRoute) {
        onSnapshot(result.value);
        toast.warning("Session changed", {
          description: "The main process did not confirm the exact selected session. Return to the live inventory and select it again.",
        });
        return;
      }
      onSessionChange(result.value, nextRoute);
    } catch (error) {
      if (requestCanCommit()) {
        toast.danger("Could not switch session", { description: errorMessage(error) });
      }
    } finally {
      if (pendingSessionSelectionRef.current?.requestSequence === requestSequence) {
        pendingSessionSelectionRef.current = undefined;
      }
      if (
        requestSequence === sessionSelectionRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current
      ) setIsSwitchingSession(false);
    }
  }, [onSessionChange, onSnapshot, route.sessionId, routeIdentity]);

  const requestSessionSwitch = useCallback(async (option: SessionSwitchOption): Promise<void> => {
    if (!isCurrentRef.current || !onSessionChange || option.ref.id === route.sessionId) return;
    const expectedRouteIdentity = routeIdentity;
    const requestSequence = ++shellPreflightRequestSequence.current;
    setIsCheckingSessionShells(true);
    try {
      const result = await window.sliver.listSessionShells({});
      if (
        requestSequence !== shellPreflightRequestSequence.current ||
        expectedRouteIdentity !== routeIdentityRef.current ||
        !isCurrentRef.current
      ) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not inspect managed shells", {
          description: result.error ?? "The session was not changed because open shell state could not be confirmed.",
        });
        return;
      }
      if (result.value.resources.length > 0) {
        setPendingSessionSwitch({ option, shellCount: result.value.resources.length });
        return;
      }
      await selectSession(option);
    } catch (error) {
      if (
        requestSequence === shellPreflightRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current &&
        isCurrentRef.current
      ) {
        toast.danger("Could not inspect managed shells", {
          description: `${errorMessage(error)} The session was not changed.`,
        });
      }
    } finally {
      if (
        requestSequence === shellPreflightRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current
      ) setIsCheckingSessionShells(false);
    }
  }, [onSessionChange, route.sessionId, routeIdentity, selectSession]);

  const popOutInteraction = useCallback(async (): Promise<void> => {
    if (!isCurrentRef.current || !allowPopOut) return;
    const expectedRouteIdentity = routeIdentity;
    const requestSequence = ++interactionWindowRequestSequence.current;
    setIsPoppingOutInteraction(true);
    try {
      const result = await window.sliver.openInteractionWindow();
      if (
        requestSequence !== interactionWindowRequestSequence.current ||
        expectedRouteIdentity !== routeIdentityRef.current ||
        !isCurrentRef.current
      ) return;
      if (!result.ok) {
        toast.danger("Could not pop out interaction", { description: result.error });
      }
    } catch (error) {
      if (
        requestSequence === interactionWindowRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current &&
        isCurrentRef.current
      ) toast.danger("Could not pop out interaction", { description: errorMessage(error) });
    } finally {
      if (
        requestSequence === interactionWindowRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current
      ) setIsPoppingOutInteraction(false);
    }
  }, [allowPopOut, routeIdentity]);

  const popOutSessionPanel = useCallback(async (panel: SessionPanelWindowKind): Promise<void> => {
    if (
      !isCurrentRef.current || targetTransitionPendingRef.current ||
      routeIdentity !== routeIdentityRef.current
    ) throw new Error("The active session changed before the panel could be popped out");
    const result = await window.sliver.openSessionPanelWindow({ panel });
    if (!result.ok) throw new Error(result.error ?? "The session panel could not be opened");
  }, [routeIdentity]);

  const goToProcess = useCallback((pid: number) => {
    if (
      !isCurrentRef.current ||
      targetTransitionPendingRef.current ||
      routeIdentity !== routeIdentityRef.current ||
      !Number.isSafeInteger(pid) || pid < 0
    ) return;
    setProcessNavigation((current) => ({ routeIdentity, pid, requestId: (current?.requestId ?? 0) + 1 }));
    setSelectedPanel("processes");
  }, [routeIdentity]);

  useEffect(() => {
    if (!supportsRegistry && selectedPanel === "registry") setSelectedPanel("overview");
  }, [selectedPanel, supportsRegistry]);

  if (!currentSession) {
    return (
      <section className="page-stack" aria-labelledby="session-workspace-unavailable-heading">
        <WorkspaceTrail sessionName={route.sessionId} onBack={onBack} />
        <div className="rounded-2xl bg-surface px-6 py-12">
          <EmptyState>
            <EmptyState.Header>
              <EmptyState.Media variant="icon">
                <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
              </EmptyState.Media>
              <EmptyState.Title id="session-workspace-unavailable-heading">Session workspace unavailable</EmptyState.Title>
              <EmptyState.Description className="max-w-md text-pretty">
                This route no longer matches the main process&apos;s active session or connection. Return to the live inventory and select it again.
              </EmptyState.Description>
            </EmptyState.Header>
            {onBack ? (
              <EmptyState.Content>
                <Button variant="outline" onPress={onBack}>Back to sessions</Button>
              </EmptyState.Content>
            ) : null}
          </EmptyState>
        </div>
      </section>
    );
  }

  const status = targetStatus(currentSession);
  const context: SessionWorkspacePanelContext = {
    route,
    session: currentSession,
    snapshot,
    onSnapshot,
    onOperationSubmitted: acceptSubmittedOperation,
    onPopOutPanel: popOutSessionPanel,
    isTargetTransitionPending,
    onGoToProcess: goToProcess,
    ...(processNavigation?.routeIdentity === routeIdentity ? {
      processNavigation: { pid: processNavigation.pid, requestId: processNavigation.requestId },
    } : {}),
  };
  const resolvedPanels = { ...defaultSessionWorkspacePanels, ...panels };
  const isWindows = currentSession.os.toLocaleLowerCase().includes("windows");
  const activeSessionRef = snapshot.targetContext.activeTarget?.mode === "session"
    ? snapshot.targetContext.activeTarget
    : undefined;
  const terminate = capabilityFor(snapshot.targetContext.capabilities, "target.terminate");
  const close = capabilityFor(snapshot.targetContext.capabilities, "session.close");

  return (
    <section
      aria-busy={isTargetTransitionPending || undefined}
      aria-labelledby="session-workspace-heading"
      className="page-stack session-workspace"
      data-presentation={presentation}
      data-selected-panel={visiblePanel}
      inert={isTargetTransitionPending ? true : undefined}
    >
      <div className="session-workspace__trail-frame">
        <WorkspaceTrail
          currentSessionId={route.sessionId}
          isSessionMenuBusy={isTargetTransitionPending}
          isPoppingOutInteraction={isPoppingOutInteraction}
          sessionMenu={sessionMenu}
          sessionName={currentSession.name || currentSession.hostname || currentSession.id}
          onBack={onBack}
          onPopOutInteraction={allowPopOut ? () => void popOutInteraction() : undefined}
          onSelectSession={onSessionChange ? (option) => void requestSessionSwitch(option) : undefined}
        />
      </div>

      {renameRouteIdentity === routeIdentity ? (
        <RenameSessionModal
          key={routeIdentity}
          capabilities={snapshot.targetContext.capabilities}
          session={currentSession}
          targetIdentity={routeIdentity}
          onClose={() => setRenameRouteIdentity(undefined)}
          onSubmitted={acceptSubmittedOperation}
        />
      ) : null}

      <Tabs
        className="session-workspace__tabs"
        selectedKey={visiblePanel}
        variant="secondary"
        onSelectionChange={(key) => {
          setSelectedPanel(String(key));
          if (String(key) !== "processes") setProcessNavigation(undefined);
          if (String(key) === "terminal") setTerminalVisitedRouteIdentity(routeIdentity);
        }}
      >
        <div aria-hidden="true" className="session-workspace__scroll-marker" ref={workspaceScrollMarkerRef} />
        <div
          className="session-workspace__sticky"
          data-stuck={isWorkspaceHeaderStuck}
        >
          <div className="session-workspace__summary-frame">
            <header className="session-workspace__summary flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-2xl bg-surface px-4 py-3">
              <div className="flex min-w-0 flex-1 basis-80 items-center gap-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-default text-muted">
                  <FontAwesomeIcon aria-hidden icon={sessionOperatingSystemIcons.get(currentSession.os.trim().toLowerCase()) ?? faComputer} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <h1 className="truncate text-base font-semibold text-foreground" id="session-workspace-heading" title={currentSession.name || currentSession.hostname || "Unnamed session"}>
                      {currentSession.name || currentSession.hostname || "Unnamed session"}
                    </h1>
                    <Chip className="shrink-0" color={status.color} size="sm" variant="soft">{status.label}</Chip>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <p className="min-w-0 truncate" title={`${currentSession.username || "Unknown user"} on ${currentSession.hostname || "unknown host"}`}>
                      {currentSession.username || "Unknown user"} on {currentSession.hostname || "unknown host"}
                    </p>
                    <p className="min-w-0 truncate font-mono text-[11px]" title={currentSession.id}>{currentSession.id}</p>
                  </div>
                </div>
              </div>
              <dl className="flex max-w-full flex-wrap items-center gap-x-5 gap-y-2">
                <CompactDetail label="Platform" value={`${currentSession.os || "unknown"}/${currentSession.arch || "unknown"}`} mono />
                <CompactDetail label="Process" value={currentSession.pid === undefined ? "Not reported" : String(currentSession.pid)} mono />
                <CompactDetail label="Last check-in" value={formatTimestamp(currentSession.lastCheckinAt)} />
              </dl>
              <Dropdown>
                <Tooltip delay={250}>
                  <Button aria-label="Session actions" className="shrink-0" isIconOnly size="sm" variant="ghost">
                    <FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} />
                  </Button>
                  <Tooltip.Content>Session actions</Tooltip.Content>
                </Tooltip>
                <Dropdown.Popover placement="bottom end">
                  <Dropdown.Menu aria-label="Session actions" onAction={(key) => {
                    if (key === "rename") setRenameRouteIdentity(routeIdentity);
                    if (key === "target.kill" || key === "session.close") void prepareAction(key);
                  }}>
                    <Dropdown.Item
                      id="rename"
                      isDisabled={!capabilityFor(snapshot.targetContext.capabilities, "target.rename")?.available}
                      textValue="Rename"
                    >
                      <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faPen} />
                      <Label>Rename</Label>
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="session.close"
                      isDisabled={isPreparingAction || isExecutingAction || close?.available !== true}
                      textValue="Close Session"
                      variant="danger"
                    >
                      <FontAwesomeIcon aria-hidden className="size-3.5 text-danger" icon={faStop} />
                      <Label>Close Session</Label>
                    </Dropdown.Item>
                    <Dropdown.Item
                      id="target.kill"
                      isDisabled={isPreparingAction || isExecutingAction || terminate?.available !== true}
                      textValue="Kill Session"
                      variant="danger"
                    >
                      <FontAwesomeIcon aria-hidden className="size-3.5 text-danger" icon={faSkullCrossbones} />
                      <Label>Kill Session</Label>
                    </Dropdown.Item>
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
            </header>
          </div>
          <div className="session-workspace__tabs-frame tabs--secondary" data-orientation="horizontal">
            <Tabs.ListContainer>
              <Tabs.List aria-label="Session interaction sections">
                <WorkspaceTab id="overview" label="Overview" />
                <WorkspaceTab id="execution" label="Execution" />
                <WorkspaceTab id="files" label="Files" />
                <WorkspaceTab id="processes" label="Processes" />
                <WorkspaceTab id="network" label="Network" />
                <WorkspaceTab id="environment" label="Environment" />
                {isWindows ? <WorkspaceTab id="registry" label="Registry" /> : null}
                <WorkspaceTab id="terminal" label="Shell" />
                <WorkspaceTab id="activity" label="Activity" />
              </Tabs.List>
            </Tabs.ListContainer>
          </div>
        </div>

        <WorkspacePanelViewport presentation={presentation} scrollKey={`${routeIdentity}:${visiblePanel}`}>
          <Tabs.Panel className="pt-6" id="overview">
            {renderPanel(resolvedPanels.overview, context, {
              icon: faComputer,
              title: "Session overview unavailable",
              description: "Identity and screenshot details are not available for this workspace adapter.",
            })}
            <section className="mt-6 rounded-2xl bg-surface p-5 sm:p-6" aria-label="Quick actions">
              <OperationComposer
                key={`${routeIdentity}:overview`}
                active={currentSession}
                capabilities={snapshot.targetContext.capabilities}
                operationIds={OVERVIEW_OPERATION_IDS}
                targetIdentity={routeIdentity}
                onSubmitted={acceptSubmittedOperation}
              />
            </section>
          </Tabs.Panel>

          <Tabs.Panel className="pt-6" id="execution">
            {resolvedPanels.execution
              ? resolvedPanels.execution(context)
              : activeSessionRef
                ? <TargetExecutionWorkbench
                    expectedTarget={activeSessionRef}
                    targetIdentity={routeIdentity}
                    onPopOut={() => popOutSessionPanel("execution")}
                  />
                : renderPanel(undefined, context, {
                    icon: faTriangleExclamation,
                    title: "Execution workbench unavailable",
                    description: "The exact main-issued target reference is no longer available.",
                  })}
          </Tabs.Panel>
          <Tabs.Panel className="session-workspace__files-panel pt-6" id="files">
            {renderPanel(resolvedPanels.files, context, {
              icon: faFolderOpen,
              title: "No file inventory loaded",
              description: "Browse a directory to inspect bounded remote filesystem results for this session.",
            })}
          </Tabs.Panel>
          <Tabs.Panel className="session-workspace__processes-panel pt-6" id="processes">
            {renderPanel(resolvedPanels.processes, context, {
              icon: faMicrochip,
              title: "No process inventory loaded",
              description: "Process details and filters will appear here after the session returns an inventory.",
            })}
          </Tabs.Panel>
          <Tabs.Panel className="pt-6" id="network">
            {renderPanel(resolvedPanels.network, context, {
              icon: faNetworkWired,
              title: "No network inventory loaded",
              description: "Network interfaces and current connections will appear here when requested.",
            })}
          </Tabs.Panel>
          <Tabs.Panel className="pt-6" id="environment">
            {renderPanel(resolvedPanels.environment, context, {
              icon: faCode,
              title: "No environment inventory loaded",
              description: "Environment names and protected values will appear here when requested.",
            })}
          </Tabs.Panel>
          {isWindows ? (
            <Tabs.Panel className="session-workspace__registry-panel pt-6" id="registry">
              {renderPanel(resolvedPanels.registry, context, {
                icon: faList,
                title: "No registry location loaded",
                description: "Choose a hive and path to inspect Windows registry values for this session.",
              })}
            </Tabs.Panel>
          ) : null}
          <Tabs.Panel
            shouldForceMount
            className="session-workspace__terminal-panel pt-6 data-[inert=true]:hidden"
            id="terminal"
          >
            {terminalVisitedRouteIdentity === routeIdentity
              ? resolvedPanels.terminal
                ? resolvedPanels.terminal(context)
                : (
                    <SessionTerminalPanel
                      route={route}
                      session={currentSession}
                      onPopOut={popOutManagedShells}
                    />
                  )
              : null}
          </Tabs.Panel>
          <Tabs.Panel className="pt-6" id="activity">
            <SessionActivity
              error={operationsError}
              hasMore={operations.length > visibleOperationLimit || nextOperationCursor !== undefined}
              isLoading={isLoadingOperations}
              isLoadingMore={isLoadingMoreOperations}
              operations={operations.slice(0, visibleOperationLimit)}
              onLoadMore={() => void loadOperations(
                visibleOperationLimitRef.current + (operationsError ? 0 : SESSION_ACTIVITY_PAGE_SIZE),
                true,
              )}
              onOpen={(operation) => {
                const expectedRouteIdentity = routeIdentity;
                const requestSequence = ++operationDetailRequestSequence.current;
                void openOperationDetail(
                  operation,
                  (detail) => {
                    setSelectedOperationRouteIdentity(expectedRouteIdentity);
                    setSelectedOperation(detail);
                  },
                  () => expectedRouteIdentity === routeIdentityRef.current &&
                    requestSequence === operationDetailRequestSequence.current,
                );
              }}
            />
            {resolvedPanels.activity ? <div className="mt-6">{resolvedPanels.activity(context)}</div> : null}
          </Tabs.Panel>
        </WorkspacePanelViewport>
      </Tabs>

      <OperationDetailModal
        isCurrent={() => selectedOperationRouteIdentity === routeIdentityRef.current}
        operation={selectedOperation}
        onChanged={mergeOperation}
        onOpenChange={(open) => {
          if (!open) {
            operationDetailRequestSequence.current += 1;
            setSelectedOperation(undefined);
            setSelectedOperationRouteIdentity(undefined);
          }
        }}
      />
      <DestructiveReviewModal
        isExecuting={isExecutingAction}
        plan={reviewPlan}
        result={actionResult}
        onConfirm={() => void executeAction()}
        onOpenChange={(open) => {
          if (!open && !isExecutingAction) {
            setReviewPlan(undefined);
            setActionResult(undefined);
          }
        }}
      />
      <SessionSwitchDialog
        isSwitching={isSwitchingSession}
        pending={pendingSessionSwitch}
        onCancel={() => {
          if (!isSwitchingSession) setPendingSessionSwitch(undefined);
        }}
        onConfirm={() => {
          const pending = pendingSessionSwitch;
          if (!pending || isSwitchingSession) return;
          setPendingSessionSwitch(undefined);
          void selectSession(pending.option);
        }}
      />
    </section>
  );
}

function WorkspacePanelViewport({ children, presentation, scrollKey }: {
  children: ReactNode;
  presentation: "embedded" | "dedicated";
  scrollKey: string;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // HeroUI observes the viewport; panel changes can resize only its contents.
    const observer = new ResizeObserver(() => viewport.dispatchEvent(new Event("scroll")));
    observer.observe(content);
    return () => observer.disconnect();
  }, [presentation]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
  }, [presentation, scrollKey]);

  if (presentation === "embedded") {
    return <div className="session-workspace__panel-content">{children}</div>;
  }
  return (
    <ScrollShadow
      ref={viewportRef}
      aria-label="Session interaction content"
      className="session-workspace__viewport min-h-0 flex-1 overflow-y-auto overscroll-contain"
      hideScrollBar={false}
      role="region"
      size={32}
      tabIndex={0}
    >
      <div ref={contentRef} className="session-workspace__viewport-content flow-root pb-[10px]">{children}</div>
    </ScrollShadow>
  );
}

interface SessionSwitchOption {
  readonly summary: SessionSummary;
  readonly ref: TargetRef;
}

interface SessionMenuModel {
  readonly options: readonly SessionSwitchOption[];
  readonly isTruncated: boolean;
  readonly total: number;
}

interface PendingSessionSwitch {
  readonly option: SessionSwitchOption;
  readonly shellCount: number;
}

interface PendingSessionSelection {
  readonly requestSequence: number;
  readonly requestedRef: TargetRef;
  readonly sourceRef: TargetRef;
  readonly sourceRoute: SessionWorkspaceRoute;
  readonly sourceRouteIdentity: string;
}

function WorkspaceTrail({
  currentSessionId,
  isPoppingOutInteraction = false,
  isSessionMenuBusy = false,
  sessionMenu,
  sessionName,
  onBack,
  onPopOutInteraction,
  onSelectSession,
}: {
  currentSessionId?: string;
  isPoppingOutInteraction?: boolean;
  isSessionMenuBusy?: boolean;
  sessionMenu?: SessionMenuModel;
  sessionName: string;
  onBack?: (() => void) | undefined;
  onPopOutInteraction?: (() => void) | undefined;
  onSelectSession?: ((option: SessionSwitchOption) => void) | undefined;
}): React.JSX.Element {
  const optionByKey = new Map(
    sessionMenu?.options.map((option) => [sessionMenuItemKey(option.ref.id), option]) ?? [],
  );
  const currentKey = currentSessionId ? sessionMenuItemKey(currentSessionId) : undefined;
  const hasSessionMenu = Boolean(sessionMenu && onSelectSession);
  const viewAllDescription = sessionMenu
    ? `Showing ${sessionMenu.options.length} of ${sessionMenu.total} available sessions`
    : undefined;

  return (
    <div className="flex min-w-0 items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {onBack ? (
          <Tooltip delay={250}>
            <Button aria-label="Back to live sessions" isIconOnly size="sm" variant="ghost" onPress={onBack}>
              <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
            </Button>
            <Tooltip.Content>Back to live sessions</Tooltip.Content>
          </Tooltip>
        ) : null}
        <nav aria-label="Session workspace breadcrumbs" className="min-w-0">
          <Breadcrumbs aria-label="Breadcrumb items" className="min-w-0">
            {hasSessionMenu && sessionMenu ? (
              <Breadcrumbs.Item>
                {() => (
                  <>
                    <Dropdown>
                      <Button
                        aria-label="Sessions, switch session"
                        className="-mx-2 px-2 text-muted"
                        isPending={isSessionMenuBusy}
                        size="sm"
                        variant="ghost"
                      >
                        Sessions
                        <FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} />
                      </Button>
                      <Dropdown.Popover className="max-h-96 min-w-80" placement="bottom start">
                        <Dropdown.Menu
                          aria-label="Switch session"
                          selectionMode="single"
                          {...(currentKey ? { selectedKeys: new Set([currentKey]) } : {})}
                          onAction={(key) => {
                            const option = optionByKey.get(String(key));
                            if (option) onSelectSession?.(option);
                          }}
                        >
                          {sessionMenu.options.map((option) => {
                            const name = sessionDisplayName(option.summary);
                            const status = targetStatus(option.summary);
                            const isCurrent = option.ref.id === currentSessionId;
                            return (
                              <Dropdown.Item
                                id={sessionMenuItemKey(option.ref.id)}
                                key={sessionMenuItemKey(option.ref.id)}
                                textValue={`${name}, ${option.summary.hostname || "unknown host"}, ${status.label}`}
                              >
                                <Dropdown.ItemIndicator className="shrink-0 text-accent" />
                                <div className="min-w-0">
                                  <Label className="block truncate">{name}{isCurrent ? " — Current" : ""}</Label>
                                  <Description className="block truncate">
                                    {option.summary.username || "Unknown user"} · {option.summary.hostname || "unknown host"} · {status.label}
                                  </Description>
                                </div>
                              </Dropdown.Item>
                            );
                          })}
                        </Dropdown.Menu>
                        {sessionMenu.isTruncated ? (
                          onBack ? (
                            <Button
                              className="w-full justify-start rounded-none border-t border-separator px-3 py-2 text-start"
                              size="sm"
                              variant="ghost"
                              onPress={onBack}
                            >
                              <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-muted" icon={faList} />
                              <span className="min-w-0">
                                <span className="block text-sm font-medium">View all sessions</span>
                                <span className="block truncate text-xs font-normal text-muted">{viewAllDescription}</span>
                              </span>
                            </Button>
                          ) : (
                            <p className="border-t border-separator px-3 py-2 text-xs text-muted">
                              {viewAllDescription}. Additional sessions are available in the main window.
                            </p>
                          )
                        ) : null}
                      </Dropdown.Popover>
                    </Dropdown>
                    <FontAwesomeIcon
                      aria-hidden
                      className="mx-1 size-3 shrink-0 text-muted"
                      data-slot="breadcrumbs-separator"
                      icon={faChevronRight}
                    />
                  </>
                )}
              </Breadcrumbs.Item>
            ) : (
              <Breadcrumbs.Item className="no-underline">Sessions</Breadcrumbs.Item>
            )}
            <Breadcrumbs.Item className="max-w-72 truncate no-underline">{sessionName}</Breadcrumbs.Item>
          </Breadcrumbs>
        </nav>
      </div>
      {onPopOutInteraction ? (
        <Tooltip delay={250}>
          <Button
            aria-label="Pop out interaction"
            isIconOnly
            isPending={isPoppingOutInteraction}
            size="sm"
            variant="ghost"
            onPress={onPopOutInteraction}
          >
            <FontAwesomeIcon aria-hidden icon={faArrowUpRightFromSquare} />
          </Button>
          <Tooltip.Content>Pop out interaction into a new window</Tooltip.Content>
        </Tooltip>
      ) : null}
    </div>
  );
}

function SessionSwitchDialog({
  isSwitching,
  pending,
  onCancel,
  onConfirm,
}: {
  isSwitching: boolean;
  pending: PendingSessionSwitch | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const shellCount = pending?.shellCount ?? 0;
  return (
    <AlertDialog.Backdrop
      isOpen={pending !== undefined}
      onOpenChange={(open) => {
        if (!open && !isSwitching) onCancel();
      }}
      variant="blur"
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[440px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning">
              <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
            </AlertDialog.Icon>
            <AlertDialog.Heading>Switch sessions and close managed shells?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="text-sm leading-relaxed text-muted">
              Switching to <strong className="text-foreground">{pending ? sessionDisplayName(pending.option.summary) : "this session"}</strong> closes {shellCount} managed shell {shellCount === 1 ? "stream" : "streams"} owned by this window as the target changes. Detached scrollback cannot be recovered, and remote process termination is not confirmed. Cancel and use <strong className="text-foreground">Pop out managed shells</strong> from the Shell tab first if you want to keep those shells open in their own window.
            </p>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isSwitching} size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
            <Button isPending={isSwitching} size="sm" variant="danger" onPress={onConfirm}>
              Close {shellCount === 1 ? "shell" : "shells"} and switch
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function WorkspaceTab({ id, label }: { id: SessionWorkspacePanelId; label: string }): React.JSX.Element {
  return (
    <Tabs.Tab id={id}>
      {label}
      <Tabs.Indicator />
    </Tabs.Tab>
  );
}

function SessionActivity({
  operations,
  error,
  hasMore,
  isLoading,
  isLoadingMore,
  onLoadMore,
  onOpen,
}: {
  operations: TargetOperationRecord[];
  error: string | undefined;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onOpen: (operation: TargetOperationRecord) => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<TargetOperationRecord>[]>(() => [
    {
      id: "operation",
      header: "Operation",
      isRowHeader: true,
      minWidth: 220,
      cell: (operation) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{operationLabel(operation.operationId)}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{operation.requestId}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      accessorKey: "state",
      minWidth: 150,
      cell: (operation) => (
        <Chip color={operationStateColor(operation.state)} size="sm" variant="soft">
          {operationStateLabel(operation.state)}
        </Chip>
      ),
    },
    {
      id: "origin",
      header: "Origin",
      minWidth: 130,
      cell: (operation) => <span className="text-xs text-muted">{operation.ownership.origin === "local" ? "This window" : "External"}</span>,
    },
    {
      id: "updated",
      header: "Updated",
      accessorKey: "updatedAt",
      allowsSorting: true,
      minWidth: 200,
      cell: (operation) => <span className="text-xs tabular-nums text-muted">{formatTimestamp(operation.updatedAt)}</span>,
    },
  ], []);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl bg-surface" aria-labelledby="m1-operations-heading">
      <div className="flex items-center gap-4 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground" id="m1-operations-heading">Activity</h2>
            <p className="text-xs text-muted">M1 and session workbench activity for this exact session.</p>
          </div>
        </div>
      </div>
      {error ? <p className="bg-danger-soft px-5 py-3 text-xs text-danger-soft-foreground sm:px-6" role="alert">{error}</p> : null}
      <DataGrid
        aria-label="Session activity"
        columns={columns}
        contentClassName="min-w-[720px]"
        data={operations}
        defaultSortDescriptor={{ column: "updated", direction: "descending" }}
        getRowId={(operation) => operation.requestId}
        variant="secondary"
        onRowAction={(key) => {
          const operation = operations.find((candidate) => candidate.requestId === String(key));
          if (operation) onOpen(operation);
        }}
        renderEmptyState={() => (
          <EmptyState className="min-h-64 px-6 py-12" size="sm">
            <EmptyState.Header>
              <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></EmptyState.Media>
              <EmptyState.Title>{isLoading ? "Loading activity" : "No session activity"}</EmptyState.Title>
              <EmptyState.Description>
                {isLoading ? "Reading the bounded operation history…" : "M1 and workbench operations for this session will appear here."}
              </EmptyState.Description>
            </EmptyState.Header>
          </EmptyState>
        )}
      />
      <div className="flex min-h-12 items-center justify-between gap-3 px-5 py-2.5 sm:px-6">
        <p className="text-xs tabular-nums text-muted">{operations.length} matching operations loaded</p>
        {hasMore ? (
          <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={onLoadMore}>
            Load older activity
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function renderPanel(
  renderer: SessionWorkspacePanelRenderer | undefined,
  context: SessionWorkspacePanelContext,
  fallback: { icon: typeof faFolderOpen; title: string; description: string },
): ReactNode {
  if (renderer) return renderer(context);
  return (
    <section className="rounded-2xl bg-surface px-6 py-12">
      <EmptyState>
        <EmptyState.Header>
          <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={fallback.icon} /></EmptyState.Media>
          <EmptyState.Title>{fallback.title}</EmptyState.Title>
          <EmptyState.Description className="max-w-md text-pretty">{fallback.description}</EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    </section>
  );
}

function CompactDetail({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`mt-0.5 truncate text-xs text-foreground ${mono ? "font-mono tabular-nums" : ""}`}>{value}</dd>
    </div>
  );
}

export function isAuthoritativeSessionRoute(
  snapshot: SliverSnapshot,
  session: SessionSummary | null,
  route: SessionWorkspaceRoute,
): session is SessionSummary {
  const activeRef = snapshot.targetContext.activeTarget;
  const activeSummary = snapshot.targetContext.activeTargetSummary;
  return Boolean(
    session &&
    snapshot.connection.epoch === route.backendEpoch &&
    (snapshot.connection.incarnation ?? 0) === route.connectionIncarnation &&
    activeRef?.mode === "session" &&
    activeRef.id === route.sessionId &&
    activeRef.backendEpoch === route.backendEpoch &&
    activeRef.fingerprint === route.targetFingerprint &&
    activeSummary?.mode === "session" &&
    activeSummary.id === route.sessionId &&
    session.id === activeSummary.id,
  );
}

export function sessionWorkspaceRouteIdentity(route: SessionWorkspaceRoute): string {
  return `${route.backendEpoch}:${route.connectionIncarnation}:session:${route.sessionId}:${route.targetFingerprint}`;
}

function buildSessionMenu(snapshot: SliverSnapshot): SessionMenuModel {
  const backendEpoch = snapshot.connection.epoch;
  const refs = new Map<string, TargetRef>();
  for (const ref of snapshot.targetContext.selectableTargets) {
    if (ref.mode === "session" && ref.backendEpoch === backendEpoch) refs.set(targetRowKey(ref), ref);
  }
  const activeRef = snapshot.targetContext.activeTarget;
  if (activeRef?.mode === "session" && activeRef.backendEpoch === backendEpoch) {
    refs.set(targetRowKey(activeRef), activeRef);
  }

  const summaries = new Map<string, SessionSummary>();
  for (const summary of [...snapshot.sessions, ...snapshot.domains.sessions.items]) {
    summaries.set(targetRowKey(summary), summary);
  }
  const activeSummary = snapshot.targetContext.activeTargetSummary;
  if (activeSummary?.mode === "session") summaries.set(targetRowKey(activeSummary), activeSummary);

  const allOptions: SessionSwitchOption[] = [];
  let hasUnpairedSummary = false;
  for (const [key, summary] of summaries) {
    const ref = refs.get(key);
    if (ref) allOptions.push({ summary, ref });
    else hasUnpairedSummary = true;
  }
  const hasUnpairedRef = [...refs.keys()].some((key) => !summaries.has(key));
  const total = Math.max(snapshot.domains.sessions.page.total, summaries.size, refs.size);
  return {
    options: allOptions,
    total,
    isTruncated: snapshot.domains.sessions.page.truncated ||
      snapshot.domains.sessions.page.total > summaries.size ||
      hasUnpairedSummary ||
      hasUnpairedRef,
  };
}

function routeFromExactSessionSelection(
  snapshot: SliverSnapshot,
  requested: TargetRef,
): SessionWorkspaceRoute | undefined {
  const selectedRef = snapshot.targetContext.activeTarget;
  const selectedSummary = snapshot.targetContext.activeTargetSummary;
  if (
    snapshot.targetContext.status !== "selected" ||
    requested.mode !== "session" ||
    snapshot.connection.epoch !== requested.backendEpoch ||
    selectedRef?.mode !== "session" ||
    selectedRef.id !== requested.id ||
    selectedRef.backendEpoch !== requested.backendEpoch ||
    selectedRef.domainRevision !== requested.domainRevision ||
    selectedRef.fingerprint !== requested.fingerprint ||
    selectedSummary?.mode !== "session" ||
    selectedSummary.id !== requested.id
  ) return undefined;
  return {
    sessionId: selectedRef.id,
    backendEpoch: selectedRef.backendEpoch,
    connectionIncarnation: snapshot.connection.incarnation ?? 0,
    targetFingerprint: selectedRef.fingerprint,
  };
}

function sessionSelectionSnapshotIdentity(snapshot: SliverSnapshot): string {
  const ref = snapshot.targetContext.activeTarget;
  const summary = snapshot.targetContext.activeTargetSummary;
  return JSON.stringify([
    snapshot.connection.status,
    snapshot.connection.epoch,
    snapshot.connection.incarnation,
    snapshot.targetContext.status,
    ref?.mode,
    ref?.id,
    ref?.backendEpoch,
    ref?.domainRevision,
    ref?.fingerprint,
    summary?.mode,
    summary?.id,
  ]);
}

function sessionSelectionSnapshotAllowsCompletion(
  snapshot: SliverSnapshot,
  pending: PendingSessionSelection,
): boolean {
  if (
    !["connected", "degraded", "reconnecting"].includes(snapshot.connection.status) ||
    snapshot.connection.epoch !== pending.sourceRoute.backendEpoch ||
    (snapshot.connection.incarnation ?? 0) !== pending.sourceRoute.connectionIncarnation
  ) return false;
  return snapshotHasExactSessionTarget(snapshot, pending.sourceRef) ||
    snapshotHasExactSessionTarget(snapshot, pending.requestedRef);
}

function snapshotHasExactSessionTarget(snapshot: SliverSnapshot, expected: TargetRef): boolean {
  const activeRef = snapshot.targetContext.activeTarget;
  const activeSummary = snapshot.targetContext.activeTargetSummary;
  return snapshot.targetContext.status === "selected" &&
    expected.mode === "session" &&
    activeRef?.mode === "session" &&
    activeRef.id === expected.id &&
    activeRef.backendEpoch === expected.backendEpoch &&
    activeRef.domainRevision === expected.domainRevision &&
    activeRef.fingerprint === expected.fingerprint &&
    activeSummary?.mode === "session" &&
    activeSummary.id === expected.id;
}

function targetRefMatchesSessionRoute(target: TargetRef, route: SessionWorkspaceRoute): boolean {
  return target.mode === "session" &&
    target.id === route.sessionId &&
    target.backendEpoch === route.backendEpoch &&
    target.fingerprint === route.targetFingerprint;
}

function sessionDisplayName(session: SessionSummary): string {
  return session.name || session.hostname || session.id;
}

function sessionMenuItemKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function operationBelongsToRoute(operation: TargetOperationRecord, route: SessionWorkspaceRoute): boolean {
  return operation.mode === "session" &&
    operation.target.mode === "session" &&
    operation.target.id === route.sessionId &&
    operation.target.backendEpoch === route.backendEpoch &&
    operation.target.fingerprint === route.targetFingerprint &&
    operation.backend.epoch === route.backendEpoch;
}

function mergeUniqueOperations(
  current: TargetOperationRecord[],
  incoming: TargetOperationRecord[],
): TargetOperationRecord[] {
  const byId = new Map(current.map((operation) => [operation.requestId, operation]));
  for (const operation of incoming) {
    const existing = byId.get(operation.requestId);
    if (!existing || operation.updatedAt.localeCompare(existing.updatedAt) >= 0) {
      byId.set(operation.requestId, operation);
    }
  }
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
