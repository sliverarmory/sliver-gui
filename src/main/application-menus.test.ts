// @vitest-environment node

import type { ContextMenuParams, MenuItem, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildApplicationMenuTemplate,
  buildContextMenuTemplate,
  commandPaletteShortcutDispositionForInput,
  consoleTabShortcutIndexForInput,
  isConsoleNewTabShortcutInput,
  isSafeExternalWebUrl,
  serverRefreshShortcutDispositionForInput,
  type ContextMenuActions,
} from "./application-menus.js";

const shortcutInput = (overrides: Partial<Parameters<typeof consoleTabShortcutIndexForInput>[1]> = {}) => ({
  type: "keyDown",
  key: "1",
  code: "Digit1",
  isComposing: false,
  isAutoRepeat: false,
  shift: false,
  control: false,
  alt: false,
  meta: true,
  ...overrides,
});

describe("console tab shortcut input", () => {
  it("maps the macOS Command digits to positions one through ten", () => {
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput())).toBe(0);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "9", code: "Digit9" }))).toBe(8);
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "0", code: "Digit0" }))).toBe(9);
  });

  it("uses Control off macOS and rejects modified or non-keydown terminal input", () => {
    const controlOne = shortcutInput({ meta: false, control: true });
    expect(consoleTabShortcutIndexForInput("win32", controlOne)).toBe(0);
    expect(consoleTabShortcutIndexForInput("linux", controlOne)).toBe(0);
    expect(consoleTabShortcutIndexForInput("darwin", controlOne)).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("win32", shortcutInput())).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ control: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ shift: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ alt: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ type: "keyUp" }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ isComposing: true }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ key: "a", code: "KeyA" }))).toBeUndefined();
    expect(consoleTabShortcutIndexForInput("darwin", shortcutInput({ code: "Numpad1" }))).toBeUndefined();
  });

  it("recognizes the exact platform new-tab chord", () => {
    const commandT = shortcutInput({ key: "t", code: "KeyT" });
    const controlT = shortcutInput({ key: "t", code: "KeyT", meta: false, control: true });
    expect(isConsoleNewTabShortcutInput("darwin", commandT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("win32", controlT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("linux", controlT)).toBe(true);
    expect(isConsoleNewTabShortcutInput("darwin", controlT)).toBe(false);
    expect(isConsoleNewTabShortcutInput("win32", commandT)).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", control: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", shift: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", alt: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", type: "keyUp" }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyT", isComposing: true }))).toBe(false);
    expect(isConsoleNewTabShortcutInput("darwin", shortcutInput({ code: "KeyR" }))).toBe(false);
  });
});

describe("command palette shortcut input", () => {
  it("matches the exact configured platform chord", () => {
    const commandShiftP = shortcutInput({ key: "P", code: "KeyP", shift: true });
    const controlShiftP = shortcutInput({
      key: "P",
      code: "KeyP",
      shift: true,
      meta: false,
      control: true,
    });
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+shift+p", commandShiftP))
      .toBe("request");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+shift+p", controlShiftP))
      .toBe("request");
    expect(commandPaletteShortcutDispositionForInput("win32", "mod+shift+p", commandShiftP))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+shift+p", controlShiftP))
      .toBeUndefined();
  });

  it("rejects near matches and consumes auto-repeat without another request", () => {
    const controlAltP = shortcutInput({ key: "p", code: "KeyP", meta: false, control: true, alt: true });
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", controlAltP)).toBe("request");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", {
      ...controlAltP,
      isAutoRepeat: true,
    })).toBe("suppress");
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, key: "o" }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, shift: true }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, type: "keyUp" }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+alt+p", { ...controlAltP, isComposing: true }))
      .toBeUndefined();
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+n", controlAltP)).toBeUndefined();
  });

  it("matches shifted digits and macOS Option characters by their physical key code", () => {
    expect(commandPaletteShortcutDispositionForInput("linux", "mod+shift+1", shortcutInput({
      code: "Digit1",
      control: true,
      key: "!",
      meta: false,
      shift: true,
    }))).toBe("request");
    expect(commandPaletteShortcutDispositionForInput("darwin", "mod+alt+k", shortcutInput({
      alt: true,
      code: "KeyK",
      key: "˚",
    }))).toBe("request");
  });
});

