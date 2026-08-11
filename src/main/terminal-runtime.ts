import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export const GHOSTTY_WEB_VERSION = "0.4.0" as const;
export const GHOSTTY_WASM_SHA256 = "d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a" as const;
export const GHOSTTY_WASM_BYTES = 423_045;

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const require = createRequire(import.meta.url);
let cachedRuntime: Buffer | undefined;

export interface TerminalRuntimeAsset {
  version: typeof GHOSTTY_WEB_VERSION;
  sha256: typeof GHOSTTY_WASM_SHA256;
  bytes: Uint8Array;
}

/**
 * Read the one reviewed Ghostty Web runtime from the packaged dependency.
 * Renderer code never selects a path or fetches a network/data URL.
 */
export async function loadTerminalRuntime(): Promise<TerminalRuntimeAsset> {
  const source = cachedRuntime ?? await readAndVerifyRuntime();
  cachedRuntime = source;
  return {
    version: GHOSTTY_WEB_VERSION,
    sha256: GHOSTTY_WASM_SHA256,
    bytes: Uint8Array.from(source),
  };
}

async function readAndVerifyRuntime(): Promise<Buffer> {
  const runtimePath = require.resolve("ghostty-web/ghostty-vt.wasm");
  const bytes = await readFile(runtimePath);
  if (
    bytes.byteLength !== GHOSTTY_WASM_BYTES ||
    !bytes.subarray(0, WASM_MAGIC.byteLength).equals(WASM_MAGIC) ||
    createHash("sha256").update(bytes).digest("hex") !== GHOSTTY_WASM_SHA256
  ) {
    bytes.fill(0);
    throw new Error("The packaged terminal runtime failed its integrity check");
  }
  return bytes;
}

export function clearTerminalRuntimeCacheForTests(): void {
  cachedRuntime?.fill(0);
  cachedRuntime = undefined;
}
