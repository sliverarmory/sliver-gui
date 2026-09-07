import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

const HOST_KEY_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.@-]{0,63}$/u;
const MAX_PRIVATE_KEY_BYTES = 1024 * 1024;
const MAX_PASSPHRASE_BYTES = 4 * 1024;
const TERMINAL_TYPE = "xterm-256color";
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 36;
const KEEPALIVE_INTERVAL_MILLISECONDS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;

const SAFE_START_ERROR_MESSAGES = {
  "connection-failed": "The SSH server could not be reached or authenticated.",
  "host-key-approval-required": "The SSH server host key must be approved before connecting.",
  "host-key-mismatch": "The SSH server host key did not match the trusted fingerprint.",
  "invalid-input": "The SSH terminal request is invalid.",
  "shell-failed": "The SSH terminal shell could not be started.",
} as const;

const SAFE_RUNTIME_ERROR_MESSAGES = {
  "terminal-io-failed": "The SSH terminal stopped after a secure transport error.",
} as const;

export const DEFAULT_SSH_TERMINAL_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxPendingInputBytes: 256 * 1024,
  maxOutputChunkBytes: 64 * 1024,
  maxPendingOutputBytes: 256 * 1024,
  maxScrollbackBytes: 256 * 1024,
  maxSubscribers: 8,
  connectTimeoutMilliseconds: 30_000,
  shellTimeoutMilliseconds: 15_000,
  closeTimeoutMilliseconds: 2_000,
});

export interface SshTerminalTarget {
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly privateKey: Buffer | string;
  readonly passphrase?: Buffer | string;
  /** OpenSSH SHA-256 host-key fingerprint, for example `SHA256:...`. */
  readonly hostKeySha256?: string;
}

export interface SshTerminalRuntimeLimits {
  readonly maxInputBytes: number;
  readonly maxPendingInputBytes: number;
  readonly maxOutputChunkBytes: number;
  readonly maxPendingOutputBytes: number;
  readonly maxScrollbackBytes: number;
  readonly maxSubscribers: number;
  readonly connectTimeoutMilliseconds: number;
  readonly shellTimeoutMilliseconds: number;
  readonly closeTimeoutMilliseconds: number;
}

export interface StartSshTerminalRuntimeOptions {
  readonly ssh: SshTerminalTarget;
  readonly createSshClient?: () => Client;
  readonly columns?: number;
  readonly rows?: number;
  readonly limits?: Partial<SshTerminalRuntimeLimits>;
}

export interface SshTerminalExit {
  readonly exitCode: number;
}

export type SshTerminalStartErrorCode =
  | "connection-failed"
  | "host-key-approval-required"
  | "host-key-mismatch"
  | "invalid-input"
  | "shell-failed";

export type SshTerminalRuntimeErrorCode = "terminal-io-failed";

export interface SshTerminalRuntimeNotice {
  readonly code: SshTerminalRuntimeErrorCode;
  readonly message: string;
}

export interface SshTerminalSubscriber {
  onOutput(data: Uint8Array): void;
  onExit(exit: SshTerminalExit): void;
  onError?(notice: SshTerminalRuntimeNotice): void;
}

export class SshTerminalStartError extends Error {
  readonly code: SshTerminalStartErrorCode;
  readonly hostKeySha256?: string;

  constructor(code: SshTerminalStartErrorCode, hostKeySha256?: string) {
    super(SAFE_START_ERROR_MESSAGES[code]);
    this.name = "SshTerminalStartError";
    this.code = code;
    if (hostKeySha256 !== undefined) this.hostKeySha256 = hostKeySha256;
  }
}

export class SshTerminalRuntimeError extends Error {
  constructor(readonly code: SshTerminalRuntimeErrorCode | "closed" | "invalid-input") {
    super(
      code === "closed"
        ? "The SSH terminal is closed."
        : code === "invalid-input"
          ? "The SSH terminal input is invalid."
          : SAFE_RUNTIME_ERROR_MESSAGES[code],
    );
    this.name = "SshTerminalRuntimeError";
  }
}

