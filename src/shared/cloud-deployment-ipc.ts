import type {
  AwsCliProfileSummary,
  CloudCredentialSummary,
  CloudDeploymentActionInput,
  CloudDeploymentRecord,
  CloudDeploymentState,
  CreateCloudCredentialInput,
  CreateCloudDeploymentInput,
  UpdateCloudFirewallInput,
} from "./cloud-deployment-contracts.js";
import type { OperationResult } from "./contracts.js";
import type { CloudPermissionEvaluation } from "./cloud-provider-permissions.js";
import type {
  AwsDeploymentOptions,
  DiscoverAwsOptionsInput,
} from "./cloud-provider-inventory.js";
import type { TerminalRuntimeAsset } from "./stream-contracts.js";

export const CLOUD_DEPLOYMENT_IPC_INVOKE = {
  getSnapshot: "sliver:cloud-deployment:snapshot:get",
  getProvisioningTranscripts: "sliver:cloud-deployment:transcripts:get",
  getTerminalRuntime: "sliver:cloud-deployment:terminal-runtime:get",
  detectCurrentEgressIpv4: "sliver:cloud-deployment:egress-ipv4:detect",
  chooseSshPrivateKey: "sliver:cloud-deployment:ssh-key:choose",
  createCredential: "sliver:cloud-deployment:credential:create",
  deleteCredential: "sliver:cloud-deployment:credential:delete",
  testCredential: "sliver:cloud-deployment:credential:test",
  discoverAwsOptions: "sliver:cloud-deployment:aws:options:discover",
  createDeployment: "sliver:cloud-deployment:create",
  runLifecycleAction: "sliver:cloud-deployment:lifecycle",
  updateFirewall: "sliver:cloud-deployment:firewall:update",
  prepareDestroyDeployment: "sliver:cloud-deployment:destroy:prepare",
  executeDestroyDeployment: "sliver:cloud-deployment:destroy:execute",
} as const;

export const CLOUD_DEPLOYMENT_IPC_EVENTS = {
  changed: "sliver:cloud-deployment:changed",
  themeChanged: "sliver:cloud-deployment:theme-changed",
} as const;

export interface CloudDeploymentSnapshot {
  readonly state: CloudDeploymentState;
  readonly credentials: readonly CloudCredentialSummary[];
  readonly secureCredentialStorage: boolean;
  readonly awsProfiles: readonly AwsCliProfileSummary[];
  readonly awsProfileDiscoveryError: string | null;
  /** Session-only, bounded SSH provisioning output. This is never written to disk. */
  readonly provisioningTranscripts: readonly CloudProvisioningTranscript[];
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
  readonly provider: "aws" | "proxmox";
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
  readonly provider: "aws" | "proxmox";
  readonly expiresAt: string;
}

export interface ExecuteDestroyCloudDeploymentInput {
  readonly token: string;
}

export interface CloudDeploymentAPI {
  getSnapshot(): Promise<OperationResult<CloudDeploymentSnapshot>>;
  getProvisioningTranscripts(): Promise<OperationResult<CloudProvisioningTranscriptSnapshot>>;
  getTerminalRuntime(): Promise<OperationResult<TerminalRuntimeAsset>>;
  detectCurrentEgressIpv4(): Promise<OperationResult<CurrentEgressIpv4>>;
  chooseSshPrivateKey(): Promise<OperationResult<SshPrivateKeySelection>>;
  createCredential(input: CreateCloudCredentialInput): Promise<OperationResult<CloudCredentialSummary>>;
  deleteCredential(input: CloudCredentialIdInput): Promise<OperationResult>;
  testCredential(input: CloudCredentialIdInput): Promise<OperationResult<CloudCredentialTestResult>>;
  discoverAwsOptions(input: DiscoverAwsOptionsInput): Promise<OperationResult<AwsDeploymentOptions>>;
  createDeployment(input: CreateCloudDeploymentInput): Promise<OperationResult<CloudDeploymentRecord>>;
  runLifecycleAction(input: CloudDeploymentActionInput): Promise<OperationResult<CloudDeploymentRecord>>;
  updateFirewall(input: UpdateCloudFirewallInput): Promise<OperationResult<CloudDeploymentRecord>>;
  prepareDestroyDeployment(
    input: PrepareDestroyCloudDeploymentInput,
  ): Promise<OperationResult<DestroyCloudDeploymentPlan>>;
  executeDestroyDeployment(
    input: ExecuteDestroyCloudDeploymentInput,
  ): Promise<OperationResult<CloudDeploymentState>>;
  onChanged(listener: (scope: CloudDeploymentChangeScope) => void): () => void;
  onThemeChanged(listener: (dark: boolean) => void): () => void;
}

export type CloudDeploymentInvokeMethod = keyof typeof CLOUD_DEPLOYMENT_IPC_INVOKE;
