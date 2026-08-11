import {
  STREAM_INITIAL_CREDIT_BYTES,
  STREAM_MAX_CREDIT_BYTES,
  STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
  STREAM_MAX_FRAME_BYTES,
  STREAM_MAX_QUEUE_BYTES,
  STREAM_MAX_TERMINAL_DIMENSION,
  STREAM_PROTOCOL_VERSION,
  parseStreamServerFrame,
  type StreamCloseDisposition,
  type StreamCloseReason,
  type StreamPressure,
  type StreamServerFrame,
} from "../../../shared/stream-contracts";
import type {
  GhosttyTerminalInputSource,
  GhosttyTerminalTransport,
  GhosttyTerminalTransportSubscription,
} from "./GhosttyTerminal";

const DEFAULT_ATTACH_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_OPEN_TIMEOUT_MILLISECONDS = 35_000;
const PRELOAD_ENVELOPE_SOURCE = "sliver-preload";
const PRELOAD_ENVELOPE_TYPE = "stream-port";

export type SessionShellTransportState =
  | "connecting"
  | "opening"
  | "attached"
  | "detached"
  | "closed"
  | "failed";

export interface SessionShellTransportSnapshot {
  readonly state: SessionShellTransportState;
  readonly pressure: StreamPressure;
  readonly queuedInputBytes: number;
  readonly queuedOutputBytes: number;
  readonly inputCreditBytes: number;
  readonly bytesFromRemote: string;
  readonly bytesToRemote: string;
  readonly closeReason?: StreamCloseReason | "route-changed" | "transport-error";
  readonly closeDisposition?: StreamCloseDisposition;
}

export interface OpenSessionShellTransportOptions {
  readonly attachmentToken: string;
  readonly expectedResourceId: string;
  readonly canResize: boolean;
  /** Re-checked before accepting the port and every frame. */
  readonly isCurrent: () => boolean;
  readonly attachTimeoutMilliseconds?: number;
  readonly targetWindow?: Window;
  readonly api?: Pick<Window["sliver"], "openStream">;
}

interface QueuedInput {
  readonly bytes: Uint8Array<ArrayBuffer>;
  offset: number;
}

interface PreloadStreamPortEnvelope {
  readonly source: typeof PRELOAD_ENVELOPE_SOURCE;
  readonly type: typeof PRELOAD_ENVELOPE_TYPE;
  readonly v: typeof STREAM_PROTOCOL_VERSION;
  readonly correlationId: string;
}

type SnapshotListener = (snapshot: SessionShellTransportSnapshot) => void;

/**
 * A one-resource MessagePort capability. It never exposes the port or stream
 * identifier to React, and it owns all output and queued input bytes outside
 * component state.
 */
export class SessionShellTransport implements GhosttyTerminalTransport {
  readonly #targetWindow: Window;
  readonly #api: Pick<Window["sliver"], "openStream">;
  readonly #expectedResourceId: string;
  readonly #canResize: boolean;
  readonly #isCurrent: () => boolean;
  readonly #correlationId: string;
  readonly #attachTimeoutMilliseconds: number;
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #earlyOutput: Uint8Array<ArrayBuffer>[] = [];
  readonly #inputQueue: QueuedInput[] = [];

  #state: SessionShellTransportState = "connecting";
  #pressure: StreamPressure = "normal";
  #closeReason: SessionShellTransportSnapshot["closeReason"];
  #closeDisposition: StreamCloseDisposition | undefined;
  #port: MessagePort | undefined;
  #streamId: string | undefined;
  #terminalSubscription: GhosttyTerminalTransportSubscription | undefined;
  #queuedInputBytes = 0;
  #queuedOutputBytes = 0;
  #inputCreditBytes = 0;
  #maxInputCreditBytes = STREAM_MAX_CREDIT_BYTES;
  #maxFrameBytes = STREAM_MAX_FRAME_BYTES;
  #receiveCreditBytes = STREAM_INITIAL_CREDIT_BYTES;
  #nextInputSequence = 0;
  #nextOutputSequence = 0;
  #bytesFromRemote = 0n;
  #bytesToRemote = 0n;
  #settled = false;
  #resolveOpen: ((transport: SessionShellTransport) => void) | undefined;
  #rejectOpen: ((error: Error) => void) | undefined;
  #attachTimer: ReturnType<typeof setTimeout> | undefined;
  #windowMessageListener: ((event: MessageEvent) => void) | undefined;
  #portMessageListener: ((event: MessageEvent) => void) | undefined;
  #portMessageErrorListener: (() => void) | undefined;

