// @vitest-environment node

import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import { observeConsoleInput, type ConsoleProbeBrowser } from "./console-input-probe.js";

function createProbe() {
  const browser: ConsoleProbeBrowser = { addEventListener: vi.fn() };
  // Match Playwright's serialization so the probe cannot accidentally depend
  // on imports or a closure that is unavailable in the production renderer.
  runInNewContext(`(${observeConsoleInput.toString()})()`, Object.assign(browser, { TextDecoder, ArrayBuffer }));
  const onWindowMessage = vi.mocked(browser.addEventListener).mock.calls[0]![1];
  const port = { addEventListener: vi.fn(), start: vi.fn(), postMessage: vi.fn() };
  onWindowMessage({ data: { source: "sliver-preload", type: "console-stream-port" }, ports: [port] });
  const onOutput = port.addEventListener.mock.calls[0]![1];
  const send = (text: string): Uint8Array => {
    const bytes = new TextEncoder().encode(text);
    onOutput({ data: { type: "data", data: bytes.buffer } });
    return bytes;
  };
  return { browser, onWindowMessage, port, send, probe: browser.__SLIVER_GUI_PACKAGED_CONSOLE_INPUT__! };
}

describe("packaged native console input readiness", () => {
  it("waits beyond the startup banner and prompt until the cursor handshake completes", () => {
    const { probe, send } = createProbe();
    send("Server v1.7.0\r\nWelcome to the sliver shell\r\n\u001b[?25h");
    expect(probe.readlineReady).toBe(false);
    send("\u001b[4msliver\u001b[0m > \u001b[6n");
    expect(probe.readlineReady).toBe(false);
    send("\u001b[?25");
    expect(probe.readlineReady).toBe(false);
    send("h");
    expect(probe.readlineReady).toBe(true);
  });

  it("requires the complete echoed command across formatted, fragmented output", () => {
    const { probe, send } = createProbe();
    send("\u001b[4msliver\u001b[0m > \u001b[32mver");
    expect(probe.commandEchoed).toBe(false);
    send("sion\u001b[0m\u001b[?25h");
    expect(probe.commandEchoed).toBe(true);
  });

  it("observes output without mutating frames or taking over the port", () => {
    const { probe, port, send, onWindowMessage } = createProbe();
    const text = "sliver > \u001b[?25h";
    const bytes = send(text);
    expect(new TextDecoder().decode(bytes)).toBe(text);
    expect(probe.outputBytes).toBe(bytes.byteLength);
    expect(port.start).not.toHaveBeenCalled();
    expect(port.postMessage).not.toHaveBeenCalled();
    const unrelatedPort = { addEventListener: vi.fn() };
    onWindowMessage({ data: { source: "sliver-preload", type: "ssh-stream-port" }, ports: [unrelatedPort] });
    expect(unrelatedPort.addEventListener).not.toHaveBeenCalled();
  });
});
