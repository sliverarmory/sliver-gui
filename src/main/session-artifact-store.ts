import { createHash, randomBytes } from "node:crypto";

const KiB = 1_024;
const MiB = 1_024 * KiB;
const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,128}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const PREVIEW_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PREVIEW_DIMENSION = 8_192;
const MAX_PREVIEW_PIXELS = 32 * 1_024 * 1_024;

export const SESSION_ARTIFACT_MAX_BYTES = 64 * MiB;
export const SESSION_ARTIFACT_PREVIEW_MAX_BYTES = 8 * MiB;
export const SESSION_ARTIFACT_DEFAULT_TTL_MILLISECONDS = 5 * 60 * 1_000;
export const SESSION_ARTIFACT_MAX_TTL_MILLISECONDS = 60 * 60 * 1_000;
export const SESSION_ARTIFACT_DEFAULT_OWNER_ITEM_LIMIT = 8;
export const SESSION_ARTIFACT_DEFAULT_OWNER_BYTE_LIMIT = 128 * MiB;
export const SESSION_ARTIFACT_DEFAULT_GLOBAL_ITEM_LIMIT = 32;
export const SESSION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT = 256 * MiB;

export interface SessionArtifactScope {
  readonly ownerWindowId: number;
  /** Stable backend/configuration identity, not a display name. */
  readonly backendId: string;
  readonly backendEpoch: number;
  /** Per-window connection-attempt/incarnation counter. */
  readonly connectionIncarnation: number;
  readonly sessionId: string;
  readonly sessionFingerprint: string;
}

export interface SessionArtifactMetadata {
  readonly handle: string;
  readonly mediaType: string;
  readonly suggestedBasename: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoreSessionArtifactInput {
  readonly scope: SessionArtifactScope;
  readonly data: Buffer;
  readonly mediaType: string;
  readonly suggestedBasename: string;
  readonly ttlMilliseconds?: number;
  /** `take` transfers the supplied Buffer to the store and invalidates it on every failure/removal path. */
  readonly ownership?: "clone" | "take";
}

export interface ConsumedSessionArtifact {
  readonly metadata: SessionArtifactMetadata;
  /** Caller-owned copy. The caller is responsible for clearing it after use. */
  readonly data: Buffer;
}

export interface SessionArtifactStoreUsage {
  readonly itemCount: number;
  readonly byteCount: number;
}

export interface SessionArtifactStoreOptions {
  readonly maximumArtifactBytes?: number;
  readonly maximumPreviewBytes?: number;
  readonly perOwnerItemLimit?: number;
  readonly perOwnerByteLimit?: number;
  readonly globalItemLimit?: number;
  readonly globalByteLimit?: number;
  readonly defaultTtlMilliseconds?: number;
  readonly maximumTtlMilliseconds?: number;
  readonly now?: () => number;
  /** Disable only for deterministic callers that invoke `pruneExpired` themselves. */
  readonly autoPrune?: boolean;
}

interface StoredArtifact {
  readonly scope: SessionArtifactScope;
  readonly metadata: SessionArtifactMetadata;
  readonly expiresAtMilliseconds: number;
  readonly data: Buffer;
}

interface OwnerUsage {
  itemCount: number;
  byteCount: number;
}

export class SessionArtifactAccessError extends Error {
  constructor() {
    super("The session artifact is unavailable for the current window, backend, or session");
    this.name = "SessionArtifactAccessError";
  }
}

export class SessionArtifactCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionArtifactCapacityError";
  }
}

/**
 * Main-process-only bounded storage for unary session artifacts.
 *
 * A window must first bind its exact current backend/session identity. Rebinding
 * revokes and clears every artifact from the previous identity, which prevents
 * a late response from an old operation from minting a usable capability.
 */