describe("server refresh shortcut input", () => {
  it("accepts only an exact unmodified F5 keydown", () => {
    const f5 = shortcutInput({ key: "F5", code: "F5", meta: false });
    expect(serverRefreshShortcutDispositionForInput(f5)).toBe("refresh");
    expect(serverRefreshShortcutDispositionForInput({ ...f5, type: "keyUp" })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, code: "KeyR" })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, isComposing: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, shift: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, control: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, alt: true })).toBeUndefined();
    expect(serverRefreshShortcutDispositionForInput({ ...f5, meta: true })).toBeUndefined();
  });

  it("suppresses F5 auto-repeat without scheduling another refresh", () => {
    expect(serverRefreshShortcutDispositionForInput(shortcutInput({
      key: "F5",
      code: "F5",
      meta: false,
      isAutoRepeat: true,
    }))).toBe("suppress");
  });
});

describe("application menu templates", () => {
  it("keeps explicit Edit, View, and Help menus with the expected platform actions", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", actions);

    expect(template.map((item) => item.label)).toEqual([
      "Sliver GUI",
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    expect(menuItems(template, "Sliver GUI")[0]).toMatchObject({
      label: "About Sliver GUI",
      role: "about",
    });
    expect(menuRoles(template, "Edit")).toEqual([
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
    ]);
    expect(menuRoles(template, "View")).toEqual([
      "reload",
      "forceReload",
      "resetZoom",
      "zoomIn",
      "zoomOut",
      "togglefullscreen",
      "toggleDevTools",
    ]);
    clickItem(menuItems(template, "Help")[0]);
    expect(actions.openDocumentation).toHaveBeenCalledOnce();
  });

  it("uses the conventional non-macOS close and quit placements", () => {
    const showAboutPanel = vi.fn();
    const template = buildApplicationMenuTemplate("win32", "Sliver GUI", {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel,
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    });

    expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(menuRoles(template, "File")).toContain("quit");
    expect(menuRoles(template, "Window")).toContain("close");
    const about = menuItems(template, "Help").find((item) => item.label === "About Sliver GUI");
    clickItem(about);
    expect(showAboutPanel).toHaveBeenCalledOnce();
  });

  it("adds terminal commands only for a focused console without colliding with close-window", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const consoleActions = {
      newTab: vi.fn(),
      closeTab: vi.fn(),
      selectTab: vi.fn(),
      closeWindow: vi.fn(),
      showSettings: vi.fn(),
    };
    const macTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      consoleActions,
    );

    expect(macTemplate.map((item) => item.label)).toEqual([
      "Sliver GUI",
      "File",
      "Edit",
      "View",
      "Terminal",
      "Window",
      "Help",
    ]);
    const terminal = menuItems(macTemplate, "Terminal");
    expect(terminal.slice(0, 3)).toEqual([
      expect.objectContaining({ id: "console.new-tab", label: "New Tab", accelerator: "CmdOrCtrl+T" }),
      expect.objectContaining({ id: "console.close-tab", label: "Close Tab", accelerator: "CmdOrCtrl+W" }),
      expect.objectContaining({ type: "separator" }),
    ]);
    expect(terminal.slice(3, 13).map(({ id, label, accelerator }) => ({ id, label, accelerator }))).toEqual([
      { id: "console.select-tab-1", label: "Select Tab 1", accelerator: "CmdOrCtrl+1" },
      { id: "console.select-tab-2", label: "Select Tab 2", accelerator: "CmdOrCtrl+2" },
      { id: "console.select-tab-3", label: "Select Tab 3", accelerator: "CmdOrCtrl+3" },
      { id: "console.select-tab-4", label: "Select Tab 4", accelerator: "CmdOrCtrl+4" },
      { id: "console.select-tab-5", label: "Select Tab 5", accelerator: "CmdOrCtrl+5" },
      { id: "console.select-tab-6", label: "Select Tab 6", accelerator: "CmdOrCtrl+6" },
      { id: "console.select-tab-7", label: "Select Tab 7", accelerator: "CmdOrCtrl+7" },
      { id: "console.select-tab-8", label: "Select Tab 8", accelerator: "CmdOrCtrl+8" },
      { id: "console.select-tab-9", label: "Select Tab 9", accelerator: "CmdOrCtrl+9" },
      { id: "console.select-tab-0", label: "Select Tab 10", accelerator: "CmdOrCtrl+0" },
    ]);
    expect(terminal.slice(13)).toEqual([
      expect.objectContaining({ type: "separator" }),
      expect.objectContaining({
        id: "console.settings",
        label: "Terminal Settings…",
        accelerator: "CmdOrCtrl+,",
      }),
    ]);
    clickItem(terminal[0]);
    clickItem(terminal[1]);
    clickItem(terminal[3]);
    clickItem(terminal[12]);
    clickItem(terminal[14]);
    expect(consoleActions.newTab).toHaveBeenCalledOnce();
    expect(consoleActions.closeTab).toHaveBeenCalledOnce();
    expect(consoleActions.selectTab.mock.calls).toEqual([[0], [9]]);
    expect(consoleActions.showSettings).toHaveBeenCalledOnce();

    const macCloseWindow = menuItems(macTemplate, "File").at(-1);
    expect(macCloseWindow).toMatchObject({
      label: "Close Window",
      accelerator: "CmdOrCtrl+Shift+W",
    });
    clickItem(macCloseWindow);
    expect(consoleActions.closeWindow).toHaveBeenCalledOnce();

    const windowsTemplate = buildApplicationMenuTemplate(
      "win32",
      "Sliver GUI",
      actions,
      { status: "loading" },
      undefined,
      consoleActions,
    );
    expect(menuItems(windowsTemplate, "File").at(-1)).toMatchObject({ role: "quit" });
    expect(menuItems(windowsTemplate, "Window").at(-1)).toMatchObject({
      label: "Close Window",
      accelerator: "CmdOrCtrl+Shift+W",
    });
  });

  it("builds server and console-client submenus from every latest-release target", () => {
    const downloadRelease = vi.fn();
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease,
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    }, {
      status: "ready",
      version: "v1.7.3",
      targets: [
        { artifact: "server", os: "darwin", arch: "amd64" },
        { artifact: "server", os: "darwin", arch: "arm64" },
        { artifact: "server", os: "linux", arch: "amd64" },
        { artifact: "client", os: "macos", arch: "arm64" },
        { artifact: "client", os: "windows", arch: "386" },
      ],
    });
    const help = menuItems(template, "Help");
    expect(help.map((item) => item.label).filter(Boolean)).toEqual([
      "Sliver Documentation",
      "Download Server",
      "Download Console Client",
    ]);

    const server = nestedMenuItems(help, "Download Server");
    expect(server[0]?.label).toBe("Latest release: v1.7.3");
    expect(server.filter((item) => item.submenu).map((item) => item.label)).toEqual(["macOS", "Linux"]);
    const macosServer = nestedMenuItems(server, "macOS");
    expect(macosServer.map((item) => item.label)).toEqual(["x86_64 (amd64)", "arm64"]);
    clickItem(macosServer[1]);
    expect(downloadRelease).toHaveBeenCalledExactlyOnceWith({ artifact: "server", os: "darwin", arch: "arm64" });

    const client = nestedMenuItems(help, "Download Console Client");
    expect(client.filter((item) => item.submenu).map((item) => item.label)).toEqual(["macOS", "Windows"]);
    expect(nestedMenuItems(client, "Windows").map((item) => item.label)).toEqual(["x86 (386)"]);
  });

  it("shows non-actionable release status while the live catalog is loading or unavailable", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates: vi.fn(),
      restartToApplyApplicationUpdate: vi.fn(),
    };
    const loading = menuItems(buildApplicationMenuTemplate("linux", "Sliver GUI", actions), "Help");
    expect(nestedMenuItems(loading, "Download Server")).toEqual([
      expect.objectContaining({ label: "Checking latest release…", enabled: false }),
    ]);
    const unavailable = menuItems(buildApplicationMenuTemplate(
      "linux",
      "Sliver GUI",
      actions,
      { status: "unavailable" },
    ), "Help");
    expect(nestedMenuItems(unavailable, "Download Console Client")).toEqual([
      expect.objectContaining({ label: "Latest release unavailable", enabled: false }),
    ]);
  });

  it("places update checks conventionally and exposes restart only when an update is ready", () => {
    const checkForApplicationUpdates = vi.fn();
    const restartToApplyApplicationUpdate = vi.fn();
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
      checkForApplicationUpdates,
      restartToApplyApplicationUpdate,
    };
    const disabledTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      {
        status: "disabled",
        revision: 0,
        currentVersion: "1.2.3",
        disabledReason: "Automatic updates are available in packaged builds.",
      },
    );
    const disabledCheck = menuItems(disabledTemplate, "Sliver GUI")
      .find((item) => item.label === "Check for Updates…");
    expect(disabledCheck?.enabled).not.toBe(false);
    clickItem(disabledCheck);
    expect(checkForApplicationUpdates).toHaveBeenCalledOnce();
    checkForApplicationUpdates.mockClear();

    const macTemplate = buildApplicationMenuTemplate(
      "darwin",
      "Sliver GUI",
      actions,
      { status: "loading" },
      { status: "idle", revision: 0, currentVersion: "1.2.3" },
    );
    clickItem(menuItems(macTemplate, "Sliver GUI").find((item) => item.label === "Check for Updates…"));
    expect(checkForApplicationUpdates).toHaveBeenCalledOnce();

    const linuxTemplate = buildApplicationMenuTemplate(
      "linux",
      "Sliver GUI",
      actions,
      { status: "loading" },
      { status: "ready", revision: 3, currentVersion: "1.2.3", availableVersion: "1.3.0" },
    );
    clickItem(menuItems(linuxTemplate, "Help").find((item) => item.label === "Restart to Update to 1.3.0…"));
    expect(restartToApplyApplicationUpdate).toHaveBeenCalledOnce();

    const downloadingTemplate = buildApplicationMenuTemplate(
      "win32",
      "Sliver GUI",
      actions,
      { status: "loading" },
      {
        status: "downloading",
        revision: 2,
        currentVersion: "1.2.3",
        availableVersion: "1.3.0",
        progressPercent: 42.4,
      },
    );
    expect(menuItems(downloadingTemplate, "Help")[0]).toMatchObject({
      label: "Downloading Update 1.3.0… 42%",
      enabled: false,
    });
  });
});

