// @vitest-environment node

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STREAM_CLOSING_GRACE_MILLISECONDS,
  STREAM_MAX_FRAME_BYTES,
  STREAM_PROTOCOL_VERSION,
  type StreamClientFrame,
  type StreamServerFrame,
} from "../shared/stream-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import {
  StreamAccessError,
  StreamCapacityError,
  StreamManager,
  type MainStreamEndpoint,
  type StartMainStreamEndpoint,
  type StartMainStreamEndpointContext,
  type StreamAttachmentPort,
  type StreamManagerLimits,
  type StreamOwnerBinding,
} from "./stream-manager.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("StreamManager admission and attachment capabilities", () => {
  it("enforces window, backend, process, and reservation quotas without leaking admission", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, {
      maxStreamsPerWindow: 1,
      maxStreamsPerBackend: 2,
      maxStreamsPerProcess: 2,
      maxReservedBytesPerWindow: 64,
      maxReservedBytesPerBackend: 128,
      maxReservedBytesPerProcess: 128,
    });
    const first = manager.prepareSessionShell(preparation(binding(), resolvedStarter()));

    expect(() => manager.prepareSessionShell(preparation(binding({ targetId: "two" }), resolvedStarter())))
      .toThrow(StreamCapacityError);
    expect(manager.metricsForWindow(1)).toMatchObject({
      activeStreams: 1,
      reservedBytes: 64,
      rejectedStreams: "1",
    });

    const secondBinding = binding({ ownerWindowId: 2, targetId: "two" });
    const second = manager.prepareSessionShell(preparation(secondBinding, resolvedStarter()));
    expect(() => manager.prepareSessionShell(preparation(
      binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "three" }),
      resolvedStarter(),
    ))).toThrow(StreamCapacityError);
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 2, reservedBytes: 128 });

    await manager.actOnSessionShell(binding(), { resourceId: first.resourceId, action: "close" });
    await manager.actOnSessionShell(secondBinding, { resourceId: second.resourceId, action: "close" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, reservedBytes: 0 });

    const replacement = manager.prepareSessionShell(preparation(
      binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "three" }),
      resolvedStarter(),
    ));
    await manager.actOnSessionShell(
      binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "three" }),
      { resourceId: replacement.resourceId, action: "close" },
    );
    await manager.close();
  });

  it("rolls back atomically when the clock, ID allocator, or ticket allocation fails", () => {
    const scheduler = new ManualScheduler();
    const badClock = createManager(scheduler, {}, { now: () => Number.NaN });
    expect(() => badClock.prepareSessionShell(preparation(binding(), resolvedStarter()))).toThrow(/clock/);
    expect(badClock.metricsForProcess()).toMatchObject({ activeStreams: 0, reservedBytes: 0 });

    const badId = createManager(scheduler, {}, { createOpaqueId: () => "not-an-id" });
    expect(() => badId.prepareSessionShell(preparation(binding(), resolvedStarter()))).toThrow(/ID generator/);
    expect(badId.metricsForProcess()).toMatchObject({ activeStreams: 0, reservedBytes: 0 });

    let calls = 0;
    const badTicket = createManager(scheduler, {}, {
      createOpaqueId: () => calls++ === 0 ? opaqueId(1) : "not-an-id",
    });
    expect(() => badTicket.prepareSessionShell(preparation(binding(), resolvedStarter()))).toThrow(/ID generator/);
    expect(badTicket.metricsForProcess()).toMatchObject({ activeStreams: 0, reservedBytes: 0 });
    expect(badTicket.listSessionShells(binding()).resources).toEqual([]);
  });

  it("accounts backend admission independently from window and process capacity", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, {
      maxStreamsPerBackend: 1,
      maxStreamsPerProcess: 4,
      maxReservedBytesPerBackend: 64,
      maxReservedBytesPerProcess: 256,
    });
    const firstBinding = binding({ ownerWindowId: 1, targetId: "one" });
    const first = manager.prepareSessionShell(preparation(firstBinding, resolvedStarter()));
    expect(() => manager.prepareSessionShell(preparation(
      binding({ ownerWindowId: 2, targetId: "two" }),
      resolvedStarter(),
    ))).toThrow(StreamCapacityError);
    const otherBackend = binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "three" });
    const second = manager.prepareSessionShell(preparation(otherBackend, resolvedStarter()));
    expect(manager.metricsForBackend({ backendId: "backend-a", backendEpoch: 1 })).toMatchObject({
      activeStreams: 1,
      rejectedStreams: "1",
    });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 2 });
    await manager.actOnSessionShell(firstBinding, { resourceId: first.resourceId, action: "close" });
    await manager.actOnSessionShell(otherBackend, { resourceId: second.resourceId, action: "close" });
    await manager.close();
  });

  it("binds a one-use ticket to the exact window, process, frame, document, backend, incarnation, and target", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const owner = binding();
    const plan = manager.prepareSessionShell(preparation(owner, resolvedStarter()));
    const variants: StreamOwnerBinding[] = [
      binding({ ownerWindowId: 2 }),
      binding({ rendererProcessId: 12 }),
      binding({ rendererFrameToken: "frame-b" }),
      binding({ rendererDocumentId: "document-b" }),
      binding({ backendId: "backend-b" }),
      binding({ connectionIncarnation: 8 }),
      binding({ targetId: "session-b" }),
      binding({ fingerprint: "b".repeat(64) }),
    ];

    for (const attacker of variants) {
      const rejectedPort = new FakePort();
      expect(() => manager.attach({
        binding: attacker,
        attachmentToken: plan.attachment.attachmentToken,
        port: rejectedPort,
      })).toThrow(StreamAccessError);
      expect(rejectedPort.closed).toBe(true);
    }

    const port = new FakePort();
    const streamId = manager.attach({
      binding: owner,
      attachmentToken: plan.attachment.attachmentToken,
      port,
    });
    expect(streamId).toHaveLength(43);
    expect(port.frames[0]).toMatchObject({ type: "ready", streamId });

    const replay = new FakePort();
    expect(() => manager.attach({
      binding: owner,
      attachmentToken: plan.attachment.attachmentToken,
      port: replay,
    })).toThrow(StreamAccessError);
    expect(replay.closed).toBe(true);
    await manager.close();
  });

  it("does not consume a valid ticket if allocating the per-attachment stream ID fails", async () => {
    const scheduler = new ManualScheduler();
    let calls = 0;
    const ids = [opaqueId(1), opaqueId(2), "bad-id", opaqueId(3)];
    const manager = createManager(scheduler, {}, { createOpaqueId: () => ids[calls++] ?? opaqueId(calls + 4) });
    const plan = manager.prepareSessionShell(preparation(binding(), resolvedStarter()));
    const failedPort = new FakePort();
    expect(() => manager.attach({
      binding: binding(),
      attachmentToken: plan.attachment.attachmentToken,
      port: failedPort,
    })).toThrow(/ID generator/);
    expect(failedPort.closed).toBe(true);

    const workingPort = new FakePort();
    expect(() => manager.attach({
      binding: binding(),
      attachmentToken: plan.attachment.attachmentToken,
      port: workingPort,
    })).not.toThrow();
    await manager.close();
  });

  it("expires unused tickets and closes the prepared resource", async () => {
    vi.useFakeTimers();
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, { ticketTtlMilliseconds: 10 });
    const plan = manager.prepareSessionShell(preparation(binding(), resolvedStarter()));

    await vi.advanceTimersByTimeAsync(11);
    await scheduler.flush();
    expect(manager.listSessionShells(binding()).resources).toEqual([]);
    expect(manager.metricsForProcess()).toMatchObject({
      activeStreams: 0,
      closedStreams: "1",
      closesByReason: { "handshake-timeout": "1" },
    });

    const port = new FakePort();
    expect(() => manager.attach({
      binding: binding(),
      attachmentToken: plan.attachment.attachmentToken,
      port,
    })).toThrow(StreamAccessError);
    expect(port.closed).toBe(true);
    await manager.close();

    let now = 0;
    const delayedTimerManager = createManager(scheduler, { ticketTtlMilliseconds: 10 }, { now: () => now });
    const delayedPlan = delayedTimerManager.prepareSessionShell(preparation(binding(), resolvedStarter()));
    now = 11;
    const delayedPort = new FakePort();
    expect(() => delayedTimerManager.attach({
      binding: binding(), attachmentToken: delayedPlan.attachment.attachmentToken, port: delayedPort,
    })).toThrow(StreamAccessError);
    await scheduler.flush();
    expect(delayedTimerManager.metricsForProcess()).toMatchObject({
      activeStreams: 0,
      closesByReason: { "handshake-timeout": "1" },
    });
    await delayedTimerManager.close();
  });
});

