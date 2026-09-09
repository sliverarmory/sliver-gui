import { gunzip } from "node:zlib";
import { MAX_ARMORY_MANIFEST_BYTES } from "./armory-signature.js";

export const ARMORY_ARCHIVE_LIMITS = {
  compressedBytes: 128 * 1024 * 1024,
  expandedBytes: 512 * 1024 * 1024,
  fileBytes: 128 * 1024 * 1024,
  entries: 20_000,
} as const;

/** Manifest paths use Sliver's leading-slash convention; tar paths never do. */
export function safeArmoryPath(value: string, manifest = false): string {
  if (value.length > 1024 || /[\x00-\x1f\x7f\\:]/u.test(value)) throw new Error("Unsafe Armory file path");
  let normalized = value;
  if (manifest && normalized.startsWith("/") && !normalized.startsWith("//")) normalized = normalized.slice(1);
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  normalized = normalized.replace(/\/$/u, "");
  const segments = normalized.split("/");
  if (!normalized || segments.some((part) => !part || part === "." || part === ".." ||
    /[. ]$/u.test(part) || /[<>"|?*]/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    throw new Error("Unsafe Armory file path");
  }
  return normalized;
}

export function safeArmoryName(value: string): string {
  const normalized = safeArmoryPath(value);
  if (normalized !== value || normalized.includes("/") || value.length > 180 || value.startsWith(".")) throw new Error("Unsafe Armory package name");
  return normalized;
}

function stringField(bytes: Buffer): string {
  const end = bytes.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octalField(bytes: Buffer): number {
  const raw = stringField(bytes).trim();
  if (!/^[0-7]*$/u.test(raw)) throw new Error("Unsupported tar numeric field");
  const number = raw ? Number.parseInt(raw, 8) : 0;
  if (!Number.isSafeInteger(number)) throw new Error("Tar numeric field exceeds safe limits");
  return number;
}
function paxFields(bytes: Buffer): Map<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < offset || space - offset > 8) throw new Error("Invalid tar PAX record");
    const prefix = bytes.subarray(offset, space).toString("ascii");
    const length = Number(prefix);
    if (!/^[1-9][0-9]*$/u.test(prefix) || length < space - offset + 4 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) throw new Error("Invalid tar PAX record");
    const record = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf("=");
    if (equals < 1) throw new Error("Invalid tar PAX record");
    const name = record.slice(0, equals);
    if (result.has(name) || name.includes("sparse") || name === "linkpath") throw new Error("Unsupported tar PAX record");
    result.set(name, record.slice(equals + 1));
    offset += length;
  }
  return result;
}

/** Fully validates a bounded archive in memory. No archive entry can touch disk. */
export async function unpackArmoryArchive(compressed: Uint8Array): Promise<Map<string, Buffer>> {
  if (!compressed.length || compressed.length > ARMORY_ARCHIVE_LIMITS.compressedBytes) throw new Error("Armory archive exceeds the download limit");
  let archive: Buffer;
  try { archive = await new Promise<Buffer>((resolve, reject) => gunzip(compressed, { maxOutputLength: ARMORY_ARCHIVE_LIMITS.expandedBytes }, (error, data) => error ? reject(error) : resolve(data))); }
  catch { throw new Error("Armory archive is invalid or exceeds the unpacked size limit"); }
  const files = new Map<string, Buffer>();
  const names = new Map<string, "file" | "directory">();
  const parentPaths = new Set<string>();
  let pendingPax: Map<string, string> | undefined;
  let offset = 0;
  let entries = 0;
  let ended = false;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      if (archive.length - offset < 1024 || !archive.subarray(offset).every((value) => value === 0)) throw new Error("Invalid tar end marker");
      ended = true;
      break;
    }
    if (++entries > ARMORY_ARCHIVE_LIMITS.entries) throw new Error("Armory archive contains too many entries");
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (octalField(header.subarray(148, 156)) !== checksum) throw new Error("Invalid tar header checksum");
    const type = header[156] ?? 0;
    let size = octalField(header.subarray(124, 136));
    const prefix = stringField(header.subarray(345, 500));
    let entryPath = `${prefix ? `${prefix}/` : ""}${stringField(header.subarray(0, 100))}`;
    if (type !== 120 && pendingPax) {
      entryPath = pendingPax.get("path") ?? entryPath;
      const paxSize = pendingPax.get("size");
      if (paxSize !== undefined) {
        if (!/^[0-9]+$/u.test(paxSize)) throw new Error("Invalid tar PAX size");
        size = Number(paxSize);
      }
      pendingPax = undefined;
    }
    if (!Number.isSafeInteger(size) || size > ARMORY_ARCHIVE_LIMITS.fileBytes || offset + 512 + Math.ceil(size / 512) * 512 > archive.length) throw new Error("Armory archive entry exceeds its size limit or is truncated");
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 120) {
      if (pendingPax || size > MAX_ARMORY_MANIFEST_BYTES) throw new Error("Invalid tar PAX header");
      pendingPax = paxFields(data);
      continue;
    }
    if (type !== 0 && type !== 48 && type !== 53) throw new Error("Armory archives may only contain regular files and directories");
    if (type === 53 && size !== 0) throw new Error("Invalid tar directory");
    if (type === 53 && (entryPath === "." || entryPath === "./")) continue;
    const path = safeArmoryPath(entryPath);
    const folded = path.normalize("NFC").toLowerCase();
    if (names.has(folded)) throw new Error("Armory archive contains duplicate or conflicting paths");
    if (type !== 53 && parentPaths.has(folded)) throw new Error("Armory archive contains conflicting file paths");
    const segments = folded.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const parent = segments.slice(0, depth).join("/");
      if (names.get(parent) === "file") throw new Error("Armory archive contains conflicting file paths");
      parentPaths.add(parent);
    }
    names.set(folded, type === 53 ? "directory" : "file");
    if (type !== 53) files.set(path, data);
  }
  if (!ended || pendingPax) throw new Error("Armory tar archive is truncated");
  return files;
}

