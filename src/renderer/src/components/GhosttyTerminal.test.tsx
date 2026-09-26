import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithApplicationContextMenu } from "../application-context-menu-test-utils";

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
    options: Record<string, unknown>;
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

    constructor(readonly options: Record<string, unknown>) {
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

    onSelectionChange(_listener: () => void) {
      return { dispose: vi.fn() };
    }

    loadAddon(addon: { activate?: (terminal: Terminal) => void }) {
      addon.activate?.(this);
    }

    open(element: HTMLElement) {
      this.element = element;
      element.setAttribute("contenteditable", "true");
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
const resizeObservers: Array<{
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];

beforeEach(() => {
  ghosttyMocks.fitAddons.length = 0;
  ghosttyMocks.fitResize = undefined;
  ghosttyMocks.ghosttyInstances.length = 0;
  ghosttyMocks.responsesPerWrite.length = 0;
  ghosttyMocks.terminals.length = 0;
  resizeObservers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    readonly observe = vi.fn();
    readonly disconnect = vi.fn();
    constructor(readonly callback: ResizeObserverCallback) {
      resizeObservers.push(this);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
  Reflect.deleteProperty(document, "execCommand");
  Reflect.deleteProperty(document, "fonts");
});

describe("GhosttyTerminal", () => {
  it.each([true, false])("preserves native context-menu events with clipboard actions enabled=%s", async (enableClipboard) => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const outerCapture = vi.fn();
    renderWithApplicationContextMenu(
      <section onContextMenuCapture={outerCapture}>
        <GhosttyTerminal
          ariaLabel="Context-menu terminal"
          enableClipboard={enableClipboard}
          transport={transport.api}
          wasmBytes={new Uint8Array([0x00, 0x61, 0x73, 0x6d])}
        />
      </section>,
    );
    const host = await screen.findByRole("textbox", { name: "Context-menu terminal" });
    const canvas = document.createElement("canvas");
    host.append(canvas);
    const vendorCanvasContextMenu = vi.fn();
    canvas.addEventListener("contextmenu", vendorCanvasContextMenu);
    const event = createEvent.contextMenu(canvas, { bubbles: true, cancelable: true });

    fireEvent(canvas, event);

    expect(outerCapture).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(vendorCanvasContextMenu).toHaveBeenCalledTimes(enableClipboard ? 0 : 1);
  });

  it.each([true, false])("filters only the hidden terminal input's scroll events with clipboard actions enabled=%s", async (enableClipboard) => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const rendered = renderWithApplicationContextMenu(
      <GhosttyTerminal
        ariaLabel="Scroll-filter terminal"
        enableClipboard={enableClipboard}
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00, 0x61, 0x73, 0x6d])}
      />,
    );
    const host = await screen.findByRole("textbox", { name: "Scroll-filter terminal" });
    const hiddenInput = document.createElement("textarea");
    const canvas = document.createElement("canvas");
    const nestedContainer = document.createElement("div");
    const nestedInput = document.createElement("textarea");
    nestedContainer.append(nestedInput);
    host.append(hiddenInput, canvas, nestedContainer);
    const outsideInput = document.createElement("textarea");
    document.body.append(outsideInput);
    const observedEvents: Event[] = [];
    const observeScroll = (event: Event): void => { observedEvents.push(event); };
    // A popup registers its window-capture listener after the terminal mounts.
    window.addEventListener("scroll", observeScroll, true);

    try {
      fireEvent(hiddenInput, new Event("scroll"));
      expect(observedEvents.length).toBe(0);
      observedEvents.length = 0;

      const visibleScrollEvents: Event[] = [];
      for (const target of [host, canvas, nestedInput, outsideInput, document, window]) {
        const event = new Event("scroll");
        visibleScrollEvents.push(event);
        target.dispatchEvent(event);
      }
      expect(observedEvents.length).toBe(visibleScrollEvents.length);
      expect(observedEvents.every((event, index) => event === visibleScrollEvents[index])).toBe(true);
      observedEvents.length = 0;

      rendered.unmount();
      // Reconnect the old host to prove its former capture filter was removed,
      // even for a textarea that still has that exact host as its parent.
      document.body.append(host);
      const afterUnmount = new Event("scroll");
      fireEvent(hiddenInput, afterUnmount);
      expect(observedEvents.length).toBe(1);
      expect(observedEvents[0] === afterUnmount).toBe(true);
    } finally {
      window.removeEventListener("scroll", observeScroll, true);
      outsideInput.remove();
      if (!rendered.container.contains(host)) host.remove();
    }
  });

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
    expect(terminal.options["fontFamily"]).toBe('"Fira Code", monospace');
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(decoder.decode(terminal.write.mock.calls[0]?.[0] as Uint8Array)).toBe(
      "safelinkhttps://plain.example",
    );

    const host = screen.getByRole("textbox", { name: "Safe terminal" });
    expect(host).toHaveAttribute("contenteditable", "true");
    expect(host).not.toHaveClass("p-2");
    expect(host.style.backgroundColor).toBe("rgb(30, 30, 30)");
    expect(host.parentElement?.style.backgroundColor).toBe("rgb(30, 30, 30)");
    expect(host.style.caretColor).toBe("transparent");
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
    expect(contextMenu.defaultPrevented).toBe(false);
    expect(host).toHaveAttribute("data-application-context-menu-policy", "inspect-only");
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

  it("makes an output-only terminal inert without forwarding operator or terminal-response bytes", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    ghosttyMocks.responsesPerWrite.push(["\u001b[1;1R"]);

    render(
      <GhosttyTerminal
        ariaLabel="Windows shell output"
        disableInput
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    const host = await screen.findByRole("textbox", { name: "Windows shell output" });
    const terminal = requireTerminal();

    expect(terminal.options["disableStdin"]).toBe(true);
    expect(host).toHaveAttribute("aria-readonly", "true");
    act(() => terminal.emitData("whoami\r"));
    act(() => transport.emitOutput(encoder.encode("result\u001b[6n")));

    expect(transport.send).not.toHaveBeenCalled();
    expect(terminal.write).toHaveBeenCalledOnce();
    expect(decoder.decode(terminal.write.mock.calls[0]?.[0] as Uint8Array)).toBe("result\u001b[6n");
  });

  it("accepts Windows PowerShell input in the terminal without leaking device replies", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const frames: Array<{ data: string; source: string }> = [];
    transport.send.mockImplementation((bytes, source) => {
      frames.push({ data: decoder.decode(bytes.slice()), source });
    });
    ghosttyMocks.responsesPerWrite.push(["\u001b[1;1R"]);

    render(
      <GhosttyTerminal
        ariaLabel="Interactive Windows shell"
        pipedWindowsInput
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    const host = await screen.findByRole("textbox", { name: "Interactive Windows shell" });
    const terminal = requireTerminal();
    expect(terminal.options["disableStdin"]).toBe(false);
    expect(host).not.toHaveAttribute("aria-readonly");

    act(() => terminal.emitData("Write-OutpuX"));
    act(() => terminal.emitData("\u007f"));
    act(() => terminal.emitData("t 'ready'\r"));
    act(() => terminal.emitData("\u001b[D"));
    act(() => transport.emitOutput(encoder.encode("\u001b[6n")));

    expect(frames).toEqual([
      { data: "Write-OutpuX", source: "operator" },
      { data: "\b \b", source: "operator" },
      { data: "t 'ready'\r", source: "operator" },
    ]);
  });

  it("sends a reviewed multiline Windows paste in bounded wire slices", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const slices: Uint8Array[] = [];
    transport.send.mockImplementation((bytes, source) => {
      expect(source).toBe("operator");
      slices.push(bytes.slice());
    });
    const ref = createRef<GhosttyTerminalHandle>();
    render(
      <GhosttyTerminal
        ref={ref}
        pipedWindowsInput
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(1));

    const line = "x".repeat(12_000);
    act(() => ref.current?.paste(`${line}\n${line}\n${line}\n${line}\n${line}\n`));
    expect(slices.length).toBeGreaterThan(1);
    expect(slices.every((slice) => slice.byteLength <= 16 * 1_024)).toBe(true);
    expect(decoder.decode(concat(slices))).toBe(`${line}\r${line}\r${line}\r${line}\r${line}\r`);
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
    expect(ghosttyMocks.fitAddons[0]?.observeResize).not.toHaveBeenCalled();
    expect(resizeObservers[0]?.observe).toHaveBeenCalledWith(
      screen.getByRole("textbox", { name: "Interactive session terminal" }),
    );

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

  it("refits after a burst of host resizes and cancels pending fits on unmount", async () => {
    installWebAssemblyMocks();
    const transport = fakeTransport();
    const rendered = render(
      <GhosttyTerminal
        transport={transport.api}
        wasmBytes={new Uint8Array([0x00])}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.fitAddons[0]?.fit).toHaveBeenCalledOnce());
    const observer = resizeObservers[0]!;
    const addon = ghosttyMocks.fitAddons[0]!;

    act(() => {
      observer.callback([], observer as unknown as ResizeObserver);
      observer.callback([], observer as unknown as ResizeObserver);
    });
    expect(addon.fit).toHaveBeenCalledOnce();
    await waitFor(() => expect(addon.fit).toHaveBeenCalledTimes(2));

    act(() => observer.callback([], observer as unknown as ResizeObserver));
    rendered.unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    await delay(140);
    expect(addon.fit).toHaveBeenCalledTimes(2);
  });

  it("uses Fira Code by default and applies live appearance changes without remounting", async () => {
    const { instantiate } = installWebAssemblyMocks();
    const transport = fakeTransport();
    const wasmBytes = new Uint8Array([0x00]);
    const rendered = render(
      <GhosttyTerminal
        appearance={{
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily: '"Fira Code", monospace',
          fontSize: 13,
          smoothScrollDuration: 0,
        }}
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );
    await waitFor(() => expect(ghosttyMocks.terminals).toHaveLength(1));
    const terminal = requireTerminal();
    const fitAddon = ghosttyMocks.fitAddons[0];
    const initialFitCalls = fitAddon?.fit.mock.calls.length ?? 0;

    expect(terminal.options).toMatchObject({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: '"Fira Code", monospace',
      fontSize: 13,
      smoothScrollDuration: 0,
    });

    rendered.rerender(
      <GhosttyTerminal
        appearance={{
          cursorBlink: false,
          cursorStyle: "bar",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 18,
          smoothScrollDuration: 100,
        }}
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );

    await waitFor(() => expect(terminal.options).toMatchObject({
      cursorBlink: false,
      cursorStyle: "bar",
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 18,
      smoothScrollDuration: 100,
    }));
    expect(ghosttyMocks.terminals).toHaveLength(1);
    expect(instantiate).toHaveBeenCalledOnce();
    expect(transport.unsubscribe).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(fitAddon?.fit.mock.calls.length).toBeGreaterThan(initialFitCalls);
  });

  it("updates its accessible label without recreating or clearing the terminal", async () => {
    const { instantiate } = installWebAssemblyMocks();
    const transport = fakeTransport();
    const wasmBytes = new Uint8Array([0x00]);
    const rendered = render(
      <GhosttyTerminal
        ariaLabel="SSH session test1"
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );
    await screen.findByRole("textbox", { name: "SSH session test1" });
    const terminal = requireTerminal();
    act(() => transport.emitOutput(encoder.encode("existing scrollback")));
    expect(decoder.decode(terminal.write.mock.calls[0]?.[0] as Uint8Array)).toBe("existing scrollback");

    rendered.rerender(
      <GhosttyTerminal
        ariaLabel="SSH session Primary gateway"
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );

    await screen.findByRole("textbox", { name: "SSH session Primary gateway" });
    expect(ghosttyMocks.terminals).toEqual([terminal]);
    expect(instantiate).toHaveBeenCalledOnce();
    expect(transport.unsubscribe).not.toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();

    act(() => transport.emitOutput(encoder.encode(" after rename")));
    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(decoder.decode(terminal.write.mock.calls[0]?.[0] as Uint8Array)).toBe("existing scrollback");
    expect(decoder.decode(terminal.write.mock.calls[1]?.[0] as Uint8Array)).toBe(" after rename");
  });

  it("applies the latest appearance when settings change during async font loading", async () => {
    installWebAssemblyMocks();
    const initialFontLoad = deferred<unknown[]>();
    const load = vi.fn()
      .mockImplementationOnce(() => initialFontLoad.promise)
      .mockResolvedValue([]);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { load },
    });
    const transport = fakeTransport();
    const wasmBytes = new Uint8Array([0x00]);
    const rendered = render(
      <GhosttyTerminal
        appearance={{
          cursorBlink: true,
          cursorStyle: "block",
          fontFamily: '"Fira Code", monospace',
          fontSize: 13,
          smoothScrollDuration: 0,
        }}
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );
    await waitFor(() => expect(load).toHaveBeenCalledWith('13px "Fira Code", monospace'));

    rendered.rerender(
      <GhosttyTerminal
        appearance={{
          cursorBlink: false,
          cursorStyle: "underline",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 18,
          smoothScrollDuration: 100,
        }}
        transport={transport.api}
        wasmBytes={wasmBytes}
      />,
    );
    expect(ghosttyMocks.terminals).toHaveLength(0);
    initialFontLoad.resolve([]);

    await waitFor(() => expect(requireTerminal().options).toMatchObject({
      cursorBlink: false,
      cursorStyle: "underline",
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 18,
      smoothScrollDuration: 100,
    }));
    expect(ghosttyMocks.terminals).toHaveLength(1);
    expect(load).toHaveBeenCalledWith('18px "JetBrains Mono", monospace');
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
