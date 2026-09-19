export const CLOUD_DEPLOYMENT_STATE_VERSION = 1 as const;

export const CLOUD_DEPLOYMENT_ACTIONS = ["start", "stop", "reboot"] as const;
export const CLOUD_DEPLOYMENT_STATUSES = [
  "provisioning",
  "running",
  "stopped",
  "failed",
  "deleting",
] as const;
export const CLOUD_DEPLOYMENT_PHASES = [
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
  "stopped",
  "failed",
  "deleting",
] as const;

export const CLOUD_CREDENTIAL_LABEL_MAX_LENGTH = 120;
export const AWS_CLI_PROFILE_NAME_MAX_LENGTH = 256;
export const AZURE_LOCATION_MAX_LENGTH = 64;
export const AZURE_SSH_PORT = 22 as const;
export const AWS_SUPPORTED_INSTANCE_TYPES = [
  "t3.micro",
  "t3.small",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "t4g.micro",
  "t4g.small",
  "t4g.medium",
  "t4g.large",
  "t4g.xlarge",
] as const;
export const CLOUD_DEPLOYMENT_NAME_MAX_LENGTH = 120;
export const CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH = 1024 * 1024;
export const CLOUD_INGRESS_CIDR_MAX_ITEMS = 32;
export const AZURE_FIREWALL_RULE_MAX_VALUES = 1_000;

export type CloudProvider = "aws" | "azure";
export type CloudCredentialPersistence = "secure" | "session";
export type CloudDeploymentAction = (typeof CLOUD_DEPLOYMENT_ACTIONS)[number];
export type CloudDeploymentStatus = (typeof CLOUD_DEPLOYMENT_STATUSES)[number];
export type CloudDeploymentPhase = (typeof CLOUD_DEPLOYMENT_PHASES)[number];
export type AwsNetworkMode = "existing" | "managed";
export type AwsSshKeyMode = "managed" | "existing";
export type AwsSupportedInstanceType = (typeof AWS_SUPPORTED_INSTANCE_TYPES)[number];
export type AwsDeploymentInstanceState =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped"
  | "unknown";
export type AwsDeploymentHealth = "ok" | "impaired" | "initializing" | "unknown";
export type AwsFirewallDirection = "ingress" | "egress";
export type AwsFirewallPeerType = "ipv4" | "ipv6" | "prefix-list" | "security-group";
export type AzureNetworkMode = "existing" | "managed";
export type AzureDeploymentInstanceState =
  | "creating"
  | "running"
  | "deallocated"
  | "deallocating"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";
export type AzureFirewallDirection = "ingress" | "egress";
export type AzureFirewallAccess = "allow" | "deny";
export type AzureFirewallProtocol = "*" | "tcp" | "udp" | "icmp" | "ah" | "esp";

export interface AwsAccessKeyCredentialSecret {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | null;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

/** Main-process session material. Never include this object in renderer messages. */
export interface AwsConsoleLoginSession {
  readonly loginSessionArn: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly refreshToken: string;
  readonly privateKey: string;
}

export interface AwsLoginCredentialSecret {
  readonly loginSession: AwsConsoleLoginSession;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export interface AwsProfileCredentialSecret {
  readonly profileName: string;
  readonly loginSession?: AwsConsoleLoginSession;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export type AwsCredentialSecret = AwsAccessKeyCredentialSecret | AwsProfileCredentialSecret | AwsLoginCredentialSecret;

/** Main-process MSAL cache and pinned account identity. Never expose this through IPC. */
export interface AzureBrowserLoginSession {
  readonly clientId: string;
  readonly homeAccountId: string;
  readonly localAccountId: string;
  readonly tenantId: string;
  readonly username: string;
  readonly cache: string;
}

export interface AzureCliCredentialSecret {
  readonly authentication?: "login";
  readonly loginSession?: AzureBrowserLoginSession;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export interface AzureLoginCredentialSecret extends AzureCliCredentialSecret {
  readonly authentication: "login";
  readonly loginSession: AzureBrowserLoginSession;
}

export type CloudCredentialSecret = AwsCredentialSecret | AzureCliCredentialSecret;

/** Renderer-safe AWS credential input. A null token requests main-process key generation. */
export interface CreateAwsAccessKeyCloudCredentialInput {
  readonly provider: "aws";
  readonly label: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
  readonly sshPrivateKeyToken: string | null;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | null;
  readonly sshPassphrase: string | null;
}

/** Renderer-safe AWS profile input. AWS secrets stay shared; a null key token requests generation. */
export interface CreateAwsProfileCloudCredentialInput {
  readonly provider: "aws";
  readonly label: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
  readonly sshPrivateKeyToken: string | null;
  readonly profileName: string;
  readonly sshPassphrase: string | null;
}

/** Renderer-safe request to authenticate through the AWS console in a browser. */
export interface CreateAwsLoginCloudCredentialInput {
  readonly provider: "aws";
  readonly authentication: "login";
  readonly label: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
  readonly sshPrivateKeyToken: string | null;
  readonly sshPassphrase: string | null;
}

export type CreateAwsCloudCredentialInput =
  | CreateAwsAccessKeyCloudCredentialInput
  | CreateAwsProfileCloudCredentialInput
  | CreateAwsLoginCloudCredentialInput;

/** Renderer-safe Azure CLI credential input. Tokens remain in the Azure CLI cache. */
export interface CreateAzureCliCloudCredentialInput {
  readonly provider: "azure";
  readonly label: string;
  readonly defaultLocation: string;
  readonly sshUsername: string;
  readonly sshPrivateKeyToken: string | null;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly sshPassphrase: string | null;
}

export interface CreateAzureLoginCloudCredentialInput extends CreateAzureCliCloudCredentialInput {
  readonly authentication: "login";
  readonly loginToken: string;
}

export type CreateAzureCloudCredentialInput = CreateAzureCliCloudCredentialInput | CreateAzureLoginCloudCredentialInput;

export interface BeginAzureLoginInput {
  readonly tenantId: string | null;
  readonly clientId: string | null;
}

export interface AzureLoginSelection {
  readonly token: string;
  readonly expiresAt: string;
  readonly subscriptions: readonly AzureCliAccountSummary[];
}

export type CreateCloudCredentialInput =
  | CreateAwsCloudCredentialInput
  | CreateAzureCloudCredentialInput;

/** Main-process input after resolving an imported or generated SSH private key. */
export interface ResolvedAwsCloudCredentialInput {
  readonly provider: "aws";
  readonly label: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
  readonly secret: AwsCredentialSecret;
}

/** Main-process input after resolving an imported or generated SSH private key. */
export interface ResolvedAzureCloudCredentialInput {
  readonly provider: "azure";
  readonly label: string;
  readonly defaultLocation: string;
  readonly sshUsername: string;
  readonly secret: AzureCliCredentialSecret;
}

export type ResolvedCloudCredentialInput =
  | ResolvedAwsCloudCredentialInput
  | ResolvedAzureCloudCredentialInput;

interface AwsCloudCredentialSummaryBase {
  readonly id: string;
  readonly provider: "aws";
  readonly label: string;
  readonly persistence: CloudCredentialPersistence;
  readonly createdAt: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
}

export interface AwsAccessKeyCloudCredentialSummary extends AwsCloudCredentialSummaryBase {}

export interface AwsProfileCloudCredentialSummary extends AwsCloudCredentialSummaryBase {
  readonly profileName: string;
  readonly loginSessionArn?: string;
}

export interface AwsLoginCloudCredentialSummary extends AwsCloudCredentialSummaryBase {
  readonly loginSessionArn: string;
}

export type AwsCloudCredentialSummary =
  | AwsAccessKeyCloudCredentialSummary
  | AwsProfileCloudCredentialSummary
  | AwsLoginCloudCredentialSummary;

export interface AzureCloudCredentialSummary {
  readonly authentication?: "login";
  readonly loginAccountId?: string;
  readonly id: string;
  readonly provider: "azure";
  readonly label: string;
  readonly persistence: CloudCredentialPersistence;
  readonly createdAt: string;
  readonly defaultLocation: string;
  readonly subscriptionId: string;
  readonly tenantId: string;
  readonly sshUsername: string;
}

export type CloudCredentialSummary = AwsCloudCredentialSummary | AzureCloudCredentialSummary;

/** Non-secret metadata discovered from the local AWS shared configuration files. */
export interface AwsCliProfileSummary {
  readonly name: string;
  readonly region: string | null;
}

/** Non-secret subscription metadata discovered from the local Azure CLI. */
export interface AzureCliAccountSummary {
  readonly subscriptionId: string;
  readonly name: string;
  readonly tenantId: string;
  readonly homeTenantId: string | null;
  readonly isDefault: boolean;
  readonly cloudName: string;
}

export interface AwsDeploymentSpec {
  readonly region: string;
  readonly imageId: string;
  readonly instanceType: string;
  readonly subnetId: string | null;
  readonly vpcId: string | null;
  /** Explicit for new records; legacy v1 records are normalized to existing-network mode. */
  readonly networkMode: AwsNetworkMode;
  readonly managedVpcCidr: string | null;
  readonly managedSubnetCidr: string | null;
  /** Explicit for new records; legacy v1 records are normalized to a managed credential key. */
  readonly sshKeyMode: AwsSshKeyMode;
  readonly existingKeyPairName: string | null;
  /** Per-image SSH login; null preserves the credential default for legacy records. */
  readonly sshUsername: string | null;
  /** @deprecated Retained in v1 state for on-disk compatibility. */
  readonly keyPairName: string;
  readonly operatorName: string;
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly volumeSizeGiB: number | null;
  readonly useElasticIp: boolean;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
}

export interface AzureDeploymentSpec {
  readonly location: string;
  readonly imageReference: string;
  readonly vmSize: string;
  readonly networkMode: AzureNetworkMode;
  readonly vnetId: string | null;
  readonly subnetId: string | null;
  readonly managedVnetCidr: string | null;
  readonly managedSubnetCidr: string | null;
  readonly sshUsername: string;
  readonly operatorName: string;
  readonly sshPort: typeof AZURE_SSH_PORT;
  readonly multiplayerPort: number;
  readonly osDiskSizeGiB: number | null;
  readonly usePublicIp: boolean;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
}

export interface CreateAwsCloudDeploymentInput {
  readonly provider: "aws";
  readonly expectedRevision: number;
  readonly credentialId: string;
  readonly name: string;
  readonly spec: AwsDeploymentSpec;
}

export interface CreateAzureCloudDeploymentInput {
  readonly provider: "azure";
  readonly expectedRevision: number;
  readonly credentialId: string;
  readonly name: string;
  readonly spec: AzureDeploymentSpec;
}

export type CreateCloudDeploymentInput =
  | CreateAwsCloudDeploymentInput
  | CreateAzureCloudDeploymentInput;

export type AwsManagedAssetType =
  | "ec2-instance"
  | "ec2-volume"
  | "ec2-network-interface"
  | "ec2-security-group"
  | "ec2-key-pair"
  | "ec2-elastic-ip"
  | "ec2-vpc"
  | "ec2-subnet"
  | "ec2-internet-gateway"
  | "ec2-route-table"
  | "ec2-route-table-association";
export type AzureManagedAssetType =
  | "azure-resource-group"
  | "azure-virtual-network"
  | "azure-subnet"
  | "azure-network-security-group"
  | "azure-public-ip"
  | "azure-network-interface"
  | "azure-os-disk"
  | "azure-virtual-machine";

export interface CloudManagedAsset {
  readonly resourceType: AwsManagedAssetType | AzureManagedAssetType;
  readonly resourceId: string;
  readonly displayName: string | null;
  readonly tagged: boolean;
}

export interface AwsDeploymentRuntime {
  readonly instanceId: string | null;
  readonly instanceState: AwsDeploymentInstanceState;
  readonly instanceHealth: AwsDeploymentHealth;
  readonly systemHealth: AwsDeploymentHealth;
  readonly securityGroupIds: readonly string[];
  readonly volumeIds: readonly string[];
  readonly networkInterfaceIds: readonly string[];
  readonly publicIpAddress: string | null;
  readonly privateIpAddress: string | null;
  readonly availabilityZone: string | null;
  readonly elasticIpAllocationId: string | null;
  readonly vpcId: string | null;
  readonly subnetId: string | null;
  readonly internetGatewayId: string | null;
  readonly routeTableId: string | null;
  readonly routeTableAssociationId: string | null;
}

export interface AzureDeploymentRuntime {
  readonly resourceGroupName: string | null;
  readonly vmName: string | null;
  readonly vmId: string | null;
  readonly instanceState: AzureDeploymentInstanceState;
  readonly provisioningState: string | null;
  readonly networkSecurityGroupId: string | null;
  readonly networkInterfaceId: string | null;
  readonly osDiskId: string | null;
  readonly publicIpAddressId: string | null;
  readonly publicIpAddress: string | null;
  readonly privateIpAddress: string | null;
  readonly vnetId: string | null;
  readonly subnetId: string | null;
}

interface CloudDeploymentRecordBase {
  /** Stable UUIDv4 used as the local identity and provider management tag value. */
  readonly id: string;
  readonly name: string;
  readonly credentialId: string;
  readonly status: CloudDeploymentStatus;
  readonly phase: CloudDeploymentPhase;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly operatorConfigFileName: string | null;
  readonly operatorConfigDigest: string | null;
  readonly remoteHost: string | null;
  readonly lastError: string | null;
  readonly managedAssets: readonly CloudManagedAsset[];
}

export interface AwsCloudDeploymentRecord extends CloudDeploymentRecordBase {
  readonly provider: "aws";
  readonly spec: AwsDeploymentSpec;
  readonly runtime: AwsDeploymentRuntime;
}

export interface AzureCloudDeploymentRecord extends CloudDeploymentRecordBase {
  readonly provider: "azure";
  readonly spec: AzureDeploymentSpec;
  readonly runtime: AzureDeploymentRuntime;
}

export type CloudDeploymentRecord = AwsCloudDeploymentRecord | AzureCloudDeploymentRecord;

export interface CloudDeploymentState {
  readonly v: typeof CLOUD_DEPLOYMENT_STATE_VERSION;
  readonly revision: number;
  readonly deployments: readonly CloudDeploymentRecord[];
}

export interface UpdateCloudDeploymentInput {
  readonly expectedRevision: number;
  readonly deployment: CloudDeploymentRecord;
}

export interface DeleteCloudDeploymentInput {
  readonly expectedRevision: number;
  readonly deploymentId: string;
}

export interface CloudDeploymentActionInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly action: CloudDeploymentAction;
}

export interface RenameCloudDeploymentInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly name: string;
}

export interface UpdateCloudFirewallInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly sshCidrs: readonly string[];
  readonly operatorCidrs: readonly string[];
}

export interface AwsFirewallRuleSpec {
  readonly direction: AwsFirewallDirection;
  readonly protocol: string;
  readonly fromPort: number | null;
  readonly toPort: number | null;
  readonly peerType: AwsFirewallPeerType;
  readonly peer: string;
  readonly description: string | null;
}

export interface AwsFirewallRule extends AwsFirewallRuleSpec {
  readonly id: string;
  readonly managed: boolean;
}

export interface AwsFirewallSnapshot {
  readonly provider: "aws";
  readonly securityGroupId: string;
  readonly securityGroupName: string | null;
  readonly vpcId: string | null;
  readonly rules: readonly AwsFirewallRule[];
}

export interface AzureFirewallRuleSpec {
  readonly name: string;
  readonly priority: number;
  readonly direction: AzureFirewallDirection;
  readonly access: AzureFirewallAccess;
  readonly protocol: AzureFirewallProtocol;
  readonly sourceAddressPrefixes: readonly string[];
  readonly sourcePortRanges: readonly string[];
  readonly destinationAddressPrefixes: readonly string[];
  readonly destinationPortRanges: readonly string[];
  readonly description: string | null;
}

export interface AzureFirewallRule extends AzureFirewallRuleSpec {
  readonly id: string;
  readonly managed: boolean;
  readonly isDefault: boolean;
  /** ASG references are preserved for display but are not editable by this client. */
  readonly sourceApplicationSecurityGroupIds: readonly string[];
  readonly destinationApplicationSecurityGroupIds: readonly string[];
  readonly editUnsupportedReason: string | null;
}

export interface AzureFirewallSnapshot {
  readonly provider: "azure";
  readonly networkSecurityGroupId: string;
  readonly networkSecurityGroupName: string | null;
  readonly resourceGroupName: string;
  readonly rules: readonly AzureFirewallRule[];
}

export type CloudFirewallRuleSpec = AwsFirewallRuleSpec | AzureFirewallRuleSpec;
export type CloudFirewallRule = AwsFirewallRule | AzureFirewallRule;
export type CloudFirewallSnapshot = AwsFirewallSnapshot | AzureFirewallSnapshot;

export interface ListCloudFirewallRulesInput {
  readonly deploymentId: string;
}

export interface CreateCloudFirewallRuleInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly rule: CloudFirewallRuleSpec;
}

