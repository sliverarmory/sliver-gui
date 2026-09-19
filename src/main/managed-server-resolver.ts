import type { AwsDeploymentHealth, AzureCloudDeploymentRecord, CloudDeploymentRecord } from "../shared/cloud-deployment-contracts.js";
import type { ManagedCloudOverview, ManagedServerOverview, ManagedServerReference } from "../shared/contracts.js";

type DeploymentIdentity = Pick<
  CloudDeploymentRecord,
  "id" | "provider" | "name" | "operatorConfigDigest"
>;
type DeploymentSource = DeploymentIdentity | CloudDeploymentRecord;

/** Resolves local deployment provenance without loading configs or contacting a provider. */
export function resolveManagedServerFromDeployments(
  configDigest: string,
  deployments: readonly DeploymentSource[],
): ManagedServerReference | null {
  if (!configDigest) return null;

  let match: DeploymentSource | undefined;
  for (const deployment of deployments) {
    if (deployment.operatorConfigDigest !== configDigest) continue;
    if (match) return null;
    match = deployment;
  }

  if (!match) return null;
  const overview = "spec" in match ? deploymentOverview(match) : undefined;
  return Object.freeze({
    deploymentId: match.id,
    provider: match.provider,
    name: match.name,
    ...(overview ? { overview } : {}),
  });
}

function deploymentOverview(deployment: CloudDeploymentRecord): ManagedServerOverview {
  const instanceId = deployment.provider === "aws" ? deployment.runtime.instanceId : deployment.runtime.vmId;
  const instanceName = deployment.name;
  const subnetId = deployment.runtime.subnetId ?? deployment.spec.subnetId;
  return Object.freeze({
    cloud: deploymentCloudOverview(deployment),
    region: deployment.provider === "aws" ? deployment.spec.region : deployment.spec.location,
    size: deployment.provider === "aws" ? deployment.spec.instanceType : deployment.spec.vmSize,
    ...(instanceId ? { instanceId } : {}),
    instanceName,
    ...(subnetId ? { subnetId } : {}),
    instanceState: deployment.runtime.instanceState,
    ...(deployment.provider === "aws" ? {
      health: combinedAwsHealth(deployment.runtime.instanceHealth, deployment.runtime.systemHealth),
      ...(deployment.runtime.availabilityZone ? { availabilityZone: deployment.runtime.availabilityZone } : {}),
    } : {}),
    publicIpAddress: deployment.runtime.publicIpAddress,
    privateIpAddress: deployment.runtime.privateIpAddress,
    updatedAt: deployment.updatedAt,
  });
}

function deploymentCloudOverview(deployment: CloudDeploymentRecord): ManagedCloudOverview {
  if (deployment.provider === "aws") {
    const vpcId = deployment.runtime.vpcId ?? deployment.spec.vpcId;
    return Object.freeze({
      provider: "aws",
      ...(vpcId ? { vpcId } : {}),
      ...(deployment.spec.networkMode === "managed" && deployment.spec.managedVpcCidr
        ? { vpcCidr: deployment.spec.managedVpcCidr } : {}),
    });
  }

  return azureCloudOverview(deployment);
}

function azureCloudOverview(deployment: AzureCloudDeploymentRecord): ManagedCloudOverview {
  const reportedGroupName = deployment.runtime.resourceGroupName;
  const matchesReportedGroup = (scope: ReturnType<typeof azureResourceScope>) => scope &&
    (!reportedGroupName || scope.resourceGroupName.toLowerCase() === reportedGroupName.toLowerCase());
  const vmScope = azureResourceScope(deployment.runtime.vmId, "Microsoft.Compute/virtualMachines");
  const recordedGroup = deployment.managedAssets
    .filter((asset) => asset.resourceType === "azure-resource-group")
    .map((asset) => azureResourceScope(asset.resourceId))
    .find(matchesReportedGroup);
  const groupScope = matchesReportedGroup(vmScope) ? vmScope : recordedGroup;
  const resourceGroupName = reportedGroupName ?? groupScope?.resourceGroupName;
  // Existing VNets can be in a separate group/subscription; neither identifies the VM's group.
  const virtualNetworkId = deployment.runtime.vnetId ?? deployment.spec.vnetId;
  const networkScope = azureResourceScope(virtualNetworkId, "Microsoft.Network/virtualNetworks");
  const subscriptionId = groupScope?.subscriptionId;
  const resourceGroupId = groupScope?.resourceGroupId;

  return Object.freeze({
    provider: "azure",
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(resourceGroupName ? { resourceGroupName } : {}),
    ...(resourceGroupId ? { resourceGroupId } : {}),
    ...(networkScope ? {
      virtualNetworkId: virtualNetworkId!,
      virtualNetworkName: networkScope.name!,
      virtualNetworkResourceGroup: networkScope.resourceGroupName,
    } : {}),
    ...(deployment.spec.networkMode === "managed" && deployment.spec.managedVnetCidr
      ? { virtualNetworkCidr: deployment.spec.managedVnetCidr } : {}),
  });
}

/** Read only the identity components of recognized ARM IDs already in the local record. */
function azureResourceScope(id: string | null, resourceType?: string): {
  subscriptionId: string;
  resourceGroupName: string;
  resourceGroupId: string;
  name?: string;
} | undefined {
  if (!id) return undefined;
  const match = /^(\/subscriptions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/resourceGroups\/([\p{L}\p{N}_\-.()]+))(?:\/providers\/([^/]+\/[^/]+)\/([^/]+))?$/iu.exec(id);
  if (!match || (resourceType ? match[4]?.toLowerCase() !== resourceType.toLowerCase() : match[4] !== undefined)) return undefined;
  return {
    subscriptionId: match[2]!,
    resourceGroupName: match[3]!,
    resourceGroupId: match[1]!,
    ...(match[5] ? { name: match[5] } : {}),
  };
}

/** Never declare the VM healthy unless both provider checks passed. */
function combinedAwsHealth(instance: AwsDeploymentHealth, system: AwsDeploymentHealth): AwsDeploymentHealth {
  if (instance === "impaired" || system === "impaired") return "impaired";
  if (instance === "initializing" || system === "initializing") return "initializing";
  return instance === "ok" && system === "ok" ? "ok" : "unknown";
}
