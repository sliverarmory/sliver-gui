import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  HELLO_WORLD_SCRIPT_NAME,
  HELLO_WORLD_SCRIPT_SOURCE,
  SCRIPT_LIMITS,
  parseCreateScriptInput,
  parseDeleteScriptInput,
  parseReadScriptInput,
  parseRenameScriptInput,
  parseSaveScriptInput,
  parseScriptId,
  parseScriptName,
  parseScriptSource,
  type CreateScriptInput,
  type DeleteScriptInput,
  type ReadScriptInput,
  type RenameScriptInput,
  type SaveScriptInput,
  type ScriptCatalog,
  type ScriptDocument,
} from "../shared/script-contracts.js";
import { readBoundedRegularFile, writePrivateFileAtomic, writePrivateFileExclusiveAtomic } from "./secure-file.js";

const MANIFEST_FILE = "names.json";
const MAX_DIRECTORY_ENTRIES = SCRIPT_LIMITS.scripts * 2 + 10;

interface Manifest { version: 1; initialized: true; names: Record<string, string> }
interface LoadedManifest { manifest: Manifest; warnings: string[]; writable: boolean }
type Authorize = () => void;

/** Only messages from this class are suitable to expose to a renderer. */
export class ScriptStoreError extends Error {}

/** One main-owned instance serializes every window's reads and writes. */
export class ScriptStore {
  private chain: Promise<void> = Promise.resolve();
  private initialized = false;
  private directoryIdentity: Array<{ path: string; dev: number; ino: number }> = [];

  constructor(readonly directory: string, private readonly onChanged: () => void = () => undefined) {
    if (!isAbsolute(directory) || resolve(directory) !== directory || dirname(directory) === directory) {
      throw new TypeError("Script directory must be an absolute normalized application path");
    }
  }

