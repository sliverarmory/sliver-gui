// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WebContents } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { clientpb, type SliverEventStreamState } from "sliver-script";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloneGenerateInput, defaultGenerateInput } from "../shared/generate-defaults.js";
import { SLIVER_PROTOCOL_BASELINE_COMMIT } from "../shared/contracts.js";

const electronMocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  fromId: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
  },
  webContents: { fromId: electronMocks.fromId },
}));

import {
  ConnectionRegistry,
  negotiateServerVersion,
  summarizeEvent,
  type SliverClientAdapter,
} from "./connection-registry.js";

let root: string;
let externalDirectory: string;
let managedDirectory: string;
const registries: ConnectionRegistry[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-gui-registry-fake-"));
  externalDirectory = join(root, "external");
  managedDirectory = join(root, "managed");
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, "operator.cfg"), validConfig());
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
  electronMocks.fromId.mockReset();
  electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send: vi.fn() });
  electronMocks.showOpenDialog.mockReset();
  electronMocks.showSaveDialog.mockReset();
  electronMocks.showSaveDialog.mockResolvedValue({ canceled: true });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const registry of registries.splice(0)) {
    await registry.unregisterWindow(1);
    await registry.unregisterWindow(2);
  }
  await rm(root, { recursive: true, force: true });
});

