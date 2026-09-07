import { faAmazon } from "@fortawesome/free-brands-svg-icons";
import {
  faArrowLeft,
  faArrowsRotate,
  faCheck,
  faCloudArrowUp,
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
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Chip,
  Description,
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
  AWS_SUPPORTED_INSTANCE_TYPES,
  isAwsRegion,
  type AwsCloudDeploymentRecord,
  type AwsCliProfileSummary,
  type AwsFirewallPeerType,
  type AwsFirewallRule,
  type AwsFirewallDirection,
  type AwsFirewallRuleSpec,
  type AwsFirewallSnapshot,
  type CloudCredentialSummary,
  type CloudDeploymentRecord,
  type CloudDeploymentStatus,
  type CloudProvider,
  type CreateCloudCredentialInput,
  type CreateCloudDeploymentInput,
} from "../../shared/cloud-deployment-contracts";
import type { AwsDeploymentOptions } from "../../shared/cloud-provider-inventory";
import type { SshHostKeyReview } from "../../shared/ssh-contracts";
import type {
  CloudCredentialTestResult,
  CloudDeploymentAPI,
  CloudDeploymentChangeScope,
  CloudDeploymentNavigationRequest,
  CloudDeploymentSnapshot,
  CloudProvisioningTranscript,
  DestroyCloudDeploymentPlan,
  SshPrivateKeySelection,
} from "../../shared/cloud-deployment-ipc";
import { applyRendererTheme } from "./components/ApplicationSettingsProvider";
import { CloudProvisioningTerminal } from "./components/CloudProvisioningTerminal";

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
type CloudDeploymentCardAction = CloudDeploymentActionRequest["action"] | "reboot";

interface ActiveCloudDeploymentCardAction {
  readonly deploymentId: string;
  readonly action: CloudDeploymentCardAction;
}

const FEEDBACK_TOAST_TIMEOUT_MS = 30_000;

type EgressIpv4Detection =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly cidr: string }
  | { readonly status: "failed"; readonly error: string };

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

