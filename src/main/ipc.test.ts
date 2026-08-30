// @vitest-environment node

import type {
  IpcMainEvent,
  IpcMainInvokeEvent,
  MessagePortMain,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IPC,
  IPC_INVOKE,
  disconnectedSnapshot,
  type IpcInvokeChannel,
  type ListenerInput,
} from "../shared/contracts.js";
import type { PrepareExecutionActionInput } from "../shared/execution-contracts.js";
import { defaultGenerateInput } from "../shared/generate-defaults.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: IpcMainEvent, ...args: unknown[]) => void>(),
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  ipcMain: {
    handle: electronMocks.handle,
    on: electronMocks.on,
    removeHandler: electronMocks.removeHandler,
    removeListener: electronMocks.removeListener,
  },
}));

import { registerIpcHandlers, unregisterIpcHandlers, type IpcConnectionRegistry } from "./ipc.js";

const RENDERER_URL = "http://127.0.0.1:5173";

beforeEach(() => {
  unregisterIpcHandlers();
  electronMocks.handlers.clear();
  electronMocks.listeners.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.on.mockReset();
  electronMocks.on.mockImplementation(
    (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => void) => {
      electronMocks.listeners.set(channel, listener);
    },
  );
  electronMocks.removeHandler.mockReset();
  electronMocks.removeListener.mockReset();
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue({});
});

afterEach(() => unregisterIpcHandlers());

