import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GhosttyTerminalProps } from "./GhosttyTerminal";

const mockedTerminal = vi.hoisted(() => ({ props: undefined as GhosttyTerminalProps | undefined }));

vi.mock("./GhosttyTerminal", () => ({
  GhosttyTerminal: (props: GhosttyTerminalProps) => {
    mockedTerminal.props = props;
    return <div aria-label={props.ariaLabel} />;
  },
}));

import { ExecutionOutputTerminal, ExecutionOutputTransport } from "./ExecutionOutputTerminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterEach(() => {
  cleanup();
  mockedTerminal.props = undefined;
  vi.unstubAllGlobals();
});

describe("ExecutionOutputTerminal", () => {
  it("loads the verified runtime and renders captured output in a read-only Ghostty with clipboard actions", async () => {
    const getTerminalRuntime = vi.fn(async () => ({
      ok: true as const,
      value: {
        version: "0.4.0" as const,
        sha256: "a".repeat(64),
        bytes: Uint8Array.of(0, 97, 115, 109),
      },
    }));
    vi.stubGlobal("sliver", { getTerminalRuntime });
    const output = encoder.encode("hello from process\r\n");

    render(<ExecutionOutputTerminal bytes={output} resetKey="run-1" />);

    await screen.findByLabelText("Execution output terminal");
    expect(getTerminalRuntime).toHaveBeenCalledOnce();
    expect(mockedTerminal.props?.disableInput).toBe(true);
    expect(mockedTerminal.props?.enableClipboard).toBe(true);
    expect(mockedTerminal.props?.wasmBytes).toEqual(Uint8Array.of(0, 97, 115, 109));
    expect(mockedTerminal.props?.appearance?.cursorBlink).toBe(false);
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("hello from process");

    const onOutput = vi.fn();
    mockedTerminal.props?.transport.subscribe({ onOutput, onClose: vi.fn() });
    expect(onOutput).not.toHaveBeenCalled();
    mockedTerminal.props?.onReady?.();
    expect(onOutput).toHaveBeenCalledOnce();
    expect(decoder.decode(onOutput.mock.calls[0]?.[0])).toBe("hello from process\r\n");
  });

  it("creates a fresh replay transport when another invocation is selected", async () => {
    vi.stubGlobal("sliver", {
      getTerminalRuntime: vi.fn(async () => ({
        ok: true as const,
        value: { version: "0.4.0", sha256: "b".repeat(64), bytes: Uint8Array.of(0) },
      })),
    });
    const { rerender } = render(
      <ExecutionOutputTerminal bytes={encoder.encode("first")} resetKey="run-1" />,
    );
    await screen.findByLabelText("Execution output terminal");
    const firstTransport = mockedTerminal.props?.transport;

    rerender(<ExecutionOutputTerminal bytes={encoder.encode("second")} resetKey="run-2" />);
    await waitFor(() => expect(mockedTerminal.props?.transport).not.toBe(firstTransport));
    const onOutput = vi.fn();
    mockedTerminal.props?.transport.subscribe({ onOutput, onClose: vi.fn() });
    mockedTerminal.props?.onReady?.();
    expect(decoder.decode(onOutput.mock.calls[0]?.[0])).toBe("second");
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("second");
  });

  it("shows a runtime error without exposing an editable terminal", async () => {
    vi.stubGlobal("sliver", {
      getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "Runtime unavailable" })),
    });
    render(<ExecutionOutputTerminal bytes={encoder.encode("output")} resetKey="run-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime unavailable");
    expect(screen.queryByLabelText("Execution output terminal")).not.toBeInTheDocument();
  });
});

describe("ExecutionOutputTransport", () => {
  it("waits for readiness, emits bounded chunks, replays after remount, and never sends input", () => {
    const transport = new ExecutionOutputTransport();
    const bytes = new Uint8Array((64 * 1_024) + 7).fill(65);
    const onOutput = vi.fn();
    const unsubscribe = transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(bytes);
    expect(onOutput).not.toHaveBeenCalled();

    transport.ready();
    expect(onOutput).toHaveBeenCalledTimes(2);
    expect(onOutput.mock.calls.map(([chunk]) => chunk.byteLength)).toEqual([64 * 1_024, 7]);
    transport.send(encoder.encode("ignored"), "operator");
    transport.resize(120, 40);
    expect(onOutput).toHaveBeenCalledTimes(2);

    unsubscribe();
    const replay = vi.fn();
    transport.subscribe({ onOutput: replay, onClose: vi.fn() });
    expect(replay).not.toHaveBeenCalled();
    transport.ready();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(replay.mock.calls.reduce((sum, [chunk]) => sum + chunk.byteLength, 0)).toBe(bytes.byteLength);
  });

  it("appends new output and resets the emulator when same-key output is replaced", () => {
    const transport = new ExecutionOutputTransport();
    const onOutput = vi.fn();
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(encoder.encode("first"));
    transport.ready();
    transport.update(encoder.encode("first second"));
    expect(onOutput.mock.calls.map(([chunk]) => decoder.decode(chunk))).toEqual(["first", " second"]);

    transport.update(encoder.encode("replacement"));
    expect(onOutput.mock.calls.map(([chunk]) => decoder.decode(chunk))).toEqual([
      "first", " second", "\u001bc", "replacement",
    ]);
  });

  it("normalizes bare LF without doubling CRLF, including across output updates", () => {
    const transport = new ExecutionOutputTransport();
    const onOutput = vi.fn();
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(encoder.encode("one\ntwo\r\nthree\r"));
    transport.ready();
    transport.update(encoder.encode("one\ntwo\r\nthree\r\nfour\n"));

    expect(onOutput.mock.calls.map(([chunk]) => decoder.decode(chunk))).toEqual([
      "one\r\ntwo\r\nthree\r", "\nfour\r\n",
    ]);
  });

  it("caps an unexpected oversized transcript without changing the caller's bytes", () => {
    const transport = new ExecutionOutputTransport();
    const onOutput = vi.fn();
    const input = new Uint8Array((2 * 1_024 * 1_024) + 1).fill(65);
    input[input.byteLength - 1] = 66;
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(input);
    transport.ready();

    expect(onOutput.mock.calls.reduce((sum, [chunk]) => sum + chunk.byteLength, 0)).toBe(2 * 1_024 * 1_024);
    expect(onOutput.mock.calls.every(([chunk]) => chunk.byteLength <= 64 * 1_024)).toBe(true);
    expect(input[input.byteLength - 1]).toBe(66);
  });

  it("drops its private output copy when the view is cleared", () => {
    const transport = new ExecutionOutputTransport();
    const onOutput = vi.fn();
    transport.subscribe({ onOutput, onClose: vi.fn() });
    transport.update(encoder.encode("sensitive output"));
    transport.clear();
    transport.ready();

    expect(onOutput).not.toHaveBeenCalled();
    transport.update(encoder.encode("next output"));
    expect(onOutput.mock.calls.map(([chunk]) => decoder.decode(chunk))).toEqual(["next output"]);
  });
});
