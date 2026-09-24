import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Dropdown, Label, Modal, Tooltip, toast } from "@heroui/react";
import { Sidebar, useSidebar } from "@heroui-pro/react/sidebar";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Heading } from "react-aria-components";
import {
  faArrowLeft,
  faArrowRight,
  faBolt,
  faBoxOpen,
  faBoxesStacked,
  faCamera,
  faCloudArrowUp,
  faCode,
  faComputer,
  faEllipsisVertical,
  faGear,
  faLink,
  faLinkSlash,
  faMagnifyingGlass,
  faNetworkWired,
  faKey,
  faPlus,
  faPowerOff,
  faRotate,
  faSatellite,
  faSatelliteDish,
  faTableColumns,
  faTerminal,
  faTriangleExclamation,
  faWindowRestore,
} from "@fortawesome/free-solid-svg-icons";
import { disconnectedSnapshot, SLIVER_PROTOCOL_COMPATIBILITY } from "../../shared/contracts";
import type { EventStreamStatus, SavedConfigSummary, SliverSnapshot } from "../../shared/contracts";
import { isUsableConnection } from "./connection-status";
import { useNavigationHistory } from "./use-navigation-history";
import { navigationShortcuts, shortcutAriaKeyShortcuts, useNavigationShortcuts } from "./navigation-shortcuts";
import { useConsoleShortcut } from "./window-shortcuts";
import { resolveKeyboardShortcut } from "../../shared/keyboard-shortcuts";
import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_COMMAND_PALETTE_SHORTCUT,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
  type ApplicationSettingsValues,
  type ResolvedApplicationIcon,
} from "../../shared/application-settings-contracts";
import { CONSOLE_WINDOW_OPEN_REQUEST_ERROR } from "../../shared/console-contracts";
import type { BeaconSummary, SessionSummary, TargetRef } from "../../shared/target-contracts";
import sliverDarkIcon from "../../../build/icon1a-dark.png";
import sliverLightIcon from "../../../build/icon1a-light.png";
import sliverPassionIcon from "../../../build/passion.png";
import {
  AppCommandPalette,
  type AppCommandPaletteCommand,
} from "./components/AppCommandPalette";
import { CommandPaletteShortcutKbd, isApplePlatform } from "./components/CommandPaletteShortcut";
import { SavedConfigSelector } from "./components/SavedConfigSelector";
import { SidebarZoomControls } from "./components/SidebarZoomControls";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { ConnectionProvider } from "./components/ConnectionProvider";
import { BuildsPage } from "./pages/BuildsPage";
import { GeneratePage } from "./pages/GeneratePage";
import { LootPage } from "./pages/LootPage";
import { CredentialsPage } from "./pages/CredentialsPage";
import { OperationsPage } from "./pages/OperationsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ScriptEditorPage } from "./pages/ScriptEditorPage";
import {
  SessionWorkspacePage,
  type SessionWorkspaceRoute,
} from "./pages/SessionWorkspacePage";
import { TargetsPage } from "./pages/TargetsPage";

type ViewId = "overview" | "operations" | "sessions" | "beacons" | "generate" | "artifacts" | "loot" | "credentials" | "settings" | "script-editor";

const sidebarIcons = {
  dark: sliverDarkIcon,
  light: sliverLightIcon,
  passion: sliverPassionIcon,
} satisfies Record<ResolvedApplicationIcon, string>;

interface BeaconWorkspaceRoute {
  target: TargetRef;
  connectionIncarnation: number;
}

const overviewNavItem = { id: "overview" as const, label: "Overview", description: "Explore infrastructure and reported connections.", icon: faNetworkWired };

const infrastructureNavItems = [
  { id: "generate" as const, label: "Generate", description: "Create implant artifacts.", icon: faBolt },
  {
    id: "artifacts" as const,
    label: "Builds & profiles",
    description: "Browse generated builds and reusable profiles.",
    icon: faBoxesStacked,
  },
  {
    id: "operations" as const,
    label: "Jobs & listeners",
    description: "Manage server jobs and listener endpoints.",
    icon: faSatelliteDish,
  },
];

const interactNavItems = [
  { id: "sessions" as const, label: "Sessions", description: "Browse interactive sessions.", icon: faComputer },
  { id: "beacons" as const, label: "Beacons", description: "Browse asynchronous beacons.", icon: faSatellite },
];

const dataNavItems = [
  { id: "loot" as const, label: "Loot", description: "Browse collected files.", icon: faBoxOpen },
  { id: "credentials" as const, label: "Credentials", description: "Browse collected credentials.", icon: faKey },
];

const automationNavItems = [
  { id: "script-editor" as const, label: "Script Editor", description: "Write and run local JavaScript scripts.", icon: faCode },
];

type NavigationItem =
  | typeof overviewNavItem
  | (typeof infrastructureNavItems)[number]
  | (typeof interactNavItems)[number]
  | (typeof dataNavItems)[number]
  | (typeof automationNavItems)[number];

function SidebarNavigationItem({
  count,
  isDisabled,
  item,
  isCurrent,
  onAction,
}: {
  count?: number | undefined;
  isDisabled: boolean;
  item: NavigationItem;
  isCurrent: boolean;
  onAction: () => void;
}) {
  const { collapsible, isMobile, isOpen } = useSidebar();
  const isIconCollapsed = collapsible === "icon" && !isMobile && !isOpen;

  return (
    <Sidebar.MenuItem
      id={item.id}
      aria-label={item.label}
      textValue={item.label}
      isCurrent={isCurrent}
      isDisabled={isDisabled}
      tooltip={false}
      onAction={onAction}
      {...(isIconCollapsed
        ? {
            tooltipProps: {
              content: item.label,
              delay: 250,
              placement: "right" as const,
            },
          }
        : {})}
    >
      <Sidebar.MenuIcon><FontAwesomeIcon icon={item.icon} /></Sidebar.MenuIcon>
      <Sidebar.MenuLabel>{item.label}</Sidebar.MenuLabel>
      {count && count > 0 ? <Sidebar.MenuChip>{count}</Sidebar.MenuChip> : null}
    </Sidebar.MenuItem>
  );
}

