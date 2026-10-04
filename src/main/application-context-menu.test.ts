// @vitest-environment node

import { EventEmitter } from "node:events";

import type {
  ContextMenuParams,
  IpcMainEvent,
  IpcMainInvokeEvent,
  WebContents,
  WebFrameMain,
} from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APPLICATION_CONTEXT_MENU_IPC,
  parseApplicationContextMenuRequest,
  type ApplicationContextMenuActionItem,
  type ApplicationContextMenuRequest,
} from "../shared/application-context-menu-contracts.js";

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>(),
  listeners: new Map<string, (event: IpcMainEvent, ...args: unknown[]) => unknown>(),
  handle: vi.fn(),
  on: vi.fn(),
  removeHandler: vi.fn(),
  removeListener: vi.fn(),
  clipboardWriteText: vi.fn(),
  openExternal: vi.fn(),
  appFocus: vi.fn(),
  windowFocus: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { focus: electronMocks.appFocus },
  BrowserWindow: {
    fromWebContents: vi.fn(() => ({
      focus: electronMocks.windowFocus,
      isDestroyed: () => false,
    })),
  },
  clipboard: {
    writeText: electronMocks.clipboardWriteText,
  },
  ipcMain: {
    handle: electronMocks.handle,
    on: electronMocks.on,
    removeHandler: electronMocks.removeHandler,
    removeListener: electronMocks.removeListener,
  },
  shell: { openExternal: electronMocks.openExternal },
}));

import {
  APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS,
  APPLICATION_CONTEXT_MENU_RESTRICTED_TARGET_TTL_MS,
  APPLICATION_CONTEXT_MENU_VISIBLE_LEASE_TTL_MS,
  ApplicationContextMenuController,
} from "./application-context-menu.js";

class FakeWebFrameMain {
  public destroyed = false;
  public detached = false;
  public parent: FakeWebFrameMain | null = null;

