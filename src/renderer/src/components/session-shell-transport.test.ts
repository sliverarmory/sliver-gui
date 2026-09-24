import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STREAM_INITIAL_CREDIT_BYTES,
  STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
  STREAM_MAX_FRAME_BYTES,
  STREAM_MAX_TERMINAL_DIMENSION,
  STREAM_PROTOCOL_VERSION,
  parseStreamServerFrame,
  type StreamServerFrame,
} from "../../../shared/stream-contracts";
import { SessionShellTransport } from "./session-shell-transport";

const streamId = "s".repeat(43);
const resourceId = "r".repeat(43);
const attachmentToken = "t".repeat(43);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SessionShellTransport", () => {
  it("accepts one exact preload capability, handshakes, and drains bounded early output", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);

    const output = new TextEncoder().encode("early output");
    const outputFrame = serverData(0, output);
    expect(() => parseStreamServerFrame(outputFrame)).not.toThrow();
    port.emit(outputFrame);
    expect(transport.getSnapshot()).toMatchObject({
      state: "attached",
      queuedOutputBytes: output.byteLength,
      bytesFromRemote: String(output.byteLength),
    });

    let observedOutput: Uint8Array | undefined;
    const onOutput = vi.fn((bytes: Uint8Array) => {
      observedOutput = Uint8Array.from(bytes);
    });
    const onClose = vi.fn();
    transport.subscribe({ onOutput, onClose });

    expect(onOutput).toHaveBeenCalledOnce();
    expect([...observedOutput ?? []]).toEqual([...output]);
    expect([...onOutput.mock.calls[0]![0] as Uint8Array]).toEqual(new Array(output.byteLength).fill(0));
    expect([...new Uint8Array(outputFrame.data)]).toEqual(new Array(output.byteLength).fill(0));
    expect(port.sent.at(-1)?.message).toMatchObject({
      type: "credit",
      streamId,
      bytes: output.byteLength,
    });
    expect(transport.getSnapshot()).toMatchObject({
      state: "attached",
      queuedOutputBytes: 0,
      bytesFromRemote: String(output.byteLength),
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("replays bounded early output before reporting a normal remote close", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const first = serverData(0, Uint8Array.from([1, 2]));
    const second = serverData(1, Uint8Array.from([3, 4]));
    port.emit(first);
    port.emit(second);
    port.emit(serverClosed("remote-close"));

    expect(port.closed).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({
      state: "closed",
      queuedOutputBytes: 4,
      bytesFromRemote: "4",
      closeReason: "remote-close",
    });
    const events: string[] = [];
    const onOutput = vi.fn((bytes: Uint8Array) => events.push(`data:${[...bytes].join(",")}`));
    const onClose = vi.fn((reason?: string) => events.push(`closed:${reason}`));
    transport.subscribe({ onOutput, onClose });

    expect(events).toEqual(["data:1,2", "data:3,4", "closed:remote-close"]);
    expect(onOutput.mock.calls.every(([bytes]) => bytes.every((byte) => byte === 0))).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({ state: "closed", queuedOutputBytes: 0 });
    expect([...new Uint8Array(first.data)]).toEqual([0, 0]);
    expect([...new Uint8Array(second.data)]).toEqual([0, 0]);
  });

  it("preserves at most the bounded early-output capacity across remote EOF", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const frameCount = STREAM_MAX_DETACHED_SCROLLBACK_BYTES / STREAM_MAX_FRAME_BYTES;
    expect(Number.isInteger(frameCount)).toBe(true);
    for (let sequence = 0; sequence < frameCount; sequence += 1) {
      port.emit(serverData(sequence, new Uint8Array(STREAM_MAX_FRAME_BYTES).fill(sequence + 1)));
    }
    port.emit(serverClosed("completed"));
    expect(transport.getSnapshot()).toMatchObject({
      state: "closed",
      queuedOutputBytes: STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
    });

    const seen: number[] = [];
    transport.subscribe({
      onOutput: (bytes) => seen.push(bytes[0] ?? 0),
      onClose: vi.fn(),
    });
    expect(seen).toEqual(Array.from({ length: frameCount }, (_, index) => index + 1));
    expect(transport.getSnapshot().queuedOutputBytes).toBe(0);

    const overflowHarness = openHarness();
    const overflow = await openAttached(overflowHarness);
    for (let sequence = 0; sequence <= frameCount; sequence += 1) {
      overflow.port.emit(serverData(sequence, new Uint8Array(STREAM_MAX_FRAME_BYTES).fill(0x41)));
    }
    expect(overflow.transport.getSnapshot()).toMatchObject({
      state: "failed",
      queuedOutputBytes: 0,
      closeReason: "transport-error",
    });
    const onOutput = vi.fn();
    overflow.transport.subscribe({ onOutput, onClose: vi.fn() });
    expect(onOutput).not.toHaveBeenCalled();
  });

  it("wipes early output on error, operator close, or explicit release after remote EOF", async () => {
    for (const action of ["transport-error", "operator-close", "release-after-eof"] as const) {
      const harness = openHarness();
      const { port, transport } = await openAttached(harness);
      port.emit(serverData(0, Uint8Array.from([7, 8, 9])));
      if (action === "transport-error") port.emit(serverClosed("transport-error"));
      else if (action === "operator-close") transport.close();
      else {
        port.emit(serverClosed("completed"));
        expect(transport.getSnapshot().queuedOutputBytes).toBe(3);
        transport.close();
      }
      expect(transport.getSnapshot().queuedOutputBytes).toBe(0);
      const onOutput = vi.fn();
      transport.subscribe({ onOutput, onClose: vi.fn() });
      expect(onOutput).not.toHaveBeenCalled();
    }
  });

  it("chunks renderer input by frame and credit while preserving sequence", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness, STREAM_MAX_FRAME_BYTES);
    const bytes = new Uint8Array(STREAM_MAX_FRAME_BYTES + 9).fill(0x61);

    transport.send(bytes, "operator");
    const first = port.sent.find(({ message }) => frameType(message) === "data");
    expect(first?.message).toMatchObject({ type: "data", sequence: 0 });
    expect((first?.message as { data: ArrayBuffer }).data.byteLength).toBe(STREAM_MAX_FRAME_BYTES);
    expect(first?.transfer).toEqual([]);
    expect([...new Uint8Array(first?.sourceData ?? new ArrayBuffer(0))]).toEqual(
      new Array(STREAM_MAX_FRAME_BYTES).fill(0),
    );
    expect(new Uint8Array((first?.message as { data: ArrayBuffer }).data).every((byte) => byte === 0x61)).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({ queuedInputBytes: 9, inputCreditBytes: 0 });

    port.emit(serverCredit(9));
    const dataFrames = port.sent.filter(({ message }) => frameType(message) === "data");
    expect(dataFrames).toHaveLength(2);
    expect(dataFrames[1]?.message).toMatchObject({ type: "data", sequence: 1 });
    expect((dataFrames[1]?.message as { data: ArrayBuffer }).data.byteLength).toBe(9);
    expect(transport.getSnapshot()).toMatchObject({
      queuedInputBytes: 0,
      inputCreditBytes: 0,
      bytesToRemote: String(bytes.byteLength),
    });
  });

  it("zeroes attached output immediately after the synchronous terminal callback", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const observed: Uint8Array[] = [];
    const onOutput = vi.fn((bytes: Uint8Array) => observed.push(Uint8Array.from(bytes)));
    transport.subscribe({ onOutput, onClose: vi.fn() });
    const frame = serverData(0, new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74]));

    port.emit(frame);

    expect(observed).toEqual([new Uint8Array([0x73, 0x65, 0x63, 0x72, 0x65, 0x74])]);
    expect([...onOutput.mock.calls[0]![0] as Uint8Array]).toEqual([0, 0, 0, 0, 0, 0]);
    expect([...new Uint8Array(frame.data)]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("fails closed on an invalid sequence and quarantines a stale route", async () => {
    let isCurrent = true;
    const harness = openHarness(() => isCurrent);
    const { port, transport } = await openAttached(harness);
    const onClose = vi.fn();
    transport.subscribe({ onOutput: vi.fn(), onClose });

    const invalidSequence = serverData(1, new Uint8Array([1]));
    port.emit(invalidSequence);
    expect(transport.getSnapshot()).toMatchObject({
      state: "failed",
      closeReason: "transport-error",
      closeDisposition: "outcome-unknown",
    });
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/sequence/u));
    expect(port.closed).toBe(true);
    expect([...new Uint8Array(invalidSequence.data)]).toEqual([0]);

    const nextHarness = openHarness(() => isCurrent);
    const pending = nextHarness.promise;
    isCurrent = false;
    nextHarness.deliverPort();
    await expect(pending).rejects.toThrow(/route changed/u);
    expect(nextHarness.port.closed).toBe(true);
  });

  it("rejects a matching malformed preload envelope and closes every supplied port", async () => {
    const harness = openHarness();
    const correlationId = harness.correlationId();
    const extraPort = new FakeMessagePort();
    const event = new MessageEvent("message", {
      data: {
        source: "sliver-preload",
        type: "stream-port",
        v: STREAM_PROTOCOL_VERSION,
        correlationId,
        unexpected: true,
      },
      source: window,
      ports: [harness.port as unknown as MessagePort, extraPort as unknown as MessagePort],
    });
    window.dispatchEvent(event);

    await expect(harness.promise).rejects.toThrow(/invalid stream capability/u);
    expect(harness.port.closed).toBe(true);
    expect(extraPort.closed).toBe(true);
  });

  it("sends an explicit detach disposition and releases the port", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    transport.detach();

    expect(port.sent.at(-1)?.message).toMatchObject({
      type: "close",
      disposition: "detach",
      streamId,
    });
    expect(port.closed).toBe(true);
    expect(transport.getSnapshot()).toMatchObject({
      state: "detached",
      closeReason: "operator-detach",
      closeDisposition: "detached",
    });
  });

  it("emits only shared-contract terminal dimensions at the wire boundary", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const sentBeforeResize = port.sent.length;

    transport.resize(STREAM_MAX_TERMINAL_DIMENSION, STREAM_MAX_TERMINAL_DIMENSION);
    expect(port.sent.at(-1)?.message).toMatchObject({
      type: "resize",
      columns: STREAM_MAX_TERMINAL_DIMENSION,
      rows: STREAM_MAX_TERMINAL_DIMENSION,
    });
    transport.resize(STREAM_MAX_TERMINAL_DIMENSION + 1, 24);
    transport.resize(80, STREAM_MAX_TERMINAL_DIMENSION + 1);
    expect(port.sent).toHaveLength(sentBeforeResize + 1);
    expect(transport.getSnapshot().state).toBe("attached");
  });
});

