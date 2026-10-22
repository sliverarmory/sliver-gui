import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRdpSource, RDP_SOURCE_PATCH, RDP_STAGED_SOURCE, verifyStagedRdpSource } from "./rdpSourceOverlay.mjs";

export const ROOT_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RDP_SOURCE_MANIFEST = "protocol/ironrdp-provenance.json";
export const RDP_PACKAGED_RECORD = "native/rdp/packaged-provenance.json";
export const RDP_OUTPUT_DIRECTORY = "native/rdp/bin";
export const RDP_TARGETS = Object.freeze({
  "darwin-universal": ["x86_64-apple-darwin", "aarch64-apple-darwin"],
  "darwin-arm64": ["aarch64-apple-darwin"],
  "darwin-x64": ["x86_64-apple-darwin"],
  "windows-x64": ["x86_64-pc-windows-msvc"],
  "linux-x64": ["x86_64-unknown-linux-gnu"],
});

export function rdpTargetForHost(platform, architecture = process.arch, hostOnly = false) {
  if (platform === "darwin" && ["arm64", "x64"].includes(architecture)) {
    return hostOnly ? `darwin-${architecture}` : "darwin-universal";
  }
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  throw new Error(`RDP packaging does not support ${platform}/${architecture}`);
}

export function rdpExecutableName(target) {
  if (!Object.hasOwn(RDP_TARGETS, target)) throw new Error(`Unsupported RDP target ${target}`);
  return target === "windows-x64" ? "sliver-rdp.exe" : "sliver-rdp";
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateRdpSourceManifest(manifest) {
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 ||
      manifest.source?.repository !== "https://github.com/sliverarmory/IronRDP" ||
      !/^[a-f0-9]{40}$/u.test(manifest.source?.commit ?? "") ||
      !/^[a-f0-9]{40}$/u.test(manifest.source?.tree ?? "") ||
      manifest.source?.patchInventory !== "SLIVER_GUI_EMBEDDING.md" ||
      !/^[a-f0-9]{64}$/u.test(manifest.source?.patchInventorySha256 ?? "") ||
      (manifest.source.localOverlay !== undefined && (
        manifest.source.localOverlay.patch !== RDP_SOURCE_PATCH ||
        !/^[a-f0-9]{64}$/u.test(manifest.source.localOverlay.sha256 ?? "") ||
        !/^[a-f0-9]{40}$/u.test(manifest.source.localOverlay.tree ?? ""))) ||
      !/^\d+\.\d+\.\d+$/u.test(manifest.toolchain?.rust ?? "") ||
      manifest.build?.macosDeploymentTarget !== "13.0" ||
      manifest.build?.linuxGlibcBaseline !== "2.35" ||
      manifest.build?.windowsCrt !== "static" ||
      JSON.stringify([...(manifest.build?.ironrdpClientFeatures ?? [])].sort()) !== JSON.stringify(["clipboard-custom", "rustls"]) ||
      JSON.stringify(manifest.build?.targets) !== JSON.stringify([
        "x86_64-apple-darwin", "aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu",
      ])) {
    throw new Error("Invalid pinned IronRDP source/toolchain/platform provenance");
  }
  return manifest;
}

