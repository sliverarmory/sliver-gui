import { createHash } from "node:crypto";

import type { clientpb } from "sliver-script";

import type { DomainCollection } from "../shared/contracts.js";
import {
  MAX_TARGET_DOMAIN_ITEMS,
  targetMatchesCatalogQuery,
  type BeaconCheckinStatus,
  type BeaconCollection,
  type BeaconSummary,
  type OperatorPresenceCollection,
  type OperatorPresenceSummary,
  type SessionCollection,
  type SessionSummary,
  type TargetDomains,
  type TargetMode,
  type TargetRef,
  type TargetSummary,
  type TargetTransport,
} from "../shared/target-contracts.js";

const MAX_ID_TEXT = 128;
const MAX_SUMMARY_TEXT = 256;
const MAX_PLATFORM_TEXT = 64;
const MAX_INT64 = 9_223_372_036_854_775_807n;
const MAX_DATE_SECONDS = 253_402_300_799n;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;

export type TargetDomainName = "sessions" | "beacons" | "operators";

export interface TargetStoreOptions {
  now?: () => number;
}

export interface RevalidatedTarget {
  target: TargetSummary;
  ref: TargetRef;
}

export interface TargetCatalogSlice {
  items: TargetSummary[];
  total: number;
  revision: number;
}

export class TargetDomainNormalizationError extends Error {
  constructor(
    readonly domain: TargetDomainName,
    message: string,
  ) {
    super(message);
    this.name = "TargetDomainNormalizationError";
  }
}

export class DuplicateTargetIdError extends TargetDomainNormalizationError {
  constructor(domain: "sessions" | "beacons", readonly targetId: string) {
    super(domain, `Duplicate ${domain === "sessions" ? "session" : "beacon"} ID: ${targetId}`);
    this.name = "DuplicateTargetIdError";
  }
}

export class TargetStore {
  private domains: TargetDomains = emptyTargetDomains();
  private sessions: SessionSummary[] = [];
  private beacons: BeaconSummary[] = [];
  private sessionActiveC2 = new Map<string, string>();
  private beaconActiveC2 = new Map<string, string>();
  private readonly now: () => number;

