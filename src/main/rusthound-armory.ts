import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { TargetSummary } from "../shared/target-contracts.js";
import { armoryRecord, armoryText, parseArmoryManifest, safeArmoryPath } from "./armory-archive.js";
import { MAX_ARMORY_MANIFEST_BYTES } from "./armory-signature.js";
import { readBoundedRegularFile } from "./secure-file.js";

export const RUSTHOUND_ARMORY_REPOSITORY = "https://github.com/sliverarmory/RustHound-CE";
export const RUSTHOUND_ARMORY_COMMAND = "rusthound-ce";
export const RUSTHOUND_EXTENSION_EXPORT = "RustHoundCE";
// The native-extension artifact RPC has a separate 32 MiB send/receive budget.
export const RUSTHOUND_EXTENSION_MAX_BYTES = 32 * 1024 * 1024;
/** Exact signed release DLLs admitted for the integrated collector. */
export const VERIFIED_RUSTHOUND_DLL_SHA256 = new Set<string>([
  // Signed v2.5.29 GNU release: GOAD session/beacon and Beagle for LdapOnly, DCOnly, All.
  "d31f7bcbc9176fa7928302cfdab72b865d9539a61e2f2350085442f0f2368c64",
  // Signed v2.5.30 GNU release: adds current-user GSSAPI; Beagle E2E is pending.
  "7e072a170992d332b6f0862f706bcfeec494b6b9a9a8602e5280f90a9b42aba1",
]);
const CURRENT_USER_RUSTHOUND_VERSION = "2.5.30";
const CURRENT_USER_RUSTHOUND_DLL_SHA256 = "7e072a170992d332b6f0862f706bcfeec494b6b9a9a8602e5280f90a9b42aba1";

export interface InstalledRustHound {
  readonly packageDirectory: string;
  readonly artifactPath: string;
  readonly manifestDigest: string;
  readonly artifactDigest: string;
  readonly version: string;
}

export function isVerifiedRustHoundBuild(entry: InstalledRustHound): boolean {
  return VERIFIED_RUSTHOUND_DLL_SHA256.has(entry.artifactDigest);
}

/** Never offer token authentication for the older credential-only DLL. */
export function supportsRustHoundCurrentUser(entry: InstalledRustHound): boolean {
  return entry.version === CURRENT_USER_RUSTHOUND_VERSION &&
    entry.artifactDigest === CURRENT_USER_RUSTHOUND_DLL_SHA256 && isVerifiedRustHoundBuild(entry);
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

async function realDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Armory directory is not a regular directory");
}

async function checkedArtifactPath(packageDirectory: string, relative: string): Promise<string> {
  const parts = relative.split("/");
  let current = packageDirectory;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    await realDirectory(current);
  }
  const path = join(current, parts.at(-1)!);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > RUSTHOUND_EXTENSION_MAX_BYTES) {
    throw new Error("RustHound extension must be a bounded regular file");
  }
  return path;
}

export function isWindowsAmd64(target: TargetSummary): boolean {
  return target.os.trim().toLowerCase() === "windows" &&
    ["amd64", "x64", "x86_64"].includes(target.arch.trim().toLowerCase());
}

/** Discovers only the fork's installed Armory extension, with an exact artifact digest. */
export async function installedRustHound(root: string, target: TargetSummary): Promise<InstalledRustHound | null> {
  if (!isWindowsAmd64(target)) return null;
  const packageDirectory = join(root, "extensions", RUSTHOUND_ARMORY_COMMAND);
  try {
    await realDirectory(root);
    await realDirectory(join(root, "extensions"));
    await realDirectory(packageDirectory);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  const manifestBytes = (await readBoundedRegularFile(join(packageDirectory, "extension.json"), {
    label: "RustHound Armory manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    const manifest = parseArmoryManifest(manifestBytes, false);
    if (manifest.kind !== "extension" || manifest.directoryName !== RUSTHOUND_ARMORY_COMMAND ||
        manifest.repoUrl !== RUSTHOUND_ARMORY_REPOSITORY ||
        manifest.commandNames.length !== 1 || manifest.commandNames[0] !== RUSTHOUND_ARMORY_COMMAND ||
        !manifest.version) throw new Error("The installed RustHound package is not the supported fork");
    const raw = armoryRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown);
    const command = Array.isArray(raw["commands"]) ? armoryRecord(raw["commands"][0]) : raw;
    if (armoryText(command["entrypoint"]) !== RUSTHOUND_EXTENSION_EXPORT ||
        armoryText(command["depends_on"]) || armoryText(command["bof_executor"])) {
      throw new Error("The RustHound extension has an unsupported loader contract");
    }
    const files = command["files"];
    if (!Array.isArray(files)) throw new Error("The RustHound manifest has no artifacts");
    const matches = files.map(armoryRecord).filter((file) =>
      armoryText(file["os"]).trim().toLowerCase() === "windows" &&
      ["amd64", "x64", "x86_64"].includes(armoryText(file["arch"]).trim().toLowerCase()));
    if (matches.length !== 1) throw new Error("The RustHound package needs one Windows x64 DLL");
    const artifactPath = safeArmoryPath(armoryText(matches[0]!["path"], true), true);
    const artifactDigest = armoryText(matches[0]!["sha256"], true).toLowerCase();
    if (!artifactPath.toLowerCase().endsWith(".dll") || !/^[a-f0-9]{64}$/u.test(artifactDigest)) {
      throw new Error("The RustHound DLL or its checksum is invalid");
    }
    await checkedArtifactPath(packageDirectory, artifactPath);
    return { packageDirectory, artifactPath, artifactDigest, version: manifest.version,
      manifestDigest: createHash("sha256").update(manifestBytes).digest("hex") };
  } finally { manifestBytes.fill(0); }
}

/** Rechecks manifest and DLL bytes at execution time to detect replacement. */
export async function readInstalledRustHound(entry: InstalledRustHound): Promise<Buffer> {
  await realDirectory(entry.packageDirectory);
  const manifestBytes = (await readBoundedRegularFile(join(entry.packageDirectory, "extension.json"), {
    label: "RustHound Armory manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    if (createHash("sha256").update(manifestBytes).digest("hex") !== entry.manifestDigest) {
      throw new Error("The RustHound Armory manifest changed; refresh collectors");
    }
  } finally { manifestBytes.fill(0); }
  const path = await checkedArtifactPath(entry.packageDirectory, entry.artifactPath);
  const bytes = (await readBoundedRegularFile(path, {
    label: "RustHound extension", maxBytes: RUSTHOUND_EXTENSION_MAX_BYTES,
  })).data;
  try {
    if (createHash("sha256").update(bytes).digest("hex") !== entry.artifactDigest) {
      throw new Error("The RustHound DLL checksum does not match its Armory manifest");
    }
    const peOffset = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : -1;
    if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d || peOffset < 0x40 ||
        peOffset + 24 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550 ||
        bytes.readUInt16LE(peOffset + 4) !== 0x8664 ||
        (bytes.readUInt16LE(peOffset + 22) & 0x2000) === 0) {
      throw new Error("The installed RustHound artifact is not a Windows x64 DLL");
    }
    return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}
