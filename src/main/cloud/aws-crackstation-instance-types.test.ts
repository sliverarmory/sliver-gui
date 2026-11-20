import { DescribeImagesCommand, DescribeInstanceTypeOfferingsCommand, DescribeInstanceTypesCommand, DescribeInternetGatewaysCommand, DescribeRouteTablesCommand, DescribeSubnetsCommand, RunInstancesCommand } from "@aws-sdk/client-ec2";
import { describe, expect, it, vi } from "vitest";

import { AwsEc2Provider } from "./aws-ec2-provider.js";

function gpuType(name: string, manufacturer = "NVIDIA", architecture = "x86_64") {
  return {
    InstanceType: name, SupportedInRegion: true,
    ProcessorInfo: { SupportedArchitectures: [architecture] },
    VCpuInfo: { DefaultVCpus: 4 }, MemoryInfo: { SizeInMiB: 16_384 },
    GpuInfo: { Gpus: [{ Manufacturer: manufacturer, Name: "GPU", Count: 1 }] },
  };
}

function provider() {
  const send = vi.fn(async (command: unknown) => {
    if (command instanceof DescribeInstanceTypeOfferingsCommand) return {
      InstanceTypeOfferings: ["g4dn.xlarge", "g5.xlarge", "g6.xlarge", "g6f.large", "g5g.xlarge"]
        .map((InstanceType) => ({ InstanceType })),
    };
    if (command instanceof DescribeInstanceTypesCommand) return {
      InstanceTypes: [gpuType("g4dn.xlarge"), gpuType("g5.xlarge"), gpuType("g6.xlarge"),
        gpuType("g6f.large"), gpuType("g5g.xlarge", "NVIDIA", "arm64")],
    };
    if (command instanceof DescribeImagesCommand) return { Images: [
      { ImageId: "ami-11111111111111111", Name: "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20261002", State: "available", Architecture: "x86_64", RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", CreationDate: "2026-10-02T00:00:00Z" },
      { ImageId: "ami-22222222222222222", Name: "Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 24.04) 20261117", State: "available", Architecture: "x86_64", RootDeviceType: "ebs", RootDeviceName: "/dev/sda1", CreationDate: "2026-11-17T00:00:00Z" },
    ] };
    throw new Error(`Unexpected EC2 command ${String(command)}`);
  });
  const hourlyUsd = vi.fn(async (_region: string, instanceType: string) => ({
    "g4dn.xlarge": 0.526, "g5.xlarge": 1.006, "g6.xlarge": 0.805,
  })[instanceType as "g4dn.xlarge" | "g5.xlarge" | "g6.xlarge"] ?? null);
  return { send, hourlyUsd, instance: new AwsEc2Provider({
    region: "us-east-1", credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
  }, { clientFactory: () => ({ send }), gpuPricing: { hourlyUsd } }) };
}

describe("AWS Crackstation GPU selection", () => {
  it("offers public SSH subnets only when their effective route reaches an attached internet gateway", async () => {
    const vpcId = "vpc-0123456789abcdef0";
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof DescribeSubnetsCommand) return { Subnets: [
        { SubnetId: "subnet-11111111111111111", VpcId: vpcId, State: "available" },
        { SubnetId: "subnet-22222222222222222", VpcId: vpcId, State: "available" },
      ] };
      if (command instanceof DescribeRouteTablesCommand) return { RouteTables: [
        { VpcId: vpcId, Associations: [{ Main: true }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", GatewayId: "igw-11111111111111111", State: "active" }] },
        { VpcId: vpcId, Associations: [{ SubnetId: "subnet-22222222222222222" }], Routes: [{ DestinationCidrBlock: "0.0.0.0/0", NatGatewayId: "nat-22222222222222222", State: "active" }] },
      ] };
      if (command instanceof DescribeInternetGatewaysCommand) return { InternetGateways: [{
        InternetGatewayId: "igw-11111111111111111", Attachments: [{ VpcId: vpcId, State: "attached" }],
      }] };
      throw new Error("Unexpected EC2 command");
    });
    const instance = new AwsEc2Provider({
      region: "us-east-1", credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    }, { clientFactory: () => ({ send }) });
    expect(await instance.discoverCrackstationPublicSubnetIds(vpcId)).toEqual(["subnet-11111111111111111"]);
  });

  it("returns only the two lowest-priced compatible Linux/x86-64 CUDA offerings", async () => {
    const { instance, hourlyUsd } = provider();
    expect(await instance.discoverCrackstationInstanceTypes()).toMatchObject([
      { name: "g4dn.xlarge", priceHourlyUsd: 0.526, estimatedCostPerDayUsd: 12.62 },
      { name: "g6.xlarge", priceHourlyUsd: 0.805, estimatedCostPerDayUsd: 19.32 },
    ]);
    expect(hourlyUsd.mock.calls.map(([, name]) => name)).not.toContain("g6f.large");
    expect(hourlyUsd.mock.calls.map(([, name]) => name)).not.toContain("g5g.xlarge");
  });

  it("does not launch an out-of-scope GPU type", async () => {
    const { instance, send } = provider();
    await expect(instance.createCrackstation({
      guid: "22222222-2222-4222-8222-222222222222", name: "worker",
      imageId: "ami-0123456789abcdef0", instanceType: "g6f.large",
      network: { mode: "existing", vpcId: "vpc-0123456789abcdef0", subnetId: "subnet-0123456789abcdef0" },
      sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElo6IUxNiKthKvTqYFCBBLjkJPL7GBfAoqglIqa0oqb test",
      firewall: { sshPort: 22, sshSourceCidrs: ["203.0.113.1/32"] }, allocateElasticIp: false,
    })).rejects.toThrow(/two lowest-priced compatible choices/u);
    expect(send.mock.calls.some(([command]) => command instanceof RunInstancesCommand)).toBe(false);
  });

  it("does not launch into a subnet without a public internet-gateway route", async () => {
    const { instance, send } = provider();
    vi.spyOn(instance, "discoverCrackstationPublicSubnetIds").mockResolvedValue([]);
    await expect(instance.createCrackstation({
      guid: "22222222-2222-4222-8222-222222222222", name: "worker",
      imageId: "ami-0123456789abcdef0", instanceType: "g4dn.xlarge",
      network: { mode: "existing", vpcId: "vpc-0123456789abcdef0", subnetId: "subnet-0123456789abcdef0" },
      sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElo6IUxNiKthKvTqYFCBBLjkJPL7GBfAoqglIqa0oqb test",
      firewall: { sshPort: 22, sshSourceCidrs: ["203.0.113.1/32"] }, allocateElasticIp: true,
    })).rejects.toThrow(/public internet-gateway route/u);
    expect(send.mock.calls.some(([command]) => command instanceof RunInstancesCommand)).toBe(false);
  });

  it("offers only the latest official x86-64 GPU base image", async () => {
    const { instance, send } = provider();
    expect(await instance.discoverCrackstationImages()).toMatchObject([
      { id: "ami-22222222222222222", distribution: "ubuntu", architecture: "x86_64", sshUsername: "ubuntu" },
    ]);
    const imageCall = send.mock.calls.find(([command]) => command instanceof DescribeImagesCommand)?.[0] as DescribeImagesCommand;
    expect(imageCall.input.Owners).toEqual(["amazon"]);
  });
});
