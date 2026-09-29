// @vitest-environment node

import { clientpb, sliverpb } from "sliver-script";
import { describe, expect, it, vi } from "vitest";

import type { ExecutionOperationId } from "../shared/execution-contracts.js";
import type { OperationOwnership } from "../shared/operation-contracts.js";
import { BeaconTaskStore, type TaskOwnershipResolver } from "./beacon-task-store.js";
import { EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES } from "./execution-beacon-task.js";
import { EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES } from "./execution-workbench.js";

const beaconId = "beacon_1";
const localOwnership: OperationOwnership = {
  origin: "local",
  ownerWindowId: 7,
  actor: { attribution: "verified", name: "operator" },
};

describe("BeaconTaskStore execution results", () => {
  it("decodes and independently bounds process stdout and stderr without previewing artifact-bearing requests", async () => {
    const stdout = Buffer.alloc(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 3, 65);
    const stderr = Buffer.alloc(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 5, 66);
    const response = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
      Pid: 404, Status: 23, Stdout: stdout, Stderr: stderr,
    })).finish());
    const request = Buffer.alloc(512 * 1_024, 67);
    const fixture = await executionFixture("ExecuteReq", response, { request });

    const detail = await fixture.store.detail(beaconId, "execution_task", () => ({
      ownership: localOwnership, localRequestId: "process_request",
      executionOperationId: "execution.process", processWaited: true,
    }));

    expect(detail.operationId).toBeUndefined();
    expect(detail.disposition).toBeUndefined();
    expect(detail.execution).toMatchObject({ operationId: "execution.process", pid: 404, exitCode: 23 });
    expect(detail.execution?.stdout?.data).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    expect(detail.execution?.stderr?.data).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    expect(detail.execution?.stdout?.truncated).toBe(true);
    expect(detail.execution?.stderr?.truncated).toBe(true);
    expect(detail.execution?.stdout?.data.every((byte) => byte === 65)).toBe(true);
    expect(detail.execution?.stderr?.data.every((byte) => byte === 66)).toBe(true);
    expect(detail.execution?.stdout?.data).not.toBe(stdout);
    expect(detail.errorKind).toBeUndefined();
    expect(request.every((byte) => byte === 0)).toBe(true);
    expect(response.every((byte) => byte === 0)).toBe(true);
    detail.execution?.stdout?.data.fill(0);
    expect(detail.execution?.stderr?.data[0]).toBe(66);
  });

  it("infers only unambiguous external execution descriptions and never invents an external process exit code", async () => {
    const cases: Array<{ description: string; operationId: ExecutionOperationId; response: Buffer }> = [
      { description: "ExecuteReq", operationId: "execution.process", response: Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99, Status: 8, Stdout: Buffer.from("process") })).finish()) },
      { description: "ExecuteWindowsReq", operationId: "execution.process", response: Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99, Status: 8 })).finish()) },
      { description: "InvokeExecuteAssemblyReq", operationId: "execution.assembly", response: Buffer.from(sliverpb.ExecuteAssembly.encode(sliverpb.ExecuteAssembly.create({ Output: Buffer.from("assembly") })).finish()) },
      { description: "InvokeInProcExecuteAssemblyReq", operationId: "execution.assembly", response: Buffer.from(sliverpb.ExecuteAssembly.encode(sliverpb.ExecuteAssembly.create({ Output: Buffer.from("inproc") })).finish()) },
      { description: "SideloadReq", operationId: "execution.sideload", response: Buffer.from(sliverpb.Sideload.encode(sliverpb.Sideload.create({ Result: "sideload", Response: {} })).finish()) },
      { description: "SpawnDllReq", operationId: "execution.spawn-dll", response: Buffer.from(sliverpb.SpawnDll.encode(sliverpb.SpawnDll.create({ Result: "spawn" })).finish()) },
      { description: "InvokeMigrateReq", operationId: "execution.migrate", response: Buffer.from(sliverpb.Migrate.encode(sliverpb.Migrate.create({ Success: true, Pid: 123 })).finish()) },
      { description: "RunAsReq", operationId: "privilege.run-as", response: Buffer.from(sliverpb.RunAs.encode(sliverpb.RunAs.create({ Output: "run-as" })).finish()) },
    ];
    for (const item of cases) {
      const fixture = await executionFixture(item.description, item.response);
      const detail = await fixture.store.detail(beaconId, "execution_task", () => ({
        ownership: { origin: "unknown", actor: { attribution: "unknown" } }, processWaited: true,
      }));
      expect(detail.execution?.operationId).toBe(item.operationId);
      expect(detail.execution?.exitCode).toBeUndefined();
      expect(detail.ownership.origin).toBe("unknown");
      expect(detail.error).toBeUndefined();
      expect(item.response.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("does not infer BOF or ambiguous task execution from an external description", async () => {
    for (const description of ["CallExtensionReq", "TaskReq", "ExecuteReq suffix", "InvokeExecuteAssembly"]) {
      const fixture = await executionFixture(description, Buffer.from("untrusted task response"));
      const detail = await fixture.store.detail(beaconId, "execution_task");
      expect(detail.execution).toBeUndefined();
      expect(detail.operationId).toBeUndefined();
      expect(fixture.client.fetchBeaconTask).not.toHaveBeenCalled();
    }
  });

  it("retains a known execution skeleton for pending tasks without fetching task bytes", async () => {
    const fixture = await executionFixture("CallExtensionReq", Buffer.from("not dispatched"), { state: "pending" });
    const detail = await fixture.store.detail(beaconId, "execution_task", () => ({
      ownership: { origin: "unknown", actor: { attribution: "unknown" } },
      executionOperationId: "bof.execute",
    }));
    expect(detail.execution).toEqual({ operationId: "bof.execute" });
    expect(detail.state).toBe("pending");
    expect(detail.ownership.origin).toBe("unknown");
    expect(fixture.client.fetchBeaconTask).not.toHaveBeenCalled();
  });

  it("requires the exact locally correlated execution description before fetching", async () => {
    const fixture = await executionFixture("CallExtensionReq", Buffer.from("wrong operation"));
    const detail = await fixture.store.detail(beaconId, "execution_task", () => ({
      ownership: localOwnership, executionOperationId: "execution.process",
    }));
    expect(detail.errorKind).toBe("decode-uncertain");
    expect(detail.error).toBe("The task description did not match the locally submitted operation");
    expect(detail.execution?.outputError).toBe(detail.error);
    expect(fixture.client.fetchBeaconTask).not.toHaveBeenCalled();
  });

  it.each([
    { ID: "other_task" },
    { BeaconID: "other_beacon" },
    { Description: "ExecuteWindowsReq" },
    { State: "pending" },
  ])("rejects changed fetched execution identity or metadata %j and zeroizes both buffers", async (fetchedOverrides) => {
    const response = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99 })).finish());
    const request = Buffer.from("secret artifact request");
    const fixture = await executionFixture("ExecuteReq", response, { request, fetchedOverrides });
    const detail = await fixture.store.detail(beaconId, "execution_task");
    expect(detail.errorKind).toBe("decode-uncertain");
    expect(detail.execution?.stdout).toBeUndefined();
    expect(detail.execution?.pid).toBeUndefined();
    expect(detail.execution?.outputError).toBe(detail.error);
    expect(request.every((byte) => byte === 0)).toBe(true);
    expect(response.every((byte) => byte === 0)).toBe(true);
  });

  it("fails closed on malformed, noncanonical, asynchronous, and oversized execution responses", async () => {
    const valid = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99 })).finish());
    const cases = [
      Buffer.from([0x0a, 0x02, 0xff]),
      Buffer.concat([valid, Buffer.from([0xf8, 0x07, 0x01])]),
      Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99, Response: { Async: true } })).finish()),
      Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({ Pid: 99, Response: { TaskID: "another-task" } })).finish()),
      Buffer.alloc(EXECUTION_BEACON_TASK_MAX_RESPONSE_BYTES + 1, 65),
    ];
    for (const response of cases) {
      const request = Buffer.from("SECRET raw request");
      const fixture = await executionFixture("ExecuteReq", response, { request });
      const detail = await fixture.store.detail(beaconId, "execution_task");
      expect(detail.errorKind).toBe("decode-uncertain");
      expect(detail.error).toBe("The beacon task result could not be decoded safely");
      expect(detail.execution?.outputError).toBe(detail.error);
      expect(detail.execution?.stdout).toBeUndefined();
      expect(request.every((byte) => byte === 0)).toBe(true);
      expect(response.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("classifies an execution target rejection without exposing remote error text", async () => {
    const response = Buffer.from(sliverpb.Execute.encode(sliverpb.Execute.create({
      Pid: 99, Response: { Err: "remote secret failure" },
    })).finish());
    const fixture = await executionFixture("ExecuteReq", response);
    const detail = await fixture.store.detail(beaconId, "execution_task");
    expect(detail.errorKind).toBe("target-reported");
    expect(detail.error).toBe("The beacon task response reported an error");
    expect(JSON.stringify(detail)).not.toContain("remote secret");
    expect(response.every((byte) => byte === 0)).toBe(true);
  });

  it("requires exact main-issued BOF provenance and retains independent binary output channels", async () => {
    const response = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      Output: Buffer.from("ignored legacy duplicate"),
      BOFOutputs: [
        { Type: 0, Data: Buffer.from([65, 0, 255]) },
        { Type: 1, Data: Buffer.from([66]) },
        { Type: 0x0d, Data: Buffer.alloc(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 1, 69) },
      ],
      Response: {},
    })).finish());
    const request = Buffer.alloc(256 * 1_024, 70);
    const fixture = await executionFixture("CallExtensionReq", response, { request });
    const detail = await fixture.store.detail(beaconId, "execution_task", () => ({
      // Exact pooled BOF history proves the operation without claiming which
      // operator window originally submitted it.
      ownership: { origin: "unknown", actor: { attribution: "unknown" } },
      executionOperationId: "bof.execute",
    }));
    expect(detail.ownership.origin).toBe("unknown");
    expect(detail.execution?.stdout).toEqual({ data: Buffer.from([65, 0, 255, 66]), truncated: false });
    expect(detail.execution?.stderr?.data).toHaveLength(EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES);
    expect(detail.execution?.stderr?.truncated).toBe(true);
    expect(detail.error).toBeUndefined();
    expect(fixture.client.fetchBofBeaconTask).toHaveBeenCalledWith(beaconId, "execution_task", "CallExtensionReq");
    expect(fixture.client.fetchBeaconTask).not.toHaveBeenCalled();
    expect(request.every((byte) => byte === 0)).toBe(true);
    expect(response.every((byte) => byte === 0)).toBe(true);
  });

  it("rejects malformed and incomplete BOF envelopes without exposing output", async () => {
    const valid = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({ Output: Buffer.from("secret output") })).finish());
    for (const response of [
      Buffer.from([0x0a, 0x02, 0xff]),
      Buffer.concat([valid, Buffer.from([0xf8, 0x07, 0x01])]),
      Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({ Output: Buffer.from("secret output"), Response: { Async: true } })).finish()),
      Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({ Output: Buffer.from("secret output"), Response: { BeaconID: beaconId } })).finish()),
      Buffer.alloc(4 * EXECUTION_WORKBENCH_OUTPUT_MAX_BYTES + 1, 65),
    ]) {
      const fixture = await executionFixture("CallExtensionReq", response);
      const detail = await fixture.store.detail(beaconId, "execution_task", bofAttribution);
      expect(detail.errorKind).toBe("decode-uncertain");
      expect(detail.error).toBe("The beacon task result could not be decoded safely");
      expect(detail.execution?.stdout).toBeUndefined();
      expect(response.every((byte) => byte === 0)).toBe(true);
      expect(fixture.request.every((byte) => byte === 0)).toBe(true);
    }
  });

  it("retains valid partial BOF output with a fixed target-reported error", async () => {
    const response = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      BOFOutputs: [{ Type: 0, Data: Buffer.from("partial output") }],
      Response: { Err: "secret BOF rejection" },
    })).finish());
    const fixture = await executionFixture("CallExtensionReq", response);
    const detail = await fixture.store.detail(beaconId, "execution_task", bofAttribution);
    expect(detail.errorKind).toBe("target-reported");
    expect(detail.execution?.stdout?.data).toEqual(Buffer.from("partial output"));
    expect(detail.execution?.outputError).toBe("The beacon task response reported an error");
    expect(JSON.stringify(detail)).not.toContain("secret BOF");
    expect(response.every((byte) => byte === 0)).toBe(true);
  });

  it("reports a retryable fetch failure with a known execution operation", async () => {
    const fixture = await executionFixture("ExecuteReq", Buffer.alloc(0));
    fixture.client.fetchBeaconTask.mockRejectedValueOnce(new Error("private transport error"));
    const detail = await fixture.store.detail(beaconId, "execution_task");
    expect(detail.errorKind).toBe("decode-uncertain");
    expect(detail.execution).toEqual({ operationId: "execution.process", outputError: "The beacon task result could not be fetched" });
    expect(JSON.stringify(detail)).not.toContain("private transport");
  });
});

