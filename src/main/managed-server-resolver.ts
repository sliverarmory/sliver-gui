import type { CloudDeploymentRecord } from "../shared/cloud-deployment-contracts.js";
import type { ManagedServerReference } from "../shared/contracts.js";

type DeploymentIdentity = Pick<
  CloudDeploymentRecord,
  "id" | "provider" | "name" | "operatorConfigDigest"
>;

/** Resolves local deployment provenance without loading configs or contacting a provider. */
export function resolveManagedServerFromDeployments(
  configDigest: string,
  deployments: readonly DeploymentIdentity[],
): ManagedServerReference | null {
  if (!configDigest) return null;

  let match: DeploymentIdentity | undefined;
  for (const deployment of deployments) {
    if (deployment.operatorConfigDigest !== configDigest) continue;
    if (match) return null;
    match = deployment;
  }

  return match ? Object.freeze({
    deploymentId: match.id,
    provider: match.provider,
    name: match.name,
  }) : null;
}
