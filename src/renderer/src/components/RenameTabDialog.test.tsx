import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  RenameTabDialog,
  TERMINAL_TAB_NAME_MAX_LENGTH,
  normalizeTerminalTabName,
} from "./RenameTabDialog";

beforeAll(() => {
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

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(() => cleanup());

describe("RenameTabDialog", () => {
  it("normalizes ordinary Unicode names and rejects empty, control, bidi, and oversized names", () => {
    expect(normalizeTerminalTabName("  Primary 🛰️  ")).toBe("Primary 🛰️");
    expect(normalizeTerminalTabName("Developer 👩‍💻")).toBe("Developer 👩‍💻");
    expect(normalizeTerminalTabName("   ")).toBeUndefined();
    expect(normalizeTerminalTabName("\u200b")).toBeUndefined();
    expect(normalizeTerminalTabName("left\u200eright")).toBeUndefined();
    expect(normalizeTerminalTabName("left\u200fright")).toBeUndefined();
    expect(normalizeTerminalTabName("left\u061cright")).toBeUndefined();
    expect(normalizeTerminalTabName("unsafe\nname")).toBeUndefined();
    expect(normalizeTerminalTabName("left\u202eright")).toBeUndefined();
    expect(normalizeTerminalTabName("x".repeat(TERMINAL_TAB_NAME_MAX_LENGTH + 1))).toBeUndefined();
  });

  it("submits a trimmed changed name with Enter and disables an unchanged name", async () => {
    const user = userEvent.setup();
    const onNameChange = vi.fn();
    const onRename = vi.fn();
    const rendered = render(
      <RenameTabDialog
        description="Only the tab label changes."
        isOpen
        name="Console 1"
        originalName="Console 1"
        onNameChange={onNameChange}
        onOpenChange={vi.fn()}
        onRename={onRename}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Rename tab" });
    expect(within(dialog).getByRole("button", { name: "Rename" })).toBeDisabled();

    rendered.rerender(
      <RenameTabDialog
        description="Only the tab label changes."
        isOpen
        name="  Primary  "
        originalName="Console 1"
        onNameChange={onNameChange}
        onOpenChange={vi.fn()}
        onRename={onRename}
      />,
    );
    await user.click(screen.getByRole("textbox", { name: "Tab name" }));
    await user.keyboard("{Enter}");
    expect(onRename).toHaveBeenCalledExactlyOnceWith("Primary");
  });

  it("associates visible validation feedback with an emptied or whitespace-only name", async () => {
    function ControlledDialog(): React.JSX.Element {
      const [name, setName] = useState("Console 1");
      return (
        <RenameTabDialog
          description="Only the tab label changes."
          isOpen
          name={name}
          originalName="Console 1"
          onNameChange={setName}
          onOpenChange={vi.fn()}
          onRename={vi.fn()}
        />
      );
    }

    const user = userEvent.setup();
    render(<ControlledDialog />);
    const input = screen.getByRole("textbox", { name: "Tab name" });
    await user.clear(input);

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(`Use 1–${TERMINAL_TAB_NAME_MAX_LENGTH} visible characters.`);
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();

    await user.type(input, "   ");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(`Use 1–${TERMINAL_TAB_NAME_MAX_LENGTH} visible characters.`);
  });
});
