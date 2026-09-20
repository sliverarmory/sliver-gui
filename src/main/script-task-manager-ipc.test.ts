// @vitest-environment node
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { SCRIPT_TASK_IPC } from "../shared/script-task-manager-contracts.js";
import { ScriptTaskManagerRelay } from "./script-task-manager.js";
import { registerScriptTaskManagerIpc, unregisterScriptTaskManagerIpc } from "./script-task-manager-ipc.js";

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(), fromWebContents: vi.fn() }));
vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: mocks.fromWebContents }, ipcMain: {
  handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler),
  removeHandler: (channel: string) => mocks.handlers.delete(channel),
} }));
const OWNER_URL = "sliver://app/index.html";
const MANAGER_URL = `${OWNER_URL}?surface=script-task-manager`;
const ID = "123e4567-e89b-42d3-a456-426614174000";
const ownerWindow = { isDestroyed: () => false } as BrowserWindow;
const managerWindow = { isDestroyed: () => false } as BrowserWindow;
const snapshot = { scripts: [{ id: ID, name: "Hello", dirty: false, conflict: false }], selectedId: ID, records: [], outputReset: 0, pending: false };

function event(id: number, url = id === 1 ? OWNER_URL : MANAGER_URL): IpcMainInvokeEvent {
  const frame = { processId: id * 10, frameToken: `${id}-frame`, url, isDestroyed: () => false };
  return { sender: { id, isDestroyed: () => false, mainFrame: frame, getURL: () => url }, senderFrame: frame } as unknown as IpcMainInvokeEvent;
}
function setup() {
  const send = vi.fn(); const relay = new ScriptTaskManagerRelay(send);
  relay.registerOwner(1); relay.attachManager(1, 2);
  const authorize = vi.fn((window: BrowserWindow) => window === ownerWindow
    ? { role: "owner" as const, ownerId: 1 } : window === managerWindow ? { role: "manager" as const, ownerId: 1 } : undefined);
  const open = vi.fn(async () => ({ ok: true as const }));
  registerScriptTaskManagerIpc({ relay, workspaceUrl: OWNER_URL, managerUrl: MANAGER_URL, authorize, open, settings: () => DEFAULT_APPLICATION_SETTINGS_STATE });
  return { send, relay, authorize, open };
}
async function invoke(channel: string, sender: IpcMainInvokeEvent, ...args: unknown[]) { return await mocks.handlers.get(channel)!(sender, ...args); }
beforeEach(() => {
  mocks.handlers.clear(); mocks.fromWebContents.mockReset();
  mocks.fromWebContents.mockImplementation((contents) => contents.id === 1 ? ownerWindow : contents.id === 2 ? managerWindow : undefined);
});

describe("Script Task Manager IPC", () => {
  it("relays validated snapshots and commands using the authorized source, never renderer-selected windows", async () => {
    const { send } = setup();
    expect(await invoke(SCRIPT_TASK_IPC.publish, event(1), snapshot)).toEqual({ ok: true });
    expect(await invoke(SCRIPT_TASK_IPC.getState, event(2))).toEqual({ ok: true, value: snapshot });
    expect(await invoke(SCRIPT_TASK_IPC.ownerReady, event(1))).toEqual({ ok: true });
    expect(await invoke(SCRIPT_TASK_IPC.command, event(2), { type: "run", id: ID })).toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(1, SCRIPT_TASK_IPC.commandRequested, { type: "run", id: ID });
    expect(await invoke(SCRIPT_TASK_IPC.getApplicationSettings, event(2))).toEqual(DEFAULT_APPLICATION_SETTINGS_STATE);
  });

  it("rejects commands from owners and publications/readiness from companions", async () => {
    setup();
    for (const [channel, sender, args] of [
      [SCRIPT_TASK_IPC.command, event(1), [{ type: "run", id: ID }]],
      [SCRIPT_TASK_IPC.publish, event(2), [snapshot]],
      [SCRIPT_TASK_IPC.ownerReady, event(2), []],
    ] as const) expect(await invoke(channel, sender, ...args)).toMatchObject({ ok: false });
  });

  it("rejects unknown, auxiliary, subframe, navigated, and stale sender identities", async () => {
    const { authorize, open } = setup();
    const subframe = event(1);
    Object.assign(subframe, { senderFrame: { ...subframe.senderFrame, frameToken: "child", isDestroyed: () => false } });
    for (const sender of [event(99), event(1, MANAGER_URL), event(2, OWNER_URL), event(1, "https://example.com"), subframe]) {
      expect(await invoke(SCRIPT_TASK_IPC.open, sender)).toMatchObject({ ok: false });
    }
    authorize.mockReturnValue(undefined);
    expect(await invoke(SCRIPT_TASK_IPC.open, event(1))).toMatchObject({ ok: false });
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects extra args, source/path payloads, unknown IDs and capability redirection", async () => {
    const { send } = setup(); send.mockClear();
    for (const [channel, sender, args] of [
      [SCRIPT_TASK_IPC.open, event(1), [2]],
      [SCRIPT_TASK_IPC.getState, event(2), [{ ownerId: 123 }]],
      [SCRIPT_TASK_IPC.publish, event(1), [{ ...snapshot, source: "x" }]],
      [SCRIPT_TASK_IPC.publish, event(1), [snapshot, "extra"]],
      [SCRIPT_TASK_IPC.command, event(2), [{ type: "run", id: ID, path: "/tmp/script.js" }]],
      [SCRIPT_TASK_IPC.command, event(2), [{ type: "run", id: ID }]],
    ] as const) expect(await invoke(channel, sender, ...args)).toMatchObject({ ok: false });
    expect(send).not.toHaveBeenCalled();
    unregisterScriptTaskManagerIpc(); expect(mocks.handlers.size).toBe(0);
  });
});
