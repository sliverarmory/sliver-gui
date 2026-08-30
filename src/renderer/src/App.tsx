import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Chip, Dropdown, Label, Modal, Tooltip, toast } from "@heroui/react";
import { Sidebar, useSidebar } from "@heroui-pro/react/sidebar";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Heading } from "react-aria-components";
import {
  faArrowsRotate,
  faBars,
  faBolt,
  faBoxesStacked,
  faComputer,
  faEllipsisVertical,
  faGear,
  faLink,
  faLinkSlash,
  faPlus,
  faPowerOff,
  faSatellite,
  faSatelliteDish,
  faTerminal,
  faTriangleExclamation,
  faWindowRestore,
} from "@fortawesome/free-solid-svg-icons";
import { disconnectedSnapshot } from "../../shared/contracts";
import type { ConnectionStatus, EventStreamStatus, SavedConfigSummary, SliverSnapshot } from "../../shared/contracts";
import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
  type ApplicationSettingsValues,
} from "../../shared/application-settings-contracts";
import { CONSOLE_WINDOW_OPEN_REQUEST_ERROR } from "../../shared/console-contracts";
import type { SessionSummary, TargetRef } from "../../shared/target-contracts";
import sliverSidebarIcon from "./assets/sliver-sidebar.png";
import { SavedConfigSelector } from "./components/SavedConfigSelector";
import { useApplicationSettings } from "./components/ApplicationSettingsProvider";
import { BuildsPage } from "./pages/BuildsPage";
import { GeneratePage } from "./pages/GeneratePage";
import { OperationsPage } from "./pages/OperationsPage";
import { SettingsPage } from "./pages/SettingsPage";
import {
  SessionWorkspacePage,
  type SessionWorkspaceRoute,
} from "./pages/SessionWorkspacePage";
import { TargetsPage } from "./pages/TargetsPage";

type ViewId = "operations" | "sessions" | "beacons" | "generate" | "artifacts" | "settings";

const infrastructureNavItems = [
  { id: "operations" as const, label: "Jobs & listeners", icon: faSatelliteDish },
  { id: "generate" as const, label: "Generate", icon: faBolt },
  { id: "artifacts" as const, label: "Builds & profiles", icon: faBoxesStacked },
];

const interactNavItems = [
  { id: "sessions" as const, label: "Sessions", icon: faComputer },
  { id: "beacons" as const, label: "Beacons", icon: faSatellite },
];

