import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT_DIRECTORY, rdpTargetForHost, runRdpCommand, sha256 } from "./buildRdpRuntime.mjs";

export { ROOT_DIRECTORY, sha256 };
export const BEAGLE_SOURCE_MANIFEST = "protocol/beagle-provenance.json";
export const BEAGLE_PACKAGED_RECORD = "native/beagle/packaged-provenance.json";
export const BEAGLE_OUTPUT_DIRECTORY = "native/beagle/bin";
export const BEAGLE_TARGETS = Object.freeze({
  "darwin-universal": ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  "darwin-arm64": ["aarch64-apple-darwin"],
  "darwin-x64": ["x86_64-apple-darwin"],
  "windows-x64": ["x86_64-pc-windows-gnu"],
  "linux-x64": ["x86_64-unknown-linux-gnu"],
});
export const beagleTargetForHost = rdpTargetForHost;
export function beagleExecutableName(target) {
  if (!Object.hasOwn(BEAGLE_TARGETS, target)) throw new Error(`Unsupported Beagle target: ${target}`);
  return target === "windows-x64" ? "beagle.exe" : "beagle";
}
const HASH = /^[a-f0-9]{64}$/u;
const TRIPLES = [...BEAGLE_TARGETS["darwin-universal"], ...BEAGLE_TARGETS["windows-x64"], ...BEAGLE_TARGETS["linux-x64"]];
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;

export function validateBeagleSourceManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 ||
      !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(manifest.version ?? "") ||
      manifest.source?.repository !== "https://github.com/sliverarmory/Beagle" ||
      !/^[a-f0-9]{40}$/u.test(manifest.source?.commit ?? "") || !/^[a-f0-9]{40}$/u.test(manifest.source?.tree ?? "") ||
      !/^\d+\.\d+\.\d+$/u.test(manifest.toolchain?.rust ?? "") ||
      manifest.release?.tag !== `v${manifest.version}` || !Array.isArray(manifest.release?.assets) ||
      manifest.release.assets.length !== TRIPLES.length) throw new Error("Invalid pinned Beagle release provenance");
  const targets = new Set();
  for (const asset of manifest.release.assets) {
    const root = `beagle-${manifest.version}-${asset.target}`;
    const filename = `${root}.${asset.target === "x86_64-pc-windows-gnu" ? "zip" : "tar.gz"}`;
    if (!TRIPLES.includes(asset.target) || targets.has(asset.target) || asset.fileName !== filename ||
        asset.url !== `${manifest.source.repository}/releases/download/${manifest.release.tag}/${filename}` ||
        !HASH.test(asset.sha256 ?? "") || !HASH.test(asset.binarySha256 ?? "")) {
      throw new Error("Invalid pinned Beagle release asset");
    }
    targets.add(asset.target);
  }
  return manifest;
}

