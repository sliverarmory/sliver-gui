import { randomBytes } from "node:crypto";

import {
  CONSOLE_ATTACHMENT_TTL_MILLISECONDS,
  CONSOLE_HANDSHAKE_TIMEOUT_MILLISECONDS,
  CONSOLE_INITIAL_CREDIT_BYTES,
  CONSOLE_MAX_CREDIT_BYTES,
  CONSOLE_MAX_FRAME_BYTES,
  CONSOLE_MAX_QUEUE_BYTES,
  CONSOLE_MAX_SESSION_INPUT_BYTES,
  CONSOLE_PROTOCOL_VERSION,
  parseConsoleClientFrame,
  type ConsoleClientFrame,
  type ConsoleCloseReason,
  type ConsoleServerFrame,
} from "../shared/console-contracts.js";
import type { SliverConsoleRuntime } from "./console-runtime.js";

type Timer = ReturnType<typeof setTimeout>;

// Pause with one default runtime chunk of headroom. Resume below a lower
// watermark so renderer credit cannot make the PTY oscillate for every frame.
const CONSOLE_OUTPUT_PAUSE_BYTES = Math.floor(CONSOLE_MAX_QUEUE_BYTES / 2);
const CONSOLE_OUTPUT_RESUME_BYTES = Math.floor(CONSOLE_OUTPUT_PAUSE_BYTES / 2);

export interface ConsoleOwnerIdentity {
  readonly contentsId: number;
  readonly rendererProcessId: number;
  readonly rendererFrameToken: string;
}

export interface ConsoleAttachmentPort {
  postMessage(frame: ConsoleServerFrame): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: () => void): () => void;
  start(): void;
  close(): void;
}

export interface ConsolePortSessionOptions {
  readonly attachmentTtlMilliseconds?: number;
  readonly handshakeTimeoutMilliseconds?: number;
  readonly createOpaqueId?: () => string;
  /** Test seam; production always uses CONSOLE_MAX_SESSION_INPUT_BYTES. */
  readonly maxSessionInputBytes?: number;
}

/**
 * One-use, owner-bound MessagePort capability around a native console runtime.
 * It applies symmetric byte credit and bounded queues before any PTY bytes can
 * cross the renderer boundary.
 */
export class ConsolePortSession {
  readonly attachmentToken: string;

  private readonly streamId: string;
  private readonly outputQueue: Uint8Array[] = [];
  private outputQueueBytes = 0;
  private outputCreditBytes = 0;
  private inputCreditBytes = CONSOLE_INITIAL_CREDIT_BYTES;
  private expectedInputSequence = 0;
  private nextOutputSequence = 0;
  private totalInputBytes = 0;
  private runtimeOutputPaused = false;
  private state: "awaiting-attach" | "handshaking" | "open" | "closing" | "closed" = "awaiting-attach";
  private attachmentTimer: Timer | undefined;
  private handshakeTimer: Timer | undefined;
  private port: ConsoleAttachmentPort | undefined;
  private removePortMessage: (() => void) | undefined;
  private removePortClose: (() => void) | undefined;
  private unsubscribeRuntime: (() => void) | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly maxSessionInputBytes: number;

  constructor(
    private readonly runtime: SliverConsoleRuntime,
    private readonly owner: ConsoleOwnerIdentity,
    options: ConsolePortSessionOptions = {},
  ) {
    const createOpaqueId = options.createOpaqueId ?? defaultOpaqueId;
    this.attachmentToken = createOpaqueId();
    this.streamId = createOpaqueId();
    const attachmentTtl = normalizeTimeout(
      options.attachmentTtlMilliseconds,
      CONSOLE_ATTACHMENT_TTL_MILLISECONDS,
    );
    const handshakeTimeout = normalizeTimeout(
      options.handshakeTimeoutMilliseconds,
      CONSOLE_HANDSHAKE_TIMEOUT_MILLISECONDS,
    );
    this.handshakeTimeoutMilliseconds = handshakeTimeout;
    this.maxSessionInputBytes = normalizeSessionInputLimit(options.maxSessionInputBytes);
    this.attachmentTimer = setTimeout(() => {
      void this.close("handshake-timeout");
    }, attachmentTtl);
  }

  private readonly handshakeTimeoutMilliseconds: number;

  get isClosed(): boolean {
    return this.state === "closed";
  }

