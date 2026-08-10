// @vitest-environment node

import { gzipSync } from "node:zlib";

import { SliverClient, type SliverClientConfig } from "sliver-script";
import { describe, expect, it, vi } from "vitest";

describe("explicit Sliver session workbench wrappers", () => {
  it("binds requests to the supplied session and never accepts a service hostname", async () => {
    const services = vi.fn(async () => ({ Services: [] }));
    const currentTokenOwner = vi.fn(async () => ({ Output: "SYSTEM" }));
    const registryRead = vi.fn(async () => ({ Value: "value" }));
    const client = clientWithRpc({ control: { services, currentTokenOwner, registryRead } });

    await client.servicesSession("session-42", 0);
    await client.currentTokenOwnerSession("session-42", 0);
    await client.registryReadSession("session-42", "HKLM", "Software\\Example", "Value", 0);

    expect(services).toHaveBeenCalledWith(
      {
        Hostname: "",
        Request: { Async: false, Timeout: "0", BeaconID: "", SessionID: "session-42" },
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(currentTokenOwner).toHaveBeenCalledWith(
      { Request: { Async: false, Timeout: "0", BeaconID: "", SessionID: "session-42" } },
      { signal: expect.any(AbortSignal) },
    );
    expect(registryRead).toHaveBeenCalledWith(
      expect.objectContaining({
        Hostname: "",
        Request: expect.objectContaining({ SessionID: "session-42", BeaconID: "" }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("routes M2 binary wrappers through the bounded workbench channel only", async () => {
    const workbench = {
      download: vi.fn(async () => ({
        Data: Buffer.from("download"), Encoder: "", Exists: true, IsDir: false, Response: undefined,
      })),
      upload: vi.fn(async () => ({ Path: "/tmp/upload.bin", Response: undefined })),
      screenshot: vi.fn(async () => ({ Data: Buffer.from("png"), Response: undefined })),
      processDump: vi.fn(async () => ({ Data: Buffer.from("dump"), Response: undefined })),
      registryReadHive: vi.fn(async () => ({ Data: Buffer.from("hive"), Encoder: "", Response: undefined })),
    };
    const legacy = {
      download: vi.fn(),
      upload: vi.fn(),
      screenshot: vi.fn(),
      processDump: vi.fn(),
      registryReadHive: vi.fn(),
    };
    const client = clientWithRpc({ "workbench-artifact": workbench, artifact: legacy });

    await client.downloadFileSession("session-a", "/tmp/download.bin", { maxBytes: 128 }, 0);
    await client.uploadSession("session-a", "/tmp/upload.bin", Buffer.from("upload"), {}, 0);
    await client.screenshotSession("session-a", 0);
    await client.processDumpSession("session-a", 123, 60, 0);
    await client.registryReadHiveSession("session-a", "HKLM", "SAM", 128, 0);

    expect(workbench.download).toHaveBeenCalledOnce();
    expect(workbench.upload).toHaveBeenCalledOnce();
    expect(workbench.screenshot).toHaveBeenCalledOnce();
    expect(workbench.processDump).toHaveBeenCalledOnce();
    expect(workbench.registryReadHive).toHaveBeenCalledOnce();
    for (const rpc of Object.values(legacy)) expect(rpc).not.toHaveBeenCalled();

    expect(workbench.download).toHaveBeenCalledWith(
      expect.objectContaining({
        Path: "/tmp/download.bin",
        Recurse: false,
        RestrictedToFile: true,
        MaxBytes: "128",
        Request: expect.objectContaining({ SessionID: "session-a", BeaconID: "" }),
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("maps bounded tail reads to negative MaxBytes while decoding against the positive magnitude", async () => {
    const remoteBytes = Buffer.alloc(65_538, 0x41);
    const download = vi.fn(async () => ({
      Data: remoteBytes,
      Encoder: "",
      Exists: true,
      IsDir: false,
      Response: undefined,
    }));
    const client = clientWithRpc({ "workbench-artifact": { download } });

    await expect(client.downloadFileSession(
      "session-tail",
      "/tmp/tail.txt",
      { maxBytes: 65_537, fromEnd: true },
      0,
    )).rejects.toThrow(/65537-byte workbench limit/u);

    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        Path: "/tmp/tail.txt",
        MaxBytes: "-65537",
        MaxLines: "0",
        RestrictedToFile: true,
      }),
      { signal: expect.any(AbortSignal) },
    );
    expect(remoteBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("always binds a positive byte ceiling when a line ceiling is requested", async () => {
    const download = vi.fn(async () => ({
      Data: Buffer.from("line\n"),
      Encoder: "",
      Exists: true,
      IsDir: false,
      Response: undefined,
    }));
    const client = clientWithRpc({ "workbench-artifact": { download } });

    await client.downloadFileSession("session-lines", "/tmp/lines.txt", { maxLines: 5 }, 0);

    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({ MaxBytes: String(64 * 1_024 * 1_024), MaxLines: "5" }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it("rejects ambiguous or invalid from-end download options before dispatch", () => {
    const download = vi.fn();
    const client = clientWithRpc({ "workbench-artifact": { download } });

    expect(() => client.downloadFileSession(
      "session-tail",
      "/tmp/tail.txt",
      { maxBytes: 32, fromEnd: true, maxLines: 1 },
      0,
    )).toThrow(/cannot be combined/u);
    expect(() => client.downloadFileSession(
      "session-tail",
      "/tmp/tail.txt",
      { maxBytes: 32, fromEnd: "yes" as never },
      0,
    )).toThrow(/must be a boolean/u);
    expect(download).not.toHaveBeenCalled();
  });

  it("uses the explicit process-dump transport deadline for both RPC cancellation and the common request", async () => {
    const processDump = vi.fn(async (
      _request: { Pid: number; Timeout: number; Request: { Timeout: string } },
      _options: { signal: AbortSignal },
    ) => ({ Data: Buffer.from("dump"), Response: undefined }));
    const client = clientWithRpc({ "workbench-artifact": { processDump } });

    await client.processDumpSession("session-timeout", 42, 120, 150);

    expect(processDump).toHaveBeenCalledOnce();
    const [request, options] = processDump.mock.calls[0]!;
    expect(request).toMatchObject({
      Pid: 42,
      Timeout: 120,
      Request: {
        Async: false,
        BeaconID: "",
        SessionID: "session-timeout",
      },
    });
    const commonTimeout = BigInt(request.Request.Timeout);
    expect(commonTimeout).toBeLessThanOrEqual(150_000_000_000n);
    expect(commonTimeout).toBeGreaterThan(149_000_000_000n);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects decoded gzip expansion beyond the per-operation cap", async () => {
    const encoded = gzipSync(Buffer.alloc(4_096, 0x41));
    const client = clientWithRpc({
      "workbench-artifact": {
        download: vi.fn(async () => ({
          Data: encoded,
          Encoder: "gzip",
          Exists: true,
          IsDir: false,
          Response: undefined,
        })),
      },
    });

    await expect(client.downloadFileSession(
      "session-b",
      "/tmp/compressed.bin",
      { maxBytes: 32 },
      0,
    )).rejects.toThrow(/32-byte decoded limit/u);
    expect(encoded.every((byte) => byte === 0)).toBe(true);
  });

  it("does not reflect target-controlled errors and clears rejected artifact buffers", async () => {
    const remoteBytes = Buffer.from("sensitive-target-artifact");
    const client = clientWithRpc({
      "workbench-artifact": {
        screenshot: vi.fn(async () => ({
          Data: remoteBytes,
          Response: { Err: "TOP-SECRET-TARGET-ERROR" },
        })),
      },
    });

    await expect(client.screenshotSession("session-error", 0)).rejects.toThrow(
      "Screenshot was rejected by the target",
    );
    await expect(client.screenshotSession("session-error", 0)).rejects.not.toThrow(/TOP-SECRET/u);
    expect(remoteBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("clears unavailable download bytes before rejecting the response", async () => {
    const remoteBytes = Buffer.from("must-not-survive");
    const client = clientWithRpc({
      "workbench-artifact": {
        download: vi.fn(async () => ({
          Data: remoteBytes,
          Encoder: "",
          Exists: false,
          IsDir: false,
        })),
      },
    });

    await expect(client.downloadFileSession("session-missing", "/tmp/missing", { maxBytes: 128 }, 0))
      .rejects.toThrow(/unavailable or is not a single file/u);
    expect(remoteBytes.every((byte) => byte === 0)).toBe(true);
  });

  it("clears the compressed upload payload after success or target rejection", async () => {
    let compressed: Buffer | undefined;
    const upload = vi.fn(async (request: { Data: Buffer }) => {
      compressed = request.Data;
      return { Path: "/tmp/upload.bin", Response: { Err: "target-controlled failure" } };
    });
    const client = clientWithRpc({ "workbench-artifact": { upload } });
    const source = Buffer.from("operator upload bytes");

    await expect(client.uploadSession("session-upload", "/tmp/upload.bin", source, {}, 0)).resolves.toMatchObject({
      Response: { Err: "target-controlled failure" },
    });
    expect(compressed).toBeDefined();
    expect(compressed!.every((byte) => byte === 0)).toBe(true);
    expect(source.toString()).toBe("operator upload bytes");
  });

  it("rejects an upload before compression when it exceeds the workbench cap", async () => {
    const upload = vi.fn();
    const client = clientWithRpc({ "workbench-artifact": { upload } });
    const oversized = Buffer.alloc((64 * 1_024 * 1_024) + 1);

    expect(() => client.uploadSession("session-c", "/tmp/large.bin", oversized, {}, 0))
      .toThrow(/workbench limit/u);
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects registry QWORD values outside the unsigned 64-bit range", () => {
    const registryWrite = vi.fn();
    const client = clientWithRpc({ control: { registryWrite } });

    expect(() => client.registryWriteSession(
      "session-d",
      "HKLM",
      "Software\\Example",
      "Counter",
      { type: "qword", value: "18446744073709551616" },
      0,
    )).toThrow(/unsigned 64-bit/u);
    expect(registryWrite).not.toHaveBeenCalled();
  });
});

function clientWithRpc(rpc: Record<string, Record<string, unknown>>): SliverClient {
  const config: SliverClientConfig = {
    operator: "test",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "",
    certificate: "",
    private_key: "",
    token: "",
  };
  const client = new SliverClient(config);
  const internals = client as unknown as { rpcClients: Record<string, unknown> };
  Object.assign(internals.rpcClients, rpc);
  return client;
}
