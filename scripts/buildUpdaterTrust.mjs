import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function buildUpdaterTrust({ projectDirectory = rootDirectory } = {}) {
  if (process.platform !== "darwin") throw new Error("The updater trust helper must be built on macOS.");
  const source = join(projectDirectory, "native", "updater-trust", "main.swift");
  const outputDirectory = join(projectDirectory, "native", "updater-trust", "build");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-updater-trust-"));
  await mkdir(outputDirectory, { recursive: true });
  try {
    const slices = [];
    for (const architecture of ["arm64", "x86_64"]) {
      const slice = join(temporaryDirectory, architecture);
      await execute("/usr/bin/xcrun", [
        // Electron's supported macOS baseline is Ventura; the repository's
        // acceptance matrix specifies 13.7.8 for both Intel and Apple Silicon.
        "swiftc", "-O", "-target", `${architecture}-apple-macosx13.0`,
        "-module-cache-path", join(temporaryDirectory, "module-cache"),
        "-framework", "AppKit", "-framework", "Security", "-framework", "SecurityInterface",
        source, "-o", slice,
      ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
      slices.push(slice);
    }
    const stagedOutput = join(temporaryDirectory, "updater-trust");
    await execute("/usr/bin/lipo", ["-create", ...slices, "-output", stagedOutput], { timeout: 30_000 });
    await chmod(stagedOutput, 0o755);
    const outputPath = join(outputDirectory, "updater-trust");
    await rename(stagedOutput, outputPath);
    return outputPath;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildUpdaterTrust();
}
