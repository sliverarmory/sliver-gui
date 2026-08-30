import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIRECTORY = resolve(scriptDirectory, "..");
export const SOURCE_MANIFEST_PATH = join(ROOT_DIRECTORY, "protocol", "sliver-console-provenance.json");
export const OUTPUT_DIRECTORY = join(ROOT_DIRECTORY, "native", "sliver-console");

const ARMORY_PUBLIC_KEY = "RWSBpxpRWDrD7Fe+VvRE3c2VEDC2NK80rlNCj+BX0gz44Xw07r6KQD9L";
const ARMORY_REPOSITORY = "https://api.github.com/repos/sliverarmory/armory/releases";
const SLIVER_PUBLIC_KEY = "RWTZPg959v3b7tLG7VzKHRB1/QT+d3c71Uzetfa44qAoX5rH7mGoQTTR";
const CLIENT_ASSETS_PACKAGE = "github.com/bishopfox/sliver/client/assets";
const UPDATE_PACKAGE = "github.com/bishopfox/sliver/client/command/update";
export const SLIVER_CLIENT_LINKER_DEFAULTS = Object.freeze({
  sliverPublicKey: SLIVER_PUBLIC_KEY,
  armoryPublicKey: ARMORY_PUBLIC_KEY,
  armoryRepoUrl: ARMORY_REPOSITORY,
});
const GO_ENVIRONMENT_PASSTHROUGH = [
  "APPDATA",
  "COMSPEC",
  "GOCACHE",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
];
const SOURCE_OVERLAY_FORMAT = "go-build-overlay-v1";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function targetForHost(platform) {
  switch (platform) {
    case "darwin":
      return "darwin-universal";
    case "linux":
      return "linux-amd64";
    case "win32":
      return "windows-amd64";
    default:
      throw new Error(`Sliver console packaging does not support host platform ${platform}`);
  }
}

export function targetSlices(target) {
  switch (target) {
    case "darwin-universal":
      return [
        { goos: "darwin", goarch: "amd64" },
        { goos: "darwin", goarch: "arm64" },
      ];
    case "linux-amd64":
      return [{ goos: "linux", goarch: "amd64" }];
    case "windows-amd64":
      return [{ goos: "windows", goarch: "amd64" }];
    default:
      throw new Error(`Unsupported Sliver console target ${target}`);
  }
}

export function goBuildArguments(outputPath, overlayPath) {
  validateMinisignPublicKey(ARMORY_PUBLIC_KEY, "Armory public key");
  validateMinisignPublicKey(SLIVER_PUBLIC_KEY, "Sliver update public key");
  if (typeof overlayPath !== "string" || !isAbsolute(overlayPath)) {
    throw new Error("The Sliver console build requires an absolute verified Go overlay path");
  }
  const linkerFlags = [
    "-s",
    "-w",
    `-X ${UPDATE_PACKAGE}.SliverPublicKey=${SLIVER_PUBLIC_KEY}`,
    `-X ${CLIENT_ASSETS_PACKAGE}.DefaultArmoryPublicKey=${ARMORY_PUBLIC_KEY}`,
    `-X ${CLIENT_ASSETS_PACKAGE}.DefaultArmoryRepoURL=${ARMORY_REPOSITORY}`,
  ].join(" ");
  return [
    "build",
    "-mod=vendor",
    "-trimpath",
    "-overlay",
    overlayPath,
    "-tags",
    "go_sqlite,client",
    "-ldflags",
    linkerFlags,
    "-o",
    outputPath,
    "./client",
  ];
}

export function validateMinisignPublicKey(value, label = "Minisign public key") {
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/u, "");
  if (value.length !== 56 || decoded.byteLength !== 42 || canonical !== value) {
    throw new Error(`${label} is not a canonical 42-byte Minisign public key`);
  }
  return value;
}

export function validatePinnedClientLinkerDefaults(makefile) {
  const expected = new Map([
    ["SLIVER_PUBLIC_KEY", SLIVER_PUBLIC_KEY],
    ["ARMORY_PUBLIC_KEY", ARMORY_PUBLIC_KEY],
    ["ARMORY_REPO_URL", ARMORY_REPOSITORY],
  ]);
  for (const [name, expectedValue] of expected) {
    const match = makefile.match(new RegExp(`^${name}\\s*\\?=\\s*(\\S+)\\s*$`, "mu"));
    const actualValue = match?.[1];
    if (actualValue !== expectedValue) {
      throw new Error(`Sliver Makefile ${name} is ${actualValue ?? "missing"}, expected ${expectedValue}`);
    }
  }
}

