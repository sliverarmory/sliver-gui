// @vitest-environment node

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  SESSION_WORKBENCH_MAX_ARTIFACT_BYTES,
  SESSION_WORKBENCH_PLATFORM_REQUIREMENTS,
  type SessionWorkbenchInput,
} from "../shared/session-contracts.js";
import {
  SessionWorkbench,
  SessionWorkbenchPlatformError,
  SessionWorkbenchRemoteError,
  type SessionWorkbenchArtifactGateway,
  type SessionWorkbenchClient,
  type SessionWorkbenchTarget,
} from "./session-workbench.js";

const NOW = Date.UTC(2026, 7, 9, 23, 0, 0);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const TEST_SERVICE = {
  Name: "Spooler",
  DisplayName: "Print Spooler",
  Description: "Print service",
  Status: 4,
  StartupType: 2,
  BinPath: "C:\\Windows\\spoolsv.exe",
  Account: "LocalSystem",
};

describe("SessionWorkbench", () => {
  it("dispatches every direct query and non-destructive mutation with the exact result discriminant", async () => {
    const client = fakeClient();
    const workbench = new SessionWorkbench(client, fakeArtifacts(), { now: () => NOW });
    const inputs: SessionWorkbenchInput[] = [
      { operationId: "session.identity.current-token-owner" },
      { operationId: "session.environment.list" },
      { operationId: "session.environment.reveal", name: "PATH" },
      { operationId: "session.network.interfaces" },
      {
        operationId: "session.network.connections",
        tcp: true,
        udp: false,
        ip4: true,
        ip6: false,
        listening: false,
      },
      { operationId: "session.filesystem.pwd" },
      { operationId: "session.filesystem.ls", path: "/tmp" },
      {
        operationId: "session.filesystem.grep",
        path: "/tmp",
        pattern: "needle",
        recursive: false,
        linesBefore: 0,
        linesAfter: 0,
      },
      { operationId: "session.filesystem.mounts" },
      { operationId: "session.filesystem.memfiles.list" },
      { operationId: "session.process.list", fullInfo: true },
      { operationId: "session.service.list" },
      { operationId: "session.service.detail", name: "Spooler" },
      { operationId: "session.registry.read", hive: "HKCU", path: "Software", key: "Value" },
      { operationId: "session.registry.list-subkeys", hive: "HKCU", path: "Software" },
      { operationId: "session.registry.list-values", hive: "HKCU", path: "Software" },
      { operationId: "session.filesystem.cd", path: "/tmp" },
      { operationId: "session.filesystem.mkdir", path: "/tmp/new" },
      { operationId: "session.filesystem.memfiles.add" },
      { operationId: "session.filesystem.chmod", path: "/tmp/a", fileMode: "0600", recursive: false },
      {
        operationId: "session.filesystem.chown",
        path: "/tmp/a",
        uid: "1000",
        gid: "1000",
        recursive: false,
      },
      {
        operationId: "session.filesystem.chtimes",
        path: "/tmp/a",
        accessTime: "2026-08-09T00:00:00Z",
        modificationTime: "2026-08-09T00:00:00Z",
      },
      { operationId: "session.service.start", name: "Spooler" },
    ];

    for (const input of inputs) {
      const platform = SESSION_WORKBENCH_PLATFORM_REQUIREMENTS[input.operationId][0]!;
      const result = await workbench.run(target({ platform, os: platform }), input);
      expect(result.operationId).toBe(input.operationId);
      expect(JSON.stringify(result)).not.toContain("Buffer");
    }
  });

  it("enforces authoritative platform gates before dispatch", async () => {
    const client = fakeClient();
    const artifacts = fakeArtifacts();
    const workbench = new SessionWorkbench(client, artifacts);

    await expect(
      workbench.run(target({ platform: "linux", os: "linux" }), { operationId: "session.service.list" }),
    ).rejects.toBeInstanceOf(SessionWorkbenchPlatformError);
    await expect(
      workbench.run(target({ platform: "windows", os: "windows" }), {
        operationId: "session.filesystem.chmod",
        path: "C:\\a",
        fileMode: "0600",
        recursive: false,
      }),
    ).rejects.toBeInstanceOf(SessionWorkbenchPlatformError);
    await expect(
      workbench.run(target({ platform: "darwin", os: "darwin" }), {
        operationId: "session.screenshot.capture",
      }),
    ).rejects.toBeInstanceOf(SessionWorkbenchPlatformError);

    expect(client.servicesSession).not.toHaveBeenCalled();
    expect(client.chmodSession).not.toHaveBeenCalled();
    expect(client.screenshotSession).not.toHaveBeenCalled();
    expect(artifacts.captureScreenshot).not.toHaveBeenCalled();
  });

  it("redacts sensitive environment values, bounds pages, and reveals only an exact requested name", async () => {
    const client = fakeClient();
    const variables = Array.from({ length: 502 }, (_, index) => ({
      Key: index === 1 ? "API_TOKEN" : `VAR_${index}`,
      Value: index === 0 ? "x".repeat(70_000) : index === 1 ? "TOP-SECRET" : `value-${index}`,
    }));
    vi.mocked(client.listEnvSession).mockResolvedValueOnce({ Variables: variables } as never);
    vi.mocked(client.revealEnvSession).mockResolvedValueOnce({
      Variables: [{ Key: "API_TOKEN", Value: "TOP-SECRET" }],
    } as never);
    const workbench = new SessionWorkbench(client, fakeArtifacts(), { now: () => NOW });

    const first = await workbench.run(target(), {
      operationId: "session.environment.list",
      limit: 500,
    });
    expect(first).toMatchObject({
      operationId: "session.environment.list",
      value: {
        page: { limit: 500, total: 502, truncated: true, nextCursor: "500" },
      },
    });
    if (first.operationId !== "session.environment.list") throw new Error("Unexpected result");
    expect(first.value.items).toHaveLength(500);
    expect(first.value.items[0]).toMatchObject({ value: expect.stringMatching(/^x+$/u) });
    const firstEntry = first.value.items[0];
    if (!firstEntry || !("value" in firstEntry)) throw new Error("Expected a visible environment entry");
    expect(firstEntry.value).toHaveLength(64 * 1_024);
    expect(first.value.items[1]).toEqual({ name: "API_TOKEN", sensitive: true, redacted: true });
    expect(JSON.stringify(first)).not.toContain("TOP-SECRET");

    const revealed = await workbench.run(target(), {
      operationId: "session.environment.reveal",
      name: "API_TOKEN",
    });
    expect(revealed).toEqual({
      operationId: "session.environment.reveal",
      value: {
        name: "API_TOKEN",
        value: "TOP-SECRET",
        sensitive: true,
        revealedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 30_000).toISOString(),
      },
    });
    expect(client.revealEnvSession).toHaveBeenCalledWith("session-1", "API_TOKEN");
  });

  it("does not reflect target error contents into renderer-facing errors", async () => {
    const client = fakeClient();
    vi.mocked(client.mkdirSession).mockResolvedValueOnce({
      Path: "/tmp/private",
      Response: { Err: "token=TOP-SECRET at /tmp/private" },
    } as never);
    const workbench = new SessionWorkbench(client, fakeArtifacts());

    const rejection = workbench.run(target(), {
      operationId: "session.filesystem.mkdir",
      path: "/tmp/private",
    });
    await expect(rejection).rejects.toBeInstanceOf(SessionWorkbenchRemoteError);
    await expect(rejection).rejects.not.toThrow(/TOP-SECRET|private/u);
  });

  it("does not reflect target-controlled service messages into renderer results", async () => {
    const client = fakeClient();
    vi.mocked(client.serviceDetailSession).mockResolvedValueOnce({
      Detail: TEST_SERVICE,
      Message: "token=TOP-SECRET at /private/backend/path",
    } as never);
    const workbench = new SessionWorkbench(client, fakeArtifacts());

    const result = await workbench.run(target({ platform: "windows", os: "windows" }), {
      operationId: "session.service.detail",
      name: "Spooler",
    });

    expect(result).toMatchObject({
      operationId: "session.service.detail",
      value: { message: "The target reported partial service details" },
    });
    expect(JSON.stringify(result)).not.toMatch(/TOP-SECRET|private\/backend/u);
  });

  it("normalizes hostile nested process, file, and network data without raw protobuf fields", async () => {
    const client = fakeClient();
    vi.mocked(client.psSession).mockResolvedValueOnce({
      Processes: [{
        Pid: 42,
        Ppid: 1,
        Executable: `/tmp/evil\u202e${"x".repeat(5_000)}`,
        Owner: "root\u0000",
        Architecture: "amd64",
        SessionID: 3,
        CmdLine: Array.from({ length: 80 }, (_, index) => `arg-${index}`),
      }],
    } as never);
    vi.mocked(client.lsSession).mockResolvedValueOnce({
      Path: "/tmp",
      Exists: true,
      Files: [{
        Name: "file.txt",
        IsDir: false,
        Size: "00012",
        ModTime: "1786316400",
        Mode: "-rw-------",
        Link: "",
        Uid: "1000",
        Gid: "1000",
      }],
      timezone: "PDT",
      timezoneOffset: -25_200,
    } as never);
    vi.mocked(client.netstatSession).mockResolvedValueOnce({
      Entries: [{
        Protocol: "tcp",
        SkState: "ESTABLISHED",
        UID: 1000,
        LocalAddr: { Ip: "127.0.0.1", Port: 4444 },
        RemoteAddr: { Ip: "10.0.0.1", Port: 443 },
      }],
    } as never);
    const workbench = new SessionWorkbench(client, fakeArtifacts());

    const processes = await workbench.run(target(), {
      operationId: "session.process.list",
      fullInfo: true,
      query: "evil",
    });
    const files = await workbench.run(target(), { operationId: "session.filesystem.ls", path: "/tmp" });
    const network = await workbench.run(target(), {
      operationId: "session.network.connections",
      tcp: true,
      udp: false,
      ip4: true,
      ip6: false,
      listening: false,
    });

    if (processes.operationId !== "session.process.list") throw new Error("Unexpected process result");
    expect(processes.value.items[0]?.executable).toHaveLength(4_096);
    expect(processes.value.items[0]?.executable).not.toContain("\u202e");
    expect(processes.value.items[0]?.owner).toContain("�");
    expect(processes.value.items[0]?.commandLine).toHaveLength(64);
    expect(files).toMatchObject({
      value: {
        timezone: "PDT",
        timezoneOffsetMinutes: -420,
        items: [{ path: "/tmp/file.txt", sizeBytes: "12" }],
      },
    });
    expect(network).toMatchObject({
      value: {
        items: [{
          protocol: "tcp",
          local: { address: "127.0.0.1", port: 4444 },
          remote: { address: "10.0.0.1", port: 443 },
        }],
      },
    });
    expect(JSON.stringify({ processes, files, network })).not.toMatch(/Processes|Files|Entries|Response/u);
  });

  it("cancels native save/open workflows before dispatching remote RPCs", async () => {
    const client = fakeClient();
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.prepareNativeSave).mockResolvedValue(null);
    vi.mocked(artifacts.prepareUploadOpen).mockResolvedValue(null);
    vi.mocked(artifacts.prepareStoredArtifactSave).mockResolvedValue(null);
    const workbench = new SessionWorkbench(client, artifacts);

    await expect(workbench.run(target(), {
      operationId: "session.filesystem.download",
      path: "/tmp/file",
      maxBytes: 1_024,
    })).resolves.toMatchObject({ value: { status: "canceled" } });
    await expect(workbench.run(target({ platform: "windows", os: "windows" }), {
      operationId: "session.process.dump",
      pid: 42,
      dumpTimeoutSeconds: 60,
    })).resolves.toMatchObject({ value: { status: "canceled" } });
    await expect(workbench.run(target({ platform: "windows", os: "windows" }), {
      operationId: "session.registry.read-hive",
      rootHive: "HKLM",
      requestedHive: "SAM",
      maxBytes: 1_024,
    })).resolves.toMatchObject({ value: { status: "canceled" } });
    await expect(workbench.run(target(), {
      operationId: "session.filesystem.upload-open",
      remotePath: "/tmp",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    })).resolves.toMatchObject({ value: { status: "canceled" } });
    await expect(workbench.run(target(), {
      operationId: "session.artifact.save",
      handle: "A".repeat(43),
    })).resolves.toMatchObject({ value: { status: "canceled" } });

    expect(client.downloadFileSession).not.toHaveBeenCalled();
    expect(client.processDumpSession).not.toHaveBeenCalled();
    expect(client.registryReadHiveSession).not.toHaveBeenCalled();
    expect(client.uploadSession).not.toHaveBeenCalled();
    expect(artifacts.writeNativeSave).not.toHaveBeenCalled();
    expect(artifacts.writeStoredArtifact).not.toHaveBeenCalled();
  });

  it("gives process dumps a transport deadline longer than the implant deadline", async () => {
    const client = fakeClient();
    const workbench = new SessionWorkbench(client, fakeArtifacts());

    await workbench.run(target({ platform: "windows", os: "windows" }), {
      operationId: "session.process.dump",
      pid: 42,
      dumpTimeoutSeconds: 120,
    });

    expect(client.processDumpSession).toHaveBeenCalledWith("session-1", 42, 120, 150);
  });

  it("preflights, saves, hashes, and zeroizes a bounded single-file download in order", async () => {
    const order: string[] = [];
    const client = fakeClient();
    const downloaded = Buffer.from("downloaded-content");
    vi.mocked(client.downloadFileSession).mockImplementationOnce(async () => {
      order.push("rpc");
      return { Path: "/remote/report.txt", Exists: true, IsDir: false, Data: downloaded } as never;
    });
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.prepareNativeSave).mockImplementationOnce(async () => {
      order.push("prepare");
      return { capability: {} };
    });
    let written = Buffer.alloc(0);
    vi.mocked(artifacts.writeNativeSave).mockImplementationOnce(async (_prepared, input) => {
      order.push("write");
      written = Buffer.from(input.data);
    });
    const workbench = new SessionWorkbench(client, artifacts);

    const result = await workbench.run(target(), {
      operationId: "session.filesystem.download",
      path: "/remote/report.txt",
      maxBytes: 1_024,
    });

    const sha256 = digest(Buffer.from("downloaded-content"));
    expect(order).toEqual(["prepare", "rpc", "write"]);
    expect(written.toString()).toBe("downloaded-content");
    expect(downloaded.equals(Buffer.alloc(downloaded.length))).toBe(true);
    expect(result).toEqual({
      operationId: "session.filesystem.download",
      value: { status: "saved", suggestedBasename: "report.txt", size: 18, sha256 },
    });
    expect(JSON.stringify(result)).not.toMatch(/remote|path|Buffer/u);
  });

  it("zeroizes native-save bytes even when publishing fails", async () => {
    const client = fakeClient();
    const dump = Buffer.from("process-dump");
    vi.mocked(client.processDumpSession).mockResolvedValueOnce({ Data: dump } as never);
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.writeNativeSave).mockRejectedValueOnce(new Error("disk full"));
    const workbench = new SessionWorkbench(client, artifacts);

    await expect(workbench.run(target({ platform: "windows", os: "windows" }), {
      operationId: "session.process.dump",
      pid: 42,
      dumpTimeoutSeconds: 60,
    })).rejects.toThrow("disk full");
    expect(dump.equals(Buffer.alloc(dump.length))).toBe(true);
  });

  it("opens uploads before dispatch, returns path-free metadata, and clears bytes on success and failure", async () => {
    const client = fakeClient();
    const first = Buffer.from("upload-one");
    const second = Buffer.from("upload-two");
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.prepareUploadOpen)
      .mockResolvedValueOnce({ data: first, suggestedBasename: "C:\\local\\one?.txt" })
      .mockResolvedValueOnce({ data: second, suggestedBasename: "two.txt" });
    vi.mocked(client.uploadSession)
      .mockResolvedValueOnce({ Path: "/remote/one_.txt", WrittenFiles: 1, UnwriteableFiles: 0 } as never)
      .mockResolvedValueOnce({ Response: { Err: "rejected" } } as never);
    const workbench = new SessionWorkbench(client, artifacts);

    const result = await workbench.run(target(), {
      operationId: "session.filesystem.upload-open",
      remotePath: "/remote",
      isIOC: true,
      isDirectory: false,
      overwrite: false,
    });
    expect(result).toEqual({
      operationId: "session.filesystem.upload-open",
      value: {
        status: "uploaded",
        remotePath: "/remote/one_.txt",
        suggestedBasename: "one_.txt",
        size: 10,
        sha256: digest(Buffer.from("upload-one")),
        message: "Upload completed",
      },
    });
    expect(client.uploadSession).toHaveBeenNthCalledWith(
      1,
      "session-1",
      "/remote",
      expect.any(Buffer),
      { isIOC: true, fileName: "one_.txt", isDirectory: false, overwrite: false },
    );
    expect(first.equals(Buffer.alloc(first.length))).toBe(true);

    await expect(workbench.run(target(), {
      operationId: "session.filesystem.upload-open",
      remotePath: "/remote",
      isIOC: false,
      isDirectory: false,
      overwrite: false,
    })).rejects.toBeInstanceOf(SessionWorkbenchRemoteError);
    expect(second.equals(Buffer.alloc(second.length))).toBe(true);
  });

  it("captures only bounded signed images through a main-owned handle", async () => {
    const client = fakeClient();
    const screenshot = Buffer.from(PNG);
    vi.mocked(client.screenshotSession).mockResolvedValueOnce({ Data: screenshot } as never);
    const artifacts = fakeArtifacts();
    vi.mocked(artifacts.captureScreenshot).mockImplementationOnce(async (input) => {
      const copy = Buffer.from(input.data);
      input.data.fill(0);
      return capturedResult(copy, input.suggestedBasename, input.sha256);
    });
    const workbench = new SessionWorkbench(client, artifacts);

    const result = await workbench.run(target(), { operationId: "session.screenshot.capture" });

    expect(screenshot.equals(Buffer.alloc(screenshot.length))).toBe(true);
    expect(result).toMatchObject({
      operationId: "session.screenshot.capture",
      value: {
        status: "captured",
        artifact: {
          handle: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
          mediaType: "image/png",
          size: PNG.length,
          sha256: digest(PNG),
        },
        preview: { mediaType: "image/png", size: PNG.length },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/"Data"|"path"|Buffer/u);
  });

  it("rejects and clears invalid or oversized screenshot bytes before publication", async () => {
    const client = fakeClient();
    const invalid = Buffer.from("not-an-image");
    vi.mocked(client.screenshotSession).mockResolvedValueOnce({ Data: invalid } as never);
    const artifacts = fakeArtifacts();
    const workbench = new SessionWorkbench(client, artifacts);

    await expect(workbench.run(target(), { operationId: "session.screenshot.capture" }))
      .rejects.toThrow(/supported image/u);
    expect(invalid.equals(Buffer.alloc(invalid.length))).toBe(true);
    expect(artifacts.captureScreenshot).not.toHaveBeenCalled();

    const oversized = Buffer.alloc(8 * 1_024 * 1_024 + 1, 0xa5);
    PNG.copy(oversized);
    vi.mocked(client.screenshotSession).mockResolvedValueOnce({ Data: oversized } as never);
    await expect(workbench.run(target(), { operationId: "session.screenshot.capture" }))
      .rejects.toThrow(/limit/u);
    expect(oversized.equals(Buffer.alloc(oversized.length))).toBe(true);
  });

  it("saves an existing handle without exposing gateway-local fields and validates before write", async () => {
    const client = fakeClient();
    const artifacts = fakeArtifacts();
    const workbench = new SessionWorkbench(client, artifacts);

    const result = await workbench.run(target(), {
      operationId: "session.artifact.save",
      handle: "A".repeat(43),
    });
    expect(result).toEqual({
      operationId: "session.artifact.save",
      value: {
        status: "saved",
        suggestedBasename: "screen.png",
        size: PNG.length,
        sha256: digest(PNG),
      },
    });
    expect(artifacts.writeStoredArtifact).toHaveBeenCalledOnce();

    vi.mocked(artifacts.prepareStoredArtifactSave).mockResolvedValueOnce({
      capability: {},
      suggestedBasename: "bad.bin",
      size: SESSION_WORKBENCH_MAX_ARTIFACT_BYTES + 1,
      sha256: "f".repeat(64),
    });
    await expect(workbench.run(target(), {
      operationId: "session.artifact.save",
      handle: "B".repeat(43),
    })).rejects.toThrow(/invalid size/u);
    expect(artifacts.writeStoredArtifact).toHaveBeenCalledOnce();
  });
});

