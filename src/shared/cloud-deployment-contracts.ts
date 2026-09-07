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

export type CloudProvider = "aws" | "proxmox";
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

export interface AwsAccessKeyCredentialSecret {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string | null;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export interface AwsProfileCredentialSecret {
  readonly profileName: string;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export type AwsCredentialSecret = AwsAccessKeyCredentialSecret | AwsProfileCredentialSecret;

export interface ProxmoxCredentialSecret {
  readonly endpoint: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tlsCaCertificate: string | null;
  readonly sshPrivateKey: string;
  readonly sshPassphrase: string | null;
}

export type CloudCredentialSecret = AwsCredentialSecret | ProxmoxCredentialSecret;

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

export type CreateAwsCloudCredentialInput =
  | CreateAwsAccessKeyCloudCredentialInput
  | CreateAwsProfileCloudCredentialInput;

/** Renderer-safe Proxmox credential input. A null token requests main-process key generation. */
export interface CreateProxmoxCloudCredentialInput {
  readonly provider: "proxmox";
  readonly label: string;
  readonly sshUsername: string;
  readonly sshPrivateKeyToken: string | null;
  readonly endpoint: string;
  readonly tokenId: string;
  readonly tokenSecret: string;
  readonly tlsCaCertificate: string | null;
  readonly sshPassphrase: string | null;
}

export type CreateCloudCredentialInput =
  | CreateAwsCloudCredentialInput
  | CreateProxmoxCloudCredentialInput;

/** Main-process input after resolving an imported or generated SSH private key. */
export interface ResolvedAwsCloudCredentialInput {
  readonly provider: "aws";
  readonly label: string;
  readonly defaultRegion: string;
  readonly sshUsername: string;
  readonly secret: AwsCredentialSecret;
}

/** Main-process input after resolving an imported or generated SSH private key. */
export interface ResolvedProxmoxCloudCredentialInput {
  readonly provider: "proxmox";
  readonly label: string;
  readonly sshUsername: string;
  readonly secret: ProxmoxCredentialSecret;
}

export type ResolvedCloudCredentialInput =
  | ResolvedAwsCloudCredentialInput
  | ResolvedProxmoxCloudCredentialInput;

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
}

export type AwsCloudCredentialSummary =
  | AwsAccessKeyCloudCredentialSummary
  | AwsProfileCloudCredentialSummary;

export interface ProxmoxCloudCredentialSummary {
  readonly id: string;
  readonly provider: "proxmox";
  readonly label: string;
  readonly persistence: CloudCredentialPersistence;
  readonly createdAt: string;
  readonly endpoint: string;
  readonly sshUsername: string;
}

export type CloudCredentialSummary = AwsCloudCredentialSummary | ProxmoxCloudCredentialSummary;

/** Non-secret metadata discovered from the local AWS shared configuration files. */
export interface AwsCliProfileSummary {
  readonly name: string;
  readonly region: string | null;
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

export interface ProxmoxDeploymentSpec {
  readonly node: string;
  readonly templateVmId: number;
  readonly vmId: number | null;
  readonly storage: string;
  readonly bridge: string;
  readonly cores: number;
  readonly memoryMiB: number;
  readonly diskGiB: number;
  readonly operatorName: string;
  readonly sshPort: number;
  readonly multiplayerPort: number;
  readonly ipConfig: string;
  readonly gateway: string | null;
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

export interface CreateProxmoxCloudDeploymentInput {
  readonly provider: "proxmox";
  readonly expectedRevision: number;
  readonly credentialId: string;
  readonly name: string;
  readonly spec: ProxmoxDeploymentSpec;
}

export type CreateCloudDeploymentInput =
  | CreateAwsCloudDeploymentInput
  | CreateProxmoxCloudDeploymentInput;

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
export type ProxmoxManagedAssetType = "proxmox-vm";

export interface CloudManagedAsset {
  readonly resourceType: AwsManagedAssetType | ProxmoxManagedAssetType;
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

export interface ProxmoxDeploymentRuntime {
  readonly vmId: number | null;
  readonly node: string;
  readonly ipAddress: string | null;
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

export interface ProxmoxCloudDeploymentRecord extends CloudDeploymentRecordBase {
  readonly provider: "proxmox";
  readonly spec: ProxmoxDeploymentSpec;
  readonly runtime: ProxmoxDeploymentRuntime;
}

export type CloudDeploymentRecord = AwsCloudDeploymentRecord | ProxmoxCloudDeploymentRecord;

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
  readonly securityGroupId: string;
  readonly securityGroupName: string | null;
  readonly vpcId: string | null;
  readonly rules: readonly AwsFirewallRule[];
}

export interface ListAwsFirewallRulesInput {
  readonly deploymentId: string;
}

export interface CreateAwsFirewallRuleInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly rule: AwsFirewallRuleSpec;
}

export interface UpdateAwsFirewallRuleInput extends CreateAwsFirewallRuleInput {
  readonly ruleId: string;
}

export interface DeleteAwsFirewallRuleInput {
  readonly deploymentId: string;
  readonly expectedRevision: number;
  readonly ruleId: string;
}

const AWS_ACCESS_KEY_SECRET_KEYS = ["accessKeyId", "secretAccessKey", "sessionToken", "sshPrivateKey", "sshPassphrase"] as const;
const AWS_PROFILE_SECRET_KEYS = ["profileName", "sshPrivateKey", "sshPassphrase"] as const;
const PROXMOX_SECRET_KEYS = ["endpoint", "tokenId", "tokenSecret", "tlsCaCertificate", "sshPrivateKey", "sshPassphrase"] as const;
const CREATE_AWS_ACCESS_KEY_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "sshPrivateKeyToken", "accessKeyId", "secretAccessKey", "sessionToken", "sshPassphrase"] as const;
const CREATE_AWS_PROFILE_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "sshPrivateKeyToken", "profileName", "sshPassphrase"] as const;
const CREATE_PROXMOX_CREDENTIAL_KEYS = ["provider", "label", "sshUsername", "sshPrivateKeyToken", "endpoint", "tokenId", "tokenSecret", "tlsCaCertificate", "sshPassphrase"] as const;
const RESOLVED_CREDENTIAL_KEYS = ["provider", "label", "defaultRegion", "sshUsername", "secret"] as const;
const RESOLVED_PROXMOX_CREDENTIAL_KEYS = ["provider", "label", "sshUsername", "secret"] as const;
const AWS_ACCESS_KEY_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "defaultRegion", "sshUsername"] as const;
const AWS_PROFILE_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "defaultRegion", "sshUsername", "profileName"] as const;
const PROXMOX_SUMMARY_KEYS = ["id", "provider", "label", "persistence", "createdAt", "endpoint", "sshUsername"] as const;
const LEGACY_AWS_SPEC_KEYS = ["region", "imageId", "instanceType", "subnetId", "vpcId", "keyPairName", "operatorName", "sshPort", "multiplayerPort", "volumeSizeGiB", "useElasticIp", "sshCidrs", "operatorCidrs"] as const;
const AWS_SPEC_KEYS = ["region", "imageId", "instanceType", "subnetId", "vpcId", "networkMode", "managedVpcCidr", "managedSubnetCidr", "sshKeyMode", "existingKeyPairName", "sshUsername", "keyPairName", "operatorName", "sshPort", "multiplayerPort", "volumeSizeGiB", "useElasticIp", "sshCidrs", "operatorCidrs"] as const;
const PROXMOX_SPEC_KEYS = ["node", "templateVmId", "vmId", "storage", "bridge", "cores", "memoryMiB", "diskGiB", "operatorName", "sshPort", "multiplayerPort", "ipConfig", "gateway", "sshCidrs", "operatorCidrs"] as const;
const CREATE_DEPLOYMENT_KEYS = ["provider", "expectedRevision", "credentialId", "name", "spec"] as const;
const ASSET_KEYS = ["resourceType", "resourceId", "displayName", "tagged"] as const;
const RECORD_KEYS = ["id", "name", "credentialId", "status", "phase", "createdAt", "updatedAt", "operatorConfigFileName", "operatorConfigDigest", "remoteHost", "lastError", "managedAssets", "provider", "spec", "runtime"] as const;
const LEGACY_AWS_RUNTIME_KEYS = ["instanceId", "securityGroupIds", "volumeIds", "networkInterfaceIds", "publicIpAddress", "privateIpAddress", "availabilityZone", "elasticIpAllocationId"] as const;
const AWS_RUNTIME_KEYS = ["instanceId", "securityGroupIds", "volumeIds", "networkInterfaceIds", "publicIpAddress", "privateIpAddress", "availabilityZone", "elasticIpAllocationId", "vpcId", "subnetId", "internetGatewayId", "routeTableId", "routeTableAssociationId"] as const;
const AWS_RUNTIME_WITH_STATUS_KEYS = [...AWS_RUNTIME_KEYS, "instanceState", "instanceHealth", "systemHealth"] as const;
const PROXMOX_RUNTIME_KEYS = ["vmId", "node", "ipAddress"] as const;
const STATE_KEYS = ["v", "revision", "deployments"] as const;
const UPDATE_KEYS = ["expectedRevision", "deployment"] as const;
const DELETE_KEYS = ["expectedRevision", "deploymentId"] as const;
const ACTION_KEYS = ["deploymentId", "expectedRevision", "action"] as const;
const FIREWALL_KEYS = ["deploymentId", "expectedRevision", "sshCidrs", "operatorCidrs"] as const;
const AWS_FIREWALL_RULE_KEYS = ["direction", "protocol", "fromPort", "toPort", "peerType", "peer", "description"] as const;
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
const AWS_ASSET_TYPES = new Set<AwsManagedAssetType>(["ec2-instance", "ec2-volume", "ec2-network-interface", "ec2-security-group", "ec2-key-pair", "ec2-elastic-ip", "ec2-vpc", "ec2-subnet", "ec2-internet-gateway", "ec2-route-table", "ec2-route-table-association"]);
const PROXMOX_ASSET_TYPES = new Set<ProxmoxManagedAssetType>(["proxmox-vm"]);

