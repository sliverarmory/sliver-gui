import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";

import { parseBeagleJson, type BeagleJsonValue } from "../shared/beagle-contracts.js";
import {
  BEAGLE_RUNTIME_MAX_REQUEST_BYTES, BEAGLE_RUNTIME_MAX_RESPONSE_BYTES, BEAGLE_RUNTIME_OPERATIONS,
  BEAGLE_RUNTIME_REQUIRED_OPERATIONS,
  BEAGLE_RUNTIME_PROTOCOL, type BeagleRuntimeCommand, type BeagleRuntimeReady,
} from "../shared/beagle-runtime-contracts.js";

export interface BeagleRuntimeRequestOptions { timeout: number; signal?: AbortSignal }
export interface BeagleRuntimeOptions { cwd: string; env: NodeJS.ProcessEnv }
export interface BeagleRuntimeClient {
  readonly ready: Promise<BeagleRuntimeReady>;
  readonly closed: boolean;
  request(command: BeagleRuntimeCommand, options: BeagleRuntimeRequestOptions): Promise<BeagleJsonValue>;
  stop(): Promise<void>;
}

/** An operation may fail while the helper remains healthy and available for the next request. */
export class BeagleRuntimeOperationError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "BeagleRuntimeOperationError"; }
}

const READY_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 1_000;
const MAX_READY_BYTES = 16 * 1024;
const PAGE_BYTES = 64 * 1024;

/** Fixed-size pages bound fragment overhead and copy a response only once during assembly. */
class LineDecoder {
  #pages: Buffer[] = [];
  #length = 0;
  get pending(): boolean { return this.#length !== 0; }
  reset(): void { this.#pages = []; this.#length = 0; }
  push(chunk: Buffer, limit: () => number, receive: (line: Buffer) => void): void {
    for (let offset = 0; offset < chunk.length;) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (this.#length + length + 1 > limit()) throw new Error("Beagle runtime response exceeds its limit");
      for (let copied = 0; copied < length;) {
        const pageOffset = this.#length % PAGE_BYTES;
        if (pageOffset === 0) this.#pages.push(Buffer.allocUnsafe(PAGE_BYTES));
        const size = Math.min(PAGE_BYTES - pageOffset, length - copied);
        chunk.copy(this.#pages[this.#pages.length - 1]!, pageOffset, offset + copied, offset + copied + size);
        this.#length += size; copied += size;
      }
      offset = end + (newline < 0 ? 0 : 1);
      if (newline >= 0) {
        const line = Buffer.concat(this.#pages, this.#length);
        this.reset(); receive(line);
      }
    }
  }
}

interface PendingRequest {
  id: number;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  removeAbort: () => void;
  resolve: (value: BeagleJsonValue) => void;
  reject: (error: Error) => void;
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new Error("Invalid Beagle runtime message");
  }
  return value as Record<string, unknown>;
}

function operationError(raw: unknown): BeagleRuntimeOperationError {
  const value = object(raw, ["code", "message"]);
  if (typeof value["code"] !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value["code"]) ||
      typeof value["message"] !== "string" || value["message"].length === 0 || value["message"].length > 4096 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value["message"])) throw new Error("Invalid Beagle runtime error");
  return new BeagleRuntimeOperationError(value["code"], value["message"]);
}

function parseReady(raw: unknown): BeagleRuntimeReady {
  const value = object(raw, ["type", "protocol", "name", "version", "operations", "limits"]);
  const limits = object(value["limits"], ["requestBytes", "responseBytes"]);
  const operations = value["operations"];
  if (value["type"] !== "ready" || value["protocol"] !== BEAGLE_RUNTIME_PROTOCOL || value["name"] !== "beagle" ||
      typeof value["version"] !== "string" || !/^0\.1\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value["version"]) ||
      !Array.isArray(operations) || operations.length > 64 ||
      operations.some((name) => typeof name !== "string" || !/^[a-zA-Z][a-zA-Z0-9]{0,63}$/u.test(name)) ||
      new Set(operations).size !== operations.length || BEAGLE_RUNTIME_REQUIRED_OPERATIONS.some((name) => !operations.includes(name)) ||
      limits["requestBytes"] !== BEAGLE_RUNTIME_MAX_REQUEST_BYTES || limits["responseBytes"] !== BEAGLE_RUNTIME_MAX_RESPONSE_BYTES) {
    throw new Error("Incompatible Beagle runtime protocol; update the Beagle executable");
  }
  return Object.freeze({ type: "ready", protocol: BEAGLE_RUNTIME_PROTOCOL, name: "beagle", version: value["version"],
    operations: Object.freeze(BEAGLE_RUNTIME_OPERATIONS.filter((name) => operations.includes(name))),
    limits: Object.freeze({ requestBytes: BEAGLE_RUNTIME_MAX_REQUEST_BYTES, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES }) });
}

