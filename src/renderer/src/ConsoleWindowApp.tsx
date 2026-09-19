import {
  createRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  Button,
  Spinner,
  Tabs,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faPlus,
  faTerminal,
  faTriangleExclamation,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

import type { OperationResult } from "../../shared/contracts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import {
  type ConsoleTabCloseResult,
  type ConsoleTabLaunchContext,
  type ConsoleWindowLaunchContext,
} from "../../shared/console-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import {
  GhosttyTerminal,
  type GhosttyTerminalHandle,
} from "./components/GhosttyTerminal";
import { applicationTerminalAppearance } from "./components/application-terminal-appearance";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { ConsoleTerminalTransport } from "./components/console-terminal-transport";
import {
  loadConsoleTerminalSettings,
  saveConsoleTerminalSettings,
} from "./components/console-terminal-settings";
import { TerminalSettingsModal } from "./components/TerminalSettingsModal";
import { RenamableTab } from "./components/RenamableTab";
import { RenameTabDialog } from "./components/RenameTabDialog";
import { terminalKeyboardShortcutForEvent, terminalTabShortcutLabels } from "./terminal-shortcuts";

const EMPTY_CONSOLE_TAB_KEY = "sliver-console-empty";

type ConsoleWindowPhase = "claiming" | "starting" | "ready";

interface ReadyConsoleTab {
  readonly context: ConsoleTabLaunchContext;
  readonly label: string;
  readonly transport: ConsoleTerminalTransport;
  readonly terminalRef: RefObject<GhosttyTerminalHandle | null>;
  readonly exitMessage: string | undefined;
  readonly terminalError: string | undefined;
  readonly actionError: string | undefined;
}

interface ConsoleWindowAPI {
  claimConsoleWindow(): Promise<OperationResult<ConsoleWindowLaunchContext>>;
  createConsoleTab(): Promise<OperationResult<ConsoleTabLaunchContext>>;
  closeConsoleTab(tabId: string): Promise<OperationResult<ConsoleTabCloseResult>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  onConsoleNewTabRequested(listener: () => void): () => void;
  onConsoleCloseTabRequested(listener: () => void): () => void;
  onConsoleSelectTabRequested(listener: (index: number) => void): () => void;
  onConsoleSettingsRequested(listener: () => void): () => void;
}

let pendingConsoleLaunchContext: Promise<OperationResult<ConsoleWindowLaunchContext>> | undefined;
let cachedConsoleTerminalRuntime: TerminalRuntimeAsset | undefined;
let pendingConsoleTerminalRuntime: Promise<TerminalRuntimeAsset> | undefined;

