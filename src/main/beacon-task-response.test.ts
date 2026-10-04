// @vitest-environment node

import { gzipSync } from "node:zlib";
import { clientpb, sliverpb } from "sliver-script";
import { describe, expect, it, vi } from "vitest";

import { BeaconTaskStore, type TaskOwnershipResolver } from "./beacon-task-store.js";
import { decodeBeaconTaskResponse, BEACON_TASK_RESPONSE_PAGE_CHARACTERS } from "./beacon-task-response.js";

const beaconId = "beacon_response";
const taskId = "task_response";

describe("complete beacon task responses", () => {
  it("does not label ordinary preview whitespace normalization as truncation", async () => {
    const fixture = await savedResponse("PwdReq", sliverpb.Pwd.encode(sliverpb.Pwd.create({
      Path: "  /a\tpath\r\n", Response: {},
    })).finish(), envelope(12));
    const detail = await fixture.store.detail(beaconId, taskId);
    expect(detail.disposition).toMatchObject({ truncated: false });
  });

  it("returns every list row and long field that the preview would truncate", async () => {
    const longName = `first\r\n${"a".repeat(5_000)}  last`;
    const fixture = await savedResponse("LsReq", sliverpb.Ls.encode(sliverpb.Ls.create({
      Path: "/tmp",
      Files: Array.from({ length: 300 }, (_, index) => ({ Name: index === 299 ? longName : `file-${index}` })),
      Response: {},
    })).finish(), envelope(5));

    const result = await completeResponse(fixture.store);
    const decoded = JSON.parse(result.text);
    expect(result.format).toBe("json");
    expect(decoded.Files).toHaveLength(300);
    expect(decoded.Files[299].Name).toBe(longName);
    expect(fixture.content.every((item) => allZero(item.Request) && allZero(item.Response))).toBe(true);
  });

  it("keeps complete execution stdout and stderr across response pages", async () => {
    const stdout = `start\r\n${"out".repeat(50_000)}stdout end`;
    const stderr = `${"err".repeat(30_000)}stderr end`;
    const fixture = await savedResponse("ExecuteReq", sliverpb.Execute.encode(sliverpb.Execute.create({
      Pid: 42, Status: 2, Stdout: Buffer.from(stdout), Stderr: Buffer.from(stderr), Response: {},
    })).finish(), envelope(44));

    const result = await completeResponse(fixture.store);
    const decoded = JSON.parse(result.text);
    expect(decoded.Stdout.data).toBe(stdout);
    expect(decoded.Stderr.data).toBe(stderr);
    expect(decoded.Pid).toBe(42);
    expect(fixture.client.fetchBeaconTaskContent.mock.calls.length).toBeGreaterThan(1);
    expect(fixture.content.every((item) => allZero(item.Request) && allZero(item.Response))).toBe(true);
  });

  it("retains every BOF output record and full binary records", async () => {
    const finalOutput = `end:${"z".repeat(6_000)}`;
    const fixture = await savedResponse("CallExtensionReq", sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      BOFOutputs: [
        ...Array.from({ length: 65 }, (_, index) => ({ Type: 0, Data: Buffer.from(`output ${index}`) })),
        { Type: 0x0d, Data: Buffer.from(finalOutput) },
        { Type: 7, Data: Buffer.from([0, 255, 1, 254]) },
      ], Response: {},
    })).finish(), envelope(91));

    const result = JSON.parse((await completeResponse(fixture.store)).text);
    expect(result.BOFOutputs).toHaveLength(67);
    expect(result.BOFOutputs[65].Data.data).toBe(finalOutput);
    expect(result.BOFOutputs[66].Data).toEqual({ encoding: "hex", bytes: 4, data: "00ff01fe" });
  });

  it("expands complete gzip file data beyond both the row and file preview limits", async () => {
    const file = `first\r\n${"file data\n".repeat(10_000)}last\r\n`;
    const fixture = await savedResponse("DownloadReq", sliverpb.Download.encode(sliverpb.Download.create({
      Path: "/tmp/example.txt", Exists: true, Encoder: "gzip", Data: gzipSync(file), Response: {},
    })).finish(), envelope(7));

    const result = JSON.parse((await completeResponse(fixture.store)).text);
    expect(result.Data).toEqual({ encoding: "utf-8", bytes: Buffer.byteLength(file), data: file });
  });

  it("preserves leading UTF-8 byte order marks in opaque responses and expanded file data", async () => {
    const original = "\uFEFFfull saved text\r\n";
    const opaque = await savedResponse("FutureTaskReq", Buffer.from(original));
    expect((await completeResponse(opaque.store)).text).toBe(original);

    const file = await savedResponse("DownloadReq", sliverpb.Download.encode(sliverpb.Download.create({
      Exists: true, Encoder: "gzip", Data: gzipSync(original), Response: {},
    })).finish(), envelope(7));
    const result = JSON.parse((await completeResponse(file.store)).text);
    expect(result.Data).toEqual({ encoding: "utf-8", bytes: Buffer.byteLength(original), data: original });
  });

  it("redacts sensitive environment values but retains all ordinary environment values", async () => {
    const fixture = await savedResponse("EnvReq", sliverpb.EnvInfo.encode(sliverpb.EnvInfo.create({
      Variables: [
        { Key: "PATH", Value: "/long/path/".repeat(1_000) },
        { Key: "AWS_SECRET_ACCESS_KEY", Value: "do-not-expose" },
        { Key: "PASSWORD", Value: "also-private" },
      ], Response: { Err: "The server reported a partial environment response" },
    })).finish(), envelope(66));

    const result = (await completeResponse(fixture.store)).text;
    expect(result).not.toContain("do-not-expose");
    expect(result).not.toContain("also-private");
    expect(JSON.parse(result).Variables[0].Value).toBe("/long/path/".repeat(1_000));
    expect(JSON.parse(result).Variables.slice(1).map((item: { Value: string }) => item.Value)).toEqual(["[redacted]", "[redacted]"]);
    expect(JSON.parse(result).Response.Err).toBe("The server reported a partial environment response");
  });

  it.each(["FutureTaskReq", "__proto__", "constructor"])("returns complete unknown %s text and never request bytes", async (description) => {
    const original = `${"x".repeat(BEACON_TASK_RESPONSE_PAGE_CHARACTERS - 1)}😀tail\r\n`;
    const fixture = await savedResponse(description, Buffer.from(original), Buffer.from("private request secret"));

    const first = await fixture.store.response(beaconId, taskId);
    const second = await fixture.store.response(beaconId, taskId, first.nextOffset!);
    expect(first.text).toBe("x".repeat(BEACON_TASK_RESPONSE_PAGE_CHARACTERS - 1));
    expect(second.text).toBe("😀tail\r\n");
    expect(first.text + second.text).toBe(original);
    expect(first.totalCharacters).toBe(original.length);
    expect(first.format).toBe("text");
    expect(second.nextOffset).toBeUndefined();
    expect(JSON.stringify([first, second])).not.toContain("private request secret");
    await expect(fixture.store.response(beaconId, taskId, BEACON_TASK_RESPONSE_PAGE_CHARACTERS)).rejects.toThrow(/splits a Unicode/u);
  });

  it("preserves all unknown binary bytes as paged hex", async () => {
    const bytes = Buffer.alloc(70_000, 255);
    const fixture = await savedResponse("FutureBinaryReq", bytes);
    const result = await completeResponse(fixture.store);
    expect(result.format).toBe("hex");
    expect(Buffer.from(result.text, "hex")).toEqual(bytes);
  });

  it.each([
    { ID: "other_task" }, { BeaconID: "other_beacon" }, { Description: "PsReq" }, { State: "pending" },
  ])("rejects fetched task identity or state mismatches %j and zeroizes content", async (overrides) => {
    const fixture = await savedResponse("PwdReq", sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp", Response: {} })).finish(), envelope(12), overrides);
    await expect(fixture.store.response(beaconId, taskId)).rejects.toThrow(/different resource, state, or description/u);
    expect(fixture.content.every((item) => allZero(item.Request) && allZero(item.Response))).toBe(true);
  });

  it("rejects a known task's mismatched request envelope and asynchronous result", () => {
    const bytes = sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp", Response: {} })).finish();
    expect(() => decodeBeaconTaskResponse("PwdReq", envelope(18), bytes)).toThrow(/request type mismatch/u);
    const pending = sliverpb.Pwd.encode(sliverpb.Pwd.create({ Response: { Async: true, TaskID: taskId } })).finish();
    expect(() => decodeBeaconTaskResponse("PwdReq", envelope(12), pending)).toThrow(/asynchronous acknowledgement/u);
  });

  it("verifies locally reviewed request arguments before returning complete response data", async () => {
    const response = sliverpb.Ls.encode(sliverpb.Ls.create({ Path: "/different", Response: {} })).finish();
    const fixture = await savedResponse("LsReq", response, envelope(5,
      sliverpb.LsReq.encode(sliverpb.LsReq.create({ Path: "/different", Request: { Async: true } })).finish()));
    const attribution: TaskOwnershipResolver = () => ({
      ownership: { origin: "unknown", actor: { attribution: "unknown" } },
      operationId: "beacon.filesystem.ls",
      expectedRequest: { operationId: "beacon.filesystem.ls", path: "/expected" },
    });

    await expect(fixture.store.response(beaconId, taskId, 0, attribution)).rejects.toThrow(/saved task request did not match/u);
    expect(fixture.content.every((item) => allZero(item.Request) && allZero(item.Response))).toBe(true);
  });

  it("rejects invalid offsets and pending tasks without a content fetch", async () => {
    const fixture = await savedResponse("FutureTaskReq", Buffer.from("response"));
    for (const offset of [-1, 0.5, NaN, Infinity]) {
      await expect(fixture.store.response(beaconId, taskId, offset)).rejects.toThrow(/offset is invalid/u);
    }
    expect(fixture.client.fetchBeaconTaskContent).not.toHaveBeenCalled();
    await expect(fixture.store.response(beaconId, taskId, 9)).rejects.toThrow(/offset is invalid/u);
    expect(allZero(fixture.content[0]!.Response)).toBe(true);

    const pending = await savedResponse("FutureTaskReq", Buffer.alloc(0), Buffer.alloc(0), {}, "pending");
    await expect(pending.store.response(beaconId, taskId)).rejects.toThrow(/does not have a completed response/u);
    expect(pending.client.fetchBeaconTaskContent).not.toHaveBeenCalled();
  });

  it("rejects content returned after its task catalog was removed", async () => {
    const fixture = await savedResponse("FutureTaskReq", Buffer.from("response"));
    const fetch = fixture.client.fetchBeaconTaskContent.getMockImplementation()!;
    fixture.client.fetchBeaconTaskContent.mockImplementationOnce(async (...args) => {
      const result = await fetch(...args);
      fixture.store.removeBeacon(beaconId);
      return result;
    });
    await expect(fixture.store.response(beaconId, taskId)).rejects.toThrow();
    expect(allZero(fixture.content[0]!.Response)).toBe(true);
  });

  it("fails explicitly instead of clipping oversized compressed file responses", () => {
    const response = sliverpb.Download.encode(sliverpb.Download.create({
      Exists: true, Encoder: "gzip", Data: gzipSync(Buffer.alloc(16 * 1024 * 1024, 97)), Response: {},
    })).finish();
    expect(() => decodeBeaconTaskResponse("DownloadReq", envelope(7), response)).toThrow(/exceeds the safe response viewer resource limit/u);
  });
});