interface NormalizedSshTerminalTarget {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly privateKey: Buffer | string;
  readonly passphrase?: Buffer | string;
  readonly hostKeySha256?: string;
}

interface PendingOutput {
  readonly data: Buffer;
  offset: number;
}

/**
 * Owns one in-process ssh2 connection and interactive PTY shell. Renderer code
 * must only reach this object through the separately authenticated, bounded
 * console MessagePort transport. Closing a renderer attachment does not imply
 * closing this runtime; the main-process session owner controls that policy.
 */
export class SshTerminalRuntime {
  readonly hostKeySha256: string;

  private readonly subscribers = new Set<SshTerminalSubscriber>();
  private readonly scrollback: Buffer[] = [];
  private readonly pendingOutput: PendingOutput[] = [];
  private readonly pendingInput = new Set<Buffer>();
  private readonly closedPromise: Promise<void>;
  private readonly transportClosedPromise: Promise<void>;
  private resolveClosed: () => void = () => undefined;
  private resolveTransportClosed: () => void = () => undefined;
  private state: "running" | "closing" | "closed" = "running";
  private cleanupPromise: Promise<void> | undefined;
  private scrollbackBytes = 0;
  private pendingInputBytes = 0;
  private pendingOutputBytes = 0;
  private outputPaused = false;
  private drainingOutput = false;
  private transportClosed = false;
  private terminalExit: SshTerminalExit | undefined;
  private lastNotice: SshTerminalRuntimeNotice | undefined;

  private readonly onChannelData = (data: Buffer | string): void => this.receiveOutput(data);
  private readonly onChannelError = (): void => this.receiveTransportError();
  private readonly onChannelExit = (code: number | null): void => this.receiveExit(code);
  private readonly onChannelClose = (): void => this.receiveChannelClose();
  private readonly onClientError = (): void => this.receiveTransportError();
  private readonly onClientClose = (): void => this.receiveClientClose();

  private constructor(
    private readonly client: Client,
    private readonly channel: ClientChannel,
    hostKeySha256: string,
    private readonly limits: SshTerminalRuntimeLimits,
  ) {
    this.hostKeySha256 = hostKeySha256;
    this.closedPromise = new Promise((resolveClosed) => {
      this.resolveClosed = resolveClosed;
    });
    this.transportClosedPromise = new Promise((resolveTransportClosed) => {
      this.resolveTransportClosed = resolveTransportClosed;
    });
  }

  static async start(options: StartSshTerminalRuntimeOptions): Promise<SshTerminalRuntime> {
    let credentialBuffers: Buffer[] = [];
    let client: Client | undefined;
    try {
      const limits = normalizeLimits(options.limits);
      const columns = validateDimension(options.columns ?? DEFAULT_COLUMNS, "columns");
      const rows = validateDimension(options.rows ?? DEFAULT_ROWS, "rows");
      const normalized = normalizeTarget(options.ssh, credentialBuffers);
      client = (options.createSshClient ?? (() => new Client()))();
      return await startClient(client, normalized, columns, rows, limits, (channel, hostKeySha256) => {
        const runtime = new SshTerminalRuntime(client!, channel, hostKeySha256, limits);
        runtime.attachListeners();
        return runtime;
      });
    } catch (error) {
      if (error instanceof SshTerminalStartError) throw error;
      try {
        client?.destroy();
      } catch {
        // Startup reports one fixed error; raw ssh2 errors never cross the boundary.
      }
      throw new SshTerminalStartError("connection-failed");
    } finally {
      for (const buffer of credentialBuffers) buffer.fill(0);
      credentialBuffers = [];
    }
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** Replays only the caller-requested tail of the bounded retained scrollback. */
  subscribe(
    subscriber: SshTerminalSubscriber,
    replayLimitBytes = this.limits.maxScrollbackBytes,
  ): () => void {
    if (!Number.isSafeInteger(replayLimitBytes) || replayLimitBytes < 0) {
      throw new SshTerminalRuntimeError("invalid-input");
    }
    if (this.state === "closed") {
      this.replayScrollback(subscriber, Math.min(replayLimitBytes, this.limits.maxScrollbackBytes));
      if (this.lastNotice) this.deliverNotice(subscriber, this.lastNotice);
      if (this.terminalExit) this.deliverExit(subscriber, this.terminalExit);
      return () => undefined;
    }
    if (this.subscribers.size >= this.limits.maxSubscribers) {
      throw new SshTerminalRuntimeError("invalid-input");
    }
    this.subscribers.add(subscriber);
    this.replayScrollback(subscriber, Math.min(replayLimitBytes, this.limits.maxScrollbackBytes));
    if (this.lastNotice) this.deliverNotice(subscriber, this.lastNotice);
    if (this.terminalExit) this.deliverExit(subscriber, this.terminalExit);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.subscribers.delete(subscriber);
    };
  }

