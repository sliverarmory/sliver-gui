// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  AWS_EC2_DEFAULT_INSTANCE_TYPES,
  AwsEc2Provider,
  type AwsEc2ClientConfiguration,
  type AwsEc2ClientLike,
  type AwsEc2CreateInput,
  type AwsEc2DeploymentResource,
  type AwsEc2Waiters,
} from "./aws-ec2-provider.js";
import type { AwsFirewallRuleSpec } from "../../shared/cloud-deployment-contracts.js";

const guid = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const region = "us-west-2";
const imageId = "ami-0123456789abcdef0";
const subnetId = "subnet-0123456789abcdef0";
const vpcId = "vpc-0123456789abcdef0";
const instanceId = "i-0123456789abcdef0";
const securityGroupId = "sg-0123456789abcdef0";
const ingressRuleId = "sgr-11111111111111111";
const egressRuleId = "sgr-22222222222222222";
const volumeId = "vol-0123456789abcdef0";
const networkInterfaceId = "eni-0123456789abcdef0";
const allocationId = "eipalloc-0123456789abcdef0";
const associationId = "eipassoc-0123456789abcdef0";
const keyPairId = "key-0123456789abcdef0";
const keyPairName = `sliver-gui-${guid}`;
const managedVpcId = "vpc-11111111111111111";
const managedSubnetId = "subnet-11111111111111111";
const internetGatewayId = "igw-11111111111111111";
const routeTableId = "rtb-11111111111111111";
const routeTableAssociationId = "rtbassoc-11111111111111111";
const sshPublicKeyBlob = Buffer.from(
  "\0\0\0\u000bssh-ed25519\0\0\0\u001f0123456789012345678901234567890",
  "binary",
).toString("base64");
const sshPublicKey = `ssh-ed25519 ${sshPublicKeyBlob} sliver-gui`;
const credentials = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  sessionToken: "temporary-session-token",
} as const;

