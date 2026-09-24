// @vitest-environment node

import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessagePortMain, WebContents } from "electron";
import { BehaviorSubject, Subject } from "rxjs";
import { clientpb, sliverpb, type SliverEventStreamState } from "sliver-script";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cloneGenerateInput, defaultGenerateInput } from "../shared/generate-defaults.js";
import { IPC, SLIVER_PROTOCOL_BASELINE_COMMIT, type ManagedCloudOverview, type ManagedServerReference, type SliverSnapshot } from "../shared/contracts.js";
import { OPERATOR_DATA_LIMITS } from "../shared/operator-data-contracts.js";
import type { SessionStoredArtifact } from "../shared/session-contracts.js";
import {
  STREAM_PROTOCOL_VERSION,
  type PrepareSessionShellInput,
  type SessionShellPlan,
  type StreamClientFrame,
  type StreamServerFrame,
  type TerminalRuntimeAsset,
} from "../shared/stream-contracts.js";

const electronMocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  fromId: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  clipboardText: "",
  clipboardReadText: vi.fn(),
  clipboardWriteText: vi.fn(),
  clipboardClear: vi.fn(),
}));

const terminalRuntimeMocks = vi.hoisted(() => ({
  loadTerminalRuntime: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: electronMocks.fromWebContents },
  clipboard: {
    readText: electronMocks.clipboardReadText,
    writeText: electronMocks.clipboardWriteText,
    clear: electronMocks.clipboardClear,
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
    showSaveDialog: electronMocks.showSaveDialog,
  },
  webContents: { fromId: electronMocks.fromId },
}));

vi.mock("./terminal-runtime.js", () => ({
  loadTerminalRuntime: terminalRuntimeMocks.loadTerminalRuntime,
}));

import {
  ConnectionRegistry,
  negotiateServerVersion,
  summarizeEvent,
  type SliverClientAdapter,
} from "./connection-registry.js";
import { BeaconTaskStore } from "./beacon-task-store.js";
import type { OperationEngine } from "./operation-engine.js";

let root: string;
let externalDirectory: string;
let managedDirectory: string;
const registries: ConnectionRegistry[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sliver-gui-registry-fake-"));
  externalDirectory = join(root, "external");
  managedDirectory = join(root, "managed");
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, "operator.cfg"), validConfig(), { mode: 0o600 });
  electronMocks.fromWebContents.mockReset();
  electronMocks.fromWebContents.mockReturnValue({ isDestroyed: () => false });
  electronMocks.fromId.mockReset();
  electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send: vi.fn() });
  electronMocks.showOpenDialog.mockReset();
  electronMocks.showSaveDialog.mockReset();
  electronMocks.showSaveDialog.mockResolvedValue({ canceled: true });
  electronMocks.clipboardText = "";
  electronMocks.clipboardReadText.mockReset();
  electronMocks.clipboardReadText.mockImplementation(() => electronMocks.clipboardText);
  electronMocks.clipboardWriteText.mockReset();
  electronMocks.clipboardWriteText.mockImplementation((value: string) => { electronMocks.clipboardText = value; });
  electronMocks.clipboardClear.mockReset();
  electronMocks.clipboardClear.mockImplementation(() => { electronMocks.clipboardText = ""; });
  terminalRuntimeMocks.loadTerminalRuntime.mockReset();
  terminalRuntimeMocks.loadTerminalRuntime.mockResolvedValue(terminalRuntimeAsset());
});

afterEach(async () => {
  vi.useRealTimers();
  for (const registry of registries.splice(0)) {
    await registry.unregisterWindow(1);
    await registry.unregisterWindow(2);
    await registry.unregisterWindow(3);
  }
  await rm(root, { recursive: true, force: true });
});

describe("passive infrastructure service inventory", () => {
  function services(client: FakeSliverClient) {
    const getExternalBuilders = vi.fn().mockResolvedValue(clientpb.Builders.create({ Builders: [
      { Name: "linux-builder", GOOS: "linux", GOARCH: "amd64", OperatorName: "builder-operator", Templates: ["excluded-template"] },
    ] }));
    const getCrackstations = vi.fn().mockResolvedValue(clientpb.Crackstations.create({ Crackstations: [
      { HostUUID: "station-host", Name: "Station", GOOS: "linux", GOARCH: "amd64", Version: "1.0", Benchmarks: { 1: "excluded-benchmark" } },
    ] }));
    client.adapter.getExternalBuilders = getExternalBuilders;
    client.adapter.getCrackstations = getCrackstations;
    return { getExternalBuilders, getCrackstations };
  }

  it("publishes bounded service metadata independently from selectable targets", async () => {
    const client = new FakeSliverClient();
    const queries = services(client);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const snapshot = registry.snapshot(1);
    expect(snapshot.infrastructureServices?.builders).toMatchObject({ status: "ready", revision: 1, items: [
      { id: "linux-builder", name: "linux-builder", os: "linux", arch: "amd64", operatorName: "builder-operator" },
    ] });
    expect(snapshot.infrastructureServices?.crackstations).toMatchObject({ status: "ready", revision: 1, items: [
      { id: "station-host", name: "Station", version: "1.0" },
    ] });
    expect(queries.getExternalBuilders).toHaveBeenCalledExactlyOnceWith();
    expect(queries.getCrackstations).toHaveBeenCalledExactlyOnceWith();
    expect(snapshot.targetContext.selectableTargets).toEqual([]);
    expect(JSON.stringify(snapshot.infrastructureServices)).not.toContain("excluded-");
  });

  it.each(["builders", "crackstations"] as const)("isolates %s errors, retains last-known data, and removes absent services after recovery", async (domain) => {
    const client = new FakeSliverClient();
    const queries = services(client);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const previous = registry.snapshot(1).infrastructureServices![domain];
    const query = domain === "builders" ? queries.getExternalBuilders : queries.getCrackstations;
    query.mockRejectedValueOnce(new Error("Service inventory unavailable"));

    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });

    expect(registry.snapshot(1).infrastructureServices![domain]).toEqual({ ...previous, status: "error", error: "Service inventory unavailable" });
    expect(registry.snapshot(1).connection.status).toBe("degraded");
    expect(registry.snapshot(1).domains.sessions.status).toBe("empty");
    query.mockResolvedValue(domain === "builders" ? clientpb.Builders.create({}) : clientpb.Crackstations.create({}));
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1).infrastructureServices![domain]).toMatchObject({ status: "empty", items: [], revision: previous.revision + 1 });
    expect(registry.snapshot(1).infrastructureServices![domain]).not.toHaveProperty("error");
    expect(registry.snapshot(1).connection.status).toBe("connected");
  });

  it("keeps a prior station inventory when a malformed replacement is returned", async () => {
    const client = new FakeSliverClient();
    const queries = services(client);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const previous = registry.snapshot(1).infrastructureServices!.crackstations.items;
    queries.getCrackstations.mockResolvedValue(clientpb.Crackstations.create({ Crackstations: [{ Name: "No stable identity" }] }));
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1).infrastructureServices!.crackstations).toMatchObject({ status: "error", items: previous });
    expect(registry.snapshot(1).infrastructureServices!.builders.status).toBe("ready");
  });

  it("handles missing and unimplemented optional service APIs without failing core inventories", async () => {
    const client = new FakeSliverClient();
    client.adapter.getCrackstations = vi.fn().mockRejectedValue(Object.assign(new Error("UNIMPLEMENTED"), { code: 12 }));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    expect(registry.snapshot(1).infrastructureServices).toMatchObject({
      builders: { status: "unsupported", items: [] }, crackstations: { status: "unsupported", items: [] },
    });
    expect(registry.snapshot(1).connection.status).toBe("connected");
  });

  it("refreshes service presence on relevant events and periodic reconciliation", async () => {
    vi.useFakeTimers();
    const client = new FakeSliverClient();
    const queries = services(client);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    client.events.next(clientpb.Event.create({ EventType: "crackstation-disconnected" }));
    await vi.advanceTimersByTimeAsync(101);
    expect(queries.getCrackstations).toHaveBeenCalledTimes(2);
    expect(queries.getExternalBuilders).toHaveBeenCalledTimes(1);
    client.events.next(clientpb.Event.create({ EventType: "client-joined" }));
    await vi.advanceTimersByTimeAsync(101);
    expect(queries.getExternalBuilders).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queries.getExternalBuilders).toHaveBeenCalledTimes(3);
    expect(queries.getCrackstations).toHaveBeenCalledTimes(3);
  });

  it("discards delayed service responses after disconnect and a new backend connection", async () => {
    const first = new FakeSliverClient();
    const second = new FakeSliverClient();
    const queries = services(first);
    const clients = [first, second];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const pending = deferred<clientpb.Crackstations>();
    queries.getCrackstations.mockReturnValueOnce(pending.promise);
    const refresh = registry.refresh(1);
    await vi.waitFor(() => expect(queries.getCrackstations).toHaveBeenCalledTimes(2));
    await registry.disconnect(1);
    expect(registry.snapshot(1).infrastructureServices).toBeUndefined();
    await connectSaved(registry, 1);
    const current = registry.snapshot(1).infrastructureServices;
    pending.resolve(clientpb.Crackstations.create({ Crackstations: [{ HostUUID: "old-host", Name: "Old station" }] }));
    await expect(refresh).resolves.toMatchObject({ ok: false });
    expect(registry.snapshot(1).infrastructureServices).toEqual(current);
  });
});

describe("passive pivot topology inventory", () => {
  function graph(childPeer = "3"): clientpb.PivotGraph {
    return clientpb.PivotGraph.create({ Children: [{
      PeerID: "1", Name: "parent", Session: { ID: "session-parent", Name: "parent" },
      Children: [{ PeerID: "2", Name: "relay", Children: [{
        PeerID: childPeer, Name: "child", Session: { ID: "session-child", Name: "child", ProxyURL: "https://user:private-topology-secret@example.invalid" },
      }] }],
    }] });
  }

  it("publishes normalized server hierarchy during inventory refresh without creating selectable targets", async () => {
    const send = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const client = new FakeSliverClient();
    const getPivotGraph = vi.fn().mockResolvedValue(graph());
    client.adapter.getPivotGraph = getPivotGraph;
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);

    await connectSaved(registry, 1);

    expect(getPivotGraph).toHaveBeenCalledExactlyOnceWith();
    const snapshot = registry.snapshot(1);
    expect(snapshot.pivotTopology).toEqual({
      status: "ready", revision: 1, updatedAt: expect.any(String), truncated: false,
      entries: [
        { peerId: "1", parentPeerId: null, sessionId: "session-parent", name: "parent" },
        { peerId: "2", parentPeerId: "1", name: "relay" },
        { peerId: "3", parentPeerId: "2", sessionId: "session-child", name: "child" },
      ],
    });
    expect(snapshot.targetContext.selectableTargets).toEqual([]);
    expect(send).toHaveBeenCalledWith(IPC.snapshotChanged, expect.objectContaining({ pivotTopology: snapshot.pivotTopology }));
    expect(JSON.stringify(snapshot)).not.toContain("private-topology-secret");
    expect(client.pingSession).not.toHaveBeenCalled();
    expect(client.pingBeacon).not.toHaveBeenCalled();

    getPivotGraph.mockResolvedValue(graph("4"));
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(getPivotGraph).toHaveBeenCalledTimes(2);
    expect(registry.snapshot(1).pivotTopology).toMatchObject({ status: "ready", revision: 2,
      entries: expect.arrayContaining([expect.objectContaining({ peerId: "4", parentPeerId: "2" })]) });
  });

  it("refreshes passive topology when a session event invalidates the inventory", async () => {
    vi.useFakeTimers();
    const client = new FakeSliverClient();
    const getPivotGraph = vi.fn().mockResolvedValue(graph());
    client.adapter.getPivotGraph = getPivotGraph;
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionsBefore = client.getSessions.mock.calls.length;
    getPivotGraph.mockResolvedValue(graph("4"));

    client.events.next(clientpb.Event.create({ EventType: "session-updated", Session: { ID: "session-child" } }));
    await vi.advanceTimersByTimeAsync(101);

    expect(client.getSessions).toHaveBeenCalledTimes(sessionsBefore + 1);
    expect(getPivotGraph).toHaveBeenCalledTimes(2);
    expect(registry.snapshot(1).pivotTopology).toMatchObject({ status: "ready", revision: 2,
      entries: expect.arrayContaining([expect.objectContaining({ peerId: "4", parentPeerId: "2" })]) });
  });

  it.each(["failed-query", "invalid-graph"])("retains last known topology with an explicit error after %s", async (failure) => {
    const client = new FakeSliverClient();
    const getPivotGraph = vi.fn().mockResolvedValue(graph());
    client.adapter.getPivotGraph = getPivotGraph;
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const previous = registry.snapshot(1).pivotTopology!;
    const sessionReads = client.getSessions.mock.calls.length;
    if (failure === "failed-query") getPivotGraph.mockRejectedValueOnce(new Error("Pivot inventory is temporarily unavailable"));
    else getPivotGraph.mockResolvedValueOnce(clientpb.PivotGraph.create({ Children: [{ PeerID: "1" }, { PeerID: "1" }] }));

    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });

    expect(registry.snapshot(1).pivotTopology).toEqual({ ...previous, status: "error", error: expect.any(String) });
    expect(registry.snapshot(1).connection.status).toBe("degraded");
    expect(client.getSessions).toHaveBeenCalledTimes(sessionReads + 1);
    expect(registry.snapshot(1).domains.sessions).toMatchObject({ status: "empty", items: [] });
    getPivotGraph.mockResolvedValue(graph("4"));
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1).pivotTopology).toMatchObject({ status: "ready", revision: previous.revision + 1 });
    expect(registry.snapshot(1).pivotTopology).not.toHaveProperty("error");
  });

  it("treats an unimplemented passive graph RPC as unsupported without degrading other inventory", async () => {
    const client = new FakeSliverClient();
    const getPivotGraph = vi.fn().mockRejectedValue(Object.assign(new Error("UNIMPLEMENTED"), { code: 12 }));
    client.adapter.getPivotGraph = getPivotGraph;
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);

    await connectSaved(registry, 1);
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });

    expect(registry.snapshot(1).pivotTopology).toEqual({ status: "unsupported", revision: 0, entries: [], truncated: false });
    expect(registry.snapshot(1).connection.status).toBe("connected");
    expect(registry.snapshot(1).domains.sessions.status).toBe("empty");
  });

  it("supports adapters without the optional passive graph method", async () => {
    const client = new FakeSliverClient();
    expect(client.adapter.getPivotGraph).toBeUndefined();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    expect(registry.snapshot(1).pivotTopology).toMatchObject({ status: "unsupported", entries: [] });
    expect(registry.snapshot(1).connection.status).toBe("connected");
  });

  it("discards a graph reply from a disconnected backend after another connection is established", async () => {
    const first = new FakeSliverClient();
    const second = new FakeSliverClient();
    const getPivotGraph = vi.fn().mockResolvedValue(graph());
    first.adapter.getPivotGraph = getPivotGraph;
    second.adapter.getPivotGraph = vi.fn().mockResolvedValue(clientpb.PivotGraph.create({ Children: [{ PeerID: "99", Name: "new-server" }] }));
    const clients = [first, second];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const oldEpoch = registry.snapshot(1).connection.epoch;
    const pending = deferred<clientpb.PivotGraph>();
    getPivotGraph.mockReturnValueOnce(pending.promise);
    const refresh = registry.refresh(1);
    await vi.waitFor(() => expect(getPivotGraph).toHaveBeenCalledTimes(2));

    await registry.disconnect(1);
    expect(registry.snapshot(1).pivotTopology).toBeUndefined();
    await connectSaved(registry, 1);
    const current = registry.snapshot(1);
    expect(current.connection.epoch).toBeGreaterThan(oldEpoch ?? 0);
    expect(current.pivotTopology).toMatchObject({ status: "ready", entries: [{ peerId: "99", parentPeerId: null, name: "new-server" }] });
    pending.resolve(graph("4"));
    await expect(refresh).resolves.toMatchObject({ ok: false });
    await Promise.resolve();

    expect(registry.snapshot(1).connection.epoch).toBe(current.connection.epoch);
    expect(registry.snapshot(1).pivotTopology).toEqual(current.pivotTopology);
    expect(first.disconnect).toHaveBeenCalledOnce();
  });
});

