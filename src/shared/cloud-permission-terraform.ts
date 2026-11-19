import { cloudRequiredPermissions } from "./cloud-provider-permissions.js";

/** Exports the application's required AWS actions without inspecting an IAM identity. */
export function awsRequiredPermissionsTerraform(): string {
  const required = cloudRequiredPermissions("aws").map(({ id }) => id);
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: required.filter((id) => id !== "iam:CreateServiceLinkedRole"),
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
  };
  const document = JSON.stringify(policy, null, 2).replace(/\n/gu, "\n  ");

  return [
    "# App-required permissions, not the current IAM identity's complete policies.",
    'resource "aws_iam_policy" "sliver_gui_cloud_deployment" {',
    '  name        = "sliver-gui-cloud-deployment"',
    '  description = "Required AWS permissions for Sliver GUI cloud deployment."',
    "",
    `  policy = jsonencode(${document})`,
    "}",
    "",
  ].join("\n");
}
