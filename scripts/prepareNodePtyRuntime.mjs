import { chmod, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function runtimeFilesForPlatform(platform) {
  switch (platform) {
    case "darwin":
      return {
        required: [
          "prebuilds/darwin-arm64/pty.node",
          "prebuilds/darwin-arm64/spawn-helper",
          "prebuilds/darwin-x64/pty.node",
          "prebuilds/darwin-x64/spawn-helper",
        ],
        helpers: [
          "prebuilds/darwin-arm64/spawn-helper",
          "prebuilds/darwin-x64/spawn-helper",
        ],
      };
    case "linux":
      return {
        required: ["build/Release/pty.node", "build/Release/spawn-helper"],
        helpers: ["build/Release/spawn-helper"],
      };
    case "win32":
      return {
        required: [
          "prebuilds/win32-x64/conpty.node",
          "prebuilds/win32-x64/conpty_console_list.node",
          "prebuilds/win32-x64/pty.node",
          "prebuilds/win32-x64/winpty-agent.exe",
          "prebuilds/win32-x64/winpty.dll",
        ],
        helpers: [],
      };
    default:
      throw new Error(`node-pty packaging does not support ${platform}`);
  }
}

export function packagedRuntimeFilesForPlatform(platform) {
  switch (platform) {
    case "darwin":
    case "linux":
      return {
        required: ["build/Release/pty.node", "build/Release/spawn-helper"],
        helpers: ["build/Release/spawn-helper"],
      };
    case "win32":
      return {
        required: [
          "build/Release/conpty.node",
          "build/Release/conpty_console_list.node",
          "build/Release/pty.node",
          "build/Release/winpty-agent.exe",
          "build/Release/winpty.dll",
        ],
        helpers: [],
      };
    default:
      throw new Error(`node-pty packaging does not support ${platform}`);
  }
}

export async function prepareNodePtyRuntime({
  platform = process.platform,
  moduleDirectory = join(rootDirectory, "node_modules", "node-pty"),
  packaged = false,
} = {}) {
  const files = packaged ? packagedRuntimeFilesForPlatform(platform) : runtimeFilesForPlatform(platform);
  for (const relativePath of files.required) {
    const filePath = join(moduleDirectory, ...relativePath.split("/"));
    const metadata = await stat(filePath).catch((error) => {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw new Error(`node-pty is missing required ${platform} runtime file ${relativePath}`);
      }
      throw error;
    });
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`node-pty runtime file is invalid: ${relativePath}`);
    }
  }

  for (const relativePath of files.helpers) {
    const helperPath = join(moduleDirectory, ...relativePath.split("/"));
    await chmod(helperPath, 0o755);
    const metadata = await stat(helperPath);
    if ((metadata.mode & 0o111) !== 0o111) {
      throw new Error(`node-pty spawn helper is not executable: ${relativePath}`);
    }
  }
  return files;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  await prepareNodePtyRuntime();
  console.log(`Prepared node-pty ${process.platform} runtime`);
}
