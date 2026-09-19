import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateInternetGatewayCommand,
  CreateRouteCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateVpcCommand,
  DeleteInternetGatewayCommand,
  DeleteKeyPairCommand,
  DeleteNetworkInterfaceCommand,
  DeleteRouteCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVolumeCommand,
  DeleteVpcCommand,
  DescribeAddressesCommand,
  DescribeAvailabilityZonesCommand,
  DescribeImagesCommand,
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeInternetGatewaysCommand,
  DescribeKeyPairsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  DetachInternetGatewayCommand,
  DisassociateAddressCommand,
  DisassociateRouteTableCommand,
  EC2Client,
  ImportKeyPairCommand,
  ModifySecurityGroupRulesCommand,
  RebootInstancesCommand,
  ReleaseAddressCommand,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";

import {
  cloudRequiredPermissions,
  createCloudPermissionEvaluation,
  type CloudPermissionEvaluation,
} from "../../shared/cloud-provider-permissions.js";
import type {
  AwsEc2ClientConfiguration,
  AwsEc2ClientLike,
  AwsEc2ProviderConnection,
} from "./aws-ec2-provider.js";

const PLACEHOLDER = {
  allocationId: "eipalloc-00000000000000000",
  associationId: "eipassoc-00000000000000000",
  imageId: "ami-00000000000000000",
  instanceId: "i-00000000000000000",
  internetGatewayId: "igw-00000000000000000",
  keyPairId: "key-00000000000000000",
  networkInterfaceId: "eni-00000000000000000",
  routeTableAssociationId: "rtbassoc-00000000000000000",
  routeTableId: "rtb-00000000000000000",
  securityGroupRuleId: "sgr-00000000000000000",
  securityGroupId: "sg-00000000000000000",
  subnetId: "subnet-00000000000000000",
  volumeId: "vol-00000000000000000",
  vpcId: "vpc-00000000000000000",
} as const;

// A syntactically valid, non-secret ED25519 public key used only in DryRun requests.
const DRY_RUN_PUBLIC_KEY = Buffer.from(
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA sliver-gui-permission-check",
  "utf8",
);
const DRY_RUN_MANAGED_TAGS = [
  { Key: "SliverGUIManaged", Value: "true" },
  { Key: "SliverGUID", Value: "00000000-0000-4000-8000-000000000000" },
  { Key: "Name", Value: "sliver-gui-permission-check" },
] as { Key: string; Value: string }[];
const DRY_RUN_CUSTOM_RULE_TAGS = [
  ...DRY_RUN_MANAGED_TAGS,
  { Key: "SliverGUIRuleType", Value: "custom" },
] as { Key: string; Value: string }[];
const MAX_PROBE_CONCURRENCY = 6;

type PermissionStatus = "verified" | "missing" | "unverifiable";

interface PermissionProbe {
  readonly permission: string;
  readonly command: unknown | null;
  readonly mode: "read" | "dry-run" | "tag-on-create" | "unverifiable";
}

interface TagOnCreateProbe extends PermissionProbe {
  readonly permission: "ec2:CreateTags";
  readonly mode: "tag-on-create";
  readonly prerequisitePermission: string;
}

export interface AwsEc2PermissionCheckerDependencies {
  readonly clientFactory?: (configuration: AwsEc2ClientConfiguration) => AwsEc2ClientLike;
}

/**
 * Performs only read operations and EC2 DryRun authorization probes. It never
 * creates, changes, starts, stops, or deletes an AWS resource.
 * AWS evaluates the effective permissions, including administrator policies,
 * wildcard grants (* and ec2:*), and explicit denies. Do not infer access from
 * policy names or treat an inconclusive resource probe as a missing grant.
 */
export class AwsEc2PermissionChecker {
  private readonly client: AwsEc2ClientLike;

  constructor(
    connection: AwsEc2ProviderConnection,
    dependencies: AwsEc2PermissionCheckerDependencies = {},
  ) {
    this.client = (dependencies.clientFactory ?? defaultClientFactory)(connection);
  }

