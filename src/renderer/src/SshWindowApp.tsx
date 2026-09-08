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
  AlertDialog,
  Button,
  Chip,
  Modal,
  Spinner,
  Tabs,
  Tooltip,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { faAmazon } from "@fortawesome/free-brands-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faKey,
  faPlus,
  faServer,
  faTerminal,
  faTriangleExclamation,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import type { OperationResult } from "../../shared/contracts";
import {
  SSH_MAX_TABS_PER_WINDOW,
  type ManagedSshTarget,
  type SshHostKeyReview,
  type SshOpenTabResult,
  type SshTabLaunchContext,
  type SshWindowAPI,
  type SshWindowLaunchContext,
} from "../../shared/ssh-contracts";
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

const EMPTY_SSH_TAB_KEY = "sliver-ssh-empty";

type SshWindowPhase = "claiming" | "starting" | "ready";

interface SshTab {
  readonly context: SshTabLaunchContext;
  readonly transport: ConsoleTerminalTransport | undefined;
  readonly terminalRef: RefObject<GhosttyTerminalHandle | null>;
  readonly attachmentError: string | undefined;
  readonly exitMessage: string | undefined;
  readonly terminalError: string | undefined;
  readonly actionError: string | undefined;
}

interface AttachedSshTab extends SshTab {
  readonly transport: ConsoleTerminalTransport;
}

let pendingSshLaunchContext: Promise<OperationResult<SshWindowLaunchContext>> | undefined;
let cachedSshTerminalRuntime: TerminalRuntimeAsset | undefined;
let pendingSshTerminalRuntime: Promise<TerminalRuntimeAsset> | undefined;

