import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(argumentValue("--directory") ?? join(rootDir, "release"));
const platform = argumentValue("--platform");
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const version = argumentValue("--version") ?? packageJson.version;
const checksumsFile = argumentValue("--checksums");
const appUpdateFile = argumentValue("--app-update");
const publisherName = argumentValue("--publisher-name");

if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
  throw new Error(`--version must be an exact stable SemVer version: ${version}`);
}

const inventories = {
  macos: {
    files: [
      "latest-mac.yml",
      `sliver-gui-${version}-macos-universal.dmg`,
      `sliver-gui-${version}-macos-universal.dmg.blockmap`,
      `sliver-gui-${version}-macos-universal.zip`,
      `sliver-gui-${version}-macos-universal.zip.blockmap`,
    ],
    metadata: "latest-mac.yml",
    primary: `sliver-gui-${version}-macos-universal.zip`,
    referenced: [
      `sliver-gui-${version}-macos-universal.zip`,
      `sliver-gui-${version}-macos-universal.dmg`,
    ],
  },
  windows: {
    files: [
      "latest.yml",
      `sliver-gui-${version}-windows-x64-portable.exe`,
      `sliver-gui-${version}-windows-x64-setup.exe`,
      `sliver-gui-${version}-windows-x64-setup.exe.blockmap`,
    ],
    metadata: "latest.yml",
    primary: `sliver-gui-${version}-windows-x64-setup.exe`,
    referenced: [`sliver-gui-${version}-windows-x64-setup.exe`],
  },
  linux: {
    files: [
      "latest-linux.yml",
      `sliver-gui-${version}-linux-x86_64.AppImage`,
      `sliver-gui-${version}-linux-amd64.deb`,
    ],
    metadata: "latest-linux.yml",
    primary: `sliver-gui-${version}-linux-x86_64.AppImage`,
    referenced: [
      `sliver-gui-${version}-linux-x86_64.AppImage`,
      `sliver-gui-${version}-linux-amd64.deb`,
    ],
  },
};

if (!platform || (platform !== "all" && !(platform in inventories))) {
  throw new Error("--platform must be macos, windows, linux, or all");
}

const selected = platform === "all" ? Object.values(inventories) : [inventories[platform]];
const expected = [...new Set(selected.flatMap(({ files }) => files))].sort();
const entries = await readdir(directory, { withFileTypes: true });
const regularFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
const checksumName = checksumsFile ? basename(checksumsFile) : undefined;
const inventoryFiles = checksumName ? regularFiles.filter((name) => name !== checksumName) : regularFiles;
const actual = platform === "all" ? inventoryFiles : inventoryFiles.filter(isPlatformArtifact).sort();

assertExactNames(actual, expected, `release artifact inventory for ${platform}`);

for (const name of expected) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
    throw new Error(`Release asset name is not URL-safe: ${name}`);
  }
  const metadata = await stat(join(directory, name));
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`Release asset is empty or not a regular file: ${name}`);
  }
}

for (const inventory of selected) {
  await verifyMetadata(inventory);
}

if (appUpdateFile) {
  await verifyPackagedUpdateConfiguration(resolve(appUpdateFile), publisherName);
} else if (publisherName) {
  throw new Error("--publisher-name requires --app-update");
}

if (checksumsFile) {
  await verifyChecksums(resolve(directory, checksumsFile), expected);
}

console.log(
  `Verified ${expected.length} ${platform} update/release artifact(s) for version ${version}` +
    (checksumsFile ? " and their SHA-256 checksums" : "") +
    (appUpdateFile ? " with the public packaged update provider" : ""),
);

function isPlatformArtifact(name) {
  if (platform === "macos") {
    return name === "latest-mac.yml" || /\.(?:dmg|zip)(?:\.blockmap)?$/u.test(name);
  }
  if (platform === "windows") {
    return name === "latest.yml" || /\.exe(?:\.blockmap)?$/iu.test(name);
  }
  return name === "latest-linux.yml" || /\.(?:AppImage|deb)$/u.test(name);
}

async function verifyMetadata(inventory) {
  const metadataPath = join(directory, inventory.metadata);
  const content = await readFile(metadataPath, "utf8");
  const metadataVersion = scalarValue(content, "version");
  if (metadataVersion !== version) {
    throw new Error(`${inventory.metadata} version ${metadataVersion} does not match ${version}`);
  }

  const fileEntries = metadataFileEntries(content, inventory.metadata);
  const urls = fileEntries.map(({ url }) => url);
  assertExactNames([...new Set(urls)].sort(), [...inventory.referenced].sort(), `${inventory.metadata} URLs`);

  const primary = scalarValue(content, "path");
  if (primary !== inventory.primary) {
    throw new Error(`${inventory.metadata} primary path ${primary} does not match ${inventory.primary}`);
  }

  for (const name of [...urls, primary]) {
    if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new Error(`${inventory.metadata} contains an unsafe asset reference: ${name}`);
    }
    if (!inventory.files.includes(name)) {
      throw new Error(`${inventory.metadata} references an asset outside its platform inventory: ${name}`);
    }
  }

  for (const entry of fileEntries) {
    if (!/^[A-Za-z0-9+/]{86}==$/u.test(entry.sha512)) {
      throw new Error(`${inventory.metadata} has an invalid SHA-512 digest for ${entry.url}`);
    }
    const artifact = await readFile(join(directory, entry.url));
    const actualDigest = createHash("sha512").update(artifact).digest("base64");
    if (entry.sha512 !== actualDigest) {
      throw new Error(`${inventory.metadata} SHA-512 digest does not match ${entry.url}`);
    }
    if (!Number.isSafeInteger(entry.size) || entry.size !== artifact.byteLength) {
      throw new Error(`${inventory.metadata} size does not match ${entry.url}`);
    }
  }

  const primaryEntry = fileEntries.find(({ url }) => url === primary);
  if (!primaryEntry || scalarValue(content, "sha512") !== primaryEntry.sha512) {
    throw new Error(`${inventory.metadata} primary SHA-512 digest does not match ${primary}`);
  }
  if (!/^releaseDate:\s*['"]?\d{4}-\d{2}-\d{2}T/mu.test(content)) {
    throw new Error(`${inventory.metadata} is missing a release date`);
  }
}

