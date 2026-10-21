// @vitest-environment node
import { mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RDP_MAX_CLIPBOARD_FILE_BYTES, RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES, RDP_MAX_CLIPBOARD_FILES } from "../shared/rdp-contracts.js";
import { createRdpClipboardStaging, readRdpClipboardFiles, type RdpClipboardStaging, type RdpLocalClipboardFiles } from "./rdp-file-clipboard.js";

const mocks = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("electron", () => ({
  clipboard: mocks,
  ClipboardItem: class {
    readonly types: string[];
    constructor(readonly formats: Record<string, Blob>) { this.types = Object.keys(formats); }
    async getType(type: string): Promise<Blob> { const value = this.formats[type]; if (!value) throw new Error("Missing format"); return value; }
  },
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, lstat: vi.fn(original.lstat), open: vi.fn(original.open) };
});

const raw = (name: string): string => `electron application/osclipboard;format="${name}"`;
const directories: string[] = [];
const sources: RdpLocalClipboardFiles[] = [], staging: RdpClipboardStaging[] = [];
beforeEach(() => { mocks.read.mockReset().mockResolvedValue([]); mocks.write.mockReset().mockResolvedValue(undefined); vi.mocked(fs.open).mockClear(); });
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(sources.splice(0).map((source) => source.close()));
  await Promise.all(staging.splice(0).map((stage) => stage.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function item(formats: Record<string, string | Buffer>): Electron.ClipboardItem {
  return { types: Object.keys(formats), getType: async (type: string) => new Blob([formats[type] as string]) } as Electron.ClipboardItem;
}
async function fixture(name = "sample.txt", value = "hello world"): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "rdp-file-clipboard-test-")); directories.push(directory);
  const file = path.join(directory, name); await writeFile(file, value); return file;
}
async function source(platform: NodeJS.Platform = process.platform): Promise<RdpLocalClipboardFiles> {
  const result = await readRdpClipboardFiles(platform);
  if (!result) throw new Error("Missing fixture source");
  sources.push(result); return result;
}
async function stage(files = [{ name: "remote.txt", size: 5 }], platform: NodeJS.Platform = process.platform): Promise<RdpClipboardStaging> {
  const result = await createRdpClipboardStaging(files, platform); staging.push(result); return result;
}
async function publishedFiles(): Promise<string[]> {
  const entries = mocks.write.mock.calls.at(-1)?.[0] as Electron.ClipboardItem[];
  const value = await entries[0]!.getType("text/uri-list") as Blob;
  return (await value.text()).trim().split("\r\n").map((url) => fileURLToPath(url));
}

describe("RDP native file clipboard", () => {
  it("ignores ordinary text and does not infer paths from text selections", async () => {
    mocks.read.mockResolvedValue([item({ "text/plain": "/etc/passwd" })]);
    expect(await readRdpClipboardFiles("linux")).toBeUndefined();
  });

  it.each(["x-special/gnome-copied-files", raw("x-special/gnome-copied-files")])("reads explicit Linux %s selections", async (format) => {
    const file = await fixture("héllo space.txt");
    mocks.read.mockResolvedValue([item({ [format]: `${format.includes("gnome") ? "copy\n" : "# Files\r\n"}${pathToFileURL(file).href}\r\n` })]);
    const realStat = await stat(file);
    vi.mocked(fs.lstat).mockResolvedValueOnce(realStat as never);
    const files = await source("linux");
    expect(files.files).toEqual([{ name: "héllo space.txt", size: 11 }]);
  });

  it.each(["darwin", "win32", "linux"] as const)("reads native copied files through Electron's URI mapping on %s", async (platform) => {
    const existing = await fixture();
    const realStat = await stat(existing);
    vi.mocked(fs.lstat).mockResolvedValueOnce(realStat as never).mockResolvedValueOnce(realStat as never);
    const first = platform === "win32" ? "file:///C:/Users/test/r%C3%A9sum%C3%A9.txt" : "file:///home/test/r%C3%A9sum%C3%A9.txt";
    const second = platform === "win32" ? "file:///C:/Users/test/second.txt" : "file:///home/test/second.txt";
    mocks.read.mockResolvedValue([item({ "text/uri-list": `${first}\r\n${second}\r\n` })]);
    expect((await source(platform)).files).toEqual([{ name: "résumé.txt", size: 11 }, { name: "second.txt", size: 11 }]);
  });

  it("prefers Electron's normalized URI format when a Linux file manager also offers GNOME data", async () => {
    const file = await fixture();
    const realStat = await stat(file); vi.mocked(fs.lstat).mockResolvedValueOnce(realStat as never);
    mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(file).href, "x-special/gnome-copied-files": "invalid" })]);
    expect((await source("linux")).files).toEqual([{ name: "sample.txt", size: 11 }]);
  });

  it.each(["file://server/share/file.txt", "file:///C:/file.txt:stream", "file:///C:/bad%00name", "file:///C:/bad%0Aname"])("rejects unsafe Windows file URI %s", async (uri) => {
    mocks.read.mockResolvedValue([item({ "text/uri-list": uri })]);
    await expect(readRdpClipboardFiles("win32")).rejects.toThrow();
  });

  it.each(["https://example.com/private.txt", "file://otherhost/etc/passwd", "file:///etc/passwd#fragment", "file:///etc/passwd?query", "file:///tmp/bad%00name"])("rejects nonlocal or ambiguous file URI %s", async (uri) => {
    mocks.read.mockResolvedValue([item({ "text/uri-list": uri })]);
    await expect(readRdpClipboardFiles("linux")).rejects.toThrow();
  });

  it("rejects oversize clipboard metadata before reading its payload", async () => {
    const arrayBuffer = vi.fn();
    const oversized = new Blob([new Uint8Array(1024 * 1024 + 1)]);
    Object.defineProperty(oversized, "arrayBuffer", { value: arrayBuffer });
    mocks.read.mockResolvedValue([{ types: ["text/uri-list"], getType: async () => oversized }]);
    await expect(readRdpClipboardFiles("linux")).rejects.toThrow(/valid list/u);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });
});