export function hermeticGoEnvironment(baseEnvironment = process.env, slice = {}) {
  const environment = {};
  for (const name of GO_ENVIRONMENT_PASSTHROUGH) {
    const entry = Object.entries(baseEnvironment).find(([candidate]) => candidate.toUpperCase() === name);
    if (entry && entry[1] !== undefined) environment[name] = entry[1];
  }
  return {
    ...environment,
    CGO_ENABLED: "0",
    GOENV: "off",
    GOFLAGS: "",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    ...(slice.goarch ? { GOARCH: slice.goarch } : {}),
    ...(slice.goos ? { GOOS: slice.goos } : {}),
  };
}

export function validateGoBuildInfo(output, { sourceManifest, slice }) {
  let commandPackage;
  let modulePath;
  const settings = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split("\t");
    if (fields[0] === "path") commandPackage = fields[1];
    if (fields[0] === "mod") modulePath = fields[1];
    if (fields[0] === "build") {
      const separator = fields[1]?.indexOf("=") ?? -1;
      if (separator > 0) settings.set(fields[1].slice(0, separator), fields[1].slice(separator + 1));
    }
  }

  const expected = new Map([
    ["-tags", sourceManifest.build.tags.join(",")],
    ["-trimpath", "true"],
    ["CGO_ENABLED", "0"],
    ["GOARCH", slice.goarch],
    ["GOOS", slice.goos],
    ["vcs", "git"],
    ["vcs.modified", "false"],
    ["vcs.revision", sourceManifest.source.commit],
  ]);
  if (commandPackage !== sourceManifest.source.commandPackage) {
    throw new Error(`Sliver console build path is ${commandPackage ?? "missing"}, expected ${sourceManifest.source.commandPackage}`);
  }
  if (modulePath !== sourceManifest.source.module) {
    throw new Error(`Sliver console module is ${modulePath ?? "missing"}, expected ${sourceManifest.source.module}`);
  }
  for (const [name, value] of expected) {
    if (settings.get(name) !== value) {
      throw new Error(`Sliver console build setting ${name} is ${settings.get(name) ?? "missing"}, expected ${value}`);
    }
  }
  return {
    commandPackage,
    module: modulePath,
    vcsRevision: settings.get("vcs.revision"),
    vcsModified: false,
  };
}

export async function verifyPinnedCheckout({ sourceDirectory, sourceManifest, run = runCommand }) {
  const root = (await run("git", ["rev-parse", "--show-toplevel"], { cwd: sourceDirectory })).trim();
  if (resolve(root) !== resolve(sourceDirectory)) {
    throw new Error(`SLIVER_SOURCE_DIR must name the Sliver repository root; found ${root}`);
  }

  const [commit, tree, statusOutput] = await Promise.all([
    run("git", ["rev-parse", "HEAD"], { cwd: sourceDirectory }),
    run("git", ["rev-parse", "HEAD^{tree}"], { cwd: sourceDirectory }),
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceDirectory }),
  ]);
  if (commit.trim() !== sourceManifest.source.commit) {
    throw new Error(`Sliver checkout is at ${commit.trim()}, expected ${sourceManifest.source.commit}`);
  }
  if (tree.trim() !== sourceManifest.source.tree) {
    throw new Error(`Sliver source tree is ${tree.trim()}, expected ${sourceManifest.source.tree}`);
  }
  if (statusOutput.trim() !== "") {
    throw new Error(`Sliver checkout must be clean before packaging:\n${statusOutput.trimEnd()}`);
  }
}

export async function verifySourceOverlay({
  sourceDirectory,
  sourceManifest,
  repositoryDirectory = ROOT_DIRECTORY,
}) {
  const verified = await verifySourceOverlayReplacements({ sourceManifest, repositoryDirectory });
  const replacements = {};
  for (const entry of verified.record.files) {
    const sourcePath = resolveContainedPath(sourceDirectory, entry.sourcePath, "source overlay target");
    const baseContent = await readFile(sourcePath);
    if (sha256(baseContent) !== entry.baseSha256) {
      throw new Error(`Sliver source overlay base hash drifted for ${entry.sourcePath}`);
    }
    replacements[sourcePath] = verified.replacementPaths[entry.sourcePath];
  }
  return { record: verified.record, replacements };
}