describe("AWS EC2 provider authentication and discovery", () => {
  it("binds only the supplied credentials to the official client factory", async () => {
    const configurations: AwsEc2ClientConfiguration[] = [];
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: {
        AvailabilityZones: [
          { ZoneName: "us-west-2b", State: "available" },
          { ZoneName: "us-west-2a", State: "available" },
        ],
      },
    });
    const provider = new AwsEc2Provider(
      { region, credentials },
      {
        clientFactory: (configuration) => {
          configurations.push(configuration);
          return client;
        },
        waiters: waiterSpies(),
      },
    );

    await expect(provider.preflight()).resolves.toEqual({
      region,
      availabilityZones: [
        { name: "us-west-2a", state: "available" },
        { name: "us-west-2b", state: "available" },
      ],
    });
    expect(configurations).toEqual([{ region, credentials }]);
    expect(client.commandNames()).toEqual(["DescribeAvailabilityZonesCommand"]);
  });

  it("accepts a lazy named-profile credential provider without resolving it during construction", async () => {
    const profileCredentials = vi.fn(async () => credentials);
    let configuration: AwsEc2ClientConfiguration | undefined;
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: { AvailabilityZones: [] },
    });
    const provider = new AwsEc2Provider(
      { region, credentials: profileCredentials },
      {
        clientFactory: (input) => {
          configuration = input;
          return client;
        },
        waiters: waiterSpies(),
      },
    );

    await provider.preflight();
    expect(profileCredentials).not.toHaveBeenCalled();
    expect(configuration?.region).toBe(region);
    expect(typeof configuration?.credentials).toBe("function");
    if (typeof configuration?.credentials !== "function") throw new Error("Expected a lazy credential provider");
    await expect(configuration.credentials()).resolves.toEqual(credentials);
    expect(profileCredentials).toHaveBeenCalledOnce();
  });

  it("accepts EC2 regions in restricted AWS partitions", () => {
    let configuration: AwsEc2ClientConfiguration | undefined;

    new AwsEc2Provider(
      { region: "us-iso-east-1", credentials },
      {
        clientFactory: (input) => {
          configuration = input;
          return new RecordingEc2Client({});
        },
        waiters: waiterSpies(),
      },
    );

    expect(configuration?.region).toBe("us-iso-east-1");
  });

  it("returns a bounded SDK failure without echoing the SDK message or credentials", async () => {
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: () => {
        throw Object.assign(
          new Error(`do not expose ${credentials.secretAccessKey}`),
          { name: "UnauthorizedOperation", $metadata: { httpStatusCode: 403 } },
        );
      },
    });
    const provider = providerFor(client);

    const error = await provider.preflight().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("UnauthorizedOperation");
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain(credentials.secretAccessKey);
    expect(String(error)).not.toContain("do not expose");
  });

  it.each(["AwsSharedProfileError", "AwsConsoleLoginError", "ExpiredToken", "ExpiredTokenException"])("turns %s into actionable safe login guidance", async (name) => {
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: () => {
        throw Object.assign(
          new Error(`do not expose ${credentials.secretAccessKey}`),
          { name },
        );
      },
    });
    const provider = providerFor(client);

    const error = await provider.preflight().catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(name === "AwsConsoleLoginError" ? "Use AWS Login to renew this credential" : "configured authentication method");
    expect(String(error)).not.toContain(name);
    expect(String(error)).not.toContain(credentials.secretAccessKey);
    expect(String(error)).not.toContain("do not expose");
  });

  it.each(["transient", "permission-denied", "unexpected-response"])("does not turn %s authentication failures into forced browser login", async (category) => {
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: () => {
        throw Object.assign(new Error(`do not expose ${credentials.secretAccessKey}`), { name: "AwsConsoleLoginError", category });
      },
    });
    const error = await providerFor(client).preflight().catch((failure: unknown) => failure);
    expect(String(error)).not.toContain("Use AWS Login");
    expect(String(error)).not.toContain(credentials.secretAccessKey);
    expect(String(error)).not.toContain("do not expose");
    if (category === "transient") expect(String(error)).toContain("temporary connection or service problem");
  });

  it("discovers curated regional sizes, latest official AMIs, networking, and SSH key pairs", async () => {
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: {
        AvailabilityZones: [{ ZoneName: "us-west-2a", State: "available" }],
      },
      DescribeInstanceTypesCommand: {
        InstanceTypes: [
          {
            InstanceType: "t4g.micro",
            SupportedInRegion: true,
            ProcessorInfo: { SupportedArchitectures: ["arm64"] },
            VCpuInfo: { DefaultVCpus: 2 },
            MemoryInfo: { SizeInMiB: 1_024 },
          },
          {
            InstanceType: "t3.xlarge",
            SupportedInRegion: true,
            ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
            VCpuInfo: { DefaultVCpus: 4 },
            MemoryInfo: { SizeInMiB: 16_384 },
          },
          {
            InstanceType: "t3.micro",
            SupportedInRegion: true,
            ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
            VCpuInfo: { DefaultVCpus: 2 },
            MemoryInfo: { SizeInMiB: 1_024 },
          },
          { InstanceType: "t4g.xlarge", SupportedInRegion: false },
          { InstanceType: "m7i.large", SupportedInRegion: true },
        ],
      },
      DescribeInstanceTypeOfferingsCommand: {
        InstanceTypeOfferings: [
          { InstanceType: "t4g.xlarge", Location: region, LocationType: "region" },
          { InstanceType: "t3.micro", Location: region, LocationType: "region" },
          { InstanceType: "t3.xlarge", Location: region, LocationType: "region" },
          { InstanceType: "t4g.micro", Location: region, LocationType: "region" },
        ],
      },
      DescribeVpcsCommand: {
        Vpcs: [
          { VpcId: "vpc-bbbbbbbbbbbbbbbbb", CidrBlock: "10.1.0.0/16", IsDefault: false },
          {
            VpcId: vpcId,
            CidrBlock: "10.0.0.0/16",
            IsDefault: true,
            Tags: [{ Key: "Name", Value: "Operator VPC" }],
          },
        ],
      },
      DescribeSubnetsCommand: {
        Subnets: [{
          SubnetId: subnetId,
          VpcId: vpcId,
          AvailabilityZone: "us-west-2a",
          CidrBlock: "10.0.1.0/24",
          MapPublicIpOnLaunch: true,
          Tags: [{ Key: "Name", Value: "Public A" }],
        }],
      },
      DescribeKeyPairsCommand: {
        KeyPairs: [{
          KeyPairId: keyPairId,
          KeyName: "operator-key",
          KeyFingerprint: "SHA256:example",
          KeyType: "ed25519",
          PublicKey: "ssh-ed25519 AAAAC3NzaExample operator-key",
        }],
      },
      DescribeImagesCommand: {
        Images: [
          officialUbuntuImage("ami-00000000000000001", "amd64", "2026-01-01T00:00:00.000Z"),
          officialUbuntuImage("ami-00000000000000002", "amd64", "2026-08-01T00:00:00.000Z"),
          officialUbuntuImage("ami-00000000000000003", "arm64", "2026-07-01T00:00:00.000Z"),
          amazonLinuxImage("ami-00000000000000004", "x86_64", "2026-08-02T00:00:00.000Z"),
          amazonLinuxImage("ami-00000000000000005", "arm64", "2026-08-03T00:00:00.000Z"),
          {
            ...officialUbuntuImage("ami-00000000000000006", "amd64", "2026-09-01T00:00:00.000Z"),
            OwnerId: "111122223333",
          },
        ],
      },
    });
    const provider = providerFor(client);

    await expect(provider.discover()).resolves.toEqual({
      region,
      availabilityZones: [{ name: "us-west-2a", state: "available" }],
      instanceTypes: [
        {
          name: "t3.micro",
          architecture: "x86_64",
          vCpuCount: 2,
          memoryMiB: 1_024,
          processor: "Intel x86-64",
          description: "2 vCPU · 1 GiB RAM · Intel x86-64",
        },
        {
          name: "t3.xlarge",
          architecture: "x86_64",
          vCpuCount: 4,
          memoryMiB: 16_384,
          processor: "Intel x86-64",
          description: "4 vCPU · 16 GiB RAM · Intel x86-64",
        },
        {
          name: "t4g.micro",
          architecture: "arm64",
          vCpuCount: 2,
          memoryMiB: 1_024,
          processor: "AWS Graviton2 Arm",
          description: "2 vCPU · 1 GiB RAM · AWS Graviton2 Arm",
        },
      ],
      vpcs: [
        { id: vpcId, name: "Operator VPC", cidrBlock: "10.0.0.0/16", isDefault: true },
        { id: "vpc-bbbbbbbbbbbbbbbbb", cidrBlock: "10.1.0.0/16", isDefault: false },
      ],
      subnets: [{
        id: subnetId,
        name: "Public A",
        vpcId,
        availabilityZone: "us-west-2a",
        cidrBlock: "10.0.1.0/24",
        mapPublicIpOnLaunch: true,
      }],
      keyPairs: [{
        name: "operator-key",
        id: keyPairId,
        fingerprint: "SHA256:example",
        keyType: "ed25519",
        publicKey: "ssh-ed25519 AAAAC3NzaExample operator-key",
      }],
      images: [
        {
          id: "ami-00000000000000002",
          name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-20260801",
          description: "Ubuntu Server 24.04 LTS",
          architecture: "x86_64",
          rootDeviceName: "/dev/sda1",
          distribution: "ubuntu",
          version: "24.04 LTS",
          sshUsername: "ubuntu",
          creationDate: "2026-08-01T00:00:00.000Z",
        },
        {
          id: "ami-00000000000000003",
          name: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20260701",
          description: "Ubuntu Server 24.04 LTS",
          architecture: "arm64",
          rootDeviceName: "/dev/sda1",
          distribution: "ubuntu",
          version: "24.04 LTS",
          sshUsername: "ubuntu",
          creationDate: "2026-07-01T00:00:00.000Z",
        },
        {
          id: "ami-00000000000000004",
          name: "al2023-ami-2023.9.20260802.0-kernel-6.1-x86_64",
          description: "Amazon Linux 2023",
          architecture: "x86_64",
          rootDeviceName: "/dev/xvda",
          distribution: "amazon-linux",
          version: "2023",
          sshUsername: "ec2-user",
          creationDate: "2026-08-02T00:00:00.000Z",
        },
        {
          id: "ami-00000000000000005",
          name: "al2023-ami-2023.9.20260803.0-kernel-6.1-arm64",
          description: "Amazon Linux 2023",
          architecture: "arm64",
          rootDeviceName: "/dev/xvda",
          distribution: "amazon-linux",
          version: "2023",
          sshUsername: "ec2-user",
          creationDate: "2026-08-03T00:00:00.000Z",
        },
      ],
    });

    expect(client.input("DescribeInstanceTypeOfferingsCommand")).toEqual({
      LocationType: "region",
      Filters: [
        { Name: "location", Values: [region] },
        { Name: "instance-type", Values: [...AWS_EC2_DEFAULT_INSTANCE_TYPES] },
      ],
    });
    expect(client.input("DescribeInstanceTypesCommand")).toEqual({
      InstanceTypes: ["t3.micro", "t3.xlarge", "t4g.micro", "t4g.xlarge"],
    });
    expect(client.input("DescribeKeyPairsCommand")).toEqual({ IncludePublicKey: true });
    expect(client.inputs("DescribeImagesCommand")).toEqual([
      expect.objectContaining({ Owners: ["099720109477"] }),
      expect.objectContaining({ Owners: ["amazon"] }),
    ]);
    expect(client.inputs("DescribeImagesCommand")[0]).toMatchObject({
      Filters: expect.arrayContaining([{
        Name: "name",
        Values: expect.arrayContaining([
          "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
          "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-*",
        ]),
      }]),
    });
  });

  it("collects and deduplicates every bounded discovery page before sorting options", async () => {
    const secondVpcId = "vpc-22222222222222222";
    const secondSubnetId = "subnet-22222222222222222";
    const latestUbuntuId = "ami-22222222222222222";
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: {
        AvailabilityZones: [{ ZoneName: "us-west-2a", State: "available" }],
      },
      DescribeVpcsCommand: (command: unknown) => commandInput(command)["NextToken"] === "vpcs-2"
        ? {
            Vpcs: [
              { VpcId: secondVpcId, IsDefault: false, Tags: [{ Key: "Name", Value: "Alpha" }] },
              { VpcId: vpcId, IsDefault: true, Tags: [{ Key: "Name", Value: "Duplicate" }] },
            ],
          }
        : {
            Vpcs: [{ VpcId: vpcId, IsDefault: true, Tags: [{ Key: "Name", Value: "Zulu" }] }],
            NextToken: "vpcs-2",
          },
      DescribeSubnetsCommand: (command: unknown) => commandInput(command)["NextToken"] === "subnets-2"
        ? {
            Subnets: [
              { SubnetId: secondSubnetId, VpcId: secondVpcId, MapPublicIpOnLaunch: false },
              { SubnetId: subnetId, VpcId: vpcId, MapPublicIpOnLaunch: false },
            ],
          }
        : {
            Subnets: [{ SubnetId: subnetId, VpcId: vpcId, MapPublicIpOnLaunch: true }],
            NextToken: "subnets-2",
          },
      DescribeKeyPairsCommand: { KeyPairs: [] },
      DescribeInstanceTypeOfferingsCommand: (command: unknown) => (
        commandInput(command)["NextToken"] === "offerings-2"
          ? { InstanceTypeOfferings: [{ InstanceType: "t4g.micro" }] }
          : { InstanceTypeOfferings: [{ InstanceType: "t3.micro" }], NextToken: "offerings-2" }
      ),
      DescribeInstanceTypesCommand: (command: unknown) => commandInput(command)["NextToken"] === "types-2"
        ? {
            InstanceTypes: [{
              InstanceType: "t4g.micro",
              ProcessorInfo: { SupportedArchitectures: ["arm64"] },
              VCpuInfo: { DefaultVCpus: 2 },
              MemoryInfo: { SizeInMiB: 1_024 },
            }],
          }
        : {
            InstanceTypes: [{
              InstanceType: "t3.micro",
              ProcessorInfo: { SupportedArchitectures: ["x86_64"] },
              VCpuInfo: { DefaultVCpus: 2 },
              MemoryInfo: { SizeInMiB: 1_024 },
            }],
            NextToken: "types-2",
          },
      DescribeImagesCommand: (command: unknown) => {
        const input = commandInput(command);
        if (input["NextToken"] === "ubuntu-2") {
          return { Images: [officialUbuntuImage(latestUbuntuId, "amd64", "2026-09-01T00:00:00.000Z")] };
        }
        if ((input["Owners"] as string[] | undefined)?.[0] === "099720109477") {
          return {
            Images: [officialUbuntuImage("ami-11111111111111111", "amd64", "2026-01-01T00:00:00.000Z")],
            NextToken: "ubuntu-2",
          };
        }
        return { Images: [amazonLinuxImage("ami-33333333333333333", "arm64", "2026-08-01T00:00:00.000Z")] };
      },
    });

    const discovered = await providerFor(client).discover();

    expect(discovered.vpcs.map(({ id }) => id)).toEqual([secondVpcId, vpcId]);
    expect(discovered.subnets.map(({ id }) => id)).toEqual([subnetId, secondSubnetId]);
    expect(discovered.instanceTypes.map(({ name }) => name)).toEqual(["t3.micro", "t4g.micro"]);
    expect(discovered.images.map(({ id }) => id)).toEqual([
      latestUbuntuId,
      "ami-33333333333333333",
    ]);
    expect(client.inputs("DescribeVpcsCommand")).toEqual([{}, { NextToken: "vpcs-2" }]);
    expect(client.inputs("DescribeSubnetsCommand")).toEqual([{}, { NextToken: "subnets-2" }]);
    expect(client.inputs("DescribeInstanceTypeOfferingsCommand")[1]).toMatchObject({ NextToken: "offerings-2" });
    expect(client.inputs("DescribeInstanceTypesCommand")[1]).toMatchObject({ NextToken: "types-2" });
    expect(client.inputs("DescribeImagesCommand")).toEqual(expect.arrayContaining([
      expect.objectContaining({ NextToken: "ubuntu-2" }),
    ]));
  });

  it("rejects a repeated discovery token instead of looping", async () => {
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: { AvailabilityZones: [{ ZoneName: "us-west-2a", State: "available" }] },
      DescribeVpcsCommand: { Vpcs: [], NextToken: "repeat" },
      DescribeSubnetsCommand: { Subnets: [] },
      DescribeKeyPairsCommand: { KeyPairs: [] },
      DescribeInstanceTypeOfferingsCommand: { InstanceTypeOfferings: [] },
      DescribeImagesCommand: { Images: [] },
    });

    await expect(providerFor(client).discover()).rejects.toThrow(/repeated pagination token/u);

    expect(client.inputs("DescribeVpcsCommand")).toEqual([{}, { NextToken: "repeat" }]);
  });

  it("caps discovery pagination even when AWS keeps returning unique tokens", async () => {
    let page = 0;
    const client = new RecordingEc2Client({
      DescribeAvailabilityZonesCommand: { AvailabilityZones: [{ ZoneName: "us-west-2a", State: "available" }] },
      DescribeVpcsCommand: () => ({ Vpcs: [], NextToken: `page-${page += 1}` }),
      DescribeSubnetsCommand: { Subnets: [] },
      DescribeKeyPairsCommand: { KeyPairs: [] },
      DescribeInstanceTypeOfferingsCommand: { InstanceTypeOfferings: [] },
      DescribeImagesCommand: { Images: [] },
    });

    await expect(providerFor(client).discover()).rejects.toThrow(/too many pages/u);

    expect(client.inputs("DescribeVpcsCommand")).toHaveLength(100);
  });
});