describe("managed server connection metadata", () => {
  const managedServer: ManagedServerReference = {
    deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0010",
    provider: "aws",
    name: "Managed test server",
  };
  const configDigest = createHash("sha256").update(validConfig()).digest("hex");

  it("includes provenance in the first connected event without exposing the config digest", async () => {
    const send = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    const resolve = vi.fn((digest: string) => digest === configDigest ? managedServer : null);
    registry.setManagedServerResolver(resolve);
    registry.registerWindow(1);
    expect(registry.snapshot(1).connection.managedServer).toBeNull();

    await connectSaved(registry, 1);

    const snapshots = send.mock.calls
      .filter(([channel]) => channel === IPC.snapshotChanged)
      .map(([, snapshot]) => snapshot as SliverSnapshot);
    const connected = snapshots.filter(({ connection }) => connection.status === "connected");
    expect(connected.length).toBeGreaterThan(0);
    expect(connected.every(({ connection }) => connection.managedServer?.deploymentId === managedServer.deploymentId)).toBe(true);
    expect(snapshots.filter(({ connection }) => connection.status === "connecting")
      .every(({ connection }) => connection.managedServer === null)).toBe(true);
    expect(resolve).toHaveBeenCalledWith(configDigest);
    expect(JSON.stringify(snapshots)).not.toContain(configDigest);
    expect(registry.networkContext(1)).toMatchObject({ ok: true, value: { connection: { managedServer } } });
  });

  it("keeps different windows independent and recognizes copied config bytes", async () => {
    await writeFile(join(externalDirectory, "copy.cfg"), validConfig());
    await writeFile(join(externalDirectory, "other.cfg"), validConfig({ operator: "other" }));
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.setManagedServerResolver((digest) => digest === configDigest ? managedServer : null);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectNamed(registry, 1, "copy");
    await connectNamed(registry, 2, "other");

    expect(registry.snapshot(1).connection.managedServer).toEqual(managedServer);
    expect(registry.snapshot(2).connection.managedServer).toBeNull();
    await connectNamed(registry, 1, "other");
    expect(registry.snapshot(1).connection.managedServer).toBeNull();
  });

  it("inherits provenance and retains it through reconnecting and degraded health", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => managedServer);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);

    client.streamStates.next({ status: "retrying", attempt: 1 });
    for (const id of [1, 2]) {
      expect(registry.snapshot(id).connection).toMatchObject({ status: "reconnecting", managedServer });
    }
    client.streamStates.next({ status: "stopped", attempt: 1 });
    expect(registry.snapshot(2).connection).toMatchObject({ status: "degraded", managedServer });
    await registry.disconnect(1);
    expect(registry.snapshot(1).connection.managedServer).toBeNull();
    expect(registry.snapshot(2).connection.managedServer).toEqual(managedServer);
  });

  it("republishes metadata changes and deletion without reconnecting", async () => {
    const send = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    let current: ManagedServerReference | null = managedServer;
    registry.setManagedServerResolver(() => current);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    send.mockClear();

    registry.refreshManagedServerMetadata();
    expect(send).not.toHaveBeenCalled();
    current = { ...managedServer, name: "Renamed" };
    registry.refreshManagedServerMetadata();
    expect(send).toHaveBeenCalledWith(IPC.snapshotChanged, expect.objectContaining({
      connection: expect.objectContaining({ managedServer: current }),
    }));
    current = null;
    registry.refreshManagedServerMetadata();
    expect(send).toHaveBeenLastCalledWith("sliver:network-forwarding:changed");
    expect(registry.snapshot(1).connection.managedServer).toBeNull();
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("publishes cached cloud display updates to shared windows without reconnecting", async () => {
    const send = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    let current: ManagedServerReference = {
      ...managedServer,
      overview: {
        region: "us-west-2",
        size: "t3.small",
        instanceState: "running",
        health: "ok",
        publicIpAddress: "198.51.100.24",
        privateIpAddress: "10.0.0.24",
        updatedAt: "2026-09-18T12:00:00.000Z",
      },
    };
    registry.setManagedServerResolver(() => current);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    send.mockClear();

    current = { ...current, overview: { ...current.overview! } };
    registry.refreshManagedServerMetadata();
    expect(send).not.toHaveBeenCalled();

    current = {
      ...current,
      overview: { ...current.overview!, instanceState: "stopped", updatedAt: "2026-09-18T12:01:00.000Z" },
    };
    registry.refreshManagedServerMetadata();
    expect(send.mock.calls.filter(([channel]) => channel === IPC.snapshotChanged)).toHaveLength(2);
    for (const id of [1, 2]) expect(registry.snapshot(id).connection.managedServer).toEqual(current);

    send.mockClear();
    current = managedServer;
    registry.refreshManagedServerMetadata();
    expect(send.mock.calls.filter(([channel]) => channel === IPC.snapshotChanged)).toHaveLength(2);
    for (const id of [1, 2]) expect(registry.snapshot(id).connection.managedServer).toEqual(managedServer);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it.each(["aws", "azure"] as const)("publishes nested %s cloud metadata changes with an unchanged timestamp", async (provider) => {
    const send = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    const updatedAt = "2026-09-19T12:00:00.000Z";
    let current: ManagedServerReference = {
      ...managedServer, provider,
      overview: { region: "region", size: "size", instanceState: "running", publicIpAddress: null,
        privateIpAddress: null, updatedAt, cloud: { provider } },
    };
    registry.setManagedServerResolver(() => current);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    const updates: ManagedCloudOverview[] = provider === "aws" ? [
      { provider: "aws", vpcId: "vpc-shared" },
      { provider: "aws", vpcCidr: "10.20.0.0/16" },
    ] : [
      { provider: "azure", subscriptionId: "subscription-one" },
      { provider: "azure", resourceGroupName: "server-group" },
      { provider: "azure", resourceGroupId: "/subscriptions/subscription-one/resourceGroups/server-group" },
      { provider: "azure", virtualNetworkId: "/subscriptions/subscription-one/resourceGroups/network-group/providers/Microsoft.Network/virtualNetworks/shared-network" },
      { provider: "azure", virtualNetworkName: "shared-network" },
      { provider: "azure", virtualNetworkResourceGroup: "network-group" },
      { provider: "azure", virtualNetworkCidr: "10.30.0.0/16" },
    ];

    for (const cloud of updates) {
      send.mockClear();
      current = { ...current, overview: { ...current.overview!, cloud: { ...current.overview!.cloud!, ...cloud } } };
      registry.refreshManagedServerMetadata();
      expect(send.mock.calls.filter(([channel]) => channel === IPC.snapshotChanged)).toHaveLength(2);
      expect(send.mock.calls.filter(([channel]) => channel === "sliver:network-forwarding:changed")).toHaveLength(2);
      for (const id of [1, 2]) {
        expect(registry.snapshot(id).connection.managedServer).toEqual(current);
        expect(registry.snapshot(id).connection.managedServer?.overview?.updatedAt).toBe(updatedAt);
      }

      send.mockClear();
      current = structuredClone(current);
      registry.refreshManagedServerMetadata();
      expect(send).not.toHaveBeenCalled();
    }

    send.mockClear();
    const overview = { ...current.overview! };
    delete overview.cloud;
    current = { ...current, overview };
    registry.refreshManagedServerMetadata();
    expect(send.mock.calls.filter(([channel]) => channel === IPC.snapshotChanged)).toHaveLength(2);
    for (const id of [1, 2]) expect(registry.snapshot(id).connection.managedServer?.overview).not.toHaveProperty("cloud");
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it.each(["instanceId", "instanceName", "availabilityZone", "subnetId"] as const)(
    "publishes an %s-only update with an unchanged timestamp", async (field) => {
      const send = vi.fn();
      electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send });
      const client = new FakeSliverClient();
      const registry = createRegistry(() => client.adapter);
      let current: ManagedServerReference = {
        ...managedServer,
        overview: { region: "us-west-2", size: "t3.small", instanceState: "running", publicIpAddress: null,
          privateIpAddress: null, updatedAt: "2026-09-19T12:00:00.000Z", cloud: { provider: "aws", vpcId: "vpc-shared" } },
      };
      registry.setManagedServerResolver(() => current);
      registry.registerWindow(1);
      registry.registerWindow(2);
      await connectSaved(registry, 1);
      registry.inheritConnection(1, 2);
      send.mockClear();

      current = { ...current, overview: { ...current.overview!, [field]: "changed-instance-metadata" } };
      registry.refreshManagedServerMetadata();
      expect(send.mock.calls.filter(([channel]) => channel === IPC.snapshotChanged)).toHaveLength(2);
      for (const id of [1, 2]) expect(registry.snapshot(id).connection.managedServer).toEqual(current);

      send.mockClear();
      current = structuredClone(current);
      registry.refreshManagedServerMetadata();
      expect(send).not.toHaveBeenCalled();
      expect(client.connect).toHaveBeenCalledOnce();
    },
  );

  it("clears provenance after failure and ignores a superseded connection completion", async () => {
    await writeFile(join(externalDirectory, "other.cfg"), validConfig({ operator: "other" }));
    const initialClient = new FakeSliverClient();
    const nextClient = new FakeSliverClient();
    const gate = deferred<unknown>();
    initialClient.connect.mockImplementationOnce(() => gate.promise);
    const factory = vi.fn().mockReturnValueOnce(initialClient.adapter).mockReturnValue(nextClient.adapter);
    const registry = createRegistry(factory);
    registry.setManagedServerResolver((digest) => digest === configDigest ? managedServer : null);
    registry.registerWindow(1);
    const listed = await registry.listSavedConfigs(1);
    if (!listed.ok) throw new Error(listed.error);
    const managedId = listed.value.find(({ displayName }) => displayName === "operator")!.id;
    const otherId = listed.value.find(({ displayName }) => displayName === "other")!.id;
    const pending = registry.connectSavedConfig(1, managedId);
    await vi.waitFor(() => expect(initialClient.connect).toHaveBeenCalledOnce());
    expect(registry.snapshot(1).connection.managedServer).toBeNull();
    expect(await registry.connectSavedConfig(1, otherId)).toMatchObject({ ok: true });
    gate.resolve(undefined);
    expect(await pending).toMatchObject({ ok: false });
    expect(registry.snapshot(1).connection).toMatchObject({ operator: "other", managedServer: null });

    await registry.disconnect(1);
    nextClient.connect.mockRejectedValueOnce(new Error("Connection failed"));
    expect(await registry.connectSavedConfig(1, managedId)).toMatchObject({ ok: false });
    expect(registry.snapshot(1).connection).toMatchObject({ status: "disconnected", managedServer: null });
  });

  it("treats unavailable metadata as unassociated without failing the connection", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.setManagedServerResolver(() => { throw new Error("Metadata unavailable"); });
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    expect(registry.snapshot(1).connection).toMatchObject({ status: "connected", managedServer: null });
    registry.setManagedServerResolver(() => managedServer);
    expect(registry.snapshot(1).connection.managedServer).toEqual(managedServer);
  });

  it("does not infer cloud provenance from imported config ownership", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [join(externalDirectory, "operator.cfg")] });
    const imported = await registry.importConfig(sender(1), "Imported");
    expect(imported).toMatchObject({ ok: true, value: { origin: "imported", removal: "detach" } });
    await connectNamed(registry, 1, "Imported");
    expect(registry.snapshot(1).connection.managedServer).toBeNull();
  });

  it("rejects an imported source changed after selection and omits it on refresh", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    const sourcePath = join(root, "outside.cfg");
    await writeFile(sourcePath, validConfig(), { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourcePath] });
    const imported = await registry.importConfig(sender(1), "Outside");
    expect(imported.ok).toBe(true);

    await writeFile(sourcePath, validConfig({ operator: "changed" }));
    expect(await registry.connectSavedConfig(1, imported.value!.id)).toMatchObject({
      ok: false,
      error: "Saved configuration changed or is no longer available; refresh the list",
    });
    const refreshed = await registry.listSavedConfigs(1);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.value?.some((entry) => entry.origin === "imported")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("explains private file permissions required for a no-copy import", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    const sourcePath = join(root, "public.cfg");
    await writeFile(sourcePath, validConfig(), { mode: 0o644 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [sourcePath] });

    expect(await registry.importConfig(sender(1), "Public")).toEqual({
      ok: false,
      error: "Selected configuration must have private file permissions (0600 or stricter) to import by reference",
    });
  });
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

  it("keeps loot and credential inventories metadata-only until an explicit content request", async () => {
    const client = new FakeSliverClient();
    const lootId = "591a16d2-e138-4a21-b38f-f166aa23e044";
    const credentialId = "80ae1382-e6e2-44d6-a663-537cafb60e74";
    client.lootState = [clientpb.Loot.create({
      ID: lootId,
      Name: "operator-notes",
      FileType: clientpb.FileType.TEXT,
      OriginHostUUID: "76955e80-e700-4bc1-84d0-4e8090d5b900",
      Size: "18",
      File: { Name: "notes.txt", Data: Buffer.from("LOOT-CONTENT-SECRET") },
    })];
    client.credentialState = [clientpb.Credential.create({
      ID: credentialId,
      Username: "alice",
      Plaintext: "CREDENTIAL-PLAINTEXT-SECRET",
      Hash: "d41d8cd98f00b204e9800998ecf8427e",
      HashType: clientpb.HashType.MD5,
      IsCracked: true,
      OriginHostUUID: "76955e80-e700-4bc1-84d0-4e8090d5b900",
      Collection: "manual",
    })];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const loot = await registry.listLoot(1, { fileType: "all", limit: 100 });
    const credentials = await registry.listCredentials(1, { kind: "all", limit: 100 });

    expect(loot).toMatchObject({
      ok: true,
      value: { items: [{ id: lootId, name: "operator-notes", sizeBytes: "18" }] },
    });
    expect(credentials).toMatchObject({
      ok: true,
      value: {
        items: [{ id: credentialId, username: "alice", hasPlaintext: true, hasHash: true }],
      },
    });
    expect(JSON.stringify({ loot, credentials })).not.toMatch(/LOOT-CONTENT-SECRET|CREDENTIAL-PLAINTEXT-SECRET|d41d8cd/iu);
    expect(client.lootContent).not.toHaveBeenCalled();
    expect(client.credentialById).not.toHaveBeenCalled();

    const preview = await registry.getLootDetail(1, lootId);
    expect(preview).toMatchObject({ ok: true, value: { previewState: "text" } });
    if (!preview.ok) throw new Error(preview.error);
    expect(new TextDecoder().decode(preview.value.preview)).toBe("LOOT-CONTENT-SECRET");
    const revealed = await registry.revealCredentialSecret(1, { id: credentialId, field: "plaintext" });
    expect(revealed).toMatchObject({ ok: true, value: { field: "plaintext", item: { id: credentialId } } });
    if (!revealed.ok) throw new Error(revealed.error);
    expect(new TextDecoder().decode(revealed.value.value)).toBe("CREDENTIAL-PLAINTEXT-SECRET");
    expect(revealed.value).not.toHaveProperty("hash");
    preview.value.preview.fill(0);
    revealed.value.value.fill(0);
  });

  it("previews binary images and videos by content signature, independent of filename", async () => {
    const client = new FakeSliverClient();
    const imageId = "591a16d2-e138-4a21-b38f-f166aa23e044";
    const videoId = "80ae1382-e6e2-44d6-a663-537cafb60e74";
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const video = Buffer.from([0, 0, 0, 16, ...Buffer.from("ftypmp42"), 0, 0, 0, 0]);
    client.lootState = [
      clientpb.Loot.create({
        ID: imageId, Name: "image", FileType: clientpb.FileType.BINARY,
        Size: String(image.byteLength), File: { Name: "misleading.txt", Data: image },
      }),
      clientpb.Loot.create({
        ID: videoId, Name: "video", FileType: clientpb.FileType.BINARY,
        Size: String(video.byteLength), File: { Name: "misleading.png", Data: video },
      }),
    ];
    const returned: clientpb.Loot[] = [];
    client.lootContent.mockImplementation(async (id) => {
      const item = client.lootState.find((loot) => loot.ID === id);
      if (!item) throw new Error("unknown fake loot");
      const response = clientpb.Loot.create({
        ...item,
        File: item.File ? { ...item.File, Data: Buffer.from(item.File.Data) } : undefined,
      });
      returned.push(response);
      return response;
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const imageDetail = await registry.getLootDetail(1, imageId);
    const videoDetail = await registry.getLootDetail(1, videoId);
    expect(imageDetail).toMatchObject({ ok: true, value: { previewState: "image", mediaMimeType: "image/png" } });
    expect(videoDetail).toMatchObject({ ok: true, value: { previewState: "video", mediaMimeType: "video/mp4" } });
    if (!imageDetail.ok || !videoDetail.ok) throw new Error("Media preview failed");
    expect(imageDetail.value.preview).toEqual(new Uint8Array(image));
    expect(videoDetail.value.preview).toEqual(new Uint8Array(video));
    expect(returned).toHaveLength(2);
    expect(returned.every((response) => response.File?.Data.every((byte) => byte === 0))).toBe(true);
    imageDetail.value.preview.fill(0);
    videoDetail.value.preview.fill(0);
  });

  it("keeps unknown binary content out of the detail response even with an image extension", async () => {
    const client = new FakeSliverClient();
    const lootId = "591a16d2-e138-4a21-b38f-f166aa23e044";
    const response = clientpb.Loot.create({
      ID: lootId, Name: "unknown", FileType: clientpb.FileType.BINARY,
      Size: "11", File: { Name: "spoofed.png", Data: Buffer.from("not a photo") },
    });
    client.lootState = [response];
    const returned = clientpb.Loot.create({
      ...response, File: { Name: "spoofed.png", Data: Buffer.from("not a photo") },
    });
    client.lootContent.mockResolvedValueOnce(returned);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const detail = await registry.getLootDetail(1, lootId);
    expect(detail).toMatchObject({ ok: true, value: { previewState: "binary" } });
    if (!detail.ok) throw new Error(detail.error);
    expect(detail.value.preview).toHaveLength(0);
    expect(detail.value).not.toHaveProperty("mediaMimeType");
    expect(client.lootContent).toHaveBeenCalledExactlyOnceWith(lootId);
    expect(returned.File?.Data.every((byte) => byte === 0)).toBe(true);
  });

  it("does not fetch an oversized binary preview and rejects oversized returned content", async () => {
    const client = new FakeSliverClient();
    const lootId = "591a16d2-e138-4a21-b38f-f166aa23e044";
    client.lootState = [clientpb.Loot.create({
      ID: lootId, Name: "large", FileType: clientpb.FileType.BINARY,
      Size: String(OPERATOR_DATA_LIMITS.mediaPreviewBytes + 1),
      File: { Name: "large.mp4", Data: Buffer.alloc(0) },
    })];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const tooLarge = await registry.getLootDetail(1, lootId);
    expect(tooLarge).toMatchObject({ ok: true, value: { previewState: "too-large" } });
    expect(client.lootContent).not.toHaveBeenCalled();

    client.lootState[0]!.Size = "1";
    const oversizedData = Buffer.alloc(OPERATOR_DATA_LIMITS.mediaPreviewBytes + 1);
    oversizedData[0] = 0x89;
    client.lootContent.mockImplementationOnce(async () => ({
      ID: lootId,
      File: { Data: oversizedData },
    }) as clientpb.Loot);
    const rejected = await registry.getLootDetail(1, lootId);
    expect(rejected).toMatchObject({ ok: false });
    if (rejected.ok) throw new Error("Oversized preview was accepted");
    expect(rejected.error).toMatch(/preview exceeds/u);
    expect(oversizedData.every((byte) => byte === 0)).toBe(true);
  });

  it("opens the native loot save dialog before fetching content and writes a private bounded copy", async () => {
    const client = new FakeSliverClient();
    const lootId = "591a16d2-e138-4a21-b38f-f166aa23e044";
    client.lootState = [clientpb.Loot.create({
      ID: lootId,
      Name: "operator-notes",
      FileType: clientpb.FileType.BINARY,
      Size: "12",
      File: { Name: "notes.bin", Data: Buffer.from("loot-payload") },
    })];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(registry.downloadLoot(sender(1), lootId)).resolves.toEqual({
      ok: true,
      value: { saved: false, fileName: "notes.bin", size: 0 },
    });
    expect(client.lootContent).not.toHaveBeenCalled();

    const destination = join(root, "saved-loot.bin");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(registry.downloadLoot(sender(1), lootId)).resolves.toMatchObject({
      ok: true,
      value: { saved: true, fileName: "notes.bin", size: 12 },
    });
    expect(client.lootContent).toHaveBeenCalledOnce();
    expect(await readFile(destination, "utf8")).toBe("loot-payload");
  });

  it("zeroes submitted credential buffers and clears only an unchanged copied secret", async () => {
    const client = new FakeSliverClient();
    const credentialId = "80ae1382-e6e2-44d6-a663-537cafb60e74";
    client.credentialState = [clientpb.Credential.create({
      ID: credentialId,
      Username: "alice",
      Plaintext: "clipboard-secret",
      HashType: clientpb.HashType.INVALID,
      Collection: "manual",
    })];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const plaintext = new TextEncoder().encode("new-secret");
    const hash = new Uint8Array();
    await expect(registry.addCredential(1, {
      username: "bob",
      collection: "manual",
      plaintext,
      hash,
      hashType: null,
    })).resolves.toEqual({ ok: true });
    expect(plaintext.every((byte) => byte === 0)).toBe(true);
    expect(client.credentialAdd).toHaveBeenCalledWith(expect.objectContaining({
      Username: "bob",
      Plaintext: "new-secret",
      HashType: clientpb.HashType.INVALID,
    }));

    vi.useFakeTimers();
    const first = await registry.copyCredentialSecret(1, { id: credentialId, field: "plaintext" });
    expect(first).toMatchObject({ ok: true, value: { expiresAt: expect.any(String) } });
    expect(electronMocks.clipboardText).toBe("clipboard-secret");
    electronMocks.clipboardText = "operator-replaced-value";
    await vi.advanceTimersByTimeAsync(30_000);
    expect(electronMocks.clipboardText).toBe("operator-replaced-value");
    expect(electronMocks.clipboardClear).not.toHaveBeenCalled();

    await registry.copyCredentialSecret(1, { id: credentialId, field: "plaintext" });
    electronMocks.clipboardWriteText.mockImplementationOnce(() => { throw new Error("clipboard unavailable"); });
    await expect(registry.copyCredentialSecret(1, { id: credentialId, field: "plaintext" })).resolves.toEqual({
      ok: false,
      error: "clipboard unavailable",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(electronMocks.clipboardText).toBe("");
    expect(electronMocks.clipboardClear).toHaveBeenCalledOnce();
  });

  it("dispatches listener mutations and refreshes only the jobs domain", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineCalls = domainCallCounts(client);

    const started = await registry.startListener(1, {
      listener: { kind: "mtls", host: "127.0.0.1", port: 65_535 },
      addManagedFirewallRule: false,
    });

    expect(started).toMatchObject({
      ok: true,
      value: {
        job: { protocol: "mtls", port: 65_535 },
        firewall: { status: "not-requested", ruleCount: 0 },
      },
    });
    expect(client.startMTLSListener).toHaveBeenCalledWith("127.0.0.1", 65_535);
    expect(domainCallCounts(client)).toEqual({ ...baselineCalls, jobs: baselineCalls.jobs + 1 });

    for (const port of [0, 65_536, 1.5]) {
      await expect(
        registry.startListener(1, {
          listener: { kind: "mtls", host: "127.0.0.1", port },
          addManagedFirewallRule: false,
        }),
      ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/1 and 65535/) });
    }
    expect(client.startMTLSListener).toHaveBeenCalledOnce();
  });

  it("adds managed firewall ingress after starting a listener and maps transport protocols", async () => {
    const client = new FakeSliverClient();
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0011",
      provider: "aws",
      name: "Managed listener server",
    };
    const ensureIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "applied", ruleCount: 1 },
    } as const));
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress,
      removeIngress: vi.fn(async () => ({
        ok: true,
        value: { status: "removed", ruleCount: 1 },
      } as const)),
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(registry.startListener(1, {
      listener: { kind: "mtls", host: "0.0.0.0", port: 8888 },
      addManagedFirewallRule: true,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        job: { protocol: "mtls", port: 8888 },
        firewall: { status: "applied", ruleCount: 1 },
      },
    });
    await expect(registry.startListener(1, {
      listener: {
        kind: "dns",
        host: "0.0.0.0",
        port: 53,
        domains: "example.test",
        canaries: false,
        enforceOtp: false,
      },
      addManagedFirewallRule: true,
    })).resolves.toMatchObject({ ok: true });

    expect(ensureIngress).toHaveBeenNthCalledWith(1, { server, protocol: "tcp", port: 8888 });
    expect(ensureIngress).toHaveBeenNthCalledWith(2, { server, protocol: "udp", port: 53 });
  });

  it("keeps a started listener successful when managed firewall ingress fails", async () => {
    const client = new FakeSliverClient();
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0012",
      provider: "azure",
      name: "Managed listener server",
    };
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({ ok: false, error: "cloud rule rejected" } as const)),
      removeIngress: vi.fn(async () => ({ ok: false, error: "unused" } as const)),
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(registry.startListener(1, {
      listener: { kind: "mtls", host: "0.0.0.0", port: 8888 },
      addManagedFirewallRule: true,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        job: { port: 8888 },
        firewall: { status: "failed", ruleCount: 0, error: "cloud rule rejected" },
      },
    });
    expect(registry.snapshot(1).jobs).toEqual([expect.objectContaining({ port: 8888 })]);
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
      registry.startListener(1, {
        listener: { kind: "mtls", host: "127.0.0.1", port: 65_535 },
        addManagedFirewallRule: false,
      }),
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

  it("bounds overlapping manual refresh waiters and coalesces them into one follow-up", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const baselineSessions = client.getSessions.mock.calls.length;
    const gate = deferred<clientpb.Sessions>();
    client.nextSessionsPromise = gate.promise;

    const admitted = [registry.refresh(1)];
    await vi.waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(baselineSessions + 1));
    admitted.push(registry.refresh(1), registry.refresh(1), registry.refresh(1));
    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Too many manual refresh callers/),
    });
    expect(client.getSessions).toHaveBeenCalledTimes(baselineSessions + 1);

    gate.resolve(clientpb.Sessions.create(client.sessionState));
    await expect(Promise.all(admitted)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
    expect(client.getSessions).toHaveBeenCalledTimes(baselineSessions + 2);
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
      registry.startListener(1, {
        listener: { kind: "mtls", host: "127.0.0.1", port: 8888 },
        addManagedFirewallRule: false,
      }),
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
      registry.startListener(1, {
        listener: { kind: "mtls", host: "127.0.0.1", port: 8888 },
        addManagedFirewallRule: false,
      }),
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

    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: false,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/job set changed/),
    });
    expect(client.killJob).not.toHaveBeenCalled();
    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: false,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expired/),
    });

    const current = await registry.prepareStopAllJobs(1);
    if (!current.ok) throw new Error(current.error);
    await expect(registry.executeStopPlan(1, {
      token: current.value.token,
      removeManagedFirewallRule: false,
    })).resolves.toEqual({
      ok: true,
      value: {
        stoppedJobIds: [7],
        failedJobIds: [],
        firewall: { status: "not-requested", ruleCount: 0 },
      },
    });
    expect(client.killJob).toHaveBeenCalledWith(7);
    expect(registry.snapshot(1).jobs).toEqual([]);
  });

  it("captures and removes managed listener firewall ingress after a confirmed stop", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000, "wireguard")];
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0013",
      provider: "aws",
      name: "Managed listener server",
    };
    const removeIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "removed", ruleCount: 1 },
    } as const));
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({
        ok: true,
        value: { status: "applied", ruleCount: 1 },
      } as const)),
      removeIngress,
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareStopJob(1, 7);
    expect(prepared).toMatchObject({
      ok: true,
      value: { impact: { managedFirewall: { server, protocol: "udp", port: 7000 } } },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: true,
    })).resolves.toEqual({
      ok: true,
      value: {
        stoppedJobIds: [7],
        failedJobIds: [],
        firewall: { status: "removed", ruleCount: 1 },
      },
    });
    expect(removeIngress).toHaveBeenCalledWith({ server, protocol: "udp", port: 7000 });
  });

  it("retains managed ingress while another listener uses the same protocol and port", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000), job(8, 7000)];
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0014",
      provider: "azure",
      name: "Managed listener server",
    };
    const removeIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "removed", ruleCount: 1 },
    } as const));
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({
        ok: true,
        value: { status: "applied", ruleCount: 1 },
      } as const)),
      removeIngress,
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareStopJob(1, 7);
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: true,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        stoppedJobIds: [7],
        failedJobIds: [],
        firewall: { status: "retained", ruleCount: 0 },
      },
    });
    expect(removeIngress).not.toHaveBeenCalled();
    expect(registry.snapshot(1).jobs.map(({ id }) => id)).toEqual([8]);

    const stopAll = await registry.prepareStopAllJobs(1);
    expect(stopAll).toMatchObject({ ok: true, value: { impact: { managedFirewall: null } } });
  });

  it("does not offer managed firewall cleanup for an unrecognized server job", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000, "custom-job")];
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => ({
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0017",
      provider: "aws",
      name: "Managed listener server",
    }));
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(registry.prepareStopJob(1, 7)).resolves.toMatchObject({
      ok: true,
      value: { impact: { managedFirewall: null } },
    });
  });

  it("reports managed firewall removal failure after the listener is confirmed stopped", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000)];
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0015",
      provider: "aws",
      name: "Managed listener server",
    };
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({ ok: false, error: "unused" } as const)),
      removeIngress: vi.fn(async () => ({ ok: false, error: "cloud delete rejected" } as const)),
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareStopJob(1, 7);
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: true,
    })).resolves.toEqual({
      ok: true,
      value: {
        stoppedJobIds: [7],
        failedJobIds: [],
        firewall: { status: "failed", ruleCount: 0, error: "cloud delete rejected" },
      },
    });
    expect(registry.snapshot(1).jobs).toEqual([]);
  });

  it("does not remove managed ingress when the listener stop fails", async () => {
    const client = new FakeSliverClient();
    client.jobState = [job(7, 7000)];
    client.killJob.mockResolvedValueOnce(clientpb.KillJob.create({ ID: 7, Success: false }));
    const server: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0016",
      provider: "aws",
      name: "Managed listener server",
    };
    const removeIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "removed", ruleCount: 1 },
    } as const));
    const registry = createRegistry(() => client.adapter);
    registry.setManagedServerResolver(() => server);
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({ ok: false, error: "unused" } as const)),
      removeIngress,
    });
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareStopJob(1, 7);
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: true,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Failed to stop jobs #7/),
    });
    expect(removeIngress).not.toHaveBeenCalled();
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

    const execution = registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: false,
    });
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

  it("reports a confirmed stop when the window switches backends during the kill", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    firstClient.jobState = [job(7, 7000)];
    const secondClient = new FakeSliverClient();
    const clients = [firstClient, secondClient];
    const removeIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "removed", ruleCount: 1 },
    } as const));
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.setManagedServerResolver(() => ({
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0019",
      provider: "aws",
      name: "Managed listener server",
    }));
    registry.setManagedListenerFirewallController({
      ensureIngress: vi.fn(async () => ({ ok: false, error: "unused" } as const)),
      removeIngress,
    });
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectNamed(registry, 1, "operator");
    await connectNamed(registry, 2, "operator");
    const prepared = await registry.prepareStopJob(1, 7);
    if (!prepared.ok) throw new Error(prepared.error);

    const killStarted = deferred<void>();
    const killResponse = deferred<clientpb.KillJob>();
    firstClient.killJob.mockImplementationOnce(async () => {
      killStarted.resolve(undefined);
      const response = await killResponse.promise;
      firstClient.jobState = [];
      return response;
    });
    const execution = registry.executeStopPlan(1, {
      token: prepared.value.token,
      removeManagedFirewallRule: true,
    });
    await killStarted.promise;
    await connectNamed(registry, 1, "backend-b");
    killResponse.resolve(clientpb.KillJob.create({ ID: 7, Success: true }));

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: {
        stoppedJobIds: [7],
        failedJobIds: [],
        firewall: {
          status: "outcome-unknown",
          error: expect.stringMatching(/backend changed.*Cloud Deployment/iu),
        },
      },
    });
    expect(removeIngress).not.toHaveBeenCalled();
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it("rejects stale reads but reports a listener mutation confirmed before a backend switch", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    const secondClient = new FakeSliverClient();
    const thirdClient = new FakeSliverClient();
    const clients = [firstClient, secondClient, thirdClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    const managedServer: ManagedServerReference = {
      deploymentId: "6f0a80ed-bdd5-4ec0-aa53-7ecca9df0018",
      provider: "aws",
      name: "Managed listener server",
    };
    const ensureIngress = vi.fn(async () => ({
      ok: true,
      value: { status: "applied", ruleCount: 1 },
    } as const));
    registry.setManagedServerResolver(() => managedServer);
    registry.setManagedListenerFirewallController({
      ensureIngress,
      removeIngress: vi.fn(async () => ({ ok: false, error: "unused" } as const)),
    });
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
    const staleMutation = registry.startListener(1, {
      listener: { kind: "mtls", host: "127.0.0.1", port: 9999 },
      addManagedFirewallRule: true,
    });
    await Promise.resolve();
    await connectNamed(registry, 1, "backend-b");
    listener.resolve(clientpb.ListenerJob.create({ JobID: 99 }));
    await expect(staleMutation).resolves.toMatchObject({
      ok: true,
      value: {
        job: { id: 99, protocol: "mtls", port: 9999 },
        firewall: {
          status: "failed",
          ruleCount: 0,
          error: expect.stringMatching(/backend connection changed/),
        },
      },
    });
    expect(ensureIngress).not.toHaveBeenCalled();
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it("returns the old backend operation journal after a config switch instead of losing a dispatched result", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    const secondClient = new FakeSliverClient();
    firstClient.sessionState.Sessions = [session("session_1", "interactive")];
    const mutationGate = deferred<void>();
    firstClient.setEnvSession.mockImplementationOnce(async () => {
      await mutationGate.promise;
      return sliverpb.SetEnv.create({});
    });
    const clients = [firstClient, secondClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    await connectNamed(registry, 1, "operator");
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const submitted = registry.submitTargetOperation(1, {
      operationId: "target.env-set",
      name: "M1_SWITCH",
      value: "old-backend",
    });
    await vi.waitFor(() => expect(firstClient.setEnvSession).toHaveBeenCalledOnce());
    await connectNamed(registry, 1, "backend-b");
    mutationGate.resolve(undefined);

    await expect(submitted).resolves.toMatchObject({
      ok: true,
      value: {
        operationId: "target.env-set",
        target: { id: "session_1" },
        backend: { server: "localhost:31337" },
        state: "outcome-unknown",
      },
    });
    expect(firstClient.setEnvSession).toHaveBeenCalledOnce();
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it("keeps a late exact beacon task ID while same-config reconnect retires its old ownership", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const responseGate = deferred<void>();
    client.pingBeacon.mockImplementationOnce(async (beaconId: string, nonce: number) => {
      await responseGate.promise;
      const response = {
        Nonce: nonce,
        Response: { Async: true, BeaconID: beaconId, TaskID: "late_exact_task", Err: "" },
      };
      client.taskState.set(beaconId, [clientpb.BeaconTask.create({
        ID: "late_exact_task",
        BeaconID: beaconId,
        State: "pending",
        Description: "Ping",
        CreatedAt: String(Math.floor(Date.now() / 1_000)),
        Request: Buffer.alloc(0),
        Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: nonce })).finish()),
      })]);
      return response;
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectNamed(registry, 1, "operator");
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = registry.submitTargetOperation(1, { operationId: "target.ping" });
    await vi.waitFor(() => expect(client.pingBeacon).toHaveBeenCalledOnce());

    await connectNamed(registry, 1, "operator");
    responseGate.resolve(undefined);
    await expect(submitted).resolves.toMatchObject({
      ok: true,
      value: { state: "outcome-unknown", taskId: "late_exact_task", target: { id: "beacon_1" } },
    });

    const currentRef = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "beacon_1")!;
    await registry.selectTarget(1, currentRef);
    await expect(registry.listBeaconTasks(1, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ taskId: "late_exact_task", ownership: { origin: "unknown" } }] },
    });
    await expect(registry.listTargetOperations(1, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { items: [] },
    });
  });

  it("does not let an old postcondition refresh complete after same-config engine replacement", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_1", "interactive")];
    const refreshGate = deferred<clientpb.Sessions>();
    const rendererSend = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send: rendererSend });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectNamed(registry, 1, "operator");
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    client.nextSessionsPromise = refreshGate.promise;

    const rename = registry.submitTargetOperation(1, { operationId: "target.rename", name: "renamed" });
    await vi.waitFor(() => expect(client.renameSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(client.getSessions.mock.calls.length).toBeGreaterThan(1));
    await connectNamed(registry, 1, "operator");
    rendererSend.mockClear();
    refreshGate.resolve(clientpb.Sessions.create(client.sessionState));

    await expect(rename).resolves.toMatchObject({ ok: true, value: { state: "outcome-unknown" } });
    expect(rendererSend).not.toHaveBeenCalledWith(IPC.operationChanged, expect.anything());
    await expect(registry.listTargetOperations(1, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { items: [] },
    });
  });

  it("uses authoritative compiler inventory and sanitizes bounded build summaries", async () => {
    const client = new FakeSliverClient();
    client.compilerState = clientpb.Compiler.create({
      Targets: [clientpb.CompilerTarget.create({ GOOS: "darwin", GOARCH: "arm64", Format: clientpb.OutputFormat.EXECUTABLE })],
      UnsupportedTargets: [
        clientpb.CompilerTarget.create({ GOOS: "freebsd", GOARCH: "amd64", Format: clientpb.OutputFormat.EXECUTABLE }),
      ],
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
      { os: "freebsd", arch: "amd64", format: "executable", supported: false },
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

    input.name = "generic-target";
    input.os = "freebsd";
    input.arch = "amd64";
    const generic = await registry.generate(sender(1), input);
    expect(generic).toMatchObject({ ok: true, value: { implantName: "generic-target", saved: false } });
    expect(client.generateImplant).toHaveBeenCalledTimes(2);

    input.arch = "arm64";
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

  it("copies only the verified active profile and carries its main-only reference into inherited windows", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);

    const source = await registry.copyActiveConfig(1);
    const inherited = await registry.copyActiveConfig(2);
    try {
      expect(source.configName).toBe("operator");
      expect(inherited.configName).toBe("operator");
      expect(source.configBytes.toString("utf8")).toBe(validConfig());
      expect(inherited.configBytes.toString("utf8")).toBe(validConfig());
      expect(source.configBytes).not.toBe(inherited.configBytes);
    } finally {
      source.configBytes.fill(0);
      inherited.configBytes.fill(0);
    }
  });

  it("inherits a connection while a new renderer frame cannot yet receive snapshots", async () => {
    const destinationSend = vi.fn(() => {
      throw new Error("Render frame was disposed before WebContents.send");
    });
    electronMocks.fromId.mockImplementation((contentsId: number) => ({
      isDestroyed: () => false,
      send: contentsId === 2 ? destinationSend : vi.fn(),
    }));
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);

    expect(() => registry.inheritConnection(1, 2)).not.toThrow();
    expect(destinationSend).toHaveBeenCalledWith(
      IPC.snapshotChanged,
      expect.objectContaining({
        connection: expect.objectContaining({
          configName: "operator",
          status: "connected",
        }),
      }),
    );
    expect(registry.snapshot(2).connection).toMatchObject({
      configName: "operator",
      status: "connected",
    });
  });

  it("refuses to launch from changed or disconnected active profile material", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await writeFile(join(externalDirectory, "operator.cfg"), validConfig({ operator: "changed" }));
    await expect(registry.copyActiveConfig(1)).rejects.toThrow(/changed/u);

    await registry.disconnect(1);
    await expect(registry.copyActiveConfig(1)).rejects.toThrow(/Connect to a Sliver server/u);
  });

  it("surfaces reconnecting and warns on version incompatibility without blocking the connection", async () => {
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
    expect(result).toMatchObject({
      ok: true,
      value: {
        connection: {
          status: "degraded",
          capabilities: {
            compatibility: "degraded",
            reason: expect.stringMatching(/may be incompatible/u),
            currentSlice: {
              jobs: true,
              listeners: true,
              generation: true,
              builds: true,
              profiles: true,
              events: true,
              targets: true,
              tasks: true,
            },
          },
        },
      },
    });
    expect(incompatibleRegistry.snapshot(2).domains.compiler.status).not.toBe("unsupported");
    expect(incompatibleClient.getCompiler).toHaveBeenCalled();
  });

  it("never suggests system CA trust for managed operator mTLS failures", async () => {
    const client = new FakeSliverClient();
    client.connect.mockRejectedValueOnce(new Error(
      "14 UNAVAILABLE: unable to verify the first certificate; if the root CA is installed locally, " +
      "try running Node.js with --use-system-ca",
    ));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    const listed = await registry.listSavedConfigs(1);
    if (!listed.ok) throw new Error(listed.error);

    const result = await registry.connectSavedConfig(1, listed.value[0]!.id);

    expect(result).toEqual({ ok: false, error: "14 UNAVAILABLE: unable to verify the first certificate" });
    expect(registry.snapshot(1).connection.error).toBe("14 UNAVAILABLE: unable to verify the first certificate");
    expect(JSON.stringify(result)).not.toContain("--use-system-ca");
  });

  it("still blocks when GetVersion fails before returning a version", async () => {
    const client = new FakeSliverClient();
    client.getVersion.mockRejectedValueOnce(new Error("/rpcpb.SliverRPC/GetVersion UNAVAILABLE: no authenticated response"));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    const listed = await registry.listSavedConfigs(1);
    if (!listed.ok) throw new Error(listed.error);

    const result = await registry.connectSavedConfig(1, listed.value[0]!.id);

    expect(result).toEqual({
      ok: false,
      error: "/rpcpb.SliverRPC/GetVersion UNAVAILABLE: no authenticated response",
    });
    expect(registry.snapshot(1).connection.status).toBe("disconnected");
    expect(client.getCompiler).not.toHaveBeenCalled();
  });

  it("refuses an operator configuration without a managed CA before constructing a client", async () => {
    const missingCaPath = join(externalDirectory, "missing-managed-ca.cfg");
    await writeFile(missingCaPath, validConfig({ ca_certificate: "  " }));
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [missingCaPath] });
    const factory = vi.fn(() => new FakeSliverClient().adapter);
    const registry = createRegistry(factory);
    registry.registerWindow(1);

    await expect(registry.chooseAndConnect(sender(1))).resolves.toEqual({
      ok: false,
      error: "Invalid Sliver configuration file",
    });
    expect(factory).not.toHaveBeenCalled();
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

  it("pages target 501 with window-bound immutable cursors across polling and insertion", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) =>
      session(`session_${String(index).padStart(4, "0")}`, `session-${index}`),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);

    const bounded = registry.snapshot(1);
    const cursor = bounded.domains.sessions.page.nextCursor;
    expect(cursor).toMatch(/^target:v1:[0-9a-f-]{36}$/u);
    if (!cursor) throw new Error("Expected a target continuation cursor");
    expect(bounded.sessions).toHaveLength(500);
    expect(bounded.sessions).not.toContainEqual(expect.objectContaining({ id: "session_0500" }));

    await expect(registry.listTargets(2, { mode: "session", cursor, limit: 100 })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/stale|another window/),
    });
    const continuation = await registry.listTargets(1, { mode: "session", cursor, limit: 100 });
    expect(continuation).toMatchObject({
      ok: true,
      value: {
        items: [{ target: { id: "session_0500" }, ref: { id: "session_0500" } }],
        page: { total: 501, truncated: false },
      },
    });
    if (!continuation.ok) throw new Error(continuation.error);
    await expect(registry.selectTarget(1, continuation.value.items[0]!.ref)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTargetSummary: { id: "session_0500" } } },
    });

    const identicalRefreshCursor = registry.snapshot(1).domains.sessions.page.nextCursor;
    if (!identicalRefreshCursor) throw new Error("Expected an identical-refresh target continuation cursor");
    const revisionBeforeRefresh = registry.snapshot(1).domains.sessions.revision;
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1).domains.sessions.revision).toBe(revisionBeforeRefresh);
    await expect(registry.listTargets(1, {
      mode: "session",
      cursor: identicalRefreshCursor,
      limit: 100,
    })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ target: { id: "session_0500" } }], page: { truncated: false } },
    });

    const insertionCursor = registry.snapshot(1).domains.sessions.page.nextCursor;
    if (!insertionCursor) throw new Error("Expected an insertion-safe target continuation cursor");
    client.sessionState.Sessions = [session("session_-inserted", "inserted"), ...client.sessionState.Sessions];
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    await expect(registry.listTargets(1, {
      mode: "session",
      cursor: insertionCursor,
      limit: 100,
    })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ target: { id: "session_0500" } }], page: { truncated: false } },
    });
  });

  it("searches the complete target catalog and binds continuations to the normalized query", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) =>
      session(
        `session_${String(index).padStart(4, "0")}`,
        index === 500 ? "only-hidden-catalog-match" : `ordinary-${index}`,
      ),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    await expect(registry.listTargets(1, {
      mode: "session",
      query: "  ONLY-HIDDEN-CATALOG-MATCH  ",
      limit: 100,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{ target: { id: "session_0500" }, ref: { id: "session_0500" } }],
        page: { limit: 100, total: 1, truncated: false },
      },
    });

    client.sessionState.Sessions = Array.from({ length: 201 }, (_, index) =>
      session(`matching_${String(index).padStart(4, "0")}`, `query-bound-${index}`),
    );
    await registry.refresh(1);
    const firstPage = await registry.listTargets(1, {
      mode: "session",
      query: "query-bound",
      limit: 100,
    });
    if (!firstPage.ok || !firstPage.value.page.nextCursor) throw new Error("Expected a search cursor");
    await expect(registry.listTargets(1, {
      mode: "session",
      query: "different-query",
      cursor: firstPage.value.page.nextCursor,
      limit: 100,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/stale|query|refresh/),
    });

    const retry = await registry.listTargets(1, {
      mode: "session",
      query: "QUERY-BOUND",
      limit: 100,
    });
    if (!retry.ok || !retry.value.page.nextCursor) throw new Error("Expected a replacement search cursor");
    await expect(registry.listTargets(1, {
      mode: "session",
      query: " query-bound ",
      cursor: retry.value.page.nextCursor,
      limit: 100,
    })).resolves.toMatchObject({
      ok: true,
      value: { items: expect.any(Array), page: { total: 201, truncated: true } },
    });
  });

  it("shares bounded target paging snapshots across windows and changing revisions", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) =>
      session(`session_${String(index).padStart(4, "0")}`, `session-${index}`),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);

    for (let revision = 0; revision < 40; revision += 1) {
      client.sessionState.Sessions[0]!.Name = `revision-${revision}`;
      await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    }

    const internals = registry as unknown as {
      targetCatalogSnapshots: Map<string, { estimatedBytes: number }>;
      targetCatalogSnapshotBytes: number;
      windows: Map<number, { targetPageCursors: Map<string, { snapshotKey: string }> }>;
    };
    expect(internals.targetCatalogSnapshots.size).toBeLessThanOrEqual(32);
    expect(internals.targetCatalogSnapshotBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(internals.windows.get(1)?.targetPageCursors.size).toBeLessThanOrEqual(8);
    expect(internals.windows.get(2)?.targetPageCursors.size).toBeLessThanOrEqual(8);
    const firstCursor = registry.snapshot(1).domains.sessions.page.nextCursor;
    const secondCursor = registry.snapshot(2).domains.sessions.page.nextCursor;
    if (!firstCursor || !secondCursor) throw new Error("Expected both windows to have target cursors");
    const firstSnapshotKey = internals.windows.get(1)?.targetPageCursors.get(firstCursor)?.snapshotKey;
    const secondSnapshotKey = internals.windows.get(2)?.targetPageCursors.get(secondCursor)?.snapshotKey;
    expect(firstSnapshotKey).toBeDefined();
    expect(secondSnapshotKey).toBe(firstSnapshotKey);
    expect(firstCursor).not.toBe(secondCursor);
  });

  it("revokes the oldest cursor instead of blocking a thirty-third target catalog snapshot", async () => {
    await Promise.all([
      writeFile(join(externalDirectory, "pool-b.cfg"), validConfig({ lport: 31_338, token: "pool-b" })),
      writeFile(join(externalDirectory, "pool-c.cfg"), validConfig({ lport: 31_339, token: "pool-c" })),
      writeFile(join(externalDirectory, "pool-d.cfg"), validConfig({ lport: 31_340, token: "pool-d" })),
    ]);
    const clients = Array.from({ length: 4 }, (_, poolIndex) => {
      const client = new FakeSliverClient();
      client.sessionState.Sessions = Array.from({ length: 501 }, (_, targetIndex) =>
        session(
          `pool_${poolIndex}_session_${String(targetIndex).padStart(4, "0")}`,
          `pool-${poolIndex}-target-${targetIndex}`,
        ),
      );
      return client;
    });
    const availableClients = [...clients];
    const registry = createRegistry(() => availableClients.shift()!.adapter);
    for (const contentsId of [1, 2, 3, 4]) registry.registerWindow(contentsId);

    try {
      await connectNamed(registry, 1, "operator");
      await connectNamed(registry, 2, "pool-b");
      await connectNamed(registry, 3, "pool-c");
      await connectNamed(registry, 4, "pool-d");

      const oldestCursor = registry.snapshot(1).domains.sessions.page.nextCursor;
      if (!oldestCursor) throw new Error("Expected an initial cursor for the first backend");
      for (let revision = 1; revision < 8; revision += 1) {
        for (let poolIndex = 0; poolIndex < clients.length; poolIndex += 1) {
          clients[poolIndex]!.sessionState.Sessions[0]!.Name = `pool-${poolIndex}-revision-${revision}`;
          await expect(registry.refresh(poolIndex + 1)).resolves.toMatchObject({ ok: true });
        }
      }

      const internals = registry as unknown as {
        targetCatalogSnapshots: Map<string, { estimatedBytes: number }>;
        targetCatalogSnapshotBytes: number;
        windows: Map<number, { targetPageCursors: Map<string, { snapshotKey: string }> }>;
      };
      expect(internals.targetCatalogSnapshots.size).toBe(32);
      for (const contentsId of [1, 2, 3, 4]) {
        expect(internals.windows.get(contentsId)?.targetPageCursors.size).toBe(8);
      }

      clients[0]!.sessionState.Sessions[0]!.Name = "pool-0-revision-8";
      await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
      const newestCursor = registry.snapshot(1).domains.sessions.page.nextCursor;
      if (!newestCursor) throw new Error("Expected the newest target catalog cursor");

      await expect(registry.listTargets(1, {
        mode: "session",
        cursor: oldestCursor,
        limit: 100,
      })).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/stale|refresh/),
      });
      await expect(registry.listTargets(1, {
        mode: "session",
        cursor: newestCursor,
        limit: 100,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          items: [{ target: { id: "pool_0_session_0500" } }],
          page: { total: 501, truncated: false },
        },
      });
      expect(internals.targetCatalogSnapshots.size).toBeLessThanOrEqual(32);
      expect(internals.targetCatalogSnapshotBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    } finally {
      await registry.unregisterWindow(3);
      await registry.unregisterWindow(4);
    }
  });

  it("keeps target selection and operation ownership independent across shared windows", async () => {
    const rendererSend = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send: rendererSend });
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_1", "interactive")];
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    client.operatorState.Operators = [clientpb.Operator.create({ Name: "operator", Online: true })];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);

    const firstSnapshot = registry.snapshot(1);
    const sessionRef = firstSnapshot.targetContext.selectableTargets.find((ref) => ref.id === "session_1");
    const beaconRef = firstSnapshot.targetContext.selectableTargets.find((ref) => ref.id === "beacon_1");
    expect(sessionRef).toBeDefined();
    expect(beaconRef).toBeDefined();
    await expect(registry.selectTarget(1, sessionRef!)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { status: "selected", activeTargetSummary: { id: "session_1" } } },
    });
    await expect(registry.selectTarget(2, beaconRef!)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { status: "selected", activeTargetSummary: { id: "beacon_1" } } },
    });

    const sessionPing = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    expect(sessionPing).toMatchObject({ ok: true, value: { state: "completed", mode: "session" } });
    const beaconPing = await registry.submitTargetOperation(2, { operationId: "target.ping" });
    expect(beaconPing).toMatchObject({
      ok: true,
      value: { mode: "beacon", taskId: expect.stringMatching(/^task_/u) },
    });
    if (!beaconPing.ok || !beaconPing.value.taskId) throw new Error("Expected a correlated beacon task");
    expect(["submitted", "running"]).toContain(beaconPing.value.state);

    rendererSend.mockClear();
    await expect(registry.listBeaconTasks(2, { limit: 50 })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{
          taskId: beaconPing.value.taskId,
          localRequestId: beaconPing.value.requestId,
          ownership: { origin: "local", ownerWindowId: 2 },
        }],
      },
    });
    expect(rendererSend).not.toHaveBeenCalledWith(IPC.beaconTasksInvalidated, expect.anything());
    await expect(registry.listBeaconTasks(1, { limit: 50 })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Select an available beacon/),
    });
    await expect(registry.listTargetOperations(1, { limit: 50 })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ mode: "session", ownership: { ownerWindowId: 1 } }] },
    });
    await expect(registry.listTargetOperations(2, { limit: 50 })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ mode: "beacon", ownership: { ownerWindowId: 2 } }] },
    });

    const task = client.taskState.get("beacon_1")?.find((candidate) => candidate.ID === beaconPing.value.taskId);
    if (!task) throw new Error("Expected fake beacon task");
    task.State = "completed";
    task.SentAt = String(Math.floor(Date.now() / 1_000));
    task.CompletedAt = String(Math.floor(Date.now() / 1_000) + 1);
    await expect(registry.getBeaconTask(2, task.ID)).resolves.toMatchObject({
      ok: true,
      value: { state: "completed", disposition: { kind: "structured-detail", title: "Ping response" } },
    });
    await expect(registry.getTargetOperation(2, beaconPing.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "completed" },
    });

    expect(registry.snapshot(1).targetContext.activeTargetSummary?.id).toBe("session_1");
    expect(registry.snapshot(2).targetContext.activeTargetSummary?.id).toBe("beacon_1");
  });

  it("coalesces a burst of task-reconciliation signals into one follow-up refresh", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await registry.submitTargetOperation(1, { operationId: "target.ping" });
    const internals = registry as unknown as {
      windows: Map<number, { operationReconcileInFlight?: Promise<void> }>;
      reconcileWindowOperations(
        contentsId: number,
        reason: "server-event",
        includeOutcomeUnknown?: boolean,
      ): Promise<void>;
    };
    await internals.windows.get(1)?.operationReconcileInFlight;
    const baselineCalls = client.getBeaconTasks.mock.calls.length;
    const gate = deferred<clientpb.BeaconTasks>();
    client.getBeaconTasks.mockImplementationOnce(async () => gate.promise);

    const first = internals.reconcileWindowOperations(1, "server-event");
    await vi.waitFor(() => expect(client.getBeaconTasks).toHaveBeenCalledTimes(baselineCalls + 1));
    const burst = Array.from({ length: 12 }, () =>
      internals.reconcileWindowOperations(1, "server-event", true)
    );
    gate.resolve(clientpb.BeaconTasks.create({
      Tasks: (client.taskState.get("beacon_1") ?? []).map((task) => clientpb.BeaconTask.create({
        ...task,
        Request: Buffer.alloc(0),
        Response: Buffer.alloc(0),
      })),
    }));

    await Promise.all([first, ...burst]);
    expect(client.getBeaconTasks).toHaveBeenCalledTimes(baselineCalls + 2);
  });

  it("allows only one window to claim a duplicated server task ID", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "shared")];
    client.setEnvBeacon.mockResolvedValue({
      Response: { Async: true, BeaconID: "beacon_1", TaskID: "shared_task", Err: "" },
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    const target = registry.snapshot(1).targetContext.selectableTargets[0]!;
    await registry.selectTarget(1, target);
    await registry.selectTarget(2, target);

    const first = await registry.submitTargetOperation(1, {
      operationId: "target.env-set",
      name: "SHARED_KEY",
      value: "first",
    });
    const second = await registry.submitTargetOperation(2, {
      operationId: "target.env-set",
      name: "SHARED_KEY",
      value: "second",
    });
    expect(first).toMatchObject({
      ok: true,
      value: { taskId: "shared_task", ownership: { ownerWindowId: 1 } },
    });
    expect(second).toMatchObject({
      ok: true,
      value: {
        state: "outcome-unknown",
        ownership: { ownerWindowId: 2 },
        message: expect.stringMatching(/claimed by another window/),
      },
    });
    if (!first.ok || !second.ok) throw new Error("Expected operation records");
    expect(second.value.taskId).toBeUndefined();

    client.taskState.set("beacon_1", [clientpb.BeaconTask.create({
      ID: "shared_task",
      BeaconID: "beacon_1",
      State: "completed",
      Description: "SetEnvReq",
      CreatedAt: String(Math.floor(Date.now() / 1_000)),
      SentAt: String(Math.floor(Date.now() / 1_000)),
      CompletedAt: String(Math.floor(Date.now() / 1_000) + 1),
      Response: Buffer.from(sliverpb.SetEnv.encode(sliverpb.SetEnv.create({ Response: {} })).finish()),
    })]);
    await expect(registry.getBeaconTask(1, "shared_task")).resolves.toMatchObject({
      ok: true,
      value: { ownership: { origin: "local", ownerWindowId: 1 } },
    });
    await expect(registry.getTargetOperation(1, first.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "completed" },
    });
    await expect(registry.listBeaconTasks(2, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ taskId: "shared_task", ownership: { origin: "unknown" } }] },
    });
    await expect(registry.getTargetOperation(2, second.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "outcome-unknown" },
    });
    expect(client.setEnvBeacon).toHaveBeenCalledTimes(2);
  });

  it("advertises beacon session conversion only for a valid main-owned ActiveC2", async () => {
    const client = new FakeSliverClient();
    const valid = beacon("beacon_valid", "valid");
    const missing = beacon("beacon_missing", "missing");
    missing.ActiveC2 = "";
    const mismatched = beacon("beacon_mismatched", "mismatched");
    mismatched.Transport = "mtls";
    mismatched.ActiveC2 = "https://127.0.0.1:9999/private";
    client.beaconState.Beacons = [valid, missing, mismatched];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    for (const [id, available] of [
      ["beacon_valid", true],
      ["beacon_missing", false],
      ["beacon_mismatched", false],
    ] as const) {
      const ref = registry.snapshot(1).targetContext.selectableTargets.find((candidate) => candidate.id === id)!;
      const selected = await registry.selectTarget(1, ref);
      if (!selected.ok) throw new Error(selected.error);
      const capability = selected.value.targetContext.capabilities.find(
        (candidate) => candidate.id === "beacon.open-session",
      );
      expect(capability?.available).toBe(available);
      if (!available) expect(capability?.reason?.code).toBe("unsupported-transport");
    }
  });

  it("retains a selected target through a deferred refresh while failing dispatch closed", async () => {
    const rendererSend = vi.fn();
    electronMocks.fromId.mockReturnValue({ isDestroyed: () => false, send: rendererSend });
    const client = new FakeSliverClient();
    const stableBeacon = beacon("beacon_1", "async");
    client.beaconState.Beacons = [stableBeacon];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await registry.setBeaconWatch(1, true);
    const selected = registry.snapshot(1).targetContext.activeTarget;
    expect(selected).not.toBeNull();

    rendererSend.mockClear();
    const beaconsGate = deferred<clientpb.Beacons>();
    client.nextBeaconsPromise = beaconsGate.promise;
    const refresh = registry.refresh(1);
    await vi.waitFor(() => expect(registry.snapshot(1).domains.beacons.status).toBe("loading"));

    const duringRefresh = registry.snapshot(1).targetContext;
    expect(duringRefresh).toMatchObject({
      status: "unavailable",
      activeTarget: selected,
      activeTargetSummary: { id: "beacon_1" },
      beaconWatch: true,
      unavailableReason: expect.stringMatching(/refreshing|temporarily disabled/),
    });
    expect(duringRefresh.capabilities).not.toHaveLength(0);
    expect(duringRefresh.capabilities.every((capability) => !capability.available)).toBe(true);
    await expect(registry.submitTargetOperation(1, { operationId: "target.ping" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not authoritative/),
    });
    expect(client.pingBeacon).not.toHaveBeenCalled();

    beaconsGate.resolve(clientpb.Beacons.create({ Beacons: [stableBeacon] }));
    await expect(refresh).resolves.toMatchObject({ ok: true });
    const restored = registry.snapshot(1).targetContext;
    expect(restored).toMatchObject({
      status: "selected",
      activeTarget: {
        mode: selected!.mode,
        id: selected!.id,
        backendEpoch: selected!.backendEpoch,
        fingerprint: selected!.fingerprint,
      },
      activeTargetSummary: { id: "beacon_1" },
      beaconWatch: true,
    });
    expect(restored.capabilities.some((capability) => capability.available)).toBe(true);
    const emittedSnapshots = rendererSend.mock.calls
      .filter(([channel]) => channel === IPC.snapshotChanged)
      .map(([, snapshot]) => snapshot as ReturnType<ConnectionRegistry["snapshot"]>);
    expect(emittedSnapshots.length).toBeGreaterThan(0);
    expect(emittedSnapshots.every((snapshot) =>
      snapshot.targetContext.activeTarget?.id === "beacon_1" &&
      snapshot.targetContext.activeTargetSummary?.id === "beacon_1"
    )).toBe(true);
  });

  it("clears selection and watch after a complete empty inventory and marks in-flight work target-disappeared", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const renameGate = deferred<void>();
    client.renameBeacon.mockImplementationOnce(async () => {
      await renameGate.promise;
      return {};
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await registry.setBeaconWatch(1, true);

    const rename = registry.submitTargetOperation(1, { operationId: "target.rename", name: "renamed" });
    await vi.waitFor(() => expect(client.renameBeacon).toHaveBeenCalledOnce());
    client.beaconState.Beacons = [];
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    renameGate.resolve(undefined);
    await expect(rename).resolves.toMatchObject({
      ok: true,
      value: { state: "target-disappeared", target: { id: "beacon_1" } },
    });

    expect(registry.snapshot(1).targetContext).toMatchObject({
      status: "none",
      activeTarget: null,
      activeTargetSummary: null,
      beaconWatch: false,
    });
    expect(history).toMatchObject({
      ok: true,
      value: { items: [{ state: "target-disappeared", target: { id: "beacon_1" } }] },
    });
    expect(client.renameBeacon).toHaveBeenCalledOnce();
  });

  it("treats an omitted target in the full paged catalog as authoritatively disappeared", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_selected", "selected")];
    const pingGate = deferred<void>();
    client.pingSession.mockImplementationOnce(async (_sessionId, nonce) => {
      await pingGate.promise;
      return sliverpb.Ping.create({ Nonce: nonce });
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const ping = registry.submitTargetOperation(1, { operationId: "target.ping" });
    await vi.waitFor(() => expect(client.pingSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) =>
      session(`session_${String(index).padStart(4, "0")}`, `session-${index}`),
    );
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    const boundedSnapshot = registry.snapshot(1);
    const history = await registry.listTargetOperations(1, { limit: 100 });
    pingGate.resolve(undefined);
    await expect(ping).resolves.toMatchObject({ ok: true, value: { state: "target-disappeared" } });

    expect(boundedSnapshot.domains.sessions.page).toMatchObject({ total: 501, truncated: true });
    expect(boundedSnapshot.targetContext).toMatchObject({
      status: "none",
      activeTarget: null,
      activeTargetSummary: null,
    });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error(history.error);
    expect(history.value.items[0]?.state).toBe("target-disappeared");
    expect(client.pingSession).toHaveBeenCalledOnce();
  });

  it("reruns an older in-flight inventory refresh before executing a destructive target plan", async () => {
    const client = new FakeSliverClient();
    const dead = session("session_dead", "dead");
    dead.IsDead = true;
    client.sessionState.Sessions = [dead];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const prepared = await registry.prepareTargetAction(1, { actionId: "sessions.prune-dead" });
    if (!prepared.ok) throw new Error(prepared.error);
    const baselineCalls = client.getSessions.mock.calls.length;

    const staleSessions = deferred<clientpb.Sessions>();
    client.nextSessionsPromise = staleSessions.promise;
    const olderRefresh = registry.refresh(1);
    await vi.waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(baselineCalls + 1));
    client.sessionState.Sessions = [session("session_dead", "now-active")];
    const execute = registry.executeTargetActionPlan(1, prepared.value.token);
    await Promise.resolve();
    staleSessions.resolve(clientpb.Sessions.create({ Sessions: [dead] }));

    await expect(olderRefresh).resolves.toMatchObject({ ok: true });
    await expect(execute).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/reviewed target set changed|no longer available/),
    });
    expect(client.getSessions).toHaveBeenCalledTimes(baselineCalls + 2);
    expect(client.killSession).not.toHaveBeenCalled();
  });

  it("revalidates every bulk-prune target immediately before dispatch", async () => {
    const client = new FakeSliverClient();
    const first = session("session_dead_a", "dead-a");
    const second = session("session_dead_b", "dead-b");
    first.IsDead = true;
    second.IsDead = true;
    client.sessionState.Sessions = [first, second];
    const firstKill = deferred<void>();
    client.killSession.mockImplementationOnce(async (sessionId: string) => {
      await firstKill.promise;
      client.sessionState.Sessions = client.sessionState.Sessions.filter((candidate) => candidate.ID !== sessionId);
      return {};
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const prepared = await registry.prepareTargetAction(1, { actionId: "sessions.prune-dead" });
    if (!prepared.ok) throw new Error(prepared.error);

    const execution = registry.executeTargetActionPlan(1, prepared.value.token);
    await vi.waitFor(() => expect(client.killSession).toHaveBeenCalledWith("session_dead_a", false));
    client.sessionState.Sessions = [first, session("session_dead_b", "revived")];
    firstKill.resolve(undefined);

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: {
        outcomes: [
          { target: { id: "session_dead_a" }, status: "succeeded" },
          { target: { id: "session_dead_b" }, status: "skipped" },
        ],
        partial: true,
      },
    });
    expect(client.killSession).toHaveBeenCalledOnce();
  });

  it("reviews and executes an eligible target beyond the 500-row projection", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) => {
      const record = session(`session_${String(index).padStart(4, "0")}`, `session-${index}`);
      record.IsDead = index === 500;
      return record;
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareTargetAction(1, { actionId: "sessions.prune-dead" });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        impact: {
          targets: [{ id: "session_0500" }],
          totalTargets: 1,
          truncated: false,
        },
      },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeTargetActionPlan(1, prepared.value.token)).resolves.toMatchObject({
      ok: true,
      value: { outcomes: [{ target: { id: "session_0500" }, status: "succeeded" }] },
    });
    expect(client.killSession).toHaveBeenCalledWith("session_0500", false);
  });

  it("bounds bulk-prune review plans and discloses the full matching count", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = Array.from({ length: 501 }, (_, index) => {
      const record = session(`session_${String(index).padStart(4, "0")}`, `session-${index}`);
      record.IsDead = true;
      return record;
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);

    const prepared = await registry.prepareTargetAction(1, { actionId: "sessions.prune-dead" });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.value.impact.targets).toHaveLength(100);
    expect(prepared.value.impact).toMatchObject({ totalTargets: 501, truncated: true });
    expect(prepared.value.impact.warning).toMatch(/100 of 501/u);
  });

  it("reconciles a lost rename response against its journaled target after selection changes", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [
      session("session_a", "first"),
      session("session_b", "second"),
    ];
    const renameGate = deferred<void>();
    client.renameSession.mockImplementationOnce(async (sessionId: string, name: string) => {
      const target = client.sessionState.Sessions.find((candidate) => candidate.ID === sessionId);
      if (target) target.Name = name;
      await renameGate.promise;
      throw new Error("response lost after rename");
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const firstRef = registry.snapshot(1).targetContext.selectableTargets.find((ref) => ref.id === "session_a")!;
    const secondRef = registry.snapshot(1).targetContext.selectableTargets.find((ref) => ref.id === "session_b")!;
    await registry.selectTarget(1, firstRef);

    const rename = registry.submitTargetOperation(1, {
      operationId: "target.rename",
      name: "renamed-first",
    });
    await vi.waitFor(() => expect(client.renameSession).toHaveBeenCalledOnce());
    await expect(registry.selectTarget(1, secondRef)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTargetSummary: { id: "session_b" } } },
    });
    renameGate.resolve(undefined);

    await expect(rename).resolves.toMatchObject({
      ok: true,
      value: {
        operationId: "target.rename",
        target: { id: "session_a" },
        state: "completed",
      },
    });
    expect(client.renameSession).toHaveBeenCalledOnce();
    expect(registry.snapshot(1).targetContext.activeTargetSummary?.id).toBe("session_b");
  });

  it("cancels only the exact pending beacon task and rejects stale target references", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const staleRef = registry.snapshot(1).targetContext.selectableTargets[0]!;
    client.beaconState.Beacons[0]!.Name = "updated-after-selection";
    await registry.refresh(1);
    await expect(registry.selectTarget(1, staleRef)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/stale/),
    });

    const currentRef = registry.snapshot(1).targetContext.selectableTargets[0]!;
    await expect(registry.selectTarget(1, currentRef)).resolves.toMatchObject({ ok: true });
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated beacon task");
    await expect(registry.cancelTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled", taskId: submitted.value.taskId },
    });
    expect(client.cancelBeaconTask).toHaveBeenCalledWith(submitted.value.taskId);
    await expect(registry.getBeaconTask(1, submitted.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled" },
    });
    await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled" },
    });
  });

  it("keeps a locally rejected ninth task cancellation eligible for one retry", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const operations = [];
    for (let index = 0; index < 9; index += 1) {
      const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
      if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated ping task");
      operations.push(submitted.value);
    }
    const admittedTaskIds = operations.slice(0, 8).map((operation) => operation.taskId!);
    const ninthTaskId = operations[8]!.taskId!;
    const gates = new Map(admittedTaskIds.map((taskId) => [taskId, deferred<void>()]));
    client.cancelBeaconTask.mockImplementation(async (taskId: string) => {
      const gate = gates.get(taskId);
      if (gate) await gate.promise;
      const task = client.taskState.get("beacon_1")?.find((candidate) => candidate.ID === taskId);
      if (!task) throw new Error("missing task");
      task.State = "canceled";
      return clientpb.BeaconTask.create({ ...task });
    });

    const admitted = operations.slice(0, 8).map((operation) =>
      registry.cancelTargetOperation(1, operation.requestId)
    );
    await vi.waitFor(() => expect(client.cancelBeaconTask).toHaveBeenCalledTimes(8));

    await expect(registry.cancelTargetOperation(1, operations[8]!.requestId)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Too many beacon task cancellations/u),
    });
    expect(client.cancelBeaconTask).toHaveBeenCalledTimes(8);
    expect(client.cancelBeaconTask).not.toHaveBeenCalledWith(ninthTaskId);

    gates.get(admittedTaskIds[0]!)?.resolve(undefined);
    await expect(admitted[0]).resolves.toMatchObject({ ok: true, value: { state: "canceled" } });

    await expect(registry.cancelTargetOperation(1, operations[8]!.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled", taskId: ninthTaskId },
    });
    expect(client.cancelBeaconTask.mock.calls.filter(([taskId]) => taskId === ninthTaskId)).toHaveLength(1);

    for (const taskId of admittedTaskIds.slice(1)) gates.get(taskId)?.resolve(undefined);
    await expect(Promise.all(admitted.slice(1))).resolves.toHaveLength(7);
  });

  it("preserves direct task-cancellation policy denials without dispatching", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = await registry.submitTargetOperation(1, {
      operationId: "beacon.reconfigure",
      intervalSeconds: 5,
      jitterSeconds: 1,
    });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a reconfigure task");

    await expect(registry.cancelBeaconTask(1, submitted.value.taskId)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot be canceled safely|server timing metadata/u),
    });
    expect(client.cancelBeaconTask).not.toHaveBeenCalled();
  });

  it.each([
    ["canceled", "canceled"],
    ["sent", "running"],
    ["completed", "completed"],
  ] as const)("reconciles an already-%s task without dispatching cancellation", async (taskState, operationState) => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated ping task");
    const task = client.taskState.get("beacon_1")?.find(({ ID }) => ID === submitted.value!.taskId);
    if (!task) throw new Error("Expected the fake ping task");
    task.State = taskState;
    if (taskState === "sent" || taskState === "completed") task.SentAt = String(Math.floor(Date.now() / 1_000));
    if (taskState === "completed") task.CompletedAt = String(Math.floor(Date.now() / 1_000));

    await expect(registry.cancelBeaconTask(1, submitted.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        taskId: submitted.value.taskId,
        state: taskState,
      },
    });
    await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: {
        state: operationState,
        ...(taskState === "completed" ? { disposition: { kind: "structured-detail" } } : {}),
      },
    });
    expect(client.cancelBeaconTask).not.toHaveBeenCalled();
  });

  it("does not return a confirmed old-target cancellation as current after selection changes", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_a", "first"), beacon("beacon_b", "second")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const first = registry.snapshot(1).targetContext.selectableTargets.find((target) => target.id === "beacon_a")!;
    await registry.selectTarget(1, first);
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a ping task");
    const cancelGate = deferred<void>();
    client.cancelBeaconTask.mockImplementationOnce(async (taskId: string) => {
      await cancelGate.promise;
      const task = client.taskState.get("beacon_a")?.find((candidate) => candidate.ID === taskId);
      if (!task) throw new Error("missing task");
      task.State = "canceled";
      return clientpb.BeaconTask.create({ ...task });
    });

    const cancellation = registry.cancelBeaconTask(1, submitted.value.taskId);
    await vi.waitFor(() => expect(client.cancelBeaconTask).toHaveBeenCalledOnce());
    const currentSecond = registry.snapshot(1).targetContext.selectableTargets.find((target) => target.id === "beacon_b");
    if (!currentSecond) throw new Error("Expected the second beacon to remain selectable");
    await expect(registry.selectTarget(1, currentSecond)).resolves.toMatchObject({ ok: true });
    cancelGate.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/previously selected backend target/u),
    });
    expect(registry.snapshot(1).targetContext.activeTargetSummary?.id).toBe("beacon_b");
    expect(client.cancelBeaconTask).toHaveBeenCalledOnce();
  });

  it("uses exact task lookup to reconcile cancellation beyond the first 100 active tasks", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated beacon task");
    const tasks = client.taskState.get("beacon_1");
    if (!tasks) throw new Error("Expected fake beacon task inventory");
    tasks.push(...activeBeaconTasks("beacon_1", 101, "first_page_distractor"));

    const exactTaskSpy = vi.spyOn(BeaconTaskStore.prototype, "task");
    const pageSpy = vi.spyOn(BeaconTaskStore.prototype, "list");
    try {
      await expect(registry.cancelBeaconTask(1, submitted.value.taskId)).resolves.toMatchObject({
        ok: true,
        value: {
          taskId: submitted.value.taskId,
          state: "canceled",
          localRequestId: submitted.value.requestId,
        },
      });
      expect(client.cancelBeaconTask).toHaveBeenCalledWith(submitted.value.taskId);
      expect(exactTaskSpy).toHaveBeenCalledWith("beacon_1", submitted.value.taskId, expect.any(Function));
      expect(pageSpy).not.toHaveBeenCalled();
      await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
        ok: true,
        value: { state: "canceled", taskId: submitted.value.taskId },
      });
    } finally {
      exactTaskSpy.mockRestore();
      pageSpy.mockRestore();
    }
  });

  it("keeps an exact cancellation authoritative when refresh fails and reconciles a lost cancel response", async () => {
    const exactClient = new FakeSliverClient();
    exactClient.beaconState.Beacons = [beacon("beacon_1", "async")];
    const exactRegistry = createRegistry(() => exactClient.adapter);
    exactRegistry.registerWindow(1);
    await connectSaved(exactRegistry, 1);
    await exactRegistry.selectTarget(1, exactRegistry.snapshot(1).targetContext.selectableTargets[0]!);
    const exactSubmitted = await exactRegistry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!exactSubmitted.ok || !exactSubmitted.value.taskId) throw new Error("Expected a correlated beacon task");
    exactClient.getBeaconTasks
      .mockImplementationOnce(async (beaconId: string) => clientpb.BeaconTasks.create({
        Tasks: (exactClient.taskState.get(beaconId) ?? []).map((task) => clientpb.BeaconTask.create({
          ...task,
          Request: Buffer.alloc(0),
          Response: Buffer.alloc(0),
        })),
      }))
      .mockRejectedValueOnce(new Error("post-cancel inventory unavailable"));

    await expect(exactRegistry.cancelBeaconTask(1, exactSubmitted.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { taskId: exactSubmitted.value.taskId, state: "canceled" },
    });
    await expect(exactRegistry.getTargetOperation(1, exactSubmitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled" },
    });
    expect(exactClient.cancelBeaconTask).toHaveBeenCalledOnce();

    const lostClient = new FakeSliverClient();
    lostClient.beaconState.Beacons = [beacon("beacon_2", "async")];
    const lostRegistry = createRegistry(() => lostClient.adapter);
    lostRegistry.registerWindow(2);
    await connectSaved(lostRegistry, 2);
    await lostRegistry.selectTarget(2, lostRegistry.snapshot(2).targetContext.selectableTargets[0]!);
    const lostSubmitted = await lostRegistry.submitTargetOperation(2, { operationId: "target.ping" });
    if (!lostSubmitted.ok || !lostSubmitted.value.taskId) throw new Error("Expected a correlated beacon task");
    lostClient.cancelBeaconTask.mockImplementationOnce(async (taskId: string) => {
      const task = lostClient.taskState.get("beacon_2")?.find((candidate) => candidate.ID === taskId);
      if (task) task.State = "canceled";
      throw new Error("cancel response lost");
    });

    await expect(lostRegistry.cancelBeaconTask(2, lostSubmitted.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: { taskId: lostSubmitted.value.taskId, state: "canceled" },
    });
    await expect(lostRegistry.getTargetOperation(2, lostSubmitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled" },
    });
    expect(lostClient.cancelBeaconTask).toHaveBeenCalledOnce();
  });

  it("pins and reconciles a cancel-target task among more than 500 active tasks", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated beacon task");
    const tasks = client.taskState.get("beacon_1");
    if (!tasks) throw new Error("Expected fake beacon task inventory");
    tasks.push(...activeBeaconTasks("beacon_1", 501, "bounded_distractor"));

    const listed = await registry.listBeaconTasks(1, { limit: 100 });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.value.page).toMatchObject({ total: 502, truncated: true });
    expect(listed.value.items).toHaveLength(100);
    expect(listed.value.items[0]).toMatchObject({
      taskId: submitted.value.taskId,
      localRequestId: submitted.value.requestId,
      ownership: { origin: "local", ownerWindowId: 1 },
    });
    await expect(registry.cancelTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled", taskId: submitted.value.taskId },
    });
    expect(client.cancelBeaconTask).toHaveBeenCalledWith(submitted.value.taskId);
    await expect(registry.getBeaconTask(1, submitted.value.taskId)).resolves.toMatchObject({
      ok: true,
      value: {
        taskId: submitted.value.taskId,
        state: "canceled",
        localRequestId: submitted.value.requestId,
      },
    });
    await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "canceled", taskId: submitted.value.taskId },
    });
  });

  it("keeps beacon task continuation pages on one catalog and refreshes new tasks on restart", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    client.taskState.set("beacon_1", activeBeaconTasks("beacon_1", 3, "history"));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const first = await registry.listBeaconTasks(1, { limit: 2 });
    if (!first.ok || !first.value.page.nextCursor) throw new Error("Expected a task continuation cursor");
    expect(client.getBeaconTasks).toHaveBeenCalledOnce();
    const newerTask = activeBeaconTasks("beacon_1", 1, "newer")[0]!;
    newerTask.CreatedAt = "3000000000";
    client.taskState.get("beacon_1")!.push(newerTask);

    const second = await registry.listBeaconTasks(1, {
      cursor: first.value.page.nextCursor,
      limit: 2,
    });
    if (!second.ok) throw new Error(second.error);
    expect(second.value.items).toHaveLength(1);
    expect(client.getBeaconTasks).toHaveBeenCalledOnce();
    expect(new Set([...first.value.items, ...second.value.items].map(({ taskId }) => taskId)).size).toBe(3);

    const restarted = await registry.listBeaconTasks(1, { limit: 2 });
    if (!restarted.ok) throw new Error(restarted.error);
    expect(client.getBeaconTasks).toHaveBeenCalledTimes(2);
    expect(restarted.value.items[0]?.taskId).toMatch(/^newer_/u);
  });

  it("bounds same-beacon task-list waiters per window without starving another window", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_a", "async-a"), beacon("beacon_b", "async-b")];
    client.taskState.set("beacon_a", activeBeaconTasks("beacon_a", 1, "a_task"));
    client.taskState.set("beacon_b", activeBeaconTasks("beacon_b", 1, "b_task"));
    const beaconAGate = deferred<void>();
    client.getBeaconTasks.mockImplementation(async (beaconId: string) => {
      if (beaconId === "beacon_a") await beaconAGate.promise;
      return clientpb.BeaconTasks.create({
        Tasks: (client.taskState.get(beaconId) ?? []).map((task) => clientpb.BeaconTask.create({
          ...task,
          Request: Buffer.alloc(0),
          Response: Buffer.alloc(0),
        })),
      });
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    const targetA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "beacon_a");
    const targetB = registry.snapshot(2).targetContext.selectableTargets.find(({ id }) => id === "beacon_b");
    if (!targetA || !targetB) throw new Error("Expected both fake beacons to be selectable");
    await registry.selectTarget(1, targetA);
    await registry.selectTarget(2, targetB);

    const admitted = Array.from({ length: 4 }, () => registry.listBeaconTasks(1, { limit: 100 }));
    await vi.waitFor(() => {
      expect(client.getBeaconTasks.mock.calls.filter(([beaconId]) => beaconId === "beacon_a")).toHaveLength(1);
    });
    await expect(registry.listBeaconTasks(1, { limit: 100 })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Too many beacon task inventories/),
    });

    await expect(registry.listBeaconTasks(2, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: { items: [{ taskId: expect.stringMatching(/^b_task_/u) }] },
    });
    beaconAGate.resolve(undefined);
    await expect(Promise.all(admitted)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
    expect(client.getBeaconTasks.mock.calls.filter(([beaconId]) => beaconId === "beacon_a")).toHaveLength(2);
  });

  it("bounds concurrent task-detail admissions per window before raw content fetch", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    client.taskState.set("beacon_1", [clientpb.BeaconTask.create({
      ID: "completed_task",
      BeaconID: "beacon_1",
      State: "completed",
      Description: "Ping",
      CreatedAt: String(Math.floor(Date.now() / 1_000)),
      SentAt: String(Math.floor(Date.now() / 1_000)),
      CompletedAt: String(Math.floor(Date.now() / 1_000)),
    })]);
    const fetchGate = deferred<void>();
    client.fetchBeaconTask.mockImplementation(async () => {
      await fetchGate.promise;
      return clientpb.BeaconTask.create({
        ...client.taskState.get("beacon_1")![0],
        Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 7 })).finish()),
      });
    });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const admitted = Array.from({ length: 4 }, () => registry.getBeaconTask(1, "completed_task"));
    await vi.waitFor(() => expect(client.fetchBeaconTask).toHaveBeenCalledTimes(4));
    await expect(registry.getBeaconTask(1, "completed_task")).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/Too many beacon task details/),
    });
    expect(client.fetchBeaconTask).toHaveBeenCalledTimes(4);
    fetchGate.resolve(undefined);
    await expect(Promise.all(admitted)).resolves.toHaveLength(4);
  });

  it("keeps editable config operator metadata out of verified operation attribution", async () => {
    await writeFile(join(externalDirectory, "spoofed.cfg"), validConfig({ operator: "spoofed-verified-actor" }));
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_1", "interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectNamed(registry, 1, "spoofed");
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const operation = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    expect(registry.snapshot(1).connection.operator).toBe("spoofed-verified-actor");
    expect(operation).toMatchObject({
      ok: true,
      value: { ownership: { origin: "local", actor: { attribution: "unknown" } } },
    });
    expect(JSON.stringify(operation)).not.toContain('"attribution":"verified"');
  });

  it("fails target actions closed while their inventory is non-authoritative and recovers selection", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    client.getBeacons.mockRejectedValueOnce(new Error("temporary beacon inventory failure"));
    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: false });
    expect(registry.snapshot(1).targetContext).toMatchObject({
      status: "unavailable",
      selectableTargets: [],
      unavailableReason: expect.stringMatching(/refreshing|unavailable/),
    });
    await expect(registry.submitTargetOperation(1, { operationId: "target.ping" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/not authoritative/),
    });
    expect(client.pingBeacon).not.toHaveBeenCalled();

    await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
    expect(registry.snapshot(1).targetContext).toMatchObject({
      status: "selected",
      activeTargetSummary: { id: "beacon_1" },
    });
  });

  it("prunes task catalogs only after a complete authoritative beacon inventory", async () => {
    const pruneSpy = vi.spyOn(BeaconTaskStore.prototype, "pruneAbsentBeacons");
    try {
      const client = new FakeSliverClient();
      client.beaconState.Beacons = [beacon("beacon_keep", "keep"), beacon("beacon_removed", "removed")];
      const registry = createRegistry(() => client.adapter);
      registry.registerWindow(1);
      await connectSaved(registry, 1);
      pruneSpy.mockClear();

      client.getBeacons.mockRejectedValueOnce(new Error("temporary beacon inventory failure"));
      await expect(registry.refresh(1)).resolves.toMatchObject({ ok: false });
      expect(pruneSpy).not.toHaveBeenCalled();

      client.beaconState.Beacons = Array.from({ length: 501 }, (_, index) =>
        beacon(`beacon_${String(index).padStart(4, "0")}`, `beacon-${index}`),
      );
      await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
      expect(registry.snapshot(1).domains.beacons.page.truncated).toBe(true);
      expect(pruneSpy).toHaveBeenCalledOnce();
      expect(pruneSpy.mock.calls[0]?.[0]).toHaveLength(501);
      expect(pruneSpy.mock.calls[0]?.[0]).toContain("beacon_0500");
      pruneSpy.mockClear();

      client.beaconState.Beacons = [beacon("beacon_keep", "keep")];
      await expect(registry.refresh(1)).resolves.toMatchObject({ ok: true });
      expect(pruneSpy).toHaveBeenCalledOnce();
      expect(pruneSpy).toHaveBeenCalledWith(["beacon_keep"]);
    } finally {
      pruneSpy.mockRestore();
    }
  });

  it("reconciles a correlated beacon task after operator connection uncertainty without resubmission", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const submitted = await registry.submitTargetOperation(1, { operationId: "target.ping" });
    if (!submitted.ok || !submitted.value.taskId) throw new Error("Expected a correlated beacon task");

    client.streamStates.next({ status: "retrying", attempt: 1, error: "fault proxy blocked" });
    await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "outcome-unknown", taskId: submitted.value.taskId },
    });
    const task = client.taskState.get("beacon_1")?.find((candidate) => candidate.ID === submitted.value.taskId);
    if (!task) throw new Error("Expected fake beacon task");
    task.State = "completed";
    task.SentAt = String(Math.floor(Date.now() / 1_000));
    task.CompletedAt = String(Math.floor(Date.now() / 1_000) + 1);
    client.streamStates.next({ status: "connected", attempt: 0 });
    await registry.getBeaconTask(1, task.ID);

    await expect(registry.getTargetOperation(1, submitted.value.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "completed", disposition: { kind: "structured-detail" } },
    });
    expect(client.pingBeacon).toHaveBeenCalledOnce();
  });

  it("binds destructive target actions to a reviewed one-use plan", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_1", "async")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const prepared = await registry.prepareTargetAction(1, { actionId: "target.kill" });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        impact: {
          targets: [{ id: "beacon_1" }],
          warning: expect.stringMatching(/outcome unknown/),
        },
      },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    await expect(registry.executeTargetActionPlan(1, prepared.value.token)).resolves.toMatchObject({
      ok: true,
      value: { outcomes: [{ target: { id: "beacon_1" }, status: "outcome-unknown" }] },
    });
    await expect(registry.executeTargetActionPlan(1, prepared.value.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expired or was already used/),
    });
    expect(client.killBeacon).toHaveBeenCalledOnce();
  });

  it("bounds parallel target action plan preparation and retained reviews per window", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_1", "interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const inventoryGate = deferred<clientpb.Sessions>();
    client.nextSessionsPromise = inventoryGate.promise;

    const preparations = Array.from({ length: 9 }, () =>
      registry.prepareTargetAction(1, { actionId: "target.kill" })
    );
    await vi.waitFor(() => expect(client.getSessions.mock.calls.length).toBeGreaterThan(0));
    inventoryGate.resolve(clientpb.Sessions.create(client.sessionState));
    const results = await Promise.all(preparations);

    expect(results.filter((result) => result.ok)).toHaveLength(8);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ error: expect.stringMatching(/Too many target action plans/) }),
    ]);
    const internals = registry as unknown as {
      windows: Map<number, { targetPlans: Map<string, unknown>; targetPlanAdmissions: Set<string> }>;
    };
    expect(internals.windows.get(1)?.targetPlans.size).toBe(8);
    expect(internals.windows.get(1)?.targetPlanAdmissions.size).toBe(0);
  });

  it("returns backend-bound destructive outcomes and skips undispatched targets after a config switch", async () => {
    await writeFile(join(externalDirectory, "backend-b.cfg"), validConfig({ lport: 31338, token: "backend-b" }));
    const firstClient = new FakeSliverClient();
    const secondClient = new FakeSliverClient();
    const deadA = session("session_a", "dead-a");
    const deadB = session("session_b", "dead-b");
    deadA.IsDead = true;
    deadB.IsDead = true;
    firstClient.sessionState.Sessions = [deadA, deadB];
    const killGate = deferred<void>();
    firstClient.killSession.mockImplementationOnce(async (sessionId: string) => {
      await killGate.promise;
      firstClient.sessionState.Sessions = firstClient.sessionState.Sessions.filter(({ ID }) => ID !== sessionId);
      return {};
    });
    const clients = [firstClient, secondClient];
    const registry = createRegistry(() => clients.shift()!.adapter);
    registry.registerWindow(1);
    await connectNamed(registry, 1, "operator");
    const prepared = await registry.prepareTargetAction(1, { actionId: "sessions.prune-dead" });
    if (!prepared.ok) throw new Error(prepared.error);

    const execution = registry.executeTargetActionPlan(1, prepared.value.token);
    await vi.waitFor(() => expect(firstClient.killSession).toHaveBeenCalledOnce());
    await connectNamed(registry, 1, "backend-b");
    killGate.resolve(undefined);

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: {
        actionId: "sessions.prune-dead",
        outcomes: [
          { ownerWindowId: 1, target: { id: "session_a" }, status: "succeeded" },
          { ownerWindowId: 1, target: { id: "session_b" }, status: "skipped" },
        ],
        partial: true,
      },
    });
    expect(firstClient.killSession).toHaveBeenCalledOnce();
    expect(secondClient.killSession).not.toHaveBeenCalled();
    expect(registry.snapshot(1).connection.server).toBe("localhost:31338");
  });

  it.each([
    ["target.kill", "killSession"],
    ["session.close", "closeSession"],
  ] as const)(
    "reconciles %s as succeeded when its response is lost after exact session removal",
    async (actionId, method) => {
      const client = new FakeSliverClient();
      client.sessionState.Sessions = [session("session_1", "interactive")];
      client[method].mockImplementationOnce(async (sessionId: string) => {
        client.sessionState.Sessions = client.sessionState.Sessions.filter(
          (candidate) => candidate.ID !== sessionId,
        );
        throw new Error("response lost after mutation");
      });
      const registry = createRegistry(() => client.adapter);
      registry.registerWindow(1);
      await connectSaved(registry, 1);
      await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
      const prepared = await registry.prepareTargetAction(1, { actionId });
      if (!prepared.ok) throw new Error(prepared.error);

      await expect(registry.executeTargetActionPlan(1, prepared.value.token)).resolves.toMatchObject({
        ok: true,
        value: {
          outcomes: [{
            requestId: expect.stringMatching(/^[A-Za-z0-9-]+$/u),
            ownerWindowId: 1,
            target: { id: "session_1" },
            status: "succeeded",
          }],
        },
      });
      expect(client[method]).toHaveBeenCalledOnce();
    },
  );

  it("reconciles beacon removal after a lost response and keeps unproved actions outcome unknown", async () => {
    const removedClient = new FakeSliverClient();
    removedClient.beaconState.Beacons = [beacon("beacon_1", "async")];
    removedClient.rmBeacon.mockImplementationOnce(async (beaconId: string) => {
      removedClient.beaconState.Beacons = removedClient.beaconState.Beacons.filter(
        (candidate) => candidate.ID !== beaconId,
      );
      throw new Error("response lost after mutation");
    });
    const removedRegistry = createRegistry(() => removedClient.adapter);
    removedRegistry.registerWindow(1);
    await connectSaved(removedRegistry, 1);
    await removedRegistry.selectTarget(1, removedRegistry.snapshot(1).targetContext.selectableTargets[0]!);
    const removedPlan = await removedRegistry.prepareTargetAction(1, { actionId: "beacon.remove" });
    if (!removedPlan.ok) throw new Error(removedPlan.error);
    await expect(removedRegistry.executeTargetActionPlan(1, removedPlan.value.token)).resolves.toMatchObject({
      ok: true,
      value: { outcomes: [{ target: { id: "beacon_1" }, status: "succeeded" }] },
    });
    expect(removedClient.rmBeacon).toHaveBeenCalledOnce();

    const unknownClient = new FakeSliverClient();
    unknownClient.sessionState.Sessions = [session("session_2", "interactive")];
    unknownClient.killSession.mockRejectedValueOnce(new Error("response lost before mutation"));
    const unknownRegistry = createRegistry(() => unknownClient.adapter);
    unknownRegistry.registerWindow(2);
    await connectSaved(unknownRegistry, 2);
    await unknownRegistry.selectTarget(2, unknownRegistry.snapshot(2).targetContext.selectableTargets[0]!);
    const unknownPlan = await unknownRegistry.prepareTargetAction(2, { actionId: "target.kill" });
    if (!unknownPlan.ok) throw new Error(unknownPlan.error);
    await expect(unknownRegistry.executeTargetActionPlan(2, unknownPlan.value.token)).resolves.toMatchObject({
      ok: true,
      value: {
        outcomes: [{
          ownerWindowId: 2,
          target: { id: "session_2" },
          status: "outcome-unknown",
          error: expect.stringMatching(/could not be confirmed/),
        }],
      },
    });
    expect(unknownClient.killSession).toHaveBeenCalledOnce();
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

  it("binds session workbench reads to the selected active session and redacts sensitive environment values", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    client.environmentState.set("PATH", "/usr/bin");
    client.environmentState.set("API_TOKEN", "TOP-SECRET-M2-TOKEN");
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    const sessionRef = registry.snapshot(1).targetContext.selectableTargets.find((ref) => ref.mode === "session");
    expect(sessionRef).toBeDefined();
    await registry.selectTarget(1, sessionRef!);

    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
      limit: 100,
    })).resolves.toEqual({
      ok: true,
      value: {
        status: "completed",
        result: {
          operationId: "session.environment.list",
          value: {
            items: [
              { name: "PATH", value: "/usr/bin", sensitive: false, redacted: false },
              { name: "API_TOKEN", sensitive: true, redacted: true },
            ],
            page: { limit: 100, total: 2, truncated: false },
          },
        },
      },
    });
    expect(JSON.stringify(await registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
    }))).not.toContain("TOP-SECRET-M2-TOKEN");
    expect(client.listEnvSession).toHaveBeenCalledWith("session_m2");

    await expect(registry.runSessionWorkbench(sender(2), {
      operationId: "session.environment.list",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Select an active session/) });
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.identity.current-token-owner",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable on darwin/) });
    expect(client.currentTokenOwnerSession).not.toHaveBeenCalled();
  });

  it("keeps a confirmed session mutation completed while suppressing its stale-selection result", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const mutationGate = deferred<sliverpb.Mkdir>();
    client.mkdirSession.mockImplementationOnce(async () => mutationGate.promise);

    const mutation = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/TOP-SECRET-confirmed-create",
    });
    await vi.waitFor(() => expect(client.mkdirSession).toHaveBeenCalledOnce());
    await registry.backgroundTarget(1);
    mutationGate.resolve(sliverpb.Mkdir.create({ Path: "/tmp/TOP-SECRET-confirmed-create" }));

    const result = await mutation;
    expect(result).toEqual({
      ok: false,
      error: "The session mutation completed for the previously selected session; refresh the session state before continuing",
    });
    expect(client.mkdirSession).toHaveBeenCalledOnce();
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.mkdir", state: "completed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ result, history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("recovers target-loss uncertainty after an exact mutation success without exposing the stale result", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const mutationGate = deferred<sliverpb.Mkdir>();
    client.mkdirSession.mockImplementationOnce(async () => mutationGate.promise);

    const mutation = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/TOP-SECRET-late-exact-create",
    });
    await vi.waitFor(() => expect(client.mkdirSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = [];
    await registry.refresh(1);
    mutationGate.resolve(sliverpb.Mkdir.create({ Path: "/tmp/TOP-SECRET-late-exact-create" }));

    const result = await mutation;
    expect(result).toEqual({
      ok: false,
      error: "The session mutation completed for the previously selected session; refresh the session state before continuing",
    });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.mkdir", state: "completed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ result, history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("does not recover an exact mutation response after the backend incarnation changes", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const mutationGate = deferred<sliverpb.Mkdir>();
    client.mkdirSession.mockImplementationOnce(async () => mutationGate.promise);

    const mutation = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/TOP-SECRET-stale-incarnation-create",
    });
    await vi.waitFor(() => expect(client.mkdirSession).toHaveBeenCalledOnce());
    await registry.disconnect(1);
    mutationGate.resolve(sliverpb.Mkdir.create({ Path: "/tmp/TOP-SECRET-stale-incarnation-create" }));

    await expect(mutation).resolves.toMatchObject({
      ok: true,
      value: { status: "outcome-unknown", operationId: "session.filesystem.mkdir" },
    });
    expect(JSON.stringify({ result: await mutation, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("does not downgrade a confirmed service start when selection drifts during its detail refresh", async () => {
    const client = new FakeSliverClient();
    const sessionARecord = session("session_a", "session-a");
    const sessionBRecord = session("session_b", "session-b");
    sessionARecord.OS = "windows";
    sessionBRecord.OS = "windows";
    client.sessionState.Sessions = [sessionARecord, sessionBRecord];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a")!;
    const sessionB = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b")!;
    await registry.selectTarget(1, sessionA);
    const detailGate = deferred<sliverpb.ServiceDetail>();
    client.serviceDetailSession.mockImplementationOnce(async () => detailGate.promise);

    const start = registry.runSessionWorkbench(sender(1), {
      operationId: "session.service.start",
      name: "TOP-SECRET-service-name",
    });
    await vi.waitFor(() => expect(client.startServiceSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(client.serviceDetailSession).toHaveBeenCalledOnce());
    await registry.selectTarget(1, sessionB);
    detailGate.resolve(sliverpb.ServiceDetail.create({
      Detail: {
        Name: "TOP-SECRET-service-name",
        DisplayName: "TOP-SECRET display name",
        Description: "TOP-SECRET description",
        Status: 4,
        StartupType: 2,
        BinPath: "C:\\TOP-SECRET\\service.exe",
        Account: "TOP-SECRET-account",
      },
    }));

    const result = await start;
    expect(result).toEqual({
      ok: false,
      error: "The session mutation completed for the previously selected session; refresh the session state before continuing",
    });
    expect(client.startServiceSession).toHaveBeenCalledOnce();
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.service.start", state: "completed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ result, history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("reports a target-rejected direct session mutation as confirmed failed without reflecting target details", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    client.mkdirSession.mockResolvedValueOnce(sliverpb.Mkdir.create({
      Response: { Err: "TOP-SECRET target rejection at /private/implant/path" },
    }));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const result = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/rejected",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        status: "failed",
        operationId: "session.filesystem.mkdir",
        message: "The target rejected the session mutation. Refresh the session state before taking another action.",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|private\/implant/u);
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.mkdir",
          state: "failed",
          attempts: 1,
          target: { id: "session_m2" },
          backend: { configName: "operator" },
        }],
      },
    });
    expect(JSON.stringify(history)).not.toMatch(/TOP-SECRET|\/tmp\/rejected|private\/implant/u);
  });

  it("recovers direct target-loss uncertainty after an exact target rejection", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const mutationGate = deferred<sliverpb.Mkdir>();
    client.mkdirSession.mockImplementationOnce(async () => mutationGate.promise);

    const mutation = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/TOP-SECRET-late-rejection",
    });
    await vi.waitFor(() => expect(client.mkdirSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = [];
    await registry.refresh(1);
    mutationGate.resolve(sliverpb.Mkdir.create({ Response: { Err: "TOP-SECRET exact rejection" } }));

    await expect(mutation).resolves.toEqual({
      ok: true,
      value: {
        status: "failed",
        operationId: "session.filesystem.mkdir",
        message: "The target rejected the session mutation. Refresh the session state before taking another action.",
      },
    });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.mkdir", state: "failed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("keeps a direct session mutation outcome unknown after a transport failure", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    client.mkdirSession.mockRejectedValueOnce(new Error("14 UNAVAILABLE: TOP-SECRET transport path"));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const result = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/uncertain",
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "outcome-unknown",
        operationId: "session.filesystem.mkdir",
        message: expect.stringMatching(/dispatched, but its final outcome could not be confirmed/i),
      },
    });
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
  });

  it("classifies unary transfer response loss by side effect and never replays an upload", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const downloadDestination = join(root, "download-timeout.bin");
    electronMocks.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: downloadDestination,
    });
    client.downloadFileSession.mockRejectedValueOnce(
      new Error("4 DEADLINE_EXCEEDED: TOP-SECRET download transport detail"),
    );

    const download = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: "/tmp/TOP-SECRET-read.bin",
      maxBytes: 1_024,
    });
    expect(download).toEqual({ ok: false, error: "The session workbench request failed" });
    expect(JSON.stringify(download)).not.toContain("TOP-SECRET");

    const uploadPath = join(root, "TOP-SECRET-local-upload.bin");
    await writeFile(uploadPath, "TOP-SECRET unary upload bytes", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [uploadPath] });
    client.uploadSession.mockRejectedValueOnce(
      new Error("4 DEADLINE_EXCEEDED: TOP-SECRET upload transport detail"),
    );

    const upload = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp/TOP-SECRET-remote",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    });
    expect(upload).toEqual({
      ok: true,
      value: {
        status: "outcome-unknown",
        operationId: "session.filesystem.upload-open",
        message: "The session mutation was dispatched, but its final outcome could not be confirmed. Refresh the session state before taking another action.",
      },
    });
    expect(client.uploadSession).toHaveBeenCalledOnce();
    expect(client.uploadSession.mock.calls[0]?.[2].every((byte) => byte === 0)).toBe(true);

    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [
          { operationId: "session.filesystem.upload-open", state: "outcome-unknown", attempts: 1 },
          { operationId: "session.filesystem.download", state: "failed", attempts: 1 },
        ],
      },
    });
    const serialized = JSON.stringify({ upload, history, snapshot: registry.snapshot(1) });
    expect(serialized).not.toMatch(/TOP-SECRET|local-upload|remote-upload/u);
    await expect(readFile(downloadDestination)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("adds dropped local loot with its file name and content-detected type through the bounded reader", async () => {
    const client = new FakeSliverClient();
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const textPath = join(root, "operator-report.txt");
    const binaryPath = join(root, "operator-data.bin");
    await writeFile(textPath, "loot text\n");
    await writeFile(binaryPath, Buffer.from([0, 255, 1]));

    const text = await registry.addDroppedLoot(sender(1), textPath);
    const binary = await registry.addDroppedLoot(sender(1), binaryPath);

    expect(text).toMatchObject({
      ok: true,
      value: { name: "operator-report.txt", fileName: "operator-report.txt", fileType: "text" },
    });
    expect(binary).toMatchObject({
      ok: true,
      value: { name: "operator-data.bin", fileName: "operator-data.bin", fileType: "binary" },
    });
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(client.lootState.map((item) => item.File?.Data)).toEqual([
      Buffer.from("loot text\n"),
      Buffer.from([0, 255, 1]),
    ]);
    for (const [request] of client.lootAdd.mock.calls) {
      expect(request.File?.Data.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("adds a bounded remote file to loot with host provenance and preserves uncertain mutation outcomes", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    client.sessionState.Sessions = [activeSession];
    const downloaded = Buffer.from("loot text\n");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Path: "C:\\Windows\\Temp\\CON.txt",
      Data: downloaded,
    }));
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const added = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.add-to-loot",
      path: "/tmp/source.txt",
      maxBytes: 1_024,
    });

    expect(added).toEqual({
      ok: true,
      value: {
        status: "completed",
        result: {
          operationId: "session.filesystem.add-to-loot",
          value: {
            status: "added",
            fileName: "_CON.txt",
            fileType: "text",
            size: 10,
            sha256: createHash("sha256").update("loot text\n").digest("hex"),
          },
        },
      },
    });
    expect(JSON.stringify(added)).not.toMatch(/source\.txt|Windows|Buffer/u);
    expect(client.lootState).toHaveLength(1);
    expect(client.lootState[0]).toMatchObject({
      Name: "_CON.txt",
      OriginHostUUID: activeSession.UUID,
      FileType: clientpb.FileType.TEXT,
      File: { Name: "_CON.txt" },
    });
    expect(client.lootState[0]?.File?.Data.toString()).toBe("loot text\n");
    expect(downloaded.every((byte) => byte === 0)).toBe(true);
    expect(client.lootAdd.mock.calls[0]?.[0].File?.Data.every((byte) => byte === 0)).toBe(true);

    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Path: "/tmp/uncertain.bin",
      Data: Buffer.from([0, 1, 2]),
    }));
    client.lootAdd.mockRejectedValueOnce(new Error("14 UNAVAILABLE: TOP-SECRET loot response loss"));
    const uncertain = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.add-to-loot",
      path: "/tmp/uncertain.bin",
      maxBytes: 1_024,
    });

    expect(uncertain).toEqual({
      ok: true,
      value: {
        status: "outcome-unknown",
        operationId: "session.filesystem.add-to-loot",
        message: "The session mutation was dispatched, but its final outcome could not be confirmed. Refresh the session state before taking another action.",
      },
    });
    expect(client.lootAdd).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(uncertain)).not.toContain("TOP-SECRET");
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [
          { operationId: "session.filesystem.add-to-loot", state: "outcome-unknown", attempts: 1 },
          { operationId: "session.filesystem.add-to-loot", state: "completed", attempts: 1 },
        ],
      },
    });
  });

  it("does not report loot mutation uncertainty when the target disappears during download preflight", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const downloadGate = deferred<sliverpb.Download>();
    const downloaded = Buffer.from("preflight-only");
    client.downloadFileSession.mockImplementationOnce(async () => downloadGate.promise);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const pending = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.add-to-loot",
      path: "/tmp/preflight-only.txt",
      maxBytes: 1_024,
    });
    await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = [];
    await registry.refresh(1);
    downloadGate.resolve(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Path: "/tmp/preflight-only.txt",
      Data: downloaded,
    }));

    await expect(pending).resolves.toEqual({ ok: false, error: "The session workbench request failed" });
    expect(client.lootAdd).not.toHaveBeenCalled();
    expect(downloaded.every((byte) => byte === 0)).toBe(true);
    await expect(registry.listTargetOperations(1, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.add-to-loot",
          state: "target-disappeared",
          attempts: 0,
        }],
      },
    });
  });

  it("journals native cancellation without dispatch or sensitive workbench input", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const secretRemotePath = "/tmp/TOP-SECRET-native-cancel.bin";
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: true });

    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: secretRemotePath,
      maxBytes: 1_024,
    })).resolves.toEqual({
      ok: true,
      value: {
        status: "completed",
        result: {
          operationId: "session.filesystem.download",
          value: { status: "canceled" },
        },
      },
    });

    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.download",
          state: "canceled",
          attempts: 0,
        }],
      },
    });
    expect(JSON.stringify(history)).not.toContain(secretRemotePath);
    expect(client.downloadFileSession).not.toHaveBeenCalled();
  });

  it("quarantines pending download, dump, and screenshot responses after session selection loss", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    activeSession.OS = "linux";
    client.sessionState.Sessions = [activeSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionRef = registry.snapshot(1).targetContext.selectableTargets[0]!;
    await registry.selectTarget(1, sessionRef);
    const internals = registry as unknown as {
      sessionArtifacts: { usage(ownerWindowId?: number): { itemCount: number; byteCount: number } };
    };

    const downloadDestination = join(root, "TOP-SECRET-pending-download.bin");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: downloadDestination });
    const downloadGate = deferred<sliverpb.Download>();
    const downloadedBytes = Buffer.from("TOP-SECRET pending download bytes");
    client.downloadFileSession.mockImplementationOnce(async () => downloadGate.promise);
    const download = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: "/tmp/TOP-SECRET-pending-download.bin",
      maxBytes: 1_024,
    });
    await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledOnce());
    await registry.backgroundTarget(1);
    downloadGate.resolve(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Data: downloadedBytes,
    }));
    await expect(download).resolves.toEqual({ ok: false, error: "The session workbench request failed" });
    expect(downloadedBytes.every((byte) => byte === 0)).toBe(true);
    await expect(readFile(downloadDestination)).rejects.toMatchObject({ code: "ENOENT" });

    await registry.selectTarget(1, sessionRef);
    const dumpDestination = join(root, "TOP-SECRET-pending-dump.bin");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: dumpDestination });
    const dumpGate = deferred<sliverpb.ProcessDump>();
    const dumpBytes = Buffer.from("TOP-SECRET pending process dump");
    client.processDumpSession.mockImplementationOnce(async () => dumpGate.promise);
    const dump = registry.runSessionWorkbench(sender(1), {
      operationId: "session.process.dump",
      pid: 4242,
      dumpTimeoutSeconds: 60,
    });
    await vi.waitFor(() => expect(client.processDumpSession).toHaveBeenCalledOnce());
    await registry.backgroundTarget(1);
    dumpGate.resolve(sliverpb.ProcessDump.create({ Data: dumpBytes }));
    await expect(dump).resolves.toEqual({ ok: false, error: "The session workbench request failed" });
    expect(dumpBytes.every((byte) => byte === 0)).toBe(true);
    await expect(readFile(dumpDestination)).rejects.toMatchObject({ code: "ENOENT" });

    await registry.selectTarget(1, sessionRef);
    const screenshotGate = deferred<sliverpb.Screenshot>();
    const screenshotBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    client.screenshotSession.mockImplementationOnce(async () => screenshotGate.promise);
    const screenshot = registry.runSessionWorkbench(sender(1), {
      operationId: "session.screenshot.capture",
    });
    await vi.waitFor(() => expect(client.screenshotSession).toHaveBeenCalledOnce());
    await registry.backgroundTarget(1);
    screenshotGate.resolve(sliverpb.Screenshot.create({ Data: screenshotBytes }));
    await expect(screenshot).resolves.toEqual({ ok: false, error: "The session workbench request failed" });
    expect(screenshotBytes.every((byte) => byte === 0)).toBe(true);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });

    await registry.selectTarget(1, sessionRef);
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [
          { operationId: "session.screenshot.capture", state: "failed", attempts: 1 },
          { operationId: "session.process.dump", state: "failed", attempts: 1 },
          { operationId: "session.filesystem.download", state: "failed", attempts: 1 },
        ],
      },
    });
    expect(JSON.stringify({ history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("revokes plans and screenshot/editor capabilities across an A-to-B-to-A selection cycle", async () => {
    const client = new FakeSliverClient();
    const sessionARecord = session("session_a", "session-a");
    const sessionBRecord = session("session_b", "session-b");
    sessionARecord.OS = "linux";
    sessionBRecord.OS = "linux";
    client.sessionState.Sessions = [sessionARecord, sessionBRecord];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a")!;
    const sessionB = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b")!;
    await registry.selectTarget(1, sessionA);

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/TOP-SECRET-reviewed-delete.bin",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a reviewed plan");
    const editorArtifact = await stageTextArtifact(registry, 1, "TOP-SECRET editor capability bytes");
    const screenshot = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.screenshot.capture",
    });
    if (
      !screenshot.ok || screenshot.value.status !== "completed" ||
      screenshot.value.result.operationId !== "session.screenshot.capture"
    ) throw new Error(`Expected a screenshot artifact: ${JSON.stringify(screenshot)}`);
    const screenshotHandle = screenshot.value.result.value.artifact.handle;
    const internals = registry as unknown as {
      windows: Map<number, {
        sessionPlans: Map<string, unknown>;
        sessionPlanTimers: Map<string, NodeJS.Timeout>;
      }>;
      sessionArtifacts: {
        artifacts: Map<string, { data: Buffer }>;
        usage(ownerWindowId?: number): { itemCount: number; byteCount: number };
      };
    };
    const ownedBuffers = [...internals.sessionArtifacts.artifacts.values()].map(({ data }) => data);
    expect(ownedBuffers).toHaveLength(2);
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(1);
    expect(internals.windows.get(1)?.sessionPlanTimers.size).toBe(1);

    await registry.selectTarget(1, sessionB);
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(0);
    expect(internals.windows.get(1)?.sessionPlanTimers.size).toBe(0);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
    for (const buffer of ownedBuffers) expect(buffer.every((byte) => byte === 0)).toBe(true);

    await registry.selectTarget(1, sessionA);
    await expect(
      registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/already-used/) });
    expect(client.rmSession).not.toHaveBeenCalled();
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: screenshotHandle,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });
    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: editorArtifact.handle,
      remotePath: "/tmp/TOP-SECRET-editor.txt",
      encoding: "utf-8",
      expectedSha256: "0".repeat(64),
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });

    const backgroundArtifact = await stageTextArtifact(
      registry,
      1,
      "TOP-SECRET background-bound editor bytes",
    );
    const backgroundPlan = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/TOP-SECRET-background-delete.bin",
      recursive: false,
      force: false,
    });
    if (!backgroundPlan.ok || backgroundPlan.value.status !== "prepared") {
      throw new Error("Expected a background-bound plan");
    }
    const backgroundBytes = [...internals.sessionArtifacts.artifacts.values()][0]?.data;
    await registry.backgroundTarget(1);
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(0);
    expect(internals.windows.get(1)?.sessionPlanTimers.size).toBe(0);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
    expect(backgroundBytes?.every((byte) => byte === 0)).toBe(true);
    await registry.selectTarget(1, sessionA);
    await expect(
      registry.executeSessionDestructiveActionPlan(1, backgroundPlan.value.plan.token),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/already-used/) });
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: backgroundArtifact.handle,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(JSON.stringify({ history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("preserves capabilities across summary refreshes but revokes them on authoritative identity replacement", async () => {
    const client = new FakeSliverClient();
    const original = session("session_m2", "m2-interactive");
    client.sessionState.Sessions = [original];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const editorArtifact = await stageTextArtifact(registry, 1, "TOP-SECRET refresh-bound editor bytes");
    const internals = registry as unknown as {
      sessionArtifacts: {
        artifacts: Map<string, { data: Buffer }>;
        usage(ownerWindowId?: number): { itemCount: number; byteCount: number };
      };
    };
    const ownedBytes = [...internals.sessionArtifacts.artifacts.values()][0]?.data;

    original.LastCheckin = String(Number(original.LastCheckin) + 1);
    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTarget: { id: "session_m2" } } },
    });
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: true });
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: editorArtifact.handle,
    })).resolves.toMatchObject({
      ok: true,
      value: { status: "completed", result: { value: { status: "canceled" } } },
    });
    expect(internals.sessionArtifacts.usage(1).itemCount).toBe(1);
    expect(ownedBytes?.some((byte) => byte !== 0)).toBe(true);

    original.UUID = "replacement-host-identity";
    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTarget: null } },
    });
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
    expect(ownedBytes?.every((byte) => byte === 0)).toBe(true);
    const replacement = registry.snapshot(1).targetContext.selectableTargets[0]!;
    await registry.selectTarget(1, replacement);
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: editorArtifact.handle,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });
    expect(JSON.stringify(registry.snapshot(1))).not.toContain("TOP-SECRET");
  });

  it("stages bounded editor bytes in main-owned storage and journals no content, handle, or native path", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const editorContent = "TOP-SECRET editor body";

    const staged = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.stage-text",
      content: editorContent,
      encoding: "utf-8",
    });
    if (
      !staged.ok || staged.value.status !== "completed" ||
      staged.value.result.operationId !== "session.filesystem.stage-text"
    ) throw new Error("Expected staged editor content");
    const artifact = staged.value.result.value.artifact;
    expect(artifact).toMatchObject({
      suggestedBasename: "edited-text.txt",
      mediaType: "text/plain",
      size: Buffer.byteLength(editorContent),
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(Date.parse(artifact.expiresAt) - Date.parse(artifact.createdAt)).toBeLessThanOrEqual(60_000);

    const destination = join(root, "TOP-SECRET-editor-destination.txt");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: artifact.handle,
    })).resolves.toMatchObject({
      ok: true,
      value: { status: "completed", result: { value: { status: "saved" } } },
    });
    expect(await readFile(destination, "utf8")).toBe(editorContent);

    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error(history.error);
    expect(history.value.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "session.filesystem.stage-text", state: "completed", attempts: 0 }),
      expect.objectContaining({ operationId: "session.artifact.save", state: "completed", attempts: 0 }),
    ]));
    const serializedHistory = JSON.stringify(history);
    for (const sensitiveValue of [editorContent, artifact.handle, destination]) {
      expect(serializedHistory).not.toContain(sensitiveValue);
    }
  });

  it("executes conflict-aware text and hex overwrites from exact staged artifacts", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const textArtifact = await stageTextArtifact(registry, 1, "new text");
    const textOriginal = Buffer.from("old text");
    const textExpected = createHash("sha256").update(textOriginal).digest("hex");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Data: textOriginal,
    }));
    const textPlan = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: textArtifact.handle,
      remotePath: "/tmp/edit.txt",
      encoding: "utf-8",
      expectedSha256: textExpected,
    });
    expect(textPlan).toMatchObject({
      ok: true,
      value: { status: "prepared", plan: { artifact: {
        suggestedBasename: "edited-text.txt",
        size: 8,
        sha256: textArtifact.sha256,
      } } },
    });
    if (!textPlan.ok || textPlan.value.status !== "prepared") throw new Error("Expected text edit plan");
    expect(Date.parse(textPlan.value.plan.expiresAt)).toBeLessThanOrEqual(Date.parse(textArtifact.expiresAt));
    await expect(registry.executeSessionDestructiveActionPlan(1, textPlan.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.edit-text-overwrite", status: "succeeded" },
    });
    expect(client.lastUploadData?.toString()).toBe("new text");
    expect(client.uploadSession).toHaveBeenLastCalledWith("session_m2", "/tmp/edit.txt", expect.any(Buffer), {
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    expect(client.uploadSession.mock.calls.at(-1)?.[2].every((byte) => byte === 0)).toBe(true);
    expect(textOriginal.every((byte) => byte === 0)).toBe(true);

    const hexArtifact = await stageHexArtifact(registry, 1, "00a1ff");
    const hexOriginal = Buffer.from([1, 2, 3]);
    const hexExpected = createHash("sha256").update(hexOriginal).digest("hex");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Data: hexOriginal,
    }));
    const hexPlan = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.patch-hex",
      patchHandle: hexArtifact.handle,
      remotePath: "/tmp/edit.bin",
      expectedSha256: hexExpected,
    });
    if (!hexPlan.ok || hexPlan.value.status !== "prepared") throw new Error("Expected hex edit plan");
    await expect(registry.executeSessionDestructiveActionPlan(1, hexPlan.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.patch-hex", status: "succeeded" },
    });
    expect(client.lastUploadData).toEqual(Buffer.from([0x00, 0xa1, 0xff]));
    expect(client.uploadSession.mock.calls.at(-1)?.[2].every((byte) => byte === 0)).toBe(true);
    expect(hexOriginal.every((byte) => byte === 0)).toBe(true);
  });

  it("opens a complete remote text file for the standalone editor and uploads only after confirmation", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const original = "old text";
    const digest = createHash("sha256").update(original).digest("hex");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true, IsDir: false, Path: "/tmp/edit.txt", Data: Buffer.from(original),
    }));
    const owner = sender(1);
    const loaded = await registry.loadRemoteTextEditor(owner, "/tmp/edit.txt");
    expect(loaded).toMatchObject({ title: "edit.txt", text: original, expectedSha256: digest });
    const declined = vi.fn().mockResolvedValue(false);
    await expect(registry.saveRemoteTextEditor(
      loaded.binding, "/tmp/edit.txt", digest, "new text", declined,
    )).resolves.toBeNull();
    expect(declined).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({ actionId: "session.filesystem.edit-text-overwrite", remotePath: "/tmp/edit.txt" }),
    }));
    expect(client.uploadSession).not.toHaveBeenCalled();

    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true, IsDir: false, Path: "/tmp/edit.txt", Data: Buffer.from(original),
    }));
    const confirmed = vi.fn().mockResolvedValue(true);
    const saved = await registry.saveRemoteTextEditor(
      loaded.binding, "/tmp/edit.txt", digest, "new text", confirmed,
    );
    expect(saved).toEqual({ expectedSha256: createHash("sha256").update("new text").digest("hex") });
    expect(client.lastUploadData?.toString()).toBe("new text");
    expect(client.uploadSession).toHaveBeenCalledWith("session_m2", "/tmp/edit.txt", expect.any(Buffer), {
      isIOC: false, isDirectory: false, overwrite: true,
    });
    await expect(registry.saveRemoteTextEditor(
      loaded.binding, "/tmp/edit.txt", digest, "stale draft", confirmed,
    )).rejects.toThrow(/document changed/u);
  });

  it("rejects a standalone remote edit after the owner selects another session", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_a", "session-a"), session("session_b", "session-b")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const targets = registry.snapshot(1).targetContext.selectableTargets;
    await registry.selectTarget(1, targets[0]!);
    const original = "original";
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true, IsDir: false, Data: Buffer.from(original),
    }));
    const loaded = await registry.loadRemoteTextEditor(sender(1), "/tmp/edit.txt");
    await registry.selectTarget(1, targets[1]!);
    await expect(registry.saveRemoteTextEditor(
      loaded.binding, "/tmp/edit.txt", loaded.expectedSha256, "changed", async () => true,
    )).rejects.toThrow(/session changed/u);
    expect(client.uploadSession).not.toHaveBeenCalled();
  });

  it("rejects a standalone remote edit after the source renderer reloads", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true, IsDir: false, Data: Buffer.from("original"),
    }));
    const owner = sender(1);
    const loaded = await registry.loadRemoteTextEditor(owner, "/tmp/edit.txt");
    (owner.mainFrame as unknown as { frameToken: string }).frameToken = "reloaded-frame";
    await expect(registry.saveRemoteTextEditor(
      loaded.binding, "/tmp/edit.txt", loaded.expectedSha256, "changed", async () => true,
    )).rejects.toThrow(/session changed/u);
    expect(client.uploadSession).not.toHaveBeenCalled();
  });

  it("fails an edit on digest conflict, revokes staged bytes, and never uploads", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const artifact = await stageTextArtifact(registry, 1, "replacement");
    const expectedSha256 = createHash("sha256").update("original").digest("hex");
    const changed = Buffer.from("changed");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Data: changed,
    }));
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: artifact.handle,
      remotePath: "/tmp/conflict.txt",
      encoding: "utf-8",
      expectedSha256,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected edit plan");

    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { status: "failed", message: expect.stringMatching(/changed after it was opened/i) },
    });
    expect(changed.every((byte) => byte === 0)).toBe(true);
    expect(client.uploadSession).not.toHaveBeenCalled();
    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already-used/),
    });
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.artifact.save",
      handle: artifact.handle,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });
  });

  it("does not upload when the active target changes during edit preflight", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_a", "session-a"), session("session_b", "session-b")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a")!;
    const sessionB = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b")!;
    await registry.selectTarget(1, sessionA);
    const artifact = await stageTextArtifact(registry, 1, "replacement");
    const original = Buffer.from("original");
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: artifact.handle,
      remotePath: "/tmp/stale.txt",
      encoding: "utf-8",
      expectedSha256,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected edit plan");
    const gate = deferred<sliverpb.Download>();
    client.downloadFileSession.mockImplementationOnce(async () => gate.promise);
    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledOnce());
    await registry.selectTarget(1, sessionB);
    gate.resolve(sliverpb.Download.create({ Exists: true, IsDir: false, Data: original }));

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: { status: "target-disappeared" },
    });
    expect(original.every((byte) => byte === 0)).toBe(true);
    expect(client.uploadSession).not.toHaveBeenCalled();
  });

  it("distinguishes edit target rejection from transport loss and zeroizes staged upload buffers", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    for (const [suffix, rejection, status] of [
      ["rejected", sliverpb.Upload.create({ Response: { Err: "TOP-SECRET target detail" } }), "failed"],
      ["transport", new Error("14 UNAVAILABLE: TOP-SECRET transport detail"), "outcome-unknown"],
    ] as const) {
      const artifact = await stageTextArtifact(registry, 1, `replacement-${suffix}`);
      const original = Buffer.from(`original-${suffix}`);
      const expectedSha256 = createHash("sha256").update(original).digest("hex");
      client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
        Exists: true,
        IsDir: false,
        Data: original,
      }));
      const prepared = await registry.prepareSessionDestructiveAction(1, {
        actionId: "session.filesystem.edit-text-overwrite",
        contentHandle: artifact.handle,
        remotePath: `/tmp/${suffix}.txt`,
        encoding: "utf-8",
        expectedSha256,
      });
      if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected edit plan");
      if (rejection instanceof Error) client.uploadSession.mockRejectedValueOnce(rejection);
      else client.uploadSession.mockResolvedValueOnce(rejection);

      const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
      expect(result).toMatchObject({ ok: true, value: { status } });
      expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
      expect(client.uploadSession.mock.calls.at(-1)?.[2].every((byte) => byte === 0)).toBe(true);
      expect(original.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("rejects staged editor handle/media mismatches and prevents plan replay", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const textArtifact = await stageTextArtifact(registry, 1, "new text");
    const expectedSha256 = createHash("sha256").update("old text").digest("hex");

    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.patch-hex",
      patchHandle: textArtifact.handle,
      remotePath: "/tmp/mismatch.bin",
      expectedSha256,
    })).resolves.toEqual({
      ok: false,
      error: "The staged editor artifact does not match the reviewed edit type",
    });
    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: "A".repeat(43),
      remotePath: "/tmp/missing.txt",
      encoding: "utf-8",
      expectedSha256,
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/unavailable/) });

    const original = Buffer.from("old text");
    client.downloadFileSession.mockResolvedValueOnce(sliverpb.Download.create({
      Exists: true,
      IsDir: false,
      Data: original,
    }));
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.edit-text-overwrite",
      contentHandle: textArtifact.handle,
      remotePath: "/tmp/replay.txt",
      encoding: "utf-8",
      expectedSha256,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected edit plan");
    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { status: "succeeded" },
    });
    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already-used/),
    });
    expect(client.uploadSession).toHaveBeenCalledOnce();
  });

  it("uploads one dropped local file through the existing bounded workbench path without a picker", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "dropped.bin");
    await writeFile(uploadPath, "dropped bytes", { mode: 0o600 });

    const result = await registry.runDroppedSessionUpload(sender(1), uploadPath, {
      remotePath: "/tmp",
      isIOC: true,
      isDirectory: false,
      overwrite: false,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "completed",
        result: {
          operationId: "session.filesystem.upload-open",
          value: {
            status: "uploaded",
            remotePath: "/tmp",
            suggestedBasename: "dropped.bin",
            size: 13,
            message: "Upload completed",
          },
        },
      },
    });
    expect(electronMocks.showOpenDialog).not.toHaveBeenCalled();
    expect(client.lastUploadData?.toString()).toBe("dropped bytes");
    expect(client.uploadSession).toHaveBeenCalledExactlyOnceWith(
      "session_m2",
      "/tmp",
      expect.any(Buffer),
      {
        isIOC: true,
        fileName: "dropped.bin",
        isDirectory: false,
        overwrite: false,
      },
    );
    expect(client.uploadSession.mock.calls[0]?.[2].every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(uploadPath);
  });

  it("does not expose native paths or raw transport errors through workbench results", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const secretPath = join(root, "private-operator-name", "TOP-SECRET-source.bin");
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secretPath] });

    const upload = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    });
    expect(upload).toEqual({ ok: false, error: "Could not read the selected upload file" });
    expect(JSON.stringify(upload)).not.toContain(secretPath);

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [secretPath] });
    const reviewedUpload = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/reviewed.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    expect(reviewedUpload).toEqual({ ok: false, error: "Could not read the selected upload file" });
    expect(JSON.stringify(reviewedUpload)).not.toContain(secretPath);

    electronMocks.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: join(root, "missing-secret-directory", "report.bin"),
    });
    const save = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: "/tmp/report.bin",
      maxBytes: 1_024,
    });
    expect(save).toEqual({ ok: false, error: "Could not prepare the selected artifact destination" });
    expect(JSON.stringify(save)).not.toMatch(/missing-secret-directory/u);
    expect(client.downloadFileSession).not.toHaveBeenCalled();

    client.lsSession.mockRejectedValueOnce(new Error("13 INTERNAL: TOP-SECRET at /private/backend/path"));
    const listing = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.ls",
      path: "/tmp",
    });
    expect(listing).toEqual({ ok: false, error: "The session workbench request failed" });
    expect(JSON.stringify(listing)).not.toMatch(/TOP-SECRET|private\/backend/u);
  });

  it("supports inherited-window workbench requests without sharing artifact capabilities", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    activeSession.OS = "linux";
    client.sessionState.Sessions = [activeSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    expect(registry.snapshot(2).connection.incarnation).toBeGreaterThan(0);
    const sourceRef = registry.snapshot(1).targetContext.selectableTargets[0]!;
    const inheritedRef = registry.snapshot(2).targetContext.selectableTargets[0]!;
    await registry.selectTarget(1, sourceRef);
    await registry.selectTarget(2, inheritedRef);

    await expect(registry.runSessionWorkbench(sender(2), {
      operationId: "session.environment.list",
    })).resolves.toMatchObject({ ok: true, value: { status: "completed" } });
    const sourceCapture = await registry.runSessionWorkbench(sender(1), {
      operationId: "session.screenshot.capture",
    });
    const inheritedCapture = await registry.runSessionWorkbench(sender(2), {
      operationId: "session.screenshot.capture",
    });
    if (
      !sourceCapture.ok || sourceCapture.value.status !== "completed" ||
      sourceCapture.value.result.operationId !== "session.screenshot.capture" ||
      !inheritedCapture.ok || inheritedCapture.value.status !== "completed" ||
      inheritedCapture.value.result.operationId !== "session.screenshot.capture"
    ) throw new Error("Expected two captured screenshots");
    const sourceHandle = sourceCapture.value.result.value.artifact.handle;
    const inheritedHandle = inheritedCapture.value.result.value.artifact.handle;
    expect(sourceHandle).not.toBe(inheritedHandle);

    await expect(registry.runSessionWorkbench(sender(2), {
      operationId: "session.artifact.save",
      handle: sourceHandle,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/unavailable for the current window/),
    });
  });

  it("executes a one-use session action plan only after a fresh exact-target refresh", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const selected = registry.snapshot(1).targetContext.selectableTargets[0]!;
    await registry.selectTarget(1, selected);
    const baselineRefreshes = client.getSessions.mock.calls.length;

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/reviewed.txt",
      recursive: false,
      force: false,
    });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        status: "prepared",
        plan: {
          payloadDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
          action: { actionId: "session.filesystem.rm", path: "/tmp/reviewed.txt" },
          target: {
            backend: {
              id: createHash("sha256").update(validConfig()).digest("hex"),
              displayName: "operator",
            },
            sessionId: "session_m2",
            fingerprint: selected.fingerprint,
            name: "m2-interactive",
            hostname: "m2-interactive-host",
            os: "darwin",
          },
        },
      },
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");

    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: {
        actionId: "session.filesystem.rm",
        status: "succeeded",
        payloadDigest: prepared.value.plan.payloadDigest,
      },
    });
    expect(client.getSessions.mock.calls.length).toBeGreaterThan(baselineRefreshes);
    expect(client.rmSession).toHaveBeenCalledOnce();
    expect(client.rmSession).toHaveBeenCalledWith("session_m2", "/tmp/reviewed.txt", false, false);
    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/already-used session action plan/),
    });
    expect(client.rmSession).toHaveBeenCalledOnce();
  });

  it("refuses recursive removal plans for self and root paths after target-platform normalization", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    activeSession.OS = "windows";
    client.sessionState.Sessions = [activeSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    for (const path of [
      ".",
      "..",
      "/",
      "\\",
      ".\\",
      "C:\\",
      "C:\\temp\\..",
      "/tmp/..",
      "C:",
      "C:.",
      "C:..",
      "C:relative\\child",
      "\\\\server\\share",
      "\\\\server\\share\\",
    ]) {
      await expect(registry.prepareSessionDestructiveAction(1, {
        actionId: "session.filesystem.rm",
        path,
        recursive: true,
        force: true,
      })).resolves.toEqual({
        ok: false,
        error: "Recursive removal of a filesystem root, self, or drive-relative path is not allowed",
      });
    }

    const internals = registry as unknown as {
      windows: Map<number, { sessionPlans: Map<string, unknown> }>;
    };
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(0);
    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "C:\\temp\\bounded-child",
      recursive: true,
      force: true,
    })).resolves.toMatchObject({ ok: true, value: { status: "prepared" } });
  });

  it("reports a reviewed target rejection as confirmed failed without reflecting target details", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/rejected.txt",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    client.rmSession.mockResolvedValueOnce(sliverpb.Rm.create({
      Response: { Err: "TOP-SECRET target rejection at C:\\private\\implant" },
    }));

    const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);

    expect(result).toMatchObject({
      ok: true,
      value: {
        actionId: "session.filesystem.rm",
        status: "failed",
        message: "The target rejected the reviewed action",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|private\\implant/u);
    expect(client.rmSession).toHaveBeenCalledOnce();
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.rm",
          state: "failed",
          attempts: 1,
        }],
      },
    });
    expect(JSON.stringify(history)).not.toMatch(/TOP-SECRET|\/tmp\/rejected/u);
  });

  it("recovers reviewed target-loss uncertainty after an exact target rejection", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/TOP-SECRET-reviewed-late-rejection",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    const mutationGate = deferred<sliverpb.Rm>();
    client.rmSession.mockImplementationOnce(async () => mutationGate.promise);

    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.rmSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = [];
    await registry.refresh(1);
    mutationGate.resolve(sliverpb.Rm.create({ Response: { Err: "TOP-SECRET reviewed exact rejection" } }));

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.rm", status: "failed" },
    });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.rm", state: "failed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("keeps a reviewed action outcome unknown after transport failure", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/uncertain.txt",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    client.rmSession.mockRejectedValueOnce(new Error("14 UNAVAILABLE: TOP-SECRET transport path"));

    const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);

    expect(result).toMatchObject({
      ok: true,
      value: {
        actionId: "session.filesystem.rm",
        status: "outcome-unknown",
        message: "The action was dispatched, but its outcome could not be confirmed",
      },
    });
    expect(JSON.stringify(result)).not.toContain("TOP-SECRET");
    expect(client.rmSession).toHaveBeenCalledOnce();
    await expect(registry.listTargetOperations(1, { limit: 100 })).resolves.toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.rm",
          state: "outcome-unknown",
          attempts: 1,
        }],
      },
    });
  });

  it("recovers reviewed target-loss uncertainty after an exact success", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/TOP-SECRET-reviewed-late-success",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    const mutationGate = deferred<sliverpb.Rm>();
    client.rmSession.mockImplementationOnce(async () => mutationGate.promise);

    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.rmSession).toHaveBeenCalledOnce());
    client.sessionState.Sessions = [];
    await registry.refresh(1);
    mutationGate.resolve(sliverpb.Rm.create());

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.rm", status: "succeeded" },
    });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.rm", state: "completed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("keeps a reviewed exact response uncertain after the backend incarnation changes", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/TOP-SECRET-reviewed-stale-incarnation",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    const mutationGate = deferred<sliverpb.Rm>();
    client.rmSession.mockImplementationOnce(async () => mutationGate.promise);

    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.rmSession).toHaveBeenCalledOnce());
    await registry.disconnect(1);
    mutationGate.resolve(sliverpb.Rm.create());

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.rm", status: "outcome-unknown" },
    });
    expect(JSON.stringify({ result: await execution, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("does not dispatch a reviewed session action after authoritative target disappearance", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/stale.txt",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    client.sessionState.Sessions = [];

    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.rm", status: "target-disappeared" },
    });
    expect(client.rmSession).not.toHaveBeenCalled();
  });

  it("binds process termination to the reviewed process identity and rejects PID reuse", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.process.terminate",
      pid: 4242,
      force: false,
    });
    expect(prepared).toMatchObject({
      ok: true,
      value: {
        status: "prepared",
        plan: {
          resource: {
            kind: "process",
            pid: 4242,
            executable: "/tmp/original",
            owner: "operator",
          },
        },
      },
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a process plan");
    client.psSession.mockResolvedValueOnce(sliverpb.Ps.create({
      Processes: [{
        Pid: 4242,
        Ppid: 1,
        Executable: "/tmp/reused",
        Owner: "other-user",
        Architecture: "arm64",
        CmdLine: ["/tmp/reused"],
      }],
    }));

    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: {
        actionId: "session.process.terminate",
        status: "failed",
        message: expect.stringMatching(/identity changed/),
      },
    });
    expect(client.terminateSessionProcess).not.toHaveBeenCalled();
  });

  it("does not terminate a process when the active session changes during process revalidation", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [
      session("session_a", "session-a"),
      session("session_b", "session-b"),
    ];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionA = registry.snapshot(1).targetContext.selectableTargets.find((ref) => ref.id === "session_a")!;
    const sessionB = registry.snapshot(1).targetContext.selectableTargets.find((ref) => ref.id === "session_b")!;
    await registry.selectTarget(1, sessionA);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.process.terminate",
      pid: 4242,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a process plan");
    const processGate = deferred<sliverpb.Ps>();
    client.psSession.mockImplementationOnce(async () => processGate.promise);

    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.psSession).toHaveBeenCalledTimes(2));
    await registry.selectTarget(1, sessionB);
    processGate.resolve(sliverpb.Ps.create({
      Processes: [{
        Pid: 4242,
        Ppid: 1,
        Executable: "/tmp/original",
        Owner: "operator",
        Architecture: "arm64",
        CmdLine: ["/tmp/original", "--session"],
      }],
    }));

    await expect(execution).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.process.terminate", status: "target-disappeared" },
    });
    expect(client.terminateSessionProcess).not.toHaveBeenCalled();
  });

  it("treats native upload cancellation as a closed non-error result before any remote RPC", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });

    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/reviewed.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    })).resolves.toEqual({ ok: true, value: { status: "canceled" } });
    expect(electronMocks.showOpenDialog).toHaveBeenCalledOnce();
    expect(client.uploadSession).not.toHaveBeenCalled();
  });

  it("does not insert a stale upload plan when selection changes while the native picker is pending", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [
      session("session_a", "session-a"),
      session("session_b", "session-b"),
    ];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const sessionA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a")!;
    const sessionB = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b")!;
    await registry.selectTarget(1, sessionA);
    const uploadPath = join(root, "TOP-SECRET-deferred-picker.bin");
    await writeFile(uploadPath, "TOP-SECRET deferred picker bytes", { mode: 0o600 });
    const picker = deferred<{ canceled: boolean; filePaths: string[] }>();
    electronMocks.showOpenDialog.mockImplementationOnce(async () => picker.promise);
    const internals = registry as unknown as {
      windows: Map<number, {
        sessionPlans: Map<string, unknown>;
        sessionPlanAdmissions: Set<string>;
      }>;
      sessionArtifacts: {
        store: (...args: unknown[]) => unknown;
        usage(ownerWindowId?: number): { itemCount: number; byteCount: number };
      };
    };
    const originalStore = internals.sessionArtifacts.store.bind(internals.sessionArtifacts);
    let pickedBytes: Buffer | undefined;
    let selectionChange: ReturnType<ConnectionRegistry["selectTarget"]> | undefined;
    const storeSpy = vi.spyOn(internals.sessionArtifacts, "store").mockImplementation((...args) => {
      const input = args[0] as { data?: unknown } | undefined;
      if (Buffer.isBuffer(input?.data)) pickedBytes = input.data;
      const metadata = originalStore(...args);
      selectionChange = registry.selectTarget(1, sessionB);
      return metadata;
    });

    const preparation = registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/TOP-SECRET-stale-plan.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    await vi.waitFor(() => expect(electronMocks.showOpenDialog).toHaveBeenCalledOnce());
    picker.resolve({ canceled: false, filePaths: [uploadPath] });

    const result = await preparation;
    await selectionChange;
    storeSpy.mockRestore();
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/active session changed/) });
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(0);
    expect(internals.windows.get(1)?.sessionPlanAdmissions.size).toBe(0);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
    expect(pickedBytes?.every((byte) => byte === 0)).toBe(true);
    expect(client.uploadSession).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("revokes reviewed upload bytes when the exact session disappears before dispatch", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "TOP-SECRET-target-loss-upload.bin");
    await writeFile(uploadPath, "TOP-SECRET reviewed target-loss bytes", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [uploadPath] });

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/TOP-SECRET-target-loss.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected an upload plan");
    const internals = registry as unknown as {
      sessionArtifacts: {
        artifacts: Map<string, { data: Buffer }>;
        usage(ownerWindowId?: number): { itemCount: number; byteCount: number };
      };
    };
    const ownedBytes = [...internals.sessionArtifacts.artifacts.values()][0]?.data;
    expect(ownedBytes?.toString()).toBe("TOP-SECRET reviewed target-loss bytes");
    client.sessionState.Sessions = [];

    const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    expect(result).toMatchObject({
      ok: true,
      value: {
        actionId: "session.filesystem.upload-overwrite",
        status: "target-disappeared",
      },
    });
    expect(client.uploadSession).not.toHaveBeenCalled();
    expect(ownedBytes?.every((byte) => byte === 0)).toBe(true);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
    await expect(
      registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/already-used/) });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{
          operationId: "session.filesystem.upload-overwrite",
          state: "target-disappeared",
          attempts: 0,
        }],
      },
    });
    expect(JSON.stringify({ result, history, snapshot: registry.snapshot(1) })).not.toContain("TOP-SECRET");
  });

  it("classifies a reviewed upload rejection as failed and clears every owned copy", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "TOP-SECRET-rejected-upload.bin");
    await writeFile(uploadPath, "TOP-SECRET reviewed rejected bytes", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [uploadPath] });
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/TOP-SECRET-rejected.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected an upload plan");
    const internals = registry as unknown as {
      sessionArtifacts: { artifacts: Map<string, { data: Buffer }> };
    };
    const storedBytes = [...internals.sessionArtifacts.artifacts.values()][0]?.data;
    client.uploadSession.mockResolvedValueOnce(sliverpb.Upload.create({
      Response: { Err: "TOP-SECRET target rejection at /private/implant/path" },
    }));

    const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    expect(result).toMatchObject({
      ok: true,
      value: {
        actionId: "session.filesystem.upload-overwrite",
        status: "failed",
        message: "The target rejected the reviewed action",
      },
    });
    expect(client.uploadSession).toHaveBeenCalledOnce();
    expect(storedBytes?.every((byte) => byte === 0)).toBe(true);
    expect(client.uploadSession.mock.calls[0]?.[2].every((byte) => byte === 0)).toBe(true);
    await expect(
      registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token),
    ).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/already-used/) });
    const history = await registry.listTargetOperations(1, { limit: 100 });
    expect(history).toMatchObject({
      ok: true,
      value: {
        items: [{ operationId: "session.filesystem.upload-overwrite", state: "failed", attempts: 1 }],
      },
    });
    expect(JSON.stringify({ result, history, snapshot: registry.snapshot(1) }))
      .not.toMatch(/TOP-SECRET|private\/implant/u);
  });

  it("binds upload-overwrite authorization to the exact native-picked bytes without exposing the local path", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "operator-secret-name.bin");
    await writeFile(uploadPath, "reviewed bytes", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [uploadPath] });

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/remote.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared upload plan");
    expect(prepared.value.plan.artifact).toMatchObject({
      suggestedBasename: "operator-secret-name.bin",
      size: 14,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(JSON.stringify(prepared)).not.toContain(uploadPath);
    expect(JSON.stringify(prepared)).not.toContain("reviewed bytes");
    await writeFile(uploadPath, "changed after review", { mode: 0o600 });

    await expect(registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token)).resolves.toMatchObject({
      ok: true,
      value: { actionId: "session.filesystem.upload-overwrite", status: "succeeded" },
    });
    expect(client.uploadSession).toHaveBeenCalledOnce();
    expect(client.lastUploadData?.toString()).toBe("reviewed bytes");
  });

  it("prevents a late artifact response from overwriting a newer save to the same destination", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const destination = join(root, "session-download.bin");
    electronMocks.showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: destination })
      .mockResolvedValueOnce({ canceled: false, filePath: destination });
    const firstGate = deferred<sliverpb.Download>();
    const secondGate = deferred<sliverpb.Download>();
    client.downloadFileSession
      .mockImplementationOnce(async () => firstGate.promise)
      .mockImplementationOnce(async () => secondGate.promise);

    const first = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: "/tmp/first.bin",
      maxBytes: 1_024,
    });
    await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledTimes(1));
    const second = registry.runSessionWorkbench(sender(1), {
      operationId: "session.filesystem.download",
      path: "/tmp/second.bin",
      maxBytes: 1_024,
    });
    await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledTimes(2));
    const newerBytes = Buffer.from("newer");
    secondGate.resolve(sliverpb.Download.create({ Exists: true, IsDir: false, Data: newerBytes }));
    await expect(second).resolves.toMatchObject({
      ok: true,
      value: { status: "completed", result: { value: { status: "saved" } } },
    });
    const staleBytes = Buffer.from("stale");
    firstGate.resolve(sliverpb.Download.create({ Exists: true, IsDir: false, Data: staleBytes }));

    await expect(first).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/newer save .* superseded/i),
    });
    expect(await readFile(destination, "utf8")).toBe("newer");
    expect(newerBytes.every((byte) => byte === 0)).toBe(true);
    expect(staleBytes.every((byte) => byte === 0)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes parent-directory aliases before ordering artifact saves",
    async () => {
      const client = new FakeSliverClient();
      client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
      const registry = createRegistry(() => client.adapter);
      registry.registerWindow(1);
      await connectSaved(registry, 1);
      await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
      const actualDirectory = join(root, "actual-save-directory");
      const aliasDirectory = join(root, "alias-save-directory");
      await mkdir(actualDirectory);
      await symlink(actualDirectory, aliasDirectory, "dir");
      const canonicalDestination = join(actualDirectory, "session-download.bin");
      const aliasDestination = join(aliasDirectory, "session-download.bin");
      electronMocks.showSaveDialog
        .mockResolvedValueOnce({ canceled: false, filePath: aliasDestination })
        .mockResolvedValueOnce({ canceled: false, filePath: canonicalDestination });
      const firstGate = deferred<sliverpb.Download>();
      const secondGate = deferred<sliverpb.Download>();
      client.downloadFileSession
        .mockImplementationOnce(async () => firstGate.promise)
        .mockImplementationOnce(async () => secondGate.promise);

      const first = registry.runSessionWorkbench(sender(1), {
        operationId: "session.filesystem.download",
        path: "/tmp/first.bin",
        maxBytes: 1_024,
      });
      await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledTimes(1));
      const second = registry.runSessionWorkbench(sender(1), {
        operationId: "session.filesystem.download",
        path: "/tmp/second.bin",
        maxBytes: 1_024,
      });
      await vi.waitFor(() => expect(client.downloadFileSession).toHaveBeenCalledTimes(2));
      const newerBytes = Buffer.from("newer");
      secondGate.resolve(sliverpb.Download.create({ Exists: true, IsDir: false, Data: newerBytes }));
      await expect(second).resolves.toMatchObject({ ok: true });
      const staleBytes = Buffer.from("stale");
      firstGate.resolve(sliverpb.Download.create({ Exists: true, IsDir: false, Data: staleBytes }));

      await expect(first).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/newer save .* superseded/i),
      });
      expect(await readFile(canonicalDestination, "utf8")).toBe("newer");
      expect(newerBytes.every((byte) => byte === 0)).toBe(true);
      expect(staleBytes.every((byte) => byte === 0)).toBe(true);
    },
  );

  it("revokes abandoned session plans and their upload bytes at the exact TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 9, 20, 0, 0));
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "reviewed-upload.bin");
    await writeFile(uploadPath, "reviewed bytes", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [uploadPath] });

    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/reviewed.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    });
    expect(prepared).toMatchObject({ ok: true, value: { status: "prepared" } });
    const internals = registry as unknown as {
      windows: Map<number, { sessionPlans: Map<string, unknown> }>;
      sessionArtifacts: { usage(ownerWindowId?: number): { itemCount: number; byteCount: number } };
    };
    expect(internals.windows.get(1)?.sessionPlans.size).toBe(1);
    expect(internals.sessionArtifacts.usage(1)).toMatchObject({ itemCount: 1, byteCount: 14 });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(internals.windows.get(1)?.sessionPlans.size).toBe(0);
    expect(internals.sessionArtifacts.usage(1)).toEqual({ itemCount: 0, byteCount: 0 });
  });

  it("rechecks plan expiry after a delayed authoritative refresh and never dispatches late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 9, 20, 0, 0));
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/late.txt",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    const refreshGate = deferred<clientpb.Sessions>();
    const baselineRefreshes = client.getSessions.mock.calls.length;
    client.nextSessionsPromise = refreshGate.promise;

    const execution = registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    await vi.waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(baselineRefreshes + 1));
    await vi.advanceTimersByTimeAsync(60_000);
    refreshGate.resolve(clientpb.Sessions.create(client.sessionState));

    await expect(execution).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/expired before dispatch/),
    });
    expect(client.rmSession).not.toHaveBeenCalled();
  });

  it("does not expose backend refresh errors while revalidating a destructive plan", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const prepared = await registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.rm",
      path: "/tmp/reviewed.txt",
      recursive: false,
      force: false,
    });
    if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected a prepared session plan");
    client.nextSessionsPromise = Promise.reject(new Error("13 INTERNAL: TOP-SECRET at /private/backend/path"));

    const result = await registry.executeSessionDestructiveActionPlan(1, prepared.value.plan.token);
    expect(result).toMatchObject({
      ok: true,
      value: {
        status: "failed",
        message: "Could not refresh the reviewed session before dispatch",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|private\/backend/u);
    expect(client.rmSession).not.toHaveBeenCalled();
  });

  it("bounds concurrent session workbench and artifact requests per window", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    activeSession.OS = "linux";
    client.sessionState.Sessions = [activeSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    registry.registerWindow(3);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    await connectSaved(registry, 3);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await registry.selectTarget(2, registry.snapshot(2).targetContext.selectableTargets[0]!);
    await registry.selectTarget(3, registry.snapshot(3).targetContext.selectableTargets[0]!);

    const environmentGate = deferred<sliverpb.EnvInfo>();
    client.listEnvSession.mockImplementation(async () => environmentGate.promise);
    const standardRequests = Array.from({ length: 8 }, () => registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
    }));
    await vi.waitFor(() => expect(client.listEnvSession).toHaveBeenCalledTimes(8));
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Too many session workbench requests/) });
    environmentGate.resolve(sliverpb.EnvInfo.create({ Variables: [] }));
    await expect(Promise.all(standardRequests)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );

    const screenshotGate = deferred<sliverpb.Screenshot>();
    client.screenshotSession.mockImplementation(async () => screenshotGate.promise);
    const artifactRequests = [
      ...Array.from({ length: 2 }, () => registry.runSessionWorkbench(sender(1), {
        operationId: "session.screenshot.capture" as const,
      })),
      ...Array.from({ length: 2 }, () => registry.runSessionWorkbench(sender(2), {
        operationId: "session.screenshot.capture" as const,
      })),
    ];
    await vi.waitFor(() => expect(client.screenshotSession).toHaveBeenCalledTimes(4));
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.screenshot.capture",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Too many session artifact requests/) });
    await expect(registry.runSessionWorkbench(sender(3), {
      operationId: "session.screenshot.capture",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/global session artifact request capacity/) });
    screenshotGate.resolve(sliverpb.Screenshot.create({
      Data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    }));
    await expect(Promise.all(artifactRequests)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
  });

  it("retains physical workbench admissions across reconnect until the old requests settle", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m2", "m2-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    const gate = deferred<sliverpb.EnvInfo>();
    client.listEnvSession.mockImplementation(async () => gate.promise);
    const oldRequests = Array.from({ length: 8 }, () => registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list" as const,
    }));
    await vi.waitFor(() => expect(client.listEnvSession).toHaveBeenCalledTimes(8));

    await registry.disconnect(1);
    await connectSaved(registry, 1);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
    })).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Too many session workbench requests/) });

    await connectSaved(registry, 2);
    await registry.selectTarget(2, registry.snapshot(2).targetContext.selectableTargets[0]!);
    const peerRequest = registry.runSessionWorkbench(sender(2), { operationId: "session.environment.list" });
    await vi.waitFor(() => expect(client.listEnvSession).toHaveBeenCalledTimes(9));
    gate.resolve(sliverpb.EnvInfo.create({ Variables: [] }));
    await Promise.all(oldRequests);
    await expect(peerRequest).resolves.toMatchObject({ ok: true });

    await expect(registry.runSessionWorkbench(sender(1), {
      operationId: "session.environment.list",
    })).resolves.toMatchObject({ ok: true });
  });

  it("shares artifact admission across upload-plan preparation and execution and releases it on settle", async () => {
    const client = new FakeSliverClient();
    const activeSession = session("session_m2", "m2-interactive");
    activeSession.OS = "linux";
    client.sessionState.Sessions = [activeSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    registry.registerWindow(3);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    await connectSaved(registry, 3);
    await registry.selectTarget(1, registry.snapshot(1).targetContext.selectableTargets[0]!);
    await registry.selectTarget(2, registry.snapshot(2).targetContext.selectableTargets[0]!);
    await registry.selectTarget(3, registry.snapshot(3).targetContext.selectableTargets[0]!);
    const uploadPath = join(root, "bounded-plan-upload.bin");
    await writeFile(uploadPath, "bounded upload", { mode: 0o600 });
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [uploadPath] });

    const plans: Array<{ windowId: number; token: string }> = [];
    for (const windowId of [1, 1, 2, 2]) {
      const prepared = await registry.prepareSessionDestructiveAction(windowId, {
        actionId: "session.filesystem.upload-overwrite",
        remotePath: `/tmp/window-${windowId}-${plans.length}.bin`,
        isIOC: false,
        isDirectory: false,
        overwrite: true,
      });
      if (!prepared.ok || prepared.value.status !== "prepared") throw new Error("Expected an upload plan");
      plans.push({ windowId, token: prepared.value.plan.token });
    }
    const uploadGate = deferred<sliverpb.Upload>();
    client.uploadSession.mockImplementation(async () => uploadGate.promise);
    const executions = plans.map(({ windowId, token }) =>
      registry.executeSessionDestructiveActionPlan(windowId, token));
    await vi.waitFor(() => expect(client.uploadSession).toHaveBeenCalledTimes(4));

    await expect(registry.prepareSessionDestructiveAction(3, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/capacity.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/global session artifact request capacity/),
    });
    uploadGate.resolve(sliverpb.Upload.create({ Path: "/tmp/uploaded.bin" }));
    await expect(Promise.all(executions)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ ok: true })]),
    );
    for (const call of client.uploadSession.mock.calls.slice(-4)) {
      expect(call[2].every((byte) => byte === 0)).toBe(true);
    }

    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    await expect(registry.prepareSessionDestructiveAction(1, {
      actionId: "session.filesystem.upload-overwrite",
      remotePath: "/tmp/after-release.bin",
      isIOC: false,
      isDirectory: false,
      overwrite: true,
    })).resolves.toEqual({ ok: true, value: { status: "canceled" } });
  });
});