describe("StreamManager explicit window ownership transfer", () => {
  it("moves attached, detached, and prepared shells with live accounting and supports reverse transfer", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const source = binding();
    const destination = binding({
      ownerWindowId: 2,
      rendererProcessId: 22,
      rendererFrameToken: "frame-popout",
      rendererDocumentId: "document-popout",
      connectionIncarnation: 1,
    });
    const writeGate = deferred<void>();
    const activeEndpoint = endpointHarness({ write: () => writeGate.promise });
    let activeContext: StartMainStreamEndpointContext | undefined;
    const active = await openShell(manager, scheduler, {
      binding: source,
      receiveCreditBytes: 1,
      starter: async (context) => {
        activeContext = context;
        return activeEndpoint.endpoint;
      },
    });
    active.port.send(dataFrame(active.streamId, 0, arrayBuffer([1, 2, 3, 4])));
    expect(activeContext?.emitOutput(Uint8Array.from([5, 6, 7, 8]))).toBe(true);
    await scheduler.flush();

    const detached = await openShell(manager, scheduler, { binding: source });
    detached.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "close",
      streamId: detached.streamId,
      disposition: "detach",
    });
    const prepared = manager.prepareSessionShell(preparation(source, resolvedStarter()));
    const backendBefore = manager.metricsForBackend({ backendId: source.backendId, backendEpoch: source.backendEpoch });
    const processBefore = manager.metricsForProcess();
    expect(manager.metricsForWindow(source.ownerWindowId)).toMatchObject({
      activeStreams: 3,
      attachedStreams: 1,
      detachedStreams: 1,
      reservedBytes: 192,
      queuedBytes: 4,
      inFlightBytes: 4,
    });

    const transferred = manager.transferSessionShells(source, destination);
    expect(Object.isFrozen(transferred)).toBe(true);
    expect(new Set(transferred)).toEqual(new Set([active.resourceId, detached.resourceId, prepared.resourceId]));
    expect(lastFrame(active.port, "closed")).toMatchObject({
      reason: "operator-detach",
      disposition: "detached",
    });
    expect(manager.listSessionShells(source).resources).toEqual([]);
    expect(manager.listSessionShells(destination).resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceId: active.resourceId, state: "detached" }),
      expect.objectContaining({ resourceId: detached.resourceId, state: "detached" }),
      expect.objectContaining({ resourceId: prepared.resourceId, state: "detached" }),
    ]));
    expect(manager.metricsForWindow(source.ownerWindowId)).toMatchObject({
      activeStreams: 0,
      reservedBytes: 0,
      queuedBytes: 0,
      inFlightBytes: 0,
    });
    expect(manager.metricsForWindow(destination.ownerWindowId)).toMatchObject({
      activeStreams: 3,
      attachedStreams: 0,
      detachedStreams: 3,
      reservedBytes: 192,
      queuedBytes: 4,
      inFlightBytes: 4,
    });
    expect(manager.metricsForBackend({ backendId: source.backendId, backendEpoch: source.backendEpoch }))
      .toMatchObject({
        activeStreams: backendBefore.activeStreams,
        reservedBytes: backendBefore.reservedBytes,
        queuedBytes: backendBefore.queuedBytes,
        inFlightBytes: backendBefore.inFlightBytes,
        openedStreams: backendBefore.openedStreams,
        closedStreams: backendBefore.closedStreams,
      });
    expect(manager.metricsForProcess()).toMatchObject({
      activeStreams: processBefore.activeStreams,
      reservedBytes: processBefore.reservedBytes,
      queuedBytes: processBefore.queuedBytes,
      inFlightBytes: processBefore.inFlightBytes,
      openedStreams: processBefore.openedStreams,
      closedStreams: processBefore.closedStreams,
    });

    const staleSourcePort = new FakePort();
    expect(() => manager.attach({
      binding: source,
      attachmentToken: prepared.attachment.attachmentToken,
      port: staleSourcePort,
    })).toThrow(StreamAccessError);
    expect(staleSourcePort.closed).toBe(true);
    const staleDestinationPort = new FakePort();
    expect(() => manager.attach({
      binding: destination,
      attachmentToken: prepared.attachment.attachmentToken,
      port: staleDestinationPort,
    })).toThrow(StreamAccessError);
    expect(staleDestinationPort.closed).toBe(true);
    await expect(manager.actOnSessionShell(source, {
      resourceId: prepared.resourceId,
      action: "attach",
    })).rejects.toThrow(StreamAccessError);

    const destinationAction = await manager.actOnSessionShell(destination, {
      resourceId: prepared.resourceId,
      action: "attach",
    });
    const destinationPort = new FakePort();
    const destinationStreamId = manager.attach({
      binding: destination,
      attachmentToken: destinationAction.attachment!.attachmentToken,
      port: destinationPort,
    });
    destinationPort.send(startFrame(destinationStreamId, 16));
    await scheduler.flush();
    expect(lastFrame(destinationPort, "opened")).toBeDefined();

    const returned = manager.transferSessionShells(destination, source);
    expect(Object.isFrozen(returned)).toBe(true);
    expect(new Set(returned)).toEqual(new Set(transferred));
    expect(lastFrame(destinationPort, "closed")).toMatchObject({
      reason: "operator-detach",
      disposition: "detached",
    });
    expect(manager.listSessionShells(destination).resources).toEqual([]);
    expect(manager.listSessionShells(source).resources).toHaveLength(3);

    const sourceAction = await manager.actOnSessionShell(source, {
      resourceId: prepared.resourceId,
      action: "attach",
    });
    const returnedPort = new FakePort();
    const returnedStreamId = manager.attach({
      binding: source,
      attachmentToken: sourceAction.attachment!.attachmentToken,
      port: returnedPort,
    });
    returnedPort.send(startFrame(returnedStreamId, 16));
    await scheduler.flush();
    expect(lastFrame(returnedPort, "opened")).toBeDefined();
    await manager.closeWindow(destination.ownerWindowId);
    expect(manager.listSessionShells(source).resources).toHaveLength(3);

    writeGate.resolve();
    await scheduler.flush();
    await manager.close();
  });

  it("keeps an opening endpoint detached after transfer and reattaches it without a second start", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const source = binding();
    const destination = binding({
      ownerWindowId: 2,
      rendererProcessId: 22,
      rendererFrameToken: "frame-popout",
      rendererDocumentId: "document-popout",
    });
    const endpoint = endpointHarness();
    const startGate = deferred<MainStreamEndpoint>();
    const start = vi.fn(() => startGate.promise);
    const plan = manager.prepareSessionShell(preparation(source, start));
    const sourcePort = new FakePort();
    const sourceStreamId = manager.attach({
      binding: source,
      attachmentToken: plan.attachment.attachmentToken,
      port: sourcePort,
    });
    sourcePort.send(startFrame(sourceStreamId, 16));
    await scheduler.flush();
    expect(manager.listSessionShells(source).resources[0]).toMatchObject({ state: "opening" });

    expect(manager.transferSessionShells(source, destination)).toEqual([plan.resourceId]);
    expect(lastFrame(sourcePort, "closed")).toMatchObject({ disposition: "detached" });
    expect(manager.listSessionShells(destination).resources[0]).toMatchObject({ state: "detached" });
    startGate.resolve(endpoint.endpoint);
    await scheduler.flush();
    expect(manager.listSessionShells(destination).resources[0]).toMatchObject({
      state: "detached",
      canKill: false,
    });

    const action = await manager.actOnSessionShell(destination, {
      resourceId: plan.resourceId,
      action: "attach",
    });
    const destinationPort = new FakePort();
    const destinationStreamId = manager.attach({
      binding: destination,
      attachmentToken: action.attachment!.attachmentToken,
      port: destinationPort,
    });
    destinationPort.send(startFrame(destinationStreamId, 16));
    await scheduler.flush();
    expect(lastFrame(destinationPort, "opened")).toBeDefined();
    expect(start).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("reattaches a transferred opening resource before its one remote start settles", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const source = binding();
    const destination = binding({
      ownerWindowId: 2,
      rendererProcessId: 22,
      rendererFrameToken: "frame-popout",
      rendererDocumentId: "document-popout",
    });
    const endpoint = endpointHarness();
    const startGate = deferred<MainStreamEndpoint>();
    const start = vi.fn(() => startGate.promise);
    const plan = manager.prepareSessionShell(preparation(source, start));
    const sourcePort = new FakePort();
    const sourceStreamId = manager.attach({
      binding: source,
      attachmentToken: plan.attachment.attachmentToken,
      port: sourcePort,
    });
    sourcePort.send(startFrame(sourceStreamId, 16));
    await scheduler.flush();
    expect(manager.listSessionShells(source).resources[0]).toMatchObject({ state: "opening" });

    manager.transferSessionShells(source, destination);
    const action = await manager.actOnSessionShell(destination, {
      resourceId: plan.resourceId,
      action: "attach",
    });
    const destinationPort = new FakePort();
    const destinationStreamId = manager.attach({
      binding: destination,
      attachmentToken: action.attachment!.attachmentToken,
      port: destinationPort,
    });
    destinationPort.send(startFrame(destinationStreamId, 16));
    await scheduler.flush();
    expect(manager.listSessionShells(destination).resources[0]).toMatchObject({ state: "opening" });
    expect(lastFrame(destinationPort, "closed")).toBeUndefined();
    expect(start).toHaveBeenCalledOnce();

    startGate.resolve(endpoint.endpoint);
    await scheduler.flush();
    expect(lastFrame(destinationPort, "opened")).toBeDefined();
    expect(manager.listSessionShells(destination).resources[0]).toMatchObject({ state: "attached" });
    expect(start).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("rejects same-window and foreign-scope transfers without changing ownership", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const source = binding();
    const plan = manager.prepareSessionShell(preparation(source, resolvedStarter()));

    for (const invalidDestination of [
      source,
      binding({ rendererDocumentId: "another-document" }),
      binding({ ownerWindowId: 2, backendId: "backend-b" }),
      binding({ ownerWindowId: 2, backendEpoch: 2 }),
      binding({ ownerWindowId: 2, targetId: "session-b" }),
      binding({ ownerWindowId: 2, fingerprint: "b".repeat(64) }),
    ]) {
      expect(() => manager.transferSessionShells(source, invalidDestination)).toThrow(StreamAccessError);
    }
    expect(manager.listSessionShells(source).resources).toEqual([
      expect.objectContaining({ resourceId: plan.resourceId, state: "prepared" }),
    ]);
    expect(manager.metricsForWindow(source.ownerWindowId)).toMatchObject({
      activeStreams: 1,
      reservedBytes: 64,
      rejectedStreams: "0",
    });
    await manager.close();
  });

  it("leaves attachments, tickets, resources, and accounting unchanged when destination capacity is full", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, {
      maxStreamsPerWindow: 2,
      maxReservedBytesPerWindow: 128,
    });
    const source = binding();
    const destination = binding({
      ownerWindowId: 2,
      rendererProcessId: 22,
      rendererFrameToken: "frame-popout",
      rendererDocumentId: "document-popout",
    });
    const first = manager.prepareSessionShell(preparation(source, resolvedStarter()));
    const second = manager.prepareSessionShell(preparation(source, resolvedStarter()));
    const destinationShell = await openShell(manager, scheduler, { binding: destination });
    const sourceBefore = manager.metricsForWindow(source.ownerWindowId);
    const destinationBefore = manager.metricsForWindow(destination.ownerWindowId);
    const backendBefore = manager.metricsForBackend({ backendId: source.backendId, backendEpoch: source.backendEpoch });
    const processBefore = manager.metricsForProcess();

    expect(() => manager.transferSessionShells(source, destination)).toThrow(StreamCapacityError);
    expect(manager.metricsForWindow(source.ownerWindowId)).toEqual(sourceBefore);
    expect(manager.metricsForWindow(destination.ownerWindowId)).toEqual(destinationBefore);
    expect(manager.metricsForBackend({ backendId: source.backendId, backendEpoch: source.backendEpoch }))
      .toEqual(backendBefore);
    expect(manager.metricsForProcess()).toEqual(processBefore);
    expect(destinationShell.port.closed).toBe(false);
    expect(manager.listSessionShells(source).resources).toEqual([
      expect.objectContaining({ resourceId: first.resourceId, state: "prepared" }),
      expect.objectContaining({ resourceId: second.resourceId, state: "prepared" }),
    ]);

    const sourcePort = new FakePort();
    expect(() => manager.attach({
      binding: source,
      attachmentToken: first.attachment.attachmentToken,
      port: sourcePort,
    })).not.toThrow();
    expect(sourcePort.closed).toBe(false);
    await manager.close();
  });
});