describe("AWS EC2 managed deployment creation", () => {
  it("creates and tags a hardened one-instance deployment and an optional Elastic IP", async () => {
    const client = createClient();
    const waiters = waiterSpies();
    const provider = providerFor(client, waiters);

    const resource = await provider.create(createInput());

    expect(resource).toEqual({
      guid,
      name: "Red team server",
      region,
      keyPair: { id: keyPairId, name: keyPairName },
      instanceId,
      securityGroupId,
      volumeIds: [volumeId],
      networkInterfaceIds: [networkInterfaceId],
      state: "running",
      instanceHealth: "ok",
      systemHealth: "ok",
      availabilityZone: "us-west-2a",
      privateIpAddress: "10.0.1.8",
      publicIpAddress: "203.0.113.40",
      elasticIp: { allocationId, associationId, publicIp: "203.0.113.40" },
    });

    const createGroup = client.input("CreateSecurityGroupCommand");
    expect(createGroup).toMatchObject({
      GroupName: `sliver-gui-${guid}`,
      VpcId: vpcId,
      TagSpecifications: [{
        ResourceType: "security-group",
        Tags: managedTags(),
      }],
    });

    expect(client.input("ImportKeyPairCommand")).toEqual({
      KeyName: keyPairName,
      PublicKeyMaterial: Buffer.from(sshPublicKey, "utf8"),
      TagSpecifications: [{ ResourceType: "key-pair", Tags: managedTags() }],
    });

    const authorize = client.input("AuthorizeSecurityGroupIngressCommand");
    expect(authorize).toMatchObject({
      GroupId: securityGroupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 22,
          ToPort: 22,
          IpRanges: [{ CidrIp: "198.51.100.8/32", Description: `sliver-gui:${guid}:ssh` }],
        },
        {
          IpProtocol: "tcp",
          FromPort: 31_337,
          ToPort: 31_337,
          Ipv6Ranges: [{ CidrIpv6: "2001:db8::/64", Description: `sliver-gui:${guid}:multiplayer` }],
        },
      ],
      TagSpecifications: [{
        ResourceType: "security-group-rule",
        Tags: managedTags(),
      }],
    });

    const run = client.input("RunInstancesCommand");
    expect(run).toMatchObject({
      ImageId: imageId,
      InstanceType: "t3.small",
      MinCount: 1,
      MaxCount: 1,
      ClientToken: guid,
      SubnetId: subnetId,
      SecurityGroupIds: [securityGroupId],
      KeyName: keyPairName,
      UserData: Buffer.from("#cloud-config\n", "utf8").toString("base64"),
      MetadataOptions: { HttpEndpoint: "enabled", HttpTokens: "required" },
      BlockDeviceMappings: [{
        DeviceName: "/dev/sda1",
        Ebs: { DeleteOnTermination: true, Encrypted: true, VolumeSize: 24 },
      }],
    });
    expect(run["TagSpecifications"]).toEqual([
      { ResourceType: "instance", Tags: managedTags() },
      { ResourceType: "volume", Tags: managedTags() },
      { ResourceType: "network-interface", Tags: managedTags() },
    ]);
    expect(client.input("AllocateAddressCommand")).toMatchObject({
      Domain: "vpc",
      TagSpecifications: [{ ResourceType: "elastic-ip", Tags: managedTags() }],
    });
    expect(client.input("AssociateAddressCommand")).toEqual({ AllocationId: allocationId, InstanceId: instanceId });
    expect(waiters.running).toHaveBeenCalledWith(client, instanceId);
    expect(waiters.instanceStatusOk).toHaveBeenCalledWith(client, instanceId);
    expect(waiters.systemStatusOk).toHaveBeenCalledWith(client, instanceId);
  });

  it("journals each managed identity before later waits and associations", async () => {
    const client = createClient();
    const timeline: string[] = [];
    const waitUntilRunning = vi.fn(async () => undefined);
    const waitUntilInstanceStatusOk = vi.fn(async () => undefined);
    const waitUntilSystemStatusOk = vi.fn(async () => undefined);
    const waiters: AwsEc2Waiters = {
      ...waiterSpies(),
      running: waitUntilRunning,
      instanceStatusOk: waitUntilInstanceStatusOk,
      systemStatusOk: waitUntilSystemStatusOk,
    };
    const provider = providerFor(client, waiters);
    const events: unknown[] = [];
    waitUntilRunning.mockImplementation(async () => {
      timeline.push("wait-running");
    });
    waitUntilInstanceStatusOk.mockImplementation(async () => {
      timeline.push("wait-instance-status");
    });
    waitUntilSystemStatusOk.mockImplementation(async () => {
      timeline.push("wait-system-status");
    });

    await provider.create(createInput(), (event) => {
      events.push(event);
      timeline.push(event.phase);
    });

    expect(events).toEqual([
      {
        phase: "key-pair",
        resources: { keyPair: { id: keyPairId, name: keyPairName } },
      },
      {
        phase: "security-group",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
        },
      },
      {
        phase: "instance",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
        },
      },
      {
        phase: "instance-running",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
        },
      },
      {
        phase: "instance-status-ok",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
        },
      },
      {
        phase: "system-status-ok",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
        },
      },
      {
        phase: "elastic-ip",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
          elasticIpAllocationId: allocationId,
          elasticIpPublicAddress: "203.0.113.40",
        },
      },
      {
        phase: "elastic-ip",
        resources: {
          keyPair: { id: keyPairId, name: keyPairName },
          securityGroupId,
          instanceId,
          elasticIpAllocationId: allocationId,
          elasticIpAssociationId: associationId,
          elasticIpPublicAddress: "203.0.113.40",
        },
      },
    ]);
    expect(client.commandNames().indexOf("RunInstancesCommand"))
      .toBeLessThan(client.commandNames().indexOf("DescribeInstancesCommand"));
    expect(timeline).toEqual([
      "key-pair",
      "security-group",
      "instance",
      "wait-running",
      "instance-running",
      "wait-instance-status",
      "instance-status-ok",
      "wait-system-status",
      "system-status-ok",
      "elastic-ip",
      "elastic-ip",
    ]);
  });

  it("rejects unsupported public-key material before importing a key pair", async () => {
    const client = new RecordingEc2Client({});
    const provider = providerFor(client);

    await expect(provider.create(createInput({
      sshPublicKey: "ecdsa-sha2-nistp256 AAAA not-supported-by-ec2",
    }))).rejects.toThrow(/OpenSSH RSA or ED25519/u);

    expect(client.commands).toHaveLength(0);
  });

  it.each(["0.0.0.0/0", "::/0", "0:0:0:0:0:0:0:0/0"])(
    "rejects internet-wide firewall CIDR %s before making an AWS request",
    async (openCidr) => {
      const client = new RecordingEc2Client({});
      const provider = providerFor(client);
      const input = createInput({
        firewall: {
          sshPort: 22,
          sshSourceCidrs: [openCidr],
          multiplayerPort: 31_337,
          multiplayerSourceCidrs: ["198.51.100.9/32"],
        },
      });

      await expect(provider.create(input)).rejects.toThrow(/internet-wide \/0 access/u);
      expect(client.commands).toHaveLength(0);
    },
  );

  it("uses an existing EC2 key pair only when its public key exactly matches the credential", async () => {
    const client = createClient({
      DescribeKeyPairsCommand: {
        KeyPairs: [{
          KeyPairId: keyPairId,
          KeyName: "operator-key",
          PublicKey: sshPublicKey,
        }],
      },
    });
    const provider = providerFor(client);

    const created = await provider.create(createInput({
      sshKeyPair: { mode: "existing", name: "operator-key" },
      allocateElasticIp: false,
    }));

    expect(created.keyPair).toEqual({ id: keyPairId, name: "operator-key", managed: false });
    expect(client.input("DescribeKeyPairsCommand")).toEqual({
      KeyNames: ["operator-key"],
      IncludePublicKey: true,
    });
    expect(client.commandNames()).not.toContain("ImportKeyPairCommand");
    expect(client.input("RunInstancesCommand")).toMatchObject({ KeyName: "operator-key" });
  });

  it("accepts the same existing EC2 public key with a different comment", async () => {
    const client = createClient({
      DescribeKeyPairsCommand: {
        KeyPairs: [{
          KeyPairId: keyPairId,
          KeyName: "operator-key",
          PublicKey: `${sshPublicKey} changed`,
        }],
      },
    });
    const provider = providerFor(client);

    await expect(provider.create(createInput({
      sshKeyPair: { mode: "existing", name: "operator-key" },
      allocateElasticIp: false,
    }))).resolves.toMatchObject({ keyPair: { name: "operator-key", managed: false } });

    expect(client.commandNames()).not.toContain("ImportKeyPairCommand");
    expect(client.input("RunInstancesCommand")).toMatchObject({ KeyName: "operator-key" });
  });

  it("rejects an existing EC2 key pair with different key material before creating resources", async () => {
    const fields = sshPublicKey.split(" ");
    const differentPublicKey = `${fields[0]} ${Buffer.from("different-key-material").toString("base64")}`;
    const client = createClient({
      DescribeKeyPairsCommand: {
        KeyPairs: [{
          KeyPairId: keyPairId,
          KeyName: "operator-key",
          PublicKey: differentPublicKey,
        }],
      },
    });
    const provider = providerFor(client);

    await expect(provider.create(createInput({
      sshKeyPair: { mode: "existing", name: "operator-key" },
    }))).rejects.toThrow(/does not exactly match/u);

    expect(client.commandNames()).not.toContain("ImportKeyPairCommand");
    expect(client.commandNames()).not.toContain("CreateSecurityGroupCommand");
    expect(client.commandNames()).not.toContain("RunInstancesCommand");
  });

  it("rejects a subnet outside the selected VPC before creating resources", async () => {
    const selectedVpcId = "vpc-99999999999999999";
    const client = createClient();
    const provider = providerFor(client);

    await expect(provider.create(createInput({
      network: { mode: "existing", vpcId: selectedVpcId, subnetId },
    }))).rejects.toThrow(/subnet does not belong to the selected VPC/u);

    expect(client.commandNames()).toEqual(["DescribeImagesCommand", "DescribeSubnetsCommand"]);
    expect(client.commandNames()).not.toContain("ImportKeyPairCommand");
    expect(client.commandNames()).not.toContain("CreateSecurityGroupCommand");
    expect(client.commandNames()).not.toContain("RunInstancesCommand");
  });

  it("rejects an AMI architecture incompatible with the selected instance type before creating resources", async () => {
    const client = createClient({
      DescribeImagesCommand: {
        Images: [{
          ImageId: imageId,
          State: "available",
          Architecture: "arm64",
          RootDeviceType: "ebs",
          RootDeviceName: "/dev/sda1",
        }],
      },
    });
    const provider = providerFor(client);

    await expect(provider.create(createInput({ instanceType: "t3.micro" })))
      .rejects.toThrow(/architecture must be x86_64 for t3\.micro/u);

    expect(client.commandNames()).toEqual(["DescribeImagesCommand"]);
  });

  it("rejects instance types outside the bounded deployment catalog before AWS calls", async () => {
    const client = createClient();
    const provider = providerFor(client);

    await expect(provider.create(createInput({ instanceType: "m7i.large" })))
      .rejects.toThrow(/instance type is not supported/u);

    expect(client.commandNames()).toEqual([]);
  });

  it("creates, tags, and journals a managed public VPC before launching the instance", async () => {
    const client = createClient(managedNetworkCreateResponses());
    const waiters = waiterSpies();
    const provider = providerFor(client, waiters);
    const events: Array<{ phase: string; resources: Record<string, unknown> }> = [];

    const created = await provider.create(createInput({
      network: {
        mode: "managed",
        vpcCidrBlock: "10.42.0.0/16",
        subnetCidrBlock: "10.42.1.0/24",
      },
      allocateElasticIp: false,
    }), (event) => {
      events.push(event as { phase: string; resources: Record<string, unknown> });
    });

    expect(created.managedNetwork).toEqual({
      vpcId: managedVpcId,
      subnetId: managedSubnetId,
      internetGatewayId,
      routeTableId,
      routeTableAssociationId,
    });
    expect(waiters.vpcAvailable).toHaveBeenCalledWith(client, managedVpcId);
    expect(waiters.subnetAvailable).toHaveBeenCalledWith(client, managedSubnetId);
    expect(client.input("CreateVpcCommand")).toEqual({
      CidrBlock: "10.42.0.0/16",
      InstanceTenancy: "default",
      TagSpecifications: [{ ResourceType: "vpc", Tags: managedTags() }],
    });
    expect(client.inputs("ModifyVpcAttributeCommand")).toEqual([
      { VpcId: managedVpcId, EnableDnsSupport: { Value: true } },
      { VpcId: managedVpcId, EnableDnsHostnames: { Value: true } },
    ]);
    expect(client.input("CreateInternetGatewayCommand")).toEqual({
      TagSpecifications: [{ ResourceType: "internet-gateway", Tags: managedTags() }],
    });
    expect(client.input("AttachInternetGatewayCommand")).toEqual({
      InternetGatewayId: internetGatewayId,
      VpcId: managedVpcId,
    });
    expect(client.input("CreateSubnetCommand")).toEqual({
      VpcId: managedVpcId,
      CidrBlock: "10.42.1.0/24",
      TagSpecifications: [{ ResourceType: "subnet", Tags: managedTags() }],
    });
    expect(client.input("ModifySubnetAttributeCommand")).toEqual({
      SubnetId: managedSubnetId,
      MapPublicIpOnLaunch: { Value: true },
    });
    expect(client.input("CreateRouteTableCommand")).toEqual({
      VpcId: managedVpcId,
      TagSpecifications: [{ ResourceType: "route-table", Tags: managedTags() }],
    });
    expect(client.input("CreateRouteCommand")).toEqual({
      RouteTableId: routeTableId,
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: internetGatewayId,
    });
    expect(client.input("AssociateRouteTableCommand")).toEqual({
      RouteTableId: routeTableId,
      SubnetId: managedSubnetId,
    });
    expect(client.input("CreateSecurityGroupCommand")).toMatchObject({ VpcId: managedVpcId });
    expect(client.input("RunInstancesCommand")).toMatchObject({ SubnetId: managedSubnetId });
    expect(events.map(({ phase }) => phase)).toEqual([
      "key-pair",
      "vpc",
      "internet-gateway",
      "subnet",
      "route-table",
      "route-table",
      "security-group",
      "instance",
      "instance-running",
      "instance-status-ok",
      "system-status-ok",
    ]);
    expect(events.at(-1)?.resources).toMatchObject({
      vpcId: managedVpcId,
      subnetId: managedSubnetId,
      internetGatewayId,
      routeTableId,
      routeTableAssociationId,
    });
  });

  it("rolls back every managed network identity when instance launch fails", async () => {
    const client = createClient({
      ...managedNetworkCreateResponses(),
      RunInstancesCommand: () => { throw awsError("InsufficientInstanceCapacity"); },
    });
    const provider = providerFor(client);

    await expect(provider.create(createInput({
      network: {
        mode: "managed",
        vpcCidrBlock: "10.42.0.0/16",
        subnetCidrBlock: "10.42.1.0/24",
      },
    }))).rejects.toThrow(/InsufficientInstanceCapacity/u);

    const cleanup = client.commandNames().filter((name) => [
      "DeleteKeyPairCommand",
      "DeleteSecurityGroupCommand",
      "DisassociateRouteTableCommand",
      "DeleteRouteCommand",
      "DeleteRouteTableCommand",
      "DeleteSubnetCommand",
      "DetachInternetGatewayCommand",
      "DeleteInternetGatewayCommand",
      "DeleteVpcCommand",
    ].includes(name));
    expect(cleanup).toEqual([
      "DeleteKeyPairCommand",
      "DeleteSecurityGroupCommand",
      "DisassociateRouteTableCommand",
      "DeleteRouteCommand",
      "DeleteRouteTableCommand",
      "DeleteSubnetCommand",
      "DetachInternetGatewayCommand",
      "DeleteInternetGatewayCommand",
      "DeleteVpcCommand",
    ]);
  });

  it("rolls back the dedicated security group if launch fails", async () => {
    const client = createClient({
      RunInstancesCommand: () => {
        throw Object.assign(new Error("raw details"), { name: "InsufficientInstanceCapacity" });
      },
    });
    const provider = providerFor(client);

    await expect(provider.create(createInput())).rejects.toThrow(/InsufficientInstanceCapacity/u);

    expect(client.commandNames()).toContain("DeleteSecurityGroupCommand");
    expect(client.input("DeleteKeyPairCommand")).toEqual({ KeyPairId: keyPairId });
    expect(client.commandNames()).not.toContain("AllocateAddressCommand");
  });
});

