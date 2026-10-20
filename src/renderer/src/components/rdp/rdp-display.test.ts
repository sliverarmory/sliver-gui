import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpFrame } from "../../../../shared/rdp-contracts";
import { RdpDisplay, validateRdpFrame } from "./rdp-display";

function tile(overrides: Partial<RdpFrame> = {}): RdpFrame {
  return { type: "frame", seq: 1, frameId: 1, geometry: 1, width: 2, height: 2, x: 0, y: 0,
    tileWidth: 2, tileHeight: 1, first: true, full: true, last: false, data: Uint8Array.from([255, 0, 0, 255, 0, 255, 0, 255]).buffer, ...overrides };
}

const pixels = new WeakMap<HTMLCanvasElement, Uint8ClampedArray>();
function storage(canvas: HTMLCanvasElement): Uint8ClampedArray {
  let value = pixels.get(canvas);
  if (!value || value.length !== canvas.width * canvas.height * 4) { value = new Uint8ClampedArray(canvas.width * canvas.height * 4); pixels.set(canvas, value); }
  return value;
}

beforeEach(() => {
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      putImageData: (image: ImageData, x: number, y: number) => {
        for (let row = 0; row < image.height; row++) storage(this).set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), ((y + row) * this.width + x) * 4);
      },
      drawImage: (source: HTMLCanvasElement) => { storage(this).set(storage(source)); },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("RDP display snapshots", () => {
  it("keeps a partial full snapshot invisible and commits exact pixels on the final tile", () => {
    const canvas = document.createElement("canvas"); canvas.width = 2; canvas.height = 2;
    const display = new RdpDisplay(canvas);
    expect(display.apply(tile())).toBe(false);
    expect([...storage(canvas)]).toEqual(Array(16).fill(0));
    expect(display.apply(tile({ seq: 2, first: false, last: true, y: 1, data: Uint8Array.from([0, 0, 255, 255, 255, 255, 255, 255]).buffer }))).toBe(true);
    expect([...storage(canvas)]).toEqual([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    display.apply(tile({ seq: 3, frameId: 2, full: false, first: true, last: true, x: 1, y: 1, tileWidth: 1, data: Uint8Array.from([20, 30, 40, 255]).buffer }));
    expect([...storage(canvas).slice(12)]).toEqual([20, 30, 40, 255]);
  });

  it("rejects malformed allocations and mismatched geometry before pixel conversion", () => {
    expect(() => validateRdpFrame(tile({ width: 8193 }))).toThrow();
    expect(() => validateRdpFrame(tile({ width: 8192, height: 8192 }))).toThrow();
    expect(() => validateRdpFrame(tile({ x: 1 }))).toThrow();
    expect(() => validateRdpFrame(tile({ data: new ArrayBuffer(3) }))).toThrow();
    expect(() => validateRdpFrame(tile({ seq: NaN }))).toThrow();
    const display = new RdpDisplay(document.createElement("canvas"));
    display.apply(tile());
    expect(() => display.apply(tile({ seq: 2, first: false, last: true, geometry: 2 }))).toThrow();
  });

  it("replaces an incomplete snapshot with a new full snapshot and rejects out-of-order delivery", () => {
    const canvas = document.createElement("canvas");
    const display = new RdpDisplay(canvas);
    display.apply(tile());
    display.apply(tile({ seq: 2, frameId: 2, geometry: 2, width: 1, height: 1, tileWidth: 1, last: true, data: Uint8Array.from([12, 34, 56, 255]).buffer }));
    expect(canvas.width).toBe(1);
    expect([...storage(canvas)]).toEqual([12, 34, 56, 255]);
    expect(() => display.apply(tile({ seq: 4 }))).toThrow("sequence");
  });
});
