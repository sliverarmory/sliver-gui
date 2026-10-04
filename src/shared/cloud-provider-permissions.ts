import type { CloudProvider } from "./cloud-deployment-contracts.js";

export const CLOUD_PERMISSION_CAPABILITIES = [
  "inventory",
  "deploy",
  "network",
  "firewall",
  "lifecycle",
  "destroy",
] as const;

export type CloudPermissionCapability = (typeof CLOUD_PERMISSION_CAPABILITIES)[number];

export interface CloudRequiredPermission {
  /** Provider-native IAM action or privilege name. */
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly CloudPermissionCapability[];
}

export interface CloudPermissionEvaluation {
  readonly required: readonly CloudRequiredPermission[];
  /** Permissions directly demonstrated by a successful read or non-mutating authorization probe. */
  readonly verified: readonly string[];
  /** Permissions directly rejected by the provider's authorization layer. */
  readonly missing: readonly string[];
  /** Permissions that cannot be safely or conclusively tested without selected provider resources. */
  readonly unverifiable: readonly string[];
}

const AWS_REQUIRED_PERMISSIONS = definePermissions([
  permission("ec2:DescribeAddresses", "Read Elastic IPs", ["inventory", "destroy"]),
  permission("ec2:DescribeAvailabilityZones", "Read availability zones", ["inventory"]),
  permission("ec2:DescribeImages", "Read machine images", ["inventory", "deploy"]),
  permission("ec2:DescribeInstanceStatus", "Read instance health", ["inventory", "lifecycle"]),
  permission("ec2:DescribeInstances", "Read instances", ["inventory", "lifecycle", "destroy"]),
  permission("ec2:DescribeInstanceTypeOfferings", "Read regional instance type availability", ["inventory", "deploy"]),
  permission("ec2:DescribeInstanceTypes", "Read instance types", ["inventory", "deploy"]),
  permission("ec2:DescribeInternetGateways", "Read internet gateways", ["inventory", "network", "destroy"]),
  permission("ec2:DescribeKeyPairs", "Read SSH key pairs", ["inventory", "deploy"]),
  permission("ec2:DescribeNetworkInterfaces", "Read network interfaces", ["inventory", "destroy"]),
  permission("ec2:DescribeRouteTables", "Read route tables", ["inventory", "network", "destroy"]),
  permission("ec2:DescribeSecurityGroupRules", "Read firewall rules", ["inventory", "firewall"]),
  permission("ec2:DescribeSecurityGroups", "Read security groups", ["inventory", "firewall", "destroy"]),
  permission("ec2:DescribeSubnets", "Read subnets", ["inventory", "network", "deploy"]),
  permission("ec2:DescribeVolumes", "Read volumes", ["inventory", "destroy"]),
  permission("ec2:DescribeVpcs", "Read VPCs", ["inventory", "network", "deploy"]),
  permission("ec2:AllocateAddress", "Allocate an Elastic IP", ["network", "deploy"]),
  permission("ec2:AssociateAddress", "Attach an Elastic IP", ["network", "deploy"]),
  permission("ec2:AuthorizeSecurityGroupIngress", "Create inbound firewall rules", ["firewall", "deploy"]),
  permission("ec2:AuthorizeSecurityGroupEgress", "Create outbound firewall rules", ["firewall"]),
  permission("ec2:CreateSecurityGroup", "Create a security group", ["firewall", "deploy"]),
  permission("ec2:CreateTags", "Tag managed resources", ["deploy", "network", "firewall"]),
  permission("ec2:ImportKeyPair", "Import the credential SSH key", ["deploy"]),
  permission("ec2:RunInstances", "Launch an EC2 instance", ["deploy"]),
  permission("ec2:StartInstances", "Start managed instances", ["lifecycle"]),
  permission("ec2:StopInstances", "Stop managed instances", ["lifecycle", "destroy"]),
  permission("ec2:RebootInstances", "Reboot managed instances", ["lifecycle"]),
  permission("ec2:ModifySecurityGroupRules", "Edit firewall rules", ["firewall"]),
  permission("ec2:RevokeSecurityGroupIngress", "Remove inbound firewall rules", ["firewall", "destroy"]),
  permission("ec2:RevokeSecurityGroupEgress", "Remove outbound firewall rules", ["firewall"]),
  permission("ec2:TerminateInstances", "Terminate managed instances", ["destroy"]),
  permission("ec2:DeleteKeyPair", "Delete managed SSH key pairs", ["destroy"]),
  permission("ec2:DeleteNetworkInterface", "Delete managed network interfaces", ["destroy"]),
  permission("ec2:DeleteSecurityGroup", "Delete managed security groups", ["destroy"]),
  permission("ec2:DeleteVolume", "Delete managed volumes", ["destroy"]),
  permission("ec2:DisassociateAddress", "Detach managed Elastic IPs", ["destroy"]),
  permission("ec2:ReleaseAddress", "Release managed Elastic IPs", ["destroy"]),
  permission("ec2:CreateVpc", "Create a managed VPC", ["network", "deploy"]),
  permission("ec2:ModifyVpcAttribute", "Configure managed VPC DNS", ["network", "deploy"]),
  permission("ec2:CreateSubnet", "Create a managed subnet", ["network", "deploy"]),
  permission("ec2:ModifySubnetAttribute", "Configure managed subnet addressing", ["network", "deploy"]),
  permission("ec2:CreateInternetGateway", "Create a managed internet gateway", ["network", "deploy"]),
  permission("ec2:AttachInternetGateway", "Attach a managed internet gateway", ["network", "deploy"]),
  permission("ec2:CreateRouteTable", "Create a managed route table", ["network", "deploy"]),
  permission("ec2:CreateRoute", "Create a managed internet route", ["network", "deploy"]),
  permission("ec2:AssociateRouteTable", "Associate a managed route table", ["network", "deploy"]),
  permission("ec2:DisassociateRouteTable", "Disassociate managed route tables", ["destroy"]),
  permission("ec2:DeleteRoute", "Delete managed routes", ["destroy"]),
  permission("ec2:DeleteRouteTable", "Delete managed route tables", ["destroy"]),
  permission("ec2:DetachInternetGateway", "Detach managed internet gateways", ["destroy"]),
  permission("ec2:DeleteInternetGateway", "Delete managed internet gateways", ["destroy"]),
  permission("ec2:DeleteSubnet", "Delete managed subnets", ["destroy"]),
  permission("ec2:DeleteVpc", "Delete managed VPCs", ["destroy"]),
]);

