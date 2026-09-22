// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createApplicationZoomAPI } from "./application-zoom.js";

function fixture(initialFactor = 1) {
  let factor = initialFactor;
  const frame = {
    getZoomFactor: vi.fn(() => factor),
    setZoomFactor: vi.fn((value: number) => { factor = value; }),
  };
  const target = new EventTarget();
  const api = createApplicationZoomAPI(frame, target);
  return {
    api,
    frame,
    resize: () => target.dispatchEvent(new Event("resize")),
    changeFactor: (value: number) => { factor = value; },
  };
}

describe("application zoom preload API", () => {
  it("reads native zoom and resets only to 100 percent", () => {
    const { api, frame, changeFactor } = fixture(0.9);
    expect(api.getFactor()).toBe(0.9);
    changeFactor(1.5);
    expect(api.getFactor()).toBe(1.5);
    (api.reset as (ignored: number) => void)(2);
    expect(frame.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1);
    expect(api.getFactor()).toBe(1);
    expect(Object.isFrozen(api)).toBe(true);
  });

  it("reports only zoom changes on resize and releases each subscription independently", () => {
    const { api, resize, changeFactor } = fixture(0.9);
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = api.onChanged(first);
    const stopSecond = api.onChanged(second);
    expect(first).not.toHaveBeenCalled();
    resize();
    expect(first).not.toHaveBeenCalled();
    changeFactor(1.1);
    resize();
    resize();
    expect(first).toHaveBeenCalledExactlyOnceWith(1.1);
    expect(second).toHaveBeenCalledExactlyOnceWith(1.1);
    stopFirst();
    stopFirst();
    api.reset();
    resize();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second.mock.calls).toEqual([[1.1], [1]]);
    stopSecond();
    changeFactor(0.8);
    resize();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid change listeners at the bridge boundary", () => {
    const { api } = fixture();
    expect(() => api.onChanged(null as unknown as (factor: number) => void)).toThrow(
      /zoom listener must be a function/u,
    );
  });
});
