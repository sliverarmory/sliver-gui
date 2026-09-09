import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ArmoryBundle, ArmoryInstallBundleInput, ArmoryInstalledPackage, ArmoryInstallInput, ArmoryInstallLocalInput,
  ArmoryPackage, ArmoryRemoveSourceInput, ArmorySaveSourceInput, ArmorySnapshot, ArmorySource, ArmoryUninstallInput,
} from "../shared/armory-contracts.js";
import {
  ARMORY_ARCHIVE_LIMITS, armoryRecord, armoryText, parseArmoryManifest, safeArmoryName, unpackArmoryArchive, type ArmoryManifest,
} from "./armory-archive.js";
import {
  MAX_ARMORY_MANIFEST_BYTES, decodeArmoryBase64, normalizeArmoryPublicKey, verifyArmoryMinisign, verifyArmorySignatureMetadata,
} from "./armory-signature.js";

// Same trust root and repository as scripts/buildSliverConsole.mjs and the console client.
export const DEFAULT_ARMORY_PUBLIC_KEY = "RWSBpxpRWDrD7Fe+VvRE3c2VEDC2NK80rlNCj+BX0gz44Xw07r6KQD9L";
export const DEFAULT_ARMORY_REPO_URL = "https://api.github.com/repos/sliverarmory/armory/releases";
const METADATA_LIMIT = 8 * 1024 * 1024;
const MAX_PACKAGES = 5_000;
const REQUEST_TIMEOUT_MS = 120_000;
interface SourceConfig extends Record<string, unknown> {
  public_key: string; repo_url: string; authorization: string; authorization_cmd: string; name: string; enabled: boolean;
}
interface CatalogEntry {
  dto: ArmoryPackage;
  source: SourceConfig;
  isAlias: boolean;
  manifest?: ArmoryManifest;
}
interface InstalledEntry { dto: ArmoryInstalledPackage; manifest: ArmoryManifest; manifestBytes: Buffer }
interface PreparedPackage { manifest: ArmoryManifest; files: Map<string, Buffer>; previous: Buffer | null; replace: boolean }
interface RemotePackage { signature: Buffer; archiveUrl: string }
interface GitHubAsset { name: string; url: string }
export interface ArmoryServiceOptions { rootPath?: string; fetch?: typeof globalThis.fetch }

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function sourceId(source: SourceConfig): string { return hash(source.repo_url + source.public_key + source.name); }
function installedId(manifest: ArmoryManifest): string { return `${manifest.kind === "alias" ? "aliases" : "extensions"}/${manifest.directoryName}`; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Armory operation failed"; }
export function armoryVersionIsNewer(candidate: string, installed: string): boolean {
  const version = /^v?(\d+(?:\.\d+)*)(?:-([^+]+))?(?:\+.*)?$/u;
  const left = version.exec(candidate); const right = version.exec(installed);
  if (!left || !right) return new Intl.Collator("en", { numeric: true }).compare(candidate, installed) > 0;
  const a = left[1]!.split(".").map(BigInt); const b = right[1]!.split(".").map(BigInt);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    if ((a[index] ?? 0n) !== (b[index] ?? 0n)) return (a[index] ?? 0n) > (b[index] ?? 0n);
  }
  if (!left[2] || !right[2]) return !!right[2] && !left[2];
  const preA = left[2].split("."); const preB = right[2].split(".");
  for (let index = 0; index < Math.max(preA.length, preB.length); index++) {
    const partA = preA[index]; const partB = preB[index];
    if (partA === partB) continue;
    if (partA === undefined || partB === undefined) return partB === undefined;
    const numericA = /^[0-9]+$/u.test(partA); const numericB = /^[0-9]+$/u.test(partB);
    if (numericA && numericB) return BigInt(partA) > BigInt(partB);
    if (numericA !== numericB) return numericB;
    return partA > partB;
  }
  return false;
}
function missing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"; }
function defaultSource(): SourceConfig { return { public_key: DEFAULT_ARMORY_PUBLIC_KEY, repo_url: DEFAULT_ARMORY_REPO_URL, authorization: "", authorization_cmd: "", name: "Default", enabled: true }; }
function validatedURL(value: string): URL {
  const url = new URL(value);
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) throw new Error("Armory URLs must use HTTP or HTTPS without embedded credentials or fragments");
  return url;
}
function sourceDTO(source: SourceConfig, error?: string): ArmorySource {
  return { id: sourceId(source), name: source.name, repoUrl: source.repo_url, publicKey: source.public_key, enabled: source.enabled,
    hasAuthorization: !!source.authorization, hasAuthorizationCommand: !!source.authorization_cmd, ...(error ? { error } : {}) };
}
async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Armory file is not a regular file or exceeds its size limit");
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    if (offset !== stat.size) throw new Error("Armory file changed while it was being read");
    return bytes.subarray(0, offset);
  } finally { await file.close(); }
}
async function directory(path: string, create = false): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Armory directories must be real directories, not symbolic links");
}

