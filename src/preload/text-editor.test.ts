// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { TEXT_EDITOR_IPC, type TextEditorAPI } from "../shared/text-editor-contracts.js";

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn<(name: string, api: TextEditorAPI) => void>(),
  invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
  on: vi.fn(), removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));

await import("./text-editor.js");

function api(): TextEditorAPI {
  const bridge = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "textEditor")?.[1];
  if (!bridge) throw new Error("Missing text editor bridge");
  return bridge;
}

describe("text editor preload", () => {
  it("exposes one frozen API with no generic IPC, filesystem paths, or connection capability", () => {
    expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(api())).toBe(true);
    expect(Object.keys(api())).toEqual([
      "getDocument", "openFile", "save", "setDirty", "getApplicationSettings", "onApplicationSettingsChanged",
    ]);
  });

  it("maps every request to exactly one dedicated channel", async () => {
    mocks.invoke.mockClear();
    await api().getDocument();
    await api().openFile();
    await api().save({ text: "hello", saveAs: false });
    await api().setDirty(true);
    await api().getApplicationSettings();
    expect(mocks.invoke.mock.calls).toEqual([
      [TEXT_EDITOR_IPC.getDocument], [TEXT_EDITOR_IPC.openFile],
      [TEXT_EDITOR_IPC.save, { text: "hello", saveAs: false }],
      [TEXT_EDITOR_IPC.setDirty, true], [TEXT_EDITOR_IPC.getApplicationSettings],
    ]);
  });

  it("rejects malformed inputs and extra path authority before crossing IPC", () => {
    mocks.invoke.mockClear();
    expect(() => api().save({ text: "hello", saveAs: false, path: "/tmp/hidden" } as never)).toThrow();
    expect(() => api().save({ text: new Uint8Array([1]), saveAs: false } as never)).toThrow();
    expect(() => api().save({ text: "a".repeat(2 * 1024 * 1024 + 1), saveAs: false })).toThrow();
    expect(() => api().setDirty("true" as never)).toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
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
});