  private constructor(options: OpenSessionShellTransportOptions) {
    this.#targetWindow = options.targetWindow ?? window;
    this.#api = options.api ?? window.sliver;
    this.#expectedResourceId = options.expectedResourceId;
    this.#canResize = options.canResize;
    this.#isCurrent = options.isCurrent;
    this.#correlationId = crypto.randomUUID();
    this.#attachTimeoutMilliseconds = normalizeAttachTimeout(options.attachTimeoutMilliseconds);
  }

  static open(options: OpenSessionShellTransportOptions): Promise<SessionShellTransport> {
    const transport = new SessionShellTransport(options);
    return transport.#open(options.attachmentToken);
  }

  getSnapshot(): SessionShellTransportSnapshot {
    return Object.freeze({
      state: this.#state,
      pressure: this.#pressure,
      queuedInputBytes: this.#queuedInputBytes,
      queuedOutputBytes: this.#queuedOutputBytes,
      inputCreditBytes: this.#inputCreditBytes,
      bytesFromRemote: this.#bytesFromRemote.toString(),
      bytesToRemote: this.#bytesToRemote.toString(),
      ...(this.#closeReason ? { closeReason: this.#closeReason } : {}),
      ...(this.#closeDisposition ? { closeDisposition: this.#closeDisposition } : {}),
    });
  }

  subscribeState(listener: SnapshotListener): () => void {
    this.#snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#snapshotListeners.delete(listener);
  }

  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    if (this.#terminalSubscription) {
      throw new Error("A session shell transport supports one terminal subscriber");
    }
    this.#terminalSubscription = subscription;
    const pendingOutput = this.#earlyOutput.splice(0);
    for (const [index, bytes] of pendingOutput.entries()) {
      try {
        subscription.onOutput(bytes);
      } catch (error) {
        for (const remaining of pendingOutput.slice(index + 1)) remaining.fill(0);
        this.#fail(normalizeError(error), "transport-error");
        break;
      } finally {
        bytes.fill(0);
      }
    }
    this.#queuedOutputBytes = 0;
    this.#emitSnapshot();
    if (isTerminalState(this.#state)) safeTerminalClose(subscription, this.#closeReason);
    return () => {
      if (this.#terminalSubscription === subscription) this.#terminalSubscription = undefined;
    };
  }

  send(bytes: Uint8Array, _source: GhosttyTerminalInputSource): void {
    if (bytes.byteLength === 0 || isTerminalState(this.#state)) return;
    if (!this.#isCurrent()) {
      this.#fail(new Error("Session route changed"), "route-changed");
      return;
    }
    if (this.#queuedInputBytes + bytes.byteLength > STREAM_MAX_QUEUE_BYTES) {
      this.#fail(new Error("Session shell input queue exceeded its bounded capacity"), "transport-error");
      return;
    }
    const owned = copyBytes(bytes);
    this.#inputQueue.push({ bytes: owned, offset: 0 });
    this.#queuedInputBytes += owned.byteLength;
    this.#flushInput();
    this.#emitSnapshot();
  }

  resize(columns: number, rows: number): void {
    if (!this.#canResize || this.#state !== "attached" || !this.#streamId || !this.#port) return;
    if (!this.#isCurrent()) {
      this.#fail(new Error("Session route changed"), "route-changed");
      return;
    }
    if (!validDimension(columns) || !validDimension(rows)) return;
    try {
      this.#port.postMessage({
        v: STREAM_PROTOCOL_VERSION,
        type: "resize",
        streamId: this.#streamId,
        rows,
        columns,
      });
    } catch (error) {
      this.#fail(normalizeError(error), "transport-error");
    }
  }

  detach(): void {
    this.#dispose("detach", "operator-detach", "detached");
  }

  close(): void {
    this.#dispose("close", "operator-close", "closed");
  }

  #open(attachmentToken: string): Promise<SessionShellTransport> {
    return new Promise<SessionShellTransport>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
      if (!this.#isCurrent()) {
        this.#fail(new Error("Session route changed before stream attachment"), "route-changed");
        return;
      }

      this.#windowMessageListener = (event) => this.#acceptPreloadPort(event);
      this.#targetWindow.addEventListener("message", this.#windowMessageListener);
      this.#attachTimer = setTimeout(() => {
        this.#fail(new Error("Session shell stream attachment timed out"), "transport-error");
      }, this.#attachTimeoutMilliseconds);

      try {
        this.#api.openStream(attachmentToken, this.#correlationId);
      } catch (error) {
        this.#fail(normalizeError(error), "transport-error");
      }
    });
  }

  #acceptPreloadPort(event: MessageEvent): void {
    if (!messageClaimsCorrelation(event.data, this.#correlationId)) return;
    const port = event.ports[0];
    if (
      event.source !== this.#targetWindow ||
      !isExactPreloadEnvelope(event.data, this.#correlationId) ||
      event.ports.length !== 1 ||
      !port
    ) {
      for (const suppliedPort of event.ports) suppliedPort.close();
      this.#fail(new Error("Preload returned an invalid stream capability"), "transport-error");
      return;
    }
    if (!this.#isCurrent()) {
      port.close();
      this.#fail(new Error("Session route changed before stream attachment"), "route-changed");
      return;
    }

    this.#removeWindowListener();
    this.#port = port;
    this.#portMessageListener = (message) => this.#receiveFrame(message.data);
    this.#portMessageErrorListener = () => {
      this.#fail(new Error("Session shell stream sent an unreadable frame"), "transport-error");
    };
    try {
      port.addEventListener("message", this.#portMessageListener);
      port.addEventListener("messageerror", this.#portMessageErrorListener);
      port.start();
    } catch (error) {
      this.#fail(normalizeError(error), "transport-error");
    }
  }

  #receiveFrame(value: unknown): void {
    if (isTerminalState(this.#state)) {
      wipeUnknownFrameData(value);
      return;
    }
    if (!this.#isCurrent()) {
      wipeUnknownFrameData(value);
      this.#fail(new Error("Session route changed"), "route-changed");
      return;
    }

    let frame: StreamServerFrame;
    try {
      frame = parseStreamServerFrame(value);
    } catch (error) {
      wipeUnknownFrameData(value);
      this.#fail(normalizeError(error), "transport-error");
      return;
    }

    if (this.#streamId && frame.streamId !== this.#streamId) {
      wipeServerFrameData(frame);
      this.#fail(new Error("Session shell stream identity changed"), "transport-error");
      return;
    }

    switch (frame.type) {
      case "ready":
        this.#receiveReady(frame);
        break;
      case "opened":
        this.#receiveOpened(frame);
        break;
      case "data":
        this.#receiveOutput(frame);
        break;
      case "credit":
        this.#receiveCredit(frame.bytes);
        break;
      case "pressure":
        if (this.#state !== "attached") {
          this.#fail(new Error("Session shell pressure arrived out of order"), "transport-error");
          break;
        }
        this.#pressure = frame.level;
        this.#emitSnapshot();
        break;
      case "closed":
        this.#remoteClosed(frame.reason, frame.disposition);
        break;
    }
  }

  #receiveReady(frame: Extract<StreamServerFrame, { type: "ready" }>): void {
    if (this.#state !== "connecting" || this.#streamId) {
      this.#fail(new Error("Session shell sent ready out of order"), "transport-error");
      return;
    }
    this.#streamId = frame.streamId;
    this.#maxFrameBytes = Math.min(STREAM_MAX_FRAME_BYTES, frame.limits.maxFrameBytes);
    this.#maxInputCreditBytes = Math.min(STREAM_MAX_CREDIT_BYTES, frame.limits.maxCreditBytes);
    this.#receiveCreditBytes = Math.min(STREAM_INITIAL_CREDIT_BYTES, frame.limits.maxCreditBytes);
    this.#state = "opening";
    this.#emitSnapshot();
    try {
      this.#port?.postMessage({
        v: STREAM_PROTOCOL_VERSION,
        type: "start",
        streamId: frame.streamId,
        receiveCreditBytes: this.#receiveCreditBytes,
      });
    } catch (error) {
      this.#fail(normalizeError(error), "transport-error");
      return;
    }
    if (this.#attachTimer) clearTimeout(this.#attachTimer);
    this.#attachTimer = setTimeout(() => {
      this.#fail(new Error("Session shell did not finish opening in time"), "transport-error");
    }, DEFAULT_OPEN_TIMEOUT_MILLISECONDS);
  }

