import { randomBytes } from "node:crypto";

import {
  STREAM_CLOSING_GRACE_MILLISECONDS,
  STREAM_CONTROL_FRAME_BURST,
  STREAM_CONTROL_FRAMES_PER_SECOND,
  STREAM_CREDIT_TIMEOUT_MILLISECONDS,
  STREAM_DETACHED_TTL_MILLISECONDS,
  STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
  STREAM_IDLE_TIMEOUT_MILLISECONDS,
  STREAM_INITIAL_CREDIT_BYTES,
  STREAM_MAX_CREDIT_BYTES,
  STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
  STREAM_MAX_FRAME_BYTES,
  STREAM_MAX_QUEUE_BYTES,
  STREAM_MAX_RESERVED_BYTES_PER_BACKEND,
  STREAM_MAX_RESERVED_BYTES_PER_PROCESS,
  STREAM_MAX_RESERVED_BYTES_PER_WINDOW,
  STREAM_MAX_STREAMS_PER_BACKEND,
  STREAM_MAX_STREAMS_PER_PROCESS,
  STREAM_MAX_STREAMS_PER_WINDOW,
  STREAM_PROTOCOL_VERSION,
  STREAM_RESERVED_BYTES_PER_RESOURCE,
  STREAM_TICKET_TTL_MILLISECONDS,
  STREAM_WRITE_TIMEOUT_MILLISECONDS,
  isOpaqueStreamId,
  parsePrepareSessionShellInput,
  parseSessionShellResourceActionInput,
  parseStreamClientFrame,
  type PrepareSessionShellInput,
  type SessionShellPlan,
  type SessionShellPty,
  type SessionShellResource,
  type SessionShellResourceActionInput,
  type SessionShellResourceActionResult,
  type SessionShellResourceList,
  type SessionShellResourceState,
  type StreamAggregateMetrics,
  type StreamAttachmentTicket,
  type StreamClientFrame,
  type StreamCloseReason,
  type StreamMetrics,
  type StreamPressure,
  type StreamServerFrame,
} from "../shared/stream-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";

const MAX_SAFE_TIME_MILLISECONDS = 8_640_000_000_000_000;
const DEFAULT_SCHEDULER_QUANTUM_BYTES = STREAM_MAX_FRAME_BYTES;
const DEFAULT_MAX_FRAMES_PER_STREAM_TURN = 4;
const DEFAULT_MAX_BYTES_PER_STREAM_TURN = 64 * 1_024;
const DEFAULT_MAX_BYTES_PER_SCHEDULER_TICK = 256 * 1_024;
const DEFAULT_MAX_IN_FLIGHT_WRITES_PER_BACKEND = 4;
const DEFAULT_MAX_IN_FLIGHT_WRITES_PER_PROCESS = 16;
const PRESSURE_HIGH_WATER_FRACTION = 0.75;
const PRESSURE_LOW_WATER_FRACTION = 0.25;
const BINDING_TEXT_PATTERN = /^[^\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]{1,256}$/u;
const TARGET_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

type Timer = ReturnType<typeof setTimeout>;
type StreamEndpointCloseReason = "completed" | "remote-close" | "transport-error";
type TicketPurpose = "start" | "reattach";
type CommandKind = "write" | "resize";

export interface StreamOwnerBinding {
  readonly ownerWindowId: number;
  readonly rendererProcessId: number;
  readonly rendererFrameToken: string;
  /** Main-issued document generation; it must change on every main-frame document replacement. */
  readonly rendererDocumentId: string;
  /** Stable configuration/pool identity. This value is never copied into renderer DTOs or metrics. */
  readonly backendId: string;
  readonly backendEpoch: number;
  readonly connectionIncarnation: number;
  readonly target: TargetRef;
}

export interface StreamAttachmentPort {
  postMessage(frame: StreamServerFrame): void;
  close(): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  start(): void;
}

export interface MainStreamEndpoint {
  write(data: Uint8Array, signal: AbortSignal): Promise<void>;
  resize?(rows: number, columns: number, signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
  kill?(signal: AbortSignal): Promise<void>;
}

export interface StartMainStreamEndpointContext {
  readonly signal: AbortSignal;
  /** Copies accepted output immediately; false means the resource is already terminal. */
  emitOutput(data: Uint8Array): boolean;
  /** Reports only a fixed disposition. Diagnostic errors stay inside the transport implementation. */
  remoteClose(reason: StreamEndpointCloseReason): void;
}

export type StartMainStreamEndpoint = (
  context: StartMainStreamEndpointContext,
) => Promise<MainStreamEndpoint>;

export interface PrepareSessionShellManagerInput {
  readonly binding: StreamOwnerBinding;
  readonly input: PrepareSessionShellInput;
  readonly start: StartMainStreamEndpoint;
}

export interface AttachStreamManagerInput {
  readonly binding: StreamOwnerBinding;
  readonly attachmentToken: string;
  readonly port: StreamAttachmentPort;
}

export interface StreamBackendBinding {
  readonly backendId: string;
  readonly backendEpoch: number;
}

export interface StreamTargetBinding extends StreamBackendBinding {
  readonly target: TargetRef;
}

export interface StreamManagerLimits {
  readonly maxFrameBytes: number;
  readonly initialCreditBytes: number;
  readonly maxCreditBytes: number;
  readonly maxQueueBytes: number;
  readonly maxDetachedScrollbackBytes: number;
  readonly reservedBytesPerResource: number;
  readonly maxStreamsPerWindow: number;
  readonly maxStreamsPerBackend: number;
  readonly maxStreamsPerProcess: number;
  readonly maxReservedBytesPerWindow: number;
  readonly maxReservedBytesPerBackend: number;
  readonly maxReservedBytesPerProcess: number;
  readonly ticketTtlMilliseconds: number;
  readonly handshakeTimeoutMilliseconds: number;
  readonly writeTimeoutMilliseconds: number;
  readonly creditTimeoutMilliseconds: number;
  readonly idleTimeoutMilliseconds: number;
  readonly detachedTtlMilliseconds: number;
  readonly controlFramesPerSecond: number;
  readonly controlFrameBurst: number;
  readonly schedulerQuantumBytes: number;
  readonly maxFramesPerStreamTurn: number;
  readonly maxBytesPerStreamTurn: number;
  readonly maxBytesPerSchedulerTick: number;
  readonly maxInFlightWritesPerBackend: number;
  readonly maxInFlightWritesPerProcess: number;
}

export interface StreamManagerOptions {
  readonly limits?: Partial<StreamManagerLimits>;
  readonly now?: () => number;
  readonly createOpaqueId?: () => string;
  readonly schedule?: (callback: () => void) => void;
}

interface TicketRecord {
  readonly token: string;
  readonly resourceId: string;
  readonly binding: StreamOwnerBinding;
  readonly purpose: TicketPurpose;
  readonly expiresAtMilliseconds: number;
  readonly timer: Timer;
}

interface QueuedChunk {
  readonly data: Uint8Array;
}

interface PendingResize {
  readonly rows: number;
  readonly columns: number;
}

interface InFlightCommand {
  readonly id: number;
  readonly kind: CommandKind;
  readonly data?: Uint8Array;
  byteCount: number;
  settled: boolean;
  readonly promise: Promise<void>;
}

interface Attachment {
  readonly streamId: string;
  readonly port: StreamAttachmentPort;
  removeMessageListener: () => void;
  removeCloseListener: () => void;
  expectedInputSequence: number;
  nextOutputSequence: number;
  inputCreditBytes: number;
  outputCreditBytes: number;
  controlTokens: number;
  controlRefillAtMilliseconds: number;
  started: boolean;
  disposed: boolean;
}

interface StreamResourceRecord {
  readonly resourceId: string;
  binding: StreamOwnerBinding;
  readonly pty: SessionShellPty;
  readonly canResize: boolean;
  readonly createdAtMilliseconds: number;
  readonly start: StartMainStreamEndpoint;
  readonly lifetime: AbortController;
  state: SessionShellResourceState;
  lastActivityAtMilliseconds: number;
  endpoint?: MainStreamEndpoint;
  starterPending: boolean;
  openedCounted: boolean;
  pendingTicketToken?: string;
  attachment?: Attachment;
  inputQueue: QueuedChunk[];
  outputQueue: QueuedChunk[];
  inputQueuedBytes: number;
  outputQueuedBytes: number;
  inFlightInputBytes: number;
  highWaterInputBytes: number;
  highWaterOutputBytes: number;
  bytesFromRenderer: bigint;
  bytesToRenderer: bigint;
  framesFromRenderer: bigint;
  framesToRenderer: bigint;
  pendingResize?: PendingResize;
  commandInFlight?: InFlightCommand;
  nextCommandId: number;
  pressure: StreamPressure;
  handshakeTimer?: Timer;
  creditTimer?: Timer;
  idleTimer?: Timer;
  detachedTimer?: Timer;
  remoteCloseTimer?: Timer;
  remoteClosePending?: "completed" | "remote-close";
  detachedExpiresAtMilliseconds?: number;
  closePromise?: Promise<void>;
}

interface ScopeUsage {
  streamCount: number;
  reservedBytes: number;
  queuedBytes: number;
  inFlightBytes: number;
  highWaterReservedBytes: number;
  highWaterQueuedBytes: number;
  highWaterInFlightBytes: number;
  openedStreams: bigint;
  rejectedStreams: bigint;
  closedStreams: bigint;
  readonly closesByReason: Map<StreamCloseReason, bigint>;
}

export class StreamAccessError extends Error {
  constructor() {
    super("The stream is unavailable for the current window, backend, target, or renderer");
    this.name = "StreamAccessError";
  }
}

export class StreamCapacityError extends Error {
  constructor() {
    super("The bounded stream capacity limit has been reached");
    this.name = "StreamCapacityError";
  }
}

export class StreamProtocolError extends Error {
  constructor() {
    super("The stream peer violated the bounded protocol");
    this.name = "StreamProtocolError";
  }
}

export class StreamStateError extends Error {
  constructor(message = "The stream resource is not in the required state") {
    super(message);
    this.name = "StreamStateError";
  }
}

const DEFAULT_LIMITS: StreamManagerLimits = Object.freeze({
  maxFrameBytes: STREAM_MAX_FRAME_BYTES,
  initialCreditBytes: STREAM_INITIAL_CREDIT_BYTES,
  maxCreditBytes: STREAM_MAX_CREDIT_BYTES,
  maxQueueBytes: STREAM_MAX_QUEUE_BYTES,
  maxDetachedScrollbackBytes: STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
  reservedBytesPerResource: STREAM_RESERVED_BYTES_PER_RESOURCE,
  maxStreamsPerWindow: STREAM_MAX_STREAMS_PER_WINDOW,
  maxStreamsPerBackend: STREAM_MAX_STREAMS_PER_BACKEND,
  maxStreamsPerProcess: STREAM_MAX_STREAMS_PER_PROCESS,
  maxReservedBytesPerWindow: STREAM_MAX_RESERVED_BYTES_PER_WINDOW,
  maxReservedBytesPerBackend: STREAM_MAX_RESERVED_BYTES_PER_BACKEND,
  maxReservedBytesPerProcess: STREAM_MAX_RESERVED_BYTES_PER_PROCESS,
  ticketTtlMilliseconds: STREAM_TICKET_TTL_MILLISECONDS,
  handshakeTimeoutMilliseconds: STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
  writeTimeoutMilliseconds: STREAM_WRITE_TIMEOUT_MILLISECONDS,
  creditTimeoutMilliseconds: STREAM_CREDIT_TIMEOUT_MILLISECONDS,
  idleTimeoutMilliseconds: STREAM_IDLE_TIMEOUT_MILLISECONDS,
  detachedTtlMilliseconds: STREAM_DETACHED_TTL_MILLISECONDS,
  controlFramesPerSecond: STREAM_CONTROL_FRAMES_PER_SECOND,
  controlFrameBurst: STREAM_CONTROL_FRAME_BURST,
  schedulerQuantumBytes: DEFAULT_SCHEDULER_QUANTUM_BYTES,
  maxFramesPerStreamTurn: DEFAULT_MAX_FRAMES_PER_STREAM_TURN,
  maxBytesPerStreamTurn: DEFAULT_MAX_BYTES_PER_STREAM_TURN,
  maxBytesPerSchedulerTick: DEFAULT_MAX_BYTES_PER_SCHEDULER_TICK,
  maxInFlightWritesPerBackend: DEFAULT_MAX_IN_FLIGHT_WRITES_PER_BACKEND,
  maxInFlightWritesPerProcess: DEFAULT_MAX_IN_FLIGHT_WRITES_PER_PROCESS,
});

/**
 * Main-process lifecycle and flow-control engine for locally owned streams.
 *
 * It deliberately knows nothing about Electron or Sliver RPC objects. The IPC
 * boundary supplies a tiny port adapter and the session service supplies a
 * purpose-built endpoint starter, keeping raw transport handles main-only.
 */
export class StreamManager {
  private readonly resources = new Map<string, StreamResourceRecord>();
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly windowUsage = new Map<number, ScopeUsage>();
  private readonly backendUsage = new Map<string, ScopeUsage>();
  private processUsage = newScopeUsage();
  private readonly limits: StreamManagerLimits;
  private readonly now: () => number;
  private readonly createOpaqueId: () => string;
  private readonly schedule: (callback: () => void) => void;
  private pumpScheduled = false;
  private schedulerCursor = 0;
  private inFlightWrites = 0;
  private readonly inFlightWritesByBackend = new Map<string, number>();
  private closed = false;

