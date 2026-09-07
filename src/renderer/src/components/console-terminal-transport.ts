import {
  CONSOLE_INITIAL_CREDIT_BYTES,
  CONSOLE_MAX_CREDIT_BYTES,
  CONSOLE_MAX_FRAME_BYTES,
  CONSOLE_MAX_QUEUE_BYTES,
  CONSOLE_MAX_TERMINAL_DIMENSION,
  CONSOLE_PROTOCOL_VERSION,
  parseConsoleServerFrame,
  type ConsoleCloseReason,
  type ConsoleServerFrame,
} from "../../../shared/console-contracts";
import type {
  GhosttyTerminalInputSource,
  GhosttyTerminalTransport,
  GhosttyTerminalTransportSubscription,
} from "./GhosttyTerminal";

const DEFAULT_ATTACH_TIMEOUT_MILLISECONDS = 5_000;
const PRELOAD_ENVELOPE_SOURCE = "sliver-preload";
const PRELOAD_ENVELOPE_TYPES = {
  console: "console-stream-port",
  ssh: "ssh-stream-port",
} as const;

export type TerminalStreamKind = keyof typeof PRELOAD_ENVELOPE_TYPES;

export type ConsoleTerminalTransportState = "connecting" | "attached" | "closed" | "failed";

export interface ConsoleTerminalTransportSnapshot {
  readonly state: ConsoleTerminalTransportState;
  readonly queuedInputBytes: number;
  readonly queuedOutputBytes: number;
  readonly inputCreditBytes: number;
  readonly bytesFromClient: string;
  readonly bytesToClient: string;
  readonly closeReason?: ConsoleCloseReason | "operator-close" | "transport-error";
  readonly exitCode?: number;
}

export interface OpenConsoleTerminalTransportOptions {
  readonly attachmentToken: string;
  readonly attachTimeoutMilliseconds?: number;
  readonly targetWindow?: Window;
  readonly api?: ConsoleStreamAPI | SshStreamAPI;
  readonly streamKind?: TerminalStreamKind;
}

export interface ConsoleStreamAPI {
  openConsoleStream(attachmentToken: string, correlationId: string): void;
}

export interface SshStreamAPI {
  openSshStream(attachmentToken: string, correlationId: string): void;
}

interface QueuedInput {
  readonly bytes: Uint8Array<ArrayBuffer>;
  offset: number;
}

interface PreloadConsolePortEnvelope {
  readonly source: typeof PRELOAD_ENVELOPE_SOURCE;
  readonly type: (typeof PRELOAD_ENVELOPE_TYPES)[TerminalStreamKind];
  readonly v: typeof CONSOLE_PROTOCOL_VERSION;
  readonly correlationId: string;
}

type SnapshotListener = (snapshot: ConsoleTerminalTransportSnapshot) => void;

/**
 * Owns the one-use native-client MessagePort capability. Console bytes never
 * enter React state and are scrubbed after their synchronous consumer returns.
 */
export class ConsoleTerminalTransport implements GhosttyTerminalTransport {
  readonly #targetWindow: Window;
  readonly #api: ConsoleStreamAPI | SshStreamAPI;
  readonly #streamKind: TerminalStreamKind;
  readonly #correlationId: string;
  readonly #attachTimeoutMilliseconds: number;
  readonly #snapshotListeners = new Set<SnapshotListener>();
  readonly #earlyOutput: Uint8Array<ArrayBuffer>[] = [];
  readonly #inputQueue: QueuedInput[] = [];

