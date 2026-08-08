// @vitest-environment node

import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  IPC_INVOKE,
  disconnectedSnapshot,
  type IpcInvokeChannel,
  type ListenerInput,
} from "../shared/contracts.js";
import { defaultGenerateInput } from "../shared/generate-defaults.js";

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

import { registerIpcHandlers, type IpcConnectionRegistry } from "./ipc.js";

const RENDERER_URL = "http://127.0.0.1:5173";

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue({});
});

describe("trusted Electron IPC boundary", () => {
  it("registers every shared invoke channel exactly once", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);

    expect([...electronMocks.handlers.keys()].sort()).toEqual(Object.values(IPC_INVOKE).sort());
    expect(electronMocks.handle).toHaveBeenCalledTimes(Object.keys(IPC_INVOKE).length);
  });

  it("accepts the registered main frame and captures its webContents ID", () => {
    const snapshot = vi.fn((_contentsId: number) => disconnectedSnapshot());
    registerIpcHandlers(registryMock({ snapshot }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/builds", 42);

    expect(electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toEqual(disconnectedSnapshot());
    expect(snapshot).toHaveBeenCalledWith(42);
  });

  it("rejects origins that merely prefix-match the configured renderer", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173.evil.test/", 42);

    expect(() => electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toThrow(/untrusted renderer/);
  });

  it("rejects child-frame invocations even when they use the trusted origin", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event, mainFrame } = invokeEvent("http://127.0.0.1:5173/", 42);
    const childFrame = {
      ...mainFrame,
      frameToken: "child-frame",
    } as WebFrameMain;
    Object.defineProperty(event, "senderFrame", { value: childFrame });

    expect(() => electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toThrow(/untrusted renderer/);
  });

  it("scopes saved-config list and connect calls to the invoking main window", async () => {
    const listSavedConfigs = vi.fn(async (_contentsId: number) => ({ ok: true as const, value: [] }));
    const connectSavedConfig = vi.fn(async (_contentsId: number, _id: string) => ({
      ok: true,
      value: disconnectedSnapshot(),
    } as const));
    registerIpcHandlers(registryMock({ listSavedConfigs, connectSavedConfig }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);
    const id = "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2";

    await expect(electronMocks.handlers.get(IPC.listSavedConfigs)?.(event)).resolves.toEqual({ ok: true, value: [] });
    await expect(electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, id)).resolves.toEqual({
      ok: true,
      value: disconnectedSnapshot(),
    });
    expect(listSavedConfigs).toHaveBeenCalledWith(77);
    expect(connectSavedConfig).toHaveBeenCalledWith(77, id);
  });

  it("rejects malformed saved-config IDs at the central IPC boundary", () => {
    const connectSavedConfig = vi.fn(async () => ({ ok: false, error: "not called" } as const));
    registerIpcHandlers(registryMock({ connectSavedConfig }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    expect(() => electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, "../../operator.cfg")).toThrow(
      /invalid saved configuration ID/,
    );
    expect(() => electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, { id: "anything" })).toThrow(
      /invalid saved configuration ID/,
    );
    expect(connectSavedConfig).not.toHaveBeenCalled();
  });

  it.each([
    IPC.chooseConfig,
    IPC.listSavedConfigs,
    IPC.disconnect,
    IPC.getSnapshot,
    IPC.refresh,
    IPC.chooseCertificatePair,
    IPC.killAllJobs,
  ] as const)("rejects unexpected arguments for %s", (channel) => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    expect(() => electronMocks.handlers.get(channel)?.(event, "unexpected")).toThrow(/invalid arguments/);
  });

  it.each(
    [
      [IPC.openWindow, [{}]],
      [IPC.startListener, [{ kind: "bogus", host: "127.0.0.1", port: 8888 }]],
      [IPC.killJob, ["7"]],
      [IPC.generate, [{ name: "incomplete" }]],
      [IPC.generateFromProfile, [{ profileName: 7, name: "test" }]],
      [IPC.downloadBuild, [7]],
      [IPC.deleteBuild, [{}]],
      [IPC.setStagedBuilds, [["valid", 7]]],
      [IPC.saveProfile, [{ profileName: "test", config: {} }]],
      [IPC.deleteProfile, [7]],
    ] satisfies ReadonlyArray<readonly [IpcInvokeChannel, readonly unknown[]]>,
  )("rejects malformed renderer payloads for %s", (channel, args) => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    expect(() => electronMocks.handlers.get(channel)?.(event, ...args)).toThrow(/Rejected invalid/);
  });

  it.each([
    { kind: "mtls", host: "127.0.0.1", port: 8888 },
    {
      kind: "wireguard",
      host: "127.0.0.1",
      port: 51820,
      tunnelIp: "100.64.0.1",
      tcpCommsPort: 1337,
      keyExchangePort: 1338,
    },
    {
      kind: "dns",
      host: "127.0.0.1",
      port: 53,
      domains: "example.test",
      canaries: true,
      enforceOtp: false,
    },
    {
      kind: "http",
      host: "127.0.0.1",
      port: 80,
      domain: "example.test",
      website: "default",
      enforceOtp: false,
      longPollTimeoutSeconds: 10,
      longPollJitterSeconds: 2,
      acme: false,
      randomizeJarm: false,
      certificateToken: "",
    },
    {
      kind: "https",
      host: "127.0.0.1",
      port: 443,
      domain: "example.test",
      website: "default",
      enforceOtp: true,
      longPollTimeoutSeconds: 10,
      longPollJitterSeconds: 2,
      acme: true,
      randomizeJarm: true,
      certificateToken: "",
    },
    {
      kind: "stage",
      host: "127.0.0.1",
      port: 8443,
      profileName: "default",
      compression: "gzip",
      aesKey: "",
      aesIv: "",
      rc4Key: "",
    },
  ] satisfies readonly ListenerInput[])("decodes a valid $kind listener payload", async (listener) => {
    const startListener = vi.fn(async () => ({ ok: false, error: "listener probe" } as const));
    registerIpcHandlers(registryMock({ startListener }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    await expect(electronMocks.handlers.get(IPC.startListener)?.(event, listener)).resolves.toEqual({
      ok: false,
      error: "listener probe",
    });
    expect(startListener).toHaveBeenCalledWith(77, listener);
  });

  it("decodes valid structured operation payloads before forwarding them", async () => {
    const createWindow = vi.fn();
    const generate = vi.fn(async () => ({ ok: false, error: "generate probe" } as const));
    const generateFromProfile = vi.fn(async () => ({ ok: false, error: "profile generation probe" } as const));
    const setStagedBuilds = vi.fn(async () => ({ ok: false, error: "staging probe" } as const));
    const saveProfile = vi.fn(async () => ({ ok: false, error: "profile save probe" } as const));
    registerIpcHandlers(
      registryMock({ generate, generateFromProfile, setStagedBuilds, saveProfile }),
      createWindow,
      RENDERER_URL,
    );
    const { event, sender } = invokeEvent("http://127.0.0.1:5173/", 77);
    const profileGeneration = { profileName: "default", name: "test" };
    const profileSave = { profileName: "default", config: defaultGenerateInput };
    const stagedBuilds = ["alpha", "bravo"];

    expect(electronMocks.handlers.get(IPC.openWindow)?.(event, { inheritConnection: true })).toEqual({ ok: true });
    await expect(electronMocks.handlers.get(IPC.generate)?.(event, defaultGenerateInput)).resolves.toEqual({
      ok: false,
      error: "generate probe",
    });
    await electronMocks.handlers.get(IPC.generateFromProfile)?.(event, profileGeneration);
    await electronMocks.handlers.get(IPC.setStagedBuilds)?.(event, stagedBuilds);
    await electronMocks.handlers.get(IPC.saveProfile)?.(event, profileSave);

    expect(createWindow).toHaveBeenCalledWith(77);
    expect(generate).toHaveBeenCalledWith(sender, defaultGenerateInput);
    expect(generateFromProfile).toHaveBeenCalledWith(sender, profileGeneration);
    expect(setStagedBuilds).toHaveBeenCalledWith(77, stagedBuilds);
    expect(saveProfile).toHaveBeenCalledWith(77, profileSave);
  });
});