export async function verifySourceOverlayReplacements({
  sourceManifest,
  repositoryDirectory = ROOT_DIRECTORY,
}) {
  const overlay = sourceManifest.build?.overlay;
  if (overlay?.format !== SOURCE_OVERLAY_FORMAT || !Array.isArray(overlay.files) || overlay.files.length === 0) {
    throw new Error(`Sliver console source provenance requires a nonempty ${SOURCE_OVERLAY_FORMAT} overlay`);
  }
  const correspondingSource = overlay.correspondingSource;
  if (
    correspondingSource?.repository !== "https://github.com/sliverarmory/sliver-gui" ||
    typeof correspondingSource?.packageVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/u.test(correspondingSource.packageVersion) ||
    correspondingSource?.tag !== `v${correspondingSource.packageVersion}` ||
    correspondingSource?.archive !==
      `https://github.com/sliverarmory/sliver-gui/archive/refs/tags/v${correspondingSource.packageVersion}.tar.gz` ||
    Object.keys(correspondingSource).length !== 4
  ) {
    throw new Error("Sliver console source overlay lacks matching-release corresponding source metadata");
  }

  const files = [];
  const replacementPathsBySourcePath = {};
  const sourcePaths = new Set();
  const replacementPaths = new Set();
  for (const entry of overlay.files) {
    if (
      typeof entry?.sourcePath !== "string" ||
      typeof entry?.replacementPath !== "string" ||
      typeof entry?.baseSha256 !== "string" ||
      typeof entry?.sha256 !== "string" ||
      typeof entry?.review !== "string" ||
      entry.review.trim() === "" ||
      !SHA256_PATTERN.test(entry.baseSha256) ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error("Sliver console source overlay metadata is invalid");
    }
    if (sourcePaths.has(entry.sourcePath) || replacementPaths.has(entry.replacementPath)) {
      throw new Error("Sliver console source overlay contains a duplicate path");
    }
    sourcePaths.add(entry.sourcePath);
    replacementPaths.add(entry.replacementPath);

    resolveContainedPath(repositoryDirectory, entry.sourcePath, "source overlay target");
    const replacementPath = resolveContainedPath(
      repositoryDirectory,
      entry.replacementPath,
      "source overlay replacement",
    );
    const replacementContent = await readFile(replacementPath);
    if (sha256(replacementContent) !== entry.sha256) {
      throw new Error(`Sliver source overlay replacement hash drifted for ${entry.replacementPath}`);
    }
    replacementPathsBySourcePath[entry.sourcePath] = replacementPath;
    files.push({
      sourcePath: entry.sourcePath,
      replacementPath: entry.replacementPath,
      baseSha256: entry.baseSha256,
      sha256: entry.sha256,
      review: entry.review,
    });
  }

  return {
    record: {
      format: SOURCE_OVERLAY_FORMAT,
      correspondingSource: {
        repository: correspondingSource.repository,
        packageVersion: correspondingSource.packageVersion,
        tag: correspondingSource.tag,
        archive: correspondingSource.archive,
      },
      files,
    },
    replacementPaths: replacementPathsBySourcePath,
  };
}

/**
 * Verifies the exact corresponding-source files copied beside a packaged
 * Sliver console. Both provenance records are required so a packaged source
 * tree cannot be checked against only one side of the build contract.
 */
