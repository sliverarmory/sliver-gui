// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BEAGLE_RUNTIME_MAX_REQUEST_BYTES, BEAGLE_RUNTIME_MAX_RESPONSE_BYTES, BEAGLE_RUNTIME_OPERATIONS,
  BEAGLE_RUNTIME_REQUIRED_OPERATIONS,
  type BeagleRuntimeCommand,
} from "../shared/beagle-runtime-contracts.js";
import { BeagleRuntimeOperationError, createBeagleRuntime, type BeagleRuntimeClient } from "./beagle-runtime.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const clients: { client: BeagleRuntimeClient; child: EventEmitter }[] = [];
afterEach(async () => {
  for (const { client, child } of clients.splice(0)) { const stopped = client.stop(); child.emit("close", 0); await stopped; }
  vi.useRealTimers(); vi.clearAllMocks();
});

const ready = {
  type: "ready", name: "beagle", protocol: 1, version: "0.1.7", operations: [...BEAGLE_RUNTIME_OPERATIONS],
  limits: { requestBytes: BEAGLE_RUNTIME_MAX_REQUEST_BYTES, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES },
};
const wire = (value: unknown): Buffer => Buffer.from(`${JSON.stringify(value)}\n`, "utf8");

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
  });
  const written: Buffer[] = [];
  child.stdin.on("data", (bytes: Buffer) => written.push(Buffer.from(bytes)));
  vi.mocked(spawn).mockReturnValueOnce(child as unknown as ChildProcessWithoutNullStreams);
  const client = createBeagleRuntime("/verified/beagle", { cwd: "/private/project", env: { PATH: "/usr/bin" } });
  clients.push({ client, child });
  const emit = (value: unknown): void => { child.stdout.emit("data", wire(value)); };
  const request = async (command: BeagleRuntimeCommand = { type: "stats" }, timeout = 1000) => {
    const result = client.request(command, { timeout });
    // Let ready's continuation write the request to the private pipe.
    await Promise.resolve();
    return { result, sent: JSON.parse(written.at(-1)!.toString("utf8")) as { id: number; command: BeagleRuntimeCommand } };
  };
  return { child, client, written, emit, request };
}

