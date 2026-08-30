import { chmod, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { MAX_SAVED_CONFIG_BYTES } from "./saved-config-catalog.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

const CONSOLE_ROOT_PREFIX = "sliver-gui-console-";
const CONSOLE_ROOT_NAME_PATTERN = /^sliver-gui-console-[A-Za-z0-9]{6}$/u;
const CONSOLE_ROOT_MARKER_FILE = ".sliver-gui-console-root";
const CONSOLE_ROOT_MARKER = Buffer.from("sliver-gui-console-root-v1\n", "utf8");
const ACTIVE_CONFIG_FILE = "active.cfg";
const CLIENT_SETTINGS_FILE = "tui-settings.yaml";
const CLIENT_SETTINGS = Buffer.from("console_logs: false\n", "utf8");
const PTY_EXIT_GRACE_MILLISECONDS = 1_500;
const PTY_FORCE_EXIT_GRACE_MILLISECONDS = 500;
const PROTECTED_ENVIRONMENT_KEYS = new Set(["COLORTERM", "SLIVER_CLIENT_ROOT_DIR", "TERM"]);
const SAFE_ERROR_MESSAGES = {
  "cleanup-failed": "The private Sliver console workspace could not be removed.",
  "terminal-io-failed": "The Sliver console stopped after a local terminal error.",
} as const;

export const DEFAULT_SLIVER_CONSOLE_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024,
  maxOutputChunkBytes: 64 * 1024,
  maxScrollbackBytes: 256 * 1024,
  maxSubscribers: 8,
});

export interface NativePtyDisposable {
  dispose(): void;
}

/** The dependency-injected subset of node-pty used by the console runtime. */
export interface NativePty {
  write(data: string | Buffer): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): NativePtyDisposable;
  onExit(listener: (event: NativePtyExitEvent) => void): NativePtyDisposable;
}

export interface NativePtyExitEvent {
  readonly exitCode: number;
  readonly signal?: number;
}

export interface NativePtySpawnOptions {
  readonly name: "xterm-256color";
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
}

export interface NativePtyFactory {
  spawn(file: string, args: string[], options: NativePtySpawnOptions): NativePty;
}

export interface SliverConsoleRuntimeLimits {
  readonly maxInputBytes: number;
  readonly maxOutputChunkBytes: number;
  readonly maxScrollbackBytes: number;
  readonly maxSubscribers: number;
}

export interface StartSliverConsoleRuntimeOptions {
  readonly clientExecutable: string;
  /** Ownership transfers to this call. The supplied view is zeroized on every outcome. */
  readonly configBytes: Uint8Array;
  readonly ptyFactory: NativePtyFactory;
  /**
   * Synchronous final authorization check. The runtime invokes this immediately
   * before spawning, after all asynchronous validation and private staging.
   */
  readonly assertSpawnLease?: () => void;
  readonly tempDirectory?: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly columns?: number;
  readonly rows?: number;
  readonly limits?: Partial<SliverConsoleRuntimeLimits>;
}

export interface SliverConsoleExit {
  readonly exitCode: number;
  readonly signal?: number;
}

export type SliverConsoleRuntimeErrorCode = "cleanup-failed" | "terminal-io-failed";

export interface SliverConsoleRuntimeNotice {
  readonly code: SliverConsoleRuntimeErrorCode;
  readonly message: string;
}

export interface SliverConsoleSubscriber {
  onOutput(data: Uint8Array): void;
  onExit(exit: SliverConsoleExit): void;
  onError?(notice: SliverConsoleRuntimeNotice): void;
}

export class SliverConsoleStartError extends Error {
  readonly code = "start-failed" as const;

  constructor() {
    super("The Sliver console could not be started.");
    this.name = "SliverConsoleStartError";
  }
}

export class SliverConsoleRuntimeError extends Error {
  constructor(readonly code: SliverConsoleRuntimeErrorCode | "closed" | "invalid-input") {
    super(
      code === "closed"
        ? "The Sliver console is closed."
        : code === "invalid-input"
          ? "The Sliver console input is invalid."
          : SAFE_ERROR_MESSAGES[code],
    );
    this.name = "SliverConsoleRuntimeError";
  }
}

