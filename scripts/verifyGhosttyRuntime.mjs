import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(await readFile(join(root, "protocol/ghostty-web-provenance.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const manifest = JSON.parse(await readFile(join(root, "node_modules/ghostty-web/package.json"), "utf8"));
const runtime = await readFile(join(root, provenance.runtime.path));
const locked = lock.packages?.["node_modules/ghostty-web"];

assertEqual(manifest.name, provenance.package.name, "installed package name");
assertEqual(manifest.version, provenance.package.version, "installed package version");
assertEqual(manifest.license, provenance.package.license, "installed package license");
assertEqual(locked?.version, provenance.package.version, "lockfile package version");
assertEqual(locked?.integrity, provenance.package.npmIntegrity, "lockfile package integrity");
assertEqual(runtime.byteLength, provenance.runtime.bytes, "WASM byte length");
assertEqual(createHash("sha256").update(runtime).digest("hex"), provenance.runtime.sha256, "WASM SHA-256");

if (!runtime.subarray(0, 4).equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
  throw new Error("Ghostty runtime does not have a WebAssembly header");
}

console.log(
  `Verified ${manifest.name}@${manifest.version} runtime (${runtime.byteLength} bytes, ${provenance.runtime.sha256})`,
);

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} mismatch: expected ${expected}, received ${actual}`);
}
