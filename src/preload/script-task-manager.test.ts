// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SCRIPT_TASK_IPC, type ScriptTaskManagerAPI } from "../shared/script-task-manager-contracts.js";
const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn(), send: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: mocks.expose }, ipcRenderer: {
  invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener, send: mocks.send,
} }));
await import("./script-task-manager.js");
const api = mocks.expose.mock.calls.find(([name]) => name === "scriptTasks")![1] as ScriptTaskManagerAPI;
describe("Script Task Manager sandbox preload", () => {
  it("exposes only console display, fixed commands, appearance and scoped context menus", () => {
    expect(mocks.expose.mock.calls.map(([name]) => name).sort()).toEqual(["applicationContextMenu", "scriptTasks"]);
    expect(Object.isFrozen(api)).toBe(true);
    expect(Object.keys(api).sort()).toEqual(["open", "getState", "command", "getTerminalRuntime", "getApplicationSettings", "onChanged", "onApplicationSettingsChanged"].sort());
    expect(api).not.toHaveProperty("publish"); expect(api).not.toHaveProperty("ownerReady");
    expect(api).not.toHaveProperty("getScriptRuntime"); expect(api).not.toHaveProperty("readScript");
  });
  it("does not accept source, paths, owner IDs, arbitrary actions or malformed UUIDs", () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    api.command({ type: "run", id });
    expect(mocks.invoke).toHaveBeenLastCalledWith(SCRIPT_TASK_IPC.command, { type: "run", id });
    const invalid = [{ type: "eval", id }, { type: "run", id: "../source.js" }, { type: "run", id, source: "x" }, { type: "run", id, ownerId: 3 }];
    for (const command of invalid) expect(() => api.command(command as never)).toThrow();
    api.getState(); expect(mocks.invoke).toHaveBeenLastCalledWith(SCRIPT_TASK_IPC.getState);
    api.getTerminalRuntime(); expect(mocks.invoke).toHaveBeenLastCalledWith(SCRIPT_TASK_IPC.getTerminalRuntime);
  });
  it("strips Electron events from display subscriptions and unsubscribes", () => {
    const listener = vi.fn(); const unsubscribe = api.onChanged(listener);
    const handler = mocks.on.mock.calls.findLast(([channel]) => channel === SCRIPT_TASK_IPC.changed)![1];
    const state = { scripts: [], records: [], outputReset: 0, pending: false };
    handler({ secret: true }, state); expect(listener).toHaveBeenCalledExactlyOnceWith(state);
    handler({}, state, "extra"); handler({}, null); expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe(); expect(mocks.removeListener).toHaveBeenCalledWith(SCRIPT_TASK_IPC.changed, handler);
  });
});
