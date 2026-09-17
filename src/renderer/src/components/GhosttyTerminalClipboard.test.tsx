import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, StrictMode } from "react";
import type { Terminal } from "ghostty-web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApplicationContextMenuItem } from "../../../shared/application-context-menu-contracts";
import { renderWithApplicationContextMenu } from "../application-context-menu-test-utils";
import { GhosttyTerminalClipboard } from "./GhosttyTerminalClipboard";

const toastMocks = vi.hoisted(() => ({ danger: vi.fn() }));

vi.mock("@heroui/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("@heroui/react")>(),
  toast: toastMocks,
}));

beforeEach(() => {
  toastMocks.danger.mockClear();
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const property of ["clipboard", "userActivation", "platform"]) {
    Reflect.deleteProperty(navigator, property);
  }
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("Ghostty terminal clipboard actions", () => {
  it("copies the Ghostty selection captured when the menu opens and excludes native edit actions", async () => {
    const fixture = renderClipboard();
    const menu = await fixture.openMenu();

    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
    expect(within(menu).getByRole("menuitem", { name: "Copy" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Paste" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Inspect Element" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Select All" })).not.toBeInTheDocument();

    fixture.getSelection.mockReturnValue("selection changed after opening");
    act(() => fixture.terminal.selectionChanged());
    await fixture.user.click(within(menu).getByRole("menuitem", { name: "Copy" }));

    await waitFor(() => expect(fixture.writeText).toHaveBeenCalledExactlyOnceWith("selected terminal text"));
    expect(fixture.rendered.contextMenu.api.executeAction).not.toHaveBeenCalled();
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it("disables Copy with no Ghostty selection while leaving explicit Paste available", async () => {
    const fixture = renderClipboard({ selection: "" });
    const menu = await fixture.openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Copy" })).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Paste" })).not.toHaveAttribute("aria-disabled", "true");
    await fixture.user.click(within(menu).getByRole("menuitem", { name: "Paste" }));

    await waitFor(() => expect(fixture.paste).toHaveBeenCalledExactlyOnceWith("clipboard text"));
    expect(fixture.terminal.focus).toHaveBeenCalledOnce();
    expect(fixture.writeText).not.toHaveBeenCalled();
    expect(fixture.rendered.contextMenu.api.executeAction).not.toHaveBeenCalled();
  });

  it("refreshes a silently cleared Ghostty selection before offering Copy", async () => {
    const fixture = renderClipboard();
    fixture.getSelection.mockReturnValue("");

    const menu = await fixture.openMenu();
    const copy = within(menu).getByRole("menuitem", { name: "Copy" });
    expect(copy).toHaveAttribute("aria-disabled", "true");
    await fixture.user.click(copy);

    expect(fixture.writeText).not.toHaveBeenCalled();
    expect(fixture.rendered.contextMenu.api.executeAction).not.toHaveBeenCalled();
  });

  it("disables Paste after input closes without disabling a remaining selection", async () => {
    const fixture = renderClipboard({ canPaste: false });
    const menu = await fixture.openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Copy" })).not.toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByRole("menuitem", { name: "Paste" })).toHaveAttribute("aria-disabled", "true");
    expect(fixture.readText).not.toHaveBeenCalled();
  });

  it.each([
    ["MacIntel", { metaKey: true }],
    ["Win32", { ctrlKey: true, shiftKey: true }],
    ["Linux x86_64", { ctrlKey: true, shiftKey: true }],
  ])("routes only explicit copy/paste shortcuts on %s before Ghostty receives them", async (platform, modifiers) => {
    const fixture = renderClipboard({ platform });
    const terminalInput = vi.fn();
    fixture.host.addEventListener("keydown", terminalInput);

    const copyEvent = fixture.keyDown("c", modifiers);
    const pasteEvent = fixture.keyDown("v", modifiers);

    expect(copyEvent.defaultPrevented).toBe(true);
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(terminalInput).not.toHaveBeenCalled();
    await waitFor(() => expect(fixture.writeText).toHaveBeenCalledExactlyOnceWith("selected terminal text"));
    await waitFor(() => expect(fixture.paste).toHaveBeenCalledExactlyOnceWith("clipboard text"));

    const interruptEvent = fixture.keyDown("c", { ctrlKey: true });
    expect(interruptEvent.defaultPrevented).toBe(false);
    expect(terminalInput).toHaveBeenCalledExactlyOnceWith(interruptEvent);
    expect(fixture.readText).toHaveBeenCalledOnce();
    expect(fixture.writeText).toHaveBeenCalledOnce();
  });

  it("does not turn composition, extra modifiers, or repeated shortcuts into clipboard actions", () => {
    const fixture = renderClipboard();
    fixture.keyDown("v", { ctrlKey: true, shiftKey: true, isComposing: true });
    fixture.keyDown("v", { ctrlKey: true, shiftKey: true, altKey: true });
    fixture.keyDown("v", { ctrlKey: true, shiftKey: true, metaKey: true });
    fixture.keyDown("v", { ctrlKey: true, shiftKey: true, repeat: true });

    expect(fixture.readText).not.toHaveBeenCalled();
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it.each(["inert", "closed", "replaced", "input-disabled", "detached", "unmounted"] as const)(
    "discards a clipboard read when its terminal becomes %s",
    async (change) => {
      const fixture = renderClipboard();
      const pending = deferred<string>();
      fixture.readText.mockReturnValue(pending.promise);
      fixture.keyDown("v", { ctrlKey: true, shiftKey: true });
      expect(fixture.readText).toHaveBeenCalledOnce();

      if (change === "inert") fixture.update({ inert: true });
      if (change === "closed") fixture.update({ terminal: undefined });
      if (change === "replaced") fixture.update({ terminal: fakeTerminal().value });
      if (change === "input-disabled") fixture.update({ canPaste: false });
      if (change === "detached") fixture.host.remove();
      if (change === "unmounted") fixture.rendered.unmount();
      await act(async () => pending.resolve("must stay with the original terminal"));

      expect(fixture.paste).not.toHaveBeenCalled();
      expect(fixture.terminal.focus).not.toHaveBeenCalled();
      expect(toastMocks.danger).not.toHaveBeenCalled();
    },
  );

  it("does not read the clipboard without active operator activation", async () => {
    const fixture = renderClipboard();
    Object.defineProperty(navigator, "userActivation", {
      configurable: true,
      value: { isActive: false },
    });

    fixture.keyDown("v", { ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(toastMocks.danger).toHaveBeenCalledOnce());
    expect(fixture.readText).not.toHaveBeenCalled();
    expect(fixture.paste).not.toHaveBeenCalled();
    expect(fixture.terminal.dispose).not.toHaveBeenCalled();
  });

  it.each(["copy", "paste"] as const)("contains an unavailable %s clipboard API without closing the terminal", async (action) => {
    const fixture = renderClipboard();
    Reflect.deleteProperty(navigator, "clipboard");

    fixture.keyDown(action === "copy" ? "c" : "v", { ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(toastMocks.danger).toHaveBeenCalledOnce());
    expect(fixture.paste).not.toHaveBeenCalled();
    expect(fixture.terminal.dispose).not.toHaveBeenCalled();
    expect(fixture.host).toBeInTheDocument();
  });

  it.each(["copy", "paste"] as const)("contains a rejected %s clipboard operation and allows a later retry", async (action) => {
    const fixture = renderClipboard();
    const operation = action === "copy" ? fixture.writeText : fixture.readText;
    operation.mockRejectedValueOnce(new Error("clipboard denied"));
    const key = action === "copy" ? "c" : "v";

    fixture.keyDown(key, { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(toastMocks.danger).toHaveBeenCalledOnce());
    expect(fixture.paste).not.toHaveBeenCalled();
    expect(fixture.terminal.dispose).not.toHaveBeenCalled();

    fixture.keyDown(key, { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    if (action === "paste") {
      await waitFor(() => expect(fixture.paste).toHaveBeenCalledExactlyOnceWith("clipboard text"));
    }
    expect(toastMocks.danger).toHaveBeenCalledOnce();
  });

  it("keeps clipboard actions live under React StrictMode", async () => {
    const fixture = renderClipboard({ strict: true });

    fixture.keyDown("v", { ctrlKey: true, shiftKey: true });

    await waitFor(() => expect(fixture.paste).toHaveBeenCalledExactlyOnceWith("clipboard text"));
    expect(fixture.readText).toHaveBeenCalledOnce();
  });
});

function fakeTerminal() {
  let onSelectionChange: (() => void) | undefined;
  const terminal = {
    focus: vi.fn(),
    dispose: vi.fn(),
    onSelectionChange: vi.fn((listener: () => void) => {
      onSelectionChange = listener;
      return { dispose: vi.fn(() => {
        if (onSelectionChange === listener) onSelectionChange = undefined;
      }) };
    }),
  };
  return {
    ...terminal,
    value: terminal as unknown as Terminal,
    selectionChanged: () => onSelectionChange?.(),
  };
}

function renderClipboard(options: { selection?: string; canPaste?: boolean; platform?: string; strict?: boolean } = {}) {
  const user = userEvent.setup();
  const readText = vi.fn(async () => "clipboard text");
  const writeText = vi.fn(async (_text: string) => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { readText, writeText } });
  Object.defineProperty(navigator, "userActivation", { configurable: true, value: { isActive: true } });
  Object.defineProperty(navigator, "platform", { configurable: true, value: options.platform ?? "Linux x86_64" });
  const hostRef = createRef<HTMLDivElement>();
  const terminal = fakeTerminal();
  const getSelection = vi.fn(() => options.selection ?? "selected terminal text");
  const paste = vi.fn();
  let state: { terminal: Terminal | undefined; canPaste: boolean; inert: boolean } = {
    terminal: terminal.value,
    canPaste: options.canPaste ?? true,
    inert: false,
  };
  const content = () => {
    const scope = (
      <section inert={state.inert}>
        <GhosttyTerminalClipboard
          terminal={state.terminal}
          hostRef={hostRef}
          canPaste={state.canPaste}
          getSelection={getSelection}
          paste={paste}
        >
          <div ref={hostRef} tabIndex={0} aria-label="Terminal canvas" />
        </GhosttyTerminalClipboard>
      </section>
    );
    return options.strict ? <StrictMode>{scope}</StrictMode> : scope;
  };
  const rendered = renderWithApplicationContextMenu(content());
  const host = hostRef.current!;
  return {
    user,
    rendered,
    host,
    terminal,
    getSelection,
    paste,
    readText,
    writeText,
    update: (next: Partial<typeof state>) => {
      state = { ...state, ...next };
      rendered.rerender(content());
    },
    keyDown: (key: string, modifiers: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
      fireEvent(host, event);
      return event;
    },
    openMenu: async () => {
      fireEvent.contextMenu(host, { clientX: 40, clientY: 24 });
      rendered.contextMenu.emit(nativeItems());
      return screen.findByRole("menu", { name: "Application context menu" });
    },
  };
}

function nativeItems(): readonly ApplicationContextMenuItem[] {
  return [
    { type: "action", actionId: "10000000-0000-4000-8000-000000000001", kind: "copy", label: "Copy", enabled: true },
    { type: "action", actionId: "10000000-0000-4000-8000-000000000002", kind: "paste", label: "Paste", enabled: true },
    { type: "action", actionId: "10000000-0000-4000-8000-000000000003", kind: "select-all", label: "Select All", enabled: true },
    { type: "action", actionId: "10000000-0000-4000-8000-000000000004", kind: "inspect", label: "Inspect Element", enabled: true },
  ];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
