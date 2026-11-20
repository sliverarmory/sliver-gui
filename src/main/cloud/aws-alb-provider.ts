import {
  AssociateRouteTableCommand,
  AuthorizeSecurityGroupEgressCommand,
  AuthorizeSecurityGroupIngressCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupRulesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  DisassociateRouteTableCommand,
  EC2Client,
  RevokeSecurityGroupEgressCommand,
  RevokeSecurityGroupIngressCommand,
  waitUntilSubnetAvailable,
  type IpPermission,
} from "@aws-sdk/client-ec2";
import {
  CreateListenerCommand,
  CreateLoadBalancerCommand,
  CreateTargetGroupCommand,
  DeleteListenerCommand,
  DeleteLoadBalancerCommand,
  DeleteTargetGroupCommand,
  DescribeListenersCommand,
  DescribeLoadBalancersCommand,
  DescribeTagsCommand,
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  RegisterTargetsCommand,
  waitUntilLoadBalancerAvailable,
  waitUntilLoadBalancersDeleted,
  waitUntilTargetInService,
} from "@aws-sdk/client-elastic-load-balancing-v2";
import { isAwsRegion } from "../../shared/cloud-deployment-contracts.js";
import type { AwsEc2ProviderConnection } from "./aws-ec2-provider.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EC2_ID = {
  instance: /^i-[0-9a-f]{8,17}$/u,
  vpc: /^vpc-[0-9a-f]{8,17}$/u,
  subnet: /^subnet-[0-9a-f]{8,17}$/u,
  securityGroup: /^sg-[0-9a-f]{8,17}$/u,
  rule: /^sgr-[0-9a-f]{8,17}$/u,
  routeTable: /^rtb-[0-9a-f]{8,17}$/u,
  routeTableAssociation: /^rtbassoc-[0-9a-f]{8,17}$/u,
  internetGateway: /^igw-[0-9a-f]{8,17}$/u,
};
const RESOURCE_ARN = /^arn:(aws|aws-us-gov|aws-cn):elasticloadbalancing:([a-z0-9-]+):([0-9]{12}):(loadbalancer\/app|targetgroup|listener\/app)\/[A-Za-z0-9/-]+$/u;
const MANAGED_TAG = "SliverGUIManaged";
const GUID_TAG = "SliverGUID";
const NAME_TAG = "Name";
const TYPE_TAG = "SliverGUIDeploymentType";
const TYPE_VALUE = "alb-redirector";
const REQUEST_TIMEOUT_MS = 60_000;
const WAIT_SECONDS = 300;

export interface AwsAlbClientLike {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
  destroy?(): void;
}

export interface AwsAlbProviderDependencies {
  readonly ec2ClientFactory?: (connection: AwsEc2ProviderConnection) => AwsAlbClientLike;
  readonly elbClientFactory?: (connection: AwsEc2ProviderConnection) => AwsAlbClientLike;
  readonly waiters?: AwsAlbWaiters;
}

export interface AwsAlbWaiters {
  readonly subnetAvailable: (client: AwsAlbClientLike, id: string) => Promise<void>;
  readonly loadBalancerAvailable: (client: AwsAlbClientLike, arn: string) => Promise<void>;
  readonly targetHealthy: (client: AwsAlbClientLike, targetGroupArn: string, instanceId: string, port: number) => Promise<void>;
  readonly loadBalancerDeleted: (client: AwsAlbClientLike, arn: string) => Promise<void>;
}

export interface AwsAlbAdditionalSubnetInput {
  /** A free IPv4 subnet CIDR inside the existing server VPC. */
  readonly cidrBlock: string;
  /** An available AZ different from the selected existing subnet's AZ. */
  readonly availabilityZone: string;
  /** The server's existing public route table, reused for this subnet. */
  readonly routeTableId: string;
}

export interface AwsAlbNetworkOptions {
  readonly publicSubnets: readonly { readonly id: string; readonly availabilityZone: string }[];
  readonly suggestedAdditionalSubnet: AwsAlbAdditionalSubnetInput | null;
}

export interface AwsAlbRedirectorCreateInput {
  readonly guid: string;
  readonly name: string;
  readonly serverGuid: string;
  readonly serverInstanceId: string;
  readonly serverSecurityGroupId: string;
  readonly vpcId: string;
  /** Two existing public subnets, or one when additionalSubnet is provided. */
  readonly subnetIds: readonly [string] | readonly [string, string];
  readonly additionalSubnet?: AwsAlbAdditionalSubnetInput;
  readonly certificateArn: string;
  readonly backendPort: number;
  readonly healthCheckPath?: string;
  /** ALB HTTP matcher; defaults to the 404 normally returned by an unmatched Sliver path. */
  readonly healthCheckSuccessCodes?: string;
}

export interface AwsAlbRedirectorMutationResources {
  readonly additionalSubnetId?: string;
  readonly additionalRouteTableAssociationId?: string;
  readonly securityGroupId?: string;
  readonly albIngressRuleId?: string;
  readonly albEgressRuleId?: string;
  readonly serverIngressRuleId?: string;
  readonly targetGroupArn?: string;
  readonly loadBalancerArn?: string;
  readonly canonicalHostedZoneId?: string;
  readonly listenerArn?: string;
}

export interface AwsAlbRedirectorMutationEvent {
  readonly phase: "subnet" | "subnet-route" | "security-group" | "firewall" | "target-group" | "load-balancer" | "listener" | "healthy";
  readonly resources: AwsAlbRedirectorMutationResources;
}

export type AwsAlbRedirectorMutationListener = (event: AwsAlbRedirectorMutationEvent) => void | Promise<void>;

export interface AwsAlbRedirectorDestroyResource extends AwsAlbRedirectorMutationResources {
  readonly guid: string;
  readonly name: string;
  readonly region: string;
  readonly serverGuid: string;
  readonly serverInstanceId: string;
  readonly serverSecurityGroupId: string;
  readonly vpcId: string;
  readonly subnetIds: readonly string[];
  readonly additionalRouteTableId?: string;
  readonly certificateArn: string;
  readonly backendPort: number;
  readonly healthCheckPath: string;
  readonly healthCheckSuccessCodes: string;
}

export interface AwsAlbRedirectorResource extends AwsAlbRedirectorDestroyResource {
  readonly securityGroupId: string;
  readonly albIngressRuleId: string;
  readonly albEgressRuleId: string;
  readonly serverIngressRuleId: string;
  readonly targetGroupArn: string;
  readonly loadBalancerArn: string;
  readonly listenerArn: string;
  readonly dnsName: string;
  readonly canonicalHostedZoneId: string;
}

export class AwsAlbProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsAlbProviderError";
  }
}

/**
 * AWS-only HTTPS redirector attached to a managed Sliver server in the same VPC.
 * All credentials are supplied explicitly by the caller; no default AWS chain is used.
 */
