// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT } from "../e2e/cloud-deployment-fixture.js";
import type { AwsDeploymentHealth, CloudProvider } from "../shared/cloud-deployment-contracts.js";
import { resolveManagedServerFromDeployments } from "./managed-server-resolver.js";

const CONFIG_BYTES = Buffer.from('{"operator":"alice","lhost":"203.0.113.20"}');
const CONFIG_DIGEST = digest(CONFIG_BYTES);
const DEPLOYMENT = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "aws" as const,
  name: "Team server",
  operatorConfigDigest: CONFIG_DIGEST,
};

describe("resolveManagedServerFromDeployments", () => {
  it.each<CloudProvider>(["aws", "azure"])("returns only the safe identity for a unique %s deployment", (provider) => {
    const record = {
      ...DEPLOYMENT,
      provider,
      credentialId: "credential-reference",
      operatorConfigFileName: "private-operator.cfg",
      remoteHost: "203.0.113.20",
    };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [record]);

    expect(result).toEqual({ deploymentId: record.id, provider, name: record.name });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("recognizes byte-identical copies independently of file name", () => {
    const copiedBytes = Buffer.from(CONFIG_BYTES);
    expect(resolveManagedServerFromDeployments(digest(copiedBytes), [DEPLOYMENT])).toEqual({
      deploymentId: DEPLOYMENT.id,
      provider: DEPLOYMENT.provider,
      name: DEPLOYMENT.name,
    });
  });

  it("returns null for missing, unknown, reformatted, or changed config digests", () => {
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [])).toBeNull();
    expect(resolveManagedServerFromDeployments("", [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments("b".repeat(64), [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [{ ...DEPLOYMENT, operatorConfigDigest: null }])).toBeNull();
    expect(resolveManagedServerFromDeployments(digest(Buffer.from(`${CONFIG_BYTES.toString()}\n`)), [DEPLOYMENT])).toBeNull();
    expect(resolveManagedServerFromDeployments(digest(Buffer.from('{"operator":"bob","lhost":"203.0.113.20"}')), [DEPLOYMENT])).toBeNull();
  });

  it("returns null when multiple deployments claim the config", () => {
    const duplicate = { ...DEPLOYMENT, id: "55555555-5555-4555-8555-555555555555", provider: "azure" as const };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [DEPLOYMENT, duplicate])).toBeNull();
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [duplicate, DEPLOYMENT])).toBeNull();
  });

  it("ignores nonmatching deployments and reflects updated or removed metadata", () => {
    const unrelated = { ...DEPLOYMENT, id: "other", operatorConfigDigest: "b".repeat(64) };
    const renamed = { ...DEPLOYMENT, name: "Renamed team server" };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [unrelated, renamed])).toEqual({
      deploymentId: renamed.id,
      provider: renamed.provider,
      name: renamed.name,
    });
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [unrelated])).toBeNull();
  });

  it("projects only cached display metadata from AWS records", () => {
    const deployment = { ...E2E_AWS_DEPLOYMENT, operatorConfigDigest: CONFIG_DIGEST };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);

    expect(result).toEqual({
      deploymentId: deployment.id,
      provider: "aws",
      name: deployment.name,
      overview: {
        cloud: { provider: "aws", vpcId: "vpc-0123456789abcdef0" },
        region: "us-west-2",
        size: "t3.small",
        instanceId: "i-0123456789abcdef0",
        instanceName: deployment.name,
        availabilityZone: "us-west-2a",
        subnetId: "subnet-0123456789abcdef0",
        instanceState: "running",
        health: "ok",
        publicIpAddress: "198.51.100.24",
        privateIpAddress: "10.0.0.24",
        updatedAt: deployment.updatedAt,
      },
    });
    expect(Object.isFrozen(result?.overview)).toBe(true);
    expect(Object.isFrozen(result?.overview?.cloud)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(deployment.credentialId);
    expect(JSON.stringify(result)).not.toContain(CONFIG_DIGEST);
    expect(JSON.stringify(result)).not.toContain(deployment.operatorConfigFileName);
  });

  it("normalizes Azure location and size without inventing health or missing addresses", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, publicIpAddress: null, privateIpAddress: null },
    };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);

    expect(result).toEqual({
      deploymentId: deployment.id,
      provider: "azure",
      name: deployment.name,
      overview: {
        cloud: {
          provider: "azure",
          subscriptionId: "11111111-2222-3333-4444-555555555555",
          resourceGroupName: deployment.runtime.resourceGroupName,
          resourceGroupId: deployment.managedAssets[0]!.resourceId,
          virtualNetworkId: deployment.runtime.vnetId,
          virtualNetworkName: `${deployment.name}-vnet`,
          virtualNetworkResourceGroup: deployment.runtime.resourceGroupName,
          virtualNetworkCidr: "10.42.0.0/16",
        },
        region: deployment.spec.location,
        size: deployment.spec.vmSize,
        instanceId: deployment.runtime.vmId,
        instanceName: deployment.name,
        subnetId: deployment.runtime.subnetId,
        instanceState: deployment.runtime.instanceState,
        publicIpAddress: null,
        privateIpAddress: null,
        updatedAt: deployment.updatedAt,
      },
    });
    expect(Object.isFrozen(result?.overview)).toBe(true);
    expect(Object.isFrozen(result?.overview?.cloud)).toBe(true);
  });

  it("shows renamed Azure metadata while retaining the immutable VM resource identity", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      name: "Operations server",
      operatorConfigDigest: CONFIG_DIGEST,
    };

    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);

    expect(result?.name).toBe("Operations server");
    expect(result?.overview?.instanceName).toBe("Operations server");
    expect(result?.overview?.instanceId).toBe(E2E_AZURE_DEPLOYMENT.runtime.vmId);
    expect(deployment.runtime.vmName).toBe(E2E_AZURE_DEPLOYMENT.runtime.vmName);
  });

  it("prefers observed AWS network IDs while keeping configured network CIDR separate from instance metadata", () => {
    const deployment = {
      ...E2E_AWS_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      spec: { ...E2E_AWS_DEPLOYMENT.spec, networkMode: "managed" as const, managedVpcCidr: "10.42.0.0/16" },
      runtime: { ...E2E_AWS_DEPLOYMENT.runtime, vpcId: "vpc-fedcba98765432100", subnetId: "subnet-fedcba98765432100" },
    };
    const overview = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview;
    expect(overview?.cloud).toEqual({ provider: "aws", vpcId: "vpc-fedcba98765432100", vpcCidr: "10.42.0.0/16" });
    expect(overview?.subnetId).toBe("subnet-fedcba98765432100");
    expect(overview?.instanceId).toBe(deployment.runtime.instanceId);
  });

  it("falls back to the configured AWS network when runtime IDs are absent without inventing account identity", () => {
    const deployment = {
      ...E2E_AWS_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AWS_DEPLOYMENT.runtime, vpcId: null, subnetId: null, instanceId: null, availabilityZone: null },
    };
    const overview = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview;
    expect(overview?.cloud).toEqual({ provider: "aws", vpcId: deployment.spec.vpcId });
    expect(overview?.subnetId).toBe(deployment.spec.subnetId);
    expect(overview).not.toHaveProperty("instanceId");
    expect(overview).not.toHaveProperty("availabilityZone");
    expect(overview?.cloud).not.toHaveProperty("accountId");
  });

  it("keeps a shared Azure VNet's group distinct from the VM resource group and prefers runtime VNet and subnet IDs", () => {
    const networkId = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/shared-network/providers/Microsoft.Network/virtualNetworks/production";
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      spec: {
        ...E2E_AZURE_DEPLOYMENT.spec,
        networkMode: "existing" as const,
        vnetId: `${networkId}-configured`,
        subnetId: `${networkId}-configured/subnets/default`,
      },
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, vnetId: networkId, subnetId: `${networkId}/subnets/workloads` },
    };
    const overview = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview;
    expect(overview?.cloud).toEqual({
      provider: "azure",
      subscriptionId: "11111111-2222-3333-4444-555555555555",
      resourceGroupName: deployment.runtime.resourceGroupName,
      resourceGroupId: deployment.managedAssets[0]!.resourceId,
      virtualNetworkId: networkId,
      virtualNetworkName: "production",
      virtualNetworkResourceGroup: "shared-network",
    });
    expect(overview?.subnetId).toBe(`${networkId}/subnets/workloads`);
  });

  it("uses the configured Azure VNet without assigning its group to a VM whose group is unknown", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      managedAssets: [],
      spec: {
        ...E2E_AZURE_DEPLOYMENT.spec,
        networkMode: "existing" as const,
        vnetId: E2E_AZURE_DEPLOYMENT.runtime.vnetId,
        subnetId: E2E_AZURE_DEPLOYMENT.runtime.subnetId,
      },
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, vmId: null, vmName: null, resourceGroupName: null, vnetId: null, subnetId: null },
    };
    const overview = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview;
    expect(overview?.cloud).toEqual({
      provider: "azure",
      virtualNetworkId: deployment.spec.vnetId,
      virtualNetworkName: `${deployment.name}-vnet`,
      virtualNetworkResourceGroup: E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName,
    });
    expect(overview?.subnetId).toBe(deployment.spec.subnetId);
    expect(overview?.instanceName).toBe(deployment.name);
  });

  it("does not attribute a VNet subscription to an unverified VM resource group", () => {
    const networkId = "/subscriptions/99999999-2222-3333-4444-555555555555/resourceGroups/shared-network/providers/Microsoft.Network/virtualNetworks/production";
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      managedAssets: [],
      spec: { ...E2E_AZURE_DEPLOYMENT.spec, networkMode: "existing" as const },
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, vmId: null, resourceGroupName: "vm-group", vnetId: networkId },
    };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.cloud).toEqual({
      provider: "azure",
      resourceGroupName: "vm-group",
      virtualNetworkId: networkId,
      virtualNetworkName: "production",
      virtualNetworkResourceGroup: "shared-network",
    });
  });

  it("does not pair a reported group name with a mismatching VM's subscription or resource group ID", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      managedAssets: [],
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, resourceGroupName: "different-group" },
    };
    const cloud = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.cloud;
    expect(cloud).toHaveProperty("resourceGroupName", "different-group");
    expect(cloud).not.toHaveProperty("resourceGroupId");
    expect(cloud).not.toHaveProperty("subscriptionId");
  });

  it("uses a matching group asset when the VM ID has a different group identity", () => {
    const groupId = "/subscriptions/99999999-2222-3333-4444-555555555555/resourceGroups/current-group";
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      managedAssets: [{ resourceType: "azure-resource-group" as const, resourceId: groupId, displayName: null, tagged: true }],
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, resourceGroupName: "current-group" },
    };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.cloud).toMatchObject({
      resourceGroupName: "current-group",
      resourceGroupId: groupId,
      subscriptionId: "99999999-2222-3333-4444-555555555555",
    });
  });

  it("recovers Azure group identity from its cached managed asset when the VM ID is not available", () => {
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, vmId: null, resourceGroupName: null },
    };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.cloud).toMatchObject({
      provider: "azure",
      subscriptionId: "11111111-2222-3333-4444-555555555555",
      resourceGroupName: E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName,
      resourceGroupId: E2E_AZURE_DEPLOYMENT.managedAssets[0]!.resourceId,
    });
  });

  it("omits unavailable network metadata and never copies arbitrary assets, credentials, or local paths", () => {
    const privatePath = "/private/operator/config.cfg";
    const deployment = {
      ...E2E_AZURE_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      operatorConfigFileName: privatePath,
      credentialId: "secret-credential-reference",
      managedAssets: [{ resourceType: "azure-resource-group" as const, resourceId: privatePath, displayName: "private display name", tagged: true }],
      spec: { ...E2E_AZURE_DEPLOYMENT.spec, networkMode: "existing" as const },
      runtime: { ...E2E_AZURE_DEPLOYMENT.runtime, vmId: null, resourceGroupName: null, vnetId: null, subnetId: null },
    };
    const result = resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment]);
    expect(result?.overview?.cloud).toEqual({ provider: "azure" });
    expect(JSON.stringify(result)).not.toContain(privatePath);
    expect(JSON.stringify(result)).not.toContain(deployment.credentialId);
    expect(JSON.stringify(result)).not.toContain("private display name");
    expect(JSON.stringify(result)).not.toContain(CONFIG_DIGEST);
  });

  it.each<[AwsDeploymentHealth, AwsDeploymentHealth, AwsDeploymentHealth]>([
    ["ok", "unknown", "unknown"],
    ["unknown", "ok", "unknown"],
    ["ok", "initializing", "initializing"],
    ["impaired", "ok", "impaired"],
    ["initializing", "impaired", "impaired"],
  ])("reports AWS checks %s / %s as %s", (instanceHealth, systemHealth, expected) => {
    const deployment = {
      ...E2E_AWS_DEPLOYMENT,
      operatorConfigDigest: CONFIG_DIGEST,
      runtime: { ...E2E_AWS_DEPLOYMENT.runtime, instanceHealth, systemHealth },
    };
    expect(resolveManagedServerFromDeployments(CONFIG_DIGEST, [deployment])?.overview?.health).toBe(expected);
  });
});

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
