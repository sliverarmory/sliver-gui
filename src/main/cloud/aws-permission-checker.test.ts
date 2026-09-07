// @vitest-environment node

import { describe, expect, it } from "vitest";

import { cloudRequiredPermissions } from "../../shared/cloud-provider-permissions.js";
import type { AwsEc2ClientLike } from "./aws-ec2-provider.js";
import { AwsEc2PermissionChecker } from "./aws-permission-checker.js";

const connection = {
  region: "us-west-2",
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
} as const;

describe("AWS EC2 permission checker", () => {
  it("uses successful read calls and DryRunOperation to verify permissions without mutations", async () => {
    const client = new PermissionClient();
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    const result = await checker.check();

    expect(result.missing).toEqual([]);
    expect(result.unverifiable).toEqual([
      "ec2:ModifyVpcAttribute",
      "ec2:ModifySubnetAttribute",
    ]);
    expect(result.verified).toHaveLength(cloudRequiredPermissions("aws").length - 2);
    expect(result.verified).toContain("ec2:CreateTags");
    expect(client.calls.some(({ name }) => name === "RunInstancesCommand")).toBe(true);
    expect(client.calls.filter(({ name }) => !name.startsWith("Describe"))
      .every(({ input }) => input["DryRun"] === true)).toBe(true);

    for (const name of [
      "AllocateAddressCommand",
      "AuthorizeSecurityGroupIngressCommand",
      "CreateInternetGatewayCommand",
      "CreateRouteTableCommand",
      "CreateSecurityGroupCommand",
      "CreateSubnetCommand",
      "CreateVpcCommand",
      "ImportKeyPairCommand",
      "RunInstancesCommand",
    ]) {
      const calls = client.calls.filter((call) => call.name === name);
      expect(calls.some(({ input }) => input["TagSpecifications"] === undefined), name).toBe(true);
      expect(calls.some(({ input }) => Array.isArray(input["TagSpecifications"])), name).toBe(true);
    }
  });

  it("distinguishes explicit authorization failures from inconclusive resource validation", async () => {
    const client = new PermissionClient({
      DescribeVpcsCommand: "UnauthorizedOperation",
      RunInstancesCommand: "InvalidAMIID.NotFound",
    });
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    const result = await checker.check();

    expect(result.missing).toContain("ec2:DescribeVpcs");
    expect(result.unverifiable).toEqual(expect.arrayContaining([
      "ec2:RunInstances",
      "ec2:ModifyVpcAttribute",
      "ec2:ModifySubnetAttribute",
    ]));
    expect(result.verified).not.toContain("ec2:RunInstances");
  });

  it("does not misattribute an ambiguous tagged-create denial to the primary action or CreateTags", async () => {
    const client = new PermissionClient({}, (name, input) => name === "CreateVpcCommand" &&
      Array.isArray(input["TagSpecifications"])
      ? {
          code: "UnauthorizedOperation",
          message: "You are not authorized to perform this operation.",
        }
      : undefined);
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    const result = await checker.check();

    expect(result.verified).toContain("ec2:CreateVpc");
    expect(result.missing).not.toContain("ec2:CreateVpc");
    expect(result.missing).not.toContain("ec2:CreateTags");
    expect(result.unverifiable).toContain("ec2:CreateTags");
  });

  it("reports CreateTags missing only when tagged-create error detail explicitly names it", async () => {
    const client = new PermissionClient({}, (name, input) => name === "CreateVpcCommand" &&
      Array.isArray(input["TagSpecifications"])
      ? {
          code: "UnauthorizedOperation",
          message: "User is not authorized to perform: ec2:CreateTags on the requested resource.",
        }
      : undefined);
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    const result = await checker.check();

    expect(result.verified).toContain("ec2:CreateVpc");
    expect(result.missing).toContain("ec2:CreateTags");
    expect(result.unverifiable).not.toContain("ec2:CreateTags");
  });

  it("skips a tagged composite when its primary create action is not authorized", async () => {
    const client = new PermissionClient({}, (name, input) => name === "CreateVpcCommand" &&
      input["TagSpecifications"] === undefined
      ? { code: "UnauthorizedOperation", message: "Missing ec2:CreateVpc" }
      : undefined);
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    const result = await checker.check();

    expect(result.missing).toContain("ec2:CreateVpc");
    expect(result.unverifiable).toContain("ec2:CreateTags");
    expect(client.calls.filter(({ name }) => name === "CreateVpcCommand")).toHaveLength(1);
  });

  it("fails the connection test for invalid credentials before issuing the remaining probes", async () => {
    const client = new PermissionClient({ DescribeAvailabilityZonesCommand: "InvalidClientTokenId" });
    const checker = new AwsEc2PermissionChecker(connection, { clientFactory: () => client });

    await expect(checker.check()).rejects.toThrow(/rejected the credential \(InvalidClientTokenId\)/u);
    expect(client.calls.map(({ name }) => name)).toEqual(["DescribeAvailabilityZonesCommand"]);
  });
});

interface PermissionError {
  readonly code: string;
  readonly message?: string;
}

class PermissionClient implements AwsEc2ClientLike {
  readonly calls: { readonly name: string; readonly input: Record<string, unknown> }[] = [];

  constructor(
    private readonly errors: Readonly<Record<string, string>> = {},
    private readonly selectError?: (
      name: string,
      input: Readonly<Record<string, unknown>>,
    ) => PermissionError | undefined,
  ) {}

  async send(command: unknown): Promise<unknown> {
    const candidate = command as { readonly constructor?: { readonly name?: string }; readonly input?: unknown };
    const name = candidate.constructor?.name ?? "UnknownCommand";
    const input = isRecord(candidate.input) ? candidate.input : {};
    this.calls.push({ name, input });
    const selected = this.selectError?.(name, input);
    if (selected) {
      throw Object.assign(new Error(selected.message ?? selected.code), { name: selected.code });
    }
    const configured = this.errors[name];
    if (configured) throw Object.assign(new Error(configured), { name: configured });
    if (input["DryRun"] === true) throw Object.assign(new Error("dry run"), { name: "DryRunOperation" });
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