  async check(): Promise<CloudPermissionEvaluation> {
    // Establish that the endpoint and credential are usable before turning
    // individual authorization failures into a permission report.
    const probes = awsPermissionProbes();
    const preflight = probes.find(({ permission }) => permission === "ec2:DescribeAvailabilityZones");
    if (!preflight) throw new Error("The AWS permission manifest is empty");
    const statuses = new Map<string, PermissionStatus>();
    statuses.set(preflight.permission, await this.runProbe(preflight, true));

    const pending = probes.filter((probe) => probe !== preflight);
    for (let offset = 0; offset < pending.length; offset += MAX_PROBE_CONCURRENCY) {
      const batch = pending.slice(offset, offset + MAX_PROBE_CONCURRENCY);
      const results = await Promise.all(batch.map(async (probe) => [
        probe.permission,
        await this.runProbe(probe, false),
      ] as const));
      for (const [permission, status] of results) statuses.set(permission, status);
    }
    statuses.set("ec2:CreateTags", await this.checkTagOnCreate(statuses));
    return createCloudPermissionEvaluation("aws", statuses);
  }

  private async checkTagOnCreate(
    directStatuses: ReadonlyMap<string, PermissionStatus>,
  ): Promise<PermissionStatus> {
    const probes = awsTagOnCreateProbes();
    let skippedProbe = false;
    const runnable = probes.filter(({ prerequisitePermission }) => {
      if (directStatuses.get(prerequisitePermission) === "verified") return true;
      skippedProbe = true;
      return false;
    });
    const results: PermissionStatus[] = [];
    for (let offset = 0; offset < runnable.length; offset += MAX_PROBE_CONCURRENCY) {
      const batch = runnable.slice(offset, offset + MAX_PROBE_CONCURRENCY);
      results.push(...await Promise.all(batch.map((probe) => this.runProbe(probe, false))));
    }
    if (results.includes("missing")) return "missing";
    if (!skippedProbe && results.length === probes.length && results.every((status) => status === "verified")) {
      return "verified";
    }
    return "unverifiable";
  }

  private async runProbe(probe: PermissionProbe, connectionProbe: boolean): Promise<PermissionStatus> {
    if (probe.command === null || probe.mode === "unverifiable") return "unverifiable";
    try {
      await this.client.send(probe.command);
      return "verified";
    } catch (error) {
      const code = awsErrorCode(error);
      if ((probe.mode === "dry-run" || probe.mode === "tag-on-create") && code === "DryRunOperation") {
        return "verified";
      }
      if (isAuthorizationFailure(code)) {
        // Tag-on-create requests authorize both the create action and
        // ec2:CreateTags. A generic UnauthorizedOperation cannot identify
        // which policy condition failed, so only attribute it to CreateTags
        // when AWS explicitly names that action in the error detail.
        if (probe.mode === "tag-on-create") {
          return explicitlyDeniesPermission(error, probe.permission) ? "missing" : "unverifiable";
        }
        return "missing";
      }
      if (isAuthenticationFailure(code)) throw new Error(`AWS rejected the credential (${code})`);
      if (connectionProbe) throw new Error(`AWS connection preflight failed (${code})`);
      return "unverifiable";
    }
  }
}

