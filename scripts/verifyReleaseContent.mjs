import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage, statFile } from "@electron/asar";

import { asarEntryPaths } from "./asarEntryPaths.mjs";
import {
  hermeticGoEnvironment,
  SLIVER_CLIENT_LINKER_DEFAULTS,
  validateGoBuildInfo,
  verifyPackagedSourceOverlayFiles,
  verifySourceOverlayReplacements,
} from "./buildSliverConsole.mjs";
import { packagedRuntimeFilesForPlatform, runtimeFilesForPlatform } from "./prepareNodePtyRuntime.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(rootDir, "dist");
const releaseDir = join(rootDir, "release");
const verifyPackaged = process.argv.includes("--packaged");
const exactArchiveArgument = argumentValue("--archive");
if (exactArchiveArgument && !verifyPackaged) {
  throw new Error("--archive requires --packaged");
}
const bannedProductionMarkers = [
  "__SLIVER_GUI_E2E_STATE__",
  "FAKE_TOKEN_M0_DO_NOT_RENDER",
  "FAKE_EVENT_SECRET_M0_DO_NOT_RENDER",
  "PACKAGED_MTLS_TOKEN_M0_DO_NOT_RENDER",
  "PACKAGED_EVENT_SECRET_M0_DO_NOT_RENDER",
];
const requiredBuilderPaths = [
  "dist/**",
  "package.json",
  "LICENSE",
  "LICENSES/LICENSING.md",
  "LICENSES/**",
  "THIRD_PARTY_NOTICES.md",
  "node_modules/ghostty-web/LICENSE",
  "node_modules/ghostty-web/package.json",
  "node_modules/ghostty-web/ghostty-vt.wasm",
  "node_modules/node-pty/LICENSE",
  "node_modules/node-pty/package.json",
  "node_modules/node-pty/lib/**/*.js",
  "node_modules/node-pty/build/Release/**",
  "node_modules/sliver-script/LICENSE",
  "node_modules/sliver-script/package.json",
  "node_modules/sliver-script/integration.lock.json",
  "node_modules/sliver-script/protobuf.lock.json",
  "node_modules/sliver-script/protobuf.sh",
  "node_modules/sliver-script/tsconfig.json",
  "node_modules/sliver-script/scripts/**",
  "node_modules/sliver-script/src/**",
  "protocol/sliver-baseline.json",
  "protocol/sliver-script-provenance.json",
  "protocol/ghostty-web-provenance.json",
  "protocol/terminal-fonts-provenance.json",
  "docs/operator-parity.generated.json",
  "docs/operator-parity.annotations.json",
  "docs/operator-parity.schema.json",
  "docs/operator-parity.md",
  "docs/adr/0001-platform-support.md",
  "docs/rpc-message-budgets.md",
];
const requiredPackagedFiles = [
  "LICENSE",
  "LICENSES/Apache-2.0.txt",
  "LICENSES/GPL-3.0-or-later.txt",
  "LICENSES/LICENSING.md",
  "LICENSES/MIT.txt",
  "LICENSES/OFL-1.1.txt",
  "LICENSES/README.md",
  "package.json",
  "node_modules/ghostty-web/LICENSE",
  "node_modules/ghostty-web/package.json",
  "node_modules/ghostty-web/ghostty-vt.wasm",
  "node_modules/node-pty/LICENSE",
  "node_modules/node-pty/package.json",
  "node_modules/node-pty/lib/index.js",
  "node_modules/electron-updater/LICENSE",
  "node_modules/electron-updater/package.json",
  "node_modules/electron-updater/out/main.js",
  "dist/main/index.js",
  "dist/preload/cloud-deployment.cjs",
  "dist/preload/index.cjs",
  "dist/preload/ssh.cjs",
  "dist/renderer/index.html",
  "node_modules/sliver-script/LICENSE",
  "node_modules/sliver-script/package.json",
  "node_modules/sliver-script/integration.lock.json",
  "node_modules/sliver-script/protobuf.lock.json",
  "node_modules/sliver-script/protobuf.sh",
  "node_modules/sliver-script/tsconfig.json",
  "protocol/sliver-baseline.json",
  "protocol/sliver-script-provenance.json",
  "protocol/ghostty-web-provenance.json",
  "protocol/terminal-fonts-provenance.json",
  "docs/operator-parity.generated.json",
  "docs/operator-parity.annotations.json",
  "docs/operator-parity.schema.json",
  "docs/operator-parity.md",
  "docs/adr/0001-platform-support.md",
  "docs/rpc-message-budgets.md",
];
const requiredPackagedPrefixes = [
  "dist/renderer/assets/",
  "node_modules/sliver-script/lib/",
  "node_modules/sliver-script/scripts/",
  "node_modules/sliver-script/src/",
  "node_modules/node-pty/lib/",
];

