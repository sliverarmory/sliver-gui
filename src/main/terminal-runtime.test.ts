// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearTerminalRuntimeCacheForTests,
  GHOSTTY_WASM_BYTES,
  GHOSTTY_WASM_SHA256,
  GHOSTTY_WEB_VERSION,
  loadTerminalRuntime,
} from "./terminal-runtime.js";

afterEach(() => clearTerminalRuntimeCacheForTests());

describe("packaged Ghostty Web runtime", () => {
  it("loads only the pinned local WASM asset and returns independent copies", async () => {
    const first = await loadTerminalRuntime();
    const second = await loadTerminalRuntime();

    expect(first.version).toBe(GHOSTTY_WEB_VERSION);
    expect(first.sha256).toBe(GHOSTTY_WASM_SHA256);
    expect(first.bytes).toHaveLength(GHOSTTY_WASM_BYTES);
    expect(createHash("sha256").update(first.bytes).digest("hex")).toBe(GHOSTTY_WASM_SHA256);
    expect(first.bytes).not.toBe(second.bytes);

    first.bytes.fill(0);
    expect(createHash("sha256").update(second.bytes).digest("hex")).toBe(GHOSTTY_WASM_SHA256);
  });
});
