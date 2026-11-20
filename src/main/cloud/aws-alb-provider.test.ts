// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  AwsAlbRedirectorProvider,
  type AwsAlbClientLike,
  type AwsAlbRedirectorCreateInput,
  type AwsAlbRedirectorResource,
  type AwsAlbWaiters,
} from "./aws-alb-provider.js";

const region = "us-west-2";
const guid = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const serverGuid = "cd08fd6c-c559-49df-9ed3-2246448aa654";
const vpcId = "vpc-0123456789abcdef0";
const serverSubnetId = "subnet-0123456789abcdef0";
const otherSubnetId = "subnet-1123456789abcdef0";
const createdSubnetId = "subnet-2123456789abcdef0";
const serverInstanceId = "i-0123456789abcdef0";
const serverSecurityGroupId = "sg-0123456789abcdef0";
const albSecurityGroupId = "sg-1123456789abcdef0";
const routeTableId = "rtb-0123456789abcdef0";
const routeAssociationId = "rtbassoc-0123456789abcdef0";
const loadBalancerArn = `arn:aws:elasticloadbalancing:${region}:123456789012:loadbalancer/app/sliver-gui-alb/aabbccdd`;
const targetGroupArn = `arn:aws:elasticloadbalancing:${region}:123456789012:targetgroup/sliver-gui-tg/aabbccdd`;
const listenerArn = `arn:aws:elasticloadbalancing:${region}:123456789012:listener/app/sliver-gui-alb/aabbccdd/eeff0011`;
const certificateArn = `arn:aws:acm:${region}:123456789012:certificate/12345678-1234-4123-8123-123456789abc`;
const dnsName = "sliver-gui-alb-1234567890.us-west-2.elb.amazonaws.com";
const canonicalHostedZoneId = "Z1H1FL5HABSF5";
const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };

const baseInput: AwsAlbRedirectorCreateInput = {
  guid,
  name: "HTTPS redirector",
  serverGuid,
  serverInstanceId,
  serverSecurityGroupId,
  vpcId,
  subnetIds: [serverSubnetId],
  additionalSubnet: { cidrBlock: "10.77.0.0/24", availabilityZone: "us-west-2b", routeTableId },
  certificateArn,
  backendPort: 8080,
};

const waiters: AwsAlbWaiters = {
  subnetAvailable: async () => undefined,
  loadBalancerAvailable: async () => undefined,
  targetHealthy: async () => undefined,
  loadBalancerDeleted: async () => undefined,
};

type Tag = { Key: string; Value: string };

class FakeAws {
  readonly commands: { client: "ec2" | "elb"; name: string; input: Record<string, unknown> }[] = [];
  readonly serverTags: Tag[] = [{ Key: "SliverGUIManaged", Value: "true" }, { Key: "SliverGUID", Value: serverGuid }];
  readonly subnets = new Map<string, { SubnetId: string; VpcId: string; AvailabilityZone: string; CidrBlock: string; AvailableIpAddressCount: number; State: string; Tags?: Tag[] }>([
    [serverSubnetId, { SubnetId: serverSubnetId, VpcId: vpcId, AvailabilityZone: "us-west-2a", CidrBlock: "10.77.1.0/24", AvailableIpAddressCount: 251, State: "available" }],
  ]);
  readonly routeTable = {
    RouteTableId: routeTableId,
    VpcId: vpcId,
    Tags: this.serverTags,
    Associations: [{ SubnetId: serverSubnetId, RouteTableAssociationId: "rtbassoc-1123456789abcdef0" }],
    Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-0123456789abcdef0", State: "active" }],
  };
  readonly groups = new Map<string, { GroupId: string; VpcId: string; Tags: Tag[]; IpPermissionsEgress: unknown[] }>([
    [serverSecurityGroupId, { GroupId: serverSecurityGroupId, VpcId: vpcId, Tags: this.serverTags, IpPermissionsEgress: [] }],
  ]);
  readonly rules = new Map<string, Record<string, unknown>>();
  readonly elbTags = new Map<string, Tag[]>();
  loadBalancer: Record<string, unknown> | null = null;
  targetGroup: Record<string, unknown> | null = null;
  listener: Record<string, unknown> | null = null;
  serverPresent = true;
  serverAvailabilityZone = "us-west-2a";
  failCommand: string | null = null;
  strictNotFound = false;

  readonly ec2: AwsAlbClientLike = {
    send: async (command: unknown) => this.send("ec2", command),
  };
  readonly elb: AwsAlbClientLike = {
    send: async (command: unknown) => this.send("elb", command),
  };

