import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clipboard, ClipboardItem } from "electron";
import { RDP_MAX_CLIPBOARD_FILES, RDP_MAX_CLIPBOARD_FILE_BYTES, RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, type RdpClipboardFile } from "../shared/rdp-contracts.js";

const MAX_FORMAT_BYTES = 1024 * 1024;
const MAX_PATH_LENGTH = 32_768;
const rawFormat = (format: string): string => `electron application/osclipboard;format="${format}"`;
const invalidFiles = (): Error => new Error("The clipboard does not contain a valid list of local files");

export interface RdpLocalClipboardFiles {
  readonly files: readonly RdpClipboardFile[];
  readonly signature: string;
  read(index: number, offset: number, length: number): Promise<Buffer>;
  close(): Promise<void>;
}

export interface RdpClipboardStaging {
  write(index: number, offset: number, bytes: Uint8Array): Promise<void>;
  /** Publishes only complete files and returns their local clipboard signature. */
  publish(beforeWrite?: () => void | Promise<void>): Promise<string>;
  /** The owner retains published staging until application shutdown. */
  dispose(): Promise<void>;
}

function fileNames(files: readonly RdpClipboardFile[]): void {
  if (files.length === 0 || files.length > RDP_MAX_CLIPBOARD_FILES) throw new Error(`Copy between 1 and ${RDP_MAX_CLIPBOARD_FILES} files at a time`);
  const names = new Set<string>();
  let total = 0;
  for (const file of files) {
    // File descriptors are basenames, never paths. Apply Windows restrictions on
    // every platform, including reserved device names and alternate data streams.
    if (!file.name || file.name.length > 255 || Buffer.byteLength(file.name, "utf8") > 255 ||
      /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(file.name) || /[. ]$/u.test(file.name) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(file.name) ||
      file.name === "." || file.name === ".." || file.name !== Buffer.from(file.name, "utf8").toString("utf8")) throw new Error("Clipboard files must have valid, portable file names");
    const key = file.name.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new Error("Clipboard file names must be unique");
    names.add(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid clipboard file size");
    total += file.size;
    if (total > RDP_MAX_CLIPBOARD_FILE_BYTES) throw new Error("Clipboard files exceed the 256 MiB total limit");
  }
}

function localPath(value: string, platform: NodeJS.Platform): string {
  const isWindows = platform === "win32";
  const paths = isWindows ? path.win32 : path.posix;
  if (!value || value.length > MAX_PATH_LENGTH || /[\x00-\x1f\x7f]/u.test(value) ||
    !paths.isAbsolute(value) || (isWindows && (!/^[a-z]:[\\/]/iu.test(value) || value.slice(2).includes(":")))) throw invalidFiles();
  return paths.normalize(value);
}

function fileUri(value: string, platform: NodeJS.Platform): string {
  const url = new URL(value);
  if (url.protocol !== "file:" || (url.hostname !== "" && url.hostname !== "localhost") || url.search || url.hash || url.username || url.password) throw invalidFiles();
  return localPath(fileURLToPath(url, { windows: platform === "win32" }), platform);
}

function uriList(value: string, platform: NodeJS.Platform, gnome = false): string[] {
  const lines = value.split(/\r?\n/u).filter((line) => line !== "" && !line.startsWith("#"));
  if (gnome && !["copy", "cut"].includes(lines.shift() ?? "")) throw invalidFiles();
  if (lines.length > RDP_MAX_CLIPBOARD_FILES) throw invalidFiles();
  return lines.map((line) => fileUri(line, platform));
}

async function formatBytes(item: Electron.ClipboardItem, type: string): Promise<Buffer> {
  const value = await item.getType(type);
  if (!(value instanceof Blob) || value.size > MAX_FORMAT_BYTES) throw invalidFiles();
  return Buffer.from(await value.arrayBuffer());
}

async function clipboardPaths(platform: NodeJS.Platform): Promise<string[] | undefined> {
  const items = await clipboard.read();
  if (items.length > RDP_MAX_CLIPBOARD_FILES) throw invalidFiles();
  const paths: string[] = [];
  let found = false;
  for (const item of items) {
    // Electron 44 translates native copied-file formats to text/uri-list on
    // Windows, macOS, and Linux. Keep OS serialization inside Electron.
    // https://www.electronjs.org/docs/latest/api/clipboard-item#files-the-texturi-list-mime-type
    const supported = platform === "linux" ? ["text/uri-list", "x-special/gnome-copied-files", rawFormat("x-special/gnome-copied-files")] : ["text/uri-list"];
    const type = supported.find((candidate) => item.types.includes(candidate));
    if (!type) continue;
    found = true;
    const bytes = await formatBytes(item, type);
    const names = uriList(bytes.toString("utf8"), platform, type.includes("x-special/gnome-copied-files"));
    for (const name of names) if (!paths.includes(name)) paths.push(name);
    if (paths.length > RDP_MAX_CLIPBOARD_FILES) throw invalidFiles();
  }
  return found ? paths : undefined;
}

function identity(stat: Stats): string { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; }
function signature(paths: readonly string[], stats: readonly Stats[]): string {
  return createHash("sha256").update(JSON.stringify(paths.map((file, index) => [file, identity(stats[index]!)]))).digest("base64");
}

/** File-system paths and handles never leave Electron main. */
export async function readRdpClipboardFiles(platform: NodeJS.Platform = process.platform): Promise<RdpLocalClipboardFiles | undefined> {
  const paths = await clipboardPaths(platform);
  if (!paths) return undefined;
  const stats = await Promise.all(paths.map((file) => lstat(file)));
  if (stats.some((stat) => !stat.isFile())) throw new Error("Clipboard file transfer supports regular files only; folders and symbolic links are not supported");
  const files = paths.map((file, index) => ({ name: (platform === "win32" ? path.win32 : path.posix).basename(file), size: stats[index]!.size }));
  fileNames(files);
  const handles = new Map<number, FileHandle>();
  let closed = false, queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(operation); queue = result.then(() => {}, () => {}); return result; };
  return {
    files, signature: signature(paths, stats),
    read: (index, offset, length) => enqueue(async () => {
      const file = files[index];
      if (closed) throw new Error("Clipboard files are no longer available");
      if (!Number.isSafeInteger(index) || !file || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 ||
        length > RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES || offset > file.size || length > file.size - offset) throw new Error("Invalid clipboard file range");
      let handle = handles.get(index);
      if (!handle) {
        const current = await lstat(paths[index]!);
        if (!current.isFile() || identity(current) !== identity(stats[index]!)) throw new Error("A copied file changed; copy it again before pasting");
        handle = await open(paths[index]!, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        handles.set(index, handle);
      }
      if (identity(await handle.stat()) !== identity(stats[index]!)) throw new Error("A copied file changed; copy it again before pasting");
      const bytes = Buffer.alloc(length);
      let completed = 0;
      while (completed < length) {
        const result = await handle.read(bytes, completed, length - completed, offset + completed);
        if (result.bytesRead === 0) throw new Error("A copied file changed; copy it again before pasting");
        completed += result.bytesRead;
      }
      if (identity(await handle.stat()) !== identity(stats[index]!)) throw new Error("A copied file changed; copy it again before pasting");
      return bytes;
    }),
    close: () => enqueue(async () => { closed = true; await Promise.all([...handles.values()].map((handle) => handle.close())); handles.clear(); }),
  };
}

async function writePaths(paths: readonly string[], platform: NodeJS.Platform): Promise<void> {
  const urls = paths.map((file) => pathToFileURL(file).href);
  const formats: Record<string, Blob> = { "text/uri-list": new Blob([`${urls.join("\r\n")}\r\n`]) };
  if (platform === "linux") formats["x-special/gnome-copied-files"] = new Blob([`copy\n${urls.join("\n")}`]);
  await clipboard.write([new ClipboardItem(formats)]);
}

/** Receive into a private temporary directory; incomplete transfers are never published. */
export async function createRdpClipboardStaging(input: readonly RdpClipboardFile[], platform: NodeJS.Platform = process.platform): Promise<RdpClipboardStaging> {
  const files = input.map(({ name, size }) => ({ name, size }));
  fileNames(files);
  const directory = await mkdtemp(path.join(tmpdir(), "sliver-rdp-clipboard-"));
  const handles: FileHandle[] = [], paths = files.map((file) => path.join(directory, file.name));
  try {
    await chmod(directory, 0o700);
    for (const file of paths) handles.push(await open(file, "wx", 0o600));
  } catch (error) { await Promise.all(handles.map((handle) => handle.close())); await rm(directory, { recursive: true, force: true }); throw error; }
  const positions = files.map(() => 0);
  let disposed = false, published = false, sealed = false, publishedSignature = "", queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(operation); queue = result.then(() => {}, () => {}); return result; };
  const close = async (): Promise<void> => { if (!sealed) { sealed = true; await Promise.all(handles.map((handle) => handle.close())); } };
  return {
    write: (index, offset, inputBytes) => {
      if (inputBytes.byteLength === 0 || inputBytes.byteLength > RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES) return Promise.reject(new Error("Invalid clipboard file chunk"));
      const bytes = Buffer.from(inputBytes);
      return enqueue(async () => {
        const file = files[index];
        if (disposed || sealed) throw new Error("Clipboard transfer is closed");
        if (!Number.isSafeInteger(index) || !file || !Number.isSafeInteger(offset) || offset !== positions[index] || bytes.length === 0 ||
          bytes.length > RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES || bytes.length > file.size - offset) throw new Error("Invalid clipboard file chunk");
        let written = 0;
        while (written < bytes.length) {
          const result = await handles[index]!.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error("Unable to write clipboard file");
          written += result.bytesWritten;
        }
        positions[index] = offset + written;
      });
    },
    publish: (beforeWrite) => enqueue(async () => {
      if (disposed) throw new Error("Clipboard transfer is closed");
      if (published) return publishedSignature;
      if (positions.some((position, index) => position !== files[index]!.size)) throw new Error("Clipboard files have not finished transferring");
      await close();
      publishedSignature = signature(paths, await Promise.all(paths.map((file) => lstat(file))));
      await beforeWrite?.();
      await writePaths(paths, platform); published = true;
      return publishedSignature;
    }),
    dispose: () => enqueue(async () => { if (disposed) return; disposed = true; await close(); await rm(directory, { recursive: true, force: true }); }),
  };
}