function openHarness(isCurrent: () => boolean = () => true) {
  const port = new FakeMessagePort();
  const openStream = vi.fn();
  const promise = SessionShellTransport.open({
    attachmentToken,
    expectedResourceId: resourceId,
    canResize: true,
    isCurrent,
    attachTimeoutMilliseconds: 500,
    targetWindow: window,
    api: { openStream },
  });
  const correlationId = () => {
    const value = openStream.mock.calls[0]?.[1];
    if (typeof value !== "string") throw new Error("openStream correlation was not recorded");
    return value;
  };
  const deliverPort = () => {
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "sliver-preload",
        type: "stream-port",
        v: STREAM_PROTOCOL_VERSION,
        correlationId: correlationId(),
      },
      source: window,
      ports: [port as unknown as MessagePort],
    }));
  };
  return { correlationId, deliverPort, openStream, port, promise };
}

async function openAttached(
  harness: ReturnType<typeof openHarness>,
  inputCreditBytes = STREAM_INITIAL_CREDIT_BYTES,
) {
  harness.deliverPort();
  harness.port.emit(serverReady());
  expect(harness.port.sent.at(-1)?.message).toMatchObject({
    type: "start",
    streamId,
    receiveCreditBytes: STREAM_INITIAL_CREDIT_BYTES,
  });
  harness.port.emit(serverOpened(inputCreditBytes));
  const transport = await harness.promise;
  await waitFor(() => expect(transport.getSnapshot().state).toBe("attached"));
  return { port: harness.port, transport };
}

