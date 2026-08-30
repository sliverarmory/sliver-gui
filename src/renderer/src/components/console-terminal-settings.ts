import {
  CONSOLE_TERMINAL_FONTS,
  DEFAULT_APPLICATION_TERMINAL_SETTINGS,
  parseApplicationTerminalSettings,
  type ApplicationTerminalSettings,
  type ConsoleTerminalFontId,
} from "../../../shared/application-settings-contracts";

export {
  CONSOLE_TERMINAL_FONTS,
  CONSOLE_TERMINAL_FONT_SIZE_MAX,
  CONSOLE_TERMINAL_FONT_SIZE_MIN,
  CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS,
  isConsoleTerminalCursorStyle,
  isConsoleTerminalFontId,
} from "../../../shared/application-settings-contracts";
export type {
  ConsoleTerminalCursorStyle,
  ConsoleTerminalFontId,
} from "../../../shared/application-settings-contracts";

export const CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY = "sliver.console-terminal-settings";
export const CONSOLE_TERMINAL_SETTINGS_VERSION = 1 as const;
export type ConsoleTerminalSettings = ApplicationTerminalSettings;

interface PersistedConsoleTerminalSettings extends ConsoleTerminalSettings {
  readonly v: typeof CONSOLE_TERMINAL_SETTINGS_VERSION;
}

export const DEFAULT_CONSOLE_TERMINAL_SETTINGS = DEFAULT_APPLICATION_TERMINAL_SETTINGS;

const PERSISTED_KEYS = new Set([
  "v",
  "fontId",
  "fontSize",
  "cursorStyle",
  "cursorBlink",
  "smoothScrolling",
]);

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
  if (
    !isRecord(value) ||
    Object.keys(value).length !== PERSISTED_KEYS.size ||
    Object.keys(value).some((key) => !PERSISTED_KEYS.has(key)) ||
    value["v"] !== CONSOLE_TERMINAL_SETTINGS_VERSION
  ) {
    throw new TypeError("Invalid terminal settings");
  }
  try {
    return parseApplicationTerminalSettings({
      fontId: value["fontId"],
      fontSize: value["fontSize"],
      cursorStyle: value["cursorStyle"],
      cursorBlink: value["cursorBlink"],
      smoothScrolling: value["smoothScrolling"],
    });
  } catch {
    throw new TypeError("Invalid terminal settings");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
