import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useConsoleShortcut } from "./window-shortcuts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("console shortcut", () => {
  it("applies and resets live custom bindings without retaining the old chord", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    const view = renderHook(({ settings }) => useConsoleShortcut({ isEnabled: true, onOpenConsole, settings }), {
      initialProps: { settings: DEFAULT_APPLICATION_SETTINGS_STATE },
    });
    dispatchShortcut({ ctrlKey: true });
    expect(onOpenConsole).toHaveBeenCalledTimes(1);
    view.rerender({ settings: { ...DEFAULT_APPLICATION_SETTINGS_STATE, keyboardShortcuts: { openConsole: "mod+shift+o" } } });
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    dispatchShortcut({ key: "o", ctrlKey: true, shiftKey: true });
    expect(onOpenConsole).toHaveBeenCalledTimes(2);
    view.rerender({ settings: DEFAULT_APPLICATION_SETTINGS_STATE });
    expect(dispatchShortcut({ key: "o", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
    dispatchShortcut({ ctrlKey: true });
    expect(onOpenConsole).toHaveBeenCalledTimes(3);
  });
  it.each([
    ["MacIntel", { metaKey: true }, { ctrlKey: true }],
    ["Win32", { ctrlKey: true }, { metaKey: true }],
    ["Linux x86_64", { ctrlKey: true }, { metaKey: true }],
  ])("uses only the platform modifier on %s", (platform, expected, unsupported) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));

    expect(dispatchShortcut(expected).defaultPrevented).toBe(true);
    expect(onOpenConsole).toHaveBeenCalledOnce();
    expect(dispatchShortcut(unsupported).defaultPrevented).toBe(false);
    expect(dispatchShortcut({ metaKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onOpenConsole).toHaveBeenCalledOnce();
  });

  it.each([
    { repeat: true },
    { isComposing: true },
    { altKey: true },
    { shiftKey: true },
    { key: "n" },
    { ctrlKey: false },
  ])("ignores unsuitable key events: %j", (overrides) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));
    expect(dispatchShortcut({ ctrlKey: true, ...overrides }).defaultPrevented).toBe(false);
    expect(onOpenConsole).not.toHaveBeenCalled();
  });

  it("respects an event already handled by another control", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));
    const event = new KeyboardEvent("keydown", { key: "t", ctrlKey: true, cancelable: true, bubbles: true });
    event.preventDefault();
    act(() => { document.body.dispatchEvent(event); });
    expect(onOpenConsole).not.toHaveBeenCalled();
  });

  it.each([
    "<input />",
    "<textarea></textarea>",
    "<select></select>",
    '<div contenteditable="true"><span>Editable</span></div>',
    '<div role="textbox"><span>Editable</span></div>',
    '<div data-terminal-state="ready"><canvas></canvas></div>',
    '<button data-command-palette-shortcut-recorder="true">Record</button>',
  ])("preserves editable, terminal, and recorder events: %s", (markup) => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));
    const fixture = document.createElement("div");
    fixture.innerHTML = markup;
    document.body.append(fixture);
    const target = fixture.firstElementChild!.lastElementChild ?? fixture.firstElementChild!;
    expect(dispatchShortcut({ ctrlKey: true }, target).defaultPrevented).toBe(false);
    expect(onOpenConsole).not.toHaveBeenCalled();
  });

  it("preserves focused input and shadow DOM input contexts", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    input.remove();

    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.append(input);
    document.body.append(host);
    expect(dispatchShortcut({ ctrlKey: true, composed: true }, input).defaultPrevented).toBe(false);
    expect(onOpenConsole).not.toHaveBeenCalled();
  });

  it("blocks active dialogs and allows hidden dialogs", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onOpenConsole = vi.fn();
    renderHook(() => useConsoleShortcut({ isEnabled: true, onOpenConsole }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(onOpenConsole).not.toHaveBeenCalled();
    dialog.hidden = true;
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(true);
    expect(onOpenConsole).toHaveBeenCalledOnce();
  });

  it("adopts changed callbacks, disables handling, and removes its listener", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const initialCallback = vi.fn();
    const nextCallback = vi.fn();
    const view = renderHook((options) => useConsoleShortcut(options), {
      initialProps: { isEnabled: false, onOpenConsole: initialCallback },
    });
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    view.rerender({ isEnabled: true, onOpenConsole: initialCallback });
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(true);
    expect(initialCallback).toHaveBeenCalledOnce();
    view.rerender({ isEnabled: true, onOpenConsole: nextCallback });
    dispatchShortcut({ ctrlKey: true });
    expect(initialCallback).toHaveBeenCalledOnce();
    expect(nextCallback).toHaveBeenCalledOnce();
    view.rerender({ isEnabled: false, onOpenConsole: nextCallback });
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    view.rerender({ isEnabled: true, onOpenConsole: nextCallback });
    view.unmount();
    expect(dispatchShortcut({ ctrlKey: true }).defaultPrevented).toBe(false);
    expect(nextCallback).toHaveBeenCalledOnce();
  });
});

function dispatchShortcut(overrides: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: "t", cancelable: true, bubbles: true, ...overrides });
  act(() => { target.dispatchEvent(event); });
  return event;
}
