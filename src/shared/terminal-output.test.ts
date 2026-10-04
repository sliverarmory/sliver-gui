import { describe, expect, it } from "vitest";

import { escapeTerminalOutput } from "./terminal-output.js";

describe("captured terminal output", () => {
  it("renders terminal and bidirectional controls as literal text", () => {
    expect(escapeTerminalOutput("\u001b]52;c;data\u0007<b>text</b>\u009b2J\u202e\u2066")).toBe(
      "\\u001b]52;c;data\\u0007<b>text</b>\\u009b2J\\u202e\\u2066",
    );
  });

  it("normalizes line endings while preserving tabs and printable Unicode", () => {
    expect(escapeTerminalOutput("first\r\nsecond\rthird\n\t🌎")).toBe("first\nsecond\nthird\n\t🌎");
  });
});
