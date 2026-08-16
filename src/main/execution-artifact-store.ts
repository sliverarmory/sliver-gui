import { createHash, randomBytes } from "node:crypto";

const KiB = 1_024;
const MiB = 1_024 * KiB;
const MAX_TIMER_DELAY_MILLISECONDS = 2_147_483_647;
const MAX_DATE_MILLISECONDS = 8_640_000_000_000_000;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_SCOPE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,128}$/u;
const SAFE_ROLE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,64}$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;

export const EXECUTION_ARTIFACT_MAX_BYTES = 64 * MiB;
export const EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS = 60 * 1_000;
export const EXECUTION_ARTIFACT_RESULT_TTL_MILLISECONDS = 5 * 60 * 1_000;
export const EXECUTION_ARTIFACT_DEFAULT_WINDOW_BYTE_LIMIT = 128 * MiB;
export const EXECUTION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT = 256 * MiB;

/**
 * Internal mirror of the identity-bearing fields in a main-issued TargetRef.
 * This store deliberately does not import or widen renderer-facing contracts.
 */
export interface ExecutionArtifactTargetRef {
  readonly mode: "session" | "beacon";
  readonly id: string;
  readonly backendEpoch: number;
  /** Catalog freshness marker; identity comparisons use the exact fingerprint. */
  readonly domainRevision: number;
  readonly fingerprint: string;
}

/** The current connection authority owned by one BrowserWindow. */
export interface ExecutionArtifactOwnerBinding {
  readonly ownerWindowId: number;
  /** Stable backend/configuration identity, not a display name. */
  readonly backendId: string;
  readonly backendEpoch: number;
  readonly connectionIncarnation: number;
}

/**
 * The complete capability scope for one staged input or retained result.
 * Operation and role are exact, main-authored identities, not display text.
 */
export interface ExecutionArtifactScope extends ExecutionArtifactOwnerBinding {
  readonly target: ExecutionArtifactTargetRef;
  readonly operationId: string;
  readonly role: string;
}

export interface ExecutionArtifactTargetBinding extends ExecutionArtifactOwnerBinding {
  readonly target: ExecutionArtifactTargetRef;
}

export interface ExecutionArtifactOperationBinding extends ExecutionArtifactTargetBinding {
  readonly operationId: string;
}

export interface ExecutionArtifactBackendBinding {
  readonly backendId: string;
  readonly backendEpoch: number;
}

