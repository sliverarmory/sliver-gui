import {
  isKeyboardShortcut,
  parseKeyboardShortcutOverrides,
  type KeyboardShortcutOverrides,
} from "./keyboard-shortcuts.js";

export const APPLICATION_SETTINGS_VERSION = 5 as const;
const KEYBOARD_SHORTCUTS_APPLICATION_SETTINGS_VERSION = 4 as const;
const PREVIOUS_APPLICATION_SETTINGS_VERSION = 3 as const;
const COMMAND_PALETTE_APPLICATION_SETTINGS_VERSION = 2 as const;
const LEGACY_APPLICATION_SETTINGS_VERSION = 1 as const;

export const CONSOLE_TERMINAL_FONT_SIZE_MIN = 8;
export const CONSOLE_TERMINAL_FONT_SIZE_MAX = 32;
export const CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS = 100;

export const CONSOLE_TERMINAL_FONTS = [
  { id: "fira-code", label: "Fira Code", family: "Fira Code" },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono" },
  { id: "cascadia-mono", label: "Cascadia Mono", family: "Cascadia Mono" },
  { id: "source-code-pro", label: "Source Code Pro", family: "Source Code Pro" },
] as const;

export type ApplicationTheme = "system" | "light" | "dark";
export type ApplicationIcon = "auto" | "light" | "dark" | "passion";
export type ResolvedApplicationIcon = Exclude<ApplicationIcon, "auto">;
export type ConsoleTerminalFontId = (typeof CONSOLE_TERMINAL_FONTS)[number]["id"];
export type ConsoleTerminalCursorStyle = "block" | "underline" | "bar";

export const DEFAULT_COMMAND_PALETTE_SHORTCUT = "mod+k";

export interface ApplicationTerminalSettings {
  readonly fontId: ConsoleTerminalFontId;
  readonly fontSize: number;
  readonly cursorStyle: ConsoleTerminalCursorStyle;
  readonly cursorBlink: boolean;
  readonly smoothScrolling: boolean;
}

export interface ApplicationSettingsValues {
  readonly theme: ApplicationTheme;
  readonly appIcon: ApplicationIcon;
  readonly reduceMotion: boolean;
  /** null uses the current user's Desktop directory when a report is captured. */
  readonly reportScreenshotDirectory: string | null;
  readonly commandPaletteShortcut: string;
  readonly keyboardShortcuts: KeyboardShortcutOverrides;
  readonly terminal: ApplicationTerminalSettings;
}

export interface ApplicationSettingsState extends ApplicationSettingsValues {
  readonly v: typeof APPLICATION_SETTINGS_VERSION;
  readonly revision: number;
}

export interface ApplicationSettingsUpdateInput {
  readonly expectedRevision: number;
  readonly settings: ApplicationSettingsValues;
}

export const DEFAULT_APPLICATION_TERMINAL_SETTINGS: ApplicationTerminalSettings = Object.freeze({
  fontId: "fira-code",
  fontSize: 13,
  cursorStyle: "block",
  cursorBlink: true,
  smoothScrolling: false,
});

export const DEFAULT_APPLICATION_SETTINGS_VALUES: ApplicationSettingsValues = Object.freeze({
  theme: "system",
  appIcon: "auto",
  reduceMotion: false,
  reportScreenshotDirectory: null,
  commandPaletteShortcut: DEFAULT_COMMAND_PALETTE_SHORTCUT,
  keyboardShortcuts: Object.freeze({}),
  terminal: DEFAULT_APPLICATION_TERMINAL_SETTINGS,
});

export const DEFAULT_APPLICATION_SETTINGS_STATE: ApplicationSettingsState = Object.freeze({
  v: APPLICATION_SETTINGS_VERSION,
  revision: 0,
  ...DEFAULT_APPLICATION_SETTINGS_VALUES,
});

const APPLICATION_THEMES = new Set<ApplicationTheme>(["system", "light", "dark"]);
const APPLICATION_ICONS = new Set<ApplicationIcon>(["auto", "light", "dark", "passion"]);
const CURSOR_STYLES = new Set<ConsoleTerminalCursorStyle>(["block", "underline", "bar"]);
const FONT_IDS = new Set<ConsoleTerminalFontId>(CONSOLE_TERMINAL_FONTS.map(({ id }) => id));
const TERMINAL_KEYS = [
  "fontId",
  "fontSize",
  "cursorStyle",
  "cursorBlink",
  "smoothScrolling",
] as const;
const SETTINGS_VALUE_KEYS = ["theme", "appIcon", "reduceMotion", "reportScreenshotDirectory", "commandPaletteShortcut", "keyboardShortcuts", "terminal"] as const;
const SETTINGS_STATE_KEYS = ["v", "revision", ...SETTINGS_VALUE_KEYS] as const;
const KEYBOARD_SHORTCUTS_SETTINGS_STATE_KEYS = ["v", "revision", "theme", "appIcon", "reduceMotion", "commandPaletteShortcut", "keyboardShortcuts", "terminal"] as const;
const PREVIOUS_SETTINGS_STATE_KEYS = ["v", "revision", "theme", "appIcon", "reduceMotion", "commandPaletteShortcut", "terminal"] as const;
const COMMAND_PALETTE_SETTINGS_STATE_KEYS = ["v", "revision", "theme", "reduceMotion", "commandPaletteShortcut", "terminal"] as const;
const LEGACY_SETTINGS_STATE_KEYS = ["v", "revision", "theme", "reduceMotion", "terminal"] as const;
const UPDATE_INPUT_KEYS = ["expectedRevision", "settings"] as const;
const RESERVED_COMMAND_PALETTE_SHORTCUTS = new Set([
  "alt+f4",
  "mod+0",
  "mod+1",
  "mod+2",
  "mod+3",
  "mod+4",
  "mod+5",
  "mod+6",
  "mod+7",
  "mod+8",
  "mod+9",
  "mod+a",
  "mod+c",
  "mod+h",
  "mod+alt+h",
  "mod+m",
  "mod+n",
  "mod+shift+n",
  "mod+q",
  "mod+r",
  "mod+shift+r",
  "mod+t",
  "mod+v",
  "mod+w",
  "mod+shift+w",
  "mod+x",
  "mod+y",
  "mod+z",
]);