class BeagleRuntime implements BeagleRuntimeClient {
  readonly ready: Promise<BeagleRuntimeReady>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder = new LineDecoder();
  readonly #exit: Promise<void>;
  #resolveExit!: () => void;
  #resolveReady!: (value: BeagleRuntimeReady) => void;
  #rejectReady!: (error: Error) => void;
  #readyTimer: ReturnType<typeof setTimeout>;
  #killTimer: ReturnType<typeof setTimeout> | undefined;
  #pending: PendingRequest | undefined;
  #ready = false;
  #closed = false;
  #exited = false;
  #nextId = 1;

  constructor(executable: string, options: BeagleRuntimeOptions) {
    if (!isAbsolute(executable) || !isAbsolute(options.cwd)) throw new Error("Beagle runtime requires verified absolute paths");
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    // Startup can fail before a caller awaits ready; preserve the rejection without an unhandled promise.
    void this.ready.catch(() => undefined);
    this.#exit = new Promise((resolve) => { this.#resolveExit = resolve; });
    try {
      this.#child = spawn(executable, ["helper-stdio"], { cwd: options.cwd, env: options.env, stdio: "pipe", shell: false, windowsHide: true });
    } catch { throw new Error("Beagle runtime could not start"); }
    this.#readyTimer = setTimeout(() => this.#fail(new Error("Beagle runtime readiness timed out")), READY_TIMEOUT_MS);
    this.#readyTimer.unref();
    this.#child.stdout.on("data", (chunk: Buffer) => {
      if (this.#closed) return;
      try {
        this.#decoder.push(chunk, () => this.#ready ? BEAGLE_RUNTIME_MAX_RESPONSE_BYTES : MAX_READY_BYTES, (line) => {
          if (!this.#closed) this.#receive(line);
        });
      } catch (error) {
        this.#fail(error instanceof Error && error.message.startsWith("Incompatible Beagle") ? error : new Error("Beagle runtime returned invalid or oversized protocol data"));
      }
    });
    this.#child.stdout.once("end", () => this.#fail(new Error(this.#decoder.pending
      ? "Beagle runtime returned a truncated response" : "Beagle runtime output pipe closed")));
    this.#child.stdout.on("error", () => this.#fail(new Error("Beagle runtime output pipe failed")));
    this.#child.stdin.on("error", () => this.#fail(new Error("Beagle runtime input pipe failed")));
    this.#child.stderr.on("error", () => undefined);
    this.#child.stderr.resume();
    this.#child.once("error", () => this.#fail(new Error("Beagle runtime could not start")));
    this.#child.once("close", () => {
      this.#exited = true;
      clearTimeout(this.#killTimer);
      if (!this.#closed) this.#fail(new Error(this.#decoder.pending ? "Beagle runtime returned a truncated response" : "Beagle runtime exited"));
      this.#resolveExit();
    });
  }

  get closed(): boolean { return this.#closed; }

  request(command: BeagleRuntimeCommand, options: BeagleRuntimeRequestOptions): Promise<BeagleJsonValue> {
    if (this.#closed) return Promise.reject(new Error("Beagle runtime is closed"));
    if (this.#pending) return Promise.reject(new Error("Beagle runtime already has an active request"));
    if (options.signal?.aborted) return Promise.reject(new Error("Beagle request was canceled before it was sent"));
    if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 2_147_483_647) return Promise.reject(new Error("Invalid Beagle request timeout"));
    if (!Number.isSafeInteger(this.#nextId)) { this.#fail(new Error("Beagle runtime request IDs exhausted")); return Promise.reject(new Error("Beagle runtime is closed")); }
    const id = this.#nextId++;
    let bytes: Buffer;
    try {
      if (!BEAGLE_RUNTIME_OPERATIONS.includes(command.type)) throw new Error();
      bytes = Buffer.from(`${JSON.stringify({ id, command })}\n`, "utf8");
      if (bytes.length > BEAGLE_RUNTIME_MAX_REQUEST_BYTES) { bytes.fill(0); throw new Error(); }
    } catch { return Promise.reject(new Error("Beagle request is invalid or exceeds the 1 MiB limit")); }
    return new Promise((resolve, reject) => {
      const aborted = (): void => {
        if (pending.sent) this.#fail(new Error("Beagle request was canceled; its outcome may be unknown"));
        else { this.#clearPending(); bytes.fill(0); reject(new Error("Beagle request was canceled before it was sent")); }
      };
      const pending: PendingRequest = {
        id, sent: false, resolve, reject,
        timer: setTimeout(() => this.#fail(new Error("Beagle request timed out; its outcome may be unknown")), options.timeout),
        removeAbort: () => options.signal?.removeEventListener("abort", aborted),
      };
      pending.timer.unref();
      this.#pending = pending;
      options.signal?.addEventListener("abort", aborted, { once: true });
      if (options.signal?.aborted) aborted();
      void this.ready.then((ready) => {
        if (this.#closed || this.#pending !== pending) { bytes.fill(0); return; }
        if (!ready.operations.includes(command.type)) {
          this.#clearPending(); bytes.fill(0); reject(new Error("This Beagle executable does not support the requested operation; choose a current executable")); return;
        }
        pending.sent = true;
        try {
          this.#child.stdin.write(bytes, (error) => {
            bytes.fill(0);
            if (error) this.#fail(new Error("Beagle runtime input pipe failed"));
          });
        } catch { bytes.fill(0); this.#fail(new Error("Beagle runtime input pipe failed")); }
      }, () => { bytes.fill(0); });
    });
  }

  stop(): Promise<void> {
    this.#fail(new Error("Beagle runtime stopped; an unfinished request may have an unknown outcome"));
    return this.#exit;
  }

  #receive(line: Buffer): void {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    const message = object(raw, ["type", "id", "ok", "value", "error", "protocol", "name", "version", "operations", "limits"]);
    if (message["type"] === "fatal") {
      const fatal = object(raw, ["type", "error"]);
      this.#fail(operationError(fatal["error"])); return;
    }
    if (!this.#ready) {
      const ready = parseReady(raw);
      clearTimeout(this.#readyTimer); this.#ready = true; this.#resolveReady(ready); return;
    }
    const response = object(raw, ["type", "id", "ok", "value", "error"]);
    const pending = this.#pending;
    if (response["type"] !== "response" || !pending?.sent || response["id"] !== pending.id) throw new Error("Unexpected Beagle runtime response");
    if (response["ok"] === true && Object.hasOwn(response, "value") && !Object.hasOwn(response, "error")) {
      const value = parseBeagleJson(response["value"], 2_000_000);
      this.#clearPending(); pending.resolve(value);
    } else if (response["ok"] === false && Object.hasOwn(response, "error") && !Object.hasOwn(response, "value")) {
      const error = operationError(response["error"]);
      this.#clearPending(); pending.reject(error);
    } else throw new Error("Invalid Beagle runtime response");
  }

  #clearPending(): void {
    if (!this.#pending) return;
    clearTimeout(this.#pending.timer); this.#pending.removeAbort(); this.#pending = undefined;
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#readyTimer);
    if (!this.#ready) this.#rejectReady(error);
    const pending = this.#pending; this.#clearPending(); pending?.reject(error);
    this.#decoder.reset();
    if (this.#exited) return;
    try { this.#child.stdin.end(); } catch { /* The forced kill still owns termination. */ }
    this.#killTimer = setTimeout(() => { try { this.#child.kill("SIGKILL"); } catch { /* The close event remains authoritative. */ } }, STOP_GRACE_MS);
    this.#killTimer.unref();
  }
}

/** The caller verifies executable provenance and supplies a filtered environment before spawning. */
export function createBeagleRuntime(executable: string, options: BeagleRuntimeOptions): BeagleRuntimeClient {
  return new BeagleRuntime(executable, options);
}