describe("trusted Electron IPC boundary", () => {
  it("registers every shared invoke channel exactly once", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);

    expect([...electronMocks.handlers.keys()].sort()).toEqual(Object.values(IPC_INVOKE).sort());
    expect(electronMocks.handle).toHaveBeenCalledTimes(Object.keys(IPC_INVOKE).length);
  });

  it("registers and unregisters the isolated shell and console port listeners", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const listener = electronMocks.listeners.get(IPC.attach);
    const consoleListener = electronMocks.listeners.get(IPC.attachConsole);

    expect(listener).toBeTypeOf("function");
    expect(consoleListener).toBeTypeOf("function");
    expect(electronMocks.on).toHaveBeenCalledTimes(2);
    expect(electronMocks.on).toHaveBeenCalledWith(IPC.attach, listener);
    expect(electronMocks.on).toHaveBeenCalledWith(IPC.attachConsole, consoleListener);

    unregisterIpcHandlers();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.attach, listener);
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.attachConsole, consoleListener);
  });

  it("accepts the registered main frame and captures its webContents ID", () => {
    const snapshot = vi.fn((_contentsId: number) => disconnectedSnapshot());
    registerIpcHandlers(registryMock({ snapshot }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/builds", 42);

    expect(electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toEqual(disconnectedSnapshot());
    expect(snapshot).toHaveBeenCalledWith(42);
  });

  it("allows a trusted renderer to request application exit", () => {
    const exitApplication = vi.fn();
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL, undefined, exitApplication);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 42);

    expect(electronMocks.handlers.get(IPC.exitApp)?.(event)).toEqual({ ok: true });
    expect(exitApplication).toHaveBeenCalledOnce();
  });

  it("exposes only the bounded application-update controller methods", async () => {
    const state = { status: "idle", revision: 0, currentVersion: "1.2.3" } as const;
    const getState = vi.fn(() => state);
    const checkForUpdates = vi.fn(async () => ({ ok: true as const, value: state }));
    const restartToApply = vi.fn(() => ({ ok: true as const }));
    registerIpcHandlers(
      registryMock(),
      vi.fn(),
      RENDERER_URL,
      undefined,
      undefined,
      undefined,
      { getState, checkForUpdates, restartToApply },
    );
    const { event } = invokeEvent("http://127.0.0.1:5173/", 42);

    expect(electronMocks.handlers.get(IPC.getApplicationUpdateState)?.(event)).toEqual(state);
    await expect(electronMocks.handlers.get(IPC.checkForApplicationUpdates)?.(event)).resolves.toEqual({
      ok: true,
      value: state,
    });
    expect(electronMocks.handlers.get(IPC.restartToApplyApplicationUpdate)?.(event)).toEqual({ ok: true });
    expect(getState).toHaveBeenCalledOnce();
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(restartToApply).toHaveBeenCalledOnce();
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

  it("exposes the bounded interface inventory only to a window connected to a local server", () => {
    const snapshot = vi.fn((contentsId: number) => {
      const value = disconnectedSnapshot();
      value.connection = contentsId === 77
        ? { status: "connected", server: "127.0.0.1:53137" }
        : { status: "connected", server: "remote.example:53137" };
      return value;
    });
    registerIpcHandlers(registryMock({ snapshot }), vi.fn(), RENDERER_URL);
    const local = invokeEvent("http://127.0.0.1:5173/", 77);
    const remote = invokeEvent("http://127.0.0.1:5173/", 88);
    const handler = electronMocks.handlers.get(IPC.listLocalNetworkInterfaces);

    const localResult = handler?.(local.event) as {
      ok: boolean;
      value?: { hostname: string; addresses: Array<Record<string, unknown>> };
    };
    expect(localResult).toMatchObject({
      ok: true,
      value: { hostname: expect.any(String), addresses: expect.any(Array) },
    });
    expect(localResult.value?.addresses.every((address) =>
      Object.keys(address).every((key) => ["name", "address", "family", "scope"].includes(key)),
    )).toBe(true);
    expect(handler?.(remote.event)).toEqual({
      ok: false,
      error: "Local interface selection is available only when the Sliver server is running on this machine",
    });
    expect(snapshot).toHaveBeenNthCalledWith(1, 77);
    expect(snapshot).toHaveBeenNthCalledWith(2, 88);
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
    IPC.listLocalNetworkInterfaces,
    IPC.openInteractionWindow,
    IPC.claimInteractionWindow,
    IPC.exitApp,
    IPC.getApplicationUpdateState,
    IPC.checkForApplicationUpdates,
    IPC.restartToApplyApplicationUpdate,
    IPC.chooseCertificatePair,
    IPC.prepareStopAllJobs,
    IPC.listExecutionCatalog,
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

  it("opens and claims only main-owned managed-shell windows with exact renderer identity", async () => {
    const open = vi.fn(async () => ({ ok: true as const }));
    const claim = vi.fn(async () => ({ ok: false as const, error: "claim probe" }));
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL, { open, claim });
    const { event } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const resourceId = "P".repeat(43);

    await expect(electronMocks.handlers.get(IPC.openSessionShellWindow)?.(event, {
      preferredResourceId: resourceId,
    })).resolves.toEqual({ ok: true });
    await expect(electronMocks.handlers.get(IPC.claimSessionShellWindow)?.(event)).resolves.toEqual({
      ok: false,
      error: "claim probe",
    });
    expect(open).toHaveBeenCalledWith(
      { contentsId: 77, rendererProcessId: 100, rendererFrameToken: "main-frame" },
      { preferredResourceId: resourceId },
    );
    expect(claim).toHaveBeenCalledWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });

    expect(() => electronMocks.handlers.get(IPC.openSessionShellWindow)?.(event, {
      preferredResourceId: "not-an-opaque-resource",
    })).toThrow(/invalid open managed-shell window input/i);
    expect(() => electronMocks.handlers.get(IPC.openSessionShellWindow)?.(event, {
      preferredResourceId: resourceId,
      targetId: "attacker-selected-session",
    })).toThrow(/invalid open managed-shell window input/i);
    expect(() => electronMocks.handlers.get(IPC.claimSessionShellWindow)?.(event, {})).toThrow(
      /invalid arguments/i,
    );
  });

  it("opens, claims, and attaches a console without renderer-authored profile material", async () => {
    const open = vi.fn(async () => ({ ok: true as const }));
    const context = {
      kind: "console" as const,
      configName: "Production",
      shortcutModifier: "Command" as const,
      initialTab: {
        tabId: "T".repeat(43),
        attachmentToken: "C".repeat(43),
        label: "Console 1",
      },
    };
    const claim = vi.fn(async () => ({ ok: true as const, value: context }));
    const nextTab = {
      tabId: "N".repeat(43),
      attachmentToken: "E".repeat(43),
      label: "Console 2",
    };
    const createTab = vi.fn(async () => ({ ok: true as const, value: nextTab }));
    const closeResult = { remainingTabs: 1 };
    const closeTab = vi.fn(async () => ({ ok: true as const, value: closeResult }));
    const attach = vi.fn();
    registerIpcHandlers(
      registryMock(),
      vi.fn(),
      RENDERER_URL,
      undefined,
      undefined,
      undefined,
      undefined,
      { open, claim, createTab, closeTab, attach },
    );
    const trusted = invokeEvent("http://127.0.0.1:5173/", 77);

    await expect(electronMocks.handlers.get(IPC.openConsoleWindow)?.(trusted.event)).resolves.toEqual({ ok: true });
    await expect(electronMocks.handlers.get(IPC.claimConsoleWindow)?.(trusted.event)).resolves.toEqual({
      ok: true,
      value: context,
    });
    await expect(electronMocks.handlers.get(IPC.createConsoleTab)?.(trusted.event)).resolves.toEqual({
      ok: true,
      value: nextTab,
    });
    await expect(electronMocks.handlers.get(IPC.closeConsoleTab)?.(
      trusted.event,
      nextTab.tabId,
    )).resolves.toEqual({ ok: true, value: closeResult });
    expect(open).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });
    expect(claim).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });
    expect(createTab).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });
    expect(closeTab).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    }, nextTab.tabId);
    expect(() => electronMocks.handlers.get(IPC.openConsoleWindow)?.(trusted.event, {
      configPath: "/tmp/attacker.cfg",
    })).toThrow(/invalid arguments/iu);
    expect(() => electronMocks.handlers.get(IPC.createConsoleTab)?.(trusted.event, {})).toThrow(/invalid arguments/iu);
    expect(() => electronMocks.handlers.get(IPC.closeConsoleTab)?.(trusted.event, "short")).toThrow(
      /invalid console tab ID/iu,
    );
    expect(closeTab).toHaveBeenCalledOnce();

    const port = messagePort();
    const request = { v: 1 as const, attachmentToken: "D".repeat(43) };
    requireConsoleStreamListener()(streamEvent("http://127.0.0.1:5173/", 77, [port]).event, request);
    expect(attach).toHaveBeenCalledExactlyOnceWith(
      { contentsId: 77, rendererProcessId: 100, rendererFrameToken: "main-frame" },
      request,
      port,
    );
    expect(Object.isFrozen(attach.mock.calls[0]?.[1])).toBe(true);

    const rejected = messagePort();
    requireConsoleStreamListener()(streamEvent("http://127.0.0.1:5173/", 77, [rejected]).event, {
      ...request,
      configPath: "/tmp/attacker.cfg",
    });
    expect(rejected.close).toHaveBeenCalledOnce();
    expect(attach).toHaveBeenCalledOnce();
  });

  it("opens and claims an interaction window only for the exact trusted main-frame identity", async () => {
    const open = vi.fn(async () => ({ ok: true as const }));
    const claim = vi.fn(async () => ({ ok: false as const, error: "claim probe" }));
    const selectTarget = vi.fn(async () => ({ ok: false as const, error: "selection probe" }));
    registerIpcHandlers(
      registryMock(),
      vi.fn(),
      RENDERER_URL,
      undefined,
      undefined,
      { open, claim, selectTarget },
    );
    const trusted = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);

    await expect(
      electronMocks.handlers.get(IPC.openInteractionWindow)?.(trusted.event),
    ).resolves.toEqual({ ok: true });
    expect(open).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });
    await expect(
      electronMocks.handlers.get(IPC.claimInteractionWindow)?.(trusted.event),
    ).resolves.toEqual({ ok: false, error: "claim probe" });
    expect(claim).toHaveBeenCalledExactlyOnceWith({
      contentsId: 77,
      rendererProcessId: 100,
      rendererFrameToken: "main-frame",
    });

    expect(() => electronMocks.handlers.get(IPC.openInteractionWindow)?.(
      trusted.event,
      { targetId: "attacker-selected-session" },
    )).toThrow(/invalid arguments/i);
    expect(() => electronMocks.handlers.get(IPC.claimInteractionWindow)?.(
      trusted.event,
      { targetId: "attacker-selected-session" },
    )).toThrow(/invalid arguments/i);

    const untrusted = invokeEvent("http://127.0.0.1:5173.evil.test/", 88);
    expect(() => electronMocks.handlers.get(IPC.openInteractionWindow)?.(untrusted.event)).toThrow(
      /untrusted renderer/i,
    );
    expect(() => electronMocks.handlers.get(IPC.claimInteractionWindow)?.(untrusted.event)).toThrow(
      /untrusted renderer/i,
    );

    const child = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 99);
    Object.defineProperty(child.event, "senderFrame", {
      value: { ...child.mainFrame, frameToken: "child-frame" } as WebFrameMain,
    });
    expect(() => electronMocks.handlers.get(IPC.openInteractionWindow)?.(child.event)).toThrow(
      /untrusted renderer/i,
    );
    expect(() => electronMocks.handlers.get(IPC.claimInteractionWindow)?.(child.event)).toThrow(
      /untrusted renderer/i,
    );

    const wrongProcess = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 100);
    Object.defineProperty(wrongProcess.event, "senderFrame", {
      value: { ...wrongProcess.mainFrame, processId: 101 } as WebFrameMain,
    });
    expect(() => electronMocks.handlers.get(IPC.claimInteractionWindow)?.(wrongProcess.event)).toThrow(
      /untrusted renderer/i,
    );
    expect(open).toHaveBeenCalledOnce();
    expect(claim).toHaveBeenCalledOnce();
  });

  it("rejects interaction claims when no main-owned controller recognizes the window", async () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/?surface=interaction", 77);

    expect(electronMocks.handlers.get(IPC.claimInteractionWindow)?.(event)).toEqual({
      ok: false,
      error: "This window is not authorized to host an interaction workspace",
    });
  });

  it("routes target selection through the interaction controller when one is installed", async () => {
    const registrySelectTarget = vi.fn(async () => ({ ok: false as const, error: "registry probe" }));
    const controllerSelectTarget = vi.fn(async () => ({ ok: false as const, error: "controller probe" }));
    registerIpcHandlers(
      registryMock({ selectTarget: registrySelectTarget }),
      vi.fn(),
      RENDERER_URL,
      undefined,
      undefined,
      {
        open: vi.fn(async () => ({ ok: true as const })),
        claim: vi.fn(async () => ({ ok: false as const, error: "claim probe" })),
        selectTarget: controllerSelectTarget,
      },
    );
    const { event } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const target = {
      mode: "session",
      id: "session_2",
      backendEpoch: 3,
      domainRevision: 8,
      fingerprint: "b".repeat(64),
    } as const;

    await expect(electronMocks.handlers.get(IPC.selectTarget)?.(event, target)).resolves.toEqual({
      ok: false,
      error: "controller probe",
    });
    expect(controllerSelectTarget).toHaveBeenCalledExactlyOnceWith(
      { contentsId: 77, rendererProcessId: 100, rendererFrameToken: "main-frame" },
      target,
    );
    expect(registrySelectTarget).not.toHaveBeenCalled();
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

  it("routes only closed session-workbench operations and main-owned action plans", async () => {
    const runSessionWorkbench = vi.fn(async () => ({ ok: false as const, error: "workbench probe" }));
    const prepareSessionDestructiveAction = vi.fn(async () => ({ ok: false as const, error: "review probe" }));
    const executeSessionDestructiveActionPlan = vi.fn(async () => ({ ok: false as const, error: "execute probe" }));
    registerIpcHandlers(
      registryMock({
        runSessionWorkbench,
        prepareSessionDestructiveAction,
        executeSessionDestructiveActionPlan,
      }),
      vi.fn(),
      RENDERER_URL,
    );
    const { event, sender } = invokeEvent("http://127.0.0.1:5173/sessions", 77);
    const planToken = "8e577480-5dc2-4dde-aa58-23c8f1770627";

    await electronMocks.handlers.get(IPC.runSessionWorkbench)?.(event, {
      operationId: "session.filesystem.ls",
      path: "/tmp",
      limit: 100,
    });
    await electronMocks.handlers.get(IPC.prepareSessionDestructiveAction)?.(event, {
      actionId: "session.filesystem.rm",
      path: "/tmp/reviewed",
      recursive: false,
      force: false,
    });
    await electronMocks.handlers.get(IPC.executeSessionDestructiveActionPlan)?.(event, { token: planToken });

    expect(runSessionWorkbench).toHaveBeenCalledWith(sender, {
      operationId: "session.filesystem.ls",
      path: "/tmp",
      limit: 100,
    });
    expect(prepareSessionDestructiveAction).toHaveBeenCalledWith(77, {
      actionId: "session.filesystem.rm",
      path: "/tmp/reviewed",
      recursive: false,
      force: false,
    });
    expect(executeSessionDestructiveActionPlan).toHaveBeenCalledWith(77, planToken);

    expect(() => electronMocks.handlers.get(IPC.runSessionWorkbench)?.(event, {
      operationId: "session.shell.execute",
      command: "whoami",
    })).toThrow(/unknown session workbench operation/i);
    expect(() => electronMocks.handlers.get(IPC.runSessionWorkbench)?.(event, {
      operationId: "session.filesystem.pwd",
      sessionId: "attacker-selected-session",
    })).toThrow(/unexpected session input field/i);
    expect(() => electronMocks.handlers.get(IPC.prepareSessionDestructiveAction)?.(event, {
      actionId: "sessions.kill-all",
    })).toThrow(/unknown session destructive action/i);
    expect(() => electronMocks.handlers.get(IPC.executeSessionDestructiveActionPlan)?.(event, {
      token: planToken,
      targetId: "session_1",
    })).toThrow(/unexpected session input field/i);
  });

  it("parses shell invokes and binds preparation to the exact renderer document", async () => {
    const prepareSessionShell = vi.fn(async () => ({ ok: false as const, error: "prepare probe" }));
    const listSessionShells = vi.fn(async () => ({ ok: false as const, error: "list probe" }));
    const actOnSessionShell = vi.fn(async () => ({ ok: false as const, error: "action probe" }));
    const getTerminalRuntime = vi.fn(async () => ({ ok: false as const, error: "runtime probe" }));
    registerIpcHandlers(
      registryMock({ prepareSessionShell, listSessionShells, actOnSessionShell, getTerminalRuntime }),
      vi.fn(),
      RENDERER_URL,
    );
    const { event } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const resourceId = "R".repeat(43);

    await electronMocks.handlers.get(IPC.prepareSessionShell)?.(event, {
      path: "/bin/zsh",
      requestPty: true,
      rows: 30,
      columns: 100,
    });
    await electronMocks.handlers.get(IPC.listSessionShells)?.(event, {});
    await electronMocks.handlers.get(IPC.actOnSessionShell)?.(event, { resourceId, action: "attach" });
    await electronMocks.handlers.get(IPC.getTerminalRuntime)?.(event);

    expect(prepareSessionShell).toHaveBeenCalledWith(77, 100, "main-frame", {
      path: "/bin/zsh",
      requestPty: true,
      rows: 30,
      columns: 100,
    });
    expect(listSessionShells).toHaveBeenCalledWith(77, 100, "main-frame", {});
    expect(actOnSessionShell).toHaveBeenCalledWith(77, 100, "main-frame", { resourceId, action: "attach" });
    expect(getTerminalRuntime).toHaveBeenCalledWith(77);

    expect(() => electronMocks.handlers.get(IPC.prepareSessionShell)?.(event, {
      requestPty: false,
      rows: 30,
      columns: 100,
    })).toThrow(/dimensions require requestPty/i);
    expect(() => electronMocks.handlers.get(IPC.listSessionShells)?.(event, { targetId: "session_1" })).toThrow(
      /unexpected .* field/i,
    );
    expect(() => electronMocks.handlers.get(IPC.actOnSessionShell)?.(event, {
      resourceId,
      action: "raw-tunnel",
    })).toThrow(/unsupported/i);
  });

  it("routes only strictly parsed execution operations through the trusted window boundary", async () => {
    const listExecutionCatalog = vi.fn(async () => ({ ok: false as const, error: "catalog probe" }));
    const runExecutionRead = vi.fn(async () => ({ ok: false as const, error: "read probe" }));
    const prepareExecutionAction = vi.fn(async () => ({ ok: false as const, error: "prepare probe" }));
    const executeExecutionPlan = vi.fn(async () => ({ ok: false as const, error: "execute probe" }));
    const discardExecutionPlan = vi.fn(async () => ({ ok: false as const, error: "discard probe" }));
    const getExecutionResult = vi.fn(async () => ({ ok: false as const, error: "result probe" }));
    const saveExecutionResult = vi.fn(async () => ({ ok: false as const, error: "save probe" }));
    registerIpcHandlers(
      registryMock({
        listExecutionCatalog,
        runExecutionRead,
        prepareExecutionAction,
        executeExecutionPlan,
        discardExecutionPlan,
        getExecutionResult,
        saveExecutionResult,
      }),
      vi.fn(),
      RENDERER_URL,
    );
    const { event, sender } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const action = { draft: { operationId: "privilege.revert" as const, timeoutSeconds: 30 } };
    const plan = { token: "execution_plan_1" };
    const request = { requestId: "execution_request_1" };
    const save = { ...request, stream: "combined" as const };

    await electronMocks.handlers.get(IPC.listExecutionCatalog)?.(event);
    await electronMocks.handlers.get(IPC.runExecutionRead)?.(event, {
      operationId: "execution.children",
      cursor: "children_page_2",
      limit: 25,
    });
    await electronMocks.handlers.get(IPC.prepareExecutionAction)?.(event, action);
    await electronMocks.handlers.get(IPC.executeExecutionPlan)?.(event, plan);
    await electronMocks.handlers.get(IPC.discardExecutionPlan)?.(event, plan);
    await electronMocks.handlers.get(IPC.getExecutionResult)?.(event, request);
    await electronMocks.handlers.get(IPC.saveExecutionResult)?.(event, save);

    expect(listExecutionCatalog).toHaveBeenCalledExactlyOnceWith(77);
    expect(runExecutionRead).toHaveBeenCalledExactlyOnceWith(77, {
      operationId: "execution.children",
      cursor: "children_page_2",
      limit: 25,
    });
    expect(prepareExecutionAction).toHaveBeenCalledExactlyOnceWith(sender, action);
    expect(executeExecutionPlan).toHaveBeenCalledExactlyOnceWith(77, plan);
    expect(discardExecutionPlan).toHaveBeenCalledExactlyOnceWith(77, plan);
    expect(getExecutionResult).toHaveBeenCalledExactlyOnceWith(77, request);
    expect(saveExecutionResult).toHaveBeenCalledExactlyOnceWith(sender, save);
  });

  it("scrubs every raw credential view after successful prepare while retaining the parsed copy", async () => {
    const parsedCredentials: Uint8Array[] = [];
    const prepareExecutionAction = vi.fn(async (_sender: WebContents, input: PrepareExecutionActionInput) => {
      parsedCredentials.push(executionCredential(input));
      return { ok: true as const, value: {} as never };
    });
    registerIpcHandlers(registryMock({ prepareExecutionAction }), vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const secretText = "main-clone-secret";
    const drafts = [
      (password: Uint8Array) => ({
        operationId: "privilege.run-as",
        username: "operator",
        domain: "LAB",
        password,
        process: "cmd.exe",
        args: "/c whoami",
        showWindow: false,
        netOnly: false,
        timeoutSeconds: 30,
      }),
      (password: Uint8Array) => ({
        operationId: "privilege.make-token",
        username: "operator",
        domain: "LAB",
        password,
        logonType: "new-credentials",
        timeoutSeconds: 30,
      }),
      (password: Uint8Array) => ({
        operationId: "execution.ssh",
        hostname: "server",
        port: 22,
        username: "operator",
        command: ["id"],
        authentication: { kind: "password", password },
        timeoutSeconds: 30,
      }),
    ];

    for (const draft of drafts) {
      const rawPassword = Uint8Array.from(Buffer.from(secretText, "utf8"));
      const pending = electronMocks.handlers.get(IPC.prepareExecutionAction)?.(event, {
        draft: draft(rawPassword),
      }) as Promise<unknown>;

      expect(isZeroBytes(rawPassword)).toBe(true);
      await pending;
      const parsedPassword = parsedCredentials.at(-1);
      expect(parsedPassword).toBeDefined();
      expect(parsedPassword).not.toBe(rawPassword);
      expect(Buffer.from(parsedPassword!).toString("utf8")).toBe(secretText);
      parsedPassword?.fill(0);
    }
  });

  it("scrubs parsed credential copies when prepare fails or throws", async () => {
    const secretText = "failed-prepare-secret";
    for (const outcome of ["failure", "throw"] as const) {
      let parsedPassword: Uint8Array | undefined;
      const prepareExecutionAction = vi.fn(async (_sender: WebContents, input: PrepareExecutionActionInput) => {
        parsedPassword = executionCredential(input);
        if (outcome === "throw") throw new Error("prepare failed without credential detail");
        return { ok: false as const, error: "prepare failed" };
      });
      registerIpcHandlers(registryMock({ prepareExecutionAction }), vi.fn(), RENDERER_URL);
      const { event } = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
      const rawPassword = Uint8Array.from(Buffer.from(secretText, "utf8"));
      const pending = electronMocks.handlers.get(IPC.prepareExecutionAction)?.(event, {
        draft: {
          operationId: "privilege.make-token",
          username: "operator",
          domain: "LAB",
          password: rawPassword,
          logonType: "new-credentials",
          timeoutSeconds: 30,
        },
      }) as Promise<unknown>;

      expect(isZeroBytes(rawPassword)).toBe(true);
      if (outcome === "throw") {
        await expect(pending).rejects.toThrow("prepare failed without credential detail");
        await expect(pending).rejects.not.toThrow(secretText);
      } else {
        await expect(pending).resolves.toEqual({ ok: false, error: "prepare failed" });
      }
      expect(parsedPassword).toBeDefined();
      expect(isZeroBytes(parsedPassword!)).toBe(true);
    }
  });

  it("scrubs credential-shaped raw views on parse and trust rejection without exposing their contents", () => {
    const prepareExecutionAction = vi.fn(async () => ({ ok: false as const, error: "prepare probe" }));
    registerIpcHandlers(registryMock({ prepareExecutionAction }), vi.fn(), RENDERER_URL);
    const trusted = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const untrusted = invokeEvent("http://127.0.0.1:5173.evil.test/sessions/session_1", 88);
    const secretText = "rejected-boundary-secret";
    const malformedPassword = Uint8Array.from(Buffer.from(secretText, "utf8"));

    let parseFailure: unknown;
    try {
      electronMocks.handlers.get(IPC.prepareExecutionAction)?.(trusted.event, {
        draft: { operationId: "invalid-operation", password: malformedPassword },
      });
    } catch (error) {
      parseFailure = error;
    }
    expect(parseFailure).toBeInstanceOf(TypeError);
    expect(String(parseFailure)).not.toContain(secretText);
    expect(isZeroBytes(malformedPassword)).toBe(true);

    const untrustedPassword = Uint8Array.from(Buffer.from(secretText, "utf8"));
    let trustFailure: unknown;
    try {
      electronMocks.handlers.get(IPC.prepareExecutionAction)?.(untrusted.event, {
        draft: {
          operationId: "execution.ssh",
          hostname: "server",
          port: 22,
          username: "operator",
          command: ["id"],
          authentication: { kind: "password", password: untrustedPassword },
          timeoutSeconds: 30,
        },
      });
    } catch (error) {
      trustFailure = error;
    }
    expect(String(trustFailure)).toMatch(/untrusted renderer/i);
    expect(String(trustFailure)).not.toContain(secretText);
    expect(isZeroBytes(untrustedPassword)).toBe(true);
    expect(prepareExecutionAction).not.toHaveBeenCalled();
  });

  it("rejects untrusted and over-posted execution requests before registry dispatch", () => {
    const runExecutionRead = vi.fn(async () => ({ ok: false as const, error: "read probe" }));
    const prepareExecutionAction = vi.fn(async () => ({ ok: false as const, error: "prepare probe" }));
    const executeExecutionPlan = vi.fn(async () => ({ ok: false as const, error: "execute probe" }));
    const discardExecutionPlan = vi.fn(async () => ({ ok: false as const, error: "discard probe" }));
    const getExecutionResult = vi.fn(async () => ({ ok: false as const, error: "result probe" }));
    const saveExecutionResult = vi.fn(async () => ({ ok: false as const, error: "save probe" }));
    registerIpcHandlers(
      registryMock({
        runExecutionRead,
        prepareExecutionAction,
        executeExecutionPlan,
        discardExecutionPlan,
        getExecutionResult,
        saveExecutionResult,
      }),
      vi.fn(),
      RENDERER_URL,
    );
    const trusted = invokeEvent("http://127.0.0.1:5173/sessions/session_1", 77);
    const untrusted = invokeEvent("http://127.0.0.1:5173.evil.test/sessions/session_1", 88);

    expect(() => electronMocks.handlers.get(IPC.runExecutionRead)?.(untrusted.event, {
      operationId: "execution.children",
    })).toThrow(/untrusted renderer/i);
    expect(() => electronMocks.handlers.get(IPC.prepareExecutionAction)?.(trusted.event, {
      draft: { operationId: "privilege.revert", timeoutSeconds: 30, targetId: "session_2" },
    })).toThrow(/unexpected field: targetId/i);
    expect(() => electronMocks.handlers.get(IPC.executeExecutionPlan)?.(trusted.event, {
      token: "execution_plan_1",
      operationId: "privilege.revert",
    })).toThrow(/unexpected field: operationId/i);
    expect(() => electronMocks.handlers.get(IPC.discardExecutionPlan)?.(trusted.event, {
      token: "execution_plan_1",
      targetId: "session_2",
    })).toThrow(/unexpected field: targetId/i);
    expect(() => electronMocks.handlers.get(IPC.getExecutionResult)?.(trusted.event, {
      requestId: "execution_request_1",
      outputPath: "/tmp/secret",
    })).toThrow(/unexpected field: outputPath/i);
    expect(() => electronMocks.handlers.get(IPC.saveExecutionResult)?.(trusted.event, {
      requestId: "execution_request_1",
      stream: "combined",
      destinationPath: "/tmp/secret",
    })).toThrow(/unexpected field: destinationPath/i);

    expect(runExecutionRead).not.toHaveBeenCalled();
    expect(prepareExecutionAction).not.toHaveBeenCalled();
    expect(executeExecutionPlan).not.toHaveBeenCalled();
    expect(discardExecutionPlan).not.toHaveBeenCalled();
    expect(getExecutionResult).not.toHaveBeenCalled();
    expect(saveExecutionResult).not.toHaveBeenCalled();
  });

  it("transfers one validated stream port with the exact main-frame identity", () => {
    const attachStream = vi.fn();
    registerIpcHandlers(registryMock({ attachStream }), vi.fn(), RENDERER_URL);
    const port = messagePort();
    const { event } = streamEvent("http://127.0.0.1:5173/sessions/session_1", 77, [port]);
    const request = { v: 1 as const, attachmentToken: "A".repeat(43) };

    requireStreamListener()(event, request);

    expect(attachStream).toHaveBeenCalledExactlyOnceWith(77, 100, "main-frame", request, port);
    expect(Object.isFrozen(attachStream.mock.calls[0]?.[3])).toBe(true);
    expect(port.close).not.toHaveBeenCalled();
  });

  it("rejects hostile stream senders and closes their transferred capability", () => {
    const attachStream = vi.fn();
    registerIpcHandlers(registryMock({ attachStream }), vi.fn(), RENDERER_URL);
    const request = { v: 1 as const, attachmentToken: "A".repeat(43) };
    const hostilePort = messagePort();
    const hostile = streamEvent("http://127.0.0.1:5173.evil.test/", 77, [hostilePort]);

    requireStreamListener()(hostile.event, request);

    const childPort = messagePort();
    const child = streamEvent("http://127.0.0.1:5173/", 77, [childPort]);
    Object.defineProperty(child.event, "senderFrame", {
      value: { ...child.mainFrame, frameToken: "child-frame" } as WebFrameMain,
    });
    requireStreamListener()(child.event, request);

    expect(attachStream).not.toHaveBeenCalled();
    expect(hostilePort.close).toHaveBeenCalledOnce();
    expect(childPort.close).toHaveBeenCalledOnce();
  });

  it("rejects zero or multiple stream ports and attempts to close every supplied port", () => {
    const attachStream = vi.fn();
    registerIpcHandlers(registryMock({ attachStream }), vi.fn(), RENDERER_URL);
    const request = { v: 1 as const, attachmentToken: "A".repeat(43) };
    const empty = streamEvent("http://127.0.0.1:5173/", 77, []);
    requireStreamListener()(empty.event, request);

    const first = messagePort(() => {
      throw new Error("already closed");
    });
    const second = messagePort();
    const multiple = streamEvent("http://127.0.0.1:5173/", 77, [first, second]);
    requireStreamListener()(multiple.event, request);

    expect(attachStream).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).toHaveBeenCalledOnce();
  });

  it("closes the transferred port when the attachment request is malformed", () => {
    const attachStream = vi.fn();
    registerIpcHandlers(registryMock({ attachStream }), vi.fn(), RENDERER_URL);
    const port = messagePort();
    const { event } = streamEvent("http://127.0.0.1:5173/", 77, [port]);

    requireStreamListener()(event, {
      v: 1,
      attachmentToken: "A".repeat(43),
      tunnelId: 7,
    });

    expect(attachStream).not.toHaveBeenCalled();
    expect(port.close).toHaveBeenCalledOnce();
  });

  it("delegates attachment-token replay detection to the main-owned registry", () => {
    const attachStream = vi.fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("replayed token");
      });
    registerIpcHandlers(registryMock({ attachStream }), vi.fn(), RENDERER_URL);
    const request = { v: 1 as const, attachmentToken: "A".repeat(43) };
    const first = messagePort();
    const second = messagePort();

    requireStreamListener()(streamEvent("http://127.0.0.1:5173/", 77, [first]).event, request);
    requireStreamListener()(streamEvent("http://127.0.0.1:5173/", 77, [second]).event, request);

    expect(attachStream).toHaveBeenCalledTimes(2);
    expect(first.close).not.toHaveBeenCalled();
    expect(second.close).toHaveBeenCalledOnce();
  });
});