function serverReady(): StreamServerFrame {
  return {
    v: STREAM_PROTOCOL_VERSION,
    type: "ready",
    streamId,
    limits: {
      maxFrameBytes: STREAM_MAX_FRAME_BYTES,
      maxCreditBytes: 128 * 1_024,
      inputCreditBytes: STREAM_INITIAL_CREDIT_BYTES,
      handshakeTimeoutMilliseconds: 5_000,
      idleTimeoutMilliseconds: 30 * 60 * 1_000,
    },
  };
}

function serverOpened(inputCreditBytes: number): StreamServerFrame {
  return {
    v: STREAM_PROTOCOL_VERSION,
    type: "opened",
    streamId,
    resource: {
      resourceId,
      kind: "session-shell",
      pty: "requested-unconfirmed",
    },
    inputCreditBytes,
  };
}

function serverData(
  sequence: number,
  bytes: Uint8Array,
): Extract<StreamServerFrame, { type: "data" }> {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return {
    v: STREAM_PROTOCOL_VERSION,
    type: "data",
    streamId,
    sequence,
    data,
  };
}

function serverCredit(bytes: number): StreamServerFrame {
  return {
    v: STREAM_PROTOCOL_VERSION,
    type: "credit",
    streamId,
    bytes,
  };
}

function serverClosed(reason: "completed" | "remote-close" | "transport-error"): StreamServerFrame {
  return {
    v: STREAM_PROTOCOL_VERSION,
    type: "closed",
    streamId,
    reason,
    disposition: "closed",
    metrics: {
      bytesFromRenderer: "0",
      bytesToRenderer: "0",
      framesFromRenderer: "0",
      framesToRenderer: "0",
      queuedInputBytes: 0,
      queuedOutputBytes: 0,
      inFlightInputBytes: 0,
      inputCreditBytes: 0,
      outputCreditBytes: 0,
      highWaterInputBytes: 0,
      highWaterOutputBytes: 0,
      pressure: "normal",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

function frameType(value: unknown): string | undefined {
  return typeof value === "object" && value !== null
    ? String((value as { type?: unknown }).type)
    : undefined;
}

class FakeMessagePort {
  readonly sent: Array<{
    message: unknown;
    transfer: Transferable[];
    sourceData?: ArrayBuffer;
  }> = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;
  started = false;

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const callable: EventListener = typeof listener === "function"
      ? listener
      : (event) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(callable);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (typeof listener === "function") this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    const sourceData = typeof message === "object" && message !== null &&
      (message as { data?: unknown }).data instanceof ArrayBuffer
      ? (message as { data: ArrayBuffer }).data
      : undefined;
    this.sent.push({
      message: structuredClone(message),
      transfer,
      ...(sourceData ? { sourceData } : {}),
    });
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }

  emit(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}