export async function verifyPackagedSourceOverlayFiles({
  packagedDirectory,
  sourceOverlay,
  buildOverlay,
}) {
  if (
    JSON.stringify(buildOverlay) !== JSON.stringify(sourceOverlay) ||
    sourceOverlay?.format !== SOURCE_OVERLAY_FORMAT ||
    !Array.isArray(sourceOverlay.files) ||
    sourceOverlay.files.length === 0
  ) {
    throw new Error("Packaged Sliver console source overlay provenance does not match its build evidence");
  }

  const overlayRoot = join(packagedDirectory, "source-overlay");
  let overlayRootStats;
  try {
    overlayRootStats = await lstat(overlayRoot);
  } catch {
    throw new Error("Packaged Sliver console is missing its source overlay directory");
  }
  if (!overlayRootStats.isDirectory() || overlayRootStats.isSymbolicLink()) {
    throw new Error("Packaged Sliver console source overlay root must be a regular directory");
  }
  const canonicalOverlayRoot = await realpath(overlayRoot);

  for (const entry of sourceOverlay.files) {
    if (
      typeof entry?.sourcePath !== "string" ||
      typeof entry?.replacementPath !== "string" ||
      typeof entry?.sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.sha256)
    ) {
      throw new Error("Packaged Sliver console source overlay metadata is invalid");
    }
    const sourcePath = resolveContainedPath(overlayRoot, entry.sourcePath, "packaged source overlay");
    if (entry.replacementPath !== `protocol/sliver-console-overlay/${entry.sourcePath}`) {
      throw new Error(`Packaged Sliver console has an invalid source overlay mapping: ${entry.replacementPath}`);
    }

    let sourceStats;
    try {
      sourceStats = await lstat(sourcePath);
    } catch {
      throw new Error(`Packaged Sliver console is missing source overlay file: ${entry.sourcePath}`);
    }
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error(`Packaged Sliver console source overlay is not a regular file: ${entry.sourcePath}`);
    }
    const canonicalSourcePath = await realpath(sourcePath);
    if (!canonicalSourcePath.startsWith(`${canonicalOverlayRoot}${sep}`)) {
      throw new Error(`Packaged Sliver console source overlay escapes its package root: ${entry.sourcePath}`);
    }
    const content = await readFile(canonicalSourcePath);
    if (sha256(content) !== entry.sha256) {
      throw new Error(`Packaged Sliver console source overlay digest changed: ${entry.sourcePath}`);
    }
  }
}

