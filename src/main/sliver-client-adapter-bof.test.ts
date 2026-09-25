import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SliverClient, sliverpb } from "sliver-script";
import { adaptSliverClient } from "./sliver-client-adapter.js";

describe("narrow BOF adapter", () => {
  it("forms a fixed built-in BOF request for sessions and beacons", async () => {
    const callExtension = vi.fn(async (_request: unknown, _options: unknown) => sliverpb.CallExtension.create({ Output: Buffer.from("ok") }));
    const client = adaptSliverClient({ rpc: { callExtension } } as unknown as SliverClient);
    const object = Buffer.from("fixture BOF object");
    const args = Buffer.from([0, 0, 0, 0]);
    const digest = createHash("sha256").update(object).digest("hex");

    await client.callBofSession("session-1", object, args, "go", 30);
    await client.callBofBeacon("beacon-1", object, args, "go", 45);

    expect(callExtension).toHaveBeenCalledTimes(2);
    expect(callExtension.mock.calls[0]?.[0]).toMatchObject({
      Name: digest, BOFData: object, Args: args, Export: "go", IsBOF: true,
      WantBOFOutputs: true, ServerStore: false,
      Request: { SessionID: "session-1", BeaconID: "", Async: false },
    });
    expect(callExtension.mock.calls[1]?.[0]).toMatchObject({
      Name: digest, BOFData: object, Args: args, Export: "go", IsBOF: true,
      WantBOFOutputs: true, ServerStore: false,
      Request: { SessionID: "", BeaconID: "beacon-1", Async: true },
    });
  });

  it("registers and calls only a main-selected legacy COFF loader", async () => {
    const registerExtension = vi.fn(async (_request: unknown, _options: unknown) => sliverpb.RegisterExtension.create({}));
    const callExtension = vi.fn(async (_request: unknown, _options: unknown) => sliverpb.CallExtension.create({ Output: Buffer.from("ok") }));
    const client = adaptSliverClient({ rpc: { registerExtension, callExtension } } as unknown as SliverClient);
    const loader = Buffer.from("fixture COFF loader");
    const argumentsBuffer = Buffer.from([4, 0, 0, 0, 1, 2, 3, 4]);
    const digest = createHash("sha256").update(loader).digest("hex");

    await client.registerBofLoaderSession("session-1", loader, "init", "windows", 30);
    await client.callLegacyBofSession("session-1", loader, argumentsBuffer, "Run", 30);
    await client.registerBofLoaderBeacon("beacon-1", loader, "init", "windows", 45);
    await client.callLegacyBofBeacon("beacon-1", loader, argumentsBuffer, "Run", 45);

    expect(registerExtension).toHaveBeenCalledTimes(2);
    expect(registerExtension.mock.calls[0]?.[0]).toMatchObject({
      Name: digest, Data: loader, OS: "windows", Init: "init",
      Request: { SessionID: "session-1", BeaconID: "", Async: false },
    });
    expect(registerExtension.mock.calls[1]?.[0]).toMatchObject({
      Name: digest, Data: loader, OS: "windows", Init: "init",
      Request: { SessionID: "", BeaconID: "beacon-1", Async: true },
    });
    expect(callExtension).toHaveBeenCalledTimes(2);
    expect(callExtension.mock.calls[0]?.[0]).toMatchObject({
      Name: digest, BOFData: Buffer.alloc(0), Args: argumentsBuffer, Export: "Run",
      IsBOF: false, WantBOFOutputs: false, ServerStore: false,
      Request: { SessionID: "session-1", BeaconID: "", Async: false },
    });
    expect(callExtension.mock.calls[1]?.[0]).toMatchObject({
      Name: digest, BOFData: Buffer.alloc(0), Args: argumentsBuffer, Export: "Run",
      IsBOF: false, WantBOFOutputs: false, ServerStore: false,
      Request: { SessionID: "", BeaconID: "beacon-1", Async: true },
    });
  });
});