  #receiveOpened(frame: Extract<StreamServerFrame, { type: "opened" }>): void {
    if (this.#state !== "opening" || frame.resource.resourceId !== this.#expectedResourceId) {
      this.#fail(new Error("Session shell opened an unexpected resource"), "transport-error");
      return;
    }
    this.#inputCreditBytes = frame.inputCreditBytes;
    if (this.#inputCreditBytes > this.#maxInputCreditBytes) {
      this.#fail(new Error("Session shell granted excessive input credit"), "transport-error");
      return;
    }
    this.#state = "attached";
    this.#flushInput();
    this.#settleOpen();
    this.#emitSnapshot();
  }

  #receiveOutput(frame: Extract<StreamServerFrame, { type: "data" }>): void {
    const transferred = new Uint8Array(frame.data);
    if (this.#state !== "attached" || frame.sequence !== this.#nextOutputSequence) {
      transferred.fill(0);
      this.#fail(new Error("Session shell output sequence is invalid"), "transport-error");
      return;
    }
    if (frame.data.byteLength > this.#receiveCreditBytes) {
      transferred.fill(0);
      this.#fail(new Error("Session shell exceeded renderer output credit"), "transport-error");
      return;
    }
    this.#nextOutputSequence += 1;
    this.#receiveCreditBytes -= frame.data.byteLength;
    this.#bytesFromRemote += BigInt(frame.data.byteLength);
    const owned = copyBytes(transferred);
    transferred.fill(0);
    if (this.#terminalSubscription) {
      try {
        this.#terminalSubscription.onOutput(owned);
      } catch (error) {
        this.#fail(normalizeError(error), "transport-error");
        return;
      } finally {
        owned.fill(0);
      }
    } else {
      if (this.#queuedOutputBytes + owned.byteLength > STREAM_MAX_DETACHED_SCROLLBACK_BYTES) {
        owned.fill(0);
        this.#fail(new Error("Session shell early output exceeded its bounded capacity"), "transport-error");
        return;
      }
      this.#earlyOutput.push(owned);
      this.#queuedOutputBytes += owned.byteLength;
    }
    this.#receiveCreditBytes += frame.data.byteLength;
    try {
      this.#port?.postMessage({
        v: STREAM_PROTOCOL_VERSION,
        type: "credit",
        streamId: frame.streamId,
        bytes: frame.data.byteLength,
      });
    } catch (error) {
      this.#fail(normalizeError(error), "transport-error");
      return;
    }
    this.#emitSnapshot();
  }

  #receiveCredit(bytes: number): void {
    if (this.#state !== "attached" || this.#inputCreditBytes + bytes > this.#maxInputCreditBytes) {
      this.#fail(new Error("Session shell input credit is invalid"), "transport-error");
      return;
    }
    this.#inputCreditBytes += bytes;
    this.#flushInput();
    this.#emitSnapshot();
  }

  #flushInput(): void {
    if (this.#state !== "attached" || !this.#streamId || !this.#port) return;
    while (this.#inputQueue.length > 0 && this.#inputCreditBytes > 0) {
      const queued = this.#inputQueue[0];
      if (!queued) break;
      const remaining = queued.bytes.byteLength - queued.offset;
      const size = Math.min(remaining, this.#maxFrameBytes, this.#inputCreditBytes);
      if (size <= 0) break;
      const frameBytes = new Uint8Array(new ArrayBuffer(size));
      frameBytes.set(queued.bytes.subarray(queued.offset, queued.offset + size));
      try {
        this.#port.postMessage({
          v: STREAM_PROTOCOL_VERSION,
          type: "data",
          streamId: this.#streamId,
          sequence: this.#nextInputSequence,
          data: frameBytes.buffer,
        });
      } catch (error) {
        this.#fail(normalizeError(error), "transport-error");
        return;
      } finally {
        // Electron's renderer-to-main MessagePort boundary preserves this
        // nested frame via synchronous structured clone. Supplying the DOM
        // ArrayBuffer transfer list does not preserve the containing object
        // on the real cross-process port, so scrub our source immediately
        // after postMessage returns instead.
        frameBytes.fill(0);
      }
      queued.bytes.fill(0, queued.offset, queued.offset + size);
      queued.offset += size;
      this.#queuedInputBytes -= size;
      this.#inputCreditBytes -= size;
      this.#bytesToRemote += BigInt(size);
      this.#nextInputSequence += 1;
      if (queued.offset === queued.bytes.byteLength) {
        queued.bytes.fill(0);
        this.#inputQueue.shift();
      }
    }
  }

  #remoteClosed(reason: StreamCloseReason, disposition: StreamCloseDisposition): void {
    this.#closeReason = reason;
    this.#closeDisposition = disposition;
    this.#state = disposition === "detached" ? "detached" : "closed";
    this.#settleOpen(new Error(`Session shell closed before attachment (${reason})`));
    if (this.#terminalSubscription) safeTerminalClose(this.#terminalSubscription, reason);
    this.#teardownPort();
    this.#clearQueues();
    this.#emitSnapshot();
  }

  #dispose(
    disposition: "close" | "detach",
    reason: StreamCloseReason,
    state: "closed" | "detached",
  ): void {
    if (isTerminalState(this.#state)) return;
    if (this.#streamId && this.#port) {
      try {
        this.#port.postMessage({
          v: STREAM_PROTOCOL_VERSION,
          type: "close",
          streamId: this.#streamId,
          disposition,
        });
      } catch {
        // Teardown below still revokes the one-use capability.
      }
    }
    this.#closeReason = reason;
    this.#closeDisposition = state === "detached" ? "detached" : "closed";
    this.#state = state;
    this.#settleOpen(new Error(`Session shell ${state} before attachment completed`));
    if (this.#terminalSubscription) safeTerminalClose(this.#terminalSubscription, reason);
    this.#removeWindowListener();
    this.#teardownPort();
    this.#clearQueues();
    this.#emitSnapshot();
  }

  #fail(error: Error, reason: "route-changed" | "transport-error"): void {
    if (isTerminalState(this.#state)) return;
    this.#closeReason = reason;
    this.#closeDisposition = "outcome-unknown";
    this.#state = "failed";
    this.#settleOpen(error);
    if (this.#terminalSubscription) safeTerminalClose(this.#terminalSubscription, error.message);
    this.#removeWindowListener();
    this.#teardownPort();
    this.#clearQueues();
    this.#emitSnapshot();
  }

  #settleOpen(error?: Error): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#attachTimer) clearTimeout(this.#attachTimer);
    this.#attachTimer = undefined;
    if (error) this.#rejectOpen?.(error);
    else this.#resolveOpen?.(this);
    this.#resolveOpen = undefined;
    this.#rejectOpen = undefined;
  }

  #removeWindowListener(): void {
    if (this.#windowMessageListener) {
      this.#targetWindow.removeEventListener("message", this.#windowMessageListener);
      this.#windowMessageListener = undefined;
    }
  }

  #teardownPort(): void {
    if (this.#port && this.#portMessageListener) {
      this.#port.removeEventListener("message", this.#portMessageListener);
    }
    if (this.#port && this.#portMessageErrorListener) {
      this.#port.removeEventListener("messageerror", this.#portMessageErrorListener);
    }
    this.#port?.close();
    this.#port = undefined;
    this.#portMessageListener = undefined;
    this.#portMessageErrorListener = undefined;
  }

  #clearQueues(): void {
    for (const queued of this.#inputQueue) queued.bytes.fill(0);
    for (const output of this.#earlyOutput) output.fill(0);
    this.#inputQueue.length = 0;
    this.#earlyOutput.length = 0;
    this.#queuedInputBytes = 0;
    this.#queuedOutputBytes = 0;
    this.#inputCreditBytes = 0;
  }

  #emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.#snapshotListeners) {
      try {
        listener(snapshot);
      } catch {
        this.#snapshotListeners.delete(listener);
      }
    }
  }
}