export interface UpdateCloudFirewallRuleInput extends CreateCloudFirewallRuleInput {
  readonly ruleId: string;
}

export interface DeleteCloudFirewallRuleInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly ruleId: string;
}

/** @deprecated Use the provider-neutral aliases. */
export type ListAwsFirewallRulesInput = ListCloudFirewallRulesInput;
/** @deprecated Use the provider-neutral aliases. */
export type CreateAwsFirewallRuleInput = CreateCloudFirewallRuleInput;
/** @deprecated Use the provider-neutral aliases. */
export type UpdateAwsFirewallRuleInput = UpdateCloudFirewallRuleInput;
/** @deprecated Use the provider-neutral aliases. */
export type DeleteAwsFirewallRuleInput = DeleteCloudFirewallRuleInput;

const AWS_ACCESS_KEY_SECRET_KEYS = ["accessKeyId", "secretAccessKey", "sessionToken", "sshPrivateKey", "sshPassphrase"] as const;
const AWS_PROFILE_SECRET_KEYS = ["profileName", "sshPrivateKey", "sshPassphrase"] as const;
const AWS_PROFILE_LOGIN_SECRET_KEYS = [...AWS_PROFILE_SECRET_KEYS, "loginSession"] as const;
const AWS_LOGIN_SECRET_KEYS = ["loginSession", "sshPrivateKey", "sshPassphrase"] as const;
const AWS_LOGIN_SESSION_KEYS = ["loginSessionArn", "region", "accessKeyId", "secretAccessKey", "sessionToken", "expiresAt", "refreshToken", "privateKey"] as const;
const AZURE_CLI_SECRET_KEYS = ["subscriptionId", "tenantId", "sshPrivateKey", "sshPassphrase"] as const;
const AZURE_CLI_LOGIN_SECRET_KEYS = [...AZURE_CLI_SECRET_KEYS, "loginSession"] as const;
const AZURE_LOGIN_SECRET_KEYS = [...AZURE_CLI_LOGIN_SECRET_KEYS, "authentication"] as const;
const AZURE_LOGIN_SESSION_KEYS = ["clientId", "homeAccountId", "localAccountId", "tenantId", "username", "cache"] as const;
const BEGIN_AZURE_LOGIN_KEYS = ["tenantId", "clientId"] as const;
const CREATE_AWS_ACCESS_KEY_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "sshPrivateKeyToken", "accessKeyId", "secretAccessKey", "sessionToken", "sshPassphrase"] as const;
const CREATE_AWS_LOGIN_CREDENTIAL_KEYS = ["provider", "authentication", "label", "defaultRegion", "sshUsername", "sshPrivateKeyToken", "sshPassphrase"] as const;
const CREATE_AWS_PROFILE_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "sshPrivateKeyToken", "profileName", "sshPassphrase"] as const;
const CREATE_AZURE_CLI_CREDENTIAL_KEYS = ["provider", "label", "defaultLocation", "sshUsername", "sshPrivateKeyToken", "subscriptionId", "tenantId", "sshPassphrase"] as const;
const CREATE_AZURE_LOGIN_CREDENTIAL_KEYS = [...CREATE_AZURE_CLI_CREDENTIAL_KEYS, "authentication", "loginToken"] as const;
const RESOLVED_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "secret"] as const;
const RESOLVED_AZURE_CREDENTIAL_KEYS = ["provider", "label", "defaultLocation", "sshUsername", "secret"] as const;
const AWS_ACCESS_KEY_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "defaultRegion", "sshUsername"] as const;
const AWS_PROFILE_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "defaultRegion", "sshUsername", "profileName"] as const;
const AWS_PROFILE_LOGIN_SUMMARY_KEYS = [...AWS_PROFILE_SUMMARY_KEYS, "loginSessionArn"] as const;
const AWS_LOGIN_SUMMARY_KEYS = [...AWS_ACCESS_KEY_SUMMARY_KEYS, "loginSessionArn"] as const;
const AZURE_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "defaultLocation", "subscriptionId", "tenantId", "sshUsername"] as const;
const AZURE_CLI_LOGIN_SUMMARY_KEYS = [...AZURE_SUMMARY_KEYS, "loginAccountId"] as const;
const AZURE_LOGIN_SUMMARY_KEYS = [...AZURE_CLI_LOGIN_SUMMARY_KEYS, "authentication"] as const;
const AZURE_CLI_ACCOUNT_KEYS = ["subscriptionId", "name", "tenantId", "homeTenantId", "isDefault", "cloudName"] as const;
const LEGACY_AWS_SPEC_KEYS = ["region", "imageId", "instanceType", "subnetId", "vpcId", "keyPairName", "operatorName", "sshPort", "multiplayerPort", "volumeSizeGiB", "useElasticIp", "sshCidrs", "operatorCidrs"] as const;
const AWS_SPEC_KEYS = ["region", "imageId", "instanceType", "subnetId", "vpcId", "networkMode", "managedVpcCidr", "managedSubnetCidr", "sshKeyMode", "existingKeyPairName", "sshUsername", "keyPairName", "operatorName", "sshPort", "multiplayerPort", "volumeSizeGiB", "useElasticIp", "sshCidrs", "operatorCidrs"] as const;
const AZURE_SPEC_KEYS = ["location", "imageReference", "vmSize", "networkMode", "vnetId", "subnetId", "managedVnetCidr", "managedSubnetCidr", "sshUsername", "operatorName", "sshPort", "multiplayerPort", "osDiskSizeGiB", "usePublicIp", "sshCidrs", "operatorCidrs"] as const;
const CREATE_DEPLOYMENT_KEYS = ["provider", "expectedRevision", "credentialId", "name", "spec"] as const;
const ASSET_KEYS = ["resourceType", "resourceId", "displayName", "tagged"] as const;
const RECORD_KEYS = ["id", "name", "credentialId", "status", "phase", "createdAt", "updatedAt", "operatorConfigFileName", "operatorConfigDigest", "remoteHost", "lastError", "managedAssets", "provider", "spec", "runtime"] as const;
const LEGACY_AWS_RUNTIME_KEYS = ["instanceId", "securityGroupIds", "volumeIds", "networkInterfaceIds", "publicIpAddress", "privateIpAddress", "availabilityZone", "elasticIpAllocationId"] as const;
const AWS_RUNTIME_KEYS = ["instanceId", "securityGroupIds", "volumeIds", "networkInterfaceIds", "publicIpAddress", "privateIpAddress", "availabilityZone", "elasticIpAllocationId", "vpcId", "subnetId", "internetGatewayId", "routeTableId", "routeTableAssociationId"] as const;
const AWS_RUNTIME_WITH_STATUS_KEYS = [...AWS_RUNTIME_KEYS, "instanceState", "instanceHealth", "systemHealth"] as const;
const AZURE_RUNTIME_KEYS = ["resourceGroupName", "vmName", "vmId", "instanceState", "provisioningState", "networkSecurityGroupId", "networkInterfaceId", "osDiskId", "publicIpAddressId", "publicIpAddress", "privateIpAddress", "vnetId", "subnetId"] as const;
const STATE_KEYS = ["v", "revision", "deployments"] as const;
const UPDATE_KEYS = ["expectedRevision", "deployment"] as const;
const DELETE_KEYS = ["expectedRevision", "deploymentId"] as const;
const ACTION_KEYS = ["deploymentId", "expectedRevision", "action"] as const;
const RENAME_DEPLOYMENT_KEYS = ["deploymentId", "expectedRevision", "name"] as const;
const FIREWALL_KEYS = ["deploymentId", "expectedRevision", "sshCidrs", "operatorCidrs"] as const;
const AWS_FIREWALL_RULE_KEYS = ["direction", "protocol", "fromPort", "toPort", "peerType", "peer", "description"] as const;
const AZURE_FIREWALL_RULE_KEYS = ["name", "priority", "direction", "access", "protocol", "sourceAddressPrefixes", "sourcePortRanges", "destinationAddressPrefixes", "destinationPortRanges", "description"] as const;
const LIST_AWS_FIREWALL_RULES_KEYS = ["deploymentId"] as const;
const CREATE_AWS_FIREWALL_RULE_KEYS = ["deploymentId", "expectedRevision", "rule"] as const;
const UPDATE_AWS_FIREWALL_RULE_KEYS = ["deploymentId", "expectedRevision", "rule", "ruleId"] as const;
const DELETE_AWS_FIREWALL_RULE_KEYS = ["deploymentId", "expectedRevision", "ruleId"] as const;