export interface ExecutionArtifactMetadata {
  readonly handle: string;
  readonly suggestedBasename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface StoreExecutionArtifactInput {
  readonly scope: ExecutionArtifactScope;
  readonly data: Buffer;
  readonly mediaType: string;
  readonly suggestedBasename: string;
}

export interface ExecutionArtifactData {
  readonly metadata: ExecutionArtifactMetadata;
  /** Caller-owned clone. The caller is responsible for clearing it after use. */
  readonly data: Buffer;
}

export interface ExecutionArtifactStoreUsage {
  readonly itemCount: number;
  readonly byteCount: number;
}

export interface ExecutionArtifactTimerHandle {
  unref?(): void;
}

export interface ExecutionArtifactTimers {
  setTimeout(callback: () => void, delayMilliseconds: number): ExecutionArtifactTimerHandle;
  clearTimeout(handle: ExecutionArtifactTimerHandle): void;
}

export interface ExecutionArtifactStoreOptions {
  readonly maximumArtifactBytes?: number;
  readonly perWindowByteLimit?: number;
  readonly globalByteLimit?: number;
  readonly now?: () => number;
  readonly timers?: ExecutionArtifactTimers;
  /** Disable only for deterministic callers that invoke `pruneExpired` themselves. */
  readonly autoPrune?: boolean;
  /** Test/diagnostic observer. It is called only after the buffer has been cleared. */
  readonly onDidZeroize?: (clearedData: Buffer) => void;
}

type ExecutionArtifactKind = "input" | "result";

interface StoredExecutionArtifact {
  readonly kind: ExecutionArtifactKind;
  readonly scope: ExecutionArtifactScope;
  readonly metadata: ExecutionArtifactMetadata;
  readonly expiresAtMilliseconds: number;
  readonly data: Buffer;
}

interface MutableUsage {
  itemCount: number;
  byteCount: number;
}

const DEFAULT_TIMERS: ExecutionArtifactTimers = Object.freeze({
  setTimeout(callback: () => void, delayMilliseconds: number): ExecutionArtifactTimerHandle {
    return setTimeout(callback, delayMilliseconds);
  },
  clearTimeout(handle: ExecutionArtifactTimerHandle): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

export class ExecutionArtifactAccessError extends Error {
  constructor() {
    super("The execution artifact is unavailable for the current window, connection, target, operation, or role");
    this.name = "ExecutionArtifactAccessError";
  }
}

export class ExecutionArtifactCapacityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionArtifactCapacityError";
  }
}

/**
 * Main-process-only storage for sensitive execution inputs and bounded results.
 *
 * Handles are capabilities bound to an exact owner connection, TargetRef,
 * operation, and role. Input handles are one-use and expire after 60 seconds;
 * result handles may be read repeatedly until their five-minute expiration.
 * Bytes are always cloned on ingress and egress and cleared on every teardown.
 */
export class ExecutionArtifactStore {
  private readonly artifacts = new Map<string, StoredExecutionArtifact>();
  private readonly ownerHandles = new Map<number, Set<string>>();
  private readonly ownerUsage = new Map<number, MutableUsage>();
  private readonly ownerBindings = new Map<number, ExecutionArtifactOwnerBinding>();
  private readonly maximumArtifactBytes: number;
  private readonly perWindowByteLimit: number;
  private readonly globalByteLimit: number;
  private readonly now: () => number;
  private readonly timers: ExecutionArtifactTimers;
  private readonly autoPrune: boolean;
  private readonly onDidZeroize: ((clearedData: Buffer) => void) | undefined;
  private totalBytes = 0;
  private expiryTimer: ExecutionArtifactTimerHandle | undefined;
  private closed = false;

  constructor(options: ExecutionArtifactStoreOptions = {}) {
    this.maximumArtifactBytes = boundedPositiveInteger(
      options.maximumArtifactBytes ?? EXECUTION_ARTIFACT_MAX_BYTES,
      "maximumArtifactBytes",
      EXECUTION_ARTIFACT_MAX_BYTES,
    );
    this.perWindowByteLimit = boundedPositiveInteger(
      options.perWindowByteLimit ?? EXECUTION_ARTIFACT_DEFAULT_WINDOW_BYTE_LIMIT,
      "perWindowByteLimit",
      EXECUTION_ARTIFACT_DEFAULT_WINDOW_BYTE_LIMIT,
    );
    this.globalByteLimit = boundedPositiveInteger(
      options.globalByteLimit ?? EXECUTION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT,
      "globalByteLimit",
      EXECUTION_ARTIFACT_DEFAULT_GLOBAL_BYTE_LIMIT,
    );
    if (this.perWindowByteLimit > this.globalByteLimit) {
      throw new TypeError("perWindowByteLimit must not exceed globalByteLimit");
    }
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? DEFAULT_TIMERS;
    this.autoPrune = options.autoPrune !== false;
    this.onDidZeroize = options.onDidZeroize;
  }

  /**
   * Installs the current main-owned connection identity for a window. Changing
   * it revokes every artifact issued under the previous connection, while
   * changing active targets within the same connection does not.
   */
  bindOwner(binding: ExecutionArtifactOwnerBinding): void {
    this.assertOpen();
    const normalized = normalizeOwnerBinding(binding);
    const current = this.ownerBindings.get(normalized.ownerWindowId);
    if (current && !sameOwnerBinding(current, normalized)) {
      this.removeArtifactsForOwner(normalized.ownerWindowId);
    }
    this.ownerBindings.set(normalized.ownerWindowId, normalized);
    this.scheduleExpiryPrune();
  }

  storeInput(input: StoreExecutionArtifactInput): ExecutionArtifactMetadata {
    return this.store("input", input);
  }

