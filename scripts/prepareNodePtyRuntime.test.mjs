import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import afterPack, { verifySliverConsoleBeforeSigning } from "./afterPack.mjs";
import {
  packagedRuntimeFilesForPlatform,
  prepareNodePtyRuntime,
  runtimeFilesForPlatform,
} from "./prepareNodePtyRuntime.mjs";

async function fixture(platform, omittedPath) {
  const directory = await mkdtemp(join(tmpdir(), "node-pty-runtime-test-"));
  const files = runtimeFilesForPlatform(platform);
  for (const relativePath of files.required) {
    if (relativePath === omittedPath) continue;
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

test("validates Windows x64 runtime inventory without POSIX chmod", async () => {
  const { directory } = await fixture("win32");
  try {
    const files = await prepareNodePtyRuntime({ platform: "win32", moduleDirectory: directory });
    assert.deepEqual(files.helpers, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when a current-platform runtime file is absent", async () => {
  const missing = "prebuilds/darwin-arm64/pty.node";
  const { directory } = await fixture("darwin", missing);
  try {
    await assert.rejects(
      prepareNodePtyRuntime({ platform: "darwin", moduleDirectory: directory }),
      new RegExp(missing.replace(".", "\\."), "u"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
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