const CREDENTIAL_PERSISTENCE = new Set<CloudCredentialPersistence>(["secure", "session"]);
const DEPLOYMENT_ACTIONS = new Set<CloudDeploymentAction>(CLOUD_DEPLOYMENT_ACTIONS);
const DEPLOYMENT_STATUSES = new Set<CloudDeploymentStatus>(CLOUD_DEPLOYMENT_STATUSES);
const DEPLOYMENT_PHASES = new Set<CloudDeploymentPhase>(CLOUD_DEPLOYMENT_PHASES);
const AWS_INSTANCE_STATES = new Set<AwsDeploymentInstanceState>(["pending", "running", "shutting-down", "terminated", "stopping", "stopped", "unknown"]);
const AWS_HEALTH_VALUES = new Set<AwsDeploymentHealth>(["ok", "impaired", "initializing", "unknown"]);
const AWS_FIREWALL_DIRECTIONS = new Set<AwsFirewallDirection>(["ingress", "egress"]);
const AWS_FIREWALL_PEER_TYPES = new Set<AwsFirewallPeerType>(["ipv4", "ipv6", "prefix-list", "security-group"]);
const AZURE_INSTANCE_STATES = new Set<AzureDeploymentInstanceState>(["creating", "running", "deallocated", "deallocating", "starting", "stopping", "stopped", "failed", "unknown"]);
const AZURE_FIREWALL_DIRECTIONS = new Set<AzureFirewallDirection>(["ingress", "egress"]);
const AZURE_FIREWALL_ACCESS = new Set<AzureFirewallAccess>(["allow", "deny"]);
const AZURE_FIREWALL_PROTOCOLS = new Set<AzureFirewallProtocol>(["*", "tcp", "udp", "icmp", "ah", "esp"]);
const AZURE_RESERVED_SSH_USERNAMES = new Set([
  "1", "123", "a", "actuser", "adm", "admin", "admin1", "admin2", "administrator",
  "aspnet", "backup", "console", "david", "guest", "john", "owner", "root", "server",
  "sql", "support_388945a0", "support", "sys", "test", "test1", "test2", "test3",
  "user", "user1", "user2", "user3", "user4", "user5", "video",
]);
const AWS_ASSET_TYPES = new Set<AwsManagedAssetType>(["ec2-instance", "ec2-volume", "ec2-network-interface", "ec2-security-group", "ec2-key-pair", "ec2-elastic-ip", "ec2-vpc", "ec2-subnet", "ec2-internet-gateway", "ec2-route-table", "ec2-route-table-association"]);
const AZURE_ASSET_TYPES = new Set<AzureManagedAssetType>(["azure-resource-group", "azure-virtual-network", "azure-subnet", "azure-network-security-group", "azure-public-ip", "azure-network-interface", "azure-os-disk", "azure-virtual-machine"]);

export function isAwsLoginSessionArn(value: unknown): value is string {
  return boundedPattern(value, 20, 2_048, /^arn:(aws|aws-cn|aws-us-gov):(iam|sts)::[0-9]{12}:[A-Za-z0-9_+=,.@:/-]+$/u);
}

export function parseAwsConsoleLoginSession(value: unknown): AwsConsoleLoginSession {
  if (!hasExactKeys(value, AWS_LOGIN_SESSION_KEYS) ||
    !isAwsLoginSessionArn(value["loginSessionArn"]) || !isAwsRegion(value["region"]) ||
    !boundedSecret(value["accessKeyId"], 16, 256) || !boundedSecret(value["secretAccessKey"], 1, 16_384) ||
    !boundedSecret(value["sessionToken"], 1, 32_768) || !isIsoTimestamp(value["expiresAt"]) ||
    !boundedSecret(value["refreshToken"], 1, 2_048) || !boundedSecret(value["privateKey"], 32, 8_192) || !/^-----BEGIN (?:EC )?PRIVATE KEY-----/u.test(value["privateKey"])) {
    throw invalid("AWS login session");
  }
  return Object.freeze({ loginSessionArn: value["loginSessionArn"], region: value["region"],
    accessKeyId: value["accessKeyId"], secretAccessKey: value["secretAccessKey"], sessionToken: value["sessionToken"],
    expiresAt: value["expiresAt"], refreshToken: value["refreshToken"], privateKey: value["privateKey"] });
}

export function parseAwsCredentialSecret(value: unknown): AwsCredentialSecret {
  if (hasExactKeys(value, AWS_PROFILE_SECRET_KEYS) || hasExactKeys(value, AWS_PROFILE_LOGIN_SECRET_KEYS)) {
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    if (
      !isAwsProfileName(value["profileName"]) ||
      !isSshPrivateKey(value["sshPrivateKey"]) ||
      sshPassphrase === undefined
    ) throw invalid("AWS profile credential secret");
    return Object.freeze({
      profileName: value["profileName"],
      ...("loginSession" in value ? { loginSession: parseAwsConsoleLoginSession(value["loginSession"]) } : {}),
      sshPrivateKey: value["sshPrivateKey"],
      sshPassphrase,
    });
  }
  if (hasExactKeys(value, AWS_LOGIN_SECRET_KEYS)) {
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    if (!isSshPrivateKey(value["sshPrivateKey"]) || sshPassphrase === undefined) throw invalid("AWS login credential secret");
    return Object.freeze({ loginSession: parseAwsConsoleLoginSession(value["loginSession"]), sshPrivateKey: value["sshPrivateKey"], sshPassphrase });
  }
  if (hasExactKeys(value, AWS_ACCESS_KEY_SECRET_KEYS)) {
    const sessionToken = nullableSecret(value["sessionToken"], 16_384);
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    if (
      !boundedSecret(value["accessKeyId"], 16, 256) ||
      !boundedSecret(value["secretAccessKey"], 1, 16_384) ||
      sessionToken === undefined ||
      !isSshPrivateKey(value["sshPrivateKey"]) ||
      sshPassphrase === undefined
    ) throw invalid("AWS access-key credential secret");
    return Object.freeze({
      accessKeyId: value["accessKeyId"],
      secretAccessKey: value["secretAccessKey"],
      sessionToken,
      sshPrivateKey: value["sshPrivateKey"],
      sshPassphrase,
    });
  }
  throw invalid("AWS credential secret");
}

