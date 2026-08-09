import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(await readFile(join(repositoryRoot, "protocol/sliver-script-provenance.json"), "utf8"));
const arguments_ = parseArguments(process.argv.slice(2));
const destination = resolve(arguments_.destination ?? await mkdtemp(join(tmpdir(), "sliver-script-base-")));

if (arguments_.verifyOnly) {
  verifyCheckout(destination);
  console.log(destination);
  process.exit(0);
}

if (existsSync(destination)) {
  if ((await readdir(destination)).length !== 0) {
    throw new Error(`Refusing to fetch into non-empty destination: ${destination}`);
  }
} else {
  await mkdir(destination, { recursive: true });
}

runGit(destination, ["init", "--quiet"]);
runGit(destination, ["remote", "add", "origin", provenance.wrapper.repository]);
runGit(destination, ["fetch", "--quiet", "--depth=1", "--no-tags", "origin", provenance.wrapper.publishedBase]);
runGit(destination, ["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
verifyCheckout(destination);
console.log(destination);

function verifyCheckout(checkout) {
  if (!existsSync(join(checkout, ".git"))) throw new Error(`Not a Git checkout: ${checkout}`);
  const commit = git(checkout, ["rev-parse", "HEAD"]);
  if (commit !== provenance.wrapper.publishedBase) {
    throw new Error(`sliver-script base mismatch: expected ${provenance.wrapper.publishedBase}, received ${commit}`);
  }
  const dirty = git(checkout, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (dirty !== "") throw new Error(`sliver-script base has tracked changes:\n${dirty}`);
}

function parseArguments(values) {
  const result = { destination: undefined, verifyOnly: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--destination") result.destination = requireValue(values[++index], "--destination");
    else if (values[index] === "--verify-only") result.verifyOnly = true;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  if (result.verifyOnly && !result.destination) throw new Error("--verify-only requires --destination");
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function runGit(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "inherit" });
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