  constructor(options: TargetStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  snapshot(): TargetDomains {
    return cloneTargetDomains(this.domains);
  }

  markLoading(domain: TargetDomainName): DomainCollection<SessionSummary | BeaconSummary | OperatorPresenceSummary> {
    switch (domain) {
      case "sessions": {
        const next = loadingDomain(this.domains.sessions);
        this.domains = { ...this.domains, sessions: next };
        return cloneDomain(next);
      }
      case "beacons": {
        const next = loadingDomain(this.domains.beacons);
        this.domains = { ...this.domains, beacons: next };
        return cloneDomain(next);
      }
      case "operators": {
        const next = loadingDomain(this.domains.operators);
        this.domains = { ...this.domains, operators: next };
        return cloneDomain(next);
      }
    }
  }

  markError(domain: TargetDomainName, error: string): DomainCollection<SessionSummary | BeaconSummary | OperatorPresenceSummary> {
    const safeError = cleanText(error, MAX_SUMMARY_TEXT) || `Unable to refresh ${domain}`;
    switch (domain) {
      case "sessions": {
        const next = failedDomain(this.domains.sessions, safeError);
        this.domains = { ...this.domains, sessions: next };
        return cloneDomain(next);
      }
      case "beacons": {
        const next = failedDomain(this.domains.beacons, safeError);
        this.domains = { ...this.domains, beacons: next };
        return cloneDomain(next);
      }
      case "operators": {
        const next = failedDomain(this.domains.operators, safeError);
        this.domains = { ...this.domains, operators: next };
        return cloneDomain(next);
      }
    }
  }

  markUnsupported(error: string): TargetDomains {
    const safeError = cleanText(error, MAX_SUMMARY_TEXT) || "Target operations are unsupported";
    this.domains = {
      sessions: { ...this.domains.sessions, status: "unsupported", error: safeError },
      beacons: { ...this.domains.beacons, status: "unsupported", error: safeError },
      operators: { ...this.domains.operators, status: "unsupported", error: safeError },
    };
    return this.snapshot();
  }

  replaceSessions(records: readonly clientpb.Session[]): SessionCollection {
    const observedAt = this.now();
    try {
      const committed = commitTargetDomain(
        this.domains.sessions,
        this.sessions,
        records,
        "sessions",
        (record) => normalizeSessionSummary(record),
        observedAt,
      );
      this.domains = { ...this.domains, sessions: committed.domain };
      this.sessions = committed.catalog;
      this.sessionActiveC2 = authoritativeC2Index(records, committed.catalog);
    } catch (error) {
      this.domains = {
        ...this.domains,
        sessions: failedDomain(this.domains.sessions, normalizationError("sessions", error)),
      };
    }
    return cloneDomain(this.domains.sessions);
  }

  replaceBeacons(records: readonly clientpb.Beacon[]): BeaconCollection {
    const observedAt = this.now();
    try {
      const committed = commitTargetDomain(
        this.domains.beacons,
        this.beacons,
        records,
        "beacons",
        (record) => normalizeBeaconSummary(record, observedAt),
        observedAt,
      );
      this.domains = { ...this.domains, beacons: committed.domain };
      this.beacons = committed.catalog;
      this.beaconActiveC2 = authoritativeC2Index(records, committed.catalog);
    } catch (error) {
      this.domains = {
        ...this.domains,
        beacons: failedDomain(this.domains.beacons, normalizationError("beacons", error)),
      };
    }
    return cloneDomain(this.domains.beacons);
  }

  replaceOperators(records: readonly clientpb.Operator[]): OperatorPresenceCollection {
    const observedAt = this.now();
    try {
      const normalized = normalizeOperatorPresenceSummaries(records);
      const next = commitNormalizedDomain(this.domains.operators, normalized, "operators", observedAt);
      this.domains = { ...this.domains, operators: next };
    } catch (error) {
      this.domains = {
        ...this.domains,
        operators: failedDomain(this.domains.operators, normalizationError("operators", error)),
      };
    }
    return cloneDomain(this.domains.operators);
  }

  reset(): TargetDomains {
    const observedAt = this.now();
    this.domains = {
      sessions: clearedDomain(this.domains.sessions, observedAt),
      beacons: clearedDomain(this.domains.beacons, observedAt),
      operators: clearedDomain(this.domains.operators, observedAt),
    };
    this.sessionActiveC2.clear();
    this.beaconActiveC2.clear();
    this.sessions = [];
    this.beacons = [];
    return this.snapshot();
  }

  catalogPage(mode: TargetMode, offset: number, limit: number, query = ""): TargetCatalogSlice {
    if (
      (mode !== "session" && mode !== "beacon") ||
      !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(limit) || limit < 1
    ) {
      throw new TypeError("Invalid target catalog page request");
    }
    const catalog = mode === "session" ? this.sessions : this.beacons;
    const filtered = query ? catalog.filter((target) => targetMatchesCatalogQuery(target, query)) : catalog;
    const revision = mode === "session" ? this.domains.sessions.revision : this.domains.beacons.revision;
    return {
      items: filtered.slice(offset, offset + limit).map(cloneTarget),
      total: filtered.length,
      revision,
    };
  }

  catalogIds(mode: TargetMode): string[] {
    if (mode !== "session" && mode !== "beacon") throw new TypeError("Invalid target catalog mode");
    return (mode === "session" ? this.sessions : this.beacons).map((target) => target.id);
  }

  target(mode: TargetMode, id: string): TargetSummary | undefined {
    const target = this.targetInternal(mode, id);
    return target ? cloneTarget(target) : undefined;
  }

  /** Main-process-only exact C2 value used for server operations that require
   * an existing implant endpoint. Snapshot projection remains redacted. */
  authoritativeActiveC2(mode: TargetMode, id: string): string | undefined {
    if (mode !== "session" && mode !== "beacon") return undefined;
    if (typeof id !== "string" || cleanText(id, MAX_ID_TEXT) !== id) return undefined;
    return (mode === "session" ? this.sessionActiveC2 : this.beaconActiveC2).get(id);
  }

  createTargetRef(mode: TargetMode, id: string, backendEpoch: number): TargetRef | undefined {
    if (!isSafeEpoch(backendEpoch)) return undefined;
    const target = this.targetInternal(mode, id);
    if (!target) return undefined;
    const domainRevision = mode === "session" ? this.domains.sessions.revision : this.domains.beacons.revision;
    return {
      mode,
      id: target.id,
      backendEpoch,
      domainRevision,
      fingerprint: stableTargetFingerprint(target),
    };
  }

  isCurrentTargetRef(ref: TargetRef, backendEpoch: number): boolean {
    const revalidated = this.revalidateTargetRef(ref, backendEpoch);
    return revalidated !== undefined && revalidated.ref.domainRevision === ref.domainRevision;
  }

  revalidateTargetRef(ref: TargetRef, backendEpoch: number): RevalidatedTarget | undefined {
    if (!isWellFormedTargetRef(ref) || !isSafeEpoch(backendEpoch) || ref.backendEpoch !== backendEpoch) {
      return undefined;
    }
    const target = this.targetInternal(ref.mode, ref.id);
    if (!target || stableTargetFingerprint(target) !== ref.fingerprint) return undefined;
    const fresh = this.createTargetRef(ref.mode, ref.id, backendEpoch);
    return fresh ? { target: cloneTarget(target), ref: fresh } : undefined;
  }

  private targetInternal(mode: TargetMode, id: string): TargetSummary | undefined {
    if (mode !== "session" && mode !== "beacon") return undefined;
    if (typeof id !== "string" || cleanText(id, MAX_ID_TEXT) !== id) return undefined;
    const items = mode === "session" ? this.sessions : this.beacons;
    return items.find((target) => target.id === id);
  }
}

function authoritativeC2Index(
  records: readonly (clientpb.Session | clientpb.Beacon)[],
  committed: readonly TargetSummary[],
): Map<string, string> {
  const committedIds = new Set(committed.map((target) => target.id));
  const result = new Map<string, string>();
  for (const record of records) {
    if (!committedIds.has(record.ID)) continue;
    const activeC2 = privateEndpoint(record.ActiveC2);
    if (activeC2) result.set(record.ID, activeC2);
  }
  return result;
}

function privateEndpoint(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (!candidate || [...candidate].length > 2_048 || /[\p{Cc}\p{Cf}]/u.test(candidate)) return undefined;
  return candidate;
}

export function normalizeSessionSummary(record: clientpb.Session): SessionSummary {
  return {
    ...normalizeTargetIdentity(record, "sessions"),
    mode: "session",
    liveness: record.IsDead === true ? "dead" : "active",
  };
}

export function normalizeBeaconSummary(record: clientpb.Beacon, nowMs = Date.now()): BeaconSummary {
  const nextCheckinSeconds = parsePositiveInteger(record.NextCheckin);
  const taskCount = safeCount(record.TasksCount);
  const completedTaskCount = safeCount(record.TasksCountCompleted);
  const nonCompletedTaskCount =
    taskCount !== undefined && completedTaskCount !== undefined && completedTaskCount <= taskCount
      ? taskCount - completedTaskCount
      : undefined;
  const nextCheckinAt = unixSecondsToIso(record.NextCheckin);
  const intervalMs = nanosecondsToMilliseconds(record.Interval);
  const jitterMs = nanosecondsToMilliseconds(record.Jitter);

  return {
    ...normalizeTargetIdentity(record, "beacons"),
    mode: "beacon",
    checkinStatus: beaconCheckinStatus(nextCheckinSeconds, nowMs),
    ...(nextCheckinAt ? { nextCheckinAt } : {}),
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(jitterMs !== undefined ? { jitterMs } : {}),
    ...(taskCount !== undefined ? { taskCount } : {}),
    ...(completedTaskCount !== undefined ? { completedTaskCount } : {}),
    ...(nonCompletedTaskCount !== undefined ? { nonCompletedTaskCount } : {}),
  };
}

export function normalizeOperatorPresenceSummaries(
  records: readonly clientpb.Operator[],
): OperatorPresenceSummary[] {
  const byIdentity = new Map<string, { names: Set<string>; online: boolean }>();
  for (const record of records) {
    const name = cleanText(record.Name, MAX_ID_TEXT);
    if (!name) continue;
    const id = cleanText(name.toLowerCase(), MAX_ID_TEXT);
    if (!id) continue;
    const current = byIdentity.get(id) ?? { names: new Set<string>(), online: false };
    current.names.add(name);
    current.online ||= record.Online === true;
    byIdentity.set(id, current);
  }

  return [...byIdentity]
    .sort(([left], [right]) => compareText(left, right))
    .map(([id, value]) => ({
      id,
      name: [...value.names].sort(compareText)[0]!,
      online: value.online,
    }));
}

export function redactTargetEndpoint(value: unknown): string {
  const candidate = cleanText(value, 2_048);
  if (!candidate) return "";

  const explicitScheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(candidate);
  try {
    if (explicitScheme) {
      const parsed = new URL(candidate);
      const scheme = cleanText(parsed.protocol.toLowerCase(), 32);
      const host = cleanText(parsed.host, MAX_SUMMARY_TEXT);
      return scheme && host ? cleanText(`${scheme}//${host}`, MAX_SUMMARY_TEXT) : "[redacted endpoint]";
    }

    const parsed = new URL(`tcp://${candidate}`);
    const host = cleanText(parsed.host, MAX_SUMMARY_TEXT);
    return host || "[redacted endpoint]";
  } catch {
    const scheme = explicitScheme?.[1];
    return scheme ? `${cleanText(scheme.toLowerCase(), 31)}://[redacted]` : "[redacted endpoint]";
  }
}

export function unixSecondsToIso(value: unknown): string | undefined {
  const seconds = parsePositiveInteger(value);
  if (seconds === undefined || seconds > MAX_DATE_SECONDS) return undefined;
  return new Date(Number(seconds * 1_000n)).toISOString();
}

export function nanosecondsToMilliseconds(value: unknown): number | undefined {
  const nanoseconds = parsePositiveInteger(value);
  if (nanoseconds === undefined || nanoseconds > MAX_INT64) return undefined;
  return Number(nanoseconds / NANOSECONDS_PER_MILLISECOND);
}

export function stableTargetFingerprint(target: TargetSummary): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        target.mode,
        target.id,
        target.hostId,
        target.firstContactAt ?? "",
        target.hostId ? "" : target.hostname,
        target.os,
        target.arch,
      ]),
    )
    .digest("hex");
}