export function parseAzureBrowserLoginSession(value: unknown): AzureBrowserLoginSession {
  if (!hasExactKeys(value, AZURE_LOGIN_SESSION_KEYS) || !isUuid(value["clientId"]) || !isUuid(value["tenantId"]) ||
    !boundedPlain(value["homeAccountId"], 1, 1_024) || !boundedPlain(value["localAccountId"], 1, 1_024) ||
    !boundedPlain(value["username"], 0, 512) || !boundedSecret(value["cache"], 2, 1024 * 1024)) throw invalid("Azure login session");
  try {
    if (!isRecord(JSON.parse(value["cache"]) as unknown)) throw invalid("Azure login cache");
  } catch { throw invalid("Azure login cache"); }
  return Object.freeze({ clientId: value["clientId"], homeAccountId: value["homeAccountId"], localAccountId: value["localAccountId"],
    tenantId: value["tenantId"], username: value["username"], cache: value["cache"] });
}

export function parseBeginAzureLoginInput(value: unknown): BeginAzureLoginInput {
  if (!hasExactKeys(value, BEGIN_AZURE_LOGIN_KEYS) || (value["tenantId"] !== null && !isUuid(value["tenantId"])) ||
    (value["clientId"] !== null && !isUuid(value["clientId"]))) throw invalid("Azure login request");
  return Object.freeze({ tenantId: value["tenantId"], clientId: value["clientId"] });
}

export function parseAzureCliCredentialSecret(value: unknown): AzureCliCredentialSecret {
  if (!hasExactKeys(value, AZURE_CLI_SECRET_KEYS) && !hasExactKeys(value, AZURE_CLI_LOGIN_SECRET_KEYS) &&
    !hasExactKeys(value, AZURE_LOGIN_SECRET_KEYS)) throw invalid("Azure credential secret");
  if ("authentication" in value && value["authentication"] !== "login") throw invalid("Azure credential authentication");
  const loginSession = "loginSession" in value ? parseAzureBrowserLoginSession(value["loginSession"]) : undefined;
  if (loginSession && loginSession.tenantId.toLowerCase() !== String(value["tenantId"]).toLowerCase()) throw invalid("Azure credential login tenant");
  const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
  if (
    !isUuid(value["subscriptionId"]) ||
    !isUuid(value["tenantId"]) ||
    !isSshPrivateKey(value["sshPrivateKey"]) ||
    sshPassphrase === undefined
  ) throw invalid("Azure CLI credential secret");
  return Object.freeze({
    subscriptionId: value["subscriptionId"],
    tenantId: value["tenantId"],
    ...("authentication" in value ? { authentication: "login" as const } : {}),
    ...(loginSession ? { loginSession } : {}),
    sshPrivateKey: value["sshPrivateKey"],
    sshPassphrase,
  });
}

export function parseCreateCloudCredentialInput(value: unknown): CreateCloudCredentialInput {
  if (!isRecord(value)) throw invalid("cloud credential");
  if (value["provider"] === "aws") {
    if (hasExactKeys(value, CREATE_AWS_LOGIN_CREDENTIAL_KEYS)) {
      const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
      if (value["authentication"] !== "login" || !boundedLabel(value["label"]) || !isAwsRegion(value["defaultRegion"]) || !isSshUsername(value["sshUsername"]) || !isNullableSshPrivateKeyToken(value["sshPrivateKeyToken"]) || sshPassphrase === undefined || (value["sshPrivateKeyToken"] === null && sshPassphrase !== null)) throw invalid("AWS login cloud credential");
      return Object.freeze({ provider: "aws", authentication: "login", label: value["label"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], sshPrivateKeyToken: value["sshPrivateKeyToken"], sshPassphrase });
    }
    if (hasExactKeys(value, CREATE_AWS_PROFILE_CREDENTIAL_KEYS)) {
      const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
      if (!boundedLabel(value["label"]) || !isAwsRegion(value["defaultRegion"]) || !isSshUsername(value["sshUsername"]) || !isNullableSshPrivateKeyToken(value["sshPrivateKeyToken"]) || !isAwsProfileName(value["profileName"]) || sshPassphrase === undefined || (value["sshPrivateKeyToken"] === null && sshPassphrase !== null)) throw invalid("AWS profile cloud credential");
      return Object.freeze({ provider: "aws", label: value["label"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], sshPrivateKeyToken: value["sshPrivateKeyToken"], profileName: value["profileName"], sshPassphrase });
    }
    if (hasExactKeys(value, CREATE_AWS_ACCESS_KEY_CREDENTIAL_KEYS)) {
      const sessionToken = nullableSecret(value["sessionToken"], 16_384);
      const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
      if (!boundedLabel(value["label"]) || !isAwsRegion(value["defaultRegion"]) || !isSshUsername(value["sshUsername"]) || !isNullableSshPrivateKeyToken(value["sshPrivateKeyToken"]) || !boundedSecret(value["accessKeyId"], 16, 256) || !boundedSecret(value["secretAccessKey"], 1, 16_384) || sessionToken === undefined || sshPassphrase === undefined || (value["sshPrivateKeyToken"] === null && sshPassphrase !== null)) throw invalid("AWS access-key cloud credential");
      return Object.freeze({ provider: "aws", label: value["label"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], sshPrivateKeyToken: value["sshPrivateKeyToken"], accessKeyId: value["accessKeyId"], secretAccessKey: value["secretAccessKey"], sessionToken, sshPassphrase });
    }
    throw invalid("AWS cloud credential");
  }
  if (value["provider"] === "azure") {
    if (!hasExactKeys(value, CREATE_AZURE_CLI_CREDENTIAL_KEYS) && !hasExactKeys(value, CREATE_AZURE_LOGIN_CREDENTIAL_KEYS)) throw invalid("Azure cloud credential");
    if ("authentication" in value && (value["authentication"] !== "login" || !isUuidV4(value["loginToken"]))) throw invalid("Azure login credential");
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    if (!boundedLabel(value["label"]) || !isAzureLocation(value["defaultLocation"]) || !isAzureSshUsername(value["sshUsername"]) || !isNullableSshPrivateKeyToken(value["sshPrivateKeyToken"]) || !isUuid(value["subscriptionId"]) || !isUuid(value["tenantId"]) || sshPassphrase === undefined || (value["sshPrivateKeyToken"] === null && sshPassphrase !== null)) throw invalid("Azure CLI cloud credential");
    return Object.freeze({ provider: "azure", label: value["label"], defaultLocation: value["defaultLocation"], sshUsername: value["sshUsername"], sshPrivateKeyToken: value["sshPrivateKeyToken"], subscriptionId: value["subscriptionId"], tenantId: value["tenantId"], sshPassphrase, ...("authentication" in value ? { authentication: "login" as const, loginToken: value["loginToken"] as string } : {}) });
  }
  throw invalid("cloud credential");
}

export function parseResolvedCloudCredentialInput(value: unknown): ResolvedCloudCredentialInput {
  if (!isRecord(value)) throw invalid("resolved cloud credential");
  if (value["provider"] === "aws") {
    if (!hasExactKeys(value, RESOLVED_CREDENTIAL_KEYS) || !boundedLabel(value["label"]) || !isAwsRegion(value["defaultRegion"]) || !isSshUsername(value["sshUsername"])) throw invalid("resolved AWS cloud credential");
    return Object.freeze({ provider: "aws", label: value["label"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], secret: parseAwsCredentialSecret(value["secret"]) });
  }
  if (value["provider"] === "azure") {
    if (!hasExactKeys(value, RESOLVED_AZURE_CREDENTIAL_KEYS) || !boundedLabel(value["label"]) || !isAzureLocation(value["defaultLocation"]) || !isAzureSshUsername(value["sshUsername"])) throw invalid("resolved Azure CLI cloud credential");
    return Object.freeze({ provider: "azure", label: value["label"], defaultLocation: value["defaultLocation"], sshUsername: value["sshUsername"], secret: parseAzureCliCredentialSecret(value["secret"]) });
  }
  throw invalid("resolved cloud credential");
}

export function parseCloudCredentialSummary(value: unknown): CloudCredentialSummary {
  if (!isRecord(value)) throw invalid("cloud credential summary");
  if (value["provider"] === "aws") {
    if ((hasExactKeys(value, AWS_PROFILE_SUMMARY_KEYS) || hasExactKeys(value, AWS_PROFILE_LOGIN_SUMMARY_KEYS)) && (!("loginSessionArn" in value) || isAwsLoginSessionArn(value["loginSessionArn"])) && isUuidV4(value["id"]) && boundedLabel(value["label"]) && isCredentialPersistence(value["persistence"]) && isIsoTimestamp(value["createdAt"]) && isAwsRegion(value["defaultRegion"]) && isSshUsername(value["sshUsername"]) && isAwsProfileName(value["profileName"])) {
      return Object.freeze({ id: value["id"], provider: "aws", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], profileName: value["profileName"], ...("loginSessionArn" in value ? { loginSessionArn: value["loginSessionArn"] as string } : {}) });
    }
    if ((hasExactKeys(value, AWS_ACCESS_KEY_SUMMARY_KEYS) || hasExactKeys(value, AWS_LOGIN_SUMMARY_KEYS)) && (!("loginSessionArn" in value) || isAwsLoginSessionArn(value["loginSessionArn"])) && isUuidV4(value["id"]) && boundedLabel(value["label"]) && isCredentialPersistence(value["persistence"]) && isIsoTimestamp(value["createdAt"]) && isAwsRegion(value["defaultRegion"]) && isSshUsername(value["sshUsername"])) {
      return Object.freeze({ id: value["id"], provider: "aws", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], ...("loginSessionArn" in value ? { loginSessionArn: value["loginSessionArn"] as string } : {}) });
    }
    throw invalid("AWS cloud credential summary");
  }
  if (value["provider"] === "azure") {
    if ((!hasExactKeys(value, AZURE_SUMMARY_KEYS) && !hasExactKeys(value, AZURE_CLI_LOGIN_SUMMARY_KEYS) && !hasExactKeys(value, AZURE_LOGIN_SUMMARY_KEYS)) || ("authentication" in value && value["authentication"] !== "login") || ("loginAccountId" in value && !boundedPlain(value["loginAccountId"], 1, 1_024)) || !isUuidV4(value["id"]) || !boundedLabel(value["label"]) || !isCredentialPersistence(value["persistence"]) || !isIsoTimestamp(value["createdAt"]) || !isAzureLocation(value["defaultLocation"]) || !isUuid(value["subscriptionId"]) || !isUuid(value["tenantId"]) || !isAzureSshUsername(value["sshUsername"])) throw invalid("Azure CLI cloud credential summary");
    return Object.freeze({ id: value["id"], provider: "azure", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], defaultLocation: value["defaultLocation"], subscriptionId: value["subscriptionId"], tenantId: value["tenantId"], sshUsername: value["sshUsername"], ...("authentication" in value ? { authentication: "login" as const } : {}), ...("loginAccountId" in value ? { loginAccountId: value["loginAccountId"] as string } : {}) });
  }
  throw invalid("cloud credential summary");
}

