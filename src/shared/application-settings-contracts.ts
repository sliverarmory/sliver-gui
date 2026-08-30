export const APPLICATION_SETTINGS_VERSION = 1 as const;

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
export type ConsoleTerminalFontId = (typeof CONSOLE_TERMINAL_FONTS)[number]["id"];
export type ConsoleTerminalCursorStyle = "block" | "underline" | "bar";

export interface ApplicationTerminalSettings {
  readonly fontId: ConsoleTerminalFontId;
  readonly fontSize: number;
  readonly cursorStyle: ConsoleTerminalCursorStyle;
  readonly cursorBlink: boolean;
  readonly smoothScrolling: boolean;
}

export interface ApplicationSettingsValues {
  readonly theme: ApplicationTheme;
  readonly reduceMotion: boolean;
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
  reduceMotion: false,
  terminal: DEFAULT_APPLICATION_TERMINAL_SETTINGS,
});

export const DEFAULT_APPLICATION_SETTINGS_STATE: ApplicationSettingsState = Object.freeze({
  v: APPLICATION_SETTINGS_VERSION,
  revision: 0,
  ...DEFAULT_APPLICATION_SETTINGS_VALUES,
});

const APPLICATION_THEMES = new Set<ApplicationTheme>(["system", "light", "dark"]);
const CURSOR_STYLES = new Set<ConsoleTerminalCursorStyle>(["block", "underline", "bar"]);
const FONT_IDS = new Set<ConsoleTerminalFontId>(CONSOLE_TERMINAL_FONTS.map(({ id }) => id));
const TERMINAL_KEYS = [
  "fontId",
  "fontSize",
  "cursorStyle",
  "cursorBlink",
  "smoothScrolling",
] as const;
const SETTINGS_VALUE_KEYS = ["theme", "reduceMotion", "terminal"] as const;
const SETTINGS_STATE_KEYS = ["v", "revision", ...SETTINGS_VALUE_KEYS] as const;
const UPDATE_INPUT_KEYS = ["expectedRevision", "settings"] as const;

export function isApplicationTheme(value: unknown): value is ApplicationTheme {
  return typeof value === "string" && APPLICATION_THEMES.has(value as ApplicationTheme);
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
  if (!isApplicationTheme(value["theme"]) || typeof value["reduceMotion"] !== "boolean") {
    throw new TypeError("Invalid application settings");
  }
  let terminal: ApplicationTerminalSettings;
  try {
    terminal = parseApplicationTerminalSettings(value["terminal"]);
  } catch {
    throw new TypeError("Invalid application settings");
  }
  return Object.freeze({
    theme: value["theme"],
    reduceMotion: value["reduceMotion"],
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
      reduceMotion: value["reduceMotion"],
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
