import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sliverpb } from "sliver-script";

import type { BofArgumentDefinition, BofCatalog, BofCommand, BofExecutionOutput } from "../shared/bof-contracts.js";
import type { TargetRef, TargetSummary } from "../shared/target-contracts.js";
import { armoryRecord, armoryText, parseArmoryManifest, safeArmoryName, safeArmoryPath } from "./armory-archive.js";
import { MAX_ARMORY_MANIFEST_BYTES } from "./armory-signature.js";
import { readBoundedRegularFile } from "./secure-file.js";
import { readInstalledBofLoader } from "./bof-legacy-dispatch.js";

const MAX_INSTALLED = 5_000;
const MAX_ARGUMENTS = 128;
const MAX_OBJECT_BYTES = 16 * 1_024 * 1_024;
export const MAX_BOF_ARGUMENT_FILE_BYTES = 16 * 1_024 * 1_024;
export const MAX_BOF_OUTPUT_BYTES = 1 * 1_024 * 1_024;

export interface InstalledBofCommand {
  readonly dto: BofCommand;
  readonly packageDirectory: string;
  readonly objectPath?: string;
  readonly entrypoint: string;
  readonly arguments: readonly BofArgumentDefinition[];
  readonly mode: "reflektor" | "coff-loader";
  readonly dependencyName?: string;
}

export interface BofDirectoryCommands {
  readonly entries: InstalledBofCommand[];
  readonly manifestDigest: string;
}

async function realDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Armory directory is not a regular directory");
}

function isFileSystemError(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && typeof error.code === "string";
}

function architecture(value: string): string {
  switch (value.trim().toLowerCase()) {
    case "x64": case "x86_64": return "amd64";
    case "x86": case "i386": case "i686": return "386";
    case "aarch64": return "arm64";
    default: return value.trim().toLowerCase();
  }
}

function manifestArguments(value: unknown): BofArgumentDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) throw new Error("Invalid BOF manifest arguments");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const raw = armoryRecord(entry);
    const name = armoryText(raw["name"], true);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(name) || names.has(name)) throw new Error("Invalid or duplicate BOF argument name");
    names.add(name);
    const type = raw["type"];
    if (type !== "string" && type !== "wstring" && type !== "int" && type !== "integer" && type !== "short" && type !== "file") {
      throw new Error(`Unsupported BOF argument type at index ${index}`);
    }
    const optional = raw["optional"] === true;
    if (raw["optional"] !== undefined && typeof raw["optional"] !== "boolean") throw new Error("Invalid BOF optional argument declaration");
    const description = armoryText(raw["desc"] ?? "");
    if (description.length > 4_096) throw new Error("BOF argument description exceeds its limit");
    const defaultValue = raw["default"];
    if (defaultValue !== undefined && !(typeof defaultValue === "string" ||
      (typeof defaultValue === "number" && Number.isSafeInteger(defaultValue)))) throw new Error("Invalid BOF default argument");
    const choices = raw["choices"];
    if (choices !== undefined && (!Array.isArray(choices) || choices.length > 128 ||
      choices.some((choice: unknown) => !(typeof choice === "string" ||
        (typeof choice === "number" && Number.isSafeInteger(choice)))))) throw new Error("Invalid BOF argument choices");
    return {
      name, description, type, optional,
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      ...(choices === undefined ? {} : { choices: choices as (string | number)[] }),
    };
  });
}