const AZURE_REQUIRED_PERMISSIONS = definePermissions([
  permission("Microsoft.Resources/subscriptions/resourceGroups/read", "Read resource groups", ["inventory", "destroy"]),
  permission("Microsoft.Resources/subscriptions/resourcegroups/resources/read", "List resources in managed resource groups", ["inventory", "destroy"]),
  permission("Microsoft.Resources/subscriptions/resourceGroups/write", "Create and tag resource groups", ["deploy"]),
  permission("Microsoft.Resources/subscriptions/resourceGroups/delete", "Delete empty managed resource groups", ["destroy"]),
  permission("Microsoft.Compute/skus/read", "Read available virtual-machine sizes", ["inventory", "deploy"]),
  permission("Microsoft.Compute/images/read", "Read managed VM images", ["inventory", "deploy"]),
  permission("Microsoft.Compute/virtualMachines/read", "Read virtual machines", ["inventory", "lifecycle", "destroy"]),
  permission("Microsoft.Compute/virtualMachines/instanceView/read", "Read virtual-machine instance state", ["inventory", "deploy", "lifecycle", "destroy"]),
  permission("Microsoft.Compute/virtualMachines/write", "Create and update virtual machines", ["deploy"]),
  permission("Microsoft.Compute/virtualMachines/delete", "Delete managed virtual machines", ["destroy"]),
  permission("Microsoft.Compute/virtualMachines/start/action", "Start managed virtual machines", ["lifecycle"]),
  permission("Microsoft.Compute/virtualMachines/deallocate/action", "Deallocate managed virtual machines", ["lifecycle", "destroy"]),
  permission("Microsoft.Compute/virtualMachines/restart/action", "Restart managed virtual machines", ["lifecycle"]),
  permission("Microsoft.Compute/disks/read", "Read managed disks", ["inventory", "destroy"]),
  permission("Microsoft.Compute/disks/write", "Create managed disks", ["deploy"]),
  permission("Microsoft.Compute/disks/delete", "Delete managed disks", ["destroy"]),
  permission("Microsoft.Network/virtualNetworks/read", "Read virtual networks", ["inventory", "network"]),
  permission("Microsoft.Network/virtualNetworks/write", "Create managed virtual networks", ["network", "deploy"]),
  permission("Microsoft.Network/virtualNetworks/delete", "Delete managed virtual networks", ["destroy"]),
  permission("Microsoft.Network/virtualNetworks/subnets/read", "Read subnets", ["inventory", "network"]),
  permission("Microsoft.Network/virtualNetworks/subnets/write", "Create managed subnets", ["network", "deploy"]),
  permission("Microsoft.Network/virtualNetworks/subnets/delete", "Delete managed subnets", ["destroy"]),
  permission("Microsoft.Network/virtualNetworks/subnets/join/action", "Attach interfaces to subnets", ["network", "deploy"]),
  permission("Microsoft.Network/networkSecurityGroups/read", "Read network security groups", ["inventory", "firewall"]),
  permission("Microsoft.Network/networkSecurityGroups/write", "Create managed network security groups", ["firewall", "deploy"]),
  permission("Microsoft.Network/networkSecurityGroups/delete", "Delete managed network security groups", ["destroy"]),
  permission("Microsoft.Network/networkSecurityGroups/securityRules/read", "Read firewall rules", ["inventory", "firewall"]),
  permission("Microsoft.Network/networkSecurityGroups/securityRules/write", "Create and edit firewall rules", ["firewall", "deploy"]),
  permission("Microsoft.Network/networkSecurityGroups/securityRules/delete", "Delete firewall rules", ["firewall", "destroy"]),
  permission("Microsoft.Network/networkSecurityGroups/join/action", "Attach network security groups", ["network", "deploy"]),
  permission("Microsoft.Network/publicIPAddresses/read", "Read public IP addresses", ["inventory", "network"]),
  permission("Microsoft.Network/publicIPAddresses/write", "Create managed public IP addresses", ["network", "deploy"]),
  permission("Microsoft.Network/publicIPAddresses/delete", "Delete managed public IP addresses", ["destroy"]),
  permission("Microsoft.Network/publicIPAddresses/join/action", "Attach public IP addresses", ["network", "deploy"]),
  permission("Microsoft.Network/networkInterfaces/read", "Read network interfaces", ["inventory", "network"]),
  permission("Microsoft.Network/networkInterfaces/write", "Create managed network interfaces", ["network", "deploy"]),
  permission("Microsoft.Network/networkInterfaces/delete", "Delete managed network interfaces", ["destroy"]),
  permission("Microsoft.Network/networkInterfaces/join/action", "Attach network interfaces", ["network", "deploy"]),
]);

