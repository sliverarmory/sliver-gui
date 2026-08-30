import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONSOLE_INITIAL_CREDIT_BYTES,
  CONSOLE_MAX_CREDIT_BYTES,
  CONSOLE_MAX_FRAME_BYTES,
  CONSOLE_MAX_TERMINAL_DIMENSION,
  CONSOLE_PROTOCOL_VERSION,
  type ConsoleServerFrame,
} from "../../../shared/console-contracts";
import { ConsoleTerminalTransport } from "./console-terminal-transport";

const streamId = "s".repeat(43);
const attachmentToken = "t".repeat(43);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ConsoleTerminalTransport", () => {
  it("accepts one exact preload capability, handshakes, and drains bounded early output", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const output = new TextEncoder().encode("sliver > ");
    const frame = serverData(0, output);

    port.emit(frame);
    expect(transport.getSnapshot()).toMatchObject({
      state: "attached",
      queuedOutputBytes: output.byteLength,
      bytesFromClient: String(output.byteLength),
    });

    let observed: Uint8Array | undefined;
    const onOutput = vi.fn((bytes: Uint8Array) => {
      observed = Uint8Array.from(bytes);
    });
    transport.subscribe({ onOutput, onClose: vi.fn() });

    expect([...observed ?? []]).toEqual([...output]);
    expect([...onOutput.mock.calls[0]![0] as Uint8Array]).toEqual(new Array(output.byteLength).fill(0));
    expect([...new Uint8Array(frame.data)]).toEqual(new Array(output.byteLength).fill(0));
    expect(port.sent.at(-1)?.message).toMatchObject({
      type: "credit",
      bytes: output.byteLength,
      streamId,
    });
  });

  it("chunks renderer input by negotiated frame and credit while preserving sequence", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness, CONSOLE_MAX_FRAME_BYTES);
    const bytes = new Uint8Array(CONSOLE_MAX_FRAME_BYTES + 9).fill(0x61);

    transport.send(bytes, "operator");
    const first = port.sent.find(({ message }) => frameType(message) === "data");
    expect(first?.message).toMatchObject({ type: "data", sequence: 0, streamId });
    expect((first?.message as { data: ArrayBuffer }).data.byteLength).toBe(CONSOLE_MAX_FRAME_BYTES);
    expect([...new Uint8Array(first?.sourceData ?? new ArrayBuffer(0))]).toEqual(
      new Array(CONSOLE_MAX_FRAME_BYTES).fill(0),
    );
    expect(transport.getSnapshot()).toMatchObject({ queuedInputBytes: 9, inputCreditBytes: 0 });

    port.emit(serverCredit(9));
    const frames = port.sent.filter(({ message }) => frameType(message) === "data");
    expect(frames).toHaveLength(2);
    expect(frames[1]?.message).toMatchObject({ type: "data", sequence: 1 });
    expect(transport.getSnapshot()).toMatchObject({
      queuedInputBytes: 0,
      bytesToClient: String(bytes.byteLength),
    });
  });

  it("reports native exit status and releases the one-use port", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const onClose = vi.fn();
    transport.subscribe({ onOutput: vi.fn(), onClose });

    port.emit({
      v: CONSOLE_PROTOCOL_VERSION,
      type: "closed",
      streamId,
      reason: "completed",
      exitCode: 7,
    } satisfies ConsoleServerFrame);

    expect(onClose).toHaveBeenCalledWith("Sliver client exited with code 7");
    expect(transport.getSnapshot()).toMatchObject({
      state: "closed",
      closeReason: "completed",
      exitCode: 7,
    });
    expect(port.closed).toBe(true);
  });

  it("fails closed on an invalid sequence and rejects malformed matching envelopes", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const onClose = vi.fn();
    transport.subscribe({ onOutput: vi.fn(), onClose });
    const invalid = serverData(1, new Uint8Array([1]));

    port.emit(invalid);
    expect(transport.getSnapshot()).toMatchObject({ state: "failed", closeReason: "transport-error" });
    expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/sequence/u));
    expect(port.closed).toBe(true);
    expect([...new Uint8Array(invalid.data)]).toEqual([0]);

    const malformed = openHarness();
    const extraPort = new FakeMessagePort();
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "sliver-preload",
        type: "console-stream-port",
        v: CONSOLE_PROTOCOL_VERSION,
        correlationId: malformed.correlationId(),
        unexpected: true,
      },
      source: window,
      ports: [malformed.port as unknown as MessagePort, extraPort as unknown as MessagePort],
    }));
    await expect(malformed.promise).rejects.toThrow(/invalid Sliver console capability/u);
    expect(malformed.port.closed).toBe(true);
    expect(extraPort.closed).toBe(true);
  });

  it("emits only bounded dimensions and closes the native console explicitly", async () => {
    const harness = openHarness();
    const { port, transport } = await openAttached(harness);
    const sentBeforeResize = port.sent.length;

    transport.resize(CONSOLE_MAX_TERMINAL_DIMENSION, CONSOLE_MAX_TERMINAL_DIMENSION);
    expect(port.sent.at(-1)?.message).toMatchObject({
      type: "resize",
      columns: CONSOLE_MAX_TERMINAL_DIMENSION,
      rows: CONSOLE_MAX_TERMINAL_DIMENSION,
    });
    transport.resize(CONSOLE_MAX_TERMINAL_DIMENSION + 1, 24);
    expect(port.sent).toHaveLength(sentBeforeResize + 1);

    transport.close();
    expect(port.sent.at(-1)?.message).toMatchObject({ type: "close", streamId });
    expect(port.closed).toBe(true);
  });
});

