import { describe, expect, it } from "vitest";

import { awsRequiredPermissionsTerraform } from "./cloud-permission-terraform.js";
import { cloudRequiredPermissions } from "./cloud-provider-permissions.js";

interface ExportedPolicy {
  readonly Version: string;
  readonly Statement: readonly {
    readonly Effect: string;
    readonly Action: readonly string[];
    readonly Resource: string | readonly string[];
    readonly Condition?: { readonly StringEquals: { readonly "iam:AWSServiceName": string } };
  }[];
}

function exportedPolicy(terraform: string): ExportedPolicy {
  const match = /policy = jsonencode\((\{[\s\S]*\})\)\n\}\n$/u.exec(terraform);
  expect(match, "the resource should encode a JSON-compatible policy object").not.toBeNull();
  return JSON.parse(match![1]!) as ExportedPolicy;
}

describe("AWS required-permission Terraform export", () => {
  it("includes every manifest action once, including actions that cannot be probed safely", () => {
    const policy = exportedPolicy(awsRequiredPermissionsTerraform());
    const actions = policy.Statement.flatMap(({ Action }) => Action);
    const required = cloudRequiredPermissions("aws").map(({ id }) => id);

    expect(actions).toEqual([...required.filter((id) => id !== "iam:CreateServiceLinkedRole"), "iam:CreateServiceLinkedRole"]);
    expect(new Set(actions).size).toBe(actions.length);
    expect(actions).toEqual(expect.arrayContaining([
      "ec2:CreateTags",
      "ec2:ModifyVpcAttribute",
      "ec2:ModifySubnetAttribute",
    ]));
    expect(actions.every((action) => /^(?:ec2|pricing|acm|elasticloadbalancing|route53|iam):[A-Za-z]+$/u.test(action))).toBe(true);
    expect(actions).not.toContain("*");
    expect(actions).not.toContain("ec2:*");
  });

  it("limits the export to one policy with a scoped ELB service-linked-role grant", () => {
    const terraform = awsRequiredPermissionsTerraform();
    const policy = exportedPolicy(terraform);

    expect(policy).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: cloudRequiredPermissions("aws").map(({ id }) => id).filter((id) => id !== "iam:CreateServiceLinkedRole"),
          Resource: "*",
        },
        {
          Effect: "Allow",
          Action: ["iam:CreateServiceLinkedRole"],
          Resource: ["aws", "aws-us-gov", "aws-cn"].map((partition) =>
            `arn:${partition}:iam::*:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing`),
          Condition: { StringEquals: { "iam:AWSServiceName": "elasticloadbalancing.amazonaws.com" } },
        },
      ],
    });
    expect(terraform.match(/^resource .+$/gmu)).toEqual([
      'resource "aws_iam_policy" "sliver_gui_cloud_deployment" {',
    ]);
    expect(terraform).not.toMatch(/\b(?:provider|data|module|terraform|variable|output)\s+[{\"]/);
    expect(terraform).not.toMatch(/access_key|secret_key|session_token|assume_role_policy|\$\{|%\{/u);
  });

  it("is deterministic and identifies the policy as app requirements rather than identity permissions", () => {
    const terraform = awsRequiredPermissionsTerraform();

    expect(awsRequiredPermissionsTerraform()).toBe(terraform);
    expect(terraform.startsWith("# App-required permissions, not the current IAM identity's complete policies.\n")).toBe(true);
    expect(terraform.endsWith("\n")).toBe(true);
  });
});