/**
 * Owns one native Sliver client process and its private, one-configuration root.
 * Renderer code must only reach this object through a separately authenticated
 * main-process transport.
 */
export class SliverConsoleRuntime {
  private readonly subscribers = new Set<SliverConsoleSubscriber>();
  private readonly scrollback: Buffer[] = [];
  private readonly closedPromise: Promise<void>;
  private readonly ptyExitedPromise: Promise<void>;
  private resolveClosed: () => void = () => undefined;
  private resolvePtyExited: () => void = () => undefined;
  private scrollbackBytes = 0;
  private state: "running" | "closing" | "closed" = "running";
  private cleanupPromise: Promise<void> | undefined;
  private dataDisposable: NativePtyDisposable | undefined;
  private exitDisposable: NativePtyDisposable | undefined;
  private terminalExit: SliverConsoleExit | undefined;
  private lastNotice: SliverConsoleRuntimeNotice | undefined;
  private ptyExited = false;

  private constructor(
    private readonly pty: NativePty,
    private readonly rootDirectory: string,
    private readonly rootPrefix: string,
    private readonly limits: SliverConsoleRuntimeLimits,
  ) {
    this.closedPromise = new Promise((resolveClosed) => {
      this.resolveClosed = resolveClosed;
    });
    this.ptyExitedPromise = new Promise((resolvePtyExited) => {
      this.resolvePtyExited = resolvePtyExited;
    });
  }

  static async start(options: StartSliverConsoleRuntimeOptions): Promise<SliverConsoleRuntime> {
    let stagedConfig: Buffer | undefined;
    let rootDirectory: string | undefined;
    let rootPrefix: string | undefined;
    let pty: NativePty | undefined;

    try {
      validateExecutable(options.clientExecutable);
      await assertExecutableFile(options.clientExecutable);
      validateConfig(options.configBytes);
      const limits = normalizeLimits(options.limits);
      const columns = validateDimension(options.columns ?? 120, "columns");
      const rows = validateDimension(options.rows ?? 36, "rows");
      const tempRoot = await verifiedTemporaryDirectory(options.tempDirectory ?? tmpdir());
      rootPrefix = join(tempRoot, CONSOLE_ROOT_PREFIX);
      rootDirectory = await mkdtemp(rootPrefix);
      if (!isOwnedConsoleRoot(rootDirectory, rootPrefix)) throw new Error("Unexpected temporary directory");
      if (process.platform !== "win32") await chmod(rootDirectory, 0o700);
      await assertPrivateDirectory(rootDirectory);

      stagedConfig = Buffer.from(options.configBytes);
      const configsDirectory = join(rootDirectory, "configs");
      // The marker is written before any credential material. A later startup
      // scavenges only exact mkdtemp roots bearing this private marker.
      await writePrivateFileAtomic(join(rootDirectory, CONSOLE_ROOT_MARKER_FILE), CONSOLE_ROOT_MARKER);
      await writePrivateFileAtomic(join(configsDirectory, ACTIVE_CONFIG_FILE), stagedConfig);
      await writePrivateFileAtomic(join(rootDirectory, CLIENT_SETTINGS_FILE), CLIENT_SETTINGS);
      const configEntries = await readdir(configsDirectory);
      if (configEntries.length !== 1 || configEntries[0] !== ACTIVE_CONFIG_FILE) {
        throw new Error("Unexpected staged configuration directory contents");
      }

      const environment = buildEnvironment(options.environment, rootDirectory);
      options.assertSpawnLease?.();
      pty = options.ptyFactory.spawn(options.clientExecutable, ["--disable-wg"], {
        name: "xterm-256color",
        cwd: rootDirectory,
        cols: columns,
        rows,
        env: environment,
      });
      const runtime = new SliverConsoleRuntime(pty, rootDirectory, rootPrefix, limits);
      runtime.attachPtyListeners();
      return runtime;
    } catch {
      try {
        pty?.kill();
      } catch {
        // Startup reports one fixed error; raw native errors never cross the boundary.
      }
      if (rootDirectory && rootPrefix) await removeOwnedConsoleRoot(rootDirectory, rootPrefix);
      throw new SliverConsoleStartError();
    } finally {
      stagedConfig?.fill(0);
      options.configBytes.fill(0);
    }
  }

  get isClosed(): boolean {
    return this.state === "closed";
  }

