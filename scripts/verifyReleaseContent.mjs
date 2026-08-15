import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractFile, listPackage, statFile } from "@electron/asar";

import { asarEntryPaths } from "./asarEntryPaths.mjs";

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
  "LICENSING.md",
  "LICENSES/**",
  "THIRD_PARTY_NOTICES.md",
  "node_modules/ghostty-web/LICENSE",
  "node_modules/ghostty-web/package.json",
  "node_modules/ghostty-web/ghostty-vt.wasm",
  "vendor/sliver-script/LICENSE",
  "vendor/sliver-script/README.md",
  "vendor/sliver-script/VENDORED.md",
  "vendor/sliver-script/package.json",
  "vendor/sliver-script/tsconfig.json",
  "vendor/sliver-script/sliver-script-snapshot.bundle",
  "vendor/sliver-script/patches/**",
  "vendor/sliver-script/src/**",
  "protocol/sliver-baseline.json",
  "protocol/sliver-script-provenance.json",
  "protocol/sliver-script-handwritten-overlay.patch",
  "protocol/ghostty-web-provenance.json",
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
  "LICENSES/MIT.txt",
  "LICENSES/README.md",
  "package.json",
  "node_modules/ghostty-web/LICENSE",
  "node_modules/ghostty-web/package.json",
  "node_modules/ghostty-web/ghostty-vt.wasm",
  "node_modules/electron-updater/LICENSE",
  "node_modules/electron-updater/package.json",
  "node_modules/electron-updater/out/main.js",
  "dist/main/index.js",
  "dist/preload/index.cjs",
  "dist/renderer/index.html",
  "vendor/sliver-script/LICENSE",
  "vendor/sliver-script/README.md",
  "vendor/sliver-script/VENDORED.md",
  "vendor/sliver-script/package.json",
  "vendor/sliver-script/tsconfig.json",
  "vendor/sliver-script/sliver-script-snapshot.bundle",
  "protocol/sliver-baseline.json",
  "protocol/sliver-script-provenance.json",
  "protocol/sliver-script-handwritten-overlay.patch",
  "protocol/ghostty-web-provenance.json",
  "docs/operator-parity.generated.json",
  "docs/operator-parity.annotations.json",
  "docs/operator-parity.schema.json",
  "docs/operator-parity.md",
  "docs/adr/0001-platform-support.md",
  "docs/rpc-message-budgets.md",
];
const requiredPackagedPrefixes = [
  "dist/renderer/assets/",
  "vendor/sliver-script/patches/",
  "vendor/sliver-script/src/",
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

const licenseInventory = await readFile(join(distDir, "THIRD_PARTY_LICENSES.txt"), "utf8");
for (const requiredText of [
  "@heroui-pro/react@1.0.0-beta.8",
  "HeroUI Pro License Agreement",
  "@heroui/react@3.2.4",
  "@heroui/styles@3.2.4",
  "Copyright 2025 NextUI Inc.",
  "react@19.2.8",
  "ghostty-web@0.4.0",
  "electron-updater@6.8.9",
  "Inventory entries:",
]) {
  if (!licenseInventory.includes(requiredText)) {
    throw new Error(`Third-party license inventory is missing: ${requiredText}`);
  }
}

const [projectLicense, gplLicense, mitLicense, apacheLicense, licensingGuide, thirdPartyNotices] =
  await Promise.all([
    readFile(join(rootDir, "LICENSE"), "utf8"),
    readFile(join(rootDir, "LICENSES/GPL-3.0-or-later.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/MIT.txt"), "utf8"),
    readFile(join(rootDir, "LICENSES/Apache-2.0.txt"), "utf8"),
    readFile(join(rootDir, "LICENSING.md"), "utf8"),
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
]) {
  for (const marker of markers) {
    if (!content.includes(marker)) throw new Error(`${name} license text is missing: ${marker}`);
  }
}
for (const [name, content] of [
  ["LICENSING.md", licensingGuide],
  ["THIRD_PARTY_NOTICES.md", thirdPartyNotices],
]) {
  if (!/not dual-licens(?:e|ed)/u.test(content)) {
    throw new Error(`${name} must state that third-party license texts do not dual-license Sliver GUI`);
  }
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
  "from: LICENSING.md",
  "to: licenses/LICENSING.md",
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

if (verifyPackaged) {
  const archives = exactArchiveArgument
    ? [await exactPackagedArchive(exactArchiveArgument)]
    : [await newestPackagedArchive()];

  for (const archive of archives) {
    verifyArchive(archive);
    await verifyExternalBrandAsset(archive);
    await verifyExternalLegalAssets(archive);
  }
  console.log(`Verified ${archives.length} packaged app.asar archive(s) contain no E2E or secret fixtures`);
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
    [join(rootDir, "LICENSES/README.md"), "licenses/README.md"],
    [join(rootDir, "LICENSING.md"), "licenses/LICENSING.md"],
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

function verifyArchive(archivePath) {
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
  for (const requiredPrefix of requiredPackagedPrefixes) {
    if (!normalizedEntries.some((entry) => entry.startsWith(requiredPrefix))) {
      throw new Error(`Packaged archive has no files under required application/source path: ${requiredPrefix}`);
    }
  }

  for (const entry of entries) {
    const metadata = statFile(archivePath, entry.lookupPath, false);
    if (!("size" in metadata)) continue;
    assertNoBannedMarkers(
      extractFile(archivePath, entry.lookupPath, false),
      `${archivePath}:${entry.normalizedPath}`,
    );
  }
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
