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

  it("registers and unregisters exactly one dedicated stream-port listener", () => {
    registerIpcHandlers(registryMock(), vi.fn(), RENDERER_URL);
    const listener = electronMocks.listeners.get(IPC.attach);

    expect(listener).toBeTypeOf("function");
    expect(electronMocks.on).toHaveBeenCalledExactlyOnceWith(IPC.attach, listener);

    unregisterIpcHandlers();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.attach, listener);
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
    IPC.exitApp,
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
    attachStream: vi.fn(),
    ...overrides,
  };
}

function requireStreamListener(): (event: IpcMainEvent, ...args: unknown[]) => void {
  const listener = electronMocks.listeners.get(IPC.attach);
  if (!listener) throw new Error("Expected the stream attach listener to be registered");
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
