import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import type { SavedConfigSummary } from "../shared/contracts.js";
import {
  discoverSavedConfigs,
  MAX_SAVED_CONFIG_BYTES,
  readSavedConfigRecord,
  sanitizeSavedConfigMetadata,
  type SavedConfigRecord,
} from "./saved-config-catalog.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

const MANIFEST_FILE = "operator-configs.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface ConfigManifest {
  version: 2;
  imported: Record<string, { path: string; displayName: string; digest: string }>;
  detachedExternal: string[];
}

export class OperatorConfigStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    readonly externalDirectory: string,
    readonly metadataDirectory: string,
  ) {}

  async list(): Promise<SavedConfigRecord[]> {
    const manifest = await this.loadManifest();
    const [imported, external] = await Promise.all([
      Promise.all(Object.entries(manifest.imported).map(async ([importedId, entry]) => {
        try {
          const record = await readSavedConfigRecord(entry.path, "imported", entry.displayName);
          return record.digest === entry.digest ? { ...record, importedId } : undefined;
        } catch {
          // An unavailable or changed source must not become a selectable imported config.
          return undefined;
        }
      })),
      discoverSavedConfigs(this.externalDirectory),
    ]);
    const availableImported = imported.filter((record) => record !== undefined);
    const importedPaths = new Set(Object.values(manifest.imported).map((entry) => pathFingerprint(entry.path)));
    const detached = new Set(manifest.detachedExternal);
    return [
      ...availableImported,
      ...external.filter((record) => {
        const fingerprint = pathFingerprint(record.path);
        return !detached.has(fingerprint) && !importedPaths.has(fingerprint);
      }),
    ].sort(
      (left, right) =>
        right.summary.modifiedAt.localeCompare(left.summary.modifiedAt) ||
        left.summary.displayName.localeCompare(right.summary.displayName),
    );
  }

  async import(sourcePath: string, requestedDisplayName: string): Promise<SavedConfigRecord> {
    const displayName = sanitizeSavedConfigMetadata(requestedDisplayName);
    if (!displayName || displayName.length > 200) throw new Error("A valid local configuration name is required");
    return this.serializeMutation(async () => {
      const path = resolve(sourcePath);
      const record = await readSavedConfigRecord(path, "imported", displayName);
      const manifest = await this.loadManifest();
      const existing = Object.entries(manifest.imported).find(([, entry]) => entry.path === path);
      const importedId = existing?.[0] ?? randomUUID();
      manifest.imported[importedId] = { path, displayName, digest: record.digest };
      manifest.detachedExternal = manifest.detachedExternal.filter((fingerprint) => fingerprint !== pathFingerprint(path));
      await this.saveManifest(manifest);
      return { ...record, importedId };
    });
  }

  async remove(record: SavedConfigRecord): Promise<void> {
    return this.serializeMutation(async () => {
      const manifest = await this.loadManifest();
      if (record.summary.origin === "imported") {
        const entry = record.importedId ? manifest.imported[record.importedId] : undefined;
        if (!entry || entry.path !== record.path || entry.digest !== record.digest) {
          throw new Error("Imported configuration reference could not be verified");
        }
        delete manifest.imported[record.importedId!];
        const fingerprint = pathFingerprint(record.path);
        if (!manifest.detachedExternal.includes(fingerprint)) manifest.detachedExternal.push(fingerprint);
        await this.saveManifest(manifest);
        return;
      }

      const fingerprint = pathFingerprint(record.path);
      if (!manifest.detachedExternal.includes(fingerprint)) manifest.detachedExternal.push(fingerprint);
      await this.saveManifest(manifest);
    });
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(operation);
    this.mutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async loadManifest(): Promise<ConfigManifest> {
    const path = join(this.metadataDirectory, MANIFEST_FILE);
    try {
      const loaded = await readBoundedRegularFile(path, {
        label: "Configuration manifest",
        maxBytes: MAX_MANIFEST_BYTES,
        requirePrivateMode: true,
      });
      try {
        return parseManifest(JSON.parse(loaded.data.toString("utf8")) as unknown);
      } finally {
        loaded.data.fill(0);
      }
    } catch (error) {
      if (isMissingFile(error)) return emptyManifest();
      throw error;
    }
  }

  private async saveManifest(manifest: ConfigManifest): Promise<void> {
    const data = Buffer.from(JSON.stringify(manifest), "utf8");
    try {
      if (data.length > MAX_MANIFEST_BYTES) throw new Error("Configuration manifest is too large");
      await writePrivateFileAtomic(join(this.metadataDirectory, MANIFEST_FILE), data);
    } finally {
      data.fill(0);
    }
  }
}

export function deferredWireGuardResult(summary: SavedConfigSummary): string | undefined {
  return summary.transport === "wireguard"
    ? summary.unavailableReason ?? "WireGuard operator connections are deferred for this milestone"
    : undefined;
}

function emptyManifest(): ConfigManifest {
  return { version: 2, imported: {}, detachedExternal: [] };
}

function parseManifest(value: unknown): ConfigManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration manifest");
  const candidate = value as Partial<ConfigManifest>;
  if (candidate.version !== 2 || !candidate.imported || typeof candidate.imported !== "object" || Array.isArray(candidate.imported)) {
    throw new Error("Invalid configuration manifest");
  }
  const imported: ConfigManifest["imported"] = {};
  for (const [importedId, raw] of Object.entries(candidate.imported)) {
    if (!/^[0-9a-f-]{36}$/iu.test(importedId) || !raw || typeof raw !== "object") continue;
    const entry = raw as { path?: unknown; displayName?: unknown; digest?: unknown };
    if (
      typeof entry.path !== "string" || !isAbsolute(entry.path) || entry.path.includes("\0") ||
      typeof entry.displayName !== "string" || typeof entry.digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.digest)
    ) {
      continue;
    }
    const displayName = sanitizeSavedConfigMetadata(entry.displayName);
    if (!displayName) continue;
    imported[importedId] = { path: resolve(entry.path), displayName, digest: entry.digest };
  }
  const detachedExternal = Array.isArray(candidate.detachedExternal)
    ? candidate.detachedExternal.filter((item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/u.test(item))
    : [];
  return { version: 2, imported, detachedExternal: [...new Set(detachedExternal)] };
}

function pathFingerprint(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

// Keep the import cap and final-file check colocated with the store policy.
export async function readConfigForImport(path: string): Promise<Buffer> {
  const loaded = await readBoundedRegularFile(path, {
    label: "Selected configuration",
    maxBytes: MAX_SAVED_CONFIG_BYTES,
  });
  return loaded.data;
}
