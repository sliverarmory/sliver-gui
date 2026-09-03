import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";
import type { ApplicationUpdateState } from "../shared/application-update-contracts.js";
import {
  isCommandPaletteShortcut,
  normalizeCommandPaletteShortcutKey,
} from "../shared/application-settings-contracts.js";
import { CONSOLE_MAX_TABS_PER_WINDOW } from "../shared/console-contracts.js";
import type { SliverReleaseTarget } from "../shared/release-contracts.js";

export type ReleaseMenuCatalog =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | {
      readonly status: "ready";
      readonly version: string;
      readonly targets: readonly SliverReleaseTarget[];
    };

export interface ApplicationMenuActions {
  readonly newWindow: () => void;
  readonly duplicateConnectedWindow: () => void;
  readonly openDocumentation: () => void;
  readonly showAboutPanel: () => void;
  readonly downloadRelease: (target: SliverReleaseTarget) => void;
  readonly checkForApplicationUpdates: () => void;
  readonly restartToApplyApplicationUpdate: () => void;
}

export interface ConsoleApplicationMenuActions {
  readonly newTab: () => void;
  readonly closeTab: () => void;
  readonly selectTab: (index: number) => void;
  readonly closeWindow: () => void;
  readonly showSettings: () => void;
}

export interface ConsoleTabShortcutInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly isComposing: boolean;
  readonly isAutoRepeat: boolean;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
}

export type ServerRefreshShortcutDisposition = "refresh" | "suppress";
export type CommandPaletteShortcutDisposition = "request" | "suppress";

export function commandPaletteShortcutDispositionForInput(
  platform: NodeJS.Platform,
  shortcut: string,
  input: ConsoleTabShortcutInput,
): CommandPaletteShortcutDisposition | undefined {
  if (
    !isCommandPaletteShortcut(shortcut) ||
    input.type !== "keyDown" ||
    input.isComposing
  ) return undefined;

  const tokens = shortcut.split("+");
  const key = tokens.at(-1);
  const modifiers = new Set(tokens.slice(0, -1));
  const primaryPressed = platform === "darwin" ? input.meta : input.control;
  const secondaryPressed = platform === "darwin" ? input.control : input.meta;
  if (
    secondaryPressed ||
    normalizeCommandPaletteShortcutKey(input.key, input.code) !== key ||
    primaryPressed !== modifiers.has("mod") ||
    input.alt !== modifiers.has("alt") ||
    input.shift !== modifiers.has("shift")
  ) return undefined;

  return input.isAutoRepeat ? "suppress" : "request";
}

export function serverRefreshShortcutDispositionForInput(
  input: ConsoleTabShortcutInput,
): ServerRefreshShortcutDisposition | undefined {
  if (
    input.type !== "keyDown" ||
    input.code !== "F5" ||
    input.isComposing ||
    input.shift ||
    input.control ||
    input.alt ||
    input.meta
  ) return undefined;
  return input.isAutoRepeat ? "suppress" : "refresh";
}

export interface ContextMenuActions {
  readonly copyImageAt: (x: number, y: number) => void;
  readonly copyText: (text: string) => void;
  readonly inspectElement: (x: number, y: number) => void;
  readonly openExternal: (url: string) => void;
  readonly replaceMisspelling: (text: string) => void;
}

export function consoleTabShortcutIndexForInput(
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
): number | undefined {
  if (!isConsolePrimaryShortcutInput(platform, input)) return undefined;

  const codeMatch = /^Digit([0-9])$/u.exec(input.code);
  if (!codeMatch?.[1]) return undefined;
  const digit = Number(codeMatch[1]);
  return digit === 0 ? CONSOLE_MAX_TABS_PER_WINDOW - 1 : digit - 1;
}

export function isConsoleNewTabShortcutInput(
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
): boolean {
  return isConsolePrimaryShortcutInput(platform, input) && input.code === "KeyT";
}

function isConsolePrimaryShortcutInput(
  platform: NodeJS.Platform,
  input: ConsoleTabShortcutInput,
): boolean {
  if (
    input.type !== "keyDown" ||
    input.isComposing ||
    input.shift ||
    input.alt
  ) return false;
  return platform === "darwin"
    ? input.meta && !input.control
    : input.control && !input.meta;
}

