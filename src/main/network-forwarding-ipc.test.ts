// @vitest-environment node

import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { NETWORK_FORWARDING_IPC_INVOKE } from "../shared/network-forwarding-contracts.js";
import {
  registerNetworkForwardingIpcHandlers,
  unregisterNetworkForwardingIpcHandlers,
  type NetworkForwardingIpcServices,
} from "./network-forwarding-ipc.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
}));

const RENDERER_URL = "sliver://app/index.html?surface=network";
const WINDOW = { marker: "network" } as unknown as BrowserWindow;
const REJECTED = { ok: false, error: "The Network request was rejected" };
const session = {
  mode: "session" as const,
  id: "session-1",
  backendEpoch: 4,
  domainRevision: 6,
  fingerprint: "a".repeat(64),
};

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation((channel, handler) => electronMocks.handlers.set(channel, handler));
  electronMocks.removeHandler.mockReset();
  electronMocks.removeHandler.mockImplementation((channel) => electronMocks.handlers.delete(channel));
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue(WINDOW);
});

afterEach(() => unregisterNetworkForwardingIpcHandlers());

describe("Network forwarding IPC", () => {
  it("registers only the dedicated fixed invoke channels", () => {
    registerNetworkForwardingIpcHandlers(servicesMock(), RENDERER_URL, () => true);
    expect([...electronMocks.handlers.keys()].sort()).toEqual(
      Object.values(NETWORK_FORWARDING_IPC_INVOKE).sort(),
    );
    unregisterNetworkForwardingIpcHandlers();
    expect(electronMocks.handlers.size).toBe(0);
  });

  it("dispatches exact validated forwarding inputs with the authorized contents ID", async () => {
    const services = servicesMock();
    const authorize = vi.fn(() => true);
    registerNetworkForwardingIpcHandlers(services, RENDERER_URL, authorize);
    const event = invokeEvent(RENDERER_URL, 77);
    const portInput = {
      session,
      bind: { host: "127.0.0.1", port: 0 },
      destination: { host: "10.0.0.5", port: 443 },
      keepAliveSeconds: 30,
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 32,
      maxBufferedBytesPerConnection: 512 * 1024,
    };

    await invoke(NETWORK_FORWARDING_IPC_INVOKE.getContext, event);
    await invoke(NETWORK_FORWARDING_IPC_INVOKE.list, event, { reverseTargets: [session] });
    await invoke(NETWORK_FORWARDING_IPC_INVOKE.startPortForward, event, portInput);
    await invoke(
      NETWORK_FORWARDING_IPC_INVOKE.stopPortForward,
      event,
      "123e4567-e89b-42d3-a456-426614174000",
    );

    expect(services.forwarding.getContext).toHaveBeenCalledWith(77);
    expect(services.forwarding.list).toHaveBeenCalledWith(77, { reverseTargets: [session] });
    expect(services.forwarding.startPortForward).toHaveBeenCalledWith(77, portInput);
    expect(authorize).toHaveBeenCalledWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    }, WINDOW);
  });

  it("clears the raw SOCKS password after dispatch", async () => {
    const services = servicesMock();
    registerNetworkForwardingIpcHandlers(services, RENDERER_URL, () => true);
    const input = {
      session,
      bind: { host: "127.0.0.1", port: 1080 },
      authentication: { username: "operator", password: "transient-secret" },
      connectTimeoutSeconds: 30,
      closeTimeoutSeconds: 5,
      maxConnections: 64,
      maxBufferedBytesPerConnection: 1024 * 1024,
    };
    await invoke(NETWORK_FORWARDING_IPC_INVOKE.startSocks5Proxy, invokeEvent(RENDERER_URL, 77), input);
    expect(services.forwarding.startSocks5Proxy).toHaveBeenCalledWith(
      77,
      expect.objectContaining({ authentication: { username: "operator", password: "transient-secret" } }),
    );
    expect(input.authentication.password).toBe("");
  });

  it.each([
    ["workspace URL", "sliver://app/index.html"],
    ["extra query state", "sliver://app/index.html?surface=network&session=attacker"],
    ["origin impostor", "sliver://app.evil.test/index.html?surface=network"],
  ])("rejects %s", async (_label, url) => {
    const services = servicesMock();
    registerNetworkForwardingIpcHandlers(services, RENDERER_URL, () => true);
    await expect(invoke(NETWORK_FORWARDING_IPC_INVOKE.getContext, invokeEvent(url, 77)))
      .resolves.toEqual(REJECTED);
    expect(services.forwarding.getContext).not.toHaveBeenCalled();
  });

  it("rejects child frames and parser widening before controller dispatch", async () => {
    const services = servicesMock();
    registerNetworkForwardingIpcHandlers(services, RENDERER_URL, () => true);
    const child = invokeEvent(RENDERER_URL, 77);
    Object.defineProperty(child, "senderFrame", {
      value: { ...child.sender.mainFrame, frameToken: "child" } as WebFrameMain,
    });
    await expect(invoke(NETWORK_FORWARDING_IPC_INVOKE.getContext, child)).resolves.toEqual(REJECTED);
    await expect(invoke(NETWORK_FORWARDING_IPC_INVOKE.list, invokeEvent(RENDERER_URL, 77), {
      reverseTargets: [session],
      rpcMethod: "arbitrary",
    })).resolves.toEqual(REJECTED);
    expect(services.forwarding.getContext).not.toHaveBeenCalled();
    expect(services.forwarding.list).not.toHaveBeenCalled();
  });
});

function servicesMock(): NetworkForwardingIpcServices {
  const success = { ok: true as const };
  return {
    forwarding: {
      getContext: vi.fn(async () => success as never),
      list: vi.fn(async () => success as never),
      startPortForward: vi.fn(async () => success as never),
      stopPortForward: vi.fn(async () => success),
      startReversePortForward: vi.fn(async () => success as never),
      stopReversePortForward: vi.fn(async () => success),
      startSocks5Proxy: vi.fn(async () => success as never),
      stopSocks5Proxy: vi.fn(async () => success),
    },
    applicationSettings: {
      getState: vi.fn(() => DEFAULT_APPLICATION_SETTINGS_STATE),
    },
  };
}

function invokeEvent(url: string, id: number): IpcMainInvokeEvent {
  const mainFrame = {
    processId: 100,
    frameToken: "main-frame",
    url,
    isDestroyed: () => false,
  } as unknown as WebFrameMain;
  const sender = {
    id,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  } as unknown as WebContents;
  return { sender, senderFrame: mainFrame } as IpcMainInvokeEvent;
}

async function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) throw new Error(`Missing handler for ${channel}`);
  return handler(event, ...args);
}
