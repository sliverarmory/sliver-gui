import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CommandPaletteShortcutRecorder,
  CommandPaletteShortcutKbd,
  commandPaletteShortcutFromKeyboardEvent,
  formatCommandPaletteShortcut,
} from "./CommandPaletteShortcut";

afterEach(() => {
  cleanup();
});

describe("command palette shortcuts", () => {
  it("captures and matches a portable modified shortcut", () => {
    const event = keyboardEvent({ ctrlKey: true, shiftKey: true, key: "P" });
    expect(commandPaletteShortcutFromKeyboardEvent(event)).toBe("mod+shift+p");
  });

  it("uses the physical key when Shift or Option changes the reported character", () => {
    expect(commandPaletteShortcutFromKeyboardEvent(keyboardEvent({
      code: "Digit1",
      ctrlKey: true,
      key: "!",
      shiftKey: true,
    }))).toBe("mod+shift+1");
    expect(commandPaletteShortcutFromKeyboardEvent(keyboardEvent({
      altKey: true,
      code: "KeyK",
      key: "˚",
      metaKey: true,
    }), true)).toBe("mod+alt+k");
  });

  it("requires a non-shift modifier and a supported action key", () => {
    expect(commandPaletteShortcutFromKeyboardEvent(keyboardEvent({ key: "k" }))).toBeUndefined();
    expect(commandPaletteShortcutFromKeyboardEvent(
      keyboardEvent({ key: "Shift", shiftKey: true }),
    )).toBeUndefined();
    expect(commandPaletteShortcutFromKeyboardEvent(
      keyboardEvent({ altKey: true, key: "F8" }),
    )).toBeUndefined();
    expect(commandPaletteShortcutFromKeyboardEvent(
      keyboardEvent({ ctrlKey: true, key: "n" }),
    )).toBeUndefined();
  });

  it("uses the exact platform primary modifier", () => {
    const commandK = keyboardEvent({ metaKey: true, key: "k" });
    const controlK = keyboardEvent({ ctrlKey: true, key: "k" });
    expect(commandPaletteShortcutFromKeyboardEvent(commandK, true)).toBe("mod+k");
    expect(commandPaletteShortcutFromKeyboardEvent(controlK, true)).toBeUndefined();
  });

  it("formats the primary modifier for Apple and non-Apple platforms", () => {
    expect(formatCommandPaletteShortcut("mod+alt+k", true)).toBe("Command + Option + K");
    expect(formatCommandPaletteShortcut("mod+alt+k", false)).toBe("Ctrl + Alt + K");
  });

  it("renders navigation arrow shortcuts with symbols and readable labels", () => {
    render(<CommandPaletteShortcutKbd shortcut="alt+ArrowLeft" />);
    expect(formatCommandPaletteShortcut("alt+ArrowLeft", false)).toBe("Alt + Left Arrow");
    expect(formatCommandPaletteShortcut("alt+ArrowRight", false)).toBe("Alt + Right Arrow");
    expect(screen.getByLabelText("Alt + Left Arrow")).toHaveTextContent("←");
    expect(screen.queryByText("ARROWLEFT")).not.toBeInTheDocument();
  });

  it("records, resets, and cancels without leaking the keystroke", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CommandPaletteShortcutRecorder shortcut="mod+f8" onChange={onChange} />);

    const change = screen.getByRole("button", { name: "Change shortcut" });
    await user.click(change);
    expect(screen.getByRole("button", { name: "Press shortcut…" })).toHaveAttribute("aria-pressed", "true");

    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");
    expect(onChange).toHaveBeenCalledExactlyOnceWith("mod+shift+p");

    await user.click(screen.getByRole("button", { name: "Change shortcut" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Change shortcut" })).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onChange).toHaveBeenLastCalledWith("mod+k");
  });
});

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: "k",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}
