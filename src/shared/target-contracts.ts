import type {
  DomainCollection,
  JobStopBackendSummary,
  PageRequest,
  PageResult,
  PageSummary,
} from "./contracts.js";

export const MAX_TARGET_DOMAIN_ITEMS = 500 as const;
export const DEFAULT_TARGET_CATALOG_PAGE_SIZE = 100 as const;
export const MAX_TARGET_CATALOG_PAGE_SIZE = 100 as const;
export const MAX_TARGET_CATALOG_CURSOR_LENGTH = 128 as const;
export const MAX_TARGET_CATALOG_QUERY_LENGTH = 128 as const;

export type TargetMode = "session" | "beacon";
export type TargetTransport =
  | "mtls"
  | "http"
  | "https"
  | "dns"
  | "wg"
  | "namedpipe"
  | "tcppivot"
  | "unknown";
export type SessionLiveness = "active" | "dead";
export type BeaconCheckinStatus = "on-time" | "overdue" | "unknown";

export interface TargetIdentitySummary {
  id: string;
  name: string;
  hostname: string;
  hostId: string;
  username: string;
  os: string;
  arch: string;
  transport: TargetTransport;
  remoteAddress: string;
  activeC2: string;
  executable: string;
  version: string;
  locale: string;
  integrity: string;
  burned: boolean;
  pid?: number;
  firstContactAt?: string;
  lastCheckinAt?: string;
  reconnectIntervalMs?: number;
}

export interface SessionSummary extends TargetIdentitySummary {
  mode: "session";
  liveness: SessionLiveness;
}

export interface BeaconSummary extends TargetIdentitySummary {
  mode: "beacon";
  checkinStatus: BeaconCheckinStatus;
  nextCheckinAt?: string;
  intervalMs?: number;
  jitterMs?: number;
  taskCount?: number;
  completedTaskCount?: number;
  /** Server total minus completed; may include pending, sent, canceled, or failed tasks. */
  nonCompletedTaskCount?: number;
}

export interface OperatorPresenceSummary {
  id: string;
  name: string;
  online: boolean;
}

export type TargetSummary = SessionSummary | BeaconSummary;

/** A main-issued catalog row keeps the selectable capability reference paired
 * with the renderer-safe target summary. Renderers never synthesize refs from
 * IDs or cursor contents. */
export interface TargetCatalogEntry {
  target: TargetSummary;
  ref: TargetRef;
}

export interface TargetCatalogPageRequest extends PageRequest {
  mode: TargetMode;
  query?: string;
}

export type TargetCatalogPage = PageResult<TargetCatalogEntry>;

export type SessionCollection = DomainCollection<SessionSummary>;
export type BeaconCollection = DomainCollection<BeaconSummary>;
export type OperatorPresenceCollection = DomainCollection<OperatorPresenceSummary>;

export interface TargetDomains {
  sessions: SessionCollection;
  beacons: BeaconCollection;
  operators: OperatorPresenceCollection;
}

// Target surfaces use the existing shared paging envelope rather than creating
// a second renderer-facing pagination protocol.
export type TargetPageRequest = PageRequest;
export type TargetPageResult<T> = PageResult<T>;
export type TargetPageSummary = PageSummary;

export interface TargetRef {
  mode: TargetMode;
  id: string;
  backendEpoch: number;
  domainRevision: number;
  fingerprint: string;
}

export function normalizeTargetCatalogQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function targetMatchesCatalogQuery(target: TargetSummary, query: string): boolean {
  const normalizedQuery = normalizeTargetCatalogQuery(query);
  if (!normalizedQuery) return true;
  return [
    target.name,
    target.hostname,
    target.username,
    target.id,
    target.os,
    target.arch,
    target.transport,
    target.remoteAddress,
    target.activeC2,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

export const TARGET_CAPABILITY_IDS = [
  "target.ping",
  "target.rename",
  "target.terminate",
  "target.task.execute",
  "target.environment.write",
  "session.close",
  "beacon.remove",
  "beacon.reconfigure",
  "beacon.open-session",
  "beacon.tasks.read",
  "beacon.tasks.cancel",
] as const;

export type TargetCapabilityId = (typeof TARGET_CAPABILITY_IDS)[number];

export type TargetCapabilityReasonCode =
  | "unsupported-by-server"
  | "requires-session"
  | "requires-beacon"
  | "target-dead"
  | "target-overdue"
  | "target-state-unknown"
  | "unsupported-transport";

export interface TargetCapabilityReason {
  code: TargetCapabilityReasonCode;
  message: string;
}

export interface TargetCapabilityState {
  id: TargetCapabilityId;
  available: boolean;
  reason?: TargetCapabilityReason;
}

export interface TargetServerSupport {
  supported: TargetCapabilityId[];
}

export interface WindowTargetContext {
  status: "none" | "selected" | "unavailable";
  activeTarget: TargetRef | null;
  activeTargetSummary: TargetSummary | null;
  /** Main-issued, epoch-bound references for the currently visible bounded inventory. */
  selectableTargets: TargetRef[];
  capabilities: TargetCapabilityState[];
  beaconWatch: boolean;
  unavailableReason?: string;
}

export const DESTRUCTIVE_TARGET_ACTION_IDS = [
  "target.kill",
  "session.close",
  "beacon.remove",
  "sessions.prune-dead",
  "beacons.prune-overdue",
] as const;

export type DestructiveTargetActionId = (typeof DESTRUCTIVE_TARGET_ACTION_IDS)[number];

// Singular actions are bound to the main-owned active target. The renderer is
// deliberately unable to supply or substitute a target identifier here.
export interface PrepareTargetActionInput {
  actionId: DestructiveTargetActionId;
}

export interface TargetActionImpact {
  actionId: DestructiveTargetActionId;
  backend: JobStopBackendSummary;
  targets: TargetSummary[];
  totalTargets: number;
  truncated: boolean;
  warning: string;
}

export interface TargetActionPlan {
  token: string;
  expiresAt: string;
  impact: TargetActionImpact;
}

export interface ExecuteTargetActionPlanInput {
  token: string;
}

export type TargetActionOutcomeStatus = "succeeded" | "failed" | "skipped" | "outcome-unknown";

export interface TargetActionOutcome {
  requestId: string;
  ownerWindowId: number;
  target: TargetSummary;
  status: TargetActionOutcomeStatus;
  error?: string;
}

export interface TargetActionExecutionResult {
  actionId: DestructiveTargetActionId;
  outcomes: TargetActionOutcome[];
  partial: boolean;
}
