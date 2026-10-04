import { GHOSTTY_X11_COLORS } from "./ghostty-x11-colors.js";

/** Appearance overrides only; absence means the application's terminal default. */
export interface GhosttyThemeAppearance {
  foreground?: string;
  background?: string;
  cursor?: string;
  cursorText?: string;
  selectionForeground?: string;
  selectionBackground?: string;
  backgroundOpacity?: number;
  palette: Readonly<Record<number, string>>;
}

export interface GhosttyConfigDiagnostic {
  source: string;
  line?: number;
  severity: "warning" | "error";
  message: string;
}

export interface GhosttyThemeCatalogEntry {
  name: string;
  path: string;
}

export interface GhosttyConfigState {
  configPath: string;
  themesDirectory: string;
  theme: string;
  themes: readonly GhosttyThemeCatalogEntry[];
  light: GhosttyThemeAppearance;
  dark: GhosttyThemeAppearance;
  diagnostics: readonly GhosttyConfigDiagnostic[];
  revision: number;
}

export interface GhosttyConfigEntry {
  key: string;
  value: string;
  line: number;
}

const COLOR_KEYS = {
  foreground: "foreground",
  background: "background",
  "cursor-color": "cursor",
  "cursor-text": "cursorText",
  "selection-foreground": "selectionForeground",
  "selection-background": "selectionBackground",
} as const;

export function parseGhosttyConfig(text: string, source: string): {
  entries: GhosttyConfigEntry[];
  diagnostics: GhosttyConfigDiagnostic[];
} {
  const entries: GhosttyConfigEntry[] = [];
  const diagnostics: GhosttyConfigDiagnostic[] = [];
  for (const [index, raw] of text.replace(/^\uFEFF/u, "").split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    const key = line.slice(0, equals).trim();
    if (equals < 0 || !/^[a-z][a-z0-9-]*$/u.test(key)) {
      diagnostics.push({ source, line: index + 1, severity: "error", message: "Expected a lowercase key = value configuration entry." });
      continue;
    }
    const rawValue = line.slice(equals + 1).trim();
    // Ghostty strips a matching pair of quotes; comments are only whole lines.
    const quoted = rawValue.startsWith('"');
    if (quoted && (rawValue.length < 2 || !rawValue.endsWith('"'))) {
      diagnostics.push({ source, line: index + 1, severity: "error", message: `The ${key} value has an unmatched quote.` });
      continue;
    }
    entries.push({ key, value: quoted ? rawValue.slice(1, -1) : rawValue, line: index + 1 });
  }
  return { entries, diagnostics };
}

/** Matches Ghostty's RGB/X11 color input; never passes arbitrary strings to CSS. */
export function parseGhosttyColor(input: string): string | undefined {
  const value = input.trim();
  const named = Object.hasOwn(GHOSTTY_X11_COLORS, value.toLowerCase()) ? GHOSTTY_X11_COLORS[value.toLowerCase()] : undefined;
  if (named) return named;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  const lengths = value.startsWith("#") ? [3, 6, 9, 12] : [3, 6];
  if (lengths.includes(hex.length) && /^[a-f\d]+$/iu.test(hex)) {
    const width = hex.length / 3;
    return colorFromChannels([0, 1, 2].map((channel) =>
      Math.floor(Number.parseInt(hex.slice(channel * width, (channel + 1) * width), 16) * 255 / (16 ** width - 1))));
  }
  const rgb = /^rgb:([a-f\d]{1,4})\/([a-f\d]{1,4})\/([a-f\d]{1,4})$/iu.exec(value);
  if (rgb) return colorFromChannels(rgb.slice(1).map((channel) =>
    Math.floor(Number.parseInt(channel, 16) * 255 / (16 ** channel.length - 1))));
  if (value.startsWith("rgbi:")) {
    const channels = value.slice(5).split("/");
    if (channels.length === 3 && channels.every((channel) => /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(channel)
      && Number(channel) >= 0 && Number(channel) <= 1)) {
      return colorFromChannels(channels.map((channel) => Math.floor(Number(channel) * 255)));
    }
  }
  return undefined;
}

export function applyGhosttyAppearance(
  base: GhosttyThemeAppearance,
  entries: readonly GhosttyConfigEntry[],
  source: string,
): { appearance: GhosttyThemeAppearance; diagnostics: GhosttyConfigDiagnostic[] } {
  const appearance: GhosttyThemeAppearance = { ...base, palette: { ...base.palette } };
  const diagnostics: GhosttyConfigDiagnostic[] = [];
  const report = (entry: GhosttyConfigEntry, severity: "warning" | "error", message: string): void => {
    diagnostics.push({ source, line: entry.line, severity, message });
  };
  for (const entry of entries) {
    if (entry.key === "theme" || entry.key === "config-file") continue;
    if (Object.hasOwn(COLOR_KEYS, entry.key)) {
      const key = COLOR_KEYS[entry.key as keyof typeof COLOR_KEYS];
      if (entry.value === "") {
        delete appearance[key];
        continue;
      }
      const color = parseGhosttyColor(entry.value);
      if (color) appearance[key] = color;
      else if (entry.value === "cell-foreground" || entry.value === "cell-background") {
        report(entry, "warning", `${entry.key}: dynamic cell colors are not supported by the embedded terminal; the value is preserved for native Ghostty.`);
      } else report(entry, "error", `${entry.key}: expected a Ghostty RGB or X11 color.`);
      continue;
    }
    if (entry.key === "palette") {
      if (!entry.value) {
        appearance.palette = {};
        continue;
      }
      const match = /^(0[xX][a-f\d]+|0[bB][01]+|0[oO][0-7]+|\d+)\s*=\s*(.+)$/iu.exec(entry.value);
      const index = match ? Number(match[1]) : Number.NaN;
      const color = match ? parseGhosttyColor(match[2] ?? "") : undefined;
      if (!Number.isInteger(index) || index < 0 || index > 255 || !color) {
        report(entry, "error", "palette: expected an index from 0 to 255 followed by = and a Ghostty color.");
        continue;
      }
      appearance.palette = { ...appearance.palette, [index]: color };
      if (index >= 16) report(entry, "warning", `palette ${index}: the embedded terminal currently applies palette colors 0–15; this color is preserved for native Ghostty.`);
      continue;
    }
    if (entry.key === "background-opacity") {
      if (!entry.value) {
        delete appearance.backgroundOpacity;
      } else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(entry.value) && Number.isFinite(Number(entry.value))) {
        appearance.backgroundOpacity = Math.min(1, Math.max(0, Number(entry.value)));
      } else report(entry, "error", "background-opacity: expected a number between 0 and 1.");
      continue;
    }
    report(entry, "warning", `${entry.key} is not supported by the embedded terminal and is preserved for native Ghostty.`);
  }
  return { appearance, diagnostics };
}

export function ghosttyThemeForMode(theme: string, mode: "light" | "dark"): string {
  if (!/^(?:light|dark)\s*:/u.test(theme)) return theme;
  const pair = /^(light|dark)\s*:\s*(.+?)\s*,\s*(light|dark)\s*:\s*(.+)$/u.exec(theme);
  if (!pair || pair[1] === pair[3]) throw new Error("A theme pair must specify both light:theme and dark:theme.");
  return (pair[1] === mode ? pair[2] : pair[4])!.trim();
}

function colorFromChannels(channels: readonly number[]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
