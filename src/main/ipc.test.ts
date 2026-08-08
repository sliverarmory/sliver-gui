// @vitest-environment node

import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IPC } from "../shared/contracts.js";
import type { ConnectionRegistry } from "./connection-registry.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  fromWebContents: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  ipcMain: {
    handle: electronMocks.handle,
    removeHandler: electronMocks.removeHandler,
  },
}));

import { registerIpcHandlers } from "./ipc.js";

const RENDERER_URL = "http://127.0.0.1:5173";

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue({});
});

describe("trusted Electron IPC boundary", () => {
  it("accepts the registered main frame and captures its webContents ID", () => {
    const snapshot = vi.fn((contentsId: number) => ({ contentsId }));
    registerIpcHandlers({ snapshot } as unknown as ConnectionRegistry, vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/builds", 42);

    expect(electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toEqual({ contentsId: 42 });
    expect(snapshot).toHaveBeenCalledWith(42);
  });

  it("rejects origins that merely prefix-match the configured renderer", () => {
    registerIpcHandlers({} as ConnectionRegistry, vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173.evil.test/", 42);

    expect(() => electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toThrow(/untrusted renderer/);
  });

  it("rejects child-frame invocations even when they use the trusted origin", () => {
    registerIpcHandlers({} as ConnectionRegistry, vi.fn(), RENDERER_URL);
    const { event, mainFrame } = invokeEvent("http://127.0.0.1:5173/", 42);
    const childFrame = {
      ...mainFrame,
      frameToken: "child-frame",
    } as WebFrameMain;
    Object.defineProperty(event, "senderFrame", { value: childFrame });

    expect(() => electronMocks.handlers.get(IPC.getSnapshot)?.(event)).toThrow(/untrusted renderer/);
  });

  it("scopes saved-config list and connect calls to the invoking main window", () => {
    const listSavedConfigs = vi.fn((contentsId: number) => ({ ok: true, value: [{ contentsId }] }));
    const connectSavedConfig = vi.fn((contentsId: number, id: string) => ({ ok: true, value: { contentsId, id } }));
    registerIpcHandlers(
      { listSavedConfigs, connectSavedConfig } as unknown as ConnectionRegistry,
      vi.fn(),
      RENDERER_URL,
    );
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);
    const id = "3f3bfca3-b80a-4cf2-b7e2-a2d86e5a01b2";

    expect(electronMocks.handlers.get(IPC.listSavedConfigs)?.(event)).toEqual({ ok: true, value: [{ contentsId: 77 }] });
    expect(electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, id)).toEqual({
      ok: true,
      value: { contentsId: 77, id },
    });
    expect(listSavedConfigs).toHaveBeenCalledWith(77);
    expect(connectSavedConfig).toHaveBeenCalledWith(77, id);
  });

  it("rejects malformed saved-config IDs at the central IPC boundary", () => {
    const connectSavedConfig = vi.fn();
    registerIpcHandlers({ connectSavedConfig } as unknown as ConnectionRegistry, vi.fn(), RENDERER_URL);
    const { event } = invokeEvent("http://127.0.0.1:5173/", 77);

    expect(() => electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, "../../operator.cfg")).toThrow(
      /invalid saved configuration selection/,
    );
    expect(() => electronMocks.handlers.get(IPC.connectSavedConfig)?.(event, { id: "anything" })).toThrow(
      /invalid saved configuration selection/,
    );
    expect(connectSavedConfig).not.toHaveBeenCalled();
  });
});

function invokeEvent(url: string, contentsId: number): {
  event: IpcMainInvokeEvent;
  mainFrame: WebFrameMain;
} {
  const mainFrame = {
    frameToken: "main-frame",
    processId: 100,
    url,
    isDestroyed: () => false,
  } as WebFrameMain;
  const sender = {
    id: contentsId,
    mainFrame,
    getURL: () => url,
    isDestroyed: () => false,
  } as unknown as WebContents;
  const event = {
    sender,
    senderFrame: mainFrame,
  } as IpcMainInvokeEvent;
  return { event, mainFrame };
}
