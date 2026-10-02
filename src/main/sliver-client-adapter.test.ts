// @vitest-environment node

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { clientpb, type SliverClient } from "sliver-script";

import {
  adaptSliverClient,
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
