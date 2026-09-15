export type SliverReleaseArtifact = "server" | "client" | "crackstation";

export interface SliverReleaseTarget {
  readonly artifact: SliverReleaseArtifact;
  readonly os: string;
  readonly arch: string;
}

interface SliverReleaseDownloadEventBase extends SliverReleaseTarget {
  readonly downloadId: string;
}

export type SliverReleaseDownloadEvent =
  | (SliverReleaseDownloadEventBase & {
      readonly status: "started";
    })
  | (SliverReleaseDownloadEventBase & {
      readonly status: "progress";
      readonly version: string;
      readonly fileName: string;
      readonly receivedBytes: number;
      readonly totalBytes: number;
    })
  | (SliverReleaseDownloadEventBase & {
      readonly status: "completed";
      readonly version: string;
      readonly fileName: string;
      readonly receivedBytes: number;
      readonly totalBytes: number;
    })
  | (SliverReleaseDownloadEventBase & {
      readonly status: "failed";
      readonly error: string;
    });

const DOWNLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TARGET_SEGMENT_PATTERN = /^[a-z0-9]{2,16}$/u;
const VERSION_PATTERN = /^v?[0-9][0-9A-Za-z.+-]{0,63}$/u;
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._() -]{0,199}$/u;

export function parseSliverReleaseDownloadEvent(value: unknown): SliverReleaseDownloadEvent {
  const event = requireRecord(value);
  const status = requireLiteral(event["status"], ["started", "progress", "completed", "failed"] as const);
  const base = {
    downloadId: requirePattern(event["downloadId"], DOWNLOAD_ID_PATTERN),
    artifact: requireLiteral(event["artifact"], ["server", "client", "crackstation"] as const),
    os: requirePattern(event["os"], TARGET_SEGMENT_PATTERN),
    arch: requirePattern(event["arch"], TARGET_SEGMENT_PATTERN),
  };
  if (status === "started") {
    requireExactKeys(event, ["status", "downloadId", "artifact", "os", "arch"]);
    return { ...base, status };
  }
  if (status === "failed") {
    requireExactKeys(event, ["status", "downloadId", "artifact", "os", "arch", "error"]);
    return {
      ...base,
      status,
      error: requireBoundedString(event["error"], 300),
    };
  }
  requireExactKeys(event, [
    "status",
    "downloadId",
    "artifact",
    "os",
    "arch",
    "version",
    "fileName",
    "receivedBytes",
    "totalBytes",
  ]);
  const totalBytes = requireSafeNonNegativeInteger(event["totalBytes"]);
  const receivedBytes = requireSafeNonNegativeInteger(event["receivedBytes"]);
  if (totalBytes < 1 || receivedBytes > totalBytes || (status === "completed" && receivedBytes !== totalBytes)) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return {
    ...base,
    status,
    version: requirePattern(event["version"], VERSION_PATTERN),
    fileName: requirePattern(event["fileName"], FILE_NAME_PATTERN),
    receivedBytes,
    totalBytes,
  };
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  const expected = new Set(keys);
  if (Object.keys(record).length !== expected.size || Object.keys(record).some((key) => !expected.has(key))) {
    throw new TypeError("Invalid Sliver release download event");
  }
}

function requireLiteral<const Value extends string>(value: unknown, allowed: readonly Value[]): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return value as Value;
}

function requirePattern(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return value;
}

function requireBoundedString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return value;
}

function requireSafeNonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid Sliver release download event");
  }
  return value;
}
