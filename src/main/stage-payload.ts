import { createCipheriv } from "node:crypto";
import { deflateRawSync, gzipSync, deflateSync } from "node:zlib";

import type { StageListenerInput } from "../shared/contracts.js";

export function buildStagePayload(source: Buffer, input: StageListenerInput): Buffer {
  if (input.aesKey && input.rc4Key) throw new Error("AES and RC4 encryption cannot be used together");

  let payload = compress(source, input.compression);
  if (input.aesKey) payload = encryptAes(payload, input.aesKey, input.aesIv);
  if (input.rc4Key) payload = encryptRc4(payload, input.rc4Key);

  const size = Buffer.allocUnsafe(4);
  size.writeUInt32LE(payload.length);
  return Buffer.concat([size, payload]);
}

function compress(source: Buffer, compression: StageListenerInput["compression"]): Buffer {
  switch (compression) {
    case "gzip":
      return gzipSync(source);
    case "zlib":
      return deflateSync(source);
    case "deflate":
      return deflateRawSync(source, { level: 9 });
    case "none":
      return source;
  }
}

function encryptAes(source: Buffer, keyText: string, ivText: string): Buffer {
  const key = Buffer.from(keyText, "utf8");
  const iv = Buffer.from(ivText || "0000000000000000", "utf8");
  try {
    if (key.length !== 16 && key.length !== 32) throw new Error("AES key must be exactly 16 or 32 UTF-8 bytes");
    if (iv.length !== 16) throw new Error("AES IV must be exactly 16 UTF-8 bytes");

    const cipher = createCipheriv(key.length === 16 ? "aes-128-cbc" : "aes-256-cbc", key, iv);
    return Buffer.concat([iv, cipher.update(source), cipher.final()]);
  } finally {
    key.fill(0);
    iv.fill(0);
  }
}

function encryptRc4(source: Buffer, keyText: string): Buffer {
  const key = Buffer.from(keyText, "utf8");
  try {
    if (key.length < 1 || key.length > 256) throw new Error("RC4 key must be between 1 and 256 UTF-8 bytes");

    const state = Uint8Array.from({ length: 256 }, (_, index) => index);
    let j = 0;
    for (let i = 0; i < 256; i += 1) {
      j = (j + state[i]! + key[i % key.length]!) & 0xff;
      [state[i], state[j]] = [state[j]!, state[i]!];
    }

    const output = Buffer.allocUnsafe(source.length);
    let i = 0;
    j = 0;
    for (let offset = 0; offset < source.length; offset += 1) {
      i = (i + 1) & 0xff;
      j = (j + state[i]!) & 0xff;
      [state[i], state[j]] = [state[j]!, state[i]!];
      output[offset] = source[offset]! ^ state[(state[i]! + state[j]!) & 0xff]!;
    }
    state.fill(0);
    return output;
  } finally {
    key.fill(0);
  }
}
