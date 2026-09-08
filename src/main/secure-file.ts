import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const READ_CHUNK_BYTES = 64 * 1024;

export interface SecureReadOptions {
  label: string;
  maxBytes: number;
  requirePrivateMode?: boolean;
}

export interface SecureFileRead {
  data: Buffer;
  modifiedAtMs: number;
  mode: number;
}

/** Opens a bounded regular file without following links and verifies the opened identity. */
export async function readBoundedRegularFile(path: string, options: SecureReadOptions): Promise<SecureFileRead> {
  validateLimit(options.maxBytes);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size > options.maxBytes) {
    throw new Error(`${options.label} must be a bounded regular file`);
  }
  assertPrivateMode(before.mode, options);

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  const chunks: Buffer[] = [];
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size > options.maxBytes ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      throw new Error(`${options.label} changed while being opened`);
    }
    assertPrivateMode(opened.mode, options);

    let total = 0;
    while (total <= options.maxBytes) {
      const remaining = options.maxBytes + 1 - total;
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > options.maxBytes) throw new Error(`${options.label} exceeds the size limit`);

    const after = await handle.stat();
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`${options.label} changed while being read`);
    }

    const data = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    return { data, modifiedAtMs: opened.mtimeMs, mode: opened.mode };
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
}

/** Writes a private file atomically in its destination directory and verifies its final mode. */
export async function writePrivateFileAtomic(path: string, data: Buffer, beforeCommit?: () => void): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Private-file destination must be a regular directory");
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    const stats = await handle.stat();
    assertPrivateMode(stats.mode, { label: "Imported configuration", maxBytes: data.length, requirePrivateMode: true });
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    await rename(temporaryPath, path);

    const final = await lstat(path);
    if (!final.isFile() || final.isSymbolicLink()) throw new Error("Imported configuration is not a regular file");
    assertPrivateMode(final.mode, { label: "Imported configuration", maxBytes: data.length, requirePrivateMode: true });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomically creates a private file without replacing any existing entry.
 * A hard-link commit gives the final name O_EXCL-style collision semantics
 * while keeping partial bytes hidden under a random temporary name.
 */
export async function writePrivateFileExclusiveAtomic(path: string, data: Buffer, beforeCommit?: () => void): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Private-file destination must be a regular directory");
  }
  if (process.platform !== "win32") await chmod(directory, 0o700);

  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  let destinationCreated = false;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    const stats = await handle.stat();
    assertPrivateMode(stats.mode, {
      label: "Imported configuration",
      maxBytes: Math.max(1, data.length),
      requirePrivateMode: true,
    });
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    await link(temporaryPath, path);
    destinationCreated = true;
    await unlink(temporaryPath);

    const final = await lstat(path);
    if (!final.isFile() || final.isSymbolicLink()) {
      throw new Error("Imported configuration is not a regular file");
    }
    assertPrivateMode(final.mode, {
      label: "Imported configuration",
      maxBytes: Math.max(1, data.length),
      requirePrivateMode: true,
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    if (destinationCreated) await unlink(path).catch(() => undefined);
    throw error;
  }
}

/**
 * Atomically writes an operator-selected artifact without changing the
 * destination directory's permissions. The parent must already exist (native
 * save dialogs only return paths in existing directories).
 */
export async function writePrivateArtifactFileAtomic(
  path: string,
  data: Buffer,
  beforeCommit?: () => void,
): Promise<void> {
  const directory = dirname(path);
  const directoryStats = await lstat(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error("Artifact destination must be a regular directory");
  }

  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(data);
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(0o600);
    const stats = await handle.stat();
    assertPrivateMode(stats.mode, { label: "Session artifact", maxBytes: Math.max(1, data.length), requirePrivateMode: true });
    await handle.close();
    handle = undefined;
    beforeCommit?.();
    await rename(temporaryPath, path);

    const final = await lstat(path);
    if (!final.isFile() || final.isSymbolicLink()) throw new Error("Session artifact is not a regular file");
    assertPrivateMode(final.mode, { label: "Session artifact", maxBytes: Math.max(1, data.length), requirePrivateMode: true });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export function assertPrivateMode(mode: number, options: SecureReadOptions): void {
  if (options.requirePrivateMode && process.platform !== "win32" && (mode & 0o7177) !== 0) {
    throw new Error(`${options.label} permissions must be private and non-executable (0600 or stricter)`);
  }
}

function validateLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Secure file size limit is invalid");
}
