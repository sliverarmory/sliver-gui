// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/contracts.js";
import { confirmDiscardScriptChanges } from "./script-editor-close-dialog.js";
import { ScriptEditorCloseGuard } from "./script-editor-close-guard.js";

function createWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    webContents: { isDestroyed: vi.fn(() => false), send: vi.fn() },
  };
}

function setup(response = 0) {
  vi.useFakeTimers();
  const first = createWindow();
  const second = createWindow();
  const windows = new Map([[1, first], [2, second]]);
  const options = {
    getWindow: (id: number) => windows.get(id),
    getFocusedWindow: vi.fn(() => second),
    showDialog: vi.fn((_owner: typeof first | undefined) => response),
  };
  const guard = new ScriptEditorCloseGuard((ids) => confirmDiscardScriptChanges(ids, options));
  return { first, second, windows, options, guard };
}

afterEach(() => vi.useRealTimers());

describe("returning to unsaved scripts after cancelling close", () => {
  it("restores a minimized owner after its window close is cancelled", () => {
    const { first, second, options, guard } = setup();
    first.isMinimized.mockReturnValue(true);
    guard.setDirty(1, true);

    expect(guard.allowClose(1)).toBe(false);
    expect(options.showDialog).toHaveBeenCalledExactlyOnceWith(first);
    expect(first.restore).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(first.restore).toHaveBeenCalledOnce();
    expect(first.show).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.scriptEditorRequested);
    expect(second.webContents.send).not.toHaveBeenCalled();
  });

  it("prefers the focused dirty window when application quit is cancelled", () => {
    const { first, second, options, guard } = setup();
    guard.setDirty(1, true);
    guard.setDirty(2, true);

    expect(guard.allowQuit()).toBe(false);
    expect(guard.isQuitRequested).toBe(false);
    expect(options.showDialog).toHaveBeenCalledExactlyOnceWith(second);
    vi.runAllTimers();

    expect(second.restore).not.toHaveBeenCalled();
    expect(second.show).toHaveBeenCalledOnce();
    expect(second.focus).toHaveBeenCalledOnce();
    expect(second.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.scriptEditorRequested);
    expect(first.webContents.send).not.toHaveBeenCalled();
  });

  it("falls back to a surviving dirty owner if the dialog owner closes before navigation", () => {
    const { first, second, options, guard } = setup();
    guard.setDirty(1, true);
    guard.setDirty(2, true);
    expect(guard.allowQuit()).toBe(false);
    expect(options.showDialog).toHaveBeenCalledExactlyOnceWith(second);

    second.webContents.isDestroyed.mockReturnValue(true);
    vi.runAllTimers();
    expect(first.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.scriptEditorRequested);
    expect(second.focus).not.toHaveBeenCalled();
  });

  it("ignores missing and destroyed owners without navigating another window", () => {
    const { first, second, windows, options, guard } = setup();
    guard.setDirty(1, true);
    guard.setDirty(2, true);
    windows.delete(1);
    second.isDestroyed.mockReturnValue(true);

    expect(guard.allowQuit()).toBe(false);
    expect(options.showDialog).toHaveBeenCalledExactlyOnceWith(undefined);
    vi.runAllTimers();
    expect(first.focus).not.toHaveBeenCalled();
    expect(second.focus).not.toHaveBeenCalled();
  });

  it("does not navigate or focus when changes are discarded", () => {
    const { first, second, guard } = setup(1);
    guard.setDirty(1, true);
    guard.setDirty(2, true);
    expect(guard.allowQuit()).toBe(true);
    expect(guard.isQuitRequested).toBe(true);
    vi.runAllTimers();
    expect(first.focus).not.toHaveBeenCalled();
    expect(second.focus).not.toHaveBeenCalled();
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).not.toHaveBeenCalled();
  });

  it("does not show a dialog or navigate on clean close and quit", () => {
    const { first, second, options, guard } = setup();
    expect(guard.allowClose(1)).toBe(true);
    expect(guard.allowQuit()).toBe(true);
    vi.runAllTimers();
    expect(options.showDialog).not.toHaveBeenCalled();
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).not.toHaveBeenCalled();
  });
});