  storeResult(input: StoreExecutionArtifactInput): ExecutionArtifactMetadata {
    return this.store("result", input);
  }

  metadata(scope: ExecutionArtifactScope, handle: string): ExecutionArtifactMetadata {
    return this.requireArtifact(scope, handle).metadata;
  }

  /** Consumes and revokes an input capability exactly once. */
  consumeInput(scope: ExecutionArtifactScope, handle: string): ExecutionArtifactData {
    const artifact = this.requireArtifact(scope, handle, "input");
    const data = Buffer.from(artifact.data);
    const metadata = artifact.metadata;
    this.destroyHandle(handle);
    this.scheduleExpiryPrune();
    return { metadata, data };
  }

  /** Returns a caller-owned clone while retaining the bounded result capability. */
  getResult(scope: ExecutionArtifactScope, handle: string): ExecutionArtifactData {
    const artifact = this.requireArtifact(scope, handle, "result");
    return { metadata: artifact.metadata, data: Buffer.from(artifact.data) };
  }

  remove(scope: ExecutionArtifactScope, handle: string): void {
    this.requireArtifact(scope, handle);
    this.destroyHandle(handle);
    this.scheduleExpiryPrune();
  }

  removeOperation(binding: ExecutionArtifactOperationBinding): number {
    this.assertOpen();
    const normalized = normalizeOperationBinding(binding);
    const removed = this.removeMatching((artifact) => sameOperationBinding(artifact.scope, normalized));
    this.scheduleExpiryPrune();
    return removed;
  }

  removeTarget(binding: ExecutionArtifactTargetBinding): number {
    this.assertOpen();
    const normalized = normalizeTargetBinding(binding);
    const removed = this.removeMatching((artifact) => sameTargetBinding(artifact.scope, normalized));
    this.scheduleExpiryPrune();
    return removed;
  }

  removeBackend(binding: ExecutionArtifactBackendBinding): number {
    this.assertOpen();
    const normalized = normalizeBackendBinding(binding);
    const removed = this.removeMatching((artifact) => sameBackendBinding(artifact.scope, normalized));
    for (const [ownerWindowId, ownerBinding] of this.ownerBindings) {
      if (sameBackendBinding(ownerBinding, normalized)) this.ownerBindings.delete(ownerWindowId);
    }
    this.scheduleExpiryPrune();
    return removed;
  }

  removeOwner(ownerWindowId: number): number {
    this.assertOpen();
    positiveInteger(ownerWindowId, "ownerWindowId");
    const removed = this.removeArtifactsForOwner(ownerWindowId);
    this.ownerBindings.delete(ownerWindowId);
    this.scheduleExpiryPrune();
    return removed;
  }

  pruneExpired(): number {
    this.assertOpen();
    const removed = this.pruneExpiredAt(this.currentTime());
    this.scheduleExpiryPrune();
    return removed;
  }

  usage(ownerWindowId?: number): ExecutionArtifactStoreUsage {
    this.assertOpen();
    this.pruneExpiredAt(this.currentTime());
    if (ownerWindowId === undefined) {
      return Object.freeze({ itemCount: this.artifacts.size, byteCount: this.totalBytes });
    }
    positiveInteger(ownerWindowId, "ownerWindowId");
    const usage = this.ownerUsage.get(ownerWindowId);
    return Object.freeze({ itemCount: usage?.itemCount ?? 0, byteCount: usage?.byteCount ?? 0 });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.expiryTimer) this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    for (const handle of [...this.artifacts.keys()]) this.destroyHandle(handle);
    this.ownerBindings.clear();
  }

