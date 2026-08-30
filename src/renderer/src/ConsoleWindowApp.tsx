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
  Description,
  Label,
  ListBox,
  Modal,
  NumberField,
  Select,
  Spinner,
  Tabs,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faGear,
  faPlus,
  faTerminal,
  faTriangleExclamation,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

import type { OperationResult } from "../../shared/contracts";
import type {
  ConsoleTabCloseResult,
  ConsoleTabLaunchContext,
  ConsoleWindowLaunchContext,
} from "../../shared/console-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import {
  GhosttyTerminal,
  type GhosttyTerminalAppearance,
  type GhosttyTerminalHandle,
} from "./components/GhosttyTerminal";
import { SwitchRow } from "./components/FormControls";
import { ConsoleTerminalTransport } from "./components/console-terminal-transport";
import {
  CONSOLE_TERMINAL_FONTS,
  CONSOLE_TERMINAL_FONT_SIZE_MAX,
  CONSOLE_TERMINAL_FONT_SIZE_MIN,
  CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS,
  DEFAULT_CONSOLE_TERMINAL_SETTINGS,
  consoleTerminalFontFamily,
  isConsoleTerminalCursorStyle,
  isConsoleTerminalFontId,
  loadConsoleTerminalSettings,
  saveConsoleTerminalSettings,
  type ConsoleTerminalSettings,
} from "./components/console-terminal-settings";

const EMPTY_CONSOLE_TAB_KEY = "sliver-console-empty";

type ConsoleWindowPhase = "claiming" | "starting" | "ready";

interface ReadyConsoleTab {
  readonly context: ConsoleTabLaunchContext;
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
  const [phase, setPhase] = useState<ConsoleWindowPhase>("claiming");
  const [context, setContext] = useState<ConsoleWindowLaunchContext>();
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset>();
  const [tabs, setTabs] = useState<readonly ReadyConsoleTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string>();
  const [fatalError, setFatalError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [isCreatingTab, setIsCreatingTab] = useState(false);
  const [closingTabId, setClosingTabId] = useState<string>();
  const [settings, setSettingsState] = useState(loadConsoleTerminalSettings);
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
    settingsRef.current = settings;
  }, [settings]);

  const activeTab = tabs.find(({ context: tabContext }) => tabContext.tabId === activeTabId);
  useEffect(() => {
    if (!context) return;
    document.title = activeTab
      ? `Sliver console — ${context.configName} — ${activeTab.context.label}`
      : `Sliver console — ${context.configName}`;
  }, [activeTab, context]);

  const appearance = useMemo<GhosttyTerminalAppearance>(() => ({
    cursorBlink: settings.cursorBlink,
    cursorStyle: settings.cursorStyle,
    fontFamily: consoleTerminalFontFamily(settings.fontId),
    fontSize: settings.fontSize,
    smoothScrollDuration: settings.smoothScrolling
      ? CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS
      : 0,
  }), [settings]);

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

          <Tabs.ListContainer className="min-w-0 flex-1 rounded-none bg-transparent">
            <Tabs.List aria-label="Sliver console tabs" className="min-w-0 bg-transparent p-0 shadow-none">
              {tabs.map((tab, index) => {
                const state = consoleTabState(tab);
                const shortcutDigit = consoleTabShortcutDigit(index);
                return (
                  <Tabs.Tab
                    aria-label={`${tab.context.label} ${state === "connected" ? "Connected" : "Exited"}, shortcut Command+${shortcutDigit}`}
                    key={tab.context.tabId}
                    className="max-w-56 min-w-28 gap-2 rounded-lg px-3"
                    id={tab.context.tabId}
                  >
                    <span
                      aria-hidden
                      className={`size-2 shrink-0 rounded-full ${state === "connected" ? "bg-success" : "bg-warning"}`}
                    />
                    <span className="truncate">{tab.context.label}</span>
                    <kbd
                      aria-hidden
                      className="flex-none rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted tabular-nums"
                    >
                      ⌘{shortcutDigit}
                    </kbd>
                    <span className="sr-only"> {state === "connected" ? "Connected" : "Exited"}</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
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

        <section className="relative min-h-0 flex-1 bg-[#1e1e1e]" aria-label="Console terminal">
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
                    ref={tab.terminalRef}
                    appearance={appearance}
                    ariaLabel={`Sliver client ${tab.context.label} using ${context.configName}`}
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
          saveConsoleTerminalSettings(next);
          settingsRef.current = next;
          setSettingsState(next);
          setIsSettingsOpen(false);
          focusActiveTerminal();
        }}
      />
    </main>
  );
}