export function SshWindowApp(): React.JSX.Element {
  const api = sshWindowApi();
  const applicationSettings = useApplicationSettings();
  const [phase, setPhase] = useState<SshWindowPhase>("claiming");
  const [context, setContext] = useState<SshWindowLaunchContext>();
  const [runtime, setRuntime] = useState<TerminalRuntimeAsset>();
  const [tabs, setTabs] = useState<readonly SshTab[]>([]);
  const [activeTabId, setActiveTabIdState] = useState<string>();
  const [fatalError, setFatalError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [closingTabId, setClosingTabId] = useState<string>();
  const [retryingTabId, setRetryingTabId] = useState<string>();
  const [renameTabId, setRenameTabId] = useState<string>();
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string>();
  const [isRenamingTab, setIsRenamingTab] = useState(false);
  const [openingDeploymentId, setOpeningDeploymentId] = useState<string>();
  const [targets, setTargets] = useState<readonly ManagedSshTarget[]>([]);
  const [isTargetPickerOpen, setIsTargetPickerOpen] = useState(false);
  const [isLoadingTargets, setIsLoadingTargets] = useState(false);
  const [targetPickerError, setTargetPickerError] = useState<string>();
  const [hostKeyReview, setHostKeyReview] = useState<SshHostKeyReview>();
  const [hostKeyReviewError, setHostKeyReviewError] = useState<string>();
  const [isApprovingHostKey, setIsApprovingHostKey] = useState(false);
  const [localSettings, setLocalSettings] = useState(loadConsoleTerminalSettings);
  const settings = applicationSettings?.settings.terminal ?? localSettings;
  const [settingsDraft, setSettingsDraft] = useState(settings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const tabsRef = useRef<readonly SshTab[]>([]);
  const activeTabIdRef = useRef<string | undefined>(undefined);
  const settingsRef = useRef(settings);
  const mountedRef = useRef(false);
  const tabHostReadyRef = useRef(false);
  const openingTabIdsRef = useRef(new Set<string>());
  const pendingOpenedContextsRef = useRef<SshTabLaunchContext[]>([]);
  const pendingActiveTabIdRef = useRef<string | undefined>(undefined);
  const pendingPickerRequestRef = useRef(false);
  const closingTabRef = useRef(false);
  const retryingTabRef = useRef<string | undefined>(undefined);
  const openingTargetRef = useRef(false);
  const approvingHostKeyRef = useRef(false);
  const renamingTabRef = useRef(false);

  const setActiveTabId = useCallback((tabId: string | undefined): void => {
    activeTabIdRef.current = tabId;
    setActiveTabIdState(tabId);
  }, []);

  const replaceTabs = useCallback(
    (update: (current: readonly SshTab[]) => readonly SshTab[]): void => {
      setTabs((current) => {
        const next = update(current);
        tabsRef.current = next;
        return next;
      });
    },
    [],
  );

  const updateTab = useCallback((tabId: string, update: Partial<SshTab>): void => {
    replaceTabs((current) => current.map((tab) => tab.context.tabId === tabId
      ? { ...tab, ...update }
      : tab));
  }, [replaceTabs]);

  const focusActiveTerminal = useCallback((): void => {
    const active = tabsRef.current.find(({ context: tabContext }) =>
      tabContext.tabId === activeTabIdRef.current);
    queueMicrotask(() => active?.terminalRef.current?.focus());
  }, []);

  const selectTab = useCallback((tabId: string, persist = true): void => {
    const tab = tabsRef.current.find(({ context: tabContext }) => tabContext.tabId === tabId);
    if (!tab) {
      pendingActiveTabIdRef.current = tabId;
      return;
    }
    pendingActiveTabIdRef.current = undefined;
    setActiveTabId(tabId);
    queueMicrotask(() => tab.terminalRef.current?.focus());
    if (!persist || !api) return;
    void api.selectSshTab({ tabId }).then((result) => {
      if (!result.ok && mountedRef.current) {
        setActionError(result.error ?? "The active SSH tab could not be saved");
      }
    }).catch((caught: unknown) => {
      if (mountedRef.current) setActionError(errorMessage(caught));
    });
  }, [api, setActiveTabId]);

  const adoptTabContext = useCallback(async (
    tabContext: SshTabLaunchContext,
    makeActive = true,
  ): Promise<boolean> => {
    const existing = tabsRef.current.find(({ context: current }) => current.tabId === tabContext.tabId);
    if (existing?.context.attachmentToken === tabContext.attachmentToken) {
      if (makeActive) selectTab(tabContext.tabId, false);
      return true;
    }
    if (!api || openingTabIdsRef.current.has(tabContext.tabId)) {
      if (makeActive) pendingActiveTabIdRef.current = tabContext.tabId;
      return false;
    }

    openingTabIdsRef.current.add(tabContext.tabId);
    try {
      const tab = await openSshTabWithRecovery(api, tabContext);
      if (!mountedRef.current) {
        tab.transport.close();
        return false;
      }
      const currentExisting = tabsRef.current.find(({ context: current }) =>
        current.tabId === tabContext.tabId);
      if (existing && !currentExisting) {
        tab.transport.close();
        return false;
      }
      if (currentExisting) {
        replaceTabs((current) => current.map((candidate) =>
          candidate.context.tabId === tabContext.tabId ? tab : candidate));
        currentExisting.transport?.close();
      } else {
        replaceTabs((current) => current.some(({ context: candidate }) =>
          candidate.tabId === tabContext.tabId) ? current : [...current, tab]);
      }
      setActionError(undefined);
      if (makeActive || pendingActiveTabIdRef.current === tabContext.tabId) {
        pendingActiveTabIdRef.current = undefined;
        setActiveTabId(tabContext.tabId);
        queueMicrotask(() => tab.terminalRef.current?.focus());
      }
      return true;
    } catch (caught: unknown) {
      if (mountedRef.current) {
        const message = errorMessage(caught);
        const currentExisting = tabsRef.current.some(({ context: current }) =>
          current.tabId === tabContext.tabId);
        if (existing && currentExisting) {
          updateTab(tabContext.tabId, { context: tabContext, attachmentError: message });
        } else if (!existing) {
          replaceTabs((current) => current.some(({ context: candidate }) =>
            candidate.tabId === tabContext.tabId)
            ? current
            : [...current, failedSshTab(tabContext, message)]);
        }
        if (makeActive && (!existing || currentExisting)) setActiveTabId(tabContext.tabId);
      }
      return false;
    } finally {
      openingTabIdsRef.current.delete(tabContext.tabId);
    }
  }, [api, replaceTabs, selectTab, setActiveTabId, updateTab]);

  const acceptOpenResult = useCallback(async (result: SshOpenTabResult): Promise<void> => {
    if (result.status === "host-key-review") {
      setHostKeyReviewError(undefined);
      setHostKeyReview(result.review);
      setIsTargetPickerOpen(false);
      return;
    }
    if (result.context) {
      if (result.context.tabId !== result.tabId) {
        setActionError("The SSH tab identity changed while it was opening");
        return;
      }
      await adoptTabContext(result.context);
      return;
    }
    if (tabsRef.current.some(({ context: tabContext }) => tabContext.tabId === result.tabId)) {
      setActionError(undefined);
      selectTab(result.tabId, false);
      return;
    }
    if (!api) {
      setActionError("The secure SSH bridge is unavailable");
      return;
    }
    try {
      const reattached = await api.reattachSshTab({ tabId: result.tabId });
      if (!reattached.ok || !reattached.value) {
        throw new Error(reattached.error ?? "The SSH session could not be reattached");
      }
      if (reattached.value.tabId !== result.tabId) {
        throw new Error("The SSH tab identity changed while it was reattaching");
      }
      await adoptTabContext(reattached.value);
    } catch (caught: unknown) {
      if (mountedRef.current) {
        setActionError(`Could not recover the SSH tab: ${errorMessage(caught)}`);
      }
    }
  }, [adoptTabContext, api, selectTab]);

  const showTargetPicker = useCallback(async (): Promise<void> => {
    if (!api) {
      setActionError("The secure SSH bridge is unavailable");
      return;
    }
    if (!tabHostReadyRef.current) {
      pendingPickerRequestRef.current = true;
      return;
    }
    if (tabsRef.current.length >= SSH_MAX_TABS_PER_WINDOW) {
      setActionError(`An SSH window supports at most ${SSH_MAX_TABS_PER_WINDOW} sessions`);
      return;
    }

    setIsTargetPickerOpen(true);
    setIsLoadingTargets(true);
    setTargetPickerError(undefined);
    setActionError(undefined);
    try {
      const result = await api.listSshTargets();
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Managed SSH servers are unavailable");
      }
      if (!mountedRef.current) return;
      setTargets([...result.value].sort(compareSshTargets));
    } catch (caught: unknown) {
      if (mountedRef.current) setTargetPickerError(errorMessage(caught));
    } finally {
      if (mountedRef.current) setIsLoadingTargets(false);
    }
  }, [api]);

  const requestTarget = useCallback(async (deploymentId: string): Promise<void> => {
    if (!api || openingTargetRef.current) return;
    openingTargetRef.current = true;
    setOpeningDeploymentId(deploymentId);
    setTargetPickerError(undefined);
    setActionError(undefined);
    try {
      const result = await api.createSshTab({ deploymentId });
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "The SSH session could not be opened");
      }
      if (!mountedRef.current) return;
      await acceptOpenResult(result.value);
      if (result.value.status === "opened") setIsTargetPickerOpen(false);
    } catch (caught: unknown) {
      if (mountedRef.current) setTargetPickerError(errorMessage(caught));
    } finally {
      openingTargetRef.current = false;
      if (mountedRef.current) setOpeningDeploymentId(undefined);
    }
  }, [acceptOpenResult, api]);

  const approveHostKey = useCallback(async (): Promise<void> => {
    if (!api || !hostKeyReview || approvingHostKeyRef.current) return;
    approvingHostKeyRef.current = true;
    setIsApprovingHostKey(true);
    setHostKeyReviewError(undefined);
    try {
      const result = await api.approveSshHostKey({ token: hostKeyReview.token });
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "The SSH host key could not be trusted");
      }
      if (!mountedRef.current) return;
      await acceptOpenResult(result.value);
      if (result.value.status === "opened") setHostKeyReview(undefined);
    } catch (caught: unknown) {
      if (mountedRef.current) setHostKeyReviewError(errorMessage(caught));
    } finally {
      approvingHostKeyRef.current = false;
      if (mountedRef.current) setIsApprovingHostKey(false);
    }
  }, [acceptOpenResult, api, hostKeyReview]);

  const recheckHostKey = useCallback(async (): Promise<void> => {
    if (!api || !hostKeyReview || approvingHostKeyRef.current) return;
    approvingHostKeyRef.current = true;
    setIsApprovingHostKey(true);
    setHostKeyReviewError(undefined);
    try {
      const result = await api.createSshTab({ deploymentId: hostKeyReview.deploymentId });
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "The SSH host could not be checked again");
      }
      if (!mountedRef.current) return;
      await acceptOpenResult(result.value);
      if (result.value.status === "opened") setHostKeyReview(undefined);
    } catch (caught: unknown) {
      if (mountedRef.current) setHostKeyReviewError(errorMessage(caught));
    } finally {
      approvingHostKeyRef.current = false;
      if (mountedRef.current) setIsApprovingHostKey(false);
    }
  }, [acceptOpenResult, api, hostKeyReview]);

  const retryTabAttachment = useCallback(async (tabId: string): Promise<void> => {
    if (!api || retryingTabRef.current || openingTabIdsRef.current.has(tabId)) return;
    const tab = tabsRef.current.find(({ context: candidate }) => candidate.tabId === tabId);
    if (!tab?.attachmentError) return;

    retryingTabRef.current = tabId;
    setRetryingTabId(tabId);
    setActionError(undefined);
    try {
      const result = await api.reattachSshTab({ tabId });
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "The SSH session could not be reattached");
      }
      if (result.value.tabId !== tabId) {
        throw new Error("The SSH tab identity changed while it was reattaching");
      }
      await adoptTabContext(result.value);
    } catch (caught: unknown) {
      if (mountedRef.current) updateTab(tabId, { attachmentError: errorMessage(caught) });
    } finally {
      retryingTabRef.current = undefined;
      if (mountedRef.current) setRetryingTabId(undefined);
    }
  }, [adoptTabContext, api, updateTab]);

  const closeActiveTab = useCallback(async (): Promise<void> => {
    if (!api || closingTabRef.current) return;
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
      const result = await api.closeSshTab({ tabId: tab.context.tabId });
      if (!result.ok) throw new Error(result.error ?? "The SSH tab could not be closed");
      tab.transport?.close();
      const remaining = tabsRef.current.filter(({ context: tabContext }) =>
        tabContext.tabId !== tab.context.tabId);
      tabsRef.current = remaining;
      setTabs(remaining);
      const next = remaining[Math.min(index, remaining.length - 1)];
      setActiveTabId(next?.context.tabId);
      if (next) {
        void api.selectSshTab({ tabId: next.context.tabId }).catch(() => undefined);
        queueMicrotask(() => next.terminalRef.current?.focus());
      }
    } catch (caught: unknown) {
      updateTab(tab.context.tabId, { actionError: errorMessage(caught) });
    } finally {
      closingTabRef.current = false;
      if (mountedRef.current) setClosingTabId(undefined);
    }
  }, [api, setActiveTabId, updateTab]);

  const openSettings = useCallback((): void => {
    setSettingsDraft(settingsRef.current);
    setIsSettingsOpen(true);
  }, []);

  const openRenameTab = useCallback((tabId: string): void => {
    const tab = tabsRef.current.find(({ context: tabContext }) => tabContext.tabId === tabId);
    if (!tab) return;
    setRenameTabId(tabId);
    setRenameName(tab.context.label);
    setRenameError(undefined);
  }, []);

  const renameTab = useCallback(async (label: string): Promise<void> => {
    if (!api || !renameTabId || renamingTabRef.current) return;
    const tabId = renameTabId;
    if (!tabsRef.current.some(({ context }) => context.tabId === tabId)) return;
    renamingTabRef.current = true;
    setIsRenamingTab(true);
    setRenameError(undefined);
    try {
      const result = await api.renameSshTab({ tabId, label });
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "The SSH tab could not be renamed");
      }
      if (result.value.tabId !== tabId) {
        throw new Error("The SSH tab identity changed while it was being renamed");
      }
      if (!mountedRef.current) return;
      replaceTabs((current) => current.map((tab) => tab.context.tabId === tabId
        ? { ...tab, context: { ...tab.context, label: result.value!.label } }
        : tab));
      setRenameTabId(undefined);
      setRenameName("");
      focusActiveTerminal();
    } catch (caught: unknown) {
      if (mountedRef.current) setRenameError(errorMessage(caught));
    } finally {
      renamingTabRef.current = false;
      if (mountedRef.current) setIsRenamingTab(false);
    }
  }, [api, focusActiveTerminal, renameTabId, replaceTabs]);

  const selectTabByShortcut = useCallback((index: number): void => {
    const tab = tabsRef.current[index];
    if (tab) selectTab(tab.context.tabId);
  }, [selectTab]);

  useEffect(() => {
    if (!api) return;
    const unsubscribers = [
      api.onSshNewTabRequested(() => {
        if (tabHostReadyRef.current) void showTargetPicker();
        else pendingPickerRequestRef.current = true;
      }),
      api.onSshCloseTabRequested(() => void closeActiveTab()),
      api.onSshSelectTabRequested(selectTabByShortcut),
      api.onSshSettingsRequested(openSettings),
      api.onSshTabOpened((tabContext) => {
        if (tabHostReadyRef.current) void adoptTabContext(tabContext);
        else pendingOpenedContextsRef.current.push(tabContext);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [adoptTabContext, api, closeActiveTab, openSettings, selectTabByShortcut, showTargetPicker]);

  useEffect(() => {
    mountedRef.current = true;
    tabHostReadyRef.current = false;
    if (!api) {
      setFatalError("The secure SSH bridge is unavailable. Restart the application and try again.");
      return () => {
        mountedRef.current = false;
      };
    }

    let mounted = true;
    let initialTabPromises: readonly Promise<AttachedSshTab>[] = [];
    let adoptedInitialTabs = false;
    const detachedTransports = new Set<ConsoleTerminalTransport>();
    const detachTab = (tab: SshTab): void => {
      if (!tab.transport) return;
      if (detachedTransports.has(tab.transport)) return;
      detachedTransports.add(tab.transport);
      tab.transport.close();
    };
    const detachStartedTabs = async (): Promise<void> => {
      const settled = await Promise.allSettled(initialTabPromises);
      for (const result of settled) {
        if (result.status === "fulfilled") detachTab(result.value);
      }
    };
    void claimSshLaunchContext(api)
      .then(async (result) => {
        if (!mounted) return;
        if (!result.ok || !result.value || result.value.kind !== "ssh") {
          throw new Error(result.error ?? "This window is not authorized to host managed SSH sessions");
        }
        const launchContext = result.value;
        setPhase("starting");
        initialTabPromises = launchContext.tabs.map((tabContext) => openSshTabWithRecovery(api, tabContext));
        const [terminalRuntime, settledInitialTabs] = await Promise.all([
          loadSshTerminalRuntime(api),
          Promise.allSettled(initialTabPromises),
        ]);
        const initialTabs = settledInitialTabs.map((result, index) => result.status === "fulfilled"
          ? result.value
          : failedSshTab(launchContext.tabs[index]!, errorMessage(result.reason)));
        if (!mounted) {
          for (const tab of initialTabs) detachTab(tab);
          return;
        }
        tabsRef.current = initialTabs;
        adoptedInitialTabs = true;
        setContext(launchContext);
        setRuntime(terminalRuntime);
        setTabs(initialTabs);
        const selected = initialTabs.some(({ context: tabContext }) =>
          tabContext.tabId === launchContext.activeTabId)
          ? launchContext.activeTabId
          : initialTabs[0]?.context.tabId;
        setActiveTabId(selected);
        tabHostReadyRef.current = true;
        setPhase("ready");
        setFatalError(undefined);

        const pendingContexts = pendingOpenedContextsRef.current.splice(0);
        for (const tabContext of pendingContexts) void adoptTabContext(tabContext);
        if (pendingPickerRequestRef.current) {
          pendingPickerRequestRef.current = false;
          void showTargetPicker();
        }
      })
      .catch(async (caught: unknown) => {
        if (!adoptedInitialTabs) await detachStartedTabs();
        if (mounted) {
          tabHostReadyRef.current = false;
          setFatalError(errorMessage(caught));
        }
      });

    return () => {
      mounted = false;
      mountedRef.current = false;
      tabHostReadyRef.current = false;
      if (adoptedInitialTabs) {
        for (const tab of tabsRef.current) detachTab(tab);
      } else {
        void detachStartedTabs();
      }
    };
  }, [adoptTabContext, api, setActiveTabId, showTargetPicker]);

  useEffect(() => {
    if (!context) return;
    const handleTabShortcut = (event: KeyboardEvent): void => {
      const shortcut = sshKeyboardShortcutForEvent(context.shortcutModifier, event);
      if (!shortcut) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (event.repeat) return;
      if (shortcut.type === "new-tab") void showTargetPicker();
      else selectTabByShortcut(shortcut.index);
    };
    window.addEventListener("keydown", handleTabShortcut, true);
    return () => window.removeEventListener("keydown", handleTabShortcut, true);
  }, [context, selectTabByShortcut, showTargetPicker]);

  useEffect(() => {
    settingsRef.current = settings;
    if (!isSettingsOpen) setSettingsDraft(settings);
  }, [isSettingsOpen, settings]);

  useEffect(() => {
    if (!renameTabId || tabs.some(({ context: tabContext }) => tabContext.tabId === renameTabId)) return;
    setRenameTabId(undefined);
    setRenameName("");
    setRenameError(undefined);
  }, [renameTabId, tabs]);

  const activeTab = tabs.find(({ context: tabContext }) => tabContext.tabId === activeTabId);
  useEffect(() => {
    document.title = activeTab
      ? `SSH — ${activeTab.context.label} — ${sshEndpoint(activeTab.context.target)}`
      : "Managed SSH";
  }, [activeTab]);

  const appearance = useMemo(() => applicationTerminalAppearance(
    settings,
    applicationSettings?.resolvedTheme ?? "dark",
    applicationSettings?.settings.reduceMotion ?? false,
  ), [applicationSettings?.resolvedTheme, applicationSettings?.settings.reduceMotion, settings]);

  if (fatalError) {
    return (
      <SshWindowState
        title="Managed SSH unavailable"
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
          <span>{phase === "claiming" ? "Claiming SSH window…" : "Starting managed SSH sessions…"}</span>
        </div>
      </main>
    );
  }

  const atTabLimit = tabs.length >= SSH_MAX_TABS_PER_WINDOW;

  return (
    <main
      className="flex h-screen min-h-0 flex-col overflow-hidden bg-background"
      aria-label="Managed SSH client window"
    >
      <Tabs
        className="contents"
        selectedKey={activeTabId ?? EMPTY_SSH_TAB_KEY}
        variant="secondary"
        onSelectionChange={(key) => selectTab(String(key))}
      >
        <header className="flex h-16 min-h-16 flex-none items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <Tooltip delay={250}>
            <span
              aria-label="Managed SSH sessions"
              className="grid size-9 flex-none place-items-center rounded-xl bg-accent-soft text-accent-soft-foreground"
            >
              <FontAwesomeIcon aria-hidden icon={faTerminal} />
            </span>
            <Tooltip.Content placement="bottom">Managed SSH sessions</Tooltip.Content>
          </Tooltip>

          <Tabs.ListContainer className="min-w-0 flex-1 rounded-none border-b border-border bg-transparent">
            <Tabs.List aria-label="Managed SSH tabs" className="min-w-0 bg-transparent p-0 shadow-none">
              {tabs.map((tab, index) => {
                const state = sshTabState(tab);
                const shortcutDigit = sshTabShortcutDigit(index);
                return (
                  <RenamableTab
                    ariaLabel={`${tab.context.label}, ${sshEndpoint(tab.context.target)}, ${tabStateLabel(state)}, shortcut ${context.shortcutModifier}+${shortcutDigit}`}
                    className="max-w-64 min-w-32 gap-2 rounded-none px-3 data-[selected=true]:text-foreground"
                    id={tab.context.tabId}
                    key={tab.context.tabId}
                    onRename={openRenameTab}
                  >
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${tabStateColor(state)}`} />
                    <span className="truncate">{tab.context.label}</span>
                    <kbd
                      aria-hidden
                      className="flex-none rounded-md bg-surface-secondary px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted tabular-nums"
                    >
                      {context.shortcutModifier === "Command" ? "⌘" : "Ctrl+"}{shortcutDigit}
                    </kbd>
                    <span className="sr-only"> {tabStateLabel(state)}</span>
                    <Tabs.Indicator className="top-auto bottom-0 h-0.5 rounded-none bg-accent shadow-none" />
                  </RenamableTab>
                );
              })}
            </Tabs.List>
          </Tabs.ListContainer>

          <div className="flex flex-none items-center gap-1">
            <Tooltip delay={250}>
              <Button
                aria-label="New SSH tab"
                isDisabled={atTabLimit}
                isIconOnly
                isPending={isLoadingTargets}
                size="sm"
                variant="ghost"
                onPress={() => void showTargetPicker()}
              >
                <FontAwesomeIcon aria-hidden icon={faPlus} />
              </Button>
              <Tooltip.Content placement="bottom">
                {atTabLimit ? `Maximum ${SSH_MAX_TABS_PER_WINDOW} SSH sessions` : "New SSH tab"}
              </Tooltip.Content>
            </Tooltip>
            <Tooltip delay={250}>
              <Button
                aria-label="Close active SSH tab"
                isDisabled={!activeTab || retryingTabId === activeTabId}
                isIconOnly
                isPending={closingTabId === activeTabId}
                size="sm"
                variant="ghost"
                onPress={() => void closeActiveTab()}
              >
                <FontAwesomeIcon aria-hidden icon={faXmark} />
              </Button>
              <Tooltip.Content placement="bottom">Close active SSH tab</Tooltip.Content>
            </Tooltip>
          </div>
        </header>

        <section
          aria-label="SSH terminal"
          className="relative min-h-0 flex-1"
          style={{ backgroundColor: appearance.theme?.background }}
        >
          {tabs.map((tab) => {
            const isActive = tab.context.tabId === activeTabId;
            const message = tab.terminalError ?? tab.exitMessage ?? tab.actionError;
            return (
              <Tabs.Panel className="contents" id={tab.context.tabId} key={tab.context.tabId} shouldForceMount>
                <div
                  aria-hidden={!isActive}
                  className={isActive
                    ? "relative h-full min-h-0 w-full"
                    : "pointer-events-none invisible absolute inset-0 h-full min-h-0 w-full"}
                  data-ssh-terminal-tab-id={tab.context.tabId}
                  inert={isActive ? undefined : true}
                >
                  {tab.transport ? (
                    <GhosttyTerminal
                      enableClipboard
                      ref={tab.terminalRef}
                      appearance={appearance}
                      ariaLabel={`SSH session ${tab.context.label} for ${sshEndpoint(tab.context.target)}`}
                      className="h-full min-h-0"
                      transport={tab.transport}
                      wasmBytes={runtime.bytes}
                      onClose={(reason) => {
                        const current = tabsRef.current.find(({ context: candidate }) =>
                          candidate.tabId === tab.context.tabId);
                        if (current?.transport !== tab.transport) return;
                        updateTab(tab.context.tabId, {
                          exitMessage: reason ?? "SSH session exited",
                        });
                      }}
                      onError={(terminalError) => {
                        const current = tabsRef.current.find(({ context: candidate }) =>
                          candidate.tabId === tab.context.tabId);
                        if (current?.transport !== tab.transport) return;
                        tab.transport?.close();
                        updateTab(tab.context.tabId, { terminalError: terminalError.message });
                      }}
                    />
                  ) : null}
                  {tab.attachmentError ? (
                    <SshTabNotice
                      action={(
                        <Button
                          isDisabled={closingTabId === tab.context.tabId}
                          isPending={retryingTabId === tab.context.tabId}
                          size="sm"
                          variant="secondary"
                          onPress={() => void retryTabAttachment(tab.context.tabId)}
                        >
                          Retry
                        </Button>
                      )}
                      message={tab.attachmentError}
                      title="SSH session could not be restored"
                    />
                  ) : message ? (
                    <SshTabNotice
                      message={message}
                      title={tab.terminalError
                        ? "Terminal unavailable"
                        : tab.exitMessage
                          ? "SSH session exited"
                          : "SSH tab could not be closed"}
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
                <p className="text-sm font-semibold text-foreground">No SSH sessions</p>
                <p className="text-xs leading-relaxed text-muted">
                  Select a managed server to start a secure shell using its stored SSH key.
                </p>
                <Button size="sm" onPress={() => void showTargetPicker()}>Choose server</Button>
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
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">SSH tab action failed</p>
                <p className="mt-1 break-words text-xs leading-relaxed">{actionError}</p>
              </div>
              <Button
                aria-label="Dismiss SSH error"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => setActionError(undefined)}
              >
                <FontAwesomeIcon aria-hidden icon={faXmark} />
              </Button>
            </div>
          ) : null}
        </section>
      </Tabs>

      <SshTargetPicker
        activeDeploymentIds={new Set(tabs.map(({ context: tabContext }) =>
          tabContext.target.deploymentId))}
        error={targetPickerError}
        isLoading={isLoadingTargets}
        isOpen={isTargetPickerOpen}
        openingDeploymentId={openingDeploymentId}
        targets={targets}
        onChoose={(deploymentId) => void requestTarget(deploymentId)}
        onOpenChange={(open) => {
          setIsTargetPickerOpen(open);
          if (!open) setTargetPickerError(undefined);
        }}
      />

      <SshHostKeyReviewDialog
        error={hostKeyReviewError}
        isApproving={isApprovingHostKey}
        review={hostKeyReview}
        onApprove={() => void approveHostKey()}
        onCancel={() => {
          if (isApprovingHostKey) return;
          setHostKeyReview(undefined);
          setHostKeyReviewError(undefined);
          focusActiveTerminal();
        }}
        onRecheck={() => void recheckHostKey()}
      />

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
        description="The managed server name and connection details stay unchanged."
        error={renameError}
        isOpen={renameTabId !== undefined}
        isPending={isRenamingTab}
        name={renameName}
        originalName={tabs.find(({ context: tabContext }) => tabContext.tabId === renameTabId)?.context.label ?? ""}
        onNameChange={(name) => {
          setRenameName(name);
          if (renameError) setRenameError(undefined);
        }}
        onOpenChange={(isOpen) => {
          if (isOpen || isRenamingTab) return;
          setRenameTabId(undefined);
          setRenameName("");
          setRenameError(undefined);
          focusActiveTerminal();
        }}
        onRename={(name) => void renameTab(name)}
      />
    </main>
  );
}

function SshTargetPicker({
  activeDeploymentIds,
  error,
  isLoading,
  isOpen,
  openingDeploymentId,
  targets,
  onChoose,
  onOpenChange,
}: {
  readonly activeDeploymentIds: ReadonlySet<string>;
  readonly error: string | undefined;
  readonly isLoading: boolean;
  readonly isOpen: boolean;
  readonly openingDeploymentId: string | undefined;
  readonly targets: readonly ManagedSshTarget[];
  readonly onChoose: (deploymentId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  return (
    <Modal.Backdrop isOpen={isOpen} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" size="md">
        <Modal.Dialog className="sm:max-w-[560px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-10">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faTerminal} />
            </Modal.Icon>
            <div className="min-w-0">
              <Modal.Heading>New SSH Session</Modal.Heading>
              <p className="mt-1 text-sm leading-5 text-muted">
                Choose a managed server that has a stored SSH key.
              </p>
            </div>
          </Modal.Header>
          <Modal.Body>
            {isLoading ? (
              <div className="grid min-h-40 place-items-center" role="status">
                <div className="flex items-center gap-3 text-sm text-muted">
                  <Spinner size="sm" />
                  <span>Loading managed servers…</span>
                </div>
              </div>
            ) : error ? (
              <div className="rounded-xl border border-danger/50 bg-danger-soft px-4 py-3" role="alert">
                <p className="text-sm font-semibold text-danger-soft-foreground">Managed servers unavailable</p>
                <p className="mt-1 break-words text-xs leading-5 text-danger-soft-foreground">{error}</p>
              </div>
            ) : targets.length === 0 ? (
              <div className="grid min-h-40 place-items-center text-center">
                <div className="max-w-sm">
                  <p className="text-sm font-semibold">No SSH-capable managed servers</p>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    Add a managed server with a stored SSH key, then try again.
                  </p>
                </div>
              </div>
            ) : (
              <div aria-label="Managed SSH servers" className="flex max-h-96 flex-col gap-2 overflow-y-auto" role="list">
                {targets.map((target) => {
                  const hasOpenSession = activeDeploymentIds.has(target.deploymentId);
                  const detail = !target.connectable
                    ? target.unavailableReason ?? "Unavailable"
                    : hasOpenSession
                      ? "Open another SSH session"
                      : titleCase(target.status);
                  return (
                    <div key={target.deploymentId} role="listitem">
                      <Button
                        aria-label={`${hasOpenSession ? "Open another SSH session to" : "Connect to"} ${target.name}, ${sshEndpoint(target)}`}
                        className="h-auto min-h-16 justify-start px-3 py-2 text-start"
                        fullWidth
                        isDisabled={!target.connectable}
                        isPending={openingDeploymentId === target.deploymentId}
                        variant="secondary"
                        onPress={() => onChoose(target.deploymentId)}
                      >
                        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-tertiary text-muted">
                          <FontAwesomeIcon aria-hidden icon={target.provider === "aws" ? faAmazon : faServer} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">{target.name}</span>
                          <span className="block truncate font-mono text-xs text-muted">{sshEndpoint(target)}</span>
                        </span>
                        <Chip
                          color={hasOpenSession ? "accent" : sshTargetColor(target)}
                          size="sm"
                          variant="soft"
                        >
                          {detail}
                        </Chip>
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onPress={() => onOpenChange(false)}>Cancel</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function SshHostKeyReviewDialog({
  error,
  isApproving,
  review,
  onApprove,
  onCancel,
  onRecheck,
}: {
  readonly error: string | undefined;
  readonly isApproving: boolean;
  readonly review: SshHostKeyReview | undefined;
  readonly onApprove: () => void;
  readonly onCancel: () => void;
  readonly onRecheck: () => void;
}): React.JSX.Element {
  return (
    <AlertDialog.Backdrop
      isOpen={review !== undefined}
      variant="blur"
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialog.Container placement="center" size="sm">
        <AlertDialog.Dialog className="sm:max-w-[500px]">
          <AlertDialog.Header>
            <AlertDialog.Icon status="warning">
              <FontAwesomeIcon aria-hidden className="size-5" icon={faKey} />
            </AlertDialog.Icon>
            <AlertDialog.Heading>Trust SSH host key?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="space-y-4 text-sm leading-6 text-muted">
              <p>
                Verify this fingerprint before connecting to <strong className="text-foreground">{review?.name}</strong>.
                The app will pin it to this managed server and reject later changes.
              </p>
              <dl className="space-y-3 rounded-xl bg-surface-secondary p-4">
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted">Server</dt>
                  <dd className="mt-1 font-mono text-xs text-foreground">{review ? `${review.host}:${review.port}` : ""}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted">SHA-256 fingerprint</dt>
                  <dd className="mt-1">
                    <input
                      aria-label="SSH host-key fingerprint; select to copy"
                      className="w-full select-all rounded-lg border border-border bg-surface px-2 py-1.5 font-mono text-xs text-foreground"
                      readOnly
                      value={review?.fingerprint ?? ""}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted">Approval expires</dt>
                  <dd className="mt-1 text-xs text-foreground">{formatReviewExpiry(review?.expiresAt)}</dd>
                </div>
              </dl>
              {error ? (
                <div className="rounded-xl border border-danger/50 bg-danger-soft px-3 py-2 text-danger-soft-foreground" role="alert">
                  {error}
                </div>
              ) : null}
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={isApproving} variant="secondary" onPress={onCancel}>Cancel</Button>
            <Button
              isPending={isApproving}
              variant="primary"
              onPress={error ? onRecheck : onApprove}
            >
              {error ? "Re-check Host" : "Trust & Connect"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}

function SshTabNotice({
  action,
  title,
  message,
}: {
  readonly action?: React.JSX.Element;
  readonly title: string;
  readonly message: string;
}): React.JSX.Element {
  return (
    <div
      aria-atomic="true"
      className="absolute inset-x-5 bottom-5 isolate flex items-start gap-3 rounded-xl border border-warning/50 bg-overlay px-4 py-3 text-overlay-foreground shadow-overlay"
      role="alert"
    >
      <span className="grid size-8 flex-none place-items-center rounded-lg bg-warning text-warning-foreground shadow-sm">
        <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-1 break-words text-xs leading-relaxed text-overlay-foreground">{message}</p>
      </div>
      {action}
    </div>
  );
}

function SshWindowState({
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
      <section aria-label={title} className="w-full max-w-xl rounded-2xl bg-surface px-6 py-12">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={icon} /></EmptyState.Media>
            <EmptyState.Title>{title}</EmptyState.Title>
            <EmptyState.Description className="max-w-md text-pretty">{description}</EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      </section>
    </main>
  );
}

type SshTabState = "connected" | "exited" | "failed";

function sshTabState(tab: SshTab): SshTabState {
  if (tab.attachmentError || tab.terminalError || tab.actionError) return "failed";
  if (tab.exitMessage) return "exited";
  return "connected";
}

function tabStateLabel(state: SshTabState): string {
  if (state === "connected") return "Connected";
  if (state === "failed") return "Failed";
  return "Exited";
}

function tabStateColor(state: SshTabState): string {
  if (state === "connected") return "bg-success";
  if (state === "failed") return "bg-danger";
  return "bg-warning";
}

function sshTabShortcutDigit(index: number): number {
  return index === 9 ? 0 : index + 1;
}

type SshKeyboardShortcut =
  | { readonly type: "new-tab" }
  | { readonly type: "select-tab"; readonly index: number };

function sshKeyboardShortcutForEvent(
  modifier: SshWindowLaunchContext["shortcutModifier"],
  event: KeyboardEvent,
): SshKeyboardShortcut | undefined {
  if (event.isComposing || event.shiftKey || event.altKey) return undefined;
  const primaryModifierOnly = modifier === "Command"
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primaryModifierOnly) return undefined;
  if (event.code === "KeyT") return { type: "new-tab" };
  const codeMatch = /^Digit([0-9])$/u.exec(event.code);
  if (!codeMatch?.[1]) return undefined;
  const digit = Number(codeMatch[1]);
  return {
    type: "select-tab",
    index: digit === 0 ? SSH_MAX_TABS_PER_WINDOW - 1 : digit - 1,
  };
}

function sshWindowApi(): SshWindowAPI | undefined {
  return (window as unknown as { ssh?: SshWindowAPI }).ssh;
}

function claimSshLaunchContext(api: SshWindowAPI) {
  pendingSshLaunchContext ??= api.claimSshWindow();
  return pendingSshLaunchContext;
}

async function openSshTab(api: SshWindowAPI, context: SshTabLaunchContext): Promise<AttachedSshTab> {
  return {
    context,
    transport: await ConsoleTerminalTransport.open({
      api,
      attachmentToken: context.attachmentToken,
      streamKind: "ssh",
    }),
    terminalRef: createRef<GhosttyTerminalHandle>(),
    attachmentError: undefined,
    exitMessage: undefined,
    terminalError: undefined,
    actionError: undefined,
  };
}

async function openSshTabWithRecovery(
  api: SshWindowAPI,
  context: SshTabLaunchContext,
): Promise<AttachedSshTab> {
  try {
    return await openSshTab(api, context);
  } catch (initialError) {
    const replacement = await api.reattachSshTab({ tabId: context.tabId });
    if (!replacement.ok || !replacement.value) {
      throw new Error(
        replacement.error ?? `SSH stream attachment failed: ${errorMessage(initialError)}`,
      );
    }
    if (replacement.value.tabId !== context.tabId) {
      throw new Error("The SSH tab identity changed while it was reattaching");
    }
    return await openSshTab(api, replacement.value);
  }
}

function failedSshTab(context: SshTabLaunchContext, attachmentError: string): SshTab {
  return {
    context,
    transport: undefined,
    terminalRef: createRef<GhosttyTerminalHandle>(),
    attachmentError,
    exitMessage: undefined,
    terminalError: undefined,
    actionError: undefined,
  };
}

async function loadSshTerminalRuntime(api: SshWindowAPI): Promise<TerminalRuntimeAsset> {
  if (cachedSshTerminalRuntime) return cachedSshTerminalRuntime;
  if (pendingSshTerminalRuntime) return pendingSshTerminalRuntime;
  const request = api.getTerminalRuntime()
    .then((result) => {
      if (!result.ok || !result.value) {
        throw new Error(result.error ?? "Terminal runtime is unavailable");
      }
      const source = result.value.bytes;
      const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
      bytes.set(source);
      cachedSshTerminalRuntime = Object.freeze({
        version: result.value.version,
        sha256: result.value.sha256,
        bytes,
      });
      return cachedSshTerminalRuntime;
    })
    .catch((caught: unknown) => {
      cachedSshTerminalRuntime = undefined;
      throw caught;
    })
    .finally(() => {
      if (pendingSshTerminalRuntime === request) pendingSshTerminalRuntime = undefined;
    });
  pendingSshTerminalRuntime = request;
  return request;
}

function sshEndpoint(target: ManagedSshTarget): string {
  if (target.host.length === 0) return "Address unavailable";
  return `${target.username}@${target.host}:${target.port}`;
}

function formatReviewExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return "";
  const expiry = new Date(expiresAt);
  if (!Number.isFinite(expiry.getTime())) return expiresAt;
  return expiry.toLocaleString();
}

function compareSshTargets(left: ManagedSshTarget, right: ManagedSshTarget): number {
  if (left.connectable !== right.connectable) return left.connectable ? -1 : 1;
  return left.name.localeCompare(right.name) || left.host.localeCompare(right.host);
}

function sshTargetColor(target: ManagedSshTarget): "default" | "success" | "warning" | "danger" {
  if (target.connectable) return "success";
  if (target.status === "failed") return "danger";
  if (target.status === "provisioning" || target.status === "deleting") return "warning";
  return "default";
}

function titleCase(value: string): string {
  return value.replace(/(^|-)([a-z])/gu, (_match, separator: string, letter: string) =>
    `${separator === "-" ? " " : ""}${letter.toUpperCase()}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetSshWindowStateForTest(): void {
  pendingSshLaunchContext = undefined;
  cachedSshTerminalRuntime = undefined;
  pendingSshTerminalRuntime = undefined;
}