  /** Ownership transfers to this call. The supplied view is always zeroized. */
  write(data: Uint8Array): void {
    let owned: Buffer | undefined;
    try {
      this.assertRunning();
      if (data.byteLength > this.limits.maxInputBytes) throw new SshTerminalRuntimeError("invalid-input");
      if (data.byteLength === 0) return;
      if (this.pendingInputBytes + data.byteLength > this.limits.maxPendingInputBytes) {
        this.receiveTransportError();
        throw new SshTerminalRuntimeError("terminal-io-failed");
      }
      owned = Buffer.from(data);
      const writeBuffer = owned;
      this.pendingInput.add(writeBuffer);
      this.pendingInputBytes += writeBuffer.length;
      this.channel.write(writeBuffer, (error?: Error | null) => {
        if (this.pendingInput.delete(writeBuffer)) this.pendingInputBytes -= writeBuffer.length;
        writeBuffer.fill(0);
        if (error) this.receiveTransportError();
      });
      owned = undefined;
    } catch (error) {
      if (owned) {
        if (this.pendingInput.delete(owned)) this.pendingInputBytes -= owned.length;
        owned.fill(0);
      }
      if (error instanceof SshTerminalRuntimeError) throw error;
      this.receiveTransportError();
      throw new SshTerminalRuntimeError("terminal-io-failed");
    } finally {
      data.fill(0);
    }
  }

  resize(columns: number, rows: number): void {
    this.assertRunning();
    const safeColumns = validateRuntimeDimension(columns);
    const safeRows = validateRuntimeDimension(rows);
    try {
      this.channel.setWindow(safeRows, safeColumns, 0, 0);
    } catch {
      this.receiveTransportError();
      throw new SshTerminalRuntimeError("terminal-io-failed");
    }
  }

  pauseOutput(): void {
    this.assertRunning();
    if (this.outputPaused) return;
    try {
      this.channel.pause();
      this.outputPaused = true;
    } catch {
      this.receiveTransportError();
      throw new SshTerminalRuntimeError("terminal-io-failed");
    }
  }

  resumeOutput(): void {
    this.assertRunning();
    if (!this.outputPaused) return;
    try {
      this.outputPaused = false;
      this.drainOutput();
      if (this.state === "running" && !this.outputPaused) this.channel.resume();
    } catch (error) {
      if (error instanceof SshTerminalRuntimeError) throw error;
      this.receiveTransportError();
      throw new SshTerminalRuntimeError("terminal-io-failed");
    }
  }

  close(): Promise<void> {
    return this.beginCleanup();
  }

  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  private attachListeners(): void {
    this.channel.on("data", this.onChannelData);
    this.channel.stderr.on("data", this.onChannelData);
    this.channel.on("error", this.onChannelError);
    this.channel.once("exit", this.onChannelExit);
    this.channel.once("close", this.onChannelClose);
    this.client.on("error", this.onClientError);
    this.client.once("close", this.onClientClose);
  }

