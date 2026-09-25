import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertDialog,
  Button,
  Chip,
  Spinner,
  Tooltip,
  toast,
} from "@heroui/react";
import {
  ItemCard,
  ItemCardGroup,
  Segment,
  Sheet,
} from "@heroui-pro/react";
import { DataGrid } from "@heroui-pro/react/data-grid";
import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faChevronRight,
  faDownload,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";

import type {
  ExecutionActionDraft,
  ExecutionActionPlan,
  ExecutionActionResult,
  ExecutionCapability,
  ExecutionCatalog,
  ExecutionChildSummary,
  ExecutionOperationId,
  ExecutionPrivilegeSummary,
  ExecutionPrivilegesResult,
  ExecutionReadOperationId,
  ExecutionReadResult,
  ExecutionResultState,
  ExecuteProcessDraft,
} from "../../../shared/execution-contracts";
import type { TargetRef, TargetSummary } from "../../../shared/target-contracts";
import { ProcessExecutionView } from "./ProcessExecutionView";
import {
  addProcessExecution,
  clearProcessExecution,
  updateProcessExecution,
  useProcessExecutionHistory,
  type ProcessExecutionRecord,
} from "./process-execution-history";
import { ExecutionActionForm } from "./target-execution-forms";
import {
  EXECUTION_CATEGORIES,
  executionActionPresentation,
  executionCapabilitySupportsTarget,
  executionCategoryPresentation,
  executionRiskColor,
  executionRiskLabel,
  type ExecutionCategoryId,
} from "./target-execution-model";

const ACTION_FORM_ID = "target-execution-action-form";

export interface TargetExecutionWorkbenchProps {
  expectedTarget: TargetRef;
  targetIdentity: string;
}

type CatalogState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; value: ExecutionCatalog };

type ReadState =
  | { status: "idle" }
  | { status: "loading"; operationId: ExecutionReadOperationId }
  | { status: "error"; operationId: ExecutionReadOperationId; error: string }
  | { status: "ready"; value: ExecutionReadResult; isLoadingMore: boolean };

