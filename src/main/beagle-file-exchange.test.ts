// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { BEAGLE_RESULT_LIMITS, type BeagleQueryResult } from "../shared/beagle-contracts.js";
import { parseBeagleResultExportInput, readBeagleQueries, serializeBeagleQueries, serializeBeagleResult } from "./beagle-file-exchange.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function file(data: Buffer | string): Promise<string> { const root = await mkdtemp(join(tmpdir(), "beagle-exchange-")); directories.push(root); const path = join(root, "queries"); await writeFile(path, data); return path; }
function archive(entries: { name: string; contents: string; method?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name), contents = Buffer.from(entry.contents), method = entry.method ?? 8;
    const compressed = method === 8 ? deflateRawSync(contents) : contents;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc32(contents), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(contents.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc32(contents), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(contents.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(directory, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const query = (name = "Test") => JSON.stringify({ name, description: "portable", query: "RETURN $value AS value", parameters: { value: 1 } });

describe("query file exchange", () => {
  it("reads local lossless libraries and CE single-query JSON", async () => {
    const ce = await readBeagleQueries(await file(query())); expect(ce[0]).toMatchObject({ name: "Test", cypher: "RETURN $value AS value", parameters: '{"value":1}' });
    const local = await readBeagleQueries(await file(JSON.stringify({ version: 1, queries: ce })));
    expect(local).toEqual(ce);
  });
  it("exports deterministic JSON and per-query ZIP libraries that retain metadata and parameters", async () => {
    const queries = await readBeagleQueries(await file(query()));
    for (const format of ["json", "zip"] as const) {
      const encoded = serializeBeagleQueries(queries, format);
      expect(serializeBeagleQueries(queries, format)).toEqual(encoded);
      const restored = await readBeagleQueries(await file(encoded));
      expect(restored.map(({ id: _id, ...entry }) => entry)).toEqual(queries.map(({ id: _id, ...entry }) => entry));
      expect(await readBeagleQueries(await file(serializeBeagleQueries([], format)))).toEqual([]);
    }
  });
  it("reads stored and deflated CE query ZIPs without colliding generated IDs", async () => {
    const result = await readBeagleQueries(await file(archive([{ name: "a.json", contents: query("First"), method: 0 }, { name: "folder/b.json", contents: query("Second") }])));
    expect(result.map((entry) => entry.name)).toEqual(["First", "Second"]); expect(new Set(result.map((entry) => entry.id)).size).toBe(2);
  });
  it.each(["../escape.json", "/absolute.json", "folder\\escape.json", "data.exe"])("rejects unsupported archive entry %s", async (name) => {
    await expect(readBeagleQueries(await file(archive([{ name, contents: query() }])))).rejects.toThrow(/ZIP/u);
  });
  it("checks CRC, local and central agreement, duplicate names and truncated archives", async () => {
    const good = archive([{ name: "a.json", contents: query(), method: 0 }]);
    const corrupt = Buffer.from(good); corrupt[36] = corrupt[36]! ^ 1;
    await expect(readBeagleQueries(await file(corrupt))).rejects.toThrow(/ZIP/u);
    await expect(readBeagleQueries(await file(good.subarray(0, good.length - 1)))).rejects.toThrow(/ZIP/u);
    await expect(readBeagleQueries(await file(archive([{ name: "a.json", contents: query() }, { name: "a.json", contents: query() }])))).rejects.toThrow(/ZIP/u);
  });
  it("rejects a highly compressed archive exceeding its decompressed budget", async () => {
    const bomb = archive([{ name: "large.json", contents: "x".repeat(16 * 1024 * 1024 + 1) }]);
    expect(bomb.length).toBeLessThan(32_000);
    await expect(readBeagleQueries(await file(bomb))).rejects.toThrow(/16 MiB/u);
  });
});

const result = (rows: BeagleQueryResult["rows"]): BeagleQueryResult => ({ projectId: "11111111-1111-4111-8111-111111111111", columns: ["name", "value"], rows, graph: { nodes: [], edges: [] }, totalRows: rows.length, truncated: false, elapsedMs: 0, limits: { ...BEAGLE_RESULT_LIMITS } });
describe("result export", () => {
  it("quotes delimiters, protects only string formulas and preserves numeric negatives", () => {
    const csv = serializeBeagleResult({ format: "csv", title: "Test", result: result([{ name: '=HYPERLINK("bad")', value: -42 }, { name: 'x,"y"\nnext', value: '  +1' }]) }).toString();
    expect(csv).toBe('"name","value"\r\n"\'=HYPERLINK(""bad"")","-42"\r\n"x,""y""\nnext","\'  +1"\r\n');
  });
  it("matches stable numeric table sorting with nulls last in both directions", () => {
    const rows = [{ name: "ten", value: 10 }, { name: "first-two", value: 2 }, { name: "null", value: null }, { name: "second-two", value: 2 }];
    const exported = JSON.parse(serializeBeagleResult({ format: "json", title: "Test", result: result(rows), columns: ["name"], sort: { column: "value", direction: "desc" } }).toString());
    expect(exported.result.rows).toEqual([{ name: "ten" }, { name: "first-two" }, { name: "second-two" }, { name: "null" }]);
    expect(exported.result.columns).toEqual(["name"]);
  });
  it("rejects unknown columns, malformed snapshots and additional export instructions", () => {
    const input = { format: "csv", title: "Test", result: result([]) };
    expect(() => parseBeagleResultExportInput({ ...input, columns: ["unknown"] })).toThrow();
    expect(() => parseBeagleResultExportInput({ ...input, result: {} })).toThrow();
    expect(() => parseBeagleResultExportInput({ ...input, path: "/tmp/arbitrary" })).toThrow();
  });
});