  attach(owner: ConsoleOwnerIdentity, attachmentToken: string, port: ConsoleAttachmentPort): void {
    if (
      this.state !== "awaiting-attach" ||
      attachmentToken !== this.attachmentToken ||
      !sameOwner(this.owner, owner)
    ) {
      safeClosePort(port);
      throw new Error("The console stream capability is unavailable for this renderer");
    }

    clearTimeout(this.attachmentTimer);
    this.attachmentTimer = undefined;
    this.state = "handshaking";
    this.port = port;
    this.removePortMessage = port.onMessage((message) => this.receiveFrame(message));
    this.removePortClose = port.onClose(() => {
      void this.close("renderer-gone");
    });
    try {
      port.start();
      this.post({
        v: CONSOLE_PROTOCOL_VERSION,
        type: "ready",
        streamId: this.streamId,
        limits: {
          maxFrameBytes: CONSOLE_MAX_FRAME_BYTES,
          maxCreditBytes: CONSOLE_MAX_CREDIT_BYTES,
          inputCreditBytes: this.inputCreditBytes,
        },
      });
      this.handshakeTimer = setTimeout(() => {
        void this.close("handshake-timeout");
      }, this.handshakeTimeoutMilliseconds);
    } catch (error) {
      void this.close("transport-error");
      throw error;
    }
  }

  close(reason: ConsoleCloseReason, exitCode?: number): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = "closing";
    clearTimeout(this.attachmentTimer);
    clearTimeout(this.handshakeTimer);
    this.attachmentTimer = undefined;
    this.handshakeTimer = undefined;
    this.unsubscribeRuntime?.();
    this.unsubscribeRuntime = undefined;
    this.removePortMessage?.();
    this.removePortMessage = undefined;
    this.removePortClose?.();
    this.removePortClose = undefined;