describe("StreamManager protocol and data lifetime", () => {
  it("delivers queued final output before closing a remote shell", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const endpoint = endpointHarness();
    let context: StartMainStreamEndpointContext | undefined;
    const shell = await openShell(manager, scheduler, {
      starter: async (value) => {
        context = value;
        return endpoint.endpoint;
      },
    });

    expect(context?.emitOutput(Uint8Array.from([1, 2, 3, 4]))).toBe(true);
    context?.remoteClose("remote-close");
    expect(lastFrame(shell.port, "closed")).toBeUndefined();
    expect(manager.metricsForProcess().queuedBytes).toBe(4);
    expect(context?.emitOutput(Uint8Array.from([9]))).toBe(false);
    const lateInput = arrayBuffer([8]);
    shell.port.send(dataFrame(shell.streamId, 0, lateInput));
    expect([...new Uint8Array(lateInput)]).toEqual([0]);

    await scheduler.flush();
    expect(shell.port.frames.slice(-2).map((frame) => frame.type)).toEqual(["data", "closed"]);
    expect([...new Uint8Array(lastFrame(shell.port, "data")!.data)]).toEqual([1, 2, 3, 4]);
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "remote-close" });
    expect(endpoint.write).not.toHaveBeenCalled();
    expect(endpoint.close).toHaveBeenCalledOnce();
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, queuedBytes: 0 });
    await manager.close();
  });

  it("drains a fast shell that reaches EOF before endpoint startup settles", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const plan = manager.prepareSessionShell(preparation(binding(), (context) => {
      expect(context.emitOutput(Uint8Array.from([5, 4, 3, 2]))).toBe(true);
      context.remoteClose("completed");
      return Promise.resolve(endpointHarness().endpoint);
    }));
    const port = new FakePort();
    const streamId = manager.attach({
      binding: binding(), attachmentToken: plan.attachment.attachmentToken, port,
    });
    port.send(startFrame(streamId, 4));

    await scheduler.flush();
    expect(port.frames.map((frame) => frame.type)).toEqual(["ready", "opened", "data", "closed"]);
    expect([...new Uint8Array(lastFrame(port, "data")!.data)]).toEqual([5, 4, 3, 2]);
    expect(lastFrame(port, "closed")).toMatchObject({ reason: "completed" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, queuedBytes: 0 });
    await manager.close();
  });

  it("waits for output credit after remote EOF and bounds a stalled renderer", async () => {
    vi.useFakeTimers();
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, { creditTimeoutMilliseconds: 10_000 });
    let context: StartMainStreamEndpointContext | undefined;
    const shell = await openShell(manager, scheduler, {
      receiveCreditBytes: 4,
      starter: async (value) => {
        context = value;
        return endpointHarness().endpoint;
      },
    });

    expect(context?.emitOutput(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    context?.remoteClose("completed");
    await scheduler.flush();
    expect(shell.port.frames.filter((frame) => frame.type === "data")).toHaveLength(1);
    expect(lastFrame(shell.port, "closed")).toBeUndefined();
    expect(manager.metricsForProcess().queuedBytes).toBe(4);

    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "credit",
      streamId: shell.streamId,
      bytes: 4,
    });
    await scheduler.flush();
    expect(shell.port.frames.slice(-2).map((frame) => frame.type)).toEqual(["data", "closed"]);
    expect(shell.port.frames.filter((frame) => frame.type === "data")
      .map((frame) => frame.type === "data" ? [...new Uint8Array(frame.data)] : []))
      .toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "completed" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, queuedBytes: 0 });

    const stalled = await openShell(manager, scheduler, {
      binding: binding({ targetId: "stalled" }),
      receiveCreditBytes: 4,
      starter: async (value) => {
        context = value;
        return endpointHarness().endpoint;
      },
    });
    expect(context?.emitOutput(Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]))).toBe(true);
    context?.remoteClose("remote-close");
    await scheduler.flush();
    expect(lastFrame(stalled.port, "closed")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(STREAM_CLOSING_GRACE_MILLISECONDS + 1);
    expect(lastFrame(stalled.port, "closed")).toMatchObject({ reason: "remote-close" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, queuedBytes: 0 });
    await manager.close();
  });

  it("closes transport errors immediately even when output is queued", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    let context: StartMainStreamEndpointContext | undefined;
    const shell = await openShell(manager, scheduler, {
      starter: async (value) => {
        context = value;
        return endpointHarness().endpoint;
      },
    });

    expect(context?.emitOutput(Uint8Array.from([1, 2, 3, 4]))).toBe(true);
    context?.remoteClose("transport-error");
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "transport-error" });
    await scheduler.flush();
    expect(lastFrame(shell.port, "data")).toBeUndefined();
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, queuedBytes: 0 });
    await manager.close();
  });

  it.each([
    ["extra key", (streamId: string, data: ArrayBuffer) => ({
      v: STREAM_PROTOCOL_VERSION, type: "data", streamId, sequence: 0, data, extra: true,
    })],
    ["wrong version", (streamId: string, data: ArrayBuffer) => ({
      v: 2, type: "data", streamId, sequence: 0, data,
    })],
    ["wrong sequence", (streamId: string, data: ArrayBuffer) => ({
      v: STREAM_PROTOCOL_VERSION, type: "data", streamId, sequence: 1, data,
    })],
    ["wrong stream", (_streamId: string, data: ArrayBuffer) => ({
      v: STREAM_PROTOCOL_VERSION, type: "data", streamId: opaqueId(999), sequence: 0, data,
    })],
    ["configured oversize", (streamId: string, data: ArrayBuffer) => ({
      v: STREAM_PROTOCOL_VERSION, type: "data", streamId, sequence: 0, data,
    })],
  ])("closes on %s data and scrubs the transferred buffer", async (_label, frameFactory) => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const shell = await openShell(manager, scheduler);
    const bytes = _label === "configured oversize" ? [1, 2, 3, 4, 5] : [1, 2, 3];
    const buffer = arrayBuffer(bytes);

    shell.port.send(frameFactory(shell.streamId, buffer));
    await scheduler.flush();

    expect([...new Uint8Array(buffer)]).toEqual(new Array(bytes.length).fill(0));
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "protocol-error", disposition: "closed" });
    expect(manager.metricsForProcess().activeStreams).toBe(0);
    await manager.close();
  });

  it("enforces the configured receive-credit ceiling at start", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, { maxCreditBytes: 8, initialCreditBytes: 8 });
    const plan = manager.prepareSessionShell(preparation(binding(), resolvedStarter()));
    const port = new FakePort();
    const streamId = manager.attach({
      binding: binding(), attachmentToken: plan.attachment.attachmentToken, port,
    });

    port.send(startFrame(streamId, 9));
    await scheduler.flush();
    expect(lastFrame(port, "closed")).toMatchObject({ reason: "protocol-error" });
    expect(manager.metricsForProcess().activeStreams).toBe(0);
    await manager.close();
  });

  it("scrubs an adversarial typed-array payload rejected before contract admission", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const shell = await openShell(manager, scheduler);
    const typedPayload = Uint8Array.from([9, 4, 2]);
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "data",
      streamId: shell.streamId,
      sequence: 0,
      data: typedPayload,
    });
    await scheduler.flush();
    expect([...typedPayload]).toEqual([0, 0, 0]);
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "protocol-error" });
    await manager.close();
  });

  it("rejects malformed exact keys, credit overflow, duplicate start, resize misuse, and post-close frames", async () => {
    const scheduler = new ManualScheduler();

    for (const violate of [
      (shell: OpenShell) => shell.port.send({
        v: STREAM_PROTOCOL_VERSION,
        type: "credit",
        streamId: shell.streamId,
        bytes: 16,
      }),
      (shell: OpenShell) => shell.port.send(startFrame(shell.streamId, 8)),
      (shell: OpenShell) => shell.port.send({
        v: STREAM_PROTOCOL_VERSION,
        type: "resize",
        streamId: shell.streamId,
        rows: 24,
        columns: 80,
      }),
    ]) {
      const manager = createManager(scheduler);
      const shell = await openShell(manager, scheduler, { requestPty: false, receiveCreditBytes: 16 });
      violate(shell);
      await scheduler.flush();
      expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "protocol-error" });
      await manager.close();
    }

    const manager = createManager(scheduler);
    const shell = await openShell(manager, scheduler);
    const retainedListener = shell.port.lastMessageListener;
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "close",
      streamId: shell.streamId,
      disposition: "close",
    });
    await scheduler.flush();
    const afterClose = arrayBuffer([9, 8, 7]);
    retainedListener?.({
      v: STREAM_PROTOCOL_VERSION,
      type: "data",
      streamId: shell.streamId,
      sequence: 0,
      data: afterClose,
    });
    expect([...new Uint8Array(afterClose)]).toEqual([0, 0, 0]);
    await manager.close();
  });

  it("rate-limits otherwise valid control frames independently of byte credit", async () => {
    const scheduler = new ManualScheduler();
    const endpoint = endpointHarness();
    const manager = createManager(scheduler, { controlFrameBurst: 2, controlFramesPerSecond: 1 });
    const shell = await openShell(manager, scheduler, {
      requestPty: true,
      endpoint: {
        ...endpoint.endpoint,
        resize: vi.fn(async () => undefined),
      },
    });
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "resize",
      streamId: shell.streamId,
      rows: 24,
      columns: 80,
    });
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "resize",
      streamId: shell.streamId,
      rows: 25,
      columns: 81,
    });
    await scheduler.flush();
    expect(lastFrame(shell.port, "closed")).toMatchObject({ reason: "protocol-error" });
    await manager.close();
  });

  it("buffers output emitted synchronously by the starter and closes a late endpoint after teardown", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const endpoint = endpointHarness();
    const late = deferred<MainStreamEndpoint>();
    let emitAccepted = false;
    const starter: StartMainStreamEndpoint = (context) => {
      emitAccepted = context.emitOutput(Uint8Array.from([4, 3, 2, 1]));
      return late.promise;
    };
    const plan = manager.prepareSessionShell(preparation(binding(), starter));
    const port = new FakePort();
    const streamId = manager.attach({ binding: binding(), attachmentToken: plan.attachment.attachmentToken, port });
    port.send(startFrame(streamId, 16));
    await scheduler.flush();

    expect(emitAccepted).toBe(true);
    expect(manager.listSessionShells(binding()).resources[0]).toMatchObject({
      state: "opening",
      metrics: { queuedOutputBytes: 4 },
    });

    await manager.closeWindow(1, "navigation");
    late.resolve(endpoint.endpoint);
    await scheduler.flush();
    expect(endpoint.close).toHaveBeenCalledTimes(1);
    expect(lastFrame(port, "closed")).toMatchObject({ reason: "navigation" });
    await manager.close();
  });

  it("zeroizes accepted input after serialized write completion", async () => {
    const scheduler = new ManualScheduler();
    const pending = deferred<void>();
    const endpoint = endpointHarness({ write: () => pending.promise });
    const manager = createManager(scheduler);
    const shell = await openShell(manager, scheduler, { endpoint: endpoint.endpoint });
    const transferred = arrayBuffer([1, 3, 3, 7]);
    shell.port.send(dataFrame(shell.streamId, 0, transferred));
    await scheduler.flush();

    expect([...new Uint8Array(transferred)]).toEqual([0, 0, 0, 0]);
    expect(endpoint.writeCopies).toEqual([[1, 3, 3, 7]]);
    const endpointReference = endpoint.writeReferences[0];
    expect(endpointReference && [...endpointReference]).toEqual([1, 3, 3, 7]);

    pending.resolve();
    await scheduler.flush();
    expect(endpointReference && [...endpointReference]).toEqual([0, 0, 0, 0]);
    expect(lastFrame(shell.port, "credit")).toMatchObject({ bytes: 4 });
    await manager.close();
  });

  it("detaches explicitly, preserves bounded scrollback for a one-use reattach, and closes on unexpected port loss", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    let context: StartMainStreamEndpointContext | undefined;
    const shell = await openShell(manager, scheduler, {
      starter: async (value) => {
        context = value;
        return endpointHarness().endpoint;
      },
    });
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "close",
      streamId: shell.streamId,
      disposition: "detach",
    });
    expect(lastFrame(shell.port, "closed")).toMatchObject({
      reason: "operator-detach",
      disposition: "detached",
    });
    expect(context?.emitOutput(Uint8Array.from([7, 6, 5, 4]))).toBe(true);
    await scheduler.flush();

    const action = await manager.actOnSessionShell(binding(), {
      resourceId: shell.resourceId,
      action: "attach",
    });
    const reattachPort = new FakePort();
    const reattachedStreamId = manager.attach({
      binding: binding(),
      attachmentToken: action.attachment!.attachmentToken,
      port: reattachPort,
    });
    const replayPort = new FakePort();
    expect(() => manager.attach({
      binding: binding(), attachmentToken: action.attachment!.attachmentToken, port: replayPort,
    })).toThrow(StreamAccessError);
    reattachPort.send(startFrame(reattachedStreamId, 16));
    await scheduler.flush();
    expect(lastFrame(reattachPort, "opened")).toBeDefined();
    expect(lastFrame(reattachPort, "data")?.sequence).toBe(0);
    expect([...new Uint8Array(lastFrame(reattachPort, "data")!.data)]).toEqual([7, 6, 5, 4]);
    expect(reattachPort.rawDataReferences.every((data) => [...new Uint8Array(data)].every((byte) => byte === 0)))
      .toBe(true);
    expect(manager.metricsForProcess()).toMatchObject({ attachedStreams: 1, detachedStreams: 0 });

    reattachPort.disconnect();
    await scheduler.flush();
    expect(lastFrame(reattachPort, "closed")).toMatchObject({ reason: "port-closed", disposition: "closed" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0 });
    await manager.close();
  });

  it("fails closed when detached output exhausts its dedicated bounded scrollback", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, { maxDetachedScrollbackBytes: 8 });
    let context: StartMainStreamEndpointContext | undefined;
    const shell = await openShell(manager, scheduler, {
      starter: async (value) => {
        context = value;
        return endpointHarness().endpoint;
      },
    });
    shell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "close",
      streamId: shell.streamId,
      disposition: "detach",
    });
    expect(context?.emitOutput(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    expect(context?.emitOutput(Uint8Array.from([9]))).toBe(false);
    await scheduler.flush();
    expect(manager.listSessionShells(binding()).resources).toEqual([]);
    expect(manager.metricsForProcess()).toMatchObject({
      queuedBytes: 0,
      activeStreams: 0,
      closesByReason: { "detached-buffer-exhausted": "1" },
    });
    await manager.close();
  });

  it("splits and joins multi-megabyte duplex traffic without digest drift", async () => {
    const scheduler = new ManualScheduler();
    let firstContext: StartMainStreamEndpointContext | undefined;
    let secondContext: StartMainStreamEndpointContext | undefined;
    const firstEndpoint = endpointHarness();
    const secondEndpoint = endpointHarness();
    const manager = new StreamManager({ schedule: scheduler.schedule, createOpaqueId: idGenerator() });
    const firstShell = await openShell(manager, scheduler, {
      receiveCreditBytes: 128 * 1_024,
      starter: async (value) => {
        firstContext = value;
        return firstEndpoint.endpoint;
      },
    });
    const secondBinding = binding({ ownerWindowId: 2, targetId: "session-b" });
    const secondShell = await openShell(manager, scheduler, {
      binding: secondBinding,
      receiveCreditBytes: 128 * 1_024,
      starter: async (value) => {
        secondContext = value;
        return secondEndpoint.endpoint;
      },
    });
    const transferBytes = 3 * 1_024 * 1_024;
    const firstOutput = patternedBytes(transferBytes, 17);
    const secondOutput = patternedBytes(transferBytes, 23);

    for (let offset = 0; offset < transferBytes; offset += 64 * 1_024) {
      expect(firstContext?.emitOutput(firstOutput.subarray(offset, offset + 64 * 1_024))).toBe(true);
      expect(secondContext?.emitOutput(secondOutput.subarray(offset, offset + 64 * 1_024))).toBe(true);
      await scheduler.flush();
      if (offset + 64 * 1_024 < transferBytes) {
        for (const shell of [firstShell, secondShell]) {
          shell.port.send({
            v: STREAM_PROTOCOL_VERSION,
            type: "credit",
            streamId: shell.streamId,
            bytes: 64 * 1_024,
          });
        }
        await scheduler.flush();
      }
    }
    for (const [shell, expected] of [
      [firstShell, firstOutput],
      [secondShell, secondOutput],
    ] as const) {
      const outputFrames = shell.port.frames.filter(
        (frame): frame is Extract<StreamServerFrame, { type: "data" }> => frame.type === "data",
      );
      expect(outputFrames).toHaveLength(transferBytes / STREAM_MAX_FRAME_BYTES);
      expect(outputFrames.map((frame) => frame.sequence)).toEqual(
        Array.from({ length: outputFrames.length }, (_, index) => index),
      );
      const joinedOutput = Buffer.concat(outputFrames.map((frame) => Buffer.from(frame.data)));
      expect(sha256(joinedOutput)).toBe(sha256(expected));
    }

    const firstInput = patternedBytes(transferBytes, 29);
    const secondInput = patternedBytes(transferBytes, 31);
    for (let sequence = 0; sequence < transferBytes / STREAM_MAX_FRAME_BYTES; sequence += 1) {
      const offset = sequence * STREAM_MAX_FRAME_BYTES;
      firstShell.port.send(dataFrame(firstShell.streamId, sequence, exactBuffer(
        firstInput.subarray(offset, offset + STREAM_MAX_FRAME_BYTES),
      )));
      secondShell.port.send(dataFrame(secondShell.streamId, sequence, exactBuffer(
        secondInput.subarray(offset, offset + STREAM_MAX_FRAME_BYTES),
      )));
      await scheduler.flush();
    }
    expect(sha256(Buffer.concat(firstEndpoint.writeCopies.map((bytes) => Buffer.from(bytes)))))
      .toBe(sha256(firstInput));
    expect(sha256(Buffer.concat(secondEndpoint.writeCopies.map((bytes) => Buffer.from(bytes)))))
      .toBe(sha256(secondInput));
    expect(manager.listSessionShells(binding()).resources[0]?.metrics).toMatchObject({
      bytesFromRenderer: String(transferBytes),
      bytesToRenderer: String(transferBytes),
    });
    expect(manager.listSessionShells(secondBinding).resources[0]?.metrics).toMatchObject({
      bytesFromRenderer: String(transferBytes),
      bytesToRenderer: String(transferBytes),
    });
    await manager.close();
  });
});

