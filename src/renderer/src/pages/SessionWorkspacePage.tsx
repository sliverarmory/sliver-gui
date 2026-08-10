import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Breadcrumbs, Button, Chip, Tabs, Tooltip, toast } from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faClockRotateLeft,
  faComputer,
  faCode,
  faFolderOpen,
  faList,
  faMicrochip,
  faRotate,
  faSkullCrossbones,
  faStop,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

import type { SliverSnapshot } from "../../../shared/contracts";
import type {
  DestructiveTargetActionId,
  SessionSummary,
  TargetActionExecutionResult,
  TargetActionPlan,
} from "../../../shared/target-contracts";
import type { TargetOperationRecord } from "../../../shared/operation-contracts";
import {
  capabilityFor,
  formatTimestamp,
  operationLabel,
  operationStateColor,
  operationStateLabel,
  targetStatus,
} from "./target-page-model";
import {
  DestructiveReviewModal,
  OperationComposer,
  OperationDetailModal,
  openOperationDetail,
} from "./TargetsPage";
import { defaultSessionWorkspacePanels } from "./session-workbench-panels";

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
  | "environment"
  | "activity"
  | "registry";

export interface SessionWorkspacePanelContext {
  route: SessionWorkspaceRoute;
  session: SessionSummary;
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
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
  onBack: () => void;
  panels?: SessionWorkspacePanels;
}

