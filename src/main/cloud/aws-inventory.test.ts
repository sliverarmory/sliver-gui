import { describe, expect, it } from "vitest";

import type { AwsEc2DiscoveryResult } from "./aws-ec2-provider.js";
import { toAwsDeploymentOptions } from "./aws-inventory.js";

const blob = Buffer.from("\0\0\0\u000bssh-ed25519\0\0\0\u0004test", "binary").toString("base64");
const otherBlob = Buffer.from("\0\0\0\u000bssh-ed25519\0\0\0\u0005other", "binary").toString("base64");

describe("AWS renderer inventory", () => {
  it("marks only AWS key pairs containing the credential public key as usable", () => {
    const result = toAwsDeploymentOptions("us-west-2", inventory(), `ssh-ed25519 ${blob} local`);

    expect(result.keyPairs).toEqual([
      expect.objectContaining({ name: "matching", isCredentialMatch: true }),
      expect.objectContaining({ name: "other", isCredentialMatch: false }),
      expect.objectContaining({ name: "opaque", isCredentialMatch: false }),
    ]);
    expect(result.credentialKey.matchingKeyPairNames).toEqual(["matching"]);
    expect(result.credentialKey.fingerprint).toMatch(/^SHA256:/u);
    expect(JSON.stringify(result)).not.toContain(blob);
  });

  it("omits images that are not one of the supported curated Linux options", () => {
    const source = inventory();
    const result = toAwsDeploymentOptions("us-west-2", {
      ...source,
      images: [...source.images, { id: "ami-custom", architecture: "x86_64" }],
    }, `ssh-ed25519 ${blob}`);

    expect(result.images.map(({ id }) => id)).toEqual(["ami-ubuntu"]);
  });
});

function inventory(): AwsEc2DiscoveryResult {
  return {
    region: "us-west-2",
    availabilityZones: [{ name: "us-west-2a", state: "available" }],
    instanceTypes: [{
      name: "t3.micro",
      architecture: "x86_64",
      vCpuCount: 2,
      memoryMiB: 1024,
      processor: "Intel or AMD",
      description: "2 vCPU · 1 GiB memory",
    }],
    images: [{
      id: "ami-ubuntu",
      name: "ubuntu/images/example",
      architecture: "x86_64",
      distribution: "ubuntu",
      version: "24.04 LTS",
      sshUsername: "ubuntu",
    }],
    vpcs: [{ id: "vpc-a", isDefault: true }],
    subnets: [{ id: "subnet-a", vpcId: "vpc-a", mapPublicIpOnLaunch: true }],
    keyPairs: [
      { name: "matching", publicKey: `ssh-ed25519 ${blob} aws` },
      { name: "other", publicKey: `ssh-ed25519 ${otherBlob}` },
      { name: "opaque" },
    ],
  };
}
