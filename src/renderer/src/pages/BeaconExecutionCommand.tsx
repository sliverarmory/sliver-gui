import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs, toast } from "@heroui/react";

import type {
  AssemblySource,
  ExecutionActionDraft,
  ExecutionActionPlan,
  ExecutionActionResult,
  ExecutionCatalog,
  ExecutionOperationId,
  ExecutionReadOperationId,
} from "../../../shared/execution-contracts";
import type { TargetRef } from "../../../shared/target-contracts";
import { BofExecutionView } from "./BofExecutionView";
import { DotNetExecutionView } from "./DotNetExecutionView";
import { ProcessExecutionView } from "./ProcessExecutionView";
import type { ExecutionComposerState } from "./execution-composer-state";
import { ExecutionActionForm } from "./target-execution-forms";
import { executionCapabilitySupportsTarget } from "./target-execution-model";
import {
  ExecutionReviewDialog,
  executionPlanMatchesTarget,
  targetExecutionIdentity,
  targetRefsEqual,
  targetSelectionIdentity,
} from "./TargetExecutionWorkbench";

export type BeaconExecutionCommandState = ExecutionComposerState;
export type BeaconExecutionSelection = "execution" | "execution.children" | "privilege.get" |
  "privilege.run-as" | "privilege.make-token" | "privilege.impersonate" | "privilege.revert";

export interface BeaconExecutionCommandProps {
  expectedTarget: TargetRef;
  targetIdentity: string;
  formId: string;
  selection?: BeaconExecutionSelection;
  onQueuedTask: (taskId: string) => void;
  onStateChange: (state: BeaconExecutionCommandState) => void;
}

const EXECUTABLE_TYPES = [
  { id: "execution.process", label: "Process" },
  { id: "execution.assembly", label: ".NET" },
  { id: "execution.shellcode", label: "Shellcode" },
  { id: "execution.sideload", label: "Sideload" },
  { id: "execution.spawn-dll", label: "Reflective DLL" },
  { id: "execution.migrate", label: "Migrate" },
  { id: "execution.msf", label: "MSF" },
  { id: "execution.msf-inject", label: "MSF inject" },
] as const;
const EMPTY_COMPOSER: ExecutionComposerState = { isPending: false, isAvailable: false };
const EMPTY_HISTORY = Object.freeze([]);
const noop = (): void => undefined;

