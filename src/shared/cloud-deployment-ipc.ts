import type {
  CloudDnsZone,
  CloudDnsRecord,
  ListCloudDnsZonesInput,
  ListCloudDnsRecordsInput,
  CreateCloudDnsRecordInput,
  UpdateCloudDnsRecordInput,
  DeleteCloudDnsRecordInput,
} from "./cloud-dns-contracts.js";
import type {
  AwsCliProfileSummary,
  AzureCliAccountSummary,
  BeginAzureLoginInput,
  AzureLoginSelection,
  CloudFirewallSnapshot,
  CloudProvider,
  CloudCredentialSummary,
  CloudDeploymentActionInput,
  CloudDeploymentRecord,
  CloudDeploymentState,
  CreateCloudFirewallRuleInput,
  CreateCloudCredentialInput,
  CreateCloudDeploymentInput,
  DeleteCloudFirewallRuleInput,
  ListCloudFirewallRulesInput,
  RenameCloudDeploymentInput,
  UpdateCloudFirewallRuleInput,
  UpdateCloudFirewallInput,
} from "./cloud-deployment-contracts.js";
import type { OperationResult } from "./contracts.js";
import type {
  InstallLocalRedirectorInput,
  ListLocalRedirectorListenersInput,
  LocalRedirectorListenerOption,
  LocalRedirectorRecord,
  RemoveLocalRedirectorInput,
  SoftwareDeploymentState,
  SoftwareInstallProgress,
  SoftwareInstallProgressSnapshot,
} from "./software-deployment-contracts.js";
import type { CloudPermissionEvaluation } from "./cloud-provider-permissions.js";
import type {
  AwsDeploymentOptions,
  AzureDeploymentOptions,
  DiscoverAwsOptionsInput,
  DiscoverAzureOptionsInput,
} from "./cloud-provider-inventory.js";
import type { TerminalRuntimeAsset } from "./stream-contracts.js";
import type {
  SshDeploymentInput,
  SshHostKeyReviewInput,
  SshOpenTabResult,
} from "./ssh-contracts.js";

export const CLOUD_DEPLOYMENT_IPC_INVOKE = {
  getSnapshot: "sliver:cloud-deployment:snapshot:get",
  refreshDeployments: "sliver:cloud-deployment:status:refresh",
  copyInstanceId: "sliver:cloud-deployment:instance-id:copy",
  copyIpAddress: "sliver:cloud-deployment:ip-address:copy",
  getProvisioningTranscripts: "sliver:cloud-deployment:transcripts:get",
  getTerminalRuntime: "sliver:cloud-deployment:terminal-runtime:get",
  detectCurrentEgressIpv4: "sliver:cloud-deployment:egress-ipv4:detect",
  chooseSshPrivateKey: "sliver:cloud-deployment:ssh-key:choose",
  createCredential: "sliver:cloud-deployment:credential:create",
  openAwsConsole: "sliver:cloud-deployment:aws:console:open",
  loginAwsCredential: "sliver:cloud-deployment:aws:login",
  copyAwsLoginLink: "sliver:cloud-deployment:aws:login:copy-link",
  cancelAwsLogin: "sliver:cloud-deployment:aws:login:cancel",
  beginAzureLogin: "sliver:cloud-deployment:azure:login:begin",
  loginAzureCredential: "sliver:cloud-deployment:azure:login",
  cancelAzureLogin: "sliver:cloud-deployment:azure:login:cancel",
  deleteCredential: "sliver:cloud-deployment:credential:delete",
  testCredential: "sliver:cloud-deployment:credential:test",
  copyAwsPermissionsTerraform: "sliver:cloud-deployment:aws:permissions:copy-terraform",
  discoverAwsOptions: "sliver:cloud-deployment:aws:options:discover",
  discoverAzureAccounts: "sliver:cloud-deployment:azure:accounts:discover",
  discoverAzureOptions: "sliver:cloud-deployment:azure:options:discover",
  listDnsZones: "sliver:cloud-deployment:dns:zones:list",
  listDnsRecords: "sliver:cloud-deployment:dns:records:list",
  createDnsRecord: "sliver:cloud-deployment:dns:record:create",
  updateDnsRecord: "sliver:cloud-deployment:dns:record:update",
  deleteDnsRecord: "sliver:cloud-deployment:dns:record:delete",
  createDeployment: "sliver:cloud-deployment:create",
  getSoftwareState: "sliver:cloud-deployment:software:state",
  getSoftwareInstallProgress: "sliver:cloud-deployment:software:install:progress:get",
  listSoftwareListeners: "sliver:cloud-deployment:software:listeners",
  installLocalRedirector: "sliver:cloud-deployment:software:install",
  removeLocalRedirector: "sliver:cloud-deployment:software:remove",
  renameDeployment: "sliver:cloud-deployment:rename",
  createOperatorConfig: "sliver:cloud-deployment:operator:create",
  runLifecycleAction: "sliver:cloud-deployment:lifecycle",
  updateFirewall: "sliver:cloud-deployment:firewall:update",
  listFirewallRules: "sliver:cloud-deployment:firewall-rules:list",
  createFirewallRule: "sliver:cloud-deployment:firewall-rule:create",
  updateFirewallRule: "sliver:cloud-deployment:firewall-rule:update",
  deleteFirewallRule: "sliver:cloud-deployment:firewall-rule:delete",
  prepareDestroyDeployment: "sliver:cloud-deployment:destroy:prepare",
  executeDestroyDeployment: "sliver:cloud-deployment:destroy:execute",
  openSshWindow: "sliver:cloud-deployment:ssh-window:open",
  approveSshHostKey: "sliver:cloud-deployment:ssh-host-key:approve",
} as const;

