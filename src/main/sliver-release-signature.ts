import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

// This is Sliver's release-signing key. Keep it in sync with
// scripts/buildSliverConsole.mjs, which embeds the same trust root in the
// bundled console update command.
export const SLIVER_RELEASE_MINISIGN_PUBLIC_KEY =
  "RWTZPg959v3b7tLG7VzKHRB1/QT+d3c71Uzetfa44qAoX5rH7mGoQTTR";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const MINISIGN_PUBLIC_KEY_BYTES = 2 + 8 + ED25519_PUBLIC_KEY_BYTES;
const MINISIGN_SIGNATURE_BYTES = 2 + 8 + ED25519_SIGNATURE_BYTES;
const EDDSA_ALGORITHM = Buffer.from([0x45, 0x64]); // little-endian 0x6445 ("Ed")
const HASH_EDDSA_ALGORITHM = Buffer.from([0x45, 0x44]); // little-endian 0x4445 ("ED")
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNTRUSTED_COMMENT_PREFIX = "untrusted comment: ";
const TRUSTED_COMMENT_PREFIX = "trusted comment: ";
const MAX_SIGNATURE_TEXT_BYTES = 16 * 1024;
const MAX_COMMENT_CHARACTERS = 8 * 1024;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

interface ParsedPublicKey {
  readonly keyId: Buffer;
  readonly key: KeyObject;
}

interface ParsedSignature {
  readonly keyId: Buffer;
  readonly messageSignature: Buffer;
  readonly trustedComment: string;
  readonly commentSignature: Buffer;
}

/**
 * Verify an official Sliver release artifact using Minisign's streaming
 * Blake2b-512/Ed25519 format. The signed trusted comment is also bound to the
 * exact GitHub asset filename so a valid signature cannot be replayed for a
 * different release asset.
 */
export async function verifySliverReleaseMinisign(
  artifactPath: string,
  signatureText: Uint8Array,
  expectedFileName: string,
  publicKeyText = SLIVER_RELEASE_MINISIGN_PUBLIC_KEY,
): Promise<void> {
  if (basename(expectedFileName) !== expectedFileName || expectedFileName.length < 1) {
    throw new SliverReleaseSignatureError("The expected release filename is invalid");
  }

  const publicKey = parsePublicKey(publicKeyText);
  const signature = parseSignature(signatureText);
  if (!timingSafeEqual(publicKey.keyId, signature.keyId)) {
    throw new SliverReleaseSignatureError("The release signature uses an untrusted key");
  }

  const digest = await hashFileBlake2b512(artifactPath);
  if (!verify(null, digest, publicKey.key, signature.messageSignature)) {
    throw new SliverReleaseSignatureError("The Sliver release signature is invalid");
  }

  const signedComment = Buffer.concat([
    signature.messageSignature,
    Buffer.from(signature.trustedComment, "utf8"),
  ]);
  if (!verify(null, signedComment, publicKey.key, signature.commentSignature)) {
    throw new SliverReleaseSignatureError("The Sliver release trusted comment is invalid");
  }

  const fileFields = signature.trustedComment
    .split(/\s+/u)
    .filter((field) => field.startsWith("file:"))
    .map((field) => field.slice("file:".length));
  if (fileFields.length !== 1 || fileFields[0] !== expectedFileName) {
    throw new SliverReleaseSignatureError("The release signature does not match the selected asset");
  }
}

function parsePublicKey(text: string): ParsedPublicKey {
  const normalized = normalizePublicKey(text);
  const raw = decodeCanonicalBase64(normalized, MINISIGN_PUBLIC_KEY_BYTES, "public key");
  if (!timingSafeEqual(raw.subarray(0, 2), EDDSA_ALGORITHM)) {
    throw new SliverReleaseSignatureError("The Sliver release public key is invalid");
  }
  const rawPublicKey = raw.subarray(10);
  let key: KeyObject;
  try {
    key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
  } catch {
    throw new SliverReleaseSignatureError("The Sliver release public key is invalid");
  }
  return { keyId: Buffer.from(raw.subarray(2, 10)), key };
}

function parseSignature(bytes: Uint8Array): ParsedSignature {
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_SIGNATURE_TEXT_BYTES) {
    throw new SliverReleaseSignatureError("The Sliver release signature is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SliverReleaseSignatureError("The Sliver release signature is invalid");
  }
  text = text.replace(/\r\n/gu, "\n");
  if (text.includes("\r") || text.includes("\0")) {
    throw new SliverReleaseSignatureError("The Sliver release signature is invalid");
  }
  if (text.endsWith("\n")) text = text.slice(0, -1);
  const lines = text.split("\n");
  const untrustedComment = lines[0];
  const encodedSignature = lines[1];
  const trustedCommentLine = lines[2];
  const encodedCommentSignature = lines[3];
  if (
    lines.length !== 4 ||
    untrustedComment === undefined ||
    !untrustedComment.startsWith(UNTRUSTED_COMMENT_PREFIX) ||
    encodedSignature === undefined ||
    trustedCommentLine === undefined ||
    !trustedCommentLine.startsWith(TRUSTED_COMMENT_PREFIX) ||
    encodedCommentSignature === undefined ||
    trustedCommentLine.length > MAX_COMMENT_CHARACTERS
  ) {
    throw new SliverReleaseSignatureError("The Sliver release signature is invalid");
  }

  const rawSignature = decodeCanonicalBase64(
    encodedSignature,
    MINISIGN_SIGNATURE_BYTES,
    "signature",
  );
  // Cloud staging only accepts Minisign's streaming format. This keeps the
  // verifier bounded even for the maximum-size Sliver release artifact.
  if (!timingSafeEqual(rawSignature.subarray(0, 2), HASH_EDDSA_ALGORITHM)) {
    throw new SliverReleaseSignatureError("The Sliver release signature algorithm is unsupported");
  }
  const commentSignature = decodeCanonicalBase64(
    encodedCommentSignature,
    ED25519_SIGNATURE_BYTES,
    "comment signature",
  );
  return {
    keyId: Buffer.from(rawSignature.subarray(2, 10)),
    messageSignature: Buffer.from(rawSignature.subarray(10)),
    trustedComment: trustedCommentLine.slice(TRUSTED_COMMENT_PREFIX.length),
    commentSignature,
  };
}

function normalizePublicKey(text: string): string {
  const normalized = text.replace(/\r\n/gu, "\n").trimEnd();
  if (normalized.includes("\r") || normalized.includes("\0")) {
    throw new SliverReleaseSignatureError("The Sliver release public key is invalid");
  }
  const lines = normalized.split("\n");
  if (lines.length === 1) return lines[0] ?? "";
  if (lines.length === 2 && lines[0]?.startsWith(UNTRUSTED_COMMENT_PREFIX)) {
    return lines[1] ?? "";
  }
  throw new SliverReleaseSignatureError("The Sliver release public key is invalid");
}

function decodeCanonicalBase64(value: string, expectedBytes: number, label: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new SliverReleaseSignatureError(`The Sliver release ${label} is invalid`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== expectedBytes || decoded.toString("base64") !== value) {
    throw new SliverReleaseSignatureError(`The Sliver release ${label} is invalid`);
  }
  return decoded;
}

async function hashFileBlake2b512(path: string): Promise<Buffer> {
  const hash = createHash("blake2b512");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest();
  } catch {
    throw new SliverReleaseSignatureError("The staged Sliver release could not be verified");
  }
}

export class SliverReleaseSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SliverReleaseSignatureError";
  }
}
