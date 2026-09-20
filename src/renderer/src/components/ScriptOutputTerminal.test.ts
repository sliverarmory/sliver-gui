import { describe, expect, it, vi } from "vitest";
import { ScriptOutputTransport, scriptOutputText } from "./ScriptOutputTerminal";

describe("local script output transport", () => {
  it("waits for Ghostty to initialize, emits each record once and discards input", () => {
    const transport = new ScriptOutputTransport();
    const onOutput = vi.fn();
    const records = [{ sequence: 0, level: "log" as const, text: "Hello, world!" }];
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(records);
    expect(onOutput).not.toHaveBeenCalled();
    transport.ready();
    transport.update(records);
    expect(onOutput).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(onOutput.mock.calls[0]![0])).toContain("Hello, world!");
    transport.send();
    transport.resize();
    expect(onOutput).toHaveBeenCalledOnce();
  });
  it("escapes guest controls before adding trusted colors and exposes the same text for copying", () => {
    const records = [{ sequence: 0, level: "warn" as const, text: "\x1b]52;c;data\x07<b>text</b>" }];
    const onOutput = vi.fn();
    const transport = new ScriptOutputTransport();
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.ready();
    transport.update(records);
    const output = new TextDecoder().decode(onOutput.mock.calls[0]![0]);
    expect(output.startsWith("\x1b[33m")).toBe(true);
    expect(output).not.toContain("\x1b]52");
    expect(output).toContain("\\u001b]52;c;data\\u0007<b>text</b>");
    expect(scriptOutputText(records)).toBe("\\u001b]52;c;data\\u0007<b>text</b>\n");
  });

  it("replays existing output only after a replacement Ghostty emulator becomes ready", () => {
    const transport = new ScriptOutputTransport();
    const firstOutput = vi.fn();
    const unsubscribe = transport.subscribe({ onOutput: firstOutput, onClose: vi.fn() });
    const records = [{ sequence: 0, level: "log" as const, text: "Persist across theme changes" }];
    transport.update(records);
    transport.ready();
    expect(firstOutput).toHaveBeenCalledOnce();
    unsubscribe();

    const replacementOutput = vi.fn();
    transport.subscribe({ onOutput: replacementOutput, onClose: vi.fn() });
    transport.update(records);
    expect(replacementOutput).not.toHaveBeenCalled();
    transport.ready();
    transport.update(records);
    expect(replacementOutput).toHaveBeenCalledOnce();
    expect(new TextDecoder().decode(replacementOutput.mock.calls[0]![0])).toContain(records[0]!.text);
  });
});
