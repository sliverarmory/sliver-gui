import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Arch } from "electron-builder";

import { prepareNodePtyRuntime, runtimeFilesForPlatform } from "./prepareNodePtyRuntime.mjs";

const CONCRETE_ARCHITECTURES = new Set(["ia32", "x64", "armv7l", "arm64"]);

export default async function stageNodePtyBeforePack(context, dependencies = {}) {
  const stageRuntime = dependencies.stageNodePtyRuntimeForElectron ?? stageNodePtyRuntimeForElectron;
  const arch = Number.isInteger(context?.arch) ? Arch[context.arch] : undefined;
  const platform = context?.electronPlatformName;
  const appDirectory = context?.packager?.info?.appDir;
  if (!CONCRETE_ARCHITECTURES.has(arch) || typeof platform !== "string" || typeof appDirectory !== "string") {
    throw new Error("Electron Builder supplied an invalid node-pty staging context");
  }

  await stageRuntime({
    arch,
    moduleDirectory: join(appDirectory, "node_modules", "node-pty"),
    platform,
  });
}

export async function stageNodePtyRuntimeForElectron({
  arch,
  moduleDirectory,
  platform,
}) {
  if (platform === "linux") {
    await prepareNodePtyRuntime({ platform, moduleDirectory, packaged: true });
    return;
  }
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(`node-pty packaging does not support ${platform}`);
  }

  const sourcePrefix = `prebuilds/${platform}-${arch}/`;
  const sourceFiles = runtimeFilesForPlatform(platform).required
    .filter((relativePath) => relativePath.startsWith(sourcePrefix))
    .map((relativePath) => relativePath.slice(sourcePrefix.length));
  if (sourceFiles.length === 0) {
    throw new Error(`node-pty has no packaged ${platform}-${arch} runtime`);
  }

  await prepareNodePtyRuntime({ platform, moduleDirectory });
  const releaseDirectory = join(moduleDirectory, "build", "Release");
  await rm(releaseDirectory, { recursive: true, force: true });
  for (const relativePath of sourceFiles) {
    const destination = join(releaseDirectory, ...relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(
      join(moduleDirectory, ...sourcePrefix.split("/"), ...relativePath.split("/")),
      destination,
    );
  }
  await prepareNodePtyRuntime({ platform, moduleDirectory, packaged: true });
}
