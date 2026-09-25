import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type { TargetSummary } from "../shared/target-contracts.js";
import { armoryRecord, armoryText, parseArmoryManifest, safeArmoryName, safeArmoryPath } from "./armory-archive.js";
import { MAX_ARMORY_MANIFEST_BYTES } from "./armory-signature.js";
import { readBoundedRegularFile } from "./secure-file.js";

export const MAX_BOF_LOADER_BYTES = 16 * 1_024 * 1_024;
const MAX_LEGACY_ARGUMENT_BYTES = 64 * 1_024 * 1_024;

export interface InstalledBofLoader {
  /** SHA-256 loader identity used as CallExtensionReq.Name after registration. */
  readonly name: string;
  /** Native extension bytes to register for the selected target. Caller owns zeroization. */
  readonly data: Buffer;
  /** Native export used as CallExtensionReq.Export. */
  readonly exportName: string;
  /** Optional native initialization export used during RegisterExtension. */
  readonly init: string;
}

function targetArchitecture(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "x64": case "x86_64": return "amd64";
    case "x86": case "i386": case "i686": return "386";
    case "aarch64": return "arm64";
    default: return value.trim().toLowerCase();
  }
}

async function requireDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Armory loader directory is not a regular directory");
}

function requireNativeLoaderArtifact(path: string, os: string): void {
  const expected = os.trim().toLowerCase() === "windows" ? /\.dll$/iu
    : os.trim().toLowerCase() === "linux" ? /\.so$/iu
      : os.trim().toLowerCase() === "darwin" ? /\.(?:dylib|so)$/iu : undefined;
  if (!expected || !expected.test(path)) throw new Error("Armory loader artifact is not a native extension for this target");
}

/** Resolve the native loader named by an installed BOF's depends_on field. */
export async function readInstalledBofLoader(
  root: string,
  dependencyName: string,
  target: Pick<TargetSummary, "os" | "arch">,
): Promise<InstalledBofLoader> {
  const directoryName = safeArmoryName(dependencyName);
  const extensionsDirectory = join(root, "extensions");
  const packageDirectory = join(extensionsDirectory, directoryName);
  await requireDirectory(root);
  await requireDirectory(extensionsDirectory);
  await requireDirectory(packageDirectory);

  const manifestBytes = (await readBoundedRegularFile(join(packageDirectory, "extension.json"), {
    label: "Armory loader manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    const manifest = parseArmoryManifest(manifestBytes, false);
    if (manifest.directoryName !== directoryName || manifest.kind !== "extension") {
      throw new Error("Installed Armory loader manifest does not match its package");
    }
    const raw = armoryRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)) as unknown);
    const commands = Array.isArray(raw["commands"]) && raw["commands"].length
      ? raw["commands"].map(armoryRecord) : [raw];
    const command = commands.find((entry) => armoryText(entry["command_name"]) === dependencyName);
    if (!command) throw new Error("The installed Armory loader command is unavailable");
    const exportName = armoryText(command["entrypoint"], true);
    if (exportName.length > 256 || /[\u0000-\u001f\u007f]/u.test(exportName)) {
      throw new Error("Invalid Armory loader entrypoint");
    }
    const init = armoryText(command["init"]);
    if (init.length > 256 || /[\u0000-\u001f\u007f]/u.test(init)) {
      throw new Error("Invalid Armory loader initialization export");
    }
    const files = command["files"];
    if (!Array.isArray(files)) throw new Error("Armory loader has no target artifacts");
    const selected = files.map(armoryRecord).find((file) =>
      armoryText(file["os"]).trim().toLowerCase() === target.os.trim().toLowerCase() &&
      targetArchitecture(armoryText(file["arch"])) === targetArchitecture(target.arch));
    if (!selected) throw new Error("No Armory loader matches this target's OS and architecture");
    const relativePath = safeArmoryPath(armoryText(selected["path"], true), true);
    requireNativeLoaderArtifact(relativePath, target.os);
    let current = packageDirectory;
    const segments = relativePath.split("/");
    for (const segment of segments.slice(0, -1)) {
      current = join(current, segment);
      await requireDirectory(current);
    }
    const data = (await readBoundedRegularFile(join(current, segments.at(-1)!), {
      label: "Armory loader", maxBytes: MAX_BOF_LOADER_BYTES,
    })).data;
    if (!data.length) throw new Error("The installed Armory loader is empty");
    return { name: createHash("sha256").update(data).digest("hex"), data, exportName, init };
  } finally {
    manifestBytes.fill(0);
  }
}

/** Matches console getBOFArgs: AddString(entrypoint), AddData(object), AddData(typed args), GetBuffer. */
export function packLegacyBofArguments(entrypoint: string, object: Buffer, packedArgs: Buffer): Buffer {
  if (!entrypoint || entrypoint.length > 256 || /[\u0000-\u001f\u007f]/u.test(entrypoint)) {
    throw new Error("Invalid BOF entrypoint");
  }
  if (!object.length || object.length > MAX_BOF_LOADER_BYTES) throw new Error("Invalid BOF object size");
  if (packedArgs.length < 4 || packedArgs.length > MAX_LEGACY_ARGUMENT_BYTES ||
    packedArgs.readUInt32LE(0) !== packedArgs.length - 4) throw new Error("Invalid packed BOF arguments");

  const exportBytes = Buffer.from(`${entrypoint}\0`, "utf8");
  try {
    const bodyLength = 4 + exportBytes.length + 4 + object.length + 4 + packedArgs.length;
    if (bodyLength > MAX_LEGACY_ARGUMENT_BYTES) throw new Error("Legacy BOF arguments exceed the size limit");
    const outer = Buffer.alloc(4 + bodyLength);
    outer.writeUInt32LE(bodyLength, 0);
    let offset = 4;
    for (const part of [exportBytes, object, packedArgs]) {
      outer.writeUInt32LE(part.length, offset);
      offset += 4;
      part.copy(outer, offset);
      offset += part.length;
    }
    return outer;
  } finally {
    exportBytes.fill(0);
  }
}