describe("AWS EC2 owned lifecycle and firewall operations", () => {
  it("renames only the owned instance's Name tag", async () => {
    const client = managedResourceClient();
    await providerFor(client).rename(resource(), "Operations server");
    expect(client.commandNames()).toEqual(["DescribeInstancesCommand", "CreateTagsCommand"]);
    expect(client.input("CreateTagsCommand")).toEqual({
      Resources: [instanceId], Tags: [{ Key: "Name", Value: "Operations server" }],
    });
  });

  it("rejects a rename before mutation when ownership or the name is invalid", async () => {
    const client = managedResourceClient({ DescribeInstancesCommand: instanceResponse("running", "wrong-owner") });
    await expect(providerFor(client).rename(resource(), "Operations server")).rejects.toThrow(/ownership tags do not match/u);
    expect(client.commandNames()).toEqual(["DescribeInstancesCommand"]);
    const invalid = managedResourceClient();
    await expect(providerFor(invalid).rename(resource(), "bad\nname")).rejects.toThrow(/name is invalid/u);
    expect(invalid.commandNames()).toEqual([]);
  });

  it("sanitizes a provider rename failure", async () => {
    const client = managedResourceClient({ CreateTagsCommand: () => { throw new Error("private provider response"); } });
    await expect(providerFor(client).rename(resource(), "Operations server"))
      .rejects.toThrow("AWS EC2 could not rename the managed instance (Error).");
  });

  it.each([
    { name: "Provider friendly name", valid: true },
    { name: "bad\nname", valid: false },
    { name: "x".repeat(121), valid: false },
  ])("reads only displayable instance Name tags during refresh: $valid", async ({ name, valid }) => {
    const response = instanceResponse("running");
    response.Reservations[0]!.Instances[0]!.Tags = managedTags().map((tag) => tag.Key === "Name" ? { ...tag, Value: name } : tag);
    const client = managedResourceClient({ DescribeInstancesCommand: response });
    const current = resource();
    const refreshed = await providerFor(client).refresh(current);
    expect(refreshed.name).toBe(valid ? name : current.name);
    expect(refreshed.instanceId).toBe(current.instanceId);
    expect(client.commandNames()).not.toContain("CreateTagsCommand");
  });

  it("replaces only tagged Sliver GUI rules in the tracked security group", async () => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [
          {
            SecurityGroupRuleId: ingressRuleId,
            Description: `sliver-gui:${guid}:ssh`,
            Tags: managedTags(),
          },
          {
            SecurityGroupRuleId: "sgr-33333333333333333",
            Description: `sliver-gui:${guid}:ssh`,
            Tags: [{ Key: "Owner", Value: "human" }],
          },
          {
            SecurityGroupRuleId: "sgr-44444444444444444",
            Description: "sliver-gui:5f44a268-802f-47c0-a62e-89c1b3783ba2:ssh",
            Tags: [
              { Key: "SliverGUIManaged", Value: "true" },
              { Key: "SliverGUID", Value: "5f44a268-802f-47c0-a62e-89c1b3783ba2" },
            ],
          },
        ],
      },
    });
    const provider = providerFor(client);

    await provider.replaceFirewall(resource(), {
      sshPort: 2222,
      sshSourceCidrs: ["192.0.2.10/32"],
      multiplayerPort: 31_338,
      multiplayerSourceCidrs: ["198.51.100.0/24"],
    });

    expect(client.input("RevokeSecurityGroupIngressCommand")).toEqual({
      GroupId: securityGroupId,
      SecurityGroupRuleIds: [ingressRuleId],
    });
    expect(client.inputs("AuthorizeSecurityGroupIngressCommand")).toHaveLength(1);
    expect(client.commandNames().indexOf("AuthorizeSecurityGroupIngressCommand"))
      .toBeLessThan(client.commandNames().indexOf("RevokeSecurityGroupIngressCommand"));
  });

  it("authorizes only missing baseline peers before revoking obsolete baseline rules", async () => {
    const retainedRuleId = "sgr-33333333333333333";
    const obsoleteRuleId = "sgr-44444444444444444";
    const customRuleId = "sgr-55555555555555555";
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [
          describedFirewallRule(retainedRuleId, firewallRuleSpec({
            fromPort: 2222,
            toPort: 2222,
            description: `sliver-gui:${guid}:multiplayer`,
          }), managedTags()),
          describedFirewallRule(obsoleteRuleId, firewallRuleSpec({
            fromPort: 31_338,
            toPort: 31_338,
            peer: "198.51.99.0/24",
            description: `sliver-gui:${guid}:multiplayer`,
          }), managedTags()),
          describedFirewallRule(customRuleId, firewallRuleSpec({
            fromPort: 8443,
            toPort: 8443,
            peer: "203.0.113.8/32",
            description: `sliver-gui:${guid}:ssh`,
          }), [
            ...managedTags(),
            { Key: "SliverGUIRuleType", Value: "custom" },
          ]),
        ],
      },
    });
    const provider = providerFor(client);

    await provider.replaceFirewall(resource(), {
      sshPort: 2222,
      sshSourceCidrs: ["192.0.2.10/32", "203.0.113.40/32"],
      multiplayerPort: 31_338,
      multiplayerSourceCidrs: ["198.51.100.0/24"],
    });

    expect(client.input("AuthorizeSecurityGroupIngressCommand")).toEqual({
      GroupId: securityGroupId,
      IpPermissions: [
        {
          IpProtocol: "tcp",
          FromPort: 2222,
          ToPort: 2222,
          IpRanges: [{
            CidrIp: "203.0.113.40/32",
            Description: `sliver-gui:${guid}:ssh`,
          }],
        },
        {
          IpProtocol: "tcp",
          FromPort: 31_338,
          ToPort: 31_338,
          IpRanges: [{
            CidrIp: "198.51.100.0/24",
            Description: `sliver-gui:${guid}:multiplayer`,
          }],
        },
      ],
      TagSpecifications: [{ ResourceType: "security-group-rule", Tags: managedTags() }],
    });
    expect(client.input("RevokeSecurityGroupIngressCommand")).toEqual({
      GroupId: securityGroupId,
      SecurityGroupRuleIds: [obsoleteRuleId],
    });
    expect(client.commandNames().indexOf("AuthorizeSecurityGroupIngressCommand"))
      .toBeLessThan(client.commandNames().indexOf("RevokeSecurityGroupIngressCommand"));
  });

  it("deduplicates overlapping desired baseline access tuples", async () => {
    const client = managedResourceClient();
    const provider = providerFor(client);

    await provider.replaceFirewall(resource(), {
      sshPort: 22,
      sshSourceCidrs: ["192.0.2.10/32"],
      multiplayerPort: 22,
      multiplayerSourceCidrs: ["192.0.2.10/32"],
    });

    expect(client.input("AuthorizeSecurityGroupIngressCommand")).toMatchObject({
      GroupId: securityGroupId,
      IpPermissions: [{
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        IpRanges: [{ CidrIp: "192.0.2.10/32" }],
      }],
    });
    expect(client.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
  });

  it("does not revoke baseline rules when authorizing a replacement fails", async () => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, firewallRuleSpec({
          peer: "198.51.99.0/24",
          description: `sliver-gui:${guid}:ssh`,
        }), managedTags())],
      },
      AuthorizeSecurityGroupIngressCommand: () => {
        throw awsError("UnauthorizedOperation");
      },
    });
    const provider = providerFor(client);

    await expect(provider.replaceFirewall(resource(), {
      sshPort: 22,
      sshSourceCidrs: ["192.0.2.10/32"],
      multiplayerPort: 31_337,
      multiplayerSourceCidrs: ["198.51.100.10/32"],
    })).rejects.toThrow(/authorize managed firewall rules/u);

    expect(client.inputs("AuthorizeSecurityGroupIngressCommand")).toHaveLength(1);
    expect(client.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
  });

  it("preserves custom managed rules when replacing the baseline firewall", async () => {
    const customRuleId = "sgr-55555555555555555";
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [{
          SecurityGroupRuleId: customRuleId,
          Description: `sliver-gui:${guid}:ssh`,
          Tags: [
            ...managedTags(),
            { Key: "SliverGUIRuleType", Value: "custom" },
          ],
        }],
      },
    });
    const provider = providerFor(client);

    await provider.replaceFirewall(resource(), {
      sshPort: 22,
      sshSourceCidrs: ["192.0.2.10/32"],
      multiplayerPort: 31_337,
      multiplayerSourceCidrs: ["198.51.100.10/32"],
    });

    expect(client.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
    expect(client.inputs("AuthorizeSecurityGroupIngressCommand")).toHaveLength(1);
  });

  it("lists and normalizes every paginated ingress and egress peer type", async () => {
    const ipv4 = firewallRuleSpec({
      peer: "0.0.0.0/0",
      description: "Public HTTPS",
      fromPort: 443,
      toPort: 443,
    });
    const ipv6 = firewallRuleSpec({
      direction: "egress",
      protocol: "-1",
      fromPort: null,
      toPort: null,
      peerType: "ipv6",
      peer: "::/0",
      description: null,
    });
    const prefixList = firewallRuleSpec({
      direction: "egress",
      protocol: "udp",
      fromPort: 53,
      toPort: 53,
      peerType: "prefix-list",
      peer: "pl-0123456789abcdef0",
      description: "DNS prefix",
    });
    const referencedGroup = firewallRuleSpec({
      protocol: "icmp",
      fromPort: 8,
      toPort: -1,
      peerType: "security-group",
      peer: "sg-11111111111111111",
      description: "Peer health",
    });
    const client = managedResourceClient({
      DescribeSecurityGroupsCommand: {
        SecurityGroups: [{
          GroupId: securityGroupId,
          GroupName: "sliver-gui-managed",
          VpcId: vpcId,
          Tags: managedTags(),
        }],
      },
      DescribeSecurityGroupRulesCommand: (command: unknown) => {
        const input = commandInput(command);
        return input["NextToken"] === undefined
          ? {
            SecurityGroupRules: [
              describedFirewallRule("sgr-40000000000000000", ipv4, managedTags()),
              // EC2 reports -1/-1 for the default allow-all egress rule.
              describedFirewallRule("sgr-30000000000000000", ipv6, [], { FromPort: -1, ToPort: -1 }),
            ],
            NextToken: "firewall-page-2",
          }
          : {
            SecurityGroupRules: [
              describedFirewallRule("sgr-20000000000000000", prefixList),
              describedFirewallRule("sgr-10000000000000000", referencedGroup),
            ],
          };
      },
    });
    const provider = providerFor(client);

    await expect(provider.listFirewallRules(resource())).resolves.toEqual({
      provider: "aws",
      securityGroupId,
      securityGroupName: "sliver-gui-managed",
      vpcId,
      rules: [
        { id: "sgr-10000000000000000", ...referencedGroup, managed: false },
        { id: "sgr-20000000000000000", ...prefixList, managed: false },
        { id: "sgr-30000000000000000", ...ipv6, managed: false },
        { id: "sgr-40000000000000000", ...ipv4, managed: true },
      ],
    });
    expect(client.inputs("DescribeSecurityGroupRulesCommand")).toEqual([
      { Filters: [{ Name: "group-id", Values: [securityGroupId] }] },
      { Filters: [{ Name: "group-id", Values: [securityGroupId] }], NextToken: "firewall-page-2" },
    ]);
  });

  it("normalizes omitted ICMPv6 ports as all types and codes", async () => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [{
          SecurityGroupRuleId: ingressRuleId,
          GroupId: securityGroupId,
          IsEgress: false,
          IpProtocol: "icmpv6",
          CidrIpv6: "2001:db8::/64",
          Description: "IPv6 diagnostics",
          Tags: managedTags(),
        }],
      },
    });

    await expect(providerFor(client).listFirewallRules(resource())).resolves.toMatchObject({
      rules: [{
        id: ingressRuleId,
        direction: "ingress",
        protocol: "icmpv6",
        fromPort: -1,
        toPort: -1,
        peerType: "ipv6",
        peer: "2001:db8::/64",
        description: "IPv6 diagnostics",
        managed: true,
      }],
    });
  });

  it.each([
    ["all-protocol", "-1", -1, -1],
    ["numeric-protocol", "6", 22, 443],
  ])("ignores AWS-reported port fields for an %s rule", async (_case, protocol, fromPort, toPort) => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [{
          SecurityGroupRuleId: ingressRuleId,
          GroupId: securityGroupId,
          IsEgress: false,
          IpProtocol: protocol,
          FromPort: fromPort,
          ToPort: toPort,
          CidrIpv4: "192.0.2.0/24",
        }],
      },
    });

    await expect(providerFor(client).listFirewallRules(resource())).resolves.toMatchObject({
      rules: [{ protocol, fromPort: null, toPort: null }],
    });
  });

  it.each([
    ["another group", {
      ...describedFirewallRule(ingressRuleId, firewallRuleSpec()),
      GroupId: "sg-11111111111111111",
    }],
    ["multiple peers", {
      ...describedFirewallRule(ingressRuleId, firewallRuleSpec()),
      CidrIpv6: "2001:db8::/64",
    }],
  ])("rejects a listed firewall rule from %s", async (_case, rule) => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: { SecurityGroupRules: [rule] },
    });

    await expect(providerFor(client).listFirewallRules(resource())).rejects.toThrow(/security group rule/u);
  });

  it("creates and tags one managed ingress IPv4 rule", async () => {
    const spec = firewallRuleSpec({
      fromPort: 443,
      toPort: 8443,
      peer: "0.0.0.0/0",
      description: "Public TLS",
    });
    const client = managedResourceClient({
      AuthorizeSecurityGroupIngressCommand: {
        Return: true,
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, spec, [
          ...managedTags(),
          { Key: "SliverGUIRuleType", Value: "custom" },
        ])],
      },
    });
    const provider = providerFor(client);

    await expect(provider.createFirewallRule(resource(), spec)).resolves.toEqual({
      id: ingressRuleId,
      ...spec,
      managed: true,
    });
    expect(client.input("AuthorizeSecurityGroupIngressCommand")).toEqual({
      GroupId: securityGroupId,
      IpPermissions: [{
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 8443,
        IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Public TLS" }],
      }],
      TagSpecifications: [{
        ResourceType: "security-group-rule",
        Tags: [
          ...managedTags(),
          { Key: "SliverGUIRuleType", Value: "custom" },
        ],
      }],
    });
  });

  it("accepts the canonical CIDR returned by AWS after creating a rule", async () => {
    const requested = firewallRuleSpec({ peer: "100.68.0.18/18" });
    const canonical = firewallRuleSpec({ peer: "100.68.0.0/18" });
    const client = managedResourceClient({
      AuthorizeSecurityGroupIngressCommand: {
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, canonical, managedTags())],
      },
    });

    await expect(providerFor(client).createFirewallRule(resource(), requested)).resolves.toMatchObject({
      id: ingressRuleId,
      peer: "100.68.0.0/18",
    });
    expect(client.input("AuthorizeSecurityGroupIngressCommand")).toMatchObject({
      IpPermissions: [{ IpRanges: [{ CidrIp: "100.68.0.18/18" }] }],
    });
  });

  it("creates a managed allow-all IPv6 egress rule with the egress API", async () => {
    const spec = firewallRuleSpec({
      direction: "egress",
      protocol: "-1",
      fromPort: null,
      toPort: null,
      peerType: "ipv6",
      peer: "::/0",
      description: null,
    });
    const client = managedResourceClient({
      AuthorizeSecurityGroupEgressCommand: {
        Return: true,
        SecurityGroupRules: [describedFirewallRule(egressRuleId, spec, managedTags(), {
          FromPort: -1,
          ToPort: -1,
        })],
      },
    });

    await expect(providerFor(client).createFirewallRule(resource(), spec)).resolves.toMatchObject({
      id: egressRuleId,
      ...spec,
      managed: true,
    });
    expect(client.input("AuthorizeSecurityGroupEgressCommand")).toMatchObject({
      GroupId: securityGroupId,
      IpPermissions: [{ IpProtocol: "-1", Ipv6Ranges: [{ CidrIpv6: "::/0" }] }],
    });
    expect(client.commandNames()).not.toContain("AuthorizeSecurityGroupIngressCommand");
  });

  it("updates an exact unmanaged rule without changing its direction or peer type", async () => {
    const original = firewallRuleSpec({
      direction: "egress",
      protocol: "udp",
      fromPort: 53,
      toPort: 53,
      peerType: "prefix-list",
      peer: "pl-0123456789abcdef0",
      description: "Original DNS",
    });
    const updated = { ...original, toPort: 5353, description: "DNS services" } satisfies AwsFirewallRuleSpec;
    let reads = 0;
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: () => ({
        SecurityGroupRules: [describedFirewallRule(
          egressRuleId,
          reads++ === 0 ? original : updated,
          [{ Key: "Owner", Value: "human" }],
        )],
      }),
      ModifySecurityGroupRulesCommand: { Return: true },
    });
    const provider = providerFor(client);

    await expect(provider.updateFirewallRule(resource(), egressRuleId, updated)).resolves.toEqual({
      id: egressRuleId,
      ...updated,
      managed: false,
    });
    expect(client.input("ModifySecurityGroupRulesCommand")).toEqual({
      GroupId: securityGroupId,
      SecurityGroupRules: [{
        SecurityGroupRuleId: egressRuleId,
        SecurityGroupRule: {
          IpProtocol: "udp",
          FromPort: 53,
          ToPort: 5353,
          PrefixListId: "pl-0123456789abcdef0",
          Description: "DNS services",
        },
      }],
    });
    expect(client.commandNames().slice(0, 4)).toEqual([
      "DescribeSecurityGroupsCommand",
      "DescribeSecurityGroupRulesCommand",
      "ModifySecurityGroupRulesCommand",
      "DescribeSecurityGroupRulesCommand",
    ]);
  });

  it.each([
    ["direction", firewallRuleSpec({ direction: "egress" })],
    ["peer type", firewallRuleSpec({ peerType: "ipv6", peer: "2001:db8::/64" })],
  ])("refuses to update a firewall rule's %s", async (_case, updated) => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, firewallRuleSpec())],
      },
    });
    const provider = providerFor(client);

    await expect(provider.updateFirewallRule(resource(), ingressRuleId, updated)).rejects.toThrow(/cannot change/u);
    expect(client.commandNames()).not.toContain("ModifySecurityGroupRulesCommand");
  });

  it.each([
    ["ingress", ingressRuleId, "RevokeSecurityGroupIngressCommand"],
    ["egress", egressRuleId, "RevokeSecurityGroupEgressCommand"],
  ] as const)("deletes an exact unmanaged %s rule with the direction-specific API", async (
    direction,
    ruleId,
    expectedCommand,
  ) => {
    const spec = firewallRuleSpec({ direction });
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(ruleId, spec, [{ Key: "Owner", Value: "human" }])],
      },
    });

    await providerFor(client).deleteFirewallRule(resource(), ruleId);

    expect(client.input(expectedCommand)).toEqual({
      GroupId: securityGroupId,
      SecurityGroupRuleIds: [ruleId],
    });
  });

  it("deletes a managed firewall rule only when its current spec still matches", async () => {
    const expected = firewallRuleSpec({ description: "sliver-gui:listener:tcp:22" });
    const matchingClient = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, expected, managedTags())],
      },
    });

    await expect(
      providerFor(matchingClient).deleteFirewallRuleIfMatches(resource(), ingressRuleId, expected),
    ).resolves.toBe(true);
    expect(matchingClient.input("RevokeSecurityGroupIngressCommand")).toEqual({
      GroupId: securityGroupId,
      SecurityGroupRuleIds: [ingressRuleId],
    });

    const changedClient = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(
          ingressRuleId,
          { ...expected, fromPort: 8_443, toPort: 8_443 },
          managedTags(),
        )],
      },
    });
    await expect(
      providerFor(changedClient).deleteFirewallRuleIfMatches(resource(), ingressRuleId, expected),
    ).resolves.toBe(false);
    expect(changedClient.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
    expect(changedClient.commandNames()).not.toContain("RevokeSecurityGroupEgressCommand");
  });

  it("refuses a rule mutation when the security group ownership does not match", async () => {
    const client = managedResourceClient({
      DescribeSecurityGroupsCommand: securityGroupResponse("5f44a268-802f-47c0-a62e-89c1b3783ba2"),
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [describedFirewallRule(ingressRuleId, firewallRuleSpec())],
      },
    });

    await expect(providerFor(client).deleteFirewallRule(resource(), ingressRuleId)).rejects.toThrow(
      /ownership tags do not match/u,
    );
    expect(client.commandNames()).not.toContain("DescribeSecurityGroupRulesCommand");
    expect(client.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
  });

  it("refuses a rule returned for a different security group before mutating it", async () => {
    const client = managedResourceClient({
      DescribeSecurityGroupRulesCommand: {
        SecurityGroupRules: [{
          ...describedFirewallRule(ingressRuleId, firewallRuleSpec()),
          GroupId: "sg-11111111111111111",
        }],
      },
    });

    await expect(providerFor(client).deleteFirewallRule(resource(), ingressRuleId)).rejects.toThrow(
      /unexpected group/u,
    );
    expect(client.commandNames()).not.toContain("RevokeSecurityGroupIngressCommand");
  });

  it.each([
    ["unsupported protocol", { protocol: "all" }],
    ["out-of-range numeric protocol", { protocol: "256" }],
    ["noncanonical numeric protocol", { protocol: "01" }],
    ["missing TCP ports", { fromPort: null, toPort: null }],
    ["reversed TCP ports", { fromPort: 443, toPort: 22 }],
    ["out-of-range TCP port", { fromPort: 0, toPort: 65_536 }],
    ["invalid ICMP wildcard", { protocol: "icmp", fromPort: -1, toPort: 0 }],
    ["numeric protocol ports", { protocol: "6", fromPort: 22, toPort: 22 }],
    ["wrong-family CIDR", { peerType: "ipv4", peer: "2001:db8::/64" }],
    ["out-of-range CIDR", { peer: "192.0.2.0/33" }],
    ["invalid prefix list", { peerType: "prefix-list", peer: "pl-not-hex" }],
    ["invalid security group", { peerType: "security-group", peer: "sg-not-hex" }],
    ["invalid description", { description: "not ☃ allowed" }],
  ])("rejects a firewall rule with %s before any AWS call", async (_case, overrides) => {
    const client = managedResourceClient();
    const invalid = { ...firewallRuleSpec(), ...overrides } as AwsFirewallRuleSpec;

    await expect(providerFor(client).createFirewallRule(resource(), invalid)).rejects.toThrow(/firewall rule/u);
    expect(client.commands).toHaveLength(0);
  });

  it("rejects an invalid security group rule ID before any AWS call", async () => {
    const client = managedResourceClient();

    await expect(providerFor(client).deleteFirewallRule(resource(), "sgr-not-hex")).rejects.toThrow(
      /security group rule ID is invalid/u,
    );
    expect(client.commands).toHaveLength(0);
  });

  it("refuses destructive operations when either resource has mismatched GUID tags", async () => {
    const client = managedResourceClient({
      DescribeInstancesCommand: instanceResponse("running", "5f44a268-802f-47c0-a62e-89c1b3783ba2"),
    });
    const provider = providerFor(client);

    await expect(provider.destroy(resource())).rejects.toThrow(/ownership tags do not match/u);

    expect(client.commandNames()).not.toContain("TerminateInstancesCommand");
    expect(client.commandNames()).not.toContain("DeleteSecurityGroupCommand");
    expect(client.commandNames()).not.toContain("ReleaseAddressCommand");
  });

  it.each([
    ["EBS volume", { DescribeVolumesCommand: volumeResponse("5f44a268-802f-47c0-a62e-89c1b3783ba2") }],
    ["network interface", {
      DescribeNetworkInterfacesCommand: networkInterfaceResponse("5f44a268-802f-47c0-a62e-89c1b3783ba2"),
    }],
  ])("refuses destruction when a tracked %s has mismatched GUID tags", async (_kind, overrides) => {
    const client = managedResourceClient(overrides);
    const provider = providerFor(client);

    await expect(provider.destroy(resource())).rejects.toThrow(/ownership tags do not match/u);

    expect(client.commandNames()).not.toContain("TerminateInstancesCommand");
    expect(client.commandNames()).not.toContain("DeleteVolumeCommand");
    expect(client.commandNames()).not.toContain("DeleteNetworkInterfaceCommand");
    expect(client.commandNames()).not.toContain("DeleteSecurityGroupCommand");
  });

  it("verifies ownership before releasing the Elastic IP, terminating, and deleting managed resources", async () => {
    const client = managedResourceClient();
    const waiters = waiterSpies();
    const provider = providerFor(client, waiters);

    await provider.destroy(resource());

    const mutations = client.commandNames().filter((name) => [
      "DisassociateAddressCommand",
      "ReleaseAddressCommand",
      "TerminateInstancesCommand",
      "DeleteNetworkInterfaceCommand",
      "DeleteVolumeCommand",
      "DeleteSecurityGroupCommand",
      "DeleteKeyPairCommand",
    ].includes(name));
    expect(mutations).toEqual([
      "DisassociateAddressCommand",
      "ReleaseAddressCommand",
      "TerminateInstancesCommand",
      "DeleteNetworkInterfaceCommand",
      "DeleteVolumeCommand",
      "DeleteSecurityGroupCommand",
      "DeleteKeyPairCommand",
    ]);
    expect(waiters.terminated).toHaveBeenCalledWith(client, instanceId);
  });

  it("does not inspect, tag, or delete a selected existing SSH key pair during destruction", async () => {
    const client = managedResourceClient();
    const provider = providerFor(client);

    await provider.destroy({
      ...resource(),
      keyPair: { id: keyPairId, name: "operator-key", managed: false },
    });

    expect(client.commandNames()).not.toContain("DescribeKeyPairsCommand");
    expect(client.commandNames()).not.toContain("DeleteKeyPairCommand");
  });

  it("verifies tags before deleting a managed route table, subnet, gateway, and VPC", async () => {
    const client = managedResourceClient(managedNetworkOwnershipResponses());
    const provider = providerFor(client);

    await provider.destroy({
      ...resource(),
      managedNetwork: {
        vpcId: managedVpcId,
        subnetId: managedSubnetId,
        internetGatewayId,
        routeTableId,
        routeTableAssociationId,
      },
    });

    const networkCleanup = client.commandNames().filter((name) => [
      "DisassociateRouteTableCommand",
      "DeleteRouteCommand",
      "DeleteRouteTableCommand",
      "DeleteSubnetCommand",
      "DetachInternetGatewayCommand",
      "DeleteInternetGatewayCommand",
      "DeleteVpcCommand",
    ].includes(name));
    expect(networkCleanup).toEqual([
      "DisassociateRouteTableCommand",
      "DeleteRouteCommand",
      "DeleteRouteTableCommand",
      "DeleteSubnetCommand",
      "DetachInternetGatewayCommand",
      "DeleteInternetGatewayCommand",
      "DeleteVpcCommand",
    ]);
  });

  it("refuses managed-network destruction when any network ownership tag is mismatched", async () => {
    const client = managedResourceClient({
      ...managedNetworkOwnershipResponses(),
      DescribeRouteTablesCommand: {
        RouteTables: [{
          RouteTableId: routeTableId,
          VpcId: managedVpcId,
          Tags: managedTags("5f44a268-802f-47c0-a62e-89c1b3783ba2"),
        }],
      },
    });
    const provider = providerFor(client);

    await expect(provider.destroy({
      ...resource(),
      managedNetwork: {
        vpcId: managedVpcId,
        subnetId: managedSubnetId,
        internetGatewayId,
        routeTableId,
        routeTableAssociationId,
      },
    })).rejects.toThrow(/ownership tags do not match/u);

    expect(client.commandNames()).not.toContain("TerminateInstancesCommand");
    expect(client.commandNames()).not.toContain("DeleteVpcCommand");
  });

  it("treats already-missing tracked resources as a successful destroy", async () => {
    const client = managedResourceClient({
      DescribeInstancesCommand: () => { throw awsError("InvalidInstanceID.NotFound"); },
      DescribeSecurityGroupsCommand: () => { throw awsError("InvalidGroup.NotFound"); },
      DescribeAddressesCommand: () => { throw awsError("InvalidAllocationID.NotFound"); },
      DescribeKeyPairsCommand: () => { throw awsError("InvalidKeyPair.NotFound"); },
      DescribeVolumesCommand: () => { throw awsError("InvalidVolume.NotFound"); },
      DescribeNetworkInterfacesCommand: () => { throw awsError("InvalidNetworkInterfaceID.NotFound"); },
    });
    const provider = providerFor(client);

    await expect(provider.destroy(resource())).resolves.toBeUndefined();

    expect(client.commandNames()).not.toContain("TerminateInstancesCommand");
    expect(client.commandNames()).not.toContain("DeleteSecurityGroupCommand");
    expect(client.commandNames()).not.toContain("DeleteKeyPairCommand");
    expect(client.commandNames()).not.toContain("DeleteVolumeCommand");
    expect(client.commandNames()).not.toContain("DeleteNetworkInterfaceCommand");
    expect(client.commandNames()).not.toContain("ReleaseAddressCommand");
  });

  it("retries cleanup after earlier mutations succeeded and security-group deletion failed", async () => {
    let instanceExists = true;
    let addressExists = true;
    let volumeExists = true;
    let networkInterfaceExists = true;
    let securityGroupDeleteAttempts = 0;
    const client = managedResourceClient({
      DescribeInstancesCommand: () => {
        if (!instanceExists) throw awsError("InvalidInstanceID.NotFound");
        return instanceResponse("running");
      },
      DescribeAddressesCommand: () => {
        if (!addressExists) throw awsError("InvalidAllocationID.NotFound");
        return addressResponse();
      },
      ReleaseAddressCommand: () => {
        addressExists = false;
        return {};
      },
      TerminateInstancesCommand: () => {
        instanceExists = false;
        return {};
      },
      DescribeVolumesCommand: () => {
        if (!volumeExists) throw awsError("InvalidVolume.NotFound");
        return volumeResponse();
      },
      DescribeNetworkInterfacesCommand: () => {
        if (!networkInterfaceExists) throw awsError("InvalidNetworkInterfaceID.NotFound");
        return networkInterfaceResponse();
      },
      DeleteVolumeCommand: () => {
        volumeExists = false;
        return {};
      },
      DeleteNetworkInterfaceCommand: () => {
        networkInterfaceExists = false;
        return {};
      },
      DeleteSecurityGroupCommand: () => {
        securityGroupDeleteAttempts += 1;
        if (securityGroupDeleteAttempts === 1) throw awsError("DependencyViolation");
        return {};
      },
    });
    const provider = providerFor(client);

    await expect(provider.destroy(resource())).rejects.toThrow(/DependencyViolation/u);
    await expect(provider.destroy(resource())).resolves.toBeUndefined();

    expect(client.inputs("ReleaseAddressCommand")).toHaveLength(1);
    expect(client.inputs("TerminateInstancesCommand")).toHaveLength(1);
    expect(client.inputs("DeleteVolumeCommand")).toHaveLength(1);
    expect(client.inputs("DeleteNetworkInterfaceCommand")).toHaveLength(1);
    expect(client.inputs("DeleteSecurityGroupCommand")).toHaveLength(2);
    expect(client.inputs("DeleteKeyPairCommand")).toHaveLength(1);
  });

  it("retries partial volume and network-interface cleanup after a delete response is lost", async () => {
    let volumeExists = true;
    let networkInterfaceExists = true;
    const client = managedResourceClient({
      DescribeVolumesCommand: () => {
        if (!volumeExists) throw awsError("InvalidVolume.NotFound");
        return volumeResponse();
      },
      DescribeNetworkInterfacesCommand: () => {
        if (!networkInterfaceExists) throw awsError("InvalidNetworkInterfaceID.NotFound");
        return networkInterfaceResponse();
      },
      DeleteNetworkInterfaceCommand: () => {
        networkInterfaceExists = false;
        return {};
      },
      DeleteVolumeCommand: () => {
        volumeExists = false;
        throw new Error("connection closed after AWS accepted the delete");
      },
    });
    const provider = providerFor(client);
    const tracked = {
      guid,
      name: "Red team server",
      region,
      volumeIds: [volumeId],
      networkInterfaceIds: [networkInterfaceId],
    } as const;

    await expect(provider.destroy(tracked)).rejects.toThrow(/delete the managed EBS volume/u);
    await expect(provider.destroy(tracked)).resolves.toBeUndefined();

    expect(client.inputs("DeleteVolumeCommand")).toHaveLength(1);
    expect(client.inputs("DeleteNetworkInterfaceCommand")).toHaveLength(1);
  });

  it("cleans up a partially journaled key pair", async () => {
    const client = managedResourceClient();
    const provider = providerFor(client);

    await provider.destroy({
      guid,
      name: "Red team server",
      region,
      keyPair: { id: keyPairId, name: keyPairName },
    });

    expect(client.commandNames()).toEqual(["DescribeKeyPairsCommand", "DeleteKeyPairCommand"]);
  });

  it("still enforces GUID ownership for a partially journaled key pair", async () => {
    const client = managedResourceClient({
      DescribeKeyPairsCommand: {
        KeyPairs: [{
          KeyPairId: keyPairId,
          KeyName: keyPairName,
          Tags: managedTags("5f44a268-802f-47c0-a62e-89c1b3783ba2"),
        }],
      },
    });
    const provider = providerFor(client);

    await expect(provider.destroy({
      guid,
      name: "Red team server",
      region,
      keyPair: { id: keyPairId, name: keyPairName },
    })).rejects.toThrow(/ownership tags do not match/u);
    expect(client.commandNames()).not.toContain("DeleteKeyPairCommand");
  });

  it("uses a graceful EC2 stop and waits for the stopped state", async () => {
    const client = managedResourceClient();
    const waiters = waiterSpies();
    const provider = providerFor(client, waiters);

    await provider.stop(resource());

    expect(client.input("StopInstancesCommand")).toEqual({
      InstanceIds: [instanceId],
      Force: false,
      SkipOsShutdown: false,
    });
    expect(waiters.stopped).toHaveBeenCalledWith(client, instanceId);
  });

  it("starts and reboots only after checking instance ownership", async () => {
    const client = managedResourceClient({
      DescribeInstancesCommand: instanceResponse("stopped"),
    });
    const waiters = waiterSpies();
    const provider = providerFor(client, waiters);

    await provider.start(resource());
    await provider.reboot(resource());

    expect(client.input("StartInstancesCommand")).toEqual({ InstanceIds: [instanceId] });
    expect(client.input("RebootInstancesCommand")).toEqual({ InstanceIds: [instanceId] });
    expect(waiters.running).toHaveBeenCalledTimes(2);
    expect(waiters.instanceStatusOk).toHaveBeenCalledTimes(2);
    expect(waiters.systemStatusOk).toHaveBeenCalledTimes(2);
  });
});

