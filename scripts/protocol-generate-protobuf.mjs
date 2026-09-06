import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = await readJSON(join(repositoryRoot, "protocol/sliver-baseline.json"));
const provenance = await readJSON(join(repositoryRoot, baseline.clientPackage.provenance));
const arguments_ = parseArguments(process.argv.slice(2));

const source = resolve(arguments_.source);
const protobufRoot = join(source, "protobuf");
const packageRoot = join(repositoryRoot, provenance.installedPackage.root);
const packageProtobufLockPath = join(packageRoot, provenance.protocol.protobufLock);
const packageProtobufLock = await readJSON(packageProtobufLockPath);
const checkedOutput = join(packageRoot, provenance.protocol.generatedSourceRoot);
const toolRoot = join(repositoryRoot, "protocol/protobuf-toolchain");
const protocCommand = process.env.SLIVER_PROTOC_BINARY || "protoc";
const plugin = process.platform === "win32"
  ? join(toolRoot, "node_modules/.bin/protoc-gen-ts_proto.cmd")
  : join(toolRoot, "node_modules/ts-proto/protoc-gen-ts_proto");

await verifyPackageLock();
verifyGitSource(source);
await verifyInputs(protobufRoot);
await verifyToolchain(toolRoot, arguments_.allowNodeDrift);
if (!existsSync(plugin)) {
  throw new Error("Install the locked generator with: npm ci --ignore-scripts --prefix protocol/protobuf-toolchain");
}

