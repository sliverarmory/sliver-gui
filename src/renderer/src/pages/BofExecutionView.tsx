import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Autocomplete, Button, Chip, Description, Input, Label, ListBox, SearchField, Switch, TextField, Tooltip, toast, useFilter } from "@heroui/react";
import { ChatListView, Segment } from "@heroui-pro/react";
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
  faPlay,
  faPlus,
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
import { ExecutionOutputTerminal } from "../components/ExecutionOutputTerminal";

type OutputStream = "stdout" | "stderr";
type CatalogState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: BofCatalog };
type HistoryState = { identityKey: string; revision: number; records: readonly BofExecutionRecord[]; error?: string };
type ArgumentValue = string | BofArgumentFileSelection | undefined;

const FORM_ID = "execution-bof-form";
const NEW_EXECUTION_KEY = "new-bof-execution";
const EXECUTION_KEY_PREFIX = "bof-execution:";
const EMPTY_HISTORY: readonly BofExecutionRecord[] = Object.freeze([]);
const AUTO_REFRESH_INITIAL_DELAY_MS = 3_000;
const AUTO_REFRESH_MAX_DELAY_MS = 15_000;
const AUTO_REFRESH_MAX_ATTEMPTS = 40;

interface BofExecutionViewProps {
  isRefreshing: boolean;
  target: TargetSummary;
  targetRef: TargetRef;
}