describe("StreamManager scheduler, timeouts, and teardown", () => {
  it("serializes writes per stream and respects backend and process in-flight caps without starvation", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, {
      maxInFlightWritesPerBackend: 1,
      maxInFlightWritesPerProcess: 2,
    });
    const pending: Array<ReturnType<typeof deferred<void>>> = [];
    const calls: string[] = [];
    const makeEndpoint = (name: string) => endpointHarness({
      write: () => {
        calls.push(name);
        const wait = deferred<void>();
        pending.push(wait);
        return wait.promise;
      },
    });
    const a1 = makeEndpoint("a1");
    const a2 = makeEndpoint("a2");
    const b1 = makeEndpoint("b1");
    const shellA1 = await openShell(manager, scheduler, { endpoint: a1.endpoint });
    const shellA2 = await openShell(manager, scheduler, {
      binding: binding({ ownerWindowId: 2, targetId: "a2" }), endpoint: a2.endpoint,
    });
    const shellB1 = await openShell(manager, scheduler, {
      binding: binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "b1" }), endpoint: b1.endpoint,
    });

    shellA1.port.send(dataFrame(shellA1.streamId, 0, arrayBuffer([1])));
    shellA1.port.send(dataFrame(shellA1.streamId, 1, arrayBuffer([2])));
    shellA2.port.send(dataFrame(shellA2.streamId, 0, arrayBuffer([3])));
    shellB1.port.send(dataFrame(shellB1.streamId, 0, arrayBuffer([4])));
    await scheduler.flush();

    expect(calls).toHaveLength(2);
    expect(calls.filter((name) => name.startsWith("a"))).toHaveLength(1);
    expect(calls).toContain("b1");
    expect(a1.writeCopies.length).toBeLessThanOrEqual(1);

    pending.splice(0).forEach((wait) => wait.resolve());
    await scheduler.flush();
    expect(calls).toHaveLength(3);
    pending.splice(0).forEach((wait) => wait.resolve());
    await scheduler.flush();
    expect(calls).toHaveLength(4);
    pending.splice(0).forEach((wait) => wait.resolve());
    await scheduler.flush();
    expect(new Set(calls)).toEqual(new Set(["a1", "a2", "b1"]));
    expect(a1.writeCopies).toEqual([[1], [2]]);
    await manager.close();
  });

  it("round-robins bounded output turns so every runnable stream progresses", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler, {
      maxFramesPerStreamTurn: 1,
      maxBytesPerStreamTurn: 4,
      maxBytesPerSchedulerTick: 4,
    });
    const events: string[] = [];
    const contexts: StartMainStreamEndpointContext[] = [];
    const shells: OpenShell[] = [];
    for (let index = 0; index < 3; index += 1) {
      const port = new FakePort((frame) => {
        if (frame.type === "data") events.push(`s${index}:${frame.sequence}`);
      });
      let context: StartMainStreamEndpointContext | undefined;
      const shell = await openShell(manager, scheduler, {
        binding: binding({ ownerWindowId: index + 1, targetId: `s${index}` }),
        port,
        starter: async (value) => {
          context = value;
          return endpointHarness().endpoint;
        },
      });
      if (!context) throw new Error("starter context was not captured");
      contexts.push(context);
      shells.push(shell);
    }
    for (const context of contexts) expect(context.emitOutput(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(true);
    await scheduler.flush();

    expect(events.slice(0, 3)).toEqual(["s0:0", "s1:0", "s2:0"]);
    expect(events).toHaveLength(6);
    expect(shells.every((shell) => shell.port.frames.filter((frame) => frame.type === "data").length === 2)).toBe(true);
    await manager.close();
  });

  it("applies handshake, opening, credit, write, idle, and detached timeouts with fixed close reasons", async () => {
    vi.useFakeTimers();
    const scheduler = new ManualScheduler();

    const handshakeManager = createManager(scheduler, { handshakeTimeoutMilliseconds: 10 });
    const handshakePlan = handshakeManager.prepareSessionShell(preparation(binding(), resolvedStarter()));
    const handshakePort = new FakePort();
    handshakeManager.attach({
      binding: binding(), attachmentToken: handshakePlan.attachment.attachmentToken, port: handshakePort,
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(lastFrame(handshakePort, "closed")).toMatchObject({ reason: "handshake-timeout" });
    await handshakeManager.close();

    const openingManager = createManager(scheduler, { handshakeTimeoutMilliseconds: 10 });
    const lateEndpoint = endpointHarness();
    const late = deferred<MainStreamEndpoint>();
    const openingPlan = openingManager.prepareSessionShell(preparation(binding(), () => late.promise));
    const openingPort = new FakePort();
    const openingId = openingManager.attach({
      binding: binding(), attachmentToken: openingPlan.attachment.attachmentToken, port: openingPort,
    });
    openingPort.send(startFrame(openingId, 8));
    await vi.advanceTimersByTimeAsync(11);
    expect(lastFrame(openingPort, "closed")).toMatchObject({ reason: "handshake-timeout" });
    late.resolve(lateEndpoint.endpoint);
    await scheduler.flush();
    expect(lateEndpoint.close).toHaveBeenCalledOnce();
    await openingManager.close();

    const creditManager = createManager(scheduler, { creditTimeoutMilliseconds: 10 });
    let creditContext: StartMainStreamEndpointContext | undefined;
    const creditShell = await openShell(creditManager, scheduler, {
      receiveCreditBytes: 1,
      starter: async (context) => {
        creditContext = context;
        return endpointHarness().endpoint;
      },
    });
    expect(creditContext?.emitOutput(Uint8Array.from([1, 2, 3, 4]))).toBe(true);
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(11);
    expect(lastFrame(creditShell.port, "closed")).toMatchObject({ reason: "credit-timeout" });
    await creditManager.close();

    const stalledWrite = deferred<void>();
    const writeManager = createManager(scheduler, { writeTimeoutMilliseconds: 10 });
    const writeShell = await openShell(writeManager, scheduler, {
      endpoint: endpointHarness({ write: () => stalledWrite.promise }).endpoint,
    });
    writeShell.port.send(dataFrame(writeShell.streamId, 0, arrayBuffer([1])));
    await scheduler.flush();
    await vi.advanceTimersByTimeAsync(11);
    expect(lastFrame(writeShell.port, "closed")).toMatchObject({ reason: "write-timeout" });
    stalledWrite.resolve();
    await scheduler.flush();
    await writeManager.close();

    const idleManager = createManager(scheduler, { idleTimeoutMilliseconds: 10 });
    const idleShell = await openShell(idleManager, scheduler);
    await vi.advanceTimersByTimeAsync(11);
    expect(lastFrame(idleShell.port, "closed")).toMatchObject({ reason: "idle-timeout" });
    await idleManager.close();

    const detachedManager = createManager(scheduler, {
      idleTimeoutMilliseconds: 1_000,
      detachedTtlMilliseconds: 10,
    });
    const detachedShell = await openShell(detachedManager, scheduler);
    detachedShell.port.send({
      v: STREAM_PROTOCOL_VERSION,
      type: "close",
      streamId: detachedShell.streamId,
      disposition: "detach",
    });
    expect(lastFrame(detachedShell.port, "closed")).toMatchObject({
      reason: "operator-detach", disposition: "detached",
    });
    expect(detachedManager.metricsForProcess()).toMatchObject({ attachedStreams: 0, detachedStreams: 1 });
    await vi.advanceTimersByTimeAsync(11);
    expect(detachedManager.metricsForProcess()).toMatchObject({
      activeStreams: 0, closesByReason: { "idle-timeout": "1" },
    });
    await detachedManager.close();
  });

  it("isolates teardown by target, backend, window, and application and emits content-free metrics", async () => {
    const scheduler = new ManualScheduler();
    const manager = createManager(scheduler);
    const firstBinding = binding({ ownerWindowId: 1, targetId: "target-a" });
    const secondBinding = binding({ ownerWindowId: 2, targetId: "target-b" });
    const thirdBinding = binding({ ownerWindowId: 3, backendId: "backend-b", targetId: "target-c" });
    const first = await openShell(manager, scheduler, { binding: firstBinding });
    const second = await openShell(manager, scheduler, { binding: secondBinding });
    const third = await openShell(manager, scheduler, { binding: thirdBinding });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 3, attachedStreams: 3 });

    await manager.closeTarget({ backendId: "backend-a", backendEpoch: 1, target: firstBinding.target });
    expect(lastFrame(first.port, "closed")).toMatchObject({ reason: "target-disappeared" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 2, attachedStreams: 2 });

    await manager.closeWindow(2, "renderer-gone");
    expect(lastFrame(second.port, "closed")).toMatchObject({ reason: "renderer-gone" });
    await manager.closeBackend({ backendId: "backend-b", backendEpoch: 1 });
    expect(lastFrame(third.port, "closed")).toMatchObject({ reason: "backend-disconnected" });

    const metricsJson = JSON.stringify(manager.metricsForProcess());
    expect(metricsJson).not.toContain("backend-a");
    expect(metricsJson).not.toContain("target-a");
    expect(metricsJson).not.toContain("frame-a");
    expect(metricsJson).not.toContain("document-a");
    expect(metricsJson).not.toContain("payload");
    expect(manager.metricsForProcess()).toMatchObject({
      activeStreams: 0,
      closedStreams: "3",
      closesByReason: {
        "target-disappeared": "1",
        "renderer-gone": "1",
        "backend-disconnected": "1",
      },
    });

    const appShell = await openShell(manager, scheduler, { binding: binding({ targetId: "app" }) });
    await manager.close();
    expect(lastFrame(appShell.port, "closed")).toMatchObject({ reason: "application-shutdown" });
    expect(manager.metricsForProcess()).toMatchObject({ activeStreams: 0, reservedBytes: 0 });
    expect(() => manager.prepareSessionShell(preparation(binding(), resolvedStarter()))).toThrow(/closed/);
  });
});