/** Read one Armory-style BOF package without exposing its path to the renderer. */
async function readBofPackage(
  root: string,
  packageDirectory: string,
  namespace: string,
  target: TargetSummary,
  supportsBuiltInBof: boolean,
  installedDirectoryName?: string,
  loaderAvailability = new Map<string, string | null>(),
): Promise<BofDirectoryCommands | null> {
  await realDirectory(packageDirectory);
  const bytes = (await readBoundedRegularFile(join(packageDirectory, "extension.json"), {
    label: "Armory manifest", maxBytes: MAX_ARMORY_MANIFEST_BYTES,
  })).data;
  try {
    const manifest = parseArmoryManifest(bytes, false);
    if (installedDirectoryName && manifest.directoryName !== installedDirectoryName) return null;
    if (manifest.kind !== "bof") {
      if (installedDirectoryName) return null;
      throw new Error("The selected directory does not contain an Armory BOF package");
    }
    const manifestDigest = createHash("sha256").update(bytes).digest("hex");
    const raw = armoryRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    const commands = Array.isArray(raw["commands"]) && raw["commands"].length
      ? raw["commands"].map(armoryRecord) : [raw];
    const entries: InstalledBofCommand[] = [];
    for (const command of commands) {
      const commandName = safeArmoryName(armoryText(command["command_name"], true));
      const files = command["files"];
      if (!Array.isArray(files)) throw new Error("BOF manifest has no files");
      const selected = files.map(armoryRecord).find((file) =>
        armoryText(file["os"]).toLowerCase() === target.os.trim().toLowerCase() &&
        architecture(armoryText(file["arch"])) === architecture(target.arch));
      const objectPath = selected ? safeArmoryPath(armoryText(selected["path"], true), true) : undefined;
      const isObject = objectPath !== undefined && /\.(?:o|obj)$/iu.test(objectPath);
      if (!isObject && !files.some((file) => /\.(?:o|obj)$/iu.test(armoryText(armoryRecord(file)["path"])))) continue;
      const executor = armoryText(command["bof_executor"]);
      const supportedExecutor = executor === "" || executor === "coff-loader" || executor === "reflektor";
      const dependencyName = armoryText(command["depends_on"]);
      const usesLegacyLoader = executor === "coff-loader" ||
        (executor === "" && !!dependencyName) ||
        (executor === "reflektor" && !supportsBuiltInBof && !!dependencyName);
      let loaderError: string | undefined;
      if (usesLegacyLoader && objectPath && isObject) {
        const cached = loaderAvailability.get(dependencyName);
        if (cached !== undefined) loaderError = cached ?? undefined;
        else {
          try {
            const loader = await readInstalledBofLoader(root, dependencyName, target);
            loader.data.fill(0);
            loaderAvailability.set(dependencyName, null);
          } catch (error) {
            loaderError = isFileSystemError(error) ? "Loader files could not be read"
              : error instanceof Error ? error.message : "The Armory loader is unavailable";
            loaderAvailability.set(dependencyName, loaderError);
          }
        }
      }
      const available = !!objectPath && isObject && supportedExecutor && (usesLegacyLoader ? !loaderError : supportsBuiltInBof);
      const reason = !objectPath ? "No BOF object matches this target's OS and architecture."
        : !isObject ? "This target artifact is not a BOF object."
          : !supportedExecutor ? "This BOF manifest declares an unsupported executor."
            : usesLegacyLoader && loaderError ? `The required Armory loader is unavailable: ${loaderError}`
            : !usesLegacyLoader && !supportsBuiltInBof ? "This target does not advertise built-in BOF execution." : undefined;
      const args = manifestArguments(command["arguments"]);
      const entrypoint = armoryText(command["entrypoint"], true);
      if (entrypoint.length > 256 || /[\u0000-\u001f\u007f]/u.test(entrypoint)) throw new Error("Invalid BOF entrypoint");
      const dto: BofCommand = {
        id: `${namespace}/${commandName}`,
        packageName: manifest.name,
        commandName,
        description: armoryText(command["help"]),
        arguments: args,
        available,
        ...(reason ? { reason } : {}),
      };
      entries.push({ dto, packageDirectory, ...(objectPath ? { objectPath } : {}), entrypoint, arguments: args,
        mode: usesLegacyLoader ? "coff-loader" : "reflektor",
        ...(usesLegacyLoader ? { dependencyName } : {}),
      });
    }
    return { entries, manifestDigest };
  } finally {
    bytes.fill(0);
  }
}

export async function readBofCommandsFromDirectory(
  root: string,
  directory: string,
  namespace: string,
  target: TargetSummary,
  _targetRef: TargetRef,
  supportsBuiltInBof: boolean,
): Promise<BofDirectoryCommands> {
  safeArmoryName(namespace);
  let result: BofDirectoryCommands | null;
  try { result = await readBofPackage(root, directory, namespace, target, supportsBuiltInBof); }
  catch (error) {
    if (isFileSystemError(error)) throw new Error("The selected BOF directory or manifest could not be read");
    throw error;
  }
  if (!result || !result.entries.length) throw new Error("The selected directory contains no BOF commands");
  return result;
}

/** Enumerates only main-owned, locally installed Armory extensions. */
export async function installedBofCommands(
  root: string,
  target: TargetSummary,
  targetRef: TargetRef,
  supportsBuiltInBof: boolean,
): Promise<{ catalog: BofCatalog; entries: InstalledBofCommand[] }> {
  const warnings: string[] = [];
  const entries: InstalledBofCommand[] = [];
  const loaderAvailability = new Map<string, string | null>();
  const extensions = join(root, "extensions");
  try { await realDirectory(root); await realDirectory(extensions); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { catalog: { target: { ...targetRef }, commands: [], warnings }, entries };
    }
    throw error;
  }
  const names = await readdir(extensions);
  if (names.length > MAX_INSTALLED) throw new Error("Too many installed Armory extensions");
  for (const directoryName of names.sort()) {
    try {
      safeArmoryName(directoryName);
      const packageDirectory = join(extensions, directoryName);
      const result = await readBofPackage(root, packageDirectory, directoryName, target, supportsBuiltInBof, directoryName, loaderAvailability);
      if (result) entries.push(...result.entries);
    } catch (error) {
      warnings.push(`Could not read extensions/${directoryName}: ${error instanceof Error ? error.message : "invalid package"}`);
    }
  }
  return { catalog: { target: { ...targetRef }, commands: entries.map((entry) => entry.dto), warnings }, entries };
}