describe("connection registry with an injected Sliver client", () => {
  it("shares pools, listeners, and event subscriptions until the final window detaches", async () => {
    const clients: FakeSliverClient[] = [];
    const registry = createRegistry(() => {
      const client = new FakeSliverClient();
      clients.push(client);
      return client.adapter;
    });
    registry.registerWindow(1);
    registry.registerWindow(2);

    await connectSaved(registry, 1);
    await connectSaved(registry, 2);

    expect(clients).toHaveLength(1);
    expect(clients[0]?.connect).toHaveBeenCalledOnce();
    expect(clients[0]?.events.observed).toBe(true);
    expect(clients[0]?.streamStates.observed).toBe(true);
    await registry.unregisterWindow(1);
    expect(clients[0]?.disconnect).not.toHaveBeenCalled();
    await registry.unregisterWindow(2);
    expect(clients[0]?.disconnect).toHaveBeenCalledOnce();
    expect(clients[0]?.events.observed).toBe(false);
    expect(clients[0]?.streamStates.observed).toBe(false);
  });

  it("dispatches listener mutations and refreshes only the jobs domain", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = domainCallCounts(client);

    const started = await registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port: 65_535 });

    expect(started).toMatchObject({ ok: true, value: { protocol: "mtls", port: 65_535 } });
    expect(client.startMTLSListener).toHaveBeenCalledWith("127.0.0.1", 65_535);
    expect(domainCallCounts(client)).toEqual({ ...baselineCalls, jobs: baselineCalls.jobs + 1 });

    for (const port of [0, 65_536, 1.5]) {
      await expect(
        registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/1 and 65535/) });
    }
    expect(client.startMTLSListener).toHaveBeenCalledOnce();
  });

  it("does not misclassify a gRPC method path as a local filesystem failure", async () => {
    const client = new FakeSliverClient();
    client.startMTLSListener.mockRejectedValueOnce(
      Object.assign(new Error("3 INVALID_ARGUMENT: invalid listener port"), {
        code: 3,
        path: "/clientpb.SliverRPC/StartMTLSListener",
      }),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(
      registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port: 65_535 }),
    ).resolves.toEqual({ ok: false, error: "3 INVALID_ARGUMENT: invalid listener port" });
  });

  it("coalesces job events into a targeted refresh and never forwards raw event bytes", async () => {
    vi.useFakeTimers();
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = domainCallCounts(client);
    client.jobState = [job(9, 9999)];

    client.events.next(
      clientpb.Event.create({
        EventType: "job-started",
        Job: job(9, 9999),
        Data: Buffer.from("TOP-SECRET-TASK-BYTES"),
        Err: "token=TOP-SECRET-EVENT-TOKEN",
      }),
    );
    await vi.advanceTimersByTimeAsync(101);

    expect(domainCallCounts(client)).toEqual({ ...baselineCalls, jobs: baselineCalls.jobs + 1 });
    const snapshot = registry.snapshot(1);
    expect(snapshot.jobs.map((item) => item.id)).toEqual([9]);
    expect(JSON.stringify(snapshot)).not.toContain("TOP-SECRET");
    expect(snapshot.recentEvents[0]).toMatchObject({ type: "job-started", isError: true });
  });

  it("reruns an in-flight domain refresh when an event invalidates its pending result", async () => {
    vi.useFakeTimers();
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = client.jobs.mock.calls.length;
    const staleJobs = deferred<clientpb.Job[]>();
    client.nextJobsPromise = staleJobs.promise;

    const refresh = registry.refresh(1);
    await Promise.resolve();
    expect(client.jobs).toHaveBeenCalledTimes(baselineCalls + 1);
    client.events.next(clientpb.Event.create({ EventType: "job-started", Job: job(44, 4444) }));
    await vi.advanceTimersByTimeAsync(101);
    client.jobState = [job(44, 4444)];
    staleJobs.resolve([]);

    await expect(refresh).resolves.toMatchObject({ ok: true });
    expect(client.jobs).toHaveBeenCalledTimes(baselineCalls + 2);
    expect(registry.snapshot(1).jobs).toMatchObject([{ id: 44, port: 4444 }]);
  });

  it("recognizes the pinned external-build-completed event as a build invalidation", async () => {
    vi.useFakeTimers();
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = client.implantBuilds.mock.calls.length;
    client.buildState.Configs["external"] = clientpb.ImplantConfig.create({
      ID: "external-id",
      GOOS: "linux",
      GOARCH: "amd64",
      Format: clientpb.OutputFormat.EXECUTABLE,
    });

    client.events.next(clientpb.Event.create({ EventType: "external-build-completed" }));
    await vi.advanceTimersByTimeAsync(101);

    expect(client.implantBuilds).toHaveBeenCalledTimes(baselineCalls + 1);
    expect(registry.snapshot(1).builds.map((build) => build.name)).toContain("external");
    expect(registry.snapshot(1).recentEvents[0]).toMatchObject({
      type: "external-build-completed",
      message: "Implant build inventory changed",
    });
  });

  it("catches refresh rejection, exposes the domain error, and recovers health on a later refresh", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    client.nextJobsError = new Error("token=TOP-SECRET-REFRESH");

    const failed = await registry.refresh(1);
    expect(failed).toMatchObject({ ok: false });
    expect(registry.snapshot(1).connection.status).toBe("degraded");
    expect(registry.snapshot(1).domains.jobs.status).toBe("error");
    expect(JSON.stringify(registry.snapshot(1))).not.toContain("TOP-SECRET-REFRESH");

    const recovered = await registry.refresh(1);
    expect(recovered).toMatchObject({ ok: true, value: { connection: { status: "connected" } } });
    expect(registry.snapshot(1).domains.jobs.status).toBe("empty");
  });

  it("remains degraded when a targeted refresh succeeds but another domain is still in error", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    client.nextProfilesError = new Error("profile inventory unavailable");

    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: false });
    expect(registry.snapshot(1)).toMatchObject({
      connection: { status: "degraded" },
      domains: { profiles: { status: "error" } },
    });

    await expect(
      registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port: 8888 }),
    ).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1)).toMatchObject({
      connection: { status: "degraded", error: "profile inventory unavailable" },
      domains: { jobs: { status: "ready" }, profiles: { status: "error" } },
    });

    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: true,
      value: { connection: { status: "connected" } },
    });
  });

  it("preserves a domain failure while its retry is loading and another domain succeeds", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    client.nextProfilesError = new Error("profile inventory unavailable");
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: false });

    const profiles = deferred<clientpb.ImplantProfiles>();
    client.nextProfilesPromise = profiles.promise;
    const retry = registry.refresh(1);
    await Promise.resolve();
    expect(registry.snapshot(1).domains.profiles).toMatchObject({
      status: "loading",
      error: "profile inventory unavailable",
    });

    await expect(
      registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port: 8888 }),
    ).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1)).toMatchObject({
      connection: { status: "degraded", error: "profile inventory unavailable" },
      domains: { profiles: { status: "loading", error: "profile inventory unavailable" } },
    });

    profiles.resolve(clientpb.ImplantProfiles.create({ Profiles: [] }));
    await expect(retry).resolves.toMatchObject({ ok: true, value: { connection: { status: "connected" } } });
  });

  it("does not clear event-stream failure health after a successful domain refresh", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    client.events.error(new Error("event stream terminated"));
    expect(registry.snapshot(1)).toMatchObject({
      connection: { status: "degraded", error: "event stream terminated" },
      eventStream: { status: "stopped", error: "event stream terminated" },
    });

    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: true,
      value: { connection: { status: "degraded" } },
    });
    expect(registry.snapshot(1).connection.error).toBe("event stream terminated");
  });

  it("rejects a slow refresh from a closed epoch after reconnect", async () => {
    const firstClient = new FakeSliverClient();
    const secondClient = new FakeSliverClient();
    secondClient.jobState = [job(22, 2222)];
    const clients = [firstClient, secondClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const oldEpoch = registry.snapshot(1).connection.epoch;
    const gate = deferred<clientpb.Job[]>();
    firstClient.nextJobsPromise = gate.promise;

    const staleRefresh = registry.refresh(1);
    await Promise.resolve();
    await registry.disconnect(1);
    await connectSaved(registry, 1);
    const newEpoch = registry.snapshot(1).connection.epoch;
    expect(newEpoch).toBeGreaterThan(oldEpoch ?? 0);
    expect(registry.snapshot(1).jobs.map((item) => item.id)).toEqual([22]);

    gate.resolve([job(11, 1111)]);
    await expect(staleRefresh).resolves.toMatchObject({ ok: false });
    await Promise.resolve();
    expect(registry.snapshot(1).connection.epoch).toBe(newEpoch);
    expect(registry.snapshot(1).jobs.map((item) => item.id)).toEqual([22]);
    expect(firstClient.disconnect).toHaveBeenCalledOnce();
  });

  it("binds one-use stop plans to exact backend resources and rejects drift", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000)];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareStopJob(1, 7);
    expect(prepared).toMatchObject({
      ok: true,
      value: { impact: { backend: { sharedWindowCount: 1 }, jobs: [{ id: 7, port: 7000 }] } },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    client.jobState = [job(7, 7001)];

    await expect(registry.executeStopPlan(1, prepared.value.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/job set changed/),
    });
    expect(client.killJob).not.toHaveBeenCalled();
    await expect(registry.executeStopPlan(1, prepared.value.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expired/),
    });

    const current = await registry.prepareStopAllJobs(1);
    if (!current.ok) throw new Error(current.error);
    await expect(registry.executeStopPlan(1, current.value.token)).resolves.toEqual({ ok: true });
    expect(client.killJob).toHaveBeenCalledWith(7);
    expect(registry.snapshot(1).jobs).toEqual([]);
  });

  it("refuses to label a truncated job inventory as a stop-all plan", async () => {
    const client = new FakeSliverClient();
    client.jobState = Array.from({ length: 501 }, (_, index) => job(index + 1, 10_000 + index));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    expect(registry.snapshot(1).domains.jobs.page).toMatchObject({ total: 501, truncated: true });
    await expect(registry.prepareStopAllJobs(1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/inventory is truncated/),
    });
    expect(client.killJob).not.toHaveBeenCalled();
  });

  it("rechecks a stop plan after a blocked refresh before dispatching a kill", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    firstClient.jobState = [job(7, 7000)];
    const secondClient = new FakeSliverClient();
    const clients = [firstClient, secondClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectNamed(registry, 1, "operator");
    await connectNamed(registry, 2, "operator");
    const prepared = await registry.prepareStopJob(1, 7);
    if (!prepared.ok) throw new Error(prepared.error);
    const blockedJobs = deferred<clientpb.Job[]>();
    firstClient.nextJobsPromise = blockedJobs.promise;

    const execution = registry.executeStopPlan(1, prepared.value.token);
    await Promise.resolve();
    await connectNamed(registry, 1, "backend-b");
    blockedJobs.resolve([job(7, 7000)]);

    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/backend connection changed/),
    });
    expect(firstClient.killJob).not.toHaveBeenCalled();
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it("rejects stale read and mutation results after their window switches backends", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    const secondClient = new FakeSliverClient();
    const thirdClient = new FakeSliverClient();
    const clients = [firstClient, secondClient, thirdClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectNamed(registry, 1, "operator");
    await connectNamed(registry, 2, "operator");

    const staleJobs = deferred<clientpb.Job[]>();
    firstClient.nextJobsPromise = staleJobs.promise;
    const staleRefresh = registry.refresh(1);
    await Promise.resolve();
    await connectNamed(registry, 1, "backend-b");
    staleJobs.resolve([job(11, 1111)]);
    await expect(staleRefresh).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/backend connection changed/),
    });
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
    expect(registry.snapshot(1).jobs).toEqual([]);

    await connectNamed(registry, 1, "operator");
    const listener = deferred<clientpb.ListenerJob>();
    firstClient.startMTLSListener.mockImplementationOnce(async () => listener.promise);
    const staleMutation = registry.startListener(1, { kind: "mtls", host: "127.0.0.1", port: 9999 });
    await Promise.resolve();
    await connectNamed(registry, 1, "backend-b");
    listener.resolve(clientpb.ListenerJob.create({ JobID: 99 }));
    await expect(staleMutation).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/backend connection changed/),
    });
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it("uses authoritative compiler inventory and sanitizes bounded build summaries", async () => {
    const client = new FakeSliverClient();
    client.compilerState = clientpb.Compiler.create({
      Targets: [clientpb.CompilerTarget.create({ GOOS: "darwin", GOARCH: "arm64", Format: clientpb.OutputFormat.EXECUTABLE })],
    });
    client.buildState.Configs["existing"] = clientpb.ImplantConfig.create({
      ID: "build-id",
      GOOS: "darwin",
      GOARCH: "arm64",
      Format: clientpb.OutputFormat.EXECUTABLE,
      C2: [clientpb.ImplantC2.create({ URL: "https://user:password@c2.test:443/private?token=secret" })],
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    expect(registry.snapshot(1).compilerTargets).toEqual([
      { os: "darwin", arch: "arm64", format: "executable", supported: true },
    ]);
    expect(registry.snapshot(1).builds[0]?.c2).toEqual(["https://c2.test"]);
    expect(JSON.stringify(registry.snapshot(1))).not.toContain("password");
    expect(JSON.stringify(registry.snapshot(1))).not.toContain("secret");

    const input = cloneGenerateInput(defaultGenerateInput);
    input.name = "generated";
    input.os = "darwin";
    input.arch = "arm64";
    input.format = "executable";
    const generated = await registry.generate(sender(1), input);
    expect(generated).toMatchObject({ ok: true, value: { implantName: "generated", saved: false } });
    expect(client.generateImplant).toHaveBeenCalled();

    input.arch = "amd64";
    await expect(registry.generate(sender(1), input)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot build/),
    });
  });

  it("bounds server artifact metadata and never uses a server path as the native save default", async () => {
    const client = new FakeSliverClient();
    client.compilerState = clientpb.Compiler.create({
      Targets: [clientpb.CompilerTarget.create({ GOOS: "darwin", GOARCH: "arm64", Format: clientpb.OutputFormat.EXECUTABLE })],
    });
    const artifact = Buffer.from("artifact");
    client.generateImplant.mockResolvedValueOnce(clientpb.Generate.create({
      ImplantName: `implant\n${"x".repeat(500)}`,
      ImplantBuildID: `build-${"y".repeat(500)}`,
      File: { Name: "C:\\Users\\alice\\private\\secret.bin", Data: artifact },
    }));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const input = cloneGenerateInput(defaultGenerateInput);
    input.name = "generated";
    input.os = "darwin";
    input.arch = "arm64";
    input.format = "executable";
    const generated = await registry.generate(sender(1), input);

    expect(electronMocks.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: "secret.bin" }),
    );
    expect(generated).toMatchObject({ ok: true, value: { fileName: "secret.bin", saved: false } });
    if (!generated.ok) throw new Error(generated.error);
    expect(generated.value.implantName.length).toBeLessThanOrEqual(256);
    expect(generated.value.buildId.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(generated.value)).not.toMatch(/Users|alice|private|\\n/u);
    expect([...artifact]).toEqual(new Array(artifact.length).fill(0));
  });

  it("maps native filesystem failures to bounded path-free operation errors", async () => {
    const client = new FakeSliverClient();
    client.compilerState = clientpb.Compiler.create({
      Targets: [clientpb.CompilerTarget.create({ GOOS: "darwin", GOARCH: "arm64", Format: clientpb.OutputFormat.EXECUTABLE })],
    });
    const privatePath = "/Users/alice/.ssh/operator-private-key";
    electronMocks.showSaveDialog.mockRejectedValueOnce(
      Object.assign(new Error(`EACCES: permission denied, open '${privatePath}'`), {
        code: "EACCES",
        path: privatePath,
      }),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const input = cloneGenerateInput(defaultGenerateInput);
    input.name = "generated";
    input.os = "darwin";
    input.arch = "arm64";
    input.format = "executable";
    const generated = await registry.generate(sender(1), input);

    expect(generated).toEqual({ ok: false, error: "A local file operation was denied by the operating system" });
    expect(JSON.stringify(generated)).not.toContain(privatePath);
  });

  it("reconciles build and profile mutations through their own domain stores", async () => {
    const client = new FakeSliverClient();
    client.compilerState = clientpb.Compiler.create({
      Targets: [clientpb.CompilerTarget.create({ GOOS: "darwin", GOARCH: "arm64", Format: clientpb.OutputFormat.EXECUTABLE })],
    });
    client.buildState.Configs["existing"] = clientpb.ImplantConfig.create({
      ID: "existing-id",
      GOOS: "darwin",
      GOARCH: "arm64",
      Format: clientpb.OutputFormat.EXECUTABLE,
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = domainCallCounts(client);

    await expect(registry.setStagedBuilds(1, ["existing"])).resolves.toEqual({ ok: true });
    expect(registry.snapshot(1).builds[0]?.staged).toBe(true);
    expect(domainCallCounts(client)).toEqual({ ...baselineCalls, builds: baselineCalls.builds + 1 });

    const input = cloneGenerateInput(defaultGenerateInput);
    input.os = "darwin";
    input.arch = "arm64";
    input.format = "executable";
    await expect(registry.saveProfile(1, { profileName: "saved", config: input, overwrite: false })).resolves.toMatchObject({
      ok: true,
      value: { name: "saved" },
    });
    expect(registry.snapshot(1).profiles.map((profile) => profile.name)).toContain("saved");
    await expect(registry.deleteProfile(1, "saved")).resolves.toEqual({ ok: true });
    expect(registry.snapshot(1).profiles).toEqual([]);

    await expect(registry.deleteBuild(1, "existing")).resolves.toEqual({ ok: true });
    expect(registry.snapshot(1).builds).toEqual([]);
  });

  it("rejects replace-all staging when unseen builds make the inventory non-authoritative", async () => {
    const client = new FakeSliverClient();
    for (let index = 0; index < 501; index += 1) {
      const name = `build-${String(index).padStart(3, "0")}`;
      client.buildState.Configs[name] = clientpb.ImplantConfig.create({
        ID: `${name}-id`,
        GOOS: "linux",
        GOARCH: "amd64",
        Format: clientpb.OutputFormat.EXECUTABLE,
      });
    }
    client.buildState.staged["build-500"] = true;
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    expect(registry.snapshot(1).domains.builds.page).toMatchObject({ total: 501, truncated: true });
    expect(registry.snapshot(1).builds.some((build) => build.name === "build-500")).toBe(false);
    await expect(registry.setStagedBuilds(1, ["build-000"])).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/complete build inventory is not authoritative/),
    });
    expect(client.stageImplantBuild).not.toHaveBeenCalled();
    expect(client.buildState.staged["build-500"]).toBe(true);
  });

  it("requires an authoritative profile inventory and explicit overwrite intent", async () => {
    const truncatedClient = new FakeSliverClient();
    truncatedClient.profileState.Profiles = Array.from({ length: 501 }, (_, index) =>
      clientpb.ImplantProfile.create({ ID: `profile-${index}`, Name: `profile-${String(index).padStart(3, "0")}` }),
    );
    const truncatedRegistry = createRegistry(() => truncatedClient.adapter);
    truncatedRegistry.registerWindow(1);
    await connectSaved(truncatedRegistry, 1);
    const input = cloneGenerateInput(defaultGenerateInput);

    await expect(
      truncatedRegistry.saveProfile(1, { profileName: "profile-500", config: input, overwrite: false }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/complete profile inventory/) });
    expect(truncatedClient.saveImplantProfile).not.toHaveBeenCalled();

    const currentClient = new FakeSliverClient();
    currentClient.profileState.Profiles = [clientpb.ImplantProfile.create({ ID: "existing-id", Name: "existing" })];
    const currentRegistry = createRegistry(() => currentClient.adapter);
    currentRegistry.registerWindow(2);
    await connectSaved(currentRegistry, 2);
    await expect(
      currentRegistry.saveProfile(2, { profileName: "existing", config: input, overwrite: false }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/confirm replacement/) });
    expect(currentClient.saveImplantProfile).not.toHaveBeenCalled();
    await expect(
      currentRegistry.saveProfile(2, { profileName: "existing", config: input, overwrite: true }),
    ).resolves.toMatchObject({ ok: true, value: { name: "existing" } });
    expect(currentClient.saveImplantProfile).toHaveBeenCalledOnce();
  });

  it("shares identical credentials while preserving each window's local configuration alias", async () => {
    const sameConfig = validConfig();
    await writeFile(join(externalDirectory, "Alpha.cfg"), sameConfig);
    await writeFile(join(externalDirectory, "Beta.cfg"), sameConfig);
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000)];
    const factory = vi.fn(() => client.adapter);
    const registry = createRegistry(factory);
    registry.registerWindow(1);
    registry.registerWindow(2);

    await connectNamed(registry, 1, "Alpha");
    await connectNamed(registry, 2, "Beta");

    expect(factory).toHaveBeenCalledOnce();
    expect(registry.snapshot(1).connection.configName).toBe("Alpha");
    expect(registry.snapshot(2).connection.configName).toBe("Beta");
    const firstPlan = await registry.prepareStopJob(1, 7);
    const secondPlan = await registry.prepareStopJob(2, 7);
    expect(firstPlan).toMatchObject({ ok: true, value: { impact: { backend: { configName: "Alpha" } } } });
    expect(secondPlan).toMatchObject({ ok: true, value: { impact: { backend: { configName: "Beta" } } } });
  });

  it("surfaces reconnecting and incompatible connection states", async () => {
    vi.useFakeTimers();
    const reconnectingClient = new FakeSliverClient();
    const registry = createRegistry(() => reconnectingClient.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    reconnectingClient.streamStates.next({ status: "retrying", attempt: 1, error: "temporary failure" });
    expect(registry.snapshot(1).connection.status).toBe("reconnecting");
    reconnectingClient.streamStates.next({ status: "connected", attempt: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.snapshot(1).connection.status).toBe("connected");

    await registry.disconnect(1);
    const incompatibleClient = new FakeSliverClient();
    incompatibleClient.getVersion.mockResolvedValue(version({ Major: 2, Commit: "breaking" }));
    const incompatibleRegistry = createRegistry(() => incompatibleClient.adapter);
    incompatibleRegistry.registerWindow(2);
    const listed = await incompatibleRegistry.listSavedConfigs(2);
    if (!listed.ok) throw new Error(listed.error);
    const result = await incompatibleRegistry.connectSavedConfig(2, listed.value[0]!.id);
    expect(result).toMatchObject({ ok: false });
    expect(incompatibleRegistry.snapshot(2).connection.status).toBe("incompatible");
    expect(incompatibleRegistry.snapshot(2).domains.compiler.status).toBe("unsupported");
  });

  it("keeps an empty compiler inventory authoritative and never fabricates targets", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    expect(registry.snapshot(1).domains.compiler.status).toBe("empty");
    expect(registry.snapshot(1).compilerTargets).toEqual([]);
    await expect(registry.generate(sender(1), cloneGenerateInput(defaultGenerateInput))).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not currently authoritative/),
    });
  });

  it("discovers but refuses a WireGuard operator config before constructing a client", async () => {
    const wireGuardPath = join(externalDirectory, "wireguard.cfg");
    await writeFile(wireGuardPath, validConfig({ wg: wireGuardConfig() }));
    const factory = vi.fn(() => new FakeSliverClient().adapter);
    const registry = createRegistry(factory);
    registry.registerWindow(1);
    const listed = await registry.listSavedConfigs(1);
    if (!listed.ok) throw new Error(listed.error);
    const wireGuard = listed.value.find((summary) => summary.transport === "wireguard");
    expect(wireGuard).toMatchObject({ availability: "deferred" });

    await expect(registry.connectSavedConfig(1, wireGuard!.id)).resolves.toEqual({
      ok: false,
      error: "WireGuard operator connections are deferred for this milestone",
    });
    expect(factory).not.toHaveBeenCalled();

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [wireGuardPath] });
    await expect(registry.chooseAndConnect(sender(1))).resolves.toEqual({
      ok: false,
      error: "WireGuard operator connections are deferred for this milestone",
    });
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("server compatibility and event redaction", () => {
  it("distinguishes the pinned baseline, unverified compatible builds, and unsupported majors", () => {
    expect(negotiateServerVersion(version({ Commit: SLIVER_PROTOCOL_BASELINE_COMMIT }))).toEqual({
      compatibility: "supported",
    });
    expect(negotiateServerVersion(version({ Commit: "different" }))).toMatchObject({ compatibility: "degraded" });
    expect(negotiateServerVersion(version({ Major: 2, Commit: "different" }))).toMatchObject({
      compatibility: "unsupported",
    });
  });

  it("never copies arbitrary Data or Err payloads into event summaries", () => {
    const summary = summarizeEvent(
      clientpb.Event.create({
        EventType: "loot-added",
        Data: Buffer.from("credential-password"),
        Err: "token=server-secret",
      }),
    );

    expect(summary).toMatchObject({ type: "loot-added", message: "Loot inventory changed", isError: true });
    expect(JSON.stringify(summary)).not.toMatch(/credential-password|server-secret/u);
  });
});