async function listFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function verifyTerminalFontAssets(distributionFiles) {
  const manifestPath = join(rootDir, "protocol/terminal-fonts-provenance.json");
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const expectedIds = ["cascadia-mono", "fira-code", "jetbrains-mono", "source-code-pro"];
  const actualIds = Array.isArray(manifest.fonts)
    ? manifest.fonts.map((font) => font.id).sort()
    : [];
  if (
    manifest.schemaVersion !== 1 ||
    manifest.defaultFontId !== "fira-code" ||
    JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
  ) {
    throw new Error("Terminal font provenance must pin the approved four-family inventory");
  }

  const sourceStyles = await readFile(join(rootDir, "src/renderer/src/styles.css"), "utf8");
  const expectedFiles = [];
  const seenPaths = new Set();
  for (const font of manifest.fonts) {
    if (
      typeof font.family !== "string" ||
      typeof font.version !== "string" ||
      font.license !== "OFL-1.1" ||
      typeof font.copyrightNotice !== "string" ||
      typeof font.repository !== "string" ||
      !font.repository.startsWith("https://github.com/") ||
      typeof font.tag !== "string" ||
      typeof font.commit !== "string" ||
      !/^[0-9a-f]{40}$/u.test(font.commit) ||
      typeof font.licenseUrl !== "string" ||
      !font.licenseUrl.includes(font.commit) ||
      !Array.isArray(font.files) ||
      font.files.length === 0
    ) {
      throw new Error(`Invalid terminal font provenance entry: ${String(font.id)}`);
    }
    if (!sourceStyles.includes(`font-family: "${font.family}"`)) {
      throw new Error(`Renderer CSS does not declare embedded terminal font: ${font.family}`);
    }

    for (const file of font.files) {
      const archive = font.archive;
      if (
        typeof file.path !== "string" ||
        !/^src\/renderer\/src\/assets\/fonts\/[a-z0-9-]+\/[A-Za-z0-9._-]+\.woff2$/u.test(file.path) ||
        seenPaths.has(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        typeof file.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(file.sha256) ||
        (typeof file.sourceUrl !== "string" && typeof file.sourcePath !== "string")
      ) {
        throw new Error(`Invalid terminal font file provenance: ${String(file.path)}`);
      }
      if (typeof file.sourceUrl === "string" && !file.sourceUrl.includes(font.commit)) {
        throw new Error(`Terminal font raw source is not pinned to its commit: ${file.path}`);
      }
      if (
        typeof file.sourcePath === "string" &&
        (
          typeof archive !== "object" ||
          archive === null ||
          typeof archive.url !== "string" ||
          !archive.url.includes(font.tag) ||
          !Number.isSafeInteger(archive.size) ||
          archive.size < 1 ||
          typeof archive.sha256 !== "string" ||
          !/^[0-9a-f]{64}$/u.test(archive.sha256)
        )
      ) {
        throw new Error(`Terminal font archive source is not pinned: ${file.path}`);
      }
      seenPaths.add(file.path);
      const absolutePath = join(rootDir, ...file.path.split("/"));
      const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      if (!metadata.isFile() || content.byteLength !== file.size || sha256(content) !== file.sha256) {
        throw new Error(`Terminal font source failed its integrity check: ${file.path}`);
      }
      const cssPath = `./${file.path.slice("src/renderer/src/".length)}`;
      if (!sourceStyles.includes(`url("${cssPath}")`)) {
        throw new Error(`Renderer CSS does not reference pinned terminal font: ${file.path}`);
      }
      expectedFiles.push({ sha256: file.sha256, size: file.size });
    }
  }
  if (!sourceStyles.includes('--font-mono: "Fira Code"')) {
    throw new Error("Fira Code must remain the default renderer monospace font");
  }

  const builtFontFiles = distributionFiles.filter((filePath) =>
    filePath.endsWith(".woff2") && filePath.startsWith(join(distDir, "renderer", "assets")),
  );
  const builtFiles = await Promise.all(builtFontFiles.map(async (filePath) => {
    const content = await readFile(filePath);
    return { sha256: sha256(content), size: content.byteLength };
  }));
  assertExactTerminalFonts(builtFiles, expectedFiles, "Built renderer");
  return Object.freeze({
    files: Object.freeze(expectedFiles),
    manifestSha256: sha256(manifestBytes),
  });
}

function assertExactTerminalFonts(actual, expected, label) {
  const tokens = (fontFiles) => fontFiles
    .map((file) => `${file.size}:${file.sha256}`)
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(tokens(actual)) !== JSON.stringify(tokens(expected))) {
    throw new Error(`${label} does not contain the exact pinned terminal font inventory`);
  }
}

const files = await listFiles(distDir);
const sourceMaps = files.filter((filePath) => filePath.endsWith(".map"));

if (sourceMaps.length > 0) {
  const names = sourceMaps.map((filePath) => relative(rootDir, filePath)).join("\n");
  throw new Error(`Production source maps must not be packaged:\n${names}`);
}

for (const filePath of files.filter((path) => /\.(?:c?js|html|css|json)$/u.test(path))) {
  const content = await readFile(filePath, "utf8");
  assertNoBannedMarkers(content, relative(rootDir, filePath));
}

const terminalFontEvidence = await verifyTerminalFontAssets(files);

