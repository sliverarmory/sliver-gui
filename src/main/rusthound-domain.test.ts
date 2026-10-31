// @vitest-environment node
import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { collectedRustHoundDomain } from "./rusthound-domain.js";

const domain = (name: string, collected = true) => ({ Properties: { name, domain: name, collected } });
const document = (data = [domain("EXAMPLE.LOCAL"), domain("TRUST.LOCAL", false)]) => JSON.stringify({
  meta: { type: "domains", count: data.length, version: 6 }, data,
});

function archive(entries: { contents: string; name?: string; zip64?: boolean; expanded?: number; flags?: number; crc?: number }[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name ?? "20261024_example-local_domains.json");
    const contents = Buffer.from(entry.contents), data = deflateRawSync(contents);
    const expanded = entry.expanded ?? contents.length;
    const extra = entry.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (entry.zip64) {
      extra.writeUInt16LE(1); extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(expanded), 4); extra.writeBigUInt64LE(BigInt(data.length), 12);
    }
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(45, 4); header.writeUInt16LE(entry.flags ?? 0, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(entry.crc ?? crc32(contents), 14); header.writeUInt32LE(entry.zip64 ? 0xffffffff : data.length, 18);
    header.writeUInt32LE(entry.zip64 ? 0xffffffff : expanded, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(extra.length, 28);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(45, 6); directory.writeUInt16LE(entry.flags ?? 0, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(entry.crc ?? crc32(contents), 16); directory.writeUInt32LE(entry.zip64 ? 0xffffffff : data.length, 20);
    directory.writeUInt32LE(entry.zip64 ? 0xffffffff : expanded, 24); directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(extra.length, 30); directory.writeUInt32LE(offset, 42);
    local.push(header, name, extra, data); central.push(directory, name, extra);
    offset += header.length + name.length + extra.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("RustHound collected domain", () => {
  it.each([false, true])("finds the collected domain and ignores trust stubs (ZIP64=%s)", (zip64) => {
    const zip = archive([{ contents: document(), zip64 }]);
    const before = Buffer.from(zip);
    expect(collectedRustHoundDomain(zip)).toBe("example.local");
    expect(collectedRustHoundDomain(zip, "EXAMPLE.LOCAL")).toBe("example.local");
    expect(zip).toEqual(before);
    expect(() => collectedRustHoundDomain(zip, "trust.local")).toThrow(/different AD domain/u);
  });

  it("requires an explicit collected domain when the archive has multiple collected domains", () => {
    const zip = archive([{ contents: document([domain("ONE.LOCAL"), domain("TWO.LOCAL")]) }]);
    expect(() => collectedRustHoundDomain(zip)).toThrow(/identify one collected AD domain/u);
    expect(collectedRustHoundDomain(zip, "two.local")).toBe("two.local");
  });

  it.each([
    { contents: document(), expanded: 5 * 1024 * 1024 },
    { contents: document(), crc: 0 },
    { contents: document(), flags: 1 },
    { contents: document(), name: "../domains.json" },
    { contents: "{not json}" },
    { contents: JSON.stringify({ meta: { type: "users", version: 6 }, data: [] }) },
    { contents: document([domain("../escape.local")]) },
    { contents: document([domain("ONE.LOCAL", false)]) },
  ])("rejects invalid or unbounded domain metadata: %j", (entry) => {
    expect(() => collectedRustHoundDomain(archive([entry]))).toThrow(/RustHound/u);
  });

  it("rejects duplicate domain documents, even if they agree", () => {
    expect(() => collectedRustHoundDomain(archive([
      { contents: document() }, { contents: document(), name: "other_domains.json" },
    ]))).toThrow(/invalid domain metadata/u);
  });
});
