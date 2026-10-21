// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RDP_MAX_CLIPBOARD_BYTES, RDP_MAX_PAYLOAD_BYTES } from "../shared/rdp-contracts.js";
import { RdpRuntime, RdpWireDecoder, parseRdpRuntimeEvent, rdpRuntimeEnvironment, type RdpRuntimeEvent } from "./rdp-runtime.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function wire(header: unknown, payload = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(json.length, 0);
  prefix.writeUInt32LE(payload.length, 4);
  return Buffer.concat([prefix, json, payload]);
}

const frame = { type: "frame", width: 800, height: 600, x: 4, y: 5, tileWidth: 2, tileHeight: 2,
  seq: 1, frameId: 0, geometry: 0, full: true, first: true, last: true };

describe("RdpWireDecoder", () => {
  it("reconstructs every split boundary and multiple records without exposing mutable pipe buffers", () => {
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const bytes = Buffer.concat([wire({ type: "ready", protocol: 1 }), wire(frame, pixels), wire({ type: "state", state: "active" })]);
    for (let split = 0; split <= bytes.length; split += 1) {
      const decoder = new RdpWireDecoder();
      const received: RdpRuntimeEvent[] = [];
      decoder.push(bytes.subarray(0, split), (event) => received.push(event));
      decoder.push(bytes.subarray(split), (event) => received.push(event));
      decoder.finish();
      expect(received.map(({ type }) => type)).toEqual(["ready", "frame", "state"]);
      const display = received[1];
      if (display?.type !== "frame") throw new Error("Missing fixture frame");
      expect(Buffer.from(display.data)).toEqual(pixels);
    }
    const decoder = new RdpWireDecoder();
    let output: RdpRuntimeEvent | undefined;
    const mutable = wire(frame, pixels);
    decoder.push(mutable, (event) => { output = event; });
    mutable.fill(0);
    expect(output?.type).toBe("frame");
    if (output?.type === "frame") expect(Buffer.from(output.data)).toEqual(pixels);
  });

  it.each([[0, 0], [0xffffffff, 0], [2 * 1024 * 1024 + 1, 0], [1, RDP_MAX_PAYLOAD_BYTES + 1]])(
    "rejects hostile declared lengths (%s/%s) immediately after the prefix", (headerLength, payloadLength) => {
      const prefix = Buffer.alloc(8);
      prefix.writeUInt32LE(headerLength!, 0);
      prefix.writeUInt32LE(payloadLength!, 4);
      const decoder = new RdpWireDecoder();
      expect(() => decoder.push(prefix, () => { throw new Error("Unexpected delivery"); })).toThrow(/record length/u);
    },
  );

  it("rejects truncated headers and pixels at EOF without emitting partial frames", () => {
    const bytes = wire(frame, Buffer.alloc(16));
    for (const length of [1, 7, 8, bytes.length - 17, bytes.length - 1]) {
      const decoder = new RdpWireDecoder();
      const events: RdpRuntimeEvent[] = [];
      decoder.push(bytes.subarray(0, length), (event) => events.push(event));
      expect(events).toEqual([]);
      expect(() => decoder.finish()).toThrow(/Truncated/u);
    }
  });

  it("permits bounded large clipboard records but rejects large control headers", () => {
    const decoder = new RdpWireDecoder();
    const text = "x".repeat(RDP_MAX_CLIPBOARD_BYTES);
    const events: RdpRuntimeEvent[] = [];
    decoder.push(wire({ type: "clipboard", text }), (event) => events.push(event));
    decoder.finish();
    expect(events).toEqual([{ type: "clipboard", text }]);
    expect(() => new RdpWireDecoder().push(wire({ type: "ready", protocol: 1, padding: "x".repeat(17 * 1024) }), () => {})).toThrow(/Oversized/u);
  });
});