export class AwsAlbRedirectorProvider {
  private readonly region: string;
  private readonly ec2: AwsAlbClientLike;
  private readonly elb: AwsAlbClientLike;
  private readonly waiters: AwsAlbWaiters;

  constructor(connection: AwsEc2ProviderConnection, dependencies: AwsAlbProviderDependencies = {}) {
    if (!isAwsRegion(connection.region)) throw new AwsAlbProviderError("The AWS region is invalid.");
    this.region = connection.region;
    this.ec2 = (dependencies.ec2ClientFactory ?? ((value) => new EC2Client({ ...value, maxAttempts: 1 })))(connection);
    this.elb = (dependencies.elbClientFactory ?? ((value) => new ElasticLoadBalancingV2Client({ ...value, maxAttempts: 1 })))(connection);
    this.waiters = dependencies.waiters ?? defaultWaiters;
  }

  dispose(): void {
    this.ec2.destroy?.();
    this.elb.destroy?.();
  }

  async discoverNetworkOptions(input: {
    readonly vpcId: string;
    readonly serverSubnetId: string;
    readonly serverGuid: string;
  }): Promise<AwsAlbNetworkOptions> {
    requiredId(input.vpcId, EC2_ID.vpc, "VPC");
    requiredId(input.serverSubnetId, EC2_ID.subnet, "server subnet");
    requireUuid(input.serverGuid, "server deployment ID");
    const [vpcs, subnets, tables, gateways, zones] = await Promise.all([
      this.ec2Send<{ Vpcs?: { VpcId?: string; CidrBlock?: string }[] }>(new DescribeVpcsCommand({ VpcIds: [input.vpcId] })),
      this.ec2Send<{ Subnets?: { SubnetId?: string; VpcId?: string; AvailabilityZone?: string; CidrBlock?: string; AvailableIpAddressCount?: number; State?: string }[]; NextToken?: string }>(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [input.vpcId] }] })),
      this.ec2Send<{ RouteTables?: RouteTableLike[]; NextToken?: string }>(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [input.vpcId] }] })),
      this.ec2Send<{ InternetGateways?: { InternetGatewayId?: string; Attachments?: { VpcId?: string; State?: string }[] }[]; NextToken?: string }>(new DescribeInternetGatewaysCommand({ Filters: [{ Name: "attachment.vpc-id", Values: [input.vpcId] }] })),
      this.ec2Send<{ AvailabilityZones?: { ZoneName?: string; State?: string }[]; NextToken?: string }>(new DescribeAvailabilityZonesCommand({ Filters: [{ Name: "region-name", Values: [this.region] }] })),
    ]);
    if (subnets.NextToken || tables.NextToken || gateways.NextToken || zones.NextToken) throw new AwsAlbProviderError("AWS network inventory is incomplete; cannot choose an ALB subnet safely.");
    const vpc = vpcs.Vpcs?.find((value) => value.VpcId === input.vpcId);
    if (!vpc?.CidrBlock) throw new AwsAlbProviderError("The selected VPC has no primary IPv4 CIDR.");
    const allSubnets = (subnets.Subnets ?? []).filter((value) => value.VpcId === input.vpcId && value.SubnetId && value.AvailabilityZone && value.State === "available");
    const serverSubnet = allSubnets.find((value) => value.SubnetId === input.serverSubnetId);
    if (!serverSubnet) throw new AwsAlbProviderError("The selected server subnet is unavailable in its VPC.");
    const routeTables = (tables.RouteTables ?? []).filter((value) => value.VpcId === input.vpcId);
    const gatewayIds = new Set((gateways.InternetGateways ?? []).filter((value) => value.Attachments?.some((attachment) => attachment.VpcId === input.vpcId && attachment.State === "available")).map((value) => value.InternetGatewayId));
    const tableFor = (subnetId: string): RouteTableLike | undefined => routeTables.find((value) => value.Associations?.some((association) => association.SubnetId === subnetId)) ?? routeTables.find((value) => value.Associations?.some((association) => association.Main));
    const publicRoute = (table: RouteTableLike | undefined): boolean => !!table?.Routes?.some((route) => route.DestinationCidrBlock === "0.0.0.0/0" && route.State === "active" && gatewayIds.has(route.GatewayId));
    const publicSubnets = allSubnets.filter((subnet) => publicRoute(tableFor(subnet.SubnetId!)) && eligibleAlbSubnet(subnet)).map((subnet) => ({ id: subnet.SubnetId!, availabilityZone: subnet.AvailabilityZone! }));
    const alternateZone = (zones.AvailabilityZones ?? []).filter((zone) => zone.State === "available" && zone.ZoneName?.startsWith(this.region) && zone.ZoneName !== serverSubnet.AvailabilityZone).map((zone) => zone.ZoneName!).sort()[0];
    const serverTable = tableFor(input.serverSubnetId);
    const cidrBlock = findAvailableAlbSubnet(vpc.CidrBlock, (subnets.Subnets ?? []).map((subnet) => subnet.CidrBlock).filter((value): value is string => !!value));
    const suggestedAdditionalSubnet = alternateZone && cidrBlock && serverTable?.RouteTableId && publicRoute(serverTable) && eligibleAlbSubnet(serverSubnet) && hasTags(serverTable.Tags, input.serverGuid)
      ? { cidrBlock, availabilityZone: alternateZone, routeTableId: serverTable.RouteTableId }
      : null;
    return { publicSubnets, suggestedAdditionalSubnet };
  }

  async create(input: AwsAlbRedirectorCreateInput, onMutation?: AwsAlbRedirectorMutationListener): Promise<AwsAlbRedirectorResource> {
    const spec = validateCreateInput(input, this.region);
    const subnetIds = [...spec.subnetIds];
    const resources: MutableResources = {};
    const serverZone = await this.validateServer(spec);
    await this.validateSubnets(spec, subnetIds, serverZone);

    const notify = async (phase: AwsAlbRedirectorMutationEvent["phase"]): Promise<void> => {
      await onMutation?.({ phase, resources: { ...resources } });
    };
    try {
      if (spec.additionalSubnet) {
        const created = await this.ec2Send<{
          Subnet?: { SubnetId?: string };
        }>(new CreateSubnetCommand({
          VpcId: spec.vpcId,
          CidrBlock: spec.additionalSubnet.cidrBlock,
          AvailabilityZone: spec.additionalSubnet.availabilityZone,
          TagSpecifications: [{ ResourceType: "subnet", Tags: ownedTags(spec) }],
        }));
        resources.additionalSubnetId = requiredId(created.Subnet?.SubnetId, EC2_ID.subnet, "subnet");
        subnetIds.push(resources.additionalSubnetId);
        await notify("subnet");
        await this.waiters.subnetAvailable(this.ec2, resources.additionalSubnetId);
        const associated = await this.ec2Send<{ AssociationId?: string }>(new AssociateRouteTableCommand({
          RouteTableId: spec.additionalSubnet.routeTableId,
          SubnetId: resources.additionalSubnetId,
        }));
        resources.additionalRouteTableAssociationId = requiredId(associated.AssociationId, EC2_ID.routeTableAssociation, "route table association");
        await notify("subnet-route");
      }

      const group = await this.ec2Send<{ GroupId?: string }>(new CreateSecurityGroupCommand({
        VpcId: spec.vpcId,
        GroupName: `sliver-gui-alb-${spec.guid}`,
        Description: `Sliver GUI ALB redirector ${spec.guid}`,
        TagSpecifications: [{ ResourceType: "security-group", Tags: ownedTags(spec) }],
      }));
      resources.securityGroupId = requiredId(group.GroupId, EC2_ID.securityGroup, "ALB security group");
      await notify("security-group");

      const existingGroup = await this.ec2Send<{ SecurityGroups?: { IpPermissionsEgress?: unknown[] }[] }>(new DescribeSecurityGroupsCommand({
        GroupIds: [resources.securityGroupId],
      }));
      const defaultEgress = existingGroup.SecurityGroups?.[0]?.IpPermissionsEgress;
      if (defaultEgress?.length) {
        await this.ec2Send(new RevokeSecurityGroupEgressCommand({
          GroupId: resources.securityGroupId,
          IpPermissions: defaultEgress as IpPermission[],
        }));
      }
      const restrictedGroup = await this.ec2Send<{ SecurityGroups?: { IpPermissionsEgress?: unknown[] }[] }>(new DescribeSecurityGroupsCommand({
        GroupIds: [resources.securityGroupId],
      }));
      if (restrictedGroup.SecurityGroups?.[0]?.IpPermissionsEgress?.length) {
        throw new AwsAlbProviderError("The new ALB security group still has unrestricted outbound rules.");
      }
      const albIngress = await this.ec2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string }[] }>(new AuthorizeSecurityGroupIngressCommand({
        GroupId: resources.securityGroupId,
        IpPermissions: [{ IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: `sliver-gui:${spec.guid}:alb:https` }] }],
        TagSpecifications: [{ ResourceType: "security-group-rule", Tags: ownedTags(spec) }],
      }));
      resources.albIngressRuleId = requiredId(albIngress.SecurityGroupRules?.[0]?.SecurityGroupRuleId, EC2_ID.rule, "ALB ingress rule");
      await notify("firewall");
      const albEgress = await this.ec2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string }[] }>(new AuthorizeSecurityGroupEgressCommand({
        GroupId: resources.securityGroupId,
        IpPermissions: [{ IpProtocol: "tcp", FromPort: spec.backendPort, ToPort: spec.backendPort, UserIdGroupPairs: [{ GroupId: spec.serverSecurityGroupId, Description: `sliver-gui:${spec.guid}:alb:backend` }] }],
        TagSpecifications: [{ ResourceType: "security-group-rule", Tags: ownedTags(spec) }],
      }));
      resources.albEgressRuleId = requiredId(albEgress.SecurityGroupRules?.[0]?.SecurityGroupRuleId, EC2_ID.rule, "ALB egress rule");
      await notify("firewall");
      const serverIngress = await this.ec2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string }[] }>(new AuthorizeSecurityGroupIngressCommand({
        GroupId: spec.serverSecurityGroupId,
        IpPermissions: [{ IpProtocol: "tcp", FromPort: spec.backendPort, ToPort: spec.backendPort, UserIdGroupPairs: [{ GroupId: resources.securityGroupId, Description: `sliver-gui:${spec.guid}:alb:target` }] }],
        TagSpecifications: [{ ResourceType: "security-group-rule", Tags: ownedTags(spec) }],
      }));
      resources.serverIngressRuleId = requiredId(serverIngress.SecurityGroupRules?.[0]?.SecurityGroupRuleId, EC2_ID.rule, "server ingress rule");
      await notify("firewall");

      const targetGroup = await this.elbSend<{ TargetGroups?: { TargetGroupArn?: string }[] }>(new CreateTargetGroupCommand({
        Name: resourceName("sliver-gui-tg", spec.guid),
        Protocol: "HTTP",
        Port: spec.backendPort,
        VpcId: spec.vpcId,
        TargetType: "instance",
        HealthCheckEnabled: true,
        HealthCheckProtocol: "HTTP",
        HealthCheckPort: "traffic-port",
        HealthCheckPath: spec.healthCheckPath,
        Matcher: { HttpCode: spec.healthCheckSuccessCodes },
        Tags: ownedTags(spec),
      }));
      resources.targetGroupArn = requiredArn(targetGroup.TargetGroups?.[0]?.TargetGroupArn, this.region, "targetgroup");
      await notify("target-group");
      await this.elbSend(new RegisterTargetsCommand({
        TargetGroupArn: resources.targetGroupArn,
        Targets: [{ Id: spec.serverInstanceId, Port: spec.backendPort }],
      }));

      const loadBalancer = await this.elbSend<{
        LoadBalancers?: { LoadBalancerArn?: string; DNSName?: string; CanonicalHostedZoneId?: string }[];
      }>(new CreateLoadBalancerCommand({
        Name: resourceName("sliver-gui-alb", spec.guid),
        Type: "application",
        Scheme: "internet-facing",
        IpAddressType: "ipv4",
        Subnets: subnetIds,
        SecurityGroups: [resources.securityGroupId],
        Tags: ownedTags(spec),
      }));
      resources.loadBalancerArn = requiredArn(loadBalancer.LoadBalancers?.[0]?.LoadBalancerArn, this.region, "loadbalancer/app");
      const dnsName = requiredDns(loadBalancer.LoadBalancers?.[0]?.DNSName);
      resources.canonicalHostedZoneId = requiredHostedZoneId(loadBalancer.LoadBalancers?.[0]?.CanonicalHostedZoneId);
      await notify("load-balancer");
      await this.waiters.loadBalancerAvailable(this.elb, resources.loadBalancerArn);
      const listener = await this.elbSend<{ Listeners?: { ListenerArn?: string }[] }>(new CreateListenerCommand({
        LoadBalancerArn: resources.loadBalancerArn,
        Protocol: "HTTPS",
        Port: 443,
        Certificates: [{ CertificateArn: spec.certificateArn }],
        DefaultActions: [{ Type: "forward", TargetGroupArn: resources.targetGroupArn }],
      }));
      resources.listenerArn = requiredArn(listener.Listeners?.[0]?.ListenerArn, this.region, "listener/app");
      await notify("listener");
      await this.waiters.targetHealthy(this.elb, resources.targetGroupArn, spec.serverInstanceId, spec.backendPort);
      await notify("healthy");
      return {
        ...spec,
        region: this.region,
        subnetIds,
        ...(spec.additionalSubnet ? { additionalRouteTableId: spec.additionalSubnet.routeTableId } : {}),
        ...completeResources(resources),
        dnsName,
      };
    } catch (error) {
      const partial: AwsAlbRedirectorDestroyResource = {
        ...spec,
        region: this.region,
        subnetIds,
        ...(spec.additionalSubnet ? { additionalRouteTableId: spec.additionalSubnet.routeTableId } : {}),
        ...resources,
      };
      try {
        await this.destroy(partial);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "ALB redirector creation failed and cleanup is incomplete.");
      }
      throw error;
    }
  }

  async destroy(resource: AwsAlbRedirectorDestroyResource): Promise<void> {
    const spec = validateDestroyResource(resource, this.region);
    await this.validateServerForDestroy(spec);
    const lbResponse = spec.loadBalancerArn ? await this.maybeElbSend<{ LoadBalancers?: { LoadBalancerArn?: string; VpcId?: string; Type?: string; Scheme?: string; SecurityGroups?: string[] }[] }>(new DescribeLoadBalancersCommand({ LoadBalancerArns: [spec.loadBalancerArn] }), "LoadBalancerNotFoundException") : null;
    const lb = lbResponse?.LoadBalancers?.[0];
    let listenerExists = false;
    if (lb) {
      await this.assertOwnedElb(spec.loadBalancerArn!, spec.guid);
      if (lb.LoadBalancerArn !== spec.loadBalancerArn || lb.VpcId !== spec.vpcId || lb.Type !== "application" || lb.Scheme !== "internet-facing" || !spec.securityGroupId || !lb.SecurityGroups?.includes(spec.securityGroupId)) {
        throw new AwsAlbProviderError("Refusing to delete an ALB whose network binding no longer matches the managed redirector.");
      }
      const listed = await this.elbSend<{ Listeners?: { ListenerArn?: string; LoadBalancerArn?: string; Port?: number; Protocol?: string; Certificates?: { CertificateArn?: string }[]; DefaultActions?: { TargetGroupArn?: string }[] }[]; NextMarker?: string }>(new DescribeListenersCommand({ LoadBalancerArn: spec.loadBalancerArn }));
      const listeners = listed.Listeners ?? [];
      if (listed.NextMarker || listeners.length > 1 || (listeners.length && listeners[0]?.ListenerArn !== spec.listenerArn)) throw new AwsAlbProviderError("Refusing to delete an ALB with an untracked listener.");
      if (listeners.length) {
        const listener = listeners[0]!;
        if (listener.LoadBalancerArn !== spec.loadBalancerArn || listener.Port !== 443 || listener.Protocol !== "HTTPS" || listener.DefaultActions?.[0]?.TargetGroupArn !== spec.targetGroupArn || listener.Certificates?.[0]?.CertificateArn !== spec.certificateArn) {
          throw new AwsAlbProviderError("Refusing to delete an ALB listener whose binding no longer matches the managed redirector.");
        }
        listenerExists = true;
      }
    }
    const targetResponse = spec.targetGroupArn ? await this.maybeElbSend<{ TargetGroups?: { TargetGroupArn?: string; VpcId?: string; Port?: number; Protocol?: string; TargetType?: string }[] }>(new DescribeTargetGroupsCommand({ TargetGroupArns: [spec.targetGroupArn] }), "TargetGroupNotFoundException") : null;
    const target = targetResponse?.TargetGroups?.[0];
    if (target) {
      await this.assertOwnedElb(spec.targetGroupArn!, spec.guid);
      if (target.TargetGroupArn !== spec.targetGroupArn || target.VpcId !== spec.vpcId || target.Port !== spec.backendPort || target.Protocol !== "HTTP" || target.TargetType !== "instance") {
        throw new AwsAlbProviderError("Refusing to delete a target group whose binding no longer matches the managed redirector.");
      }
    }
    const securityGroup = spec.securityGroupId ? await this.maybeEc2Send<{ SecurityGroups?: { GroupId?: string }[] }>(new DescribeSecurityGroupsCommand({ GroupIds: [spec.securityGroupId] }), "InvalidGroup.NotFound", "InvalidSecurityGroupID.NotFound") : null;
    const securityGroupExists = !!securityGroup?.SecurityGroups?.length;
    if (securityGroupExists) await this.assertOwnedSecurityGroup(spec.securityGroupId!, spec.guid, spec.vpcId);
    const ruleExists = async (id: string | undefined): Promise<boolean> => {
      if (!id) return false;
      const result = await this.maybeEc2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string }[] }>(new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [id] }), "InvalidSecurityGroupRuleId.NotFound");
      return !!result?.SecurityGroupRules?.some((rule) => rule.SecurityGroupRuleId === id);
    };
    const albIngressExists = await ruleExists(spec.albIngressRuleId);
    const albEgressExists = await ruleExists(spec.albEgressRuleId);
    let serverIngressRuleId = spec.serverIngressRuleId;
    let serverIngressExists = await ruleExists(serverIngressRuleId);
    if (!serverIngressExists) {
      const discoveredRuleId = await this.findManagedServerIngressRule(spec);
      if (serverIngressRuleId && discoveredRuleId && discoveredRuleId !== serverIngressRuleId) {
        throw new AwsAlbProviderError("The managed server firewall rule identity changed unexpectedly.");
      }
      serverIngressRuleId = discoveredRuleId ?? serverIngressRuleId;
      serverIngressExists = !!discoveredRuleId;
    }
    if (albIngressExists && spec.securityGroupId) await this.assertOwnedRule(spec.albIngressRuleId!, spec.guid, spec.securityGroupId, undefined, 443, false);
    if (albEgressExists && spec.securityGroupId) await this.assertOwnedRule(spec.albEgressRuleId!, spec.guid, spec.securityGroupId, spec.serverSecurityGroupId, spec.backendPort, true);
    if (serverIngressExists) await this.assertOwnedRule(serverIngressRuleId!, spec.guid, spec.serverSecurityGroupId, spec.securityGroupId, spec.backendPort, false);
    const subnetResponse = spec.additionalSubnetId ? await this.maybeEc2Send<{ Subnets?: { SubnetId?: string }[] }>(new DescribeSubnetsCommand({ SubnetIds: [spec.additionalSubnetId] }), "InvalidSubnetID.NotFound") : null;
    const subnetExists = !!subnetResponse?.Subnets?.length;
    if (subnetExists) await this.assertOwnedSubnet(spec.additionalSubnetId!, spec.guid, spec.vpcId);
    let associationId: string | undefined;
    if (subnetExists && spec.additionalRouteTableId) {
      const routes = await this.maybeEc2Send<{ RouteTables?: RouteTableLike[] }>(new DescribeRouteTablesCommand({ RouteTableIds: [spec.additionalRouteTableId] }), "InvalidRouteTableID.NotFound");
      const table = routes?.RouteTables?.find((value) => value.RouteTableId === spec.additionalRouteTableId);
      const savedAssociation = table?.Associations?.find((item) => item.RouteTableAssociationId === spec.additionalRouteTableAssociationId);
      if (savedAssociation && savedAssociation.SubnetId !== spec.additionalSubnetId) throw new AwsAlbProviderError("Refusing to disassociate a route table from an untracked subnet.");
      const subnetAssociation = table?.Associations?.find((item) => item.SubnetId === spec.additionalSubnetId);
      if (spec.additionalRouteTableAssociationId && subnetAssociation && subnetAssociation.RouteTableAssociationId !== spec.additionalRouteTableAssociationId) {
        throw new AwsAlbProviderError("The managed subnet route association changed unexpectedly.");
      }
      const association = spec.additionalRouteTableAssociationId ? savedAssociation : subnetAssociation;
      if (association) {
        if (table?.VpcId !== spec.vpcId || !hasTags(table.Tags, spec.serverGuid)) {
          throw new AwsAlbProviderError("Refusing to disassociate a route table no longer owned by the parent server.");
        }
        associationId = requiredId(association.RouteTableAssociationId, EC2_ID.routeTableAssociation, "route table association");
      }
    }
    if (listenerExists) await this.elbSend(new DeleteListenerCommand({ ListenerArn: spec.listenerArn! }));
    if (lb) {
      await this.elbSend(new DeleteLoadBalancerCommand({ LoadBalancerArn: spec.loadBalancerArn! }));
      await this.waiters.loadBalancerDeleted(this.elb, spec.loadBalancerArn!);
    }
    if (target) await this.elbSend(new DeleteTargetGroupCommand({ TargetGroupArn: spec.targetGroupArn! }));
    if (serverIngressExists) await this.ec2Send(new RevokeSecurityGroupIngressCommand({ GroupId: spec.serverSecurityGroupId, SecurityGroupRuleIds: [serverIngressRuleId!] }));
    if (securityGroupExists) await this.ec2Send(new DeleteSecurityGroupCommand({ GroupId: spec.securityGroupId! }));
    if (associationId) await this.ec2Send(new DisassociateRouteTableCommand({ AssociationId: associationId }));
    if (subnetExists) await this.ec2Send(new DeleteSubnetCommand({ SubnetId: spec.additionalSubnetId! }));
  }

  async refresh(resource: AwsAlbRedirectorDestroyResource): Promise<{ readonly dnsName: string; readonly canonicalHostedZoneId: string; readonly targetHealth: string }> {
    const spec = validateDestroyResource(resource, this.region);
    if (!spec.loadBalancerArn || !spec.targetGroupArn) throw new AwsAlbProviderError("The ALB redirector resource is incomplete.");
    await this.assertOwnedElb(spec.loadBalancerArn, spec.guid);
    await this.assertOwnedElb(spec.targetGroupArn, spec.guid);
    const [lbResult, targetResult] = await Promise.all([
      this.elbSend<{ LoadBalancers?: { DNSName?: string; CanonicalHostedZoneId?: string; VpcId?: string }[] }>(new DescribeLoadBalancersCommand({ LoadBalancerArns: [spec.loadBalancerArn] })),
      this.elbSend<{ TargetHealthDescriptions?: { Target?: { Id?: string }; TargetHealth?: { State?: string } }[] }>(new DescribeTargetHealthCommand({ TargetGroupArn: spec.targetGroupArn, Targets: [{ Id: spec.serverInstanceId, Port: spec.backendPort }] })),
    ]);
    const lb = lbResult.LoadBalancers?.[0];
    if (lb?.VpcId !== spec.vpcId) throw new AwsAlbProviderError("The ALB VPC changed unexpectedly.");
    const target = targetResult.TargetHealthDescriptions?.find((item) => item.Target?.Id === spec.serverInstanceId);
    return { dnsName: requiredDns(lb.DNSName), canonicalHostedZoneId: requiredHostedZoneId(lb.CanonicalHostedZoneId), targetHealth: target?.TargetHealth?.State ?? "unknown" };
  }

  private async validateServer(input: Pick<AwsAlbRedirectorCreateInput, "serverGuid" | "serverInstanceId" | "serverSecurityGroupId" | "vpcId">): Promise<string> {
    const [instances, groups] = await Promise.all([
      this.ec2Send<{ Reservations?: { Instances?: { InstanceId?: string; VpcId?: string; State?: { Name?: string }; Placement?: { AvailabilityZone?: string }; SecurityGroups?: { GroupId?: string }[]; Tags?: TagLike[] }[] }[] }>(new DescribeInstancesCommand({ InstanceIds: [input.serverInstanceId] })),
      this.ec2Send<{ SecurityGroups?: { GroupId?: string; VpcId?: string; Tags?: TagLike[] }[] }>(new DescribeSecurityGroupsCommand({ GroupIds: [input.serverSecurityGroupId] })),
    ]);
    const instance = instances.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((value) => value.InstanceId === input.serverInstanceId);
    const group = groups.SecurityGroups?.find((value) => value.GroupId === input.serverSecurityGroupId);
    if (!instance || instance.VpcId !== input.vpcId || instance.State?.Name !== "running" || !instance.Placement?.AvailabilityZone || !instance.SecurityGroups?.some((value) => value.GroupId === input.serverSecurityGroupId) || !hasTags(instance.Tags, input.serverGuid)) {
      throw new AwsAlbProviderError("The selected managed Sliver server is not in the expected VPC and security group.");
    }
    if (!group || group.VpcId !== input.vpcId || !hasTags(group.Tags, input.serverGuid)) {
      throw new AwsAlbProviderError("The selected Sliver server security group ownership does not match.");
    }
    return instance.Placement.AvailabilityZone;
  }

  private async validateServerForDestroy(input: Pick<AwsAlbRedirectorDestroyResource, "serverGuid" | "serverInstanceId" | "serverSecurityGroupId" | "vpcId">): Promise<void> {
    const [instances, groups] = await Promise.all([
      this.maybeEc2Send<{ Reservations?: { Instances?: { InstanceId?: string; VpcId?: string; Tags?: TagLike[] }[] }[] }>(new DescribeInstancesCommand({ InstanceIds: [input.serverInstanceId] }), "InvalidInstanceID.NotFound"),
      this.maybeEc2Send<{ SecurityGroups?: { GroupId?: string; VpcId?: string; Tags?: TagLike[] }[] }>(new DescribeSecurityGroupsCommand({ GroupIds: [input.serverSecurityGroupId] }), "InvalidGroup.NotFound", "InvalidSecurityGroupID.NotFound"),
    ]);
    const instance = instances?.Reservations?.flatMap((reservation) => reservation.Instances ?? []).find((value) => value.InstanceId === input.serverInstanceId);
    const group = groups?.SecurityGroups?.find((value) => value.GroupId === input.serverSecurityGroupId);
    if (instance && (instance.VpcId !== input.vpcId || !hasTags(instance.Tags, input.serverGuid))) {
      throw new AwsAlbProviderError("The live Sliver server identity no longer matches this redirector.");
    }
    if (group && (group.VpcId !== input.vpcId || !hasTags(group.Tags, input.serverGuid))) {
      throw new AwsAlbProviderError("The live Sliver server security group identity no longer matches this redirector.");
    }
  }

  private async validateSubnets(input: AwsAlbRedirectorCreateInput, subnetIds: readonly string[], serverZone: string): Promise<void> {
    const result = await this.ec2Send<{ Subnets?: { SubnetId?: string; VpcId?: string; AvailabilityZone?: string; CidrBlock?: string; AvailableIpAddressCount?: number; State?: string }[] }>(new DescribeSubnetsCommand({ SubnetIds: [...subnetIds] }));
    const subnets = result.Subnets ?? [];
    if (subnets.length !== subnetIds.length || subnets.some((subnet) => !subnetIds.includes(subnet.SubnetId ?? "") || subnet.VpcId !== input.vpcId || subnet.State !== "available" || !subnet.AvailabilityZone)) {
      throw new AwsAlbProviderError("The ALB subnets must be available in the selected server VPC.");
    }
    if (subnets.some((subnet) => !eligibleAlbSubnet(subnet))) {
      throw new AwsAlbProviderError("Each ALB subnet must be /27 or larger with at least eight free IPv4 addresses.");
    }
    const zones = subnets.map((subnet) => subnet.AvailabilityZone!);
    if (new Set(zones).size !== zones.length || !zones.includes(serverZone) || (input.additionalSubnet && zones.includes(input.additionalSubnet.availabilityZone))) {
      throw new AwsAlbProviderError("The ALB requires two public subnets in distinct availability zones.");
    }
    const [tables, gateways] = await Promise.all([
      this.ec2Send<{ RouteTables?: RouteTableLike[] }>(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [input.vpcId] }] })),
      this.ec2Send<{ InternetGateways?: { InternetGatewayId?: string; Attachments?: { VpcId?: string; State?: string }[] }[] }>(new DescribeInternetGatewaysCommand({ Filters: [{ Name: "attachment.vpc-id", Values: [input.vpcId] }] })),
    ]);
    const routeTables = tables.RouteTables ?? [];
    const gatewayIds = new Set((gateways.InternetGateways ?? []).filter((value) => value.Attachments?.some((attachment) => attachment.VpcId === input.vpcId && attachment.State === "available")).map((value) => value.InternetGatewayId));
    const publicRoute = (table: RouteTableLike): boolean => table.VpcId === input.vpcId && (table.Routes ?? []).some((route) => route.DestinationCidrBlock === "0.0.0.0/0" && route.State === "active" && gatewayIds.has(route.GatewayId));
    for (const subnetId of subnetIds) {
      const table = routeTables.find((value) => value.Associations?.some((association) => association.SubnetId === subnetId)) ?? routeTables.find((value) => value.Associations?.some((association) => association.Main));
      if (!table || !publicRoute(table)) throw new AwsAlbProviderError("The ALB requires public subnets routed to an attached internet gateway.");
    }
    if (input.additionalSubnet) {
      const table = routeTables.find((value) => value.RouteTableId === input.additionalSubnet?.routeTableId);
      if (!table || !publicRoute(table) || !hasTags(table.Tags, input.serverGuid)) {
        throw new AwsAlbProviderError("The additional subnet must use the managed server's public route table.");
      }
      const current = await this.discoverNetworkOptions({
        vpcId: input.vpcId,
        serverSubnetId: subnetIds[0]!,
        serverGuid: input.serverGuid,
      });
      const suggested = current.suggestedAdditionalSubnet;
      if (!suggested || suggested.cidrBlock !== input.additionalSubnet.cidrBlock || suggested.availabilityZone !== input.additionalSubnet.availabilityZone || suggested.routeTableId !== input.additionalSubnet.routeTableId) {
        throw new AwsAlbProviderError("The additional subnet suggestion is stale. Refresh the network options before deploying.");
      }
    }
  }

  private async assertOwnedElb(arn: string, guid: string): Promise<void> {
    const result = await this.elbSend<{ TagDescriptions?: { ResourceArn?: string; Tags?: TagLike[] }[] }>(new DescribeTagsCommand({ ResourceArns: [arn] }));
    if (result.TagDescriptions?.[0]?.ResourceArn !== arn || !hasTags(result.TagDescriptions[0].Tags, guid, true)) {
      throw new AwsAlbProviderError("Refusing to modify an ALB resource whose Sliver GUI ownership tags do not match.");
    }
  }

  private async assertOwnedSecurityGroup(id: string, guid: string, vpcId: string): Promise<void> {
    const result = await this.ec2Send<{ SecurityGroups?: { GroupId?: string; VpcId?: string; Tags?: TagLike[] }[] }>(new DescribeSecurityGroupsCommand({ GroupIds: [id] }));
    const group = result.SecurityGroups?.[0];
    if (group?.GroupId !== id || group.VpcId !== vpcId || !hasTags(group.Tags, guid, true)) {
      throw new AwsAlbProviderError("Refusing to delete an ALB security group whose ownership tags do not match.");
    }
  }

  private async assertOwnedSubnet(id: string, guid: string, vpcId: string): Promise<void> {
    const result = await this.ec2Send<{ Subnets?: { SubnetId?: string; VpcId?: string; Tags?: TagLike[] }[] }>(new DescribeSubnetsCommand({ SubnetIds: [id] }));
    const subnet = result.Subnets?.[0];
    if (subnet?.SubnetId !== id || subnet.VpcId !== vpcId || !hasTags(subnet.Tags, guid, true)) {
      throw new AwsAlbProviderError("Refusing to delete an ALB subnet whose ownership tags do not match.");
    }
  }

  private async assertOwnedRule(id: string, guid: string, groupId: string, referencedGroupId: string | undefined, port: number, egress: boolean): Promise<void> {
    const result = await this.ec2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string; GroupId?: string; IsEgress?: boolean; FromPort?: number; ToPort?: number; ReferencedGroupInfo?: { GroupId?: string }; Tags?: TagLike[] }[] }>(new DescribeSecurityGroupRulesCommand({ SecurityGroupRuleIds: [id] }));
    const rule = result.SecurityGroupRules?.[0];
    if (!rule || rule.SecurityGroupRuleId !== id || rule.GroupId !== groupId || rule.IsEgress !== egress || rule.FromPort !== port || rule.ToPort !== port || rule.ReferencedGroupInfo?.GroupId !== referencedGroupId || !hasTags(rule.Tags, guid, true)) {
      throw new AwsAlbProviderError("Refusing to remove an ALB firewall rule whose ownership or binding does not match.");
    }
  }

  private async findManagedServerIngressRule(spec: AwsAlbRedirectorDestroyResource): Promise<string | undefined> {
    if (!spec.securityGroupId) return undefined;
    const result = await this.ec2Send<{ SecurityGroupRules?: { SecurityGroupRuleId?: string; GroupId?: string; IsEgress?: boolean; FromPort?: number; ToPort?: number; ReferencedGroupInfo?: { GroupId?: string }; Tags?: TagLike[] }[]; NextToken?: string }>(new DescribeSecurityGroupRulesCommand({
      Filters: [
        { Name: "group-id", Values: [spec.serverSecurityGroupId] },
        { Name: `tag:${GUID_TAG}`, Values: [spec.guid] },
      ],
    }));
    if (result.NextToken) throw new AwsAlbProviderError("The server firewall rule inventory is incomplete.");
    const rules = result.SecurityGroupRules ?? [];
    if (rules.length > 1 || rules.some((rule) => !rule.SecurityGroupRuleId || rule.GroupId !== spec.serverSecurityGroupId || rule.IsEgress !== false || rule.FromPort !== spec.backendPort || rule.ToPort !== spec.backendPort || rule.ReferencedGroupInfo?.GroupId !== spec.securityGroupId || !hasTags(rule.Tags, spec.guid, true))) {
      throw new AwsAlbProviderError("Refusing to remove an untracked server firewall rule for this redirector.");
    }
    return rules[0]?.SecurityGroupRuleId;
  }

  private async ec2Send<T = unknown>(command: unknown): Promise<T> {
    return this.ec2.send(command, { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) as Promise<T>;
  }

  private async elbSend<T = unknown>(command: unknown): Promise<T> {
    return this.elb.send(command, { abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }) as Promise<T>;
  }

  private async maybeEc2Send<T>(command: unknown, ...notFoundNames: readonly string[]): Promise<T | null> {
    try { return await this.ec2Send<T>(command); }
    catch (error) { if (isAwsNotFound(error, notFoundNames)) return null; throw error; }
  }

  private async maybeElbSend<T>(command: unknown, ...notFoundNames: readonly string[]): Promise<T | null> {
    try { return await this.elbSend<T>(command); }
    catch (error) { if (isAwsNotFound(error, notFoundNames)) return null; throw error; }
  }
}

