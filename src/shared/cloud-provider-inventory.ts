import { isAwsRegion, isUuidV4 } from "./cloud-deployment-contracts.js";

export interface DiscoverAwsOptionsInput {
  readonly credentialId: string;
  readonly region: string;
}

export interface AwsInstanceTypeOption {
  readonly name: string;
  readonly architecture: "x86_64" | "arm64";
  readonly vCpuCount: number;
  readonly memoryMiB: number;
  readonly processor: string;
  readonly description: string;
}

export interface AwsImageOption {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly architecture: "x86_64" | "arm64";
  readonly rootDeviceName: string | null;
  readonly distribution: "ubuntu" | "amazon-linux";
  readonly version: string;
  readonly creationDate: string | null;
  readonly sshUsername: string;
}

export interface AwsVpcOption {
  readonly id: string;
  readonly name: string | null;
  readonly cidrBlock: string | null;
  readonly isDefault: boolean;
}

export interface AwsSubnetOption {
  readonly id: string;
  readonly name: string | null;
  readonly vpcId: string;
  readonly availabilityZone: string | null;
  readonly cidrBlock: string | null;
  readonly mapPublicIpOnLaunch: boolean;
}

export interface AwsKeyPairOption {
  readonly name: string;
  readonly id: string | null;
  readonly fingerprint: string | null;
  readonly keyType: string | null;
  /** True only when AWS returned public material identical to the credential key. */
  readonly isCredentialMatch: boolean;
}

export interface AwsCredentialKeySummary {
  readonly type: string;
  readonly fingerprint: string;
  readonly matchingKeyPairNames: readonly string[];
}

export interface AwsDeploymentOptions {
  readonly region: string;
  readonly instanceTypes: readonly AwsInstanceTypeOption[];
  readonly images: readonly AwsImageOption[];
  readonly vpcs: readonly AwsVpcOption[];
  readonly subnets: readonly AwsSubnetOption[];
  readonly keyPairs: readonly AwsKeyPairOption[];
  readonly credentialKey: AwsCredentialKeySummary;
}

export function parseDiscoverAwsOptionsInput(value: unknown): DiscoverAwsOptionsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid AWS option discovery request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "credentialId") ||
    !Object.hasOwn(record, "region") ||
    !isUuidV4(record["credentialId"]) ||
    !isAwsRegion(record["region"])
  ) throw new TypeError("Invalid AWS option discovery request");
  return Object.freeze({ credentialId: record["credentialId"], region: record["region"] });
}
