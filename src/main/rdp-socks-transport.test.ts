// @vitest-environment node
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRdpSocksTransport, type RdpSocksProxyLease, type RdpSocksTransport } from "./rdp-socks-transport.js";

const sockets = new Set<Socket>();
const servers: Server[] = [];
const transports: RdpSocksTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close().catch(() => undefined)));
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  vi.useRealTimers();
});

interface ProxyOptions {
  readonly method?: number;
  readonly methodVersion?: number;
  readonly authStatus?: number;
  readonly authVersion?: number;
  readonly reply?: Buffer;
  readonly fragment?: boolean;
  readonly stall?: "greeting" | "authentication" | "connect";
  readonly initialData?: Buffer;
  readonly truncatedGreeting?: boolean;
}
async function fakeProxy(options: ProxyOptions = {}) {
  const observed: { greeting?: Buffer; username?: Buffer; password?: Buffer; request?: Buffer; socket?: Socket } = {};
  const server = createServer((socket) => {
    sockets.add(socket); observed.socket = socket;
    socket.on("error", () => undefined);
    void (async () => {
      const header = await read(socket, 2);
      observed.greeting = Buffer.concat([header, await read(socket, header[1]!)]);
      if (options.stall === "greeting") return;
      if (options.truncatedGreeting) { socket.end(Buffer.from([5])); return; }
      const method = options.method ?? 0;
      await send(socket, Buffer.from([options.methodVersion ?? 5, method]), options.fragment);
      if (method === 2) {
        const auth = await read(socket, 2);
        observed.username = await read(socket, auth[1]!);
        const length = (await read(socket, 1))[0]!;
        observed.password = await read(socket, length);
        if (options.stall === "authentication") return;
        await send(socket, Buffer.from([options.authVersion ?? 1, options.authStatus ?? 0]), options.fragment);
      }
      const request = await read(socket, 4);
      let address: Buffer;
      if (request[3] === 1) address = await read(socket, 4);
      else if (request[3] === 4) address = await read(socket, 16);
      else { const length = await read(socket, 1); address = Buffer.concat([length, await read(socket, length[0]!)]); }
      observed.request = Buffer.concat([request, address, await read(socket, 2)]);
      if (options.stall === "connect") return;
      const reply = options.reply ?? Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]);
      await send(socket, Buffer.concat([reply, options.initialData ?? Buffer.alloc(0)]), options.fragment);
      socket.pipe(socket);
    })().catch(() => { socket.destroy(); });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake proxy did not listen");
  const controller = new AbortController();
  let active = true;
  const authentication = options.method === 2 ? { username: Buffer.from("fixture-user"), password: Buffer.from("fixture-password") } : undefined;
  const release = vi.fn(() => { authentication?.username.fill(0); authentication?.password.fill(0); });
  const lease: RdpSocksProxyLease = { host: "127.0.0.1", port: address.port, signal: controller.signal,
    ...(authentication ? { authentication } : {}), release, isActive: () => active };
  return { observed, lease, controller, release, inactive: () => { active = false; } };
}
async function open(proxy: Awaited<ReturnType<typeof fakeProxy>>, target = { host: "private-does-not-resolve.invalid", port: 3389 }) {
  const failure = vi.fn();
  const transport = await createRdpSocksTransport(proxy.lease, target, failure);
  transports.push(transport);
  return { transport, failure };
}
async function helper(transport: RdpSocksTransport): Promise<Socket> {
  const socket = createConnection(transport.port, transport.host); sockets.add(socket);
  socket.on("error", () => undefined);
  await once(socket, "connect");
  return socket;
}
async function read(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stop = (): void => { cleanup(); reject(new Error("Fixture socket closed")); };
    const available = (): void => {
      const bytes = socket.read(length) as Buffer | null;
      if (bytes !== null) { cleanup(); resolve(Buffer.from(bytes)); }
      else if (socket.destroyed || socket.readableEnded) stop();
    };
    const cleanup = (): void => { socket.off("readable", available); socket.off("close", stop); socket.off("end", stop); };
    socket.on("readable", available); socket.once("close", stop); socket.once("end", stop); available();
  });
}
async function send(socket: Socket, bytes: Buffer, fragmented = false): Promise<void> {
  if (!fragmented) { socket.write(bytes); return; }
  for (const byte of bytes) { socket.write(Buffer.from([byte])); await delay(1); }
}
async function spinUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture condition timed out"); await nextTurn(); }
}

