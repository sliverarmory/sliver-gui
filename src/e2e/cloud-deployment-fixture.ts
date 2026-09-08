import type {
  AwsCloudDeploymentRecord,
  AwsFirewallSnapshot,
  AzureCloudDeploymentRecord,
  AzureFirewallSnapshot,
} from "../shared/cloud-deployment-contracts.js";

export const E2E_AWS_CREDENTIAL_ID = "0f24a4da-28c1-4d94-a66d-eb224892745d";
export const E2E_AWS_DEPLOYMENT_ID = "77777777-7777-4777-8777-777777777777";
export const E2E_AWS_DEPLOYMENT_NAME = "e2e-firewall-instance";
export const E2E_AZURE_CREDENTIAL_ID = "1c5f60df-27c8-44ca-ad9d-c44f4cb5a31c";
export const E2E_AZURE_DEPLOYMENT_ID = "88888888-8888-4888-8888-888888888888";
export const E2E_AZURE_DEPLOYMENT_NAME = "e2e-azure-control";
export const E2E_AZURE_SUBSCRIPTION_ID = "11111111-2222-3333-4444-555555555555";
export const E2E_AZURE_TENANT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

export const E2E_AWS_DEPLOYMENT: AwsCloudDeploymentRecord = {
  id: E2E_AWS_DEPLOYMENT_ID,
  provider: "aws",
  name: E2E_AWS_DEPLOYMENT_NAME,
  credentialId: E2E_AWS_CREDENTIAL_ID,
  status: "running",
  phase: "ready",
  createdAt: "2026-09-06T18:00:00.000Z",
  updatedAt: "2026-09-06T18:05:00.000Z",
  operatorConfigFileName: "e2e-firewall-instance.cfg",
  operatorConfigDigest: "a".repeat(64),
  remoteHost: "198.51.100.24",
  lastError: null,
  managedAssets: [
    {
      resourceType: "ec2-instance",
      resourceId: "i-0123456789abcdef0",
      displayName: E2E_AWS_DEPLOYMENT_NAME,
      tagged: true,
    },
    {
      resourceType: "ec2-security-group",
      resourceId: "sg-0123456789abcdef0",
      displayName: "sliver-gui-e2e-firewall",
      tagged: true,
    },
  ],
  spec: {
    region: "us-west-2",
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
    keyPairName: "e2e-operator-key",
    operatorName: "operator",
    sshPort: 22,
    multiplayerPort: 31_337,
    volumeSizeGiB: 20,
    useElasticIp: true,
    sshCidrs: ["198.51.100.77/32"],
    operatorCidrs: ["198.51.100.77/32"],
  },
  runtime: {
    instanceId: "i-0123456789abcdef0",
    instanceState: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    securityGroupIds: ["sg-0123456789abcdef0"],
    networkInterfaceIds: ["eni-0123456789abcdef0"],
    volumeIds: ["vol-0123456789abcdef0"],
    publicIpAddress: "198.51.100.24",
    privateIpAddress: "10.0.0.24",
    availabilityZone: "us-west-2a",
    elasticIpAllocationId: "eipalloc-0123456789abcdef0",
    vpcId: "vpc-0123456789abcdef0",
    subnetId: "subnet-0123456789abcdef0",
    internetGatewayId: null,
    routeTableId: null,
    routeTableAssociationId: null,
  },
};

export const E2E_AWS_FIREWALL: AwsFirewallSnapshot = {
  provider: "aws",
  securityGroupId: "sg-0123456789abcdef0",
  securityGroupName: "sliver-gui-e2e-firewall",
  vpcId: "vpc-0123456789abcdef0",
  rules: [{
    id: "sgr-0123456789abcdef0",
    managed: true,
    direction: "ingress",
    protocol: "tcp",
    fromPort: 22,
    toPort: 22,
    peerType: "ipv4",
    peer: "198.51.100.77/32",
    description: "E2E operator SSH",
  }],
};

const E2E_AZURE_RESOURCE_GROUP = "sliver-gui-e2e-azure-control";
const E2E_AZURE_RESOURCE_GROUP_ID =
  `/subscriptions/${E2E_AZURE_SUBSCRIPTION_ID}/resourceGroups/${E2E_AZURE_RESOURCE_GROUP}`;
const E2E_AZURE_VM_ID =
  `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Compute/virtualMachines/${E2E_AZURE_DEPLOYMENT_NAME}`;