  private store(kind: ExecutionArtifactKind, input: StoreExecutionArtifactInput): ExecutionArtifactMetadata {
    this.assertOpen();
    if (!Buffer.isBuffer(input.data)) throw new TypeError("Execution artifact data must be a Buffer");
    const scope = normalizeScope(input.scope);
    this.assertCurrentOwnerBinding(scope);
    if (input.data.length > this.maximumArtifactBytes) {
      throw new ExecutionArtifactCapacityError(
        `Execution artifacts must not exceed ${this.maximumArtifactBytes} bytes`,
      );
    }
    if (input.data.length > this.perWindowByteLimit || input.data.length > this.globalByteLimit) {
      throw new ExecutionArtifactCapacityError("The execution artifact exceeds the configured store capacity");
    }
    const mediaType = normalizeMediaType(input.mediaType);
    const suggestedBasename = safeSuggestedBasename(input.suggestedBasename);
    const createdAtMilliseconds = this.currentTime();
    const ttlMilliseconds = kind === "input"
      ? EXECUTION_ARTIFACT_INPUT_TTL_MILLISECONDS
      : EXECUTION_ARTIFACT_RESULT_TTL_MILLISECONDS;
    const expiresAtMilliseconds = createdAtMilliseconds + ttlMilliseconds;
    if (!Number.isSafeInteger(expiresAtMilliseconds) || expiresAtMilliseconds > MAX_DATE_MILLISECONDS) {
      throw new TypeError("Execution artifact expiration is outside the supported date range");
    }

    this.pruneExpiredAt(createdAtMilliseconds);
    const owner = this.ownerUsage.get(scope.ownerWindowId);
    if ((owner?.byteCount ?? 0) + input.data.length > this.perWindowByteLimit) {
      throw new ExecutionArtifactCapacityError("The per-window execution artifact capacity is exhausted");
    }
    if (this.totalBytes + input.data.length > this.globalByteLimit) {
      throw new ExecutionArtifactCapacityError("The global execution artifact capacity is exhausted");
    }

    let storedData: Buffer | undefined;
    let storedHandle: string | undefined;
    try {
      storedData = Buffer.from(input.data);
      const handle = this.createHandle();
      storedHandle = handle;
      const metadata = freezeMetadata({
        handle,
        suggestedBasename,
        mediaType,
        size: storedData.length,
        sha256: createHash("sha256").update(storedData).digest("hex"),
        createdAt: new Date(createdAtMilliseconds).toISOString(),
        expiresAt: new Date(expiresAtMilliseconds).toISOString(),
      });
      this.artifacts.set(handle, { kind, scope, metadata, expiresAtMilliseconds, data: storedData });
      const handles = this.ownerHandles.get(scope.ownerWindowId) ?? new Set<string>();
      handles.add(handle);
      this.ownerHandles.set(scope.ownerWindowId, handles);
      const usage = this.ownerUsage.get(scope.ownerWindowId) ?? { itemCount: 0, byteCount: 0 };
      usage.itemCount += 1;
      usage.byteCount += storedData.length;
      this.ownerUsage.set(scope.ownerWindowId, usage);
      this.totalBytes += storedData.length;
      storedData = undefined;
      storedHandle = undefined;
      this.scheduleExpiryPrune();
      return metadata;
    } catch (error) {
      if (storedHandle) this.destroyHandle(storedHandle);
      if (storedData) {
        storedData.fill(0);
        this.notifyDidZeroize(storedData);
      }
      throw error;
    }
  }

  private requireArtifact(
    scope: ExecutionArtifactScope,
    handle: string,
    expectedKind?: ExecutionArtifactKind,
  ): StoredExecutionArtifact {
    this.assertOpen();
    const normalized = normalizeScope(scope);
    this.assertCurrentOwnerBinding(normalized);
    this.pruneExpiredAt(this.currentTime());
    if (!HANDLE_PATTERN.test(handle)) throw new ExecutionArtifactAccessError();
    const artifact = this.artifacts.get(handle);
    if (
      !artifact ||
      !sameScope(artifact.scope, normalized) ||
      (expectedKind !== undefined && artifact.kind !== expectedKind)
    ) {
      throw new ExecutionArtifactAccessError();
    }
    return artifact;
  }

  private assertCurrentOwnerBinding(scope: ExecutionArtifactOwnerBinding): void {
    const current = this.ownerBindings.get(scope.ownerWindowId);
    if (!current || !sameOwnerBinding(current, scope)) throw new ExecutionArtifactAccessError();
  }