  /** Replays only the bounded retained scrollback, followed by terminal state. */
  subscribe(subscriber: SliverConsoleSubscriber): () => void {
    if (this.state === "closed") {
      if (this.lastNotice) this.deliverNotice(subscriber, this.lastNotice);
      if (this.terminalExit) this.deliverExit(subscriber, this.terminalExit);
      return () => undefined;
    }
    if (this.subscribers.size >= this.limits.maxSubscribers) {
      throw new SliverConsoleRuntimeError("invalid-input");
    }
    this.subscribers.add(subscriber);
    for (const chunk of this.scrollback) this.deliverOutput(subscriber, chunk);
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
      if (data.byteLength > this.limits.maxInputBytes) throw new SliverConsoleRuntimeError("invalid-input");
      if (data.byteLength === 0) return;
      owned = Buffer.from(data);
      this.pty.write(owned);
    } catch (error) {
      if (error instanceof SliverConsoleRuntimeError) throw error;
      const safeError = new SliverConsoleRuntimeError("terminal-io-failed");
      this.reportNotice("terminal-io-failed");
      void this.beginCleanup(true);
      throw safeError;
    } finally {
      owned?.fill(0);
      data.fill(0);
    }
  }

  resize(columns: number, rows: number): void {
    this.assertRunning();
    const safeColumns = validateDimension(columns, "columns");
    const safeRows = validateDimension(rows, "rows");
    try {
      this.pty.resize(safeColumns, safeRows);
    } catch {
      const safeError = new SliverConsoleRuntimeError("terminal-io-failed");
      this.reportNotice("terminal-io-failed");
      void this.beginCleanup(true);
      throw safeError;
    }
  }

  close(): Promise<void> {
    return this.beginCleanup(true);
  }

  waitForClose(): Promise<void> {
    return this.closedPromise;
  }

  private attachPtyListeners(): void {
    try {
      this.dataDisposable = this.pty.onData((data) => this.receiveOutput(data));
      this.exitDisposable = this.pty.onExit((event) => this.receiveExit(event));
    } catch (error) {
      this.dataDisposable?.dispose();
      this.dataDisposable = undefined;
      throw error;
    }
  }

  private receiveOutput(data: string): void {
    if (this.state !== "running" || data.length === 0) return;
    try {
      for (const chunk of encodeOutputChunks(data, this.limits.maxOutputChunkBytes)) {
        this.retainScrollback(chunk);
        for (const subscriber of this.subscribers) this.deliverOutput(subscriber, chunk);
      }
    } catch {
      this.reportNotice("terminal-io-failed");
      void this.beginCleanup(true);
    }
  }

  private receiveExit(event: NativePtyExitEvent): void {
    if (!this.ptyExited) {
      this.ptyExited = true;
      this.resolvePtyExited();
    }
    if (this.terminalExit || this.state !== "running") return;
    this.terminalExit = normalizeExit(event);
    void this.beginCleanup(false);
    for (const subscriber of this.subscribers) this.deliverExit(subscriber, this.terminalExit);
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

  private deliverOutput(subscriber: SliverConsoleSubscriber, chunk: Uint8Array): void {
    try {
      subscriber.onOutput(Uint8Array.from(chunk));
    } catch {
      // A renderer transport callback cannot break or observe another subscriber.
    }
  }

  private deliverExit(subscriber: SliverConsoleSubscriber, exit: SliverConsoleExit): void {
    try {
      subscriber.onExit(exit);
    } catch {
      // A renderer transport callback cannot break process cleanup.
    }
  }

  private deliverNotice(subscriber: SliverConsoleSubscriber, notice: SliverConsoleRuntimeNotice): void {
    try {
      subscriber.onError?.(notice);
    } catch {
      // A renderer transport callback cannot break process cleanup.
    }
  }

  private reportNotice(code: SliverConsoleRuntimeErrorCode): void {
    const notice = { code, message: SAFE_ERROR_MESSAGES[code] } as const;
    this.lastNotice = notice;
    for (const subscriber of this.subscribers) this.deliverNotice(subscriber, notice);
  }

  private assertRunning(): void {
    if (this.state !== "running") throw new SliverConsoleRuntimeError("closed");
  }

  private beginCleanup(killProcess: boolean): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.state = "closing";
    this.cleanupPromise = this.performCleanup(killProcess);
    return this.cleanupPromise;
  }

  private async performCleanup(killProcess: boolean): Promise<void> {
    // Make cleanupPromise observable before kill() can synchronously emit exit.
    await Promise.resolve();
    this.dataDisposable?.dispose();
    this.dataDisposable = undefined;
    if (killProcess && !this.ptyExited) {
      try {
        this.pty.kill();
      } catch {
        this.reportNotice("terminal-io-failed");
      }
      await this.waitForPtyExit(PTY_EXIT_GRACE_MILLISECONDS);
      if (!this.ptyExited) {
        try {
          this.pty.kill(process.platform === "win32" ? undefined : "SIGKILL");
        } catch {
          this.reportNotice("terminal-io-failed");
        }
        await this.waitForPtyExit(PTY_FORCE_EXIT_GRACE_MILLISECONDS);
      }
      if (!this.ptyExited) this.reportNotice("cleanup-failed");
    }
    this.exitDisposable?.dispose();
    this.exitDisposable = undefined;

    const removed = await removeOwnedConsoleRoot(this.rootDirectory, this.rootPrefix);
    if (!removed) this.reportNotice("cleanup-failed");
    for (const chunk of this.scrollback) chunk.fill(0);
    this.scrollback.length = 0;
    this.scrollbackBytes = 0;
    this.subscribers.clear();
    this.state = "closed";
    this.resolveClosed();
  }

  private async waitForPtyExit(timeoutMilliseconds: number): Promise<void> {
    if (this.ptyExited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.ptyExitedPromise,
      new Promise<void>((resolveTimeout) => {
        timer = setTimeout(resolveTimeout, timeoutMilliseconds);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
}

/**
 * Removes credential-bearing console roots left by a previous crashed instance.
 * The production caller runs this only after obtaining Electron's single-instance
 * lock, so no live GUI-owned root can match during the scan.
 */
export async function scavengeStaleSliverConsoleRoots(tempDirectory: string = tmpdir()): Promise<number> {
  const tempRoot = await verifiedTemporaryDirectory(tempDirectory);
  const rootPrefix = join(tempRoot, CONSOLE_ROOT_PREFIX);
  const entries = await readdir(tempRoot, { withFileTypes: true });
  let removedRoots = 0;

  for (const entry of entries) {
    if (!CONSOLE_ROOT_NAME_PATTERN.test(entry.name)) continue;
    const candidate = join(tempRoot, entry.name);
    let markerBytes: Buffer | undefined;
    let recognizedOwnedRoot = false;
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink() || !stats.isDirectory() || !isPrivateRootOwnedByCurrentUser(stats)) continue;
      const marker = await readBoundedRegularFile(join(candidate, CONSOLE_ROOT_MARKER_FILE), {
        label: "Sliver console root marker",
        maxBytes: CONSOLE_ROOT_MARKER.byteLength,
        requirePrivateMode: true,
      });
      markerBytes = marker.data;
      if (!markerBytes.equals(CONSOLE_ROOT_MARKER)) continue;
      recognizedOwnedRoot = true;
      if (!await removeOwnedConsoleRoot(candidate, rootPrefix)) {
        throw new Error("The stale Sliver console workspace could not be removed");
      }
      removedRoots += 1;
    } catch (error) {
      // Unmarked, malformed, inaccessible, prefix-similar, and symlink entries
      // are not ours to delete. Once the private marker has authenticated a
      // root, cleanup failure is fatal so retained credentials are not ignored.
      if (recognizedOwnedRoot) throw error;
    } finally {
      markerBytes?.fill(0);
    }
  }

  return removedRoots;
}

function normalizeLimits(overrides: Partial<SliverConsoleRuntimeLimits> | undefined): SliverConsoleRuntimeLimits {
  const limits = { ...DEFAULT_SLIVER_CONSOLE_LIMITS, ...overrides };
  validatePositiveLimit(limits.maxInputBytes, "input limit", 1);
  validatePositiveLimit(limits.maxOutputChunkBytes, "output chunk limit", 1_024);
  validatePositiveLimit(limits.maxScrollbackBytes, "scrollback limit", limits.maxOutputChunkBytes);
  validatePositiveLimit(limits.maxSubscribers, "subscriber limit", 1);
  if (limits.maxSubscribers > 64) throw new Error("Invalid subscriber limit");
  return limits;
}

function validatePositiveLimit(value: number, label: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 64 * 1024 * 1024) {
    throw new Error(`Invalid ${label}`);
  }
}