export function App() {
  const applicationSettings = useApplicationSettings();
  const [standaloneSettings, setStandaloneSettings] = useState<ApplicationSettingsState>(
    DEFAULT_APPLICATION_SETTINGS_STATE,
  );
  const settings = applicationSettings?.settings ?? standaloneSettings;
  const [snapshot, setSnapshot] = useState<SliverSnapshot>(() => disconnectedSnapshot());
  const connected = isUsableConnection(snapshot.connection.status);
  const lootIdentity = connected ? [
    snapshot.connection.epoch,
    snapshot.connection.incarnation,
    snapshot.connection.server,
    snapshot.connection.configName,
  ].join("\0") : "";
  const latestLootEventId = snapshot.recentEvents.find((event) =>
    event.type === "loot-added" || event.type === "loot-removed")?.id ?? "";
  const [lootCountState, setLootCountState] = useState<{ identity: string; total: number }>();
  const [lootCountRefreshSequence, setLootCountRefreshSequence] = useState(0);
  const lootCountRequestSequence = useRef(0);
  const lootCount = lootCountState?.identity === lootIdentity ? lootCountState.total : undefined;
  const acceptLootInventoryTotal = useCallback((total: number) => {
    if (!lootIdentity) return;
    lootCountRequestSequence.current += 1;
    setLootCountState({ identity: lootIdentity, total });
  }, [lootIdentity]);
  const isViewAvailable = useCallback((entry: ViewId) =>
    entry === "overview" || entry === "settings" || entry === "script-editor" || connected, [connected]);
  const { current: view, navigate: setView, goBack, goForward, canGoBack, canGoForward } =
    useNavigationHistory<ViewId>("overview", isViewAvailable);
  const [scriptEditorVisited, setScriptEditorVisited] = useState(false);
  const [scriptEditorRevealRequest, setScriptEditorRevealRequest] = useState(0);
  const [scriptEditorEditRequest, setScriptEditorEditRequest] = useState<{ id: string; request: number }>();
  useEffect(() => {
    if (view === "script-editor") setScriptEditorVisited(true);
  }, [view]);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [sessionWorkspaceRoute, setSessionWorkspaceRoute] = useState<SessionWorkspaceRoute>();
  const [beaconWorkspaceRoute, setBeaconWorkspaceRoute] = useState<BeaconWorkspaceRoute>();
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConfigSelectorOpen, setIsConfigSelectorOpen] = useState(true);
  const [isLoadingSavedConfigs, setIsLoadingSavedConfigs] = useState(true);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigSummary[]>([]);
  const [savedConfigError, setSavedConfigError] = useState<string>();
  const savedConfigLoadRef = useRef<Promise<void> | null>(null);
  const configSelectorHasMountedRef = useRef(false);
  const snapshotEventGenerationRef = useRef(0);
  const wasConnectedRef = useRef(false);
  const [dismissedCompatibilityKeys, setDismissedCompatibilityKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => window.sliver.onCommandPaletteRequested(() => {
    setIsCommandPaletteOpen((current) => !current);
  }), []);

  const loadSavedConfigs = useCallback(async (afterInFlight = false): Promise<void> => {
    const activeRequest = savedConfigLoadRef.current;
    if (activeRequest) {
      await activeRequest;
      if (!afterInFlight) return;
      const trailingRequest = savedConfigLoadRef.current;
      if (trailingRequest) {
        await trailingRequest;
        return;
      }
    }

    const request = (async () => {
      setIsLoadingSavedConfigs(true);
      try {
        const result = await window.sliver.listSavedConfigs();
        if (!result.ok || !result.value) {
          setSavedConfigs([]);
          setSavedConfigError(result.error ?? "Could not load saved configurations");
          return;
        }
        setSavedConfigs(result.value);
        setSavedConfigError(undefined);
      } catch (error) {
        setSavedConfigs([]);
        setSavedConfigError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsLoadingSavedConfigs(false);
      }
    })();
    savedConfigLoadRef.current = request;
    try {
      await request;
    } finally {
      if (savedConfigLoadRef.current === request) savedConfigLoadRef.current = null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    const unsubscribe = window.sliver.onSnapshotChanged((next) => {
      receivedEvent = true;
      if (mounted) {
        snapshotEventGenerationRef.current += 1;
        setSnapshot(next);
      }
    });
    void window.sliver.getSnapshot().then((next) => {
      if (mounted && !receivedEvent) {
        setSnapshot(next);
        if (isUsableConnection(next.connection.status)) setIsConfigSelectorOpen(false);
      }
    });
    void loadSavedConfigs();
    const reloadSavedConfigs = () => void loadSavedConfigs();
    window.addEventListener("focus", reloadSavedConfigs);
    return () => {
      mounted = false;
      unsubscribe();
      window.removeEventListener("focus", reloadSavedConfigs);
    };
  }, [loadSavedConfigs]);

  useEffect(() => {
    if (!isConfigSelectorOpen) return;
    // The mount effect loads the initial catalog. Reopening must pick up any
    // directory changes that arrived while this selector was dismissed.
    if (configSelectorHasMountedRef.current) void loadSavedConfigs(true);
    else configSelectorHasMountedRef.current = true;

    let active = true;
    let scheduled: number | undefined;
    let refreshing = false;
    let refreshNeeded = false;
    const scheduleRefresh = (): void => {
      refreshNeeded = true;
      if (refreshing || scheduled !== undefined) return;
      scheduled = window.setTimeout(() => void refreshCatalog(), 50);
    };
    const refreshCatalog = async (): Promise<void> => {
      scheduled = undefined;
      if (!active || !refreshNeeded) return;
      refreshNeeded = false;
      refreshing = true;
      try {
        await loadSavedConfigs(true);
      } finally {
        refreshing = false;
        if (active && refreshNeeded) scheduleRefresh();
      }
    };
    const unsubscribe = window.sliver.onSavedConfigsChanged(scheduleRefresh);
    return () => {
      active = false;
      unsubscribe();
      if (scheduled !== undefined) window.clearTimeout(scheduled);
    };
  }, [isConfigSelectorOpen, loadSavedConfigs]);

  useEffect(() => {
    const request = ++lootCountRequestSequence.current;
    if (!lootIdentity) {
      setLootCountState(undefined);
      return;
    }

    let active = true;
    void window.sliver.listLoot({ fileType: "all", limit: 1 }).then((result) => {
      if (!active || request !== lootCountRequestSequence.current) return;
      setLootCountState(result.ok && result.value
        ? { identity: lootIdentity, total: result.value.page.total }
        : undefined);
    }).catch(() => {
      if (active && request === lootCountRequestSequence.current) setLootCountState(undefined);
    });
    return () => { active = false; };
  }, [lootIdentity, latestLootEventId, lootCountRefreshSequence, snapshot.eventStream.status]);

  const connect = useCallback(async (): Promise<void> => {
    const eventGeneration = snapshotEventGenerationRef.current;
    setIsConnecting(true);
    try {
      const result = await window.sliver.chooseConfig();
      if (!result.ok || !result.value) {
        if (result.error && !/cancel/i.test(result.error)) {
          toast.danger("Connection failed", { description: result.error });
        }
        return;
      }
      if (snapshotEventGenerationRef.current === eventGeneration) setSnapshot(result.value);
      setIsConfigSelectorOpen(false);
      toast.success("Connected", { description: result.value.connection.server });
    } catch (error) {
      toast.danger("Connection failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const connectSavedConfig = useCallback(async (config: SavedConfigSummary): Promise<void> => {
    const eventGeneration = snapshotEventGenerationRef.current;
    setIsConnecting(true);
    try {
      const result = await window.sliver.connectSavedConfig(config.id);
      if (!result.ok || !result.value) {
        toast.danger("Connection failed", { description: result.error });
        return;
      }
      if (snapshotEventGenerationRef.current === eventGeneration) setSnapshot(result.value);
      setIsConfigSelectorOpen(false);
      toast.success("Connected", { description: result.value.connection.server });
    } catch (error) {
      toast.danger("Connection failed", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const importConfig = useCallback(async (displayName: string): Promise<void> => {
    const result = await window.sliver.importConfig({ displayName });
    if (!result.ok || !result.value) {
      if (result.error && /cancel/i.test(result.error)) return;
      throw new Error(result.error ?? "Could not import the configuration");
    }
    await loadSavedConfigs(true);
    toast.success("Configuration imported", { description: result.value.displayName });
  }, [loadSavedConfigs]);

  const removeConfig = useCallback(async (config: SavedConfigSummary): Promise<void> => {
    const result = await window.sliver.removeSavedConfig({ id: config.id });
    if (!result.ok) throw new Error(result.error ?? "Could not remove the configuration");
    await loadSavedConfigs(true);
    toast.success("Configuration forgotten", {
      description: config.displayName,
    });
  }, [loadSavedConfigs]);

  const disconnect = useCallback(async () => {
    const eventGeneration = snapshotEventGenerationRef.current;
    const result = await window.sliver.disconnect();
    if (!result.ok || !result.value) {
      toast.danger("Could not disconnect", { description: result.error });
      return;
    }
    if (snapshotEventGenerationRef.current === eventGeneration) setSnapshot(result.value);
  }, []);

  const refreshServer = useCallback(async (): Promise<void> => {
    const eventGeneration = snapshotEventGenerationRef.current;
    const result = await window.sliver.refresh();
    if (!result.ok || !result.value) {
      toast.danger("Could not refresh server", { description: result.error });
      return;
    }
    if (snapshotEventGenerationRef.current === eventGeneration) setSnapshot(result.value);
    setLootCountRefreshSequence((current) => current + 1);
  }, []);

  async function openWindow(inheritConnection: boolean) {
    const result = await window.sliver.openWindow({ inheritConnection });
    if (!result.ok) toast.danger("Could not open window", { description: result.error });
  }

  async function reportScreenshot(): Promise<void> {
    try {
      const result = await window.sliver.reportScreenshot();
      if (!result.ok || !result.value) {
        toast.danger("Could not capture screenshots", {
          description: result.error ?? "The screenshots could not be saved.",
        });
        return;
      }
      const count = result.value.files.length;
      toast.success("Report screenshots saved", {
        description: `Saved ${count} ${count === 1 ? "window" : "windows"} to ${result.value.directory}.`,
      });
    } catch (error) {
      toast.danger("Could not capture screenshots", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function openCloudDeployment() {
    try {
      const result = await window.sliver.openCloudDeploymentWindow();
      if (!result.ok) {
        toast.danger("Could not open Cloud Deployment", { description: result.error });
      }
    } catch (error) {
      toast.danger("Could not open Cloud Deployment", {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const openConsole = useCallback(async () => {
    try {
      const result = await window.sliver.openConsoleWindow();
      if (!result.ok) {
        toast.danger("Could not open Sliver console", { description: result.error });
      }
    } catch {
      toast.danger("Could not open Sliver console", {
        description: CONSOLE_WINDOW_OPEN_REQUEST_ERROR,
      });
    }
  }, []);

  useConsoleShortcut({ isEnabled: connected, onOpenConsole: openConsole, settings });

  const connectionInProgress = snapshot.connection.status === "connecting";

  useEffect(() => {
    if (connected) {
      setIsConfigSelectorOpen(false);
      wasConnectedRef.current = true;
      return;
    }
    if (connectionInProgress) return;
    if (wasConnectedRef.current) setIsConfigSelectorOpen(true);
    wasConnectedRef.current = false;
  }, [connected, connectionInProgress]);

  const compatibilityKey = compatibilityNoticeKey(snapshot);
  const isCompatibilityNoticeOpen = Boolean(
    connected &&
      compatibilityKey &&
      !isConnecting &&
      !isConfigSelectorOpen &&
      !dismissedCompatibilityKeys.has(compatibilityKey),
  );
  const setConfigSelectorOpen = useCallback((isOpen: boolean) => {
    setIsConfigSelectorOpen(isOpen);
  }, []);
  const setCompatibilityNoticeOpen = useCallback((isOpen: boolean) => {
    if (isOpen || !compatibilityKey) return;
    setDismissedCompatibilityKeys((current) => {
      if (current.has(compatibilityKey)) return current;
      const next = new Set(current);
      next.add(compatibilityKey);
      return next;
    });
  }, [compatibilityKey]);
  const changeView = useCallback((nextView: ViewId) => {
    if (nextView === "script-editor") setIsConfigSelectorOpen(false);
    setSessionWorkspaceRoute(undefined);
    setBeaconWorkspaceRoute(undefined);
    setView(nextView);
  }, [setView]);
  useEffect(() => window.sliver.onScriptEditorRequested(() => {
    setIsCommandPaletteOpen(false);
    setIsConfigSelectorOpen(false);
    setCompatibilityNoticeOpen(false);
    changeView("script-editor");
    setScriptEditorRevealRequest((current) => current + 1);
  }), [changeView, setCompatibilityNoticeOpen]);
  useEffect(() => {
    const api = window.scriptTasks;
    if (!api) return;
    const unsubscribeHost = api.onHostRequested(() => setScriptEditorVisited(true));
    const unsubscribeEdit = api.onEditRequested((id) => {
      setIsCommandPaletteOpen(false);
      setIsConfigSelectorOpen(false);
      setCompatibilityNoticeOpen(false);
      changeView("script-editor");
      setScriptEditorEditRequest((current) => ({ id, request: (current?.request ?? 0) + 1 }));
    });
    return () => { unsubscribeHost(); unsubscribeEdit(); };
  }, [changeView, setCompatibilityNoticeOpen]);
  const navigateBack = useCallback(() => {
    if (!canGoBack) return;
    setSessionWorkspaceRoute(undefined);
    setBeaconWorkspaceRoute(undefined);
    goBack();
  }, [canGoBack, goBack]);
  const navigateForward = useCallback(() => {
    if (!canGoForward) return;
    setSessionWorkspaceRoute(undefined);
    setBeaconWorkspaceRoute(undefined);
    goForward();
  }, [canGoForward, goForward]);
  useNavigationShortcuts({
    settings,
    canGoBack,
    canGoForward,
    goBack: navigateBack,
    goForward: navigateForward,
  });
  const updateSettings = useCallback((
    updater: (current: ApplicationSettingsValues) => ApplicationSettingsValues,
  ): void => {
    if (applicationSettings) {
      void applicationSettings.updateSettings(updater);
      return;
    }
    setStandaloneSettings((current) => ({
      v: APPLICATION_SETTINGS_VERSION,
      revision: current.revision + 1,
      ...updater({
        theme: current.theme,
        appIcon: current.appIcon,
        reduceMotion: current.reduceMotion,
        reportScreenshotDirectory: current.reportScreenshotDirectory,
        commandPaletteShortcut: current.commandPaletteShortcut,
        keyboardShortcuts: current.keyboardShortcuts,
        terminal: current.terminal,
      }),
    }));
  }, [applicationSettings]);
  const openSessionWorkspace = useCallback((session: SessionSummary, target: TargetRef) => {
    const backendEpoch = snapshot.connection.epoch;
    if (
      backendEpoch === undefined ||
      target.mode !== "session" ||
      target.id !== session.id ||
      target.backendEpoch !== backendEpoch
    ) {
      toast.warning("Session changed", { description: "Reconnect and select the session again." });
      return;
    }
    setSessionWorkspaceRoute({
      sessionId: session.id,
      backendEpoch,
      connectionIncarnation: snapshot.connection.incarnation ?? 0,
      targetFingerprint: target.fingerprint,
    });
    setBeaconWorkspaceRoute(undefined);
    setView("sessions");
  }, [setView, snapshot.connection.epoch, snapshot.connection.incarnation]);
  const changeSessionWorkspace = useCallback((next: SliverSnapshot, route: SessionWorkspaceRoute) => {
    setSnapshot(next);
    setSessionWorkspaceRoute(route);
  }, []);
  const openBeaconWorkspace = useCallback((beacon: BeaconSummary, target: TargetRef) => {
    const backendEpoch = snapshot.connection.epoch;
    if (
      backendEpoch === undefined ||
      target.mode !== "beacon" ||
      target.id !== beacon.id ||
      target.backendEpoch !== backendEpoch
    ) {
      toast.warning("Beacon changed", { description: "Reconnect and select the beacon again." });
      return;
    }
    setBeaconWorkspaceRoute({
      target,
      connectionIncarnation: snapshot.connection.incarnation ?? 0,
    });
    setSessionWorkspaceRoute(undefined);
    setView("beacons");
  }, [setView, snapshot.connection.epoch, snapshot.connection.incarnation]);

  useEffect(() => {
    if (!sessionWorkspaceRoute) return;
    if (
      !connected ||
      snapshot.connection.epoch !== sessionWorkspaceRoute.backendEpoch ||
      (snapshot.connection.incarnation ?? 0) !== sessionWorkspaceRoute.connectionIncarnation
    ) setSessionWorkspaceRoute(undefined);
  }, [
    connected,
    sessionWorkspaceRoute,
    snapshot.connection.epoch,
    snapshot.connection.incarnation,
  ]);

  useEffect(() => {
    if (!beaconWorkspaceRoute) return;
    if (
      !connected ||
      snapshot.connection.epoch !== beaconWorkspaceRoute.target.backendEpoch ||
      (snapshot.connection.incarnation ?? 0) !== beaconWorkspaceRoute.connectionIncarnation
    ) setBeaconWorkspaceRoute(undefined);
  }, [
    beaconWorkspaceRoute,
    connected,
    snapshot.connection.epoch,
    snapshot.connection.incarnation,
  ]);

  const historyShortcuts = navigationShortcuts(isApplePlatform(), settings);
  const consoleShortcut = resolveKeyboardShortcut("openConsole", settings, isApplePlatform());
  const navigationCommands = [
    overviewNavItem,
    ...infrastructureNavItems,
    ...interactNavItems,
    ...dataNavItems,
    ...automationNavItems,
  ].map((item): AppCommandPaletteCommand => ({
    id: `navigate-${item.id}`,
    group: "Navigate",
    icon: item.icon,
    label: item.label,
    description: item.description,
    isCurrent: view === item.id,
    isDisabled: !isViewAvailable(item.id),
    onAction: () => changeView(item.id),
  }));
  const commandPaletteCommands: readonly AppCommandPaletteCommand[] = [
    ...navigationCommands,
    {
      id: "navigate-settings",
      group: "Navigate",
      icon: faGear,
      label: "Settings",
      description: "Configure appearance, keyboard shortcuts, and terminals.",
      keywords: ["preferences"],
      isCurrent: view === "settings",
      onAction: () => {
        setIsConfigSelectorOpen(false);
        changeView("settings");
      },
    },
    {
      id: "navigate-back",
      group: "Navigate",
      icon: faArrowLeft,
      label: "Go back",
      description: "Return to the previous page.",
      keywords: ["previous", "history"],
      shortcut: historyShortcuts.back.shortcut,
      isDisabled: !canGoBack,
      onAction: navigateBack,
    },
    {
      id: "navigate-forward",
      group: "Navigate",
      icon: faArrowRight,
      label: "Go forward",
      description: "Return to the next page in navigation history.",
      keywords: ["next", "history"],
      shortcut: historyShortcuts.forward.shortcut,
      isDisabled: !canGoForward,
      onAction: navigateForward,
    },
    {
      id: "server-switch-config",
      group: "Server",
      icon: faLink,
      label: "Saved configurations",
      description: "Connect to or manage an operator configuration.",
      keywords: ["switch server", "connect"],
      onAction: () => setIsConfigSelectorOpen(true),
    },
    {
      id: "server-console",
      group: "Server",
      icon: faTerminal,
      label: "Open Sliver console",
      shortcut: consoleShortcut,
      description: connected ? "Open a console for the active server." : "Connect to a server first.",
      keywords: ["terminal"],
      isDisabled: !connected,
      onAction: () => void openConsole(),
    },
    {
      id: "server-disconnect",
      group: "Server",
      icon: faLinkSlash,
      label: "Disconnect",
      description: connected ? "Disconnect the active server." : "No active server connection.",
      isDisabled: !connected,
      onAction: () => void disconnect(),
    },
    {
      id: "server-refresh",
      group: "Server",
      icon: faRotate,
      label: "Refresh server",
      shortcut: resolveKeyboardShortcut("refreshServer", settings, isApplePlatform()),
      description: connected ? "Reconcile the active server snapshot." : "Connect to a server first.",
      keywords: ["reload", "sync"],
      isDisabled: !connected,
      onAction: () => void refreshServer(),
    },
    {
      id: "window-cloud-deployment",
      group: "Windows",
      icon: faCloudArrowUp,
      label: "Cloud Deployment",
      description: "Open or focus the Cloud Deployment window.",
      keywords: ["aws", "cloud infrastructure"],
      onAction: () => void openCloudDeployment(),
    },
    {
      id: "report-screenshot",
      group: "Windows",
      icon: faCamera,
      label: "Report Screenshot",
      shortcut: resolveKeyboardShortcut("reportScreenshot", settings, isApplePlatform()),
      description: "Capture all open application windows to the configured screenshot folder.",
      keywords: ["capture", "windows", "desktop"],
      onAction: () => void reportScreenshot(),
    },
    {
      id: "window-same-server",
      group: "Windows",
      icon: faWindowRestore,
      label: "New connected window",
      shortcut: resolveKeyboardShortcut("duplicateWindow", settings, isApplePlatform()),
      description: connected ? "Open another window on the active server." : "Connect to a server first.",
      keywords: ["duplicate", "same server"],
      isDisabled: !connected,
      onAction: () => void openWindow(true),
    },
    {
      id: "window-different-server",
      group: "Windows",
      icon: faPlus,
      label: "New connection window",
      shortcut: resolveKeyboardShortcut("newWindow", settings, isApplePlatform()),
      description: "Open another window for a different server.",
      keywords: ["different server"],
      onAction: () => void openWindow(false),
    },
  ];

  const content = (
    <Sidebar.Provider
      className="app-shell"
      collapsible="icon"
      data-platform={globalThis.navigator?.platform.startsWith("Mac") ? "mac" : "other"}
      defaultOpen
    >
      <Sidebar className="app-sidebar">
        <NavigationContent
          snapshot={snapshot}
          lootCount={lootCount}
          view={view}
          onDisconnect={() => void disconnect()}
          onExitApp={() => void window.sliver.exitApp()}
          onSettings={() => {
            setIsConfigSelectorOpen(false);
            changeView("settings");
          }}
          onSwitchConfig={() => setIsConfigSelectorOpen(true)}
          onViewChange={changeView}
        />
        <Sidebar.Rail />
      </Sidebar>
      <Sidebar.Mobile backdrop="blur" className="app-sidebar">
        <NavigationContent
          snapshot={snapshot}
          lootCount={lootCount}
          view={view}
          onDisconnect={() => void disconnect()}
          onExitApp={() => void window.sliver.exitApp()}
          onSettings={() => {
            setIsConfigSelectorOpen(false);
            changeView("settings");
          }}
          onSwitchConfig={() => setIsConfigSelectorOpen(true)}
          onViewChange={changeView}
        />
      </Sidebar.Mobile>
      <Sidebar.Main className="app-main min-w-0">
        <header className="app-header">
          <div aria-hidden="true" className="app-header-drag-region" />
          <div className="header-server">
            <div className="hidden min-w-0 text-center sm:block">
              <p className="truncate text-sm font-medium text-foreground">
                {connected ? snapshot.connection.server : "No server connected"}
              </p>
              <p className="truncate text-xs text-muted">
                {connected
                  ? `${snapshot.connection.operator ?? "operator"} · ${snapshot.connection.configName ?? "configuration"}`
                  : "Select a saved configuration to begin"}
              </p>
            </div>
          </div>
          <div className="header-actions">
            {connected ? <EventStatus status={snapshot.eventStream.status} /> : null}
            {connected && snapshot.connection.status === "reconnecting" ? <ReconnectingStatus /> : null}
            <Tooltip delay={250}>
              <Tooltip.Trigger>
                <Button
                  aria-label="Open command palette"
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  onPress={() => setIsCommandPaletteOpen(true)}
                >
                  <FontAwesomeIcon aria-hidden icon={faMagnifyingGlass} />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content placement="bottom">
                <span className="flex items-center gap-2">
                  Command palette
                  <CommandPaletteShortcutKbd className="text-xs" shortcut={settings.commandPaletteShortcut} />
                </span>
              </Tooltip.Content>
            </Tooltip>
            <WindowMenu connected={connected} settings={settings} onOpenWindow={openWindow} />
            <Tooltip delay={250}>
              <Button
                aria-label="Open Sliver console"
                isDisabled={!connected}
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => void openConsole()}
                render={(props) => (
                  <button {...props} aria-keyshortcuts={shortcutAriaKeyShortcuts(consoleShortcut)} />
                )}
              >
                <FontAwesomeIcon aria-hidden icon={faTerminal} />
              </Button>
              <Tooltip.Content placement="bottom">
                <span className="flex items-center gap-2">
                  {connected ? "Open console for the active server" : "Connect to a server first"}
                  <CommandPaletteShortcutKbd className="text-xs" shortcut={consoleShortcut} />
                </span>
              </Tooltip.Content>
            </Tooltip>
            {!connected ? (
              <Button size="sm" isPending={isConnecting} onPress={() => setIsConfigSelectorOpen(true)}>
                <FontAwesomeIcon icon={faLink} /> Connect
              </Button>
            ) : null}
          </div>
        </header>
        <div
          className={view === "script-editor" ? "app-content app-content--scripts" : view === "overview" ? "app-content app-content--overview" : view === "generate" && connected
            ? "app-content app-content--generate"
            : "app-content"}
        >
          {scriptEditorVisited || view === "script-editor" ? <ScriptEditorPage active={view === "script-editor"} revealUnsavedRequest={scriptEditorRevealRequest} {...(scriptEditorEditRequest ? { editRequest: scriptEditorEditRequest } : {})} /> : null}
          {view === "overview" ? <OverviewPage snapshot={snapshot} onSnapshot={setSnapshot} onNavigate={changeView}
            onOpenSession={openSessionWorkspace} onOpenBeacon={openBeaconWorkspace} /> : view === "settings" ? (
            <SettingsPage
              isSaving={applicationSettings
                ? !applicationSettings.isReady || applicationSettings.isSaving
                : false}
              settings={settings}
              onAppIconChange={(appIcon) => updateSettings((current) => ({
                ...current,
                appIcon,
              }))}
              onReportScreenshotDirectoryChange={(reportScreenshotDirectory) => updateSettings((current) => ({
                ...current,
                reportScreenshotDirectory,
              }))}
              onResetKeyboardShortcuts={() => updateSettings((current) => ({
                ...current,
                commandPaletteShortcut: DEFAULT_COMMAND_PALETTE_SHORTCUT,
                keyboardShortcuts: {},
              }))}
              onKeyboardShortcutChange={(action, shortcut) => updateSettings((current) => {
                if (action === "commandPalette") return { ...current, commandPaletteShortcut: shortcut ?? DEFAULT_COMMAND_PALETTE_SHORTCUT };
                const keyboardShortcuts = { ...current.keyboardShortcuts };
                if (shortcut === undefined) delete keyboardShortcuts[action];
                else keyboardShortcuts[action] = shortcut;
                return { ...current, keyboardShortcuts };
              })}
              onReduceMotionChange={(reduceMotion) => updateSettings((current) => ({
                ...current,
                reduceMotion,
              }))}
              onTerminalChange={(terminal) => updateSettings((current) => ({
                ...current,
                terminal,
              }))}
              onThemeChange={(theme) => updateSettings((current) => ({
                ...current,
                theme,
              }))}
            />
          ) : connected ? (
            <>
              {view === "operations" ? <OperationsPage snapshot={snapshot} /> : null}
              {view === "sessions" ? (
                sessionWorkspaceRoute ? (
                  <SessionWorkspacePage
                    key={`session-workspace:${sessionWorkspaceRoute.backendEpoch}:${sessionWorkspaceRoute.connectionIncarnation}:${sessionWorkspaceRoute.sessionId}:${sessionWorkspaceRoute.targetFingerprint}`}
                    route={sessionWorkspaceRoute}
                    session={snapshot.targetContext.activeTargetSummary?.mode === "session"
                      ? snapshot.targetContext.activeTargetSummary
                      : null}
                    snapshot={snapshot}
                    onBack={() => setSessionWorkspaceRoute(undefined)}
                    onSessionChange={changeSessionWorkspace}
                    onSnapshot={setSnapshot}
                  />
                ) : (
                  <TargetsPage
                    key="sessions"
                    mode="session"
                    snapshot={snapshot}
                    onOpenSession={openSessionWorkspace}
                    onSnapshot={setSnapshot}
                  />
                )
              ) : null}
              {view === "beacons" ? (
                beaconWorkspaceRoute ? (
                  <TargetsPage
                    key={`beacon-workspace:${beaconWorkspaceRoute.target.backendEpoch}:${beaconWorkspaceRoute.connectionIncarnation}:${beaconWorkspaceRoute.target.id}:${beaconWorkspaceRoute.target.fingerprint}`}
                    expectedTarget={beaconWorkspaceRoute.target}
                    mode="beacon"
                    presentation="dedicated"
                    snapshot={snapshot}
                    onBack={() => setBeaconWorkspaceRoute(undefined)}
                    onSnapshot={setSnapshot}
                  />
                ) : (
                  <TargetsPage
                    key="beacons"
                    mode="beacon"
                    snapshot={snapshot}
                    onOpenBeacon={openBeaconWorkspace}
                    onSnapshot={setSnapshot}
                  />
                )
              ) : null}
              {view === "generate" ? <GeneratePage snapshot={snapshot} /> : null}
              {view === "artifacts" ? <BuildsPage snapshot={snapshot} /> : null}
              {view === "loot" ? <LootPage snapshot={snapshot} onInventoryTotal={acceptLootInventoryTotal} /> : null}
              {view === "credentials" ? <CredentialsPage snapshot={snapshot} /> : null}
            </>
          ) : null}
        </div>
        <SavedConfigSelector
          configs={savedConfigs}
          error={savedConfigError}
          isConnecting={isConnecting}
          isLoading={isLoadingSavedConfigs}
          isOpen={isConfigSelectorOpen}
          onChooseFile={connect}
          onConnect={connectSavedConfig}
          onImport={importConfig}
          onOpenCloudDeployment={openCloudDeployment}
          onOpenChange={setConfigSelectorOpen}
          onRefresh={loadSavedConfigs}
          onRemove={removeConfig}
        />
        <CompatibilityMismatchModal
          isOpen={isCompatibilityNoticeOpen}
          snapshot={snapshot}
          onOpenChange={setCompatibilityNoticeOpen}
        />
        <AppCommandPalette
          commands={commandPaletteCommands}
          isOpen={isCommandPaletteOpen}
          shortcut={settings.commandPaletteShortcut}
          onOpenChange={setIsCommandPaletteOpen}
        />
      </Sidebar.Main>
      <WindowNavigation
        settings={settings}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={navigateBack}
        onForward={navigateForward}
      />
    </Sidebar.Provider>
  );

  return <ConnectionProvider connection={snapshot.connection}>{content}</ConnectionProvider>;
}

function WindowNavigation({ canGoBack, canGoForward, onBack, onForward, settings }: {
  settings: ApplicationSettingsState;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}) {
  const { isMobile, isMobileOpen, isOpen, toggleSidebar } = useSidebar();
  const sidebarLabel = (isMobile ? isMobileOpen : isOpen) ? "Collapse sidebar" : "Expand sidebar";
  const shortcuts = navigationShortcuts(isApplePlatform(), settings);
  const actions = [
    { id: "sidebar", label: sidebarLabel, icon: faTableColumns, onPress: toggleSidebar, isDisabled: false, shortcut: undefined },
    { id: "back", label: "Go back", icon: faArrowLeft, onPress: onBack, isDisabled: !canGoBack, shortcut: shortcuts.back },
    { id: "forward", label: "Go forward", icon: faArrowRight, onPress: onForward, isDisabled: !canGoForward, shortcut: shortcuts.forward },
  ];

  return (
    <nav aria-label="Window navigation" className="window-navigation">
      {actions.map(({ id, label, icon, onPress, isDisabled, shortcut }) => (
        <Tooltip delay={250} key={id}>
          <Button
            aria-label={label}
            {...(id === "sidebar" ? { "aria-expanded": isMobile ? isMobileOpen : isOpen } : {})}
            className="window-navigation__button"
            isDisabled={isDisabled}
            isIconOnly
            size="sm"
            variant="ghost"
            render={(props) => (
              <button {...props} {...(shortcut ? { "aria-keyshortcuts": shortcut.ariaKeyShortcuts } : {})} />
            )}
            onPress={onPress}
          >
            <FontAwesomeIcon aria-hidden icon={icon} />
          </Button>
          <Tooltip.Content placement="bottom">
            <span className="flex items-center gap-2">
              {label}
              {shortcut ? <CommandPaletteShortcutKbd className="text-xs" shortcut={shortcut.shortcut} /> : null}
            </span>
          </Tooltip.Content>
        </Tooltip>
      ))}
    </nav>
  );
}

export function NavigationContent({
  snapshot,
  lootCount,
  view,
  onDisconnect,
  onExitApp,
  onSettings,
  onSwitchConfig,
  onViewChange,
}: {
  snapshot: SliverSnapshot;
  lootCount?: number | undefined;
  view: ViewId;
  onDisconnect: () => void;
  onExitApp: () => void;
  onSettings: () => void;
  onSwitchConfig: () => void;
  onViewChange: (view: ViewId) => void;
}) {
  const applicationSettings = useApplicationSettings();
  const sidebarIcon = applicationSettings?.resolvedAppIcon ?? "dark";
  const connected = isUsableConnection(snapshot.connection.status);
  const { setMobileOpen } = useSidebar();
  const switchConfig = () => {
    setMobileOpen(false);
    onSwitchConfig();
  };
  const disconnectCurrentServer = () => {
    setMobileOpen(false);
    onDisconnect();
  };
  const exitApp = () => {
    setMobileOpen(false);
    onExitApp();
  };
  const openSettings = () => {
    setMobileOpen(false);
    onSettings();
  };
  const navigate = (nextView: ViewId) => {
    setMobileOpen(false);
    onViewChange(nextView);
  };
  return (
    <>
      <Heading className="sr-only" slot="title">Sliver navigation</Heading>
      <Sidebar.Header className="brand-block">
        <div className="brand-mark" aria-hidden="true">
          <img alt="" className="brand-mark__image" draggable={false} src={sidebarIcons[sidebarIcon]} />
        </div>
        <div className="min-w-0" data-sidebar="label">
          <p className="truncate text-sm font-semibold tracking-tight">Sliver Desktop</p>
          <p className="truncate text-[11px] text-muted">Operator console</p>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group className="mt-3">
          <Sidebar.Menu aria-label="Overview navigation" showGuideLines={false}>
            <SidebarNavigationItem item={overviewNavItem} isCurrent={view === "overview"}
              isDisabled={false} onAction={() => navigate("overview")} />
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Operational</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Operational navigation" showGuideLines={false}>
            {infrastructureNavItems.map((item) => (
              <SidebarNavigationItem
                key={item.id}
                count={item.id === "operations" ? snapshot.jobs.length : undefined}
                item={item}
                isCurrent={view === item.id}
                isDisabled={!connected}
                onAction={() => navigate(item.id)}
              />
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Interact</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Interact navigation" showGuideLines={false}>
            {interactNavItems.map((item) => (
              <SidebarNavigationItem
                key={item.id}
                count={item.id === "sessions"
                  ? snapshot.domains.sessions.page.total
                  : snapshot.domains.beacons.page.total}
                item={item}
                isCurrent={view === item.id}
                isDisabled={!connected}
                onAction={() => navigate(item.id)}
              />
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Data</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Data navigation" showGuideLines={false}>
            {dataNavItems.map((item) => (
              <SidebarNavigationItem
                key={item.id}
                count={item.id === "loot" ? lootCount : undefined}
                item={item}
                isCurrent={view === item.id}
                isDisabled={!connected}
                onAction={() => navigate(item.id)}
              />
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Automations</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Automations navigation" showGuideLines={false}>
            {automationNavItems.map((item) => (
              <SidebarNavigationItem
                key={item.id}
                item={item}
                isCurrent={view === item.id}
                isDisabled={false}
                onAction={() => navigate(item.id)}
              />
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer>
        <SidebarZoomControls />
        <ConnectionMenu
          snapshot={snapshot}
          onDisconnect={disconnectCurrentServer}
          onExitApp={exitApp}
          onSettings={openSettings}
          onSwitchConfig={switchConfig}
        />
      </Sidebar.Footer>
    </>
  );
}

export function ConnectionMenu({
  snapshot,
  onDisconnect,
  onExitApp,
  onSettings,
  onSwitchConfig,
}: {
  snapshot: SliverSnapshot;
  onDisconnect: () => void;
  onExitApp: () => void;
  onSettings: () => void;
  onSwitchConfig: () => void;
}) {
  const connected = isUsableConnection(snapshot.connection.status);
  const operator = snapshot.connection.operator ?? "Current server";
  const { collapsible, isMobile, isOpen } = useSidebar();
  const isIconCollapsed = collapsible === "icon" && !isMobile && !isOpen;

  return (
    <Tooltip delay={250} isDisabled={!isIconCollapsed}>
      <Dropdown>
        <Button
          aria-label={connected ? `Current server: ${operator}` : "Application menu, offline"}
          className="connection-summary connection-summary--trigger"
          fullWidth={!isIconCollapsed}
          isIconOnly={isIconCollapsed}
          variant="ghost"
        >
          <span
            className={`connection-summary__status status-dot status-dot--${connected ? "connected" : "stopped"}`}
          />
          <span className="min-w-0 text-left" data-sidebar="label">
            <span className="block truncate text-xs font-medium">{connected ? operator : "Offline"}</span>
            <span className="block truncate text-[11px] text-muted">
              {connected ? snapshot.connection.version : "No active channel"}
            </span>
          </span>
          <FontAwesomeIcon
            aria-hidden
            className={`connection-summary__menu-icon size-3.5 shrink-0 text-muted${isIconCollapsed ? "" : " ms-auto"}`}
            icon={faEllipsisVertical}
          />
        </Button>
        <Dropdown.Popover className="min-w-56" placement="top start">
          <Dropdown.Menu
            aria-label="Application and current server actions"
            onAction={(key) => {
              if (String(key) === "switch-config") onSwitchConfig();
              if (String(key) === "disconnect") onDisconnect();
              if (String(key) === "exit-app") onExitApp();
              if (String(key) === "settings") onSettings();
            }}
          >
            <Dropdown.Item id="exit-app" textValue="Exit app" variant="danger">
              <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-danger" icon={faPowerOff} />
              <Label>Exit app</Label>
            </Dropdown.Item>
            {connected ? (
              <Dropdown.Item id="disconnect" textValue="Disconnect" variant="danger">
                <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-danger" icon={faLinkSlash} />
                <Label>Disconnect</Label>
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item id="switch-config" textValue="Switch config">
              <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-muted" icon={faLink} />
              <Label>Switch config</Label>
            </Dropdown.Item>
            <Dropdown.Item id="settings" textValue="Settings">
              <FontAwesomeIcon aria-hidden className="size-3.5 shrink-0 text-muted" icon={faGear} />
              <Label>Settings</Label>
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <Tooltip.Content placement="right">Application menu</Tooltip.Content>
    </Tooltip>
  );
}

export function WindowMenu({
  connected,
  onOpenWindow,
  settings = DEFAULT_APPLICATION_SETTINGS_STATE,
}: {
  connected: boolean;
  onOpenWindow: (inherit: boolean) => Promise<void>;
  settings?: ApplicationSettingsState;
}) {
  const newWindowShortcut = resolveKeyboardShortcut("newWindow", settings, isApplePlatform());
  const duplicateWindowShortcut = resolveKeyboardShortcut("duplicateWindow", settings, isApplePlatform());
  return (
    <Tooltip delay={250}>
      <Dropdown>
        <Button aria-label="New window options" isIconOnly size="sm" variant="ghost">
          <FontAwesomeIcon aria-hidden icon={faWindowRestore} />
        </Button>
        <Dropdown.Popover className="min-w-52">
          <Dropdown.Menu
            aria-label="New window"
            onAction={(key) => void onOpenWindow(String(key) === "same-server")}
          >
            {connected ? (
              <Dropdown.Item
                id="same-server"
                textValue="Same server"
                aria-label="Same server"
              >
                <FontAwesomeIcon aria-hidden icon={faWindowRestore} className="size-3.5 shrink-0 text-muted" />
                <Label>Same server</Label>
                <CommandPaletteShortcutKbd slot="keyboard" shortcut={duplicateWindowShortcut} />
              </Dropdown.Item>
            ) : null}
            <Dropdown.Item
              id="different-server"
              textValue="Different server"
              aria-label="Different server"
            >
              <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3.5 shrink-0 text-muted" />
              <Label>Different server</Label>
              <CommandPaletteShortcutKbd slot="keyboard" shortcut={newWindowShortcut} />
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <Tooltip.Content placement="bottom">
        <span className="flex items-center gap-2">
          New window
          <CommandPaletteShortcutKbd className="text-xs" shortcut={newWindowShortcut} />
        </span>
      </Tooltip.Content>
    </Tooltip>
  );
}

function EventStatus({ status }: { status: EventStreamStatus }) {
  const metadata = {
    connected: { label: "Live", color: "success" as const },
    connecting: { label: "Awaiting events", color: "accent" as const },
    retrying: { label: "Reconnecting", color: "warning" as const },
    stopped: { label: "Events offline", color: "danger" as const },
  }[status];
  return (
    <Chip size="sm" color={metadata.color} variant="soft" className="hidden sm:inline-flex">
      <span className={`status-dot status-dot--${status}`} /> {metadata.label}
    </Chip>
  );
}

function ReconnectingStatus() {
  return (
    <Chip size="sm" color="warning" variant="soft" className="hidden md:inline-flex">
      Backend reconnecting
    </Chip>
  );
}

function CompatibilityMismatchModal({
  isOpen,
  snapshot,
  onOpenChange,
}: {
  isOpen: boolean;
  snapshot: SliverSnapshot;
  onOpenChange: (isOpen: boolean) => void;
}) {
  const capabilities = snapshot.connection.capabilities;
  if (capabilities?.compatibility !== "degraded") return null;

  const serverVersion = capabilities.serverVersion ?? snapshot.connection.version ?? "Not reported";
  const reason = capabilities.reason ?? `This server is outside the compatible ${SLIVER_PROTOCOL_COMPATIBILITY.series} version series`;

  return (
    <Modal.Backdrop isOpen={isOpen} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog
          aria-describedby="server-version-mismatch-description"
          className="sm:max-w-[440px]"
        >
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-warning-soft text-warning-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>Server version mismatch</Modal.Heading>
              <p
                className="mt-1 text-sm font-normal leading-relaxed text-muted"
                id="server-version-mismatch-description"
              >
                Sliver Desktop connected successfully, but this server is outside the version series verified for this app.
              </p>
            </div>
          </Modal.Header>
          <Modal.Body className="flex flex-col gap-3">
            <dl className="grid gap-2 rounded-xl border border-separator bg-default p-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted">Connected server</dt>
                <dd className="text-right font-medium text-foreground">{serverVersion}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <dt className="text-muted">Compatible series</dt>
                <dd className="font-mono text-xs text-foreground">{SLIVER_PROTOCOL_COMPATIBILITY.series}</dd>
              </div>
            </dl>
            <p className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm leading-relaxed text-warning-soft-foreground">
              {reason}.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button slot="close">Continue</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function compatibilityNoticeKey(snapshot: SliverSnapshot): string | undefined {
  const capabilities = snapshot.connection.capabilities;
  if (capabilities?.compatibility !== "degraded") return undefined;
  const connectionIdentity = snapshot.connection.epoch === undefined
    ? `${snapshot.connection.server ?? "unknown"}:${capabilities.serverVersion ?? snapshot.connection.version ?? "unknown"}`
    : String(snapshot.connection.epoch);
  return `${connectionIdentity}:${SLIVER_PROTOCOL_COMPATIBILITY.series}`;
}