const BASE_LIMITS: StreamManagerLimits = {
  maxFrameBytes: 4,
  initialCreditBytes: 8,
  maxCreditBytes: 16,
  maxQueueBytes: 16,
  maxDetachedScrollbackBytes: 32,
  reservedBytesPerResource: 64,
  maxStreamsPerWindow: 8,
  maxStreamsPerBackend: 16,
  maxStreamsPerProcess: 32,
  maxReservedBytesPerWindow: 512,
  maxReservedBytesPerBackend: 1_024,
  maxReservedBytesPerProcess: 2_048,
  ticketTtlMilliseconds: 1_000,
  handshakeTimeoutMilliseconds: 1_000,
  writeTimeoutMilliseconds: 1_000,
  creditTimeoutMilliseconds: 1_000,
  idleTimeoutMilliseconds: 10_000,
  detachedTtlMilliseconds: 1_000,
  controlFramesPerSecond: 64,
  controlFrameBurst: 128,
  schedulerQuantumBytes: 4,
  maxFramesPerStreamTurn: 1,
  maxBytesPerStreamTurn: 4,
  maxBytesPerSchedulerTick: 8,
  maxInFlightWritesPerBackend: 2,
  maxInFlightWritesPerProcess: 4,
};

interface ManagerOverrides {
  readonly now?: () => number;
  readonly createOpaqueId?: () => string;
}