export function App() {
  const applicationSettings = useApplicationSettings();
  const [standaloneSettings, setStandaloneSettings] = useState<ApplicationSettingsState>(
    DEFAULT_APPLICATION_SETTINGS_STATE,
  );
  const [snapshot, setSnapshot] = useState<SliverSnapshot>(() => disconnectedSnapshot());
  const [view, setView] = useState<ViewId>("operations");
  const [sessionWorkspaceRoute, setSessionWorkspaceRoute] = useState<SessionWorkspaceRoute>();
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isConfigSelectorOpen, setIsConfigSelectorOpen] = useState(true);
  const [isLoadingSavedConfigs, setIsLoadingSavedConfigs] = useState(true);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigSummary[]>([]);
  const [savedConfigError, setSavedConfigError] = useState<string>();
  const savedConfigLoadRef = useRef<Promise<void> | null>(null);
  const wasConnectedRef = useRef(false);
  const [dismissedCompatibilityKeys, setDismissedCompatibilityKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

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
    const unsubscribe = window.sliver.onSnapshotChanged((next) => {
      if (mounted) setSnapshot(next);
    });
    void window.sliver.getSnapshot().then((next) => {
      if (mounted) {
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

  const connect = useCallback(async (): Promise<void> => {
    setIsConnecting(true);
    try {
      const result = await window.sliver.chooseConfig();
      if (!result.ok || !result.value) {
        if (result.error && !/cancel/i.test(result.error)) {
          toast.danger("Connection failed", { description: result.error });
        }
        return;
      }
      setSnapshot(result.value);
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
    setIsConnecting(true);
    try {
      const result = await window.sliver.connectSavedConfig(config.id);
      if (!result.ok || !result.value) {
        toast.danger("Connection failed", { description: result.error });
        return;
      }
      setSnapshot(result.value);
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
    toast.success(config.removal === "delete-managed-copy" ? "Imported copy deleted" : "Configuration forgotten", {
      description: config.displayName,
    });
  }, [loadSavedConfigs]);

  const disconnect = useCallback(async () => {
    const result = await window.sliver.disconnect();
    if (!result.ok || !result.value) {
      toast.danger("Could not disconnect", { description: result.error });
      return;
    }
    setSnapshot(result.value);
  }, []);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await window.sliver.refresh();
      if (!result.ok || !result.value) {
        toast.danger("Refresh failed", { description: result.error });
        return;
      }
      setSnapshot(result.value);
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  async function openWindow(inheritConnection: boolean) {
    const result = await window.sliver.openWindow({ inheritConnection });
    if (!result.ok) toast.danger("Could not open window", { description: result.error });
  }

  async function openConsole() {
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
  }

  const connected = isUsableConnection(snapshot.connection.status);
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
    setSessionWorkspaceRoute(undefined);
    setView(nextView);
  }, []);
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
        reduceMotion: current.reduceMotion,
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
  }, [snapshot.connection.epoch, snapshot.connection.incarnation]);
  const changeSessionWorkspace = useCallback((next: SliverSnapshot, route: SessionWorkspaceRoute) => {
    setSnapshot(next);
    setSessionWorkspaceRoute(route);
  }, []);

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

  return (
    <Sidebar.Provider collapsible="icon" defaultOpen>
      <Sidebar className="app-sidebar">
        <NavigationContent
          snapshot={snapshot}
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
          <div className="flex min-w-0 items-center gap-3">
            <Sidebar.Trigger aria-label="Toggle navigation">
              <FontAwesomeIcon icon={faBars} />
            </Sidebar.Trigger>
            <div className="hidden min-w-0 sm:block">
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
            <WindowMenu connected={connected} onOpenWindow={openWindow} />
            <Tooltip delay={250}>
              <Tooltip.Trigger>
                <Button
                  aria-label="Open Sliver console"
                  isDisabled={!connected}
                  size="sm"
                  variant="ghost"
                  onPress={() => void openConsole()}
                >
                  <FontAwesomeIcon aria-hidden icon={faTerminal} />
                  <span className="hidden xl:inline">Console</span>
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content placement="bottom">
                {connected ? "Open console for the active server" : "Connect to a server first"}
              </Tooltip.Content>
            </Tooltip>
            {connected ? (
              <HeaderAction label="Refresh server state" icon={faArrowsRotate} pending={isRefreshing} onPress={() => void refresh()} />
            ) : (
              <Button size="sm" isPending={isConnecting} onPress={() => setIsConfigSelectorOpen(true)}>
                <FontAwesomeIcon icon={faLink} /> Saved configurations
              </Button>
            )}
          </div>
        </header>
        <div
          className={view === "generate" && connected
            ? "app-content app-content--generate"
            : "app-content"}
        >
          {view === "settings" ? (
            <SettingsPage
              isSaving={applicationSettings
                ? !applicationSettings.isReady || applicationSettings.isSaving
                : false}
              settings={applicationSettings?.settings ?? standaloneSettings}
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
              {view === "beacons" ? <TargetsPage key="beacons" mode="beacon" snapshot={snapshot} onSnapshot={setSnapshot} /> : null}
              {view === "generate" ? <GeneratePage snapshot={snapshot} /> : null}
              {view === "artifacts" ? <BuildsPage snapshot={snapshot} /> : null}
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
          onOpenChange={setConfigSelectorOpen}
          onRefresh={loadSavedConfigs}
          onRemove={removeConfig}
        />
        <CompatibilityMismatchModal
          isOpen={isCompatibilityNoticeOpen}
          snapshot={snapshot}
          onOpenChange={setCompatibilityNoticeOpen}
        />
      </Sidebar.Main>
    </Sidebar.Provider>
  );
}

export function NavigationContent({
  snapshot,
  view,
  onDisconnect,
  onExitApp,
  onSettings,
  onSwitchConfig,
  onViewChange,
}: {
  snapshot: SliverSnapshot;
  view: ViewId;
  onDisconnect: () => void;
  onExitApp: () => void;
  onSettings: () => void;
  onSwitchConfig: () => void;
  onViewChange: (view: ViewId) => void;
}) {
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
          <img alt="" className="brand-mark__image" draggable={false} src={sliverSidebarIcon} />
        </div>
        <div className="min-w-0" data-sidebar="label">
          <p className="truncate text-sm font-semibold tracking-tight">Sliver Desktop</p>
          <p className="truncate text-[11px] text-muted">Operator console</p>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Infrastructure</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Infrastructure navigation" showGuideLines={false}>
            {infrastructureNavItems.map((item) => (
              <Sidebar.MenuItem
                key={item.id}
                id={item.id}
                aria-label={item.label}
                textValue={item.label}
                isCurrent={view === item.id}
                isDisabled={!connected}
                tooltip={item.label}
                onAction={() => navigate(item.id)}
              >
                <Sidebar.MenuIcon><FontAwesomeIcon icon={item.icon} /></Sidebar.MenuIcon>
                <Sidebar.MenuLabel>{item.label}</Sidebar.MenuLabel>
                {item.id === "operations" && snapshot.jobs.length > 0 ? (
                  <Sidebar.MenuChip>{snapshot.jobs.length}</Sidebar.MenuChip>
                ) : null}
              </Sidebar.MenuItem>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Interact</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Interact navigation" showGuideLines={false}>
            {interactNavItems.map((item) => (
              <Sidebar.MenuItem
                key={item.id}
                id={item.id}
                aria-label={item.label}
                textValue={item.label}
                isCurrent={view === item.id}
                isDisabled={!connected}
                tooltip={item.label}
                onAction={() => navigate(item.id)}
              >
                <Sidebar.MenuIcon><FontAwesomeIcon icon={item.icon} /></Sidebar.MenuIcon>
                <Sidebar.MenuLabel>{item.label}</Sidebar.MenuLabel>
                {(item.id === "sessions" ? snapshot.domains.sessions.page.total : snapshot.domains.beacons.page.total) > 0 ? (
                  <Sidebar.MenuChip>{item.id === "sessions" ? snapshot.domains.sessions.page.total : snapshot.domains.beacons.page.total}</Sidebar.MenuChip>
                ) : null}
              </Sidebar.MenuItem>
            ))}
          </Sidebar.Menu>
        </Sidebar.Group>
      </Sidebar.Content>
      <Sidebar.Footer>
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

  return (
    <Dropdown>
      <Button
        aria-label={connected ? `Current server: ${operator}` : "Application menu, offline"}
        className="connection-summary connection-summary--trigger"
        fullWidth
        variant="ghost"
      >
        <span className={`status-dot status-dot--${connected ? "connected" : "stopped"}`} />
        <span className="min-w-0 text-left" data-sidebar="label">
          <span className="block truncate text-xs font-medium">{connected ? operator : "Offline"}</span>
          <span className="block truncate text-[11px] text-muted">
            {connected ? snapshot.connection.version : "No active channel"}
          </span>
        </span>
        <FontAwesomeIcon
          aria-hidden
          className="ms-auto size-3.5 shrink-0 text-muted"
          data-sidebar="label"
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
  );
}

export function WindowMenu({
  connected,
  onOpenWindow,
}: {
  connected: boolean;
  onOpenWindow: (inherit: boolean) => Promise<void>;
}) {
  return (
    <Dropdown>
      <Button aria-label="New window options" size="sm" variant="ghost">
        <FontAwesomeIcon aria-hidden icon={faWindowRestore} />
        <span className="hidden xl:inline">New window</span>
      </Button>
      <Dropdown.Popover className="min-w-52">
        <Dropdown.Menu
          aria-label="New window"
          onAction={(key) => void onOpenWindow(String(key) === "same-server")}
        >
          {connected ? (
            <Dropdown.Item id="same-server" textValue="Same server">
              <FontAwesomeIcon aria-hidden icon={faWindowRestore} className="size-3.5 shrink-0 text-muted" />
              <Label>Same server</Label>
            </Dropdown.Item>
          ) : null}
          <Dropdown.Item id="different-server" textValue="Different server">
            <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3.5 shrink-0 text-muted" />
            <Label>Different server</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

function EventStatus({ status }: { status: EventStreamStatus }) {
  const metadata = {
    connected: { label: "Live", color: "success" as const },
    connecting: { label: "Syncing", color: "accent" as const },
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
  const baselineCommit = capabilities.baselineCommit.slice(0, 12);
  const reason = capabilities.reason ?? "This server build has not been verified against the pinned baseline";

  return (
    <Modal.Backdrop isOpen={isOpen} variant="blur" onOpenChange={onOpenChange}>
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog
          aria-describedby="server-build-mismatch-description"
          className="sm:max-w-[440px]"
        >
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-warning-soft text-warning-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>Server build mismatch</Modal.Heading>
              <p
                className="mt-1 text-sm font-normal leading-relaxed text-muted"
                id="server-build-mismatch-description"
              >
                Sliver Desktop connected successfully, but this server does not match the build used to verify this app.
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
                <dt className="text-muted">Verified baseline</dt>
                <dd className="font-mono text-xs text-foreground">{baselineCommit}</dd>
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
  return `${connectionIdentity}:${capabilities.baselineCommit}`;
}

function isUsableConnection(status: ConnectionStatus): boolean {
  return status === "connected" || status === "degraded" || status === "reconnecting";
}

function HeaderAction({
  label,
  icon,
  onPress,
  pending = false,
}: {
  label: string;
  icon: typeof faArrowsRotate;
  onPress: () => void;
  pending?: boolean;
}) {
  return (
    <Tooltip delay={350}>
      <Tooltip.Trigger>
        <Button aria-label={label} size="sm" variant="ghost" isIconOnly isPending={pending} onPress={onPress}>
          <FontAwesomeIcon icon={icon} />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content placement="bottom">{label}</Tooltip.Content>
    </Tooltip>
  );
}
