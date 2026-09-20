// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  SCRIPT_LIMITS,
  parseCreateScriptInput,
  parseDeleteScriptInput,
  parseExportScriptInput,
  parseReadScriptInput,
  parseRenameScriptInput,
  parseSaveScriptInput,
  parseScriptSource,
} from "./script-contracts.js";

const id = "22222222-2222-4222-8222-222222222222";
const revision = "a".repeat(64);

describe("script capability contracts", () => {
  it("accepts exactly the purpose-built fields and display names never become paths", () => {
    expect(parseCreateScriptInput({ name: "  ../display name  ", source: "" })).toEqual({ name: "../display name", source: "" });
    expect(parseReadScriptInput({ id })).toEqual({ id });
    expect(parseSaveScriptInput({ id, source: "1", expectedRevision: revision })).toEqual({ id, source: "1", expectedRevision: revision });
    expect(parseRenameScriptInput({ id, name: "Renamed", expectedRevision: revision })).toEqual({ id, name: "Renamed", expectedRevision: revision });
    expect(parseDeleteScriptInput({ id, expectedRevision: revision })).toEqual({ id, expectedRevision: revision });
    expect(parseExportScriptInput({ name: "Snapshot", source: "unsaved" })).toEqual({ name: "Snapshot", source: "unsaved" });
    expect(() => parseReadScriptInput({ id, filename: "outside.js" })).toThrow();
    expect(() => parseCreateScriptInput({ name: "Valid", source: "", run: true })).toThrow();
    expect(() => parseExportScriptInput({ name: "Valid", source: "", path: "/tmp/output.js" })).toThrow();
    expect(() => parseExportScriptInput({ name: "Valid", source: "x".repeat(SCRIPT_LIMITS.sourceBytes + 1) })).toThrow();
    expect(() => parseReadScriptInput({ id: "../../outside.js" })).toThrow();
    expect(() => parseDeleteScriptInput({ id, expectedRevision: "old" })).toThrow();
  });

  it("bounds UTF-8 bytes, preserves a BOM and rejects malformed Unicode without silently rewriting source", () => {
    expect(parseScriptSource("x".repeat(SCRIPT_LIMITS.sourceBytes))).toHaveLength(SCRIPT_LIMITS.sourceBytes);
    expect(parseScriptSource("\ufeffconsole.log('hello');")).toBe("\ufeffconsole.log('hello');");
    expect(parseScriptSource("😀".repeat(SCRIPT_LIMITS.sourceBytes / 4))).toHaveLength(SCRIPT_LIMITS.sourceBytes / 2);
    expect(() => parseScriptSource("😀".repeat(SCRIPT_LIMITS.sourceBytes / 4 + 1))).toThrow(/512 KiB/u);
    expect(() => parseScriptSource("\ud800")).toThrow(/valid UTF-8/u);
    expect(() => parseCreateScriptInput({ name: "x".repeat(201), source: "" })).toThrow(/200/u);
  });
});
