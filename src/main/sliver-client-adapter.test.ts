// @vitest-environment node

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { clientpb, type SliverClient } from "sliver-script";

import {
  adaptSliverClient,
  BEACON_TEXT_READ_PROBE_BYTES,
  BEACON_TASK_CONTENT_REQUEST_MAX_BYTES,
  BEACON_TASK_CONTENT_RESPONSE_MAX_BYTES,
  BOF_TASK_RESPONSE_MAX_BYTES,
  type SliverClientAdapter,
} from "./sliver-client-adapter.js";

describe("SliverClientAdapter passive topology inventory", () => {
  it("reads service registries with bounded empty requests and no worker commands", async () => {
    const builders = vi.fn().mockResolvedValue({ Builders: [] });
    const crackstations = vi.fn().mockResolvedValue({ Crackstations: [] });
    const startBuild = vi.fn();
    const crackstationTrigger = vi.fn();
    const adapter = adaptSliverClient({ rpc: { builders, crackstations, startBuild, crackstationTrigger } } as unknown as SliverClient);

    await expect(adapter.getExternalBuilders!()).resolves.toEqual({ Builders: [] });
    await expect(adapter.getCrackstations!()).resolves.toEqual({ Crackstations: [] });

    expect(builders).toHaveBeenCalledExactlyOnceWith({}, { signal: expect.any(AbortSignal) });
    expect(crackstations).toHaveBeenCalledExactlyOnceWith({}, { signal: expect.any(AbortSignal) });
    expect(startBuild).not.toHaveBeenCalled();
    expect(crackstationTrigger).not.toHaveBeenCalled();
    expectTypeOf<SliverClientAdapter>().not.toHaveProperty("crackstationTrigger");
  });

  it("queries only the server pivot graph with an empty request and bounded signal", async () => {
    const graph = { Children: [] };
    const pivotGraph = vi.fn().mockResolvedValue(graph);
    const pivotSessionListeners = vi.fn();
    const interactSession = vi.fn();
    const interactBeacon = vi.fn();
    const client = { rpc: { pivotGraph, pivotSessionListeners }, interactSession, interactBeacon } as unknown as SliverClient;
    const adapter = adaptSliverClient(client);

    await expect(adapter.getPivotGraph!()).resolves.toBe(graph);

    expect(pivotGraph).toHaveBeenCalledExactlyOnceWith({}, { signal: expect.any(AbortSignal) });
    expect(pivotSessionListeners).not.toHaveBeenCalled();
    expect(interactSession).not.toHaveBeenCalled();
    expect(interactBeacon).not.toHaveBeenCalled();
    expectTypeOf<Parameters<NonNullable<SliverClientAdapter["getPivotGraph"]>>>().toEqualTypeOf<[]>();
    expectTypeOf<SliverClientAdapter>().not.toHaveProperty("rpc");
  });
});

