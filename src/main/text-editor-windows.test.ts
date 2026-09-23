// @vitest-environment node

import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../shared/application-settings-contracts.js";
import { TEXT_EDITOR_IPC, TEXT_EDITOR_MAX_BYTES } from "../shared/text-editor-contracts.js";
import type { SessionDestructiveActionPlan } from "../shared/session-contracts.js";
import { TextEditorWindows } from "./text-editor-windows.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>>(),
  windows: [] as MockWindow[],
  showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBoxSync: vi.fn(),
}));

interface MockWindow {
  destroyed: boolean;
  webContents: WebContents & { currentUrl: string };
  emit(event: string, ...args: unknown[]): boolean;
  isDestroyed(): boolean;
  destroy(): void;
  setTitle: ReturnType<typeof vi.fn>;
}

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    BrowserWindow: class extends EventEmitter {
      destroyed = false;
      webContents = Object.assign(new EventEmitter(), {
        id: mocks.windows.length + 1,
        currentUrl: "",
        mainFrame: { processId: 10, frameToken: "main", url: "", isDestroyed: () => false },
        isDestroyed: () => this.destroyed,
        getURL: () => this.webContents.currentUrl,
        setWindowOpenHandler: vi.fn(),
      });
      setTitle = vi.fn();
      setDocumentEdited = vi.fn();
      constructor() { super(); mocks.windows.push(this as unknown as MockWindow); }
      isDestroyed(): boolean { return this.destroyed; }
      async loadURL(url: string): Promise<void> {
        this.webContents.currentUrl = url;
        this.webContents.mainFrame.url = url;
      }
      destroy(): void { this.destroyed = true; this.emit("closed"); }
    },
    dialog: { showOpenDialog: mocks.showOpenDialog, showSaveDialog: mocks.showSaveDialog, showMessageBoxSync: mocks.showMessageBoxSync },
    nativeTheme: { shouldUseDarkColors: true },
    ipcMain: {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler),
      removeHandler: (channel: string) => mocks.handlers.delete(channel),
    },
  };
});

const URL = "sliver://app/index.html?surface=text-editor";
let manager: TextEditorWindows;
let directory: string;

beforeEach(async () => {
  mocks.handlers.clear();
  mocks.windows.length = 0;
  mocks.showOpenDialog.mockReset().mockResolvedValue({ canceled: true, filePaths: [] });
  mocks.showSaveDialog.mockReset().mockResolvedValue({ canceled: true });
  mocks.showMessageBoxSync.mockReset().mockReturnValue(0);
  directory = await mkdtemp(join(tmpdir(), "text-editor-test-"));
  manager = new TextEditorWindows({ rendererUrl: URL, preloadPath: "/text-editor.cjs",
    getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE, prepareWindow: vi.fn() });
  await manager.open();
});

afterEach(async () => { manager.dispose(); await rm(directory, { recursive: true, force: true }); });

function currentWindow(): MockWindow {
  const window = mocks.windows.at(-1);
  if (!window) throw new Error("Missing test editor window");
  return window;
}

function eventFor(window = currentWindow()): IpcMainInvokeEvent {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return invokeFrom(eventFor(), channel, ...args);
}

async function invokeFrom(event: IpcMainInvokeEvent, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Missing test IPC handler");
  return handler(event, ...args);
}

function cancelableEvent(): { preventDefault: ReturnType<typeof vi.fn> } { return { preventDefault: vi.fn() }; }

