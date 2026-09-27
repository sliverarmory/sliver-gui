import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Autocomplete, Button, Chip, Description, Input, Label, ListBox, ScrollShadow, SearchField, Switch, TextField, Tooltip, toast, useFilter } from "@heroui/react";
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
  faFileArrowUp,
  faFolderOpen,
  faPlay,
  faRotate,
  faTrashCan,
} from "@fortawesome/free-solid-svg-icons";

import type {
  BofArgumentDefinition,
  BofArgumentFileSelection,
  BofCatalog,
  BofExecutionHistorySnapshot,
  BofExecutionRecord,
} from "../../../shared/bof-contracts";
import type { TargetRef, TargetSummary } from "../../../shared/target-contracts";
import { ExecutionHistorySidebar } from "../components/ExecutionHistorySidebar";
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";
import type { ExecutionComposerState } from "./execution-composer-state";

type OutputStream = "stdout" | "stderr";
type CatalogState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; value: BofCatalog; refreshing?: boolean; error?: string };
type HistoryState = { identityKey: string; revision: number; records: readonly BofExecutionRecord[]; error?: string };
type ArgumentValue = string | BofArgumentFileSelection | undefined;

const FORM_ID = "execution-bof-form";
const EMPTY_HISTORY: readonly BofExecutionRecord[] = Object.freeze([]);
const AUTO_REFRESH_INITIAL_DELAY_MS = 3_000;
const AUTO_REFRESH_MAX_DELAY_MS = 15_000;
const AUTO_REFRESH_MAX_ATTEMPTS = 40;

interface BofExecutionViewProps {
  composerOnly?: boolean;
  formId?: string;
  onComposerStateChange?: (state: ExecutionComposerState) => void;
  onQueuedTask?: (taskId: string) => void;
  isRefreshing: boolean;
  target: TargetSummary;
  targetRef: TargetRef;
}