describe("RDP local file serving", () => {
  it("rejects folders, symbolic links, excessive total size and excessive file counts", async () => {
    const file = await fixture();
    const directory = path.dirname(file);
    mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(directory).href })]);
    await expect(readRdpClipboardFiles()).rejects.toThrow(/regular files/u);
    const link = path.join(directory, "link.txt"); await symlink(file, link);
    mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(link).href })]);
    await expect(readRdpClipboardFiles()).rejects.toThrow(/regular files/u);
    await truncate(file, RDP_MAX_CLIPBOARD_FILE_BYTES + 1);
    mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(file).href })]);
    await expect(readRdpClipboardFiles()).rejects.toThrow(/256 MiB/u);
    mocks.read.mockResolvedValue([item({ "text/uri-list": Array.from({ length: RDP_MAX_CLIPBOARD_FILES + 1 }, (_, i) => `file:///tmp/file-${i}`).join("\n") })]);
    await expect(readRdpClipboardFiles()).rejects.toThrow(/valid list/u);
  });

  it("does not open handles while sampling, refuses changed files, and releases handles on close", async () => {
    const file = await fixture(); mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(file).href })]);
    const opening = vi.spyOn(fs, "open");
    const files = await source(); expect(opening).not.toHaveBeenCalled();
    expect(await files.read(0, 0, 5)).toEqual(Buffer.from("hello")); expect(opening).toHaveBeenCalledTimes(1);
    await writeFile(file, "changed");
    await expect(files.read(0, 0, 5)).rejects.toThrow(/changed/u);
    await files.close(); await expect(files.read(0, 0, 5)).rejects.toThrow(/no longer/u);
  });

  it("refuses replacement between clipboard sampling and the first file read", async () => {
    const file = await fixture(); mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(file).href })]);
    const files = await source(); await rm(file); await writeFile(file, "hello world");
    await expect(files.read(0, 0, 5)).rejects.toThrow(/changed/u);
  });

  it("bounds all file reads before allocating memory or opening a file", async () => {
    const file = await fixture(); mocks.read.mockResolvedValue([item({ "text/uri-list": pathToFileURL(file).href })]);
    const files = await source(); const opening = vi.spyOn(fs, "open");
    for (const args of [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 0, 0], [0, 0, RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES + 1], [0, 10, 2], [0, 0.5, 1]]) {
      await expect(files.read(args[0]!, args[1]!, args[2]!)).rejects.toThrow(/range/u);
    }
    expect(opening).not.toHaveBeenCalled();
  });
});