describe("standalone local text editor host", () => {
  it("opens a remote document and confirms the exact overwrite before accepting a save", async () => {
    const source = currentWindow().webContents;
    manager.dispose();
    const oldDigest = "a".repeat(64);
    const newDigest = "b".repeat(64);
    const plan = {
      target: { name: "payments", hostname: "host", backend: { displayName: "Production" } },
      artifact: { sha256: newDigest }, warning: "The upload is not atomic.",
    } as SessionDestructiveActionPlan;
    const binding = {};
    const save = vi.fn(async (_binding: unknown, _path: string, _digest: string, _text: string,
      confirm: (plan: SessionDestructiveActionPlan) => Promise<boolean>) =>
      await confirm(plan) ? { expectedSha256: newDigest } : null);
    const load = vi.fn().mockResolvedValue({ title: "notes.txt", text: "original", expectedSha256: oldDigest, binding });
    manager = new TextEditorWindows({ rendererUrl: URL, preloadPath: "/text-editor.cjs",
      getApplicationSettings: () => DEFAULT_APPLICATION_SETTINGS_STATE, prepareWindow: vi.fn(),
      remote: { load, save } });
    await manager.openRemote(source, "/opt/notes.txt");
    expect(load).toHaveBeenCalledWith(source, "/opt/notes.txt");
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: {
      title: "notes.txt", text: "original", remote: true,
    } });
    await invoke(TEXT_EDITOR_IPC.setDirty, true);
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "edited", saveAs: true })).toMatchObject({ ok: false });
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "edited", saveAs: false })).toEqual({ ok: true, value: null });
    expect(save).toHaveBeenCalledWith(binding, "/opt/notes.txt", oldDigest, "edited", expect.any(Function));
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: { text: "original" } });
    expect(manager.allowQuit()).toBe(false);
    mocks.showMessageBoxSync.mockReturnValue(1);
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "edited", saveAs: false })).toEqual({ ok: true, value: { title: "notes.txt" } });
    expect(mocks.showMessageBoxSync).toHaveBeenCalledWith(currentWindow(), expect.objectContaining({
      title: "Overwrite remote file?", buttons: ["Cancel", "Overwrite File"], defaultId: 0, cancelId: 0,
    }));
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: { text: "edited" } });
    expect(save).toHaveBeenLastCalledWith(binding, "/opt/notes.txt", oldDigest, "edited", expect.any(Function));
  });

  it("exposes only display document data, with independent initial documents", async () => {
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toEqual({ ok: true, value: {
      id: expect.any(String), title: "Untitled", text: "", language: "plaintext", readOnly: false,
    } });
    await manager.open({ title: "notes.md", text: "# Notes", readOnly: true });
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: {
      title: "notes.md", text: "# Notes", language: "markdown", readOnly: true,
    } });
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "replacement", saveAs: true })).toMatchObject({ ok: false, error: "This document is read-only" });
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
  });

  it.each(["setup.sh", "deploy.bash", "interactive.zsh", ".bashrc", ".profile"])(
    "infers Bash highlighting for %s",
    async (title) => {
      await manager.open({ title, text: "echo ready\n" });
      expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({
        ok: true,
        value: { title, language: "shell" },
      });
    },
  );

  it.each([
    ["binary bytes", Buffer.from([0x61, 0x00, 0x62]), /text files/u],
    ["invalid UTF-8", Buffer.from([0xff, 0x61]), /UTF-8/u],
    ["UTF-16", Buffer.from([0xff, 0xfe, 0x61, 0x00]), /UTF-8/u],
    ["oversized content", Buffer.alloc(TEXT_EDITOR_MAX_BYTES + 1, "x"), /2 MiB/u],
  ])("rejects %s regardless of the filename extension", async (_name, contents, error) => {
    const path = join(directory, "looks-like-text.txt");
    await writeFile(path, contents);
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    expect(await invoke(TEXT_EDITOR_IPC.openFile)).toMatchObject({ ok: false, error: expect.stringMatching(error) });
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: { title: "Untitled", text: "" } });
  });

  it("accepts Unicode text without a known extension and keeps all native paths private", async () => {
    const path = join(directory, "notes.unrecognized");
    await writeFile(path, "A note 📝\n中文\n");
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    const result = await invoke(TEXT_EDITOR_IPC.openFile);
    expect(result).toMatchObject({ ok: true, value: { title: "notes.unrecognized", language: "plaintext", text: "A note 📝\n中文\n" } });
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(JSON.stringify(await invoke(TEXT_EDITOR_IPC.getDocument))).not.toContain(directory);
  });

  it("preserves a UTF-8 BOM and CRLF while saving atomically and retaining dirty state", async () => {
    const path = join(directory, "notes.xml");
    await writeFile(path, "\ufeff<a>\r\ntext\r\n</a>\r\n");
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    expect(await invoke(TEXT_EDITOR_IPC.openFile)).toMatchObject({ ok: true, value: { language: "xml", text: "<a>\r\ntext\r\n</a>\r\n" } });
    await invoke(TEXT_EDITOR_IPC.setDirty, true);
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "<a>\nnew text\n</a>\n", saveAs: false })).toEqual({ ok: true, value: { title: "notes.xml" } });
    expect(await readFile(path, "utf8")).toBe("\ufeff<a>\r\nnew text\r\n</a>\r\n");
    expect(await readdir(directory)).toEqual(["notes.xml"]);
    expect(manager.allowQuit()).toBe(false);
    await invoke(TEXT_EDITOR_IPC.setDirty, false);
    expect(manager.allowQuit()).toBe(true);
  });

  it("preserves the document and unsaved guard when Save As is canceled or fails", async () => {
    await manager.open({ title: "draft.txt", text: "original" });
    await invoke(TEXT_EDITOR_IPC.setDirty, true);
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "new", saveAs: true })).toEqual({ ok: true, value: null });
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: join(directory, "missing", "new.txt") });
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "new", saveAs: true })).toMatchObject({ ok: false });
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: true, value: { title: "draft.txt", text: "original" } });
    expect(manager.allowQuit()).toBe(false);
  });

  it("serializes native file operations while allowing new edits to remain dirty", async () => {
    let finishDialog!: (value: { canceled: boolean; filePath: string }) => void;
    mocks.showSaveDialog.mockImplementation(() => new Promise((resolve) => { finishDialog = resolve; }));
    const save = invoke(TEXT_EDITOR_IPC.save, { text: "saved snapshot", saveAs: true });
    expect(await invoke(TEXT_EDITOR_IPC.openFile)).toMatchObject({ ok: false, error: expect.stringMatching(/already in progress/u) });
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "other", saveAs: false })).toMatchObject({ ok: false });
    await invoke(TEXT_EDITOR_IPC.setDirty, true);
    expect(manager.allowQuit()).toBe(false);
    finishDialog({ canceled: false, filePath: join(directory, "draft.txt") });
    expect(await save).toMatchObject({ ok: true });
    expect(manager.allowQuit()).toBe(false);
    expect(await readFile(join(directory, "draft.txt"), "utf8")).toBe("saved snapshot");
  });

  it("rejects foreign, child, stale, and wrong-document IPC frames", async () => {
    const event = eventFor();
    const child = { ...event, senderFrame: { ...event.senderFrame, frameToken: "child" } } as IpcMainInvokeEvent;
    expect(await invokeFrom(child, TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: false });
    const foreign = { ...event, sender: { ...event.sender, id: 999 } } as IpcMainInvokeEvent;
    expect(await invokeFrom(foreign, TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: false });
    const stale = { ...event, senderFrame: { ...event.senderFrame, processId: 99 } } as IpcMainInvokeEvent;
    expect(await invokeFrom(stale, TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: false });
    currentWindow().webContents.currentUrl = "sliver://app/index.html";
    expect(await invoke(TEXT_EDITOR_IPC.getDocument)).toMatchObject({ ok: false });
  });

  it("revokes pending file dialogs when the sending frame changes", async () => {
    let finishDialog!: (value: { canceled: boolean; filePath: string }) => void;
    mocks.showSaveDialog.mockImplementation(() => new Promise((resolve) => { finishDialog = resolve; }));
    const save = invoke(TEXT_EDITOR_IPC.save, { text: "must not write", saveAs: true });
    Object.defineProperty(currentWindow().webContents, "mainFrame", { configurable: true,
      value: { ...currentWindow().webContents.mainFrame, frameToken: "replacement" } as WebFrameMain });
    finishDialog({ canceled: false, filePath: join(directory, "draft.txt") });
    expect(await save).toMatchObject({ ok: false });
    expect(await readdir(directory)).toEqual([]);
  });

  it("rejects renderer-supplied paths and malformed state without opening native dialogs", async () => {
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "hello", saveAs: false, path: "/tmp/arbitrary" })).toMatchObject({ ok: false });
    expect(await invoke(TEXT_EDITOR_IPC.setDirty, "yes")).toMatchObject({ ok: false });
    expect(await invoke(TEXT_EDITOR_IPC.openFile, "/tmp/arbitrary")).toMatchObject({ ok: false });
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "\ud800", saveAs: true })).toMatchObject({ ok: false });
    expect(mocks.showSaveDialog).not.toHaveBeenCalled();
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  });

  it("requires confirmation for a renderer unload veto even when dirty IPC has not arrived", () => {
    const close = cancelableEvent();
    currentWindow().emit("close", close);
    expect(close.preventDefault).not.toHaveBeenCalled();
    const unload = cancelableEvent();
    currentWindow().webContents.emit("will-prevent-unload", unload);
    expect(mocks.showMessageBoxSync).toHaveBeenCalledWith(currentWindow(), expect.objectContaining({ title: "Unsaved changes" }));
    expect(unload.preventDefault).not.toHaveBeenCalled();
    mocks.showMessageBoxSync.mockReturnValue(1);
    currentWindow().webContents.emit("will-prevent-unload", unload);
    expect(unload.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("allows explicit discard once and revokes approvals when application quit is canceled", async () => {
    await invoke(TEXT_EDITOR_IPC.setDirty, true);
    mocks.showMessageBoxSync.mockReturnValue(1);
    expect(manager.allowQuit()).toBe(true);
    mocks.showMessageBoxSync.mockClear();
    expect(manager.allowQuit()).toBe(true);
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    manager.cancelQuit();
    mocks.showMessageBoxSync.mockReturnValue(0);
    const close = cancelableEvent();
    currentWindow().emit("close", close);
    expect(close.preventDefault).toHaveBeenCalledTimes(1);
    mocks.showMessageBoxSync.mockReturnValue(1);
    currentWindow().emit("close", cancelableEvent());
    mocks.showMessageBoxSync.mockClear();
    const unload = cancelableEvent();
    currentWindow().webContents.emit("will-prevent-unload", unload);
    expect(unload.preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
  });

  it("rejects symbolic links without replacing the link or modifying its target", async () => {
    const target = join(directory, "original.txt");
    const link = join(directory, "linked.txt");
    await writeFile(target, "original");
    await symlink(target, link);
    mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [link] });
    expect(await invoke(TEXT_EDITOR_IPC.openFile)).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/u) });
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: link });
    expect(await invoke(TEXT_EDITOR_IPC.save, { text: "replacement", saveAs: true })).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/u) });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("original");
    expect((await readdir(directory)).sort()).toEqual(["linked.txt", "original.txt"]);
  });

  it("disposes windows and unregisters the dedicated handlers", async () => {
    const event = eventFor();
    const handler = mocks.handlers.get(TEXT_EDITOR_IPC.getDocument);
    manager.dispose();
    expect(mocks.handlers.size).toBe(0);
    expect(currentWindow().isDestroyed()).toBe(true);
    expect(await handler?.(event)).toMatchObject({ ok: false });
  });
});
