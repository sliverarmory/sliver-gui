import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

import { parseConfig } from "sliver-script";

import type { SavedConfigSummary } from "../shared/contracts.js";

export const MAX_SAVED_CONFIG_BYTES = 4 * 1024 * 1024;

const MAX_METADATA_LENGTH = 200;
const READ_CHUNK_BYTES = 64 * 1024;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/** Main-process-only catalog entry. Paths and content fingerprints never cross IPC. */
export interface SavedConfigRecord {
  readonly path: string;
  readonly digest: string;
  readonly summary: SavedConfigSummary;
}

export async function discoverSavedConfigs(directory: string): Promise<SavedConfigRecord[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const discovered: Array<SavedConfigRecord & { modifiedAtMs: number; sortName: string }> = [];
  for (const entry of entries) {
    // Dirent.isFile() excludes directories, sockets, named pipes, and symlinks.
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    let data: Buffer | undefined;
    try {
      const loaded = await readBoundedRegularFile(path);
      data = loaded.data;
      const config = parseConfig(data);
      if (!Number.isSafeInteger(config.lport) || config.lport < 1 || config.lport > 65_535) {
        throw new Error("Invalid Sliver configuration port");
      }

      const fileName = sanitizeSavedConfigMetadata(entry.name);
      const withoutExtension = entry.name.slice(0, Math.max(0, entry.name.length - extname(entry.name).length));
      const displayName = sanitizeSavedConfigMetadata(withoutExtension || entry.name);
      const operator = sanitizeSavedConfigMetadata(config.operator);
      const lhost = sanitizeSavedConfigMetadata(config.lhost);
      if (!fileName || !displayName || !operator || !lhost) throw new Error("Invalid Sliver configuration metadata");

      discovered.push({
        path,
        digest: createHash("sha256").update(data).digest("hex"),
        modifiedAtMs: loaded.modifiedAtMs,
        sortName: entry.name,
        summary: {
          id: randomUUID(),
          fileName,
          displayName,
          operator,
          lhost,
          lport: config.lport,
          transport: config.wg === undefined ? "mtls" : "wireguard",
          modifiedAt: new Date(loaded.modifiedAtMs).toISOString(),
        },
      });
    } catch {
      // A single invalid, unreadable, changed, or oversized entry must not hide valid configs.
    } finally {
      data?.fill(0);
    }
  }

  discovered.sort(
    (left, right) =>
      right.modifiedAtMs - left.modifiedAtMs ||
      compareNames(left.summary.fileName, right.summary.fileName) ||
      compareNames(left.sortName, right.sortName),
  );
  return discovered.map(({ modifiedAtMs: _modifiedAtMs, sortName: _sortName, ...record }) => record);
}

export async function readCurrentSavedConfig(record: SavedConfigRecord): Promise<Buffer> {
  const { data } = await readBoundedRegularFile(record.path);
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== record.digest) {
    data.fill(0);
    throw new Error("Saved configuration changed after the catalog was refreshed");
  }
  return data;
}

async function readBoundedRegularFile(path: string): Promise<{ data: Buffer; modifiedAtMs: number }> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_SAVED_CONFIG_BYTES) {
    throw new Error("Saved configuration is not a bounded regular file");
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  const chunks: Buffer[] = [];
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > MAX_SAVED_CONFIG_BYTES ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      throw new Error("Saved configuration changed while being opened");
    }

    let total = 0;
    while (total <= MAX_SAVED_CONFIG_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_SAVED_CONFIG_BYTES + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_SAVED_CONFIG_BYTES) throw new Error("Saved configuration exceeds the size limit");

    const data = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    return { data, modifiedAtMs: opened.mtimeMs };
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

export function sanitizeSavedConfigMetadata(value: string): string {
  const cleaned = value.replace(UNSAFE_DISPLAY_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
  return [...cleaned].slice(0, MAX_METADATA_LENGTH).join("");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function compareNames(left: string, right: string): number {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  if (foldedLeft < foldedRight) return -1;
  if (foldedLeft > foldedRight) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