function validateExecutable(executable: string): void {
  if (
    !isAbsolute(executable) ||
    executable.length > 4_096 ||
    executable.includes("\0") ||
    /[\r\n]/u.test(executable)
  ) {
    throw new Error("Invalid console executable");
  }
}

async function assertExecutableFile(executable: string): Promise<void> {
  const stats = await lstat(executable);
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error("Invalid console executable");
  if (process.platform !== "win32" && (stats.mode & 0o111) === 0) throw new Error("Console executable is not executable");
}

function validateConfig(configBytes: Uint8Array): void {
  if (configBytes.byteLength < 1 || configBytes.byteLength > MAX_SAVED_CONFIG_BYTES) {
    throw new Error("Invalid console configuration");
  }
}

function validateDimension(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_000) throw new Error(`Invalid terminal ${label}`);
  return value;
}

async function verifiedTemporaryDirectory(path: string): Promise<string> {
  const canonical = await realpath(resolve(path));
  const stats = await lstat(canonical);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Invalid temporary directory");
  return canonical;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Invalid private directory");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) throw new Error("Private directory is not private");
}

function isPrivateRootOwnedByCurrentUser(stats: Stats): boolean {
  if (process.platform === "win32") return true;
  if ((stats.mode & 0o077) !== 0) return false;
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function buildEnvironment(
  overlay: Readonly<NodeJS.ProcessEnv> | undefined,
  rootDirectory: string,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const source of [process.env, overlay ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value !== "string" || PROTECTED_ENVIRONMENT_KEYS.has(key.toUpperCase())) continue;
      result[key] = value;
    }
  }
  result["TERM"] = "xterm-256color";
  result["COLORTERM"] = "truecolor";
  result["SLIVER_CLIENT_ROOT_DIR"] = rootDirectory;
  return result;
}