function envelope(type: number, data: Uint8Array = Buffer.alloc(0)): Buffer {
  return Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({ Type: type, Data: Buffer.from(data) })).finish());
}

function allZero(bytes: Uint8Array): boolean { return bytes.every((byte) => byte === 0); }

async function savedResponse(
  description: string,
  response: Uint8Array,
  request: Uint8Array = Buffer.alloc(0),
  fetchedOverrides: Partial<clientpb.BeaconTask> = {},
  state = "completed",
) {
  const metadata = clientpb.BeaconTask.create({
    ID: taskId, BeaconID: beaconId, Description: description, State: state,
    CreatedAt: "100", CompletedAt: state === "completed" ? "102" : "0",
  });
  const content: clientpb.BeaconTask[] = [];
  const client = {
    getBeaconTasks: vi.fn(async () => clientpb.BeaconTasks.create({ Tasks: [metadata] })),
    fetchBeaconTaskContent: vi.fn(async (_beaconId: string, _taskId: string, _description: string) => {
      const fetched = clientpb.BeaconTask.create({
        ...metadata, Request: Buffer.from(request), Response: Buffer.from(response), ...fetchedOverrides,
      });
      content.push(fetched);
      return fetched;
    }),
    fetchBofBeaconTask: vi.fn(),
    cancelBeaconTask: vi.fn(),
  };
  const store = new BeaconTaskStore(client);
  await store.refresh(beaconId);
  return { store, client, content };
}

async function completeResponse(store: BeaconTaskStore) {
  let page = await store.response(beaconId, taskId);
  let text = page.text;
  while (page.nextOffset !== undefined) {
    expect(page.text.length).toBeLessThanOrEqual(BEACON_TASK_RESPONSE_PAGE_CHARACTERS);
    page = await store.response(beaconId, taskId, page.nextOffset);
    text += page.text;
  }
  expect(text.length).toBe(page.totalCharacters);
  return { text, format: page.format };
}