export class SessionArtifactStore {
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly ownerHandles = new Map<number, Set<string>>();
  private readonly ownerUsage = new Map<number, OwnerUsage>();
  private readonly bindings = new Map<number, SessionArtifactScope>();
  private readonly maximumArtifactBytes: number;
  private readonly maximumPreviewBytes: number;
  private readonly perOwnerItemLimit: number;
  private readonly perOwnerByteLimit: number;
  private readonly globalItemLimit: number;
  private readonly globalByteLimit: number;
  private readonly defaultTtlMilliseconds: number;
  private readonly maximumTtlMilliseconds: number;
  private readonly now: () => number;
  private readonly autoPrune: boolean;
  private totalBytes = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: SessionArtifactStoreOptions = {}) {
    this.maximumArtifactBytes = boundedPositiveInteger(
      options.maximumArtifactBytes ?? SESSION_ARTIFACT_MAX_BYTES,
      "maximumArtifactBytes",
      SESSION_ARTIFACT_MAX_BYTES,
    );
    this.maximumPreviewBytes = boundedPositiveInteger(
      options.maximumPreviewBytes ?? Math.min(SESSION_ARTIFACT_PREVIEW_MAX_BYTES, this.maximumArtifactBytes),
      "maximumPreviewBytes",
      Math.min(SESSION_ARTIFACT_PREVIEW_MAX_BYTES, this.maximumArtifactBytes),
    );
    this.perOwnerItemLimit = positiveInteger(
      options.perOwnerItemLimit ?? SESSION_ARTIFACT_DEFAULT_OWNER_ITEM_LIMIT,
      "perOwnerItemLimit",
    );
    this.perOwnerByteLimit = positiveInteger(
      options.perOwnerByteLimit ?? SESSION_ARTIFACT_DEFAULT_OWNER_BYTE_LIMIT,
      "perOwnerByteLimit",
    );
    this.globalItemLimit = positiveInteger(
      options.globalItemLimit ?? SESSION_ARTIFACT_DEFAULT_GLOBAL_ITEM_LIMIT,
      "globalItemLimit",
    );
    this.globalByteLimit = positiveInteger(
      options.globalByteLimit ?? SESSION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT,
      "globalByteLimit",
    );
    this.maximumTtlMilliseconds = boundedPositiveInteger(
      options.maximumTtlMilliseconds ?? SESSION_ARTIFACT_MAX_TTL_MILLISECONDS,
      "maximumTtlMilliseconds",
      SESSION_ARTIFACT_MAX_TTL_MILLISECONDS,
    );
    this.defaultTtlMilliseconds = boundedPositiveInteger(
      options.defaultTtlMilliseconds ??
        Math.min(SESSION_ARTIFACT_DEFAULT_TTL_MILLISECONDS, this.maximumTtlMilliseconds),
      "defaultTtlMilliseconds",
      this.maximumTtlMilliseconds,
    );
    this.now = options.now ?? Date.now;
    this.autoPrune = options.autoPrune !== false;
  }

  bind(scope: SessionArtifactScope): void {
    this.assertOpen();
    const normalized = normalizeScope(scope);
    const current = this.bindings.get(normalized.ownerWindowId);
    if (current && !sameScope(current, normalized)) {
      this.removeArtifactsForOwner(normalized.ownerWindowId);
    }
    this.bindings.set(normalized.ownerWindowId, normalized);
    this.scheduleExpiryPrune();
  }

  store(input: StoreSessionArtifactInput): SessionArtifactMetadata {
    this.assertOpen();
    const ownership = input.ownership ?? "clone";
    if (ownership !== "clone" && ownership !== "take") {
      throw new TypeError("Session artifact ownership must be clone or take");
    }

    let storedData: Buffer | undefined;
    let storedHandle: string | undefined;
    try {
      if (!Buffer.isBuffer(input.data)) throw new TypeError("Session artifact data must be a Buffer");
      const scope = normalizeScope(input.scope);
      this.assertCurrentBinding(scope);
      if (input.data.length > this.maximumArtifactBytes) {
        throw new SessionArtifactCapacityError(
          `Session artifacts must not exceed ${this.maximumArtifactBytes} bytes`,
        );
      }
      if (input.data.length > this.perOwnerByteLimit || input.data.length > this.globalByteLimit) {
        throw new SessionArtifactCapacityError("The session artifact exceeds the configured store capacity");
      }
      const mediaType = normalizeMediaType(input.mediaType);
      const suggestedBasename = safeSuggestedBasename(input.suggestedBasename);
      const ttlMilliseconds = input.ttlMilliseconds ?? this.defaultTtlMilliseconds;
      boundedPositiveInteger(ttlMilliseconds, "ttlMilliseconds", this.maximumTtlMilliseconds);
      const createdAtMilliseconds = this.currentTime();
      const expiresAtMilliseconds = createdAtMilliseconds + ttlMilliseconds;
      if (!Number.isSafeInteger(expiresAtMilliseconds) || expiresAtMilliseconds > 8_640_000_000_000_000) {
        throw new TypeError("Session artifact expiration is outside the supported date range");
      }

      this.pruneExpiredAt(createdAtMilliseconds);
      const evictionHandles = this.admissionEvictions(scope.ownerWindowId, input.data.length);
      for (const handle of evictionHandles) this.destroyHandle(handle);

      storedData = ownership === "take" ? input.data : Buffer.from(input.data);
      const handle = this.createHandle();
      storedHandle = handle;
      const metadata = freezeMetadata({
        handle,
        mediaType,
        suggestedBasename,
        size: storedData.length,
        sha256: createHash("sha256").update(storedData).digest("hex"),
        createdAt: new Date(createdAtMilliseconds).toISOString(),
        expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      });
      this.artifacts.set(handle, {
        scope,
        metadata,
        expiresAtMilliseconds,
        data: storedData,
      });
      const handles = this.ownerHandles.get(scope.ownerWindowId) ?? new Set<string>();
      handles.add(handle);
      this.ownerHandles.set(scope.ownerWindowId, handles);
      const usage = this.ownerUsage.get(scope.ownerWindowId) ?? { itemCount: 0, byteCount: 0 };
      usage.itemCount += 1;
      usage.byteCount += storedData.length;
      this.ownerUsage.set(scope.ownerWindowId, usage);
      this.totalBytes += storedData.length;
      storedData = undefined;
      this.scheduleExpiryPrune();
      storedHandle = undefined;
      return metadata;
    } catch (error) {
      if (storedHandle) this.destroyHandle(storedHandle);
      storedData?.fill(0);
      if (ownership === "take" && Buffer.isBuffer(input.data)) input.data.fill(0);
      throw error;
    }
  }

  metadata(scope: SessionArtifactScope, handle: string): SessionArtifactMetadata {
    return this.requireArtifact(scope, handle).metadata;
  }

  previewDataUrl(scope: SessionArtifactScope, handle: string): string {
    const artifact = this.requireArtifact(scope, handle);
    if (
      artifact.data.length > this.maximumPreviewBytes ||
      !PREVIEW_MEDIA_TYPES.has(artifact.metadata.mediaType) ||
      !hasExpectedImageSignature(artifact.metadata.mediaType, artifact.data) ||
      !hasSafeImageDimensions(artifact.metadata.mediaType, artifact.data)
    ) {
      throw new Error("This artifact is not an allowed bounded image preview");
    }
    return `data:${artifact.metadata.mediaType};base64,${artifact.data.toString("base64")}`;
  }

  consume(scope: SessionArtifactScope, handle: string): ConsumedSessionArtifact {
    const artifact = this.requireArtifact(scope, handle);
    const data = Buffer.from(artifact.data);
    const metadata = artifact.metadata;
    this.destroyHandle(handle);
    this.scheduleExpiryPrune();
    return { metadata, data };
  }

  remove(scope: SessionArtifactScope, handle: string): void {
    this.requireArtifact(scope, handle);
    this.destroyHandle(handle);
    this.scheduleExpiryPrune();
  }

  removeOwner(ownerWindowId: number): number {
    this.assertOpen();
    positiveInteger(ownerWindowId, "ownerWindowId");
    const removed = this.removeArtifactsForOwner(ownerWindowId);
    this.bindings.delete(ownerWindowId);
    this.scheduleExpiryPrune();
    return removed;
  }

  pruneExpired(): number {
    this.assertOpen();
    const removed = this.pruneExpiredAt(this.currentTime());
    this.scheduleExpiryPrune();
    return removed;
  }

  usage(ownerWindowId?: number): SessionArtifactStoreUsage {
    this.assertOpen();
    this.pruneExpiredAt(this.currentTime());
    if (ownerWindowId === undefined) {
      return Object.freeze({ itemCount: this.artifacts.size, byteCount: this.totalBytes });
    }
    positiveInteger(ownerWindowId, "ownerWindowId");
    const usage = this.ownerUsage.get(ownerWindowId);
    return Object.freeze({
      itemCount: usage?.itemCount ?? 0,
      byteCount: usage?.byteCount ?? 0,
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    delete this.expiryTimer;
    for (const handle of [...this.artifacts.keys()]) this.destroyHandle(handle);
    this.bindings.clear();
  }

  private admissionEvictions(ownerWindowId: number, artifactBytes: number): string[] {
    const handles = [...(this.ownerHandles.get(ownerWindowId) ?? [])];
    const usage = this.ownerUsage.get(ownerWindowId) ?? { itemCount: 0, byteCount: 0 };
    let retainedItems = usage.itemCount;
    let retainedBytes = usage.byteCount;
    const evictions: string[] = [];
    while (
      retainedItems + 1 > this.perOwnerItemLimit ||
      retainedBytes + artifactBytes > this.perOwnerByteLimit
    ) {
      const handle = handles.shift();
      if (!handle) {
        throw new SessionArtifactCapacityError("The per-window session artifact capacity is exhausted");
      }
      const victim = this.artifacts.get(handle);
      if (!victim) continue;
      evictions.push(handle);
      retainedItems -= 1;
      retainedBytes -= victim.data.length;
    }

    const evictedBytes = evictions.reduce(
      (total, handle) => total + (this.artifacts.get(handle)?.data.length ?? 0),
      0,
    );
    if (
      this.artifacts.size - evictions.length + 1 > this.globalItemLimit ||
      this.totalBytes - evictedBytes + artifactBytes > this.globalByteLimit
    ) {
      throw new SessionArtifactCapacityError("The global session artifact capacity is exhausted");
    }
    return evictions;
  }

  private requireArtifact(scope: SessionArtifactScope, handle: string): StoredArtifact {
    this.assertOpen();
    const normalized = normalizeScope(scope);
    this.assertCurrentBinding(normalized);
    this.pruneExpiredAt(this.currentTime());
    if (!HANDLE_PATTERN.test(handle)) throw new SessionArtifactAccessError();
    const artifact = this.artifacts.get(handle);
    if (!artifact || !sameScope(artifact.scope, normalized)) throw new SessionArtifactAccessError();
    return artifact;
  }

  private assertCurrentBinding(scope: SessionArtifactScope): void {
    const current = this.bindings.get(scope.ownerWindowId);
    if (!current || !sameScope(current, scope)) throw new SessionArtifactAccessError();
  }

  private removeArtifactsForOwner(ownerWindowId: number): number {
    const handles = [...(this.ownerHandles.get(ownerWindowId) ?? [])];
    for (const handle of handles) this.destroyHandle(handle);
    return handles.length;
  }

  private destroyHandle(handle: string): void {
    const artifact = this.artifacts.get(handle);
    if (!artifact) return;
    artifact.data.fill(0);
    this.artifacts.delete(handle);
    this.totalBytes -= artifact.data.length;
    const ownerWindowId = artifact.scope.ownerWindowId;
    const handles = this.ownerHandles.get(ownerWindowId);
    handles?.delete(handle);
    if (handles?.size === 0) this.ownerHandles.delete(ownerWindowId);
    const usage = this.ownerUsage.get(ownerWindowId);
    if (usage) {
      usage.itemCount -= 1;
      usage.byteCount -= artifact.data.length;
      if (usage.itemCount === 0) this.ownerUsage.delete(ownerWindowId);
    }
  }

  private pruneExpiredAt(nowMilliseconds: number): number {
    let removed = 0;
    for (const [handle, artifact] of this.artifacts) {
      if (artifact.expiresAtMilliseconds <= nowMilliseconds) {
        this.destroyHandle(handle);
        removed += 1;
      }
    }
    return removed;
  }

  private scheduleExpiryPrune(): void {
    if (!this.autoPrune || this.closed) return;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    delete this.expiryTimer;
    let earliest = Number.POSITIVE_INFINITY;
    for (const artifact of this.artifacts.values()) {
      earliest = Math.min(earliest, artifact.expiresAtMilliseconds);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(
      MAX_TIMER_DELAY_MILLISECONDS,
      Math.max(0, earliest - this.currentTime()),
    );
    this.expiryTimer = setTimeout(() => {
      delete this.expiryTimer;
      if (this.closed) return;
      this.pruneExpiredAt(this.currentTime());
      this.scheduleExpiryPrune();
    }, delay);
    this.expiryTimer.unref();
  }

  private createHandle(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const handle = randomBytes(32).toString("base64url");
      if (!this.artifacts.has(handle)) return handle;
    }
    throw new Error("Could not allocate a unique session artifact handle");
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
      throw new TypeError("Session artifact clock returned an invalid timestamp");
    }
    return value;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The session artifact store is closed");
  }
}

