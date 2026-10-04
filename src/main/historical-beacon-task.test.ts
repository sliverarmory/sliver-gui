import { describe, expect, it } from "vitest";

import { sliverpb } from "sliver-script";

import { decodeHistoricalBeaconTask } from "./historical-beacon-task.js";

function savedRequest(type: number): Buffer {
  return Buffer.from(sliverpb.Envelope.encode(sliverpb.Envelope.create({
    Type: type,
    Data: Buffer.from([0x08, 0x01]),
  })).finish());
}

function text(result: ReturnType<typeof decodeHistoricalBeaconTask>): string {
  expect(result.disposition?.kind).toBe("inline-text");
  return result.disposition?.kind === "inline-text" ? result.disposition.text : "";
}

describe("historical beacon task decoder", () => {
  it("renders saved BOF output records with their separate channels", () => {
    const response = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      Output: Buffer.from("duplicate legacy bytes"),
      BOFOutputs: [
        { Type: 0, Data: Buffer.from("first line\nsecond line") },
        { Type: 0x0d, Data: Buffer.from("stderr line") },
        { Type: 4, Data: Buffer.from([0, 255]) },
      ],
      Response: {},
    })).finish());
    const result = decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(91), response);
    const output = text(result);
    expect(output).toContain("first line\nsecond line");
    expect(output).toContain("stderr: stderr line");
    expect(output).toContain("channel 4: hex 00ff");
    expect(output).not.toContain("duplicate legacy bytes");
    expect(result.error).toBeUndefined();
  });

  it("renders legacy extension output after reconnect without local BOF attribution", () => {
    const response = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      Output: Buffer.from("historic extension output"),
    })).finish());
    expect(text(decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(91), response)))
      .toContain("output: historic extension output");
  });

  it("uses pinned response types for other completed beacon tasks", () => {
    const response = Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp/history" })).finish());
    const result = decodeHistoricalBeaconTask("CdReq", savedRequest(11), response);
    expect(text(result)).toContain("Path: /tmp/history");
    expect(text(result)).not.toContain("CdReq");
    expect(result.error).toBeUndefined();
  });

  it("shows saved bytes for unknown task types and explains empty saved payloads", () => {
    expect(text(decodeHistoricalBeaconTask("FutureReq", Buffer.alloc(0), Buffer.from([0, 1, 255]))))
      .toContain("hex 0001ff");
    expect(text(decodeHistoricalBeaconTask("FutureReq", Buffer.alloc(0), Buffer.from("first\nsecond"))))
      .toContain("first\nsecond");
    expect(text(decodeHistoricalBeaconTask("FutureReq", Buffer.alloc(0), Buffer.alloc(0))))
      .toContain("server stored no response payload");
  });

  it("rejects a mismatched request envelope without exposing response bytes", () => {
    const response = Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp" })).finish());
    const result = decodeHistoricalBeaconTask("PwdReq", savedRequest(91), response);
    expect(result.errorKind).toBe("decode-uncertain");
    expect(result.disposition).toBeUndefined();
  });

  it("rejects noncanonical known protobuf bytes", () => {
    const valid = Buffer.from(sliverpb.Pwd.encode(sliverpb.Pwd.create({ Path: "/tmp" })).finish());
    const response = Buffer.concat([valid, Buffer.from([0xf8, 0x07, 0x01])]);
    const result = decodeHistoricalBeaconTask("PwdReq", savedRequest(12), response);
    expect(result.errorKind).toBe("decode-uncertain");
    expect(result.disposition).toBeUndefined();
  });

  it("keeps target error text out of the rendered output", () => {
    const response = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      Output: Buffer.from("partial output"),
      Response: { Err: "remote private failure" },
    })).finish());
    const result = decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(91), response);
    expect(result.errorKind).toBe("target-reported");
    expect(text(result)).toContain("partial output");
    expect(JSON.stringify(result)).not.toContain("remote private failure");
  });

  it("marks limited previews of nested binary fields and BOF records", () => {
    const screenshot = Buffer.from(sliverpb.Screenshot.encode(sliverpb.Screenshot.create({
      Data: Buffer.alloc(512, 0xff),
    })).finish());
    const screenshotResult = decodeHistoricalBeaconTask("ScreenshotReq", savedRequest(47), screenshot);
    expect(screenshotResult.disposition?.kind === "inline-text" && screenshotResult.disposition.truncated).toBe(true);
    expect(text(screenshotResult)).toContain("Data: hex");

    const extension = Buffer.from(sliverpb.CallExtension.encode(sliverpb.CallExtension.create({
      BOFOutputs: [{ Type: 0, Data: Buffer.alloc(5_000, 0x41) }],
    })).finish());
    const extensionResult = decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(91), extension);
    expect(extensionResult.disposition?.kind === "inline-text" && extensionResult.disposition.truncated).toBe(true);
    expect(text(extensionResult)).toContain("stdout: AAAA");
  });

  it("bounds previews of responses too large for structured decoding", () => {
    const response = Buffer.alloc(4 * 1024 * 1024 + 1, 0xff);
    const result = decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(91), response);
    expect(result.disposition?.kind).toBe("inline-text");
    expect(result.disposition?.kind === "inline-text" && result.disposition.truncated).toBe(true);
    expect(text(result).length).toBeLessThan(1_000);
    const mismatched = decodeHistoricalBeaconTask("CallExtensionReq", savedRequest(12), response);
    expect(mismatched.errorKind).toBe("decode-uncertain");
    expect(mismatched.disposition).toBeUndefined();
  });
});