  private detachListeners(): void {
    this.channel.removeListener("data", this.onChannelData);
    this.channel.stderr.removeListener("data", this.onChannelData);
    this.channel.removeListener("error", this.onChannelError);
    this.channel.removeListener("exit", this.onChannelExit);
    this.channel.removeListener("close", this.onChannelClose);
    this.client.removeListener("error", this.onClientError);
    this.client.removeListener("close", this.onClientClose);
  }

  private receiveOutput(data: Buffer | string): void {
    if (this.state !== "running") return;
    const owned = Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data, "utf8");
    if (owned.length === 0) return;
    if (this.pendingOutputBytes + owned.length > this.limits.maxPendingOutputBytes) {
      owned.fill(0);
      this.receiveTransportError();
      return;
    }
    this.pendingOutput.push({ data: owned, offset: 0 });
    this.pendingOutputBytes += owned.length;
    this.drainOutput();
  }

  private drainOutput(): void {
    if (this.drainingOutput || this.outputPaused || this.state !== "running") return;
    this.drainingOutput = true;
    try {
      while (this.state === "running" && !this.outputPaused && this.pendingOutput.length > 0) {
        const pending = this.pendingOutput[0];
        if (!pending) break;
        const end = Math.min(pending.offset + this.limits.maxOutputChunkBytes, pending.data.length);
        const chunk = Buffer.from(pending.data.subarray(pending.offset, end));
        const consumed = end - pending.offset;
        pending.offset = end;
        this.pendingOutputBytes -= consumed;
        if (pending.offset === pending.data.length) {
          this.pendingOutput.shift();
          pending.data.fill(0);
        }
        this.retainScrollback(chunk);
        for (const subscriber of this.subscribers) this.deliverOutput(subscriber, chunk);
      }
    } finally {
      this.drainingOutput = false;
    }
  }

  private receiveExit(code: number | null): void {
    if (this.terminalExit || this.state !== "running") return;
    this.terminalExit = { exitCode: normalizeExitCode(code) };
    for (const subscriber of this.subscribers) this.deliverExit(subscriber, this.terminalExit);
    void this.beginCleanup();
  }

  private receiveTransportError(): void {
    if (this.state !== "running") return;
    this.reportNotice("terminal-io-failed");
    if (!this.terminalExit) {
      this.terminalExit = { exitCode: 255 };
      for (const subscriber of this.subscribers) this.deliverExit(subscriber, this.terminalExit);
    }
    void this.beginCleanup();
  }

  private receiveChannelClose(): void {
    if (this.state !== "running") return;
    if (!this.terminalExit) {
      this.terminalExit = { exitCode: 255 };
      for (const subscriber of this.subscribers) this.deliverExit(subscriber, this.terminalExit);
    }
    void this.beginCleanup();
  }

  private receiveClientClose(): void {
    if (!this.transportClosed) {
      this.transportClosed = true;
      this.resolveTransportClosed();
    }
    if (this.state !== "running") return;
    if (!this.terminalExit) {
      this.terminalExit = { exitCode: 255 };
      for (const subscriber of this.subscribers) this.deliverExit(subscriber, this.terminalExit);
    }
    void this.beginCleanup();
  }

  private retainScrollback(chunk: Buffer): void {
    this.scrollback.push(chunk);
    this.scrollbackBytes += chunk.length;
    while (this.scrollbackBytes > this.limits.maxScrollbackBytes) {
      const oldest = this.scrollback[0];
      if (!oldest) break;
      const excess = this.scrollbackBytes - this.limits.maxScrollbackBytes;
      if (oldest.length <= excess) {
        this.scrollback.shift();
        this.scrollbackBytes -= oldest.length;
        oldest.fill(0);
        continue;
      }
      const retained = Buffer.from(oldest.subarray(excess));
      oldest.fill(0);
      this.scrollback[0] = retained;
      this.scrollbackBytes -= excess;
    }
  }

  private replayScrollback(subscriber: SshTerminalSubscriber, limitBytes: number): void {
    let skipBytes = Math.max(0, this.scrollbackBytes - limitBytes);
    for (const chunk of this.scrollback) {
      if (skipBytes >= chunk.byteLength) {
        skipBytes -= chunk.byteLength;
        continue;
      }
      this.deliverOutput(subscriber, skipBytes === 0 ? chunk : chunk.subarray(skipBytes));
      skipBytes = 0;
    }
  }

  private deliverOutput(subscriber: SshTerminalSubscriber, chunk: Uint8Array): void {
    try {
      subscriber.onOutput(Uint8Array.from(chunk));
    } catch {
      // A renderer transport callback cannot break or observe another subscriber.
    }
  }

  private deliverExit(subscriber: SshTerminalSubscriber, exit: SshTerminalExit): void {
    try {
      subscriber.onExit(exit);
    } catch {
      // A renderer transport callback cannot break transport cleanup.
    }
  }

  private deliverNotice(subscriber: SshTerminalSubscriber, notice: SshTerminalRuntimeNotice): void {
    try {
      subscriber.onError?.(notice);
    } catch {
      // A renderer transport callback cannot break transport cleanup.
    }
  }

  private reportNotice(code: SshTerminalRuntimeErrorCode): void {
    const notice = { code, message: SAFE_RUNTIME_ERROR_MESSAGES[code] } as const;
    this.lastNotice = notice;
    for (const subscriber of this.subscribers) this.deliverNotice(subscriber, notice);
  }

  private assertRunning(): void {
    if (this.state !== "running") throw new SshTerminalRuntimeError("closed");
  }

  private beginCleanup(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.state = "closing";
    this.cleanupPromise = this.performCleanup();
    return this.cleanupPromise;
  }

  private async performCleanup(): Promise<void> {
    // Make cleanupPromise observable before close() can synchronously emit.
    await Promise.resolve();
    this.channel.removeListener("data", this.onChannelData);
    this.channel.stderr.removeListener("data", this.onChannelData);
    try {
      this.channel.close();
    } catch {
      // The client connection below is the final bounded teardown path.
    }
    try {
      this.client.end();
    } catch {
      // A forced destroy follows if no close event arrives in time.
    }
    await this.waitForTransportClose();
    if (!this.transportClosed) {
      try {
        this.client.destroy();
      } catch {
        // The runtime still reaches a terminal local state after the deadline.
      }
    }
    this.detachListeners();
    for (const input of this.pendingInput) input.fill(0);
    for (const chunk of this.scrollback) chunk.fill(0);
    for (const pending of this.pendingOutput) pending.data.fill(0);
    this.pendingInput.clear();
    this.scrollback.length = 0;
    this.pendingOutput.length = 0;
    this.pendingInputBytes = 0;
    this.scrollbackBytes = 0;
    this.pendingOutputBytes = 0;
    this.subscribers.clear();
    this.state = "closed";
    this.resolveClosed();
  }

  private async waitForTransportClose(): Promise<void> {
    if (this.transportClosed) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.transportClosedPromise,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, this.limits.closeTimeoutMilliseconds);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