function normalizeTargetIdentity(
  record: clientpb.Session | clientpb.Beacon,
  domain: "sessions" | "beacons",
): Omit<SessionSummary, "mode" | "liveness"> {
  const id = cleanText(record.ID, MAX_ID_TEXT);
  if (!id) {
    throw new TargetDomainNormalizationError(
      domain,
      `${domain === "sessions" ? "Session" : "Beacon"} inventory contains an empty ID`,
    );
  }
  const firstContactAt = unixSecondsToIso(record.FirstContact);
  const lastCheckinAt = unixSecondsToIso(record.LastCheckin);
  const reconnectIntervalMs = nanosecondsToMilliseconds(record.ReconnectInterval);
  const pid = safePid(record.PID);
  const uid = cleanText(record.UID, MAX_ID_TEXT);
  const gid = cleanText(record.GID, MAX_ID_TEXT);

  return {
    id,
    name: cleanText(record.Name, MAX_SUMMARY_TEXT) || id,
    hostname: cleanText(record.Hostname, MAX_SUMMARY_TEXT),
    hostId: cleanText(record.UUID, MAX_ID_TEXT),
    username: cleanText(record.Username, MAX_SUMMARY_TEXT),
    ...(uid ? { uid } : {}),
    ...(gid ? { gid } : {}),
    os: cleanText(record.OS, MAX_PLATFORM_TEXT).toLowerCase() || "unknown",
    arch: cleanText(record.Arch, MAX_PLATFORM_TEXT).toLowerCase() || "unknown",
    transport: normalizeTransport(record.Transport, record.ActiveC2),
    remoteAddress: redactTargetEndpoint(record.RemoteAddress),
    activeC2: redactTargetEndpoint(record.ActiveC2),
    executable: executableName(record.Filename),
    version: cleanText(record.Version, MAX_SUMMARY_TEXT),
    locale: cleanText(record.Locale, MAX_PLATFORM_TEXT),
    integrity: cleanText(record.Integrity, MAX_PLATFORM_TEXT),
    burned: record.Burned === true,
    ...(pid !== undefined ? { pid } : {}),
    ...(firstContactAt ? { firstContactAt } : {}),
    ...(lastCheckinAt ? { lastCheckinAt } : {}),
    ...(reconnectIntervalMs !== undefined ? { reconnectIntervalMs } : {}),
  };
}

