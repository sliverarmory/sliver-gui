// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GHOSTTY_SETTINGS_IPC } from "../shared/ghostty-settings-contracts.js";
import { GhosttyConfigStore } from "./ghostty-config.js";
import { registerGhosttySettingsIpc } from "./ghostty-settings-ipc.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  watch: vi.fn(),
}));

vi.mock("electron", () => ({ ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler } }));
vi.mock("node:fs", async (importOriginal) => ({ ...await importOriginal<typeof import("node:fs")>(), watch: mocks.watch }));

const rendererUrl = "sliver://app/index.html?surface=console";
let directory = "";
let store: GhosttyConfigStore;
let ipc: ReturnType<typeof registerGhosttySettingsIpc> | undefined;
const watchers: { changed: () => void; close: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }[] = [];

beforeEach(async () => {
  vi.resetAllMocks();
  mocks.handlers.clear();
  watchers.length = 0;
  mocks.handle.mockImplementation((channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler));
  mocks.removeHandler.mockImplementation((channel: string) => mocks.handlers.delete(channel));
  mocks.watch.mockImplementation((_path: string, _options: unknown, changed: () => void) => {
    const watcher = { changed, close: vi.fn(), on: vi.fn() };
    watchers.push(watcher);
    return watcher;
  });
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-ghostty-ipc-"));
  store = await GhosttyConfigStore.load({ directory, themeDirectories: [] });
  await store.ensureConfig();
});

afterEach(async () => {
  ipc?.dispose();
  ipc = undefined;
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const frame = { processId: 42, frameToken: "approved-main", url: rendererUrl, isDestroyed: vi.fn(() => false) };
  const contents = {
    mainFrame: frame,
    isDestroyed: vi.fn(() => false),
    getURL: vi.fn(() => rendererUrl),
    send: vi.fn(),
  };
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) };
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const resolveWindow = vi.fn((): { window: BrowserWindow; rendererUrl: string } | undefined => ({ window: window as unknown as BrowserWindow, rendererUrl }));
  const onChanged = vi.fn();
  const editConfig = vi.fn(async () => undefined);
  const windows = vi.fn(() => [window as unknown as BrowserWindow]);
  ipc = registerGhosttySettingsIpc({ store, resolveWindow, windows, editConfig, onChanged });
  return { frame, contents, window, event, resolveWindow, onChanged, editConfig, windows };
}

function invoke(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Handler not registered");
  return handler(event, ...args);
}

