import type { AwsCrackstationDeploymentRecord, CloudDeploymentPhase, CloudManagedAsset } from "../../shared/cloud-deployment-contracts.js";
import type { AwsEc2CreateMutationEvent, AwsEc2DeploymentResource, AwsEc2DestroyResource } from "./aws-ec2-provider.js";

function upsert(assets: readonly CloudManagedAsset[], resourceType: CloudManagedAsset["resourceType"], resourceId: string, displayName: string | null): readonly CloudManagedAsset[] {
  return [...assets.filter((asset) => asset.resourceType !== resourceType), { resourceType, resourceId, displayName, tagged: true }];
}

/** A worker owns its EC2 resources, but never owns its parent server's VPC or subnet. */
export function applyCrackstationCreateMutation(record: AwsCrackstationDeploymentRecord, event: AwsEc2CreateMutationEvent): AwsCrackstationDeploymentRecord {
  const resources = event.resources;
  let assets = record.managedAssets;
  if (resources.keyPair && resources.keyPair.managed !== false) assets = upsert(assets, "ec2-key-pair", resources.keyPair.id, resources.keyPair.name);
  if (resources.securityGroupId) assets = upsert(assets, "ec2-security-group", resources.securityGroupId, null);
  if (resources.instanceId) assets = upsert(assets, "ec2-instance", resources.instanceId, record.name);
  if (resources.elasticIpAllocationId) assets = upsert(assets, "ec2-elastic-ip", resources.elasticIpAllocationId, resources.elasticIpPublicAddress ?? null);
  const phase: CloudDeploymentPhase = event.phase === "security-group" ? "configuring-firewall"
    : event.phase === "instance" ? "starting-instance"
      : event.phase === "instance-running" ? "waiting-instance-status"
        : event.phase === "instance-status-ok" ? "waiting-system-status"
          : event.phase === "system-status-ok" || event.phase === "elastic-ip" ? "finalizing-network" : "creating-instance";
  return {
    ...record, phase, managedAssets: assets,
    runtime: {
      ...record.runtime,
      instanceId: resources.instanceId ?? record.runtime.instanceId,
      instanceState: resources.instanceId ? (event.phase === "instance" ? "pending" : "running") : record.runtime.instanceState,
      instanceHealth: event.phase === "instance-status-ok" || event.phase === "system-status-ok" ? "ok" : record.runtime.instanceHealth,
      systemHealth: event.phase === "system-status-ok" ? "ok" : record.runtime.systemHealth,
      securityGroupIds: resources.securityGroupId ? [resources.securityGroupId] : record.runtime.securityGroupIds,
      elasticIpAllocationId: resources.elasticIpAllocationId ?? record.runtime.elasticIpAllocationId,
      publicIpAddress: resources.elasticIpPublicAddress ?? record.runtime.publicIpAddress,
      vpcId: record.spec.vpcId,
      subnetId: record.spec.subnetId,
    },
  };
}

export function applyCrackstationResource(record: AwsCrackstationDeploymentRecord, resource: AwsEc2DeploymentResource, phase: CloudDeploymentPhase): AwsCrackstationDeploymentRecord {
  let assets = record.managedAssets;
  assets = upsert(assets, "ec2-instance", resource.instanceId, record.name);
  assets = upsert(assets, "ec2-security-group", resource.securityGroupId, null);
  if (resource.keyPair && resource.keyPair.managed !== false) assets = upsert(assets, "ec2-key-pair", resource.keyPair.id, resource.keyPair.name);
  if (resource.elasticIp) assets = upsert(assets, "ec2-elastic-ip", resource.elasticIp.allocationId, resource.elasticIp.publicIp);
  for (const id of resource.volumeIds) assets = [...assets.filter((asset) => !(asset.resourceType === "ec2-volume" && asset.resourceId === id)), { resourceType: "ec2-volume", resourceId: id, displayName: null, tagged: true }];
  for (const id of resource.networkInterfaceIds) assets = [...assets.filter((asset) => !(asset.resourceType === "ec2-network-interface" && asset.resourceId === id)), { resourceType: "ec2-network-interface", resourceId: id, displayName: null, tagged: true }];
  return {
    ...record, phase, managedAssets: assets,
    runtime: {
      ...record.runtime,
      instanceId: resource.instanceId, instanceState: resource.state,
      instanceHealth: resource.instanceHealth, systemHealth: resource.systemHealth,
      securityGroupIds: [resource.securityGroupId], volumeIds: resource.volumeIds,
      networkInterfaceIds: resource.networkInterfaceIds,
      publicIpAddress: resource.publicIpAddress ?? null, privateIpAddress: resource.privateIpAddress ?? null,
      availabilityZone: resource.availabilityZone ?? null,
      elasticIpAllocationId: resource.elasticIp?.allocationId ?? null,
      vpcId: record.spec.vpcId, subnetId: record.spec.subnetId,
    },
  };
}