interface TagLike { readonly Key?: string; readonly Value?: string }
interface RouteTableLike {
  readonly RouteTableId?: string;
  readonly VpcId?: string;
  readonly Tags?: TagLike[];
  readonly Associations?: { readonly SubnetId?: string; readonly Main?: boolean; readonly RouteTableAssociationId?: string }[];
  readonly Routes?: { readonly DestinationCidrBlock?: string; readonly GatewayId?: string; readonly State?: string }[];
}
type MutableResources = { -readonly [K in keyof AwsAlbRedirectorMutationResources]?: AwsAlbRedirectorMutationResources[K] };

function validateCreateInput(input: AwsAlbRedirectorCreateInput, region: string): AwsAlbRedirectorCreateInput & { readonly healthCheckPath: string; readonly healthCheckSuccessCodes: string } {
  if (!input || typeof input !== "object") throw new AwsAlbProviderError("The ALB redirector request is invalid.");
  const guid = requireUuid(input.guid, "deployment ID");
  const serverGuid = requireUuid(input.serverGuid, "server deployment ID");
  if (guid === serverGuid) throw new AwsAlbProviderError("The ALB and server deployment IDs must differ.");
  if (typeof input.name !== "string" || input.name.trim() !== input.name || input.name.length < 1 || input.name.length > 128 || /\p{Cc}/u.test(input.name)) throw new AwsAlbProviderError("The ALB redirector name is invalid.");
  requiredId(input.serverInstanceId, EC2_ID.instance, "server instance");
  requiredId(input.serverSecurityGroupId, EC2_ID.securityGroup, "server security group");
  requiredId(input.vpcId, EC2_ID.vpc, "VPC");
  if (!Array.isArray(input.subnetIds) || input.subnetIds.length !== (input.additionalSubnet ? 1 : 2) || new Set(input.subnetIds).size !== input.subnetIds.length) throw new AwsAlbProviderError("Provide two public subnets or one public subnet plus an additional subnet specification.");
  for (const id of input.subnetIds) requiredId(id, EC2_ID.subnet, "subnet");
  if (input.additionalSubnet) {
    requiredId(input.additionalSubnet.routeTableId, EC2_ID.routeTable, "route table");
    if (!/^[a-z]{2}(?:-[a-z]+)+-[0-9][a-z]$/u.test(input.additionalSubnet.availabilityZone) || !input.additionalSubnet.availabilityZone.startsWith(region)) throw new AwsAlbProviderError("The additional subnet availability zone is invalid.");
    const cidr = parseIpv4Cidr(input.additionalSubnet.cidrBlock);
    if (!cidr || cidr.prefix < 16 || cidr.prefix > 27 || cidr.address !== cidr.start) throw new AwsAlbProviderError("The additional subnet IPv4 CIDR is invalid; ALB subnets must be /27 or larger.");
  }
  const expectedPrefix = `arn:${region.startsWith("cn-") ? "aws-cn" : region.startsWith("us-gov-") ? "aws-us-gov" : "aws"}:acm:${region}:`;
  if (typeof input.certificateArn !== "string" || !input.certificateArn.startsWith(expectedPrefix) || !/^arn:(aws|aws-us-gov|aws-cn):acm:[a-z0-9-]+:[0-9]{12}:certificate\/[0-9a-f-]{36}$/iu.test(input.certificateArn)) throw new AwsAlbProviderError("The ACM certificate ARN must belong to the selected AWS region.");
  if (!Number.isSafeInteger(input.backendPort) || input.backendPort < 1 || input.backendPort > 65_535) throw new AwsAlbProviderError("The backend HTTP port is invalid.");
  const healthCheckPath = input.healthCheckPath ?? "/";
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{0,255}$/u.test(healthCheckPath)) throw new AwsAlbProviderError("The ALB health check path is invalid.");
  const healthCheckSuccessCodes = input.healthCheckSuccessCodes ?? "404";
  if (!/^[2-4][0-9]{2}(?:,[2-4][0-9]{2}){0,9}$/u.test(healthCheckSuccessCodes) || healthCheckSuccessCodes.split(",").some((value) => Number(value) > 499)) throw new AwsAlbProviderError("The ALB health check success codes must be HTTP 200-499.");
  return { ...input, guid, serverGuid, healthCheckPath, healthCheckSuccessCodes };
}