function registryMock(overrides: Partial<IpcConnectionRegistry> = {}): IpcConnectionRegistry {
  const unavailable = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: "not implemented",
  });
  return {
    chooseAndConnect: vi.fn(unavailable),
    listSavedConfigs: vi.fn(unavailable),
    connectSavedConfig: vi.fn(unavailable),
    disconnect: vi.fn(unavailable),
    snapshot: vi.fn(() => disconnectedSnapshot()),
    refresh: vi.fn(unavailable),
    chooseCertificatePair: vi.fn(unavailable),
    startListener: vi.fn(unavailable),
    killJob: vi.fn(unavailable),
    killAllJobs: vi.fn(unavailable),
    generate: vi.fn(unavailable),
    generateFromProfile: vi.fn(unavailable),
    downloadBuild: vi.fn(unavailable),
    deleteBuild: vi.fn(unavailable),
    setStagedBuilds: vi.fn(unavailable),
    saveProfile: vi.fn(unavailable),
    deleteProfile: vi.fn(unavailable),
    ...overrides,
  };
}

function invokeEvent(url: string, contentsId: number): {
  event: IpcMainInvokeEvent;
  mainFrame: WebFrameMain;
  sender: WebContents;
} {
  // Electron event objects are host-created and have a much wider API than the
  // sender properties exercised here. Keep those unavoidable test assertions
  // isolated in this fixture builder.
  const mainFrame = {
    frameToken: "main-frame",
    processId: 100,
    url,
    isDestroyed: () => false,
  } as WebFrameMain;
  const sender = {
    id: contentsId,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  } as unknown as WebContents;
  const event = {
    sender,
    senderFrame: mainFrame,
  } as IpcMainInvokeEvent;
  return { event, mainFrame, sender };
}
