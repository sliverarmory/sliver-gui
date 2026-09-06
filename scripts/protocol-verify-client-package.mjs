import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenancePath = join(repositoryRoot, "protocol/sliver-script-provenance.json");
const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const baseline = await readJSON(join(repositoryRoot, provenance.protocol.baseline));
const rootManifest = await readJSON(join(repositoryRoot, "package.json"));
const rootLock = await readJSON(join(repositoryRoot, "package-lock.json"));

assert(provenance.schemaVersion === 2, "Unsupported sliver-script provenance schema");

const packageMetadata = provenance.package;
const installedMetadata = provenance.installedPackage;
const packageRoot = resolve(repositoryRoot, installedMetadata.root);
const expectedPackageRoot = join(repositoryRoot, "node_modules", packageMetadata.name);
assert(packageRoot === expectedPackageRoot, `Unexpected installed package root: ${packageRoot}`);

const packageRootStat = await lstat(packageRoot).catch(() => undefined);
assert(packageRootStat, `Missing installed ${packageMetadata.name} package; run npm ci`);
assert(!packageRootStat.isSymbolicLink(), `${installedMetadata.root} must be an installed registry package, not a link`);
assert(packageRootStat.isDirectory(), `${installedMetadata.root} is not a package directory`);

assert(baseline.clientPackage.name === packageMetadata.name, "Client package names disagree");
assert(baseline.clientPackage.version === packageMetadata.version, "Client package versions disagree");
assert(baseline.clientPackage.integrity === packageMetadata.integrity, "Client package integrity locks disagree");
assert(stable(baseline.clientPackage.source) === stable(packageMetadata.source), "Client package source locks disagree");
assert(
  baseline.clientPackage.protobufLockSha256 === fileLock("protobuf.lock.json").sha256,
  "Client protobuf lock hashes disagree",
);
assert(
  baseline.clientPackage.provenance === relative(repositoryRoot, provenancePath).split(sep).join("/"),
  "Client package provenance path drifted",
);

assert(packageMetadata.dependencySpec === packageMetadata.version, "Client dependency is not exact");
assert(packageMetadata.source.tag === `v${packageMetadata.version}`, "Client source tag does not match package version");
assert(/^[0-9a-f]{40}$/u.test(packageMetadata.source.commit), "Client source commit is not a full Git object id");
assert(/^[0-9a-f]{40}$/u.test(packageMetadata.shasum), "Client registry shasum is malformed");

const expectedTarball =
  `https://registry.npmjs.org/${packageMetadata.name}/-/${packageMetadata.name}-${packageMetadata.version}.tgz`;
assert(packageMetadata.tarball === expectedTarball, "Client registry tarball URL drifted");

const rootDependencySpecs = [
  rootManifest.dependencies?.[packageMetadata.name],
  rootManifest.devDependencies?.[packageMetadata.name],
].filter((value) => value !== undefined);
assert(rootDependencySpecs.length === 1, `Expected one root dependency entry for ${packageMetadata.name}`);
assert(rootDependencySpecs[0] === packageMetadata.dependencySpec, "Root client dependency spec drifted");

assert(rootLock.lockfileVersion === 3, `Unsupported root package-lock version: ${rootLock.lockfileVersion}`);
const rootLockedSpec =
  rootLock.packages?.[""]?.dependencies?.[packageMetadata.name]
  ?? rootLock.packages?.[""]?.devDependencies?.[packageMetadata.name];
assert(rootLockedSpec === packageMetadata.dependencySpec, "Root package-lock client spec drifted");

const registryEntry = rootLock.packages?.[`node_modules/${packageMetadata.name}`];
assert(registryEntry?.version === packageMetadata.version, "Locked client package version drifted");
assert(registryEntry?.resolved === packageMetadata.tarball, "Locked client registry tarball drifted");
assert(registryEntry?.integrity === packageMetadata.integrity, "Locked client registry integrity drifted");
assert(registryEntry?.link !== true, "Locked client package unexpectedly resolves through a link");

