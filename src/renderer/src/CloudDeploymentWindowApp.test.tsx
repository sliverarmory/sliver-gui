import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AwsCloudDeploymentRecord,
  AwsFirewallSnapshot,
  AzureCloudDeploymentRecord,
  AzureFirewallSnapshot,
  CloudCredentialSummary,
  CloudFirewallSnapshot,
  CreateCloudCredentialInput,
  CreateCloudDeploymentInput,
} from "../../shared/cloud-deployment-contracts";
import type {
  CloudDeploymentAPI,
  CloudDeploymentChangeScope,
  CloudDeploymentNavigationRequest,
  CloudDeploymentSnapshot,
  CurrentEgressIpv4,
} from "../../shared/cloud-deployment-ipc";
import type { AwsDeploymentOptions, AzureDeploymentOptions, DiscoverAwsOptionsInput } from "../../shared/cloud-provider-inventory";
import type { OperationResult } from "../../shared/contracts";
import type { SshHostKeyReview, SshOpenTabResult } from "../../shared/ssh-contracts";
import { CloudDeploymentWindowApp } from "./CloudDeploymentWindowApp";

vi.mock("./components/CloudProvisioningTerminal", () => ({
  CloudProvisioningTerminal: ({ transcript }: {
    readonly transcript?: CloudDeploymentSnapshot["provisioningTranscripts"][number];
  }) => (
    <div aria-label="Mock read-only SSH provisioning terminal" data-read-only="true">
      {transcript && transcript.chunks.length > 0
        ? transcript.chunks.map(({ bytes }) => new TextDecoder().decode(bytes)).join("")
        : "Waiting for SSH"}
    </div>
  ),
}));

const CREDENTIAL_ID = "0f24a4da-28c1-4d94-a66d-eb224892745d";
const AZURE_CREDENTIAL_ID = "a4e47541-6084-4d13-a103-31b9aa879839";
const DEPLOYMENT_ID = "a48987b1-7b88-46dc-b72b-7f34dd5e0e92";
const AZURE_DEPLOYMENT_ID = "f208145e-76d9-49a9-8a40-f83b817971fe";
const AZURE_SUBSCRIPTION_ID = "11111111-2222-3333-4444-555555555555";
const AZURE_TENANT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const KEY_TOKEN = "2b1cbf1a-6861-4db8-a39d-ffbdad8087f8";
const LOGIN_SESSION_ARN = "arn:aws:iam::123456789012:user/operator";
const CONSOLE_PROFILE_AUTHENTICATION = { method: "console-login", canConsoleLogin: true } as const;
const AZURE_LOGIN_TOKEN = "c9b06d16-8a57-427f-a9de-c762c3f45f8c";
const SSH_REVIEW_TOKEN = "r".repeat(43);

let currentSnapshot: CloudDeploymentSnapshot;
let themeListener: ((dark: boolean) => void) | undefined;
let changedListener: ((scope: CloudDeploymentChangeScope) => void) | undefined;
let navigationListener: ((request: CloudDeploymentNavigationRequest) => void) | undefined;
let capturedCredential: CreateCloudCredentialInput | undefined;
let capturedDeployment: CreateCloudDeploymentInput | undefined;
let currentFirewallSnapshot: CloudFirewallSnapshot;
const unsubscribeTheme = vi.fn();
const unsubscribeChanged = vi.fn();
const unsubscribeNavigation = vi.fn();

const awsCredential = {
  id: CREDENTIAL_ID,
  provider: "aws" as const,
  label: "Production AWS",
  persistence: "secure" as const,
  createdAt: "2026-09-06T18:00:00.000Z",
  defaultRegion: "us-east-1",
  sshUsername: "ubuntu",
};

const azureAccount = {
  subscriptionId: AZURE_SUBSCRIPTION_ID,
  name: "Operator Subscription",
  tenantId: AZURE_TENANT_ID,
  homeTenantId: AZURE_TENANT_ID,
  isDefault: true,
  cloudName: "AzureCloud",
};

const azureCredential = {
  id: AZURE_CREDENTIAL_ID,
  provider: "azure" as const,
  label: "Production Azure",
  persistence: "secure" as const,
  createdAt: "2026-09-06T18:00:00.000Z",
  defaultLocation: "eastus",
  subscriptionId: AZURE_SUBSCRIPTION_ID,
  tenantId: AZURE_TENANT_ID,
  sshUsername: "azureuser",
};

const runningDeployment: AwsCloudDeploymentRecord = {
  id: DEPLOYMENT_ID,
  provider: "aws",
  name: "range-control",
  credentialId: CREDENTIAL_ID,
  status: "running",
  phase: "ready",
  createdAt: "2026-09-06T18:00:00.000Z",
  updatedAt: "2026-09-06T18:05:00.000Z",
  operatorConfigFileName: "sliver-gui-cloud-range.cfg",
  operatorConfigDigest: "a".repeat(64),
  remoteHost: "198.51.100.24",
  lastError: null,
  managedAssets: [{ resourceType: "ec2-instance", resourceId: "i-abc123", displayName: "range-control", tagged: true }],
  spec: {
    region: "us-east-1",
    imageId: "ami-0123456789abcdef0",
    instanceType: "t3.small",
    subnetId: "subnet-0123456789abcdef0",
    vpcId: "vpc-0123456789abcdef0",
    networkMode: "existing",
    managedVpcCidr: null,
    managedSubnetCidr: null,
    sshKeyMode: "managed",
    existingKeyPairName: null,
    sshUsername: "ubuntu",
    keyPairName: "operator-key",
    operatorName: "operator",
    sshPort: 22,
    multiplayerPort: 31337,
    volumeSizeGiB: 20,
    useElasticIp: true,
    sshCidrs: ["203.0.113.8/32"],
    operatorCidrs: ["203.0.113.8/32"],
  },
  runtime: {
    instanceId: "i-abc123",
    instanceState: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    securityGroupIds: ["sg-abc123"],
    networkInterfaceIds: ["eni-abc123"],
    volumeIds: ["vol-abc123"],
    publicIpAddress: "198.51.100.24",
    privateIpAddress: "10.0.0.24",
    availabilityZone: "us-east-1a",
    elasticIpAllocationId: "eipalloc-abc123",
    vpcId: "vpc-0123456789abcdef0",
    subnetId: "subnet-0123456789abcdef0",
    internetGatewayId: null,
    routeTableId: null,
    routeTableAssociationId: null,
  },
};

const sshHostKeyReview: SshHostKeyReview = {
  token: SSH_REVIEW_TOKEN,
  deploymentId: DEPLOYMENT_ID,
  name: "range-control",
  host: "198.51.100.24",
  port: 22,
  fingerprint: `SHA256:${"A".repeat(43)}`,
  expiresAt: "2026-09-07T19:00:00.000Z",
};

const firewallSnapshot: AwsFirewallSnapshot = {
  provider: "aws",
  securityGroupId: "sg-abc123",
  securityGroupName: "sliver-gui-range-control",
  vpcId: "vpc-0123456789abcdef0",
  rules: [
    {
      id: "sgr-11111111111111111",
      managed: true,
      direction: "ingress",
      protocol: "tcp",
      fromPort: 22,
      toPort: 22,
      peerType: "ipv4",
      peer: "203.0.113.8/32",
      description: "Operator SSH",
    },
    {
      id: "sgr-22222222222222222",
      managed: false,
      direction: "egress",
      protocol: "-1",
      fromPort: null,
      toPort: null,
      peerType: "ipv4",
      peer: "0.0.0.0/0",
      description: null,
    },
  ],
};

const runningAzureDeployment: AzureCloudDeploymentRecord = {
  id: AZURE_DEPLOYMENT_ID,
  provider: "azure",
  name: "azure-control",
  credentialId: AZURE_CREDENTIAL_ID,
  status: "running",
  phase: "ready",
  createdAt: "2026-09-06T18:00:00.000Z",
  updatedAt: "2026-09-06T18:05:00.000Z",
  operatorConfigFileName: "sliver-gui-cloud-azure.cfg",
  operatorConfigDigest: "c".repeat(64),
  remoteHost: "203.0.113.42",
  lastError: null,
  managedAssets: [{
    resourceType: "azure-virtual-machine",
    resourceId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui/providers/Microsoft.Compute/virtualMachines/azure-control",
    displayName: "azure-control",
    tagged: true,
  }],
  spec: {
    location: "eastus",
    imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
    vmSize: "Standard_B2s",
    networkMode: "managed",
    vnetId: null,
    subnetId: null,
    managedVnetCidr: "10.0.0.0/16",
    managedSubnetCidr: "10.0.1.0/24",
    sshUsername: "azureuser",
    operatorName: "operator",
    sshPort: 22,
    multiplayerPort: 31337,
    osDiskSizeGiB: 30,
    usePublicIp: true,
    sshCidrs: ["203.0.113.8/32"],
    operatorCidrs: ["203.0.113.8/32"],
  },
  runtime: {
    resourceGroupName: "sliver-gui-azure-control",
    vmName: "azure-control",
    vmId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Compute/virtualMachines/azure-control",
    instanceState: "running",
    provisioningState: "Succeeded",
    networkSecurityGroupId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Network/networkSecurityGroups/azure-control-nsg",
    networkInterfaceId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Network/networkInterfaces/azure-control-nic",
    osDiskId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Compute/disks/azure-control-os",
    publicIpAddressId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Network/publicIPAddresses/azure-control-ip",
    publicIpAddress: "203.0.113.42",
    privateIpAddress: "10.0.1.4",
    vnetId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Network/virtualNetworks/azure-control-vnet",
    subnetId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/sliver-gui-azure-control/providers/Microsoft.Network/virtualNetworks/azure-control-vnet/subnets/default",
  },
};

const azureFirewallSnapshot: AzureFirewallSnapshot = {
  provider: "azure",
  networkSecurityGroupId: runningAzureDeployment.runtime.networkSecurityGroupId!,
  networkSecurityGroupName: "azure-control-nsg",
  resourceGroupName: "sliver-gui-azure-control",
  rules: [
    {
      id: `${runningAzureDeployment.runtime.networkSecurityGroupId}/securityRules/allow-admin`,
      name: "allow-admin",
      priority: 1_200,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: ["203.0.113.8/32"],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: ["22"],
      description: "Operator SSH",
      managed: true,
      isDefault: false,
      sourceApplicationSecurityGroupIds: [],
      destinationApplicationSecurityGroupIds: [],
      editUnsupportedReason: null,
    },
    {
      id: `${runningAzureDeployment.runtime.networkSecurityGroupId}/securityRules/sliver-gui-ssh-001`,
      name: "sliver-gui-ssh-001",
      priority: 1_000,
      direction: "ingress",
      access: "allow",
      protocol: "tcp",
      sourceAddressPrefixes: ["203.0.113.8/32"],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: ["22"],
      description: `sliver-gui:${AZURE_DEPLOYMENT_ID}:baseline:ssh`,
      managed: true,
      isDefault: false,
      sourceApplicationSecurityGroupIds: [],
      destinationApplicationSecurityGroupIds: [],
      editUnsupportedReason: null,
    },
    {
      id: `${runningAzureDeployment.runtime.networkSecurityGroupId}/defaultSecurityRules/DenyAllInBound`,
      name: "DenyAllInBound",
      priority: 65500,
      direction: "ingress",
      access: "deny",
      protocol: "*",
      sourceAddressPrefixes: ["*"],
      sourcePortRanges: ["*"],
      destinationAddressPrefixes: ["*"],
      destinationPortRanges: ["*"],
      description: "Default rule",
      managed: false,
      isDefault: true,
      sourceApplicationSecurityGroupIds: [],
      destinationApplicationSecurityGroupIds: [],
      editUnsupportedReason: null,
    },
  ],
};

