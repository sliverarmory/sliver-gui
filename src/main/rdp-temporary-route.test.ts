// @vitest-environment node

import { BehaviorSubject, Subject } from "rxjs";
import type { ForwardConnectionEvent, LocalForwardState, PortForward } from "sliver-script";
import { describe, expect, it, vi } from "vitest";
import { createRdpTemporaryRoute } from "./rdp-temporary-route.js";

function fixture() {
  const state: LocalForwardState = { status: "listening", activeConnections: 0, totalConnections: 0, bytesToTarget: 0, bytesFromTarget: 0 };
  const close = vi.fn(async () => undefined);
  const forward: PortForward = { id: "owned-forward", sessionId: "windows-session", bind: { host: "127.0.0.1", port: 49152 },
    target: { host: "127.0.0.1", port: 3389 }, state, state$: new BehaviorSubject(state),
    connection$: new Subject<ForwardConnectionEvent>(), close };
  const client = { startPortForward: vi.fn(async () => forward) };
  return { forward, client, close };
}

describe("temporary RDP routes", () => {
  it("asks the OS for a loopback port and closes the captured listener exactly once", async () => {
    const { client, close } = fixture();
    const route = await createRdpTemporaryRoute(client, "windows-session", () => undefined);
    expect(client.startPortForward).toHaveBeenCalledWith("windows-session", {
      bind: { host: "127.0.0.1", port: 0 }, target: { host: "127.0.0.1", port: 3389 },
      keepAliveSeconds: 30, connectTimeoutSeconds: 30, closeTimeoutSeconds: 5,
      maxConnections: 4, maxBufferedBytesPerConnection: 512 * 1024,
    }, { timeoutSeconds: 30 });
    expect(route).toMatchObject({ host: "127.0.0.1", port: 49152 });
    expect(route.isActive()).toBe(true);
    const closing = route.close();
    expect(route.isActive()).toBe(false);
    expect(route.close()).toBe(closing);
    await closing;
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not open a listener for stale authority", async () => {
    const { client } = fixture();
    await expect(createRdpTemporaryRoute(client, "windows-session", () => { throw new Error("stale"); })).rejects.toThrow("stale");
    expect(client.startPortForward).not.toHaveBeenCalled();
  });

  it("closes a listener if authority changed while binding it", async () => {
    const { client, close, forward } = fixture();
    let current = true;
    client.startPortForward.mockImplementation(async () => { current = false; return forward; });
    await expect(createRdpTemporaryRoute(client, "windows-session", () => {
      if (!current) throw new Error("source changed");
    })).rejects.toThrow("source changed");
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    { bind: { host: "0.0.0.0", port: 49152 } },
    { bind: { host: "127.0.0.1", port: 0 } },
    { bind: { host: "127.0.0.1", port: 65536 } },
    { bind: { host: "127.0.0.1", port: 3.5 } },
    { target: { host: "10.0.0.1", port: 3389 } },
    { target: { host: "127.0.0.1", port: 22 } },
    { sessionId: "other-session" },
  ])("rejects an unexpected listener endpoint or session: %j", async (changes) => {
    const { client, close, forward } = fixture();
    client.startPortForward.mockResolvedValue({ ...forward, ...changes });
    await expect(createRdpTemporaryRoute(client, "windows-session", () => undefined)).rejects.toThrow("loopback listener");
    expect(close).toHaveBeenCalledOnce();
  });

  it("becomes inactive when either its original authority or listener is lost", async () => {
    const { client, forward } = fixture();
    let current = true;
    const route = await createRdpTemporaryRoute(client, "windows-session", () => { if (!current) throw new Error("stale"); });
    current = false;
    expect(route.isActive()).toBe(false);
    current = true;
    expect(route.isActive()).toBe(true);
    Object.assign(forward, { state: { ...forward.state, status: "failed" } });
    expect(route.isActive()).toBe(false);
    await route.close();
  });
});
