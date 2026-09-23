// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import {
  APPLICATION_CONTEXT_MENU_IPC,
  type ApplicationContextMenuAPI,
} from "../shared/application-context-menu-contracts.js";
import { DEFAULT_TEXT_EDITOR_SETTINGS_STATE } from "../shared/text-editor-settings-contracts.js";
import { TEXT_EDITOR_IPC, type TextEditorAPI } from "../shared/text-editor-contracts.js";

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: unknown) => void>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  on: vi.fn(), removeListener: vi.fn(), send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener, send: mocks.send },
}));

await import("./text-editor.js");

function api(): TextEditorAPI {
  const bridge = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "textEditor")?.[1];
  if (!bridge) throw new Error("Missing text editor bridge");
  return bridge as TextEditorAPI;
}

function contextMenuApi(): ApplicationContextMenuAPI {
  const bridge = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "applicationContextMenu")?.[1];
  if (!bridge) throw new Error("Missing application context menu bridge");
  return bridge as ApplicationContextMenuAPI;
}

describe("text editor preload", () => {
  it("exposes only the frozen editor and context-menu APIs", () => {
    expect(mocks.exposeInMainWorld.mock.calls.map(([name]) => name)).toEqual([
      "textEditor",
      "applicationContextMenu",
    ]);
    expect(Object.isFrozen(api())).toBe(true);
    expect(Object.isFrozen(contextMenuApi())).toBe(true);
    expect(Object.keys(api())).toEqual([
      "getDocument", "openFile", "save", "setDirty", "respondToRemoteOverwrite",
      "onRemoteOverwriteRequested", "getApplicationSettings", "onApplicationSettingsChanged",
      "getEditorSettings", "updateEditorSettings", "onEditorSettingsChanged",
    ]);
    expect(Object.keys(contextMenuApi())).toEqual(["onMenuRequested", "executeAction", "setOpen"]);
  });

  it("validates context-menu events and sends only opaque capabilities on fixed channels", async () => {
    const listener = vi.fn();
    const stop = contextMenuApi().onMenuRequested(listener);
    const registration = mocks.on.mock.calls.find(
      ([channel]) => channel === APPLICATION_CONTEXT_MENU_IPC.menuRequested,
    );
    const handler = registration?.[1] as (_event: unknown, ...payload: unknown[]) => void;
    const requestId = "00000000-0000-4000-8000-000000000001";
    const actionId = "00000000-0000-4000-8000-000000000002";
    const request = {
      v: 1,
      requestId,
      x: 20,
      y: 30,
      items: [{ type: "action", actionId, kind: "copy", label: "Copy", enabled: true }],
    };
    handler({ sender: "private native event" }, request);
    handler({}, { ...request, action: "copy" });
    handler({}, request, "extra payload");
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);
    stop();
    expect(mocks.removeListener).toHaveBeenCalledWith(APPLICATION_CONTEXT_MENU_IPC.menuRequested, handler);

    mocks.invoke.mockClear();
    await contextMenuApi().executeAction({ requestId, actionId });
    await contextMenuApi().setOpen({ requestId, open: true });
    expect(mocks.invoke.mock.calls).toEqual([
      [APPLICATION_CONTEXT_MENU_IPC.executeAction, { requestId, actionId }],
      [APPLICATION_CONTEXT_MENU_IPC.setOpen, { requestId, open: true }],
    ]);
    expect(() => contextMenuApi().executeAction({ requestId, actionId: "copy" })).toThrow(TypeError);
    expect(() => contextMenuApi().setOpen({ requestId: "menu", open: true })).toThrow(TypeError);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });

  it("maps every request to exactly one dedicated channel", async () => {
    mocks.invoke.mockClear();
    await api().getDocument();
    await api().openFile();
    await api().save({ text: "hello", saveAs: false });
    await api().setDirty(true);
    await api().respondToRemoteOverwrite({
      requestId: "11111111-1111-4111-8111-111111111111",
      confirmed: true,
    });
    await api().getApplicationSettings();
    await api().getEditorSettings();
    const { v: _version, revision: _revision, ...editorSettings } = DEFAULT_TEXT_EDITOR_SETTINGS_STATE;
    await api().updateEditorSettings({
      expectedRevision: 0,
      settings: editorSettings,
    });
    expect(mocks.invoke.mock.calls).toEqual([
      [TEXT_EDITOR_IPC.getDocument], [TEXT_EDITOR_IPC.openFile],
      [TEXT_EDITOR_IPC.save, { text: "hello", saveAs: false }],
      [TEXT_EDITOR_IPC.setDirty, true],
      [TEXT_EDITOR_IPC.respondToRemoteOverwrite, {
        requestId: "11111111-1111-4111-8111-111111111111",
        confirmed: true,
      }],
      [TEXT_EDITOR_IPC.getApplicationSettings],
      [TEXT_EDITOR_IPC.getEditorSettings],
      [TEXT_EDITOR_IPC.updateEditorSettings, {
        expectedRevision: 0,
        settings: editorSettings,
      }],
    ]);
  });

  it("rejects malformed inputs and extra path authority before crossing IPC", () => {
    mocks.invoke.mockClear();
    expect(() => api().save({ text: "hello", saveAs: false, path: "/tmp/hidden" } as never)).toThrow();
    expect(() => api().save({ text: new Uint8Array([1]), saveAs: false } as never)).toThrow();
    expect(() => api().save({ text: "a".repeat(2 * 1024 * 1024 + 1), saveAs: false })).toThrow();
    expect(() => api().setDirty("true" as never)).toThrow();
    expect(() => api().respondToRemoteOverwrite({ requestId: "not-a-uuid", confirmed: true })).toThrow();
    expect(() => api().respondToRemoteOverwrite({
      requestId: "11111111-1111-4111-8111-111111111111", confirmed: "yes",
    } as never)).toThrow();
    expect(() => api().updateEditorSettings({
      expectedRevision: 0,
      settings: { ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, fontSize: 100 },
    })).toThrow();
    expect(() => api().updateEditorSettings({
      expectedRevision: 0,
      settings: { ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, path: "/tmp/hidden" },
    } as never)).toThrow();
    expect(() => api().respondToRemoteOverwrite({
      requestId: "11111111-1111-4111-8111-111111111111", confirmed: true, path: "/tmp/hidden",
    } as never)).toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("forwards only validated remote overwrite requests and removes its listener", () => {
    const listener = vi.fn();
    const stop = api().onRemoteOverwriteRequested(listener);
    const registration = mocks.on.mock.calls.at(-1);
    expect(registration?.[0]).toBe(TEXT_EDITOR_IPC.remoteOverwriteRequested);
    const handler = registration?.[1] as (_event: unknown, ...args: unknown[]) => void;
    const request = {
      requestId: "11111111-1111-4111-8111-111111111111",
      path: "/opt/notes.txt",
      target: {
        name: "payments",
        hostname: "host",
        sessionId: "session-1",
        backend: { id: "production", displayName: "Production" },
      },
      originalSha256: "a".repeat(64),
      newSha256: "b".repeat(64),
      warning: "The upload is not atomic.",
    };
    handler({ sender: "private native event" }, request);
    handler({}, { ...request, requestId: "not-a-uuid" });
    handler({}, { ...request, planToken: "must-not-cross-preload" });
    handler({}, request, "extra payload");
    expect(listener).toHaveBeenCalledExactlyOnceWith(request);
    stop();
    expect(mocks.removeListener).toHaveBeenCalledWith(TEXT_EDITOR_IPC.remoteOverwriteRequested, handler);
  });

  it("forwards settings data without the Electron event and removes its listener", () => {
    const listener = vi.fn();
    const stop = api().onApplicationSettingsChanged(listener);
    const registration = mocks.on.mock.calls.at(-1);
    expect(registration?.[0]).toBe(TEXT_EDITOR_IPC.applicationSettingsChanged);
    const handler = registration?.[1] as (_event: unknown, ...args: unknown[]) => void;
    handler({ sender: "private native event" }, DEFAULT_APPLICATION_SETTINGS_STATE);
    handler({}, null);
    handler({}, DEFAULT_APPLICATION_SETTINGS_STATE, "extra payload");
    expect(listener).toHaveBeenCalledExactlyOnceWith(DEFAULT_APPLICATION_SETTINGS_STATE);
    stop();
    expect(mocks.removeListener).toHaveBeenCalledWith(TEXT_EDITOR_IPC.applicationSettingsChanged, handler);
  });

  it("forwards only validated editor settings and removes its listener", () => {
    const listener = vi.fn();
    const stop = api().onEditorSettingsChanged(listener);
    const registration = mocks.on.mock.calls.at(-1);
    expect(registration?.[0]).toBe(TEXT_EDITOR_IPC.editorSettingsChanged);
    const handler = registration?.[1] as (_event: unknown, ...args: unknown[]) => void;
    handler({ sender: "private native event" }, DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
    handler({}, { ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, fontSize: 100 });
    handler({}, { ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, path: "/tmp/hidden" });
    handler({}, DEFAULT_TEXT_EDITOR_SETTINGS_STATE, "extra payload");
    expect(listener).toHaveBeenCalledExactlyOnceWith(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
    stop();
    expect(mocks.removeListener).toHaveBeenCalledWith(TEXT_EDITOR_IPC.editorSettingsChanged, handler);
  });
});
