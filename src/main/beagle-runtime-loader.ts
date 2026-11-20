import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import { BEAGLE_RUNTIME_PROTOCOL } from "../shared/beagle-runtime-contracts.js";
import { executeNativeVerification, readBundledNativeFile, verifySameApplicationSigner, type NativeVerificationCommand } from "./native-runtime-loader.js";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/iu;
const FAILURE = "The Beagle executable could not be verified. Choose the executable again or check the configured SHA-256.";
const BUNDLED_FAILURE = "The bundled Beagle runtime could not be verified. Rebuild or reinstall Sliver GUI.";
const ENVIRONMENT_KEYS = new Set([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "LC_COLLATE", "LC_MONETARY", "LC_NUMERIC",
  "LC_TIME", "LC_PAPER", "LC_NAME", "LC_ADDRESS", "LC_TELEPHONE", "LC_MEASUREMENT", "LC_IDENTIFICATION", "TZ",
]);

export interface BeagleExecutableIdentity {
  path: string;
  sha256: string;
  size: number;
}

export interface BeagleExecutableVerifier {
  capture(path: string): Promise<BeagleExecutableIdentity>;
  verify(path: string, sha256: string): Promise<BeagleExecutableIdentity>;
}

export interface ResolveVerifiedBeagleRuntimeOptions {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly developmentRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Test seam; production invokes only the bundled helper and fixed OS verifiers. */
  readonly execute?: NativeVerificationCommand;
}

/** Resolve the build-pinned helper before the service probes its protocol and query capabilities. */
export async function resolveVerifiedBeagleRuntime(options: ResolveVerifiedBeagleRuntimeOptions): Promise<BeagleExecutableIdentity> {
  try {
    const platform = options.platform ?? process.platform;
    const architecture = options.architecture ?? process.arch;
    const triple = platform === "darwin" && architecture === "arm64" ? "aarch64-apple-darwin"
      : platform === "darwin" && architecture === "x64" ? "x86_64-apple-darwin"
        : platform === "win32" && architecture === "x64" ? "x86_64-pc-windows-gnu"
          : platform === "linux" && architecture === "x64" ? "x86_64-unknown-linux-gnu" : undefined;
    if (!triple || !isAbsolute(options.resourcesPath) || !isAbsolute(options.developmentRoot)) throw new Error(BUNDLED_FAILURE);
    const root = options.isPackaged ? options.resourcesPath : options.developmentRoot;
    const directory = options.isPackaged ? join(root, "beagle") : join(root, "native/beagle/bin");
    const sourcePath = options.isPackaged ? join(root, "app.asar/protocol/beagle-provenance.json") : join(root, "protocol/beagle-provenance.json");
    const [sourceBytes, copiedSource, recordBytes] = await Promise.all([
      readBundledNativeFile(root, sourcePath, 128 * 1024, options.isPackaged),
      readBundledNativeFile(root, join(directory, "source-provenance.json"), 128 * 1024),
      readBundledNativeFile(root, join(directory, "provenance.json"), 2 * 1024 * 1024),
    ]);
    if (!sourceBytes.equals(copiedSource)) throw new Error(BUNDLED_FAILURE);
    if (options.isPackaged && !recordBytes.equals(await readBundledNativeFile(root,
      join(root, "app.asar/native/beagle/packaged-provenance.json"), 2 * 1024 * 1024, true))) throw new Error(BUNDLED_FAILURE);
    const manifest = record(JSON.parse(sourceBytes.toString("utf8")));
    const source = record(manifest["source"]);
    const provenance = record(JSON.parse(recordBytes.toString("utf8")));
    const artifact = record(provenance["artifact"]);
    const build = record(provenance["build"]);
    const slices = build["slices"];
    const inputs = provenance["inputs"];
    const buildIdentity = provenance["buildIdentity"];
    const filename = platform === "win32" ? "beagle.exe" : "beagle";
    const expectedTarget = platform === "darwin" ? "darwin-universal" : platform === "win32" ? "windows-x64" : "linux-x64";
    if (manifest["schemaVersion"] !== 1 || manifest["protocolVersion"] !== BEAGLE_RUNTIME_PROTOCOL ||
        typeof manifest["version"] !== "string" || !/^0\.1\.\d+$/u.test(manifest["version"]) ||
        source["repository"] !== "https://github.com/sliverarmory/Beagle" || typeof source["commit"] !== "string" || !/^[a-f0-9]{40}$/u.test(source["commit"]) ||
        typeof source["tree"] !== "string" || !/^[a-f0-9]{40}$/u.test(source["tree"]) ||
        provenance["schemaVersion"] !== 1 || provenance["protocolVersion"] !== BEAGLE_RUNTIME_PROTOCOL ||
        JSON.stringify(provenance["source"]) !== JSON.stringify(source) || provenance["sourceManifestSha256"] !== digest(sourceBytes) ||
        typeof buildIdentity !== "string" || !SHA256.test(buildIdentity) || artifact["fileName"] !== filename ||
        !Array.isArray(inputs) || inputs.length === 0 || buildIdentity !== digest(Buffer.from(JSON.stringify({ manifest, inputs }))) ||
        typeof artifact["sha256"] !== "string" || !SHA256.test(artifact["sha256"]) ||
        !Number.isSafeInteger(artifact["size"]) || (artifact["size"] as number) <= 0 || (artifact["size"] as number) > MAX_EXECUTABLE_BYTES ||
        !Array.isArray(slices) || !slices.some((slice: unknown) => record(slice)["target"] === triple) ||
        (options.isPackaged && (build["target"] !== expectedTarget || slices.length !== (platform === "darwin" ? 2 : 1)))) throw new Error(BUNDLED_FAILURE);
    const executablePath = join(directory, filename);
    const [canonicalRoot, identity] = await Promise.all([realpath(root), executableIdentity(executablePath)]);
    if (!identity.path.startsWith(`${canonicalRoot}${sep}`)) throw new Error(BUNDLED_FAILURE);
    const run = options.execute ?? executeNativeVerification;
    const commandOptions = { timeout: 15_000, maxBuffer: 16 * 1024, env: beagleRuntimeEnvironment() };
    if (identity.sha256 !== artifact["sha256"] || identity.size !== artifact["size"]) {
      if (!options.isPackaged || platform === "linux") throw new Error(BUNDLED_FAILURE);
      await verifySameApplicationSigner(platform, options.resourcesPath, identity.path, run, commandOptions);
      await verifyBeagleExecutable(identity.path, identity.sha256);
    }
    const info = record(JSON.parse(await run(identity.path, ["--build-info"], commandOptions)));
    if (info["name"] !== "beagle" || info["protocol"] !== BEAGLE_RUNTIME_PROTOCOL || info["beagleRevision"] !== source["commit"] ||
        info["version"] !== manifest["version"] || info["target"] !== triple) throw new Error(BUNDLED_FAILURE);
    // Signing changes bytes; retain the verified installed digest for every subsequent launch.
    await verifyBeagleExecutable(identity.path, identity.sha256);
    return identity;
  } catch { throw new Error(BUNDLED_FAILURE); }
}

