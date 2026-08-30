import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareNodePtyRuntime } from "./prepareNodePtyRuntime.mjs";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default async function afterPack(context, dependencies = {}) {
  const prepareRuntime = dependencies.prepareNodePtyRuntime ?? prepareNodePtyRuntime;
  const verifySliverConsole = dependencies.verifySliverConsoleBeforeSigning ?? verifySliverConsoleBeforeSigning;
  const platform = context.electronPlatformName;
  let resourcesDirectory;
  if (platform === "darwin") {
    const applications = (await readdir(context.appOutDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
    if (applications.length !== 1) {
      throw new Error(`Expected one macOS application under ${context.appOutDir}; found ${applications.length}`);
    }
    resourcesDirectory = join(context.appOutDir, applications[0].name, "Contents", "Resources");
  } else {
    resourcesDirectory = join(context.appOutDir, "resources");
  }
  await prepareRuntime({
    platform,
    packaged: true,
    moduleDirectory: join(resourcesDirectory, "app.asar.unpacked", "node_modules", "node-pty"),
  });
  await verifySliverConsole({
    platform,
    projectDirectory: context.packager?.projectDir ?? rootDirectory,
    resourcesDirectory,
  });
}

export async function verifySliverConsoleBeforeSigning({
  platform,
  projectDirectory = rootDirectory,
  resourcesDirectory,
  run = runCommand,
}) {
  const sourceDirectory = join(projectDirectory, "native", "sliver-console");
  const packagedDirectory = join(resourcesDirectory, "sliver-console");
  const [sourceManifestContent, sourceRecordContent, packagedManifest, packagedRecordContent, sourceLicense, packagedLicense] =
    await Promise.all([
      readFile(join(projectDirectory, "protocol", "sliver-console-provenance.json"), "utf8"),
      readFile(join(sourceDirectory, "provenance.json"), "utf8"),
      readFile(join(packagedDirectory, "source-provenance.json"), "utf8"),
      readFile(join(packagedDirectory, "provenance.json"), "utf8"),
      readFile(join(sourceDirectory, "LICENSE")),
      readFile(join(packagedDirectory, "LICENSE")),
    ]);
  if (sourceManifestContent !== packagedManifest || sourceRecordContent !== packagedRecordContent) {
    throw new Error(`Packaged Sliver console provenance changed before signing: ${packagedDirectory}`);
  }
  if (!sourceLicense.equals(packagedLicense)) {
    throw new Error(`Packaged Sliver console license changed before signing: ${packagedDirectory}`);
  }

  const sourceManifest = JSON.parse(sourceManifestContent);
  const record = JSON.parse(sourceRecordContent);
  if (JSON.stringify(record.build?.overlay) !== JSON.stringify(sourceManifest.build?.overlay)) {
    throw new Error(`Packaged Sliver console overlay provenance changed before signing: ${packagedDirectory}`);
  }
  await verifyPackagedSourceOverlay(projectDirectory, packagedDirectory, sourceManifest);
  const executablePath = join(packagedDirectory, record.artifact.fileName);
  const [executable, metadata] = await Promise.all([readFile(executablePath), stat(executablePath)]);
  if (executable.byteLength !== record.artifact.size || sha256(executable) !== record.artifact.sha256) {
    throw new Error(`Packaged Sliver console executable changed before signing: ${executablePath}`);
  }
  if (platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`Packaged Sliver console executable is not executable: ${executablePath}`);
  }
  if (platform === "darwin") {
    await run("/usr/bin/lipo", [executablePath, "-verify_arch", "x86_64", "arm64"], {});
  }
}

async function verifyPackagedSourceOverlay(projectDirectory, packagedDirectory, sourceManifest) {
  const files = sourceManifest.build?.overlay?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Packaged Sliver console is missing its source overlay provenance");
  }
  for (const entry of files) {
    const sourcePath = safeOverlayPath(entry?.sourcePath);
    const replacementPath = safeOverlayPath(entry?.replacementPath);
    if (replacementPath !== `protocol/sliver-console-overlay/${sourcePath}`) {
      throw new Error(`Packaged Sliver console has an invalid source overlay mapping: ${replacementPath}`);
    }
    const [replacement, packagedReplacement] = await Promise.all([
      readFile(join(projectDirectory, ...replacementPath.split("/"))),
      readFile(join(packagedDirectory, "source-overlay", ...sourcePath.split("/"))),
    ]);
    if (!replacement.equals(packagedReplacement) || sha256(replacement) !== entry.sha256) {
      throw new Error(`Packaged Sliver console source overlay changed before signing: ${sourcePath}`);
    }
  }
}

function safeOverlayPath(value) {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Packaged Sliver console has an invalid source overlay path");
  }
  return value;
}

async function runCommand(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...options,
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return accept();
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${detail ? `: ${detail}` : ""}`));
    });
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}
