import { createServer, isIP, Socket } from "node:net";

export interface RdpSocksProxyLease {
  readonly host: string;
  readonly port: number;
  readonly authentication?: { readonly username: Buffer; readonly password: Buffer };
  readonly signal: AbortSignal;
  isActive(): boolean;
  /** Releases copied authentication bytes; signal and isActive remain valid. */
  release(): void;
}
export interface RdpSocksTransport {
  readonly host: "127.0.0.1";
  readonly port: number;
  isActive(): boolean;
  close(): Promise<void>;
}

class RdpSocksError extends Error {}

const PREPARE_TIMEOUT_MS = 15_000;
const HELPER_TIMEOUT_MS = 30_000;
const UNAVAILABLE = "The selected SOCKS proxy is no longer available.";
const CONNECTION_FAILED = "The connection through the selected SOCKS proxy failed.";

/** SOCKS5 CONNECT (RFC 1928/1929); the original destination never reaches local DNS.
 * Only a completed proxy tunnel is exposed to the native helper, through one loopback connection.
 */
export async function createRdpSocksTransport(
  lease: RdpSocksProxyLease,
  target: { host: string; port: number },
  onFailure: (message: string) => void,
): Promise<RdpSocksTransport> {
  const proxy = new Socket();
  const listenerAbort = new AbortController();
  const server = createServer({ pauseOnConnect: true });
  let helper: Socket | undefined;
  let closed = false, ready = false, released = false, notified = false, listenStarted = false;
  let failure: Error | undefined;
  let closing: Promise<void> | undefined;
  let stoppingListener: Promise<void> | undefined;
  let helperTimer: ReturnType<typeof setTimeout> | undefined;
  const proxyClosed = new Promise<void>((resolve) => proxy.once("close", () => resolve()));
  let helperClosed: Promise<void> | undefined;
  const activeLease = (): boolean => {
    try { return !lease.signal.aborted && lease.isActive(); } catch { return false; }
  };
  const release = (): void => {
    if (released) return;
    released = true;
    if (Buffer.isBuffer(lease.authentication?.username)) lease.authentication.username.fill(0);
    if (Buffer.isBuffer(lease.authentication?.password)) lease.authentication.password.fill(0);
    lease.release();
  };
  const stopListener = (): Promise<void> => {
    if (!listenStarted) return Promise.resolve();
    return stoppingListener ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Abort also cancels an asynchronous listen that has not bound its port yet.
      listenerAbort.abort();
    });
  };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    clearTimeout(preparingTimer);
    clearTimeout(helperTimer);
    clearInterval(monitor);
    lease.signal.removeEventListener("abort", aborted);
    proxy.destroy(); helper?.destroy();
    // Cleanup must complete even if a lease owner's release implementation throws.
    let releaseFailed = false;
    try { release(); } catch { releaseFailed = true; }
    return closing = Promise.all([stopListener(), proxyClosed, helperClosed]).then(() => {
      if (releaseFailed) throw new RdpSocksError("Unable to release the SOCKS proxy lease.");
    });
  };
  const fail = (message: string): void => {
    if (closed) return;
    failure ??= new RdpSocksError(message);
    void close().catch(() => undefined);
    if (ready && !notified) {
      notified = true;
      try { onFailure(message); } catch { /* A callback cannot prevent socket cleanup. */ }
    }
  };
  const assertCurrent = (): void => {
    if (failure) throw failure;
    if (closed) throw new RdpSocksError("The SOCKS connection was canceled.");
    if (!activeLease()) throw new RdpSocksError(UNAVAILABLE);
  };
  const aborted = (): void => fail(UNAVAILABLE);
  const preparingTimer = setTimeout(() => fail("The SOCKS proxy connection timed out."), PREPARE_TIMEOUT_MS);
  preparingTimer.unref();
  const monitor = setInterval(() => { if (!activeLease()) fail(UNAVAILABLE); }, 250);
  monitor.unref();
  lease.signal.addEventListener("abort", aborted, { once: true });
  proxy.on("error", () => fail(CONNECTION_FAILED));
  proxy.on("close", () => fail(CONNECTION_FAILED));
  server.on("error", () => fail("Unable to open the local RDP proxy connection."));
  server.on("connection", (socket) => {
    if (closed || helper || !activeLease() || socket.remoteAddress !== "127.0.0.1") { socket.destroy(); return; }
    helper = socket;
    helperClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    clearTimeout(helperTimer);
    void stopListener();
    socket.setNoDelay(true);
    socket.on("error", () => fail(CONNECTION_FAILED));
    socket.on("close", () => fail("The local RDP proxy connection closed."));
    // Node pipes apply backpressure in both directions; unread handshake-adjacent bytes remain queued.
    proxy.pipe(socket); socket.pipe(proxy);
    proxy.resume(); socket.resume();
  });
  try {
    assertCurrent();
    validEndpoint(lease.host, lease.port);
    const request = connectRequest(target);
    const authentication = lease.authentication;
    if (authentication && (!Buffer.isBuffer(authentication.username) || !Buffer.isBuffer(authentication.password)
      || authentication.username.length < 1 || authentication.username.length > 255
      || authentication.password.length < 1 || authentication.password.length > 255)) {
      throw new RdpSocksError("SOCKS credentials must contain between 1 and 255 bytes each.");
    }
    await new Promise<void>((resolve, reject) => {
      const connected = (): void => { cleanup(); resolve(); };
      const stopped = (): void => { cleanup(); reject(failure ?? new RdpSocksError(CONNECTION_FAILED)); };
      const cleanup = (): void => { proxy.off("connect", connected); proxy.off("close", stopped); };
      proxy.once("connect", connected); proxy.once("close", stopped);
      proxy.connect({ host: lease.host, port: lease.port });
    });
    assertCurrent(); proxy.setNoDelay(true);
    const method = authentication ? 2 : 0;
    await write(proxy, Buffer.from([5, 1, method]));
    const selected = await read(proxy, 2);
    if (selected[0] !== 5 || selected[1] !== method) throw new RdpSocksError("The SOCKS proxy rejected the required authentication method.");
    if (authentication) {
      const packet = Buffer.concat([Buffer.from([1, authentication.username.length]), authentication.username,
        Buffer.from([authentication.password.length]), authentication.password]);
      try { await write(proxy, packet); } finally { packet.fill(0); }
      const authenticated = await read(proxy, 2);
      if (authenticated[0] !== 1 || authenticated[1] !== 0) throw new RdpSocksError("The SOCKS proxy rejected authentication.");
    }
    assertCurrent();
    await write(proxy, request);
    const response = await read(proxy, 4);
    if (response[0] !== 5 || response[2] !== 0) throw new RdpSocksError("The SOCKS proxy returned an invalid response.");
    if (response[1] !== 0) throw new RdpSocksError("The SOCKS proxy could not connect to the remote desktop.");
    if (response[3] === 1) await read(proxy, 6);
    else if (response[3] === 4) await read(proxy, 18);
    else if (response[3] === 3) {
      const length = (await read(proxy, 1))[0]!;
      if (!length) throw new RdpSocksError("The SOCKS proxy returned an invalid bound address.");
      await read(proxy, length + 2);
    } else throw new RdpSocksError("The SOCKS proxy returned an unsupported address type.");
    assertCurrent();
    release();
    assertCurrent();
    await new Promise<void>((resolve, reject) => {
      const listening = (): void => { cleanup(); resolve(); };
      const stopped = (): void => { cleanup(); reject(failure ?? new RdpSocksError("Unable to open the local RDP proxy connection.")); };
      const cleanup = (): void => { server.off("listening", listening); server.off("error", stopped); server.off("close", stopped); };
      server.once("listening", listening); server.once("error", stopped); server.once("close", stopped);
      listenStarted = true;
      server.listen({ host: "127.0.0.1", port: 0, exclusive: true, signal: listenerAbort.signal });
    });
    assertCurrent();
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1") throw new RdpSocksError("Unable to open a loopback RDP proxy connection.");
    clearTimeout(preparingTimer);
    ready = true;
    helperTimer = setTimeout(() => fail("The native RDP client did not connect to the SOCKS transport in time."), HELPER_TIMEOUT_MS);
    helperTimer.unref();
    return Object.freeze({ host: "127.0.0.1" as const, port: address.port,
      isActive: () => !closed && !proxy.destroyed && activeLease(), close });
  } catch (error) {
    await close().catch(() => undefined);
    // Socket failures may include endpoints; only locally constructed errors are returned.
    if (failure) throw failure;
    if (error instanceof RdpSocksError) throw error;
    throw new RdpSocksError(CONNECTION_FAILED);
  }
}

