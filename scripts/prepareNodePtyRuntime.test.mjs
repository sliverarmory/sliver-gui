import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import afterPack, { verifySliverConsoleBeforeSigning } from "./afterPack.mjs";
import {
  packagedRuntimeFilesForPlatform,
  prepareNodePtyRuntime,
} from "./prepareNodePtyRuntime.mjs";
import stageNodePtyBeforePack, { stageNodePtyRuntimeForElectron } from "./stageNodePtyForElectron.mjs";

// Keep the fixture inventory independent of the implementation: accidentally
// dropping a required DLL or helper must not silently drop it from the tests.
const RUNTIME_FILES = {
  darwin: [
    "prebuilds/darwin-arm64/pty.node",
    "prebuilds/darwin-arm64/spawn-helper",
    "prebuilds/darwin-x64/pty.node",
    "prebuilds/darwin-x64/spawn-helper",
  ],
  linux: ["build/Release/pty.node"],
  win32: [
    "prebuilds/win32-x64/conpty.node",
    "prebuilds/win32-x64/conpty_console_list.node",
    "prebuilds/win32-x64/pty.node",
    "prebuilds/win32-x64/conpty/OpenConsole.exe",
    "prebuilds/win32-x64/conpty/conpty.dll",
    "prebuilds/win32-x64/winpty-agent.exe",
    "prebuilds/win32-x64/winpty.dll",
  ],
};

