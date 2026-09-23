import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import { KeyboardShortcutsSettings, type KeyboardShortcutsSettingsProps } from "./KeyboardShortcutsSettings";

const setKeyboardShortcutRecording = vi.fn<(recording: boolean) => Promise<void>>();

beforeEach(() => {
  setKeyboardShortcutRecording.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: { setKeyboardShortcutRecording },
  });
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "sliver");
  Reflect.deleteProperty(navigator, "platform");
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

describe("KeyboardShortcutsSettings", () => {
  it("groups the current bindings and disables reset when defaults are active", () => {
    renderShortcuts();

    for (const group of ["Application", "Navigation", "Text Editor", "Terminal", "Terminal tabs"]) {
      expect(screen.getByRole("heading", { name: group })).toBeInTheDocument();
    }
    expect(screen.getAllByRole("button", { name: /^Change shortcut for /u })).toHaveLength(31);
    expect(screen.getByRole("button", { name: "Reset all to defaults" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset shortcut for New window" })).toBeDisabled();
    expect(within(screen.getByRole("group", { name: "New window" })).getByLabelText("Command + N"))
      .toBeInTheDocument();
  });

  it.each([
    { query: "New window for this server", labels: ["New window for this server"] },
    { query: "Navigation", labels: ["Go back", "Go forward", "Refresh server"] },
    { query: "command + shift + n", labels: ["New window for this server"] },
    { query: "mod+shift+n", labels: ["New window for this server"] },
    { query: "Monaco editor commands", labels: ["Open editor command palette"] },
  ])("filters by label, functionality, or shortcut: $query", async ({ query, labels }) => {
    const user = userEvent.setup();
    renderShortcuts();
    await user.type(screen.getByRole("searchbox", { name: "Search shortcuts" }), query);

    expect(screen.getAllByRole("button", { name: /^Change shortcut for /u })).toHaveLength(labels.length);
    for (const label of labels) expect(screen.getByRole("group", { name: label })).toBeInTheDocument();
  });

  it("shows an empty search state and restores the list when the query is cleared", async () => {
    const user = userEvent.setup();
    renderShortcuts();
    const search = screen.getByRole("searchbox", { name: "Search shortcuts" });
    await user.type(search, "no-such-shortcut");
    expect(screen.getByRole("status")).toHaveTextContent("No shortcuts match your search.");
    expect(screen.queryByRole("button", { name: /^Change shortcut for /u })).not.toBeInTheDocument();
    await user.clear(search);
    expect(screen.queryByText("No shortcuts match your search.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change shortcut for Open command palette" })).toBeInTheDocument();
  });

  it("waits for native shortcut suppression before recording and restores it after a successful change", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    setKeyboardShortcutRecording.mockImplementationOnce(() => pending.promise);
    const { onShortcutChange } = renderShortcuts();
    await user.click(changeButton());
    expect(changeButton()).toHaveTextContent("Preparing…");
    expect(setKeyboardShortcutRecording).toHaveBeenCalledExactlyOnceWith(true);
    fireEvent.keyDown(changeButton(), { key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(onShortcutChange).not.toHaveBeenCalled();

    await act(async () => pending.resolve());
    const recording = screen.getByRole("button", { name: "Cancel changing shortcut for Open command palette" });
    expect(recording).toHaveAttribute("data-command-palette-shortcut-recorder", "true");
    const event = new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, key: "P", code: "KeyP", metaKey: true, shiftKey: true,
    });
    act(() => expect(recording.dispatchEvent(event)).toBe(false));

    expect(onShortcutChange).toHaveBeenCalledExactlyOnceWith("commandPalette", "mod+shift+p");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);
    expect(changeButton()).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps recording after a conflicting binding and saves only a conflict-free replacement", async () => {
    const user = userEvent.setup();
    const { onShortcutChange } = renderShortcuts();
    await user.click(changeButton());
    const recording = screen.getByRole("button", { name: "Cancel changing shortcut for Open command palette" });
    fireEvent.keyDown(recording, { key: "n", code: "KeyN", metaKey: true });

    expect(screen.getByRole("alert")).toHaveTextContent("This shortcut is already assigned to New window.");
    expect(onShortcutChange).not.toHaveBeenCalled();
    expect(recording).toHaveAttribute("aria-pressed", "true");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(recording, { key: "P", code: "KeyP", metaKey: true, shiftKey: true });
    expect(onShortcutChange).toHaveBeenCalledExactlyOnceWith("commandPalette", "mod+shift+p");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects plain keys and reserved editing shortcuts without persisting them", async () => {
    const user = userEvent.setup();
    const { onShortcutChange } = renderShortcuts();
    await user.click(changeButton());
    const recording = screen.getByRole("button", { name: "Cancel changing shortcut for Open command palette" });
    fireEvent.keyDown(recording, { key: "p", code: "KeyP" });
    expect(screen.getByRole("alert")).toHaveTextContent("Use a modifier");
    fireEvent.keyDown(recording, { key: "c", code: "KeyC", metaKey: true });
    expect(screen.getByRole("alert")).toHaveTextContent("reserved for standard system or editing commands");
    expect(onShortcutChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(changeButton()).toHaveAttribute("aria-pressed", "false");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);
  });

  it("releases native suppression on focus loss and unmount", async () => {
    const user = userEvent.setup();
    const { onShortcutChange, unmount } = renderShortcuts();
    await user.click(changeButton());
    fireEvent.blur(window);
    expect(changeButton()).toHaveAttribute("aria-pressed", "false");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);

    await user.click(changeButton());
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(true);
    unmount();
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);
    expect(onShortcutChange).not.toHaveBeenCalled();
  });

  it("resets one changed binding or all bindings through the appropriate callback", async () => {
    const user = userEvent.setup();
    const { onShortcutChange, onReset } = renderShortcuts({
      settings: { ...DEFAULT_APPLICATION_SETTINGS_STATE, keyboardShortcuts: { newWindow: "mod+shift+j" } },
    });
    await user.click(screen.getByRole("button", { name: "Reset shortcut for New window" }));
    expect(onShortcutChange).toHaveBeenCalledExactlyOnceWith("newWindow", undefined);
    expect(onReset).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset all to defaults" }));
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("reports a conflicting individual reset while allowing all bindings to reset together", async () => {
    const user = userEvent.setup();
    const { onShortcutChange, onReset } = renderShortcuts({
      settings: {
        ...DEFAULT_APPLICATION_SETTINGS_STATE,
        commandPaletteShortcut: "mod+n",
        keyboardShortcuts: { newWindow: "mod+shift+j" },
      },
    });
    await user.click(screen.getByRole("button", { name: "Reset shortcut for New window" }));
    expect(screen.getByRole("alert")).toHaveTextContent("already assigned to Open command palette");
    expect(onShortcutChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reset all to defaults" }));
    expect(onReset).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a native recording failure and allows retrying", async () => {
    const user = userEvent.setup();
    setKeyboardShortcutRecording.mockRejectedValueOnce(new Error("Unavailable"));
    const { onShortcutChange } = renderShortcuts();
    await user.click(changeButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not start recording. Try again.");
    expect(changeButton()).toHaveAttribute("aria-pressed", "false");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);
    expect(onShortcutChange).not.toHaveBeenCalled();
    await user.click(changeButton());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel changing shortcut for Open command palette" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("does not activate a delayed recording request after focus has moved away", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    setKeyboardShortcutRecording.mockImplementationOnce(() => pending.promise);
    renderShortcuts();
    await user.click(changeButton());
    await user.click(screen.getByRole("searchbox", { name: "Search shortcuts" }));
    await act(async () => pending.resolve());
    expect(changeButton()).toHaveAttribute("aria-pressed", "false");
    expect(setKeyboardShortcutRecording).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText("Press a new shortcut, or Escape to cancel.")).not.toBeInTheDocument();
  });

  it("disables modifications during persistence while keeping search available", async () => {
    const user = userEvent.setup();
    const { onShortcutChange, onReset } = renderShortcuts({
      isSaving: true,
      settings: { ...DEFAULT_APPLICATION_SETTINGS_STATE, keyboardShortcuts: { newWindow: "mod+shift+j" } },
    });
    expect(changeButton()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset shortcut for New window" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset all to defaults" })).toBeDisabled();
    await user.type(screen.getByRole("searchbox", { name: "Search shortcuts" }), "Navigation");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Change shortcut for /u })).toHaveLength(3));
    expect(onShortcutChange).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});

function changeButton() {
  return screen.getByRole("button", { name: "Change shortcut for Open command palette" });
}

function renderShortcuts(overrides: Partial<KeyboardShortcutsSettingsProps> = {}) {
  const props: KeyboardShortcutsSettingsProps = {
    settings: DEFAULT_APPLICATION_SETTINGS_STATE,
    isSaving: false,
    onShortcutChange: vi.fn(),
    onReset: vi.fn(),
    ...overrides,
  };
  return { ...render(<KeyboardShortcutsSettings {...props} />), ...props };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}
