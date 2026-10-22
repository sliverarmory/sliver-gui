// @vitest-environment node

import { BehaviorSubject, Subject } from "rxjs";
import type {
  LocalForwardState,
  PortForward,
  ReversePortForward,
  ReversePortForwardInfo,
  Socks5Proxy,
} from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkForwardingController } from "./network-forwarding-controller.js";

const session = {
  mode: "session" as const,
  id: "session-1",
  backendEpoch: 1,
  domainRevision: 2,
  fingerprint: "a".repeat(64),
};
const listening: LocalForwardState = {
  status: "listening",
  activeConnections: 1,
  totalConnections: 3,
  bytesToTarget: 1024,
  bytesFromTarget: 2048,
};

afterEach(() => vi.useRealTimers());

describe("NetworkForwardingController", () => {
  async function managedSocks(bind = { host: "127.0.0.1", port: 1080 }, authentication: { username: string; password: string } | null = { username: "private-proxy-user", password: "private-proxy-password" }) {
    const state = new BehaviorSubject<LocalForwardState>(listening);
    const proxy = { ...localSocksProxy(state), bind, get state() { return state.value; } };
    const client = forwardingClient({ socks: proxy });
    const controller = new NetworkForwardingController(client, Date.now, vi.fn());
    await controller.startSocks5Proxy({ session, bind, ...(authentication ? { authentication } : {}),
      connectTimeoutSeconds: 30, closeTimeoutSeconds: 5, maxConnections: 64, maxBufferedBytesPerConnection: 1_048_576 });
    return { state, proxy, client, controller };
  }

  it("lends independent credential copies only inside main and wipes each released copy", async () => {
    const { controller, proxy } = await managedSocks();
    try {
      const first = controller.leaseRdpProxy(proxy.id), second = controller.leaseRdpProxy(proxy.id);
      expect(first.authentication?.username.toString()).toBe("private-proxy-user");
      expect(first.authentication?.password.toString()).toBe("private-proxy-password");
      expect(first.authentication?.password).not.toBe(second.authentication?.password);
      const summaries = JSON.stringify({ rdp: controller.rdpProxies(), inventory: await controller.list({ reverseTargets: [] }) });
      expect(summaries).not.toContain("private-proxy-user");
      expect(summaries).not.toContain("private-proxy-password");
      expect(summaries).not.toContain('"type":"Buffer"');
      first.release(); first.release();
      expect(first.authentication?.username.every((byte) => byte === 0)).toBe(true);
      expect(first.authentication?.password.every((byte) => byte === 0)).toBe(true);
      expect(second.authentication?.password.toString()).toBe("private-proxy-password");
      expect(first.isActive()).toBe(true); // Releasing credentials must not close the shared proxy.
      const third = controller.leaseRdpProxy(proxy.id);
      expect(third.authentication?.password.toString()).toBe("private-proxy-password");
      second.release(); third.release();
    } finally { controller.dispose(); }
  });

  it.each(["stop", "closed", "failed", "complete", "dispose", "removed"] as const)("aborts borrowed routes and wipes credentials on %s", async (action) => {
    const { controller, proxy, state, client } = await managedSocks();
    const lease = controller.leaseRdpProxy(proxy.id), aborted = vi.fn();
    lease.signal.addEventListener("abort", aborted);
    try {
      if (action === "stop") {
        client.stopSocks5Proxy.mockImplementation(async () => { expect(lease.signal.aborted).toBe(true); });
        await controller.stopSocks5Proxy(proxy.id);
      } else if (action === "closed" || action === "failed") state.next({ ...listening, status: action });
      else if (action === "complete") state.complete();
      else if (action === "dispose") controller.dispose();
      else { client.listSocks5Proxies.mockReturnValue([]); expect(controller.rdpProxies()).toEqual([]); }
      expect(lease.signal.aborted).toBe(true);
      expect(aborted).toHaveBeenCalledOnce();
      expect(lease.isActive()).toBe(false);
      expect(lease.authentication?.username.every((byte) => byte === 0)).toBe(true);
      expect(lease.authentication?.password.every((byte) => byte === 0)).toBe(true);
      expect(() => controller.leaseRdpProxy(proxy.id)).toThrow();
      expect(controller.rdpProxies()).toEqual([]);
    } finally { controller.dispose(); }
    expect(aborted).toHaveBeenCalledOnce();
  });

  it.each([["0.0.0.0", "127.0.0.1"], ["::", "::1"], ["127.0.0.1", "127.0.0.1"], ["::1", "::1"]])("normalizes managed numeric bind %s to %s without DNS", async (host, expected) => {
    const { controller, proxy } = await managedSocks({ host, port: 49152 }, null);
    try {
      const lease = controller.leaseRdpProxy(proxy.id);
      expect(lease.host).toBe(expected); expect(lease.port).toBe(49152);
      expect(lease.authentication).toBeUndefined();
      lease.release();
    } finally { controller.dispose(); }
  });

  it("rejects unowned proxies and hostnames even when they appear in inventory", async () => {
    const proxy = localSocksProxy(new BehaviorSubject<LocalForwardState>(listening));
    const controller = new NetworkForwardingController(forwardingClient({ socks: proxy }), Date.now, vi.fn());
    try {
      expect((await controller.list({ reverseTargets: [] })).socks5Proxies).toHaveLength(1);
      expect(controller.rdpProxies()).toEqual([]);
      expect(() => controller.leaseRdpProxy(proxy.id)).toThrow(/no longer available/u);
    } finally { controller.dispose(); }
    const managed = await managedSocks({ host: "localhost", port: 1080 });
    try { expect(() => managed.controller.leaseRdpProxy(managed.proxy.id)).toThrow(/IP address/u); }
    finally { managed.controller.dispose(); }
  });

  it("stops lending while a proxy closes and detects an obsolete handle", async () => {
    const { controller, proxy, state, client } = await managedSocks();
    try {
      const lease = controller.leaseRdpProxy(proxy.id);
      state.next({ ...listening, status: "closing" });
      expect(lease.isActive()).toBe(false);
      expect(() => controller.leaseRdpProxy(proxy.id)).toThrow(/no longer available/u);
      state.next(listening);
      client.listSocks5Proxies.mockReturnValue([{ ...proxy }]);
      expect(lease.isActive()).toBe(false);
      lease.release();
    } finally { controller.dispose(); }
  });

  it("keeps rc4 handles in main and exposes serializable summaries without SOCKS credentials", async () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const portState = new BehaviorSubject<LocalForwardState>(listening);
    const socksState = new BehaviorSubject<LocalForwardState>(listening);
    const port = localPortForward(portState);
    const socks = localSocksProxy(socksState);
    const client = forwardingClient({ port, socks });
    const controller = new NetworkForwardingController(client, () => 1_700_000_000_000, changed);

    const startedPort = await controller.startPortForward({
      session,
      bind: { host: "127.0.0.1", port: 0 },
      destination: { host: "10.0.0.2", port: 443 },
      keepAliveSeconds: 30,
      connectTimeoutSeconds: 20,
      closeTimeoutSeconds: 4,
      maxConnections: 12,
      maxBufferedBytesPerConnection: 262_144,
    });
    expect(client.startPortForward).toHaveBeenCalledWith(
      "session-1",
      expect.objectContaining({
        bind: { host: "127.0.0.1", port: 0 },
        target: { host: "10.0.0.2", port: 443 },
        maxConnections: 12,
      }),
      { timeoutSeconds: 30 },
    );
    expect(startedPort).toMatchObject({
      bind: { host: "127.0.0.1", port: 45_550 },
      destination: { host: "10.0.0.2", port: 443 },
      state: listening,
    });

    const startedSocks = await controller.startSocks5Proxy({
      session,
      bind: { host: "127.0.0.1", port: 1080 },
      authentication: { username: "operator", password: "do-not-return" },
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 64,
      maxBufferedBytesPerConnection: 1_048_576,
    });
    expect(startedSocks.authentication).toBe("username-password");
    expect(JSON.stringify(startedSocks)).not.toContain("do-not-return");
    expect(JSON.stringify(await controller.list({ reverseTargets: [session] }))).not.toContain("do-not-return");

    portState.next({ ...listening, bytesToTarget: 4096 });
    socksState.next({ ...listening, bytesFromTarget: 8192 });
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(changed).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("returns local inventory when the authoritative reverse list is temporarily unavailable", async () => {
    const port = localPortForward(new BehaviorSubject<LocalForwardState>(listening));
    const client = forwardingClient({ port, reverseError: new Error("control stream unavailable") });
    const controller = new NetworkForwardingController(client, Date.now, vi.fn());
    const snapshot = await controller.list({ reverseTargets: [session] });
    expect(snapshot.portForwards).toHaveLength(1);
    expect(snapshot.reversePortForwards).toMatchObject({
      status: "error",
      items: [],
      error: "session-1: control stream unavailable",
    });
    controller.dispose();
  });

  it("aggregates reverse listeners across sessions while preserving partial results", async () => {
    const secondSession = { ...session, id: "session-2", fingerprint: "b".repeat(64) };
    const reverse: ReversePortForwardInfo = {
      id: 17,
      sessionId: session.id,
      bind: { host: "0.0.0.0", port: 8080 },
      target: { host: "127.0.0.1", port: 8443 },
    };
    const client = forwardingClient({});
    client.listReversePortForwards.mockImplementation(async (sessionId) => {
      if (sessionId === secondSession.id) throw new Error("session unavailable");
      return [reverse];
    });
    const controller = new NetworkForwardingController(client, Date.now, vi.fn());

    const snapshot = await controller.list({ reverseTargets: [session, secondSession] });

    expect(client.listReversePortForwards).toHaveBeenCalledTimes(2);
    expect(snapshot.reversePortForwards).toMatchObject({
      status: "error",
      items: [{ listenerId: 17, sessionId: session.id }],
      error: "session-2: session unavailable",
    });
    controller.dispose();
  });
});

function localPortForward(state: BehaviorSubject<LocalForwardState>): PortForward {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    sessionId: "session-1",
    bind: { host: "127.0.0.1", port: 45_550 },
    target: { host: "10.0.0.2", port: 443 },
    get state() { return state.value; },
    state$: state.asObservable(),
    connection$: new Subject<never>().asObservable(),
    close: vi.fn(async () => undefined),
  };
}