describe("M3 session shell registry boundary", () => {
  it("binds a prepared shell to the exact window and renderer document while preserving early output", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m3", "m3-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);

    await expect(registry.prepareSessionShell(1, 101, "document-a", { requestPty: true })).resolves.toEqual({
      ok: false,
      error: "Select an active session before using the session workbench",
    });
    const firstTarget = registry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    const secondTarget = registry.snapshot(2).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!firstTarget || !secondTarget) throw new Error("Expected shared session target refs");
    await registry.selectTarget(1, firstTarget);
    await registry.selectTarget(2, secondTarget);

    const earlyPrompt = Uint8Array.from(Buffer.from("early-shell-prompt> ", "utf8"));
    const shell = new FakeShellSession(earlyPrompt);
    client.nextShellSession = shell;
    const prepared = await registry.prepareSessionShell(1, 101, "document-a", {
      requestPty: true,
      rows: 41,
      columns: 119,
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.value).toMatchObject({
      kind: "session-shell",
      pty: "requested-unconfirmed",
      canResize: true,
    });

    await expect(registry.listSessionShells(1, 101, "document-stale", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.listSessionShells(2, 202, "document-b", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.actOnSessionShell(1, 101, "document-stale", {
      resourceId: prepared.value.resourceId,
      action: "close",
    })).resolves.toEqual({
      ok: false,
      error: "The stream is unavailable for the current window, backend, target, or renderer",
    });
    expect(client.startShellSession).not.toHaveBeenCalled();

    const crossWindowPort = new FakeMessagePort();
    expect(() => registry.attachStream(2, 202, "document-b", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: prepared.value.attachment.attachmentToken,
    }, crossWindowPort.asElectronPort())).toThrow(
      "The stream is unavailable for the current window, backend, target, or renderer",
    );
    expect(crossWindowPort.closed).toBe(true);

    const staleDocumentPort = new FakeMessagePort();
    expect(() => registry.attachStream(1, 101, "document-stale", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: prepared.value.attachment.attachmentToken,
    }, staleDocumentPort.asElectronPort())).toThrow(
      "The stream is unavailable for the current window, backend, target, or renderer",
    );
    expect(staleDocumentPort.closed).toBe(true);

    const port = new FakeMessagePort();
    registry.attachStream(1, 101, "document-a", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: prepared.value.attachment.attachmentToken,
    }, port.asElectronPort());
    const ready = port.last("ready");
    if (!ready) throw new Error("Expected ready frame");
    port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: 64 * 1_024,
    });

    await vi.waitFor(() => expect(client.startShellSession).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(port.last("opened")).toBeDefined());
    await vi.waitFor(() => expect(port.last("data")).toBeDefined());
    expect(client.startShellSession).toHaveBeenCalledWith("session_m3", {
      path: "/bin/bash",
      pty: true,
      rows: 41,
      cols: 119,
    }, 30);
    expect(Buffer.from(new Uint8Array(port.last("data")!.data)).toString("utf8")).toBe("early-shell-prompt> ");
    expect([...earlyPrompt]).toEqual(new Array(earlyPrompt.length).fill(0));
    await expect(registry.listSessionShells(1, 101, "document-a", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: prepared.value.resourceId, state: "attached" }] },
    });

    await expect(registry.actOnSessionShell(1, 101, "document-a", {
      resourceId: prepared.value.resourceId,
      action: "close",
    })).resolves.toEqual({
      ok: true,
      value: { action: "close", resourceId: prepared.value.resourceId },
    });
    expect(shell.close).toHaveBeenCalledOnce();
  });

  it("coerces Windows PTY requests off and uses bounded platform defaults", async () => {
    const client = new FakeSliverClient();
    const windowsSession = session("session_windows", "windows-interactive");
    windowsSession.OS = "windows";
    windowsSession.Arch = "amd64";
    client.sessionState.Sessions = [windowsSession];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets[0];
    if (!target) throw new Error("Expected Windows session ref");
    await registry.selectTarget(1, target);

    const shell = new FakeShellSession();
    client.nextShellSession = shell;
    const opened = await openRegistryShell(registry, 1, 303, "windows-document", {
      requestPty: true,
      rows: 55,
      columns: 144,
    });

    expect(opened.plan).toMatchObject({ pty: "disabled", canResize: false });
    expect(client.startShellSession).toHaveBeenCalledWith("session_windows", {
      path: "powershell.exe",
      pty: false,
      rows: 24,
      cols: 80,
    }, 30);
    await registry.actOnSessionShell(1, 303, "windows-document", {
      resourceId: opened.plan.resourceId,
      action: "close",
    });
  });

  it("claims and returns one exact shell without restarting it or accepting stale renderer authority", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_popout", "popout-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    const target = registry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!target) throw new Error("Expected session target ref");
    await registry.selectTarget(1, target);

    const shell = new FakeShellSession();
    client.nextShellSession = shell;
    const opened = await openRegistryShell(registry, 1, 701, "source-document", { requestPty: false });
    await expect(registry.actOnSessionShell(1, 701, "source-document", {
      resourceId: opened.plan.resourceId,
      action: "detach",
    })).resolves.toMatchObject({ ok: true });
    const staleAttach = await registry.actOnSessionShell(1, 701, "source-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    });
    if (!staleAttach.ok || !staleAttach.value.attachment) throw new Error("Expected source reattach ticket");

    await expect(registry.claimSessionShellWindow(
      1,
      701,
      "source-document",
      2,
      702,
      "popout-document",
      target,
      opened.plan.resourceId,
    )).resolves.toMatchObject({
      ok: true,
      value: {
        kind: "session-shell",
        preferredResourceId: opened.plan.resourceId,
        snapshot: { targetContext: { activeTargetSummary: { id: "session_popout" } } },
      },
    });
    expect(client.startShellSession).toHaveBeenCalledOnce();
    await expect(registry.listSessionShells(1, 701, "source-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.listSessionShells(2, 999, "popout-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.listSessionShells(2, 702, "stale-popout-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.listSessionShells(2, 702, "popout-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: opened.plan.resourceId, state: "detached" }] },
    });
    await expect(registry.actOnSessionShell(1, 701, "source-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    })).resolves.toEqual({
      ok: false,
      error: "The stream is unavailable for the current window, backend, target, or renderer",
    });
    await expect(registry.actOnSessionShell(2, 999, "popout-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    })).resolves.toMatchObject({ ok: false });

    for (const [contentsId, processId, frameToken] of [
      [1, 701, "source-document"],
      [2, 702, "popout-document"],
    ] as const) {
      const stalePort = new FakeMessagePort();
      expect(() => registry.attachStream(contentsId, processId, frameToken, {
        v: STREAM_PROTOCOL_VERSION,
        attachmentToken: staleAttach.value.attachment!.attachmentToken,
      }, stalePort.asElectronPort())).toThrow(
        "The stream is unavailable for the current window, backend, target, or renderer",
      );
      expect(stalePort.closed).toBe(true);
    }

    const destinationAttach = await registry.actOnSessionShell(2, 702, "popout-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    });
    if (!destinationAttach.ok || !destinationAttach.value.attachment) {
      throw new Error("Expected destination reattach ticket");
    }
    const destinationPort = new FakeMessagePort();
    registry.attachStream(2, 702, "popout-document", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: destinationAttach.value.attachment.attachmentToken,
    }, destinationPort.asElectronPort());
    const destinationReady = destinationPort.last("ready");
    if (!destinationReady) throw new Error("Expected destination ready frame");
    destinationPort.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "start",
      streamId: destinationReady.streamId,
      receiveCreditBytes: 64 * 1_024,
    });
    await vi.waitFor(() => expect(destinationPort.last("opened")).toBeDefined());
    expect(client.startShellSession).toHaveBeenCalledOnce();

    await expect(registry.returnSessionShellWindow(
      2,
      702,
      "popout-document",
      1,
      701,
      "source-document",
      target,
    )).resolves.toBe(true);
    expect(destinationPort.last("closed")).toMatchObject({
      reason: "operator-detach",
      disposition: "detached",
    });
    await expect(registry.listSessionShells(2, 702, "popout-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    await expect(registry.listSessionShells(1, 701, "source-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: opened.plan.resourceId, state: "detached" }] },
    });

    const returnedAttach = await registry.actOnSessionShell(1, 701, "source-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    });
    if (!returnedAttach.ok || !returnedAttach.value.attachment) throw new Error("Expected returned shell ticket");
    const returnedPort = new FakeMessagePort();
    registry.attachStream(1, 701, "source-document", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: returnedAttach.value.attachment.attachmentToken,
    }, returnedPort.asElectronPort());
    const returnedReady = returnedPort.last("ready");
    if (!returnedReady) throw new Error("Expected returned ready frame");
    returnedPort.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "start",
      streamId: returnedReady.streamId,
      receiveCreditBytes: 64 * 1_024,
    });
    await vi.waitFor(() => expect(returnedPort.last("opened")).toBeDefined());
    expect(client.startShellSession).toHaveBeenCalledOnce();
    await registry.actOnSessionShell(1, 701, "source-document", {
      resourceId: opened.plan.resourceId,
      action: "close",
    });
    expect(shell.close).toHaveBeenCalledOnce();
  });

  it("tops up an existing dedicated window and accepts a preferred shell already owned there", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_topup", "topup-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    const target = registry.snapshot(1).targetContext.selectableTargets[0];
    if (!target) throw new Error("Expected session target ref");
    await registry.selectTarget(1, target);

    const first = await registry.prepareSessionShell(1, 721, "source-document", { requestPty: false });
    if (!first.ok) throw new Error(first.error);
    await expect(registry.claimSessionShellWindow(
      1, 721, "source-document", 2, 722, "popout-document", target, first.value.resourceId,
    )).resolves.toMatchObject({
      ok: true,
      value: { preferredResourceId: first.value.resourceId },
    });

    await expect(registry.claimSessionShellWindow(
      1, 721, "source-document", 2, 722, "popout-document", target, first.value.resourceId,
    )).resolves.toMatchObject({
      ok: true,
      value: { preferredResourceId: first.value.resourceId },
    });

    const second = await registry.prepareSessionShell(1, 721, "source-document", { requestPty: false });
    if (!second.ok) throw new Error(second.error);
    await expect(registry.claimSessionShellWindow(
      1, 721, "source-document", 2, 722, "popout-document", target, second.value.resourceId,
    )).resolves.toMatchObject({
      ok: true,
      value: { preferredResourceId: second.value.resourceId },
    });
    await expect(registry.listSessionShells(1, 721, "source-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [] },
    });
    const destination = await registry.listSessionShells(2, 722, "popout-document", {});
    expect(destination).toMatchObject({ ok: true, value: { resources: expect.any(Array) } });
    if (!destination.ok) throw new Error(destination.error);
    expect(destination.value.resources.map(({ resourceId }) => resourceId).sort()).toEqual([
      first.value.resourceId,
      second.value.resourceId,
    ].sort());
    expect(client.startShellSession).not.toHaveBeenCalled();
  });

  it("leaves ownership atomic when source identity or preferred shell is stale or foreign", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_popout", "popout-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    registry.registerWindow(3);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    registry.inheritConnection(1, 3);
    const sourceTarget = registry.snapshot(1).targetContext.selectableTargets[0];
    const foreignTarget = registry.snapshot(3).targetContext.selectableTargets[0];
    if (!sourceTarget || !foreignTarget) throw new Error("Expected shared target refs");
    await registry.selectTarget(1, sourceTarget);
    await registry.selectTarget(3, foreignTarget);

    const sourceShell = new FakeShellSession();
    client.nextShellSession = sourceShell;
    const source = await openRegistryShell(registry, 1, 711, "source-document", { requestPty: false });
    const foreignShell = new FakeShellSession();
    client.nextShellSession = foreignShell;
    const foreign = await openRegistryShell(registry, 3, 713, "foreign-document", { requestPty: false });
    const destinationContextBefore = registry.snapshot(2).targetContext;

    for (const [sourceProcessId, sourceFrameToken, preferredResourceId] of [
      [999, "source-document", source.plan.resourceId],
      [711, "stale-source-document", source.plan.resourceId],
      [711, "source-document", foreign.plan.resourceId],
      [711, "source-document", "Z".repeat(43)],
    ] as const) {
      await expect(registry.claimSessionShellWindow(
        1,
        sourceProcessId,
        sourceFrameToken,
        2,
        712,
        "popout-document",
        sourceTarget,
        preferredResourceId,
      )).resolves.toMatchObject({ ok: false });
      expect(source.port.closed).toBe(false);
      await expect(registry.listSessionShells(1, 711, "source-document", {})).resolves.toMatchObject({
        ok: true,
        value: { resources: [{ resourceId: source.plan.resourceId, state: "attached" }] },
      });
      expect(registry.snapshot(2).targetContext).toEqual(destinationContextBefore);
    }
    await expect(registry.listSessionShells(3, 713, "foreign-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: foreign.plan.resourceId, state: "attached" }] },
    });

    await expect(registry.claimSessionShellWindow(
      1,
      711,
      "source-document",
      2,
      712,
      "popout-document",
      sourceTarget,
      source.plan.resourceId,
    )).resolves.toMatchObject({ ok: true });
    expect(source.port.last("closed")).toMatchObject({ disposition: "detached" });
    expect(foreign.port.closed).toBe(false);
  });

  it("keeps a migrated shell alive across source target switch and close, then closes it on target loss", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [
      session("session_a", "session-a"),
      session("session_b", "session-b"),
    ];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    registry.inheritConnection(1, 2);
    const targetA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a");
    if (!targetA) throw new Error("Expected session A target ref");
    await registry.selectTarget(1, targetA);
    const shell = new FakeShellSession();
    client.nextShellSession = shell;
    const opened = await openRegistryShell(registry, 1, 721, "source-document", { requestPty: false });

    await expect(registry.claimSessionShellWindow(
      1,
      721,
      "source-document",
      2,
      722,
      "popout-document",
      targetA,
      opened.plan.resourceId,
    )).resolves.toMatchObject({ ok: true });
    const destinationAttach = await registry.actOnSessionShell(2, 722, "popout-document", {
      resourceId: opened.plan.resourceId,
      action: "attach",
    });
    if (!destinationAttach.ok || !destinationAttach.value.attachment) {
      throw new Error("Expected destination ticket");
    }
    const destinationPort = new FakeMessagePort();
    registry.attachStream(2, 722, "popout-document", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: destinationAttach.value.attachment.attachmentToken,
    }, destinationPort.asElectronPort());
    const ready = destinationPort.last("ready");
    if (!ready) throw new Error("Expected destination ready frame");
    destinationPort.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: 64 * 1_024,
    });
    await vi.waitFor(() => expect(destinationPort.last("opened")).toBeDefined());

    const currentTargetB = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b");
    if (!currentTargetB) throw new Error("Expected current session B target ref");
    await expect(registry.selectTarget(1, currentTargetB)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTargetSummary: { id: "session_b" } } },
    });
    expect(shell.close).not.toHaveBeenCalled();
    expect(destinationPort.last("closed")).toBeUndefined();
    await expect(registry.listSessionShells(2, 722, "popout-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: opened.plan.resourceId, state: "attached" }] },
    });

    await registry.unregisterWindow(1);
    expect(shell.close).not.toHaveBeenCalled();
    expect(destinationPort.last("closed")).toBeUndefined();
    client.sessionState.Sessions = [session("session_b", "session-b")];
    await expect(registry.refresh(2)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTarget: null } },
    });
    await vi.waitFor(() => expect(shell.close).toHaveBeenCalledOnce());
    expect(destinationPort.last("closed")).toMatchObject({
      reason: "target-disappeared",
      disposition: "closed",
    });
  });

  it("cleans up A-to-B and background transitions per window, then closes every owner on authoritative loss", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_a", "session-a"), session("session_b", "session-b")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    registry.registerWindow(2);
    await connectSaved(registry, 1);
    await connectSaved(registry, 2);
    const targetA1 = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a");
    const targetA2 = registry.snapshot(2).targetContext.selectableTargets.find(({ id }) => id === "session_a");
    const targetB1 = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_b");
    if (!targetA1 || !targetA2 || !targetB1) throw new Error("Expected both session refs");
    await registry.selectTarget(1, targetA1);
    await registry.selectTarget(2, targetA2);

    const firstShell = new FakeShellSession();
    client.nextShellSession = firstShell;
    await openRegistryShell(registry, 1, 401, "window-one-document", { requestPty: false });
    const secondShell = new FakeShellSession();
    client.nextShellSession = secondShell;
    const second = await openRegistryShell(registry, 2, 402, "window-two-document", { requestPty: false });

    await expect(registry.selectTarget(1, targetB1)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTargetSummary: { id: "session_b" } } },
    });
    expect(firstShell.close).toHaveBeenCalledOnce();
    expect(secondShell.close).not.toHaveBeenCalled();
    await expect(registry.listSessionShells(2, 402, "window-two-document", {})).resolves.toMatchObject({
      ok: true,
      value: { resources: [{ resourceId: second.plan.resourceId, state: "attached" }] },
    });

    await expect(registry.backgroundTarget(2)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTarget: null } },
    });
    expect(secondShell.close).toHaveBeenCalledOnce();

    const currentA = registry.snapshot(1).targetContext.selectableTargets.find(({ id }) => id === "session_a");
    if (!currentA) throw new Error("Expected current A target ref");
    await registry.selectTarget(1, currentA);
    const lostShell = new FakeShellSession();
    client.nextShellSession = lostShell;
    await openRegistryShell(registry, 1, 401, "window-one-document", { requestPty: false });
    client.sessionState.Sessions = [session("session_b", "session-b")];

    await expect(registry.refresh(1)).resolves.toMatchObject({
      ok: true,
      value: { targetContext: { activeTarget: null } },
    });
    await vi.waitFor(() => expect(lostShell.close).toHaveBeenCalledOnce());
  });

  it("exposes only a fixed close disposition when shell startup fails with sensitive diagnostics", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m3", "m3-interactive")];
    client.startShellSession.mockRejectedValueOnce(
      new Error("token=TOP-SECRET password=HUNTER2 path=/Users/operator/private-shell"),
    );
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets[0];
    if (!target) throw new Error("Expected session ref");
    await registry.selectTarget(1, target);

    const prepared = await registry.prepareSessionShell(1, 501, "failure-document", { requestPty: false });
    if (!prepared.ok) throw new Error(prepared.error);
    const port = new FakeMessagePort();
    registry.attachStream(1, 501, "failure-document", {
      v: STREAM_PROTOCOL_VERSION,
      attachmentToken: prepared.value.attachment.attachmentToken,
    }, port.asElectronPort());
    const ready = port.last("ready");
    if (!ready) throw new Error("Expected ready frame");
    port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: 64 * 1_024,
    });

    await vi.waitFor(() => expect(port.last("closed")).toMatchObject({
      reason: "transport-error",
      disposition: "closed",
    }));
    expect(JSON.stringify(port.frames)).not.toMatch(/TOP-SECRET|HUNTER2|private-shell/u);
    await vi.waitFor(async () => {
      await expect(registry.listSessionShells(1, 501, "failure-document", {})).resolves.toMatchObject({
        ok: true,
        value: { resources: [] },
      });
    });
  });

  it("bounds shell preparation across a coalesced refresh and releases admission after settlement", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m3", "m3-interactive")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets[0];
    if (!target) throw new Error("Expected session ref");
    await registry.selectTarget(1, target);
    const baselineSessionCalls = client.getSessions.mock.calls.length;
    const refreshGate = deferred<clientpb.Sessions>();
    client.nextSessionsPromise = refreshGate.promise;
    const internals = registry as unknown as {
      windows: Map<number, { sessionShellPrepareAdmissions: Set<string> }>;
    };

    const first = registry.prepareSessionShell(1, 601, "prepare-one", { requestPty: false });
    await vi.waitFor(() => expect(client.getSessions).toHaveBeenCalledTimes(baselineSessionCalls + 1));
    const second = registry.prepareSessionShell(1, 602, "prepare-two", { requestPty: false });
    await vi.waitFor(() => expect(internals.windows.get(1)?.sessionShellPrepareAdmissions.size).toBe(2));
    await expect(registry.prepareSessionShell(1, 603, "prepare-three", {
      requestPty: false,
    })).resolves.toEqual({
      ok: false,
      error: "Too many shell preparations are already running in this window",
    });
    expect(client.getSessions).toHaveBeenCalledTimes(baselineSessionCalls + 1);

    refreshGate.resolve(clientpb.Sessions.create(client.sessionState));
    const prepared = await Promise.all([first, second]);
    for (const result of prepared) expect(result).toMatchObject({ ok: true });
    expect(internals.windows.get(1)?.sessionShellPrepareAdmissions.size).toBe(0);
    const released = await registry.prepareSessionShell(1, 603, "prepare-three", { requestPty: false });
    expect(released).toMatchObject({ ok: true });

    const plans = [...prepared, released].flatMap((result) => result.ok ? [result.value] : []);
    const documents = [
      { processId: 601, frameToken: "prepare-one" },
      { processId: 602, frameToken: "prepare-two" },
      { processId: 603, frameToken: "prepare-three" },
    ];
    for (const [index, plan] of plans.entries()) {
      const document = documents[index];
      if (!document) throw new Error("Expected preparation document binding");
      await expect(registry.actOnSessionShell(1, document.processId, document.frameToken, {
        resourceId: plan.resourceId,
        action: "close",
      })).resolves.toMatchObject({ ok: true });
    }
  });

  it("bounds terminal runtime copies per window without a rejected duplicate releasing the live admission", async () => {
    const registry = createRegistry(() => new FakeSliverClient().adapter);
    registry.registerWindow(1);
    const gate = deferred<TerminalRuntimeAsset>();
    terminalRuntimeMocks.loadTerminalRuntime.mockImplementationOnce(() => gate.promise);

    const first = registry.getTerminalRuntime(1);
    await vi.waitFor(() => expect(terminalRuntimeMocks.loadTerminalRuntime).toHaveBeenCalledOnce());
    await expect(registry.getTerminalRuntime(1)).resolves.toEqual({
      ok: false,
      error: "The verified packaged terminal runtime is unavailable",
    });
    await expect(registry.getTerminalRuntime(1)).resolves.toEqual({
      ok: false,
      error: "The verified packaged terminal runtime is unavailable",
    });
    expect(terminalRuntimeMocks.loadTerminalRuntime).toHaveBeenCalledOnce();

    const asset = terminalRuntimeAsset();
    gate.resolve(asset);
    await expect(first).resolves.toEqual({ ok: true, value: asset });
    await expect(registry.getTerminalRuntime(1)).resolves.toMatchObject({
      ok: true,
      value: { version: "0.4.0", sha256: "a".repeat(64) },
    });
    expect(terminalRuntimeMocks.loadTerminalRuntime).toHaveBeenCalledTimes(2);
  });

  it("binds reviewed execution to the exact session, retains bounded output, and consumes the plan once", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m4", "m4-execution")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!target) throw new Error("Expected an M4 session target");
    await registry.selectTarget(1, target);

    const catalog = await registry.listExecutionCatalog(1);
    expect(catalog).toMatchObject({
      ok: true,
      value: {
        target: { id: "session_m4" },
        capabilities: expect.arrayContaining([
          expect.objectContaining({ operationId: "execution.process", available: true }),
          expect.objectContaining({ operationId: "execution.assembly", available: false }),
        ]),
      },
    });

    const prepared = await registry.prepareExecutionAction(sender(1), {
      draft: {
        operationId: "execution.process",
        path: "/usr/bin/id",
        args: ["-u"],
        captureOutput: true,
        background: false,
        inheritEnvironment: true,
        environment: [],
        useToken: false,
        hideWindow: false,
        timeoutSeconds: 60,
      },
    });
    if (!prepared.ok) throw new Error(prepared.error);
    expect(prepared.value.fields).toContainEqual({
      label: "Executable",
      value: "/usr/bin/id",
      sensitive: false,
    });

    const executed = await registry.executeExecutionPlan(1, { token: prepared.value.token });
    if (!executed.ok) throw new Error(executed.error);
    expect(executed.value).toMatchObject({
      operationId: "execution.process",
      state: "completed",
      pid: 6_001,
      output: expect.arrayContaining([
        expect.objectContaining({ stream: "stdout", size: 9 }),
        expect.objectContaining({ stream: "stderr", size: 9 }),
        expect.objectContaining({ stream: "combined", size: 18 }),
      ]),
    });
    expect(client.executeSession).toHaveBeenCalledOnce();
    await expect(registry.executeExecutionPlan(1, { token: prepared.value.token })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/unavailable or expired/u),
    });
    expect(client.executeSession).toHaveBeenCalledOnce();

    await expect(registry.getExecutionResult(1, { requestId: executed.value.requestId })).resolves.toEqual({
      ok: true,
      value: executed.value,
    });
    const destination = join(externalDirectory, "m4-stdout.bin");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(registry.saveExecutionResult(sender(1), {
      requestId: executed.value.requestId,
      stream: "stdout",
    })).resolves.toEqual({ ok: true, value: { saved: true, fileName: "m4-stdout.bin" } });
    await expect(readFile(destination, "utf8")).resolves.toBe("m4-stdout");
  });

  it("classifies exact target rejection separately from transport uncertainty without replay or backend text", async () => {
    const client = new FakeSliverClient();
    client.sessionState.Sessions = [session("session_m4_errors", "m4-errors")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!target) throw new Error("Expected an M4 session target");
    await registry.selectTarget(1, target);
    const prepare = async () => {
      const result = await registry.prepareExecutionAction(sender(1), {
        draft: {
          operationId: "execution.process",
          path: "/usr/bin/false",
          args: [],
          captureOutput: true,
          background: false,
          inheritEnvironment: true,
          environment: [],
          useToken: false,
          hideWindow: false,
          timeoutSeconds: 60,
        },
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };

    client.executeSession.mockResolvedValueOnce({
      Stdout: Buffer.alloc(0),
      Stderr: Buffer.alloc(0),
      Pid: 0,
      Response: { Err: "secret target detail /remote/path" },
    });
    const rejected = await registry.executeExecutionPlan(1, { token: (await prepare()).token });
    expect(rejected).toMatchObject({
      ok: true,
      value: { state: "failed", message: "The selected target rejected the reviewed operation." },
    });
    expect(JSON.stringify(rejected)).not.toMatch(/secret|remote\/path/u);

    client.executeSession.mockRejectedValueOnce(new Error("credential=secret /rpc/private/path"));
    const uncertain = await registry.executeExecutionPlan(1, { token: (await prepare()).token });
    expect(uncertain).toMatchObject({
      ok: true,
      value: { state: "outcome-unknown" },
    });
    expect(JSON.stringify(uncertain)).not.toMatch(/credential|secret|rpc\/private/u);
    expect(client.executeSession).toHaveBeenCalledTimes(2);
  });

  it("clears credential bytes after reviewed execution and journals beacon submission without waiting", async () => {
    const windowsClient = new FakeSliverClient();
    const windowsSession = session("session_windows_m4", "windows-m4");
    windowsSession.OS = "windows";
    windowsSession.Arch = "amd64";
    windowsClient.sessionState.Sessions = [windowsSession];
    const sessionRegistry = createRegistry(() => windowsClient.adapter);
    sessionRegistry.registerWindow(1);
    await connectSaved(sessionRegistry, 1);
    const sessionTarget = sessionRegistry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!sessionTarget) throw new Error("Expected a Windows session target");
    await sessionRegistry.selectTarget(1, sessionTarget);
    const credential = Uint8Array.from(Buffer.from("one-operation-password", "utf8"));
    const review = await sessionRegistry.prepareExecutionAction(sender(1), {
      draft: {
        operationId: "privilege.run-as",
        username: "operator",
        domain: "LAB",
        password: credential,
        process: "cmd.exe",
        args: "/c whoami",
        showWindow: false,
        netOnly: false,
        timeoutSeconds: 30,
      },
    });
    if (!review.ok) throw new Error(review.error);
    expect(review.value).toMatchObject({
      currentIdentity: "DOMAIN\\operator-user",
      requestedIdentity: "LAB\\operator",
    });
    expect(windowsClient.currentTokenOwnerSession).toHaveBeenCalledOnce();
    expect(JSON.stringify(review.value)).not.toMatch(/one-operation-password/u);
    await expect(sessionRegistry.executeExecutionPlan(1, { token: review.value.token })).resolves.toMatchObject({
      ok: true,
      value: { state: "completed" },
    });
    expect([...credential]).toEqual(new Array(credential.length).fill(0));

    const beaconClient = new FakeSliverClient();
    beaconClient.beaconState.Beacons = [beacon("beacon_m4", "m4-beacon")];
    const beaconRegistry = createRegistry(() => beaconClient.adapter);
    beaconRegistry.registerWindow(2);
    await connectSaved(beaconRegistry, 2);
    const beaconTarget = beaconRegistry.snapshot(2).targetContext.selectableTargets.find(({ mode }) => mode === "beacon");
    if (!beaconTarget) throw new Error("Expected an M4 beacon target");
    await beaconRegistry.selectTarget(2, beaconTarget);
    const queued = await beaconRegistry.prepareExecutionAction(sender(2), {
      draft: {
        operationId: "execution.process",
        path: "/usr/bin/id",
        args: [],
        captureOutput: false,
        background: false,
        inheritEnvironment: true,
        environment: [],
        useToken: false,
        hideWindow: false,
        timeoutSeconds: 60,
      },
    });
    if (!queued.ok) throw new Error(queued.error);
    const submitted = await beaconRegistry.executeExecutionPlan(2, { token: queued.value.token });
    if (!submitted.ok) throw new Error(submitted.error);
    expect(submitted).toMatchObject({
      ok: true,
      value: {
        operationId: "execution.process",
        state: "submitted",
        taskId: expect.stringMatching(/^task_/u),
      },
    });
    expect(beaconClient.executeBeacon).toHaveBeenCalledOnce();
  });

  it("decodes a completed beacon action, retains its output, and destroys fetched task bytes", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_decode", "m4-decode")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(client, "beacon_m4_decode", taskId, "ExecuteReq");
    const fetched = clientpb.BeaconTask.create({
      ID: taskId,
      BeaconID: "beacon_m4_decode",
      State: "completed",
      Description: "ExecuteReq",
      Request: Buffer.from("M4_FETCHED_REQUEST_SECRET"),
      Response: Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
        Stdout: Buffer.from("decoded-beacon-stdout"),
        Stderr: Buffer.from("decoded-beacon-stderr"),
        Pid: 7_331,
        Response: {},
      })).finish()),
    });
    client.fetchBeaconTask.mockResolvedValueOnce(fetched);

    const completed = await registry.getExecutionResult(1, { requestId: submitted.requestId });
    expect(completed).toMatchObject({
      ok: true,
      value: {
        requestId: submitted.requestId,
        operationId: "execution.process",
        state: "completed",
        taskId,
        pid: 7_331,
        message: "Process execution completed.",
        output: expect.arrayContaining([
          expect.objectContaining({ stream: "stdout", size: 21 }),
          expect.objectContaining({ stream: "stderr", size: 21 }),
          expect.objectContaining({ stream: "combined", size: 42 }),
        ]),
      },
    });
    expect(fetched.Request.every((byte) => byte === 0)).toBe(true);
    expect(fetched.Response.every((byte) => byte === 0)).toBe(true);

    await expect(registry.getExecutionResult(1, { requestId: submitted.requestId })).resolves.toEqual(completed);
    expect(client.fetchBeaconTask).toHaveBeenCalledOnce();
    const destination = join(externalDirectory, "decoded-beacon-stdout.txt");
    electronMocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
    await expect(registry.saveExecutionResult(sender(1), {
      requestId: submitted.requestId,
      stream: "stdout",
    })).resolves.toEqual({
      ok: true,
      value: { saved: true, fileName: "decoded-beacon-stdout.txt" },
    });
    await expect(readFile(destination, "utf8")).resolves.toBe("decoded-beacon-stdout");
  });

  it("maps a completed beacon Response.Err to a fixed failed result without remote text", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_reject", "m4-reject")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(client, "beacon_m4_reject", taskId, "ExecuteReq");
    const fetched = clientpb.BeaconTask.create({
      ID: taskId,
      BeaconID: "beacon_m4_reject",
      State: "completed",
      Description: "ExecuteReq",
      Request: Buffer.from("M4_REJECT_REQUEST_SECRET"),
      Response: Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
        Response: { Err: "password=REMOTE_SECRET path=/remote/private" },
      })).finish()),
    });
    client.fetchBeaconTask.mockResolvedValueOnce(fetched);

    const failed = await registry.getExecutionResult(1, { requestId: submitted.requestId });
    expect(failed).toMatchObject({
      ok: true,
      value: {
        state: "failed",
        taskId,
        message: "The selected target rejected the reviewed operation.",
      },
    });
    expect(JSON.stringify(failed)).not.toMatch(/REMOTE_SECRET|remote\/private|password=/u);
    expect(fetched.Request.every((byte) => byte === 0)).toBe(true);
    expect(fetched.Response.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    {
      label: "a target-reported error",
      response: () => Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
        Response: { Err: "password=GENERIC_DETAIL_MUST_NOT_SETTLE" },
      })).finish()),
      exactState: "failed",
    },
    {
      label: "a malformed response",
      response: () => Buffer.from([0xff, 0xff, 0xff, 0x7f]),
      exactState: "outcome-unknown",
    },
  ] as const)("does not settle an M4 journal from generic task detail with $label", async ({
    response,
    exactState,
  }) => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_detail_guard", "m4-detail-guard")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(client, "beacon_m4_detail_guard", taskId, "ExecuteReq", response());

    await expect(registry.getBeaconTask(1, taskId)).resolves.toMatchObject({
      ok: true,
      value: { taskId, state: "completed", localRequestId: submitted.requestId },
    });
    await expect(registry.getTargetOperation(1, submitted.requestId)).resolves.toMatchObject({
      ok: true,
      value: { state: "running", taskId },
    });

    await expect(registry.getExecutionResult(1, { requestId: submitted.requestId })).resolves.toMatchObject({
      ok: true,
      value: { state: exactState, taskId },
    });
  });

  it("keeps an already-completed malformed M4 task nonterminal during cancellation preflight", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_cancel_preflight", "m4-cancel-preflight")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(
      client,
      "beacon_m4_cancel_preflight",
      taskId,
      "ExecuteReq",
      Buffer.from([0xff, 0xff, 0xff, 0x7f]),
    );

    const canceled = await registry.cancelTargetOperation(1, submitted.requestId);
    expect(canceled).toMatchObject({ ok: true, value: { taskId } });
    if (!canceled.ok) throw new Error(canceled.error);
    expect(["running", "cancel-requested"]).toContain(canceled.value.state);
    expect(client.cancelBeaconTask).not.toHaveBeenCalled();
    const operation = await registry.getTargetOperation(1, submitted.requestId);
    expect(operation).toMatchObject({ ok: true, value: { taskId } });
    if (!operation.ok) throw new Error(operation.error);
    expect(["running", "cancel-requested"]).toContain(operation.value.state);

    await expect(registry.getExecutionResult(1, { requestId: submitted.requestId })).resolves.toMatchObject({
      ok: true,
      value: { state: "outcome-unknown", taskId },
    });
  });

  it("keeps a completed M4 Response.Err nonterminal during cancellation follow-up", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_cancel_followup", "m4-cancel-followup")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    client.cancelBeaconTask.mockImplementationOnce(async () => {
      completeFakeTaskSummary(
        client,
        "beacon_m4_cancel_followup",
        taskId,
        "ExecuteReq",
        Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
          Response: { Err: "password=CANCEL_FOLLOWUP_MUST_NOT_SETTLE" },
        })).finish()),
      );
      throw new Error("the cancellation response was lost after task completion");
    });

    const canceled = await registry.cancelTargetOperation(1, submitted.requestId);
    expect(canceled).toMatchObject({ ok: true, value: { taskId } });
    if (!canceled.ok) throw new Error(canceled.error);
    expect(["running", "cancel-requested"]).toContain(canceled.value.state);
    expect(client.cancelBeaconTask).toHaveBeenCalledOnce();
    const operation = await registry.getTargetOperation(1, submitted.requestId);
    expect(operation).toMatchObject({ ok: true, value: { taskId } });
    if (!operation.ok) throw new Error(operation.error);
    expect(["running", "cancel-requested"]).toContain(operation.value.state);

    await expect(registry.getExecutionResult(1, { requestId: submitted.requestId })).resolves.toMatchObject({
      ok: true,
      value: { state: "failed", taskId },
    });
  });

  it("zeroizes decoded action output when completed journal reconciliation rejects", async () => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_reconcile_reject", "m4-reconcile-reject")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(client, "beacon_m4_reconcile_reject", taskId, "ExecuteReq");
    const fetched = clientpb.BeaconTask.create({
      ID: taskId,
      BeaconID: "beacon_m4_reconcile_reject",
      State: "completed",
      Description: "ExecuteReq",
      Response: Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
        Pid: 7_332,
        Stdout: Buffer.from("RECONCILE_REJECT_STDOUT"),
        Stderr: Buffer.from("RECONCILE_REJECT_STDERR"),
        Response: {},
      })).finish()),
    });
    client.fetchBeaconTask.mockResolvedValueOnce(fetched);

    const internals = registry as unknown as {
      windows: Map<number, {
        operationEngine?: OperationEngine;
        operationReconcileInFlight?: Promise<void>;
      }>;
    };
    const context = internals.windows.get(1);
    await context?.operationReconcileInFlight;
    if (!context?.operationEngine) throw new Error("Expected an operation engine");
    vi.spyOn(context.operationEngine, "reconcileTask")
      .mockRejectedValueOnce(new Error("journal reconciliation rejected"));

    const originalBufferFrom = Buffer.from.bind(Buffer);
    const decodedCopies: Buffer[] = [];
    const bufferFrom = vi.spyOn(Buffer, "from").mockImplementation(((...args: Parameters<typeof Buffer.from>) => {
      const created = originalBufferFrom(...args);
      const text = created.toString("utf8");
      if (text === "RECONCILE_REJECT_STDOUT" || text === "RECONCILE_REJECT_STDERR") {
        decodedCopies.push(created);
      }
      return created;
    }) as typeof Buffer.from);
    try {
      await expect(registry.getExecutionResult(1, { requestId: submitted.requestId })).resolves.toMatchObject({
        ok: true,
        value: { state: "outcome-unknown", taskId },
      });
    } finally {
      bufferFrom.mockRestore();
    }
    expect(decodedCopies.filter((copy) => copy.every((byte) => byte === 0))).toHaveLength(2);
    expect(fetched.Response.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    { label: "description mismatch", description: "RunAsReq", fetchedId: "same", response: "valid" },
    { label: "task ID mismatch", description: "ExecuteReq", fetchedId: "other", response: "valid" },
    { label: "malformed response", description: "ExecuteReq", fetchedId: "same", response: "malformed" },
  ] as const)("quarantines a completed beacon action with $label as outcome-unknown", async ({
    description,
    fetchedId,
    response,
  }) => {
    const client = new FakeSliverClient();
    client.beaconState.Beacons = [beacon("beacon_m4_uncertain", "m4-uncertain")];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const submitted = await submitBeaconProcess(registry, 1);
    const taskId = submitted.taskId;
    if (!taskId) throw new Error("Expected a submitted beacon task");
    completeFakeTaskSummary(client, "beacon_m4_uncertain", taskId, description);
    const fetched = clientpb.BeaconTask.create({
      ID: fetchedId === "same" ? taskId : "task_other_M4_SECRET",
      BeaconID: "beacon_m4_uncertain",
      State: "completed",
      Description: description,
      Request: Buffer.from("M4_UNCERTAIN_REQUEST_SECRET"),
      Response: response === "valid"
        ? Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
            Stdout: Buffer.from("must-not-be-retained"),
            Response: {},
          })).finish())
        : Buffer.from([0xff, 0xff, 0xff, 0x7f]),
    });
    client.fetchBeaconTask.mockResolvedValueOnce(fetched);

    const uncertain = await registry.getExecutionResult(1, { requestId: submitted.requestId });
    expect(uncertain).toMatchObject({
      ok: true,
      value: {
        state: "outcome-unknown",
        taskId,
        message: "The beacon task completed, but its exact execution result could not be confirmed safely.",
      },
    });
    expect(JSON.stringify(uncertain)).not.toMatch(/M4_SECRET|must-not-be-retained|UNCERTAIN_REQUEST/u);
    expect(fetched.Request.every((byte) => byte === 0)).toBe(true);
    expect(fetched.Response.every((byte) => byte === 0)).toBe(true);
  });

  it("decodes submitted children and privilege reads into bounded pages without redispatch", async () => {
    const childrenClient = new FakeSliverClient();
    childrenClient.beaconState.Beacons = [beacon("beacon_m4_children", "m4-children")];
    const childrenRegistry = createRegistry(() => childrenClient.adapter);
    childrenRegistry.registerWindow(1);
    await connectSaved(childrenRegistry, 1);
    await selectOnlyBeacon(childrenRegistry, 1);

    const submittedChildren = await childrenRegistry.runExecutionRead(1, {
      operationId: "execution.children",
      limit: 1,
    });
    if (!submittedChildren.ok || submittedChildren.value.state !== "submitted") {
      throw new Error("Expected submitted children task");
    }
    const childrenTaskId = submittedChildren.value.taskId;
    if (!childrenTaskId) throw new Error("Expected children task ID");
    completeFakeTaskSummary(childrenClient, "beacon_m4_children", childrenTaskId, "ExecuteChildrenReq", Buffer.from(
      sliverpb.ExecuteChildren.encode(sliverpb.ExecuteChildren.create({
        Children: [
          { Pid: 101, Path: "/usr/bin/one", Args: ["a"], StartTime: "2000000000", Exited: true, ExitCode: 0 },
          { Pid: 102, Path: "/usr/bin/two", Args: ["b"], StartTime: "2000000001", Exited: false },
          { Pid: 103, Path: "/usr/bin/three", Args: ["c"], StartTime: "2000000002", Exited: false },
        ],
        Response: {},
      })).finish(),
    ));

    const firstChildrenPage = await childrenRegistry.runExecutionRead(1, {
      operationId: "execution.children",
      taskId: childrenTaskId,
      limit: 1,
    });
    expect(firstChildrenPage).toMatchObject({
      ok: true,
      value: {
        state: "completed",
        taskId: childrenTaskId,
        items: [{ pid: 101, path: "/usr/bin/one" }],
        total: 3,
        nextCursor: `execution-read:v2:execution.children:${childrenTaskId}:1`,
        truncated: true,
      },
    });
    if (!firstChildrenPage.ok || firstChildrenPage.value.operationId !== "execution.children") {
      throw new Error("Expected decoded children page");
    }
    const nextChildrenCursor = firstChildrenPage.value.nextCursor;
    if (!nextChildrenCursor) throw new Error("Expected another children page");
    const secondChildrenPage = await childrenRegistry.runExecutionRead(1, {
      operationId: "execution.children",
      taskId: childrenTaskId,
      cursor: nextChildrenCursor,
      limit: 1,
    });
    expect(secondChildrenPage).toMatchObject({
      ok: true,
      value: { taskId: childrenTaskId, items: [{ pid: 102, path: "/usr/bin/two" }], total: 3 },
    });
    expect(childrenClient.executeChildrenBeacon).toHaveBeenCalledOnce();

    const privilegesClient = new FakeSliverClient();
    const windowsBeacon = beacon("beacon_m4_privs", "m4-privs");
    windowsBeacon.OS = "windows";
    windowsBeacon.Arch = "amd64";
    privilegesClient.beaconState.Beacons = [windowsBeacon];
    const privilegesRegistry = createRegistry(() => privilegesClient.adapter);
    privilegesRegistry.registerWindow(2);
    await connectSaved(privilegesRegistry, 2);
    await selectOnlyBeacon(privilegesRegistry, 2);

    const submittedPrivileges = await privilegesRegistry.runExecutionRead(2, {
      operationId: "privilege.get",
      limit: 1,
    });
    if (!submittedPrivileges.ok || submittedPrivileges.value.state !== "submitted") {
      throw new Error("Expected submitted privileges task");
    }
    const privilegeTaskId = submittedPrivileges.value.taskId;
    if (!privilegeTaskId) throw new Error("Expected privilege task ID");
    completeFakeTaskSummary(privilegesClient, "beacon_m4_privs", privilegeTaskId, "GetPrivsReq", Buffer.from(
      sliverpb.GetPrivs.encode(sliverpb.GetPrivs.create({
        ProcessName: "implant.exe",
        ProcessIntegrity: "High",
        PrivInfo: [
          { Name: "SeDebugPrivilege", Description: "Debug programs", Enabled: true },
          { Name: "SeImpersonatePrivilege", Description: "Impersonate clients", Enabled: true },
        ],
        Response: {},
      })).finish(),
    ));

    const firstPrivilegePage = await privilegesRegistry.runExecutionRead(2, {
      operationId: "privilege.get",
      taskId: privilegeTaskId,
      limit: 1,
    });
    expect(firstPrivilegePage).toMatchObject({
      ok: true,
      value: {
        state: "completed",
        taskId: privilegeTaskId,
        processName: "implant.exe",
        processIntegrity: "High",
        privileges: [{ name: "SeDebugPrivilege", enabled: true }],
        total: 2,
        nextCursor: `execution-read:v2:privilege.get:${privilegeTaskId}:1`,
        truncated: true,
      },
    });
    if (!firstPrivilegePage.ok || firstPrivilegePage.value.operationId !== "privilege.get") {
      throw new Error("Expected decoded privilege page");
    }
    const nextPrivilegeCursor = firstPrivilegePage.value.nextCursor;
    if (!nextPrivilegeCursor) throw new Error("Expected another privilege page");
    const secondPrivilegePage = await privilegesRegistry.runExecutionRead(2, {
      operationId: "privilege.get",
      taskId: privilegeTaskId,
      cursor: nextPrivilegeCursor,
      limit: 1,
    });
    expect(secondPrivilegePage).toMatchObject({
      ok: true,
      value: {
        taskId: privilegeTaskId,
        privileges: [{ name: "SeImpersonatePrivilege", enabled: true }],
        total: 2,
      },
    });
    expect(privilegesClient.getPrivsBeacon).toHaveBeenCalledOnce();
  });

  it("denies cross-operation beacon task refresh without dispatching another read", async () => {
    const client = new FakeSliverClient();
    const windowsBeacon = beacon("beacon_m4_cross", "m4-cross");
    windowsBeacon.OS = "windows";
    windowsBeacon.Arch = "amd64";
    client.beaconState.Beacons = [windowsBeacon];
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    await selectOnlyBeacon(registry, 1);

    const children = await registry.runExecutionRead(1, { operationId: "execution.children", limit: 1 });
    const privileges = await registry.runExecutionRead(1, { operationId: "privilege.get", limit: 1 });
    if (!children.ok || children.value.state !== "submitted" ||
      !privileges.ok || privileges.value.state !== "submitted") {
      throw new Error("Expected two submitted read tasks");
    }
    const childrenTaskId = children.value.taskId;
    const privilegeTaskId = privileges.value.taskId;
    if (!childrenTaskId || !privilegeTaskId) throw new Error("Expected exact read task IDs");

    await expect(registry.runExecutionRead(1, {
      operationId: "execution.children",
      taskId: privilegeTaskId,
      limit: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/execution result is unavailable for the current target/i),
    });
    await expect(registry.runExecutionRead(1, {
      operationId: "privilege.get",
      taskId: childrenTaskId,
      limit: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/execution result is unavailable for the current target/i),
    });
    expect(client.executeChildrenBeacon).toHaveBeenCalledOnce();
    expect(client.getPrivsBeacon).toHaveBeenCalledOnce();
    expect(client.fetchBeaconTask).not.toHaveBeenCalled();
  });

  it("rejects an identity review when the exact selected session changes during token-owner verification", async () => {
    const client = new FakeSliverClient();
    const first = session("session_identity_a", "identity-a");
    const second = session("session_identity_b", "identity-b");
    first.OS = second.OS = "windows";
    first.Arch = second.Arch = "amd64";
    client.sessionState.Sessions = [first, second];
    const identityGate = deferred<sliverpb.CurrentTokenOwner>();
    client.currentTokenOwnerSession.mockImplementationOnce(async () => identityGate.promise);
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const selectable = registry.snapshot(1).targetContext.selectableTargets.filter(({ mode }) => mode === "session");
    const firstRef = selectable.find(({ id }) => id === first.ID);
    const secondRef = selectable.find(({ id }) => id === second.ID);
    if (!firstRef || !secondRef) throw new Error("Expected two Windows sessions");
    await registry.selectTarget(1, firstRef);
    const password = Uint8Array.from(Buffer.from("review-secret", "utf8"));
    const pending = registry.prepareExecutionAction(sender(1), {
      draft: {
        operationId: "privilege.make-token",
        username: "operator",
        domain: "LAB",
        password,
        logonType: "interactive",
        timeoutSeconds: 60,
      },
    });
    await vi.waitFor(() => expect(client.currentTokenOwnerSession).toHaveBeenCalledOnce());
    await registry.selectTarget(1, secondRef);
    identityGate.resolve(sliverpb.CurrentTokenOwner.create({ Output: "LAB\\old-token" }));
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/selected target changed/u),
    });
    expect([...password]).toEqual(new Array(password.length).fill(0));
  });

  it("binds Psexec upload and service execution to one generated remote executable", async () => {
    const client = new FakeSliverClient();
    const windowsSession = session("session_psexec_m4", "psexec-m4");
    windowsSession.OS = "windows";
    windowsSession.Arch = "amd64";
    client.sessionState.Sessions = [windowsSession];
    const executablePath = join(externalDirectory, "review-service.exe");
    await writeFile(executablePath, "reviewed-service-binary");
    electronMocks.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [executablePath] });
    const registry = createRegistry(() => client.adapter);
    registry.registerWindow(1);
    await connectSaved(registry, 1);
    const target = registry.snapshot(1).targetContext.selectableTargets.find(({ mode }) => mode === "session");
    if (!target) throw new Error("Expected a Windows session");
    await registry.selectTarget(1, target);
    const prepared = await registry.prepareExecutionAction(sender(1), {
      draft: {
        operationId: "execution.psexec",
        hostname: "workstation.example",
        serviceName: "TelemetryReview",
        serviceDescription: "Telemetry review service",
        remotePath: "C:\\Windows\\Temp",
        source: { kind: "native-file" },
        timeoutSeconds: 180,
      },
    });
    if (!prepared.ok) throw new Error(prepared.error);

    vi.useFakeTimers();
    try {
      const execution = registry.executeExecutionPlan(1, { token: prepared.value.token });
      await vi.waitFor(() => expect(client.uploadSession).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(execution).resolves.toMatchObject({
        ok: true,
        value: {
          state: "completed",
          message: expect.stringMatching(/uploaded executable remains/u),
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(client.startRemoteServiceSession).toHaveBeenCalledOnce();
    expect(client.removeRemoteServiceSession).toHaveBeenCalledOnce();
    const uploadedPath = client.uploadSession.mock.calls.at(-1)?.[1];
    const serviceOptions = client.startRemoteServiceSession.mock.calls.at(-1)?.[1];
    expect(serviceOptions?.binaryPath).toMatch(/^C:\\Windows\\Temp\\sliver-[a-f0-9]{12}\.exe$/u);
    expect(uploadedPath).toBe(
      `\\\\workstation.example\\C$${serviceOptions?.binaryPath.slice(2)}`,
    );
    expect(client.uploadSession.mock.calls.at(-1)?.[2].every((byte) => byte === 0)).toBe(true);
  });
});

describe("server compatibility and event redaction", () => {
  it("matches the semantic-version major/minor series regardless of patch or build provenance", () => {
    for (const compatible of [
      version({ Patch: 0, Commit: "" }),
      version({ Patch: 7, Commit: "different" }),
      version({ Patch: 999, Commit: "modified", Dirty: true }),
    ]) {
      expect(negotiateServerVersion(compatible)).toEqual({ compatibility: "supported" });
    }
  });

  it("warns for valid versions outside the compatible semantic-version series", () => {
    for (const incompatible of [
      version({ Major: 0, Minor: 0, Patch: 0 }),
      version({ Minor: 6 }),
      version({ Minor: 8 }),
      version({ Major: 2, Minor: 7 }),
      version({ Major: 2, Minor: 7, Commit: SLIVER_PROTOCOL_BASELINE_COMMIT }),
    ]) {
      expect(negotiateServerVersion(incompatible)).toMatchObject({
        compatibility: "degraded",
        reason: expect.stringMatching(/outside the compatible 1\.7\.x version series/u),
      });
    }
  });

  it("rejects invalid semantic-version components", () => {
    for (const invalid of [
      version({ Major: -1 }),
      version({ Minor: 1.5 }),
      version({ Patch: Number.NaN }),
      version({ Patch: Number.POSITIVE_INFINITY }),
    ]) {
      expect(negotiateServerVersion(invalid)).toEqual({
        compatibility: "unsupported",
        reason: "The server reported an invalid version",
      });
    }
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
  lootState: clientpb.Loot[] = [];
  credentialState: clientpb.Credential[] = [];
  compilerState = clientpb.Compiler.create({ Targets: [], UnsupportedTargets: [] });
  sessionState = clientpb.Sessions.create({ Sessions: [] });
  beaconState = clientpb.Beacons.create({ Beacons: [] });
  operatorState = clientpb.Operators.create({ Operators: [] });
  taskState = new Map<string, clientpb.BeaconTask[]>();
  environmentState = new Map<string, string>();
  private nextTaskId = 1;
  nextJobsError: Error | undefined;
  nextJobsPromise: Promise<clientpb.Job[]> | undefined;
  nextProfilesError: Error | undefined;
  nextProfilesPromise: Promise<clientpb.ImplantProfiles> | undefined;
  nextSessionsPromise: Promise<clientpb.Sessions> | undefined;
  nextBeaconsPromise: Promise<clientpb.Beacons> | undefined;
  nextShellSession: FakeShellSession | undefined;
  lastUploadData: Buffer | undefined;

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
  readonly getSessions = vi.fn(async () => {
    if (this.nextSessionsPromise) {
      const promise = this.nextSessionsPromise;
      this.nextSessionsPromise = undefined;
      return clientpb.Sessions.create(await promise);
    }
    return clientpb.Sessions.create(this.sessionState);
  });
  readonly getBeacons = vi.fn(async () => {
    if (this.nextBeaconsPromise) {
      const promise = this.nextBeaconsPromise;
      this.nextBeaconsPromise = undefined;
      return clientpb.Beacons.create(await promise);
    }
    return clientpb.Beacons.create(this.beaconState);
  });
  readonly getOperators = vi.fn(async () => clientpb.Operators.create(this.operatorState));
  readonly renameSession = vi.fn(async (sessionId: string, name: string) => {
    const session = this.sessionState.Sessions.find((candidate) => candidate.ID === sessionId);
    if (session) session.Name = name;
    return {};
  });
  readonly renameBeacon = vi.fn(async (beaconId: string, name: string) => {
    const beacon = this.beaconState.Beacons.find((candidate) => candidate.ID === beaconId);
    if (beacon) beacon.Name = name;
    return {};
  });
  readonly pingSession = vi.fn(async (_sessionId: string, nonce: number) => sliverpb.Ping.create({ Nonce: nonce }));
  readonly pingBeacon = vi.fn(async (beaconId: string, nonce: number) =>
    this.queueBeaconTask(beaconId, "Ping", sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: nonce })).finish(), nonce),
  );
  readonly getEnvSession = vi.fn(async (_sessionId: string, name = "") => sliverpb.EnvInfo.create({
    Variables: [...this.environmentState]
      .filter(([key]) => !name || key === name)
      .map(([Key, Value]) => ({ Key, Value })),
  }));
  readonly currentTokenOwnerSession = vi.fn(async () => sliverpb.CurrentTokenOwner.create({ Output: "DOMAIN\\operator-user" }));
  readonly currentTokenOwnerBeacon = vi.fn(async () => ({ Output: "DOMAIN\\operator-user" }));
  readonly executeSession = vi.fn(async () => ({
    Stdout: Buffer.from("m4-stdout"),
    Stderr: Buffer.from("m4-stderr"),
    Pid: 6_001,
    Response: { Err: "" },
  }));
  readonly executeBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "ExecuteReq",
    Buffer.alloc(0),
  ));
  readonly executeChildrenSession = vi.fn(async () => ({ Children: [], Response: { Err: "" } }));
  readonly executeChildrenBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "ExecuteChildrenReq",
    Buffer.alloc(0),
  ));
  readonly getPrivsSession = vi.fn(async () => ({
    ProcessName: "implant",
    ProcessIntegrity: "high",
    PrivInfo: [],
    Response: { Err: "" },
  }));
  readonly getPrivsBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "GetPrivsReq",
    Buffer.alloc(0),
  ));
  readonly runAsSession = vi.fn(async () => ({ Output: "run-as-ok", Response: { Err: "" } }));
  readonly runAsBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "RunAsReq",
    Buffer.alloc(0),
  ));
  readonly startRemoteServiceSession = vi.fn(async (
    _sessionId: string,
    _options: {
      hostname: string;
      serviceName: string;
      serviceDescription: string;
      binaryPath: string;
      args?: string;
    },
  ) => ({ Response: { Err: "" } }));
  readonly removeRemoteServiceSession = vi.fn(async (
    _sessionId: string,
    _options: { hostname: string; serviceName: string },
  ) => ({ Response: { Err: "" } }));
  readonly listEnvSession = vi.fn(async (sessionId: string) => this.getEnvSession(sessionId, ""));
  readonly revealEnvSession = vi.fn(async (sessionId: string, name: string) => this.getEnvSession(sessionId, name));
  readonly pwdSession = vi.fn(async () => sliverpb.Pwd.create({ Path: "/tmp" }));
  readonly lsSession = vi.fn(async (_sessionId: string, path: string) => sliverpb.Ls.create({
    Path: path,
    Exists: true,
    Files: [{ Name: "example.txt", Size: "7", ModTime: "0", Mode: "-rw-------", IsDir: false }],
  }));
  readonly mkdirSession = vi.fn(async (_sessionId: string, path: string) => sliverpb.Mkdir.create({ Path: path }));
  readonly rmSession = vi.fn(async (_sessionId: string, path: string) => sliverpb.Rm.create({ Path: path }));
  readonly screenshotSession = vi.fn(async () => sliverpb.Screenshot.create({
    Data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
  }));
  readonly processDumpSession = vi.fn(async () => sliverpb.ProcessDump.create({
    Data: Buffer.from("process-dump"),
  }));
  readonly startServiceSession = vi.fn(async () => sliverpb.ServiceInfo.create({}));
  readonly serviceDetailSession = vi.fn(async (_sessionId: string, name: string) => sliverpb.ServiceDetail.create({
    Detail: {
      Name: name,
      DisplayName: name,
      Description: "Test service",
      Status: 4,
      StartupType: 2,
      BinPath: "C:\\Windows\\service.exe",
      Account: "LocalSystem",
    },
  }));
  readonly uploadSession = vi.fn(async (_sessionId: string, path: string, data: Buffer) => {
    this.lastUploadData = Buffer.from(data);
    return sliverpb.Upload.create({ Path: path });
  });
  readonly downloadFileSession = vi.fn(async (_sessionId: string, path: string) => sliverpb.Download.create({
    Exists: true,
    IsDir: false,
    Path: path,
    Data: Buffer.from("download"),
  }));
  readonly psSession = vi.fn(async () => sliverpb.Ps.create({
    Processes: [{
      Pid: 4242,
      Ppid: 1,
      Executable: "/tmp/original",
      Owner: "operator",
      Architecture: "arm64",
      CmdLine: ["/tmp/original", "--session"],
    }],
  }));
  readonly terminateSessionProcess = vi.fn(async () => sliverpb.Terminate.create({}));
  readonly startShellSession = vi.fn(async () => {
    const shell = this.nextShellSession ?? new FakeShellSession();
    this.nextShellSession = undefined;
    return shell;
  });
  readonly setEnvSession = vi.fn(async (_sessionId: string, name: string, value: string) => {
    this.environmentState.set(name, value);
    return sliverpb.SetEnv.create({});
  });
  readonly setEnvBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "SetEnvReq",
    sliverpb.SetEnv.encode(sliverpb.SetEnv.create({})).finish(),
  ));
  readonly unsetEnvSession = vi.fn(async (_sessionId: string, name: string) => {
    this.environmentState.delete(name);
    return sliverpb.UnsetEnv.create({});
  });
  readonly unsetEnvBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "UnsetEnvReq",
    sliverpb.UnsetEnv.encode(sliverpb.UnsetEnv.create({})).finish(),
  ));
  readonly reconfigureBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "ReconfigureReq",
    sliverpb.Reconfigure.encode(sliverpb.Reconfigure.create({})).finish(),
  ));
  readonly openSessionFromBeacon = vi.fn(async (beaconId: string) => this.queueBeaconTask(
    beaconId,
    "OpenSession",
    Buffer.alloc(0),
  ));
  readonly killSession = vi.fn(async (sessionId: string) => {
    this.sessionState.Sessions = this.sessionState.Sessions.filter((candidate) => candidate.ID !== sessionId);
    return {};
  });
  readonly killBeacon = vi.fn(async () => ({}));
  readonly closeSession = vi.fn(async (sessionId: string) => {
    this.sessionState.Sessions = this.sessionState.Sessions.filter((candidate) => candidate.ID !== sessionId);
    return {};
  });
  readonly getBeaconTasks = vi.fn(async (beaconId: string) => clientpb.BeaconTasks.create({
    Tasks: (this.taskState.get(beaconId) ?? []).map((task) => clientpb.BeaconTask.create({
      ...task,
      Request: Buffer.alloc(0),
      Response: Buffer.alloc(0),
    })),
  }));
  readonly fetchBeaconTask = vi.fn(async (taskId: string) => {
    const task = [...this.taskState.values()].flat().find((candidate) => candidate.ID === taskId);
    if (!task) throw new Error("unknown fake task");
    return clientpb.BeaconTask.create({
      ...task,
      Request: Buffer.from(task.Request),
      Response: Buffer.from(task.Response),
    });
  });
  readonly cancelBeaconTask = vi.fn(async (taskId: string) => {
    const task = [...this.taskState.values()].flat().find((candidate) => candidate.ID === taskId);
    if (!task) throw new Error("unknown fake task");
    task.State = "canceled";
    return clientpb.BeaconTask.create({
      ...task,
      Request: Buffer.from(task.Request),
      Response: Buffer.from(task.Response),
    });
  });
  readonly rmBeacon = vi.fn(async (beaconId: string) => {
    this.beaconState.Beacons = this.beaconState.Beacons.filter((candidate) => candidate.ID !== beaconId);
    this.taskState.delete(beaconId);
  });
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
  readonly lootAll = vi.fn(async () => this.lootState.map((item) => clientpb.Loot.create({
    ...item,
    ...(item.File ? { File: { ...item.File, Data: Buffer.alloc(0) } } : {}),
  })));
  readonly lootAdd = vi.fn(async (loot: clientpb.Loot) => {
    const stored = clientpb.Loot.create({
      ...loot,
      ID: randomUUID(),
      Size: String(loot.File?.Data.byteLength ?? 0),
      File: loot.File ? { ...loot.File, Data: Buffer.from(loot.File.Data) } : undefined,
    });
    this.lootState.push(stored);
    return clientpb.Loot.create({
      ...stored,
      File: stored.File ? { ...stored.File, Data: Buffer.from(stored.File.Data) } : undefined,
    });
  });
  readonly lootUpdate = vi.fn(async (loot: clientpb.Loot) => {
    const current = this.lootState.find((item) => item.ID === loot.ID);
    if (!current) throw new Error("unknown fake loot");
    current.Name = loot.Name;
    return clientpb.Loot.create({ ...current, File: undefined });
  });
  readonly lootRemove = vi.fn(async (lootId: string) => {
    this.lootState = this.lootState.filter((item) => item.ID !== lootId);
  });
  readonly lootContent = vi.fn(async (lootId: string) => {
    const current = this.lootState.find((item) => item.ID === lootId);
    if (!current) throw new Error("unknown fake loot");
    return clientpb.Loot.create({
      ...current,
      File: current.File ? { ...current.File, Data: Buffer.from(current.File.Data) } : undefined,
    });
  });
  readonly credentialsAll = vi.fn(async () => this.credentialState.map((item) => clientpb.Credential.create(item)));
  readonly credentialById = vi.fn(async (credentialId: string) => {
    const current = this.credentialState.find((item) => item.ID === credentialId);
    if (!current) throw new Error("unknown fake credential");
    return clientpb.Credential.create(current);
  });
  readonly credentialAdd = vi.fn(async (credential: clientpb.Credential) => {
    this.credentialState.push(clientpb.Credential.create({ ...credential, ID: randomUUID() }));
  });
  readonly credentialRemove = vi.fn(async (credentialId: string) => {
    this.credentialState = this.credentialState.filter((item) => item.ID !== credentialId);
  });
  readonly credentialSniffHashType = vi.fn(async (hash: string) => (
    /^[0-9a-f]{32}$/iu.test(hash) ? clientpb.HashType.MD5 : clientpb.HashType.INVALID
  ));

  readonly adapter = {
    connect: this.connect,
    disconnect: this.disconnect,
    getVersion: this.getVersion,
    jobs: this.jobs,
    implantBuilds: this.implantBuilds,
    implantProfiles: this.implantProfiles,
    getCompiler: this.getCompiler,
    getSessions: this.getSessions,
    getBeacons: this.getBeacons,
    getOperators: this.getOperators,
    renameSession: this.renameSession,
    renameBeacon: this.renameBeacon,
    pingSession: this.pingSession,
    pingBeacon: this.pingBeacon,
    getEnvSession: this.getEnvSession,
    currentTokenOwnerSession: this.currentTokenOwnerSession,
    currentTokenOwnerBeacon: this.currentTokenOwnerBeacon,
    executeSession: this.executeSession,
    executeBeacon: this.executeBeacon,
    executeChildrenSession: this.executeChildrenSession,
    executeChildrenBeacon: this.executeChildrenBeacon,
    getPrivsSession: this.getPrivsSession,
    getPrivsBeacon: this.getPrivsBeacon,
    runAsSession: this.runAsSession,
    runAsBeacon: this.runAsBeacon,
    startRemoteServiceSession: this.startRemoteServiceSession,
    removeRemoteServiceSession: this.removeRemoteServiceSession,
    listEnvSession: this.listEnvSession,
    revealEnvSession: this.revealEnvSession,
    pwdSession: this.pwdSession,
    lsSession: this.lsSession,
    mkdirSession: this.mkdirSession,
    rmSession: this.rmSession,
    screenshotSession: this.screenshotSession,
    processDumpSession: this.processDumpSession,
    startServiceSession: this.startServiceSession,
    serviceDetailSession: this.serviceDetailSession,
    uploadSession: this.uploadSession,
    downloadFileSession: this.downloadFileSession,
    psSession: this.psSession,
    terminateSessionProcess: this.terminateSessionProcess,
    startShellSession: this.startShellSession,
    setEnvSession: this.setEnvSession,
    setEnvBeacon: this.setEnvBeacon,
    unsetEnvSession: this.unsetEnvSession,
    unsetEnvBeacon: this.unsetEnvBeacon,
    reconfigureBeacon: this.reconfigureBeacon,
    openSessionFromBeacon: this.openSessionFromBeacon,
    killSession: this.killSession,
    killBeacon: this.killBeacon,
    closeSession: this.closeSession,
    getBeaconTasks: this.getBeaconTasks,
    fetchBeaconTask: this.fetchBeaconTask,
    cancelBeaconTask: this.cancelBeaconTask,
    rmBeacon: this.rmBeacon,
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
    lootAll: this.lootAll,
    lootAdd: this.lootAdd,
    lootUpdate: this.lootUpdate,
    lootRemove: this.lootRemove,
    lootContent: this.lootContent,
    credentialsAll: this.credentialsAll,
    credentialById: this.credentialById,
    credentialAdd: this.credentialAdd,
    credentialRemove: this.credentialRemove,
    credentialSniffHashType: this.credentialSniffHashType,
    event$: this.events.asObservable(),
    eventStreamState$: this.streamStates.asObservable(),
  } as unknown as SliverClientAdapter;

  private addListener(protocol: string, _host: string, port: number): clientpb.ListenerJob {
    const id = Math.max(0, ...this.jobState.map((item) => item.ID)) + 1;
    this.jobState.push(job(id, port, protocol));
    return clientpb.ListenerJob.create({ JobID: id });
  }

  private queueBeaconTask(
    beaconId: string,
    description: string,
    responseBytes: Uint8Array,
    nonce?: number,
  ) {
    const id = `task_${this.nextTaskId++}`;
    const task = clientpb.BeaconTask.create({
      ID: id,
      BeaconID: beaconId,
      State: "pending",
      Description: description,
      CreatedAt: String(Math.floor(Date.now() / 1_000)),
      Request: Buffer.alloc(0),
      Response: Buffer.from(responseBytes),
    });
    const current = this.taskState.get(beaconId) ?? [];
    current.push(task);
    this.taskState.set(beaconId, current);
    return {
      ...(description === "Ping" ? { Nonce: nonce ?? 0 } : {}),
      Response: { Async: true, BeaconID: beaconId, TaskID: id, Err: "" },
    };
  }
}

