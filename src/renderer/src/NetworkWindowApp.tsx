import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { DataGrid } from "@heroui-pro/react/data-grid";
import {
  Button,
  Card,
  Chip,
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  Select,
  Spinner,
  Switch,
  Tabs,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faArrowRightArrowLeft,
  faArrowsLeftRightToLine,
  faChevronDown,
  faCircleExclamation,
  faGaugeHigh,
  faGlobe,
  faNetworkWired,
  faPlus,
  faRotate,
  faRoute,
  faShieldHalved,
  faStop,
} from "@fortawesome/free-solid-svg-icons";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { ConnectionStatus } from "../../shared/contracts";
import {
  NETWORK_FORWARDING_DEFAULTS,
  NETWORK_FORWARDING_LIMITS,
  parseStartPortForwardInput,
  parseStartReversePortForwardInput,
  parseStartSocks5ProxyInput,
  type NetworkForwardingAPI,
  type NetworkForwardingSnapshot,
  type NetworkPortForwardSummary,
  type NetworkReversePortForwardSummary,
  type NetworkSessionEntry,
  type NetworkSocks5ProxySummary,
  type NetworkTabId,
  type NetworkWindowContext,
} from "../../shared/network-forwarding-contracts";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";
import { ConnectionProvider } from "./components/ConnectionProvider";

type CreateKind = "port-forward" | "reverse-port-forward" | "socks5";
type StopTarget =
  | { readonly kind: "port-forward"; readonly value: NetworkPortForwardSummary }
  | { readonly kind: "reverse-port-forward"; readonly value: NetworkReversePortForwardSummary }
  | { readonly kind: "socks5"; readonly value: NetworkSocks5ProxySummary };