async function verifyChecksums(checksumsPath, expectedNames) {
  const content = await readFile(checksumsPath, "utf8");
  const lines = content.split(/\r?\n/u).filter(Boolean);
  const entries = new Map();

  for (const line of lines) {
    const match = /^([a-f0-9]{64}) [ *](.+)$/u.exec(line);
    if (!match || basename(match[2]) !== match[2]) {
      throw new Error(`Invalid SHA256SUMS entry: ${line}`);
    }
    if (entries.has(match[2])) {
      throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
    }
    entries.set(match[2], match[1]);
  }

  assertExactNames([...entries.keys()].sort(), [...expectedNames].sort(), "SHA256SUMS inventory");
  for (const [name, expectedDigest] of entries) {
    const actualDigest = createHash("sha256").update(await readFile(join(directory, name))).digest("hex");
    if (actualDigest !== expectedDigest) {
      throw new Error(`SHA256SUMS digest does not match ${name}`);
    }
  }
}

async function verifyPackagedUpdateConfiguration(configPath, expectedPublisherName) {
  const content = await readFile(configPath, "utf8");
  const expected = new Map([
    ["provider", "github"],
    ["owner", "sliverarmory"],
    ["repo", "sliver-gui"],
  ]);

  for (const [key, value] of expected) {
    const actual = scalarValue(content, key);
    if (actual !== value) {
      throw new Error(`Packaged app-update.yml ${key} ${actual} does not match ${value}`);
    }
  }

  const forbiddenKeys = [...content.matchAll(/^[ \t]*([A-Za-z][A-Za-z0-9_-]*):/gmu)]
    .map((match) => match[1])
    .filter((key) => /token|private|authorization|request-?headers?|password|secret/iu.test(key));
  if (forbiddenKeys.length > 0) {
    throw new Error(`Packaged app-update.yml contains private credential field(s): ${forbiddenKeys.join(", ")}`);
  }

  if (expectedPublisherName) {
    const publisherNames = rootScalarOrSequenceValues(content, "publisherName");
    assertExactNames(publisherNames, [expectedPublisherName], "Packaged app-update.yml publisherName");
  }
}

function metadataFileEntries(content, metadataName) {
  const lines = content.split(/\r?\n/u);
  const filesIndex = lines.findIndex((line) => line === "files:");
  if (filesIndex < 0) throw new Error(`${metadataName} is missing files`);
  const entries = [];
  let current;

  for (const line of lines.slice(filesIndex + 1)) {
    if (/^\S/u.test(line)) break;
    const urlMatch = /^\s+-\s+url:\s*(.+?)\s*$/u.exec(line);
    if (urlMatch) {
      if (current) entries.push(current);
      current = { url: unquote(urlMatch[1]), sha512: undefined, size: undefined };
      continue;
    }
    const propertyMatch = /^\s+(sha512|size):\s*(.+?)\s*$/u.exec(line);
    if (!current || !propertyMatch) continue;
    if (propertyMatch[1] === "sha512") current.sha512 = unquote(propertyMatch[2]);
    else current.size = Number(unquote(propertyMatch[2]));
  }
  if (current) entries.push(current);
  if (entries.length === 0 || entries.some(({ sha512, size }) => !sha512 || size === undefined)) {
    throw new Error(`${metadataName} is missing complete file metadata`);
  }
  return entries;
}

function rootScalarOrSequenceValues(content, key) {
  const lines = content.split(/\r?\n/u);
  const index = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (index < 0) throw new Error(`Packaged app-update.yml is missing ${key}`);
  const inline = lines[index].slice(lines[index].indexOf(":") + 1).trim();
  if (inline) return [unquote(inline)];
  const values = [];
  for (const line of lines.slice(index + 1)) {
    if (/^\S/u.test(line)) break;
    const match = /^\s+-\s+(.+?)\s*$/u.exec(line);
    if (match) values.push(unquote(match[1]));
  }
  return values;
}

function scalarValue(content, key) {
  const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, "mu").exec(content);
  if (!match) throw new Error(`Update metadata is missing ${key}`);
  return unquote(match[1]);
}

function unquote(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

function assertExactNames(actualNames, expectedNames, label) {
  if (actualNames.length === expectedNames.length && actualNames.every((name, index) => name === expectedNames[index])) {
    return;
  }
  const missing = expectedNames.filter((name) => !actualNames.includes(name));
  const unexpected = actualNames.filter((name) => !expectedNames.includes(name));
  throw new Error(
    `${label} mismatch` +
      (missing.length > 0 ? `\nMissing:\n${missing.join("\n")}` : "") +
      (unexpected.length > 0 ? `\nUnexpected:\n${unexpected.join("\n")}` : ""),
  );
}

function argumentValue(name) {
  const indexes = process.argv.flatMap((argument, index) => argument === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