async function startClient(
  client: Client,
  target: NormalizedSshTerminalTarget,
  columns: number,
  rows: number,
  limits: SshTerminalRuntimeLimits,
  createRuntime: (channel: ClientChannel, hostKeySha256: string) => SshTerminalRuntime,
): Promise<SshTerminalRuntime> {
  let observedFingerprint: string | undefined;
  let hostKeyApprovalRequired = false;
  let hostKeyMismatch = false;
  let phase: "connecting" | "shell" = "connecting";

  const config: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    ...(target.hostKeySha256 === undefined
      ? { authHandler: ["none"] }
      : {
          privateKey: target.privateKey,
          ...(target.passphrase === undefined ? {} : { passphrase: target.passphrase }),
          authHandler: ["publickey"],
        }),
    readyTimeout: limits.connectTimeoutMilliseconds,
    timeout: limits.connectTimeoutMilliseconds,
    keepaliveInterval: KEEPALIVE_INTERVAL_MILLISECONDS,
    keepaliveCountMax: KEEPALIVE_COUNT_MAX,
    hostVerifier: (key: Buffer) => {
      const fingerprint = sshHostKeySha256(key);
      if (observedFingerprint !== undefined && !constantTimeEqual(observedFingerprint, fingerprint)) {
        hostKeyMismatch = true;
        return false;
      }
      observedFingerprint = fingerprint;
      if (target.hostKeySha256 === undefined) {
        hostKeyApprovalRequired = true;
        // Deliberately abort before ssh2 begins user authentication. The caller
        // may explicitly trust the observed fingerprint and retry with a pin.
        return false;
      }
      const matches = constantTimeEqual(target.hostKeySha256, fingerprint);
      if (!matches) hostKeyMismatch = true;
      return matches;
    },
  };

  return new Promise<SshTerminalRuntime>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const clearPhaseTimer = (): void => {
      if (!timer) return;
      clearTimeout(timer);
      timer = undefined;
    };
    const removeStartupListeners = (): void => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
    };
    const fail = (code: SshTerminalStartErrorCode): void => {
      if (settled) return;
      settled = true;
      clearPhaseTimer();
      // Keep an error sink installed across destroy: a second asynchronous
      // socket error must not become an unhandled EventEmitter exception.
      client.on("error", () => undefined);
      try {
        client.destroy();
      } catch {
        // The typed startup error is intentionally independent of teardown.
      }
      removeStartupListeners();
      reject(new SshTerminalStartError(code, observedFingerprint));
    };
    const startTimer = (milliseconds: number, code: SshTerminalStartErrorCode): void => {
      clearPhaseTimer();
      timer = setTimeout(() => fail(code), milliseconds);
      timer.unref?.();
    };
    const startupFailureCode = (): SshTerminalStartErrorCode => {
      if (hostKeyApprovalRequired) return "host-key-approval-required";
      if (hostKeyMismatch) return "host-key-mismatch";
      return phase === "shell" ? "shell-failed" : "connection-failed";
    };
    const onError = (): void => fail(startupFailureCode());
    const onClose = (): void => fail(startupFailureCode());
    const onReady = (): void => {
      if (settled) return;
      if (observedFingerprint === undefined) {
        fail("connection-failed");
        return;
      }
      clearClientCredentialReference(client);
      delete config.privateKey;
      delete config.passphrase;
      phase = "shell";
      startTimer(limits.shellTimeoutMilliseconds, "shell-failed");
      try {
        client.shell({
          term: TERMINAL_TYPE,
          cols: columns,
          rows,
          width: 0,
          height: 0,
        }, (error, channel) => {
          if (settled) {
            if (!error) channel.close();
            return;
          }
          if (error) {
            fail("shell-failed");
            return;
          }
          try {
            const runtime = createRuntime(channel, observedFingerprint!);
            settled = true;
            clearPhaseTimer();
            removeStartupListeners();
            resolve(runtime);
          } catch {
            try {
              channel.close();
            } catch {
              // Startup returns only the fixed shell error below.
            }
            fail("shell-failed");
          }
        });
      } catch {
        fail("shell-failed");
      }
    };

    client.once("ready", onReady);
    client.on("error", onError);
    client.once("close", onClose);
    startTimer(limits.connectTimeoutMilliseconds, "connection-failed");
    try {
      client.connect(config);
    } catch {
      fail(startupFailureCode());
    }
  });
}