class FakeShellOutput implements AsyncIterable<Uint8Array> {
  private readonly queued: Uint8Array[] = [];
  private readonly waiters: Array<(value: Uint8Array | undefined) => void> = [];
  private ended = false;

  constructor(initial?: Uint8Array) {
    if (initial) this.queued.push(initial);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const resolve of this.waiters.splice(0)) resolve(undefined);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const queued = this.queued.shift();
      if (queued) {
        yield queued;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<Uint8Array | undefined>((resolve) => this.waiters.push(resolve));
      if (!next) return;
      yield next;
    }
  }
}

class FakeShellSession {
  readonly id = "main-only-tunnel-id";
  readonly pid = 7_733;
  readonly path = "/bin/bash";
  readonly ptyRequested = true;
  readonly output: FakeShellOutput;
  readonly write = vi.fn(async (_chunk: Uint8Array | string) => undefined);
  readonly resize = vi.fn(async (_rows: number, _columns: number) => undefined);
  readonly close = vi.fn(async () => this.output.close());

  constructor(initialOutput?: Uint8Array) {
    this.output = new FakeShellOutput(initialOutput);
  }
}

class FakeMessagePort extends EventEmitter {
  readonly frames: StreamServerFrame[] = [];
  closed = false;
  started = false;

  asElectronPort(): MessagePortMain {
    return this as unknown as MessagePortMain;
  }