function* encodeOutputChunks(data: string, maxBytes: number): Generator<Buffer> {
  const maxCodeUnits = Math.max(1, Math.floor(maxBytes / 3));
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(data.length, offset + maxCodeUnits);
    if (end < data.length && end > offset && isHighSurrogate(data.charCodeAt(end - 1))) end -= 1;
    if (end === offset) end += 1;
    const encoded = Buffer.from(data.slice(offset, end), "utf8");
    if (encoded.length > maxBytes) {
      for (let byteOffset = 0; byteOffset < encoded.length; byteOffset += maxBytes) {
        yield Buffer.from(encoded.subarray(byteOffset, byteOffset + maxBytes));
      }
      encoded.fill(0);
    } else {
      yield encoded;
    }
    offset = end;
  }
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function normalizeExit(event: NativePtyExitEvent): SliverConsoleExit {
  const exitCode = Number.isSafeInteger(event.exitCode) && event.exitCode >= 0 && event.exitCode <= 0x7fff_ffff
    ? event.exitCode
    : -1;
  const signal = event.signal;
  return typeof signal === "number" && Number.isSafeInteger(signal) && signal >= 0 && signal <= 0x7fff_ffff
    ? { exitCode, signal }
    : { exitCode };
}

function isOwnedConsoleRoot(rootDirectory: string, rootPrefix: string): boolean {
  const canonicalRoot = resolve(rootDirectory);
  const canonicalPrefix = resolve(rootPrefix);
  const rootName = basename(canonicalRoot);
  const prefixName = basename(canonicalPrefix);
  return (
    dirname(canonicalRoot) === dirname(canonicalPrefix) &&
    rootName.startsWith(prefixName) &&
    rootName.length > prefixName.length
  );
}

async function removeOwnedConsoleRoot(rootDirectory: string, rootPrefix: string): Promise<boolean> {
  if (!isOwnedConsoleRoot(rootDirectory, rootPrefix)) return false;
  try {
    await rm(rootDirectory, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 4 : 1,
      retryDelay: 50,
    });
    return true;
  } catch {
    return false;
  }
}
