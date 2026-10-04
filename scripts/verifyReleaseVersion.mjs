import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tag = argumentValue("--tag") ?? process.env.GITHUB_REF_NAME;
const allowPackageMismatch = process.argv.includes("--allow-package-mismatch");

if (!tag) {
  throw new Error("A release tag is required via --tag or GITHUB_REF_NAME");
}

const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(tag);
if (!match) {
  throw new Error(`Release tag must be an exact stable SemVer tag such as v1.2.3: ${tag}`);
}

const version = tag.slice(1);
if (!allowPackageMismatch) {
  const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(rootDir, "package-lock.json"), "utf8"));
  const versions = new Map([
    ["package.json", packageJson.version],
    ["package-lock.json", packageLock.version],
    ["package-lock.json root package", packageLock.packages?.[""]?.version],
  ]);

  for (const [source, actual] of versions) {
    if (actual !== version) {
      throw new Error(`${source} version ${String(actual)} does not match release tag ${tag}`);
    }
  }
}

console.log(
  allowPackageMismatch
    ? `Validated stable release tag ${tag}`
    : `Validated release tag and package version ${tag}`,
);

function argumentValue(name) {
  const indexes = process.argv.flatMap((argument, index) => argument === name ? [index] : []);
  if (indexes.length > 1) throw new Error(`${name} may be specified only once`);
  if (indexes.length === 0) return undefined;
  const value = process.argv[indexes[0] + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}
