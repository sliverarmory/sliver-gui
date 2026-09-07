import type {
  AwsCloudDeploymentRecord,
  AwsFirewallSnapshot,
} from "../shared/cloud-deployment-contracts.js";

export const E2E_AWS_CREDENTIAL_ID = "0f24a4da-28c1-4d94-a66d-eb224892745d";
export const E2E_AWS_DEPLOYMENT_ID = "77777777-7777-4777-8777-777777777777";
export const E2E_AWS_DEPLOYMENT_NAME = "e2e-firewall-instance";

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
