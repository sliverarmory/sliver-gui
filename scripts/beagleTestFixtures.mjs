import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BEAGLE_SOURCE_MANIFEST, BEAGLE_TARGETS, buildBeagleRuntime, readBeagleReleaseArchive, sha256 } from "./buildBeagleRuntime.mjs";
import { nativeBinary, universalBinary } from "./rdpTestFixtures.mjs";

export async function beagleFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "sliver-beagle-build-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["protocol", "scripts", "native/beagle"]) await mkdir(join(root, directory), { recursive: true });
  for (const name of ["buildBeagleRuntime.mjs", "verifyBeagleRuntime.mjs"]) await writeFile(join(root, "scripts", name), `// ${name} fixture input\n`);
  const manifest = {
    schemaVersion: 1, protocolVersion: 1, version: "0.1.0",
    source: { repository: "https://github.com/sliverarmory/Beagle", commit: "a".repeat(40), tree: "b".repeat(40) },
    toolchain: { rust: "1.94.1" }, release: { tag: "v0.1.0", assets: [] },
  };
  const archives = new Map();
  const releaseFiles = new Map();
  for (const target of [...BEAGLE_TARGETS["darwin-universal"], ...BEAGLE_TARGETS["windows-x64"], ...BEAGLE_TARGETS["linux-x64"]]) {
    const binaryName = target.includes("windows") ? "beagle.exe" : "beagle";
    const binary = nativeBinary(target);
    if (target.includes("windows")) {
      binary.writeUInt16LE(240, 128 + 20); // Complete PE32+ optional header.
      binary.writeUInt32LE(16, 152 + 108); // Data-directory count includes the certificate table.
    }
    const fileName = `beagle-${manifest.version}-${target}.${target.includes("windows") ? "zip" : "tar.gz"}`;
    const url = `${manifest.source.repository}/releases/download/${manifest.release.tag}/${fileName}`;
    const archive = Buffer.from(`archive of ${target}`);
    const asset = { target, fileName, url, sha256: sha256(archive), binarySha256: sha256(binary) };
    manifest.release.assets.push(asset);
    archives.set(url, archive);
    releaseFiles.set(target, new Map([
      [binaryName, binary], ["LICENSE", Buffer.from("Beagle GPL license\n")],
      ["THIRD_PARTY_NOTICES.md", Buffer.from("Graph engine and dependency notices\n")],
      ["licenses/graph/LICENSE", Buffer.from("Graph engine MIT license\n")],
      ["BUILD-PROVENANCE.json", Buffer.from(JSON.stringify({ schema_version: 1, project: "beagle", version: manifest.version,
        tag: manifest.release.tag, commit: manifest.source.commit, tree: manifest.source.tree, target,
        rust_toolchain: manifest.toolchain.rust, helper_protocol: manifest.protocolVersion, binary: { name: binaryName, sha256: asset.binarySha256 } }))],
    ]));
  }
  await writeFile(join(root, BEAGLE_SOURCE_MANIFEST), JSON.stringify(manifest));
  const downloads = [];
  const calls = [];
  const fetchBytes = async (url) => { downloads.push(url); return Buffer.from(archives.get(url)); };
  const readArchive = async (archivePath, asset, pin) => readBeagleReleaseArchive(archivePath, asset, pin, async (args) => {
    const files = releaseFiles.get(asset.target);
    const prefix = `beagle-${pin.version}-${asset.target}`;
    if (args[0] === "-tf") return Buffer.from([`${prefix}/`, ...[...files.keys()].map((name) => `${prefix}/${name}`)].join("\n"));
    return Buffer.from(files.get(args[2].slice(prefix.length + 1)));
  });
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command !== "/usr/bin/lipo" || args[0] !== "-create") throw new Error(`Unexpected build command: ${command}`);
    await writeFile(args.at(-1), universalBinary());
    return { stdout: "", stderr: "" };
  };
  const options = { projectDirectory: root, platform: "linux", architecture: "x64", fetchBytes, readArchive, run };
  return { root, manifest, archives, releaseFiles, downloads, calls, fetchBytes, readArchive, run, options };
}

export async function builtBeagleFixture(context, platform = "linux", architecture = platform === "darwin" ? "arm64" : "x64", hostOnly = false) {
  const fixture = await beagleFixture(context);
  const built = await buildBeagleRuntime({ ...fixture.options, platform, architecture, hostOnly });
  const target = built.record.build.target === "darwin-universal"
    ? architecture === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin" : built.record.build.slices[0].target;
  const info = { name: "beagle", protocol: 1, version: fixture.manifest.version, beagleRevision: fixture.manifest.source.commit, target };
  const commands = [];
  const run = async (command, args, options) => {
    commands.push({ command, args, options });
    if (args[0] !== "--build-info") throw new Error(`Unexpected verification command: ${command}`);
    return { stdout: JSON.stringify(info), stderr: "" };
  };
  const options = { projectDirectory: fixture.root, platform, architecture, hostOnly, run };
  return { ...fixture, ...built, info, commands, options };
}
