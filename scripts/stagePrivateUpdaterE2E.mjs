import { X509Certificate } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertPackagedGitHubUpdateConfiguration } from "./privateUpdaterE2EConfig.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const platform = requiredArgument("--platform");
const version = requiredArgument("--version");
const sourceDirectory = resolve(requiredArgument("--source"));
const destinationDirectory = resolve(requiredArgument("--destination"));
const certificate = argumentValue("--certificate");

const platformConfiguration = {
  macos: {
    installer: `sliver-gui-${version}-macos-universal.dmg`,
    appUpdate: join("mac-universal", "Sliver GUI.app", "Contents", "Resources", "app-update.yml"),
    certificateName: "signing-certificate.pem",
  },
  windows: {
    installer: `sliver-gui-${version}-windows-x64-setup.exe`,
    appUpdate: join("win-unpacked", "resources", "app-update.yml"),
    certificateName: "signing-certificate.cer",
  },
  linux: {
    installer: `sliver-gui-${version}-linux-x86_64.AppImage`,
    appUpdate: join("linux-unpacked", "resources", "app-update.yml"),
    certificateName: undefined,
  },
}[platform];

if (!platformConfiguration) throw new Error("--platform must be macos, windows, or linux");
if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/u.test(version)) {
  throw new Error(`--version must be an exact prerelease SemVer version: ${version}`);
}
if (platformConfiguration.certificateName && !certificate) {
  throw new Error(`--certificate is required for ${platform}`);
}
if (!platformConfiguration.certificateName && certificate) {
  throw new Error("--certificate is not supported for linux");
}

const installerPath = join(sourceDirectory, platformConfiguration.installer);
const appUpdatePath = join(sourceDirectory, platformConfiguration.appUpdate);
await requireNonemptyFile(installerPath, "base installer");
await requireNonemptyFile(appUpdatePath, "packaged app-update.yml");

const packagedUpdateConfiguration = await readFile(appUpdatePath, "utf8");
assertPackagedGitHubUpdateConfiguration(packagedUpdateConfiguration, { privateE2E: true });

let certificatePath;
if (platformConfiguration.certificateName && certificate) {
  certificatePath = resolve(certificate);
  await requireNonemptyFile(certificatePath, "public signing certificate");
  await requirePublicX509Certificate(certificatePath);
}

// No destination is created until every input has passed the credential and
// certificate boundaries. A rejected input therefore cannot be picked up by a
// later unconditional artifact-upload step.
const baseDirectory = join(destinationDirectory, "base");
const contextDirectory = join(destinationDirectory, "context");
await mkdir(baseDirectory, { recursive: true });
await mkdir(contextDirectory, { recursive: true });
await copyFile(installerPath, join(baseDirectory, platformConfiguration.installer));
await copyFile(appUpdatePath, join(contextDirectory, "app-update.yml"));
if (platformConfiguration.certificateName && certificatePath) {
  await copyFile(certificatePath, join(baseDirectory, platformConfiguration.certificateName));
}

await writeFile(
  join(contextDirectory, "build-context.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    platform,
    version,
    installer: basename(installerPath),
    commit: process.env.GITHUB_SHA ?? null,
  }, null, 2)}\n`,
  { encoding: "utf8", flag: "wx" },
);

console.log(`Staged ${platform} private updater E2E base installer and public context`);

async function requireNonemptyFile(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`${label} is missing or empty: ${path}`);
}

async function requirePublicX509Certificate(path) {
  const content = await readFile(path);
  const text = content.toString("utf8");
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|-----BEGIN (?:PKCS12|PFX)-----/iu.test(text)) {
    throw new Error("Refusing to stage private signing material as a public certificate");
  }

  try {
    const certificate = new X509Certificate(content);
    if (!text.includes("-----BEGIN CERTIFICATE-----") && certificate.raw.byteLength !== content.byteLength) {
      throw new Error("DER certificate contains trailing data");
    }
    if (text.includes("-----BEGIN CERTIFICATE-----")) {
      const remainder = text.replace(
        /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu,
        "",
      );
      if (remainder.trim() !== "") throw new Error("PEM certificate contains non-certificate data");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Refusing to stage a non-X.509 public certificate: ${detail}`);
  }
}

function requiredArgument(name) {
  const value = argumentValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function argumentValue(name) {
  const indexes = process.argv.flatMap((argument, index) => argument === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
