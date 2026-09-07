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
  permission("ec2:AuthorizeSecurityGroupIngress", "Create firewall rules", ["firewall", "deploy"]),
  permission("ec2:CreateSecurityGroup", "Create a security group", ["firewall", "deploy"]),
  permission("ec2:CreateTags", "Tag managed resources", ["deploy", "network"]),
  permission("ec2:ImportKeyPair", "Import the credential SSH key", ["deploy"]),
  permission("ec2:RunInstances", "Launch an EC2 instance", ["deploy"]),
  permission("ec2:StartInstances", "Start managed instances", ["lifecycle"]),
  permission("ec2:StopInstances", "Stop managed instances", ["lifecycle", "destroy"]),
  permission("ec2:RebootInstances", "Reboot managed instances", ["lifecycle"]),
  permission("ec2:RevokeSecurityGroupIngress", "Remove firewall rules", ["firewall", "destroy"]),
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

const PROXMOX_REQUIRED_PERMISSIONS = definePermissions([
  permission("Sys.Audit", "Read node and cluster state", ["inventory"]),
  permission("VM.Audit", "Read virtual-machine state", ["inventory", "lifecycle", "destroy"]),
  permission("VM.Allocate", "Allocate and delete virtual machines", ["deploy", "destroy"]),
  permission("VM.Clone", "Clone the selected template", ["deploy"]),
  permission("VM.Config.CPU", "Configure virtual-machine CPU", ["deploy"]),
  permission("VM.Config.Memory", "Configure virtual-machine memory", ["deploy"]),
  permission("VM.Config.Disk", "Configure and resize virtual-machine disks", ["deploy"]),
  permission("VM.Config.Network", "Configure virtual-machine networking and firewall", ["network", "firewall", "deploy"]),
  permission("VM.Config.Cloudinit", "Configure cloud-init credentials and addressing", ["network", "deploy"]),
  permission("VM.Config.Options", "Configure virtual-machine options and management tags", ["deploy"]),
  permission("VM.PowerMgmt", "Start, stop, and reboot virtual machines", ["lifecycle", "deploy", "destroy"]),
  permission("VM.GuestAgent.Audit", "Read guest-agent network state", ["inventory", "deploy"]),
  permission("Datastore.Audit", "Read target storage", ["inventory", "deploy"]),
  permission("Datastore.AllocateSpace", "Allocate and resize managed disks", ["deploy"]),
  permission("SDN.Audit", "Read virtual networks", ["inventory", "network"]),
  permission("SDN.Use", "Attach the managed VM to a virtual network", ["network", "deploy"]),
]);

export const CLOUD_PROVIDER_REQUIRED_PERMISSIONS: Readonly<Record<CloudProvider, readonly CloudRequiredPermission[]>> =
  Object.freeze({
    aws: AWS_REQUIRED_PERMISSIONS,
    proxmox: PROXMOX_REQUIRED_PERMISSIONS,
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
