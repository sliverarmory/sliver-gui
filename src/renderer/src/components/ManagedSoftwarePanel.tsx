import { faArrowsRotate, faCheck, faCircle, faPlus, faSpinner, faTrash, faTriangleExclamation } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, Card, Chip, Input, Label, ProgressBar, Tabs, TextArea, TextField, Tooltip } from "@heroui/react";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import type { CloudDeploymentAPI, CloudProvisioningTranscript } from "../../../shared/cloud-deployment-ipc";
import { cloudDnsRecordName, type CloudDnsRecord, type CloudDnsZone } from "../../../shared/cloud-dns-contracts";
import {
  resolveLocalRedirectorDnsNames,
  type LocalRedirectorListenerOption,
  type LocalRedirectorRecipe,
  type LocalRedirectorRecord,
  type SoftwareInstallProgress,
  type SoftwareInstallProgressSnapshot,
  type SoftwareDeploymentState,
} from "../../../shared/software-deployment-contracts";
import { CloudProvisioningTerminal } from "./CloudProvisioningTerminal";

type SoftwareAPI = Pick<CloudDeploymentAPI,
  "getSoftwareState" | "getSoftwareInstallProgress" | "onSoftwareInstallProgress" | "getTerminalRuntime" |
  "listSoftwareListeners" | "installLocalRedirector" | "removeLocalRedirector" | "listDnsZones" | "listDnsRecords" | "onChanged">;

interface ManagedSoftwarePanelProps {
  readonly api: SoftwareAPI;
  readonly deploymentId: string;
  readonly credentialId: string;
  readonly publicIp: string | null;
  readonly serverRunning: boolean;
}

const DNS_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recipeName(recipeId: LocalRedirectorRecipe): string {
  return recipeId === "caddy" ? "Caddy" : "Nginx";
}

function parseDomains(value: string): string[] {
  const domains = value.split(/[\s,]+/u).filter(Boolean).map((domain) => domain.toLowerCase());
  if (domains.length > 8) throw new Error("Choose at most eight domains.");
  if (domains.some((domain) => !DNS_NAME.test(domain))) throw new Error("Enter valid public domain names, separated by commas or lines.");
  if (new Set(domains).size !== domains.length) throw new Error("Remove duplicate domains.");
  return domains;
}

function dnsRecordDomain(record: CloudDnsRecord): string {
  return cloudDnsRecordName(record.name, record.zoneName).replace(/\.$/u, "");
}

function statusColor(status: LocalRedirectorRecord["status"]): "success" | "warning" | "danger" | "default" {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  if (status === "degraded" || status === "outcome-unknown") return "warning";
  return "default";
}

