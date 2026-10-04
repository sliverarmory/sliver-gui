import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2.js";

const KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
export const MAX_ARMORY_MANIFEST_BYTES = 1024 * 1024;
const MAX_SIGNATURE_BYTES = 2 * MAX_ARMORY_MANIFEST_BYTES;

export function decodeArmoryBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("Invalid Armory base64 data");
  }
  const result = Buffer.from(value, "base64");
  if (result.length > maxBytes || result.toString("base64") !== value) throw new Error("Invalid Armory base64 data");
  return result;
}

export function normalizeArmoryPublicKey(text: string): string {
  const lines = text.replace(/\r\n/gu, "\n").trim().split("\n");
  const value = lines.length === 1 ? lines[0] :
    lines.length === 2 && lines[0]?.startsWith("untrusted comment: ") ? lines[1] : undefined;
  const bytes = decodeArmoryBase64(value, 42);
  if (bytes.length !== 42 || bytes.subarray(0, 2).toString("ascii") !== "Ed") throw new Error("Invalid Armory Minisign public key");
  return bytes.toString("base64");
}

/** Authenticates Minisign's trusted comment even before its archive is downloaded. */
export function verifyArmorySignatureMetadata(signature: Uint8Array, publicKey: string): {
  trustedComment: string;
  verifyPayload: (payload: Uint8Array) => void;
} {
  if (!signature.length || signature.length > MAX_SIGNATURE_BYTES) throw new Error("Invalid Armory Minisign signature size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(signature).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
  if (text.includes("\r") || text.includes("\0")) throw new Error("Invalid Armory Minisign signature");
  const lines = text.split("\n");
  if (lines.length !== 4 || !lines[0]?.startsWith("untrusted comment: ") || !lines[2]?.startsWith("trusted comment: ")) {
    throw new Error("Invalid Armory Minisign signature");
  }
  const keyBytes = decodeArmoryBase64(normalizeArmoryPublicKey(publicKey), 42);
  const sigBytes = decodeArmoryBase64(lines[1], 74);
  const commentSignature = decodeArmoryBase64(lines[3], 64);
  if (sigBytes.length !== 74 || commentSignature.length !== 64) throw new Error("Invalid Armory Minisign signature");
  const algorithm = sigBytes.subarray(0, 2).toString("ascii");
  if (algorithm !== "Ed" && algorithm !== "ED") throw new Error("Unsupported Armory Minisign algorithm");
  if (!timingSafeEqual(keyBytes.subarray(2, 10), sigBytes.subarray(2, 10))) throw new Error("Armory signature uses an untrusted key");
  const key = createPublicKey({ key: Buffer.concat([KEY_PREFIX, keyBytes.subarray(10)]), format: "der", type: "spki" });
  const trustedComment = lines[2].slice("trusted comment: ".length);
  const messageSignature = sigBytes.subarray(10);
  if (!verify(null, Buffer.concat([messageSignature, Buffer.from(trustedComment, "utf8")]), key, commentSignature)) {
    throw new Error("Armory trusted manifest signature is invalid");
  }
  return {
    trustedComment,
    verifyPayload(payload) {
      const message = algorithm === "ED" ? blake2b(payload, { dkLen: 64 }) : payload;
      if (!verify(null, message, key, messageSignature)) throw new Error("Armory package signature is invalid");
    },
  };
}

export function verifyArmoryMinisign(payload: Uint8Array, signature: Uint8Array, publicKey: string): string {
  const parsed = verifyArmorySignatureMetadata(signature, publicKey);
  parsed.verifyPayload(payload);
  return parsed.trustedComment;
}
