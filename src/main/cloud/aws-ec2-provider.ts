import { isIP } from "node:net";

import {
  AllocateAddressCommand,
  AssociateAddressCommand,
  AssociateRouteTableCommand,
  AttachInternetGatewayCommand,
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
  DescribeInternetGatewaysCommand,
  DescribeInstanceTypeOfferingsCommand,
  DescribeInstanceTypesCommand,
  DescribeInstanceStatusCommand,
  DescribeInstancesCommand,
  DescribeKeyPairsCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVolumesCommand,
  DescribeVpcsCommand,
  DisassociateAddressCommand,
  DisassociateRouteTableCommand,
  DetachInternetGatewayCommand,
  EC2Client,
  ImportKeyPairCommand,
  ModifySubnetAttributeCommand,
  ModifyVpcAttributeCommand,
  RebootInstancesCommand,
  ReleaseAddressCommand,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
  TerminateInstancesCommand,
  waitUntilInstanceRunning,
  waitUntilInstanceStatusOk,
  waitUntilInstanceStopped,
  waitUntilInstanceTerminated,
  waitUntilSubnetAvailable,
  waitUntilSystemStatusOk,
  waitUntilVpcAvailable,
  type AllocateAddressCommandOutput,
  type AssociateAddressCommandOutput,
  type AssociateRouteTableCommandOutput,
  type CreateInternetGatewayCommandOutput,
  type CreateRouteTableCommandOutput,
  type CreateSubnetCommandOutput,
  type CreateVpcCommandOutput,
  type DescribeAddressesCommandOutput,
  type DescribeAvailabilityZonesCommandOutput,
  type DescribeImagesCommandOutput,
  type DescribeInternetGatewaysCommandOutput,
  type DescribeInstanceTypeOfferingsCommandOutput,
  type DescribeInstanceTypesCommandOutput,
  type DescribeInstanceStatusCommandOutput,
  type DescribeInstancesCommandOutput,
  type DescribeKeyPairsCommandOutput,
  type DescribeNetworkInterfacesCommandOutput,
  type DescribeRouteTablesCommandOutput,
  type DescribeSecurityGroupRulesCommandOutput,
  type DescribeSecurityGroupsCommandOutput,
  type DescribeSubnetsCommandOutput,
  type DescribeVolumesCommandOutput,
  type DescribeVpcsCommandOutput,
  type ImportKeyPairCommandOutput,
  type Image,
  type InstanceTypeInfo,
  type IpPermission,
  type RunInstancesCommandInput,
  type RunInstancesCommandOutput,
  type SecurityGroup,
  type Tag,
  type TagSpecification,
} from "@aws-sdk/client-ec2";

import {
  AWS_SUPPORTED_INSTANCE_TYPES,
  isAwsRegion,
  isSupportedAwsInstanceType,
} from "../../shared/cloud-deployment-contracts.js";
import { openSshPublicKeysEqual } from "./aws-inventory.js";

const MANAGED_TAG_KEY = "SliverGUIManaged";
const GUID_TAG_KEY = "SliverGUID";
const NAME_TAG_KEY = "Name";
const MANAGED_TAG_VALUE = "true";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AWS_ID_PATTERNS = {
  allocation: /^eipalloc-[0-9a-f]+$/u,
  association: /^eipassoc-[0-9a-f]+$/u,
  image: /^ami-[0-9a-f]+$/u,
  instance: /^i-[0-9a-f]+$/u,
  networkInterface: /^eni-[0-9a-f]+$/u,
  securityGroup: /^sg-[0-9a-f]+$/u,
  subnet: /^subnet-[0-9a-f]+$/u,
  volume: /^vol-[0-9a-f]+$/u,
  keyPair: /^key-[0-9a-f]+$/u,
  vpc: /^vpc-[0-9a-f]+$/u,
  internetGateway: /^igw-[0-9a-f]+$/u,
  routeTable: /^rtb-[0-9a-f]+$/u,
  routeTableAssociation: /^rtbassoc-[0-9a-f]+$/u,
} as const;
const MAX_USER_DATA_BYTES = 16 * 1024;
const MAX_PUBLIC_KEY_BYTES = 16 * 1024;
const MAX_CIDRS_PER_SERVICE = 60;
const DEFAULT_WAITER_SECONDS = 10 * 60;
const MAX_DISCOVERY_PAGES = 100;
const MAX_PAGINATION_TOKEN_LENGTH = 4_096;

export const AWS_EC2_DEFAULT_INSTANCE_TYPES = AWS_SUPPORTED_INSTANCE_TYPES;

export type AwsEc2Architecture = "x86_64" | "arm64";
export type AwsEc2ImageDistribution = "ubuntu" | "amazon-linux";

export interface AwsEc2InstanceTypeOption {
  readonly name: string;
  readonly architecture: AwsEc2Architecture;
  readonly vCpuCount: number;
  readonly memoryMiB: number;
  readonly processor: string;
  readonly description: string;
}

export interface AwsEc2ImageOption {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly architecture?: string;
  readonly rootDeviceName?: string;
  readonly distribution?: AwsEc2ImageDistribution;
  readonly version?: string;
  readonly creationDate?: string;
  readonly sshUsername?: string;
}

export interface AwsEc2Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly expiration?: Date;
  readonly credentialScope?: string;
  readonly accountId?: string;
}

export type AwsEc2CredentialProvider = () => Promise<AwsEc2Credentials>;
export type AwsEc2CredentialSource = AwsEc2Credentials | AwsEc2CredentialProvider;

export interface AwsEc2ProviderConnection {
  readonly region: string;
  readonly credentials: AwsEc2CredentialSource;
}

export interface AwsEc2ClientConfiguration {
  readonly region: string;
  readonly credentials: AwsEc2CredentialSource;
}

export interface AwsEc2ClientLike {
  send(command: unknown): Promise<unknown>;
}

export type AwsEc2ClientFactory = (configuration: AwsEc2ClientConfiguration) => AwsEc2ClientLike;

export interface AwsEc2Waiters {
  readonly running: (client: AwsEc2ClientLike, instanceId: string) => Promise<void>;
  readonly instanceStatusOk: (client: AwsEc2ClientLike, instanceId: string) => Promise<void>;
  readonly systemStatusOk: (client: AwsEc2ClientLike, instanceId: string) => Promise<void>;
  readonly stopped: (client: AwsEc2ClientLike, instanceId: string) => Promise<void>;
  readonly terminated: (client: AwsEc2ClientLike, instanceId: string) => Promise<void>;
  readonly subnetAvailable: (client: AwsEc2ClientLike, subnetId: string) => Promise<void>;
  readonly vpcAvailable: (client: AwsEc2ClientLike, vpcId: string) => Promise<void>;
}

export interface AwsEc2ProviderDependencies {
  readonly clientFactory?: AwsEc2ClientFactory;
  readonly waiters?: AwsEc2Waiters;
}

export interface AwsEc2PreflightResult {
  readonly region: string;
  readonly availabilityZones: readonly {
    readonly name: string;
    readonly state: string;
  }[];
}

export interface AwsEc2DiscoveryInput {
  readonly vpcId?: string;
  readonly imageIds?: readonly string[];
  readonly imageOwners?: readonly string[];
  readonly imageNamePattern?: string;
  readonly architecture?: "arm64" | "x86_64";
}

export interface AwsEc2DiscoveryResult extends AwsEc2PreflightResult {
  readonly instanceTypes: readonly AwsEc2InstanceTypeOption[];
  readonly vpcs: readonly {
    readonly id: string;
    readonly name?: string;
    readonly cidrBlock?: string;
    readonly isDefault: boolean;
  }[];
  readonly subnets: readonly {
    readonly id: string;
    readonly name?: string;
    readonly vpcId: string;
    readonly availabilityZone?: string;
    readonly cidrBlock?: string;
    readonly mapPublicIpOnLaunch: boolean;
  }[];
  readonly keyPairs: readonly {
    readonly name: string;
    readonly id?: string;
    readonly fingerprint?: string;
    readonly keyType?: string;
    readonly publicKey?: string;
  }[];
  readonly images: readonly AwsEc2ImageOption[];
}

export interface AwsEc2FirewallInput {
  readonly sshPort: number;
  readonly sshSourceCidrs: readonly string[];
  readonly multiplayerPort: number;
  readonly multiplayerSourceCidrs: readonly string[];
}

export type AwsEc2NetworkInput =
  | { readonly mode: "existing"; readonly vpcId: string; readonly subnetId: string }
  | {
    readonly mode: "managed";
    readonly vpcCidrBlock: string;
    readonly subnetCidrBlock: string;
  };

export type AwsEc2SshKeyPairInput =
  | { readonly mode: "managed" }
  | { readonly mode: "existing"; readonly name: string };

export interface AwsEc2CreateInput {
  readonly guid: string;
  readonly name: string;
  readonly imageId: string;
  readonly instanceType: string;
  readonly network: AwsEc2NetworkInput;
  /** OpenSSH RSA or ED25519 public key derived from the stored SSH private key. */
  readonly sshPublicKey: string;
  readonly sshKeyPair?: AwsEc2SshKeyPairInput;
  readonly userData?: string;
  readonly rootVolumeSizeGiB?: number;
  readonly rootVolumeKmsKeyId?: string;
  readonly firewall: AwsEc2FirewallInput;
  readonly allocateElasticIp: boolean;
}

export interface AwsEc2KeyPairResource {
  readonly id: string;
  readonly name: string;
  /** Absent on legacy records, which always represented a managed key pair. */
  readonly managed?: boolean;
}

/** @deprecated Use AwsEc2KeyPairResource. */
export type AwsEc2ManagedKeyPairResource = AwsEc2KeyPairResource;

export interface AwsEc2ManagedNetworkResource {
  readonly vpcId: string;
  readonly subnetId: string;
  readonly internetGatewayId: string;
  readonly routeTableId: string;
  readonly routeTableAssociationId: string;
}

export interface AwsEc2DestroyNetworkResource {
  readonly vpcId?: string;
  readonly subnetId?: string;
  readonly internetGatewayId?: string;
  readonly routeTableId?: string;
  readonly routeTableAssociationId?: string;
}

export interface AwsEc2CreateMutationResources {
  readonly keyPair?: AwsEc2KeyPairResource | undefined;
  readonly vpcId?: string;
  readonly subnetId?: string;
  readonly internetGatewayId?: string;
  readonly routeTableId?: string;
  readonly routeTableAssociationId?: string;
  readonly securityGroupId?: string;
  readonly instanceId?: string;
  readonly elasticIpAllocationId?: string;
  readonly elasticIpAssociationId?: string;
  readonly elasticIpPublicAddress?: string;
}

export interface AwsEc2CreateMutationEvent {
  readonly phase:
    | "key-pair"
    | "vpc"
    | "internet-gateway"
    | "subnet"
    | "route-table"
    | "security-group"
    | "instance"
    | "instance-running"
    | "instance-status-ok"
    | "system-status-ok"
    | "elastic-ip";
  readonly resources: AwsEc2CreateMutationResources;
}

export type AwsEc2CreateMutationListener = (
  event: AwsEc2CreateMutationEvent,
) => void | Promise<void>;

export type AwsEc2InstanceState =
  | "pending"
  | "running"
  | "shutting-down"
  | "terminated"
  | "stopping"
  | "stopped"
  | "unknown";

export type AwsEc2Health = "ok" | "impaired" | "initializing" | "unknown";

