import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = parseArguments(process.argv.slice(2));
const temporaryRoots = [];

try {
  const sliverSource = arguments_.sliverSource
    ? resolve(arguments_.sliverSource)
    : await fetchSource("protocol-fetch-baseline.mjs", "sliver-protocol-ci-");
  const wrapperSource = arguments_.wrapperSource
    ? resolve(arguments_.wrapperSource)
    : await fetchSource("protocol-fetch-wrapper-base.mjs", "sliver-script-protocol-ci-");

  run("parity-check.mjs", ["--source", sliverSource, "--regenerate"]);
  run("protocol-generate-protobuf.mjs", [
    "--source", sliverSource, "--check",
    ...(arguments_.allowNodeDrift ? ["--allow-node-drift"] : []),
  ]);
  run("protocol-generate-wrapper-overlay.mjs", ["--source", wrapperSource, "--check"]);
  run("protocol-verify-vendor.mjs", ["--wrapper-source", wrapperSource]);
  console.log("Protocol, protobuf, parity, and vendored-wrapper drift checks passed");
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
  const result = { sliverSource: undefined, wrapperSource: undefined, allowNodeDrift: false };
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === "--sliver-source") result.sliverSource = requireValue(values[++index], "--sliver-source");
    else if (values[index] === "--wrapper-source") result.wrapperSource = requireValue(values[++index], "--wrapper-source");
    else if (values[index] === "--allow-node-drift") result.allowNodeDrift = true;
    else throw new Error(`Unknown argument: ${values[index]}`);
  }
  return result;
}

function requireValue(value, option) {
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
