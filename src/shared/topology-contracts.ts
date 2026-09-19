/**
 * Renderer-independent, JSON-safe topology model. Contributions must contain
 * display data only: never credentials, callable actions, HTML, or graph-library
 * objects. Unknown kinds and icon keys intentionally remain valid; renderers
 * display them using a generic resource card and icon.
 */
import type { DomainCollection, DomainStatus } from "./contracts.js";

export const TOPOLOGY_SCHEMA_VERSION = 1 as const;

/** Allowlisted service identity and display metadata; no jobs or action handles. */
export interface InfrastructureServiceSummary {
  readonly id: string;
  readonly name: string;
  readonly os: string;
  readonly arch: string;
  readonly operatorName: string;
  readonly version?: string;
}

export interface InfrastructureServicesSnapshot {
  readonly builders: DomainCollection<InfrastructureServiceSummary>;
  readonly crackstations: DomainCollection<InfrastructureServiceSummary>;
}

/** Passive server-reported routing inventory; no target action authority. */
export interface PivotTopologyEntry {
  readonly peerId: string;
  readonly parentPeerId: string | null;
  readonly sessionId?: string;
  readonly name: string;
}

export interface PivotTopologySnapshot {
  readonly status: DomainStatus;
  readonly revision: number;
  readonly updatedAt?: string;
  readonly error?: string;
  readonly entries: PivotTopologyEntry[];
  readonly truncated: boolean;
}

export type TopologyStatus = "healthy" | "warning" | "inactive" | "unknown";
export type TopologyFreshness = "current" | "stale" | "unknown";

export interface TopologyProperty {
  readonly label: string;
  readonly value: string | number | boolean | null;
}

export interface TopologyNode {
  readonly id: string;
  /** Open vocabulary, e.g. cloud, server, session, beacon, or future resources. */
  readonly kind: string;
  readonly role: "resource" | "group";
  /** Visual containment only. A parent does not imply network traffic. */
  readonly parentId?: string;
  readonly label: string;
  readonly subtitle?: string;
  /** A local icon registry key, never an external asset URL. */
  readonly icon: string;
  readonly provider?: string;
  readonly status: TopologyStatus;
  readonly statusLabel: string;
  readonly freshness: TopologyFreshness;
  readonly properties: readonly TopologyProperty[];
  /** Display/navigation identity only; never an execution capability. */
  readonly resource?: { readonly kind: string; readonly id: string };
}

export interface TopologyEdge {
  readonly id: string;
  readonly kind: string;
  readonly role: "communication" | "containment" | "relationship";
  readonly source: string;
  readonly target: string;
  readonly label: string;
  /** Periodic means intermittent communication, not a continuously open link. */
  readonly state: "live" | "periodic" | "inactive" | "unknown";
  readonly freshness: TopologyFreshness;
  readonly transport?: string;
  /** Observed activity time. This is not a traffic rate or latency measurement. */
  readonly activityAt?: string;
  readonly description: string;
  readonly properties: readonly TopologyProperty[];
}

export interface TopologyNotice {
  readonly id: string;
  readonly severity: "info" | "warning";
  readonly message: string;
}

export interface TopologyDocument {
  readonly schemaVersion: typeof TOPOLOGY_SCHEMA_VERSION;
  readonly scope: {
    /** Stable across refreshes/reconnects, different for distinct server configs. */
    readonly id: string;
    readonly label: string;
    readonly connected: boolean;
  };
  /** Source snapshot time, not the time a renderer happened to build the graph. */
  readonly updatedAt: string | null;
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly notices: readonly TopologyNotice[];
}
