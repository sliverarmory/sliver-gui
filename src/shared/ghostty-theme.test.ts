import { describe, expect, it } from "vitest";

import { applyGhosttyAppearance, ghosttyThemeForMode, parseGhosttyColor, parseGhosttyConfig } from "./ghostty-theme.js";

describe("Ghostty configuration syntax", () => {
  it("accepts comments, quoted values and empty resets without treating a hex color as a comment", () => {
    const parsed = parseGhosttyConfig('\uFEFF# Comment\r\n background = "#ABCDEF"\r\nforeground=\r\nkeybind = ctrl+x=quit\r\n', "config");
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.entries).toEqual([
      { key: "background", value: "#ABCDEF", line: 2 },
      { key: "foreground", value: "", line: 3 },
      { key: "keybind", value: "ctrl+x=quit", line: 4 },
    ]);
  });

  it("reports malformed lines and never interprets inline comments or unknown commands", () => {
    const parsed = parseGhosttyConfig('missing equals\nBackground=#abc\nforeground="unterminated\nbackground=#abcdef #comment\ncommand=sh -c anything\n', "config");
    expect(parsed.diagnostics).toHaveLength(3);
    const applied = applyGhosttyAppearance({ palette: {} }, parsed.entries, "config");
    expect(applied.appearance).toEqual({ palette: {} });
    expect(applied.diagnostics).toEqual([
      expect.objectContaining({ line: 4, severity: "error" }),
      expect.objectContaining({ line: 5, severity: "warning", message: expect.stringContaining("command is not supported") }),
    ]);
  });

  it("overrides a theme in order and applies native empty-value reset semantics", () => {
    const parsed = parseGhosttyConfig("background=#112233\nbackground=\nforeground=#ffffff\npalette=\npalette=0=#000000\nbackground-opacity=0.75", "config");
    expect(applyGhosttyAppearance({ background: "#aabbcc", foreground: "#000000", palette: { 2: "#cccccc" } }, parsed.entries, "config").appearance)
      .toEqual({ foreground: "#ffffff", palette: { 0: "#000000" }, backgroundOpacity: 0.75 });
  });

  it("parses all 256 palette indices and preserves runtime limitations as diagnostics", () => {
    const parsed = parseGhosttyConfig("palette=0b1=#010203\npalette=0o7=#070809\npalette=0xf=#ffffff\npalette=255=#aabbcc\npalette=256=#aabbcc", "theme");
    const applied = applyGhosttyAppearance({ palette: {} }, parsed.entries, "theme");
    expect(applied.appearance.palette).toEqual({ 1: "#010203", 7: "#070809", 15: "#ffffff", 255: "#aabbcc" });
    expect(applied.diagnostics).toEqual([
      expect.objectContaining({ line: 4, severity: "warning", message: expect.stringContaining("0–15") }),
      expect.objectContaining({ line: 5, severity: "error" }),
    ]);
  });

  it("reports dynamic cell colors and unsupported rendering options", () => {
    const parsed = parseGhosttyConfig("cursor-color=cell-foreground\nselection-background=cell-background\ncustom-shader=/tmp/test.glsl", "theme");
    const applied = applyGhosttyAppearance({ palette: {} }, parsed.entries, "theme");
    expect(applied.appearance).toEqual({ palette: {} });
    expect(applied.diagnostics).toHaveLength(3);
    expect(applied.diagnostics.every((diagnostic) => diagnostic.severity === "warning")).toBe(true);
  });

  it("clamps finite opacity as Ghostty does and rejects unsafe color strings", () => {
    for (const [input, expected] of [["3", 1], ["-1", 0], ["0.75", 0.75]] as const) {
      const parsed = parseGhosttyConfig(`background-opacity=${input}`, "config");
      expect(applyGhosttyAppearance({ palette: {} }, parsed.entries, "config").appearance.backgroundOpacity).toBe(expected);
    }
    for (const color of ["__proto__", "constructor", "transparent", "url(https://example.com)", "#abcdef00", "NaN", "#12"]) {
      expect(parseGhosttyColor(color)).toBeUndefined();
    }
  });
});

describe("Ghostty colors", () => {
  it.each([
    ["#AbC", "#aabbcc"], ["ff0000", "#ff0000"], ["#fff000fff", "#ff00ff"],
    ["#ffff00000000", "#ff0000"], ["rgb:f/0/ffff", "#ff00ff"], ["rgbi:1/0/.5", "#ff007f"],
    ["green", "#00ff00"], ["gray", "#bebebe"], ["gray50", "#7f7f7f"],
    ["Medium Spring Green", "#00fa9a"], ["FoReStGrEeN", "#228b22"], ["RebeccaPurple", "#663399"],
  ])("normalizes %s to the native Ghostty RGB value", (input, expected) => {
    expect(parseGhosttyColor(input)).toBe(expected);
  });
});

describe("Ghostty light/dark theme selection", () => {
  it("preserves plain names and absolute paths and resolves paired names", () => {
    expect(ghosttyThemeForMode("/tmp/my theme", "dark")).toBe("/tmp/my theme");
    expect(ghosttyThemeForMode("Ocean", "light")).toBe("Ocean");
    expect(ghosttyThemeForMode("dark: Ocean, light: Paper", "light")).toBe("Paper");
    expect(ghosttyThemeForMode("light:Paper,dark:Ocean", "dark")).toBe("Ocean");
    expect(() => ghosttyThemeForMode("light:Paper", "dark")).toThrow("both");
    expect(() => ghosttyThemeForMode("dark:Ocean,dark:Ocean", "light")).toThrow("both");
  });
});