export const CLOUD_DEPLOYMENT_IPC_EVENTS = {
  changed: "sliver:cloud-deployment:changed",
  awsLoginProgress: "sliver:cloud-deployment:aws:login:progress",
  softwareInstallProgress: "sliver:cloud-deployment:software:install:progress",
  navigationRequested: "sliver:cloud-deployment:navigation-requested",
  themeChanged: "sliver:cloud-deployment:theme-changed",
} as const;

/** Only observable phases, with no authorization URLs or credential material. */
export interface AwsLoginProgress {
  readonly phase: "opening-browser" | "waiting-for-authorization" | "exchanging-authorization";
}

export interface OpenAwsConsoleInput {
  readonly region: string;
}

export type CloudDeploymentNavigationRequest =
  | {
      readonly view: "deployments";
      readonly deploymentId: string;
      readonly action: "start" | "stop" | "reboot" | "terminate" | "ssh" | "operator" | "rename";
    }
  | {
      readonly view: "firewall";
      readonly deploymentId: string;
    }
  | {
      readonly view: "software";
      readonly deploymentId: string;
    };

export interface CloudDeploymentSnapshot {
  readonly state: CloudDeploymentState;
  readonly refreshErrors: readonly CloudDeploymentRefreshError[];
  readonly credentials: readonly CloudCredentialSummary[];
  readonly secureCredentialStorage: boolean;
  readonly awsProfiles: readonly AwsCliProfileSummary[];
  readonly awsProfileDiscoveryError: string | null;
  readonly azureAccounts: readonly AzureCliAccountSummary[];
  readonly azureAccountDiscoveryError: string | null;
  /** Session-only, bounded SSH provisioning output. This is never written to disk. */
  readonly provisioningTranscripts: readonly CloudProvisioningTranscript[];
}

/** Session-only read failures, separate from persisted operation failures. */
export interface CloudDeploymentRefreshError {
  readonly deploymentId: string;
  readonly message: string;
}

export interface CloudDeploymentRefreshResult {
  readonly state: CloudDeploymentState;
  readonly refreshErrors: readonly CloudDeploymentRefreshError[];
}

export interface CopyCloudInstanceIdInput {
  readonly deploymentId: string;
}

export interface CopyCloudIpAddressInput {
  readonly deploymentId: string;
  readonly kind: "public" | "private";
}

export interface CloudProvisioningTranscriptChunk {
  readonly sequence: number;
  readonly bytes: Uint8Array;
}

export interface CloudProvisioningTranscript {
  readonly deploymentId: string;
  readonly status: "streaming" | "complete" | "failed";
  readonly truncated: boolean;
  readonly chunks: readonly CloudProvisioningTranscriptChunk[];
}

export interface CloudProvisioningTranscriptSnapshot {
  readonly provisioningTranscripts: readonly CloudProvisioningTranscript[];
}

export type CloudDeploymentChangeScope = "snapshot" | "transcripts";

export interface CurrentEgressIpv4 {
  readonly address: string;
  readonly cidr: string;
}