  private async send(client: "ec2" | "elb", raw: unknown): Promise<unknown> {
    const command = raw as { constructor: { name: string }; input: Record<string, any> };
    const { name } = command.constructor;
    const input = command.input as any;
    this.commands.push({ client, name, input });
    if (name === this.failCommand) throw new Error(`${name} failed`);
    switch (name) {
      case "DescribeVpcsCommand": return { Vpcs: [{ VpcId: vpcId, CidrBlock: "10.77.0.0/16" }] };
      case "DescribeAvailabilityZonesCommand": return { AvailabilityZones: [{ ZoneName: "us-west-2a", State: "available" }, { ZoneName: "us-west-2b", State: "available" }] };
      case "DescribeInstancesCommand": return { Reservations: [{ Instances: this.serverPresent ? [{ InstanceId: serverInstanceId, VpcId: vpcId, State: { Name: "running" }, Placement: { AvailabilityZone: this.serverAvailabilityZone }, Tags: this.serverTags, SecurityGroups: [{ GroupId: serverSecurityGroupId }] }] : [] }] };
      case "DescribeSubnetsCommand": return { Subnets: input.SubnetIds ? input.SubnetIds.map((id: string) => this.subnets.get(id)).filter(Boolean) : [...this.subnets.values()] };
      case "DescribeRouteTablesCommand": return { RouteTables: !input.RouteTableIds || input.RouteTableIds.includes(routeTableId) ? [this.routeTable] : [] };
      case "DescribeInternetGatewaysCommand": return { InternetGateways: [{ InternetGatewayId: "igw-0123456789abcdef0", Attachments: [{ VpcId: vpcId, State: "available" }] }] };
      case "CreateSubnetCommand": {
        this.subnets.set(createdSubnetId, { SubnetId: createdSubnetId, VpcId: vpcId, AvailabilityZone: input.AvailabilityZone, CidrBlock: input.CidrBlock, AvailableIpAddressCount: 251, State: "available", Tags: input.TagSpecifications[0].Tags });
        return { Subnet: { SubnetId: createdSubnetId } };
      }
      case "AssociateRouteTableCommand": {
        this.routeTable.Associations.push({ SubnetId: input.SubnetId, RouteTableAssociationId: routeAssociationId });
        return { AssociationId: routeAssociationId };
      }
      case "DisassociateRouteTableCommand": {
        this.routeTable.Associations.splice(this.routeTable.Associations.findIndex((value) => value.RouteTableAssociationId === input.AssociationId), 1);
        return {};
      }
      case "DeleteSubnetCommand": this.subnets.delete(input.SubnetId); return {};
      case "CreateSecurityGroupCommand": {
        this.groups.set(albSecurityGroupId, { GroupId: albSecurityGroupId, VpcId: vpcId, Tags: input.TagSpecifications[0].Tags, IpPermissionsEgress: [{ IpProtocol: "-1", IpRanges: [{ CidrIp: "0.0.0.0/0" }] }] });
        return { GroupId: albSecurityGroupId };
      }
      case "DescribeSecurityGroupsCommand": return { SecurityGroups: input.GroupIds.map((id: string) => this.groups.get(id)).filter(Boolean) };
      case "RevokeSecurityGroupEgressCommand": {
        const group = this.groups.get(input.GroupId);
        if (group) group.IpPermissionsEgress = [];
        return {};
      }
      case "AuthorizeSecurityGroupIngressCommand": return this.addRule(input, false);
      case "AuthorizeSecurityGroupEgressCommand": return this.addRule(input, true);
      case "DescribeSecurityGroupRulesCommand": return { SecurityGroupRules: input.SecurityGroupRuleIds
        ? input.SecurityGroupRuleIds.map((id: string) => this.rules.get(id)).filter(Boolean)
        : [...this.rules.values()].filter((rule) => rule["GroupId"] === input.Filters.find((filter: any) => filter.Name === "group-id")?.Values[0] &&
          (rule["Tags"] as Tag[]).some((tag) => tag.Key === "SliverGUID" && tag.Value === input.Filters.find((filter: any) => filter.Name === "tag:SliverGUID")?.Values[0])) };
      case "RevokeSecurityGroupIngressCommand": input.SecurityGroupRuleIds.forEach((id: string) => this.rules.delete(id)); return {};
      case "DeleteSecurityGroupCommand": this.groups.delete(input.GroupId); return {};
      case "CreateTargetGroupCommand": {
        this.targetGroup = { TargetGroupArn: targetGroupArn, VpcId: input.VpcId, Port: input.Port, Protocol: input.Protocol, TargetType: input.TargetType };
        this.elbTags.set(targetGroupArn, input.Tags);
        return { TargetGroups: [this.targetGroup] };
      }
      case "RegisterTargetsCommand": return {};
      case "CreateLoadBalancerCommand": {
        this.loadBalancer = { LoadBalancerArn: loadBalancerArn, DNSName: dnsName, CanonicalHostedZoneId: canonicalHostedZoneId, VpcId: input.Subnets.length ? vpcId : "", Type: input.Type, Scheme: input.Scheme, SecurityGroups: input.SecurityGroups };
        this.elbTags.set(loadBalancerArn, input.Tags);
        return { LoadBalancers: [this.loadBalancer] };
      }
      case "CreateListenerCommand": {
        this.listener = { ListenerArn: listenerArn, LoadBalancerArn: input.LoadBalancerArn, Port: input.Port, Protocol: input.Protocol, Certificates: input.Certificates, DefaultActions: input.DefaultActions };
        return { Listeners: [this.listener] };
      }
      case "DescribeListenersCommand": return { Listeners: this.listener && (input.LoadBalancerArn === loadBalancerArn || input.ListenerArns?.includes(listenerArn)) ? [this.listener] : [] };
      case "DescribeLoadBalancersCommand": {
        if (!this.loadBalancer && this.strictNotFound) throw Object.assign(new Error("missing"), { name: "LoadBalancerNotFoundException" });
        return { LoadBalancers: this.loadBalancer ? [this.loadBalancer] : [] };
      }
      case "DescribeTargetGroupsCommand": {
        if (!this.targetGroup && this.strictNotFound) throw Object.assign(new Error("missing"), { name: "TargetGroupNotFoundException" });
        return { TargetGroups: this.targetGroup ? [this.targetGroup] : [] };
      }
      case "DescribeTargetHealthCommand": return { TargetHealthDescriptions: [{ Target: { Id: serverInstanceId }, TargetHealth: { State: "healthy" } }] };
      case "DescribeTagsCommand": return { TagDescriptions: input.ResourceArns.map((arn: string) => ({ ResourceArn: arn, Tags: this.elbTags.get(arn) })) };
      case "DeleteListenerCommand": this.listener = null; return {};
      case "DeleteLoadBalancerCommand": this.loadBalancer = null; this.elbTags.delete(loadBalancerArn); return {};
      case "DeleteTargetGroupCommand": this.targetGroup = null; this.elbTags.delete(targetGroupArn); return {};
      default: throw new Error(`Unexpected ${name}`);
    }
  }

