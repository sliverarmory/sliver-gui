// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SliverReleaseDownloadEvent } from "../shared/release-contracts.js";
import {
  SliverReleaseDownloader,
  isTrustedSliverReleaseDownloadUrl,
  parseLatestRelease,
} from "./sliver-release-download.js";

const downloadId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("latest Sliver release catalog", () => {
  it("extracts only executable server and client assets and sorts their targets", () => {
    const catalog = parseLatestRelease(releasePayload([
      releaseAsset("sliver-server_windows-amd64.exe", 30),
      releaseAsset("sliver-client_linux-arm64", 20),
      releaseAsset("sliver-client_linux-arm64.minisig", 320),
      { name: "checksums.txt", size: 5, browser_download_url: releaseUrl("checksums.txt") },
    ]));

    expect(catalog).toEqual({
      version: "v1.7.3",
      assets: [
        expect.objectContaining({ artifact: "client", os: "linux", arch: "arm64", size: 20 }),
        expect.objectContaining({ artifact: "server", os: "windows", arch: "amd64", size: 30 }),
      ],
    });
  });

  it.each([
    ["https://github.com/BishopFox/sliver/releases/download/v1.7.3/sliver-server_linux-amd64", true],
    ["http://github.com/BishopFox/sliver/releases/download/v1.7.3/server", false],
    ["https://github.com.evil.test/BishopFox/sliver/releases/download/v1.7.3/server", false],
    ["https://github.com/Other/sliver/releases/download/v1.7.3/server", false],
    ["https://user:secret@github.com/BishopFox/sliver/releases/download/v1.7.3/server", false],
  ])("classifies release URL %s", (url, expected) => {
    expect(isTrustedSliverReleaseDownloadUrl(url)).toBe(expected);
  });

  it("rejects duplicate targets and untrusted asset URLs", () => {
    expect(() => parseLatestRelease(releasePayload([
      releaseAsset("sliver-server_linux-amd64", 20),
      releaseAsset("sliver-server_linux-amd64", 20),
    ]))).toThrow(/duplicate release targets/);
    expect(() => parseLatestRelease(releasePayload([{
      name: "sliver-server_linux-amd64",
      size: 20,
      browser_download_url: "https://example.com/server",
    }]))).toThrow(/untrusted release asset URL/);
  });
});

describe("Sliver release downloads", () => {
  it("rechecks the latest release, streams progress, and writes a private executable into Downloads", async () => {
    const downloadsDirectory = await testDirectory();
    const bytes = new TextEncoder().encode("verified release bytes");
    const fetch = releaseFetch("sliver-client_macos-arm64", bytes);
    const events: SliverReleaseDownloadEvent[] = [];
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory,
      fetch,
      createDownloadId: () => downloadId,
      now: vi.fn()
        .mockReturnValueOnce(100)
        .mockReturnValueOnce(250),
    });

    await downloader.download(
      { artifact: "client", os: "macos", arch: "arm64" },
      (event) => events.push(event),
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.status)).toEqual(["started", "progress", "completed"]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      status: "completed",
      version: "v1.7.3",
      fileName: "sliver-client_macos-arm64",
      receivedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    }));
    const outputPath = join(downloadsDirectory, "sliver-client_macos-arm64");
    expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
    if (process.platform !== "win32") expect((await stat(outputPath)).mode & 0o777).toBe(0o700);
    expect((await readdir(downloadsDirectory)).some((name) => name.endsWith(".download"))).toBe(false);
  });

  it("never overwrites an existing download", async () => {
    const downloadsDirectory = await testDirectory();
    const fileName = "sliver-server_linux-amd64";
    await writeFile(join(downloadsDirectory, fileName), "keep me");
    const bytes = new TextEncoder().encode("new release");
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory,
      fetch: releaseFetch(fileName, bytes),
      createDownloadId: () => downloadId,
      now: () => 200,
    });
    const events: SliverReleaseDownloadEvent[] = [];

    await downloader.download(
      { artifact: "server", os: "linux", arch: "amd64" },
      (event) => events.push(event),
    );

    expect(await readFile(join(downloadsDirectory, fileName), "utf8")).toBe("keep me");
    expect(await readFile(join(downloadsDirectory, `${fileName} (1)`))).toEqual(Buffer.from(bytes));
    expect(events.at(-1)).toEqual(expect.objectContaining({ fileName: `${fileName} (1)` }));
  });

  it("reports bounded failures and removes partial files", async () => {
    const downloadsDirectory = await testDirectory();
    const bytes = new TextEncoder().encode("short");
    const fetch = releaseFetch("sliver-server_linux-arm64", bytes, bytes.byteLength + 10);
    const events: SliverReleaseDownloadEvent[] = [];
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory,
      fetch,
      createDownloadId: () => downloadId,
    });

    await downloader.download(
      { artifact: "server", os: "linux", arch: "arm64" },
      (event) => events.push(event),
    );

    expect(events.map((event) => event.status)).toEqual(["started", "failed"]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      error: "The release download size did not match GitHub metadata",
    }));
    expect(await readdir(downloadsDirectory)).toEqual([]);
  });
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sliver-gui-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function releaseFetch(fileName: string, bytes: Uint8Array, advertisedSize = bytes.byteLength) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(releasePayload([releaseAsset(fileName, advertisedSize)])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });
  });
}

function releasePayload(assets: unknown[]): Record<string, unknown> {
  return { tag_name: "v1.7.3", assets };
}

function releaseAsset(name: string, size: number): Record<string, unknown> {
  return { name, size, browser_download_url: releaseUrl(name) };
}

function releaseUrl(name: string): string {
  return `https://github.com/BishopFox/sliver/releases/download/v1.7.3/${name}`;
}