class FakeSliverClient {
  readonly events = new Subject<clientpb.Event>();
  readonly streamStates = new BehaviorSubject<SliverEventStreamState>({ status: "connected", attempt: 0 });
  jobState: clientpb.Job[] = [];
  buildState = clientpb.ImplantBuilds.create({ Configs: {}, ResourceIDs: {}, staged: {} });
  profileState = clientpb.ImplantProfiles.create({ Profiles: [] });
  compilerState = clientpb.Compiler.create({ Targets: [], UnsupportedTargets: [] });
  nextJobsError: Error | undefined;
  nextJobsPromise: Promise<clientpb.Job[]> | undefined;
  nextProfilesError: Error | undefined;
  nextProfilesPromise: Promise<clientpb.ImplantProfiles> | undefined;

  readonly connect = vi.fn(async (): Promise<unknown> => {
    return this;
  });
  readonly disconnect = vi.fn(async () => undefined);
  readonly getVersion = vi.fn(async () => version({ Commit: SLIVER_PROTOCOL_BASELINE_COMMIT }));
  readonly jobs = vi.fn(async () => {
    if (this.nextJobsError) {
      const error = this.nextJobsError;
      this.nextJobsError = undefined;
      throw error;
    }
    if (this.nextJobsPromise) {
      const promise = this.nextJobsPromise;
      this.nextJobsPromise = undefined;
      return promise;
    }
    return this.jobState.map((item) => clientpb.Job.create(item));
  });
  readonly implantBuilds = vi.fn(async () => clientpb.ImplantBuilds.create(this.buildState));
  readonly implantProfiles = vi.fn(async () => {
    if (this.nextProfilesError) {
      const error = this.nextProfilesError;
      this.nextProfilesError = undefined;
      throw error;
    }
    if (this.nextProfilesPromise) {
      const promise = this.nextProfilesPromise;
      this.nextProfilesPromise = undefined;
      return promise;
    }
    return clientpb.ImplantProfiles.create(this.profileState);
  });
  readonly getCompiler = vi.fn(async () => clientpb.Compiler.create(this.compilerState));
  readonly startMTLSListener = vi.fn(async (host: string, port: number) => this.addListener("mtls", host, port));
  readonly startWGListener = vi.fn(async (host: string, port: number) => this.addListener("wireguard", host, port));
  readonly startDNSListener = vi.fn(async (_domains: string[], _canaries: boolean, host: string, port: number) =>
    this.addListener("dns", host, port),
  );
  readonly startHTTPListenerWithOptions = vi.fn(async (options: { host: string; port: number }) =>
    this.addListener("http", options.host, options.port),
  );
  readonly startHTTPSListenerWithOptions = vi.fn(async (options: { host: string; port: number }) =>
    this.addListener("https", options.host, options.port),
  );
  readonly startTCPStagerListenerWithOptions = vi.fn(async (options: { Host: string; Port: number }) =>
    this.addListener("stage", options.Host, options.Port),
  );
  readonly killJob = vi.fn(async (jobId: number) => {
    const exists = this.jobState.some((item) => item.ID === jobId);
    this.jobState = this.jobState.filter((item) => item.ID !== jobId);
    return clientpb.KillJob.create({ ID: jobId, Success: exists });
  });
  readonly generateUniqueIP = vi.fn(async () => clientpb.UniqueWGIP.create({ IP: "100.64.0.2" }));
  readonly generateImplant = vi.fn(async (config: clientpb.ImplantConfig, requestedName = "") => {
    const name = requestedName || "generated";
    this.buildState.Configs[name] = clientpb.ImplantConfig.create(config);
    return clientpb.Generate.create({
      ImplantName: name,
      ImplantBuildID: `build-${name}`,
      File: { Name: `${name}.bin`, Data: Buffer.from("artifact") },
    });
  });
  readonly regenerateImplant = vi.fn(async (name: string) =>
    clientpb.Generate.create({
      ImplantName: name,
      ImplantBuildID: `build-${name}`,
      File: { Name: `${name}.bin`, Data: Buffer.from("artifact") },
    }),
  );
  readonly deleteImplantBuild = vi.fn(async (name: string) => {
    delete this.buildState.Configs[name];
  });
  readonly stageImplantBuild = vi.fn(async (names: string[]) => {
    this.buildState.staged = Object.fromEntries(names.map((name) => [name, true]));
  });
  readonly saveImplantProfile = vi.fn(async (profile: clientpb.ImplantProfile) => {
    const existing = this.profileState.Profiles.findIndex((item) => item.Name === profile.Name);
    if (existing >= 0) this.profileState.Profiles[existing] = clientpb.ImplantProfile.create(profile);
    else this.profileState.Profiles.push(clientpb.ImplantProfile.create(profile));
    return clientpb.ImplantProfile.create(profile);
  });
  readonly deleteImplantProfile = vi.fn(async (name: string) => {
    this.profileState.Profiles = this.profileState.Profiles.filter((item) => item.Name !== name);
  });

