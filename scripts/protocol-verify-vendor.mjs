import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = await readJSON("protocol/sliver-baseline.json");
const provenance = await readJSON("protocol/sliver-script-provenance.json");
const arguments_ = parseArguments(process.argv.slice(2));
if (!arguments_.wrapperSource) {
  throw new Error("Pass --wrapper-source with the checkout created by protocol-fetch-wrapper-base.mjs");
}

assert(provenance.schemaVersion === 1, "Unsupported sliver-script provenance schema");
assert(provenance.wrapper.repository === baseline.vendoredWrapper.repository, "Wrapper repository locks disagree");
assert(provenance.wrapper.publishedBase === baseline.vendoredWrapper.publishedBase, "Wrapper base locks disagree");
assert(provenance.wrapper.snapshot === baseline.vendoredWrapper.snapshot, "Wrapper snapshot locks disagree");
assert(provenance.archivalEvidence.bundle.sha256 === baseline.vendoredWrapper.bundleSha256, "Bundle locks disagree");
assert(provenance.generatedProtobuf.sourceCommit === baseline.protobuf.sourceCommit, "Protobuf source locks disagree");

for (const evidence of [provenance.archivalEvidence.bundle, ...provenance.archivalEvidence.commitPatches]) {
  await verifyHash(evidence.path, evidence.sha256, "archival evidence");
}
await verifyHash(
  provenance.handwrittenOverlay.patch.path,
  provenance.handwrittenOverlay.patch.sha256,
  "handwritten overlay patch",
);

const wrapperSource = resolve(arguments_.wrapperSource);
assert(existsSync(join(wrapperSource, ".git")), `Not a Git checkout: ${wrapperSource}`);
assert(
  git(wrapperSource, ["rev-parse", "HEAD"]) === provenance.wrapper.publishedBase,
  "Wrapper source is not the exact published base",
);
assert(
  git(wrapperSource, ["status", "--porcelain=v1", "--untracked-files=no"]) === "",
  "Wrapper base has tracked changes",
);

const reconstruction = await mkdtemp(join(tmpdir(), "sliver-script-provenance-"));
execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", wrapperSource, reconstruction], { stdio: "inherit" });
const bundle = join(repositoryRoot, provenance.archivalEvidence.bundle.path);
execFileSync("git", ["bundle", "verify", bundle], { cwd: reconstruction, stdio: "inherit" });
execFileSync("git", ["fetch", "--quiet", bundle, `HEAD:refs/sliver-gui/${provenance.wrapper.snapshot}`], {
  cwd: reconstruction,
  stdio: "inherit",
});
execFileSync("git", ["checkout", "--quiet", "--detach", provenance.wrapper.snapshot], {
  cwd: reconstruction,
  stdio: "inherit",
});
assert(git(reconstruction, ["rev-parse", "HEAD"]) === provenance.wrapper.snapshot, "Bundle reconstructed the wrong snapshot");

for (const file of provenance.retainedSnapshotFiles) {
  await verifyReconstructedAndVendoredFile(reconstruction, file);
}
for (const file of provenance.handwrittenOverlay.files) {
  const reconstructedPath = join(reconstruction, file.path);
  if (file.baseSha256 === null) {
    assert(!existsSync(reconstructedPath), `${file.path}: overlay claims a new file but the snapshot already contains it`);
  } else {
    const baseDigest = sha256(await readFile(reconstructedPath));
    assert(baseDigest === file.baseSha256, `${file.path}: overlay base hash drifted`);
  }
}

const patch = join(repositoryRoot, provenance.handwrittenOverlay.patch.path);
execFileSync("git", ["apply", "--check", patch], { cwd: reconstruction, stdio: "inherit" });
execFileSync("git", ["apply", patch], { cwd: reconstruction, stdio: "inherit" });
for (const file of provenance.handwrittenOverlay.files) {
  await verifyReconstructedAndVendoredFile(reconstruction, file);
}

const generatedByVendorPath = new Map(
  baseline.protobuf.outputs.map((file) => [`src/pb/${file.path}`, file.sha256]),
);
assert(
  stable([...generatedByVendorPath.keys()].sort()) === stable([...provenance.generatedProtobuf.paths].sort()),
  "Generated protobuf path list drifted from the baseline",
);
for (const [path, digest] of generatedByVendorPath) {
  await verifyHash(join("vendor/sliver-script", path), digest, "generated protobuf output");
}

const expectedSources = new Set([
  ...provenance.retainedSnapshotFiles.map((file) => file.path).filter((path) => path.startsWith("src/")),
  ...provenance.handwrittenOverlay.files.map((file) => file.path),
  ...provenance.generatedProtobuf.paths,
]);
const actualSources = (await recursiveFiles(join(repositoryRoot, "vendor/sliver-script/src")))
  .map((path) => `src/${relative(join(repositoryRoot, "vendor/sliver-script/src"), path)}`)
  .sort();
assert(
  stable(actualSources) === stable([...expectedSources].sort()),
  describeDifference(actualSources, [...expectedSources].sort()),
);

console.log(
  `Vendored sliver-script provenance passed: ${provenance.retainedSnapshotFiles.length} snapshot files, ` +
  `${provenance.handwrittenOverlay.files.length} handwritten overlay files, ${generatedByVendorPath.size} generated files`,
);

async function verifyReconstructedAndVendoredFile(reconstructedRoot, file) {
  const reconstructed = await readFile(join(reconstructedRoot, file.path));
  const vendored = await readFile(join(repositoryRoot, "vendor/sliver-script", file.path));
  assert(sha256(reconstructed) === file.sha256, `${file.path}: reconstructed hash drifted`);
  assert(sha256(vendored) === file.sha256, `${file.path}: vendored hash drifted`);
  assert(reconstructed.equals(vendored), `${file.path}: reconstructed and vendored bytes differ`);
}

async function verifyHash(path, expected, label) {
  const digest = sha256(await readFile(join(repositoryRoot, path)));
  assert(digest === expected, `${label} hash drifted: ${path}`);
}

async function recursiveFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await recursiveFiles(entryPath));
    else if (entry.isFile()) result.push(entryPath);
  }
  return result;
}

function describeDifference(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));
  return `Vendored source set drifted; unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`;
}

function parseArguments(values) {
  const result = { wrapperSource: undefined };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--wrapper-source") result.wrapperSource = requireValue(values[++index], "--wrapper-source");
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function stable(value) {
  return JSON.stringify(value);
}

async function readJSON(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
