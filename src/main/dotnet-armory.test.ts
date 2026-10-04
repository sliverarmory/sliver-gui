// @vitest-environment node
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { TargetRef, TargetSummary } from "../shared/target-contracts.js";
import { installedDotNetAssemblies, MAX_DOTNET_ASSEMBLY_BYTES, readInstalledDotNetAssembly } from "./dotnet-armory.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const target = { mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active" } as TargetSummary;
const ref: TargetRef = { mode: "session", id: "session-1", backendEpoch: 1, domainRevision: 1, fingerprint: "fixture" };

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sliver-dotnet-armory-test-"));
  roots.push(root);
  return root;
}

async function alias(root: string, directoryName: string, override: Record<string, unknown> = {}, bytes = Buffer.from("managed fixture")) {
  const directory = join(root, "aliases", directoryName);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "dist", "fixture.exe"), bytes);
  await writeFile(join(directory, "alias.json"), JSON.stringify({
    name: "Fixture Assembly", command_name: directoryName, help: "Runs the fixture",
    is_assembly: true,
    files: [
      { os: "windows", arch: "386", path: "dist/fixture-x86.exe" },
      { os: "windows", arch: "amd64", path: "/dist/fixture.exe" },
    ],
    ...override,
  }));
  return directory;
}

describe("installed Armory .NET assemblies", () => {
  it("selects a target-matched alias and reads its bounded artifact", async () => {
    const root = await temporaryRoot();
    await alias(root, "fixture-assembly");
    await alias(root, "native-tool", { is_assembly: false });

    const { catalog, entries } = await installedDotNetAssemblies(root, target, ref);
    expect(catalog.target).toEqual(ref);
    expect(catalog.assemblies).toEqual([{
      id: "aliases/fixture-assembly", commandName: "fixture-assembly", packageName: "Fixture Assembly",
      description: "Runs the fixture", fileName: "fixture.exe", isDll: false, available: true,
    }]);
    expect(entries).toHaveLength(1);
    expect(await readInstalledDotNetAssembly(entries[0]!)).toEqual(Buffer.from("managed fixture"));
  });

  it("marks unmatched platforms and unsupported target artifacts unavailable", async () => {
    const root = await temporaryRoot();
    await alias(root, "fixture-assembly");
    const nonWindows = await installedDotNetAssemblies(root, { ...target, os: "linux" }, ref);
    expect(nonWindows.catalog.assemblies[0]).toMatchObject({ available: false, reason: expect.stringContaining("Windows") });
    await expect(readInstalledDotNetAssembly(nonWindows.entries[0]!)).rejects.toThrow(/Windows/u);

    const otherArchitecture = await installedDotNetAssemblies(root, { ...target, arch: "arm64" }, ref);
    expect(otherArchitecture.catalog.assemblies[0]).toMatchObject({ available: false, reason: expect.stringContaining("No .NET assembly") });

    await alias(root, "wrong-extension", {
      files: [{ os: "windows", arch: "amd64", path: "dist/fixture.txt" }],
    });
    const invalid = await installedDotNetAssemblies(root, target, ref);
    expect(invalid.catalog.assemblies.find((item) => item.commandName === "wrong-extension"))
      .toMatchObject({ available: false, reason: expect.stringContaining(".exe or .dll") });
  });

  it("rejects a changed manifest and an oversized artifact at read time", async () => {
    const root = await temporaryRoot();
    const directory = await alias(root, "fixture-assembly");
    const first = await installedDotNetAssemblies(root, target, ref);
    await writeFile(join(directory, "alias.json"), JSON.stringify({
      name: "Changed Assembly", command_name: "fixture-assembly", help: "changed",
      is_assembly: true, files: [{ os: "windows", arch: "amd64", path: "dist/fixture.exe" }],
    }));
    await expect(readInstalledDotNetAssembly(first.entries[0]!)).rejects.toThrow(/changed/u);

    const second = await installedDotNetAssemblies(root, target, ref);
    await truncate(join(directory, "dist", "fixture.exe"), MAX_DOTNET_ASSEMBLY_BYTES + 1);
    await expect(readInstalledDotNetAssembly(second.entries[0]!)).rejects.toThrow(/bounded regular file/u);
    const third = await installedDotNetAssemblies(root, target, ref);
    expect(third.catalog.assemblies[0]).toMatchObject({ available: false });
  });

  it.skipIf(process.platform === "win32")("excludes unsafe manifests and refuses symlinked package paths", async () => {
    const root = await temporaryRoot();
    const good = await alias(root, "fixture-assembly");
    await alias(root, "traversal", { files: [{ os: "windows", arch: "amd64", path: "../outside.exe" }] });
    await symlink(good, join(root, "aliases", "linked-package"), "dir");
    await mkdir(join(root, "aliases", "linked-manifest"));
    await symlink(join(good, "alias.json"), join(root, "aliases", "linked-manifest", "alias.json"));
    const { catalog } = await installedDotNetAssemblies(root, target, ref);
    expect(catalog.assemblies.map((entry) => entry.commandName)).toEqual(["fixture-assembly"]);

    await rm(join(good, "dist", "fixture.exe"));
    await writeFile(join(root, "outside.exe"), "outside package");
    await symlink(join(root, "outside.exe"), join(good, "dist", "fixture.exe"));
    const changed = await installedDotNetAssemblies(root, target, ref);
    expect(changed.catalog.assemblies[0]).toMatchObject({ available: false });
  });
});
