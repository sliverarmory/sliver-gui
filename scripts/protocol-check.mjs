import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = parseArguments(process.argv.slice(2));
const temporaryRoots = [];

try {
  run("protocol-verify-client-package.mjs", []);
  const sliverSource = arguments_.sliverSource
    ? resolve(arguments_.sliverSource)
    : await fetchSource("protocol-fetch-baseline.mjs", "sliver-protocol-ci-");

  run("parity-check.mjs", ["--source", sliverSource, "--regenerate"]);
  console.log("Protocol, parity, and installed-client provenance checks passed");
} finally {
  for (const directory of temporaryRoots) {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fetchSource(script, prefix) {
  const destination = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(destination);
  run(script, ["--destination", destination]);
  return destination;
}

function run(script, args) {
  execFileSync(process.execPath, [join(repositoryRoot, "scripts", script), ...args], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
}

function parseArguments(values) {
  const result = { sliverSource: undefined };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--sliver-source") result.sliverSource = requireValue(values[++index], "--sliver-source");
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
