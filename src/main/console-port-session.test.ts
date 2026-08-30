// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
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
  private subscriber: SliverConsoleSubscriber | undefined;

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

  exit(exit: SliverConsoleExit): void {
    this.subscriber?.onExit(exit);
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
}
