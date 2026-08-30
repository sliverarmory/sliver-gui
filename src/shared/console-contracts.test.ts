import { describe, expect, it } from "vitest";

import {
  CONSOLE_MAX_FRAME_BYTES,
  CONSOLE_PROTOCOL_VERSION,
  parseConsoleAttachRequest,
  parseConsoleClientFrame,
  parseConsoleServerFrame,
} from "./console-contracts.js";

const opaque = "A".repeat(43);

describe("console contracts", () => {
  it("accepts and freezes only a versioned opaque attachment capability", () => {
    const parsed = parseConsoleAttachRequest({
      v: CONSOLE_PROTOCOL_VERSION,
      attachmentToken: opaque,
    });
    expect(parsed).toEqual({ v: 1, attachmentToken: opaque });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => parseConsoleAttachRequest({ v: 2, attachmentToken: opaque })).toThrow(/version/u);
    expect(() => parseConsoleAttachRequest({ v: 1, attachmentToken: "short" })).toThrow(/invalid/u);
  });

  it("bounds terminal data and dimensions at both protocol boundaries", () => {
    expect(parseConsoleClientFrame({
      v: 1,
      type: "data",
      streamId: opaque,
      sequence: 0,
      data: new ArrayBuffer(CONSOLE_MAX_FRAME_BYTES),
    })).toMatchObject({ type: "data", sequence: 0 });
    expect(() => parseConsoleClientFrame({
      v: 1,
      type: "data",
      streamId: opaque,
      sequence: 0,
      data: new ArrayBuffer(CONSOLE_MAX_FRAME_BYTES + 1),
    })).toThrow(/data/u);
    expect(() => parseConsoleClientFrame({
      v: 1,
      type: "resize",
      streamId: opaque,
      rows: 0,
      columns: 80,
    })).toThrow(/rows/u);
  });

  it("parses ready and fixed close frames without admitting diagnostics", () => {
    const ready = parseConsoleServerFrame({
      v: 1,
      type: "ready",
      streamId: opaque,
      limits: {
        maxFrameBytes: 16_384,
        maxCreditBytes: 131_072,
        inputCreditBytes: 65_536,
      },
    });
    expect(ready).toMatchObject({ type: "ready", limits: { inputCreditBytes: 65_536 } });
    expect(Object.isFrozen(ready)).toBe(true);
    expect(() => parseConsoleServerFrame({
      v: 1,
      type: "closed",
      streamId: opaque,
      reason: "raw-native-error",
    })).toThrow(/reason/u);
  });
});
