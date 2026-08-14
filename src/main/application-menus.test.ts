// @vitest-environment node

import type { ContextMenuParams, MenuItem, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  buildApplicationMenuTemplate,
  buildContextMenuTemplate,
  isSafeExternalWebUrl,
  type ContextMenuActions,
} from "./application-menus.js";

describe("application menu templates", () => {
  it("keeps explicit Edit, View, and Help menus with the expected platform actions", () => {
    const actions = {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease: vi.fn(),
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
    });

    expect(template.map((item) => item.label)).toEqual(["File", "Edit", "View", "Window", "Help"]);
    expect(menuRoles(template, "File")).toContain("quit");
    expect(menuRoles(template, "Window")).toContain("close");
    const about = menuItems(template, "Help").find((item) => item.label === "About Sliver GUI");
    clickItem(about);
    expect(showAboutPanel).toHaveBeenCalledOnce();
  });

  it("builds server and console-client submenus from every latest-release target", () => {
    const downloadRelease = vi.fn();
    const template = buildApplicationMenuTemplate("darwin", "Sliver GUI", {
      newWindow: vi.fn(),
      duplicateConnectedWindow: vi.fn(),
      openDocumentation: vi.fn(),
      showAboutPanel: vi.fn(),
      downloadRelease,
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