function localSocksProxy(state: BehaviorSubject<LocalForwardState>): Socks5Proxy {
  return {
    id: "socks5-223e4567-e89b-42d3-a456-426614174000",
    sessionId: "session-1",
    bind: { host: "127.0.0.1", port: 1080 },
    get state() { return state.value; },
    state$: state.asObservable(),
    connection$: new Subject<never>().asObservable(),
    close: vi.fn(async () => undefined),
  };
}

function forwardingClient({
  port,
  socks,
  reverseError,
}: {
  port?: PortForward;
  socks?: Socks5Proxy;
  reverseError?: Error;
}) {
  const ports = port ? [port] : [];
  const proxies = socks ? [socks] : [];
  const reverse: ReversePortForwardInfo[] = [];
  return {
    startPortForward: vi.fn(async () => port!),
    listPortForwards: vi.fn(() => ports),
    stopPortForward: vi.fn(async () => undefined),
    startSocks5Proxy: vi.fn(async () => socks!),
    listSocks5Proxies: vi.fn(() => proxies),
    stopSocks5Proxy: vi.fn(async () => undefined),
    startReversePortForward: vi.fn(async () => undefined as unknown as ReversePortForward),
    listReversePortForwards: vi.fn(async (_sessionId: string) => {
      if (reverseError) throw reverseError;
      return reverse;
    }),
    stopReversePortForward: vi.fn(async () => undefined),
  };
}
