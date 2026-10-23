import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { type BeagleJsonObject, type BeagleJsonValue, type BeagleAPI } from "../shared/beagle-contracts.js";
import { BEAGLE_CUSTOM_QUERY_LIMIT, parseBeagleCustomQueries, parseBeaglePortableQueries, exportBeaglePortableQueries, type BeagleCustomQuery } from "../shared/beagle-workspace.js";
import { parseBeagleExportResultInput } from "../shared/beagle-workspace-inputs.js";
import { readBoundedRegularFile } from "./secure-file.js";

const MAX_BYTES = 16 * 1024 * 1024;
export type BeagleResultExportInput = Parameters<BeagleAPI["exportResult"]>[0];
const decode = (data: Buffer): unknown => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));

/** Read CE's JSON/ZIP query export without extracting any archive paths. */
export async function readBeagleQueries(path: string): Promise<BeagleCustomQuery[]> {
  const { data } = await readBoundedRegularFile(path, { label: "Query library", maxBytes: MAX_BYTES });
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return parseBeaglePortableQueries(decode(data));
  const queries: BeagleCustomQuery[] = [];
  const entries = queryZipEntries(data);
  if (!entries.length) throw new Error("The archive contains no JSON queries");
  for (const { name, contents } of entries) {
    for (const query of parseBeaglePortableQueries(decode(contents))) {
      // Separate per-file CE exports have no IDs; avoid collisions between the
      // generated IDs while preserving repeatable identities for this archive.
      const id = `zip-${createHash("sha256").update(name).update("\0").update(query.id).digest("hex")}`;
      queries.push({ ...query, id });
      if (queries.length > BEAGLE_CUSTOM_QUERY_LIMIT) throw new Error("Query library exceeds 500 queries");
    }
  }
  return parseBeagleCustomQueries(queries);
}

function queryZipEntries(data: Buffer): { name: string; contents: Buffer }[] {
  const invalid = (): never => { throw new Error("Invalid or unsupported query ZIP archive"); };
  const range = (offset: number, size: number): void => { if (offset < 0 || size < 0 || offset + size > data.length) invalid(); };
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65_557); offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50 && offset + 22 + data.readUInt16LE(offset + 20) === data.length) { end = offset; break; }
  }
  if (end < 0) invalid();
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) invalid();
  const count = data.readUInt16LE(end + 10), directoryBytes = data.readUInt32LE(end + 12), directory = data.readUInt32LE(end + 16);
  if (count !== data.readUInt16LE(end + 8) || count > BEAGLE_CUSTOM_QUERY_LIMIT || directory + directoryBytes !== end) invalid();
  let offset = directory, expanded = 0;
  const names = new Set<string>(), intervals: [number, number][] = [], result: { name: string; contents: Buffer }[] = [];
  for (let index = 0; index < count; index++) {
    range(offset, 46); if (data.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = data.readUInt16LE(offset + 8), method = data.readUInt16LE(offset + 10), expectedCrc = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20), uncompressed = data.readUInt32LE(offset + 24);
    const nameBytes = data.readUInt16LE(offset + 28), extraBytes = data.readUInt16LE(offset + 30), commentBytes = data.readUInt16LE(offset + 32);
    const local = data.readUInt32LE(offset + 42), attributes = data.readUInt32LE(offset + 38);
    range(offset + 46, nameBytes + extraBytes + commentBytes);
    if (flags & ~0x0808 || ![0, 8].includes(method) || data.readUInt16LE(offset + 34) || (attributes >>> 16 & 0o170000) === 0o120000) invalid();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(offset + 46, offset + 46 + nameBytes));
    if (!name || name.length > 1024 || name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === "..") || /[\x00-\x1f\x7f]/u.test(name) || names.has(name)) invalid();
    names.add(name); offset += 46 + nameBytes + extraBytes + commentBytes;
    range(local, 30); if (data.readUInt32LE(local) !== 0x04034b50 || data.readUInt16LE(local + 6) !== flags || data.readUInt16LE(local + 8) !== method) invalid();
    const localNameBytes = data.readUInt16LE(local + 26), localExtraBytes = data.readUInt16LE(local + 28);
    range(local + 30, localNameBytes + localExtraBytes);
    if (!data.subarray(local + 30, local + 30 + localNameBytes).equals(Buffer.from(name, "utf8"))) invalid();
    const start = local + 30 + localNameBytes + localExtraBytes;
    range(start, compressed);
    if (start + compressed > directory || intervals.some(([a, b]) => local < b && start + compressed > a)) invalid();
    intervals.push([local, start + compressed]);
    if (flags & 8 ? false : data.readUInt32LE(local + 14) !== expectedCrc || data.readUInt32LE(local + 18) !== compressed || data.readUInt32LE(local + 22) !== uncompressed) invalid();
    if (uncompressed > MAX_BYTES - expanded) throw new Error("Query ZIP expands beyond 16 MiB");
    const contents = method === 0 ? data.subarray(start, start + compressed) : inflateRawSync(data.subarray(start, start + compressed), { maxOutputLength: Math.max(1, Math.min(uncompressed + 1, MAX_BYTES - expanded + 1)) });
    if (contents.length !== uncompressed || crc32(contents) !== expectedCrc) invalid();
    expanded += contents.length;
    if (name.endsWith("/")) { if (contents.length) invalid(); continue; }
    if (!name.toLowerCase().endsWith(".json")) invalid();
    result.push({ name, contents });
  }
  if (offset !== end) invalid();
  return result;
}

