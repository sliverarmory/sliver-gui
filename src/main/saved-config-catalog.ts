import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { parseConfig } from "sliver-script";

import type { SavedConfigOrigin, SavedConfigSummary } from "../shared/contracts.js";
import { readBoundedRegularFile } from "./secure-file.js";

export const MAX_SAVED_CONFIG_BYTES = 4 * 1024 * 1024;

const MAX_METADATA_LENGTH = 200;
const UNSAFE_DISPLAY_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/** Main-process-only catalog entry. Paths and content fingerprints never cross IPC. */
export interface SavedConfigRecord {
  readonly path: string;
  readonly digest: string;
  readonly summary: SavedConfigSummary;
  readonly importedId?: string;
}

export async function discoverSavedConfigs(
  directory: string,
): Promise<SavedConfigRecord[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const discovered: Array<SavedConfigRecord & { sortName: string }> = [];
  for (const entry of entries) {
    // Dirent.isFile() excludes directories, sockets, named pipes, and symlinks.
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      discovered.push({ ...await readSavedConfigRecord(path, "preexisting"), sortName: entry.name });
    } catch {
      // A single invalid, unreadable, changed, or oversized entry must not hide valid configs.
    }
  }

  discovered.sort(
    (left, right) =>
      right.summary.modifiedAt.localeCompare(left.summary.modifiedAt) ||
      compareNames(left.summary.fileName, right.summary.fileName) ||
      compareNames(left.sortName, right.sortName),
  );
  return discovered.map(({ sortName: _sortName, ...record }) => record);
}

export async function readSavedConfigRecord(
  path: string,
  origin: SavedConfigOrigin,
  requestedDisplayName?: string,
): Promise<SavedConfigRecord> {
  const loaded = await readBoundedRegularFile(path, {
    label: "Saved configuration",
    maxBytes: MAX_SAVED_CONFIG_BYTES,
    requirePrivateMode: origin === "imported",
  });
  try {
    const config = parseConfig(loaded.data);
    if (!Number.isSafeInteger(config.lport) || config.lport < 1 || config.lport > 65_535) {
      throw new Error("Invalid Sliver configuration port");
    }

    const sourceName = basename(path);
    const fileName = sanitizeSavedConfigMetadata(sourceName);
    const withoutExtension = sourceName.slice(0, Math.max(0, sourceName.length - extname(sourceName).length));
    const displayName = sanitizeSavedConfigMetadata(requestedDisplayName ?? (withoutExtension || sourceName));
    const operator = sanitizeSavedConfigMetadata(config.operator);
    const lhost = sanitizeSavedConfigMetadata(config.lhost);
    if (!fileName || !displayName || !operator || !lhost) throw new Error("Invalid Sliver configuration metadata");

    return {
      path,
      digest: createHash("sha256").update(loaded.data).digest("hex"),
      summary: {
        id: randomUUID(),
        fileName,
        displayName,
        operator,
        lhost,
        lport: config.lport,
        transport: config.wg === undefined ? "mtls" : "wireguard",
        modifiedAt: new Date(loaded.modifiedAtMs).toISOString(),
        origin,
        removal: "detach",
        availability: config.wg === undefined ? "available" : "deferred",
        ...(config.wg === undefined
          ? {}
          : { unavailableReason: "WireGuard operator connections are deferred for this milestone" }),
      },
    };
  } finally {
    loaded.data.fill(0);
  }
}

export async function readCurrentSavedConfig(record: SavedConfigRecord): Promise<Buffer> {
  const { data } = await readBoundedRegularFile(record.path, {
    label: "Saved configuration",
    maxBytes: MAX_SAVED_CONFIG_BYTES,
    requirePrivateMode: record.summary.origin === "imported",
  });
  const digest = createHash("sha256").update(data).digest("hex");
  if (digest !== record.digest) {
    data.fill(0);
    throw new Error("Saved configuration changed after the catalog was refreshed");
  }
  return data;
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