  constructor(options: StreamManagerOptions = {}) {
    this.limits = normalizeLimits(options.limits);
    this.now = options.now ?? Date.now;
    this.createOpaqueId = options.createOpaqueId ?? (() => randomBytes(32).toString("base64url"));
    this.schedule = options.schedule ?? ((callback) => setImmediate(callback));
  }

  prepareSessionShell(input: PrepareSessionShellManagerInput): SessionShellPlan {
    this.assertOpen();
    const binding = normalizeBinding(input.binding);
    const shellInput = parsePrepareSessionShellInput(input.input);
    if (typeof input.start !== "function") throw new TypeError("Stream endpoint starter must be a function");
    const pty: SessionShellPty = shellInput.requestPty ? "requested-unconfirmed" : "disabled";
    this.reserveAdmission(binding);
    let resourceId: string | undefined;
    try {
      const createdAtMilliseconds = this.currentTime();
      resourceId = this.newOpaqueId();
      const resource: StreamResourceRecord = {
        resourceId,
        binding,
        pty,
        canResize: shellInput.requestPty,
        createdAtMilliseconds,
        start: input.start,
        lifetime: new AbortController(),
        state: "prepared",
        lastActivityAtMilliseconds: createdAtMilliseconds,
        starterPending: false,
        openedCounted: false,
        inputQueue: [],
        outputQueue: [],
        inputQueuedBytes: 0,
        outputQueuedBytes: 0,
        inFlightInputBytes: 0,
        highWaterInputBytes: 0,
        highWaterOutputBytes: 0,
        bytesFromRenderer: 0n,
        bytesToRenderer: 0n,
        framesFromRenderer: 0n,
        framesToRenderer: 0n,
        nextCommandId: 0,
        pressure: "normal",
      };
      this.resources.set(resourceId, resource);
      const attachment = this.issueTicket(resource, "start");
      return Object.freeze({
        resourceId,
        kind: "session-shell",
        pty,
        canResize: resource.canResize,
        createdAt: isoDate(createdAtMilliseconds),
        attachment,
      });
    } catch (error) {
      if (resourceId) this.resources.delete(resourceId);
      this.releaseAdmissionForBinding(binding, "transport-error", false);
      throw error;
    }
  }

  attach(input: AttachStreamManagerInput): string {
    this.assertOpen();
    const binding = normalizeBinding(input.binding);
    const port = requirePort(input.port);
    const token = input.attachmentToken;
    if (typeof token !== "string" || !isOpaqueStreamId(token)) {
      safeClosePort(port);
      this.recordRejection(binding);
      throw new StreamAccessError();
    }

    const ticket = this.tickets.get(token);
    const now = this.currentTime();
    if (!ticket || ticket.expiresAtMilliseconds <= now || !sameBinding(ticket.binding, binding)) {
      if (ticket && ticket.expiresAtMilliseconds <= now) this.expireTicket(ticket.token);
      safeClosePort(port);
      this.recordRejection(binding);
      throw new StreamAccessError();
    }
    const resource = this.resources.get(ticket.resourceId);
    if (
      !resource ||
      resource.state === "closing" ||
      resource.attachment ||
      resource.pendingTicketToken !== token ||
      (ticket.purpose === "start" && resource.state !== "prepared") ||
      (ticket.purpose === "reattach" && resource.state !== "detached")
    ) {
      safeClosePort(port);
      this.recordRejection(binding);
      throw new StreamAccessError();
    }

    let streamId: string;
    try {
      streamId = this.newOpaqueId();
    } catch (error) {
      safeClosePort(port);
      throw error;
    }
    this.consumeTicket(ticket, resource);
    const attachment: Attachment = {
      streamId,
      port,
      removeMessageListener: () => undefined,
      removeCloseListener: () => undefined,
      expectedInputSequence: 0,
      nextOutputSequence: 0,
      inputCreditBytes: 0,
      outputCreditBytes: 0,
      controlTokens: this.limits.controlFrameBurst,
      controlRefillAtMilliseconds: now,
      started: false,
      disposed: false,
    };
    resource.attachment = attachment;
    resource.state = "handshaking";
    delete resource.detachedExpiresAtMilliseconds;
    clearManagedTimer(resource.detachedTimer);
    delete resource.detachedTimer;

    try {
      attachment.removeMessageListener = port.onMessage((message) =>
        this.receivePortMessage(resource.resourceId, streamId, message));
      attachment.removeCloseListener = port.onClose(() =>
        this.receivePortClose(resource.resourceId, streamId));
      port.start();
      this.sendFrame(resource, attachment, {
        v: STREAM_PROTOCOL_VERSION,
        type: "ready",
        streamId,
        limits: Object.freeze({
          maxFrameBytes: this.limits.maxFrameBytes,
          maxCreditBytes: this.limits.maxCreditBytes,
          inputCreditBytes: this.availableInitialInputCredit(resource),
          handshakeTimeoutMilliseconds: this.limits.handshakeTimeoutMilliseconds,
          idleTimeoutMilliseconds: this.limits.idleTimeoutMilliseconds,
        }),
      });
      if (resource.attachment === attachment && !attachment.disposed && !attachment.started) {
        resource.handshakeTimer = managedTimeout(() => {
          if (resource.attachment?.streamId === streamId && !resource.attachment.started) {
            void this.closeResource(resource, "handshake-timeout");
          }
        }, this.limits.handshakeTimeoutMilliseconds);
      }
      return streamId;
    } catch {
      this.disposeAttachment(resource, attachment);
      void this.closeResource(resource, "protocol-error");
      throw new StreamProtocolError();
    }
  }

