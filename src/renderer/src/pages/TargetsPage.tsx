import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Key } from "react-aria-components";
import {
  Button,
  Chip,
  Dropdown,
  Label,
  Modal,
  SearchField,
  Switch,
  Tooltip,
  toast,
} from "@heroui/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { ScrollShadow } from "@heroui/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowLeft,
  faArrowRight,
  faBan,
  faBolt,
  faBroom,
  faChevronDown,
  faCircleInfo,
  faCircleNotch,
  faClockRotateLeft,
  faCodeBranch,
  faComputer,
  faFileCode,
  faListCheck,
  faMagnifyingGlass,
  faPen,
  faPlay,
  faRotate,
  faSatellite,
  faSkullCrossbones,
  faStop,
  faTerminal,
  faTrash,
  faTriangleExclamation,
  faUserGroup,
  faWrench,
} from "@fortawesome/free-solid-svg-icons";

import type { PageSummary, SliverSnapshot } from "../../../shared/contracts";
import type {
  DestructiveTargetActionId,
  SessionSummary,
  TargetActionExecutionResult,
  TargetActionPlan,
  TargetCapabilityId,
  TargetMode,
  TargetRef,
  TargetSummary,
} from "../../../shared/target-contracts";
import {
  MAX_TARGET_CATALOG_QUERY_LENGTH,
  normalizeTargetCatalogQuery,
} from "../../../shared/target-contracts";
import type {
  BeaconTaskDetail,
  BeaconTaskSummary,
  OperationDisposition,
  OperationRecordId,
  TargetOperationId,
  TargetOperationInput,
  TargetOperationRecord,
} from "../../../shared/operation-contracts";
import { AreaField, Field } from "../components/FormControls";
import {
  beaconTaskCountLabel,
  capabilityFor,
  filterTargets,
  formatDuration,
  formatTimestamp,
  isOperationCancelable,
  operationLabel,
  operationStateColor,
  operationStateLabel,
  targetRowKey,
  targetStatus,
  targetTimingLabel,
  taskStateColor,
} from "./target-page-model";
import type { TargetModeFilter } from "./target-page-model";

export interface TargetsPageProps {
  mode: TargetMode;
  snapshot: SliverSnapshot;
  onSnapshot: (snapshot: SliverSnapshot) => void;
  onOpenSession?: (session: SessionSummary, target: TargetRef) => void;
}

type OperationDraft = {
  operationId: TargetOperationId;
  name: string;
  value: string;
  reconnectIntervalSeconds: string;
  intervalSeconds: string;
  jitterSeconds: string;
  delaySeconds: string;
};

interface TargetInventoryState {
  identity: string;
  sessions: TargetSummary[];
  beacons: TargetSummary[];
  refs: Record<string, TargetRef>;
  sessionPage: PageSummary;
  beaconPage: PageSummary;
}

const DEFAULT_OPERATION_DRAFT: OperationDraft = {
  operationId: "target.ping",
  name: "",
  value: "",
  reconnectIntervalSeconds: "",
  intervalSeconds: "",
  jitterSeconds: "",
  delaySeconds: "0",
};

const OPERATION_CAPABILITIES: Readonly<Record<TargetOperationId, TargetCapabilityId>> = {
  "target.ping": "target.ping",
  "target.rename": "target.rename",
  "target.env-set": "target.environment.write",
  "target.env-unset": "target.environment.write",
  "beacon.reconfigure": "beacon.reconfigure",
  "beacon.open-session": "beacon.open-session",
};