export function parseAzureCliAccountSummary(value: unknown): AzureCliAccountSummary {
  if (!hasExactKeys(value, AZURE_CLI_ACCOUNT_KEYS) || !isUuid(value["subscriptionId"]) || !boundedPlain(value["name"], 1, 256) || !isUuid(value["tenantId"]) || (value["homeTenantId"] !== null && !isUuid(value["homeTenantId"])) || typeof value["isDefault"] !== "boolean" || !boundedIdentifier(value["cloudName"], 1, 128)) throw invalid("Azure CLI account summary");
  return Object.freeze({ subscriptionId: value["subscriptionId"], name: value["name"], tenantId: value["tenantId"], homeTenantId: value["homeTenantId"], isDefault: value["isDefault"], cloudName: value["cloudName"] });
}

export function parseAwsDeploymentSpec(value: unknown): AwsDeploymentSpec {
  if (!isRecord(value)) throw invalid("AWS deployment specification");
  const legacy = hasExactKeys(value, LEGACY_AWS_SPEC_KEYS);
  if (!legacy && !hasExactKeys(value, AWS_SPEC_KEYS)) throw invalid("AWS deployment specification");
  const sshCidrs = parseIngressCidrs(value["sshCidrs"]);
  const operatorCidrs = parseIngressCidrs(value["operatorCidrs"]);
  const volumeSizeGiB = nullableInteger(value["volumeSizeGiB"], 8, 16_384);
  if (!isAwsRegion(value["region"]) || !boundedPattern(value["imageId"], 5, 128, /^ami-[0-9a-f]+$/u) || !boundedPattern(value["instanceType"], 2, 64, /^[a-z0-9][a-z0-9.-]+$/u) || !nullableBoundedPattern(value["subnetId"], 5, 128, /^subnet-[0-9a-f]+$/u) || !nullableBoundedPattern(value["vpcId"], 5, 128, /^vpc-[0-9a-f]+$/u) || !boundedPlain(value["keyPairName"], 1, 255) || !isOperatorName(value["operatorName"]) || !isPort(value["sshPort"]) || !isPort(value["multiplayerPort"]) || value["sshPort"] === value["multiplayerPort"] || volumeSizeGiB === undefined || typeof value["useElasticIp"] !== "boolean") throw invalid("AWS deployment specification");
  if (legacy) {
    return Object.freeze({
      region: value["region"], imageId: value["imageId"], instanceType: value["instanceType"],
      subnetId: value["subnetId"], vpcId: value["vpcId"], networkMode: "existing",
      managedVpcCidr: null, managedSubnetCidr: null, sshKeyMode: "managed",
      existingKeyPairName: null, sshUsername: null, keyPairName: "managed-by-sliver-gui", operatorName: value["operatorName"],
      sshPort: value["sshPort"], multiplayerPort: value["multiplayerPort"], volumeSizeGiB,
      useElasticIp: value["useElasticIp"], sshCidrs, operatorCidrs,
    });
  }
  const networkMode = value["networkMode"];
  const sshKeyMode = value["sshKeyMode"];
  const managedVpcCidr = nullableIpv4NetworkCidr(value["managedVpcCidr"], 16, 28);
  const managedSubnetCidr = nullableIpv4NetworkCidr(value["managedSubnetCidr"], 16, 28);
  const existingKeyPairName = value["existingKeyPairName"] === null
    ? null
    : boundedPlain(value["existingKeyPairName"], 1, 255)
      ? value["existingKeyPairName"]
      : undefined;
  const sshUsername = value["sshUsername"] === null
    ? null
    : isSshUsername(value["sshUsername"])
      ? value["sshUsername"]
      : undefined;
  if (
    (networkMode !== "existing" && networkMode !== "managed") ||
    (sshKeyMode !== "managed" && sshKeyMode !== "existing") ||
    managedVpcCidr === undefined || managedSubnetCidr === undefined || existingKeyPairName === undefined || sshUsername === undefined ||
    (networkMode === "existing" && (value["vpcId"] === null || value["subnetId"] === null || managedVpcCidr !== null || managedSubnetCidr !== null)) ||
    (networkMode === "managed" && (value["vpcId"] !== null || value["subnetId"] !== null || managedVpcCidr === null || managedSubnetCidr === null || !ipv4CidrContains(managedVpcCidr, managedSubnetCidr))) ||
    (sshKeyMode === "managed" && (existingKeyPairName !== null || value["keyPairName"] !== "managed-by-sliver-gui")) ||
    (sshKeyMode === "existing" && (existingKeyPairName === null || value["keyPairName"] !== existingKeyPairName))
  ) throw invalid("AWS deployment specification");
  return Object.freeze({
    region: value["region"], imageId: value["imageId"], instanceType: value["instanceType"],
    subnetId: value["subnetId"], vpcId: value["vpcId"], networkMode, managedVpcCidr,
    managedSubnetCidr, sshKeyMode, existingKeyPairName, sshUsername, keyPairName: value["keyPairName"],
    operatorName: value["operatorName"], sshPort: value["sshPort"], multiplayerPort: value["multiplayerPort"],
    volumeSizeGiB, useElasticIp: value["useElasticIp"], sshCidrs, operatorCidrs,
  });
}

export function parseAzureDeploymentSpec(value: unknown): AzureDeploymentSpec {
  if (!hasExactKeys(value, AZURE_SPEC_KEYS)) throw invalid("Azure deployment specification");
  const sshCidrs = parseIngressCidrs(value["sshCidrs"]);
  const operatorCidrs = parseIngressCidrs(value["operatorCidrs"]);
  const networkMode = value["networkMode"];
  const managedVnetCidr = nullableIpv4NetworkCidr(value["managedVnetCidr"], 8, 29);
  const managedSubnetCidr = nullableIpv4NetworkCidr(value["managedSubnetCidr"], 8, 29);
  const osDiskSizeGiB = nullableInteger(value["osDiskSizeGiB"], 30, 4_095);
  if (
    !isAzureLocation(value["location"]) ||
    !isAzureImageReference(value["imageReference"]) ||
    !boundedPattern(value["vmSize"], 2, 128, /^[A-Za-z0-9][A-Za-z0-9_-]+$/u) ||
    (networkMode !== "existing" && networkMode !== "managed") ||
    !nullableAzureResourceId(value["vnetId"]) ||
    !nullableAzureResourceId(value["subnetId"]) ||
    managedVnetCidr === undefined ||
    managedSubnetCidr === undefined ||
    !isAzureSshUsername(value["sshUsername"]) ||
    !isOperatorName(value["operatorName"]) ||
    value["sshPort"] !== AZURE_SSH_PORT ||
    !isPort(value["multiplayerPort"]) ||
    value["sshPort"] === value["multiplayerPort"] ||
    osDiskSizeGiB === undefined ||
    typeof value["usePublicIp"] !== "boolean" ||
    (networkMode === "existing" && (value["vnetId"] === null || value["subnetId"] === null || managedVnetCidr !== null || managedSubnetCidr !== null || !azureSubnetBelongsToVnet(value["vnetId"], value["subnetId"]))) ||
    (networkMode === "managed" && (value["vnetId"] !== null || value["subnetId"] !== null || managedVnetCidr === null || managedSubnetCidr === null || !ipv4CidrContains(managedVnetCidr, managedSubnetCidr)))
  ) throw invalid("Azure deployment specification");
  return Object.freeze({
    location: value["location"], imageReference: value["imageReference"], vmSize: value["vmSize"],
    networkMode, vnetId: value["vnetId"], subnetId: value["subnetId"], managedVnetCidr,
    managedSubnetCidr, sshUsername: value["sshUsername"], operatorName: value["operatorName"],
    sshPort: value["sshPort"], multiplayerPort: value["multiplayerPort"], osDiskSizeGiB,
    usePublicIp: value["usePublicIp"], sshCidrs, operatorCidrs,
  });
}

export function parseCreateCloudDeploymentInput(value: unknown): CreateCloudDeploymentInput {
  if (!hasExactKeys(value, CREATE_DEPLOYMENT_KEYS) || !isRevision(value["expectedRevision"]) || !isUuidV4(value["credentialId"]) || !boundedName(value["name"])) throw invalid("cloud deployment request");
  if (value["provider"] === "aws") {
    const spec = parseAwsDeploymentSpec(value["spec"]);
    if (!isSupportedAwsInstanceType(spec.instanceType)) throw invalid("AWS instance type selection");
    // Legacy on-disk records may omit this pair, but new provisioning requests
    // must bind the chosen subnet to the VPC the user actually selected.
    if (spec.networkMode === "existing" && (spec.vpcId === null || spec.subnetId === null)) {
      throw invalid("AWS existing network selection");
    }
    return Object.freeze({ provider: "aws", expectedRevision: value["expectedRevision"], credentialId: value["credentialId"], name: value["name"], spec });
  }
  if (value["provider"] === "azure") return Object.freeze({ provider: "azure", expectedRevision: value["expectedRevision"], credentialId: value["credentialId"], name: value["name"], spec: parseAzureDeploymentSpec(value["spec"]) });
  throw invalid("cloud deployment request");
}

