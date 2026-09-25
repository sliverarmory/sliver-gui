// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  IPC,
  IPC_INVOKE,
  SLIVER_DESKTOP_NON_INVOKE_API_KEYS,
  type IpcInvokeArgs,
  type SliverDesktopAPI,
} from "../shared/contracts.js";
import { defaultGenerateInput } from "../shared/generate-defaults.js";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";
import { SESSION_DROPPED_UPLOAD_IPC_CHANNEL } from "../shared/session-contracts.js";
import { LOOT_DROPPED_ADD_IPC_CHANNEL } from "../shared/operator-data-contracts.js";
import { SCRIPT_TASK_IPC, type ScriptTaskManagerAPI } from "../shared/script-task-manager-contracts.js";
import type { ApplicationZoomAPI } from "../shared/application-zoom-contracts.js";

type InvokeArgumentsByMethod = {
  [Method in keyof typeof IPC_INVOKE]: IpcInvokeArgs<(typeof IPC_INVOKE)[Method]>;
};

const invokeArguments = {
  listScripts: [],
  readScript: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2" }],
  createScript: [{ name: "Test", source: "console.log(1)" }],
  saveScript: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2", source: "console.log(1)", expectedRevision: "a".repeat(64) }],
  renameScript: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2", name: "Renamed", expectedRevision: "a".repeat(64) }],
  deleteScript: [{ id: "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2", expectedRevision: "a".repeat(64) }],
  exportScript: [{ name: "Test", source: "console.log(1)" }],
  importScript: [],
  getScriptRuntime: [],
  setScriptEditorDirty: [true],
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
  openCloudDeploymentWindow: [],
  copyManagedServerSshCommand: [{ deploymentId: "22222222-2222-4222-8222-222222222222" }],
  copyManagedServerPublicIp: [{ deploymentId: "22222222-2222-4222-8222-222222222222" }],
  openInteractionWindow: [],
  claimInteractionWindow: [],
  exitApp: [],
  getApplicationSettings: [],
  chooseReportScreenshotDirectory: [],
  reportScreenshot: [],
  getApplicationIcon: [],
  setKeyboardShortcutRecording: [true],
  updateApplicationSettings: [{
    expectedRevision: 0,
    settings: {
      theme: DEFAULT_APPLICATION_SETTINGS_STATE.theme,
      appIcon: DEFAULT_APPLICATION_SETTINGS_STATE.appIcon,
      reduceMotion: DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
      commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
      keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
      reportScreenshotDirectory: DEFAULT_APPLICATION_SETTINGS_STATE.reportScreenshotDirectory,
      terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      overview: DEFAULT_APPLICATION_SETTINGS_STATE.overview,
    },
  }],
  getApplicationUpdateState: [],
  checkForApplicationUpdates: [],
  restartToApplyApplicationUpdate: [],
  openSessionShellWindow: [{ preferredResourceId: "R".repeat(43) }],
  claimSessionShellWindow: [],
  openSessionPanelWindow: [{ panel: "execution" }],
  claimSessionPanelWindow: [],
  openConsoleWindow: [],
  claimConsoleWindow: [],
  createConsoleTab: [],
  closeConsoleTab: ["T".repeat(43)],
  chooseCertificatePair: [],
  startListener: [{
    listener: { kind: "mtls", host: "127.0.0.1", port: 8888 },
    addManagedFirewallRule: false,
  }],
  prepareStopJob: [7],
  prepareStopAllJobs: [],
  executeStopPlan: [{
    token: "8e577480-5dc2-4dde-aa58-23c8f1770627",
    removeManagedFirewallRule: false,
  }],
  generate: [defaultGenerateInput],
  generateFromProfile: [{ profileName: "default", name: "test" }],
  downloadBuild: ["existing-build"],
  deleteBuild: ["existing-build"],
  setStagedBuilds: [["existing-build"]],
  saveProfile: [{ profileName: "default", config: defaultGenerateInput, overwrite: false }],
  deleteProfile: ["default"],
  listLoot: [{ query: "report", fileType: "all", limit: 100 }],
  addLoot: [{ name: "operator report", fileType: "auto" }],
  getLootDetail: ["80ae1382-e6e2-44d6-a663-537cafb60e74"],
  downloadLoot: ["80ae1382-e6e2-44d6-a663-537cafb60e74"],
  renameLoot: [{ id: "80ae1382-e6e2-44d6-a663-537cafb60e74", name: "renamed report" }],
  deleteLoot: ["80ae1382-e6e2-44d6-a663-537cafb60e74"],
  listCredentials: [{ query: "operator", kind: "all", limit: 100 }],
  revealCredentialSecret: [{ id: "b5aa8e99-3e16-4c7c-8fc7-5f4f3b6c42c0", field: "plaintext" }],
  addCredential: [{
    username: "operator",
    collection: "manual",
    plaintext: new Uint8Array([115, 101, 99, 114, 101, 116]),
    hash: new Uint8Array(),
    hashType: null,
  }],
  deleteCredential: ["b5aa8e99-3e16-4c7c-8fc7-5f4f3b6c42c0"],
  copyCredentialSecret: [{ id: "b5aa8e99-3e16-4c7c-8fc7-5f4f3b6c42c0", field: "hash" }],
  clearCredentialClipboard: [],
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
  openRemoteTextEditor: [{ remotePath: "/tmp/edit.txt" }],
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
  readExecutionOutput: [{ requestId: "execution_request_1", stream: "stdout" }],
  addExecutionOutputToLoot: [{ requestId: "execution_request_1", stream: "stdout", name: "Saved output" }],
  saveExecutionResult: [{ requestId: "execution_request_1", stream: "combined" }],
  listProcessExecutionHistory: [],
  clearProcessExecutionHistory: [{ id: "execution_request_1" }],
} satisfies InvokeArgumentsByMethod;

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: SliverDesktopAPI) => void>(),
  invoke: vi.fn((channel: string, ...args: unknown[]) => ({ channel, args })),
  send: vi.fn(),
  postMessage: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  getPathForFile: vi.fn<(file: File) => string>(),
  getZoomFactor: vi.fn(() => 1),
  setZoomFactor: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    postMessage: electronMocks.postMessage,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
  webUtils: { getPathForFile: electronMocks.getPathForFile },
  webFrame: {
    getZoomFactor: electronMocks.getZoomFactor,
    setZoomFactor: electronMocks.setZoomFactor,
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
const documentAddEventListener = vi.fn();
const documentQuerySelectorAll = vi.fn(() => []);
const mutationObserverCallbacks: Array<(records: readonly Record<string, unknown>[]) => void> = [];
const mutationObserverObserve = vi.fn();
class TestMutationObserver {
  public constructor(callback: (records: readonly Record<string, unknown>[]) => void) {
    mutationObserverCallbacks.push(callback);
  }

  public observe(target: unknown, options: unknown): void {
    mutationObserverObserve(target, options);
  }
}
vi.stubGlobal("MessageChannel", TestMessageChannel);
vi.stubGlobal("MutationObserver", TestMutationObserver);
vi.stubGlobal("window", {
  postMessage: windowPostMessage,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});
vi.stubGlobal("document", {
  addEventListener: documentAddEventListener,
  querySelectorAll: documentQuerySelectorAll,
});

await import("./index.js");

describe("sandboxed preload bridge", () => {
  it("buffers native host/edit requests until subscribers mount and consumes only the latest valid selection", async () => {
    const api = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "scriptTasks")![1] as unknown as ScriptTaskManagerAPI;
    const hostEvent = electronMocks.on.mock.calls.find(([channel]) => channel === SCRIPT_TASK_IPC.hostRequested)![1] as (...args: unknown[]) => void;
    const editEvent = electronMocks.on.mock.calls.find(([channel]) => channel === SCRIPT_TASK_IPC.editRequested)![1] as (...args: unknown[]) => void;
    const id = "123e4567-e89b-42d3-a456-426614174000";
    hostEvent({}, "discard payload"); hostEvent({}); hostEvent({});
    editEvent({}, "123e4567-e89b-42d3-a456-426614174001"); editEvent({}, id);
    editEvent({}, "../source.js"); editEvent({}, id, "extra");
    const host = vi.fn(); const edit = vi.fn();
    const stopHost = api.onHostRequested(host); const stopEdit = api.onEditRequested(edit);
    await Promise.resolve();
    expect(host).toHaveBeenCalledExactlyOnceWith(); expect(edit).toHaveBeenCalledExactlyOnceWith(id);
    stopHost(); stopEdit();
    const next = vi.fn(); const stopNext = api.onEditRequested(next);
    await Promise.resolve(); expect(next).not.toHaveBeenCalled(); stopNext();
  });
  it("exposes script invalidation without leaking the Electron event and unsubscribes cleanly", () => {
    const api = electronMocks.exposeInMainWorld.mock.calls[0]![1];
    const listener = vi.fn();
    const unsubscribe = api.onScriptsChanged(listener);
    const registration = electronMocks.on.mock.calls.findLast(([channel]) => channel === IPC.scriptsChanged)!;
    const handler = registration[1] as (...args: unknown[]) => void;
    handler({ privateElectronEvent: true }, "ignored payload");
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.scriptsChanged, handler);
  });

  it("accepts only payload-free saved-config invalidations and unsubscribes cleanly", () => {
    const api = electronMocks.exposeInMainWorld.mock.calls[0]![1];
    const listener = vi.fn();
    const unsubscribe = api.onSavedConfigsChanged(listener);
    const registration = electronMocks.on.mock.calls.findLast(([channel]) => channel === IPC.savedConfigsChanged)!;
    const handler = registration[1] as (...args: unknown[]) => void;
    handler({ privateElectronEvent: true }, "unexpected payload");
    expect(listener).not.toHaveBeenCalled();
    handler({ privateElectronEvent: true });
    expect(listener).toHaveBeenCalledExactlyOnceWith();
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(IPC.savedConfigsChanged, handler);
  });

  it("exposes frozen saved-config methods using only their dedicated IPC channels", async () => {
    expect(electronMocks.exposeInMainWorld).toHaveBeenCalledTimes(4);
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

  it("resolves a dropped File path in preload and sends only the private typed envelope", async () => {
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    if (!exposed) throw new Error("Expected the preload API to be exposed");
    const file = {} as File;
    const input = {
      remotePath: "/tmp",
      isIOC: true,
      isDirectory: false as const,
      overwrite: false as const,
    };
    electronMocks.invoke.mockClear();
    electronMocks.getPathForFile.mockReset();
    electronMocks.getPathForFile.mockReturnValue("/private/operator/drop.bin");

    await exposed.uploadDroppedSessionFile(file, input);

    expect(electronMocks.getPathForFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      SESSION_DROPPED_UPLOAD_IPC_CHANNEL,
      { sourcePath: "/private/operator/drop.bin", input },
    );

    electronMocks.invoke.mockClear();
    electronMocks.getPathForFile.mockReturnValue("");
    expect(() => exposed.uploadDroppedSessionFile(file, input)).toThrow(
      /must be backed by a local file/u,
    );
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it("resolves a dropped loot File in preload without exposing its path to the renderer", async () => {
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    if (!exposed) throw new Error("Expected the preload API to be exposed");
    const file = {} as File;
    electronMocks.invoke.mockClear();
    electronMocks.getPathForFile.mockReset();
    electronMocks.getPathForFile.mockReturnValue("/private/operator/report.txt");

    await exposed.addDroppedLoot(file);

    expect(electronMocks.getPathForFile).toHaveBeenCalledExactlyOnceWith(file);
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      LOOT_DROPPED_ADD_IPC_CHANNEL,
      { sourcePath: "/private/operator/report.txt" },
    );

    electronMocks.invoke.mockClear();
    electronMocks.getPathForFile.mockReturnValue("");
    expect(() => exposed.addDroppedLoot(file)).toThrow(/must be backed by a local file/u);
    expect(electronMocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards optional cloud navigation on its existing dedicated channel", async () => {
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    if (!exposed) throw new Error("Expected the preload API to be exposed");
    const request = {
      view: "deployments" as const,
      deploymentId: "22222222-2222-4222-8222-222222222222",
      action: "rename" as const,
    };

    await exposed.openCloudDeploymentWindow(request);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC.openCloudDeploymentWindow, request);
    await exposed.openCloudDeploymentWindow();
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC.openCloudDeploymentWindow);
  });

  it("copies a managed server public IP using only its deployment identity", async () => {
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    if (!exposed) throw new Error("Expected the preload API to be exposed");
    const input = { deploymentId: "22222222-2222-4222-8222-222222222222" };
    await exposed.copyManagedServerPublicIp(input);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC.copyManagedServerPublicIp, input);
  });

  it("copies a managed server SSH command using only its deployment identity", async () => {
    const exposed = electronMocks.exposeInMainWorld.mock.calls[0]?.[1];
    if (!exposed) throw new Error("Expected the preload API to be exposed");
    const input = { deploymentId: "22222222-2222-4222-8222-222222222222" };
    await exposed.copyManagedServerSshCommand(input);
    expect(electronMocks.invoke).toHaveBeenLastCalledWith(IPC.copyManagedServerSshCommand, input);
  });

  it("exposes only current zoom, reset, and change subscription capabilities", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "applicationZoom");
    if (!call) throw new Error("Expected the zoom bridge to be exposed");
    const exposed = call[1] as unknown as ApplicationZoomAPI;
    expect(Object.keys(exposed)).toEqual(["getFactor", "reset", "onChanged"]);
    expect(Object.isFrozen(exposed)).toBe(true);
    electronMocks.getZoomFactor.mockReturnValueOnce(0.9);
    expect(exposed.getFactor()).toBe(0.9);
    exposed.reset();
    expect(electronMocks.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("exposes a frozen capability-only application context-menu bridge", async () => {
    const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => (
      name === "applicationContextMenu"
    ));
    if (!call) throw new Error("Expected the context-menu bridge to be exposed");
    const exposed = call[1] as unknown as ApplicationContextMenuAPI;
    expect(Object.keys(exposed)).toEqual(["onMenuRequested", "executeAction", "setOpen"]);
    expect(Object.isFrozen(exposed)).toBe(true);

    const requestId = "00000000-0000-4000-8000-000000000001";
    const actionId = "00000000-0000-4000-8000-000000000002";
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();
    const unsubscribe = exposed.onMenuRequested(listener);
    const registration = electronMocks.on.mock.calls.find(([channel]) => (
      channel === APPLICATION_CONTEXT_MENU_IPC.menuRequested
    ));
    if (!registration) throw new Error("Expected the context-menu event subscription");
    const handler = registration[1] as (event: unknown, ...payload: unknown[]) => void;
    handler({}, { v: 1, requestId, x: 12, y: 34, items: [{
      type: "action",
      actionId,
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    }] });
    handler({}, { v: 1, requestId, x: -1, y: 34, items: [] });
    expect(listener).toHaveBeenCalledOnce();
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);

    electronMocks.invoke.mockClear();
    await exposed.executeAction({ requestId, actionId });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      { requestId, actionId },
    );
    expect(() => exposed.executeAction({ requestId, actionId: "copy" })).toThrow(
      /Invalid application context menu action request/u,
    );

    electronMocks.invoke.mockClear();
    await exposed.setOpen({ requestId, open: true });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
      { requestId, open: true },
    );
    expect(() => exposed.setOpen({ requestId, open: 1 as unknown as boolean })).toThrow(
      /Invalid application context menu visibility request/u,
    );

    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.menuRequested,
      handler,
    );
  });

  it("sticks restricted classification across attribute removal and descendant moves", () => {
    const registration = documentAddEventListener.mock.calls.find(([type]) => type === "contextmenu");
    if (!registration) throw new Error("Expected the restricted-target capture listener");
    expect(registration[2]).toBe(true);
    expect(mutationObserverObserve).toHaveBeenCalledWith(
      (globalThis as { document?: unknown }).document,
      expect.objectContaining({ attributes: true, childList: true, subtree: true }),
    );
    const handler = registration[1] as (event: { isTrusted: boolean; target: unknown }) => void;
    const observe = mutationObserverCallbacks[0];
    if (!observe) throw new Error("Expected the restricted-target mutation observer");
    let rootPolicy: string | null = "inspect-only";
    const root = {
      childNodes: [] as unknown[],
      getAttribute: () => rootPolicy,
      parentNode: null,
    };
    const textarea = { childNodes: [], parentNode: root as object | null };

    observe([{
      addedNodes: [],
      attributeName: "data-application-context-menu-policy",
      oldValue: null,
      target: root,
      type: "attributes",
    }]);
    root.childNodes.push(textarea);
    observe([{ addedNodes: [textarea], target: root, type: "childList" }]);
    rootPolicy = null;
    textarea.parentNode = {};

    electronMocks.send.mockClear();
    handler({ isTrusted: true, target: root });
    handler({ isTrusted: true, target: textarea });
    handler({ isTrusted: false, target: textarea });
    handler({ isTrusted: true, target: {} });

    expect(electronMocks.send).toHaveBeenCalledTimes(2);
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      1,
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
    );
    expect(electronMocks.send).toHaveBeenNthCalledWith(
      2,
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
    );
  });

  it("routes every invoke method through its same-named shared channel", async () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;

    expect(Object.keys(exposed).sort()).toEqual([
      ...Object.keys(IPC_INVOKE),
      ...SLIVER_DESKTOP_NON_INVOKE_API_KEYS,
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
      ...SLIVER_DESKTOP_NON_INVOKE_API_KEYS,
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
    ["onScriptEditorRequested", IPC.scriptEditorRequested],
    ["onCommandPaletteRequested", IPC.commandPaletteRequested],
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
    const validCrackstation = {
      ...valid,
      artifact: "crackstation",
      os: "windows",
      version: "v0.0.4",
      fileName: "sliver-crackstation_windows-amd64.exe",
    };
    handler({} as Electron.IpcRendererEvent, valid);
    handler({} as Electron.IpcRendererEvent, validCrackstation);
    handler({} as Electron.IpcRendererEvent, { ...valid, destinationPath: "/Users/private/Downloads" });
    handler({} as Electron.IpcRendererEvent, { ...valid, receivedBytes: 129 });

    expect(listener.mock.calls).toEqual([[valid], [validCrackstation]]);
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
    const valid = { ...DEFAULT_APPLICATION_SETTINGS_STATE, revision: 4, theme: "light", appIcon: "passion" };
    handler({} as Electron.IpcRendererEvent, valid);
    handler({} as Electron.IpcRendererEvent, { ...valid, untrustedPath: "/tmp/private" });
    handler({} as Electron.IpcRendererEvent, { ...valid, theme: "sepia" });
    handler({} as Electron.IpcRendererEvent, { ...valid, appIcon: "system" });

    expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0].terminal)).toBe(true);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      IPC.applicationSettingsChanged,
      handler,
    );
  });

  it("delivers only resolved application icons and removes the listener", () => {
    const call = electronMocks.exposeInMainWorld.mock.calls[0];
    if (!call) throw new Error("Expected the preload API to be exposed");
    const [, exposed] = call;
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();

    const unsubscribe = exposed.onApplicationIconChanged(listener);
    const [channel, handler] = electronMocks.on.mock.calls[0] ?? [];
    expect(channel).toBe(IPC.applicationIconChanged);
    if (typeof handler !== "function") throw new Error("Expected the application-icon event handler");
    for (const icon of ["light", "dark", "passion"]) handler({} as Electron.IpcRendererEvent, icon);
    for (const invalid of ["auto", "system", "", null, { icon: "light" }]) {
      handler({} as Electron.IpcRendererEvent, invalid);
    }
    handler({} as Electron.IpcRendererEvent);
    handler({} as Electron.IpcRendererEvent, "light", "dark");

    expect(listener.mock.calls).toEqual([["light"], ["dark"], ["passion"]]);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(IPC.applicationIconChanged, handler);
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
