// @vitest-environment node

import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OperatorConfigStore } from "./operator-config-store.js";
import { readCurrentSavedConfig } from "./saved-config-catalog.js";

let root: string;
let externalDirectory: string;
let metadataDirectory: string;
let sourceDirectory: string;
let store: OperatorConfigStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-gui-config-store-"));
  externalDirectory = join(root, "configs");
  metadataDirectory = join(root, "gui");
  sourceDirectory = join(root, "sources");
  store = new OperatorConfigStore(externalDirectory, metadataDirectory);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("operator configuration references", () => {
  it("imports a private source by reference without copying credentials", async () => {
    const sourcePath = await createSource("team.cfg");
    const imported = await store.import(sourcePath, "  Local\nOperator  ");

    expect(imported.summary).toMatchObject({
      fileName: "team.cfg",
      displayName: "Local Operator",
      origin: "imported",
      removal: "detach",
      availability: "available",
      transport: "mtls",
    });
    expect(imported.path).toBe(sourcePath);
    expect(JSON.stringify(imported.summary)).not.toContain(sourceDirectory);
    expect(JSON.stringify(imported.summary)).not.toContain("private-key");
    expect(await readFile(sourcePath, "utf8")).toBe(validConfig());
    expect(await readdir(metadataDirectory)).toEqual(["operator-configs.json"]);
    const manifest = await readFile(join(metadataDirectory, "operator-configs.json"), "utf8");
    expect(manifest).toContain(sourcePath);
    expect(manifest).not.toContain("private-key");
    if (process.platform !== "win32") {
      expect((await stat(join(metadataDirectory, "operator-configs.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(metadataDirectory)).mode & 0o777).toBe(0o700);
    }
  });

  it("labels imported WireGuard configs deferred without attempting transport support", async () => {
    const sourcePath = await createSource("wireguard.cfg", validConfig({ wg: wireGuardConfig() }));
    const imported = await store.import(sourcePath, "WG operator");

    expect(imported.summary).toMatchObject({
      transport: "wireguard",
      availability: "deferred",
      unavailableReason: "WireGuard operator connections are deferred for this milestone",
    });
  });

  it("serializes concurrent imports without creating config copies", async () => {
    const paths = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      createSource(`${index}.cfg`, validConfig({ operator: `operator-${index}` })),
    ));
    const imports = await Promise.all(paths.map((path, index) => store.import(path, `Local ${index}`)));

    expect(new Set(imports.map((record) => record.importedId)).size).toBe(20);
    const listed = await store.list();
    expect(listed).toHaveLength(20);
    expect(listed.map((record) => record.summary.displayName).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `Local ${index}`).sort(),
    );
    expect(await readdir(metadataDirectory)).toEqual(["operator-configs.json"]);
  });

  it("omits imported sources that change after import and rejects their old digest", async () => {
    const sourcePath = await createSource("mutable.cfg");
    const imported = await store.import(sourcePath, "Mutable");
    await writeFile(sourcePath, validConfig({ operator: "changed" }), { mode: 0o600 });

    expect(await store.list()).toEqual([]);
    await expect(readCurrentSavedConfig(imported)).rejects.toThrow(/changed after the catalog was refreshed/u);
  });

  it("does not reclassify a changed imported source as discovered until explicit re-import", async () => {
    const sourcePath = await createSource("existing.cfg", validConfig(), externalDirectory);
    await store.import(sourcePath, "Existing");
    await writeFile(sourcePath, validConfig({ operator: "changed" }));

    expect(await store.list()).toEqual([]);
    await store.import(sourcePath, "Updated");
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toMatchObject({ origin: "imported", displayName: "Updated", operator: "changed" });
  });

  it("requires a private regular source for a persistent import", async () => {
    const sourcePath = await createSource("private.cfg");
    const linkedPath = join(sourceDirectory, "link.cfg");
    await symlink(sourcePath, linkedPath);
    await expect(store.import(linkedPath, "Linked")).rejects.toThrow(/bounded regular file/u);

    if (process.platform !== "win32") {
      await chmod(sourcePath, 0o644);
      await expect(store.import(sourcePath, "Public")).rejects.toThrow(/private and non-executable/u);
    }
  });

  it("deduplicates a source inside the discovered directory and forgets without unlinking it", async () => {
    const sourcePath = await createSource("existing.cfg", validConfig(), externalDirectory);
    const first = await store.import(sourcePath, "First name");
    const second = await store.import(sourcePath, "Second name");
    expect(second.importedId).toBe(first.importedId);

    let listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary).toMatchObject({ origin: "imported", displayName: "Second name" });
    await store.remove(listed[0]!);
    expect(await readFile(sourcePath, "utf8")).toBe(validConfig());
    expect(await store.list()).toEqual([]);

    const importedAgain = await store.import(sourcePath, "Third name");
    expect(importedAgain.summary.displayName).toBe("Third name");
    listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.summary.origin).toBe("imported");
  });

  it("forgets an imported source outside the discovered directory without deleting it", async () => {
    const sourcePath = await createSource("outside.cfg");
    const imported = await store.import(sourcePath, "Outside");
    await store.remove(imported);

    expect(await readFile(sourcePath, "utf8")).toBe(validConfig());
    expect(await store.list()).toEqual([]);
  });

  it("detaches pre-existing configs without exposing filesystem deletion", async () => {
    const detachedPath = await createSource("detached.cfg", validConfig({ operator: "detached" }), externalDirectory);

    let listed = await store.list();
    const detached = listed.find((record) => record.summary.operator === "detached");
    expect(detached?.summary).toMatchObject({ origin: "preexisting", removal: "detach" });

    await store.remove(detached!);
    expect(await readFile(detachedPath, "utf8")).toContain("detached");
    listed = await store.list();
    expect(listed.some((record) => record.summary.operator === "detached")).toBe(false);
  });

  it("serializes concurrent external detach mutations without losing either manifest update", async () => {
    await Promise.all([
      createSource("first.cfg", validConfig({ operator: "first" }), externalDirectory),
      createSource("second.cfg", validConfig({ operator: "second" }), externalDirectory),
    ]);
    const listed = await store.list();

    await Promise.all(listed.map((record) => store.remove(record)));

    expect(await store.list()).toEqual([]);
    expect(await readFile(join(externalDirectory, "first.cfg"), "utf8")).toContain("first");
    expect(await readFile(join(externalDirectory, "second.cfg"), "utf8")).toContain("second");
  });
});

async function createSource(name: string, contents = validConfig(), directory = sourceDirectory): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, contents, { mode: 0o600 });
  return path;
}

function validConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    operator: "operator",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "ca",
    certificate: "cert",
    private_key: "private-key",
    token: "token",
    ...overrides,
  });
}

function wireGuardConfig(): Record<string, string> {
  return {
    server_pub_key: "server-key",
    client_private_key: "client-key",
    client_pub_key: "client-public-key",
    client_ip: "127.0.0.2",
    server_ip: "127.0.0.1",
  };
}
