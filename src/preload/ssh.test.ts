// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";
import type { SshWindowAPI } from "../shared/ssh-contracts.js";
import { SSH_IPC_EVENTS, SSH_IPC_INVOKE } from "../main/ssh-ipc.js";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: SshWindowAPI) => void>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  send: vi.fn(),
  postMessage: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {},
  contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
  ipcMain: {},
  ipcRenderer: {
    invoke: electronMocks.invoke,
    send: electronMocks.send,
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
vi.stubGlobal("window", { postMessage: windowPostMessage });
vi.stubGlobal("document", {
  addEventListener: documentAddEventListener,
  querySelectorAll: documentQuerySelectorAll,
});

await import("./ssh.js");

const preloadEventRegistrations = new Map(
  electronMocks.on.mock.calls.map((call) => [call[0], call] as const),
);

const DEPLOYMENT_ID = "11111111-1111-4111-8111-111111111111";
const TAB_ID = "T".repeat(43);
const TOKEN = "A".repeat(43);
const REVIEW_TOKEN = "R".repeat(43);
const CORRELATION_ID = "22222222-2222-4222-8222-222222222222";

describe("SSH preload bridge", () => {
  it("exposes only the frozen narrow SSH API", () => {
    const api = exposedApi();
    expect(Object.keys(api)).toEqual([
      "claimSshWindow",
      "listSshTargets",
      "createSshTab",
      "reattachSshTab",
      "approveSshHostKey",
      "closeSshTab",
      "selectSshTab",
      "copySshCommand",
      "renameSshTab",
      "getTerminalRuntime",
      "getApplicationSettings",
      "updateApplicationSettings",
      "openSshStream",
      "onSshNewTabRequested",
      "onSshCloseTabRequested",
      "onSshSelectTabRequested",
      "onSshSettingsRequested",
      "onSshTabOpened",
      "onApplicationSettingsChanged",
    ]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(api).not.toHaveProperty("ipcRenderer");
    expect(api).not.toHaveProperty("send");
    expect(api).not.toHaveProperty("postMessage");
  });

  it("also exposes the frozen validated application context-menu bridge", async () => {
    const contextMenu = exposedContextMenuApi();
    expect(Object.keys(contextMenu)).toEqual(["onMenuRequested", "executeAction", "setOpen"]);
    expect(Object.isFrozen(contextMenu)).toBe(true);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const actionId = "00000000-0000-4000-8000-000000000002";
    const listener = vi.fn();
    const unsubscribe = contextMenu.onMenuRequested(listener);
    const handler = eventRegistration(APPLICATION_CONTEXT_MENU_IPC.menuRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    handler({}, { v: 1, requestId, x: 7, y: 9, items: [{
      type: "action",
      actionId,
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    }] });
    handler({}, { v: 1, requestId, x: 7, y: 9, items: [{ type: "separator" }] });
    expect(listener).toHaveBeenCalledOnce();

    electronMocks.invoke.mockClear();
    await contextMenu.executeAction({ requestId, actionId });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      { requestId, actionId },
    );
    expect(() => contextMenu.executeAction({ requestId, actionId: "inspect" })).toThrow(
      /Invalid application context menu action request/u,
    );

    electronMocks.invoke.mockClear();
    await contextMenu.setOpen({ requestId, open: true });
    expect(electronMocks.invoke).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
      { requestId, open: true },
    );
    expect(() => contextMenu.setOpen({ requestId, open: "yes" as unknown as boolean })).toThrow(
      /Invalid application context menu visibility request/u,
    );
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
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

  it("maps every invoke method to its fixed dedicated channel", async () => {
    const api = exposedApi();
    electronMocks.invoke.mockClear();
    const deploymentInput = { deploymentId: DEPLOYMENT_ID };
    const reviewInput = { token: REVIEW_TOKEN };
    const tabInput = { tabId: TAB_ID };
    const renameInput = { tabId: TAB_ID, label: "Production shell" };
    const settingsInput = {
      expectedRevision: 0,
      settings: {
        theme: DEFAULT_APPLICATION_SETTINGS_STATE.theme,
        appIcon: DEFAULT_APPLICATION_SETTINGS_STATE.appIcon,
        reduceMotion: DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
        commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
        keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
        terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      },
    };

    await api.claimSshWindow();
    await api.listSshTargets();
    await api.createSshTab(deploymentInput);
    await api.reattachSshTab(tabInput);
    await api.approveSshHostKey(reviewInput);
    await api.closeSshTab(tabInput);
    await api.selectSshTab(tabInput);
    await api.copySshCommand(tabInput);
    await api.renameSshTab(renameInput);
    await api.getTerminalRuntime();
    await api.getApplicationSettings();
    await api.updateApplicationSettings(settingsInput);

    expect(electronMocks.invoke.mock.calls).toEqual([
      [SSH_IPC_INVOKE.claimSshWindow],
      [SSH_IPC_INVOKE.listSshTargets],
      [SSH_IPC_INVOKE.createSshTab, deploymentInput],
      [SSH_IPC_INVOKE.reattachSshTab, tabInput],
      [SSH_IPC_INVOKE.approveSshHostKey, reviewInput],
      [SSH_IPC_INVOKE.closeSshTab, tabInput],
      [SSH_IPC_INVOKE.selectSshTab, tabInput],
      [SSH_IPC_INVOKE.copySshCommand, tabInput],
      [SSH_IPC_INVOKE.renameSshTab, renameInput],
      [SSH_IPC_INVOKE.getTerminalRuntime],
      [SSH_IPC_INVOKE.getApplicationSettings],
      [SSH_IPC_INVOKE.updateApplicationSettings, settingsInput],
    ]);
  });

  it("transfers exactly one SSH MessagePort with the bounded envelope", () => {
    const api = exposedApi();
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockReset();

    api.openSshStream(TOKEN, CORRELATION_ID);

    expect(createdChannels).toHaveLength(1);
    const channel = createdChannels[0];
    expect(channel).toBeDefined();
    expect(electronMocks.postMessage).toHaveBeenCalledExactlyOnceWith(
      SSH_IPC_EVENTS.attach,
      { v: 1, attachmentToken: TOKEN },
      [channel!.port1],
    );
    const request = electronMocks.postMessage.mock.calls[0]?.[1];
    expect(Object.isFrozen(request)).toBe(true);
    expect(windowPostMessage).toHaveBeenCalledExactlyOnceWith(
      {
        source: "sliver-preload",
        type: "ssh-stream-port",
        v: 1,
        correlationId: CORRELATION_ID,
      },
      "*",
      [channel!.port2],
    );
    expect(Object.isFrozen(windowPostMessage.mock.calls[0]?.[0])).toBe(true);
  });

  it("rejects malformed stream capabilities before creating or transferring a port", () => {
    const api = exposedApi();
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockReset();

    expect(() => api.openSshStream("short", CORRELATION_ID)).toThrow(/attachment token/u);
    expect(() => api.openSshStream(TOKEN, "not-a-uuid")).toThrow(/correlationId/u);
    expect(createdChannels).toHaveLength(0);
    expect(electronMocks.postMessage).not.toHaveBeenCalled();
    expect(windowPostMessage).not.toHaveBeenCalled();
  });

  it("closes both ports if either transfer boundary throws", () => {
    const api = exposedApi();
    createdChannels.length = 0;
    electronMocks.postMessage.mockClear();
    windowPostMessage.mockReset();
    windowPostMessage.mockImplementationOnce(() => { throw new Error("renderer unavailable"); });

    expect(() => api.openSshStream(TOKEN, CORRELATION_ID)).toThrow("renderer unavailable");
    const channel = createdChannels[0];
    expect(channel?.port1.close).toHaveBeenCalledOnce();
    expect(channel?.port2.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["onSshNewTabRequested", SSH_IPC_EVENTS.newTabRequested],
    ["onSshCloseTabRequested", SSH_IPC_EVENTS.closeTabRequested],
    ["onSshSettingsRequested", SSH_IPC_EVENTS.settingsRequested],
  ] as const)("delivers only a no-payload %s event", (method, channel) => {
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();
    const unsubscribe = exposedApi()[method](listener);
    const handler = eventRegistration(channel)[1] as (event: unknown, ...payload: unknown[]) => void;

    handler({});
    handler({}, { attackerPayload: true });
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(channel, handler);
  });

  it("delivers only bounded SSH tab shortcut indexes", () => {
    const listener = vi.fn();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();
    const unsubscribe = exposedApi().onSshSelectTabRequested(listener);
    const handler = eventRegistration(SSH_IPC_EVENTS.selectTabRequested)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;

    handler({}, 0);
    handler({}, 9);
    handler({}, 10);
    handler({}, -1);
    handler({}, "1");
    handler({}, 1, 2);
    expect(listener.mock.calls).toEqual([[0], [9]]);
    unsubscribe();
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      SSH_IPC_EVENTS.selectTabRequested,
      handler,
    );
  });

  it("validates and replays a tab-opened capability that arrives before subscription", async () => {
    const handler = eventRegistration(SSH_IPC_EVENTS.tabOpened)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const context = validTabContext();
    handler({}, { ...context, privateKey: "must-not-cross" });
    handler({}, { ...context, label: "bad\nlabel" });
    handler({}, { ...context, label: "\u200b" });
    handler({}, { ...context, label: "left\u200eright" });
    handler({}, { ...context, target: { ...context.target, name: "left\u061cright" } });
    handler({}, { ...context, target: { ...context.target, host: "bad\nvalue" } });
    handler({}, context);

    const listener = vi.fn();
    const unsubscribe = exposedApi().onSshTabOpened(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledExactlyOnceWith(context);
    const delivered = listener.mock.calls[0]?.[0];
    expect(Object.isFrozen(delivered)).toBe(true);
    expect(Object.isFrozen(delivered?.target)).toBe(true);

    handler({}, { ...context, tabId: "N".repeat(43), attachmentToken: "B".repeat(43) });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("validates, freezes, and replays application settings events", async () => {
    const handler = eventRegistration(SSH_IPC_EVENTS.applicationSettingsChanged)[1] as (
      event: unknown,
      ...payload: unknown[]
    ) => void;
    const valid = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 4,
      theme: "light" as const,
      appIcon: "passion" as const,
      keyboardShortcuts: {
        terminalNewTab: "mod+shift+t",
        terminalSettings: "alt+,",
        textEditorOpen: "mod+alt+o",
        textEditorUndo: "mod+z",
        textEditorRedo: "mod+shift+z",
      },
    };
    handler({}, { ...valid, rendererPath: "/tmp/private" });
    handler({}, { ...valid, terminal: { ...valid.terminal, fontSize: 100 } });
    handler({}, { ...valid, appIcon: "system" });
    handler({}, { ...valid, keyboardShortcuts: { arbitraryAction: "mod+p" } });
    handler({}, { ...valid, keyboardShortcuts: { terminalNewTab: "mod+c" } });
    handler({}, { ...valid, keyboardShortcuts: { terminalNewTab: "shift+mod+t" } });
    handler({}, { ...valid, keyboardShortcuts: { navigateBack: "f5" } });
    handler({}, { ...valid, keyboardShortcuts: { textEditorFind: "mod+z" } });
    handler({}, { ...valid, keyboardShortcuts: { textEditorUndo: "mod+y" } });
    handler({}, valid);

    const listener = vi.fn();
    const unsubscribe = exposedApi().onApplicationSettingsChanged(listener);
    await Promise.resolve();

    expect(listener).toHaveBeenCalledExactlyOnceWith(valid);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0].terminal)).toBe(true);
    expect(Object.isFrozen(listener.mock.calls[0]?.[0].keyboardShortcuts)).toBe(true);

    const windowsRedo = {
      ...valid,
      revision: 5,
      keyboardShortcuts: { ...valid.keyboardShortcuts, textEditorRedo: "mod+y" },
    };
    handler({}, windowsRedo);
    handler({}, { ...valid, revision: 6, keyboardShortcuts: { textEditorFind: "mod+z" } });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(windowsRedo);
    unsubscribe();
  });

  it("rejects non-function event subscribers", () => {
    const api = exposedApi();
    expect(() => Reflect.apply(api.onSshNewTabRequested, api, [null])).toThrow(/listener/u);
    expect(() => Reflect.apply(api.onSshTabOpened, api, ["listener"])).toThrow(/listener/u);
    expect(() => Reflect.apply(api.onApplicationSettingsChanged, api, [{}])).toThrow(/listener/u);
  });
});

function validTabContext() {
  return Object.freeze({
    tabId: TAB_ID,
    attachmentToken: TOKEN,
    label: "test1",
    target: Object.freeze({
      deploymentId: DEPLOYMENT_ID,
      name: "test1",
      provider: "aws" as const,
      host: "203.0.113.10",
      port: 22,
      username: "ubuntu",
      status: "running" as const,
      connectable: true,
    }),
  });
}

function exposedApi(): SshWindowAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls[0];
  if (!call) throw new Error("Expected the SSH bridge to be installed");
  expect(call[0]).toBe("ssh");
  return call[1];
}

function exposedContextMenuApi(): ApplicationContextMenuAPI {
  const call = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => (
    name === "applicationContextMenu"
  ));
  if (!call) throw new Error("Expected the application context-menu bridge to be installed");
  return call[1] as unknown as ApplicationContextMenuAPI;
}

function eventRegistration(channel: string): unknown[] {
  const call = electronMocks.on.mock.calls.find(([candidate]) => candidate === channel) ??
    preloadEventRegistrations.get(channel);
  if (!call) throw new Error(`Expected ${channel} to be registered`);
  return call;
}