function normalizeScope(value: SessionArtifactScope): SessionArtifactScope {
  if (typeof value !== "object" || value === null) throw new TypeError("Session artifact scope is required");
  const ownerWindowId = positiveInteger(value.ownerWindowId, "ownerWindowId");
  const backendEpoch = positiveInteger(value.backendEpoch, "backendEpoch");
  const connectionIncarnation = positiveInteger(value.connectionIncarnation, "connectionIncarnation");
  if (!SHA256_PATTERN.test(value.backendId)) throw new TypeError("backendId must be an exact SHA-256 identity");
  if (!SESSION_ID_PATTERN.test(value.sessionId)) throw new TypeError("sessionId is invalid");
  if (!SHA256_PATTERN.test(value.sessionFingerprint)) {
    throw new TypeError("sessionFingerprint must be an exact SHA-256 identity");
  }
  return Object.freeze({
    ownerWindowId,
    backendId: value.backendId,
    backendEpoch,
    connectionIncarnation,
    sessionId: value.sessionId,
    sessionFingerprint: value.sessionFingerprint,
  });
}

function sameScope(left: SessionArtifactScope, right: SessionArtifactScope): boolean {
  return left.ownerWindowId === right.ownerWindowId &&
    left.backendId === right.backendId &&
    left.backendEpoch === right.backendEpoch &&
    left.connectionIncarnation === right.connectionIncarnation &&
    left.sessionId === right.sessionId &&
    left.sessionFingerprint === right.sessionFingerprint;
}