describe("main-owned RDP SOCKS transport", () => {
  it("negotiates no-auth and proxy DNS before exposing a one-use loopback relay", async () => {
    const proxy = await fakeProxy({ initialData: Buffer.from("remote-first") });
    const { transport, failure } = await open(proxy);
    expect(proxy.observed.greeting).toEqual(Buffer.from([5, 1, 0]));
    const name = Buffer.from("private-does-not-resolve.invalid");
    expect(proxy.observed.request).toEqual(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([13, 61])]));
    expect(transport.host).toBe("127.0.0.1"); expect(transport.isActive()).toBe(true);
    expect(proxy.release).toHaveBeenCalledTimes(1);
    const socket = await helper(transport);
    expect(await read(socket, 12)).toEqual(Buffer.from("remote-first"));
    const payload = Buffer.alloc(4 * 1024 * 1024);
    for (let index = 0; index < payload.length; index++) payload[index] = index % 251;
    socket.write(payload);
    expect(createHash("sha256").update(await read(socket, payload.length)).digest("hex"))
      .toBe(createHash("sha256").update(payload).digest("hex"));
    const extra = createConnection(transport.port, transport.host); sockets.add(extra);
    extra.on("error", () => undefined);
    await new Promise<void>((resolve) => extra.once("close", () => resolve()));
    expect(transport.isActive()).toBe(true);
    await transport.close(); await transport.close();
    expect(transport.isActive()).toBe(false); expect(failure).not.toHaveBeenCalled();
    expect(proxy.release).toHaveBeenCalledTimes(1);
  });
  it("authenticates exact bytes through fragmented replies and wipes credentials after the handshake", async () => {
    const proxy = await fakeProxy({ method: 2, fragment: true, reply: Buffer.from([5, 0, 0, 3, 3, 97, 98, 99, 0, 80]) });
    const { transport } = await open(proxy);
    expect(proxy.observed.greeting).toEqual(Buffer.from([5, 1, 2]));
    expect(proxy.observed.username).toEqual(Buffer.from("fixture-user"));
    expect(proxy.observed.password).toEqual(Buffer.from("fixture-password"));
    expect(proxy.lease.authentication!.username.every((byte) => byte === 0)).toBe(true);
    expect(proxy.lease.authentication!.password.every((byte) => byte === 0)).toBe(true);
    expect(proxy.release).toHaveBeenCalledTimes(1);
    const socket = await helper(transport); socket.write("hello");
    expect(await read(socket, 5)).toEqual(Buffer.from("hello"));
  });
  it.each([
    ["192.0.2.9", "01c0000209"], ["2001:db8::1", "0420010db8000000000000000000000001"],
    ["::1", "0400000000000000000000000000000001"], ["::ffff:192.0.2.1", "0400000000000000000000ffffc0000201"],
  ])("uses the SOCKS IP address type for %s", async (host, addressHex) => {
    const proxy = await fakeProxy({ reply: Buffer.concat([Buffer.from([5, 0, 0, 4]), Buffer.alloc(18)]) });
    await open(proxy, { host, port: 3390 });
    expect(proxy.observed.request).toEqual(Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from(addressHex, "hex"), Buffer.from([13, 62])]));
  });
  it.each([
    [{ methodVersion: 4 }, "authentication method"], [{ method: 255 }, "authentication method"],
    [{ method: 2, authStatus: 1 }, "rejected authentication"], [{ method: 2, authVersion: 5 }, "rejected authentication"],
    [{ reply: Buffer.from([4, 0, 0, 1]) }, "invalid response"], [{ reply: Buffer.from([5, 0, 1, 1]) }, "invalid response"],
    [{ reply: Buffer.from([5, 5, 0, 1]) }, "could not connect"], [{ reply: Buffer.from([5, 0, 0, 2]) }, "address type"],
    [{ reply: Buffer.from([5, 0, 0, 3, 0]) }, "bound address"], [{ truncatedGreeting: true }, "failed"],
  ] as const)("rejects a proxy failure before returning a listener: %j", async (options, message) => {
    const proxy = await fakeProxy(options);
    const failure = vi.fn();
    await expect(createRdpSocksTransport(proxy.lease, { host: "target.invalid", port: 3389 }, failure)).rejects.toThrow(message);
    expect(proxy.release).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
    if (proxy.lease.authentication) expect(proxy.lease.authentication.password.every((byte) => byte === 0)).toBe(true);
  });
  it("never accepts a no-auth downgrade when credentials were supplied", async () => {
    const proxy = await fakeProxy();
    const authentication = { username: Buffer.from("name"), password: Buffer.from("password") };
    await expect(createRdpSocksTransport({ ...proxy.lease, authentication }, { host: "host", port: 3389 }, vi.fn())).rejects.toThrow("authentication method");
    expect(authentication.password.every((byte) => byte === 0)).toBe(true);
    expect(proxy.observed.request).toBeUndefined();
  });
  it("does not attempt authentication when the lease selected no-auth", async () => {
    const proxy = await fakeProxy({ method: 2 });
    const { authentication: _authentication, ...lease } = proxy.lease;
    await expect(createRdpSocksTransport(lease, { host: "host", port: 3389 }, vi.fn())).rejects.toThrow("authentication method");
    expect(proxy.observed.username).toBeUndefined();
    expect(proxy.observed.request).toBeUndefined();
  });
  it.each(["aborted", "inactive"])("rejects an already %s lease without opening a connection", async (reason) => {
    const proxy = await fakeProxy({ method: 2 });
    if (reason === "aborted") proxy.controller.abort(); else proxy.inactive();
    await expect(createRdpSocksTransport(proxy.lease, { host: "host", port: 3389 }, vi.fn())).rejects.toThrow("no longer available");
    expect(proxy.release).toHaveBeenCalledTimes(1);
    expect(proxy.observed.socket).toBeUndefined();
    expect(proxy.lease.authentication!.password.every((byte) => byte === 0)).toBe(true);
  });
  it.each(["greeting", "authentication", "connect"] as const)("cancels a pending %s handshake and releases its lease", async (stage) => {
    const proxy = await fakeProxy({ method: 2, stall: stage });
    const failure = vi.fn();
    const pending = createRdpSocksTransport(proxy.lease, { host: "host", port: 3389 }, failure);
    const rejected = expect(pending).rejects.toThrow("no longer available");
    await spinUntil(() => stage === "greeting" ? Boolean(proxy.observed.greeting) : stage === "authentication" ? Boolean(proxy.observed.password) : Boolean(proxy.observed.request));
    proxy.controller.abort(); await rejected;
    expect(proxy.release).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
  });
  it("rejects an abort during credential release before a listener is exposed", async () => {
    const proxy = await fakeProxy({ method: 2 });
    const release = vi.fn(() => { proxy.release(); proxy.controller.abort(); });
    await expect(createRdpSocksTransport({ ...proxy.lease, release }, { host: "host", port: 3389 }, vi.fn())).rejects.toThrow("no longer available");
    expect(release).toHaveBeenCalledTimes(1);
  });
  it.each(["abort", "inactive", "remote-close", "helper-close"])("closes a ready relay and reports %s once", async (reason) => {
    const proxy = await fakeProxy(); const { transport, failure } = await open(proxy);
    const socket = await helper(transport);
    if (reason === "abort") proxy.controller.abort();
    else if (reason === "inactive") proxy.inactive();
    else if (reason === "remote-close") proxy.observed.socket!.destroy();
    else socket.destroy();
    await spinUntil(() => failure.mock.calls.length > 0);
    await transport.close(); proxy.controller.abort();
    expect(failure).toHaveBeenCalledTimes(1); expect(transport.isActive()).toBe(false);
    expect(proxy.release).toHaveBeenCalledTimes(1);
  });
  it("bounds the total handshake wait", async () => {
    const proxy = await fakeProxy({ stall: "greeting" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const pending = createRdpSocksTransport(proxy.lease, { host: "host", port: 3389 }, vi.fn());
    const rejected = expect(pending).rejects.toThrow("timed out");
    await spinUntil(() => Boolean(proxy.observed.greeting));
    await vi.advanceTimersByTimeAsync(15_001); await rejected;
    expect(proxy.release).toHaveBeenCalledTimes(1);
  });
  it("bounds helper arrival and clears timers on explicit close", async () => {
    const proxy = await fakeProxy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { transport, failure } = await open(proxy);
    await vi.advanceTimersByTimeAsync(30_001);
    await transport.close();
    expect(failure).toHaveBeenCalledTimes(1); expect(failure.mock.calls[0]![0]).toContain("did not connect");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("validates endpoints and credential sizes before making any proxy connection", async () => {
    const proxy = await fakeProxy();
    for (const target of [{ host: "rdp://host", port: 3389 }, { host: "host", port: 0 }, { host: "fe80::1%en0", port: 3389 }]) {
      await expect(createRdpSocksTransport(proxy.lease, target, vi.fn())).rejects.toThrow("Invalid RDP");
    }
    await expect(createRdpSocksTransport({ ...proxy.lease, authentication: { username: Buffer.alloc(256), password: Buffer.from("p") } },
      { host: "host", port: 3389 }, vi.fn())).rejects.toThrow("255 bytes");
    expect(proxy.observed.socket).toBeUndefined();
  });
  it("fails a refused proxy connection without attempting the direct destination", async () => {
    const proxy = await fakeProxy();
    const proxyServer = servers.at(-1)!;
    let directConnections = 0;
    const destination = createServer((socket) => { directConnections++; sockets.add(socket); socket.destroy(); });
    servers.push(destination); destination.listen(0, "127.0.0.1"); await once(destination, "listening");
    const address = destination.address();
    if (!address || typeof address === "string") throw new Error("Destination fixture did not listen");
    await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
    await expect(createRdpSocksTransport(proxy.lease, { host: "127.0.0.1", port: address.port }, vi.fn())).rejects.toThrow("failed");
    expect(directConnections).toBe(0); expect(proxy.release).toHaveBeenCalledTimes(1);
  });
  it("sanitizes lease cleanup failures while still wiping credentials and closing the tunnel", async () => {
    const proxy = await fakeProxy({ method: 2 });
    const release = vi.fn(() => { throw new Error("The SOCKS secret must not appear in an error"); });
    await expect(createRdpSocksTransport({ ...proxy.lease, release }, { host: "host", port: 3389 }, vi.fn())).rejects.toThrow(
      "The connection through the selected SOCKS proxy failed.");
    expect(proxy.lease.authentication!.password.every((byte) => byte === 0)).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });
});