function openHarness() {
  const port = new FakeMessagePort();
  const openConsoleStream = vi.fn();
  const promise = ConsoleTerminalTransport.open({
    attachmentToken,
    attachTimeoutMilliseconds: 500,
    targetWindow: window,
    api: { openConsoleStream },
  });
  const correlationId = () => {
    const value = openConsoleStream.mock.calls[0]?.[1];
    if (typeof value !== "string") throw new Error("Console correlation was not recorded");
    return value;
  };
  const deliverPort = () => {
    window.dispatchEvent(new MessageEvent("message", {
      data: {
        source: "sliver-preload",
        type: "console-stream-port",
        v: CONSOLE_PROTOCOL_VERSION,
        correlationId: correlationId(),
      },
      source: window,
      ports: [port as unknown as MessagePort],
    }));
  };
  return { correlationId, deliverPort, openConsoleStream, port, promise };
}

async function openAttached(
  harness: ReturnType<typeof openHarness>,
  inputCreditBytes = CONSOLE_INITIAL_CREDIT_BYTES,
) {
  harness.deliverPort();
  harness.port.emit(serverReady(inputCreditBytes));
  const transport = await harness.promise;
  expect(harness.port.sent.at(-1)?.message).toMatchObject({
    type: "start",
    streamId,
    receiveCreditBytes: CONSOLE_INITIAL_CREDIT_BYTES,
  });
  expect(transport.getSnapshot().state).toBe("attached");
  return { port: harness.port, transport };
}

function serverReady(inputCreditBytes: number): ConsoleServerFrame {
  return {
    v: CONSOLE_PROTOCOL_VERSION,
    type: "ready",
    streamId,
    limits: {
      maxFrameBytes: CONSOLE_MAX_FRAME_BYTES,
      maxCreditBytes: CONSOLE_MAX_CREDIT_BYTES,
      inputCreditBytes,
    },
  };
}

function serverData(
  sequence: number,
  bytes: Uint8Array,
): Extract<ConsoleServerFrame, { type: "data" }> {
  const data = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(data).set(bytes);
  return {
    v: CONSOLE_PROTOCOL_VERSION,
    type: "data",
    streamId,
    sequence,
    data,
  };
}

function serverCredit(bytes: number): ConsoleServerFrame {
  return {
    v: CONSOLE_PROTOCOL_VERSION,
    type: "credit",
    streamId,
    bytes,
  };
}

function frameType(value: unknown): string | undefined {
  return typeof value === "object" && value !== null
    ? String((value as { type?: unknown }).type)
    : undefined;
}

class FakeMessagePort {
  readonly sent: Array<{ message: unknown; sourceData?: ArrayBuffer }> = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  closed = false;

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

  postMessage(message: unknown): void {
    const sourceData = typeof message === "object" && message !== null &&
      (message as { data?: unknown }).data instanceof ArrayBuffer
      ? (message as { data: ArrayBuffer }).data
      : undefined;
    this.sent.push({
      message: structuredClone(message),
      ...(sourceData ? { sourceData } : {}),
    });
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  emit(message: unknown): void {
    const event = new MessageEvent("message", { data: message });
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
}