function normalizeMediaType(value: string): string {
  if (typeof value !== "string") throw new TypeError("Session artifact media type must be a string");
  const normalized = value.trim().toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(normalized)) throw new TypeError("Session artifact media type is invalid");
  return normalized;
}

function safeSuggestedBasename(value: string): string {
  if (typeof value !== "string") throw new TypeError("Session artifact basename must be a string");
  const tail = value.normalize("NFC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const sanitized = [...tail]
    .slice(0, 200)
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") return "session-artifact.bin";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
}

function hasExpectedImageSignature(mediaType: string, data: Buffer): boolean {
  switch (mediaType) {
    case "image/png":
      return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case "image/jpeg":
      return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    case "image/webp":
      return data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" &&
        data.subarray(8, 12).toString("ascii") === "WEBP";
    default:
      return false;
  }
}

function hasSafeImageDimensions(mediaType: string, data: Buffer): boolean {
  const dimensions = imageDimensions(mediaType, data);
  if (!dimensions) return false;
  const { width, height } = dimensions;
  return width >= 1 && height >= 1 &&
    width <= MAX_PREVIEW_DIMENSION && height <= MAX_PREVIEW_DIMENSION &&
    width * height <= MAX_PREVIEW_PIXELS;
}

function imageDimensions(mediaType: string, data: Buffer): { width: number; height: number } | undefined {
  switch (mediaType) {
    case "image/png":
      if (data.length < 24 || data.subarray(12, 16).toString("ascii") !== "IHDR") return undefined;
      return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
    case "image/jpeg":
      return jpegDimensions(data);
    case "image/webp":
      return webpDimensions(data);
    default:
      return undefined;
  }
}

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < data.length) {
    while (offset < data.length && data[offset] !== 0xff) offset += 1;
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return undefined;
    const marker = data[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= data.length) return undefined;
    const segmentLength = data.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > data.length) return undefined;
    if (startOfFrameMarkers.has(marker)) {
      if (segmentLength < 7) return undefined;
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += segmentLength;
  }
  return undefined;
}

function webpDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.length < 30) return undefined;
  const kind = data.subarray(12, 16).toString("ascii");
  const payload = 20;
  if (kind === "VP8X") {
    return {
      width: 1 + readUInt24LE(data, payload + 4),
      height: 1 + readUInt24LE(data, payload + 7),
    };
  }
  if (kind === "VP8 " && data.length >= payload + 10) {
    if (data[payload + 3] !== 0x9d || data[payload + 4] !== 0x01 || data[payload + 5] !== 0x2a) return undefined;
    return {
      width: data.readUInt16LE(payload + 6) & 0x3fff,
      height: data.readUInt16LE(payload + 8) & 0x3fff,
    };
  }
  if (kind === "VP8L" && data.length >= payload + 5 && data[payload] === 0x2f) {
    return {
      width: 1 + data[payload + 1]! + ((data[payload + 2]! & 0x3f) << 8),
      height: 1 + (data[payload + 2]! >> 6) + (data[payload + 3]! << 2) + ((data[payload + 4]! & 0x0f) << 10),
    };
  }
  return undefined;
}

function readUInt24LE(data: Buffer, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function freezeMetadata(value: SessionArtifactMetadata): SessionArtifactMetadata {
  return Object.freeze({ ...value });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) throw new TypeError(`${name} must not exceed ${maximum}`);
  return parsed;
}
