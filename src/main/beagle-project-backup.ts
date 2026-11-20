import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, unlink, type FileHandle } from "node:fs/promises";
import { BEAGLE_STORAGE_LIMITS } from "../shared/beagle-projects.js";

const MAGIC = Buffer.from("SLIVER-BEAGLE-PROJECT\x00\x01", "binary");
const SQLITE = Buffer.from("SQLite format 3\x00", "binary");
const CHUNK = 1024 * 1024;

async function regular(path: string): Promise<FileHandle> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Project input must be a regular file");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const after = await file.stat();
  if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino) { await file.close(); throw new Error("Project input changed while opening"); }
  return file;
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("AD Explorer operation cancelled"); }
async function readExact(file: FileHandle, bytes: number, offset: number): Promise<Buffer> {
  const data = Buffer.alloc(bytes);
  let read = 0;
  while (read < bytes) {
    const result = await file.read(data, read, bytes - read, offset + read);
    if (!result.bytesRead) throw new Error("Truncated project backup");
    read += result.bytesRead;
  }
  return data;
}
export async function hashBeagleFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  const file = await regular(path);
  try {
    const before = await file.stat();
    if (before.size > maxBytes) throw new Error(`File exceeds the supported ${Math.floor(maxBytes / 1024 / 1024)} MiB limit`);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK);
    for (let offset = 0; offset < before.size;) {
      cancelled(signal);
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("File changed while reading");
      hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("File changed while reading");
    return { sha256: hash.digest("hex"), bytes: before.size };
  } finally { await file.close(); }
}

/** A bounded JSON manifest followed by streamed SQLite bytes; no base64 or graph-sized IPC. */
export async function writeBeagleBackup(path: string, database: string, metadata: unknown, signal?: AbortSignal): Promise<void> {
  const identity = await hashBeagleFile(database, BEAGLE_STORAGE_LIMITS.backupDatabaseBytes, signal);
  const manifest = Buffer.from(JSON.stringify({ format: "sliver-beagle-project", version: 1, database: identity, metadata }));
  if (manifest.length > BEAGLE_STORAGE_LIMITS.backupMetadataBytes) throw new Error("Project metadata exceeds the backup limit");
  const input = await regular(database);
  let output: FileHandle | undefined;
  let complete = false;
  try {
    if (!(await readExact(input, SQLITE.length, 0)).equals(SQLITE)) throw new Error("Invalid project database");
    output = await open(path, "wx", 0o600);
    const length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
    await output.writeFile(Buffer.concat([MAGIC, length, manifest]));
    const buffer = Buffer.alloc(CHUNK);
    const copiedHash = createHash("sha256");
    for (let offset = 0; offset < identity.bytes;) {
      cancelled(signal);
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, identity.bytes - offset), offset);
      if (!bytesRead) throw new Error("Project database changed during backup");
      copiedHash.update(buffer.subarray(0, bytesRead));
      await output.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (copiedHash.digest("hex") !== identity.sha256 || (await input.stat()).size !== identity.bytes) throw new Error("Project database changed during backup");
    await output.sync(); complete = true;
  } finally {
    await input.close(); await output?.close();
    if (output && !complete) await unlink(path).catch(() => undefined);
  }
}

export async function readBeagleBackup(path: string, database: string, signal?: AbortSignal): Promise<unknown> {
  const input = await regular(path);
  let output: FileHandle | undefined;
  let complete = false;
  try {
    const size = (await input.stat()).size;
    if (size > BEAGLE_STORAGE_LIMITS.backupDatabaseBytes + BEAGLE_STORAGE_LIMITS.backupMetadataBytes + 128) throw new Error("Project backup exceeds its supported size");
    if (!(await readExact(input, MAGIC.length, 0)).equals(MAGIC)) throw new Error("Not a supported Beagle project backup");
    const length = (await readExact(input, 4, MAGIC.length)).readUInt32BE();
    if (length > BEAGLE_STORAGE_LIMITS.backupMetadataBytes) throw new Error("Project backup metadata exceeds its limit");
    const manifest = JSON.parse((await readExact(input, length, MAGIC.length + 4)).toString("utf8")) as Record<string, unknown>;
    const identity = manifest["database"] as { sha256?: unknown; bytes?: unknown } | undefined;
    if (manifest["format"] !== "sliver-beagle-project" || manifest["version"] !== 1 || !identity || typeof identity.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(identity.sha256) ||
      typeof identity.bytes !== "number" || !Number.isSafeInteger(identity.bytes) || identity.bytes < SQLITE.length || identity.bytes > BEAGLE_STORAGE_LIMITS.backupDatabaseBytes) throw new Error("Invalid project backup manifest");
    const start = MAGIC.length + 4 + length;
    if (start + identity.bytes !== size || !(await readExact(input, SQLITE.length, start)).equals(SQLITE)) throw new Error("Project backup database size or format is invalid");
    output = await open(database, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(CHUNK);
    for (let offset = 0; offset < identity.bytes;) {
      cancelled(signal);
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, identity.bytes - offset), start + offset);
      if (!bytesRead) throw new Error("Truncated project backup database");
      hash.update(buffer.subarray(0, bytesRead));
      await output.writeFile(buffer.subarray(0, bytesRead)); offset += bytesRead;
    }
    if (hash.digest("hex") !== identity.sha256) throw new Error("Project backup checksum mismatch");
    await output.sync(); complete = true;
    return manifest["metadata"];
  } finally {
    await input.close(); await output?.close();
    if (output && !complete) await unlink(database).catch(() => undefined);
  }
}