export async function rdpSourceInputs(projectDirectory = ROOT_DIRECTORY) {
  const paths = ["native/rdp/Cargo.toml", "native/rdp/Cargo.lock"];
  for (const optional of ["native/rdp/build.rs", "native/rdp/rust-toolchain.toml", "native/rdp/.cargo/config.toml", RDP_SOURCE_PATCH,
    "scripts/rdpSourceOverlay.mjs", "scripts/testRdpNative.mjs", "scripts/buildRdpRuntime.mjs", "scripts/verifyRdpRuntime.mjs"]) {
    if (await readFile(join(projectDirectory, optional)).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    })) paths.push(optional);
  }
  async function visit(directory) {
    for (const entry of await readdir(join(projectDirectory, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`RDP source must not contain symlinks: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  }
  await visit("native/rdp/src");
  return Promise.all(paths.sort().map(async (path) => ({ path, sha256: sha256(await readFile(join(projectDirectory, path))) })));
}

export function rdpBuildEnvironment(environment, manifest, target, projectDirectory, buildIdentity) {
  const passthrough = new Set([
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "TEMP", "TMP", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "SDKROOT", "DEVELOPER_DIR",
    "INCLUDE", "LIB", "LIBPATH", "VCTOOLSINSTALLDIR", "VCINSTALLDIR", "WINDOWSSDKDIR",
    "SYSTEMDRIVE", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "PROGRAMDATA", "VSINSTALLDIR",
    "VSCMD_ARG_TGT_ARCH", "WINDOWSSDKVERSION", "UNIVERSALCRTSDKDIR", "UCRTVERSION",
  ]);
  const result = Object.fromEntries(Object.entries(environment).filter(([key, value]) => value !== undefined && passthrough.has(key.toUpperCase())));
  const flags = [`--remap-path-prefix=${projectDirectory}=sliver-gui`];
  if (target.endsWith("windows-msvc")) flags.push("-Ctarget-feature=+crt-static");
  return {
    ...result,
    RUSTUP_TOOLCHAIN: manifest.toolchain.rust,
    CARGO_INCREMENTAL: "0",
    CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"),
    MACOSX_DEPLOYMENT_TARGET: manifest.build.macosDeploymentTarget,
    SLIVER_RDP_BUILD_ID: buildIdentity,
    SLIVER_RDP_SOURCE_REVISION: manifest.source.commit,
    SLIVER_RDP_BUILD_TARGET: target,
    SLIVER_RDP_PROTOCOL_VERSION: String(manifest.protocolVersion),
  };
}

/** Traverse the filtered Cargo resolve graph, omitting dev-only dependencies. */
export function selectedCargoPackages(metadata, sourceManifest, projectDirectory = ROOT_DIRECTORY) {
  const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
  const nodes = new Map(metadata.resolve.nodes.map((entry) => [entry.id, entry]));
  const selected = new Map();
  function visit(id) {
    if (selected.has(id)) return;
    const entry = packages.get(id);
    const node = nodes.get(id);
    if (!entry || !node) throw new Error("Incomplete RDP Cargo dependency graph");
    selected.set(id, { ...entry, selectedFeatures: [...node.features].sort() });
    for (const dependency of node.deps) {
      if (dependency.dep_kinds.some(({ kind }) => kind !== "dev")) visit(dependency.pkg);
    }
  }
  visit(metadata.resolve.root);
  const ironrdp = [...selected.values()].filter(({ name }) => name.startsWith("ironrdp-"));
  if (ironrdp.length === 0) throw new Error("RDP helper has no pinned IronRDP dependencies");
  for (const dependency of ironrdp) {
    const expected = `git+${sourceManifest.source.repository}?rev=${sourceManifest.source.commit}#${sourceManifest.source.commit}`;
    const valid = sourceManifest.source.localOverlay
      ? dependency.source === null && resolve(dependency.manifest_path) === join(resolve(projectDirectory), RDP_STAGED_SOURCE, "crates", dependency.name, "Cargo.toml")
      : dependency.source === expected;
    if (!valid) throw new Error(`Unpinned IronRDP dependency: ${dependency.name}`);
  }
  const client = ironrdp.find(({ name }) => name === "ironrdp-client");
  if (!client || JSON.stringify(client.selectedFeatures) !== JSON.stringify([...sourceManifest.build.ironrdpClientFeatures].sort())) {
    throw new Error("IronRDP client features do not match the pinned feature inventory");
  }
  return [...selected.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export async function verifyIronRdpPatchInventory(packages, sourceManifest) {
  const client = packages.find(({ name }) => name === "ironrdp-client");
  if (!client) throw new Error("Missing IronRDP client source");
  let directory = dirname(client.manifest_path);
  for (let depth = 0; depth < 5; depth += 1) {
    const bytes = await readFile(join(directory, sourceManifest.source.patchInventory)).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (bytes) {
      if (sha256(bytes) !== sourceManifest.source.patchInventorySha256) throw new Error("IronRDP fork patch inventory does not match its pinned digest");
      return directory;
    }
    if (dirname(directory) === directory) break;
    directory = dirname(directory);
  }
  throw new Error("IronRDP fork patch inventory is missing");
}

export async function verifyIronRdpCheckout(directory, manifest, run = runRdpCommand, environment = {}) {
  const options = { env: environment };
  const revision = (await run("git", ["-C", directory, "rev-parse", "HEAD", "HEAD^{tree}"], options)).stdout.trim().split(/\r?\n/u);
  const status = (await run("git", ["-C", directory, "status", "--porcelain", "--untracked-files=all"], options)).stdout.trim().split(/\r?\n/u);
  // Cargo adds this completion marker after checking out the exact Git source.
  if (revision[0] !== manifest.source.commit || revision[1] !== manifest.source.tree ||
      status.some((entry) => entry !== "" && entry !== "?? .cargo-ok")) {
    throw new Error("IronRDP Cargo checkout is modified or does not match the pinned commit/tree");
  }
}

export async function cargoLicenseInventory(packages, projectDirectory = ROOT_DIRECTORY) {
  const sections = ["SLIVER RDP RUST DEPENDENCY LICENSES", "Includes normal and build dependencies for the exact selected target features.", ""];
  const entries = [];
  for (const entry of packages) {
    if (!entry.license && !entry.license_file) throw new Error(`Rust dependency has no license declaration: ${entry.name}@${entry.version}`);
    const licenseFiles = new Map();
    let directory = dirname(entry.manifest_path);
    // IronRDP workspace crates share notices at their pinned checkout root.
    const levels = entry.source?.startsWith("git+") || entry.name.startsWith("ironrdp-") ? 5 : 1;
    for (let depth = 0; depth < levels; depth += 1) {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(item.name)) {
          const bytes = await readFile(join(directory, item.name));
          if (bytes.length > 2 * 1024 * 1024) throw new Error(`Rust license file is too large: ${entry.name}`);
          licenseFiles.set(sha256(bytes), { name: item.name, text: bytes.toString("utf8").trim() });
        }
      }
      if (licenseFiles.size || dirname(directory) === directory) break;
      directory = dirname(directory);
    }
    if (entry.license_file) {
      const bytes = await readFile(entry.license_file);
      licenseFiles.set(sha256(bytes), { name: "Cargo license_file", text: bytes.toString("utf8").trim() });
    }
    if (licenseFiles.size === 0 && entry.name === "sliver-rdp") {
      licenseFiles.set("project", { name: "LICENSE", text: await readFile(join(projectDirectory, "LICENSE"), "utf8") });
    }
    entries.push({ entry, licenseFiles });
  }
  const repositoryKey = (entry) => entry.repository?.toLowerCase().replace(/\.git$/u, "").replace(/\/$/u, "");
  const licenseKey = (entry) => entry.license?.replace(/\//gu, " OR ").replace(/\s+/gu, " ");
  for (const { entry, licenseFiles } of entries) {
    let sharedFrom;
    if (licenseFiles.size === 0 && repositoryKey(entry)) {
      // Some published workspace subcrates omit their shared root license. Reuse
      // a matching license from an installed crate in that same upstream repo.
      const sibling = entries.find((candidate) => candidate.licenseFiles.size && repositoryKey(candidate.entry) === repositoryKey(entry) && licenseKey(candidate.entry) === licenseKey(entry));
      if (sibling) {
        for (const [key, file] of sibling.licenseFiles) licenseFiles.set(key, file);
        sharedFrom = `${sibling.entry.name}@${sibling.entry.version}`;
      }
    }
    sections.push("=".repeat(80), `${entry.name}@${entry.version}`, `Source: ${entry.source ?? (entry.name.startsWith("ironrdp-") ? "Pinned IronRDP source with reviewed local overlay (see source-provenance.json)" : "Sliver GUI source")}`,
      `Declared license: ${entry.license ?? "see license_file"}`, `Features: ${entry.selectedFeatures.join(", ")}`, "");
    if (sharedFrom) sections.push(`Shared upstream license text from ${sharedFrom} (${entry.repository}).`, "");
    if (licenseFiles.size === 0) {
      // A missing notice must be reviewed, not silently omitted from a release.
      throw new Error(`Rust dependency has no packaged license/notice text: ${entry.name}@${entry.version}`);
    }
    for (const { name, text } of licenseFiles.values()) sections.push(`--- ${name} ---`, text, "");
  }
  sections.push(`Cargo inventory entries: ${packages.length}`, "");
  return sections.join("\n");
}

export async function runRdpCommand(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, ...options });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) stream.on("data", (bytes) => {
      outputBytes += bytes.length;
      if (outputBytes > 32 * 1024 * 1024) child.kill();
      else chunks.push(bytes);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code !== 0 || outputBytes > 32 * 1024 * 1024) reject(new Error(`${command} failed (${signal ?? code}): ${result.stderr.slice(-12000)}`));
      else accept(result);
    });
  });
}