export function parseCloudDeploymentRecord(value: unknown): CloudDeploymentRecord {
  if (!hasExactKeys(value, RECORD_KEYS) || !isUuidV4(value["id"]) || !boundedName(value["name"]) || !isUuidV4(value["credentialId"]) || !isDeploymentStatus(value["status"]) || !isDeploymentPhase(value["phase"]) || !isIsoTimestamp(value["createdAt"]) || !isIsoTimestamp(value["updatedAt"]) || !isOperatorConfigFileName(value["operatorConfigFileName"]) || !isSha256Digest(value["operatorConfigDigest"]) || (value["operatorConfigFileName"] === null) !== (value["operatorConfigDigest"] === null) || !nullableBoundedPlain(value["remoteHost"], 1, 255) || !nullableBoundedPlain(value["lastError"], 1, 4_096) || !Array.isArray(value["managedAssets"]) || value["managedAssets"].length > 64) throw invalid("cloud deployment record");
  const managedAssets = Object.freeze(value["managedAssets"].map(parseCloudManagedAsset));
  if (new Set(managedAssets.map(({ resourceType, resourceId }) => `${resourceType}:${resourceId}`)).size !== managedAssets.length) throw invalid("cloud deployment record");
  if (value["provider"] === "aws") {
    if (!hasOnlyAssetTypes(managedAssets, AWS_ASSET_TYPES)) throw invalid("AWS cloud deployment record");
    return Object.freeze({ id: value["id"], provider: "aws", name: value["name"], credentialId: value["credentialId"], status: value["status"], phase: value["phase"], createdAt: value["createdAt"], updatedAt: value["updatedAt"], operatorConfigFileName: value["operatorConfigFileName"], operatorConfigDigest: value["operatorConfigDigest"], remoteHost: value["remoteHost"], lastError: value["lastError"], managedAssets, spec: parseAwsDeploymentSpec(value["spec"]), runtime: parseAwsDeploymentRuntime(value["runtime"]) });
  }
  if (value["provider"] === "azure") {
    if (!hasOnlyAssetTypes(managedAssets, AZURE_ASSET_TYPES)) throw invalid("Azure cloud deployment record");
    return Object.freeze({ id: value["id"], provider: "azure", name: value["name"], credentialId: value["credentialId"], status: value["status"], phase: value["phase"], createdAt: value["createdAt"], updatedAt: value["updatedAt"], operatorConfigFileName: value["operatorConfigFileName"], operatorConfigDigest: value["operatorConfigDigest"], remoteHost: value["remoteHost"], lastError: value["lastError"], managedAssets, spec: parseAzureDeploymentSpec(value["spec"]), runtime: parseAzureDeploymentRuntime(value["runtime"]) });
  }
  throw invalid("cloud deployment record");
}

export function parseCloudDeploymentState(value: unknown): CloudDeploymentState {
  if (!hasExactKeys(value, STATE_KEYS) || value["v"] !== CLOUD_DEPLOYMENT_STATE_VERSION || !isRevision(value["revision"]) || !Array.isArray(value["deployments"]) || value["deployments"].length > 1_000) throw invalid("cloud deployment state");
  const deployments = Object.freeze(value["deployments"].map(parseCloudDeploymentRecord));
  if (new Set(deployments.map(({ id }) => id)).size !== deployments.length) throw invalid("cloud deployment state");
  return Object.freeze({ v: CLOUD_DEPLOYMENT_STATE_VERSION, revision: value["revision"], deployments });
}

export function parseUpdateCloudDeploymentInput(value: unknown): UpdateCloudDeploymentInput {
  if (!hasExactKeys(value, UPDATE_KEYS) || !isRevision(value["expectedRevision"])) throw invalid("cloud deployment update");
  return Object.freeze({ expectedRevision: value["expectedRevision"], deployment: parseCloudDeploymentRecord(value["deployment"]) });
}

export function parseDeleteCloudDeploymentInput(value: unknown): DeleteCloudDeploymentInput {
  if (!hasExactKeys(value, DELETE_KEYS) || !isRevision(value["expectedRevision"]) || !isUuidV4(value["deploymentId"])) throw invalid("cloud deployment deletion");
  return Object.freeze({ expectedRevision: value["expectedRevision"], deploymentId: value["deploymentId"] });
}

export function parseCloudDeploymentActionInput(value: unknown): CloudDeploymentActionInput {
  if (!hasExactKeys(value, ACTION_KEYS) || !isUuidV4(value["deploymentId"]) || !isRevision(value["expectedRevision"]) || typeof value["action"] !== "string" || !DEPLOYMENT_ACTIONS.has(value["action"] as CloudDeploymentAction)) throw invalid("cloud deployment action");
  return Object.freeze({ deploymentId: value["deploymentId"], expectedRevision: value["expectedRevision"], action: value["action"] as CloudDeploymentAction });
}

export function parseRenameCloudDeploymentInput(value: unknown): RenameCloudDeploymentInput {
  if (
    !hasExactKeys(value, RENAME_DEPLOYMENT_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"]) ||
    typeof value["name"] !== "string" ||
    /\p{Cc}/u.test(value["name"])
  ) throw invalid("cloud deployment rename");
  const name = value["name"].trim();
  if (!boundedName(name)) throw invalid("cloud deployment rename");
  return Object.freeze({ deploymentId: value["deploymentId"], expectedRevision: value["expectedRevision"], name });
}

export function parseUpdateCloudFirewallInput(value: unknown): UpdateCloudFirewallInput {
  if (!hasExactKeys(value, FIREWALL_KEYS) || !isUuidV4(value["deploymentId"]) || !isRevision(value["expectedRevision"])) throw invalid("cloud firewall update");
  return Object.freeze({ deploymentId: value["deploymentId"], expectedRevision: value["expectedRevision"], sshCidrs: parseIngressCidrs(value["sshCidrs"]), operatorCidrs: parseIngressCidrs(value["operatorCidrs"]) });
}

export function parseAwsFirewallRuleSpec(value: unknown): AwsFirewallRuleSpec {
  if (
    !hasExactKeys(value, AWS_FIREWALL_RULE_KEYS) ||
    typeof value["direction"] !== "string" ||
    !AWS_FIREWALL_DIRECTIONS.has(value["direction"] as AwsFirewallDirection) ||
    !isAwsFirewallProtocol(value["protocol"]) ||
    typeof value["peerType"] !== "string" ||
    !AWS_FIREWALL_PEER_TYPES.has(value["peerType"] as AwsFirewallPeerType) ||
    !isAwsFirewallPeer(value["peerType"] as AwsFirewallPeerType, value["peer"]) ||
    !isAwsFirewallDescription(value["description"]) ||
    !areValidAwsFirewallPorts(value["protocol"], value["fromPort"], value["toPort"])
  ) throw invalid("AWS firewall rule");
  return Object.freeze({
    direction: value["direction"] as AwsFirewallDirection,
    protocol: value["protocol"],
    fromPort: value["fromPort"] as number | null,
    toPort: value["toPort"] as number | null,
    peerType: value["peerType"] as AwsFirewallPeerType,
    peer: value["peer"] as string,
    description: value["description"],
  });
}

export function parseAzureFirewallRuleSpec(value: unknown): AzureFirewallRuleSpec {
  if (
    !hasExactKeys(value, AZURE_FIREWALL_RULE_KEYS) ||
    !isAzureSecurityRuleName(value["name"]) ||
    !boundedInteger(value["priority"], 100, 4_096) ||
    (value["priority"] >= 1_000 && value["priority"] <= 1_199) ||
    typeof value["direction"] !== "string" ||
    !AZURE_FIREWALL_DIRECTIONS.has(value["direction"] as AzureFirewallDirection) ||
    typeof value["access"] !== "string" ||
    !AZURE_FIREWALL_ACCESS.has(value["access"] as AzureFirewallAccess) ||
    typeof value["protocol"] !== "string" ||
    !AZURE_FIREWALL_PROTOCOLS.has(value["protocol"] as AzureFirewallProtocol) ||
    !isAzureRuleValueList(value["sourceAddressPrefixes"], isAzureAddressPrefix) ||
    !isAzureRuleValueList(value["sourcePortRanges"], isAzurePortRange) ||
    !isAzureRuleValueList(value["destinationAddressPrefixes"], isAzureAddressPrefix) ||
    !isAzureRuleValueList(value["destinationPortRanges"], isAzurePortRange) ||
    !isAzureFirewallDescription(value["description"])
  ) throw invalid("Azure firewall rule");
  return Object.freeze({
    name: value["name"], priority: value["priority"],
    direction: value["direction"] as AzureFirewallDirection,
    access: value["access"] as AzureFirewallAccess,
    protocol: value["protocol"] as AzureFirewallProtocol,
    sourceAddressPrefixes: Object.freeze([...value["sourceAddressPrefixes"]]),
    sourcePortRanges: Object.freeze([...value["sourcePortRanges"]]),
    destinationAddressPrefixes: Object.freeze([...value["destinationAddressPrefixes"]]),
    destinationPortRanges: Object.freeze([...value["destinationPortRanges"]]),
    description: value["description"],
  });
}

export function parseCloudFirewallRuleSpec(value: unknown): CloudFirewallRuleSpec {
  if (hasExactKeys(value, AWS_FIREWALL_RULE_KEYS)) return parseAwsFirewallRuleSpec(value);
  if (hasExactKeys(value, AZURE_FIREWALL_RULE_KEYS)) return parseAzureFirewallRuleSpec(value);
  throw invalid("cloud firewall rule");
}

export function parseListCloudFirewallRulesInput(value: unknown): ListCloudFirewallRulesInput {
  if (!hasExactKeys(value, LIST_AWS_FIREWALL_RULES_KEYS) || !isUuidV4(value["deploymentId"])) {
    throw invalid("cloud firewall rule list request");
  }
  return Object.freeze({ deploymentId: value["deploymentId"] });
}

export function parseCreateCloudFirewallRuleInput(value: unknown): CreateCloudFirewallRuleInput {
  if (
    !hasExactKeys(value, CREATE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"])
  ) throw invalid("cloud firewall rule creation");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    rule: parseCloudFirewallRuleSpec(value["rule"]),
  });
}

