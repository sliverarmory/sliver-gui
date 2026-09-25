import type { LocalRedirectorOverview } from "../../../shared/software-deployment-contracts";
import type { TopologyEdge, TopologyFreshness, TopologyNode, TopologyProperty, TopologyStatus } from "../../../shared/topology-contracts";
import type { TopologyContext, TopologyContributor } from "./overview-topology";

function scopedId(context: TopologyContext, kind: string, id: string): string {
  return `${context.scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function property(label: string, value: string | number | null): TopologyProperty[] {
  return value === null || value === "" ? [] : [{ label, value }];
}

function recipeLabel(recipeId: LocalRedirectorOverview["recipeId"]): string {
  return recipeId === "caddy" ? "Caddy" : "Nginx";
}

function publicEndpoint(redirector: LocalRedirectorOverview): URL {
  const host = redirector.domains[0] ?? redirector.publicIp ?? "localhost";
  const fallback = new URL(`${redirector.domains.length ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}`);
  try {
    const url = new URL(redirector.publicUrl);
    if (url.protocol === fallback.protocol && url.hostname === fallback.hostname && !url.username && !url.password) return new URL(url.origin);
  } catch {
    // A malformed saved URL must not make the entire Overview fail to render.
  }
  return fallback;
}

function installationStatus(redirector: LocalRedirectorOverview): { status: TopologyStatus; label: string } {
  switch (redirector.status) {
    case "active": return { status: "unknown", label: "Installed (cached)" };
    case "degraded": return { status: "warning", label: "Degraded (cached)" };
    case "failed": return { status: "warning", label: "Failed (cached)" };
    case "outcome-unknown": return { status: "warning", label: "Outcome unknown" };
    case "installing": return { status: "unknown", label: "Installing (cached)" };
    case "removing": return { status: "unknown", label: "Removing (cached)" };
  }
}

function jobFreshness(context: TopologyContext): TopologyFreshness {
  const jobs = context.snapshot.domains.jobs;
  const eventStatus = context.snapshot.eventStream.status;
  if (!context.connected || eventStatus === "retrying" || eventStatus === "stopped") return "stale";
  if (jobs.status === "ready" || jobs.status === "empty") return "current";
  return jobs.items.length > 0 || jobs.updatedAt ? "stale" : "unknown";
}

function listenerInventoryProperties(context: TopologyContext, redirector: LocalRedirectorOverview): TopologyProperty[] {
  const listener = redirector.listener;
  const unconfirmed = listener.jobId === 0;
  const freshness = jobFreshness(context);
  const job = unconfirmed ? undefined : context.snapshot.domains.jobs.items.find((candidate) => candidate.id === listener.jobId);
  const matches = job?.port === listener.port && job.name.trim().toLowerCase() === listener.kind;
  const statusLabel = unconfirmed ? "Job ID unconfirmed" : freshness === "current"
    ? matches ? "Job reported" : job ? "Job details changed" : "Job not in inventory"
    : "Saved listener association";
  return [
    { label: "Job inventory", value: statusLabel },
    ...property("Job inventory updated", context.snapshot.domains.jobs.updatedAt ?? null),
  ];
}

/** Saved installation associations, with live job inventory shown only as edge details. */
export const localRedirectorTopologyContributor: TopologyContributor = (context) => {
  const redirectors = context.snapshot.connection.managedServer?.overview?.redirectors;
  if (!context.hasServer || !redirectors?.length) return { nodes: [], edges: [], notices: [] };

  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  for (const redirector of redirectors) {
    const redirectorId = scopedId(context, "http-redirector", redirector.id);
    const listener = redirector.listener;
    const { status, label: statusLabel } = installationStatus(redirector);
    // This summary comes from a local deployment record. A prior successful
    // verification is not evidence that the frontend is still serving now.
    const freshness: TopologyFreshness = redirector.lastCheckedAt ? "stale" : "unknown";
    const endpoint = publicEndpoint(redirector);
    const publicUrl = endpoint.origin;
    const primaryDns = redirector.domains[0] ?? null;
    nodes.push({
      id: redirectorId, kind: "http-redirector", role: "resource",
      parentId: context.ids.cloud, label: recipeLabel(redirector.recipeId),
      subtitle: primaryDns ? `DNS · ${primaryDns}` : redirector.publicIp ? `Public IP · ${redirector.publicIp}` : "HTTP Redirectors · local",
      icon: redirector.recipeId,
      status, statusLabel, freshness,
      properties: [
        { label: "Installation ID", value: redirector.id },
        { label: "Category", value: "HTTP Redirectors" },
        { label: "Subcategory", value: "local" },
        { label: "Software", value: recipeLabel(redirector.recipeId) },
        { label: "Status (cached)", value: redirector.status },
        ...property("Last verified", redirector.lastCheckedAt),
        { label: "Public URL", value: publicUrl },
        ...property("DNS record", primaryDns),
        ...property("Domains", redirector.domains.join(", ")),
        ...property("Public IP", redirector.publicIp),
        { label: "Configured upstream", value: `127.0.0.1:${listener.port}` },
        ...property("Listener job ID", listener.jobId === 0 ? null : listener.jobId),
      ],
      resource: { kind: "managed-software", id: redirector.id },
    });

    // Association direction controls left-to-right placement only. This
    // relationship does not claim a measured traffic path or listener attribution.
    edges.push({
      id: scopedId(context, "server-redirector", redirector.id),
      kind: "server-redirector", role: "relationship",
      source: context.ids.server, target: redirectorId,
      label: `${listener.kind.toUpperCase()} :${listener.port}`,
      state: "unknown", freshness,
      description: "Saved association between this server's localhost listener and the redirector. This is not a live request path observation.",
      properties: [
        { label: "Upstream", value: `127.0.0.1:${listener.port}` },
        { label: "Listener ownership", value: listener.ownership },
        ...property("Job ID", listener.jobId === 0 ? null : listener.jobId),
        ...property("Listener domain", listener.domain),
        ...listenerInventoryProperties(context, redirector),
      ],
    });
  }
  return { nodes, edges, notices: [] };
};