    const port = this.port;
    if (port) {
      try {
        this.post({
          v: CONSOLE_PROTOCOL_VERSION,
          type: "closed",
          streamId: this.streamId,
          reason,
          ...(exitCode === undefined ? {} : { exitCode }),
        });
      } catch {
        // The capability is already terminal; cleanup must continue.
      }
    }
    this.port = undefined;
    this.clearOutputQueue();
    this.closePromise = this.runtime.close()
      .catch(() => undefined)
      .then(() => {
        this.state = "closed";
        if (port) setTimeout(() => safeClosePort(port), 0);
      });
    return this.closePromise;
  }

  private receiveFrame(value: unknown): void {
    if (this.state !== "handshaking" && this.state !== "open") {
      wipeClientFrameData(value);
      return;
    }
    try {
      const frame = parseConsoleClientFrame(value);
      if (frame.streamId !== this.streamId) throw new Error("Console stream identity changed");
      if (this.state === "handshaking") {
        if (frame.type !== "start") throw new Error("Console stream did not start with a handshake");
        this.beginStreaming(frame);
        return;
      }
      this.applyOpenFrame(frame);
    } catch {
      wipeClientFrameData(value);
      void this.close("protocol-error");
    }
  }

  private beginStreaming(frame: Extract<ConsoleClientFrame, { type: "start" }>): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    this.outputCreditBytes = frame.receiveCreditBytes;
    this.state = "open";
    this.unsubscribeRuntime = this.runtime.subscribe(
      {
        onOutput: (data) => this.queueOutput(data),
        onExit: (exit) => void this.close("completed", exit.exitCode),
        onError: (notice) => {
          if (notice.code === "terminal-io-failed") void this.close("transport-error");
        },
      },
      // The runtime can retain more scrollback than this transport can queue.
      // Replaying only the newest queue-sized tail keeps attachment bounded;
      // live output resumes losslessly through native PTY backpressure.
      CONSOLE_MAX_QUEUE_BYTES,
    );
    this.flushOutput();
  }

  private applyOpenFrame(frame: ConsoleClientFrame): void {
    switch (frame.type) {
      case "start":
        throw new Error("Console stream was started twice");
      case "data": {
        if (frame.sequence !== this.expectedInputSequence || frame.data.byteLength > this.inputCreditBytes) {
          throw new Error("Console input exceeded its sequence or credit");
        }
        if (this.totalInputBytes + frame.data.byteLength > this.maxSessionInputBytes) {
          throw new Error("Console input exceeded its lifetime admission bound");
        }
        this.expectedInputSequence += 1;
        this.inputCreditBytes -= frame.data.byteLength;
        const source = new Uint8Array(frame.data);
        const owned = Uint8Array.from(source);
        const acceptedBytes = owned.byteLength;
        try {
          this.runtime.write(owned);
        } finally {
          source.fill(0);
        }
        this.totalInputBytes += acceptedBytes;
        this.inputCreditBytes += acceptedBytes;
        this.post({
          v: CONSOLE_PROTOCOL_VERSION,
          type: "credit",
          streamId: this.streamId,
          bytes: acceptedBytes,
        });
        return;
      }
      case "credit":
        if (this.outputCreditBytes + frame.bytes > CONSOLE_MAX_CREDIT_BYTES) {
          throw new Error("Console output credit exceeded its bound");
        }
        this.outputCreditBytes += frame.bytes;
        this.flushOutput();
        return;
      case "resize":
        this.runtime.resize(frame.columns, frame.rows);
        return;
      case "close":
        void this.close("operator-close");
        return;
    }
  }

  private queueOutput(data: Uint8Array): void {
    try {
      for (let offset = 0; offset < data.byteLength; offset += CONSOLE_MAX_FRAME_BYTES) {
        const chunk = Uint8Array.from(data.subarray(offset, offset + CONSOLE_MAX_FRAME_BYTES));
        if (this.outputQueueBytes + chunk.byteLength > CONSOLE_MAX_QUEUE_BYTES) {
          chunk.fill(0);
          throw new Error("Console output queue exceeded its bound");
        }
        this.outputQueue.push(chunk);
        this.outputQueueBytes += chunk.byteLength;
        this.flushOutput();
      }
    } catch {
      void this.close("transport-error");
    } finally {
      data.fill(0);
    }
  }

  private flushOutput(): void {
    if (this.state !== "open") return;
    while (this.outputQueue.length > 0 && this.outputCreditBytes > 0) {
      const queued = this.outputQueue[0]!;
      const count = Math.min(queued.byteLength, this.outputCreditBytes, CONSOLE_MAX_FRAME_BYTES);
      const sending = Uint8Array.from(queued.subarray(0, count));
      if (count === queued.byteLength) {
        this.outputQueue.shift();
        queued.fill(0);
      } else {
        const remaining = Uint8Array.from(queued.subarray(count));
        queued.fill(0);
        this.outputQueue[0] = remaining;
      }
      this.outputQueueBytes -= count;
      this.outputCreditBytes -= count;
      const data = sending.buffer;
      try {
        // MessagePortMain synchronously structured-clones ArrayBuffers; its
        // transfer list accepts only MessagePortMain instances.
        this.post({
          v: CONSOLE_PROTOCOL_VERSION,
          type: "data",
          streamId: this.streamId,
          sequence: this.nextOutputSequence++,
          data,
        });
      } finally {
        sending.fill(0);
      }
    }
    this.updateOutputBackpressure();
  }

  private updateOutputBackpressure(): void {
    if (this.state !== "open") return;
    if (!this.runtimeOutputPaused && this.outputQueueBytes >= CONSOLE_OUTPUT_PAUSE_BYTES) {
      this.runtimeOutputPaused = true;
      try {
        this.runtime.pauseOutput();
      } catch (error) {
        this.runtimeOutputPaused = false;
        throw error;
      }
      return;
    }
    if (this.runtimeOutputPaused && this.outputQueueBytes <= CONSOLE_OUTPUT_RESUME_BYTES) {
      // resumeOutput can synchronously drain the remainder of the native chunk;
      // clear our flag first so that nested output can pause again.
      this.runtimeOutputPaused = false;
      try {
        this.runtime.resumeOutput();
      } catch (error) {
        this.runtimeOutputPaused = true;
        throw error;
      }
    }
  }

  private post(frame: ConsoleServerFrame): void {
    const port = this.port;
    if (!port) throw new Error("Console port is unavailable");
    port.postMessage(frame);
  }

  private clearOutputQueue(): void {
    for (const chunk of this.outputQueue) chunk.fill(0);
    this.outputQueue.length = 0;
    this.outputQueueBytes = 0;
  }
}

function defaultOpaqueId(): string {
  return randomBytes(32).toString("base64url");
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new Error("Invalid console timeout");
  return value;
}

function normalizeSessionInputLimit(value: number | undefined): number {
  if (value === undefined) return CONSOLE_MAX_SESSION_INPUT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > CONSOLE_MAX_SESSION_INPUT_BYTES) {
    throw new Error("Invalid console session input limit");
  }
  return value;
}

function wipeClientFrameData(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const data = (value as Record<string, unknown>)["data"];
  if (!(data instanceof ArrayBuffer)) return;
  try {
    new Uint8Array(data).fill(0);
  } catch {
    // Best effort for a detached malformed frame.
  }
}

function sameOwner(left: ConsoleOwnerIdentity, right: ConsoleOwnerIdentity): boolean {
  return left.contentsId === right.contentsId &&
    left.rendererProcessId === right.rendererProcessId &&
    left.rendererFrameToken === right.rendererFrameToken;
}

function safeClosePort(port: ConsoleAttachmentPort): void {
  try {
    port.close();
  } catch {
    // Closing is best-effort for an already-detached native port.
  }
}