export function isApplicationTheme(value: unknown): value is ApplicationTheme {
  return typeof value === "string" && APPLICATION_THEMES.has(value as ApplicationTheme);
}

export function isApplicationIcon(value: unknown): value is ApplicationIcon {
  return typeof value === "string" && APPLICATION_ICONS.has(value as ApplicationIcon);
}

export function isResolvedApplicationIcon(value: unknown): value is ResolvedApplicationIcon {
  return value !== "auto" && isApplicationIcon(value);
}

export function isReportScreenshotDirectory(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    return false;
  }
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
}

export function isConsoleTerminalFontId(value: unknown): value is ConsoleTerminalFontId {
  return typeof value === "string" && FONT_IDS.has(value as ConsoleTerminalFontId);
}

export function isConsoleTerminalCursorStyle(value: unknown): value is ConsoleTerminalCursorStyle {
  return typeof value === "string" && CURSOR_STYLES.has(value as ConsoleTerminalCursorStyle);
}

export function parseApplicationTerminalSettings(value: unknown): ApplicationTerminalSettings {
  if (!hasExactKeys(value, TERMINAL_KEYS)) throw new TypeError("Invalid terminal settings");
  if (
    !isConsoleTerminalFontId(value["fontId"]) ||
    !Number.isSafeInteger(value["fontSize"]) ||
    (value["fontSize"] as number) < CONSOLE_TERMINAL_FONT_SIZE_MIN ||
    (value["fontSize"] as number) > CONSOLE_TERMINAL_FONT_SIZE_MAX ||
    !isConsoleTerminalCursorStyle(value["cursorStyle"]) ||
    typeof value["cursorBlink"] !== "boolean" ||
    typeof value["smoothScrolling"] !== "boolean"
  ) {
    throw new TypeError("Invalid terminal settings");
  }
  return Object.freeze({
    fontId: value["fontId"],
    fontSize: value["fontSize"] as number,
    cursorStyle: value["cursorStyle"],
    cursorBlink: value["cursorBlink"],
    smoothScrolling: value["smoothScrolling"],
  });
}

export function parseApplicationSettingsValues(value: unknown): ApplicationSettingsValues {
  if (!hasExactKeys(value, SETTINGS_VALUE_KEYS)) {
    throw new TypeError("Invalid application settings");
  }
  if (
    !isApplicationTheme(value["theme"]) ||
    !isApplicationIcon(value["appIcon"]) ||
    typeof value["reduceMotion"] !== "boolean" ||
    !isReportScreenshotDirectory(value["reportScreenshotDirectory"]) ||
    !isKeyboardShortcut(value["commandPaletteShortcut"])
  ) {
    throw new TypeError("Invalid application settings");
  }
  let terminal: ApplicationTerminalSettings;
  let keyboardShortcuts: KeyboardShortcutOverrides;
  try {
    terminal = parseApplicationTerminalSettings(value["terminal"]);
    keyboardShortcuts = parseKeyboardShortcutOverrides(value["keyboardShortcuts"]);
  } catch {
    throw new TypeError("Invalid application settings");
  }
  return Object.freeze({
    theme: value["theme"],
    appIcon: value["appIcon"],
    reduceMotion: value["reduceMotion"],
    reportScreenshotDirectory: value["reportScreenshotDirectory"],
    commandPaletteShortcut: value["commandPaletteShortcut"],
    keyboardShortcuts,
    terminal,
  });
}

