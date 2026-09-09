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
  UpdateCloudFirewallRuleInput,
  UpdateCloudFirewallInput,
} from "./cloud-deployment-contracts.js";
import type { OperationResult } from "./contracts.js";
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
  getProvisioningTranscripts: "sliver:cloud-deployment:transcripts:get",
  getTerminalRuntime: "sliver:cloud-deployment:terminal-runtime:get",
  detectCurrentEgressIpv4: "sliver:cloud-deployment:egress-ipv4:detect",
  chooseSshPrivateKey: "sliver:cloud-deployment:ssh-key:choose",
  createCredential: "sliver:cloud-deployment:credential:create",
  loginAwsCredential: "sliver:cloud-deployment:aws:login",
  cancelAwsLogin: "sliver:cloud-deployment:aws:login:cancel",
  beginAzureLogin: "sliver:cloud-deployment:azure:login:begin",
  loginAzureCredential: "sliver:cloud-deployment:azure:login",
  cancelAzureLogin: "sliver:cloud-deployment:azure:login:cancel",
  deleteCredential: "sliver:cloud-deployment:credential:delete",
  testCredential: "sliver:cloud-deployment:credential:test",
  discoverAwsOptions: "sliver:cloud-deployment:aws:options:discover",
  discoverAzureAccounts: "sliver:cloud-deployment:azure:accounts:discover",
  discoverAzureOptions: "sliver:cloud-deployment:azure:options:discover",
  createDeployment: "sliver:cloud-deployment:create",
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
  navigationRequested: "sliver:cloud-deployment:navigation-requested",
  themeChanged: "sliver:cloud-deployment:theme-changed",
} as const;

export type CloudDeploymentNavigationRequest =
  | {
      readonly view: "deployments";
      readonly deploymentId: string;
      readonly action: "start" | "stop" | "terminate" | "ssh";
    }
  | {
      readonly view: "firewall";
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

export interface CloudDeploymentAPI {
  getSnapshot(): Promise<OperationResult<CloudDeploymentSnapshot>>;
  /** Read provider state; passive change notifications continue to use getSnapshot. */
  refreshDeployments(): Promise<OperationResult<CloudDeploymentRefreshResult>>;
  getProvisioningTranscripts(): Promise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): Promise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(): Promise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput): Promise<OperationResult<CloudCredentialSummary>>;
  loginAwsCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialSummary>>;
  cancelAwsLogin(): Promise<OperationResult>;
  beginAzureLogin(input: BeginAzureLoginInput): Promise<OperationResult<AzureLoginSelection>>;
  loginAzureCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialSummary>>;
  cancelAzureLogin(): Promise<OperationResult>;
  deleteCredential(input: CloudCredentialIdInput): Promise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialTestResult>>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): Promise<OperationResult<AwsDeploymentOptions>>;
  discoverAzureAccounts(): Promise<OperationResult<readonly AzureCliAccountSummary[]>>;
  discoverAzureOptions(input: DiscoverAzureOptionsInput): Promise<OperationResult<AzureDeploymentOptions>>;
  createDeployment(input: CreateCloudDeploymentInput): Promise<OperationResult<CloudDeploymentRecord>>;
  runLifecycleAction(input: CloudDeploymentActionInput): Promise<OperationResult<CloudDeploymentRecord>>;
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
  onNavigationRequested(listener: (request: CloudDeploymentNavigationRequest) => void): () => void;
  onThemeChanged(listener: (dark: boolean) => void): () => void;
}

export type CloudDeploymentInvokeMethod = keyof typeof CLOUD_DEPLOYMENT_IPC_INVOKE;