describe("AWS EC2 provider refresh cancellation", () => {
  it("aborts every in-flight status read and sanitizes cancellation failures", async () => {
    const client = managedResourceClient();
    const controller = new AbortController();
    const readSignals: AbortSignal[] = [];
    let abortedReads = 0;
    vi.spyOn(client, "send").mockImplementation((_command, options) => {
      const signal = options?.abortSignal;
      if (!signal) return Promise.reject(new Error("Missing refresh cancellation signal"));
      readSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          abortedReads += 1;
          reject(Object.assign(new Error("private cancellation details"), { name: "AbortError" }));
        }, { once: true });
      });
    });

    const pending = providerFor(client).refresh(resource(), controller.signal);
    expect(readSignals).toEqual(Array.from({ length: 4 }, () => controller.signal));
    controller.abort("private cancellation reason");
    const error: unknown = await pending.catch((failure: unknown) => failure);

    expect(abortedReads).toBe(4);
    expect(String(error)).toContain("AbortError");
    expect(String(error)).not.toContain("private cancellation");
  });

  it("does not send requests for an already cancelled refresh", async () => {
    const client = managedResourceClient();
    const controller = new AbortController();
    controller.abort("private cancellation reason");

    await expect(providerFor(client).refresh(resource(), controller.signal))
      .rejects.toThrow("AWS EC2 status refresh was cancelled.");

    expect(client.commandNames()).toEqual([]);
  });
});

