import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import type { RdpImportResult } from "../shared/rdp-contracts.js";
import { parseRdpFile, RDP_IMPORT_MAX_BYTES, type ParsedRdpFile } from "./rdp-file-import.js";
import type { RdpStore } from "./rdp-store.js";

export function rdpImportPaths(raw: unknown): readonly string[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32 || raw.some((path) => typeof path !== "string" ||
    path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || !isAbsolute(path) || !/\.rdp$/iu.test(path))) {
    throw new Error("Select between 1 and 32 local .rdp files");
  }
  return [...new Set(raw as string[])];
}

/** Native file paths are admitted by the picker, OS association, or preload's File bridge. */
export async function importRdpProfiles(paths: readonly string[], store: RdpStore, assertCurrent: () => void): Promise<RdpImportResult> {
  const items: RdpImportResult["items"][number][] = [];
  for (const path of rdpImportPaths(paths)) {
    assertCurrent();
    const name = basename(path).replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 255) || "RDP file";
    let contents: Buffer | undefined;
    try {
      const before = await lstat(path);
      if (before.isSymbolicLink() || !before.isFile() || before.size > RDP_IMPORT_MAX_BYTES) throw new Error("Invalid file");
      const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW) | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > RDP_IMPORT_MAX_BYTES || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error("Invalid file");
        // A bounded read also protects against concurrent growth after stat().
        contents = Buffer.alloc(RDP_IMPORT_MAX_BYTES + 1);
        let length = 0;
        while (length < contents.length) {
          const { bytesRead } = await file.read(contents, length, contents.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > RDP_IMPORT_MAX_BYTES) throw new Error("Invalid file");
        const after = await file.stat();
        if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new Error("File changed");
        contents = contents.subarray(0, length);
      } finally { await file.close(); }
    } catch {
      contents?.fill(0);
      items.push({ name, warnings: [], error: "Could not read this .rdp file. Use a regular file no larger than 256 KiB." });
      continue;
    }
    try { assertCurrent(); } catch (error) { contents.fill(0); throw error; }
    let parsed: ParsedRdpFile;
    try { parsed = parseRdpFile(contents, name); }
    catch (error) {
      items.push({ name, warnings: [], error: error instanceof Error ? error.message.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 512) : "Could not import this .rdp file" });
      continue;
    } finally { contents.fill(0); }
    try {
      const profile = await store.saveProfile(parsed.profile);
      items.push({ name, profile, warnings: parsed.warnings });
    } catch {
      items.push({ name, warnings: parsed.warnings, error: "Could not save this profile. Check available storage and the 100-profile limit." });
    }
  }
  return { canceled: false, items };
}
