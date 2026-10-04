// @vitest-environment node

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  STREAM_CLOSE_REASONS,
  STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
  STREAM_IDLE_TIMEOUT_MILLISECONDS,
  STREAM_MAX_CREDIT_BYTES,
  STREAM_MAX_CREDIT_GRANT_BYTES,
  STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
  STREAM_MAX_FRAME_BYTES,
  STREAM_MAX_QUEUE_BYTES,
  STREAM_MAX_TERMINAL_DIMENSION,
  STREAM_PROTOCOL_VERSION,
  STREAM_RENDERER_PORT_MESSAGE,
  STREAM_RESERVED_BYTES_PER_RESOURCE,
  type StreamMetrics,
  type TerminalRuntimeAsset,
  parseListSessionShellsInput,
  parsePrepareSessionShellInput,
  parseSessionShellResourceActionInput,
  parseStreamAttachRequest,
  parseStreamClientFrame,
  parseStreamCorrelationId,
  parseStreamServerFrame,
} from "./stream-contracts.js";

const STREAM_ID = "A".repeat(43);
const RESOURCE_ID = "B".repeat(43);
const ATTACHMENT_TOKEN = "C".repeat(43);
const CREATED_AT = "2026-08-10T20:00:00.000Z";
const LAST_ACTIVITY_AT = "2026-08-10T20:00:01.000Z";

