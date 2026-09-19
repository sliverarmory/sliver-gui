import type { AwsDeploymentHealth, CloudDeploymentRecord } from "../shared/cloud-deployment-contracts.js";
import type { ManagedServerOverview, ManagedServerReference } from "../shared/contracts.js";

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
  return Object.freeze({
    region: deployment.provider === "aws" ? deployment.spec.region : deployment.spec.location,
    size: deployment.provider === "aws" ? deployment.spec.instanceType : deployment.spec.vmSize,
    instanceState: deployment.runtime.instanceState,
    ...(deployment.provider === "aws" ? {
      health: combinedAwsHealth(deployment.runtime.instanceHealth, deployment.runtime.systemHealth),
    } : {}),
    publicIpAddress: deployment.runtime.publicIpAddress,
    privateIpAddress: deployment.runtime.privateIpAddress,
    updatedAt: deployment.updatedAt,
  });
}

/** Never declare the VM healthy unless both provider checks passed. */
function combinedAwsHealth(instance: AwsDeploymentHealth, system: AwsDeploymentHealth): AwsDeploymentHealth {
  if (instance === "impaired" || system === "impaired") return "impaired";
  if (instance === "initializing" || system === "initializing") return "initializing";
  return instance === "ok" && system === "ok" ? "ok" : "unknown";
}
