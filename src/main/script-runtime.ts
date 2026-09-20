import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import type { ScriptRuntimeAsset } from "../shared/script-contracts.js";

export const QUICKJS_VERSION = "0.32.0";
export const QUICKJS_WASM_SHA256 = "105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232";
export const QUICKJS_WASM_BYTES = 503134;
const require = createRequire(import.meta.url);
let cached: Uint8Array | undefined;

/** Fixed packaged asset only. No renderer-controlled path, URL or runtime variant. */
export async function loadScriptRuntime(): Promise<ScriptRuntimeAsset> {
  if (!cached) {
    const bytes = await readFile(require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"));
    if (bytes.byteLength !== QUICKJS_WASM_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== QUICKJS_WASM_SHA256) {
      throw new Error("The packaged script runtime failed its integrity check");
    }
    cached = Uint8Array.from(bytes);
  }
  return { version: QUICKJS_VERSION, sha256: QUICKJS_WASM_SHA256, bytes: Uint8Array.from(cached) };
}