export interface SshPrivateKeySelection {
  readonly token: string;
  readonly fileName: string;
}

export interface CloudCredentialTestResult {
  readonly provider: CloudProvider;
  readonly summary: string;
  readonly permissions: CloudPermissionEvaluation;
}

export interface CloudCredentialIdInput {
  readonly credentialId: string;
}

export interface PrepareDestroyCloudDeploymentInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
}

export interface DestroyCloudDeploymentPlan {
  readonly token: string;
  readonly deploymentId: string;
  readonly deploymentName: string;
  readonly provider: CloudProvider;
  readonly expiresAt: string;
}

export interface ExecuteDestroyCloudDeploymentInput {
  readonly token: string;
}

export interface CreateCloudOperatorConfigInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly operatorName: string;
  readonly publicIp: string;
  readonly port: number;
  readonly permissions: CloudOperatorPermission;
}

export const CLOUD_OPERATOR_PERMISSIONS = ["all", "builder", "crackstation"] as const;
export type CloudOperatorPermission = typeof CLOUD_OPERATOR_PERMISSIONS[number];

export type SaveCloudOperatorConfigResult =
  | {
      readonly saved: true;
      readonly fileName: string;
      readonly mutationState: "created";
    }
  | {
      readonly saved: false;
      readonly fileName: string;
      readonly mutationState: "not-started";
      readonly error?: string;
    }
  | {
      readonly saved: false;
      readonly fileName: string;
      readonly mutationState: "unknown" | "created";
      readonly error: string;
      readonly remoteRecoveryPath?: string;
      readonly remoteRecoveryCandidatePath?: string;
      readonly remoteHandoffCandidatePath?: string;
    };

const CLOUD_OPERATOR_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const CLOUD_OPERATOR_PERMISSION_SET = new Set<string>(CLOUD_OPERATOR_PERMISSIONS);
const CLOUD_DEPLOYMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function parseCreateCloudOperatorConfigInput(
  value: unknown,
): CreateCloudOperatorConfigInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid cloud operator configuration request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 6 ||
    !["deploymentId", "expectedRevision", "operatorName", "publicIp", "port", "permissions"].every((key) => Object.hasOwn(record, key)) ||
    typeof record["deploymentId"] !== "string" ||
    !CLOUD_DEPLOYMENT_ID_PATTERN.test(record["deploymentId"]) ||
    !Number.isSafeInteger(record["expectedRevision"]) ||
    (record["expectedRevision"] as number) < 0 ||
    typeof record["operatorName"] !== "string" ||
    !CLOUD_OPERATOR_NAME_PATTERN.test(record["operatorName"]) ||
    !isCanonicalIpv4Address(record["publicIp"]) ||
    !Number.isSafeInteger(record["port"]) ||
    (record["port"] as number) < 1 ||
    (record["port"] as number) > 65_535 ||
    typeof record["permissions"] !== "string" ||
    !CLOUD_OPERATOR_PERMISSION_SET.has(record["permissions"])
  ) throw new TypeError("Invalid cloud operator configuration request");
  return Object.freeze({
    deploymentId: record["deploymentId"],
    expectedRevision: record["expectedRevision"] as number,
    operatorName: record["operatorName"],
    publicIp: record["publicIp"],
    port: record["port"] as number,
    permissions: record["permissions"] as CloudOperatorPermission,
  });
}

function isCanonicalIpv4Address(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 7 || value.length > 15) return false;
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
}