  /**
   * Move every live shell owned by one exact renderer binding to another
   * application window without exposing a transferable capability to either
   * renderer. The destination must already be bound to the same backend epoch
   * and exact session identity.
   *
   * Validation and destination admission happen before any ticket,
   * attachment, resource, or accounting state changes. Once admitted, active
   * renderer ports are intentionally detached and every old ticket is revoked;
   * the destination must request a fresh one-use reattachment ticket.
   */
  transferSessionShells(
    sourceBindingInput: StreamOwnerBinding,
    destinationBindingInput: StreamOwnerBinding,
  ): readonly string[] {
    this.assertOpen();
    const sourceBinding = normalizeBinding(sourceBindingInput);
    const destinationBinding = normalizeBinding(destinationBindingInput);
    if (
      sourceBinding.ownerWindowId === destinationBinding.ownerWindowId ||
      !sameBackend(sourceBinding, destinationBinding) ||
      !sameTargetIdentity(sourceBinding.target, destinationBinding.target)
    ) {
      throw new StreamAccessError();
    }

    const resources = [...this.resources.values()].filter((resource) =>
      resource.state !== "closing" && sameBinding(resource.binding, sourceBinding));
    if (resources.length === 0) return Object.freeze([]);

    const sourceUsage = this.windowUsage.get(sourceBinding.ownerWindowId);
    const destinationUsage = this.windowUsage.get(destinationBinding.ownerWindowId) ?? newScopeUsage();
    const reservedBytes = resources.length * this.limits.reservedBytesPerResource;
    const queuedBytes = resources.reduce(
      (total, resource) => total + resource.inputQueuedBytes + resource.outputQueuedBytes,
      0,
    );
    const inFlightBytes = resources.reduce((total, resource) => total + resource.inFlightInputBytes, 0);
    if (
      !sourceUsage ||
      sourceUsage.streamCount < resources.length ||
      sourceUsage.reservedBytes < reservedBytes ||
      sourceUsage.queuedBytes < queuedBytes ||
      sourceUsage.inFlightBytes < inFlightBytes
    ) {
      throw new StreamStateError("The source shell accounting is unavailable");
    }
    if (
      destinationUsage.streamCount + resources.length > this.limits.maxStreamsPerWindow ||
      destinationUsage.reservedBytes + reservedBytes > this.limits.maxReservedBytesPerWindow
    ) {
      throw new StreamCapacityError();
    }

    for (const resource of resources) this.detachResourceForTransfer(resource);

    sourceUsage.streamCount -= resources.length;
    sourceUsage.reservedBytes -= reservedBytes;
    sourceUsage.queuedBytes -= queuedBytes;
    sourceUsage.inFlightBytes -= inFlightBytes;
    destinationUsage.streamCount += resources.length;
    destinationUsage.reservedBytes += reservedBytes;
    destinationUsage.queuedBytes += queuedBytes;
    destinationUsage.inFlightBytes += inFlightBytes;
    destinationUsage.highWaterReservedBytes = Math.max(
      destinationUsage.highWaterReservedBytes,
      destinationUsage.reservedBytes,
    );
    destinationUsage.highWaterQueuedBytes = Math.max(
      destinationUsage.highWaterQueuedBytes,
      destinationUsage.queuedBytes,
    );
    destinationUsage.highWaterInFlightBytes = Math.max(
      destinationUsage.highWaterInFlightBytes,
      destinationUsage.inFlightBytes,
    );
    this.windowUsage.set(destinationBinding.ownerWindowId, destinationUsage);

    for (const resource of resources) resource.binding = destinationBinding;
    return Object.freeze(resources.map((resource) => resource.resourceId));
  }

  listSessionShells(bindingInput: StreamOwnerBinding): SessionShellResourceList {
    const binding = normalizeBinding(bindingInput);
    const resources = [...this.resources.values()]
      .filter((resource) => sameBinding(resource.binding, binding))
      .sort((left, right) => left.createdAtMilliseconds - right.createdAtMilliseconds ||
        left.resourceId.localeCompare(right.resourceId))
      .map((resource) => this.publicResource(resource));
    return Object.freeze({
      resources: Object.freeze(resources),
      metrics: this.metricsForWindow(binding.ownerWindowId),
    });
  }

  async actOnSessionShell(
    bindingInput: StreamOwnerBinding,
    actionInput: SessionShellResourceActionInput,
  ): Promise<SessionShellResourceActionResult> {
    this.assertOpen();
    const binding = normalizeBinding(bindingInput);
    const action = parseSessionShellResourceActionInput(actionInput);
    const resource = this.resources.get(action.resourceId);
    if (!resource || !sameBinding(resource.binding, binding) || resource.state === "closing") {
      this.recordRejection(binding);
      throw new StreamAccessError();
    }

    switch (action.action) {
      case "attach": {
        if (resource.state !== "detached" || resource.attachment || resource.pendingTicketToken) {
          throw new StreamStateError("Only a detached shell can be attached");
        }
        const attachment = this.issueTicket(resource, "reattach");
        return Object.freeze({
          action: action.action,
          resourceId: resource.resourceId,
          resource: this.publicResource(resource),
          attachment,
        });
      }
      case "detach": {
        if (!resource.attachment || (resource.state !== "attached" && resource.state !== "opening")) {
          throw new StreamStateError("Only an attached shell can be detached");
        }
        this.detachResource(resource, "operator-detach");
        return Object.freeze({
          action: action.action,
          resourceId: resource.resourceId,
          resource: this.publicResource(resource),
        });
      }
      case "close": {
        await this.closeResource(resource, "operator-close");
        return Object.freeze({ action: action.action, resourceId: resource.resourceId });
      }
      case "kill": {
        if (!resource.endpoint?.kill) throw new StreamStateError("This shell cannot be killed");
        try {
          await this.runEndpointAction((signal) => resource.endpoint!.kill!(signal));
        } catch {
          await this.closeResource(resource, "transport-error");
          throw new StreamStateError("The shell kill request did not complete");
        }
        await this.closeResource(resource, "operator-close");
        return Object.freeze({ action: action.action, resourceId: resource.resourceId });
      }
    }
  }

  metricsForWindow(ownerWindowId: number): StreamAggregateMetrics {
    requirePositiveInteger(ownerWindowId, "ownerWindowId");
    return publicAggregate(
      this.windowUsage.get(ownerWindowId) ?? newScopeUsage(),
      this.resources.values(),
      (resource) => resource.binding.ownerWindowId === ownerWindowId,
    );
  }

  metricsForBackend(binding: StreamBackendBinding): StreamAggregateMetrics {
    const normalized = normalizeBackendBinding(binding);
    return publicAggregate(
      this.backendUsage.get(backendKey(normalized)) ?? newScopeUsage(),
      this.resources.values(),
      (resource) => sameBackend(resource.binding, normalized),
    );
  }

  metricsForProcess(): StreamAggregateMetrics {
    return publicAggregate(this.processUsage, this.resources.values(), () => true);
  }

  async closeBinding(bindingInput: StreamOwnerBinding, reason: StreamCloseReason = "backend-rebound"): Promise<void> {
    const binding = normalizeBinding(bindingInput);
    await this.closeMatching((resource) => sameBinding(resource.binding, binding), reason);
  }

  async closeTarget(bindingInput: StreamTargetBinding, reason: StreamCloseReason = "target-disappeared"): Promise<void> {
    const binding = normalizeTargetBinding(bindingInput);
    await this.closeMatching(
      (resource) => sameBackend(resource.binding, binding) && sameTargetIdentity(resource.binding.target, binding.target),
      reason,
    );
  }

  async closeBackend(bindingInput: StreamBackendBinding, reason: StreamCloseReason = "backend-disconnected"): Promise<void> {
    const binding = normalizeBackendBinding(bindingInput);
    await this.closeMatching((resource) => sameBackend(resource.binding, binding), reason);
    this.backendUsage.delete(backendKey(binding));
  }

  async closeWindow(ownerWindowId: number, reason: StreamCloseReason = "window-closed"): Promise<void> {
    requirePositiveInteger(ownerWindowId, "ownerWindowId");
    await this.closeMatching((resource) => resource.binding.ownerWindowId === ownerWindowId, reason);
    this.windowUsage.delete(ownerWindowId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const ticket of this.tickets.values()) clearManagedTimer(ticket.timer);
    this.tickets.clear();
    await Promise.allSettled([...this.resources.values()].map((resource) =>
      this.closeResource(resource, "application-shutdown")));
    this.resources.clear();
    this.windowUsage.clear();
    this.backendUsage.clear();
    this.inFlightWritesByBackend.clear();
    this.inFlightWrites = 0;
    this.processUsage = newScopeUsage();
  }