export async function buildRdpRuntime({ projectDirectory = ROOT_DIRECTORY, platform = process.platform,
  architecture = process.arch, hostOnly = false, run = runRdpCommand, environment = process.env } = {}) {
  const manifestBytes = await readFile(join(projectDirectory, RDP_SOURCE_MANIFEST));
  const manifest = validateRdpSourceManifest(JSON.parse(manifestBytes));
  const inputs = await rdpSourceInputs(projectDirectory);
  const buildIdentity = sha256(JSON.stringify({ manifest, inputs }));
  const target = rdpTargetForHost(platform, architecture, hostOnly);
  const slices = RDP_TARGETS[target];
  const outputDirectory = join(projectDirectory, RDP_OUTPUT_DIRECTORY);
  const crateDirectory = join(projectDirectory, "native/rdp");
  const targetDirectory = join(crateDirectory, "target");
  const commonEnvironment = rdpBuildEnvironment(environment, manifest, slices[0], projectDirectory, buildIdentity);
  const rustVersion = (await run("rustc", ["--version"], { cwd: crateDirectory, env: commonEnvironment })).stdout.trim();
  if (!rustVersion.startsWith(`rustc ${manifest.toolchain.rust} `)) throw new Error(`RDP requires Rust ${manifest.toolchain.rust}; found ${rustVersion}`);
  const cargoVersion = (await run("cargo", ["--version"], { cwd: crateDirectory, env: commonEnvironment })).stdout.trim();
  if (!cargoVersion.startsWith(`cargo ${manifest.toolchain.rust} `)) throw new Error(`RDP requires Cargo ${manifest.toolchain.rust}; found ${cargoVersion}`);
  await mkdir(outputDirectory, { recursive: true });
  // Remove the success marker first so a failed rebuild cannot package stale output.
  await rm(join(outputDirectory, "provenance.json"), { force: true });
  await rm(join(projectDirectory, RDP_PACKAGED_RECORD), { force: true });
  if (manifest.source.localOverlay) await prepareRdpSource({ projectDirectory, manifest, run, environment: commonEnvironment });
  const dependencies = new Map();
  const sliceRecords = [];
  for (const slice of slices) {
    const env = rdpBuildEnvironment(environment, manifest, slice, projectDirectory, buildIdentity);
    const metadata = JSON.parse((await run("cargo", ["metadata", "--format-version=1", "--locked", "--filter-platform", slice], { cwd: crateDirectory, env })).stdout);
    const selected = selectedCargoPackages(metadata, manifest, projectDirectory);
    const checkout = await verifyIronRdpPatchInventory(selected, manifest);
    if (manifest.source.localOverlay) await verifyStagedRdpSource(checkout, manifest, run, env);
    else await verifyIronRdpCheckout(checkout, manifest, run, env);
    for (const entry of selected) dependencies.set(entry.id, {
      ...entry, selectedFeatures: [...new Set([...(dependencies.get(entry.id)?.selectedFeatures ?? []), ...entry.selectedFeatures])].sort(),
    });
    await run("cargo", ["build", "--release", "--locked", "--bin", "sliver-rdp", "--target", slice, "--target-dir", targetDirectory], { cwd: crateDirectory, env });
    if (manifest.source.localOverlay) await verifyStagedRdpSource(checkout, manifest, run, env);
    const path = join(targetDirectory, slice, "release", rdpExecutableName(target));
    const bytes = await readFile(path);
    sliceRecords.push({ target: slice, sha256: sha256(bytes), size: bytes.length, path });
  }
  const executableName = rdpExecutableName(target);
  const executablePath = join(outputDirectory, executableName);
  const temporaryPath = `${executablePath}.tmp`;
  if (target === "darwin-universal") {
    await run("/usr/bin/lipo", ["-create", ...sliceRecords.map(({ path }) => path), "-output", temporaryPath]);
  } else await copyFile(sliceRecords[0].path, temporaryPath);
  if (platform !== "win32") await chmod(temporaryPath, 0o755);
  await rename(temporaryPath, executablePath);
  const licenseInventory = await cargoLicenseInventory([...dependencies.values()].sort((left, right) => left.id.localeCompare(right.id)), projectDirectory);
  await writeFile(join(outputDirectory, "THIRD_PARTY_LICENSES.txt"), licenseInventory);
  await writeFile(join(outputDirectory, "source-provenance.json"), manifestBytes);
  await copyFile(join(projectDirectory, "LICENSE"), join(outputDirectory, "LICENSE"));
  const executable = await readFile(executablePath);
  const record = {
    schemaVersion: 1, protocolVersion: manifest.protocolVersion, buildIdentity,
    source: manifest.source, sourceManifestSha256: sha256(manifestBytes), inputs,
    toolchain: { rust: rustVersion, cargo: cargoVersion },
    build: { target, macosDeploymentTarget: manifest.build.macosDeploymentTarget, windowsCrt: manifest.build.windowsCrt,
      slices: sliceRecords.map(({ path: _path, ...entry }) => entry) },
    dependencies: [...dependencies.values()].map(({ name, version, source, license, selectedFeatures }) => ({ name, version,
      source: source ?? (name.startsWith("ironrdp-") ? `git+${manifest.source.repository}#${manifest.source.commit};overlay-sha256=${manifest.source.localOverlay.sha256}` : null),
      license, features: selectedFeatures })),
    artifact: { fileName: executableName, sha256: sha256(executable), size: executable.length },
    licenseInventorySha256: sha256(licenseInventory), projectLicenseSha256: sha256(await readFile(join(projectDirectory, "LICENSE"))),
  };
  const recordBytes = `${JSON.stringify(record, null, 2)}\n`;
  // electron-builder excludes extraResources sources from ASAR. Keep its trust
  // anchor outside bin/ so the archive and external helper each retain a copy.
  await writeFile(join(projectDirectory, `${RDP_PACKAGED_RECORD}.tmp`), recordBytes);
  await rename(join(projectDirectory, `${RDP_PACKAGED_RECORD}.tmp`), join(projectDirectory, RDP_PACKAGED_RECORD));
  await writeFile(join(outputDirectory, "provenance.json.tmp"), recordBytes);
  await rename(join(outputDirectory, "provenance.json.tmp"), join(outputDirectory, "provenance.json"));
  return { executablePath, record };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildRdpRuntime({ hostOnly: process.argv.includes("--host") });
  console.log(`Built ${relative(ROOT_DIRECTORY, result.executablePath)} (${result.record.build.target}, ABI ${result.record.protocolVersion})`);
}