function normalizeTarget(target: SshTerminalTarget, credentialBuffers: Buffer[]): NormalizedSshTerminalTarget {
  const host = normalizeSshHost(target.host);
  const port = boundedInteger(target.port ?? 22, 1, 65_535);
  if (!SSH_USERNAME_PATTERN.test(target.username)) throw new SshTerminalStartError("invalid-input");
  if (target.hostKeySha256 !== undefined && !HOST_KEY_PATTERN.test(target.hostKeySha256)) {
    throw new SshTerminalStartError("invalid-input");
  }
  const privateKey = copyCredential(target.privateKey, MAX_PRIVATE_KEY_BYTES, credentialBuffers);
  const passphrase = target.passphrase === undefined
    ? undefined
    : copyCredential(target.passphrase, MAX_PASSPHRASE_BYTES, credentialBuffers);
  return {
    host,
    port,
    username: target.username,
    privateKey,
    ...(passphrase === undefined ? {} : { passphrase }),
    ...(target.hostKeySha256 === undefined ? {} : { hostKeySha256: target.hostKeySha256 }),
  };
}

function copyCredential(value: Buffer | string, maximumBytes: number, ownedBuffers: Buffer[]): Buffer | string {
  const byteLength = Buffer.isBuffer(value) ? value.byteLength : Buffer.byteLength(value, "utf8");
  if (byteLength < 1 || byteLength > maximumBytes) throw new SshTerminalStartError("invalid-input");
  if (typeof value === "string") {
    if (value.includes("\0")) throw new SshTerminalStartError("invalid-input");
    return value;
  }
  if (value.includes(0)) throw new SshTerminalStartError("invalid-input");
  const copy = Buffer.from(value);
  ownedBuffers.push(copy);
  return copy;
}