function awsPermissionProbes(): readonly PermissionProbe[] {
  const firewallPermission = [{
    IpProtocol: "tcp",
    FromPort: 22,
    ToPort: 22,
    IpRanges: [{ CidrIp: "192.0.2.1/32", Description: "Sliver GUI permission check" }],
  }];
  const probes = [
    read("ec2:DescribeAvailabilityZones", new DescribeAvailabilityZonesCommand({ AllAvailabilityZones: false })),
    read("ec2:DescribeAddresses", new DescribeAddressesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeImages", new DescribeImagesCommand({ Owners: ["amazon"], Filters: [{ Name: "state", Values: ["available"] }], MaxResults: 5 })),
    read("ec2:DescribeInstanceStatus", new DescribeInstanceStatusCommand({ IncludeAllInstances: true, MaxResults: 5 })),
    read("ec2:DescribeInstances", new DescribeInstancesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }], MaxResults: 5 })),
    read("ec2:DescribeInstanceTypeOfferings", new DescribeInstanceTypeOfferingsCommand({
      LocationType: "region",
      Filters: [{ Name: "instance-type", Values: ["t3.micro", "t4g.micro"] }],
    })),
    read("ec2:DescribeInstanceTypes", new DescribeInstanceTypesCommand({ InstanceTypes: ["t3.micro", "t4g.micro"] })),
    read("ec2:DescribeInternetGateways", new DescribeInternetGatewaysCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeKeyPairs", new DescribeKeyPairsCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeNetworkInterfaces", new DescribeNetworkInterfacesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeRouteTables", new DescribeRouteTablesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeSecurityGroupRules", new DescribeSecurityGroupRulesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeSecurityGroups", new DescribeSecurityGroupsCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeSubnets", new DescribeSubnetsCommand({})),
    read("ec2:DescribeVolumes", new DescribeVolumesCommand({ Filters: [{ Name: "tag:SliverGUIManaged", Values: ["true"] }] })),
    read("ec2:DescribeVpcs", new DescribeVpcsCommand({})),
    dryRun("ec2:AllocateAddress", new AllocateAddressCommand({ Domain: "vpc", DryRun: true })),
    dryRun("ec2:AssociateAddress", new AssociateAddressCommand({ AllocationId: PLACEHOLDER.allocationId, InstanceId: PLACEHOLDER.instanceId, DryRun: true })),
    dryRun("ec2:AuthorizeSecurityGroupEgress", new AuthorizeSecurityGroupEgressCommand({ GroupId: PLACEHOLDER.securityGroupId, IpPermissions: firewallPermission, DryRun: true })),
    dryRun("ec2:AuthorizeSecurityGroupIngress", new AuthorizeSecurityGroupIngressCommand({ GroupId: PLACEHOLDER.securityGroupId, IpPermissions: firewallPermission, DryRun: true })),
    dryRun("ec2:CreateSecurityGroup", new CreateSecurityGroupCommand({ GroupName: "sliver-gui-permission-check", Description: "Sliver GUI permission check", VpcId: PLACEHOLDER.vpcId, DryRun: true })),
    // CreateTags is evaluated separately with tagged copies of every create
    // request used by the provider. A standalone CreateTags probe would
    // incorrectly reject valid policies conditioned on ec2:CreateAction.
    unverifiable("ec2:CreateTags"),
    dryRun("ec2:ImportKeyPair", new ImportKeyPairCommand({ KeyName: "sliver-gui-permission-check", PublicKeyMaterial: DRY_RUN_PUBLIC_KEY, DryRun: true })),
    dryRun("ec2:RunInstances", new RunInstancesCommand({ ImageId: PLACEHOLDER.imageId, InstanceType: "t3.micro", MinCount: 1, MaxCount: 1, SubnetId: PLACEHOLDER.subnetId, MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" }, DryRun: true })),
    dryRun("ec2:StartInstances", new StartInstancesCommand({ InstanceIds: [PLACEHOLDER.instanceId], DryRun: true })),
    dryRun("ec2:StopInstances", new StopInstancesCommand({ InstanceIds: [PLACEHOLDER.instanceId], DryRun: true })),
    dryRun("ec2:RebootInstances", new RebootInstancesCommand({ InstanceIds: [PLACEHOLDER.instanceId], DryRun: true })),
    dryRun("ec2:ModifySecurityGroupRules", new ModifySecurityGroupRulesCommand({
      GroupId: PLACEHOLDER.securityGroupId,
      SecurityGroupRules: [{
        SecurityGroupRuleId: PLACEHOLDER.securityGroupRuleId,
        SecurityGroupRule: {
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          CidrIpv4: "192.0.2.1/32",
          Description: "Sliver GUI permission check",
        },
      }],
      DryRun: true,
    })),
    dryRun("ec2:RevokeSecurityGroupEgress", new RevokeSecurityGroupEgressCommand({ GroupId: PLACEHOLDER.securityGroupId, SecurityGroupRuleIds: [PLACEHOLDER.securityGroupRuleId], DryRun: true })),
    dryRun("ec2:RevokeSecurityGroupIngress", new RevokeSecurityGroupIngressCommand({ GroupId: PLACEHOLDER.securityGroupId, IpPermissions: firewallPermission, DryRun: true })),
    dryRun("ec2:TerminateInstances", new TerminateInstancesCommand({ InstanceIds: [PLACEHOLDER.instanceId], DryRun: true })),
    dryRun("ec2:DeleteKeyPair", new DeleteKeyPairCommand({ KeyPairId: PLACEHOLDER.keyPairId, DryRun: true })),
    dryRun("ec2:DeleteNetworkInterface", new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: PLACEHOLDER.networkInterfaceId, DryRun: true })),
    dryRun("ec2:DeleteSecurityGroup", new DeleteSecurityGroupCommand({ GroupId: PLACEHOLDER.securityGroupId, DryRun: true })),
    dryRun("ec2:DeleteVolume", new DeleteVolumeCommand({ VolumeId: PLACEHOLDER.volumeId, DryRun: true })),
    dryRun("ec2:DisassociateAddress", new DisassociateAddressCommand({ AssociationId: PLACEHOLDER.associationId, DryRun: true })),
    dryRun("ec2:ReleaseAddress", new ReleaseAddressCommand({ AllocationId: PLACEHOLDER.allocationId, DryRun: true })),
    dryRun("ec2:CreateVpc", new CreateVpcCommand({ CidrBlock: "10.255.0.0/16", DryRun: true })),
    unverifiable("ec2:ModifyVpcAttribute"),
    dryRun("ec2:CreateSubnet", new CreateSubnetCommand({ VpcId: PLACEHOLDER.vpcId, CidrBlock: "10.255.1.0/24", DryRun: true })),
    unverifiable("ec2:ModifySubnetAttribute"),
    dryRun("ec2:CreateInternetGateway", new CreateInternetGatewayCommand({ DryRun: true })),
    dryRun("ec2:AttachInternetGateway", new AttachInternetGatewayCommand({ InternetGatewayId: PLACEHOLDER.internetGatewayId, VpcId: PLACEHOLDER.vpcId, DryRun: true })),
    dryRun("ec2:CreateRouteTable", new CreateRouteTableCommand({ VpcId: PLACEHOLDER.vpcId, DryRun: true })),
    dryRun("ec2:CreateRoute", new CreateRouteCommand({ RouteTableId: PLACEHOLDER.routeTableId, DestinationCidrBlock: "0.0.0.0/0", GatewayId: PLACEHOLDER.internetGatewayId, DryRun: true })),
    dryRun("ec2:AssociateRouteTable", new AssociateRouteTableCommand({ RouteTableId: PLACEHOLDER.routeTableId, SubnetId: PLACEHOLDER.subnetId, DryRun: true })),
    dryRun("ec2:DisassociateRouteTable", new DisassociateRouteTableCommand({ AssociationId: PLACEHOLDER.routeTableAssociationId, DryRun: true })),
    dryRun("ec2:DeleteRoute", new DeleteRouteCommand({ RouteTableId: PLACEHOLDER.routeTableId, DestinationCidrBlock: "0.0.0.0/0", DryRun: true })),
    dryRun("ec2:DeleteRouteTable", new DeleteRouteTableCommand({ RouteTableId: PLACEHOLDER.routeTableId, DryRun: true })),
    dryRun("ec2:DetachInternetGateway", new DetachInternetGatewayCommand({ InternetGatewayId: PLACEHOLDER.internetGatewayId, VpcId: PLACEHOLDER.vpcId, DryRun: true })),
    dryRun("ec2:DeleteInternetGateway", new DeleteInternetGatewayCommand({ InternetGatewayId: PLACEHOLDER.internetGatewayId, DryRun: true })),
    dryRun("ec2:DeleteSubnet", new DeleteSubnetCommand({ SubnetId: PLACEHOLDER.subnetId, DryRun: true })),
    dryRun("ec2:DeleteVpc", new DeleteVpcCommand({ VpcId: PLACEHOLDER.vpcId, DryRun: true })),
  ];
  const byPermission = new Map(probes.map((probe) => [probe.permission, probe] as const));
  if (byPermission.size !== probes.length) throw new Error("Duplicate AWS permission probe");
  const required = cloudRequiredPermissions("aws");
  const known = new Set(required.map(({ id }) => id));
  for (const permission of byPermission.keys()) {
    if (!known.has(permission)) throw new Error(`Unknown AWS permission probe: ${permission}`);
  }
  return required.map(({ id }) => byPermission.get(id) ?? unverifiable(id));
}

