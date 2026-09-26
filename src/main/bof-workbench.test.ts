import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sliverpb } from "sliver-script";
import type { BofArgumentDefinition } from "../shared/bof-contracts.js";
import type { TargetRef, TargetSummary } from "../shared/target-contracts.js";
import { decodeBofOutput, installedBofCommands, packBofArguments, readBofCommandsFromDirectory, readInstalledBofObject } from "./bof-workbench.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const target = { mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active" } as TargetSummary;
const ref: TargetRef = { mode: "session", id: "session-1", backendEpoch: 1, domainRevision: 1, fingerprint: "fixture" };

describe("installed BOF selection", () => {
  it("reads installed Armory manifests, exposes arguments, and selects the exact target object", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-bof-test-"));
    roots.push(root);
    const directory = join(root, "extensions", "fixture-bof");
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "dist", "fixture.o"), Buffer.from("fixture-object"));
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      name: "Fixture BOF", package_name: "fixture-bof", version: "1",
      commands: [{ command_name: "fixture-bof", help: "Fixture description", bof_executor: "reflektor", entrypoint: "go",
        files: [{ os: "windows", arch: "amd64", path: "dist/fixture.o" }],
        arguments: [{ name: "host", desc: "Host to query", type: "wstring", optional: false },
          { name: "count", desc: "Count", type: "integer", optional: true, default: 5, choices: ["5", "10"] }] }],
    }));

    const selected = await installedBofCommands(root, target, ref, true);
    expect(selected.catalog.commands).toEqual([{ id: "fixture-bof/fixture-bof", packageName: "Fixture BOF",
      commandName: "fixture-bof", description: "Fixture description", platformSupported: true, available: true,
      arguments: [{ name: "host", description: "Host to query", type: "wstring", optional: false },
        { name: "count", description: "Count", type: "integer", optional: true, default: 5, choices: ["5", "10"] }] }]);
    expect(await readInstalledBofObject(selected.entries[0]!)).toEqual(Buffer.from("fixture-object"));
    const unsupported = await installedBofCommands(root, target, ref, false);
    expect(unsupported.catalog.commands[0]).toMatchObject({ platformSupported: true, available: false, reason: expect.stringContaining("does not advertise") });
    const otherArch = await installedBofCommands(root, { ...target, arch: "arm64" }, ref, true);
    expect(otherArch.catalog.commands[0]).toMatchObject({ platformSupported: false, available: false, reason: expect.stringContaining("No BOF object") });
    const otherOs = await installedBofCommands(root, { ...target, os: "linux" }, ref, true);
    expect(otherOs.catalog.commands[0]).toMatchObject({ platformSupported: false, available: false, reason: expect.stringContaining("No BOF object") });
  });

  it("refuses a symlinked object inside an installed package", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-bof-test-"));
    roots.push(root);
    const directory = join(root, "extensions", "linked-bof");
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, "external.o"), "outside package");
    await symlink(join(root, "external.o"), join(directory, "linked.o"));
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      name: "linked-bof", command_name: "linked-bof", help: "link fixture", entrypoint: "go",
      bof_executor: "reflektor", files: [{ os: "windows", arch: "amd64", path: "linked.o" }],
    }));
    const { entries } = await installedBofCommands(root, target, ref, true);
    await expect(readInstalledBofObject(entries[0]!)).rejects.toThrow(/bounded regular file/u);
  });

  it("offers legacy BOFs only when a matching installed loader artifact exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-bof-test-"));
    roots.push(root);
    const bofDirectory = join(root, "extensions", "legacy-probe");
    const loaderDirectory = join(root, "extensions", "coff-loader");
    await mkdir(bofDirectory, { recursive: true });
    await mkdir(loaderDirectory, { recursive: true });
    await writeFile(join(bofDirectory, "probe.o"), Buffer.from("BOF"));
    await writeFile(join(bofDirectory, "extension.json"), JSON.stringify({
      name: "Legacy Probe", command_name: "legacy-probe", help: "legacy fixture",
      bof_executor: "coff-loader", depends_on: "coff-loader", entrypoint: "go",
      arguments: [{ name: "domain.fqdn", type: "wstring", optional: false }],
      files: [{ os: "windows", arch: "amd64", path: "probe.o" }],
    }));
    await writeFile(join(loaderDirectory, "extension.json"), JSON.stringify({
      name: "COFF Loader", command_name: "coff-loader", help: "loader fixture",
      entrypoint: "LoadAndRun", files: [{ os: "windows", arch: "amd64", path: "loader.dll" }],
    }));
    const unavailable = await installedBofCommands(root, target, ref, false);
    expect(unavailable.catalog.commands.find((item) => item.id === "legacy-probe/legacy-probe"))
      .toMatchObject({ platformSupported: true, available: false, reason: expect.stringContaining("loader") });
    await writeFile(join(loaderDirectory, "loader.dll"), Buffer.from("DLL"));
    const available = await installedBofCommands(root, target, ref, false);
    expect(available.catalog.commands.find((item) => item.id === "legacy-probe/legacy-probe"))
      .toMatchObject({ available: true, arguments: [{ name: "domain.fqdn", type: "wstring" }] });
    expect(available.entries.find((item) => item.dto.id === "legacy-probe/legacy-probe"))
      .toMatchObject({ mode: "coff-loader", dependencyName: "coff-loader" });
  });
});

