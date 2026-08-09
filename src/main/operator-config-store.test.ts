// @vitest-environment node

import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OperatorConfigStore } from "./operator-config-store.js";

let root: string;
let externalDirectory: string;
let managedDirectory: string;
let store: OperatorConfigStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-gui-config-store-"));
  externalDirectory = join(root, "external");
  managedDirectory = join(root, "managed");
  store = new OperatorConfigStore(externalDirectory, managedDirectory);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("managed operator configuration store", () => {
  it("imports a private GUI-owned copy with a local display name", async () => {
    const source = Buffer.from(validConfig(), "utf8");
    const imported = await store.import(source, "  Local\nOperator  ");

    expect(imported.summary).toMatchObject({
      displayName: "Local Operator",
      origin: "managed",
      removal: "delete-managed-copy",
      availability: "available",
      transport: "mtls",
    });
    expect(JSON.stringify(imported.summary)).not.toContain("private-key");
    const configPath = join(managedDirectory, imported.summary.fileName);
    expect(await readFile(configPath, "utf8")).toBe(validConfig());
    if (process.platform !== "win32") {
      expect((await stat(configPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(managedDirectory, ".sliver-gui-configs.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("labels imported WireGuard configs deferred without attempting transport support", async () => {
    const imported = await store.import(Buffer.from(validConfig({ wg: wireGuardConfig() })), "WG operator");

    expect(imported.summary).toMatchObject({
      transport: "wireguard",
      availability: "deferred",
      unavailableReason: "WireGuard operator connections are deferred for this milestone",
    });
  });

  it("serializes concurrent imports so every successful managed copy remains manifest-owned", async () => {
    const imports = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        store.import(Buffer.from(validConfig({ operator: `operator-${index}` })), `Local ${index}`),
      ),
    );

    expect(new Set(imports.map((record) => record.summary.id)).size).toBe(20);
    const listed = await store.list();
    expect(listed).toHaveLength(20);
    expect(listed.map((record) => record.summary.displayName).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `Local ${index}`).sort(),
    );
    expect((await readdir(managedDirectory)).filter((name) => name.endsWith(".cfg"))).toHaveLength(20);
  });

  it("lists only manifest-owned managed copies and deletes an exact owned copy", async () => {
    const imported = await store.import(Buffer.from(validConfig()), "Owned");
    await writeFile(join(managedDirectory, "orphan.cfg"), validConfig({ operator: "orphan" }), { mode: 0o600 });

    const listed = await store.list();
    expect(listed.map((record) => record.summary.displayName)).toEqual(["Owned"]);
    await store.remove(listed[0]!);

    await expect(access(join(managedDirectory, imported.summary.fileName))).rejects.toThrow();
    expect((await readdir(managedDirectory)).sort()).toEqual([".sliver-gui-configs.json", "orphan.cfg"]);
  });

  it("detaches pre-existing configs without exposing filesystem deletion", async () => {
    await mkdir(externalDirectory);
    const detachedPath = join(externalDirectory, "detached.cfg");
    await writeFile(detachedPath, validConfig({ operator: "detached" }));

    let listed = await store.list();
    const detached = listed.find((record) => record.summary.operator === "detached");
    expect(detached?.summary).toMatchObject({ origin: "preexisting", removal: "detach" });

    await store.remove(detached!);
    expect(await readFile(detachedPath, "utf8")).toContain("detached");
    listed = await store.list();
    expect(listed.some((record) => record.summary.operator === "detached")).toBe(false);
  });

  it("serializes concurrent external detach mutations without losing either manifest update", async () => {
    await mkdir(externalDirectory);
    await Promise.all([
      writeFile(join(externalDirectory, "first.cfg"), validConfig({ operator: "first" })),
      writeFile(join(externalDirectory, "second.cfg"), validConfig({ operator: "second" })),
    ]);
    const listed = await store.list();

    await Promise.all(listed.map((record) => store.remove(record)));

    expect(await store.list()).toEqual([]);
    expect(await readFile(join(externalDirectory, "first.cfg"), "utf8")).toContain("first");
    expect(await readFile(join(externalDirectory, "second.cfg"), "utf8")).toContain("second");
  });
});

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
