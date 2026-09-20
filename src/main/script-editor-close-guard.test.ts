// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { ScriptEditorCloseGuard } from "./script-editor-close-guard.js";

describe("script editor close and quit guard", () => {
  it("allows clean close and quit without a dialog and signals terminal windows to close", () => {
    const confirm = vi.fn(() => true);
    const guard = new ScriptEditorCloseGuard(confirm);
    expect(guard.allowClose(1)).toBe(true);
    expect(guard.allowQuit()).toBe(true);
    expect(guard.isQuitRequested).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps dirty windows open and cancels quit intent when the operator keeps editing", () => {
    const guard = new ScriptEditorCloseGuard(() => false);
    const tearDown = vi.fn();
    guard.setDirty(1, true);
    if (guard.allowQuit()) tearDown();
    expect(tearDown).not.toHaveBeenCalled();
    expect(guard.isQuitRequested).toBe(false);
    expect(guard.allowClose(1)).toBe(false);
  });

  it("confirms all dirty windows once and permits their beforeunload vetoes", () => {
    const confirm = vi.fn(() => true);
    const guard = new ScriptEditorCloseGuard(confirm);
    guard.setDirty(1, true);
    guard.setDirty(2, true);
    expect(guard.allowQuit()).toBe(true);
    expect(confirm).toHaveBeenCalledExactlyOnceWith([1, 2]);
    expect(guard.allowClose(1)).toBe(true);
    expect(guard.allowClose(1, true)).toBe(true);
    expect(guard.allowClose(2, true)).toBe(true);
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("handles an unreported beforeunload veto before teardown and clears quit intent on cancellation", () => {
    const confirm = vi.fn(() => false);
    const guard = new ScriptEditorCloseGuard(confirm);
    expect(guard.allowQuit()).toBe(true);
    expect(guard.allowClose(3, true)).toBe(false);
    expect(guard.isQuitRequested).toBe(false);
    expect(confirm).toHaveBeenCalledExactlyOnceWith([3]);
  });

  it("forgets saved, navigated, and closed documents and invalidates stale discard approval", () => {
    const confirm = vi.fn(() => true);
    const guard = new ScriptEditorCloseGuard(confirm);
    guard.setDirty(1, true);
    expect(guard.allowClose(1)).toBe(true);
    guard.setDirty(1, true);
    expect(guard.allowClose(1)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
    guard.setDirty(1, false);
    guard.setDirty(2, true);
    guard.forget(2);
    expect(guard.allowQuit()).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("restores normal close behavior when an update restart cannot proceed", () => {
    const confirm = vi.fn(() => true);
    const guard = new ScriptEditorCloseGuard(confirm);
    guard.setDirty(1, true);
    expect(guard.allowQuit()).toBe(true);
    guard.cancelQuit();
    expect(guard.isQuitRequested).toBe(false);
    expect(guard.allowClose(1)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