export function buildApplicationMenuTemplate(
  platform: NodeJS.Platform,
  applicationName: string,
  actions: ApplicationMenuActions,
  releaseCatalog: ReleaseMenuCatalog = { status: "loading" },
  applicationUpdateState?: ApplicationUpdateState,
  consoleActions?: ConsoleApplicationMenuActions,
): MenuItemConstructorOptions[] {
  const updateItems = applicationUpdateState
    ? buildApplicationUpdateMenuItems(applicationUpdateState, actions)
    : [];
  return [
    ...(platform === "darwin"
      ? [
          {
            label: applicationName,
            submenu: [
              { label: `About ${applicationName}`, role: "about" as const },
              ...updateItems,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: actions.newWindow,
        },
        {
          label: "Duplicate Connected Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: actions.duplicateConnectedWindow,
        },
        { type: "separator" },
        platform === "darwin"
          ? consoleActions
            ? {
                label: "Close Window",
                accelerator: "CmdOrCtrl+Shift+W",
                click: consoleActions.closeWindow,
              }
            : { role: "close" }
          : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    ...(consoleActions
      ? [{
          label: "Terminal",
          submenu: [
            {
              id: "console.new-tab",
              label: "New Tab",
              accelerator: "CmdOrCtrl+T",
              click: consoleActions.newTab,
            },
            {
              id: "console.close-tab",
              label: "Close Tab",
              accelerator: "CmdOrCtrl+W",
              click: consoleActions.closeTab,
            },
            { type: "separator" as const },
            ...Array.from({ length: CONSOLE_MAX_TABS_PER_WINDOW }, (_, index): MenuItemConstructorOptions => {
              const digit = index === 9 ? 0 : index + 1;
              return {
                id: `console.select-tab-${digit}`,
                label: `Select Tab ${index + 1}`,
                accelerator: `CmdOrCtrl+${digit}`,
                click: () => consoleActions.selectTab(index),
              };
            }),
            { type: "separator" as const },
            {
              id: "console.settings",
              label: "Terminal Settings…",
              accelerator: "CmdOrCtrl+,",
              click: consoleActions.showSettings,
            },
          ],
        }]
      : []),
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        ...(platform === "darwin" ? [{ role: "zoom" as const }] : []),
        { type: "separator" },
        ...(platform === "darwin"
          ? [{ role: "front" as const }]
          : consoleActions
            ? [{
                label: "Close Window",
                accelerator: "CmdOrCtrl+Shift+W",
                click: consoleActions.closeWindow,
              }]
            : [{ role: "close" as const }]),
      ],
    },
    {
      label: "Help",
      role: "help",
      submenu: [
        ...(platform === "darwin" ? [] : updateItems),
        ...(platform !== "darwin" && updateItems.length > 0
          ? [{ type: "separator" as const }]
          : []),
        {
          label: "Sliver Documentation",
          click: actions.openDocumentation,
        },
        { type: "separator" },
        {
          label: "Download Server",
          submenu: buildReleaseDownloadSubmenu("server", releaseCatalog, actions.downloadRelease),
        },
        {
          label: "Download Console Client",
          submenu: buildReleaseDownloadSubmenu("client", releaseCatalog, actions.downloadRelease),
        },
        ...(platform === "darwin"
          ? []
          : [
              { type: "separator" as const },
              {
                label: `About ${applicationName}`,
                click: actions.showAboutPanel,
              },
            ]),
      ],
    },
  ];
}

function buildApplicationUpdateMenuItems(
  state: ApplicationUpdateState,
  actions: ApplicationMenuActions,
): MenuItemConstructorOptions[] {
  switch (state.status) {
    case "disabled":
      return [{
        label: "Check for Updates…",
        click: actions.checkForApplicationUpdates,
      }];
    case "checking":
      return [{ label: "Checking for Updates…", enabled: false }];
    case "available":
      return [{ label: `Downloading Update ${state.availableVersion}…`, enabled: false }];
    case "downloading":
      return [{
        label: `Downloading Update ${state.availableVersion}… ${Math.round(state.progressPercent)}%`,
        enabled: false,
      }];
    case "ready":
      return [{
        label: `Restart to Update to ${state.availableVersion}…`,
        click: actions.restartToApplyApplicationUpdate,
      }];
    case "idle":
    case "up-to-date":
    case "error":
      return [{
        label: "Check for Updates…",
        click: actions.checkForApplicationUpdates,
      }];
  }
}

function buildReleaseDownloadSubmenu(
  artifact: SliverReleaseTarget["artifact"],
  catalog: ReleaseMenuCatalog,
  onDownload: (target: SliverReleaseTarget) => void,
): MenuItemConstructorOptions[] {
  if (catalog.status === "loading") return [{ label: "Checking latest release…", enabled: false }];
  if (catalog.status === "unavailable") return [{ label: "Latest release unavailable", enabled: false }];
  const targets = catalog.targets.filter((target) => target.artifact === artifact);
  if (targets.length === 0) return [{ label: "No binaries in latest release", enabled: false }];
  const byOperatingSystem = new Map<string, SliverReleaseTarget[]>();
  for (const target of targets) {
    const existing = byOperatingSystem.get(target.os) ?? [];
    existing.push(target);
    byOperatingSystem.set(target.os, existing);
  }
  return [
    { label: `Latest release: ${catalog.version}`, enabled: false },
    { type: "separator" },
    ...[...byOperatingSystem.entries()]
      .sort(([left], [right]) => operatingSystemOrder(left) - operatingSystemOrder(right) || left.localeCompare(right))
      .map(([os, osTargets]) => ({
        label: operatingSystemLabel(os),
        submenu: osTargets
          .sort((left, right) => architectureOrder(left.arch) - architectureOrder(right.arch) || left.arch.localeCompare(right.arch))
          .map((target) => ({
            label: architectureLabel(target.arch),
            click: () => onDownload(target),
          })),
      })),
  ];
}

function operatingSystemLabel(value: string): string {
  if (value === "darwin" || value === "macos") return "macOS";
  if (value === "linux") return "Linux";
  if (value === "windows") return "Windows";
  if (value === "freebsd") return "FreeBSD";
  return value;
}

function operatingSystemOrder(value: string): number {
  return ["darwin", "macos", "linux", "windows", "freebsd"].indexOf(value) + 1 || 100;
}

function architectureLabel(value: string): string {
  if (value === "amd64") return "x86_64 (amd64)";
  if (value === "386") return "x86 (386)";
  return value;
}

function architectureOrder(value: string): number {
  return ["amd64", "arm64", "386"].indexOf(value) + 1 || 100;
}

export function buildContextMenuTemplate(
  params: ContextMenuParams,
  actions: ContextMenuActions,
): MenuItemConstructorOptions[] {
  const groups: MenuItemConstructorOptions[][] = [];

  if (params.isEditable && params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, 5);
    groups.push(suggestions.length > 0
      ? suggestions.map((suggestion) => ({
          label: suggestion,
          click: () => actions.replaceMisspelling(suggestion),
        }))
      : [{ label: "No Spelling Suggestions", enabled: false }]);
  }

  if (params.isEditable) {
    groups.push([
      { role: "undo", enabled: params.editFlags.canUndo },
      { role: "redo", enabled: params.editFlags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
      { role: "delete", enabled: params.editFlags.canDelete },
      { type: "separator" },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
  } else if (params.selectionText.length > 0) {
    groups.push([
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    ]);
  } else {
    groups.push([{ role: "selectAll", enabled: params.editFlags.canSelectAll }]);
  }

  if (params.linkURL) {
    groups.push([
      ...(isSafeExternalWebUrl(params.linkURL)
        ? [{ label: "Open Link in Browser", click: () => actions.openExternal(params.linkURL) }]
        : []),
      { label: "Copy Link Address", click: () => actions.copyText(params.linkURL) },
    ]);
  }

  if (params.mediaType === "image" && params.hasImageContents) {
    groups.push([{
      label: "Copy Image",
      click: () => actions.copyImageAt(params.x, params.y),
    }]);
  }

  groups.push([{
    label: "Inspect Element",
    click: () => actions.inspectElement(params.x, params.y),
  }]);

  return joinMenuGroups(groups);
}

export function isSafeExternalWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

function joinMenuGroups(groups: readonly MenuItemConstructorOptions[][]): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    if (template.length > 0) template.push({ type: "separator" });
    template.push(...group);
  }
  return template;
}