  private removeArtifactsForOwner(ownerWindowId: number): number {
    const handles = [...(this.ownerHandles.get(ownerWindowId) ?? [])];
    for (const handle of handles) this.destroyHandle(handle);
    return handles.length;
  }

  private removeMatching(predicate: (artifact: StoredExecutionArtifact) => boolean): number {
    const handles: string[] = [];
    for (const [handle, artifact] of this.artifacts) {
      if (predicate(artifact)) handles.push(handle);
    }
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
    this.notifyDidZeroize(artifact.data);
  }

  private notifyDidZeroize(data: Buffer): void {
    if (!this.onDidZeroize) return;
    try {
      this.onDidZeroize(Buffer.from(data));
    } catch {
      // A diagnostic observer must never interfere with security cleanup.
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
    if (this.expiryTimer) this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const artifact of this.artifacts.values()) {
      earliest = Math.min(earliest, artifact.expiresAtMilliseconds);
    }
    if (!Number.isFinite(earliest)) return;
    const delay = Math.min(MAX_TIMER_DELAY_MILLISECONDS, Math.max(0, earliest - this.currentTime()));
    const timer = this.timers.setTimeout(() => {
      this.expiryTimer = undefined;
      if (this.closed) return;
      this.pruneExpiredAt(this.currentTime());
      this.scheduleExpiryPrune();
    }, delay);
    timer.unref?.();
    this.expiryTimer = timer;
  }

  private createHandle(): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const handle = randomBytes(32).toString("base64url");
      if (!this.artifacts.has(handle)) return handle;
    }
    throw new Error("Could not allocate a unique execution artifact handle");
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DATE_MILLISECONDS) {
      throw new TypeError("Execution artifact clock returned an invalid timestamp");
    }
    return value;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("The execution artifact store is closed");
  }
}

function normalizeScope(value: ExecutionArtifactScope): ExecutionArtifactScope {
  if (typeof value !== "object" || value === null) throw new TypeError("Execution artifact scope is required");
  const owner = normalizeOwnerBinding(value);
  const target = normalizeTargetRef(value.target);
  if (target.backendEpoch !== owner.backendEpoch) {
    throw new TypeError("TargetRef backendEpoch must match the execution artifact backendEpoch");
  }
  const operationId = safeScopeText(value.operationId, "operationId", SAFE_SCOPE_TEXT_PATTERN);
  const role = safeScopeText(value.role, "role", SAFE_ROLE_TEXT_PATTERN);
  return Object.freeze({ ...owner, target, operationId, role });
}

function normalizeOwnerBinding(value: ExecutionArtifactOwnerBinding): ExecutionArtifactOwnerBinding {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Execution artifact owner binding is required");
  }
  const ownerWindowId = positiveInteger(value.ownerWindowId, "ownerWindowId");
  const backendEpoch = positiveInteger(value.backendEpoch, "backendEpoch");
  const connectionIncarnation = positiveInteger(value.connectionIncarnation, "connectionIncarnation");
  if (!SHA256_PATTERN.test(value.backendId)) throw new TypeError("backendId must be an exact SHA-256 identity");
  return Object.freeze({ ownerWindowId, backendId: value.backendId, backendEpoch, connectionIncarnation });
}

function normalizeTargetRef(value: ExecutionArtifactTargetRef): ExecutionArtifactTargetRef {
  if (typeof value !== "object" || value === null) throw new TypeError("Execution artifact TargetRef is required");
  if (value.mode !== "session" && value.mode !== "beacon") throw new TypeError("TargetRef mode is invalid");
  const id = safeScopeText(value.id, "TargetRef id", SAFE_SCOPE_TEXT_PATTERN);
  const backendEpoch = positiveInteger(value.backendEpoch, "TargetRef backendEpoch");
  const domainRevision = nonNegativeInteger(value.domainRevision, "TargetRef domainRevision");
  if (!SHA256_PATTERN.test(value.fingerprint)) {
    throw new TypeError("TargetRef fingerprint must be an exact SHA-256 identity");
  }
  return Object.freeze({ mode: value.mode, id, backendEpoch, domainRevision, fingerprint: value.fingerprint });
}