describe("parseRdpRuntimeEvent", () => {
  it("bounds upload progress counters and rejects premature completion or binary data", () => {
    const progress = { type: "clipboardFileUploadProgress", offerId: "offer", transferId: "upload-1", phase: "transferring",
      transferredBytes: 3, totalBytes: 6, completedFiles: 0, totalFiles: 1 };
    expect(parseRdpRuntimeEvent(progress, Buffer.alloc(0))).toEqual(progress);
    for (const patch of [{ phase: "preparing" }, { phase: "completed" }, { transferredBytes: 7 }, { transferredBytes: -1 },
      { totalBytes: 256 * 1024 * 1024 + 1 }, { totalFiles: 65 }, { completedFiles: 2 }, { transferId: "" }]) {
      expect(() => parseRdpRuntimeEvent({ ...progress, ...patch }, Buffer.alloc(0))).toThrow();
    }
    expect(() => parseRdpRuntimeEvent(progress, Buffer.alloc(1))).toThrow();
    expect(parseRdpRuntimeEvent({ ...progress, phase: "completed", transferredBytes: 6, completedFiles: 1 }, Buffer.alloc(0))).toMatchObject({ phase: "completed" });
  });

  it("decodes bounded file metadata and binary chunks without exposing pipe buffers", () => {
    const files = Array.from({ length: 64 }, (_, index) => ({ name: `${index}-` + "a".repeat(250), size: 0 }));
    const events: RdpRuntimeEvent[] = [];
    const bytes = wire({ type: "clipboardFiles", requestId: "request", clipboardId: "remote", files });
    new RdpWireDecoder().push(bytes, (event) => events.push(event));
    expect(events).toEqual([{ type: "clipboardFiles", requestId: "request", clipboardId: "remote", files }]);
    const payload = Buffer.from("file bytes");
    const event = parseRdpRuntimeEvent({ type: "clipboardFileChunk", requestId: "chunk", error: false }, payload);
    payload.fill(0);
    expect(event).toEqual({ type: "clipboardFileChunk", requestId: "chunk", error: false, data: Buffer.from("file bytes") });
  });

  it("rejects invalid file counts, names, sizes, ranges and failed payloads", () => {
    for (const files of [[], Array.from({ length: 65 }, () => ({ name: "a", size: 0 })), [{ name: "../escape", size: 1 }], [{ name: "large", size: 256 * 1024 * 1024 + 1 }], [{ name: "a", size: 256 * 1024 * 1024 }, { name: "b", size: 1 }]]) {
      expect(() => parseRdpRuntimeEvent({ type: "clipboardFiles", requestId: "id", clipboardId: "remote", files }, Buffer.alloc(0))).toThrow();
    }
    expect(() => parseRdpRuntimeEvent({ type: "clipboardFileRequest", requestId: "id", offerId: "offer", index: 64, offset: 0, length: 1 }, Buffer.alloc(0))).toThrow();
    expect(() => parseRdpRuntimeEvent({ type: "clipboardFileRequest", requestId: "id", offerId: "offer", index: 0, offset: 0, length: 256 * 1024 + 1 }, Buffer.alloc(0))).toThrow();
    expect(() => parseRdpRuntimeEvent({ type: "clipboardFileChunk", requestId: "id", error: true }, Buffer.alloc(1))).toThrow();
  });
  it("accepts explicit clipboard-ready and resize-fallback notifications", () => {
    expect(parseRdpRuntimeEvent({ type: "clipboardReady" }, Buffer.alloc(0))).toEqual({ type: "clipboardReady" });
    expect(parseRdpRuntimeEvent({ type: "resizeFallback" }, Buffer.alloc(0))).toEqual({ type: "resizeFallback" });
    expect(() => parseRdpRuntimeEvent({ type: "clipboardReady" }, Buffer.alloc(1))).toThrow(/Unexpected/u);
  });
  it("does not pass ambient credentials or diagnostic settings into the helper", () => {
    expect(rdpRuntimeEnvironment({ PATH: "/bin", HOME: "/home/test", AWS_SECRET_ACCESS_KEY: "private", SSL_CERT_FILE: "/unreviewed", RUST_LOG: "trace" }))
      .toEqual({ PATH: "/bin", HOME: "/home/test", RUST_LOG: "off" });
  });
  it.each([0, 2, "1", undefined])("rejects incompatible protocol %s", (protocol) => {
    expect(() => parseRdpRuntimeEvent({ type: "ready", protocol }, Buffer.alloc(0))).toThrow(/protocol/u);
  });

  it.each([
    { width: 8193 }, { width: 8192, height: 8192 }, { x: -1 }, { x: 800 }, { y: 600 },
    { x: 799, tileWidth: 2 }, { y: 599, tileHeight: 2 }, { tileWidth: 0 }, { tileHeight: 0 },
    { seq: 0 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { geometry: -1 }, { first: "true" },
  ])("rejects invalid pixel geometry or sequencing %j", (change) => {
    expect(() => parseRdpRuntimeEvent({ ...frame, ...change }, Buffer.alloc(16))).toThrow();
  });

  it("requires exact pixel/cursor lengths, bounded hotspots, and no binary control payloads", () => {
    for (const length of [0, 15, 17]) expect(() => parseRdpRuntimeEvent(frame, Buffer.alloc(length))).toThrow(/pixel/u);
    expect(() => parseRdpRuntimeEvent({ type: "state", state: "active" }, Buffer.alloc(1))).toThrow(/Unexpected/u);
    const cursor = { type: "cursor", kind: "bitmap", width: 2, height: 2, hotspotX: 1, hotspotY: 1 };
    expect(parseRdpRuntimeEvent(cursor, Buffer.alloc(16))).toMatchObject(cursor);
    expect(() => parseRdpRuntimeEvent(cursor, Buffer.alloc(12))).toThrow(/cursor payload/u);
    expect(() => parseRdpRuntimeEvent({ ...cursor, hotspotX: 2 }, Buffer.alloc(16))).toThrow();
    expect(() => parseRdpRuntimeEvent({ ...cursor, width: 257 }, Buffer.alloc(16))).toThrow();
    expect(() => parseRdpRuntimeEvent({ type: "cursor", kind: "hidden" }, Buffer.alloc(4))).toThrow();
  });

  it("bounds clipboard UTF-8 bytes and rejects unknown event types and malformed certificate identity", () => {
    expect(() => parseRdpRuntimeEvent({ type: "clipboard", text: "🙂".repeat(RDP_MAX_CLIPBOARD_BYTES / 4 + 1) }, Buffer.alloc(0))).toThrow(/clipboard/u);
    expect(() => parseRdpRuntimeEvent({ type: "execute", command: "ignored" }, Buffer.alloc(0))).toThrow(/Unknown/u);
    expect(() => parseRdpRuntimeEvent({ type: "certificate", fingerprint: "a".repeat(63) }, Buffer.alloc(0))).toThrow(/fingerprint/u);
    expect(() => parseRdpRuntimeEvent({ type: "error", code: "diagnostic\nsecret" }, Buffer.alloc(0))).toThrow();
  });
});

describe("RdpRuntime shutdown", () => {
  function childFixture() {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const exited = vi.fn();
    const runtime = new RdpRuntime("/fixed/sliver-rdp", vi.fn(), exited);
    return { child, exited, runtime };
  }

  it("shuts down a blocked stdin without recursively enqueueing disconnects", () => {
    vi.useFakeTimers();
    const { child, runtime, exited } = childFixture();
    Object.defineProperty(child.stdin, "writableLength", { value: 5 * 1024 * 1024 });
    expect(() => runtime.send({ type: "snapshot" })).not.toThrow();
    expect(exited).toHaveBeenCalledExactlyOnceWith("runtime-input-limit");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", 1);
  });

  it("retains forced termination after a protocol error until the helper actually exits", () => {
    vi.useFakeTimers();
    const { child, exited } = childFixture();
    child.stdout.emit("data", wire({ type: "ready", protocol: 99 }));
    expect(exited).toHaveBeenCalledExactlyOnceWith("runtime-protocol-error");
    vi.advanceTimersByTime(3000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    child.emit("close", 1);
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("cancels force termination only when a graceful helper exit arrives", () => {
    vi.useFakeTimers();
    const { child, exited, runtime } = childFixture();
    runtime.stop();
    runtime.stop();
    child.emit("close", 0);
    vi.advanceTimersByTime(3000);
    expect(child.kill).not.toHaveBeenCalled();
    expect(exited).toHaveBeenCalledExactlyOnceWith("disconnected");
  });
});