const licenseInventory = await readFile(join(distDir, "THIRD_PARTY_LICENSES.txt"), "utf8");
const applicationPackage = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const sliverScriptVersion = applicationPackage.dependencies?.["sliver-script"];
if (
  typeof sliverScriptVersion !== "string"
  || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(sliverScriptVersion)
) {
  throw new Error("Sliver client dependency must be an exact semantic version");
}
for (const requiredText of [
  "@heroui-pro/react@1.0.0-beta.8",
  "HeroUI Pro License Agreement",
  "@heroui/react@3.2.4",
  "@heroui/styles@3.2.4",
  "Copyright 2025 NextUI Inc.",
  "react@19.2.8",
  "ghostty-web@0.4.0",
  "node-pty@1.1.0",
  "electron-updater@6.8.9",
  `sliver-script@${sliverScriptVersion}\nDeclared license: GPL-3.0-or-later`,
  "Fira Code@6.2 (embedded terminal font)",
  "JetBrains Mono@2.304 (embedded terminal font)",
  "Cascadia Mono@2407.24 (embedded terminal font)",
  "Source Code Pro@2.042R-u/1.062R-i/1.026R-vf (embedded terminal font)",
  "Embedded terminal font entries: 4",
  "Inventory entries:",
]) {
  if (!licenseInventory.includes(requiredText)) {
    throw new Error(`Third-party license inventory is missing: ${requiredText}`);
  }
}

const [projectLicense, gplLicense, mitLicense, apacheLicense, oflLicense, licensingGuide, thirdPartyNotices] =
  await Promise.all([
    readFile(join(rootDir, "LICENSE"), "utf8"),
    readFile(join(rootDir, "LICENSES/GPL-3.0-or-later.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/MIT.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/Apache-2.0.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/OFL-1.1.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/LICENSING.md"), "utf8"),
    readFile(join(rootDir, "THIRD_PARTY_NOTICES.md"), "utf8"),
  ]);
if (projectLicense !== gplLicense) {
  throw new Error("Root LICENSE must be the canonical GPLv3 text copied to LICENSES/GPL-3.0-or-later.txt");
}
for (const requiredText of [
  "GNU GENERAL PUBLIC LICENSE",
  "Version 3, 29 June 2007",
  "END OF TERMS AND CONDITIONS",
]) {
  if (!projectLicense.includes(requiredText)) {
    throw new Error(`Project GPL license is missing: ${requiredText}`);
  }
}
if (projectLicense.includes("Permission is hereby granted") || projectLicense.includes("Angular Electron")) {
  throw new Error("Root LICENSE must not mix third-party MIT notices into the project GPL text");
}
for (const [name, content, markers] of [
  ["MIT", mitLicense, ["MIT License", "Permission is hereby granted"]],
  ["Apache-2.0", apacheLicense, ["Apache License", "Version 2.0, January 2004", "Copyright 2025 NextUI Inc."]],
  ["OFL-1.1", oflLicense, ["SIL OPEN FONT LICENSE Version 1.1", "PERMISSION & CONDITIONS", "Reserved Font Name"]],
]) {
  for (const marker of markers) {
    if (!content.includes(marker)) throw new Error(`${name} license text is missing: ${marker}`);
  }
}
for (const [name, content] of [
  ["LICENSES/LICENSING.md", licensingGuide],
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices],
]) {
  if (!/not dual-licens(?:e|ed)/u.test(content)) {
    throw new Error(`${name} must state that third-party license texts do not dual-license Sliver GUI`);
  }
}
const sliverNoticeVersions = [...thirdPartyNotices.matchAll(/bundles `sliver-script` version ([^,\s]+)/gu)];
if (sliverNoticeVersions.length !== 1 || sliverNoticeVersions[0][1] !== sliverScriptVersion) {
  throw new Error("THIRD_PARTY_NOTICES.md must identify the exact installed sliver-script version once");
}
const sliverNoticeTags = [
  ...thirdPartyNotices.matchAll(/https:\/\/github\.com\/sliverarmory\/sliver-script\/tree\/v([^\s]+)/gu),
];
if (sliverNoticeTags.length !== 1 || sliverNoticeTags[0][1] !== sliverScriptVersion) {
  throw new Error("THIRD_PARTY_NOTICES.md must link the exact installed sliver-script source tag once");
}

const builderConfiguration = await readFile(join(rootDir, "electron-builder.yml"), "utf8");
for (const requiredPath of requiredBuilderPaths) {
  if (!builderConfiguration.includes(`- ${requiredPath}`)) {
    throw new Error(`Production package allowlist is missing: ${requiredPath}`);
  }
}
for (const requiredSetting of [
  "from: build/about-icon.png",
  "to: sliver-desktop.png",
  "from: LICENSES",
  "to: licenses",
  "from: THIRD_PARTY_NOTICES.md",
  "to: licenses/THIRD_PARTY_NOTICES.md",
  "from: dist/THIRD_PARTY_LICENSES.txt",
  "to: licenses/THIRD_PARTY_LICENSES.txt",
]) {
  if (!builderConfiguration.includes(requiredSetting)) {
    throw new Error(`Production package branding is missing: ${requiredSetting}`);
  }
}
const configuredPlatformIcons = builderConfiguration.match(/^\s+icon: build\/icon\.png$/gmu) ?? [];
if (configuredPlatformIcons.length !== 3) {
  throw new Error("Production package branding must configure the app icon for macOS, Windows, and Linux");
}
for (const forbiddenPath of [".e2e-dist", "src/e2e", "tsconfig.e2e", "artifacts/e2e"]) {
  if (builderConfiguration.includes(forbiddenPath)) {
    throw new Error(`Production package allowlist references test-only content: ${forbiddenPath}`);
  }
}

