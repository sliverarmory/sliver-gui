import type { DomainCollection } from "../../../shared/contracts";
import type { InfrastructureServiceSummary, TopologyEdge, TopologyFreshness, TopologyNode, TopologyNotice, TopologyProperty } from "../../../shared/topology-contracts";
import type { TopologyContext, TopologyContributor } from "./overview-topology";

interface ServiceKind {
  readonly kind: "external-builder" | "crackstation";
  readonly inventory: "builders" | "crackstations";
  readonly label: string;
  readonly plural: string;
  readonly identityLabel: string;
  readonly statusLabel: string;
  readonly statusProperty: string;
  readonly edgeKind: string;
  readonly edgeLabel: string;
  readonly description: string;
}

const serviceKinds: readonly ServiceKind[] = [
  {
    kind: "external-builder", inventory: "builders", label: "External builder", plural: "external builders",
    identityLabel: "Builder name", statusLabel: "Registered", statusProperty: "Registration",
    edgeKind: "external-builder-registration", edgeLabel: "Builder registration",
    description: "Server-reported external builder registration. Traffic, build activity, and operator identity relationships are not reported.",
  },
  {
    kind: "crackstation", inventory: "crackstations", label: "Crackstation", plural: "crackstations",
    identityLabel: "Host UUID", statusLabel: "Connected", statusProperty: "Connection",
    edgeKind: "crackstation-connection", edgeLabel: "Crackstation connection",
    description: "Server-reported crackstation connection. Traffic, cracking activity, and operator identity relationships are not reported.",
  },
];

function serviceFreshness(context: TopologyContext, domain: DomainCollection<InfrastructureServiceSummary>): TopologyFreshness {
  const eventStatus = context.snapshot.eventStream.status;
  if (!context.connected || eventStatus === "retrying" || eventStatus === "stopped") return "stale";
  if (domain.status === "ready" || domain.status === "empty") return "current";
  return domain.items.length > 0 || domain.updatedAt ? "stale" : "unknown";
}

function scopedId(context: TopologyContext, kind: string, id: string): string {
  return `${context.scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function metadata(label: string, value: string | undefined): TopologyProperty[] {
  return value ? [{ label, value }] : [];
}

/** Display-only service inventory; reported operator names do not establish identity or ownership. */
export const serviceTopologyContributor: TopologyContributor = (context) => {
  const inventory = context.snapshot.infrastructureServices;
  if (!context.hasServer || !inventory) return { nodes: [], edges: [], notices: [] };
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const notices: TopologyNotice[] = [];
  for (const type of serviceKinds) {
    const domain = inventory[type.inventory];
    const freshness = serviceFreshness(context, domain);
    const statusLabel = freshness === "current" ? type.statusLabel : `Last known: ${type.statusLabel.toLowerCase()}`;
    for (const service of domain.items) {
      const id = scopedId(context, type.kind, service.id);
      const properties: TopologyProperty[] = [
        { label: type.identityLabel, value: service.id },
        ...metadata("Operating system", service.os),
        ...metadata("Architecture", service.arch),
        ...metadata("Reported operator", service.operatorName),
        ...metadata("Version", service.version),
        { label: type.statusProperty, value: statusLabel },
        ...metadata("Inventory updated", domain.updatedAt),
      ];
      nodes.push({
        id, kind: type.kind, role: "resource", label: service.name || service.id,
        subtitle: [service.os, service.arch].filter(Boolean).join(" · ") || `Server-reported ${type.label.toLowerCase()}`,
        icon: type.kind, status: freshness === "current" ? "healthy" : "unknown", statusLabel, freshness, properties,
      });
      edges.push({
        id: scopedId(context, type.edgeKind, service.id), kind: type.edgeKind, role: "relationship",
        source: id, target: context.ids.server, label: type.edgeLabel, state: "unknown", freshness,
        description: type.description, properties: [{ label: type.statusProperty, value: statusLabel }],
      });
    }
    if (domain.page.truncated || domain.items.length < domain.page.total) {
      notices.push({
        id: `${type.inventory}:partial`, severity: "info",
        message: `Showing ${domain.items.length} of ${domain.page.total} ${type.plural}; this inventory is partial.`,
      });
    }
    if (domain.status === "error") {
      notices.push({ id: `${type.inventory}:error`, severity: "warning", message: `${type.label} inventory could not be refreshed; any displayed records are last known.` });
    } else if (domain.status === "unsupported") {
      notices.push({ id: `${type.inventory}:unsupported`, severity: "info", message: `${type.label} inventory is unavailable from this server.` });
    } else if (context.connected && (domain.status === "idle" || domain.status === "loading")) {
      notices.push({ id: `${type.inventory}:loading`, severity: "info", message: `${type.label} inventory is loading${domain.items.length ? "; displayed records are last known" : ""}.` });
    }
  }
  return { nodes, edges, notices };
};
