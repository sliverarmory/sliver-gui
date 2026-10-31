// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { clientpb, sliverpb } from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TargetSummary } from "../shared/target-contracts.js";
import { collectRustHound, rustHoundFailure, type RustHoundClient, type RustHoundProgress } from "./rusthound-collector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const session = { mode: "session", id: "session-1", os: "windows", arch: "amd64", liveness: "active" } as TargetSummary;
const beacon = { mode: "beacon", id: "beacon-1", os: "windows", arch: "amd64", checkinStatus: "on-time" } as TargetSummary;

function zip(): Buffer {
  const name = Buffer.from("20261024_domains.json");
  const contents = Buffer.from(JSON.stringify({ meta: { type: "domains", version: 6 }, data: [
    { Properties: { name: "EXAMPLE.LOCAL", domain: "EXAMPLE.LOCAL", collected: true } },
    { Properties: { name: "TRUST.LOCAL", domain: "TRUST.LOCAL", collected: false } },
  ] }));
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
  it("classifies authentication and discovery errors without echoing native text or credentials", () => {
    expect(rustHoundFailure("GSSAPI ClientCtx::step failed No credentials are available in the security package; password=secret").message)
      .toMatch(/full domain logon/u);
    expect(rustHoundFailure("DsGetDcName failed: secret").message).toMatch(/domain membership and DNS/u);
    expect(rustHoundFailure("invalid credentials password=secret").message).toMatch(/authentication was rejected/u);
    expect(rustHoundFailure("arbitrary secret native diagnostic").message).not.toMatch(/secret/u);
  });

  it("retrieves bounded chunks, checks SHA-256 and ZIP structure, and saves only the client result", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const calls: Array<Record<string, unknown>> = [];
    const args: Buffer[] = [];
    const progress: RustHoundProgress[] = [];
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
    const { path, domain } = await collectRustHound({
      client, target: session, dll: Buffer.from("MZtest"), domain: "example.local",
      ldapFqdn: "dc.example.local", ldaps: true,
      method: "LdapOnly", credentials: { username: "user@example.local", password: "test secret" },
      onProgress: (value) => progress.push(value),
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    });
    expect(await readFile(path)).toEqual(archive);
    expect(domain).toBe("example.local");
    expect(path).toMatch(/\/example\.local\/rusthound-[0-9a-f-]+\.zip$/u);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(calls.map((call) => call["op"])).toEqual(["start", "status", "read", "finish"]);
    expect(calls[0]).toMatchObject({ domain: "example.local", ldapFqdn: "dc.example.local", ldaps: true,
      method: "LdapOnly", username: "user@example.local",
      password: "test secret" });
    expect(args.every((arg) => arg.every((byte) => byte === 0))).toBe(true);
    expect(progress.map((value) => value.phase)).toEqual(["registering", "collecting", "transferring", "transferring", "saving"]);
    expect(progress.at(-1)).toEqual({ phase: "saving", transferredBytes: archive.length, totalBytes: archive.length });
  });

  it("rejects a corrupt collection, aborts the target run, and saves nothing", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const calls: string[] = [];
    let aborted = false;
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(String(request["op"]));
        if (aborted) return response({ state: "error", error: "runId was not found" });
        switch (request["op"]) {
          case "start": return response({ state: "running", runId: "a42" });
          case "status": return response({ state: "complete", runId: "a42", size: archive.length,
            sha256: "0".repeat(64) });
          case "read": return response({ state: "chunk", runId: "a42", offset: 0,
            nextOffset: archive.length, data: archive.toString("base64") });
          case "abort": aborted = true; return response({ state: "aborted", runId: "a42" });
          default: throw new Error("unexpected command");
        }
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({
      client, target: session, dll: Buffer.from("MZtest"), domain: "example.local",
      method: "LdapOnly", credentials: { username: "user", password: "secret" },
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    })).rejects.toThrow(/complete, verified ZIP/u);
    expect(calls.slice(-2)).toEqual(["abort", "status"]);
    expect(await readdir(join(root, "example.local")).catch(() => [])).toEqual([]);
  });

  it("correlates asynchronous beacon registration and every chunk task", async () => {
    const archive = zip();
    const root = await collectionRoot();
    const tasks = new Map<string, clientpb.BeaconTask>();
    const starts: Record<string, unknown>[] = [];
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
          case "start": starts.push(request); result = response({ state: "running", runId: "b11" }); break;
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
    const { path, domain } = await collectRustHound({
      client, target: beacon, dll: Buffer.from("MZtest"),
      method: "LdapOnly",
      collectionRoot: root, assertCurrent: vi.fn(), delay: async () => undefined,
    });
    expect(await readFile(path)).toEqual(archive);
    expect(domain).toBe("example.local");
    expect(starts).toMatchObject([{ currentUser: true, method: "LdapOnly" }]);
    expect(starts[0]).not.toHaveProperty("domain");
    expect(starts[0]).not.toHaveProperty("username");
    expect(starts[0]).not.toHaveProperty("password");
    expect(client.fetchAdCollectorBeaconTask).toHaveBeenCalledTimes(5);
    expect(vi.mocked(client.fetchAdCollectorBeaconTask).mock.calls.map((call) => call[2]))
      .toEqual(["register", "call", "call", "call", "call"]);
  });

  it("interrupts a polling wait and releases its session run despite the aborted signal", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let aborted = false;
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(String(request["op"]));
        if (aborted) return response({ state: "error", error: "runId was not found" });
        if (request["op"] === "abort") aborted = true;
        return response({ state: request["op"] === "abort" ? "aborted" : "running", runId: "a42" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: session, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), assertCurrent: vi.fn(), signal: controller.signal,
      delay: () => { controller.abort(); return new Promise<void>(() => undefined); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["start", "status", "abort", "status"]);
  });

  it("captures a session run ID before handling cancellation during Start", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let aborted = false;
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(String(request["op"]));
        if (aborted) return response({ state: "error", error: "runId was not found" });
        if (request["op"] === "abort") aborted = true;
        if (request["op"] === "start") controller.abort();
        return response({ state: request["op"] === "abort" ? "aborted" : "running", runId: "a42" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: session, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), assertCurrent: vi.fn(), signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["start", "abort", "status"]);
  });

  it("waits for the native worker to release the run after acknowledging abort", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    let statuses = 0;
    const delay = vi.fn(async () => undefined);
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        calls.push(String(request["op"]));
        if (request["op"] === "start") controller.abort();
        if (request["op"] === "status" && ++statuses > 1) return response({ state: "error", error: "runId was not found" });
        return response({ state: request["op"] === "abort" ? "aborted" : "running", runId: "a42" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: session, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), assertCurrent: vi.fn(), signal: controller.signal, delay,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["start", "abort", "status", "status"]);
    expect(delay).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cancels a beacon Start safely when already sent is %s", async (sent) => {
    const controller = new AbortController();
    const calls: string[] = [];
    const tasks = new Map<string, clientpb.BeaconTask>();
    tasks.set("register-1", clientpb.BeaconTask.create({ ID: "register-1", BeaconID: beacon.id, State: "completed",
      Response: Buffer.from(sliverpb.RegisterExtension.encode(sliverpb.RegisterExtension.create({ Response: {} })).finish()) }));
    const client = {
      registerAdCollectorBeacon: vi.fn(async () => sliverpb.RegisterExtension.create({
        Response: { Async: true, TaskID: "register-1", BeaconID: beacon.id },
      })),
      callAdCollectorBeacon: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        const operation = String(request["op"]), id = `${operation}-task`;
        calls.push(operation);
        const output = operation === "status" ? response({ state: "error", error: "runId was not found" })
          : response({ state: operation === "abort" ? "aborted" : "running", runId: "b11" });
        tasks.set(id, clientpb.BeaconTask.create({ ID: id, BeaconID: beacon.id, State: "completed",
          Response: Buffer.from(sliverpb.CallExtension.encode(output).finish()) }));
        if (operation === "start") controller.abort();
        return sliverpb.CallExtension.create({ Response: { Async: true, TaskID: id, BeaconID: beacon.id } });
      }),
      fetchAdCollectorBeaconTask: vi.fn(async (_id: string, id: string) => tasks.get(id)!),
      cancelBeaconTask: vi.fn(async (id: string) => {
        if (sent) throw new Error("already sent");
        return clientpb.BeaconTask.create({ ID: id, BeaconID: beacon.id, State: "canceled" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: beacon, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), assertCurrent: vi.fn(), signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(client.cancelBeaconTask).toHaveBeenCalledWith("start-task", 30);
    expect(calls).toEqual(sent ? ["start", "abort", "status"] : ["start"]);
  });

  it("reports unacknowledged target cleanup instead of claiming cancellation succeeded", async () => {
    const controller = new AbortController();
    const client = {
      registerAdCollectorSession: vi.fn(async () => sliverpb.RegisterExtension.create()),
      callAdCollectorSession: vi.fn(async (_id: string, _name: string, bytes: Buffer) => {
        const request = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
        if (request["op"] === "abort") throw new Error("disconnected");
        controller.abort();
        return response({ state: "running", runId: "a42" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: session, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), assertCurrent: vi.fn(), signal: controller.signal,
    })).rejects.toThrow(/did not acknowledge collection cleanup/u);
  });

  it.each(["register", "start"] as const)("stops all beacon RPCs when the binding changes during %s cancellation", async (phase) => {
    const controller = new AbortController();
    let current = true;
    const client = {
      registerAdCollectorBeacon: vi.fn(async () => {
        if (phase === "register") controller.abort();
        return sliverpb.RegisterExtension.create({ Response: { Async: true, TaskID: "register-1", BeaconID: beacon.id } });
      }),
      callAdCollectorBeacon: vi.fn(async () => {
        controller.abort();
        return sliverpb.CallExtension.create({ Response: { Async: true, TaskID: "start-1", BeaconID: beacon.id } });
      }),
      fetchAdCollectorBeaconTask: vi.fn(async () => clientpb.BeaconTask.create({
        ID: "register-1", BeaconID: beacon.id, State: "completed",
        Response: Buffer.from(sliverpb.RegisterExtension.encode(sliverpb.RegisterExtension.create({ Response: {} })).finish()),
      })),
      cancelBeaconTask: vi.fn(async (id: string) => {
        current = false;
        return clientpb.BeaconTask.create({ ID: id, BeaconID: beacon.id, State: "canceled" });
      }),
    } as unknown as RustHoundClient;
    await expect(collectRustHound({ client, target: beacon, dll: Buffer.from("MZ"), method: "LdapOnly",
      collectionRoot: await collectionRoot(), signal: controller.signal,
      assertCurrent: () => { if (!current) throw new Error("The selected target changed during AD collection"); },
    })).rejects.toThrow("The selected target changed during AD collection");
    expect(client.fetchAdCollectorBeaconTask).toHaveBeenCalledTimes(phase === "register" ? 0 : 1);
    expect(client.callAdCollectorBeacon).toHaveBeenCalledTimes(phase === "register" ? 0 : 1);
  });
});
