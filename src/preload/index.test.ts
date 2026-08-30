// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  IPC,
  IPC_INVOKE,
  type IpcInvokeArgs,
  type SliverDesktopAPI,
} from "../shared/contracts.js";
import { defaultGenerateInput } from "../shared/generate-defaults.js";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";

type InvokeArgumentsByMethod = {
  [Method in keyof typeof IPC_INVOKE]: IpcInvokeArgs<(typeof IPC_INVOKE)[Method]>;
};

const invokeArguments = {
  chooseConfig: [],
  importConfig: [{ displayName: "local test" }],
  listSavedConfigs: [],
  connectSavedConfig: ["3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2"],
  removeSavedConfig: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2" }],
  disconnect: [],
  getSnapshot: [],
  refresh: [],
  listLocalNetworkInterfaces: [],
  openWindow: [{ inheritConnection: true }],
  openInteractionWindow: [],
  claimInteractionWindow: [],
  exitApp: [],
  getApplicationSettings: [],
  updateApplicationSettings: [{
    expectedRevision: 0,
    settings: {
      theme: DEFAULT_APPLICATION_SETTINGS_STATE.theme,
      reduceMotion: DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
      terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
    },
  }],
  getApplicationUpdateState: [],
  checkForApplicationUpdates: [],
  restartToApplyApplicationUpdate: [],
  openSessionShellWindow: [{ preferredResourceId: "R".repeat(43) }],
  claimSessionShellWindow: [],
  openConsoleWindow: [],
  claimConsoleWindow: [],
  createConsoleTab: [],
  closeConsoleTab: ["T".repeat(43)],
  chooseCertificatePair: [],
  startListener: [{ kind: "mtls", host: "127.0.0.1", port: 8888 }],
  prepareStopJob: [7],
  prepareStopAllJobs: [],
  executeStopPlan: ["8e577480-5dc2-4dde-aa58-23c8f1770627"],
  generate: [defaultGenerateInput],
  generateFromProfile: [{ profileName: "default", name: "test" }],
  downloadBuild: ["existing-build"],
  deleteBuild: ["existing-build"],
  setStagedBuilds: [["existing-build"]],
  saveProfile: [{ profileName: "default", config: defaultGenerateInput, overwrite: false }],
  deleteProfile: ["default"],
  listTargets: [{ mode: "session", limit: 100, query: "prod-mac" }],
  selectTarget: [{
    mode: "session",
    id: "session_1",
    backendEpoch: 1,
    domainRevision: 1,
    fingerprint: "a".repeat(64),
  }],
  backgroundTarget: [],
  setBeaconWatch: [{ enabled: true }],
  submitTargetOperation: [{ operationId: "target.ping" }],
  listTargetOperations: [{}],
  getTargetOperation: [{ requestId: "request_1" }],
  cancelTargetOperation: [{ requestId: "request_1" }],
  prepareTargetAction: [{ actionId: "target.kill" }],
  executeTargetActionPlan: [{ token: "8e577480-5dc2-4dde-aa58-23c8f1770627" }],
  listBeaconTasks: [{}],
  getBeaconTask: [{ taskId: "task_1" }],
  cancelBeaconTask: [{ taskId: "task_1" }],
  runSessionWorkbench: [{ operationId: "session.filesystem.pwd" }],
  prepareSessionDestructiveAction: [{
    actionId: "session.filesystem.rm",
    path: "/tmp/m2-test",
    recursive: false,
    force: false,
  }],
  executeSessionDestructiveActionPlan: [{ token: "8e577480-5dc2-4dde-aa58-23c8f1770627" }],
  prepareSessionShell: [{ path: "/bin/zsh", requestPty: true, rows: 30, columns: 100 }],
  listSessionShells: [{}],
  actOnSessionShell: [{ resourceId: "R".repeat(43), action: "attach" }],
  getTerminalRuntime: [],
  listExecutionCatalog: [],
  runExecutionRead: [{ operationId: "execution.children" }],
  prepareExecutionAction: [{ draft: { operationId: "privilege.revert", timeoutSeconds: 30 } }],
  executeExecutionPlan: [{ token: "execution_plan_1" }],
  discardExecutionPlan: [{ token: "execution_plan_1" }],
  getExecutionResult: [{ requestId: "execution_request_1" }],
  saveExecutionResult: [{ requestId: "execution_request_1", stream: "combined" }],
} satisfies InvokeArgumentsByMethod;

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: SliverDesktopAPI) => void>(),
  invoke: vi.fn((channel: string, ...args: unknown[]) => ({ channel, args })),
  postMessage: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    postMessage: electronMocks.postMessage,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

