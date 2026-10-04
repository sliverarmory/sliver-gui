import {
  CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS,
  type ApplicationTerminalSettings,
} from "../../../shared/application-settings-contracts";
import type { GhosttyConfigState, GhosttyThemeAppearance } from "../../../shared/ghostty-theme";
import type { GhosttyTerminalAppearance } from "./GhosttyTerminal";
import { consoleTerminalFontFamily } from "./console-terminal-settings";

const DARK_TERMINAL_THEME = Object.freeze({
  background: "#1e1e1e",
  foreground: "#f4f4f5",
  cursor: "#f4f4f5",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#3f3f46",
  selectionForeground: "#f4f4f5",
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
  selectionForeground: "#18181b",
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

const PALETTE_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const;
type TerminalTheme = NonNullable<GhosttyTerminalAppearance["theme"]>;
// Native vibrancy already supplies the frosted background. Match the main
// sidebar's light tint so the renderer does not cover up that material.
const DEFAULT_GLASS_BACKGROUND_OPACITY = 0.22;
const configuredThemes = new WeakMap<GhosttyThemeAppearance, Map<string, TerminalTheme>>();
const transparentThemes = {
  dark: { ...DARK_TERMINAL_THEME, backgroundOpacity: DEFAULT_GLASS_BACKGROUND_OPACITY },
  light: { ...LIGHT_TERMINAL_THEME, backgroundOpacity: DEFAULT_GLASS_BACKGROUND_OPACITY },
};

export function applicationTerminalAppearance(
  settings: ApplicationTerminalSettings,
  resolvedTheme: "light" | "dark",
  reduceMotion: boolean,
  ghosttyConfig?: GhosttyConfigState,
  transparentWindow = false,
): GhosttyTerminalAppearance {
  return {
    cursorBlink: settings.cursorBlink && !reduceMotion,
    cursorStyle: settings.cursorStyle,
    fontFamily: consoleTerminalFontFamily(settings.fontId),
    fontSize: settings.fontSize,
    smoothScrollDuration: settings.smoothScrolling && !reduceMotion
      ? CONSOLE_TERMINAL_SMOOTH_SCROLL_DURATION_MS
      : 0,
    theme: terminalTheme(resolvedTheme, ghosttyConfig?.[resolvedTheme], transparentWindow),
  };
}

function terminalTheme(
  resolvedTheme: "light" | "dark",
  configured: GhosttyThemeAppearance | undefined,
  transparentWindow: boolean,
): TerminalTheme {
  const defaults = resolvedTheme === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
  if (!configured) return transparentWindow ? transparentThemes[resolvedTheme] : defaults;
  const key = `${resolvedTheme}:${transparentWindow}`;
  let cache = configuredThemes.get(configured);
  const cached = cache?.get(key);
  if (cached) return cached;
  const theme: TerminalTheme = { ...defaults };
  if (configured.background) theme.background = configured.background;
  if (configured.foreground) theme.foreground = configured.foreground;
  theme.cursor = configured.cursor ?? theme.foreground ?? defaults.foreground;
  theme.cursorAccent = configured.cursorText ?? theme.background ?? defaults.background;
  const configuredColors = Object.entries(configured).some(([name, value]) => name === "palette"
    ? Object.keys(configured.palette).length > 0
    : name !== "backgroundOpacity" && value !== undefined);
  // Native Ghostty defaults selections to inverted window colors. Preserve
  // the app's existing selection palette until a color theme is configured.
  theme.selectionForeground = configured.selectionForeground ?? (configuredColors
    ? theme.background ?? defaults.background
    : defaults.selectionForeground);
  theme.selectionBackground = configured.selectionBackground ?? (configuredColors
    ? theme.foreground ?? defaults.foreground
    : defaults.selectionBackground);
  for (const [index, name] of PALETTE_KEYS.entries()) {
    const color = configured.palette[index];
    if (color) theme[name] = color;
  }
  if (transparentWindow) theme.backgroundOpacity = configured.backgroundOpacity ?? DEFAULT_GLASS_BACKGROUND_OPACITY;
  if (!cache) {
    cache = new Map();
    configuredThemes.set(configured, cache);
  }
  cache.set(key, theme);
  return theme;
}