function executableName(value: unknown): string {
  const candidate = cleanText(value, 2_048);
  if (!candidate) return "";
  return cleanText(candidate.split(/[\\/]/u).at(-1), MAX_SUMMARY_TEXT);
}

function normalizeTransport(transport: unknown, activeC2: unknown): TargetTransport {
  const rawTransport = cleanText(transport, MAX_PLATFORM_TEXT).toLowerCase();
  const endpointScheme = /^([a-z][a-z0-9+.-]*):/iu.exec(cleanText(activeC2, 2_048))?.[1]?.toLowerCase();
  if (rawTransport === "http(s)") {
    return endpointScheme === "http" || endpointScheme === "https" ? endpointScheme : "unknown";
  }
  if (rawTransport === "pivot") {
    if (endpointScheme === "namedpipe" || endpointScheme === "named-pipe") return "namedpipe";
    if (endpointScheme === "tcp" || endpointScheme === "tcp-pivot" || endpointScheme === "tcppivot") return "tcppivot";
    return "unknown";
  }
  const candidate = rawTransport || endpointScheme || "";
  switch (candidate) {
    case "mtls":
      return "mtls";
    case "http":
      return "http";
    case "https":
      return "https";
    case "dns":
      return "dns";
    case "wg":
    case "wireguard":
      return "wg";
    case "namedpipe":
    case "named-pipe":
      return "namedpipe";
    case "tcp":
    case "tcp-pivot":
    case "tcppivot":
      return "tcppivot";
    default:
      return "unknown";
  }
}