class RecordingEc2Client implements AwsEc2ClientLike {
  readonly commands: unknown[] = [];

  constructor(private readonly responses: Readonly<Record<string, unknown | ((command: unknown) => unknown)>>) {}

  async send(command: unknown, _options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    this.commands.push(command);
    const name = commandName(command);
    const response = this.responses[name];
    if (typeof response === "function") return response(command);
    if (response === undefined) return {};
    return response;
  }

  commandNames(): string[] {
    return this.commands.map(commandName);
  }

  input(name: string): Record<string, unknown> {
    const command = this.commands.find((candidate) => commandName(candidate) === name);
    if (!command) throw new Error(`Missing recorded ${name}`);
    return commandInput(command);
  }

  inputs(name: string): Record<string, unknown>[] {
    return this.commands.filter((candidate) => commandName(candidate) === name).map(commandInput);
  }
}

function commandName(command: unknown): string {
  if (typeof command !== "object" || command === null) return "";
  return (command as { constructor?: { name?: string } }).constructor?.name ?? "";
}

function commandInput(command: unknown): Record<string, unknown> {
  if (typeof command !== "object" || command === null) return {};
  const input = (command as { input?: unknown }).input;
  return typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
}

function awsError(code: string): Error {
  return Object.assign(new Error("sensitive AWS details"), { name: code });
}