export const CLOUD_PROVIDER_REQUIRED_PERMISSIONS: Readonly<Record<CloudProvider, readonly CloudRequiredPermission[]>> =
  Object.freeze({
    aws: AWS_REQUIRED_PERMISSIONS,
    azure: AZURE_REQUIRED_PERMISSIONS,
  });

export function cloudRequiredPermissions(provider: CloudProvider): readonly CloudRequiredPermission[] {
  return CLOUD_PROVIDER_REQUIRED_PERMISSIONS[provider];
}

export function createCloudPermissionEvaluation(
  provider: CloudProvider,
  statuses: ReadonlyMap<string, "verified" | "missing" | "unverifiable">,
): CloudPermissionEvaluation {
  const required = cloudRequiredPermissions(provider);
  const known = new Set(required.map(({ id }) => id));
  for (const id of statuses.keys()) {
    if (!known.has(id)) throw new TypeError(`Unknown ${provider} permission: ${id}`);
  }
  const byStatus = (status: "verified" | "missing" | "unverifiable"): readonly string[] => Object.freeze(
    required.filter(({ id }) => (statuses.get(id) ?? "unverifiable") === status).map(({ id }) => id),
  );
  return Object.freeze({
    required,
    verified: byStatus("verified"),
    missing: byStatus("missing"),
    unverifiable: byStatus("unverifiable"),
  });
}

function permission(
  id: string,
  label: string,
  capabilities: readonly CloudPermissionCapability[],
): CloudRequiredPermission {
  return Object.freeze({ id, label, capabilities: Object.freeze([...capabilities]) });
}

function definePermissions(permissions: readonly CloudRequiredPermission[]): readonly CloudRequiredPermission[] {
  const ids = new Set<string>();
  for (const { id } of permissions) {
    if (ids.has(id)) throw new Error(`Duplicate cloud permission: ${id}`);
    ids.add(id);
  }
  return Object.freeze([...permissions]);
}
