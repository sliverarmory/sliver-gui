import {
  CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS,
  type ApplicationTerminalSettings,
} from "../../../shared/application-settings-contracts";
import type { GhosttyTerminalAppearance } from "./GhosttyTerminal";
import { consoleTerminalFontFamily } from "./console-terminal-settings";

const DARK_TERMINAL_THEME = Object.freeze({
  background: "#1e1e1e",
  foreground: "#f4f4f5",
  cursor: "#f4f4f5",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#3f3f46",
  black: "#27272a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#e4e4e7",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
});

const LIGHT_TERMINAL_THEME = Object.freeze({
  background: "#fafafa",
  foreground: "#18181b",
  cursor: "#18181b",
  cursorAccent: "#fafafa",
  selectionBackground: "#d4d4d8",
  black: "#27272a",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#e4e4e7",
  brightBlack: "#52525b",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#ffffff",
});

export function applicationTerminalAppearance(
  settings: ApplicationTerminalSettings,
  resolvedTheme: "light" | "dark",
  reduceMotion: boolean,
): GhosttyTerminalAppearance {
  return {
    cursorBlink: settings.cursorBlink && !reduceMotion,
    cursorStyle: settings.cursorStyle,
    fontFamily: consoleTerminalFontFamily(settings.fontId),
    fontSize: settings.fontSize,
    smoothScrollDuration: settings.smoothScrolling && !reduceMotion
      ? CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS
      : 0,
    theme: resolvedTheme === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME,
  };
}
