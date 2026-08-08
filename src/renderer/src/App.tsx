import { useCallback, useEffect, useState } from "react";
import { Button, Card, Chip, Dropdown, Label, Tooltip, toast } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { Sidebar } from "@heroui-pro/react/sidebar";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowsRotate,
  faBars,
  faBolt,
  faBoxesStacked,
  faCircleNodes,
  faLink,
  faLinkSlash,
  faPlus,
  faSatelliteDish,
  faShieldHalved,
  faWindowRestore,
} from "@fortawesome/free-solid-svg-icons";
import { disconnectedSnapshot } from "../../shared/contracts";
import type { EventStreamStatus, SavedConfigSummary, SliverSnapshot } from "../../shared/contracts";
import { SavedConfigSelector } from "./components/SavedConfigSelector";
import { BuildsPage } from "./pages/BuildsPage";
import { GeneratePage } from "./pages/GeneratePage";
import { OperationsPage } from "./pages/OperationsPage";

type ViewId = "operations" | "generate" | "artifacts";

const navItems = [
  { id: "operations" as const, label: "Jobs & listeners", icon: faSatelliteDish },
  { id: "generate" as const, label: "Generate", icon: faBolt },
  { id: "artifacts" as const, label: "Builds & profiles", icon: faBoxesStacked },
];