function beaconCheckinStatus(nextCheckinSeconds: bigint | undefined, nowMs: number): BeaconCheckinStatus {
  if (nextCheckinSeconds === undefined || !isSafeDateMilliseconds(nowMs)) return "unknown";
  return BigInt(Math.floor(nowMs)) <= nextCheckinSeconds * 1_000n ? "on-time" : "overdue";
}

function commitTargetDomain<TSource, TItem extends TargetSummary>(
  current: DomainCollection<TItem>,
  previousCatalog: readonly TItem[],
  source: readonly TSource[],
  domain: "sessions" | "beacons",
  normalize: (item: TSource) => TItem,
  observedAt: number,
): { domain: DomainCollection<TItem>; catalog: TItem[] } {
  const normalized = source.map(normalize);
  const duplicate = firstDuplicateId(normalized);
  if (duplicate) throw new DuplicateTargetIdError(domain, duplicate);
  const catalog = [...normalized].sort((left, right) => compareText(left.id, right.id));
  return {
    domain: commitOrderedDomain(current, catalog, observedAt, sameTargetCatalog(previousCatalog, catalog)),
    catalog,
  };
}

function commitNormalizedDomain<TItem extends { id: string }>(
  current: DomainCollection<TItem>,
  normalized: readonly TItem[],
  domain: TargetDomainName,
  observedAt: number,
): DomainCollection<TItem> {
  const duplicate = firstDuplicateId(normalized);
  if (duplicate) throw new TargetDomainNormalizationError(domain, `Duplicate ${domain} ID: ${duplicate}`);
  const ordered = [...normalized].sort((left, right) => compareText(left.id, right.id));
  return commitOrderedDomain(current, ordered, observedAt);
}

function commitOrderedDomain<TItem>(
  current: DomainCollection<TItem>,
  ordered: readonly TItem[],
  observedAt: number,
  preserveRevision = false,
): DomainCollection<TItem> {
  const items = ordered.slice(0, MAX_TARGET_DOMAIN_ITEMS);
  const updatedAt = safeDateIso(observedAt);
  return {
    status: items.length === 0 ? "empty" : "ready",
    revision: preserveRevision ? current.revision : current.revision + 1,
    items,
    page: {
      limit: MAX_TARGET_DOMAIN_ITEMS,
      total: ordered.length,
      truncated: ordered.length > items.length,
    },
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function sameTargetCatalog(left: readonly TargetSummary[], right: readonly TargetSummary[]): boolean {
  return left.length === right.length && left.every((target, index) =>
    JSON.stringify(target) === JSON.stringify(right[index]),
  );
}

function firstDuplicateId<TItem extends { id: string }>(items: readonly TItem[]): string | undefined {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) duplicates.add(item.id);
    else seen.add(item.id);
  }
  return [...duplicates].sort(compareText)[0];
}