export function ConsoleWindowApp(): React.JSX.Element {
  const applicationSettings = useApplicationSettings();
  const shortcutSettings = applicationSettings?.settings ?? DEFAULT_APPLICATION_SETTINGS_STATE;
  const [phase, setPhase] = useState<ConsoleWindowPhase>("claiming");
  const [context, setContext] = useState<ConsoleWindowLaunchContext>();
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset>();
  const [tabs, setTabs] = useState<readonly ReadyConsoleTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string>();
  const [fatalError, setFatalError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [isCreatingTab, setIsCreatingTab] = useState(false);
  const [closingTabId, setClosingTabId] = useState<string>();
  const [renameTabId, setRenameTabId] = useState<string>();
  const [renameName, setRenameName] = useState("");
  const [localSettings, setLocalSettings] = useState(loadConsoleTerminalSettings);
  const settings = applicationSettings?.settings.terminal ?? localSettings;
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const tabsRef = useRef<readonly ReadyConsoleTab[]>([]);
  const activeTabIdRef = useRef<string | undefined>(undefined);
  const settingsRef = useRef(settings);
  const creatingTabRef = useRef(false);
  const closingTabRef = useRef(false);
  const tabHostReadyRef = useRef(false);

  const setActiveTabId = useCallback((tabId: string | undefined): void => {
    activeTabIdRef.current = tabId;
    setActiveTabIdState(tabId);
  }, []);

  const replaceTabs = useCallback(
    (update: (current: readonly ReadyConsoleTab[]) => readonly ReadyConsoleTab[]): void => {
      setTabs((current) => {
        const next = update(current);
        tabsRef.current = next;
        return next;
      });
    },
    [],
  );

  const updateTab = useCallback((tabId: string, update: Partial<ReadyConsoleTab>): void => {
    replaceTabs((current) => current.map((tab) => tab.context.tabId === tabId
      ? { ...tab, ...update }
      : tab));
  }, [replaceTabs]);

  const focusActiveTerminal = useCallback((): void => {
    const active = tabsRef.current.find(({ context: tabContext }) =>
      tabContext.tabId === activeTabIdRef.current);
    queueMicrotask(() => active?.terminalRef.current?.focus());
  }, []);

  const openSettings = useCallback((): void => {
    setSettingsDraft(settingsRef.current);
    setIsSettingsOpen(true);
  }, []);

  const openRenameTab = useCallback((tabId: string): void => {
    const tab = tabsRef.current.find(({ context: tabContext }) => tabContext.tabId === tabId);
    if (!tab) return;
    setRenameName(tab.label);
    setRenameTabId(tabId);
  }, []);

  const renameTab = useCallback((name: string): void => {
    if (!renameTabId || !tabsRef.current.some(({ context }) => context.tabId === renameTabId)) return;
    updateTab(renameTabId, { label: name });
    setRenameTabId(undefined);
    setRenameName("");
    focusActiveTerminal();
  }, [focusActiveTerminal, renameTabId, updateTab]);

  const selectTabByShortcut = useCallback((index: number): void => {
    const tab = tabsRef.current[index];
    if (!tab) return;
    setActiveTabId(tab.context.tabId);
    queueMicrotask(() => tab.terminalRef.current?.focus());
  }, [setActiveTabId]);

  const createTab = useCallback(async (): Promise<void> => {
    if (!tabHostReadyRef.current || creatingTabRef.current) return;
    creatingTabRef.current = true;
    setIsCreatingTab(true);
    setActionError(undefined);
    const api = consoleWindowApi();
    let tabContext: ConsoleTabLaunchContext | undefined;
    try {
      const result = await api.createConsoleTab();
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "A new Sliver console tab could not be started");
      }
      tabContext = result.value;
      const tab = await openConsoleTab(tabContext);
      replaceTabs((current) => [...current, tab]);
      setActiveTabId(tabContext.tabId);
    } catch (caught: unknown) {
      if (tabContext) await api.closeConsoleTab(tabContext.tabId).catch(() => undefined);
      setActionError(errorMessage(caught));
    } finally {
      creatingTabRef.current = false;
      setIsCreatingTab(false);
    }
  }, [replaceTabs, setActiveTabId]);

  const closeActiveTab = useCallback(async (): Promise<void> => {
    if (closingTabRef.current) return;
    const tabId = activeTabIdRef.current;
    const current = tabsRef.current;
    const index = current.findIndex(({ context: tabContext }) => tabContext.tabId === tabId);
    const tab = index < 0 ? undefined : current[index];
    if (!tab) return;

    closingTabRef.current = true;
    setClosingTabId(tab.context.tabId);
    setActionError(undefined);
    updateTab(tab.context.tabId, { actionError: undefined });
    try {
      const result = await consoleWindowApi().closeConsoleTab(tab.context.tabId);
      if (!result.ok) throw new Error(result.error ?? "The Sliver console tab could not be closed");
      tab.transport.close();
      const remaining = tabsRef.current.filter(({ context: tabContext }) =>
        tabContext.tabId !== tab.context.tabId);
      tabsRef.current = remaining;
      setTabs(remaining);
      const next = remaining[Math.min(index, remaining.length - 1)];
      setActiveTabId(next?.context.tabId);
      queueMicrotask(() => next?.terminalRef.current?.focus());
    } catch (caught: unknown) {
      updateTab(tab.context.tabId, { actionError: errorMessage(caught) });
    } finally {
      closingTabRef.current = false;
      setClosingTabId(undefined);
    }
  }, [setActiveTabId, updateTab]);

  useEffect(() => {
    let mounted = true;
    let transportPromise: Promise<ReadyConsoleTab> | undefined;
    tabHostReadyRef.current = false;

    void claimConsoleLaunchContext()
      .then(async (result) => {
        if (!mounted) return;
        if (!result.ok || !result.value || result.value.kind !== "console") {
          throw new Error(result.error ?? "This window is not authorized to host a Sliver console");
        }
        const launchContext = result.value;
        setPhase("starting");
        transportPromise = openConsoleTab(launchContext.initialTab);
        const [terminalRuntime, initialTab] = await Promise.all([
          loadConsoleTerminalRuntime(),
          transportPromise,
        ]);
        if (!mounted) {
          initialTab.transport.close();
          return;
        }
        tabsRef.current = [initialTab];
        setContext(launchContext);
        setRuntime(terminalRuntime);
        setTabs([initialTab]);
        setActiveTabId(launchContext.initialTab.tabId);
        tabHostReadyRef.current = true;
        setPhase("ready");
        setFatalError(undefined);
      })
      .catch(async (caught: unknown) => {
        if (transportPromise) {
          await transportPromise
            .then((tab) => tab.transport.close())
            .catch(() => undefined);
        }
        if (mounted) {
          tabHostReadyRef.current = false;
          setFatalError(errorMessage(caught));
        }
      });

    return () => {
      mounted = false;
      tabHostReadyRef.current = false;
      for (const tab of tabsRef.current) tab.transport.close();
      if (transportPromise) {
        void transportPromise.then((tab) => tab.transport.close()).catch(() => undefined);
      }
    };
  }, [setActiveTabId]);

  useEffect(() => {
    const api = consoleWindowApi();
    const unsubscribers = [
      api.onConsoleNewTabRequested(() => void createTab()),
      api.onConsoleCloseTabRequested(() => void closeActiveTab()),
      api.onConsoleSelectTabRequested(selectTabByShortcut),
      api.onConsoleSettingsRequested(openSettings),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [closeActiveTab, createTab, openSettings, selectTabByShortcut]);

  useEffect(() => {
    if (!context) return;
    const handleTabShortcut = (event: KeyboardEvent): void => {
      const shortcut = terminalKeyboardShortcutForEvent(shortcutSettings, event, context.shortcutModifier === "Command");
      if (!shortcut) return;
      // Electron claims native input in the main process. Keep this capture
      // guard as a renderer boundary too: Ghostty owns the focused target and
      // must never encode an application shortcut into PTY input.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (shortcut.type === "new-tab") {
        void createTab();
      } else {
        selectTabByShortcut(shortcut.index);
      }
    };
    window.addEventListener("keydown", handleTabShortcut, true);
    return () => window.removeEventListener("keydown", handleTabShortcut, true);
  }, [context, createTab, selectTabByShortcut, shortcutSettings]);

  useEffect(() => {
    settingsRef.current = settings;
    if (!isSettingsOpen) setSettingsDraft(settings);
  }, [isSettingsOpen, settings]);

  useEffect(() => {
    if (!renameTabId || tabs.some(({ context: tabContext }) => tabContext.tabId === renameTabId)) return;
    setRenameTabId(undefined);
    setRenameName("");
  }, [renameTabId, tabs]);

  const activeTab = tabs.find(({ context: tabContext }) => tabContext.tabId === activeTabId);
  useEffect(() => {
    if (!context) return;
    document.title = activeTab
      ? `Sliver console — ${context.configName} — ${activeTab.label}`
      : `Sliver console — ${context.configName}`;
  }, [activeTab, context]);

  const appearance = useMemo(() => applicationTerminalAppearance(
    settings,
    applicationSettings?.resolvedTheme ?? "dark",
    applicationSettings?.settings.reduceMotion ?? false,
  ), [applicationSettings?.resolvedTheme, applicationSettings?.settings.reduceMotion, settings]);

  if (fatalError) {
    return (
      <ConsoleWindowState
        title="Sliver console unavailable"
        description={fatalError}
        icon={faTriangleExclamation}
      />
    );
  }
  if (!context || !runtime) {
    return (
      <main className="grid min-h-screen place-items-center bg-background" aria-busy="true">
        <div className="flex items-center gap-3 text-sm text-muted" role="status">
          <Spinner size="sm" />
          <span>{phase === "claiming" ? "Claiming console window…" : "Starting Sliver console…"}</span>
        </div>
      </main>
    );
  }

  return (
    <main
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-background"
      aria-label="Sliver client console window"
    >
      <Tabs
        className="contents"
        selectedKey={activeTabId ?? EMPTY_CONSOLE_TAB_KEY}
        variant="secondary"
        onSelectionChange={(key) => setActiveTabId(String(key))}
      >
        <header className="flex h-16 min-h-16 flex-none items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <Tooltip delay={250}>
            <span
              aria-label={`Sliver client consoles using ${context.configName}`}
              className="grid size-9 flex-none place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground"
            >
              <FontAwesomeIcon aria-hidden icon={faTerminal} />
            </span>
            <Tooltip.Content placement="bottom">{context.configName}</Tooltip.Content>
          </Tooltip>

          <Tabs.ListContainer className="min-w-0 flex-1 rounded-none border-b border-border bg-transparent">
            <Tabs.List aria-label="Sliver console tabs" className="min-w-0 bg-transparent p-0 shadow-none">
              {tabs.map((tab, index) => {
                const state = consoleTabState(tab);
                const shortcutLabels = terminalTabShortcutLabels(index, shortcutSettings, context.shortcutModifier === "Command");
                return (
                  <RenamableTab
                    ariaLabel={`${tab.label} ${state === "connected" ? "Connected" : "Exited"}, shortcut ${shortcutLabels.accessible}`}
                    key={tab.context.tabId}
                    className="max-w-56 min-w-28 gap-2 rounded-none px-3 data-[selected=true]:text-foreground"
                    id={tab.context.tabId}
                    onRename={openRenameTab}
                  >
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${state === "connected" ? "bg-success" : "bg-warning"}`}
                    />
                    <span className="truncate">{tab.label}</span>
                    <kbd
                      aria-hidden
                      className="flex-none rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted tabular-nums"
                    >
                      {shortcutLabels.display}
                    </kbd>
                    <span className="sr-only"> {state === "connected" ? "Connected" : "Exited"}</span>
                    <Tabs.Indicator className="top-auto bottom-0 h-0.5 rounded-none bg-accent shadow-none" />
                  </RenamableTab>
                );
              })}
            </Tabs.List>
          </Tabs.ListContainer>

          <div className="flex flex-none items-center gap-1">
            <Tooltip delay={250}>
              <Button
                aria-label="New console tab"
                isIconOnly
                isPending={isCreatingTab}
                size="sm"
                variant="ghost"
                onPress={() => void createTab()}
              >
                <FontAwesomeIcon aria-hidden icon={faPlus} />
              </Button>
              <Tooltip.Content placement="bottom">New console tab</Tooltip.Content>
            </Tooltip>
            <Tooltip delay={250}>
              <Button
                aria-label="Close active console tab"
                isDisabled={!activeTab}
                isIconOnly
                isPending={closingTabId === activeTabId}
                size="sm"
                variant="ghost"
                onPress={() => void closeActiveTab()}
              >
                <FontAwesomeIcon aria-hidden icon={faXmark} />
              </Button>
              <Tooltip.Content placement="bottom">Close active console tab</Tooltip.Content>
            </Tooltip>
          </div>
        </header>

        <section
          className="relative min-h-0 flex-1"
          style={{ backgroundColor: appearance.theme?.background }}
          aria-label="Console terminal"
        >
          {tabs.map((tab) => {
            const isActive = tab.context.tabId === activeTabId;
            const message = tab.terminalError ?? tab.exitMessage ?? tab.actionError;
            return (
              <Tabs.Panel
                className="contents"
                id={tab.context.tabId}
                key={tab.context.tabId}
                shouldForceMount
              >
                <div
                  aria-hidden={!isActive}
                  className={isActive
                    ? "relative h-full min-h-0 w-full"
                    : "pointer-events-none invisible absolute inset-0 h-full min-h-0 w-full"}
                  data-console-terminal-tab-id={tab.context.tabId}
                  inert={isActive ? undefined : true}
                >
                  <GhosttyTerminal
                    enableClipboard
                    ref={tab.terminalRef}
                    appearance={appearance}
                    ariaLabel={`Sliver client ${tab.label} using ${context.configName}`}
                    className="h-full min-h-0"
                    transport={tab.transport}
                    wasmBytes={runtime.bytes}
                    onClose={(reason) => updateTab(tab.context.tabId, {
                      exitMessage: reason ?? "Sliver client exited",
                    })}
                    onError={(terminalError) => {
                      tab.transport.close();
                      updateTab(tab.context.tabId, { terminalError: terminalError.message });
                    }}
                  />
                  {message ? (
                    <ConsoleTabNotice
                      message={message}
                      title={tab.terminalError
                        ? "Terminal unavailable"
                        : tab.exitMessage
                          ? "Console process exited"
                          : "Console tab could not be closed"}
                    />
                  ) : null}
                </div>
              </Tabs.Panel>
            );
          })}
          {tabs.length === 0 ? (
            <div className="grid h-full place-items-center bg-background px-6 text-center">
              <div className="flex max-w-sm flex-col items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground">
                  <FontAwesomeIcon aria-hidden icon={faTerminal} />
                </span>
                <p className="text-sm font-semibold text-foreground">No console tabs</p>
                <p className="text-xs leading-relaxed text-muted">
                  Start another Sliver client using the active {context.configName} configuration.
                </p>
                <Button isPending={isCreatingTab} size="sm" onPress={() => void createTab()}>
                  New console tab
                </Button>
              </div>
            </div>
          ) : null}
          {actionError ? (
            <div
              aria-atomic="true"
              className="absolute inset-x-5 bottom-5 z-20 flex items-start gap-3 rounded-xl border border-danger/50 bg-overlay px-4 py-3 text-overlay-foreground shadow-overlay"
              role="alert"
            >
              <span className="grid size-8 flex-none place-items-center rounded-lg bg-danger text-danger-foreground">
                <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">Console tab action failed</p>
                <p className="mt-1 break-words text-xs leading-relaxed">{actionError}</p>
              </div>
            </div>
          ) : null}
        </section>
      </Tabs>

      <TerminalSettingsModal
        draft={settingsDraft}
        isOpen={isSettingsOpen}
        onDraftChange={setSettingsDraft}
        onOpenChange={(isOpen) => {
          setIsSettingsOpen(isOpen);
          if (!isOpen) {
            setSettingsDraft(settingsRef.current);
            focusActiveTerminal();
          }
        }}
        onSave={() => {
          const next = Object.freeze({ ...settingsDraft });
          if (applicationSettings) {
            void applicationSettings.updateSettings((current) => ({ ...current, terminal: next }))
              .then((saved) => {
                if (!saved) return;
                settingsRef.current = next;
                setIsSettingsOpen(false);
                focusActiveTerminal();
              });
            return;
          }
          saveConsoleTerminalSettings(next);
          settingsRef.current = next;
          setLocalSettings(next);
          setIsSettingsOpen(false);
          focusActiveTerminal();
        }}
      />

      <RenameTabDialog
        description="This name applies to this console window."
        isOpen={renameTabId !== undefined}
        name={renameName}
        originalName={tabs.find(({ context: tabContext }) => tabContext.tabId === renameTabId)?.label ?? ""}
        onNameChange={setRenameName}
        onOpenChange={(isOpen) => {
          if (isOpen) return;
          setRenameTabId(undefined);
          setRenameName("");
          focusActiveTerminal();
        }}
        onRename={renameTab}
      />
    </main>
  );
}

function ConsoleTabNotice({ title, message }: { readonly title: string; readonly message: string }): React.JSX.Element {
  return (
    <div
      aria-atomic="true"
      className="absolute inset-x-5 bottom-5 isolate flex items-start gap-3 rounded-xl border border-warning/50 bg-overlay px-4 py-3 text-overlay-foreground shadow-overlay"
      role="alert"
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-warning text-warning-foreground shadow-sm">
        <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-overlay-foreground">{message}</p>
      </div>
    </div>
  );
}

function consoleTabState(tab: ReadyConsoleTab): "connected" | "exited" {
  return tab.exitMessage || tab.terminalError ? "exited" : "connected";
}

function consoleWindowApi(): ConsoleWindowAPI {
  return window.sliver as unknown as ConsoleWindowAPI;
}

function claimConsoleLaunchContext(): Promise<OperationResult<ConsoleWindowLaunchContext>> {
  pendingConsoleLaunchContext ??= consoleWindowApi().claimConsoleWindow();
  return pendingConsoleLaunchContext;
}

async function openConsoleTab(context: ConsoleTabLaunchContext): Promise<ReadyConsoleTab> {
  return {
    context,
    label: context.label,
    transport: await ConsoleTerminalTransport.open({ attachmentToken: context.attachmentToken }),
    terminalRef: createRef<GhosttyTerminalHandle>(),
    exitMessage: undefined,
    terminalError: undefined,
    actionError: undefined,
  };
}

async function loadConsoleTerminalRuntime(): Promise<TerminalRuntimeAsset> {
  if (cachedConsoleTerminalRuntime) return cachedConsoleTerminalRuntime;
  if (pendingConsoleTerminalRuntime) return pendingConsoleTerminalRuntime;
  const request = consoleWindowApi().getTerminalRuntime()
    .then((result) => {
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Terminal runtime is unavailable");
      }
      const source = result.value.bytes;
      const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
      bytes.set(source);
      cachedConsoleTerminalRuntime = Object.freeze({
        version: result.value.version,
        sha256: result.value.sha256,
        bytes,
      });
      return cachedConsoleTerminalRuntime;
    })
    .catch((caught: unknown) => {
      cachedConsoleTerminalRuntime = undefined;
      throw caught;
    })
    .finally(() => {
      if (pendingConsoleTerminalRuntime === request) pendingConsoleTerminalRuntime = undefined;
    });
  pendingConsoleTerminalRuntime = request;
  return request;
}

function ConsoleWindowState({
  title,
  description,
  icon,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: typeof faTerminal;
}): React.JSX.Element {
  return (
    <main className="grid min-h-screen place-items-center bg-background p-8">
      <section className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12" aria-label={title}>
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <FontAwesomeIcon aria-hidden icon={icon} />
            </EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </section>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetConsoleWindowStateForTest(): void {
  pendingConsoleLaunchContext = undefined;
  cachedConsoleTerminalRuntime = undefined;
  pendingConsoleTerminalRuntime = undefined;
}
