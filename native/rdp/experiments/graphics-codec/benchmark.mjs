import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const [wasmPath, fixtureDirectory] = process.argv.slice(2);
if (!wasmPath || !fixtureDirectory) throw new Error("Usage: node benchmark.mjs <module.wasm> <fixture-directory>");
const wasm = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasm, {});
const { memory, prepare_input, decode, output_ptr, output_len } = instance.exports;
const cases = JSON.parse(await readFile(`${fixtureDirectory}/fixtures.json`, "utf8"));
const results = [];
const percentile = (values, percent) => [...values].sort((a, b) => a - b)[Math.floor(values.length * percent)];
for (const test of cases) {
  const bytes = await readFile(`${fixtureDirectory}/${test.file}`);
  const offset = prepare_input(bytes.length);
  if (!offset) throw new Error("Input rejected");
  new Uint8Array(memory.buffer, offset, bytes.length).set(bytes);
  const decodeTimings = [], copyTimings = [];
  for (let i = 0; i < test.iterations + 10; i++) {
    let start = performance.now();
    if (decode(test.width, test.height) !== 1) throw new Error("Decode failed");
    const decodeMs = performance.now() - start;
    start = performance.now();
    // Copying the output out of WASM is a real boundary cost; canvas/GPU/IPC remain unmeasured.
    const copy = new Uint8Array(memory.buffer, output_ptr(), output_len()).slice();
    const copyMs = performance.now() - start;
    if (i === 0 && createHash("sha256").update(copy).digest("hex") !== test.sha256) throw new Error("Native/WASM pixel mismatch");
    if (i >= 10) { decodeTimings.push(decodeMs); copyTimings.push(copyMs); }
  }
  results.push({ ...test, wasmDecodeP50Ms: percentile(decodeTimings, 0.5), wasmDecodeP95Ms: percentile(decodeTimings, 0.95), wasmOutputCopyP50Ms: percentile(copyTimings, 0.5), wasmOutputCopyP95Ms: percentile(copyTimings, 0.95), wasmLinearMemoryBytes: memory.buffer.byteLength, pixelEquality: true });
}
if (prepare_input(17 * 1024 * 1024) !== 0 || decode(8192, 8192) !== 0) throw new Error("Resource limits failed");
const invalid = prepare_input(1);
new Uint8Array(memory.buffer, invalid, 1)[0] = 0xff;
if (decode(1, 1) !== 0) throw new Error("Malformed stream was accepted");
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, wasmBytes: wasm.length, wasmSha256: createHash("sha256").update(wasm).digest("hex"), limitsAndMalformedInput: true, results }, null, 2));
