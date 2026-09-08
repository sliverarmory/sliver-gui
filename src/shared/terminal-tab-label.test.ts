import { describe, expect, it } from "vitest";

import {
  TERMINAL_TAB_LABEL_MAX_LENGTH,
  isTerminalTabLabel,
  normalizeTerminalTabLabel,
} from "./terminal-tab-label.js";

describe("terminal tab labels", () => {
  it("normalizes visible Unicode labels and preserves meaningful joiner sequences", () => {
    expect(normalizeTerminalTabLabel("  Primary 🛰️  ")).toBe("Primary 🛰️");
    expect(normalizeTerminalTabLabel("Developer 👩‍💻")).toBe("Developer 👩‍💻");
    expect(isTerminalTabLabel("Developer 👩‍💻")).toBe(true);
    expect(isTerminalTabLabel(" padded ")).toBe(false);
  });

  it("rejects visually blank, control, directional, and oversized labels", () => {
    for (const value of [
      "   ",
      "\u200b",
      "\u200c\u200d",
      "bad\nlabel",
      "left\u061cright",
      "left\u200eright",
      "left\u200fright",
      "left\u202eright",
      "left\u2066right",
      "x".repeat(TERMINAL_TAB_LABEL_MAX_LENGTH + 1),
    ]) expect(normalizeTerminalTabLabel(value)).toBeUndefined();
  });
});