  #state: ConsoleTerminalTransportState = "connecting";
  #closeReason: ConsoleTerminalTransportSnapshot["closeReason"];
  #exitCode: number | undefined;
  #port: MessagePort | undefined;
  #streamId: string | undefined;
  #terminalSubscription: GhosttyTerminalTransportSubscription | undefined;
  #queuedInputBytes = 0;
  #queuedOutputBytes = 0;
  #inputCreditBytes = 0;
  #maxInputCreditBytes = CONSOLE_MAX_CREDIT_BYTES;
  #maxFrameBytes = CONSOLE_MAX_FRAME_BYTES;
  #receiveCreditBytes = CONSOLE_INITIAL_CREDIT_BYTES;
  #nextInputSequence = 0;
  #nextOutputSequence = 0;
  #bytesFromClient = 0n;
  #bytesToClient = 0n;
  #settled = false;
  #resolveOpen: ((transport: ConsoleTerminalTransport) => void) | undefined;
  #rejectOpen: ((error: Error) => void) | undefined;
  #attachTimer: ReturnType<typeof setTimeout> | undefined;
  #windowMessageListener: ((event: MessageEvent) => void) | undefined;
  #portMessageListener: ((event: MessageEvent) => void) | undefined;
  #portMessageErrorListener: (() => void) | undefined;

