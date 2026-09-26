import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  Autocomplete,
  Button,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  SearchField,
  Switch,
  TextField,
  Tooltip,
  toast,
  useFilter,
} from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBoxOpen,
  faCircleCheck,
  faCircleExclamation,
  faCircleQuestion,
  faClock,
  faCopy,
  faDownload,
  faFolderOpen,
  faPlay,
  faRotate,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";

import type { DotNetCatalog } from "../../../shared/dotnet-contracts";
import type {
  AssemblySource,
  DotNetFileSelection,
  DotNetExecutionRecord,
  ExecuteAssemblyDraft,
  ExecutionActionResult,
  ExecutionCapability,
} from "../../../shared/execution-contracts";
import { EXECUTION_LIMITS } from "../../../shared/execution-contracts";
import type { TargetRef, TargetSummary } from "../../../shared/target-contracts";
import { ExecutionHistorySidebar } from "../components/ExecutionHistorySidebar";
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";
import { parseProcessArgv } from "./process-argv";

const FORM_ID = "execution-dotnet-form";
const AUTO_REFRESH_INITIAL_DELAY_MS = 3_000;
const AUTO_REFRESH_MAX_DELAY_MS = 15_000;
const AUTO_REFRESH_MAX_ATTEMPTS = 40;
type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: DotNetCatalog; refreshing?: boolean; error?: string };
type HistoryState = { identityKey: string; revision: number; records: readonly DotNetExecutionRecord[]; error?: string };
const EMPTY_HISTORY: readonly DotNetExecutionRecord[] = Object.freeze([]);

export interface DotNetExecutionViewProps {
  capability: ExecutionCapability | undefined;
  isExecuting: boolean;
  isPreparing: boolean;
  isRefreshing: boolean;
  target: TargetSummary;
  targetRef: TargetRef;
  result?: ExecutionActionResult | undefined;
  onPrepare: (draft: ExecuteAssemblyDraft, assemblySource: AssemblySource) => Promise<void>;
}

