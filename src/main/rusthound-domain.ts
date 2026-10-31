import { crc32, inflateRawSync } from "node:zlib";

import { parseAdDomain } from "../shared/ad-explorer-contracts.js";
import { isCompleteZipEnvelope } from "./ad-collector.js";

const MAX_DOMAIN_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

/** Read only bounded domain metadata, without extracting paths or expanding the rest of the collection. */
export function collectedRustHoundDomain(archive: Buffer, expectedDomain?: string): string {
  const invalid = (): never => { throw new Error("RustHound returned invalid domain metadata in its collection ZIP"); };
  if (archive.length > MAX_ARCHIVE_BYTES || !isCompleteZipEnvelope(archive)) invalid();
  let end = archive.length - 22;
  while (end >= Math.max(0, archive.length - 65_557)) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
    end--;
  }
  if (end < 0) invalid();
  const entries = archive.readUInt16LE(end + 10);
  const centralStart = archive.readUInt32LE(end + 16);
  let cursor = centralStart;
  let domainFile: Buffer | undefined;
  try {
    for (let index = 0; index < entries; index++) {
      const nameBytes = archive.readUInt16LE(cursor + 28);
      const extraBytes = archive.readUInt16LE(cursor + 30);
      const name = new TextDecoder("utf-8", { fatal: true }).decode(archive.subarray(cursor + 46, cursor + 46 + nameBytes));
      const next = cursor + 46 + nameBytes + extraBytes + archive.readUInt16LE(cursor + 32);
      if (/(?:^|_)domains\.json$/iu.test(name)) {
        if (domainFile || name.includes("/") || name.includes("\\") || /[\x00-\x1f\x7f]/u.test(name)) invalid();
        const flags = archive.readUInt16LE(cursor + 8);
        const method = archive.readUInt16LE(cursor + 10);
        if ((flags & ~0x0808) !== 0 || (method !== 0 && method !== 8)) invalid();
        const sizes = zip64Entry(archive, cursor, nameBytes, extraBytes, invalid);
        if (sizes.expanded < 1 || sizes.expanded > MAX_DOMAIN_JSON_BYTES || sizes.compressed > MAX_ARCHIVE_BYTES) invalid();
        const local = sizes.local;
        if (local + 30 > centralStart || archive.readUInt16LE(local + 6) !== flags || archive.readUInt16LE(local + 8) !== method) invalid();
        const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        if (start + sizes.compressed > centralStart) invalid();
        const compressed = archive.subarray(start, start + sizes.compressed);
        domainFile = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_DOMAIN_JSON_BYTES });
        if (domainFile.length !== sizes.expanded || crc32(domainFile) !== archive.readUInt32LE(cursor + 16)) invalid();
      }
      cursor = next;
    }
    if (!domainFile) invalid();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(domainFile));
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    const document = value as Record<string, unknown>;
    const meta = document["meta"];
    if (!meta || typeof meta !== "object" || Array.isArray(meta) ||
        (meta as Record<string, unknown>)["type"] !== "domains" ||
        ![5, 6].includes((meta as Record<string, unknown>)["version"] as number) || !Array.isArray(document["data"])) invalid();
    const domains = new Set<string>();
    for (const item of document["data"] as unknown[]) {
      if (!item || typeof item !== "object" || Array.isArray(item)) invalid();
      const properties = (item as Record<string, unknown>)["Properties"];
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) invalid();
      const fields = properties as Record<string, unknown>;
      // Trust stubs include valid DNS names too. Only actual collected domain
      // records establish which directory produced this archive.
      if (fields["collected"] !== true) continue;
      const domain = parseAdDomain(fields["domain"]);
      if (parseAdDomain(fields["name"]) !== domain) invalid();
      domains.add(domain);
    }
    if (expectedDomain) {
      const expected = parseAdDomain(expectedDomain);
      if (!domains.has(expected)) throw new Error("RustHound collected a different AD domain. Confirm the selected domain and try again.");
      return expected;
    }
    if (domains.size !== 1) throw new Error("RustHound could not identify one collected AD domain. Enter the AD DNS domain and try again.");
    return domains.values().next().value!;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("RustHound ")) throw error;
    return invalid();
  } finally { domainFile?.fill(0); }
}

function zip64Entry(archive: Buffer, cursor: number, nameBytes: number, extraBytes: number, invalid: () => never):
  { expanded: number; compressed: number; local: number } {
  let expanded = archive.readUInt32LE(cursor + 24);
  let compressed = archive.readUInt32LE(cursor + 20);
  let local = archive.readUInt32LE(cursor + 42);
  if ([expanded, compressed, local].every((value) => value !== 0xffffffff)) return { expanded, compressed, local };
  let field = cursor + 46 + nameBytes;
  const end = field + extraBytes;
  while (field + 4 <= end) {
    const kind = archive.readUInt16LE(field), length = archive.readUInt16LE(field + 2);
    const dataEnd = field + 4 + length;
    if (dataEnd > end) invalid();
    if (kind === 1) {
      let at = field + 4;
      const next = (): number => {
        if (at + 8 > dataEnd) return invalid();
        const value = archive.readBigUInt64LE(at); at += 8;
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) return invalid();
        return Number(value);
      };
      if (expanded === 0xffffffff) expanded = next();
      if (compressed === 0xffffffff) compressed = next();
      if (local === 0xffffffff) local = next();
      return { expanded, compressed, local };
    }
    field = dataEnd;
  }
  return invalid();
}