const sliverClientEvidence = await verifyInstalledSliverClient();
const sliverConsoleEvidence = await verifyPreparedSliverConsole();
await verifyNodePtyDirectory(join(rootDir, "node_modules/node-pty"), process.platform);

if (verifyPackaged) {
  const archives = exactArchiveArgument
    ? [await exactPackagedArchive(exactArchiveArgument)]
    : [await newestPackagedArchive()];

  for (const archive of archives) {
    verifyArchive(archive, terminalFontEvidence, sliverClientEvidence);
    await verifyExternalBrandAsset(archive);
    await verifyExternalLegalAssets(archive);
    await verifyExternalSliverConsole(archive, sliverConsoleEvidence);
    await verifyExternalNodePtyRuntime(archive);
  }
  console.log(`Verified ${archives.length} packaged app.asar archive(s) contain no E2E or secret fixtures`);
}

async function verifyExternalNodePtyRuntime(archivePath) {
  const moduleDirectory = join(`${archivePath}.unpacked`, "node_modules", "node-pty");
  await verifyNodePtyDirectory(moduleDirectory, process.platform, true);
  if (process.platform === "darwin") {
    const architectures = archivePath.replaceAll("\\", "/").includes("/mac-universal/")
      ? ["x86_64", "arm64"]
      : [process.arch === "x64" ? "x86_64" : "arm64"];
    for (const relativePath of ["build/Release/pty.node", "build/Release/spawn-helper"]) {
      await runCommand("/usr/bin/lipo", [
        join(moduleDirectory, ...relativePath.split("/")),
        "-verify_arch",
        ...architectures,
      ]);
    }
  }
}

async function verifyNodePtyDirectory(moduleDirectory, platform, packaged = false) {
  const files = packaged ? packagedRuntimeFilesForPlatform(platform) : runtimeFilesForPlatform(platform);
  for (const relativePath of files.required) {
    const filePath = join(moduleDirectory, ...relativePath.split("/"));
    const metadata = await stat(filePath).catch(() => undefined);
    if (!metadata?.isFile() || metadata.size === 0) {
      throw new Error(`node-pty runtime is missing required ${platform} file: ${filePath}`);
    }
  }
  for (const relativePath of files.helpers) {
    const metadata = await stat(join(moduleDirectory, ...relativePath.split("/")));
    if ((metadata.mode & 0o111) !== 0o111) {
      throw new Error(`node-pty spawn helper is not executable: ${relativePath}`);
    }
  }
}

async function verifyPreparedSliverConsole() {
  const [sourceManifestContent, baselineContent, buildRecordContent, sourceLicense, applicationPackageContent] = await Promise.all([
    readFile(join(rootDir, "protocol/sliver-console-provenance.json"), "utf8"),
    readFile(join(rootDir, "protocol/sliver-baseline.json"), "utf8"),
    readFile(join(rootDir, "native/sliver-console/provenance.json"), "utf8"),
    readFile(join(rootDir, "native/sliver-console/LICENSE")),
    readFile(join(rootDir, "package.json"), "utf8"),
  ]);
  const sourceManifest = JSON.parse(sourceManifestContent);
  const baseline = JSON.parse(baselineContent);
  const buildRecord = JSON.parse(buildRecordContent);
  const applicationPackage = JSON.parse(applicationPackageContent);
  const sourceOverlay = await verifySourceOverlayReplacements({
    sourceManifest,
    repositoryDirectory: rootDir,
  });
  if (
    applicationPackage.version !== sourceOverlay.record.correspondingSource.packageVersion ||
    JSON.stringify(buildRecord.build?.overlay) !== JSON.stringify(sourceOverlay.record)
  ) {
    throw new Error("Native Sliver console source overlay provenance does not match the application release");
  }
  if (
    sourceManifest.schemaVersion !== 1 ||
    sourceManifest.source?.commit !== baseline.commit ||
    sourceManifest.source?.tree !== baseline.tree ||
    sourceManifest.source?.module !== "github.com/bishopfox/sliver" ||
    sourceManifest.source?.commandPackage !== "github.com/bishopfox/sliver/client" ||
    sourceManifest.toolchain?.go !== "go1.26.6"
  ) {
    throw new Error("Native Sliver console source provenance does not match the pinned protocol baseline");
  }
  if (sha256(sourceLicense) !== sourceManifest.source.licenseSha256) {
    throw new Error("Native Sliver console license does not match its source provenance");
  }
  if (
    buildRecord.schemaVersion !== 1 ||
    buildRecord.source?.commit !== sourceManifest.source.commit ||
    buildRecord.source?.tree !== sourceManifest.source.tree ||
    buildRecord.toolchain?.go !== sourceManifest.toolchain.go
  ) {
    throw new Error("Native Sliver console build record does not match its source provenance");
  }
  const executableName = buildRecord.artifact?.fileName;
  if (!new Set(["sliver-client", "sliver-client.exe"]).has(executableName)) {
    throw new Error("Native Sliver console build record has an invalid executable name");
  }
  const expectedTarget = process.platform === "darwin"
    ? "darwin-universal"
    : process.platform === "win32"
      ? "windows-amd64"
      : "linux-amd64";
  if (buildRecord.build?.target !== expectedTarget) {
    throw new Error(`Native Sliver console target ${buildRecord.build?.target} does not match ${expectedTarget}`);
  }
  if (JSON.stringify(buildRecord.build?.linkerDefaults) !== JSON.stringify(SLIVER_CLIENT_LINKER_DEFAULTS)) {
    throw new Error("Native Sliver console linker defaults do not match the audited Sliver client build");
  }
  const expectedSlices = expectedTarget === "darwin-universal"
    ? [{ goos: "darwin", goarch: "amd64" }, { goos: "darwin", goarch: "arm64" }]
    : expectedTarget === "windows-amd64"
      ? [{ goos: "windows", goarch: "amd64" }]
      : [{ goos: "linux", goarch: "amd64" }];
  if (!Array.isArray(buildRecord.build?.slices) || buildRecord.build.slices.length !== expectedSlices.length) {
    throw new Error("Native Sliver console build record has the wrong target slices");
  }
  for (let index = 0; index < expectedSlices.length; index += 1) {
    const expected = expectedSlices[index];
    const actual = buildRecord.build.slices[index];
    if (
      actual.goos !== expected.goos ||
      actual.goarch !== expected.goarch ||
      actual.buildInfo?.commandPackage !== sourceManifest.source.commandPackage ||
      actual.buildInfo?.module !== sourceManifest.source.module ||
      actual.buildInfo?.vcsRevision !== sourceManifest.source.commit ||
      actual.buildInfo?.vcsModified !== false
    ) {
      throw new Error(`Native Sliver console build record has invalid ${expected.goos}/${expected.goarch} build information`);
    }
  }
  const executablePath = join(rootDir, "native/sliver-console", executableName);
  const [executable, executableMetadata] = await Promise.all([readFile(executablePath), stat(executablePath)]);
  if (
    executable.byteLength !== buildRecord.artifact?.size ||
    sha256(executable) !== buildRecord.artifact?.sha256
  ) {
    throw new Error("Native Sliver console executable does not match its build record");
  }
  if (process.platform !== "win32" && (executableMetadata.mode & 0o111) === 0) {
    throw new Error("Native Sliver console executable is not marked executable");
  }
  await verifySliverExecutableBuildInfo(executablePath, { buildRecord, sourceManifest });
  return { sourceManifestContent, sourceManifest, buildRecordContent, buildRecord, executable, sourceLicense };
}

