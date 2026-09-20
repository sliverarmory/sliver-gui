import type { TopologyEdge, TopologyFreshness, TopologyNode, TopologyNotice } from "../../../shared/topology-contracts";
import type { TopologyContext, TopologyContributor } from "./overview-topology";

function scopedOperatorId(context: TopologyContext, kind: string, id: string): string {
  return `${context.scopeId}/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
}

function operatorFreshness(context: TopologyContext): TopologyFreshness {
  const { operators } = context.snapshot.domains;
  const eventStatus = context.snapshot.eventStream.status;
  if (!context.connected || eventStatus === "retrying" || eventStatus === "stopped") return "stale";
  // A connected, refreshed inventory remains current while the event stream is
  // waiting for its first event; a quiet stream can stay "connecting".
  if (operators.status === "ready" || operators.status === "empty") return "current";
  return operators.items.length > 0 || operators.updatedAt ? "stale" : "unknown";
}

/**
 * Passive server-reported presence only. Names do not establish which roster
 * identity belongs to this client, nor expose remote endpoints or ownership.
 */
export const operatorTopologyContributor: TopologyContributor = (context) => {
  if (!context.hasServer) return { nodes: [], edges: [], notices: [] };
  const { operators } = context.snapshot.domains;
  const freshness = operatorFreshness(context);
  const nodes: TopologyNode[] = [];
  const edges: TopologyEdge[] = [];
  const notices: TopologyNotice[] = [];
  for (const operator of operators.items) {
    const id = scopedOperatorId(context, "operator", operator.id);
    const presence = operator.online ? "Online" : "Offline";
    const statusLabel = freshness === "current" ? presence : `Last known: ${presence.toLowerCase()}`;
    const properties = [
      { label: "Operator ID", value: operator.id },
      { label: "Presence", value: statusLabel },
      ...(operators.updatedAt ? [{ label: "Inventory updated", value: operators.updatedAt }] : []),
    ];
    nodes.push({
      id,
      kind: "operator",
      filterKind: operator.online ? "operator" : "operator-offline",
      role: "resource",
      label: operator.name || operator.id,
      subtitle: "Server-reported operator",
      icon: "operator",
      status: freshness !== "current" ? "unknown" : operator.online ? "healthy" : "inactive",
      statusLabel,
      freshness,
      properties,
      resource: { kind: "operator", id: operator.id },
    });
    edges.push({
      id: scopedOperatorId(context, "operator-presence", operator.id),
      kind: "operator-presence",
      role: "relationship",
      source: id,
      target: context.ids.server,
      label: "Operator presence",
      state: "unknown",
      freshness,
      description: "Server-reported operator presence. Endpoint address, traffic, and target ownership are not reported.",
      properties,
    });
  }
  if (operators.page.truncated || operators.items.length < operators.page.total) {
    notices.push({
      id: "operators:partial",
      severity: "info",
      message: `Showing ${operators.items.length} of ${operators.page.total} operators; this inventory is partial.`,
    });
  }
  if (operators.status === "error") {
    notices.push({ id: "operators:error", severity: "warning", message: "Operators could not be refreshed; any displayed presence is last known." });
  } else if (operators.status === "unsupported") {
    notices.push({ id: "operators:unsupported", severity: "info", message: "Operator presence is unavailable from this server." });
  } else if (context.connected && (operators.status === "idle" || operators.status === "loading")) {
    notices.push({ id: "operators:loading", severity: "info", message: `Operator inventory is loading${operators.items.length ? "; displayed presence is last known" : ""}.` });
  }
  return { nodes, edges, notices };
};
