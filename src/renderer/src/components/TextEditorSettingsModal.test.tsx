import { useState } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_TEXT_EDITOR_SETTINGS,
  TEXT_EDITOR_FONTS,
  type TextEditorSettingsValues,
} from "../../../shared/text-editor-settings-contracts";
import { TextEditorSettingsModal } from "./TextEditorSettingsModal";

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

afterEach(cleanup);

describe("TextEditorSettingsModal", () => {
  it("presents every editor setting and all bundled fonts", async () => {
    const user = userEvent.setup();
    render(<ControlledSettingsModal />);
    const dialog = screen.getByRole("dialog", { name: "Editor settings" });
    const settingsContent = dialog.querySelector(".modal__body");

    expect(settingsContent).toHaveClass("scroll-shadow", "scroll-shadow--vertical");
    expect(settingsContent).toHaveAttribute("data-scroll-shadow-size", "28");
    expect(within(dialog).getByText("Typography and indentation")).toBeInTheDocument();
    expect(within(dialog).getByText("Editor features")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Font size" })).toHaveValue("13");
    expect(within(dialog).getByRole("textbox", { name: "Tab size" })).toHaveValue("2");
    expect(within(dialog).getByRole("button", { name: /Line numbers/u })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /Visible whitespace/u })).toBeInTheDocument();
    for (const label of ["Minimap", "Word wrap", "Insert spaces", "Sticky scroll", "Bracket pair colors", "Font ligatures"]) {
      expect(within(dialog).getByRole("switch", { name: label })).toBeInTheDocument();
    }

    await user.click(within(dialog).getByRole("button", { name: /Font family/u }));
    const listbox = await screen.findByRole("listbox");
    for (const font of TEXT_EDITOR_FONTS) {
      expect(within(listbox).getByRole("option", { name: font.label })).toBeInTheDocument();
    }
  });

  it("reports controlled changes and supports reset, cancel, and save", async () => {
    const changed = vi.fn();
    const openChanged = vi.fn();
    const save = vi.fn();
    const user = userEvent.setup();
    const draft: TextEditorSettingsValues = {
      ...DEFAULT_TEXT_EDITOR_SETTINGS,
      fontId: "jetbrains-mono",
      fontSize: 18,
      minimap: false,
    };
    render(
      <TextEditorSettingsModal
        draft={draft}
        isOpen
        onDraftChange={changed}
        onOpenChange={openChanged}
        onSave={save}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Editor settings" });

    await user.click(within(dialog).getByRole("switch", { name: "Word wrap" }));
    expect(changed).toHaveBeenLastCalledWith({ ...draft, wordWrap: true });
    await user.click(within(dialog).getByRole("button", { name: "Reset defaults" }));
    expect(changed).toHaveBeenLastCalledWith({ ...DEFAULT_TEXT_EDITOR_SETTINGS });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(openChanged).toHaveBeenCalledWith(false);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledOnce();
  });

  it("shows save failures and locks every exit while saving", async () => {
    const openChanged = vi.fn();
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <TextEditorSettingsModal
        draft={{ ...DEFAULT_TEXT_EDITOR_SETTINGS, fontSize: 16 }}
        error="Editor settings could not be saved."
        isOpen
        isSaving
        onDraftChange={vi.fn()}
        onOpenChange={openChanged}
        onSave={save}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Editor settings could not be saved.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "Reset defaults" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(openChanged).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("prevents saving invalid numeric settings", () => {
    render(
      <TextEditorSettingsModal
        draft={{ ...DEFAULT_TEXT_EDITOR_SETTINGS, tabSize: 0 }}
        isOpen
        onDraftChange={vi.fn()}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Tab size" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

function ControlledSettingsModal(): React.JSX.Element {
  const [draft, setDraft] = useState<TextEditorSettingsValues>(DEFAULT_TEXT_EDITOR_SETTINGS);
  return (
    <TextEditorSettingsModal
      draft={draft}
      isOpen
      onDraftChange={setDraft}
      onOpenChange={vi.fn()}
      onSave={vi.fn()}
    />
  );
}