function write(socket: Socket, bytes: Buffer): Promise<void> {
  return new Promise((resolve, reject) => { socket.write(bytes, (error) => error ? reject(new RdpSocksError(CONNECTION_FAILED)) : resolve()); });
}

function read(socket: Socket, length: number): Promise<Buffer> {
  // All callers request at most 257 bytes; paused socket reads preserve any following RDP bytes.
  return new Promise((resolve, reject) => {
    const stopped = (): void => { cleanup(); reject(new RdpSocksError(CONNECTION_FAILED)); };
    const readable = (): void => {
      const bytes = socket.read(length) as Buffer | null;
      if (bytes !== null) {
        if (bytes.length !== length) { stopped(); return; }
        cleanup(); resolve(bytes);
      }
      else if (socket.destroyed || socket.readableEnded) stopped();
    };
    const cleanup = (): void => { socket.off("readable", readable); socket.off("end", stopped); socket.off("close", stopped); };
    socket.on("readable", readable); socket.once("end", stopped); socket.once("close", stopped);
    readable();
  });
}

function validEndpoint(host: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || typeof host !== "string" || !host || host.length > 253
    || host.includes("%") || (isIP(host) === 0 && !/^[a-z0-9_][a-z0-9._-]*$/iu.test(host))) throw new RdpSocksError("Invalid SOCKS endpoint.");
}

function connectRequest(target: { host: string; port: number }): Buffer {
  try { validEndpoint(target.host, target.port); } catch { throw new RdpSocksError("Invalid RDP destination for the SOCKS proxy."); }
  const family = isIP(target.host);
  let address: Buffer;
  if (family === 4) address = Buffer.from([1, ...target.host.split(".").map(Number)]);
  else if (family === 6) address = Buffer.concat([Buffer.from([4]), ipv6Bytes(target.host)]);
  else {
    const name = Buffer.from(target.host, "utf8");
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  const port = Buffer.alloc(2); port.writeUInt16BE(target.port);
  return Buffer.concat([Buffer.from([5, 1, 0]), address, port]);
}

function ipv6Bytes(host: string): Buffer {
  let source = host;
  if (source.includes(".")) {
    const last = source.lastIndexOf(":"), parts = source.slice(last + 1).split(".").map(Number);
    source = `${source.slice(0, last)}:${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
  }
  const [left = "", right] = source.split("::");
  const before = left ? left.split(":") : [], after = right ? right.split(":") : [];
  const words = right === undefined ? before : [...before, ...Array<string>(8 - before.length - after.length).fill("0"), ...after];
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(Number.parseInt(word, 16), index * 2));
  return bytes;
}
