import { isAwsRegion, isAzureLocation, isUuidV4 } from "./cloud-deployment-contracts.js";

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

/** Region-specific EC2 On-Demand Linux estimate; excludes attached storage and transfer. */
export interface AwsGpuInstanceTypeOption extends AwsInstanceTypeOption {
  readonly priceHourlyUsd: number;
  readonly estimatedCostPerDayUsd: number;
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

export interface DiscoverAwsCrackstationOptionsInput {
  readonly credentialId: string;
  readonly serverDeploymentId: string;
}

export interface AwsCrackstationOptions extends Omit<AwsDeploymentOptions, "instanceTypes"> {
  readonly instanceTypes: readonly AwsGpuInstanceTypeOption[];
}

export interface DiscoverAwsAlbRedirectorOptionsInput {
  readonly credentialId: string;
  readonly serverDeploymentId: string;
}

export interface AwsAlbCertificateOption {
  readonly arn: string;
  readonly domainName: string;
  readonly subjectAlternativeNames: readonly string[];
}

export interface AwsAlbAdditionalSubnetOption {
  readonly cidrBlock: string;
  readonly availabilityZone: string;
  readonly routeTableId: string;
}

export interface AwsAlbRedirectorOptions {
  readonly region: string;
  readonly vpcId: string;
  readonly publicSubnets: readonly { readonly id: string; readonly availabilityZone: string }[];
  readonly suggestedAdditionalSubnet: AwsAlbAdditionalSubnetOption | null;
  readonly certificates: readonly AwsAlbCertificateOption[];
  readonly hostedZones: readonly { readonly id: string; readonly name: string }[];
  readonly existingHttpListeners: readonly { readonly jobId: number; readonly port: number; readonly description: string }[];
}

export function parseDiscoverAwsCrackstationOptionsInput(value: unknown): DiscoverAwsCrackstationOptionsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid AWS Crackstation option discovery request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 ||
      !isUuidV4(record["credentialId"]) || !isUuidV4(record["serverDeploymentId"])) {
    throw new TypeError("Invalid AWS Crackstation option discovery request");
  }
  return Object.freeze({ credentialId: record["credentialId"], serverDeploymentId: record["serverDeploymentId"] });
}

export function parseDiscoverAwsAlbRedirectorOptionsInput(value: unknown): DiscoverAwsAlbRedirectorOptionsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid AWS ALB option discovery request");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 ||
      !isUuidV4(record["credentialId"]) || !isUuidV4(record["serverDeploymentId"])) {
    throw new TypeError("Invalid AWS ALB option discovery request");
  }
  return Object.freeze({ credentialId: record["credentialId"], serverDeploymentId: record["serverDeploymentId"] });
}

export interface DiscoverAzureOptionsInput {
  readonly credentialId: string;
  readonly location: string;
}

export interface AzureVmSizeOption {
  readonly name: string;
  readonly vCpuCount: number | null;
  readonly memoryMiB: number | null;
}

export interface AzureImageOption {
  readonly reference: string;
  readonly label: string;
  readonly architecture: "x64" | "arm64";
  readonly sshUsername: string;
}

export interface AzureVirtualNetworkOption {
  readonly id: string;
  readonly name: string;
  readonly resourceGroupName: string;
  readonly location: string;
  readonly addressPrefixes: readonly string[];
}

export interface AzureSubnetOption {
  readonly id: string;
  readonly name: string;
  readonly vnetId: string;
  readonly resourceGroupName: string;
  readonly addressPrefixes: readonly string[];
}

export interface AzureDeploymentOptions {
  readonly location: string;
  readonly vmSizes: readonly AzureVmSizeOption[];
  readonly images: readonly AzureImageOption[];
  readonly virtualNetworks: readonly AzureVirtualNetworkOption[];
  readonly subnets: readonly AzureSubnetOption[];
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

export function parseDiscoverAzureOptionsInput(value: unknown): DiscoverAzureOptionsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid Azure option discovery request");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "credentialId") ||
    !Object.hasOwn(record, "location") ||
    !isUuidV4(record["credentialId"]) ||
    !isAzureLocation(record["location"])
  ) throw new TypeError("Invalid Azure option discovery request");
  return Object.freeze({ credentialId: record["credentialId"], location: record["location"] });
}
