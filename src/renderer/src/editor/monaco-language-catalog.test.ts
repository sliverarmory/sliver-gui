import { describe, expect, it } from "vitest";

import {
  detectMonacoLanguage,
  monacoLanguageOptions,
  preferredMonacoExtension,
} from "./monaco-language-catalog";

const definitions = [
  { id: "plaintext", extensions: [".txt"], aliases: ["Plain Text", "text"] },
  { id: "python", extensions: [".py", ".gypi"], aliases: ["Python", "py"], firstLine: "^#!/.*\\bpython[0-9.-]*\\b" },
  { id: "shell", extensions: [".sh", ".bash"], aliases: ["Shell", "sh"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"], aliases: ["Dockerfile"] },
  { id: "liquid", extensions: [".liquid", ".html.liquid"], aliases: ["Liquid"] },
  { id: "pascal", extensions: [".pp"], aliases: ["Pascal"] },
  { id: "ruby", extensions: [".rb", ".pp"], filenames: ["Gemfile"], aliases: ["Ruby"] },
  { id: "broken", aliases: ["Broken"], firstLine: "[" },
  { id: "sliver-script", extensions: [".js"], aliases: ["Sliver Script"] },
] as const;

describe("Monaco language catalog", () => {
  it("uses Monaco labels and extensions, preserves the Bash product label, and excludes the app dialect", () => {
    const catalog = monacoLanguageOptions(definitions);

    expect(catalog.map(({ id, label }) => [id, label])).toEqual([
      ["shell", "Bash"], ["broken", "Broken"], ["dockerfile", "Dockerfile"],
      ["liquid", "Liquid"], ["pascal", "Pascal"], ["plaintext", "Plain Text"],
      ["python", "Python"], ["ruby", "Ruby"],
    ]);
    expect(catalog.find(({ id }) => id === "python")?.extensions).toEqual([".py", ".gypi"]);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog[1]?.extensions)).toBe(true);
  });

  it("detects exact filenames, longest extensions, registration-order ties, and shebangs", () => {
    expect(detectMonacoLanguage("/workspace/Dockerfile", "", definitions)).toBe("dockerfile");
    expect(detectMonacoLanguage("C:\\repo\\GEMFILE", "", definitions)).toBe("ruby");
    expect(detectMonacoLanguage("email.HTML.LIQUID", "", definitions)).toBe("liquid");
    expect(detectMonacoLanguage("module.pp", "", definitions)).toBe("ruby");
    expect(detectMonacoLanguage("script", "\uFEFF#!/usr/bin/env python3\nprint('ready')", definitions)).toBe("python");
    expect(detectMonacoLanguage("README", "plain text", definitions)).toBeUndefined();
  });

  it("returns the preferred model extension without its leading dot", () => {
    expect(preferredMonacoExtension("python", definitions)).toBe("py");
    expect(preferredMonacoExtension("broken", definitions)).toBeUndefined();
    expect(preferredMonacoExtension("missing", definitions)).toBeUndefined();
  });
});