describe("Ghostty appearance IPC", () => {
  it("exposes the snapshot only to the approved exact renderer document and its live main frame", async () => {
    const { event, contents, frame, window, resolveWindow } = fixture();
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).resolves.toMatchObject({ configPath: store.configPath, theme: "", nativeTerminalTransparency: expect.any(Boolean) });
    resolveWindow.mockReturnValueOnce(undefined);
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).rejects.toThrow("cannot access");
    window.isDestroyed.mockReturnValueOnce(true);
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).rejects.toThrow("cannot access");
    contents.isDestroyed.mockReturnValueOnce(true);
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).rejects.toThrow("cannot access");
    frame.isDestroyed.mockReturnValueOnce(true);
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).rejects.toThrow("cannot access");
    contents.getURL.mockReturnValueOnce("sliver://app/index.html?surface=ssh");
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, event)).rejects.toThrow("cannot access");
    for (const senderFrame of [null, { ...frame, processId: 100 }, { ...frame, frameToken: "child" }, { ...frame, url: "https://example.test/" }]) {
      await expect(invoke(GHOSTTY_SETTINGS_IPC.get, { ...event, senderFrame } as unknown as IpcMainInvokeEvent)).rejects.toThrow("cannot access");
    }
    await expect(invoke(GHOSTTY_SETTINGS_IPC.get, { ...event, sender: { ...contents } } as unknown as IpcMainInvokeEvent)).rejects.toThrow("cannot access");
  });

  it("validates every request before writing or opening the editor", async () => {
    const { event, editConfig, onChanged } = fixture();
    const original = await readFile(store.configPath, "utf8");
    for (const channel of [GHOSTTY_SETTINGS_IPC.get, GHOSTTY_SETTINGS_IPC.reload, GHOSTTY_SETTINGS_IPC.edit]) {
      await expect(invoke(channel, event, "/unexpected/path")).rejects.toThrow("Unexpected");
    }
    for (const args of [[], [null], ["theme", "extra"], ["theme\ncommand=anything"], ["x".repeat(4097)]]) {
      await expect(invoke(GHOSTTY_SETTINGS_IPC.setTheme, event, ...args)).rejects.toThrow("Invalid");
    }
    await expect(invoke(GHOSTTY_SETTINGS_IPC.setTheme, event, "../outside")).resolves.toMatchObject({ ok: false });
    expect(await readFile(store.configPath, "utf8")).toBe(original);
    expect(editConfig).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("publishes saved appearance to live windows and tolerates a closing renderer", async () => {
    const { event, contents, windows, onChanged } = fixture();
    const closing = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn(() => { throw new Error("closed"); }) } };
    const destroyed = { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: vi.fn() } };
    windows.mockReturnValue([closing, destroyed, { isDestroyed: () => false, webContents: contents }] as unknown as BrowserWindow[]);
    await writeFile(join(directory, "themes", "Ocean"), "background=#010203");
    await expect(invoke(GHOSTTY_SETTINGS_IPC.setTheme, event, "Ocean")).resolves.toMatchObject({ ok: true, value: { theme: "Ocean", dark: { background: "#010203" } } });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(GHOSTTY_SETTINGS_IPC.changed, expect.objectContaining({ theme: "Ocean" }));
    expect(destroyed.webContents.send).not.toHaveBeenCalled();
  });

  it("coalesces reloads and only broadcasts a semantic change", async () => {
    const { contents, onChanged } = fixture();
    const originalReload = store.reload.bind(store);
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(store, "reload").mockImplementationOnce(async () => { await wait; return originalReload(); });
    const first = ipc!.reload();
    expect(ipc!.reload()).toBe(first);
    release!();
    await first;
    expect(onChanged).not.toHaveBeenCalled();
    await writeFile(store.configPath, "background=#112233");
    await ipc!.reload();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(contents.send).toHaveBeenCalledOnce();
    await ipc!.reload();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("opens only the managed configuration and rechecks authorization after creating it", async () => {
    const { event, editConfig, resolveWindow } = fixture();
    await expect(invoke(GHOSTTY_SETTINGS_IPC.edit, event)).resolves.toEqual({ ok: true });
    expect(editConfig).toHaveBeenCalledExactlyOnceWith();
    editConfig.mockClear();
    const realEnsure = store.ensureConfig.bind(store);
    vi.spyOn(store, "ensureConfig").mockImplementationOnce(async () => {
      const path = await realEnsure();
      resolveWindow.mockReturnValue(undefined);
      return path;
    });
    await expect(invoke(GHOSTTY_SETTINGS_IPC.edit, event)).resolves.toMatchObject({ ok: false });
    expect(editConfig).not.toHaveBeenCalled();
  });

  it("debounces file notifications and removes handlers, watchers and pending callbacks on dispose", async () => {
    const { event, onChanged } = fixture();
    expect(watchers).toHaveLength(2);
    const handler = mocks.handlers.get(GHOSTTY_SETTINGS_IPC.get)!;
    vi.useFakeTimers();
    const reload = vi.spyOn(store, "reload");
    await writeFile(store.configPath, "foreground=#ffffff");
    watchers[0]!.changed();
    watchers[1]!.changed();
    await vi.advanceTimersByTimeAsync(149);
    expect(reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await ipc!.reload();
    expect(reload).toHaveBeenCalledOnce();
    expect(onChanged).toHaveBeenCalledOnce();
    watchers[0]!.changed();
    ipc!.dispose();
    ipc!.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(reload).toHaveBeenCalledOnce();
    expect(watchers.every((watcher) => watcher.close.mock.calls.length === 1)).toBe(true);
    expect(mocks.handlers.size).toBe(0);
    await expect(handler(event)).rejects.toThrow("cannot access");
    await ipc!.reload();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps explicit reload available if filesystem watching is unsupported", async () => {
    mocks.watch.mockImplementation(() => { throw new Error("watch unsupported"); });
    const { event } = fixture();
    await writeFile(store.configPath, "background=#012345");
    await expect(invoke(GHOSTTY_SETTINGS_IPC.reload, event)).resolves.toMatchObject({ dark: { background: "#012345" } });
    expect(watchers).toHaveLength(0);
  });
});