/** Compact composers share the session forms and main-owned execution boundary. */
export function BeaconExecutionCommand({
  expectedTarget,
  targetIdentity,
  formId,
  selection = "execution",
  onQueuedTask,
  onStateChange,
}: BeaconExecutionCommandProps): React.JSX.Element {
  const exactIdentity = targetExecutionIdentity(targetIdentity, expectedTarget);
  const selectionIdentity = targetSelectionIdentity(targetIdentity, expectedTarget);
  const [catalog, setCatalog] = useState<ExecutionCatalog>();
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [catalogError, setCatalogError] = useState<string>();
  const [error, setError] = useState<string>();
  const [type, setType] = useState("execution.process");
  const [composerState, setComposerState] = useState<ExecutionComposerState>(EMPTY_COMPOSER);
  const [isPreparing, setIsPreparing] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [plan, setPlan] = useState<ExecutionActionPlan>();
  const [result, setResult] = useState<ExecutionActionResult>();
  const identityRef = useRef(exactIdentity);
  identityRef.current = exactIdentity;
  const selectionRef = useRef(selectionIdentity);
  selectionRef.current = selectionIdentity;
  const expectedRef = useRef(expectedTarget);
  expectedRef.current = expectedTarget;
  const mounted = useRef(true);
  const planRef = useRef<ExecutionActionPlan | undefined>(undefined);
  planRef.current = plan;
  const catalogSequence = useRef(0);
  const prepareSequence = useRef(0);
  const executeSequence = useRef(0);
  const readSequence = useRef(0);
  const preparingRef = useRef(false);
  const executingRef = useRef(false);
  const readingRef = useRef(false);
  const previousSelection = useRef<string | undefined>(undefined);
  const queuedCallback = useRef(onQueuedTask);
  queuedCallback.current = onQueuedTask;

  const discardToken = useCallback((token: string): void => {
    void window.sliver.discardExecutionPlan({ token }).catch(() => undefined);
  }, []);

  const clearPlan = useCallback((): void => {
    const current = planRef.current;
    planRef.current = undefined;
    setPlan(undefined);
    if (current) discardToken(current.token);
  }, [discardToken]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const requestIdentity = exactIdentity;
    const sequence = ++catalogSequence.current;
    setIsRefreshing(true);
    setCatalogError(undefined);
    setError(undefined);
    try {
      const response = await window.sliver.listExecutionCatalog();
      if (!mounted.current || sequence !== catalogSequence.current || requestIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Execution is unavailable for this beacon.");
      const value = response.value;
      if (value.target.mode !== "beacon" || expectedRef.current.mode !== "beacon" ||
        !targetRefsEqual(value.targetRef, expectedRef.current) || value.target.id !== value.targetRef.id ||
        value.backend.epoch !== value.targetRef.backendEpoch) {
        throw new Error("The execution catalog no longer matches this exact beacon. Reselect it and try again.");
      }
      setCatalog(value);
    } catch (failure) {
      if (mounted.current && sequence === catalogSequence.current && requestIdentity === identityRef.current) {
        const message = errorMessage(failure);
        setCatalogError(message);
        setError(message);
      }
    } finally {
      if (mounted.current && sequence === catalogSequence.current && requestIdentity === identityRef.current) setIsRefreshing(false);
    }
  }, [exactIdentity]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      catalogSequence.current += 1;
      prepareSequence.current += 1;
      executeSequence.current += 1;
      readSequence.current += 1;
      const current = planRef.current;
      planRef.current = undefined;
      if (current) discardToken(current.token);
    };
  }, [discardToken, selectionIdentity]);

  useEffect(() => {
    const changedSelection = previousSelection.current !== selectionIdentity;
    previousSelection.current = selectionIdentity;
    prepareSequence.current += 1;
    preparingRef.current = false;
    setIsPreparing(false);
    clearPlan();
    if (changedSelection) {
      executingRef.current = false;
      setIsExecuting(false);
      setCatalog(undefined);
      setType("execution.process");
      setComposerState(EMPTY_COMPOSER);
      setResult(undefined);
    }
    void loadCatalog();
  }, [clearPlan, exactIdentity, loadCatalog, selectionIdentity]);

  const catalogIsCurrent = catalog !== undefined && targetRefsEqual(catalog.targetRef, expectedTarget) && !isRefreshing && !catalogError;
  const capabilities = useMemo(() => catalog?.capabilities.filter((capability) =>
    executionCapabilitySupportsTarget(capability, catalog.target)) ?? [], [catalog]);
  const types = useMemo(() => {
    const supported = EXECUTABLE_TYPES.filter((candidate) => capabilities.some((capability) => capability.operationId === candidate.id));
    const hasBofs = catalog !== undefined && ["windows", "linux", "darwin"].includes(catalog.target.os.trim().toLowerCase());
    return hasBofs ? [...supported.slice(0, 1), { id: "bofs", label: "BOFs" }, ...supported.slice(1)] : supported;
  }, [capabilities, catalog]);
  const activeType = selection === "execution"
    ? (types.some((candidate) => candidate.id === type) ? type : types[0]?.id)
    : selection;
  const capability = capabilities.find((candidate) => candidate.operationId === activeType);
  const isSharedComposer = activeType === "execution.process" || activeType === "execution.assembly" || activeType === "bofs";
  const available = catalogIsCurrent && !isPreparing && !isExecuting && !isReading && !plan &&
    (isSharedComposer ? composerState.isAvailable : capability?.available === true);

  useEffect(() => {
    onStateChange({
      isPending: isPreparing || isExecuting || isReading || (isSharedComposer && composerState.isPending),
      isAvailable: available,
      error: error ?? (isSharedComposer ? composerState.error : capability?.reason?.message),
    });
  }, [available, capability?.reason?.message, composerState.error, composerState.isPending, error, isExecuting, isPreparing, isReading, isSharedComposer, onStateChange]);

  const runRead = useCallback(async (operationId: ExecutionReadOperationId): Promise<void> => {
    if (!catalogIsCurrent || !capability?.available || readingRef.current) return;
    const requestIdentity = exactIdentity;
    const sequence = ++readSequence.current;
    readingRef.current = true;
    setIsReading(true);
    setError(undefined);
    try {
      const response = await window.sliver.runExecutionRead({ operationId, limit: 100 });
      if (!mounted.current || sequence !== readSequence.current || requestIdentity !== identityRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not queue execution read.");
      if (response.value.operationId !== operationId || response.value.state !== "submitted" || !response.value.taskId) {
        throw new Error("The execution read returned no exact beacon task ID.");
      }
      queuedCallback.current(response.value.taskId);
      toast.success("Task queued", { description: "The read will complete after the beacon checks in." });
    } catch (failure) {
      if (mounted.current && sequence === readSequence.current && requestIdentity === identityRef.current) setError(errorMessage(failure));
    } finally {
      readingRef.current = false;
      if (mounted.current && sequence === readSequence.current && requestIdentity === identityRef.current) setIsReading(false);
    }
  }, [capability?.available, catalogIsCurrent, exactIdentity]);

  const execute = useCallback(async (directPlan?: ExecutionActionPlan): Promise<void> => {
    const current = directPlan ?? planRef.current;
    if (!catalogIsCurrent || !current || executingRef.current) return;
    const requestIdentity = selectionIdentity;
    const sequence = ++executeSequence.current;
    executingRef.current = true;
    setIsExecuting(true);
    setError(undefined);
    try {
      const response = await window.sliver.executeExecutionPlan({ token: current.token });
      if (!mounted.current || sequence !== executeSequence.current || requestIdentity !== selectionRef.current) return;
      planRef.current = undefined;
      setPlan(undefined);
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not queue execution.");
      if (response.value.operationId !== current.operationId) throw new Error("The execution result did not match the reviewed operation.");
      setResult(response.value);
      if (!response.value.taskId) throw new Error(response.value.message || "Execution finished without an exact beacon task ID.");
      queuedCallback.current(response.value.taskId);
      toast.success("Task queued", { description: response.value.message });
    } catch (failure) {
      discardToken(current.token);
      if (mounted.current && sequence === executeSequence.current && requestIdentity === selectionRef.current) {
        planRef.current = undefined;
        setPlan(undefined);
        setError(errorMessage(failure));
      }
    } finally {
      if (mounted.current && sequence === executeSequence.current && requestIdentity === selectionRef.current) {
        executingRef.current = false;
        setIsExecuting(false);
      }
    }
  }, [catalogIsCurrent, discardToken, selectionIdentity]);

  const prepare = useCallback(async (draft: ExecutionActionDraft, assemblySource?: AssemblySource): Promise<void> => {
    if (!catalogIsCurrent || preparingRef.current || executingRef.current) return;
    const requestIdentity = exactIdentity;
    const sequence = ++prepareSequence.current;
    clearPlan();
    preparingRef.current = true;
    setIsPreparing(true);
    setError(undefined);
    try {
      const response = await window.sliver.prepareExecutionAction({ draft, ...(assemblySource ? { assemblySource } : {}) });
      if (!mounted.current || sequence !== prepareSequence.current || requestIdentity !== identityRef.current) {
        if (response.ok && response.value) discardToken(response.value.token);
        return;
      }
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not prepare execution.");
      if (response.value.operationId !== draft.operationId ||
        !executionPlanMatchesTarget(response.value, expectedRef.current, catalog?.backend)) {
        discardToken(response.value.token);
        throw new Error("The reviewed plan no longer matches this exact operation and beacon.");
      }
      // Assemblies retain the session command's direct prepare/execute flow.
      if (draft.operationId === "execution.assembly") await execute(response.value);
      else {
        planRef.current = response.value;
        setPlan(response.value);
      }
    } catch (failure) {
      if (!mounted.current || sequence !== prepareSequence.current || requestIdentity !== identityRef.current) return;
      setError(errorMessage(failure));
      throw failure;
    } finally {
      if (mounted.current && sequence === prepareSequence.current && requestIdentity === identityRef.current) {
        preparingRef.current = false;
        setIsPreparing(false);
      }
    }
  }, [catalog?.backend, catalogIsCurrent, clearPlan, discardToken, exactIdentity, execute]);

  const selectType = (nextType: string): void => {
    if (isPreparing || isExecuting || composerState.isPending || plan) return;
    clearPlan();
    setComposerState(EMPTY_COMPOSER);
    setError(undefined);
    setType(nextType);
  };

  return (
    <div className="min-w-0">
      {!catalog ? (
        error ? <div className="space-y-3"><p className="text-xs text-danger" role="alert">{error}</p><Button size="sm" variant="tertiary" onPress={() => void loadCatalog()}>Retry execution</Button></div>
          : <p className="text-xs text-muted" role="status">Loading execution capabilities…</p>
      ) : (
        <>
          {isBeaconReadSelection(selection) ? (
            <form id={formId} onSubmit={(event) => { event.preventDefault(); void runRead(selection); }}>
              <p className="text-xs leading-relaxed text-muted">Queue a bounded read for this beacon. Its result appears in Task output after check-in.</p>
            </form>
          ) : selection !== "execution" && capability ? (
            <ExecutionActionForm capability={capability} formId={formId} isPreparing={!catalogIsCurrent || isPreparing || isExecuting || !capability.available}
              operationId={selection} target={catalog.target} onPrepare={prepare} />
          ) : selection === "execution" && activeType ? <Tabs className="min-w-0 gap-3" selectedKey={activeType} onSelectionChange={(key) => selectType(String(key))}>
            <Tabs.ListContainer className="max-w-full overflow-x-auto">
              <Tabs.List aria-label="Execution type" className="w-max p-0.5">
                {types.map((candidate) => <Tabs.Tab className="h-7 whitespace-nowrap px-2.5 text-xs" id={candidate.id} isDisabled={isPreparing || isExecuting || composerState.isPending || plan !== undefined} key={candidate.id}>{candidate.label}<Tabs.Indicator /></Tabs.Tab>)}
              </Tabs.List>
            </Tabs.ListContainer>
            {types.map((candidate) => (
              <Tabs.Panel className="min-w-0 p-0" id={candidate.id} key={candidate.id}>
                {candidate.id === "bofs" ? (
                  <BofExecutionView composerOnly formId={formId} isRefreshing={!catalogIsCurrent} key={selectionIdentity}
                    target={catalog.target} targetRef={expectedTarget} onComposerStateChange={setComposerState}
                    onQueuedTask={(taskId) => { if (mounted.current && selectionIdentity === selectionRef.current) queuedCallback.current(taskId); }} />
                ) : candidate.id === "execution.assembly" ? (
                  <DotNetExecutionView composerOnly formId={formId} capability={capability} isExecuting={isExecuting} isPreparing={isPreparing}
                    isRefreshing={!catalogIsCurrent} key={selectionIdentity} target={catalog.target} targetRef={expectedTarget}
                    result={result} onPrepare={prepare} onComposerStateChange={setComposerState} />
                ) : candidate.id === "execution.process" ? (
                  <ProcessExecutionView composerOnly formId={formId} capability={capability} history={EMPTY_HISTORY}
                    addingToLoot={false} isExecuting={isExecuting} isPreparing={isPreparing} isRefreshing={!catalogIsCurrent}
                    savingStream={undefined} selectedId={null} target={catalog.target} onPrepare={prepare} onComposerStateChange={setComposerState}
                    onSelect={noop} onClear={noop} onClearAll={noop} onRefresh={noop} onSave={noop} onAddToLoot={noop} />
                ) : capability ? (
                  <ExecutionActionForm capability={capability} formId={formId} isPreparing={!catalogIsCurrent || isPreparing || isExecuting || !capability.available}
                    operationId={candidate.id as Exclude<ExecutionOperationId, "execution.children" | "privilege.get">} target={catalog.target} onPrepare={prepare} />
                ) : null}
              </Tabs.Panel>
            ))}
          </Tabs> : null}
          {selection === "execution" && types.length === 0 ? <p className="text-xs text-muted" role="status">No execution types support this beacon.</p> : null}
          {selection !== "execution" && !capability ? <p className="text-xs text-warning" role="status">This execution command is unavailable for the selected beacon.</p> : null}
          {isRefreshing ? <p className="mt-3 text-xs text-muted" role="status">Refreshing execution capabilities…</p> : null}
          {error ? <p className="mt-3 text-xs text-danger" role="alert">{error}</p> : null}
          {catalogError ? <Button className="mt-3" size="sm" variant="tertiary" onPress={() => void loadCatalog()}>Retry execution</Button> : null}
        </>
      )}
      <ExecutionReviewDialog isExecuting={isExecuting} plan={plan} onCancel={clearPlan} onConfirm={() => void execute()} />
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Execution could not be queued.";
}

function isBeaconReadSelection(value: BeaconExecutionSelection): value is ExecutionReadOperationId {
  return value === "execution.children" || value === "privilege.get";
}
