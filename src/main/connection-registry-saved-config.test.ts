// @vitest-environment node

import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { webContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/contracts.js";

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
import type { OperatorConfigStore } from "./operator-config-store.js";

let directory: string;
let registry: ConnectionRegistry;

beforeEach(async () => {
  sliverMocks.constructedConfigs.length = 0;
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-registry-"));
  await writeFile(join(directory, "operator.cfg"), validConfig());
  registry = new ConnectionRegistry({
    savedConfigDirectory: directory,
    managedConfigDirectory: join(directory, "managed"),
  });
  registry.registerWindow(101);
  registry.registerWindow(202);
});

afterEach(async () => {
  await registry.unregisterWindow(101);
  await registry.unregisterWindow(202);
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("per-window saved configuration catalogs", () => {
  it("invalidates each open window only when a filesystem change yields a valid catalog entry", async () => {
    const send = vi.fn();
    vi.mocked(webContents.fromId).mockReturnValue({
      isDestroyed: () => false,
      send,
    } as unknown as ReturnType<typeof webContents.fromId>);

    // The first scan closes the window-registration/startup race.
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.savedConfigsChanged), { timeout: 5_000 });
    send.mockClear();

    await writeFile(join(directory, "broken.cfg"), "{invalid", { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(send).not.toHaveBeenCalled();

    const staged = join(directory, "..", `${basename(directory)}-staged.cfg`);
    await writeFile(staged, validConfig(), { mode: 0o600 });
    await rename(staged, join(directory, "new-operator.cfg"));
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.savedConfigsChanged), { timeout: 5_000 });
    expect(send).toHaveBeenCalledTimes(2);

    const listed = await registry.listSavedConfigs(101);
    expect(listed.value?.map((entry) => entry.fileName)).toEqual(["new-operator.cfg", "operator.cfg"]);

    send.mockClear();
    await registry.unregisterWindow(101);
    await registry.unregisterWindow(202);
    await writeFile(join(directory, "after-close.cfg"), validConfig(), { mode: 0o600 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(send).not.toHaveBeenCalled();
  }, 15_000);

  it("reattaches to an atomically replaced config directory", async () => {
    await registry.unregisterWindow(101);
    await registry.unregisterWindow(202);
    const root = await mkdtemp(join(tmpdir(), "sliver-gui-watch-replace-"));
    const configs = join(root, "configs");
    const replacementRegistry = new ConnectionRegistry({
      savedConfigDirectory: configs,
      managedConfigDirectory: join(root, "gui"),
    });
    const send = vi.fn();
    vi.mocked(webContents.fromId).mockReturnValue({
      isDestroyed: () => false,
      send,
    } as unknown as ReturnType<typeof webContents.fromId>);

    try {
      await mkdir(configs);
      await writeFile(join(configs, "old.cfg"), validConfig(), { mode: 0o600 });
      replacementRegistry.registerWindow(303);
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.savedConfigsChanged), { timeout: 5_000 });
      send.mockClear();

      await rename(configs, join(root, "configs-old"));
      await mkdir(configs);
      await writeFile(join(configs, "replacement.cfg"), validConfig(), { mode: 0o600 });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.savedConfigsChanged), { timeout: 5_000 });
      await new Promise((resolve) => setTimeout(resolve, 250));
      send.mockClear();

      await writeFile(join(configs, "later.cfg"), validConfig(), { mode: 0o600 });
      await vi.waitFor(() => expect(send).toHaveBeenCalledWith(IPC.savedConfigsChanged), { timeout: 5_000 });
      const listed = await replacementRegistry.listSavedConfigs(303);
      expect(listed.value?.map((entry) => entry.fileName)).toContain("later.cfg");
    } finally {
      await replacementRegistry.unregisterWindow(303);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("uses the Sliver client root for discovered configs and GUI-owned imports", async () => {
    const clientRoot = await mkdtemp(join(tmpdir(), "sliver-gui-client-root-"));
    const discoveredDirectory = join(clientRoot, "configs");
    await mkdir(discoveredDirectory);
    const sourcePath = join(discoveredDirectory, "existing.cfg");
    await writeFile(sourcePath, validConfig(), { mode: 0o600 });
    vi.stubEnv("SLIVER_CLIENT_ROOT_DIR", clientRoot);
    const defaultRegistry = new ConnectionRegistry();
    defaultRegistry.registerWindow(303);

    try {
      const listed = await defaultRegistry.listSavedConfigs(303);
      expect(listed.value).toEqual([
        expect.objectContaining({ fileName: "existing.cfg", origin: "preexisting" }),
      ]);

      const store = (defaultRegistry as unknown as { configStore: OperatorConfigStore }).configStore;
      const imported = await store.import(sourcePath, "Imported");
      expect(imported.path).toBe(sourcePath);
      expect(await readdir(join(clientRoot, "gui"))).toEqual(["operator-configs.json"]);
    } finally {
      await defaultRegistry.unregisterWindow(303);
      await rm(clientRoot, { recursive: true, force: true });
    }
  });

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