  public constructor(
    public processId = 100,
    public frameToken = "main-frame",
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWebContents extends EventEmitter {
  public readonly send = vi.fn();
  public readonly getZoomFactor = vi.fn().mockReturnValue(1);
  public readonly focus = vi.fn();
  public readonly undo = vi.fn();
  public readonly redo = vi.fn();
  public readonly cut = vi.fn();
  public readonly copy = vi.fn();
  public readonly paste = vi.fn();
  public readonly pasteAndMatchStyle = vi.fn();
  public readonly delete = vi.fn();
  public readonly selectAll = vi.fn();
  public readonly replaceMisspelling = vi.fn();
  public readonly copyImageAt = vi.fn();
  public readonly inspectElement = vi.fn();
  public destroyed = false;
  public frame: FakeWebFrameMain;

  public constructor(public readonly id: number) {
    super();
    this.frame = new FakeWebFrameMain(id + 1_000, `frame-${id}`);
  }

  public get mainFrame(): WebFrameMain {
    return this.frame as unknown as WebFrameMain;
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }
}

let controller: ApplicationContextMenuController;

beforeEach(() => {
  electronMocks.handlers.clear();
  electronMocks.listeners.clear();
  electronMocks.handle.mockReset();
  electronMocks.handle.mockImplementation(
    (channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      electronMocks.handlers.set(channel, handler);
    },
  );
  electronMocks.removeHandler.mockReset();
  electronMocks.removeHandler.mockImplementation((channel: string) => {
    electronMocks.handlers.delete(channel);
  });
  electronMocks.on.mockReset();
  electronMocks.on.mockImplementation(
    (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => unknown) => {
      electronMocks.listeners.set(channel, listener);
    },
  );
  electronMocks.removeListener.mockReset();
  electronMocks.removeListener.mockImplementation(
    (channel: string, listener: (event: IpcMainEvent, ...args: unknown[]) => unknown) => {
      if (electronMocks.listeners.get(channel) === listener) {
        electronMocks.listeners.delete(channel);
      }
    },
  );
  electronMocks.clipboardWriteText.mockReset();
  electronMocks.openExternal.mockReset();
  electronMocks.openExternal.mockResolvedValue(undefined);
  electronMocks.appFocus.mockReset();
  electronMocks.windowFocus.mockReset();
  controller = new ApplicationContextMenuController();
});

afterEach(() => {
  controller.dispose();
  vi.restoreAllMocks();
});

describe("ApplicationContextMenuController", () => {
  it("installs the isolated action channel and emits a serializable native-event model", () => {
    const contents = new FakeWebContents(41);
    controller.install(contents as unknown as WebContents);
    const nativeEvent = contextMenuEvent();

    contents.emit("context-menu", nativeEvent, contextParams({
      x: 12,
      y: 34,
      isEditable: true,
      misspelledWord: "teh",
      dictionarySuggestions: ["the", "tech"],
      linkURL: "https://sliver.sh/docs",
      mediaType: "image",
      hasImageContents: true,
      editFlags: editFlags({
        canUndo: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      }),
    }));

    expect(electronMocks.handle.mock.calls.map(([channel]) => channel)).toEqual([
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
    ]);
    expect(electronMocks.on).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
      expect.any(Function),
    );
    expect(nativeEvent.preventDefault).toHaveBeenCalledOnce();
    const request = sentRequest(contents);
    expect(request).toEqual(structuredClone(request));
    expect(request).toMatchObject({ v: 1, x: 12, y: 34 });
    expect(actionKinds(request)).toEqual([
      "replace-misspelling",
      "replace-misspelling",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "paste-and-match-style",
      "delete",
      "select-all",
      "open-link",
      "copy-link",
      "copy-image",
      "inspect",
    ]);
    expect(actionItem(request, "undo")).toMatchObject({
      label: "Undo",
      enabled: true,
      shortcut: "mod+z",
    });
    expect(actionItem(request, "redo")).toMatchObject({ label: "Redo", enabled: false });
    expect(JSON.stringify(request)).not.toContain("https://sliver.sh/docs");
  });

  it.each([
    { zoom: 0.9, x: 101, y: 52 },
    { zoom: 1, x: 91, y: 47 },
    { zoom: 1.25, x: 73, y: 38 },
    { zoom: 2, x: 46, y: 24 },
  ])("presents integer CSS coordinates at zoom $zoom while native image and inspection actions retain their event coordinates", async ({ zoom, x, y }) => {
    const contents = new FakeWebContents(141);
    contents.getZoomFactor.mockReturnValue(zoom);
    controller.install(contents as unknown as WebContents);
    const params = contextParams({ x: 91, y: 47, mediaType: "image", hasImageContents: true });

    emitContextMenu(contents, params);
    const imageRequest = sentRequest(contents);
    expect(imageRequest).toMatchObject({ x, y });
    expect(Number.isSafeInteger(imageRequest.x)).toBe(true);
    expect(Number.isSafeInteger(imageRequest.y)).toBe(true);
    await expect(execute(contents, imageRequest, actionItem(imageRequest, "copy-image"))).resolves.toBe(true);
    expect(contents.copyImageAt).toHaveBeenCalledExactlyOnceWith(91, 47);

    emitContextMenu(contents, params);
    const inspectionRequest = sentRequest(contents);
    expect(inspectionRequest).toMatchObject({ x, y });
    await expect(execute(contents, inspectionRequest, actionItem(inspectionRequest, "inspect"))).resolves.toBe(true);
    expect(contents.inspectElement).toHaveBeenCalledExactlyOnceWith(91, 47);
  });

  it("uses each webContents current zoom independently for every context-menu presentation", () => {
    const first = new FakeWebContents(142);
    const second = new FakeWebContents(143);
    first.getZoomFactor.mockReturnValue(0.9);
    second.getZoomFactor.mockReturnValue(1.25);
    controller.install(first as unknown as WebContents);
    controller.install(second as unknown as WebContents);
    const params = contextParams({ x: 450, y: 225 });

    emitContextMenu(first, params);
    emitContextMenu(second, params);
    expect(sentRequest(first)).toMatchObject({ x: 500, y: 250 });
    expect(sentRequest(second)).toMatchObject({ x: 360, y: 180 });

    first.getZoomFactor.mockReturnValue(2);
    emitContextMenu(first, params);
    emitContextMenu(second, params);
    expect(sentRequest(first)).toMatchObject({ x: 225, y: 113 });
    expect(sentRequest(second)).toMatchObject({ x: 360, y: 180 });
  });

  it("executes one enabled edit capability only once", async () => {
    const contents = new FakeWebContents(42);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      isEditable: true,
      selectionText: "selected text",
      editFlags: editFlags({ canCopy: true, canSelectAll: true }),
    }));
    const request = sentRequest(contents);
    const copy = actionItem(request, "copy");

    await expect(execute(contents, request, copy)).resolves.toBe(true);
    await expect(execute(contents, request, copy)).resolves.toBe(false);
    expect(contents.copy).toHaveBeenCalledExactlyOnceWith();
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(electronMocks.appFocus).not.toHaveBeenCalled();
    expect(electronMocks.windowFocus).toHaveBeenCalledOnce();
    expect(contents.focus).toHaveBeenCalledOnce();

    emitContextMenu(contents, contextParams({
      isEditable: true,
      editFlags: editFlags({ canPaste: true }),
    }));
    const pasteRequest = sentRequest(contents);
    await expect(execute(
      contents,
      pasteRequest,
      actionItem(pasteRequest, "paste"),
    )).resolves.toBe(true);
    expect(contents.paste).toHaveBeenCalledExactlyOnceWith();

    emitContextMenu(contents, contextParams({
      isEditable: true,
      editFlags: editFlags({ canPaste: true }),
    }));
    const pasteAndMatchStyleRequest = sentRequest(contents);
    await expect(execute(
      contents,
      pasteAndMatchStyleRequest,
      actionItem(pasteAndMatchStyleRequest, "paste-and-match-style"),
    )).resolves.toBe(true);
    expect(contents.pasteAndMatchStyle).toHaveBeenCalledExactlyOnceWith();

    emitContextMenu(contents, contextParams({
      isEditable: true,
      selectionText: "cut text",
      editFlags: editFlags({ canCut: true }),
    }));
    const cutRequest = sentRequest(contents);
    await expect(execute(
      contents,
      cutRequest,
      actionItem(cutRequest, "cut"),
    )).resolves.toBe(true);
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalledWith("cut text");
    expect(contents.cut).toHaveBeenCalledExactlyOnceWith();

    emitContextMenu(contents, contextParams({
      isEditable: true,
      selectionText: "delete text",
      editFlags: editFlags({ canDelete: true }),
    }));
    const deleteRequest = sentRequest(contents);
    await expect(execute(
      contents,
      deleteRequest,
      actionItem(deleteRequest, "delete"),
    )).resolves.toBe(true);
    expect(contents.delete).toHaveBeenCalledExactlyOnceWith();
  });

  it("enforces inspect-only capabilities for raw contenteditable surfaces", async () => {
    const contents = new FakeWebContents(52);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      formControlType: "none",
      isEditable: true,
      selectionText: "terminal selection",
      linkURL: "https://sliver.sh/docs",
      mediaType: "image",
      hasImageContents: true,
      editFlags: editFlags({
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
      }),
    }));

    const request = sentRequest(contents);
    expect(actionKinds(request)).toEqual(["inspect"]);
    await expect(execute(contents, request, actionItem(request, "inspect"))).resolves.toBe(true);
    expect(contents.inspectElement).toHaveBeenCalledOnce();
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(contents.cut).not.toHaveBeenCalled();
    expect(contents.paste).not.toHaveBeenCalled();
  });

  it("enforces inspect-only capabilities for non-editable canvas surfaces", async () => {
    const contents = new FakeWebContents(53);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      isEditable: false,
      formControlType: "none",
      mediaType: "canvas",
      selectionText: "canvas selection",
      linkURL: "https://sliver.sh/docs",
      editFlags: editFlags({
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      }),
    }));

    const request = sentRequest(contents);
    expect(actionKinds(request)).toEqual(["inspect"]);
    await expect(execute(contents, request, actionItem(request, "inspect"))).resolves.toBe(true);
    expect(contents.inspectElement).toHaveBeenCalledOnce();
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
    expect(contents.selectAll).not.toHaveBeenCalled();
  });

  it("retains normal editing capabilities for textarea form controls", () => {
    const contents = new FakeWebContents(54);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      formControlType: "text-area",
      isEditable: true,
      selectionText: "textarea selection",
      editFlags: editFlags({
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
      }),
    }));

    expect(actionKinds(sentRequest(contents))).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "paste-and-match-style",
      "delete",
      "select-all",
      "inspect",
    ]);
  });

  it("uses a private one-shot signal to restrict a descendant textarea", () => {
    const contents = new FakeWebContents(55);
    controller.install(contents as unknown as WebContents);
    const textarea = contextParams({
      formControlType: "text-area",
      isEditable: true,
      selectionText: "terminal selection",
      editFlags: editFlags({
        canUndo: true,
        canRedo: true,
        canCut: true,
        canCopy: true,
        canPaste: true,
        canDelete: true,
        canSelectAll: true,
      }),
    });

    signalRestrictedTarget(contents);
    emitContextMenu(contents, textarea);
    expect(actionKinds(sentRequest(contents))).toEqual(["inspect"]);

    // The mark is consumed by one native context-menu event only.
    emitContextMenu(contents, textarea);
    expect(actionKinds(sentRequest(contents))).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "paste-and-match-style",
      "delete",
      "select-all",
      "inspect",
    ]);

    // Payload-bearing and child-frame signals cannot restrict a later menu.
    signalRestrictedTarget(contents, contents.frame, "unexpected");
    const childFrame = new FakeWebFrameMain(contents.frame.processId, "child-frame");
    childFrame.parent = contents.frame;
    signalRestrictedTarget(contents, childFrame);
    emitContextMenu(contents, textarea);
    expect(actionKinds(sentRequest(contents))).toContain("cut");

    signalRestrictedTarget(contents);
    const afterRestrictedTargetTtl = Date.now() +
      APPLICATION_CONTEXT_MENU_RESTRICTED_TARGET_TTL_MS;
    const now = vi.spyOn(Date, "now").mockReturnValue(afterRestrictedTargetTtl);
    emitContextMenu(contents, textarea);
    expect(actionKinds(sentRequest(contents))).toContain("cut");
    now.mockRestore();
  });

  it("keeps spelling, link, image, and inspection payloads main-owned", async () => {
    const contents = new FakeWebContents(43);
    controller.install(contents as unknown as WebContents);
    const params = contextParams({
      x: 8,
      y: 9,
      isEditable: true,
      misspelledWord: "teh",
      dictionarySuggestions: ["the"],
      linkURL: "https://sliver.sh/docs",
      mediaType: "image",
      hasImageContents: true,
    });
    const cases = [
      ["replace-misspelling", contents.replaceMisspelling, ["the"]],
      ["open-link", electronMocks.openExternal, ["https://sliver.sh/docs"]],
      ["copy-link", electronMocks.clipboardWriteText, ["https://sliver.sh/docs"]],
      ["copy-image", contents.copyImageAt, [8, 9]],
      ["inspect", contents.inspectElement, [8, 9]],
    ] as const;

    for (const [kind, effect, expectedArguments] of cases) {
      emitContextMenu(contents, params);
      const request = sentRequest(contents);
      await expect(execute(contents, request, actionItem(request, kind))).resolves.toBe(true);
      expect(effect).toHaveBeenLastCalledWith(...expectedArguments);
    }
  });

  it("does not mint executable capabilities for disabled menu entries", async () => {
    const contents = new FakeWebContents(44);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      isEditable: true,
      editFlags: editFlags({ canPaste: false }),
    }));
    const request = sentRequest(contents);
    const paste = actionItem(request, "paste");

    expect(paste.enabled).toBe(false);
    await expect(execute(contents, request, paste)).resolves.toBe(false);
    expect(contents.paste).not.toHaveBeenCalled();
  });

  it("accepts actions only from the installed WebContents current live main frame", async () => {
    const contents = new FakeWebContents(45);
    const otherContents = new FakeWebContents(46);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);
    const copy = actionItem(request, "copy");

    await expect(execute(otherContents, request, copy)).resolves.toBe(false);
    const childFrame = new FakeWebFrameMain(contents.frame.processId, "child-frame");
    childFrame.parent = contents.frame;
    await expect(execute(contents, request, copy, childFrame)).resolves.toBe(false);
    expect(contents.copy).not.toHaveBeenCalled();

    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const freshRequest = sentRequest(contents);
    const freshCopy = actionItem(freshRequest, "copy");
    contents.frame.detached = true;
    await expect(execute(contents, freshRequest, freshCopy)).resolves.toBe(false);
    expect(contents.copy).not.toHaveBeenCalled();
  });

  it("accepts an equivalent Electron wrapper for the same main-frame document", async () => {
    const contents = new FakeWebContents(51);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);
    const equivalentFrame = new FakeWebFrameMain(
      contents.frame.processId,
      contents.frame.frameToken,
    );

    await expect(execute(
      contents,
      request,
      actionItem(request, "copy"),
      equivalentFrame,
    )).resolves.toBe(true);
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it("rejects malformed or payload-bearing action calls without dispatch", async () => {
    const contents = new FakeWebContents(47);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);
    const copy = actionItem(request, "copy");
    const handler = actionHandler();
    const event = invokeEvent(contents);

    await expect(handler(event)).resolves.toBe(false);
    await expect(handler(event, { requestId: request.requestId, actionId: copy.actionId }, "extra"))
      .resolves.toBe(false);
    await expect(handler(event, {
      requestId: request.requestId,
      actionId: copy.actionId,
      text: "renderer-controlled clipboard data",
    })).resolves.toBe(false);
    await expect(handler(event, {
      requestId: request.requestId,
      actionId: copy.actionId,
      url: "https://attacker.invalid",
    })).resolves.toBe(false);
    expect(contents.copy).not.toHaveBeenCalled();

    await expect(execute(contents, request, copy)).resolves.toBe(true);
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it("expires, replaces, and navigation-invalidates outstanding capabilities", async () => {
    const contents = new FakeWebContents(48);
    controller.install(contents as unknown as WebContents);
    const params = contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    });

    emitContextMenu(contents, params);
    const first = sentRequest(contents);
    const firstCopy = actionItem(first, "copy");
    emitContextMenu(contents, params);
    const second = sentRequest(contents);
    await expect(execute(contents, first, firstCopy)).resolves.toBe(false);

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(Date.now() + APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS);
    await expect(execute(contents, second, actionItem(second, "copy"))).resolves.toBe(false);

    now.mockRestore();
    emitContextMenu(contents, params);
    const third = sentRequest(contents);
    contents.emit("did-start-navigation", {
      isMainFrame: true,
      preventDefault: vi.fn(),
      defaultPrevented: false,
    });
    await expect(execute(contents, third, actionItem(third, "copy"))).resolves.toBe(false);

    emitContextMenu(contents, params);
    const fourth = sentRequest(contents);
    contents.destroyed = true;
    contents.emit("destroyed");
    await expect(execute(contents, fourth, actionItem(fourth, "copy"))).resolves.toBe(false);
    expect(contents.copy).not.toHaveBeenCalled();
  });

  it("keeps an acknowledged visible menu valid beyond the acquisition TTL", async () => {
    const contents = new FakeWebContents(56);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);

    await expect(setMenuOpen(contents, request, true)).resolves.toBe(true);
    const afterAcquisitionTtl = Date.now() + APPLICATION_CONTEXT_MENU_CAPABILITY_TTL_MS * 2;
    vi.spyOn(Date, "now").mockReturnValue(afterAcquisitionTtl);

    await expect(execute(contents, request, actionItem(request, "copy"))).resolves.toBe(true);
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith("selected");
  });

  it("bounds an acknowledged visible menu with a generous hard lease", async () => {
    const contents = new FakeWebContents(59);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);

    await expect(setMenuOpen(contents, request, true)).resolves.toBe(true);
    vi.spyOn(Date, "now").mockReturnValue(
      Date.now() + APPLICATION_CONTEXT_MENU_VISIBLE_LEASE_TTL_MS,
    );

    await expect(execute(contents, request, actionItem(request, "copy"))).resolves.toBe(false);
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("revokes an acknowledged menu when the renderer reports it closed", async () => {
    const contents = new FakeWebContents(57);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);

    await expect(setMenuOpen(contents, request, true)).resolves.toBe(true);
    await expect(setMenuOpen(contents, request, false)).resolves.toBe(true);
    await expect(execute(contents, request, actionItem(request, "copy"))).resolves.toBe(false);
    await expect(setMenuOpen(contents, request, false)).resolves.toBe(false);
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("rejects malformed visibility acknowledgements and revokes on a wrong frame", async () => {
    const contents = new FakeWebContents(58);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);
    const handler = visibilityHandler();
    const event = invokeEvent(contents);

    await expect(handler(event)).resolves.toBe(false);
    await expect(handler(event, { requestId: request.requestId, open: true }, "extra"))
      .resolves.toBe(false);
    await expect(handler(event, {
      requestId: request.requestId,
      open: true,
      expiresAt: Number.MAX_SAFE_INTEGER,
    })).resolves.toBe(false);

    // Malformed messages do not disturb the legitimate acquisition window.
    await expect(setMenuOpen(contents, request, true)).resolves.toBe(true);

    const childFrame = new FakeWebFrameMain(contents.frame.processId, "child-frame");
    childFrame.parent = contents.frame;
    await expect(setMenuOpen(contents, request, true, childFrame)).resolves.toBe(false);
    await expect(execute(contents, request, actionItem(request, "copy"))).resolves.toBe(false);
    expect(electronMocks.clipboardWriteText).not.toHaveBeenCalled();
  });

  it("omits unsafe external-open actions while retaining copy-link capability", async () => {
    const contents = new FakeWebContents(49);
    controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({ linkURL: "javascript:alert(1)" }));
    const request = sentRequest(contents);

    expect(actionKinds(request)).not.toContain("open-link");
    const copyLink = actionItem(request, "copy-link");
    await expect(execute(contents, request, copyLink)).resolves.toBe(true);
    expect(electronMocks.clipboardWriteText).toHaveBeenCalledExactlyOnceWith(
      "javascript:alert(1)",
    );
    expect(electronMocks.openExternal).not.toHaveBeenCalled();
  });

  it("disposes installed listeners, pending capabilities, and the fixed handler", async () => {
    const contents = new FakeWebContents(50);
    const disposeContents = controller.install(contents as unknown as WebContents);
    emitContextMenu(contents, contextParams({
      selectionText: "selected",
      editFlags: editFlags({ canCopy: true }),
    }));
    const request = sentRequest(contents);
    const copy = actionItem(request, "copy");

    disposeContents();
    expect(contents.listenerCount("context-menu")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    await expect(execute(contents, request, copy)).resolves.toBe(false);

    controller.dispose();
    controller.dispose();
    expect(electronMocks.removeHandler.mock.calls.map(([channel]) => channel)).toEqual([
      APPLICATION_CONTEXT_MENU_IPC.executeAction,
      APPLICATION_CONTEXT_MENU_IPC.setOpen,
    ]);
    expect(electronMocks.removeListener).toHaveBeenCalledExactlyOnceWith(
      APPLICATION_CONTEXT_MENU_IPC.restrictedTarget,
      expect.any(Function),
    );
    expect(electronMocks.handlers.has(APPLICATION_CONTEXT_MENU_IPC.executeAction)).toBe(false);
    expect(electronMocks.handlers.has(APPLICATION_CONTEXT_MENU_IPC.setOpen)).toBe(false);
    expect(electronMocks.listeners.has(APPLICATION_CONTEXT_MENU_IPC.restrictedTarget)).toBe(false);
  });
});