export function TargetExecutionWorkbench({
  expectedTarget,
  targetIdentity,
}: TargetExecutionWorkbenchProps): React.JSX.Element {
  const selectionIdentity = targetSelectionIdentity(targetIdentity, expectedTarget);
  const exactIdentity = targetExecutionIdentity(targetIdentity, expectedTarget);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const catalogIsCurrent = catalogState.status === "ready" &&
    targetRefsEqual(catalogState.value.targetRef, expectedTarget);
  const [category, setCategory] = useState<ExecutionCategoryId>("process");
  const [selectedCapability, setSelectedCapability] = useState<ExecutionCapability>();
  const [isPreparing, setIsPreparing] = useState(false);
  const [plan, setPlan] = useState<ExecutionActionPlan>();
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState<ExecutionActionResult>();
  const [savingStream, setSavingStream] = useState<"stdout" | "stderr" | "combined">();
  const [addingToLoot, setAddingToLoot] = useState(false);
  // null explicitly opens the new-execution composer; undefined defaults to the newest retained run.
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>();
  const [readState, setReadState] = useState<ReadState>({ status: "idle" });
  const identityRef = useRef(exactIdentity);
  identityRef.current = exactIdentity;
  const selectionIdentityRef = useRef(selectionIdentity);
  selectionIdentityRef.current = selectionIdentity;
  const previousSelectionIdentity = useRef<string | undefined>(undefined);
  const expectedTargetRef = useRef(expectedTarget);
  expectedTargetRef.current = expectedTarget;
  const planRef = useRef<ExecutionActionPlan | undefined>(undefined);
  planRef.current = plan;
  const resultRef = useRef<ExecutionActionResult | undefined>(undefined);
  resultRef.current = result;
  const readStateRef = useRef<ReadState>({ status: "idle" });
  readStateRef.current = readState;
  const catalogRequestSequence = useRef(0);
  const prepareRequestSequence = useRef(0);
  const executeRequestSequence = useRef(0);
  const readRequestSequence = useRef(0);
  const resultRequestSequence = useRef(0);
  const saveRequestSequence = useRef(0);
  const lootRequestSequence = useRef(0);
  const actionButtons = useRef(new Map<ExecutionOperationId, HTMLButtonElement>());
  const lastAction = useRef<ExecutionOperationId | undefined>(undefined);
  const preparedProcessDraft = useRef<Pick<ExecuteProcessDraft, "path" | "args"> | undefined>(undefined);

  const discardToken = useCallback((token: string): void => {
    void window.sliver.discardExecutionPlan({ token }).catch(() => undefined);
  }, []);

  const restoreActionFocus = useCallback((): void => {
    const operationId = lastAction.current;
    if (!operationId) return;
    window.setTimeout(() => actionButtons.current.get(operationId)?.focus(), 0);
  }, []);

  const clearPreparedPlan = useCallback((restoreFocus: boolean): void => {
    const current = planRef.current;
    planRef.current = undefined;
    preparedProcessDraft.current = undefined;
    setPlan(undefined);
    if (current) discardToken(current.token);
    if (restoreFocus) restoreActionFocus();
  }, [discardToken, restoreActionFocus]);

  const loadCatalog = useCallback(async (preserveCurrent = false): Promise<void> => {
    const expectedIdentity = exactIdentity;
    const sequence = ++catalogRequestSequence.current;
    if (!preserveCurrent) setCatalogState({ status: "loading" });
    try {
      const response = await window.sliver.listExecutionCatalog();
      if (sequence !== catalogRequestSequence.current || expectedIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) {
        setCatalogState({ status: "error", error: response.error ?? "Execution catalog is unavailable" });
        return;
      }
      if (
        !targetRefsEqual(response.value.targetRef, expectedTargetRef.current) ||
        response.value.target.mode !== response.value.targetRef.mode ||
        response.value.target.id !== response.value.targetRef.id ||
        response.value.backend.epoch !== response.value.targetRef.backendEpoch
      ) {
        setCatalogState({
          status: "error",
          error: "The execution catalog no longer matches this exact target selection. Reselect the target and try again.",
        });
        return;
      }
      setCatalogState({ status: "ready", value: response.value });
    } catch (error) {
      if (sequence === catalogRequestSequence.current && expectedIdentity === identityRef.current) {
        setCatalogState({ status: "error", error: errorMessage(error) });
      }
    }
  }, [exactIdentity]);

  useEffect(() => {
    const selectionChanged = previousSelectionIdentity.current !== selectionIdentity;
    previousSelectionIdentity.current = selectionIdentity;
    catalogRequestSequence.current += 1;
    prepareRequestSequence.current += 1;
    if (selectionChanged) executeRequestSequence.current += 1;
    readRequestSequence.current += 1;
    resultRequestSequence.current += 1;
    saveRequestSequence.current += 1;
    lootRequestSequence.current += 1;
    const stalePlan = planRef.current;
    planRef.current = undefined;
    preparedProcessDraft.current = undefined;
    if (stalePlan) discardToken(stalePlan.token);
    setSelectedCapability(undefined);
    setIsPreparing(false);
    setPlan(undefined);
    if (selectionChanged) setIsExecuting(false);
    setSavingStream(undefined);
    setAddingToLoot(false);
    if (selectionChanged) {
      setCategory("process");
      resultRef.current = undefined;
      setResult(undefined);
      setSelectedProcessId(undefined);
      readStateRef.current = { status: "idle" };
      setReadState({ status: "idle" });
    } else if (readStateRef.current.status === "loading") {
      readStateRef.current = { status: "idle" };
      setReadState({ status: "idle" });
    }
    // A new domain revision invalidates exact action references, but its
    // settled catalog can stay visible until main validates the new reference.
    void loadCatalog(!selectionChanged);
  }, [discardToken, exactIdentity, loadCatalog, selectionIdentity]);

  useEffect(() => () => {
    const current = planRef.current;
    planRef.current = undefined;
    if (current) discardToken(current.token);
  }, [discardToken, exactIdentity]);

  const catalog = catalogState.status === "ready" ? catalogState.value : undefined;
  const capabilities = useMemo(() => catalog
    ? catalog.capabilities.filter((capability) => executionCapabilitySupportsTarget(capability, catalog.target))
    : [], [catalog]);
  const categoryCapabilities = useMemo(() => capabilities.filter((capability) =>
    executionActionPresentation(capability.operationId).category === category), [capabilities, category]);
  const categoryCopy = executionCategoryPresentation(category);
  const processHistoryKey = catalog ? JSON.stringify([
    catalog.backend.configId,
    catalog.backend.epoch,
    catalog.target.mode,
    catalog.target.id,
    catalog.targetRef.fingerprint,
  ]) : undefined;
  const processHistory = useProcessExecutionHistory(processHistoryKey);

  const runRead = useCallback(async (
    operationId: ExecutionReadOperationId,
    cursor?: string,
    taskId?: string,
    background = false,
  ): Promise<void> => {
    if (!catalogIsCurrent && !background) return;
    const expectedIdentity = exactIdentity;
    const sequence = ++readRequestSequence.current;
    const append = cursor !== undefined;
    if (!background) {
      setReadState((current) => append && current.status === "ready"
        ? { ...current, isLoadingMore: true }
        : { status: "loading", operationId });
    }
    try {
      const response = await window.sliver.runExecutionRead({
        operationId,
        limit: 100,
        ...(taskId ? { taskId } : {}),
        ...(cursor ? { cursor } : {}),
      });
      if (sequence !== readRequestSequence.current || expectedIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) {
        if (!background) {
          setReadState({ status: "error", operationId, error: response.error ?? "Execution read failed" });
        }
        return;
      }
      if (response.value.operationId !== operationId) {
        if (!background) {
          setReadState({ status: "error", operationId, error: "The returned read did not match the requested operation." });
        }
        return;
      }
      setReadState((current) => {
        const next: ReadState = {
          status: "ready",
          value: append && current.status === "ready"
            ? mergeReadResults(current.value, response.value)
            : response.value,
          isLoadingMore: false,
        };
        readStateRef.current = next;
        return next;
      });
    } catch (error) {
      if (
        !background &&
        sequence === readRequestSequence.current &&
        expectedIdentity === identityRef.current
      ) {
        setReadState({ status: "error", operationId, error: errorMessage(error) });
      }
    }
  }, [catalogIsCurrent, exactIdentity]);

  const beginAction = useCallback((capability: ExecutionCapability): void => {
    if (!catalogIsCurrent || !capability.available) return;
    if (planRef.current) clearPreparedPlan(false);
    lastAction.current = capability.operationId;
    resultRequestSequence.current += 1;
    resultRef.current = undefined;
    setResult(undefined);
    if (isReadOperation(capability.operationId)) {
      setSelectedCapability(undefined);
      void runRead(capability.operationId);
      return;
    }
    readRequestSequence.current += 1;
    setReadState({ status: "idle" });
    setSelectedCapability(capability);
  }, [catalogIsCurrent, clearPreparedPlan, runRead]);

  const retainProcessResult = useCallback(async (
    historyKey: string,
    recordId: string,
    value: ExecutionActionResult,
  ): Promise<void> => {
    updateProcessExecution(historyKey, recordId, { state: value.state, result: value });
    const streams = (["stdout", "stderr"] as const).filter((stream) =>
      value.output?.some((item) => item.stream === stream));
    if (streams.length === 0) return;
    const reads = await Promise.all(streams.map(async (stream) => {
      try {
        return {
          stream,
          response: await window.sliver.readExecutionOutput({ requestId: value.requestId, stream }),
        };
      } catch (error) {
        return { stream, response: { ok: false as const, error: errorMessage(error) } };
      }
    }));
    if (selectionIdentity !== selectionIdentityRef.current) {
      for (const read of reads) if (read.response.ok) read.response.value.data.fill(0);
      updateProcessExecution(historyKey, recordId, {
        outputError: "Captured output could not be copied after the selected target changed.",
      });
      return;
    }
    const patch: { stdout?: { data: Uint8Array; truncated: boolean }; stderr?: { data: Uint8Array; truncated: boolean }; outputError?: string } = {};
    const failures: string[] = [];
    for (const read of reads) {
      if (!read.response.ok) {
        failures.push(read.response.error ?? "Captured output is unavailable.");
      } else if (read.stream === "stdout") {
        patch.stdout = read.response.value;
      } else {
        patch.stderr = read.response.value;
      }
    }
    if (failures.length > 0) patch.outputError = failures.join(" ");
    try {
      updateProcessExecution(historyKey, recordId, patch);
    } finally {
      patch.stdout?.data.fill(0);
      patch.stderr?.data.fill(0);
    }
  }, [selectionIdentity]);

  const execute = useCallback(async (directProcessPlan?: ExecutionActionPlan): Promise<void> => {
    if (!catalogIsCurrent) return;
    const current = directProcessPlan ?? planRef.current;
    if (!current) return;
    const expectedIdentity = selectionIdentity;
    const sequence = ++executeRequestSequence.current;
    const historyKey = current.operationId === "execution.process" && catalog?.target.mode === "session"
      ? processHistoryKey
      : undefined;
    const processDraft = preparedProcessDraft.current;
    const recordId = historyKey && processDraft
      ? (globalThis.crypto?.randomUUID?.() ?? `process-${Date.now()}-${sequence}`)
      : undefined;
    preparedProcessDraft.current = undefined;
    if (historyKey && recordId && processDraft) {
      addProcessExecution(historyKey, {
        id: recordId,
        startedAt: new Date().toISOString(),
        path: processDraft.path,
        args: processDraft.args,
        state: "running",
      });
      setSelectedProcessId(recordId);
    }
    setIsExecuting(true);
    try {
      const response = await window.sliver.executeExecutionPlan({ token: current.token });
      if (sequence !== executeRequestSequence.current || expectedIdentity !== selectionIdentityRef.current) {
        if (historyKey && recordId) updateProcessExecution(historyKey, recordId, {
          state: "outcome-unknown",
          error: "The selected target changed before this result could be associated with it.",
        });
        return;
      }
      if (!response.ok || !response.value) {
        planRef.current = undefined;
        setPlan(undefined);
        if (historyKey && recordId) updateProcessExecution(historyKey, recordId, {
          state: "request-failed",
          error: response.error ?? "The execution request failed.",
        });
        toast.danger("Execution failed", { description: response.error });
        restoreActionFocus();
        return;
      }
      if (response.value.operationId !== current.operationId) {
        planRef.current = undefined;
        setPlan(undefined);
        if (historyKey && recordId) updateProcessExecution(historyKey, recordId, {
          state: "request-failed",
          error: "The result did not match the reviewed operation.",
        });
        toast.danger("Execution result rejected", { description: "The result did not match the reviewed operation." });
        restoreActionFocus();
        return;
      }
      planRef.current = undefined;
      setPlan(undefined);
      if (historyKey && recordId) {
        await retainProcessResult(historyKey, recordId, response.value);
      } else {
        resultRef.current = response.value;
        setResult(response.value);
      }
      if (historyKey && response.value.state === "completed" && response.value.exitCode !== undefined && response.value.exitCode !== 0) {
        toast.warning(`Process exited with code ${response.value.exitCode}`, { description: response.value.message });
      } else {
        toast.success(executionResultTitle(response.value.state), { description: response.value.message });
      }
      restoreActionFocus();
    } catch (error) {
      if (directProcessPlan) discardToken(current.token);
      if (sequence === executeRequestSequence.current && expectedIdentity === selectionIdentityRef.current) {
        if (historyKey && recordId) updateProcessExecution(historyKey, recordId, {
          state: directProcessPlan ? "outcome-unknown" : "request-failed",
          error: directProcessPlan
            ? `Could not confirm whether execution started: ${errorMessage(error)}`
            : errorMessage(error),
        });
        if (directProcessPlan) toast.warning("Execution status unknown", { description: errorMessage(error) });
        else toast.danger("Execution failed", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === executeRequestSequence.current && expectedIdentity === selectionIdentityRef.current) setIsExecuting(false);
    }
  }, [catalog?.target.mode, catalogIsCurrent, discardToken, processHistoryKey, restoreActionFocus, retainProcessResult, selectionIdentity]);

  const prepare = useCallback(async (draft: ExecutionActionDraft): Promise<void> => {
    if (!catalogIsCurrent) return;
    const expectedIdentity = exactIdentity;
    const sequence = ++prepareRequestSequence.current;
    if (planRef.current) clearPreparedPlan(false);
    preparedProcessDraft.current = undefined;
    setIsPreparing(true);
    try {
      const response = await window.sliver.prepareExecutionAction({ draft });
      if (sequence !== prepareRequestSequence.current || expectedIdentity !== identityRef.current) {
        if (response.ok && response.value) discardToken(response.value.token);
        return;
      }
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not prepare execution action");
      if (
        response.value.operationId !== draft.operationId ||
        !executionPlanMatchesTarget(response.value, expectedTargetRef.current, catalog?.backend)
      ) {
        discardToken(response.value.token);
        throw new Error("The prepared plan no longer matches this exact operation and target selection.");
      }
      const isDirectSessionProcess = draft.operationId === "execution.process" && catalog?.target.mode === "session";
      if (isDirectSessionProcess) {
        preparedProcessDraft.current = { path: draft.path, args: [...draft.args] };
      }
      setSelectedCapability(undefined);
      if (isDirectSessionProcess) {
        await execute(response.value);
      } else {
        planRef.current = response.value;
        setPlan(response.value);
      }
    } finally {
      if (sequence === prepareRequestSequence.current && expectedIdentity === identityRef.current) setIsPreparing(false);
    }
  }, [catalog?.backend, catalog?.target.mode, catalogIsCurrent, clearPreparedPlan, discardToken, exactIdentity, execute]);

  const syncResult = useCallback(async (
    pending: ExecutionActionResult,
    reportFailure = false,
  ): Promise<void> => {
    if (resultRef.current?.requestId !== pending.requestId) return;
    const expectedIdentity = exactIdentity;
    const sequence = ++resultRequestSequence.current;
    try {
      const response = await window.sliver.getExecutionResult({ requestId: pending.requestId });
      if (sequence !== resultRequestSequence.current || expectedIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) {
        if (reportFailure) {
          toast.danger("Could not retrieve execution result", {
            description: response.error ?? "The result is not available yet.",
          });
        }
        return;
      }
      if (response.value.requestId !== pending.requestId || response.value.operationId !== pending.operationId) {
        toast.danger("Execution result rejected", { description: "The live result did not match this request." });
        return;
      }
      if (resultRef.current?.requestId !== pending.requestId) return;
      resultRef.current = response.value;
      setResult(response.value);
    } catch (error) {
      if (
        reportFailure &&
        sequence === resultRequestSequence.current &&
        expectedIdentity === identityRef.current
      ) {
        toast.danger("Could not retrieve execution result", { description: errorMessage(error) });
      }
      // Background failures retry on the next task event, reconciliation tick, or F5.
    }
  }, [exactIdentity]);

  useEffect(() => {
    const subscribedIdentity = exactIdentity;
    return window.sliver.onBeaconTasksInvalidated((target) => {
      if (
        subscribedIdentity !== identityRef.current ||
        expectedTargetRef.current.mode !== "beacon" ||
        !targetRefsSameIdentity(target, expectedTargetRef.current)
      ) return;

      const pendingRead = readStateRef.current;
      if (
        pendingRead.status === "ready" &&
        pendingRead.value.state === "submitted" &&
        pendingRead.value.taskId
      ) {
        void runRead(
          pendingRead.value.operationId,
          undefined,
          pendingRead.value.taskId,
          true,
        );
      }

      const pendingResult = resultRef.current;
      if (
        pendingResult?.taskId &&
        (pendingResult.state === "submitted" || pendingResult.state === "outcome-unknown")
      ) void syncResult(pendingResult);
    });
  }, [exactIdentity, runRead, syncResult]);

  const refreshProcessResult = useCallback(async (record: ProcessExecutionRecord): Promise<void> => {
    if (!processHistoryKey || !record.result) return;
    const expectedIdentity = selectionIdentity;
    try {
      const response = await window.sliver.getExecutionResult({ requestId: record.result.requestId });
      if (expectedIdentity !== selectionIdentityRef.current) return;
      if (!response.ok || !response.value) {
        toast.danger("Could not refresh process result", { description: response.error });
        return;
      }
      if (response.value.requestId !== record.result.requestId || response.value.operationId !== "execution.process") {
        toast.danger("Process result rejected", { description: "The returned result did not match this invocation." });
        return;
      }
      await retainProcessResult(processHistoryKey, record.id, response.value);
    } catch (error) {
      if (expectedIdentity === selectionIdentityRef.current) {
        toast.danger("Could not refresh process result", { description: errorMessage(error) });
      }
    }
  }, [processHistoryKey, retainProcessResult, selectionIdentity]);

  const saveResult = useCallback(async (
    source: ExecutionActionResult,
    stream: "stdout" | "stderr" | "combined",
  ): Promise<void> => {
    const expectedIdentity = exactIdentity;
    const sequence = ++saveRequestSequence.current;
    setSavingStream(stream);
    try {
      const response = await window.sliver.saveExecutionResult({ requestId: source.requestId, stream });
      if (sequence !== saveRequestSequence.current || expectedIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) {
        toast.danger("Could not save output", { description: response.error });
        return;
      }
      if (response.value.saved) toast.success("Output saved", { description: response.value.fileName });
    } catch (error) {
      if (sequence === saveRequestSequence.current && expectedIdentity === identityRef.current) {
        toast.danger("Could not save output", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === saveRequestSequence.current && expectedIdentity === identityRef.current) setSavingStream(undefined);
    }
  }, [exactIdentity]);

  const addProcessOutputToLoot = useCallback(async (
    source: ExecutionActionResult,
    stream: "stdout" | "stderr",
    name: string,
  ): Promise<void> => {
    const expectedIdentity = exactIdentity;
    const sequence = ++lootRequestSequence.current;
    setAddingToLoot(true);
    try {
      const response = await window.sliver.addExecutionOutputToLoot({
        requestId: source.requestId,
        stream,
        name,
      });
      if (sequence !== lootRequestSequence.current || expectedIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) {
        toast.danger("Could not add output to Loot", { description: response.error });
        return;
      }
      toast.success("Output added to Loot", { description: response.value.name });
    } catch (error) {
      if (sequence === lootRequestSequence.current && expectedIdentity === identityRef.current) {
        toast.danger("Could not add output to Loot", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === lootRequestSequence.current && expectedIdentity === identityRef.current) setAddingToLoot(false);
    }
  }, [exactIdentity]);

  if (
    catalogState.status === "loading" ||
    (previousSelectionIdentity.current !== undefined && previousSelectionIdentity.current !== selectionIdentity)
  ) {
    return <WorkbenchLoading />;
  }
  if (catalogState.status === "error") {
    return <WorkbenchError error={catalogState.error} onRetry={() => void loadCatalog()} />;
  }
  const isSession = catalogState.value.target.mode === "session";
  const categoryTabs = (
    <Segment
      aria-label="Execution categories"
      className={isSession ? "min-w-0 w-fit overflow-x-auto" : "mt-5 w-full overflow-x-auto sm:w-fit"}
      selectedKey={category}
      size="sm"
      onSelectionChange={(key) => {
        readRequestSequence.current += 1;
        setCategory(String(key) as ExecutionCategoryId);
        setReadState({ status: "idle" });
      }}
    >
      {EXECUTION_CATEGORIES.map((candidate) => (
        <Segment.Item id={candidate.id} key={candidate.id}>
          <span className="inline-flex items-center gap-2">
            <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-muted" icon={candidate.icon} />
            {candidate.label}
          </span>
        </Segment.Item>
      ))}
    </Segment>
  );

  return (
    <>
      <section
        className="rounded-2xl bg-surface p-5 sm:p-6"
        aria-label={isSession ? "Execution operations" : undefined}
        aria-labelledby={isSession ? undefined : "execution-workbench-heading"}
      >
        {!catalogIsCurrent ? (
          <p className="mb-4 text-xs text-muted" role="status">Refreshing execution capabilities for the latest target inventory…</p>
        ) : null}
        {!isSession ? (
          <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-foreground" id="execution-workbench-heading">Execution workbench</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted">
                Configure one typed operation, review the exact target and native files, then execute a short-lived main-owned plan.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Chip size="sm" variant="soft">{catalogState.value.target.os}/{catalogState.value.target.arch}</Chip>
              <Chip color="success" size="sm" variant="soft">{catalogState.value.target.mode}</Chip>
            </div>
          </header>
        ) : null}

        {isSession ? (
          <div className="flex items-center justify-between gap-4">
            {categoryTabs}
            <Chip className="shrink-0" size="sm" variant="soft">
              {catalogState.value.target.os}/{catalogState.value.target.arch}
            </Chip>
          </div>
        ) : categoryTabs}

        {isSession && category === "process" ? (
          <ProcessExecutionView
            capability={categoryCapabilities.find((capability) => capability.operationId === "execution.process")}
            history={processHistory}
            addingToLoot={addingToLoot}
            isExecuting={isExecuting}
            isPreparing={isPreparing}
            isRefreshing={!catalogIsCurrent}
            savingStream={savingStream === "combined" ? undefined : savingStream}
            selectedId={selectedProcessId}
            target={catalogState.value.target}
            onClear={(id) => {
              if (processHistoryKey) clearProcessExecution(processHistoryKey, id);
              setSelectedProcessId(undefined);
            }}
            onClearAll={() => {
              if (processHistoryKey) clearProcessExecution(processHistoryKey);
              setSelectedProcessId(undefined);
            }}
            onAddToLoot={(source, stream, name) => void addProcessOutputToLoot(source, stream, name)}
            onPrepare={prepare}
            onRefresh={(record) => void refreshProcessResult(record)}
            onSave={(source, stream) => void saveResult(source, stream)}
            onSelect={setSelectedProcessId}
          />
        ) : (
          <>
            <ItemCardGroup className="mt-5" columns={2} layout="grid" variant="secondary">
              <ItemCardGroup.Header className="col-span-full">
                <ItemCardGroup.Title>{categoryCopy.label}</ItemCardGroup.Title>
                <ItemCardGroup.Description>{categoryCopy.description}</ItemCardGroup.Description>
              </ItemCardGroup.Header>
              {categoryCapabilities.map((capability) => (
                <ExecutionActionCard
                  buttonRef={(node) => {
                    if (node) actionButtons.current.set(capability.operationId, node);
                    else actionButtons.current.delete(capability.operationId);
                  }}
                  capability={capability}
                  isRefreshing={!catalogIsCurrent}
                  key={capability.operationId}
                  onPress={() => beginAction(capability)}
                />
              ))}
            </ItemCardGroup>
            {categoryCapabilities.length === 0 ? <CategoryEmpty category={categoryCopy.label} /> : null}

            <ExecutionReadPanel
              state={readState}
              onLoadMore={(operationId, cursor, taskId) => void runRead(operationId, cursor, taskId)}
              onRetry={(operationId) => void runRead(operationId)}
            />
            {result ? (
              <ExecutionResultPanel
                result={result}
                savingStream={savingStream}
                onRetry={() => void syncResult(result, true)}
                onSave={(stream) => void saveResult(result, stream)}
              />
            ) : null}
          </>
        )}
      </section>

      <ExecutionConfigurationSheet
        capability={catalogIsCurrent ? selectedCapability : undefined}
        isPreparing={isPreparing}
        target={catalogState.value.target}
        onCancel={() => {
          prepareRequestSequence.current += 1;
          setSelectedCapability(undefined);
          setIsPreparing(false);
          restoreActionFocus();
        }}
        onPrepare={prepare}
      />
      <ExecutionReviewDialog
        isExecuting={isExecuting}
        plan={catalogIsCurrent ? plan : undefined}
        onCancel={() => {
          if (!isExecuting) clearPreparedPlan(true);
        }}
        onConfirm={() => void execute()}
      />
    </>
  );
}

function ExecutionActionCard({
  buttonRef,
  capability,
  isRefreshing,
  onPress,
}: {
  buttonRef: (node: HTMLButtonElement | null) => void;
  capability: ExecutionCapability;
  isRefreshing: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const copy = executionActionPresentation(capability.operationId);
  const button = (
    <Button
      ref={buttonRef}
      aria-label={`${capability.available ? "Open" : "Unavailable"}: ${copy.label}`}
      isDisabled={isRefreshing || !capability.available}
      size="sm"
      variant="tertiary"
      onPress={onPress}
    >
      {isReadOperation(capability.operationId) ? "Load" : "Configure"}
      <FontAwesomeIcon aria-hidden className="size-3" icon={faChevronRight} />
    </Button>
  );
  return (
    <ItemCard variant="secondary">
      <ItemCard.Icon><FontAwesomeIcon aria-hidden icon={copy.icon} /></ItemCard.Icon>
      <ItemCard.Content>
        <ItemCard.Title>{copy.label}</ItemCard.Title>
        <ItemCard.Description>{copy.description}</ItemCard.Description>
        <span className="mt-2 flex flex-wrap gap-1.5">
          <Chip color={executionRiskColor(capability.risk)} size="sm" variant="soft">
            {executionRiskLabel(capability.risk)}
          </Chip>
          {!capability.available ? <Chip color="warning" size="sm" variant="soft">Unavailable</Chip> : null}
        </span>
        {!capability.available ? (
          <span className="mt-2 block text-xs leading-5 text-warning-soft-foreground">
            {capability.reason?.message ?? "This action is unavailable for the selected target."}
          </span>
        ) : null}
      </ItemCard.Content>
      <ItemCard.Action>
        {!capability.available ? (
          <Tooltip delay={250}>
            {button}
            <Tooltip.Content>{capability.reason?.message ?? "Action unavailable"}</Tooltip.Content>
          </Tooltip>
        ) : button}
      </ItemCard.Action>
    </ItemCard>
  );
}

function ExecutionConfigurationSheet({
  capability,
  isPreparing,
  target,
  onCancel,
  onPrepare,
}: {
  capability: ExecutionCapability | undefined;
  isPreparing: boolean;
  target: TargetSummary;
  onCancel: () => void;
  onPrepare: (draft: ExecutionActionDraft) => Promise<void>;
}): React.JSX.Element {
  const operationId = capability?.operationId;
  const actionCapability = operationId && !isReadOperation(operationId) ? capability : undefined;
  return (
    <Sheet
      isDismissable={!isPreparing}
      isOpen={actionCapability !== undefined}
      placement="right"
      onOpenChange={(open) => { if (!open && !isPreparing) onCancel(); }}
    >
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="h-full w-full max-w-2xl">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger />
            <Sheet.Header>
              <Sheet.Heading>{actionCapability ? executionActionPresentation(actionCapability.operationId).label : "Configure action"}</Sheet.Heading>
              <p className="mt-1 text-sm text-muted">Credentials stay in this form only until Review begins.</p>
            </Sheet.Header>
            <Sheet.Body className="min-h-0 overflow-auto">
              {actionCapability && !isReadOperation(actionCapability.operationId) ? (
                <ExecutionActionForm
                  capability={actionCapability}
                  formId={ACTION_FORM_ID}
                  isPreparing={isPreparing}
                  operationId={actionCapability.operationId}
                  target={target}
                  onPrepare={onPrepare}
                />
              ) : null}
            </Sheet.Body>
            <Sheet.Footer>
              <Button isDisabled={isPreparing} size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
              <Button form={ACTION_FORM_ID} isPending={isPreparing} size="sm" type="submit" variant="primary">
                {isPreparing ? "Preparing review…" : "Review"}
              </Button>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

function ExecutionReviewDialog({
  isExecuting,
  plan,
  onCancel,
  onConfirm,
}: {
  isExecuting: boolean;
  plan: ExecutionActionPlan | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const danger = plan?.risk === "destructive" || plan?.risk === "high-opsec";
  return (
    <AlertDialog.Backdrop
      isOpen={plan !== undefined}
      onOpenChange={(open) => { if (!open && !isExecuting) onCancel(); }}
      variant="blur"
    >
      <AlertDialog.Container placement="center" size="lg">
        <AlertDialog.Dialog className="sm:max-w-2xl">
          <AlertDialog.Header>
            <AlertDialog.Icon status={danger ? "danger" : "warning"}>
              <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
            </AlertDialog.Icon>
            <AlertDialog.Heading>Execute this reviewed action?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            {plan ? (
              <div className="space-y-4 text-sm">
                <p className="leading-6 text-danger-soft-foreground">{plan.warning}</p>
                <section className="rounded-xl border border-separator bg-default px-4 py-3" aria-label="Reviewed target">
                  <p className="font-medium text-foreground">{plan.target.target.name || plan.target.target.hostname || plan.target.target.id}</p>
                  <p className="mt-1 break-all font-mono text-xs text-muted">{plan.target.target.mode}:{plan.target.target.id} · {plan.target.fingerprint}</p>
                  <p className="mt-1 text-xs text-muted">{plan.target.backend.operator}@{plan.target.backend.server} · epoch {plan.target.backend.epoch}</p>
                </section>
                {plan.currentIdentity || plan.requestedIdentity ? (
                  <dl className="grid gap-3 rounded-xl bg-surface-secondary p-4 sm:grid-cols-2">
                    <ReviewField label="Current identity" value={plan.currentIdentity ?? "Not reported"} />
                    <ReviewField label="Requested identity" value={plan.requestedIdentity ?? "No identity change"} />
                  </dl>
                ) : null}
                {plan.fields.length > 0 ? (
                  <dl className="grid gap-x-5 gap-y-3 sm:grid-cols-2" aria-label="Reviewed fields">
                    {plan.fields.map((field, index) => <ReviewField key={`${field.label}-${index}`} label={field.label} value={field.value} />)}
                  </dl>
                ) : null}
                {plan.artifacts.length > 0 ? (
                  <section aria-label="Reviewed native files">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Native files</h3>
                    <ul className="mt-2 divide-y divide-separator rounded-xl border border-separator">
                      {plan.artifacts.map((artifact) => (
                        <li className="px-4 py-3" key={`${artifact.role}-${artifact.sha256}`}>
                          <p className="font-medium text-foreground">{artifact.fileName}</p>
                          <p className="mt-1 text-xs text-muted">{formatBytes(artifact.size)} · {artifact.mediaType}</p>
                          <p className="mt-1 break-all font-mono text-[11px] text-muted">SHA-256 {artifact.sha256}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
                <p className="text-xs text-muted">This plan expires {new Date(plan.expiresAt).toLocaleTimeString()} and is rejected if the backend or target changes.</p>
              </div>
            ) : null}
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isExecuting} size="sm" variant="tertiary" onPress={onCancel}>Cancel</Button>
            <Button isPending={isExecuting} size="sm" variant={danger ? "danger" : "primary"} onPress={onConfirm}>
              {isExecuting ? "Executing…" : "Execute"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function ReviewField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 break-words font-mono text-xs text-foreground">{value}</dd></div>;
}

function ExecutionReadPanel({
  state,
  onLoadMore,
  onRetry,
}: {
  state: ReadState;
  onLoadMore: (operationId: ExecutionReadOperationId, cursor: string, taskId?: string) => void;
  onRetry: (operationId: ExecutionReadOperationId) => void;
}): React.JSX.Element | null {
  if (state.status === "idle") return null;
  if (state.status === "loading") return <InlineLoading label={`Loading ${executionActionPresentation(state.operationId).label.toLocaleLowerCase()}`} />;
  if (state.status === "error") {
    return (
      <section className="mt-6 rounded-2xl bg-danger-soft p-5" role="alert">
        <p className="font-medium text-danger-soft-foreground">Could not load {executionActionPresentation(state.operationId).label.toLocaleLowerCase()}</p>
        <p className="mt-1 text-sm text-danger-soft-foreground">{state.error}</p>
        <Button className="mt-3" size="sm" variant="tertiary" onPress={() => onRetry(state.operationId)}>Retry</Button>
      </section>
    );
  }
  if (state.value.state === "submitted") {
    return (
      <section className="mt-6 rounded-2xl border border-separator bg-surface-secondary p-5" aria-live="polite">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-foreground">{executionActionPresentation(state.value.operationId).label} queued</h3>
            <Chip color="warning" size="sm" variant="soft">Submitted</Chip>
          </div>
          <p className="mt-1 text-sm text-muted">
            The beacon accepted this read as an asynchronous task. Results will appear after its next check-in.
          </p>
          {state.value.taskId ? <p className="mt-2 break-all font-mono text-xs text-muted">Task {state.value.taskId}</p> : null}
        </div>
      </section>
    );
  }
  return state.value.operationId === "execution.children"
    ? <ChildrenTable
        isLoadingMore={state.isLoadingMore}
        value={state.value}
        onLoadMore={(operationId, cursor) => onLoadMore(operationId, cursor, state.value.taskId)}
      />
    : <PrivilegesTable
        isLoadingMore={state.isLoadingMore}
        value={state.value}
        onLoadMore={(operationId, cursor) => onLoadMore(operationId, cursor, state.value.taskId)}
      />;
}

const CHILD_COLUMNS: DataGridColumn<ExecutionChildSummary>[] = [
  { id: "pid", header: "PID", accessorKey: "pid", isRowHeader: true, width: 100, cell: (item) => <span className="font-mono text-xs">{item.pid}</span> },
  { id: "path", header: "Process", accessorKey: "path", minWidth: 260, cell: (item) => <div><p className="font-medium text-foreground">{item.path}</p><p className="mt-0.5 truncate font-mono text-xs text-muted">{item.args.join(" ") || "No arguments"}</p></div> },
  { id: "state", header: "State", width: 120, cell: (item) => <Chip color={item.exited ? "default" : "success"} size="sm" variant="soft">{item.exited ? "Exited" : "Running"}</Chip> },
  { id: "output", header: "Output", width: 150, cell: (item) => <span className="font-mono text-xs text-muted">{formatBytes(item.stdoutBytes + item.stderrBytes)}</span> },
  { id: "exit", header: "Exit", width: 100, cell: (item) => <span className="font-mono text-xs text-muted">{item.exitCode ?? "—"}</span> },
];

function ChildrenTable({ isLoadingMore, value, onLoadMore }: {
  isLoadingMore: boolean;
  value: Extract<ExecutionReadResult, { operationId: "execution.children" }>;
  onLoadMore: (operationId: ExecutionReadOperationId, cursor: string) => void;
}): React.JSX.Element {
  return (
    <section className="mt-6 space-y-3" aria-labelledby="execution-children-heading">
      <div className="flex items-center justify-between gap-3"><h3 className="font-semibold text-foreground" id="execution-children-heading">Background children</h3><span className="text-xs text-muted">{value.items.length} of {value.total}</span></div>
      {value.truncated ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground">The server bounded this inventory. Load the next page to continue.</p> : null}
      <DataGrid aria-label="Background child processes" columns={CHILD_COLUMNS} contentClassName="min-w-[760px]" data={value.items} getRowId={(item) => String(item.pid)} variant="secondary" renderEmptyState={() => <GridEmpty label="No tracked background children were reported." />} />
      {value.nextCursor ? <div className="flex justify-center"><Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => onLoadMore("execution.children", value.nextCursor!)}>Load more</Button></div> : null}
    </section>
  );
}

const PRIVILEGE_COLUMNS: DataGridColumn<ExecutionPrivilegeSummary>[] = [
  { id: "name", header: "Privilege", accessorKey: "name", isRowHeader: true, minWidth: 210, cell: (item) => <span className="font-mono text-xs font-medium text-foreground">{item.name}</span> },
  { id: "description", header: "Description", accessorKey: "description", minWidth: 320 },
  { id: "state", header: "State", width: 130, cell: (item) => <Chip color={item.removed ? "danger" : item.enabled ? "success" : "default"} size="sm" variant="soft">{item.removed ? "Removed" : item.enabled ? "Enabled" : "Disabled"}</Chip> },
  { id: "access", header: "Used", width: 90, cell: (item) => item.usedForAccess ? <FontAwesomeIcon aria-label="Used for access" className="text-success" icon={faCheck} /> : "—" },
];

function PrivilegesTable({ isLoadingMore, value, onLoadMore }: {
  isLoadingMore: boolean;
  value: ExecutionPrivilegesResult;
  onLoadMore: (operationId: ExecutionReadOperationId, cursor: string) => void;
}): React.JSX.Element {
  return (
    <section className="mt-6 space-y-3" aria-labelledby="execution-privileges-heading">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-semibold text-foreground" id="execution-privileges-heading">Windows privileges</h3><p className="mt-1 text-xs text-muted">{value.processName} · {value.processIntegrity}{value.currentIdentity ? ` · ${value.currentIdentity}` : ""}</p></div><span className="text-xs text-muted">{value.privileges.length} of {value.total}</span></div>
      {value.truncated ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground">The server bounded this inventory. Load the next page to continue.</p> : null}
      <DataGrid aria-label="Windows process privileges" columns={PRIVILEGE_COLUMNS} contentClassName="min-w-[760px]" data={value.privileges} getRowId={(item) => item.name} variant="secondary" renderEmptyState={() => <GridEmpty label="No Windows privileges were reported." />} />
      {value.nextCursor ? <div className="flex justify-center"><Button isPending={isLoadingMore} size="sm" variant="tertiary" onPress={() => onLoadMore("privilege.get", value.nextCursor!)}>Load more</Button></div> : null}
    </section>
  );
}

function ExecutionResultPanel({
  result,
  savingStream,
  onRetry,
  onSave,
}: {
  result: ExecutionActionResult;
  savingStream: "stdout" | "stderr" | "combined" | undefined;
  onRetry: () => void;
  onSave: (stream: "stdout" | "stderr" | "combined") => void;
}): React.JSX.Element {
  const streams = [...new Set(result.output?.map((output) => output.stream) ?? [])];
  return (
    <section className="mt-6 rounded-2xl border border-separator bg-surface-secondary p-5" aria-labelledby="execution-result-heading">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-foreground" id="execution-result-heading">Latest execution</h3><Chip color={resultStateColor(result.state)} size="sm" variant="soft">{executionResultTitle(result.state)}</Chip></div>
          <p className="mt-2 text-sm leading-6 text-muted">{result.message}</p>
          <p className="mt-2 break-all font-mono text-xs text-muted">Request {result.requestId}{result.taskId ? ` · Task ${result.taskId}` : ""}{result.pid === undefined ? "" : ` · PID ${result.pid}`}</p>
        </div>
        {result.state === "outcome-unknown" ? <Button size="sm" variant="outline" onPress={onRetry}>Retry result</Button> : null}
      </div>
      {streams.length > 0 ? <div className="mt-4 flex flex-wrap gap-2">{streams.map((stream) => <Button isPending={savingStream === stream} key={stream} size="sm" variant="tertiary" onPress={() => onSave(stream)}><FontAwesomeIcon aria-hidden icon={faDownload} /> Save {stream}</Button>)}</div> : null}
    </section>
  );
}

function WorkbenchLoading(): React.JSX.Element {
  return <section className="flex min-h-48 items-center justify-center rounded-2xl bg-surface" aria-label="Loading execution workbench"><Spinner size="sm" /><span className="ml-2 text-sm text-muted">Loading execution capabilities…</span></section>;
}

function WorkbenchError({ error, onRetry }: { error: string; onRetry: () => void }): React.JSX.Element {
  return <section className="rounded-2xl bg-surface p-6"><EmptyState><EmptyState.Header><EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></EmptyState.Media><EmptyState.Title>Execution workbench unavailable</EmptyState.Title><EmptyState.Description>{error}</EmptyState.Description></EmptyState.Header><EmptyState.Content><Button variant="outline" onPress={onRetry}>Retry</Button></EmptyState.Content></EmptyState></section>;
}

function CategoryEmpty({ category }: { category: string }): React.JSX.Element {
  return <div className="mt-4 rounded-xl bg-surface-secondary px-4 py-8 text-center"><p className="text-sm font-medium text-foreground">No {category.toLocaleLowerCase()} actions support this target</p><p className="mt-1 text-xs text-muted">The server-issued catalog excludes operations that do not support this mode or platform.</p></div>;
}

function InlineLoading({ label }: { label: string }): React.JSX.Element {
  return <div className="mt-6 flex items-center justify-center rounded-xl bg-surface-secondary px-4 py-8"><Spinner size="sm" /><span className="ml-2 text-sm text-muted">{label}…</span></div>;
}

function GridEmpty({ label }: { label: string }): React.JSX.Element {
  return <div className="px-4 py-10 text-center text-sm text-muted">{label}</div>;
}

function isReadOperation(operationId: ExecutionOperationId): operationId is ExecutionReadOperationId {
  return operationId === "execution.children" || operationId === "privilege.get";
}

function targetRefsEqual(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id && left.backendEpoch === right.backendEpoch && left.domainRevision === right.domainRevision && left.fingerprint === right.fingerprint;
}

function targetRefsSameIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id && left.backendEpoch === right.backendEpoch && left.fingerprint === right.fingerprint;
}

function targetExecutionIdentity(routeIdentity: string, target: TargetRef): string {
  return JSON.stringify([
    routeIdentity,
    target.mode,
    target.id,
    target.backendEpoch,
    target.domainRevision,
    target.fingerprint,
  ]);
}

function targetSelectionIdentity(routeIdentity: string, target: TargetRef): string {
  return JSON.stringify([
    routeIdentity,
    target.mode,
    target.id,
    target.backendEpoch,
    target.fingerprint,
  ]);
}

function executionPlanMatchesTarget(
  plan: ExecutionActionPlan,
  expected: TargetRef,
  catalogBackend?: ExecutionActionPlan["target"]["backend"],
): boolean {
  const backendMatchesCatalog = !catalogBackend || (
    plan.target.backend.configId === catalogBackend.configId &&
    plan.target.backend.configName === catalogBackend.configName &&
    plan.target.backend.epoch === catalogBackend.epoch &&
    plan.target.backend.server === catalogBackend.server &&
    plan.target.backend.operator === catalogBackend.operator
  );
  return backendMatchesCatalog && plan.target.backend.epoch === expected.backendEpoch && plan.target.target.mode === expected.mode && plan.target.target.id === expected.id && plan.target.fingerprint === expected.fingerprint;
}

function mergeReadResults(current: ExecutionReadResult, next: ExecutionReadResult): ExecutionReadResult {
  if (current.operationId !== next.operationId) return next;
  if (current.operationId === "execution.children" && next.operationId === "execution.children") {
    return { ...next, items: uniqueBy([...current.items, ...next.items], (item) => String(item.pid)) };
  }
  if (current.operationId === "privilege.get" && next.operationId === "privilege.get") {
    return { ...next, privileges: uniqueBy([...current.privileges, ...next.privileges], (item) => item.name) };
  }
  return next;
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function executionResultTitle(state: ExecutionResultState): string {
  switch (state) {
    case "completed": return "Completed";
    case "submitted": return "Submitted";
    case "partial": return "Partial";
    case "failed": return "Failed";
    case "canceled": return "Canceled";
    case "outcome-unknown": return "Outcome unknown";
    case "target-disappeared": return "Target disappeared";
  }
}

function resultStateColor(state: ExecutionResultState): "default" | "success" | "warning" | "danger" {
  if (state === "completed") return "success";
  if (state === "submitted" || state === "partial" || state === "outcome-unknown") return "warning";
  if (state === "failed" || state === "target-disappeared") return "danger";
  return "default";
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
