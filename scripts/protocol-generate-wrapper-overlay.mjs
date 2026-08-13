import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(await readFile(join(repositoryRoot, "protocol/sliver-baseline.json"), "utf8"));
const arguments_ = parseArguments(process.argv.slice(2));
if (!arguments_.source) throw new Error("Pass --source with the exact sliver-script public base or reconstructed snapshot");

const source = resolve(arguments_.source);
const snapshot = baseline.vendoredWrapper.snapshot;
const sourceHead = git(source, ["rev-parse", "HEAD"]);
if (![snapshot, baseline.vendoredWrapper.publishedBase].includes(sourceHead)) {
  throw new Error(`Wrapper source must be the locked public base or snapshot, received ${sourceHead}`);
}
if (git(source, ["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
  throw new Error("Wrapper source has tracked changes");
}

const overlayFiles = [
  "src/client.ts",
  "src/config.ts",
  "src/index.ts",
  "src/internal/asyncQueue.ts",
  "src/internal/credentials.ts",
  "src/internal/tunnelManager.ts",
  "src/internal/timeout.ts",
  "src/messageBudget.ts",
];
const workspace = await mkdtemp(join(tmpdir(), "sliver-wrapper-overlay-"));
execFileSync("git", ["clone", "--quiet", "--shared", "--no-checkout", source, workspace], { stdio: "inherit" });
if (!git(workspace, ["cat-file", "-e", `${snapshot}^{commit}`], false)) {
  execFileSync("git", [
    "fetch",
    "--quiet",
    join(repositoryRoot, "vendor/sliver-script/sliver-script-snapshot.bundle"),
    `HEAD:refs/sliver-gui/${snapshot}`,
  ], { cwd: workspace, stdio: "inherit" });
}
execFileSync("git", ["checkout", "--quiet", "--detach", snapshot], { cwd: workspace, stdio: "inherit" });

for (const file of overlayFiles) {
  const current = join(repositoryRoot, "vendor/sliver-script", file);
  if (!existsSync(current)) throw new Error(`Missing reviewed overlay file: ${file}`);
  await mkdir(dirname(join(workspace, file)), { recursive: true });
  await copyFile(current, join(workspace, file));
}
execFileSync("git", ["add", "--intent-to-add", "--", ...overlayFiles], { cwd: workspace, stdio: "inherit" });

const diff = spawnSync("git", ["diff", "--binary", "--", ...overlayFiles], {
  cwd: workspace,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
if (diff.status !== 0) throw new Error(`git diff failed with status ${diff.status}`);
// A unified diff represents blank context lines with one leading space. Store
// those as empty lines so this reviewed patch artifact itself remains clean
// under `git diff --check`; `git apply` accepts the normalized form.
const patchText = diff.stdout.replace(/^ $/gmu, "");
const changedFiles = git(workspace, ["diff", "--name-only", "--", ...overlayFiles]).split("\n").filter(Boolean);
for (const file of overlayFiles) {
  if (!changedFiles.includes(file)) {
    throw new Error(`Overlay patch did not capture reviewed file: ${file}`);
  }
}

const output = join(repositoryRoot, "protocol/sliver-script-handwritten-overlay.patch");
if (arguments_.check) {
  const checkedIn = await readFile(output, "utf8").catch(() => undefined);
  if (checkedIn !== patchText) throw new Error("Handwritten wrapper overlay patch drifted; regenerate it deliberately");
} else {
  await writeFile(output, patchText, "utf8");
}

console.log(`Handwritten wrapper overlay ${arguments_.check ? "verified" : "generated"}: ${overlayFiles.join(", ")}`);

function parseArguments(values) {
  const result = { source: undefined, check: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--source") result.source = requireValue(values[++index], "--source");
    else if (values[index] === "--check") result.check = true;
    else if (values[index] === "--write") result.check = false;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function git(cwd, args, capture = true) {
  try {
    const result = execFileSync("git", args, {
      cwd,
      encoding: capture ? "utf8" : undefined,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
    });
    return capture ? result.trim() : true;
  } catch {
    return capture ? "" : false;
  }
}