function createManager(
  scheduler: ManualScheduler,
  limits: Partial<StreamManagerLimits> = {},
  options: ManagerOverrides = {},
): StreamManager {
  return new StreamManager({
    limits: { ...BASE_LIMITS, ...limits },
    schedule: scheduler.schedule,
    createOpaqueId: options.createOpaqueId ?? idGenerator(),
    ...(options.now ? { now: options.now } : {}),
  });
}

function preparation(bindingValue: StreamOwnerBinding, start: StartMainStreamEndpoint) {
  return {
    binding: bindingValue,
    input: { requestPty: false },
    start,
  } as const;
}

interface BindingOptions {
  readonly ownerWindowId?: number;
  readonly rendererProcessId?: number;
  readonly rendererFrameToken?: string;
  readonly rendererDocumentId?: string;
  readonly backendId?: string;
  readonly backendEpoch?: number;
  readonly connectionIncarnation?: number;
  readonly targetId?: string;
  readonly fingerprint?: string;
}

function binding(options: BindingOptions = {}): StreamOwnerBinding {
  const backendEpoch = options.backendEpoch ?? 1;
  const target: TargetRef = {
    mode: "session",
    id: options.targetId ?? "session-a",
    backendEpoch,
    domainRevision: 1,
    fingerprint: options.fingerprint ?? "a".repeat(64),
  };
  return {
    ownerWindowId: options.ownerWindowId ?? 1,
    rendererProcessId: options.rendererProcessId ?? 11,
    rendererFrameToken: options.rendererFrameToken ?? "frame-a",
    rendererDocumentId: options.rendererDocumentId ?? "document-a",
    backendId: options.backendId ?? "backend-a",
    backendEpoch,
    connectionIncarnation: options.connectionIncarnation ?? 7,
    target,
  };
}

