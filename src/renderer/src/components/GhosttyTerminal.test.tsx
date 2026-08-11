import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ghosttyMocks = vi.hoisted(() => ({
  fitAddons: [] as Array<{
    fit: ReturnType<typeof vi.fn>;
    observeResize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  fitResize: undefined as { cols: number; rows: number } | undefined,
  ghosttyInstances: [] as unknown[],
  responsesPerWrite: [] as string[][],
  terminals: [] as Array<{
    blur: ReturnType<typeof vi.fn>;
    cols: number;
    dispose: ReturnType<typeof vi.fn>;
    emitData: (data: string) => void;
    emitResize: (cols: number, rows: number) => void;
    focus: ReturnType<typeof vi.fn>;
    getSelection: ReturnType<typeof vi.fn>;
    paste: ReturnType<typeof vi.fn>;
    rows: number;
    simulateSelectionDoubleClick: () => void;
    simulateSelectionMouseUp: () => void;
    write: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("ghostty-web", () => {
  class Ghostty {
    constructor(instance: unknown) {
      ghosttyMocks.ghosttyInstances.push(instance);
    }
  }

  class Terminal {
    cols = 80;
    rows = 24;
    private dataListener: ((data: string) => void) | undefined;
    private resizeListener: ((size: { cols: number; rows: number }) => void) | undefined;
    private element?: HTMLElement;
    private readonly selectionManager = {
      copyToClipboard: (text: string) => {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        (document as Document & { execCommand?: (command: string) => boolean }).execCommand?.("copy");
        return Promise.resolve();
      },
    };
    private readonly linkClick = (event: MouseEvent) => {
      if (event.ctrlKey || event.metaKey) window.open("https://output.example.test", "_blank");
    };
    private readonly selectionMouseUp = () => {
      void this.selectionManager.copyToClipboard("selected output");
    };
    private readonly selectionDoubleClick = () => {
      void this.selectionManager.copyToClipboard("selected output");
    };

    readonly focus = vi.fn();
    readonly blur = vi.fn();
    readonly getSelection = vi.fn(() => "selected output");
    readonly write = vi.fn((bytes: Uint8Array) => {
      void bytes;
      for (const response of ghosttyMocks.responsesPerWrite.shift() ?? []) {
        this.dataListener?.(response);
      }
    });
    readonly paste = vi.fn((text: string) => this.dataListener?.(text));
    readonly dispose = vi.fn(() => {
      this.element?.removeEventListener("click", this.linkClick);
      this.element?.removeEventListener("dblclick", this.selectionDoubleClick);
      document.removeEventListener("mouseup", this.selectionMouseUp);
    });

    constructor(_options: unknown) {
      ghosttyMocks.terminals.push(this);
    }

    onData(listener: (data: string) => void) {
      this.dataListener = listener;
      return { dispose: vi.fn(() => {
        if (this.dataListener === listener) this.dataListener = undefined;
      }) };
    }

    onResize(listener: (size: { cols: number; rows: number }) => void) {
      this.resizeListener = listener;
      return { dispose: vi.fn(() => {
        if (this.resizeListener === listener) this.resizeListener = undefined;
      }) };
    }

    loadAddon(addon: { activate?: (terminal: Terminal) => void }) {
      addon.activate?.(this);
    }

    open(element: HTMLElement) {
      this.element = element;
      element.setAttribute("role", "textbox");
      element.setAttribute("aria-label", "Terminal input");
      element.addEventListener("click", this.linkClick);
      element.addEventListener("dblclick", this.selectionDoubleClick);
      document.addEventListener("mouseup", this.selectionMouseUp);
      this.focus();
    }

    simulateSelectionMouseUp() {
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }

    simulateSelectionDoubleClick() {
      this.element?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    }

    emitData(data: string) {
      this.dataListener?.(data);
    }

    emitResize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
      this.resizeListener?.({ cols, rows });
    }
  }

  class FitAddon {
    private terminal?: Terminal;
    readonly fit = vi.fn(() => {
      if (ghosttyMocks.fitResize) {
        this.terminal?.emitResize(ghosttyMocks.fitResize.cols, ghosttyMocks.fitResize.rows);
      }
    });
    readonly observeResize = vi.fn();
    readonly dispose = vi.fn();

    constructor() {
      ghosttyMocks.fitAddons.push(this);
    }

    activate(terminal: Terminal) {
      this.terminal = terminal;
    }
  }

  return { FitAddon, Ghostty, Terminal };
});

import {
  GhosttyTerminal,
  type GhosttyTerminalHandle,
  type GhosttyTerminalTransport,
  type GhosttyTerminalTransportSubscription,
} from "./GhosttyTerminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

beforeEach(() => {
  ghosttyMocks.fitAddons.length = 0;
  ghosttyMocks.fitResize = undefined;
  ghosttyMocks.ghosttyInstances.length = 0;
  ghosttyMocks.responsesPerWrite.length = 0;
  ghosttyMocks.terminals.length = 0;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
});

describe("GhosttyTerminal", () => {
  it("loads pinned bytes without fetch and blocks hostile output host effects", async () => {
    const { compile, compiledBytes, instantiate } = installWebAssemblyMocks();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const notification = vi.fn();
    vi.stubGlobal("Notification", notification);
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    const transport = fakeTransport();
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);

    render(
      <GhosttyTerminal
        ariaLabel="Safe terminal"
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );
    await screen.findByRole("textbox", { name: "Safe terminal" });

    expect(compile).toHaveBeenCalledOnce();
    expect(compiledBytes()).toEqual(wasmBytes);
    expect(compile.mock.calls[0]?.[0]).not.toBe(wasmBytes);
    expect(compile.mock.calls[0]?.[0]).toEqual(new Uint8Array(wasmBytes.byteLength));
    expect(instantiate).toHaveBeenCalledOnce();
    const imports = instantiate.mock.calls[0]?.[1] as { env?: { log?: (...args: unknown[]) => unknown } };
    expect(imports.env?.log?.(1, 2)).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();

    act(() => {
      transport.emitOutput(concat([
        encoder.encode("safe"),
        encoder.encode("\u001b]0;hostile title\u0007"),
        encoder.encode("\u001b]8;;https://link.example\u001b\\link\u001b]8;;\u001b\\"),
        encoder.encode("\u001b]52;c;c2VjcmV0\u0007"),
        encoder.encode("\u001b_Gf=100;kitty\u001b\\"),
        encoder.encode("\u001b]1337;File=name=dGVzdA==:ZmFrZQ==\u0007"),
        new Uint8Array([0x07]),
        encoder.encode("https://plain.example"),
      ]));
    });

    const terminal = requireTerminal();
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(decoder.decode(terminal.write.mock.calls[0]?.[0] as Uint8Array)).toBe(
      "safelinkhttps://plain.example",
    );

    const host = screen.getByRole("textbox", { name: "Safe terminal" });
    fireEvent.click(host, { ctrlKey: true });
    act(() => {
      terminal.simulateSelectionMouseUp();
      terminal.simulateSelectionDoubleClick();
    });
    expect(open).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(execCommand).not.toHaveBeenCalled();
    expect(notification).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const paste = createEvent.paste(host);
    fireEvent(host, paste);
    expect(paste.defaultPrevented).toBe(true);
    const contextMenu = createEvent.contextMenu(host);
    fireEvent(host, contextMenu);
    expect(contextMenu.defaultPrevented).toBe(true);
  });

  it("classifies synchronous terminal replies separately and enforces a response budget", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    ghosttyMocks.responsesPerWrite.push(["abc", "de"], ["z"], ["overflow"]);

    render(
      <GhosttyTerminal
        terminalResponseBudgetBytes={4}
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(1));

    act(() => transport.emitOutput(encoder.encode("\u001b[6n")));
    expect(sentFrames(transport.send)).toEqual([
      { data: "abc", source: "terminal-response" },
    ]);

    act(() => transport.emitOutput(encoder.encode("\u001b[5n")));
    expect(sentFrames(transport.send)).toEqual([
      { data: "abc", source: "terminal-response" },
      { data: "z", source: "terminal-response" },
    ]);

    act(() => requireTerminal().emitData("typed"));
    expect(sentFrames(transport.send).at(-1)).toEqual({ data: "typed", source: "operator" });
  });

  it("preserves workspace focus and exposes only bounded explicit handle operations", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const ref = createRef<GhosttyTerminalHandle>();

    render(
      <GhosttyTerminal
        ref={ref}
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(1));
    const terminal = requireTerminal();

    expect(terminal.focus).toHaveBeenCalledOnce();
    expect(terminal.blur).toHaveBeenCalledOnce();
    act(() => ref.current?.focus());
    expect(terminal.focus).toHaveBeenCalledTimes(2);

    terminal.getSelection.mockReturnValue("é".repeat(40_000));
    expect(encoder.encode(ref.current?.getSelection() ?? "").byteLength).toBeLessThanOrEqual(65_539);

    expect(() => ref.current?.paste("bad\0paste")).toThrow(/NUL/u);
    expect(() => ref.current?.paste("x".repeat(65_537))).toThrow(/exceeds/u);
    act(() => ref.current?.paste("reviewed paste"));
    expect(terminal.paste).toHaveBeenCalledWith("reviewed paste");
    expect(sentFrames(transport.send).at(-1)).toEqual({ data: "reviewed paste", source: "operator" });
  });

  it("fits, clamps, debounces, and deduplicates terminal resize", async () => {
    installWebAssemblyMocks();
    ghosttyMocks.fitResize = { cols: 120, rows: 40 };
    const transport = fakeTransport();

    render(
      <GhosttyTerminal
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );

    await waitFor(() => expect(transport.resize).toHaveBeenCalledWith(120, 40), { timeout: 1_000 });
    expect(ghosttyMocks.fitAddons[0]?.fit).toHaveBeenCalledOnce();
    expect(ghosttyMocks.fitAddons[0]?.observeResize).toHaveBeenCalledOnce();

    const resizeCalls = transport.resize.mock.calls.length;
    act(() => {
      requireTerminal().emitResize(120, 40);
      requireTerminal().emitResize(120, 40);
    });
    await delay(140);
    expect(transport.resize).toHaveBeenCalledTimes(resizeCalls);

    act(() => requireTerminal().emitResize(0, 100_000));
    await waitFor(() => expect(transport.resize).toHaveBeenLastCalledWith(1, 1_000));
  });

  it("disposes a grapheme-bearing terminal and creates a fresh isolated WASM instance", async () => {
    const { instantiate } = installWebAssemblyMocks();
    const firstTransport = fakeTransport();
    const first = render(
      <GhosttyTerminal
        transport={firstTransport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(1));
    act(() => firstTransport.emitOutput(encoder.encode("👨‍👩‍👧")));
    const firstTerminal = requireTerminal();
    first.unmount();
    expect(firstTerminal.dispose).toHaveBeenCalledOnce();
    expect(firstTransport.unsubscribe).toHaveBeenCalledOnce();

    const secondTransport = fakeTransport();
    render(
      <GhosttyTerminal
        transport={secondTransport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(2));
    act(() => secondTransport.emitOutput(encoder.encode("fresh")));

    expect(instantiate).toHaveBeenCalledTimes(2);
    expect(ghosttyMocks.ghosttyInstances).toHaveLength(2);
    expect(ghosttyMocks.ghosttyInstances[0]).not.toBe(ghosttyMocks.ghosttyInstances[1]);
    expect(decoder.decode(ghosttyMocks.terminals[1]?.write.mock.calls[0]?.[0] as Uint8Array)).toBe("fresh");
  });
});

function installWebAssemblyMocks() {
  let copiedAtCompile: Uint8Array | undefined;
  const compile = vi.spyOn(WebAssembly, "compile").mockImplementation(async (bytes) => {
    copiedAtCompile = new Uint8Array(
      bytes instanceof ArrayBuffer
        ? bytes
        : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    ).slice();
    return {} as WebAssembly.Module;
  });
  let instanceId = 0;
  const instantiate = vi.spyOn(WebAssembly, "instantiate").mockImplementation(async () => ({
    exports: { instanceId: ++instanceId },
  }) as unknown as WebAssembly.Instance);
  return { compile, compiledBytes: () => copiedAtCompile, instantiate };
}

function fakeTransport() {
  let subscription: GhosttyTerminalTransportSubscription | undefined;
  const send = vi.fn<GhosttyTerminalTransport["send"]>();
  const resize = vi.fn<GhosttyTerminalTransport["resize"]>();
  const unsubscribe = vi.fn(() => {
    subscription = undefined;
  });
  const subscribe = vi.fn<GhosttyTerminalTransport["subscribe"]>((next) => {
    subscription = next;
    return unsubscribe;
  });
  return {
    api: { resize, send, subscribe } satisfies GhosttyTerminalTransport,
    emitClose: (reason?: string) => subscription?.onClose(reason),
    emitOutput: (bytes: Uint8Array) => subscription?.onOutput(bytes),
    resize,
    send,
    unsubscribe,
  };
}

function requireTerminal() {
  const terminal = ghosttyMocks.terminals.at(-1);
  if (!terminal) throw new Error("Mock terminal was not created");
  return terminal;
}

function sentFrames(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map(([bytes, source]) => ({
    data: decoder.decode(bytes as Uint8Array),
    source,
  }));
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function delay(milliseconds: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  });
}
