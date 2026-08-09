import { createHash, randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parseConfig } from "sliver-script";

import type { SavedConfigSummary } from "../shared/contracts.js";
import {
  discoverSavedConfigs,
  MAX_SAVED_CONFIG_BYTES,
  readCurrentSavedConfig,
  sanitizeSavedConfigMetadata,
  type SavedConfigRecord,
} from "./saved-config-catalog.js";
import { readBoundedRegularFile, writePrivateFileAtomic } from "./secure-file.js";

const MANIFEST_FILE = ".sliver-gui-configs.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;

interface ConfigManifest {
  version: 1;
  managed: Record<string, { displayName: string; digest: string }>;
  detachedExternal: string[];
}

export class OperatorConfigStore {
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(
    readonly externalDirectory: string,
    readonly managedDirectory: string,
  ) {}

  async list(): Promise<SavedConfigRecord[]> {
    const manifest = await this.loadManifest();
    const displayNames = new Map(
      Object.entries(manifest.managed).map(([fileName, entry]) => [fileName, entry.displayName] as const),
    );
    const [managed, external] = await Promise.all([
      discoverSavedConfigs(this.managedDirectory, "managed", displayNames),
      discoverSavedConfigs(this.externalDirectory, "preexisting"),
    ]);
    const ownedManaged = managed.filter((record) => {
      const manifestEntry = manifest.managed[basename(record.path)];
      return manifestEntry?.digest === record.digest;
    });
    const detached = new Set(manifest.detachedExternal);
    return [
      ...ownedManaged,
      ...external.filter((record) => !detached.has(pathFingerprint(record.path))),
    ].sort(
      (left, right) =>
        right.summary.modifiedAt.localeCompare(left.summary.modifiedAt) ||
        left.summary.displayName.localeCompare(right.summary.displayName),
    );
  }

  async import(data: Buffer, requestedDisplayName: string): Promise<SavedConfigRecord> {
    const displayName = sanitizeSavedConfigMetadata(requestedDisplayName);
    if (!displayName || displayName.length > 200) throw new Error("A valid local configuration name is required");
    const config = parseConfig(data);
    if (!Number.isSafeInteger(config.lport) || config.lport < 1 || config.lport > 65_535) {
      throw new Error("Invalid Sliver configuration port");
    }

    return this.serializeMutation(async () => {
      const fileName = `${randomUUID()}.cfg`;
      const path = join(this.managedDirectory, fileName);
      await writePrivateFileAtomic(path, data);
      const digest = createHash("sha256").update(data).digest("hex");
      try {
        const manifest = await this.loadManifest();
        manifest.managed[fileName] = { displayName, digest };
        await this.saveManifest(manifest);
        const record = (await discoverSavedConfigs(this.managedDirectory, "managed", new Map([[fileName, displayName]])))
          .find((candidate) => basename(candidate.path) === fileName);
        if (!record) throw new Error("Imported configuration could not be verified");
        return record;
      } catch (error) {
        await unlink(path).catch(() => undefined);
        throw error;
      }
    });
  }

  async remove(record: SavedConfigRecord): Promise<void> {
    return this.serializeMutation(async () => {
      const manifest = await this.loadManifest();
      if (record.summary.origin === "managed") {
        const fileName = basename(record.path);
        const entry = manifest.managed[fileName];
        if (!entry || dirname(resolve(record.path)) !== resolve(this.managedDirectory)) {
          throw new Error("Managed configuration ownership could not be verified");
        }
        const data = await readCurrentSavedConfig(record);
        try {
          const digest = createHash("sha256").update(data).digest("hex");
          if (digest !== entry.digest) throw new Error("Managed configuration changed since it was imported");
        } finally {
          data.fill(0);
        }
        await unlink(record.path);
        delete manifest.managed[fileName];
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
    const path = join(this.managedDirectory, MANIFEST_FILE);
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
      await writePrivateFileAtomic(join(this.managedDirectory, MANIFEST_FILE), data);
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
  return { version: 1, managed: {}, detachedExternal: [] };
}

function parseManifest(value: unknown): ConfigManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid configuration manifest");
  const candidate = value as Partial<ConfigManifest>;
  if (candidate.version !== 1 || !candidate.managed || typeof candidate.managed !== "object") {
    throw new Error("Invalid configuration manifest");
  }
  const managed: ConfigManifest["managed"] = {};
  for (const [fileName, raw] of Object.entries(candidate.managed)) {
    if (!/^[0-9a-f-]{36}\.cfg$/iu.test(fileName) || !raw || typeof raw !== "object") continue;
    const entry = raw as { displayName?: unknown; digest?: unknown };
    if (typeof entry.displayName !== "string" || typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/u.test(entry.digest)) {
      continue;
    }
    managed[fileName] = { displayName: sanitizeSavedConfigMetadata(entry.displayName), digest: entry.digest };
  }
  const detachedExternal = Array.isArray(candidate.detachedExternal)
    ? candidate.detachedExternal.filter((item): item is string => typeof item === "string" && /^[0-9a-f]{64}$/u.test(item))
    : [];
  return { version: 1, managed, detachedExternal: [...new Set(detachedExternal)] };
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

export async function verifyManagedConfigMode(path: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Imported configuration is not a regular file");
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error("Imported configuration permissions must be private (0600)");
  }
}