export function NetworkWindowApp(): React.JSX.Element {
  const api = window.network;
  const [selectedTab, setSelectedTab] = useState<NetworkTabId>("port-forward");
  const [context, setContext] = useState<NetworkWindowContext>();
  const [snapshot, setSnapshot] = useState<NetworkForwardingSnapshot>();
  const [isRefreshing, setIsRefreshing] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [createKind, setCreateKind] = useState<CreateKind>();
  const [stopTarget, setStopTarget] = useState<StopTarget>();
  const [isStopping, setIsStopping] = useState(false);
  const refreshRequested = useRef(false);
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined);

  const refresh: (showProgress?: boolean) => Promise<void> = useCallback((showProgress = false): Promise<void> => {
    if (!api) return Promise.resolve();
    refreshRequested.current = true;
    if (showProgress) setIsRefreshing(true);
    const activeRefresh = refreshInFlight.current;
    if (activeRefresh) return activeRefresh;

    const inFlight = (async (): Promise<void> => {
      while (refreshRequested.current) {
        refreshRequested.current = false;
        try {
          const contextResult = await api.getContext();
          if (!contextResult.ok || !contextResult.value) {
            setContext(undefined);
            setSnapshot(undefined);
            setLoadError(contextResult.error ?? "The Network context is unavailable.");
            continue;
          }

          const nextContext = contextResult.value;
          const activeSessions = nextContext.sessions.items.filter(({ session }) => session.liveness === "active");
          setContext(nextContext);

          const forwardsResult = await api.list({ reverseTargets: activeSessions.map(({ ref }) => ref) });
          if (!forwardsResult.ok || !forwardsResult.value) {
            setSnapshot(undefined);
            setLoadError(forwardsResult.error ?? "The forwarding inventory is unavailable.");
            continue;
          }
          setSnapshot(forwardsResult.value);
          setLoadError(undefined);
        } catch (error) {
          setContext(undefined);
          setSnapshot(undefined);
          setLoadError(errorMessage(error));
        }
      }
    })();
    refreshInFlight.current = inFlight;
    void inFlight.finally(() => {
      if (refreshInFlight.current !== inFlight) return;
      refreshInFlight.current = undefined;
      setIsRefreshing(false);
      if (refreshRequested.current) queueMicrotask(() => void refresh(false));
    });
    return inFlight;
  }, [api]);

  useEffect(() => {
    if (!api) {
      setIsRefreshing(false);
      setLoadError("The Network bridge is unavailable in this window.");
      return;
    }
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(false), 75);
    };
    const unsubscribeChanged = api.onChanged(scheduleRefresh);
    const unsubscribeNavigation = api.onNavigationRequested(setSelectedTab);
    void refresh(true);
    return () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      unsubscribeChanged();
      unsubscribeNavigation();
    };
  }, [api, refresh]);

  const sessions = context?.sessions.items ?? [];
  const activeSessions = useMemo(
    () => sessions.filter(({ session }) => session.liveness === "active"),
    [sessions],
  );
  const sessionNames = useMemo(
    () => new Map(sessions.map(({ session }) => [session.id, session.name || session.hostname || session.id])),
    [sessions],
  );
  const connected = isUsableConnection(context?.connection.status);
  const canCreate = connected && activeSessions.length > 0 && !isRefreshing && !loadError;

  const stopDescription = stopTarget ? stopTargetDescription(stopTarget, sessionNames) : "";
  const confirmStop = async (): Promise<boolean> => {
    if (!api || !stopTarget) return false;
    setIsStopping(true);
    try {
      const reverseSession = stopTarget.kind === "reverse-port-forward"
        ? selectedSessionForId(sessions, stopTarget.value.sessionId)
        : undefined;
      if (stopTarget.kind === "reverse-port-forward" && !reverseSession) {
        toast.danger("Could not stop forward", {
          description: "The listener session is no longer active; refresh the inventory.",
        });
        return false;
      }
      const result = stopTarget.kind === "port-forward"
        ? await api.stopPortForward(stopTarget.value.id)
        : stopTarget.kind === "socks5"
          ? await api.stopSocks5Proxy(stopTarget.value.id)
          : await api.stopReversePortForward({
              session: reverseSession!.ref,
              listenerId: stopTarget.value.listenerId,
              expectedBind: stopTarget.value.bind,
              expectedDestination: stopTarget.value.destination,
            });
      if (!result.ok) {
        toast.danger("Could not stop forward", { description: result.error });
        return false;
      }
      toast.success("Forward stopped");
      setStopTarget(undefined);
      await refresh(false);
      return true;
    } catch (error) {
      toast.danger("Could not stop forward", { description: errorMessage(error) });
      return false;
    } finally {
      setIsStopping(false);
    }
  };

  const content = (
    <AuxiliaryWindowFrame className="network-window-scroll overflow-y-auto bg-background">
      <div className="mx-auto flex min-h-full w-full max-w-[1480px] flex-col gap-6 px-5 pb-7 pt-[var(--auxiliary-window-content-top,1.75rem)] sm:px-8 sm:pb-9 sm:pt-[var(--auxiliary-window-content-top,2.25rem)]">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faNetworkWired} className="size-5" />
            </span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Network</h1>
                <ConnectionChip status={context?.connection.status} />
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                Route local traffic through active sessions and manage implant-side reverse listeners.
              </p>
              {context?.connection.server ? (
                <p className="mt-1 truncate font-mono text-xs text-muted">
                  {context.connection.operator ? `${context.connection.operator} · ` : ""}{context.connection.server}
                </p>
              ) : null}
            </div>
          </div>
          <Button
            isPending={isRefreshing}
            size="sm"
            variant="secondary"
            onPress={() => void refresh(true)}
          >
            <FontAwesomeIcon aria-hidden icon={faRotate} className="size-3" />
            Refresh
          </Button>
        </header>

        {loadError ? <Message tone="danger" title="Network inventory unavailable" detail={loadError} /> : null}
        {context?.sessions.error ? (
          <Message tone="warning" title="Session inventory incomplete" detail={context.sessions.error} />
        ) : null}
        {!connected && context ? (
          <Message
            tone="warning"
            title="Operator connection unavailable"
            detail="This window remains bound to its original backend and will resume when that connection recovers."
          />
        ) : null}

        {!context && isRefreshing ? (
          <div className="flex min-h-80 items-center justify-center gap-2 text-sm text-muted">
            <Spinner size="sm" /> Loading Network…
          </div>
        ) : (
          <Tabs
            className="network-window-tabs"
            selectedKey={selectedTab}
            variant="secondary"
            onSelectionChange={(key) => setSelectedTab(key as NetworkTabId)}
          >
            <Tabs.ListContainer className="network-window-tabs__nav max-w-full">
              <Tabs.List aria-label="Network forwarding features">
                <Tabs.Tab className="whitespace-nowrap" id="port-forward">
                  Port Forward
                  <Chip className="ml-1" size="sm" variant="soft">{snapshot?.portForwards.length ?? 0}</Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab className="whitespace-nowrap" id="reverse-port-forward">
                  Reverse Port Forward
                  <Chip className="ml-1" size="sm" variant="soft">{snapshot?.reversePortForwards.items.length ?? 0}</Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab className="whitespace-nowrap" id="socks5">
                  SOCKS5
                  <Chip className="ml-1" size="sm" variant="soft">{snapshot?.socks5Proxies.length ?? 0}</Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel className="pt-6" id="port-forward">
              <PortForwardPanel
                items={snapshot?.portForwards ?? []}
                sessionNames={sessionNames}
                canCreate={canCreate}
                onCreate={() => setCreateKind("port-forward")}
                onStop={(value) => setStopTarget({ kind: "port-forward", value })}
              />
            </Tabs.Panel>
            <Tabs.Panel className="pt-6" id="reverse-port-forward">
              <ReversePortForwardPanel
                inventory={snapshot?.reversePortForwards}
                sessionNames={sessionNames}
                canCreate={canCreate}
                onCreate={() => setCreateKind("reverse-port-forward")}
                onStop={(value) => setStopTarget({ kind: "reverse-port-forward", value })}
              />
            </Tabs.Panel>
            <Tabs.Panel className="pt-6" id="socks5">
              <Socks5Panel
                items={snapshot?.socks5Proxies ?? []}
                sessionNames={sessionNames}
                canCreate={canCreate}
                onCreate={() => setCreateKind("socks5")}
                onStop={(value) => setStopTarget({ kind: "socks5", value })}
              />
            </Tabs.Panel>
          </Tabs>
        )}
      </div>

      {api && createKind && activeSessions.length > 0 ? (
        <CreateForwardModal
          api={api}
          kind={createKind}
          sessions={activeSessions}
          onCreated={async () => {
            setCreateKind(undefined);
            await refresh(false);
          }}
          onOpenChange={(open) => { if (!open) setCreateKind(undefined); }}
        />
      ) : null}
      <ConfirmDialog
        isOpen={Boolean(stopTarget)}
        title={stopTarget ? stopTargetTitle(stopTarget) : "Stop forward?"}
        description={stopDescription}
        confirmLabel="Stop forward"
        isPending={isStopping}
        onOpenChange={(open) => { if (!open && !isStopping) setStopTarget(undefined); }}
        onConfirm={confirmStop}
      />
    </AuxiliaryWindowFrame>
  );

  return <ConnectionProvider connection={context?.connection}>{content}</ConnectionProvider>;
}

