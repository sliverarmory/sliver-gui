// @vitest-environment node
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { loadScriptRuntime, QUICKJS_VERSION, QUICKJS_WASM_BYTES, QUICKJS_WASM_SHA256 } from "./script-runtime.js";

it("loads the pinned QuickJS WASM and returns independent bytes to each caller", async () => {
  const asset = await loadScriptRuntime();
  expect(asset.version).toBe(QUICKJS_VERSION);
  expect(asset.bytes.byteLength).toBe(QUICKJS_WASM_BYTES);
  expect(createHash("sha256").update(asset.bytes).digest("hex")).toBe(QUICKJS_WASM_SHA256);
  asset.bytes.fill(0);
  expect(createHash("sha256").update((await loadScriptRuntime()).bytes).digest("hex")).toBe(QUICKJS_WASM_SHA256);
});
