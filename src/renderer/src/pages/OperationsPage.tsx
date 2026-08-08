import type { DataGridColumn } from "@heroui-pro/react/data-grid";
import { DataGrid } from "@heroui-pro/react/data-grid";
import {
  AlertDialog,
  Button,
  Chip,
  Description,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  NumberField,
  ScrollShadow,
  Select,
  TextField,
  Tooltip,
} from "@heroui/react";
import {
  faBolt,
  faCertificate,
  faCircleCheck,
  faCircleExclamation,
  faCircleNotch,
  faClockRotateLeft,
  faGlobe,
  faKey,
  faLock,
  faNetworkWired,
  faPlus,
  faRotate,
  faSatelliteDish,
  faServer,
  faShieldHalved,
  faStop,
  faTowerBroadcast,
  faWaveSquare,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type {
  CertificatePairSelection,
  JobSummary,
  RecentEventSummary,
  SliverSnapshot,
} from "../../../shared/contracts";
import { SwitchRow } from "../components/FormControls";
import {
  LISTENER_PROTOCOLS,
  LISTENER_PROTOCOL_BY_KIND,
  STAGE_COMPRESSION_OPTIONS,
  createListenerDraft,
  isListenerKind,
  isStageCompression,
  listenerInputFromDraft,
  validateListenerDraft,
  type ListenerDraft,
  type ListenerDraftErrors,
  type ListenerKind,
} from "./operations-listener";
import { nonBlankJobDomains, normalizedJobProtocol } from "./operations-job";

type ConfirmationTarget =
  | { kind: "job"; job: JobSummary }
  | { kind: "all"; count: number }
  | null;

interface Feedback {
  tone: "danger" | "success";
  message: string;
}

const EVENT_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const PROTOCOL_ICONS: Record<ListenerKind, typeof faServer> = {
  dns: faGlobe,
  http: faWaveSquare,
  https: faLock,
  mtls: faShieldHalved,
  stage: faNetworkWired,
  wireguard: faSatelliteDish,
};

export interface OperationsPageProps {
  snapshot: SliverSnapshot;
}

export function OperationsPage({ snapshot }: OperationsPageProps): React.JSX.Element {
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isChoosingCertificate, setIsChoosingCertificate] = useState(false);
  const [certificatePair, setCertificatePair] = useState<CertificatePairSelection | null>(null);
  const [draft, setDraft] = useState<ListenerDraft>(() => createListenerDraft());
  const [draftErrors, setDraftErrors] = useState<ListenerDraftErrors>({});
  const [confirmation, setConfirmation] = useState<ConfirmationTarget>(null);
  const [isStopping, setIsStopping] = useState(false);

  const jobs = snapshot.jobs;
  const profiles = snapshot.profiles;
  const recentEvents = snapshot.recentEvents;
  const isConnected = snapshot.connection.status === "connected";

  const openListenerDialog = useCallback(() => {
    setDraft(createListenerDraft("mtls", profiles[0]?.name ?? ""));
    setDraftErrors({});
    setCertificatePair(null);
    setFeedback(null);
    setIsCreateOpen(true);
  }, [profiles]);

  const requestStop = useCallback((job: JobSummary) => {
    setConfirmation({ kind: "job", job });
  }, []);

  const columns = useMemo<DataGridColumn<JobSummary>[]>(
    () => [
      {
        id: "id",
        header: "Job",
        accessorKey: "id",
        allowsSorting: true,
        minWidth: 76,
        sortFn: (left, right) => left.id - right.id,
        cell: (job) => (
          <span className="font-mono text-xs font-medium tabular-nums text-foreground">#{job.id}</span>
        ),
      },
      {
        id: "name",
        header: "Listener",
        accessorKey: "name",
        allowsSorting: true,
        isRowHeader: true,
        minWidth: 210,
        cell: (job) => (
          <div className="min-w-0 py-0.5">
            <p className="truncate text-sm font-medium text-foreground">{listenerName(job)}</p>
            <p className="max-w-[360px] truncate text-xs text-muted">
              {job.description || "Sliver listener"}
            </p>
          </div>
        ),
      },
      {
        id: "protocol",
        header: "Protocol",
        accessorKey: "protocol",
        allowsSorting: true,
        minWidth: 112,
        cell: (job) => {
          const protocol = normalizedJobProtocol(job);
          return (
            <Chip color={protocolColor(protocol)} size="sm" variant="soft">
              <Chip.Label>{protocolLabel(protocol)}</Chip.Label>
            </Chip>
          );
        },
      },
      {
        id: "endpoint",
        header: "Endpoint",
        minWidth: 150,
        cell: (job) => {
          const domains = nonBlankJobDomains(job);
          return (
            <div className="min-w-0 text-xs">
              {domains.length > 0 ? (
                <p className="max-w-[280px] truncate text-foreground" title={domains.join(", ")}>
                  {domains.join(", ")}
                </p>
              ) : (
                <p className="font-mono tabular-nums text-foreground">0.0.0.0:{job.port}</p>
              )}
              {domains.length > 0 && (
                <p className="font-mono tabular-nums text-muted">port {job.port}</p>
              )}
            </div>
          );
        },
      },
      {
        id: "profile",
        header: "Stage profile",
        accessorKey: "profileName",
        minWidth: 140,
        cell: (job) =>
          job.profileName ? (
            <span className="max-w-[220px] truncate font-mono text-xs text-foreground" title={job.profileName}>
              {job.profileName}
            </span>
          ) : (
            <span className="text-xs text-muted">—</span>
          ),
      },
      {
        id: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "end",
        minWidth: 72,
        pinned: "end",
        cell: (job) => (
          <Tooltip delay={250}>
            <Button
              aria-label={`Stop job ${job.id}`}
              isDisabled={isStopping}
              isIconOnly
              size="sm"
              variant="danger-soft"
              onPress={() => requestStop(job)}
            >
              <FontAwesomeIcon aria-hidden icon={faStop} className="size-3" />
            </Button>
            <Tooltip.Content>Stop job #{job.id}</Tooltip.Content>
          </Tooltip>
        ),
      },
    ],
    [isStopping, requestStop],
  );

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setFeedback(null);
    try {
      const result = await window.sliver.refresh();
      if (!result.ok) {
        setFeedback({ tone: "danger", message: result.error ?? "Unable to refresh operations." });
      } else {
        setFeedback({ tone: "success", message: "Jobs and listeners are up to date." });
      }
    } catch (error: unknown) {
      setFeedback({ tone: "danger", message: errorMessage(error) });
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const changeProtocol = useCallback(
    (kind: ListenerKind) => {
      setDraft((current) => ({
        ...createListenerDraft(kind, profiles[0]?.name ?? ""),
        host: current.host,
      }));
      setCertificatePair(null);
      setDraftErrors({});
    },
    [profiles],
  );

  const chooseCertificate = useCallback(async () => {
    setIsChoosingCertificate(true);
    setDraftErrors((current) => {
      const next = { ...current };
      delete next.certificateToken;
      return next;
    });
    try {
      const result = await window.sliver.chooseCertificatePair();
      if (!result.ok || !result.value) {
        setDraftErrors((current) => ({
          ...current,
          certificateToken: result.error ?? "Unable to load that certificate pair.",
        }));
        return;
      }
      const selectedPair = result.value;
      setCertificatePair(selectedPair);
      setDraft((current) => ({ ...current, certificateToken: selectedPair.token }));
    } catch (error: unknown) {
      setDraftErrors((current) => ({ ...current, certificateToken: errorMessage(error) }));
    } finally {
      setIsChoosingCertificate(false);
    }
  }, []);

  const startListener = useCallback(async () => {
    const errors = validateListenerDraft(draft);
    setDraftErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setIsStarting(true);
    try {
      const result = await window.sliver.startListener(listenerInputFromDraft(draft));
      if (!result.ok) {
        setDraftErrors({ form: result.error ?? "The Sliver server did not start the listener." });
        return;
      }

      const jobLabel = result.value ? ` as job #${result.value.id}` : "";
      const protocol = LISTENER_PROTOCOL_BY_KIND[draft.kind].shortLabel;
      setFeedback({ tone: "success", message: `${protocol} listener started${jobLabel}.` });
      setIsCreateOpen(false);
      setDraftErrors({});
      setCertificatePair(null);
    } catch (error: unknown) {
      setDraftErrors({ form: errorMessage(error) });
    } finally {
      setIsStarting(false);
    }
  }, [draft]);

  const confirmStop = useCallback(async () => {
    if (!confirmation) return;
    setIsStopping(true);
    setFeedback(null);
    try {
      const result =
        confirmation.kind === "all"
          ? await window.sliver.killAllJobs()
          : await window.sliver.killJob(confirmation.job.id);
      if (!result.ok) {
        setFeedback({ tone: "danger", message: result.error ?? "Unable to stop the selected job." });
        return;
      }

      setFeedback({
        tone: "success",
        message:
          confirmation.kind === "all"
            ? `${confirmation.count} ${confirmation.count === 1 ? "job" : "jobs"} stopped.`
            : `Job #${confirmation.job.id} stopped.`,
      });
      setConfirmation(null);
    } catch (error: unknown) {
      setFeedback({ tone: "danger", message: errorMessage(error) });
    } finally {
      setIsStopping(false);
    }
  }, [confirmation]);

  const stream = snapshot.eventStream;
  const selectedProtocol = LISTENER_PROTOCOL_BY_KIND[draft.kind];

  return (
    <section className="page-stack">
      <header className="page-heading">
        <div className="min-w-0">
          <div className="eyebrow flex-wrap">
            <FontAwesomeIcon aria-hidden icon={faTowerBroadcast} /> Operations
            <Chip color={connectionColor(snapshot.connection.status)} size="sm" variant="soft">
              <Chip.Label>{connectionLabel(snapshot.connection.status)}</Chip.Label>
            </Chip>
          </div>
          <h1>Jobs &amp; listeners</h1>
          <p>
            Start transport listeners, monitor server jobs, and respond to live gRPC events.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Tooltip delay={250}>
            <Button
              aria-label="Refresh jobs and listeners"
              isDisabled={!isConnected || isRefreshing}
              isIconOnly
              size="sm"
              variant="tertiary"
              onPress={() => void refresh()}
            >
              <FontAwesomeIcon
                aria-hidden
                icon={isRefreshing ? faCircleNotch : faRotate}
                className={`size-3.5 ${isRefreshing ? "animate-spin" : ""}`}
              />
            </Button>
            <Tooltip.Content>Refresh from server</Tooltip.Content>
          </Tooltip>
          <Button
            isDisabled={!isConnected}
            size="sm"
            variant="primary"
            onPress={openListenerDialog}
          >
            <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3" />
            New listener
          </Button>
        </div>
      </header>

      {feedback && (
        <div
          aria-live="polite"
          className={`flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-sm ${
            (feedback?.tone ?? "danger") === "danger"
              ? "border-danger/25 bg-danger-soft text-danger-soft-foreground"
              : "border-success/25 bg-success-soft text-success-soft-foreground"
          }`}
          role={(feedback?.tone ?? "danger") === "danger" ? "alert" : "status"}
        >
          <FontAwesomeIcon
            aria-hidden
            icon={(feedback?.tone ?? "danger") === "danger" ? faCircleExclamation : faCircleCheck}
            className="mt-0.5 size-3.5 shrink-0"
          />
          <p>{feedback.message}</p>
        </div>
      )}

      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 overflow-hidden rounded-2xl border border-separator bg-surface">
          <div className="flex flex-col gap-3 border-b border-separator px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-soft-foreground">
                <FontAwesomeIcon aria-hidden icon={faTowerBroadcast} className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Active server jobs</h2>
                <p className="text-xs text-muted">
                  {jobs.length} {jobs.length === 1 ? "listener" : "listeners"} on this backend
                </p>
              </div>
            </div>
            <Button
              isDisabled={!isConnected || jobs.length === 0 || isStopping}
              size="sm"
              variant="danger-soft"
              onPress={() => setConfirmation({ kind: "all", count: jobs.length })}
            >
              <FontAwesomeIcon aria-hidden icon={faStop} className="size-3" />
              Stop all
            </Button>
          </div>

          <DataGrid
              aria-label="Active Sliver jobs"
              columns={columns}
              contentClassName="min-w-[780px]"
              data={jobs}
              defaultSortDescriptor={{ column: "id", direction: "ascending" }}
              getRowId={(job) => job.id}
              scrollContainerClassName="max-h-[620px] overflow-auto"
              variant="secondary"
              renderEmptyState={() => (
                <div className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
                  <span className="mb-3 grid size-10 place-items-center rounded-xl bg-default text-muted">
                    <FontAwesomeIcon aria-hidden icon={faNetworkWired} className="size-4" />
                  </span>
                  <p className="text-sm font-medium text-foreground">No active jobs</p>
                  <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted">
                    Start a listener to accept new Sliver connections on this backend.
                  </p>
                  <Button
                    className="mt-4"
                    isDisabled={!isConnected}
                    size="sm"
                    variant="secondary"
                    onPress={openListenerDialog}
                  >
                    <FontAwesomeIcon aria-hidden icon={faPlus} className="size-3" />
                    Start listener
                  </Button>
                </div>
              )}
          />
        </div>

        <aside className="min-w-0 self-start overflow-hidden rounded-2xl border border-separator bg-surface xl:sticky xl:top-0">
          <div className="flex items-center justify-between gap-3 border-b border-separator px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-default text-muted">
                <FontAwesomeIcon aria-hidden icon={faClockRotateLeft} className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-foreground">Recent events</h2>
                <p className="truncate text-xs text-muted">Live updates from the gRPC event stream</p>
              </div>
            </div>
            <Chip color={streamColor(stream?.status)} size="sm" variant="soft">
              <Chip.Label>{streamLabel(stream?.status)}</Chip.Label>
            </Chip>
          </div>

          {stream?.error && (
            <div className="border-b border-separator bg-warning-soft px-4 py-2.5 text-xs text-warning-soft-foreground">
              <p className="font-medium">
                Reconnect attempt {stream.attempt > 0 ? stream.attempt : 1}
              </p>
              <p className="mt-0.5 line-clamp-2 opacity-80">{stream.error}</p>
            </div>
          )}

          <ScrollShadow className="max-h-[560px] min-h-72" hideScrollBar={false} size={28}>
            {recentEvents.length > 0 ? (
              <ol aria-live="polite" aria-relevant="additions" className="divide-y divide-separator">
                {recentEvents.map((event) => (
                  <EventRow event={event} key={event.id} />
                ))}
              </ol>
            ) : (
              <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
                <span className="mb-3 grid size-10 place-items-center rounded-xl bg-default text-muted">
                  <FontAwesomeIcon aria-hidden icon={faBolt} className="size-4" />
                </span>
                <p className="text-sm font-medium text-foreground">Waiting for activity</p>
                <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted">
                  Job, session, beacon, and listener events will appear here in real time.
                </p>
              </div>
            )}
          </ScrollShadow>
        </aside>
      </div>

      <Modal.Backdrop
        isDismissable={!isStarting}
        isKeyboardDismissDisabled={isStarting}
        isOpen={isCreateOpen}
        variant="blur"
        onOpenChange={(isOpen) => {
          if (!isStarting) setIsCreateOpen(isOpen);
        }}
      >
        <Modal.Container placement="center" scroll="inside" size="lg">
          <Modal.Dialog className="sm:max-w-[760px]">
            <Modal.CloseTrigger isDisabled={isStarting} />
            <Modal.Header>
              <Modal.Icon className="bg-accent-soft text-accent-soft-foreground">
                <FontAwesomeIcon aria-hidden icon={PROTOCOL_ICONS[draft.kind]} className="size-4" />
              </Modal.Icon>
              <div>
                <Modal.Heading>Start a listener</Modal.Heading>
                <p className="mt-0.5 text-xs font-normal text-muted">{selectedProtocol.description}</p>
              </div>
            </Modal.Header>

            <Modal.Body className="flex flex-col gap-5">
              {draftErrors.form && (
                <div className="flex gap-2 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2.5 text-sm text-danger-soft-foreground" role="alert">
                  <FontAwesomeIcon aria-hidden icon={faCircleExclamation} className="mt-0.5 size-3.5 shrink-0" />
                  <p>{draftErrors.form}</p>
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Select
                  fullWidth
                  value={draft.kind}
                  variant="secondary"
                  onChange={(value) => {
                    if (isListenerKind(value)) changeProtocol(value);
                  }}
                >
                  <Label>Protocol</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {LISTENER_PROTOCOLS.map((protocol) => (
                        <ListBox.Item id={protocol.id} key={protocol.id} textValue={protocol.label}>
                          <span className="flex items-center gap-2">
                            <FontAwesomeIcon aria-hidden icon={PROTOCOL_ICONS[protocol.id]} className="size-3.5 text-muted" />
                            <span>{protocol.label}</span>
                          </span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <div className="hidden items-end sm:flex">
                  <div className="flex w-full items-center gap-2.5 rounded-xl bg-default px-3 py-2.5 text-xs text-muted">
                    <FontAwesomeIcon aria-hidden icon={PROTOCOL_ICONS[draft.kind]} className="size-3.5 shrink-0" />
                    <span>{selectedProtocol.description}</span>
                  </div>
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
                <TextControl
                  error={draftErrors.host}
                  label="Bind host"
                  placeholder="0.0.0.0"
                  value={draft.host}
                  onChange={(host) => setDraft((current) => ({ ...current, host }))}
                />
                <NumberControl
                  error={draftErrors.port}
                  label="Listener port"
                  maxValue={65_534}
                  minValue={1}
                  value={draft.port}
                  onChange={(port) => setDraft((current) => ({ ...current, port }))}
                />
              </div>

              <ProtocolFields
                certificatePair={certificatePair}
                draft={draft}
                errors={draftErrors}
                isChoosingCertificate={isChoosingCertificate}
                profiles={profiles.map((profile) => profile.name)}
                setDraft={setDraft}
                onChooseCertificate={() => void chooseCertificate()}
              />
            </Modal.Body>

            <Modal.Footer className="items-center justify-between gap-3">
              <p className="hidden text-xs text-muted sm:block">
                {draft.kind === "stage"
                  ? "The server generates the selected profile before binding the TCP listener."
                  : "The new job will appear as soon as the server confirms it."}
              </p>
              <div className="ml-auto flex items-center gap-2">
                <Button
                  isDisabled={isStarting}
                  size="sm"
                  variant="tertiary"
                  onPress={() => setIsCreateOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  isDisabled={!isConnected || isStarting}
                  size="sm"
                  variant="primary"
                  onPress={() => void startListener()}
                >
                  <FontAwesomeIcon
                    aria-hidden
                    icon={isStarting ? faCircleNotch : faTowerBroadcast}
                    className={`size-3 ${isStarting ? "animate-spin" : ""}`}
                  />
                  {isStarting ? "Starting…" : "Start listener"}
                </Button>
              </div>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <AlertDialog.Backdrop
        isOpen={confirmation !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen && !isStopping) setConfirmation(null);
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <FontAwesomeIcon aria-hidden icon={faStop} className="size-4" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>
                {confirmation?.kind === "all" ? "Stop all server jobs?" : "Stop this server job?"}
              </AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-relaxed text-muted">
                {confirmation?.kind === "all"
                  ? `This stops ${confirmation.count} active ${confirmation.count === 1 ? "listener" : "listeners"}. Existing implant sessions are not terminated, but they may lose their callback path.`
                  : confirmation
                    ? `Job #${confirmation.job.id} (${protocolLabel(normalizedJobProtocol(confirmation.job))}) will stop accepting traffic immediately.`
                    : "The selected job will be stopped."}
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={isStopping}
                size="sm"
                variant="tertiary"
                onPress={() => setConfirmation(null)}
              >
                Cancel
              </Button>
              <Button
                isDisabled={isStopping}
                size="sm"
                variant="danger"
                onPress={() => void confirmStop()}
              >
                <FontAwesomeIcon
                  aria-hidden
                  icon={isStopping ? faCircleNotch : faStop}
                  className={`size-3 ${isStopping ? "animate-spin" : ""}`}
                />
                {isStopping ? "Stopping…" : confirmation?.kind === "all" ? "Stop all" : "Stop job"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  );
}

interface ProtocolFieldsProps {
  certificatePair: CertificatePairSelection | null;
  draft: ListenerDraft;
  errors: ListenerDraftErrors;
  isChoosingCertificate: boolean;
  profiles: string[];
  setDraft: React.Dispatch<React.SetStateAction<ListenerDraft>>;
  onChooseCertificate: () => void;
}

function ProtocolFields({
  certificatePair,
  draft,
  errors,
  isChoosingCertificate,
  profiles,
  setDraft,
  onChooseCertificate,
}: ProtocolFieldsProps): ReactNode {
  switch (draft.kind) {
    case "mtls":
      return (
        <InfoStrip
          icon={faShieldHalved}
          title="Mutual authentication"
          description="Sliver provisions the listener certificate material and requires authenticated implant clients."
        />
      );

    case "wireguard":
      return (
        <div className="space-y-4">
          <SectionLabel icon={faSatelliteDish} title="WireGuard channels" />
          <div className="grid gap-4 sm:grid-cols-3">
            <TextControl
              error={errors.tunnelIp}
              label="Tunnel IP"
              placeholder="100.64.0.1"
              value={draft.tunnelIp}
              onChange={(tunnelIp) => setDraft((current) => ({ ...current, tunnelIp }))}
            />
            <NumberControl
              error={errors.tcpCommsPort}
              label="TCP comms port"
              maxValue={65_534}
              minValue={1}
              value={draft.tcpCommsPort}
              onChange={(tcpCommsPort) => setDraft((current) => ({ ...current, tcpCommsPort }))}
            />
            <NumberControl
              error={errors.keyExchangePort}
              label="Key exchange port"
              maxValue={65_534}
              minValue={1}
              value={draft.keyExchangePort}
              onChange={(keyExchangePort) => setDraft((current) => ({ ...current, keyExchangePort }))}
            />
          </div>
        </div>
      );

    case "dns":
      return (
        <div className="space-y-4">
          <SectionLabel icon={faGlobe} title="DNS transport" />
          <TextControl
            description="Separate multiple authoritative domains with commas or spaces. Trailing dots are added by the backend."
            error={errors.domains}
            label="Authoritative domains"
            placeholder="c2.example.com, fallback.example.net"
            value={draft.domains}
            onChange={(domains) => setDraft((current) => ({ ...current, domains }))}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <SwitchRow
              description="Reject callbacks that do not present a valid one-time token."
              selected={draft.enforceOtp}
              label="Enforce OTP"
              onChange={(enforceOtp) => setDraft((current) => ({ ...current, enforceOtp }))}
            />
            <SwitchRow
              description="Enable DNS canary behavior for this listener."
              selected={draft.canaries}
              label="DNS canaries"
              onChange={(canaries) => setDraft((current) => ({ ...current, canaries }))}
            />
          </div>
        </div>
      );

    case "http":
    case "https":
      return (
        <div className="space-y-4">
          <SectionLabel icon={draft.kind === "https" ? faLock : faWaveSquare} title="HTTP transport" />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextControl
              description={draft.kind === "https" && draft.acme ? "Required for ACME issuance." : undefined}
              error={errors.domain}
              label="Domain"
              placeholder="c2.example.com"
              value={draft.domain}
              onChange={(domain) => setDraft((current) => ({ ...current, domain }))}
            />
            <TextControl
              error={errors.website}
              label="Website profile"
              placeholder="Optional website name"
              value={draft.website}
              onChange={(website) => setDraft((current) => ({ ...current, website }))}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberControl
              description="Maximum server wait before returning a poll response."
              error={errors.longPollTimeoutSeconds}
              label="Long-poll timeout (s)"
              minValue={0}
              value={draft.longPollTimeoutSeconds}
              onChange={(longPollTimeoutSeconds) =>
                setDraft((current) => ({ ...current, longPollTimeoutSeconds }))
              }
            />
            <NumberControl
              description="Randomized delay added to long-poll responses."
              error={errors.longPollJitterSeconds}
              label="Long-poll jitter (s)"
              minValue={0}
              value={draft.longPollJitterSeconds}
              onChange={(longPollJitterSeconds) =>
                setDraft((current) => ({ ...current, longPollJitterSeconds }))
              }
            />
          </div>
          <div className={`grid gap-3 ${draft.kind === "https" ? "sm:grid-cols-3" : "sm:grid-cols-1"}`}>
            <SwitchRow
              description="Require one-time authentication for HTTP callbacks."
              selected={draft.enforceOtp}
              label="Enforce OTP"
              onChange={(enforceOtp) => setDraft((current) => ({ ...current, enforceOtp }))}
            />
            {draft.kind === "https" && (
              <>
                <SwitchRow
                  description="Request and manage a public TLS certificate with ACME."
                  selected={draft.acme}
                  label="ACME certificate"
                  onChange={(acme) => {
                    setDraft((current) => ({
                      ...current,
                      acme,
                      certificateToken: acme ? "" : current.certificateToken,
                    }));
                  }}
                />
                <SwitchRow
                  description="Randomize the listener's TLS JARM fingerprint."
                  selected={draft.randomizeJarm}
                  label="Randomize JARM"
                  onChange={(randomizeJarm) =>
                    setDraft((current) => ({ ...current, randomizeJarm }))
                  }
                />
              </>
            )}
          </div>
          {draft.kind === "https" && (
            <div className="rounded-xl border border-separator bg-default p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-muted">
                    <FontAwesomeIcon aria-hidden icon={faCertificate} className="size-3.5" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">Custom certificate pair</p>
                    <p className="truncate text-xs text-muted">
                      {certificatePair
                        ? `${certificatePair.certificateName} · ${certificatePair.keyName}`
                        : draft.acme
                          ? "Disabled while ACME is enabled"
                          : "Optional PEM certificate and private key"}
                    </p>
                  </div>
                </div>
                <Button
                  isDisabled={draft.acme || isChoosingCertificate}
                  size="sm"
                  variant="secondary"
                  onPress={onChooseCertificate}
                >
                  <FontAwesomeIcon
                    aria-hidden
                    icon={isChoosingCertificate ? faCircleNotch : faCertificate}
                    className={`size-3 ${isChoosingCertificate ? "animate-spin" : ""}`}
                  />
                  {certificatePair ? "Replace pair" : "Choose pair"}
                </Button>
              </div>
              {errors.certificateToken && (
                <p className="mt-2 text-xs text-danger" role="alert">{errors.certificateToken}</p>
              )}
            </div>
          )}
        </div>
      );

    case "stage":
      return (
        <div className="space-y-4">
          <SectionLabel icon={faNetworkWired} title="Stage payload" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Select
              fullWidth
              isDisabled={profiles.length === 0}
              isInvalid={Boolean(errors.profileName)}
              placeholder={profiles.length > 0 ? "Choose a profile" : "No profiles available"}
              value={draft.profileName || null}
              variant="secondary"
              onChange={(value) => {
                if (value === null) {
                  setDraft((current) => ({ ...current, profileName: "" }));
                } else if (typeof value === "string" && profiles.includes(value)) {
                  setDraft((current) => ({ ...current, profileName: value }));
                }
              }}
            >
              <Label>Implant profile</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Description>The server generates this profile as the stage payload.</Description>
              <Select.Popover>
                <ListBox>
                  {profiles.map((profile) => (
                    <ListBox.Item id={profile} key={profile} textValue={profile}>
                      <span className="font-mono text-xs">{profile}</span>
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <Select
              fullWidth
              value={draft.compression}
              variant="secondary"
              onChange={(value) => {
                if (isStageCompression(value)) {
                  setDraft((current) => ({ ...current, compression: value }));
                }
              }}
            >
              <Label>Compression</Label>
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Description>Applied before encryption and size prefixing.</Description>
              <Select.Popover>
                <ListBox>
                  {STAGE_COMPRESSION_OPTIONS.map((option) => (
                    <ListBox.Item id={option.id} key={option.id} textValue={option.label}>
                      {option.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
          {errors.profileName && <p className="-mt-2 text-xs text-danger" role="alert">{errors.profileName}</p>}
          <div className="rounded-xl border border-separator bg-default p-3">
            <div className="mb-3 flex items-center gap-2">
              <FontAwesomeIcon aria-hidden icon={faKey} className="size-3.5 text-muted" />
              <div>
                <p className="text-xs font-medium text-foreground">Optional stage encryption</p>
                <p className="text-xs text-muted">Use AES or RC4, never both.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextControl
                autoComplete="off"
                error={errors.aesKey}
                label="AES key"
                placeholder="16 or 32 UTF-8 bytes"
                type="password"
                value={draft.aesKey}
                onChange={(aesKey) => setDraft((current) => ({ ...current, aesKey }))}
              />
              <TextControl
                autoComplete="off"
                description="Empty uses sixteen zero bytes."
                error={errors.aesIv}
                label="AES IV"
                placeholder="Optional 16-byte IV"
                type="password"
                value={draft.aesIv}
                onChange={(aesIv) => setDraft((current) => ({ ...current, aesIv }))}
              />
            </div>
            <div className="mt-4">
              <TextControl
                autoComplete="off"
                error={errors.rc4Key}
                label="RC4 key"
                placeholder="1 to 256 UTF-8 bytes"
                type="password"
                value={draft.rc4Key}
                onChange={(rc4Key) => setDraft((current) => ({ ...current, rc4Key }))}
              />
            </div>
          </div>
        </div>
      );
  }
}

interface TextControlProps {
  autoComplete?: string | undefined;
  description?: string | undefined;
  error?: string | undefined;
  label: string;
  placeholder?: string | undefined;
  type?: "password" | "text" | undefined;
  value: string;
  onChange: (value: string) => void;
}

function TextControl({
  autoComplete,
  description,
  error,
  label,
  placeholder,
  type = "text",
  value,
  onChange,
}: TextControlProps): React.JSX.Element {
  return (
    <TextField
      fullWidth
      isInvalid={Boolean(error)}
      value={value}
      variant="secondary"
      onChange={onChange}
    >
      <Label>{label}</Label>
      <Input
        {...(autoComplete ? { autoComplete } : {})}
        {...(placeholder ? { placeholder } : {})}
        type={type}
      />
      {description && <Description>{description}</Description>}
      {error && <FieldError>{error}</FieldError>}
    </TextField>
  );
}

interface NumberControlProps {
  description?: string | undefined;
  error?: string | undefined;
  label: string;
  maxValue?: number | undefined;
  minValue: number;
  value: number;
  onChange: (value: number) => void;
}

function NumberControl({
  description,
  error,
  label,
  maxValue,
  minValue,
  value,
  onChange,
}: NumberControlProps): React.JSX.Element {
  return (
    <NumberField
      fullWidth
      formatOptions={{ useGrouping: false }}
      isInvalid={Boolean(error)}
      {...(maxValue === undefined ? {} : { maxValue })}
      minValue={minValue}
      value={value}
      variant="secondary"
      onChange={(nextValue) => onChange(nextValue ?? 0)}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.Input />
      </NumberField.Group>
      {description && <Description>{description}</Description>}
      {error && <FieldError>{error}</FieldError>}
    </NumberField>
  );
}

function SectionLabel({ icon, title }: { icon: typeof faServer; title: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <FontAwesomeIcon aria-hidden icon={icon} className="size-3.5 text-muted" />
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">{title}</p>
    </div>
  );
}

function InfoStrip({
  description,
  icon,
  title,
}: {
  description: string;
  icon: typeof faServer;
  title: string;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-separator bg-default p-3">
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-surface text-muted">
        <FontAwesomeIcon aria-hidden icon={icon} className="size-3.5" />
      </span>
      <div>
        <p className="text-xs font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{description}</p>
      </div>
    </div>
  );
}

function EventRow({ event }: { event: RecentEventSummary }): React.JSX.Element {
  const tone = eventTone(event);
  return (
    <li className="flex gap-3 px-4 py-3">
      <span
        className={`mt-1 grid size-6 shrink-0 place-items-center rounded-full ${
          tone === "danger"
            ? "bg-danger-soft text-danger-soft-foreground"
            : tone === "success"
              ? "bg-success-soft text-success-soft-foreground"
              : "bg-default text-muted"
        }`}
      >
        <FontAwesomeIcon
          aria-hidden
          icon={tone === "danger" ? faCircleExclamation : tone === "success" ? faCircleCheck : faBolt}
          className="size-2.5"
        />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="truncate text-xs font-medium text-foreground" title={event.type}>
            {formatEventType(event.type)}
          </p>
          <time className="shrink-0 font-mono text-[10px] tabular-nums text-muted" dateTime={event.at}>
            {formatEventTime(event.at)}
          </time>
        </div>
        <p className="mt-1 break-words text-xs leading-relaxed text-muted">{event.message}</p>
      </div>
    </li>
  );
}

function listenerName(job: JobSummary): string {
  const name = job.name.trim();
  if (name && !/^job$/i.test(name)) return name;
  return `${protocolLabel(normalizedJobProtocol(job))} listener`;
}

function protocolLabel(protocol: string): string {
  const labels: Record<string, string> = {
    dns: "DNS",
    http: "HTTP",
    https: "HTTPS",
    mtls: "mTLS",
    stage: "TCP stage",
    wireguard: "WireGuard",
  };
  return labels[protocol] ?? protocol.toUpperCase();
}

function protocolColor(protocol: string): "accent" | "default" | "success" | "warning" {
  if (protocol === "https" || protocol === "mtls") return "success";
  if (protocol === "dns" || protocol === "wireguard") return "accent";
  if (protocol === "stage") return "warning";
  return "default";
}

function connectionColor(
  status: SliverSnapshot["connection"]["status"] | undefined,
): "danger" | "default" | "success" | "warning" {
  if (status === "connected") return "success";
  if (status === "connecting") return "warning";
  if (status === "error") return "danger";
  return "default";
}

function connectionLabel(status: SliverSnapshot["connection"]["status"] | undefined): string {
  if (status === "connected") return "Backend connected";
  if (status === "connecting") return "Connecting";
  if (status === "error") return "Connection error";
  return "Not connected";
}

function streamColor(
  status: SliverSnapshot["eventStream"]["status"] | undefined,
): "danger" | "default" | "success" | "warning" {
  if (status === "connected") return "success";
  if (status === "connecting" || status === "retrying") return "warning";
  if (status === "stopped") return "default";
  return "danger";
}

function streamLabel(status: SliverSnapshot["eventStream"]["status"] | undefined): string {
  if (status === "connected") return "Live";
  if (status === "connecting") return "Connecting";
  if (status === "retrying") return "Retrying";
  return "Offline";
}

function eventTone(event: RecentEventSummary): "danger" | "default" | "success" {
  if (event.isError || /error|failed|stopped|killed/i.test(event.type)) return "danger";
  if (/started|connected|opened|joined/i.test(event.type)) return "success";
  return "default";
}

function formatEventType(type: string): string {
  return type
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatEventTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : EVENT_TIME.format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default OperationsPage;