function normalizeSshHost(value: string): string {
  const trimmed = value.trim();
  const unbracketed = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  if (isIP(unbracketed) !== 0) return unbracketed;
  if (unbracketed.length < 1 || unbracketed.length > 253 || !validDnsName(unbracketed)) {
    throw new SshTerminalStartError("invalid-input");
  }
  return unbracketed.toLowerCase();
}

function validDnsName(value: string): boolean {
  return value.split(".").every((label) =>
    label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(label)
  );
}

function normalizeLimits(overrides: Partial<SshTerminalRuntimeLimits> | undefined): SshTerminalRuntimeLimits {
  const limits = { ...DEFAULT_SSH_TERMINAL_LIMITS, ...overrides };
  validatePositiveLimit(limits.maxInputBytes, 1, 1024 * 1024);
  validatePositiveLimit(limits.maxPendingInputBytes, limits.maxInputBytes, 4 * 1024 * 1024);
  validatePositiveLimit(limits.maxOutputChunkBytes, 1_024, DEFAULT_SSH_TERMINAL_LIMITS.maxOutputChunkBytes);
  validatePositiveLimit(limits.maxPendingOutputBytes, limits.maxOutputChunkBytes, 4 * 1024 * 1024);
  validatePositiveLimit(limits.maxScrollbackBytes, limits.maxOutputChunkBytes, 16 * 1024 * 1024);
  validatePositiveLimit(limits.maxSubscribers, 1, 64);
  validatePositiveLimit(limits.connectTimeoutMilliseconds, 1, 5 * 60_000);
  validatePositiveLimit(limits.shellTimeoutMilliseconds, 1, 60_000);
  validatePositiveLimit(limits.closeTimeoutMilliseconds, 1, 30_000);
  return limits;
}

function validatePositiveLimit(value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SshTerminalStartError("invalid-input");
  }
}

function validateDimension(value: number, _label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) {
    throw new SshTerminalStartError("invalid-input");
  }
  return value;
}

function validateRuntimeDimension(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) {
    throw new SshTerminalRuntimeError("invalid-input");
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SshTerminalStartError("invalid-input");
  }
  return value;
}

function sshHostKeySha256(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  try {
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
}

function clearClientCredentialReference(client: Client): void {
  const internal = client as unknown as { config?: { privateKey?: Buffer | string } };
  const privateKey = internal.config?.privateKey;
  if (Buffer.isBuffer(privateKey)) privateKey.fill(0);
  if (internal.config) delete internal.config.privateKey;
}

function normalizeExitCode(code: number | null): number {
  return Number.isSafeInteger(code) && code !== null && code >= 0 && code <= 255 ? code : 255;
}