function validateDestroyResource(input: AwsAlbRedirectorDestroyResource, region: string): AwsAlbRedirectorDestroyResource {
  requireUuid(input.guid, "deployment ID");
  requireUuid(input.serverGuid, "server deployment ID");
  requiredId(input.serverInstanceId, EC2_ID.instance, "server instance");
  requiredId(input.serverSecurityGroupId, EC2_ID.securityGroup, "server security group");
  requiredId(input.vpcId, EC2_ID.vpc, "VPC");
  if (!Array.isArray(input.subnetIds) || input.subnetIds.length < 1 || input.subnetIds.length > 2) throw new AwsAlbProviderError("The ALB subnet identity is invalid.");
  for (const id of input.subnetIds) requiredId(id, EC2_ID.subnet, "subnet");
  if (!Number.isSafeInteger(input.backendPort) || input.backendPort < 1 || input.backendPort > 65_535) throw new AwsAlbProviderError("The backend HTTP port is invalid.");
  if (input.region !== region) throw new AwsAlbProviderError("The ALB redirector region does not match this provider.");
  for (const [key, pattern] of [
    ["additionalSubnetId", EC2_ID.subnet],
    ["additionalRouteTableAssociationId", EC2_ID.routeTableAssociation],
    ["securityGroupId", EC2_ID.securityGroup],
    ["albIngressRuleId", EC2_ID.rule],
    ["albEgressRuleId", EC2_ID.rule],
    ["serverIngressRuleId", EC2_ID.rule],
    ["additionalRouteTableId", EC2_ID.routeTable],
  ] as const) {
    if (input[key]) requiredId(input[key], pattern, key);
  }
  for (const [key, kind] of [["targetGroupArn", "targetgroup"], ["loadBalancerArn", "loadbalancer/app"], ["listenerArn", "listener/app"]] as const) {
    if (input[key]) requiredArn(input[key], region, kind);
  }
  if (input.listenerArn && (!input.loadBalancerArn || !input.targetGroupArn)) throw new AwsAlbProviderError("The ALB listener identity is incomplete.");
  if (input.loadBalancerArn && !input.securityGroupId) throw new AwsAlbProviderError("The ALB security group identity is incomplete.");
  if (input.additionalSubnetId && !input.subnetIds.includes(input.additionalSubnetId)) throw new AwsAlbProviderError("The managed ALB subnet is not part of the selected subnet set.");
  if (input.additionalRouteTableAssociationId && (!input.additionalSubnetId || !input.additionalRouteTableId)) throw new AwsAlbProviderError("The managed ALB route association identity is incomplete.");
  return input;
}

