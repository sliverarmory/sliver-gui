// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TargetSummary } from "../shared/target-contracts.js";
import { installedRustHound, isWindowsAmd64, readInstalledRustHound } from "./rusthound-armory.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const windows = { mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active" } as TargetSummary;

function dll(): Buffer {
  const data = Buffer.alloc(128);
  data.writeUInt16LE(0x5a4d, 0);
  data.writeUInt32LE(64, 0x3c);
  data.writeUInt32LE(0x00004550, 64);
  data.writeUInt16LE(0x8664, 68);
  data.writeUInt16LE(0x2000, 86);
  return data;
}

async function fixture(digest?: string): Promise<{ root: string; manifestPath: string; artifactPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "rusthound-armory-"));
  roots.push(root);
  const packagePath = join(root, "extensions", "rusthound-ce");
  const artifactDirectory = join(packagePath, "dist");
  await mkdir(artifactDirectory, { recursive: true });
  const artifactPath = join(artifactDirectory, "rusthound-ce-windows-amd64.dll");
  const bytes = dll();
  await writeFile(artifactPath, bytes);
  const manifestPath = join(packagePath, "extension.json");
  await writeFile(manifestPath, JSON.stringify({
    name: "RustHound CE", package_name: "rusthound-ce", command_name: "rusthound-ce",
    version: "v2.5.27", repo_url: "https://github.com/sliverarmory/RustHound-CE",
    help: "AD collection", entrypoint: "RustHoundCE",
    files: [{ os: "windows", arch: "amd64", path: "dist/rusthound-ce-windows-amd64.dll",
      sha256: digest ?? createHash("sha256").update(bytes).digest("hex") }],
  }));
  return { root, manifestPath, artifactPath };
}

describe("RustHound Armory artifact", () => {
  it("uses the same Windows x64 aliases for discovery and execution", () => {
    expect(["amd64", "x64", "x86_64"].every((arch) => isWindowsAmd64({ ...windows, arch }))).toBe(true);
    expect(isWindowsAmd64({ ...windows, arch: "386" })).toBe(false);
    expect(isWindowsAmd64({ ...windows, os: "linux" })).toBe(false);
  });

  it("locates only the fork's Windows x64 package and verifies its DLL bytes", async () => {
    const { root } = await fixture();
    const entry = await installedRustHound(root, windows);
    expect(entry?.version).toBe("v2.5.27");
    expect(await readInstalledRustHound(entry!)).toEqual(dll());
    expect(await installedRustHound(root, { ...windows, arch: "386" })).toBeNull();
  });

  it("rejects a changed DLL and manifest before it can be registered", async () => {
    const { root, manifestPath, artifactPath } = await fixture();
    const entry = (await installedRustHound(root, windows))!;
    const changed = dll(); changed[120] = 1;
    await writeFile(artifactPath, changed);
    await expect(readInstalledRustHound(entry)).rejects.toThrow(/checksum/u);
    await writeFile(manifestPath, "{}");
    await expect(readInstalledRustHound(entry)).rejects.toThrow(/manifest changed/u);
  });

  it("requires a file checksum even for a manually installed package", async () => {
    const { root } = await fixture("not-a-sha256");
    await expect(installedRustHound(root, windows)).rejects.toThrow(/checksum/u);
  });
});