const bofAttribution: TaskOwnershipResolver = () => ({ ownership: localOwnership, executionOperationId: "bof.execute" });

async function executionFixture(
  description: string,
  response: Buffer,
  options: { request?: Buffer; state?: string; fetchedOverrides?: Partial<clientpb.BeaconTask> } = {},
) {
  const metadata = clientpb.BeaconTasks.create({ Tasks: [task("execution_task", options.state ?? "completed", 10, description)] });
  const request = options.request ?? Buffer.from("raw execution request");
  const fetched = clientpb.BeaconTask.create({ ...metadata.Tasks[0], Request: request, Response: response, ...options.fetchedOverrides });
  const client = fakeClient(metadata, fetched);
  const store = new BeaconTaskStore(client);
  await store.refresh(beaconId);
  return { store, client, request, response };
}

describe("BeaconTaskStore", () => {
  it("keeps bounded metadata only and projects local versus unknown ownership", async () => {
    const response = clientpb.BeaconTasks.create({
      Tasks: [
        task("task_2", "sent", 20, "  ping\nwith control\u0000text  "),
        task("task_1", "pending", 10, "external task"),
      ],
    });
    response.Tasks[0]!.Request = Buffer.from("RAW-REQUEST-SECRET");
    response.Tasks[0]!.Response = Buffer.from("RAW-RESPONSE-SECRET");
    const client = fakeClient(response);
    const store = new BeaconTaskStore(client);

    await store.refresh(beaconId);
    const page = store.list(beaconId, {}, (taskId) => taskId === "task_2"
      ? { ownership: localOwnership, localRequestId: "request_2", operationId: "target.ping" }
      : { ownership: { origin: "unknown", actor: { attribution: "unknown" } } });

    expect(page.items.map((item) => item.taskId)).toEqual(["task_2", "task_1"]);
    expect(page.items[0]).toMatchObject({
      state: "sent",
      description: "ping with control text",
      localRequestId: "request_2",
      ownership: { origin: "local" },
    });
    expect(page.items[1]).toMatchObject({ ownership: { origin: "unknown", actor: { attribution: "unknown" } } });
    expect(JSON.stringify(page)).not.toContain("RAW-");
    expect([...response.Tasks[0]!.Request]).toEqual(new Array(response.Tasks[0]!.Request.length).fill(0));
    expect([...response.Tasks[0]!.Response]).toEqual(new Array(response.Tasks[0]!.Response.length).fill(0));
  });

  it("keeps bounded task pages on an immutable cursor snapshot across refresh and pin changes", async () => {
    const initial = clientpb.BeaconTasks.create({
      Tasks: [task("task_1", "pending", 1), task("task_2", "pending", 2), task("task_3", "pending", 3)],
    });
    const identical = clientpb.BeaconTasks.create({
      Tasks: [task("task_1", "pending", 1), task("task_2", "pending", 2), task("task_3", "pending", 3)],
    });
    const updated = clientpb.BeaconTasks.create({
      Tasks: [
        task("task_1", "pending", 1),
        task("task_2", "pending", 2),
        task("task_3", "pending", 3),
        task("new_task", "pending", 4),
      ],
    });
    const client = fakeClient(initial);
    client.getBeaconTasks
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(identical)
      .mockResolvedValueOnce(updated);
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId, ["task_1"]);
    const first = store.list(beaconId, { limit: 2 });
    expect(first.items.map(({ taskId }) => taskId)).toEqual(["task_1", "task_3"]);
    await store.refresh(beaconId, ["task_2"]);
    expect(store.list(beaconId, { cursor: first.page.nextCursor!, limit: 2 }).items)
      .toMatchObject([{ taskId: "task_2" }]);

    const beforeInsertion = store.list(beaconId, { limit: 2 });
    await store.refresh(beaconId, ["task_2"]);
    expect(store.list(beaconId, { cursor: beforeInsertion.page.nextCursor!, limit: 2 }).items)
      .toMatchObject([{ taskId: "task_1" }]);
    expect(store.list(beaconId, { limit: 2 }).items.map(({ taskId }) => taskId))
      .toEqual(["task_2", "new_task"]);
  });

  it("binds task cursors to one window incarnation and isolates each owner's cursor budget", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create({
      Tasks: Array.from({ length: 10 }, (_, index) => task(`task_${index}`, "pending", index + 1)),
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);
    const ownerA = { ownerKey: "epoch:window-a", accessKey: "epoch:window-a:attempt-1" };
    const ownerB = { ownerKey: "epoch:window-b", accessKey: "epoch:window-b:attempt-1" };
    const pageA = store.list(beaconId, { limit: 1 }, undefined, ownerA);
    expect(pageA.page.nextCursor).toBeDefined();
    expect(() => store.list(beaconId, { cursor: pageA.page.nextCursor!, limit: 1 }, undefined, ownerB))
      .toThrow(/cursor is stale/u);

    for (let index = 0; index < 8; index += 1) {
      store.list(
        beaconId,
        { limit: 1 },
        undefined,
        { ownerKey: ownerB.ownerKey, accessKey: `${ownerB.accessKey}:${index}` },
      );
    }
    expect(store.list(beaconId, { cursor: pageA.page.nextCursor!, limit: 1 }, undefined, ownerA).items)
      .toHaveLength(1);
  });

  it("rejects duplicate IDs and a task that belongs to another beacon", async () => {
    const duplicates = fakeClient(clientpb.BeaconTasks.create({
      Tasks: [task("same", "pending", 1), task("same", "pending", 2)],
    }));
    await expect(new BeaconTaskStore(duplicates).refresh(beaconId)).rejects.toThrow(/Duplicate/);

    const crossBeacon = fakeClient(clientpb.BeaconTasks.create({
      Tasks: [{ ...task("task", "pending", 1), BeaconID: "another_beacon" }],
    }));
    await expect(new BeaconTaskStore(crossBeacon).refresh(beaconId)).rejects.toThrow(/different beacon/);
  });

  it("requires an exact present beacon ID in list metadata and zeroizes rejected payloads", async () => {
    for (const [invalidBeaconId, expectedError] of [
      ["", /Invalid beacon ID/u],
      ["another_beacon", /different beacon/u],
    ] as const) {
      const requestBytes = Buffer.from("rejected-list-request");
      const responseBytes = Buffer.from("rejected-list-response");
      const client = fakeClient(clientpb.BeaconTasks.create({
        Tasks: [clientpb.BeaconTask.create({
          ...task("rejected_list_task", "pending", 10),
          BeaconID: invalidBeaconId,
          Request: requestBytes,
          Response: responseBytes,
        })],
      }));

      await expect(new BeaconTaskStore(client).refresh(beaconId)).rejects.toThrow(expectedError);
      expect([...requestBytes]).toEqual(new Array(requestBytes.length).fill(0));
      expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
    }
  });

  it("decodes a completed local task and zeroizes fetched protobuf bytes", async () => {
    const response = clientpb.BeaconTasks.create({ Tasks: [task("task_ping", "completed", 10, "Ping")] });
    const requestBytes = Buffer.from("request-secret");
    const responseBytes = Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 77 })).finish());
    const fetched = clientpb.BeaconTask.create({
      ...response.Tasks[0],
      Request: requestBytes,
      Response: responseBytes,
    });
    const client = fakeClient(response, fetched);
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const detail = await store.detail(beaconId, "task_ping", () => ({
      ownership: localOwnership,
      localRequestId: "request_ping",
      operationId: "target.ping",
      expectedPingNonce: 77,
    }));

    expect(detail).toMatchObject({
      operationId: "target.ping",
      disposition: {
        kind: "structured-detail",
        fields: [{ label: "Nonce", value: 77 }],
      },
    });
    expect([...requestBytes]).toEqual(new Array(requestBytes.length).fill(0));
    expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
  });

  it("serializes a dirty rerun and never publishes the superseded pending snapshot", async () => {
    const first = deferred<clientpb.BeaconTasks>();
    const second = deferred<clientpb.BeaconTasks>();
    const client = fakeClient(clientpb.BeaconTasks.create());
    client.getBeaconTasks
      .mockImplementationOnce(async () => first.promise)
      .mockImplementationOnce(async () => second.promise);
    const store = new BeaconTaskStore(client);

    const initialRefresh = store.refresh(beaconId);
    const fresherRefresh = store.refresh(beaconId);
    expect(client.getBeaconTasks).toHaveBeenCalledOnce();
    first.resolve(clientpb.BeaconTasks.create({ Tasks: [task("race_task", "pending", 10)] }));
    await vi.waitFor(() => expect(client.getBeaconTasks).toHaveBeenCalledTimes(2));

    expect(() => store.list(beaconId)).toThrow(/Refresh/u);
    second.resolve(clientpb.BeaconTasks.create({ Tasks: [task("race_task", "completed", 10)] }));
    await Promise.all([initialRefresh, fresherRefresh]);
    expect(store.task(beaconId, "race_task").state).toBe("completed");
  });

  it("invalidates an in-flight refresh on remove without overwriting a later catalog", async () => {
    const stale = deferred<clientpb.BeaconTasks>();
    const staleRequest = Buffer.from("stale-request");
    const staleResponse = Buffer.from("stale-response");
    const client = fakeClient(clientpb.BeaconTasks.create());
    client.getBeaconTasks
      .mockImplementationOnce(async () => stale.promise)
      .mockResolvedValueOnce(clientpb.BeaconTasks.create({
        Tasks: [task("current_task", "completed", 20)],
      }));
    const store = new BeaconTaskStore(client);

    const invalidatedRefresh = store.refresh(beaconId);
    store.removeBeacon(beaconId);
    await store.refresh(beaconId);
    stale.resolve(clientpb.BeaconTasks.create({
      Tasks: [{
        ...task("stale_task", "pending", 10),
        Request: staleRequest,
        Response: staleResponse,
      }],
    }));
    await invalidatedRefresh;

    expect(store.task(beaconId, "current_task").state).toBe("completed");
    expect(() => store.task(beaconId, "stale_task")).toThrow(/Unknown/u);
    expect([...staleRequest]).toEqual(new Array(staleRequest.length).fill(0));
    expect([...staleResponse]).toEqual(new Array(staleResponse.length).fill(0));
  });

  it("invalidates every in-flight refresh on clear", async () => {
    const stale = deferred<clientpb.BeaconTasks>();
    const client = fakeClient(clientpb.BeaconTasks.create());
    client.getBeaconTasks.mockImplementationOnce(async () => stale.promise);
    const store = new BeaconTaskStore(client);

    const refresh = store.refresh(beaconId);
    store.clear();
    stale.resolve(clientpb.BeaconTasks.create({ Tasks: [task("stale_task", "pending", 10)] }));
    await refresh;

    expect(() => store.list(beaconId)).toThrow(/Refresh/u);
  });

  it("prunes absent beacon catalogs and invalidates their in-flight refreshes", async () => {
    const removedBeaconId = "beacon_removed";
    const stale = deferred<clientpb.BeaconTasks>();
    const staleResponse = Buffer.from("stale-response");
    const client = fakeClient(clientpb.BeaconTasks.create());
    client.getBeaconTasks.mockImplementation(async (requestedBeaconId: string) => {
      if (requestedBeaconId === beaconId) {
        return clientpb.BeaconTasks.create({ Tasks: [task("kept_task", "pending", 20)] });
      }
      if (client.getBeaconTasks.mock.calls.filter(([id]) => id === removedBeaconId).length === 1) {
        return clientpb.BeaconTasks.create({
          Tasks: [{ ...task("removed_task", "pending", 10), BeaconID: removedBeaconId }],
        });
      }
      return stale.promise;
    });
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);
    await store.refresh(removedBeaconId);
    const invalidatedRefresh = store.refresh(removedBeaconId);

    store.pruneAbsentBeacons([beaconId]);
    stale.resolve(clientpb.BeaconTasks.create({
      Tasks: [{
        ...task("late_task", "completed", 30),
        BeaconID: removedBeaconId,
        Response: staleResponse,
      }],
    }));
    await invalidatedRefresh;

    expect(store.task(beaconId, "kept_task").state).toBe("pending");
    expect(() => store.list(removedBeaconId)).toThrow(/Refresh/u);
    expect([...staleResponse]).toEqual(new Array(staleResponse.length).fill(0));
  });

  it("validates an authoritative prune set before changing any catalog", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create({ Tasks: [task("kept_task", "pending", 10)] }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    expect(() => store.pruneAbsentBeacons([beaconId, "../invalid"])).toThrow(/Invalid beacon ID/u);
    expect(store.task(beaconId, "kept_task").state).toBe("pending");
  });

  it("does not retain generation tombstones during beacon churn and rejects a late reused-ID refresh", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create());
    client.getBeaconTasks.mockImplementation(async (requestedBeaconId: string) => clientpb.BeaconTasks.create({
      Tasks: [clientpb.BeaconTask.create({
        ID: "churn_task",
        BeaconID: requestedBeaconId,
        State: "pending",
        Description: "ExternalTask",
        CreatedAt: "10",
      })],
    }));
    const store = new BeaconTaskStore(client);

    for (let index = 0; index < 600; index += 1) {
      const churnBeaconId = `churn_${String(index).padStart(4, "0")}`;
      await store.refresh(churnBeaconId);
      store.removeBeacon(churnBeaconId);
    }
    const internals = store as unknown as {
      catalogs: Map<string, unknown>;
      refreshes: Map<string, unknown>;
      beaconGenerations?: Map<string, number>;
    };
    expect(internals.catalogs.size).toBe(0);
    expect(internals.refreshes.size).toBe(0);
    expect(internals.beaconGenerations).toBeUndefined();

    const reusedBeaconId = "beacon_reused";
    const stale = deferred<clientpb.BeaconTasks>();
    const staleResponse = Buffer.from("stale-response");
    client.getBeaconTasks.mockReset();
    client.getBeaconTasks
      .mockImplementationOnce(async () => stale.promise)
      .mockResolvedValueOnce(clientpb.BeaconTasks.create({
        Tasks: [clientpb.BeaconTask.create({
          ID: "current_task",
          BeaconID: reusedBeaconId,
          State: "completed",
          Description: "ExternalTask",
          CreatedAt: "20",
        })],
      }));

    const invalidatedRefresh = store.refresh(reusedBeaconId);
    store.removeBeacon(reusedBeaconId);
    await store.refresh(reusedBeaconId);
    stale.resolve(clientpb.BeaconTasks.create({
      Tasks: [clientpb.BeaconTask.create({
        ID: "stale_task",
        BeaconID: reusedBeaconId,
        State: "pending",
        Description: "ExternalTask",
        CreatedAt: "10",
        Response: staleResponse,
      })],
    }));
    await invalidatedRefresh;

    expect(store.task(reusedBeaconId, "current_task").state).toBe("completed");
    expect(() => store.task(reusedBeaconId, "stale_task")).toThrow(/Unknown/u);
    expect([...staleResponse]).toEqual(new Array(staleResponse.length).fill(0));
  });

  it("decodes only the closed external Description map, including valid empty responses", async () => {
    const cases = [
      {
        description: "Ping",
        operationId: "target.ping",
        response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 9 })).finish()),
      },
      {
        description: "SetEnvReq",
        operationId: "target.env-set",
        response: Buffer.from(sliverpb.SetEnv.encode(sliverpb.SetEnv.create({ Response: {} })).finish()),
      },
      {
        description: "UnsetEnvReq",
        operationId: "target.env-unset",
        response: Buffer.from(sliverpb.UnsetEnv.encode(sliverpb.UnsetEnv.create({ Response: {} })).finish()),
      },
      { description: "ReconfigureReq", operationId: "beacon.reconfigure", response: Buffer.alloc(0) },
      { description: "OpenSession", operationId: "beacon.open-session", response: Buffer.alloc(0) },
      {
        description: "PwdReq",
        operationId: "beacon.filesystem.pwd",
        response: Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp" })).finish()),
      },
      {
        description: "LsReq",
        operationId: "beacon.filesystem.ls",
        response: Buffer.from(sliverpb.Ls.encode(sliverpb.Ls.create({ Exists: true })).finish()),
      },
      {
        description: "PsReq",
        operationId: "beacon.process.list",
        response: Buffer.from(sliverpb.Ps.encode(sliverpb.Ps.create()).finish()),
      },
      {
        description: "IfconfigReq",
        operationId: "beacon.network.interfaces",
        response: Buffer.from(sliverpb.Ifconfig.encode(sliverpb.Ifconfig.create()).finish()),
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const taskId = `external_${index}`;
      const metadata = clientpb.BeaconTasks.create({
        Tasks: [task(taskId, "completed", 10, testCase.description)],
      });
      const client = fakeClient(metadata, clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        Response: testCase.response,
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      const detail = await store.detail(beaconId, taskId);
      expect(detail.operationId).toBe(testCase.operationId);
      expect(detail.disposition).toBeDefined();
      expect(detail.errorKind).toBeUndefined();
    }

    const unknownMetadata = clientpb.BeaconTasks.create({
      Tasks: [task("unknown_external", "completed", 10, "ping")],
    });
    const unknownClient = fakeClient(unknownMetadata);
    const unknownStore = new BeaconTaskStore(unknownClient);
    await unknownStore.refresh(beaconId);
    const unknownDetail = await unknownStore.detail(beaconId, "unknown_external");
    expect(unknownDetail.operationId).toBeUndefined();
    expect(unknownDetail.disposition).toBeUndefined();
    expect(unknownClient.fetchBeaconTask).not.toHaveBeenCalled();
  });

  it("decodes bounded, sanitized filesystem, process, and interface dispositions", async () => {
    const cases = [
      {
        taskId: "pwd_result",
        description: "PwdReq",
        operationId: "beacon.filesystem.pwd" as const,
        response: Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({
          Path: "/tmp\nworking",
        })).finish()),
        expected: {
          kind: "structured-detail",
          fields: [{ label: "Path", value: "/tmp working" }],
          truncated: true,
        },
      },
      {
        taskId: "ls_result",
        description: "LsReq",
        operationId: "beacon.filesystem.ls" as const,
        response: Buffer.from(sliverpb.Ls.encode(sliverpb.Ls.create({
          Path: "/tmp",
          Exists: true,
          Files: Array.from({ length: 257 }, (_, index) => ({
            Name: index === 0 ? "first\nfile" : `file-${index}`,
            IsDir: index === 1,
            Size: String(index),
            ModTime: "1",
            Mode: "-rw-r--r--",
            Link: "",
            Uid: "1000",
            Gid: "1000",
          })),
        })).finish()),
        expected: {
          kind: "table",
          columns: ["Name", "Type", "Size", "Modified", "Mode", "Link", "UID", "GID"],
          rows: expect.arrayContaining([["first file", "File", "0", "1", "-rw-r--r--", "", "1000", "1000"]]),
          truncated: true,
        },
      },
      {
        taskId: "ps_result",
        description: "PsReq",
        operationId: "beacon.process.list" as const,
        response: Buffer.from(sliverpb.Ps.encode(sliverpb.Ps.create({
          Processes: [{
            Pid: 7,
            Ppid: 1,
            Executable: "/usr/bin/test\nprocess",
            Owner: "user",
            Architecture: "amd64",
            SessionID: 2,
            CmdLine: ["test", "--flag\u0000value"],
          }],
        })).finish()),
        expected: {
          kind: "table",
          columns: ["PID", "PPID", "Executable", "Owner", "Architecture", "Session", "Command line"],
          rows: [[7, 1, "/usr/bin/test process", "user", "amd64", 2, "test --flag value"]],
          truncated: true,
        },
      },
      {
        taskId: "ifconfig_result",
        description: "IfconfigReq",
        operationId: "beacon.network.interfaces" as const,
        response: Buffer.from(sliverpb.Ifconfig.encode(sliverpb.Ifconfig.create({
          NetInterfaces: [{ Index: 3, Name: "eth\n0", MAC: "00:11:22:33:44:55", IPAddresses: ["10.0.0.1"] }],
        })).finish()),
        expected: {
          kind: "table",
          columns: ["Index", "Name", "MAC", "Addresses"],
          rows: [[3, "eth 0", "00:11:22:33:44:55", "10.0.0.1"]],
          truncated: true,
        },
      },
    ];

    for (const testCase of cases) {
      const metadata = clientpb.BeaconTasks.create({
        Tasks: [task(testCase.taskId, "completed", 10, testCase.description)],
      });
      const responseBytes = testCase.response;
      const client = fakeClient(metadata, clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        Response: responseBytes,
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      const detail = await store.detail(beaconId, testCase.taskId, () => ({
        ownership: localOwnership,
        localRequestId: `request_${testCase.taskId}`,
        operationId: testCase.operationId,
      }));

      expect(detail).toMatchObject({ operationId: testCase.operationId, disposition: testCase.expected });
      if (testCase.operationId === "beacon.filesystem.ls") {
        expect(detail.disposition?.kind === "table" ? detail.disposition.rows : []).toHaveLength(256);
      }
      expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
    }
  });

  it("rejects a present target error on a common beacon read without exposing its text", async () => {
    const metadata = clientpb.BeaconTasks.create({
      Tasks: [task("pwd_target_error", "completed", 10, "PwdReq")],
    });
    const responseBytes = Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({
      Response: { Err: "sensitive target path failure" },
    })).finish());
    const client = fakeClient(metadata, clientpb.BeaconTask.create({
      ...metadata.Tasks[0],
      Response: responseBytes,
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const detail = await store.detail(beaconId, "pwd_target_error", () => ({
      ownership: localOwnership,
      localRequestId: "request_pwd_target_error",
      operationId: "beacon.filesystem.pwd",
    }));

    expect(detail).toMatchObject({
      operationId: "beacon.filesystem.pwd",
      errorKind: "target-reported",
      error: "The beacon task response reported an error",
    });
    expect(detail.error).not.toContain("sensitive");
    expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
  });

  it("requires the canonical empty response for reconfigure and open-session tasks", async () => {
    for (const [index, description] of ["ReconfigureReq", "OpenSession"].entries()) {
      const taskId = `noncanonical_empty_${index}`;
      const response = Buffer.from([0x78, 0x01]);
      const metadata = clientpb.BeaconTasks.create({
        Tasks: [task(taskId, "completed", 10, description)],
      });
      const client = fakeClient(metadata, clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        Response: response,
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      await expect(store.detail(beaconId, taskId)).resolves.toMatchObject({
        errorKind: "decode-uncertain",
        error: "The beacon task result did not match the expected empty response",
      });
      expect([...response]).toEqual(new Array(response.length).fill(0));
    }
  });

  it("classifies target-reported errors separately from fetch, content, and decode uncertainty", async () => {
    const targetError = await completedPingDetail({
      fetched: clientpb.BeaconTask.create({
        ID: "classified_task",
        BeaconID: beaconId,
        Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({
          Response: { Err: "sensitive implant detail" },
        })).finish()),
      }),
    });
    expect(targetError).toMatchObject({
      errorKind: "target-reported",
      error: "The beacon task response reported an error",
    });
    expect(targetError.error).not.toContain("sensitive");

    const decodeError = await completedPingDetail({
      fetched: clientpb.BeaconTask.create({
        ID: "classified_task",
        BeaconID: beaconId,
        Response: Buffer.from([0xff]),
      }),
    });
    expect(decodeError).toMatchObject({
      errorKind: "decode-uncertain",
      error: "The beacon task result could not be decoded safely",
    });

    const contentError = await completedPingDetail({
      fetched: clientpb.BeaconTask.create({
        ID: "different_task",
        BeaconID: beaconId,
        Response: Buffer.from([1]),
      }),
    });
    expect(contentError).toMatchObject({
      errorKind: "decode-uncertain",
      error: "The server returned task content for a different resource",
    });

    const fetchError = await completedPingDetail({ fetchError: new Error("secret transport detail") });
    expect(fetchError).toMatchObject({
      errorKind: "decode-uncertain",
      error: "The beacon task result could not be fetched",
    });
    expect(fetchError.error).not.toContain("secret");
  });

  it("requires an exact present beacon ID in fetched detail and zeroizes rejected payloads", async () => {
    for (const invalidBeaconId of ["", "another_beacon"]) {
      const metadata = clientpb.BeaconTasks.create({
        Tasks: [task("identity_detail", "completed", 10, "Ping")],
      });
      const requestBytes = Buffer.from("rejected-detail-request");
      const responseBytes = Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 9 })).finish());
      const client = fakeClient(metadata, clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        BeaconID: invalidBeaconId,
        Request: requestBytes,
        Response: responseBytes,
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      await expect(store.detail(beaconId, "identity_detail")).resolves.toMatchObject({
        errorKind: "decode-uncertain",
        error: "The server returned task content for a different resource",
      });
      expect([...requestBytes]).toEqual(new Array(requestBytes.length).fill(0));
      expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
    }
  });

  it("does not treat unrelated environment protobuf fields as successful responses", async () => {
    for (const [index, testCase] of [
      { description: "SetEnvReq", operationId: "target.env-set" },
      { description: "UnsetEnvReq", operationId: "target.env-unset" },
    ].entries()) {
      const taskId = `environment_junk_${index}`;
      const metadata = clientpb.BeaconTasks.create({
        Tasks: [task(taskId, "completed", 10, testCase.description)],
      });
      // Unknown field 15 is valid protobuf but does not contain Sliver's
      // required embedded Response message.
      const client = fakeClient(metadata, clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        Response: Buffer.from([0x78, 0x01]),
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      await expect(store.detail(beaconId, taskId)).resolves.toMatchObject({
        operationId: testCase.operationId,
        errorKind: "decode-uncertain",
        error: "The beacon task result could not be decoded safely",
      });
    }
  });

  it("enforces the 64 KiB decoded-result budget and zeroizes an oversized response", async () => {
    const metadata = clientpb.BeaconTasks.create({
      Tasks: [task("oversized_ping", "completed", 10, "Ping")],
    });
    const responseBytes = Buffer.alloc(64 * 1024 + 1, 0x41);
    const client = fakeClient(metadata, clientpb.BeaconTask.create({
      ...metadata.Tasks[0],
      Response: responseBytes,
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    await expect(store.detail(beaconId, "oversized_ping")).resolves.toMatchObject({
      errorKind: "decode-uncertain",
      error: "The beacon task result is too large to preview safely",
    });
    expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
  });

  it("bounds concurrent raw task-detail fetches before allocating another response", async () => {
    const metadata = clientpb.BeaconTasks.create({
      Tasks: [task("bounded_detail", "completed", 10, "Ping")],
    });
    const gate = deferred<void>();
    const client = fakeClient(metadata);
    client.fetchBeaconTask.mockImplementation(async () => {
      await gate.promise;
      return clientpb.BeaconTask.create({
        ...metadata.Tasks[0],
        Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 9 })).finish()),
      });
    });
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const admitted = Array.from({ length: 8 }, () => store.detail(beaconId, "bounded_detail"));
    await vi.waitFor(() => expect(client.fetchBeaconTask).toHaveBeenCalledTimes(8));
    await expect(store.detail(beaconId, "bounded_detail")).rejects.toThrow(/Too many beacon task details/u);
    expect(client.fetchBeaconTask).toHaveBeenCalledTimes(8);
    gate.resolve(undefined);
    await expect(Promise.all(admitted)).resolves.toHaveLength(8);
  });

  it("rejects a local description or ping nonce that does not match the submitted operation", async () => {
    const metadata = clientpb.BeaconTasks.create({
      Tasks: [task("local_binding", "completed", 10, "SetEnvReq")],
    });
    const client = fakeClient(metadata, clientpb.BeaconTask.create({
      ...metadata.Tasks[0],
      Response: Buffer.from(sliverpb.Ping.encode(sliverpb.Ping.create({ Nonce: 11 })).finish()),
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const descriptionMismatch = await store.detail(beaconId, "local_binding", () => ({
      ownership: localOwnership,
      localRequestId: "request_binding",
      operationId: "target.ping",
      expectedPingNonce: 11,
    }));
    expect(descriptionMismatch).toMatchObject({
      errorKind: "decode-uncertain",
      error: "The task description did not match the locally submitted operation",
    });
    expect(client.fetchBeaconTask).not.toHaveBeenCalled();

    metadata.Tasks[0]!.Description = "Ping";
    await store.refresh(beaconId);
    const nonceMismatch = await store.detail(beaconId, "local_binding", () => ({
      ownership: localOwnership,
      localRequestId: "request_binding",
      operationId: "target.ping",
      expectedPingNonce: 12,
    }));
    expect(nonceMismatch).toMatchObject({
      errorKind: "decode-uncertain",
      error: "The beacon task result could not be decoded safely",
    });
  });

  it("retains older active work ahead of terminal history within the bounded catalog", async () => {
    const completed = Array.from({ length: 500 }, (_, index) => task(
      `completed_${index}`,
      "completed",
      index + 2,
    ));
    const client = fakeClient(clientpb.BeaconTasks.create({
      Tasks: [...completed, task("old_pending", "pending", 1)],
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    expect(store.task(beaconId, "old_pending").state).toBe("pending");
    expect(store.list(beaconId, { limit: 1 })).toMatchObject({
      items: [{ taskId: "old_pending" }],
      page: { total: 501, truncated: true },
    });
  });

  it("pins an exact locally correlated task even when more than 500 active tasks exist", async () => {
    const tasks = Array.from({ length: 501 }, (_, index) => task(
      `active_${index}`,
      "pending",
      index + 1,
    ));
    const client = fakeClient(clientpb.BeaconTasks.create({ Tasks: tasks }));
    const store = new BeaconTaskStore(client);

    await store.refresh(beaconId, ["active_0"]);

    expect(store.task(beaconId, "active_0").state).toBe("pending");
    expect(store.list(beaconId, { limit: 1 })).toMatchObject({
      items: [{ taskId: "active_0" }],
      page: { total: 501, truncated: true },
    });
  });

  it("cancels only an authoritatively pending task and reports the dispatch race", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create({
      Tasks: [task("pending_task", "pending", 10, "Ping"), task("sent_task", "sent", 9, "Ping")],
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    await store.cancel(beaconId, "pending_task");
    expect(client.cancelBeaconTask).toHaveBeenCalledWith("pending_task");
    await expect(store.cancel(beaconId, "sent_task")).rejects.toThrow(/already have been dispatched/);
    expect(client.cancelBeaconTask).toHaveBeenCalledOnce();
  });

  it("advertises cancellation for reviewed execution and common beacon task names", async () => {
    const descriptions = [
      "InvokeExecuteAssemblyReq",
      "InvokeInProcExecuteAssemblyReq",
      "InvokeMigrateReq",
      "TaskReq",
      "PwdReq",
      "LsReq",
      "PsReq",
      "IfconfigReq",
    ];
    const client = fakeClient(clientpb.BeaconTasks.create({
      Tasks: descriptions.map((description, index) =>
        task(`m4_cancel_${index}`, "pending", 20 - index, description)),
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    for (const [index] of descriptions.entries()) {
      expect(store.task(beaconId, `m4_cancel_${index}`).cancellation).toEqual({ available: true });
    }
  });

  it("zeroizes cancellation response payloads", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create({ Tasks: [task("pending_task", "pending", 10, "Ping")] }));
    const requestBytes = Buffer.from("cancel-request-secret");
    const responseBytes = Buffer.from("cancel-response-secret");
    client.cancelBeaconTask.mockResolvedValueOnce(clientpb.BeaconTask.create({
      ID: "pending_task",
      BeaconID: beaconId,
      State: "canceled",
      Request: requestBytes,
      Response: responseBytes,
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    await store.cancel(beaconId, "pending_task");
    expect([...requestBytes]).toEqual(new Array(requestBytes.length).fill(0));
    expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
  });

  it("single-flights concurrent cancellation callers and projects ownership independently", async () => {
    const metadata = clientpb.BeaconTasks.create({ Tasks: [task("cancel_once", "pending", 10, "Ping")] });
    const gate = deferred<void>();
    const client = fakeClient(metadata);
    client.cancelBeaconTask.mockImplementationOnce(async () => {
      await gate.promise;
      return clientpb.BeaconTask.create({ ...metadata.Tasks[0], State: "canceled" });
    });
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);
    const first = store.cancel(beaconId, "cancel_once", () => ({
      ownership: localOwnership,
      localRequestId: "request-a",
    }));
    const second = store.cancel(beaconId, "cancel_once", () => ({
      ownership: { origin: "unknown", actor: { attribution: "unknown" } },
    }));
    await vi.waitFor(() => expect(client.cancelBeaconTask).toHaveBeenCalledOnce());
    gate.resolve(undefined);

    await expect(first).resolves.toMatchObject({ state: "canceled", localRequestId: "request-a" });
    await expect(second).resolves.toMatchObject({ state: "canceled", ownership: { origin: "unknown" } });
    await expect(store.cancel(beaconId, "cancel_once")).resolves.toMatchObject({ state: "canceled" });
    expect(client.cancelBeaconTask).toHaveBeenCalledOnce();
  });

  it("returns an exact canceled response even if the shared catalog is invalidated in flight", async () => {
    const metadata = clientpb.BeaconTasks.create({ Tasks: [task("cancel_detached", "pending", 10, "Ping")] });
    const gate = deferred<void>();
    const client = fakeClient(metadata);
    client.cancelBeaconTask.mockImplementationOnce(async () => {
      await gate.promise;
      return clientpb.BeaconTask.create({ ...metadata.Tasks[0], State: "canceled" });
    });
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const cancellation = store.cancel(beaconId, "cancel_detached");
    await vi.waitFor(() => expect(client.cancelBeaconTask).toHaveBeenCalledOnce());
    store.removeBeacon(beaconId);
    gate.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({ taskId: "cancel_detached", state: "canceled" });
    expect(client.cancelBeaconTask).toHaveBeenCalledOnce();
  });

  it("bounds distinct cancellation flights while still coalescing identical callers", async () => {
    const metadata = clientpb.BeaconTasks.create({
      Tasks: Array.from({ length: 9 }, (_, index) => task(`bounded_cancel_${index}`, "pending", 20 - index, "Ping")),
    });
    const gate = deferred<void>();
    const client = fakeClient(metadata);
    client.cancelBeaconTask.mockImplementation(async (taskId: string) => {
      await gate.promise;
      return clientpb.BeaconTask.create({
        ...metadata.Tasks.find((candidate) => candidate.ID === taskId),
        State: "canceled",
      });
    });
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    const admitted = metadata.Tasks.slice(0, 8).map((candidate) => store.cancel(beaconId, candidate.ID));
    await vi.waitFor(() => expect(client.cancelBeaconTask).toHaveBeenCalledTimes(8));
    const duplicate = store.cancel(beaconId, metadata.Tasks[0]!.ID);
    await expect(store.cancel(beaconId, metadata.Tasks[8]!.ID)).rejects.toThrow(/Too many beacon task cancellations/u);
    expect(client.cancelBeaconTask).toHaveBeenCalledTimes(8);
    gate.resolve(undefined);
    await expect(Promise.all([...admitted, duplicate])).resolves.toHaveLength(9);
  });

  it("bounds distinct task-inventory refreshes and evicts the least-recently-used unretained catalog", async () => {
    const gate = deferred<void>();
    const client = {
      getBeaconTasks: vi.fn(async (requestedBeaconId: string) => {
        if (requestedBeaconId.startsWith("gated_")) await gate.promise;
        return clientpb.BeaconTasks.create({
          Tasks: [clientpb.BeaconTask.create({
            ID: `task_${requestedBeaconId}`,
            BeaconID: requestedBeaconId,
            State: "pending",
            Description: "Ping",
            CreatedAt: "10",
          })],
        });
      }),
      fetchBeaconTask: vi.fn(),
      fetchBofBeaconTask: vi.fn(),
      cancelBeaconTask: vi.fn(),
    };
    const store = new BeaconTaskStore(client);
    const admitted = Array.from({ length: 16 }, (_, index) => store.refresh(`gated_${index}`));
    await vi.waitFor(() => expect(client.getBeaconTasks).toHaveBeenCalledTimes(16));
    await expect(store.refresh("gated_16")).rejects.toThrow(/Too many distinct beacon task inventories/u);
    for (let index = 0; index < 16; index += 1) store.removeBeacon(`gated_${index}`);
    await expect(store.refresh("gated_after_invalidation")).rejects.toThrow(/Too many distinct beacon task inventories/u);
    gate.resolve(undefined);
    await Promise.all(admitted);

    for (let index = 0; index < 513; index += 1) {
      await store.refresh(`catalog_${index}`, [], []);
    }
    const internals = store as unknown as { catalogs: Map<string, unknown> };
    expect(internals.catalogs.size).toBe(512);
    expect(() => store.task("catalog_0", "task_catalog_0")).toThrow(/Refresh/u);
    expect(store.task("catalog_512", "task_catalog_512")).toMatchObject({ taskId: "task_catalog_512" });
  });

  it("fails closed for reconfigure and unreviewed pending task cancellation", async () => {
    const client = fakeClient(clientpb.BeaconTasks.create({
      Tasks: [
        task("reconfigure_pending", "pending", 10, "ReconfigureReq"),
        task("unknown_pending", "pending", 9, "UnknownReq"),
      ],
    }));
    const store = new BeaconTaskStore(client);
    await store.refresh(beaconId);

    expect(store.task(beaconId, "reconfigure_pending").cancellation).toMatchObject({
      available: false,
      reason: expect.stringMatching(/server timing metadata/u),
    });
    await expect(store.cancel(beaconId, "reconfigure_pending")).rejects.toThrow(/cannot be canceled safely/u);
    await expect(store.cancel(beaconId, "unknown_pending")).rejects.toThrow(/not been reviewed/u);
    expect(client.cancelBeaconTask).not.toHaveBeenCalled();
  });

  it("requires an exact present beacon ID in cancellation responses and zeroizes rejected payloads", async () => {
    for (const invalidBeaconId of ["", "another_beacon"]) {
      const client = fakeClient(clientpb.BeaconTasks.create({
        Tasks: [task("identity_cancel", "pending", 10, "Ping")],
      }));
      const requestBytes = Buffer.from("rejected-cancel-request");
      const responseBytes = Buffer.from("rejected-cancel-response");
      client.cancelBeaconTask.mockResolvedValueOnce(clientpb.BeaconTask.create({
        ID: "identity_cancel",
        BeaconID: invalidBeaconId,
        State: "canceled",
        Request: requestBytes,
        Response: responseBytes,
      }));
      const store = new BeaconTaskStore(client);
      await store.refresh(beaconId);

      await expect(store.cancel(beaconId, "identity_cancel")).rejects.toThrow(/outcome could not be confirmed/u);
      expect([...requestBytes]).toEqual(new Array(requestBytes.length).fill(0));
      expect([...responseBytes]).toEqual(new Array(responseBytes.length).fill(0));
    }
  });
});

async function completedPingDetail(options: {
  fetched?: clientpb.BeaconTask;
  fetchError?: Error;
}) {
  const metadata = clientpb.BeaconTasks.create({
    Tasks: [task("classified_task", "completed", 10, "Ping")],
  });
  const client = fakeClient(metadata, options.fetched);
  if (options.fetchError) client.fetchBeaconTask.mockRejectedValueOnce(options.fetchError);
  const store = new BeaconTaskStore(client);
  await store.refresh(beaconId);
  return store.detail(beaconId, "classified_task");
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function task(id: string, state: string, createdAt: number, description = "task"): clientpb.BeaconTask {
  return clientpb.BeaconTask.create({
    ID: id,
    BeaconID: beaconId,
    State: state,
    CreatedAt: String(createdAt),
    SentAt: state === "sent" || state === "completed" ? String(createdAt + 1) : "0",
    CompletedAt: state === "completed" ? String(createdAt + 2) : "0",
    Description: description,
  });
}

function fakeClient(tasks: clientpb.BeaconTasks, fetched?: clientpb.BeaconTask) {
  return {
    getBeaconTasks: vi.fn(async (_beaconId: string) => tasks),
    fetchBeaconTask: vi.fn(async () => fetched ?? tasks.Tasks[0]!),
    fetchBofBeaconTask: vi.fn(async () => fetched ?? tasks.Tasks[0]!),
    cancelBeaconTask: vi.fn(async (taskId: string) => clientpb.BeaconTask.create({
      ID: taskId,
      BeaconID: beaconId,
      State: "canceled",
    })),
  };
}
