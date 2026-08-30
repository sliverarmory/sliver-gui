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
  const [sourceManifest, sourceRecordContent, packagedManifest, packagedRecordContent, sourceLicense, packagedLicense] =
    await Promise.all([
      readFile(join(projectDirectory, "protocol", "sliver-console-provenance.json"), "utf8"),
      readFile(join(sourceDirectory, "provenance.json"), "utf8"),
      readFile(join(packagedDirectory, "source-provenance.json"), "utf8"),
      readFile(join(packagedDirectory, "provenance.json"), "utf8"),
      readFile(join(sourceDirectory, "LICENSE")),
      readFile(join(packagedDirectory, "LICENSE")),
    ]);
  if (sourceManifest !== packagedManifest || sourceRecordContent !== packagedRecordContent) {
    throw new Error(`Packaged Sliver console provenance changed before signing: ${packagedDirectory}`);
  }
  if (!sourceLicense.equals(packagedLicense)) {
    throw new Error(`Packaged Sliver console license changed before signing: ${packagedDirectory}`);
  }

  const record = JSON.parse(sourceRecordContent);
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