interface OpenShellOptions {
  readonly binding?: StreamOwnerBinding;
  readonly endpoint?: MainStreamEndpoint;
  readonly starter?: StartMainStreamEndpoint;
  readonly port?: FakePort;
  readonly requestPty?: boolean;
  readonly receiveCreditBytes?: number;
}

interface OpenShell {
  readonly binding: StreamOwnerBinding;
  readonly resourceId: string;
  readonly streamId: string;
  readonly port: FakePort;
}

async function openShell(
  manager: StreamManager,
  scheduler: ManualScheduler,
  options: OpenShellOptions = {},
): Promise<OpenShell> {
  const owner = options.binding ?? binding();
  const endpoint = options.endpoint ?? endpointHarness().endpoint;
  const start = options.starter ?? resolvedStarter(endpoint);
  const plan = manager.prepareSessionShell({
    binding: owner,
    input: { requestPty: options.requestPty ?? false },
    start,
  });
  const port = options.port ?? new FakePort();
  const streamId = manager.attach({ binding: owner, attachmentToken: plan.attachment.attachmentToken, port });
  port.send(startFrame(streamId, options.receiveCreditBytes ?? 16));
  await scheduler.flush();
  expect(lastFrame(port, "opened")).toBeDefined();
  return { binding: owner, resourceId: plan.resourceId, streamId, port };
}