const createdChannels: TestMessageChannel[] = [];

class TestMessageChannel {
  readonly port1 = { close: vi.fn() };
  readonly port2 = { close: vi.fn() };

  constructor() {
    createdChannels.push(this);
  }
}

const windowPostMessage = vi.fn();
vi.stubGlobal("MessageChannel", TestMessageChannel);
vi.stubGlobal("window", { postMessage: windowPostMessage });

await import("./index.js");

describe("sandboxed preload bridge", () => {
  it("exposes frozen saved-config methods using only their dedicated IPC channels", async () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledOnce();
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [name, exposed] = call;
    expect(name).toBe("sliver");
    expect(Object.isFrozen(exposed)).toBe(true);

    await exposed.listSavedConfigs();
    await exposed.connectSavedConfig("3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2");

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, IPC.listSavedConfigs);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(
      2,
      IPC.connectSavedConfig,
      "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2",
    );
  });

  it("routes every invoke method through its same-named shared channel", async () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;

    expect(Object.keys(exposed).sort()).toEqual([
      ...Object.keys(IPC_INVOKE),
      "onSnapshotChanged",
      "onOperationChanged",
      "onBeaconTasksInvalidated",
      "onSessionShellsChanged",
      "onReleaseDownloadChanged",
      "onApplicationUpdateChanged",
      "onApplicationSettingsChanged",
      "onConsoleNewTabRequested",
      "onConsoleCloseTabRequested",
      "onConsoleSelectTabRequested",
      "onConsoleSettingsRequested",
      "openStream",
      "openConsoleStream",
    ].sort());
    for (const method of Object.keys(IPC_INVOKE) as Array<keyof typeof IPC_INVOKE>) {
      electronMocks.invoke.mockClear();
      const args: readonly unknown[] = invokeArguments[method];
      await Reflect.apply(exposed[method], exposed, args);
      expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(IPC_INVOKE[method], ...args);
    }
  });

  it("opens and claims a dedicated interaction window without renderer-authored target arguments", async () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    electronMocks.invoke.mockClear();

    await exposed.openInteractionWindow();
    await exposed.claimInteractionWindow();

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, IPC.openInteractionWindow);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, IPC.claimInteractionWindow);
  });

  it("keeps the preload allowlist narrow and exposes no raw Electron transport", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;

    expect(Object.keys(exposed).sort()).toEqual([
      ...Object.keys(IPC_INVOKE),
      "onSnapshotChanged",
      "onOperationChanged",
      "onBeaconTasksInvalidated",
      "onSessionShellsChanged",
      "onReleaseDownloadChanged",
      "onApplicationUpdateChanged",
      "onApplicationSettingsChanged",
      "onConsoleNewTabRequested",
      "onConsoleCloseTabRequested",
      "onConsoleSelectTabRequested",
      "onConsoleSettingsRequested",
      "openStream",
      "openConsoleStream",
    ].sort());
    expect(exposed).not.toHaveProperty("ipcRenderer");
    expect(exposed).not.toHaveProperty("send");
    expect(exposed).not.toHaveProperty("postMessage");
  });

  it("delivers only exact managed-shell invalidations and removes the listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onSessionShellsChanged(listener);
    expect(electronMocks.on).toHaveBeenCalledOnce();
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.sessionShellsChanged);
    if (typeof handler !== "function") throw new Error("Expected the managed-shell event handler");

    handler({} as Electron.IpcRendererEvent, undefined);
    handler({} as Electron.IpcRendererEvent, "R".repeat(43));
    handler({} as Electron.IpcRendererEvent, "!".repeat(43));
    handler({} as Electron.IpcRendererEvent, { resourceId: "R".repeat(43) });
    expect(listener.mock.calls).toEqual([[undefined], ["R".repeat(43)]]);

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      IPC.sessionShellsChanged,
      handler,
    );
  });

  it.each([
    ["onConsoleNewTabRequested", IPC.consoleNewTabRequested],
    ["onConsoleCloseTabRequested", IPC.consoleCloseTabRequested],
    ["onConsoleSettingsRequested", IPC.consoleSettingsRequested],
  ] as const)("delivers the fixed no-payload %s event and removes its listener", (method, channel) => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed[method](listener);
    expect(electronMocks.on).toHaveBeenCalledOnce();
    const [registeredChannel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(registeredChannel).toBe(channel);
    if (typeof handler !== "function") throw new Error("Expected a fixed console event handler");

    handler({} as Electron.IpcRendererEvent);
    handler({} as Electron.IpcRendererEvent, { attackerPayload: true });
    expect(listener).toHaveBeenCalledOnce();

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
  });

  it("delivers only one validated console-tab shortcut index and removes its listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onConsoleSelectTabRequested(listener);
    expect(electronMocks.on).toHaveBeenCalledOnce();
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.consoleSelectTabRequested);
    if (typeof handler !== "function") throw new Error("Expected a console-tab selection handler");

    handler({} as Electron.IpcRendererEvent, 0);
    handler({} as Electron.IpcRendererEvent, 9);
    handler({} as Electron.IpcRendererEvent, 10);
    handler({} as Electron.IpcRendererEvent, -1);
    handler({} as Electron.IpcRendererEvent, "1");
    handler({} as Electron.IpcRendererEvent, 1, 2);
    expect(listener.mock.calls).toEqual([[0], [9]]);

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
  });

  it("delivers only validated release-download progress events and removes the listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onReleaseDownloadChanged(listener);
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.releaseDownloadChanged);
    if (typeof handler !== "function") throw new Error("Expected the release-download event handler");
    const valid = {
      status: "progress",
      downloadId: "8e577480-5dc2-4dde-aa58-23c8f1770627",
      artifact: "server",
      os: "linux",
      arch: "amd64",
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      receivedBytes: 64,
      totalBytes: 128,
    };
    handler({} as Electron.IpcRendererEvent, valid);
    handler({} as Electron.IpcRendererEvent, { ...valid, destinationPath: "/Users/private/Downloads" });
    handler({} as Electron.IpcRendererEvent, { ...valid, receivedBytes: 129 });

    expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      IPC.releaseDownloadChanged,
      handler,
    );
  });

  it("delivers only exact bounded application-update states and removes the listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onApplicationUpdateChanged(listener);
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.applicationUpdateChanged);
    if (typeof handler !== "function") throw new Error("Expected the application-update event handler");
    const valid = {
      status: "downloading",
      revision: 4,
      currentVersion: "0.1.0",
      availableVersion: "0.2.0",
      progressPercent: 42.5,
    };
    handler({} as Electron.IpcRendererEvent, valid);
    handler({} as Electron.IpcRendererEvent, { ...valid, downloadUrl: "https://example.test/update" });
    handler({} as Electron.IpcRendererEvent, { ...valid, progressPercent: 101 });

    expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      IPC.applicationUpdateChanged,
      handler,
    );
  });

  it("delivers only exact application settings states and removes the listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onApplicationSettingsChanged(listener);
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.applicationSettingsChanged);
    if (typeof handler !== "function") throw new Error("Expected the application-settings event handler");
    const valid = { ...DEFAULT_APPLICATION_SETTINGS_STATE, revision: 4, theme: "light" };
    handler({} as Electron.IpcRendererEvent, valid);
    handler({} as Electron.IpcRendererEvent, { ...valid, untrustedPath: "/tmp/private" });
    handler({} as Electron.IpcRendererEvent, { ...valid, theme: "sepia" });

    expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0].terminal)).toBe(true);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      IPC.applicationSettingsChanged,
      handler,
    );
  });

  it("hands one port to main and one port to the document using the fixed envelope", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const attachmentToken = "A".repeat(43);
    const correlationId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockClear();

    exposed.openStream(attachmentToken, correlationId);

    const channel = createdChannels[0];
    if (!channel) throw new Error("Expected a MessageChannel");
    const mainRequest = { v: 1, attachmentToken };
    expect(electronMocks.postMessage).toHaveBeenCalledExactlyOnceWith(IPC.attach, mainRequest, [channel.port1]);
    expect(Object.isFrozen(electronMocks.postMessage.mock.calls[0]?.[1])).toBe(true);
    expect(windowPostMessage).toHaveBeenCalledExactlyOnceWith(
      {
        source: "sliver-preload",
        type: "stream-port",
        v: 1,
        correlationId,
      },
      "*",
      [channel.port2],
    );
    expect(Object.isFrozen(windowPostMessage.mock.calls[0]?.[0])).toBe(true);
    expect(electronMocks.postMessage.mock.invocationCallOrder[0]).toBeLessThan(
      windowPostMessage.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("keeps the native console on its distinct one-use port channel", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const attachmentToken = "C".repeat(43);
    const correlationId = "ed00ab45-4c21-48e8-9e4a-cb10241bb486";
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockClear();

    exposed.openConsoleStream(attachmentToken, correlationId);

    const channel = createdChannels[0];
    if (!channel) throw new Error("Expected a MessageChannel");
    expect(electronMocks.postMessage).toHaveBeenCalledExactlyOnceWith(
      IPC.attachConsole,
      { v: 1, attachmentToken },
      [channel.port1],
    );
    expect(windowPostMessage).toHaveBeenCalledExactlyOnceWith(
      {
        source: "sliver-preload",
        type: "console-stream-port",
        v: 1,
        correlationId,
      },
      "*",
      [channel.port2],
    );
  });

  it.each([
    ["short-token", "8e577480-5dc2-4dde-aa58-23c8f1770627"],
    ["A".repeat(43), "8e577480-5dc2-1dde-aa58-23c8f1770627"],
    ["A".repeat(43), "8e577480-5dc2-4dde-7a58-23c8f1770627"],
  ])("rejects invalid stream capabilities before allocating a MessageChannel", (attachmentToken, correlationId) => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockClear();

    expect(() => exposed.openStream(attachmentToken, correlationId)).toThrow();
    expect(createdChannels).toHaveLength(0);
    expect(electronMocks.postMessage).not.toHaveBeenCalled();
    expect(windowPostMessage).not.toHaveBeenCalled();
  });

  it("closes both local ports if the bridge cannot transfer the main-process capability", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    createdChannels.length = 0;
    windowPostMessage.mockClear();
    electronMocks.postMessage.mockReset();
    electronMocks.postMessage.mockImplementationOnce(() => {
      throw new Error("transfer failed");
    });

    expect(() => exposed.openStream("A".repeat(43), "8e577480-5dc2-4dde-aa58-23c8f1770627")).toThrow(
      /transfer failed/,
    );
    const channel = createdChannels[0];
    if (!channel) throw new Error("Expected a MessageChannel");
    expect(channel.port1.close).toHaveBeenCalledOnce();
    expect(channel.port2.close).toHaveBeenCalledOnce();
    expect(windowPostMessage).not.toHaveBeenCalled();
  });
});