  private addRule(input: any, egress: boolean): unknown {
    const id = !egress && input.GroupId === albSecurityGroupId ? "sgr-11111111111111111" : egress ? "sgr-22222222222222222" : "sgr-33333333333333333";
    const permission = input.IpPermissions[0];
    const rule = {
      SecurityGroupRuleId: id,
      GroupId: input.GroupId,
      IsEgress: egress,
      FromPort: permission.FromPort,
      ToPort: permission.ToPort,
      ReferencedGroupInfo: permission.UserIdGroupPairs?.[0] ? { GroupId: permission.UserIdGroupPairs[0].GroupId } : undefined,
      Tags: input.TagSpecifications[0].Tags,
    };
    this.rules.set(id, rule);
    return { SecurityGroupRules: [{ SecurityGroupRuleId: id }] };
  }
}

function provider(fake: FakeAws): AwsAlbRedirectorProvider {
  return new AwsAlbRedirectorProvider({ region, credentials }, { ec2ClientFactory: () => fake.ec2, elbClientFactory: () => fake.elb, waiters });
}

describe("AWS ALB redirector provider", () => {
  it("discovers a second public subnet suggestion in a different AZ", async () => {
    const fake = new FakeAws();
    await expect(provider(fake).discoverNetworkOptions({ vpcId, serverSubnetId, serverGuid })).resolves.toEqual({
      publicSubnets: [{ id: serverSubnetId, availabilityZone: "us-west-2a" }],
      suggestedAdditionalSubnet: { cidrBlock: "10.77.0.0/24", availabilityZone: "us-west-2b", routeTableId },
    });
  });

  it("creates an HTTPS ALB with ACM, private HTTP target, scoped firewall, and owned second subnet", async () => {
    const fake = new FakeAws();
    const mutations: string[] = [];
    const resource = await provider(fake).create(baseInput, (event) => { mutations.push(event.phase); });
    expect(resource).toMatchObject({
      guid, serverGuid, serverInstanceId, vpcId, subnetIds: [serverSubnetId, createdSubnetId],
      additionalSubnetId: createdSubnetId, additionalRouteTableAssociationId: routeAssociationId,
      securityGroupId: albSecurityGroupId, loadBalancerArn, targetGroupArn, listenerArn, dnsName, canonicalHostedZoneId,
    });
    expect(mutations).toEqual(["subnet", "subnet-route", "security-group", "firewall", "firewall", "firewall", "target-group", "load-balancer", "listener", "healthy"]);
    const target = fake.commands.find((command) => command.name === "CreateTargetGroupCommand")?.input as any;
    expect(target).toMatchObject({ VpcId: vpcId, Protocol: "HTTP", Port: 8080, TargetType: "instance", Matcher: { HttpCode: "404" } });
    const lb = fake.commands.find((command) => command.name === "CreateLoadBalancerCommand")?.input as any;
    expect(lb).toMatchObject({ Type: "application", Scheme: "internet-facing", Subnets: [serverSubnetId, createdSubnetId], SecurityGroups: [albSecurityGroupId] });
    const listener = fake.commands.find((command) => command.name === "CreateListenerCommand")?.input as any;
    expect(listener).toMatchObject({ Protocol: "HTTPS", Port: 443, Certificates: [{ CertificateArn: certificateArn }], DefaultActions: [{ TargetGroupArn: targetGroupArn }] });
    const backendRule = fake.commands.filter((command) => command.name === "AuthorizeSecurityGroupIngressCommand").at(-1)?.input as any;
    expect(backendRule).toMatchObject({ GroupId: serverSecurityGroupId, IpPermissions: [{ FromPort: 8080, ToPort: 8080, UserIdGroupPairs: [{ GroupId: albSecurityGroupId }] }] });
    expect(fake.commands.some((command) => command.name === "RevokeSecurityGroupEgressCommand")).toBe(true);
    const { albIngressRuleId: _ingress, albEgressRuleId: _egress, ...persisted } = resource;
    expect(await provider(fake).refresh(persisted)).toEqual({ dnsName, canonicalHostedZoneId, targetHealth: "healthy" });
  });

  it("accepts two existing public subnets and removes only its owned resources", async () => {
    const fake = new FakeAws();
    fake.subnets.set(otherSubnetId, { SubnetId: otherSubnetId, VpcId: vpcId, AvailabilityZone: "us-west-2b", CidrBlock: "10.77.2.0/24", AvailableIpAddressCount: 251, State: "available" });
    fake.routeTable.Associations.push({ SubnetId: otherSubnetId, RouteTableAssociationId: "rtbassoc-2123456789abcdef0" });
    const { additionalSubnet: _unused, ...withoutAdditionalSubnet } = baseInput;
    const resource = await provider(fake).create({ ...withoutAdditionalSubnet, subnetIds: [serverSubnetId, otherSubnetId] });
    expect(resource.additionalSubnetId).toBeUndefined();
    await provider(fake).destroy(resource);
    expect(fake.loadBalancer).toBeNull();
    expect(fake.targetGroup).toBeNull();
    expect(fake.groups.has(serverSecurityGroupId)).toBe(true);
    expect(fake.groups.has(albSecurityGroupId)).toBe(false);
    expect(fake.subnets.has(serverSubnetId)).toBe(true);
    expect(fake.subnets.has(otherSubnetId)).toBe(true);
    expect(fake.commands.filter((command) => command.name === "DeleteSubnetCommand")).toHaveLength(0);
  });

  it("refuses to delete a target whose ownership tags were changed before any mutation", async () => {
    const fake = new FakeAws();
    const resource: AwsAlbRedirectorResource = await provider(fake).create(baseInput);
    fake.elbTags.set(targetGroupArn, [{ Key: "SliverGUIManaged", Value: "true" }, { Key: "SliverGUID", Value: "other" }]);
    const before = fake.commands.length;
    await expect(provider(fake).destroy(resource)).rejects.toThrow(/ownership tags/u);
    expect(fake.commands.slice(before).every((command) => !command.name.startsWith("Delete") && !command.name.startsWith("Revoke") && !command.name.startsWith("Disassociate"))).toBe(true);
    expect(fake.loadBalancer).not.toBeNull();
  });

  it("rolls back a failed listener creation including the new subnet and server firewall rule", async () => {
    const fake = new FakeAws();
    fake.failCommand = "CreateListenerCommand";
    let journaled: Record<string, unknown> = {};
    await expect(provider(fake).create(baseInput, (event) => { journaled = { ...event.resources }; })).rejects.toThrow(/CreateListenerCommand failed/u);
    expect(fake.loadBalancer).toBeNull();
    expect(fake.targetGroup).toBeNull();
    expect(fake.groups.has(albSecurityGroupId)).toBe(false);
    expect(fake.rules.has("sgr-33333333333333333")).toBe(false);
    expect(fake.subnets.has(createdSubnetId)).toBe(false);
    fake.failCommand = null;
    fake.strictNotFound = true;
    await expect(provider(fake).destroy({
      ...baseInput, ...journaled, region,
      subnetIds: [serverSubnetId, createdSubnetId],
      additionalRouteTableId: routeTableId,
      healthCheckPath: "/", healthCheckSuccessCodes: "404",
    })).resolves.toBeUndefined();
  });

  it("resumes cleanup after a failure following listener deletion", async () => {
    const fake = new FakeAws();
    const resource = await provider(fake).create(baseInput);
    fake.failCommand = "DeleteLoadBalancerCommand";
    await expect(provider(fake).destroy(resource)).rejects.toThrow(/DeleteLoadBalancerCommand failed/u);
    expect(fake.listener).toBeNull();
    expect(fake.loadBalancer).not.toBeNull();
    fake.failCommand = null;
    await provider(fake).destroy(resource);
    expect(fake.loadBalancer).toBeNull();
    expect(fake.targetGroup).toBeNull();
    expect(fake.subnets.has(createdSubnetId)).toBe(false);
    fake.strictNotFound = true;
    await expect(provider(fake).destroy(resource)).resolves.toBeUndefined();
  });

  it("recovers a tagged subnet association and server ingress rule omitted from a partial journal", async () => {
    const fake = new FakeAws();
    const resource = await provider(fake).create(baseInput);
    const { additionalRouteTableAssociationId: _association, serverIngressRuleId: _serverRule,
      albIngressRuleId: _albIngress, albEgressRuleId: _albEgress, ...partial } = resource;
    await expect(provider(fake).destroy(partial)).resolves.toBeUndefined();
    expect(fake.rules.has(resource.serverIngressRuleId)).toBe(false);
    expect(fake.routeTable.Associations.some((association) => association.SubnetId === createdSubnetId)).toBe(false);
    expect(fake.subnets.has(createdSubnetId)).toBe(false);
  });

  it("removes owned ALB resources after the parent server has disappeared", async () => {
    const fake = new FakeAws();
    const resource = await provider(fake).create(baseInput);
    fake.serverPresent = false;
    fake.groups.delete(serverSecurityGroupId);
    fake.rules.delete(resource.serverIngressRuleId);
    const { albIngressRuleId: _ingress, albEgressRuleId: _egress, ...persisted } = resource;
    await expect(provider(fake).destroy(persisted)).resolves.toBeUndefined();
    expect(fake.loadBalancer).toBeNull();
    expect(fake.targetGroup).toBeNull();
    expect(fake.subnets.has(createdSubnetId)).toBe(false);
  });

  it("rejects an ACM certificate from another region before writing", async () => {
    const fake = new FakeAws();
    await expect(provider(fake).create({ ...baseInput, certificateArn: certificateArn.replace(region, "us-east-1") })).rejects.toThrow(/ACM certificate ARN/u);
    expect(fake.commands).toHaveLength(0);
  });

  it("rejects a public subnet without enough free IPv4 addresses", async () => {
    const fake = new FakeAws();
    fake.subnets.get(serverSubnetId)!.AvailableIpAddressCount = 7;
    const options = await provider(fake).discoverNetworkOptions({ vpcId, serverSubnetId, serverGuid });
    expect(options.publicSubnets).toEqual([]);
    expect(options.suggestedAdditionalSubnet).toBeNull();
    await expect(provider(fake).create(baseInput)).rejects.toThrow(/eight free IPv4 addresses/u);
    expect(fake.commands.some(({ name }) => name.startsWith("Create"))).toBe(false);
  });

  it("requires an enabled ALB subnet in the target server's availability zone", async () => {
    const fake = new FakeAws();
    fake.serverAvailabilityZone = "us-west-2c";
    await expect(provider(fake).create(baseInput)).rejects.toThrow(/availability zones/u);
    expect(fake.commands.some(({ name }) => name.startsWith("Create"))).toBe(false);
  });
});
