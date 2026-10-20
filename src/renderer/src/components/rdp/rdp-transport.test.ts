import { afterEach, describe, expect, it, vi } from "vitest";
import { RDP_PORT_MESSAGE, type RdpWindowAPI } from "../../../../shared/rdp-contracts";
import { RdpTransport } from "./rdp-transport";

function port(): MessagePort & { postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } {
  return { start: vi.fn(), close: vi.fn(), postMessage: vi.fn(), onmessage: null, onmessageerror: null } as unknown as ReturnType<typeof port>;
}
function api(): RdpWindowAPI {
  return { attach: vi.fn(async () => ({ ok: true, value: { tabId: "tab", attempt: 2, attachmentToken: "token" } })), openRdpStream: vi.fn() } as unknown as RdpWindowAPI;
}
function deliver(correlationId: string, transferred: MessagePort[], source: MessageEventSource | null = window): void {
  window.dispatchEvent(new MessageEvent("message", { source, data: { type: RDP_PORT_MESSAGE, correlationId }, ports: transferred }));
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("RDP display transport", () => {
  it("binds one transferred port to the exact viewer correlation, window, and connection attempt", async () => {
    const bridge = api(), message = vi.fn(), error = vi.fn(), transferred = port();
    let correlation = "";
    vi.mocked(bridge.openRdpStream).mockImplementation((_token, id) => { correlation = id; });
    const connecting = RdpTransport.open(bridge, "tab", 2, new AbortController().signal, message, error);
    await Promise.resolve();
    deliver("wrong-correlation", [transferred]);
    deliver(correlation, [transferred], null);
    expect(transferred.start).not.toHaveBeenCalled();
    deliver(correlation, [transferred]);
    const connected = await connecting;
    expect(transferred.start).toHaveBeenCalledOnce();
    transferred.onmessage?.(new MessageEvent("message", { data: { type: "ready", protocol: 1 } }));
    expect(message).toHaveBeenCalledExactlyOnceWith({ type: "ready", protocol: 1 });
    connected.send({ type: "snapshot" });
    expect(transferred.postMessage).toHaveBeenCalledWith({ type: "snapshot" });
    connected.close(); connected.close();
    expect(transferred.close).toHaveBeenCalledOnce();
    expect(transferred.postMessage).toHaveBeenLastCalledWith({ type: "releaseAll" });
    connected.send({ type: "snapshot" });
    expect(transferred.postMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects stale attachment attempts before transferring any capability", async () => {
    const bridge = api();
    await expect(RdpTransport.open(bridge, "tab", 3, new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow("connection has changed");
    expect(bridge.openRdpStream).not.toHaveBeenCalled();
  });

  it("cancels before attachment and while waiting for a transferred port", async () => {
    const bridge = api(), controller = new AbortController();
    controller.abort();
    await expect(RdpTransport.open(bridge, "tab", 2, controller.signal, vi.fn(), vi.fn())).rejects.toThrow();
    expect(bridge.attach).not.toHaveBeenCalled();
    const second = new AbortController();
    const connecting = RdpTransport.open(bridge, "tab", 2, second.signal, vi.fn(), vi.fn());
    await Promise.resolve();
    second.abort();
    await expect(connecting).rejects.toThrow("cancelled");
  });

  it("closes malformed transfers and closes the stream when display validation fails", async () => {
    const bridge = api(), one = port(), two = port();
    vi.mocked(bridge.openRdpStream).mockImplementation((_token, id) => deliver(id, [one, two]));
    await expect(RdpTransport.open(bridge, "tab", 2, new AbortController().signal, vi.fn(), vi.fn())).rejects.toThrow("attachment is invalid");
    expect(one.close).toHaveBeenCalledOnce(); expect(two.close).toHaveBeenCalledOnce();
    const transferred = port(), error = vi.fn();
    vi.mocked(bridge.openRdpStream).mockImplementation((_token, id) => deliver(id, [transferred]));
    await RdpTransport.open(bridge, "tab", 2, new AbortController().signal, () => { throw new Error("bad tile"); }, error);
    transferred.onmessage?.(new MessageEvent("message", { data: { type: "frame" } }));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stream is invalid"));
    expect(transferred.close).toHaveBeenCalledOnce();
  });
});