async function verifyExternalSliverConsole(archivePath, evidence) {
  const resourcesDirectory = dirname(archivePath);
  const resourceDirectory = join(resourcesDirectory, "sliver-console");
  const [sourceManifest, buildRecord, executable, sourceLicense] = await Promise.all([
    readFile(join(resourceDirectory, "source-provenance.json"), "utf8").catch(() => undefined),
    readFile(join(resourceDirectory, "provenance.json"), "utf8").catch(() => undefined),
    readFile(join(resourceDirectory, evidence.buildRecord.artifact.fileName)).catch(() => undefined),
    readFile(join(resourceDirectory, "LICENSE")).catch(() => undefined),
  ]);
  if (sourceManifest !== evidence.sourceManifestContent || buildRecord !== evidence.buildRecordContent) {
    throw new Error(`Packaged application has incomplete Sliver console provenance: ${resourceDirectory}`);
  }
  if (!executable) throw new Error(`Packaged application is missing the Sliver console executable: ${resourceDirectory}`);
  if (!sourceLicense || sha256(sourceLicense) !== sha256(evidence.sourceLicense)) {
    throw new Error(`Packaged application is missing the pinned Sliver console license: ${resourceDirectory}`);
  }
  await verifyPackagedSourceOverlayFiles({
    packagedDirectory: resourceDirectory,
    sourceOverlay: evidence.sourceManifest.build?.overlay,
    buildOverlay: evidence.buildRecord.build?.overlay,
  });
  const executablePath = join(resourceDirectory, evidence.buildRecord.artifact.fileName);
  const exactUnsignedDigest = sha256(executable) === evidence.buildRecord.artifact.sha256;
  const signatureRequired = process.env.SLIVER_GUI_REQUIRE_SIGNED_CHILD === "true" ||
    process.env.SLIVER_GUI_REQUIRE_SIGNED_CHILD === "1";
  if (process.platform === "linux" && !exactUnsignedDigest) {
    throw new Error(`Packaged Linux Sliver console changed after its pre-sign integrity check: ${executablePath}`);
  }
  if (signatureRequired && exactUnsignedDigest) {
    throw new Error(`Release Sliver console was not independently signed: ${executablePath}`);
  }
  if (!exactUnsignedDigest || signatureRequired) {
    await verifyNestedSliverSignature(archivePath, executablePath, signatureRequired);
  }
  await verifySliverExecutableBuildInfo(executablePath, evidence);
}

