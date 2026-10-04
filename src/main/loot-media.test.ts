import { describe, expect, it } from "vitest";

import { sniffLootMediaMimeType } from "./loot-media.js";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const ascii = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("loot media signatures", () => {
  it("recognizes supported raster image formats from bytes", () => {
    expect(sniffLootMediaMimeType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)))
      .toBe("image/png");
    expect(sniffLootMediaMimeType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffLootMediaMimeType(ascii("GIF87a"))).toBe("image/gif");
    expect(sniffLootMediaMimeType(ascii("GIF89a"))).toBe("image/gif");
    expect(sniffLootMediaMimeType(ascii("RIFF0000WEBP"))).toBe("image/webp");
  });

  it("recognizes MP4 and WebM without mistaking other ISO BMFF or EBML files for video", () => {
    expect(sniffLootMediaMimeType(bytes(0, 0, 0, 16, ...ascii("ftypmp42"), 0, 0, 0, 0)))
      .toBe("video/mp4");
    expect(sniffLootMediaMimeType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x84, ...ascii("webm"))))
      .toBe("video/webm");
    expect(sniffLootMediaMimeType(bytes(0, 0, 0, 16, ...ascii("ftypavif"), 0, 0, 0, 0)))
      .toBeUndefined();
    expect(sniffLootMediaMimeType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88, ...ascii("matroska"))))
      .toBeUndefined();
  });

  it("rejects short, unknown, and active SVG content", () => {
    expect(sniffLootMediaMimeType(bytes(0x89, 0x50, 0x4e))).toBeUndefined();
    expect(sniffLootMediaMimeType(ascii("<svg onload=\"alert(1)\"></svg>"))).toBeUndefined();
    expect(sniffLootMediaMimeType(ascii("not actually an image"))).toBeUndefined();
  });
});