const temporary = await mkdtemp(join(tmpdir(), "sliver-protobuf-check-"));
try {
  const generatedOutput = join(temporary, "pb");
  const descriptorPath = join(temporary, "sliver.pb");
  await mkdir(generatedOutput, { recursive: true });

  const protoFiles = baseline.protobuf.files.map((entry) => entry.path);
  execFileSync(protocCommand, [
    "-I", protobufRoot,
    `--plugin=protoc-gen-ts_proto=${plugin}`,
    `--ts_proto_out=${generatedOutput}`,
    `--ts_proto_opt=${baseline.protobuf.pluginOptions.join(",")}`,
    ...protoFiles,
  ], { cwd: protobufRoot, stdio: "inherit" });

  execFileSync(protocCommand, [
    "-I", protobufRoot,
    "--include_imports",
    `--descriptor_set_out=${descriptorPath}`,
    ...protoFiles,
  ], { cwd: protobufRoot, stdio: "inherit" });

  const descriptorDigest = sha256(await readFile(descriptorPath));
  if (descriptorDigest !== baseline.protobuf.descriptorSetSha256) {
    throw new Error(
      `Semantic descriptor drift: expected ${baseline.protobuf.descriptorSetSha256}, received ${descriptorDigest}`,
    );
  }

  const expectedPaths = baseline.protobuf.outputs.map((entry) => entry.path).sort();
  const generatedPaths = (await listFiles(generatedOutput)).sort();
  const installedPaths = (await listFiles(checkedOutput)).sort();
  if (stable(generatedPaths) !== stable(expectedPaths)) {
    throw new Error(describePaths("Generated protobuf source set drifted", generatedPaths, expectedPaths));
  }
  if (stable(installedPaths) !== stable(expectedPaths)) {
    throw new Error(describePaths("Installed client protobuf source set drifted", installedPaths, expectedPaths));
  }

  const drift = [];
  for (const expected of baseline.protobuf.outputs) {
    const generatedData = await readFile(join(generatedOutput, expected.path));
    const installedData = await readFile(join(checkedOutput, expected.path));
    const generatedDigest = sha256(generatedData);
    const installedDigest = sha256(installedData);
    if (
      generatedDigest !== expected.sha256
      || installedDigest !== expected.sha256
      || !generatedData.equals(installedData)
    ) {
      drift.push({
        path: expected.path,
        expected: expected.sha256,
        generated: generatedDigest,
        installed: installedDigest,
      });
    }
  }

  if (drift.length !== 0) {
    console.error(JSON.stringify({ generatedApiDrift: drift }, null, 2));
    throw new Error("Generated TypeScript protobuf API drifted from the exact installed client package");
  }

  console.log(
    `Protobuf byte and semantic verification passed for ${baseline.protobuf.outputs.length} installed client files`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function verifyPackageLock() {
  const packageLockMetadata = provenance.installedPackage.files.find(
    (entry) => entry.path === provenance.protocol.protobufLock,
  );
  if (!packageLockMetadata) throw new Error("Client package protobuf lock is absent from provenance");

  const packageLockDigest = sha256(await readFile(packageProtobufLockPath));
  if (packageLockDigest !== packageLockMetadata.sha256) {
    throw new Error(
      `Installed client protobuf lock drift: expected ${packageLockMetadata.sha256}, received ${packageLockDigest}`,
    );
  }
  if (packageLockDigest !== baseline.clientPackage.protobufLockSha256) {
    throw new Error("Baseline and installed client protobuf lock hashes disagree");
  }
  if (
    packageProtobufLock.source?.repository !== baseline.repository
    || packageProtobufLock.source?.commit !== baseline.commit
    || packageProtobufLock.source?.tree !== baseline.tree
  ) {
    throw new Error("Installed client package targets a different Sliver source");
  }
  if (
    packageProtobufLock.toolchain?.protoc !== baseline.toolchain.protoc
    || packageProtobufLock.toolchain?.tsProto !== baseline.toolchain.tsProto
  ) {
    throw new Error("Installed client protobuf toolchain lock drifted from the baseline");
  }
  if (packageProtobufLock.protobuf?.descriptorSetSha256 !== baseline.protobuf.descriptorSetSha256) {
    throw new Error("Installed client descriptor lock drifted from the baseline");
  }
  if (stable(packageProtobufLock.protobuf?.files) !== stable(baseline.protobuf.files)) {
    throw new Error("Installed client protobuf input locks drifted from the baseline");
  }
  if (stable(packageProtobufLock.protobuf?.outputs) !== stable(baseline.protobuf.outputs)) {
    throw new Error("Installed client protobuf output locks drifted from the baseline");
  }
  if (stable(packageProtobufLock.protobuf?.pluginOptions) !== stable(baseline.protobuf.pluginOptions)) {
    throw new Error("Installed client protobuf plugin options drifted from the baseline");
  }
}

function verifyGitSource(checkout) {
  const commit = git(checkout, ["rev-parse", "HEAD"]);
  const tree = git(checkout, ["rev-parse", "HEAD^{tree}"]);
  if (commit !== baseline.commit || tree !== baseline.tree) {
    throw new Error(`Source is not the locked Sliver baseline: ${commit} ${tree}`);
  }
}

async function verifyInputs(root) {
  for (const input of baseline.protobuf.files) {
    const digest = sha256(await readFile(join(root, input.path)));
    if (digest !== input.sha256) throw new Error(`Protobuf input drift: ${input.path}`);
  }
}

async function verifyToolchain(root, allowNodeDrift) {
  const versions = {
    node: process.versions.node,
    npm: output("npm", ["--version"]),
    protoc: output(protocCommand, ["--version"]).replace(/^libprotoc\s+/u, ""),
    tsProto: await packageVersion(root, "ts-proto"),
    typescript: await packageVersion(root, "typescript"),
    tsPoet: await packageVersion(root, "ts-poet"),
    dprintNode: await packageVersion(root, "dprint-node"),
  };
  for (const [name, expected] of Object.entries(baseline.toolchain)) {
    if (!(name in versions) || name === "formatting" || name === "go") continue;
    if (name === "node" && allowNodeDrift) continue;
    if (versions[name] !== expected) {
      throw new Error(`${name} toolchain drift: expected ${expected}, received ${versions[name]}`);
    }
  }
}

async function packageVersion(root, name) {
  const manifest = await readJSON(join(root, "node_modules", name, "package.json"));
  return manifest.version;
}

async function listFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(root, path));
    else if (entry.isFile()) result.push(relative(root, path).split(sep).join("/"));
    else throw new Error(`Unexpected non-file protobuf entry: ${relative(root, path)}`);
  }
  return result;
}

function describePaths(label, actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const unexpected = actual.filter((path) => !expectedSet.has(path));
  const missing = expected.filter((path) => !actualSet.has(path));
  return `${label}; unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}`;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function output(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function stable(value) {
  return JSON.stringify(value);
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseArguments(values) {
  const result = { source: undefined, check: false, allowNodeDrift: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--source") result.source = requireValue(values[++index], "--source");
    else if (values[index] === "--check") result.check = true;
    else if (values[index] === "--allow-node-drift") result.allowNodeDrift = true;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (!result.source || !result.check) {
    throw new Error("Usage: node scripts/protocol-generate-protobuf.mjs --source CHECKOUT --check [--allow-node-drift]");
  }
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