export interface CloudDeploymentAPI {
  getSnapshot(): Promise<OperationResult<CloudDeploymentSnapshot>>;
  /** Read provider state; passive change notifications continue to use getSnapshot. */
  refreshDeployments(): Promise<OperationResult<CloudDeploymentRefreshResult>>;
  copyInstanceId(input: CopyCloudInstanceIdInput): Promise<OperationResult>;
  copyIpAddress(input: CopyCloudIpAddressInput): Promise<OperationResult>;
  getProvisioningTranscripts(): Promise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): Promise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(): Promise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput): Promise<OperationResult<CloudCredentialSummary>>;
  /** Opens a fixed AWS Console page; success does not establish authentication. */
  openAwsConsole(input: OpenAwsConsoleInput): Promise<OperationResult>;
  loginAwsCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialSummary>>;
  copyAwsLoginLink(): Promise<OperationResult>;
  cancelAwsLogin(): Promise<OperationResult>;
  beginAzureLogin(input: BeginAzureLoginInput): Promise<OperationResult<AzureLoginSelection>>;
  loginAzureCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialSummary>>;
  cancelAzureLogin(): Promise<OperationResult>;
  deleteCredential(input: CloudCredentialIdInput): Promise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialTestResult>>;
  /** Copy the app's required AWS IAM policy as Terraform, without credential data. */
  copyAwsPermissionsTerraform(): Promise<OperationResult>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): Promise<OperationResult<AwsDeploymentOptions>>;
  discoverAzureAccounts(): Promise<OperationResult<readonly AzureCliAccountSummary[]>>;
  discoverAzureOptions(input: DiscoverAzureOptionsInput): Promise<OperationResult<AzureDeploymentOptions>>;
  listDnsZones(input: ListCloudDnsZonesInput): Promise<OperationResult<readonly CloudDnsZone[]>>;
  listDnsRecords(input: ListCloudDnsRecordsInput): Promise<OperationResult<readonly CloudDnsRecord[]>>;
  createDnsRecord(input: CreateCloudDnsRecordInput): Promise<OperationResult>;
  updateDnsRecord(input: UpdateCloudDnsRecordInput): Promise<OperationResult>;
  deleteDnsRecord(input: DeleteCloudDnsRecordInput): Promise<OperationResult>;
  createDeployment(input: CreateCloudDeploymentInput): Promise<OperationResult<CloudDeploymentRecord>>;
  getSoftwareState(): Promise<OperationResult<SoftwareDeploymentState>>;
  getSoftwareInstallProgress(input: ListLocalRedirectorListenersInput): Promise<OperationResult<SoftwareInstallProgressSnapshot | null>>;
  listSoftwareListeners(input: ListLocalRedirectorListenersInput): Promise<OperationResult<readonly LocalRedirectorListenerOption[]>>;
  installLocalRedirector(input: InstallLocalRedirectorInput): Promise<OperationResult<LocalRedirectorRecord>>;
  removeLocalRedirector(input: RemoveLocalRedirectorInput): Promise<OperationResult<SoftwareDeploymentState>>;
  createOperatorConfig(
    input: CreateCloudOperatorConfigInput,
  ): Promise<OperationResult<SaveCloudOperatorConfigResult>>;
  runLifecycleAction(input: CloudDeploymentActionInput): Promise<OperationResult<CloudDeploymentRecord>>;
  renameDeployment(input: RenameCloudDeploymentInput): Promise<OperationResult<CloudDeploymentRecord>>;
  updateFirewall(input: UpdateCloudFirewallInput): Promise<OperationResult<CloudDeploymentRecord>>;
  listFirewallRules(input: ListCloudFirewallRulesInput): Promise<OperationResult<CloudFirewallSnapshot>>;
  createFirewallRule(input: CreateCloudFirewallRuleInput): Promise<OperationResult<CloudFirewallSnapshot>>;
  updateFirewallRule(input: UpdateCloudFirewallRuleInput): Promise<OperationResult<CloudFirewallSnapshot>>;
  deleteFirewallRule(input: DeleteCloudFirewallRuleInput): Promise<OperationResult<CloudFirewallSnapshot>>;
  prepareDestroyDeployment(
    input: PrepareDestroyCloudDeploymentInput,
  ): Promise<OperationResult<DestroyCloudDeploymentPlan>>;
  executeDestroyDeployment(
    input: ExecuteDestroyCloudDeploymentInput,
  ): Promise<OperationResult<CloudDeploymentState>>;
  openSshWindow(input: SshDeploymentInput): Promise<OperationResult<SshOpenTabResult>>;
  approveSshHostKey(input: SshHostKeyReviewInput): Promise<OperationResult<SshOpenTabResult>>;
  onChanged(listener: (scope: CloudDeploymentChangeScope) => void): () => void;
  onAwsLoginProgress?(listener: (progress: AwsLoginProgress | null) => void): () => void;
  onSoftwareInstallProgress(listener: (progress: SoftwareInstallProgress) => void): () => void;
  onNavigationRequested(listener: (request: CloudDeploymentNavigationRequest) => void): () => void;
  onThemeChanged(listener: (dark: boolean) => void): () => void;
}

export type CloudDeploymentInvokeMethod = keyof typeof CLOUD_DEPLOYMENT_IPC_INVOKE;