describe("context menu templates", () => {
  it("offers enabled editing actions, spelling suggestions, and inspection", () => {
    const actions = contextActions();
    const template = buildContextMenuTemplate(contextParams({
      isEditable: true,
      misspelledWord: "teh",
      dictionarySuggestions: ["the", "tech"],
      editFlags: editFlags({
        canUndo: true,
        canCopy: true,
        canPaste: true,
        canSelectAll: true,
      }),
      x: 12,
      y: 34,
    }), actions);

    expect(itemLabels(template)).toEqual([
      "the",
      "tech",
      "undo",
      "redo",
      "cut",
      "copy",
      "paste",
      "pasteAndMatchStyle",
      "delete",
      "selectAll",
      "Inspect Element",
    ]);
    expect(template.find((item) => item.role === "undo")?.enabled).toBe(true);
    expect(template.find((item) => item.role === "redo")?.enabled).toBe(false);
    clickItem(template.find((item) => item.label === "the"));
    clickItem(template.find((item) => item.label === "Inspect Element"));
    expect(actions.replaceMisspelling).toHaveBeenCalledWith("the");
    expect(actions.inspectElement).toHaveBeenCalledWith(12, 34);
  });

  it("adds selection, safe-link, image, and inspect actions contextually", () => {
    const actions = contextActions();
    const template = buildContextMenuTemplate(contextParams({
      selectionText: "selected",
      linkURL: "https://sliver.sh/docs",
      mediaType: "image",
      hasImageContents: true,
      editFlags: editFlags({ canCopy: true, canSelectAll: true }),
      x: 8,
      y: 9,
    }), actions);

    expect(itemLabels(template)).toEqual([
      "copy",
      "selectAll",
      "Open Link in Browser",
      "Copy Link Address",
      "Copy Image",
      "Inspect Element",
    ]);
    clickItem(template.find((item) => item.label === "Open Link in Browser"));
    clickItem(template.find((item) => item.label === "Copy Link Address"));
    clickItem(template.find((item) => item.label === "Copy Image"));
    expect(actions.openExternal).toHaveBeenCalledWith("https://sliver.sh/docs");
    expect(actions.copyText).toHaveBeenCalledWith("https://sliver.sh/docs");
    expect(actions.copyImageAt).toHaveBeenCalledWith(8, 9);
  });

  it("never opens unsafe link schemes but still permits copying their address", () => {
    const actions = contextActions();
    const template = buildContextMenuTemplate(contextParams({ linkURL: "javascript:alert(1)" }), actions);

    expect(itemLabels(template)).toEqual(["selectAll", "Copy Link Address", "Inspect Element"]);
    expect(template).not.toContainEqual(expect.objectContaining({ label: "Open Link in Browser" }));
  });
});