interface ProxmoxDeploymentDraft {
  readonly node: string;
  readonly templateVmId: string;
  readonly vmId: string;
  readonly storage: string;
  readonly bridge: string;
  readonly cores: string;
  readonly memoryMiB: string;
  readonly diskGiB: string;
  readonly ipConfig: string;
  readonly gateway: string;
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
// AWS key-pair names are strings, so a numeric collection key cannot collide
// with any real key pair returned by EC2.
const MANAGED_KEY_OPTION = -1;

function strongerRefreshScope(
  queued: CloudDeploymentChangeScope | null,
  requested: CloudDeploymentChangeScope,
): CloudDeploymentChangeScope {
  return queued === "snapshot" || requested === "snapshot" ? "snapshot" : "transcripts";
}

const INITIAL_PROXMOX_DEPLOYMENT: ProxmoxDeploymentDraft = {
  node: "",
  templateVmId: "",
  vmId: "",
  storage: "local-lvm",
  bridge: "vmbr0",
  cores: "2",
  memoryMiB: "4096",
  diskGiB: "20",
  ipConfig: "ip=dhcp",
  gateway: "",
};

export function CloudDeploymentWindowApp(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<CloudDeploymentSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<RefreshFailure | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [selectedTab, setSelectedTab] = useState("deployments");
  const [detailsDeploymentId, setDetailsDeploymentId] = useState<string | null>(null);
  const [actionRequest, setActionRequest] = useState<CloudDeploymentActionRequest | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshQueued = useRef<CloudDeploymentChangeScope | null>(null);
  const snapshotRef = useRef<CloudDeploymentSnapshot | null>(null);
  const activeCardAction = useRef<ActiveCloudDeploymentCardAction | null>(null);
  const queuedNavigationRequest = useRef<CloudDeploymentNavigationRequest | null>(null);

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
        while (scope) {
          const activeScope = scope;
          refreshQueued.current = null;
          if ((scope === "snapshot" || !snapshotRef.current) && !showedLoading) {
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
              const result = await api.getSnapshot();
              if (!result.ok || !result.value) {
                setLoadError({
                  scope: "snapshot",
                  message: result.error ?? "Cloud Deployment state could not be loaded.",
                });
              } else {
                snapshotRef.current = result.value;
                setSnapshot(result.value);
                setLoadError(null);
              }
            } else {
              const result = await api.getProvisioningTranscripts();
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
            const message = errorMessage(error);
            setLoadError((current) => activeScope === "transcripts" && current?.scope === "snapshot"
              ? current
              : { scope: activeScope, message });
          }
          scope = refreshQueued.current;
        }
      } finally {
        if (showedLoading) setIsLoading(false);
      }
    })().finally(() => {
      if (refreshInFlight.current === request) refreshInFlight.current = null;
    });
    refreshInFlight.current = request;
    return request;
  }, [api]);

  useEffect(() => {
    document.title = "Cloud Deployment";
    const removeThemeListener = api?.onThemeChanged(applyRendererTheme);
    const removeChangedListener = api?.onChanged((scope) => void refresh(scope));
    const removeNavigationListener = api?.onNavigationRequested(handleNavigationRequest);
    void refresh();
    return () => {
      removeThemeListener?.();
      removeChangedListener?.();
      removeNavigationListener?.();
    };
  }, [api, handleNavigationRequest, refresh]);

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
    if (!detailsDeploymentId) return;
    const target = snapshot.state.deployments.find(({ id }) => id === detailsDeploymentId);
    if (!target) {
      setDetailsDeploymentId(null);
      setFeedback({
        tone: "danger",
        title: "Deployment unavailable",
        detail: `The requested deployment (${detailsDeploymentId}) is no longer in the managed inventory.`,
      });
    } else if (target.provider !== "aws") {
      setDetailsDeploymentId(null);
      setFeedback({
        tone: "danger",
        title: "Firewall unavailable",
        detail: `${target.name} is not an AWS EC2 deployment, so it cannot open the AWS firewall editor.`,
      });
    }
  }, [actionRequest, detailsDeploymentId, snapshot]);

  const detailsDeployment = detailsDeploymentId
    ? snapshot?.state.deployments.find(({ id }) => id === detailsDeploymentId)
    : undefined;
  const awsDetailsDeployment = detailsDeployment?.provider === "aws" ? detailsDeployment : undefined;

  return (
    <main className={`h-screen bg-background text-foreground ${awsDetailsDeployment ? "overflow-hidden" : "overflow-y-auto"}`}>
      <div className={`mx-auto flex w-full max-w-7xl flex-col px-6 pt-8 lg:px-8 ${awsDetailsDeployment ? "h-full min-h-0" : "gap-6 pb-12"}`}>
        {!awsDetailsDeployment ? (
          <header className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent-soft-foreground">
                <FontAwesomeIcon aria-hidden icon={faCloudArrowUp} className="size-5" />
              </span>
              <div>
                <h1 className="text-2xl font-semibold tracking-tight">Cloud Deployment</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">
                  Provision and operate tagged Sliver multiplayer servers on AWS EC2 or Proxmox.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {snapshot ? (
                <Chip color={snapshot.secureCredentialStorage ? "success" : "warning"} size="sm" variant="soft">
                  {snapshot.secureCredentialStorage ? "Encrypted credentials" : "Session-only credentials"}
                </Chip>
              ) : null}
              <Tooltip delay={0}>
                <Button
                  aria-label="Refresh cloud deployments"
                  isDisabled={isLoading}
                  isIconOnly
                  variant="outline"
                  onPress={() => void refresh()}
                >
                  <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={isLoading ? "animate-spin" : ""} />
                </Button>
                <Tooltip.Content>Refresh cloud deployments</Tooltip.Content>
              </Tooltip>
            </div>
          </header>
        ) : null}

        {!awsDetailsDeployment && feedback ? <FeedbackBanner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}
        {isLoading && !snapshot ? <LoadingSurface /> : null}
        {loadError && !snapshot ? <LoadError message={loadError.message} onRetry={() => void refresh()} /> : null}
        {!awsDetailsDeployment && loadError && snapshot ? (
          <InlineMessage
            tone="warning"
            title="Refresh failed"
            detail={`${loadError.message} The last successfully loaded deployment data remains visible.`}
          />
        ) : null}

        {snapshot && api && awsDetailsDeployment ? (
          <AwsInstanceDetails
            api={api}
            deployment={awsDetailsDeployment}
            notices={(
              <>
                {feedback ? <FeedbackBanner feedback={feedback} onDismiss={() => setFeedback(null)} /> : null}
                {loadError ? (
                  <InlineMessage
                    tone="warning"
                    title="Refresh failed"
                    detail={`${loadError.message} The last successfully loaded deployment data remains visible.`}
                  />
                ) : null}
              </>
            )}
            revision={snapshot.state.revision}
            onBack={() => setDetailsDeploymentId(null)}
            onFeedback={showFeedback}
            onRefresh={refresh}
          />
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
                onOpenAwsDetails={(deploymentId) => {
                  setFeedback(null);
                  setDetailsDeploymentId(deploymentId);
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
    </main>
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
  onOpenAwsDetails,
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
  readonly onOpenAwsDetails: (deploymentId: string) => void;
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
          deployment={resumedDeployment}
          hasSshCredential={snapshot.credentials.some(({ id, provider }) => (
            id === resumedDeployment.credentialId && provider === resumedDeployment.provider
          ))}
          isDeploymentView
          revision={snapshot.state.revision}
          {...(resumedTranscript ? { transcript: resumedTranscript } : {})}
          onFeedback={onFeedback}
          onActionRequestHandled={onActionRequestHandled}
          onBeginCardAction={onBeginCardAction}
          onFinishCardAction={onFinishCardAction}
          onOpenAwsDetails={() => onOpenAwsDetails(resumedDeployment.id)}
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
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visibleDeployments.map((deployment) => (
            <DeploymentCard
              actionRequest={actionRequest?.deploymentId === deployment.id ? actionRequest : null}
              api={api}
              deployment={deployment}
              hasSshCredential={snapshot.credentials.some(({ id, provider }) => (
                id === deployment.credentialId && provider === deployment.provider
              ))}
              key={deployment.id}
              revision={snapshot.state.revision}
              onFeedback={onFeedback}
              onActionRequestHandled={onActionRequestHandled}
              onBeginCardAction={onBeginCardAction}
              onFinishCardAction={onFinishCardAction}
              onOpenAwsDetails={() => onOpenAwsDetails(deployment.id)}
              onRefresh={onRefresh}
            />
          ))}
        </div>
      )}
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
  const [aws, setAws] = useState<AwsDeploymentDraft>(INITIAL_AWS_DEPLOYMENT);
  const [awsOptions, setAwsOptions] = useState<AwsDeploymentOptions | null>(null);
  const [awsOptionsError, setAwsOptionsError] = useState<string | null>(null);
  const [isLoadingAwsOptions, setIsLoadingAwsOptions] = useState(false);
  const [awsDiscoveryAttempt, setAwsDiscoveryAttempt] = useState(0);
  const [proxmox, setProxmox] = useState<ProxmoxDeploymentDraft>(INITIAL_PROXMOX_DEPLOYMENT);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deploymentStarted, setDeploymentStarted] = useState(false);
  const [activeDeploymentId, setActiveDeploymentId] = useState<string | null>(null);
  const deploymentBaseline = useRef<ReadonlySet<string>>(new Set());
  const awsDiscoverySequence = useRef(0);
  const sshCidrsTouched = useRef(false);
  const operatorCidrsTouched = useRef(false);

  const credentials = snapshot.credentials.filter((credential) => credential.provider === provider);
  const chosenCredential = snapshot.credentials.find((credential) => credential.id === credentialId);
  const region = awsRegion(chosenCredential);
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
    sshPort,
    multiplayerPort,
    sshCidrs,
    operatorCidrs,
    aws,
    awsOptions,
    proxmox,
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
      sshPort: Number(sshPort),
      multiplayerPort: Number(multiplayerPort),
      sshCidrs: parseCidrs(sshCidrs),
      operatorCidrs: parseCidrs(operatorCidrs),
      useElasticIp,
      aws,
      proxmox,
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
          deployment={activeDeployment}
          hasSshCredential={snapshot.credentials.some(({ id, provider: credentialProvider }) => (
            id === activeDeployment.credentialId && credentialProvider === activeDeployment.provider
          ))}
          isDeploymentView
          revision={snapshot.state.revision}
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
                { value: "proxmox", label: "Proxmox VE" },
              ]}
              onChange={(value) => {
                if (value === "aws" || value === "proxmox") changeProvider(value);
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

        {step === 1 && provider === "proxmox" ? (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <CloudTextField label="Node" placeholder="pve" value={proxmox.node} onChange={(value) => setProxmox({ ...proxmox, node: value })} />
            <CloudTextField inputMode="numeric" label="Template VM ID" placeholder="9000" value={proxmox.templateVmId} onChange={(value) => setProxmox({ ...proxmox, templateVmId: value })} />
            <CloudTextField description="Leave blank to allocate the next VM ID." inputMode="numeric" label="VM ID" placeholder="Automatic" value={proxmox.vmId} onChange={(value) => setProxmox({ ...proxmox, vmId: value })} />
            <CloudTextField label="Storage" placeholder="local-lvm" value={proxmox.storage} onChange={(value) => setProxmox({ ...proxmox, storage: value })} />
            <CloudTextField label="Network Bridge" placeholder="vmbr0" value={proxmox.bridge} onChange={(value) => setProxmox({ ...proxmox, bridge: value })} />
            <CloudTextField label="Cloud-init IP Config" placeholder="ip=dhcp" value={proxmox.ipConfig} onChange={(value) => setProxmox({ ...proxmox, ipConfig: value })} />
            <CloudTextField inputMode="numeric" label="CPU Cores" value={proxmox.cores} onChange={(value) => setProxmox({ ...proxmox, cores: value })} />
            <CloudTextField inputMode="numeric" label="Memory (MiB)" value={proxmox.memoryMiB} onChange={(value) => setProxmox({ ...proxmox, memoryMiB: value })} />
            <CloudTextField inputMode="numeric" label="Disk (GiB)" value={proxmox.diskGiB} onChange={(value) => setProxmox({ ...proxmox, diskGiB: value })} />
            <CloudTextField description="Optional for static addressing." label="Gateway" placeholder="10.0.0.1" value={proxmox.gateway} onChange={(value) => setProxmox({ ...proxmox, gateway: value })} />
            <p className="self-center text-sm leading-6 text-muted md:col-span-2">
              The template must support cloud-init and run QEMU Guest Agent so its address can be verified before Sliver is installed.
            </p>
          </div>
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
            <CloudTextField inputMode="numeric" label="SSH Port" value={sshPort} onChange={setSshPort} />
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
              ["SSH", `TCP ${sshPort} · ${parseCidrs(sshCidrs).length} source${parseCidrs(sshCidrs).length === 1 ? "" : "s"}`],
              ["Multiplayer", `TCP ${multiplayerPort} · ${parseCidrs(operatorCidrs).length} source${parseCidrs(operatorCidrs).length === 1 ? "" : "s"}`],
              ["Stable Address", provider === "aws" ? (useElasticIp ? "Elastic IP" : "Private instance address") : "Guest address"],
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
              (step === 1 && provider === "aws" && (isLoadingAwsOptions || Boolean(awsOptionsError) || !awsOptions))
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
          <FontAwesomeIcon aria-hidden icon={provider === "aws" ? faAmazon : faServer} />
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

function DeploymentCard({
  actionRequest,
  api,
  deployment,
  hasSshCredential,
  isDeploymentView = false,
  revision,
  transcript,
  onActionRequestHandled,
  onBeginCardAction,
  onFinishCardAction,
  onFeedback,
  onOpenAwsDetails,
  onRefresh,
  onTerminated,
}: {
  readonly actionRequest?: CloudDeploymentActionRequest | null;
  readonly api: CloudDeploymentAPI;
  readonly deployment: CloudDeploymentRecord;
  readonly hasSshCredential: boolean;
  readonly isDeploymentView?: boolean;
  readonly revision: number;
  readonly transcript?: CloudProvisioningTranscript;
  readonly onActionRequestHandled?: (request: CloudDeploymentActionRequest) => void;
  readonly onBeginCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => boolean;
  readonly onFinishCardAction: (deploymentId: string, action: CloudDeploymentCardAction) => void;
  readonly onFeedback: (feedback: Feedback) => void;
  readonly onOpenAwsDetails?: () => void;
  readonly onRefresh: () => Promise<void>;
  readonly onTerminated?: () => void;
}): React.JSX.Element {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [editingFirewall, setEditingFirewall] = useState(false);
  const [sshCidrs, setSshCidrs] = useState(deployment.spec.sshCidrs.join("\n"));
  const [operatorCidrs, setOperatorCidrs] = useState(deployment.spec.operatorCidrs.join("\n"));
  const [firewallError, setFirewallError] = useState<string | null>(null);
  const [destroyPlan, setDestroyPlan] = useState<DestroyCloudDeploymentPlan | null>(null);
  const [sshHostKeyReview, setSshHostKeyReview] = useState<SshHostKeyReview | null>(null);
  const [sshHostKeyReviewError, setSshHostKeyReviewError] = useState<string | null>(null);
  const [isOpeningSsh, setIsOpeningSsh] = useState(false);
  const handledActionRequest = useRef<CloudDeploymentActionRequest | null>(null);
  const actionInFlight = useRef(false);
  const destroyExecutionInFlight = useRef(false);
  const sshRequestInFlight = useRef(false);

  const lifecycle = useCallback(async (action: "start" | "stop" | "reboot"): Promise<void> => {
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
  }, [api, deployment.id, deployment.name, deployment.provider, onBeginCardAction, onFeedback, onFinishCardAction, onRefresh, revision]);

  const updateFirewall = async (): Promise<void> => {
    const nextSshCidrs = parseCidrs(sshCidrs);
    const nextOperatorCidrs = parseCidrs(operatorCidrs);
    if (!validCidrList(nextSshCidrs) || !validCidrList(nextOperatorCidrs)) {
      setFirewallError("Both services require at least one valid source CIDR.");
      return;
    }
    setPendingAction("firewall");
    setFirewallError(null);
    try {
      const result = await api.updateFirewall({ deploymentId: deployment.id, expectedRevision: revision, sshCidrs: nextSshCidrs, operatorCidrs: nextOperatorCidrs });
      if (!result.ok) {
        setFirewallError(result.error ?? "The firewall policy was rejected.");
        return;
      }
      setEditingFirewall(false);
      onFeedback({ tone: "success", title: "Firewall updated", detail: `${deployment.name} now uses the reviewed source ranges.` });
      await onRefresh();
    } catch (error) {
      setFirewallError(errorMessage(error));
    } finally {
      setPendingAction(null);
    }
  };

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

  const openSsh = async (errorSurface: "page" | "host-key-dialog" = "page"): Promise<void> => {
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
  };

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

  useEffect(() => {
    if (
      !actionRequest ||
      actionRequest.deploymentId !== deployment.id ||
      handledActionRequest.current === actionRequest
    ) return;
    handledActionRequest.current = actionRequest;
    onActionRequestHandled?.(actionRequest);
    if (actionRequest.action === "terminate") void prepareDestroy();
    else void lifecycle(actionRequest.action);
  }, [actionRequest, deployment.id, lifecycle, onActionRequestHandled, prepareDestroy]);

  const progress = phaseProgress(deployment.phase);
  const lifecycleAction = deployment.status === "running"
    ? "stop"
    : deployment.status === "stopped"
      ? "start"
      : null;
  const lifecycleLabel = lifecycleAction === "stop" ? "Stop" : "Start";
  const sshUnavailableReason = deploymentSshUnavailableReason(deployment, hasSshCredential);
  const sshActionDisabledReason = isOpeningSsh
    ? `An SSH session for ${deployment.name} is already opening.`
    : pendingAction !== null
      ? `Wait for the current ${deployment.name} server action to finish.`
      : sshUnavailableReason;

  return (
    <Card className={isDeploymentView ? "w-full" : "h-fit"} variant="secondary">
      <Card.Header className="flex-row items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-tertiary text-muted">
          <FontAwesomeIcon aria-hidden icon={deployment.provider === "aws" ? faAmazon : faServer} />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{deployment.name}</Card.Title>
          <Card.Description>{providerLabel(deployment.provider)} · {deployment.remoteHost ?? "Address pending"}</Card.Description>
        </div>
        <Chip color={statusColor(deployment.status)} size="sm" variant="soft">
          {deployment.status === "deleting" ? "Terminating" : titleCase(deployment.status)}
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
        {deployment.lastError ? <InlineMessage tone="danger" title="Last operation failed" detail={deployment.lastError} /> : null}
        {isDeploymentView && deployment.provider === "aws" ? <AwsStatusChecks deployment={deployment} /> : null}
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <DeploymentDetail label="Management ID" value={deployment.id} mono />
          <DeploymentDetail label={deployment.provider === "aws" ? "Instance" : "Virtual Machine"} value={runtimeId(deployment)} mono />
          <DeploymentDetail label="Operator Config" value={deployment.operatorConfigFileName ?? "Pending"} mono />
          <DeploymentDetail label="Managed Assets" value={String(deployment.managedAssets.length)} />
        </dl>

        {editingFirewall && deployment.provider === "proxmox" ? (
          <div className="space-y-4 rounded-2xl bg-surface p-4">
            <div>
              <h3 className="text-sm font-semibold">Firewall Sources</h3>
              <p className="mt-1 text-xs leading-5 text-muted">Only the rules owned by this deployment are changed.</p>
            </div>
            {firewallError ? <InlineMessage tone="danger" title="Firewall update failed" detail={firewallError} /> : null}
            <CloudTextArea label="SSH Source CIDRs" value={sshCidrs} onChange={setSshCidrs} />
            <CloudTextArea label="Operator Source CIDRs" value={operatorCidrs} onChange={setOperatorCidrs} />
            <div className="flex justify-end gap-2">
              <Button isDisabled={pendingAction === "firewall"} variant="tertiary" onPress={() => setEditingFirewall(false)}>Cancel</Button>
              <Button isPending={pendingAction === "firewall"} variant="primary" onPress={() => void updateFirewall()}>Save Firewall</Button>
            </div>
          </div>
        ) : null}
        {isDeploymentView ? (
          <CloudProvisioningTerminal
            api={api}
            deploymentId={deployment.id}
            transcript={transcript}
          />
        ) : null}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Tooltip delay={0}>
          <Tooltip.Trigger
            {...(sshActionDisabledReason
              ? {
                  "aria-label": `SSH action unavailable for ${deployment.name}: ${sshActionDisabledReason}`,
                  tabIndex: 0,
                }
              : { tabIndex: -1 })}
            className="inline-flex"
          >
            <Button
              aria-label={`SSH to ${deployment.name}`}
              isDisabled={sshActionDisabledReason !== undefined}
              isPending={isOpeningSsh}
              size="sm"
              variant="outline"
              onPress={() => void openSsh()}
            >
              <FontAwesomeIcon aria-hidden icon={faTerminal} /> SSH
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>
            {sshActionDisabledReason ?? `Open an SSH session for ${deployment.name}`}
          </Tooltip.Content>
        </Tooltip>
        <Button
          aria-label={`${lifecycleLabel} ${deployment.name}`}
          {...(lifecycleAction === "stop"
            ? { className: "bg-warning-soft text-warning-soft-foreground hover:bg-warning-soft-hover" }
            : {})}
          isDisabled={lifecycleAction === null || pendingAction !== null}
          size="sm"
          variant={lifecycleAction === "stop" ? "tertiary" : "outline"}
          onPress={() => {
            if (lifecycleAction) void lifecycle(lifecycleAction);
          }}
        >
          <FontAwesomeIcon aria-hidden icon={lifecycleAction === "stop" ? faStop : faPlay} /> {lifecycleLabel}
        </Button>
        <Button aria-label={`Reboot ${deployment.name}`} className="bg-warning-soft text-warning-soft-foreground hover:bg-warning-soft-hover" isDisabled={deployment.status !== "running" || pendingAction !== null} size="sm" variant="tertiary" onPress={() => void lifecycle("reboot")}>
          <FontAwesomeIcon aria-hidden icon={faRotate} /> Reboot
        </Button>
        <Button
          aria-label={`Edit firewall for ${deployment.name}`}
          isDisabled={deployment.managedAssets.length === 0 || deployment.status === "provisioning" || deployment.status === "deleting" || pendingAction !== null}
          size="sm"
          variant="outline"
          onPress={() => {
            if (deployment.provider === "aws") onOpenAwsDetails?.();
            else setEditingFirewall((value) => !value);
          }}
        >
          <FontAwesomeIcon aria-hidden icon={faShieldHalved} /> Firewall
        </Button>
        <Tooltip delay={0}>
          <Button
            aria-label={`Terminate ${deployment.name}`}
            className="sm:ml-auto"
            isDisabled={deployment.status === "provisioning" || deployment.status === "deleting" || pendingAction !== null}
            isIconOnly
            isPending={pendingAction === "prepare-destroy"}
            size="sm"
            variant="danger-soft"
            onPress={() => void prepareDestroy()}
          >
            <FontAwesomeIcon aria-hidden icon={faTrash} />
          </Button>
          <Tooltip.Content>Terminate</Tooltip.Content>
        </Tooltip>
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
  const [firewall, setFirewall] = useState<AwsFirewallSnapshot | null>(null);
  const [selectedDirection, setSelectedDirection] = useState<AwsFirewallDirection>("ingress");
  const [isLoadingRules, setIsLoadingRules] = useState(true);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [editor, setEditor] = useState<AwsFirewallEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [deleteRule, setDeleteRule] = useState<AwsFirewallRule | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<"create" | "update" | "delete" | null>(null);
  const loadGeneration = useRef(0);

  const loadRules = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setIsLoadingRules(true);
    setRulesError(null);
    try {
      const result = await api.listFirewallRules({ deploymentId: deployment.id });
      if (generation !== loadGeneration.current) return;
      if (!result.ok || !result.value) {
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
      if (!result.ok || !result.value) {
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
      if (!result.ok || !result.value) {
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
  const columns = awsFirewallColumns({
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
        className="sticky top-0 z-20 shrink-0 space-y-6 bg-background pb-6"
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
            <Chip color={statusColor(deployment.status)} size="sm" variant="soft">
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
            <Card.Header>
              <Card.Title>Instance summary</Card.Title>
              <Card.Description>Compute and network identifiers for this managed server.</Card.Description>
            </Card.Header>
            <Card.Content>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
                <DeploymentDetail label="Instance ID" value={deployment.runtime.instanceId ?? "Pending"} mono />
                <DeploymentDetail label="Instance type" value={deployment.spec.instanceType} mono />
                <DeploymentDetail label="Availability Zone" value={deployment.runtime.availabilityZone ?? "Pending"} mono />
                <DeploymentDetail label="Public IP" value={deployment.runtime.publicIpAddress ?? "None"} mono />
                <DeploymentDetail label="Private IP" value={deployment.runtime.privateIpAddress ?? "Pending"} mono />
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
              <div className="flex items-center gap-2 self-end sm:self-auto">
                <Tooltip delay={0}>
                  <Button
                    aria-label="Refresh firewall rules"
                    isDisabled={isLoadingRules || pendingMutation !== null}
                    isIconOnly
                    size="sm"
                    variant="outline"
                    onPress={() => void loadRules()}
                  >
                    <FontAwesomeIcon aria-hidden icon={faArrowsRotate} className={isLoadingRules ? "animate-spin" : ""} />
                  </Button>
                  <Tooltip.Content>Refresh firewall rules</Tooltip.Content>
                </Tooltip>
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
        className="[&_tbody_tr]:cursor-[var(--cursor-interactive)]"
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
  direction,
  isPending,
  onDelete,
  onEdit,
}: {
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
        <div className="flex min-w-0 flex-col items-start gap-1">
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
      accessorKey: "peer",
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
            <EmptyState.Description>Add an AWS or Proxmox credential to start deploying.</EmptyState.Description>
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
  const [awsAuthentication, setAwsAuthentication] = useState<"profile" | "access-keys">(
    initialAwsProfile ? "profile" : "access-keys",
  );
  const [awsProfileName, setAwsProfileName] = useState(initialAwsProfile?.name ?? "");
  const [label, setLabel] = useState("");
  const [sshUsername, setSshUsername] = useState("ubuntu");
  const [defaultRegion, setDefaultRegion] = useState(initialAwsProfile?.region ?? "us-east-1");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [tlsCaCertificate, setTlsCaCertificate] = useState("");
  const [sshPassphrase, setSshPassphrase] = useState("");
  const [keySelection, setKeySelection] = useState<SshPrivateKeySelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (awsAuthentication !== "profile") return;
    if (awsProfiles.some(({ name }) => name === awsProfileName)) return;

    const profile = preferredAwsProfile(awsProfiles);
    if (!profile) {
      setAwsAuthentication("access-keys");
      setAwsProfileName("");
      return;
    }

    setAwsProfileName(profile.name);
    if (profile.region) setDefaultRegion(profile.region);
  }, [awsAuthentication, awsProfileName, awsProfiles]);

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
      endpoint,
      tokenId,
      tokenSecret,
    });
    if (validation) {
      setError(validation);
      return;
    }
    const sshPrivateKeyToken = keySelection?.token ?? null;

    const input: CreateCloudCredentialInput = provider === "aws"
      ? awsAuthentication === "profile"
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
          provider: "proxmox",
          label: label.trim(),
          sshUsername: sshUsername.trim(),
          sshPrivateKeyToken,
          endpoint: endpoint.trim(),
          tokenId: tokenId.trim(),
          tokenSecret,
          tlsCaCertificate: nullable(tlsCaCertificate),
          sshPassphrase: nullable(sshPassphrase),
        };

    setIsSaving(true);
    setError(null);
    try {
      const result = await api.createCredential(input);
      if (!result.ok || !result.value) {
        setError(result.error ?? "The credential was rejected.");
        return;
      }
      setSecretAccessKey("");
      setSessionToken("");
      setTokenSecret("");
      setSshPassphrase("");
      setTlsCaCertificate("");
      setKeySelection(null);
      await onCreated(result.value.label);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      scrubCredentialInput(input);
      setAccessKeyId("");
      setSecretAccessKey("");
      setSessionToken("");
      setTokenSecret("");
      setSshPassphrase("");
      setKeySelection(null);
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <Card.Header>
        <Card.Title>Add Provider Credential</Card.Title>
        <Card.Description>Credentials are validated in the main process and are never listed back to the renderer.</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-5">
        {error ? <InlineMessage tone="danger" title="Credential not saved" detail={error} /> : null}
        <div className="grid gap-4 md:grid-cols-2">
          <CloudNativeSelect
            label="Provider"
            value={provider}
            options={[{ value: "aws", label: "AWS" }, { value: "proxmox", label: "Proxmox VE" }]}
            onChange={(value) => {
              if (value === "aws" || value === "proxmox") {
                setProvider(value);
                setSshUsername(value === "aws" ? "ubuntu" : "root");
                if (value === "aws") {
                  const profile = preferredAwsProfile(awsProfiles);
                  setAwsAuthentication(profile ? "profile" : "access-keys");
                  setAwsProfileName(profile?.name ?? "");
                  setDefaultRegion(profile?.region ?? "us-east-1");
                }
                setAccessKeyId("");
                setSecretAccessKey("");
                setSessionToken("");
                setTokenId("");
                setTokenSecret("");
                setError(null);
              }
            }}
          />
          <CloudTextField label="Label" placeholder={provider === "aws" ? "Production AWS" : "Lab Proxmox"} value={label} onChange={setLabel} />
          <CloudTextField label="SSH Username" placeholder={provider === "aws" ? "ubuntu" : "root"} value={sshUsername} onChange={setSshUsername} />
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
                : "Store access keys in Cloud Deployment's encrypted credential vault."}
              label="AWS Authentication"
              value={awsAuthentication}
              options={[
                ...(awsProfiles.length > 0 ? [{ value: "profile", label: "AWS CLI profile" }] : []),
                { value: "access-keys", label: "Access keys" },
              ]}
              onChange={(value) => {
                if (value !== "profile" && value !== "access-keys") return;
                setAwsAuthentication(value);
                if (value === "profile") {
                  setAccessKeyId("");
                  setSecretAccessKey("");
                  setSessionToken("");
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
            ) : (
              <div className="self-end rounded-2xl bg-surface-secondary px-4 py-3 text-sm leading-6 text-muted">
                Static, SSO, credential-process, and noninteractive role profiles are resolved by the official AWS SDK. Refresh expired SSO sessions with the AWS CLI; profiles that require an interactive MFA prompt are not supported yet.
              </div>
            )}
            {awsProfileDiscoveryError ? (
              <div className="md:col-span-2">
                <InlineMessage tone="warning" title="AWS profiles unavailable" detail={awsProfileDiscoveryError} />
              </div>
            ) : awsProfiles.length === 0 ? (
              <div className="md:col-span-2">
                <InlineMessage tone="info" title="No local AWS profiles found" detail="Configure an AWS CLI profile or continue with access keys." />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <CloudTextField description="HTTPS API origin, for example https://pve.example.test:8006" label="API Endpoint" placeholder="https://pve.example.test:8006" value={endpoint} onChange={setEndpoint} />
            <CloudTextField autoComplete="off" label="API Token ID" placeholder="user@realm!token" value={tokenId} onChange={setTokenId} />
            <CloudTextField autoComplete="new-password" label="API Token Secret" type="password" value={tokenSecret} onChange={setTokenSecret} />
            <CloudTextArea description="Optional PEM CA certificate for a private PKI." label="TLS CA Certificate" value={tlsCaCertificate} onChange={setTlsCaCertificate} />
          </div>
        )}

        {keySelection ? (
          <CloudTextField autoComplete="new-password" description="Optional. Used once to unlock the selected key." label="SSH Key Passphrase" type="password" value={sshPassphrase} onChange={setSshPassphrase} />
        ) : null}
      </Card.Content>
      <Card.Footer className="flex justify-end gap-2">
        <Button isDisabled={isSaving} variant="tertiary" onPress={onCancel}>Cancel</Button>
        <Button isPending={isSaving} variant="primary" onPress={() => void save()}>Save Credential</Button>
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
  const [pending, setPending] = useState<"test" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<CloudCredentialTestResult | null>(null);

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
          <FontAwesomeIcon aria-hidden icon={credential.provider === "aws" ? faAmazon : faServer} />
        </span>
        <div className="min-w-0 flex-1">
          <Card.Title className="truncate">{credential.label}</Card.Title>
          <Card.Description>
            {credential.provider === "aws"
              ? `${"profileName" in credential ? `AWS CLI · ${credential.profileName}` : "Access keys"} · ${credential.defaultRegion}`
              : credential.endpoint}
          </Card.Description>
        </div>
        <Chip color={credential.persistence === "secure" ? "success" : "warning"} size="sm" variant="soft">
          {credential.persistence === "secure" ? "Encrypted" : "Session"}
        </Chip>
      </Card.Header>
      <Card.Content>
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <DeploymentDetail label="Provider" value={providerLabel(credential.provider)} />
          {credential.provider === "aws" ? (
            <DeploymentDetail
              label="Authentication"
              value={"profileName" in credential ? `CLI profile: ${credential.profileName}` : "Stored access keys"}
            />
          ) : null}
          <DeploymentDetail label="SSH User" value={credential.sshUsername} mono />
          <DeploymentDetail label="Added" value={new Date(credential.createdAt).toLocaleDateString()} />
          <DeploymentDetail label="Credential ID" value={credential.id} mono />
        </dl>
        {testResult ? <CredentialPermissionSummary result={testResult} /> : null}
      </Card.Content>
      <Card.Footer className="flex gap-2">
        <Button aria-label={`Test connection for ${credential.label}`} isPending={pending === "test"} size="sm" variant="outline" onPress={() => void test()}>Test Connection</Button>
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

function CredentialPermissionSummary({ result }: { readonly result: CloudCredentialTestResult }): React.JSX.Element {
  const { missing, required, unverifiable, verified } = result.permissions;
  const issueIds = [...missing, ...unverifiable];
  const labels = new Map(required.map(({ id, label }) => [id, label]));
  const missingIds = new Set(missing);
  const unverifiableIds = new Set(unverifiable);
  const verifiedIds = new Set(verified);
  const tone = missing.length > 0 ? "danger" : unverifiable.length > 0 ? "warning" : "success";
  return (
    <div className={`mt-4 rounded-2xl px-4 py-3 ${feedbackToneClass(tone)}`} role="status">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {missing.length > 0 ? "Permissions missing" : unverifiable.length > 0 ? "Permission review incomplete" : "Permissions verified"}
        </p>
        <span className="text-xs tabular-nums opacity-80">
          {verified.length} verified · {missing.length} missing · {unverifiable.length} unverified
        </span>
      </div>
      {issueIds.length === 0 ? (
        <p className="mt-1 text-xs opacity-80">All required provider capabilities were confirmed.</p>
      ) : null}
      <details className="mt-2 text-xs">
        <summary className="cursor-[var(--cursor-interactive)] font-medium">
          {issueIds.length > 0 ? "Review permission IDs" : `View all ${required.length} required permissions`}
        </summary>
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
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
}): React.JSX.Element {
  return (
    <TextField fullWidth value={value} variant="secondary" onChange={onChange}>
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

function DeploymentDetail({ label, value, mono = false }: { readonly label: string; readonly value: string; readonly mono?: boolean }): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-1 truncate ${mono ? "font-mono text-xs" : "font-medium"}`} title={value}>{value}</dd>
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
      tone: "warning",
      title: "Permission review incomplete",
      detail: `${unverifiable.length} could not be verified safely: ${summarizePermissionIds(unverifiable)}`,
    };
  }
  return { tone: "success", title: "Connection verified", detail: result.summary };
}

function summarizePermissionIds(ids: readonly string[]): string {
  const visible = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${visible}, +${ids.length - 3} more` : visible;
}

function InlineMessage({ tone, title, detail }: Feedback): React.JSX.Element {
  return (
    <div className={`rounded-2xl px-4 py-3 ${feedbackToneClass(tone)}`} role={tone === "danger" ? "alert" : "status"}>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm leading-5 opacity-80">{detail}</p>
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
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
  readonly useElasticIp: boolean;
  readonly aws: AwsDeploymentDraft;
  readonly proxmox: ProxmoxDeploymentDraft;
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
    provider: "proxmox",
    expectedRevision: input.expectedRevision,
    credentialId: input.credentialId,
    name: input.name,
    spec: {
      node: input.proxmox.node.trim(),
      templateVmId: Number(input.proxmox.templateVmId),
      vmId: nullableInteger(input.proxmox.vmId),
      storage: input.proxmox.storage.trim(),
      bridge: input.proxmox.bridge.trim(),
      cores: Number(input.proxmox.cores),
      memoryMiB: Number(input.proxmox.memoryMiB),
      diskGiB: Number(input.proxmox.diskGiB),
      operatorName: input.operatorName,
      sshPort: input.sshPort,
      multiplayerPort: input.multiplayerPort,
      ipConfig: input.proxmox.ipConfig.trim(),
      gateway: nullable(input.proxmox.gateway),
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
    readonly proxmox: ProxmoxDeploymentDraft;
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
  if (step === 1 && values.provider === "proxmox") {
    if (!values.proxmox.node.trim() || !values.proxmox.storage.trim() || !values.proxmox.bridge.trim()) return "Enter the Proxmox node, storage, and network bridge.";
    if (!validInteger(values.proxmox.templateVmId, 100) || !validInteger(values.proxmox.cores, 1) || !validInteger(values.proxmox.memoryMiB, 512) || !validInteger(values.proxmox.diskGiB, 8)) return "Enter valid Proxmox compute values.";
    if (values.proxmox.vmId && !validInteger(values.proxmox.vmId, 100)) return "VM ID must be at least 100 or left blank.";
    if (!validProxmoxIpConfig(values.proxmox.ipConfig.trim())) return "Enter an IPv4 cloud-init configuration such as ip=dhcp or ip=10.0.0.20/24.";
    if (values.proxmox.gateway && !validIpv4Address(values.proxmox.gateway.trim())) return "Enter a valid IPv4 gateway or leave it blank.";
    if (values.proxmox.ipConfig.trim() === "ip=dhcp" && values.proxmox.gateway.trim()) return "A static gateway cannot be used with DHCP.";
    if (values.proxmox.ipConfig.includes(",gw=") && values.proxmox.gateway.trim()) return "Specify the gateway in only one field.";
  }
  if (step === 2) {
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
  readonly awsAuthentication: "profile" | "access-keys";
  readonly awsProfileName: string;
  readonly awsProfiles: readonly AwsCliProfileSummary[];
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly endpoint: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
}): string | null {
  if (!values.label.trim()) return "Enter a credential label.";
  if (!values.sshUsername.trim()) return "Enter the Linux SSH username.";
  if (values.provider === "aws") {
    if (!isAwsRegion(values.defaultRegion.trim())) return "Enter a valid AWS region.";
    if (values.awsAuthentication === "profile") {
      if (!values.awsProfileName || !values.awsProfiles.some(({ name }) => name === values.awsProfileName)) {
        return "Choose an available AWS CLI profile.";
      }
    } else if (values.accessKeyId.trim().length < 16 || !values.secretAccessKey) {
      return "Enter the AWS access key ID and secret access key.";
    }
  } else {
    if (!values.endpoint.startsWith("https://")) return "Enter an HTTPS Proxmox API endpoint.";
    if (!values.tokenId.trim() || !values.tokenSecret) return "Enter the Proxmox API token ID and secret.";
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

function validProxmoxIpConfig(value: string): boolean {
  if (value === "ip=dhcp") return true;
  const match = /^ip=([^/]+)\/(\d{1,2})(?:,gw=([^,]+))?$/u.exec(value);
  return Boolean(
    match &&
    validIpv4Address(match[1] ?? "") &&
    Number(match[2]) <= 32 &&
    (match[3] === undefined || validIpv4Address(match[3])),
  );
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableInteger(value: string): number | null {
  const trimmed = value.trim();
  return trimmed ? Number(trimmed) : null;
}

function validInteger(value: string, minimum: number): boolean {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum;
}

function validPort(value: string): boolean {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

function firstCredentialId(credentials: readonly CloudCredentialSummary[], provider: CloudProvider): string {
  return credentials.find((credential) => credential.provider === provider)?.id ?? "";
}

function preferredAwsProfile(profiles: readonly AwsCliProfileSummary[]): AwsCliProfileSummary | undefined {
  return profiles.find(({ name }) => name === "default") ?? profiles[0];
}

function awsRegion(credential: CloudCredentialSummary | undefined): string {
  return credential?.provider === "aws" ? credential.defaultRegion : "";
}

function providerLabel(provider: CloudProvider): string {
  return provider === "aws" ? "AWS EC2" : "Proxmox VE";
}

function runtimeId(deployment: CloudDeploymentRecord): string {
  if (deployment.provider === "aws") return deployment.runtime.instanceId ?? "Pending";
  return deployment.runtime.vmId === null ? "Pending" : `${deployment.runtime.node}/${deployment.runtime.vmId}`;
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
    "waiting-instance-status": "Waiting for EC2 instance status check",
    "waiting-system-status": "Waiting for EC2 system status check",
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
  for (const key of ["accessKeyId", "secretAccessKey", "sessionToken", "tokenId", "tokenSecret", "tlsCaCertificate", "sshPassphrase", "sshPrivateKeyToken"]) {
    if (Object.hasOwn(mutable, key)) mutable[key] = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Cloud Deployment encountered an unexpected error.";
}

function hasDeploymentSshHost(deployment: CloudDeploymentRecord): boolean {
  const host = deployment.remoteHost ?? (deployment.provider === "aws"
    ? deployment.runtime.publicIpAddress ?? deployment.runtime.privateIpAddress
    : deployment.runtime.ipAddress);
  return Boolean(host?.trim());
}

function deploymentSshUnavailableReason(
  deployment: CloudDeploymentRecord,
  hasSshCredential: boolean,
): string | undefined {
  if (deployment.status === "stopped") return "Start this server before opening SSH.";
  if (deployment.status === "provisioning") return "This server is still being provisioned.";
  if (deployment.status === "deleting") return "This server is being terminated.";
  if (deployment.status === "failed") return "Resolve this server's deployment error before opening SSH.";
  if (!hasSshCredential) return "No stored SSH private key is available for this server.";
  if (!hasDeploymentSshHost(deployment)) return "This server does not have an SSH address yet.";
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