/** Local package management only. This service never loads or executes a package. */
export class ArmoryService {
  readonly rootPath: string;
  private readonly fetcher: typeof globalThis.fetch;
  private catalog = new Map<string, CatalogEntry>();
  private bundles: ArmoryBundle[] = [];
  private sourceErrors = new Map<string, string>();
  private refreshedAt: string | null = null;
  private pending = Promise.resolve();
  private controllers = new Set<AbortController>();
  private disposed = false;

  constructor(options: ArmoryServiceOptions = {}) {
    this.rootPath = resolve(options.rootPath ?? (process.env["SLIVER_CLIENT_ROOT_DIR"] || join(homedir(), ".sliver-client")));
    this.fetcher = options.fetch ?? globalThis.fetch;
  }
  dispose(): void { this.disposed = true; for (const controller of this.controllers) controller.abort(); }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(() => { if (this.disposed) throw new Error("Armory is closed"); return operation(); });
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  async snapshot(): Promise<ArmorySnapshot> {
    const warnings: string[] = [];
    const sources = await this.readSources();
    const currentSources = new Map(sources.map((source) => [sourceId(source), source]));
    const installed = await this.readInstalled(warnings);
    const packages = [...this.catalog.values()].filter((entry) => currentSources.get(entry.dto.sourceId)?.enabled).map((entry) => {
      const local = installed.find((candidate) => entry.manifest && this.samePackage(candidate.manifest, entry.manifest));
      return { ...entry.dto, ...(local ? { installedId: local.dto.id } : {}), updateAvailable: !!local && armoryVersionIsNewer(entry.dto.version, local.dto.version) };
    });
    const installedDTOs = installed.map((entry) => {
      const matches = packages.filter((candidate) => candidate.installedId === entry.dto.id && !candidate.error);
      // The console does not persist provenance; never guess between competing sources.
      const match = matches.length === 1 ? matches[0] : undefined;
      return { ...entry.dto, ...(match ? { packageId: match.id, updateAvailable: match.updateAvailable } : {}) };
    });
    return { rootPath: this.rootPath, sources: sources.map((source) => sourceDTO(source, this.sourceErrors.get(sourceId(source)))),
      installed: installedDTOs, packages, bundles: this.bundles.filter((bundle) => currentSources.get(bundle.sourceId)?.enabled), refreshedAt: this.refreshedAt, warnings };
  }

