import { afterEach, beforeEach, describe, expect, it, vi, type Mock, type MockInstance } from "vitest";
import { RDP_PREVIEW_MAX_DATA_URL_LENGTH } from "../../../../shared/rdp-contracts";
import { RdpPreview } from "./rdp-preview";

const images = new WeakMap<HTMLCanvasElement, string>();
let draw: Mock<(source: HTMLCanvasElement, ...bounds: number[]) => void>;
let encode: MockInstance<HTMLCanvasElement["toDataURL"]>;

function desktop(value: string, width = 800, height = 600): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  images.set(canvas, value);
  return canvas;
}

beforeEach(() => {
  vi.useFakeTimers();
  draw = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (this: HTMLCanvasElement) {
    return {
      drawImage: (source: HTMLCanvasElement, ...bounds: number[]) => {
        draw(source, ...bounds);
        images.set(this, images.get(source)!);
      },
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
    return `data:image/jpeg;base64,${btoa(images.get(this)!)}`;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("saved desktop previews", () => {
  it("does not write a blank preview when the connection never finishes a frame", () => {
    const save = vi.fn(async () => undefined);
    const preview = new RdpPreview(save);
    preview.stop();
    expect(save).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it.each([
    [1920, 1080, 480, 270],
    [1024, 1280, 240, 300],
    [200, 100, 200, 100],
  ])("fits a %sx%s desktop into %sx%s without changing its aspect ratio", (width, height, expectedWidth, expectedHeight) => {
    const source = desktop("first", width, height);
    const save = vi.fn(async () => undefined);
    const preview = new RdpPreview(save);
    preview.completedFrame(source);
    expect(draw).toHaveBeenCalledWith(source, 0, 0, expectedWidth, expectedHeight);
    expect(encode).toHaveBeenCalledWith("image/jpeg", 0.72);
    expect(save).toHaveBeenCalledWith(`data:image/jpeg;base64,${btoa("first")}`);
    preview.stop();
  });

  it("saves the first frame, coalesces later frames every 15 seconds, and stops writing when unchanged", async () => {
    const source = desktop("first");
    const save = vi.fn(async () => undefined);
    const preview = new RdpPreview(save);
    preview.completedFrame(source);
    await vi.advanceTimersByTimeAsync(1_000);
    images.set(source, "second");
    preview.completedFrame(source);
    await vi.advanceTimersByTimeAsync(1_000);
    images.set(source, "latest");
    preview.completedFrame(source);
    await vi.advanceTimersByTimeAsync(12_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls).toEqual([
      [`data:image/jpeg;base64,${btoa("first")}`],
      [`data:image/jpeg;base64,${btoa("latest")}`],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    preview.stop();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("flushes the last completed frame on stop even when the desktop contains a newer partial frame", async () => {
    const source = desktop("first");
    const save = vi.fn(async () => undefined);
    const preview = new RdpPreview(save);
    preview.completedFrame(source);
    await vi.advanceTimersByTimeAsync(1_000);
    images.set(source, "complete second frame");
    preview.completedFrame(source);
    images.set(source, "unfinished next frame");
    preview.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenLastCalledWith(`data:image/jpeg;base64,${btoa("complete second frame")}`);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("keeps only one save in flight and flushes the latest frame when that save finishes after stop", async () => {
    let finish!: () => void;
    const save = vi.fn((_dataUrl: string) => new Promise<void>((resolve) => { finish = resolve; }));
    const source = desktop("first");
    const preview = new RdpPreview(save);
    preview.completedFrame(source);
    for (let count = 0; count < 40; count++) {
      images.set(source, `frame ${count}`);
      preview.completedFrame(source);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    preview.stop();
    expect(save).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(`data:image/jpeg;base64,${btoa("frame 39")}`);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("awaits both the in-flight save and the latest frame before allowing an explicit close", async () => {
    const finishes: (() => void)[] = [];
    const save = vi.fn((_dataUrl: string) => new Promise<void>((resolve) => { finishes.push(resolve); }));
    const source = desktop("first");
    const preview = new RdpPreview(save);
    preview.completedFrame(source);
    images.set(source, "final");
    preview.completedFrame(source);
    const closed = vi.fn();
    const flushing = preview.flush().then(closed);
    finishes[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    expect(closed).not.toHaveBeenCalled();
    finishes[1]!();
    await flushing;
    expect(closed).toHaveBeenCalledOnce();
    preview.stop();
  });

  it("does not block closing indefinitely when the persistence bridge stops responding", async () => {
    const save = vi.fn((_dataUrl: string) => new Promise<void>(() => undefined));
    const preview = new RdpPreview(save);
    preview.completedFrame(desktop("first"));
    const closed = vi.fn();
    void preview.flush().then(closed);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toHaveBeenCalledOnce();
    preview.stop();
  });

  it("lowers JPEG quality to keep the payload bounded and skips images that remain too large", () => {
    const save = vi.fn(async () => undefined);
    const preview = new RdpPreview(save);
    const oversized = `data:image/jpeg;base64,${"a".repeat(RDP_PREVIEW_MAX_DATA_URL_LENGTH)}`;
    encode.mockReturnValueOnce(oversized).mockReturnValueOnce("data:image/jpeg;base64,c21hbGw=");
    preview.completedFrame(desktop("first"));
    expect(encode.mock.calls).toEqual([["image/jpeg", 0.72], ["image/jpeg", 0.5]]);
    expect(save).toHaveBeenCalledWith("data:image/jpeg;base64,c21hbGw=");
    preview.stop();
    encode.mockReturnValue(oversized);
    const secondPreview = new RdpPreview(save);
    secondPreview.completedFrame(desktop("second"));
    secondPreview.stop();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("contains canvas and persistence failures and allows a later frame to save", async () => {
    const save = vi.fn(async (_dataUrl: string) => { throw new Error("Unavailable"); });
    const preview = new RdpPreview(save);
    const source = desktop("first");
    expect(() => preview.completedFrame(source)).not.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    encode.mockImplementationOnce(() => { throw new Error("Canvas unavailable"); });
    expect(() => preview.completedFrame(source)).not.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    preview.completedFrame(source);
    expect(save).toHaveBeenCalledTimes(2);
    preview.stop();
    await vi.advanceTimersByTimeAsync(0);
  });
});
