// @vitest-environment node

import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const rootDir = resolve(import.meta.dirname, "../..");
const verifier = resolve(rootDir, "scripts/verifyUpdateArtifacts.mjs");
const privateE2EStager = resolve(rootDir, "scripts/stagePrivateUpdaterE2E.mjs");
const productionBuilderConfig = resolve(rootDir, "electron-builder.yml");
const privateE2EBuilderConfig = resolve(rootDir, "electron-builder-updater-e2e.yml");
const publicTestCertificate = resolve(rootDir, "src/e2e/fixtures/server.crt.fixture");
const publicTestPrivateKey = resolve(rootDir, "src/e2e/fixtures/server-key.fixture");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("self-update release packaging", () => {
  it("keeps private GitHub update configuration isolated to the credential-free E2E profile", async () => {
    const [productionConfig, privateE2EConfig] = await Promise.all([
      readFile(productionBuilderConfig, "utf8"),
      readFile(privateE2EBuilderConfig, "utf8"),
    ]);

    expect(productionConfig).toContain(
      "publish:\n  provider: github\n  owner: sliverarmory\n  repo: sliver-gui\n",
    );
    expect(productionConfig).not.toMatch(/^\s*(?:private|token|auth|authorization|password|secret):/gimu);
    expect(privateE2EConfig).toContain("extends: ./electron-builder.yml\n");
    expect(privateE2EConfig).toContain(
      "publish:\n  provider: github\n  owner: sliverarmory\n  repo: sliver-gui\n  private: true\n  channel: latest\n",
    );
    expect(privateE2EConfig).not.toMatch(/^\s*(?:token|auth|authorization|password|secret):/gimu);
  });

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

    await writeFile(
      packagedUpdateConfig,
      "owner: sliverarmory\nrepo: sliver-gui\nprovider: github\nprivate: true\n",
    );
    const privateProductionProvider = spawnSync(
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
    expect(privateProductionProvider.status).not.toBe(0);
    expect(privateProductionProvider.stderr).toContain("contains private credential field(s): private");
  });

  it("accepts only credential-free private GitHub configuration for prerelease E2E versions", async () => {
    const version = "1.2.3-updater-e2e.1";
    const { directory, packagedUpdateConfig } = await createWindowsFixture(version);
    const baseConfig = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n");
    await writeFile(packagedUpdateConfig, baseConfig);

    const accepted = runVerifier([
      "--directory",
      directory,
      "--platform",
      "windows",
      "--version",
      version,
      "--app-update",
      packagedUpdateConfig,
      "--private-e2e",
    ]);
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("with the private E2E packaged update provider");

    for (const credentialKey of ["token", "auth", "password", "secret"]) {
      await writeFile(packagedUpdateConfig, `${baseConfig}${credentialKey}: must-not-ship\n`);
      const unsafe = runVerifier([
        "--directory",
        directory,
        "--platform",
        "windows",
        "--version",
        version,
        "--app-update",
        packagedUpdateConfig,
        "--private-e2e",
      ]);
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toContain(`contains private credential field(s): ${credentialKey}`);
    }

    for (const routingField of [
      "host: attacker.example",
      "protocol: http",
      "<<: {host: attacker.example, protocol: http}",
    ]) {
      await writeFile(packagedUpdateConfig, `${baseConfig}${routingField}\n`);
      const unsafe = runVerifier([
        "--directory",
        directory,
        "--platform",
        "windows",
        "--version",
        version,
        "--app-update",
        packagedUpdateConfig,
        "--private-e2e",
      ]);
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toMatch(/(?:contains unexpected root field|uses unsupported root YAML)/u);
    }

    await writeFile(packagedUpdateConfig, baseConfig.replace("private: true", "private: false"));
    const notPrivate = runVerifier([
      "--directory",
      directory,
      "--platform",
      "windows",
      "--version",
      version,
      "--app-update",
      packagedUpdateConfig,
      "--private-e2e",
    ]);
    expect(notPrivate.status).not.toBe(0);
    expect(notPrivate.stderr).toContain("must contain exactly private: true");

    const stableVersion = runVerifier([
      "--directory",
      directory,
      "--platform",
      "windows",
      "--version",
      "1.2.3",
      "--app-update",
      packagedUpdateConfig,
      "--private-e2e",
    ]);
    expect(stableVersion.status).not.toBe(0);
    expect(stableVersion.stderr).toContain("must be an exact prerelease SemVer version");

    const prereleaseInProduction = runVerifier([
      "--directory",
      directory,
      "--platform",
      "windows",
      "--version",
      version,
    ]);
    expect(prereleaseInProduction.status).not.toBe(0);
    expect(prereleaseInProduction.stderr).toContain("must be an exact stable SemVer version");
  });

  it("stages only validated public X.509 certificates after validating private provider configuration", async () => {
    const version = "1.2.3-updater-e2e.1";
    const directory = await mkdtemp(join(tmpdir(), "sliver-gui-private-stage-"));
    temporaryDirectories.push(directory);
    const source = join(directory, "source");
    const appUpdateDirectory = join(
      source,
      "mac-universal",
      "Sliver GUI.app",
      "Contents",
      "Resources",
    );
    await mkdir(appUpdateDirectory, { recursive: true });
    await writeFile(join(source, `sliver-gui-${version}-macos-universal.dmg`), "fixture:dmg");
    const appUpdatePath = join(appUpdateDirectory, "app-update.yml");
    const safeConfig = [
      "owner: sliverarmory",
      "repo: sliver-gui",
      "provider: github",
      "private: true",
      "channel: latest",
      "updaterCacheDirName: sliver-gui-updater",
      "",
    ].join("\n");
    await writeFile(appUpdatePath, safeConfig);

    const acceptedDestination = join(directory, "accepted");
    const accepted = runStager([
      "--platform", "macos",
      "--version", version,
      "--source", source,
      "--destination", acceptedDestination,
      "--certificate", publicTestCertificate,
    ]);
    expect(accepted.stderr).toBe("");
    expect(accepted.status).toBe(0);
    expect(await readFile(join(acceptedDestination, "context", "app-update.yml"), "utf8")).toBe(safeConfig);
    expect(await readFile(join(acceptedDestination, "base", "signing-certificate.pem"), "utf8"))
      .toBe(await readFile(publicTestCertificate, "utf8"));

    const privateKeyDestination = join(directory, "rejected-private-key");
    const privateKey = runStager([
      "--platform", "macos",
      "--version", version,
      "--source", source,
      "--destination", privateKeyDestination,
      "--certificate", publicTestPrivateKey,
    ]);
    expect(privateKey.status).not.toBe(0);
    expect(privateKey.stderr).toContain("Refusing to stage private signing material");
    await expect(access(privateKeyDestination)).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(appUpdatePath, `${safeConfig}host: attacker.example\n`);
    const unsafeConfigDestination = join(directory, "rejected-config");
    const unsafeConfig = runStager([
      "--platform", "macos",
      "--version", version,
      "--source", source,
      "--destination", unsafeConfigDestination,
      "--certificate", publicTestCertificate,
    ]);
    expect(unsafeConfig.status).not.toBe(0);
    expect(unsafeConfig.stderr).toContain("contains unexpected root field(s): host");
    await expect(access(unsafeConfigDestination)).rejects.toMatchObject({ code: "ENOENT" });
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

async function createWindowsFixture(version: string): Promise<{
  directory: string;
  packagedUpdateConfig: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "sliver-gui-private-update-assets-"));
  temporaryDirectories.push(directory);
  const packagedUpdateConfig = join(directory, "app-update.yml");
  const portable = `sliver-gui-${version}-windows-x64-portable.exe`;
  const setup = `sliver-gui-${version}-windows-x64-setup.exe`;
  const blockmap = `${setup}.blockmap`;
  for (const asset of [portable, setup, blockmap]) {
    await writeFile(join(directory, asset), `fixture:${asset}`);
  }
  await writeFile(
    join(directory, "latest.yml"),
    updateMetadata({ version, urls: [setup], primary: setup }),
  );
  return { directory, packagedUpdateConfig };
}

function runVerifier(arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifier, ...arguments_], { encoding: "utf8" });
}

function runStager(arguments_: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [privateE2EStager, ...arguments_], { encoding: "utf8" });
}

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