function requiredId(value: string | undefined, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new AwsAlbProviderError(`The ${label} identifier is invalid.`);
  return value;
}

function requireUuid(value: string, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new AwsAlbProviderError(`The ${label} is invalid.`);
  return value.toLowerCase();
}

function requiredArn(value: string | undefined, region: string, kind: string): string {
  const match = typeof value === "string" ? RESOURCE_ARN.exec(value) : null;
  if (!match || match[2] !== region || match[4] !== kind) throw new AwsAlbProviderError(`The AWS ${kind} ARN is invalid.`);
  return value!;
}

function requiredDns(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 253 || !/^[A-Za-z0-9.-]+\.elb\.amazonaws\.com(?:\.cn)?$/u.test(value)) throw new AwsAlbProviderError("AWS returned an invalid ALB DNS name.");
  return value;
}

function requiredHostedZoneId(value: string | undefined): string {
  if (typeof value !== "string" || !/^Z[A-Z0-9]{1,63}$/u.test(value)) throw new AwsAlbProviderError("AWS returned an invalid ALB canonical hosted zone ID.");
  return value;
}

function resourceName(prefix: string, guid: string): string {
  return `${prefix}-${guid.replaceAll("-", "").slice(0, 16)}`;
}

function ownedTags(input: Pick<AwsAlbRedirectorCreateInput, "guid" | "name">): { Key: string; Value: string }[] {
  return [{ Key: MANAGED_TAG, Value: "true" }, { Key: GUID_TAG, Value: input.guid }, { Key: TYPE_TAG, Value: TYPE_VALUE }, { Key: NAME_TAG, Value: input.name }];
}