function resolvedStarter(endpoint: MainStreamEndpoint = endpointHarness().endpoint): StartMainStreamEndpoint {
  return async () => endpoint;
}

interface EndpointOptions {
  readonly write?: (data: Uint8Array, signal: AbortSignal) => Promise<void>;
  readonly close?: (signal: AbortSignal) => Promise<void>;
}

function endpointHarness(options: EndpointOptions = {}) {
  const writeCopies: number[][] = [];
  const writeReferences: Uint8Array[] = [];
  const write = vi.fn(async (data: Uint8Array, signal: AbortSignal) => {
    writeCopies.push([...data]);
    writeReferences.push(data);
    await (options.write?.(data, signal) ?? Promise.resolve());
  });
  const close = vi.fn(async (signal: AbortSignal) => {
    await (options.close?.(signal) ?? Promise.resolve());
  });
  const endpoint: MainStreamEndpoint = { write, close };
  return { endpoint, write, close, writeCopies, writeReferences };
}

class FakePort implements StreamAttachmentPort {
  readonly frames: StreamServerFrame[] = [];
  readonly rawDataReferences: ArrayBuffer[] = [];
  closed = false;
  started = false;
  lastMessageListener?: (message: unknown) => void;
  private closeListener?: () => void;

  constructor(private readonly observe?: (frame: StreamServerFrame) => void) {}

  postMessage(frame: StreamServerFrame): void {
    if (this.closed) throw new Error("port closed");
    if (frame.type === "data") this.rawDataReferences.push(frame.data);
    const clone = structuredClone(frame);
    this.frames.push(clone);
    this.observe?.(clone);
  }

  close(): void {
    this.closed = true;
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.lastMessageListener = listener;
    return () => {
      if (this.lastMessageListener === listener) delete this.lastMessageListener;
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => {
      if (this.closeListener === listener) delete this.closeListener;
    };
  }

  start(): void {
    this.started = true;
  }

  send(message: unknown): void {
    this.lastMessageListener?.(message);
  }

  disconnect(): void {
    this.closeListener?.();
  }
}

class ManualScheduler {
  private readonly callbacks: Array<() => void> = [];
  readonly schedule = (callback: () => void): void => {
    this.callbacks.push(callback);
  };

  async flush(maximumTurns = 10_000): Promise<void> {
    for (let turn = 0; turn < maximumTurns; turn += 1) {
      const callback = this.callbacks.shift();
      if (callback) callback();
      await Promise.resolve();
      await Promise.resolve();
      if (this.callbacks.length === 0) {
        for (let microtask = 0; microtask < 12 && this.callbacks.length === 0; microtask += 1) {
          await Promise.resolve();
        }
        if (this.callbacks.length === 0) return;
      }
    }
    throw new Error("manual stream scheduler did not quiesce");
  }
}

function startFrame(streamId: string, receiveCreditBytes: number): StreamClientFrame {
  return { v: STREAM_PROTOCOL_VERSION, type: "start", streamId, receiveCreditBytes };
}

function dataFrame(streamId: string, sequence: number, data: ArrayBuffer): StreamClientFrame {
  return { v: STREAM_PROTOCOL_VERSION, type: "data", streamId, sequence, data };
}

function lastFrame<T extends StreamServerFrame["type"]>(
  port: FakePort,
  type: T,
): Extract<StreamServerFrame, { type: T }> | undefined {
  return port.frames.findLast(
    (frame): frame is Extract<StreamServerFrame, { type: T }> => frame.type === type,
  );
}

function idGenerator(): () => string {
  let next = 1;
  return () => opaqueId(next++);
}

function opaqueId(value: number): string {
  return String(value).padStart(43, "A");
}

function arrayBuffer(bytes: readonly number[]): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function patternedBytes(length: number, salt: number): Uint8Array {
  const result = new Uint8Array(length);
  for (let index = 0; index < result.length; index += 1) result[index] = (index * 31 + salt) & 0xff;
  return result;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
