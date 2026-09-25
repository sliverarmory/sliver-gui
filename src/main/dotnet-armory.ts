import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

import type { DotNetAssembly, DotNetCatalog } from "../shared/dotnet-contracts.js";
import type { TargetRef, TargetSummary } from "../shared/target-contracts.js";
import { armoryRecord, armoryText, parseArmoryManifest, safeArmoryName, safeArmoryPath } from "./armory-archive.js";
import { MAX_ARMORY_MANIFEST_BYTES } from "./armory-signature.js";
import { readBoundedRegularFile } from "./secure-file.js";

const MAX_INSTALLED = 5_000;
export const MAX_DOTNET_ASSEMBLY_BYTES = 64 * 1_024 * 1_024;

export interface InstalledDotNetAssembly {
  readonly dto: DotNetAssembly;
  readonly packageDirectory: string;
  readonly artifactPath?: string;
  readonly manifestDigest: string;
}

function architecture(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "x64": case "x86_64": return "amd64";
    case "x86": case "i386": case "i686": return "386";
    case "aarch64": return "arm64";
    default: return value.trim().toLowerCase();
  }
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function realDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Armory directory is not a regular directory");
}

function artifactExtension(path: string): ".exe" | ".dll" | null {
  const match = /\.(exe|dll)$/iu.exec(path);
  return match ? `.${match[1]!.toLowerCase()}` as ".exe" | ".dll" : null;
}

async function checkedArtifactPath(packageDirectory: string, relativePath: string): Promise<string> {
  await realDirectory(packageDirectory);
  const parts = relativePath.split("/");
  let current = packageDirectory;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    await realDirectory(current);
  }
  const path = join(current, parts.at(-1)!);
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > MAX_DOTNET_ASSEMBLY_BYTES) {
    throw new Error("Assembly must be a nonempty bounded regular file");
  }
  return path;
}

async function readPackage(packageDirectory: string, directoryName: string, target: TargetSummary): Promise<InstalledDotNetAssembly | null> {
  await realDirectory(packageDirectory);
  const manifestBytes = (await readBoundedRegularFile(join(packageDirectory, "alias.json"), {
    label: "Armory alias manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    const manifest = parseArmoryManifest(manifestBytes, true);
    if (manifest.directoryName !== directoryName) throw new Error("Armory alias name does not match its directory");
    const raw = armoryRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown);
    if (raw["is_assembly"] !== true) return null;

    const files = raw["files"];
    if (!Array.isArray(files)) throw new Error("Armory alias has no files");
    const artifacts = files.map((value) => {
      const file = armoryRecord(value);
      return {
        os: armoryText(file["os"], true).trim().toLowerCase(),
        arch: architecture(armoryText(file["arch"], true)),
        path: safeArmoryPath(armoryText(file["path"], true), true),
      };
    });
    const displayArtifact = artifacts.find((file) => artifactExtension(file.path)) ?? artifacts[0];
    const matches = target.os.trim().toLowerCase() === "windows"
      ? artifacts.filter((file) => file.os === "windows" && file.arch === architecture(target.arch))
      : [];
    const selected = matches.length === 1 ? matches[0] : undefined;
    let reason: string | undefined;
    let artifactPath: string | undefined;
    if (target.os.trim().toLowerCase() !== "windows") {
      reason = ".NET assembly execution requires a Windows target.";
    } else if (!matches.length) {
      reason = "No .NET assembly matches this target's OS and architecture.";
    } else if (matches.length > 1) {
      reason = "Multiple .NET assemblies match this target's OS and architecture.";
    } else if (!artifactExtension(selected!.path)) {
      reason = "The matching Armory artifact is not an .exe or .dll assembly.";
    } else {
      try { artifactPath = await checkedArtifactPath(packageDirectory, selected!.path); }
      catch { reason = "The matching Armory assembly file is unavailable or unsafe."; }
    }

    const displayPath = selected?.path ?? displayArtifact?.path ?? "";
    const dto: DotNetAssembly = {
      id: `aliases/${directoryName}`,
      commandName: manifest.commandNames[0]!,
      packageName: manifest.name,
      description: manifest.description,
      fileName: basename(displayPath),
      isDll: artifactExtension(displayPath) === ".dll",
      available: artifactPath !== undefined,
      ...(reason ? { reason } : {}),
    };
    return {
      dto, packageDirectory,
      ...(artifactPath ? { artifactPath: selected!.path } : {}),
      manifestDigest: createHash("sha256").update(manifestBytes).digest("hex"),
    };
  } finally {
    manifestBytes.fill(0);
  }
}

/** Enumerates locally installed Armory aliases that declare `is_assembly`. */
export async function installedDotNetAssemblies(
  root: string,
  target: TargetSummary,
  targetRef: TargetRef,
): Promise<{ catalog: DotNetCatalog; entries: InstalledDotNetAssembly[] }> {
  const entries: InstalledDotNetAssembly[] = [];
  const aliases = join(root, "aliases");
  try { await realDirectory(root); await realDirectory(aliases); }
  catch (error) {
    if (isMissing(error)) return { catalog: { target: { ...targetRef }, assemblies: [] }, entries };
    throw error;
  }
  const names = await readdir(aliases);
  if (names.length > MAX_INSTALLED) throw new Error("Too many installed Armory aliases");
  for (const name of names.sort()) {
    try {
      safeArmoryName(name);
      const entry = await readPackage(join(aliases, name), name, target);
      if (entry) entries.push(entry);
    } catch {
      // A damaged alias cannot prevent discovery of other installed packages.
    }
  }
  return { catalog: { target: { ...targetRef }, assemblies: entries.map((entry) => entry.dto) }, entries };
}

/** Reads an installed artifact without trusting its path or file identity from catalog time. */
export async function readInstalledDotNetAssembly(entry: InstalledDotNetAssembly): Promise<Buffer> {
  if (!entry.dto.available || !entry.artifactPath) throw new Error(entry.dto.reason ?? "The selected .NET assembly is unavailable");
  await realDirectory(entry.packageDirectory);
  const manifestBytes = (await readBoundedRegularFile(join(entry.packageDirectory, "alias.json"), {
    label: "Armory alias manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    const digest = createHash("sha256").update(manifestBytes).digest("hex");
    if (digest !== entry.manifestDigest) throw new Error("The selected Armory assembly changed; refresh the catalog");
  } finally {
    manifestBytes.fill(0);
  }
  const path = await checkedArtifactPath(entry.packageDirectory, entry.artifactPath);
  const bytes = (await readBoundedRegularFile(path, {
    label: "Armory .NET assembly", maxBytes: MAX_DOTNET_ASSEMBLY_BYTES,
  })).data;
  if (!bytes.length) {
    bytes.fill(0);
    throw new Error("The selected Armory assembly is empty");
  }
  return bytes;
}