function formatStatus(status: LocalRedirectorRecord["status"]): string {
  if (status === "outcome-unknown") return "Outcome unknown";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

const INSTALL_STEPS: readonly { readonly id: SoftwareInstallProgress["step"]; readonly label: string }[] = [
  { id: "dns", label: "Prepare public DNS" },
  { id: "listener", label: "Prepare localhost listener" },
  { id: "firewall", label: "Configure public firewall" },
  { id: "ssh", label: "Install software over SSH" },
  { id: "verify", label: "Verify public endpoint" },
];

function SoftwareInstallScreen({
  api,
  deploymentId,
  progress,
  fallbackError,
  attemptKey,
  onBack,
}: {
  readonly api: Pick<CloudDeploymentAPI, "getTerminalRuntime">;
  readonly deploymentId: string;
  readonly progress: SoftwareInstallProgressSnapshot;
  readonly fallbackError: string | null;
  readonly attemptKey: number;
  readonly onBack: () => void;
}): React.JSX.Element {
  const steps = INSTALL_STEPS.map(({ id, label }) => {
    const latest = progress.events.filter((event) => event.step === id && !event.output).at(-1);
    return { id, label, status: latest?.status ?? "pending", message: latest?.message ?? null };
  });
  const completed = steps.filter(({ status }) => status === "complete").length;
  const running = steps.some(({ status }) => status === "running");
  const percent = progress.status === "complete" ? 100 : progress.status === "failed" ? completed * 20 : Math.min(95, completed * 20 + (running ? 10 : 4));
  const failure = fallbackError ?? progress.events.filter((event) => event.status === "failed").at(-1)?.message ?? null;
  const transcript = useMemo<CloudProvisioningTranscript>(() => {
    let outputSequence = progress.outputSequenceStart;
    return Object.freeze({
      deploymentId,
      status: progress.status === "running" ? "streaming" : progress.status === "complete" ? "complete" : "failed",
      truncated: progress.truncated,
      chunks: Object.freeze(progress.events.flatMap((event) => event.output
        ? [Object.freeze({ sequence: outputSequence++, bytes: event.output.chunk })] : [])),
    });
  }, [deploymentId, progress]);

  return <Card variant="secondary">
    <Card.Header className="flex-row items-start justify-between gap-3">
      <div>
        <Card.Title>Installing {recipeName(progress.recipeId)}</Card.Title>
        <Card.Description>Deployment on this managed server</Card.Description>
      </div>
      <Chip color={progress.status === "complete" ? "success" : progress.status === "failed" ? "danger" : "warning"} size="sm" variant="soft">
        {progress.status === "complete" ? "Complete" : progress.status === "failed" ? "Failed" : "In progress"}
      </Chip>
    </Card.Header>
    <Card.Content className="space-y-6">
      <ProgressBar aria-label={`${recipeName(progress.recipeId)} installation progress`} value={percent}>
        <div className="mb-2 flex justify-between text-xs"><span>Deployment progress</span><ProgressBar.Output className="tabular-nums text-muted">{percent}%</ProgressBar.Output></div>
        <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
      </ProgressBar>
      <ol aria-label="Installation steps" className="space-y-2">
        {steps.map(({ id, label, status, message }) => <li aria-current={status === "running" ? "step" : undefined} className="flex items-start gap-3 rounded-xl border border-separator px-4 py-3" key={id}>
          <span className={`mt-0.5 grid size-5 shrink-0 place-items-center ${status === "complete" ? "text-success" : status === "failed" ? "text-danger" : status === "running" ? "text-primary" : "text-muted"}`}>
            <FontAwesomeIcon aria-hidden className={status === "running" ? "animate-spin" : undefined} icon={status === "complete" ? faCheck : status === "failed" ? faTriangleExclamation : status === "running" ? faSpinner : faCircle} />
          </span>
          <div className="min-w-0"><p className="text-sm font-medium">{label}</p>{message && status !== "failed" ? <p className="mt-0.5 break-words text-xs text-muted">{message}</p> : null}</div>
        </li>)}
      </ol>
      {failure && progress.status === "failed" ? <p className="rounded-xl bg-danger-soft px-4 py-3 text-sm text-danger-soft-foreground" role="alert">{failure}</p> : null}
      {progress.status === "complete" ? <p className="rounded-xl bg-success-soft px-4 py-3 text-sm text-success-soft-foreground" role="status">{recipeName(progress.recipeId)} is installed. The managed software view has the public endpoint and removal controls.</p> : null}
      <CloudProvisioningTerminal
        api={api}
        deploymentId={deploymentId}
        key={`${deploymentId}:${attemptKey}`}
        labels={{
          sectionAriaLabel: "SSH installation output",
          title: "SSH installation output",
          description: "Read-only stdout and stderr from the redirector installation.",
          terminalAriaLabel: `Read-only SSH installation output for ${deploymentId}`,
          waiting: "Waiting for SSH",
          live: "Live",
          complete: "Complete",
          failed: "Installation failed",
        }}
        transcript={transcript}
      />
    </Card.Content>
    <Card.Footer className="flex justify-between gap-3">
      {progress.status === "running" ? <p className="text-xs text-muted">Installation continues if you return to the software list.</p> : <span />}
      <Button size="sm" variant={progress.status === "running" ? "outline" : "primary"} onPress={onBack}>Back to software</Button>
    </Card.Footer>
  </Card>;
}

export function ManagedSoftwarePanel({ api, deploymentId, credentialId, publicIp, serverRunning }: ManagedSoftwarePanelProps): React.JSX.Element {
  const refreshGeneration = useRef(0);
  const progressRequestGeneration = useRef(0);
  const progressDismissed = useRef(false);
  const progressRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousDeploymentId = useRef(deploymentId);
  const selectedDeploymentId = useRef(deploymentId);
  selectedDeploymentId.current = deploymentId;
  const [state, setState] = useState<SoftwareDeploymentState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [recipeId, setRecipeId] = useState<LocalRedirectorRecipe>("caddy");
  const [publicIpInput, setPublicIpInput] = useState(publicIp ?? "");
  const [domainsInput, setDomainsInput] = useState("");
  const [dnsTab, setDnsTab] = useState<"manual" | "cloud">("manual");
  const [cloudDnsMode, setCloudDnsMode] = useState<"existing" | "create">("existing");
  const [dnsNamesInput, setDnsNamesInput] = useState("");
  const [listenerMode, setListenerMode] = useState<"create" | "existing">("create");
  const [listenerPort, setListenerPort] = useState("8000");
  const [listenerJobId, setListenerJobId] = useState("");
  const [listeners, setListeners] = useState<readonly LocalRedirectorListenerOption[]>([]);
  const [listenersLoading, setListenersLoading] = useState(false);
  const [listenersError, setListenersError] = useState<string | null>(null);
  const [zones, setZones] = useState<readonly CloudDnsZone[]>([]);
  const [zoneId, setZoneId] = useState("");
  const [dnsRecords, setDnsRecords] = useState<readonly CloudDnsRecord[]>([]);
  const [dnsLoading, setDnsLoading] = useState(false);
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState<"install" | string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [installProgress, setInstallProgress] = useState<SoftwareInstallProgressSnapshot | null>(null);
  const [progressView, setProgressView] = useState(false);
  const [progressError, setProgressError] = useState<string | null>(null);
  const [installAttemptKey, setInstallAttemptKey] = useState(0);

  const applyState = useCallback((next: SoftwareDeploymentState): void => {
    setState((current) => current && current.revision > next.revision ? current : next);
  }, []);

  const refreshState = useCallback(async (): Promise<void> => {
    const generation = ++refreshGeneration.current;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.getSoftwareState();
      if (!result.ok) throw new Error(result.error);
      if (generation === refreshGeneration.current) applyState(result.value);
    } catch (error) {
      if (generation === refreshGeneration.current) setLoadError(formatError(error));
    } finally {
      if (generation === refreshGeneration.current) setLoading(false);
    }
  }, [api, applyState]);

  const refreshInstallProgress = useCallback(async (): Promise<boolean> => {
    const generation = ++progressRequestGeneration.current;
    try {
      const result = await api.getSoftwareInstallProgress({ deploymentId });
      if (!result.ok) throw new Error(result.error);
      if (generation !== progressRequestGeneration.current || selectedDeploymentId.current !== deploymentId) return false;
      if (result.value) {
        setInstallProgress(result.value);
        setProgressError(null);
        if (result.value.status === "running" && !progressDismissed.current) setProgressView(true);
      }
      return result.value !== null;
    } catch (error) {
      if (generation === progressRequestGeneration.current && selectedDeploymentId.current === deploymentId) {
        setProgressError((current) => current ?? formatError(error));
      }
      return false;
    }
  }, [api, deploymentId]);

  useEffect(() => {
    const unsubscribe = api.onSoftwareInstallProgress((event) => {
      if (event.deploymentId !== deploymentId || progressRefreshTimer.current) return;
      progressRefreshTimer.current = setTimeout(() => {
        progressRefreshTimer.current = null;
        void refreshInstallProgress();
      }, 75);
    });
    void refreshInstallProgress();
    return () => {
      unsubscribe();
      progressRequestGeneration.current += 1;
      if (progressRefreshTimer.current) clearTimeout(progressRefreshTimer.current);
      progressRefreshTimer.current = null;
    };
  }, [api, deploymentId, refreshInstallProgress]);

  // A software window opened after installation began cannot receive the
  // original window's IPC stream. Its session snapshot still advances.
  useEffect(() => {
    if (installProgress?.status !== "running") return;
    const timer = setInterval(() => { void refreshInstallProgress(); }, 1_000);
    return () => clearInterval(timer);
  }, [installProgress?.status, refreshInstallProgress]);

  useEffect(() => {
    void refreshState();
    return () => { refreshGeneration.current += 1; };
  }, [refreshState]);

  useEffect(() => {
    setPublicIpInput(publicIp ?? "");
    setReviewing(false);
    if (previousDeploymentId.current === deploymentId) return;
    previousDeploymentId.current = deploymentId;
    setState(null);
    setShowForm(false);
    setRecipeId("caddy");
    setDomainsInput("");
    setDnsTab("manual");
    setCloudDnsMode("existing");
    setDnsNamesInput("");
    setListenerMode("create");
    setListenerPort("8000");
    setListenerJobId("");
    setListeners([]);
    setZones([]);
    setZoneId("");
    setDnsRecords([]);
    setFormError(null);
    setOperationError(null);
    setNotice(null);
    setPending(null);
    setRemovingId(null);
    progressDismissed.current = false;
    progressRequestGeneration.current += 1;
    setInstallProgress(null);
    setProgressView(false);
    setProgressError(null);
    void refreshState();
    void refreshInstallProgress();
  }, [deploymentId, publicIp, refreshInstallProgress, refreshState]);

  useEffect(() => api.onChanged((scope) => {
    if (scope === "snapshot") void refreshState();
  }), [api, refreshState]);

  useEffect(() => {
    if (!showForm || listenerMode !== "existing") return;
    let active = true;
    setListenersLoading(true);
    setListenersError(null);
    void api.listSoftwareListeners({ deploymentId }).then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      setListeners(result.value);
      setListenerJobId((current) => result.value.some((option) => option.eligible && String(option.jobId) === current)
        ? current : String(result.value.find((option) => option.eligible)?.jobId ?? ""));
    }).catch((error: unknown) => {
      if (active) setListenersError(formatError(error));
    }).finally(() => {
      if (active) setListenersLoading(false);
    });
    return () => { active = false; };
  }, [api, deploymentId, listenerMode, showForm]);

  useEffect(() => {
    if (!showForm || dnsTab !== "cloud") return;
    let active = true;
    setDnsLoading(true);
    setDnsError(null);
    void api.listDnsZones({ credentialId }).then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      const publicZones = result.value.filter((zone) => !zone.private);
      setZones(publicZones);
      setZoneId((current) => publicZones.some((zone) => zone.id === current) ? current : publicZones[0]?.id ?? "");
    }).catch((error: unknown) => {
      if (active) setDnsError(formatError(error));
    }).finally(() => {
      if (active) setDnsLoading(false);
    });
    return () => { active = false; };
  }, [api, credentialId, dnsTab, showForm]);

  useEffect(() => {
    if (!showForm || dnsTab !== "cloud" || !zoneId) {
      setDnsRecords([]);
      return;
    }
    let active = true;
    setDnsLoading(true);
    setDnsError(null);
    setDnsRecords([]);
    void api.listDnsRecords({ credentialId, zoneId }).then((result) => {
      if (!active) return;
      if (!result.ok) throw new Error(result.error);
      setDnsRecords(result.value.filter((record) => record.type === "A" && record.values.includes(publicIp ?? "")));
    }).catch((error: unknown) => {
      if (active) setDnsError(formatError(error));
    }).finally(() => {
      if (active) setDnsLoading(false);
    });
    return () => { active = false; };
  }, [api, credentialId, dnsTab, publicIp, showForm, zoneId]);

  const currentRecords = state?.records.filter((record) => record.deploymentId === deploymentId) ?? [];
  const eligibleListeners = listeners.filter((option) => option.eligible);
  const dnsChoices = dnsRecords;
  const selectedZone = zones.find((zone) => zone.id === zoneId);
  const dnsNames = cloudDnsMode === "create" ? dnsNamesInput.split(/[\s,]+/u).filter(Boolean) : [];
  let domains: string[] = [];
  let existingDomains: string[] = [];
  let plannedDomains: readonly string[] = [];
  let validationError: string | null = null;
  try {
    existingDomains = parseDomains(domainsInput);
    if (cloudDnsMode === "create" && dnsNames.length === 0) {
      throw new Error("Enter at least one subdomain to create in Cloud DNS.");
    }
    if (dnsNames.length > 0) {
      if (!selectedZone) throw new Error("Choose a public DNS zone for the new records.");
      plannedDomains = resolveLocalRedirectorDnsNames(selectedZone.name, dnsNames);
    }
    domains = [...existingDomains, ...plannedDomains];
    if (domains.length > 8) throw new Error("Choose at most eight domains in total.");
    if (new Set(domains).size !== domains.length) throw new Error("Remove duplicate domains across Manual DNS and Cloud DNS.");
  } catch (error) { validationError = formatError(error); }
  if (!validationError && currentRecords.length > 0) validationError = "Remove the current redirector before adding another.";
  const publicIpValue = publicIpInput.trim();
  if (!validationError && !publicIp) validationError = "This server needs a public IPv4 before a redirector can be deployed.";
  if (!validationError && publicIpValue && publicIpValue !== publicIp) validationError = "The public IP must match this server’s assigned public IPv4.";
  if (!validationError && !domains.length && !publicIpValue) validationError = "Enter a public IP or at least one domain.";
  const numericPort = Number(listenerPort);
  if (!validationError && listenerMode === "create" && (!/^\d+$/u.test(listenerPort) || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)) {
    validationError = "Choose a listener port from 1 to 65535.";
  }
  if (!validationError && listenerMode === "create" && (numericPort === 80 || numericPort === 443)) {
    validationError = "Choose a local listener port other than 80 or 443; the redirector reserves those public ports.";
  }
  if (!validationError && listenerMode === "existing" && !eligibleListeners.some(({ jobId }) => String(jobId) === listenerJobId)) {
    validationError = "Choose an eligible loopback listener.";
  }
  const publicUrl = domains.length ? `https://${domains[0]}` : `http://${publicIpValue}`;
  const chosenListener = listeners.find(({ jobId }) => String(jobId) === listenerJobId);

  const beginReview = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFormError(validationError);
    if (!validationError) setReviewing(true);
  };

  const install = async (): Promise<void> => {
    if (!state || validationError || pending) return;
    let installationFailed = false;
    progressDismissed.current = false;
    progressRequestGeneration.current += 1;
    setInstallProgress({ deploymentId, recipeId, status: "running", truncated: false, outputSequenceStart: 0, events: [] });
    setProgressView(true);
    setProgressError(null);
    setInstallAttemptKey((current) => current + 1);
    setPending("install");
    setFormError(null);
    setNotice(null);
    try {
      const result = await api.installLocalRedirector({
        deploymentId,
        expectedRevision: state.revision,
        recipeId,
        publicIp: publicIpValue || null,
        domains,
        ...(dnsNames.length > 0 ? { dnsRecords: { zoneId, names: dnsNames } } : {}),
        listener: listenerMode === "create" ? { mode: "create", port: numericPort } : { mode: "existing", jobId: Number(listenerJobId) },
      });
      if (!result.ok) throw new Error(result.error);
      await refreshState();
      if (selectedDeploymentId.current !== deploymentId) return;
      setShowForm(false);
      setReviewing(false);
    } catch (error) {
      installationFailed = true;
      if (selectedDeploymentId.current === deploymentId) {
        setProgressError(formatError(error));
      }
      await refreshState();
    } finally {
      if (selectedDeploymentId.current === deploymentId) {
        const hasSnapshot = await refreshInstallProgress();
        if (!hasSnapshot && installationFailed) {
          setInstallProgress((current) => current ? { ...current, status: "failed" } : current);
        }
        setPending(null);
      }
    }
  };

  const remove = async (record: LocalRedirectorRecord): Promise<void> => {
    if (!state || pending) return;
    setPending(record.id);
    setFormError(null);
    setNotice(null);
    setOperationError(null);
    try {
      const result = await api.removeLocalRedirector({ deploymentId, installationId: record.id, expectedRevision: state.revision });
      if (!result.ok) throw new Error(result.error);
      applyState(result.value);
      if (selectedDeploymentId.current !== deploymentId) return;
      setRemovingId(null);
      setNotice(`${recipeName(record.recipeId)} removed.`);
    } catch (error) {
      if (selectedDeploymentId.current === deploymentId) setOperationError(formatError(error));
      await refreshState();
    } finally {
      if (selectedDeploymentId.current === deploymentId) setPending(null);
    }
  };

  if (progressView && installProgress) {
    return <SoftwareInstallScreen
      api={api}
      attemptKey={installAttemptKey}
      deploymentId={deploymentId}
      fallbackError={progressError}
      onBack={() => {
        progressDismissed.current = true;
        setProgressView(false);
        setShowForm(false);
        setReviewing(false);
        void refreshState();
      }}
      progress={installProgress}
    />;
  }

  return <Card variant="secondary">
    <Card.Header className="flex-col items-stretch gap-4 sm:flex-row sm:items-start">
      <div className="min-w-0 flex-1">
        <Card.Title>Managed software</Card.Title>
      </div>
      <div className="flex items-center gap-2 self-end sm:self-auto">
        {installProgress ? <Button size="sm" variant="outline" onPress={() => setProgressView(true)}>
          {installProgress.status === "running" ? "View install progress" : "View last install log"}
        </Button> : null}
        <Tooltip delay={0}><Button aria-label="Refresh managed software" isDisabled={loading || pending !== null} isIconOnly size="sm" variant="outline" onPress={() => void refreshState()}>
          <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={loading ? "animate-spin" : ""} />
        </Button><Tooltip.Content>Refresh managed software</Tooltip.Content></Tooltip>
        <Button isDisabled={!serverRunning || !publicIp || !state || pending !== null || currentRecords.length > 0} size="sm" variant="primary" onPress={() => {
          if (!showForm) {
            setDnsTab("manual");
            setCloudDnsMode("existing");
            setDnsNamesInput("");
          }
          setShowForm((current) => !current);
          setReviewing(false);
          setFormError(null);
        }}><FontAwesomeIcon aria-hidden icon={faPlus} />Add software</Button>
      </div>
    </Card.Header>
    <Card.Content className="space-y-5">
      {loadError ? <p className="text-sm text-danger" role="alert">Could not load managed software: {loadError}</p> : null}
      {operationError ? <p className="text-sm text-danger" role="alert">Software change failed: {operationError}</p> : null}
      {notice ? <p className="text-sm text-success" role="status">{notice}</p> : null}
      {!serverRunning ? <p className="text-sm text-muted">Start this server before deploying a redirector.</p> : null}
      {serverRunning && !publicIp ? <p className="text-sm text-muted">Assign a public IPv4 to this server before deploying a redirector.</p> : null}
      {currentRecords.length > 0 ? <p className="text-sm text-muted">One local HTTP redirector can run on this server. Remove the current redirector before adding another; the frontend reserves public port 80 and, for domains, port 443.</p> : null}
      {loading && !state ? <p className="text-sm text-muted" role="status">Loading managed software…</p> : null}
      {!loading && !loadError && currentRecords.length === 0 ? <p className="text-sm text-muted">No local HTTP redirectors installed.</p> : null}
      {currentRecords.map((record) => <div className="space-y-3 rounded-xl border border-separator p-4" key={record.id}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><h3 className="font-semibold">{recipeName(record.recipeId)}</h3><Chip color={statusColor(record.status)} size="sm" variant="soft">{formatStatus(record.status)}</Chip></div>
            <p className="mt-1 break-all font-mono text-sm">{record.publicUrl}</p>
          </div>
          <Button aria-label={`Remove ${recipeName(record.recipeId)} from ${record.publicUrl}`} isDisabled={pending !== null || !serverRunning} size="sm" variant="danger-soft" onPress={() => setRemovingId(record.id)}>
            <FontAwesomeIcon aria-hidden icon={faTrash} />Remove
          </Button>
        </div>
        <p className="text-xs text-muted">{record.listener.ownership === "managed" ? "Managed" : "Existing"} {record.listener.kind.toUpperCase()} listener {record.listener.jobId === 0 ? "(job ID unconfirmed)" : `#${record.listener.jobId}`} · 127.0.0.1:{record.listener.port} · public port{record.frontendPorts.length === 1 ? "" : "s"} {record.frontendPorts.join(", ")}</p>
        {record.lastError ? <p className="text-sm text-danger">{record.lastError}</p> : null}
        {record.status === "outcome-unknown" ? <p className="text-xs text-warning">Check the remote service before attempting another change.</p> : null}
        {removingId === record.id ? <div className="space-y-2 rounded-lg bg-surface-secondary p-3">
          <p className="text-sm">Remove {recipeName(record.recipeId)} and its managed frontend? {record.listener.ownership === "managed" ? record.listener.jobId === 0 ? "Inspect and stop any listener on the recorded backend port first; its job ID was not confirmed." : "The listener created for it will also be stopped." : "The existing listener will remain running."}</p>
          <div className="flex gap-2"><Button isDisabled={pending !== null} size="sm" variant="tertiary" onPress={() => setRemovingId(null)}>Cancel</Button><Button isPending={pending === record.id} size="sm" variant="danger" onPress={() => void remove(record)}>Remove redirector</Button></div>
        </div> : null}
      </div>)}

      {showForm ? <form className="space-y-5 rounded-xl border border-separator p-4" onSubmit={beginReview}>
        <div><h3 className="font-semibold">Deploy local HTTP redirector</h3><p className="mt-1 text-sm text-muted">Public traffic reaches the frontend. Sliver listens on this server at 127.0.0.1.</p></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <NativeSelect fullWidth><Label>Software</Label><NativeSelect.Trigger aria-label="Software" value={recipeId} onChange={(event) => { setRecipeId(event.target.value as LocalRedirectorRecipe); setReviewing(false); }}>
            <NativeSelect.Option value="caddy">Caddy</NativeSelect.Option><NativeSelect.Option value="nginx">Nginx</NativeSelect.Option><NativeSelect.Indicator />
          </NativeSelect.Trigger></NativeSelect>
          <TextField value={publicIpInput} onChange={(value) => { setPublicIpInput(value); setReviewing(false); }}><Label>Public IP</Label><Input placeholder="203.0.113.10" /><p className="mt-1 text-xs text-muted">Used for IP-only HTTP or DNS target checks.</p></TextField>
        </div>
        <Tabs className="min-w-0" selectedKey={dnsTab} onSelectionChange={(key) => {
          if (key === "cloud" && dnsTab !== "cloud") {
            setDnsLoading(true);
            setDnsError(null);
          }
          if (key === "manual" || key === "cloud") setDnsTab(key);
        }}>
          <Tabs.ListContainer className="w-fit max-w-full">
            <Tabs.List aria-label="Domain source" className="p-0.5">
              <Tabs.Tab className="h-7 w-auto min-w-28 shrink-0 whitespace-nowrap px-3 text-xs" id="manual">Manual DNS<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab className="h-7 w-auto min-w-28 shrink-0 whitespace-nowrap px-3 text-xs" id="cloud">Cloud DNS<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
          <Tabs.Panel className="pt-4" id="manual">
            {dnsTab === "manual" ? <TextField value={domainsInput} onChange={(value) => { setDomainsInput(value); setReviewing(false); }}><Label>Public domains</Label><TextArea rows={2} placeholder="c2.example.com" /><p className="mt-1 text-xs text-muted">Optional. Separate names with commas or new lines. Domains enable automatic HTTPS; the first domain is the primary callback address.</p></TextField> : null}
          </Tabs.Panel>
          <Tabs.Panel className="space-y-3 pt-4" id="cloud">
            {dnsTab === "cloud" ? <>
              <p className="text-xs text-muted">Use an existing record or create A records pointing to this server. Domains enable automatic HTTPS; the first domain is the primary callback address.</p>
              {dnsError ? <p className="text-sm text-danger" role="alert">{dnsError}</p> : null}
              {zones.length > 0 ? <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <NativeSelect fullWidth><Label>Public zone</Label><NativeSelect.Trigger aria-label="Public zone" value={zoneId} onChange={(event) => { setZoneId(event.target.value); setReviewing(false); setFormError(null); }}>
                    {zones.map((zone) => <NativeSelect.Option key={zone.id} value={zone.id}>{zone.name}</NativeSelect.Option>)}<NativeSelect.Indicator />
                  </NativeSelect.Trigger></NativeSelect>
                  <NativeSelect fullWidth><Label>DNS records</Label><NativeSelect.Trigger aria-label="DNS record setup" value={cloudDnsMode} onChange={(event) => { setCloudDnsMode(event.target.value as "existing" | "create"); setReviewing(false); setFormError(null); }}>
                    <NativeSelect.Option value="existing">Use existing record</NativeSelect.Option>
                    <NativeSelect.Option value="create">Create A records during deployment</NativeSelect.Option>
                    <NativeSelect.Indicator />
                  </NativeSelect.Trigger></NativeSelect>
                </div>
                {cloudDnsMode === "existing" ? <NativeSelect fullWidth><Label>Record pointing to this server</Label><NativeSelect.Trigger aria-label="DNS record" defaultValue="" key={`${zoneId}:${dnsRecords.length}`} onChange={(event) => {
                  const next = event.target.value;
                  if (!next) return;
                  try {
                    const existing = parseDomains(domainsInput);
                    if (!existing.includes(next)) setDomainsInput([...existing, next].join("\n"));
                    setReviewing(false);
                    setFormError(null);
                  } catch (error) { setFormError(formatError(error)); }
                  event.target.value = "";
                }}>
                  <NativeSelect.Option value="">Choose record</NativeSelect.Option>
                  {dnsChoices.map((record) => <NativeSelect.Option key={record.id} value={dnsRecordDomain(record)}>{dnsRecordDomain(record)} · {record.type}</NativeSelect.Option>)}
                  <NativeSelect.Indicator />
                </NativeSelect.Trigger></NativeSelect> : <div className="space-y-2">
                  <TextField fullWidth value={dnsNamesInput} onChange={(value) => { setDnsNamesInput(value); setReviewing(false); setFormError(null); }}><Label>Subdomains to create</Label><TextArea rows={2} placeholder="c2, edge.c2" /><p className="mt-1 text-xs text-muted">Separate names with commas or new lines. Use @ for the zone apex. Up to eight domains total.</p></TextField>
                  {plannedDomains.length > 0 ? <div className="space-y-1 text-xs text-muted"><p>Cloud DNS will create missing A records with TTL 300 seconds:</p>{plannedDomains.map((domain) => <p className="break-all font-mono" key={domain}>{domain} → {publicIp}</p>)}</div> : null}
                </div>}
              </> : !dnsError ? <p className="text-xs text-muted">{dnsLoading ? "Loading public DNS zones…" : "No public DNS zones found for this server’s cloud account. You can enter a domain manually or add a record in Cloud DNS."}</p> : null}
              {cloudDnsMode === "existing" && zoneId && !dnsLoading && !dnsError && dnsChoices.length === 0 ? <p className="text-xs text-muted">No A records in this zone currently point to this server’s public IPv4. Choose “Create A records during deployment” or add a record in Cloud DNS.</p> : null}
              {domains.length > 0 ? <p className="text-xs text-muted">Selected domains: {domains.join(", ")}.</p> : null}
            </> : null}
          </Tabs.Panel>
        </Tabs>
        <div className="grid gap-4 sm:grid-cols-2">
          <NativeSelect fullWidth><Label>Sliver listener</Label><NativeSelect.Trigger aria-label="Sliver listener" value={listenerMode} onChange={(event) => { setListenerMode(event.target.value as "create" | "existing"); setReviewing(false); }}>
            <NativeSelect.Option value="create">Start new localhost listener</NativeSelect.Option><NativeSelect.Option value="existing">Use existing localhost listener</NativeSelect.Option><NativeSelect.Indicator />
          </NativeSelect.Trigger></NativeSelect>
          {listenerMode === "create" ? <TextField value={listenerPort} onChange={(value) => { setListenerPort(value); setReviewing(false); }}><Label>Local listener port</Label><Input inputMode="numeric" /><p className="mt-1 text-xs text-muted">Sliver binds to 127.0.0.1 only. The port is not opened publicly.</p></TextField>
            : <NativeSelect fullWidth><Label>Eligible listener</Label><NativeSelect.Trigger aria-label="Eligible listener" value={listenerJobId} onChange={(event) => { setListenerJobId(event.target.value); setReviewing(false); }}><NativeSelect.Option value="">Choose listener</NativeSelect.Option>
              {eligibleListeners.map((option) => <NativeSelect.Option key={option.jobId} value={String(option.jobId)}>#{option.jobId} · {option.kind.toUpperCase()} · 127.0.0.1:{option.port}</NativeSelect.Option>)}<NativeSelect.Indicator />
            </NativeSelect.Trigger></NativeSelect>}
        </div>
        {listenerMode === "existing" ? <div className="space-y-1 text-xs text-muted">{listenersLoading ? <p>Checking existing listeners…</p> : null}{listenersError ? <p className="text-danger" role="alert">{listenersError}</p> : null}{!listenersLoading && !listenersError && eligibleListeners.length === 0 ? <p>No eligible listener is bound only to localhost.</p> : null}{listeners.filter((option) => !option.eligible).map((option) => <p key={option.jobId}>#{option.jobId} unavailable: {option.reason ?? "not eligible"}</p>)}</div> : null}
        {formError ? <p className="text-sm text-danger" role="alert">{formError}</p> : null}
        {reviewing && !validationError ? <div className="space-y-2 rounded-lg bg-surface-secondary p-4 text-sm">
          <h4 className="font-semibold">Review deployment</h4>
          <p><strong>{recipeName(recipeId)}</strong> will serve <span className="break-all font-mono">{publicUrl}</span>{domains.length ? " with automatic HTTPS" : " over HTTP"}.</p>
          <p>Upstream: {listenerMode === "create" ? `new HTTP listener on 127.0.0.1:${numericPort}` : `existing ${chosenListener?.kind.toUpperCase() ?? ""} listener #${listenerJobId} on 127.0.0.1:${chosenListener?.port ?? ""}`}.</p>
          {domains.length ? <>
            {existingDomains.length ? <p>Before deploying, point {existingDomains.join(", ")} to this server and allow public ports 80 and 443. Certificate issuance requires working DNS.</p> : <p>Allow public ports 80 and 443. Certificate issuance requires working DNS.</p>}
            {plannedDomains.length ? <><p>Cloud DNS will create missing A records for {plannedDomains.join(", ")} pointing to {publicIp} (TTL 300 seconds), then wait up to 2 minutes for DNS propagation.</p><p>Records created during deployment stay in Cloud DNS if installation fails or this redirector is removed.</p></> : null}
          </> : <p>Public HTTP uses port 80.</p>}
          <div className="flex gap-2"><Button isDisabled={pending !== null} size="sm" variant="tertiary" onPress={() => setReviewing(false)}>Edit</Button><Button isPending={pending === "install"} size="sm" variant="primary" onPress={() => void install()}>Install {recipeName(recipeId)}</Button></div>
        </div> : <div className="flex justify-end gap-2"><Button isDisabled={pending !== null} size="sm" variant="tertiary" onPress={() => { setShowForm(false); setFormError(null); }}>Cancel</Button><Button isDisabled={loading || !state || pending !== null || !serverRunning} size="sm" type="submit" variant="primary">Review deployment</Button></div>}
      </form> : null}
    </Card.Content>
  </Card>;
}