/** Armory BOFs execute through the main-owned catalog, file tokens, and history. */
export function BofExecutionView({ composerOnly = false, formId = FORM_ID, onComposerStateChange, onQueuedTask, isRefreshing, target, targetRef }: BofExecutionViewProps): React.JSX.Element {
  const targetKey = JSON.stringify([targetRef.mode, targetRef.id, targetRef.backendEpoch, targetRef.domainRevision, targetRef.fingerprint]);
  const identityKey = JSON.stringify([targetRef.mode, targetRef.id, targetRef.backendEpoch, targetRef.fingerprint]);
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: "loading" });
  const [historyState, setHistoryState] = useState<HistoryState>({ identityKey, revision: -1, records: EMPTY_HISTORY });
  const [selectedId, setSelectedId] = useState<string | null>();
  const [commandId, setCommandId] = useState("");
  const [argumentValues, setArgumentValues] = useState<ArgumentValue[]>([]);
  const [timeoutSeconds, setTimeoutSeconds] = useState("60");
  const [formError, setFormError] = useState<string>();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isChoosingDirectory, setIsChoosingDirectory] = useState(false);
  const [choosingFileIndex, setChoosingFileIndex] = useState<number>();
  const [stream, setStream] = useState<OutputStream>("stdout");
  const [ignoreStderr, setIgnoreStderr] = useState(false);
  const [savingStream, setSavingStream] = useState<OutputStream>();
  const [addingToLoot, setAddingToLoot] = useState(false);
  const [autoRefreshPausedId, setAutoRefreshPausedId] = useState<string>();
  const catalogSequence = useRef(0);
  const historySequence = useRef(0);
  const executionSequence = useRef(0);
  const fileSequence = useRef(0);
  const directorySequence = useRef(0);
  const resultRefreshInFlight = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
  const commandRef = useRef<BofCatalog["commands"][number] | undefined>(undefined);
  const { contains } = useFilter({ sensitivity: "base" });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => () => clearOutput(historyState.records), [historyState.records]);
  useEffect(() => {
    setHistoryState((current) => current.identityKey === identityKey
      ? current
      : { identityKey, revision: -1, records: EMPTY_HISTORY });
    setSelectedId(undefined);
  }, [identityKey]);
  useEffect(() => {
    setCommandId("");
    setArgumentValues([]);
    setFormError(undefined);
    fileSequence.current += 1;
    directorySequence.current += 1;
    setIsChoosingDirectory(false);
  }, [identityKey]);

  const loadCatalog = useCallback(async (preserveCurrent = false): Promise<void> => {
    const sequence = ++catalogSequence.current;
    // Inventory revisions can change for check-ins or another target. Keep the
    // current form mounted so its open picker, focus, and draft survive.
    setCatalogState((current) => preserveCurrent && current.status === "ready" && sameTargetIdentity(current.value.target, targetRef)
      ? { status: "ready", value: current.value, refreshing: true }
      : { status: "loading" });
    try {
      const response = await window.sliver.listInstalledBofs();
      if (sequence !== catalogSequence.current || identityKey !== identityRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Installed BOFs are unavailable.");
      if (!sameTargetIdentity(response.value.target, targetRef)) {
        throw new Error("The Armory BOF catalog no longer matches this target. Reselect the target and try again.");
      }
      const previousCommand = commandRef.current;
      const nextCommand = response.value.commands.find((item) => item.id === previousCommand?.id);
      if (previousCommand && (!nextCommand?.platformSupported ||
          JSON.stringify(previousCommand.arguments) !== JSON.stringify(nextCommand.arguments))) {
        setCommandId("");
        setArgumentValues([]);
        const reason = !nextCommand ? "The selected BOF is no longer installed."
          : !nextCommand.platformSupported ? "The selected BOF no longer supports this target's OS and architecture."
            : "The selected BOF's arguments changed.";
        setFormError(`${reason} Select a BOF again.`);
        fileSequence.current += 1;
      }
      setCatalogState({ status: "ready", value: response.value });
    } catch (error) {
      if (sequence === catalogSequence.current && identityKey === identityRef.current) {
        const message = errorMessage(error);
        setCatalogState((current) => preserveCurrent && current.status === "ready" && sameTargetIdentity(current.value.target, targetRef)
          ? { ...current, refreshing: false, error: message }
          : { status: "error", message });
      }
    }
  }, [identityKey, targetKey]);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (composerOnly) return;
    const sequence = ++historySequence.current;
    try {
      const response = await window.sliver.listBofExecutionHistory();
      if (sequence !== historySequence.current || identityKey !== identityRef.current) {
        if (response.ok && response.value) clearOutput(response.value.records);
        return;
      }
      if (!response.ok || !response.value) throw new Error(response.error ?? "BOF execution history is unavailable.");
      const snapshot: BofExecutionHistorySnapshot = response.value;
      if (!sameTargetIdentity(snapshot.target, targetRef)) {
        clearOutput(snapshot.records);
        return;
      }
      let records: readonly BofExecutionRecord[];
      try {
        records = cloneRecords(snapshot.records);
      } finally {
        clearOutput(snapshot.records);
      }
      setHistoryState((current) => {
        if (current.identityKey === identityKey && snapshot.revision < current.revision) {
          clearOutput(records);
          return current;
        }
        return { identityKey, revision: snapshot.revision, records };
      });
    } catch (error) {
      if (sequence === historySequence.current && identityKey === identityRef.current) {
        setHistoryState((current) => ({
          ...(current.identityKey === identityKey ? current : { identityKey, revision: -1, records: EMPTY_HISTORY }),
          error: errorMessage(error),
        }));
      }
    }
  }, [composerOnly, identityKey, targetKey]);

  useEffect(() => {
    void loadCatalog(true);
    void loadHistory();
    const unsubscribe = composerOnly ? () => undefined : window.sliver.onBofExecutionHistoryChanged((changedTarget) => {
      if (sameTargetIdentity(changedTarget, targetRef)) void loadHistory();
    });
    return () => {
      catalogSequence.current += 1;
      historySequence.current += 1;
      executionSequence.current += 1;
      fileSequence.current += 1;
      unsubscribe();
    };
  }, [composerOnly, loadCatalog, loadHistory]);

  const catalog = catalogState.status === "ready" && sameTargetIdentity(catalogState.value.target, targetRef)
    ? catalogState.value : undefined;
  const selectableCommands = catalog?.commands.filter((item) => item.platformSupported) ?? [];
  const isCatalogLoading = catalogState.status === "loading" || (catalogState.status === "ready" && catalogState.refreshing === true);
  const catalogError = catalogState.status === "error" ? catalogState.message : catalogState.status === "ready" ? catalogState.error : undefined;
  const command = selectableCommands.find((item) => item.id === commandId);
  commandRef.current = command;
  const historyRecords = historyState.identityKey === identityKey ? historyState.records : EMPTY_HISTORY;
  const historyRecordsRef = useRef(historyRecords);
  historyRecordsRef.current = historyRecords;
  const historyError = historyState.identityKey === identityKey ? historyState.error : undefined;
  const selectedIndex = historyRecords.findIndex((record) => record.id === selectedId);
  const selected = composerOnly || selectedId === null ? undefined : historyRecords[selectedIndex < 0 ? 0 : selectedIndex];
  const showingNew = composerOnly || selected === undefined;
  const output = stream === "stdout" ? selected?.stdout : selected?.stderr;

  useEffect(() => {
    onComposerStateChange?.({
      isPending: isExecuting,
      isAvailable: command?.available === true && !isRefreshing && !isCatalogLoading && !isChoosingDirectory &&
        catalogError === undefined && !isExecuting && choosingFileIndex === undefined,
      error: formError ?? catalogError ?? (command && !command.available ? command.reason : undefined),
    });
  }, [command?.available, command?.reason, isRefreshing, isCatalogLoading, isChoosingDirectory, catalogError, isExecuting, choosingFileIndex, formError, onComposerStateChange]);

  useEffect(() => { setStream("stdout"); }, [selected?.id]);
  useEffect(() => { if (ignoreStderr) setStream("stdout"); }, [ignoreStderr]);

  const selectCommand = (id: string, source = catalog): void => {
    const next = source?.commands.find((item) => item.id === id && item.platformSupported);
    setCommandId(next?.id ?? "");
    setArgumentValues(next?.arguments.map((argument) => argument.default === undefined ? undefined : String(argument.default)) ?? []);
    setFormError(undefined);
    fileSequence.current += 1;
  };

  const chooseDirectory = async (): Promise<void> => {
    const sequence = ++directorySequence.current;
    const expectedIdentity = identityKey;
    setIsChoosingDirectory(true);
    try {
      const response = await window.sliver.chooseBofDirectory();
      if (sequence !== directorySequence.current || expectedIdentity !== identityRef.current || !mountedRef.current) return;
      if (!response.ok) throw new Error(response.error ?? "Could not open the BOF directory.");
      if (!response.value) return;
      const { catalog: selectedCatalog, selectedCommandId } = response.value;
      if (!sameTargetIdentity(selectedCatalog.target, targetRef) ||
          !selectedCatalog.commands.some((item) => item.id === selectedCommandId)) {
        throw new Error("The selected BOF no longer matches this target. Reselect the target and try again.");
      }
      if (!selectedCatalog.commands.some((item) => item.id === selectedCommandId && item.platformSupported)) {
        throw new Error(`The selected BOF has no object for ${target.os}/${target.arch}.`);
      }
      // A pending Armory refresh must not replace the newly opened directory.
      catalogSequence.current += 1;
      setCatalogState({ status: "ready", value: selectedCatalog });
      selectCommand(selectedCommandId, selectedCatalog);
    } catch (error) {
      if (sequence === directorySequence.current && expectedIdentity === identityRef.current && mountedRef.current) {
        toast.danger("Could not open BOF directory", { description: errorMessage(error) });
      }
    } finally {
      if (sequence === directorySequence.current && mountedRef.current) setIsChoosingDirectory(false);
    }
  };

  const chooseFile = async (index: number): Promise<void> => {
    if (!command) return;
    const expectedCommandId = command.id;
    const sequence = ++fileSequence.current;
    setChoosingFileIndex(index);
    setFormError(undefined);
    try {
      const response = await window.sliver.chooseBofArgumentFile({ commandId: command.id, index });
      if (sequence !== fileSequence.current || expectedCommandId !== commandId) return;
      if (!response.ok) throw new Error(response.error ?? "Could not select the argument file.");
      if (!response.value) return;
      const selection = response.value;
      setArgumentValues((current) => current.map((value, currentIndex) => currentIndex === index ? selection : value));
    } catch (error) {
      if (sequence === fileSequence.current) setFormError(errorMessage(error));
    } finally {
      if (sequence === fileSequence.current) setChoosingFileIndex(undefined);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!command || !command.available || isRefreshing || isCatalogLoading || isChoosingDirectory || catalogError !== undefined || isExecuting) return;
    let args: (string | number | null)[];
    let timeout: number;
    try {
      args = command.arguments.map((definition, index) => parseArgumentValue(definition, argumentValues[index]));
      timeout = Number(timeoutSeconds);
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3_600) throw new Error("Timeout must be between 1 and 3600 seconds.");
      setFormError(undefined);
    } catch (error) {
      setFormError(errorMessage(error));
      return;
    }
    const sequence = ++executionSequence.current;
    const expectedIdentity = identityKey;
    setIsExecuting(true);
    try {
      const response = await window.sliver.runBof({ commandId: command.id, arguments: args, timeoutSeconds: timeout });
      if (sequence !== executionSequence.current || expectedIdentity !== identityRef.current) {
        if (response.ok && response.value) clearOutput([response.value]);
        return;
      }
      if (!response.ok || !response.value) throw new Error(response.error ?? "BOF execution failed.");
      const record = response.value;
      try {
        if (record.taskId && expectedIdentity === identityRef.current) onQueuedTask?.(record.taskId);
        setSelectedId(record.id);
        setArgumentValues(command.arguments.map((argument) => argument.default === undefined ? undefined : String(argument.default)));
        void loadHistory();
        if (record.state === "failed" || record.state === "request-failed") {
          toast.danger("BOF execution failed", { description: record.error });
        } else if (record.state === "outcome-unknown") {
          toast.warning("BOF outcome unknown", { description: record.error });
        } else {
          toast.success("BOF execution started", { description: command.commandName });
        }
      } finally {
        clearOutput([record]);
      }
    } catch (error) {
      if (sequence === executionSequence.current && expectedIdentity === identityRef.current) {
        setFormError(errorMessage(error));
        void loadHistory();
      }
    } finally {
      if (sequence === executionSequence.current && expectedIdentity === identityRef.current) setIsExecuting(false);
    }
  };

  const clearHistory = async (id?: string): Promise<void> => {
    try {
      const response = await window.sliver.clearBofExecutionHistory(id ? { id } : {});
      if (!response.ok) throw new Error(response.error ?? "Could not clear BOF execution history.");
      if (id === selectedId || !id) setSelectedId(undefined);
      await loadHistory();
    } catch (error) {
      toast.danger("Could not clear BOF history", { description: errorMessage(error) });
    }
  };

  const refreshResult = useCallback(async (id: string, reportFailure = true): Promise<void> => {
    if (resultRefreshInFlight.current !== undefined) return;
    resultRefreshInFlight.current = id;
    const expectedTargetKey = targetKey;
    try {
      const response = await window.sliver.getBofExecutionResult({ id });
      if (!response.ok || !response.value) {
        throw new Error(response.error ?? "Could not refresh this BOF result.");
      }
      const refreshed = response.value;
      const matches = refreshed.id === id;
      const needsHistory = refreshed.state !== "submitted" || Boolean(refreshed.stdout?.data.byteLength || refreshed.stderr?.data.byteLength);
      clearOutput([refreshed]);
      if (!matches) throw new Error("The returned BOF result did not match this invocation.");
      if (mountedRef.current && expectedTargetKey === targetKeyRef.current && needsHistory) await loadHistory();
    } catch (error) {
      if (reportFailure && mountedRef.current && expectedTargetKey === targetKeyRef.current) {
        toast.danger("Could not refresh BOF result", { description: errorMessage(error) });
      }
    } finally {
      if (resultRefreshInFlight.current === id) resultRefreshInFlight.current = undefined;
    }
  }, [loadHistory, targetKey]);

  const pendingId = selected?.state === "submitted" ? selected.id : undefined;
  useEffect(() => {
    setAutoRefreshPausedId(undefined);
    if (!pendingId) return;
    let disposed = false;
    let timer: number | undefined;
    let running = false;
    let attempts = 0;
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
        await refreshResult(pendingId, false);
      } finally {
        running = false;
        if (disposed) return;
        if (attempts >= AUTO_REFRESH_MAX_ATTEMPTS) {
          setAutoRefreshPausedId(pendingId);
          return;
        }
        const delay = Math.min(AUTO_REFRESH_INITIAL_DELAY_MS * 2 ** Math.floor(attempts / 5), AUTO_REFRESH_MAX_DELAY_MS);
        schedule(delay);
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

  const copyOutputBytes = async (bytes: Uint8Array | undefined): Promise<void> => {
    if (!bytes?.byteLength) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(bytes));
      toast.success("Output copied");
    } catch {
      toast.danger("Could not copy output", { description: "Select text in the terminal and use Copy instead." });
    }
  };

  const copyOutput = async (): Promise<void> => copyOutputBytes(output?.data);

  const historyRecordForAction = (id: string, expectedIdentity: string): BofExecutionRecord | undefined =>
    identityRef.current === expectedIdentity ? historyRecordsRef.current.find((record) => record.id === id) : undefined;

  const saveOutput = async (record: BofExecutionRecord, selectedStream: OutputStream): Promise<void> => {
    setSavingStream(selectedStream);
    try {
      const response = await window.sliver.saveBofOutput({ id: record.id, stream: selectedStream });
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not save BOF output.");
      if (response.value.saved) toast.success("Output saved", { description: response.value.fileName });
    } catch (error) {
      toast.danger("Could not save BOF output", { description: errorMessage(error) });
    } finally {
      setSavingStream(undefined);
    }
  };

  const addOutputToLoot = async (record: BofExecutionRecord, selectedStream: OutputStream): Promise<void> => {
    setAddingToLoot(true);
    try {
      const response = await window.sliver.addBofOutputToLoot({ id: record.id, stream: selectedStream, name: "" });
      if (!response.ok || !response.value) throw new Error(response.error ?? "Could not add BOF output to Loot.");
      toast.success("Output added to Loot", { description: response.value.name });
    } catch (error) {
      toast.danger("Could not add BOF output to Loot", { description: errorMessage(error) });
    } finally {
      setAddingToLoot(false);
    }
  };

  return (
    <section
      aria-label="BOF execution history and output"
      className={composerOnly ? "min-w-0" : "mt-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(20rem,1fr)] overflow-y-auto rounded-2xl border border-separator bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden"}
    >
      {!composerOnly ? <ExecutionHistorySidebar
        label="BOF execution history"
        newExecutionKey="new-bof-execution"
        executionKeyPrefix="bof-execution:"
        items={historyRecords.map((record) => {
          const status = historyStatusIcon(record);
          return {
            id: record.id,
            title: record.commandName,
            startedAt: record.startedAt,
            stateLabel: stateLabel(record),
            statusIcon: status.icon,
            statusColor: status.color,
            contextActions: [{
              id: "copy-output",
              label: "Copy output",
              icon: faCopy,
              isDisabled: !record.stdout?.data.byteLength,
              onAction: () => copyOutputBytes(historyRecordForAction(record.id, identityKey)?.stdout?.data),
            }, {
              id: "add-stdout-to-loot",
              label: "Add stdout to Loot",
              icon: faBoxOpen,
              isDisabled: !record.stdout?.data.byteLength || addingToLoot,
              onAction: () => {
                const current = historyRecordForAction(record.id, identityKey);
                if (current?.stdout?.data.byteLength) return addOutputToLoot(current, "stdout");
                return undefined;
              },
            }],
          };
        })}
        selectedId={selected?.id}
        onClearAll={() => void clearHistory()}
        onSelect={setSelectedId}
      /> : null}

      <div className="flex min-h-0 min-w-0 flex-col">
        {showingNew ? (
          <section aria-label="Execute an Armory BOF" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className={composerOnly ? "mb-3 flex justify-end" : "sticky top-0 z-10 flex shrink-0 flex-wrap items-center justify-between gap-3 bg-surface px-4 pb-4 pt-4 sm:px-5 sm:pt-5"}>
              {!composerOnly ? <h3 className="text-base font-semibold text-foreground">Execute an Armory BOF</h3> : null}
              <div className="flex items-center gap-2">
                <Tooltip delay={250}>
                  <Button aria-label="Refresh BOFs" isDisabled={isCatalogLoading || isChoosingDirectory || isExecuting} isIconOnly size="sm" variant="ghost" onPress={() => { selectCommand(""); void loadCatalog(); }}>
                    <FontAwesomeIcon aria-hidden className="size-3" icon={faRotate} />
                  </Button>
                  <Tooltip.Content>Refresh BOFs</Tooltip.Content>
                </Tooltip>
                <Tooltip delay={250}>
                  <Button aria-label="Open BOF directory" isDisabled={isChoosingDirectory || isExecuting} isIconOnly isPending={isChoosingDirectory} size="sm" variant="ghost" onPress={() => void chooseDirectory()}>
                    <FontAwesomeIcon aria-hidden className="size-3" icon={faFolderOpen} />
                  </Button>
                  <Tooltip.Content>Open BOF directory</Tooltip.Content>
                </Tooltip>
                {!composerOnly ? <Button form={formId} isDisabled={!command?.available || isRefreshing || isCatalogLoading || isChoosingDirectory || catalogError !== undefined || isExecuting || choosingFileIndex !== undefined} isPending={isExecuting} type="submit" variant="primary">
                  <FontAwesomeIcon aria-hidden className="size-3.5" icon={faPlay} />Execute
                </Button> : null}
              </div>
            </div>
            <BofExecutionScrollBody compact={composerOnly}>
              {historyError ? <p className="mb-3 text-xs text-danger" role="alert">{historyError}</p> : null}
              {catalogState.status === "loading" ? <p className="text-sm text-muted" role="status">Loading BOFs…</p> : null}
              {catalogError !== undefined ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">{catalogError}</p> : null}
              {catalog ? (
                <form className="flex flex-col gap-5" id={formId} onSubmit={(event) => void submit(event)}>
                  <Autocomplete
                    allowsEmptyCollection
                    fullWidth
                    placeholder="Select a BOF"
                    selectionMode="single"
                    value={commandId || null}
                    variant="secondary"
                    onChange={(key) => selectCommand(key === null || Array.isArray(key) ? "" : String(key))}
                  >
                    <Label>BOF</Label>
                    <Autocomplete.Trigger>
                      <Autocomplete.Value>
                        {({ defaultChildren, isPlaceholder }) => isPlaceholder || !command
                          ? defaultChildren
                          : `${command.commandName} · ${command.packageName}`}
                      </Autocomplete.Value>
                      <Autocomplete.ClearButton />
                      <Autocomplete.Indicator />
                    </Autocomplete.Trigger>
                    <Description>{command
                      ? command.description || command.packageName
                      : `${selectableCommands.length} BOFs for ${target.os}/${target.arch}. Type to search or browse.`}</Description>
                    <Autocomplete.Popover>
                      <Autocomplete.Filter filter={contains}>
                        <SearchField autoFocus aria-label="Search BOFs" variant="secondary">
                          <SearchField.Group>
                            <SearchField.SearchIcon />
                            <SearchField.Input placeholder="Search BOFs…" />
                            <SearchField.ClearButton />
                          </SearchField.Group>
                        </SearchField>
                        <ListBox renderEmptyState={() => <p className="px-3 py-6 text-center text-sm text-muted">No matching BOFs.</p>}>
                          {selectableCommands.map((item) => (
                            <ListBox.Item
                              id={item.id}
                              key={item.id}
                              textValue={`${item.commandName} ${item.packageName} ${item.description}`}
                            >
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
                  {selectableCommands.length === 0 ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">No BOFs match {target.os}/{target.arch}. Refresh the Armory catalog or open a BOF directory.</p> : null}
                  {catalog.warnings.map((warning) => <p className="text-xs text-warning" key={warning}>{warning}</p>)}
                  {command ? (
                    <>
                      {!command.available ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground" role="alert">{command.reason ?? "This BOF is unavailable for the selected target."}</p> : null}
                      {command.arguments.length ? (
                        <section aria-label="BOF arguments" className="space-y-4">
                          <h4 className="text-sm font-semibold text-foreground">Arguments</h4>
                          <div className="grid gap-4 md:grid-cols-2">
                            {command.arguments.map((definition, index) => (
                              <BofArgumentField
                                definition={definition}
                                disabled={isExecuting || !command.available}
                                isChoosingFile={choosingFileIndex === index}
                                key={`${command.id}:${index}`}
                                value={argumentValues[index]}
                                onChange={(value) => setArgumentValues((current) => current.map((existing, currentIndex) => currentIndex === index ? value : existing))}
                                onChooseFile={() => void chooseFile(index)}
                              />
                            ))}
                          </div>
                        </section>
                      ) : <p className="text-sm text-muted">This BOF takes no arguments.</p>}
                      <TextField className="max-w-xs" fullWidth isRequired variant="secondary" value={timeoutSeconds} onChange={setTimeoutSeconds}>
                        <Label>Timeout seconds</Label><Input max={3600} min={1} type="number" />
                        <Description>Wait up to 3600 seconds for the BOF result.</Description>
                      </TextField>
                    </>
                  ) : null}
                  {formError ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">{formError}</p> : null}
                </form>
              ) : null}
            </BofExecutionScrollBody>
          </section>
        ) : selected ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="sticky top-0 z-10 flex shrink-0 flex-wrap items-start justify-between gap-2 bg-surface px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="break-all font-mono text-sm font-medium text-foreground">{selected.commandName}</h3>
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
            <BofExecutionScrollBody fillHeight>
              {historyError ? <p className="mb-3 text-xs text-danger" role="alert">{historyError}</p> : null}
              <dl aria-label="Execution details" className="mt-3 grid gap-3 rounded-xl bg-surface-secondary p-3 text-xs sm:grid-cols-2">
                <Detail label="BOF" value={selected.commandName} />
                <Detail label="Task" value={selected.taskId ?? "Not reported"} />
              </dl>
              {selected.error ? <p className="mt-3 rounded-xl bg-warning-soft px-3 py-2 text-xs text-warning-soft-foreground" role="alert">{selected.error}</p> : null}
              {autoRefreshPausedId === selected.id ? <p className="mt-2 text-xs text-muted">Automatic refresh paused. Use Refresh result to check again.</p> : null}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <Segment aria-label="Captured output stream" selectedKey={stream} size="sm" variant="ghost" onSelectionChange={(key) => setStream(String(key) as OutputStream)}>
                    <Segment.Item id="stdout">Stdout</Segment.Item>
                    {!ignoreStderr ? <Segment.Item id="stderr">Stderr</Segment.Item> : null}
                  </Segment>
                  <div aria-label="Output actions" className="flex flex-wrap items-center gap-2" role="group">
                    <Button className="h-7 px-2.5 text-xs" isDisabled={!output?.data.byteLength} size="sm" variant="tertiary" onPress={() => void copyOutput()}>
                      <FontAwesomeIcon aria-hidden className="size-3.5" icon={faCopy} />Copy output
                    </Button>
                    <Button className="h-7 px-2.5 text-xs" isDisabled={!output?.data.byteLength} isPending={savingStream === stream} size="sm" variant="tertiary" onPress={() => void saveOutput(selected, stream)}>
                      <FontAwesomeIcon aria-hidden className="size-3.5" icon={faDownload} />Save {stream}
                    </Button>
                    {output?.data.byteLength ? (
                      <Button className="h-7 px-2.5 text-xs" isPending={addingToLoot} size="sm" variant="outline" onPress={() => void addOutputToLoot(selected, stream)}>
                        <FontAwesomeIcon aria-hidden className="size-3.5" icon={faBoxOpen} />Add {stream} to Loot
                      </Button>
                    ) : null}
                    {selected.state === "submitted" || selected.state === "outcome-unknown" ? (
                      <Button className="h-7 px-2.5 text-xs" size="sm" variant="outline" onPress={() => void refreshResult(selected.id)}>
                        <FontAwesomeIcon aria-hidden className="size-3.5" icon={faRotate} />Refresh result
                      </Button>
                    ) : null}
                  </div>
                </div>
                <Switch className="flex items-center gap-2" isSelected={ignoreStderr} style={{ flexDirection: "row" }} onChange={setIgnoreStderr}>
                  <Switch.Content className="text-xs text-muted">Ignore stderr</Switch.Content>
                  <Switch.Control><Switch.Thumb /></Switch.Control>
                </Switch>
              </div>
              <div className="-mr-4 mt-2 flex min-h-40 flex-1 flex-col overflow-hidden rounded-xl bg-surface-secondary sm:-mr-5">
                {output?.data.byteLength ? (
                  <ExecutionOutputTerminal bytes={output.data} className="min-h-0 flex-1" resetKey={`${selected.id}:${stream}`} />
                ) : (
                  <div className="flex min-h-40 flex-1 items-center justify-center px-5 text-center text-sm text-muted">
                    {selected.state === "running" || selected.state === "submitted"
                      ? "Waiting for the BOF result."
                      : `No ${stream} was returned for this invocation.`}
                  </div>
                )}
              </div>
              {output?.truncated ? <p className="mt-2 pb-4 text-xs text-warning sm:pb-5">The captured {stream} was truncated at the output limit.</p> : null}
            </BofExecutionScrollBody>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function BofExecutionScrollBody({ children, fillHeight = false, compact = false }: {
  children: ReactNode;
  fillHeight?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    // The form and output can grow without changing the viewport's size.
    const observer = new ResizeObserver(() => viewport.dispatchEvent(new Event("scroll")));
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <ScrollShadow
      ref={viewportRef}
      aria-label="BOF execution content"
      className={compact ? "min-w-0" : `min-h-0 flex-1 overflow-y-auto px-4 sm:px-5${fillHeight ? "" : " pb-4 sm:pb-5"}`}
      hideScrollBar={false}
      orientation="vertical"
      role="region"
      size={28}
      tabIndex={0}
    >
      <div ref={contentRef} className={fillHeight ? "flex min-h-full min-w-0 flex-col" : "min-w-0"}>{children}</div>
    </ScrollShadow>
  );
}

function BofArgumentField({
  definition,
  disabled,
  isChoosingFile,
  value,
  onChange,
  onChooseFile,
}: {
  definition: BofArgumentDefinition;
  disabled: boolean;
  isChoosingFile: boolean;
  value: ArgumentValue;
  onChange: (value: ArgumentValue) => void;
  onChooseFile: () => void;
}): React.JSX.Element {
  const label = `${definition.name}${definition.optional ? " (optional)" : ""}`;
  if (definition.type === "file") {
    const selected = typeof value === "object" ? value : undefined;
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Button aria-label={`Choose file for ${definition.name}`} isDisabled={disabled} isPending={isChoosingFile} size="sm" variant="secondary" onPress={onChooseFile}>
            <FontAwesomeIcon aria-hidden className="size-3.5" icon={faFileArrowUp} />Choose file
          </Button>
          {selected ? <span className="min-w-0 break-all text-xs text-foreground">{selected.fileName}</span> : <span className="text-xs text-muted">No file selected</span>}
          {selected ? <Button isDisabled={disabled} size="sm" variant="ghost" onPress={() => onChange(undefined)}>Clear</Button> : null}
        </div>
        {definition.description ? <p className="text-xs leading-5 text-muted">{definition.description}</p> : null}
      </div>
    );
  }
  const textValue = typeof value === "string" ? value : "";
  if (definition.choices?.length) {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <NativeSelect className="w-full"><NativeSelect.Trigger aria-label={definition.name} disabled={disabled} value={textValue} onChange={(event) => onChange(event.target.value)}>
          <NativeSelect.Option value="">Select a value</NativeSelect.Option>
          {definition.choices.map((choice) => <NativeSelect.Option key={String(choice)} value={String(choice)}>{String(choice)}</NativeSelect.Option>)}
          <NativeSelect.Indicator />
        </NativeSelect.Trigger></NativeSelect>
        {definition.description ? <p className="text-xs leading-5 text-muted">{definition.description}</p> : null}
      </div>
    );
  }
  const numeric = definition.type === "int" || definition.type === "integer" || definition.type === "short";
  return (
    <TextField fullWidth isDisabled={disabled} isRequired={!definition.optional} variant="secondary" value={textValue} onChange={onChange}>
      <Label>{label}</Label>
      <Input
        type={numeric ? "number" : "text"}
        {...(numeric ? { step: 1, min: definition.type === "short" ? -32_768 : -2_147_483_648, max: definition.type === "short" ? 65_535 : 4_294_967_295 } : {})}
      />
      {definition.description ? <Description>{definition.description}</Description> : null}
    </TextField>
  );
}

function parseArgumentValue(definition: BofArgumentDefinition, value: ArgumentValue): string | number | null {
  if (definition.type === "file") {
    if (value && typeof value === "object") return value.token;
    if (definition.optional) return null;
    throw new Error(`${definition.name} requires a file.`);
  }
  const raw = typeof value === "string" ? value : "";
  if (!raw && definition.optional) return null;
  if (!raw) throw new Error(`${definition.name} is required.`);
  if (definition.choices?.length && !definition.choices.some((choice) => String(choice) === raw)) {
    throw new Error(`${definition.name} must be one of its manifest choices.`);
  }
  if (definition.type === "string" || definition.type === "wstring") return raw;
  const number = Number(raw);
  const minimum = definition.type === "short" ? -32_768 : -2_147_483_648;
  const maximum = definition.type === "short" ? 65_535 : 4_294_967_295;
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${definition.name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function cloneRecords(records: readonly BofExecutionRecord[]): readonly BofExecutionRecord[] {
  return records.map((record) => ({
    ...record,
    ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
    ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
  }));
}

function clearOutput(records: readonly BofExecutionRecord[]): void {
  for (const record of records) {
    record.stdout?.data.fill(0);
    record.stderr?.data.fill(0);
  }
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id &&
    left.backendEpoch === right.backendEpoch && left.fingerprint === right.fingerprint;
}

function historyStatusIcon(record: BofExecutionRecord): { icon: IconDefinition; color: string } {
  if (record.state === "running" || record.state === "submitted") return { icon: faClock, color: "text-warning" };
  if (record.state === "outcome-unknown") return { icon: faCircleQuestion, color: "text-warning" };
  if (record.state === "completed") return { icon: faCircleCheck, color: "text-success" };
  return { icon: faCircleExclamation, color: "text-danger" };
}

function stateLabel(record: BofExecutionRecord): string {
  if (record.state === "request-failed") return "Request failed";
  if (record.state === "outcome-unknown") return "Outcome unknown";
  return record.state.charAt(0).toUpperCase() + record.state.slice(1);
}

function stateColor(record: BofExecutionRecord): "success" | "warning" | "danger" {
  if (record.state === "completed") return "success";
  if (record.state === "running" || record.state === "submitted" || record.state === "outcome-unknown") return "warning";
  return "danger";
}

function Detail({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="min-w-0"><dt className="text-muted">{label}</dt><dd className="mt-1 break-all font-mono text-foreground">{value}</dd></div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The BOF request could not be completed.";
}
