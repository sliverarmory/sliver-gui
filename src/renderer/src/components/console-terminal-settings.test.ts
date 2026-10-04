import { describe, expect, it, vi } from "vitest";

import {
  CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY,
  DEFAULT_CONSOLE_TERMINAL_SETTINGS,
  consoleTerminalFontFamily,
  loadConsoleTerminalSettings,
  parseConsoleTerminalSettings,
  saveConsoleTerminalSettings,
} from "./console-terminal-settings";

describe("console terminal settings", () => {
  it("defaults to the embedded Fira Code face", () => {
    expect(loadConsoleTerminalSettings({ getItem: () => null })).toEqual(
      DEFAULT_CONSOLE_TERMINAL_SETTINGS,
    );
    expect(consoleTerminalFontFamily("fira-code")).toBe('"Fira Code", monospace');
  });

  it("round-trips the exact versioned schema", () => {
    let persistedKey = "";
    let persistedValue = "";
    const settings = {
      fontId: "jetbrains-mono" as const,
      fontSize: 17,
      cursorStyle: "bar" as const,
      cursorBlink: false,
      smoothScrolling: true,
      transparentWindows: true,
    };
    saveConsoleTerminalSettings(settings, {
      setItem: (key, value) => {
        persistedKey = key;
        persistedValue = value;
      },
    });

    expect(persistedKey).toBe(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY);
    expect(JSON.parse(persistedValue)).toEqual({ v: 1, ...settings });
    expect(loadConsoleTerminalSettings({ getItem: () => persistedValue })).toEqual(settings);
  });

  it.each([
    { v: 2, fontId: "fira-code", fontSize: 13, cursorStyle: "block", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "system-font", fontSize: 13, cursorStyle: "block", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 7, cursorStyle: "block", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 33, cursorStyle: "block", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 13.5, cursorStyle: "block", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 13, cursorStyle: "beam", cursorBlink: true, smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 13, cursorStyle: "block", cursorBlink: "yes", smoothScrolling: false },
    { v: 1, fontId: "fira-code", fontSize: 13, cursorStyle: "block", cursorBlink: true, smoothScrolling: false, extra: true },
  ])("rejects malformed or unsupported persisted settings", (value) => {
    expect(() => parseConsoleTerminalSettings(value)).toThrow("Invalid terminal settings");
    expect(loadConsoleTerminalSettings({ getItem: () => JSON.stringify(value) })).toEqual(
      DEFAULT_CONSOLE_TERMINAL_SETTINGS,
    );
  });

  it("falls back safely when browser storage is unavailable", () => {
    const setItem = vi.fn(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => saveConsoleTerminalSettings(DEFAULT_CONSOLE_TERMINAL_SETTINGS, { setItem }))
      .not.toThrow();
    expect(setItem).toHaveBeenCalledOnce();
    expect(loadConsoleTerminalSettings({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    })).toEqual(DEFAULT_CONSOLE_TERMINAL_SETTINGS);
  });
});