  postMessage(frame: StreamServerFrame): void {
    if (this.closed) throw new Error("port closed");
    this.frames.push(structuredClone(frame));
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  send(frame: StreamClientFrame): void {
    this.emit("message", { data: frame });
  }

  last<T extends StreamServerFrame["type"]>(type: T): Extract<StreamServerFrame, { type: T }> | undefined {
    return this.frames.findLast(
      (frame): frame is Extract<StreamServerFrame, { type: T }> => frame.type === type,
    );
  }
}

async function openRegistryShell(
  registry: ConnectionRegistry,
  contentsId: number,
  rendererProcessId: number,
  rendererFrameToken: string,
  input: PrepareSessionShellInput,
): Promise<{ plan: SessionShellPlan; port: FakeMessagePort }> {
  const prepared = await registry.prepareSessionShell(
    contentsId,
    rendererProcessId,
    rendererFrameToken,
    input,
  );
  if (!prepared.ok) throw new Error(prepared.error);
  const port = new FakeMessagePort();
  registry.attachStream(contentsId, rendererProcessId, rendererFrameToken, {
    v: STREAM_PROTOCOL_VERSION,
    attachmentToken: prepared.value.attachment.attachmentToken,
  }, port.asElectronPort());
  const ready = port.last("ready");
  if (!ready) throw new Error("Expected ready frame");
  port.send({
    v: STREAM_PROTOCOL_VERSION,
    type: "start",
    streamId: ready.streamId,
    receiveCreditBytes: 64 * 1_024,
  });
  await vi.waitFor(() => expect(port.last("opened")).toBeDefined());
  return { plan: prepared.value, port };
}

function terminalRuntimeAsset(): TerminalRuntimeAsset {
  return {
    version: "0.4.0",
    sha256: "a".repeat(64),
    bytes: Uint8Array.from([0, 97, 115, 109]),
  };
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

async function selectOnlyBeacon(registry: ConnectionRegistry, contentsId: number): Promise<void> {
  const target = registry.snapshot(contentsId).targetContext.selectableTargets.find(({ mode }) => mode === "beacon");
  if (!target) throw new Error("Expected a selectable beacon");
  const selected = await registry.selectTarget(contentsId, target);
  if (!selected.ok) throw new Error(selected.error);
}

async function submitBeaconProcess(registry: ConnectionRegistry, contentsId: number) {
  const prepared = await registry.prepareExecutionAction(sender(contentsId), {
    draft: {
      operationId: "execution.process",
      path: "/usr/bin/id",
      args: ["-u"],
      captureOutput: true,
      background: false,
      inheritEnvironment: true,
      environment: [],
      useToken: false,
      hideWindow: false,
      timeoutSeconds: 60,
    },
  });
  if (!prepared.ok) throw new Error(prepared.error);
  const submitted = await registry.executeExecutionPlan(contentsId, { token: prepared.value.token });
  if (!submitted.ok || submitted.value.state !== "submitted") {
    throw new Error("Expected a submitted beacon process");
  }
  return submitted.value;
}

function completeFakeTaskSummary(
  client: FakeSliverClient,
  beaconId: string,
  taskId: string,
  description: string,
  response?: Buffer,
): clientpb.BeaconTask {
  const task = client.taskState.get(beaconId)?.find((candidate) => candidate.ID === taskId);
  if (!task) throw new Error("Expected fake beacon task");
  task.State = "completed";
  task.Description = description;
  if (response) task.Response = Buffer.from(response);
  task.SentAt = task.SentAt || String(Math.floor(Date.now() / 1_000));
  task.CompletedAt = String(Math.floor(Date.now() / 1_000));
  return task;
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

async function stageTextArtifact(
  registry: ConnectionRegistry,
  contentsId: number,
  content: string,
): Promise<SessionStoredArtifact> {
  const staged = await registry.runSessionWorkbench(sender(contentsId), {
    operationId: "session.filesystem.stage-text",
    content,
    encoding: "utf-8",
  });
  if (
    !staged.ok || staged.value.status !== "completed" ||
    staged.value.result.operationId !== "session.filesystem.stage-text"
  ) throw new Error("Expected staged text artifact");
  return staged.value.result.value.artifact;
}

async function stageHexArtifact(
  registry: ConnectionRegistry,
  contentsId: number,
  hex: string,
): Promise<SessionStoredArtifact> {
  const staged = await registry.runSessionWorkbench(sender(contentsId), {
    operationId: "session.filesystem.stage-hex",
    hex,
  });
  if (
    !staged.ok || staged.value.status !== "completed" ||
    staged.value.result.operationId !== "session.filesystem.stage-hex"
  ) throw new Error("Expected staged hex artifact");
  return staged.value.result.value.artifact;
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
  return {
    id,
    isDestroyed: () => false,
    getURL: () => "sliver://app/index.html",
    mainFrame: { processId: id, frameToken: `frame-${id}`, isDestroyed: () => false },
  } as unknown as WebContents;
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

function activeBeaconTasks(beaconId: string, count: number, idPrefix: string): clientpb.BeaconTask[] {
  const baseCreatedAt = 2_000_000_000;
  return Array.from({ length: count }, (_, index) => {
    const state = index % 2 === 0 ? "pending" : "sent";
    const createdAt = baseCreatedAt + index;
    return clientpb.BeaconTask.create({
      ID: `${idPrefix}_${String(index).padStart(4, "0")}`,
      BeaconID: beaconId,
      State: state,
      Description: "ExternalTask",
      CreatedAt: String(createdAt),
      SentAt: state === "sent" ? String(createdAt + 1) : "0",
      CompletedAt: "0",
      Request: Buffer.alloc(0),
      Response: Buffer.alloc(0),
    });
  });
}

function session(id: string, name: string): clientpb.Session {
  return clientpb.Session.create({
    ID: id,
    Name: name,
    Hostname: `${name}-host`,
    UUID: `${id}-host`,
    Username: "operator-user",
    OS: "darwin",
    Arch: "arm64",
    Transport: "mtls",
    RemoteAddress: "127.0.0.1:4444",
    ActiveC2: "mtls://127.0.0.1:8888?token=redacted",
    PID: 1234,
    FirstContact: String(Math.floor(Date.now() / 1_000) - 10),
    LastCheckin: String(Math.floor(Date.now() / 1_000)),
  });
}

function beacon(id: string, name: string): clientpb.Beacon {
  return clientpb.Beacon.create({
    ID: id,
    Name: name,
    Hostname: `${name}-host`,
    UUID: `${id}-host`,
    Username: "operator-user",
    OS: "darwin",
    Arch: "arm64",
    Transport: "https",
    RemoteAddress: "127.0.0.1:5555",
    ActiveC2: "https://127.0.0.1:9999?token=redacted",
    PID: 4321,
    FirstContact: String(Math.floor(Date.now() / 1_000) - 10),
    LastCheckin: String(Math.floor(Date.now() / 1_000)),
    NextCheckin: String(Math.floor(Date.now() / 1_000) + 60),
    Interval: "8000000000",
    Jitter: "0",
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