  private constructor(options: OpenConsoleTerminalTransportOptions) {
    this.#targetWindow = options.targetWindow ?? window;
    this.#streamKind = options.streamKind ?? "console";
    this.#api = options.api ?? (this.#streamKind === "console"
      ? window.sliver as unknown as ConsoleStreamAPI
      : (window as unknown as { ssh: SshStreamAPI }).ssh);
    this.#correlationId = crypto.randomUUID();
    this.#attachTimeoutMilliseconds = normalizeAttachTimeout(options.attachTimeoutMilliseconds);
  }

  static open(options: OpenConsoleTerminalTransportOptions): Promise<ConsoleTerminalTransport> {
    const transport = new ConsoleTerminalTransport(options);
    return transport.#open(options.attachmentToken);
  }

  getSnapshot(): ConsoleTerminalTransportSnapshot {
    return Object.freeze({
      state: this.#state,
      queuedInputBytes: this.#queuedInputBytes,
      queuedOutputBytes: this.#queuedOutputBytes,
      inputCreditBytes: this.#inputCreditBytes,
      bytesFromClient: this.#bytesFromClient.toString(),
      bytesToClient: this.#bytesToClient.toString(),
      ...(this.#closeReason ? { closeReason: this.#closeReason } : {}),
      ...(this.#exitCode === undefined ? {} : { exitCode: this.#exitCode }),
    });
  }

  subscribeState(listener: SnapshotListener): () => void {
    this.#snapshotListeners.add(listener);
    listener(this.getSnapshot());
    return () => this.#snapshotListeners.delete(listener);
  }

  subscribe(subscription: GhosttyTerminalTransportSubscription): () => void {
    if (this.#terminalSubscription) {
      throw new Error(`A ${this.#streamLabel()} transport supports one terminal subscriber`);
    }
    this.#terminalSubscription = subscription;
    const pending = this.#earlyOutput.splice(0);
    for (const [index, bytes] of pending.entries()) {
      try {
        subscription.onOutput(bytes);
      } catch (error) {
        for (const remaining of pending.slice(index + 1)) remaining.fill(0);
        this.#fail(normalizeError(error));
        break;
      } finally {
        bytes.fill(0);
      }
    }
    this.#queuedOutputBytes = 0;
    this.#emitSnapshot();
    if (isTerminalState(this.#state)) {
      safeTerminalClose(subscription, closeDescription(this.#streamKind, this.#closeReason, this.#exitCode));
    }
    return () => {
      if (this.#terminalSubscription === subscription) this.#terminalSubscription = undefined;
    };
  }

  send(bytes: Uint8Array, _source: GhosttyTerminalInputSource): void {
    if (bytes.byteLength === 0 || isTerminalState(this.#state)) return;
    if (this.#queuedInputBytes + bytes.byteLength > CONSOLE_MAX_QUEUE_BYTES) {
      this.#fail(new Error(`${this.#streamLabel()} input exceeded its bounded capacity`));
      return;
    }
    const owned = copyBytes(bytes);
    this.#inputQueue.push({ bytes: owned, offset: 0 });
    this.#queuedInputBytes += owned.byteLength;
    this.#flushInput();
    this.#emitSnapshot();
  }

  resize(columns: number, rows: number): void {
    if (this.#state !== "attached" || !this.#streamId || !this.#port) return;
    if (!validDimension(columns) || !validDimension(rows)) return;
    try {
      this.#port.postMessage({
        v: CONSOLE_PROTOCOL_VERSION,
        type: "resize",
        streamId: this.#streamId,
        rows,
        columns,
      });
    } catch (error) {
      this.#fail(normalizeError(error));
    }
  }

  close(): void {
    if (isTerminalState(this.#state)) return;
    if (this.#streamId && this.#port) {
      try {
        this.#port.postMessage({
          v: CONSOLE_PROTOCOL_VERSION,
          type: "close",
          streamId: this.#streamId,
        });
      } catch {
        // Teardown still revokes the capability and closes the native PTY.
      }
    }
    this.#closeReason = "operator-close";
    this.#state = "closed";
    this.#settleOpen(new Error(`${this.#streamLabel()} closed before attachment completed`));
    if (this.#terminalSubscription) {
      safeTerminalClose(this.#terminalSubscription, closeDescription(this.#streamKind, this.#closeReason));
    }
    this.#removeWindowListener();
    this.#teardownPort();
    this.#clearQueues();
    this.#emitSnapshot();
  }

  #open(attachmentToken: string): Promise<ConsoleTerminalTransport> {
    return new Promise<ConsoleTerminalTransport>((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
      this.#windowMessageListener = (event) => this.#acceptPreloadPort(event);
      this.#targetWindow.addEventListener("message", this.#windowMessageListener);
      this.#attachTimer = setTimeout(() => {
        this.#fail(new Error(`${this.#streamLabel()} stream attachment timed out`));
      }, this.#attachTimeoutMilliseconds);
      try {
        if (this.#streamKind === "console" && "openConsoleStream" in this.#api) {
          this.#api.openConsoleStream(attachmentToken, this.#correlationId);
        } else if (this.#streamKind === "ssh" && "openSshStream" in this.#api) {
          this.#api.openSshStream(attachmentToken, this.#correlationId);
        } else {
          throw new Error(`${this.#streamLabel()} stream bridge is unavailable`);
        }
      } catch (error) {
        this.#fail(normalizeError(error));
      }
    });
  }

  #acceptPreloadPort(event: MessageEvent): void {
    if (!messageClaimsCorrelation(event.data, this.#correlationId)) return;
    const port = event.ports[0];
    if (
      event.source !== this.#targetWindow ||
      !isExactPreloadEnvelope(event.data, this.#correlationId, this.#streamKind) ||
      event.ports.length !== 1 ||
      !port
    ) {
      for (const suppliedPort of event.ports) suppliedPort.close();
      this.#fail(new Error(`Preload returned an invalid ${this.#streamLabel()} capability`));
      return;
    }

    this.#removeWindowListener();
    this.#port = port;
    this.#portMessageListener = (message) => this.#receiveFrame(message.data);
    this.#portMessageErrorListener = () => {
      this.#fail(new Error(`${this.#streamLabel()} stream sent an unreadable frame`));
    };
    try {
      port.addEventListener("message", this.#portMessageListener);
      port.addEventListener("messageerror", this.#portMessageErrorListener);
      port.start();
    } catch (error) {
      this.#fail(normalizeError(error));
    }
  }

  #receiveFrame(value: unknown): void {
    if (isTerminalState(this.#state)) {
      wipeUnknownFrameData(value);
      return;
    }
    let frame: ConsoleServerFrame;
    try {
      frame = parseConsoleServerFrame(value);
    } catch (error) {
      wipeUnknownFrameData(value);
      this.#fail(normalizeError(error));
      return;
    }
    if (this.#streamId && frame.streamId !== this.#streamId) {
      wipeServerFrameData(frame);
      this.#fail(new Error(`${this.#streamLabel()} stream identity changed`));
      return;
    }

    switch (frame.type) {
      case "ready":
        this.#receiveReady(frame);
        break;
      case "data":
        this.#receiveOutput(frame);
        break;
      case "credit":
        this.#receiveCredit(frame.bytes);
        break;
      case "closed":
        this.#remoteClosed(frame.reason, frame.exitCode);
        break;
    }
  }

  #receiveReady(frame: Extract<ConsoleServerFrame, { type: "ready" }>): void {
    if (this.#state !== "connecting" || this.#streamId) {
      this.#fail(new Error(`${this.#streamLabel()} sent ready out of order`));
      return;
    }
    this.#streamId = frame.streamId;
    this.#maxFrameBytes = Math.min(CONSOLE_MAX_FRAME_BYTES, frame.limits.maxFrameBytes);
    this.#maxInputCreditBytes = Math.min(CONSOLE_MAX_CREDIT_BYTES, frame.limits.maxCreditBytes);
    this.#receiveCreditBytes = Math.min(CONSOLE_INITIAL_CREDIT_BYTES, frame.limits.maxCreditBytes);
    this.#inputCreditBytes = frame.limits.inputCreditBytes;
    if (this.#inputCreditBytes > this.#maxInputCreditBytes) {
      this.#fail(new Error(`${this.#streamLabel()} granted excessive input credit`));
      return;
    }
    try {
      this.#port?.postMessage({
        v: CONSOLE_PROTOCOL_VERSION,
        type: "start",
        streamId: frame.streamId,
        receiveCreditBytes: this.#receiveCreditBytes,
      });
    } catch (error) {
      this.#fail(normalizeError(error));
      return;
    }
    this.#state = "attached";
    this.#flushInput();
    this.#settleOpen();
    this.#emitSnapshot();
  }

  #receiveOutput(frame: Extract<ConsoleServerFrame, { type: "data" }>): void {
    const transferred = new Uint8Array(frame.data);
    if (this.#state !== "attached" || frame.sequence !== this.#nextOutputSequence) {
      transferred.fill(0);
      this.#fail(new Error(`${this.#streamLabel()} output sequence is invalid`));
      return;
    }
    if (frame.data.byteLength > this.#receiveCreditBytes) {
      transferred.fill(0);
      this.#fail(new Error(`${this.#streamLabel()} exceeded renderer output credit`));
      return;
    }
    this.#nextOutputSequence += 1;
    this.#receiveCreditBytes -= frame.data.byteLength;
    this.#bytesFromClient += BigInt(frame.data.byteLength);
    const owned = copyBytes(transferred);
    transferred.fill(0);
    if (this.#terminalSubscription) {
      try {
        this.#terminalSubscription.onOutput(owned);
      } catch (error) {
        this.#fail(normalizeError(error));
        return;
      } finally {
        owned.fill(0);
      }
    } else {
      if (this.#queuedOutputBytes + owned.byteLength > CONSOLE_MAX_QUEUE_BYTES) {
        owned.fill(0);
        this.#fail(new Error(`${this.#streamLabel()} early output exceeded its bounded capacity`));
        return;
      }
      this.#earlyOutput.push(owned);
      this.#queuedOutputBytes += owned.byteLength;
    }
    this.#receiveCreditBytes += frame.data.byteLength;
    try {
      this.#port?.postMessage({
        v: CONSOLE_PROTOCOL_VERSION,
        type: "credit",
        streamId: frame.streamId,
        bytes: frame.data.byteLength,
      });
    } catch (error) {
      this.#fail(normalizeError(error));
      return;
    }
    this.#emitSnapshot();
  }

  #receiveCredit(bytes: number): void {
    if (this.#state !== "attached" || this.#inputCreditBytes + bytes > this.#maxInputCreditBytes) {
      this.#fail(new Error(`${this.#streamLabel()} input credit is invalid`));
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
          v: CONSOLE_PROTOCOL_VERSION,
          type: "data",
          streamId: this.#streamId,
          sequence: this.#nextInputSequence,
          data: frameBytes.buffer,
        });
      } catch (error) {
        this.#fail(normalizeError(error));
        return;
      } finally {
        // Electron synchronously clones the nested ArrayBuffer at this boundary.
        frameBytes.fill(0);
      }
      queued.bytes.fill(0, queued.offset, queued.offset + size);
      queued.offset += size;
      this.#queuedInputBytes -= size;
      this.#inputCreditBytes -= size;
      this.#bytesToClient += BigInt(size);
      this.#nextInputSequence += 1;
      if (queued.offset === queued.bytes.byteLength) {
        queued.bytes.fill(0);
        this.#inputQueue.shift();
      }
    }
  }

  #remoteClosed(reason: ConsoleCloseReason, exitCode?: number): void {
    this.#closeReason = reason;
    this.#exitCode = exitCode;
    this.#state = "closed";
    this.#settleOpen(new Error(closeDescription(this.#streamKind, reason, exitCode)));
    if (this.#terminalSubscription) {
      safeTerminalClose(this.#terminalSubscription, closeDescription(this.#streamKind, reason, exitCode));
    }
    this.#teardownPort();
    this.#clearQueues();
    this.#emitSnapshot();
  }

  #fail(error: Error): void {
    if (isTerminalState(this.#state)) return;
    this.#closeReason = "transport-error";
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
    if (!this.#windowMessageListener) return;
    this.#targetWindow.removeEventListener("message", this.#windowMessageListener);
    this.#windowMessageListener = undefined;
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

  #streamLabel(): string {
    return this.#streamKind === "console" ? "Sliver console" : "SSH terminal";
  }
}

function messageClaimsCorrelation(value: unknown, correlationId: string): boolean {
  return typeof value === "object" && value !== null &&
    (value as Record<string, unknown>)["correlationId"] === correlationId;
}

function isExactPreloadEnvelope(
  value: unknown,
  correlationId: string,
  streamKind: TerminalStreamKind,
): value is PreloadConsolePortEnvelope {
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
    record["type"] === PRELOAD_ENVELOPE_TYPES[streamKind] &&
    record["v"] === CONSOLE_PROTOCOL_VERSION &&
    record["correlationId"] === correlationId;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function normalizeAttachTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_ATTACH_TIMEOUT_MILLISECONDS;
  return Math.max(1, Math.min(DEFAULT_ATTACH_TIMEOUT_MILLISECONDS, Math.trunc(value)));
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function validDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= CONSOLE_MAX_TERMINAL_DIMENSION;
}

function wipeServerFrameData(frame: ConsoleServerFrame): void {
  if (frame.type === "data") new Uint8Array(frame.data).fill(0);
}

function wipeUnknownFrameData(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const data = (value as Record<string, unknown>)["data"];
  if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === "[object ArrayBuffer]") {
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
    // Terminal callbacks cannot retain or revive a revoked capability.
  }
}