describe("RDP received file staging", () => {
  it("publishes complete private files atomically and cleans them up on disposal", async () => {
    const transfer = await stage([{ name: "remote.txt", size: 5 }, { name: "empty.txt", size: 0 }]);
    await transfer.write(0, 0, Buffer.from("hel"));
    await expect(transfer.publish()).rejects.toThrow(/finished/u); expect(mocks.write).not.toHaveBeenCalled();
    await transfer.write(0, 3, Buffer.from("lo")); const signature = await transfer.publish();
    expect(mocks.write).toHaveBeenCalledTimes(1);
    const files = await publishedFiles();
    expect(await readFile(files[0]!, "utf8")).toBe("hello"); expect(await readFile(files[1]!, "utf8")).toBe("");
    if (process.platform !== "win32") { expect((await stat(files[0]!)).mode & 0o777).toBe(0o600); expect((await stat(path.dirname(files[0]!))).mode & 0o777).toBe(0o700); }
    mocks.read.mockResolvedValue(mocks.write.mock.calls[0]![0]); expect((await source()).signature).toBe(signature);
    expect(await transfer.publish()).toBe(signature); expect(mocks.write).toHaveBeenCalledTimes(1);
    await transfer.dispose(); await expect(stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["../escape", "..", "a/b", "a\\b", "a:stream", "NUL", "con.txt", "COM1.txt", "tail.", "tail ", "bad\0name", "x".repeat(256)])("rejects unsafe remote name %j", async (name) => {
    await expect(createRdpClipboardStaging([{ name, size: 0 }])).rejects.toThrow(/file names/u);
  });

  it("rejects duplicate names, invalid sizes, and too many files", async () => {
    await expect(createRdpClipboardStaging([{ name: "Test.txt", size: 0 }, { name: "test.txt", size: 0 }])).rejects.toThrow(/unique/u);
    await expect(createRdpClipboardStaging([{ name: "a", size: -1 }])).rejects.toThrow(/size/u);
    await expect(createRdpClipboardStaging([{ name: "a", size: RDP_MAX_CLIPBOARD_FILE_BYTES }, { name: "b", size: 1 }])).rejects.toThrow(/256 MiB/u);
    await expect(createRdpClipboardStaging(Array.from({ length: RDP_MAX_CLIPBOARD_FILES + 1 }, (_, i) => ({ name: `file${i}`, size: 0 })))).rejects.toThrow(/64 files/u);
  });

  it("rejects gaps, overlaps, oversized chunks, writes after publish, and use after cancellation", async () => {
    const transfer = await stage();
    await expect(transfer.write(0, 1, Buffer.from("x"))).rejects.toThrow(/chunk/u);
    await expect(transfer.write(0, 0, Buffer.alloc(RDP_MAX_CLIPBOARD_FILE_CHUNK_BYTES + 1))).rejects.toThrow(/chunk/u);
    await transfer.write(0, 0, Buffer.from("hello"));
    await expect(transfer.write(0, 0, Buffer.from("x"))).rejects.toThrow(/chunk/u);
    await transfer.publish(); await expect(transfer.write(0, 5, Buffer.from("x"))).rejects.toThrow(/closed/u);
    await transfer.dispose(); await expect(transfer.publish()).rejects.toThrow(/closed/u);
    expect(mocks.write).toHaveBeenCalledTimes(1);
  });

  it("serializes writes and retains a copy of chunks queued by the caller", async () => {
    const transfer = await stage();
    const bytes = Buffer.from("hel"), first = transfer.write(0, 0, bytes); bytes.fill(0);
    const second = transfer.write(0, 3, Buffer.from("lo"));
    await Promise.all([first, second]); await transfer.publish(); expect(await readFile((await publishedFiles())[0]!, "utf8")).toBe("hello");
  });

  it("rechecks authorization after asynchronous staging preparation and before writing the OS clipboard", async () => {
    const transfer = await stage([{ name: "remote.txt", size: 0 }]);
    const realLstat = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let canceled = false, stagedPath = "";
    vi.mocked(fs.lstat).mockImplementationOnce(async (file) => {
      stagedPath = file as string;
      const result = await realLstat.lstat(file);
      canceled = true;
      return result;
    });
    await expect(transfer.publish(async () => { await Promise.resolve(); if (canceled) throw new Error("Transfer canceled"); })).rejects.toThrow("Transfer canceled");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(stagedPath).not.toBe("");
    await transfer.dispose();
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans private staged files after a failed clipboard write", async () => {
    const transfer = await stage([{ name: "remote.txt", size: 0 }]);
    mocks.write.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await expect(transfer.publish()).rejects.toThrow("Clipboard unavailable");
    const files = await publishedFiles();
    await transfer.dispose();
    await expect(stat(files[0]!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["darwin", "win32", "linux"] as const)("publishes file URIs for Electron's native copied-file mapping on %s", async (platform) => {
    const transfer = await stage([{ name: "one & two.txt", size: 0 }], platform); await transfer.publish();
    const entries = mocks.write.mock.calls[0]![0] as Electron.ClipboardItem[];
    expect(entries[0]!.types).toEqual(platform === "linux" ? ["text/uri-list", "x-special/gnome-copied-files"] : ["text/uri-list"]);
    const value = await (await entries[0]!.getType("text/uri-list") as Blob).text();
    expect(value).toMatch(/^file:\/\//u); expect(value).toMatch(/one%20&%20two\.txt\r\n$/u);
    mocks.read.mockResolvedValue(entries); expect((await source()).files).toEqual([{ name: "one & two.txt", size: 0 }]);
    if (platform === "linux") expect(await (await entries[0]!.getType("x-special/gnome-copied-files") as Blob).text()).toMatch(/^copy\nfile:/u);
  });
});