function failedDomain<T>(current: DomainCollection<T>, error: string): DomainCollection<T> {
  return { ...current, status: "error", error };
}

function loadingDomain<T>(current: DomainCollection<T>): DomainCollection<T> {
  return {
    ...current,
    status: "loading",
    ...(current.error ? { error: current.error } : {}),
  };
}

function clearedDomain<T>(current: DomainCollection<T>, observedAt: number): DomainCollection<T> {
  const updatedAt = safeDateIso(observedAt);
  return {
    status: "empty",
    revision: current.revision + 1,
    items: [],
    page: { limit: MAX_TARGET_DOMAIN_ITEMS, total: 0, truncated: false },
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function emptyTargetDomains(): TargetDomains {
  return {
    sessions: emptyDomain(),
    beacons: emptyDomain(),
    operators: emptyDomain(),
  };
}

function emptyDomain<T>(): DomainCollection<T> {
  return {
    status: "idle",
    revision: 0,
    items: [],
    page: { limit: MAX_TARGET_DOMAIN_ITEMS, total: 0, truncated: false },
  };
}

function cloneTargetDomains(domains: TargetDomains): TargetDomains {
  return {
    sessions: cloneDomain(domains.sessions),
    beacons: cloneDomain(domains.beacons),
    operators: cloneDomain(domains.operators),
  };
}

function cloneDomain<T extends object>(domain: DomainCollection<T>): DomainCollection<T> {
  return {
    ...domain,
    items: domain.items.map((item) => ({ ...item })),
    page: { ...domain.page },
  };
}

function cloneTarget(target: TargetSummary): TargetSummary {
  return { ...target };
}

function cleanText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const boundedInput = value.slice(0, Math.max(limit * 4, limit));
  const cleaned = boundedInput
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return [...cleaned].slice(0, limit).join("");
}

function parsePositiveInteger(value: unknown): bigint | undefined {
  const candidate = typeof value === "bigint" ? value.toString() : typeof value === "number" ? String(value) : value;
  if (typeof candidate !== "string" || !/^[0-9]+$/u.test(candidate.trim())) return undefined;
  const parsed = BigInt(candidate.trim());
  return parsed > 0n ? parsed : undefined;
}

function safeCount(value: unknown): number | undefined {
  const parsed = parseNonNegativeInteger(value);
  return parsed !== undefined && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : undefined;
}

function parseNonNegativeInteger(value: unknown): bigint | undefined {
  const candidate = typeof value === "bigint" ? value.toString() : typeof value === "number" ? String(value) : value;
  if (typeof candidate !== "string" || !/^[0-9]+$/u.test(candidate.trim())) return undefined;
  return BigInt(candidate.trim());
}

function safePid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function safeDateIso(value: number): string | undefined {
  return isSafeDateMilliseconds(value) ? new Date(Math.floor(value)).toISOString() : undefined;
}

function isSafeDateMilliseconds(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number(MAX_DATE_SECONDS * 1_000n);
}

function isSafeEpoch(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isWellFormedTargetRef(ref: TargetRef): boolean {
  return (
    (ref.mode === "session" || ref.mode === "beacon") &&
    cleanText(ref.id, MAX_ID_TEXT) === ref.id &&
    ref.id.length > 0 &&
    isSafeEpoch(ref.backendEpoch) &&
    Number.isSafeInteger(ref.domainRevision) &&
    ref.domainRevision >= 0 &&
    SHA256_HEX_PATTERN.test(ref.fingerprint)
  );
}

function normalizationError(domain: TargetDomainName, error: unknown): string {
  if (error instanceof TargetDomainNormalizationError && error.domain === domain) return error.message;
  return `Unable to normalize ${domain} inventory`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