describe("operator-selected BOF directory", () => {
  it("loads an Armory-style package outside the installed extensions directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-local-bof-test-"));
    roots.push(root);
    const directory = join(root, "working copy with spaces");
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "dist", "probe.o"), Buffer.from("local-object"));
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      name: "Local Probe", package_name: "local-probe", version: "1",
      commands: [{ command_name: "probe", help: "Local package", bof_executor: "reflektor", entrypoint: "go",
        files: [{ os: "windows", arch: "amd64", path: "/dist/probe.o" }],
        arguments: [{ name: "domain", type: "wstring", optional: false },
          { name: "depth", type: "short", optional: true, default: 2 }] }],
    }));

    const selected = await readBofCommandsFromDirectory(root, directory, "local-fixture", target, ref, true);
    expect(selected.entries).toHaveLength(1);
    expect(selected.entries[0]?.dto).toMatchObject({
      id: "local-fixture/probe", packageName: "Local Probe", commandName: "probe", platformSupported: true, available: true,
      arguments: [{ name: "domain", type: "wstring" }, { name: "depth", type: "short", default: 2 }],
    });
    expect(await readInstalledBofObject(selected.entries[0]!)).toEqual(Buffer.from("local-object"));

    const unsupported = await readBofCommandsFromDirectory(root, directory, "local-fixture", { ...target, arch: "arm64" }, ref, true);
    expect(unsupported.entries[0]?.dto).toMatchObject({ platformSupported: false, available: false, reason: expect.stringContaining("No BOF object") });
  });

  it("rejects selected symlinks and unsafe manifest paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "sliver-local-bof-test-"));
    roots.push(root);
    const directory = join(root, "local-probe");
    await mkdir(directory);
    await writeFile(join(directory, "probe.o"), Buffer.from("COFF"));
    const manifest = {
      name: "Local Probe", command_name: "local-probe", help: "fixture", entrypoint: "go",
      bof_executor: "reflektor", files: [{ os: "windows", arch: "amd64", path: "probe.o" }],
    };
    await writeFile(join(directory, "extension.json"), JSON.stringify(manifest));
    const linkedDirectory = join(root, "linked-package");
    await symlink(directory, linkedDirectory, "dir");
    await expect(readBofCommandsFromDirectory(root, linkedDirectory, "local-linked", target, ref, true))
      .rejects.toThrow(/regular directory/u);

    await rm(join(directory, "extension.json"));
    await writeFile(join(root, "outside.json"), JSON.stringify(manifest));
    await symlink(join(root, "outside.json"), join(directory, "extension.json"));
    await expect(readBofCommandsFromDirectory(root, directory, "local-linked", target, ref, true))
      .rejects.toThrow(/bounded regular file/u);

    await rm(join(directory, "extension.json"));
    await writeFile(join(directory, "extension.json"), JSON.stringify({
      ...manifest, files: [{ os: "windows", arch: "amd64", path: "../outside.o" }],
    }));
    await expect(readBofCommandsFromDirectory(root, directory, "local-linked", target, ref, true))
      .rejects.toThrow(/Unsafe Armory file path/u);
  });
});

describe("BOF wire arguments and output", () => {
  it("packs string, wstring, integer, short, file, and optional defaults using Sliver BOF framing", () => {
    const definitions: BofArgumentDefinition[] = [
      { name: "name", description: "", type: "string", optional: false },
      { name: "wide", description: "", type: "wstring", optional: false },
      { name: "count", description: "", type: "integer", optional: false },
      { name: "port", description: "", type: "short", optional: false },
      { name: "blob", description: "", type: "file", optional: false },
      { name: "fallback", description: "", type: "int", optional: true, default: 5 },
    ];
    const actual = packBofArguments(definitions, ["A", "λ", -1, 300, "opaque-token", null], new Map([[4, Buffer.from([0, 1, 2])]]));
    const body = Buffer.concat([
      Buffer.from([2, 0, 0, 0, 65, 0]),
      Buffer.from([4, 0, 0, 0, 0xbb, 0x03, 0, 0]),
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from([0x2c, 0x01]),
      Buffer.from([3, 0, 0, 0, 0, 1, 2]),
      Buffer.from([5, 0, 0, 0]),
    ]);
    const expected = Buffer.alloc(4 + body.length);
    expected.writeUInt32LE(body.length, 0);
    body.copy(expected, 4);
    expect(actual).toEqual(expected);
    expect(() => packBofArguments(definitions, ["A", "λ", -1, 300, "path", null])).toThrow(/selected local file/u);
    expect(() => packBofArguments(definitions, [null, "λ", -1, 300, "path", null])).toThrow(/required/u);
  });

  it("retains typed BOF channel records and falls back to legacy output", () => {
    const typed = sliverpb.CallExtension.create({
      Output: Buffer.from("legacy duplicate"),
      BOFOutputs: [{ Type: 0, Data: Buffer.from("first") }, { Type: 0x0d, Data: Buffer.from("error") }, { Type: 1, Data: Buffer.from("second") }],
    });
    expect(decodeBofOutput(typed)).toEqual({
      stdout: { data: Buffer.from("firstsecond"), truncated: false },
      stderr: { data: Buffer.from("error"), truncated: false },
    });
    expect(decodeBofOutput(sliverpb.CallExtension.create({ Output: Buffer.from("legacy") })))
      .toEqual({ stdout: { data: Buffer.from("legacy"), truncated: false } });
    expect(decodeBofOutput(sliverpb.CallExtension.create({
      BOFOutputs: [{ Type: 0, Data: Buffer.from("partial") }, { Type: 0x0d, Data: Buffer.from("error detail") }],
      Response: { Err: "remote rejection", Async: false, BeaconID: "", TaskID: "" },
    }))).toEqual({
      stdout: { data: Buffer.from("partial"), truncated: false },
      stderr: { data: Buffer.from("error detail"), truncated: false },
    });
  });
});
