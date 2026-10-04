import { describe, expect, it } from "vitest";

import { DEFAULT_APPLICATION_TERMINAL_SETTINGS } from "../../../shared/application-settings-contracts";
import type { GhosttyConfigState } from "../../../shared/ghostty-theme";
import { applyGhosttyAppearance, parseGhosttyConfig } from "../../../shared/ghostty-theme";
import { applicationTerminalAppearance } from "./application-terminal-appearance";

describe("applicationTerminalAppearance", () => {
  it("applies the shared terminal preferences and a readable light palette", () => {
    expect(applicationTerminalAppearance({
      ...DEFAULT_APPLICATION_TERMINAL_SETTINGS,
      fontId: "jetbrains-mono",
      fontSize: 17,
      cursorStyle: "bar",
      smoothScrolling: true,
    }, "light", false)).toMatchObject({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 17,
      smoothScrollDuration: 100,
      theme: {
        background: "#fafafa",
        foreground: "#18181b",
        cursor: "#18181b",
      },
    });
  });

  it("turns off cursor and scrolling animation without overwriting their saved preferences", () => {
    const settings = {
      ...DEFAULT_APPLICATION_TERMINAL_SETTINGS,
      cursorBlink: true,
      smoothScrolling: true,
    };

    expect(applicationTerminalAppearance(settings, "dark", true)).toMatchObject({
      cursorBlink: false,
      smoothScrollDuration: 0,
      theme: { background: "#1e1e1e", foreground: "#f4f4f5" },
    });
    expect(settings).toMatchObject({ cursorBlink: true, smoothScrolling: true });
  });

  it("maps Ghostty colors and every supported palette slot without leaking extended colors", () => {
    const config = fixtureConfig();
    config.dark = {
      foreground: "#abcdef", background: "#123456", cursor: "#aaaaaa", cursorText: "#bbbbbb",
      selectionForeground: "#cccccc", selectionBackground: "#dddddd", backgroundOpacity: 0.4,
      palette: { 0: "#111111", 15: "#ffffff", 100: "#808080" },
    };
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config).theme).toMatchObject({
      foreground: "#abcdef", background: "#123456", cursor: "#aaaaaa", cursorAccent: "#bbbbbb",
      selectionForeground: "#cccccc", selectionBackground: "#dddddd", black: "#111111", brightWhite: "#ffffff",
    });
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config).theme).not.toHaveProperty("backgroundOpacity");
  });

  it("uses opacity only for an enabled standalone transparent window", () => {
    const config = fixtureConfig();
    config.dark.backgroundOpacity = 0.4;
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config, true).theme?.backgroundOpacity).toBe(0.4);
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config, false).theme?.backgroundOpacity).toBeUndefined();
  });

  it.each(["dark", "light"] as const)("keeps the native glass visible with the default %s theme", (mode) => {
    for (const config of [undefined, fixtureConfig()]) {
      expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, mode, false, config, true).theme?.backgroundOpacity).toBe(0.22);
    }
  });

  it("keeps theme identity stable across font changes and clears overrides across modes", () => {
    const config = fixtureConfig();
    config.dark.foreground = "#ff0000";
    const dark = applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config);
    const changedFont = applicationTerminalAppearance({ ...DEFAULT_APPLICATION_TERMINAL_SETTINGS, fontSize: 20 }, "dark", false, config);
    expect(changedFont.theme).toBe(dark.theme);
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "light", false, config).theme?.foreground).toBe("#18181b");
  });

  it("uses native inverse selection defaults for a configured theme", () => {
    const config = fixtureConfig();
    config.dark = { foreground: "#cdd6f4", background: "#1e1e2e", palette: {} };
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config).theme).toMatchObject({
      selectionForeground: "#1e1e2e", selectionBackground: "#cdd6f4",
    });
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, fixtureConfig()).theme).toMatchObject({
      selectionForeground: "#f4f4f5", selectionBackground: "#3f3f46",
    });
  });

  it("resets inherited selection overrides to native defaults without retaining theme values", () => {
    const config = fixtureConfig();
    const inherited = {
      foreground: "#cdd6f4", background: "#1e1e2e", selectionForeground: "#ff0000", selectionBackground: "#00ff00",
      backgroundOpacity: 0.5, palette: { 1: "#010203" },
    };
    const entries = parseGhosttyConfig("selection-foreground=\nselection-background=\npalette=\nbackground-opacity=", "config").entries;
    config.dark = applyGhosttyAppearance(inherited, entries, "config").appearance;
    expect(applicationTerminalAppearance(DEFAULT_APPLICATION_TERMINAL_SETTINGS, "dark", false, config, true).theme).toMatchObject({
      selectionForeground: "#1e1e2e", selectionBackground: "#cdd6f4", red: "#f87171", backgroundOpacity: 0.22,
    });
    expect(inherited.selectionForeground).toBe("#ff0000");
  });
});

function fixtureConfig(): GhosttyConfigState {
  return {
    configPath: "/test/ghostty/config", themesDirectory: "/test/ghostty/themes", theme: "", themes: [],
    light: { palette: {} }, dark: { palette: {} }, diagnostics: [], revision: 1,
  };
}