describe("Beagle persistent runtime", () => {
  it("keeps project paths, queries, and parameter data out of executable arguments and supports fragmented UTF-8", async () => {
    const { child, client, emit, written } = fixture();
    const command = { type: "query" as const, cypher: "RETURN $secret;\n-- synthetic", parameters: { secret: "synthetic; $(echo data)" } };
    const result = client.request(command, { timeout: 1000 });
    const handshake = wire(ready);
    for (const byte of handshake) child.stdout.emit("data", Buffer.from([byte]));
    await expect(client.ready).resolves.toMatchObject({ name: "beagle", protocol: 1 });
    await Promise.resolve();
    expect(spawn).toHaveBeenCalledExactlyOnceWith("/verified/beagle", ["helper-stdio"], {
      cwd: "/private/project", env: { PATH: "/usr/bin" }, stdio: "pipe", shell: false, windowsHide: true,
    });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0]!.toString())).toEqual({ id: 1, command });
    const response = wire({ type: "response", id: 1, ok: true, value: { greeting: "héllo 🙂" } });
    for (const byte of response) child.stdout.emit("data", Buffer.from([byte]));
    await expect(result).resolves.toEqual({ greeting: "héllo 🙂" });
    const next = client.request({ type: "open", database: "/private/project/graph.db", queryTimeoutMs: 30_000 }, { timeout: 1000 });
    await Promise.resolve();
    expect(JSON.parse(written[1]!.toString())).toEqual({ id: 2, command: { type: "open", database: "/private/project/graph.db", queryTimeoutMs: 30_000 } });
    emit({ type: "response", id: 2, ok: true, value: null });
    await expect(next).resolves.toBeNull();
  });

  it.each([
    { protocol: 2 }, { name: "another-helper" }, { version: "1.0.0" },
    { operations: BEAGLE_RUNTIME_OPERATIONS.slice(1) },
    { operations: [...BEAGLE_RUNTIME_OPERATIONS.slice(1), "stats"] },
    { limits: { requestBytes: 1, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES } },
    { limits: { requestBytes: BEAGLE_RUNTIME_MAX_REQUEST_BYTES, responseBytes: BEAGLE_RUNTIME_MAX_RESPONSE_BYTES + 1 } },
  ])("rejects incompatible readiness %j", async (change) => {
    const { client, emit } = fixture();
    const result = expect(client.ready).rejects.toThrow(/protocol/u);
    emit({ ...ready, ...change });
    await result;
    expect(client.closed).toBe(true);
  });

  it("times out readiness and never writes a request before the handshake", async () => {
    vi.useFakeTimers();
    const { client, child, written } = fixture();
    const startup = expect(client.ready).rejects.toThrow(/readiness timed out/u);
    const pending = expect(client.request({ type: "analyze" }, { timeout: 10_000 })).rejects.toThrow(/readiness timed out/u);
    await vi.advanceTimersByTimeAsync(5000);
    await startup; await pending;
    expect(written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("preserves healthy clients after structured operation errors", async () => {
    const { client, emit, request } = fixture(); emit(ready); await client.ready;
    const first = await request({ type: "savedQueryInfo", id: "missing" });
    const failed = expect(first.result).rejects.toEqual(new BeagleRuntimeOperationError("unknown-query", "No such saved query"));
    emit({ type: "response", id: first.sent.id, ok: false, error: { code: "unknown-query", message: "No such saved query" } });
    await failed;
    expect(client.closed).toBe(false);
    const second = await request();
    emit({ type: "response", id: second.sent.id, ok: true, value: { nodes: 2 } });
    await expect(second.result).resolves.toEqual({ nodes: 2 });
  });

  it("rejects concurrent requests without interrupting the active operation", async () => {
    const { client, emit, request, written } = fixture(); emit(ready); await client.ready;
    const first = await request();
    await expect(client.request({ type: "analyze" }, { timeout: 1000 })).rejects.toThrow(/active request/u);
    expect(written).toHaveLength(1);
    emit({ type: "response", id: first.sent.id, ok: true, value: {} });
    await expect(first.result).resolves.toEqual({});
    expect(client.closed).toBe(false);
  });

  it.each([0, 2, "1", null])("kills mismatched response identity %j", async (id) => {
    const { client, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request(); const failed = expect(pending.result).rejects.toThrow(/protocol data/u);
    emit({ type: "response", id, ok: true, value: {} });
    await failed; expect(client.closed).toBe(true);
  });

  it("rejects coalesced duplicate responses before a subsequent request can use the client", async () => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request();
    const reply = wire({ type: "response", id: pending.sent.id, ok: true, value: {} });
    child.stdout.emit("data", Buffer.concat([reply, reply]));
    await expect(pending.result).resolves.toEqual({});
    expect(client.closed).toBe(true);
    await expect(client.request({ type: "tag", objectid: "a", tag: "owned", enabled: true }, { timeout: 1000 })).rejects.toThrow(/closed/u);
  });

  it("rejects an unsolicited response coalesced with readiness before the request is sent", async () => {
    const { client, child, written } = fixture();
    const failed = expect(client.request({ type: "stats" }, { timeout: 1000 })).rejects.toThrow(/protocol data/u);
    child.stdout.emit("data", Buffer.concat([wire(ready), wire({ type: "response", id: 1, ok: true, value: {} })]));
    await failed; expect(written).toHaveLength(0);
  });

  it("bounds response bytes while reading fragments, including the required newline", async () => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request(); const failed = expect(pending.result).rejects.toThrow(/oversized/u);
    const fragment = Buffer.alloc(64 * 1024, 32);
    for (let index = 0; index < BEAGLE_RUNTIME_MAX_RESPONSE_BYTES / fragment.length; index++) child.stdout.emit("data", fragment);
    await failed; expect(client.closed).toBe(true);
  });

  it("rejects oversized requests without sending partial data", async () => {
    const { client, emit, written } = fixture(); emit(ready); await client.ready;
    await expect(client.request({ type: "query", cypher: "x".repeat(BEAGLE_RUNTIME_MAX_REQUEST_BYTES), parameters: {} }, { timeout: 1000 })).rejects.toThrow(/1 MiB/u);
    expect(written).toHaveLength(0);
  });

  it("assembles a successful response across many buffer pages and uneven pipe fragments", async () => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request();
    const value = { rows: Array.from({ length: 12 }, (_, index) => ({ index, text: "é".repeat(32_768) })) };
    const bytes = wire({ type: "response", id: pending.sent.id, ok: true, value });
    for (let offset = 0; offset < bytes.length; offset += 8191) child.stdout.emit("data", bytes.subarray(offset, offset + 8191));
    await expect(pending.result).resolves.toEqual(value);
    expect(client.closed).toBe(false);
  });

  it.each([Buffer.from('{"type":"response"}\n'), Buffer.from([0xff, 10]), wire({ type: "response", id: 1, ok: true, value: null, error: {} })])("rejects malformed output", async (output) => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request(); const failed = expect(pending.result).rejects.toThrow(/protocol data/u);
    child.stdout.emit("data", output);
    await failed; expect(client.closed).toBe(true);
  });

  it("rejects truncated output on process exit", async () => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request(); const failed = expect(pending.result).rejects.toThrow(/truncated/u);
    child.stdout.emit("data", Buffer.from('{"type":"response","id":1'));
    child.emit("close", 0);
    await failed; expect(client.closed).toBe(true);
  });

  it("rejects pending work immediately when stdout closes before the process exits", async () => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request(); const failed = expect(pending.result).rejects.toThrow(/output pipe closed/u);
    child.stdout.emit("end");
    await failed; expect(client.closed).toBe(true);
  });

  it.each(["timeout", "abort"])("retires a mutation after %s and only a new client accepts later work", async (reason) => {
    vi.useFakeTimers();
    const first = fixture(); first.emit(ready); await first.client.ready;
    const abort = new AbortController();
    const failed = expect(first.client.request({ type: "tag", objectid: "node", tag: "owned", enabled: true }, { timeout: 500, signal: abort.signal })).rejects.toThrow(/outcome may be unknown/u);
    await Promise.resolve();
    if (reason === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(500);
    await failed;
    first.emit({ type: "response", id: 1, ok: true, value: {} });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(first.written).toHaveLength(1);
    const second = fixture(); second.emit(ready); await second.client.ready;
    const pending = await second.request(); second.emit({ type: "response", id: pending.sent.id, ok: true, value: {} });
    await expect(pending.result).resolves.toEqual({});
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(second.written.map((bytes) => JSON.parse(bytes.toString()).command.type)).toEqual(["stats"]);
  });

  it("cancels an already-aborted request before writing it", async () => {
    const { client, emit, written } = fixture(); emit(ready); await client.ready;
    const abort = new AbortController(); abort.abort();
    await expect(client.request({ type: "analyze" }, { timeout: 1000, signal: abort.signal })).rejects.toThrow(/canceled/u);
    expect(written).toHaveLength(0); expect(client.closed).toBe(false);
  });

  it("cancels unsent startup work without poisoning the following request", async () => {
    const { client, emit, written, request } = fixture();
    const abort = new AbortController();
    const failed = expect(client.request({ type: "analyze" }, { timeout: 1000, signal: abort.signal })).rejects.toThrow(/before it was sent/u);
    abort.abort(); await failed;
    emit(ready); await client.ready;
    expect(written).toHaveLength(0); expect(client.closed).toBe(false);
    const pending = await request(); emit({ type: "response", id: pending.sent.id, ok: true, value: {} });
    await expect(pending.result).resolves.toEqual({});
  });

  it("keeps legacy protocol1 helpers usable while gating additive operations before sending", async () => {
    const { client, emit, written, request } = fixture();
    emit({ ...ready, operations: [...BEAGLE_RUNTIME_REQUIRED_OPERATIONS] });
    expect((await client.ready).operations).toEqual(BEAGLE_RUNTIME_REQUIRED_OPERATIONS);
    await expect(client.request({ type: "backup", path: "/private/tmp/backup.db" }, { timeout: 1000 })).rejects.toThrow(/does not support/u);
    expect(written).toHaveLength(0); expect(client.closed).toBe(false);
    const pending = await request(); emit({ type: "response", id: pending.sent.id, ok: true, value: {} });
    await expect(pending.result).resolves.toEqual({});
  });

  it.each(["error", "pipe", "fatal", "exit"])("rejects pending work on %s without exposing process diagnostics", async (kind) => {
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request();
    const failed = pending.result.catch((error: unknown) => error);
    child.stderr.write("synthetic secret stderr");
    if (kind === "error") child.emit("error", new Error("synthetic secret spawn arguments"));
    if (kind === "pipe") child.stdin.emit("error", new Error("synthetic secret pipe data"));
    if (kind === "fatal") emit({ type: "fatal", error: { code: "database-unavailable", message: "The database is unavailable" } });
    if (kind === "exit") child.emit("close", 1);
    const error = await failed;
    expect(error).toBeInstanceOf(Error); expect((error as Error).message).not.toContain("synthetic secret");
    expect(client.closed).toBe(true);
  });

  it("waits for actual exit during stop and force-kills after the grace period", async () => {
    vi.useFakeTimers();
    const { client, child, emit } = fixture(); emit(ready); await client.ready;
    const resolved = vi.fn(); const stopped = client.stop().then(resolved);
    expect(child.stdin.writableEnded).toBe(true);
    expect(client.closed).toBe(true); expect(resolved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL"); expect(resolved).not.toHaveBeenCalled();
    child.emit("close", 0); await stopped;
    expect(resolved).toHaveBeenCalledOnce();
  });

  it("lets a shutdown request finish, then cancels forced termination after graceful exit", async () => {
    vi.useFakeTimers();
    const { client, child, emit, request } = fixture(); emit(ready); await client.ready;
    const pending = await request({ type: "shutdown" });
    emit({ type: "response", id: pending.sent.id, ok: true, value: null });
    await expect(pending.result).resolves.toBeNull();
    const stopped = client.stop(); child.emit("close", 0); await stopped;
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.kill).not.toHaveBeenCalled();
  });
});