export async function readInstalledBofObject(entry: InstalledBofCommand): Promise<Buffer> {
  if (!entry.dto.available || !entry.objectPath) throw new Error(entry.dto.reason ?? "The selected BOF is unavailable");
  try {
    let current = entry.packageDirectory;
    await realDirectory(current);
    const parts = entry.objectPath.split("/");
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      await realDirectory(current);
    }
    const bytes = (await readBoundedRegularFile(join(current, parts.at(-1)!), {
      label: "BOF object", maxBytes: MAX_OBJECT_BYTES,
    })).data;
    if (!bytes.length) throw new Error("The selected BOF object is empty");
    return bytes;
  } catch (error) {
    if (isFileSystemError(error)) throw new Error("The selected BOF object could not be read");
    throw error;
  }
}

/** Matches Sliver's core.BOFArgsBuffer framing, including optional zero values. */
export function packBofArguments(
  definitions: readonly BofArgumentDefinition[],
  values: readonly (string | number | null)[],
  files: ReadonlyMap<number, Buffer> = new Map(),
): Buffer {
  if (definitions.length !== values.length) throw new Error("BOF argument count does not match its manifest");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index]!;
      let value = values[index];
      if (value === null) {
        if (!definition.optional) throw new Error(`${definition.name} is required`);
        value = definition.default ?? (definition.type === "int" || definition.type === "integer" || definition.type === "short" ? 0 : "");
      }
      if (definition.choices?.length && !definition.choices.some((choice) => String(choice) === String(value))) {
        throw new Error(`${definition.name} must be one of the manifest choices`);
      }
      let chunk: Buffer;
      if (definition.type === "file") {
        if (value !== "" && typeof value !== "string") throw new Error(`${definition.name} requires a selected local file`);
        const data = value === "" ? Buffer.alloc(0) : files.get(index);
        if (!data || data.length > MAX_BOF_ARGUMENT_FILE_BYTES) throw new Error(`${definition.name} requires a selected local file`);
        chunk = lengthPrefixed(data);
      } else if (definition.type === "string" || definition.type === "wstring") {
        if (typeof value !== "string" || value.length > 65_536 || value.includes("\0")) throw new Error(`${definition.name} must be text`);
        const data = definition.type === "wstring" ? Buffer.from(`${value}\0`, "utf16le") : Buffer.from(`${value}\0`, "utf8");
        try { chunk = lengthPrefixed(data); }
        finally { data.fill(0); }
      } else {
        const numeric = typeof value === "number" ? value : typeof value === "string" && /^-?\d+$/u.test(value) ? Number(value) : NaN;
        if (!Number.isSafeInteger(numeric) || numeric < (definition.type === "short" ? -32_768 : -2_147_483_648) ||
          numeric > (definition.type === "short" ? 65_535 : 4_294_967_295)) throw new Error(`${definition.name} is outside its integer range`);
        chunk = Buffer.alloc(definition.type === "short" ? 2 : 4);
        if (definition.type === "short") chunk.writeUInt16LE(numeric & 0xffff);
        else chunk.writeUInt32LE(numeric >>> 0);
      }
      chunks.push(chunk);
      total += chunk.length;
      if (total > 32 * 1_024 * 1_024) throw new Error("BOF arguments exceed the size limit");
    }
    const body = Buffer.concat(chunks, total);
    try { return lengthPrefixed(body); }
    finally { body.fill(0); }
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function lengthPrefixed(bytes: Buffer): Buffer {
  const output = Buffer.alloc(4 + bytes.length);
  output.writeUInt32LE(bytes.length, 0);
  bytes.copy(output, 4);
  return output;
}

export function decodeBofOutput(response: sliverpb.CallExtension): { stdout?: BofExecutionOutput; stderr?: BofExecutionOutput } {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const records = response.BOFOutputs?.length ? response.BOFOutputs : response.Output?.length
    ? [{ Type: 0, Data: response.Output }] : [];
  for (const item of records) {
    if (!Number.isInteger(item.Type) || !Buffer.isBuffer(item.Data)) throw new Error("Invalid BOF output record");
    (item.Type === 0x0d ? stderr : stdout).push(item.Data);
  }
  const output = (chunks: Buffer[]): BofExecutionOutput | undefined => {
    if (!chunks.length) return undefined;
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const data = Buffer.alloc(Math.min(total, MAX_BOF_OUTPUT_BYTES));
    let offset = 0;
    for (const chunk of chunks) {
      const length = Math.min(chunk.length, data.length - offset);
      if (length <= 0) break;
      chunk.copy(data, offset, 0, length);
      offset += length;
    }
    return { data, truncated: total > data.length };
  };
  const stdoutOutput = output(stdout);
  const stderrOutput = output(stderr);
  return { ...(stdoutOutput ? { stdout: stdoutOutput } : {}), ...(stderrOutput ? { stderr: stderrOutput } : {}) };
}

export function decodeBofTask(bytes: Uint8Array): sliverpb.CallExtension {
  if (!bytes.length || bytes.length > MAX_BOF_OUTPUT_BYTES * 4) throw new Error("BOF task response is empty or too large");
  return sliverpb.CallExtension.decode(bytes);
}