function messageClaimsCorrelation(value: unknown, correlationId: string): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["correlationId"] === correlationId;
}

function isExactPreloadEnvelope(value: unknown, correlationId: string): value is PreloadStreamPortEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 4 &&
    keys[0] === "correlationId" &&
    keys[1] === "source" &&
    keys[2] === "type" &&
    keys[3] === "v" &&
    record["source"] === PRELOAD_ENVELOPE_SOURCE &&
    record["type"] === PRELOAD_ENVELOPE_TYPE &&
    record["v"] === STREAM_PROTOCOL_VERSION &&
    record["correlationId"] === correlationId;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function normalizeAttachTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_ATTACH_TIMEOUT_MILLISECONDS;
  if (!Number.isFinite(value)) return DEFAULT_ATTACH_TIMEOUT_MILLISECONDS;
  return Math.max(1, Math.min(DEFAULT_ATTACH_TIMEOUT_MILLISECONDS, Math.trunc(value)));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= STREAM_MAX_TERMINAL_DIMENSION;
}

function wipeServerFrameData(frame: StreamServerFrame): void {
  if (frame.type === "data") new Uint8Array(frame.data).fill(0);
}

function wipeUnknownFrameData(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const data = (value as Record<string, unknown>)["data"];
  if (
    data instanceof ArrayBuffer ||
    Object.prototype.toString.call(data) === "[object ArrayBuffer]"
  ) {
    try {
      new Uint8Array(data as ArrayBuffer).fill(0);
    } catch {
      // Best-effort wipe for a malformed or foreign-realm buffer.
    }
  }
}

function safeTerminalClose(
  subscription: GhosttyTerminalTransportSubscription,
  reason: string | undefined,
): void {
  try {
    subscription.onClose(reason);
  } catch {
    // Terminal callbacks cannot retain or revive a revoked stream capability.
  }
}

function isTerminalState(state: SessionShellTransportState): boolean {
  return state === "closed" || state === "detached" || state === "failed";
}
