import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/sliverarmory/sliver-gui";

/** Keep the corresponding-source archive aligned with a release's package version. */
export async function syncReleaseVersion(directory = rootDirectory) {
  const [packageContent, provenanceContent] = await Promise.all([
    readFile(join(directory, "package.json"), "utf8"),
    readFile(join(directory, "protocol/sliver-console-provenance.json"), "utf8"),
  ]);
  const { version } = JSON.parse(packageContent);
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Corresponding-source metadata requires an exact stable package version.");
  }
  const provenance = JSON.parse(provenanceContent);
  const source = provenance.build?.overlay?.correspondingSource;
  if (source?.repository !== repository) {
    throw new Error("Unexpected corresponding-source repository.");
  }
  source.packageVersion = version;
  source.tag = `v${version}`;
  source.archive = `${repository}/archive/refs/tags/v${version}.tar.gz`;
  await writeFile(join(directory, "protocol/sliver-console-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Synchronized corresponding-source metadata for ${await syncReleaseVersion()}.`);
}