/** Armory BOFs execute through the main-owned catalog, file tokens, and history. */
export function BofExecutionView({ isRefreshing, target, targetRef }: BofExecutionViewProps): React.JSX.Element {
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
  const resultRefreshInFlight = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const identityRef = useRef(identityKey);
  identityRef.current = identityKey;
  const targetKeyRef = useRef(targetKey);
  targetKeyRef.current = targetKey;
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
  }, [targetKey]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    const sequence = ++catalogSequence.current;
    setCatalogState({ status: "loading" });
    try {
      const response = await window.sliver.listInstalledBofs();
      if (sequence !== catalogSequence.current || identityKey !== identityRef.current) return;
      if (!response.ok || !response.value) throw new Error(response.error ?? "Installed BOFs are unavailable.");
      if (!sameTargetIdentity(response.value.target, targetRef)) {
        throw new Error("The Armory BOF catalog no longer matches this target. Reselect the target and try again.");
      }
      setCatalogState({ status: "ready", value: response.value });
    } catch (error) {
      if (sequence === catalogSequence.current && identityKey === identityRef.current) {
        setCatalogState({ status: "error", message: errorMessage(error) });
      }
    }
  }, [identityKey, targetKey]);

  const loadHistory = useCallback(async (): Promise<void> => {
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
  }, [identityKey, targetKey]);

  useEffect(() => {
    void loadCatalog();
    void loadHistory();
    const unsubscribe = window.sliver.onBofExecutionHistoryChanged((changedTarget) => {
      if (sameTargetIdentity(changedTarget, targetRef)) void loadHistory();
    });
    return () => {
      catalogSequence.current += 1;
      historySequence.current += 1;
      executionSequence.current += 1;
      fileSequence.current += 1;
      unsubscribe();
    };
  }, [loadCatalog, loadHistory]);

  const catalog = catalogState.status === "ready" && sameTargetIdentity(catalogState.value.target, targetRef)
    ? catalogState.value : undefined;
  const command = catalog?.commands.find((item) => item.id === commandId);
  const historyRecords = historyState.identityKey === identityKey ? historyState.records : EMPTY_HISTORY;
  const historyError = historyState.identityKey === identityKey ? historyState.error : undefined;
  const selectedIndex = historyRecords.findIndex((record) => record.id === selectedId);
  const selected = selectedId === null ? undefined : historyRecords[selectedIndex < 0 ? 0 : selectedIndex];
  const showingNew = selected === undefined;
  const selectedHistoryKey = showingNew ? NEW_EXECUTION_KEY : `${EXECUTION_KEY_PREFIX}${selected.id}`;
  const output = stream === "stdout" ? selected?.stdout : selected?.stderr;

  useEffect(() => { setStream("stdout"); }, [selected?.id]);
  useEffect(() => { if (ignoreStderr) setStream("stdout"); }, [ignoreStderr]);

  const selectCommand = (id: string): void => {
    const next = catalog?.commands.find((item) => item.id === id);
    setCommandId(next?.id ?? "");
    setArgumentValues(next?.arguments.map((argument) => argument.default === undefined ? undefined : String(argument.default)) ?? []);
    setFormError(undefined);
    fileSequence.current += 1;
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
    if (!command || !command.available || isRefreshing || isExecuting) return;
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

  const copyOutput = async (): Promise<void> => {
    if (!output?.data.byteLength) return;
    try {
      await navigator.clipboard.writeText(new TextDecoder().decode(output.data));
      toast.success("Output copied");
    } catch {
      toast.danger("Could not copy output", { description: "Select text in the terminal and use Copy instead." });
    }
  };

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
      className="mt-4 grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(20rem,1fr)] overflow-y-auto rounded-2xl border border-separator bg-surface sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] sm:grid-rows-1 sm:overflow-hidden"
    >
      <aside className="flex min-h-0 min-w-0 flex-col border-b border-separator bg-background p-3 sm:border-b-0 sm:border-r sm:p-4">
        <nav aria-label="BOF execution history" className="min-h-0 sm:flex-1 sm:overflow-hidden">
          <ChatListView
            aria-label="BOF execution history"
            className="max-h-40 space-y-1 overflow-y-auto pr-1 sm:h-full sm:max-h-full"
            selectedKeys={new Set([selectedHistoryKey])}
            selectionBehavior="replace"
            selectionMode="single"
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const key = keys.values().next().value;
              if (key === NEW_EXECUTION_KEY) setSelectedId(null);
              else if (typeof key === "string" && key.startsWith(EXECUTION_KEY_PREFIX)) setSelectedId(key.slice(EXECUTION_KEY_PREFIX.length));
            }}
          >
            <ChatListView.Item
              className="sticky top-0 z-10 rounded-xl"
              id={NEW_EXECUTION_KEY}
              style={{
                backgroundColor: showingNew ? "var(--color-surface)" : "var(--color-background)",
                borderBottomColor: "transparent",
                boxShadow: showingNew ? "var(--shadow-surface)" : undefined,
              }}
              textValue="New Execution"
            >
              <ChatListView.ItemContent>
                <ChatListView.Icon><FontAwesomeIcon aria-hidden className="size-3.5 text-accent" icon={faPlus} /></ChatListView.Icon>
                <ChatListView.Text><ChatListView.Title>New Execution</ChatListView.Title></ChatListView.Text>
              </ChatListView.ItemContent>
            </ChatListView.Item>
            {historyRecords.map((record) => {
              const isSelected = record.id === selected?.id;
              const statusIcon = historyStatusIcon(record);
              return (
                <ChatListView.Item
                  className="rounded-xl"
                  id={`${EXECUTION_KEY_PREFIX}${record.id}`}
                  key={record.id}
                  style={{
                    backgroundColor: isSelected ? "var(--color-surface)" : undefined,
                    borderBottomColor: "transparent",
                    boxShadow: isSelected ? "var(--shadow-surface)" : undefined,
                  }}
                  textValue={record.commandName}
                >
                  <ChatListView.ItemContent>
                    <ChatListView.Icon><FontAwesomeIcon aria-hidden className={`size-3.5 ${statusIcon.color}`} icon={statusIcon.icon} /></ChatListView.Icon>
                    <ChatListView.Text>
                      <ChatListView.Title className="font-mono text-xs" title={record.commandName}>{record.commandName}</ChatListView.Title>
                      <ChatListView.Preview>{new Date(record.startedAt).toLocaleTimeString()} · {stateLabel(record)}</ChatListView.Preview>
                    </ChatListView.Text>
                  </ChatListView.ItemContent>
                </ChatListView.Item>
              );
            })}
          </ChatListView>
        </nav>
        {historyRecords.length === 0 ? <p className="px-4 pt-2 text-xs text-muted">No executions yet.</p> : null}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1">
          <span className="text-xs text-muted">History · {historyRecords.length}</span>
          <Button isDisabled={historyRecords.length === 0} size="sm" variant="danger-soft" onPress={() => void clearHistory()}>
            <FontAwesomeIcon aria-hidden className="size-3" icon={faTrashCan} />Clear history
          </Button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto p-4 sm:p-5">
        {historyError ? <p className="mb-3 text-xs text-danger" role="alert">{historyError}</p> : null}
        {showingNew ? (
          <section aria-label="Execute an Armory BOF" className="min-w-0">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-base font-semibold text-foreground">Execute an Armory BOF</h3>
              <div className="flex items-center gap-2">
                <Button isDisabled={catalogState.status === "loading" || isExecuting} size="sm" variant="ghost" onPress={() => { selectCommand(""); void loadCatalog(); }}>
                  <FontAwesomeIcon aria-hidden className="size-3" icon={faRotate} />Refresh BOFs
                </Button>
                <Button form={FORM_ID} isDisabled={!command?.available || isRefreshing || isExecuting || choosingFileIndex !== undefined} isPending={isExecuting} type="submit" variant="primary">
                  <FontAwesomeIcon aria-hidden className="size-3.5" icon={faPlay} />Execute
                </Button>
              </div>
            </div>
            {catalogState.status === "loading" ? <p className="text-sm text-muted" role="status">Loading installed Armory BOFs…</p> : null}
            {catalogState.status === "error" ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">{catalogState.message}</p> : null}
            {catalog ? (
              <form className="flex flex-col gap-5" id={FORM_ID} onSubmit={(event) => void submit(event)}>
                <Autocomplete
                  allowsEmptyCollection
                  fullWidth
                  placeholder="Select an installed BOF"
                  selectionMode="single"
                  value={commandId || null}
                  variant="secondary"
                  onChange={(key) => selectCommand(key === null || Array.isArray(key) ? "" : String(key))}
                >
                  <Label>Armory BOF</Label>
                  <Autocomplete.Trigger>
                    <Autocomplete.Value>
                      {({ defaultChildren, isPlaceholder }) => isPlaceholder || !command
                        ? defaultChildren
                        : `${command.commandName} · ${command.packageName}`}
                    </Autocomplete.Value>
                    <Autocomplete.ClearButton />
                    <Autocomplete.Indicator />
                  </Autocomplete.Trigger>
                  <Description>{catalog.commands.length} installed BOFs for {target.os}/{target.arch}. Type to search or browse.</Description>
                  <Autocomplete.Popover>
                    <Autocomplete.Filter filter={contains}>
                      <SearchField autoFocus aria-label="Search installed BOFs" variant="secondary">
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input placeholder="Search installed BOFs…" />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                      <ListBox renderEmptyState={() => <p className="px-3 py-6 text-center text-sm text-muted">No matching installed BOFs.</p>}>
                        {catalog.commands.map((item) => (
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
                {catalog.commands.length === 0 ? <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning-soft-foreground">No BOFs are installed in the local Armory directories.</p> : null}
                {catalog.warnings.map((warning) => <p className="text-xs text-warning" key={warning}>{warning}</p>)}
                {command ? (
                  <>
                    <div className="rounded-xl bg-surface-secondary p-3">
                      <p className="font-mono text-sm font-medium text-foreground">{command.commandName}</p>
                      <p className="mt-1 text-xs text-muted">{command.description || command.packageName}</p>
                    </div>
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
          </section>
        ) : selected ? (
          <div className="flex min-h-full min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-start justify-between gap-2">
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
            <div className="mt-2 min-h-40 flex-1 overflow-hidden rounded-xl bg-surface-secondary">
              {output?.data.byteLength ? (
                <ExecutionOutputTerminal bytes={output.data} className="h-full min-h-0" resetKey={`${selected.id}:${stream}`} />
              ) : (
                <div className="flex h-full min-h-40 items-center justify-center px-5 text-center text-sm text-muted">
                  {selected.state === "running" || selected.state === "submitted"
                    ? "Waiting for the BOF result."
                    : `No ${stream} was returned for this invocation.`}
                </div>
              )}
            </div>
            {output?.truncated ? <p className="mt-2 text-xs text-warning">The captured {stream} was truncated at the output limit.</p> : null}
          </div>
        ) : null}
      </div>
    </section>
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