  private issueTicket(resource: StreamResourceRecord, purpose: TicketPurpose): StreamAttachmentTicket {
    if (resource.pendingTicketToken) throw new StreamStateError("This shell already has a pending attachment");
    const now = this.currentTime();
    const expiresAtMilliseconds = safeFutureTime(now, this.limits.ticketTtlMilliseconds);
    const token = this.newOpaqueId();
    const timer = managedTimeout(() => this.expireTicket(token), this.limits.ticketTtlMilliseconds);
    const ticket: TicketRecord = {
      token,
      resourceId: resource.resourceId,
      binding: resource.binding,
      purpose,
      expiresAtMilliseconds,
      timer,
    };
    this.tickets.set(token, ticket);
    resource.pendingTicketToken = token;
    return Object.freeze({ attachmentToken: token, expiresAt: isoDate(expiresAtMilliseconds) });
  }

  private expireTicket(token: string): void {
    const ticket = this.tickets.get(token);
    if (!ticket) return;
    this.tickets.delete(token);
    const resource = this.resources.get(ticket.resourceId);
    if (!resource || resource.pendingTicketToken !== token) return;
    delete resource.pendingTicketToken;
    if (ticket.purpose === "start" && resource.state === "prepared") {
      void this.closeResource(resource, "handshake-timeout");
    }
  }

  private consumeTicket(ticket: TicketRecord, resource: StreamResourceRecord): void {
    this.tickets.delete(ticket.token);
    clearManagedTimer(ticket.timer);
    if (resource.pendingTicketToken === ticket.token) delete resource.pendingTicketToken;
  }

  private receivePortMessage(resourceId: string, streamId: string, message: unknown): void {
    const resource = this.resources.get(resourceId);
    const attachment = resource?.attachment;
    if (!resource || !attachment || attachment.streamId !== streamId || attachment.disposed) {
      scrubPotentialDataFrame(message);
      return;
    }
    let frame: StreamClientFrame;
    try {
      frame = parseStreamClientFrame(message);
    } catch {
      scrubPotentialDataFrame(message);
      void this.closeResource(resource, "protocol-error");
      return;
    }
    if (frame.streamId !== streamId) {
      scrubPotentialDataFrame(frame);
      void this.closeResource(resource, "protocol-error");
      return;
    }
    if (frame.type !== "data" && frame.type !== "close" && !this.consumeControlToken(attachment)) {
      void this.closeResource(resource, "protocol-error");
      return;
    }

    switch (frame.type) {
      case "start":
        this.handleStartFrame(resource, attachment, frame.receiveCreditBytes);
        return;
      case "data":
        this.handleDataFrame(resource, attachment, frame.sequence, frame.data);
        return;
      case "credit":
        this.handleCreditFrame(resource, attachment, frame.bytes);
        return;
      case "resize":
        this.handleResizeFrame(resource, attachment, frame.rows, frame.columns);
        return;
      case "close":
        if (frame.disposition === "detach") {
          if (resource.state === "handshaking") {
            void this.closeResource(resource, "protocol-error");
          } else {
            this.detachResource(resource, "operator-detach");
          }
        } else {
          void this.closeResource(resource, "operator-close");
        }
        return;
    }
  }

  private receivePortClose(resourceId: string, streamId: string): void {
    const resource = this.resources.get(resourceId);
    const attachment = resource?.attachment;
    if (!resource || !attachment || attachment.streamId !== streamId || attachment.disposed) return;
    void this.closeResource(resource, "port-closed");
  }

  private handleStartFrame(resource: StreamResourceRecord, attachment: Attachment, receiveCreditBytes: number): void {
    if (
      resource.state !== "handshaking" ||
      attachment.started ||
      receiveCreditBytes > this.limits.maxCreditBytes
    ) {
      void this.closeResource(resource, "protocol-error");
      return;
    }
    attachment.started = true;
    attachment.outputCreditBytes = receiveCreditBytes;
    attachment.inputCreditBytes = this.availableInitialInputCredit(resource);
    clearManagedTimer(resource.handshakeTimer);
    delete resource.handshakeTimer;
    this.touch(resource);

    if (resource.endpoint) {
      resource.state = "attached";
      this.sendOpened(resource, attachment);
      this.resetIdleTimer(resource);
      this.schedulePump();
      return;
    }
    if (resource.starterPending) {
      // An opening resource can move between the workspace and its dedicated
      // window while the one remote start remains pending. The fresh exact
      // attachment joins that start; it must not submit a second shell RPC.
      resource.state = "opening";
      resource.handshakeTimer = managedTimeout(() => {
        const current = this.resources.get(resource.resourceId);
        if (current?.state === "opening" && current.starterPending) {
          void this.closeResource(current, "handshake-timeout");
        }
      }, this.limits.handshakeTimeoutMilliseconds);
      return;
    }

    resource.state = "opening";
    resource.starterPending = true;
    resource.handshakeTimer = managedTimeout(() => {
      const current = this.resources.get(resource.resourceId);
      if (current?.state === "opening" && current.starterPending) {
        void this.closeResource(current, "handshake-timeout");
      }
    }, this.limits.handshakeTimeoutMilliseconds);
    const context: StartMainStreamEndpointContext = Object.freeze({
      signal: resource.lifetime.signal,
      emitOutput: (data: Uint8Array) => this.acceptEndpointOutput(resource.resourceId, data),
      remoteClose: (reason: StreamEndpointCloseReason) => {
        const closeReason: StreamCloseReason = reason === "transport-error" ? "transport-error" : reason;
        const current = this.resources.get(resource.resourceId);
        if (current) {
          if (reason === "transport-error") void this.closeResource(current, closeReason);
          else this.beginRemoteClose(current, reason);
        }
      },
    });

    let startPromise: Promise<MainStreamEndpoint>;
    try {
      startPromise = Promise.resolve(resource.start(context));
    } catch {
      resource.starterPending = false;
      void this.closeResource(resource, "transport-error");
      return;
    }
    void startPromise.then(
      (endpoint) => this.finishEndpointStart(resource.resourceId, endpoint),
      () => {
        const current = this.resources.get(resource.resourceId);
        if (current) {
          current.starterPending = false;
          void this.closeResource(current, "transport-error");
        }
      },
    );
  }

  private finishEndpointStart(resourceId: string, endpointInput: MainStreamEndpoint): void {
    let endpoint: MainStreamEndpoint;
    try {
      endpoint = requireEndpoint(endpointInput);
    } catch {
      const current = this.resources.get(resourceId);
      if (current) {
        current.starterPending = false;
        void this.closeResource(current, "transport-error");
      }
      return;
    }

    const resource = this.resources.get(resourceId);
    if (!resource || resource.state === "closing" || resource.lifetime.signal.aborted) {
      void safeCloseEndpoint(endpoint, this.limits.writeTimeoutMilliseconds);
      return;
    }
    resource.starterPending = false;
    clearManagedTimer(resource.handshakeTimer);
    delete resource.handshakeTimer;
    resource.endpoint = endpoint;
    if (!resource.openedCounted) {
      resource.openedCounted = true;
      this.adjustOpened(resource.binding, 1n);
    }
    if (resource.attachment?.started) {
      resource.state = "attached";
      this.sendOpened(resource, resource.attachment);
    } else {
      resource.state = "detached";
      this.resetDetachedTimer(resource);
    }
    this.resetIdleTimer(resource);
    this.schedulePump();
  }

  private beginRemoteClose(resource: StreamResourceRecord, reason: "completed" | "remote-close"): void {
    if (resource.state === "closing" || resource.remoteClosePending) return;
    if (!resource.attachment) {
      void this.closeResource(resource, reason);
      return;
    }

    // The final output chunk can be queued before its scheduled pump runs.
    // Keep this exact attachment alive until its output reaches the renderer,
    // while bounding a peer that never returns the required output credit.
    resource.remoteClosePending = reason;
    resource.remoteCloseTimer = managedTimeout(() => {
      void this.closeResource(resource, reason);
    }, STREAM_CLOSING_GRACE_MILLISECONDS);
    this.schedulePump();
  }

  private sendOpened(resource: StreamResourceRecord, attachment: Attachment): void {
    this.sendFrame(resource, attachment, {
      v: STREAM_PROTOCOL_VERSION,
      type: "opened",
      streamId: attachment.streamId,
      resource: Object.freeze({
        resourceId: resource.resourceId,
        kind: "session-shell",
        pty: resource.pty,
      }),
      inputCreditBytes: attachment.inputCreditBytes,
    });
  }

  private handleDataFrame(
    resource: StreamResourceRecord,
    attachment: Attachment,
    sequence: number,
    buffer: ArrayBuffer,
  ): void {
    const byteLength = buffer.byteLength;
    const transferredBytes = new Uint8Array(buffer);
    if (resource.remoteClosePending) {
      transferredBytes.fill(0);
      return;
    }
    if (
      resource.state !== "attached" ||
      !resource.endpoint ||
      sequence !== attachment.expectedInputSequence ||
      byteLength > this.limits.maxFrameBytes ||
      byteLength > attachment.inputCreditBytes ||
      resource.inputQueuedBytes + resource.inFlightInputBytes + byteLength > this.limits.maxQueueBytes
    ) {
      transferredBytes.fill(0);
      void this.closeResource(resource, "protocol-error");
      return;
    }
    if (attachment.expectedInputSequence === Number.MAX_SAFE_INTEGER) {
      transferredBytes.fill(0);
      void this.closeResource(resource, "protocol-error");
      return;
    }

    const data = Uint8Array.from(transferredBytes);
    transferredBytes.fill(0);
    attachment.expectedInputSequence += 1;
    attachment.inputCreditBytes -= byteLength;
    resource.inputQueue.push({ data });
    resource.inputQueuedBytes += byteLength;
    resource.highWaterInputBytes = Math.max(
      resource.highWaterInputBytes,
      resource.inputQueuedBytes + resource.inFlightInputBytes,
    );
    resource.bytesFromRenderer += BigInt(byteLength);
    resource.framesFromRenderer += 1n;
    this.adjustQueued(resource, byteLength);
    this.touch(resource);
    this.updatePressure(resource);
    this.schedulePump();
  }