function digest(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(BUNDLED_FAILURE);
  return value as Record<string, unknown>;
}

/** Absolute helpers do not need PATH, loader overrides, or the application's credentials. */
export function beagleRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    value !== undefined && ENVIRONMENT_KEYS.has(key.toUpperCase())));
}

/** Capture trust only after the operator explicitly selects this executable in a native dialog. */
export async function captureBeagleExecutable(path: string): Promise<BeagleExecutableIdentity> {
  try { return await executableIdentity(path); }
  catch { throw new Error(FAILURE); }
}

/** Recheck the selected/configured pin immediately before each process launch. */
export async function verifyBeagleExecutable(path: string, sha256: string): Promise<BeagleExecutableIdentity> {
  try {
    if (typeof sha256 !== "string" || sha256.length !== 64 || !SHA256.test(sha256)) throw new Error(FAILURE);
    const identity = await executableIdentity(path);
    if (!timingSafeEqual(Buffer.from(identity.sha256, "hex"), Buffer.from(sha256, "hex"))) throw new Error(FAILURE);
    return identity;
  } catch { throw new Error(FAILURE); }
}

export const beagleExecutableVerifier: BeagleExecutableVerifier = Object.freeze({
  capture: captureBeagleExecutable,
  verify: verifyBeagleExecutable,
});

async function executableIdentity(path: string): Promise<BeagleExecutableIdentity> {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4_096 || /[\x00-\x1f\x7f]/u.test(path)) {
    throw new Error(FAILURE);
  }
  // Reject a selected final symlink before canonicalizing parent-directory aliases such as /tmp.
  const selected = await lstat(path, { bigint: true });
  assertExecutable(selected);
  const canonicalPath = await realpath(path);
  const before = await lstat(canonicalPath, { bigint: true });
  assertExecutable(before);
  if (!sameFile(selected, before)) throw new Error(FAILURE);

  // O_NONBLOCK also prevents a file-to-FIFO replacement from blocking the main process on open.
  const flags = constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await open(canonicalPath, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    assertExecutable(opened);
    if (!sameFile(before, opened)) throw new Error(FAILURE);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let size = 0;
    while (size <= MAX_EXECUTABLE_BYTES) {
      const length = Math.min(buffer.length, MAX_EXECUTABLE_BYTES + 1 - size);
      const { bytesRead } = await handle.read(buffer, 0, length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > MAX_EXECUTABLE_BYTES) throw new Error(FAILURE);
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    assertExecutable(after);
    if (!sameFile(opened, after) || BigInt(size) !== opened.size) throw new Error(FAILURE);

    // fstat alone would miss renaming another file over the path while the old descriptor is open.
    const finalSelected = await lstat(path, { bigint: true });
    const finalCanonical = await lstat(canonicalPath, { bigint: true });
    assertExecutable(finalSelected);
    assertExecutable(finalCanonical);
    if (!sameFile(opened, finalSelected) || !sameFile(opened, finalCanonical) || (await realpath(path)) !== canonicalPath) {
      throw new Error(FAILURE);
    }
    return { path: canonicalPath, sha256: hash.digest("hex"), size };
  } finally { await handle.close(); }
}

function assertExecutable(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size <= 0n || stats.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    throw new Error(FAILURE);
  }
  // Group-managed installations may be writable by their trusted group. Public writes and
  // privilege-changing executable bits are unnecessary for this user-level helper.
  if (process.platform !== "win32" && ((stats.mode & 0o111n) === 0n || (stats.mode & 0o6002n) !== 0n)) {
    throw new Error(FAILURE);
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