function contextMenuEvent() {
  return { preventDefault: vi.fn(), defaultPrevented: false };
}

function emitContextMenu(contents: FakeWebContents, params: ContextMenuParams): void {
  contents.emit("context-menu", contextMenuEvent(), params);
}

function sentRequest(contents: FakeWebContents): ApplicationContextMenuRequest {
  const matchingCalls = contents.send.mock.calls.filter(
    ([channel]) => channel === APPLICATION_CONTEXT_MENU_IPC.menuRequested,
  );
  const raw = matchingCalls.at(-1)?.[1];
  if (raw === undefined) throw new Error("No application context menu request was sent");
  return parseApplicationContextMenuRequest(raw);
}

function actionKinds(request: ApplicationContextMenuRequest): string[] {
  return request.items.flatMap((item) => item.type === "action" ? [item.kind] : []);
}

function actionItem(
  request: ApplicationContextMenuRequest,
  kind: ApplicationContextMenuActionItem["kind"],
): ApplicationContextMenuActionItem {
  const item = request.items.find(
    (candidate): candidate is ApplicationContextMenuActionItem => (
      candidate.type === "action" && candidate.kind === kind
    ),
  );
  if (!item) throw new Error(`Missing ${kind} context menu item`);
  return item;
}

function actionHandler(): (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<boolean> {
  const handler = electronMocks.handlers.get(APPLICATION_CONTEXT_MENU_IPC.executeAction);
  if (!handler) throw new Error("Missing application context menu action handler");
  return async (event, ...args) => Boolean(await handler(event, ...args));
}

function visibilityHandler(): (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => Promise<boolean> {
  const handler = electronMocks.handlers.get(APPLICATION_CONTEXT_MENU_IPC.setOpen);
  if (!handler) throw new Error("Missing application context menu visibility handler");
  return async (event, ...args) => Boolean(await handler(event, ...args));
}

function restrictedTargetListener(): (
  event: IpcMainEvent,
  ...args: unknown[]
) => unknown {
  const listener = electronMocks.listeners.get(APPLICATION_CONTEXT_MENU_IPC.restrictedTarget);
  if (!listener) throw new Error("Missing application context menu restricted-target listener");
  return listener;
}

function invokeEvent(
  contents: FakeWebContents,
  frame: FakeWebFrameMain | null = contents.frame,
): IpcMainInvokeEvent {
  return {
    sender: contents as unknown as WebContents,
    senderFrame: frame as unknown as WebFrameMain | null,
  } as IpcMainInvokeEvent;
}

async function execute(
  contents: FakeWebContents,
  request: ApplicationContextMenuRequest,
  item: ApplicationContextMenuActionItem,
  frame: FakeWebFrameMain | null = contents.frame,
): Promise<boolean> {
  return actionHandler()(invokeEvent(contents, frame), {
    requestId: request.requestId,
    actionId: item.actionId,
  });
}

async function setMenuOpen(
  contents: FakeWebContents,
  request: ApplicationContextMenuRequest,
  open: boolean,
  frame: FakeWebFrameMain | null = contents.frame,
): Promise<boolean> {
  return visibilityHandler()(invokeEvent(contents, frame), {
    requestId: request.requestId,
    open,
  });
}

function signalRestrictedTarget(
  contents: FakeWebContents,
  frame: FakeWebFrameMain | null = contents.frame,
  ...args: unknown[]
): void {
  restrictedTargetListener()(
    invokeEvent(contents, frame) as unknown as IpcMainEvent,
    ...args,
  );
}

function contextParams(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    x: 0,
    y: 0,
    frame: null,
    linkURL: "",
    linkText: "",
    pageURL: "file:///renderer/index.html",
    frameURL: "file:///renderer/index.html",
    srcURL: "",
    mediaType: "none",
    hasImageContents: false,
    isEditable: false,
    selectionText: "",
    titleText: "",
    altText: "",
    suggestedFilename: "",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    referrerPolicy: { policy: "default", url: "" },
    misspelledWord: "",
    dictionarySuggestions: [],
    frameCharset: "UTF-8",
    formControlType: "input-text",
    spellcheckEnabled: false,
    menuSourceType: "mouse",
    mediaFlags: {
      inError: false,
      isPaused: false,
      isMuted: false,
      hasAudio: false,
      isLooping: false,
      isControlsVisible: false,
      canToggleControls: false,
      canPrint: false,
      canSave: false,
      canShowPictureInPicture: false,
      isShowingPictureInPicture: false,
      canRotate: false,
      canLoop: false,
    },
    editFlags: editFlags(),
    ...overrides,
  };
}

function editFlags(
  overrides: Partial<ContextMenuParams["editFlags"]> = {},
): ContextMenuParams["editFlags"] {
  return {
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: false,
    canDelete: false,
    canSelectAll: false,
    canEditRichly: false,
    ...overrides,
  };
}
