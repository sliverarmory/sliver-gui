import { faAmazon, faMicrosoft } from "@fortawesome/free-brands-svg-icons";
import {
  faArrowLeft,
  faArrowsRotate,
  faCheck,
  faCloudArrowUp,
  faCopy,
  faEllipsisVertical,
  faKey,
  faPen,
  faPlay,
  faPlus,
  faRotate,
  faServer,
  faShieldHalved,
  faStop,
  faTerminal,
  faTrash,
  faTriangleExclamation,
  faUserPlus,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  Alert,
  AlertDialog,
  Button,
  ButtonGroup,
  Card,
  Chip,
  Description,
  Dropdown,
  FieldError,
  Input,
  Label,
  ListBox,
  Modal,
  ProgressBar,
  ScrollShadow,
  Select,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Tooltip,
  toast,
} from "@heroui/react";
import { DataGrid, type DataGridColumn } from "@heroui-pro/react/data-grid";
import { EmptyState } from "@heroui-pro/react/empty-state";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { Sheet } from "@heroui-pro/react/sheet";
import { Stepper } from "@heroui-pro/react/stepper";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AZURE_FIREWALL_RULE_MAX_VALUES,
  AZURE_SSH_PORT,
  AWS_SUPPORTED_INSTANCE_TYPES,
  isAwsRegion,
  isAzureSshUsername,
  type AwsCloudDeploymentRecord,
  type AwsCliProfileSummary,
  type AwsFirewallPeerType,
  type AwsFirewallRule,
  type AwsFirewallDirection,
  type AwsFirewallRuleSpec,
  type AwsFirewallSnapshot,
  type AzureCliAccountSummary,
  type AzureCloudDeploymentRecord,
  type AzureFirewallAccess,
  type AzureFirewallDirection,
  type AzureFirewallProtocol,
  type AzureFirewallRule,
  type AzureFirewallRuleSpec,
  type AzureFirewallSnapshot,
  type CloudCredentialSummary,
  type CloudDeploymentRecord,
  type CloudDeploymentStatus,
  type CloudProvider,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
} from "../../shared/cloud-deployment-contracts";
import type { AwsDeploymentOptions, AzureDeploymentOptions } from "../../shared/cloud-provider-inventory";
import type { SshHostKeyReview } from "../../shared/ssh-contracts";
import type {
  CloudCredentialTestResult,
  CloudDeploymentAPI,
  CloudDeploymentChangeScope,
  CloudDeploymentNavigationRequest,
  CloudDeploymentSnapshot,
  CloudProvisioningTranscript,
  CloudOperatorPermission,
  CurrentEgressIpv4,
  DestroyCloudDeploymentPlan,
  SshPrivateKeySelection,
} from "../../shared/cloud-deployment-ipc";
import {
  firewallIpv4Accent,
  ipv4CidrContainsAddress,
  ipv4RangeContainsAddress,
  isAnyIpv4Cidr,
  type FirewallIpv4Accent,
} from "../../shared/ipv4-cidr";
import { applyRendererTheme } from "./components/ApplicationSettingsProvider";
import { CloudProvisioningTerminal } from "./components/CloudProvisioningTerminal";
import { AuxiliaryWindowFrame } from "./components/AuxiliaryWindowFrame";

type FeedbackTone = "danger" | "success" | "warning" | "info";

interface Feedback {
  readonly tone: FeedbackTone;
  readonly title: string;
  readonly detail: string;
}

interface RefreshFailure {
  readonly scope: CloudDeploymentChangeScope;
  readonly message: string;
}

type CloudDeploymentActionRequest = Extract<CloudDeploymentNavigationRequest, { readonly view: "deployments" }>;
type CloudDeploymentCardAction = Exclude<CloudDeploymentActionRequest["action"], "ssh"> | "reboot" | "operator";

interface ActiveCloudDeploymentCardAction {
  readonly deploymentId: string;
  readonly action: CloudDeploymentCardAction;
}

interface OperatorMutationLock {
  readonly mutationState: "unknown" | "created";
  readonly error: string;
  readonly operatorName: string;
  readonly publicIp: string;
  readonly port: string;
  readonly permissions: CloudOperatorPermission;
}

const FEEDBACK_TOAST_TIMEOUT_MS = 30_000;
const CLOUD_PROVIDER_POLL_INTERVAL_MS = 30_000;
const OPERATOR_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const OPERATOR_PERMISSION_OPTIONS = Object.freeze([
  { value: "all", label: "Full access" },
  { value: "builder", label: "Remote builder" },
  { value: "crackstation", label: "Crackstation" },
] as const satisfies readonly { readonly value: CloudOperatorPermission; readonly label: string }[]);

type EgressIpv4Detection =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly cidr: string }
  | { readonly status: "failed"; readonly error: string };

type CurrentEgressIpv4Lookup =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly value: CurrentEgressIpv4 }
  | { readonly status: "failed" };

interface AwsDeploymentDraft {
  readonly imageMode: "catalog" | "manual";
  readonly imageId: string;
  readonly manualImageId: string;
  readonly instanceType: string;
  readonly networkMode: "existing" | "managed";
  readonly subnetId: string;
  readonly vpcId: string;
  readonly managedVpcCidr: string;
  readonly managedSubnetCidr: string;
  readonly sshKeyMode: "managed" | "existing";
  readonly existingKeyPairName: string;
  readonly sshUsername: string;
  readonly volumeSizeGiB: string;
}

interface AzureDeploymentDraft {
  readonly imageReference: string;
  readonly vmSize: string;
  readonly networkMode: "existing" | "managed";
  readonly vnetId: string;
  readonly subnetId: string;
  readonly managedVnetCidr: string;
  readonly managedSubnetCidr: string;
  readonly sshUsername: string;
  readonly osDiskSizeGiB: string;
}

type AwsFirewallPresetId =
  | "ssh"
  | "http"
  | "https"
  | "rdp"
  | "custom-tcp"
  | "custom-udp"
  | "all-traffic"
  | "all-icmp-ipv4"
  | "custom-icmp-ipv4"
  | "all-icmp-ipv6"
  | "custom-icmp-ipv6"
  | "custom-protocol";

interface AwsFirewallRuleDraft {
  readonly direction: AwsFirewallDirection;
  readonly preset: AwsFirewallPresetId;
  readonly protocol: string;
  readonly fromPort: string;
  readonly toPort: string;
  readonly peerType: AwsFirewallPeerType;
  readonly peer: string;
  readonly description: string;
}

type AwsFirewallEditorState =
  | { readonly mode: "create"; readonly draft: AwsFirewallRuleDraft }
  | { readonly mode: "edit"; readonly ruleId: string; readonly draft: AwsFirewallRuleDraft };

interface AwsFirewallPreset {
  readonly id: AwsFirewallPresetId;
  readonly label: string;
  readonly description: string;
  readonly protocol: string;
  readonly fromPort: number | null;
  readonly toPort: number | null;
}

interface AzureFirewallRuleDraft {
  readonly name: string;
  readonly priority: string;
  readonly direction: AzureFirewallDirection;
  readonly access: AzureFirewallAccess;
  readonly protocol: AzureFirewallProtocol;
  readonly sourceAddressPrefixes: string;
  readonly sourcePortRanges: string;
  readonly destinationAddressPrefixes: string;
  readonly destinationPortRanges: string;
  readonly description: string;
}

type AzureFirewallEditorState =
  | { readonly mode: "create"; readonly draft: AzureFirewallRuleDraft }
  | { readonly mode: "edit"; readonly ruleId: string; readonly draft: AzureFirewallRuleDraft };

const AWS_FIREWALL_PRESETS: readonly AwsFirewallPreset[] = [
  { id: "ssh", label: "SSH", description: "TCP port 22", protocol: "tcp", fromPort: 22, toPort: 22 },
  { id: "http", label: "HTTP", description: "TCP port 80", protocol: "tcp", fromPort: 80, toPort: 80 },
  { id: "https", label: "HTTPS", description: "TCP port 443", protocol: "tcp", fromPort: 443, toPort: 443 },
  { id: "rdp", label: "RDP", description: "TCP port 3389", protocol: "tcp", fromPort: 3_389, toPort: 3_389 },
  { id: "custom-tcp", label: "Custom TCP", description: "Choose a TCP port range", protocol: "tcp", fromPort: null, toPort: null },
  { id: "custom-udp", label: "Custom UDP", description: "Choose a UDP port range", protocol: "udp", fromPort: null, toPort: null },
  { id: "all-traffic", label: "All traffic", description: "All protocols and ports", protocol: "-1", fromPort: null, toPort: null },
  { id: "all-icmp-ipv4", label: "All ICMP IPv4", description: "All ICMP types and codes", protocol: "icmp", fromPort: -1, toPort: -1 },
  { id: "custom-icmp-ipv4", label: "Custom ICMP IPv4", description: "Choose an ICMP type and code", protocol: "icmp", fromPort: null, toPort: null },
  { id: "all-icmp-ipv6", label: "All ICMPv6", description: "All ICMPv6 types and codes", protocol: "icmpv6", fromPort: -1, toPort: -1 },
  { id: "custom-icmp-ipv6", label: "Custom ICMPv6", description: "Choose an ICMPv6 type and code", protocol: "icmpv6", fromPort: null, toPort: null },
  { id: "custom-protocol", label: "Custom protocol", description: "Enter an IP protocol number from 0 to 255", protocol: "", fromPort: null, toPort: null },
];

const INITIAL_AWS_DEPLOYMENT: AwsDeploymentDraft = {
  imageMode: "catalog",
  imageId: "",
  manualImageId: "",
  instanceType: "t3.micro",
  networkMode: "existing",
  subnetId: "",
  vpcId: "",
  managedVpcCidr: "10.0.0.0/16",
  managedSubnetCidr: "10.0.1.0/24",
  sshKeyMode: "managed",
  existingKeyPairName: "",
  sshUsername: "ubuntu",
  volumeSizeGiB: "20",
};

const MANAGED_VPC_OPTION = "__sliver_managed_vpc__";
const MANAGED_AZURE_VNET_OPTION = "__sliver_managed_vnet__";
// AWS key-pair names are strings, so a numeric collection key cannot collide
// with any real key pair returned by EC2.
const MANAGED_KEY_OPTION = -1;

function strongerRefreshScope(
  queued: CloudDeploymentChangeScope | null,
  requested: CloudDeploymentChangeScope,
): CloudDeploymentChangeScope {
  return queued === "snapshot" || requested === "snapshot" ? "snapshot" : "transcripts";
}

const INITIAL_AZURE_DEPLOYMENT: AzureDeploymentDraft = {
  imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
  vmSize: "Standard_B2s",
  networkMode: "managed",
  vnetId: "",
  subnetId: "",
  managedVnetCidr: "10.0.0.0/16",
  managedSubnetCidr: "10.0.1.0/24",
  sshUsername: "azureuser",
  osDiskSizeGiB: "30",
};

export function CloudDeploymentWindowApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CloudDeploymentSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<RefreshFailure | null>(null);
  const [providerRefreshError, setProviderRefreshError] = useState<string | null>(null);
  const [isRefreshingProvider, setIsRefreshingProvider] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [selectedTab, setSelectedTab] = useState("deployments");
  const [detailsDeploymentId, setDetailsDeploymentId] = useState<string | null>(null);
  const [operatorDeploymentId, setOperatorDeploymentId] = useState<string | null>(null);
  const [operatorMutationLocks, setOperatorMutationLocks] = useState<Readonly<Record<string, OperatorMutationLock>>>({});
  const [actionRequest, setActionRequest] = useState<CloudDeploymentActionRequest | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef<CloudDeploymentChangeScope | null>(null);
  const snapshotRef = useRef<CloudDeploymentSnapshot | null>(null);
  const providerRefreshInFlight = useRef<Promise<void> | null>(null);
  const providerRefreshVersion = useRef(0);
  const localSnapshotVersion = useRef(0);
  const mounted = useRef(true);
  const activeCardAction = useRef<ActiveCloudDeploymentCardAction | null>(null);
  const queuedNavigationRequest = useRef<CloudDeploymentNavigationRequest | null>(null);
  const pendingOperatorReturnFocus = useRef<string | null>(null);

  const api = window.cloudDeployment;
  const showFeedback = useCallback((nextFeedback: Feedback): void => {
    if (nextFeedback.tone === "danger") {
      setFeedback(nextFeedback);
      return;
    }
    setFeedback(null);
    const options = {
      description: nextFeedback.detail,
      timeout: FEEDBACK_TOAST_TIMEOUT_MS,
    };
    if (nextFeedback.tone === "success") toast.success(nextFeedback.title, options);
    else if (nextFeedback.tone === "warning") toast.warning(nextFeedback.title, options);
    else toast.info(nextFeedback.title, options);
  }, []);
  const applyNavigationRequest = useCallback((request: CloudDeploymentNavigationRequest): void => {
    setSelectedTab("deployments");
    setFeedback(null);
    setOperatorDeploymentId(null);
    if (request.view === "firewall") {
      setActionRequest(null);
      setDetailsDeploymentId(request.deploymentId);
    } else {
      setDetailsDeploymentId(null);
      setActionRequest(request);
    }
  }, []);
  const handleNavigationRequest = useCallback((request: CloudDeploymentNavigationRequest): void => {
    const active = activeCardAction.current;
    if (active) {
      if (
        request.view === "deployments" &&
        request.deploymentId === active.deploymentId &&
        request.action === active.action
      ) return;
      queuedNavigationRequest.current = request;
      return;
    }
    applyNavigationRequest(request);
  }, [applyNavigationRequest]);
  const beginCardAction = useCallback((deploymentId: string, action: CloudDeploymentCardAction): boolean => {
    if (activeCardAction.current) return false;
    activeCardAction.current = { deploymentId, action };
    return true;
  }, []);
  const finishCardAction = useCallback((deploymentId: string, action: CloudDeploymentCardAction): void => {
    const active = activeCardAction.current;
    if (!active || active.deploymentId !== deploymentId || active.action !== action) return;
    activeCardAction.current = null;
    const queued = queuedNavigationRequest.current;
    queuedNavigationRequest.current = null;
    if (queued) applyNavigationRequest(queued);
  }, [applyNavigationRequest]);
  const closeOperatorForm = useCallback((): void => {
    if (operatorDeploymentId) pendingOperatorReturnFocus.current = operatorDeploymentId;
    setOperatorDeploymentId(null);
  }, [operatorDeploymentId]);

  useEffect(() => {
    if (operatorDeploymentId !== null) return;
    const deploymentId = pendingOperatorReturnFocus.current;
    if (!deploymentId) return;
    pendingOperatorReturnFocus.current = null;
    document.querySelector<HTMLButtonElement>(`[data-new-operator-trigger="${deploymentId}"]`)?.focus();
  }, [operatorDeploymentId]);
  const refresh = useCallback((requestedScope: CloudDeploymentChangeScope = "snapshot"): Promise<void> => {
    const initialScope = snapshotRef.current ? requestedScope : "snapshot";
    if (refreshInFlight.current) {
      refreshQueued.current = strongerRefreshScope(refreshQueued.current, initialScope);
      return refreshInFlight.current;
    }
    const request = (async () => {
      let scope: CloudDeploymentChangeScope | null = initialScope;
      let showedLoading = false;
      try {
        while (scope && mounted.current) {
          const activeScope = scope;
          refreshQueued.current = null;
          if (!snapshotRef.current && !showedLoading) {
            showedLoading = true;
            setIsLoading(true);
          }
          if (!api) {
            setLoadError({
              scope: "snapshot",
              message: "The secure Cloud Deployment bridge is unavailable. Restart the application and try again.",
            });
            return;
          }
          try {
            if (activeScope === "snapshot" || !snapshotRef.current) {
              const providerVersion = providerRefreshVersion.current;
              const result = await api.getSnapshot();
              if (!mounted.current) return;
              if (!result.ok || !result.value) {
                setLoadError({
                  scope: "snapshot",
                  message: result.error ?? "Cloud Deployment state could not be loaded.",
                });
              } else {
                const current = snapshotRef.current;
                const keepProviderState = current && (
                  result.value.state.revision < current.state.revision ||
                  (providerVersion !== providerRefreshVersion.current && result.value.state.revision === current.state.revision)
                );
                const updated = keepProviderState
                  ? { ...result.value, state: current.state, refreshErrors: current.refreshErrors }
                  : result.value;
                snapshotRef.current = updated;
                setSnapshot(updated);
                localSnapshotVersion.current += 1;
                setLoadError(null);
                setProviderRefreshError(null);
              }
            } else {
              const result = await api.getProvisioningTranscripts();
              if (!mounted.current) return;
              if (!result.ok || !result.value) {
                setLoadError((current) => current?.scope === "snapshot"
                  ? current
                  : {
                      scope: "transcripts",
                      message: result.error ?? "Cloud provisioning output could not be loaded.",
                    });
              } else {
                const current = snapshotRef.current;
                if (current) {
                  const updated = Object.freeze({
                    ...current,
                    provisioningTranscripts: result.value.provisioningTranscripts,
                  });
                  snapshotRef.current = updated;
                  setSnapshot(updated);
                  setLoadError((failure) => failure?.scope === "transcripts" ? null : failure);
                }
              }
            }
          } catch (error) {
            if (!mounted.current) return;
            const message = errorMessage(error);
            setLoadError((current) => activeScope === "transcripts" && current?.scope === "snapshot"
              ? current
              : { scope: activeScope, message });
          }
          scope = refreshQueued.current;
        }
      } finally {
        if (showedLoading && mounted.current) setIsLoading(false);
      }
    })().finally(() => {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
    });
    refreshInFlight.current = request;
    return request;
  }, [api]);

  const refreshProvider = useCallback((): Promise<void> => {
    if (!api || !mounted.current || !snapshotRef.current || document.visibilityState === "hidden") return Promise.resolve();
    if (providerRefreshInFlight.current) return providerRefreshInFlight.current;
    const snapshotVersion = localSnapshotVersion.current;
    setIsRefreshingProvider(true);
    const request = (async () => {
      try {
        const result = await api.refreshDeployments();
        if (!mounted.current) return;
        if (!result.ok || !result.value) {
          if (snapshotVersion === localSnapshotVersion.current) {
            setProviderRefreshError(result.error ?? "Provider status could not be refreshed.");
          }
          return;
        }
        const current = snapshotRef.current;
        if (current && (result.value.state.revision > current.state.revision ||
          (result.value.state.revision === current.state.revision && snapshotVersion === localSnapshotVersion.current))) {
          const updated = { ...current, state: result.value.state, refreshErrors: result.value.refreshErrors };
          providerRefreshVersion.current += 1;
          snapshotRef.current = updated;
          setSnapshot(updated);
        }
        setProviderRefreshError(null);
      } catch (error) {
        if (mounted.current && snapshotVersion === localSnapshotVersion.current) {
          setProviderRefreshError(errorMessage(error));
        }
      } finally {
        if (mounted.current) setIsRefreshingProvider(false);
      }
    })().finally(() => {
      if (providerRefreshInFlight.current === request) providerRefreshInFlight.current = null;
    });
    providerRefreshInFlight.current = request;
    return request;
  }, [api]);

  const refreshAll = useCallback(async (): Promise<void> => {
    await refresh();
    await refreshProvider();
  }, [refresh, refreshProvider]);

  useEffect(() => {
    mounted.current = true;
    document.title = "Cloud Deployment";
    const removeThemeListener = api?.onThemeChanged(applyRendererTheme);
    const removeChangedListener = api?.onChanged((scope) => void refresh(scope));
    const removeNavigationListener = api?.onNavigationRequested(handleNavigationRequest);
    void refreshAll();
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = (): void => {
      if (timer !== undefined) clearInterval(timer);
      timer = document.visibilityState === "hidden"
        ? undefined
        : setInterval(() => void refreshProvider(), CLOUD_PROVIDER_POLL_INTERVAL_MS);
    };
    const regainVisibility = (): void => {
      schedule();
      if (document.visibilityState !== "hidden") void refreshProvider();
    };
    const regainFocus = (): void => {
      if (document.visibilityState !== "hidden") void refreshProvider();
    };
    schedule();
    document.addEventListener("visibilitychange", regainVisibility);
    window.addEventListener("focus", regainFocus);
    return () => {
      mounted.current = false;
      refreshQueued.current = null;
      if (timer !== undefined) clearInterval(timer);
      document.removeEventListener("visibilitychange", regainVisibility);
      window.removeEventListener("focus", regainFocus);
      removeThemeListener?.();
      removeChangedListener?.();
      removeNavigationListener?.();
    };
  }, [api, handleNavigationRequest, refresh, refreshAll, refreshProvider]);

  useEffect(() => {
    if (!snapshot) return;
    if (actionRequest && !snapshot.state.deployments.some(({ id }) => id === actionRequest.deploymentId)) {
      setActionRequest(null);
      setFeedback({
        tone: "danger",
        title: "Cloud action unavailable",
        detail: `The requested deployment (${actionRequest.deploymentId}) is no longer in the managed inventory.`,
      });
    }
    if (detailsDeploymentId && !snapshot.state.deployments.some(({ id }) => id === detailsDeploymentId)) {
      setDetailsDeploymentId(null);
      setFeedback({
        tone: "danger",
        title: "Deployment unavailable",
        detail: `The requested deployment (${detailsDeploymentId}) is no longer in the managed inventory.`,
      });
    }
    if (operatorDeploymentId && !snapshot.state.deployments.some(({ id }) => id === operatorDeploymentId)) {
      setOperatorDeploymentId(null);
      setFeedback({
        tone: "danger",
        title: "Deployment unavailable",
        detail: `The requested deployment (${operatorDeploymentId}) is no longer in the managed inventory.`,
      });
    }
  }, [actionRequest, detailsDeploymentId, operatorDeploymentId, snapshot]);

  const detailsDeployment = detailsDeploymentId
    ? snapshot?.state.deployments.find(({ id }) => id === detailsDeploymentId)
    : undefined;
  const operatorDeployment = operatorDeploymentId
    ? snapshot?.state.deployments.find(({ id }) => id === operatorDeploymentId)
    : undefined;
  const showingDetails = detailsDeployment !== undefined || operatorDeployment !== undefined;
  const refreshFailureMessage = loadError?.message ?? providerRefreshError;
  const detailsRefreshError = snapshot?.refreshErrors.find(({ deploymentId }) => deploymentId === detailsDeploymentId)?.message;

  return (
    <AuxiliaryWindowFrame className={`bg-background text-foreground ${showingDetails ? "overflow-hidden" : "overflow-y-auto"}`}>
      <div className={`auxiliary-window-content mx-auto flex w-full max-w-7xl flex-col px-6 lg:px-8 ${showingDetails ? "h-full min-h-0" : "gap-6 pb-12"}`}>
        {!showingDetails ? (
          <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
                <FontAwesomeIcon aria-hidden icon={faCloudArrowUp} className="size-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Cloud Deployment</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                  Provision and operate tagged Sliver multiplayer servers on AWS EC2 or Microsoft Azure.
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Tooltip delay={0}>
                <Button
                  aria-label="Refresh cloud deployments"
                  isDisabled={isLoading || isRefreshingProvider}
                  isIconOnly
                  variant="outline"
                  onPress={() => void refreshAll()}
                >
                  <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={isLoading || isRefreshingProvider ? "animate-spin" : ""} />
                </Button>
                <Tooltip.Content>Refresh cloud deployments</Tooltip.Content>
              </Tooltip>
            </div>
          </header>
        ) : null}

        {!showingDetails && feedback ? <FeedbackBanner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}
        {isLoading && !snapshot ? <LoadingSurface /> : null}
        {loadError && !snapshot ? <LoadError message={loadError.message} onRetry={() => void refreshAll()} /> : null}
        {!showingDetails && refreshFailureMessage && snapshot ? (
          <InlineMessage
            tone="warning"
            title="Refresh failed"
            detail={`${refreshFailureMessage} The last successfully loaded deployment data remains visible.`}
          />
        ) : null}

        {snapshot && api && operatorDeployment ? (
          <NewOperatorForm
            api={api}
            deployment={operatorDeployment}
            key={operatorDeployment.id}
            mutationLock={operatorMutationLocks[operatorDeployment.id]}
            revision={snapshot.state.revision}
            onBeginMutation={() => beginCardAction(operatorDeployment.id, "operator")}
            onBack={closeOperatorForm}
            onFeedback={showFeedback}
            onFinishMutation={() => finishCardAction(operatorDeployment.id, "operator")}
            onMutationBlocked={(lock) => {
              setOperatorMutationLocks((current) => ({ ...current, [operatorDeployment.id]: lock }));
            }}
          />
        ) : snapshot && api && detailsDeployment ? (
          detailsDeployment.provider === "aws" ? (
            <AwsInstanceDetails
              api={api}
              deployment={detailsDeployment}
              key={detailsDeployment.id}
              notices={(
                <>
                  {feedback ? <FeedbackBanner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}
                  {refreshFailureMessage ? (
                    <InlineMessage
                      tone="warning"
                      title="Refresh failed"
                      detail={`${refreshFailureMessage} The last successfully loaded deployment data remains visible.`}
                    />
                  ) : null}
                  {detailsRefreshError ? <InlineMessage tone="warning" title="Status refresh failed" detail={detailsRefreshError} /> : null}
                </>
              )}
              revision={snapshot.state.revision}
              onBack={() => setDetailsDeploymentId(null)}
              onFeedback={showFeedback}
              onRefresh={refresh}
            />
          ) : (
            <AzureInstanceDetails
              api={api}
              deployment={detailsDeployment}
              key={detailsDeployment.id}
              notices={(
                <>
                  {feedback ? <FeedbackBanner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}
                  {refreshFailureMessage ? (
                    <InlineMessage
                      tone="warning"
                      title="Refresh failed"
                      detail={`${refreshFailureMessage} The last successfully loaded deployment data remains visible.`}
                    />
                  ) : null}
                  {detailsRefreshError ? <InlineMessage tone="warning" title="Status refresh failed" detail={detailsRefreshError} /> : null}
                </>
              )}
              revision={snapshot.state.revision}
              onBack={() => setDetailsDeploymentId(null)}
              onFeedback={showFeedback}
              onRefresh={refresh}
            />
          )
        ) : snapshot && api ? (
          <Tabs
            selectedKey={selectedTab}
            variant="secondary"
            onSelectionChange={(key) => setSelectedTab(String(key))}
          >
            <Tabs.ListContainer className="w-fit max-w-full">
              <Tabs.List aria-label="Cloud Deployment sections">
                <Tabs.Tab id="deployments">
                  Deployments
                  <Chip className="ml-1" size="sm" variant="soft">{snapshot.state.deployments.length}</Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="credentials">
                  Credentials
                  <Chip className="ml-1" size="sm" variant="soft">{snapshot.credentials.length}</Chip>
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel className="pt-6" id="deployments">
              <DeploymentsPanel
                actionRequest={actionRequest}
                api={api}
                snapshot={snapshot}
                onActionRequestHandled={(request) => {
                  setActionRequest((current) => current === request ? null : current);
                }}
                onBeginCardAction={beginCardAction}
                onFinishCardAction={finishCardAction}
                onFeedback={showFeedback}
                onOpenDetails={(deploymentId) => {
                  setFeedback(null);
                  setOperatorDeploymentId(null);
                  setDetailsDeploymentId(deploymentId);
                }}
                onOpenNewOperator={(deploymentId) => {
                  setActionRequest(null);
                  setFeedback(null);
                  setDetailsDeploymentId(null);
                  setOperatorDeploymentId(deploymentId);
                }}
                onRefresh={refresh}
                onShowCredentials={() => setSelectedTab("credentials")}
              />
            </Tabs.Panel>
            <Tabs.Panel className="pt-6" id="credentials">
              <CredentialsPanel
                api={api}
                snapshot={snapshot}
                onFeedback={showFeedback}
                onRefresh={refresh}
              />
            </Tabs.Panel>
          </Tabs>
        ) : null}
      </div>
    </AuxiliaryWindowFrame>
  );
}

