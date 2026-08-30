import { describe, expect, it } from "vitest";

import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  DEFAULT_APPLICATION_SETTINGS_VALUES,
  DEFAULT_APPLICATION_TERMINAL_SETTINGS,
  parseApplicationSettingsState,
  parseApplicationSettingsUpdateInput,
  parseApplicationSettingsValues,
  parseApplicationTerminalSettings,
} from "./application-settings-contracts.js";

const terminal = {
  fontId: "jetbrains-mono" as const,
  fontSize: 17,
  cursorStyle: "bar" as const,
  cursorBlink: false,
  smoothScrolling: true,
};
const settings = {
  theme: "light" as const,
  reduceMotion: true,
  terminal,
};

describe("application settings contracts", () => {
  it("provides deeply frozen version-one defaults", () => {
    expect(DEFAULT_APPLICATION_SETTINGS_STATE).toEqual({
      v: 1,
      revision: 0,
      theme: "system",
      reduceMotion: false,
      terminal: {
        fontId: "fira-code",
        fontSize: 13,
        cursorStyle: "block",
        cursorBlink: true,
        smoothScrolling: false,
      },
    });
    expect(Object.isFrozen(DEFAULT_APPLICATION_SETTINGS_STATE)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_SETTINGS_VALUES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_APPLICATION_TERMINAL_SETTINGS)).toBe(true);
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

    expect(state).toEqual({ v: 1, revision: 7, ...settings });
    expect(update).toEqual({ expectedRevision: 7, settings });
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.terminal)).toBe(true);
    expect(Object.isFrozen(update)).toBe(true);
    expect(Object.isFrozen(update.settings)).toBe(true);
    expect(Object.isFrozen(update.settings.terminal)).toBe(true);
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
    { ...settings, reduceMotion: "yes" },
    { ...settings, terminal: { ...terminal, extra: true } },
  ])("rejects invalid application setting values %#", (value) => {
    expect(() => parseApplicationSettingsValues(value)).toThrow("Invalid application settings");
  });

  it.each([
    { v: 2, revision: 0, ...settings },
    { v: 1, revision: -1, ...settings },
    { v: 1, revision: 1.5, ...settings },
    { v: 1, revision: 0, ...settings, extra: true },
    { v: 1, revision: 0, theme: "sepia", reduceMotion: false, terminal },
  ])("rejects invalid persisted state %#", (value) => {
    expect(() => parseApplicationSettingsState(value)).toThrow("Invalid application settings state");
  });

  it.each([
    { settings },
    { expectedRevision: -1, settings },
    { expectedRevision: 0, settings, extra: true },
    { expectedRevision: 0, settings: { ...settings, extra: true } },
  ])("rejects invalid update input %#", (value) => {
    expect(() => parseApplicationSettingsUpdateInput(value)).toThrow("Invalid application settings update");
  });
});
