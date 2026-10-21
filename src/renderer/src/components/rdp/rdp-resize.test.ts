import { describe, expect, it } from "vitest";
import { rdpWindowResize } from "./rdp-resize";

describe("RDP window resize geometry", () => {
  it("uses logical dimensions and 100% scale while high DPI is disabled", () => {
    expect(rdpWindowResize({ width: 1280, height: 800 }, false, 2)).toEqual({ width: 1280, height: 800, scaleFactor: 100 });
  });

  it.each([1, 1.25, 1.5, 2, 3])("matches physical pixels and desktop scale at %s DPR", (density) => {
    expect(rdpWindowResize({ width: 1280, height: 800 }, true, density)).toEqual({ width: 1280 * density, height: 800 * density, scaleFactor: 100 * density });
  });

  it("fits a high-DPI desktop into the native 16M pixel budget and adjusts desktop scale", () => {
    expect(rdpWindowResize({ width: 3000, height: 3000 }, true, 2)).toEqual({ width: 4000, height: 4000, scaleFactor: 133 });
    const fitted = rdpWindowResize({ width: 3000, height: 2000 }, true, 2)!;
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(16_000_000);
    expect(fitted.width / fitted.height).toBeCloseTo(1.5, 2);
    expect(fitted.scaleFactor).toBe(163);
  });

  it("fits long desktops to the edge limit and sends an even native width", () => {
    expect(rdpWindowResize({ width: 5000, height: 500 }, true, 2)).toEqual({ width: 8192, height: 819, scaleFactor: 164 });
    expect(rdpWindowResize({ width: 1281, height: 801 }, false, 2)).toEqual({ width: 1280, height: 801, scaleFactor: 100 });
  });

  it("ignores hidden or invalid viewports and safely normalizes unavailable density", () => {
    expect(rdpWindowResize({ width: 0, height: 800 }, true, 2)).toBeUndefined();
    expect(rdpWindowResize({ width: 1280, height: NaN }, true, 2)).toBeUndefined();
    expect(rdpWindowResize({ width: 1280, height: 800 }, true, NaN)).toEqual({ width: 1280, height: 800, scaleFactor: 100 });
  });
});