async function verifySliverExecutableBuildInfo(executablePath, evidence) {
  const goBinary = process.env.SLIVER_GO_BINARY ?? "go";
  const goEnvironment = hermeticGoEnvironment(process.env);
  const slices = evidence.buildRecord.build.slices;
  if (process.platform === "darwin") {
    await runCommand("/usr/bin/lipo", [executablePath, "-verify_arch", "x86_64", "arm64"]);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-console-buildinfo-"));
    try {
      for (const slice of slices) {
        const lipoArchitecture = slice.goarch === "amd64" ? "x86_64" : slice.goarch;
        const thinPath = join(temporaryDirectory, `sliver-client-${slice.goarch}`);
        await runCommand("/usr/bin/lipo", [executablePath, "-thin", lipoArchitecture, "-output", thinPath]);
        const { stdout } = await runCommand(goBinary, ["version", "-m", thinPath], { env: goEnvironment });
        validateGoBuildInfo(stdout, { sourceManifest: evidence.sourceManifest, slice });
      }
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
    return;
  }

  if (slices.length !== 1) throw new Error("Native Sliver console has an invalid non-macOS slice count");
  const { stdout } = await runCommand(goBinary, ["version", "-m", executablePath], { env: goEnvironment });
  validateGoBuildInfo(stdout, { sourceManifest: evidence.sourceManifest, slice: slices[0] });
}

async function verifyNestedSliverSignature(archivePath, executablePath, signatureRequired) {
  if (process.platform === "darwin") {
    const appPath = resolve(dirname(archivePath), "..", "..");
    await runCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", executablePath]);
    await runCommand("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", appPath]);
    const childDetails = await runCommand("/usr/bin/codesign", ["-dv", "--verbose=4", executablePath]);
    const appDetails = await runCommand("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]);
    const childTeam = signingDetail(childDetails.stderr, "TeamIdentifier");
    const appTeam = signingDetail(appDetails.stderr, "TeamIdentifier");
    const expectedTeam = process.env.APPLE_TEAM_ID?.trim();
    if (signatureRequired && !expectedTeam) {
      throw new Error("Signed Sliver console verification requires APPLE_TEAM_ID");
    }
    if (!childTeam || childTeam === "not set" || childTeam !== appTeam || (expectedTeam && childTeam !== expectedTeam)) {
      throw new Error(`Packaged Sliver console signature team ${childTeam ?? "missing"} does not match its application publisher`);
    }
    return;
  }

  if (process.platform === "win32") {
    const appPath = join(dirname(dirname(archivePath)), "Sliver GUI.exe");
    const expectedPublisher = process.env.WIN_CSC_PUBLISHER_NAME?.trim();
    if (signatureRequired && !expectedPublisher) {
      throw new Error("Signed Sliver console verification requires WIN_CSC_PUBLISHER_NAME");
    }
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$paths = @($env:SLIVER_GUI_CHILD_EXECUTABLE, $env:SLIVER_GUI_APPLICATION_EXECUTABLE)",
      "foreach ($path in $paths) {",
      "  $signature = Get-AuthenticodeSignature -LiteralPath $path",
      "  if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) { throw \"Invalid Authenticode signature: $path ($($signature.Status))\" }",
      "  [Console]::Out.WriteLine($signature.SignerCertificate.Subject)",
      "}",
    ].join("\n");
    const { stdout } = await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], {
      env: {
        ...process.env,
        SLIVER_GUI_APPLICATION_EXECUTABLE: appPath,
        SLIVER_GUI_CHILD_EXECUTABLE: executablePath,
      },
    });
    const publishers = stdout.trim().split(/\r?\n/u);
    if (
      publishers.length !== 2 ||
      publishers[0] !== publishers[1] ||
      (expectedPublisher && publishers[0] !== expectedPublisher)
    ) {
      throw new Error("Packaged Sliver console Authenticode publisher does not match its application publisher");
    }
    return;
  }

  throw new Error(`Packaged Sliver console changed unexpectedly on unsigned platform ${process.platform}`);
}

function signingDetail(output, name) {
  return output.match(new RegExp(`^${name}=(.+)$`, "mu"))?.[1]?.trim();
}

async function verifyExternalBrandAsset(archivePath) {
  const expected = await readFile(join(rootDir, "build/about-icon.png"));
  const packagedPath = join(dirname(archivePath), "sliver-desktop.png");
  const packaged = await readFile(packagedPath).catch(() => undefined);
  if (!packaged || sha256(packaged) !== sha256(expected)) {
    throw new Error(`Packaged application is missing the approved About/window icon: ${packagedPath}`);
  }
}

async function verifyExternalLegalAssets(archivePath) {
  const resourcesDirectory = dirname(archivePath);
  const expectedFiles = [
    [join(rootDir, "LICENSES/Apache-2.0.txt"), "licenses/Apache-2.0.txt"],
    [join(rootDir, "LICENSES/GPL-3.0-or-later.txt"), "licenses/GPL-3.0-or-later.txt"],
    [join(rootDir, "LICENSES/MIT.txt"), "licenses/MIT.txt"],
    [join(rootDir, "LICENSES/OFL-1.1.txt"), "licenses/OFL-1.1.txt"],
    [join(rootDir, "LICENSES/README.md"), "licenses/README.md"],
    [join(rootDir, "LICENSES/LICENSING.md"), "licenses/LICENSING.md"],
    [join(rootDir, "THIRD_PARTY_NOTICES.md"), "licenses/THIRD_PARTY_NOTICES.md"],
    [join(distDir, "THIRD_PARTY_LICENSES.txt"), "licenses/THIRD_PARTY_LICENSES.txt"],
  ];
  for (const [sourcePath, packagedRelativePath] of expectedFiles) {
    const [source, packaged] = await Promise.all([
      readFile(sourcePath),
      readFile(join(resourcesDirectory, packagedRelativePath)).catch(() => undefined),
    ]);
    if (!packaged || sha256(packaged) !== sha256(source)) {
      throw new Error(`Packaged application is missing exact legal asset: ${packagedRelativePath}`);
    }
  }
}