export function crackstationResourceFromRecord(record: AwsCrackstationDeploymentRecord): AwsEc2DeploymentResource {
  const id = record.runtime.instanceId;
  const securityGroupId = record.runtime.securityGroupIds[0];
  if (!id || !securityGroupId) throw new Error("The Crackstation EC2 resource identity is incomplete");
  const key = record.managedAssets.find((asset) => asset.resourceType === "ec2-key-pair");
  if (key && !key.displayName) throw new Error("The Crackstation SSH key identity is incomplete");
  return {
    guid: record.id, name: record.name, region: record.spec.region,
    instanceId: id, securityGroupId, volumeIds: record.runtime.volumeIds,
    networkInterfaceIds: record.runtime.networkInterfaceIds,
    state: record.runtime.instanceState, instanceHealth: record.runtime.instanceHealth,
    systemHealth: record.runtime.systemHealth,
    ...(key?.displayName ? { keyPair: { id: key.resourceId, name: key.displayName, managed: true } } : {}),
    ...(record.runtime.availabilityZone ? { availabilityZone: record.runtime.availabilityZone } : {}),
    ...(record.runtime.privateIpAddress ? { privateIpAddress: record.runtime.privateIpAddress } : {}),
    ...(record.runtime.publicIpAddress ? { publicIpAddress: record.runtime.publicIpAddress } : {}),
    ...(record.runtime.elasticIpAllocationId && record.runtime.publicIpAddress ? {
      elasticIp: { allocationId: record.runtime.elasticIpAllocationId, publicIp: record.runtime.publicIpAddress },
    } : {}),
  };
}

export function crackstationDestroyResourceFromRecord(record: AwsCrackstationDeploymentRecord): AwsEc2DestroyResource | null {
  const asset = (type: CloudManagedAsset["resourceType"]) => {
    const matches = record.managedAssets.filter((entry) => entry.resourceType === type);
    if (matches.length > 1) throw new Error(`The Crackstation has duplicate tracked ${type} identities`);
    return matches[0];
  };
  const consistent = (runtime: string | null | undefined, saved: string | undefined, label: string) => {
    if (runtime && saved && runtime !== saved) throw new Error(`The Crackstation ${label} identity changed`);
    return runtime ?? saved;
  };
  if (record.runtime.securityGroupIds.length > 1) throw new Error("The Crackstation has multiple tracked security groups");
  const instanceId = consistent(record.runtime.instanceId, asset("ec2-instance")?.resourceId, "instance");
  const securityGroupId = consistent(record.runtime.securityGroupIds[0], asset("ec2-security-group")?.resourceId, "security group");
  const allocationId = consistent(record.runtime.elasticIpAllocationId, asset("ec2-elastic-ip")?.resourceId, "Elastic IP");
  const key = asset("ec2-key-pair");
  const trackedList = (type: CloudManagedAsset["resourceType"], runtime: readonly string[], label: string) => {
    const saved = record.managedAssets.filter((entry) => entry.resourceType === type).map(({ resourceId }) => resourceId);
    if (runtime.length && saved.length &&
      (runtime.length !== saved.length || runtime.some((id) => !saved.includes(id)))) {
      throw new Error(`The Crackstation ${label} identities changed`);
    }
    return runtime.length ? runtime : saved;
  };
  const volumeIds = trackedList("ec2-volume", record.runtime.volumeIds, "volume");
  const networkInterfaceIds = trackedList("ec2-network-interface", record.runtime.networkInterfaceIds, "network interface");
  if (!instanceId && !securityGroupId && !allocationId && !key && volumeIds.length === 0 && networkInterfaceIds.length === 0) return null;
  if (key && !key.displayName) throw new Error("The Crackstation SSH key identity is incomplete");
  return {
    guid: record.id, name: record.name, region: record.spec.region,
    ...(instanceId ? { instanceId } : {}),
    ...(securityGroupId ? { securityGroupId } : {}),
    ...(allocationId ? { elasticIp: { allocationId } } : {}),
    ...(key?.displayName ? { keyPair: { id: key.resourceId, name: key.displayName } } : {}),
    ...(volumeIds.length ? { volumeIds } : {}),
    ...(networkInterfaceIds.length ? { networkInterfaceIds } : {}),
  };
}
