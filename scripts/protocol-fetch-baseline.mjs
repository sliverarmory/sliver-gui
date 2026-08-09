import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(await readFile(join(repositoryRoot, "protocol/sliver-baseline.json"), "utf8"));
const arguments_ = parseArguments(process.argv.slice(2));
const destination = resolve(
  arguments_.destination ?? (await mkdtemp(join(tmpdir(), "sliver-gui-baseline-"))),
);

if (arguments_.verifyOnly) {
  await verifyCheckout(destination);
  console.log(destination);
  process.exit(0);
}

if (existsSync(destination)) {
  const entries = await readdir(destination);
  if (entries.length !== 0) {
    throw new Error(`Refusing to fetch into non-empty destination: ${destination}`);
  }
} else {
  await mkdir(destination, { recursive: true });
}

runGit(destination, ["init", "--quiet"]);
runGit(destination, ["remote", "add", "origin", lock.repository]);
runGit(destination, [
  "fetch",
  "--quiet",
  "--depth=1",
  "--no-tags",
  "origin",
  lock.commit,
]);
runGit(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
await verifyCheckout(destination);
console.log(destination);

async function verifyCheckout(checkout) {
  if (!existsSync(join(checkout, ".git"))) {
    throw new Error(`Not a Git checkout: ${checkout}`);
  }
  const commit = gitOutput(checkout, ["rev-parse", "HEAD"]);
  if (commit !== lock.commit) {
    throw new Error(`Sliver commit mismatch: expected ${lock.commit}, received ${commit}`);
  }
  const tree = gitOutput(checkout, ["rev-parse", "HEAD^{tree}"]);
  if (tree !== lock.tree) {
    throw new Error(`Sliver tree mismatch: expected ${lock.tree}, received ${tree}`);
  }
  const dirty = gitOutput(checkout, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (dirty !== "") {
    throw new Error(`Sliver baseline checkout is modified:\n${dirty}`);
  }

  for (const input of lock.protobuf.files) {
    const data = await readFile(join(checkout, "protobuf", input.path));
    const digest = createHash("sha256").update(data).digest("hex");
    if (digest !== input.sha256) {
      throw new Error(`Pinned protobuf digest mismatch for ${input.path}`);
    }
  }
}

function parseArguments(values) {
  const parsed = { destination: undefined, verifyOnly: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--destination") {
      parsed.destination = requireValue(values[++index], value);
    } else if (value === "--verify-only") {
      parsed.verifyOnly = true;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (parsed.verifyOnly && !parsed.destination) {
    throw new Error("--verify-only requires --destination");
  }
  return parsed;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function runGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function gitOutput(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