const awsDeploymentOptions: AwsDeploymentOptions = {
  region: "us-east-1",
  instanceTypes: [
    { name: "t3.micro", architecture: "x86_64", vCpuCount: 2, memoryMiB: 1_024, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.small", architecture: "x86_64", vCpuCount: 2, memoryMiB: 2_048, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.medium", architecture: "x86_64", vCpuCount: 2, memoryMiB: 4_096, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.large", architecture: "x86_64", vCpuCount: 2, memoryMiB: 8_192, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t3.xlarge", architecture: "x86_64", vCpuCount: 4, memoryMiB: 16_384, processor: "Intel Xeon", description: "Burstable x86 compute" },
    { name: "t4g.micro", architecture: "arm64", vCpuCount: 2, memoryMiB: 1_024, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.small", architecture: "arm64", vCpuCount: 2, memoryMiB: 2_048, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.medium", architecture: "arm64", vCpuCount: 2, memoryMiB: 4_096, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.large", architecture: "arm64", vCpuCount: 2, memoryMiB: 8_192, processor: "AWS Graviton2", description: "Burstable Arm compute" },
    { name: "t4g.xlarge", architecture: "arm64", vCpuCount: 4, memoryMiB: 16_384, processor: "AWS Graviton2", description: "Burstable Arm compute" },
  ],
  images: [
    { id: "ami-11111111111111111", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-amd64-server", description: "Ubuntu Server 24.04 LTS", architecture: "x86_64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
    { id: "ami-22222222222222222", name: "al2023-ami-2023-x86_64", description: "Amazon Linux 2023", architecture: "x86_64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
    { id: "ami-aaaaaaaaaaaaaaaaa", name: "ubuntu/images/hvm-ssd/ubuntu-noble-24.04-arm64-server", description: "Ubuntu Server 24.04 LTS", architecture: "arm64", rootDeviceName: "/dev/sda1", distribution: "ubuntu", version: "24.04 LTS", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ubuntu" },
    { id: "ami-bbbbbbbbbbbbbbbbb", name: "al2023-ami-2023-arm64", description: "Amazon Linux 2023", architecture: "arm64", rootDeviceName: "/dev/xvda", distribution: "amazon-linux", version: "2023", creationDate: "2026-09-01T00:00:00.000Z", sshUsername: "ec2-user" },
  ],
  vpcs: [
    { id: "vpc-0123456789abcdef0", name: "default", cidrBlock: "172.31.0.0/16", isDefault: true },
    { id: "vpc-11111111111111111", name: "operations", cidrBlock: "10.20.0.0/16", isDefault: false },
  ],
  subnets: [
    { id: "subnet-0123456789abcdef0", name: "default-public", vpcId: "vpc-0123456789abcdef0", cidrBlock: "172.31.16.0/20", availabilityZone: "us-east-1a", mapPublicIpOnLaunch: true },
    { id: "subnet-11111111111111111", name: "operations-private", vpcId: "vpc-11111111111111111", cidrBlock: "10.20.1.0/24", availabilityZone: "us-east-1b", mapPublicIpOnLaunch: false },
  ],
  keyPairs: [
    { name: "operator-existing", id: "key-0123456789abcdef0", fingerprint: "SHA256:abcdefghijklmnopqrstuv", keyType: "ed25519", isCredentialMatch: true },
    { name: "__sliver_managed_key__", id: "key-22222222222222222", fingerprint: "SHA256:abcdefghijklmnopqrstuv", keyType: "ed25519", isCredentialMatch: true },
    { name: "unusable-key", id: "key-11111111111111111", fingerprint: "SHA256:does-not-match", keyType: "rsa", isCredentialMatch: false },
  ],
  credentialKey: {
    type: "ed25519",
    fingerprint: "SHA256:abcdefghijklmnopqrstuv",
    matchingKeyPairNames: ["operator-existing", "__sliver_managed_key__"],
  },
};

const azureDeploymentOptions: AzureDeploymentOptions = {
  location: "eastus",
  vmSizes: [{ name: "Standard_B2s", vCpuCount: 2, memoryMiB: 4_096 }],
  images: [{
    reference: "Canonical:ubuntu-24_04-lts:server:latest",
    label: "Ubuntu Server 24.04 LTS",
    architecture: "x64",
    sshUsername: "azureuser",
  }],
  virtualNetworks: [{
    id: runningAzureDeployment.runtime.vnetId!,
    name: "operations",
    resourceGroupName: "networking",
    location: "eastus",
    addressPrefixes: ["10.20.0.0/16"],
  }],
  subnets: [{
    id: runningAzureDeployment.runtime.subnetId!,
    name: "default",
    vnetId: runningAzureDeployment.runtime.vnetId!,
    resourceGroupName: "networking",
    addressPrefixes: ["10.20.1.0/24"],
  }],
};

const emptySnapshot: CloudDeploymentSnapshot = {
  state: { v: 1, revision: 0, deployments: [] },
  credentials: [],
  refreshErrors: [],
  secureCredentialStorage: true,
  awsProfiles: [],
  awsProfileDiscoveryError: null,
  azureAccounts: [azureAccount],
  azureAccountDiscoveryError: null,
  provisioningTranscripts: [],
};

const discoverAwsOptions = vi.fn(async (
  _input: DiscoverAwsOptionsInput,
): Promise<OperationResult<AwsDeploymentOptions>> => ({ ok: true, value: awsDeploymentOptions }));
const detectCurrentEgressIpv4 = vi.fn(async (): Promise<OperationResult<CurrentEgressIpv4>> => ({
  ok: false,
  error: "Current egress IPv4 could not be detected.",
}));

const api: CloudDeploymentAPI = {
  getSnapshot: vi.fn(async () => ({ ok: true as const, value: currentSnapshot })),
  refreshDeployments: vi.fn(async () => ({ ok: true as const, value: { state: currentSnapshot.state, refreshErrors: currentSnapshot.refreshErrors } })),
  getProvisioningTranscripts: vi.fn(async () => ({
    ok: true as const,
    value: { provisioningTranscripts: currentSnapshot.provisioningTranscripts },
  })),
  getTerminalRuntime: vi.fn(async () => ({
    ok: true as const,
    value: { version: "0.4.0" as const, sha256: "a".repeat(64), bytes: new Uint8Array([0, 97, 115, 109]) },
  })),
  detectCurrentEgressIpv4,
  chooseSshPrivateKey: vi.fn(async () => ({ ok: true as const, value: { token: KEY_TOKEN, fileName: "operator_ed25519" } })),
  createCredential: vi.fn(async (input) => {
    capturedCredential = structuredClone(input);
    if (input.provider === "azure") {
      return {
        ok: true as const,
        value: {
          id: AZURE_CREDENTIAL_ID,
          provider: "azure" as const,
          label: input.label,
          persistence: "secure" as const,
          createdAt: "2026-09-06T18:00:00.000Z",
          defaultLocation: input.defaultLocation,
          subscriptionId: input.subscriptionId,
          tenantId: input.tenantId,
          sshUsername: input.sshUsername,
          ...("authentication" in input && input.authentication === "login"
            ? { authentication: "login" as const, loginAccountId: "home-account-id" }
            : {}),
        },
      };
    }
    return {
      ok: true as const,
      value: {
        id: CREDENTIAL_ID,
        provider: "aws" as const,
        label: input.label,
        persistence: "secure" as const,
        createdAt: "2026-09-06T18:00:00.000Z",
        defaultRegion: input.defaultRegion,
        sshUsername: input.sshUsername,
        ...("profileName" in input ? { profileName: input.profileName } : {}),
        ...("authentication" in input && input.authentication === "login" ? { loginSessionArn: LOGIN_SESSION_ARN } : {}),
      },
    };
  }),
  openAwsConsole: vi.fn(async () => ({ ok: true as const })),
  loginAwsCredential: vi.fn(async () => ({ ok: true as const, value: { ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN } })),
  cancelAwsLogin: vi.fn(async () => ({ ok: true as const })),
  copyAwsLoginLink: vi.fn(async () => ({ ok: true as const })),
  copyInstanceId: vi.fn(async () => ({ ok: true as const })),
  copyIpAddress: vi.fn(async () => ({ ok: true as const })),
  beginAzureLogin: vi.fn(async () => ({ ok: true as const, value: {
    token: AZURE_LOGIN_TOKEN,
    expiresAt: "2026-09-08T20:00:00.000Z",
    subscriptions: [azureAccount],
  } })),
  loginAzureCredential: vi.fn(async () => ({ ok: true as const, value: { ...azureCredential, loginAccountId: "home-account-id" } })),
  cancelAzureLogin: vi.fn(async () => ({ ok: true as const })),
  deleteCredential: vi.fn(async () => ({ ok: true as const })),
  testCredential: vi.fn(async () => ({
    ok: true as const,
    value: {
      provider: "aws" as const,
      summary: "AWS identity and EC2 permissions verified.",
      permissions: { required: [], verified: [], missing: [], unverifiable: [] },
    },
  })),
  copyAwsPermissionsTerraform: vi.fn(async () => ({ ok: true as const })),
  discoverAwsOptions,
  discoverAzureAccounts: vi.fn(async () => ({ ok: true as const, value: [azureAccount] })),
  discoverAzureOptions: vi.fn(async () => ({ ok: true as const, value: azureDeploymentOptions })),
  createDeployment: vi.fn(async (input) => {
    capturedDeployment = structuredClone(input);
    return { ok: true as const, value: input.provider === "azure" ? runningAzureDeployment : runningDeployment };
  }),
  createOperatorConfig: vi.fn(async () => ({
    ok: true as const,
    value: { saved: true as const, fileName: "new-operator.cfg", mutationState: "created" as const },
  })),
  runLifecycleAction: vi.fn(async () => ({ ok: true as const, value: runningDeployment })),
  renameDeployment: vi.fn(async () => ({ ok: true as const, value: runningDeployment })),
  updateFirewall: vi.fn(async () => ({ ok: true as const, value: runningDeployment })),
  listFirewallRules: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  createFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  updateFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  deleteFirewallRule: vi.fn(async () => ({ ok: true as const, value: currentFirewallSnapshot })),
  listDnsZones: vi.fn(async () => ({ ok: true as const, value: [] })),
  listDnsRecords: vi.fn(async () => ({ ok: true as const, value: [] })),
  createDnsRecord: vi.fn(async () => ({ ok: true as const })),
  updateDnsRecord: vi.fn(async () => ({ ok: true as const })),
  deleteDnsRecord: vi.fn(async () => ({ ok: true as const })),
  prepareDestroyDeployment: vi.fn(async () => ({
    ok: true as const,
    value: {
      token: "destroy-token",
      deploymentId: DEPLOYMENT_ID,
      deploymentName: "range-control",
      provider: "aws" as const,
      expiresAt: "2026-09-06T19:00:00.000Z",
    },
  })),
  executeDestroyDeployment: vi.fn(async () => ({ ok: true as const, value: emptySnapshot.state })),
  openSshWindow: vi.fn(async (): Promise<OperationResult<SshOpenTabResult>> => ({
    ok: true,
    value: { status: "opened", tabId: "t".repeat(43), created: true },
  })),
  approveSshHostKey: vi.fn(async (): Promise<OperationResult<SshOpenTabResult>> => ({
    ok: true,
    value: { status: "opened", tabId: "t".repeat(43), created: true },
  })),
  onChanged: vi.fn((listener) => {
    changedListener = listener;
    return unsubscribeChanged;
  }),
  onNavigationRequested: vi.fn((listener) => {
    navigationListener = listener;
    return unsubscribeNavigation;
  }),
  onThemeChanged: vi.fn((listener) => {
    themeListener = listener;
    return unsubscribeTheme;
  }),
};

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(Element.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(Element.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
  Reflect.deleteProperty(Element.prototype, "hasPointerCapture");
});

beforeEach(() => {
  toast.clear();
  currentSnapshot = emptySnapshot;
  themeListener = undefined;
  changedListener = undefined;
  navigationListener = undefined;
  capturedCredential = undefined;
  capturedDeployment = undefined;
  currentFirewallSnapshot = firewallSnapshot;
  unsubscribeTheme.mockClear();
  unsubscribeChanged.mockClear();
  unsubscribeNavigation.mockClear();
  vi.mocked(api.getSnapshot).mockClear();
  vi.mocked(api.refreshDeployments).mockClear();
  vi.mocked(api.getProvisioningTranscripts).mockClear();
  vi.mocked(api.chooseSshPrivateKey).mockClear();
  vi.mocked(api.createCredential).mockClear();
  vi.mocked(api.loginAwsCredential).mockClear();
  vi.mocked(api.openAwsConsole).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.cancelAwsLogin).mockClear();
  vi.mocked(api.copyAwsLoginLink).mockClear();
  vi.mocked(api.copyInstanceId).mockReset();
  vi.mocked(api.copyInstanceId).mockResolvedValue({ ok: true });
  vi.mocked(api.copyIpAddress).mockReset();
  vi.mocked(api.copyIpAddress).mockResolvedValue({ ok: true });
  vi.mocked(api.copyAwsPermissionsTerraform).mockReset();
  vi.mocked(api.copyAwsPermissionsTerraform).mockResolvedValue({ ok: true });
  vi.mocked(api.beginAzureLogin).mockClear();
  vi.mocked(api.loginAzureCredential).mockClear();
  vi.mocked(api.cancelAzureLogin).mockClear();
  detectCurrentEgressIpv4.mockClear();
  detectCurrentEgressIpv4.mockResolvedValue({
    ok: false,
    error: "Current egress IPv4 could not be detected.",
  });
  discoverAwsOptions.mockClear();
  discoverAwsOptions.mockResolvedValue({ ok: true, value: awsDeploymentOptions });
  vi.mocked(api.discoverAzureAccounts).mockClear();
  vi.mocked(api.discoverAzureAccounts).mockResolvedValue({ ok: true, value: [azureAccount] });
  vi.mocked(api.discoverAzureOptions).mockClear();
  vi.mocked(api.discoverAzureOptions).mockResolvedValue({ ok: true, value: azureDeploymentOptions });
  vi.mocked(api.createDeployment).mockClear();
  vi.mocked(api.createOperatorConfig).mockReset();
  vi.mocked(api.createOperatorConfig).mockResolvedValue({
    ok: true,
    value: { saved: true, fileName: "new-operator.cfg", mutationState: "created" },
  });
  vi.mocked(api.runLifecycleAction).mockClear();
  vi.mocked(api.renameDeployment).mockReset();
  vi.mocked(api.renameDeployment).mockResolvedValue({ ok: true, value: runningDeployment });
  vi.mocked(api.updateFirewall).mockClear();
  vi.mocked(api.listFirewallRules).mockClear();
  vi.mocked(api.createFirewallRule).mockClear();
  vi.mocked(api.updateFirewallRule).mockClear();
  vi.mocked(api.deleteFirewallRule).mockClear();
  vi.mocked(api.prepareDestroyDeployment).mockClear();
  vi.mocked(api.executeDestroyDeployment).mockClear();
  vi.mocked(api.openSshWindow).mockClear();
  vi.mocked(api.approveSshHostKey).mockClear();
  Object.defineProperty(window, "cloudDeployment", { configurable: true, value: Object.freeze(api) });
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  toast.clear();
  cleanup();
  Reflect.deleteProperty(window, "cloudDeployment");
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.colorScheme = "";
  vi.useRealTimers();
  Reflect.deleteProperty(document, "visibilityState");
});

function renderCloudDeploymentApp(): ReturnType<typeof render> {
  return render(
    <>
      <CloudDeploymentWindowApp />
      <Toast.Provider maxVisibleToasts={4} placement="bottom" />
    </>,
  );
}

async function openServerActions(
  user: ReturnType<typeof userEvent.setup>,
  deploymentName: string,
): Promise<HTMLElement> {
  await user.click(await screen.findByRole("button", { name: `Server actions for ${deploymentName}` }));
  return screen.findByRole("menu", { name: `Server actions for ${deploymentName}` });
}

describe("CloudDeploymentWindowApp", () => {
  it("loads an accessible standalone dashboard and responds to bounded native events", async () => {
    const view = renderCloudDeploymentApp();

    expect(await screen.findByRole("heading", { name: "Cloud Deployment" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Servers\s*0$/u })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /^DNS\s*0$/u })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Credentials/i })).toBeInTheDocument();
    expect(screen.getByText("No Managed Servers")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Deployment" })).toBeInTheDocument();
    expect(screen.queryByText("Encrypted credentials")).not.toBeInTheDocument();
    expect(document.title).toBe("Cloud Deployment");

    act(() => themeListener?.(false));
    expect(document.documentElement).toHaveClass("light");
    act(() => themeListener?.(true));
    expect(document.documentElement).toHaveClass("dark");

    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));

    view.unmount();
    expect(unsubscribeTheme).toHaveBeenCalledOnce();
    expect(unsubscribeChanged).toHaveBeenCalledOnce();
    expect(unsubscribeNavigation).toHaveBeenCalledOnce();
  });

  it("coalesces rapid deployment changes into one trailing snapshot refresh", async () => {
    const firstSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    const trailingSnapshot = deferred<OperationResult<CloudDeploymentSnapshot>>();
    vi.mocked(api.getSnapshot)
      .mockReturnValueOnce(firstSnapshot.promise)
      .mockReturnValueOnce(trailingSnapshot.promise);

    renderCloudDeploymentApp();
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledOnce());
    act(() => {
      changedListener?.("snapshot");
      changedListener?.("snapshot");
      changedListener?.("snapshot");
    });
    expect(api.getSnapshot).toHaveBeenCalledOnce();

    await act(async () => {
      firstSnapshot.resolve({ ok: true, value: emptySnapshot });
      await firstSnapshot.promise;
    });
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => {
      trailingSnapshot.resolve({ ok: true, value: emptySnapshot });
      await trailingSnapshot.promise;
    });
    expect(await screen.findByText("No Managed Servers")).toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("polls provider state every 30 seconds without rediscovering accounts or replacing form and firewall drafts", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledOnce());
    await user.click(screen.getByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Add Credential" }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Unsaved credential");
    const labelInput = screen.getByRole("textbox", { name: "Label" });
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [{
      ...runningDeployment, status: "stopped", phase: "stopped", remoteHost: "198.51.100.25",
      runtime: { ...runningDeployment.runtime, instanceState: "stopped", publicIpAddress: "198.51.100.25" },
    }] } };
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.refreshDeployments).toHaveBeenCalledTimes(2);
    expect(api.getSnapshot).toHaveBeenCalledOnce();
    expect(api.discoverAzureAccounts).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Label" })).toBe(labelInput);
    expect(labelInput).toHaveValue("Unsaved credential");
    await user.click(screen.getByRole("tab", { name: /Servers/i }));
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    await user.keyboard("{Escape}");
    expect(screen.getByText(/198\.51\.100\.25/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit firewall for range-control" }));
    await user.click(await screen.findByRole("button", { name: "Add rule" }));
    const sheet = await screen.findByRole("dialog", { name: "Add firewall rule" });
    await user.type(within(sheet).getByRole("textbox", { name: "Description" }), "Unsaved firewall edit");
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(api.refreshDeployments).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("dialog", { name: "Add firewall rule" })).toBe(sheet);
    expect(within(sheet).getByRole("textbox", { name: "Description" })).toHaveValue("Unsaved firewall edit");
  });

  it("pauses hidden polling, refreshes on visibility and focus, deduplicates requests and stops on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    currentSnapshot = runningCloudSnapshot();
    const firstRefresh = deferred<Awaited<ReturnType<CloudDeploymentAPI["refreshDeployments"]>>>();
    vi.mocked(api.refreshDeployments).mockReturnValueOnce(firstRefresh.promise);
    const view = renderCloudDeploymentApp();
    expect(await screen.findByText("range-control")).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.refreshDeployments).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledOnce());
    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.refreshDeployments).toHaveBeenCalledOnce();
    await act(async () => firstRefresh.resolve({ ok: true, value: { state: currentSnapshot.state, refreshErrors: [] } }));
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledTimes(2));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.refreshDeployments).toHaveBeenCalledTimes(2);
    view.unmount();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(api.refreshDeployments).toHaveBeenCalledTimes(2);
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it("keeps per-server read failures separate and clears them when a manual provider refresh succeeds", async () => {
    currentSnapshot = { ...runningCloudSnapshot(), state: { v: 1, revision: 9, deployments: [{
      ...runningDeployment, lastError: "Earlier provisioning step failed.",
    }] } };
    vi.mocked(api.refreshDeployments).mockResolvedValueOnce({ ok: true, value: {
      state: currentSnapshot.state, refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "AWS status is temporarily unavailable." }],
    } });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    expect(await screen.findByText("Status refresh failed")).toBeInTheDocument();
    expect(screen.getByText("Last operation failed")).toBeInTheDocument();
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [runningDeployment] } };
    await user.click(screen.getByRole("button", { name: "Refresh cloud deployments" }));
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Status refresh failed")).not.toBeInTheDocument();
    expect(screen.queryByText("Last operation failed")).not.toBeInTheDocument();
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Stop" })).toBeEnabled();
  });

  it("does not let an older provider response overwrite a newer snapshot or its same-revision read errors", async () => {
    currentSnapshot = { ...runningCloudSnapshot(), refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "Expired session" }] };
    const provider = deferred<Awaited<ReturnType<CloudDeploymentAPI["refreshDeployments"]>>>();
    vi.mocked(api.refreshDeployments).mockReturnValueOnce(provider.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledOnce());
    const stale = currentSnapshot;
    currentSnapshot = { ...currentSnapshot, refreshErrors: [] };
    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(screen.queryByText("Expired session")).not.toBeInTheDocument());
    await act(async () => provider.resolve({ ok: true, value: { state: stale.state, refreshErrors: stale.refreshErrors } }));
    expect(screen.queryByText("Expired session")).not.toBeInTheDocument();
    expect(api.refreshDeployments).toHaveBeenCalledOnce();

    const olderProvider = deferred<Awaited<ReturnType<CloudDeploymentAPI["refreshDeployments"]>>>();
    vi.mocked(api.refreshDeployments).mockReturnValueOnce(olderProvider.promise);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledTimes(2));
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [{
      ...runningDeployment, status: "stopped", phase: "stopped", runtime: { ...runningDeployment.runtime, instanceState: "stopped" },
    }] } };
    act(() => changedListener?.("snapshot"));
    let serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await act(async () => olderProvider.resolve({ ok: true, value: { state: stale.state, refreshErrors: stale.refreshErrors } }));
    serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    expect(screen.queryByText("Expired session")).not.toBeInTheDocument();
  });

  it("preserves a newer provider response when an older local snapshot completes later", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledOnce());
    const local = deferred<OperationResult<CloudDeploymentSnapshot>>();
    vi.mocked(api.getSnapshot).mockReturnValueOnce(local.promise);
    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));
    const stale = currentSnapshot;
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [{
      ...runningDeployment, status: "stopped", phase: "stopped", runtime: { ...runningDeployment.runtime, instanceState: "stopped" },
    }] } };
    act(() => window.dispatchEvent(new Event("focus")));
    let serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await act(async () => local.resolve({ ok: true, value: stale }));
    serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("tab", { name: /Credentials/i }));
    expect(screen.getByText("Production AWS")).toBeInTheDocument();
  });

  it("uses the provider state refreshed during login without issuing a duplicate remote request", async () => {
    currentSnapshot = { ...runningCloudSnapshot(), credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }],
      refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "The AWS login expired." }],
    };
    vi.mocked(api.refreshDeployments).mockResolvedValueOnce({ ok: false, error: "Provider refresh connection failed." });
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => {
      currentSnapshot = { ...currentSnapshot, refreshErrors: [], state: { v: 1, revision: 10, deployments: [{
        ...runningDeployment, status: "stopped", phase: "stopped", runtime: { ...runningDeployment.runtime, instanceState: "stopped" },
      }] } };
      return { ok: true, value: { ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION, loginSessionArn: LOGIN_SESSION_ARN } };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    expect(await screen.findByText(/Provider refresh connection failed/u)).toBeInTheDocument();
    const refreshMessage = screen.getByText("The AWS login expired.").closest<HTMLElement>('[role="status"]');
    if (!refreshMessage) throw new Error("Expected the AWS refresh error status");
    await user.click(within(refreshMessage).getByRole("button", { name: "AWS Login for Production AWS from error message" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toBeEnabled();
    expect(screen.queryByText("Status refresh failed")).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider refresh connection failed/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/retry the previous operation/u)).not.toBeInTheDocument();
    expect(api.refreshDeployments).toHaveBeenCalledOnce();
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
  });

  it.each(["resolved failure", "rejection"] as const)("ignores an older provider %s after a successful login snapshot", async (failure) => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }],
      refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "The AWS login expired." }],
    };
    const provider = deferred<Awaited<ReturnType<CloudDeploymentAPI["refreshDeployments"]>>>();
    const staleError = "The previous provider request failed.";
    vi.mocked(api.refreshDeployments).mockReturnValueOnce(provider.promise.then((result) => {
      if (failure === "rejection") throw new Error(staleError);
      return result;
    }));
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => {
      currentSnapshot = { ...currentSnapshot, refreshErrors: [] };
      return { ok: true, value: { ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION, loginSessionArn: LOGIN_SESSION_ARN } };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await waitFor(() => expect(api.refreshDeployments).toHaveBeenCalledOnce());
    const refreshMessage = screen.getByText("The AWS login expired.").closest<HTMLElement>('[role="status"]');
    if (!refreshMessage) throw new Error("Expected the AWS refresh error status");
    await user.click(within(refreshMessage).getByRole("button", { name: "AWS Login for Production AWS from error message" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await waitFor(() => expect(screen.queryByText("The AWS login expired.")).not.toBeInTheDocument());
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);

    await act(async () => provider.resolve({ ok: false, error: staleError }));

    expect(screen.queryByText(staleError)).not.toBeInTheDocument();
    expect(screen.queryByText("Status refresh failed")).not.toBeInTheDocument();
    expect(api.refreshDeployments).toHaveBeenCalledOnce();
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
  });

  it.each(["stopping", "terminated", "unknown"] as const)("shows external AWS %s state and disables connection/lifecycle actions", async (instanceState) => {
    currentSnapshot = { ...runningCloudSnapshot(), state: { v: 1, revision: 9, deployments: [{
      ...runningDeployment, runtime: { ...runningDeployment.runtime, instanceState },
    }] } };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    expect(await screen.findByText(instanceState.charAt(0).toUpperCase() + instanceState.slice(1))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SSH to range-control" })).toHaveAttribute("aria-disabled", "true");
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(serverActions).getByRole("menuitem", { name: "Reboot" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    act(() => navigationListener?.({ view: "deployments", deploymentId: DEPLOYMENT_ID, action: "stop" }));
    expect(await screen.findByText("Cloud action unavailable")).toBeInTheDocument();
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
  });

  it("refreshes only bounded transcript data for transcript change signals", async () => {
    renderCloudDeploymentApp();
    expect(await screen.findByText("No Managed Servers")).toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledOnce();

    currentSnapshot = {
      ...emptySnapshot,
      provisioningTranscripts: [{
        deploymentId: DEPLOYMENT_ID,
        status: "streaming",
        truncated: false,
        chunks: [{ sequence: 0, bytes: new TextEncoder().encode("live output\n") }],
      }],
    };
    act(() => changedListener?.("transcripts"));

    await waitFor(() => expect(api.getProvisioningTranscripts).toHaveBeenCalledOnce());
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it("resumes an in-progress deployment as the full instance view after reopening", async () => {
    const deployment = awsProvisioningDeployment();
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 8, deployments: [deployment] },
      credentials: [awsCredential],
      provisioningTranscripts: [{
        deploymentId: DEPLOYMENT_ID,
        status: "streaming",
        truncated: false,
        chunks: [],
      }],
    };

    renderCloudDeploymentApp();

    expect(await screen.findByRole("heading", { name: "range-control" })).toBeInTheDocument();
    expect(screen.getByText("AWS Status Checks")).toBeInTheDocument();
    expect(screen.getByText("0/2 checks passed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deployment in progress" })).toBeDisabled();
    expect(screen.queryByText("No Managed Servers")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New Deployment" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toBeInTheDocument();
  });

  it("creates an AWS credential using only an opaque native-picker key token", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByRole("heading", { name: "Provider Credentials" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "access-keys");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Production AWS");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    expect(await screen.findByText("operator_ed25519")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toMatchObject({
      provider: "aws",
      label: "Production AWS",
      defaultRegion: "us-east-1",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "super-secret-value",
    });
    expect(capturedCredential).not.toHaveProperty("sshPrivateKey");
    expect(screen.queryByDisplayValue("super-secret-value")).not.toBeInTheDocument();
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
  });

  it("requests an automatically generated Ed25519 key when no existing key is selected", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByText(/a new Ed25519 key will be generated automatically/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("SSH Key Passphrase")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "access-keys");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Generated Key AWS");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(api.chooseSshPrivateKey).not.toHaveBeenCalled();
    expect(capturedCredential).toMatchObject({
      provider: "aws",
      label: "Generated Key AWS",
      sshPrivateKeyToken: null,
      sshPassphrase: null,
    });
  });

  it("can return to automatic key generation after selecting an existing SSH key", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    expect(await screen.findByText("operator_ed25519")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH Key Passphrase")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Use an automatically generated SSH key" }));

    expect(screen.getByText(/a new Ed25519 key will be generated automatically/i)).toBeInTheDocument();
    expect(screen.queryByLabelText("SSH Key Passphrase")).not.toBeInTheDocument();
  });

  it("reuses an explicit local AWS CLI profile without sending AWS secret values", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [
        { name: "default", region: "us-west-2" },
        { name: "operators", region: "us-iso-east-1" },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("profile");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS CLI Profile" }), "operators");
    expect(screen.getByRole("textbox", { name: "Default Region" })).toHaveValue("us-iso-east-1");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Operator Profile");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toEqual({
      provider: "aws",
      label: "Operator Profile",
      defaultRegion: "us-iso-east-1",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: KEY_TOKEN,
      profileName: "operators",
      sshPassphrase: null,
    });
    expect(capturedCredential).not.toHaveProperty("accessKeyId");
    expect(capturedCredential).not.toHaveProperty("secretAccessKey");
    expect(capturedCredential).not.toHaveProperty("sessionToken");
  });

  it("clears static AWS credentials when switching to a CLI profile", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    const authentication = screen.getByRole("combobox", { name: "AWS Authentication" });
    await user.selectOptions(authentication, "access-keys");
    await user.type(screen.getByLabelText("Access Key ID"), "AKIAIOSFODNN7EXAMPLE");
    await user.type(screen.getByLabelText("Secret Access Key"), "super-secret-value");
    await user.type(screen.getByLabelText("Session Token"), "temporary-session-token");

    await user.selectOptions(authentication, "profile");
    await user.selectOptions(authentication, "access-keys");

    expect(screen.getByLabelText("Access Key ID")).toHaveValue("");
    expect(screen.getByLabelText("Secret Access Key")).toHaveValue("");
    expect(screen.getByLabelText("Session Token")).toHaveValue("");
  });

  it("reconciles profile authentication when the discovered profile inventory changes", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [
        { name: "default", region: "us-west-2" },
        { name: "operators", region: "eu-west-1" },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS CLI Profile" }), "operators");

    currentSnapshot = {
      ...emptySnapshot,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
    };
    act(() => changedListener?.("snapshot"));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("profile");
      expect(screen.getByRole("combobox", { name: "AWS CLI Profile" })).toHaveValue("default");
      expect(screen.getByRole("textbox", { name: "Default Region" })).toHaveValue("us-west-2");
    });

    currentSnapshot = emptySnapshot;
    act(() => changedListener?.("snapshot"));

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("");
      expect(screen.queryByRole("combobox", { name: "AWS CLI Profile" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Access Key ID")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Sign In to AWS Console" })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    });
  });

  it("validates before console sign-in and requires a separate confirmation before creating an AWS credential", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    expect(screen.getByText("Enter a credential label.")).toBeInTheDocument();
    expect(api.openAwsConsole).not.toHaveBeenCalled();
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Console First");
    await user.dblClick(screen.getByRole("button", { name: "Sign In to AWS Console" }));

    expect(api.openAwsConsole).toHaveBeenCalledExactlyOnceWith({ region: "us-east-1" });
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    expect(screen.queryByText(/Complete AWS Login in your browser/u)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign In to AWS Console" })).not.toBeInTheDocument();
    expect(screen.getByText(/Opening the page or returning here does not verify your session/u)).toBeInTheDocument();
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.createCredential).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole("button", { name: "Continue to Authorization" }));
    expect(api.createCredential).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: true, value: awsCredential }));
  });

  it.each(["resolved failure", "rejection"] as const)("allows retry after a new AWS console opening %s without beginning authorization", async (failure) => {
    if (failure === "rejection") vi.mocked(api.openAwsConsole).mockRejectedValueOnce(new Error("The console could not be opened."));
    else vi.mocked(api.openAwsConsole).mockResolvedValueOnce({ ok: false, error: "The console could not be opened." });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Console Retry");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    expect(await screen.findByText("The console could not be opened.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    expect(api.createCredential).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    expect(await screen.findByRole("button", { name: "Continue to Authorization" })).toBeEnabled();
    expect(api.openAwsConsole).toHaveBeenCalledTimes(2);
    expect(api.createCredential).not.toHaveBeenCalled();
  });

  it.each(["cancel", "region", "method", "provider", "unmount"] as const)("invalidates a delayed new AWS console opener after %s", async (change) => {
    const opener = deferred<OperationResult>();
    vi.mocked(api.openAwsConsole).mockReturnValueOnce(opener.promise);
    const user = userEvent.setup();
    const view = renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Delayed Console");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    expect(screen.getByText("Opening the AWS Console in your browser…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    if (change === "cancel") await user.click(screen.getByRole("button", { name: "Cancel AWS Login" }));
    if (change === "region") {
      await user.clear(screen.getByRole("textbox", { name: "Default Region" }));
      await user.type(screen.getByRole("textbox", { name: "Default Region" }), "cn-north-1");
    }
    if (change === "method") await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "access-keys");
    if (change === "provider") await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    if (change === "unmount") view.unmount();
    await act(async () => opener.resolve({ ok: true }));
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    if (change === "region") {
      await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
      expect(api.openAwsConsole).toHaveBeenLastCalledWith({ region: "cn-north-1" });
      expect(await screen.findByRole("button", { name: "Continue to Authorization" })).toBeEnabled();
      expect(api.createCredential).not.toHaveBeenCalled();
    }
  });

  it("ignores a rejected console opener after cancellation and a new ready console step", async () => {
    const stale = deferred<OperationResult>();
    vi.mocked(api.openAwsConsole).mockReturnValueOnce(stale.promise.then(() => { throw new Error("Stale browser opening failure."); }));
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Fresh Console");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(screen.getByRole("button", { name: "Cancel AWS Login" }));
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await act(async () => stale.resolve({ ok: true }));
    expect(screen.queryByText("Stale browser opening failure.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue to Authorization" })).toBeEnabled();
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
  });

  it("holds saved AWS renewal for explicit Continue while allowing local preparation cancellation", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.loginAwsCredential).mockReturnValueOnce(login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.dblClick(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    expect(api.openAwsConsole).toHaveBeenCalledExactlyOnceWith({ region: awsCredential.defaultRegion });
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Test connection for Production AWS" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Production AWS" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel AWS Login" }));
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test connection for Production AWS" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    act(() => window.dispatchEvent(new Event("focus")));
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    await user.dblClick(screen.getByRole("button", { name: "Continue to Authorization" }));
    expect(api.loginAwsCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: CREDENTIAL_ID });
    await act(async () => login.resolve({ ok: true, value: currentSnapshot.credentials[0]! }));
  });

  it("allows a saved credential to retry opening AWS Console without starting OAuth", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    vi.mocked(api.openAwsConsole).mockResolvedValueOnce({ ok: false, error: "The console could not be opened." });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    expect(await screen.findByText("The console could not be opened.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWS Login for Production AWS" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    expect(await screen.findByRole("button", { name: "Continue to Authorization" })).toBeEnabled();
    expect(api.openAwsConsole).toHaveBeenCalledTimes(2);
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
  });

  it.each(["cancel", "region", "unmount"] as const)("invalidates a delayed saved AWS console opener after %s", async (change) => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const opener = deferred<OperationResult>();
    vi.mocked(api.openAwsConsole).mockReturnValueOnce(opener.promise);
    const user = userEvent.setup();
    const view = renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    if (change === "cancel") await user.click(screen.getByRole("button", { name: "Cancel AWS Login" }));
    if (change === "region") {
      currentSnapshot = { ...currentSnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN, defaultRegion: "us-west-2" }] };
      act(() => changedListener?.("snapshot"));
      await screen.findByText(/us-west-2/u);
    }
    if (change === "unmount") view.unmount();
    await act(async () => opener.resolve({ ok: true }));
    expect(screen.queryByRole("button", { name: "Continue to Authorization" })).not.toBeInTheDocument();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    if (change !== "unmount") expect(screen.getByRole("button", { name: "AWS Login for Production AWS" })).toBeEnabled();
  });

  it("requires an explicit AWS authentication choice and saves after browser sign-in", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async (input) => {
      capturedCredential = structuredClone(input);
      return login.promise;
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));

    expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Sign In to AWS Console" })).not.toBeInTheDocument();
    expect(api.createCredential).not.toHaveBeenCalled();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Access Key ID")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Browser AWS");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    expect(screen.getByText(/IAM users and roles need SignInLocalDevelopmentAccess/u)).toBeInTheDocument();
    expect(screen.getByText(/IAM Identity Center \(SSO\) uses an AWS CLI profile/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));

    expect(await screen.findByText(/Complete AWS Login in your browser/u)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Label" })).toBeDisabled();
    expect(screen.queryByText("Credential saved")).not.toBeInTheDocument();
    expect(screen.getByText(/If AWS shows 400 Bad Request/u)).toHaveTextContent("your console browser session may have expired");
    expect(screen.getByText(/Start Over cancels this authorization/u)).toHaveTextContent("private browser window on this computer");
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    expect(await screen.findByText("Sign-in link copied.")).toBeInTheDocument();
    expect(api.copyAwsLoginLink).toHaveBeenCalledExactlyOnceWith();
    expect(api.createCredential).toHaveBeenCalledOnce();
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    expect(capturedCredential).toEqual({
      provider: "aws",
      authentication: "login",
      label: "Browser AWS",
      defaultRegion: "us-east-1",
      sshUsername: "ubuntu",
      sshPrivateKeyToken: null,
      sshPassphrase: null,
    });
    await act(async () => login.resolve({ ok: true, value: { ...awsCredential, label: "Browser AWS", loginSessionArn: LOGIN_SESSION_ARN } }));
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it("shows AWS browser progress and withdraws recovery when authorization arrives", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    const listeners = new Set<Parameters<NonNullable<CloudDeploymentAPI["onAwsLoginProgress"]>>[0]>();
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "cloudDeployment", { configurable: true, value: {
      ...api,
      onAwsLoginProgress: (listener: Parameters<NonNullable<CloudDeploymentAPI["onAwsLoginProgress"]>>[0]) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); unsubscribe(); };
      },
    } });
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    const view = renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Browser AWS");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));

    expect(screen.getByText("Opening your browser for AWS Login…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Sign-in Link" })).toBeDisabled();
    act(() => { for (const listener of listeners) listener({ phase: "waiting-for-authorization" }); });
    expect(screen.getByText(/the app cannot see errors on the AWS browser page/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    expect(await screen.findByText("Sign-in link copied.")).toBeInTheDocument();
    act(() => { for (const listener of listeners) listener({ phase: "exchanging-authorization" }); });
    expect(screen.getByText("AWS approval received. Completing sign-in…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Sign-in Link" })).toBeDisabled();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.queryByText(/If AWS shows 400 Bad Request/u)).not.toBeInTheDocument();
    expect(api.copyAwsLoginLink).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: true, value: awsCredential }));
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
    view.unmount();
    expect(listeners.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalled();
  });

  it.each(["cancel-first", "attempt-first"] as const)("starts a fresh AWS Login only after cancellation and the previous attempt settle (%s)", async (order) => {
    const first = deferred<OperationResult<CloudCredentialSummary>>();
    const second = deferred<OperationResult<CloudCredentialSummary>>();
    const cancel = deferred<OperationResult>();
    vi.mocked(api.createCredential)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => cancel.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Restart AWS");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    expect(await screen.findByText("Sign-in link copied.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start Over" }));
    expect(api.cancelAwsLogin).toHaveBeenCalledOnce();
    expect(api.createCredential).toHaveBeenCalledOnce();
    if (order === "cancel-first") {
      await act(async () => cancel.resolve({ ok: true }));
      expect(api.createCredential).toHaveBeenCalledOnce();
      await act(async () => first.resolve({ ok: false, error: "AWS Login was cancelled." }));
    } else {
      await act(async () => first.resolve({ ok: false, error: "AWS Login was cancelled." }));
      expect(api.createCredential).toHaveBeenCalledOnce();
      expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toBeDisabled();
      await act(async () => cancel.resolve({ ok: true }));
    }

    await waitFor(() => expect(api.openAwsConsole).toHaveBeenCalledTimes(2));
    expect(api.createCredential).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Continue to Authorization" }));
    expect(api.createCredential).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Credential not saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Restart AWS");
    await act(async () => second.resolve({ ok: true, value: awsCredential }));
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
  });

  it("cancels AWS Login before allowing another authentication method", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => {
      login.resolve({ ok: false, error: "AWS Login was cancelled." });
      return { ok: true };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Choose AWS");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Choose Another Method" }));

    await waitFor(() => expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toHaveValue(""));
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Label" })).toHaveValue("Choose AWS");
    expect(screen.queryByText("Credential not saved")).not.toBeInTheDocument();
    expect(api.cancelAwsLogin).toHaveBeenCalledOnce();
    expect(api.createCredential).toHaveBeenCalledOnce();
  });

  it("keeps the AWS attempt active when Start Over cannot cancel it", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockResolvedValueOnce({ ok: false, error: "Cancellation was unavailable." });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Pending AWS");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Start Over" }));

    expect(await screen.findByText("Cancellation was unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "AWS Authentication" })).toBeDisabled();
    expect(api.createCredential).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: false, error: "The original attempt expired." }));
    expect(await screen.findByText("The original attempt expired.")).toBeInTheDocument();
    expect(api.createCredential).toHaveBeenCalledOnce();
  });

  it("cancels pending AWS Login without saving a credential or reporting a failure", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => {
      login.resolve({ ok: false, error: "AWS Login was cancelled." });
      return { ok: true };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Cancelled AWS");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(await screen.findByRole("button", { name: "Cancel AWS Login" }));

    expect(api.cancelAwsLogin).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByText(/Complete AWS Login in your browser/u)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Sign In to AWS Console" })).toBeEnabled();
    expect(screen.queryByText("Credential saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Credential not saved")).not.toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it.each(["returned error", "rejected request"])("keeps credential creation pending after a copy-link %s and allows retry", async (failure) => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    if (failure === "returned error") {
      vi.mocked(api.copyAwsLoginLink).mockResolvedValueOnce({ ok: false, error: "Sign-in link is not ready." });
    } else {
      vi.mocked(api.copyAwsLoginLink).mockRejectedValueOnce(new Error("Sign-in link is not ready."));
    }
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Browser AWS");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));

    expect(await screen.findByText("Sign-in link is not ready.")).toBeInTheDocument();
    expect(screen.queryByText("Credential not saved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel AWS Login" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    expect(await screen.findByText("Sign-in link copied.")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in link is not ready.")).not.toBeInTheDocument();
    expect(api.createCredential).toHaveBeenCalledOnce();
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    await act(async () => login.resolve({ ok: true, value: awsCredential }));
    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
  });

  it("ignores a pending copy reply when the AWS creation form closes", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    const copy = deferred<OperationResult>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.copyAwsLoginLink).mockImplementationOnce(async () => copy.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => {
      login.resolve({ ok: false, error: "AWS Login was cancelled." });
      return { ok: true };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Browser AWS");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    await user.click(screen.getByRole("button", { name: "Close Form" }));
    await waitFor(() => expect(api.cancelAwsLogin).toHaveBeenCalledOnce());
    await act(async () => copy.resolve({ ok: false, error: "Stale copy failure" }));

    expect(screen.queryByText("Stale copy failure")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
  });

  it("reauthenticates a saved native AWS credential and disables competing credential actions", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));

    expect(api.loginAwsCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: CREDENTIAL_ID });
    expect(screen.getByRole("button", { name: "Test connection for Production AWS" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Production AWS" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel AWS Login" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy Sign-in Link" }));
    expect(await screen.findByText("Sign-in link copied.")).toBeInTheDocument();
    expect(api.copyAwsLoginLink).toHaveBeenCalledExactlyOnceWith();
    expect(api.loginAwsCredential).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: true, value: currentSnapshot.credentials[0]! }));

    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.testCredential).not.toHaveBeenCalled();
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
  });

  it("cancels pending credential creation when the AWS Login form closes", async () => {
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.createCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => {
      login.resolve({ ok: false, error: "AWS Login was cancelled." });
      return { ok: true };
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Closing AWS");
    await user.selectOptions(screen.getByRole("combobox", { name: "AWS Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to AWS Console" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Close Form" }));

    await waitFor(() => expect(api.cancelAwsLogin).toHaveBeenCalledOnce());
    expect(screen.queryByText(/Complete AWS Login in your browser/u)).not.toBeInTheDocument();
    expect(screen.queryByText("Credential saved")).not.toBeInTheDocument();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it("allows AWS cancellation while copying and ignores the old reply on the next attempt", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const firstLogin = deferred<OperationResult<CloudCredentialSummary>>();
    const nextLogin = deferred<OperationResult<CloudCredentialSummary>>();
    const copy = deferred<OperationResult>();
    const cancel = deferred<OperationResult>();
    vi.mocked(api.loginAwsCredential)
      .mockImplementationOnce(async () => firstLogin.promise)
      .mockImplementationOnce(async () => nextLogin.promise);
    vi.mocked(api.copyAwsLoginLink).mockImplementationOnce(async () => copy.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => cancel.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    const copyButton = screen.getByRole("button", { name: "Copy Sign-in Link" });
    await user.click(copyButton);
    await user.click(copyButton);
    expect(api.copyAwsLoginLink).toHaveBeenCalledOnce();
    expect(copyButton).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Cancel AWS Login" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel AWS Login" }));
    expect(api.cancelAwsLogin).toHaveBeenCalledOnce();
    expect(copyButton).toBeDisabled();
    await act(async () => {
      firstLogin.resolve({ ok: false, error: "AWS Login was cancelled." });
      cancel.resolve({ ok: true });
    });
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await act(async () => copy.resolve({ ok: true }));

    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
    expect(screen.queryByText("AWS Login failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy Sign-in Link" })).toBeEnabled();
    expect(api.loginAwsCredential).toHaveBeenCalledTimes(2);
    await act(async () => nextLogin.resolve({ ok: true, value: awsCredential }));
    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
  });

  it("offers one AWS Login inside failed deployment errors without retrying lifecycle actions", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }],
      state: { v: 1, revision: 9, deployments: [{ ...runningDeployment, status: "failed", lastError: "The AWS session has expired." }] },
      refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "The AWS status session has expired." }],
    };
    renderCloudDeploymentApp();
    const operationMessage = (await screen.findByText("The AWS session has expired.")).closest<HTMLElement>('[role="alert"]');
    const refreshMessage = screen.getByText("The AWS status session has expired.").closest<HTMLElement>('[role="status"]');
    if (!operationMessage || !refreshMessage) throw new Error("Expected both AWS deployment error messages");
    const embeddedLogin = within(operationMessage).getByRole("button", { name: "AWS Login for Production AWS from error message" });
    expect(within(refreshMessage).queryByRole("button", { name: /AWS Login for Production AWS/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AWS Login for Production AWS" })).not.toBeInTheDocument();
    await act(async () => embeddedLogin.click());
    await act(async () => (await screen.findByRole("button", { name: "Continue to Authorization" })).click());

    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
    expect(api.loginAwsCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: CREDENTIAL_ID });
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
    expect(screen.getByText("The AWS session has expired.")).toBeInTheDocument();
  });

  it("hides the standalone AWS Login when the status refresh warning has its own login action", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }],
      refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "The AWS status session has expired." }],
    };
    renderCloudDeploymentApp();
    const refreshMessage = (await screen.findByText("The AWS status session has expired.")).closest<HTMLElement>('[role="status"]');
    if (!refreshMessage) throw new Error("Expected the AWS status refresh warning");
    expect(within(refreshMessage).getByRole("button", { name: "AWS Login for Production AWS from error message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AWS Login for Production AWS" })).not.toBeInTheDocument();
  });

  it("keeps one AWS reauthentication alive when a snapshot clears its error message", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }],
      state: { v: 1, revision: 9, deployments: [{ ...runningDeployment, status: "failed", lastError: "The AWS session has expired." }] },
    };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    const operationMessage = (await screen.findByText("The AWS session has expired.")).closest<HTMLElement>('[role="alert"]');
    if (!operationMessage) throw new Error("Expected the AWS deployment error alert");
    await user.click(within(operationMessage).getByRole("button", { name: "AWS Login for Production AWS from error message" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    expect(await screen.findByText(/Complete AWS Login in your browser/u)).toBeInTheDocument();
    const copyButton = within(operationMessage).getByRole("button", { name: "Copy Sign-in Link" });
    expect(screen.getAllByRole("button", { name: "Copy Sign-in Link" })).toHaveLength(1);
    await user.click(copyButton);
    expect(await within(operationMessage).findByText("Sign-in link copied.")).toBeInTheDocument();

    currentSnapshot = {
      ...currentSnapshot,
      state: { v: 1, revision: 10, deployments: [{ ...runningDeployment, lastError: null }] },
      refreshErrors: [],
    };
    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(screen.queryByText("The AWS session has expired.")).not.toBeInTheDocument());

    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "AWS Login for Production AWS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel AWS Login" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Copy Sign-in Link" })).toHaveLength(1);
    expect(screen.getByText("Sign-in link copied.")).toBeInTheDocument();
    expect(api.copyAwsLoginLink).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: true, value: { ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION, loginSessionArn: LOGIN_SESSION_ARN } }));

    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
    expect(api.loginAwsCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: CREDENTIAL_ID });
    expect(api.cancelAwsLogin).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "AWS Login for Production AWS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy Sign-in Link" })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign-in link copied.")).not.toBeInTheDocument();
  });

  it("cancels AWS reauthentication when its credential view is closed", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => {
      login.resolve({ ok: false, error: "AWS Login was cancelled." });
      return { ok: true };
    });
    const user = userEvent.setup();
    const view = renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    expect(screen.getByText(/Complete AWS Login in your browser/u)).toBeInTheDocument();

    view.unmount();
    await waitFor(() => expect(api.cancelAwsLogin).toHaveBeenCalledOnce());
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    ["sso", "IAM Identity Center (SSO): refresh this profile"],
    ["static", "This profile uses access keys."],
    ["process", "This profile uses an external credential process."],
    ["role", "This profile assumes a role."],
    ["unknown", "Existing profile credentials are reused."],
  ] as const)("offers appropriate renewal guidance for an AWS %s profile without console login", async (method, guidance) => {
    currentSnapshot = { ...emptySnapshot, credentials: [{
      ...awsCredential,
      profileName: "operators",
      authentication: { method, canConsoleLogin: false },
    }] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));

    expect(screen.queryByRole("button", { name: "AWS Login for Production AWS" })).not.toBeInTheDocument();
    expect(screen.getByText((content) => content.startsWith(guidance))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test connection for Production AWS" })).toBeEnabled();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
  });

  it("does not infer AWS profile renewal from a profile name or an old browser session", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{
      ...awsCredential, profileName: "operators", loginSessionArn: LOGIN_SESSION_ARN,
    }] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));

    expect(screen.queryByRole("button", { name: "AWS Login for Production AWS" })).not.toBeInTheDocument();
    expect(screen.getByText(/Renew this profile with the AWS CLI or your identity provider/u)).toBeInTheDocument();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
  });

  it("shows SSO profile renewal guidance on a deployment error without opening console login", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      credentials: [{ ...awsCredential, profileName: "sso", authentication: { method: "sso", canConsoleLogin: false } }],
      refreshErrors: [{ deploymentId: DEPLOYMENT_ID, message: "The SSO session has expired." }],
    };
    renderCloudDeploymentApp();
    const message = (await screen.findByText("The SSO session has expired.")).closest<HTMLElement>('[role="status"]');
    if (!message) throw new Error("Expected the SSO status refresh warning");
    expect(within(message).queryByRole("button", { name: /AWS Login/u })).not.toBeInTheDocument();
    expect(within(message).getByText(/Console login cannot renew an SSO session/u)).toBeInTheDocument();
    expect(api.loginAwsCredential).not.toHaveBeenCalled();
  });

  it.each(["cancel-first", "attempt-first"] as const)("starts over a saved AWS credential login after cancelling its previous attempt (%s)", async (order) => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const first = deferred<OperationResult<CloudCredentialSummary>>();
    const second = deferred<OperationResult<CloudCredentialSummary>>();
    const cancel = deferred<OperationResult>();
    vi.mocked(api.loginAwsCredential)
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => cancel.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Start Over" }));
    if (order === "cancel-first") {
      await act(async () => cancel.resolve({ ok: true }));
      expect(api.loginAwsCredential).toHaveBeenCalledOnce();
      await act(async () => first.resolve({ ok: false, error: "AWS Login was cancelled." }));
    } else {
      await act(async () => first.resolve({ ok: false, error: "AWS Login was cancelled." }));
      expect(api.loginAwsCredential).toHaveBeenCalledOnce();
      expect(screen.getByRole("button", { name: "AWS Login for Production AWS" })).toBeDisabled();
      await act(async () => cancel.resolve({ ok: true }));
    }

    await waitFor(() => expect(api.openAwsConsole).toHaveBeenCalledTimes(2));
    expect(api.loginAwsCredential).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Continue to Authorization" }));
    expect(api.loginAwsCredential).toHaveBeenCalledTimes(2);
    expect(api.cancelAwsLogin).toHaveBeenCalledOnce();
    expect(screen.queryByText("AWS Login failed")).not.toBeInTheDocument();
    await act(async () => second.resolve({ ok: true, value: currentSnapshot.credentials[0]! }));
    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
  });

  it("does not restart a saved AWS credential when authorization wins the cancellation race", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, loginSessionArn: LOGIN_SESSION_ARN }] };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    const cancel = deferred<OperationResult>();
    vi.mocked(api.loginAwsCredential).mockImplementationOnce(async () => login.promise);
    vi.mocked(api.cancelAwsLogin).mockImplementationOnce(async () => cancel.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));
    await user.click(screen.getByRole("button", { name: "Start Over" }));
    await act(async () => login.resolve({ ok: true, value: currentSnapshot.credentials[0]! }));
    expect(await screen.findByText("AWS Login complete")).toBeInTheDocument();
    await act(async () => cancel.resolve({ ok: true }));

    expect(api.loginAwsCredential).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Start Over" })).not.toBeInTheDocument();
  });

  it("reports an AWS Login error on the credential card and allows retry", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [{ ...awsCredential, profileName: "operators", authentication: CONSOLE_PROFILE_AUTHENTICATION }] };
    vi.mocked(api.loginAwsCredential).mockResolvedValueOnce({ ok: false, error: "AWS denied console sign-in." });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "AWS Login for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Continue to Authorization" }));

    expect(await screen.findByText("AWS Login failed")).toBeInTheDocument();
    expect(screen.getByText("AWS denied console sign-in.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AWS Login for Production AWS" })).toBeEnabled();
    expect(api.getSnapshot).toHaveBeenCalledOnce();
  });

  it("creates an Azure credential from the discovered CLI subscription without exposing SSH key contents", async () => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await waitFor(() => expect(api.discoverAzureAccounts).toHaveBeenCalledOnce());
    expect(screen.getByRole("combobox", { name: "Azure Authentication" })).toHaveValue("cli");
    expect(screen.getByRole("combobox", { name: "Azure CLI Subscription" })).toHaveValue(AZURE_SUBSCRIPTION_ID);
    expect(screen.getByRole("textbox", { name: "Tenant ID" })).toHaveValue(AZURE_TENANT_ID);
    expect(screen.getByRole("textbox", { name: "Default Location" })).toHaveValue("eastus");
    expect(screen.getByRole("textbox", { name: "SSH Username" })).toHaveValue("azureuser");

    await user.type(screen.getByRole("textbox", { name: "Label" }), "Production Azure");
    await user.click(screen.getByRole("button", { name: "Choose Key" }));
    await user.type(screen.getByLabelText("SSH Key Passphrase"), "azure-key-passphrase");
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledOnce());
    expect(capturedCredential).toEqual({
      provider: "azure",
      label: "Production Azure",
      defaultLocation: "eastus",
      subscriptionId: AZURE_SUBSCRIPTION_ID,
      tenantId: AZURE_TENANT_ID,
      sshUsername: "azureuser",
      sshPrivateKeyToken: KEY_TOKEN,
      sshPassphrase: "azure-key-passphrase",
    });
    expect(capturedCredential).not.toHaveProperty("sshPrivateKey");
  });

  it("signs into Azure without the CLI and saves the chosen subscription using an opaque login capability", async () => {
    vi.mocked(api.discoverAzureAccounts).mockResolvedValueOnce({ ok: false, error: "Azure CLI was not found." });
    const secondSubscriptionId = "22222222-3333-4444-5555-666666666666";
    const clientId = "33333333-4444-5555-6666-777777777777";
    vi.mocked(api.beginAzureLogin).mockResolvedValueOnce({ ok: true, value: {
      token: AZURE_LOGIN_TOKEN,
      expiresAt: "2026-09-08T20:00:00.000Z",
      subscriptions: [azureAccount, { ...azureAccount, subscriptionId: secondSubscriptionId, name: "Lab Subscription", isDefault: false }],
    } });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await waitFor(() => expect(api.discoverAzureAccounts).toHaveBeenCalledOnce());

    expect(screen.getByRole("combobox", { name: "Azure Authentication" })).toHaveValue("login");
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    expect(api.beginAzureLogin).not.toHaveBeenCalled();
    expect(screen.queryByText("Azure CLI was not found.")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Native Azure");
    await user.type(screen.getByRole("textbox", { name: "Directory (Tenant) ID" }), AZURE_TENANT_ID);
    await user.type(screen.getByRole("textbox", { name: "Application (Client) ID" }), clientId);
    await user.click(screen.getByRole("button", { name: "Sign In to Azure" }));
    expect(api.beginAzureLogin).toHaveBeenCalledExactlyOnceWith({ tenantId: AZURE_TENANT_ID, clientId });
    await user.selectOptions(await screen.findByRole("combobox", { name: "Azure Subscription" }), secondSubscriptionId);
    expect(screen.getByRole("textbox", { name: "Tenant ID" })).toHaveValue(AZURE_TENANT_ID);
    expect(screen.getByRole("textbox", { name: "Tenant ID" })).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    expect(await screen.findByText("Credential saved")).toBeInTheDocument();
    expect(capturedCredential).toEqual({
      provider: "azure", authentication: "login", loginToken: AZURE_LOGIN_TOKEN,
      label: "Native Azure", defaultLocation: "eastus", sshUsername: "azureuser",
      sshPrivateKeyToken: null, sshPassphrase: null, subscriptionId: secondSubscriptionId, tenantId: AZURE_TENANT_ID,
    });
    expect(api.createCredential).toHaveBeenCalledOnce();
    expect(api.cancelAzureLogin).not.toHaveBeenCalled();
    expect(capturedCredential).not.toHaveProperty("accessToken");
    expect(capturedCredential).not.toHaveProperty("tokenCache");
  });

  it("keeps an explicit Azure Login choice when delayed CLI discovery completes", async () => {
    const discovery = deferred<Awaited<ReturnType<CloudDeploymentAPI["discoverAzureAccounts"]>>>();
    vi.mocked(api.discoverAzureAccounts).mockImplementationOnce(async () => discovery.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await user.selectOptions(screen.getByRole("combobox", { name: "Azure Authentication" }), "cli");
    await user.selectOptions(screen.getByRole("combobox", { name: "Azure Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to Azure" }));
    expect(await screen.findByText("Signed in. Choose a subscription, then save this credential.")).toBeInTheDocument();
    await act(async () => discovery.resolve({ ok: true, value: [azureAccount] }));

    expect(screen.getByRole("combobox", { name: "Azure Authentication" })).toHaveValue("login");
    expect(screen.getByRole("combobox", { name: "Azure Subscription" })).toHaveValue(AZURE_SUBSCRIPTION_ID);
    expect(api.beginAzureLogin).toHaveBeenCalledExactlyOnceWith({ tenantId: null, clientId: null });
  });

  it("cancels Azure browser login and ignores its late completion", async () => {
    vi.mocked(api.discoverAzureAccounts).mockResolvedValueOnce({ ok: true, value: [] });
    const login = deferred<Awaited<ReturnType<CloudDeploymentAPI["beginAzureLogin"]>>>();
    vi.mocked(api.beginAzureLogin).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await user.click(screen.getByRole("button", { name: "Sign In to Azure" }));
    expect(await screen.findByText(/Complete Azure Login in your browser/u)).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Provider" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Directory (Tenant) ID" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel Azure Login" }));
    expect(api.cancelAzureLogin).toHaveBeenCalledOnce();
    await act(async () => login.resolve({ ok: true, value: { token: AZURE_LOGIN_TOKEN, expiresAt: "2026-09-08T20:00:00.000Z", subscriptions: [azureAccount] } }));

    expect(screen.queryByText(/Complete Azure Login in your browser/u)).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Azure Subscription" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    expect(api.createCredential).not.toHaveBeenCalled();
  });

  it.each(["authentication", "provider", "form"])("discards staged Azure login when changing %s", async (change) => {
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await user.selectOptions(screen.getByRole("combobox", { name: "Azure Authentication" }), "login");
    await user.click(screen.getByRole("button", { name: "Sign In to Azure" }));
    expect(await screen.findByText("Signed in. Choose a subscription, then save this credential.")).toBeInTheDocument();

    if (change === "authentication") await user.selectOptions(screen.getByRole("combobox", { name: "Azure Authentication" }), "cli");
    else if (change === "provider") await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "aws");
    else await user.click(screen.getByRole("button", { name: "Close Form" }));

    await waitFor(() => expect(api.cancelAzureLogin).toHaveBeenCalledOnce());
    expect(screen.queryByText("Signed in. Choose a subscription, then save this credential.")).not.toBeInTheDocument();
    expect(api.createCredential).not.toHaveBeenCalled();
  });

  it("requires a new Azure login after a staged save is rejected", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createCredential).mockResolvedValueOnce({ ok: false, error: "The selected login session expired." });
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    await user.selectOptions(screen.getByRole("combobox", { name: "Azure Authentication" }), "login");
    await user.type(screen.getByRole("textbox", { name: "Label" }), "Expired Azure");
    await user.click(screen.getByRole("button", { name: "Sign In to Azure" }));
    await user.click(screen.getByRole("button", { name: "Save Credential" }));

    expect(await screen.findByText("The selected login session expired.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Credential" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign In to Azure" })).toBeEnabled();
  });

  it("reauthenticates an Azure credential from its failed deployment without replaying lifecycle actions", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      credentials: [azureCredential],
      state: { v: 1, revision: 9, deployments: [{ ...runningAzureDeployment, status: "failed", lastError: "Azure credentials have expired." }] },
    };
    const login = deferred<OperationResult<CloudCredentialSummary>>();
    vi.mocked(api.loginAzureCredential).mockImplementationOnce(async () => login.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    const operationMessage = (await screen.findByText("Azure credentials have expired.")).closest<HTMLElement>('[role="alert"]');
    if (!operationMessage) throw new Error("Expected the Azure deployment error alert");
    const embeddedLogin = within(operationMessage).getByRole("button", { name: "Azure Login for Production Azure from error message" });
    expect(screen.queryByRole("button", { name: "Azure Login for Production Azure" })).not.toBeInTheDocument();
    act(() => {
      embeddedLogin.click();
    });
    expect(await screen.findByText(/Complete Azure Login in your browser/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel Azure Login" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Azure Login for Production Azure" })).not.toBeInTheDocument();
    await act(async () => login.resolve({ ok: true, value: { ...azureCredential, loginAccountId: "home-account-id" } }));

    expect(await screen.findByText("Azure Login complete")).toBeInTheDocument();
    expect(api.loginAzureCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: AZURE_CREDENTIAL_ID });
    expect(api.cancelAzureLogin).not.toHaveBeenCalled();
    expect(api.getSnapshot).toHaveBeenCalledTimes(2);
    expect(api.runLifecycleAction).not.toHaveBeenCalled();
    expect(screen.getByText("Azure credentials have expired.")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Credentials/i }));
    expect(screen.getByRole("button", { name: "Azure Login for Production Azure" })).toBeEnabled();
  });

  it("verifies the connection when resource-specific permissions are inconclusive and preserves actual denials", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    vi.mocked(api.testCredential).mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "aws",
        summary: "AWS identity verified; destructive permissions were not exercised.",
        permissions: {
          required: [{ id: "ec2:TerminateInstances", label: "Terminate managed instances", capabilities: ["destroy"] }],
          verified: [],
          missing: [],
          unverifiable: ["ec2:TerminateInstances"],
        },
      },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));

    expect(await screen.findByText("Connection verified")).toBeInTheDocument();
    expect(screen.getByText(/1 permission could not be verified safely: ec2:TerminateInstances/u)).toBeInTheDocument();
    expect(screen.getByText("Some permissions remain unverified")).toBeInTheDocument();
    expect(screen.queryByText("Permissions verified")).not.toBeInTheDocument();
    expect(screen.queryByText("Permission review incomplete")).not.toBeInTheDocument();
    expect(screen.getByText("0 verified · 0 missing · 1 unverified")).toBeInTheDocument();
    await user.click(screen.getByText("Review permission IDs"));
    expect(screen.getByText(/AWS evaluates administrator and wildcard grants, including \* and ec2:\*, automatically/u)).toBeVisible();
    expect(screen.getByText("ec2:TerminateInstances").closest("li")).toHaveTextContent(
      "ec2:TerminateInstances — Terminate managed instances · could not verify safely",
    );

    vi.mocked(api.testCredential).mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "aws",
        summary: "AWS identity verified with a denied deployment permission.",
        permissions: {
          required: [{ id: "ec2:RunInstances", label: "Launch an EC2 instance", capabilities: ["deploy"] }],
          verified: [],
          missing: ["ec2:RunInstances"],
          unverifiable: [],
        },
      },
    });
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));

    expect(await screen.findByText("Required permissions missing")).toBeInTheDocument();
    expect(screen.getByText(/1 missing: ec2:RunInstances/u)).toBeInTheDocument();
    expect(screen.getByText("Permissions missing")).toBeInTheDocument();
  });

  it("copies the AWS permissions as Terraform and only shows success after the clipboard reply", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const copy = deferred<OperationResult>();
    vi.mocked(api.copyAwsPermissionsTerraform).mockReturnValueOnce(copy.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    expect(screen.queryByRole("button", { name: "Copy as Terraform" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));
    const button = await screen.findByRole("button", { name: "Copy as Terraform" });
    await user.click(button);

    expect(api.copyAwsPermissionsTerraform).toHaveBeenCalledExactlyOnceWith();
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    expect(api.copyAwsPermissionsTerraform).toHaveBeenCalledOnce();
    expect(screen.queryByText("Terraform copied to clipboard")).not.toBeInTheDocument();
    await act(async () => copy.resolve({ ok: true }));
    expect(await screen.findByText("Terraform copied to clipboard")).toBeInTheDocument();
    expect(button).not.toHaveAttribute("aria-disabled", "true");
  });

  it.each(["failure", "rejection"])("reports a Terraform clipboard %s without a success toast", async (kind) => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    if (kind === "failure") {
      vi.mocked(api.copyAwsPermissionsTerraform).mockResolvedValueOnce({ ok: false, error: "Clipboard unavailable" });
    } else {
      vi.mocked(api.copyAwsPermissionsTerraform).mockRejectedValueOnce(new Error("Clipboard unavailable"));
    }
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Copy as Terraform" }));

    expect(await screen.findByText("Could not copy Terraform")).toBeInTheDocument();
    expect(screen.getByText("Clipboard unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Terraform copied to clipboard")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as Terraform" })).toBeEnabled();
  });

  it("hides a permission report and shows fresh results on the next connection test", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));
    await user.click(await screen.findByRole("button", { name: "Hide" }));

    expect(screen.queryByText("Permissions verified")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy as Terraform" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Test connection for Production AWS" }));
    expect(await screen.findByText("Permissions verified")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy as Terraform" })).toBeEnabled();
  });

  it("allows hiding Azure permission results without offering the AWS Terraform policy", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [azureCredential] };
    vi.mocked(api.testCredential).mockResolvedValueOnce({
      ok: true,
      value: {
        provider: "azure",
        summary: "Azure permissions verified.",
        permissions: { required: [], verified: [], missing: [], unverifiable: [] },
      },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/i }));
    await user.click(screen.getByRole("button", { name: "Test connection for Production Azure" }));
    expect(await screen.findByRole("button", { name: "Hide" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Copy as Terraform" })).not.toBeInTheDocument();
    expect(api.copyAwsPermissionsTerraform).not.toHaveBeenCalled();
  });

  it("automatically adds the detected egress IPv4 to both new-deployment source lists", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await waitFor(() => expect(detectCurrentEgressIpv4).toHaveBeenCalledOnce());
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "auto-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("textbox", { name: "SSH Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByRole("textbox", { name: "Operator Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByText("Current egress IPv4 detected")).toBeInTheDocument();
    expect(screen.getByText(/203\.0\.113\.42\/32 was added to any empty, untouched source lists/u)).toBeInTheDocument();
  });

  it("does not overwrite a source list the user edits and clears before egress detection finishes", async () => {
    const detection = deferred<OperationResult<CurrentEgressIpv4>>();
    detectCurrentEgressIpv4.mockReturnValueOnce(detection.promise);
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "preserve-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Detecting current egress IPv4")).toBeInTheDocument();
    const sshCidrs = screen.getByRole("textbox", { name: "SSH Source CIDRs" });
    await user.type(sshCidrs, "198.51.100.8/32");
    await user.clear(sshCidrs);

    await act(async () => {
      detection.resolve({
        ok: true,
        value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
      });
      await detection.promise;
    });

    expect(sshCidrs).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Operator Source CIDRs" })).toHaveValue("203.0.113.42/32");
    expect(screen.getByText("Current egress IPv4 detected")).toBeInTheDocument();
  });

  it("keeps the access step usable when current egress IPv4 detection fails", async () => {
    detectCurrentEgressIpv4.mockRejectedValueOnce(new Error("network unavailable"));
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "manual-egress");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Current egress IPv4 unavailable")).toBeInTheDocument();
    expect(screen.getByText("Enter the source CIDRs manually before continuing.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  });

  it("collects provider-specific infrastructure and separate firewall CIDRs before deployment", async () => {
    currentSnapshot = { ...emptySnapshot, state: { ...emptySnapshot.state, revision: 7 }, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "range-control");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(discoverAwsOptions).toHaveBeenCalledWith({
      credentialId: CREDENTIAL_ID,
      region: "us-east-1",
    }));
    expect(await screen.findByRole("button", { name: /Instance Type/i })).toHaveTextContent("t3.micro");
    expect(screen.getByRole("button", { name: /Machine Image/i })).toHaveTextContent("Ubuntu 24.04 LTS");
    expect(screen.getByRole("button", { name: /VPC/i })).toHaveTextContent("default");
    expect(screen.getByRole("button", { name: /Subnet/i })).toHaveTextContent("default-public");
    expect(screen.getByRole("button", { name: /SSH Key/i })).toHaveTextContent("Credential key (managed)");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const sshPort = screen.getByRole("textbox", { name: "SSH Port" });
    expect(sshPort).not.toHaveAttribute("readonly");
    await user.clear(sshPort);
    await user.type(sshPort, "2222");
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "198.51.100.16/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("What happens next")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    await waitFor(() => expect(api.createDeployment).toHaveBeenCalledOnce());
    expect(capturedDeployment).toEqual({
      provider: "aws",
      expectedRevision: 7,
      credentialId: CREDENTIAL_ID,
      name: "range-control",
      spec: {
        region: "us-east-1",
        imageId: "ami-11111111111111111",
        instanceType: "t3.micro",
        subnetId: "subnet-0123456789abcdef0",
        vpcId: "vpc-0123456789abcdef0",
        networkMode: "existing",
        managedVpcCidr: null,
        managedSubnetCidr: null,
        sshKeyMode: "managed",
        existingKeyPairName: null,
        sshUsername: "ubuntu",
        keyPairName: "managed-by-sliver-gui",
        operatorName: "operator",
        sshPort: 2222,
        multiplayerPort: 31337,
        volumeSizeGiB: 20,
        useElasticIp: true,
        sshCidrs: ["203.0.113.8/32"],
        operatorCidrs: ["198.51.100.16/32"],
      },
    });
    expect(await screen.findByText("Deployment ready")).toBeInTheDocument();
  });

  it("collects Azure CLI infrastructure, managed networking, and firewall policy before deployment", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { ...emptySnapshot.state, revision: 12 },
      credentials: [azureCredential],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Provider" }), "azure");
    expect(screen.getByRole("combobox", { name: "Credential" })).toHaveValue(AZURE_CREDENTIAL_ID);
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "azure-control");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(api.discoverAzureOptions).toHaveBeenCalledWith({
      credentialId: AZURE_CREDENTIAL_ID,
      location: "eastus",
    }));
    expect(await screen.findByRole("textbox", { name: "Location" })).toHaveValue("eastus");
    expect(screen.getByRole("textbox", { name: "VM Size" })).toHaveValue("Standard_B2s");
    expect(screen.getByRole("textbox", { name: "Image Reference" })).toHaveValue(
      "Canonical:ubuntu-24_04-lts:server:latest",
    );
    const virtualNetwork = screen.getByRole("button", { name: /Virtual Network/u });
    expect(virtualNetwork).toHaveTextContent("Create a new managed VNet");
    await user.click(virtualNetwork);
    await user.click(screen.getByRole("option", { name: /^operations · networking/u }));
    expect(screen.getByRole("button", { name: /Subnet/u })).toHaveTextContent("default · networking");
    await user.click(screen.getByRole("button", { name: /Virtual Network/u }));
    await user.click(screen.getByRole("option", { name: /^Create a new managed VNet/u }));
    expect(screen.getByRole("textbox", { name: "Managed VNet CIDR" })).toHaveValue("10.0.0.0/16");
    expect(screen.getByRole("textbox", { name: "Managed Subnet CIDR" })).toHaveValue("10.0.1.0/24");
    expect(screen.getByRole("switch", { name: /^Public IP/u })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("textbox", { name: "SSH Port" })).toHaveValue("22");
    expect(screen.getByRole("textbox", { name: "SSH Port" })).toHaveAttribute("readonly");
    expect(screen.getByText("Azure platform images use the standard SSH port.")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "198.51.100.16/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    await waitFor(() => expect(api.createDeployment).toHaveBeenCalledOnce());
    expect(capturedDeployment).toEqual({
      provider: "azure",
      expectedRevision: 12,
      credentialId: AZURE_CREDENTIAL_ID,
      name: "azure-control",
      spec: {
        location: "eastus",
        imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
        vmSize: "Standard_B2s",
        networkMode: "managed",
        vnetId: null,
        subnetId: null,
        managedVnetCidr: "10.0.0.0/16",
        managedSubnetCidr: "10.0.1.0/24",
        sshUsername: "azureuser",
        operatorName: "operator",
        sshPort: 22,
        multiplayerPort: 31_337,
        osDiskSizeGiB: 30,
        usePublicIp: true,
        sshCidrs: ["203.0.113.8/32"],
        operatorCidrs: ["198.51.100.16/32"],
      },
    });
    expect(await screen.findByText("Deployment ready")).toBeInTheDocument();
  });

  it("replaces setup with one full-width deployment instance until provisioning completes", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { ...emptySnapshot.state, revision: 7 },
      credentials: [awsCredential],
    };
    const deploymentResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    const waitingDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "provisioning",
      phase: "waiting-instance-status",
      operatorConfigFileName: null,
      operatorConfigDigest: null,
      remoteHost: null,
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "running",
        instanceHealth: "initializing",
        systemHealth: "initializing",
        publicIpAddress: null,
      },
    };
    vi.mocked(api.createDeployment).mockImplementationOnce(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 8, deployments: [waitingDeployment] },
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "streaming",
          truncated: false,
          chunks: [],
        }],
      };
      queueMicrotask(() => changedListener?.("snapshot"));
      return deploymentResult.promise;
    });

    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "range-control");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "203.0.113.8/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByText("Deployment")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    expect(await screen.findByRole("heading", { name: "range-control" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "New Deployment" })).not.toBeInTheDocument();
    expect(screen.getAllByText("range-control")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Deployment in progress" })).toBeDisabled();
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getByRole("menuitem", { name: "Start" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(within(serverActions).queryByRole("menuitem", { name: "Stop" })).not.toBeInTheDocument();
    expect(within(serverActions).getByRole("menuitem", { name: "Terminate" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText("0/2 checks passed")).toBeInTheDocument();
    expect(screen.getByText("Waiting for SSH")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Operator for range-control" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("button", { name: "Edit firewall for range-control" })).toBeDisabled();

    const readyForSsh: AwsCloudDeploymentRecord = {
      ...waitingDeployment,
      phase: "installing-sliver",
      remoteHost: "198.51.100.24",
      runtime: {
        ...waitingDeployment.runtime,
        instanceHealth: "ok",
        systemHealth: "ok",
        publicIpAddress: "198.51.100.24",
      },
    };
    await act(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 9, deployments: [readyForSsh] },
        provisioningTranscripts: [{
          deploymentId: DEPLOYMENT_ID,
          status: "streaming",
          truncated: false,
          chunks: [{ sequence: 0, bytes: new TextEncoder().encode("sliver-server active\r\n") }],
        }],
      };
      changedListener?.("snapshot");
    });

    expect(await screen.findByText("2/2 checks passed")).toBeInTheDocument();
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toHaveTextContent("sliver-server active");
    expect(screen.getByLabelText("Mock read-only SSH provisioning terminal")).toHaveAttribute("data-read-only", "true");

    await act(async () => {
      currentSnapshot = {
        ...currentSnapshot,
        state: { v: 1, revision: 10, deployments: [runningDeployment] },
        provisioningTranscripts: [],
      };
      changedListener?.("snapshot");
      deploymentResult.resolve({ ok: true, value: runningDeployment });
      await deploymentResult.promise;
    });

    expect(await screen.findByText("Deployment ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New Deployment" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Mock read-only SSH provisioning terminal")).not.toBeInTheDocument();
  });

  it("offers the bounded t3/t4g catalog and keeps AMIs aligned with architecture", async () => {
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "catalog-test");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const instanceType = await screen.findByRole("button", { name: /Instance Type/i });
    await user.click(instanceType);
    for (const name of [
      "t3.micro", "t3.small", "t3.medium", "t3.large", "t3.xlarge",
      "t4g.micro", "t4g.small", "t4g.medium", "t4g.large", "t4g.xlarge",
    ]) expect(screen.getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`, "u") })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^t3\.micro/u })).toHaveTextContent("2 vCPU · 1 GiB · x86-64");
    expect(screen.getByRole("option", { name: /^t4g\.xlarge/u })).toHaveTextContent("4 vCPU · 16 GiB · Arm64");

    await user.click(screen.getByRole("option", { name: /^t4g\.small/u }));
    const machineImage = screen.getByRole("button", { name: /Machine Image/i });
    expect(machineImage).toHaveTextContent("Ubuntu 24.04 LTS");
    expect(machineImage).toHaveTextContent("Arm64");
    await user.click(machineImage);
    expect(screen.getByRole("option", { name: /^Ubuntu 24\.04 LTS/u })).toHaveTextContent("ami-aaaaaaaaaaaaaaaaa · Arm64 · SSH user ubuntu");
    expect(screen.getByRole("option", { name: /^Amazon Linux 2023/u })).toHaveTextContent("ami-bbbbbbbbbbbbbbbbb · Arm64 · SSH user ec2-user");
    await user.click(screen.getByRole("option", { name: /^Amazon Linux 2023/u }));
    expect(screen.getByRole("textbox", { name: "Linux SSH Username" })).toHaveValue("ec2-user");

    await user.click(screen.getByRole("switch", { name: /^Enter AMI manually/u }));
    expect(screen.getByRole("textbox", { name: "AMI ID" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Machine Image/i })).not.toBeInTheDocument();
  });

  it("supports managed networking and disables AWS key pairs that do not match the credential", async () => {
    currentSnapshot = { ...emptySnapshot, state: { ...emptySnapshot.state, revision: 4 }, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "managed-network");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const vpc = await screen.findByRole("button", { name: /VPC/i });
    await user.click(vpc);
    await user.click(screen.getByRole("option", { name: /^Create a new VPC/u }));
    expect(screen.getByRole("textbox", { name: "VPC CIDR" })).toHaveValue("10.0.0.0/16");
    expect(screen.getByRole("textbox", { name: "Subnet CIDR" })).toHaveValue("10.0.1.0/24");
    expect(screen.queryByRole("button", { name: /Subnet/i })).not.toBeInTheDocument();

    const sshKey = screen.getByRole("button", { name: /SSH Key/i });
    await user.click(sshKey);
    expect(screen.getByRole("option", { name: /^Credential key \(managed\)/u })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /^operator-existing/u })).toHaveTextContent("Matches credential key");
    expect(screen.getByRole("option", { name: /^__sliver_managed_key__/u })).toHaveTextContent("Matches credential key");
    expect(screen.getByRole("option", { name: /^unusable-key/u })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("option", { name: /^unusable-key/u })).toHaveTextContent("Unavailable — public key does not match this credential.");
    await user.click(screen.getByRole("option", { name: /^__sliver_managed_key__/u }));
    expect(screen.getByRole("switch", { name: /^Elastic IP/u })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.type(screen.getByRole("textbox", { name: "SSH Source CIDRs" }), "203.0.113.8/32");
    await user.type(screen.getByRole("textbox", { name: "Operator Source CIDRs" }), "198.51.100.16/32");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("button", { name: "Deploy Sliver Server" }));

    await waitFor(() => expect(api.createDeployment).toHaveBeenCalledOnce());
    expect(capturedDeployment).toMatchObject({
      provider: "aws",
      expectedRevision: 4,
      spec: {
        networkMode: "managed",
        vpcId: null,
        subnetId: null,
        managedVpcCidr: "10.0.0.0/16",
        managedSubnetCidr: "10.0.1.0/24",
        sshKeyMode: "existing",
        existingKeyPairName: "__sliver_managed_key__",
        keyPairName: "__sliver_managed_key__",
        useElasticIp: true,
      },
    });
  });

  it("blocks infrastructure continuation when AWS discovery fails and can retry", async () => {
    discoverAwsOptions.mockResolvedValueOnce({ ok: false, error: "ec2:DescribeVpcs denied" });
    currentSnapshot = { ...emptySnapshot, credentials: [awsCredential] };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    await user.type(screen.getByRole("textbox", { name: "Deployment Name" }), "retry-discovery");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("AWS discovery failed")).toBeInTheDocument();
    expect(screen.getByText("ec2:DescribeVpcs denied")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Try Again" }));
    expect(await screen.findByRole("button", { name: /Instance Type/i })).toHaveTextContent("t3.micro");
    expect(discoverAwsOptions).toHaveBeenCalledTimes(2);
  });

  it("routes lifecycle and reviewed destruction through their dedicated bridge methods", async () => {
    currentSnapshot = {
      state: { v: 1, revision: 9, deployments: [runningDeployment] },
      credentials: [awsCredential],
      refreshErrors: [],
      secureCredentialStorage: true,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      azureAccounts: [azureAccount],
      azureAccountDiscoveryError: null,
      provisioningTranscripts: [],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "Server actions for range-control" });
    expect(trigger).not.toHaveTextContent("Server actions");
    expect(trigger.querySelector('svg[data-icon="ellipsis-vertical"]')).toBeInTheDocument();
    let serverActions = await openServerActions(user, "range-control");
    const stopItem = within(serverActions).getByRole("menuitem", { name: "Stop" });
    expect(within(serverActions).queryByRole("menuitem", { name: "Start" })).not.toBeInTheDocument();
    expect(stopItem.querySelector('svg[data-icon="stop"]')).toBeInTheDocument();
    await user.click(stopItem);
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9, action: "stop" }));

    await user.click(screen.getByRole("button", { name: "Edit firewall for range-control" }));
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    await waitFor(() => expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }));
    await user.click(screen.getByRole("button", { name: "Back to managed servers" }));

    serverActions = await openServerActions(user, "range-control");
    const terminateItem = within(serverActions).getByRole("menuitem", { name: "Terminate" });
    expect(terminateItem.querySelector('svg[data-icon="trash"]')).toBeInTheDocument();
    await user.click(terminateItem);
    expect(await screen.findByRole("alertdialog", { name: "Terminate range-control?" })).toBeInTheDocument();
    expect(api.prepareDestroyDeployment).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9 });
    await user.click(screen.getByRole("button", { name: "Terminate Instance" }));
    await waitFor(() => expect(api.executeDestroyDeployment).toHaveBeenCalledWith({ token: "destroy-token" }));
  });

  it("warns explicitly before recursively deleting a dedicated Azure resource group", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 9, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    vi.mocked(api.prepareDestroyDeployment).mockResolvedValueOnce({
      ok: true,
      value: {
        token: "destroy-token",
        deploymentId: AZURE_DEPLOYMENT_ID,
        deploymentName: "azure-control",
        provider: "azure",
        expiresAt: "2026-09-06T19:00:00.000Z",
      },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await screen.findByRole("heading", { name: "azure-control" });
    const serverActions = await openServerActions(user, "azure-control");
    await user.click(within(serverActions).getByRole("menuitem", { name: "Terminate" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Terminate azure-control?" });
    expect(within(confirmation).getByText(/Azure will recursively delete the dedicated resource group/u))
      .toHaveTextContent("sliver-gui-azure-control");
    expect(within(confirmation).getByText(/Do not add unrelated resources while termination is running/u))
      .toBeInTheDocument();
  });

  it("groups connection actions on the left and lifecycle actions on the right", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const connectionActions = await screen.findByRole("group", { name: "Access and operator actions for range-control" });
    const lifecycleActions = screen.getByRole("group", { name: "Lifecycle actions for range-control" });

    const connectionLabels = within(connectionActions)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);
    const lifecycleLabels = within(lifecycleActions)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label"))
      .filter((label): label is string => label !== null);

    expect(within(connectionActions).getAllByRole("button")).toHaveLength(3);
    expect(connectionLabels).toEqual([
      "SSH to range-control",
      "Edit firewall for range-control",
      "New Operator for range-control",
    ]);
    expect(lifecycleLabels).toEqual(["Server actions for range-control"]);
    expect(lifecycleActions).toHaveClass("ml-auto");
    const serverActions = await openServerActions(user, "range-control");
    expect(within(serverActions).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Stop",
      "Reboot",
      "Terminate",
    ]);
    expect(within(serverActions).getByRole("menuitem", { name: "Terminate" })).toHaveClass("menu-item--danger");
  });

  it("supports keyboard navigation and focus restoration for the icon-only server menu", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const trigger = await screen.findByRole("button", { name: "Server actions for range-control" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const menu = await screen.findByRole("menu", { name: "Server actions for range-control" });
    const rename = within(menu).getByRole("menuitem", { name: "Rename" });
    const stop = within(menu).getByRole("menuitem", { name: "Stop" });
    const reboot = within(menu).getByRole("menuitem", { name: "Reboot" });
    const terminate = within(menu).getByRole("menuitem", { name: "Terminate" });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(rename).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(stop).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(reboot).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(terminate).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu", {
      name: "Server actions for range-control",
    })).not.toBeInTheDocument());
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("opens Rename from server actions with the current name and cancels without a mutation", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(within(await openServerActions(user, "range-control")).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename Instance" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("range-control");
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename Instance" })).not.toBeInTheDocument());
    expect(api.renameDeployment).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Server actions for range-control" })).toHaveFocus();
  });

  it.each([runningDeployment, runningAzureDeployment])("opens the same rename modal from navigation for $provider", async (deployment) => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 9, deployments: [deployment] },
      credentials: [awsCredential, azureCredential],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    act(() => navigationListener?.({ view: "deployments", deploymentId: deployment.id, action: "rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename Instance" });
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue(deployment.name);
    expect(api.renameDeployment).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename Instance" })).not.toBeInTheDocument());
  });

  it("saves a trimmed name once, keeps Save/Cancel locked while pending, and refreshes after success", async () => {
    currentSnapshot = runningCloudSnapshot();
    const saved = deferred<Awaited<ReturnType<CloudDeploymentAPI["renameDeployment"]>>>();
    vi.mocked(api.renameDeployment).mockReturnValueOnce(saved.promise);
    const successToast = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(within(await openServerActions(user, "range-control")).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename Instance" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(input);
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    await user.type(input, "  Team Server  ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.renameDeployment).toHaveBeenCalledExactlyOnceWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9, name: "Team Server" });
    expect(input).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeInTheDocument();
    expect(successToast).not.toHaveBeenCalled();

    const renamed = { ...runningDeployment, name: "Team Server" };
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [renamed] } };
    await act(async () => saved.resolve({ ok: true, value: renamed }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename Instance" })).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Server actions for Team Server" })).toBeInTheDocument();
    expect(successToast).toHaveBeenCalledWith("Instance renamed", expect.objectContaining({ description: "range-control is now Team Server." }));
    successToast.mockRestore();
  });

  it("keeps the draft and captured revision when a rename fails after a background refresh", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.renameDeployment).mockResolvedValueOnce({ ok: false, error: "Deployment state changed. Refresh and try again." });
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(within(await openServerActions(user, "range-control")).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename Instance" });
    const input = within(dialog).getByRole("textbox", { name: "Name" });
    await user.clear(input);
    await user.type(input, "Draft name");
    currentSnapshot = { ...currentSnapshot, state: { ...currentSnapshot.state, revision: 10 } };
    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(api.getSnapshot).toHaveBeenCalledTimes(2));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(api.renameDeployment).toHaveBeenCalledExactlyOnceWith({ deploymentId: DEPLOYMENT_ID, expectedRevision: 9, name: "Draft name" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Deployment state changed. Refresh and try again.");
    expect(input).toHaveValue("Draft name");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("releases the rename lock when a refreshed inventory removes its instance", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 9, deployments: [runningDeployment, runningAzureDeployment] },
      credentials: [awsCredential, azureCredential],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(within(await openServerActions(user, "range-control")).getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("dialog", { name: "Rename Instance" });
    act(() => navigationListener?.({ view: "deployments", deploymentId: AZURE_DEPLOYMENT_ID, action: "rename" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("range-control");
    currentSnapshot = { ...currentSnapshot, state: { v: 1, revision: 10, deployments: [runningAzureDeployment] } };
    act(() => changedListener?.("snapshot"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("azure-control"));
    expect(api.renameDeployment).not.toHaveBeenCalled();
  });

  it("opens a validated operator form with editable endpoint and permission controls", async () => {
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: {
        v: 1,
        revision: 9,
        deployments: [{ ...runningDeployment, remoteHost: "198.51.100.99" }],
      },
    };
    const creation = deferred<Awaited<ReturnType<CloudDeploymentAPI["createOperatorConfig"]>>>();
    vi.mocked(api.createOperatorConfig).mockReturnValueOnce(creation.promise);
    const successToast = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const newOperator = await screen.findByRole("button", { name: "New Operator for range-control" });
    expect(newOperator).toHaveTextContent("New Operator");
    expect(newOperator).toBeEnabled();
    await user.keyboard("{Tab}");
    newOperator.focus();
    await waitFor(() => expect(screen.getByRole("tooltip")).toHaveTextContent("Add an operator to range-control"));
    newOperator.blur();
    await user.click(newOperator);

    expect(await screen.findByRole("heading", { level: 1, name: "New Operator" })).toBeInTheDocument();
    expect(screen.queryByText("Full server permissions")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to managed servers" })).toBeInTheDocument();
    const form = screen.getByRole("form", { name: "New Operator for range-control" });
    const operatorName = within(form).getByRole("textbox", { name: "Operator Name" });
    const publicIp = within(form).getByRole("textbox", { name: "Public IP" });
    const port = within(form).getByRole("textbox", { name: "Port" });
    const permissions = within(form).getByRole("combobox", { name: "Permissions" });
    const submit = within(form).getByRole("button", { name: "Create Operator" });
    expect(publicIp).toHaveValue("198.51.100.24");
    expect(port).toHaveValue("31337");
    expect(permissions).toHaveValue("all");
    expect(within(permissions).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Full access",
      "Remote builder",
      "Crackstation",
    ]);
    expect(submit).toBeDisabled();

    await user.type(operatorName, "invalid operator");
    expect(within(form).getByText("Use 1–128 letters, numbers, underscores, or hyphens.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(operatorName);
    await user.type(operatorName, "alice_ops-1");
    await user.clear(publicIp);
    await user.type(publicIp, "999.0.0.1");
    expect(within(form).getByText("Enter a valid public IPv4 address.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(publicIp);
    await user.type(publicIp, "203.0.113.80");
    await user.clear(port);
    await user.type(port, "65536");
    expect(within(form).getByText("Enter a TCP port from 1 to 65535.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(port);
    await user.type(port, "44331");
    await user.selectOptions(permissions, "builder");
    expect(within(form).getByText("Restricted to remote builder RPCs.")).toBeInTheDocument();
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(api.createOperatorConfig).toHaveBeenCalledExactlyOnceWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      operatorName: "alice_ops-1",
      publicIp: "203.0.113.80",
      port: 44_331,
      permissions: "builder",
    });
    expect(submit).toHaveAttribute("data-pending", "true");
    expect(screen.getByRole("button", { name: "Back to managed servers" })).toBeDisabled();

    await act(async () => {
      creation.resolve({
        ok: true,
        value: { saved: true, fileName: "alice_ops-1.cfg", mutationState: "created" },
      });
      await creation.promise;
    });

    expect(await screen.findByRole("heading", { name: "Managed Servers" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "New Operator" })).not.toBeInTheDocument();
    expect(successToast).toHaveBeenCalledWith("Operator config saved", {
      description: "alice_ops-1 now has remote builder access on range-control. alice_ops-1.cfg was saved to disk.",
      timeout: 30_000,
    });
    successToast.mockRestore();
  });

  it("queues native navigation until an in-flight operator request finishes", async () => {
    currentSnapshot = runningCloudSnapshot();
    const creation = deferred<Awaited<ReturnType<CloudDeploymentAPI["createOperatorConfig"]>>>();
    vi.mocked(api.createOperatorConfig).mockReturnValueOnce(creation.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Operator for range-control" }));
    const form = screen.getByRole("form", { name: "New Operator for range-control" });
    await user.type(within(form).getByRole("textbox", { name: "Operator Name" }), "pending_operator");
    await user.click(within(form).getByRole("button", { name: "Create Operator" }));
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);

    act(() => navigationListener?.({ view: "firewall", deploymentId: DEPLOYMENT_ID }));
    expect(screen.getByRole("heading", { level: 1, name: "New Operator" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Firewall rules" })).not.toBeInTheDocument();

    await act(async () => {
      creation.resolve({
        ok: true,
        value: { saved: false, fileName: "pending_operator.cfg", mutationState: "not-started" },
      });
      await creation.promise;
    });

    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "New Operator" })).not.toBeInTheDocument();
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);
  });

  it.each(["Back to managed servers", "Cancel"] as const)(
    "restores focus to the New Operator trigger after %s",
    async (navigationLabel) => {
      currentSnapshot = runningCloudSnapshot();
      const user = userEvent.setup();
      renderCloudDeploymentApp();

      const trigger = await screen.findByRole("button", { name: "New Operator for range-control" });
      await user.click(trigger);
      expect(await screen.findByRole("textbox", { name: "Operator Name" })).toHaveFocus();
      await user.click(screen.getByRole("button", { name: navigationLabel }));

      expect(await screen.findByRole("heading", { name: "Managed Servers" })).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole("button", {
        name: "New Operator for range-control",
      })).toHaveFocus());
    },
  );

  it("keeps the operator form retryable when the native save is canceled or creation has not started", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.createOperatorConfig)
      .mockResolvedValueOnce({
        ok: true,
        value: { saved: false, fileName: "canceled.cfg", mutationState: "not-started" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: {
          saved: false,
          fileName: "duplicate_operator.cfg",
          mutationState: "not-started",
          error: "The remote operator already exists.",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { saved: true, fileName: "duplicate_operator.cfg", mutationState: "created" },
      });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Operator for range-control" }));
    const operatorName = screen.getByRole("textbox", { name: "Operator Name" });
    const submit = screen.getByRole("button", { name: "Create Operator" });
    await user.type(operatorName, "duplicate_operator");
    await user.click(submit);

    expect(await screen.findByText("Configuration not saved")).toBeInTheDocument();
    expect(screen.getByText(/save dialog was closed/u)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "New Operator" })).toBeInTheDocument();
    expect(operatorName).toBeEnabled();
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(await screen.findByText("Operator not created")).toBeInTheDocument();
    expect(screen.getByText("The remote operator already exists.")).toBeInTheDocument();
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(2);
    expect(operatorName).toBeEnabled();
    expect(submit).toBeEnabled();

    await user.click(submit);
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(3);
    expect(await screen.findByRole("heading", { name: "Managed Servers" })).toBeInTheDocument();
  });

  it.each([
    {
      mutationState: "unknown" as const,
      title: "Operator outcome requires review",
      error: "The server CLI may have created the operator. Review the managed server before trying again.",
    },
    {
      mutationState: "created" as const,
      title: "Operator created — recovery required",
      error: "The operator exists, but the local save failed. Recover the config from /var/lib/sliver-gui/range/operator-export/operator-aaaaaaaaaaaaaaaa.cfg.",
      remoteRecoveryPath: "/var/lib/sliver-gui/range/operator-export/operator-aaaaaaaaaaaaaaaa.cfg",
    },
  ])("blocks another operator request after a $mutationState mutation outcome", async ({
    mutationState,
    title,
    error,
    remoteRecoveryPath,
  }) => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.createOperatorConfig).mockResolvedValueOnce({
      ok: true,
      value: {
        saved: false,
        fileName: "locked-operator.cfg",
        mutationState,
        error,
        ...(remoteRecoveryPath ? { remoteRecoveryPath } : {}),
      },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Operator for range-control" }));
    const form = screen.getByRole("form", { name: "New Operator for range-control" });
    const operatorName = within(form).getByRole("textbox", { name: "Operator Name" });
    const publicIp = within(form).getByRole("textbox", { name: "Public IP" });
    const port = within(form).getByRole("textbox", { name: "Port" });
    const permissions = within(form).getByRole("combobox", { name: "Permissions" });
    const submit = within(form).getByRole("button", { name: "Create Operator" });
    await user.type(operatorName, "locked_operator");
    await user.clear(publicIp);
    await user.type(publicIp, "203.0.113.90");
    await user.clear(port);
    await user.type(port, "44332");
    await user.selectOptions(permissions, "crackstation");
    await user.click(submit);

    expect(await within(form).findByText(title)).toBeInTheDocument();
    expect(within(form).getByText(error)).toBeInTheDocument();
    expect(operatorName).toBeDisabled();
    expect(publicIp).toBeDisabled();
    expect(port).toBeDisabled();
    expect(permissions).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);

    await user.click(submit);
    fireEvent.submit(form);
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);

    await user.click(within(form).getByRole("button", { name: "Cancel" }));
    await user.click(await screen.findByRole("button", { name: "New Operator for range-control" }));
    const reopenedForm = screen.getByRole("form", { name: "New Operator for range-control" });
    expect(await within(reopenedForm).findByText(title)).toBeInTheDocument();
    expect(within(reopenedForm).getByRole("textbox", { name: "Operator Name" })).toHaveValue("locked_operator");
    expect(within(reopenedForm).getByRole("textbox", { name: "Operator Name" })).toBeDisabled();
    expect(within(reopenedForm).getByRole("textbox", { name: "Public IP" })).toHaveValue("203.0.113.90");
    expect(within(reopenedForm).getByRole("textbox", { name: "Public IP" })).toBeDisabled();
    expect(within(reopenedForm).getByRole("textbox", { name: "Port" })).toHaveValue("44332");
    expect(within(reopenedForm).getByRole("textbox", { name: "Port" })).toBeDisabled();
    expect(within(reopenedForm).getByRole("combobox", { name: "Permissions" })).toHaveValue("crackstation");
    expect(within(reopenedForm).getByRole("combobox", { name: "Permissions" })).toBeDisabled();
    expect(within(reopenedForm).getByRole("button", { name: "Create Operator" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Back to managed servers" })).toHaveFocus();
    fireEvent.submit(reopenedForm);
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);
  });

  it.each(["returned", "thrown"] as const)("blocks retry after an opaque IPC failure is %s", async (failureKind) => {
    currentSnapshot = runningCloudSnapshot();
    if (failureKind === "returned") {
      vi.mocked(api.createOperatorConfig).mockResolvedValueOnce({
        ok: false,
        error: "The Cloud Deployment request was rejected",
      });
    } else {
      vi.mocked(api.createOperatorConfig).mockRejectedValueOnce(new Error("The operator request was interrupted"));
    }
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "New Operator for range-control" }));
    const form = screen.getByRole("form", { name: "New Operator for range-control" });
    const operatorName = within(form).getByRole("textbox", { name: "Operator Name" });
    const submit = within(form).getByRole("button", { name: "Create Operator" });
    await user.type(operatorName, "opaque_failure");
    await user.click(submit);

    expect(await within(form).findByText("Operator outcome requires review")).toBeInTheDocument();
    expect(operatorName).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);
    fireEvent.submit(form);
    expect(api.createOperatorConfig).toHaveBeenCalledTimes(1);
  });

  it("opens SSH through the dedicated bridge and requires explicit first-use host-key approval", async () => {
    currentSnapshot = runningCloudSnapshot();
    const openResult = deferred<OperationResult<SshOpenTabResult>>();
    vi.mocked(api.openSshWindow).mockImplementationOnce(() => openResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    const sshButton = await screen.findByRole("button", { name: "SSH to range-control" });
    expect(sshButton.querySelector('svg[data-icon="terminal"]')).toBeInTheDocument();
    await user.click(sshButton);
    expect(sshButton).toHaveAttribute("aria-disabled", "true");
    expect(api.openSshWindow).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID });

    await act(async () => {
      openResult.resolve({
        ok: true,
        value: { status: "host-key-review", review: sshHostKeyReview },
      });
      await openResult.promise;
    });

    const review = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    expect(within(review).getByText("range-control")).toBeInTheDocument();
    expect(within(review).getByText("198.51.100.24:22")).toBeInTheDocument();
    expect(within(review).getByText(sshHostKeyReview.fingerprint)).toBeInTheDocument();
    expect(within(review).getByText(/Review expires/u)).toBeInTheDocument();

    await user.click(within(review).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog", { name: "Verify SSH host" })).not.toBeInTheDocument();
    expect(api.approveSshHostKey).not.toHaveBeenCalled();

    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: true,
      value: { status: "host-key-review", review: sshHostKeyReview },
    });
    const approval = deferred<OperationResult<SshOpenTabResult>>();
    vi.mocked(api.approveSshHostKey).mockImplementationOnce(() => approval.promise);
    await user.click(sshButton);
    const secondReview = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    const connectButton = within(secondReview).getByRole("button", { name: "Trust & Connect" });
    await user.click(connectButton);
    expect(connectButton).toHaveAttribute("aria-disabled", "true");
    expect(connectButton).toHaveAttribute("data-pending", "true");
    expect(api.approveSshHostKey).toHaveBeenCalledWith({ token: SSH_REVIEW_TOKEN });

    await act(async () => {
      approval.resolve({
        ok: true,
        value: { status: "opened", tabId: "t".repeat(43), created: true },
      });
      await approval.promise;
    });
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog", { name: "Verify SSH host" })).not.toBeInTheDocument();
    });
  });

  it("keeps host-key approval failures in the review and re-probes before another approval", async () => {
    currentSnapshot = runningCloudSnapshot();
    const refreshedReview: SshHostKeyReview = {
      ...sshHostKeyReview,
      token: "s".repeat(43),
      fingerprint: `SHA256:${"B".repeat(43)}`,
      expiresAt: "2026-09-07T19:05:00.000Z",
    };
    vi.mocked(api.openSshWindow)
      .mockResolvedValueOnce({
        ok: true,
        value: { status: "host-key-review", review: sshHostKeyReview },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { status: "host-key-review", review: refreshedReview },
      });
    vi.mocked(api.approveSshHostKey).mockResolvedValueOnce({
      ok: false,
      error: "The SSH host-key review is invalid or expired.\nTry again.\u0000",
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "SSH to range-control" }));
    const review = await screen.findByRole("alertdialog", { name: "Verify SSH host" });
    await user.click(within(review).getByRole("button", { name: "Trust & Connect" }));

    const approvalError = await within(review).findByRole("alert");
    expect(within(approvalError).getByText("SSH connection failed")).toBeInTheDocument();
    expect(within(approvalError).getByText(
      "The SSH host-key review is invalid or expired. Try again.",
    )).toBeInTheDocument();
    expect(screen.getByRole("alertdialog", { name: "Verify SSH host" })).toBe(review);
    expect(api.approveSshHostKey).toHaveBeenCalledTimes(1);

    await user.click(within(review).getByRole("button", { name: "Re-check Host" }));

    await waitFor(() => {
      expect(within(review).getByText(refreshedReview.fingerprint)).toBeInTheDocument();
    });
    expect(within(review).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Trust & Connect" })).toBeInTheDocument();
    expect(api.openSshWindow).toHaveBeenCalledTimes(2);
    expect(api.openSshWindow).toHaveBeenLastCalledWith({ deploymentId: DEPLOYMENT_ID });
    expect(api.approveSshHostKey).toHaveBeenCalledTimes(1);
  });

  it("enables SSH only for a running deployment with its credential and a target address", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "c8a6e2b7-1d45-4f92-89cc-1f2c31bc57b8",
      name: "stopped-server",
      status: "stopped",
      phase: "stopped",
      runtime: { ...runningDeployment.runtime, instanceState: "stopped" },
    };
    const missingCredentialDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "b0bd8e1d-09cf-468d-a122-bc18ae18a573",
      name: "missing-key-server",
      credentialId: "477410eb-f3be-4e79-840c-d87215db28ee",
    };
    const missingHostDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: "a6405996-8a87-4e1d-b85c-3eb692b9fc67",
      name: "missing-host-server",
      remoteHost: null,
      runtime: {
        ...runningDeployment.runtime,
        publicIpAddress: null,
        privateIpAddress: null,
      },
    };
    const missingAzurePublicDeployment: AzureCloudDeploymentRecord = {
      ...runningAzureDeployment,
      id: "d617c765-93b7-4931-884e-8439db916b9d",
      name: "missing-azure-public-server",
      remoteHost: "10.0.1.4",
      runtime: {
        ...runningAzureDeployment.runtime,
        publicIpAddress: null,
        privateIpAddress: "10.0.1.4",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: {
        v: 1,
        revision: 9,
        deployments: [
          runningDeployment,
          stoppedDeployment,
          missingCredentialDeployment,
          missingHostDeployment,
          missingAzurePublicDeployment,
        ],
      },
      credentials: [awsCredential, azureCredential],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByRole("button", { name: "SSH to range-control" })).toBeEnabled();
    const unavailableButtons = [
      screen.getByRole("button", { name: "SSH to stopped-server" }),
      screen.getByRole("button", { name: "SSH to missing-key-server" }),
      screen.getByRole("button", { name: "SSH to missing-host-server" }),
      screen.getByRole("button", { name: "SSH to missing-azure-public-server" }),
    ];
    for (const button of unavailableButtons) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
    }
    for (const reason of unavailableButtons) expect(reason).toHaveAttribute("tabindex", "0");
    const stoppedReason = unavailableButtons[0]!;
    await user.hover(stoppedReason);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Start this server before opening SSH.");
    await user.unhover(stoppedReason);

    const stoppedOperator = screen.getByRole("button", { name: "New Operator for stopped-server" });
    const missingKeyOperator = screen.getByRole("button", { name: "New Operator for missing-key-server" });
    const missingHostOperator = screen.getByRole("button", { name: "New Operator for missing-host-server" });
    const missingAzureOperator = screen.getByRole("button", { name: "New Operator for missing-azure-public-server" });
    for (const button of [stoppedOperator, missingKeyOperator, missingHostOperator, missingAzureOperator]) {
      expect(button).toHaveAttribute("aria-disabled", "true");
      expect(button).toHaveAttribute("tabindex", "0");
      await user.click(button);
    }
    await user.hover(stoppedOperator);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Start this server before adding an operator.");
    expect(api.createOperatorConfig).not.toHaveBeenCalled();
    expect(api.openSshWindow).not.toHaveBeenCalled();
  });

  it("bounds and flattens SSH launch errors before showing them", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: false,
      error: `  Connection refused\nretry\u0000later ${"x".repeat(600)}`,
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "SSH to range-control" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("SSH connection failed")).toBeInTheDocument();
    const detail = within(alert).getByText(/^Connection refused retry later/u);
    expect(detail.textContent).not.toContain("\n");
    expect(detail.textContent).not.toContain("\u0000");
    expect(detail.textContent?.length).toBe(512);
  });

  it("reuses one lifecycle menu item across stopped, pending, and running states", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "stopped",
      phase: "stopped",
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "stopped",
        instanceHealth: "unknown",
        systemHealth: "unknown",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 10, deployments: [stoppedDeployment] },
    };
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    let serverActions = await openServerActions(user, "range-control");
    const startItem = within(serverActions).getByRole("menuitem", { name: "Start" });
    expect(within(serverActions).queryByRole("menuitem", { name: "Stop" })).not.toBeInTheDocument();
    expect(startItem.querySelector('svg[data-icon="play"]')).toBeInTheDocument();

    await user.click(startItem);
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 10,
      action: "start",
    });
    expect(await screen.findByRole("dialog", { name: "Starting range-control" })).toBeInTheDocument();

    currentSnapshot = { ...runningCloudSnapshot(), state: { v: 1, revision: 11, deployments: [runningDeployment] } };
    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Starting range-control" })).not.toBeInTheDocument());
    serverActions = await openServerActions(user, "range-control");
    const stopItem = within(serverActions).getByRole("menuitem", { name: "Stop" });
    expect(within(serverActions).queryByRole("menuitem", { name: "Start" })).not.toBeInTheDocument();
    expect(stopItem.querySelector('svg[data-icon="stop"]')).toHaveClass("text-warning");
  });

  it.each([
    ["AWS", runningDeployment, awsCredential],
    ["Azure", runningAzureDeployment, azureCredential],
  ] as const)("opens the existing %s operator form from native navigation without creating an operator", async (_provider, deployment, credential) => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 9, deployments: [deployment] },
      credentials: [credential],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    act(() => navigationListener?.({ view: "deployments", deploymentId: deployment.id, action: "operator" }));

    const form = await screen.findByRole("form", { name: `New Operator for ${deployment.name}` });
    expect(within(form).getByRole("textbox", { name: "Operator Name" })).toHaveValue("");
    expect(screen.getByRole("heading", { level: 1, name: "New Operator" })).toBeInTheDocument();
    expect(api.createOperatorConfig).not.toHaveBeenCalled();
    expect(api.openSshWindow).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Back to managed servers" }));
    expect(await screen.findByRole("button", { name: `New Operator for ${deployment.name}` })).toHaveFocus();
  });

  it("opens the operator form from native navigation while idle deployment setup is open", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    expect(screen.getByRole("button", { name: "Close Setup" })).toBeInTheDocument();
    act(() => navigationListener?.({ view: "deployments", deploymentId: DEPLOYMENT_ID, action: "operator" }));

    expect(await screen.findByRole("form", { name: "New Operator for range-control" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close Setup" })).not.toBeInTheDocument();
    expect(api.createOperatorConfig).not.toHaveBeenCalled();
  });

  it("routes a reboot shortcut through the existing lifecycle flow while idle setup is open", async () => {
    currentSnapshot = runningCloudSnapshot();
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockReturnValueOnce(lifecycleResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();
    await user.click(await screen.findByRole("button", { name: "New Deployment" }));
    act(() => navigationListener?.({ view: "deployments", deploymentId: DEPLOYMENT_ID, action: "reboot" }));

    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledExactlyOnceWith({
      deploymentId: DEPLOYMENT_ID, expectedRevision: 9, action: "reboot",
    }));
    expect(screen.queryByRole("button", { name: "Close Setup" })).not.toBeInTheDocument();
    await act(async () => lifecycleResult.resolve({ ok: true, value: runningDeployment }));
  });

  it("retains an Add Operator navigation request while the initial inventory loads", async () => {
    currentSnapshot = runningCloudSnapshot();
    const initial = deferred<OperationResult<CloudDeploymentSnapshot>>();
    vi.mocked(api.getSnapshot).mockReturnValueOnce(initial.promise);
    renderCloudDeploymentApp();
    act(() => navigationListener?.({ view: "deployments", deploymentId: DEPLOYMENT_ID, action: "operator" }));
    expect(screen.queryByRole("heading", { name: "New Operator" })).not.toBeInTheDocument();

    await act(async () => initial.resolve({ ok: true, value: currentSnapshot }));
    expect(await screen.findByRole("form", { name: "New Operator for range-control" })).toBeInTheDocument();
    expect(api.createOperatorConfig).not.toHaveBeenCalled();
  });

  it.each(["stopped", "missing SSH credential", "unstable runtime"])("rechecks Add Operator availability when native menu state is stale: %s", async (reason) => {
    const deployment: AwsCloudDeploymentRecord = reason === "stopped"
      ? { ...runningDeployment, status: "stopped", runtime: { ...runningDeployment.runtime, instanceState: "stopped" } }
      : reason === "unstable runtime"
        ? { ...runningDeployment, runtime: { ...runningDeployment.runtime, instanceState: "pending" } }
        : runningDeployment;
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 9, deployments: [deployment] },
      credentials: reason === "missing SSH credential" ? [] : [awsCredential],
    };
    renderCloudDeploymentApp();
    await screen.findByText("range-control");
    act(() => navigationListener?.({ view: "deployments", deploymentId: DEPLOYMENT_ID, action: "operator" }));

    expect(await screen.findByText("Operator creation unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "New Operator for range-control" })).not.toBeInTheDocument();
    expect(api.createOperatorConfig).not.toHaveBeenCalled();
  });

  it("handles a native stop request on the servers tab with a modal for the full pending duration", async () => {
    currentSnapshot = runningCloudSnapshot();
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    const successToast = vi.spyOn(toast, "success");
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    expect(screen.getByRole("heading", { name: "Provider Credentials" })).toBeInTheDocument();

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));

    const progress = await screen.findByRole("dialog", { name: "Stopping range-control" });
    expect(within(progress).getByText(/provider request is in progress/u)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Servers/u, hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      action: "stop",
    });
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledOnce());
    act(() => navigationListener?.({ view: "firewall", deploymentId: DEPLOYMENT_ID }));
    expect(screen.getByRole("dialog", { name: "Stopping range-control" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Firewall rules" })).not.toBeInTheDocument();
    const actionsTrigger = screen.getByRole("button", { name: "Server actions for range-control", hidden: true });
    expect(actionsTrigger).not.toHaveTextContent("Stop");
    expect(actionsTrigger).not.toHaveTextContent("Reboot");
    expect(actionsTrigger.querySelector('svg[data-icon="ellipsis-vertical"]')).toBeInTheDocument();

    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stopping range-control" })).not.toBeInTheDocument());
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(successToast).toHaveBeenCalledWith("Stop requested", {
      description: "range-control was updated by AWS EC2.",
      timeout: 30_000,
    });
    successToast.mockRestore();
  });

  it("serializes native lifecycle actions across deployment cards", async () => {
    const secondDeploymentId = "44444444-4444-4444-8444-444444444444";
    const secondDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      id: secondDeploymentId,
      name: "range-secondary",
      remoteHost: "198.51.100.25",
      managedAssets: [{ resourceType: "ec2-instance", resourceId: "i-def456", displayName: "range-secondary", tagged: true }],
      runtime: {
        ...runningDeployment.runtime,
        instanceId: "i-def456",
        publicIpAddress: "198.51.100.25",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 12, deployments: [runningDeployment, secondDeployment] },
    };
    const firstResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    const secondResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction)
      .mockImplementationOnce(() => firstResult.promise)
      .mockImplementationOnce(() => secondResult.promise);
    renderCloudDeploymentApp();

    await screen.findByText("range-secondary");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "stop",
    }));
    expect(await screen.findByRole("dialog", { name: "Stopping range-control" })).toBeInTheDocument();

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: secondDeploymentId,
      action: "stop",
    }));
    expect(api.runLifecycleAction).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Stopping range-secondary" })).not.toBeInTheDocument();

    await act(async () => {
      firstResult.resolve({ ok: true, value: runningDeployment });
      await firstResult.promise;
    });
    await waitFor(() => expect(api.runLifecycleAction).toHaveBeenCalledTimes(2));
    expect(api.runLifecycleAction).toHaveBeenLastCalledWith({
      deploymentId: secondDeploymentId,
      expectedRevision: 12,
      action: "stop",
    });
    expect(await screen.findByRole("dialog", { name: "Stopping range-secondary" })).toBeInTheDocument();

    await act(async () => {
      secondResult.resolve({ ok: true, value: secondDeployment });
      await secondResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Stopping range-secondary" })).not.toBeInTheDocument());
  });

  it("shows the pending modal for a native start request until the provider responds", async () => {
    const stoppedDeployment: AwsCloudDeploymentRecord = {
      ...runningDeployment,
      status: "stopped",
      phase: "stopped",
      runtime: {
        ...runningDeployment.runtime,
        instanceState: "stopped",
        instanceHealth: "unknown",
        systemHealth: "unknown",
      },
    };
    currentSnapshot = {
      ...runningCloudSnapshot(),
      state: { v: 1, revision: 10, deployments: [stoppedDeployment] },
    };
    const lifecycleResult = deferred<OperationResult<AwsCloudDeploymentRecord>>();
    vi.mocked(api.runLifecycleAction).mockImplementationOnce(() => lifecycleResult.promise);
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "start",
    }));

    expect(await screen.findByRole("dialog", { name: "Starting range-control" })).toBeInTheDocument();
    expect(api.runLifecycleAction).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 10,
      action: "start",
    });

    await act(async () => {
      lifecycleResult.resolve({ ok: true, value: runningDeployment });
      await lifecycleResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Starting range-control" })).not.toBeInTheDocument());
  });

  it("opens SSH from native navigation and preserves first-use host-key review", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.openSshWindow).mockResolvedValueOnce({
      ok: true,
      value: { status: "host-key-review", review: sshHostKeyReview },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("tab", { name: /Credentials/u }));
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "ssh",
    }));

    expect(await screen.findByRole("alertdialog", { name: "Verify SSH host" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Servers/u, hidden: true })).toHaveAttribute("aria-selected", "true");
    expect(api.openSshWindow).toHaveBeenCalledExactlyOnceWith({ deploymentId: DEPLOYMENT_ID });
  });

  it("keeps native termination confirmation before showing its pending modal", async () => {
    currentSnapshot = runningCloudSnapshot();
    const destroyResult = deferred<Awaited<ReturnType<CloudDeploymentAPI["executeDestroyDeployment"]>>>();
    vi.mocked(api.executeDestroyDeployment).mockImplementationOnce(() => destroyResult.promise);
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "terminate",
    }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Terminate range-control?" });
    expect(screen.queryByRole("dialog", { name: "Terminating range-control" })).not.toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "Terminate Instance" }));

    expect(await screen.findByRole("dialog", { name: "Terminating range-control" })).toBeInTheDocument();
    expect(api.executeDestroyDeployment).toHaveBeenCalledWith({ token: "destroy-token" });

    await act(async () => {
      destroyResult.resolve({ ok: true, value: emptySnapshot.state });
      await destroyResult.promise;
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Terminating range-control" })).not.toBeInTheDocument());
  });

  it("opens the requested AWS firewall view from native navigation", async () => {
    currentSnapshot = runningCloudSnapshot();
    renderCloudDeploymentApp();

    await screen.findByText("range-control");
    act(() => navigationListener?.({ view: "firewall", deploymentId: DEPLOYMENT_ID }));

    expect(await screen.findByRole("heading", { level: 1, name: "range-control" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID });
  });

  it("opens the requested Azure firewall view and surfaces persistent errors for stale native targets", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 9, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    currentFirewallSnapshot = azureFirewallSnapshot;
    const dangerToast = vi.spyOn(toast, "danger");
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await screen.findByRole("heading", { name: "azure-control" });
    act(() => navigationListener?.({ view: "firewall", deploymentId: AZURE_DEPLOYMENT_ID }));
    expect(await screen.findByRole("heading", { level: 1, name: "azure-control" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: AZURE_DEPLOYMENT_ID });
    expect(dangerToast).not.toHaveBeenCalled();

    for (const kind of ["public", "private"] as const) {
      const label = kind === "public" ? "Public IP" : "Private IP";
      await user.click(screen.getByRole("button", { name: `Copy ${label}` }));
      expect(api.copyIpAddress).toHaveBeenLastCalledWith({ deploymentId: AZURE_DEPLOYMENT_ID, kind });
      expect(await screen.findByText(`${label} copied`)).toBeInTheDocument();
    }

    act(() => navigationListener?.({
      view: "deployments",
      deploymentId: DEPLOYMENT_ID,
      action: "start",
    }));
    const staleAlert = await within(screen.getByRole("main")).findByRole("alert");
    expect(staleAlert).toHaveTextContent("Cloud action unavailable");
    expect(staleAlert).toHaveTextContent("is no longer in the managed inventory");
    expect(dangerToast).not.toHaveBeenCalled();
    dangerToast.mockRestore();
  });

  it("opens a dedicated AWS instance details view with inbound and outbound rule tables", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    const { container } = renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit firewall for range-control" }));

    const instanceHeading = await screen.findByRole("heading", { level: 1, name: "range-control" });
    await waitFor(() => expect(api.listFirewallRules).toHaveBeenCalledWith({ deploymentId: DEPLOYMENT_ID }));
    const backButton = screen.getByRole("button", { name: "Back to managed servers" });
    const stickyHeader = screen.getByTestId("aws-instance-sticky-header");
    const scrollRegion = screen.getByRole("region", { name: "Instance details content" });
    expect(container.querySelector("main")).toHaveClass("min-h-0", "flex-1", "overflow-hidden");
    expect(container.querySelector("main")?.parentElement).toHaveClass("h-screen", "overflow-hidden");
    expect(stickyHeader).toHaveClass("sticky", "top-0", "z-20", "shrink-0", "bg-background");
    expect(stickyHeader).toContainElement(backButton);
    expect(stickyHeader).toContainElement(instanceHeading);
    expect(scrollRegion).toHaveAttribute("data-slot", "scroll-shadow");
    expect(scrollRegion).toHaveAttribute("data-orientation", "vertical");
    expect(scrollRegion).toHaveAttribute("data-scroll-shadow-size", "48");
    expect(scrollRegion).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
    expect(backButton.compareDocumentPosition(instanceHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Cloud Deployment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Servers/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /^Credentials/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Instance summary" })).not.toBeInTheDocument();
    expect(screen.queryByText("Compute and network identifiers for this managed server.")).not.toBeInTheDocument();
    await user.click(within(scrollRegion).getByRole("button", { name: "Copy Instance ID" }));
    expect(api.copyInstanceId).toHaveBeenCalledExactlyOnceWith({ deploymentId: DEPLOYMENT_ID });
    expect(await screen.findByText("Instance ID copied")).toBeInTheDocument();
    for (const kind of ["public", "private"] as const) {
      const label = kind === "public" ? "Public IP" : "Private IP";
      await user.click(within(scrollRegion).getByRole("button", { name: `Copy ${label}` }));
      expect(api.copyIpAddress).toHaveBeenLastCalledWith({ deploymentId: DEPLOYMENT_ID, kind });
      expect(await screen.findByText(`${label} copied`)).toBeInTheDocument();
    }
    expect(within(scrollRegion).getByRole("heading", { name: "Firewall rules" })).toBeInTheDocument();
    expect(screen.getByText("sg-abc123")).toBeInTheDocument();
    expect(screen.queryByText(/Managed provenance identifies/u)).not.toBeInTheDocument();

    const inboundTab = screen.getByRole("tab", { name: /Inbound/u });
    const outboundTab = screen.getByRole("tab", { name: /Outbound/u });
    expect(within(inboundTab).getByText("Inbound")).toBeInTheDocument();
    expect(within(outboundTab).getByText("Outbound")).toBeInTheDocument();
    expect(inboundTab).toHaveClass("min-w-28", "whitespace-nowrap");
    expect(outboundTab).toHaveClass("min-w-28", "whitespace-nowrap");

    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    expect(within(inboundGrid).getByText("sgr-11111111111111111")).toBeInTheDocument();
    expect(within(inboundGrid).getByText("203.0.113.8/32")).toBeInTheDocument();
    expect(within(inboundGrid).queryByRole("columnheader", { name: "Description" })).not.toBeInTheDocument();
    expect(within(inboundGrid).queryByText("Operator SSH")).not.toBeInTheDocument();
    expect(within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" })).toBeInTheDocument();
    const actionsHeader = within(inboundGrid).getByRole("columnheader", { name: "Actions" });
    const editButton = within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" });
    expect(actionsHeader).not.toHaveAttribute("data-pinned");
    expect(editButton.closest('[role="gridcell"]')).not.toHaveAttribute("data-pinned");

    await user.click(outboundTab);
    const outboundGrid = await screen.findByRole("grid", { name: "Outbound firewall rules" });
    expect(within(outboundGrid).getByText("sgr-22222222222222222")).toBeInTheDocument();
    expect(within(outboundGrid).getByText("0.0.0.0/0")).toBeInTheDocument();
    expect(within(outboundGrid).getByRole("button", { name: "Delete firewall rule sgr-22222222222222222" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Back to managed servers" }));
    expect(container.querySelector("main")).toHaveClass("overflow-y-auto");
    expect(container.querySelector("main")).not.toHaveClass("overflow-hidden");
    expect(screen.queryByRole("region", { name: "Instance details content" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Managed Servers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit firewall for range-control" })).toBeInTheDocument();
  });

  it("accents the current IPv4 CIDR and gives public IPv4 rules danger precedence", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    currentSnapshot = runningCloudSnapshot();
    currentFirewallSnapshot = {
      ...firewallSnapshot,
      rules: [
        { ...firewallSnapshot.rules[0]!, peer: "203.0.113.0/24" },
        firewallSnapshot.rules[1]!,
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const currentIpRow = within(inboundGrid).getByText("sgr-11111111111111111").closest('[role="row"]');
    if (!(currentIpRow instanceof HTMLElement)) throw new Error("Expected current IP firewall row");
    expect(currentIpRow.querySelector('[data-firewall-rule-accent="success"]')).toBeInTheDocument();
    expect(within(currentIpRow).getByText("Current IP")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow current IP/u })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Outbound/u }));
    const outboundGrid = await screen.findByRole("grid", { name: "Outbound firewall rules" });
    const publicRow = within(outboundGrid).getByText("sgr-22222222222222222").closest('[role="row"]');
    if (!(publicRow instanceof HTMLElement)) throw new Error("Expected public IPv4 firewall row");
    expect(publicRow.querySelector('[data-firewall-rule-accent="danger"]')).toBeInTheDocument();
    expect(publicRow.querySelector('[data-firewall-rule-accent="success"]')).not.toBeInTheDocument();
    expect(within(publicRow).getByText("Any IPv4")).toBeInTheDocument();
    expect(within(outboundGrid).getByText("0.0.0.0/0")).toBeInTheDocument();
  });

  it("offers a one-click managed access update when the current IP has no inbound coverage", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
    });
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const allowCurrentIp = await screen.findByRole("button", {
      name: "Allow current IP 198.51.100.77/32",
    });
    await user.click(allowCurrentIp);

    await waitFor(() => expect(api.updateFirewall).toHaveBeenCalledExactlyOnceWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      sshCidrs: ["203.0.113.8/32", "198.51.100.77/32"],
      operatorCidrs: ["203.0.113.8/32", "198.51.100.77/32"],
    }));
    expect(await screen.findByText("Current IP allowed")).toBeInTheDocument();
    expect(screen.getByText(/198\.51\.100\.77\/32 was added to the managed SSH and operator access ranges/u)).toBeInTheDocument();
    expect(api.createFirewallRule).not.toHaveBeenCalled();
  });

  it("offers the current-IP action when an unrelated public HTTP rule is present", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
    });
    currentSnapshot = runningCloudSnapshot();
    currentFirewallSnapshot = {
      ...firewallSnapshot,
      rules: [
        firewallSnapshot.rules[0]!,
        {
          id: "sgr-33333333333333333",
          managed: false,
          direction: "ingress",
          protocol: "tcp",
          fromPort: 80,
          toPort: 80,
          peerType: "ipv4",
          peer: "0.0.0.0/0",
          description: "Public HTTP",
        },
        {
          id: "sgr-44444444444444444",
          managed: true,
          direction: "ingress",
          protocol: "tcp",
          fromPort: 31_337,
          toPort: 31_337,
          peerType: "ipv4",
          peer: "203.0.113.8/32",
          description: "Operator multiplayer",
        },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const publicHttpRow = within(inboundGrid).getByText("sgr-33333333333333333").closest('[role="row"]');
    if (!(publicHttpRow instanceof HTMLElement)) throw new Error("Expected public HTTP firewall row");
    expect(publicHttpRow.querySelector('[data-firewall-rule-accent="danger"]')).toBeInTheDocument();
    expect(await screen.findByRole("button", {
      name: "Allow current IP 198.51.100.77/32",
    })).toBeInTheDocument();
  });

  it("offers the Azure current-IP action when only a public IPv4 source contains it", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
    });
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 14, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    currentFirewallSnapshot = {
      ...azureFirewallSnapshot,
      rules: [
        azureFirewallSnapshot.rules[0]!,
        {
          ...azureFirewallSnapshot.rules[0]!,
          id: `${runningAzureDeployment.runtime.networkSecurityGroupId}/securityRules/allow-public-http`,
          name: "allow-public-http",
          priority: 1_250,
          sourceAddressPrefixes: ["0.0.0.0/0"],
          destinationPortRanges: ["80"],
        },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for azure-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const publicHttpRow = within(inboundGrid).getByText("allow-public-http").closest('[role="row"]');
    if (!(publicHttpRow instanceof HTMLElement)) throw new Error("Expected Azure public HTTP firewall row");
    expect(publicHttpRow.querySelector('[data-firewall-rule-accent="danger"]')).toBeInTheDocument();
    expect(await screen.findByRole("button", {
      name: "Allow current IP 198.51.100.77/32",
    })).toBeInTheDocument();
  });

  it("keeps the current-IP action usable when the managed firewall update fails", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
    });
    vi.mocked(api.updateFirewall).mockResolvedValueOnce({
      ok: false,
      error: "Provider rejected the managed firewall update.",
    });
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const allowCurrentIp = await screen.findByRole("button", {
      name: "Allow current IP 198.51.100.77/32",
    });
    await user.click(allowCurrentIp);

    expect(await screen.findByText("Current IP rule failed")).toBeInTheDocument();
    expect(screen.getByText("Provider rejected the managed firewall update.")).toBeInTheDocument();
    expect(allowCurrentIp).toBeEnabled();
    expect(api.listFirewallRules).toHaveBeenCalledTimes(2);
  });

  it("adds the current /32 to Azure managed SSH and operator access in one click", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "198.51.100.77", cidr: "198.51.100.77/32" },
    });
    vi.mocked(api.updateFirewall).mockResolvedValueOnce({
      ok: true,
      value: runningAzureDeployment,
    });
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 14, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    currentFirewallSnapshot = azureFirewallSnapshot;
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for azure-control" }));
    await user.click(await screen.findByRole("button", {
      name: "Allow current IP 198.51.100.77/32",
    }));

    await waitFor(() => expect(api.updateFirewall).toHaveBeenCalledExactlyOnceWith({
      deploymentId: AZURE_DEPLOYMENT_ID,
      expectedRevision: 14,
      sshCidrs: ["203.0.113.8/32", "198.51.100.77/32"],
      operatorCidrs: ["203.0.113.8/32", "198.51.100.77/32"],
    }));
    expect(await screen.findByText("Current IP allowed")).toBeInTheDocument();
  });

  it("applies the same CIDR accents to Azure rules with danger winning within a multi-prefix rule", async () => {
    detectCurrentEgressIpv4.mockResolvedValueOnce({
      ok: true,
      value: { address: "203.0.113.42", cidr: "203.0.113.42/32" },
    });
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 14, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    currentFirewallSnapshot = {
      ...azureFirewallSnapshot,
      rules: [
        {
          ...azureFirewallSnapshot.rules[0]!,
          sourceAddressPrefixes: ["203.0.113.42"],
        },
        {
          ...azureFirewallSnapshot.rules[0]!,
          id: `${runningAzureDeployment.runtime.networkSecurityGroupId}/securityRules/allow-public`,
          name: "allow-public",
          priority: 1_250,
          sourceAddressPrefixes: ["0.0.0.0/0", "203.0.113.42/32"],
        },
      ],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for azure-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const currentIpRow = within(inboundGrid).getByText("allow-admin").closest('[role="row"]');
    const publicRow = within(inboundGrid).getByText("allow-public").closest('[role="row"]');
    if (!(currentIpRow instanceof HTMLElement) || !(publicRow instanceof HTMLElement)) {
      throw new Error("Expected Azure firewall rows");
    }
    expect(currentIpRow.querySelector('[data-firewall-rule-accent="success"]')).toBeInTheDocument();
    expect(within(currentIpRow).getByText("Current IP")).toBeInTheDocument();
    expect(publicRow.querySelector('[data-firewall-rule-accent="danger"]')).toBeInTheDocument();
    expect(publicRow.querySelector('[data-firewall-rule-accent="success"]')).not.toBeInTheDocument();
    expect(within(publicRow).getByText("Any IPv4")).toBeInTheDocument();
    expect(within(publicRow).queryByText("Current IP")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Allow current IP/u })).not.toBeInTheDocument();
  });

  it("opens rule editing from accessible row actions without bubbling nested delete actions", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    const ruleRow = within(inboundGrid).getByText("sgr-11111111111111111").closest('[role="row"]');
    if (!(ruleRow instanceof HTMLElement)) throw new Error("Firewall rule row was not rendered");

    await user.click(ruleRow);
    expect(await screen.findByRole("dialog", { name: "Edit firewall rule" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument());

    ruleRow.focus();
    expect(ruleRow).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("dialog", { name: "Edit firewall rule" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument());

    await user.click(within(inboundGrid).getByRole("button", { name: "Delete firewall rule sgr-11111111111111111" }));
    expect(await screen.findByRole("alertdialog", { name: "Delete firewall rule?" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Edit firewall rule" })).not.toBeInTheDocument();
  });

  it("creates an AWS firewall rule from the add-rule sheet and warns about public inbound access", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(screen.getByRole("button", { name: "Add rule" }));

    const sheet = await screen.findByRole("dialog", { name: "Add firewall rule" });
    expect(within(sheet).getByRole("combobox", { name: "Direction" })).toHaveValue("ingress");
    expect(within(sheet).getByRole("combobox", { name: "Source type" })).toHaveValue("ipv4");
    await user.type(within(sheet).getByRole("textbox", { name: "From port" }), "8443");
    await user.type(within(sheet).getByRole("textbox", { name: "To port" }), "8443");
    await user.type(within(sheet).getByRole("textbox", { name: "Source" }), "0.0.0.0/0");
    await user.type(within(sheet).getByRole("textbox", { name: "Description" }), "Public test endpoint");

    expect(within(sheet).getByText("Public inbound access")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(api.createFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      rule: {
        direction: "ingress",
        protocol: "tcp",
        fromPort: 8_443,
        toPort: 8_443,
        peerType: "ipv4",
        peer: "0.0.0.0/0",
        description: "Public test endpoint",
      },
    }));
    expect(await screen.findByText("Firewall rule added")).toBeInTheDocument();
  });

  it("updates an AWS firewall rule while keeping its direction and peer type fixed", async () => {
    currentSnapshot = runningCloudSnapshot();
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(within(inboundGrid).getByRole("button", { name: "Edit firewall rule sgr-11111111111111111" }));

    const sheet = await screen.findByRole("dialog", { name: "Edit firewall rule" });
    expect(within(sheet).getByRole("combobox", { name: "Direction" })).toBeDisabled();
    expect(within(sheet).getByRole("combobox", { name: "Source type" })).toBeDisabled();
    const source = within(sheet).getByRole("textbox", { name: "Source" });
    const description = within(sheet).getByRole("textbox", { name: "Description" });
    await user.clear(source);
    await user.type(source, "198.51.100.18/32");
    await user.clear(description);
    await user.type(description, "Updated operator SSH");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.updateFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      ruleId: "sgr-11111111111111111",
      rule: {
        direction: "ingress",
        protocol: "tcp",
        fromPort: 22,
        toPort: 22,
        peerType: "ipv4",
        peer: "198.51.100.18/32",
        description: "Updated operator SSH",
      },
    }));
    expect(await screen.findByText("Firewall rule updated")).toBeInTheDocument();
  });

  it("deletes any rule in the deployment security group after confirmation", async () => {
    currentSnapshot = runningCloudSnapshot();
    vi.mocked(api.deleteFirewallRule).mockResolvedValueOnce({
      ok: true,
      value: { ...firewallSnapshot, rules: firewallSnapshot.rules.filter(({ direction }) => direction === "ingress") },
    });
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for range-control" }));
    await screen.findByRole("grid", { name: "Inbound firewall rules" });
    await user.click(screen.getByRole("tab", { name: /Outbound/u }));
    const outboundGrid = await screen.findByRole("grid", { name: "Outbound firewall rules" });
    await user.click(within(outboundGrid).getByRole("button", { name: "Delete firewall rule sgr-22222222222222222" }));

    const confirmation = await screen.findByRole("alertdialog", { name: "Delete firewall rule?" });
    expect(within(confirmation).getByText(/All traffic access for 0\.0\.0\.0\/0/u)).toBeInTheDocument();
    await user.click(within(confirmation).getByRole("button", { name: "Delete rule" }));

    await waitFor(() => expect(api.deleteFirewallRule).toHaveBeenCalledWith({
      deploymentId: DEPLOYMENT_ID,
      expectedRevision: 9,
      ruleId: "sgr-22222222222222222",
    }));
    expect(await screen.findByText("No outbound rules")).toBeInTheDocument();
    expect(screen.getByText("Firewall rule deleted")).toBeInTheDocument();
  });

  it("edits Azure NSG rules end to end while keeping baseline and Azure default rules read-only", async () => {
    currentSnapshot = {
      ...emptySnapshot,
      state: { v: 1, revision: 14, deployments: [runningAzureDeployment] },
      credentials: [azureCredential],
    };
    currentFirewallSnapshot = azureFirewallSnapshot;
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    await user.click(await screen.findByRole("button", { name: "Edit firewall for azure-control" }));
    const inboundGrid = await screen.findByRole("grid", { name: "Inbound firewall rules" });
    expect(within(inboundGrid).getByText("allow-admin")).toBeInTheDocument();
    expect(within(inboundGrid).getByRole("button", { name: "Edit firewall rule sliver-gui-ssh-001" })).toBeDisabled();
    expect(within(inboundGrid).getByRole("button", { name: "Delete firewall rule sliver-gui-ssh-001" })).toBeDisabled();
    expect(within(inboundGrid).getByText("DenyAllInBound")).toBeInTheDocument();
    expect(within(inboundGrid).getByRole("button", { name: "Edit firewall rule DenyAllInBound" })).toBeDisabled();
    expect(within(inboundGrid).getByRole("button", { name: "Delete firewall rule DenyAllInBound" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Add rule" }));
    let sheet = await screen.findByRole("dialog", { name: "Add firewall rule" });
    expect(within(sheet).getByRole("combobox", { name: "Direction" })).toHaveValue("ingress");
    expect(within(sheet).getByRole("combobox", { name: "Access" })).toHaveValue("allow");
    expect(within(sheet).getByRole("combobox", { name: "Protocol" })).toHaveValue("tcp");
    const name = within(sheet).getByRole("textbox", { name: "Name" });
    const priority = within(sheet).getByRole("textbox", { name: "Priority" });
    const sourceAddress = within(sheet).getByRole("textbox", { name: "Source Address Prefixes" });
    const destinationPort = within(sheet).getByRole("textbox", { name: "Destination Port Ranges" });
    const description = within(sheet).getByRole("textbox", { name: "Description" });
    await user.clear(name);
    await user.type(name, "allow-public-test");
    await user.clear(priority);
    await user.type(priority, "1200");
    await user.type(sourceAddress, "0.0.0.0/0{enter}203.0.113.0/24");
    await user.clear(destinationPort);
    await user.type(destinationPort, "8443");
    await user.type(description, "Public test endpoint");
    expect(within(sheet).getByText("Public inbound access")).toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Add rule" }));

    await waitFor(() => expect(api.createFirewallRule).toHaveBeenCalledWith({
      deploymentId: AZURE_DEPLOYMENT_ID,
      expectedRevision: 14,
      rule: {
        name: "allow-public-test",
        priority: 1_200,
        direction: "ingress",
        access: "allow",
        protocol: "tcp",
        sourceAddressPrefixes: ["0.0.0.0/0", "203.0.113.0/24"],
        sourcePortRanges: ["*"],
        destinationAddressPrefixes: ["*"],
        destinationPortRanges: ["8443"],
        description: "Public test endpoint",
      },
    }));

    await user.click(within(inboundGrid).getByRole("button", { name: "Edit firewall rule allow-admin" }));
    sheet = await screen.findByRole("dialog", { name: "Edit firewall rule" });
    expect(within(sheet).getByRole("textbox", { name: "Name" })).toBeDisabled();
    const editPriority = within(sheet).getByRole("textbox", { name: "Priority" });
    await user.clear(editPriority);
    await user.type(editPriority, "1300");
    await user.selectOptions(within(sheet).getByRole("combobox", { name: "Access" }), "deny");
    await user.selectOptions(within(sheet).getByRole("combobox", { name: "Protocol" }), "udp");
    await user.click(within(sheet).getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(api.updateFirewallRule).toHaveBeenCalledWith({
      deploymentId: AZURE_DEPLOYMENT_ID,
      expectedRevision: 14,
      ruleId: azureFirewallSnapshot.rules[0]?.id,
      rule: {
        name: "allow-admin",
        priority: 1_300,
        direction: "ingress",
        access: "deny",
        protocol: "udp",
        sourceAddressPrefixes: ["203.0.113.8/32"],
        sourcePortRanges: ["*"],
        destinationAddressPrefixes: ["*"],
        destinationPortRanges: ["22"],
        description: "Operator SSH",
      },
    }));

    await user.click(within(inboundGrid).getByRole("button", { name: "Delete firewall rule allow-admin" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Delete firewall rule?" });
    await user.click(within(confirmation).getByRole("button", { name: "Delete rule" }));
    await waitFor(() => expect(api.deleteFirewallRule).toHaveBeenCalledWith({
      deploymentId: AZURE_DEPLOYMENT_ID,
      expectedRevision: 14,
      ruleId: azureFirewallSnapshot.rules[0]?.id,
    }));
  });

  it("keeps the last good snapshot visible and reports a later refresh failure", async () => {
    currentSnapshot = {
      state: { v: 1, revision: 9, deployments: [runningDeployment] },
      credentials: [awsCredential],
      refreshErrors: [],
      secureCredentialStorage: true,
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      azureAccounts: [azureAccount],
      azureAccountDiscoveryError: null,
      provisioningTranscripts: [],
    };
    const user = userEvent.setup();
    renderCloudDeploymentApp();

    expect(await screen.findByText("range-control")).toBeInTheDocument();
    vi.mocked(api.getSnapshot).mockResolvedValueOnce({ ok: false, error: "provider snapshot unavailable" });
    await user.click(screen.getByRole("button", { name: "Refresh cloud deployments" }));

    expect(await screen.findByText("Refresh failed")).toBeInTheDocument();
    expect(screen.getByText(/provider snapshot unavailable/u)).toBeInTheDocument();
    expect(screen.getByText("range-control")).toBeInTheDocument();

    act(() => changedListener?.("transcripts"));
    await waitFor(() => expect(api.getProvisioningTranscripts).toHaveBeenCalledOnce());
    expect(screen.getByText(/provider snapshot unavailable/u)).toBeInTheDocument();
  });
});

function runningCloudSnapshot(): CloudDeploymentSnapshot {
  return {
    state: { v: 1, revision: 9, deployments: [runningDeployment] },
    credentials: [awsCredential],
    refreshErrors: [],
    secureCredentialStorage: true,
    awsProfiles: [{ name: "default", region: "us-west-2" }],
    awsProfileDiscoveryError: null,
    azureAccounts: [azureAccount],
    azureAccountDiscoveryError: null,
    provisioningTranscripts: [],
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function awsProvisioningDeployment(): AwsCloudDeploymentRecord {
  return {
    ...runningDeployment,
    status: "provisioning",
    phase: "waiting-instance-status",
    operatorConfigFileName: null,
    operatorConfigDigest: null,
    remoteHost: null,
    runtime: {
      ...runningDeployment.runtime,
      instanceState: "running",
      instanceHealth: "initializing",
      systemHealth: "initializing",
      publicIpAddress: null,
    },
  };
}
