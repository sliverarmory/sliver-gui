// @vitest-environment node

import { createHash, generateKeyPairSync, sign } from "node:crypto";
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
  it("associates Minisign sidecars with executable assets and sorts their targets", () => {
    const catalog = parseLatestRelease(releasePayload([
      releaseAsset("sliver-server_windows-amd64.exe", 30),
      releaseAsset("sliver-client_linux-arm64", 20),
      releaseAsset("sliver-client_linux-arm64.minisig", 320),
      { name: "checksums.txt", size: 5, browser_download_url: releaseUrl("checksums.txt") },
    ]));

    expect(catalog).toEqual({
      version: "v1.7.3",
      assets: [
        expect.objectContaining({
          artifact: "client",
          os: "linux",
          arch: "arm64",
          size: 20,
          signature: expect.objectContaining({ fileName: "sliver-client_linux-arm64.minisig", size: 320 }),
        }),
        expect.objectContaining({
          artifact: "server",
          os: "windows",
          arch: "amd64",
          size: 30,
          signature: null,
        }),
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
  it("stages an allowlisted server asset at a private main-owned path", async () => {
    const stagingDirectory = await testDirectory();
    const outputPath = join(stagingDirectory, "server-stage");
    const bytes = new TextEncoder().encode("server release bytes");
    const fixture = signedFixture(bytes, "sliver-server_linux-amd64");
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory: stagingDirectory,
      fetch: releaseFetch("sliver-server_linux-amd64", bytes, bytes.byteLength, fixture.signature),
      trustedMinisignPublicKey: fixture.publicKey,
    });
    const progress: Array<[number, number]> = [];

    const staged = await downloader.stagePrivate(
      { artifact: "server", os: "linux", arch: "amd64" },
      outputPath,
      (received, total) => progress.push([received, total]),
    );

    expect(staged).toEqual({
      version: "v1.7.3",
      fileName: "sliver-server_linux-amd64",
      path: outputPath,
      size: bytes.byteLength,
    });
    expect(progress).toEqual([[bytes.byteLength, bytes.byteLength]]);
    expect(await readFile(outputPath)).toEqual(Buffer.from(bytes));
    if (process.platform !== "win32") expect((await stat(outputPath)).mode & 0o777).toBe(0o700);
  });

  it("refuses a private stage before downloading executable bytes when the signature is missing", async () => {
    const stagingDirectory = await testDirectory();
    const outputPath = join(stagingDirectory, "server-stage");
    const bytes = new TextEncoder().encode("server release bytes");
    const fetch = releaseFetch("sliver-server_linux-amd64", bytes);
    const downloader = new SliverReleaseDownloader({ downloadsDirectory: stagingDirectory, fetch });

    await expect(downloader.stagePrivate(
      { artifact: "server", os: "linux", arch: "amd64" },
      outputPath,
    )).rejects.toThrow(/missing its Minisign signature/u);

    expect(fetch).toHaveBeenCalledOnce();
    expect(await readdir(stagingDirectory)).toEqual([]);
  });

  it("removes unverified bytes and never publishes the requested stage path", async () => {
    const stagingDirectory = await testDirectory();
    const outputPath = join(stagingDirectory, "server-stage");
    const bytes = Buffer.from("tampered release byte", "utf8");
    const fixture = signedFixture(Buffer.from("authentic release data", "utf8"), "sliver-server_linux-amd64");
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory: stagingDirectory,
      fetch: releaseFetch("sliver-server_linux-amd64", bytes, bytes.byteLength, fixture.signature),
      trustedMinisignPublicKey: fixture.publicKey,
    });

    await expect(downloader.stagePrivate(
      { artifact: "server", os: "linux", arch: "amd64" },
      outputPath,
    )).rejects.toThrow(/failed Minisign verification/u);

    expect(await readdir(stagingDirectory)).toEqual([]);
  });

  it("removes a failed private stage instead of leaving partial executable data", async () => {
    const stagingDirectory = await testDirectory();
    const outputPath = join(stagingDirectory, "server-stage");
    const bytes = new TextEncoder().encode("short");
    const fixture = signedFixture(bytes, "sliver-server_linux-amd64");
    const downloader = new SliverReleaseDownloader({
      downloadsDirectory: stagingDirectory,
      fetch: releaseFetch(
        "sliver-server_linux-amd64",
        bytes,
        bytes.byteLength + 1,
        fixture.signature,
      ),
      trustedMinisignPublicKey: fixture.publicKey,
    });

    await expect(downloader.stagePrivate(
      { artifact: "server", os: "linux", arch: "amd64" },
      outputPath,
    )).rejects.toThrow(/size did not match/);
    expect(await readdir(stagingDirectory)).toEqual([]);
  });

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

function releaseFetch(
  fileName: string,
  bytes: Uint8Array,
  advertisedSize = bytes.byteLength,
  signature?: Uint8Array,
) {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes("api.github.com")) {
      const assets = [releaseAsset(fileName, advertisedSize)];
      if (signature !== undefined) assets.push(releaseAsset(`${fileName}.minisig`, signature.byteLength));
      return new Response(JSON.stringify(releasePayload(assets)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith(".minisig")) {
      return signature === undefined
        ? new Response(null, { status: 404 })
        : new Response(Uint8Array.from(signature).buffer, {
            status: 200,
            headers: { "content-length": String(signature.byteLength) },
          });
    }
    return new Response(Uint8Array.from(bytes).buffer, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });
  });
}

function signedFixture(artifact: Uint8Array, fileName: string): {
  readonly publicKey: string;
  readonly signature: Buffer;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = Buffer.from("0102030405060708", "hex");
  const exported = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(exported).subarray(-32);
  const minisignPublicKey = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    keyId,
    rawPublicKey,
  ]).toString("base64");
  const digest = createHash("blake2b512").update(artifact).digest();
  const messageSignature = sign(null, digest, privateKey);
  const trustedComment = `timestamp:1788721200\tfile:${fileName}`;
  const commentSignature = sign(
    null,
    Buffer.concat([messageSignature, Buffer.from(trustedComment, "utf8")]),
    privateKey,
  );
  const rawSignature = Buffer.concat([
    Buffer.from("ED", "ascii"),
    keyId,
    messageSignature,
  ]);
  return {
    publicKey: minisignPublicKey,
    signature: Buffer.from([
      "untrusted comment: signature from test minisign key",
      rawSignature.toString("base64"),
      `trusted comment: ${trustedComment}`,
      commentSignature.toString("base64"),
      "",
    ].join("\n"), "utf8"),
  };
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
