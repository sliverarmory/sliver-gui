// @vitest-environment node

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebContents } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { clientpb, type SliverEventStreamState } from "sliver-script";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SLIVER_PROTOCOL_BASELINE_COMMIT } from "../shared/contracts.js";

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  fromId: vi.fn(),
  showOpenDialog: vi.fn(),
  createSecureContext: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  webContents: { fromId: mocks.fromId },
}));

vi.mock("node:tls", () => ({ createSecureContext: mocks.createSecureContext }));

import { ConnectionRegistry, type SliverClientAdapter } from "./connection-registry.js";

let root: string;
let configDirectory: string;
let managedDirectory: string;
let registry: ConnectionRegistry;
let fake: ReturnType<typeof fakeAdapter>;
let now: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-gui-cert-capability-"));
  configDirectory = join(root, "configs");
  managedDirectory = join(root, "managed");
  await mkdir(configDirectory);
  await writeFile(join(configDirectory, "operator.cfg"), validConfig());
  mocks.fromWebContents.mockReset();
  mocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
  mocks.fromId.mockReset();
  mocks.fromId.mockReturnValue(undefined);
  mocks.showOpenDialog.mockReset();
  mocks.createSecureContext.mockReset();
  fake = fakeAdapter();
  now = Date.parse("2026-08-09T00:00:00.000Z");
  registry = new ConnectionRegistry({
    savedConfigDirectory: configDirectory,
    managedConfigDirectory: managedDirectory,
    clientFactory: () => fake.adapter,
    now: () => now,
  });
  registry.registerWindow(1);
  const listed = await registry.listSavedConfigs(1);
  if (!listed.ok) throw new Error(listed.error);
  const connected = await registry.connectSavedConfig(1, listed.value[0]!.id);
  if (!connected.ok) throw new Error(connected.error);
});

afterEach(async () => {
  await registry.unregisterWindow(1);
  await rm(root, { recursive: true, force: true });
});

describe("native certificate capabilities", () => {
  it("is window-owned, one-use, and zeroizes certificate/key buffers after HTTPS dispatch", async () => {
    const certificatePath = join(root, "listener.crt");
    const keyPath = join(root, "listener.key");
    await writeFile(certificatePath, "certificate", { mode: 0o644 });
    await writeFile(keyPath, "private-key", { mode: 0o600 });
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [certificatePath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] });

    const selection = await registry.chooseCertificatePair(sender(1));
    if (!selection.ok) throw new Error(selection.error);
    const started = await registry.startListener(1, httpsInput(selection.value.token));

    expect(started).toMatchObject({ ok: true });
    expect(fake.startHTTPSListenerWithOptions).toHaveBeenCalledOnce();
    const options = fake.startHTTPSListenerWithOptions.mock.calls[0]?.[0] as { cert: Buffer; key: Buffer };
    expect(options.cert.every((byte) => byte === 0)).toBe(true);
    expect(options.key.every((byte) => byte === 0)).toBe(true);
    await expect(registry.startListener(1, httpsInput(selection.value.token))).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer available/),
    });
  });

  it("rejects expired tokens and private keys with unsafe permissions", async () => {
    const certificatePath = join(root, "listener.crt");
    const keyPath = join(root, "listener.key");
    await writeFile(certificatePath, "certificate", { mode: 0o644 });
    await writeFile(keyPath, "private-key", { mode: 0o600 });
    mocks.showOpenDialog
      .mockResolvedValueOnce({ canceled: false, filePaths: [certificatePath] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] });
    const selection = await registry.chooseCertificatePair(sender(1));
    if (!selection.ok) throw new Error(selection.error);
    now += 5 * 60_000 + 1;

    await expect(registry.startListener(1, httpsInput(selection.value.token))).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/no longer available/),
    });

    if (process.platform !== "win32") {
      await chmod(keyPath, 0o644);
      mocks.showOpenDialog
        .mockResolvedValueOnce({ canceled: false, filePaths: [certificatePath] })
        .mockResolvedValueOnce({ canceled: false, filePaths: [keyPath] });
      await expect(registry.chooseCertificatePair(sender(1))).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/permissions must be private/),
      });
    }
  });
});

function fakeAdapter(): {
  adapter: SliverClientAdapter;
  startHTTPSListenerWithOptions: ReturnType<typeof vi.fn>;
} {
  const event$ = new Subject<clientpb.Event>();
  const eventStreamState$ = new BehaviorSubject<SliverEventStreamState>({ status: "connected", attempt: 0 });
  const startHTTPSListenerWithOptions = vi.fn(async () => clientpb.ListenerJob.create({ JobID: 1 }));
  const empty = async (): Promise<void> => undefined;
  return {
    startHTTPSListenerWithOptions,
    adapter: {
      connect: async () => undefined,
      disconnect: empty,
      getVersion: async () =>
        clientpb.Version.create({ Major: 1, Minor: 7, Patch: 5, Commit: SLIVER_PROTOCOL_BASELINE_COMMIT }),
      jobs: async () => [],
      implantBuilds: async () => clientpb.ImplantBuilds.create({ Configs: {}, staged: {} }),
      implantProfiles: async () => clientpb.ImplantProfiles.create({ Profiles: [] }),
      getCompiler: async () => clientpb.Compiler.create({ Targets: [], UnsupportedTargets: [] }),
      startMTLSListener: async () => clientpb.ListenerJob.create({ JobID: 1 }),
      startWGListener: async () => clientpb.ListenerJob.create({ JobID: 1 }),
      startDNSListener: async () => clientpb.ListenerJob.create({ JobID: 1 }),
      startHTTPListenerWithOptions: async () => clientpb.ListenerJob.create({ JobID: 1 }),
      startHTTPSListenerWithOptions,
      startTCPStagerListenerWithOptions: async () => clientpb.ListenerJob.create({ JobID: 1 }),
      killJob: async () => clientpb.KillJob.create({ Success: true }),
      generateUniqueIP: async () => clientpb.UniqueWGIP.create({ IP: "100.64.0.2" }),
      generateImplant: async () => clientpb.Generate.create(),
      regenerateImplant: async () => clientpb.Generate.create(),
      deleteImplantBuild: empty,
      stageImplantBuild: empty,
      saveImplantProfile: async (profile) => profile,
      deleteImplantProfile: empty,
      event$: event$.asObservable(),
      eventStreamState$: eventStreamState$.asObservable(),
    } as SliverClientAdapter,
  };
}

function sender(id: number): WebContents {
  return { id, isDestroyed: () => false } as unknown as WebContents;
}

function httpsInput(token: string) {
  return {
    kind: "https" as const,
    host: "127.0.0.1",
    port: 443,
    domain: "",
    website: "",
    enforceOtp: false,
    longPollTimeoutSeconds: 0,
    longPollJitterSeconds: 0,
    acme: false,
    randomizeJarm: false,
    certificateToken: token,
  };
}

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