  private handleCreditFrame(resource: StreamResourceRecord, attachment: Attachment, bytes: number): void {
    if (
      (resource.state !== "attached" && resource.state !== "opening") ||
      !attachment.started ||
      attachment.outputCreditBytes + bytes > this.limits.maxCreditBytes
    ) {
      void this.closeResource(resource, "protocol-error");
      return;
    }
    attachment.outputCreditBytes += bytes;
    clearManagedTimer(resource.creditTimer);
    delete resource.creditTimer;
    this.schedulePump();
  }

  private handleResizeFrame(
    resource: StreamResourceRecord,
    attachment: Attachment,
    rows: number,
    columns: number,
  ): void {
    if (resource.remoteClosePending) return;
    if (
      resource.state !== "attached" ||
      !attachment.started ||
      !resource.canResize ||
      !resource.endpoint?.resize
    ) {
      void this.closeResource(resource, "protocol-error");
      return;
    }
    resource.pendingResize = { rows, columns };
    this.touch(resource);
    this.schedulePump();
  }

  private acceptEndpointOutput(resourceId: string, input: Uint8Array): boolean {
    const resource = this.resources.get(resourceId);
    if (!resource || resource.state === "closing" || resource.lifetime.signal.aborted || resource.remoteClosePending) {
      return false;
    }
    if (!(input instanceof Uint8Array)) {
      void this.closeResource(resource, "transport-error");
      return false;
    }
    if (input.byteLength === 0) return true;
    const maximumQueued = resource.state === "detached"
      ? this.limits.maxDetachedScrollbackBytes
      : this.limits.maxQueueBytes;
    if (input.byteLength > maximumQueued - resource.outputQueuedBytes) {
      void this.closeResource(
        resource,
        resource.state === "detached" ? "detached-buffer-exhausted" : "quota-exceeded",
      );
      return false;
    }

    let offset = 0;
    while (offset < input.byteLength) {
      const end = Math.min(input.byteLength, offset + this.limits.maxFrameBytes);
      const data = Uint8Array.from(input.subarray(offset, end));
      resource.outputQueue.push({ data });
      resource.outputQueuedBytes += data.byteLength;
      this.adjustQueued(resource, data.byteLength);
      offset = end;
    }
    resource.highWaterOutputBytes = Math.max(resource.highWaterOutputBytes, resource.outputQueuedBytes);
    this.touch(resource);
    this.updatePressure(resource);
    this.schedulePump();
    return true;
  }

  private detachResource(resource: StreamResourceRecord, reason: "operator-detach"): void {
    const attachment = resource.attachment;
    if (!attachment || resource.state === "closing") return;
    clearManagedTimer(resource.handshakeTimer);
    clearManagedTimer(resource.creditTimer);
    delete resource.handshakeTimer;
    delete resource.creditTimer;
    this.sendFrame(resource, attachment, {
      v: STREAM_PROTOCOL_VERSION,
      type: "closed",
      streamId: attachment.streamId,
      reason,
      disposition: "detached",
      metrics: this.publicMetrics(resource),
    }, false);
    this.disposeAttachment(resource, attachment);
    resource.state = "detached";
    this.touch(resource);
    this.resetDetachedTimer(resource);
    this.resetIdleTimer(resource);
  }

  private detachResourceForTransfer(resource: StreamResourceRecord): void {
    this.revokeResourceTicket(resource);
    if (resource.attachment) {
      this.detachResource(resource, "operator-detach");
      return;
    }
    if (resource.state === "detached" || resource.state === "closing") return;

    clearManagedTimer(resource.handshakeTimer);
    clearManagedTimer(resource.creditTimer);
    delete resource.handshakeTimer;
    delete resource.creditTimer;
    resource.state = "detached";
    this.touch(resource);
    this.resetDetachedTimer(resource);
    this.resetIdleTimer(resource);
  }

  private disposeAttachment(resource: StreamResourceRecord, attachment: Attachment): void {
    if (attachment.disposed) return;
    attachment.disposed = true;
    try {
      attachment.removeMessageListener();
    } catch {
      // A failed listener cleanup cannot retain authority in the manager.
    }
    try {
      attachment.removeCloseListener();
    } catch {
      // A failed listener cleanup cannot retain authority in the manager.
    }
    safeClosePort(attachment.port);
    if (resource.attachment === attachment) delete resource.attachment;
  }

  private schedulePump(): void {
    if (this.closed || this.pumpScheduled) return;
    this.pumpScheduled = true;
    this.schedule(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.closed) return;
    const resources = [...this.resources.values()].filter((resource) => resource.state !== "closing");
    if (resources.length === 0) return;
    let processedBytes = 0;
    let madeProgress = false;
    const startIndex = this.schedulerCursor % resources.length;

    for (let offset = 0; offset < resources.length; offset += 1) {
      const resource = resources[(startIndex + offset) % resources.length];
      if (!resource) continue;
      const result = this.pumpResource(resource, this.limits.maxBytesPerSchedulerTick - processedBytes);
      processedBytes += result.bytes;
      madeProgress ||= result.progress;
      this.schedulerCursor = (startIndex + offset + 1) % resources.length;
      if (processedBytes >= this.limits.maxBytesPerSchedulerTick) break;
    }

    if (madeProgress && this.hasRunnableWork()) this.schedulePump();
  }

  private pumpResource(resource: StreamResourceRecord, remainingTickBytes: number): { bytes: number; progress: boolean } {
    let processedBytes = 0;
    let frames = 0;
    let progress = false;
    const turnBudget = Math.min(
      this.limits.maxBytesPerStreamTurn,
      Math.max(this.limits.schedulerQuantumBytes, remainingTickBytes),
    );

    while (
      resource.state === "attached" &&
      resource.attachment &&
      frames < this.limits.maxFramesPerStreamTurn &&
      processedBytes < turnBudget
    ) {
      const chunk = resource.outputQueue[0];
      if (!chunk || chunk.data.byteLength > resource.attachment.outputCreditBytes) break;
      resource.outputQueue.shift();
      resource.outputQueuedBytes -= chunk.data.byteLength;
      this.adjustQueued(resource, -chunk.data.byteLength);
      resource.attachment.outputCreditBytes -= chunk.data.byteLength;
      const data = exactArrayBuffer(chunk.data);
      const sequence = resource.attachment.nextOutputSequence;
      if (sequence === Number.MAX_SAFE_INTEGER) {
        chunk.data.fill(0);
        void this.closeResource(resource, "protocol-error");
        return { bytes: processedBytes, progress: true };
      }
      resource.attachment.nextOutputSequence += 1;
      const sent = this.sendFrame(resource, resource.attachment, {
        v: STREAM_PROTOCOL_VERSION,
        type: "data",
        streamId: resource.attachment.streamId,
        sequence,
        data,
      });
      chunk.data.fill(0);
      if (!sent) return { bytes: processedBytes, progress: true };
      resource.bytesToRenderer += BigInt(data.byteLength);
      resource.framesToRenderer += 1n;
      processedBytes += data.byteLength;
      frames += 1;
      progress = true;
      this.updatePressure(resource);
    }

    if (resource.remoteClosePending && resource.state === "attached" && resource.outputQueue.length === 0) {
      void this.closeResource(resource, resource.remoteClosePending);
      return { bytes: processedBytes, progress: true };
    }

    if (!resource.remoteClosePending && !resource.commandInFlight && resource.endpoint && this.hasWriteSlot(resource)) {
      const chunk = resource.inputQueue.shift();
      if (chunk) {
        resource.inputQueuedBytes -= chunk.data.byteLength;
        resource.inFlightInputBytes += chunk.data.byteLength;
        this.adjustQueued(resource, -chunk.data.byteLength);
        this.adjustInFlight(resource, chunk.data.byteLength);
        this.startCommand(resource, "write", chunk.data);
        processedBytes += chunk.data.byteLength;
        progress = true;
      } else if (resource.pendingResize) {
        const resize = resource.pendingResize;
        delete resource.pendingResize;
        this.startCommand(resource, "resize", undefined, resize);
        progress = true;
      }
    }

    this.updateCreditTimer(resource);
    return { bytes: processedBytes, progress };
  }

