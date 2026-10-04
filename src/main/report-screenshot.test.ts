// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureReportScreenshots } from "./report-screenshot.js";

const mocks = vi.hoisted(() => ({ windows: [] as MockWindow[], uuid: null as string | null }));

interface MockWindow {
  id: number;
  isDestroyed: ReturnType<typeof vi.fn>;
  webContents: {
    isDestroyed: ReturnType<typeof vi.fn>;
    capturePage: ReturnType<typeof vi.fn>;
  };
}

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => mocks.windows },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return { ...original, randomUUID: () => mocks.uuid ?? original.randomUUID() };
});

let directory = "";

beforeEach(async () => {
  mocks.windows.length = 0;
  mocks.uuid = null;
  directory = await mkdtemp(join(tmpdir(), "sliver-report-screenshot-"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (directory) await rm(directory, { recursive: true, force: true });
});

function windowFor(id: number, bytes: Buffer): MockWindow {
  return {
    id,
    isDestroyed: vi.fn(() => false),
    webContents: {
      isDestroyed: vi.fn(() => false),
      capturePage: vi.fn(async () => ({
        isEmpty: () => false,
        toPNG: () => bytes,
      })),
    },
  };
}

describe("captureReportScreenshots", () => {
  it("captures every open window into distinct private PNGs without changing the destination directory", async () => {
    const first = Buffer.from("first window PNG");
    const second = Buffer.from("second window PNG");
    mocks.windows.push(windowFor(7, first), windowFor(9, second));
    if (process.platform !== "win32") await chmod(directory, 0o755);

    const result = await captureReportScreenshots(directory);

    expect(result).toEqual({
      directory: await realpath(directory),
      windowCount: 2,
      savedPaths: [expect.any(String), expect.any(String)],
      failures: [],
    });
    expect(result.savedPaths[0]).not.toBe(result.savedPaths[1]);
    expect(result.savedPaths.map((path) => basename(path))).toEqual([
      expect.stringMatching(/^sliver-report-[\w-]+-window-1\.png$/),
      expect.stringMatching(/^sliver-report-[\w-]+-window-2\.png$/),
    ]);
    expect(await readFile(result.savedPaths[0]!)).toEqual(Buffer.from("first window PNG"));
    expect(await readFile(result.savedPaths[1]!)).toEqual(Buffer.from("second window PNG"));
    expect(await readdir(directory)).toHaveLength(2);
    expect(first).toEqual(Buffer.alloc(first.length));
    expect(second).toEqual(Buffer.alloc(second.length));
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o755);
      for (const path of result.savedPaths) expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects invalid destinations and an empty window set", async () => {
    await expect(captureReportScreenshots("relative/path")).rejects.toThrow("absolute directory");
    const file = join(directory, "not-a-directory");
    await writeFile(file, "existing");
    await expect(captureReportScreenshots(file)).rejects.toThrow("must be a directory");
    await expect(captureReportScreenshots(join(directory, "missing"))).rejects.toThrow();
    await expect(captureReportScreenshots(directory)).rejects.toThrow("No open application windows");
    expect(await readdir(directory)).toEqual(["not-a-directory"]);
  });

  it("continues after capture failures and reports each failed window", async () => {
    const failed = windowFor(1, Buffer.from("unused"));
    failed.webContents.capturePage.mockRejectedValueOnce(new Error("GPU capture unavailable"));
    const empty = windowFor(2, Buffer.from("unused"));
    empty.webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true, toPNG: vi.fn() });
    const closed = windowFor(3, Buffer.from("unused"));
    closed.isDestroyed.mockReturnValueOnce(false).mockReturnValueOnce(true);
    const goodBytes = Buffer.from("good PNG");
    const good = windowFor(4, goodBytes);
    mocks.windows.push(failed, empty, closed, good);

    const result = await captureReportScreenshots(directory);

    expect(result.windowCount).toBe(4);
    expect(result.savedPaths).toHaveLength(1);
    expect(await readFile(result.savedPaths[0]!)).toEqual(Buffer.from("good PNG"));
    expect(result.failures).toEqual([
      { windowId: 1, message: "GPU capture unavailable" },
      { windowId: 2, message: "Window capture was empty" },
      { windowId: 3, message: "Window closed before capture" },
    ]);
    expect(goodBytes).toEqual(Buffer.alloc(goodBytes.length));
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("does not overwrite an existing screenshot when a final filename collides", async () => {
    mocks.uuid = "00000000-0000-4000-8000-000000000000";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T03:00:00.000Z"));
    mocks.windows.push(windowFor(1, Buffer.from("original PNG")));

    const first = await captureReportScreenshots(directory);
    const replacementBytes = Buffer.from("replacement PNG");
    mocks.windows[0] = windowFor(1, replacementBytes);
    const second = await captureReportScreenshots(directory);

    expect(second.savedPaths).toEqual([]);
    expect(second.failures).toHaveLength(1);
    expect(second.failures[0]?.message).toMatch(/EEXIST|exist/i);
    expect(await readFile(first.savedPaths[0]!)).toEqual(Buffer.from("original PNG"));
    expect(replacementBytes).toEqual(Buffer.alloc(replacementBytes.length));
    expect(await readdir(directory)).toHaveLength(1);
  });
});