export interface AwsEc2ElasticIpResource {
  readonly allocationId: string;
  readonly associationId?: string;
  readonly publicIp: string;
}

export interface AwsEc2DeploymentResource {
  readonly guid: string;
  readonly name: string;
  readonly region: string;
  readonly keyPair?: AwsEc2KeyPairResource;
  readonly managedNetwork?: AwsEc2ManagedNetworkResource;
  readonly instanceId: string;
  readonly securityGroupId: string;
  readonly volumeIds: readonly string[];
  readonly networkInterfaceIds: readonly string[];
  readonly state: AwsEc2InstanceState;
  readonly instanceHealth: AwsEc2Health;
  readonly systemHealth: AwsEc2Health;
  readonly availabilityZone?: string;
  readonly privateIpAddress?: string;
  readonly publicIpAddress?: string;
  readonly elasticIp?: AwsEc2ElasticIpResource;
}

/**
 * Provider identities durably journaled while creation is in progress. Any
 * subset can be cleaned up after a failed or interrupted deployment.
 */
export interface AwsEc2DestroyResource {
  readonly guid: string;
  readonly name: string;
  readonly region: string;
  readonly keyPair?: AwsEc2KeyPairResource;
  readonly managedNetwork?: AwsEc2DestroyNetworkResource;
  readonly instanceId?: string;
  readonly securityGroupId?: string;
  readonly volumeIds?: readonly string[];
  readonly networkInterfaceIds?: readonly string[];
  readonly elasticIp?: Pick<AwsEc2ElasticIpResource, "allocationId" | "associationId">;
}

export class AwsEc2ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsEc2ProviderError";
  }
}

/**
 * EC2 operations for a single explicitly-authenticated AWS region.
 *
 * The provider never selects an AWS identity implicitly. Every client is
 * constructed with either explicit access keys or an explicit named-profile
 * provider supplied by the caller.
 */
export class AwsEc2Provider {
  private readonly region: string;
  private readonly client: AwsEc2ClientLike;
  private readonly waiters: AwsEc2Waiters;

  constructor(connection: AwsEc2ProviderConnection, dependencies: AwsEc2ProviderDependencies = {}) {
    this.region = validateRegion(connection.region);
    const credentials = validateCredentialSource(connection.credentials);
    const clientFactory = dependencies.clientFactory ?? defaultClientFactory;
    this.client = clientFactory({ region: this.region, credentials });
    this.waiters = dependencies.waiters ?? defaultWaiters;
  }

