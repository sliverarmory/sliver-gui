import { describe, expect, it } from "vitest";

import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  DEFAULT_APPLICATION_SETTINGS_VALUES,
  DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
  DEFAULT_APPLICATION_TERMINAL_SETTINGS,
  isApplicationIcon,
  isReportScreenshotDirectory,
  parseApplicationSettingsState,
  parsePersistedApplicationSettingsState,
  parseApplicationSettingsUpdateInput,
  parseApplicationSettingsValues,
  parseApplicationTerminalSettings,
  parseApplicationOverviewSettings,
} from "./application-settings-contracts.js";

const terminal = {
  fontId: "jetbrains-mono" as const,
  fontSize: 17,
  cursorStyle: "bar" as const,
  cursorBlink: false,
  smoothScrolling: true,
  transparentWindows: true,
};
const settings = {
  theme: "light" as const,
  appIcon: "passion" as const,
  reduceMotion: true,
  commandPaletteShortcut: "mod+shift+p",
  keyboardShortcuts: {},
  reportScreenshotDirectory: null,
  terminal,
  overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
};

describe("application settings contracts", () => {
  it("provides deeply frozen version-seven defaults with Desktop screenshots", () => {
    expect(DEFAULT_APPLICATION_SETTINGS_STATE).toEqual({
      v: 7,
      revision: 0,
      theme: "system",
      appIcon: "auto",
      reduceMotion: false,
      reportScreenshotDirectory: null,
      commandPaletteShortcut: "mod+k",
      keyboardShortcuts: {},
      terminal: {
        fontId: "fira-code",
        fontSize: 13,
        cursorStyle: "block",
        cursorBlink: true,
        smoothScrolling: false,
        transparentWindows: true,
      },
      overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
    });
    expect(Object.isFrozen(DEFAULT_APPLICATION_SETTINGS_STATE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_SETTINGS_VALUES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_TERMINAL_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_OVERVIEW_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts)).toBe(true);
  });

  it("migrates version-six terminal preferences without losing settings", () => {
    const { transparentWindows: _transparent, ...legacyTerminal } = terminal;
    const legacy = { ...DEFAULT_APPLICATION_SETTINGS_STATE, ...settings, v: 6, revision: 25, terminal: legacyTerminal };
    expect(parsePersistedApplicationSettingsState(legacy)).toEqual({
      ...legacy, v: APPLICATION_SETTINGS_VERSION, terminal: { ...legacyTerminal, transparentWindows: true },
    });
    expect(() => parseApplicationSettingsState({ ...legacy, v: APPLICATION_SETTINGS_VERSION })).toThrow();
    expect(() => parseApplicationTerminalSettings({ ...terminal, transparentWindows: "yes" })).toThrow();
  });

  it("parses and deeply freezes exact state and update schemas", () => {
    const state = parseApplicationSettingsState({
      v: APPLICATION_SETTINGS_VERSION,
      revision: 7,
      ...settings,
    });
    const update = parseApplicationSettingsUpdateInput({
      expectedRevision: 7,
      settings,
    });

    expect(state).toEqual({ v: 7, revision: 7, ...settings });
    expect(update).toEqual({ expectedRevision: 7, settings });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.terminal)).toBe(true);
    expect(Object.isFrozen(state.keyboardShortcuts)).toBe(true);
    expect(Object.isFrozen(state.overview)).toBe(true);
    expect(Object.isFrozen(update)).toBe(true);
    expect(Object.isFrozen(update.settings)).toBe(true);
    expect(Object.isFrozen(update.settings.terminal)).toBe(true);
  });

  it.each(["auto", "light", "dark", "passion"])("accepts the %s icon independently of the application theme", (appIcon) => {
    expect(isApplicationIcon(appIcon)).toBe(true);
    expect(parseApplicationSettingsValues({ ...settings, theme: "dark", appIcon })).toEqual({
      ...settings,
      theme: "dark",
      appIcon,
    });
  });

  it("migrates exact version-two state while preserving every existing preference", () => {
    const previous = {
      v: 2,
      revision: 8,
      theme: "dark",
      reduceMotion: true,
      commandPaletteShortcut: "mod+alt+shift+p",
      terminal,
    };
    expect(() => parseApplicationSettingsState(previous)).toThrow("Invalid application settings state");
    const migrated = parsePersistedApplicationSettingsState(previous);
    expect(migrated).toEqual({ ...previous, v: 7, appIcon: "auto", keyboardShortcuts: {}, reportScreenshotDirectory: null, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS });
    expect(Object.isFrozen(migrated)).toBe(true);
    expect(Object.isFrozen(migrated.terminal)).toBe(true);
  });

  it.each(["mod+shift+p", "mod+shift+v", "mod+alt+i"])("migrates version-three settings while preserving the existing %s palette shortcut", (commandPaletteShortcut) => {
    const previous = {
      v: 3,
      revision: 12,
      theme: "dark",
      appIcon: "passion",
      reduceMotion: true,
      commandPaletteShortcut,
      terminal,
    };
    const migrated = parsePersistedApplicationSettingsState(previous);
    expect(migrated).toEqual({ ...previous, v: 7, keyboardShortcuts: {}, reportScreenshotDirectory: null, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS });
    expect(Object.isFrozen(migrated.keyboardShortcuts)).toBe(true);
  });

  it("migrates version-four settings to the Desktop screenshot location", () => {
    const { reportScreenshotDirectory: _directory, overview: _overview, ...previousSettings } = settings;
    const previous = { v: 4, revision: 14, ...previousSettings };
    const migrated = parsePersistedApplicationSettingsState(previous);
    expect(migrated).toEqual({ ...previous, v: 7, reportScreenshotDirectory: null, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS });
  });

  it("migrates version-five settings without discarding existing preferences", () => {
    const { overview: _overview, ...previousSettings } = settings;
    const previous = { v: 5, revision: 19, ...previousSettings };
    expect(parsePersistedApplicationSettingsState(previous)).toEqual({
      ...previous, v: 7, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
    });
  });

  it("preserves selected future types and empty selections in overview settings", () => {
    const parsed = parseApplicationOverviewSettings({
      kinds: ["future-kind", "operator"], statuses: [], lightning: true,
      sidebarDisabled: true, presentation: "list",
    });
    expect(parsed).toEqual({ kinds: ["future-kind", "operator"], statuses: [], lightning: true,
      sidebarDisabled: true, presentation: "list" });
    expect(Object.isFrozen(parsed.kinds)).toBe(true);
    expect(Object.isFrozen(parsed.statuses)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const invalid of [
      { ...parsed, kinds: ["operator", "operator"] },
      { ...parsed, kinds: ["future\nkind"] },
      { ...parsed, kinds: Array.from({ length: 65 }, (_, index) => `kind-${index}`) },
      { ...parsed, statuses: ["broken"] },
      { ...parsed, statuses: ["healthy", "healthy"] },
      { ...parsed, lightning: "yes" },
      { ...parsed, presentation: "table" },
      { ...parsed, extra: true },
    ]) expect(() => parseApplicationOverviewSettings(invalid)).toThrow("Invalid overview settings");
  });

  it.each(["/Users/operator/Pictures", "C:\\Users\\operator\\Pictures", "\\\\server\\share\\reports"])(
    "accepts an absolute screenshot directory %s", (directory) => {
      expect(isReportScreenshotDirectory(directory)).toBe(true);
      expect(parseApplicationSettingsValues({ ...settings, reportScreenshotDirectory: directory }))
        .toMatchObject({ reportScreenshotDirectory: directory });
    },
  );

  it("accepts the expanded shortcut syntax and freezes persisted overrides", () => {
    const parsed = parseApplicationSettingsValues({
      ...settings,
      commandPaletteShortcut: "mod+;",
      keyboardShortcuts: { newWindow: "mod+alt+n", terminalSettings: "mod+shift+," },
    });
    expect(parsed.commandPaletteShortcut).toBe("mod+;");
    expect(parsed.keyboardShortcuts).toEqual({ newWindow: "mod+alt+n", terminalSettings: "mod+shift+," });
    expect(Object.isFrozen(parsed.keyboardShortcuts)).toBe(true);
  });

  it("migrates exact version-one state with automatic icons and the default command palette shortcut", () => {
    const legacy = {
      v: 1,
      revision: 4,
      theme: "dark",
      reduceMotion: true,
      terminal,
    };
    expect(() => parseApplicationSettingsState(legacy)).toThrow("Invalid application settings state");
    expect(parsePersistedApplicationSettingsState(legacy)).toEqual({
      v: 7,
      revision: 4,
      theme: "dark",
      appIcon: "auto",
      reduceMotion: true,
      reportScreenshotDirectory: null,
      commandPaletteShortcut: "mod+k",
      keyboardShortcuts: {},
      terminal,
      overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
    });
  });

  it.each([
    { v: 1, revision: 0, theme: "dark", reduceMotion: true, terminal, extra: true },
    { v: 1, revision: 0, theme: "dark", reduceMotion: true, terminal, appIcon: "passion" },
    { v: 1, revision: -1, theme: "dark", reduceMotion: true, terminal },
    { v: 2, revision: 0, theme: "dark", reduceMotion: true, terminal },
    { v: 2, revision: 0, ...settings },
    { v: 2, revision: 0, theme: "dark", reduceMotion: true, commandPaletteShortcut: "mod+n", terminal },
    { v: 2, revision: 0, theme: "dark", reduceMotion: true, commandPaletteShortcut: "mod+k", terminal: { ...terminal, fontSize: 100 } },
    { v: 3, revision: 0, ...settings },
    { v: 3, revision: 0, theme: "dark", appIcon: "auto", reduceMotion: true, commandPaletteShortcut: "mod+n", terminal },
  ])("rejects malformed legacy settings instead of silently discarding fields %#", (value) => {
    expect(() => parsePersistedApplicationSettingsState(value)).toThrow("Invalid persisted application settings state");
  });

  it.each([
    null,
    [],
    { ...terminal, extra: true },
    { ...terminal, fontId: "system" },
    { ...terminal, fontSize: 7 },
    { ...terminal, fontSize: 33 },
    { ...terminal, fontSize: 13.5 },
    { ...terminal, cursorStyle: "beam" },
    { ...terminal, cursorBlink: "yes" },
    { ...terminal, smoothScrolling: 1 },
  ])("rejects invalid terminal settings %#", (value) => {
    expect(() => parseApplicationTerminalSettings(value)).toThrow("Invalid terminal settings");
  });

  it.each([
    null,
    { theme: "system", reduceMotion: false },
    { ...settings, extra: true },
    { ...settings, theme: "sepia" },
    { ...settings, appIcon: "system" },
    { ...settings, appIcon: "Passion" },
    { ...settings, appIcon: null },
    { ...settings, appIcon: "../passion.png" },
    { ...settings, appIcon: undefined },
    { ...settings, reduceMotion: "yes" },
    { ...settings, reportScreenshotDirectory: "" },
    { ...settings, reportScreenshotDirectory: "Pictures" },
    { ...settings, reportScreenshotDirectory: "../Pictures" },
    { ...settings, reportScreenshotDirectory: "/tmp/new\nfolder" },
    { ...settings, reportScreenshotDirectory: 42 },
    { ...settings, reportScreenshotDirectory: "/" + "x".repeat(4096) },
    { ...settings, commandPaletteShortcut: "k" },
    { ...settings, commandPaletteShortcut: "shift+k" },
    { ...settings, commandPaletteShortcut: "mod+alt+alt+k" },
    { ...settings, commandPaletteShortcut: "mod+space" },
    { ...settings, terminal: { ...terminal, extra: true } },
    { ...settings, keyboardShortcuts: undefined },
    { ...settings, keyboardShortcuts: { newWindow: "mod+c" } },
    { ...settings, keyboardShortcuts: { missingAction: "mod+p" } },
  ])("rejects invalid application setting values %#", (value) => {
    expect(() => parseApplicationSettingsValues(value)).toThrow("Invalid application settings");
  });

  it.each([
    { v: 8, revision: 0, ...settings },
    { v: 5, revision: -1, ...settings },
    { v: 5, revision: 1.5, ...settings },
    { v: 5, revision: 0, ...settings, extra: true },
    { v: 5, revision: 0, ...settings, theme: "sepia" },
    { v: 5, revision: 0, ...settings, appIcon: "system" },
    { v: 2, revision: 0, ...settings },
    { v: 1, revision: 0, ...settings },
  ])("rejects invalid persisted state %#", (value) => {
    expect(() => parseApplicationSettingsState(value)).toThrow("Invalid application settings state");
  });

  it.each([
    { settings },
    { expectedRevision: -1, settings },
    { expectedRevision: 0, settings, extra: true },
    { expectedRevision: 0, settings: { ...settings, extra: true } },
    { expectedRevision: 0, settings: { ...settings, appIcon: "system" } },
  ])("rejects invalid update input %#", (value) => {
    expect(() => parseApplicationSettingsUpdateInput(value)).toThrow("Invalid application settings update");
  });
});
