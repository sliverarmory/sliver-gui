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

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  mocks.send.mockReset(); mocks.close.mockReset(); mocks.open.mockReset();
  mocks.open.mockImplementation(async (_api, _tabId, _attempt, _signal, onMessage) => { message = onMessage; return { send: mocks.send, close: mocks.close }; });
  api = { setInputCapture: vi.fn(async () => ({ ok: true })), reconnect: vi.fn(), disconnect: vi.fn() } as unknown as RdpWindowAPI;
  vi.stubGlobal("ImageData", class { constructor(public data: Uint8ClampedArray, public width: number, public height: number) {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ putImageData: vi.fn(), drawImage: vi.fn(), clearRect: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(Element.prototype, "getAnimations"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount(): Promise<ReturnType<typeof render> & { handle: React.RefObject<RdpDesktopHandle | null> }> {
  const handle = createRef<RdpDesktopHandle>();
  const result = render(<RdpDesktop ref={handle} api={api} tab={tab} active inputEnabled scaleMode="fit" autoResize={false} />);
  await act(async () => {});
  act(() => message({ type: "ready", protocol: 1 }));
  return { ...result, handle };
}

describe("remote desktop viewer lifecycle", () => {
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