function normalizeTargetBinding(value: ExecutionArtifactTargetBinding): ExecutionArtifactTargetBinding {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Execution artifact target binding is required");
  }
  const owner = normalizeOwnerBinding(value);
  const target = normalizeTargetRef(value.target);
  if (target.backendEpoch !== owner.backendEpoch) {
    throw new TypeError("TargetRef backendEpoch must match the execution artifact backendEpoch");
  }
  return Object.freeze({ ...owner, target });
}

function normalizeOperationBinding(value: ExecutionArtifactOperationBinding): ExecutionArtifactOperationBinding {
  const target = normalizeTargetBinding(value);
  const operationId = safeScopeText(value.operationId, "operationId", SAFE_SCOPE_TEXT_PATTERN);
  return Object.freeze({ ...target, operationId });
}

function normalizeBackendBinding(value: ExecutionArtifactBackendBinding): ExecutionArtifactBackendBinding {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Execution artifact backend binding is required");
  }
  if (!SHA256_PATTERN.test(value.backendId)) throw new TypeError("backendId must be an exact SHA-256 identity");
  return Object.freeze({ backendId: value.backendId, backendEpoch: positiveInteger(value.backendEpoch, "backendEpoch") });
}

function sameScope(left: ExecutionArtifactScope, right: ExecutionArtifactScope): boolean {
  return sameOperationBinding(left, right) && left.role === right.role;
}

function sameOperationBinding(
  left: ExecutionArtifactOperationBinding,
  right: ExecutionArtifactOperationBinding,
): boolean {
  return sameTargetBinding(left, right) && left.operationId === right.operationId;
}

function sameTargetBinding(
  left: ExecutionArtifactTargetBinding,
  right: ExecutionArtifactTargetBinding,
): boolean {
  return sameOwnerBinding(left, right) && sameTargetRef(left.target, right.target);
}

function sameOwnerBinding(left: ExecutionArtifactOwnerBinding, right: ExecutionArtifactOwnerBinding): boolean {
  return left.ownerWindowId === right.ownerWindowId &&
    sameBackendBinding(left, right) &&
    left.connectionIncarnation === right.connectionIncarnation;
}

function sameBackendBinding(left: ExecutionArtifactBackendBinding, right: ExecutionArtifactBackendBinding): boolean {
  return left.backendId === right.backendId && left.backendEpoch === right.backendEpoch;
}

function sameTargetRef(left: ExecutionArtifactTargetRef, right: ExecutionArtifactTargetRef): boolean {
  return left.mode === right.mode &&
    left.id === right.id &&
    left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}

function normalizeMediaType(value: string): string {
  if (typeof value !== "string") throw new TypeError("Execution artifact media type must be a string");
  const normalized = value.trim().toLowerCase();
  if (!MEDIA_TYPE_PATTERN.test(normalized)) throw new TypeError("Execution artifact media type is invalid");
  return normalized;
}

function safeSuggestedBasename(value: string): string {
  if (typeof value !== "string") throw new TypeError("Execution artifact basename must be a string");
  const tail = value.normalize("NFC").replaceAll("\\", "/").split("/").at(-1) ?? "";
  const sanitized = [...tail]
    .slice(0, 200)
    .join("")
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/gu, "_")
    .replace(/[. ]+$/gu, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") return "execution-artifact.bin";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(sanitized)
    ? `_${sanitized}`
    : sanitized;
}

function safeScopeText(value: string, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value) || value.trim() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function freezeMetadata(value: ExecutionArtifactMetadata): ExecutionArtifactMetadata {
  return Object.freeze({ ...value });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer`);
  return value;
}

function boundedPositiveInteger(value: number, name: string, maximum: number): number {
  const parsed = positiveInteger(value, name);
  if (parsed > maximum) throw new TypeError(`${name} must not exceed ${maximum}`);
  return parsed;
}
