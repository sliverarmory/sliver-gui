import { describe, expect, it } from "vitest";

import { DEFAULT_APPLICATION_TERMINAL_SETTINGS } from "../../../shared/application-settings-contracts";
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
});