  readonly adapter = {
    connect: this.connect,
    disconnect: this.disconnect,
    getVersion: this.getVersion,
    jobs: this.jobs,
    implantBuilds: this.implantBuilds,
    implantProfiles: this.implantProfiles,
    getCompiler: this.getCompiler,
    startMTLSListener: this.startMTLSListener,
    startWGListener: this.startWGListener,
    startDNSListener: this.startDNSListener,
    startHTTPListenerWithOptions: this.startHTTPListenerWithOptions,
    startHTTPSListenerWithOptions: this.startHTTPSListenerWithOptions,
    startTCPStagerListenerWithOptions: this.startTCPStagerListenerWithOptions,
    killJob: this.killJob,
    generateUniqueIP: this.generateUniqueIP,
    generateImplant: this.generateImplant,
    regenerateImplant: this.regenerateImplant,
    deleteImplantBuild: this.deleteImplantBuild,
    stageImplantBuild: this.stageImplantBuild,
    saveImplantProfile: this.saveImplantProfile,
    deleteImplantProfile: this.deleteImplantProfile,
    event$: this.events.asObservable(),
    eventStreamState$: this.streamStates.asObservable(),
  } as unknown as SliverClientAdapter;

  private addListener(protocol: string, _host: string, port: number): clientpb.ListenerJob {
    const id = Math.max(0, ...this.jobState.map((item) => item.ID)) + 1;
    this.jobState.push(job(id, port, protocol));
    return clientpb.ListenerJob.create({ JobID: id });
  }
}

