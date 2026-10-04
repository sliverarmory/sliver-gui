// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SliverReleaseDownloadEvent } from "../shared/release-contracts.js";
import {
  CrackstationReleaseDownloader,
  isTrustedCrackstationReleaseDownloadUrl,
  parseLatestCrackstationRelease,
} from "./sliver-release-download.js";

const downloadId = "8e577480-5dc2-4dde-aa58-23c8f1770627";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ),
  );
});

describe("latest Crackstation release catalog", () => {
  it("parses and orders the exact published platform matrix", () => {
    const catalog = parseLatestCrackstationRelease(releasePayload([
      releaseAsset("sliver-crackstation_windows-amd64.exe", 30, "c".repeat(64)),
      {
        name: "checksums.txt",
        size: 5,
        browser_download_url: releaseUrl("checksums.txt"),
      },
      releaseAsset("sliver-crackstation_linux-amd64", 20, "b".repeat(64)),
      releaseAsset("sliver-crackstation_darwin-arm64", 10, "a".repeat(64)),
    ]));

    expect(catalog).toEqual({
      version: "v0.0.4",
      assets: [
        {
          artifact: "crackstation",
          os: "darwin",
          arch: "arm64",
          fileName: "sliver-crackstation_darwin-arm64",
          size: 10,
          downloadUrl: releaseUrl("sliver-crackstation_darwin-arm64"),
          sha256: "a".repeat(64),
          signature: null,
        },
        {
          artifact: "crackstation",
          os: "linux",
          arch: "amd64",
          fileName: "sliver-crackstation_linux-amd64",
          size: 20,
          downloadUrl: releaseUrl("sliver-crackstation_linux-amd64"),
          sha256: "b".repeat(64),
          signature: null,
        },
        {
          artifact: "crackstation",
          os: "windows",
          arch: "amd64",
          fileName: "sliver-crackstation_windows-amd64.exe",
          size: 30,
          downloadUrl: releaseUrl("sliver-crackstation_windows-amd64.exe"),
          sha256: "c".repeat(64),
          signature: null,
        },
      ],
    });
  });

  it.each([
    [releaseUrl("sliver-crackstation_linux-amd64"), true],
    ["http://github.com/sliverarmory/sliver-crackstation/releases/download/v0.0.4/sliver-crackstation_linux-amd64", false],
    ["https://github.com.evil.test/sliverarmory/sliver-crackstation/releases/download/v0.0.4/sliver-crackstation_linux-amd64", false],
    ["https://github.com/other/sliver-crackstation/releases/download/v0.0.4/sliver-crackstation_linux-amd64", false],
    ["https://user:secret@github.com/sliverarmory/sliver-crackstation/releases/download/v0.0.4/sliver-crackstation_linux-amd64", false],
    ["https://github.com:444/sliverarmory/sliver-crackstation/releases/download/v0.0.4/sliver-crackstation_linux-amd64", false],
    ["https://github.com/sliverarmory/sliver-crackstation/releases/download.evil/v0.0.4/sliver-crackstation_linux-amd64", false],
  ])("classifies Crackstation release URL %s", (url, expected) => {
    expect(isTrustedCrackstationReleaseDownloadUrl(url)).toBe(expected);
  });

  it("rejects duplicate targets, missing digests, and untrusted asset URLs", () => {
    expect(() => parseLatestCrackstationRelease(releasePayload([
      releaseAsset("sliver-crackstation_linux-amd64", 20, "a".repeat(64)),
      releaseAsset("sliver-crackstation_linux-amd64", 20, "b".repeat(64)),
    ]))).toThrow(/duplicate release targets/u);
    expect(() => parseLatestCrackstationRelease(releasePayload([{
      name: "sliver-crackstation_linux-amd64",
      size: 20,
      browser_download_url: releaseUrl("sliver-crackstation_linux-amd64"),
    }]))).toThrow(/without a SHA-256 digest/u);
    expect(() => parseLatestCrackstationRelease(releasePayload([{
      ...releaseAsset("sliver-crackstation_linux-amd64", 20, "a".repeat(64)),
      browser_download_url: "https://example.test/sliver-crackstation_linux-amd64",
    }]))).toThrow(/untrusted release asset URL/u);
  });
});

describe("Crackstation release downloads", () => {
  it("verifies SHA-256, publishes progress, and writes a private executable", async () => {
    const downloadsDirectory = await testDirectory();
    const fileName = "sliver-crackstation_linux-amd64";
    const bytes = new TextEncoder().encode("verified Crackstation release bytes");
    const fetch = releaseFetch(fileName, bytes, sha256(bytes));
    const events: SliverReleaseDownloadEvent[] = [];
    const downloader = new CrackstationReleaseDownloader({
      downloadsDirectory,
      fetch,
      createDownloadId: () => downloadId,
      now: () => 200,
    });

    await downloader.download(
      { artifact: "crackstation", os: "linux", arch: "amd64" },
      (event) => events.push(event),
    );

    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      "https://api.github.com/repos/sliverarmory/sliver-crackstation/releases/latest",
      releaseUrl(fileName),
    ]);
    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "completed",
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      status: "completed",
      artifact: "crackstation",
      os: "linux",
      arch: "amd64",
      version: "v0.0.4",
      fileName,
      receivedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
    }));
    const outputPath = join(downloadsDirectory, fileName);
    expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
    if (process.platform !== "win32") {
      expect((await stat(outputPath)).mode & 0o777).toBe(0o700);
    }
    expect((await readdir(downloadsDirectory)).some((name) =>
      name.endsWith(".download")
    )).toBe(false);
  });

  it("rejects a digest mismatch and removes all unverified bytes", async () => {
    const downloadsDirectory = await testDirectory();
    const fileName = "sliver-crackstation_linux-amd64";
    const bytes = new TextEncoder().encode("tampered!");
    const expectedDigest = sha256(new TextEncoder().encode("authentic"));
    const events: SliverReleaseDownloadEvent[] = [];
    const downloader = new CrackstationReleaseDownloader({
      downloadsDirectory,
      fetch: releaseFetch(fileName, bytes, expectedDigest),
      createDownloadId: () => downloadId,
      now: () => 200,
    });

    await downloader.download(
      { artifact: "crackstation", os: "linux", arch: "amd64" },
      (event) => events.push(event),
    );

    expect(events.map((event) => event.status)).toEqual([
      "started",
      "progress",
      "failed",
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      status: "failed",
      artifact: "crackstation",
      error: "The release download failed SHA-256 verification",
    }));
    expect(await readdir(downloadsDirectory)).toEqual([]);
  });
});

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "sliver-gui-crackstation-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function releaseFetch(fileName: string, bytes: Uint8Array, digest: string) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      return new Response(JSON.stringify(releasePayload([
        releaseAsset("sliver-crackstation_windows-amd64.exe", 1, "c".repeat(64)),
        releaseAsset(fileName, bytes.byteLength, digest),
        releaseAsset("sliver-crackstation_darwin-arm64", 1, "a".repeat(64)),
      ])), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(Uint8Array.from(bytes).buffer, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });
  });
}

function releasePayload(assets: unknown[]): Record<string, unknown> {
  return { tag_name: "v0.0.4", assets };
}

function releaseAsset(name: string, size: number, digest: string): Record<string, unknown> {
  return {
    name,
    size,
    digest: `sha256:${digest}`,
    browser_download_url: releaseUrl(name),
  };
}

function releaseUrl(name: string): string {
  return `https://github.com/sliverarmory/sliver-crackstation/releases/download/v0.0.4/${name}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
