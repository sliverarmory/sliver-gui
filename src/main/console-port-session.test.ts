// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  CONSOLE_INITIAL_CREDIT_BYTES,
  CONSOLE_MAX_FRAME_BYTES,
  CONSOLE_MAX_QUEUE_BYTES,
  CONSOLE_PROTOCOL_VERSION,
  type ConsoleClientFrame,
  type ConsoleServerFrame,
} from "../shared/console-contracts.js";
import { ConsolePortSession, type ConsoleAttachmentPort } from "./console-port-session.js";
import type {
  SliverConsoleExit,
  SliverConsoleRuntime,
  SliverConsoleSubscriber,
} from "./console-runtime.js";

const owner = Object.freeze({
  contentsId: 7,
  rendererProcessId: 70,
  rendererFrameToken: "main-frame",
});

describe("ConsolePortSession", () => {
  it("binds a one-use capability and applies credit to PTY input and output", async () => {
    const runtime = new FakeRuntime();
    const port = new FakePort();
    const ids = ["A".repeat(43), "B".repeat(43)];
    const session = new ConsolePortSession(runtime.asRuntime(), owner, {
      createOpaqueId: () => ids.shift()!,
    });

    session.attach(owner, session.attachmentToken, port);
    const ready = port.last("ready");
    if (!ready) throw new Error("Expected console ready frame");
    port.send({
      v: CONSOLE_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: 64 * 1_024,
    });

    runtime.output(Uint8Array.from([104, 105]));
    const output = port.last("data");
    expect(output && [...new Uint8Array(output.data)]).toEqual([104, 105]);

    const input = Uint8Array.from([108, 115, 10]);
    port.send({
      v: 1,
      type: "data",
      streamId: ready.streamId,
      sequence: 0,
      data: input.buffer,
    });
    expect(runtime.writes).toEqual([[108, 115, 10]]);
    expect(input).toEqual(Uint8Array.from([0, 0, 0]));
    expect(port.last("credit")).toMatchObject({ bytes: 3 });

    port.send({
      v: 1,
      type: "resize",
      streamId: ready.streamId,
      columns: 132,
      rows: 42,
    });
    expect(runtime.resizes).toEqual([[132, 42]]);

    await session.close("operator-close");
    expect(runtime.close).toHaveBeenCalledOnce();
    expect(port.last("closed")).toMatchObject({ reason: "operator-close" });
  });

  it("backpressures a multi-hundred-KiB output burst until delayed renderer credits drain it", async () => {
    const runtime = new FakeRuntime();
    const port = new FakePort();
    const session = new ConsolePortSession(runtime.asRuntime(), owner);
    session.attach(owner, session.attachmentToken, port);
    const ready = port.last("ready")!;
    port.send({
      v: CONSOLE_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: CONSOLE_INITIAL_CREDIT_BYTES,
    });

    // Before native output backpressure, the initial 64 KiB credit plus the
    // 128 KiB main-process queue tolerated exactly 192 KiB; the next byte
    // closed the whole client as a transport error. Keep renderer credits
    // delayed while a substantially larger native burst arrives.
    const burstBytes = 512 * 1_024;
    runtime.outputBurst(burstBytes, 64 * 1_024);

    expect(runtime.pauseOutput).toHaveBeenCalled();
    expect(runtime.pendingOutputBytes).toBeGreaterThan(0);
    expect(port.last("closed")).toBeUndefined();
    expect(runtime.close).not.toHaveBeenCalled();

    let creditedFrames = 0;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const outputFrames = port.all("data");
      const deliveredBytes = outputFrames.reduce((total, frame) => total + frame.data.byteLength, 0);
      if (deliveredBytes === burstBytes) break;
      expect(deliveredBytes).toBeLessThan(burstBytes);
      const uncreditedFrames = outputFrames.slice(creditedFrames);
      expect(uncreditedFrames.length).toBeGreaterThan(0);
      for (const frame of uncreditedFrames) {
        port.send({
          v: CONSOLE_PROTOCOL_VERSION,
          type: "credit",
          streamId: ready.streamId,
          bytes: frame.data.byteLength,
        });
        creditedFrames += 1;
      }
    }

    const outputFrames = port.all("data");
    expect(outputFrames.every((frame) => frame.data.byteLength <= CONSOLE_MAX_FRAME_BYTES)).toBe(true);
    expect(outputFrames.reduce((total, frame) => total + frame.data.byteLength, 0)).toBe(burstBytes);
    const output = Buffer.concat(outputFrames.map((frame) => Buffer.from(frame.data)));
    expect(Array.from({ length: burstBytes / (64 * 1_024) }, (_, index) => output[index * 64 * 1_024]))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(runtime.pendingOutputBytes).toBe(0);
    expect(runtime.resumeOutput).toHaveBeenCalled();
    expect(port.last("closed")).toBeUndefined();
    expect(runtime.close).not.toHaveBeenCalled();

    // The old failure boundary is documented in terms of the negotiated
    // constants so a future limit change cannot silently weaken this case.
    expect(CONSOLE_INITIAL_CREDIT_BYTES + CONSOLE_MAX_QUEUE_BYTES).toBe(192 * 1_024);
    await session.close("operator-close");
  });

  it("releases runtime backpressure when a detachable SSH attachment closes", async () => {
    const runtime = new FakeRuntime();
    const port = new FakePort();
    const session = new ConsolePortSession(runtime.asRuntime(), owner, {
      closeRuntimeOnSessionClose: false,
    });
    session.attach(owner, session.attachmentToken, port);
    const ready = port.last("ready")!;
    port.send({
      v: CONSOLE_PROTOCOL_VERSION,
      type: "start",
      streamId: ready.streamId,
      receiveCreditBytes: CONSOLE_INITIAL_CREDIT_BYTES,
    });

    runtime.outputBurst(512 * 1_024, 64 * 1_024);
    expect(runtime.pauseOutput).toHaveBeenCalledOnce();
    expect(runtime.pendingOutputBytes).toBeGreaterThan(0);

    await session.close("window-closed");

    expect(runtime.resumeOutput).toHaveBeenCalledOnce();
    expect(runtime.pendingOutputBytes).toBe(0);
    expect(runtime.close).not.toHaveBeenCalled();
  });

  it("rejects another renderer without consuming the valid owner capability", async () => {
    const runtime = new FakeRuntime();
    const session = new ConsolePortSession(runtime.asRuntime(), owner);
    const rejected = new FakePort();
    expect(() => session.attach({ ...owner, rendererProcessId: 71 }, session.attachmentToken, rejected))
      .toThrow(/unavailable/u);
    expect(rejected.closed).toBe(true);

    const accepted = new FakePort();
    session.attach(owner, session.attachmentToken, accepted);
    expect(accepted.last("ready")).toBeDefined();
    await session.close("window-closed");
  });

  it("closes with a fixed completed disposition when the native client exits", async () => {
    const runtime = new FakeRuntime();
    const port = new FakePort();
    const session = new ConsolePortSession(runtime.asRuntime(), owner);
    session.attach(owner, session.attachmentToken, port);
    const ready = port.last("ready")!;
    port.send({ v: 1, type: "start", streamId: ready.streamId, receiveCreditBytes: 1024 });

    runtime.exit({ exitCode: 7 });
    await vi.waitFor(() => expect(port.last("closed")).toMatchObject({ reason: "completed", exitCode: 7 }));
  });

  it("bounds cumulative PTY input and wipes the frame rejected at the lifetime ceiling", async () => {
    const runtime = new FakeRuntime();
    const port = new FakePort();
    const session = new ConsolePortSession(runtime.asRuntime(), owner, { maxSessionInputBytes: 4 });
    session.attach(owner, session.attachmentToken, port);
    const ready = port.last("ready")!;
    port.send({ v: 1, type: "start", streamId: ready.streamId, receiveCreditBytes: 1_024 });

    const accepted = Uint8Array.from([1, 2, 3]);
    port.send({ v: 1, type: "data", streamId: ready.streamId, sequence: 0, data: accepted.buffer });
    const rejected = Uint8Array.from([4, 5]);
    port.send({ v: 1, type: "data", streamId: ready.streamId, sequence: 1, data: rejected.buffer });

    await vi.waitFor(() => expect(port.last("closed")).toMatchObject({ reason: "protocol-error" }));
    expect(runtime.writes).toEqual([[1, 2, 3]]);
    expect(accepted).toEqual(Uint8Array.from([0, 0, 0]));
    expect(rejected).toEqual(Uint8Array.from([0, 0]));
  });
});