export function SessionWorkspacePage({
  route,
  session,
  snapshot,
  onSnapshot,
  onBack,
  panels = {},
}: SessionWorkspacePageProps): React.JSX.Element {
  const routeIdentity = sessionWorkspaceRouteIdentity(route);
  const routeIdentityRef = useRef(routeIdentity);
  routeIdentityRef.current = routeIdentity;
  const isCurrent = isAuthoritativeSessionRoute(snapshot, session, route);
  const isCurrentRef = useRef(isCurrent);
  isCurrentRef.current = isCurrent;
  const currentSession = isCurrent ? session : null;
  const [operations, setOperations] = useState<TargetOperationRecord[]>([]);
  const [nextOperationCursor, setNextOperationCursor] = useState<string>();
  const [operationsError, setOperationsError] = useState<string>();
  const [isLoadingOperations, setIsLoadingOperations] = useState(false);
  const [isLoadingMoreOperations, setIsLoadingMoreOperations] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<TargetOperationRecord>();
  const [selectedOperationRouteIdentity, setSelectedOperationRouteIdentity] = useState<string>();
  const [reviewPlan, setReviewPlan] = useState<TargetActionPlan>();
  const [actionResult, setActionResult] = useState<TargetActionExecutionResult>();
  const [isPreparingAction, setIsPreparingAction] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const operationsRequestSequence = useRef(0);
  const operationDetailRequestSequence = useRef(0);

  const mergeOperation = useCallback((operation: TargetOperationRecord) => {
    if (!operationBelongsToRoute(operation, route)) return;
    setOperations((current) => {
      const next = current.filter((candidate) => candidate.requestId !== operation.requestId);
      next.unshift(operation);
      return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    setSelectedOperation((current) => current?.requestId === operation.requestId ? operation : current);
  }, [route.backendEpoch, route.sessionId, route.targetFingerprint]);

  const loadOperations = useCallback(async (cursor?: string) => {
    if (!isCurrentRef.current) return;
    const append = cursor !== undefined;
    const expectedRouteIdentity = routeIdentity;
    const requestSequence = ++operationsRequestSequence.current;
    if (append) setIsLoadingMoreOperations(true);
    else setIsLoadingOperations(true);
    try {
      const result = await window.sliver.listTargetOperations({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        requestSequence !== operationsRequestSequence.current ||
        expectedRouteIdentity !== routeIdentityRef.current
      ) return;
      if (!result.ok || !result.value) {
        if (!append) setOperations([]);
        setOperationsError(result.error ?? "Session activity is unavailable");
        return;
      }
      const matching = result.value.items.filter((operation) => operationBelongsToRoute(operation, route));
      setOperations((current) => append ? mergeUniqueOperations(current, matching) : matching);
      setNextOperationCursor(result.value.page.nextCursor);
      setOperationsError(undefined);
    } catch (error) {
      if (
        requestSequence === operationsRequestSequence.current &&
        expectedRouteIdentity === routeIdentityRef.current
      ) {
        if (!append) setOperations([]);
        setOperationsError(errorMessage(error));
      }
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
    setOperations([]);
    setNextOperationCursor(undefined);
    setOperationsError(undefined);
    setSelectedOperation(undefined);
    setSelectedOperationRouteIdentity(undefined);
    setReviewPlan(undefined);
    setActionResult(undefined);
    setIsPreparingAction(false);
    setIsExecutingAction(false);
    if (isCurrent) void loadOperations();
  }, [isCurrent, loadOperations, routeIdentity]);

  useEffect(() => {
    if (!isCurrent) return;
    const subscribedIdentity = routeIdentity;
    return window.sliver.onOperationChanged((operation) => {
      if (subscribedIdentity === routeIdentityRef.current) mergeOperation(operation);
    });
  }, [isCurrent, mergeOperation, routeIdentity]);

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
            <EmptyState.Content>
              <Button variant="outline" onPress={onBack}>Back to sessions</Button>
            </EmptyState.Content>
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
  };
  const resolvedPanels = { ...defaultSessionWorkspacePanels, ...panels };
  const isWindows = currentSession.os.toLocaleLowerCase().includes("windows");

  return (
    <section className="page-stack" aria-labelledby="session-workspace-heading">
      <WorkspaceTrail sessionName={currentSession.name || currentSession.hostname || currentSession.id} onBack={onBack} />

      <header className="flex flex-col gap-5 rounded-2xl bg-surface p-5 sm:p-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className="section-icon mt-0.5"><FontAwesomeIcon aria-hidden icon={faComputer} /></span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold text-foreground sm:text-2xl" id="session-workspace-heading">
                {currentSession.name || currentSession.hostname || "Unnamed session"}
              </h1>
              <Chip color={status.color} size="sm" variant="soft">{status.label}</Chip>
            </div>
            <p className="mt-1 truncate font-mono text-xs text-muted">{currentSession.id}</p>
            <p className="mt-2 text-sm text-muted">
              {currentSession.username || "Unknown user"} on {currentSession.hostname || "unknown host"}
            </p>
          </div>
        </div>
        <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
          <CompactDetail label="Platform" value={`${currentSession.os || "unknown"}/${currentSession.arch || "unknown"}`} mono />
          <CompactDetail label="Process" value={currentSession.pid === undefined ? "Not reported" : String(currentSession.pid)} mono />
          <CompactDetail label="Last check-in" value={formatTimestamp(currentSession.lastCheckinAt)} />
        </dl>
      </header>

      <Tabs defaultSelectedKey="overview" variant="secondary">
        <Tabs.ListContainer>
          <Tabs.List aria-label="Session interaction sections">
            <WorkspaceTab id="overview" label="Overview" />
            <WorkspaceTab id="files" label="Files" />
            <WorkspaceTab id="processes" label="Processes" />
            <WorkspaceTab id="environment" label="Environment" />
            {isWindows ? <WorkspaceTab id="registry" label="Registry" /> : null}
            <WorkspaceTab id="activity" label="Activity" />
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel className="pt-6" id="overview">
          {renderPanel(resolvedPanels.overview, context, {
            icon: faComputer,
            title: "Session overview unavailable",
            description: "Identity and network details are not available for this workspace adapter.",
          })}
          <div className="mt-6 grid items-start gap-6 xl:grid-cols-2">
            <section className="rounded-2xl bg-surface p-5 sm:p-6" aria-label="Quick actions">
              <OperationComposer
                active={currentSession}
                capabilities={snapshot.targetContext.capabilities}
                targetIdentity={routeIdentity}
                onSubmitted={(operation) => {
                  if (routeIdentity !== routeIdentityRef.current) return false;
                  mergeOperation(operation);
                  return true;
                }}
              />
            </section>
            <SessionLifecycleActions
              capabilities={snapshot.targetContext.capabilities}
              isBusy={isPreparingAction}
              onPrepare={(actionId) => void prepareAction(actionId)}
            />
          </div>
        </Tabs.Panel>

        <Tabs.Panel className="pt-6" id="files">
          {renderPanel(resolvedPanels.files, context, {
            icon: faFolderOpen,
            title: "No file inventory loaded",
            description: "Browse a directory to inspect bounded remote filesystem results for this session.",
          })}
        </Tabs.Panel>
        <Tabs.Panel className="pt-6" id="processes">
          {renderPanel(resolvedPanels.processes, context, {
            icon: faMicrochip,
            title: "No process inventory loaded",
            description: "Process details and filters will appear here after the session returns an inventory.",
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
          <Tabs.Panel className="pt-6" id="registry">
            {renderPanel(resolvedPanels.registry, context, {
              icon: faList,
              title: "No registry location loaded",
              description: "Choose a hive and path to inspect Windows registry values for this session.",
            })}
          </Tabs.Panel>
        ) : null}
        <Tabs.Panel className="pt-6" id="activity">
          <SessionActivity
            error={operationsError}
            isLoading={isLoadingOperations}
            isLoadingMore={isLoadingMoreOperations}
            nextCursor={nextOperationCursor}
            operations={operations}
            onLoadMore={(cursor) => void loadOperations(cursor)}
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
            onRefresh={() => void loadOperations()}
          />
          {resolvedPanels.activity ? <div className="mt-6">{resolvedPanels.activity(context)}</div> : null}
        </Tabs.Panel>
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
    </section>
  );
}

function WorkspaceTrail({ sessionName, onBack }: { sessionName: string; onBack: () => void }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Tooltip delay={250}>
        <Button aria-label="Back to live sessions" isIconOnly size="sm" variant="ghost" onPress={onBack}>
          <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
        </Button>
        <Tooltip.Content>Back to live sessions</Tooltip.Content>
      </Tooltip>
      <Breadcrumbs className="min-w-0">
        <Breadcrumbs.Item className="no-underline">Sessions</Breadcrumbs.Item>
        <Breadcrumbs.Item className="max-w-72 truncate no-underline">{sessionName}</Breadcrumbs.Item>
      </Breadcrumbs>
    </div>
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

function SessionLifecycleActions({
  capabilities,
  isBusy,
  onPrepare,
}: {
  capabilities: SliverSnapshot["targetContext"]["capabilities"];
  isBusy: boolean;
  onPrepare: (actionId: "target.kill" | "session.close") => void;
}): React.JSX.Element {
  const terminate = capabilityFor(capabilities, "target.terminate");
  const close = capabilityFor(capabilities, "session.close");
  return (
    <section className="rounded-2xl bg-surface p-5 sm:p-6" aria-labelledby="session-controls-heading">
      <h2 className="text-sm font-semibold text-foreground" id="session-controls-heading">Session Controls</h2>
      <p className="mt-1 text-xs leading-relaxed text-muted">Destructive actions require a main-owned impact review before execution.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Tooltip delay={250}>
          <Button
            isDisabled={isBusy || terminate?.available !== true}
            size="sm"
            variant="danger-soft"
            onPress={() => onPrepare("target.kill")}
          >
            <FontAwesomeIcon aria-hidden icon={faSkullCrossbones} /> Kill target
          </Button>
          <Tooltip.Content>{terminate?.available ? "Kill target" : terminate?.reason?.message ?? "Target termination is unavailable"}</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={250}>
          <Button
            isDisabled={isBusy || close?.available !== true}
            size="sm"
            variant="danger-soft"
            onPress={() => onPrepare("session.close")}
          >
            <FontAwesomeIcon aria-hidden icon={faStop} /> Close session
          </Button>
          <Tooltip.Content>{close?.available ? "Close session" : close?.reason?.message ?? "Session close is unavailable"}</Tooltip.Content>
        </Tooltip>
      </div>
    </section>
  );
}

function SessionActivity({
  operations,
  error,
  isLoading,
  isLoadingMore,
  nextCursor,
  onLoadMore,
  onOpen,
  onRefresh,
}: {
  operations: TargetOperationRecord[];
  error: string | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  nextCursor: string | undefined;
  onLoadMore: (cursor: string) => void;
  onOpen: (operation: TargetOperationRecord) => void;
  onRefresh: () => void;
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
      <div className="flex items-center justify-between gap-4 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></span>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-foreground" id="m1-operations-heading">Activity</h2>
            <p className="text-xs text-muted">M1 and session workbench activity for this exact session.</p>
          </div>
        </div>
        <Tooltip delay={250}>
          <Button aria-label="Refresh activity" isIconOnly isPending={isLoading} size="sm" variant="ghost" onPress={onRefresh}>
            <FontAwesomeIcon aria-hidden icon={faRotate} />
          </Button>
          <Tooltip.Content>Refresh activity</Tooltip.Content>
        </Tooltip>
      </div>
      {error ? <p className="bg-danger-soft px-5 py-3 text-xs text-danger-soft-foreground sm:px-6" role="alert">{error}</p> : null}
      <DataGrid
        aria-label="Session activity"
        columns={columns}
        contentClassName="min-w-[720px]"
        data={operations}
        defaultSortDescriptor={{ column: "updated", direction: "descending" }}
        getRowId={(operation) => operation.requestId}
        scrollContainerClassName="max-h-[480px] overflow-auto"
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
        {nextCursor ? (
          <Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => onLoadMore(nextCursor)}>
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
  for (const operation of incoming) byId.set(operation.requestId, operation);
  return [...byId.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