function TerminalSettingsModal({
  draft,
  isOpen,
  onDraftChange,
  onOpenChange,
  onSave,
}: {
  readonly draft: ConsoleTerminalSettings;
  readonly isOpen: boolean;
  readonly onDraftChange: (settings: ConsoleTerminalSettings) => void;
  readonly onOpenChange: (isOpen: boolean) => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const validFontSize = Number.isSafeInteger(draft.fontSize) &&
    draft.fontSize >= CONSOLE_TERMINAL_FONT_SIZE_MIN &&
    draft.fontSize <= CONSOLE_TERMINAL_FONT_SIZE_MAX;
  const selectedFont = CONSOLE_TERMINAL_FONTS.find(({ id }) => id === draft.fontId);

  return (
    <Modal.Backdrop isOpen={isOpen} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog className="sm:max-w-[460px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faGear} />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>Terminal Settings</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">
                Applied to every console tab in this window.
              </p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-5">
            <Select
              fullWidth
              value={draft.fontId}
              variant="secondary"
              onChange={(value) => {
                if (isConsoleTerminalFontId(value)) onDraftChange({ ...draft, fontId: value });
              }}
            >
              <Label>Font family</Label>
              <Select.Trigger>
                <Select.Value>{selectedFont?.label}</Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {CONSOLE_TERMINAL_FONTS.map((font) => (
                    <ListBox.Item id={font.id} key={font.id} textValue={font.label}>
                      <span style={{ fontFamily: `"${font.family}", monospace` }}>{font.label}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
              <Description>Embedded in Sliver GUI and available offline.</Description>
            </Select>

            <NumberField
              commitBehavior="validate"
              formatOptions={{ useGrouping: false }}
              isInvalid={!validFontSize}
              maxValue={CONSOLE_TERMINAL_FONT_SIZE_MAX}
              minValue={CONSOLE_TERMINAL_FONT_SIZE_MIN}
              step={1}
              value={draft.fontSize}
              variant="secondary"
              onChange={(fontSize) => onDraftChange({
                ...draft,
                fontSize: Number.isFinite(fontSize) ? Math.trunc(fontSize) : 0,
              })}
            >
              <Label>Font size</Label>
              <NumberField.Group className="grid-cols-1">
                <NumberField.Input />
              </NumberField.Group>
              <Description>{CONSOLE_TERMINAL_FONT_SIZE_MIN}–{CONSOLE_TERMINAL_FONT_SIZE_MAX} pixels.</Description>
            </NumberField>

            <Select
              fullWidth
              value={draft.cursorStyle}
              variant="secondary"
              onChange={(value) => {
                if (isConsoleTerminalCursorStyle(value)) {
                  onDraftChange({ ...draft, cursorStyle: value });
                }
              }}
            >
              <Label>Cursor shape</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="block">Block<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item id="underline">Underline<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item id="bar">Bar<ListBox.ItemIndicator /></ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>

            <div className="grid gap-px overflow-hidden rounded-xl bg-surface-secondary p-1">
              <SwitchRow
                description="Animate the cursor while the console is active."
                label="Blinking cursor"
                selected={draft.cursorBlink}
                onChange={(cursorBlink) => onDraftChange({ ...draft, cursorBlink })}
              />
              <SwitchRow
                description="Animate movement through terminal scrollback."
                label="Smooth scrolling"
                selected={draft.smoothScrolling}
                onChange={(smoothScrolling) => onDraftChange({ ...draft, smoothScrolling })}
              />
            </div>
          </Modal.Body>
          <Modal.Footer className="items-center justify-between gap-3">
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => onDraftChange(DEFAULT_CONSOLE_TERMINAL_SETTINGS)}
            >
              Reset defaults
            </Button>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="secondary" onPress={() => onOpenChange(false)}>Cancel</Button>
              <Button isDisabled={!validFontSize} size="sm" onPress={onSave}>Save</Button>
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
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

function consoleTabShortcutDigit(index: number): number {
  return index === 9 ? 0 : index + 1;
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