function argumentValue(name) {
  const indexes = process.argv.flatMap((argument, index) => argument === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function exactPackagedArchive(configuredPath) {
  if (!isAbsolute(configuredPath)) throw new Error("--archive must be an absolute app.asar path");
  const archive = await realpath(configuredPath);
  const metadata = await stat(archive);
  if (!metadata.isFile() || !archiveMatchesCurrentPlatform(archive)) {
    throw new Error(`The exact archive is not a packaged app.asar for ${process.platform}`);
  }
  return archive;
}

async function newestPackagedArchive() {
  const packagedFiles = await listFiles(releaseDir);
  const candidates = packagedFiles.filter(
    (filePath) => filePath.endsWith("app.asar") && archiveMatchesCurrentPlatform(filePath),
  );
  if (candidates.length === 0) {
    throw new Error(`No packaged app.asar was found for ${process.platform} under ${releaseDir}`);
  }
  return newestFile(candidates);
}

function archiveMatchesCurrentPlatform(filePath) {
  const normalized = filePath.replaceAll("\\", "/");
  if (process.platform === "darwin") return /\/mac(?:-[^/]+)?\/[^/]+\.app\/Contents\/Resources\/app\.asar$/u.test(normalized);
  if (process.platform === "win32") return /\/win(?:-[^/]+)?\/resources\/app\.asar$/iu.test(normalized);
  return /\/linux(?:-[^/]+)?\/resources\/app\.asar$/u.test(normalized);
}

async function newestFile(paths) {
  const dated = await Promise.all(paths.map(async (path) => ({ path, modifiedAt: (await stat(path)).mtimeMs })));
  dated.sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
  return dated[0].path;
}

function verifyArchive(archivePath, terminalFontEvidence, sliverClientEvidence) {
  const entries = listPackage(archivePath, { isPack: false }).map(asarEntryPaths);
  const normalizedEntries = entries.map(({ normalizedPath }) => normalizedPath);
  const forbiddenEntries = normalizedEntries.filter((entry) =>
    /(?:^|\/)(?:\.e2e-dist|e2e|fixtures?|artifacts)(?:\/|$)|(?:\.e2e|\.test|\.spec)\.[cm]?[jt]sx?$|tsconfig\.e2e\.json$/iu.test(entry),
  );
  if (forbiddenEntries.length > 0) {
    throw new Error(`Packaged archive contains test-only files:\n${forbiddenEntries.join("\n")}`);
  }
  if (normalizedEntries.some((entry) => entry.endsWith(".map"))) {
    throw new Error(`Packaged archive contains production source maps: ${archivePath}`);
  }

  for (const requiredPath of requiredPackagedFiles) {
    if (!normalizedEntries.includes(requiredPath)) {
      throw new Error(`Packaged archive is missing required application/source evidence: ${requiredPath}`);
    }
  }
  const packagedFontEntries = entries.filter(({ normalizedPath }) =>
    normalizedPath.startsWith("dist/renderer/assets/") && normalizedPath.endsWith(".woff2"),
  );
  const packagedFonts = packagedFontEntries.map((entry) => {
    const content = extractFile(archivePath, entry.lookupPath, false);
    return { sha256: sha256(content), size: content.byteLength };
  });
  assertExactTerminalFonts(packagedFonts, terminalFontEvidence.files, "Packaged renderer");
  const fontManifestEntry = entries.find(
    ({ normalizedPath }) => normalizedPath === "protocol/terminal-fonts-provenance.json",
  );
  if (
    !fontManifestEntry ||
    sha256(extractFile(archivePath, fontManifestEntry.lookupPath, false)) !== terminalFontEvidence.manifestSha256
  ) {
    throw new Error("Packaged terminal font provenance manifest failed its integrity check");
  }
  const terminalRuntimeEntry = entries.find(
    ({ normalizedPath }) => normalizedPath === "node_modules/ghostty-web/ghostty-vt.wasm",
  );
  if (!terminalRuntimeEntry) {
    throw new Error("Packaged archive lost the required Ghostty runtime entry during verification");
  }
  const terminalRuntime = extractFile(archivePath, terminalRuntimeEntry.lookupPath, false);
  const terminalRuntimeSha256 = sha256(terminalRuntime);
  if (terminalRuntime.byteLength !== 423_045 || terminalRuntimeSha256 !== "d6f0326f1874ad2ce9f289e3a4a0c5f3507d4cb38d8747e4b287def470a0c60a") {
    throw new Error(`Packaged Ghostty runtime failed its integrity check: ${archivePath}`);
  }
  const nativePtyPrefixes = ["node_modules/node-pty/build/Release/"];
  for (const nativePrefix of nativePtyPrefixes) {
    if (!normalizedEntries.some((entry) => entry.startsWith(nativePrefix))) {
      throw new Error(`Packaged archive has no node-pty runtime under ${nativePrefix}`);
    }
  }
  for (const requiredPrefix of requiredPackagedPrefixes) {
    if (!normalizedEntries.some((entry) => entry.startsWith(requiredPrefix))) {
      throw new Error(`Packaged archive has no files under required application/source path: ${requiredPrefix}`);
    }
  }

  const applicationManifestEntry = entries.find(({ normalizedPath }) => normalizedPath === "package.json");
  const applicationManifest = JSON.parse(
    extractFile(archivePath, applicationManifestEntry.lookupPath, false).toString("utf8"),
  );
  if (applicationManifest.dependencies?.["sliver-script"] !== sliverClientEvidence.version) {
    throw new Error("Packaged application manifest lost the exact sliver-script dependency version");
  }
  for (const [packagedPath, expected] of sliverClientEvidence.releaseFiles) {
    const entry = entries.find(({ normalizedPath }) => normalizedPath === packagedPath);
    if (!entry || !extractFile(archivePath, entry.lookupPath, false).equals(expected)) {
      throw new Error(`Packaged sliver-script release evidence failed its integrity check: ${packagedPath}`);
    }
  }

  verifyPackagedSliverClient(archivePath, entries, sliverClientEvidence);

  for (const entry of entries) {
    const metadata = statFile(archivePath, entry.lookupPath, false);
    if (!("size" in metadata)) continue;
    assertNoBannedMarkers(
      extractFile(archivePath, entry.lookupPath, false),
      `${archivePath}:${entry.normalizedPath}`,
    );
  }
}

async function verifyInstalledSliverClient() {
  await runCommand(process.execPath, [join(rootDir, "scripts/protocol-verify-client-package.mjs")], {
    cwd: rootDir,
  });
  const provenance = JSON.parse(
    await readFile(join(rootDir, "protocol/sliver-script-provenance.json"), "utf8"),
  );
  const packageRoot = resolve(rootDir, provenance.installedPackage.root);
  const files = new Map();
  for (const absolutePath of await listFiles(packageRoot)) {
    const packagePath = relative(packageRoot, absolutePath).replaceAll("\\", "/");
    if (packagedSliverClientPath(packagePath)) {
      files.set(packagePath, await readFile(absolutePath));
    }
  }
  const releaseFiles = new Map();
  for (const packagedPath of ["protocol/sliver-baseline.json", "protocol/sliver-script-provenance.json"]) {
    releaseFiles.set(packagedPath, await readFile(join(rootDir, packagedPath)));
  }
  return Object.freeze({
    root: provenance.installedPackage.root,
    version: provenance.package.version,
    files,
    releaseFiles,
  });
}

function verifyPackagedSliverClient(archivePath, entries, evidence) {
  const prefix = `${evidence.root}/`;
  const packagedFiles = new Map();
  for (const entry of entries) {
    if (!entry.normalizedPath.startsWith(prefix)) continue;
    const metadata = statFile(archivePath, entry.lookupPath, false);
    if (!("size" in metadata)) continue;
    const packagePath = entry.normalizedPath.slice(prefix.length);
    packagedFiles.set(packagePath, entry);
  }

  const expectedPaths = [...evidence.files.keys()].sort();
  const actualPaths = [...packagedFiles.keys()].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    throw new Error(
      `Packaged sliver-script file inventory drifted; expected ${expectedPaths.length}, received ${actualPaths.length}`,
    );
  }
  for (const packagePath of expectedPaths) {
    const entry = packagedFiles.get(packagePath);
    const expected = evidence.files.get(packagePath);
    const actual = extractFile(archivePath, entry.lookupPath, false);
    if (packagePath === "package.json") {
      const expectedManifest = JSON.parse(expected.toString("utf8"));
      const actualManifest = JSON.parse(actual.toString("utf8"));
      for (const removedByElectronBuilder of ["bugs", "keywords", "scripts"]) {
        delete expectedManifest[removedByElectronBuilder];
      }
      if (JSON.stringify(actualManifest) !== JSON.stringify(expectedManifest)) {
        throw new Error("Packaged sliver-script manifest drifted beyond Electron Builder's fixed pruning");
      }
    } else if (!actual.equals(expected)) {
      throw new Error(`Packaged sliver-script file failed its integrity check: ${packagePath}`);
    }
  }
}

function packagedSliverClientPath(path) {
  return [
    "LICENSE",
    "integration.lock.json",
    "package.json",
    "protobuf.lock.json",
    "protobuf.sh",
    "tsconfig.json",
  ].includes(path)
    || path.startsWith("scripts/")
    || path.startsWith("src/")
    || (path.startsWith("lib/") && path.endsWith(".js"));
}

async function runCommand(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) return accept(result);
      const detail = result.stderr.trim();
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${detail ? `: ${detail}` : ""}`));
    });
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function assertNoBannedMarkers(content, label) {
  for (const marker of bannedProductionMarkers) {
    const found = Buffer.isBuffer(content)
      ? content.includes(Buffer.from(marker))
      : content.includes(marker);
    if (found) throw new Error(`${label} contains test-only marker ${marker}`);
  }
}