export interface ArmoryManifest {
  name: string;
  directoryName: string;
  commandNames: string[];
  kind: "alias" | "extension" | "bof";
  version: string;
  description: string;
  repoUrl: string;
  dependencies: string[];
  artifactPaths: string[];
  manifestFile: "alias.json" | "extension.json";
}
export function armoryRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Armory JSON object");
  return value as Record<string, unknown>;
}
export function armoryText(value: unknown, required = false): string {
  if (value === undefined || value === null) {
    if (!required) return "";
  }
  if (typeof value !== "string" || value.length > MAX_ARMORY_MANIFEST_BYTES || (required && !value.trim())) throw new Error("Invalid Armory text field");
  return value;
}
export function parseArmoryManifest(bytes: Uint8Array, isAlias: boolean): ArmoryManifest {
  if (bytes.length > MAX_ARMORY_MANIFEST_BYTES) throw new Error("Armory manifest exceeds its size limit");
  const raw = armoryRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
  const commands = !isAlias && Array.isArray(raw["commands"]) && raw["commands"].length ? raw["commands"].map(armoryRecord) : [raw];
  if (commands.length > 1_000) throw new Error("Armory manifest contains too many commands");
  const legacyExtension = !isAlias && commands[0] === raw;
  const name = legacyExtension ? armoryText(raw["command_name"], true) : armoryText(raw["name"], true);
  const commandNames = commands.map((command) => safeArmoryName(armoryText(command["command_name"], true)));
  if (new Set(commandNames).size !== commandNames.length) throw new Error("Duplicate Armory command names");
  const directoryName = safeArmoryName(isAlias ? commandNames[0]! : legacyExtension ? name : armoryText(raw["package_name"]) || name);
  const artifactPaths = new Set<string>();
  const dependencies = new Set<string>();
  let bof = false;
  const descriptions: string[] = [];
  for (const command of commands) {
    const description = armoryText(command["help"], true);
    if (description.length > 16_384) throw new Error("Armory package description exceeds its size limit");
    descriptions.push(description);
    const files = command["files"];
    if (!Array.isArray(files) || !files.length || files.length > 10_000) throw new Error("Armory manifest has no artifact files");
    for (const entry of files) {
      const file = armoryRecord(entry);
      armoryText(file["os"], true); armoryText(file["arch"], true);
      const path = safeArmoryPath(armoryText(file["path"], true), true);
      if (path === "alias.json" || path === "extension.json") throw new Error("Armory artifact conflicts with its manifest");
      artifactPaths.add(path);
      if (/\.(?:o|obj)$/iu.test(path)) bof = true;
    }
    const dependency = armoryText(command["depends_on"]);
    if (dependency) dependencies.add(safeArmoryName(dependency));
    const executor = armoryText(command["bof_executor"]);
    if (executor && executor !== "reflektor" && executor !== "coff-loader") throw new Error("Unknown Armory BOF executor in manifest");
    if (executor === "coff-loader" && !dependency) throw new Error("Armory BOF manifest is missing its dependency");
  }
  return { name, directoryName, commandNames, kind: isAlias ? "alias" : bof ? "bof" : "extension", version: armoryText(raw["version"]),
    description: descriptions[0] ?? "", repoUrl: armoryText(raw["repo_url"]), dependencies: [...dependencies], artifactPaths: [...artifactPaths],
    manifestFile: isAlias ? "alias.json" : "extension.json" };
}
