import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";

import { dialog, type BrowserWindow } from "electron";

import type { OperationResult } from "../shared/contracts.js";
import {
  SCRIPT_LIMITS,
  parseExportScriptInput,
  parseScriptSource,
  type ExportScriptInput,
  type ExportScriptResult,
  type ImportScriptResult,
} from "../shared/script-contracts.js";
import { safeScriptExportBasename, scriptImportDisplayName } from "./script-file-name.js";
import { ScriptStoreError, type ScriptStore } from "./script-store.js";
import { readBoundedRegularFile, writePrivateArtifactFileAtomic } from "./secure-file.js";

type Authorize = () => void;

/** Exports only the validated snapshot to an operator-selected native destination. */
export async function exportScriptFile(
  owner: BrowserWindow,
  input: ExportScriptInput,
  authorize: Authorize,
): Promise<OperationResult<ExportScriptResult>> {
  const parsed = parseExportScriptInput(input);
  const defaultPath = safeScriptExportBasename(parsed.name);
  let data: Buffer | undefined;
  try {
    authorize();
    const selection = await dialog.showSaveDialog(owner, {
      title: "Export script",
      defaultPath,
      filters: [{ name: "JavaScript", extensions: ["js"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    authorize();
    if (selection.canceled || !selection.filePath) return { ok: true, value: { canceled: true } };
    // The native dialog's selected leaf is authoritative. Never rewrite its
    // extension or name after the operator approves an overwrite.
    const destination = await regularExportDestination(selection.filePath);
    authorize();
    data = Buffer.from(parsed.source, "utf8");
    await writePrivateArtifactFileAtomic(destination, data, authorize);
    return { ok: true, value: { canceled: false } };
  } catch {
    return { ok: false, error: "The script could not be exported. Choose a writable regular file destination and try again." };
  } finally {
    data?.fill(0);
  }
}

/** Imports source as data; only ScriptStore mints the library's UUID filename. */
export async function importScriptFile(
  owner: BrowserWindow,
  store: ScriptStore,
  authorize: Authorize,
): Promise<OperationResult<ImportScriptResult>> {
  let data: Buffer | undefined;
  try {
    authorize();
    const selection = await dialog.showOpenDialog(owner, {
      title: "Import script",
      filters: [{ name: "JavaScript", extensions: ["js"] }],
      properties: ["openFile"],
    });
    authorize();
    if (selection.canceled) return { ok: true, value: { canceled: true } };
    if (selection.filePaths.length !== 1) throw new Error("Select one script");
    const path = selection.filePaths[0]!;
    if (!isAbsolute(path) || extname(path).toLowerCase() !== ".js") throw new Error("Select a JavaScript file");
    ({ data } = await readBoundedRegularFile(path, { label: "Imported script", maxBytes: SCRIPT_LIMITS.sourceBytes }));
    const source = parseScriptSource(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data));
    const name = scriptImportDisplayName(basename(path));
    authorize();
    const script = await store.create({ name, source }, authorize);
    return { ok: true, value: { canceled: false, script } };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof ScriptStoreError ? error.message
        : "The script could not be imported. Choose one regular .js file containing valid UTF-8 within the 512 KiB limit.",
    };
  } finally {
    data?.fill(0);
  }
}

async function regularExportDestination(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Invalid native save destination");
  const directory = await realpath(dirname(path));
  const destination = join(directory, basename(path));
  try {
    const existing = await lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("Destination is not a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return destination;
}
