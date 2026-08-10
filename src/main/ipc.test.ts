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

  it("decodes managed config and stop-plan capability calls at the trusted boundary", async () => {
    const importConfig = vi.fn(async () => ({ ok: false, error: "import probe" } as const));
    const removeSavedConfig = vi.fn(async () => ({ ok: true } as const));
    const prepareStopJob = vi.fn(async () => ({ ok: false, error: "stop probe" } as const));
    const executeStopPlan = vi.fn(async () => ({ ok: true } as const));
    registerIpcHandlers(
      registryMock({ importConfig, removeSavedConfig, prepareStopJob, executeStopPlan }),
      vi.fn(),
      RENDERER_URL,
    );
    const { event, sender } = invokeEvent("http://127.0.0.1:5173/", 77);
    const id = "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2";
    const token = "8e577480-5dc2-4dde-aa58-23c8f1770627";

    await electronMocks.handlers.get(IPC.importConfig)?.(event, { displayName: "Local operator" });
    await electronMocks.handlers.get(IPC.removeSavedConfig)?.(event, { id });
    await electronMocks.handlers.get(IPC.prepareStopJob)?.(event, 7);
    await electronMocks.handlers.get(IPC.executeStopPlan)?.(event, token);

    expect(importConfig).toHaveBeenCalledWith(sender, "Local operator");
    expect(removeSavedConfig).toHaveBeenCalledWith(77, id);
    expect(prepareStopJob).toHaveBeenCalledWith(77, 7);
    expect(executeStopPlan).toHaveBeenCalledWith(77, token);
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
    IPC.prepareStopAllJobs,
  ] as const)("rejects unexpected arguments for %s", (channel) => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    expect(() => electronMocks.handlers.get(channel)?.(event, "unexpected")).toThrow(/invalid arguments/);
  });

  it.each(
    [
      [IPC.openWindow, [{}]],
      [IPC.importConfig, [{ displayName: 7 }]],
      [IPC.removeSavedConfig, [{ id: "invalid" }]],
      [IPC.startListener, [{ kind: "bogus", host: "127.0.0.1", port: 8888 }]],
      [IPC.prepareStopJob, ["7"]],
      [IPC.executeStopPlan, ["invalid"]],
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
    const profileSave = { profileName: "default", config: defaultGenerateInput, overwrite: false };
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

  it("accepts only main-issued target references and compiled operation identifiers", async () => {
    const listTargets = vi.fn(async () => ({ ok: true as const, value: { items: [], page: { limit: 100, total: 0, truncated: false } } }));
    const selectTarget = vi.fn(async () => ({ ok: false as const, error: "selection probe" }));
    const submitTargetOperation = vi.fn(async () => ({ ok: false as const, error: "operation probe" }));
    const prepareTargetAction = vi.fn(async () => ({ ok: false as const, error: "action probe" }));
    registerIpcHandlers(
      registryMock({ listTargets, selectTarget, submitTargetOperation, prepareTargetAction }),
      vi.fn(),
      RENDERER_URL,
    );
    const { event } = invokeEvent("http://127.0.0.1:5173/targets", 77);
    const target = {
      mode: "beacon",
      id: "beacon_1",
      backendEpoch: 3,
      domainRevision: 7,
      fingerprint: "a".repeat(64),
    } as const;

    await electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      limit: 100,
      query: "prod-mac",
    });
    await electronMocks.handlers.get(IPC.selectTarget)?.(event, target);
    await electronMocks.handlers.get(IPC.submitTargetOperation)?.(event, {
      operationId: "target.env-set",
      name: "GUI_M1_TEST",
      value: "bounded-value",
    });
    await electronMocks.handlers.get(IPC.prepareTargetAction)?.(event, { actionId: "beacon.remove" });
    expect(selectTarget).toHaveBeenCalledWith(77, target);
    expect(listTargets).toHaveBeenCalledWith(77, {
      mode: "session",
      limit: 100,
      query: "prod-mac",
    });
    expect(submitTargetOperation).toHaveBeenCalledWith(77, {
      operationId: "target.env-set",
      name: "GUI_M1_TEST",
      value: "bounded-value",
    });
    expect(prepareTargetAction).toHaveBeenCalledWith(77, { actionId: "beacon.remove" });

    expect(() => electronMocks.handlers.get(IPC.selectTarget)?.(event, { ...target, path: "/tmp/secret" })).toThrow(
      /invalid target reference/i,
    );
    expect(() => electronMocks.handlers.get(IPC.submitTargetOperation)?.(event, {
      operationId: "raw.rpc",
      method: "SessionsKillAll",
      payload: { admin: true },
    })).toThrow(/not an allowed target operation/);
    expect(() => electronMocks.handlers.get(IPC.prepareTargetAction)?.(event, {
      actionId: "sessions.kill-all",
    })).toThrow(/invalid target action input/i);
    expect(() => electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      cursor: "500",
      limit: 100,
    })).toThrow(/invalid target catalog page request/i);
    expect(() => electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      limit: 101,
    })).toThrow(/invalid target catalog page request/i);
    expect(() => electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      limit: 100,
      targetId: "session_1",
    })).toThrow(/invalid target catalog page request/i);
    expect(() => electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      query: "x".repeat(129),
    })).toThrow(/invalid target catalog page request/i);
    expect(() => electronMocks.handlers.get(IPC.listTargets)?.(event, {
      mode: "session",
      query: "prod\0mac",
    })).toThrow(/invalid target catalog page request/i);
    expect(submitTargetOperation).toHaveBeenCalledOnce();
  });
});

function registryMock(overrides: Partial<IpcConnectionRegistry> = {}): IpcConnectionRegistry {
  const unavailable = async (): Promise<{ ok: false; error: string }> => ({
    ok: false,
    error: "not implemented",
  });
  return {
    chooseAndConnect: vi.fn(unavailable),
    importConfig: vi.fn(unavailable),
    listSavedConfigs: vi.fn(unavailable),
    connectSavedConfig: vi.fn(unavailable),
    removeSavedConfig: vi.fn(unavailable),
    disconnect: vi.fn(unavailable),
    snapshot: vi.fn(() => disconnectedSnapshot()),
    refresh: vi.fn(unavailable),
    chooseCertificatePair: vi.fn(unavailable),
    startListener: vi.fn(unavailable),
    prepareStopJob: vi.fn(unavailable),
    prepareStopAllJobs: vi.fn(unavailable),
    executeStopPlan: vi.fn(unavailable),
    generate: vi.fn(unavailable),
    generateFromProfile: vi.fn(unavailable),
    downloadBuild: vi.fn(unavailable),
    deleteBuild: vi.fn(unavailable),
    setStagedBuilds: vi.fn(unavailable),
    saveProfile: vi.fn(unavailable),
    deleteProfile: vi.fn(unavailable),
    listTargets: vi.fn(unavailable),
    selectTarget: vi.fn(unavailable),
    backgroundTarget: vi.fn(unavailable),
    setBeaconWatch: vi.fn(unavailable),
    submitTargetOperation: vi.fn(unavailable),
    listTargetOperations: vi.fn(unavailable),
    getTargetOperation: vi.fn(unavailable),
    cancelTargetOperation: vi.fn(unavailable),
    prepareTargetAction: vi.fn(unavailable),
    executeTargetActionPlan: vi.fn(unavailable),
    listBeaconTasks: vi.fn(unavailable),
    getBeaconTask: vi.fn(unavailable),
    cancelBeaconTask: vi.fn(unavailable),
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
