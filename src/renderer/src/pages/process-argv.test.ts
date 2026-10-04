import { describe, expect, it } from "vitest";

import { parseProcessArgv } from "./process-argv";

describe("parseProcessArgv", () => {
  it("splits on spaces, tabs, and newlines", () => {
    expect(parseProcessArgv(" \tfirst\t second\nthird  ")).toEqual(["first", "second", "third"]);
    expect(parseProcessArgv(" \t\n ")).toEqual([]);
  });

  it("keeps quoted whitespace, concatenated quotes, and empty quoted arguments", () => {
    expect(parseProcessArgv(`alpha "two words" 'three words' pre" middle"' tail' '' "" pre''post`)).toEqual([
      "alpha",
      "two words",
      "three words",
      "pre middle tail",
      "",
      "",
      "prepost",
    ]);
  });

  it("escapes spaces and elides continued newlines outside quotes", () => {
    expect(parseProcessArgv("one\\ two three\\\nfour \\\nfive")).toEqual(["one two", "threefour", "five"]);
    expect(parseProcessArgv("\\\n")).toEqual([]);
  });

  it("applies only the shell-supported escapes inside double quotes", () => {
    expect(parseProcessArgv(String.raw`"C:\Windows\System32" "\$HOME" "\q" "a\\b" "say \"hi\""`)).toEqual([
      String.raw`C:\Windows\System32`,
      "$HOME",
      String.raw`\q`,
      String.raw`a\b`,
      'say "hi"',
    ]);
    expect(parseProcessArgv('"one\\\ntwo"')).toEqual(["onetwo"]);
  });

  it("preserves ordinary Windows path backslashes inside double quotes", () => {
    expect(parseProcessArgv(String.raw`"C:\Program Files\App" C:\Windows`)).toEqual([
      String.raw`C:\Program Files\App`,
      "C:Windows",
    ]);
  });

  it("leaves variables and shell metacharacters literal", () => {
    expect(parseProcessArgv("$HOME *.txt ; | && $(id) '$(whoami)'")).toEqual([
      "$HOME",
      "*.txt",
      ";",
      "|",
      "&&",
      "$(id)",
      "$(whoami)",
    ]);
  });

  it("reports malformed quotes and trailing backslash escapes", () => {
    expect(() => parseProcessArgv("'unfinished")).toThrow(/Unterminated single-quoted argument.*closing/u);
    expect(() => parseProcessArgv('"unfinished')).toThrow(/Unterminated double-quoted argument.*closing/u);
    expect(() => parseProcessArgv("unfinished\\")).toThrow(/backslash escape.*remove it/u);
  });
});