function target(overrides: Partial<SessionWorkbenchTarget> = {}): SessionWorkbenchTarget {
  return {
    sessionId: "session-1",
    platform: "linux",
    username: "operator",
    uid: "1000",
    gid: "1000",
    pid: 4242,
    executable: "/tmp/implant",
    hostname: "target-host",
    os: "linux",
    arch: "amd64",
    ...overrides,
  };
}

function fakeClient(): SessionWorkbenchClient {
  return {
    currentTokenOwnerSession: vi.fn().mockResolvedValue({ Output: "DOMAIN\\operator" }),
    listEnvSession: vi.fn().mockResolvedValue({ Variables: [{ Key: "PATH", Value: "/usr/bin" }] }),
    revealEnvSession: vi.fn().mockResolvedValue({ Variables: [{ Key: "PATH", Value: "/usr/bin" }] }),
    ifconfigSession: vi.fn().mockResolvedValue({ NetInterfaces: [] }),
    netstatSession: vi.fn().mockResolvedValue({ Entries: [] }),
    pwdSession: vi.fn().mockResolvedValue({ Path: "/tmp" }),
    cdSession: vi.fn().mockResolvedValue({ Path: "/tmp" }),
    lsSession: vi.fn().mockResolvedValue({
      Path: "/tmp",
      Exists: true,
      Files: [],
      timezone: "UTC",
      timezoneOffset: 0,
    }),
    downloadFileSession: vi.fn().mockResolvedValue({
      Path: "/tmp/file",
      Exists: true,
      IsDir: false,
      Data: Buffer.from("download"),
    }),
    uploadSession: vi.fn().mockResolvedValue({ Path: "/tmp/upload", WrittenFiles: 1, UnwriteableFiles: 0 }),
    grepSession: vi.fn().mockResolvedValue({ Results: {}, SearchPathAbsolute: "/tmp" }),
    mkdirSession: vi.fn().mockResolvedValue({ Path: "/tmp/new" }),
    mountsSession: vi.fn().mockResolvedValue({ Info: [] }),
    memfilesListSession: vi.fn().mockResolvedValue({
      Path: "/proc/self/fd",
      Exists: true,
      Files: [],
      timezone: "UTC",
      timezoneOffset: 0,
    }),
    memfilesAddSession: vi.fn().mockResolvedValue({ Fd: "7" }),
    chmodSession: vi.fn().mockResolvedValue({ Path: "/tmp/a" }),
    chownSession: vi.fn().mockResolvedValue({ Path: "/tmp/a" }),
    chtimesSession: vi.fn().mockResolvedValue({ Path: "/tmp/a" }),
    psSession: vi.fn().mockResolvedValue({ Processes: [] }),
    processDumpSession: vi.fn().mockResolvedValue({ Data: Buffer.from("dump") }),
    screenshotSession: vi.fn().mockResolvedValue({ Data: Buffer.from(PNG) }),
    servicesSession: vi.fn().mockResolvedValue({ Details: [TEST_SERVICE], Error: "" }),
    serviceDetailSession: vi.fn().mockResolvedValue({ Detail: TEST_SERVICE, Message: "Running" }),
    startServiceSession: vi.fn().mockResolvedValue({}),
    registryReadSession: vi.fn().mockResolvedValue({ Value: "registry-value" }),
    registryListSubkeysSession: vi.fn().mockResolvedValue({ Subkeys: [] }),
    registryListValuesSession: vi.fn().mockResolvedValue({ ValueNames: [] }),
    registryReadHiveSession: vi.fn().mockResolvedValue({ Data: Buffer.from("hive"), Encoder: "" }),
  } as unknown as SessionWorkbenchClient;
}

