// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sliverMocks = vi.hoisted(() => ({
  constructedConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: {},
  webContents: { fromId: vi.fn() },
}));

vi.mock("sliver-script", async (importOriginal) => {
  const original = await importOriginal<typeof import("sliver-script")>();
  class FakeSliverClient {
    readonly event$ = {
      subscribe: () => ({ unsubscribe: vi.fn() }),
    };
    readonly eventStreamState$ = {
      subscribe: (observer: { next: (state: { status: "connected"; attempt: number }) => void }) => {
        observer.next({ status: "connected", attempt: 0 });
        return { unsubscribe: vi.fn() };
      },
    };

    constructor(config: Record<string, unknown>) {
      sliverMocks.constructedConfigs.push(config);
    }

    async connect() {}
    async disconnect() {}
    async getVersion() { return { Major: 1, Minor: 6, Patch: 2, Dirty: false }; }
    async jobs() { return []; }
    async implantBuilds() { return { Configs: {}, staged: {} }; }
    async implantProfiles() { return { Profiles: [] }; }
    async getCompiler() { return { Targets: [], UnsupportedTargets: [] }; }
  }

  return { ...original, SliverClient: FakeSliverClient };
});

import { ConnectionRegistry } from "./connection-registry.js";

let directory: string;
let registry: ConnectionRegistry;

beforeEach(async () => {
  sliverMocks.constructedConfigs.length = 0;
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-registry-"));
  await writeFile(join(directory, "operator.cfg"), validConfig());
  registry = new ConnectionRegistry(directory);
  registry.registerWindow(101);
  registry.registerWindow(202);
});

afterEach(async () => {
  await registry.unregisterWindow(101);
  await registry.unregisterWindow(202);
  await rm(directory, { recursive: true, force: true });
});

describe("per-window saved configuration catalogs", () => {
  it("rejects unknown IDs and IDs owned by a different window", async () => {
    const listed = await registry.listSavedConfigs(101);
    const id = listed.value?.[0]?.id;
    expect(id).toBeDefined();

    await expect(registry.connectSavedConfig(202, id!)).resolves.toEqual({
      ok: false,
      error: "Unknown or stale saved configuration selection",
    });
    await expect(registry.connectSavedConfig(101, "unknown-id")).resolves.toEqual({
      ok: false,
      error: "Unknown or stale saved configuration selection",
    });
  });

  it("invalidates every previous opaque ID when its window refreshes", async () => {
    const first = await registry.listSavedConfigs(101);
    const oldId = first.value?.[0]?.id;
    const second = await registry.listSavedConfigs(101);
    const currentId = second.value?.[0]?.id;

    expect(oldId).toBeDefined();
    expect(currentId).toBeDefined();
    expect(currentId).not.toBe(oldId);
    await expect(registry.connectSavedConfig(101, oldId!)).resolves.toEqual({
      ok: false,
      error: "Unknown or stale saved configuration selection",
    });
  });

  it("connects through a selected catalog entry without returning its credentials", async () => {
    const listed = await registry.listSavedConfigs(101);
    const id = listed.value?.[0]?.id;
    expect(id).toBeDefined();

    const result = await registry.connectSavedConfig(101, id!);

    expect(result).toMatchObject({
      ok: true,
      value: {
        connection: {
          status: "degraded",
          operator: "operator",
          server: "localhost:31337",
          configName: "operator",
        },
      },
    });
    expect(sliverMocks.constructedConfigs.at(-1)).toMatchObject({
      private_key: "private-key",
      token: "token",
    });
    expect(JSON.stringify(listed.value)).not.toContain("private-key");
    expect(JSON.stringify(result.value)).not.toContain("private-key");
    expect(JSON.stringify(result.value)).not.toContain("token");
  });
});

function validConfig(): string {
  return JSON.stringify({
    operator: "operator",
    lhost: "localhost",
    lport: 31337,
    ca_certificate: "ca",
    certificate: "cert",
    private_key: "private-key",
    token: "token",
  });
}
