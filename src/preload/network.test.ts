// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NetworkForwardingAPI } from "../shared/network-forwarding-contracts.js";
import {
  NETWORK_FORWARDING_IPC_EVENTS,
  NETWORK_FORWARDING_IPC_INVOKE,
} from "../shared/network-forwarding-contracts.js";
import { IPC } from "../shared/contracts.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: NetworkForwardingAPI) => void>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await import("./network.js");
});

describe("Network preload", () => {
  it("exposes only the frozen Network capability API", () => {
    const api = exposedApi();
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith("network", api);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api)).toEqual([
      "getContext",
      "list",
      "startPortForward",
      "stopPortForward",
      "startReversePortForward",
      "stopReversePortForward",
      "startSocks5Proxy",
      "stopSocks5Proxy",
      "getApplicationSettings",
      "onChanged",
      "onNavigationRequested",
      "onApplicationSettingsChanged",
    ]);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("send");
    expect(api).not.toHaveProperty("rpc");
  });

  it("maps every operation to one literal dedicated channel", async () => {
    const api = exposedApi();
    electronMocks.invoke.mockClear();
    const ref = {
      mode: "session" as const,
      id: "session-1",
      backendEpoch: 1,
      domainRevision: 2,
      fingerprint: "a".repeat(64),
    };
    const portInput = {
      session: ref,
      bind: { host: "127.0.0.1", port: 0 },
      destination: { host: "10.0.0.2", port: 443 },
      keepAliveSeconds: 30,
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 32,
      maxBufferedBytesPerConnection: 512 * 1024,
    };
    const reverseInput = {
      session: ref,
      bind: { host: "0.0.0.0", port: 8080 },
      destination: { host: "127.0.0.1", port: 9000 },
      keepAliveSeconds: 30,
    };
    const socksInput = {
      session: ref,
      bind: { host: "127.0.0.1", port: 1080 },
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 64,
      maxBufferedBytesPerConnection: 1024 * 1024,
    };
    await api.getContext();
    await api.list({ reverseTargets: [ref] });
    await api.startPortForward(portInput);
    await api.stopPortForward("123e4567-e89b-42d3-a456-426614174000");
    await api.startReversePortForward(reverseInput);
    const stopReverseInput = {
      session: ref,
      listenerId: 7,
      expectedBind: reverseInput.bind,
      expectedDestination: reverseInput.destination,
    };
    await api.stopReversePortForward(stopReverseInput);
    await api.startSocks5Proxy(socksInput);
    await api.stopSocks5Proxy("socks5-223e4567-e89b-42d3-a456-426614174000");
    await api.getApplicationSettings();
    expect(electronMocks.invoke.mock.calls).toEqual([
      [NETWORK_FORWARDING_IPC_INVOKE.getContext],
      [NETWORK_FORWARDING_IPC_INVOKE.list, { reverseTargets: [ref] }],
      [NETWORK_FORWARDING_IPC_INVOKE.startPortForward, portInput],
      [NETWORK_FORWARDING_IPC_INVOKE.stopPortForward, "123e4567-e89b-42d3-a456-426614174000"],
      [NETWORK_FORWARDING_IPC_INVOKE.startReversePortForward, reverseInput],
      [NETWORK_FORWARDING_IPC_INVOKE.stopReversePortForward, stopReverseInput],
      [NETWORK_FORWARDING_IPC_INVOKE.startSocks5Proxy, socksInput],
      [NETWORK_FORWARDING_IPC_INVOKE.stopSocks5Proxy, "socks5-223e4567-e89b-42d3-a456-426614174000"],
      [NETWORK_FORWARDING_IPC_INVOKE.getApplicationSettings],
    ]);
  });

  it("buffers native tab navigation until React subscribes", async () => {
    const handler = registeredHandler(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested);
    handler({}, "socks5");
    const listener = vi.fn();
    const unsubscribe = exposedApi().onNavigationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith("socks5");
    unsubscribe();
  });

  it("discards native payloads and removes the exact handler from both inventory channels", () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi().onChanged(listener);
    const networkHandler = registeredHandler(NETWORK_FORWARDING_IPC_EVENTS.changed);
    const snapshotHandler = registeredHandler(IPC.snapshotChanged);
    networkHandler({ sender: "native event" }, { secret: "private inventory" });
    snapshotHandler({ sender: "native event" }, { secret: "private snapshot" });
    expect(listener.mock.calls).toEqual([[], []]);
    unsubscribe();
    expect(electronMocks.removeListener.mock.calls).toEqual([
      [NETWORK_FORWARDING_IPC_EVENTS.changed, networkHandler],
      [IPC.snapshotChanged, snapshotHandler],
    ]);
  });

  it("retains buffered navigation when a subscriber unmounts before delivery", async () => {
    const handler = registeredHandler(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested);
    handler({}, "port-forward");
    handler({}, "socks5");
    const first = vi.fn();
    const stopFirst = exposedApi().onNavigationRequested(first);
    stopFirst();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();

    const second = vi.fn();
    const stopSecond = exposedApi().onNavigationRequested(second);
    await Promise.resolve();
    expect(second).toHaveBeenCalledExactlyOnceWith("socks5");
    stopSecond();
    handler({}, "reverse-port-forward");
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("does not replay buffered navigation after a newer live request", async () => {
    const handler = registeredHandler(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested);
    handler({}, "port-forward");
    const listener = vi.fn();
    const stop = exposedApi().onNavigationRequested(listener);
    handler({}, "reverse-port-forward");
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith("reverse-port-forward");
    stop();
  });

  it("drops malformed navigation both before and after subscription", async () => {
    const handler = registeredHandler(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested);
    const malformed = [[], ["unknown"], [{ tab: "socks5" }], ["socks5", "extra"], [null]];
    for (const payload of malformed) handler({}, ...payload);
    const listener = vi.fn();
    const stop = exposedApi().onNavigationRequested(listener);
    await Promise.resolve();
    for (const payload of malformed) handler({}, ...payload);
    expect(listener).not.toHaveBeenCalled();
    handler({ sender: "native event" }, "socks5");
    expect(listener).toHaveBeenCalledExactlyOnceWith("socks5");
    stop();
  });
});

function registeredHandler(channel: string): (...args: unknown[]) => void {
  const registration = electronMocks.on.mock.calls.find(([registered]) => registered === channel);
  if (typeof registration?.[1] !== "function") throw new Error(`Missing listener for ${channel}`);
  return registration[1];
}

function exposedApi(): NetworkForwardingAPI {
  const match = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "network");
  if (!match?.[1]) throw new Error("Network API was not exposed");
  return match[1];
}