function PortForwardPanel({
  items,
  sessionNames,
  canCreate,
  onCreate,
  onStop,
}: {
  readonly items: readonly NetworkPortForwardSummary[];
  readonly sessionNames: ReadonlyMap<string, string>;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly onStop: (item: NetworkPortForwardSummary) => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<NetworkPortForwardSummary>[]>(() => [
    sessionColumn(sessionNames),
    endpointColumn("bind", "Local bind", (item) => item.bind),
    endpointColumn("destination", "Implant destination", (item) => item.destination),
    localStateColumn(),
    trafficColumn(),
    actionColumn("port forward", onStop, (item) => (
      `Stop port forward ${formatEndpoint(item.bind)} to ${formatEndpoint(item.destination)} through ${sessionNames.get(item.sessionId) ?? item.sessionId}`
    )),
  ], [onStop, sessionNames]);
  return (
    <InventoryCard
      title="Local port forwards"
      description="Accept TCP connections on this computer and open each destination from its chosen implant."
      icon={faArrowRightArrowLeft}
      createLabel="Add port forward"
      canCreate={canCreate}
      onCreate={onCreate}
    >
      <DataGrid
        aria-label="Local port forwards"
        columns={columns}
        contentClassName="min-w-[1040px]"
        data={[...items]}
        getRowId={(item) => item.id}
        scrollContainerClassName="max-h-[560px] overflow-auto"
        variant="secondary"
        renderEmptyState={() => <ForwardEmptyState icon={faArrowRightArrowLeft} title="No port forwards" detail="Start a local listener to route TCP traffic through a session." />}
      />
    </InventoryCard>
  );
}

function Socks5Panel({
  items,
  sessionNames,
  canCreate,
  onCreate,
  onStop,
}: {
  readonly items: readonly NetworkSocks5ProxySummary[];
  readonly sessionNames: ReadonlyMap<string, string>;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly onStop: (item: NetworkSocks5ProxySummary) => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<NetworkSocks5ProxySummary>[]>(() => [
    sessionColumn(sessionNames),
    endpointColumn("bind", "Local bind", (item) => item.bind),
    {
      id: "authentication",
      header: "Authentication",
      minWidth: 150,
      cell: (item) => <Chip size="sm" variant="soft">{item.authentication === "none" ? "None" : "Username + password"}</Chip>,
    },
    localStateColumn(),
    trafficColumn(),
    actionColumn("SOCKS5 proxy", onStop, (item) => (
      `Stop SOCKS5 proxy ${formatEndpoint(item.bind)} through ${sessionNames.get(item.sessionId) ?? item.sessionId}`
    )),
  ], [onStop, sessionNames]);
  return (
    <InventoryCard
      title="Local SOCKS5 proxies"
      description="Expose bounded SOCKS5 listeners backed by active Sliver sessions."
      icon={faRoute}
      createLabel="Add SOCKS5 proxy"
      canCreate={canCreate}
      onCreate={onCreate}
    >
      <DataGrid
        aria-label="Local SOCKS5 proxies"
        columns={columns}
        contentClassName="min-w-[1040px]"
        data={[...items]}
        getRowId={(item) => item.id}
        scrollContainerClassName="max-h-[560px] overflow-auto"
        variant="secondary"
        renderEmptyState={() => <ForwardEmptyState icon={faRoute} title="No SOCKS5 proxies" detail="Start a local proxy to route compatible applications through a session." />}
      />
    </InventoryCard>
  );
}

function ReversePortForwardPanel({
  inventory,
  sessionNames,
  canCreate,
  onCreate,
  onStop,
}: {
  readonly inventory: NetworkForwardingSnapshot["reversePortForwards"] | undefined;
  readonly sessionNames: ReadonlyMap<string, string>;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly onStop: (item: NetworkReversePortForwardSummary) => void;
}): React.JSX.Element {
  const columns = useMemo<DataGridColumn<NetworkReversePortForwardSummary>[]>(() => [
    {
      id: "listener",
      header: "Listener",
      minWidth: 92,
      cell: (item) => <span className="font-mono text-xs tabular-nums">#{item.listenerId}</span>,
    },
    sessionColumn(sessionNames),
    endpointColumn("bind", "Implant bind", (item) => item.bind),
    endpointColumn("destination", "Server destination", (item) => item.destination),
    {
      id: "status",
      header: "Status",
      minWidth: 112,
      cell: () => <Chip color="success" size="sm" variant="soft">Listening</Chip>,
    },
    actionColumn("reverse port forward", onStop, (item) => (
      `Stop reverse port forward ${formatEndpoint(item.bind)} to ${formatEndpoint(item.destination)} through ${sessionNames.get(item.sessionId) ?? item.sessionId}`
    )),
  ], [onStop, sessionNames]);
  return (
    <div className="space-y-4">
      {inventory?.status === "error" ? (
        <Message tone="warning" title="Reverse inventory incomplete" detail={inventory.error ?? "Refresh and try again."} />
      ) : null}
      <InventoryCard
        title="Reverse port forwards"
        description="Listen on the implant and relay each connection to a destination reachable from the teamserver."
        icon={faArrowsLeftRightToLine}
        createLabel="Add reverse port forward"
        canCreate={canCreate}
        onCreate={onCreate}
      >
        <DataGrid
          aria-label="Reverse port forwards"
          columns={columns}
          contentClassName="min-w-[940px]"
          data={[...(inventory?.items ?? [])]}
          getRowId={(item) => `${item.sessionId}:${item.listenerId}`}
          scrollContainerClassName="max-h-[560px] overflow-auto"
          variant="secondary"
          renderEmptyState={() => <ForwardEmptyState icon={faArrowsLeftRightToLine} title="No reverse port forwards" detail="Create an implant-side listener for an active session." />}
        />
      </InventoryCard>
    </div>
  );
}

function InventoryCard({
  title,
  description,
  icon,
  createLabel,
  canCreate,
  onCreate,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly icon: typeof faRoute;
  readonly createLabel: string;
  readonly canCreate: boolean;
  readonly onCreate: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Card className="overflow-hidden" variant="secondary">
      <Card.Header className="flex-row items-center gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-default text-muted">
          <FontAwesomeIcon aria-hidden icon={icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title>{title}</Card.Title>
          <Card.Description>{description}</Card.Description>
        </div>
        <Button isDisabled={!canCreate} size="sm" onPress={onCreate}>
          <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3" />
          {createLabel}
        </Button>
      </Card.Header>
      <Card.Content className="p-0">{children}</Card.Content>
    </Card>
  );
}

function CreateForwardModal({
  api,
  kind,
  sessions,
  onCreated,
  onOpenChange,
}: {
  readonly api: NetworkForwardingAPI;
  readonly kind: CreateKind;
  readonly sessions: readonly NetworkSessionEntry[];
  readonly onCreated: () => void | Promise<void>;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const isReverse = kind === "reverse-port-forward";
  const isSocks = kind === "socks5";
  const [selectedSessionId, setSelectedSessionId] = useState(sessions[0]?.session.id ?? "");
  const session = selectedSessionForId(sessions, selectedSessionId);
  const [bindHost, setBindHost] = useState<string>(isReverse
    ? NETWORK_FORWARDING_DEFAULTS.reverseBindHost
    : NETWORK_FORWARDING_DEFAULTS.localBindHost);
  const [bindPort, setBindPort] = useState<number>(isReverse ? 8080 : NETWORK_FORWARDING_DEFAULTS.localBindPort);
  const [destinationHost, setDestinationHost] = useState<string>("127.0.0.1");
  const [destinationPort, setDestinationPort] = useState<number>(80);
  const [keepAliveSeconds, setKeepAliveSeconds] = useState<number>(NETWORK_FORWARDING_DEFAULTS.keepAliveSeconds);
  const [connectTimeoutSeconds, setConnectTimeoutSeconds] = useState<number>(NETWORK_FORWARDING_DEFAULTS.connectTimeoutSeconds);
  const [closeTimeoutSeconds, setCloseTimeoutSeconds] = useState<number>(NETWORK_FORWARDING_DEFAULTS.closeTimeoutSeconds);
  const [maxConnections, setMaxConnections] = useState<number>(isSocks
    ? NETWORK_FORWARDING_DEFAULTS.socks5Connections
    : NETWORK_FORWARDING_DEFAULTS.portForwardConnections);
  const [bufferKib, setBufferKib] = useState<number>(isSocks
    ? NETWORK_FORWARDING_DEFAULTS.socks5BufferBytes / 1024
    : NETWORK_FORWARDING_DEFAULTS.portForwardBufferBytes / 1024);
  const [authenticationEnabled, setAuthenticationEnabled] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    if (session) return;
    setSelectedSessionId(sessions[0]?.session.id ?? "");
  }, [session, sessions]);

  const start = async (): Promise<void> => {
    if (isStarting) return;
    if (!session) {
      setFormError("Select an active session.");
      return;
    }
    setIsStarting(true);
    setFormError(undefined);
    try {
      const bind = { host: bindHost, port: bindPort };
      const result = kind === "port-forward"
        ? await api.startPortForward(parseStartPortForwardInput({
            session: session.ref,
            bind,
            destination: { host: destinationHost, port: destinationPort },
            keepAliveSeconds,
            connectTimeoutSeconds,
            closeTimeoutSeconds,
            maxConnections,
            maxBufferedBytesPerConnection: bufferKib * 1024,
          }))
        : kind === "reverse-port-forward"
          ? await api.startReversePortForward(parseStartReversePortForwardInput({
              session: session.ref,
              bind,
              destination: { host: destinationHost, port: destinationPort },
              keepAliveSeconds,
            }))
          : await api.startSocks5Proxy(parseStartSocks5ProxyInput({
              session: session.ref,
              bind,
              ...(authenticationEnabled ? { authentication: { username, password } } : {}),
              connectTimeoutSeconds,
              closeTimeoutSeconds,
              maxConnections,
              maxBufferedBytesPerConnection: bufferKib * 1024,
            }));
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      toast.success(`${createTitle(kind)} started`, {
        description: formatEndpoint(result.value?.bind ?? null),
      });
      await onCreated();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setPassword("");
      setIsStarting(false);
    }
  };

  return (
    <Modal.Backdrop isOpen variant="blur" onOpenChange={(open) => { if (!isStarting) onOpenChange(open); }}>
      <Modal.Container placement="center" scroll="inside" size="lg">
        <Modal.Dialog className="sm:max-w-[760px]">
          <form className="contents" onSubmit={(event) => { event.preventDefault(); void start(); }}>
            <Modal.CloseTrigger isDisabled={isStarting} />
            <Modal.Header className="flex-row items-start pr-10">
              <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                <FontAwesomeIcon aria-hidden icon={kind === "socks5" ? faRoute : kind === "reverse-port-forward" ? faArrowsLeftRightToLine : faArrowRightArrowLeft} className="size-4" />
              </Modal.Icon>
              <div className="min-w-0">
                <Modal.Heading>{createTitle(kind)}</Modal.Heading>
                <p className="mt-0.5 text-xs font-normal leading-5 text-muted">
                  Choose the active session and configure the forwarding endpoints.
                </p>
              </div>
            </Modal.Header>
            <Modal.Body className="flex flex-col gap-5">
              {formError ? <Message tone="danger" title="Could not start forward" detail={formError} /> : null}
              <section className="space-y-3">
                <SectionLabel icon={faNetworkWired} title="Target session" />
                <Select
                  fullWidth
                  isRequired
                  value={selectedSessionId}
                  variant="secondary"
                  onChange={(value) => {
                    if (value !== null) setSelectedSessionId(String(value));
                  }}
                >
                  <Label>Session</Label>
                  <Select.Trigger>
                    <Select.Value>
                      {session ? sessionLabel(session) : "Select an active session"}
                    </Select.Value>
                    <Select.Indicator><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3" /></Select.Indicator>
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {sessions.map((entry) => (
                        <ListBox.Item id={entry.session.id} key={entry.session.id} textValue={sessionLabel(entry)}>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{entry.session.name || entry.session.hostname || entry.session.id}</p>
                            <p className="truncate text-xs text-muted">{entry.session.username} · {entry.session.os}/{entry.session.arch}</p>
                          </div>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                  <Description>The selected session opens the remote side of this route.</Description>
                </Select>
              </section>
              <section className="space-y-3">
                <SectionLabel icon={isReverse ? faGlobe : faNetworkWired} title={isReverse ? "Implant listener" : "Local listener"} />
                <AddressFields
                  host={bindHost}
                  hostLabel={isReverse ? "Implant bind host" : "Local bind host"}
                  port={bindPort}
                  portLabel={isReverse ? "Implant bind port" : "Local bind port"}
                  allowZeroPort={!isReverse}
                  onHostChange={setBindHost}
                  onPortChange={setBindPort}
                />
              </section>
              {!isSocks ? (
                <section className="space-y-3">
                  <SectionLabel icon={faRoute} title={isReverse ? "Teamserver destination" : "Implant destination"} />
                  <AddressFields
                    host={destinationHost}
                    hostLabel="Destination host"
                    port={destinationPort}
                    portLabel="Destination port"
                    allowZeroPort={false}
                    onHostChange={setDestinationHost}
                    onPortChange={setDestinationPort}
                  />
                </section>
              ) : (
                <section className="space-y-3">
                  <Switch
                    className="flex w-full items-center rounded-xl bg-surface-secondary px-4 py-3"
                    isSelected={authenticationEnabled}
                    onChange={(enabled) => {
                      setAuthenticationEnabled(enabled);
                      if (!enabled) {
                        setUsername("");
                        setPassword("");
                      }
                    }}
                  >
                    <Switch.Content className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                        <FontAwesomeIcon aria-hidden icon={faShieldHalved} className="size-3.5 text-muted" />
                        Require authentication
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted">Clients must provide this username and password.</span>
                    </Switch.Content>
                    <Switch.Control className="ml-3 shrink-0"><Switch.Thumb /></Switch.Control>
                  </Switch>
                  {!authenticationEnabled && isWildcardBindHost(bindHost) ? (
                    <Message
                      tone="warning"
                      title="Unauthenticated network exposure"
                      detail="This wildcard listener accepts SOCKS5 connections from every reachable interface. Enable authentication or bind to a loopback address."
                    />
                  ) : null}
                  {authenticationEnabled ? (
                    <div className="space-y-2">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <TextControl label="Username" value={username} autoComplete="off" onChange={setUsername} />
                        <TextControl label="Password" value={password} type="password" autoComplete="new-password" onChange={setPassword} />
                      </div>
                      <p className="text-xs text-muted">Each credential may use up to 255 UTF-8 bytes.</p>
                    </div>
                  ) : null}
                </section>
              )}
              <Disclosure className="rounded-xl bg-surface-secondary">
                <Disclosure.Heading>
                  <Disclosure.Trigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground">
                    <span className="flex items-center gap-2"><FontAwesomeIcon aria-hidden icon={faGaugeHigh} className="size-3.5 text-muted" />Advanced</span>
                    <Disclosure.Indicator><FontAwesomeIcon aria-hidden icon={faChevronDown} className="size-3 text-muted" /></Disclosure.Indicator>
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
                    {!isSocks ? (
                      <NumberControl label="Keepalive seconds" value={keepAliveSeconds} minValue={-1} onChange={setKeepAliveSeconds} description="Use -1 to disable." />
                    ) : null}
                    {!isReverse ? (
                      <>
                        <NumberControl label="Connect timeout" value={connectTimeoutSeconds} minValue={1} maxValue={NETWORK_FORWARDING_LIMITS.operationTimeoutSeconds} onChange={setConnectTimeoutSeconds} />
                        <NumberControl label="Close timeout" value={closeTimeoutSeconds} minValue={1} maxValue={NETWORK_FORWARDING_LIMITS.operationTimeoutSeconds} onChange={setCloseTimeoutSeconds} />
                        <NumberControl label="Maximum connections" value={maxConnections} minValue={1} maxValue={isSocks ? NETWORK_FORWARDING_LIMITS.socks5Connections : NETWORK_FORWARDING_LIMITS.portForwardConnections} onChange={setMaxConnections} />
                        <NumberControl label="Buffer per connection (KiB)" value={bufferKib} minValue={1} maxValue={(isSocks ? NETWORK_FORWARDING_LIMITS.socks5BufferBytes : NETWORK_FORWARDING_LIMITS.portForwardBufferBytes) / 1024} onChange={setBufferKib} />
                      </>
                    ) : null}
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </Modal.Body>
            <Modal.Footer>
              <Button isDisabled={isStarting} type="button" variant="tertiary" onPress={() => onOpenChange(false)}>Cancel</Button>
              <Button isDisabled={!session} isPending={isStarting} type="submit">
                <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3" />
                Start
              </Button>
            </Modal.Footer>
          </form>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function AddressFields({
  host,
  hostLabel,
  port,
  portLabel,
  allowZeroPort,
  onHostChange,
  onPortChange,
}: {
  readonly host: string;
  readonly hostLabel: string;
  readonly port: number;
  readonly portLabel: string;
  readonly allowZeroPort: boolean;
  readonly onHostChange: (value: string) => void;
  readonly onPortChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px]">
      <TextControl label={hostLabel} value={host} onChange={onHostChange} />
      <NumberControl
        label={portLabel}
        value={port}
        minValue={allowZeroPort ? 0 : 1}
        maxValue={65_535}
        {...(allowZeroPort ? { description: "Use 0 for an automatic port." } : {})}
        onChange={onPortChange}
      />
    </div>
  );
}

function TextControl({
  label,
  value,
  type = "text",
  autoComplete = "off",
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly type?: "text" | "password";
  readonly autoComplete?: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <TextField fullWidth isRequired value={value} variant="secondary" onChange={onChange}>
      <Label>{label}</Label>
      <Input
        autoComplete={autoComplete}
        maxLength={type === "password" ? NETWORK_FORWARDING_LIMITS.socks5CredentialBytes : NETWORK_FORWARDING_LIMITS.hostCharacters}
        type={type}
      />
    </TextField>
  );
}

function NumberControl({
  label,
  value,
  minValue,
  maxValue,
  description,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly minValue: number;
  readonly maxValue?: number;
  readonly description?: string;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <NumberField
      commitBehavior="validate"
      fullWidth
      formatOptions={{ useGrouping: false }}
      isRequired
      minValue={minValue}
      {...(maxValue === undefined ? {} : { maxValue })}
      step={1}
      value={value}
      variant="secondary"
      onChange={(next) => onChange(Number.isFinite(next) ? next : minValue)}
    >
      <Label>{label}</Label>
      <NumberField.Group className="grid-cols-1"><NumberField.Input /></NumberField.Group>
      {description ? <Description>{description}</Description> : null}
    </NumberField>
  );
}

function SectionLabel({ icon, title }: { readonly icon: typeof faGlobe; readonly title: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <FontAwesomeIcon aria-hidden icon={icon} className="size-3.5 text-muted" />
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
    </div>
  );
}

function ForwardEmptyState({
  icon,
  title,
  detail,
}: {
  readonly icon: typeof faRoute;
  readonly title: string;
  readonly detail: string;
}): React.JSX.Element {
  return (
    <EmptyState className="py-14" size="sm">
      <EmptyState.Media><FontAwesomeIcon aria-hidden icon={icon} /></EmptyState.Media>
      <EmptyState.Content>
        <EmptyState.Title>{title}</EmptyState.Title>
        <EmptyState.Description>{detail}</EmptyState.Description>
      </EmptyState.Content>
    </EmptyState>
  );
}

function Message({
  tone,
  title,
  detail,
}: {
  readonly tone: "danger" | "warning";
  readonly title: string;
  readonly detail: string;
}): React.JSX.Element {
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 ${tone === "danger" ? "border-danger/25 bg-danger-soft text-danger-soft-foreground" : "border-warning/25 bg-warning-soft text-warning-soft-foreground"}`} role={tone === "danger" ? "alert" : "status"}>
      <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="mt-0.5 size-3.5 shrink-0" />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs leading-5 opacity-85">{detail}</p>
      </div>
    </div>
  );
}

function ConnectionChip({ status }: { readonly status: ConnectionStatus | undefined }): React.JSX.Element {
  const color = status === "connected" ? "success" : status === "degraded" || status === "reconnecting" ? "warning" : "default";
  return <Chip color={color} size="sm" variant="soft">{connectionLabel(status)}</Chip>;
}

function sessionColumn<T extends { readonly sessionId: string }>(
  sessionNames: ReadonlyMap<string, string>,
): DataGridColumn<T> {
  return {
    id: "session",
    header: "Session",
    isRowHeader: true,
    minWidth: 170,
    cell: (item) => (
      <div className="min-w-0">
        <p className="max-w-[220px] truncate text-sm font-medium text-foreground">{sessionNames.get(item.sessionId) ?? item.sessionId}</p>
        <p className="max-w-[220px] truncate font-mono text-[11px] text-muted">{item.sessionId}</p>
      </div>
    ),
  };
}

function endpointColumn<T>(
  id: string,
  header: string,
  value: (item: T) => { readonly host: string; readonly port: number } | null,
): DataGridColumn<T> {
  return {
    id,
    header,
    minWidth: 180,
    cell: (item) => <span className="font-mono text-xs tabular-nums text-foreground">{formatEndpoint(value(item))}</span>,
  };
}

function localStateColumn<T extends { readonly state: NetworkPortForwardSummary["state"] }>(): DataGridColumn<T> {
  return {
    id: "state",
    header: "State",
    minWidth: 160,
    cell: (item) => (
      <div className="space-y-1">
        <Chip color={stateColor(item.state.status)} size="sm" variant="soft">{titleCase(item.state.status)}</Chip>
        <p className="text-[11px] tabular-nums text-muted">{item.state.activeConnections} active · {item.state.totalConnections} total</p>
        {item.state.reason ? <p className="text-[11px] text-muted">{titleCase(item.state.reason)}</p> : null}
      </div>
    ),
  };
}

function trafficColumn<T extends { readonly state: NetworkPortForwardSummary["state"] }>(): DataGridColumn<T> {
  return {
    id: "traffic",
    header: "Traffic",
    minWidth: 145,
    cell: (item) => (
      <div className="font-mono text-[11px] leading-5 tabular-nums text-muted">
        <p>↑ {formatBytes(item.state.bytesToTarget)}</p>
        <p>↓ {formatBytes(item.state.bytesFromTarget)}</p>
      </div>
    ),
  };
}

function actionColumn<T>(
  label: string,
  onStop: (item: T) => void,
  accessibleName: (item: T) => string,
): DataGridColumn<T> {
  return {
    id: "actions",
    header: <span className="sr-only">Actions</span>,
    align: "center",
    width: 68,
    minWidth: 68,
    maxWidth: 68,
    cell: (item) => (
      <Tooltip delay={250}>
        <Button aria-label={accessibleName(item)} isIconOnly size="sm" variant="danger-soft" onPress={() => onStop(item)}>
          <FontAwesomeIcon aria-hidden icon={faStop} className="size-3" />
        </Button>
        <Tooltip.Content>Stop {label}</Tooltip.Content>
      </Tooltip>
    ),
  };
}

function selectedSessionForId(
  sessions: readonly NetworkSessionEntry[],
  sessionId: string,
): NetworkSessionEntry | undefined {
  return sessions.find(({ session }) => session.id === sessionId && session.liveness === "active");
}

function stopTargetTitle(target: StopTarget): string {
  return target.kind === "port-forward"
    ? "Stop port forward?"
    : target.kind === "socks5"
      ? "Stop SOCKS5 proxy?"
      : `Stop reverse listener #${target.value.listenerId}?`;
}

function stopTargetDescription(target: StopTarget, sessions: ReadonlyMap<string, string>): string {
  const session = sessions.get(target.value.sessionId) ?? target.value.sessionId;
  if (target.kind === "reverse-port-forward") {
    return `${session}: ${formatEndpoint(target.value.bind)} on the implant to ${formatEndpoint(target.value.destination)} on the teamserver. Active connections may be interrupted.`;
  }
  if (target.kind === "socks5") {
    return `${session}: stop the local SOCKS5 listener at ${formatEndpoint(target.value.bind)}. Active connections will close.`;
  }
  return `${session}: stop ${formatEndpoint(target.value.bind)} to ${formatEndpoint(target.value.destination)}. Active connections will close.`;
}

function createTitle(kind: CreateKind): string {
  return kind === "port-forward"
    ? "Port Forward"
    : kind === "reverse-port-forward"
      ? "Reverse Port Forward"
      : "SOCKS5 Proxy";
}

function sessionLabel(entry: NetworkSessionEntry): string {
  const name = entry.session.name || entry.session.hostname || entry.session.id;
  return `${name} · ${entry.session.username}@${entry.session.hostname}`;
}

function formatEndpoint(value: { readonly host: string; readonly port: number } | null): string {
  if (!value) return "Legacy metadata unavailable";
  const host = value.host.includes(":") ? `[${value.host}]` : value.host;
  return `${host}:${value.port}`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / 1024 ** exponent;
  return `${amount >= 10 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`;
}

function stateColor(status: NetworkPortForwardSummary["state"]["status"]): "success" | "warning" | "danger" | "default" {
  if (status === "listening") return "success";
  if (status === "starting" || status === "closing") return "warning";
  if (status === "failed") return "danger";
  return "default";
}

function connectionLabel(status: ConnectionStatus | undefined): string {
  if (!status) return "Loading";
  return titleCase(status);
}

function isUsableConnection(status: ConnectionStatus | undefined): boolean {
  return status === "connected" || status === "degraded" || status === "reconnecting";
}

function isWildcardBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]";
}

function titleCase(value: string): string {
  return value.replaceAll("-", " ").replace(/^./u, (first) => first.toLocaleUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