/** Main owns native file bytes and Armory paths; this form sends only a source handle and argv. */
export function DotNetExecutionView({
  capability,
  isExecuting,
  isPreparing,
  isRefreshing,
  target,
  targetRef,
  result,
  onPrepare,
}: DotNetExecutionViewProps): React.JSX.Element {
  const identity = JSON.stringify([targetRef.mode, targetRef.id, targetRef.backendEpoch, targetRef.fingerprint]);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [historyState, setHistoryState] = useState<HistoryState>({ identityKey: identity, revision: -1, records: EMPTY_HISTORY });
  const [selectedId, setSelectedId] = useState<string | null>();
  const [assemblyId, setAssemblyId] = useState("");
  const [file, setFile] = useState<DotNetFileSelection>();
  const [isChoosingFile, setIsChoosingFile] = useState(false);
  const [argumentsText, setArgumentsText] = useState("");
  const [architecture, setArchitecture] = useState<ExecuteAssemblyDraft["architecture"]>("x84");
  const [process, setProcess] = useState("notepad.exe");
  const [processArgumentsText, setProcessArgumentsText] = useState("");
  const [className, setClassName] = useState("");
  const [method, setMethod] = useState("");
  const [appDomain, setAppDomain] = useState("");
  const [parentPid, setParentPid] = useState("");
  const [inProcess, setInProcess] = useState(false);
  const [runtime, setRuntime] = useState("");
  const [amsiBypass, setAmsiBypass] = useState(false);
  const [etwBypass, setEtwBypass] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState("60");
  const [formError, setFormError] = useState<string>();
  const [addingToLoot, setAddingToLoot] = useState(false);
  const catalogSequence = useRef(0);
  const historySequence = useRef(0);
  const fileSequence = useRef(0);
  const mountedRef = useRef(true);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const { contains } = useFilter({ sensitivity: "base" });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => () => clearOutput(historyState.records), [historyState.records]);
  useEffect(() => {
    setHistoryState((current) => current.identityKey === identity
      ? current
      : { identityKey: identity, revision: -1, records: EMPTY_HISTORY });
    setSelectedId(undefined);
  }, [identity]);

  const loadCatalog = useCallback(async (preserveCurrent = false): Promise<void> => {
    const sequence = ++catalogSequence.current;
    setCatalogState((current) => preserveCurrent && current.status === "ready" && sameTargetIdentity(current.value.target, targetRef)
      ? { status: "ready", value: current.value, refreshing: true }
      : { status: "loading" });
    try {
      const response = await window.sliver.listDotNetAssemblies();
      if (sequence !== catalogSequence.current || identity !== identityRef.current || !mountedRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Armory assemblies are unavailable.");
      if (!sameTargetIdentity(response.value.target, targetRef)) {
        throw new Error("The Armory assembly catalog no longer matches this target. Reselect the target and try again.");
      }
      setCatalogState({ status: "ready", value: response.value });
      setAssemblyId((current) => response.value!.assemblies.some((item) => item.id === current) ? current : "");
    } catch (error) {
      if (sequence === catalogSequence.current && identity === identityRef.current && mountedRef.current) {
        const message = errorMessage(error);
        setCatalogState((current) => preserveCurrent && current.status === "ready" && sameTargetIdentity(current.value.target, targetRef)
          ? { ...current, refreshing: false, error: message }
          : { status: "error", message });
      }
    }
  }, [identity, targetRef.backendEpoch, targetRef.domainRevision, targetRef.fingerprint, targetRef.id, targetRef.mode]);

  const loadHistory = useCallback(async (): Promise<void> => {
    const sequence = ++historySequence.current;
    try {
      const response = await window.sliver.listDotNetExecutionHistory();
      if (sequence !== historySequence.current || identity !== identityRef.current || !mountedRef.current) {
        if (response.ok && response.value) clearOutput(response.value.records);
        return;
      }
      if (!response.ok || !response.value) throw new Error(response.error ?? ".NET execution history is unavailable.");
      const snapshot = response.value;
      if (!sameTargetIdentity(snapshot.target, targetRef)) {
        clearOutput(snapshot.records);
        return;
      }
      let records: readonly DotNetExecutionRecord[];
      try {
        records = cloneRecords(snapshot.records);
      } finally {
        clearOutput(snapshot.records);
      }
      setHistoryState((current) => {
        if (current.identityKey === identity && snapshot.revision < current.revision) {
          clearOutput(records);
          return current;
        }
        return { identityKey: identity, revision: snapshot.revision, records };
      });
    } catch (error) {
      if (sequence === historySequence.current && identity === identityRef.current && mountedRef.current) {
        setHistoryState((current) => ({
          ...(current.identityKey === identity ? current : { identityKey: identity, revision: -1, records: EMPTY_HISTORY }),
          error: errorMessage(error),
        }));
      }
    }
  }, [identity, targetRef.backendEpoch, targetRef.domainRevision, targetRef.fingerprint, targetRef.id, targetRef.mode]);

  useEffect(() => {
    void loadCatalog(true);
    void loadHistory();
    const unsubscribe = window.sliver.onDotNetExecutionHistoryChanged((changedTarget) => {
      if (sameTargetIdentity(changedTarget, targetRef)) void loadHistory();
    });
    return () => {
      catalogSequence.current += 1;
      historySequence.current += 1;
      fileSequence.current += 1;
      unsubscribe();
    };
  }, [loadCatalog, loadHistory]);

  useEffect(() => {
    if (!result || result.operationId !== "execution.assembly") return;
    setSelectedId(result.requestId);
    void loadHistory();
  }, [result?.requestId]);

  const catalog = catalogState.status === "ready" && sameTargetIdentity(catalogState.value.target, targetRef)
    ? catalogState.value : undefined;
  const historyRecords = historyState.identityKey === identity ? historyState.records : EMPTY_HISTORY;
  const historyRecordsRef = useRef(historyRecords);
  historyRecordsRef.current = historyRecords;
  const historyError = historyState.identityKey === identity ? historyState.error : undefined;
  const selectedIndex = historyRecords.findIndex((record) => record.id === selectedId);
  const selected = selectedId === null ? undefined : historyRecords[selectedIndex < 0 ? 0 : selectedIndex];
  const showingNew = selected === undefined;
  const assembly = catalog?.assemblies.find((item) => item.id === assemblyId);
  const catalogError = catalogState.status === "error" ? catalogState.message : catalogState.status === "ready" ? catalogState.error : undefined;
  const isBusy = isPreparing || isExecuting || isChoosingFile || isRefreshing;
  const source: AssemblySource | undefined = file
    ? { kind: "file", token: file.token }
    : assembly ? { kind: "armory", id: assembly.id } : undefined;
  const isDll = file?.isDll ?? assembly?.isDll ?? false;
  const canExecute = !!source && !!capability?.available && (file !== undefined || !!assembly?.available) && !isBusy;
  const joinedArgumentBytes = parsedArgumentBytes(argumentsText);

  const chooseFile = async (): Promise<void> => {
    const sequence = ++fileSequence.current;
    const selectedIdentity = identity;
    setIsChoosingFile(true);
    setFormError(undefined);
    try {
      const response = await window.sliver.chooseDotNetAssemblyFile();
      if (sequence !== fileSequence.current || selectedIdentity !== identityRef.current || !mountedRef.current) return;
      if (!response.ok) throw new Error(response.error ?? "Could not open the assembly file.");
      if (!response.value) return;
      setFile(response.value);
      setAssemblyId("");
      setClassName("");
      setMethod("");
    } catch (error) {
      if (sequence === fileSequence.current && selectedIdentity === identityRef.current && mountedRef.current) {
        setFormError(errorMessage(error));
      }
    } finally {
      if (sequence === fileSequence.current && mountedRef.current) setIsChoosingFile(false);
    }
  };

  const selectAssembly = (id: string): void => {
    setAssemblyId(catalog?.assemblies.some((item) => item.id === id) ? id : "");
    setFile(undefined);
    setClassName("");
    setMethod("");
    setFormError(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!canExecute || !source) return;
    try {
      const args = parseProcessArgv(argumentsText);
      const processArgs = parseProcessArgv(processArgumentsText);
      const timeout = Number(timeoutSeconds);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600) throw new Error("Timeout must be between 1 and 3600 seconds.");
      const pid = parentPid.trim() ? Number(parentPid) : undefined;
      if (pid !== undefined && (!Number.isInteger(pid) || pid < 0 || pid > EXECUTION_LIMITS.pid)) {
        throw new Error(`Parent process ID must be an integer from 0 to ${EXECUTION_LIMITS.pid}.`);
      }
      if (!process.trim()) throw new Error("Host process is required.");
      if (isDll && (!className.trim() || !method.trim())) throw new Error("DLL assemblies require a class and method.");
      if (!inProcess && (runtime.trim() || amsiBypass || etwBypass)) {
        throw new Error("Runtime and bypass options require in-process execution.");
      }
      const draft: ExecuteAssemblyDraft = {
        operationId: "execution.assembly",
        args,
        process: process.trim(),
        isDll,
        architecture,
        processArgs,
        inProcess,
        amsiBypass: inProcess && amsiBypass,
        etwBypass: inProcess && etwBypass,
        timeoutSeconds: timeout,
        ...(className.trim() ? { className: className.trim() } : {}),
        ...(method.trim() ? { method: method.trim() } : {}),
        ...(appDomain.trim() ? { appDomain: appDomain.trim() } : {}),
        ...(pid === undefined ? {} : { parentPid: pid }),
        ...(inProcess && runtime.trim() ? { runtime: runtime.trim() } : {}),
      };
      setFormError(undefined);
      await onPrepare(draft, source);
      // Main consumes a local file token while preparing the review. Require
      // another Open before the same file can be prepared a second time.
      if (source.kind === "file") setFile(undefined);
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  const clearHistory = async (id?: string): Promise<void> => {
    const expectedIdentity = identity;
    try {
      const response = await window.sliver.clearDotNetExecutionHistory(id ? { id } : {});
      if (expectedIdentity !== identityRef.current || !mountedRef.current) return;
      if (!response.ok) throw new Error(response.error ?? "Could not clear .NET execution history.");
      if (!id || id === selectedId) setSelectedId(undefined);
      await loadHistory();
    } catch (error) {
      if (expectedIdentity === identityRef.current && mountedRef.current) {
        toast.danger("Could not clear .NET history", { description: errorMessage(error) });
      }
    }
  };

  const addOutputToLoot = async (record: DotNetExecutionRecord, stream: OutputStream): Promise<void> => {
    const expectedIdentity = identity;
    const metadata = outputMetadata(record, stream);
    if (!record.result || !metadata || !canAddOutputToLoot(record, stream)) {
      toast.warning("Output unavailable for Loot", { description: "The retained transcript can still be copied." });
      return;
    }
    setAddingToLoot(true);
    try {
      const response = await window.sliver.addExecutionOutputToLoot({
        requestId: record.result.requestId,
        stream: metadata.stream,
        name: "",
      });
      if (expectedIdentity !== identityRef.current || !mountedRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not add output to Loot.");
      toast.success("Output added to Loot", { description: response.value.name });
    } catch (error) {
      if (expectedIdentity === identityRef.current && mountedRef.current) {
        toast.danger("Could not add output to Loot", { description: errorMessage(error) });
      }
    } finally {
      if (expectedIdentity === identityRef.current && mountedRef.current) setAddingToLoot(false);
    }
  };

  return (
    <section
      aria-label=".NET assembly execution"
      className="mt-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(20rem,1fr)] overflow-y-auto rounded-2xl border border-separator bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden"
    >
      <ExecutionHistorySidebar
        label=".NET execution history"
        newExecutionKey="new-dotnet-execution"
        executionKeyPrefix="dotnet-execution:"
        items={historyRecords.map((record) => {
          const status = historyStatusIcon(record);
          return {
            id: record.id,
            title: `${record.assemblyName}${record.args.length ? ` ${formatArgv(record.args)}` : ""}`,
            startedAt: record.startedAt,
            stateLabel: stateLabel(record),
            statusIcon: status.icon,
            statusColor: status.color,
            contextActions: [{
              id: "copy-output",
              label: "Copy output",
              icon: faCopy,
              isDisabled: !record.stdout?.data.byteLength,
              onAction: () => identity === identityRef.current
                ? copyOutputBytes(historyRecordsRef.current.find((item) => item.id === record.id)?.stdout?.data)
                : undefined,
            }, {
              id: "add-stdout-to-loot",
              label: "Add stdout to Loot",
              icon: faBoxOpen,
              isDisabled: addingToLoot || !canAddOutputToLoot(record, "stdout"),
              onAction: () => {
                if (identity !== identityRef.current) return undefined;
                const current = historyRecordsRef.current.find((item) => item.id === record.id);
                if (current && canAddOutputToLoot(current, "stdout")) return addOutputToLoot(current, "stdout");
                return undefined;
              },
            }],
          };
        })}
        selectedId={selected?.id}
        onClearAll={() => void clearHistory()}
        onSelect={setSelectedId}
      />

      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto p-4 sm:p-5">
      {historyError ? <p className="mb-3 text-xs text-danger" role="alert">{historyError}</p> : null}
      {showingNew ? <section aria-label="Execute a .NET assembly" className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-foreground">Execute a .NET assembly</h3>
          <div className="flex items-center gap-2">
            <Tooltip delay={250}>
              <Button aria-label="Refresh assemblies" isDisabled={isBusy || catalogState.status === "loading"} isIconOnly size="sm" variant="ghost" onPress={() => void loadCatalog()}>
                <FontAwesomeIcon aria-hidden className="size-3" icon={faRotate} />
              </Button>
              <Tooltip.Content>Refresh assemblies</Tooltip.Content>
            </Tooltip>
            <Tooltip delay={250}>
              <Button aria-label="Open assembly file" isDisabled={isBusy} isIconOnly isPending={isChoosingFile} size="sm" variant="ghost" onPress={() => void chooseFile()}>
                <FontAwesomeIcon aria-hidden className="size-3.5" icon={faFolderOpen} />
              </Button>
              <Tooltip.Content>Open an assembly file</Tooltip.Content>
            </Tooltip>
            <Button form={FORM_ID} isDisabled={!canExecute} isPending={isPreparing || isExecuting} type="submit" variant="primary">
              <FontAwesomeIcon aria-hidden className="size-3.5" icon={faPlay} />Execute
            </Button>
          </div>
        </div>

        {!capability ? <p className="mb-4 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">.NET execution is unavailable for this target.</p> : !capability.available ? (
          <p className="mb-4 rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">{capability.reason?.message ?? ".NET execution is unavailable for this target."}</p>
        ) : null}
        {catalogState.status === "loading" ? <p className="mb-4 text-sm text-muted" role="status">Loading Armory assemblies…</p> : null}
        {catalogError ? <p className="mb-4 rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">{catalogError}</p> : null}

        <form className="flex flex-col gap-5" id={FORM_ID} onSubmit={(event) => void submit(event)}>
          <Autocomplete
            allowsEmptyCollection
            fullWidth
            placeholder="Select an Armory assembly"
            selectionMode="single"
            value={assemblyId || null}
            variant="secondary"
            onChange={(key) => selectAssembly(key === null || Array.isArray(key) ? "" : String(key))}
          >
            <Label>Armory assembly</Label>
            <Autocomplete.Trigger>
              <Autocomplete.Value>
                {({ defaultChildren }) => file?.fileName ??
                  (assembly ? `${assembly.commandName} · ${assembly.packageName}` : defaultChildren)}
              </Autocomplete.Value>
              <Autocomplete.ClearButton />
              <Autocomplete.Indicator />
            </Autocomplete.Trigger>
            <Description>{file
              ? `Local file · ${formatBytes(file.size)}`
              : assembly
                ? assembly.description || assembly.packageName
                : `${catalog?.assemblies.length ?? 0} assemblies for ${target.os}/${target.arch}. Type to search or browse.`}</Description>
            <Autocomplete.Popover>
              <Autocomplete.Filter filter={contains}>
                <SearchField autoFocus aria-label="Search assemblies" variant="secondary">
                  <SearchField.Group>
                    <SearchField.SearchIcon />
                    <SearchField.Input placeholder="Search assemblies…" />
                    <SearchField.ClearButton />
                  </SearchField.Group>
                </SearchField>
                <ListBox renderEmptyState={() => <p className="px-3 py-6 text-center text-sm text-muted">No matching assemblies.</p>}>
                  {(catalog?.assemblies ?? []).map((item) => (
                    <ListBox.Item id={item.id} key={item.id} textValue={`${item.commandName} ${item.packageName} ${item.description}`}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm font-medium text-foreground">{item.commandName}</span>
                        <span className="truncate text-xs text-muted">{item.packageName}{item.available ? "" : " · Unavailable"}</span>
                      </span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Autocomplete.Filter>
            </Autocomplete.Popover>
          </Autocomplete>

          {assembly && !assembly.available ? <p className="text-xs text-warning" role="alert">{assembly.reason ?? "This assembly is unavailable for the selected target."}</p> : null}
          {catalog && catalog.assemblies.length === 0 && !file ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">No Armory assemblies are installed for this target. Open a local assembly file or install one from Armory.</p> : null}

          <TextField fullWidth isDisabled={isBusy} variant="secondary" value={argumentsText} onChange={setArgumentsText}>
            <Label>Assembly arguments</Label>
            <Input placeholder="--flag 'value with spaces'" />
          </TextField>
          {!inProcess && joinedArgumentBytes !== undefined && joinedArgumentBytes > 256 ? (
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" role="alert">
              The default child-process loader limits joined assembly arguments to 256 bytes. These {joinedArgumentBytes} bytes may be truncated on the target. Review the arguments or use in-process execution.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">Assembly architecture</span>
              <NativeSelect className="w-full"><NativeSelect.Trigger aria-label="Assembly architecture" disabled={isBusy} value={architecture} onChange={(event) => setArchitecture(event.target.value as ExecuteAssemblyDraft["architecture"])}>
                <NativeSelect.Option value="x84">AnyCPU (x84)</NativeSelect.Option>
                <NativeSelect.Option value="x64">x64</NativeSelect.Option>
                <NativeSelect.Option value="x86">x86</NativeSelect.Option>
                <NativeSelect.Indicator />
              </NativeSelect.Trigger></NativeSelect>
            </div>
            <TextField fullWidth isDisabled={isBusy} isRequired variant="secondary" value={process} onChange={setProcess}>
              <Label>Host process</Label><Input />
            </TextField>
          </div>
          {isDll ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField fullWidth isDisabled={isBusy} variant="secondary" value={className} onChange={setClassName}>
                <Label>Class name</Label><Input placeholder="Namespace.Class" />
              </TextField>
              <TextField fullWidth isDisabled={isBusy} variant="secondary" value={method} onChange={setMethod}>
                <Label>Method name</Label><Input />
              </TextField>
            </div>
          ) : null}
          <Switch className="flex w-full items-center rounded-xl bg-surface-secondary px-3 py-2.5" isDisabled={isBusy} isSelected={inProcess} style={{ flexDirection: "row" }} onChange={(selected) => {
            setInProcess(selected);
            if (!selected) { setRuntime(""); setAmsiBypass(false); setEtwBypass(false); }
          }}>
            <Switch.Content className="flex min-w-0 flex-1 flex-col items-start">
              <span className="text-sm font-medium text-foreground">Run in process</span>
              <span className="mt-0.5 text-xs text-muted">Run inside the implant instead of a child host process.</span>
            </Switch.Content>
            <Switch.Control className="ml-3 shrink-0"><Switch.Thumb /></Switch.Control>
          </Switch>
          {inProcess ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField fullWidth isDisabled={isBusy} variant="secondary" value={runtime} onChange={setRuntime}>
                <Label>.NET runtime</Label><Input placeholder="Optional runtime" />
              </TextField>
              <Switch className="flex items-center gap-2" isDisabled={isBusy} isSelected={amsiBypass} onChange={setAmsiBypass}>
                <Switch.Content>AMSI bypass</Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch>
              <Switch className="flex items-center gap-2" isDisabled={isBusy} isSelected={etwBypass} onChange={setEtwBypass}>
                <Switch.Content>ETW bypass</Switch.Content><Switch.Control><Switch.Thumb /></Switch.Control>
              </Switch>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField fullWidth isDisabled={isBusy} variant="secondary" value={appDomain} onChange={setAppDomain}>
              <Label>AppDomain</Label><Input placeholder="Generated when omitted" />
            </TextField>
            <TextField fullWidth isDisabled={isBusy} variant="secondary" value={parentPid} onChange={setParentPid}>
              <Label>Parent process ID</Label><Input max={EXECUTION_LIMITS.pid} min={0} type="number" />
            </TextField>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField fullWidth isDisabled={isBusy} variant="secondary" value={processArgumentsText} onChange={setProcessArgumentsText}>
              <Label>Host process arguments</Label><Input placeholder="Optional host arguments" />
            </TextField>
            <TextField fullWidth isDisabled={isBusy} isRequired variant="secondary" value={timeoutSeconds} onChange={setTimeoutSeconds}>
              <Label>Timeout seconds</Label><Input max={3600} min={1} type="number" />
            </TextField>
          </div>
          {formError ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">{formError}</p> : null}
        </form>
      </section> : selected ? (
        <section aria-label=".NET execution details" className="flex min-h-full min-w-0 flex-1 flex-col">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="break-all font-mono text-sm font-medium text-foreground">{selected.assemblyName}</h3>
                <Chip color={stateColor(selected)} size="sm" variant="soft">{stateLabel(selected)}</Chip>
              </div>
              <p className="mt-0.5 text-xs text-muted">{new Date(selected.startedAt).toLocaleString()}</p>
            </div>
            <Tooltip delay={250}>
              <Button aria-label="Clear selected" isIconOnly size="sm" variant="danger-soft" onPress={() => void clearHistory(selected.id)}>
                <FontAwesomeIcon aria-hidden className="size-3" icon={faTrashCan} />
              </Button>
              <Tooltip.Content>Clear selected</Tooltip.Content>
            </Tooltip>
          </div>
          <dl aria-label="Execution details" className="mt-3 grid gap-3 rounded-xl bg-surface-secondary p-3 text-xs sm:grid-cols-2">
            <Detail label="Assembly" value={selected.assemblyName} />
            <Detail label="Arguments" value={formatArgv(selected.args) || "None"} />
          </dl>
          {selected.error || selected.outputError ? (
            <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="alert">{selected.error ?? selected.outputError}</p>
          ) : null}
          <DotNetOutputPanel
            key={selected.id}
            addingToLoot={addingToLoot}
            record={selected}
            onAddToLoot={addOutputToLoot}
            onHistoryChanged={loadHistory}
          />
        </section>
      ) : null}
      </div>
    </section>
  );
}

type OutputStream = "stdout" | "stderr";

function outputMetadata(record: DotNetExecutionRecord, stream: OutputStream) {
  return record.result?.output?.find((item) => item.stream === stream) ??
    (stream === "stdout" ? record.result?.output?.find((item) => item.stream === "combined") : undefined);
}

function hasRetainedOutput(record: DotNetExecutionRecord, stream: OutputStream): boolean {
  return Boolean((stream === "stdout" ? record.stdout : record.stderr)?.data.byteLength);
}

function canAddOutputToLoot(record: DotNetExecutionRecord, stream: OutputStream): boolean {
  const metadata = outputMetadata(record, stream);
  return hasRetainedOutput(record, stream) && Boolean(metadata && Date.parse(metadata.expiresAt) > Date.now());
}

function DotNetOutputPanel({
  addingToLoot,
  record,
  onAddToLoot,
  onHistoryChanged,
}: {
  addingToLoot: boolean;
  record: DotNetExecutionRecord;
  onAddToLoot: (record: DotNetExecutionRecord, stream: OutputStream) => Promise<void>;
  onHistoryChanged: () => Promise<void>;
}): React.JSX.Element {
  const [stream, setStream] = useState<OutputStream>("stdout");
  const [savingStream, setSavingStream] = useState<OutputStream>();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefreshPausedId, setAutoRefreshPausedId] = useState<string>();
  const resultRefreshInFlight = useRef(false);
  const output = stream === "stdout" ? record.stdout : record.stderr;
  const metadata = outputMetadata(record, stream);
  const canSave = Boolean(metadata && Date.parse(metadata.expiresAt) > Date.now());

  useEffect(() => { setStream("stdout"); }, [record.id]);

  const saveOutput = async (): Promise<void> => {
    if (!record.result || !metadata || !canSave) {
      toast.warning("Output download unavailable", { description: "The retained transcript can still be copied." });
      return;
    }
    setSavingStream(stream);
    try {
      const response = await window.sliver.saveExecutionResult({ requestId: record.result.requestId, stream: metadata.stream });
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not save output.");
      if (response.value.saved) toast.success("Output saved", { description: response.value.fileName });
    } catch (error) {
      toast.danger("Could not save output", { description: errorMessage(error) });
    } finally {
      setSavingStream(undefined);
    }
  };

  const refreshResult = useCallback(async (reportFailure = true): Promise<void> => {
    if (!record.result || resultRefreshInFlight.current) return;
    resultRefreshInFlight.current = true;
    setIsRefreshing(true);
    try {
      const response = await window.sliver.getExecutionResult({ requestId: record.result.requestId });
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not refresh the assembly result.");
      if (response.value.requestId !== record.id || response.value.operationId !== "execution.assembly") {
        throw new Error("The returned result did not match this assembly execution.");
      }
      await onHistoryChanged();
    } catch (error) {
      if (reportFailure) toast.danger("Could not refresh assembly result", { description: errorMessage(error) });
    } finally {
      resultRefreshInFlight.current = false;
      setIsRefreshing(false);
    }
  }, [record.id, record.result?.requestId, onHistoryChanged]);

  const pendingId = record.state === "submitted" && record.result ? record.id : undefined;
  useEffect(() => {
    setAutoRefreshPausedId(undefined);
    if (!pendingId) return;
    let disposed = false;
    let timer: number | undefined;
    let attempts = 0;
    let running = false;
    const schedule = (delay: number): void => {
      if (disposed || running || timer !== undefined || attempts >= AUTO_REFRESH_MAX_ATTEMPTS || document.visibilityState === "hidden") return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void poll();
      }, delay);
    };
    const poll = async (): Promise<void> => {
      if (disposed || running || document.visibilityState === "hidden") return;
      running = true;
      attempts += 1;
      try {
        await refreshResult(false);
      } finally {
        running = false;
        if (disposed) return;
        if (attempts >= AUTO_REFRESH_MAX_ATTEMPTS) {
          setAutoRefreshPausedId(pendingId);
          return;
        }
        schedule(Math.min(AUTO_REFRESH_INITIAL_DELAY_MS * 2 ** Math.floor(attempts / 5), AUTO_REFRESH_MAX_DELAY_MS));
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        if (timer !== undefined) window.clearTimeout(timer);
        timer = undefined;
      } else {
        schedule(AUTO_REFRESH_INITIAL_DELAY_MS);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule(AUTO_REFRESH_INITIAL_DELAY_MS);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [pendingId, refreshResult]);

  return (
    <section aria-label=".NET execution output" className="mt-3 flex min-h-40 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segment aria-label="Captured output stream" selectedKey={stream} size="sm" variant="ghost" onSelectionChange={(key) => setStream(String(key) as OutputStream)}>
            <Segment.Item id="stdout">Stdout</Segment.Item>
            <Segment.Item id="stderr">Stderr</Segment.Item>
          </Segment>
          <div aria-label="Output actions" className="flex flex-wrap items-center gap-2" role="group">
            <Button className="h-7 px-2.5 text-xs" isDisabled={!output?.data.byteLength} size="sm" variant="tertiary" onPress={() => void copyOutputBytes(output?.data)}>
              <FontAwesomeIcon aria-hidden className="size-3.5" icon={faCopy} />Copy output
            </Button>
            <Button className="h-7 px-2.5 text-xs" isDisabled={!canSave} isPending={savingStream === stream} size="sm" variant="tertiary" onPress={() => void saveOutput()}>
              <FontAwesomeIcon aria-hidden className="size-3.5" icon={faDownload} />Save {stream}
            </Button>
            <Button className="h-7 px-2.5 text-xs" isDisabled={addingToLoot || !canAddOutputToLoot(record, stream)} isPending={addingToLoot} size="sm" variant="outline" onPress={() => void onAddToLoot(record, stream)}>
              <FontAwesomeIcon aria-hidden className="size-3.5" icon={faBoxOpen} />Add {stream} to Loot
            </Button>
            {record.result && (record.state === "submitted" || record.state === "outcome-unknown") ? (
              <Button className="h-7 px-2.5 text-xs" isPending={isRefreshing} size="sm" variant="outline" onPress={() => void refreshResult()}>
                <FontAwesomeIcon aria-hidden className="size-3.5" icon={faRotate} />Refresh result
              </Button>
            ) : null}
          </div>
        </div>
        <span className="text-xs text-muted">Captured output</span>
      </div>
      {output?.data.byteLength && !canSave ? <p className="mt-2 text-xs text-muted">Saving and Loot are unavailable after the output expires. The retained transcript can still be copied.</p> : null}
      {autoRefreshPausedId === record.id ? <p className="mt-2 text-xs text-muted">Automatic refresh paused. Use Refresh result to check again.</p> : null}
      <div className={["-mr-4 mt-2 min-h-40 flex-1 overflow-hidden rounded-xl bg-surface-secondary sm:-mr-5", output?.truncated ? "" : "-mb-4 sm:-mb-5"].join(" ")}>
        {output?.data.byteLength ? (
          <ExecutionOutputTerminal bytes={output.data} className="h-full min-h-0" resetKey={`${record.id}:${stream}`} />
        ) : (
          <div className="flex h-full min-h-40 items-center justify-center px-5 text-center text-sm text-muted" role="status">
            {record.state === "running" || record.state === "submitted"
              ? "Waiting for the assembly result."
              : `No ${stream} was returned for this invocation.`}
          </div>
        )}
      </div>
      {output?.truncated ? <p className="mt-2 text-xs text-warning">The captured {stream} was truncated at the output limit.</p> : null}
    </section>
  );
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id &&
    left.backendEpoch === right.backendEpoch && left.fingerprint === right.fingerprint;
}

function cloneRecords(records: readonly DotNetExecutionRecord[]): readonly DotNetExecutionRecord[] {
  return records.map((record) => ({
    ...record,
    args: [...record.args],
    ...(record.result ? { result: {
      ...record.result,
      ...(record.result.output ? { output: record.result.output.map((item) => ({ ...item })) } : {}),
    } } : {}),
    ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
    ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
  }));
}

function clearOutput(records: readonly DotNetExecutionRecord[]): void {
  for (const record of records) {
    record.stdout?.data.fill(0);
    record.stderr?.data.fill(0);
  }
}

async function copyOutputBytes(bytes: Uint8Array | undefined): Promise<void> {
  if (!bytes?.byteLength) return;
  try {
    await navigator.clipboard.writeText(new TextDecoder().decode(bytes));
    toast.success("Output copied");
  } catch {
    toast.danger("Could not copy output", { description: "Select text in the terminal and use Copy instead." });
  }
}

function formatArgv(args: readonly string[]): string {
  return args.map((argument) => !argument || /[\s"']/u.test(argument) ? JSON.stringify(argument) : argument).join(" ");
}

function historyStatusIcon(record: DotNetExecutionRecord): { icon: IconDefinition; color: string } {
  if (record.state === "running" || record.state === "submitted") return { icon: faClock, color: "text-warning" };
  if (record.state === "outcome-unknown") return { icon: faCircleQuestion, color: "text-warning" };
  if (record.state === "completed") return { icon: faCircleCheck, color: "text-success" };
  return { icon: faCircleExclamation, color: "text-danger" };
}

function stateLabel(record: DotNetExecutionRecord): string {
  if (record.state === "request-failed") return "Request failed";
  if (record.state === "outcome-unknown") return "Outcome unknown";
  return record.state.charAt(0).toUpperCase() + record.state.slice(1);
}

function stateColor(record: DotNetExecutionRecord): "success" | "warning" | "danger" {
  if (record.state === "completed") return "success";
  if (record.state === "running" || record.state === "submitted" || record.state === "outcome-unknown") return "warning";
  return "danger";
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="mt-1 break-all font-mono text-foreground">{value}</dd></div>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The assembly request could not be completed.";
}

function parsedArgumentBytes(input: string): number | undefined {
  try {
    return new TextEncoder().encode(parseProcessArgv(input).join(" ")).length;
  } catch {
    return undefined;
  }
}