  private startCommand(
    resource: StreamResourceRecord,
    kind: CommandKind,
    data?: Uint8Array,
    resize?: PendingResize,
  ): void {
    const endpoint = resource.endpoint;
    if (!endpoint) return;
    const id = resource.nextCommandId;
    resource.nextCommandId += 1;
    const controller = new AbortController();
    const onLifetimeAbort = (): void => controller.abort(resource.lifetime.signal.reason);
    if (resource.lifetime.signal.aborted) onLifetimeAbort();
    else resource.lifetime.signal.addEventListener("abort", onLifetimeAbort, { once: true });

    const timeout = managedTimeout(() => {
      controller.abort(new Error("Stream write timed out"));
      const current = this.resources.get(resource.resourceId);
      if (current?.commandInFlight?.id === id && !current.commandInFlight.settled) {
        void this.closeResource(current, "write-timeout");
      }
    }, this.limits.writeTimeoutMilliseconds);
    this.inFlightWrites += 1;
    const key = backendKey(resource.binding);
    this.inFlightWritesByBackend.set(key, (this.inFlightWritesByBackend.get(key) ?? 0) + 1);

    const commandPromise = (async () => {
      if (kind === "write") {
        if (!data) throw new Error("Missing bounded stream data");
        await endpoint.write(data, controller.signal);
      } else {
        if (!resize || !endpoint.resize) throw new Error("Missing bounded resize endpoint");
        await endpoint.resize(resize.rows, resize.columns, controller.signal);
      }
    })();
    const command: InFlightCommand = {
      id,
      kind,
      ...(data ? { data, byteCount: data.byteLength } : { byteCount: 0 }),
      settled: false,
      promise: commandPromise,
    };
    resource.commandInFlight = command;

    void commandPromise.then(
      () => this.finishCommand(resource.resourceId, id, true),
      () => this.finishCommand(resource.resourceId, id, false),
    ).finally(() => {
      clearManagedTimer(timeout);
      resource.lifetime.signal.removeEventListener("abort", onLifetimeAbort);
    });
  }

  private finishCommand(resourceId: string, commandId: number, succeeded: boolean): void {
    const resource = this.resources.get(resourceId);
    const command = resource?.commandInFlight;
    if (!resource || !command || command.id !== commandId || command.settled) return;
    command.settled = true;
    const key = backendKey(resource.binding);
    this.inFlightWrites = Math.max(0, this.inFlightWrites - 1);
    const backendWrites = Math.max(0, (this.inFlightWritesByBackend.get(key) ?? 1) - 1);
    if (backendWrites === 0) this.inFlightWritesByBackend.delete(key);
    else this.inFlightWritesByBackend.set(key, backendWrites);

    if (command.byteCount > 0) {
      resource.inFlightInputBytes = Math.max(0, resource.inFlightInputBytes - command.byteCount);
      this.adjustInFlight(resource, -command.byteCount);
      command.data?.fill(0);
      if (succeeded && resource.state !== "closing" && resource.attachment?.started) {
        const available = this.limits.maxCreditBytes - resource.attachment.inputCreditBytes;
        const granted = Math.min(command.byteCount, Math.max(0, available));
        if (granted > 0) {
          resource.attachment.inputCreditBytes += granted;
          this.sendFrame(resource, resource.attachment, {
            v: STREAM_PROTOCOL_VERSION,
            type: "credit",
            streamId: resource.attachment.streamId,
            bytes: granted,
          });
        }
      }
      command.byteCount = 0;
    }
    delete resource.commandInFlight;
    this.updatePressure(resource);
    if (!succeeded && resource.state !== "closing") {
      void this.closeResource(resource, "transport-error");
      return;
    }
    this.schedulePump();
  }

  private hasWriteSlot(resource: StreamResourceRecord): boolean {
    if (this.inFlightWrites >= this.limits.maxInFlightWritesPerProcess) return false;
    return (this.inFlightWritesByBackend.get(backendKey(resource.binding)) ?? 0) <
      this.limits.maxInFlightWritesPerBackend;
  }

  private hasRunnableWork(): boolean {
    for (const resource of this.resources.values()) {
      if (resource.state === "closing") continue;
      const attachment = resource.attachment;
      const output = resource.state === "attached" && attachment &&
        resource.outputQueue[0]?.data.byteLength !== undefined &&
        resource.outputQueue[0].data.byteLength <= attachment.outputCreditBytes;
      const command = !resource.commandInFlight && resource.endpoint && this.hasWriteSlot(resource) &&
        (resource.inputQueue.length > 0 || Boolean(resource.pendingResize));
      if (output || command) return true;
    }
    return false;
  }

  private updateCreditTimer(resource: StreamResourceRecord): void {
    const attachment = resource.attachment;
    const next = resource.outputQueue[0];
    const blocked = resource.state === "attached" && attachment?.started && next &&
      next.data.byteLength > attachment.outputCreditBytes;
    if (!blocked) {
      clearManagedTimer(resource.creditTimer);
      delete resource.creditTimer;
      return;
    }
    if (resource.creditTimer) return;
    const streamId = attachment.streamId;
    resource.creditTimer = managedTimeout(() => {
      if (resource.attachment?.streamId === streamId && resource.outputQueue.length > 0) {
        void this.closeResource(resource, "credit-timeout");
      }
    }, this.limits.creditTimeoutMilliseconds);
  }

  private updatePressure(resource: StreamResourceRecord): void {
    if (resource.state === "closing") return;
    const queued = resource.inputQueuedBytes + resource.outputQueuedBytes + resource.inFlightInputBytes;
    const capacity = this.limits.maxQueueBytes * 2;
    const nextPressure: StreamPressure = resource.pressure === "normal"
      ? (queued >= capacity * PRESSURE_HIGH_WATER_FRACTION ? "high" : "normal")
      : (queued <= capacity * PRESSURE_LOW_WATER_FRACTION ? "normal" : "high");
    if (nextPressure === resource.pressure) return;
    resource.pressure = nextPressure;
    const attachment = resource.attachment;
    if (attachment?.started) {
      this.sendFrame(resource, attachment, {
        v: STREAM_PROTOCOL_VERSION,
        type: "pressure",
        streamId: attachment.streamId,
        level: nextPressure,
        queuedBytes: queued,
      });
    }
  }

  private touch(resource: StreamResourceRecord): void {
    resource.lastActivityAtMilliseconds = this.currentTime();
    if (resource.endpoint) this.resetIdleTimer(resource);
  }

  private resetIdleTimer(resource: StreamResourceRecord): void {
    clearManagedTimer(resource.idleTimer);
    delete resource.idleTimer;
    if (resource.state === "closing" || !resource.endpoint) return;
    resource.idleTimer = managedTimeout(() => {
      if (resource.state !== "closing") void this.closeResource(resource, "idle-timeout");
    }, this.limits.idleTimeoutMilliseconds);
  }

  private resetDetachedTimer(resource: StreamResourceRecord): void {
    clearManagedTimer(resource.detachedTimer);
    const expiresAtMilliseconds = safeFutureTime(this.currentTime(), this.limits.detachedTtlMilliseconds);
    resource.detachedExpiresAtMilliseconds = expiresAtMilliseconds;
    resource.detachedTimer = managedTimeout(() => {
      if (resource.state === "detached") void this.closeResource(resource, "idle-timeout");
    }, this.limits.detachedTtlMilliseconds);
  }

  private consumeControlToken(attachment: Attachment): boolean {
    const now = this.currentTime();
    const elapsed = Math.max(0, now - attachment.controlRefillAtMilliseconds);
    if (elapsed > 0) {
      attachment.controlTokens = Math.min(
        this.limits.controlFrameBurst,
        attachment.controlTokens + (elapsed * this.limits.controlFramesPerSecond) / 1_000,
      );
      attachment.controlRefillAtMilliseconds = now;
    }
    if (attachment.controlTokens < 1) return false;
    attachment.controlTokens -= 1;
    return true;
  }

  private sendFrame(
    resource: StreamResourceRecord,
    attachment: Attachment,
    frame: StreamServerFrame,
    closeOnFailure = true,
  ): boolean {
    if (attachment.disposed) return false;
    try {
      attachment.port.postMessage(frame);
      return true;
    } catch {
      if (closeOnFailure) void this.closeResource(resource, "port-closed");
      return false;
    } finally {
      if (frame.type === "data") new Uint8Array(frame.data).fill(0);
    }
  }

  private async closeResource(resource: StreamResourceRecord, reason: StreamCloseReason): Promise<void> {
    if (resource.closePromise) return resource.closePromise;
    resource.state = "closing";
    resource.lifetime.abort(new Error("Bounded stream closed"));
    this.revokeResourceTicket(resource);
    this.clearResourceTimers(resource);
    const attachment = resource.attachment;

    this.clearQueuedData(resource);
    if (attachment) {
      this.sendFrame(resource, attachment, {
        v: STREAM_PROTOCOL_VERSION,
        type: "closed",
        streamId: attachment.streamId,
        reason,
        disposition: "closed",
        metrics: this.publicMetrics(resource),
      }, false);
      this.disposeAttachment(resource, attachment);
    }

    const cleanup = async (): Promise<void> => {
      const endpoint = resource.endpoint;
      const commandPromise = resource.commandInFlight?.promise;
      const work: Promise<unknown>[] = [];
      if (endpoint) work.push(safeCloseEndpoint(endpoint, this.limits.writeTimeoutMilliseconds));
      if (commandPromise) work.push(commandPromise.catch(() => undefined));
      if (work.length > 0) {
        await boundedWait(Promise.allSettled(work), this.limits.writeTimeoutMilliseconds);
      }
      this.finalizeResource(resource, reason);
    };
    resource.closePromise = cleanup();
    return resource.closePromise;
  }

  private finalizeResource(resource: StreamResourceRecord, reason: StreamCloseReason): void {
    if (this.resources.get(resource.resourceId) !== resource) return;
    const command = resource.commandInFlight;
    if (command && !command.settled) {
      const key = backendKey(resource.binding);
      this.inFlightWrites = Math.max(0, this.inFlightWrites - 1);
      const backendWrites = Math.max(0, (this.inFlightWritesByBackend.get(key) ?? 1) - 1);
      if (backendWrites === 0) this.inFlightWritesByBackend.delete(key);
      else this.inFlightWritesByBackend.set(key, backendWrites);
      if (command.byteCount > 0) {
        resource.inFlightInputBytes = Math.max(0, resource.inFlightInputBytes - command.byteCount);
        this.adjustInFlight(resource, -command.byteCount);
        command.data?.fill(0);
        command.byteCount = 0;
      }
      command.settled = true;
      delete resource.commandInFlight;
    }
    this.resources.delete(resource.resourceId);
    this.releaseAdmission(resource, reason, true);
  }

