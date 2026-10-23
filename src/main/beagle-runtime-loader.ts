import { createHash, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";

const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SHA256 = /^[a-f0-9]{64}$/iu;
const FAILURE = "The Beagle executable could not be verified. Choose the executable again or check the configured SHA-256.";
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