export function App() {
  const [snapshot, setSnapshot] = useState<SliverSnapshot>(() => disconnectedSnapshot());
  const [view, setView] = useState<ViewId>("operations");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isConfigSelectorOpen, setIsConfigSelectorOpen] = useState(true);
  const [isLoadingSavedConfigs, setIsLoadingSavedConfigs] = useState(true);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigSummary[]>([]);
  const [savedConfigError, setSavedConfigError] = useState<string>();

  const loadSavedConfigs = useCallback(async () => {
    setIsLoadingSavedConfigs(true);
    try {
      const result = await window.sliver.listSavedConfigs();
      if (!result.ok || !result.value) {
        setSavedConfigError(result.error ?? "Could not load saved configurations");
        return;
      }
      setSavedConfigs(result.value);
      setSavedConfigError(undefined);
    } catch (error) {
      setSavedConfigError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingSavedConfigs(false);
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
        if (next.connection.status === "connected") setIsConfigSelectorOpen(false);
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

  const connect = useCallback(async (): Promise<boolean> => {
    setIsConnecting(true);
    try {
      const result = await window.sliver.chooseConfig();
      if (!result.ok || !result.value) {
        if (result.error && !/cancel/i.test(result.error)) {
          toast.danger("Connection failed", { description: result.error });
        }
        return false;
      }
      setSnapshot(result.value);
      setIsConfigSelectorOpen(false);
      toast.success("Connected", { description: result.value.connection.server });
      return true;
    } catch (error) {
      toast.danger("Connection failed", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const connectSavedConfig = useCallback(async (config: SavedConfigSummary): Promise<boolean> => {
    setIsConnecting(true);
    try {
      const result = await window.sliver.connectSavedConfig(config.id);
      if (!result.ok || !result.value) {
        toast.danger("Connection failed", { description: result.error });
        return false;
      }
      setSnapshot(result.value);
      setIsConfigSelectorOpen(false);
      toast.success("Connected", { description: result.value.connection.server });
      return true;
    } catch (error) {
      toast.danger("Connection failed", {
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      setIsConnecting(false);
    }
  }, []);

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

  const connected = snapshot.connection.status === "connected";
  const setConfigSelectorOpen = useCallback((isOpen: boolean) => {
    setIsConfigSelectorOpen(isOpen);
  }, []);

  return (
    <Sidebar.Provider collapsible="icon" defaultOpen>
      <Sidebar className="app-sidebar">
        <NavigationContent snapshot={snapshot} view={view} onViewChange={setView} />
        <Sidebar.Rail />
      </Sidebar>
      <Sidebar.Mobile backdrop="blur" className="app-sidebar">
        <NavigationContent snapshot={snapshot} view={view} onViewChange={setView} />
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
                  : "Import an operator configuration to begin"}
              </p>
            </div>
          </div>
          <div className="header-actions">
            {connected ? <EventStatus status={snapshot.eventStream.status} /> : null}
            <WindowMenu connected={connected} onOpenWindow={openWindow} />
            {connected ? (
              <>
                <HeaderAction label="Refresh server state" icon={faArrowsRotate} pending={isRefreshing} onPress={() => void refresh()} />
                <Button size="sm" variant="tertiary" onPress={() => void disconnect()}>
                  <FontAwesomeIcon icon={faLinkSlash} />
                  <span className="hidden lg:inline">Disconnect</span>
                </Button>
              </>
            ) : (
              <Button size="sm" isPending={isConnecting} onPress={() => setIsConfigSelectorOpen(true)}>
                <FontAwesomeIcon icon={faLink} /> Connect
              </Button>
            )}
          </div>
        </header>
        <div
          className={view === "generate" && connected
            ? "app-content app-content--generate"
            : "app-content"}
        >
          {connected ? (
            <>
              {view === "operations" ? <OperationsPage snapshot={snapshot} /> : null}
              {view === "generate" ? <GeneratePage snapshot={snapshot} /> : null}
              {view === "artifacts" ? <BuildsPage snapshot={snapshot} /> : null}
            </>
          ) : (
            <ConnectionLanding
              snapshot={snapshot}
              isConnecting={isConnecting}
              isLoadingSavedConfigs={isLoadingSavedConfigs}
              savedConfigCount={savedConfigs.length}
              onOpenConfigSelector={() => setIsConfigSelectorOpen(true)}
            />
          )}
        </div>
        <SavedConfigSelector
          configs={savedConfigs}
          error={savedConfigError}
          isConnecting={isConnecting}
          isLoading={isLoadingSavedConfigs}
          isOpen={isConfigSelectorOpen}
          onChooseFile={connect}
          onConnect={connectSavedConfig}
          onOpenChange={setConfigSelectorOpen}
          onRefresh={loadSavedConfigs}
        />
      </Sidebar.Main>
    </Sidebar.Provider>
  );
}

export function NavigationContent({
  snapshot,
  view,
  onViewChange,
}: {
  snapshot: SliverSnapshot;
  view: ViewId;
  onViewChange: (view: ViewId) => void;
}) {
  const connected = snapshot.connection.status === "connected";
  return (
    <>
      <Sidebar.Header className="brand-block">
        <div className="brand-mark" aria-hidden="true"><FontAwesomeIcon icon={faShieldHalved} /></div>
        <div className="min-w-0" data-sidebar="label">
          <p className="truncate text-sm font-semibold tracking-tight">Sliver Desktop</p>
          <p className="truncate text-[11px] text-muted">Operator console</p>
        </div>
      </Sidebar.Header>
      <Sidebar.Content>
        <Sidebar.Group>
          <Sidebar.GroupLabel>Workspace</Sidebar.GroupLabel>
          <Sidebar.Menu aria-label="Workspace navigation" showGuideLines={false}>
            {navItems.map((item) => (
              <Sidebar.MenuItem
                key={item.id}
                id={item.id}
                aria-label={item.label}
                textValue={item.label}
                isCurrent={view === item.id}
                isDisabled={!connected}
                tooltip={item.label}
                onAction={() => onViewChange(item.id)}
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
      </Sidebar.Content>
      <Sidebar.Footer>
        <div className="connection-summary">
          <span className={`status-dot status-dot--${connected ? "connected" : "stopped"}`} />
          <div className="min-w-0" data-sidebar="label">
            <p className="truncate text-xs font-medium">{connected ? snapshot.connection.operator : "Offline"}</p>
            <p className="truncate text-[11px] text-muted">{connected ? snapshot.connection.version : "No active channel"}</p>
          </div>
        </div>
      </Sidebar.Footer>
    </>
  );
}

function ConnectionLanding({
  snapshot,
  isConnecting,
  isLoadingSavedConfigs,
  savedConfigCount,
  onOpenConfigSelector,
}: {
  snapshot: SliverSnapshot;
  isConnecting: boolean;
  isLoadingSavedConfigs: boolean;
  savedConfigCount: number;
  onOpenConfigSelector: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100vh-10rem)] items-center justify-center py-12">
      <Card variant="secondary" className="w-full max-w-xl overflow-hidden">
        <div className="landing-glow" aria-hidden="true" />
        <Card.Content className="relative p-8 sm:p-10">
          <EmptyState size="lg">
            <EmptyState.Media className="landing-icon"><FontAwesomeIcon icon={faCircleNodes} /></EmptyState.Media>
            <EmptyState.Content>
              <EmptyState.Title>Connect an operator configuration</EmptyState.Title>
              <EmptyState.Description>
                Choose a saved configuration from ~/.sliver-client/configs or import one from another location. Certificates, keys, and tokens remain only in the Electron main process.
              </EmptyState.Description>
            </EmptyState.Content>
            <div className="mt-6 flex justify-center">
              <Button isPending={isConnecting || isLoadingSavedConfigs} onPress={onOpenConfigSelector}>
                <FontAwesomeIcon icon={faLink} />
                {savedConfigCount > 0 ? `Saved configurations (${savedConfigCount})` : "Select configuration"}
              </Button>
            </div>
            {snapshot.connection.status === "error" && snapshot.connection.error ? (
              <div className="mt-6 max-w-md rounded-2xl bg-danger-soft px-4 py-3 text-left text-sm text-danger-soft-foreground">
                {snapshot.connection.error}
              </div>
            ) : null}
          </EmptyState>
        </Card.Content>
      </Card>
    </div>
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