describe("bounded stream contracts", () => {
  it("keeps the protocol constants conservative and fixed", () => {
    expect(STREAM_PROTOCOL_VERSION).toBe(1);
    expect(STREAM_RENDERER_PORT_MESSAGE).toBe("sliver:stream:port");
    expect(STREAM_MAX_FRAME_BYTES).toBe(16 * 1_024);
    expect(STREAM_MAX_CREDIT_BYTES).toBe(128 * 1_024);
    expect(STREAM_MAX_QUEUE_BYTES).toBe(128 * 1_024);
    expect(STREAM_MAX_DETACHED_SCROLLBACK_BYTES).toBe(256 * 1_024);
    expect(STREAM_RESERVED_BYTES_PER_RESOURCE).toBe(512 * 1_024);
    expect(STREAM_MAX_TERMINAL_DIMENSION).toBe(1_000);
    expect(STREAM_CLOSE_REASONS).toContain("renderer-gone");
    expect(STREAM_CLOSE_REASONS).toContain("detached-buffer-exhausted");
  });

  it("parses shell preparation without accepting renderer-selected targets", () => {
    expect(parsePrepareSessionShellInput({ requestPty: false })).toEqual({ requestPty: false });
    expect(parsePrepareSessionShellInput({
      path: "/bin/zsh",
      requestPty: true,
      rows: 40,
      columns: 120,
    })).toEqual({ path: "/bin/zsh", requestPty: true, rows: 40, columns: 120 });

    expect(() => parsePrepareSessionShellInput({ requestPty: true, targetId: "session-2" }))
      .toThrow(/Unexpected session shell input field/u);
    expect(() => parsePrepareSessionShellInput({ requestPty: false, rows: 24, columns: 80 }))
      .toThrow(/dimensions require requestPty/u);
    expect(() => parsePrepareSessionShellInput({ requestPty: true, rows: 24 }))
      .toThrow(/provided together/u);
    expect(() => parsePrepareSessionShellInput({ requestPty: true, rows: 1_001, columns: 80 }))
      .toThrow(/rows/u);
    expect(() => parsePrepareSessionShellInput({ requestPty: true, rows: 24, columns: 1_001 }))
      .toThrow(/columns/u);
    expect(() => parsePrepareSessionShellInput({ path: "/bin/zsh\0--evil", requestPty: false }))
      .toThrow(/path/u);
  });

  it("keeps list, resource actions, attach envelopes, and correlation IDs closed", () => {
    expect(parseListSessionShellsInput({})).toEqual({});
    expect(() => parseListSessionShellsInput({ ownerWindowId: 7 })).toThrow(/Unexpected/u);

    for (const action of ["attach", "detach", "close", "kill"] as const) {
      expect(parseSessionShellResourceActionInput({ resourceId: RESOURCE_ID, action })).toEqual({
        resourceId: RESOURCE_ID,
        action,
      });
    }
    expect(() => parseSessionShellResourceActionInput({ resourceId: RESOURCE_ID, action: "send-signal" }))
      .toThrow(/unsupported/u);
    expect(() => parseSessionShellResourceActionInput({
      resourceId: RESOURCE_ID,
      action: "close",
      backendId: "renderer-choice",
    })).toThrow(/Unexpected/u);

    expect(parseStreamAttachRequest({ v: 1, attachmentToken: ATTACHMENT_TOKEN })).toEqual({
      v: 1,
      attachmentToken: ATTACHMENT_TOKEN,
    });
    expect(() => parseStreamAttachRequest({ v: 2, attachmentToken: ATTACHMENT_TOKEN })).toThrow(/version/u);
    expect(() => parseStreamAttachRequest({
      v: 1,
      attachmentToken: ATTACHMENT_TOKEN,
      streamId: STREAM_ID,
    })).toThrow(/Unexpected/u);

    expect(parseStreamCorrelationId(STREAM_ID)).toBe(STREAM_ID);
    expect(parseStreamCorrelationId("8e577480-5dc2-4dde-aa58-23c8f1770627"))
      .toBe("8e577480-5dc2-4dde-aa58-23c8f1770627");
    expect(() => parseStreamCorrelationId("8e577480-5dc2-3dde-aa58-23c8f1770627")).toThrow(/invalid/u);
    expect(() => parseStreamCorrelationId("../port")).toThrow(/invalid/u);
  });

  it("parses every renderer-to-main frame with exact keys and hard bounds", () => {
    expect(parseStreamClientFrame({
      v: 1,
      type: "start",
      streamId: STREAM_ID,
      receiveCreditBytes: STREAM_MAX_CREDIT_BYTES,
    })).toMatchObject({ type: "start", receiveCreditBytes: STREAM_MAX_CREDIT_BYTES });
    const data = new Uint8Array([0, 1, 2]).buffer;
    expect(parseStreamClientFrame({ v: 1, type: "data", streamId: STREAM_ID, sequence: 0, data }))
      .toMatchObject({ type: "data", sequence: 0, data });
    expect(parseStreamClientFrame({
      v: 1,
      type: "credit",
      streamId: STREAM_ID,
      bytes: STREAM_MAX_CREDIT_GRANT_BYTES,
    })).toMatchObject({ type: "credit", bytes: STREAM_MAX_CREDIT_GRANT_BYTES });
    expect(parseStreamClientFrame({
      v: 1,
      type: "resize",
      streamId: STREAM_ID,
      rows: 1_000,
      columns: 1_000,
    })).toMatchObject({ type: "resize", rows: 1_000, columns: 1_000 });
    expect(parseStreamClientFrame({
      v: 1,
      type: "close",
      streamId: STREAM_ID,
      disposition: "detach",
    })).toMatchObject({ type: "close", disposition: "detach" });

    expect(() => parseStreamClientFrame({
      v: 1,
      type: "data",
      streamId: STREAM_ID,
      sequence: 0,
      data: new ArrayBuffer(STREAM_MAX_FRAME_BYTES + 1),
    })).toThrow(/stream data/u);
    expect(() => parseStreamClientFrame({
      v: 1,
      type: "data",
      streamId: STREAM_ID,
      sequence: 0,
      data: new Uint8Array([1]),
    })).toThrow(/ArrayBuffer/u);
    expect(() => parseStreamClientFrame({
      v: 1,
      type: "credit",
      streamId: STREAM_ID,
      bytes: STREAM_MAX_CREDIT_GRANT_BYTES + 1,
    })).toThrow(/credit bytes/u);
    expect(() => parseStreamClientFrame({
      v: 1,
      type: "resize",
      streamId: STREAM_ID,
      rows: 1_001,
      columns: 80,
    })).toThrow(/resize rows/u);
    expect(() => parseStreamClientFrame({
      v: 1,
      type: "start",
      streamId: STREAM_ID,
      receiveCreditBytes: 1,
      targetId: "session-2",
    })).toThrow(/Unexpected/u);
    expect(() => parseStreamClientFrame(Object.assign(new Date(), {
      v: 1,
      type: "close",
      streamId: STREAM_ID,
      disposition: "close",
    }))).toThrow(/plain object/u);
  });

  it("parses every main-to-renderer frame and freezes nested metadata", () => {
    const ready = parseStreamServerFrame({
      v: 1,
      type: "ready",
      streamId: STREAM_ID,
      limits: {
        maxFrameBytes: STREAM_MAX_FRAME_BYTES,
        maxCreditBytes: STREAM_MAX_CREDIT_BYTES,
        inputCreditBytes: 64 * 1_024,
        handshakeTimeoutMilliseconds: STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
        idleTimeoutMilliseconds: STREAM_IDLE_TIMEOUT_MILLISECONDS,
      },
    });
    expect(ready).toMatchObject({ type: "ready", streamId: STREAM_ID });
    if (ready.type !== "ready") throw new Error("Expected ready frame");
    expect(Object.isFrozen(ready)).toBe(true);
    expect(Object.isFrozen(ready.limits)).toBe(true);

    const opened = parseStreamServerFrame({
      v: 1,
      type: "opened",
      streamId: STREAM_ID,
      resource: { resourceId: RESOURCE_ID, kind: "session-shell", pty: "requested-unconfirmed" },
      inputCreditBytes: 64 * 1_024,
    });
    expect(opened).toMatchObject({
      type: "opened",
      resource: { resourceId: RESOURCE_ID, kind: "session-shell", pty: "requested-unconfirmed" },
    });

    const data = new Uint8Array([3, 4, 5]).buffer;
    expect(parseStreamServerFrame({ v: 1, type: "data", streamId: STREAM_ID, sequence: 0, data }))
      .toMatchObject({ type: "data", sequence: 0, data });
    expect(parseStreamServerFrame({ v: 1, type: "credit", streamId: STREAM_ID, bytes: 1 }))
      .toMatchObject({ type: "credit", bytes: 1 });
    expect(parseStreamServerFrame({
      v: 1,
      type: "pressure",
      streamId: STREAM_ID,
      level: "high",
      queuedBytes: STREAM_RESERVED_BYTES_PER_RESOURCE,
    })).toMatchObject({ type: "pressure", level: "high" });

    const closed = parseStreamServerFrame({
      v: 1,
      type: "closed",
      streamId: STREAM_ID,
      reason: "operator-detach",
      disposition: "detached",
      metrics: metrics(),
    });
    expect(closed).toMatchObject({ type: "closed", reason: "operator-detach", disposition: "detached" });
    if (closed.type !== "closed") throw new Error("Expected closed frame");
    expect(Object.isFrozen(closed.metrics)).toBe(true);
  });

  it("rejects malformed, oversized, and content-bearing server frames", () => {
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "ready",
      streamId: STREAM_ID,
      limits: {
        maxFrameBytes: STREAM_MAX_FRAME_BYTES,
        maxCreditBytes: STREAM_MAX_CREDIT_BYTES,
        inputCreditBytes: 0,
        handshakeTimeoutMilliseconds: STREAM_HANDSHAKE_TIMEOUT_MILLISECONDS,
        idleTimeoutMilliseconds: STREAM_IDLE_TIMEOUT_MILLISECONDS,
        connectUrl: "https://remote.invalid",
      },
    })).toThrow(/Unexpected/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "opened",
      streamId: STREAM_ID,
      resource: {
        resourceId: RESOURCE_ID,
        kind: "session-shell",
        pty: "disabled",
        tunnelId: "raw-server-handle",
      },
      inputCreditBytes: 0,
    })).toThrow(/Unexpected/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "data",
      streamId: STREAM_ID,
      sequence: 0,
      data: new ArrayBuffer(STREAM_MAX_FRAME_BYTES + 1),
    })).toThrow(/server data/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "pressure",
      streamId: STREAM_ID,
      level: "high",
      queuedBytes: STREAM_RESERVED_BYTES_PER_RESOURCE + 1,
    })).toThrow(/queuedBytes/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "closed",
      streamId: STREAM_ID,
      reason: "operator-detach",
      disposition: "closed",
      metrics: metrics(),
    })).toThrow(/detach reason/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "closed",
      streamId: STREAM_ID,
      reason: "transport-error",
      disposition: "closed",
      metrics: { ...metrics(), payload: "do-not-log" },
    })).toThrow(/Unexpected/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "closed",
      streamId: STREAM_ID,
      reason: "transport-error",
      disposition: "closed",
      metrics: { ...metrics(), bytesToRenderer: "01" },
    })).toThrow(/bytesToRenderer/u);
    expect(() => parseStreamServerFrame({
      v: 1,
      type: "closed",
      streamId: STREAM_ID,
      reason: "transport-error",
      disposition: "closed",
      metrics: { ...metrics(), lastActivityAt: "2026-08-10T19:59:59.000Z" },
    })).toThrow(/precedes/u);
  });

  it("defines the fixed verified terminal runtime clone shape", () => {
    expectTypeOf<TerminalRuntimeAsset>().toEqualTypeOf<{
      readonly version: "0.4.0";
      readonly sha256: string;
      readonly bytes: Uint8Array;
    }>();
  });
});

function metrics(): StreamMetrics {
  return {
    bytesFromRenderer: "3",
    bytesToRenderer: "5",
    framesFromRenderer: "1",
    framesToRenderer: "1",
    queuedInputBytes: STREAM_MAX_QUEUE_BYTES,
    queuedOutputBytes: STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
    inFlightInputBytes: STREAM_MAX_FRAME_BYTES,
    inputCreditBytes: STREAM_MAX_CREDIT_BYTES,
    outputCreditBytes: STREAM_MAX_CREDIT_BYTES,
    highWaterInputBytes: STREAM_MAX_QUEUE_BYTES,
    highWaterOutputBytes: STREAM_MAX_DETACHED_SCROLLBACK_BYTES,
    pressure: "high",
    createdAt: CREATED_AT,
    lastActivityAt: LAST_ACTIVITY_AT,
  };
}
