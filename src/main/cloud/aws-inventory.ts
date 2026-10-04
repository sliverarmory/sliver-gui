import { createHash, timingSafeEqual } from "node:crypto";

import type { AwsDeploymentOptions } from "../../shared/cloud-provider-inventory.js";
import type { AwsEc2DiscoveryResult } from "./aws-ec2-provider.js";

export function toAwsDeploymentOptions(
  region: string,
  inventory: AwsEc2DiscoveryResult,
  credentialPublicKey: string,
): AwsDeploymentOptions {
  const credentialKey = parseOpenSshPublicKey(credentialPublicKey);
  const keyPairs = inventory.keyPairs.map((keyPair) => {
    const candidate = keyPair.publicKey ? tryParseOpenSshPublicKey(keyPair.publicKey) : null;
    return Object.freeze({
      name: keyPair.name,
      id: keyPair.id ?? null,
      fingerprint: keyPair.fingerprint ?? null,
      keyType: keyPair.keyType ?? null,
      isCredentialMatch: candidate !== null && parsedPublicKeysEqual(credentialKey, candidate),
    });
  });
  const matchingKeyPairNames = Object.freeze(keyPairs
    .filter(({ isCredentialMatch }) => isCredentialMatch)
    .map(({ name }) => name));
  return Object.freeze({
    region,
    instanceTypes: Object.freeze(inventory.instanceTypes.map((option) => Object.freeze({ ...option }))),
    images: Object.freeze(inventory.images.flatMap((image) => (
      (image.architecture === "x86_64" || image.architecture === "arm64") &&
      (image.distribution === "ubuntu" || image.distribution === "amazon-linux") &&
      image.version && image.sshUsername
        ? [Object.freeze({
            id: image.id,
            name: image.name ?? null,
            description: image.description ?? null,
            architecture: image.architecture,
            rootDeviceName: image.rootDeviceName ?? null,
            distribution: image.distribution,
            version: image.version,
            creationDate: image.creationDate ?? null,
            sshUsername: image.sshUsername,
          })]
        : []
    ))),
    vpcs: Object.freeze(inventory.vpcs.map((vpc) => Object.freeze({
      id: vpc.id,
      name: vpc.name ?? null,
      cidrBlock: vpc.cidrBlock ?? null,
      isDefault: vpc.isDefault,
    }))),
    subnets: Object.freeze(inventory.subnets.map((subnet) => Object.freeze({
      id: subnet.id,
      name: subnet.name ?? null,
      vpcId: subnet.vpcId,
      availabilityZone: subnet.availabilityZone ?? null,
      cidrBlock: subnet.cidrBlock ?? null,
      mapPublicIpOnLaunch: subnet.mapPublicIpOnLaunch,
    }))),
    keyPairs: Object.freeze(keyPairs),
    credentialKey: Object.freeze({
      type: credentialKey.type,
      fingerprint: `SHA256:${createHash("sha256").update(credentialKey.blob).digest("base64").replace(/=+$/u, "")}`,
      matchingKeyPairNames,
    }),
  });
}

interface ParsedPublicKey {
  readonly type: string;
  readonly blob: Buffer;
}

function parseOpenSshPublicKey(value: string): ParsedPublicKey {
  const parsed = tryParseOpenSshPublicKey(value);
  if (!parsed) throw new Error("The credential SSH public key is invalid");
  return parsed;
}

function tryParseOpenSshPublicKey(value: string): ParsedPublicKey | null {
  if (typeof value !== "string" || value.length > 16 * 1024) return null;
  const fields = value.trim().split(/\s+/u);
  if (fields.length < 2 || !/^ssh-(?:rsa|ed25519)$/u.test(fields[0] ?? "")) return null;
  const encoded = fields[1] ?? "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return null;
  const blob = Buffer.from(encoded, "base64");
  if (blob.length < 16 || blob.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")) return null;
  return { type: fields[0]!, blob };
}

export function openSshPublicKeysEqual(left: string, right: string): boolean {
  const parsedLeft = tryParseOpenSshPublicKey(left);
  const parsedRight = tryParseOpenSshPublicKey(right);
  return parsedLeft !== null && parsedRight !== null && parsedPublicKeysEqual(parsedLeft, parsedRight);
}

function parsedPublicKeysEqual(left: ParsedPublicKey, right: ParsedPublicKey): boolean {
  return left.type === right.type && left.blob.length === right.blob.length && timingSafeEqual(left.blob, right.blob);
}