export function parseAwsCredentialSecret(value: unknown): AwsCredentialSecret {
  if (hasExactKeys(value, AWS_PROFILE_SECRET_KEYS)) {
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    if (
      !isAwsProfileName(value["profileName"]) ||
      !isSshPrivateKey(value["sshPrivateKey"]) ||
      sshPassphrase === undefined
    ) throw invalid("AWS profile credential secret");
    return Object.freeze({
      profileName: value["profileName"],
      sshPrivateKey: value["sshPrivateKey"],
      sshPassphrase,
    });
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

export function parseProxmoxCredentialSecret(value: unknown): ProxmoxCredentialSecret {
  if (!hasExactKeys(value, PROXMOX_SECRET_KEYS)) throw invalid("Proxmox credential secret");
  const tlsCaCertificate = nullableTlsCaCertificate(value["tlsCaCertificate"]);
  const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
  if (
    !isHttpsEndpoint(value["endpoint"]) ||
    !boundedSecret(value["tokenId"], 3, 512) ||
    !boundedSecret(value["tokenSecret"], 1, 16_384) ||
    tlsCaCertificate === undefined ||
    !isSshPrivateKey(value["sshPrivateKey"]) ||
    sshPassphrase === undefined
  ) throw invalid("Proxmox credential secret");
  return Object.freeze({
    endpoint: value["endpoint"],
    tokenId: value["tokenId"],
    tokenSecret: value["tokenSecret"],
    tlsCaCertificate,
    sshPrivateKey: value["sshPrivateKey"],
    sshPassphrase,
  });
}

export function parseCreateCloudCredentialInput(value: unknown): CreateCloudCredentialInput {
  if (!isRecord(value)) throw invalid("cloud credential");
  if (value["provider"] === "aws") {
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
  if (value["provider"] === "proxmox") {
    if (!hasExactKeys(value, CREATE_PROXMOX_CREDENTIAL_KEYS)) throw invalid("Proxmox cloud credential");
    const sshPassphrase = nullableSecret(value["sshPassphrase"], 4_096);
    const tlsCaCertificate = nullableTlsCaCertificate(value["tlsCaCertificate"]);
    if (!boundedLabel(value["label"]) || !isSshUsername(value["sshUsername"]) || !isNullableSshPrivateKeyToken(value["sshPrivateKeyToken"]) || !isHttpsEndpoint(value["endpoint"]) || !boundedSecret(value["tokenId"], 3, 512) || !boundedSecret(value["tokenSecret"], 1, 16_384) || tlsCaCertificate === undefined || sshPassphrase === undefined || (value["sshPrivateKeyToken"] === null && sshPassphrase !== null)) throw invalid("Proxmox cloud credential");
    return Object.freeze({ provider: "proxmox", label: value["label"], sshUsername: value["sshUsername"], sshPrivateKeyToken: value["sshPrivateKeyToken"], endpoint: value["endpoint"], tokenId: value["tokenId"], tokenSecret: value["tokenSecret"], tlsCaCertificate, sshPassphrase });
  }
  throw invalid("cloud credential");
}

export function parseResolvedCloudCredentialInput(value: unknown): ResolvedCloudCredentialInput {
  if (!isRecord(value)) throw invalid("resolved cloud credential");
  if (value["provider"] === "aws") {
    if (!hasExactKeys(value, RESOLVED_CREDENTIAL_KEYS) || !boundedLabel(value["label"]) || !isAwsRegion(value["defaultRegion"]) || !isSshUsername(value["sshUsername"])) throw invalid("resolved AWS cloud credential");
    return Object.freeze({ provider: "aws", label: value["label"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], secret: parseAwsCredentialSecret(value["secret"]) });
  }
  if (value["provider"] === "proxmox") {
    if (!hasExactKeys(value, RESOLVED_PROXMOX_CREDENTIAL_KEYS) || !boundedLabel(value["label"]) || !isSshUsername(value["sshUsername"])) throw invalid("resolved Proxmox cloud credential");
    return Object.freeze({ provider: "proxmox", label: value["label"], sshUsername: value["sshUsername"], secret: parseProxmoxCredentialSecret(value["secret"]) });
  }
  throw invalid("resolved cloud credential");
}

export function parseCloudCredentialSummary(value: unknown): CloudCredentialSummary {
  if (!isRecord(value)) throw invalid("cloud credential summary");
  if (value["provider"] === "aws") {
    if (hasExactKeys(value, AWS_PROFILE_SUMMARY_KEYS) && isUuidV4(value["id"]) && boundedLabel(value["label"]) && isCredentialPersistence(value["persistence"]) && isIsoTimestamp(value["createdAt"]) && isAwsRegion(value["defaultRegion"]) && isSshUsername(value["sshUsername"]) && isAwsProfileName(value["profileName"])) {
      return Object.freeze({ id: value["id"], provider: "aws", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"], profileName: value["profileName"] });
    }
    if (hasExactKeys(value, AWS_ACCESS_KEY_SUMMARY_KEYS) && isUuidV4(value["id"]) && boundedLabel(value["label"]) && isCredentialPersistence(value["persistence"]) && isIsoTimestamp(value["createdAt"]) && isAwsRegion(value["defaultRegion"]) && isSshUsername(value["sshUsername"])) {
      return Object.freeze({ id: value["id"], provider: "aws", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], defaultRegion: value["defaultRegion"], sshUsername: value["sshUsername"] });
    }
    throw invalid("AWS cloud credential summary");
  }
  if (value["provider"] === "proxmox") {
    if (!hasExactKeys(value, PROXMOX_SUMMARY_KEYS) || !isUuidV4(value["id"]) || !boundedLabel(value["label"]) || !isCredentialPersistence(value["persistence"]) || !isIsoTimestamp(value["createdAt"]) || !isHttpsEndpoint(value["endpoint"]) || !isSshUsername(value["sshUsername"])) throw invalid("Proxmox cloud credential summary");
    return Object.freeze({ id: value["id"], provider: "proxmox", label: value["label"], persistence: value["persistence"], createdAt: value["createdAt"], endpoint: value["endpoint"], sshUsername: value["sshUsername"] });
  }
  throw invalid("cloud credential summary");
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

export function parseProxmoxDeploymentSpec(value: unknown): ProxmoxDeploymentSpec {
  if (!hasExactKeys(value, PROXMOX_SPEC_KEYS)) throw invalid("Proxmox deployment specification");
  const sshCidrs = parseIngressCidrs(value["sshCidrs"]);
  const operatorCidrs = parseIngressCidrs(value["operatorCidrs"]);
  const vmId = nullableInteger(value["vmId"], 100, 999_999_999);
  if (!boundedIdentifier(value["node"], 1, 128) || !boundedInteger(value["templateVmId"], 100, 999_999_999) || vmId === undefined || !boundedIdentifier(value["storage"], 1, 128) || !boundedIdentifier(value["bridge"], 1, 128) || !boundedInteger(value["cores"], 1, 256) || !boundedInteger(value["memoryMiB"], 512, 1_048_576) || !boundedInteger(value["diskGiB"], 8, 16_384) || !isOperatorName(value["operatorName"]) || !isPort(value["sshPort"]) || !isPort(value["multiplayerPort"]) || value["sshPort"] === value["multiplayerPort"] || !isProxmoxIpv4Config(value["ipConfig"]) || !isNullableIpv4Address(value["gateway"]) || (value["ipConfig"] === "ip=dhcp" && value["gateway"] !== null) || (typeof value["ipConfig"] === "string" && value["ipConfig"].includes(",gw=") && value["gateway"] !== null)) throw invalid("Proxmox deployment specification");
  return Object.freeze({ node: value["node"], templateVmId: value["templateVmId"], vmId, storage: value["storage"], bridge: value["bridge"], cores: value["cores"], memoryMiB: value["memoryMiB"], diskGiB: value["diskGiB"], operatorName: value["operatorName"], sshPort: value["sshPort"], multiplayerPort: value["multiplayerPort"], ipConfig: value["ipConfig"], gateway: value["gateway"], sshCidrs, operatorCidrs });
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
  if (value["provider"] === "proxmox") return Object.freeze({ provider: "proxmox", expectedRevision: value["expectedRevision"], credentialId: value["credentialId"], name: value["name"], spec: parseProxmoxDeploymentSpec(value["spec"]) });
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
  if (value["provider"] === "proxmox") {
    if (!hasOnlyAssetTypes(managedAssets, PROXMOX_ASSET_TYPES)) throw invalid("Proxmox cloud deployment record");
    return Object.freeze({ id: value["id"], provider: "proxmox", name: value["name"], credentialId: value["credentialId"], status: value["status"], phase: value["phase"], createdAt: value["createdAt"], updatedAt: value["updatedAt"], operatorConfigFileName: value["operatorConfigFileName"], operatorConfigDigest: value["operatorConfigDigest"], remoteHost: value["remoteHost"], lastError: value["lastError"], managedAssets, spec: parseProxmoxDeploymentSpec(value["spec"]), runtime: parseProxmoxDeploymentRuntime(value["runtime"]) });
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

export function parseListAwsFirewallRulesInput(value: unknown): ListAwsFirewallRulesInput {
  if (!hasExactKeys(value, LIST_AWS_FIREWALL_RULES_KEYS) || !isUuidV4(value["deploymentId"])) {
    throw invalid("AWS firewall rule list request");
  }
  return Object.freeze({ deploymentId: value["deploymentId"] });
}

export function parseCreateAwsFirewallRuleInput(value: unknown): CreateAwsFirewallRuleInput {
  if (
    !hasExactKeys(value, CREATE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"])
  ) throw invalid("AWS firewall rule creation");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    rule: parseAwsFirewallRuleSpec(value["rule"]),
  });
}

export function parseUpdateAwsFirewallRuleInput(value: unknown): UpdateAwsFirewallRuleInput {
  if (
    !hasExactKeys(value, UPDATE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"]) ||
    !isAwsSecurityGroupRuleId(value["ruleId"])
  ) throw invalid("AWS firewall rule update");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    rule: parseAwsFirewallRuleSpec(value["rule"]),
    ruleId: value["ruleId"],
  });
}

export function parseDeleteAwsFirewallRuleInput(value: unknown): DeleteAwsFirewallRuleInput {
  if (
    !hasExactKeys(value, DELETE_AWS_FIREWALL_RULE_KEYS) ||
    !isUuidV4(value["deploymentId"]) ||
    !isRevision(value["expectedRevision"]) ||
    !isAwsSecurityGroupRuleId(value["ruleId"])
  ) throw invalid("AWS firewall rule deletion");
  return Object.freeze({
    deploymentId: value["deploymentId"],
    expectedRevision: value["expectedRevision"],
    ruleId: value["ruleId"],
  });
}

export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
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

function parseProxmoxDeploymentRuntime(value: unknown): ProxmoxDeploymentRuntime {
  const vmId = isRecord(value) ? nullableInteger(value["vmId"], 100, 999_999_999) : undefined;
  if (!hasExactKeys(value, PROXMOX_RUNTIME_KEYS) || vmId === undefined || !boundedIdentifier(value["node"], 1, 128) || !nullableBoundedPlain(value["ipAddress"], 1, 255)) throw invalid("Proxmox deployment runtime");
  return Object.freeze({ vmId, node: value["node"], ipAddress: value["ipAddress"] });
}

function parseCloudManagedAsset(value: unknown): CloudManagedAsset {
  if (!hasExactKeys(value, ASSET_KEYS) || typeof value["resourceType"] !== "string" || (!AWS_ASSET_TYPES.has(value["resourceType"] as AwsManagedAssetType) && !PROXMOX_ASSET_TYPES.has(value["resourceType"] as ProxmoxManagedAssetType)) || !boundedPlain(value["resourceId"], 1, 512) || !nullableBoundedPlain(value["displayName"], 1, 255) || typeof value["tagged"] !== "boolean") throw invalid("cloud managed asset");
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

function isAwsFirewallCidr(value: unknown, ipv6: boolean): value is string {
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

function isProxmoxIpv4Config(value: unknown): value is string {
  if (value === "ip=dhcp") return true;
  if (typeof value !== "string") return false;
  const match = /^ip=([^/]+)\/(\d{1,2})(?:,gw=([^,]+))?$/u.exec(value);
  if (!match || !isIpv4Address(match[1]) || Number(match[2]) > 32) return false;
  return match[3] === undefined || isIpv4Address(match[3]);
}

function isNullableIpv4Address(value: unknown): value is string | null {
  return value === null || isIpv4Address(value);
}

function isIpv4Address(value: unknown): value is string {
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
  const address = ipv4AddressNumber(match[1]);
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

function isHttpsEndpoint(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || value.trim() !== value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "" && parsed.search === "" && parsed.hostname !== "";
  } catch {
    return false;
  }
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

function isSshUsername(value: unknown): value is string {
  return boundedPattern(value, 1, 64, /^[a-z_][a-z0-9_-]*[$]?$/u);
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

function nullableTlsCaCertificate(value: unknown): string | null | undefined {
  return value === null
    ? null
    : boundedSecret(value, 32, 256 * 1024) && /^-----BEGIN CERTIFICATE-----/u.test(value)
      ? value
      : undefined;
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