class FakeRuntime {
  readonly writes: number[][] = [];
  readonly resizes: Array<[number, number]> = [];
  readonly close = vi.fn(async () => undefined);
  readonly pauseOutput = vi.fn(() => {
    this.outputPaused = true;
  });
  readonly resumeOutput = vi.fn(() => {
    this.outputPaused = false;
    this.drainPendingOutput();
  });
  private subscriber: SliverConsoleSubscriber | undefined;
  private readonly pendingOutput: Uint8Array[] = [];
  private outputPaused = false;
  private drainingOutput = false;

  get pendingOutputBytes(): number {
    return this.pendingOutput.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  asRuntime(): SliverConsoleRuntime {
    return this as unknown as SliverConsoleRuntime;
  }

  subscribe(subscriber: SliverConsoleSubscriber): () => void {
    this.subscriber = subscriber;
    return () => {
      if (this.subscriber === subscriber) this.subscriber = undefined;
    };
  }

  write(data: Uint8Array): void {
    this.writes.push([...data]);
    data.fill(0);
  }

  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }

  output(data: Uint8Array): void {
    this.subscriber?.onOutput(data);
  }

  outputBurst(byteLength: number, eventBytes: number): void {
    for (let offset = 0; offset < byteLength; offset += eventBytes) {
      const eventNumber = Math.floor(offset / eventBytes) + 1;
      this.pendingOutput.push(new Uint8Array(Math.min(eventBytes, byteLength - offset)).fill(eventNumber));
    }
    this.drainPendingOutput();
  }

