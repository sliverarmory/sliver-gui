// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../..");
const verifier = resolve(rootDir, "scripts/verifyUpdateArtifacts.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("self-update release packaging", () => {
  it("accepts the exact cross-platform updater inventory and checksums", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-update-assets-"));
    temporaryDirectories.push(directory);
    const version = "1.2.3";
    const publisherName = "CN=Sliver Armory, O=Sliver Armory, C=US";
    const packagedUpdateConfig = join(directory, "packaged", "app-update.yml");
    await mkdir(join(directory, "packaged"));
    const assets = [
      "latest-linux.yml",
      "latest-mac.yml",
      "latest.yml",
      `sliver-gui-${version}-linux-x86_64.AppImage`,
      `sliver-gui-${version}-linux-amd64.deb`,
      `sliver-gui-${version}-macos-universal.dmg`,
      `sliver-gui-${version}-macos-universal.dmg.blockmap`,
      `sliver-gui-${version}-macos-universal.zip`,
      `sliver-gui-${version}-macos-universal.zip.blockmap`,
      `sliver-gui-${version}-windows-x64-portable.exe`,
      `sliver-gui-${version}-windows-x64-setup.exe`,
      `sliver-gui-${version}-windows-x64-setup.exe.blockmap`,
    ];

    for (const asset of assets.filter((name) => !name.startsWith("latest"))) {
      await writeFile(join(directory, asset), `fixture:${asset}`);
    }
    await writeFile(
      join(directory, "latest-mac.yml"),
      updateMetadata({
        version,
        urls: [
          `sliver-gui-${version}-macos-universal.zip`,
          `sliver-gui-${version}-macos-universal.dmg`,
        ],
        primary: `sliver-gui-${version}-macos-universal.zip`,
      }),
    );
    await writeFile(
      join(directory, "latest.yml"),
      updateMetadata({
        version,
        urls: [`sliver-gui-${version}-windows-x64-setup.exe`],
        primary: `sliver-gui-${version}-windows-x64-setup.exe`,
      }),
    );
    await writeFile(
      join(directory, "latest-linux.yml"),
      updateMetadata({
        version,
        urls: [
          `sliver-gui-${version}-linux-x86_64.AppImage`,
          `sliver-gui-${version}-linux-amd64.deb`,
        ],
        primary: `sliver-gui-${version}-linux-x86_64.AppImage`,
      }),
    );

    const checksums = await Promise.all(
      assets.map(async (asset) => {
        const content = await readFile(join(directory, asset));
        return `${createHash("sha256").update(content).digest("hex")}  ${asset}`;
      }),
    );
    await writeFile(join(directory, "SHA256SUMS"), `${checksums.join("\n")}\n`);
    await writeFile(
      packagedUpdateConfig,
      `owner: sliverarmory\nrepo: sliver-gui\nprovider: github\npublisherName:\n  - ${publisherName}\nupdaterCacheDirName: sliver-gui-updater\n`,
    );

    const result = spawnSync(
      process.execPath,
      [
        verifier,
        "--directory",
        directory,
        "--platform",
        "all",
        "--version",
        version,
        "--checksums",
        "SHA256SUMS",
        "--app-update",
        packagedUpdateConfig,
        "--publisher-name",
        publisherName,
      ],
      { encoding: "utf8" },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Verified 12 all update/release artifact(s)");

    await writeFile(
      packagedUpdateConfig,
      "owner: sliverarmory\nrepo: sliver-gui\nprovider: github\ntoken: must-not-ship\n",
    );
    const unsafeProvider = spawnSync(
      process.execPath,
      [
        verifier,
        "--directory",
        directory,
        "--platform",
        "all",
        "--version",
        version,
        "--checksums",
        "SHA256SUMS",
        "--app-update",
        packagedUpdateConfig,
      ],
      { encoding: "utf8" },
    );
    expect(unsafeProvider.status).not.toBe(0);
    expect(unsafeProvider.stderr).toContain("contains private credential field(s): token");
  });

  it("rejects an incomplete updater inventory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-update-assets-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "latest.yml"), "version: 1.2.3\n");

    const result = spawnSync(
      process.execPath,
      [verifier, "--directory", directory, "--platform", "windows", "--version", "1.2.3"],
      { encoding: "utf8" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release artifact inventory for windows mismatch");
  });
});

function updateMetadata(options: {
  version: string;
  urls: string[];
  primary: string;
}): string {
  const fileInfo = (url: string): { digest: string; size: number } => {
    const content = Buffer.from(`fixture:${url}`);
    return { digest: createHash("sha512").update(content).digest("base64"), size: content.byteLength };
  };
  const files = options.urls.flatMap((url) => {
    const info = fileInfo(url);
    return [`  - url: ${url}`, `    sha512: ${info.digest}`, `    size: ${info.size}`];
  });
  const primary = fileInfo(options.primary);
  return [
    `version: ${options.version}`,
    "files:",
    ...files,
    `path: ${options.primary}`,
    `sha512: ${primary.digest}`,
    "releaseDate: '2026-08-14T12:00:00.000Z'",
    "",
  ].join("\n");
}