export function parseUpdateCloudFirewallRuleInput(value: unknown): UpdateCloudFirewallRuleInput {
  if (
    !hasExactKeys(value, UPDATE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"]) ||
    !isCloudFirewallRuleId(value["ruleId"])
  ) throw invalid("cloud firewall rule update");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    rule: parseCloudFirewallRuleSpec(value["rule"]),
    ruleId: value["ruleId"],
  });
}

export function parseDeleteCloudFirewallRuleInput(value: unknown): DeleteCloudFirewallRuleInput {
  if (
    !hasExactKeys(value, DELETE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"]) ||
    !isCloudFirewallRuleId(value["ruleId"])
  ) throw invalid("cloud firewall rule deletion");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    ruleId: value["ruleId"],
  });
}

/** @deprecated Use parseListCloudFirewallRulesInput. */
export const parseListAwsFirewallRulesInput = parseListCloudFirewallRulesInput;
/** @deprecated Use parseCreateCloudFirewallRuleInput. */
export const parseCreateAwsFirewallRuleInput = parseCreateCloudFirewallRuleInput;
/** @deprecated Use parseUpdateCloudFirewallRuleInput. */
export const parseUpdateAwsFirewallRuleInput = parseUpdateCloudFirewallRuleInput;
/** @deprecated Use parseDeleteCloudFirewallRuleInput. */
export const parseDeleteAwsFirewallRuleInput = parseDeleteCloudFirewallRuleInput;

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function isNullableSshPrivateKeyToken(value: unknown): value is string | null {
  return value === null || isUuidV4(value);
}

export function isAwsProfileName(value: unknown): value is string {
  return boundedPlain(value, 1, AWS_CLI_PROFILE_NAME_MAX_LENGTH) && !/[\p{C}\[\]]/u.test(value);
}

export function isSupportedAwsInstanceType(value: unknown): value is AwsSupportedInstanceType {
  return typeof value === "string" && (AWS_SUPPORTED_INSTANCE_TYPES as readonly string[]).includes(value);
}

function parseAwsDeploymentRuntime(value: unknown): AwsDeploymentRuntime {
  if (!isRecord(value)) throw invalid("AWS deployment runtime");
  const legacy = hasExactKeys(value, LEGACY_AWS_RUNTIME_KEYS);
  const withoutStatus = hasExactKeys(value, AWS_RUNTIME_KEYS);
  const withStatus = hasExactKeys(value, AWS_RUNTIME_WITH_STATUS_KEYS);
  if (!legacy && !withoutStatus && !withStatus) throw invalid("AWS deployment runtime");
  if (!nullableBoundedPattern(value["instanceId"], 5, 128, /^i-[a-z0-9]+$/u) || !boundedStringArray(value["securityGroupIds"], 32, 5, 128, /^sg-[a-z0-9]+$/u) || !boundedStringArray(value["volumeIds"], 64, 5, 128, /^vol-[a-z0-9]+$/u) || !boundedStringArray(value["networkInterfaceIds"], 64, 5, 128, /^eni-[a-z0-9]+$/u) || !nullableBoundedPlain(value["publicIpAddress"], 1, 255) || !nullableBoundedPlain(value["privateIpAddress"], 1, 255) || !nullableBoundedPlain(value["availabilityZone"], 1, 128) || !nullableBoundedPattern(value["elasticIpAllocationId"], 5, 128, /^eipalloc-[a-z0-9]+$/u)) throw invalid("AWS deployment runtime");
  if (!legacy && (!nullableBoundedPattern(value["vpcId"], 5, 128, /^vpc-[a-z0-9]+$/u) || !nullableBoundedPattern(value["subnetId"], 5, 128, /^subnet-[a-z0-9]+$/u) || !nullableBoundedPattern(value["internetGatewayId"], 5, 128, /^igw-[a-z0-9]+$/u) || !nullableBoundedPattern(value["routeTableId"], 5, 128, /^rtb-[a-z0-9]+$/u) || !nullableBoundedPattern(value["routeTableAssociationId"], 5, 128, /^rtbassoc-[a-z0-9]+$/u))) throw invalid("AWS deployment runtime");
  if (withStatus && (!isAwsDeploymentInstanceState(value["instanceState"]) || !isAwsDeploymentHealth(value["instanceHealth"]) || !isAwsDeploymentHealth(value["systemHealth"]))) throw invalid("AWS deployment runtime");
  const instanceState = withStatus ? value["instanceState"] as AwsDeploymentInstanceState : "unknown";
  const instanceHealth = withStatus ? value["instanceHealth"] as AwsDeploymentHealth : "unknown";
  const systemHealth = withStatus ? value["systemHealth"] as AwsDeploymentHealth : "unknown";
  return Object.freeze({
    instanceId: value["instanceId"],
    instanceState,
    instanceHealth,
    systemHealth,
    securityGroupIds: Object.freeze([...value["securityGroupIds"]]),
    volumeIds: Object.freeze([...value["volumeIds"]]), networkInterfaceIds: Object.freeze([...value["networkInterfaceIds"]]),
    publicIpAddress: value["publicIpAddress"], privateIpAddress: value["privateIpAddress"],
    availabilityZone: value["availabilityZone"], elasticIpAllocationId: value["elasticIpAllocationId"],
    vpcId: legacy ? null : value["vpcId"], subnetId: legacy ? null : value["subnetId"],
    internetGatewayId: legacy ? null : value["internetGatewayId"], routeTableId: legacy ? null : value["routeTableId"],
    routeTableAssociationId: legacy ? null : value["routeTableAssociationId"],
  });
}

function isAwsDeploymentInstanceState(value: unknown): value is AwsDeploymentInstanceState {
  return typeof value === "string" && AWS_INSTANCE_STATES.has(value as AwsDeploymentInstanceState);
}

function isAwsDeploymentHealth(value: unknown): value is AwsDeploymentHealth {
  return typeof value === "string" && AWS_HEALTH_VALUES.has(value as AwsDeploymentHealth);
}

function parseAzureDeploymentRuntime(value: unknown): AzureDeploymentRuntime {
  if (
    !hasExactKeys(value, AZURE_RUNTIME_KEYS) ||
    !nullableAzureResourceGroupName(value["resourceGroupName"]) ||
    !nullableAzureResourceName(value["vmName"]) ||
    !nullableAzureResourceId(value["vmId"]) ||
    typeof value["instanceState"] !== "string" ||
    !AZURE_INSTANCE_STATES.has(value["instanceState"] as AzureDeploymentInstanceState) ||
    !nullableBoundedPlain(value["provisioningState"], 1, 128) ||
    !nullableAzureResourceId(value["networkSecurityGroupId"]) ||
    !nullableAzureResourceId(value["networkInterfaceId"]) ||
    !nullableAzureResourceId(value["osDiskId"]) ||
    !nullableAzureResourceId(value["publicIpAddressId"]) ||
    !nullableBoundedPlain(value["publicIpAddress"], 1, 255) ||
    !nullableBoundedPlain(value["privateIpAddress"], 1, 255) ||
    !nullableAzureResourceId(value["vnetId"]) ||
    !nullableAzureResourceId(value["subnetId"])
  ) throw invalid("Azure deployment runtime");
  return Object.freeze({
    resourceGroupName: value["resourceGroupName"], vmName: value["vmName"], vmId: value["vmId"],
    instanceState: value["instanceState"] as AzureDeploymentInstanceState,
    provisioningState: value["provisioningState"], networkSecurityGroupId: value["networkSecurityGroupId"],
    networkInterfaceId: value["networkInterfaceId"], osDiskId: value["osDiskId"],
    publicIpAddressId: value["publicIpAddressId"], publicIpAddress: value["publicIpAddress"],
    privateIpAddress: value["privateIpAddress"], vnetId: value["vnetId"], subnetId: value["subnetId"],
  });
}

function parseCloudManagedAsset(value: unknown): CloudManagedAsset {
  if (!hasExactKeys(value, ASSET_KEYS) || typeof value["resourceType"] !== "string" || (!AWS_ASSET_TYPES.has(value["resourceType"] as AwsManagedAssetType) && !AZURE_ASSET_TYPES.has(value["resourceType"] as AzureManagedAssetType)) || !boundedPlain(value["resourceId"], 1, 2_048) || !nullableBoundedPlain(value["displayName"], 1, 255) || typeof value["tagged"] !== "boolean") throw invalid("cloud managed asset");
  return Object.freeze({ resourceType: value["resourceType"] as CloudManagedAsset["resourceType"], resourceId: value["resourceId"], displayName: value["displayName"], tagged: value["tagged"] });
}

function parseIngressCidrs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CLOUD_INGRESS_CIDR_MAX_ITEMS || !value.every(isCidr)) throw invalid("ingress CIDR list");
  const result = Object.freeze([...new Set(value)]);
  if (result.length !== value.length) throw invalid("ingress CIDR list");
  return result;
}

function isCidr(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 3 || value.length > 64 || value.trim() !== value || /[\s\0]/u.test(value)) return false;
  const match = /^(.+)\/(\d{1,3})$/u.exec(value);
  if (!match) return false;
  const prefix = Number(match[2]);
  const address = match[1] ?? "";
  if (address.includes(":")) return prefix > 0 && prefix <= 128 && isIpv6Address(address);
  return prefix > 0 && prefix <= 32 && isIpv4Address(address);
}

function isAwsFirewallProtocol(value: unknown): value is string {
  if (value === "-1" || value === "tcp" || value === "udp" || value === "icmp" || value === "icmpv6") {
    return true;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,2})$/u.test(value)) return false;
  return Number(value) <= 255;
}

function areValidAwsFirewallPorts(
  protocol: string,
  fromPort: unknown,
  toPort: unknown,
): boolean {
  if (protocol === "tcp" || protocol === "udp") {
    return boundedInteger(fromPort, 0, 65_535) &&
      boundedInteger(toPort, 0, 65_535) &&
      fromPort <= toPort;
  }
  if (protocol === "icmp" || protocol === "icmpv6") {
    return boundedInteger(fromPort, -1, 255) &&
      boundedInteger(toPort, -1, 255) &&
      (fromPort !== -1 || toPort === -1);
  }
  return fromPort === null && toPort === null;
}