function awsTagOnCreateProbes(): readonly TagOnCreateProbe[] {
  const firewallPermission = [{
    IpProtocol: "tcp",
    FromPort: 22,
    ToPort: 22,
    IpRanges: [{ CidrIp: "192.0.2.1/32", Description: "Sliver GUI permission check" }],
  }];
  return [
    tagOnCreate("ec2:AllocateAddress", new AllocateAddressCommand({
      Domain: "vpc",
      TagSpecifications: [{ ResourceType: "elastic-ip", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:AuthorizeSecurityGroupIngress", new AuthorizeSecurityGroupIngressCommand({
      GroupId: PLACEHOLDER.securityGroupId,
      IpPermissions: firewallPermission,
      TagSpecifications: [{ ResourceType: "security-group-rule", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:AuthorizeSecurityGroupIngress", new AuthorizeSecurityGroupIngressCommand({
      GroupId: PLACEHOLDER.securityGroupId,
      IpPermissions: firewallPermission,
      TagSpecifications: [{ ResourceType: "security-group-rule", Tags: DRY_RUN_CUSTOM_RULE_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:AuthorizeSecurityGroupEgress", new AuthorizeSecurityGroupEgressCommand({
      GroupId: PLACEHOLDER.securityGroupId,
      IpPermissions: firewallPermission,
      TagSpecifications: [{ ResourceType: "security-group-rule", Tags: DRY_RUN_CUSTOM_RULE_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:CreateSecurityGroup", new CreateSecurityGroupCommand({
      GroupName: "sliver-gui-permission-check",
      Description: "Sliver GUI permission check",
      VpcId: PLACEHOLDER.vpcId,
      TagSpecifications: [{ ResourceType: "security-group", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:ImportKeyPair", new ImportKeyPairCommand({
      KeyName: "sliver-gui-permission-check",
      PublicKeyMaterial: DRY_RUN_PUBLIC_KEY,
      TagSpecifications: [{ ResourceType: "key-pair", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:RunInstances", new RunInstancesCommand({
      ImageId: PLACEHOLDER.imageId,
      InstanceType: "t3.micro",
      MinCount: 1,
      MaxCount: 1,
      SubnetId: PLACEHOLDER.subnetId,
      MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" },
      TagSpecifications: [
        { ResourceType: "instance", Tags: DRY_RUN_MANAGED_TAGS },
        { ResourceType: "volume", Tags: DRY_RUN_MANAGED_TAGS },
        { ResourceType: "network-interface", Tags: DRY_RUN_MANAGED_TAGS },
      ],
      DryRun: true,
    })),
    tagOnCreate("ec2:CreateVpc", new CreateVpcCommand({
      CidrBlock: "10.255.0.0/16",
      TagSpecifications: [{ ResourceType: "vpc", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:CreateSubnet", new CreateSubnetCommand({
      VpcId: PLACEHOLDER.vpcId,
      CidrBlock: "10.255.1.0/24",
      TagSpecifications: [{ ResourceType: "subnet", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:CreateInternetGateway", new CreateInternetGatewayCommand({
      TagSpecifications: [{ ResourceType: "internet-gateway", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
    tagOnCreate("ec2:CreateRouteTable", new CreateRouteTableCommand({
      VpcId: PLACEHOLDER.vpcId,
      TagSpecifications: [{ ResourceType: "route-table", Tags: DRY_RUN_MANAGED_TAGS }],
      DryRun: true,
    })),
  ];
}

function read(permission: string, command: unknown): PermissionProbe {
  return { permission, command, mode: "read" };
}

function dryRun(permission: string, command: unknown): PermissionProbe {
  return { permission, command, mode: "dry-run" };
}

function unverifiable(permission: string): PermissionProbe {
  return { permission, command: null, mode: "unverifiable" };
}

function tagOnCreate(prerequisitePermission: string, command: unknown): TagOnCreateProbe {
  return {
    permission: "ec2:CreateTags",
    prerequisitePermission,
    command,
    mode: "tag-on-create",
  };
}

function defaultClientFactory(configuration: AwsEc2ClientConfiguration): AwsEc2ClientLike {
  return new EC2Client(configuration);
}

function awsErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) return "UnknownError";
  const candidate = error as { readonly name?: unknown; readonly Code?: unknown; readonly code?: unknown };
  for (const value of [candidate.name, candidate.Code, candidate.code]) {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(value)) return value;
  }
  return "UnknownError";
}

function isAuthorizationFailure(code: string): boolean {
  return code === "UnauthorizedOperation" ||
    code === "AccessDenied" ||
    code === "AccessDeniedException" ||
    code === "UnauthorizedException";
}

function isAuthenticationFailure(code: string): boolean {
  return code === "AuthFailure" ||
    code === "ExpiredToken" ||
    code === "ExpiredTokenException" ||
    code === "IncompleteSignature" ||
    code === "InvalidClientTokenId" ||
    code === "InvalidSignatureException" ||
    code === "RequestExpired" ||
    code === "SignatureDoesNotMatch" ||
    code === "UnrecognizedClientException";
}

function explicitlyDeniesPermission(error: unknown, permission: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly action?: unknown;
    readonly Action?: unknown;
    readonly message?: unknown;
    readonly Message?: unknown;
  };
  if ([candidate.action, candidate.Action].some((value) => value === permission)) return true;
  const escaped = permission.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const denial = new RegExp(
    `(?:not\\s+authorized\\s+to\\s+perform|access\\s+denied|explicit(?:ly)?\\s+denied)[^\\n]{0,512}${escaped}`,
    "iu",
  );
  return [candidate.message, candidate.Message].some((value) => typeof value === "string" && denial.test(value));
}
