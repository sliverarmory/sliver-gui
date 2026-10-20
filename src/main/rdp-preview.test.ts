// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RDP_PREVIEW_MAX_DATA_URL_LENGTH } from "../shared/rdp-contracts.js";
import { parseRdpPreview, parseRdpSavePreview } from "../shared/rdp-validation.js";
import { RDP_PREVIEW_FIXTURE } from "../tests/rdp-preview-fixture.js";
import { normalizeRdpPreview } from "./rdp-preview.js";

const mocks = vi.hoisted(() => ({ createFromDataURL: vi.fn(), getSize: vi.fn(), isEmpty: vi.fn(), toJPEG: vi.fn() }));
vi.mock("electron", () => ({ nativeImage: { createFromDataURL: mocks.createFromDataURL } }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createFromDataURL.mockReturnValue(mocks);
  mocks.getSize.mockReturnValue({ width: 1, height: 1 });
  mocks.isEmpty.mockReturnValue(false);
  mocks.toJPEG.mockImplementation(() => Buffer.from(RDP_PREVIEW_FIXTURE.dataUrl.split(",")[1]!, "base64"));
});

describe("RDP raster preview boundary", () => {
  it("decodes bounded JPEG pixels and persists only a fresh native encoding and main timestamp", () => {
    const normalized = normalizeRdpPreview(RDP_PREVIEW_FIXTURE.dataUrl);
    expect(normalized).toMatchObject({ dataUrl: RDP_PREVIEW_FIXTURE.dataUrl, width: 1, height: 1 });
    expect(Date.now() - Date.parse(normalized.capturedAt)).toBeLessThan(1000);
    expect(mocks.createFromDataURL).toHaveBeenCalledExactlyOnceWith(RDP_PREVIEW_FIXTURE.dataUrl);
    expect(mocks.toJPEG).toHaveBeenCalledExactlyOnceWith(75);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("rejects unsafe media, malformed encoding, oversized data, and oversized JPEG dimensions before decoding", () => {
    const bytes = Buffer.from(RDP_PREVIEW_FIXTURE.dataUrl.split(",")[1]!, "base64");
    const marker = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    expect(marker).toBeGreaterThan(0);
    bytes.writeUInt16BE(481, marker + 7);
    const oversizedDimensions = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    for (const input of ["data:image/svg+xml;base64,PHN2Zz4=", "https://example.test/image.jpg", "data:image/jpeg;base64,!!!!",
      `${RDP_PREVIEW_FIXTURE.dataUrl}junk`, "data:image/jpeg;base64," + "A".repeat(RDP_PREVIEW_MAX_DATA_URL_LENGTH), oversizedDimensions]) {
      expect(() => normalizeRdpPreview(input)).toThrow();
    }
    expect(mocks.createFromDataURL).not.toHaveBeenCalled();
  });

  it("rejects malformed native images and dimension mismatches", () => {
    mocks.isEmpty.mockReturnValueOnce(true);
    expect(() => normalizeRdpPreview(RDP_PREVIEW_FIXTURE.dataUrl)).toThrow("Invalid RDP preview");
    mocks.getSize.mockReturnValueOnce({ width: 9999, height: 9999 });
    expect(() => normalizeRdpPreview(RDP_PREVIEW_FIXTURE.dataUrl)).toThrow("Invalid RDP preview");
    expect(mocks.toJPEG).not.toHaveBeenCalled();
  });

  it("validates saved metadata and permits only attempt-bound preview upload fields", () => {
    expect(parseRdpPreview(RDP_PREVIEW_FIXTURE)).toEqual(RDP_PREVIEW_FIXTURE);
    for (const invalid of [{ ...RDP_PREVIEW_FIXTURE, width: 100 }, { ...RDP_PREVIEW_FIXTURE, capturedAt: "yesterday" }, { ...RDP_PREVIEW_FIXTURE, path: "/private/file" }]) {
      expect(() => parseRdpPreview(invalid)).toThrow();
    }
    const input = { tabId: "tab", attempt: 1, dataUrl: RDP_PREVIEW_FIXTURE.dataUrl };
    expect(parseRdpSavePreview(input)).toEqual(input);
    for (const invalid of [{ ...input, attempt: 0 }, { ...input, attempt: 1.5 }, { ...input, profileId: "unrelated" }]) {
      expect(() => parseRdpSavePreview(invalid)).toThrow();
    }
  });
});