function executionCredential(input: PrepareExecutionActionInput): Uint8Array {
  switch (input.draft.operationId) {
    case "execution.ssh":
      if (input.draft.authentication.kind !== "password") throw new Error("Expected SSH password credentials");
      return input.draft.authentication.password;
    case "privilege.run-as":
    case "privilege.make-token":
      return input.draft.password;
    default:
      throw new Error("Expected credential-bearing execution draft");
  }
}

function isZeroBytes(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

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
    runSessionWorkbench: vi.fn(unavailable),
    prepareSessionDestructiveAction: vi.fn(unavailable),
    executeSessionDestructiveActionPlan: vi.fn(unavailable),
    prepareSessionShell: vi.fn(unavailable),
    listSessionShells: vi.fn(unavailable),
    actOnSessionShell: vi.fn(unavailable),
    getTerminalRuntime: vi.fn(unavailable),
    listExecutionCatalog: vi.fn(unavailable),
    runExecutionRead: vi.fn(unavailable),
    prepareExecutionAction: vi.fn(unavailable),
    executeExecutionPlan: vi.fn(unavailable),
    discardExecutionPlan: vi.fn(unavailable),
    getExecutionResult: vi.fn(unavailable),
    saveExecutionResult: vi.fn(unavailable),
    attachStream: vi.fn(),
    ...overrides,
  };
}

function requireStreamListener(): (event: IpcMainEvent, ...args: unknown[]) => void {
  const listener = electronMocks.listeners.get(IPC.attach);
  if (!listener) throw new Error("Expected the stream attach listener to be registered");
  return listener;
}

function requireConsoleStreamListener(): (event: IpcMainEvent, ...args: unknown[]) => void {
  const listener = electronMocks.listeners.get(IPC.attachConsole);
  if (!listener) throw new Error("Expected the console stream attach listener to be registered");
  return listener;
}

function messagePort(closeImplementation?: () => void): MessagePortMain & { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn(closeImplementation);
  return { close } as unknown as MessagePortMain & { close: ReturnType<typeof vi.fn> };
}

function streamEvent(
  url: string,
  contentsId: number,
  ports: readonly MessagePortMain[],
): {
  event: IpcMainEvent;
  mainFrame: WebFrameMain;
  sender: WebContents;
} {
  const { mainFrame, sender } = invokeEvent(url, contentsId);
  return {
    event: {
      sender,
      senderFrame: mainFrame,
      ports,
    } as IpcMainEvent,
    mainFrame,
    sender,
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