export function TargetsPage({ mode, snapshot, onSnapshot, onOpenSession }: TargetsPageProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [isSelecting, setIsSelecting] = useState(false);
  const [isChangingWatch, setIsChangingWatch] = useState(false);
  const [operations, setOperations] = useState<TargetOperationRecord[]>([]);
  const [operationsPage, setOperationsPage] = useState<PageSummary>();
  const [operationsError, setOperationsError] = useState<string>();
  const [isLoadingOperations, setIsLoadingOperations] = useState(false);
  const [isLoadingMoreOperations, setIsLoadingMoreOperations] = useState(false);
  const [selectedOperation, setSelectedOperation] = useState<TargetOperationRecord>();
  const [tasks, setTasks] = useState<BeaconTaskSummary[]>([]);
  const [tasksPage, setTasksPage] = useState<PageSummary>();
  const [tasksError, setTasksError] = useState<string>();
  const [isLoadingTasks, setIsLoadingTasks] = useState(false);
  const [isLoadingMoreTasks, setIsLoadingMoreTasks] = useState(false);
  const [selectedTask, setSelectedTask] = useState<BeaconTaskDetail>();
  const [selectedTaskIdentity, setSelectedTaskIdentity] = useState<string>();
  const [reviewPlan, setReviewPlan] = useState<TargetActionPlan>();
  const [actionResult, setActionResult] = useState<TargetActionExecutionResult>();
  const [isPreparingAction, setIsPreparingAction] = useState(false);
  const [isExecutingAction, setIsExecutingAction] = useState(false);
  const targetInventoryIdentity = targetCatalogIdentity(snapshot, mode);
  const normalizedTargetQuery = normalizeTargetCatalogQuery(query);
  const targetSearchIdentity = `${targetInventoryIdentity}\0${mode}\0${normalizedTargetQuery}`;
  const [targetInventory, setTargetInventory] = useState<TargetInventoryState>(() => seedTargetInventory(snapshot, mode));
  const [targetSearch, setTargetSearch] = useState<TargetInventoryState>();
  const [targetSearchError, setTargetSearchError] = useState<string>();
  const [loadingTargetModes, setLoadingTargetModes] = useState<ReadonlySet<TargetMode>>(new Set());
  const [searchingTargetModes, setSearchingTargetModes] = useState<ReadonlySet<TargetMode>>(new Set());
  const operationsRequestSequence = useRef(0);
  const tasksRequestSequence = useRef(0);
  const targetInventoryPageRequestSequence = useRef<Record<TargetMode, number>>({ session: 0, beacon: 0 });
  const targetSearchPageRequestSequence = useRef<Record<TargetMode, number>>({ session: 0, beacon: 0 });
  const operationDetailRequestSequence = useRef(0);
  const taskDetailRequestSequence = useRef(0);
  const targetSelectionRequestSequence = useRef(0);
  const selectedOperationIncarnationRef = useRef<string | undefined>(undefined);
  const selectedTaskIncarnationRef = useRef<string | undefined>(undefined);
  const targetInventoryIdentityRef = useRef(targetInventoryIdentity);
  targetInventoryIdentityRef.current = targetInventoryIdentity;
  const targetSearchIdentityRef = useRef(targetSearchIdentity);
  targetSearchIdentityRef.current = targetSearchIdentity;

  const presentedTargetInventory = useMemo(
    () => normalizedTargetQuery
      ? targetSearch?.identity === targetSearchIdentity
        ? targetSearch
        : emptyTargetInventory(targetSearchIdentity)
      : targetInventory,
    [normalizedTargetQuery, targetInventory, targetSearch, targetSearchIdentity],
  );
  const relevantSearchModes = targetModesForFilter(mode);
  const isSearchingTargets = Boolean(normalizedTargetQuery) && (
    targetSearch?.identity !== targetSearchIdentity ||
    relevantSearchModes.some((targetMode) => searchingTargetModes.has(targetMode))
  );

  const allTargets = useMemo<TargetSummary[]>(
    () => mode === "session" ? presentedTargetInventory.sessions : presentedTargetInventory.beacons,
    [mode, presentedTargetInventory.beacons, presentedTargetInventory.sessions],
  );
  const filteredTargets = useMemo(
    () => filterTargets(allTargets, mode, query),
    [allTargets, mode, query],
  );
  const active = snapshot.targetContext.activeTargetSummary?.mode === mode
    ? snapshot.targetContext.activeTargetSummary
    : null;
  const activeRef = snapshot.targetContext.activeTarget?.mode === mode
    ? snapshot.targetContext.activeTarget
    : null;
  const backendEpochRef = useRef(snapshot.connection.epoch);
  backendEpochRef.current = snapshot.connection.epoch;
  const activeIdentity = targetRefIdentity(activeRef);
  const activeIdentityRef = useRef(activeIdentity);
  activeIdentityRef.current = activeIdentity;
  const selectedOperationIdRef = useRef(selectedOperation?.requestId);
  selectedOperationIdRef.current = selectedOperation?.requestId;
  const selectedTaskIdRef = useRef(selectedTask?.taskId);
  selectedTaskIdRef.current = selectedTask?.taskId;
  const backendIncarnation = snapshot.connection.epoch === undefined
    ? "disconnected"
    : `${snapshot.connection.epoch}:${snapshot.connection.incarnation ?? 0}:${snapshot.connection.server ?? ""}:${snapshot.connection.configName ?? ""}`;
  const backendIncarnationRef = useRef(backendIncarnation);
  backendIncarnationRef.current = backendIncarnation;
  const taskReadCapability = capabilityFor(snapshot.targetContext.capabilities, "beacon.tasks.read");
  const selectedKeys = active ? new Set([targetRowKey(active)]) : new Set<string>();
  const pageLabel = mode === "session" ? "Sessions" : "Beacons";
  const pageLabelLower = mode === "session" ? "sessions" : "beacons";
  const pageIcon = mode === "session" ? faComputer : faSatellite;
  const pageTotal = mode === "session" ? targetInventory.sessionPage.total : targetInventory.beaconPage.total;

  const mergeOperation = useCallback((operation: TargetOperationRecord) => {
    if (operation.backend.epoch !== backendEpochRef.current) return;
    setOperations((current) => {
      const next = current.filter((item) => item.requestId !== operation.requestId);
      next.unshift(operation);
      return next.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
    setSelectedOperation((current) => current?.requestId === operation.requestId ? operation : current);
  }, []);

  const loadMoreTargets = useCallback(async (targetMode: TargetMode, cursor: string) => {
    const expectedIdentity = targetInventoryIdentityRef.current;
    const requestSequence = ++targetInventoryPageRequestSequence.current[targetMode];
    setLoadingTargetModes((current) => new Set(current).add(targetMode));
    try {
      const result = await window.sliver.listTargets({ mode: targetMode, cursor, limit: 100 });
      if (
        requestSequence !== targetInventoryPageRequestSequence.current[targetMode] ||
        expectedIdentity !== targetInventoryIdentityRef.current
      ) return;
      if (!result.ok || !result.value) {
        toast.danger(`Could not load more ${targetMode}s`, { description: result.error });
        return;
      }
      setTargetInventory((current) => {
        if (current.identity !== expectedIdentity) return current;
        const nextRefs = { ...current.refs };
        for (const entry of result.value.items) nextRefs[targetRowKey(entry.target)] = entry.ref;
        const appended = appendUnique(
          targetMode === "session" ? current.sessions : current.beacons,
          result.value.items.map((entry) => entry.target),
          targetRowKey,
        );
        return targetMode === "session"
          ? { ...current, sessions: appended, refs: nextRefs, sessionPage: result.value.page }
          : { ...current, beacons: appended, refs: nextRefs, beaconPage: result.value.page };
      });
    } catch (error) {
      if (
        requestSequence === targetInventoryPageRequestSequence.current[targetMode] &&
        expectedIdentity === targetInventoryIdentityRef.current
      ) {
        toast.danger(`Could not load more ${targetMode}s`, { description: errorMessage(error) });
      }
    } finally {
      if (
        requestSequence === targetInventoryPageRequestSequence.current[targetMode] &&
        expectedIdentity === targetInventoryIdentityRef.current
      ) {
        setLoadingTargetModes((current) => {
          const next = new Set(current);
          next.delete(targetMode);
          return next;
        });
      }
    }
  }, []);

  const loadMoreSearchTargets = useCallback(async (
    targetMode: TargetMode,
    cursor: string,
    searchIdentity: string,
    searchQuery: string,
  ) => {
    const requestSequence = ++targetSearchPageRequestSequence.current[targetMode];
    setSearchingTargetModes((current) => new Set(current).add(targetMode));
    try {
      const result = await window.sliver.listTargets({
        mode: targetMode,
        cursor,
        limit: 100,
        query: searchQuery,
      });
      if (
        requestSequence !== targetSearchPageRequestSequence.current[targetMode] ||
        searchIdentity !== targetSearchIdentityRef.current
      ) return;
      if (!result.ok || !result.value) {
        setTargetSearchError(result.error ?? `Could not load more ${targetMode} search results`);
        return;
      }
      setTargetSearch((current) => {
        if (current?.identity !== searchIdentity) return current;
        const nextRefs = { ...current.refs };
        for (const entry of result.value.items) nextRefs[targetRowKey(entry.target)] = entry.ref;
        const appended = appendUnique(
          targetMode === "session" ? current.sessions : current.beacons,
          result.value.items.map((entry) => entry.target),
          targetRowKey,
        );
        return targetMode === "session"
          ? { ...current, sessions: appended, refs: nextRefs, sessionPage: result.value.page }
          : { ...current, beacons: appended, refs: nextRefs, beaconPage: result.value.page };
      });
      setTargetSearchError(undefined);
    } catch (error) {
      if (
        requestSequence === targetSearchPageRequestSequence.current[targetMode] &&
        searchIdentity === targetSearchIdentityRef.current
      ) setTargetSearchError(errorMessage(error));
    } finally {
      if (
        requestSequence === targetSearchPageRequestSequence.current[targetMode] &&
        searchIdentity === targetSearchIdentityRef.current
      ) {
        setSearchingTargetModes((current) => {
          const next = new Set(current);
          next.delete(targetMode);
          return next;
        });
      }
    }
  }, []);

  const loadOperations = useCallback(async (cursor?: string) => {
    const append = cursor !== undefined;
    const expectedIncarnation = backendIncarnationRef.current;
    const requestSequence = ++operationsRequestSequence.current;
    if (append) {
      setIsLoadingOperations(false);
      setIsLoadingMoreOperations(true);
    } else {
      setIsLoadingMoreOperations(false);
      setIsLoadingOperations(true);
    }
    try {
      const result = await window.sliver.listTargetOperations({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        requestSequence !== operationsRequestSequence.current ||
        expectedIncarnation !== backendIncarnationRef.current
      ) return;
      if (!result.ok || !result.value) {
        if (!append) {
          setOperations([]);
          setOperationsPage(undefined);
        }
        setOperationsError(result.error ?? "Operation history is unavailable");
        return;
      }
      setOperations((current) => append
        ? appendUnique(current, result.value.items, (operation) => operation.requestId)
        : result.value.items);
      setOperationsPage(result.value.page);
      setOperationsError(undefined);
    } catch (error) {
      if (
        requestSequence !== operationsRequestSequence.current ||
        expectedIncarnation !== backendIncarnationRef.current
      ) return;
      if (!append) {
        setOperations([]);
        setOperationsPage(undefined);
      }
      setOperationsError(errorMessage(error));
    } finally {
      if (
        requestSequence === operationsRequestSequence.current &&
        expectedIncarnation === backendIncarnationRef.current
      ) {
        if (append) setIsLoadingMoreOperations(false);
        else setIsLoadingOperations(false);
      }
    }
  }, []);

  const loadTasks = useCallback(async (cursor?: string) => {
    const append = cursor !== undefined;
    const expectedIncarnation = backendIncarnationRef.current;
    const requestSequence = ++tasksRequestSequence.current;
    if (active?.mode !== "beacon") {
      setTasks([]);
      setTasksPage(undefined);
      setTasksError(undefined);
      setIsLoadingTasks(false);
      setIsLoadingMoreTasks(false);
      return;
    }
    if (!taskReadCapability?.available) {
      setTasks([]);
      setTasksPage(undefined);
      setTasksError(taskReadCapability?.reason?.message ?? "Beacon task inventory is unavailable for this target");
      setIsLoadingTasks(false);
      setIsLoadingMoreTasks(false);
      return;
    }
    if (append) {
      setIsLoadingTasks(false);
      setIsLoadingMoreTasks(true);
    } else {
      setIsLoadingMoreTasks(false);
      setIsLoadingTasks(true);
    }
    try {
      const result = await window.sliver.listBeaconTasks({
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (
        requestSequence !== tasksRequestSequence.current ||
        expectedIncarnation !== backendIncarnationRef.current
      ) return;
      if (!result.ok || !result.value) {
        if (!append) {
          setTasks([]);
          setTasksPage(undefined);
        }
        setTasksError(result.error ?? "Beacon tasks are unavailable");
        return;
      }
      setTasks((current) => append
        ? appendUnique(current, result.value.items, (task) => task.taskId)
        : result.value.items);
      setTasksPage(result.value.page);
      setTasksError(undefined);
    } catch (error) {
      if (
        requestSequence !== tasksRequestSequence.current ||
        expectedIncarnation !== backendIncarnationRef.current
      ) return;
      if (!append) {
        setTasks([]);
        setTasksPage(undefined);
      }
      setTasksError(errorMessage(error));
    } finally {
      if (
        requestSequence === tasksRequestSequence.current &&
        expectedIncarnation === backendIncarnationRef.current
      ) {
        if (append) setIsLoadingMoreTasks(false);
        else setIsLoadingTasks(false);
      }
    }
  }, [active?.id, active?.mode, activeIdentity, taskReadCapability?.available, taskReadCapability?.reason?.message]);

  useEffect(() => {
    targetInventoryPageRequestSequence.current.session += 1;
    targetInventoryPageRequestSequence.current.beacon += 1;
    setLoadingTargetModes(new Set());
    setTargetInventory(seedTargetInventory(snapshot, mode));
  }, [targetInventoryIdentity]);

  useEffect(() => {
    setSearchingTargetModes(new Set());
    setTargetSearchError(undefined);
    if (!normalizedTargetQuery) {
      setTargetSearch(undefined);
      return;
    }

    targetSearchPageRequestSequence.current.session += 1;
    targetSearchPageRequestSequence.current.beacon += 1;
    const searchModes = targetModesForFilter(mode);
    const requests = searchModes.map((targetMode) => ({
      mode: targetMode,
      sequence: targetSearchPageRequestSequence.current[targetMode],
    }));
    setTargetSearch(emptyTargetInventory(targetSearchIdentity));
    setSearchingTargetModes(new Set(searchModes));
    const timer = window.setTimeout(() => {
      for (const request of requests) {
        void window.sliver.listTargets({
          mode: request.mode,
          limit: 100,
          query: normalizedTargetQuery,
        }).then((result) => {
          if (
            request.sequence !== targetSearchPageRequestSequence.current[request.mode] ||
            targetSearchIdentity !== targetSearchIdentityRef.current
          ) return;
          if (!result.ok || !result.value) {
            setTargetSearchError(result.error ?? `Could not search ${request.mode}s`);
            return;
          }
          setTargetSearch((current) => {
            if (current?.identity !== targetSearchIdentity) return current;
            const refs = { ...current.refs };
            for (const entry of result.value.items) refs[targetRowKey(entry.target)] = entry.ref;
            const items = result.value.items.map((entry) => entry.target);
            return request.mode === "session"
              ? { ...current, sessions: items, refs, sessionPage: result.value.page }
              : { ...current, beacons: items, refs, beaconPage: result.value.page };
          });
        }).catch((error: unknown) => {
          if (
            request.sequence === targetSearchPageRequestSequence.current[request.mode] &&
            targetSearchIdentity === targetSearchIdentityRef.current
          ) setTargetSearchError(errorMessage(error));
        }).finally(() => {
          if (
            request.sequence === targetSearchPageRequestSequence.current[request.mode] &&
            targetSearchIdentity === targetSearchIdentityRef.current
          ) {
            setSearchingTargetModes((current) => {
              const next = new Set(current);
              next.delete(request.mode);
              return next;
            });
          }
        });
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [mode, normalizedTargetQuery, targetSearchIdentity]);

  useEffect(() => {
    targetSelectionRequestSequence.current += 1;
    setIsSelecting(false);
    operationsRequestSequence.current += 1;
    tasksRequestSequence.current += 1;
    operationDetailRequestSequence.current += 1;
    taskDetailRequestSequence.current += 1;
    setOperations([]);
    setOperationsPage(undefined);
    setOperationsError(undefined);
    setTasks([]);
    setTasksPage(undefined);
    setTasksError(undefined);
    setSelectedOperation(undefined);
    selectedOperationIncarnationRef.current = undefined;
    setSelectedTask(undefined);
    selectedTaskIncarnationRef.current = undefined;
    setSelectedTaskIdentity(undefined);
    setReviewPlan(undefined);
    setActionResult(undefined);
    if (snapshot.connection.epoch !== undefined) void loadOperations();
  }, [backendIncarnation, loadOperations, snapshot.connection.epoch]);

  useEffect(() => {
    const subscribedIncarnation = backendIncarnation;
    const unsubscribeOperations = window.sliver.onOperationChanged((operation) => {
      if (subscribedIncarnation === backendIncarnationRef.current) mergeOperation(operation);
    });
    const unsubscribeTasks = window.sliver.onBeaconTasksInvalidated((target) => {
      if (activeRef?.mode === "beacon" && target.id === activeRef.id && target.backendEpoch === activeRef.backendEpoch) {
        void loadTasks();
      }
    });
    return () => {
      unsubscribeOperations();
      unsubscribeTasks();
    };
  }, [activeRef?.backendEpoch, activeRef?.id, activeRef?.mode, backendIncarnation, loadOperations, loadTasks, mergeOperation]);

  useEffect(() => {
    taskDetailRequestSequence.current += 1;
    setTasks([]);
    setTasksPage(undefined);
    void loadTasks();
    setSelectedTask(undefined);
    selectedTaskIncarnationRef.current = undefined;
    setSelectedTaskIdentity(undefined);
  }, [loadTasks]);

  const selectTarget = useCallback(async (target: TargetSummary) => {
    const ref = presentedTargetInventory.refs[targetRowKey(target)];
    if (!ref) {
      toast.warning("Target changed", { description: "Refresh the inventory and select it again." });
      return;
    }
    const expectedIncarnation = backendIncarnationRef.current;
    const requestSequence = ++targetSelectionRequestSequence.current;
    setIsSelecting(true);
    try {
      const result = await window.sliver.selectTarget(ref);
      if (
        requestSequence !== targetSelectionRequestSequence.current ||
        expectedIncarnation !== backendIncarnationRef.current
      ) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not select target", { description: result.error });
        return;
      }
      onSnapshot(result.value);

      if (target.mode === "session" && onOpenSession) {
        const selectedRef = result.value.targetContext.activeTarget;
        const selectedSummary = result.value.targetContext.activeTargetSummary;
        if (
          selectedRef?.mode !== "session" ||
          selectedRef.id !== ref.id ||
          selectedRef.backendEpoch !== ref.backendEpoch ||
          selectedRef.fingerprint !== ref.fingerprint ||
          selectedSummary?.mode !== "session" ||
          selectedSummary.id !== ref.id
        ) {
          toast.warning("Session changed", {
            description: "The server did not confirm the selected session. Refresh the inventory and try again.",
          });
          return;
        }
        onOpenSession(selectedSummary, selectedRef);
      }
    } catch (error) {
      if (
        requestSequence === targetSelectionRequestSequence.current &&
        expectedIncarnation === backendIncarnationRef.current
      ) toast.danger("Could not select target", { description: errorMessage(error) });
    } finally {
      if (
        requestSequence === targetSelectionRequestSequence.current &&
        expectedIncarnation === backendIncarnationRef.current
      ) setIsSelecting(false);
    }
  }, [onOpenSession, onSnapshot, presentedTargetInventory.refs]);

  const selectTargetByKey = useCallback((key: Key) => {
    const target = allTargets.find((candidate) => targetRowKey(candidate) === String(key));
    if (target) void selectTarget(target);
  }, [allTargets, selectTarget]);

  const backgroundTarget = useCallback(async () => {
    setIsSelecting(true);
    try {
      const result = await window.sliver.backgroundTarget();
      if (!result.ok || !result.value) {
        toast.danger("Could not background target", { description: result.error });
        return;
      }
      onSnapshot(result.value);
    } catch (error) {
      toast.danger("Could not background target", { description: errorMessage(error) });
    } finally {
      setIsSelecting(false);
    }
  }, [onSnapshot]);

  const setBeaconWatch = useCallback(async (enabled: boolean) => {
    setIsChangingWatch(true);
    try {
      const result = await window.sliver.setBeaconWatch({ enabled });
      if (!result.ok || !result.value) {
        toast.danger("Could not change beacon watch", { description: result.error });
        return;
      }
      onSnapshot(result.value);
    } catch (error) {
      toast.danger("Could not change beacon watch", { description: errorMessage(error) });
    } finally {
      setIsChangingWatch(false);
    }
  }, [onSnapshot]);

  const refreshSnapshot = useCallback(async () => {
    try {
      const result = await window.sliver.refresh();
      if (result.ok && result.value) onSnapshot(result.value);
    } catch (error) {
      toast.danger("Could not refresh targets", { description: errorMessage(error) });
    }
  }, [onSnapshot]);

  const prepareAction = useCallback(async (actionId: DestructiveTargetActionId) => {
    setIsPreparingAction(true);
    setActionResult(undefined);
    try {
      const result = await window.sliver.prepareTargetAction({ actionId });
      if (!result.ok || !result.value) {
        toast.danger("Could not review action", { description: result.error });
        return;
      }
      setReviewPlan(result.value);
    } catch (error) {
      toast.danger("Could not review action", { description: errorMessage(error) });
    } finally {
      setIsPreparingAction(false);
    }
  }, []);

  const executeAction = useCallback(async () => {
    if (!reviewPlan) return;
    setIsExecutingAction(true);
    try {
      const result = await window.sliver.executeTargetActionPlan({ token: reviewPlan.token });
      if (!result.ok || !result.value) {
        toast.danger("Target action failed", { description: result.error });
        return;
      }
      setActionResult(result.value);
      const failures = result.value.outcomes.filter((outcome) => outcome.status !== "succeeded");
      if (failures.length === 0) {
        toast.success("Target action complete", { description: `${result.value.outcomes.length} target result recorded.` });
      } else {
        toast.warning("Target action needs review", { description: `${failures.length} outcome${failures.length === 1 ? "" : "s"} were not confirmed.` });
      }
      await refreshSnapshot();
    } catch (error) {
      toast.danger("Target action failed", { description: errorMessage(error) });
    } finally {
      setIsExecutingAction(false);
    }
  }, [refreshSnapshot, reviewPlan]);

  const targetColumns = useMemo<DataGridColumn<TargetSummary>[]>(() => [
    {
      id: "target",
      header: "Target",
      isRowHeader: true,
      allowsSorting: true,
      minWidth: 220,
      sortFn: (left, right) => left.name.localeCompare(right.name),
      cell: (target) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{target.name || target.hostname || "Unnamed target"}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{target.id}</p>
        </div>
      ),
    },
    {
      id: "host",
      header: "Host & user",
      minWidth: 190,
      cell: (target) => (
        <div className="min-w-0 text-xs">
          <p className="truncate text-foreground">{target.hostname || "Unknown host"}</p>
          <p className="mt-0.5 truncate text-muted">{target.username || "Unknown user"} · {target.os}/{target.arch}</p>
        </div>
      ),
    },
    {
      id: "transport",
      header: "Transport",
      accessorKey: "transport",
      allowsSorting: true,
      minWidth: 120,
      cell: (target) => (
        <div className="min-w-0 text-xs">
          <p className="uppercase text-foreground">{target.transport}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{target.remoteAddress || "Not reported"}</p>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      allowsSorting: true,
      minWidth: 114,
      sortFn: (left, right) => targetStatus(left).label.localeCompare(targetStatus(right).label),
      cell: (target) => {
        const status = targetStatus(target);
        return <Chip color={status.color} size="sm" variant="soft">{status.label}</Chip>;
      },
    },
    {
      id: "timing",
      header: "Timing",
      minWidth: 210,
      cell: (target) => (
        <span className="text-xs tabular-nums text-muted">{targetTimingLabel(target)}</span>
      ),
    },
    ...(mode === "beacon" ? [{
      id: "tasks",
      header: "Tasks",
      minWidth: 130,
      cell: (target: TargetSummary) => target.mode === "beacon"
        ? <span className="text-xs tabular-nums text-muted">{beaconTaskCountLabel(target)}</span>
        : null,
    }] : [{
      id: "interact",
      header: "",
      minWidth: 124,
      cell: (target: TargetSummary) => (
        <Button
          aria-label={`Interact with ${target.name || target.hostname || target.id}`}
          size="sm"
          variant="secondary"
          onPress={() => void selectTarget(target)}
        >
          Interact <FontAwesomeIcon aria-hidden icon={faArrowRight} />
        </Button>
      ),
    }]),
  ], [mode, selectTarget]);

  return (
    <section className="page-stack targets-page">
      <header className="page-heading">
        <div className="min-w-0">
          <div className="eyebrow"><FontAwesomeIcon aria-hidden icon={pageIcon} /> {mode === "session" ? "Session" : "Beacon"} workspace</div>
          <h1>{pageLabel}</h1>
          <p>Inspect live {pageLabelLower}, choose this window's active {mode}, and track every submitted operation.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Chip size="sm" variant="soft">{pageTotal} {pageLabelLower}</Chip>
          <Chip size="sm" variant="soft">{snapshot.operators.filter((operator) => operator.online).length} online operators</Chip>
          <MaintenanceMenu
            disabled={isPreparingAction}
            mode={mode}
            onAction={(action) => void prepareAction(action)}
          />
        </div>
      </header>

      <div className={mode === "session" ? "min-h-0" : "grid min-h-0 gap-4 2xl:grid-cols-[minmax(0,1fr)_390px]"}>
        <section className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby="target-inventory-heading">
          <div className="flex flex-col gap-4 px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="section-icon"><FontAwesomeIcon aria-hidden icon={pageIcon} /></span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground" id="target-inventory-heading">Live {pageLabelLower}</h2>
                <p className="text-xs text-muted">Selection belongs to this window and does not affect other operators.</p>
              </div>
            </div>
            <SearchField
              aria-label={`Filter ${pageLabelLower}`}
              className="w-full lg:max-w-sm"
              value={query}
              variant="secondary"
              onChange={setQuery}
            >
              <SearchField.Group>
                <SearchField.SearchIcon><FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} /></SearchField.SearchIcon>
                <SearchField.Input
                  maxLength={MAX_TARGET_CATALOG_QUERY_LENGTH}
                  placeholder="Filter name, host, user, ID, or C2"
                />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
          </div>
          {targetSearchError ? (
            <InlineNotice tone="danger" message={targetSearchError} />
          ) : (
            <DomainNotice
              error={mode === "session" ? snapshot.domains.sessions.error : snapshot.domains.beacons.error}
              mode={mode}
              status={targetDomainStatus(snapshot, mode)}
              truncated={mode === "session"
                ? presentedTargetInventory.sessionPage.truncated
                : presentedTargetInventory.beaconPage.truncated}
            />
          )}
          <DataGrid
            aria-label={`Sliver ${pageLabelLower}`}
            columns={targetColumns}
            contentClassName={mode === "session" ? "min-w-[850px]" : "min-w-[980px]"}
            data={filteredTargets}
            disabledKeys={isSelecting ? filteredTargets.map(targetRowKey) : []}
            getRowId={targetRowKey}
            selectedKeys={selectedKeys}
            selectionBehavior="replace"
            selectionMode="single"
            scrollContainerClassName="max-h-[520px] overflow-auto"
            variant="secondary"
            onRowAction={selectTargetByKey}
            onSelectionChange={(selection) => {
              if (selection === "all") return;
              const key = [...selection][0];
              if (key !== undefined) selectTargetByKey(key);
            }}
            renderEmptyState={() => (
              <EmptyState className="min-h-64 px-6 py-12" size="sm">
                <EmptyState.Media><FontAwesomeIcon aria-hidden icon={pageIcon} /></EmptyState.Media>
                <EmptyState.Content>
                  <EmptyState.Title>
                    {isSearchingTargets
                      ? `Searching ${pageLabelLower}`
                      : normalizedTargetQuery
                        ? `No ${pageLabelLower} match`
                        : allTargets.length === 0
                          ? `No ${pageLabelLower} connected`
                          : `No ${pageLabelLower} match`}
                  </EmptyState.Title>
                  <EmptyState.Description>
                    {isSearchingTargets
                      ? "Searching the complete bounded server catalog…"
                      : normalizedTargetQuery
                        ? "Clear the search or try another query."
                        : allTargets.length === 0
                          ? `${pageLabel} appear here as the server reports them.`
                          : "Try another query."}
                  </EmptyState.Description>
                </EmptyState.Content>
              </EmptyState>
            )}
          />
          <TargetCatalogPaging
            filter={mode}
            sessionsLoaded={presentedTargetInventory.sessions.length}
            beaconsLoaded={presentedTargetInventory.beacons.length}
            sessionPage={presentedTargetInventory.sessionPage}
            beaconPage={presentedTargetInventory.beaconPage}
            loadingModes={normalizedTargetQuery ? searchingTargetModes : loadingTargetModes}
            disabled={targetDomainStatus(snapshot, mode) !== "ready"}
            onLoadMore={(targetMode, cursor) => {
              if (normalizedTargetQuery) {
                void loadMoreSearchTargets(
                  targetMode,
                  cursor,
                  targetSearchIdentity,
                  normalizedTargetQuery,
                );
              } else {
                void loadMoreTargets(targetMode, cursor);
              }
            }}
          />
        </section>

        {mode === "beacon" ? (
          <TargetDetail
            active={active}
            mode={mode}
            capabilities={snapshot.targetContext.capabilities}
            isBusy={isSelecting || isPreparingAction}
            isChangingWatch={isChangingWatch}
            watchEnabled={snapshot.targetContext.beaconWatch}
            unavailableReason={snapshot.targetContext.activeTarget?.mode === mode
              ? snapshot.targetContext.unavailableReason
              : undefined}
            onBackground={() => void backgroundTarget()}
            onPrepareAction={(action) => void prepareAction(action)}
            onWatchChange={(enabled) => void setBeaconWatch(enabled)}
            onOperationSubmitted={(operation) => {
              const submittedIncarnation = backendIncarnation;
              if (submittedIncarnation !== backendIncarnationRef.current) return false;
              mergeOperation(operation);
              return true;
            }}
            operationTargetIdentity={`${backendIncarnation}:${targetRefIdentity(activeRef) ?? `${active?.mode ?? "none"}:${active?.id ?? "none"}`}`}
          />
        ) : null}
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <OperationHistory
          error={operationsError}
          isLoading={isLoadingOperations}
          isLoadingMore={isLoadingMoreOperations}
          operations={operations}
          page={operationsPage}
          onLoadMore={(cursor) => void loadOperations(cursor)}
          onOpen={(operation) => {
            const expectedIncarnation = backendIncarnation;
            const requestSequence = ++operationDetailRequestSequence.current;
            void openOperationDetail(
              operation,
              (detail) => {
                selectedOperationIncarnationRef.current = expectedIncarnation;
                setSelectedOperation(detail);
              },
              () => expectedIncarnation === backendIncarnationRef.current &&
                requestSequence === operationDetailRequestSequence.current,
            );
          }}
          onRefresh={() => void loadOperations()}
        />
        <OperatorPresence snapshot={snapshot} />
      </div>

      {active?.mode === "beacon" ? (
        <BeaconTasks
          error={tasksError}
          isLoading={isLoadingTasks}
          isLoadingMore={isLoadingMoreTasks}
          page={tasksPage}
          tasks={tasks}
          watchEnabled={snapshot.targetContext.beaconWatch}
          onLoadMore={(cursor) => void loadTasks(cursor)}
          onOpen={(task) => {
            const expectedTarget = activeIdentity;
            const expectedIncarnation = backendIncarnation;
            const requestSequence = ++taskDetailRequestSequence.current;
            void openTaskDetail(
              task,
              (detail) => {
                selectedTaskIncarnationRef.current = expectedIncarnation;
                setSelectedTaskIdentity(expectedTarget);
                setSelectedTask(detail);
              },
              () => expectedIncarnation === backendIncarnationRef.current &&
                expectedTarget === activeIdentityRef.current &&
                requestSequence === taskDetailRequestSequence.current,
            );
          }}
          onRefresh={() => void loadTasks()}
        />
      ) : null}

      <OperationDetailModal
        isCurrent={() => Boolean(
          selectedOperation &&
          selectedOperationIncarnationRef.current === backendIncarnationRef.current &&
          selectedOperation.backend.epoch === backendEpochRef.current &&
          selectedOperation.requestId === selectedOperationIdRef.current,
        )}
        operation={selectedOperation}
        onChanged={mergeOperation}
        onOpenChange={(open) => {
          if (!open) {
            selectedOperationIncarnationRef.current = undefined;
            setSelectedOperation(undefined);
          }
        }}
      />
      <TaskDetailModal
        isCurrent={() => selectedTaskIdentity !== undefined &&
          selectedTaskIncarnationRef.current === backendIncarnationRef.current &&
          selectedTaskIdentity === activeIdentityRef.current &&
          selectedTask?.taskId === selectedTaskIdRef.current}
        task={selectedTask}
        onChanged={(task) => {
          setSelectedTask(task);
          setTasks((current) => current.map((item) => item.taskId === task.taskId ? task : item));
        }}
        onOpenChange={(open) => {
          if (!open) {
            selectedTaskIncarnationRef.current = undefined;
            setSelectedTask(undefined);
            setSelectedTaskIdentity(undefined);
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

function TargetDetail({
  active,
  mode,
  capabilities,
  isBusy,
  isChangingWatch,
  watchEnabled,
  unavailableReason,
  onBackground,
  onPrepareAction,
  onWatchChange,
  onOperationSubmitted,
  operationTargetIdentity,
}: {
  active: TargetSummary | null;
  mode: TargetMode;
  capabilities: SliverSnapshot["targetContext"]["capabilities"];
  isBusy: boolean;
  isChangingWatch: boolean;
  watchEnabled: boolean;
  unavailableReason: string | undefined;
  onBackground: () => void;
  onPrepareAction: (action: DestructiveTargetActionId) => void;
  onWatchChange: (enabled: boolean) => void;
  onOperationSubmitted: (operation: TargetOperationRecord) => boolean;
  operationTargetIdentity: string;
}): React.JSX.Element {
  if (!active) {
    return (
      <aside className="min-w-0 self-start rounded-2xl border border-separator bg-surface p-6 2xl:sticky 2xl:top-0">
        <EmptyState size="sm">
          <EmptyState.Media><FontAwesomeIcon aria-hidden icon={mode === "session" ? faComputer : faSatellite} /></EmptyState.Media>
          <EmptyState.Content>
            <EmptyState.Title>{unavailableReason ? `${capitalize(mode)} unavailable` : `Select a ${mode}`}</EmptyState.Title>
            <EmptyState.Description>
              {unavailableReason ?? `Choose a ${mode} to inspect its capabilities and submit an operation.`}
            </EmptyState.Description>
          </EmptyState.Content>
        </EmptyState>
      </aside>
    );
  }

  const status = targetStatus(active);
  const lifecycleActions: DestructiveTargetActionId[] = active.mode === "session"
    ? ["target.kill", "session.close"]
    : ["target.kill", "beacon.remove"];

  return (
    <aside className="min-w-0 self-start overflow-hidden rounded-2xl border border-separator bg-surface 2xl:sticky 2xl:top-0">
      <div className="flex items-start gap-3 px-4 py-4">
        <span className="section-icon"><FontAwesomeIcon aria-hidden icon={active.mode === "session" ? faComputer : faSatellite} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-sm font-semibold text-foreground">{active.name || active.hostname || "Unnamed target"}</h2>
            <Chip color={status.color} size="sm" variant="soft">{status.label}</Chip>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted">{active.id}</p>
        </div>
        <Tooltip delay={250}>
          <Button aria-label="Background target" isDisabled={isBusy} isIconOnly size="sm" variant="ghost" onPress={onBackground}>
            <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
          </Button>
          <Tooltip.Content>Background target</Tooltip.Content>
        </Tooltip>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-3 border-y border-separator bg-default px-4 py-4 text-xs">
        <DetailItem label="Host" value={active.hostname || "Not reported"} />
        <DetailItem label="User" value={active.username || "Not reported"} />
        <DetailItem label="Platform" value={`${active.os || "unknown"}/${active.arch || "unknown"}`} mono />
        <DetailItem label="Process" value={active.pid === undefined ? "Not reported" : String(active.pid)} mono />
        <DetailItem label="Transport" value={active.transport.toUpperCase()} />
        <DetailItem label="Remote" value={active.remoteAddress || "Not reported"} mono />
        <div className="col-span-2"><DetailItem label="Active C2" value={active.activeC2 || "Not reported"} mono /></div>
        <div className="col-span-2"><DetailItem label="Executable" value={active.executable || "Not reported"} mono /></div>
        <DetailItem label="Version" value={active.version || "Not reported"} />
        <DetailItem label="Locale" value={active.locale || "Not reported"} mono />
        <DetailItem label="Integrity" value={active.integrity || "Not reported"} />
        <DetailItem label="Burned" value={active.burned ? "Yes" : "No"} />
        <DetailItem label="First contact" value={formatTimestamp(active.firstContactAt)} />
        <DetailItem label="Last check-in" value={formatTimestamp(active.lastCheckinAt)} />
        {active.mode === "session" ? (
          <DetailItem label="Reconnect" value={formatDuration(active.reconnectIntervalMs)} />
        ) : (
          <>
            <DetailItem label="Next check-in" value={formatTimestamp(active.nextCheckinAt)} />
            <DetailItem label="Interval / jitter" value={`${formatDuration(active.intervalMs)} / ${formatDuration(active.jitterMs)}`} />
            <DetailItem label="Tasks" value={beaconTaskCountLabel(active)} />
          </>
        )}
      </div>

      {active.mode === "beacon" ? (
        <div className="border-b border-separator px-4 py-3">
          <Switch
            aria-label="Watch active beacon"
            isDisabled={isChangingWatch || !capabilityFor(capabilities, "beacon.tasks.read")?.available}
            isSelected={watchEnabled}
            onChange={onWatchChange}
          >
            <Switch.Content className="min-w-0 flex-1">
              <span className="block text-xs font-medium text-foreground">Watch active beacon</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">Refresh tasks between normal check-ins for this window.</span>
            </Switch.Content>
            <Switch.Control><Switch.Thumb /></Switch.Control>
          </Switch>
        </div>
      ) : null}

      <div className="px-4 py-4">
        <h3 className="text-xs font-semibold text-foreground">Capabilities</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {capabilities.map((capability) => (
            <Tooltip delay={250} key={capability.id}>
              <Chip color={capability.available ? "success" : "default"} size="sm" variant="soft">
                {capabilityLabel(capability.id)}
              </Chip>
              <Tooltip.Content>{capability.available ? "Available" : capability.reason?.message ?? "Unavailable"}</Tooltip.Content>
            </Tooltip>
          ))}
        </div>
        {capabilities.some((capability) => !capability.available) ? (
          <ul className="mt-3 flex flex-col gap-1.5 text-[11px] leading-relaxed text-muted" aria-label="Unavailable capability reasons">
            {capabilities.filter((capability) => !capability.available).map((capability) => (
              <li key={capability.id}><span className="font-medium text-foreground">{capabilityLabel(capability.id)}:</span> {capability.reason?.message ?? "Unavailable"}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="border-t border-separator px-4 py-4">
        <OperationComposer
          active={active}
          targetIdentity={operationTargetIdentity}
          capabilities={capabilities}
          onSubmitted={onOperationSubmitted}
        />
      </div>

      <div className="flex flex-wrap gap-2 border-t border-separator px-4 py-4">
        {lifecycleActions.map((action) => {
          const capability = capabilityFor(capabilities, lifecycleCapabilityId(action));
          const unavailableReason = capability?.reason?.message ?? "This action is unavailable for the current target";
          return (
            <Tooltip delay={250} key={action}>
              <Button
                isDisabled={isBusy || capability?.available !== true}
                size="sm"
                variant="danger-soft"
                onPress={() => onPrepareAction(action)}
              >
                <FontAwesomeIcon aria-hidden icon={action === "beacon.remove" ? faTrash : action === "session.close" ? faStop : faSkullCrossbones} />
                {targetActionLabel(action)}
              </Button>
              <Tooltip.Content>{capability?.available ? targetActionLabel(action) : unavailableReason}</Tooltip.Content>
            </Tooltip>
          );
        })}
      </div>
    </aside>
  );
}

export function OperationComposer({
  active,
  targetIdentity,
  capabilities,
  onSubmitted,
}: {
  active: TargetSummary;
  targetIdentity: string;
  capabilities: SliverSnapshot["targetContext"]["capabilities"];
  onSubmitted: (operation: TargetOperationRecord) => boolean;
}): React.JSX.Element {
  const [draft, setDraft] = useState<OperationDraft>(DEFAULT_OPERATION_DRAFT);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const targetIdentityRef = useRef(targetIdentity);
  targetIdentityRef.current = targetIdentity;
  const availableOperations = useMemo<TargetOperationId[]>(() => active.mode === "beacon"
    ? ["target.ping", "target.rename", "target.env-set", "target.env-unset", "beacon.reconfigure", "beacon.open-session"]
    : ["target.ping", "target.rename", "target.env-set", "target.env-unset"], [active.mode]);
  const capability = capabilityFor(capabilities, OPERATION_CAPABILITIES[draft.operationId]);

  useEffect(() => {
    if (!availableOperations.includes(draft.operationId)) {
      setDraft({ ...DEFAULT_OPERATION_DRAFT, operationId: availableOperations[0] ?? "target.ping" });
    }
  }, [availableOperations, draft.operationId]);

  useEffect(() => {
    setDraft(DEFAULT_OPERATION_DRAFT);
    setError(undefined);
    setIsSubmitting(false);
  }, [targetIdentity]);

  const submit = useCallback(async () => {
    const submittedTargetIdentity = targetIdentity;
    let input: TargetOperationInput;
    try {
      input = operationInputFromDraft(draft);
      setError(undefined);
    } catch (validationError) {
      setError(errorMessage(validationError));
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await window.sliver.submitTargetOperation(input);
      if (submittedTargetIdentity !== targetIdentityRef.current) return;
      if (!result.ok || !result.value) {
        setError(result.error ?? "The operation was rejected");
        return;
      }
      if (!onSubmitted(result.value)) return;
      toast.success("Operation submitted", {
        description: `${operationLabel(result.value.operationId)} · ${result.value.targetName}`,
      });
      setDraft((current) => ({ ...DEFAULT_OPERATION_DRAFT, operationId: current.operationId }));
    } catch (submitError) {
      if (submittedTargetIdentity !== targetIdentityRef.current) return;
      setError(errorMessage(submitError));
    } finally {
      if (submittedTargetIdentity === targetIdentityRef.current) setIsSubmitting(false);
    }
  }, [draft, onSubmitted, targetIdentity]);

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Run operation</h3>
          <p className="mt-0.5 text-[11px] text-muted">The main process binds this request to the selected target.</p>
        </div>
        <Dropdown>
          <Button size="sm" variant="tertiary">
            {operationLabel(draft.operationId)} <FontAwesomeIcon aria-hidden icon={faChevronDown} />
          </Button>
          <Dropdown.Popover className="min-w-64" placement="bottom end">
            <Dropdown.Menu
              aria-label="Target operation"
              selectionMode="single"
              selectedKeys={new Set([draft.operationId])}
              onAction={(key) => {
                setDraft({ ...DEFAULT_OPERATION_DRAFT, operationId: String(key) as TargetOperationId });
                setError(undefined);
              }}
            >
              {availableOperations.map((operationId) => (
                <Dropdown.Item id={operationId} key={operationId} textValue={operationLabel(operationId)}>
                  <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={operationIcon(operationId)} />
                  <Label>{operationLabel(operationId)}</Label>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>

      <div className="mt-3 flex flex-col gap-3">
        {draft.operationId === "target.rename" ? (
          <Field label="New target name" value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} />
        ) : null}
        {draft.operationId === "target.env-set" ? (
          <>
            <Field label="Variable name" mono value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} />
            <AreaField label="Variable value" mono rows={3} value={draft.value} onChange={(value) => setDraft((current) => ({ ...current, value }))} />
          </>
        ) : null}
        {draft.operationId === "target.env-unset" ? (
          <Field label="Variable name" mono value={draft.name} onChange={(name) => setDraft((current) => ({ ...current, name }))} />
        ) : null}
        {draft.operationId === "beacon.reconfigure" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reconnect seconds" type="number" min={1} value={draft.reconnectIntervalSeconds} onChange={(value) => setDraft((current) => ({ ...current, reconnectIntervalSeconds: value }))} />
              <Field label="Interval seconds" type="number" min={1} value={draft.intervalSeconds} onChange={(value) => setDraft((current) => ({ ...current, intervalSeconds: value }))} />
              <Field label="Jitter seconds" type="number" min={1} value={draft.jitterSeconds} onChange={(value) => setDraft((current) => ({ ...current, jitterSeconds: value }))} />
            </div>
            <p className="text-[11px] leading-relaxed text-muted">
              Timing changes only. The server does not expose an authoritative alternate C2 list.
            </p>
          </>
        ) : null}
        {draft.operationId === "beacon.open-session" ? (
          <div className="flex flex-col gap-2">
            <Field label="Delay seconds" type="number" min={0} value={draft.delaySeconds} onChange={(value) => setDraft((current) => ({ ...current, delaySeconds: value }))} />
            <p className="text-[11px] leading-relaxed text-muted">
              Uses the main-owned current ActiveC2 for this beacon.
            </p>
          </div>
        ) : null}

        {!capability?.available ? (
          <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="status">
            {capability?.reason?.message ?? "This operation is unavailable for the selected target."}
          </p>
        ) : null}
        {error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger-soft-foreground" role="alert">{error}</p> : null}

        <Button
          isDisabled={!capability?.available}
          isPending={isSubmitting}
          size="sm"
          onPress={() => void submit()}
        >
          <FontAwesomeIcon aria-hidden icon={faPlay} /> Run {operationLabel(draft.operationId).toLocaleLowerCase()}
        </Button>
      </div>
    </div>
  );
}

function OperationHistory({
  operations,
  page,
  error,
  isLoading,
  isLoadingMore,
  onLoadMore,
  onOpen,
  onRefresh,
}: {
  operations: TargetOperationRecord[];
  page: PageSummary | undefined;
  error: string | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  onLoadMore: (cursor: string) => void;
  onOpen: (operation: TargetOperationRecord) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<TargetOperationRecord>[]>(() => [
    {
      id: "operation",
      header: "Operation",
      isRowHeader: true,
      minWidth: 190,
      cell: (operation) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{operationLabel(operation.operationId)}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{operation.requestId}</p>
        </div>
      ),
    },
    {
      id: "target",
      header: "Target",
      minWidth: 170,
      cell: (operation) => (
        <div className="min-w-0 text-xs">
          <p className="truncate text-foreground">{operation.targetName}</p>
          <p className="mt-0.5 capitalize text-muted">{operation.mode}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      accessorKey: "state",
      minWidth: 150,
      cell: (operation) => <Chip color={operationStateColor(operation.state)} size="sm" variant="soft">{operationStateLabel(operation.state)}</Chip>,
    },
    {
      id: "owner",
      header: "Origin",
      minWidth: 120,
      cell: (operation) => <OwnershipChip ownership={operation.ownership} />,
    },
    {
      id: "updated",
      header: "Updated",
      accessorKey: "updatedAt",
      allowsSorting: true,
      minWidth: 190,
      cell: (operation) => <span className="text-xs tabular-nums text-muted">{formatTimestamp(operation.updatedAt)}</span>,
    },
  ], []);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby="operation-history-heading">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></span>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground" id="operation-history-heading">All target operations</h2>
            <p className="text-xs text-muted">Across sessions and beacons on this backend; local requests retain their owning window.</p>
          </div>
        </div>
        <Tooltip delay={250}>
          <Button aria-label="Refresh operation history" isDisabled={isLoadingMore} isIconOnly isPending={isLoading} size="sm" variant="ghost" onPress={onRefresh}>
            <FontAwesomeIcon aria-hidden icon={faRotate} />
          </Button>
          <Tooltip.Content>Refresh operation history</Tooltip.Content>
        </Tooltip>
      </div>
      {error ? <InlineNotice tone="danger" message={error} /> : null}
      <DataGrid
        aria-label="Target operation history"
        columns={columns}
        contentClassName="min-w-[820px]"
        data={operations}
        defaultSortDescriptor={{ column: "updated", direction: "descending" }}
        getRowId={(operation) => operation.requestId}
        scrollContainerClassName="max-h-[420px] overflow-auto"
        variant="secondary"
        onRowAction={(key) => {
          const operation = operations.find((item) => item.requestId === String(key));
          if (operation) onOpen(operation);
        }}
        renderEmptyState={() => (
          <EmptyState className="min-h-56 px-6 py-10" size="sm">
            <EmptyState.Media><FontAwesomeIcon aria-hidden icon={faClockRotateLeft} /></EmptyState.Media>
            <EmptyState.Content>
              <EmptyState.Title>No operations yet</EmptyState.Title>
              <EmptyState.Description>Submitted target operations will remain visible here as they progress.</EmptyState.Description>
            </EmptyState.Content>
          </EmptyState>
        )}
      />
      <HistoryPagingFooter
        boundedMessage="Older operation records are not available from this window's bounded history."
        isLoadingMore={isLoadingMore}
        itemLabel="operations"
        loadedCount={operations.length}
        page={page}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}

function OperatorPresence({ snapshot }: { snapshot: SliverSnapshot }): React.JSX.Element {
  return (
    <aside className="min-w-0 self-start overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby="operators-heading">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faUserGroup} /></span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground" id="operators-heading">Operator presence</h2>
          <p className="text-xs text-muted">Read-only server presence; attribution is never inferred.</p>
        </div>
      </div>
      {snapshot.domains.operators.error ? <InlineNotice tone="danger" message={snapshot.domains.operators.error} /> : null}
      <ScrollShadow className="max-h-[360px] overflow-y-auto" hideScrollBar={false} size={20}>
        {snapshot.operators.length > 0 ? (
          <ul className="divide-y divide-separator" aria-label="Connected operators">
            {snapshot.operators.map((operator) => (
              <li className="flex items-center justify-between gap-3 px-4 py-3" key={operator.id}>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{operator.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{operator.id}</p>
                </div>
                <Chip color={operator.online ? "success" : "default"} size="sm" variant="soft">
                  {operator.online ? "Online" : "Offline"}
                </Chip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 pb-4 text-xs leading-relaxed text-muted">No operator presence records were returned by this server.</p>
        )}
      </ScrollShadow>
    </aside>
  );
}

function BeaconTasks({
  tasks,
  page,
  error,
  isLoading,
  isLoadingMore,
  watchEnabled,
  onLoadMore,
  onOpen,
  onRefresh,
}: {
  tasks: BeaconTaskSummary[];
  page: PageSummary | undefined;
  error: string | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  watchEnabled: boolean;
  onLoadMore: (cursor: string) => void;
  onOpen: (task: BeaconTaskSummary) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<BeaconTaskSummary>[]>(() => [
    {
      id: "task",
      header: "Task",
      isRowHeader: true,
      minWidth: 220,
      cell: (task) => (
        <div className="min-w-0 py-1">
          <p className="truncate text-sm font-medium text-foreground">{task.description || "Beacon task"}</p>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{task.taskId}</p>
        </div>
      ),
    },
    {
      id: "state",
      header: "State",
      accessorKey: "state",
      minWidth: 120,
      cell: (task) => <Chip color={taskStateColor(task.state)} size="sm" variant="soft">{capitalize(task.state)}</Chip>,
    },
    {
      id: "origin",
      header: "Origin",
      minWidth: 120,
      cell: (task) => <OwnershipChip ownership={task.ownership} />,
    },
    {
      id: "created",
      header: "Created",
      accessorKey: "createdAt",
      minWidth: 190,
      cell: (task) => <span className="text-xs tabular-nums text-muted">{formatTimestamp(task.createdAt)}</span>,
    },
    {
      id: "result",
      header: "Result",
      minWidth: 110,
      cell: (task) => <span className="text-xs text-muted">{task.resultAvailable ? "Available" : "Pending"}</span>,
    },
  ], []);

  return (
    <section className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface" aria-labelledby="beacon-tasks-heading">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="section-icon"><FontAwesomeIcon aria-hidden icon={faListCheck} /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-foreground" id="beacon-tasks-heading">Beacon tasks</h2>
              {watchEnabled ? <Chip color="accent" size="sm" variant="soft">Watching</Chip> : null}
            </div>
            <p className="text-xs text-muted">Server task metadata for the active beacon. Raw protobuf buffers remain in the main process.</p>
          </div>
        </div>
        <Tooltip delay={250}>
          <Button aria-label="Refresh beacon tasks" isDisabled={isLoadingMore} isIconOnly isPending={isLoading} size="sm" variant="ghost" onPress={onRefresh}>
            <FontAwesomeIcon aria-hidden icon={faRotate} />
          </Button>
          <Tooltip.Content>Refresh beacon tasks</Tooltip.Content>
        </Tooltip>
      </div>
      {error ? <InlineNotice tone="danger" message={error} /> : null}
      <DataGrid
        aria-label="Active beacon tasks"
        columns={columns}
        contentClassName="min-w-[760px]"
        data={tasks}
        getRowId={(task) => task.taskId}
        scrollContainerClassName="max-h-[380px] overflow-auto"
        variant="secondary"
        onRowAction={(key) => {
          const task = tasks.find((item) => item.taskId === String(key));
          if (task) onOpen(task);
        }}
        renderEmptyState={() => (
          <EmptyState className="min-h-48 px-6 py-10" size="sm">
            <EmptyState.Media><FontAwesomeIcon aria-hidden icon={faListCheck} /></EmptyState.Media>
            <EmptyState.Content>
              <EmptyState.Title>No beacon tasks</EmptyState.Title>
              <EmptyState.Description>Queued and completed operations for this beacon will appear here.</EmptyState.Description>
            </EmptyState.Content>
          </EmptyState>
        )}
      />
      <HistoryPagingFooter
        boundedMessage="Older task records are outside the available server task catalog."
        isLoadingMore={isLoadingMore}
        itemLabel="beacon tasks"
        loadedCount={tasks.length}
        page={page}
        onLoadMore={onLoadMore}
      />
    </section>
  );
}

function HistoryPagingFooter({
  boundedMessage,
  isLoadingMore,
  itemLabel,
  loadedCount,
  page,
  onLoadMore,
}: {
  boundedMessage: string;
  isLoadingMore: boolean;
  itemLabel: string;
  loadedCount: number;
  page: PageSummary | undefined;
  onLoadMore: (cursor: string) => void;
}): React.JSX.Element | null {
  if (!page) return null;
  const nextCursor = page.nextCursor;
  const total = Math.max(page.total, loadedCount);
  const isBounded = page.truncated && nextCursor === undefined;
  const boundedPrefix = loadedCount < page.total
    ? `Showing ${loadedCount} of ${page.total} ${itemLabel}. `
    : "This history is reported as truncated, and no additional page cursor is available. ";

  return (
    <>
      {isBounded ? <InlineNotice tone="warning" message={`${boundedPrefix}${boundedMessage}`} /> : null}
      <div className="flex min-h-12 items-center justify-between gap-3 border-t border-separator px-4 py-2.5">
        <p className="text-xs tabular-nums text-muted" aria-live="polite">
          Showing {loadedCount} of {total} {itemLabel}
        </p>
        {nextCursor !== undefined ? (
          <Button
            isPending={isLoadingMore}
            size="sm"
            variant="tertiary"
            onPress={() => onLoadMore(nextCursor)}
          >
            Load more {itemLabel}
          </Button>
        ) : null}
      </div>
    </>
  );
}

export function OperationDetailModal({
  isCurrent,
  operation,
  onChanged,
  onOpenChange,
}: {
  isCurrent: () => boolean;
  operation: TargetOperationRecord | undefined;
  onChanged: (operation: TargetOperationRecord) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  const [isCanceling, setIsCanceling] = useState(false);
  if (!operation) return null;

  const cancel = async () => {
    setIsCanceling(true);
    try {
      const result = await window.sliver.cancelTargetOperation({ requestId: operation.requestId });
      if (!isCurrent()) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not cancel operation", { description: result.error });
        return;
      }
      onChanged(result.value);
    } catch (error) {
      if (isCurrent()) toast.danger("Could not cancel operation", { description: errorMessage(error) });
    } finally {
      setIsCanceling(false);
    }
  };

  return (
    <Modal.Backdrop isOpen variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[720px]">
          <Modal.CloseTrigger isDisabled={isCanceling} />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground"><FontAwesomeIcon aria-hidden icon={operationIcon(operation.operationId)} /></Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>{operationLabel(operation.operationId)}</Modal.Heading>
              <p className="mt-1 truncate font-mono text-xs text-muted">{operation.requestId}</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <div className="grid gap-3 rounded-xl bg-default p-4 text-sm sm:grid-cols-2">
              <DetailItem label="Target" value={operation.targetName} />
              <DetailItem label="State" value={operationStateLabel(operation.state)} />
              <DetailItem label="Backend" value={operation.backend.server} mono />
              <DetailItem label="Operator" value={operation.backend.operator} />
              <DetailItem label="Created" value={formatTimestamp(operation.createdAt)} />
              <DetailItem label="Updated" value={formatTimestamp(operation.updatedAt)} />
              <DetailItem label="Attempts" value={String(operation.attempts)} mono />
              <DetailItem label="Task ID" value={operation.taskId ?? "Synchronous"} mono />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip color={operationStateColor(operation.state)} size="sm" variant="soft">{operationStateLabel(operation.state)}</Chip>
              <OwnershipChip ownership={operation.ownership} />
              {operation.progress ? (
                <span className="text-xs tabular-nums text-muted">
                  {operation.progress.completedUnits}{operation.progress.totalUnits === undefined ? "" : ` / ${operation.progress.totalUnits}`}
                  {operation.progress.message ? ` · ${operation.progress.message}` : ""}
                </span>
              ) : null}
            </div>
            {operation.message ? <InlineNotice tone={operation.state === "failed" ? "danger" : "default"} message={operation.message} /> : null}
            <DispositionView disposition={operation.disposition} />
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="tertiary">Close</Button>
            {isOperationCancelable(operation) ? (
              <Button isPending={isCanceling} variant="danger-soft" onPress={() => void cancel()}>
                <FontAwesomeIcon aria-hidden icon={faBan} /> Cancel operation
              </Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function TaskDetailModal({
  isCurrent,
  task,
  onChanged,
  onOpenChange,
}: {
  isCurrent: () => boolean;
  task: BeaconTaskDetail | undefined;
  onChanged: (task: BeaconTaskDetail) => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  const [isCanceling, setIsCanceling] = useState(false);
  if (!task) return null;

  const cancel = async () => {
    setIsCanceling(true);
    try {
      const result = await window.sliver.cancelBeaconTask({ taskId: task.taskId });
      if (!isCurrent()) return;
      if (!result.ok || !result.value) {
        toast.danger("Could not cancel beacon task", { description: result.error });
        return;
      }
      onChanged({ ...task, ...result.value });
    } catch (error) {
      if (isCurrent()) toast.danger("Could not cancel beacon task", { description: errorMessage(error) });
    } finally {
      setIsCanceling(false);
    }
  };

  return (
    <Modal.Backdrop isOpen variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[680px]">
          <Modal.CloseTrigger isDisabled={isCanceling} />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground"><FontAwesomeIcon aria-hidden icon={faListCheck} /></Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>{task.description || "Beacon task"}</Modal.Heading>
              <p className="mt-1 truncate font-mono text-xs text-muted">{task.taskId}</p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <div className="grid gap-3 rounded-xl bg-default p-4 text-sm sm:grid-cols-2">
              <DetailItem label="State" value={capitalize(task.state)} />
              <DetailItem label="Operation" value={task.operationId ? operationLabel(task.operationId) : "External or unknown"} />
              <DetailItem label="Created" value={formatTimestamp(task.createdAt)} />
              <DetailItem label="Sent" value={formatTimestamp(task.sentAt)} />
              <DetailItem label="Completed" value={formatTimestamp(task.completedAt)} />
              <DetailItem label="Local request" value={task.localRequestId ?? "Not locally owned"} mono />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip color={taskStateColor(task.state)} size="sm" variant="soft">{capitalize(task.state)}</Chip>
              <OwnershipChip ownership={task.ownership} />
            </div>
            {task.error ? <InlineNotice tone="danger" message={task.error} /> : null}
            <DispositionView disposition={task.disposition} />
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" variant="tertiary">Close</Button>
            {task.state === "pending" ? (
              <>
                {!task.cancellation.available && task.cancellation.reason ? (
                  <p className="mr-auto max-w-sm text-xs text-muted">{task.cancellation.reason}</p>
                ) : null}
                <Button
                  isDisabled={!task.cancellation.available}
                  isPending={isCanceling}
                  variant="danger-soft"
                  onPress={() => void cancel()}
                >
                  <FontAwesomeIcon aria-hidden icon={faBan} /> Cancel task
                </Button>
              </>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

export function DestructiveReviewModal({
  plan,
  result,
  isExecuting,
  onConfirm,
  onOpenChange,
}: {
  plan: TargetActionPlan | undefined;
  result: TargetActionExecutionResult | undefined;
  isExecuting: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element | null {
  if (!plan) return null;
  return (
    <Modal.Backdrop isOpen variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[680px]">
          <Modal.CloseTrigger isDisabled={isExecuting} />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-danger-soft text-danger-soft-foreground"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>{result ? "Target action results" : `Review ${targetActionLabel(plan.impact.actionId).toLocaleLowerCase()}`}</Modal.Heading>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                {result ? "The server outcomes below are reported individually." : plan.impact.warning}
              </p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-4">
            <div className="grid gap-3 rounded-xl bg-default p-4 text-sm sm:grid-cols-2">
              <DetailItem label="Server" value={plan.impact.backend.server} mono />
              <DetailItem label="Operator" value={plan.impact.backend.operator} />
              <DetailItem
                label="Targets"
                value={plan.impact.truncated
                  ? `${plan.impact.targets.length} of ${plan.impact.totalTargets}`
                  : String(plan.impact.totalTargets)}
                mono
              />
              <DetailItem label="Review expires" value={formatTimestamp(plan.expiresAt)} />
            </div>
            <ScrollShadow className="max-h-64 overflow-y-auto rounded-xl bg-default" hideScrollBar={false} size={20}>
              <ul className="divide-y divide-separator" aria-label="Affected targets">
                {(result?.outcomes ?? plan.impact.targets.map((target) => ({ target, status: undefined }))).map((item) => (
                  <li className="flex items-center justify-between gap-3 px-4 py-3" key={targetRowKey(item.target)}>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{item.target.name || item.target.hostname}</p>
                      <p className="mt-0.5 truncate font-mono text-[11px] text-muted">{item.target.id}</p>
                      {"error" in item && item.error ? <p className="mt-1 text-xs text-danger">{item.error}</p> : null}
                    </div>
                    {item.status ? <Chip color={actionOutcomeColor(item.status)} size="sm" variant="soft">{item.status.split("-").map(capitalize).join(" ")}</Chip> : <Chip size="sm" variant="soft">{capitalize(item.target.mode)}</Chip>}
                  </li>
                ))}
              </ul>
            </ScrollShadow>
            {!result ? (
              <InlineNotice
                tone="danger"
                message={plan.impact.truncated
                  ? `This one-use review is bound to the exact backend epoch and ${plan.impact.targets.length} targets shown above. ${plan.impact.totalTargets - plan.impact.targets.length} additional matching targets require another reviewed plan.`
                  : "This one-use review is bound to the exact backend epoch and target set shown above."}
              />
            ) : null}
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close" isDisabled={isExecuting} variant="tertiary">{result ? "Done" : "Cancel"}</Button>
            {!result ? (
              <Button isPending={isExecuting} variant="danger-soft" onPress={onConfirm}>
                <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /> {targetActionLabel(plan.impact.actionId)}
              </Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function DispositionView({ disposition }: { disposition: OperationDisposition | undefined }): React.JSX.Element {
  if (!disposition) {
    return (
      <div className="rounded-xl bg-default px-4 py-4 text-sm text-muted">
        No decoded result is available for this operation.
      </div>
    );
  }
  if (disposition.kind === "inline-text") {
    return (
      <div>
        <p className="mb-2 text-xs font-semibold text-foreground">Decoded output</p>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-default p-4 font-mono text-xs leading-relaxed text-foreground">{disposition.text}</pre>
        {disposition.truncated ? <p className="mt-2 text-xs text-warning">Output was truncated to the safe preview limit.</p> : null}
      </div>
    );
  }
  if (disposition.kind === "table") {
    return (
      <div className="overflow-auto rounded-xl bg-default">
        <table className="w-full min-w-[480px] text-left text-xs">
          <thead><tr>{disposition.columns.map((column) => <th className="px-3 py-2 font-medium text-muted" key={column}>{column}</th>)}</tr></thead>
          <tbody>{disposition.rows.map((row, rowIndex) => (
            <tr className="border-t border-separator" key={rowIndex}>
              {row.map((value, columnIndex) => <td className="px-3 py-2 text-foreground" key={columnIndex}>{String(value ?? "")}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    );
  }
  if (disposition.kind === "structured-detail") {
    return (
      <div className="rounded-xl bg-default p-4">
        <p className="text-xs font-semibold text-foreground">{disposition.title}</p>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          {disposition.fields.map((field) => <DetailItem key={field.label} label={field.label} value={String(field.value ?? "")} />)}
        </dl>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-xl bg-default p-4">
      <FontAwesomeIcon aria-hidden className="mt-0.5 text-accent" icon={faFileCode} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{dispositionLabel(disposition.kind)}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted">The main process retained this binary result behind a short-lived safe handle. Arbitrary paths and raw buffers are not exposed here.</p>
        {"suggestedFileName" in disposition ? <p className="mt-2 truncate font-mono text-xs text-foreground">{disposition.suggestedFileName}</p> : null}
      </div>
    </div>
  );
}

function MaintenanceMenu({
  disabled,
  mode,
  onAction,
}: {
  disabled: boolean;
  mode: TargetMode;
  onAction: (action: DestructiveTargetActionId) => void;
}): React.JSX.Element {
  return (
    <Dropdown>
      <Button isDisabled={disabled} size="sm" variant="tertiary">
        <FontAwesomeIcon aria-hidden icon={faBroom} /> Maintenance <FontAwesomeIcon aria-hidden icon={faChevronDown} />
      </Button>
      <Dropdown.Popover className="min-w-60" placement="bottom end">
        <Dropdown.Menu aria-label="Target maintenance" onAction={(key) => onAction(String(key) as DestructiveTargetActionId)}>
          {mode === "session" ? (
            <Dropdown.Item id="sessions.prune-dead" textValue="Prune dead sessions" variant="danger">
              <FontAwesomeIcon aria-hidden className="text-danger" icon={faComputer} />
              <Label>Prune dead sessions</Label>
            </Dropdown.Item>
          ) : (
            <Dropdown.Item id="beacons.prune-overdue" textValue="Prune overdue beacons" variant="danger">
              <FontAwesomeIcon aria-hidden className="text-danger" icon={faSatellite} />
              <Label>Prune overdue beacons</Label>
            </Dropdown.Item>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function OwnershipChip({ ownership }: { ownership: TargetOperationRecord["ownership"] }): React.JSX.Element {
  const verifiedActor = ownership.actor.attribution === "verified" ? ownership.actor.name : "Unknown actor";
  return (
    <Tooltip delay={250}>
      <Chip color={ownership.origin === "local" ? "accent" : "default"} size="sm" variant="soft">
        {ownership.origin === "local"
          ? "This window"
          : ownership.origin === "external"
            ? "External"
            : "Unknown origin"}
      </Chip>
      <Tooltip.Content>{verifiedActor}</Tooltip.Content>
    </Tooltip>
  );
}

function lifecycleCapabilityId(action: DestructiveTargetActionId): TargetCapabilityId {
  if (action === "target.kill") return "target.terminate";
  if (action === "session.close") return "session.close";
  if (action === "beacon.remove") return "beacon.remove";
  throw new Error(`Unsupported singular target action: ${action}`);
}

function TargetCatalogPaging({
  filter,
  sessionsLoaded,
  beaconsLoaded,
  sessionPage,
  beaconPage,
  loadingModes,
  disabled,
  onLoadMore,
}: {
  filter: TargetModeFilter;
  sessionsLoaded: number;
  beaconsLoaded: number;
  sessionPage: PageSummary;
  beaconPage: PageSummary;
  loadingModes: ReadonlySet<TargetMode>;
  disabled: boolean;
  onLoadMore: (mode: TargetMode, cursor: string) => void;
}): React.JSX.Element | null {
  const showSessions = filter !== "beacon" && sessionPage.truncated;
  const showBeacons = filter !== "session" && beaconPage.truncated;
  const sessionCursor = sessionPage.nextCursor;
  const beaconCursor = beaconPage.nextCursor;
  if (!showSessions && !showBeacons) return null;
  const loaded = filter === "session"
    ? sessionsLoaded
    : filter === "beacon"
      ? beaconsLoaded
      : sessionsLoaded + beaconsLoaded;
  const total = filter === "session"
    ? sessionPage.total
    : filter === "beacon"
      ? beaconPage.total
      : sessionPage.total + beaconPage.total;
  const itemLabel = filter === "session" ? "sessions" : filter === "beacon" ? "beacons" : "targets";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <p className="text-xs tabular-nums text-muted" role="status">Showing {loaded} of {total} {itemLabel}</p>
      <div className="flex flex-wrap items-center gap-2">
        {showSessions && sessionCursor ? (
          <Button
            isDisabled={disabled || loadingModes.has("session")}
            isPending={loadingModes.has("session")}
            size="sm"
            variant="secondary"
            onPress={() => onLoadMore("session", sessionCursor)}
          >
            Load more sessions
          </Button>
        ) : null}
        {showBeacons && beaconCursor ? (
          <Button
            isDisabled={disabled || loadingModes.has("beacon")}
            isPending={loadingModes.has("beacon")}
            size="sm"
            variant="secondary"
            onPress={() => onLoadMore("beacon", beaconCursor)}
          >
            Load more beacons
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function targetCatalogIdentity(snapshot: SliverSnapshot, mode: TargetMode): string {
  return [
    snapshot.connection.epoch ?? "disconnected",
    snapshot.connection.incarnation ?? 0,
    mode,
    mode === "session" ? snapshot.domains.sessions.revision : snapshot.domains.beacons.revision,
  ].join(":");
}

function seedTargetInventory(snapshot: SliverSnapshot, mode: TargetMode): TargetInventoryState {
  const refs: Record<string, TargetRef> = {};
  for (const ref of snapshot.targetContext.selectableTargets) refs[`${ref.mode}:${ref.id}`] = ref;
  if (snapshot.targetContext.activeTarget) {
    refs[`${snapshot.targetContext.activeTarget.mode}:${snapshot.targetContext.activeTarget.id}`] =
      snapshot.targetContext.activeTarget;
  }
  const sessions = [...snapshot.sessions];
  const beacons = [...snapshot.beacons];
  const active = snapshot.targetContext.activeTargetSummary;
  if (active?.mode === "session" && !sessions.some((target) => target.id === active.id)) sessions.push(active);
  if (active?.mode === "beacon" && !beacons.some((target) => target.id === active.id)) beacons.push(active);
  return {
    identity: targetCatalogIdentity(snapshot, mode),
    sessions,
    beacons,
    refs,
    sessionPage: { ...snapshot.domains.sessions.page },
    beaconPage: { ...snapshot.domains.beacons.page },
  };
}

function emptyTargetInventory(identity: string): TargetInventoryState {
  return {
    identity,
    sessions: [],
    beacons: [],
    refs: {},
    sessionPage: { limit: 100, total: 0, truncated: false },
    beaconPage: { limit: 100, total: 0, truncated: false },
  };
}

function targetModesForFilter(filter: TargetModeFilter): TargetMode[] {
  if (filter === "all") return ["session", "beacon"];
  return [filter];
}

function DomainNotice({
  status,
  error,
  mode,
  truncated,
}: {
  status: "loading" | "error" | "unsupported" | "ready";
  error: string | undefined;
  mode: TargetMode;
  truncated: boolean;
}): React.JSX.Element | null {
  const label = mode === "session" ? "session" : "beacon";
  if (status === "loading") return <InlineNotice tone="default" message={`Refreshing ${label} inventory…`} pending />;
  if (status === "unsupported") return <InlineNotice tone="warning" message={error ?? `This server does not support ${label} inventory.`} />;
  if (status === "error") return <InlineNotice tone="danger" message={error ?? `${capitalize(label)} inventory could not be refreshed.`} />;
  if (truncated) return <InlineNotice tone="default" message={`Additional ${label}s are available from the bounded server catalog.`} />;
  return null;
}

function InlineNotice({
  message,
  tone,
  pending = false,
}: {
  message: string;
  tone: "default" | "warning" | "danger";
  pending?: boolean;
}): React.JSX.Element {
  const style = tone === "danger"
    ? "bg-danger-soft text-danger-soft-foreground"
    : tone === "warning"
      ? "bg-warning-soft text-warning-soft-foreground"
      : "bg-default text-muted";
  return (
    <div className={`flex items-start gap-2.5 px-4 py-3 text-xs leading-relaxed ${style}`} role={tone === "danger" ? "alert" : "status"}>
      <FontAwesomeIcon aria-hidden className={pending ? "mt-0.5 animate-spin" : "mt-0.5"} icon={pending ? faCircleNotch : tone === "danger" ? faTriangleExclamation : faCircleInfo} />
      <p>{message}</p>
    </div>
  );
}

function DetailItem({ label, value, mono = false }: { label: string; value: string; mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className={`mt-0.5 break-words text-xs text-foreground ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function appendUnique<T>(current: T[], incoming: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set(current.map(keyFor));
  return [
    ...current,
    ...incoming.filter((item) => {
      const key = keyFor(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}

export async function openOperationDetail(
  operation: TargetOperationRecord,
  setOperation: (operation: TargetOperationRecord) => void,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const result = await window.sliver.getTargetOperation({ requestId: operation.requestId });
    if (!isCurrent()) return;
    if (!result.ok || !result.value) {
      toast.danger("Could not load operation", { description: result.error });
      return;
    }
    setOperation(result.value);
  } catch (error) {
    if (!isCurrent()) return;
    toast.danger("Could not load operation", { description: errorMessage(error) });
  }
}

async function openTaskDetail(
  task: BeaconTaskSummary,
  setTask: (task: BeaconTaskDetail) => void,
  isCurrent: () => boolean,
): Promise<void> {
  try {
    const result = await window.sliver.getBeaconTask({ taskId: task.taskId });
    if (!isCurrent()) return;
    if (!result.ok || !result.value) {
      toast.danger("Could not load beacon task", { description: result.error });
      return;
    }
    setTask(result.value);
  } catch (error) {
    if (!isCurrent()) return;
    toast.danger("Could not load beacon task", { description: errorMessage(error) });
  }
}

function operationInputFromDraft(draft: OperationDraft): TargetOperationInput {
  switch (draft.operationId) {
    case "target.ping":
      return { operationId: "target.ping" };
    case "target.rename": {
      const name = draft.name.trim();
      if (!name) throw new Error("Enter a new target name.");
      return { operationId: "target.rename", name };
    }
    case "target.env-set": {
      const name = draft.name.trim();
      if (!name) throw new Error("Enter an environment variable name.");
      return { operationId: "target.env-set", name, value: draft.value };
    }
    case "target.env-unset": {
      const name = draft.name.trim();
      if (!name) throw new Error("Enter an environment variable name.");
      return { operationId: "target.env-unset", name };
    }
    case "beacon.reconfigure": {
      const reconnectIntervalSeconds = optionalInteger(draft.reconnectIntervalSeconds, "Reconnect seconds", 1);
      const intervalSeconds = optionalInteger(draft.intervalSeconds, "Interval seconds", 1);
      const jitterSeconds = optionalInteger(draft.jitterSeconds, "Jitter seconds", 1);
      if (reconnectIntervalSeconds === undefined && intervalSeconds === undefined && jitterSeconds === undefined) {
        throw new Error("Change at least one beacon setting.");
      }
      return {
        operationId: "beacon.reconfigure",
        ...(reconnectIntervalSeconds === undefined ? {} : { reconnectIntervalSeconds }),
        ...(intervalSeconds === undefined ? {} : { intervalSeconds }),
        ...(jitterSeconds === undefined ? {} : { jitterSeconds }),
      };
    }
    case "beacon.open-session":
      return {
        operationId: "beacon.open-session",
        delaySeconds: requiredInteger(draft.delaySeconds, "Delay seconds", 0),
      };
  }
}

function optionalInteger(value: string, label: string, minimum: number): number | undefined {
  if (!value.trim()) return undefined;
  return requiredInteger(value, label, minimum);
}

function requiredInteger(value: string, label: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label} must be an integer of ${minimum} or greater.`);
  return parsed;
}

function targetDomainStatus(snapshot: SliverSnapshot, mode: TargetMode): "loading" | "error" | "unsupported" | "ready" {
  const status = mode === "session" ? snapshot.domains.sessions.status : snapshot.domains.beacons.status;
  if (status === "loading") return "loading";
  if (status === "error") return "error";
  if (status === "unsupported") return "unsupported";
  return "ready";
}

function capabilityLabel(id: TargetCapabilityId): string {
  return ({
    "target.ping": "Ping",
    "target.rename": "Rename",
    "target.terminate": "Terminate",
    "target.task.execute": "Execute tasks",
    "target.environment.write": "Environment",
    "session.close": "Close session",
    "beacon.remove": "Remove beacon",
    "beacon.reconfigure": "Reconfigure",
    "beacon.open-session": "Open session",
    "beacon.tasks.read": "Read tasks",
    "beacon.tasks.cancel": "Cancel tasks",
  } as const)[id];
}

function operationIcon(operationId: OperationRecordId): typeof faPlay {
  if (operationId === "target.ping") return faBolt;
  if (operationId === "target.rename") return faPen;
  if (operationId === "target.env-set" || operationId === "target.env-unset") return faTerminal;
  if (operationId === "beacon.reconfigure") return faWrench;
  return faCodeBranch;
}

function targetActionLabel(action: DestructiveTargetActionId): string {
  return ({
    "target.kill": "Kill target",
    "session.close": "Close session",
    "beacon.remove": "Remove beacon",
    "sessions.prune-dead": "Prune dead sessions",
    "beacons.prune-overdue": "Prune overdue beacons",
  } as const)[action];
}

function targetRefIdentity(target: TargetRef | null | undefined): string | undefined {
  return target
    ? `${target.backendEpoch}:${target.mode}:${target.id}:${target.fingerprint}`
    : undefined;
}

function actionOutcomeColor(status: TargetActionExecutionResult["outcomes"][number]["status"]): "success" | "danger" | "warning" | "default" {
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  if (status === "outcome-unknown") return "warning";
  return "default";
}

function dispositionLabel(kind: OperationDisposition["kind"]): string {
  if (kind === "native-save") return "Native save available";
  if (kind === "loot-save") return "Loot save available";
  if (kind === "binary-preview") return "Binary preview available";
  if (kind === "stream-attachment") return "Stream attachment available";
  return "Decoded result";
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
