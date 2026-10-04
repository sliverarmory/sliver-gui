import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";

import {
  navigationDirectionFromKeyboardEvent,
  navigationShortcuts,
  useNavigationShortcuts,
} from "./navigation-shortcuts";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("navigation shortcuts", () => {
  it("uses configured shortcuts and stops handling their old chords", () => {
    const settings = { ...DEFAULT_APPLICATION_SETTINGS_STATE, keyboardShortcuts: { navigateBack: "mod+shift+b", navigateForward: "mod+shift+f" } };
    expect(navigationShortcuts(false, settings).back).toEqual({ shortcut: "mod+shift+b", ariaKeyShortcuts: "Control+Shift+B" });
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "b", ctrlKey: true, shiftKey: true }), false, settings)).toBe("back");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "f", ctrlKey: true, shiftKey: true }), false, settings)).toBe("forward");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "ArrowLeft", altKey: true }), false, settings)).toBeUndefined();
  });
  it("uses Command brackets on Apple platforms and Alt arrows elsewhere", () => {
    expect(navigationShortcuts(true)).toEqual({
      back: { shortcut: "mod+[", ariaKeyShortcuts: "Meta+[" },
      forward: { shortcut: "mod+]", ariaKeyShortcuts: "Meta+]" },
    });
    expect(navigationShortcuts(false)).toEqual({
      back: { shortcut: "alt+arrowleft", ariaKeyShortcuts: "Alt+ArrowLeft" },
      forward: { shortcut: "alt+arrowright", ariaKeyShortcuts: "Alt+ArrowRight" },
    });
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), true)).toBe("back");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "]", metaKey: true }), true)).toBe("forward");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "ArrowLeft", altKey: true }), false)).toBe("back");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "ArrowRight", altKey: true }), false)).toBe("forward");
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "ArrowLeft", altKey: true }), true)).toBeUndefined();
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), false)).toBeUndefined();
  });

  it.each([
    { repeat: true },
    { isComposing: true },
    { defaultPrevented: true },
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: false },
  ])("ignores handled, repeated, composing, and extra-modifier events: %j", (overrides) => {
    expect(navigationDirectionFromKeyboardEvent({
      ...keyEvent({ key: "[", metaKey: true }),
      ...overrides,
    }, true)).toBeUndefined();
  });

  it.each([
    '<input aria-label="Editable" />',
    '<textarea aria-label="Editable"></textarea>',
    '<select aria-label="Editable"></select>',
    '<div contenteditable="true"><span>Editable</span></div>',
    '<div role="textbox"><span>Editable</span></div>',
    '<div data-terminal-state="ready"><canvas></canvas></div>',
    '<button data-command-palette-shortcut-recorder="true">Record</button>',
  ])("leaves input contexts alone: %s", (markup) => {
    document.body.innerHTML = markup;
    const target = document.body.firstElementChild!.lastElementChild ?? document.body.firstElementChild!;
    expect(navigationDirectionFromKeyboardEvent({
      ...keyEvent({ key: "[", metaKey: true }), target,
    }, true)).toBeUndefined();
  });

  it("also checks the focused input when the event is retargeted", () => {
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    expect(navigationDirectionFromKeyboardEvent({
      ...keyEvent({ key: "[", metaKey: true }), target: document.body,
    }, true)).toBeUndefined();
  });

  it("preserves editable contexts through a shadow DOM event path", () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = document.createElement("input");
    shadow.append(input);
    document.body.append(host);
    expect(navigationDirectionFromKeyboardEvent({
      ...keyEvent({ key: "[", metaKey: true }), target: host,
      composedPath: () => [input, shadow, host, document.body, document, window],
    }, true)).toBeUndefined();
  });

  it.each(['role="dialog"', 'role="alertdialog"'])
    ("blocks navigation while a dialog is open: %s", (attributes) => {
      document.body.innerHTML = `<div ${attributes}><button>Confirm</button></div>`;
      expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), true)).toBeUndefined();
    });

  it.each(['hidden', 'aria-hidden="true"', 'inert', 'style="display:none"', 'style="visibility:hidden"'])
    ("ignores closed or hidden dialogs: %s", (attributes) => {
      document.body.innerHTML = `<div ${attributes}><div role="dialog"></div></div>`;
      expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), true)).toBe("back");
    });

  it("honors whether a native dialog is open", () => {
    const dialog = document.createElement("dialog");
    document.body.append(dialog);
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), true)).toBe("back");
    dialog.open = true;
    expect(navigationDirectionFromKeyboardEvent(keyEvent({ key: "[", metaKey: true }), true)).toBeUndefined();
  });

  it("runs available history actions, consumes boundary gestures, and removes its listener", () => {
    const goBack = vi.fn();
    const goForward = vi.fn();
    const view = renderHook((options) => useNavigationShortcuts(options), {
      initialProps: { canGoBack: true, canGoForward: false, goBack, goForward, isDisabled: false },
    });

    expect(dispatchNavigation("back").defaultPrevented).toBe(true);
    expect(goBack).toHaveBeenCalledOnce();
    expect(dispatchNavigation("forward").defaultPrevented).toBe(true);
    expect(goForward).not.toHaveBeenCalled();

    view.rerender({ canGoBack: false, canGoForward: true, goBack, goForward, isDisabled: false });
    dispatchNavigation("forward");
    expect(goForward).toHaveBeenCalledOnce();

    view.rerender({ canGoBack: true, canGoForward: true, goBack, goForward, isDisabled: true });
    expect(dispatchNavigation("back").defaultPrevented).toBe(false);
    expect(goBack).toHaveBeenCalledOnce();

    view.unmount();
    expect(dispatchNavigation("forward").defaultPrevented).toBe(false);
    expect(goForward).toHaveBeenCalledOnce();
  });
});

function keyEvent(overrides: Partial<KeyboardEvent> = {}) {
  return { altKey: false, ctrlKey: false, key: "", metaKey: false, shiftKey: false, ...overrides };
}

function dispatchNavigation(direction: "back" | "forward"): KeyboardEvent {
  const shortcut = navigationShortcuts()[direction].shortcut;
  const apple = shortcut.startsWith("mod+");
  const event = new KeyboardEvent("keydown", {
    key: shortcut.split("+")[1]!,
    metaKey: apple,
    altKey: !apple,
    cancelable: true,
    bubbles: true,
  });
  act(() => { document.body.dispatchEvent(event); });
  return event;
}
