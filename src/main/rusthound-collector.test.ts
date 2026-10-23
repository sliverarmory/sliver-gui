// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { clientpb, sliverpb } from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TargetSummary } from "../shared/target-contracts.js";
import { collectRustHound, type RustHoundClient } from "./rusthound-collector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const session = { mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active" } as TargetSummary;
const beacon = { mode: "beacon", id: "beacon-1", os: "windows", arch: "amd64", checkinStatus: "on-time" } as TargetSummary;

function zip(): Buffer {
  const name = Buffer.from("users.json");
  const contents = Buffer.from('{"users":[]}\n');
  const checksum = crc32(contents);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24); central.writeUInt16LE(name.length, 28);
  const directoryOffset = local.length + name.length + contents.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(directoryOffset, 16);
  return Buffer.concat([local, name, contents, central, name, end]);
}

function response(value: Record<string, unknown>): sliverpb.CallExtension {
  return sliverpb.CallExtension.create({ Output: Buffer.from(JSON.stringify({ version: 1, ...value })) });
}

async function collectionRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rusthound-collection-"));
  roots.push(root);
  return join(root, "gui", "ad-explorer", "collections");
}

describe("in-memory RustHound collection", () => {
  it("retrieves bounded chunks, checks SHA-256 and ZIP structure, and saves only the client result", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const calls: Array<Record<string, unknown>> = [];
    const args: Buffer[] = [];
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        args.push(bytes);
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(request);
        switch (request["op"]) {
          case "start": return response({ state: "running", runId: "a42" });
          case "status": return response({ state: "complete", runId: "a42", size: archive.length,
            sha256: createHash("sha256").update(archive).digest("hex") });
          case "read": return response({ state: "chunk", runId: "a42", offset: request["offset"],
            nextOffset: archive.length, data: archive.toString("base64") });
          case "finish": return response({ state: "finished", runId: "a42" });
          default: throw new Error("unexpected command");
        }
      }),
    } as unknown as RustHoundClient;
    const path = await collectRustHound({
      client, target: session, dll: Buffer.from("MZtest"), domain: "example.local",
      ldapFqdn: "dc.example.local", ldaps: true,
      method: "LdapOnly", username: "user@example.local", password: "test secret",
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    });
    expect(await readFile(path)).toEqual(archive);
    expect(path).toMatch(/\/example\.local\/rusthound-[0-9a-f-]+\.zip$/u);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(calls.map((call) => call["op"])).toEqual(["start", "status", "read", "finish"]);
    expect(calls[0]).toMatchObject({ domain: "example.local", ldapFqdn: "dc.example.local", ldaps: true,
      method: "LdapOnly", username: "user@example.local",
      password: "test secret" });
    expect(args.every((arg) => arg.every((byte) => byte === 0))).toBe(true);
  });

  it("rejects a corrupt collection, aborts the target run, and saves nothing", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const calls: string[] = [];
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(String(request["op"]));
        switch (request["op"]) {
          case "start": return response({ state: "running", runId: "a42" });
          case "status": return response({ state: "complete", runId: "a42", size: archive.length,
            sha256: "0".repeat(64) });
          case "read": return response({ state: "chunk", runId: "a42", offset: 0,
            nextOffset: archive.length, data: archive.toString("base64") });
          case "abort": return response({ state: "aborted", runId: "a42" });
          default: throw new Error("unexpected command");
        }
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({
      client, target: session, dll: Buffer.from("MZtest"), domain: "example.local",
      method: "LdapOnly", username: "user", password: "secret",
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    })).rejects.toThrow(/complete, verified ZIP/u);
    expect(calls.at(-1)).toBe("abort");
    expect(await readdir(join(root, "example.local")).catch(() => [])).toEqual([]);
  });

  it("correlates asynchronous beacon registration and every chunk task", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const tasks = new Map<string, clientpb.BeaconTask>();
    tasks.set("register-1", clientpb.BeaconTask.create({
      ID: "register-1", BeaconID: beacon.id, Description: "RegisterExtensionReq", State: "completed",
      Response: Buffer.from(sliverpb.RegisterExtension.encode(sliverpb.RegisterExtension.create({ Response: {} })).finish()),
    }));
    const client = {
      registerAdCollectorBeacon: vi.fn(async () => sliverpb.RegisterExtension.create({
        Response: { Async: true, TaskID: "register-1", BeaconID: beacon.id },
      })),
      callAdCollectorBeacon: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        const taskId = `call-${tasks.size}`;
        let result: sliverpb.CallExtension;
        switch (request["op"]) {
          case "start": result = response({ state: "running", runId: "b11" }); break;
          case "status": result = response({ state: "complete", runId: "b11", size: archive.length,
            sha256: createHash("sha256").update(archive).digest("hex") }); break;
          case "read": result = response({ state: "chunk", runId: "b11", offset: 0,
            nextOffset: archive.length, data: archive.toString("base64") }); break;
          case "finish": result = response({ state: "finished", runId: "b11" }); break;
          default: throw new Error("unexpected command");
        }
        tasks.set(taskId, clientpb.BeaconTask.create({
          ID: taskId, BeaconID: beacon.id, Description: "CallExtensionReq", State: "completed",
          Response: Buffer.from(sliverpb.CallExtension.encode(result).finish()),
        }));
        return sliverpb.CallExtension.create({ Response: { Async: true, TaskID: taskId, BeaconID: beacon.id } });
      }),
      fetchAdCollectorBeaconTask: vi.fn(async (_id: string, taskId: string) => tasks.get(taskId)!),
    } as unknown as RustHoundClient;
    const path = await collectRustHound({
      client, target: beacon, dll: Buffer.from("MZtest"), domain: "example.local",
      method: "LdapOnly", username: "user", password: "secret",
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    });
    expect(await readFile(path)).toEqual(archive);
    expect(client.fetchAdCollectorBeaconTask).toHaveBeenCalledTimes(5);
    expect(vi.mocked(client.fetchAdCollectorBeaconTask).mock.calls.map((call) => call[2]))
      .toEqual(["register", "call", "call", "call", "call"]);
  });
});
