import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await readFile(join(repositoryRoot, "protocol/sliver-baseline.json"), "utf8"));
const arguments_ = parseArguments(process.argv.slice(2));
if (!arguments_.source) throw new Error("Pass --source with a checkout created by protocol-fetch-baseline.mjs");

const source = resolve(arguments_.source);
const protobufRoot = join(source, "protobuf");
const vendoredOutput = join(repositoryRoot, "vendor/sliver-script/src/pb");
const toolRoot = join(repositoryRoot, "protocol/protobuf-toolchain");
const plugin = join(toolRoot, "node_modules/ts-proto/protoc-gen-ts_proto");

verifyGitSource(source);
await verifyInputs(protobufRoot);
await verifyToolchain(toolRoot, arguments_.allowNodeDrift);
if (!existsSync(plugin)) throw new Error("Install the locked generator with: npm ci --ignore-scripts --prefix protocol/protobuf-toolchain");

const temporary = await mkdtemp(join(tmpdir(), "sliver-protobuf-generate-"));
const generatedOutput = join(temporary, "pb");
const descriptorPath = join(temporary, "sliver.pb");
await mkdir(generatedOutput, { recursive: true });

const protoFiles = baseline.protobuf.files.map((entry) => entry.path);
execFileSync("protoc", [
  "-I", protobufRoot,
  `--plugin=protoc-gen-ts_proto=${plugin}`,
  `--ts_proto_out=${generatedOutput}`,
  `--ts_proto_opt=${baseline.protobuf.pluginOptions.join(",")}`,
  ...protoFiles,
], { cwd: protobufRoot, stdio: "inherit" });

execFileSync("protoc", [
  "-I", protobufRoot,
  "--include_imports",
  `--descriptor_set_out=${descriptorPath}`,
  ...protoFiles,
], { cwd: protobufRoot, stdio: "inherit" });

const descriptorDigest = sha256(await readFile(descriptorPath));
if (descriptorDigest !== baseline.protobuf.descriptorSetSha256) {
  throw new Error(`Semantic descriptor drift: expected ${baseline.protobuf.descriptorSetSha256}, received ${descriptorDigest}`);
}

const drift = [];
for (const expected of baseline.protobuf.outputs) {
  const generatedPath = join(generatedOutput, expected.path);
  const generatedData = await readFile(generatedPath);
  const generatedDigest = sha256(generatedData);
  const checkedData = await readFile(join(vendoredOutput, expected.path));
  const checkedDigest = sha256(checkedData);
  if (generatedDigest !== expected.sha256 || checkedDigest !== expected.sha256 || !generatedData.equals(checkedData)) {
    drift.push({ path: expected.path, expected: expected.sha256, generated: generatedDigest, checkedIn: checkedDigest });
  }
  if (arguments_.write) {
    await mkdir(dirname(join(vendoredOutput, expected.path)), { recursive: true });
    await copyFile(generatedPath, join(vendoredOutput, expected.path));
  }
}

if (drift.length !== 0) {
  console.error(JSON.stringify({ generatedApiDrift: drift }, null, 2));
  throw new Error("Generated TypeScript protobuf API drifted from the locked byte baseline");
}

console.log(`Protobuf byte and semantic verification passed for ${baseline.protobuf.outputs.length} generated files`);

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
    protoc: output("protoc", ["--version"]).replace(/^libprotoc\s+/u, ""),
    tsProto: (await packageVersion(root, "ts-proto")),
    typescript: (await packageVersion(root, "typescript")),
    tsPoet: (await packageVersion(root, "ts-poet")),
    dprintNode: (await packageVersion(root, "dprint-node")),
  };
  for (const [name, expected] of Object.entries(baseline.toolchain)) {
    if (!(name in versions) || name === "formatting" || name === "go") continue;
    if (name === "node" && allowNodeDrift) continue;
    if (versions[name] !== expected) throw new Error(`${name} toolchain drift: expected ${expected}, received ${versions[name]}`);
  }
}

async function packageVersion(root, name) {
  const manifest = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
  return manifest.version;
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

function parseArguments(values) {
  const result = { source: undefined, write: false, allowNodeDrift: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--source") result.source = values[++index];
    else if (values[index] === "--write") result.write = true;
    else if (values[index] === "--check") result.write = false;
    else if (values[index] === "--allow-node-drift") result.allowNodeDrift = true;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}