function fakeArtifacts(): SessionWorkbenchArtifactGateway {
  return {
    prepareNativeSave: vi.fn().mockResolvedValue({ capability: {} }),
    writeNativeSave: vi.fn().mockResolvedValue(undefined),
    prepareUploadOpen: vi.fn().mockResolvedValue(null),
    captureScreenshot: vi.fn().mockImplementation(async (input) => {
      const copy = Buffer.from(input.data);
      input.data.fill(0);
      return capturedResult(copy, input.suggestedBasename, input.sha256);
    }),
    prepareStoredArtifactSave: vi.fn().mockResolvedValue({
      capability: {},
      suggestedBasename: "screen.png",
      size: PNG.length,
      sha256: digest(PNG),
    }),
    writeStoredArtifact: vi.fn().mockResolvedValue(undefined),
  };
}

function capturedResult(data: Buffer, suggestedBasename: string, sha256: string) {
  return {
    status: "captured" as const,
    artifact: {
      handle: "H".repeat(43),
      suggestedBasename,
      mediaType: "image/png",
      size: data.length,
      sha256,
      createdAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60_000).toISOString(),
    },
    preview: {
      mediaType: "image/png" as const,
      dataUrl: `data:image/png;base64,${data.toString("base64")}`,
      size: data.length,
    },
  };
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