  list(): Promise<ScriptCatalog> {
    return this.serialize(async () => {
      await this.prepare();
      const loaded = await this.loadManifest();
      const ids = await this.sourceIds();
      const scripts: ScriptCatalog["scripts"] = [];
      const warnings = [...loaded.warnings];
      for (const id of ids) {
        try {
          const { source: _source, ...summary } = await this.readDocument(id, loaded.manifest);
          scripts.push(summary);
          if (!Object.hasOwn(loaded.manifest.names, id)) warnings.push(`Recovered script ${id} has no saved name. Rename it to restore its catalog entry.`);
        } catch {
          warnings.push(`Script ${id} could not be read safely. Its file has been preserved.`);
        }
      }
      for (const id of Object.keys(loaded.manifest.names)) {
        if (!ids.includes(id)) warnings.push(`Script ${id} has a saved name but its source file is missing. Its catalog entry has been preserved.`);
      }
      return { scripts: scripts.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), warnings };
    });
  }

  read(input: ReadScriptInput): Promise<ScriptDocument> {
    const { id } = parseReadScriptInput(input);
    return this.serialize(async () => {
      await this.prepare();
      return this.readDocument(id, (await this.loadManifest()).manifest);
    });
  }

  create(input: CreateScriptInput, authorize?: Authorize): Promise<ScriptDocument> {
    const parsed = parseCreateScriptInput(input);
    return this.serialize(async () => {
      await this.prepare(authorize);
      const manifest = this.requireWritable(await this.loadManifest());
      const ids = await this.sourceIds();
      if (new Set([...ids, ...Object.keys(manifest.names)]).size >= SCRIPT_LIMITS.scripts) {
        throw new ScriptStoreError("The script library has reached its 1,000-script limit");
      }
      const id = randomUUID();
      await this.assertDirectories();
      await writePrivateFileExclusiveAtomic(this.sourcePath(id), Buffer.from(parsed.source), authorize);
      manifest.names[id] = parsed.name;
      // Preserve an orphan source if the metadata commit fails; the next list
      // recovers it. Never erase user code while handling a second-file error.
      await this.saveManifest(manifest, authorize);
      this.changed();
      return document(id, parsed.name, parsed.source);
    });
  }

  save(input: SaveScriptInput, authorize?: Authorize): Promise<ScriptDocument> {
    const parsed = parseSaveScriptInput(input);
    return this.serialize(async () => {
      await this.prepare(authorize);
      const manifest = this.requireWritable(await this.loadManifest());
      const current = await this.readDocument(parsed.id, manifest);
      assertRevision(current, parsed.expectedRevision);
      await this.assertDirectories();
      await writePrivateFileAtomic(this.sourcePath(parsed.id), Buffer.from(parsed.source), authorize);
      this.changed();
      return document(parsed.id, current.name, parsed.source);
    });
  }

  rename(input: RenameScriptInput, authorize?: Authorize): Promise<ScriptDocument> {
    const parsed = parseRenameScriptInput(input);
    return this.serialize(async () => {
      await this.prepare(authorize);
      const manifest = this.requireWritable(await this.loadManifest());
      const current = await this.readDocument(parsed.id, manifest);
      assertRevision(current, parsed.expectedRevision);
      if (!Object.hasOwn(manifest.names, parsed.id) && Object.keys(manifest.names).length >= SCRIPT_LIMITS.scripts) {
        throw new ScriptStoreError("The script names file has reached its 1,000-script limit. Repair missing entries before recovering another script.");
      }
      manifest.names[parsed.id] = parsed.name;
      await this.saveManifest(manifest, authorize);
      this.changed();
      return document(parsed.id, parsed.name, current.source);
    });
  }

  remove(input: DeleteScriptInput, authorize?: Authorize): Promise<void> {
    const parsed = parseDeleteScriptInput(input);
    return this.serialize(async () => {
      await this.prepare(authorize);
      const manifest = this.requireWritable(await this.loadManifest());
      const current = await this.readDocument(parsed.id, manifest);
      assertRevision(current, parsed.expectedRevision);
      delete manifest.names[parsed.id];
      await this.saveManifest(manifest, authorize);
      await this.assertDirectories();
      // Re-read immediately before unlinking, detecting outside file changes
      // during the metadata commit. On interruption the preserved file appears
      // as a recovered orphan, rather than being silently destroyed.
      const beforeDelete = await this.readDocument(parsed.id, { ...manifest, names: { [parsed.id]: current.name } });
      assertRevision(beforeDelete, parsed.expectedRevision);
      authorize?.();
      await unlink(this.sourcePath(parsed.id));
      this.changed();
    });
  }

  flush(): Promise<void> { return this.chain; }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation);
    this.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private async prepare(authorize?: Authorize): Promise<void> {
    authorize?.();
    if (this.initialized) { await this.assertDirectories(); return; }
    this.directoryIdentity = [];
    const guiDirectory = dirname(this.directory);
    const clientDirectory = dirname(guiDirectory);
    // The client root is application-owned configuration, not renderer input.
    // Verify each owned directory component before creating its child.
    await mkdir(clientDirectory, { recursive: true, mode: 0o700 });
    for (const path of [clientDirectory, guiDirectory, this.directory]) {
      if (path !== clientDirectory) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasCode(error, "EEXIST")) throw error;
      });
      const stats = await lstat(path);
      if (!stats.isDirectory() || stats.isSymbolicLink()) throw new ScriptStoreError("The script library must use regular application directories, not symbolic links");
      if (path !== clientDirectory && process.platform !== "win32") await chmod(path, 0o700);
      this.directoryIdentity.push({ path, dev: stats.dev, ino: stats.ino });
    }
    const entries = await readdir(this.directory);
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new ScriptStoreError("The script library contains too many directory entries");
    if (!entries.includes(MANIFEST_FILE)) {
      const manifest = emptyManifest();
      if (entries.length === 0) {
        const id = randomUUID();
        await writePrivateFileExclusiveAtomic(this.sourcePath(id), Buffer.from(HELLO_WORLD_SCRIPT_SOURCE), authorize);
        manifest.names[id] = HELLO_WORLD_SCRIPT_NAME;
      }
      await writePrivateFileExclusiveAtomic(join(this.directory, MANIFEST_FILE), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), authorize);
    }
    this.initialized = true;
  }

  private async assertDirectories(): Promise<void> {
    for (const expected of this.directoryIdentity) {
      const actual = await lstat(expected.path);
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
        throw new ScriptStoreError("The script library directory changed. Reopen the application after checking its location.");
      }
    }
  }

  private async sourceIds(): Promise<string[]> {
    const entries = await readdir(this.directory);
    if (entries.length > MAX_DIRECTORY_ENTRIES) throw new ScriptStoreError("The script library contains too many directory entries");
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".js")) continue;
      try { ids.push(parseScriptId(entry.slice(0, -3))); } catch { /* Never interpret a user-selected filename. */ }
    }
    if (ids.length > SCRIPT_LIMITS.scripts) throw new ScriptStoreError("The script library has exceeded its 1,000-script limit");
    return ids.sort();
  }

  private sourcePath(id: string): string { return join(this.directory, `${parseScriptId(id)}.js`); }

  private async readDocument(id: string, manifest: Manifest): Promise<ScriptDocument> {
    await this.assertDirectories();
    try {
      const { data } = await readBoundedRegularFile(this.sourcePath(id), { label: "Script source", maxBytes: SCRIPT_LIMITS.sourceBytes, requirePrivateMode: true });
      try {
        const source = parseScriptSource(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data));
        return document(id, manifest.names[id] ?? `Recovered script ${id.slice(0, 8)}`, source);
      } finally { data.fill(0); }
    } catch (error) {
      if (hasCode(error, "ENOENT")) throw new ScriptStoreError("This script no longer exists. Refresh the script library.");
      throw new ScriptStoreError("The script source could not be read safely. Its file has been preserved.");
    }
  }

  private async loadManifest(): Promise<LoadedManifest> {
    await this.assertDirectories();
    try {
      const { data } = await readBoundedRegularFile(join(this.directory, MANIFEST_FILE), { label: "Script names", maxBytes: SCRIPT_LIMITS.manifestBytes, requirePrivateMode: true });
      try { return { manifest: parseManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data))), warnings: [], writable: true }; }
      finally { data.fill(0); }
    } catch {
      return { manifest: emptyManifest(), writable: false, warnings: ["names.json is missing, invalid, or unsafe. Source files are preserved and can be read. Repair the names file before changing the library."] };
    }
  }

  private requireWritable(loaded: LoadedManifest): Manifest {
    if (!loaded.writable) throw new ScriptStoreError("The script names file needs repair. Existing source files and metadata have been preserved.");
    return loaded.manifest;
  }

  private async saveManifest(manifest: Manifest, authorize?: Authorize): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    if (bytes.length > SCRIPT_LIMITS.manifestBytes) throw new ScriptStoreError("The script names file exceeds its size limit");
    await this.assertDirectories();
    await writePrivateFileAtomic(join(this.directory, MANIFEST_FILE), bytes, authorize);
  }

  private changed(): void { try { this.onChanged(); } catch { /* A closing subscriber must not undo a successful save. */ } }
}

function emptyManifest(): Manifest { return { version: 1, initialized: true, names: Object.create(null) as Record<string, string> }; }

function parseManifest(value: unknown): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid script names");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["version", "initialized", "names"].includes(key)) || raw["version"] !== 1 || raw["initialized"] !== true || !raw["names"] || typeof raw["names"] !== "object" || Array.isArray(raw["names"])) throw new Error("Invalid script names");
  const entries = Object.entries(raw["names"]);
  if (entries.length > SCRIPT_LIMITS.scripts) throw new Error("Too many script names");
  const manifest = emptyManifest();
  for (const [id, name] of entries) manifest.names[parseScriptId(id)] = parseScriptName(name);
  return manifest;
}

function document(id: string, name: string, source: string): ScriptDocument {
  return { id, name, source, revision: createHash("sha256").update(JSON.stringify([name, source])).digest("hex") };
}

function assertRevision(current: ScriptDocument, expected: string): void {
  if (current.revision !== expected) throw new ScriptStoreError("This script changed in another window or on disk. Your draft has been preserved; reload or save a new copy.");
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