  async preflight(): Promise<AwsEc2PreflightResult> {
    const response = await this.send<DescribeAvailabilityZonesCommandOutput>(
      "credential and region preflight",
      new DescribeAvailabilityZonesCommand({
        AllAvailabilityZones: false,
        Filters: [{ Name: "state", Values: ["available"] }],
      }),
    );
    return {
      region: this.region,
      availabilityZones: (response.AvailabilityZones ?? [])
        .flatMap((zone) => zone.ZoneName ? [{ name: zone.ZoneName, state: zone.State ?? "unknown" }] : [])
        .sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async discover(input: AwsEc2DiscoveryInput = {}): Promise<AwsEc2DiscoveryResult> {
    validateDiscoveryInput(input);
    const subnetFilters = input.vpcId ? [{ Name: "vpc-id", Values: [input.vpcId] }] : undefined;
    const imageRequests = buildImageDiscoveryRequests(input, this.region);
    const [preflight, vpcResponses, subnetResponses, keyPairResponse, instanceTypes, imageResponsePages] = await Promise.all([
      this.preflight(),
      this.paginate<DescribeVpcsCommandOutput>("discover VPCs", (nextToken) => (
        new DescribeVpcsCommand(nextToken ? { NextToken: nextToken } : {})
      )),
      this.paginate<DescribeSubnetsCommandOutput>(
        "discover subnets",
        (nextToken) => new DescribeSubnetsCommand({
          ...(subnetFilters ? { Filters: subnetFilters } : {}),
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      ),
      this.send<DescribeKeyPairsCommandOutput>(
        "discover key pairs",
        new DescribeKeyPairsCommand({ IncludePublicKey: true }),
      ),
      this.discoverInstanceTypes(),
      Promise.all(imageRequests.map((request) => this.paginate<DescribeImagesCommandOutput>(
        "discover images",
        (nextToken) => new DescribeImagesCommand({
          ...request,
          ...(nextToken ? { NextToken: nextToken } : {}),
        }),
      ))),
    ]);
    const vpcResponseValues = vpcResponses.flatMap((response) => response.Vpcs ?? []);
    const subnetResponseValues = subnetResponses.flatMap((response) => response.Subnets ?? []);

    return {
      ...preflight,
      instanceTypes,
      vpcs: uniqueById(vpcResponseValues.flatMap((vpc) => vpc.VpcId ? [{
        id: vpc.VpcId,
        ...optionalString("name", tagValue(vpc.Tags, NAME_TAG_KEY)),
        ...optionalString("cidrBlock", vpc.CidrBlock),
        isDefault: vpc.IsDefault === true,
      }] : []))
        .sort(compareNamedIds),
      subnets: uniqueById(subnetResponseValues.flatMap((subnet) => subnet.SubnetId && subnet.VpcId ? [{
        id: subnet.SubnetId,
        ...optionalString("name", tagValue(subnet.Tags, NAME_TAG_KEY)),
        vpcId: subnet.VpcId,
        ...optionalString("availabilityZone", subnet.AvailabilityZone),
        ...optionalString("cidrBlock", subnet.CidrBlock),
        mapPublicIpOnLaunch: subnet.MapPublicIpOnLaunch === true,
      }] : []))
        .sort(compareNamedIds),
      keyPairs: (keyPairResponse.KeyPairs ?? [])
        .flatMap((keyPair) => keyPair.KeyName ? [{
          name: keyPair.KeyName,
          ...optionalString("id", keyPair.KeyPairId),
          ...optionalString("fingerprint", keyPair.KeyFingerprint),
          ...optionalString("keyType", keyPair.KeyType),
          ...optionalString("publicKey", keyPair.PublicKey),
        }] : [])
        .sort((left, right) => left.name.localeCompare(right.name)),
      images: normalizeImageOptions(
        imageResponsePages.flatMap((pages) => pages.flatMap((response) => response.Images ?? [])),
        isRecommendedImageDiscovery(input),
        canonicalOwnerForRegion(this.region),
      ),
    };
  }

  async create(
    input: AwsEc2CreateInput,
    onMutation?: AwsEc2CreateMutationListener,
  ): Promise<AwsEc2DeploymentResource> {
    const validated = validateCreateInput(input);
    const image = await this.lookupLaunchImage(validated.imageId);
    const expectedArchitecture = supportedInstanceArchitecture(validated.instanceType);
    if (expectedArchitecture && image.architecture !== expectedArchitecture) {
      throw new AwsEc2ProviderError(
        `The selected EC2 image architecture must be ${expectedArchitecture} for ${validated.instanceType}.`,
      );
    }
    if (validated.network.mode === "existing") {
      const actualVpcId = await this.lookupSubnetVpc(validated.network.subnetId);
      if (actualVpcId !== validated.network.vpcId) {
        throw new AwsEc2ProviderError("The selected EC2 subnet does not belong to the selected VPC.");
      }
    }
    const existingKeyPair = validated.sshKeyPair.mode === "existing"
      ? await this.lookupExistingKeyPair(validated.sshKeyPair.name, validated.sshPublicKey)
      : undefined;

    let keyPair: AwsEc2KeyPairResource | undefined = existingKeyPair;
    let vpcId: string | undefined = validated.network.mode === "existing"
      ? validated.network.vpcId
      : undefined;
    let subnetId: string | undefined = validated.network.mode === "existing"
      ? validated.network.subnetId
      : undefined;
    let internetGatewayId: string | undefined;
    let routeTableId: string | undefined;
    let routeTableAssociationId: string | undefined;
    let securityGroupId: string | undefined;
    let instanceId: string | undefined;
    let allocationId: string | undefined;
    let associationId: string | undefined;
    let elasticPublicIp: string | undefined;
    const mutationResources = (): AwsEc2CreateMutationResources => ({
      ...(keyPair ? { keyPair } : {}),
      ...(validated.network.mode === "managed" ? {
        ...optionalString("vpcId", vpcId),
        ...optionalString("subnetId", subnetId),
        ...optionalString("internetGatewayId", internetGatewayId),
        ...optionalString("routeTableId", routeTableId),
        ...optionalString("routeTableAssociationId", routeTableAssociationId),
      } : {}),
      ...optionalString("securityGroupId", securityGroupId),
      ...optionalString("instanceId", instanceId),
      ...optionalString("elasticIpAllocationId", allocationId),
      ...optionalString("elasticIpAssociationId", associationId),
      ...optionalString("elasticIpPublicAddress", elasticPublicIp),
    });
    try {
      const tags = managedTags(validated.guid, validated.name);
      if (validated.sshKeyPair.mode === "managed") {
        const keyPairName = managedKeyPairName(validated.guid);
        const importedKeyPair = await this.send<ImportKeyPairCommandOutput>(
          "import the managed SSH key pair",
          new ImportKeyPairCommand({
            KeyName: keyPairName,
            PublicKeyMaterial: Buffer.from(validated.sshPublicKey, "utf8"),
            TagSpecifications: [{ ResourceType: "key-pair", Tags: tags }],
          }),
        );
        keyPair = {
          id: requireAwsId(importedKeyPair.KeyPairId, "key pair", AWS_ID_PATTERNS.keyPair),
          name: keyPairName,
        };
        await notifyCreateMutation(onMutation, "key-pair", mutationResources());
      }

      if (validated.network.mode === "managed") {
        const createdVpc = await this.send<CreateVpcCommandOutput>(
          "create the managed VPC",
          new CreateVpcCommand({
            CidrBlock: validated.network.vpcCidrBlock,
            InstanceTenancy: "default",
            TagSpecifications: [{ ResourceType: "vpc", Tags: tags }],
          }),
        );
        vpcId = requireAwsId(createdVpc.Vpc?.VpcId, "VPC", AWS_ID_PATTERNS.vpc);
        await notifyCreateMutation(onMutation, "vpc", mutationResources());
        await this.wait("wait for the managed VPC", () => this.waiters.vpcAvailable(this.client, vpcId!));
        await this.send(
          "enable managed VPC DNS support",
          new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsSupport: { Value: true } }),
        );
        await this.send(
          "enable managed VPC DNS hostnames",
          new ModifyVpcAttributeCommand({ VpcId: vpcId, EnableDnsHostnames: { Value: true } }),
        );

        const createdGateway = await this.send<CreateInternetGatewayCommandOutput>(
          "create the managed internet gateway",
          new CreateInternetGatewayCommand({
            TagSpecifications: [{ ResourceType: "internet-gateway", Tags: tags }],
          }),
        );
        internetGatewayId = requireAwsId(
          createdGateway.InternetGateway?.InternetGatewayId,
          "internet gateway",
          AWS_ID_PATTERNS.internetGateway,
        );
        await notifyCreateMutation(onMutation, "internet-gateway", mutationResources());
        await this.send(
          "attach the managed internet gateway",
          new AttachInternetGatewayCommand({ InternetGatewayId: internetGatewayId, VpcId: vpcId }),
        );

        const createdSubnet = await this.send<CreateSubnetCommandOutput>(
          "create the managed public subnet",
          new CreateSubnetCommand({
            VpcId: vpcId,
            CidrBlock: validated.network.subnetCidrBlock,
            TagSpecifications: [{ ResourceType: "subnet", Tags: tags }],
          }),
        );
        subnetId = requireAwsId(createdSubnet.Subnet?.SubnetId, "subnet", AWS_ID_PATTERNS.subnet);
        await notifyCreateMutation(onMutation, "subnet", mutationResources());
        await this.wait(
          "wait for the managed subnet",
          () => this.waiters.subnetAvailable(this.client, subnetId!),
        );
        await this.send(
          "enable public IPv4 assignment on the managed subnet",
          new ModifySubnetAttributeCommand({ SubnetId: subnetId, MapPublicIpOnLaunch: { Value: true } }),
        );

        const createdRouteTable = await this.send<CreateRouteTableCommandOutput>(
          "create the managed route table",
          new CreateRouteTableCommand({
            VpcId: vpcId,
            TagSpecifications: [{ ResourceType: "route-table", Tags: tags }],
          }),
        );
        routeTableId = requireAwsId(
          createdRouteTable.RouteTable?.RouteTableId,
          "route table",
          AWS_ID_PATTERNS.routeTable,
        );
        await notifyCreateMutation(onMutation, "route-table", mutationResources());
        await this.send(
          "create the managed public route",
          new CreateRouteCommand({
            RouteTableId: routeTableId,
            DestinationCidrBlock: "0.0.0.0/0",
            GatewayId: internetGatewayId,
          }),
        );
        const associatedRouteTable = await this.send<AssociateRouteTableCommandOutput>(
          "associate the managed route table",
          new AssociateRouteTableCommand({ RouteTableId: routeTableId, SubnetId: subnetId }),
        );
        routeTableAssociationId = requireAwsId(
          associatedRouteTable.AssociationId,
          "route table association",
          AWS_ID_PATTERNS.routeTableAssociation,
        );
        await notifyCreateMutation(onMutation, "route-table", mutationResources());
      }

      if (!keyPair || !vpcId || !subnetId) {
        throw new AwsEc2ProviderError("AWS EC2 did not resolve the selected SSH key pair and network.");
      }

      const group = await this.send<{ GroupId?: string }>(
        "create the managed security group",
        new CreateSecurityGroupCommand({
          GroupName: `sliver-gui-${validated.guid}`,
          Description: `Sliver GUI managed deployment ${validated.guid}`,
          VpcId: vpcId,
          TagSpecifications: [{ ResourceType: "security-group", Tags: tags }],
        }),
      );
      securityGroupId = requireAwsId(group.GroupId, "security group", AWS_ID_PATTERNS.securityGroup);
      await notifyCreateMutation(onMutation, "security-group", mutationResources());
      await this.authorizeManagedFirewall(securityGroupId, validated.guid, validated.name, validated.firewall);

      const runInput: RunInstancesCommandInput = {
        ImageId: validated.imageId,
        InstanceType: validated.instanceType as RunInstancesCommandInput["InstanceType"],
        MinCount: 1,
        MaxCount: 1,
        ClientToken: validated.guid,
        SubnetId: subnetId,
        SecurityGroupIds: [securityGroupId],
        MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" },
        BlockDeviceMappings: [{
          DeviceName: image.rootDeviceName,
          Ebs: {
            DeleteOnTermination: true,
            Encrypted: true,
            ...optionalNumber("VolumeSize", validated.rootVolumeSizeGiB),
            ...optionalString("KmsKeyId", validated.rootVolumeKmsKeyId),
          },
        }],
        TagSpecifications: launchTagSpecifications(tags),
        KeyName: keyPair.name,
        ...(validated.userData === undefined
          ? {}
          : { UserData: Buffer.from(validated.userData, "utf8").toString("base64") }),
      };
      const launched = await this.send<RunInstancesCommandOutput>(
        "launch the managed instance",
        new RunInstancesCommand(runInput),
      );
      if (launched.Instances?.length !== 1) {
        throw new AwsEc2ProviderError("AWS EC2 did not return exactly one launched instance.");
      }
      instanceId = requireAwsId(launched.Instances[0]?.InstanceId, "instance", AWS_ID_PATTERNS.instance);
      await notifyCreateMutation(onMutation, "instance", mutationResources());
      await this.wait("wait for the instance to run", () => this.waiters.running(this.client, instanceId!));
      await notifyCreateMutation(onMutation, "instance-running", mutationResources());
      await this.wait("wait for instance status checks", () => this.waiters.instanceStatusOk(this.client, instanceId!));
      await notifyCreateMutation(onMutation, "instance-status-ok", mutationResources());
      await this.wait("wait for system status checks", () => this.waiters.systemStatusOk(this.client, instanceId!));
      await notifyCreateMutation(onMutation, "system-status-ok", mutationResources());

      if (validated.allocateElasticIp) {
        const allocated = await this.send<AllocateAddressCommandOutput>(
          "allocate the managed Elastic IP",
          new AllocateAddressCommand({
            Domain: "vpc",
            TagSpecifications: [{ ResourceType: "elastic-ip", Tags: tags }],
          }),
        );
        allocationId = requireAwsId(allocated.AllocationId, "Elastic IP allocation", AWS_ID_PATTERNS.allocation);
        elasticPublicIp = requireIpAddress(
          allocated.PublicIp,
          "AWS EC2 did not return a valid allocated public IPv4 address.",
          4,
        );
        await notifyCreateMutation(onMutation, "elastic-ip", mutationResources());
        const associated = await this.send<AssociateAddressCommandOutput>(
          "associate the managed Elastic IP",
          new AssociateAddressCommand({ AllocationId: allocationId, InstanceId: instanceId }),
        );
        associationId = requireAwsId(
          associated.AssociationId,
          "Elastic IP association",
          AWS_ID_PATTERNS.association,
        );
        await notifyCreateMutation(onMutation, "elastic-ip", mutationResources());
      }

      const resource: AwsEc2DeploymentResource = {
        guid: validated.guid,
        name: validated.name,
        region: this.region,
        keyPair,
        ...(validated.network.mode === "managed" ? {
          managedNetwork: {
            vpcId,
            subnetId,
            internetGatewayId: internetGatewayId!,
            routeTableId: routeTableId!,
            routeTableAssociationId: routeTableAssociationId!,
          },
        } : {}),
        instanceId,
        securityGroupId,
        volumeIds: [],
        networkInterfaceIds: [],
        state: "running",
        instanceHealth: "ok",
        systemHealth: "ok",
        ...(allocationId && elasticPublicIp ? {
          elasticIp: {
            allocationId,
            ...(associationId ? { associationId } : {}),
            publicIp: elasticPublicIp,
          },
          publicIpAddress: elasticPublicIp,
        } : {}),
      };
      return await this.refresh(resource);
    } catch (error) {
      await this.rollbackCreate({
        ...(keyPair && keyPair.managed !== false ? { keyPairId: keyPair.id } : {}),
        ...(securityGroupId ? { securityGroupId } : {}),
        ...(instanceId ? { instanceId } : {}),
        ...(allocationId ? { allocationId } : {}),
        ...(associationId ? { associationId } : {}),
        ...optionalString("vpcId", vpcId && validated.network.mode === "managed" ? vpcId : undefined),
        ...optionalString("subnetId", subnetId && validated.network.mode === "managed" ? subnetId : undefined),
        ...optionalString("internetGatewayId", internetGatewayId),
        ...optionalString("routeTableId", routeTableId),
        ...optionalString("routeTableAssociationId", routeTableAssociationId),
      });
      throw sanitizeAwsError("create the deployment", error);
    }
  }

  async refresh(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource> {
    this.validateResource(resource);
    const [instance, securityGroup, status, address] = await Promise.all([
      this.describeOwnedInstance(resource),
      this.describeOwnedSecurityGroup(resource),
      this.send<DescribeInstanceStatusCommandOutput>(
        "read instance health",
        new DescribeInstanceStatusCommand({ InstanceIds: [resource.instanceId], IncludeAllInstances: true }),
      ),
      resource.elasticIp ? this.describeOwnedElasticIp(resource) : Promise.resolve(undefined),
    ]);
    void securityGroup;
    const health = status.InstanceStatuses?.find((candidate) => candidate.InstanceId === resource.instanceId);
    const elasticIp = address?.AllocationId && address.PublicIp ? {
      allocationId: address.AllocationId,
      ...optionalString("associationId", address.AssociationId),
      publicIp: requireIpAddress(address.PublicIp, "AWS EC2 returned an invalid Elastic IP address.", 4),
    } : undefined;
    const privateIpAddress = optionalIpAddress(instance.PrivateIpAddress, "private IP address");
    const publicIpAddress = elasticIp?.publicIp ?? optionalIpAddress(instance.PublicIpAddress, "public IP address");
    const volumeIds = [...new Set((instance.BlockDeviceMappings ?? [])
      .flatMap((mapping) => mapping.Ebs?.VolumeId ? [
        requireAwsId(mapping.Ebs.VolumeId, "volume", AWS_ID_PATTERNS.volume),
      ] : []))].sort();
    const networkInterfaceIds = [...new Set((instance.NetworkInterfaces ?? [])
      .flatMap((networkInterface) => networkInterface.NetworkInterfaceId ? [
        requireAwsId(
          networkInterface.NetworkInterfaceId,
          "network interface",
          AWS_ID_PATTERNS.networkInterface,
        ),
      ] : []))].sort();
    return {
      guid: resource.guid,
      name: resource.name,
      region: resource.region,
      ...(resource.keyPair ? { keyPair: resource.keyPair } : {}),
      ...(resource.managedNetwork ? { managedNetwork: resource.managedNetwork } : {}),
      instanceId: resource.instanceId,
      securityGroupId: resource.securityGroupId,
      volumeIds,
      networkInterfaceIds,
      state: normalizeInstanceState(instance.State?.Name),
      instanceHealth: normalizeHealth(health?.InstanceStatus?.Status),
      systemHealth: normalizeHealth(health?.SystemStatus?.Status),
      ...optionalString("availabilityZone", instance.Placement?.AvailabilityZone),
      ...optionalString("privateIpAddress", privateIpAddress),
      ...optionalString("publicIpAddress", publicIpAddress),
      ...(elasticIp ? { elasticIp } : {}),
    };
  }

  async start(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource> {
    const instance = await this.describeOwnedInstance(resource);
    if (instance.State?.Name !== "running") {
      await this.send("start the managed instance", new StartInstancesCommand({ InstanceIds: [resource.instanceId] }));
      await this.wait("wait for the instance to run", () => this.waiters.running(this.client, resource.instanceId));
    }
    await this.wait("wait for instance status checks", () => this.waiters.instanceStatusOk(this.client, resource.instanceId));
    await this.wait("wait for system status checks", () => this.waiters.systemStatusOk(this.client, resource.instanceId));
    return await this.refresh(resource);
  }

  async stop(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource> {
    const instance = await this.describeOwnedInstance(resource);
    if (instance.State?.Name !== "stopped") {
      await this.send(
        "stop the managed instance",
        new StopInstancesCommand({
          InstanceIds: [resource.instanceId],
          Force: false,
          SkipOsShutdown: false,
        }),
      );
      await this.wait("wait for the instance to stop", () => this.waiters.stopped(this.client, resource.instanceId));
    }
    return await this.refresh(resource);
  }

  async reboot(resource: AwsEc2DeploymentResource): Promise<AwsEc2DeploymentResource> {
    await this.describeOwnedInstance(resource);
    await this.send("reboot the managed instance", new RebootInstancesCommand({ InstanceIds: [resource.instanceId] }));
    await this.wait("wait for the instance to run", () => this.waiters.running(this.client, resource.instanceId));
    await this.wait("wait for instance status checks", () => this.waiters.instanceStatusOk(this.client, resource.instanceId));
    await this.wait("wait for system status checks", () => this.waiters.systemStatusOk(this.client, resource.instanceId));
    return await this.refresh(resource);
  }

  async replaceFirewall(
    resource: AwsEc2DeploymentResource,
    firewall: AwsEc2FirewallInput,
  ): Promise<AwsEc2DeploymentResource> {
    this.validateResource(resource);
    const validated = validateFirewall(firewall);
    await this.describeOwnedSecurityGroup(resource);
    const ruleResponse = await this.send<DescribeSecurityGroupRulesCommandOutput>(
      "read managed firewall rules",
      new DescribeSecurityGroupRulesCommand({
        Filters: [{ Name: "group-id", Values: [resource.securityGroupId] }],
      }),
    );
    const managedRuleIds = (ruleResponse.SecurityGroupRules ?? [])
      .filter((rule) => hasManagedTags(rule.Tags, resource.guid))
      .flatMap((rule) => rule.SecurityGroupRuleId ? [rule.SecurityGroupRuleId] : []);
    if (managedRuleIds.length > 0) {
      await this.send(
        "remove old managed firewall rules",
        new RevokeSecurityGroupIngressCommand({
          GroupId: resource.securityGroupId,
          SecurityGroupRuleIds: managedRuleIds,
        }),
      );
    }
    await this.authorizeManagedFirewall(
      resource.securityGroupId,
      resource.guid,
      resource.name,
      validated,
    );
    return await this.refresh(resource);
  }

  async destroy(resource: AwsEc2DestroyResource): Promise<void> {
    this.validateDestroyResource(resource);
    const volumeIds = resource.volumeIds ?? [];
    const networkInterfaceIds = resource.networkInterfaceIds ?? [];
    const [instance, securityGroup, address, keyPair, vpc, subnet, internetGateway, routeTable] = await Promise.all([
      this.findOwnedInstance(resource),
      this.findOwnedSecurityGroup(resource),
      this.findOwnedElasticIp(resource),
      this.findOwnedKeyPair(resource),
      this.findOwnedVpc(resource),
      this.findOwnedSubnet(resource),
      this.findOwnedInternetGateway(resource),
      this.findOwnedRouteTable(resource),
      Promise.all(volumeIds.map((volumeId) => this.findOwnedVolume(resource, volumeId))),
      Promise.all(networkInterfaceIds.map((networkInterfaceId) => (
        this.findOwnedNetworkInterface(resource, networkInterfaceId)
      ))),
    ]);

    if (address?.AssociationId) {
      await this.sendAllowingNotFound(
        "disassociate the managed Elastic IP",
        new DisassociateAddressCommand({ AssociationId: address.AssociationId }),
        ["InvalidAssociationID.NotFound"],
      );
    }
    if (address?.AllocationId) {
      await this.sendAllowingNotFound(
        "release the managed Elastic IP",
        new ReleaseAddressCommand({ AllocationId: address.AllocationId }),
        ["InvalidAllocationID.NotFound"],
      );
    }
    if (instance && instance.State?.Name !== "terminated" && resource.instanceId) {
      const terminateResult = await this.sendAllowingNotFound(
        "terminate the managed instance",
        new TerminateInstancesCommand({ InstanceIds: [resource.instanceId] }),
        ["InvalidInstanceID.NotFound"],
      );
      if (terminateResult.found) {
        await this.waitAllowingNotFound(
          "wait for the instance to terminate",
          () => this.waiters.terminated(this.client, resource.instanceId!),
          ["InvalidInstanceID.NotFound"],
        );
      }
    }
    const remainingNetworkInterfaces = await Promise.all(networkInterfaceIds.map((networkInterfaceId) => (
      this.findOwnedNetworkInterface(resource, networkInterfaceId)
    )));
    for (const networkInterface of remainingNetworkInterfaces) {
      if (!networkInterface?.NetworkInterfaceId) continue;
      await this.sendAllowingNotFound(
        "delete the managed network interface",
        new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: networkInterface.NetworkInterfaceId }),
        ["InvalidNetworkInterfaceID.NotFound"],
      );
    }
    const remainingVolumes = await Promise.all(volumeIds.map((volumeId) => this.findOwnedVolume(resource, volumeId)));
    for (const volume of remainingVolumes) {
      if (!volume?.VolumeId) continue;
      await this.sendAllowingNotFound(
        "delete the managed EBS volume",
        new DeleteVolumeCommand({ VolumeId: volume.VolumeId }),
        ["InvalidVolume.NotFound"],
      );
    }
    if (securityGroup?.GroupId) {
      await this.sendAllowingNotFound(
        "delete the managed security group",
        new DeleteSecurityGroupCommand({ GroupId: securityGroup.GroupId }),
        ["InvalidGroup.NotFound"],
      );
    }
    if (keyPair?.KeyPairId) {
      await this.sendAllowingNotFound(
        "delete the managed SSH key pair",
        new DeleteKeyPairCommand({ KeyPairId: keyPair.KeyPairId }),
        ["InvalidKeyPair.NotFound"],
      );
    }
    const managedNetwork = resource.managedNetwork;
    const association = routeTable?.Associations?.find(
      (candidate) => candidate.RouteTableAssociationId === managedNetwork?.routeTableAssociationId,
    );
    if (association?.RouteTableAssociationId) {
      await this.sendAllowingNotFound(
        "disassociate the managed route table",
        new DisassociateRouteTableCommand({ AssociationId: association.RouteTableAssociationId }),
        ["InvalidAssociationID.NotFound"],
      );
    }
    if (routeTable?.RouteTableId) {
      await this.sendAllowingNotFound(
        "delete the managed public route",
        new DeleteRouteCommand({ RouteTableId: routeTable.RouteTableId, DestinationCidrBlock: "0.0.0.0/0" }),
        ["InvalidRoute.NotFound", "InvalidRouteTableID.NotFound"],
      );
      await this.sendAllowingNotFound(
        "delete the managed route table",
        new DeleteRouteTableCommand({ RouteTableId: routeTable.RouteTableId }),
        ["InvalidRouteTableID.NotFound"],
      );
    }
    if (subnet?.SubnetId) {
      await this.sendAllowingNotFound(
        "delete the managed subnet",
        new DeleteSubnetCommand({ SubnetId: subnet.SubnetId }),
        ["InvalidSubnetID.NotFound"],
      );
    }
    if (internetGateway?.InternetGatewayId) {
      const attachedVpcId = internetGateway.Attachments
        ?.find((attachment) => attachment.VpcId === managedNetwork?.vpcId)?.VpcId;
      if (attachedVpcId) {
        await this.sendAllowingNotFound(
          "detach the managed internet gateway",
          new DetachInternetGatewayCommand({
            InternetGatewayId: internetGateway.InternetGatewayId,
            VpcId: attachedVpcId,
          }),
          ["Gateway.NotAttached", "InvalidInternetGatewayID.NotFound", "InvalidVpcID.NotFound"],
        );
      }
      await this.sendAllowingNotFound(
        "delete the managed internet gateway",
        new DeleteInternetGatewayCommand({ InternetGatewayId: internetGateway.InternetGatewayId }),
        ["InvalidInternetGatewayID.NotFound"],
      );
    }
    if (vpc?.VpcId) {
      await this.sendAllowingNotFound(
        "delete the managed VPC",
        new DeleteVpcCommand({ VpcId: vpc.VpcId }),
        ["InvalidVpcID.NotFound"],
      );
    }
  }

  private async discoverInstanceTypes(): Promise<AwsEc2InstanceTypeOption[]> {
    const offeringResponses = await this.paginate<DescribeInstanceTypeOfferingsCommandOutput>(
      "discover regional instance type offerings",
      (nextToken) => new DescribeInstanceTypeOfferingsCommand({
        LocationType: "region",
        Filters: [
          { Name: "location", Values: [this.region] },
          { Name: "instance-type", Values: [...AWS_EC2_DEFAULT_INSTANCE_TYPES] },
        ],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    const offered = new Set(offeringResponses.flatMap((response) => response.InstanceTypeOfferings ?? [])
      .flatMap((offering) => offering.InstanceType ? [offering.InstanceType] : []));
    const instanceTypes = AWS_EC2_DEFAULT_INSTANCE_TYPES.filter((name) => offered.has(name));
    if (instanceTypes.length === 0) return [];
    const typeResponses = await this.paginate<DescribeInstanceTypesCommandOutput>(
      "discover instance types",
      (nextToken) => new DescribeInstanceTypesCommand({
        InstanceTypes: [...instanceTypes],
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    return normalizeInstanceTypeOptions(typeResponses.flatMap((response) => response.InstanceTypes ?? []));
  }

  private async paginate<T extends { readonly NextToken?: string | undefined }>(
    operation: string,
    command: (nextToken: string | undefined) => unknown,
  ): Promise<readonly T[]> {
    const pages: T[] = [];
    const seenTokens = new Set<string>();
    let nextToken: string | undefined;
    for (let page = 0; page < MAX_DISCOVERY_PAGES; page += 1) {
      const response = await this.send<T>(operation, command(nextToken));
      pages.push(response);
      const candidate = validatePaginationToken(response.NextToken, operation);
      if (candidate === undefined) return pages;
      if (seenTokens.has(candidate)) {
        throw new AwsEc2ProviderError(`AWS EC2 returned a repeated pagination token while attempting to ${operation}.`);
      }
      seenTokens.add(candidate);
      nextToken = candidate;
    }
    throw new AwsEc2ProviderError(`AWS EC2 returned too many pages while attempting to ${operation}.`);
  }

  private async authorizeManagedFirewall(
    securityGroupId: string,
    guid: string,
    name: string,
    firewall: AwsEc2FirewallInput,
  ): Promise<void> {
    const validated = validateFirewall(firewall);
    await this.send(
      "authorize managed firewall rules",
      new AuthorizeSecurityGroupIngressCommand({
        GroupId: securityGroupId,
        IpPermissions: firewallPermissions(validated, guid),
        TagSpecifications: [{ ResourceType: "security-group-rule", Tags: managedTags(guid, name) }],
      }),
    );
  }

  private async lookupLaunchImage(imageId: string): Promise<{
    readonly rootDeviceName: string;
    readonly architecture: string | undefined;
  }> {
    const response = await this.send<DescribeImagesCommandOutput>(
      "validate the launch image",
      new DescribeImagesCommand({ ImageIds: [imageId] }),
    );
    const image = response.Images?.find((candidate) => candidate.ImageId === imageId);
    if (!image || image.State !== "available") {
      throw new AwsEc2ProviderError("The selected EC2 image is not available.");
    }
    if (image.RootDeviceType !== "ebs" || !image.RootDeviceName) {
      throw new AwsEc2ProviderError("The selected EC2 image does not have an encryptable EBS root volume.");
    }
    return { rootDeviceName: image.RootDeviceName, architecture: image.Architecture };
  }

  private async lookupSubnetVpc(subnetId: string): Promise<string> {
    const response = await this.send<DescribeSubnetsCommandOutput>(
      "validate the launch subnet",
      new DescribeSubnetsCommand({ SubnetIds: [subnetId] }),
    );
    const subnet = response.Subnets?.find((candidate) => candidate.SubnetId === subnetId);
    return requireNonEmpty(subnet?.VpcId, "The selected EC2 subnet does not belong to a VPC.");
  }

  private async lookupExistingKeyPair(name: string, expectedPublicKey: string): Promise<AwsEc2KeyPairResource> {
    const response = await this.send<DescribeKeyPairsCommandOutput>(
      "validate the selected SSH key pair",
      new DescribeKeyPairsCommand({ KeyNames: [name], IncludePublicKey: true }),
    );
    const keyPair = response.KeyPairs?.find((candidate) => candidate.KeyName === name);
    if (!keyPair?.PublicKey || !openSshPublicKeysEqual(keyPair.PublicKey, expectedPublicKey)) {
      throw new AwsEc2ProviderError(
        "The selected EC2 SSH key pair does not exactly match the credential public key.",
      );
    }
    return {
      id: requireAwsId(keyPair.KeyPairId, "key pair", AWS_ID_PATTERNS.keyPair),
      name,
      managed: false,
    };
  }

  private async findOwnedInstance(resource: AwsEc2DestroyResource) {
    if (!resource.instanceId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeInstancesCommandOutput>(
      "read the managed instance",
      new DescribeInstancesCommand({ InstanceIds: [resource.instanceId] }),
      ["InvalidInstanceID.NotFound"],
    );
    if (!result.found) return undefined;
    const instance = result.value.Reservations?.flatMap((reservation) => reservation.Instances ?? [])
      .find((candidate) => candidate.InstanceId === resource.instanceId);
    if (!instance) return undefined;
    assertManagedTags(instance.Tags, resource.guid, "instance");
    return instance;
  }

  private async findOwnedSecurityGroup(resource: AwsEc2DestroyResource): Promise<SecurityGroup | undefined> {
    if (!resource.securityGroupId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeSecurityGroupsCommandOutput>(
      "read the managed security group",
      new DescribeSecurityGroupsCommand({ GroupIds: [resource.securityGroupId] }),
      ["InvalidGroup.NotFound"],
    );
    if (!result.found) return undefined;
    const group = result.value.SecurityGroups?.find((candidate) => candidate.GroupId === resource.securityGroupId);
    if (!group) return undefined;
    assertManagedTags(group.Tags, resource.guid, "security group");
    return group;
  }

  private async findOwnedElasticIp(resource: AwsEc2DestroyResource) {
    const allocationId = resource.elasticIp?.allocationId;
    if (!allocationId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeAddressesCommandOutput>(
      "read the managed Elastic IP",
      new DescribeAddressesCommand({ AllocationIds: [allocationId] }),
      ["InvalidAllocationID.NotFound"],
    );
    if (!result.found) return undefined;
    const address = result.value.Addresses?.find((candidate) => candidate.AllocationId === allocationId);
    if (!address) return undefined;
    assertManagedTags(address.Tags, resource.guid, "Elastic IP");
    return address;
  }

  private async findOwnedKeyPair(resource: AwsEc2DestroyResource) {
    if (!resource.keyPair || resource.keyPair.managed === false) return undefined;
    const result = await this.sendAllowingNotFound<DescribeKeyPairsCommandOutput>(
      "read the managed SSH key pair",
      new DescribeKeyPairsCommand({ KeyPairIds: [resource.keyPair.id] }),
      ["InvalidKeyPair.NotFound"],
    );
    if (!result.found) return undefined;
    const keyPair = result.value.KeyPairs?.find((candidate) => candidate.KeyPairId === resource.keyPair?.id);
    if (!keyPair) return undefined;
    assertManagedTags(keyPair.Tags, resource.guid, "SSH key pair");
    if (keyPair.KeyName !== resource.keyPair.name) {
      throw new AwsEc2ProviderError("The tracked EC2 SSH key pair identity does not match.");
    }
    return keyPair;
  }

  private async findOwnedVpc(resource: AwsEc2DestroyResource) {
    const vpcId = resource.managedNetwork?.vpcId;
    if (!vpcId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeVpcsCommandOutput>(
      "read the managed VPC",
      new DescribeVpcsCommand({ VpcIds: [vpcId] }),
      ["InvalidVpcID.NotFound"],
    );
    if (!result.found) return undefined;
    const vpc = result.value.Vpcs?.find((candidate) => candidate.VpcId === vpcId);
    if (!vpc) return undefined;
    assertManagedTags(vpc.Tags, resource.guid, "VPC");
    return vpc;
  }

  private async findOwnedSubnet(resource: AwsEc2DestroyResource) {
    const network = resource.managedNetwork;
    if (!network?.subnetId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeSubnetsCommandOutput>(
      "read the managed subnet",
      new DescribeSubnetsCommand({ SubnetIds: [network.subnetId] }),
      ["InvalidSubnetID.NotFound"],
    );
    if (!result.found) return undefined;
    const subnet = result.value.Subnets?.find((candidate) => candidate.SubnetId === network.subnetId);
    if (!subnet) return undefined;
    assertManagedTags(subnet.Tags, resource.guid, "subnet");
    if (network.vpcId && subnet.VpcId !== network.vpcId) {
      throw new AwsEc2ProviderError("The tracked EC2 subnet does not belong to the managed VPC.");
    }
    return subnet;
  }

  private async findOwnedInternetGateway(resource: AwsEc2DestroyResource) {
    const network = resource.managedNetwork;
    if (!network?.internetGatewayId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeInternetGatewaysCommandOutput>(
      "read the managed internet gateway",
      new DescribeInternetGatewaysCommand({ InternetGatewayIds: [network.internetGatewayId] }),
      ["InvalidInternetGatewayID.NotFound"],
    );
    if (!result.found) return undefined;
    const gateway = result.value.InternetGateways
      ?.find((candidate) => candidate.InternetGatewayId === network.internetGatewayId);
    if (!gateway) return undefined;
    assertManagedTags(gateway.Tags, resource.guid, "internet gateway");
    if (network.vpcId && gateway.Attachments?.some((attachment) => attachment.VpcId !== network.vpcId)) {
      throw new AwsEc2ProviderError("The tracked EC2 internet gateway attachment does not match the managed VPC.");
    }
    return gateway;
  }

  private async findOwnedRouteTable(resource: AwsEc2DestroyResource) {
    const network = resource.managedNetwork;
    if (!network?.routeTableId) return undefined;
    const result = await this.sendAllowingNotFound<DescribeRouteTablesCommandOutput>(
      "read the managed route table",
      new DescribeRouteTablesCommand({ RouteTableIds: [network.routeTableId] }),
      ["InvalidRouteTableID.NotFound"],
    );
    if (!result.found) return undefined;
    const routeTable = result.value.RouteTables
      ?.find((candidate) => candidate.RouteTableId === network.routeTableId);
    if (!routeTable) return undefined;
    assertManagedTags(routeTable.Tags, resource.guid, "route table");
    if (network.vpcId && routeTable.VpcId !== network.vpcId) {
      throw new AwsEc2ProviderError("The tracked EC2 route table does not belong to the managed VPC.");
    }
    const association = routeTable.Associations?.find(
      (candidate) => candidate.RouteTableAssociationId === network.routeTableAssociationId,
    );
    if (association && network.subnetId && association.SubnetId !== network.subnetId) {
      throw new AwsEc2ProviderError("The tracked EC2 route table association does not match the managed subnet.");
    }
    return routeTable;
  }

  private async findOwnedVolume(resource: AwsEc2DestroyResource, volumeId: string) {
    const result = await this.sendAllowingNotFound<DescribeVolumesCommandOutput>(
      "read the managed EBS volume",
      new DescribeVolumesCommand({ VolumeIds: [volumeId] }),
      ["InvalidVolume.NotFound"],
    );
    if (!result.found) return undefined;
    const volume = result.value.Volumes?.find((candidate) => candidate.VolumeId === volumeId);
    if (!volume) return undefined;
    assertManagedTags(volume.Tags, resource.guid, "EBS volume");
    return volume;
  }

  private async findOwnedNetworkInterface(resource: AwsEc2DestroyResource, networkInterfaceId: string) {
    const result = await this.sendAllowingNotFound<DescribeNetworkInterfacesCommandOutput>(
      "read the managed network interface",
      new DescribeNetworkInterfacesCommand({ NetworkInterfaceIds: [networkInterfaceId] }),
      ["InvalidNetworkInterfaceID.NotFound"],
    );
    if (!result.found) return undefined;
    const networkInterface = result.value.NetworkInterfaces
      ?.find((candidate) => candidate.NetworkInterfaceId === networkInterfaceId);
    if (!networkInterface) return undefined;
    assertManagedTags(networkInterface.TagSet, resource.guid, "network interface");
    return networkInterface;
  }

  private async describeOwnedInstance(resource: AwsEc2DeploymentResource) {
    this.validateResource(resource);
    const response = await this.send<DescribeInstancesCommandOutput>(
      "read the managed instance",
      new DescribeInstancesCommand({ InstanceIds: [resource.instanceId] }),
    );
    const instance = response.Reservations?.flatMap((reservation) => reservation.Instances ?? [])
      .find((candidate) => candidate.InstanceId === resource.instanceId);
    if (!instance) throw new AwsEc2ProviderError("The tracked EC2 instance was not found.");
    assertManagedTags(instance.Tags, resource.guid, "instance");
    return instance;
  }

  private async describeOwnedSecurityGroup(resource: AwsEc2DeploymentResource): Promise<SecurityGroup> {
    this.validateResource(resource);
    const response = await this.send<DescribeSecurityGroupsCommandOutput>(
      "read the managed security group",
      new DescribeSecurityGroupsCommand({ GroupIds: [resource.securityGroupId] }),
    );
    const group = response.SecurityGroups?.find((candidate) => candidate.GroupId === resource.securityGroupId);
    if (!group) throw new AwsEc2ProviderError("The tracked EC2 security group was not found.");
    assertManagedTags(group.Tags, resource.guid, "security group");
    return group;
  }

  private async describeOwnedElasticIp(resource: AwsEc2DeploymentResource) {
    const allocationId = resource.elasticIp?.allocationId;
    if (!allocationId) return undefined;
    const response = await this.send<DescribeAddressesCommandOutput>(
      "read the managed Elastic IP",
      new DescribeAddressesCommand({ AllocationIds: [allocationId] }),
    );
    const address = response.Addresses?.find((candidate) => candidate.AllocationId === allocationId);
    if (!address) throw new AwsEc2ProviderError("The tracked EC2 Elastic IP was not found.");
    assertManagedTags(address.Tags, resource.guid, "Elastic IP");
    return address;
  }

  private validateResource(resource: AwsEc2DeploymentResource): void {
    this.validateDestroyResource(resource);
    if (resource.elasticIp) {
      requireIpAddress(resource.elasticIp.publicIp, "The tracked Elastic IP address is invalid.", 4);
    }
    if (resource.privateIpAddress) requireIpAddress(resource.privateIpAddress, "The tracked private IP address is invalid.");
    if (resource.publicIpAddress) requireIpAddress(resource.publicIpAddress, "The tracked public IP address is invalid.");
  }

  private validateDestroyResource(resource: AwsEc2DestroyResource): void {
    if (resource.region !== this.region) {
      throw new AwsEc2ProviderError("The tracked deployment belongs to a different AWS region.");
    }
    validateGuid(resource.guid);
    validateName(resource.name);
    if (resource.keyPair) {
      requireAwsId(resource.keyPair.id, "key pair", AWS_ID_PATTERNS.keyPair);
      if (resource.keyPair.managed !== undefined && typeof resource.keyPair.managed !== "boolean") {
        throw new AwsEc2ProviderError("The tracked EC2 SSH key pair ownership is invalid.");
      }
      if (resource.keyPair.managed === false) {
        validateKeyPairName(resource.keyPair.name);
      } else if (resource.keyPair.name !== managedKeyPairName(resource.guid)) {
        throw new AwsEc2ProviderError("The tracked EC2 SSH key pair name is invalid.");
      }
    }
    const network = resource.managedNetwork;
    if (network) {
      if (!network.vpcId) throw new AwsEc2ProviderError("The tracked managed VPC ID is missing.");
      requireAwsId(network.vpcId, "VPC", AWS_ID_PATTERNS.vpc);
      if (network.subnetId) requireAwsId(network.subnetId, "subnet", AWS_ID_PATTERNS.subnet);
      if (network.internetGatewayId) {
        requireAwsId(network.internetGatewayId, "internet gateway", AWS_ID_PATTERNS.internetGateway);
      }
      if (network.routeTableId) {
        requireAwsId(network.routeTableId, "route table", AWS_ID_PATTERNS.routeTable);
      }
      if (network.routeTableAssociationId) {
        requireAwsId(
          network.routeTableAssociationId,
          "route table association",
          AWS_ID_PATTERNS.routeTableAssociation,
        );
        if (!network.routeTableId || !network.subnetId) {
          throw new AwsEc2ProviderError("The tracked EC2 route table association is incomplete.");
        }
      }
    }
    if (resource.instanceId) requireAwsId(resource.instanceId, "instance", AWS_ID_PATTERNS.instance);
    if (resource.securityGroupId) requireAwsId(resource.securityGroupId, "security group", AWS_ID_PATTERNS.securityGroup);
    validateTrackedAwsIds(resource.volumeIds ?? [], "volume", AWS_ID_PATTERNS.volume, 64);
    validateTrackedAwsIds(
      resource.networkInterfaceIds ?? [],
      "network interface",
      AWS_ID_PATTERNS.networkInterface,
      64,
    );
    if (resource.elasticIp) {
      requireAwsId(resource.elasticIp.allocationId, "Elastic IP allocation", AWS_ID_PATTERNS.allocation);
      if (resource.elasticIp.associationId) {
        requireAwsId(resource.elasticIp.associationId, "Elastic IP association", AWS_ID_PATTERNS.association);
      }
    }
  }

  private async send<T = unknown>(operation: string, command: unknown): Promise<T> {
    try {
      return await this.client.send(command) as T;
    } catch (error) {
      throw sanitizeAwsError(operation, error);
    }
  }

  private async sendAllowingNotFound<T = unknown>(
    operation: string,
    command: unknown,
    notFoundCodes: readonly string[],
  ): Promise<{ readonly found: true; readonly value: T } | { readonly found: false }> {
    try {
      return { found: true, value: await this.client.send(command) as T };
    } catch (error) {
      if (hasAwsErrorCode(error, notFoundCodes)) return { found: false };
      throw sanitizeAwsError(operation, error);
    }
  }

  private async wait(operation: string, waiter: () => Promise<void>): Promise<void> {
    try {
      await waiter();
    } catch (error) {
      throw sanitizeAwsError(operation, error);
    }
  }

  private async waitAllowingNotFound(
    operation: string,
    waiter: () => Promise<void>,
    notFoundCodes: readonly string[],
  ): Promise<void> {
    try {
      await waiter();
    } catch (error) {
      if (!hasAwsErrorCode(error, notFoundCodes)) throw sanitizeAwsError(operation, error);
    }
  }

  private async rollbackCreate(resources: {
    readonly keyPairId?: string;
    readonly securityGroupId?: string;
    readonly instanceId?: string;
    readonly allocationId?: string;
    readonly associationId?: string;
    readonly vpcId?: string;
    readonly subnetId?: string;
    readonly internetGatewayId?: string;
    readonly routeTableId?: string;
    readonly routeTableAssociationId?: string;
  }): Promise<void> {
    if (resources.associationId) {
      await bestEffortSend(this.client, new DisassociateAddressCommand({ AssociationId: resources.associationId }));
    }
    if (resources.allocationId) {
      await bestEffortSend(this.client, new ReleaseAddressCommand({ AllocationId: resources.allocationId }));
    }
    if (resources.instanceId) {
      await bestEffortSend(this.client, new TerminateInstancesCommand({ InstanceIds: [resources.instanceId] }));
      await this.waiters.terminated(this.client, resources.instanceId).catch(() => undefined);
    }
    if (resources.keyPairId) {
      await bestEffortSend(this.client, new DeleteKeyPairCommand({ KeyPairId: resources.keyPairId }));
    }
    if (resources.securityGroupId) {
      await bestEffortSend(this.client, new DeleteSecurityGroupCommand({ GroupId: resources.securityGroupId }));
    }
    let routeTableAssociationId = resources.routeTableAssociationId;
    if (!routeTableAssociationId && resources.routeTableId && resources.subnetId) {
      const response = await bestEffortSendResult<DescribeRouteTablesCommandOutput>(
        this.client,
        new DescribeRouteTablesCommand({ RouteTableIds: [resources.routeTableId] }),
      );
      routeTableAssociationId = response?.RouteTables?.[0]?.Associations
        ?.find((association) => association.SubnetId === resources.subnetId)?.RouteTableAssociationId;
    }
    if (routeTableAssociationId) {
      await bestEffortSend(
        this.client,
        new DisassociateRouteTableCommand({ AssociationId: routeTableAssociationId }),
      );
    }
    if (resources.routeTableId) {
      await bestEffortSend(
        this.client,
        new DeleteRouteCommand({ RouteTableId: resources.routeTableId, DestinationCidrBlock: "0.0.0.0/0" }),
      );
      await bestEffortSend(this.client, new DeleteRouteTableCommand({ RouteTableId: resources.routeTableId }));
    }
    if (resources.subnetId) {
      await bestEffortSend(this.client, new DeleteSubnetCommand({ SubnetId: resources.subnetId }));
    }
    if (resources.internetGatewayId && resources.vpcId) {
      await bestEffortSend(this.client, new DetachInternetGatewayCommand({
        InternetGatewayId: resources.internetGatewayId,
        VpcId: resources.vpcId,
      }));
    }
    if (resources.internetGatewayId) {
      await bestEffortSend(
        this.client,
        new DeleteInternetGatewayCommand({ InternetGatewayId: resources.internetGatewayId }),
      );
    }
    if (resources.vpcId) {
      await bestEffortSend(this.client, new DeleteVpcCommand({ VpcId: resources.vpcId }));
    }
  }
}

const defaultClientFactory: AwsEc2ClientFactory = ({ region, credentials }) => new EC2Client({
  region,
  credentials,
}) as unknown as AwsEc2ClientLike;

const defaultWaiters: AwsEc2Waiters = {
  running: async (client, instanceId) => {
    await waitUntilInstanceRunning(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { InstanceIds: [instanceId] },
    );
  },
  instanceStatusOk: async (client, instanceId) => {
    await waitUntilInstanceStatusOk(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { InstanceIds: [instanceId], IncludeAllInstances: true },
    );
  },
  systemStatusOk: async (client, instanceId) => {
    await waitUntilSystemStatusOk(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { InstanceIds: [instanceId], IncludeAllInstances: true },
    );
  },
  stopped: async (client, instanceId) => {
    await waitUntilInstanceStopped(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { InstanceIds: [instanceId] },
    );
  },
  terminated: async (client, instanceId) => {
    await waitUntilInstanceTerminated(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { InstanceIds: [instanceId] },
    );
  },
  subnetAvailable: async (client, subnetId) => {
    await waitUntilSubnetAvailable(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { SubnetIds: [subnetId] },
    );
  },
  vpcAvailable: async (client, vpcId) => {
    await waitUntilVpcAvailable(
      { client: client as EC2Client, maxWaitTime: DEFAULT_WAITER_SECONDS },
      { VpcIds: [vpcId] },
    );
  },
};

function validateCredentials(credentials: AwsEc2Credentials): AwsEc2Credentials {
  const accessKeyId = validateSecretField(credentials.accessKeyId, "AWS access key ID", 16, 256);
  const secretAccessKey = validateSecretField(credentials.secretAccessKey, "AWS secret access key", 16, 4_096);
  const sessionToken = credentials.sessionToken === undefined
    ? undefined
    : validateSecretField(credentials.sessionToken, "AWS session token", 1, 16_384);
  const expiration = credentials.expiration === undefined
    ? undefined
    : validateCredentialExpiration(credentials.expiration);
  const credentialScope = credentials.credentialScope === undefined
    ? undefined
    : validateSecretField(credentials.credentialScope, "AWS credential scope", 1, 2_048);
  const accountId = credentials.accountId === undefined
    ? undefined
    : validateSecretField(credentials.accountId, "AWS account ID", 1, 256);
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(expiration ? { expiration } : {}),
    ...(credentialScope ? { credentialScope } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function validateCredentialSource(credentials: AwsEc2CredentialSource): AwsEc2CredentialSource {
  if (typeof credentials !== "function") return validateCredentials(credentials);
  return async () => validateCredentials(await credentials());
}

function validateSecretField(value: string, label: string, minimum: number, maximum: number): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < minimum || value.length > maximum) {
    throw new AwsEc2ProviderError(`${label} is invalid.`);
  }
  if (/\p{Cc}/u.test(value)) throw new AwsEc2ProviderError(`${label} is invalid.`);
  return value;
}

function validateCredentialExpiration(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new AwsEc2ProviderError("AWS credential expiration is invalid.");
  }
  return new Date(value.getTime());
}

function validateRegion(value: string): string {
  if (!isAwsRegion(value)) throw new AwsEc2ProviderError("The AWS region is invalid.");
  return value;
}

function validateDiscoveryInput(input: AwsEc2DiscoveryInput): void {
  if (input.vpcId !== undefined && !/^vpc-[0-9a-f]+$/u.test(input.vpcId)) {
    throw new AwsEc2ProviderError("The AWS VPC ID is invalid.");
  }
  if (input.imageIds) {
    if (input.imageIds.length < 1 || input.imageIds.length > 100) {
      throw new AwsEc2ProviderError("Image discovery accepts between 1 and 100 image IDs.");
    }
    for (const id of input.imageIds) requireAwsId(id, "image", AWS_ID_PATTERNS.image);
  }
  if (input.imageOwners?.some((owner) => !/^(?:self|amazon|aws-marketplace|[0-9]{12})$/u.test(owner))) {
    throw new AwsEc2ProviderError("An EC2 image owner is invalid.");
  }
  if (input.imageNamePattern !== undefined && (
    input.imageNamePattern.length < 1 ||
    input.imageNamePattern.length > 128 ||
    /[^A-Za-z0-9._*?()\-/: ]/u.test(input.imageNamePattern)
  )) {
    throw new AwsEc2ProviderError("The EC2 image name filter is invalid.");
  }
}

function buildImageDiscoveryRequests(input: AwsEc2DiscoveryInput, region: string) {
  if (input.imageIds) return [{ ImageIds: [...input.imageIds] }];
  if (input.imageOwners || input.imageNamePattern || input.architecture) {
    return [buildFilteredImageDiscoveryRequest(input)];
  }
  const sharedFilters = [
    { Name: "state", Values: ["available"] },
    { Name: "image-type", Values: ["machine"] },
    { Name: "root-device-type", Values: ["ebs"] },
    { Name: "virtualization-type", Values: ["hvm"] },
  ];
  return [
    {
      Owners: [canonicalOwnerForRegion(region)],
      Filters: [
        ...sharedFilters,
        {
          Name: "name",
          Values: [
            "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
            "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*",
          ],
        },
      ],
    },
    {
      Owners: ["amazon"],
      Filters: [
        ...sharedFilters,
        {
          Name: "name",
          Values: [
            "al2023-ami-2023.*-kernel-6.1-x86_64",
            "al2023-ami-2023.*-kernel-6.1-arm64",
          ],
        },
      ],
    },
  ];
}

function buildFilteredImageDiscoveryRequest(input: AwsEc2DiscoveryInput) {
  const filters = [
    { Name: "state", Values: ["available"] },
    { Name: "root-device-type", Values: ["ebs"] },
    ...(input.imageNamePattern ? [{ Name: "name", Values: [input.imageNamePattern] }] : []),
    ...(input.architecture ? [{ Name: "architecture", Values: [input.architecture] }] : []),
  ];
  return {
    Owners: input.imageOwners ? [...input.imageOwners] : ["amazon"],
    Filters: filters,
  };
}

function isRecommendedImageDiscovery(input: AwsEc2DiscoveryInput): boolean {
  return input.imageIds === undefined &&
    input.imageOwners === undefined &&
    input.imageNamePattern === undefined &&
    input.architecture === undefined;
}

function canonicalOwnerForRegion(region: string): string {
  if (region.startsWith("cn-")) return "837727238323";
  if (region.startsWith("us-gov-")) return "513442679011";
  return "099720109477";
}

type ValidatedAwsEc2CreateInput = Omit<AwsEc2CreateInput, "network" | "sshKeyPair"> & {
  readonly network: AwsEc2NetworkInput;
  readonly sshKeyPair: AwsEc2SshKeyPairInput;
};

function validateCreateInput(input: AwsEc2CreateInput): ValidatedAwsEc2CreateInput {
  const guid = validateGuid(input.guid);
  const name = validateName(input.name);
  const imageId = requireAwsId(input.imageId, "image", AWS_ID_PATTERNS.image);
  const network = validateNetworkInput(input.network);
  const sshKeyPair = validateSshKeyPairInput(input.sshKeyPair);
  if (!isSupportedAwsInstanceType(input.instanceType)) {
    throw new AwsEc2ProviderError("The EC2 instance type is not supported.");
  }
  const sshPublicKey = validateSshPublicKey(input.sshPublicKey);
  if (input.userData !== undefined && Buffer.byteLength(input.userData, "utf8") > MAX_USER_DATA_BYTES) {
    throw new AwsEc2ProviderError("EC2 user data exceeds the 16 KiB limit.");
  }
  if (input.rootVolumeSizeGiB !== undefined && (
    !Number.isSafeInteger(input.rootVolumeSizeGiB) ||
    input.rootVolumeSizeGiB < 8 ||
    input.rootVolumeSizeGiB > 16_384
  )) {
    throw new AwsEc2ProviderError("The EC2 root volume size is invalid.");
  }
  if (input.rootVolumeKmsKeyId !== undefined && (
    input.rootVolumeKmsKeyId.length < 1 || input.rootVolumeKmsKeyId.length > 2_048 || /\p{Cc}/u.test(input.rootVolumeKmsKeyId)
  )) {
    throw new AwsEc2ProviderError("The EBS KMS key identifier is invalid.");
  }
  return {
    ...input,
    guid,
    name,
    imageId,
    network,
    sshKeyPair,
    sshPublicKey,
    firewall: validateFirewall(input.firewall),
  };
}

function validateNetworkInput(
  value: AwsEc2NetworkInput | undefined,
): AwsEc2NetworkInput {
  if (value === undefined) {
    throw new AwsEc2ProviderError("Select both an EC2 VPC and subnet.");
  }
  if (value.mode === "existing") {
    const vpcId = requireAwsId(value.vpcId, "VPC", AWS_ID_PATTERNS.vpc);
    const subnetId = requireAwsId(value.subnetId, "subnet", AWS_ID_PATTERNS.subnet);
    return { mode: "existing", vpcId, subnetId };
  }
  if (value.mode !== "managed") {
    throw new AwsEc2ProviderError("The EC2 network selection is invalid.");
  }
  const vpcCidrBlock = validateManagedIpv4Cidr(value.vpcCidrBlock, "VPC");
  const subnetCidrBlock = validateManagedIpv4Cidr(value.subnetCidrBlock, "subnet");
  if (!ipv4CidrContains(vpcCidrBlock, subnetCidrBlock)) {
    throw new AwsEc2ProviderError("The managed subnet CIDR must be contained by the managed VPC CIDR.");
  }
  return { mode: "managed", vpcCidrBlock, subnetCidrBlock };
}

function supportedInstanceArchitecture(instanceType: string): AwsEc2Architecture | undefined {
  if (!isSupportedAwsInstanceType(instanceType)) return undefined;
  return INSTANCE_TYPE_FALLBACKS[instanceType].architecture;
}

function validateSshKeyPairInput(value: AwsEc2SshKeyPairInput | undefined): AwsEc2SshKeyPairInput {
  if (value === undefined || value.mode === "managed") return { mode: "managed" };
  if (value.mode !== "existing") throw new AwsEc2ProviderError("The EC2 SSH key pair selection is invalid.");
  return { mode: "existing", name: validateKeyPairName(value.name) };
}

function validateKeyPairName(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 255 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AwsEc2ProviderError("The EC2 SSH key pair name is invalid.");
  }
  return value;
}

function validateManagedIpv4Cidr(value: string, label: string): string {
  if (typeof value !== "string") throw new AwsEc2ProviderError(`The managed ${label} CIDR is invalid.`);
  const separator = value.lastIndexOf("/");
  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const numeric = ipv4AddressNumber(address);
  if (numeric === undefined || !Number.isInteger(prefix) || prefix < 16 || prefix > 28) {
    throw new AwsEc2ProviderError(`The managed ${label} CIDR is invalid.`);
  }
  const mask = (0xffff_ffff << (32 - prefix)) >>> 0;
  if ((numeric & mask) !== numeric) {
    throw new AwsEc2ProviderError(`The managed ${label} CIDR must use its canonical network address.`);
  }
  return value;
}

function ipv4CidrContains(parent: string, child: string): boolean {
  const parentPrefix = Number(parent.slice(parent.lastIndexOf("/") + 1));
  const childPrefix = Number(child.slice(child.lastIndexOf("/") + 1));
  const parentAddress = ipv4AddressNumber(parent.slice(0, parent.lastIndexOf("/")))!;
  const childAddress = ipv4AddressNumber(child.slice(0, child.lastIndexOf("/")))!;
  const mask = (0xffff_ffff << (32 - parentPrefix)) >>> 0;
  return childPrefix >= parentPrefix && (parentAddress & mask) === (childAddress & mask);
}

function ipv4AddressNumber(value: string): number | undefined {
  if (isIP(value) !== 4) return undefined;
  return value.split(".").reduce((result, octet) => ((result << 8) | Number(octet)) >>> 0, 0);
}

function validateGuid(value: string): string {
  if (!UUID_PATTERN.test(value)) throw new AwsEc2ProviderError("The deployment GUID is invalid.");
  return value.toLowerCase();
}

function validateName(value: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 128 || /\p{Cc}/u.test(value)) {
    throw new AwsEc2ProviderError("The deployment name is invalid.");
  }
  return value;
}

function validateSshPublicKey(value: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    Buffer.byteLength(value, "utf8") > MAX_PUBLIC_KEY_BYTES ||
    !/^ssh-(?:ed25519|rsa) [A-Za-z0-9+/]+={0,3}(?: [^\r\n\p{Cc}]{1,255})?$/u.test(value)
  ) {
    throw new AwsEc2ProviderError("AWS EC2 requires an OpenSSH RSA or ED25519 public key.");
  }
  return value;
}

function managedKeyPairName(guid: string): string {
  return `sliver-gui-${guid}`;
}

function validateFirewall(input: AwsEc2FirewallInput): AwsEc2FirewallInput {
  const sshPort = validatePort(input.sshPort, "SSH");
  const multiplayerPort = validatePort(input.multiplayerPort, "multiplayer");
  return {
    sshPort,
    sshSourceCidrs: validateCidrs(input.sshSourceCidrs, "SSH"),
    multiplayerPort,
    multiplayerSourceCidrs: validateCidrs(input.multiplayerSourceCidrs, "multiplayer"),
  };
}

function validatePort(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new AwsEc2ProviderError(`The ${label} TCP port is invalid.`);
  }
  return value;
}

function validateCidrs(values: readonly string[], label: string): readonly string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_CIDRS_PER_SERVICE) {
    throw new AwsEc2ProviderError(`${label} access requires between 1 and ${MAX_CIDRS_PER_SERVICE} explicit CIDRs.`);
  }
  const unique = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() !== value) {
      throw new AwsEc2ProviderError(`An ${label} source CIDR is invalid.`);
    }
    const slash = value.lastIndexOf("/");
    const address = slash > 0 ? value.slice(0, slash) : "";
    const prefixText = slash > 0 ? value.slice(slash + 1) : "";
    const family = isIP(address);
    const prefix = /^\d{1,3}$/u.test(prefixText) ? Number(prefixText) : -1;
    const maximum = family === 4 ? 32 : family === 6 ? 128 : -1;
    if (maximum < 0 || prefix <= 0 || prefix > maximum) {
      throw new AwsEc2ProviderError(
        `An ${label} source CIDR is invalid; internet-wide /0 access is never created automatically.`,
      );
    }
    unique.add(value);
  }
  return [...unique];
}

function firewallPermissions(input: AwsEc2FirewallInput, guid: string): IpPermission[] {
  return [
    permissionForCidrs(input.sshPort, input.sshSourceCidrs, `sliver-gui:${guid}:ssh`),
    permissionForCidrs(input.multiplayerPort, input.multiplayerSourceCidrs, `sliver-gui:${guid}:multiplayer`),
  ];
}

function permissionForCidrs(port: number, cidrs: readonly string[], description: string): IpPermission {
  const ipv4 = cidrs.filter((cidr) => isIP(cidr.slice(0, cidr.lastIndexOf("/"))) === 4);
  const ipv6 = cidrs.filter((cidr) => isIP(cidr.slice(0, cidr.lastIndexOf("/"))) === 6);
  return {
    IpProtocol: "tcp",
    FromPort: port,
    ToPort: port,
    ...(ipv4.length > 0 ? { IpRanges: ipv4.map((CidrIp) => ({ CidrIp, Description: description })) } : {}),
    ...(ipv6.length > 0 ? { Ipv6Ranges: ipv6.map((CidrIpv6) => ({ CidrIpv6, Description: description })) } : {}),
  };
}

function managedTags(guid: string, name: string): Tag[] {
  return [
    { Key: MANAGED_TAG_KEY, Value: MANAGED_TAG_VALUE },
    { Key: GUID_TAG_KEY, Value: guid },
    { Key: NAME_TAG_KEY, Value: name },
  ];
}

function launchTagSpecifications(tags: Tag[]): TagSpecification[] {
  return (["instance", "volume", "network-interface"] as const)
    .map((ResourceType) => ({ ResourceType, Tags: tags }));
}

function tagValue(tags: readonly Tag[] | undefined, key: string): string | undefined {
  return tags?.find((tag) => tag.Key === key)?.Value;
}

function hasManagedTags(tags: readonly Tag[] | undefined, guid: string): boolean {
  return tagValue(tags, MANAGED_TAG_KEY) === MANAGED_TAG_VALUE && tagValue(tags, GUID_TAG_KEY) === guid;
}

function assertManagedTags(tags: readonly Tag[] | undefined, guid: string, kind: string): void {
  if (!hasManagedTags(tags, guid)) {
    throw new AwsEc2ProviderError(`Refusing to modify the ${kind}: its Sliver GUI ownership tags do not match.`);
  }
}

function requireAwsId(value: string | undefined, label: string, pattern: RegExp): string {
  if (!value || !pattern.test(value)) throw new AwsEc2ProviderError(`The AWS ${label} ID is invalid.`);
  return value;
}

function validateTrackedAwsIds(
  values: readonly string[],
  label: string,
  pattern: RegExp,
  maximum: number,
): void {
  if (!Array.isArray(values) || values.length > maximum || new Set(values).size !== values.length) {
    throw new AwsEc2ProviderError(`The tracked AWS ${label} IDs are invalid.`);
  }
  for (const value of values) requireAwsId(value, label, pattern);
}

function requireNonEmpty(value: string | undefined, errorMessage: string): string {
  if (!value) throw new AwsEc2ProviderError(errorMessage);
  return value;
}

function requireIpAddress(value: string | undefined, errorMessage: string, family?: 4 | 6): string {
  const actualFamily = value ? isIP(value) : 0;
  if (actualFamily === 0 || (family !== undefined && actualFamily !== family)) {
    throw new AwsEc2ProviderError(errorMessage);
  }
  return value!;
}

function optionalIpAddress(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requireIpAddress(value, `AWS EC2 returned an invalid ${label}.`);
}

function normalizeInstanceState(value: string | undefined): AwsEc2InstanceState {
  switch (value) {
    case "pending":
    case "running":
    case "shutting-down":
    case "terminated":
    case "stopping":
    case "stopped":
      return value;
    default:
      return "unknown";
  }
}

function normalizeHealth(value: string | undefined): AwsEc2Health {
  switch (value) {
    case "ok":
    case "impaired":
    case "initializing":
      return value;
    default:
      return "unknown";
  }
}

const INSTANCE_TYPE_FALLBACKS: Readonly<Record<
  (typeof AWS_EC2_DEFAULT_INSTANCE_TYPES)[number],
  { readonly architecture: AwsEc2Architecture; readonly vCpuCount: number; readonly memoryMiB: number; readonly processor: string }
>> = {
  "t3.micro": { architecture: "x86_64", vCpuCount: 2, memoryMiB: 1_024, processor: "Intel x86-64" },
  "t3.small": { architecture: "x86_64", vCpuCount: 2, memoryMiB: 2_048, processor: "Intel x86-64" },
  "t3.medium": { architecture: "x86_64", vCpuCount: 2, memoryMiB: 4_096, processor: "Intel x86-64" },
  "t3.large": { architecture: "x86_64", vCpuCount: 2, memoryMiB: 8_192, processor: "Intel x86-64" },
  "t3.xlarge": { architecture: "x86_64", vCpuCount: 4, memoryMiB: 16_384, processor: "Intel x86-64" },
  "t4g.micro": { architecture: "arm64", vCpuCount: 2, memoryMiB: 1_024, processor: "AWS Graviton2 Arm" },
  "t4g.small": { architecture: "arm64", vCpuCount: 2, memoryMiB: 2_048, processor: "AWS Graviton2 Arm" },
  "t4g.medium": { architecture: "arm64", vCpuCount: 2, memoryMiB: 4_096, processor: "AWS Graviton2 Arm" },
  "t4g.large": { architecture: "arm64", vCpuCount: 2, memoryMiB: 8_192, processor: "AWS Graviton2 Arm" },
  "t4g.xlarge": { architecture: "arm64", vCpuCount: 4, memoryMiB: 16_384, processor: "AWS Graviton2 Arm" },
};

function normalizeInstanceTypeOptions(
  values: readonly InstanceTypeInfo[] | undefined,
): AwsEc2InstanceTypeOption[] {
  const byName = new Map((values ?? []).flatMap((value) => {
    const name = value.InstanceType;
    return name && AWS_EC2_DEFAULT_INSTANCE_TYPES.includes(
      name as (typeof AWS_EC2_DEFAULT_INSTANCE_TYPES)[number],
    ) ? [[name, value] as const] : [];
  }));

  return AWS_EC2_DEFAULT_INSTANCE_TYPES.flatMap((name) => {
    const value = byName.get(name);
    if (!value || value.SupportedInRegion === false) return [];
    const fallback = INSTANCE_TYPE_FALLBACKS[name];
    const architectures = value.ProcessorInfo?.SupportedArchitectures;
    if (architectures && !architectures.includes(fallback.architecture)) return [];
    const vCpuCount = positiveInteger(value.VCpuInfo?.DefaultVCpus) ?? fallback.vCpuCount;
    const memoryMiB = positiveInteger(value.MemoryInfo?.SizeInMiB) ?? fallback.memoryMiB;
    return [{
      name,
      architecture: fallback.architecture,
      vCpuCount,
      memoryMiB,
      processor: fallback.processor,
      description: `${vCpuCount} vCPU · ${formatMemory(memoryMiB)} RAM · ${fallback.processor}`,
    }];
  });
}

function positiveInteger(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}

function formatMemory(memoryMiB: number): string {
  return memoryMiB % 1_024 === 0 ? `${memoryMiB / 1_024} GiB` : `${memoryMiB} MiB`;
}

function normalizeImageOptions(
  values: readonly Image[],
  latestRecommendedOnly: boolean,
  canonicalOwnerId: string,
): AwsEc2ImageOption[] {
  const unique = new Map<string, AwsEc2ImageOption>();
  for (const value of values) {
    if (!value.ImageId || !AWS_ID_PATTERNS.image.test(value.ImageId) || unique.has(value.ImageId)) continue;
    unique.set(value.ImageId, normalizeImageOption(value, canonicalOwnerId));
  }
  const options = [...unique.values()];
  if (!latestRecommendedOnly) return options.sort(compareNamedIds);

  const latest = new Map<string, AwsEc2ImageOption>();
  for (const option of options) {
    if (!option.distribution || !isSupportedArchitecture(option.architecture)) continue;
    const key = `${option.distribution}:${option.architecture}`;
    const current = latest.get(key);
    if (!current || compareNewestImage(option, current) < 0) latest.set(key, option);
  }
  const order = [
    "ubuntu:x86_64",
    "ubuntu:arm64",
    "amazon-linux:x86_64",
    "amazon-linux:arm64",
  ];
  return order.flatMap((key) => {
    const option = latest.get(key);
    return option ? [option] : [];
  });
}

function normalizeImageOption(value: Image, canonicalOwnerId: string): AwsEc2ImageOption {
  const name = value.Name;
  const ubuntuMatch = value.OwnerId === canonicalOwnerId
    ? /^ubuntu\/images\/hvm-ssd-gp3\/ubuntu-noble-24\.04-(amd64|arm64)-server-/u.exec(name ?? "")
    : null;
  const amazonLinuxMatch = value.ImageOwnerAlias === "amazon"
    ? /^al2023-ami-2023(?:\.[0-9]+)+-kernel-6\.1-(x86_64|arm64)$/u.exec(name ?? "")
    : null;
  const distribution = ubuntuMatch ? "ubuntu" : amazonLinuxMatch ? "amazon-linux" : undefined;
  const nameArchitecture = ubuntuMatch?.[1] === "amd64"
    ? "x86_64"
    : ubuntuMatch?.[1] ?? amazonLinuxMatch?.[1];
  const architecture = isSupportedArchitecture(nameArchitecture)
    ? nameArchitecture
    : value.Architecture;
  const creationDate = validIsoDate(value.CreationDate);
  return {
    id: value.ImageId!,
    ...optionalString("name", name),
    ...optionalString("description", value.Description),
    ...optionalString("architecture", architecture),
    ...optionalString("rootDeviceName", value.RootDeviceName),
    ...(distribution ? { distribution } : {}),
    ...(distribution === "ubuntu" ? { version: "24.04 LTS", sshUsername: "ubuntu" } : {}),
    ...(distribution === "amazon-linux" ? { version: "2023", sshUsername: "ec2-user" } : {}),
    ...optionalString("creationDate", creationDate),
  };
}

function isSupportedArchitecture(value: string | undefined): value is AwsEc2Architecture {
  return value === "x86_64" || value === "arm64";
}

function validIsoDate(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 64 || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function compareNewestImage(left: AwsEc2ImageOption, right: AwsEc2ImageOption): number {
  const byDate = (right.creationDate ?? "").localeCompare(left.creationDate ?? "");
  return byDate || left.id.localeCompare(right.id);
}

function uniqueById<Value extends { readonly id: string }>(values: readonly Value[]): Value[] {
  const unique = new Map<string, Value>();
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value);
  }
  return [...unique.values()];
}

function validatePaginationToken(value: unknown, operation: string): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_PAGINATION_TOKEN_LENGTH ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AwsEc2ProviderError(`AWS EC2 returned an invalid pagination token while attempting to ${operation}.`);
  }
  return value;
}

function optionalString<Key extends string>(key: Key, value: string | undefined): { [Property in Key]?: string } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: string };
}

function optionalNumber<Key extends string>(key: Key, value: number | undefined): { [Property in Key]?: number } {
  return value === undefined ? {} : { [key]: value } as { [Property in Key]?: number };
}

function compareNamedIds(
  left: { readonly id: string; readonly name?: string },
  right: { readonly id: string; readonly name?: string },
): number {
  return (left.name ?? left.id).localeCompare(right.name ?? right.id);
}

function sanitizeAwsError(operation: string, error: unknown): AwsEc2ProviderError {
  if (error instanceof AwsEc2ProviderError) return error;
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : undefined;
  const rawCode = record?.["name"] ?? record?.["Code"] ?? record?.["code"];
  const code = typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,80}$/u.test(rawCode) ? rawCode : undefined;
  const metadata = record?.["$metadata"];
  const rawStatus = typeof metadata === "object" && metadata !== null
    ? (metadata as Record<string, unknown>)["httpStatusCode"]
    : undefined;
  const status = typeof rawStatus === "number" && Number.isInteger(rawStatus) ? rawStatus : undefined;
  const details = [code, status === undefined ? undefined : `HTTP ${status}`].filter(Boolean).join(", ");
  return new AwsEc2ProviderError(`AWS EC2 could not ${operation}${details ? ` (${details})` : ""}.`);
}

function hasAwsErrorCode(error: unknown, expectedCodes: readonly string[]): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  const code = record["name"] ?? record["Code"] ?? record["code"];
  return typeof code === "string" && expectedCodes.includes(code);
}

async function bestEffortSend(client: AwsEc2ClientLike, command: unknown): Promise<void> {
  await client.send(command).then(() => undefined, () => undefined);
}

async function bestEffortSendResult<T>(client: AwsEc2ClientLike, command: unknown): Promise<T | undefined> {
  return await client.send(command).then((value) => value as T, () => undefined);
}

async function notifyCreateMutation(
  listener: AwsEc2CreateMutationListener | undefined,
  phase: AwsEc2CreateMutationEvent["phase"],
  resources: AwsEc2CreateMutationResources,
): Promise<void> {
  if (!listener) return;
  await listener(Object.freeze({ phase, resources: Object.freeze(resources) }));
}
