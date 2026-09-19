// @vitest-environment node

import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { SliverClient } from "sliver-script";

import {
  adaptSliverClient,
  type SliverClientAdapter,
} from "./sliver-client-adapter.js";

describe("SliverClientAdapter passive topology inventory", () => {
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
});
