import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RdpHostMessage, RdpTab, RdpWindowAPI } from "../../../../shared/rdp-contracts";
import type { OperationResult } from "../../../../shared/contracts";
import { RdpDesktop, type RdpDesktopHandle } from "./RdpDesktop";

const mocks = vi.hoisted(() => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }));
vi.mock("./rdp-transport", () => ({ RdpTransport: { open: mocks.open }, isRdpReady: (message: RdpHostMessage) => message.type === "ready" && message.protocol === 1 }));
const tab: RdpTab = { id: "tab", label: "Office", attempt: 1, host: "office.test", port: 3389, domain: "", username: "operator", width: 800, height: 600,
  clipboard: false, clipboardReady: false, clipboardAvailable: false, scaleMode: "fit", state: "active" };
let message: (value: RdpHostMessage) => void;
let api: RdpWindowAPI;
let viewport: { width: number; height: number };
let resizeObservers: { notify(): void; disconnect: ReturnType<typeof vi.fn> }[];

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  mocks.send.mockReset(); mocks.close.mockReset(); mocks.open.mockReset();
  mocks.open.mockImplementation(async (_api, _tabId, _attempt, _signal, onMessage) => { message = onMessage; return { send: mocks.send, close: mocks.close }; });
  api = { setInputCapture: vi.fn(async () => ({ ok: true })), savePreview: vi.fn(async () => ({ ok: true })), reconnect: vi.fn(), disconnect: vi.fn() } as unknown as RdpWindowAPI;
  viewport = { width: 1280, height: 800 };
  resizeObservers = [];
  vi.stubGlobal("ResizeObserver", class {
    readonly disconnect = vi.fn();
    constructor(callback: ResizeObserverCallback) { resizeObservers.push({ notify: () => callback([], this), disconnect: this.disconnect }); }
    observe(): void {}
    unobserve(): void {}
  });
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const dimensions = this instanceof HTMLCanvasElement ? { width: 800, height: 600 } : viewport;
    return { x: 0, y: 0, top: 0, left: 0, right: dimensions.width, bottom: dimensions.height, ...dimensions, toJSON: () => ({}) };
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(Element.prototype, "getAnimations"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(autoResize = false, connection = tab): Promise<ReturnType<typeof render> & { handle: React.RefObject<RdpDesktopHandle | null> }> {
  const handle = createRef<RdpDesktopHandle>();
  const result = render(<RdpDesktop ref={handle} api={api} tab={connection} active inputEnabled scaleMode="fit" autoResize={autoResize} />);
  await act(async () => {});
  act(() => message({ type: "ready", protocol: 1 }));
  return { ...result, handle };
}

describe("remote desktop viewer lifecycle", () => {
  it("coalesces automatic resize notifications and does not repeat a size across server reactivation", async () => {
    vi.useFakeTimers();
    const view = await mount(true);
    const observer = resizeObservers.at(-1)!;
    const requests = (): unknown[] => mocks.send.mock.calls.map(([value]) => value).filter((value) => value.type === "resize");
    act(() => { observer.notify(); observer.notify(); vi.advanceTimersByTime(350); });
    expect(requests()).toEqual([{ type: "resize", width: 1280, height: 800, scaleFactor: 100 }]);
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={{ ...tab, state: "authenticating" }} active inputEnabled scaleMode="fit" autoResize />);
    act(() => { observer.notify(); vi.advanceTimersByTime(350); });
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={tab} active inputEnabled scaleMode="fit" autoResize />);
    act(() => { observer.notify(); vi.advanceTimersByTime(350); });
    expect(resizeObservers).toHaveLength(1);
    expect(requests()).toHaveLength(1);
    viewport = { width: 1440, height: 900 };
    act(() => { observer.notify(); vi.advanceTimersByTime(349); });
    expect(requests()).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(requests()).toHaveLength(2);
    expect(requests().at(-1)).toEqual({ type: "resize", width: 1440, height: 900, scaleFactor: 100 });
  });

  it("applies the latest window size once when the session becomes active again", async () => {
    vi.useFakeTimers();
    const view = await mount(true);
    const observer = resizeObservers.at(-1)!;
    act(() => { vi.advanceTimersByTime(350); });
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={{ ...tab, state: "connecting" }} active inputEnabled scaleMode="fit" autoResize />);
    viewport = { width: 1600, height: 900 };
    act(() => { observer.notify(); vi.advanceTimersByTime(350); });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "resize")).toHaveLength(1);
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={tab} active inputEnabled scaleMode="fit" autoResize />);
    act(() => { vi.advanceTimersByTime(350); });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "resize")).toEqual([
      [{ type: "resize", width: 1280, height: 800, scaleFactor: 100 }],
      [{ type: "resize", width: 1600, height: 900, scaleFactor: 100 }],
    ]);
  });

  it.each(["disabled", "inactive"] as const)("cancels a queued automatic resize when %s", async (reason) => {
    vi.useFakeTimers();
    const view = await mount(true);
    const observer = resizeObservers.at(-1)!;
    act(() => { observer.notify(); vi.advanceTimersByTime(100); });
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={tab} active={reason !== "inactive"} inputEnabled scaleMode="fit" autoResize={reason !== "disabled"} />);
    act(() => { vi.advanceTimersByTime(350); });
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "resize")).toHaveLength(0);
  });

  it("retains resize deduplication after viewer reattachment and permits a changed scale factor", async () => {
    vi.useFakeTimers();
    await mount(true);
    act(() => { vi.advanceTimersByTime(350); });
    act(() => message({ type: "closed", reason: "Window hidden" }));
    fireEvent.click(screen.getByRole("button", { name: "Reattach viewer" }));
    await act(async () => {});
    expect(mocks.open).toHaveBeenCalledTimes(2);
    act(() => message({ type: "ready", protocol: 1 }));
    act(() => { resizeObservers.at(-1)!.notify(); vi.advanceTimersByTime(350); });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "resize")).toHaveLength(1);
    vi.stubGlobal("devicePixelRatio", 2);
    act(() => { resizeObservers.at(-1)!.notify(); vi.advanceTimersByTime(350); });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "resize")).toEqual([
      [{ type: "resize", width: 1280, height: 800, scaleFactor: 100 }],
      [{ type: "resize", width: 1280, height: 800, scaleFactor: 200 }],
    ]);
  });

  it("acknowledges cursors only after drawing and preserves the bitmap across position updates", async () => {
    const view = await mount();
    const context = document.createElement("canvas").getContext("2d")!;
    const draw = vi.mocked(context.drawImage);
    act(() => message({ type: "cursor", kind: "bitmap", seq: 10, width: 2, height: 2, hotspotX: 1, hotspotY: 1, data: new ArrayBuffer(16) }));
    expect(view.container.querySelector(".rdp-screen")).toHaveAttribute("data-cursor", "bitmap");
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "cursorAck", seq: 10 });
    mocks.send.mockImplementation((value) => {
      if (value.type === "cursorAck") expect(draw).toHaveBeenLastCalledWith(expect.any(HTMLCanvasElement), 43, 54);
    });
    act(() => message({ type: "cursor", kind: "position", seq: 11, x: 44, y: 55 }));
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "cursorAck", seq: 11 });
    expect(view.container.querySelector(".rdp-screen")).toHaveAttribute("data-cursor", "bitmap");
  });

  it.each([
    { type: "cursor", kind: "default", seq: 0 },
    { type: "cursor", kind: "default", seq: 1.5 },
    { type: "cursor", kind: "default", seq: Number.MAX_SAFE_INTEGER + 1 },
    { type: "cursor", kind: "default" },
    { type: "cursor", kind: "position", seq: 1, x: -1, y: 20 },
    { type: "cursor", kind: "position", seq: 1, x: 0, y: 8192 },
    { type: "cursor", kind: "bitmap", seq: 1, width: 2, height: 2, hotspotX: 0, hotspotY: 0, data: new ArrayBuffer(4) },
  ])("does not acknowledge an invalid cursor %#", async (cursor) => {
    await mount(); mocks.send.mockClear();
    expect(() => act(() => message(cursor as RdpHostMessage))).toThrow("Invalid remote cursor");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects duplicate or skipped cursor delivery sequences", async () => {
    await mount();
    act(() => message({ type: "cursor", kind: "default", seq: 12 }));
    mocks.send.mockClear();
    for (const seq of [12, 14]) expect(() => act(() => message({ type: "cursor", kind: "hidden", seq }))).toThrow("Invalid remote cursor sequence");
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("acknowledges staged tiles and counts only complete desktop snapshots", async () => {
    const view = await mount();
    expect(mocks.send).toHaveBeenCalledWith({ type: "snapshot" });
    const frame = { type: "frame" as const, seq: 1, frameId: 1, geometry: 1, width: 2, height: 2, tileWidth: 2, tileHeight: 1, x: 0, y: 0,
      full: true, first: true, last: false, data: new Uint8Array(8).buffer };
    act(() => message(frame));
    expect(mocks.send).toHaveBeenCalledWith({ type: "ack", seq: 1 });
    expect(view.container.querySelector("[data-frame-count]" )).toHaveAttribute("data-frame-count", "0");
    act(() => message({ ...frame, seq: 2, first: false, last: true, y: 1 }));
    expect(mocks.send).toHaveBeenCalledWith({ type: "ack", seq: 2 });
    expect(view.container.querySelector("[data-frame-count]" )).toHaveAttribute("data-frame-count", "1");
    expect(screen.getByLabelText("Remote desktop for Office")).toHaveAttribute("width", "2");
    expect(api.savePreview).not.toHaveBeenCalled();
  });

  it("saves a profile preview only after the final tile is painted and acknowledged", async () => {
    const dataUrl = "data:image/jpeg;base64,cHJldmlldw==";
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      expect(mocks.send).toHaveBeenLastCalledWith({ type: "ack", seq: 2 });
      return dataUrl;
    });
    const view = await mount(false, { ...tab, profileId: "office" });
    const frame = { type: "frame" as const, seq: 1, frameId: 1, geometry: 1, width: 2, height: 2, tileWidth: 2, tileHeight: 1, x: 0, y: 0,
      full: true, first: true, last: false, data: new Uint8Array(8).buffer };
    act(() => message(frame));
    expect(encode).not.toHaveBeenCalled();
    expect(api.savePreview).not.toHaveBeenCalled();
    act(() => message({ ...frame, seq: 2, first: false, last: true, y: 1 }));
    expect(api.savePreview).toHaveBeenCalledExactlyOnceWith({ tabId: tab.id, attempt: tab.attempt, dataUrl });
    view.unmount();
    await act(async () => {});
    expect(api.savePreview).toHaveBeenCalledTimes(1);
  });

  it("shares pending preview saves across viewer reattachment so an older frame cannot overwrite the latest", async () => {
    const finishes: ((result: OperationResult) => void)[] = [];
    vi.mocked(api.savePreview).mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(function (this: HTMLCanvasElement) {
      return `data:image/jpeg;base64,${btoa(`${this.width}x${this.height}`)}`;
    });
    const view = await mount(false, { ...tab, profileId: "office" });
    const frame = { type: "frame" as const, seq: 1, frameId: 1, geometry: 1, width: 2, height: 2, tileWidth: 2, tileHeight: 2, x: 0, y: 0,
      full: true, first: true, last: true, data: new Uint8Array(16).buffer };
    act(() => message(frame));
    act(() => message({ ...frame, seq: 2, frameId: 2, geometry: 2, width: 3, tileWidth: 3, data: new Uint8Array(24).buffer }));
    act(() => message({ type: "closed", reason: "Window hidden" }));
    fireEvent.click(screen.getByRole("button", { name: "Reattach viewer" }));
    await act(async () => {});
    expect(mocks.open).toHaveBeenCalledTimes(2);
    act(() => message({ type: "ready", protocol: 1 }));
    act(() => message({ ...frame, seq: 3, frameId: 3, geometry: 3, width: 4, tileWidth: 4, data: new Uint8Array(32).buffer }));
    expect(api.savePreview).toHaveBeenCalledTimes(1);
    await act(async () => { finishes[0]!({ ok: true }); });
    expect(api.savePreview).toHaveBeenCalledTimes(2);
    expect(api.savePreview).toHaveBeenLastCalledWith({ tabId: tab.id, attempt: tab.attempt, dataUrl: `data:image/jpeg;base64,${btoa("4x2")}` });
    await act(async () => { finishes[1]!({ ok: true }); });
    view.unmount();
    expect(api.savePreview).toHaveBeenCalledTimes(2);
  });

  it("allows reattaching after a hidden window detaches its port without reconnecting the session", async () => {
    await mount();
    act(() => message({ type: "closed", reason: "Window hidden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Viewer detached");
    fireEvent.click(screen.getByRole("button", { name: "Reattach viewer" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledTimes(2));
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(api.reconnect).not.toHaveBeenCalled();
    expect(api.disconnect).not.toHaveBeenCalled();
    expect(mocks.open.mock.calls[1]?.slice(1, 3)).toEqual([tab.id, tab.attempt]);
  });

  it("queues keys until capture is authorized and can capture again after OS window blur", async () => {
    let approve: ((result: OperationResult) => void) | undefined;
    vi.mocked(api.setInputCapture).mockImplementation((input) => input.captured ? new Promise((resolve) => { approve = resolve; }) : Promise.resolve({ ok: true }));
    const { handle } = await mount();
    act(() => handle.current?.focus());
    const input = screen.getByLabelText("Keyboard input for Office");
    expect(input.closest(".rdp-screen")).toHaveAttribute("data-input-capture", "pending");
    fireEvent.keyDown(input, { key: "a", code: "KeyA" });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "input")).toHaveLength(0);
    await act(async () => { approve?.({ ok: true }); });
    expect(input.closest(".rdp-screen")).toHaveAttribute("data-input-capture", "captured");
    expect(mocks.send).toHaveBeenCalledWith({ type: "input", events: [{ kind: "unicode", codePoint: 97, down: true }, { kind: "unicode", codePoint: 97, down: false }] });
    fireEvent(window, new Event("blur"));
    expect(input.closest(".rdp-screen")).toHaveAttribute("data-input-capture", "released");
    expect(document.activeElement).toBe(input);
    expect(api.setInputCapture).toHaveBeenLastCalledWith({ tabId: tab.id, captured: false });
    act(() => handle.current?.focus());
    expect(api.setInputCapture).toHaveBeenLastCalledWith({ tabId: tab.id, captured: true });
    await act(async () => { approve?.({ ok: true }); });
    fireEvent.keyDown(input, { key: "ArrowUp", code: "ArrowUp" });
    expect(mocks.send).toHaveBeenLastCalledWith({ type: "input", events: [{ kind: "key", scanCode: 72, extended: true, down: true }] });
  });

  it("discards pending input when a modal or inactive tab revokes capture", async () => {
    let approve: ((result: OperationResult) => void) | undefined;
    vi.mocked(api.setInputCapture).mockImplementation((input) => input.captured ? new Promise((resolve) => { approve = resolve; }) : Promise.resolve({ ok: true }));
    const view = await mount();
    act(() => view.handle.current?.focus());
    fireEvent.keyDown(screen.getByLabelText("Keyboard input for Office"), { key: "x", code: "KeyX" });
    view.rerender(<RdpDesktop ref={view.handle} api={api} tab={tab} active inputEnabled={false} scaleMode="fit" autoResize={false} />);
    await act(async () => { approve?.({ ok: true }); });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "input")).toHaveLength(0);
    expect(mocks.send).toHaveBeenCalledWith({ type: "releaseAll" });
    expect(screen.getByLabelText("Keyboard input for Office")).not.toHaveFocus();
  });

  it("keeps the release chord local and prevents local scroll during remote wheel input", async () => {
    const view = await mount();
    await act(async () => view.handle.current?.focus());
    const input = screen.getByLabelText("Keyboard input for Office");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 20, clientY: 30, deltaY: 120 });
    fireEvent(view.container.querySelector(".rdp-screen")!, wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(mocks.send).toHaveBeenCalledWith({ type: "input", events: [{ kind: "mouse", x: 20, y: 30, wheel: -120, horizontal: false }] });
    mocks.send.mockClear();
    fireEvent.keyDown(input, { key: "Escape", code: "Escape", ctrlKey: true, altKey: true });
    expect(mocks.send.mock.calls.filter(([value]) => value.type === "input")).toHaveLength(0);
    expect(mocks.send).toHaveBeenCalledWith({ type: "releaseAll" });
    expect(input).not.toHaveFocus();
  });
});
