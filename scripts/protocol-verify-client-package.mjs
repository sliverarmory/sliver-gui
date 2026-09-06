import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenancePath = join(repositoryRoot, "protocol/sliver-script-provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const rootManifest = await readJSON(join(repositoryRoot, "package.json"));
const rootLock = await readJSON(join(repositoryRoot, "package-lock.json"));

assertExactKeys(provenance, ["schemaVersion", "package", "installedPackage", "protocol"], "Client provenance");
assert(provenance.schemaVersion === 3, "Unsupported sliver-script provenance schema");
assertExactKeys(
  provenance.package,
  ["name", "version", "dependencySpec", "tarball", "integrity", "shasum", "source"],
  "Client provenance package",
);
assertExactKeys(provenance.package.source, ["repository", "tag", "commit"], "Client provenance source");
assertExactKeys(provenance.installedPackage, ["root", "tree", "files"], "Installed client provenance");
assertExactKeys(provenance.installedPackage.tree, ["files", "sha256"], "Installed client tree");
assertExactKeys(
  provenance.protocol,
  ["baseline", "integrationLock", "protobufLock"],
  "Client protocol provenance",
);
assert(provenance.package.name === "sliver-script", "Unexpected client package name");
assert(provenance.installedPackage.root === "node_modules/sliver-script", "Unexpected installed client root");
assert(provenance.protocol.baseline === "protocol/sliver-baseline.json", "Unexpected Sliver baseline path");
assert(provenance.protocol.integrationLock === "integration.lock.json", "Unexpected client integration lock path");
assert(provenance.protocol.protobufLock === "protobuf.lock.json", "Unexpected client protobuf lock path");

const baseline = await readJSON(join(repositoryRoot, provenance.protocol.baseline));
assertExactKeys(
  baseline,
  ["schemaVersion", "repository", "commit", "tree", "commandSources", "toolchain"],
  "Sliver baseline",
);
assert(baseline.schemaVersion === 2, "Unsupported Sliver baseline schema");
assertGitObject(baseline.commit, "Sliver baseline commit");
assertGitObject(baseline.tree, "Sliver baseline tree");
assertExactKeys(baseline.toolchain, ["go"], "Sliver baseline toolchain");
assertNonEmptyString(baseline.toolchain.go, "Sliver baseline Go version");

const packageMetadata = provenance.package;
const installedMetadata = provenance.installedPackage;
const packageRoot = resolve(repositoryRoot, installedMetadata.root);
const expectedPackageRoot = join(repositoryRoot, "node_modules", packageMetadata.name);
assert(packageRoot === expectedPackageRoot, `Unexpected installed package root: ${packageRoot}`);

const packageRootStat = await lstat(packageRoot).catch(() => undefined);
assert(packageRootStat, `Missing installed ${packageMetadata.name} package; run npm ci`);
assert(!packageRootStat.isSymbolicLink(), `${installedMetadata.root} must be an installed registry package, not a link`);
assert(packageRootStat.isDirectory(), `${installedMetadata.root} is not a package directory`);

assert(packageMetadata.dependencySpec === packageMetadata.version, "Client dependency is not exact");
assertNonEmptyString(packageMetadata.integrity, "Client registry integrity");
assert(packageMetadata.source.tag === `v${packageMetadata.version}`, "Client source tag does not match package version");
assertGitObject(packageMetadata.source.commit, "Client source commit");
assertSha1(packageMetadata.shasum, "Client registry shasum");

const expectedTarball =
  `https://registry.npmjs.org/${packageMetadata.name}/-/${packageMetadata.name}-${packageMetadata.version}.tgz`;
assert(packageMetadata.tarball === expectedTarball, "Client registry tarball URL drifted");

assert(
  rootManifest.dependencies?.[packageMetadata.name] === packageMetadata.dependencySpec,
  "Root production client dependency spec drifted",
);
assert(
  rootManifest.devDependencies?.[packageMetadata.name] === undefined,
  "Client package must not be a development dependency",
);

assert(rootLock.lockfileVersion === 3, `Unsupported root package-lock version: ${rootLock.lockfileVersion}`);
assert(
  rootLock.packages?.[""]?.dependencies?.[packageMetadata.name] === packageMetadata.dependencySpec,
  "Root package-lock production client spec drifted",
);
assert(
  rootLock.packages?.[""]?.devDependencies?.[packageMetadata.name] === undefined,
  "Root package-lock lists the client as a development dependency",
);

const registryEntry = rootLock.packages?.[`node_modules/${packageMetadata.name}`];
assert(registryEntry?.version === packageMetadata.version, "Locked client package version drifted");
assert(registryEntry?.resolved === packageMetadata.tarball, "Locked client registry tarball drifted");
assert(registryEntry?.integrity === packageMetadata.integrity, "Locked client registry integrity drifted");
assert(registryEntry?.link !== true, "Locked client package unexpectedly resolves through a link");

const expectedFileLocks = ["integration.lock.json", "package.json", "protobuf.lock.json"];
assert(Array.isArray(installedMetadata.files), "Installed client file locks must be an array");
for (const file of installedMetadata.files) {
  assertExactKeys(file, ["path", "sha256"], `Installed client file lock ${file.path ?? "<unknown>"}`);
  assertSha256(file.sha256, `Installed client file lock ${file.path}`);
}
const actualFileLocks = installedMetadata.files.map((entry) => entry.path).sort();
assert(stable(actualFileLocks) === stable(expectedFileLocks), "Installed client package file-lock set drifted");
assert(Number.isSafeInteger(installedMetadata.tree.files) && installedMetadata.tree.files > 0, "Invalid client tree file count");
assertSha256(installedMetadata.tree.sha256, "Installed client tree hash");

const installedTree = await packageTree(packageRoot);
assert(
  stable(installedMetadata.tree) === stable(installedTree),
  "Installed client package tree drifted",
);
const lockedBytes = new Map();
for (const file of installedMetadata.files) {
  const data = await readFile(join(packageRoot, file.path));
  const digest = sha256(data);
  assert(digest === file.sha256, `Installed client package hash drifted: ${file.path}`);
  lockedBytes.set(file.path, data);
}

const packageManifest = JSON.parse(lockedBytes.get("package.json").toString("utf8"));
assert(packageManifest.name === packageMetadata.name, "Installed client manifest name drifted");
assert(packageManifest.version === packageMetadata.version, "Installed client manifest version drifted");
assert(packageManifest.main === "lib/index.js", "Installed client CommonJS entry point drifted");
assert(packageManifest.types === "lib/index.d.ts", "Installed client type entry point drifted");
assert(packageManifest.engines?.node === ">=24", "Installed client Node engine drifted");
assert(
  normalizeRepository(packageManifest.repository?.url) === normalizeRepository(packageMetadata.source.repository),
  "Installed client repository metadata drifted",
);
assert(existsSync(join(packageRoot, packageManifest.main)), "Installed client runtime entry point is missing");
assert(existsSync(join(packageRoot, packageManifest.types)), "Installed client type entry point is missing");

const integrationLock = JSON.parse(lockedBytes.get(provenance.protocol.integrationLock).toString("utf8"));
const protobufLock = JSON.parse(lockedBytes.get(provenance.protocol.protobufLock).toString("utf8"));
assertExactKeys(
  integrationLock,
  ["schemaVersion", "wrapper", "sliver", "importedPaths", "standaloneAdaptations", "standaloneOmissions"],
  "Client integration lock",
);
assert(integrationLock.schemaVersion === 2, "Unsupported client integration lock schema");
assertExactKeys(
  integrationLock.wrapper,
  ["repository", "publishedBase", "integrationBase"],
  "Client integration wrapper lock",
);
assertGitObject(integrationLock.wrapper.publishedBase, "Client published base");
assertGitObject(integrationLock.wrapper.integrationBase, "Client integration base");
assertExactKeys(
  integrationLock.sliver,
  ["repository", "sourceCommit", "protobufLock"],
  "Client integration Sliver lock",
);
assertGitObject(integrationLock.sliver.sourceCommit, "Client integration Sliver commit");
const serializedIntegrationLock = JSON.stringify([integrationLock, protobufLock]).toLowerCase();
for (const marker of [
  "sliver-gui",
  "authoritativegui",
  "vendoredroot",
  "guionlyomissions",
  "provenancemanifest",
  "handwrittenoverlay",
  "vendor/sliver-script",
  "protocol/sliver-script-provenance",
  "protocol/sliver-script-handwritten-overlay",
]) {
  assert(
    !serializedIntegrationLock.includes(marker),
    `Client integration lock contains consumer-specific marker: ${marker}`,
  );
}
assert(
  normalizeRepository(integrationLock.wrapper?.repository) === normalizeRepository(packageMetadata.source.repository),
  "Client integration repository drifted",
);
assert(integrationLock.sliver?.repository === baseline.repository, "Client integration Sliver repository drifted");
assert(integrationLock.sliver?.sourceCommit === baseline.commit, "Client integration Sliver commit drifted");
assert(integrationLock.sliver?.protobufLock === provenance.protocol.protobufLock, "Client integration lock link drifted");

assertExactKeys(protobufLock, ["schemaVersion", "source", "toolchain", "protobuf"], "Client protobuf lock");
assert(protobufLock.schemaVersion === 1, "Unsupported client protobuf lock schema");
assertExactKeys(protobufLock.source, ["repository", "commit", "tree"], "Client protobuf source lock");
assertGitObject(protobufLock.source.commit, "Client protobuf source commit");
assertGitObject(protobufLock.source.tree, "Client protobuf source tree");
assert(protobufLock.source?.repository === baseline.repository, "Client protobuf Sliver repository drifted");
assert(protobufLock.source?.commit === baseline.commit, "Client protobuf Sliver commit drifted");
assert(protobufLock.source?.tree === baseline.tree, "Client protobuf Sliver tree drifted");

console.log(
  `Installed ${packageMetadata.name}@${packageMetadata.version} provenance passed: `
    + `${installedTree.files} package files and ${installedMetadata.files.length} locked metadata files; `
    + packageMetadata.integrity,
);

async function listFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`Unexpected non-file package entry: ${relative(root, path)}`);
  }
  return result;
}

async function packageTree(root) {
  const paths = (await listFiles(root)).sort();
  const entries = [];
  for (const path of paths) {
    entries.push([path, sha256(await readFile(join(root, path)))]);
  }
  return {
    files: entries.length,
    sha256: sha256(Buffer.from(stable(entries), "utf8")),
  };
}

function normalizeRepository(value) {
  return String(value ?? "").replace(/^git\+/u, "").replace(/\.git$/u, "");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function stable(value) {
  return JSON.stringify(value);
}

function assertExactKeys(value, expected, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert(
    stable(Object.keys(value).sort()) === stable([...expected].sort()),
    `${label} field set drifted`,
  );
}

function assertNonEmptyString(value, label) {
  assert(typeof value === "string" && value.trim() !== "", `${label} must be a non-empty string`);
}

function assertGitObject(value, label) {
  assert(/^[0-9a-f]{40}$/u.test(value), `${label} must be a full lowercase Git object id`);
}

function assertSha1(value, label) {
  assert(/^[0-9a-f]{40}$/u.test(value), `${label} must be a lowercase SHA-1 digest`);
}

function assertSha256(value, label) {
  assert(/^[0-9a-f]{64}$/u.test(value), `${label} must be a lowercase SHA-256 digest`);
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
