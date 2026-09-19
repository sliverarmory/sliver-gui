import type { Selection } from "@heroui/react";
import {
  Button,
  Chip,
  Header,
  Label,
  ListBox,
  Modal,
  ScrollShadow,
  Spinner,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faCheck,
  faCircleExclamation,
  faGlobe,
  faLock,
  faNetworkWired,
  faSatelliteDish,
  faTowerBroadcast,
  faTriangleExclamation,
} from "@fortawesome/free-solid-svg-icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  LocalNetworkInterfaceInventory,
  ManagedServerReference,
  NetworkInterfaceAddressScope,
  SliverSnapshot,
} from "../../../shared/contracts";
import {
  listenerEndpointAlreadyAdded,
  listenerEndpointOptions,
  listenerProtocolLabel,
  resolveManagedWildcardListenerEndpoint,
  resolveWildcardListenerEndpoints,
  type ListenerEndpointOption,
  type ListenerInterfaceEndpointOption,
  type ListenerEndpointProtocol,
} from "../pages/generate-listener-endpoint";

export interface ListenerEndpointSelectorProps {
  isOpen: boolean;
  jobs: SliverSnapshot["domains"]["jobs"];
  currentC2: string;
  connectionIncarnation: number | undefined;
  connectionServer: string | undefined;
  managedServer: ManagedServerReference | null;
  targetOs: string;
  onOpenChange: (isOpen: boolean) => void;
  onAddEndpoint: (endpoint: string) => void;
}

const protocolIcons: Record<ListenerEndpointProtocol, typeof faGlobe> = {
  dns: faGlobe,
  http: faGlobe,
  https: faLock,
  mtls: faSatelliteDish,
  wireguard: faTowerBroadcast,
};

const EMPTY_INTERFACE_OPTIONS: readonly ListenerInterfaceEndpointOption[] = [];