  private clearQueuedData(resource: StreamResourceRecord): void {
    const queuedBytes = resource.inputQueuedBytes + resource.outputQueuedBytes;
    for (const chunk of resource.inputQueue) chunk.data.fill(0);
    for (const chunk of resource.outputQueue) chunk.data.fill(0);
    resource.inputQueue = [];
    resource.outputQueue = [];
    resource.inputQueuedBytes = 0;
    resource.outputQueuedBytes = 0;
    resource.pressure = "normal";
    delete resource.pendingResize;
    if (queuedBytes > 0) this.adjustQueued(resource, -queuedBytes);
  }

  private clearResourceTimers(resource: StreamResourceRecord): void {
    clearManagedTimer(resource.handshakeTimer);
    clearManagedTimer(resource.creditTimer);
    clearManagedTimer(resource.idleTimer);
    clearManagedTimer(resource.detachedTimer);
    clearManagedTimer(resource.remoteCloseTimer);
    delete resource.handshakeTimer;
    delete resource.creditTimer;
    delete resource.idleTimer;
    delete resource.detachedTimer;
    delete resource.remoteCloseTimer;
  }

  private revokeResourceTicket(resource: StreamResourceRecord): void {
    const token = resource.pendingTicketToken;
    if (!token) return;
    const ticket = this.tickets.get(token);
    if (ticket) clearManagedTimer(ticket.timer);
    this.tickets.delete(token);
    delete resource.pendingTicketToken;
  }

  private async runEndpointAction(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    const timer = managedTimeout(() => controller.abort(new Error("Stream endpoint action timed out")),
      this.limits.writeTimeoutMilliseconds);
    try {
      await boundedWait(action(controller.signal), this.limits.writeTimeoutMilliseconds);
    } finally {
      clearManagedTimer(timer);
    }
  }

  private availableInitialInputCredit(resource: StreamResourceRecord): number {
    return Math.max(
      0,
      Math.min(
        this.limits.initialCreditBytes,
        this.limits.maxCreditBytes,
        this.limits.maxQueueBytes - resource.inputQueuedBytes - resource.inFlightInputBytes,
      ),
    );
  }

  private publicResource(resource: StreamResourceRecord): SessionShellResource {
    return Object.freeze({
      resourceId: resource.resourceId,
      kind: "session-shell",
      state: resource.state,
      pty: resource.pty,
      canResize: resource.canResize,
      canKill: Boolean(resource.endpoint?.kill),
      createdAt: isoDate(resource.createdAtMilliseconds),
      lastActivityAt: isoDate(resource.lastActivityAtMilliseconds),
      ...(resource.detachedExpiresAtMilliseconds !== undefined
        ? { detachedExpiresAt: isoDate(resource.detachedExpiresAtMilliseconds) }
        : {}),
      metrics: this.publicMetrics(resource),
    });
  }

  private publicMetrics(resource: StreamResourceRecord): StreamMetrics {
    return Object.freeze({
      bytesFromRenderer: resource.bytesFromRenderer.toString(10),
      bytesToRenderer: resource.bytesToRenderer.toString(10),
      framesFromRenderer: resource.framesFromRenderer.toString(10),
      framesToRenderer: resource.framesToRenderer.toString(10),
      queuedInputBytes: resource.inputQueuedBytes,
      queuedOutputBytes: resource.outputQueuedBytes,
      inFlightInputBytes: resource.inFlightInputBytes,
      inputCreditBytes: resource.attachment?.inputCreditBytes ?? 0,
      outputCreditBytes: resource.attachment?.outputCreditBytes ?? 0,
      highWaterInputBytes: resource.highWaterInputBytes,
      highWaterOutputBytes: resource.highWaterOutputBytes,
      pressure: resource.pressure,
      createdAt: isoDate(resource.createdAtMilliseconds),
      lastActivityAt: isoDate(resource.lastActivityAtMilliseconds),
    });
  }

  private reserveAdmission(binding: StreamOwnerBinding): void {
    const window = this.windowUsage.get(binding.ownerWindowId) ?? newScopeUsage();
    const backendIdentifier = backendKey(binding);
    const backend = this.backendUsage.get(backendIdentifier) ?? newScopeUsage();
    if (
      window.streamCount >= this.limits.maxStreamsPerWindow ||
      backend.streamCount >= this.limits.maxStreamsPerBackend ||
      this.processUsage.streamCount >= this.limits.maxStreamsPerProcess ||
      window.reservedBytes + this.limits.reservedBytesPerResource > this.limits.maxReservedBytesPerWindow ||
      backend.reservedBytes + this.limits.reservedBytesPerResource > this.limits.maxReservedBytesPerBackend ||
      this.processUsage.reservedBytes + this.limits.reservedBytesPerResource >
        this.limits.maxReservedBytesPerProcess
    ) {
      this.recordRejection(binding);
      throw new StreamCapacityError();
    }
    this.windowUsage.set(binding.ownerWindowId, window);
    this.backendUsage.set(backendIdentifier, backend);
    for (const usage of [window, backend, this.processUsage]) {
      usage.streamCount += 1;
      usage.reservedBytes += this.limits.reservedBytesPerResource;
      usage.highWaterReservedBytes = Math.max(usage.highWaterReservedBytes, usage.reservedBytes);
    }
  }

  private releaseAdmission(resource: StreamResourceRecord, reason: StreamCloseReason, recordClose: boolean): void {
    this.releaseAdmissionForBinding(resource.binding, reason, recordClose);
  }

  private releaseAdmissionForBinding(
    binding: StreamOwnerBinding,
    reason: StreamCloseReason,
    recordClose: boolean,
  ): void {
    const usages = this.usagesFor(binding);
    for (const usage of usages) {
      usage.streamCount = Math.max(0, usage.streamCount - 1);
      usage.reservedBytes = Math.max(0, usage.reservedBytes - this.limits.reservedBytesPerResource);
      if (recordClose) {
        usage.closedStreams += 1n;
        usage.closesByReason.set(reason, (usage.closesByReason.get(reason) ?? 0n) + 1n);
      }
    }
  }

  private recordRejection(binding: StreamOwnerBinding): void {
    const window = this.windowUsage.get(binding.ownerWindowId) ?? newScopeUsage();
    const key = backendKey(binding);
    const backend = this.backendUsage.get(key) ?? newScopeUsage();
    this.windowUsage.set(binding.ownerWindowId, window);
    this.backendUsage.set(key, backend);
    for (const usage of [window, backend, this.processUsage]) usage.rejectedStreams += 1n;
  }

  private adjustOpened(binding: StreamOwnerBinding, amount: bigint): void {
    for (const usage of this.usagesFor(binding)) usage.openedStreams += amount;
  }

  private adjustQueued(resource: StreamResourceRecord, amount: number): void {
    for (const usage of this.usagesFor(resource.binding)) {
      usage.queuedBytes = Math.max(0, usage.queuedBytes + amount);
      usage.highWaterQueuedBytes = Math.max(usage.highWaterQueuedBytes, usage.queuedBytes);
    }
  }

  private adjustInFlight(resource: StreamResourceRecord, amount: number): void {
    for (const usage of this.usagesFor(resource.binding)) {
      usage.inFlightBytes = Math.max(0, usage.inFlightBytes + amount);
      usage.highWaterInFlightBytes = Math.max(usage.highWaterInFlightBytes, usage.inFlightBytes);
    }
  }

  private usagesFor(binding: StreamOwnerBinding): ScopeUsage[] {
    const window = this.windowUsage.get(binding.ownerWindowId);
    const backend = this.backendUsage.get(backendKey(binding));
    return [window, backend, this.processUsage].filter((usage): usage is ScopeUsage => Boolean(usage));
  }

  private closeMatching(
    predicate: (resource: StreamResourceRecord) => boolean,
    reason: StreamCloseReason,
  ): Promise<void> {
    return Promise.allSettled(
      [...this.resources.values()].filter(predicate).map((resource) => this.closeResource(resource, reason)),
    ).then(() => undefined);
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SAFE_TIME_MILLISECONDS) {
      throw new TypeError("Stream clock returned an invalid time");
    }
    return value;
  }

  private newOpaqueId(): string {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = this.createOpaqueId();
      if (!isOpaqueStreamId(id)) throw new TypeError("Stream ID generator returned an invalid opaque ID");
      const activeCollision = this.resources.has(id) || this.tickets.has(id) ||
        [...this.resources.values()].some((resource) => resource.attachment?.streamId === id);
      if (!activeCollision) return id;
    }
    throw new Error("Unable to allocate a unique stream ID");
  }

  private assertOpen(): void {
    if (this.closed) throw new StreamStateError("The stream manager is closed");
  }
}

function newScopeUsage(): ScopeUsage {
  return {
    streamCount: 0,
    reservedBytes: 0,
    queuedBytes: 0,
    inFlightBytes: 0,
    highWaterReservedBytes: 0,
    highWaterQueuedBytes: 0,
    highWaterInFlightBytes: 0,
    openedStreams: 0n,
    rejectedStreams: 0n,
    closedStreams: 0n,
    closesByReason: new Map(),
  };
}