function DeploymentsPanel({
  actionRequest,
  api,
  snapshot,
  onActionRequestHandled,
  onBeginCardAction,
  onFinishCardAction,
  onFeedback,
  onOpenDetails,
  onOpenNewOperator,
  onRefresh,
  onShowCredentials,
}: {
  readonly actionRequest: CloudDeploymentActionRequest | null;
  readonly api: CloudDeploymentAPI;
  readonly snapshot: CloudDeploymentSnapshot;
  readonly onActionRequestHandled: (request: CloudDeploymentActionRequest) => void;
  readonly onBeginCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => boolean;
  readonly onFinishCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onOpenDetails: (deploymentId: string) => void;
  readonly onOpenNewOperator: (deploymentId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onShowCredentials: () => void;
}): React.JSX.Element {
  const [showWizard, setShowWizard] = useState(false);
  const [wizardBusy, setWizardBusy] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
  const resumedDeployment = showWizard
    ? undefined
    : snapshot.state.deployments.find(({ status }) => status === "provisioning");
  const resumedTranscript = resumedDeployment
    ? snapshot.provisioningTranscripts.find(({ deploymentId }) => deploymentId === resumedDeployment.id)
    : undefined;
  const displayedDeploymentId = activeDeploymentId ?? resumedDeployment?.id ?? null;
  const visibleDeployments = snapshot.state.deployments.filter((deployment) =>
    deployment.id !== displayedDeploymentId &&
    !(showWizard && wizardBusy && activeDeploymentId === null && deployment.status === "provisioning")
  );
  const deploymentInProgress = wizardBusy || resumedDeployment !== undefined;

  useEffect(() => {
    if (!actionRequest || !showWizard || wizardBusy) return;
    setShowWizard(false);
    setActiveDeploymentId(null);
  }, [actionRequest, showWizard, wizardBusy]);

  const closeWizard = (): void => {
    setShowWizard(false);
    setWizardBusy(false);
    setActiveDeploymentId(null);
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold">Managed Servers</h2>
          <p className="mt-1 text-sm text-muted">Provider resources are tracked by a unique management ID before any lifecycle action.</p>
        </div>
        <Button
          isDisabled={deploymentInProgress}
          variant={showWizard ? "tertiary" : "primary"}
          onPress={() => {
            if (showWizard) closeWizard();
            else setShowWizard(true);
          }}
        >
          {deploymentInProgress ? "Deployment in progress" : showWizard ? "Close Setup" : "New Deployment"}
        </Button>
      </section>

      {resumedDeployment ? (
        <DeploymentCard
          actionRequest={actionRequest?.deploymentId === resumedDeployment.id ? actionRequest : null}
          api={api}
          credential={snapshot.credentials.find(({ id }) => id === resumedDeployment.credentialId)}
          deployment={resumedDeployment}
          hasSshCredential={snapshot.credentials.some(({ id, provider }) => (
            id === resumedDeployment.credentialId && provider === resumedDeployment.provider
          ))}
          isDeploymentView
          revision={snapshot.state.revision}
          refreshError={snapshot.refreshErrors.find(({ deploymentId }) => deploymentId === resumedDeployment.id)?.message}
          {...(resumedTranscript ? { transcript: resumedTranscript } : {})}
          onFeedback={onFeedback}
          onActionRequestHandled={onActionRequestHandled}
          onBeginCardAction={onBeginCardAction}
          onFinishCardAction={onFinishCardAction}
          onOpenDetails={() => onOpenDetails(resumedDeployment.id)}
          onOpenNewOperator={() => onOpenNewOperator(resumedDeployment.id)}
          onRefresh={onRefresh}
        />
      ) : null}

      {showWizard ? (
        <DeploymentWizard
          api={api}
          snapshot={snapshot}
          onActiveDeploymentChange={setActiveDeploymentId}
          onActivityChange={setWizardBusy}
          onBeginCardAction={onBeginCardAction}
          onCancel={closeWizard}
          onCreated={async (name) => {
            closeWizard();
            onFeedback({ tone: "success", title: "Deployment ready", detail: `${name} is running and its operator configuration is available to the GUI.` });
            await onRefresh();
          }}
          onFeedback={onFeedback}
          onFinishCardAction={onFinishCardAction}
          onRefresh={onRefresh}
          onShowCredentials={onShowCredentials}
        />
      ) : null}

      {visibleDeployments.length === 0 && !showWizard && !resumedDeployment ? (
        <EmptyState className="min-h-72 rounded-2xl bg-surface-secondary">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <FontAwesomeIcon aria-hidden icon={faServer} className="size-5 text-accent" />
            </EmptyState.Media>
            <EmptyState.Title>No Managed Servers</EmptyState.Title>
            <EmptyState.Description>Add provider credentials, then launch a tagged Sliver multiplayer server.</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            <Button variant="outline" onPress={onShowCredentials}>Manage Credentials</Button>
          </EmptyState.Content>
        </EmptyState>
      ) : !showWizard ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {visibleDeployments.map((deployment) => (
            <DeploymentCard
              actionRequest={actionRequest?.deploymentId === deployment.id ? actionRequest : null}
              api={api}
              credential={snapshot.credentials.find(({ id }) => id === deployment.credentialId)}
              deployment={deployment}
              hasSshCredential={snapshot.credentials.some(({ id, provider }) => (
                id === deployment.credentialId && provider === deployment.provider
              ))}
              key={deployment.id}
              revision={snapshot.state.revision}
              refreshError={snapshot.refreshErrors.find(({ deploymentId }) => deploymentId === deployment.id)?.message}
              onFeedback={onFeedback}
              onActionRequestHandled={onActionRequestHandled}
              onBeginCardAction={onBeginCardAction}
              onFinishCardAction={onFinishCardAction}
              onOpenDetails={() => onOpenDetails(deployment.id)}
              onOpenNewOperator={() => onOpenNewOperator(deployment.id)}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeploymentWizard({
  api,
  snapshot,
  onCancel,
  onActiveDeploymentChange,
  onActivityChange,
  onBeginCardAction,
  onCreated,
  onFeedback,
  onFinishCardAction,
  onRefresh,
  onShowCredentials,
}: {
  readonly api: CloudDeploymentAPI;
  readonly snapshot: CloudDeploymentSnapshot;
  readonly onCancel: () => void;
  readonly onActiveDeploymentChange: (deploymentId: string | null) => void;
  readonly onActivityChange: (active: boolean) => void;
  readonly onBeginCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => boolean;
  readonly onCreated: (name: string) => Promise<void>;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onFinishCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onShowCredentials: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [provider, setProvider] = useState<CloudProvider>("aws");
  const [credentialId, setCredentialId] = useState(firstCredentialId(snapshot.credentials, "aws"));
  const [name, setName] = useState("");
  const [operatorName, setOperatorName] = useState("operator");
  const [sshPort, setSshPort] = useState("22");
  const [multiplayerPort, setMultiplayerPort] = useState("31337");
  const [sshCidrs, setSshCidrs] = useState("");
  const [operatorCidrs, setOperatorCidrs] = useState("");
  const [egressIpv4Detection, setEgressIpv4Detection] = useState<EgressIpv4Detection>({ status: "loading" });
  const [useElasticIp, setUseElasticIp] = useState(true);
  const [usePublicIp, setUsePublicIp] = useState(true);
  const [aws, setAws] = useState<AwsDeploymentDraft>(INITIAL_AWS_DEPLOYMENT);
  const [awsOptions, setAwsOptions] = useState<AwsDeploymentOptions | null>(null);
  const [awsOptionsError, setAwsOptionsError] = useState<string | null>(null);
  const [isLoadingAwsOptions, setIsLoadingAwsOptions] = useState(false);
  const [awsDiscoveryAttempt, setAwsDiscoveryAttempt] = useState(0);
  const [azure, setAzure] = useState<AzureDeploymentDraft>(INITIAL_AZURE_DEPLOYMENT);
  const [azureOptions, setAzureOptions] = useState<AzureDeploymentOptions | null>(null);
  const [azureOptionsError, setAzureOptionsError] = useState<string | null>(null);
  const [isLoadingAzureOptions, setIsLoadingAzureOptions] = useState(false);
  const [azureDiscoveryAttempt, setAzureDiscoveryAttempt] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deploymentStarted, setDeploymentStarted] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
  const deploymentBaseline = useRef<ReadonlySet<string>>(new Set());
  const awsDiscoverySequence = useRef(0);
  const azureOptionsDiscoverySequence = useRef(0);
  const sshCidrsTouched = useRef(false);
  const operatorCidrsTouched = useRef(false);

  const credentials = snapshot.credentials.filter((credential) => credential.provider === provider);
  const chosenCredential = snapshot.credentials.find((credential) => credential.id === credentialId);
  const region = awsRegion(chosenCredential);
  const location = azureLocation(chosenCredential);
  const effectiveSshPort = provider === "azure" ? String(AZURE_SSH_PORT) : sshPort;
  const transcript = activeDeploymentId
    ? snapshot.provisioningTranscripts.find(({ deploymentId }) => deploymentId === activeDeploymentId)
    : undefined;
  const activeDeployment = activeDeploymentId
    ? snapshot.state.deployments.find(({ id }) => id === activeDeploymentId)
    : undefined;

  useEffect(() => {
    if (!deploymentStarted || activeDeploymentId) return;
    const transcriptMatch = snapshot.provisioningTranscripts.find(
      ({ deploymentId }) => !deploymentBaseline.current.has(deploymentId),
    );
    const deploymentMatch = transcriptMatch
      ? snapshot.state.deployments.find(({ id }) => id === transcriptMatch.deploymentId)
      : snapshot.state.deployments.find((deployment) =>
          !deploymentBaseline.current.has(deployment.id) &&
          deployment.name === name.trim() &&
          deployment.provider === provider &&
          deployment.credentialId === credentialId
        );
    if (!deploymentMatch) return;
    setActiveDeploymentId(deploymentMatch.id);
    onActiveDeploymentChange(deploymentMatch.id);
  }, [
    activeDeploymentId,
    credentialId,
    deploymentStarted,
    name,
    onActiveDeploymentChange,
    provider,
    snapshot.provisioningTranscripts,
    snapshot.state.deployments,
  ]);

  useEffect(() => {
    let isActive = true;
    void api.detectCurrentEgressIpv4().then((result) => {
      if (!isActive) return;
      if (!result.ok || !result.value) {
        setEgressIpv4Detection({
          status: "failed",
          error: result.error
            ? `${result.error} Enter the source CIDRs manually before continuing.`
            : "Enter the source CIDRs manually before continuing.",
        });
        return;
      }

      const cidr = result.value.cidr;
      if (!sshCidrsTouched.current) {
        setSshCidrs((current) => current.trim().length === 0 ? cidr : current);
      }
      if (!operatorCidrsTouched.current) {
        setOperatorCidrs((current) => current.trim().length === 0 ? cidr : current);
      }
      setEgressIpv4Detection({ status: "success", cidr });
    }).catch(() => {
      if (!isActive) return;
      setEgressIpv4Detection({
        status: "failed",
        error: "Enter the source CIDRs manually before continuing.",
      });
    });

    return () => {
      isActive = false;
    };
  }, [api]);

  useEffect(() => {
    if (step !== 1 || provider !== "aws" || !credentialId || !region) return;
    const sequence = awsDiscoverySequence.current + 1;
    awsDiscoverySequence.current = sequence;
    setAwsOptions(null);
    setAwsOptionsError(null);
    setIsLoadingAwsOptions(true);
    void api.discoverAwsOptions({ credentialId, region }).then((result) => {
      if (awsDiscoverySequence.current !== sequence) return;
      if (!result.ok || !result.value) {
        setAwsOptionsError(result.error ?? "AWS infrastructure options could not be loaded.");
        return;
      }
      setAwsOptions(result.value);
      setAws((current) => reconcileAwsDraft(current, result.value));
    }).catch((error: unknown) => {
      if (awsDiscoverySequence.current === sequence) setAwsOptionsError(errorMessage(error));
    }).finally(() => {
      if (awsDiscoverySequence.current === sequence) setIsLoadingAwsOptions(false);
    });
    return () => {
      if (awsDiscoverySequence.current === sequence) awsDiscoverySequence.current += 1;
    };
  }, [api, awsDiscoveryAttempt, credentialId, provider, region, step]);

  useEffect(() => {
    if (step !== 1 || provider !== "azure" || !credentialId || !location) return;
    const sequence = azureOptionsDiscoverySequence.current + 1;
    azureOptionsDiscoverySequence.current = sequence;
    setAzureOptions(null);
    setAzureOptionsError(null);
    setIsLoadingAzureOptions(true);
    void api.discoverAzureOptions({ credentialId, location }).then((result) => {
      if (azureOptionsDiscoverySequence.current !== sequence) return;
      if (!result.ok || !result.value) {
        setAzureOptionsError(result.error ?? "Azure infrastructure options could not be loaded.");
        return;
      }
      setAzureOptions(result.value);
      setAzure((current) => reconcileAzureDraft(current, result.value));
    }).catch((error: unknown) => {
      if (azureOptionsDiscoverySequence.current === sequence) setAzureOptionsError(errorMessage(error));
    }).finally(() => {
      if (azureOptionsDiscoverySequence.current === sequence) setIsLoadingAzureOptions(false);
    });
    return () => {
      if (azureOptionsDiscoverySequence.current === sequence) azureOptionsDiscoverySequence.current += 1;
    };
  }, [api, azureDiscoveryAttempt, credentialId, location, provider, step]);

  const changeProvider = (nextProvider: CloudProvider): void => {
    setProvider(nextProvider);
    setCredentialId(firstCredentialId(snapshot.credentials, nextProvider));
    setValidationError(null);
  };

  const currentValidationValues = {
    provider,
    credentialId,
    name,
    operatorName,
    sshPort: effectiveSshPort,
    multiplayerPort,
    sshCidrs,
    operatorCidrs,
    aws,
    awsOptions,
    azure,
    azureOptions,
    location,
  };

  const next = (): void => {
    const error = validateDeploymentStep(step, currentValidationValues);
    if (error) {
      setValidationError(error);
      return;
    }
    setValidationError(null);
    setStep((value) => Math.min(3, value + 1));
  };

  const create = async (): Promise<void> => {
    const error = validateDeploymentStep(2, currentValidationValues);
    if (error) {
      setValidationError(error);
      setStep(error.includes("CIDR") || error.includes("port") ? 2 : 1);
      return;
    }

    const input = deploymentInput({
      provider,
      credentialId,
      expectedRevision: snapshot.state.revision,
      name: name.trim(),
      operatorName: operatorName.trim(),
      region,
      location,
      sshPort: Number(effectiveSshPort),
      multiplayerPort: Number(multiplayerPort),
      sshCidrs: parseCidrs(sshCidrs),
      operatorCidrs: parseCidrs(operatorCidrs),
      useElasticIp,
      usePublicIp,
      aws,
      azure,
    });

    deploymentBaseline.current = new Set(snapshot.state.deployments.map(({ id }) => id));
    setActiveDeploymentId(null);
    onActiveDeploymentChange(null);
    setDeploymentStarted(true);
    setStep(3);
    setIsCreating(true);
    onActivityChange(true);
    try {
      const result = await api.createDeployment(input);
      if (!result.ok || !result.value) {
        setValidationError(result.error ?? "The deployment request was rejected.");
        return;
      }
      await onCreated(input.name);
    } catch (caught) {
      const detail = errorMessage(caught);
      setValidationError(detail);
      onFeedback({ tone: "danger", title: "Deployment failed", detail });
    } finally {
      setIsCreating(false);
      onActivityChange(false);
    }
  };

  if (deploymentStarted) {
    if (activeDeployment) {
      return (
        <DeploymentCard
          api={api}
          credential={snapshot.credentials.find(({ id }) => id === activeDeployment.credentialId)}
          deployment={activeDeployment}
          hasSshCredential={snapshot.credentials.some(({ id, provider: credentialProvider }) => (
            id === activeDeployment.credentialId && credentialProvider === activeDeployment.provider
          ))}
          isDeploymentView
          revision={snapshot.state.revision}
          refreshError={snapshot.refreshErrors.find(({ deploymentId }) => deploymentId === activeDeployment.id)?.message}
          {...(transcript ? { transcript } : {})}
          onBeginCardAction={onBeginCardAction}
          onFeedback={onFeedback}
          onFinishCardAction={onFinishCardAction}
          onRefresh={onRefresh}
          onTerminated={onCancel}
        />
      );
    }
    return (
      <PendingDeploymentCard
        error={validationError}
        name={name.trim() || "New server"}
        provider={provider}
      />
    );
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>New Deployment</Card.Title>
        <Card.Description>Review the provider, infrastructure, and ingress policy before provisioning.</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-6">
        <DeploymentStepper
          currentStep={step}
          onStepChange={(nextStep) => {
            if (nextStep < step) {
              setStep(nextStep);
              setValidationError(null);
            }
          }}
        />

        {validationError ? <InlineMessage tone="danger" title="Check this step" detail={validationError} /> : null}

        {step === 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <CloudNativeSelect
              label="Provider"
              value={provider}
              options={[
                { value: "aws", label: "AWS EC2" },
                { value: "azure", label: "Microsoft Azure" },
              ]}
              onChange={(value) => {
                if (value === "aws" || value === "azure") changeProvider(value);
              }}
            />
            <CloudNativeSelect
              description={credentials.length === 0 ? "Add credentials before continuing." : undefined}
              label="Credential"
              value={credentialId}
              options={credentials.map((credential) => ({ value: credential.id, label: credential.label }))}
              placeholder="Choose a credential"
              onChange={setCredentialId}
            />
            <CloudTextField label="Deployment Name" placeholder="red-team-control" value={name} onChange={setName} />
            <CloudTextField
              description="Used for the generated Sliver operator profile."
              label="Operator Name"
              placeholder="operator"
              value={operatorName}
              onChange={setOperatorName}
            />
            {credentials.length === 0 ? (
              <Button className="md:col-span-2 md:w-fit" variant="outline" onPress={onShowCredentials}>
                Add {providerLabel(provider)} Credentials
              </Button>
            ) : null}
          </div>
        ) : null}

        {step === 1 && provider === "aws" ? (
          <AwsInfrastructureFields
            draft={aws}
            error={awsOptionsError}
            isLoading={isLoadingAwsOptions}
            options={awsOptions}
            region={region}
            useElasticIp={useElasticIp}
            onChange={setAws}
            onElasticIpChange={setUseElasticIp}
            onRetry={() => setAwsDiscoveryAttempt((value) => value + 1)}
          />
        ) : null}

        {step === 1 && provider === "azure" ? (
          <AzureInfrastructureFields
            draft={azure}
            error={azureOptionsError}
            isLoading={isLoadingAzureOptions}
            location={location}
            options={azureOptions}
            usePublicIp={usePublicIp}
            onChange={setAzure}
            onPublicIpChange={setUsePublicIp}
            onRetry={() => setAzureDiscoveryAttempt((value) => value + 1)}
          />
        ) : null}

        {step === 2 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              {egressIpv4Detection.status === "loading" ? (
                <InlineMessage
                  tone="info"
                  title="Detecting current egress IPv4"
                  detail="The detected address will be added to both source lists as a /32."
                />
              ) : null}
              {egressIpv4Detection.status === "success" ? (
                <InlineMessage
                  tone="success"
                  title="Current egress IPv4 detected"
                  detail={`${egressIpv4Detection.cidr} was added to any empty, untouched source lists. You can edit either list before deployment.`}
                />
              ) : null}
              {egressIpv4Detection.status === "failed" ? (
                <InlineMessage
                  tone="warning"
                  title="Current egress IPv4 unavailable"
                  detail={egressIpv4Detection.error}
                />
              ) : null}
            </div>
            <CloudTextField
              description={provider === "azure" ? "Azure platform images use the standard SSH port." : undefined}
              inputMode="numeric"
              isReadOnly={provider === "azure"}
              label="SSH Port"
              value={effectiveSshPort}
              onChange={setSshPort}
            />
            <CloudTextField inputMode="numeric" label="Sliver Multiplayer Port" value={multiplayerPort} onChange={setMultiplayerPort} />
            <CloudTextArea
              description="One IPv4 or IPv6 CIDR per line. Internet-wide /0 access is not created automatically."
              label="SSH Source CIDRs"
              placeholder={"203.0.113.8/32\n2001:db8::1/128"}
              value={sshCidrs}
              onChange={(value) => {
                sshCidrsTouched.current = true;
                setSshCidrs(value);
              }}
            />
            <CloudTextArea
              description="These sources can reach the generated Sliver operator endpoint."
              label="Operator Source CIDRs"
              placeholder={"203.0.113.8/32\n2001:db8::1/128"}
              value={operatorCidrs}
              onChange={(value) => {
                operatorCidrsTouched.current = true;
                setOperatorCidrs(value);
              }}
            />
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <ReviewGroup title="Identity" rows={[
              ["Name", name.trim()],
              ["Provider", providerLabel(provider)],
              ["Credential", chosenCredential?.label ?? "Not selected"],
              ["Operator", operatorName.trim()],
            ]} />
            <ReviewGroup title="Network Policy" rows={[
              ["SSH", `TCP ${effectiveSshPort} · ${parseCidrs(sshCidrs).length} source${parseCidrs(sshCidrs).length === 1 ? "" : "s"}`],
              ["Multiplayer", `TCP ${multiplayerPort} · ${parseCidrs(operatorCidrs).length} source${parseCidrs(operatorCidrs).length === 1 ? "" : "s"}`],
              ["Stable Address", provider === "aws"
                ? (useElasticIp ? "Elastic IP" : "Private instance address")
                : (usePublicIp ? "Azure public IP" : "Private VM address")],
            ]} />
            <div className="md:col-span-2">
              <InlineMessage
                tone="info"
                title="What happens next"
                detail="The provider assets are tagged with a unique management ID, Sliver is installed as a Linux daemon, and the generated operator config is copied into the local GUI config directory."
              />
            </div>
          </div>
        ) : null}
      </Card.Content>
      <Card.Footer className="flex justify-between gap-3">
        <Button variant="tertiary" onPress={step === 0 ? onCancel : () => { setStep((value) => Math.max(0, value - 1)); setValidationError(null); }}>
          {step === 0 ? "Cancel" : "Back"}
        </Button>
        {step < 3 ? (
          <Button
            isDisabled={
              (step === 0 && credentials.length === 0) ||
              (step === 1 && provider === "aws" && (isLoadingAwsOptions || Boolean(awsOptionsError) || !awsOptions)) ||
              (step === 1 && provider === "azure" && (isLoadingAzureOptions || Boolean(azureOptionsError) || !azureOptions))
            }
            variant="primary"
            onPress={next}
          >
            Continue
          </Button>
        ) : (
          <Button isPending={isCreating} variant="primary" onPress={() => void create()}>Deploy Sliver Server</Button>
        )}
      </Card.Footer>
    </Card>
  );
}

function DeploymentStepper({
  currentStep,
  onStepChange,
}: {
  readonly currentStep: number;
  readonly onStepChange?: (step: number) => void;
}): React.JSX.Element {
  return (
    <Stepper
      aria-label="Deployment setup progress"
      className="w-full"
      currentStep={currentStep}
      {...(onStepChange ? { onStepChange } : {})}
    >
      {[
        ["Provider", "Account"],
        ["Infrastructure", "Compute"],
        ["Access", "Firewall"],
        ["Deployment", "Provision"],
      ].map(([title, description]) => (
        <Stepper.Step key={title}>
          <Stepper.Indicator />
          <Stepper.Content>
            <Stepper.Title>{title}</Stepper.Title>
            <Stepper.Description>{description}</Stepper.Description>
          </Stepper.Content>
          <Stepper.Separator />
        </Stepper.Step>
      ))}
    </Stepper>
  );
}

function PendingDeploymentCard({
  error,
  name,
  provider,
}: {
  readonly error: string | null;
  readonly name: string;
  readonly provider: CloudProvider;
}): React.JSX.Element {
  return (
    <Card>
      <Card.Header className="flex-row items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-tertiary text-muted">
          <FontAwesomeIcon aria-hidden icon={providerIcon(provider)} />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{name}</Card.Title>
          <Card.Description>{providerLabel(provider)} · Preparing managed resources</Card.Description>
        </div>
        <Chip color={error ? "danger" : "warning"} size="sm" variant="soft">
          {error ? "Failed" : "Provisioning"}
        </Chip>
      </Card.Header>
      <Card.Content className="space-y-6">
        <DeploymentStepper currentStep={3} />
        <ProgressBar aria-label={`${name} deployment progress`} value={error ? 100 : 4}>
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="font-medium text-foreground">{error ? "Deployment failed" : "Creating deployment record"}</span>
            <ProgressBar.Output className="tabular-nums text-muted">{error ? "100%" : "4%"}</ProgressBar.Output>
          </div>
          <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
        </ProgressBar>
        {error ? <InlineMessage tone="danger" title="Deployment failed" detail={error} /> : null}
        <div className="grid h-64 place-items-center rounded-xl border border-default bg-black text-xs text-zinc-400">
          SSH output will appear after the provider status checks pass.
        </div>
      </Card.Content>
    </Card>
  );
}

function AwsInfrastructureFields({
  draft,
  error,
  isLoading,
  options,
  region,
  useElasticIp,
  onChange,
  onElasticIpChange,
  onRetry,
}: {
  readonly draft: AwsDeploymentDraft;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly options: AwsDeploymentOptions | null;
  readonly region: string;
  readonly useElasticIp: boolean;
  readonly onChange: (draft: AwsDeploymentDraft) => void;
  readonly onElasticIpChange: (selected: boolean) => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  if (isLoading) {
    return (
      <div aria-live="polite" className="grid gap-4 md:grid-cols-2">
        <p className="sr-only">Loading AWS infrastructure options</p>
        {Array.from({ length: 8 }, (_, index) => (
          <div className="space-y-2" key={index}>
            <Skeleton className="h-3 w-28 rounded-lg" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <InlineMessage tone="danger" title="AWS discovery failed" detail={error} />
        <Button variant="outline" onPress={onRetry}>Try Again</Button>
      </div>
    );
  }

  if (!options) return <div />;

  const instanceTypes = supportedInstanceTypes(options);
  const selectedInstance = instanceTypes.find(({ name }) => name === draft.instanceType);
  const images = compatibleImages(options.images, selectedInstance?.architecture);
  const selectedImage = images.find(({ id }) => id === draft.imageId);
  const selectedVpcValue = draft.networkMode === "managed" ? MANAGED_VPC_OPTION : draft.vpcId;
  const subnets = options.subnets.filter(({ vpcId }) => vpcId === draft.vpcId);
  const selectedSubnet = subnets.find(({ id }) => id === draft.subnetId);
  const usableKeyPairs = options.keyPairs.filter(({ isCredentialMatch }) => isCredentialMatch);
  const selectedKeyValue = draft.sshKeyMode === "managed" ? MANAGED_KEY_OPTION : draft.existingKeyPairName;
  const selectedKey = usableKeyPairs.find(({ name }) => name === draft.existingKeyPairName);

  const selectInstanceType = (instanceType: string): void => {
    const architecture = instanceTypes.find(({ name }) => name === instanceType)?.architecture;
    const nextImages = compatibleImages(options.images, architecture);
    const imageStillCompatible = nextImages.some(({ id }) => id === draft.imageId);
    const nextImage = imageStillCompatible
      ? nextImages.find(({ id }) => id === draft.imageId)
      : preferredImage(nextImages);
    onChange({
      ...draft,
      instanceType,
      imageId: nextImage?.id ?? "",
      ...(imageStillCompatible ? {} : { sshUsername: nextImage?.sshUsername ?? draft.sshUsername }),
    });
  };

  const selectVpc = (value: string): void => {
    if (value === MANAGED_VPC_OPTION) {
      onChange({ ...draft, networkMode: "managed", vpcId: "", subnetId: "" });
      return;
    }
    const nextSubnets = options.subnets.filter(({ vpcId }) => vpcId === value);
    onChange({
      ...draft,
      networkMode: "existing",
      vpcId: value,
      subnetId: nextSubnets.some(({ id }) => id === draft.subnetId)
        ? draft.subnetId
        : preferredSubnet(nextSubnets)?.id ?? "",
    });
  };

  const selectKey = (value: string | number): void => {
    if (value === MANAGED_KEY_OPTION) {
      onChange({ ...draft, sshKeyMode: "managed", existingKeyPairName: "" });
      return;
    }
    if (typeof value === "string") {
      onChange({ ...draft, sshKeyMode: "existing", existingKeyPairName: value });
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <CloudTextField isReadOnly label="Region" value={region} onChange={() => undefined} />
      <CloudRichSelect
        label="Instance Type"
        options={instanceTypes.map((instance) => ({
          value: instance.name,
          label: instance.name,
          description: `${instance.vCpuCount} vCPU · ${formatMemory(instance.memoryMiB)} · ${architectureLabel(instance.architecture)}`,
        }))}
        placeholder="Choose an instance type"
        selectedDescription={selectedInstance
          ? `${selectedInstance.vCpuCount} vCPU · ${formatMemory(selectedInstance.memoryMiB)} · ${architectureLabel(selectedInstance.architecture)}`
          : undefined}
        value={draft.instanceType}
        onChange={selectInstanceType}
      />

      <div className="flex min-h-16 items-center rounded-2xl bg-surface-secondary px-4 py-3 md:col-span-2">
        <Switch
          className="w-full justify-between"
          isSelected={draft.imageMode === "manual"}
          onChange={(manual) => onChange({ ...draft, imageMode: manual ? "manual" : "catalog" })}
        >
          <Switch.Content>
            <Label>Enter AMI manually</Label>
            <Description>Use a specific AMI ID instead of a verified Ubuntu or Amazon Linux image.</Description>
          </Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
      </div>

      {draft.imageMode === "manual" ? (
        <div className="md:col-span-2">
          <CloudTextField
            description="The AMI architecture must match the selected instance type."
            label="AMI ID"
            placeholder="ami-0123456789abcdef0"
            value={draft.manualImageId}
            onChange={(manualImageId) => onChange({ ...draft, manualImageId })}
          />
        </div>
      ) : (
        <div className="md:col-span-2">
          <CloudRichSelect
            description="Images are filtered to the selected instance architecture."
            label="Machine Image"
            options={images.map((image) => ({
              value: image.id,
              label: imageLabel(image),
              description: imageDescription(image),
            }))}
            placeholder={images.length === 0 ? "No compatible images" : "Choose an image"}
            selectedDescription={selectedImage ? imageDescription(selectedImage) : undefined}
            value={draft.imageId}
            onChange={(imageId) => {
              const image = images.find(({ id }) => id === imageId);
              onChange({ ...draft, imageId, sshUsername: image?.sshUsername ?? draft.sshUsername });
            }}
          />
        </div>
      )}

      <CloudTextField
        description={draft.imageMode === "manual"
          ? "Enter the default Linux account configured by this AMI."
          : `Expected by the selected image${selectedImage?.sshUsername ? ` (${selectedImage.sshUsername})` : ""}.`}
        label="Linux SSH Username"
        placeholder={selectedImage?.sshUsername ?? "ubuntu"}
        value={draft.sshUsername}
        onChange={(sshUsername) => onChange({ ...draft, sshUsername })}
      />

      <CloudRichSelect
        label="VPC"
        options={[
          {
            value: MANAGED_VPC_OPTION,
            label: "Create a new VPC",
            description: "Cloud Deployment creates and tags an isolated VPC and subnet.",
          },
          ...options.vpcs.map((vpc) => ({
            value: vpc.id,
            label: vpc.name ? `${vpc.name} · ${vpc.id}` : vpc.id,
            description: [vpc.cidrBlock, vpc.isDefault ? "Default VPC" : null].filter(Boolean).join(" · "),
          })),
        ]}
        placeholder="Choose a VPC"
        selectedDescription={draft.networkMode === "managed"
          ? "A new GUID-tagged network"
          : [options.vpcs.find(({ id }) => id === draft.vpcId)?.cidrBlock, options.vpcs.find(({ id }) => id === draft.vpcId)?.isDefault ? "Default VPC" : null].filter(Boolean).join(" · ")}
        value={selectedVpcValue}
        onChange={selectVpc}
      />

      {draft.networkMode === "existing" ? (
        <CloudRichSelect
          description="Only subnets from the selected VPC are shown."
          isDisabled={!draft.vpcId || subnets.length === 0}
          label="Subnet"
          options={subnets.map((subnet) => ({
            value: subnet.id,
            label: subnet.name ? `${subnet.name} · ${subnet.id}` : subnet.id,
            description: [subnet.availabilityZone, subnet.cidrBlock, subnet.mapPublicIpOnLaunch ? "Public IP on launch" : "Private addressing"].filter(Boolean).join(" · "),
          }))}
          placeholder={draft.vpcId && subnets.length === 0 ? "No subnets available" : "Choose a subnet"}
          selectedDescription={selectedSubnet
            ? [selectedSubnet.availabilityZone, selectedSubnet.cidrBlock].filter(Boolean).join(" · ")
            : undefined}
          value={draft.subnetId}
          onChange={(subnetId) => onChange({ ...draft, subnetId })}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:col-span-1 md:grid-cols-1 lg:grid-cols-2">
          <CloudTextField label="VPC CIDR" placeholder="10.0.0.0/16" value={draft.managedVpcCidr} onChange={(managedVpcCidr) => onChange({ ...draft, managedVpcCidr })} />
          <CloudTextField label="Subnet CIDR" placeholder="10.0.1.0/24" value={draft.managedSubnetCidr} onChange={(managedSubnetCidr) => onChange({ ...draft, managedSubnetCidr })} />
        </div>
      )}

      <CloudRichSelect
        description={usableKeyPairs.length === 0
          ? "No existing AWS key pair matches this credential's private key."
          : "Only AWS key pairs matching this credential's private key are available."}
        label="SSH Key"
        options={[
          {
            value: MANAGED_KEY_OPTION,
            label: "Credential key (managed)",
            description: `Import and GUID-tag the ${options.credentialKey.type} public key stored with this credential.`,
          },
          ...options.keyPairs.map((keyPair) => ({
            value: keyPair.name,
            label: keyPair.name,
            description: keyPair.isCredentialMatch
              ? [keyPair.keyType, shortFingerprint(keyPair.fingerprint), "Matches credential key"].filter(Boolean).join(" · ")
              : "Unavailable — public key does not match this credential.",
            isDisabled: !keyPair.isCredentialMatch,
          })),
        ]}
        placeholder="Choose an SSH key"
        selectedDescription={draft.sshKeyMode === "managed"
          ? "A new tagged AWS key pair"
          : [selectedKey?.keyType, shortFingerprint(selectedKey?.fingerprint), "Existing matching key"].filter(Boolean).join(" · ")}
        value={selectedKeyValue}
        onChange={selectKey}
      />

      <CloudTextField inputMode="numeric" label="Root Volume (GiB)" value={draft.volumeSizeGiB} onChange={(volumeSizeGiB) => onChange({ ...draft, volumeSizeGiB })} />

      <div className="flex min-h-16 items-center rounded-2xl bg-surface-secondary px-4 py-3 md:col-span-2">
        <Switch className="w-full justify-between" isSelected={useElasticIp} onChange={onElasticIpChange}>
          <Switch.Content>
            <Label>Elastic IP</Label>
            <Description>Keep the operator endpoint stable and publicly routable. Turn this off only when this computer can reach the VPC private address.</Description>
          </Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
      </div>
    </div>
  );
}

function AzureInfrastructureFields({
  draft,
  error,
  isLoading,
  location,
  options,
  usePublicIp,
  onChange,
  onPublicIpChange,
  onRetry,
}: {
  readonly draft: AzureDeploymentDraft;
  readonly error: string | null;
  readonly isLoading: boolean;
  readonly location: string;
  readonly options: AzureDeploymentOptions | null;
  readonly usePublicIp: boolean;
  readonly onChange: (draft: AzureDeploymentDraft) => void;
  readonly onPublicIpChange: (value: boolean) => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  if (isLoading) {
    return (
      <div aria-live="polite" className="grid gap-4 md:grid-cols-2">
        <p className="sr-only">Loading Azure infrastructure options</p>
        {Array.from({ length: 8 }, (_, index) => (
          <div className="space-y-2" key={index}>
            <Skeleton className="h-3 w-28 rounded-lg" />
            <Skeleton className="h-11 w-full rounded-xl" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-3">
        <InlineMessage tone="danger" title="Azure discovery failed" detail={error} />
        <Button variant="outline" onPress={onRetry}>Try Again</Button>
      </div>
    );
  }

  if (!options) return <div />;

  const selectedVnetValue = draft.networkMode === "managed" ? MANAGED_AZURE_VNET_OPTION : draft.vnetId;
  const selectedVnet = options.virtualNetworks.find(({ id }) => id === draft.vnetId);
  const subnets = options.subnets.filter(({ vnetId }) => vnetId === draft.vnetId);
  const selectedSubnet = subnets.find(({ id }) => id === draft.subnetId);

  const selectVnet = (value: string): void => {
    if (value === MANAGED_AZURE_VNET_OPTION) {
      onChange({ ...draft, networkMode: "managed", vnetId: "", subnetId: "" });
      return;
    }
    const nextSubnets = options.subnets.filter(({ vnetId }) => vnetId === value);
    onChange({
      ...draft,
      networkMode: "existing",
      vnetId: value,
      subnetId: nextSubnets.some(({ id }) => id === draft.subnetId)
        ? draft.subnetId
        : nextSubnets[0]?.id ?? "",
    });
  };

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <CloudTextField
        description="Inherited from the selected Azure CLI credential."
        isReadOnly
        label="Location"
        value={location}
        onChange={() => undefined}
      />
      <CloudTextField
        description="Azure VM size available in the selected subscription and location."
        label="VM Size"
        placeholder="Standard_B2s"
        value={draft.vmSize}
        onChange={(vmSize) => onChange({ ...draft, vmSize })}
      />
      <CloudTextField
        description="Publisher:offer:sku:version or a managed-image resource ID."
        label="Image Reference"
        placeholder="Canonical:ubuntu-24_04-lts:server:latest"
        value={draft.imageReference}
        onChange={(imageReference) => onChange({ ...draft, imageReference })}
      />
      <CloudTextField
        description="Linux account provisioned with the selected or generated SSH public key."
        label="Linux SSH Username"
        placeholder="azureuser"
        value={draft.sshUsername}
        onChange={(sshUsername) => onChange({ ...draft, sshUsername })}
      />
      <CloudRichSelect
        description="Choose a discovered VNet or create a tagged isolated network."
        label="Virtual Network"
        value={selectedVnetValue}
        options={[
          {
            value: MANAGED_AZURE_VNET_OPTION,
            label: "Create a new managed VNet",
            description: "Cloud Deployment creates and tags an isolated VNet and subnet.",
          },
          ...options.virtualNetworks.map((vnet) => ({
            value: vnet.id,
            label: `${vnet.name} · ${vnet.resourceGroupName}`,
            description: vnet.addressPrefixes.join(", ") || vnet.location,
          })),
        ]}
        selectedDescription={draft.networkMode === "managed"
          ? "A new GUID-tagged Azure virtual network"
          : selectedVnet?.addressPrefixes.join(", ")}
        onChange={selectVnet}
      />
      <CloudTextField
        description="30 to 4095 GiB."
        inputMode="numeric"
        label="OS Disk (GiB)"
        value={draft.osDiskSizeGiB}
        onChange={(osDiskSizeGiB) => onChange({ ...draft, osDiskSizeGiB })}
      />
      {draft.networkMode === "managed" ? (
        <>
          <CloudTextField
            description="Canonical private IPv4 CIDR between /16 and /28."
            label="Managed VNet CIDR"
            placeholder="10.0.0.0/16"
            value={draft.managedVnetCidr}
            onChange={(managedVnetCidr) => onChange({ ...draft, managedVnetCidr })}
          />
          <CloudTextField
            description="Must be contained by the managed VNet CIDR."
            label="Managed Subnet CIDR"
            placeholder="10.0.1.0/24"
            value={draft.managedSubnetCidr}
            onChange={(managedSubnetCidr) => onChange({ ...draft, managedSubnetCidr })}
          />
        </>
      ) : (
        <CloudRichSelect
          description="Only subnets from the selected VNet are shown."
          isDisabled={!draft.vnetId || subnets.length === 0}
          label="Subnet"
          options={subnets.map((subnet) => ({
            value: subnet.id,
            label: `${subnet.name} · ${subnet.resourceGroupName}`,
            description: subnet.addressPrefixes.join(", ") || subnet.id,
          }))}
          placeholder={draft.vnetId && subnets.length === 0 ? "No subnets available" : "Choose a subnet"}
          selectedDescription={selectedSubnet?.addressPrefixes.join(", ")}
          value={draft.subnetId}
          onChange={(subnetId) => onChange({ ...draft, subnetId })}
        />
      )}
      <div className="flex min-h-16 items-center rounded-2xl bg-surface-secondary px-4 py-3 md:col-span-2">
        <Switch className="w-full justify-between" isSelected={usePublicIp} onChange={onPublicIpChange}>
          <Switch.Content>
            <Label>Public IP</Label>
            <Description>Attach a tagged Standard public IP for SSH and the Sliver operator endpoint. Turn this off only when this computer can reach the VNet private address.</Description>
          </Switch.Content>
          <Switch.Control><Switch.Thumb /></Switch.Control>
        </Switch>
      </div>
    </div>
  );
}

function DeploymentCard({
  actionRequest,
  api,
  credential,
  deployment,
  hasSshCredential,
  isDeploymentView = false,
  revision,
  refreshError,
  transcript,
  onActionRequestHandled,
  onBeginCardAction,
  onFinishCardAction,
  onFeedback,
  onOpenDetails,
  onOpenNewOperator,
  onRefresh,
  onTerminated,
}: {
  readonly actionRequest?: CloudDeploymentActionRequest | null;
  readonly api: CloudDeploymentAPI;
  readonly credential?: CloudCredentialSummary | undefined;
  readonly deployment: CloudDeploymentRecord;
  readonly hasSshCredential: boolean;
  readonly isDeploymentView?: boolean;
  readonly revision: number;
  readonly refreshError?: string | undefined;
  readonly transcript?: CloudProvisioningTranscript;
  readonly onActionRequestHandled?: (request: CloudDeploymentActionRequest) => void;
  readonly onBeginCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => boolean;
  readonly onFinishCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onOpenDetails?: () => void;
  readonly onOpenNewOperator?: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onTerminated?: () => void;
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [destroyPlan, setDestroyPlan] = useState<DestroyCloudDeploymentPlan | null>(null);
  const [sshHostKeyReview, setSshHostKeyReview] = useState<SshHostKeyReview | null>(null);
  const [sshHostKeyReviewError, setSshHostKeyReviewError] = useState<string | null>(null);
  const [isOpeningSsh, setIsOpeningSsh] = useState(false);
  const [serverActionsOpen, setServerActionsOpen] = useState(false);
  const handledActionRequest = useRef<CloudDeploymentActionRequest | null>(null);
  const actionInFlight = useRef(false);
  const destroyExecutionInFlight = useRef(false);
  const sshRequestInFlight = useRef(false);
  const restoreServerActionsFocus = useRef(false);
  const serverActionsTrigger = useRef<HTMLButtonElement | null>(null);
  const runtimeIsStable = hasStableDeploymentRuntime(deployment);

  useEffect(() => {
    if (!serverActionsOpen) return undefined;
    const rememberEscapeClose = (event: KeyboardEvent): void => {
      if (event.key === "Escape") restoreServerActionsFocus.current = true;
    };
    document.addEventListener("keydown", rememberEscapeClose, true);
    return () => document.removeEventListener("keydown", rememberEscapeClose, true);
  }, [serverActionsOpen]);

  const lifecycle = useCallback(async (action: "start" | "stop" | "reboot"): Promise<void> => {
    if ((deployment.status === "running" || deployment.status === "stopped") && !runtimeIsStable) {
      onFeedback({
        tone: "warning",
        title: "Cloud action unavailable",
        detail: "Wait until the provider confirms this server is running or stopped before using power controls.",
      });
      return;
    }
    if (actionInFlight.current || !onBeginCardAction(deployment.id, action)) return;
    actionInFlight.current = true;
    setPendingAction(action);
    try {
      const result = await api.runLifecycleAction({ deploymentId: deployment.id, expectedRevision: revision, action });
      if (!result.ok) {
        onFeedback({ tone: "danger", title: `${titleCase(action)} failed`, detail: result.error ?? "The provider rejected the request." });
        return;
      }
      onFeedback({ tone: "success", title: `${titleCase(action)} requested`, detail: `${deployment.name} was updated by ${providerLabel(deployment.provider)}.` });
      await onRefresh();
    } catch (error) {
      onFeedback({ tone: "danger", title: `${titleCase(action)} failed`, detail: errorMessage(error) });
    } finally {
      actionInFlight.current = false;
      setPendingAction(null);
      onFinishCardAction(deployment.id, action);
    }
  }, [api, deployment.id, deployment.name, deployment.provider, deployment.status, onBeginCardAction, onFeedback, onFinishCardAction, onRefresh, revision, runtimeIsStable]);

  const prepareDestroy = useCallback(async (): Promise<void> => {
    if (actionInFlight.current || !onBeginCardAction(deployment.id, "terminate")) return;
    actionInFlight.current = true;
    setPendingAction("prepare-destroy");
    try {
      const result = await api.prepareDestroyDeployment({ deploymentId: deployment.id, expectedRevision: revision });
      if (!result.ok || !result.value) {
        onFeedback({ tone: "danger", title: "Could not review termination", detail: result.error ?? "The provider assets could not be verified." });
        actionInFlight.current = false;
        onFinishCardAction(deployment.id, "terminate");
        return;
      }
      setDestroyPlan(result.value);
    } catch (error) {
      actionInFlight.current = false;
      onFeedback({ tone: "danger", title: "Could not review termination", detail: errorMessage(error) });
      onFinishCardAction(deployment.id, "terminate");
    } finally {
      setPendingAction(null);
    }
  }, [api, deployment.id, onBeginCardAction, onFeedback, onFinishCardAction, revision]);

  const executeDestroy = async (): Promise<void> => {
    if (!destroyPlan || destroyExecutionInFlight.current) return;
    destroyExecutionInFlight.current = true;
    const reviewedPlan = destroyPlan;
    setDestroyPlan(null);
    setPendingAction("destroy");
    try {
      const result = await api.executeDestroyDeployment({ token: reviewedPlan.token });
      if (!result.ok) {
        onFeedback({ tone: "danger", title: "Termination failed", detail: result.error ?? "The reviewed termination was rejected." });
        return;
      }
      onFeedback({ tone: "success", title: "Instance terminated", detail: `${deployment.name} and its verified managed assets were removed.` });
      await onRefresh();
      onTerminated?.();
    } catch (error) {
      onFeedback({ tone: "danger", title: "Termination failed", detail: errorMessage(error) });
    } finally {
      destroyExecutionInFlight.current = false;
      actionInFlight.current = false;
      setPendingAction(null);
      onFinishCardAction(deployment.id, "terminate");
    }
  };

  const cancelDestroyReview = (): void => {
    setDestroyPlan(null);
    actionInFlight.current = false;
    onFinishCardAction(deployment.id, "terminate");
  };

  const openSsh = useCallback(async (errorSurface: "page" | "host-key-dialog" = "page"): Promise<void> => {
    if (sshRequestInFlight.current) return;
    sshRequestInFlight.current = true;
    setIsOpeningSsh(true);
    setSshHostKeyReviewError(null);
    try {
      const result = await api.openSshWindow({ deploymentId: deployment.id });
      if (!result.ok || !result.value) {
        const detail = safeSshErrorMessage(result.error, "The SSH session could not be opened.");
        if (errorSurface === "host-key-dialog") setSshHostKeyReviewError(detail);
        else onFeedback({ tone: "danger", title: "SSH connection failed", detail });
        return;
      }
      if (result.value.status === "host-key-review") {
        setSshHostKeyReview(result.value.review);
      } else if (errorSurface === "host-key-dialog") {
        setSshHostKeyReview(null);
      }
    } catch (error) {
      const detail = safeSshErrorMessage(error, "The SSH session could not be opened.");
      if (errorSurface === "host-key-dialog") setSshHostKeyReviewError(detail);
      else onFeedback({ tone: "danger", title: "SSH connection failed", detail });
    } finally {
      sshRequestInFlight.current = false;
      setIsOpeningSsh(false);
    }
  }, [api, deployment.id, onFeedback]);

  const approveSshHostKey = async (): Promise<void> => {
    if (!sshHostKeyReview || sshRequestInFlight.current) return;
    sshRequestInFlight.current = true;
    setIsOpeningSsh(true);
    setSshHostKeyReviewError(null);
    try {
      const result = await api.approveSshHostKey({ token: sshHostKeyReview.token });
      if (!result.ok || !result.value) {
        setSshHostKeyReviewError(safeSshErrorMessage(
          result.error,
          "The reviewed SSH host could not be connected.",
        ));
        return;
      }
      if (result.value.status === "host-key-review") {
        setSshHostKeyReview(result.value.review);
        return;
      }
      setSshHostKeyReview(null);
    } catch (error) {
      setSshHostKeyReviewError(safeSshErrorMessage(
        error,
        "The reviewed SSH host could not be connected.",
      ));
    } finally {
      sshRequestInFlight.current = false;
      setIsOpeningSsh(false);
    }
  };

  const progress = phaseProgress(deployment.phase);
  const lifecycleAction = deployment.status === "running" && runtimeIsStable
    ? "stop"
    : deployment.status === "stopped" && runtimeIsStable
      ? "start"
      : null;
  const lifecycleLabel = lifecycleAction === "stop" ? "Stop" : "Start";
  const sshUnavailableReason = deploymentSshUnavailableReason(deployment, hasSshCredential);
  const sshActionDisabledReason = isOpeningSsh
    ? `An SSH session for ${deployment.name} is already opening.`
    : pendingAction !== null
      ? `Wait for the current ${deployment.name} server action to finish.`
      : sshUnavailableReason;
  const operatorUnavailableReason = deploymentOperatorUnavailableReason(deployment, hasSshCredential);
  const operatorActionDisabledReason = !onOpenNewOperator
    ? "Finish deployment setup before adding an operator."
    : isOpeningSsh
      ? `Wait for the ${deployment.name} SSH session to finish opening before adding an operator.`
      : pendingAction !== null
        ? `Wait for the current ${deployment.name} server action to finish before adding an operator.`
        : operatorUnavailableReason;

  useEffect(() => {
    if (
      !actionRequest ||
      actionRequest.deploymentId !== deployment.id ||
      handledActionRequest.current === actionRequest
    ) return;
    handledActionRequest.current = actionRequest;
    onActionRequestHandled?.(actionRequest);
    if (actionRequest.action === "operator") {
      if (operatorActionDisabledReason) {
        onFeedback({ tone: "danger", title: "Operator creation unavailable", detail: operatorActionDisabledReason });
      } else {
        onOpenNewOperator?.();
      }
    } else if (actionRequest.action === "ssh") void openSsh();
    else if (actionRequest.action === "terminate") void prepareDestroy();
    else void lifecycle(actionRequest.action);
  }, [actionRequest, deployment.id, lifecycle, onActionRequestHandled, onFeedback, onOpenNewOperator, openSsh, operatorActionDisabledReason, prepareDestroy]);

  const loginCredential = canLoginCloudCredential(credential) ? credential : undefined;
  const cloudLogin = useCloudLoginActionController({
    api,
    credential: loginCredential,
    isDisabled: pendingAction !== null,
    onFeedback,
    onPendingChange: (pending) => setPendingAction(pending ? "cloud-login" : null),
    onRefresh,
  });
  const hasEmbeddedCloudLogin = Boolean(deployment.lastError || refreshError);
  const showCloudLogin = hasEmbeddedCloudLogin || cloudLogin.isPending || cloudLogin.error !== null;
  const cloudLoginAction = (embedded: boolean): React.JSX.Element | null => loginCredential && showCloudLogin ? (
    <CloudLoginAction
      controller={cloudLogin}
      credential={loginCredential}
      isDisabled={pendingAction !== null}
      isEmbedded={embedded}
      showDetails={embedded || !hasEmbeddedCloudLogin}
    />
  ) : null;

  return (
    <Card className={isDeploymentView ? "w-full" : "h-fit"} variant="secondary">
      <Card.Header className="flex-row items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-tertiary text-muted">
          <FontAwesomeIcon aria-hidden icon={providerIcon(deployment.provider)} />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{deployment.name}</Card.Title>
          <Card.Description>{providerLabel(deployment.provider)} · {deployment.remoteHost ?? "Address pending"}</Card.Description>
        </div>
        <Chip color={(deployment.status === "running" || deployment.status === "stopped") && !runtimeIsStable ? "warning" : statusColor(deployment.status)} size="sm" variant="soft">
          {deploymentStatusLabel(deployment)}
        </Chip>
      </Card.Header>
      <Card.Content className="space-y-4">
        {isDeploymentView ? <DeploymentStepper currentStep={3} /> : null}
        {deployment.status === "provisioning" || deployment.status === "deleting" || isDeploymentView ? (
          <ProgressBar aria-label={`${deployment.name} deployment progress`} value={progress}>
            <div className="mb-2 flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{phaseLabel(deployment.phase)}</span>
              <ProgressBar.Output className="tabular-nums text-muted">{progress}%</ProgressBar.Output>
            </div>
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>
        ) : null}
        {deployment.lastError ? (
          <InlineMessage
            action={cloudLoginAction(true)}
            detail={deployment.lastError}
            title="Last operation failed"
            tone="danger"
          />
        ) : null}
        {refreshError ? (
          <InlineMessage
            action={deployment.lastError ? null : cloudLoginAction(true)}
            detail={refreshError}
            title="Status refresh failed"
            tone="warning"
          />
        ) : null}
        {cloudLoginAction(false)}
        {isDeploymentView && deployment.provider === "aws" ? <AwsStatusChecks deployment={deployment} /> : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <DeploymentDetail label="Management ID" value={deployment.id} mono />
          <DeploymentDetail label={deployment.provider === "aws" ? "Instance" : "Virtual Machine"} value={runtimeId(deployment)} mono />
          <DeploymentDetail label="Operator Config" value={deployment.operatorConfigFileName ?? "Pending"} mono />
          <DeploymentDetail label="Managed Assets" value={String(deployment.managedAssets.length)} />
        </dl>

        {isDeploymentView ? (
          <CloudProvisioningTerminal
            api={api}
            deploymentId={deployment.id}
            transcript={transcript}
          />
        ) : null}
      </Card.Content>
      <Card.Footer className="flex w-full flex-wrap items-center gap-2">
        <div aria-label={`Access and operator actions for ${deployment.name}`} className="flex flex-wrap items-center gap-2" role="group">
          <Tooltip delay={0}>
            <Button
              aria-disabled={sshActionDisabledReason !== undefined}
              aria-label={`SSH to ${deployment.name}`}
              className={sshActionDisabledReason ? "cursor-not-allowed opacity-50" : ""}
              isPending={isOpeningSsh}
              size="sm"
              variant="outline"
              onPress={() => {
                if (!sshActionDisabledReason) void openSsh();
              }}
            >
              <FontAwesomeIcon aria-hidden icon={faTerminal} /> SSH
            </Button>
            <Tooltip.Content>
              {sshActionDisabledReason ?? `Open an SSH session for ${deployment.name}`}
            </Tooltip.Content>
          </Tooltip>
          <Button
            aria-label={`Edit firewall for ${deployment.name}`}
            isDisabled={!onOpenDetails || deployment.managedAssets.length === 0 || deployment.status === "provisioning" || deployment.status === "deleting" || pendingAction !== null}
            size="sm"
            variant="outline"
            onPress={() => onOpenDetails?.()}
          >
            <FontAwesomeIcon aria-hidden icon={faShieldHalved} /> Firewall
          </Button>
          <Tooltip delay={0}>
            <Button
              aria-label={`New Operator for ${deployment.name}`}
              aria-disabled={operatorActionDisabledReason !== undefined}
              className={operatorActionDisabledReason ? "cursor-not-allowed opacity-50" : ""}
              data-new-operator-trigger={deployment.id}
              size="sm"
              variant="outline"
              onPress={() => {
                if (!operatorActionDisabledReason) onOpenNewOperator?.();
              }}
            >
              <FontAwesomeIcon aria-hidden icon={faUserPlus} /> New Operator
            </Button>
            <Tooltip.Content>
              {operatorActionDisabledReason ?? `Add an operator to ${deployment.name}`}
            </Tooltip.Content>
          </Tooltip>
        </div>
        <div aria-label={`Lifecycle actions for ${deployment.name}`} className="ml-auto flex flex-wrap items-center justify-end gap-2" role="group">
          <Dropdown
            isOpen={serverActionsOpen}
            onOpenChange={(isOpen) => {
              setServerActionsOpen(isOpen);
              if (!isOpen && restoreServerActionsFocus.current) {
                restoreServerActionsFocus.current = false;
                queueMicrotask(() => serverActionsTrigger.current?.focus());
              }
            }}
          >
            <Tooltip delay={0}>
              <Button
                aria-label={`Server actions for ${deployment.name}`}
                isIconOnly
                isPending={pendingAction === "prepare-destroy"}
                ref={serverActionsTrigger}
                size="sm"
                variant="ghost"
              >
                <FontAwesomeIcon aria-hidden icon={faEllipsisVertical} />
              </Button>
              <Tooltip.Content>Server actions</Tooltip.Content>
            </Tooltip>
            <Dropdown.Popover className="min-w-52" placement="bottom end">
              <Dropdown.Menu
                aria-label={`Server actions for ${deployment.name}`}
                onAction={(key) => {
                  const action = String(key);
                  if (action === "terminate") void prepareDestroy();
                  else if (action === "start" || action === "stop" || action === "reboot") void lifecycle(action);
                }}
              >
                <Dropdown.Item
                  id={lifecycleAction ?? "start"}
                  isDisabled={lifecycleAction === null || pendingAction !== null}
                  textValue={lifecycleLabel}
                >
                  <FontAwesomeIcon
                    aria-hidden
                    className={`size-3.5 ${lifecycleAction === "stop" ? "text-warning" : "text-muted"}`}
                    icon={lifecycleAction === "stop" ? faStop : faPlay}
                  />
                  <Label>{lifecycleLabel}</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="reboot"
                  isDisabled={deployment.status !== "running" || !runtimeIsStable || pendingAction !== null}
                  textValue="Reboot"
                >
                  <FontAwesomeIcon aria-hidden className="size-3.5 text-warning" icon={faRotate} />
                  <Label>Reboot</Label>
                </Dropdown.Item>
                <Dropdown.Item
                  id="terminate"
                  isDisabled={deployment.status === "provisioning" || deployment.status === "deleting" || pendingAction !== null}
                  textValue="Terminate"
                  variant="danger"
                >
                  <FontAwesomeIcon aria-hidden className="size-3.5 text-danger" icon={faTrash} />
                  <Label>Terminate</Label>
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        </div>
      </Card.Footer>

      <AlertDialog.Backdrop isOpen={destroyPlan !== null} variant="blur" onOpenChange={(open) => { if (!open && pendingAction !== "destroy") cancelDestroyReview(); }}>
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[460px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-5" /></AlertDialog.Icon>
              <AlertDialog.Heading>Terminate {destroyPlan?.deploymentName ?? "deployment"}?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="space-y-3 text-sm leading-6 text-muted">
                <p>The provider assets were re-checked against this deployment’s management ID.</p>
                <p>This terminates the server and removes its verified managed infrastructure. The local operator configuration is no longer managed afterward.</p>
                {deployment.provider === "azure" && deployment.runtime.resourceGroupName ? (
                  <p className="text-warning">
                    Azure will recursively delete the dedicated resource group <span className="font-mono">{deployment.runtime.resourceGroupName}</span> after confirming it is empty. Do not add unrelated resources while termination is running.
                  </p>
                ) : null}
                {destroyPlan ? <p className="text-xs">Review expires {new Date(destroyPlan.expiresAt).toLocaleTimeString()}.</p> : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={pendingAction === "destroy"} variant="tertiary" onPress={cancelDestroyReview}>Cancel</Button>
              <Button isPending={pendingAction === "destroy"} variant="danger" onPress={() => void executeDestroy()}>Terminate Instance</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <AlertDialog.Backdrop
        isOpen={sshHostKeyReview !== null}
        variant="blur"
        onOpenChange={(open) => {
          if (!open && !isOpeningSsh) {
            setSshHostKeyReview(null);
            setSshHostKeyReviewError(null);
          }
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[500px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning">
                <FontAwesomeIcon aria-hidden icon={faKey} className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>Verify SSH host</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              {sshHostKeyReview ? (
                <div className="space-y-4 text-sm leading-6 text-muted">
                  <p>
                    This is the first SSH connection to <span className="font-medium text-foreground">{sshHostKeyReview.name}</span>.
                    Confirm the host key with a trusted source before connecting.
                  </p>
                  <dl className="space-y-3 rounded-2xl bg-surface-secondary p-4">
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted">Server</dt>
                      <dd className="mt-1 break-all font-mono text-foreground">{sshHostKeyReview.host}:{sshHostKeyReview.port}</dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted">SHA-256 fingerprint</dt>
                      <dd className="mt-1 break-all font-mono text-foreground">{sshHostKeyReview.fingerprint}</dd>
                    </div>
                  </dl>
                  <p>
                    Connecting pins this key for future sessions. A changed key will be rejected until it is reviewed separately.
                  </p>
                  <p className="text-xs">Review expires {new Date(sshHostKeyReview.expiresAt).toLocaleTimeString()}.</p>
                  {sshHostKeyReviewError ? (
                    <InlineMessage
                      tone="danger"
                      title="SSH connection failed"
                      detail={sshHostKeyReviewError}
                    />
                  ) : null}
                </div>
              ) : null}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                isDisabled={isOpeningSsh}
                variant="tertiary"
                onPress={() => {
                  setSshHostKeyReview(null);
                  setSshHostKeyReviewError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                isPending={isOpeningSsh}
                variant="primary"
                onPress={() => {
                  if (sshHostKeyReviewError) void openSsh("host-key-dialog");
                  else void approveSshHostKey();
                }}
              >
                {sshHostKeyReviewError ? "Re-check Host" : "Trust & Connect"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      <LifecycleProgressModal action={pendingAction} deploymentName={deployment.name} />
    </Card>
  );
}

function NewOperatorForm({
  api,
  deployment,
  mutationLock,
  revision,
  onBeginMutation,
  onBack,
  onFeedback,
  onFinishMutation,
  onMutationBlocked,
}: {
  readonly api: CloudDeploymentAPI;
  readonly deployment: CloudDeploymentRecord;
  readonly mutationLock: OperatorMutationLock | undefined;
  readonly revision: number;
  readonly onBeginMutation: () => boolean;
  readonly onBack: () => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onFinishMutation: () => void;
  readonly onMutationBlocked: (lock: OperatorMutationLock) => void;
}): React.JSX.Element {
  const [operatorName, setOperatorName] = useState(mutationLock?.operatorName ?? "");
  const [publicIp, setPublicIp] = useState(
    mutationLock?.publicIp ?? deployment.runtime.publicIpAddress ?? "",
  );
  const [port, setPort] = useState(mutationLock?.port ?? String(deployment.spec.multiplayerPort));
  const [permissions, setPermissions] = useState<CloudOperatorPermission>(
    mutationLock?.permissions ?? "all",
  );
  const [error, setError] = useState<string | null>(mutationLock?.error ?? null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [mutationState, setMutationState] = useState<"not-started" | "unknown" | "created">(
    mutationLock?.mutationState ?? "not-started",
  );
  const operatorNameError = operatorName.length === 0
    ? null
    : OPERATOR_NAME_PATTERN.test(operatorName)
      ? null
      : "Use 1–128 letters, numbers, underscores, or hyphens.";
  const publicIpError = publicIp.length === 0
    ? null
    : validIpv4Address(publicIp.trim())
      ? null
      : "Enter a valid public IPv4 address.";
  const portError = port.length === 0
    ? null
    : validOperatorPort(port)
      ? null
      : "Enter a TCP port from 1 to 65535.";
  const isValid = OPERATOR_NAME_PATTERN.test(operatorName) &&
    validIpv4Address(publicIp.trim()) &&
    validOperatorPort(port);
  const retryBlocked = mutationState !== "not-started";
  const blockRetry = (nextMutationState: "unknown" | "created", nextError: string): void => {
    const lock = Object.freeze({
      mutationState: nextMutationState,
      error: nextError,
      operatorName,
      publicIp: publicIp.trim(),
      port,
      permissions,
    });
    setMutationState(nextMutationState);
    setError(nextError);
    onMutationBlocked(lock);
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!isValid || isSaving || retryBlocked || !onBeginMutation()) return;
    setIsSaving(true);
    setError(null);
    setSaveNotice(null);
    try {
      const result = await api.createOperatorConfig({
        deploymentId: deployment.id,
        expectedRevision: revision,
        operatorName,
        publicIp: publicIp.trim(),
        port: Number(port),
        permissions,
      });
      if (!result.ok || !result.value) {
        blockRetry("unknown", result.error ?? "The operator configuration could not be created.");
        return;
      }
      if (!result.value.saved) {
        if (result.value.mutationState === "not-started") {
          if (result.value.error) setError(result.value.error);
          else setSaveNotice("The save dialog was closed before a configuration file was saved.");
        } else {
          blockRetry(result.value.mutationState, result.value.error);
        }
        return;
      }
      onBack();
      onFeedback({
        tone: "success",
        title: "Operator config saved",
        detail: `${operatorName} now has ${operatorPermissionAccessLabel(permissions)} on ${deployment.name}. ${result.value.fileName} was saved to disk.`,
      });
    } catch (caught) {
      blockRetry("unknown", errorMessage(caught));
    } finally {
      setIsSaving(false);
      onFinishMutation();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        aria-label="New operator header"
        className="sticky top-0 z-20 shrink-0 space-y-3 bg-background pb-4"
      >
        <div>
          <Button
            aria-label="Back to managed servers"
            autoFocus={mutationLock !== undefined}
            isDisabled={isSaving}
            size="sm"
            variant="ghost"
            onPress={onBack}
          >
            <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
            Back to managed servers
          </Button>
        </div>
        <section aria-labelledby="new-operator-heading">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
              <FontAwesomeIcon aria-hidden className="size-5" icon={faUserPlus} />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Operator management</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight" id="new-operator-heading">New Operator</h1>
              <p className="mt-1 truncate text-sm text-muted">{deployment.name} · {providerLabel(deployment.provider)}</p>
            </div>
          </div>
        </section>
      </header>

      <ScrollShadow
        aria-label="New operator form content"
        className="min-h-0 flex-1 overflow-y-auto pb-12"
        orientation="vertical"
        role="region"
        size={48}
      >
        <form aria-label={`New Operator for ${deployment.name}`} className="mx-auto w-full max-w-2xl" onSubmit={(event) => void submit(event)}>
          <Card variant="secondary">
            <Card.Header>
              <Card.Title>Create an operator configuration</Card.Title>
              <Card.Description>
                First choose where to save the configuration. The app then connects over SSH and uses the Sliver server CLI to create and retrieve the operator profile.
              </Card.Description>
            </Card.Header>
            <Card.Content className="space-y-5">
              {error ? (
                <InlineMessage
                  detail={error}
                  title={mutationState === "created"
                    ? "Operator created — recovery required"
                    : mutationState === "unknown"
                      ? "Operator outcome requires review"
                      : "Operator not created"}
                  tone="danger"
                />
              ) : null}
              {saveNotice ? <InlineMessage detail={saveNotice} title="Configuration not saved" tone="info" /> : null}
              <TextField
                fullWidth
                isDisabled={isSaving || retryBlocked}
                isInvalid={operatorNameError !== null}
                isRequired
                value={operatorName}
                variant="secondary"
                onChange={(value) => {
                  setOperatorName(value);
                  setError(null);
                  setSaveNotice(null);
                }}
              >
                <Label>Operator Name</Label>
                <Input
                  autoComplete="off"
                  autoFocus={mutationLock === undefined}
                  maxLength={128}
                  pattern="[A-Za-z0-9_-]{1,128}"
                  placeholder="operator_name"
                  spellCheck={false}
                />
                {operatorNameError
                  ? <FieldError>{operatorNameError}</FieldError>
                  : <Description>1–128 letters, numbers, underscores, or hyphens.</Description>}
              </TextField>
              <CloudNativeSelect
                description={operatorPermissionDescription(permissions)}
                isDisabled={isSaving || retryBlocked}
                label="Permissions"
                options={OPERATOR_PERMISSION_OPTIONS}
                value={permissions}
                onChange={(value) => {
                  if (!isCloudOperatorPermission(value)) return;
                  setPermissions(value);
                  setError(null);
                  setSaveNotice(null);
                }}
              />
              <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <TextField
                  fullWidth
                  isDisabled={isSaving || retryBlocked}
                  isInvalid={publicIpError !== null}
                  isRequired
                  value={publicIp}
                  variant="secondary"
                  onChange={(value) => {
                    setPublicIp(value);
                    setError(null);
                    setSaveNotice(null);
                  }}
                >
                  <Label>Public IP</Label>
                  <Input
                    autoComplete="off"
                    inputMode="decimal"
                    maxLength={15}
                    placeholder="203.0.113.10"
                    spellCheck={false}
                  />
                  {publicIpError
                    ? <FieldError>{publicIpError}</FieldError>
                    : <Description>Address embedded in the saved operator configuration.</Description>}
                </TextField>
                <TextField
                  fullWidth
                  isDisabled={isSaving || retryBlocked}
                  isInvalid={portError !== null}
                  isRequired
                  value={port}
                  variant="secondary"
                  onChange={(value) => {
                    setPort(value);
                    setError(null);
                    setSaveNotice(null);
                  }}
                >
                  <Label>Port</Label>
                  <Input
                    autoComplete="off"
                    inputMode="numeric"
                    maxLength={5}
                    pattern="[0-9]{1,5}"
                    placeholder="31337"
                    spellCheck={false}
                  />
                  {portError ? <FieldError>{portError}</FieldError> : <Description>TCP port.</Description>}
                </TextField>
              </div>
            </Card.Content>
            <Card.Footer className="flex flex-wrap justify-end gap-2">
              <Button isDisabled={isSaving} type="button" variant="tertiary" onPress={onBack}>Cancel</Button>
              <Button isDisabled={!isValid || isSaving || retryBlocked} isPending={isSaving} type="submit" variant="primary">
                Create Operator
              </Button>
            </Card.Footer>
          </Card>
        </form>
      </ScrollShadow>
    </div>
  );
}

function useCurrentEgressIpv4Lookup(api: CloudDeploymentAPI): {
  readonly state: CurrentEgressIpv4Lookup;
  readonly refresh: () => Promise<void>;
} {
  const [state, setState] = useState<CurrentEgressIpv4Lookup>({ status: "loading" });
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const currentGeneration = ++generation.current;
    setState({ status: "loading" });
    try {
      const result = await api.detectCurrentEgressIpv4();
      if (currentGeneration !== generation.current) return;
      setState(result.ok && result.value
        ? { status: "success", value: result.value }
        : { status: "failed" });
    } catch {
      if (currentGeneration === generation.current) setState({ status: "failed" });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
    };
  }, [refresh]);

  return { state, refresh };
}

function AwsInstanceDetails({
  api,
  deployment,
  notices,
  revision,
  onBack,
  onFeedback,
  onRefresh,
}: {
  readonly api: CloudDeploymentAPI;
  readonly deployment: AwsCloudDeploymentRecord;
  readonly notices: React.JSX.Element;
  readonly revision: number;
  readonly onBack: () => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const currentEgressIpv4 = useCurrentEgressIpv4Lookup(api);
  const [firewall, setFirewall] = useState<AwsFirewallSnapshot | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<AwsFirewallDirection>("ingress");
  const [isLoadingRules, setIsLoadingRules] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [editor, setEditor] = useState<AwsFirewallEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteRule, setDeleteRule] = useState<AwsFirewallRule | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<"create" | "update" | "delete" | "current-ip" | null>(null);
  const loadGeneration = useRef(0);

  const copyInstanceId = async (): Promise<void> => {
    try {
      const result = await api.copyInstanceId({ deploymentId: deployment.id });
      if (!result.ok) throw new Error(result.error ?? "The instance ID could not be copied.");
      toast.success("Instance ID copied");
    } catch (error) {
      toast.danger("Could not copy instance ID", { description: errorMessage(error) });
    }
  };

  const loadRules = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setIsLoadingRules(true);
    setRulesError(null);
    try {
      const result = await api.listFirewallRules({ deploymentId: deployment.id });
      if (generation !== loadGeneration.current) return;
      if (!result.ok || !result.value || result.value.provider !== "aws") {
        setRulesError(result.error ?? "AWS EC2 firewall rules could not be loaded.");
        return;
      }
      setFirewall(result.value);
    } catch (error) {
      if (generation === loadGeneration.current) setRulesError(errorMessage(error));
    } finally {
      if (generation === loadGeneration.current) setIsLoadingRules(false);
    }
  }, [api, deployment.id]);

  useEffect(() => {
    void loadRules();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadRules]);

  const openCreateRule = (): void => {
    setEditorError(null);
    setEditor({ mode: "create", draft: initialAwsFirewallRuleDraft(selectedDirection) });
  };

  const openEditRule = (rule: AwsFirewallRule): void => {
    setEditorError(null);
    setEditor({ mode: "edit", ruleId: rule.id, draft: awsFirewallRuleDraft(rule) });
  };

  const allowCurrentEgressIpv4 = async (): Promise<void> => {
    if (currentEgressIpv4.state.status !== "success") return;
    const { cidr } = currentEgressIpv4.state.value;
    setPendingMutation("current-ip");
    try {
      const result = await api.updateFirewall({
        deploymentId: deployment.id,
        expectedRevision: revision,
        sshCidrs: appendUniqueCidr(deployment.spec.sshCidrs, cidr),
        operatorCidrs: appendUniqueCidr(deployment.spec.operatorCidrs, cidr),
      });
      if (!result.ok || !result.value || result.value.provider !== "aws") {
        onFeedback({
          tone: "danger",
          title: "Current IP rule failed",
          detail: result.error ?? `The managed access rules for ${deployment.name} could not be updated.`,
        });
        await Promise.allSettled([onRefresh(), loadRules()]);
        return;
      }
      onFeedback({
        tone: "success",
        title: "Current IP allowed",
        detail: `${cidr} was added to the managed SSH and operator access ranges for ${deployment.name}.`,
      });
      await Promise.allSettled([onRefresh(), loadRules()]);
    } catch (error) {
      onFeedback({ tone: "danger", title: "Current IP rule failed", detail: errorMessage(error) });
      await Promise.allSettled([onRefresh(), loadRules()]);
    } finally {
      setPendingMutation(null);
    }
  };

  const saveRule = async (): Promise<void> => {
    if (!editor) return;
    const parsed = parseAwsFirewallRuleDraft(editor.draft);
    if (!parsed.ok) {
      setEditorError(parsed.error);
      return;
    }
    const action = editor.mode === "create" ? "create" : "update";
    setPendingMutation(action);
    setEditorError(null);
    try {
      const result = editor.mode === "create"
        ? await api.createFirewallRule({ deploymentId: deployment.id, expectedRevision: revision, rule: parsed.value })
        : await api.updateFirewallRule({ deploymentId: deployment.id, expectedRevision: revision, ruleId: editor.ruleId, rule: parsed.value });
      if (!result.ok || !result.value || result.value.provider !== "aws") {
        setEditorError(result.error ?? `The firewall rule could not be ${action === "create" ? "created" : "updated"}.`);
        return;
      }
      setFirewall(result.value);
      setSelectedDirection(parsed.value.direction);
      setEditor(null);
      onFeedback({
        tone: "success",
        title: action === "create" ? "Firewall rule added" : "Firewall rule updated",
        detail: `${deployment.name} now uses the updated ${directionLabel(parsed.value.direction).toLowerCase()} policy.`,
      });
      await onRefresh();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setPendingMutation(null);
    }
  };

  const removeRule = async (): Promise<void> => {
    if (!deleteRule) return;
    setPendingMutation("delete");
    setDeleteError(null);
    try {
      const result = await api.deleteFirewallRule({
        deploymentId: deployment.id,
        expectedRevision: revision,
        ruleId: deleteRule.id,
      });
      if (!result.ok || !result.value || result.value.provider !== "aws") {
        setDeleteError(result.error ?? "The firewall rule could not be deleted.");
        return;
      }
      setFirewall(result.value);
      setDeleteRule(null);
      onFeedback({
        tone: "success",
        title: "Firewall rule deleted",
        detail: `${ruleTypeLabel(deleteRule)} was removed from ${deployment.name}.`,
      });
      await onRefresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setPendingMutation(null);
    }
  };

  const ingressRules = firewall?.rules.filter(({ direction }) => direction === "ingress") ?? [];
  const egressRules = firewall?.rules.filter(({ direction }) => direction === "egress") ?? [];
  const visibleRules = selectedDirection === "ingress" ? ingressRules : egressRules;
  const securityGroupId = firewall?.securityGroupId ?? deployment.runtime.securityGroupIds[0] ?? "Pending";
  const securityGroupName = firewall?.securityGroupName ?? "Managed security group";
  const currentEgressAddress = currentEgressIpv4.state.status === "success"
    ? currentEgressIpv4.state.value.address
    : null;
  const currentEgressCidr = currentEgressIpv4.state.status === "success"
    ? currentEgressIpv4.state.value.cidr
    : null;
  const canAllowCurrentEgressIpv4 = Boolean(
    firewall &&
    currentEgressCidr &&
    currentEgressAddress &&
    !awsFirewallHasSpecificIngressRangeFor(firewall.rules, currentEgressAddress),
  );
  const columns = awsFirewallColumns({
    currentEgressAddress,
    direction: selectedDirection,
    isPending: pendingMutation !== null,
    onDelete: (rule) => {
      setDeleteError(null);
      setDeleteRule(rule);
    },
    onEdit: openEditRule,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        aria-label="Instance details header"
        className="sticky top-0 z-20 shrink-0 space-y-3 bg-background pb-4"
        data-testid="aws-instance-sticky-header"
      >
        <div>
          <Button
            aria-label="Back to managed servers"
            size="sm"
            variant="ghost"
            onPress={onBack}
          >
            <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
            Managed Servers
          </Button>
        </div>
        <section aria-labelledby="aws-instance-heading" className="space-y-4">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-secondary text-muted">
                <FontAwesomeIcon aria-hidden icon={faAmazon} className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Instance details</p>
                <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight" id="aws-instance-heading">{deployment.name}</h1>
                <p className="mt-1 truncate text-sm text-muted">AWS EC2 · {deployment.runtime.instanceId ?? "Instance pending"}</p>
              </div>
            </div>
            <Chip color={statusColor(deployment.status)} variant="soft">
              {deployment.status === "deleting" ? "Terminating" : titleCase(deployment.status)}
            </Chip>
          </div>
        </section>
      </header>

      <ScrollShadow
        aria-label="Instance details content"
        className="min-h-0 flex-1 overflow-y-auto pb-12"
        orientation="vertical"
        role="region"
        size={48}
      >
        <div className="space-y-6">
          {notices}

          <Card variant="secondary">
            <Card.Content>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                <DeploymentDetail
                  label="Instance ID"
                  value={deployment.runtime.instanceId ?? "Pending"}
                  mono
                  onCopy={deployment.runtime.instanceId ? () => { void copyInstanceId(); } : undefined}
                />
                <DeploymentDetail label="Instance type" value={deployment.spec.instanceType} mono />
                <DeploymentDetail label="Availability Zone" value={deployment.runtime.availabilityZone ?? "Pending"} mono />
                <DeploymentDetail
                  label="Public IP"
                  value={deployment.runtime.publicIpAddress ?? "None"}
                  mono
                  onCopy={deployment.runtime.publicIpAddress ? () => { void copyCloudIpAddress(api, deployment.id, "public"); } : undefined}
                />
                <DeploymentDetail
                  label="Private IP"
                  value={deployment.runtime.privateIpAddress ?? "Pending"}
                  mono
                  onCopy={deployment.runtime.privateIpAddress ? () => { void copyCloudIpAddress(api, deployment.id, "private"); } : undefined}
                />
                <DeploymentDetail label="VPC" value={firewall?.vpcId ?? deployment.runtime.vpcId ?? deployment.spec.vpcId ?? "Pending"} mono />
                <DeploymentDetail label="Subnet" value={deployment.runtime.subnetId ?? deployment.spec.subnetId ?? "Pending"} mono />
                <DeploymentDetail label="Security group" value={securityGroupId} mono />
              </dl>
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header className="flex-col items-stretch gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <Card.Title>Firewall rules</Card.Title>
                <Card.Description>
                  {securityGroupName} · {securityGroupId}
                </Card.Description>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
                <Tooltip delay={0}>
                  <Button
                    aria-label="Refresh firewall rules"
                    isDisabled={isLoadingRules || pendingMutation !== null}
                    isIconOnly
                    size="sm"
                    variant="outline"
                    onPress={() => void Promise.allSettled([
                      loadRules(),
                      currentEgressIpv4.refresh(),
                    ])}
                  >
                    <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={isLoadingRules ? "animate-spin" : ""} />
                  </Button>
                  <Tooltip.Content>Refresh firewall rules</Tooltip.Content>
                </Tooltip>
                {canAllowCurrentEgressIpv4 && currentEgressCidr ? (
                  <Button
                    aria-label={`Allow current IP ${currentEgressCidr}`}
                    className="text-success"
                    isDisabled={pendingMutation !== null}
                    isPending={pendingMutation === "current-ip"}
                    size="sm"
                    variant="outline"
                    onPress={() => void allowCurrentEgressIpv4()}
                  >
                    <FontAwesomeIcon aria-hidden icon={faShieldHalved} />
                    Allow my IP
                  </Button>
                ) : null}
                <Button
                  isDisabled={!firewall || isLoadingRules || pendingMutation !== null}
                  size="sm"
                  variant="primary"
                  onPress={openCreateRule}
                >
                  <FontAwesomeIcon aria-hidden icon={faPlus} />
                  Add rule
                </Button>
              </div>
            </Card.Header>
            <Card.Content className="space-y-4">
              <Tabs
                selectedKey={selectedDirection}
                variant="secondary"
                onSelectionChange={(key) => {
                  if (key === "ingress" || key === "egress") setSelectedDirection(key);
                }}
              >
                <Tabs.ListContainer className="w-fit max-w-full">
                  <Tabs.List aria-label="Firewall rule direction" className="w-fit whitespace-nowrap">
                    <Tabs.Tab className="min-w-28 whitespace-nowrap" id="ingress">
                      Inbound
                      <Chip className="ml-1" size="sm" variant="soft">{ingressRules.length}</Chip>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab className="min-w-28 whitespace-nowrap" id="egress">
                      Outbound
                      <Chip className="ml-1" size="sm" variant="soft">{egressRules.length}</Chip>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
                <Tabs.Panel className="pt-4" id="ingress">
                  <AwsFirewallRulesContent
                    columns={columns}
                    direction="ingress"
                    firewall={firewall}
                    isLoading={isLoadingRules}
                    isPending={pendingMutation !== null}
                    rules={visibleRules}
                    rulesError={rulesError}
                    onEdit={openEditRule}
                    onRetry={() => void loadRules()}
                  />
                </Tabs.Panel>
                <Tabs.Panel className="pt-4" id="egress">
                  <AwsFirewallRulesContent
                    columns={columns}
                    direction="egress"
                    firewall={firewall}
                    isLoading={isLoadingRules}
                    isPending={pendingMutation !== null}
                    rules={visibleRules}
                    rulesError={rulesError}
                    onEdit={openEditRule}
                    onRetry={() => void loadRules()}
                  />
                </Tabs.Panel>
              </Tabs>
            </Card.Content>
          </Card>
        </div>
      </ScrollShadow>

      <AwsFirewallRuleSheet
        editor={editor}
        error={editorError}
        isPending={pendingMutation === "create" || pendingMutation === "update"}
        onChange={setEditor}
        onClose={() => {
          if (pendingMutation === null) {
            setEditor(null);
            setEditorError(null);
          }
        }}
        onSave={() => void saveRule()}
      />

      <AlertDialog.Backdrop
        isOpen={deleteRule !== null}
        variant="blur"
        onOpenChange={(open) => {
          if (!open && pendingMutation !== "delete") {
            setDeleteRule(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[460px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>Delete firewall rule?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="space-y-3 text-sm leading-6 text-muted">
                <p>
                  {deleteRule
                    ? `${ruleTypeLabel(deleteRule)} access for ${deleteRule.peer} will be removed from ${directionLabel(deleteRule.direction).toLowerCase()}.`
                    : "This managed firewall rule will be removed."}
                </p>
                <p>This change takes effect immediately in AWS EC2.</p>
                {deleteError ? <InlineMessage tone="danger" title="Rule deletion failed" detail={deleteError} /> : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={pendingMutation === "delete"} variant="tertiary" onPress={() => setDeleteRule(null)}>Cancel</Button>
              <Button isPending={pendingMutation === "delete"} variant="danger" onPress={() => void removeRule()}>Delete rule</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}

function AzureInstanceDetails({
  api,
  deployment,
  notices,
  revision,
  onBack,
  onFeedback,
  onRefresh,
}: {
  readonly api: CloudDeploymentAPI;
  readonly deployment: AzureCloudDeploymentRecord;
  readonly notices: React.JSX.Element;
  readonly revision: number;
  readonly onBack: () => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const currentEgressIpv4 = useCurrentEgressIpv4Lookup(api);
  const [firewall, setFirewall] = useState<AzureFirewallSnapshot | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<AzureFirewallDirection>("ingress");
  const [isLoadingRules, setIsLoadingRules] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [editor, setEditor] = useState<AzureFirewallEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteRule, setDeleteRule] = useState<AzureFirewallRule | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<"create" | "update" | "delete" | "current-ip" | null>(null);
  const loadGeneration = useRef(0);

  const loadRules = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setIsLoadingRules(true);
    setRulesError(null);
    try {
      const result = await api.listFirewallRules({ deploymentId: deployment.id });
      if (generation !== loadGeneration.current) return;
      if (!result.ok || !result.value || result.value.provider !== "azure") {
        setRulesError(result.error ?? "Azure network security group rules could not be loaded.");
        return;
      }
      setFirewall(result.value);
    } catch (error) {
      if (generation === loadGeneration.current) setRulesError(errorMessage(error));
    } finally {
      if (generation === loadGeneration.current) setIsLoadingRules(false);
    }
  }, [api, deployment.id]);

  useEffect(() => {
    void loadRules();
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadRules]);

  const openCreateRule = (): void => {
    setEditorError(null);
    setEditor({ mode: "create", draft: initialAzureFirewallRuleDraft(selectedDirection) });
  };

  const openEditRule = (rule: AzureFirewallRule): void => {
    if (azureFirewallRuleEditUnsupportedReason(rule, deployment.id)) return;
    setEditorError(null);
    setEditor({ mode: "edit", ruleId: rule.id, draft: azureFirewallRuleDraft(rule) });
  };

  const allowCurrentEgressIpv4 = async (): Promise<void> => {
    if (currentEgressIpv4.state.status !== "success") return;
    const { cidr } = currentEgressIpv4.state.value;
    setPendingMutation("current-ip");
    try {
      const result = await api.updateFirewall({
        deploymentId: deployment.id,
        expectedRevision: revision,
        sshCidrs: appendUniqueCidr(deployment.spec.sshCidrs, cidr),
        operatorCidrs: appendUniqueCidr(deployment.spec.operatorCidrs, cidr),
      });
      if (!result.ok || !result.value || result.value.provider !== "azure") {
        onFeedback({
          tone: "danger",
          title: "Current IP rule failed",
          detail: result.error ?? `The managed access rules for ${deployment.name} could not be updated.`,
        });
        await Promise.allSettled([onRefresh(), loadRules()]);
        return;
      }
      onFeedback({
        tone: "success",
        title: "Current IP allowed",
        detail: `${cidr} was added to the managed SSH and operator access ranges for ${deployment.name}.`,
      });
      await Promise.allSettled([onRefresh(), loadRules()]);
    } catch (error) {
      onFeedback({ tone: "danger", title: "Current IP rule failed", detail: errorMessage(error) });
      await Promise.allSettled([onRefresh(), loadRules()]);
    } finally {
      setPendingMutation(null);
    }
  };

  const saveRule = async (): Promise<void> => {
    if (!editor) return;
    const parsed = parseAzureFirewallRuleDraft(editor.draft);
    if (!parsed.ok) {
      setEditorError(parsed.error);
      return;
    }
    const action = editor.mode === "create" ? "create" : "update";
    setPendingMutation(action);
    setEditorError(null);
    try {
      const result = editor.mode === "create"
        ? await api.createFirewallRule({ deploymentId: deployment.id, expectedRevision: revision, rule: parsed.value })
        : await api.updateFirewallRule({ deploymentId: deployment.id, expectedRevision: revision, ruleId: editor.ruleId, rule: parsed.value });
      if (!result.ok || !result.value || result.value.provider !== "azure") {
        setEditorError(result.error ?? `The network security rule could not be ${action === "create" ? "created" : "updated"}.`);
        return;
      }
      setFirewall(result.value);
      setSelectedDirection(parsed.value.direction);
      setEditor(null);
      onFeedback({
        tone: "success",
        title: action === "create" ? "Firewall rule added" : "Firewall rule updated",
        detail: `${deployment.name} now uses the updated ${directionLabel(parsed.value.direction).toLowerCase()} policy.`,
      });
      await onRefresh();
    } catch (error) {
      setEditorError(errorMessage(error));
    } finally {
      setPendingMutation(null);
    }
  };

  const removeRule = async (): Promise<void> => {
    if (!deleteRule || azureFirewallRuleProtectionReason(deleteRule, deployment.id)) return;
    setPendingMutation("delete");
    setDeleteError(null);
    try {
      const result = await api.deleteFirewallRule({
        deploymentId: deployment.id,
        expectedRevision: revision,
        ruleId: deleteRule.id,
      });
      if (!result.ok || !result.value || result.value.provider !== "azure") {
        setDeleteError(result.error ?? "The network security rule could not be deleted.");
        return;
      }
      setFirewall(result.value);
      setDeleteRule(null);
      onFeedback({
        tone: "success",
        title: "Firewall rule deleted",
        detail: `${deleteRule.name} was removed from ${deployment.name}.`,
      });
      await onRefresh();
    } catch (error) {
      setDeleteError(errorMessage(error));
    } finally {
      setPendingMutation(null);
    }
  };

  const ingressRules = firewall?.rules.filter(({ direction }) => direction === "ingress") ?? [];
  const egressRules = firewall?.rules.filter(({ direction }) => direction === "egress") ?? [];
  const nsgId = firewall?.networkSecurityGroupId ?? deployment.runtime.networkSecurityGroupId ?? "Pending";
  const nsgName = firewall?.networkSecurityGroupName ?? "Managed network security group";
  const currentEgressAddress = currentEgressIpv4.state.status === "success"
    ? currentEgressIpv4.state.value.address
    : null;
  const currentEgressCidr = currentEgressIpv4.state.status === "success"
    ? currentEgressIpv4.state.value.cidr
    : null;
  const canAllowCurrentEgressIpv4 = Boolean(
    firewall &&
    currentEgressCidr &&
    currentEgressAddress &&
    !azureFirewallHasSpecificIngressRangeFor(firewall.rules, currentEgressAddress),
  );
  const columns = azureFirewallColumns({
    currentEgressAddress,
    deploymentId: deployment.id,
    direction: selectedDirection,
    isPending: pendingMutation !== null,
    onDelete: (rule) => {
      if (azureFirewallRuleProtectionReason(rule, deployment.id)) return;
      setDeleteError(null);
      setDeleteRule(rule);
    },
    onEdit: openEditRule,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header
        aria-label="Virtual machine details header"
        className="sticky top-0 z-20 shrink-0 space-y-3 bg-background pb-4"
        data-testid="azure-instance-sticky-header"
      >
        <div>
          <Button aria-label="Back to managed servers" size="sm" variant="ghost" onPress={onBack}>
            <FontAwesomeIcon aria-hidden icon={faArrowLeft} />
            Managed Servers
          </Button>
        </div>
        <section aria-labelledby="azure-instance-heading" className="space-y-4">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-surface-secondary text-muted">
                <FontAwesomeIcon aria-hidden icon={faMicrosoft} className="size-5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Virtual machine details</p>
                <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight" id="azure-instance-heading">{deployment.name}</h1>
                <p className="mt-1 truncate text-sm text-muted">Microsoft Azure · {deployment.runtime.vmName ?? "VM pending"}</p>
              </div>
            </div>
            <Chip color={statusColor(deployment.status)} variant="soft">
              {deployment.status === "deleting" ? "Terminating" : titleCase(deployment.status)}
            </Chip>
          </div>
        </section>
      </header>

      <ScrollShadow
        aria-label="Virtual machine details content"
        className="min-h-0 flex-1 overflow-y-auto pb-12"
        orientation="vertical"
        role="region"
        size={48}
      >
        <div className="space-y-6">
          {notices}
          <Card variant="secondary">
            <Card.Header>
              <Card.Title>Virtual machine summary</Card.Title>
              <Card.Description>Compute and network identifiers for this tagged managed server.</Card.Description>
            </Card.Header>
            <Card.Content>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                <DeploymentDetail label="VM name" value={deployment.runtime.vmName ?? "Pending"} mono />
                <DeploymentDetail label="VM size" value={deployment.spec.vmSize} mono />
                <DeploymentDetail label="Location" value={deployment.spec.location} mono />
                <DeploymentDetail label="Resource group" value={firewall?.resourceGroupName ?? deployment.runtime.resourceGroupName ?? "Pending"} mono />
                <DeploymentDetail
                  label="Public IP"
                  value={deployment.runtime.publicIpAddress ?? "None"}
                  mono
                  onCopy={deployment.runtime.publicIpAddress ? () => { void copyCloudIpAddress(api, deployment.id, "public"); } : undefined}
                />
                <DeploymentDetail
                  label="Private IP"
                  value={deployment.runtime.privateIpAddress ?? "Pending"}
                  mono
                  onCopy={deployment.runtime.privateIpAddress ? () => { void copyCloudIpAddress(api, deployment.id, "private"); } : undefined}
                />
                <DeploymentDetail label="VNet" value={deployment.runtime.vnetId ?? deployment.spec.vnetId ?? "Pending"} mono />
                <DeploymentDetail label="Subnet" value={deployment.runtime.subnetId ?? deployment.spec.subnetId ?? "Pending"} mono />
                <DeploymentDetail label="Network security group" value={nsgId} mono />
                <DeploymentDetail label="Network interface" value={deployment.runtime.networkInterfaceId ?? "Pending"} mono />
                <DeploymentDetail label="OS disk" value={deployment.runtime.osDiskId ?? "Pending"} mono />
                <DeploymentDetail label="Provisioning" value={deployment.runtime.provisioningState ?? "Pending"} />
              </dl>
            </Card.Content>
          </Card>

          <Card variant="secondary">
            <Card.Header className="flex-col items-stretch gap-4 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <Card.Title>Firewall rules</Card.Title>
                <Card.Description>{nsgName} · {nsgId}</Card.Description>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2 self-end sm:self-auto">
                <Tooltip delay={0}>
                  <Button
                    aria-label="Refresh firewall rules"
                    isDisabled={isLoadingRules || pendingMutation !== null}
                    isIconOnly
                    size="sm"
                    variant="outline"
                    onPress={() => void Promise.allSettled([
                      loadRules(),
                      currentEgressIpv4.refresh(),
                    ])}
                  >
                    <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={isLoadingRules ? "animate-spin" : ""} />
                  </Button>
                  <Tooltip.Content>Refresh firewall rules</Tooltip.Content>
                </Tooltip>
                {canAllowCurrentEgressIpv4 && currentEgressCidr ? (
                  <Button
                    aria-label={`Allow current IP ${currentEgressCidr}`}
                    className="text-success"
                    isDisabled={pendingMutation !== null}
                    isPending={pendingMutation === "current-ip"}
                    size="sm"
                    variant="outline"
                    onPress={() => void allowCurrentEgressIpv4()}
                  >
                    <FontAwesomeIcon aria-hidden icon={faShieldHalved} />
                    Allow my IP
                  </Button>
                ) : null}
                <Button
                  isDisabled={!firewall || isLoadingRules || pendingMutation !== null}
                  size="sm"
                  variant="primary"
                  onPress={openCreateRule}
                >
                  <FontAwesomeIcon aria-hidden icon={faPlus} /> Add rule
                </Button>
              </div>
            </Card.Header>
            <Card.Content className="space-y-4">
              <Tabs
                selectedKey={selectedDirection}
                variant="secondary"
                onSelectionChange={(key) => {
                  if (key === "ingress" || key === "egress") setSelectedDirection(key);
                }}
              >
                <Tabs.ListContainer className="w-fit max-w-full">
                  <Tabs.List aria-label="Firewall rule direction" className="w-fit whitespace-nowrap">
                    <Tabs.Tab className="min-w-28 whitespace-nowrap" id="ingress">
                      Inbound <Chip className="ml-1" size="sm" variant="soft">{ingressRules.length}</Chip>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                    <Tabs.Tab className="min-w-28 whitespace-nowrap" id="egress">
                      Outbound <Chip className="ml-1" size="sm" variant="soft">{egressRules.length}</Chip>
                      <Tabs.Indicator />
                    </Tabs.Tab>
                  </Tabs.List>
                </Tabs.ListContainer>
                {(["ingress", "egress"] as const).map((direction) => (
                  <Tabs.Panel className="pt-4" id={direction} key={direction}>
                    <AzureFirewallRulesContent
                      columns={columns}
                      deploymentId={deployment.id}
                      direction={direction}
                      firewall={firewall}
                      isLoading={isLoadingRules}
                      isPending={pendingMutation !== null}
                      rules={direction === "ingress" ? ingressRules : egressRules}
                      rulesError={rulesError}
                      onEdit={openEditRule}
                      onRetry={() => void loadRules()}
                    />
                  </Tabs.Panel>
                ))}
              </Tabs>
            </Card.Content>
          </Card>
        </div>
      </ScrollShadow>

      <AzureFirewallRuleSheet
        editor={editor}
        error={editorError}
        isPending={pendingMutation === "create" || pendingMutation === "update"}
        onChange={setEditor}
        onClose={() => {
          if (pendingMutation === null) {
            setEditor(null);
            setEditorError(null);
          }
        }}
        onSave={() => void saveRule()}
      />

      <AlertDialog.Backdrop
        isOpen={deleteRule !== null}
        variant="blur"
        onOpenChange={(open) => {
          if (!open && pendingMutation !== "delete") {
            setDeleteRule(null);
            setDeleteError(null);
          }
        }}
      >
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[460px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-5" /></AlertDialog.Icon>
              <AlertDialog.Heading>Delete firewall rule?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <div className="space-y-3 text-sm leading-6 text-muted">
                <p>{deleteRule ? `${deleteRule.name} will be removed from ${directionLabel(deleteRule.direction).toLowerCase()}.` : "This network security rule will be removed."}</p>
                <p>This change takes effect immediately in Microsoft Azure.</p>
                {deleteError ? <InlineMessage tone="danger" title="Rule deletion failed" detail={deleteError} /> : null}
              </div>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={pendingMutation === "delete"} variant="tertiary" onPress={() => setDeleteRule(null)}>Cancel</Button>
              <Button isPending={pendingMutation === "delete"} variant="danger" onPress={() => void removeRule()}>Delete rule</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  );
}

function AzureFirewallRulesContent({
  columns,
  deploymentId,
  direction,
  firewall,
  isLoading,
  isPending,
  rules,
  rulesError,
  onEdit,
  onRetry,
}: {
  readonly columns: DataGridColumn<AzureFirewallRule>[];
  readonly deploymentId: string;
  readonly direction: AzureFirewallDirection;
  readonly firewall: AzureFirewallSnapshot | null;
  readonly isLoading: boolean;
  readonly isPending: boolean;
  readonly rules: readonly AzureFirewallRule[];
  readonly rulesError: string | null;
  readonly onEdit: (rule: AzureFirewallRule) => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  if (isLoading && !firewall) {
    return (
      <div aria-label={`Loading ${directionLabel(direction).toLowerCase()} rules`} className="space-y-2 py-2">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (rulesError && !firewall) {
    return (
      <div className="space-y-3">
        <InlineMessage tone="danger" title="Firewall rules unavailable" detail={rulesError} />
        <Button size="sm" variant="outline" onPress={onRetry}>Try again</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rulesError ? <InlineMessage tone="warning" title="Refresh failed" detail={`${rulesError} The last loaded rules remain visible.`} /> : null}
      <DataGrid
        aria-label={`${directionLabel(direction)} firewall rules`}
        className="firewall-rules-grid [&_tbody_tr]:cursor-[var(--cursor-interactive)]"
        columns={columns}
        contentClassName="min-w-[1050px]"
        data={[...rules]}
        disabledKeys={rules.filter((rule) => isPending || azureFirewallRuleEditUnsupportedReason(rule, deploymentId)).map(({ id }) => id)}
        getRowId={(rule) => rule.id}
        onRowAction={(key) => {
          const rule = rules.find(({ id }) => id === String(key));
          if (rule && !isPending && !azureFirewallRuleEditUnsupportedReason(rule, deploymentId)) onEdit(rule);
        }}
        renderEmptyState={() => (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">No {directionLabel(direction).toLowerCase()} rules</p>
            <p className="mt-1 text-xs text-muted">Add a network security rule for the traffic this server needs.</p>
          </div>
        )}
        verticalAlign="top"
        variant="secondary"
      />
    </div>
  );
}

function AzureFirewallRuleSheet({
  editor,
  error,
  isPending,
  onChange,
  onClose,
  onSave,
}: {
  readonly editor: AzureFirewallEditorState | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onChange: (editor: AzureFirewallEditorState) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const draft = editor?.draft;
  const isEdit = editor?.mode === "edit";
  const publicIngress = Boolean(
    draft?.direction === "ingress" &&
    draft.access === "allow" &&
    azureFirewallDraftValues(draft.sourceAddressPrefixes).some((prefix) => (
      ["*", "0.0.0.0/0", "::/0", "internet"].includes(prefix.toLowerCase())
    )),
  );
  const updateDraft = (nextDraft: AzureFirewallRuleDraft): void => {
    if (!editor) return;
    onChange(editor.mode === "edit"
      ? { mode: "edit", ruleId: editor.ruleId, draft: nextDraft }
      : { mode: "create", draft: nextDraft });
  };

  return (
    <Sheet
      isDismissable={!isPending}
      isOpen={editor !== null}
      placement="right"
      shouldAutoFocus
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="h-full w-full max-w-[540px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger aria-label="Close firewall rule editor" isDisabled={isPending} />
            <Sheet.Header>
              <Sheet.Heading>{isEdit ? "Edit firewall rule" : "Add firewall rule"}</Sheet.Heading>
              <p className="text-sm leading-6 text-muted">
                {isEdit ? "Update this Azure network security rule. Its resource name stays fixed." : "Create one rule in the deployment network security group."}
              </p>
            </Sheet.Header>
            <Sheet.Body className="min-h-0 space-y-5 overflow-auto">
              {draft ? (
                <>
                  {error ? <InlineMessage tone="danger" title="Firewall rule invalid" detail={error} /> : null}
                  {publicIngress ? (
                    <InlineMessage tone="warning" title="Public inbound access" detail="This allow rule accepts inbound traffic from the public Internet. Review the source and destination ports before saving." />
                  ) : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <CloudTextField
                      description={isEdit ? "Rule names cannot be changed after creation." : "Unique within this network security group."}
                      isDisabled={isEdit || isPending}
                      label="Name"
                      placeholder="allow-operator-ssh"
                      value={draft.name}
                      onChange={(name) => updateDraft({ ...draft, name })}
                    />
                    <CloudTextField
                      description="100–4096; lower numbers run first."
                      inputMode="numeric"
                      isDisabled={isPending}
                      label="Priority"
                      value={draft.priority}
                      onChange={(priority) => updateDraft({ ...draft, priority })}
                    />
                    <CloudNativeSelect
                      isDisabled={isPending}
                      label="Direction"
                      options={[{ value: "ingress", label: "Inbound" }, { value: "egress", label: "Outbound" }]}
                      value={draft.direction}
                      onChange={(direction) => {
                        if (direction === "ingress" || direction === "egress") updateDraft({ ...draft, direction });
                      }}
                    />
                    <CloudNativeSelect
                      isDisabled={isPending}
                      label="Access"
                      options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]}
                      value={draft.access}
                      onChange={(access) => {
                        if (access === "allow" || access === "deny") updateDraft({ ...draft, access });
                      }}
                    />
                    <CloudNativeSelect
                      isDisabled={isPending}
                      label="Protocol"
                      options={[
                        { value: "*", label: "Any" },
                        { value: "tcp", label: "TCP" },
                        { value: "udp", label: "UDP" },
                        { value: "icmp", label: "ICMP" },
                        { value: "ah", label: "AH" },
                        { value: "esp", label: "ESP" },
                      ]}
                      value={draft.protocol}
                      onChange={(protocol) => {
                        if (isAzureFirewallProtocol(protocol)) updateDraft({ ...draft, protocol });
                      }}
                    />
                    <CloudTextArea
                      description="One port, ordered range, or * per line. Multiple values use Azure augmented-rule semantics."
                      isDisabled={isPending}
                      label="Source Port Ranges"
                      value={draft.sourcePortRanges}
                      onChange={(sourcePortRanges) => updateDraft({ ...draft, sourcePortRanges })}
                    />
                    <CloudTextArea
                      description="One CIDR, IP address, *, or Azure service tag per line."
                      isDisabled={isPending}
                      label="Source Address Prefixes"
                      value={draft.sourceAddressPrefixes}
                      onChange={(sourceAddressPrefixes) => updateDraft({ ...draft, sourceAddressPrefixes })}
                    />
                    <CloudTextArea
                      description="One port, ordered range, or * per line. Multiple values use Azure augmented-rule semantics."
                      isDisabled={isPending}
                      label="Destination Port Ranges"
                      value={draft.destinationPortRanges}
                      onChange={(destinationPortRanges) => updateDraft({ ...draft, destinationPortRanges })}
                    />
                    <CloudTextArea
                      description="One CIDR, IP address, *, or Azure service tag per line."
                      isDisabled={isPending}
                      label="Destination Address Prefixes"
                      value={draft.destinationAddressPrefixes}
                      onChange={(destinationAddressPrefixes) => updateDraft({ ...draft, destinationAddressPrefixes })}
                    />
                  </div>
                  <CloudTextField
                    description="Optional Azure network security rule description (140 characters maximum)."
                    isDisabled={isPending}
                    label="Description"
                    placeholder="Why this access is needed"
                    value={draft.description}
                    onChange={(description) => updateDraft({ ...draft, description })}
                  />
                </>
              ) : null}
            </Sheet.Body>
            <Sheet.Footer>
              <Button isDisabled={isPending} variant="tertiary" onPress={onClose}>Cancel</Button>
              <Button isPending={isPending} variant="primary" onPress={onSave}>{isEdit ? "Save changes" : "Add rule"}</Button>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

function azureFirewallColumns({
  currentEgressAddress,
  deploymentId,
  direction,
  isPending,
  onDelete,
  onEdit,
}: {
  readonly currentEgressAddress: string | null;
  readonly deploymentId: string;
  readonly direction: AzureFirewallDirection;
  readonly isPending: boolean;
  readonly onDelete: (rule: AzureFirewallRule) => void;
  readonly onEdit: (rule: AzureFirewallRule) => void;
}): DataGridColumn<AzureFirewallRule>[] {
  return [
    {
      id: "name",
      header: "Name",
      isRowHeader: true,
      minWidth: 190,
      cell: (rule) => (
        <div
          className="flex min-w-0 flex-col items-start gap-1"
          data-firewall-rule-accent={azureFirewallRuleAccent(rule, currentEgressAddress) ?? undefined}
        >
          <span className="max-w-48 truncate font-mono text-xs" title={rule.name}>{rule.name}</span>
          <div className="flex flex-wrap gap-1">
            <Chip size="sm" variant="soft">{rule.isDefault ? "Azure default" : azureFirewallRuleProtectionReason(rule, deploymentId) ? "Sliver GUI baseline" : rule.managed ? "Sliver GUI" : "Azure"}</Chip>
            {rule.editUnsupportedReason ? (
              <Chip color="warning" size="sm" title={rule.editUnsupportedReason} variant="soft">Edit unavailable</Chip>
            ) : null}
          </div>
        </div>
      ),
    },
    { id: "priority", header: "Priority", minWidth: 90, accessorKey: "priority" },
    { id: "access", header: "Access", minWidth: 90, cell: (rule) => titleCase(rule.access) },
    { id: "protocol", header: "Protocol", minWidth: 90, cell: (rule) => rule.protocol === "*" ? "Any" : rule.protocol.toUpperCase() },
    {
      id: "source",
      header: direction === "ingress" ? "Source" : "Source address",
      minWidth: 170,
      cell: (rule) => (
        <AzureFirewallEndpoint
          addressPrefixes={rule.sourceAddressPrefixes}
          applicationSecurityGroupIds={rule.sourceApplicationSecurityGroupIds}
          currentEgressAddress={currentEgressAddress}
          portRanges={rule.sourcePortRanges}
          ruleAccent={azureFirewallRuleAccent(rule, currentEgressAddress)}
        />
      ),
    },
    {
      id: "destination",
      header: direction === "egress" ? "Destination" : "Destination address",
      minWidth: 190,
      cell: (rule) => (
        <AzureFirewallEndpoint
          addressPrefixes={rule.destinationAddressPrefixes}
          applicationSecurityGroupIds={rule.destinationApplicationSecurityGroupIds}
          currentEgressAddress={currentEgressAddress}
          portRanges={rule.destinationPortRanges}
          ruleAccent={azureFirewallRuleAccent(rule, currentEgressAddress)}
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "end",
      minWidth: 104,
      cell: (rule) => (
        <div
          className="flex justify-end gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Tooltip delay={0}>
            <Button
              aria-label={`Edit firewall rule ${rule.name}`}
              isDisabled={isPending || Boolean(azureFirewallRuleEditUnsupportedReason(rule, deploymentId))}
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => onEdit(rule)}
            >
              <FontAwesomeIcon aria-hidden icon={faPen} />
            </Button>
            <Tooltip.Content>{azureFirewallRuleEditUnsupportedReason(rule, deploymentId) ?? "Edit rule"}</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Button
              aria-label={`Delete firewall rule ${rule.name}`}
              isDisabled={isPending || Boolean(azureFirewallRuleProtectionReason(rule, deploymentId))}
              isIconOnly
              size="sm"
              variant="danger-soft"
              onPress={() => onDelete(rule)}
            >
              <FontAwesomeIcon aria-hidden icon={faTrash} />
            </Button>
            <Tooltip.Content>{azureFirewallRuleProtectionReason(rule, deploymentId) ?? "Delete rule"}</Tooltip.Content>
          </Tooltip>
        </div>
      ),
    },
  ];
}

function AzureFirewallEndpoint({
  addressPrefixes,
  applicationSecurityGroupIds,
  currentEgressAddress,
  portRanges,
  ruleAccent,
}: {
  readonly addressPrefixes: readonly string[];
  readonly applicationSecurityGroupIds: readonly string[];
  readonly currentEgressAddress: string | null;
  readonly portRanges: readonly string[];
  readonly ruleAccent: FirewallIpv4Accent;
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1 font-mono text-xs">
      {addressPrefixes.map((prefix, index) => (
        <FirewallIpv4Cidr
          accent={firewallIpv4ValueAccent(prefix, ruleAccent, currentEgressAddress)}
          key={`prefix-${index}-${prefix}`}
          value={prefix}
        />
      ))}
      {applicationSecurityGroupIds.map((id, index) => (
        <span className="max-w-72 truncate" key={`asg-${index}-${id}`} title={id}>ASG · {id}</span>
      ))}
      <span className="text-muted">Ports · {portRanges.join(", ")}</span>
    </div>
  );
}

function FirewallIpv4Cidr({
  accent,
  value,
}: {
  readonly accent: FirewallIpv4Accent;
  readonly value: string;
}): React.JSX.Element {
  return (
    <span className="inline-flex w-fit flex-wrap items-center gap-1.5">
      <span>{value}</span>
      {accent ? (
        <Chip color={accent} size="sm" variant="soft">
          {accent === "danger" ? "Any IPv4" : "Current IP"}
        </Chip>
      ) : null}
    </span>
  );
}

function firewallIpv4ValueAccent(
  cidr: string,
  ruleAccent: FirewallIpv4Accent,
  currentEgressAddress: string | null,
): FirewallIpv4Accent {
  if (ruleAccent === "danger") return isAnyIpv4Cidr(cidr) ? "danger" : null;
  if (
    ruleAccent === "success" &&
    currentEgressAddress !== null &&
    ipv4RangeContainsAddress(cidr, currentEgressAddress)
  ) {
    return "success";
  }
  return null;
}

function awsFirewallRuleAccent(
  rule: AwsFirewallRule,
  currentEgressAddress: string | null,
): FirewallIpv4Accent {
  return firewallIpv4Accent(
    rule.peerType === "ipv4" ? [rule.peer] : [],
    currentEgressAddress,
  );
}

function azureFirewallRuleAccent(
  rule: AzureFirewallRule,
  currentEgressAddress: string | null,
): FirewallIpv4Accent {
  return firewallIpv4Accent(
    [...rule.sourceAddressPrefixes, ...rule.destinationAddressPrefixes],
    currentEgressAddress,
  );
}

function awsFirewallHasSpecificIngressRangeFor(
  rules: readonly AwsFirewallRule[],
  currentEgressAddress: string,
): boolean {
  return rules.some((rule) => (
    rule.direction === "ingress" &&
    rule.peerType === "ipv4" &&
    !isAnyIpv4Cidr(rule.peer) &&
    ipv4CidrContainsAddress(rule.peer, currentEgressAddress)
  ));
}

function azureFirewallHasSpecificIngressRangeFor(
  rules: readonly AzureFirewallRule[],
  currentEgressAddress: string,
): boolean {
  return rules.some((rule) => (
    rule.direction === "ingress" &&
    rule.access === "allow" &&
    rule.sourceAddressPrefixes.some((cidr) => (
      !isAnyIpv4Cidr(cidr) && ipv4RangeContainsAddress(cidr, currentEgressAddress)
    ))
  ));
}

function appendUniqueCidr(cidrs: readonly string[], cidr: string): readonly string[] {
  return cidrs.includes(cidr) ? cidrs : [...cidrs, cidr];
}

function azureFirewallRuleProtectionReason(rule: AzureFirewallRule, deploymentId: string): string | null {
  if (rule.isDefault) return "Azure default rules are read-only here.";
  const baselineKind = rule.name.startsWith("sliver-gui-ssh-")
    ? "ssh"
    : rule.name.startsWith("sliver-gui-operator-")
      ? "operator"
      : null;
  return baselineKind !== null && rule.description === `sliver-gui:${deploymentId}:baseline:${baselineKind}`
    ? "Sliver GUI baseline rules are managed through the deployment access settings."
    : null;
}

function azureFirewallRuleEditUnsupportedReason(rule: AzureFirewallRule, deploymentId: string): string | null {
  return azureFirewallRuleProtectionReason(rule, deploymentId) ?? rule.editUnsupportedReason;
}

function initialAzureFirewallRuleDraft(direction: AzureFirewallDirection): AzureFirewallRuleDraft {
  return {
    name: "allow-operator-ssh",
    priority: "1200",
    direction,
    access: "allow",
    protocol: "tcp",
    sourceAddressPrefixes: "",
    sourcePortRanges: "*",
    destinationAddressPrefixes: "*",
    destinationPortRanges: "22",
    description: "",
  };
}

function azureFirewallRuleDraft(rule: AzureFirewallRule): AzureFirewallRuleDraft {
  return {
    name: rule.name,
    priority: String(rule.priority),
    direction: rule.direction,
    access: rule.access,
    protocol: rule.protocol,
    sourceAddressPrefixes: rule.sourceAddressPrefixes.join("\n"),
    sourcePortRanges: rule.sourcePortRanges.join("\n"),
    destinationAddressPrefixes: rule.destinationAddressPrefixes.join("\n"),
    destinationPortRanges: rule.destinationPortRanges.join("\n"),
    description: rule.description ?? "",
  };
}

function parseAzureFirewallRuleDraft(
  draft: AzureFirewallRuleDraft,
): { readonly ok: true; readonly value: AzureFirewallRuleSpec } | { readonly ok: false; readonly error: string } {
  const name = draft.name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(name)) {
    return { ok: false, error: "Name must be 1–80 characters and use letters, numbers, dot, dash, or underscore." };
  }
  const priority = strictInteger(draft.priority);
  if (priority === null || priority < 100 || priority > 4_096) {
    return { ok: false, error: "Priority must be an integer from 100 to 4096." };
  }
  if (priority >= 1_000 && priority <= 1_199) {
    return { ok: false, error: "Priorities 1000 through 1199 are reserved for baseline access." };
  }
  const sourceAddressPrefixes = parseAzureFirewallDraftValues(
    draft.sourceAddressPrefixes,
    validAzureAddressPrefix,
  );
  const destinationAddressPrefixes = parseAzureFirewallDraftValues(
    draft.destinationAddressPrefixes,
    validAzureAddressPrefix,
  );
  if (!sourceAddressPrefixes.ok || !destinationAddressPrefixes.ok) {
    return { ok: false, error: "Enter one source and destination CIDR, IP address, *, or Azure service tag per line." };
  }
  const sourcePortRanges = parseAzureFirewallDraftValues(
    draft.sourcePortRanges,
    validAzurePortRange,
  );
  const destinationPortRanges = parseAzureFirewallDraftValues(
    draft.destinationPortRanges,
    validAzurePortRange,
  );
  if (!sourcePortRanges.ok || !destinationPortRanges.ok) {
    return { ok: false, error: "Enter one port per line as *, a value from 0 to 65535, or an ordered range such as 8000-8100." };
  }
  const description = draft.description.trim();
  if (description.length > 140 || /[\u0000-\u001f\u007f]/u.test(description)) {
    return { ok: false, error: "Description must be 140 printable characters or fewer." };
  }
  return {
    ok: true,
    value: {
      name,
      priority,
      direction: draft.direction,
      access: draft.access,
      protocol: draft.protocol,
      sourceAddressPrefixes: sourceAddressPrefixes.value,
      sourcePortRanges: sourcePortRanges.value,
      destinationAddressPrefixes: destinationAddressPrefixes.value,
      destinationPortRanges: destinationPortRanges.value,
      description: description || null,
    },
  };
}

function azureFirewallDraftValues(value: string): readonly string[] {
  return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}

function parseAzureFirewallDraftValues(
  value: string,
  validate: (entry: string) => boolean,
): { readonly ok: true; readonly value: readonly string[] } | { readonly ok: false } {
  const values = azureFirewallDraftValues(value);
  if (values.length === 0 || values.length > AZURE_FIREWALL_RULE_MAX_VALUES || !values.every(validate)) {
    return { ok: false };
  }
  return { ok: true, value: values };
}

function isAzureFirewallProtocol(value: string): value is AzureFirewallProtocol {
  return ["*", "tcp", "udp", "icmp", "ah", "esp"].includes(value);
}

function validAzureAddressPrefix(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validAzurePortRange(value: string): boolean {
  if (value === "*") return true;
  const match = /^(\d{1,5})(?:-(\d{1,5}))?$/u.exec(value);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start <= end && end <= 65_535;
}

function AwsFirewallRulesContent({
  columns,
  direction,
  firewall,
  isLoading,
  isPending,
  rules,
  rulesError,
  onEdit,
  onRetry,
}: {
  readonly columns: DataGridColumn<AwsFirewallRule>[];
  readonly direction: AwsFirewallDirection;
  readonly firewall: AwsFirewallSnapshot | null;
  readonly isLoading: boolean;
  readonly isPending: boolean;
  readonly rules: readonly AwsFirewallRule[];
  readonly rulesError: string | null;
  readonly onEdit: (rule: AwsFirewallRule) => void;
  readonly onRetry: () => void;
}): React.JSX.Element {
  if (isLoading && !firewall) {
    return (
      <div aria-label={`Loading ${directionLabel(direction).toLowerCase()} rules`} className="space-y-2 py-2">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (rulesError && !firewall) {
    return (
      <div className="space-y-3">
        <InlineMessage tone="danger" title="Firewall rules unavailable" detail={rulesError} />
        <Button size="sm" variant="outline" onPress={onRetry}>Try again</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {rulesError ? <InlineMessage tone="warning" title="Refresh failed" detail={`${rulesError} The last loaded rules remain visible.`} /> : null}
      <DataGrid
        aria-label={`${directionLabel(direction)} firewall rules`}
        className="firewall-rules-grid [&_tbody_tr]:cursor-[var(--cursor-interactive)]"
        columns={columns}
        contentClassName="min-w-[900px]"
        data={[...rules]}
        {...(isPending ? { disabledKeys: rules.map(({ id }) => id) } : {})}
        getRowId={(rule) => rule.id}
        onRowAction={(key) => {
          const rule = rules.find(({ id }) => id === String(key));
          if (rule && !isPending) onEdit(rule);
        }}
        renderEmptyState={() => (
          <div className="py-8 text-center">
            <p className="text-sm font-medium">No {directionLabel(direction).toLowerCase()} rules</p>
            <p className="mt-1 text-xs text-muted">Add a managed rule to allow the traffic this server needs.</p>
          </div>
        )}
        verticalAlign="top"
        variant="secondary"
      />
    </div>
  );
}

function AwsFirewallRuleSheet({
  editor,
  error,
  isPending,
  onChange,
  onClose,
  onSave,
}: {
  readonly editor: AwsFirewallEditorState | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly onChange: (editor: AwsFirewallEditorState) => void;
  readonly onClose: () => void;
  readonly onSave: () => void;
}): React.JSX.Element {
  const draft = editor?.draft;
  const isEdit = editor?.mode === "edit";
  const selectedPreset = AWS_FIREWALL_PRESETS.find(({ id }) => id === draft?.preset);
  const publicIngress = Boolean(
    draft?.direction === "ingress" &&
    ((draft.peerType === "ipv4" && draft.peer.trim() === "0.0.0.0/0") ||
      (draft.peerType === "ipv6" && draft.peer.trim() === "::/0")),
  );

  const updateDraft = (nextDraft: AwsFirewallRuleDraft): void => {
    if (!editor) return;
    onChange(editor.mode === "edit"
      ? { mode: "edit", ruleId: editor.ruleId, draft: nextDraft }
      : { mode: "create", draft: nextDraft });
  };

  return (
    <Sheet
      isDismissable={!isPending}
      isOpen={editor !== null}
      placement="right"
      shouldAutoFocus
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <Sheet.Backdrop variant="blur">
        <Sheet.Content className="h-full w-full max-w-[500px]">
          <Sheet.Dialog className="h-full">
            <Sheet.CloseTrigger aria-label="Close firewall rule editor" isDisabled={isPending} />
            <Sheet.Header>
              <Sheet.Heading>{isEdit ? "Edit firewall rule" : "Add firewall rule"}</Sheet.Heading>
              <p className="text-sm leading-6 text-muted">
                {isEdit
                  ? "AWS keeps the rule direction and peer kind fixed. Other rule fields can be updated."
                  : "Create one managed rule in the deployment security group."}
              </p>
            </Sheet.Header>
            <Sheet.Body className="min-h-0 space-y-5 overflow-auto">
              {draft ? (
                <>
                  {error ? <InlineMessage tone="danger" title="Firewall rule invalid" detail={error} /> : null}
                  {publicIngress ? (
                    <InlineMessage
                      tone="warning"
                      title="Public inbound access"
                      detail={`${draft.peer.trim()} allows this port or protocol from every ${draft.peerType === "ipv4" ? "IPv4" : "IPv6"} address. Review the exposure before saving.`}
                    />
                  ) : null}
                  <CloudNativeSelect
                    description={isEdit ? "Direction cannot be changed after AWS creates a rule." : undefined}
                    isDisabled={isEdit || isPending}
                    label="Direction"
                    options={[
                      { value: "ingress", label: "Inbound" },
                      { value: "egress", label: "Outbound" },
                    ]}
                    value={draft.direction}
                    onChange={(direction) => {
                      if (direction === "ingress" || direction === "egress") updateDraft({ ...draft, direction });
                    }}
                  />
                  <CloudRichSelect
                    description={selectedPreset?.description}
                    isDisabled={isPending}
                    label="Type"
                    options={AWS_FIREWALL_PRESETS.map((preset) => ({
                      value: preset.id,
                      label: preset.label,
                      description: preset.description,
                    }))}
                    value={draft.preset}
                    onChange={(presetId) => updateDraft(applyAwsFirewallPreset(draft, presetId))}
                  />
                  {draft.preset === "custom-protocol" ? (
                    <CloudTextField
                      description="Use the canonical IP protocol number from 0 to 255."
                      inputMode="numeric"
                      isDisabled={isPending}
                      label="Protocol number"
                      placeholder="For example, 50"
                      value={draft.protocol}
                      onChange={(protocol) => updateDraft({ ...draft, protocol })}
                    />
                  ) : null}
                  {awsFirewallPresetNeedsPorts(draft.preset) ? (
                    <div className="grid gap-4 sm:grid-cols-2">
                      <CloudTextField
                        description={awsFirewallPresetUsesIcmp(draft.preset) ? "-1 means every type." : "0–65535"}
                        inputMode="numeric"
                        isDisabled={isPending}
                        label={awsFirewallPresetUsesIcmp(draft.preset) ? "ICMP type" : "From port"}
                        value={draft.fromPort}
                        onChange={(fromPort) => updateDraft({ ...draft, fromPort })}
                      />
                      <CloudTextField
                        description={awsFirewallPresetUsesIcmp(draft.preset) ? "-1 means every code." : "0–65535"}
                        inputMode="numeric"
                        isDisabled={isPending}
                        label={awsFirewallPresetUsesIcmp(draft.preset) ? "ICMP code" : "To port"}
                        value={draft.toPort}
                        onChange={(toPort) => updateDraft({ ...draft, toPort })}
                      />
                    </div>
                  ) : null}
                  <CloudNativeSelect
                    description={isEdit ? "Peer type cannot be changed after AWS creates a rule." : undefined}
                    isDisabled={isEdit || isPending}
                    label={draft.direction === "ingress" ? "Source type" : "Destination type"}
                    options={[
                      { value: "ipv4", label: "IPv4 CIDR" },
                      { value: "ipv6", label: "IPv6 CIDR" },
                      { value: "prefix-list", label: "Prefix list" },
                      { value: "security-group", label: "Security group" },
                    ]}
                    value={draft.peerType}
                    onChange={(peerType) => {
                      if (isAwsFirewallPeerType(peerType)) updateDraft({ ...draft, peerType, peer: "" });
                    }}
                  />
                  <CloudTextField
                    description={awsFirewallPeerDescription(draft.direction, draft.peerType)}
                    isDisabled={isPending}
                    label={draft.direction === "ingress" ? "Source" : "Destination"}
                    placeholder={awsFirewallPeerPlaceholder(draft.peerType)}
                    value={draft.peer}
                    onChange={(peer) => updateDraft({ ...draft, peer })}
                  />
                  <CloudTextField
                    description="Optional AWS security-group rule description."
                    isDisabled={isPending}
                    label="Description"
                    placeholder="Why this access is needed"
                    value={draft.description}
                    onChange={(description) => updateDraft({ ...draft, description })}
                  />
                </>
              ) : null}
            </Sheet.Body>
            <Sheet.Footer>
              <Button isDisabled={isPending} variant="tertiary" onPress={onClose}>Cancel</Button>
              <Button isPending={isPending} variant="primary" onPress={onSave}>{isEdit ? "Save changes" : "Add rule"}</Button>
            </Sheet.Footer>
          </Sheet.Dialog>
        </Sheet.Content>
      </Sheet.Backdrop>
    </Sheet>
  );
}

function awsFirewallColumns({
  currentEgressAddress,
  direction,
  isPending,
  onDelete,
  onEdit,
}: {
  readonly currentEgressAddress: string | null;
  readonly direction: AwsFirewallDirection;
  readonly isPending: boolean;
  readonly onDelete: (rule: AwsFirewallRule) => void;
  readonly onEdit: (rule: AwsFirewallRule) => void;
}): DataGridColumn<AwsFirewallRule>[] {
  return [
    {
      id: "id",
      header: "Rule ID",
      isRowHeader: true,
      minWidth: 180,
      cell: (rule) => (
        <div
          className="flex min-w-0 flex-col items-start gap-1"
          data-firewall-rule-accent={awsFirewallRuleAccent(rule, currentEgressAddress) ?? undefined}
        >
          <span className="max-w-44 truncate font-mono text-xs" title={rule.id}>{rule.id}</span>
          <Chip size="sm" variant="soft">{rule.managed ? "Sliver GUI" : "AWS"}</Chip>
        </div>
      ),
    },
    {
      id: "peerType",
      header: direction === "ingress" ? "IP version / source type" : "IP version / destination type",
      minWidth: 155,
      cell: (rule) => awsFirewallPeerTypeLabel(rule.peerType),
    },
    {
      id: "type",
      header: "Type",
      minWidth: 130,
      cell: ruleTypeLabel,
    },
    {
      id: "protocol",
      header: "Protocol",
      minWidth: 100,
      cell: (rule) => awsFirewallProtocolLabel(rule.protocol),
    },
    {
      id: "ports",
      header: "Port range",
      minWidth: 120,
      cell: awsFirewallPortRange,
    },
    {
      id: "peer",
      header: direction === "ingress" ? "Source" : "Destination",
      minWidth: 180,
      cellClassName: "font-mono text-xs",
      cell: (rule) => (
        <FirewallIpv4Cidr
          accent={firewallIpv4ValueAccent(
            rule.peer,
            awsFirewallRuleAccent(rule, currentEgressAddress),
            currentEgressAddress,
          )}
          value={rule.peer}
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      align: "end",
      minWidth: 104,
      cell: (rule) => (
        <div
          className="flex justify-end gap-1"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Tooltip delay={0}>
            <Button
              aria-label={`Edit firewall rule ${rule.id}`}
              isDisabled={isPending}
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={() => onEdit(rule)}
            >
              <FontAwesomeIcon aria-hidden icon={faPen} />
            </Button>
            <Tooltip.Content>Edit rule</Tooltip.Content>
          </Tooltip>
          <Tooltip delay={0}>
            <Button
              aria-label={`Delete firewall rule ${rule.id}`}
              isDisabled={isPending}
              isIconOnly
              size="sm"
              variant="danger-soft"
              onPress={() => onDelete(rule)}
            >
              <FontAwesomeIcon aria-hidden icon={faTrash} />
            </Button>
            <Tooltip.Content>Delete rule</Tooltip.Content>
          </Tooltip>
        </div>
      ),
    },
  ];
}

function initialAwsFirewallRuleDraft(direction: AwsFirewallDirection): AwsFirewallRuleDraft {
  return applyAwsFirewallPreset({
    direction,
    preset: "custom-tcp",
    protocol: "tcp",
    fromPort: "",
    toPort: "",
    peerType: "ipv4",
    peer: "",
    description: "",
  }, "custom-tcp");
}

function awsFirewallRuleDraft(rule: AwsFirewallRule): AwsFirewallRuleDraft {
  return {
    direction: rule.direction,
    preset: awsFirewallPresetForRule(rule),
    protocol: rule.protocol,
    fromPort: rule.fromPort === null ? "" : String(rule.fromPort),
    toPort: rule.toPort === null ? "" : String(rule.toPort),
    peerType: rule.peerType,
    peer: rule.peer,
    description: rule.description ?? "",
  };
}

function applyAwsFirewallPreset(
  draft: AwsFirewallRuleDraft,
  presetId: AwsFirewallPresetId,
): AwsFirewallRuleDraft {
  const preset = AWS_FIREWALL_PRESETS.find(({ id }) => id === presetId)!;
  return {
    ...draft,
    preset: preset.id,
    protocol: preset.protocol,
    fromPort: preset.fromPort === null ? "" : String(preset.fromPort),
    toPort: preset.toPort === null ? "" : String(preset.toPort),
  };
}

function awsFirewallPresetForRule(rule: AwsFirewallRuleSpec): AwsFirewallPresetId {
  if (rule.protocol === "-1") return "all-traffic";
  if (rule.protocol === "icmp") {
    return rule.fromPort === -1 && rule.toPort === -1 ? "all-icmp-ipv4" : "custom-icmp-ipv4";
  }
  if (rule.protocol === "icmpv6") {
    return rule.fromPort === -1 && rule.toPort === -1 ? "all-icmp-ipv6" : "custom-icmp-ipv6";
  }
  if (rule.protocol === "tcp" && rule.fromPort === rule.toPort) {
    if (rule.fromPort === 22) return "ssh";
    if (rule.fromPort === 80) return "http";
    if (rule.fromPort === 443) return "https";
    if (rule.fromPort === 3_389) return "rdp";
  }
  if (rule.protocol === "tcp") return "custom-tcp";
  if (rule.protocol === "udp") return "custom-udp";
  return "custom-protocol";
}

function parseAwsFirewallRuleDraft(
  draft: AwsFirewallRuleDraft,
): { readonly ok: true; readonly value: AwsFirewallRuleSpec } | { readonly ok: false; readonly error: string } {
  const protocol = draft.protocol.trim();
  if (!validAwsFirewallProtocol(protocol)) {
    return { ok: false, error: "Enter a protocol number from 0 to 255." };
  }
  let fromPort: number | null = null;
  let toPort: number | null = null;
  if (protocol === "tcp" || protocol === "udp") {
    fromPort = strictInteger(draft.fromPort);
    toPort = strictInteger(draft.toPort);
    if (fromPort === null || toPort === null || fromPort < 0 || toPort > 65_535 || fromPort > toPort) {
      return { ok: false, error: "Enter an ordered port range between 0 and 65535." };
    }
  } else if (protocol === "icmp" || protocol === "icmpv6") {
    fromPort = strictInteger(draft.fromPort);
    toPort = strictInteger(draft.toPort);
    if (
      fromPort === null || toPort === null ||
      fromPort < -1 || fromPort > 255 || toPort < -1 || toPort > 255 ||
      (fromPort === -1 && toPort !== -1)
    ) {
      return { ok: false, error: "Enter an ICMP type and code from -1 to 255; type -1 requires code -1." };
    }
  }
  const peer = draft.peer.trim();
  if (!validAwsFirewallPeer(draft.peerType, peer)) {
    return { ok: false, error: `Enter a valid ${awsFirewallPeerTypeLabel(draft.peerType)} value.` };
  }
  const description = draft.description.trim();
  if (description.length > 255 || !/^[A-Za-z0-9 ._:/()#,@\[\]+=&;{}!$*-]*$/u.test(description)) {
    return { ok: false, error: "Description must be 255 characters or fewer and use AWS-supported characters." };
  }
  return {
    ok: true,
    value: {
      direction: draft.direction,
      protocol,
      fromPort,
      toPort,
      peerType: draft.peerType,
      peer,
      description: description || null,
    },
  };
}

function validAwsFirewallProtocol(value: string): boolean {
  if (["-1", "tcp", "udp", "icmp", "icmpv6"].includes(value)) return true;
  return /^(?:0|[1-9]\d{0,2})$/u.test(value) && Number(value) <= 255;
}

function validAwsFirewallPeer(peerType: AwsFirewallPeerType, value: string): boolean {
  if (peerType === "prefix-list") return /^pl-[0-9a-f]+$/u.test(value) && value.length <= 128;
  if (peerType === "security-group") return /^sg-[0-9a-f]+$/u.test(value) && value.length <= 128;
  const match = /^(.+)\/(\d{1,3})$/u.exec(value);
  if (!match) return false;
  const address = match[1] ?? "";
  const prefix = Number(match[2]);
  return peerType === "ipv6"
    ? prefix >= 0 && prefix <= 128 && validIpv6Address(address)
    : prefix >= 0 && prefix <= 32 && validIpv4Address(address);
}

function strictInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?(?:0|[1-9]\d*)$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function awsFirewallPresetNeedsPorts(preset: AwsFirewallPresetId): boolean {
  return preset === "custom-tcp" || preset === "custom-udp" ||
    preset === "custom-icmp-ipv4" || preset === "custom-icmp-ipv6";
}

function awsFirewallPresetUsesIcmp(preset: AwsFirewallPresetId): boolean {
  return preset === "custom-icmp-ipv4" || preset === "custom-icmp-ipv6";
}

function isAwsFirewallPeerType(value: string): value is AwsFirewallPeerType {
  return value === "ipv4" || value === "ipv6" || value === "prefix-list" || value === "security-group";
}

function directionLabel(direction: AwsFirewallDirection): string {
  return direction === "ingress" ? "Inbound" : "Outbound";
}

function awsFirewallPeerTypeLabel(peerType: AwsFirewallPeerType): string {
  const labels: Record<AwsFirewallPeerType, string> = {
    ipv4: "IPv4",
    ipv6: "IPv6",
    "prefix-list": "Prefix list",
    "security-group": "Security group",
  };
  return labels[peerType];
}

function awsFirewallProtocolLabel(protocol: string): string {
  if (protocol === "-1") return "All";
  if (protocol === "icmpv6") return "ICMPv6";
  return protocol.toUpperCase();
}

function awsFirewallPortRange(rule: AwsFirewallRuleSpec): string {
  if (rule.fromPort === null || rule.toPort === null) return "All";
  if (rule.protocol === "icmp" || rule.protocol === "icmpv6") {
    return rule.fromPort === -1 ? "All types / codes" : `Type ${rule.fromPort} / code ${rule.toPort}`;
  }
  return rule.fromPort === rule.toPort ? String(rule.fromPort) : `${rule.fromPort}–${rule.toPort}`;
}

function ruleTypeLabel(rule: AwsFirewallRuleSpec): string {
  const presetId = awsFirewallPresetForRule(rule);
  return AWS_FIREWALL_PRESETS.find(({ id }) => id === presetId)?.label ?? "Custom";
}

function awsFirewallPeerDescription(
  direction: AwsFirewallDirection,
  peerType: AwsFirewallPeerType,
): string {
  const side = direction === "ingress" ? "traffic may come from" : "traffic may go to";
  return `${awsFirewallPeerTypeLabel(peerType)} ${side}. Public /0 CIDRs are allowed but highlighted before saving.`;
}

function awsFirewallPeerPlaceholder(peerType: AwsFirewallPeerType): string {
  const placeholders: Record<AwsFirewallPeerType, string> = {
    ipv4: "203.0.113.10/32",
    ipv6: "2001:db8::/64",
    "prefix-list": "pl-0123456789abcdef0",
    "security-group": "sg-0123456789abcdef0",
  };
  return placeholders[peerType];
}

function CredentialsPanel({
  api,
  snapshot,
  onFeedback,
  onRefresh,
}: {
  readonly api: CloudDeploymentAPI;
  readonly snapshot: CloudDeploymentSnapshot;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [showForm, setShowForm] = useState(snapshot.credentials.length === 0);

  return (
    <div className="space-y-6">
      <section className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-lg font-semibold">Provider Credentials</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Secrets never return to this window after saving. Existing SSH keys use a native picker and short-lived token; generated keys stay in the main process.
          </p>
        </div>
        <Button variant={showForm ? "tertiary" : "primary"} onPress={() => setShowForm((value) => !value)}>
          {showForm ? "Close Form" : "Add Credential"}
        </Button>
      </section>

      {!snapshot.secureCredentialStorage ? (
        <InlineMessage tone="warning" title="Session-only storage" detail="OS-backed encryption is unavailable, so newly added secrets remain in memory and must be added again after restart." />
      ) : null}

      {showForm ? (
        <CredentialForm
          api={api}
          awsProfiles={snapshot.awsProfiles}
          awsProfileDiscoveryError={snapshot.awsProfileDiscoveryError}
          onCancel={() => setShowForm(false)}
          onCreated={async (label) => {
            setShowForm(false);
            onFeedback({ tone: "success", title: "Credential saved", detail: `${label} is ready for connection testing and deployments.` });
            await onRefresh();
          }}
        />
      ) : null}

      {snapshot.credentials.length === 0 && !showForm ? (
        <EmptyState className="min-h-72 rounded-2xl bg-surface-secondary">
          <EmptyState.Header>
            <EmptyState.Media variant="icon"><FontAwesomeIcon aria-hidden icon={faKey} className="size-5 text-accent" /></EmptyState.Media>
            <EmptyState.Title>No Provider Credentials</EmptyState.Title>
            <EmptyState.Description>Add an AWS or Azure credential to start deploying.</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content><Button onPress={() => setShowForm(true)}>Add Credential</Button></EmptyState.Content>
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {snapshot.credentials.map((credential) => (
            <CredentialCard api={api} credential={credential} key={credential.id} onFeedback={onFeedback} onRefresh={onRefresh} />
          ))}
        </div>
      )}
    </div>
  );
}

function CredentialForm({
  api,
  awsProfiles,
  awsProfileDiscoveryError,
  onCancel,
  onCreated,
}: {
  readonly api: CloudDeploymentAPI;
  readonly awsProfiles: readonly AwsCliProfileSummary[];
  readonly awsProfileDiscoveryError: string | null;
  readonly onCancel: () => void;
  readonly onCreated: (label: string) => Promise<void>;
}): React.JSX.Element {
  const initialAwsProfile = preferredAwsProfile(awsProfiles);
  const [provider, setProvider] = useState<CloudProvider>("aws");
  const [awsAuthentication, setAwsAuthentication] = useState<"login" | "profile" | "access-keys">(
    initialAwsProfile ? "profile" : "login",
  );
  const [awsProfileName, setAwsProfileName] = useState(initialAwsProfile?.name ?? "");
  const [label, setLabel] = useState("");
  const [sshUsername, setSshUsername] = useState("ubuntu");
  const [defaultRegion, setDefaultRegion] = useState(initialAwsProfile?.region ?? "us-east-1");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [azureAccounts, setAzureAccounts] = useState<readonly AzureCliAccountSummary[]>([]);
  const [azureAuthentication, setAzureAuthentication] = useState<"login" | "cli">("login");
  const [azureLoginSession, setAzureLoginSession] = useState<{
    readonly token: string;
    readonly expiresAt: string;
    readonly subscriptions: readonly AzureCliAccountSummary[];
  } | null>(null);
  const [azureLoginTenantId, setAzureLoginTenantId] = useState("");
  const [azureLoginClientId, setAzureLoginClientId] = useState("");
  const [isAzureLoginPending, setIsAzureLoginPending] = useState(false);
  const [isCancellingAzureLogin, setIsCancellingAzureLogin] = useState(false);
  const [azureSubscriptionId, setAzureSubscriptionId] = useState("");
  const [azureTenantId, setAzureTenantId] = useState("");
  const [defaultLocation, setDefaultLocation] = useState("eastus");
  const [azureDiscoveryError, setAzureDiscoveryError] = useState<string | null>(null);
  const [isDiscoveringAzure, setIsDiscoveringAzure] = useState(false);
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [keySelection, setKeySelection] = useState<SshPrivateKeySelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isCancellingLogin, setIsCancellingLogin] = useState(false);
  const awsLoginLink = useAwsLoginLinkCopy(api);
  const loginPending = useRef(false);
  const loginCancelled = useRef(false);
  const azureDiscoverySequence = useRef(0);
  const azureLoginSequence = useRef(0);
  const azureFlowActive = useRef(false);
  const azureModeChosen = useRef(false);
  const selectedAzureAccounts = azureAuthentication === "login" ? azureLoginSession?.subscriptions ?? [] : azureAccounts;

  useEffect(() => () => {
    if (loginPending.current) void api.cancelAwsLogin().catch(() => undefined);
    azureLoginSequence.current += 1;
    if (azureFlowActive.current) void api.cancelAzureLogin().catch(() => undefined);
  }, [api]);

  useEffect(() => {
    if (awsAuthentication !== "profile") return;
    if (awsProfiles.some(({ name }) => name === awsProfileName)) return;

    const profile = preferredAwsProfile(awsProfiles);
    if (!profile) {
      setAwsAuthentication("login");
      setAwsProfileName("");
      return;
    }

    setAwsProfileName(profile.name);
    if (profile.region) setDefaultRegion(profile.region);
  }, [awsAuthentication, awsProfileName, awsProfiles]);

  useEffect(() => {
    if (provider !== "azure") return;
    const sequence = azureDiscoverySequence.current + 1;
    azureDiscoverySequence.current = sequence;
    setIsDiscoveringAzure(true);
    setAzureDiscoveryError(null);
    void api.discoverAzureAccounts().then((result) => {
      if (azureDiscoverySequence.current !== sequence) return;
      if (!result.ok || !result.value) {
        setAzureAccounts([]);
        if (!azureModeChosen.current) setAzureAuthentication("login");
        setAzureDiscoveryError(result.error ?? "Azure CLI accounts could not be discovered.");
        return;
      }
      setAzureAccounts(result.value);
      if (!azureModeChosen.current) setAzureAuthentication(result.value.length > 0 ? "cli" : "login");
    }).catch((caught: unknown) => {
      if (azureDiscoverySequence.current !== sequence) return;
      setAzureAccounts([]);
      if (!azureModeChosen.current) setAzureAuthentication("login");
      setAzureDiscoveryError(errorMessage(caught));
    }).finally(() => {
      if (azureDiscoverySequence.current === sequence) setIsDiscoveringAzure(false);
    });
    return () => {
      if (azureDiscoverySequence.current === sequence) azureDiscoverySequence.current += 1;
    };
  }, [api, provider]);

  useEffect(() => {
    const accounts = azureAuthentication === "login" ? azureLoginSession?.subscriptions ?? [] : azureAccounts;
    const account = accounts.find(({ subscriptionId }) => subscriptionId === azureSubscriptionId) ?? preferredAzureAccount(accounts);
    setAzureSubscriptionId(account?.subscriptionId ?? "");
    setAzureTenantId(account?.tenantId ?? "");
  }, [azureAccounts, azureAuthentication, azureLoginSession, azureSubscriptionId]);

  const discardAzureLogin = async (): Promise<void> => {
    const sequence = ++azureLoginSequence.current;
    setAzureLoginSession(null);
    if (!azureFlowActive.current) return;
    setIsCancellingAzureLogin(true);
    try {
      const result = await api.cancelAzureLogin();
      if (sequence !== azureLoginSequence.current) return;
      if (!result.ok) {
        setError(result.error ?? "Azure Login could not be cancelled.");
        return;
      }
      azureFlowActive.current = false;
    } catch (caught) {
      if (sequence === azureLoginSequence.current) setError(errorMessage(caught));
    } finally {
      if (sequence === azureLoginSequence.current) {
        setIsAzureLoginPending(false);
        setIsCancellingAzureLogin(false);
      }
    }
  };

  const beginAzureLogin = async (): Promise<void> => {
    if (isAzureLoginPending || isCancellingAzureLogin || isSaving) return;
    if (azureFlowActive.current) {
      await discardAzureLogin();
      if (azureFlowActive.current) return;
    }
    const sequence = ++azureLoginSequence.current;
    azureModeChosen.current = true;
    azureFlowActive.current = true;
    setAzureLoginSession(null);
    setIsAzureLoginPending(true);
    setError(null);
    try {
      const result = await api.beginAzureLogin({ tenantId: nullable(azureLoginTenantId), clientId: nullable(azureLoginClientId) });
      if (sequence !== azureLoginSequence.current) return;
      if (!result.ok || !result.value) {
        azureFlowActive.current = false;
        setError(result.error ?? "Azure Login could not be completed.");
        return;
      }
      setAzureLoginSession(result.value);
    } catch (caught) {
      if (sequence === azureLoginSequence.current) {
        azureFlowActive.current = false;
        setError(errorMessage(caught));
      }
    } finally {
      if (sequence === azureLoginSequence.current) setIsAzureLoginPending(false);
    }
  };

  const pickKey = async (): Promise<void> => {
    setIsPicking(true);
    setError(null);
    try {
      const result = await api.chooseSshPrivateKey();
      if (!result.ok || !result.value) {
        if (result.error) setError(result.error);
        return;
      }
      setKeySelection(result.value);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setIsPicking(false);
    }
  };

  const save = async (): Promise<void> => {
    if (isSaving || isAzureLoginPending || isCancellingAzureLogin) return;
    if (provider === "azure" && azureAuthentication === "login" && !azureLoginSession) {
      setError("Complete Azure Login before saving the credential.");
      return;
    }
    const validation = validateCredential({
      provider,
      label,
      sshUsername,
      defaultRegion,
      awsAuthentication,
      awsProfileName,
      awsProfiles,
      accessKeyId,
      secretAccessKey,
      azureAccounts: selectedAzureAccounts,
      azureSubscriptionId,
      azureTenantId,
      defaultLocation,
    });
    if (validation) {
      setError(validation);
      return;
    }
    const sshPrivateKeyToken = keySelection?.token ?? null;

    const input: CreateCloudCredentialInput = provider === "aws"
      ? awsAuthentication === "login"
        ? {
          provider: "aws",
          authentication: "login",
          label: label.trim(),
          defaultRegion: defaultRegion.trim(),
          sshUsername: sshUsername.trim(),
          sshPrivateKeyToken,
          sshPassphrase: nullable(sshPassphrase),
        }
        : awsAuthentication === "profile"
        ? {
          provider: "aws",
          label: label.trim(),
          defaultRegion: defaultRegion.trim(),
          sshUsername: sshUsername.trim(),
          sshPrivateKeyToken,
          profileName: awsProfileName,
          sshPassphrase: nullable(sshPassphrase),
        }
        : {
          provider: "aws",
          label: label.trim(),
          defaultRegion: defaultRegion.trim(),
          sshUsername: sshUsername.trim(),
          sshPrivateKeyToken,
          accessKeyId: accessKeyId.trim(),
          secretAccessKey,
          sessionToken: nullable(sessionToken),
          sshPassphrase: nullable(sshPassphrase),
        }
      : {
          provider: "azure",
          label: label.trim(),
          defaultLocation: defaultLocation.trim(),
          sshUsername: sshUsername.trim(),
          sshPrivateKeyToken,
          subscriptionId: azureSubscriptionId,
          tenantId: azureTenantId,
          sshPassphrase: nullable(sshPassphrase),
          ...(azureAuthentication === "login" && azureLoginSession
            ? { authentication: "login" as const, loginToken: azureLoginSession.token }
            : {}),
        };

    setIsSaving(true);
    awsLoginLink.reset();
    loginPending.current = provider === "aws" && awsAuthentication === "login";
    loginCancelled.current = false;
    setError(null);
    try {
      const result = await api.createCredential(input);
      loginPending.current = false;
      awsLoginLink.reset();
      if (input.provider === "azure" && "authentication" in input) {
        azureFlowActive.current = false;
        setAzureLoginSession(null);
      }
      if (loginCancelled.current && !result.ok) return;
      if (!result.ok || !result.value) {
        setError(result.error ?? "The credential was rejected.");
        return;
      }
      setSecretAccessKey("");
      setSessionToken("");
      setSshPassphrase("");
      setKeySelection(null);
      await onCreated(result.value.label);
    } catch (caught) {
      if (!loginCancelled.current) setError(errorMessage(caught));
    } finally {
      if (input.provider === "azure" && "authentication" in input) {
        setAzureLoginSession(null);
        if (azureFlowActive.current) void discardAzureLogin();
      }
      loginPending.current = false;
      awsLoginLink.reset();
      scrubCredentialInput(input);
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setSshPassphrase("");
      setKeySelection(null);
      setIsSaving(false);
    }
  };

  const cancelLogin = async (): Promise<void> => {
    if (!loginPending.current || isCancellingLogin) return;
    setIsCancellingLogin(true);
    loginCancelled.current = true;
    try {
      const result = await api.cancelAwsLogin();
      if (!result.ok) {
        loginCancelled.current = false;
        setError(result.error ?? "AWS Login could not be cancelled.");
      }
    } catch (caught) {
      loginCancelled.current = false;
      setError(errorMessage(caught));
    } finally {
      setIsCancellingLogin(false);
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Add Provider Credential</Card.Title>
        <Card.Description>Connect a cloud account and choose how to authenticate.</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-5">
        {error ? <InlineMessage tone="danger" title="Credential not saved" detail={error} /> : null}
        {isSaving && loginPending.current ? (
          <div role="status" className="space-y-2 text-sm text-muted">
            <p>Complete AWS Login in your browser, then return here. This window will save the credential when sign-in finishes.</p>
            <AwsLoginRecoveryDetails controller={awsLoginLink} />
          </div>
        ) : null}
        {isAzureLoginPending ? (
          <p role="status" className="text-sm text-muted">Complete Azure Login in your browser, then return here to choose a subscription.</p>
        ) : null}
        <fieldset className="space-y-5" disabled={isSaving || isAzureLoginPending || isCancellingAzureLogin}>
        <div className="grid gap-4 md:grid-cols-2">
          <CloudNativeSelect
            label="Provider"
            value={provider}
            options={[{ value: "aws", label: "AWS" }, { value: "azure", label: "Microsoft Azure" }]}
            onChange={(value) => {
              if (value === "aws" || value === "azure") {
                void discardAzureLogin();
                setProvider(value);
                setSshUsername(value === "aws" ? "ubuntu" : "azureuser");
                if (value === "aws") {
                  const profile = preferredAwsProfile(awsProfiles);
                  setAwsAuthentication(profile ? "profile" : "login");
                  setAwsProfileName(profile?.name ?? "");
                  setDefaultRegion(profile?.region ?? "us-east-1");
                } else {
                  azureModeChosen.current = false;
                  setAzureAuthentication(azureAccounts.length > 0 ? "cli" : "login");
                }
                setAccessKeyId("");
                setSecretAccessKey("");
                setSessionToken("");
                setError(null);
              }
            }}
          />
          <CloudTextField label="Label" placeholder={provider === "aws" ? "Production AWS" : "Production Azure"} value={label} onChange={setLabel} />
          <CloudTextField label="SSH Username" placeholder={provider === "aws" ? "ubuntu" : "azureuser"} value={sshUsername} onChange={setSshUsername} />
          <div className="flex min-h-16 items-end gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">SSH Private Key <span className="font-normal text-muted">(optional)</span></p>
              <p aria-live="polite" className="mt-1 text-xs leading-5 text-muted">
                {keySelection?.fileName ?? "No key selected — a new Ed25519 key will be generated automatically."}
              </p>
            </div>
            {keySelection ? (
              <Button
                aria-label="Use an automatically generated SSH key"
                size="sm"
                variant="tertiary"
                onPress={() => {
                  setKeySelection(null);
                  setSshPassphrase("");
                  setError(null);
                }}
              >
                Use Generated Key
              </Button>
            ) : null}
            <Button isPending={isPicking} size="sm" variant="outline" onPress={() => void pickKey()}>{keySelection ? "Choose Again" : "Choose Key"}</Button>
          </div>
        </div>

        {provider === "aws" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <CloudNativeSelect
              description={awsAuthentication === "profile"
                ? "Resolve credentials from the selected local AWS CLI profile at use time."
                : awsAuthentication === "login"
                  ? "Sign in with your AWS console account in your browser. No AWS CLI required."
                  : "Store access keys in Cloud Deployment's encrypted credential vault."}
              label="AWS Authentication"
              value={awsAuthentication}
              options={[
                { value: "login", label: "AWS Login" },
                ...(awsProfiles.length > 0 ? [{ value: "profile", label: "AWS CLI Profile" }] : []),
                { value: "access-keys", label: "Access Keys" },
              ]}
              onChange={(value) => {
                if (value !== "login" && value !== "profile" && value !== "access-keys") return;
                setAwsAuthentication(value);
                if (value !== "access-keys") {
                  setAccessKeyId("");
                  setSecretAccessKey("");
                  setSessionToken("");
                }
                if (value === "profile") {
                  const profile = awsProfiles.find(({ name }) => name === awsProfileName) ?? preferredAwsProfile(awsProfiles);
                  setAwsProfileName(profile?.name ?? "");
                  if (profile?.region) setDefaultRegion(profile.region);
                }
                setError(null);
              }}
            />
            {awsAuthentication === "profile" ? (
              <CloudNativeSelect
                description="Only the profile name is stored; AWS credential values remain in the shared AWS files."
                label="AWS CLI Profile"
                value={awsProfileName}
                options={awsProfiles.map((profile) => ({
                  value: profile.name,
                  label: profile.region ? `${profile.name} · ${profile.region}` : profile.name,
                }))}
                placeholder="Choose a local profile"
                onChange={(value) => {
                  setAwsProfileName(value);
                  const profile = awsProfiles.find(({ name }) => name === value);
                  if (profile?.region) setDefaultRegion(profile.region);
                  setError(null);
                }}
              />
            ) : null}
            <CloudTextField label="Default Region" placeholder="us-east-1" value={defaultRegion} onChange={setDefaultRegion} />
            {awsAuthentication === "access-keys" ? (
              <>
                <CloudTextField autoComplete="off" label="Access Key ID" placeholder="AKIA…" type="password" value={accessKeyId} onChange={setAccessKeyId} />
                <CloudTextField autoComplete="new-password" label="Secret Access Key" type="password" value={secretAccessKey} onChange={setSecretAccessKey} />
                <CloudTextField autoComplete="new-password" description="Optional for temporary STS credentials." label="Session Token" type="password" value={sessionToken} onChange={setSessionToken} />
              </>
            ) : awsAuthentication === "profile" ? (
              <p className="self-end text-sm leading-6 text-muted">
                Existing profile credentials are reused. Refresh IAM Identity Center (SSO) sessions with the AWS CLI. AWS Login uses your AWS console account; interactive MFA profile prompts are not supported.
              </p>
            ) : (
              <p className="self-end text-sm leading-6 text-muted">AWS Login opens your browser when you choose Sign In and Save. Your AWS password stays with AWS. For IAM Identity Center (SSO), use an existing AWS CLI profile.</p>
            )}
            {awsProfileDiscoveryError ? (
              <div className="md:col-span-2">
                <InlineMessage tone="warning" title="AWS profiles unavailable" detail={awsProfileDiscoveryError} />
              </div>
            ) : awsProfiles.length === 0 ? (
              <div className="md:col-span-2">
                <InlineMessage tone="info" title="No local AWS profiles found" detail="Continue with AWS Login or access keys." />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <CloudNativeSelect
              description={azureAuthentication === "login"
                ? "Sign in with Microsoft in your browser. No Azure CLI required."
                : "Use the selected account from your local Azure CLI."}
              label="Azure Authentication"
              value={azureAuthentication}
              options={[{ value: "login", label: "Azure Login" }, { value: "cli", label: "Azure CLI" }]}
              onChange={(value) => {
                if (value !== "login" && value !== "cli") return;
                azureModeChosen.current = true;
                void discardAzureLogin();
                setAzureAuthentication(value);
                setError(null);
              }}
            />
            {azureAuthentication === "login" ? (
              <>
                <CloudTextField
                  description="Optional. Leave blank to use your current directory."
                  label="Directory (Tenant) ID"
                  value={azureLoginTenantId}
                  onChange={(value) => {
                    void discardAzureLogin();
                    setAzureLoginTenantId(value);
                  }}
                />
                <CloudTextField
                  description="Optional. Use your organization's application ID if required."
                  label="Application (Client) ID"
                  value={azureLoginClientId}
                  onChange={(value) => {
                    void discardAzureLogin();
                    setAzureLoginClientId(value);
                  }}
                />
                <div className="flex flex-col items-start justify-end gap-2">
                  <p className="text-sm text-muted">
                    {azureLoginSession ? "Signed in. Choose a subscription, then save this credential." : "Sign in to discover subscriptions in your Azure directory."}
                  </p>
                  <Button variant="outline" onPress={() => void beginAzureLogin()}>
                    {azureLoginSession ? "Sign In Again" : "Sign In to Azure"}
                  </Button>
                </div>
              </>
            ) : null}
            <CloudNativeSelect
              description={azureAuthentication === "login"
                ? "Choose a subscription from your signed-in directory."
                : "Only the selected subscription and tenant IDs are stored. Access tokens remain in the local Azure CLI cache."}
              isDisabled={(azureAuthentication === "cli" && isDiscoveringAzure) || selectedAzureAccounts.length === 0}
              label={azureAuthentication === "login" ? "Azure Subscription" : "Azure CLI Subscription"}
              value={azureSubscriptionId}
              options={selectedAzureAccounts.map((account) => ({
                value: account.subscriptionId,
                label: `${account.name} · ${account.subscriptionId} · ${account.cloudName}`,
              }))}
              placeholder={azureAuthentication === "cli" && isDiscoveringAzure ? "Discovering Azure CLI accounts…" : "Choose a subscription"}
              onChange={(subscriptionId) => {
                const account = selectedAzureAccounts.find((candidate) => candidate.subscriptionId === subscriptionId);
                setAzureSubscriptionId(subscriptionId);
                setAzureTenantId(account?.tenantId ?? "");
                setError(null);
              }}
            />
            <CloudTextField
              description="Directory associated with the selected subscription."
              isReadOnly
              label="Tenant ID"
              value={azureTenantId}
              onChange={() => undefined}
            />
            <CloudTextField
              description="Azure region used for new managed resources."
              label="Default Location"
              placeholder="eastus"
              value={defaultLocation}
              onChange={setDefaultLocation}
            />
            {azureAuthentication === "cli" ? (
              <p className="self-end text-sm leading-6 text-muted">Existing Azure CLI credentials are reused. Choose Azure Login to sign in through the app.</p>
            ) : null}
            {azureAuthentication === "cli" && azureDiscoveryError ? (
              <div className="md:col-span-2">
                <InlineMessage tone="warning" title="Azure CLI accounts unavailable" detail={azureDiscoveryError} />
              </div>
            ) : azureAuthentication === "cli" && !isDiscoveringAzure && azureAccounts.length === 0 ? (
              <div className="md:col-span-2">
                <InlineMessage tone="info" title="No Azure CLI subscriptions found" detail="Choose Azure Login to sign in through the app, or run az login and reopen this form." />
              </div>
            ) : null}
          </div>
        )}

        {keySelection ? (
          <CloudTextField autoComplete="new-password" description="Optional. Used once to unlock the selected key." label="SSH Key Passphrase" type="password" value={sshPassphrase} onChange={setSshPassphrase} />
        ) : null}
        </fieldset>
      </Card.Content>
      <Card.Footer className="flex flex-wrap justify-end gap-2">
        {isAzureLoginPending || isCancellingAzureLogin ? (
          <Button isPending={isCancellingAzureLogin} variant="tertiary" onPress={() => void discardAzureLogin()}>Cancel Azure Login</Button>
        ) : isSaving && loginPending.current ? (
          <>
            <Button isPending={isCancellingLogin} variant="tertiary" onPress={() => void cancelLogin()}>Cancel AWS Login</Button>
            <Button
              isDisabled={isCancellingLogin}
              isPending={awsLoginLink.isCopying}
              variant="outline"
              onPress={() => {
                if (loginPending.current && !isCancellingLogin) void awsLoginLink.copy();
              }}
            >
              Copy Sign-in Link
            </Button>
          </>
        ) : (
          <Button isDisabled={isSaving} variant="tertiary" onPress={onCancel}>Cancel</Button>
        )}
        <Button isDisabled={isAzureLoginPending || isCancellingAzureLogin || (provider === "azure" && azureAuthentication === "login" && !azureLoginSession)} isPending={isSaving} variant="primary" onPress={() => void save()}>
          {provider === "aws" && awsAuthentication === "login" ? "Sign In and Save" : "Save Credential"}
        </Button>
      </Card.Footer>
    </Card>
  );
}

function CredentialCard({
  api,
  credential,
  onFeedback,
  onRefresh,
}: {
  readonly api: CloudDeploymentAPI;
  readonly credential: CloudCredentialSummary;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onRefresh: () => Promise<void>;
}): React.JSX.Element {
  const [pending, setPending] = useState<"test" | "delete" | "login" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<CloudCredentialTestResult | null>(null);
  const loginCredential = canLoginCloudCredential(credential) ? credential : undefined;
  const cloudLogin = useCloudLoginActionController({
    api,
    credential: loginCredential,
    isDisabled: pending !== null,
    onFeedback,
    onPendingChange: (active) => {
      setPending(active ? "login" : null);
      if (active) setTestResult(null);
    },
    onRefresh,
  });

  const test = async (): Promise<void> => {
    setPending("test");
    try {
      const result = await api.testCredential({ credentialId: credential.id });
      if (!result.ok || !result.value) {
        setTestResult(null);
        onFeedback({ tone: "danger", title: "Connection test failed", detail: result.error ?? "The provider rejected the credential." });
        return;
      }
      setTestResult(result.value);
      onFeedback(permissionTestFeedback(result.value));
    } catch (error) {
      setTestResult(null);
      onFeedback({ tone: "danger", title: "Connection test failed", detail: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  const remove = async (): Promise<void> => {
    setPending("delete");
    try {
      const result = await api.deleteCredential({ credentialId: credential.id });
      if (!result.ok) {
        onFeedback({ tone: "danger", title: "Credential not deleted", detail: result.error ?? "The credential may still be used by a deployment." });
        return;
      }
      setConfirmDelete(false);
      onFeedback({ tone: "success", title: "Credential deleted", detail: `${credential.label} was removed from Cloud Deployment.` });
      await onRefresh();
    } catch (error) {
      onFeedback({ tone: "danger", title: "Credential not deleted", detail: errorMessage(error) });
    } finally {
      setPending(null);
    }
  };

  return (
    <Card variant="secondary">
      <Card.Header className="flex-row items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-tertiary text-muted">
          <FontAwesomeIcon aria-hidden icon={providerIcon(credential.provider)} />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{credential.label}</Card.Title>
          <Card.Description>
            {credential.provider === "aws"
              ? `${awsCredentialAuthenticationLabel(credential)} · ${credential.defaultRegion}`
              : `${azureCredentialAuthenticationLabel(credential)} · ${credential.defaultLocation}`}
          </Card.Description>
        </div>
        {credential.persistence === "session" ? <Chip color="warning" size="sm" variant="soft">Session</Chip> : null}
      </Card.Header>
      <Card.Content>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <DeploymentDetail label="Provider" value={providerLabel(credential.provider)} />
          {credential.provider === "aws" ? (
            <DeploymentDetail
              label="Authentication"
              value={awsCredentialAuthenticationLabel(credential)}
            />
          ) : (
            <DeploymentDetail label="Subscription" value={credential.subscriptionId} mono />
          )}
          <DeploymentDetail label="SSH User" value={credential.sshUsername} mono />
          <DeploymentDetail label="Added" value={new Date(credential.createdAt).toLocaleDateString()} />
          <DeploymentDetail label="Credential ID" value={credential.id} mono />
        </dl>
        {testResult ? <CredentialPermissionSummary api={api} result={testResult} onHide={() => setTestResult(null)} /> : null}
        {loginCredential && (cloudLogin.isPending || cloudLogin.error) ? (
          <div className="mt-4">
            <CloudLoginAction
              controller={cloudLogin}
              credential={loginCredential}
              isDisabled={pending !== null}
              showLoginButton={false}
            />
          </div>
        ) : null}
      </Card.Content>
      <Card.Footer className="flex flex-wrap items-center gap-2">
        <ButtonGroup aria-label={`Connection actions for ${credential.label}`} size="sm" variant="outline">
          {loginCredential ? (
            <Button
              aria-label={`${credential.provider === "aws" ? "AWS Login" : "Azure Login"} for ${credential.label}`}
              isDisabled={pending !== null && !cloudLogin.isPending}
              isPending={cloudLogin.isPending}
              onPress={() => void cloudLogin.login()}
            >
              {credential.provider === "aws" ? "AWS Login" : "Azure Login"}
            </Button>
          ) : null}
          <Button aria-label={`Test connection for ${credential.label}`} isDisabled={pending !== null} isPending={pending === "test"} onPress={() => void test()}>
            {loginCredential ? <ButtonGroup.Separator /> : null}
            Test Connection
          </Button>
        </ButtonGroup>
        <Button aria-label={`Delete ${credential.label}`} className="ml-auto" isDisabled={pending !== null} size="sm" variant="danger-soft" onPress={() => setConfirmDelete(true)}>Delete</Button>
      </Card.Footer>

      <AlertDialog.Backdrop isOpen={confirmDelete} variant="blur" onOpenChange={(open) => { if (!open && pending !== "delete") setConfirmDelete(false); }}>
        <AlertDialog.Container placement="center" size="sm">
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger"><FontAwesomeIcon aria-hidden icon={faTriangleExclamation} /></AlertDialog.Icon>
              <AlertDialog.Heading>Delete {credential.label}?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm leading-6 text-muted">The encrypted or in-memory secret is removed. Credentials referenced by managed deployments cannot be deleted.</p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button isDisabled={pending === "delete"} variant="tertiary" onPress={() => setConfirmDelete(false)}>Cancel</Button>
              <Button isPending={pending === "delete"} variant="danger" onPress={() => void remove()}>Delete Credential</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Card>
  );
}

function canLoginCloudCredential(
  credential: CloudCredentialSummary | undefined,
): credential is CloudCredentialSummary {
  return credential?.provider === "azure" || (credential?.provider === "aws" && ("profileName" in credential || "loginSessionArn" in credential));
}

function awsCredentialAuthenticationLabel(credential: Extract<CloudCredentialSummary, { readonly provider: "aws" }>): string {
  if ("profileName" in credential) {
    return `${"loginSessionArn" in credential ? "AWS CLI + AWS Login" : "AWS CLI"} · ${credential.profileName}`;
  }
  return "loginSessionArn" in credential ? "AWS Login" : "Access keys";
}

function azureCredentialAuthenticationLabel(credential: Extract<CloudCredentialSummary, { readonly provider: "azure" }>): string {
  if ("authentication" in credential && credential.authentication === "login") return "Azure Login";
  return "loginAccountId" in credential ? "Azure CLI + Azure Login" : "Azure CLI";
}

interface AwsLoginLinkCopyController {
  readonly isCopying: boolean;
  readonly isCopied: boolean;
  readonly error: string | null;
  readonly copy: () => Promise<void>;
  readonly reset: () => void;
}

function useAwsLoginLinkCopy(api: CloudDeploymentAPI): AwsLoginLinkCopyController {
  const [isCopying, setIsCopying] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const copying = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      copying.current = false;
      sequence.current += 1;
    };
  }, [api]);

  const reset = useCallback((): void => {
    sequence.current += 1;
    copying.current = false;
    if (mounted.current) {
      setIsCopying(false);
      setIsCopied(false);
      setError(null);
    }
  }, []);

  const copy = async (): Promise<void> => {
    if (copying.current || !mounted.current) return;
    const currentSequence = sequence.current + 1;
    sequence.current = currentSequence;
    copying.current = true;
    setIsCopying(true);
    setIsCopied(false);
    setError(null);
    try {
      const result = await api.copyAwsLoginLink();
      if (!mounted.current || sequence.current !== currentSequence) return;
      if (result.ok) setIsCopied(true);
      else setError(result.error ?? "The AWS sign-in link could not be copied.");
    } catch (caught) {
      if (mounted.current && sequence.current === currentSequence) setError(errorMessage(caught));
    } finally {
      if (mounted.current && sequence.current === currentSequence) {
        copying.current = false;
        setIsCopying(false);
      }
    }
  };

  return { copy, error, isCopied, isCopying, reset };
}

function AwsLoginRecoveryDetails({ controller }: { readonly controller: AwsLoginLinkCopyController }): React.JSX.Element {
  return (
    <>
      <p>If AWS shows 400 Bad Request, copy the sign-in link and open it in a private browser window on this computer.</p>
      {controller.isCopied ? <p>Sign-in link copied.</p> : null}
      {controller.error ? <p className="text-danger">{controller.error}</p> : null}
    </>
  );
}

interface CloudLoginActionController {
  readonly awsLoginLink: AwsLoginLinkCopyController;
  readonly error: string | null;
  readonly isCancelling: boolean;
  readonly isPending: boolean;
  readonly cancel: () => Promise<void>;
  readonly copyAwsLoginLink: () => Promise<void>;
  readonly login: () => Promise<void>;
}

function useCloudLoginActionController({
  api,
  credential,
  isDisabled,
  onFeedback,
  onPendingChange,
  onRefresh,
}: {
  readonly api: CloudDeploymentAPI;
  readonly credential?: CloudCredentialSummary | undefined;
  readonly isDisabled: boolean;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onRefresh: () => Promise<void>;
}): CloudLoginActionController {
  const [isPending, setIsPending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const awsLoginLink = useAwsLoginLinkCopy(api);
  const active = useRef(false);
  const cancelling = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);
  const attempt = useRef(0);
  const onPendingChangeRef = useRef(onPendingChange);
  onPendingChangeRef.current = onPendingChange;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current += 1;
      const wasActive = active.current;
      active.current = false;
      cancelling.current = false;
      awsLoginLink.reset();
      if (wasActive && credential) {
        void (credential.provider === "aws" ? api.cancelAwsLogin() : api.cancelAzureLogin()).catch(() => undefined);
        onPendingChangeRef.current(false);
      }
    };
  }, [api, awsLoginLink.reset, credential?.id, credential?.provider]);

  const login = async (): Promise<void> => {
    if (!credential || active.current || cancelling.current || isDisabled) return;
    const currentAttempt = attempt.current + 1;
    attempt.current = currentAttempt;
    active.current = true;
    cancelled.current = false;
    awsLoginLink.reset();
    setIsPending(true);
    setError(null);
    onPendingChange(true);
    const loginName = credential.provider === "aws" ? "AWS Login" : "Azure Login";
    try {
      const result = await (credential.provider === "aws"
        ? api.loginAwsCredential({ credentialId: credential.id })
        : api.loginAzureCredential({ credentialId: credential.id }));
      if (!mounted.current || attempt.current !== currentAttempt) return;
      active.current = false;
      awsLoginLink.reset();
      if (!result.ok || !result.value) {
        if (!cancelled.current) setError(result.error ?? `${loginName} could not be completed.`);
        return;
      }
      onFeedback({ tone: "success", title: `${loginName} complete`, detail: `${credential.label} is signed in.` });
      await onRefresh();
    } catch (caught) {
      if (mounted.current && attempt.current === currentAttempt && !cancelled.current) setError(errorMessage(caught));
    } finally {
      if (attempt.current === currentAttempt) {
        active.current = false;
        cancelling.current = false;
        awsLoginLink.reset();
        if (mounted.current) {
          setIsPending(false);
          setIsCancelling(false);
          onPendingChange(false);
        }
      }
    }
  };

  const cancel = async (): Promise<void> => {
    if (!credential || !active.current || cancelling.current) return;
    const currentAttempt = attempt.current;
    cancelling.current = true;
    cancelled.current = true;
    setIsCancelling(true);
    const loginName = credential.provider === "aws" ? "AWS Login" : "Azure Login";
    try {
      const result = await (credential.provider === "aws" ? api.cancelAwsLogin() : api.cancelAzureLogin());
      if (!result.ok && mounted.current && attempt.current === currentAttempt) {
        cancelled.current = false;
        setError(result.error ?? `${loginName} could not be cancelled.`);
      }
    } catch (caught) {
      cancelled.current = false;
      if (mounted.current && attempt.current === currentAttempt) setError(errorMessage(caught));
    } finally {
      if (mounted.current && attempt.current === currentAttempt) setIsCancelling(false);
      cancelling.current = false;
    }
  };

  const copyAwsLoginLink = async (): Promise<void> => {
    if (credential?.provider !== "aws" || !active.current || cancelling.current) return;
    await awsLoginLink.copy();
  };

  return { awsLoginLink, cancel, copyAwsLoginLink, error, isCancelling, isPending, login };
}

function CloudLoginAction({
  controller,
  credential,
  isDisabled,
  isEmbedded = false,
  showDetails = true,
  showLoginButton = true,
}: {
  readonly controller: CloudLoginActionController;
  readonly credential: CloudCredentialSummary;
  readonly isDisabled: boolean;
  readonly isEmbedded?: boolean;
  readonly showDetails?: boolean;
  readonly showLoginButton?: boolean;
}): React.JSX.Element {
  const loginName = credential.provider === "aws" ? "AWS Login" : "Azure Login";

  return (
    <div className="space-y-3">
      {showDetails && controller.error ? isEmbedded ? (
        <p className="text-sm leading-5 opacity-80">
          <span className="font-semibold">{loginName} failed.</span> {controller.error}
        </p>
      ) : <InlineMessage tone="danger" title={`${loginName} failed`} detail={controller.error} /> : null}
      {showDetails && controller.isPending ? credential.provider === "aws" ? (
        <div {...(isEmbedded ? {} : { role: "status" })} className="space-y-2 text-sm text-muted">
          <p>Complete {loginName} in your browser, then return here.</p>
          <AwsLoginRecoveryDetails controller={controller.awsLoginLink} />
        </div>
      ) : (
        <p {...(isEmbedded ? {} : { role: "status" })} className="text-sm text-muted">
          Complete {loginName} in your browser, then return here.
        </p>
      ) : null}
      {showLoginButton || (showDetails && controller.isPending) ? <div className="flex flex-wrap gap-2">
        {showLoginButton ? <Button
          aria-label={`${loginName} for ${credential.label}${isEmbedded ? " from error message" : ""}`}
          isDisabled={(isDisabled && !controller.isPending) || (controller.isPending && !showDetails)}
          isPending={controller.isPending && showDetails}
          size="sm"
          variant="outline"
          onPress={() => void controller.login()}
        >
          {loginName}
        </Button> : null}
        {showDetails && controller.isPending ? (
          <>
            <Button isPending={controller.isCancelling} size="sm" variant="tertiary" onPress={() => void controller.cancel()}>
              Cancel {loginName}
            </Button>
            {credential.provider === "aws" ? (
              <Button isDisabled={controller.isCancelling} isPending={controller.awsLoginLink.isCopying} size="sm" variant="outline" onPress={() => void controller.copyAwsLoginLink()}>
                Copy Sign-in Link
              </Button>
            ) : null}
          </>
        ) : null}
      </div> : null}
    </div>
  );
}

function CredentialPermissionSummary({
  api,
  result,
  onHide,
}: {
  readonly api: CloudDeploymentAPI;
  readonly result: CloudCredentialTestResult;
  readonly onHide: () => void;
}): React.JSX.Element {
  const [isCopying, setIsCopying] = useState(false);
  const { missing, required, unverifiable, verified } = result.permissions;
  const issueIds = [...missing, ...unverifiable];
  const labels = new Map(required.map(({ id, label }) => [id, label]));
  const missingIds = new Set(missing);
  const unverifiableIds = new Set(unverifiable);
  const verifiedIds = new Set(verified);
  const tone = missing.length > 0 ? "danger" : unverifiable.length > 0 ? "info" : "success";

  const copyTerraform = async (): Promise<void> => {
    if (isCopying) return;
    setIsCopying(true);
    try {
      const copied = await api.copyAwsPermissionsTerraform();
      if (!copied.ok) {
        toast.danger("Could not copy Terraform", { description: copied.error ?? "The clipboard could not be updated." });
        return;
      }
      toast.success("Terraform copied to clipboard");
    } catch (error) {
      toast.danger("Could not copy Terraform", { description: errorMessage(error) });
    } finally {
      setIsCopying(false);
    }
  };

  return (
    <div className={`mt-4 rounded-2xl px-4 py-3 ${feedbackToneClass(tone)}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {missing.length > 0 ? "Permissions missing" : unverifiable.length > 0 ? "Some permissions remain unverified" : "Permissions verified"}
        </p>
        <span className="text-xs tabular-nums opacity-80">
          {verified.length} verified · {missing.length} missing · {unverifiable.length} unverified
        </span>
      </div>
      {issueIds.length === 0 ? (
        <p className="mt-1 text-xs opacity-80">All required provider capabilities were confirmed.</p>
      ) : unverifiable.length > 0 ? (
        <p className="mt-1 text-xs opacity-80">Unverified permissions need additional context or resource-specific checks.</p>
      ) : null}
      <details className="mt-2 text-xs">
        <summary className="cursor-[var(--cursor-interactive)] font-medium">
          {issueIds.length > 0 ? "Review permission IDs" : `View all ${required.length} required permissions`}
        </summary>
        {result.provider === "aws" ? (
          <p className="mt-2 opacity-80">AWS evaluates administrator and wildcard grants, including * and ec2:*, automatically. Explicit denials still apply.</p>
        ) : null}
        <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto pl-4">
          {required.map(({ id }) => {
            const status = missingIds.has(id)
              ? "missing"
              : unverifiableIds.has(id)
                ? "could not verify safely"
                : verifiedIds.has(id)
                  ? "verified"
                  : "not reported";
            return (
              <li key={id}>
                <span className="font-mono">{id}</span>{labels.get(id) ? ` — ${labels.get(id)}` : ""} · {status}
              </li>
            );
          })}
        </ul>
      </details>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {result.provider === "aws" ? (
          <Button isPending={isCopying} size="sm" variant="outline" onPress={() => void copyTerraform()}>Copy as Terraform</Button>
        ) : null}
        <Button className="ml-auto" size="sm" variant="ghost" onPress={onHide}>Hide</Button>
      </div>
    </div>
  );
}

function CloudTextField({
  label,
  value,
  onChange,
  description,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  isDisabled = false,
  isReadOnly = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: string | undefined;
  readonly type?: "text" | "password" | undefined;
  readonly placeholder?: string | undefined;
  readonly autoComplete?: string | undefined;
  readonly inputMode?: "numeric" | undefined;
  readonly isDisabled?: boolean | undefined;
  readonly isReadOnly?: boolean | undefined;
}): React.JSX.Element {
  return (
    <TextField fullWidth isDisabled={isDisabled} isReadOnly={isReadOnly} value={value} variant="secondary" onChange={onChange}>
      <Label>{label}</Label>
      <Input
        {...(autoComplete ? { autoComplete } : {})}
        {...(inputMode ? { inputMode } : {})}
        {...(placeholder ? { placeholder } : {})}
        spellCheck={false}
        type={type}
      />
      {description ? <Description>{description}</Description> : null}
      <FieldError />
    </TextField>
  );
}

function CloudTextArea({
  label,
  value,
  onChange,
  description,
  placeholder,
  isDisabled = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly isDisabled?: boolean | undefined;
}): React.JSX.Element {
  return (
    <TextField fullWidth isDisabled={isDisabled} value={value} variant="secondary" onChange={onChange}>
      <Label>{label}</Label>
      <TextArea {...(placeholder ? { placeholder } : {})} className="min-h-24 font-mono text-xs" spellCheck={false} />
      {description ? <Description>{description}</Description> : null}
      <FieldError />
    </TextField>
  );
}

function CloudNativeSelect({
  label,
  value,
  options,
  onChange,
  description,
  isDisabled = false,
  placeholder,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  readonly onChange: (value: string) => void;
  readonly description?: string | undefined;
  readonly isDisabled?: boolean | undefined;
  readonly placeholder?: string | undefined;
}): React.JSX.Element {
  return (
    <NativeSelect fullWidth variant="secondary">
      <Label>{label}</Label>
      <NativeSelect.Trigger aria-label={label} disabled={isDisabled} value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {placeholder ? <NativeSelect.Option value="">{placeholder}</NativeSelect.Option> : null}
        {options.map((option) => <NativeSelect.Option key={option.value} value={option.value}>{option.label}</NativeSelect.Option>)}
        <NativeSelect.Indicator />
      </NativeSelect.Trigger>
      {description ? <Description>{description}</Description> : null}
    </NativeSelect>
  );
}

function CloudRichSelect<Value extends string | number>({
  label,
  value,
  options,
  onChange,
  description,
  isDisabled = false,
  placeholder,
  selectedDescription,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: readonly {
    readonly value: Value;
    readonly label: string;
    readonly description: string;
    readonly isDisabled?: boolean | undefined;
  }[];
  readonly onChange: (value: Value) => void;
  readonly description?: string | undefined;
  readonly isDisabled?: boolean | undefined;
  readonly placeholder?: string | undefined;
  readonly selectedDescription?: string | undefined;
}): React.JSX.Element {
  const selected = options.find((option) => option.value === value);
  return (
    <Select
      disabledKeys={options.filter(({ isDisabled }) => isDisabled).map(({ value: optionValue }) => optionValue)}
      fullWidth
      isDisabled={isDisabled}
      value={value === "" ? null : value}
      variant="secondary"
      {...(placeholder ? { placeholder } : {})}
      onChange={(nextValue) => {
        if (typeof nextValue === "string" || typeof nextValue === "number") onChange(nextValue as Value);
      }}
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value>
          {selected ? (
            <span className="flex min-w-0 flex-col items-start py-0.5 text-left">
              <span className="w-full truncate text-sm">{selected.label}</span>
              {selectedDescription ? <span className="w-full truncate text-xs text-muted">{selectedDescription}</span> : null}
            </span>
          ) : null}
        </Select.Value>
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {options.map((option) => (
            <ListBox.Item id={option.value} key={option.value} textValue={option.label}>
              <span className="flex min-w-0 flex-1 flex-col items-start">
                <span className="text-sm font-medium">{option.label}</span>
                <span className="text-xs leading-5 text-muted">{option.description}</span>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
      {description ? <Description>{description}</Description> : null}
    </Select>
  );
}

async function copyCloudIpAddress(api: CloudDeploymentAPI, deploymentId: string, kind: "public" | "private"): Promise<void> {
  const label = kind === "public" ? "Public IP" : "Private IP";
  try {
    const result = await api.copyIpAddress({ deploymentId, kind });
    if (!result.ok) throw new Error(result.error ?? `The ${label.toLowerCase()} could not be copied.`);
    toast.success(`${label} copied`);
  } catch (error) {
    toast.danger(`Could not copy ${label.toLowerCase()}`, { description: errorMessage(error) });
  }
}

function DeploymentDetail({ label, value, mono = false, onCopy }: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly onCopy?: (() => void) | undefined;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 ${onCopy ? "flex items-center gap-1" : "truncate"} ${mono ? "font-mono text-xs" : "font-medium"}`} title={value}>
        {onCopy ? (
          <>
            <span className="min-w-0 truncate">{value}</span>
            <Tooltip delay={0}>
              <Button
                aria-label={`Copy ${label}`}
                className="size-6 min-w-0 shrink-0 p-0"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={onCopy}
              >
                <FontAwesomeIcon aria-hidden className="size-3" icon={faCopy} />
              </Button>
              <Tooltip.Content>Copy {label}</Tooltip.Content>
            </Tooltip>
          </>
        ) : value}
      </dd>
    </div>
  );
}

function AwsStatusChecks({ deployment }: { readonly deployment: AwsCloudDeploymentRecord }): React.JSX.Element {
  const checksPassed = Number(deployment.runtime.instanceHealth === "ok") +
    Number(deployment.runtime.systemHealth === "ok");
  const deploymentFailed = deployment.status === "failed";
  return (
    <section aria-label="AWS instance status checks" className="rounded-2xl bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">AWS Status Checks</h3>
          <p className="mt-1 text-xs leading-5 text-muted">SSH starts only after the instance is running and both EC2 reachability checks pass.</p>
        </div>
        <Chip color={checksPassed === 2 ? "success" : "warning"} size="sm" variant="soft">
          {checksPassed}/2 checks passed
        </Chip>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <AwsStatusCheck
          isFailed={deploymentFailed && deployment.runtime.instanceState !== "running"}
          isPassed={deployment.runtime.instanceState === "running"}
          label="Instance state"
          value={awsStatusValue(deployment.runtime.instanceState, deploymentFailed)}
        />
        <AwsStatusCheck
          isFailed={deployment.runtime.systemHealth === "impaired" || (deploymentFailed && deployment.runtime.systemHealth !== "ok")}
          isPassed={deployment.runtime.systemHealth === "ok"}
          label="System reachability"
          value={awsStatusValue(deployment.runtime.systemHealth, deploymentFailed)}
        />
        <AwsStatusCheck
          isFailed={deployment.runtime.instanceHealth === "impaired" || (deploymentFailed && deployment.runtime.instanceHealth !== "ok")}
          isPassed={deployment.runtime.instanceHealth === "ok"}
          label="Instance reachability"
          value={awsStatusValue(deployment.runtime.instanceHealth, deploymentFailed)}
        />
      </div>
    </section>
  );
}

function awsStatusValue(value: string, deploymentFailed: boolean): string {
  if (deploymentFailed && value !== "ok" && value !== "running") return `${titleCase(value)} · did not pass`;
  return titleCase(value);
}

function AwsStatusCheck({
  isFailed = false,
  isPassed,
  label,
  value,
}: {
  readonly isFailed?: boolean;
  readonly isPassed: boolean;
  readonly label: string;
  readonly value: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface-secondary px-3 py-3">
      <span
        aria-hidden
        className={`grid size-6 shrink-0 place-items-center rounded-full text-xs ${
          isPassed
            ? "bg-success-soft text-success-soft-foreground"
            : isFailed
              ? "bg-danger-soft text-danger-soft-foreground"
              : "bg-warning-soft text-warning-soft-foreground"
        }`}
      >
        {isPassed ? <FontAwesomeIcon icon={faCheck} /> : "•"}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-foreground">{label}</p>
        <p className="truncate text-xs text-muted">{value}</p>
      </div>
    </div>
  );
}

function ReviewGroup({ title, rows }: { readonly title: string; readonly rows: readonly (readonly [string, string])[] }): React.JSX.Element {
  return (
    <div className="rounded-2xl bg-surface-secondary p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <dl className="mt-3 space-y-2">
        {rows.map(([label, value]) => (
          <div className="flex items-start justify-between gap-4 text-sm" key={label}>
            <dt className="text-muted">{label}</dt>
            <dd className="max-w-[65%] break-words text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function FeedbackBanner({ feedback, onDismiss }: { readonly feedback: Feedback; readonly onDismiss: () => void }): React.JSX.Element {
  return (
    <Alert status="danger" role="alert">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{feedback.title}</Alert.Title>
        <Alert.Description>{feedback.detail}</Alert.Description>
      </Alert.Content>
      <Button size="sm" variant="ghost" onPress={onDismiss}>Dismiss</Button>
    </Alert>
  );
}

function LifecycleProgressModal({
  action,
  deploymentName,
}: {
  readonly action: string | null;
  readonly deploymentName: string;
}): React.JSX.Element {
  const progressAction = action === "start" || action === "stop" || action === "destroy" ? action : null;
  const verb = progressAction === "start" ? "Starting" : progressAction === "stop" ? "Stopping" : "Terminating";
  const color = progressAction === "stop" ? "warning" : progressAction === "destroy" ? "danger" : "accent";
  return (
    <Modal.Backdrop
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={progressAction !== null}
      variant="blur"
    >
      <Modal.Container placement="center" size="sm">
        <Modal.Dialog className="sm:max-w-[380px]">
          <Modal.Header>
            <Modal.Icon className={progressAction === "stop"
              ? "bg-warning-soft text-warning-soft-foreground"
              : progressAction === "destroy"
                ? "bg-danger-soft text-danger-soft-foreground"
                : "bg-accent-soft text-accent-soft-foreground"}
            >
              <Spinner color={color} size="sm" />
            </Modal.Icon>
            <Modal.Heading>{verb} {deploymentName}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <p className="text-sm leading-6 text-muted">
              The provider request is in progress. Deployment state will refresh when it completes.
            </p>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function permissionTestFeedback(result: CloudCredentialTestResult): Feedback {
  const { missing, unverifiable } = result.permissions;
  if (missing.length > 0) {
    return {
      tone: "danger",
      title: "Required permissions missing",
      detail: `${missing.length} missing: ${summarizePermissionIds(missing)}${unverifiable.length > 0 ? ` · ${unverifiable.length} unverified: ${summarizePermissionIds(unverifiable)}` : ""}`,
    };
  }
  if (unverifiable.length > 0) {
    return {
      tone: "success",
      title: "Connection verified",
      detail: `${unverifiable.length} permission${unverifiable.length === 1 ? "" : "s"} could not be verified safely: ${summarizePermissionIds(unverifiable)}. See the permission details for checks that need additional context or specific resources.`,
    };
  }
  return { tone: "success", title: "Connection verified", detail: result.summary };
}

function summarizePermissionIds(ids: readonly string[]): string {
  const visible = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${visible}, +${ids.length - 3} more` : visible;
}

function InlineMessage({
  action,
  tone,
  title,
  detail,
}: Feedback & { readonly action?: React.ReactNode }): React.JSX.Element {
  return (
    <div className={`rounded-2xl px-4 py-3 ${feedbackToneClass(tone)}`} role={tone === "danger" ? "alert" : "status"}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-5 opacity-80">{detail}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}

function LoadingSurface(): React.JSX.Element {
  return (
    <Card variant="secondary">
      <Card.Content className="flex min-h-64 flex-col items-center justify-center gap-3">
        <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className="size-5 animate-spin text-accent" />
        <p className="text-sm text-muted">Loading cloud deployments…</p>
      </Card.Content>
    </Card>
  );
}

function LoadError({ message, onRetry }: { readonly message: string; readonly onRetry: () => void }): React.JSX.Element {
  return (
    <Card variant="secondary">
      <Card.Content className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
        <FontAwesomeIcon aria-hidden icon={faTriangleExclamation} className="size-6 text-danger" />
        <div><h2 className="font-semibold">Cloud Deployment is unavailable</h2><p className="mt-1 max-w-lg text-sm text-muted">{message}</p></div>
        <Button variant="outline" onPress={onRetry}>Try Again</Button>
      </Card.Content>
    </Card>
  );
}

function supportedInstanceTypes(options: AwsDeploymentOptions): AwsDeploymentOptions["instanceTypes"] {
  const supported = new Set<string>(AWS_SUPPORTED_INSTANCE_TYPES);
  return [...options.instanceTypes]
    .filter(({ name }) => supported.has(name))
    .sort((left, right) => (
      AWS_SUPPORTED_INSTANCE_TYPES.indexOf(left.name as (typeof AWS_SUPPORTED_INSTANCE_TYPES)[number]) -
      AWS_SUPPORTED_INSTANCE_TYPES.indexOf(right.name as (typeof AWS_SUPPORTED_INSTANCE_TYPES)[number])
    ));
}

function compatibleImages(
  images: AwsDeploymentOptions["images"],
  architecture: "x86_64" | "arm64" | undefined,
): AwsDeploymentOptions["images"] {
  if (!architecture) return [];
  return images.filter((image) => (
    (image.distribution === "ubuntu" || image.distribution === "amazon-linux") &&
    image.architecture === architecture
  ));
}

function preferredImage(images: AwsDeploymentOptions["images"]): AwsDeploymentOptions["images"][number] | undefined {
  return images.find(({ distribution }) => distribution === "ubuntu") ?? images[0];
}

function preferredSubnet(subnets: AwsDeploymentOptions["subnets"]): AwsDeploymentOptions["subnets"][number] | undefined {
  return subnets.find(({ mapPublicIpOnLaunch }) => mapPublicIpOnLaunch) ?? subnets[0];
}

function reconcileAwsDraft(draft: AwsDeploymentDraft, options: AwsDeploymentOptions): AwsDeploymentDraft {
  const instanceTypes = supportedInstanceTypes(options);
  const instanceType = instanceTypes.some(({ name }) => name === draft.instanceType)
    ? draft.instanceType
    : instanceTypes.find(({ name }) => name === "t3.micro")?.name ?? instanceTypes[0]?.name ?? "";
  const architecture = instanceTypes.find(({ name }) => name === instanceType)?.architecture;
  const images = compatibleImages(options.images, architecture);
  const retainedImage = images.find(({ id }) => id === draft.imageId);
  const selectedImage = retainedImage ?? preferredImage(images);
  const imageId = selectedImage?.id ?? "";
  const vpcId = options.vpcs.some(({ id }) => id === draft.vpcId)
    ? draft.vpcId
    : options.vpcs.find(({ isDefault }) => isDefault)?.id ?? options.vpcs[0]?.id ?? "";
  const subnets = options.subnets.filter((subnet) => subnet.vpcId === vpcId);
  const subnetId = subnets.some(({ id }) => id === draft.subnetId)
    ? draft.subnetId
    : preferredSubnet(subnets)?.id ?? "";
  const existingKeyPairName = options.keyPairs.some((keyPair) => (
    keyPair.name === draft.existingKeyPairName && keyPair.isCredentialMatch
  )) ? draft.existingKeyPairName : "";
  return {
    ...draft,
    instanceType,
    imageId,
    ...(retainedImage ? {} : { sshUsername: selectedImage?.sshUsername ?? draft.sshUsername }),
    ...(draft.networkMode === "existing" ? { vpcId, subnetId } : {}),
    sshKeyMode: draft.sshKeyMode === "existing" && existingKeyPairName ? "existing" : "managed",
    existingKeyPairName,
  };
}

function reconcileAzureDraft(draft: AzureDeploymentDraft, options: AzureDeploymentOptions): AzureDeploymentDraft {
  const vmSize = options.vmSizes.some(({ name }) => name === draft.vmSize)
    ? draft.vmSize
    : options.vmSizes.find(({ name }) => name === INITIAL_AZURE_DEPLOYMENT.vmSize)?.name ??
      options.vmSizes[0]?.name ?? draft.vmSize;
  const retainedImage = options.images.find(({ reference }) => reference === draft.imageReference);
  const selectedImage = retainedImage ?? (!validAzureImageReference(draft.imageReference)
    ? options.images.find(({ reference }) => reference === INITIAL_AZURE_DEPLOYMENT.imageReference) ?? options.images[0]
    : undefined);
  if (draft.networkMode !== "existing") {
    return {
      ...draft,
      vmSize,
      ...(selectedImage
        ? { imageReference: selectedImage.reference, sshUsername: selectedImage.sshUsername }
        : {}),
    };
  }
  const vnetId = options.virtualNetworks.some(({ id }) => id === draft.vnetId)
    ? draft.vnetId
    : options.virtualNetworks[0]?.id ?? "";
  const subnets = options.subnets.filter(({ vnetId: candidateVnetId }) => candidateVnetId === vnetId);
  const subnetId = subnets.some(({ id }) => id === draft.subnetId)
    ? draft.subnetId
    : subnets[0]?.id ?? "";
  return {
    ...draft,
    vmSize,
    vnetId,
    subnetId,
    ...(selectedImage
      ? { imageReference: selectedImage.reference, sshUsername: selectedImage.sshUsername }
      : {}),
  };
}

function architectureLabel(architecture: "x86_64" | "arm64"): string {
  return architecture === "arm64" ? "Arm64" : "x86-64";
}

function formatMemory(memoryMiB: number): string {
  return memoryMiB % 1024 === 0 ? `${memoryMiB / 1024} GiB` : `${memoryMiB.toLocaleString()} MiB`;
}

function imageLabel(image: AwsDeploymentOptions["images"][number]): string {
  const distribution = image.distribution === "amazon-linux" ? "Amazon Linux" : "Ubuntu";
  return image.version ? `${distribution} ${image.version}` : distribution;
}

function imageDescription(image: AwsDeploymentOptions["images"][number]): string {
  return [
    image.id,
    image.architecture === "arm64" ? "Arm64" : image.architecture === "x86_64" ? "x86-64" : null,
    image.sshUsername ? `SSH user ${image.sshUsername}` : null,
  ].filter(Boolean).join(" · ");
}

function shortFingerprint(fingerprint: string | null | undefined): string | undefined {
  if (!fingerprint) return undefined;
  return fingerprint.length > 28 ? `${fingerprint.slice(0, 25)}…` : fingerprint;
}

function selectedAwsImageId(draft: AwsDeploymentDraft): string {
  return (draft.imageMode === "manual" ? draft.manualImageId : draft.imageId).trim();
}

function deploymentInput(input: {
  readonly provider: CloudProvider;
  readonly credentialId: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly operatorName: string;
  readonly region: string;
  readonly location: string;
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
  readonly useElasticIp: boolean;
  readonly usePublicIp: boolean;
  readonly aws: AwsDeploymentDraft;
  readonly azure: AzureDeploymentDraft;
}): CreateCloudDeploymentInput {
  if (input.provider === "aws") {
    return {
      provider: "aws",
      expectedRevision: input.expectedRevision,
      credentialId: input.credentialId,
      name: input.name,
      spec: {
        region: input.region,
        imageId: selectedAwsImageId(input.aws),
        instanceType: input.aws.instanceType.trim(),
        subnetId: input.aws.networkMode === "existing" ? nullable(input.aws.subnetId) : null,
        vpcId: input.aws.networkMode === "existing" ? nullable(input.aws.vpcId) : null,
        // Retained in the v1 state schema for compatibility. AWS deployments
        // default to importing an isolated, GUID-tagged credential key.
        keyPairName: input.aws.sshKeyMode === "existing"
          ? input.aws.existingKeyPairName
          : "managed-by-sliver-gui",
        networkMode: input.aws.networkMode,
        managedVpcCidr: input.aws.networkMode === "managed" ? input.aws.managedVpcCidr.trim() : null,
        managedSubnetCidr: input.aws.networkMode === "managed" ? input.aws.managedSubnetCidr.trim() : null,
        sshKeyMode: input.aws.sshKeyMode,
        existingKeyPairName: input.aws.sshKeyMode === "existing" ? input.aws.existingKeyPairName : null,
        sshUsername: input.aws.sshUsername.trim(),
        operatorName: input.operatorName,
        sshPort: input.sshPort,
        multiplayerPort: input.multiplayerPort,
        volumeSizeGiB: nullableInteger(input.aws.volumeSizeGiB),
        useElasticIp: input.useElasticIp,
        sshCidrs: input.sshCidrs,
        operatorCidrs: input.operatorCidrs,
      },
    };
  }
  return {
    provider: "azure",
    expectedRevision: input.expectedRevision,
    credentialId: input.credentialId,
    name: input.name,
    spec: {
      location: input.location,
      imageReference: input.azure.imageReference.trim(),
      vmSize: input.azure.vmSize.trim(),
      networkMode: input.azure.networkMode,
      vnetId: input.azure.networkMode === "existing" ? nullable(input.azure.vnetId) : null,
      subnetId: input.azure.networkMode === "existing" ? nullable(input.azure.subnetId) : null,
      managedVnetCidr: input.azure.networkMode === "managed" ? input.azure.managedVnetCidr.trim() : null,
      managedSubnetCidr: input.azure.networkMode === "managed" ? input.azure.managedSubnetCidr.trim() : null,
      sshUsername: input.azure.sshUsername.trim(),
      operatorName: input.operatorName,
      sshPort: AZURE_SSH_PORT,
      multiplayerPort: input.multiplayerPort,
      osDiskSizeGiB: nullableInteger(input.azure.osDiskSizeGiB),
      usePublicIp: input.usePublicIp,
      sshCidrs: input.sshCidrs,
      operatorCidrs: input.operatorCidrs,
    },
  };
}

function validateDeploymentStep(
  step: number,
  values: {
    readonly provider: CloudProvider;
    readonly credentialId: string;
    readonly name: string;
    readonly operatorName: string;
    readonly sshPort: string;
    readonly multiplayerPort: string;
    readonly sshCidrs: string;
    readonly operatorCidrs: string;
    readonly aws: AwsDeploymentDraft;
    readonly awsOptions: AwsDeploymentOptions | null;
    readonly azure: AzureDeploymentDraft;
    readonly azureOptions: AzureDeploymentOptions | null;
    readonly location: string;
  },
): string | null {
  if (step === 0) {
    if (!values.credentialId) return `Choose a ${providerLabel(values.provider)} credential.`;
    if (!values.name.trim()) return "Enter a deployment name.";
    if (!/^[a-zA-Z0-9._-]{1,128}$/u.test(values.operatorName.trim())) return "Enter an operator name using letters, numbers, dot, dash, or underscore.";
  }
  if (step === 1 && values.provider === "aws") {
    if (!values.awsOptions) return "Load AWS infrastructure options before continuing.";
    const instances = supportedInstanceTypes(values.awsOptions);
    const selectedInstance = instances.find(({ name }) => name === values.aws.instanceType);
    if (!selectedInstance) return "Choose a supported EC2 instance type.";
    const imageId = selectedAwsImageId(values.aws);
    if (!/^ami-[0-9a-f]+$/u.test(imageId)) return "Choose a machine image or enter a valid AMI ID.";
    if (values.aws.imageMode === "catalog" && !compatibleImages(values.awsOptions.images, selectedInstance.architecture).some(({ id }) => id === imageId)) {
      return "Choose an Ubuntu or Amazon Linux image compatible with the instance architecture.";
    }
    if (values.aws.networkMode === "existing") {
      if (!values.awsOptions.vpcs.some(({ id }) => id === values.aws.vpcId)) return "Choose an existing VPC or create a new one.";
      if (!values.awsOptions.subnets.some(({ id, vpcId }) => id === values.aws.subnetId && vpcId === values.aws.vpcId)) {
        return "Choose a subnet in the selected VPC.";
      }
    } else {
      const vpcCidr = parseManagedIpv4Cidr(values.aws.managedVpcCidr);
      const subnetCidr = parseManagedIpv4Cidr(values.aws.managedSubnetCidr);
      if (!vpcCidr || !subnetCidr) {
        return "Enter canonical IPv4 network CIDRs between /16 and /28 for the managed VPC and subnet.";
      }
      if (!managedIpv4CidrContains(vpcCidr, subnetCidr)) {
        return "The managed subnet CIDR must be contained by the managed VPC CIDR.";
      }
    }
    if (values.aws.sshKeyMode === "existing" && !values.awsOptions.keyPairs.some(({ name, isCredentialMatch }) => (
      name === values.aws.existingKeyPairName && isCredentialMatch
    ))) return "Choose an AWS key pair that matches the credential's private key.";
    if (!/^[a-z_][a-z0-9_-]{0,31}$/u.test(values.aws.sshUsername.trim())) {
      return "Enter a valid Linux SSH username for the selected image.";
    }
    if (!validInteger(values.aws.volumeSizeGiB, 8)) return "Root volume must be at least 8 GiB.";
  }
  if (step === 1 && values.provider === "azure") {
    if (!values.azureOptions) return "Load Azure infrastructure options before continuing.";
    if (!validAzureLocation(values.location)) return "Choose an Azure credential with a valid default location.";
    if (!validAzureImageReference(values.azure.imageReference)) {
      return "Enter an Azure image as publisher:offer:sku:version or a full managed-image resource ID.";
    }
    if (!/^[A-Za-z0-9_-]{2,80}$/u.test(values.azure.vmSize.trim())) return "Enter a valid Azure VM size.";
    if (!isAzureSshUsername(values.azure.sshUsername.trim())) {
      return "Enter a valid Linux SSH username for the Azure image.";
    }
    if (values.azure.networkMode === "existing") {
      if (!values.azureOptions.virtualNetworks.some(({ id }) => id === values.azure.vnetId)) {
        return "Choose an existing Azure VNet or create a new one.";
      }
      if (!values.azureOptions.subnets.some(({ id, vnetId }) => id === values.azure.subnetId && vnetId === values.azure.vnetId)) {
        return "Choose a subnet in the selected Azure VNet.";
      }
    } else {
      const vnetCidr = parseManagedIpv4Cidr(values.azure.managedVnetCidr);
      const subnetCidr = parseManagedIpv4Cidr(values.azure.managedSubnetCidr);
      if (!vnetCidr || !subnetCidr) {
        return "Enter canonical IPv4 network CIDRs between /16 and /28 for the managed VNet and subnet.";
      }
      if (!managedIpv4CidrContains(vnetCidr, subnetCidr)) {
        return "The managed subnet CIDR must be contained by the managed VNet CIDR.";
      }
    }
    if (!validInteger(values.azure.osDiskSizeGiB, 30, 4_095)) {
      return "Azure OS disk must be between 30 and 4095 GiB.";
    }
  }
  if (step === 2) {
    if (values.provider === "azure" && Number(values.sshPort) !== AZURE_SSH_PORT) {
      return `Azure deployments require SSH port ${AZURE_SSH_PORT}.`;
    }
    if (!validPort(values.sshPort) || !validPort(values.multiplayerPort) || Number(values.sshPort) === Number(values.multiplayerPort)) return "Enter two different valid TCP ports.";
    const parsedSshCidrs = parseCidrs(values.sshCidrs);
    const parsedOperatorCidrs = parseCidrs(values.operatorCidrs);
    if (!validCidrList(parsedSshCidrs) || !validCidrList(parsedOperatorCidrs)) return "Add at least one valid SSH CIDR and one valid operator CIDR.";
  }
  return null;
}

function validateCredential(values: {
  readonly provider: CloudProvider;
  readonly label: string;
  readonly sshUsername: string;
  readonly defaultRegion: string;
  readonly awsAuthentication: "login" | "profile" | "access-keys";
  readonly awsProfileName: string;
  readonly awsProfiles: readonly AwsCliProfileSummary[];
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly azureAccounts: readonly AzureCliAccountSummary[];
  readonly azureSubscriptionId: string;
  readonly azureTenantId: string;
  readonly defaultLocation: string;
}): string | null {
  if (!values.label.trim()) return "Enter a credential label.";
  if (!values.sshUsername.trim()) return "Enter the Linux SSH username.";
  if (values.provider === "aws") {
    if (!isAwsRegion(values.defaultRegion.trim())) return "Enter a valid AWS region.";
    if (values.awsAuthentication === "profile") {
      if (!values.awsProfileName || !values.awsProfiles.some(({ name }) => name === values.awsProfileName)) {
        return "Choose an available AWS CLI profile.";
      }
    } else if (values.awsAuthentication === "access-keys" && (values.accessKeyId.trim().length < 16 || !values.secretAccessKey)) {
      return "Enter the AWS access key ID and secret access key.";
    }
  } else {
    if (!isAzureSshUsername(values.sshUsername.trim())) {
      return "Enter a valid, non-reserved Azure Linux SSH username.";
    }
    const account = values.azureAccounts.find(({ subscriptionId }) => subscriptionId === values.azureSubscriptionId);
    if (!account || account.tenantId !== values.azureTenantId) return "Choose an available Azure subscription.";
    if (account.cloudName !== "AzureCloud") return "Only AzureCloud subscriptions are currently supported.";
    if (!validAzureLocation(values.defaultLocation)) return "Enter a valid Azure location such as eastus.";
  }
  return null;
}

function parseCidrs(value: string): readonly string[] {
  return [...new Set(value.split(/[\s,]+/u).map((entry) => entry.trim()).filter(Boolean))];
}

function validCidrList(cidrs: readonly string[]): boolean {
  return cidrs.length > 0 && cidrs.length <= 32 && cidrs.every((cidr) => {
    const match = /^(.+)\/(\d{1,3})$/u.exec(cidr);
    if (!match) return false;
    const prefix = Number(match[2]);
    const address = match[1] ?? "";
    if (address.includes(":")) return prefix > 0 && prefix <= 128 && validIpv6Address(address);
    const octets = address.split(".");
    return prefix > 0 && prefix <= 32 && octets.length === 4 && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255 && String(Number(octet)) === octet);
  });
}

function validIpv6Address(value: string): boolean {
  if (!value.includes(":") || value.includes("%") || !/^[0-9a-f:.]+$/iu.test(value)) return false;
  const compressed = value.split("::");
  if (compressed.length > 2) return false;
  const countGroups = (part: string, allowIpv4Tail: boolean): number | null => {
    if (part === "") return 0;
    const groups = part.split(":");
    let count = 0;
    for (const [index, group] of groups.entries()) {
      if (group === "") return null;
      if (group.includes(".")) {
        if (!allowIpv4Tail || index !== groups.length - 1 || !validIpv4Address(group)) return null;
        count += 2;
      } else {
        if (!/^[0-9a-f]{1,4}$/iu.test(group)) return null;
        count += 1;
      }
    }
    return count;
  };
  const left = countGroups(compressed[0] ?? "", compressed.length === 1);
  const right = countGroups(compressed[1] ?? "", true);
  if (left === null || right === null) return false;
  return compressed.length === 2 ? left + right < 8 : left + right === 8;
}

function validIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^\d{1,3}$/u.test(octet) && Number(octet) <= 255 && String(Number(octet)) === octet);
}

interface ManagedIpv4Cidr {
  readonly address: number;
  readonly prefix: number;
}

function parseManagedIpv4Cidr(value: string): ManagedIpv4Cidr | null {
  const match = /^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\/(\d{1,2})$/u.exec(value.trim());
  if (!match || !validIpv4Address(match[1] ?? "")) return null;
  const prefix = Number(match[2]);
  if (!Number.isInteger(prefix) || prefix < 16 || prefix > 28) return null;
  const address = (match[1] ?? "").split(".").reduce(
    (result, octet) => ((result << 8) | Number(octet)) >>> 0,
    0,
  );
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) === address ? { address, prefix } : null;
}

function managedIpv4CidrContains(parent: ManagedIpv4Cidr, child: ManagedIpv4Cidr): boolean {
  const mask = (0xffff_ffff << (32 - parent.prefix)) >>> 0;
  return child.prefix >= parent.prefix && (parent.address & mask) === (child.address & mask);
}

function validAzureLocation(value: string): boolean {
  return /^[a-z0-9]{2,64}$/u.test(value.trim());
}

function validAzureImageReference(value: string): boolean {
  const trimmed = value.trim();
  if (/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/images\/[^/]+$/iu.test(trimmed)) {
    return trimmed.length <= 2_048;
  }
  const parts = trimmed.split(":");
  return parts.length === 4 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part));
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function validInteger(value: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum;
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function validOperatorPort(value: string): boolean {
  return /^(?:[1-9]\d{0,4})$/u.test(value) && Number(value) <= 65_535;
}

function isCloudOperatorPermission(value: string): value is CloudOperatorPermission {
  return value === "all" || value === "builder" || value === "crackstation";
}

function operatorPermissionDescription(permissions: CloudOperatorPermission): string {
  switch (permissions) {
    case "all": return "Full access to every Sliver gRPC API.";
    case "builder": return "Restricted to remote builder RPCs.";
    case "crackstation": return "Restricted to crackstation RPCs.";
  }
}

function operatorPermissionAccessLabel(permissions: CloudOperatorPermission): string {
  switch (permissions) {
    case "all": return "full access";
    case "builder": return "remote builder access";
    case "crackstation": return "crackstation access";
  }
}

function firstCredentialId(credentials: readonly CloudCredentialSummary[], provider: CloudProvider): string {
  return credentials.find((credential) => credential.provider === provider)?.id ?? "";
}

function preferredAwsProfile(profiles: readonly AwsCliProfileSummary[]): AwsCliProfileSummary | undefined {
  return profiles.find(({ name }) => name === "default") ?? profiles[0];
}

function preferredAzureAccount(accounts: readonly AzureCliAccountSummary[]): AzureCliAccountSummary | undefined {
  return accounts.find(({ isDefault }) => isDefault) ?? accounts[0];
}

function awsRegion(credential: CloudCredentialSummary | undefined): string {
  return credential?.provider === "aws" ? credential.defaultRegion : "";
}

function azureLocation(credential: CloudCredentialSummary | undefined): string {
  return credential?.provider === "azure" ? credential.defaultLocation : "";
}

function providerLabel(provider: CloudProvider): string {
  return provider === "aws" ? "AWS EC2" : "Microsoft Azure";
}

function providerIcon(provider: CloudProvider) {
  return provider === "aws" ? faAmazon : faMicrosoft;
}

function runtimeId(deployment: CloudDeploymentRecord): string {
  if (deployment.provider === "aws") return deployment.runtime.instanceId ?? "Pending";
  return deployment.runtime.vmName ?? deployment.runtime.vmId ?? "Pending";
}

function statusColor(status: CloudDeploymentStatus): "default" | "success" | "warning" | "danger" {
  if (status === "running") return "success";
  if (status === "failed") return "danger";
  if (status === "provisioning" || status === "deleting") return "warning";
  return "default";
}

function phaseProgress(phase: CloudDeploymentRecord["phase"]): number {
  const phases: readonly CloudDeploymentRecord["phase"][] = [
    "validating",
    "creating-instance",
    "configuring-firewall",
    "starting-instance",
    "waiting-instance-status",
    "waiting-system-status",
    "finalizing-network",
    "installing-sliver",
    "configuring-daemon",
    "creating-operator",
    "copying-operator-config",
    "ready",
  ];
  if (phase === "deleting") return 50;
  if (phase === "failed" || phase === "stopped") return 100;
  const index = phases.indexOf(phase);
  return index < 0 ? 0 : Math.round(((index + 1) / phases.length) * 100);
}

function phaseLabel(phase: CloudDeploymentRecord["phase"]): string {
  const labels: Record<CloudDeploymentRecord["phase"], string> = {
    validating: "Validating provider access",
    "creating-instance": "Creating compute instance",
    "configuring-firewall": "Configuring firewall",
    "starting-instance": "Starting instance",
    "waiting-instance-status": "Waiting for compute health checks",
    "waiting-system-status": "Waiting for platform health checks",
    "finalizing-network": "Finalizing instance networking",
    "installing-sliver": "Installing Sliver",
    "configuring-daemon": "Configuring Linux daemon",
    "creating-operator": "Creating operator profile",
    "copying-operator-config": "Copying operator config",
    ready: "Ready",
    stopped: "Stopped",
    failed: "Failed",
    deleting: "Terminating verified assets",
  };
  return labels[phase];
}

function titleCase(value: string): string {
  return value.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function feedbackToneClass(tone: FeedbackTone): string {
  if (tone === "danger") return "bg-danger-soft text-danger-soft-foreground";
  if (tone === "warning") return "bg-warning-soft text-warning-soft-foreground";
  if (tone === "success") return "bg-success-soft text-success-soft-foreground";
  return "bg-accent-soft text-accent-soft-foreground";
}

function scrubCredentialInput(input: CreateCloudCredentialInput): void {
  const mutable = input as unknown as Record<string, unknown>;
  for (const key of ["accessKeyId", "secretAccessKey", "sessionToken", "sshPassphrase", "sshPrivateKeyToken", "loginToken"]) {
    if (Object.hasOwn(mutable, key)) mutable[key] = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Cloud Deployment encountered an unexpected error.";
}

function hasDeploymentSshHost(deployment: CloudDeploymentRecord): boolean {
  const host = deployment.provider === "azure"
    ? deployment.spec.usePublicIp
      ? deployment.runtime.publicIpAddress
      : deployment.runtime.privateIpAddress
    : deployment.remoteHost ?? deployment.runtime.publicIpAddress ?? deployment.runtime.privateIpAddress;
  return Boolean(host?.trim());
}

function hasStableDeploymentRuntime(deployment: CloudDeploymentRecord): boolean {
  const state = deployment.runtime.instanceState;
  if (deployment.status === "running") return state === "running";
  return deployment.status === "stopped" && (state === "stopped" || (deployment.provider === "azure" && state === "deallocated"));
}

function deploymentStatusLabel(deployment: CloudDeploymentRecord): string {
  if (deployment.status === "deleting") return "Terminating";
  if ((deployment.status === "running" || deployment.status === "stopped") && !hasStableDeploymentRuntime(deployment)) {
    return titleCase(deployment.runtime.instanceState ?? "unknown");
  }
  return titleCase(deployment.status);
}

function deploymentSshUnavailableReason(
  deployment: CloudDeploymentRecord,
  hasSshCredential: boolean,
): string | undefined {
  if ((deployment.status === "running" || deployment.status === "stopped") && !hasStableDeploymentRuntime(deployment)) {
    return "Wait until the provider confirms this server is running before opening SSH.";
  }
  if (deployment.status === "stopped") return "Start this server before opening SSH.";
  if (deployment.status === "provisioning") return "This server is still being provisioned.";
  if (deployment.status === "deleting") return "This server is being terminated.";
  if (deployment.status === "failed") return "Resolve this server's deployment error before opening SSH.";
  if (!hasSshCredential) return "No stored SSH private key is available for this server.";
  if (!hasDeploymentSshHost(deployment)) return "This server does not have an SSH address yet.";
  return undefined;
}

function deploymentOperatorUnavailableReason(
  deployment: CloudDeploymentRecord,
  hasSshCredential: boolean,
): string | undefined {
  if ((deployment.status === "running" || deployment.status === "stopped") && !hasStableDeploymentRuntime(deployment)) {
    return "Wait until the provider confirms this server is running before adding an operator.";
  }
  if (deployment.status === "stopped") return "Start this server before adding an operator.";
  if (deployment.status === "provisioning") return "Wait for provisioning to finish before adding an operator.";
  if (deployment.status === "deleting") return "This server is being terminated; operators cannot be added.";
  if (deployment.status === "failed") return "Resolve this server's deployment error before adding an operator.";
  if (!hasSshCredential) return "No stored SSH private key is available for operator creation.";
  if (!hasDeploymentSshHost(deployment)) return "This server does not have an SSH address for operator creation.";
  return undefined;
}

function safeSshErrorMessage(error: unknown, fallback: string): string {
  const source = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  let printable = "";
  for (const character of source) {
    const codePoint = character.codePointAt(0) ?? 0;
    printable += codePoint < 32 || codePoint === 127 ? " " : character;
  }
  const normalized = printable.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 512) : fallback;
}