export function ListenerEndpointSelector({
  isOpen,
  jobs,
  currentC2,
  connectionIncarnation,
  connectionServer,
  managedServer,
  targetOs,
  onOpenChange,
  onAddEndpoint,
}: ListenerEndpointSelectorProps): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedInterfaceId, setSelectedInterfaceId] = useState<string | null>(null);
  const [interfaceInventory, setInterfaceInventory] = useState<InterfaceInventoryState>({
    status: "idle",
  });
  const interfaceRequest = useRef(0);
  const jobsReady = jobs.status === "ready" || jobs.status === "empty";
  const options = useMemo(
    () => (jobs.status === "ready" ? listenerEndpointOptions(jobs.items) : []),
    [jobs.items, jobs.status],
  );
  const hasWildcardListener = useMemo(
    () => options.some((option) => option.wildcardBinding !== undefined),
    [options],
  );
  const isAdded = useCallback(
    (option: ListenerEndpointOption) =>
      Boolean(
        option.endpoint && listenerEndpointAlreadyAdded(currentC2, option.endpoint, targetOs),
      ),
    [currentC2, targetOs],
  );

  useEffect(() => {
    if (!isOpen) return;
    setSelectedId((current) => {
      const currentOption = options.find((option) => option.id === current);
      if (currentOption?.wildcardBinding || (currentOption?.endpoint && !isAdded(currentOption))) {
        return current;
      }
      return options.find((option) => option.wildcardBinding || (option.endpoint && !isAdded(option)))?.id ?? null;
    });
  }, [isAdded, isOpen, options]);

  useEffect(() => {
    if (!isOpen || !hasWildcardListener || managedServer) {
      interfaceRequest.current += 1;
      setInterfaceInventory({ status: "idle" });
      return;
    }

    const request = ++interfaceRequest.current;
    setInterfaceInventory({ status: "loading" });
    void (async () => {
      try {
        const result = await window.sliver.listLocalNetworkInterfaces();
        if (request !== interfaceRequest.current) return;
        if (!result.ok || !result.value) {
          setInterfaceInventory({
            status: "error",
            error: result.error ?? "Unable to read this machine's network interfaces.",
          });
          return;
        }
        setInterfaceInventory({ status: "ready", value: result.value });
      } catch (error: unknown) {
        if (request !== interfaceRequest.current) return;
        setInterfaceInventory({
          status: "error",
          error: error instanceof Error ? error.message : "Unable to read this machine's network interfaces.",
        });
      }
    })();

    return () => {
      if (request === interfaceRequest.current) interfaceRequest.current += 1;
    };
  }, [connectionIncarnation, hasWildcardListener, isOpen, jobs.revision, managedServer]);

  const selectedOption = useMemo(
    () => options.find((option) => option.id === selectedId),
    [options, selectedId],
  );
  const interfaceResolution = useMemo(
    () => {
      if (!selectedOption?.wildcardBinding) return undefined;
      if (managedServer) {
        return resolveManagedWildcardListenerEndpoint(
          selectedOption,
          managedServer.overview?.publicIpAddress,
        );
      }
      return interfaceInventory.status === "ready"
        ? resolveWildcardListenerEndpoints(selectedOption, interfaceInventory.value, connectionServer)
        : undefined;
    },
    [connectionServer, interfaceInventory, managedServer, selectedOption],
  );
  const interfaceOptions = interfaceResolution?.options ?? EMPTY_INTERFACE_OPTIONS;

  useEffect(() => {
    if (!isOpen || !selectedOption?.wildcardBinding || !interfaceResolution) {
      setSelectedInterfaceId(null);
      return;
    }
    setSelectedInterfaceId((current) => {
      const currentOption = interfaceOptions.find((option) => option.id === current);
      if (currentOption && !listenerEndpointAlreadyAdded(currentC2, currentOption.endpoint, targetOs)) {
        return current;
      }
      return interfaceOptions.find(
        (option) => !listenerEndpointAlreadyAdded(currentC2, option.endpoint, targetOs),
      )?.id ?? null;
    });
  }, [currentC2, interfaceOptions, interfaceResolution, isOpen, selectedOption, targetOs]);

  const selectedInterfaceOption = useMemo(
    () => interfaceOptions.find((option) => option.id === selectedInterfaceId),
    [interfaceOptions, selectedInterfaceId],
  );
  const selectedEndpoint = selectedOption?.endpoint ?? selectedInterfaceOption?.endpoint;
  const canAdd = Boolean(
    jobsReady &&
    selectedEndpoint &&
    !listenerEndpointAlreadyAdded(currentC2, selectedEndpoint, targetOs),
  );

  const handleSelectionChange = useCallback((selection: Selection) => {
    if (selection === "all") return;
    const key = selection.values().next().value;
    setSelectedId(key === undefined ? null : String(key));
    setSelectedInterfaceId(null);
  }, []);

  const handleInterfaceSelectionChange = useCallback((selection: Selection) => {
    if (selection === "all") return;
    const key = selection.values().next().value;
    setSelectedInterfaceId(key === undefined ? null : String(key));
  }, []);

  const addSelectedEndpoint = useCallback(() => {
    if (!selectedEndpoint || listenerEndpointAlreadyAdded(currentC2, selectedEndpoint, targetOs)) return;
    onAddEndpoint(selectedEndpoint);
    onOpenChange(false);
  }, [currentC2, onAddEndpoint, onOpenChange, selectedEndpoint, targetOs]);

  const addressSections = useMemo(
    () => ADDRESS_SECTIONS.map((section) => ({
      ...section,
      options: interfaceOptions.filter((option) => option.scope === section.scope),
    })).filter((section) => section.options.length > 0),
    [interfaceOptions],
  );

  return (
    <Modal.Backdrop
      isOpen={isOpen}
      variant="blur"
      onOpenChange={onOpenChange}
    >
      <Modal.Container placement="center" scroll="inside" size="md">
        <Modal.Dialog className="sm:max-w-[620px]">
          <Modal.CloseTrigger />
          <Modal.Header className="flex-row items-start pr-8">
            <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden icon={faTowerBroadcast} className="size-4" />
            </Modal.Icon>
            <div className="min-w-0 flex-1">
              <Modal.Heading>Add listener endpoint</Modal.Heading>
              <p className="mt-0.5 text-xs font-normal leading-relaxed text-muted">
                Choose an endpoint advertised by a running C2 listener. Untouched default content is replaced;
                edited or selected endpoints are kept.
              </p>
            </div>
          </Modal.Header>

          <Modal.Body className="gap-3">
            {jobs.status === "loading" ? (
              <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-center" role="status">
                <Spinner aria-label="Loading running listeners" />
                <div>
                  <p className="text-sm font-medium text-foreground">Loading running listeners</p>
                  <p className="mt-1 text-xs text-muted">Waiting for the connected server inventory.</p>
                </div>
              </div>
            ) : jobs.status === "error" ? (
              <InventoryMessage
                error
                title="Listeners could not be loaded"
                description={jobs.error ?? "Wait for the listener inventory to synchronize or reconnect before selecting an endpoint."}
              />
            ) : jobs.status === "unsupported" ? (
              <InventoryMessage
                error
                title="Listener inventory unavailable"
                description={jobs.error ?? "The connected server does not expose a compatible listener inventory."}
              />
            ) : jobs.status === "idle" ? (
              <InventoryMessage
                title="Listeners are not loaded"
                description="Wait for the listener inventory to synchronize or reconnect before selecting an endpoint."
              />
            ) : options.length === 0 ? (
              <EmptyState size="sm" className="min-h-64">
                <EmptyState.Header>
                  <EmptyState.Media variant="icon">
                    <FontAwesomeIcon aria-hidden icon={faTowerBroadcast} className="size-4" />
                  </EmptyState.Media>
                  <EmptyState.Title>No compatible C2 listeners</EmptyState.Title>
                  <EmptyState.Description className="max-w-sm">
                    Start a DNS, HTTP(S), or mTLS listener that advertises a usable callback address.
                  </EmptyState.Description>
                </EmptyState.Header>
              </EmptyState>
            ) : (
              <>
                {jobs.page.truncated ? (
                  <div className="flex items-start gap-2.5 rounded-xl bg-warning-soft px-3 py-2.5 text-xs text-warning-soft-foreground" role="status">
                    <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="mt-0.5 size-3.5 shrink-0" />
                    <p>Showing the first {jobs.page.limit} running jobs; additional listeners are not included.</p>
                  </div>
                ) : null}
                <ScrollShadow hideScrollBar className="max-h-[22rem] overflow-y-auto rounded-2xl bg-surface-secondary p-1">
                  <ListBox
                    aria-label="Running C2 listeners"
                    className="w-full"
                    selectedKeys={selectedId ? new Set([selectedId]) : new Set()}
                    selectionMode="single"
                    onAction={(key) => {
                      setSelectedId(String(key));
                      setSelectedInterfaceId(null);
                    }}
                    onSelectionChange={handleSelectionChange}
                  >
                    {options.map((option) => {
                      const alreadyAdded = isAdded(option);
                      const wildcard = option.wildcardBinding !== undefined;
                      const unavailable = !option.endpoint && !wildcard;
                      return (
                        <ListBox.Item
                          className="rounded-xl px-3 py-3 data-[selected=true]:bg-surface"
                          id={option.id}
                          isDisabled={unavailable || alreadyAdded}
                          key={option.id}
                          textValue={`${listenerProtocolLabel(option.protocol)} job ${option.jobId} ${
                            option.endpoint ??
                            (option.wildcardBinding
                              ? `wildcard ${option.wildcardBinding.family}`
                              : option.unavailableReason ?? "unavailable")
                          }`}
                        >
                          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                            <FontAwesomeIcon aria-hidden icon={protocolIcons[option.protocol]} className="size-3.5" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <Label className="text-sm font-semibold text-foreground">
                                Job #{option.jobId}
                              </Label>
                              <Chip size="sm" variant="soft">
                                <Chip.Label>{listenerProtocolLabel(option.protocol)}</Chip.Label>
                              </Chip>
                              {alreadyAdded ? (
                                <Chip color="success" size="sm" variant="soft">
                                  <Chip.Label>Added</Chip.Label>
                                </Chip>
                              ) : null}
                              {unavailable ? (
                                <Chip color="warning" size="sm" variant="soft">
                                  <Chip.Label>Unavailable</Chip.Label>
                                </Chip>
                              ) : null}
                              {wildcard ? (
                                <Chip size="sm" variant="soft">
                                  <Chip.Label>Wildcard</Chip.Label>
                                </Chip>
                              ) : null}
                            </div>
                            {option.endpoint ? (
                              <p className="mt-1 break-all font-mono text-xs text-foreground">
                                {option.endpoint}
                              </p>
                            ) : null}
                            <p className="mt-1 text-[11px] leading-relaxed text-muted">
                              {wildcard
                                ? `Bound to all ${option.wildcardBinding?.family} interfaces · choose a callback address below.`
                                : option.unavailableReason ?? option.description}
                            </p>
                          </div>
                          <ListBox.ItemIndicator className="shrink-0 text-accent">
                            {({ isSelected }) => isSelected ? (
                              <FontAwesomeIcon aria-hidden icon={faCheck} className="size-3.5" />
                            ) : null}
                          </ListBox.ItemIndicator>
                        </ListBox.Item>
                      );
                    })}
                  </ListBox>
                </ScrollShadow>
                {selectedOption?.wildcardBinding ? (
                  <section aria-labelledby="listener-callback-address-heading" className="space-y-2 pt-1">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground" id="listener-callback-address-heading">
                        Callback address
                      </h3>
                      <p className="mt-0.5 text-xs text-muted">
                        {managedServer
                          ? `Public IP reported for ${managedServer.name}.`
                          : "Addresses configured on the machine running this GUI, ordered by routability."}
                      </p>
                    </div>

                    {!managedServer && (interfaceInventory.status === "idle" || interfaceInventory.status === "loading") ? (
                      <div className="flex items-center gap-2.5 rounded-xl bg-default px-3 py-3 text-xs text-muted" role="status">
                        <Spinner aria-label="Loading configured network interfaces" size="sm" />
                        <p>Loading configured network interfaces…</p>
                      </div>
                    ) : !managedServer && interfaceInventory.status === "error" ? (
                      <InterfaceMessage error message={interfaceInventory.error} />
                    ) : interfaceResolution?.unavailableReason ? (
                      <InterfaceMessage message={interfaceResolution.unavailableReason} />
                    ) : (
                      <ScrollShadow hideScrollBar className="max-h-64 overflow-y-auto rounded-2xl bg-surface-secondary p-1">
                        <ListBox
                          aria-label="Callback address"
                          className="w-full"
                          selectedKeys={selectedInterfaceId ? new Set([selectedInterfaceId]) : new Set()}
                          selectionMode="single"
                          onAction={(key) => setSelectedInterfaceId(String(key))}
                          onSelectionChange={handleInterfaceSelectionChange}
                        >
                          {addressSections.map((section) => (
                            <ListBox.Section key={section.scope}>
                              <Header className="px-3 pb-1 pt-2 text-[11px] font-semibold text-muted">
                                {section.label}
                              </Header>
                              {section.options.map((option) => (
                                <InterfaceEndpointItem
                                  currentC2={currentC2}
                                  key={option.id}
                                  option={option}
                                  targetOs={targetOs}
                                />
                              ))}
                            </ListBox.Section>
                          ))}
                        </ListBox>
                      </ScrollShadow>
                    )}
                  </section>
                ) : null}
              </>
            )}
          </Modal.Body>

          <Modal.Footer>
            <Button variant="tertiary" onPress={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button isDisabled={!canAdd} onPress={addSelectedEndpoint}>
              Add endpoint
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

type InterfaceInventoryState =
  | { status: "idle" | "loading" }
  | { status: "ready"; value: LocalNetworkInterfaceInventory }
  | { status: "error"; error: string };

const ADDRESS_SECTIONS: ReadonlyArray<{
  scope: NetworkInterfaceAddressScope;
  label: string;
}> = [
  { scope: "global", label: "Globally routable" },
  { scope: "private", label: "Private" },
  { scope: "loopback", label: "Localhost" },
];

function InterfaceEndpointItem({
  option,
  currentC2,
  targetOs,
}: {
  option: ListenerInterfaceEndpointOption;
  currentC2: string;
  targetOs: string;
}): React.JSX.Element {
  const alreadyAdded = listenerEndpointAlreadyAdded(currentC2, option.endpoint, targetOs);
  return (
    <ListBox.Item
      className="rounded-xl px-3 py-2.5 data-[selected=true]:bg-surface"
      id={option.id}
      isDisabled={alreadyAdded}
      textValue={`${option.endpoint} ${option.interfaceName} ${interfaceScopeLabel(option.scope)} ${option.family}`}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-default text-muted">
        <FontAwesomeIcon aria-hidden icon={faNetworkWired} className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <Label className="break-all font-mono text-xs text-foreground">{option.endpoint}</Label>
        <p className="mt-1 text-[11px] text-muted">
          {option.interfaceName} · {interfaceScopeLabel(option.scope)} {option.family}
        </p>
      </div>
      {alreadyAdded ? (
        <Chip color="success" size="sm" variant="soft">
          <Chip.Label>Added</Chip.Label>
        </Chip>
      ) : null}
      <ListBox.ItemIndicator className="shrink-0 text-accent">
        {({ isSelected }) => isSelected ? (
          <FontAwesomeIcon aria-hidden icon={faCheck} className="size-3.5" />
        ) : null}
      </ListBox.ItemIndicator>
    </ListBox.Item>
  );
}

function InterfaceMessage({ message, error = false }: { message: string; error?: boolean }): React.JSX.Element {
  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-3 py-3 text-xs ${
        error
          ? "bg-danger-soft text-danger-soft-foreground"
          : "bg-warning-soft text-warning-soft-foreground"
      }`}
      role={error ? "alert" : "status"}
    >
      <FontAwesomeIcon
        aria-hidden
        icon={error ? faCircleExclamation : faTriangleExclamation}
        className="mt-0.5 size-3.5 shrink-0"
      />
      <p>{message}</p>
    </div>
  );
}

function interfaceScopeLabel(scope: NetworkInterfaceAddressScope): string {
  if (scope === "global") return "Public";
  if (scope === "private") return "Private";
  return "Loopback";
}

function InventoryMessage({
  title,
  description,
  error = false,
}: {
  title: string;
  description: string;
  error?: boolean;
}): React.JSX.Element {
  return (
    <div
      className="flex min-h-64 flex-col items-center justify-center px-6 text-center"
      role={error ? "alert" : "status"}
    >
      <span className={`grid size-10 place-items-center rounded-xl ${error ? "bg-danger-soft text-danger-soft-foreground" : "bg-default text-muted"}`}>
        <FontAwesomeIcon aria-hidden icon={error ? faCircleExclamation : faTowerBroadcast} className="size-4" />
      </span>
      <p className="mt-3 text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm break-words text-xs leading-relaxed text-muted">{description}</p>
    </div>
  );
}
