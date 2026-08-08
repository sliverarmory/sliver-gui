// @vitest-environment node

import { createDecipheriv } from "node:crypto";
import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import type { StageListenerInput } from "../shared/contracts.js";
import { buildStagePayload } from "./stage-payload.js";

function stageInput(overrides: Partial<StageListenerInput> = {}): StageListenerInput {
  return {
    kind: "stage",
    host: "127.0.0.1",
    port: 8080,
    profileName: "default-stage",
    compression: "none",
    aesKey: "",
    aesIv: "",
    rc4Key: "",
    ...overrides,
  };
}

function payloadBody(framed: Buffer): Buffer {
  const body = framed.subarray(4);
  expect(framed.readUInt32LE(0)).toBe(body.length);
  return body;
}

describe("stage payload transforms", () => {
  it("prepends a little-endian payload size without mutating raw bytes", () => {
    const source = Buffer.from([0x00, 0x01, 0x7f, 0xff]);
    const original = Buffer.from(source);

    const framed = buildStagePayload(source, stageInput());

    expect(framed).not.toBe(source);
    expect(framed.readUInt32LE(0)).toBe(source.length);
    expect(framed.subarray(4)).toEqual(source);
    expect(source).toEqual(original);
  });

  it.each([
    ["gzip", gunzipSync],
    ["zlib", inflateSync],
    ["deflate", inflateRawSync],
  ] as const)("compresses with %s before framing", (compression, decompress) => {
    const source = Buffer.from("repeatable stage payload ".repeat(32));
    const compressed = payloadBody(buildStagePayload(source, stageInput({ compression })));

    expect(compressed.length).toBeLessThan(source.length);
    expect(decompress(compressed)).toEqual(source);
  });

  it("AES-encrypts after compression and prefixes the IV", () => {
    const source = Buffer.from("secret stage payload ".repeat(16));
    const keyText = "0123456789abcdef";
    const ivText = "fedcba9876543210";
    const body = payloadBody(
      buildStagePayload(source, stageInput({
        compression: "gzip",
        aesKey: keyText,
        aesIv: ivText,
      })),
    );

    const iv = body.subarray(0, 16);
    const decipher = createDecipheriv("aes-128-cbc", Buffer.from(keyText), iv);
    const compressed = Buffer.concat([decipher.update(body.subarray(16)), decipher.final()]);

    expect(iv.toString("utf8")).toBe(ivText);
    expect(gunzipSync(compressed)).toEqual(source);
  });

  it("uses the documented zero-text IV when AES IV is blank", () => {
    const body = payloadBody(
      buildStagePayload(Buffer.from("payload"), stageInput({ aesKey: "0123456789abcdef" })),
    );

    expect(body.subarray(0, 16).toString("utf8")).toBe("0000000000000000");
  });

  it("produces the standard RC4 test vector", () => {
    const body = payloadBody(
      buildStagePayload(Buffer.from("Plaintext", "ascii"), stageInput({ rc4Key: "Key" })),
    );

    expect(body.toString("hex")).toBe("bbf316e8d940af0ad3");
  });

  it("rejects ambiguous or invalid encryption settings", () => {
    expect(() => buildStagePayload(Buffer.from("payload"), stageInput({
      aesKey: "0123456789abcdef",
      rc4Key: "rc4",
    }))).toThrow(/cannot be used together/);
    expect(() => buildStagePayload(Buffer.from("payload"), stageInput({ aesKey: "short" }))).toThrow(
      /exactly 16 or 32/,
    );
    expect(() => buildStagePayload(Buffer.from("payload"), stageInput({
      aesKey: "0123456789abcdef",
      aesIv: "short",
    }))).toThrow(/exactly 16/);
  });
});