  exit(exit: SliverConsoleExit): void {
    this.subscriber?.onExit(exit);
  }

  private drainPendingOutput(): void {
    if (this.drainingOutput) return;
    this.drainingOutput = true;
    try {
      while (!this.outputPaused) {
        const chunk = this.pendingOutput.shift();
        if (!chunk) break;
        this.subscriber?.onOutput(chunk);
      }
    } finally {
      this.drainingOutput = false;
    }
  }
}

class FakePort implements ConsoleAttachmentPort {
  readonly frames: ConsoleServerFrame[] = [];
  closed = false;
  private messageListener: ((message: unknown) => void) | undefined;
  private closeListener: (() => void) | undefined;

  postMessage(frame: ConsoleServerFrame): void {
    this.frames.push(structuredClone(frame));
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListener = listener;
    return () => {
      if (this.messageListener === listener) this.messageListener = undefined;
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListener = listener;
    return () => {
      if (this.closeListener === listener) this.closeListener = undefined;
    };
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }

  send(frame: ConsoleClientFrame): void {
    this.messageListener?.(frame);
  }

  last<T extends ConsoleServerFrame["type"]>(type: T): Extract<ConsoleServerFrame, { type: T }> | undefined {
    return this.frames.findLast(
      (frame): frame is Extract<ConsoleServerFrame, { type: T }> => frame.type === type,
    );
  }

  all<T extends ConsoleServerFrame["type"]>(type: T): Array<Extract<ConsoleServerFrame, { type: T }>> {
    return this.frames.filter(
      (frame): frame is Extract<ConsoleServerFrame, { type: T }> => frame.type === type,
    );
  }
}
