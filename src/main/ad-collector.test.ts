// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import { clientpb, sliverpb } from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TargetSummary } from "../shared/target-contracts.js";
import {
  AD_COLLECTION_BEACON_MAX_BYTES, AD_COLLECTION_SCRIPT_MAX_BYTES,
  collectSharpHound, isCompleteZipEnvelope, type AdCollectionClient,
} from "./ad-collector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const session = {
  mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active",
} as TargetSummary;
const beacon = {
  mode: "beacon", id: "beacon-1", os: "windows", arch: "amd64", checkinStatus: "on-time",
} as TargetSummary;

async function collectionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sliver-ad-collector-"));
  roots.push(root);
  return join(root, "gui", "ad-explorer", "collections");
}

function zip(): Buffer {
  const name = Buffer.from("users.json");
  const contents = Buffer.from('{"users":[]}\n');
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  const directoryOffset = local.length + name.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

function zip64EntrySizes(): Buffer {
  const original = zip();
  const endOffset = original.length - 22;
  const centralOffset = original.readUInt32LE(endOffset + 16);
  const central = Buffer.from(original.subarray(centralOffset, endOffset));
  const contentBytes = original.readUInt32LE(centralOffset + 20);
  central.writeUInt32LE(0xffffffff, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(20, 30);
  const extra = Buffer.alloc(20);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(16, 2);
  extra.writeBigUInt64LE(BigInt(contentBytes), 4);
  extra.writeBigUInt64LE(BigInt(contentBytes), 12);
  const end = Buffer.from(original.subarray(endOffset));
  end.writeUInt32LE(central.length + extra.length, 12);
  return Buffer.concat([original.subarray(0, centralOffset), central, extra, end]);
}

it("accepts a complete ZIP64 entry but rejects a truncated ZIP64 archive", () => {
  const archive = zip64EntrySizes();
  expect(isCompleteZipEnvelope(archive)).toBe(true);
  expect(isCompleteZipEnvelope(archive.subarray(0, -1))).toBe(false);
});

const outputDirectory = "C:\\Users\\Public";
const timestamp = "20261023123456";

function requestedZipName(args: string[] | undefined): string {
  return args?.[(args.indexOf("--zipfilename") + 1)] ?? "";
}

function outputListing(requestedName: string, size: number, otherNames: string[] = []): sliverpb.Ls {
  return sliverpb.Ls.create({
    Path: outputDirectory, Exists: true,
    Files: [
      { Name: `${timestamp}_${requestedName}`, Size: String(size) },
      ...otherNames.map((name) => ({ Name: name, Size: String(size) })),
    ],
  });
}

function input(client: AdCollectionClient, target: TargetSummary, root: string) {
  return {
    client, target, assembly: Buffer.from("MZfixture"), domain: "example.local",
    collectionMethod: "Default" as const, collectionRoot: root, assertCurrent: vi.fn(),
  };
}

describe("SharpHound collection", () => {
  it("runs a selected method on a session, saves a private ZIP, then cleans only its generated remote path", async () => {
    const root = await collectionRoot();
    const archive = zip();
    const output = Buffer.from("collector output");
    const received = sliverpb.Download.create({ Exists: true, Data: Buffer.from(archive) });
    let requestedName = "";
    const client = {
      executeAssemblySession: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
        requestedName = requestedZipName(options.arguments);
        return sliverpb.ExecuteAssembly.create({ Output: output });
      }),
      lsSession: vi.fn(async () => outputListing(requestedName, archive.length)),
      downloadFileSession: vi.fn(async () => received),
      rmSession: vi.fn(async () => { throw new Error("remote cleanup denied"); }),
    } as unknown as AdCollectionClient;
    const path = await collectSharpHound(input(client, session, root));
    expect(path).toMatch(/\/example\.local\/sliver-ad-[0-9a-f-]+\.zip$/u);
    expect(await readFile(path)).toEqual(archive);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    const args = vi.mocked(client.executeAssemblySession).mock.calls[0]![2]?.arguments ?? [];
    expect(args).toEqual(expect.arrayContaining(["--collectionmethods", "Default", "--domain", "example.local", "--memcache"]));
    expect(args[args.indexOf("--zipfilename") + 1]).toBe(path.split("/").at(-1));
    expect(client.lsSession).toHaveBeenCalledExactlyOnceWith(session.id, outputDirectory, 120);
    expect(vi.mocked(client.downloadFileSession).mock.calls[0]![1]).toBe(`${outputDirectory}\\${timestamp}_${path.split("/").at(-1)}`);
    expect(vi.mocked(client.rmSession).mock.calls[0]![1]).toBe(vi.mocked(client.downloadFileSession).mock.calls[0]![1]);
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(received.Data.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a truncated session ZIP before saving or remote cleanup", async () => {
    const root = await collectionRoot();
    const archive = zip();
    let requestedName = "";
    const client = {
      executeAssemblySession: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
        requestedName = requestedZipName(options.arguments);
        return sliverpb.ExecuteAssembly.create();
      }),
      lsSession: vi.fn(async () => outputListing(requestedName, archive.length)),
      downloadFileSession: vi.fn(async () => sliverpb.Download.create({ Exists: true, Data: archive.subarray(0, -1) })),
      rmSession: vi.fn(),
    } as unknown as AdCollectionClient;
    await expect(collectSharpHound(input(client, session, root))).rejects.toThrow(/complete ZIP/u);
    expect(await readdir(join(root, "example.local")).catch(() => [])).toEqual([]);
    expect(client.rmSession).not.toHaveBeenCalled();
  });

  it("rejects a ZIP with a central entry pointing outside its local records", async () => {
    const root = await collectionRoot();
    const archive = zip();
    const directory = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt32LE(archive.length, directory + 42);
    let requestedName = "";
    const client = {
      executeAssemblySession: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
        requestedName = requestedZipName(options.arguments);
        return sliverpb.ExecuteAssembly.create();
      }),
      lsSession: vi.fn(async () => outputListing(requestedName, archive.length)),
      downloadFileSession: vi.fn(async () => sliverpb.Download.create({ Exists: true, Data: archive })),
      rmSession: vi.fn(),
    } as unknown as AdCollectionClient;
    await expect(collectSharpHound(input(client, session, root))).rejects.toThrow(/complete ZIP/u);
    expect(await readdir(join(root, "example.local")).catch(() => [])).toEqual([]);
  });

  it.each(["missing", "ambiguous", "oversized"] as const)(
    "rejects a %s timestamped SharpHound result before downloading",
    async (caseName) => {
      const root = await collectionRoot();
      const archive = zip();
      let requestedName = "";
      const client = {
        executeAssemblySession: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
          requestedName = requestedZipName(options.arguments);
          return sliverpb.ExecuteAssembly.create();
        }),
        lsSession: vi.fn(async () => {
          if (caseName === "missing") return outputListing("another-collection.zip", archive.length);
          if (caseName === "ambiguous") return outputListing(requestedName, archive.length, [`20261023123457_${requestedName}`]);
          return outputListing(requestedName, 64 * 1024 * 1024);
        }),
        downloadFileSession: vi.fn(),
        rmSession: vi.fn(),
      } as unknown as AdCollectionClient;
      await expect(collectSharpHound(input(client, session, root)))
        .rejects.toThrow(caseName === "oversized" ? /64 MiB limit/u : /one uniquely named ZIP/u);
      expect(client.downloadFileSession).not.toHaveBeenCalled();
      expect(client.rmSession).not.toHaveBeenCalled();
    },
  );

  it("clears execution output when the target reference changes after execution", async () => {
    const root = await collectionRoot();
    const output = Buffer.from("sensitive collector output");
    const client = {
      executeAssemblySession: vi.fn(async () => sliverpb.ExecuteAssembly.create({ Output: output })),
      downloadFileSession: vi.fn(),
      rmSession: vi.fn(),
    } as unknown as AdCollectionClient;
    const request = input(client, session, root);
    request.assertCurrent.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("target changed"); });
    await expect(collectSharpHound(request)).rejects.toThrow(/target changed/u);
    expect(output.every((byte) => byte === 0)).toBe(true);
    expect(client.downloadFileSession).not.toHaveBeenCalled();
  });

  it("reports the collector's known .NET runtime requirement without forwarding output", async () => {
    const root = await collectionRoot();
    const output = Buffer.from("SharpHound Version: 2.17.1.0\nERROR|The .Net Runtime is not compatible with SharpHound. Please update to .Net 4.7.2.\nprivate diagnostic");
    const client = {
      executeAssemblySession: vi.fn(async () => sliverpb.ExecuteAssembly.create({ Output: output })),
      lsSession: vi.fn(),
    } as unknown as AdCollectionClient;
    await expect(collectSharpHound(input(client, session, root))).rejects.toThrow(
      "SharpHound CE requires .NET Framework 4.7.2 or later on this target",
    );
    expect(client.lsSession).not.toHaveBeenCalled();
    expect(output.every((byte) => byte === 0)).toBe(true);
  });

  it("retrieves a beacon ZIP with one capped Download task and saves its decoded bytes", async () => {
    const root = await collectionRoot();
    const archive = zip();
    let remotePath = "";
    let requestedName = "";
    const completedTask = clientpb.BeaconTask.create({
      ID: "download-task", BeaconID: beacon.id, Description: "DownloadReq", State: "completed",
      Response: Buffer.from(sliverpb.Download.encode(sliverpb.Download.create({
        Exists: true, Path: "C:\\Users\\Public\\temporary.zip", Encoder: "gzip", Data: gzipSync(archive),
      })).finish()),
    });
    const client = {
      executeAssemblyBeacon: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
        requestedName = requestedZipName(options.arguments);
        return sliverpb.ExecuteAssembly.create({ Response: { Async: true, TaskID: "execute-task" } });
      }),
      getBeaconTasks: vi.fn(async () => clientpb.BeaconTasks.create({ Tasks: [clientpb.BeaconTask.create({
        ID: "execute-task", BeaconID: beacon.id, Description: "InvokeExecuteAssemblyReq", State: "completed",
      })] })),
      lsBeacon: vi.fn(async () => sliverpb.Ls.create({ Response: { Async: true, TaskID: "ls-task" } })),
      fetchBeaconTaskContent: vi.fn(async () => clientpb.BeaconTask.create({
        ID: "ls-task", BeaconID: beacon.id, Description: "LsReq", State: "completed",
        Response: Buffer.from(sliverpb.Ls.encode(outputListing(requestedName, archive.length)).finish()),
      })),
      downloadAdCollectionBeacon: vi.fn(async (_id: string, path: string) => {
        remotePath = path;
        const decoded = sliverpb.Download.decode(completedTask.Response);
        decoded.Path = path;
        completedTask.Response = Buffer.from(sliverpb.Download.encode(decoded).finish());
        return sliverpb.Download.create({ Response: { Async: true, TaskID: "download-task" } });
      }),
      fetchAdCollectionBeaconTask: vi.fn(async () => completedTask),
      rmAdCollectionBeacon: vi.fn(async () => sliverpb.Rm.create()),
    } as unknown as AdCollectionClient;
    const path = await collectSharpHound(input(client, beacon, root));
    expect(remotePath).toMatch(/^C:\\Users\\Public\\\d{14}_sliver-ad-[0-9a-f-]+\.zip$/u);
    expect(client.fetchBeaconTaskContent).toHaveBeenCalledExactlyOnceWith(beacon.id, "ls-task", "LsReq", 30);
    expect(client.downloadAdCollectionBeacon).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.downloadAdCollectionBeacon).mock.calls[0]![2]).toBe(AD_COLLECTION_BEACON_MAX_BYTES + 1);
    expect(client.fetchAdCollectionBeaconTask).toHaveBeenCalledExactlyOnceWith("download-task", 30);
    expect(await readFile(path)).toEqual(archive);
    expect(client.rmAdCollectionBeacon).toHaveBeenCalledExactlyOnceWith(beacon.id, remotePath, 30);
    expect(completedTask.Response.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects a beacon transfer that expands past its limit without saving partial output", async () => {
    const root = await collectionRoot();
    let remotePath = "";
    let requestedName = "";
    const client = {
      executeAssemblyBeacon: vi.fn(async (_id: string, _assembly: Buffer, options: { arguments?: string[] }) => {
        requestedName = requestedZipName(options.arguments);
        return sliverpb.ExecuteAssembly.create({ Response: { Async: true, TaskID: "execute-task" } });
      }),
      getBeaconTasks: vi.fn(async () => clientpb.BeaconTasks.create({ Tasks: [clientpb.BeaconTask.create({
        ID: "execute-task", BeaconID: beacon.id, Description: "InvokeExecuteAssemblyReq", State: "completed",
      })] })),
      lsBeacon: vi.fn(async () => sliverpb.Ls.create({ Response: { Async: true, TaskID: "ls-task" } })),
      fetchBeaconTaskContent: vi.fn(async () => clientpb.BeaconTask.create({
        ID: "ls-task", BeaconID: beacon.id, Description: "LsReq", State: "completed",
        Response: Buffer.from(sliverpb.Ls.encode(outputListing(requestedName, AD_COLLECTION_BEACON_MAX_BYTES - 1)).finish()),
      })),
      downloadAdCollectionBeacon: vi.fn(async (_id: string, path: string) => {
        remotePath = path;
        return sliverpb.Download.create({ Response: { Async: true, TaskID: "download-task" } });
      }),
      fetchAdCollectionBeaconTask: vi.fn(async () => clientpb.BeaconTask.create({
        ID: "download-task", BeaconID: beacon.id, Description: "DownloadReq", State: "completed",
        Response: Buffer.from(sliverpb.Download.encode(sliverpb.Download.create({
          Exists: true, Path: remotePath, Encoder: "gzip",
          Data: gzipSync(Buffer.alloc(AD_COLLECTION_BEACON_MAX_BYTES + 1)),
        })).finish()),
      })),
    } as unknown as AdCollectionClient;
    await expect(collectSharpHound(input(client, beacon, root))).rejects.toThrow(/limit/u);
    expect(await readdir(join(root, "example.local")).catch(() => [])).toEqual([]);
    expect(client.downloadAdCollectionBeacon).toHaveBeenCalledTimes(1);
  });

  it("uploads an operator-selected Invoke-BloodHound script, runs fixed arguments, and cleans the generated session paths", async () => {
    const root = await collectionRoot();
    const archive = zip();
    const script = Buffer.from("function Invoke-BloodHound { param($CollectionMethods, $Domain, $OutputDirectory, $ZipFilename, $MemCache) }");
    const stdout = Buffer.from("collector output");
    const stderr = Buffer.from("collector diagnostic");
    const calls: string[] = [];
    let remoteScriptPath = "";
    const client = {
      uploadSession: vi.fn(async (_id: string, path: string) => {
        calls.push("upload");
        remoteScriptPath = path;
        return sliverpb.Upload.create({ Path: path, WrittenFiles: 1 });
      }),
      executeSession: vi.fn(async () => {
        calls.push("execute");
        return sliverpb.Execute.create({ Status: 0, Stdout: stdout, Stderr: stderr });
      }),
      lsSession: vi.fn(async () => {
        calls.push("list");
        return outputListing(remoteScriptPath.split("\\").at(-1)!.replace(/\.ps1$/u, ".zip"), archive.length);
      }),
      downloadFileSession: vi.fn(async () => {
        calls.push("download");
        return sliverpb.Download.create({ Exists: true, Data: Buffer.from(archive) });
      }),
      rmSession: vi.fn(async (_id: string, path: string) => { calls.push(`remove:${path}`); return sliverpb.Rm.create(); }),
    } as unknown as AdCollectionClient;
    const path = await collectSharpHound({
      client, target: session, collectorKind: "powershell", script,
      domain: "example.local", collectionMethod: "DCOnly",
      collectionRoot: root, assertCurrent: vi.fn(),
    });

    expect(await readFile(path)).toEqual(archive);
    expect(vi.mocked(client.uploadSession).mock.calls[0]![1]).toMatch(/^C:\\Users\\Public\\sliver-ad-[0-9a-f-]+\.ps1$/u);
    expect(vi.mocked(client.uploadSession).mock.calls[0]![2]).toBe(script);
    expect(vi.mocked(client.uploadSession).mock.calls[0]![3]).toMatchObject({ overwrite: false, isIOC: false });
    const options = vi.mocked(client.executeSession).mock.calls[0]![1];
    expect(options.path).toBe("powershell.exe");
    expect(options.args?.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"]);
    const command = Buffer.from(options.args![5]!, "base64").toString("utf16le");
    expect(command).toContain("Invoke-BloodHound -CollectionMethods 'DCOnly' -Domain 'example.local'");
    expect(command).toContain(`-ZipFilename '${path.split("/").at(-1)}' -MemCache`);
    expect(command).toContain(vi.mocked(client.uploadSession).mock.calls[0]![1]);
    expect(calls[0]).toBe("upload");
    expect(calls[1]).toBe("execute");
    expect(calls[2]).toMatch(/^remove:.*\.ps1$/u);
    expect(calls[3]).toBe("list");
    expect(calls[4]).toBe("download");
    expect(calls[5]).toMatch(/^remove:.*\.zip$/u);
    expect(vi.mocked(client.downloadFileSession).mock.calls[0]![1]).toBe(`${outputDirectory}\\${timestamp}_${path.split("/").at(-1)}`);
    expect(stdout.every((byte) => byte === 0)).toBe(true);
    expect(stderr.every((byte) => byte === 0)).toBe(true);
  });

  it("correlates beacon upload and PowerShell execution before downloading a complete ZIP", async () => {
    const root = await collectionRoot();
    const archive = zip();
    const script = Buffer.from("function Invoke-BloodHound { param($CollectionMethods) }");
    let remoteScriptPath = "";
    let remoteZipPath = "";
    const client = {
      uploadAdCollectionBeacon: vi.fn(async (_id: string, path: string) => {
        remoteScriptPath = path;
        return sliverpb.Upload.create({ Response: { Async: true, TaskID: "upload-task" } });
      }),
      fetchBeaconTaskContent: vi.fn(async (_id: string, taskId: string) => {
        const upload = taskId === "upload-task";
        const listing = taskId === "ls-task";
        return clientpb.BeaconTask.create({
          ID: taskId, BeaconID: beacon.id,
          Description: upload ? "UploadReq" : listing ? "LsReq" : "ExecuteWindowsReq", State: "completed",
          Request: Buffer.from("private request"),
          Response: Buffer.from(upload
            ? sliverpb.Upload.encode(sliverpb.Upload.create({ Path: remoteScriptPath, WrittenFiles: 1 })).finish()
            : listing
              ? sliverpb.Ls.encode(outputListing(remoteScriptPath.split("\\").at(-1)!.replace(/\.ps1$/u, ".zip"), archive.length)).finish()
              : sliverpb.Execute.encode(sliverpb.Execute.create({ Status: 0 })).finish()),
        });
      }),
      executeBeacon: vi.fn(async () => sliverpb.Execute.create({ Response: { Async: true, TaskID: "execute-task" } })),
      lsBeacon: vi.fn(async () => sliverpb.Ls.create({ Response: { Async: true, TaskID: "ls-task" } })),
      downloadAdCollectionBeacon: vi.fn(async (_id: string, path: string) => {
        remoteZipPath = path;
        return sliverpb.Download.create({ Response: { Async: true, TaskID: "download-task" } });
      }),
      fetchAdCollectionBeaconTask: vi.fn(async () => clientpb.BeaconTask.create({
        ID: "download-task", BeaconID: beacon.id, Description: "DownloadReq", State: "completed",
        Response: Buffer.from(sliverpb.Download.encode(sliverpb.Download.create({
          Exists: true, Path: remoteZipPath, Data: gzipSync(archive), Encoder: "gzip",
        })).finish()),
      })),
      rmAdCollectionBeacon: vi.fn(async () => sliverpb.Rm.create()),
    } as unknown as AdCollectionClient;
    const path = await collectSharpHound({
      client, target: beacon, collectorKind: "powershell", script,
      domain: "example.local", collectionMethod: "Default",
      collectionRoot: root, assertCurrent: vi.fn(),
    });

    expect(await readFile(path)).toEqual(archive);
    expect(client.fetchBeaconTaskContent).toHaveBeenCalledWith(beacon.id, "upload-task", "UploadReq", 30);
    expect(client.fetchBeaconTaskContent).toHaveBeenCalledWith(beacon.id, "execute-task", "ExecuteWindowsReq", 30);
    expect(client.fetchBeaconTaskContent).toHaveBeenCalledWith(beacon.id, "ls-task", "LsReq", 30);
    expect(client.rmAdCollectionBeacon).toHaveBeenCalledWith(beacon.id, remoteScriptPath, 30);
    expect(client.rmAdCollectionBeacon).toHaveBeenCalledWith(beacon.id, remoteZipPath, 30);
    expect(remoteZipPath).toBe(`${outputDirectory}\\${timestamp}_${remoteScriptPath.split("\\").at(-1)!.replace(/\.ps1$/u, ".zip")}`);
  });

  it("rejects an oversized PowerShell script before upload", async () => {
    const root = await collectionRoot();
    const client = { uploadSession: vi.fn(), rmSession: vi.fn() } as unknown as AdCollectionClient;
    await expect(collectSharpHound({
      client, target: session, collectorKind: "powershell",
      script: Buffer.alloc(AD_COLLECTION_SCRIPT_MAX_BYTES + 1),
      domain: "example.local", collectionMethod: "Default",
      collectionRoot: root, assertCurrent: vi.fn(),
    })).rejects.toThrow(/at most 4 MiB/u);
    expect(client.uploadSession).not.toHaveBeenCalled();
    expect(client.rmSession).not.toHaveBeenCalled();
  });
});
