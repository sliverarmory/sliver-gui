import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SliverClient, clientpb, sliverpb } from "sliver-script";
import { adaptSliverClient, BOF_TASK_RESPONSE_MAX_BYTES } from "./sliver-client-adapter.js";

describe("narrow BOF adapter", () => {
  it("uses fixed diskless RustHound extension RPC fields and bounds task content", async () => {
    const registerNativeExtensionSession = vi.fn(async () => sliverpb.RegisterExtension.create());
    const registerNativeExtensionBeacon = vi.fn(async () => sliverpb.RegisterExtension.create());
    const callExtension = vi.fn(async (_request: unknown, _options: unknown) => sliverpb.CallExtension.create({ Output: Buffer.from("ok") }));
    const dll = Buffer.from("MZ fixture DLL");
    const args = Buffer.from('{"version":1,"op":"status"}');
    const digest = createHash("sha256").update(dll).digest("hex");
    const task = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "CallExtensionReq", State: "completed",
      Request: Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
        Data: Buffer.from(sliverpb.CallExtensionReq.encode(sliverpb.CallExtensionReq.create({ Name: digest, Args: args })).finish()),
      })).finish()),
      Response: Buffer.from("response"),
    });
    const getBeaconTaskContent = vi.fn(async () => task);
    const registrationTask = clientpb.BeaconTask.create({
      ID: "register-task", BeaconID: "beacon-1", Description: "RegisterExtensionReq", State: "completed",
      Request: Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
        Data: Buffer.from(sliverpb.RegisterExtensionReq.encode(sliverpb.RegisterExtensionReq.create({ Name: digest, Data: dll })).finish()),
      })).finish()), Response: Buffer.from(sliverpb.RegisterExtension.encode(sliverpb.RegisterExtension.create()).finish()),
    });
    const fetchNativeExtensionRegistrationTask = vi.fn(async () => registrationTask);
    const client = adaptSliverClient({ rpc: { callExtension, getBeaconTaskContent },
      registerNativeExtensionSession, registerNativeExtensionBeacon, fetchNativeExtensionRegistrationTask } as unknown as SliverClient);
    expect(client.nativeExtensionArtifactTransportAvailable).toBe(true);

    await client.registerAdCollectorSession("session-1", dll, 120);
    await client.registerAdCollectorBeacon("beacon-1", dll, 120);
    await client.callAdCollectorSession("session-1", digest, args, 120);
    await client.callAdCollectorBeacon("beacon-1", digest, args, 120);
    expect(registerNativeExtensionSession).toHaveBeenCalledWith("session-1",
      { name: digest, data: dll, os: "windows", init: "" }, 120);
    expect(registerNativeExtensionBeacon).toHaveBeenCalledWith("beacon-1",
      { name: digest, data: dll, os: "windows", init: "" }, 120);
    expect(callExtension.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ Name: digest, Args: args, Export: "RustHoundCE", IsBOF: false, ServerStore: false,
        Request: expect.objectContaining({ SessionID: "session-1", Async: false }) }),
      expect.objectContaining({ Name: digest, Args: args, Export: "RustHoundCE", IsBOF: false, ServerStore: false,
        Request: expect.objectContaining({ BeaconID: "beacon-1", Async: true }) }),
    ]);
    await expect(client.fetchAdCollectorBeaconTask("beacon-1", "task-1", "call", digest, 30)).resolves.toBe(task);
    await expect(client.fetchAdCollectorBeaconTask("beacon-1", "register-task", "register", digest, 30))
      .resolves.toBe(registrationTask);
    expect(fetchNativeExtensionRegistrationTask).toHaveBeenCalledWith("beacon-1", "register-task", digest, 30);
    const mismatched = clientpb.BeaconTask.create({ ...task, ID: "other-task",
      Request: Buffer.from("secret"), Response: Buffer.from("secret response") });
    getBeaconTaskContent.mockResolvedValueOnce(mismatched);
    await expect(client.fetchAdCollectorBeaconTask("beacon-1", "task-1", "call", digest, 30)).rejects.toThrow(/did not match/u);
    expect(mismatched.Request.every((byte) => byte === 0)).toBe(true);
    expect(mismatched.Response.every((byte) => byte === 0)).toBe(true);
  });
  it("forms a fixed built-in BOF request for sessions and beacons", async () => {
    const registerExtension = vi.fn(async () => sliverpb.RegisterExtension.create({}));
    const callExtension = vi.fn(async (_request: unknown, _options: unknown) => sliverpb.CallExtension.create({ Output: Buffer.from("ok") }));
    const client = adaptSliverClient({ rpc: { registerExtension, callExtension } } as unknown as SliverClient);
    expect(client.nativeExtensionArtifactTransportAvailable).toBe(false);
    const object = Buffer.from("fixture BOF object");
    const args = Buffer.from([0, 0, 0, 0]);
    const digest = createHash("sha256").update(object).digest("hex");

    await client.callBofSession("session-1", object, args, "go", 30);
    await client.callBofBeacon("beacon-1", object, args, "go", 45);

    expect(registerExtension).not.toHaveBeenCalled();
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

  it("fetches a correlated BOF task with an object larger than the SDK task-content channel", async () => {
    const task = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "CallExtensionReq", State: "completed",
      Request: Buffer.alloc(96 * 1024, 0x42), Response: Buffer.from([1, 2, 3]),
    });
    const getBeaconTaskContent = vi.fn(async () => task);
    const client = adaptSliverClient({ rpc: { getBeaconTaskContent } } as unknown as SliverClient);

    await expect(client.fetchBofBeaconTask("beacon-1", "task-1", "CallExtensionReq"))
      .resolves.toBe(task);
    expect(getBeaconTaskContent).toHaveBeenCalledWith({ ID: "task-1" }, { signal: expect.any(AbortSignal) });
    expect(task.Request.length).toBeGreaterThan(80 * 1024);
  });

  it("zeroizes mismatched and oversized BOF task content before rejecting it", async () => {
    const mismatched = clientpb.BeaconTask.create({
      ID: "other-task", BeaconID: "beacon-1", Description: "CallExtensionReq",
      Request: Buffer.from("private request"), Response: Buffer.from("private response"),
    });
    const oversized = clientpb.BeaconTask.create({
      ID: "task-1", BeaconID: "beacon-1", Description: "CallExtensionReq",
      Request: Buffer.from("private request"), Response: Buffer.alloc(BOF_TASK_RESPONSE_MAX_BYTES + 1, 0x53),
    });
    const getBeaconTaskContent = vi.fn()
      .mockResolvedValueOnce(mismatched)
      .mockResolvedValueOnce(oversized);
    const client = adaptSliverClient({ rpc: { getBeaconTaskContent } } as unknown as SliverClient);

    await expect(client.fetchBofBeaconTask("beacon-1", "task-1", "CallExtensionReq"))
      .rejects.toThrow("The BOF task content did not match the bounded request");
    expect(mismatched.Request.every((byte) => byte === 0)).toBe(true);
    expect(mismatched.Response.every((byte) => byte === 0)).toBe(true);
    await expect(client.fetchBofBeaconTask("beacon-1", "task-1", "CallExtensionReq"))
      .rejects.toThrow("The BOF task content did not match the bounded request");
    expect(oversized.Request.every((byte) => byte === 0)).toBe(true);
    expect(oversized.Response.every((byte) => byte === 0)).toBe(true);
  });
});