  refreshCatalog(): Promise<ArmorySnapshot> { return this.exclusive(async () => { await this.refresh(); return this.snapshot(); }); }
  install(input: ArmoryInstallInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const revision = await this.configRevision();
      await this.ensureCatalog();
      const entry = await this.currentEntry(input.packageId);
      const prepared = await this.prepareEntries([entry], input.replace ?? false, false);
      if (await this.configRevision() !== revision) throw new Error("Console Armory configuration changed during download; refresh and retry");
      await this.commitPackages(prepared);
      return this.snapshot();
    });
  }
  installBundle(input: ArmoryInstallBundleInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const revision = await this.configRevision();
      await this.ensureCatalog();
      const bundle = this.bundles.find((item) => item.id === input.bundleId);
      if (!bundle) throw new Error("Armory bundle is unavailable; refresh the catalog");
      const entries: CatalogEntry[] = [];
      for (const name of bundle.packageNames) entries.push(await this.resolveDependency(name, bundle.sourceId));
      const prepared = await this.prepareEntries(entries, input.replace ?? false, true);
      if (await this.configRevision() !== revision) throw new Error("Console Armory configuration changed during download; refresh and retry");
      await this.commitPackages(prepared);
      return this.snapshot();
    });
  }
  installLocal(input: ArmoryInstallLocalInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const publicKey = normalizeArmoryPublicKey(input.publicKey);
      const signature = await boundedFile(input.signaturePath, 2 * MAX_ARMORY_MANIFEST_BYTES);
      const archive = await boundedFile(input.archivePath, ARMORY_ARCHIVE_LIMITS.compressedBytes);
      const comment = verifyArmoryMinisign(archive, signature, publicKey);
      const trustedManifest = decodeArmoryBase64(comment, MAX_ARMORY_MANIFEST_BYTES);
      const files = await unpackArmoryArchive(archive);
      const isAlias = files.has("alias.json");
      if (isAlias === files.has("extension.json")) throw new Error("Armory archive must contain exactly one root manifest");
      const manifest = this.validatePackage(files, trustedManifest, isAlias);
      const installed = await this.readInstalled([]);
      const missingDependencies = manifest.dependencies.filter((dependency) => !manifest.commandNames.includes(dependency) &&
        !installed.some((entry) => entry.manifest.commandNames.includes(dependency)));
      if (missingDependencies.length) throw new Error(`Install required packages first: ${missingDependencies.join(", ")}`);
      const prepared = await this.prepareWrite(manifest, files, input.replace ?? false, installed);
      await this.commitPackages([prepared]);
      return this.snapshot();
    });
  }
  uninstall(input: ArmoryUninstallInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const installed = await this.readInstalled([]);
      const entry = installed.find((item) => item.dto.id === input.installedId);
      if (!entry) throw new Error("Installed Armory package was not found");
      const dependents = installed.filter((item) => item !== entry && item.manifest.dependencies.some((name) => entry.manifest.commandNames.includes(name)));
      if (dependents.length) throw new Error(`Package is required by: ${dependents.map((item) => item.dto.name).join(", ")}`);
      await directory(this.rootPath);
      await directory(dirname(entry.dto.installPath));
      await directory(entry.dto.installPath);
      const quarantine = join(this.rootPath, `.armory-remove-${randomUUID()}`);
      await rename(entry.dto.installPath, quarantine);
      await rm(quarantine, { recursive: true, force: true });
      return this.snapshot();
    });
  }

  saveSource(input: ArmorySaveSourceInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const revision = await this.configRevision();
      const sources = await this.readSources();
      const existing = input.id ? sources.find((source) => sourceId(source) === input.id) : undefined;
      if (input.id && !existing) throw new Error("Armory source changed; refresh before editing it");
      const name = input.name.trim();
      if (!name || name.length > 128 || /[\x00-\x1f\x7f]/u.test(name)) throw new Error("Invalid Armory source name");
      const publicKey = normalizeArmoryPublicKey(input.publicKey);
      const repoUrl = validatedURL(input.repoUrl).toString();
      if (input.authorization !== undefined && (input.authorization.length > 8192 || /[\x00-\x1f\x7f]/u.test(input.authorization))) throw new Error("Invalid Armory authorization header");
      if (name === "Default" && (publicKey !== DEFAULT_ARMORY_PUBLIC_KEY || repoUrl !== DEFAULT_ARMORY_REPO_URL || !input.enabled)) throw new Error("The console reserves Default for the official enabled Armory; use another name for a custom source");
      if (name === "Default" && input.authorization) throw new Error("The console does not preserve authorization for Default; create a custom source to use a credential");
      if (sources.some((source) => source !== existing && (source.name === name || source.public_key === publicKey))) throw new Error("An Armory with this name or public key already exists");
      const updated: SourceConfig = { ...existing, name, public_key: publicKey, repo_url: repoUrl, enabled: input.enabled,
        authorization: input.authorization ?? existing?.authorization ?? "",
        authorization_cmd: input.authorization !== undefined ? "" : existing?.authorization_cmd ?? "" };
      await this.writeSources(existing ? sources.map((source) => source === existing ? updated : source) : [...sources, updated], revision);
      this.clearCatalog();
      return this.snapshot();
    });
  }
  removeSource(input: ArmoryRemoveSourceInput): Promise<ArmorySnapshot> {
    return this.exclusive(async () => {
      const revision = await this.configRevision();
      const sources = await this.readSources();
      if (!sources.some((source) => sourceId(source) === input.sourceId)) throw new Error("Armory source was not found");
      await this.writeSources(sources.filter((source) => sourceId(source) !== input.sourceId), revision);
      this.clearCatalog();
      return this.snapshot();
    });
  }

  private clearCatalog(): void { this.catalog.clear(); this.bundles = []; this.sourceErrors.clear(); this.refreshedAt = null; }
  private async readSources(): Promise<SourceConfig[]> {
    let bytes: Buffer;
    try { await directory(this.rootPath); bytes = await boundedFile(join(this.rootPath, "armories.json"), MAX_ARMORY_MANIFEST_BYTES); }
    catch (error) { if (missing(error)) return [defaultSource()]; throw error; }
    let raw: unknown;
    try { raw = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Invalid console armories.json configuration"); }
    if (!Array.isArray(raw) || raw.length > 64) throw new Error("Invalid console armories.json configuration");
    const sources = raw.map((value) => {
      const record = armoryRecord(value);
      // The console deliberately restores the reserved Default entry from its pinned constants.
      if (record["name"] === "Default") return defaultSource();
      const source: SourceConfig = { ...record, name: armoryText(record["name"], true), repo_url: armoryText(record["repo_url"], true),
        public_key: normalizeArmoryPublicKey(armoryText(record["public_key"], true)), authorization: armoryText(record["authorization"]),
        authorization_cmd: armoryText(record["authorization_cmd"]), enabled: record["enabled"] === true };
      validatedURL(source.repo_url);
      return source;
    });
    if (new Set(sources.map((source) => source.name)).size !== sources.length || new Set(sources.map((source) => source.public_key)).size !== sources.length) throw new Error("Console armories.json contains duplicate sources");
    return sources.sort((left, right) => left.name === "Default" ? 1 : right.name === "Default" ? -1 : 0);
  }
  private async configRevision(): Promise<string | null> {
    try { return hash((await boundedFile(join(this.rootPath, "armories.json"), MAX_ARMORY_MANIFEST_BYTES)).toString("base64")); }
    catch (error) { if (missing(error)) return null; throw error; }
  }
  private async writeSources(sources: SourceConfig[], revision: string | null): Promise<void> {
    await directory(this.rootPath, true);
    const destination = join(this.rootPath, "armories.json");
    try { if (!(await lstat(destination)).isFile()) throw new Error("Armory config is not a regular file"); } catch (error) { if (!missing(error)) throw error; }
    const temporary = join(this.rootPath, `.armories-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(sources, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      if (await this.configRevision() !== revision) throw new Error("Console Armory configuration changed; refresh and retry");
      await rename(temporary, destination);
    }
    finally { await rm(temporary, { force: true }); }
  }

  private async readInstalled(warnings: string[]): Promise<InstalledEntry[]> {
    const result: InstalledEntry[] = [];
    try { await directory(this.rootPath); } catch (error) { if (missing(error)) return result; throw error; }
    for (const category of ["aliases", "extensions"] as const) {
      const base = join(this.rootPath, category);
      let entries: string[];
      try { await directory(base); entries = await readdir(base); } catch (error) { if (missing(error)) continue; throw error; }
      if (entries.length > MAX_PACKAGES) throw new Error("Too many installed Armory packages");
      for (const name of entries.sort()) {
        try {
          safeArmoryName(name);
          const path = join(base, name);
          await directory(path);
          const bytes = await boundedFile(join(path, category === "aliases" ? "alias.json" : "extension.json"), MAX_ARMORY_MANIFEST_BYTES);
          const manifest = parseArmoryManifest(bytes, category === "aliases");
          if (manifest.directoryName !== name) throw new Error("Manifest name does not match its installation directory");
          result.push({ manifest, manifestBytes: bytes, dto: { id: installedId(manifest), name: manifest.name, commandNames: manifest.commandNames,
            kind: manifest.kind, version: manifest.version, description: manifest.description, repoUrl: manifest.repoUrl, installPath: path } });
        } catch (error) { warnings.push(`Could not read ${category}/${name}: ${errorText(error)}`); }
      }
    }
    return result;
  }
  private samePackage(left: ArmoryManifest, right: ArmoryManifest): boolean {
    return installedId(left) === installedId(right) && left.repoUrl === right.repoUrl &&
      isDeepStrictEqual([...left.commandNames].sort(), [...right.commandNames].sort());
  }
  private async ensureCatalog(): Promise<void> { if (!this.refreshedAt) await this.refresh(); }
  private async currentEntry(id: string): Promise<CatalogEntry> {
    const entry = this.catalog.get(id);
    if (!entry) throw new Error("Armory package is unavailable; refresh the catalog");
    const sources = await this.readSources();
    const source = sources.find((candidate) => sourceId(candidate) === entry.dto.sourceId && candidate.enabled);
    if (!source) throw new Error("Armory source was changed or disabled; refresh the catalog");
    return { ...entry, source };
  }
  private async refresh(): Promise<void> {
    const sources = await this.readSources();
    const catalog = new Map<string, CatalogEntry>();
    const bundles: ArmoryBundle[] = [];
    this.sourceErrors.clear();
    for (const source of sources.filter((item) => item.enabled)) {
      try {
        const index = await this.fetchIndex(source);
        const sourcePackages: CatalogEntry[] = [];
        for (const kind of ["aliases", "extensions"] as const) {
          const values = index[kind] ?? [];
          if (!Array.isArray(values) || values.length > MAX_PACKAGES) throw new Error("Armory index has too many or invalid packages");
          for (const value of values) {
            const raw = armoryRecord(value);
            const name = armoryText(raw["name"], true);
            const commandName = safeArmoryName(armoryText(raw["command_name"], true));
            const repoUrl = validatedURL(armoryText(raw["repo_url"], true)).toString();
            const publicKey = normalizeArmoryPublicKey(armoryText(raw["public_key"], true));
            const id = hash(repoUrl + publicKey + source.name + commandName);
            const duplicate = sourcePackages.find((entry) => entry.dto.id === id);
            if (duplicate) {
              if (duplicate.isAlias !== (kind === "aliases")) throw new Error("Armory index has conflicting package types");
              continue; // The official console index may repeat an identical package identity.
            }
            sourcePackages.push({ source, isAlias: kind === "aliases", dto: { id, sourceId: sourceId(source), sourceName: source.name, name, commandName,
              repoUrl, publicKey, kind: kind === "aliases" ? "alias" : "extension", version: "", description: "", updateAvailable: false } });
          }
        }
        if (catalog.size + sourcePackages.length > MAX_PACKAGES) throw new Error("Armory catalog exceeds its package limit");
        await this.concurrent(sourcePackages, async (entry) => {
          try {
            const remote = await this.fetchPackage(entry);
            const parsed = verifyArmorySignatureMetadata(remote.signature, entry.dto.publicKey);
            const manifest = parseArmoryManifest(decodeArmoryBase64(parsed.trustedComment, MAX_ARMORY_MANIFEST_BYTES), entry.isAlias);
            this.checkIdentity(entry, manifest);
            entry.manifest = manifest;
            entry.dto = { ...entry.dto, kind: manifest.kind, version: manifest.version, description: manifest.description };
          } catch (error) { entry.dto = { ...entry.dto, error: errorText(error) }; }
        });
        for (const entry of sourcePackages) catalog.set(entry.dto.id, entry);
        const rawBundles = index["bundles"] ?? [];
        if (!Array.isArray(rawBundles) || rawBundles.length > MAX_PACKAGES) throw new Error("Invalid Armory bundles");
        for (const value of rawBundles) {
          const raw = armoryRecord(value);
          const name = armoryText(raw["name"], true);
          const names = raw["packages"];
          if (!Array.isArray(names) || names.length > MAX_PACKAGES) throw new Error("Invalid Armory bundle packages");
          bundles.push({ id: hash(sourceId(source) + name), sourceId: sourceId(source), sourceName: source.name, name,
            packageNames: names.map((value) => safeArmoryName(armoryText(value, true))) });
        }
      } catch (error) { this.sourceErrors.set(sourceId(source), errorText(error)); }
    }
    this.catalog = catalog; this.bundles = bundles; this.refreshedAt = new Date().toISOString();
  }
  private async concurrent<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
      while (index < items.length) { const item = items[index++]; if (item !== undefined) await worker(item); }
    }));
  }

  private checkIdentity(entry: CatalogEntry, manifest: ArmoryManifest): void {
    if (!manifest.commandNames.includes(entry.dto.commandName) && manifest.directoryName !== entry.dto.commandName) throw new Error("Signed Armory manifest does not match the selected package");
    if (entry.isAlias !== (manifest.kind === "alias")) throw new Error("Armory package type does not match its index");
  }
  private validatePackage(files: Map<string, Buffer>, trustedBytes: Buffer, isAlias: boolean): ArmoryManifest {
    const manifestFile = isAlias ? "alias.json" : "extension.json";
    if (files.has(isAlias ? "extension.json" : "alias.json")) throw new Error("Armory archive contains conflicting manifests");
    const bytes = files.get(manifestFile);
    if (!bytes || bytes.length > MAX_ARMORY_MANIFEST_BYTES) throw new Error(`Armory archive is missing ${manifestFile}`);
    if (!isDeepStrictEqual(JSON.parse(bytes.toString("utf8")), JSON.parse(trustedBytes.toString("utf8")))) throw new Error("Archive manifest differs from the signed Armory manifest");
    const manifest = parseArmoryManifest(bytes, isAlias);
    for (const path of manifest.artifactPaths) if (!files.get(path)?.length) throw new Error(`Armory archive is missing a required artifact: ${path}`);
    return manifest;
  }
  private async resolveDependency(name: string, preferredSource: string): Promise<CatalogEntry> {
    const candidates = [...this.catalog.values()].filter((entry) => entry.dto.commandName === name || entry.manifest?.commandNames.includes(name));
    const preferred = candidates.filter((entry) => entry.dto.sourceId === preferredSource);
    const matches = preferred.length ? preferred : candidates;
    if (matches.length !== 1) throw new Error(matches.length ? `Armory dependency is ambiguous: ${name}` : `Armory dependency was not found: ${name}`);
    return this.currentEntry(matches[0]!.dto.id);
  }
  private async prepareEntries(entries: CatalogEntry[], replace: boolean, skipInstalled: boolean): Promise<PreparedPackage[]> {
    const installed = await this.readInstalled([]);
    const prepared: PreparedPackage[] = [];
    let preparedBytes = 0;
    const visited = new Set<string>();
    const active = new Set<string>();
    const visit = async (entry: CatalogEntry, dependency: boolean): Promise<void> => {
      if (active.has(entry.dto.id)) throw new Error(`Armory dependency cycle includes ${entry.dto.commandName}`);
      if (visited.has(entry.dto.id)) return;
      active.add(entry.dto.id);
      if (active.size > 64 || visited.size + active.size > 256 || prepared.length >= 256) throw new Error("Armory installation plan exceeds 256 packages");
      const remote = await this.fetchPackage(entry);
      const parsed = verifyArmorySignatureMetadata(remote.signature, entry.dto.publicKey);
      const trustedBytes = decodeArmoryBase64(parsed.trustedComment, MAX_ARMORY_MANIFEST_BYTES);
      const signedManifest = parseArmoryManifest(trustedBytes, entry.isAlias);
      this.checkIdentity(entry, signedManifest);
      if ((dependency || skipInstalled) && !replace && installed.some((item) => this.samePackage(item.manifest, signedManifest))) {
        active.delete(entry.dto.id); visited.add(entry.dto.id); return;
      }
      for (const name of signedManifest.dependencies) {
        if (signedManifest.commandNames.includes(name) || installed.some((item) => item.manifest.commandNames.includes(name))) continue;
        await visit(await this.resolveDependency(name, entry.dto.sourceId), true);
      }
      const archive = await this.request(remote.archiveUrl, entry.source, ARMORY_ARCHIVE_LIMITS.compressedBytes, true);
      parsed.verifyPayload(archive);
      const files = await unpackArmoryArchive(archive);
      const manifest = this.validatePackage(files, trustedBytes, entry.isAlias);
      this.checkIdentity(entry, manifest);
      const next = await this.prepareWrite(manifest, files, replace, installed);
      if (prepared.some((item) => installedId(item.manifest).toLowerCase() === installedId(manifest).toLowerCase() || item.manifest.commandNames.some((name) => manifest.commandNames.includes(name)))) throw new Error("Armory installation plan contains conflicting packages");
      preparedBytes += [...next.files.values()].reduce((total, bytes) => total + bytes.length, 0);
      if (preparedBytes > ARMORY_ARCHIVE_LIMITS.expandedBytes) throw new Error("Armory installation plan exceeds its total size limit");
      prepared.push(next);
      active.delete(entry.dto.id); visited.add(entry.dto.id);
    };
    for (const entry of entries) await visit(entry, false);
    return prepared;
  }
  private async prepareWrite(manifest: ArmoryManifest, files: Map<string, Buffer>, replace: boolean, installed: InstalledEntry[]): Promise<PreparedPackage> {
    const id = installedId(manifest);
    const collisions = installed.filter((entry) => entry.dto.id !== id && (entry.dto.id.toLowerCase() === id.toLowerCase() || entry.manifest.commandNames.some((name) => manifest.commandNames.includes(name))));
    if (collisions.length) throw new Error(`Armory commands are already provided by ${collisions.map((entry) => entry.dto.name).join(", ")}`);
    let previous: Buffer | null = null;
    try {
      const path = join(this.rootPath, id);
      await directory(dirname(path)); await directory(path);
      if (!replace) throw new Error("Armory package is already installed; choose Replace to reinstall it");
      previous = await boundedFile(join(path, manifest.manifestFile), MAX_ARMORY_MANIFEST_BYTES);
    } catch (error) { if (!missing(error)) throw error; }
    // Retain only the files the console installs, preserving the exact manifest bytes.
    const required = new Map<string, Buffer>();
    for (const path of [manifest.manifestFile, ...manifest.artifactPaths]) required.set(path, Buffer.from(files.get(path)!));
    return { manifest, files: required, previous, replace };
  }
  private async commitPackages(packages: PreparedPackage[]): Promise<void> {
    if (!packages.length) return;
    const current = await this.readInstalled([]);
    const replaced = new Set(packages.map((entry) => installedId(entry.manifest)));
    const remaining = current.filter((entry) => !replaced.has(entry.dto.id));
    const planned = packages.map((entry) => entry.manifest);
    for (const manifest of planned) {
      if (remaining.some((entry) => entry.dto.id.toLowerCase() === installedId(manifest).toLowerCase() ||
        entry.manifest.commandNames.some((name) => manifest.commandNames.includes(name)))) {
        throw new Error("Installed Armory commands changed during download; refresh and retry");
      }
    }
    const finalCommands = new Set([...remaining.map((entry) => entry.manifest), ...planned].flatMap((manifest) => manifest.commandNames));
    for (const manifest of planned) {
      if (manifest.dependencies.some((name) => !finalCommands.has(name))) throw new Error(`Armory package ${manifest.name} has a missing dependency; refresh and retry`);
    }
    const removedCommands = new Set(current.filter((entry) => replaced.has(entry.dto.id)).flatMap((entry) => entry.manifest.commandNames).filter((name) => !finalCommands.has(name)));
    if (remaining.some((entry) => entry.manifest.dependencies.some((name) => removedCommands.has(name)))) throw new Error("Armory update would remove a command required by an installed package");
    await directory(this.rootPath, true);
    const stage = await mkdtemp(join(this.rootPath, ".armory-stage-"));
    const committed: { destination: string; backup: string | null; published: boolean; dev: number; ino: number }[] = [];
    let preserveStage = false;
    try {
      for (let index = 0; index < packages.length; index++) {
        const entry = packages[index]!;
        const packageStage = join(stage, String(index));
        await directory(packageStage, true);
        for (const [path, data] of entry.files) {
          const destination = join(packageStage, path);
          await directory(dirname(destination), true);
          await writeFile(destination, data, { mode: 0o600, flag: "wx" });
        }
      }
      for (let index = 0; index < packages.length; index++) {
        if (this.disposed) throw new Error("Armory is closed");
        const entry = packages[index]!;
        const destination = join(this.rootPath, installedId(entry.manifest));
        await directory(this.rootPath); await directory(dirname(destination), true);
        let backup: string | null = null;
        try {
          await directory(destination);
          if (!entry.replace || !entry.previous) throw new Error("Installed Armory package changed during installation; refresh and retry");
          const bytes = await boundedFile(join(destination, entry.manifest.manifestFile), MAX_ARMORY_MANIFEST_BYTES);
          if (!bytes.equals(entry.previous)) throw new Error("Installed Armory package changed during installation; refresh and retry");
          backup = join(stage, `backup-${index}`);
          await rename(destination, backup);
        } catch (error) { if (!missing(error)) throw error; if (entry.previous) throw new Error("Installed Armory package changed during installation; refresh and retry"); }
        const stagingIdentity = await lstat(join(stage, String(index)));
        const publication = { destination, backup, published: false, dev: stagingIdentity.dev, ino: stagingIdentity.ino };
        committed.push(publication);
        await rename(join(stage, String(index)), destination);
        publication.published = true;
      }
    } catch (error) {
      for (const item of committed.reverse()) {
        try {
          if (item.published) {
            const current = await lstat(item.destination);
            if (current.dev !== item.dev || current.ino !== item.ino) throw new Error("Package changed during rollback");
            await rm(item.destination, { recursive: true, force: true });
          }
          if (item.backup) {
            try { await lstat(item.destination); throw new Error("Package changed during rollback"); }
            catch (error) { if (!missing(error)) throw error; }
            await rename(item.backup, item.destination);
          }
        } catch { if (item.backup) preserveStage = true; }
      }
      if (preserveStage) throw new Error(`Armory installation failed and its backup was preserved at ${stage}`);
      throw error;
    } finally { if (!preserveStage) await rm(stage, { recursive: true, force: true }); }
  }

  private async fetchIndex(source: SourceConfig): Promise<Record<string, unknown>> {
    const response = await this.request(source.repo_url, source, METADATA_LIMIT);
    let bytes: Buffer; let signature: Buffer;
    if (validatedURL(source.repo_url).hostname === "api.github.com") {
      const assets = this.releaseAssets(response);
      bytes = await this.request(this.assetURL(assets, "armory.json"), source, METADATA_LIMIT, true);
      signature = await this.request(this.assetURL(assets, "armory.minisig"), source, 2 * MAX_ARMORY_MANIFEST_BYTES, true);
    } else {
      const wrapper = armoryRecord(JSON.parse(response.toString("utf8")) as unknown);
      bytes = decodeArmoryBase64(wrapper["armory_index"], METADATA_LIMIT);
      signature = decodeArmoryBase64(wrapper["minisig"], 2 * MAX_ARMORY_MANIFEST_BYTES);
    }
    verifyArmoryMinisign(bytes, signature, source.public_key);
    return armoryRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  }
  private releaseAssets(bytes: Buffer): GitHubAsset[] {
    const releases: unknown = JSON.parse(bytes.toString("utf8"));
    const release = armoryRecord(Array.isArray(releases) ? releases[0] : releases);
    const assets = release["assets"];
    if (!Array.isArray(assets)) throw new Error("GitHub release has no Armory assets");
    return assets.map((value) => { const raw = armoryRecord(value); return { name: armoryText(raw["name"], true), url: armoryText(raw["url"], true) }; });
  }
  private assetURL(assets: GitHubAsset[], name: string): string {
    const matching = assets.filter((asset) => asset.name === name);
    if (matching.length !== 1) throw new Error(`GitHub release is missing a unique ${name} asset`);
    return validatedURL(matching[0]!.url).toString();
  }
  private async fetchPackage(entry: CatalogEntry): Promise<RemotePackage> {
    const url = validatedURL(entry.dto.repoUrl);
    if (url.hostname === "github.com") {
      const base = url.pathname.replace(/\/$/u, "");
      const latest = await this.requestRedirect(`https://github.com${base}/releases/latest`);
      if (latest.origin !== "https://github.com" || !latest.pathname.startsWith(`${base}/releases/tag/`)) throw new Error("GitHub returned an invalid Armory release redirect");
      const tag = latest.pathname.slice(`${base}/releases/tag/`.length);
      if (!tag || tag.includes("/")) throw new Error("GitHub returned an invalid Armory release tag");
      const releaseBase = `https://github.com${base}/releases/download/${tag}/${encodeURIComponent(entry.dto.commandName)}`;
      const signature = await this.request(`${releaseBase}.minisig`, entry.source, 2 * MAX_ARMORY_MANIFEST_BYTES, true);
      return { signature, archiveUrl: `${releaseBase}.tar.gz` };
    }
    const response = await this.request(entry.dto.repoUrl, entry.source, METADATA_LIMIT);
    if (url.hostname === "api.github.com") {
      const assets = this.releaseAssets(response);
      return { signature: await this.request(this.assetURL(assets, `${entry.dto.commandName}.minisig`), entry.source, 2 * MAX_ARMORY_MANIFEST_BYTES, true),
        archiveUrl: this.assetURL(assets, `${entry.dto.commandName}.tar.gz`) };
    }
    const wrapper = armoryRecord(JSON.parse(response.toString("utf8")) as unknown);
    return { signature: decodeArmoryBase64(wrapper["minisig"], 2 * MAX_ARMORY_MANIFEST_BYTES), archiveUrl: validatedURL(armoryText(wrapper["tar_gz_url"], true)).toString() };
  }
  private async requestRedirect(url: string): Promise<URL> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(url, { redirect: "manual", signal: controller.signal, headers: { "User-Agent": "Sliver-Armory" } });
      await response.body?.cancel();
      if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get("location")) throw new Error("GitHub latest Armory release is unavailable");
      return validatedURL(new URL(response.headers.get("location")!, url).toString());
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  private async request(rawUrl: string, source: SourceConfig, maxBytes: number, binary = false): Promise<Buffer> {
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let url = validatedURL(rawUrl);
      const authOrigin = validatedURL(source.repo_url).origin;
      for (let redirect = 0; redirect <= 5; redirect++) {
        if (this.disposed) throw new Error("Armory is closed");
        const headers: Record<string, string> = { "User-Agent": "Sliver-Armory", Accept: binary ? "application/octet-stream" : "application/json" };
        if (url.origin === authOrigin && source.authorization && url.hostname !== "github.com") {
          if (url.protocol !== "https:" || /[\x00-\x1f\x7f]/u.test(source.authorization)) throw new Error("Armory authorization requires HTTPS and a valid header");
          headers["Authorization"] = source.authorization;
        }
        const response = await this.fetcher(url.toString(), { headers, redirect: "manual", signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get("location");
          if (!location) throw new Error("Armory download has an invalid redirect");
          const next = validatedURL(new URL(location, url).toString());
          if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("Armory download attempted an insecure redirect");
          url = next; continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel();
          if ([401, 403].includes(response.status) && source.authorization_cmd) throw new Error("This source uses a console authorization command; save an authorization value in Sources for GUI downloads");
          throw new Error(`Armory download failed (HTTP ${response.status})`);
        }
        const length = response.headers.get("content-length");
        if (length && (!/^[0-9]+$/u.test(length) || Number(length) > maxBytes)) { await response.body?.cancel(); throw new Error("Armory download exceeds its size limit"); }
        if (!response.body) throw new Error("Armory download is empty");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let received = 0;
        try {
          for (;;) {
            const result = await reader.read();
            if (result.done) break;
            received += result.value.length;
            if (received > maxBytes) { await reader.cancel(); throw new Error("Armory download exceeds its size limit"); }
            chunks.push(result.value);
          }
        } finally { reader.releaseLock(); }
        return Buffer.concat(chunks, received);
      }
      throw new Error("Armory download redirected too many times");
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Armory download was cancelled or timed out");
      if (error instanceof TypeError) throw new Error("Armory request failed; check the source URL and network connection");
      throw error;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
}