export function parseBeagleResultExportInput(value: unknown): BeagleResultExportInput {
  return parseBeagleExportResultInput(value);
}

/** Deterministic stored ZIP with one CE-compatible JSON document per query. */
export function serializeBeagleQueries(queries: readonly BeagleCustomQuery[], format: "json" | "zip"): Buffer {
  const envelope = exportBeaglePortableQueries(queries);
  const json = Buffer.from(JSON.stringify(envelope) + "\n");
  if (json.length > MAX_BYTES) throw new TypeError("Query library exceeds 16 MiB");
  if (format === "json") return json;
  if (format !== "zip") throw new TypeError("Choose JSON or ZIP query export");
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  const entries = envelope["queries"] as BeagleJsonObject[];
  // An empty library remains importable as a single empty envelope.
  for (const [index, entry] of (entries.length ? entries : [envelope]).entries()) {
    const name = Buffer.from(`query-${String(index + 1).padStart(3, "0")}.json`);
    const contents = Buffer.from(JSON.stringify(entry) + "\n");
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc32(contents), 14);
    header.writeUInt32LE(contents.length, 18); header.writeUInt32LE(contents.length, 22); header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 6); directory.writeUInt32LE(crc32(contents), 16);
    directory.writeUInt32LE(contents.length, 20); directory.writeUInt32LE(contents.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, name, contents); central.push(directory, name); offset += header.length + name.length + contents.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22), count = central.length / 2;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...local, directory, end]);
  if (zip.length > MAX_BYTES) throw new TypeError("Query library exceeds 16 MiB");
  return zip;
}

function display(value: BeagleJsonValue | undefined): string { return value === undefined ? "—" : value === null ? "null" : typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value); }
export function serializeBeagleResult(value: BeagleResultExportInput): Buffer {
  const { format, title, result, columns: chosen, sort } = parseBeagleResultExportInput(value);
  const columns = chosen?.length ? chosen : result.columns.length ? result.columns : [...new Set(result.rows.flatMap((row) => Object.keys(row)))];
  let rows = result.rows;
  if (sort) {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    const compare = (a: BeagleJsonValue | undefined, b: BeagleJsonValue | undefined): number => {
      if (a == null) return b == null ? 0 : 1;
      if (b == null) return -1;
      const order = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(display(a), display(b));
      return sort.direction === "asc" ? order : -order;
    };
    rows = rows.map((row, index) => ({ row, index })).sort((a, b) => compare(a.row[sort.column], b.row[sort.column]) || a.index - b.index).map(({ row }) => row);
  }
  if (format === "json") return encodeResult(JSON.stringify({ version: 1, title, result: { ...result, columns, rows: rows.map((row) => Object.fromEntries(columns.filter((column) => Object.hasOwn(row, column)).map((column) => [column, row[column]])) as BeagleJsonObject) } }) + "\n");
  const cell = (value: BeagleJsonValue | undefined): string => {
    let text = display(value);
    if (typeof value === "string" && /^\s*[=+\-@]/u.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return encodeResult([columns.map(cell).join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\r\n") + "\r\n");
}

function encodeResult(value: string): Buffer {
  if (Buffer.byteLength(value) > 32 * 1024 * 1024) throw new TypeError("Serialized result exceeds 32 MiB");
  return Buffer.from(value);
}
