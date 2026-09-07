import { describe, expect, it } from "vitest";

import {
  cloudRequiredPermissions,
  createCloudPermissionEvaluation,
} from "./cloud-provider-permissions.js";

describe("cloud provider permission manifests", () => {
  it("tracks the AWS inventory, launch, network, lifecycle, firewall, and cleanup actions", () => {
    const ids = cloudRequiredPermissions("aws").map(({ id }) => id);

    expect(ids).toContain("ec2:DescribeInstanceTypes");
    expect(ids).toContain("ec2:DescribeInstanceTypeOfferings");
    expect(ids).toContain("ec2:DescribeImages");
    expect(ids).toContain("ec2:DescribeVpcs");
    expect(ids).toContain("ec2:DescribeKeyPairs");
    expect(ids).toContain("ec2:RunInstances");
    expect(ids).toContain("ec2:CreateVpc");
    expect(ids).toContain("ec2:AuthorizeSecurityGroupIngress");
    expect(ids).toContain("ec2:AuthorizeSecurityGroupEgress");
    expect(ids).toContain("ec2:ModifySecurityGroupRules");
    expect(ids).toContain("ec2:RevokeSecurityGroupEgress");
    expect(ids).toContain("ec2:StopInstances");
    expect(ids).toContain("ec2:TerminateInstances");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("tracks Proxmox privileges using provider-native names", () => {
    const ids = cloudRequiredPermissions("proxmox").map(({ id }) => id);

    expect(ids).toEqual(expect.arrayContaining([
      "VM.Allocate",
      "VM.Clone",
      "VM.Config.Cloudinit",
      "VM.Config.Network",
      "VM.PowerMgmt",
      "Datastore.AllocateSpace",
      "SDN.Use",
    ]));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("defaults unreported permissions to unverifiable and rejects unknown IDs", () => {
    const evaluation = createCloudPermissionEvaluation("aws", new Map([
      ["ec2:DescribeVpcs", "verified" as const],
      ["ec2:RunInstances", "missing" as const],
    ]));

    expect(evaluation.verified).toEqual(["ec2:DescribeVpcs"]);
    expect(evaluation.missing).toEqual(["ec2:RunInstances"]);
    expect(evaluation.unverifiable.length).toBe(evaluation.required.length - 2);
    expect(() => createCloudPermissionEvaluation("aws", new Map([
      ["iam:CreateUser", "verified" as const],
    ]))).toThrow(/Unknown aws permission/u);
  });
});