export async function buildSliverConsole({
  platform = process.platform,
  sourceDirectory,
  outputDirectory = OUTPUT_DIRECTORY,
  goBinary,
  environment = process.env,
  repositoryDirectory = ROOT_DIRECTORY,
  run = runCommand,
  sourceManifest: suppliedSourceManifest,
} = {}) {
  sourceDirectory ??= environment.SLIVER_SOURCE_DIR ?? join(ROOT_DIRECTORY, "sliver");
  goBinary ??= environment.SLIVER_GO_BINARY ?? "go";
  const sourceManifest = suppliedSourceManifest ?? JSON.parse(await readFile(SOURCE_MANIFEST_PATH, "utf8"));
  await verifyPinnedCheckout({ sourceDirectory, sourceManifest, run });
  const sourceOverlay = await verifySourceOverlay({ sourceDirectory, sourceManifest, repositoryDirectory });
  const packageManifest = JSON.parse(await readFile(join(repositoryDirectory, "package.json"), "utf8"));
  if (packageManifest.version !== sourceOverlay.record.correspondingSource.packageVersion) {
    throw new Error("Sliver console overlay corresponding source does not match the application package version");
  }
  validatePinnedClientLinkerDefaults(await readFile(join(sourceDirectory, "Makefile"), "utf8"));

  const baseGoEnvironment = hermeticGoEnvironment(environment);
  const goVersion = (await run(goBinary, ["env", "GOVERSION"], {
    cwd: sourceDirectory,
    env: baseGoEnvironment,
  })).trim();
  if (goVersion !== sourceManifest.toolchain.go) {
    throw new Error(`Sliver console requires ${sourceManifest.toolchain.go}; found ${goVersion}`);
  }

  const target = environment.SLIVER_CONSOLE_TARGET ?? targetForHost(platform);
  const slices = targetSlices(target);
  if (target === "darwin-universal" && platform !== "darwin") {
    throw new Error("The universal macOS console must be assembled on macOS with lipo");
  }

  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  await Promise.all([
    unlink(join(outputDirectory, "sliver-client")).catch(ignoreMissing),
    unlink(join(outputDirectory, "sliver-client.exe")).catch(ignoreMissing),
    unlink(join(outputDirectory, "provenance.json")).catch(ignoreMissing),
    unlink(join(outputDirectory, "LICENSE")).catch(ignoreMissing),
  ]);
  const sourceLicense = await readFile(join(sourceDirectory, sourceManifest.source.licenseFile));
  if (sha256(sourceLicense) !== sourceManifest.source.licenseSha256) {
    throw new Error("Sliver console source license does not match the pinned provenance");
  }
  await writeFile(join(outputDirectory, "LICENSE"), sourceLicense, { mode: 0o644 });

  const stagingDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-console-build-"));
  const sliceRecords = [];
  try {
    const overlayPath = join(stagingDirectory, "go-overlay.json");
    await writeFile(
      overlayPath,
      `${JSON.stringify({ Replace: sourceOverlay.replacements }, null, 2)}\n`,
      { mode: 0o600 },
    );
    for (const slice of slices) {
      const slicePath = join(stagingDirectory, `sliver-client-${slice.goos}-${slice.goarch}${slice.goos === "windows" ? ".exe" : ""}`);
      const args = goBuildArguments(slicePath, overlayPath);
      const sliceEnvironment = hermeticGoEnvironment(environment, slice);
      await run(goBinary, args, {
        cwd: sourceDirectory,
        env: sliceEnvironment,
      });
      const buildInfo = validateGoBuildInfo(
        await run(goBinary, ["version", "-m", slicePath], { cwd: sourceDirectory, env: sliceEnvironment }),
        { sourceManifest, slice },
      );
      const bytes = await readFile(slicePath);
      sliceRecords.push({
        ...slice,
        buildInfo,
        sha256: sha256(bytes),
        size: bytes.byteLength,
        path: slicePath,
      });
    }

    const executableName = target === "windows-amd64" ? "sliver-client.exe" : "sliver-client";
    const finalStagingPath = join(stagingDirectory, executableName);
    if (target === "darwin-universal") {
      await run("/usr/bin/lipo", ["-create", ...sliceRecords.map(({ path }) => path), "-output", finalStagingPath], {
        cwd: sourceDirectory,
      });
    } else {
      await rename(sliceRecords[0].path, finalStagingPath);
    }
    if (target !== "windows-amd64") await chmod(finalStagingPath, 0o755);

    const finalBytes = await readFile(finalStagingPath);
    const finalPath = join(outputDirectory, executableName);
    const finalTemporaryPath = join(outputDirectory, `.${executableName}.${process.pid}.tmp`);
    await writeFile(finalTemporaryPath, finalBytes, { mode: target === "windows-amd64" ? 0o644 : 0o755 });
    await rename(finalTemporaryPath, finalPath);
    if (target !== "windows-amd64") await chmod(finalPath, 0o755);

    const record = {
      schemaVersion: 1,
      source: sourceManifest.source,
      toolchain: { go: goVersion },
      build: {
        target,
        cgoEnabled: false,
        trimpath: true,
        moduleMode: "vendor",
        tags: sourceManifest.build.tags,
        overlay: sourceOverlay.record,
        linkerDefaults: SLIVER_CLIENT_LINKER_DEFAULTS,
        slices: sliceRecords.map(({ goos, goarch, buildInfo, sha256: digest, size }) => ({
          goos,
          goarch,
          buildInfo,
          sha256: digest,
          size,
        })),
      },
      artifact: {
        fileName: executableName,
        sha256: sha256(finalBytes),
        size: finalBytes.byteLength,
      },
    };
    await writeJsonAtomic(join(outputDirectory, "provenance.json"), record);
    console.log(`Built ${finalPath} from Sliver ${sourceManifest.source.commit} with ${goVersion}`);
    return { finalPath, record };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(temporaryPath, filePath);
}

async function runCommand(command, args, options) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        accept(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${detail ? `: ${detail}` : ""}`));
    });
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function resolveContainedPath(rootDirectory, relativePath, label) {
  if (
    relativePath === "" ||
    relativePath.includes("\\") ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath) ||
    relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Sliver console ${label} escapes its trusted root or is invalid: ${relativePath}`);
  }
  const root = resolve(rootDirectory);
  const candidate = resolve(root, relativePath);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`Sliver console ${label} escapes its trusted root: ${relativePath}`);
  }
  return candidate;
}

function ignoreMissing(error) {
  if (error && typeof error === "object" && error.code === "ENOENT") return;
  throw error;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await buildSliverConsole();
}