function providerFor(client: RecordingEc2Client, waiters = waiterSpies()): AwsEc2Provider {
  return new AwsEc2Provider(
    { region, credentials },
    { clientFactory: () => client, waiters },
  );
}

function waiterSpies(): AwsEc2Waiters {
  return {
    running: vi.fn(async () => undefined),
    instanceStatusOk: vi.fn(async () => undefined),
    systemStatusOk: vi.fn(async () => undefined),
    stopped: vi.fn(async () => undefined),
    terminated: vi.fn(async () => undefined),
    subnetAvailable: vi.fn(async () => undefined),
    vpcAvailable: vi.fn(async () => undefined),
  };
}

function createInput(overrides: Partial<AwsEc2CreateInput> = {}): AwsEc2CreateInput {
  return {
    guid,
    name: "Red team server",
    imageId,
    instanceType: "t3.small",
    network: { mode: "existing", vpcId, subnetId },
    sshPublicKey,
    userData: "#cloud-config\n",
    rootVolumeSizeGiB: 24,
    firewall: {
      sshPort: 22,
      sshSourceCidrs: ["198.51.100.8/32"],
      multiplayerPort: 31_337,
      multiplayerSourceCidrs: ["2001:db8::/64"],
    },
    allocateElasticIp: true,
    ...overrides,
  };
}

