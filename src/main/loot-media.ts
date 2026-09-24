import type { LootMediaMimeType } from "../shared/operator-data-contracts.js";

/** Recognize a small set of browser-renderable formats from bytes, never filenames. */
export function sniffLootMediaMimeType(data: Uint8Array): LootMediaMimeType | undefined {
  if (hasBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytes(data, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasAscii(data, 0, "GIF87a") || hasAscii(data, 0, "GIF89a")) return "image/gif";
  if (hasAscii(data, 0, "RIFF") && hasAscii(data, 8, "WEBP")) return "image/webp";
  if (isMp4(data)) return "video/mp4";
  if (isWebM(data)) return "video/webm";
  return undefined;
}

function hasBytes(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  return data.byteLength >= offset + bytes.length && bytes.every((byte, index) => data[offset + index] === byte);
}

function hasAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (data.byteLength < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function isMp4(data: Uint8Array): boolean {
  if (data.byteLength < 16 || !hasAscii(data, 4, "ftyp")) return false;
  const boxSize = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
  if (boxSize < 16 || boxSize > data.byteLength) return false;
  // Restrict to video-oriented brands. In particular, AVIF and HEIF also use
  // an ftyp box but should not be handed to a video element as MP4.
  const brands = ["isom", "iso2", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "3gp4", "3gp5", "3g2a", "MSNV"];
  return brands.some((brand) => hasAscii(data, 8, brand));
}

function isWebM(data: Uint8Array): boolean {
  if (!hasBytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  // The EBML DocType element is 0x4282, followed by a one-byte VINT length
  // of four and the literal "webm". Matroska uses the same file signature.
  const doctype = [0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d];
  for (let offset = 4; offset <= Math.min(data.byteLength - doctype.length, 256); offset += 1) {
    if (hasBytes(data, offset, doctype)) return true;
  }
  return false;
}
