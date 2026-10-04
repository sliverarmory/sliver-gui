import { createHash } from "node:crypto";
import { mkdtemp, mkdir, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_BOF_LOADER_BYTES, packLegacyBofArguments, readInstalledBofLoader } from "./bof-legacy-dispatch.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function installedLoader(options: {
  dependencyName?: string;
  artifactPath?: string;
  entrypoint?: string;
  init?: string;
  writeArtifact?: boolean;
} = {}): Promise<{ root: string; directory: string; artifact: string }> {
  const root = await mkdtemp(join(tmpdir(), "sliver-bof-loader-test-"));
  roots.push(root);
  const dependencyName = options.dependencyName ?? "coff-loader";
  const directory = join(root, "extensions", "coff-loader");
  const artifact = join(directory, "dist", "COFFLoader.x64.dll");
  await mkdir(join(directory, "dist"), { recursive: true });
  if (options.writeArtifact !== false) await writeFile(artifact, Buffer.from([0x4d, 0x5a, 1, 2]));
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    name: "COFF Loader",
    command_name: dependencyName,
    version: "1.0.0",
    help: "Load BOFs",
    entrypoint: options.entrypoint ?? "LoadAndRun",
    init: options.init ?? "InitLoader",
    files: [
      { os: "windows", arch: "386", path: "dist/COFFLoader.x86.dll" },
      { os: "windows", arch: "amd64", path: options.artifactPath ?? "dist/COFFLoader.x64.dll" },
      { os: "linux", arch: "amd64", path: "dist/libcoff.so" },
    ],
  }));
  return { root, directory, artifact };
}

describe("legacy Armory BOF loader", () => {
  it("selects the exact target DLL and returns its hash, export, init, and owned bytes", async () => {
    const { root } = await installedLoader();
    const loader = await readInstalledBofLoader(root, "coff-loader", { os: "windows", arch: "x64" });
    expect(loader).toEqual({
      name: createHash("sha256").update(Buffer.from([0x4d, 0x5a, 1, 2])).digest("hex"),
      data: Buffer.from([0x4d, 0x5a, 1, 2]),
      exportName: "LoadAndRun",
      init: "InitLoader",
    });
    loader.data.fill(0);
  });

  it("rejects mismatched loader manifests and missing target artifacts", async () => {
    const mismatched = await installedLoader({ dependencyName: "different-command" });
    await expect(readInstalledBofLoader(mismatched.root, "coff-loader", { os: "windows", arch: "amd64" }))
      .rejects.toThrow(/does not match its package/u);
    const noTarget = await installedLoader();
    await expect(readInstalledBofLoader(noTarget.root, "coff-loader", { os: "darwin", arch: "arm64" }))
      .rejects.toThrow(/No Armory loader matches/u);
    const wrongExtension = await installedLoader({ artifactPath: "dist/not-a-loader.bin" });
    await expect(readInstalledBofLoader(wrongExtension.root, "coff-loader", { os: "windows", arch: "amd64" }))
      .rejects.toThrow(/not a native extension/u);
  });

  it("rejects linked loader artifacts and linked intermediate directories", async () => {
    const linkedArtifact = await installedLoader({ writeArtifact: false });
    const outside = join(linkedArtifact.root, "outside.dll");
    await writeFile(outside, Buffer.from([0x4d, 0x5a]));
    await symlink(outside, linkedArtifact.artifact);
    await expect(readInstalledBofLoader(linkedArtifact.root, "coff-loader", { os: "windows", arch: "amd64" }))
      .rejects.toThrow(/bounded regular file/u);

    const linkedDirectory = await installedLoader({ writeArtifact: false });
    const directory = join(linkedDirectory.root, "elsewhere");
    await mkdir(directory);
    await writeFile(join(directory, "COFFLoader.x64.dll"), Buffer.from([0x4d, 0x5a]));
    await rm(join(linkedDirectory.directory, "dist"), { recursive: true });
    await symlink(directory, join(linkedDirectory.directory, "dist"));
    await expect(readInstalledBofLoader(linkedDirectory.root, "coff-loader", { os: "windows", arch: "amd64" }))
      .rejects.toThrow(/not a regular directory/u);
  });

  it("rejects a loader that exceeds the bounded native artifact limit", async () => {
    const { root, artifact } = await installedLoader();
    const handle = await open(artifact, "r+");
    try { await handle.truncate(MAX_BOF_LOADER_BYTES + 1); }
    finally { await handle.close(); }
    await expect(readInstalledBofLoader(root, "coff-loader", { os: "windows", arch: "amd64" }))
      .rejects.toThrow(/bounded regular file/u);
  });

  it("packs the exact outer buffer accepted by Sliver's legacy getBOFArgs", () => {
    const object = Buffer.from([1, 2, 3]);
    const typedArgs = Buffer.from([4, 0, 0, 0, 0x41, 0, 0, 0]);
    const actual = packLegacyBofArguments("go", object, typedArgs);
    expect(actual.toString("hex")).toBe("1a00000003000000676f0003000000010203080000000400000041000000");
    expect(() => packLegacyBofArguments("go", object, Buffer.from([8, 0, 0, 0]))).toThrow(/Invalid packed BOF arguments/u);
    expect(() => packLegacyBofArguments("bad\0export", object, typedArgs)).toThrow(/Invalid BOF entrypoint/u);
  });
});