function createRegistry(factory: () => SliverClientAdapter): ConnectionRegistry {
  const registry = new ConnectionRegistry({
    savedConfigDirectory: externalDirectory,
    managedConfigDirectory: managedDirectory,
    clientFactory: factory,
  });
  registries.push(registry);
  return registry;
}

async function connectSaved(registry: ConnectionRegistry, contentsId: number): Promise<void> {
  const listed = await registry.listSavedConfigs(contentsId);
  if (!listed.ok) throw new Error(listed.error);
  const config = listed.value.find((summary) => summary.transport === "mtls");
  if (!config) throw new Error("Expected an mTLS config");
  const connected = await registry.connectSavedConfig(contentsId, config.id);
  if (!connected.ok) throw new Error(connected.error);
}

async function connectNamed(registry: ConnectionRegistry, contentsId: number, displayName: string): Promise<void> {
  const listed = await registry.listSavedConfigs(contentsId);
  if (!listed.ok) throw new Error(listed.error);
  const config = listed.value.find((summary) => summary.displayName === displayName);
  if (!config) throw new Error(`Expected saved configuration '${displayName}'`);
  const connected = await registry.connectSavedConfig(contentsId, config.id);
  if (!connected.ok) throw new Error(connected.error);
}

function domainCallCounts(client: FakeSliverClient): Record<"jobs" | "builds" | "profiles" | "compiler", number> {
  return {
    jobs: client.jobs.mock.calls.length,
    builds: client.implantBuilds.mock.calls.length,
    profiles: client.implantProfiles.mock.calls.length,
    compiler: client.getCompiler.mock.calls.length,
  };
}

function sender(id: number): WebContents {
  return { id, isDestroyed: () => false } as unknown as WebContents;
}

function job(id: number, port: number, protocol = "mtls"): clientpb.Job {
  return clientpb.Job.create({
    ID: id,
    Name: `${protocol}-listener`,
    Description: "Listener",
    Protocol: protocol,
    Port: port,
    Domains: [],
    ProfileName: "",
  });
}

function version(overrides: Partial<clientpb.Version> = {}): clientpb.Version {
  return clientpb.Version.create({
    Major: 1,
    Minor: 7,
    Patch: 5,
    Commit: "different",
    Dirty: false,
    CompiledAt: "",
    OS: "linux",
    Arch: "amd64",
    ...overrides,
  });
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