function closeDescription(
  streamKind: TerminalStreamKind,
  reason: ConsoleTerminalTransportSnapshot["closeReason"],
  exitCode?: number,
): string {
  if (streamKind === "ssh") {
    if (exitCode !== undefined) return `SSH session exited with code ${exitCode}`;
    if (reason === "completed") return "SSH session exited";
    if (reason === "operator-close") return "SSH terminal detached";
    if (reason === "window-closed") return "SSH window closed";
    if (reason === "application-shutdown") return "Application shutdown closed the SSH session";
    if (reason === "renderer-gone") return "SSH renderer disconnected";
    if (reason === "protocol-error") return "SSH terminal protocol error";
    if (reason === "transport-error") return "SSH terminal transport error";
    return "SSH terminal closed";
  }
  if (exitCode !== undefined) return `Sliver client exited with code ${exitCode}`;
  if (reason === "completed") return "Sliver client exited";
  if (reason === "operator-close") return "Sliver console closed";
  if (reason === "window-closed") return "Sliver console window closed";
  if (reason === "application-shutdown") return "Application shutdown closed the Sliver console";
  if (reason === "renderer-gone") return "Sliver console renderer disconnected";
  if (reason === "protocol-error") return "Sliver console protocol error";
  if (reason === "transport-error") return "Sliver console transport error";
  return "Sliver console closed";
}

function isTerminalState(state: ConsoleTerminalTransportState): boolean {
  return state === "closed" || state === "failed";
}