describe("external context-menu URLs", () => {
  it.each([
    ["https://sliver.sh/docs", true],
    ["http://127.0.0.1:8080/", true],
    ["https://user:secret@example.com/", false],
    ["file:///etc/passwd", false],
    ["javascript:alert(1)", false],
    ["not a url", false],
  ])("classifies %s", (value, expected) => {
    expect(isSafeExternalWebUrl(value)).toBe(expected);
  });
});

function menuItems(
  template: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} submenu`);
  return item.submenu;
}

function menuRoles(template: readonly MenuItemConstructorOptions[], label: string): string[] {
  return menuItems(template, label)
    .map((item) => item.role)
    .filter((role): role is NonNullable<typeof role> => role !== undefined);
}

function nestedMenuItems(
  template: readonly MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const item = template.find((candidate) => candidate.label === label);
  if (!item || !Array.isArray(item.submenu)) throw new Error(`Missing ${label} submenu`);
  return item.submenu;
}

function itemLabels(template: readonly MenuItemConstructorOptions[]): string[] {
  return template
    .filter((item) => item.type !== "separator")
    .map((item) => item.label ?? item.role ?? "");
}

function clickItem(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error("Expected a clickable menu item");
  item.click({} as MenuItem, undefined, {} as Electron.KeyboardEvent);
}

function contextActions() {
  return {
    copyImageAt: vi.fn<(x: number, y: number) => void>(),
    copyText: vi.fn<(text: string) => void>(),
    inspectElement: vi.fn<(x: number, y: number) => void>(),
    openExternal: vi.fn<(url: string) => void>(),
    replaceMisspelling: vi.fn<(text: string) => void>(),
  } satisfies ContextMenuActions;
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
    formControlType: "none",
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

function editFlags(overrides: Partial<ContextMenuParams["editFlags"]> = {}): ContextMenuParams["editFlags"] {
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