function hasTags(tags: readonly TagLike[] | undefined, guid: string, redirector = false): boolean {
  const value = (key: string): string | undefined => tags?.find((tag) => tag.Key === key)?.Value;
  return value(MANAGED_TAG) === "true" && value(GUID_TAG) === guid && (!redirector || value(TYPE_TAG) === TYPE_VALUE);
}

function isAwsNotFound(error: unknown, names: readonly string[]): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; Code?: unknown };
  return names.some((name) => candidate.name === name || candidate.Code === name);
}

function completeResources(resources: MutableResources): Required<AwsAlbRedirectorMutationResources> {
  if (!resources.securityGroupId || !resources.albIngressRuleId || !resources.albEgressRuleId || !resources.serverIngressRuleId || !resources.targetGroupArn || !resources.loadBalancerArn || !resources.listenerArn) throw new AwsAlbProviderError("AWS returned an incomplete ALB redirector.");
  return resources as Required<AwsAlbRedirectorMutationResources>;
}

interface Ipv4Cidr {
  readonly address: number;
  readonly prefix: number;
  readonly start: number;
  readonly end: number;
}

function eligibleAlbSubnet(subnet: { readonly CidrBlock?: string; readonly AvailableIpAddressCount?: number }): boolean {
  const cidr = subnet.CidrBlock ? parseIpv4Cidr(subnet.CidrBlock) : null;
  return !!cidr && cidr.prefix <= 27 &&
    typeof subnet.AvailableIpAddressCount === "number" && subnet.AvailableIpAddressCount >= 8;
}

