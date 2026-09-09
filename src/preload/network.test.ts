// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

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

await import("./network.js");

const registrations = new Map(
  electronMocks.on.mock.calls.map((call) => [call[0], call[1]] as const),
);

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
    await api.stopReversePortForward({
      session: ref,
      listenerId: 7,
      expectedBind: reverseInput.bind,
      expectedDestination: reverseInput.destination,
    });
    await api.startSocks5Proxy(socksInput);
    await api.stopSocks5Proxy("socks5-223e4567-e89b-42d3-a456-426614174000");
    await api.getApplicationSettings();
    expect(electronMocks.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      NETWORK_FORWARDING_IPC_INVOKE.getContext,
      NETWORK_FORWARDING_IPC_INVOKE.list,
      NETWORK_FORWARDING_IPC_INVOKE.startPortForward,
      NETWORK_FORWARDING_IPC_INVOKE.stopPortForward,
      NETWORK_FORWARDING_IPC_INVOKE.startReversePortForward,
      NETWORK_FORWARDING_IPC_INVOKE.stopReversePortForward,
      NETWORK_FORWARDING_IPC_INVOKE.startSocks5Proxy,
      NETWORK_FORWARDING_IPC_INVOKE.stopSocks5Proxy,
      NETWORK_FORWARDING_IPC_INVOKE.getApplicationSettings,
    ]);
  });

  it("buffers native tab navigation until React subscribes", async () => {
    const handler = registrations.get(NETWORK_FORWARDING_IPC_EVENTS.navigationRequested);
    if (!handler) throw new Error("Missing navigation listener");
    handler({}, "socks5");
    const listener = vi.fn();
    const unsubscribe = exposedApi().onNavigationRequested(listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith("socks5");
    unsubscribe();
  });

  it("coalesces no authority and removes both inventory subscriptions", () => {
    const listener = vi.fn();
    const unsubscribe = exposedApi().onChanged(listener);
    const networkRegistration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === NETWORK_FORWARDING_IPC_EVENTS.changed && typeof channel === "string",
    );
    const snapshotRegistration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === IPC.snapshotChanged && typeof channel === "string",
    );
    (networkRegistration?.[1] as (() => void) | undefined)?.();
    (snapshotRegistration?.[1] as (() => void) | undefined)?.();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      NETWORK_FORWARDING_IPC_EVENTS.changed,
      expect.any(Function),
    );
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.snapshotChanged, expect.any(Function));
  });
});

function exposedApi(): NetworkForwardingAPI {
  const match = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "network");
  if (!match?.[1]) throw new Error("Network API was not exposed");
  return match[1];
}