export async function beagleSourceInputs(projectDirectory = ROOT_DIRECTORY) {
  return Promise.all(["scripts/buildBeagleRuntime.mjs", "scripts/verifyBeagleRuntime.mjs"].map(async (path) =>
    ({ path, sha256: sha256(await readFile(join(projectDirectory, path))) })));
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { "User-Agent": "sliver-gui-build" } });
  if (!response.ok) throw new Error(`Beagle release download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw new Error("Beagle release archive exceeds size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Read archive members to stdout, never extract paths or links into the checkout.
// BSD tar (macOS/Windows) supports ZIP; Linux releases use ordinary tar.gz.
async function archiveCommand(args) {
  // Git/MSYS may prepend GNU tar, which cannot read the Windows ZIP release.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe")
    : process.platform === "darwin" ? "/usr/bin/tar" : "tar";
  return new Promise((accept, reject) => execFile(tar, args,
    { encoding: "buffer", maxBuffer: MAX_ARCHIVE_BYTES, timeout: 60_000, windowsHide: true },
    (error, stdout) => error ? reject(new Error(`Cannot read Beagle release archive: ${error.message}`)) : accept(stdout)));
}

export function beagleArchiveMembers(listing, root) {
  const members = listing.trim().split(/\r?\n/u).filter(Boolean);
  const files = [];
  const seen = new Set();
  for (const path of members) {
    if (!path.startsWith(`${root}/`) && path !== root) throw new Error("Unexpected Beagle archive root");
    if (path.includes("\\") || /[\x00-\x1f\x7f]/u.test(path) ||
        path.split("/").some((part, index, all) => part === ".." || part === "." || (part === "" && index !== all.length - 1))) {
      throw new Error("Unsafe Beagle archive member");
    }
    if (path === root || path.endsWith("/")) continue;
    const name = path.slice(root.length + 1);
    if (seen.has(name)) throw new Error("Duplicate Beagle archive member");
    seen.add(name);
    if (!["beagle", "beagle.exe", "LICENSE", "THIRD_PARTY_NOTICES.md", "BUILD-PROVENANCE.json"].includes(name) && !name.startsWith("licenses/")) {
      throw new Error(`Unexpected Beagle archive member: ${name}`);
    }
    files.push(name);
  }
  if (files.length > 512) throw new Error("Too many Beagle archive members");
  return files.sort();
}

export async function readBeagleReleaseArchive(archivePath, asset, manifest, read = archiveCommand) {
  const root = `beagle-${manifest.version}-${asset.target}`;
  const names = beagleArchiveMembers((await read(["-tf", archivePath])).toString("utf8"), root);
  const files = new Map();
  let total = 0;
  for (const name of names) {
    const bytes = await read(["-xOf", archivePath, `${root}/${name}`]);
    total += bytes.length;
    if (total > MAX_ARCHIVE_BYTES || bytes.length === 0) throw new Error("Invalid Beagle archive member size");
    files.set(name, bytes);
  }
  const binaryName = asset.target.endsWith("windows-gnu") ? "beagle.exe" : "beagle";
  for (const required of [binaryName, "LICENSE", "THIRD_PARTY_NOTICES.md", "BUILD-PROVENANCE.json"]) {
    if (!files.has(required)) throw new Error(`Missing Beagle release member: ${required}`);
  }
  const provenance = JSON.parse(files.get("BUILD-PROVENANCE.json"));
  if (provenance.schema_version !== 1 || provenance.project !== "beagle" || provenance.version !== manifest.version ||
      provenance.tag !== manifest.release.tag || provenance.commit !== manifest.source.commit || provenance.tree !== manifest.source.tree ||
      provenance.target !== asset.target || provenance.rust_toolchain !== manifest.toolchain.rust ||
      provenance.helper_protocol !== manifest.protocolVersion || provenance.binary?.name !== binaryName ||
      provenance.binary?.sha256 !== asset.binarySha256 || sha256(files.get(binaryName)) !== asset.binarySha256) {
    throw new Error("Beagle release archive does not match its pinned source, toolchain or binary digest");
  }
  return { files, binaryName };
}

export async function buildBeagleRuntime({ projectDirectory = ROOT_DIRECTORY, platform = process.platform,
  architecture = process.arch, hostOnly = false, fetchBytes = download, readArchive = readBeagleReleaseArchive,
  run = runRdpCommand } = {}) {
  const output = join(projectDirectory, BEAGLE_OUTPUT_DIRECTORY);
  const anchor = join(projectDirectory, BEAGLE_PACKAGED_RECORD);
  // Fail closed even when reading a changed pin or downloading its asset fails.
  await rm(join(output, "provenance.json"), { force: true });
  await rm(anchor, { force: true });
  const sourceBytes = await readFile(join(projectDirectory, BEAGLE_SOURCE_MANIFEST));
  const manifest = validateBeagleSourceManifest(JSON.parse(sourceBytes));
  const target = beagleTargetForHost(platform, architecture, hostOnly);
  const inputs = await beagleSourceInputs(projectDirectory);
  const cache = join(projectDirectory, "native/beagle/cache");
  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(join(cache, "stage-"));
  try {
    const slices = [];
    const notices = ["SLIVER BEAGLE RELEASE LICENSES", `Release: ${manifest.source.repository}/releases/tag/${manifest.release.tag}`, ""];
    const supportFiles = [];
    for (const triple of BEAGLE_TARGETS[target]) {
      const asset = manifest.release.assets.find((entry) => entry.target === triple);
      const archivePath = join(cache, `${asset.sha256}-${asset.fileName}`);
      let bytes = await readFile(archivePath).catch((error) => { if (error.code !== "ENOENT") throw error; });
      if (!bytes || sha256(bytes) !== asset.sha256) {
        bytes = await fetchBytes(asset.url);
        if (bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== asset.sha256) throw new Error("Beagle release archive checksum mismatch");
        await writeFile(`${archivePath}.tmp`, bytes);
        await rename(`${archivePath}.tmp`, archivePath);
      }
      const { files, binaryName } = await readArchive(archivePath, asset, manifest);
      const binary = files.get(binaryName);
      // Verify independently even when an archive reader is injected by a test.
      if (sha256(binary) !== asset.binarySha256) throw new Error("Beagle executable checksum mismatch");
      const path = join(staging, `${triple}-${binaryName}`);
      await writeFile(path, binary, { mode: 0o755 });
      slices.push({ target: triple, sha256: sha256(binary), size: binary.length, path });
      for (const [name, content] of files) {
        if (name === binaryName) continue;
        const relativePath = `licenses/${triple}/${name}`;
        await mkdir(dirname(join(staging, relativePath)), { recursive: true });
        await writeFile(join(staging, relativePath), content);
        supportFiles.push({ path: relativePath, sha256: sha256(content), size: content.length });
        if (name !== "BUILD-PROVENANCE.json") notices.push("=".repeat(80), `${triple}/${name}`, "", content.toString("utf8"), "");
      }
      if (!supportFiles.some(({ path: file }) => file === "LICENSE")) {
        const license = files.get("LICENSE");
        await writeFile(join(staging, "LICENSE"), license);
        supportFiles.push({ path: "LICENSE", sha256: sha256(license), size: license.length });
      }
    }
    const fileName = beagleExecutableName(target);
    const stagedExecutable = join(staging, fileName);
    if (target === "darwin-universal") await run("/usr/bin/lipo", ["-create", ...slices.map(({ path }) => path), "-output", stagedExecutable]);
    else await copyFile(slices[0].path, stagedExecutable);
    if (platform !== "win32") await chmod(stagedExecutable, 0o755);
    const inventory = Buffer.from(`${notices.join("\n")}\n`);
    await writeFile(join(staging, "THIRD_PARTY_LICENSES.txt"), inventory);
    supportFiles.push({ path: "THIRD_PARTY_LICENSES.txt", sha256: sha256(inventory), size: inventory.length });
    await writeFile(join(staging, "source-provenance.json"), sourceBytes);
    const executable = await readFile(stagedExecutable);
    const record = {
      schemaVersion: 1, protocolVersion: manifest.protocolVersion, version: manifest.version,
      source: manifest.source, sourceManifestSha256: sha256(sourceBytes), inputs,
      buildIdentity: sha256(JSON.stringify({ manifest, inputs })),
      toolchain: manifest.toolchain,
      build: { target, slices: slices.map(({ path: _path, ...entry }) => entry) },
      artifact: { fileName, sha256: sha256(executable), size: executable.length },
      supportFiles: supportFiles.sort((a, b) => a.path.localeCompare(b.path)),
      licenseInventorySha256: sha256(inventory), projectLicenseSha256: supportFiles.find(({ path }) => path === "LICENSE").sha256,
    };
    for (const { path } of slices) await rm(path);
    const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
    await writeFile(join(staging, "provenance.json"), recordBytes);
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    await writeFile(`${anchor}.tmp`, recordBytes);
    await rename(`${anchor}.tmp`, anchor);
    return { executablePath: join(output, fileName), record };
  } finally { await rm(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildBeagleRuntime({ hostOnly: process.argv.includes("--host") });
  console.log(`Bundled ${relative(ROOT_DIRECTORY, result.executablePath)} from pinned Beagle release (${result.record.build.target})`);
}