function parseIpv4Cidr(value: string): Ipv4Cidr | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/u.exec(value);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix < 0 || prefix > 32) return null;
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  const start = (address & mask) >>> 0;
  const end = start + 2 ** (32 - prefix) - 1;
  return { address, prefix, start, end };
}

function findAvailableAlbSubnet(vpcCidr: string, occupiedCidrs: readonly string[]): string | null {
  const vpc = parseIpv4Cidr(vpcCidr);
  if (!vpc || vpc.prefix > 27) return null;
  const prefix = Math.max(24, vpc.prefix);
  const size = 2 ** (32 - prefix);
  const occupied = occupiedCidrs.map(parseIpv4Cidr).filter((value): value is Ipv4Cidr => value !== null);
  for (let start = vpc.start, attempts = 0; start + size - 1 <= vpc.end && attempts < 4_096; start += size, attempts += 1) {
    const end = start + size - 1;
    if (occupied.some((range) => start <= range.end && range.start <= end)) continue;
    return `${(start >>> 24) & 255}.${(start >>> 16) & 255}.${(start >>> 8) & 255}.${start & 255}/${prefix}`;
  }
  return null;
}

const defaultWaiters: AwsAlbWaiters = {
  subnetAvailable: async (client, id) => {
    await waitUntilSubnetAvailable({ client: client as EC2Client, maxWaitTime: WAIT_SECONDS }, { SubnetIds: [id] });
  },
  loadBalancerAvailable: async (client, arn) => {
    await waitUntilLoadBalancerAvailable({ client: client as ElasticLoadBalancingV2Client, maxWaitTime: WAIT_SECONDS }, { LoadBalancerArns: [arn] });
  },
  targetHealthy: async (client, arn, instanceId, port) => {
    await waitUntilTargetInService({ client: client as ElasticLoadBalancingV2Client, maxWaitTime: WAIT_SECONDS }, { TargetGroupArn: arn, Targets: [{ Id: instanceId, Port: port }] });
  },
  loadBalancerDeleted: async (client, arn) => {
    await waitUntilLoadBalancersDeleted({ client: client as ElasticLoadBalancingV2Client, maxWaitTime: WAIT_SECONDS }, { LoadBalancerArns: [arn] });
  },
};
