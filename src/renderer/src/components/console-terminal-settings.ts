export const CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY = "sliver.console-terminal-settings";
export const CONSOLE_TERMINAL_SETTINGS_VERSION = 1 as const;
export const CONSOLE_TERMINAL_FONT_SIZE_MIN = 8;
export const CONSOLE_TERMINAL_FONT_SIZE_MAX = 32;
export const CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS = 100;

export const CONSOLE_TERMINAL_FONTS = [
  { id: "fira-code", label: "Fira Code", family: "Fira Code" },
  { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono" },
  { id: "cascadia-mono", label: "Cascadia Mono", family: "Cascadia Mono" },
  { id: "source-code-pro", label: "Source Code Pro", family: "Source Code Pro" },
] as const;

export type ConsoleTerminalFontId = (typeof CONSOLE_TERMINAL_FONTS)[number]["id"];
export type ConsoleTerminalCursorStyle = "block" | "underline" | "bar";

export interface ConsoleTerminalSettings {
  readonly fontId: ConsoleTerminalFontId;
  readonly fontSize: number;
  readonly cursorStyle: ConsoleTerminalCursorStyle;
  readonly cursorBlink: boolean;
  readonly smoothScrolling: boolean;
}

interface PersistedConsoleTerminalSettings extends ConsoleTerminalSettings {
  readonly v: typeof CONSOLE_TERMINAL_SETTINGS_VERSION;
}

export const DEFAULT_CONSOLE_TERMINAL_SETTINGS: ConsoleTerminalSettings = Object.freeze({
  fontId: "fira-code",
  fontSize: 13,
  cursorStyle: "block",
  cursorBlink: true,
  smoothScrolling: false,
});

const CURSOR_STYLES = new Set<ConsoleTerminalCursorStyle>(["block", "underline", "bar"]);
const FONT_IDS = new Set<ConsoleTerminalFontId>(CONSOLE_TERMINAL_FONTS.map(({ id }) => id));
const PERSISTED_KEYS = new Set([
  "v",
  "fontId",
  "fontSize",
  "cursorStyle",
  "cursorBlink",
  "smoothScrolling",
]);

export function isConsoleTerminalFontId(value: unknown): value is ConsoleTerminalFontId {
  return typeof value === "string" && FONT_IDS.has(value as ConsoleTerminalFontId);
}

export function isConsoleTerminalCursorStyle(value: unknown): value is ConsoleTerminalCursorStyle {
  return typeof value === "string" && CURSOR_STYLES.has(value as ConsoleTerminalCursorStyle);
}

export function consoleTerminalFontFamily(fontId: ConsoleTerminalFontId): string {
  const font = CONSOLE_TERMINAL_FONTS.find(({ id }) => id === fontId);
  return `"${font?.family ?? "Fira Code"}", monospace`;
}

export function loadConsoleTerminalSettings(
  storage: Pick<Storage, "getItem"> = window.localStorage,
): ConsoleTerminalSettings {
  try {
    const serialized = storage.getItem(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY);
    if (serialized === null) return DEFAULT_CONSOLE_TERMINAL_SETTINGS;
    return parseConsoleTerminalSettings(JSON.parse(serialized));
  } catch {
    return DEFAULT_CONSOLE_TERMINAL_SETTINGS;
  }
}

export function saveConsoleTerminalSettings(
  settings: ConsoleTerminalSettings,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  const validated = parseConsoleTerminalSettings({
    v: CONSOLE_TERMINAL_SETTINGS_VERSION,
    ...settings,
  });
  const persisted: PersistedConsoleTerminalSettings = {
    v: CONSOLE_TERMINAL_SETTINGS_VERSION,
    ...validated,
  };
  try {
    storage.setItem(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
  } catch {
    // Terminal preferences are non-sensitive convenience state. The active
    // document still applies them even when persistent storage is unavailable.
  }
}

export function parseConsoleTerminalSettings(value: unknown): ConsoleTerminalSettings {
  if (!isRecord(value) || Object.keys(value).some((key) => !PERSISTED_KEYS.has(key))) {
    throw new TypeError("Invalid terminal settings");
  }
  if (
    value["v"] !== CONSOLE_TERMINAL_SETTINGS_VERSION ||
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
