// @vitest-environment node

import { describe, expect, it } from "vitest";

import { safeScriptExportBasename, scriptImportDisplayName } from "./script-file-name.js";

describe("script export suggested basenames", () => {
  it.each([
    ["Hello World", "Hello World.js"],
    ["example.js", "example.js"],
    ["example.JS", "example.js"],
    ["example.js.js", "example.js.js"],
    [" . example.js. ", "example.js"],
    ["/tmp/example.js", "example.js"],
    ["../../example", "example.js"],
    ["..\\..\\example", "example.js"],
    ["C:\\scripts\\example.js", "example.js"],
    ["C:example", "example.js"],
    ["\\\\server\\share\\example.js", "example.js"],
    ["folder／example", "example.js"],
    ["bad<>:\"|?*name", "bad_______name.js"],
    ["a\u0000\u001f\u007f\u009fb", "a____b.js"],
    ["a\u061c\u200e\u200f\u202e\u2066b", "a_____b.js"],
    ["a\ud800b\udfffc", "a_b_c.js"],
    ["Résumé", "Résumé.js"],
    ["Tools 🧰", "Tools 🧰.js"],
    ["__", "__.js"],
  ])("maps %j to %j", (input, expected) => {
    expect(safeScriptExportBasename(input)).toBe(expected);
  });

  it.each(["", " ", ".", "..", "...", ".js", "../", "..\\", "C:", "<>|?*", "\u0000\u202e"])(
    "uses a readable fallback for %j",
    (input) => {
      expect(safeScriptExportBasename(input)).toBe("script.js");
    },
  );

  it.each([
    ["CON", "_CON.js"],
    ["nul.foo", "_nul.foo.js"],
    ["PrN.JS", "_PrN.js"],
    ["AUX", "_AUX.js"],
    ["COM1", "_COM1.js"],
    ["LPT9", "_LPT9.js"],
    ["COM¹", "_COM1.js"],
    ["LPT².js", "_LPT2.js"],
    ["ＣＯＮ", "_CON.js"],
    ["con .report", "_con .report.js"],
    ["CONIN$", "_CONIN$.js"],
    ["conout$.txt", "_conout$.txt.js"],
    ["COM10", "COM10.js"],
    ["console", "console.js"],
  ])("handles portable device names in %j", (input, expected) => {
    expect(safeScriptExportBasename(input)).toBe(expected);
  });

  it.each(["a".repeat(250), "é".repeat(200), "🧰".repeat(200), `CON.${"é".repeat(200)}`])(
    "caps UTF-8 bytes without splitting a character",
    (input) => {
      const actual = safeScriptExportBasename(input);
      expect(Buffer.byteLength(actual, "utf8")).toBeLessThanOrEqual(180);
      expect(Buffer.from(actual, "utf8").toString("utf8")).toBe(actual);
      expect(actual).toMatch(/\.js$/u);
      expect(actual).not.toMatch(/[/\\\u0000-\u001f\u007f-\u009f<>:"|?*]/u);
      expect(Buffer.byteLength(`.${actual}.00000000-0000-4000-8000-000000000000.tmp`, "utf8"))
        .toBeLessThanOrEqual(255);
    },
  );

  it("uses the full byte budget for ASCII and keeps whole emoji", () => {
    expect(safeScriptExportBasename("a".repeat(200))).toBe(`${"a".repeat(177)}.js`);
    expect(safeScriptExportBasename("🧰".repeat(200))).toBe(`${"🧰".repeat(44)}.js`);
  });
});

describe("imported script display names", () => {
  it.each([
    ["Hello World.js", "Hello World"],
    ["example.JS", "example"],
    ["example.js.js", "example.js"],
    ["../example.js", "example"],
    ["a\u0000\u202eb.js", "a__b"],
    ["COM¹.js", "_COM1"],
    [".js", "script"],
  ])("derives readable display text from %j", (input, expected) => {
    expect(scriptImportDisplayName(input)).toBe(expected);
  });

  it("stays within the display-name code unit bound", () => {
    for (const input of ["a".repeat(500), "🧰".repeat(500), "é".repeat(500)]) {
      const name = scriptImportDisplayName(input);
      expect(name.length).toBeLessThanOrEqual(200);
      expect(name.length).toBeGreaterThan(0);
      expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
    }
  });
});