function isAwsFirewallPeer(type: AwsFirewallPeerType, value: unknown): value is string {
  if (type === "ipv4") return isAwsFirewallCidr(value, false);
  if (type === "ipv6") return isAwsFirewallCidr(value, true);
  if (type === "prefix-list") {
    return boundedPattern(value, 4, 128, /^pl-[0-9a-f]+$/u);
  }
  return boundedPattern(value, 4, 128, /^sg-[0-9a-f]+$/u);
}

function isAwsFirewallCidr(value: unknown, ipv6: boolean): boolean {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 64 ||
    value.trim() !== value ||
    /[\s\0]/u.test(value)
  ) return false;
  const match = /^(.+)\/(\d{1,3})$/u.exec(value);
  if (!match) return false;
  const address = match[1] ?? "";
  const prefixText = match[2] ?? "";
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(prefixText)) return false;
  const prefix = Number(prefixText);
  return ipv6
    ? prefix >= 0 && prefix <= 128 && isIpv6Address(address)
    : prefix >= 0 && prefix <= 32 && isIpv4Address(address);
}

function isAwsFirewallDescription(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    value.length <= 255 &&
    /^[A-Za-z0-9 ._:/()#,@\[\]+=&;{}!$*-]*$/u.test(value)
  );
}

function isAwsSecurityGroupRuleId(value: unknown): value is string {
  return boundedPattern(value, 5, 128, /^sgr-[0-9a-f]+$/u);
}

function isCloudFirewallRuleId(value: unknown): value is string {
  return isAwsSecurityGroupRuleId(value) || isAzureSecurityRuleName(value) || (
    isAzureResourceId(value) && /\/securityRules\/[^/]+$/iu.test(value)
  );
}

function isAzureSecurityRuleName(value: unknown): value is string {
  return boundedPattern(value, 1, 80, /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/u);
}

function isAzureAddressPrefix(value: unknown): value is string {
  if (value === "*") return true;
  if (typeof value !== "string" || value.length > 128 || value.trim() !== value || /[\s\0]/u.test(value)) return false;
  if (isIpv4Address(value) || isIpv6Address(value)) return true;
  if (isAwsFirewallCidr(value, value.includes(":"))) return true;
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isAzurePortRange(value: unknown): value is string {
  if (value === "*") return true;
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d{0,4})(?:-(0|[1-9]\d{0,4}))?$/u.exec(value);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return start <= 65_535 && end <= 65_535 && start <= end;
}

function isAzureRuleValueList<T extends string>(
  value: unknown,
  predicate: (candidate: unknown) => candidate is T,
): value is readonly T[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= AZURE_FIREWALL_RULE_MAX_VALUES &&
    value.every(predicate);
}

function isAzureFirewallDescription(value: unknown): value is string | null {
  return value === null || boundedPlain(value, 1, 140);
}

function isIpv6Address(value: string): boolean {
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
        if (!allowIpv4Tail || index !== groups.length - 1 || !isIpv4Address(group)) return null;
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

function isIpv4Address(value: unknown): boolean {
  if (typeof value !== "string" || value.trim() !== value) return false;
  const octets = value.split(".");
  return octets.length === 4 && octets.every((octet) =>
    /^\d{1,3}$/u.test(octet) && Number(octet) <= 255 && String(Number(octet)) === octet);
}

function nullableIpv4NetworkCidr(value: unknown, minPrefix: number, maxPrefix: number): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const match = /^([^/]+)\/(\d{1,2})$/u.exec(value);
  if (!match || !isIpv4Address(match[1])) return undefined;
  const prefix = Number(match[2]);
  if (prefix < minPrefix || prefix > maxPrefix) return undefined;
  const address = ipv4AddressNumber(match[1]!);
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === address ? value : undefined;
}

function ipv4CidrContains(parent: string, child: string): boolean {
  const parentMatch = /^([^/]+)\/(\d{1,2})$/u.exec(parent);
  const childMatch = /^([^/]+)\/(\d{1,2})$/u.exec(child);
  if (!parentMatch || !childMatch) return false;
  const parentPrefix = Number(parentMatch[2]);
  const childPrefix = Number(childMatch[2]);
  if (childPrefix < parentPrefix) return false;
  const mask = (0xffff_ffff << (32 - parentPrefix)) >>> 0;
  return (ipv4AddressNumber(parentMatch[1]!) & mask) >>> 0 === ipv4AddressNumber(parentMatch[1]!) &&
    (ipv4AddressNumber(childMatch[1]!) & mask) >>> 0 === ipv4AddressNumber(parentMatch[1]!);
}

function ipv4AddressNumber(value: string): number {
  return value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function isOperatorConfigFileName(value: unknown): value is string | null {
  return value === null || boundedPattern(value, 5, 255, /^(?!\.{1,2}$)[A-Za-z0-9._-]+\.cfg$/u);
}

function isSha256Digest(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && /^[0-9a-f]{64}$/u.test(value));
}

/**
 * Accepts the regional form used across AWS partitions, including restricted
 * partitions such as us-iso-east-1 and the European Sovereign Cloud.
 */
export function isAwsRegion(value: unknown): value is string {
  return boundedPattern(value, 3, 64, /^[a-z]{2,8}(?:-[a-z0-9]{1,16}){1,3}-[1-9]\d?$/u);
}

export function isAzureLocation(value: unknown): value is string {
  return boundedPattern(value, 2, AZURE_LOCATION_MAX_LENGTH, /^[a-z0-9]+$/u);
}

function isAzureImageReference(value: unknown): value is string {
  if (isAzureManagedImageResourceId(value)) return true;
  if (typeof value !== "string" || value.length > 512 || value.trim() !== value) return false;
  const parts = value.split(":");
  return parts.length === 4 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(part));
}

function isAzureManagedImageResourceId(value: unknown): value is string {
  return isAzureResourceId(value) &&
    /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.Compute\/images\/[^/]+$/iu.test(value);
}

function isAzureResourceId(value: unknown): value is string {
  if (!boundedPlain(value, 16, 2_048)) return false;
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+(?:\/[^/]+\/[^/]+)*$/iu.exec(value);
  return match !== null && isUuid(match[1]);
}

function nullableAzureResourceId(value: unknown): value is string | null {
  return value === null || isAzureResourceId(value);
}

function nullableAzureResourceGroupName(value: unknown): value is string | null {
  return value === null || (
    boundedPattern(value, 1, 90, /^[\p{L}\p{N}_\-.()]+$/u) && !value.endsWith(".")
  );
}

function nullableAzureResourceName(value: unknown): value is string | null {
  return value === null || boundedPattern(value, 1, 80, /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u);
}

function azureSubnetBelongsToVnet(vnetId: unknown, subnetId: unknown): boolean {
  return typeof vnetId === "string" && typeof subnetId === "string" &&
    subnetId.toLocaleLowerCase("en-US").startsWith(`${vnetId.toLocaleLowerCase("en-US")}/subnets/`);
}

function isSshUsername(value: unknown): value is string {
  return boundedPattern(value, 1, 64, /^[a-z_][a-z0-9_-]*[$]?$/u);
}

export function isAzureSshUsername(value: unknown): value is string {
  return boundedPattern(value, 1, 32, /^[a-z_][a-z0-9_-]*$/u) &&
    !AZURE_RESERVED_SSH_USERNAMES.has(value);
}

function isOperatorName(value: unknown): value is string {
  return boundedPattern(value, 1, CLOUD_DEPLOYMENT_NAME_MAX_LENGTH, /^[A-Za-z0-9][A-Za-z0-9_.@-]*$/u);
}

function boundedLabel(value: unknown): value is string {
  return boundedPlain(value, 1, CLOUD_CREDENTIAL_LABEL_MAX_LENGTH);
}

function boundedName(value: unknown): value is string {
  return boundedPlain(value, 1, CLOUD_DEPLOYMENT_NAME_MAX_LENGTH);
}

function boundedIdentifier(value: unknown, min: number, max: number): value is string {
  return boundedPattern(value, min, max, /^[A-Za-z0-9_.-]+$/u);
}

function boundedPlain(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && value.trim() === value && !/[\0\r\n]/u.test(value);
}

function boundedSecret(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && !value.includes("\0");
}

function nullableSecret(value: unknown, max: number): string | null | undefined {
  return value === null ? null : boundedSecret(value, 1, max) ? value : undefined;
}

function isSshPrivateKey(value: unknown): value is string {
  return boundedSecret(value, 32, CLOUD_SSH_PRIVATE_KEY_MAX_LENGTH) &&
    (/^-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/u.test(value) ||
      /^PuTTY-User-Key-File-\d+:/u.test(value));
}

function nullableBoundedPlain(value: unknown, min: number, max: number): value is string | null {
  return value === null || boundedPlain(value, min, max);
}

function boundedPattern(value: unknown, min: number, max: number, pattern: RegExp): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max && pattern.test(value);
}

function nullableBoundedPattern(value: unknown, min: number, max: number, pattern: RegExp): value is string | null {
  return value === null || boundedPattern(value, min, max, pattern);
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function nullableInteger(value: unknown, min: number, max: number): number | null | undefined {
  return value === null ? null : boundedInteger(value, min, max) ? value : undefined;
}

function isPort(value: unknown): value is number {
  return boundedInteger(value, 1, 65_535);
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isCredentialPersistence(value: unknown): value is CloudCredentialPersistence {
  return typeof value === "string" && CREDENTIAL_PERSISTENCE.has(value as CloudCredentialPersistence);
}

function isDeploymentStatus(value: unknown): value is CloudDeploymentStatus {
  return typeof value === "string" && DEPLOYMENT_STATUSES.has(value as CloudDeploymentStatus);
}

function isDeploymentPhase(value: unknown): value is CloudDeploymentPhase {
  return typeof value === "string" && DEPLOYMENT_PHASES.has(value as CloudDeploymentPhase);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function boundedStringArray(value: unknown, maxItems: number, minLength: number, maxLength: number, pattern: RegExp): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => boundedPattern(item, minLength, maxLength, pattern)) && new Set(value).size === value.length;
}

function hasOnlyAssetTypes<T extends CloudManagedAsset["resourceType"]>(assets: readonly CloudManagedAsset[], allowed: ReadonlySet<T>): boolean {
  return assets.every(({ resourceType }) => allowed.has(resourceType as T));
}

function hasExactKeys<const Key extends string>(value: unknown, keys: readonly Key[]): value is Record<Key, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(label: string): TypeError {
  return new TypeError(`Invalid ${label}`);
}