const expectedFileLocks = ["integration.lock.json", "package.json", "protobuf.lock.json"];
const actualFileLocks = installedMetadata.files.map((entry) => entry.path).sort();
assert(stable(actualFileLocks) === stable(expectedFileLocks), "Installed client package file-lock set drifted");

const installedTree = await packageTree(packageRoot);
assert(
  stable(installedMetadata.tree) === stable(installedTree),
  "Installed client package tree drifted",
);
assert(
  stable(baseline.clientPackage.packageTree) === stable(installedTree),
  "Baseline and installed client package tree locks disagree",
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
assertExactKeys(
  integrationLock.sliver,
  ["repository", "sourceCommit", "protobufLock"],
  "Client integration Sliver lock",
);
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

assert(protobufLock.schemaVersion === 1, "Unsupported client protobuf lock schema");
assert(protobufLock.source?.repository === baseline.repository, "Client protobuf Sliver repository drifted");
assert(protobufLock.source?.commit === baseline.commit, "Client protobuf Sliver commit drifted");
assert(protobufLock.source?.tree === baseline.tree, "Client protobuf Sliver tree drifted");
assert(protobufLock.toolchain?.protoc === baseline.toolchain.protoc, "Client protobuf protoc lock drifted");
assert(protobufLock.toolchain?.tsProto === baseline.toolchain.tsProto, "Client protobuf ts-proto lock drifted");
assert(
  protobufLock.protobuf?.descriptorSetSha256 === baseline.protobuf.descriptorSetSha256,
  "Client protobuf descriptor lock drifted",
);
assert(stable(protobufLock.protobuf?.files) === stable(baseline.protobuf.files), "Client protobuf input locks drifted");
assert(stable(protobufLock.protobuf?.outputs) === stable(baseline.protobuf.outputs), "Client protobuf output locks drifted");
assert(
  stable(protobufLock.protobuf?.pluginOptions) === stable(baseline.protobuf.pluginOptions),
  "Client protobuf plugin options drifted",
);

const expectedImportedProtobuf = baseline.protobuf.outputs.map((entry) => `src/pb/${entry.path}`).sort();
const actualImportedPaths = new Set(integrationLock.importedPaths ?? []);
const missingImportedProtobuf = expectedImportedProtobuf.filter((path) => !actualImportedPaths.has(path));
assert(
  missingImportedProtobuf.length === 0,
  `Client integration lock omits protobuf outputs: ${missingImportedProtobuf.join(", ")}`,
);

const generatedSourceRoot = join(packageRoot, provenance.protocol.generatedSourceRoot);
const expectedGeneratedPaths = baseline.protobuf.outputs.map((entry) => entry.path).sort();
const actualGeneratedPaths = (await listFiles(generatedSourceRoot)).sort();
assert(
  stable(actualGeneratedPaths) === stable(expectedGeneratedPaths),
  describePaths("Installed client protobuf source set drifted", actualGeneratedPaths, expectedGeneratedPaths),
);
for (const expected of baseline.protobuf.outputs) {
  const digest = sha256(await readFile(join(generatedSourceRoot, expected.path)));
  assert(digest === expected.sha256, `Installed client protobuf output drifted: ${expected.path}`);
}

console.log(
  `Installed ${packageMetadata.name}@${packageMetadata.version} provenance passed: `
    + `${installedTree.files} package files, ${installedMetadata.files.length} locked metadata files, `
    + `and ${expectedGeneratedPaths.length} protobuf outputs; `
    + packageMetadata.integrity,
);

function fileLock(path) {
  const match = installedMetadata.files.find((entry) => entry.path === path);
  assert(match, `Missing installed package file lock: ${path}`);
  return match;
}

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

function describePaths(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));
  return `${label}; unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`;
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

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