async function fixture(platform, { packaged = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "node-pty-runtime-test-"));
  const required = packaged
    ? [...new Set(RUNTIME_FILES[platform].map((path) => path.replace(/^prebuilds\/[^/]+\//u, "build/Release/")))]
    : RUNTIME_FILES[platform];
  const files = { required, helpers: required.filter((path) => path.endsWith("/spawn-helper")) };
  for (const relativePath of files.required) {
    const filePath = join(directory, ...relativePath.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, relativePath, { mode: 0o644 });
  }
  return { directory, files };
}

test("prepares both universal macOS spawn helpers", async () => {
  const { directory, files } = await fixture("darwin");
  try {
    await prepareNodePtyRuntime({ platform: "darwin", moduleDirectory: directory });
    for (const relativePath of files.helpers) {
      assert.equal((await stat(join(directory, ...relativePath.split("/")))).mode & 0o777, 0o755);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("accepts the Linux runtime without the macOS-only spawn helper", async () => {
  const { directory, files } = await fixture("linux");
  try {
    await prepareNodePtyRuntime({ platform: "linux", moduleDirectory: directory });
    await prepareNodePtyRuntime({ platform: "linux", moduleDirectory: directory, packaged: true });
    assert.deepEqual(files, {
      required: ["build/Release/pty.node"],
      helpers: [],
    });
    assert.deepEqual(packagedRuntimeFilesForPlatform("linux"), files);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages only the requested macOS prebuild for Electron packaging", async () => {
  const { directory } = await fixture("darwin");
  try {
    const stalePath = join(directory, "build", "Release", "stale.node");
    await mkdir(dirname(stalePath), { recursive: true });
    await writeFile(stalePath, "stale");

    await stageNodePtyRuntimeForElectron({
      arch: "x64",
      moduleDirectory: directory,
      platform: "darwin",
    });

    await assert.rejects(stat(stalePath), { code: "ENOENT" });
    for (const relativePath of packagedRuntimeFilesForPlatform("darwin").required) {
      const sourcePath = relativePath.replace("build/Release/", "prebuilds/darwin-x64/");
      assert.equal(
        await readFile(join(directory, ...relativePath.split("/")), "utf8"),
        sourcePath,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages the exact Windows runtime without debug artifacts", async () => {
  const { directory } = await fixture("win32");
  try {
    const debugArtifact = join(directory, "prebuilds", "win32-x64", "pty.pdb");
    await writeFile(debugArtifact, "debug-only");

    await stageNodePtyRuntimeForElectron({
      arch: "x64",
      moduleDirectory: directory,
      platform: "win32",
    });

    await assert.rejects(stat(join(directory, "build", "Release", "pty.pdb")), { code: "ENOENT" });
    for (const relativePath of packagedRuntimeFilesForPlatform("win32").required) {
      const sourcePath = relativePath.replace("build/Release/", "prebuilds/win32-x64/");
      assert.equal(
        await readFile(join(directory, ...relativePath.split("/")), "utf8"),
        sourcePath,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("maps Electron Builder architectures to the exact node-pty module directory", async () => {
  const calls = [];
  await stageNodePtyBeforePack({
    arch: 3,
    electronPlatformName: "darwin",
    packager: { info: { appDir: "/workspace/app" } },
  }, {
    stageNodePtyRuntimeForElectron: async (options) => calls.push(options),
  });
  assert.deepEqual(calls, [{
    arch: "arm64",
    moduleDirectory: join("/workspace/app", "node_modules", "node-pty"),
    platform: "darwin",
  }]);
});

test("rejects each missing, empty, or non-file runtime dependency before packaging", async (context) => {
  for (const platform of Object.keys(RUNTIME_FILES)) {
    for (const packaged of [false, true]) {
      await context.test(`${platform} ${packaged ? "packaged" : "installed"} runtime`, async () => {
        const { directory, files } = await fixture(platform, { packaged });
        try {
          const options = { platform, moduleDirectory: directory, packaged };
          assert.deepEqual(await prepareNodePtyRuntime(options), files);
          for (const relativePath of files.required) {
            const filePath = join(directory, ...relativePath.split("/"));
            await rm(filePath);
            await assert.rejects(prepareNodePtyRuntime(options), {
              message: `node-pty is missing required ${platform} runtime file ${relativePath}`,
            });
            await writeFile(filePath, "");
            await assert.rejects(prepareNodePtyRuntime(options), {
              message: `node-pty runtime file is invalid: ${relativePath}`,
            });
            await rm(filePath);
            await mkdir(filePath);
            await assert.rejects(prepareNodePtyRuntime(options), {
              message: `node-pty runtime file is invalid: ${relativePath}`,
            });
            await rm(filePath, { recursive: true });
            await writeFile(filePath, relativePath);
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  }
});

test("afterPack prepares the exact unpacked runtime before signing", async () => {
  const appOutDir = await mkdtemp(join(tmpdir(), "node-pty-after-pack-test-"));
  const moduleDirectory = join(
    appOutDir,
    "Sliver GUI.app",
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  const files = packagedRuntimeFilesForPlatform("darwin");
  for (const relativePath of files.required) {
    const filePath = join(moduleDirectory, ...relativePath.split("/"));
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, relativePath, { mode: 0o644 });
  }
  try {
    let verifiedResourcesDirectory;
    await afterPack(
      { electronPlatformName: "darwin", appOutDir },
      {
        verifySliverConsoleBeforeSigning: async ({ resourcesDirectory }) => {
          verifiedResourcesDirectory = resourcesDirectory;
        },
      },
    );
    assert.equal(verifiedResourcesDirectory, join(appOutDir, "Sliver GUI.app", "Contents", "Resources"));
    for (const relativePath of files.helpers) {
      assert.equal((await stat(join(moduleDirectory, ...relativePath.split("/")))).mode & 0o777, 0o755);
    }
  } finally {
    await rm(appOutDir, { recursive: true, force: true });
  }
});

test("afterPack rejects a changed Sliver console before signing", async () => {
  const projectDirectory = await mkdtemp(join(tmpdir(), "sliver-console-after-pack-test-"));
  const sourceDirectory = join(projectDirectory, "native", "sliver-console");
  const packagedDirectory = join(projectDirectory, "packaged", "sliver-console");
  const executable = Buffer.from("pinned-sliver-client");
  const overlaySourcePath = "client/cli/config.go";
  const overlayReplacementPath = `protocol/sliver-console-overlay/${overlaySourcePath}`;
  const overlaySource = Buffer.from("package cli\n\n// Reviewed source overlay.\n");
  const overlay = {
    format: "go-build-overlay-v1",
    files: [{
      sourcePath: overlaySourcePath,
      replacementPath: overlayReplacementPath,
      baseSha256: "a".repeat(64),
      sha256: createHash("sha256").update(overlaySource).digest("hex"),
      review: "Test source overlay",
    }],
  };
  const sourceManifest = `${JSON.stringify({ build: { overlay } })}\n`;
  const record = `${JSON.stringify({
    build: { overlay },
    artifact: {
      fileName: "sliver-client",
      sha256: createHash("sha256").update(executable).digest("hex"),
      size: executable.byteLength,
    },
  })}\n`;
  await Promise.all([
    mkdir(join(projectDirectory, "protocol", "sliver-console-overlay", "client", "cli"), { recursive: true }),
    mkdir(sourceDirectory, { recursive: true }),
    mkdir(join(packagedDirectory, "source-overlay", "client", "cli"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(projectDirectory, "protocol", "sliver-console-provenance.json"), sourceManifest),
    writeFile(join(projectDirectory, ...overlayReplacementPath.split("/")), overlaySource),
    writeFile(join(sourceDirectory, "provenance.json"), record),
    writeFile(join(sourceDirectory, "LICENSE"), "license\n"),
    writeFile(join(packagedDirectory, "source-provenance.json"), sourceManifest),
    writeFile(join(packagedDirectory, "source-overlay", ...overlaySourcePath.split("/")), overlaySource),
    writeFile(join(packagedDirectory, "provenance.json"), record),
    writeFile(join(packagedDirectory, "LICENSE"), "license\n"),
    writeFile(join(packagedDirectory, "sliver-client"), executable, { mode: 0o755 }),
  ]);
  try {
    await verifySliverConsoleBeforeSigning({
      platform: "linux",
      projectDirectory,
      resourcesDirectory: join(projectDirectory, "packaged"),
    });
    const architectureChecks = [];
    await verifySliverConsoleBeforeSigning({
      platform: "darwin",
      projectDirectory,
      resourcesDirectory: join(projectDirectory, "packaged"),
      run: async (command, args) => {
        assert.equal(command, "/usr/bin/lipo");
        assert.equal(args.length, 3, "each lipo invocation must verify exactly one required architecture");
        architectureChecks.push(args);
      },
    });
    assert.deepEqual(architectureChecks, [
      [join(packagedDirectory, "sliver-client"), "-verify_arch", "x86_64"],
      [join(packagedDirectory, "sliver-client"), "-verify_arch", "arm64"],
    ]);
    await assert.rejects(verifySliverConsoleBeforeSigning({
      platform: "darwin",
      projectDirectory,
      resourcesDirectory: join(projectDirectory, "packaged"),
      run: async (_command, args) => {
        if (args.at(-1) === "arm64") throw new Error("Required arm64 slice is missing");
      },
    }), /Required arm64 slice is missing/u);
    const packagedOverlayPath = join(packagedDirectory, "source-overlay", ...overlaySourcePath.split("/"));
    await writeFile(packagedOverlayPath, "changed source overlay\n");
    await assert.rejects(
      verifySliverConsoleBeforeSigning({
        platform: "linux",
        projectDirectory,
        resourcesDirectory: join(projectDirectory, "packaged"),
      }),
      /source overlay changed before signing/u,
    );
    await writeFile(packagedOverlayPath, overlaySource);
    await writeFile(join(packagedDirectory, "sliver-client"), "changed", { mode: 0o755 });
    await assert.rejects(
      verifySliverConsoleBeforeSigning({
        platform: "linux",
        projectDirectory,
        resourcesDirectory: join(projectDirectory, "packaged"),
      }),
      /changed before signing/u,
    );
  } finally {
    await rm(projectDirectory, { recursive: true, force: true });
  }
});