function createClient(overrides: Readonly<Record<string, unknown | (() => unknown)>> = {}): RecordingEc2Client {
  return new RecordingEc2Client({
    DescribeImagesCommand: {
      Images: [{
        ImageId: imageId,
        State: "available",
        Architecture: "x86_64",
        RootDeviceType: "ebs",
        RootDeviceName: "/dev/sda1",
      }],
    },
    DescribeSubnetsCommand: { Subnets: [{ SubnetId: subnetId, VpcId: vpcId }] },
    ImportKeyPairCommand: { KeyPairId: keyPairId, KeyName: keyPairName, Tags: managedTags() },
    DescribeKeyPairsCommand: { KeyPairs: [{ KeyPairId: keyPairId, KeyName: keyPairName, Tags: managedTags() }] },
    CreateSecurityGroupCommand: { GroupId: securityGroupId },
    AuthorizeSecurityGroupIngressCommand: { Return: true },
    RunInstancesCommand: { Instances: [{ InstanceId: instanceId }] },
    AllocateAddressCommand: { AllocationId: allocationId, PublicIp: "203.0.113.40" },
    AssociateAddressCommand: { AssociationId: associationId },
    DescribeInstancesCommand: instanceResponse("running"),
    DescribeSecurityGroupsCommand: securityGroupResponse(),
    DescribeInstanceStatusCommand: statusResponse(),
    DescribeAddressesCommand: addressResponse(),
    ...overrides,
  });
}

function managedNetworkCreateResponses(): Readonly<Record<string, unknown>> {
  return {
    CreateVpcCommand: { Vpc: { VpcId: managedVpcId } },
    CreateInternetGatewayCommand: { InternetGateway: { InternetGatewayId: internetGatewayId } },
    CreateSubnetCommand: { Subnet: { SubnetId: managedSubnetId, VpcId: managedVpcId } },
    CreateRouteTableCommand: { RouteTable: { RouteTableId: routeTableId, VpcId: managedVpcId } },
    AssociateRouteTableCommand: { AssociationId: routeTableAssociationId },
  };
}

function managedNetworkOwnershipResponses(): Readonly<Record<string, unknown>> {
  return {
    DescribeVpcsCommand: {
      Vpcs: [{ VpcId: managedVpcId, CidrBlock: "10.42.0.0/16", Tags: managedTags() }],
    },
    DescribeSubnetsCommand: {
      Subnets: [{ SubnetId: managedSubnetId, VpcId: managedVpcId, Tags: managedTags() }],
    },
    DescribeInternetGatewaysCommand: {
      InternetGateways: [{
        InternetGatewayId: internetGatewayId,
        Attachments: [{ VpcId: managedVpcId, State: "available" }],
        Tags: managedTags(),
      }],
    },
    DescribeRouteTablesCommand: {
      RouteTables: [{
        RouteTableId: routeTableId,
        VpcId: managedVpcId,
        Associations: [{ RouteTableAssociationId: routeTableAssociationId, SubnetId: managedSubnetId }],
        Tags: managedTags(),
      }],
    },
  };
}

function managedResourceClient(
  overrides: Readonly<Record<string, unknown | (() => unknown)>> = {},
): RecordingEc2Client {
  return new RecordingEc2Client({
    DescribeInstancesCommand: instanceResponse("running"),
    DescribeSecurityGroupsCommand: securityGroupResponse(),
    DescribeInstanceStatusCommand: statusResponse(),
    DescribeAddressesCommand: addressResponse(),
    DescribeKeyPairsCommand: { KeyPairs: [{ KeyPairId: keyPairId, KeyName: keyPairName, Tags: managedTags() }] },
    DescribeSecurityGroupRulesCommand: { SecurityGroupRules: [] },
    DescribeVolumesCommand: volumeResponse(),
    DescribeNetworkInterfacesCommand: networkInterfaceResponse(),
    ...overrides,
  });
}

function managedTags(tagGuid = guid) {
  return [
    { Key: "SliverGUIManaged", Value: "true" },
    { Key: "SliverGUID", Value: tagGuid },
    { Key: "Name", Value: "Red team server" },
  ];
}

function instanceResponse(state: string, tagGuid = guid) {
  return {
    Reservations: [{
      Instances: [{
        InstanceId: instanceId,
        State: { Name: state },
        PrivateIpAddress: "10.0.1.8",
        PublicIpAddress: "198.51.100.200",
        Placement: { AvailabilityZone: "us-west-2a" },
        BlockDeviceMappings: [{ Ebs: { VolumeId: volumeId } }],
        NetworkInterfaces: [{ NetworkInterfaceId: networkInterfaceId }],
        Tags: managedTags(tagGuid),
      }],
    }],
  };
}

function securityGroupResponse(tagGuid = guid) {
  return {
    SecurityGroups: [{ GroupId: securityGroupId, Tags: managedTags(tagGuid) }],
  };
}

function statusResponse() {
  return {
    InstanceStatuses: [{
      InstanceId: instanceId,
      InstanceStatus: { Status: "ok" },
      SystemStatus: { Status: "ok" },
    }],
  };
}

function addressResponse(tagGuid = guid) {
  return {
    Addresses: [{
      AllocationId: allocationId,
      AssociationId: associationId,
      PublicIp: "203.0.113.40",
      Tags: managedTags(tagGuid),
    }],
  };
}

function volumeResponse(tagGuid = guid) {
  return {
    Volumes: [{ VolumeId: volumeId, State: "available", Tags: managedTags(tagGuid) }],
  };
}

function networkInterfaceResponse(tagGuid = guid) {
  return {
    NetworkInterfaces: [{
      NetworkInterfaceId: networkInterfaceId,
      Status: "available",
      TagSet: managedTags(tagGuid),
    }],
  };
}

function officialUbuntuImage(id: string, architecture: "amd64" | "arm64", creationDate: string) {
  const releaseDate = creationDate.slice(0, 10).replaceAll("-", "");
  return {
    ImageId: id,
    OwnerId: "099720109477",
    Name: `ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${architecture}-server-${releaseDate}`,
    Description: "Ubuntu Server 24.04 LTS",
    Architecture: architecture === "amd64" ? "x86_64" : "arm64",
    RootDeviceName: "/dev/sda1",
    CreationDate: creationDate,
  };
}

function amazonLinuxImage(id: string, architecture: "x86_64" | "arm64", creationDate: string) {
  const releaseDate = creationDate.slice(0, 10).replaceAll("-", "");
  return {
    ImageId: id,
    ImageOwnerAlias: "amazon",
    Name: `al2023-ami-2023.9.${releaseDate}.0-kernel-6.1-${architecture}`,
    Description: "Amazon Linux 2023",
    Architecture: architecture,
    RootDeviceName: "/dev/xvda",
    CreationDate: creationDate,
  };
}

function firewallRuleSpec(overrides: Partial<AwsFirewallRuleSpec> = {}): AwsFirewallRuleSpec {
  return {
    direction: "ingress",
    protocol: "tcp",
    fromPort: 22,
    toPort: 22,
    peerType: "ipv4",
    peer: "192.0.2.10/32",
    description: "Operator access",
    ...overrides,
  };
}

function describedFirewallRule(
  id: string,
  spec: AwsFirewallRuleSpec,
  tags: readonly Record<string, string>[] = [],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    SecurityGroupRuleId: id,
    GroupId: securityGroupId,
    IsEgress: spec.direction === "egress",
    IpProtocol: spec.protocol,
    ...(spec.fromPort === null ? {} : { FromPort: spec.fromPort, ToPort: spec.toPort }),
    ...(spec.peerType === "ipv4" ? { CidrIpv4: spec.peer } : {}),
    ...(spec.peerType === "ipv6" ? { CidrIpv6: spec.peer } : {}),
    ...(spec.peerType === "prefix-list" ? { PrefixListId: spec.peer } : {}),
    ...(spec.peerType === "security-group" ? { ReferencedGroupInfo: { GroupId: spec.peer } } : {}),
    ...(spec.description === null ? {} : { Description: spec.description }),
    Tags: tags,
    ...overrides,
  };
}

function resource(): AwsEc2DeploymentResource {
  return {
    guid,
    name: "Red team server",
    region,
    keyPair: { id: keyPairId, name: keyPairName },
    instanceId,
    securityGroupId,
    volumeIds: [volumeId],
    networkInterfaceIds: [networkInterfaceId],
    state: "running",
    instanceHealth: "ok",
    systemHealth: "ok",
    privateIpAddress: "10.0.1.8",
    publicIpAddress: "203.0.113.40",
    elasticIp: { allocationId, associationId, publicIp: "203.0.113.40" },
  };
}