const E2E_AZURE_NSG_ID =
  `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/networkSecurityGroups/${E2E_AZURE_DEPLOYMENT_NAME}-nsg`;
const E2E_AZURE_VNET_ID =
  `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/virtualNetworks/${E2E_AZURE_DEPLOYMENT_NAME}-vnet`;

export const E2E_AZURE_DEPLOYMENT: AzureCloudDeploymentRecord = {
  id: E2E_AZURE_DEPLOYMENT_ID,
  provider: "azure",
  name: E2E_AZURE_DEPLOYMENT_NAME,
  credentialId: E2E_AZURE_CREDENTIAL_ID,
  status: "running",
  phase: "ready",
  createdAt: "2026-09-06T18:10:00.000Z",
  updatedAt: "2026-09-06T18:15:00.000Z",
  operatorConfigFileName: "e2e-azure-control.cfg",
  operatorConfigDigest: "b".repeat(64),
  remoteHost: "203.0.113.42",
  lastError: null,
  managedAssets: [
    {
      resourceType: "azure-resource-group",
      resourceId: E2E_AZURE_RESOURCE_GROUP_ID,
      displayName: E2E_AZURE_RESOURCE_GROUP,
      tagged: true,
    },
    {
      resourceType: "azure-virtual-machine",
      resourceId: E2E_AZURE_VM_ID,
      displayName: E2E_AZURE_DEPLOYMENT_NAME,
      tagged: true,
    },
    {
      resourceType: "azure-network-security-group",
      resourceId: E2E_AZURE_NSG_ID,
      displayName: `${E2E_AZURE_DEPLOYMENT_NAME}-nsg`,
      tagged: true,
    },
  ],
  spec: {
    location: "eastus",
    imageReference: "Canonical:ubuntu-24_04-lts:server:latest",
    vmSize: "Standard_B2s",
    networkMode: "managed",
    vnetId: null,
    subnetId: null,
    managedVnetCidr: "10.42.0.0/16",
    managedSubnetCidr: "10.42.1.0/24",
    sshUsername: "azureuser",
    operatorName: "operator",
    sshPort: 22,
    multiplayerPort: 31_337,
    osDiskSizeGiB: 30,
    usePublicIp: true,
    sshCidrs: ["198.51.100.77/32"],
    operatorCidrs: ["198.51.100.77/32"],
  },
  runtime: {
    resourceGroupName: E2E_AZURE_RESOURCE_GROUP,
    vmName: E2E_AZURE_DEPLOYMENT_NAME,
    vmId: E2E_AZURE_VM_ID,
    instanceState: "running",
    provisioningState: "Succeeded",
    networkSecurityGroupId: E2E_AZURE_NSG_ID,
    networkInterfaceId:
      `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/networkInterfaces/${E2E_AZURE_DEPLOYMENT_NAME}-nic`,
    osDiskId:
      `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Compute/disks/${E2E_AZURE_DEPLOYMENT_NAME}-os`,
    publicIpAddressId:
      `${E2E_AZURE_RESOURCE_GROUP_ID}/providers/Microsoft.Network/publicIPAddresses/${E2E_AZURE_DEPLOYMENT_NAME}-ip`,
    publicIpAddress: "203.0.113.42",
    privateIpAddress: "10.42.1.4",
    vnetId: E2E_AZURE_VNET_ID,
    subnetId: `${E2E_AZURE_VNET_ID}/subnets/default`,
  },
};

export const E2E_AZURE_FIREWALL: AzureFirewallSnapshot = {
  provider: "azure",
  networkSecurityGroupId: E2E_AZURE_NSG_ID,
  networkSecurityGroupName: `${E2E_AZURE_DEPLOYMENT_NAME}-nsg`,
  resourceGroupName: E2E_AZURE_RESOURCE_GROUP,
  rules: [{
    id: `${E2E_AZURE_NSG_ID}/securityRules/allow-operator-ssh`,
    name: "allow-operator-ssh",
    priority: 1_200,
    direction: "ingress",
    access: "allow",
    protocol: "tcp",
    sourceAddressPrefixes: ["198.51.100.77/32"],
    sourcePortRanges: ["*"],
    destinationAddressPrefixes: ["*"],
    destinationPortRanges: ["22"],
    description: "E2E operator SSH",
    managed: true,
    isDefault: false,
    sourceApplicationSecurityGroupIds: [],
    destinationApplicationSecurityGroupIds: [],
    editUnsupportedReason: null,
  }],
};