describe("SliverClientAdapter beacon reads", () => {
  it("exposes only narrow enqueue wrappers and preserves the raw ls acknowledgement", async () => {
    const ls = vi.fn(async () => ({
      Response: { Async: true, BeaconID: "unexpected_beacon", TaskID: "ls_task" },
    }));
    const beacon = {
      pwd: vi.fn(async () => ({ Response: { Async: true, BeaconID: "beacon_1", TaskID: "pwd_task" } })),
      ps: vi.fn(async () => ({ Response: { Async: true, BeaconID: "beacon_1", TaskID: "ps_task" } })),
      ifconfig: vi.fn(async () => ({ Response: { Async: true, BeaconID: "beacon_1", TaskID: "ifconfig_task" } })),
    };
    const client = {
      interactBeacon: vi.fn(() => beacon),
      rpc: { ls },
    } as unknown as SliverClient;
    const adapter = adaptSliverClient(client);

    await expect(adapter.pwdBeacon("beacon_1", 30)).resolves.toMatchObject({
      Response: { TaskID: "pwd_task" },
    });
    await expect(adapter.lsBeacon("beacon_1", "/tmp", 60)).resolves.toMatchObject({
      Response: { Async: true, BeaconID: "unexpected_beacon", TaskID: "ls_task" },
    });
    await expect(adapter.psBeacon("beacon_1", true, 60)).resolves.toMatchObject({
      Response: { TaskID: "ps_task" },
    });
    await expect(adapter.ifconfigBeacon("beacon_1", 30)).resolves.toMatchObject({
      Response: { TaskID: "ifconfig_task" },
    });

    expect(beacon.pwd).toHaveBeenCalledWith(30);
    expect(ls).toHaveBeenCalledWith({
      Path: "/tmp",
      Request: {
        Async: true,
        Timeout: "59999999999",
        BeaconID: "beacon_1",
        SessionID: "",
      },
    }, { signal: expect.any(AbortSignal) });
    expect(beacon.ps).toHaveBeenCalledWith(true, 60);
    expect(beacon.ifconfig).toHaveBeenCalledWith(30);
    expect(client.interactBeacon).toHaveBeenCalledTimes(3);
  });

  it("keeps the broad interactive beacon object outside the reviewed adapter type", () => {
    expectTypeOf<SliverClientAdapter>().not.toHaveProperty("interactBeacon");
  });

  it("queues the M2 inventory reads through fixed beacon RPCs and preserves acknowledgements", async () => {
    const acknowledgement = { Response: { Async: true, BeaconID: "different", TaskID: "task-1" } };
    const getEnv = vi.fn(async () => acknowledgement);
    const currentTokenOwner = vi.fn(async () => acknowledgement);
    const netstat = vi.fn(async () => acknowledgement);
    const mount = vi.fn(async () => acknowledgement);
    const memfilesList = vi.fn(async () => acknowledgement);
    const interactBeacon = vi.fn();
    const adapter = adaptSliverClient({
      rpc: { getEnv, currentTokenOwner, netstat, mount, memfilesList }, interactBeacon,
    } as unknown as SliverClient);

    await expect(adapter.envBeacon("beacon-1", "", 30)).resolves.toBe(acknowledgement);
    await expect(adapter.envBeacon("beacon-1", "API_ENDPOINT", 30)).resolves.toBe(acknowledgement);
    await expect(adapter.whoamiBeacon("beacon-1", 30)).resolves.toBe(acknowledgement);
    await expect(adapter.netstatBeacon("beacon-1", {
      tcp: true, udp: false, ip4: true, ip6: false, listen: true,
    }, 30)).resolves.toBe(acknowledgement);
    await expect(adapter.mountBeacon("beacon-1", 30)).resolves.toBe(acknowledgement);
    await expect(adapter.memfilesBeacon("beacon-1", 30)).resolves.toBe(acknowledgement);

    const request = {
      Async: true, Timeout: "29999999999", BeaconID: "beacon-1", SessionID: "",
    };
    const callOptions = { signal: expect.any(AbortSignal) };
    expect(getEnv).toHaveBeenNthCalledWith(1, { Name: "", Request: request }, callOptions);
    expect(getEnv).toHaveBeenNthCalledWith(2, { Name: "API_ENDPOINT", Request: request }, callOptions);
    expect(currentTokenOwner).toHaveBeenCalledExactlyOnceWith({ Request: request }, callOptions);
    expect(netstat).toHaveBeenCalledExactlyOnceWith({
      TCP: true, UDP: false, IP4: true, IP6: false, Listening: true, Request: request,
    }, callOptions);
    expect(mount).toHaveBeenCalledExactlyOnceWith({ Request: request }, callOptions);
    expect(memfilesList).toHaveBeenCalledExactlyOnceWith({ Request: request }, callOptions);
    expect(interactBeacon).not.toHaveBeenCalled();
  });

  it("uses one bounded DownloadReq shape for cat, head, and tail", async () => {
    const acknowledgement = { Response: { Async: true, BeaconID: "beacon-1", TaskID: "task-1" } };
    const download = vi.fn(async (_request: unknown, _options: unknown) => acknowledgement);
    const adapter = adaptSliverClient({ rpc: { download } } as unknown as SliverClient);

    await expect(adapter.catBeacon("beacon-1", "/tmp/a.txt", 30)).resolves.toBe(acknowledgement);
    await expect(adapter.headBeacon("beacon-1", "/tmp/a.txt", { bytes: 128 }, 30)).resolves.toBe(acknowledgement);
    await expect(adapter.headBeacon("beacon-1", "/tmp/a.txt", { lines: 10 }, 30)).resolves.toBe(acknowledgement);
    await expect(adapter.tailBeacon("beacon-1", "/tmp/a.txt", { bytes: 128 }, 30)).resolves.toBe(acknowledgement);

    const requests = download.mock.calls.map(([request]) => request);
    const base = {
      Path: "/tmp/a.txt", RestrictedToFile: true, Recurse: false,
      Request: { Async: true, Timeout: "29999999999", BeaconID: "beacon-1", SessionID: "" },
    };
    expect(requests).toEqual([
      { ...base, MaxBytes: String(BEACON_TEXT_READ_PROBE_BYTES), MaxLines: "0" },
      { ...base, MaxBytes: "128", MaxLines: "0" },
      { ...base, MaxBytes: String(BEACON_TEXT_READ_PROBE_BYTES), MaxLines: "10" },
      { ...base, MaxBytes: "-128", MaxLines: "0" },
    ]);
    expect(download.mock.calls.every(([, options]) =>
      (options as { signal?: unknown })?.signal instanceof AbortSignal)).toBe(true);
  });

  it("rejects unsafe text-read shapes before queuing a beacon task", async () => {
    const download = vi.fn();
    const adapter = adaptSliverClient({ rpc: { download } } as unknown as SliverClient);

    await expect(adapter.catBeacon("beacon-1", "", 30)).rejects.toThrow("Invalid beacon file path");
    expect(() => adapter.headBeacon("beacon-1", "/tmp/a", {}, 30)).toThrow("Choose either bytes or lines");
    expect(() => adapter.headBeacon("beacon-1", "/tmp/a", { bytes: 1, lines: 1 }, 30))
      .toThrow("Choose either bytes or lines");
    expect(() => adapter.headBeacon("beacon-1", "/tmp/a", { bytes: 65_537 }, 30))
      .toThrow("Byte count must be between 1 and 65536");
    expect(() => adapter.headBeacon("beacon-1", "/tmp/a", { lines: 4_097 }, 30))
      .toThrow("Line count must be between 1 and 4096");
    expect(() => adapter.tailBeacon("beacon-1", "/tmp/a", { lines: 10 }, 30))
      .toThrow("Beacon tail currently supports bounded bytes only");
    expect(download).not.toHaveBeenCalled();
  });

  it("queues grep with explicit context and rejects out-of-range inputs", async () => {
    const acknowledgement = { Response: { Async: true, BeaconID: "beacon-1", TaskID: "task-1" } };
    const grep = vi.fn(async () => acknowledgement);
    const adapter = adaptSliverClient({ rpc: { grep } } as unknown as SliverClient);

    await expect(adapter.grepBeacon("beacon-1", {
      path: "/tmp", pattern: "needle", recursive: true, before: 2, after: 3,
    }, 30)).resolves.toBe(acknowledgement);
    expect(grep).toHaveBeenCalledExactlyOnceWith({
      Path: "/tmp", SearchPattern: "needle", Recursive: true, LinesBefore: 2, LinesAfter: 3,
      Request: { Async: true, Timeout: "29999999999", BeaconID: "beacon-1", SessionID: "" },
    }, { signal: expect.any(AbortSignal) });
    expect(() => adapter.grepBeacon("beacon-1", {
      path: "/tmp", pattern: "x", recursive: false, before: 65, after: 0,
    }, 30)).toThrow("Invalid beacon grep options");
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it("fetches a saved task larger than the SDK task-content limit through the bounded control RPC", async () => {
    const task = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "PwdReq", State: "completed",
      Request: Buffer.alloc(96 * 1024, 0x41), Response: Buffer.from([1, 2, 3]),
    });
    const getBeaconTaskContent = vi.fn(async () => task);
    const fetchBeaconTask = vi.fn();
    const adapter = adaptSliverClient({ rpc: { getBeaconTaskContent }, fetchBeaconTask } as unknown as SliverClient);

    await expect(adapter.fetchBeaconTaskContent("beacon-1", "task-1", "PwdReq"))
      .resolves.toBe(task);
    expect(getBeaconTaskContent).toHaveBeenCalledExactlyOnceWith(
      { ID: "task-1" }, { signal: expect.any(AbortSignal) },
    );
    expect(fetchBeaconTask).not.toHaveBeenCalled();
  });

  it("accepts a bounded saved response larger than the BOF-specific response cap", async () => {
    const task = clientpb.BeaconTask.create({
      ID: "task-2", BeaconID: "beacon-1", Description: "DownloadReq", State: "completed",
      Request: Buffer.from([1]), Response: Buffer.alloc(BOF_TASK_RESPONSE_MAX_BYTES + 1, 0x42),
    });
    const getBeaconTaskContent = vi.fn(async () => task);
    const adapter = adaptSliverClient({ rpc: { getBeaconTaskContent } } as unknown as SliverClient);

    await expect(adapter.fetchBeaconTaskContent("beacon-1", "task-2", "DownloadReq"))
      .resolves.toBe(task);
  });

  it("rejects invalid task selectors before making an RPC", async () => {
    const getBeaconTaskContent = vi.fn();
    const adapter = adaptSliverClient({ rpc: { getBeaconTaskContent } } as unknown as SliverClient);

    await expect(adapter.fetchBeaconTaskContent("bad beacon", "task-1", "PwdReq"))
      .rejects.toThrow("Invalid beacon task identity");
    await expect(adapter.fetchBeaconTaskContent("beacon-1", "bad task", "PwdReq"))
      .rejects.toThrow("Invalid beacon task identity");
    await expect(adapter.fetchBeaconTaskContent("beacon-1", "task-1", "PwdReq suffix"))
      .rejects.toThrow("Invalid beacon task identity");
    expect(getBeaconTaskContent).not.toHaveBeenCalled();
  });

  it("zeroizes saved task bytes on identity, type, or content-size failure", async () => {
    const wrongTaskId = clientpb.BeaconTask.create({
      ID: "other-task", BeaconID: "beacon-1", Description: "PwdReq",
      Request: Buffer.from("private request"), Response: Buffer.from("private response"),
    });
    const mismatch = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "other-beacon", Description: "PwdReq",
      Request: Buffer.from("private request"), Response: Buffer.from("private response"),
    });
    const wrongDescription = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "LsReq",
      Request: Buffer.from("private request"), Response: Buffer.from("private response"),
    });
    const malformed = {
      ...clientpb.BeaconTask.create({
        ID: "task-1", BeaconID: "beacon-1", Description: "PwdReq",
        Request: Buffer.from("private request"),
      }),
      Response: "not bytes",
    } as unknown as clientpb.BeaconTask;
    const oversizedRequest = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "PwdReq",
      Request: Buffer.alloc(BEACON_TASK_CONTENT_REQUEST_MAX_BYTES + 1, 0x41),
      Response: Buffer.from("private response"),
    });
    const oversizedResponse = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "PwdReq",
      Request: Buffer.from("private request"),
      Response: Buffer.alloc(BEACON_TASK_CONTENT_RESPONSE_MAX_BYTES + 1, 0x42),
    });
    const oversizedCombined = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "PwdReq",
      Request: Buffer.alloc(BEACON_TASK_CONTENT_REQUEST_MAX_BYTES, 0x41),
      Response: Buffer.alloc(BEACON_TASK_CONTENT_RESPONSE_MAX_BYTES, 0x42),
    });
    const candidates = [
      wrongTaskId, mismatch, wrongDescription, malformed,
      oversizedRequest, oversizedResponse, oversizedCombined,
    ];
    const getBeaconTaskContent = vi.fn()
      .mockResolvedValueOnce(wrongTaskId)
      .mockResolvedValueOnce(mismatch)
      .mockResolvedValueOnce(wrongDescription)
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(oversizedRequest)
      .mockResolvedValueOnce(oversizedResponse)
      .mockResolvedValueOnce(oversizedCombined);
    const adapter = adaptSliverClient({ rpc: { getBeaconTaskContent } } as unknown as SliverClient);

    for (const candidate of candidates) {
      await expect(adapter.fetchBeaconTaskContent("beacon-1", "task-1", "PwdReq"))
        .rejects.toThrow("The beacon task content did not match the bounded request");
      expect(candidate.Request.every((byte) => byte === 0)).toBe(true);
      if (Buffer.isBuffer(candidate.Response)) {
        expect(candidate.Response.every((byte) => byte === 0)).toBe(true);
      }
    }
    expect(getBeaconTaskContent).toHaveBeenCalledTimes(candidates.length);
  });
});
