import type { TopologyEdge, TopologyFreshness, TopologyNode, TopologyStatus } from "../../../shared/topology-contracts";
import type { TopologyContext, TopologyContributor } from "./overview-topology";

function scopedId(context: TopologyContext, kind: string, id: string): string {
  return `${context.scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function cachedStatus(status: string): { status: TopologyStatus; label: string } {
  switch (status) {
    case "failed": return { status: "warning", label: "Failed (cached)" };
    case "stopped": return { status: "inactive", label: "Stopped (cached)" };
    case "running": return { status: "unknown", label: "Running (cached)" };
    case "provisioning": return { status: "unknown", label: "Provisioning (cached)" };
    case "deleting": return { status: "unknown", label: "Removing (cached)" };
    default: return { status: "unknown", label: "Status unknown" };
  }
}

function reportedCrackstationFreshness(context: TopologyContext): TopologyFreshness {
  const domain = context.snapshot.infrastructureServices?.crackstations;
  if (!domain) return "unknown";
  if (!context.connected || context.snapshot.eventStream.status === "retrying" || context.snapshot.eventStream.status === "stopped") return "stale";
  if (domain.status === "ready" || domain.status === "empty") return "current";
  return domain.items.length > 0 || domain.updatedAt ? "stale" : "unknown";
}

/** Persisted AWS resources associated with the selected managed server. */
export const managedDependentTopologyContributor: TopologyContributor = (context) => {
  const managed = context.snapshot.connection.managedServer;
  const deployments = managed?.overview?.dependentDeployments;
  if (!context.hasServer || managed?.provider !== "aws" || !deployments?.length) return { nodes: [], edges: [], notices: [] };

  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const reported = context.snapshot.infrastructureServices?.crackstations;
  const reportedFreshness = reportedCrackstationFreshness(context);

  for (const deployment of deployments) {
    const id = scopedId(context, deployment.kind, deployment.id);
    if (deployment.kind === "crackstation") {
      const service = deployment.hostUuid ? reported?.items.find((item) => item.id === deployment.hostUuid) : undefined;
      const confirmed = deployment.status === "running" && service && reportedFreshness === "current";
      const { status, label } = confirmed
        ? { status: "healthy" as const, label: "Connected" }
        : cachedStatus(deployment.status);
      const freshness: TopologyFreshness = service ? reportedFreshness : "stale";
      nodes.push({
        id, kind: "crackstation", role: "resource", parentId: context.ids.cloud,
        label: deployment.name, subtitle: `AWS GPU · ${deployment.instanceType}`,
        icon: "crackstation", provider: "aws", status, statusLabel: label, freshness,
        properties: [
          { label: "Deployment ID", value: deployment.id },
          { label: "Server deployment ID", value: deployment.serverDeploymentId },
          { label: "Instance type", value: deployment.instanceType },
          ...(deployment.instanceId ? [{ label: "Instance ID", value: deployment.instanceId }] : []),
          ...(deployment.privateIpAddress ? [{ label: "Private IP", value: deployment.privateIpAddress }] : []),
          ...(deployment.hostUuid ? [{ label: "Host UUID", value: deployment.hostUuid }] : []),
          ...(service?.version ? [{ label: "Reported version", value: service.version }] : []),
          { label: "Status (cached)", value: deployment.status },
          { label: "Record updated", value: deployment.updatedAt },
        ],
        resource: { kind: "managed-dependent-deployment", id: deployment.id },
      });
      edges.push({
        id: scopedId(context, "managed-crackstation-server", deployment.id),
        kind: "managed-crackstation-server", role: "relationship",
        source: id, target: context.ids.server, label: confirmed ? "Crackstation connected" : "Configured server",
        state: "unknown", freshness,
        description: confirmed
          ? "Server-reported crackstation connection matched to this managed deployment by host UUID."
          : "Saved association between this managed GPU instance and the selected Sliver server. A live connection has not been confirmed.",
        properties: [
          { label: "Relationship", value: confirmed ? "Server-reported connection" : "Saved deployment association" },
        ],
      });
      continue;
    }

    const health = deployment.targetHealth.toLowerCase();
    const cached = cachedStatus(deployment.status);
    const unhealthy = deployment.status === "running" && (health === "unhealthy" || health === "unused");
    const healthy = deployment.status === "running" && health === "healthy";
    nodes.push({
      id, kind: "alb-redirector", role: "resource", parentId: context.ids.cloud,
      label: deployment.name, subtitle: deployment.domain || deployment.dnsName || "AWS Application Load Balancer",
      icon: "alb-redirector", provider: "aws",
      status: unhealthy ? "warning" : healthy ? "unknown" : cached.status,
      statusLabel: unhealthy ? "Targets unhealthy (cached)" : healthy ? "Targets healthy (cached)" : cached.label,
      freshness: "stale",
      properties: [
        { label: "Deployment ID", value: deployment.id },
        { label: "Server deployment ID", value: deployment.serverDeploymentId },
        { label: "Type", value: "AWS Application Load Balancer" },
        ...(deployment.domain ? [{ label: "Domain", value: deployment.domain }] : []),
        ...(deployment.dnsName ? [{ label: "DNS name", value: deployment.dnsName }] : []),
        ...(deployment.loadBalancerArn ? [{ label: "Load balancer ARN", value: deployment.loadBalancerArn }] : []),
        { label: "Backend port", value: deployment.backendPort },
        ...(deployment.listenerJobId ? [{ label: "Listener job ID", value: deployment.listenerJobId }] : []),
        { label: "Target health (cached)", value: deployment.targetHealth },
        { label: "Status (cached)", value: deployment.status },
        { label: "Record updated", value: deployment.updatedAt },
      ],
      resource: { kind: "managed-dependent-deployment", id: deployment.id },
    });
    edges.push({
      id: scopedId(context, "alb-forwarding", deployment.id),
      kind: "alb-forwarding", role: "relationship",
      source: id, target: context.ids.server, label: `HTTP :${deployment.backendPort}`,
      state: "unknown", freshness: "stale",
      description: "Saved ALB target group association with this server's HTTP listener. This is not a live request path observation.",
      properties: [
        { label: "Configured backend", value: `HTTP :${deployment.backendPort}` },
        ...(deployment.listenerJobId ? [{ label: "Listener job ID", value: deployment.listenerJobId }] : []),
      ],
    });
  }
  return { nodes, edges, notices: [] };
};