function publicAggregate(
  usage: ScopeUsage,
  resources: Iterable<StreamResourceRecord> = [],
  includes: (resource: StreamResourceRecord) => boolean = () => false,
): StreamAggregateMetrics {
  const closesByReason: Partial<Record<StreamCloseReason, string>> = {};
  for (const [reason, count] of usage.closesByReason) closesByReason[reason] = count.toString(10);
  let attachedStreams = 0;
  let detachedStreams = 0;
  for (const resource of resources) {
    if (!includes(resource)) continue;
    if (resource.state !== "closing" && resource.attachment && !resource.attachment.disposed) attachedStreams += 1;
    else if (resource.state === "detached") detachedStreams += 1;
  }
  return Object.freeze({
    activeStreams: usage.streamCount,
    attachedStreams,
    detachedStreams,
    reservedBytes: usage.reservedBytes,
    queuedBytes: usage.queuedBytes,
    inFlightBytes: usage.inFlightBytes,
    highWaterReservedBytes: usage.highWaterReservedBytes,
    highWaterQueuedBytes: usage.highWaterQueuedBytes,
    highWaterInFlightBytes: usage.highWaterInFlightBytes,
    openedStreams: usage.openedStreams.toString(10),
    rejectedStreams: usage.rejectedStreams.toString(10),
    closedStreams: usage.closedStreams.toString(10),
    closesByReason: Object.freeze(closesByReason),
  });
}

function normalizeLimits(overrides: Partial<StreamManagerLimits> | undefined): StreamManagerLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) requirePositiveInteger(value, name);
  if (limits.maxFrameBytes > STREAM_MAX_FRAME_BYTES) throw new TypeError("maxFrameBytes exceeds the protocol ceiling");
  if (limits.initialCreditBytes > limits.maxCreditBytes) {
    throw new TypeError("initialCreditBytes exceeds maxCreditBytes");
  }
  if (limits.maxFrameBytes > limits.maxQueueBytes || limits.maxQueueBytes > limits.reservedBytesPerResource) {
    throw new TypeError("Stream queue limits exceed their reservation");
  }
  if (limits.maxDetachedScrollbackBytes > limits.reservedBytesPerResource) {
    throw new TypeError("Detached scrollback exceeds the per-resource reservation");
  }
  if (
    limits.reservedBytesPerResource > limits.maxReservedBytesPerWindow ||
    limits.reservedBytesPerResource > limits.maxReservedBytesPerBackend ||
    limits.reservedBytesPerResource > limits.maxReservedBytesPerProcess
  ) {
    throw new TypeError("Per-resource reservation exceeds an aggregate quota");
  }
  return Object.freeze(limits);
}

function normalizeBinding(binding: StreamOwnerBinding): StreamOwnerBinding {
  requirePositiveInteger(binding.ownerWindowId, "ownerWindowId");
  requirePositiveInteger(binding.rendererProcessId, "rendererProcessId");
  requireBindingText(binding.rendererFrameToken, "rendererFrameToken");
  requireBindingText(binding.rendererDocumentId, "rendererDocumentId");
  requireBindingText(binding.backendId, "backendId");
  requirePositiveInteger(binding.backendEpoch, "backendEpoch");
  requireNonNegativeInteger(binding.connectionIncarnation, "connectionIncarnation");
  const target = normalizeTarget(binding.target);
  if (target.mode !== "session") throw new TypeError("Bounded session streams require a session target");
  if (target.backendEpoch !== binding.backendEpoch) throw new TypeError("Target and backend epochs do not match");
  return Object.freeze({
    ownerWindowId: binding.ownerWindowId,
    rendererProcessId: binding.rendererProcessId,
    rendererFrameToken: binding.rendererFrameToken,
    rendererDocumentId: binding.rendererDocumentId,
    backendId: binding.backendId,
    backendEpoch: binding.backendEpoch,
    connectionIncarnation: binding.connectionIncarnation,
    target,
  });
}

function normalizeBackendBinding(binding: StreamBackendBinding): StreamBackendBinding {
  requireBindingText(binding.backendId, "backendId");
  requirePositiveInteger(binding.backendEpoch, "backendEpoch");
  return Object.freeze({ backendId: binding.backendId, backendEpoch: binding.backendEpoch });
}

function normalizeTargetBinding(binding: StreamTargetBinding): StreamTargetBinding {
  const backend = normalizeBackendBinding(binding);
  const target = normalizeTarget(binding.target);
  if (target.mode !== "session" || target.backendEpoch !== backend.backendEpoch) {
    throw new TypeError("Stream target binding does not match the backend");
  }
  return Object.freeze({ ...backend, target });
}

function normalizeTarget(target: TargetRef): TargetRef {
  if (target.mode !== "session" && target.mode !== "beacon") throw new TypeError("Target mode is invalid");
  requireBindingText(target.id, "target.id");
  requirePositiveInteger(target.backendEpoch, "target.backendEpoch");
  requireNonNegativeInteger(target.domainRevision, "target.domainRevision");
  if (!TARGET_FINGERPRINT_PATTERN.test(target.fingerprint)) throw new TypeError("Target fingerprint is invalid");
  return Object.freeze({
    mode: target.mode,
    id: target.id,
    backendEpoch: target.backendEpoch,
    domainRevision: target.domainRevision,
    fingerprint: target.fingerprint,
  });
}

function sameBinding(left: StreamOwnerBinding, right: StreamOwnerBinding): boolean {
  return left.ownerWindowId === right.ownerWindowId &&
    left.rendererProcessId === right.rendererProcessId &&
    left.rendererFrameToken === right.rendererFrameToken &&
    left.rendererDocumentId === right.rendererDocumentId &&
    left.backendId === right.backendId &&
    left.backendEpoch === right.backendEpoch &&
    left.connectionIncarnation === right.connectionIncarnation &&
    sameTargetIdentity(left.target, right.target);
}

function sameBackend(left: StreamBackendBinding, right: StreamBackendBinding): boolean {
  return left.backendId === right.backendId && left.backendEpoch === right.backendEpoch;
}

function sameTargetIdentity(left: TargetRef, right: TargetRef): boolean {
  return left.mode === right.mode && left.id === right.id && left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}

function backendKey(binding: StreamBackendBinding): string {
  return `${binding.backendId.length}:${binding.backendId}:${binding.backendEpoch}`;
}

function requireEndpoint(endpoint: MainStreamEndpoint): MainStreamEndpoint {
  if (typeof endpoint !== "object" || endpoint === null) throw new TypeError("Stream endpoint must be an object");
  if (typeof endpoint.write !== "function" || typeof endpoint.close !== "function") {
    throw new TypeError("Stream endpoint is incomplete");
  }
  if (endpoint.resize !== undefined && typeof endpoint.resize !== "function") {
    throw new TypeError("Stream resize endpoint is invalid");
  }
  if (endpoint.kill !== undefined && typeof endpoint.kill !== "function") {
    throw new TypeError("Stream kill endpoint is invalid");
  }
  return endpoint;
}

function requirePort(port: StreamAttachmentPort): StreamAttachmentPort {
  if (typeof port !== "object" || port === null) throw new TypeError("Stream port must be an object");
  if (
    typeof port.postMessage !== "function" ||
    typeof port.close !== "function" ||
    typeof port.onMessage !== "function" ||
    typeof port.onClose !== "function" ||
    typeof port.start !== "function"
  ) {
    throw new TypeError("Stream port adapter is incomplete");
  }
  return port;
}

function safeClosePort(port: StreamAttachmentPort): void {
  try {
    port.close();
  } catch {
    // A rejected or terminal port has no remaining authority.
  }
}

async function safeCloseEndpoint(endpoint: MainStreamEndpoint, timeoutMilliseconds: number): Promise<void> {
  const controller = new AbortController();
  const timer = managedTimeout(() => controller.abort(new Error("Stream endpoint close timed out")), timeoutMilliseconds);
  try {
    await boundedWait(Promise.resolve(endpoint.close(controller.signal)).catch(() => undefined), timeoutMilliseconds);
  } finally {
    clearManagedTimer(timer);
  }
}

function exactArrayBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function scrubPotentialDataFrame(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  try {
    const data = Reflect.get(value, "data");
    if (data instanceof ArrayBuffer) new Uint8Array(data).fill(0);
    else if (ArrayBuffer.isView(data)) {
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength).fill(0);
    }
  } catch {
    // An adversarial object cannot retain authority or disrupt teardown.
  }
}

function managedTimeout(callback: () => void, milliseconds: number): Timer {
  const timer = setTimeout(callback, milliseconds);
  timer.unref?.();
  return timer;
}

function clearManagedTimer(timer: Timer | undefined): void {
  if (timer !== undefined) clearTimeout(timer);
}

async function boundedWait<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: Timer | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = managedTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    clearManagedTimer(timer);
  }
}

function safeFutureTime(now: number, duration: number): number {
  const future = now + duration;
  if (!Number.isSafeInteger(future) || future > MAX_SAFE_TIME_MILLISECONDS) {
    throw new TypeError("Stream expiration is outside the supported date range");
  }
  return future;
}

function isoDate(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function requireBindingText(value: string, label: string): void {
  if (typeof value !== "string" || !BINDING_TEXT_PATTERN.test(value)) throw new TypeError(`${label} is invalid`);
}

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
}

function requireNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`);
}
