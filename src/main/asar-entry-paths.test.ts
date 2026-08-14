// @vitest-environment node

import { describe, expect, it } from "vitest";

import { asarEntryPaths } from "../../scripts/asarEntryPaths.mjs";

describe("ASAR entry paths", () => {
  it("keeps POSIX paths usable for archive lookup", () => {
    expect(asarEntryPaths("/node_modules/ghostty-web/ghostty-vt.wasm")).toEqual({
      lookupPath: "node_modules/ghostty-web/ghostty-vt.wasm",
      normalizedPath: "node_modules/ghostty-web/ghostty-vt.wasm",
    });
  });

  it("keeps Windows separators for lookup while normalizing comparisons", () => {
    expect(asarEntryPaths("\\node_modules\\ghostty-web\\ghostty-vt.wasm")).toEqual({
      lookupPath: "node_modules\\ghostty-web\\ghostty-vt.wasm",
      normalizedPath: "node_modules/ghostty-web/ghostty-vt.wasm",
    });
  });
});