export function parseApplicationSettingsState(value: unknown): ApplicationSettingsState {
  if (
    !hasExactKeys(value, SETTINGS_STATE_KEYS) ||
    value["v"] !== APPLICATION_SETTINGS_VERSION ||
    !isRevision(value["revision"])
  ) {
    throw new TypeError("Invalid application settings state");
  }
  let settings: ApplicationSettingsValues;
  try {
    settings = parseApplicationSettingsValues({
      theme: value["theme"],
      appIcon: value["appIcon"],
      reduceMotion: value["reduceMotion"],
      reportScreenshotDirectory: value["reportScreenshotDirectory"],
      commandPaletteShortcut: value["commandPaletteShortcut"],
      keyboardShortcuts: value["keyboardShortcuts"],
      terminal: value["terminal"],
    });
  } catch {
    throw new TypeError("Invalid application settings state");
  }
  return Object.freeze({
    v: APPLICATION_SETTINGS_VERSION,
    revision: value["revision"] as number,
    ...settings,
  });
}

export function parsePersistedApplicationSettingsState(value: unknown): ApplicationSettingsState {
  try {
    return parseApplicationSettingsState(value);
  } catch {
    try {
      if (hasExactKeys(value, KEYBOARD_SHORTCUTS_SETTINGS_STATE_KEYS) && value["v"] === KEYBOARD_SHORTCUTS_APPLICATION_SETTINGS_VERSION) {
        return parseApplicationSettingsState({
          ...value,
          v: APPLICATION_SETTINGS_VERSION,
          reportScreenshotDirectory: null,
        });
      }
      if (hasExactKeys(value, PREVIOUS_SETTINGS_STATE_KEYS) && value["v"] === PREVIOUS_APPLICATION_SETTINGS_VERSION) {
        if (!isCommandPaletteShortcut(value["commandPaletteShortcut"])) throw new TypeError("Invalid previous command palette shortcut");
        return parseApplicationSettingsState({
          ...value,
          v: APPLICATION_SETTINGS_VERSION,
          keyboardShortcuts: {},
          reportScreenshotDirectory: null,
        });
      }
      if (hasExactKeys(value, COMMAND_PALETTE_SETTINGS_STATE_KEYS) && value["v"] === COMMAND_PALETTE_APPLICATION_SETTINGS_VERSION) {
        if (!isCommandPaletteShortcut(value["commandPaletteShortcut"])) throw new TypeError("Invalid previous command palette shortcut");
        return parseApplicationSettingsState({
          ...value,
          v: APPLICATION_SETTINGS_VERSION,
          appIcon: DEFAULT_APPLICATION_SETTINGS_VALUES.appIcon,
          keyboardShortcuts: {},
          reportScreenshotDirectory: null,
        });
      }
      if (hasExactKeys(value, LEGACY_SETTINGS_STATE_KEYS) && value["v"] === LEGACY_APPLICATION_SETTINGS_VERSION) {
        return parseApplicationSettingsState({
          ...value,
          v: APPLICATION_SETTINGS_VERSION,
          appIcon: DEFAULT_APPLICATION_SETTINGS_VALUES.appIcon,
          commandPaletteShortcut: DEFAULT_COMMAND_PALETTE_SHORTCUT,
          keyboardShortcuts: {},
          reportScreenshotDirectory: null,
        });
      }
    } catch {
      throw new TypeError("Invalid persisted application settings state");
    }
    throw new TypeError("Invalid persisted application settings state");
  }
}

export function isCommandPaletteShortcut(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || value !== value.toLowerCase()) return false;
  if (RESERVED_COMMAND_PALETTE_SHORTCUTS.has(value)) return false;
  const tokens = value.split("+");
  if (tokens.length < 2 || tokens.some((token) => token === "" || token.trim() !== token)) return false;

  const key = tokens.at(-1);
  const modifiers = tokens.slice(0, -1);
  if (!key || !isShortcutKey(key)) return false;
  if (!modifiers.includes("mod")) return false;

  const expectedOrder = ["mod", "alt", "shift"];
  return modifiers.length <= expectedOrder.length &&
    modifiers.every((modifier, index) => modifier === expectedOrder.filter((item) => modifiers.includes(item))[index]);
}

export function normalizeCommandPaletteShortcutKey(key: string, code = ""): string | undefined {
  const normalizedKey = key.toLowerCase();
  if (isShortcutKey(normalizedKey)) return normalizedKey;

  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  if (letter) return letter.toLowerCase();
  const digit = /^Digit([0-9])$/u.exec(code)?.[1];
  if (digit) return digit;
  const functionKey = /^F(?:[1-9]|1[0-2])$/u.exec(code)?.[0];
  return functionKey?.toLowerCase();
}

export function parseApplicationSettingsUpdateInput(value: unknown): ApplicationSettingsUpdateInput {
  if (!hasExactKeys(value, UPDATE_INPUT_KEYS) || !isRevision(value["expectedRevision"])) {
    throw new TypeError("Invalid application settings update");
  }
  let settings: ApplicationSettingsValues;
  try {
    settings = parseApplicationSettingsValues(value["settings"]);
  } catch {
    throw new TypeError("Invalid application settings update");
  }
  return Object.freeze({
    expectedRevision: value["expectedRevision"] as number,
    settings,
  });
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isShortcutKey(value: string): boolean {
  return /^[a-z0-9]$/u.test(value) || /^f(?:[1-9]|1[0-2])$/u.test(value);
}

function hasExactKeys<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  if (!isRecord(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
