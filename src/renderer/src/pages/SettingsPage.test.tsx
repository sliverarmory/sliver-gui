import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../../../shared/application-settings-contracts";
import {
  DEFAULT_CONSOLE_TERMINAL_SETTINGS,
  type ConsoleTerminalSettings,
} from "../components/console-terminal-settings";
import { SettingsPage, type SettingsPageProps } from "./SettingsPage";

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

afterEach(() => {
  cleanup();
});

describe("SettingsPage", () => {
  it("presents a concise General and Terminal hierarchy with app-wide copy", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Appearance" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Accessibility" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Color theme" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "App icon" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Reduce motion" })).toBeInTheDocument();

    const shortcutsTab = screen.getByRole("tab", { name: "Keyboard Shortcuts" });
    expect(shortcutsTab).toHaveClass("w-auto", "shrink-0", "whitespace-nowrap");
    await user.click(shortcutsTab);

    expect(screen.getByRole("heading", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change shortcut for Open command palette" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search shortcuts" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset all to defaults" })).toBeDisabled();
    expect(screen.getByLabelText(/(?:Command|Ctrl) \+ K/u)).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Terminal" }));

    expect(screen.getByRole("heading", { name: "Terminal Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Applied to every console and managed shell window.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Font size" })).toHaveValue("13");
    expect(screen.getByRole("button", { name: "Reset defaults" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("records the app-wide command palette shortcut from Keyboard Shortcuts settings", async () => {
    const user = userEvent.setup();
    const onKeyboardShortcutChange = vi.fn();
    renderSettings({ onKeyboardShortcutChange });
    await user.click(screen.getByRole("tab", { name: "Keyboard Shortcuts" }));

    await user.click(screen.getByRole("button", { name: "Change shortcut for Open command palette" }));
    await user.keyboard("{Control>}{Shift>}p{/Shift}{/Control}");

    expect(onKeyboardShortcutChange).toHaveBeenCalledExactlyOnceWith("commandPalette", "mod+shift+p");
  });

  it("applies app-wide theme and motion choices directly", async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    const onReduceMotionChange = vi.fn();
    renderSettings({ onThemeChange, onReduceMotionChange });

    const system = screen.getByRole("radio", { name: "System" });
    expect(system).toHaveAttribute("aria-checked", "true");

    await user.click(within(screen.getByRole("radiogroup", { name: "Color theme" }))
      .getByRole("radio", { name: "Light" }));
    await user.click(screen.getByRole("switch", { name: "Reduce motion" }));

    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith("light");
    expect(onReduceMotionChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["Light", "Dark", "Passion"])("selects the %s app icon independently of the color theme", async (label) => {
    const user = userEvent.setup();
    const onAppIconChange = vi.fn();
    const onThemeChange = vi.fn();
    renderSettings({
      settings: { ...DEFAULT_APPLICATION_SETTINGS_STATE, theme: "light" },
      onAppIconChange,
      onThemeChange,
    });

    const icons = within(screen.getByRole("radiogroup", { name: "App icon" }));
    expect(icons.getByRole("radio", { name: "Auto" })).toHaveAttribute("aria-checked", "true");
    await user.click(icons.getByRole("radio", { name: label }));

    expect(onAppIconChange).toHaveBeenCalledExactlyOnceWith(label.toLowerCase());
    expect(onThemeChange).not.toHaveBeenCalled();
  });

  it("returns to Auto from a manually selected icon and disables changes while saving", async () => {
    const user = userEvent.setup();
    const onAppIconChange = vi.fn();
    const props = settingsProps({
      settings: { ...DEFAULT_APPLICATION_SETTINGS_STATE, appIcon: "passion" },
      onAppIconChange,
    });
    const { rerender } = render(<SettingsPage {...props} />);

    const icons = within(screen.getByRole("radiogroup", { name: "App icon" }));
    expect(icons.getByRole("radio", { name: "Passion" })).toHaveAttribute("aria-checked", "true");
    await user.click(icons.getByRole("radio", { name: "Auto" }));
    expect(onAppIconChange).toHaveBeenCalledExactlyOnceWith("auto");

    rerender(<SettingsPage {...props} isSaving />);
    for (const radio of icons.getAllByRole("radio")) expect(radio).toBeDisabled();
  });

  it("keeps terminal edits local until Save", async () => {
    const user = userEvent.setup();
    const onTerminalChange = vi.fn();
    renderSettings({ onTerminalChange });
    await user.click(screen.getByRole("tab", { name: "Terminal" }));

    await user.click(screen.getByRole("switch", { name: "Smooth scrolling" }));

    expect(onTerminalChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onTerminalChange).toHaveBeenCalledExactlyOnceWith({
      ...DEFAULT_CONSOLE_TERMINAL_SETTINGS,
      smoothScrolling: true,
    });
  });

  it("does not save an invalid terminal draft", async () => {
    const user = userEvent.setup();
    const onTerminalChange = vi.fn();
    renderSettings({
      settings: applicationSettings({ fontSize: 99 }),
      onTerminalChange,
    });
    await user.click(screen.getByRole("tab", { name: "Terminal" }));
    await user.click(screen.getByRole("switch", { name: "Smooth scrolling" }));

    expect(screen.getByRole("button", { name: "Discard" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(onTerminalChange).not.toHaveBeenCalled();
  });

  it("preserves a dirty terminal draft across external updates and discards to the latest value", async () => {
    const user = userEvent.setup();
    const initial = applicationSettings({ fontSize: 13 });
    const next = applicationSettings({ fontSize: 15 }, 2);
    const props = settingsProps({ settings: initial });
    const { rerender } = render(<SettingsPage {...props} />);
    await user.click(screen.getByRole("tab", { name: "Terminal" }));

    await user.click(screen.getByRole("switch", { name: "Blinking cursor" }));

    rerender(<SettingsPage {...props} settings={next} />);
    expect(screen.getByRole("textbox", { name: "Font size" })).toHaveValue("13");
    expect(screen.getByRole("switch", { name: "Blinking cursor" })).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("textbox", { name: "Font size" })).toHaveValue("15");
    expect(screen.getByRole("switch", { name: "Blinking cursor" })).toBeChecked();
  });

  it("resets a non-default terminal draft before saving it", async () => {
    const user = userEvent.setup();
    const onTerminalChange = vi.fn();
    renderSettings({
      settings: applicationSettings({
        fontId: "jetbrains-mono",
        fontSize: 18,
        cursorStyle: "bar",
        cursorBlink: false,
        smoothScrolling: true,
      }),
      onTerminalChange,
    });
    await user.click(screen.getByRole("tab", { name: "Terminal" }));

    await user.click(screen.getByRole("button", { name: "Reset defaults" }));
    expect(screen.getByRole("textbox", { name: "Font size" })).toHaveValue("13");
    expect(onTerminalChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onTerminalChange).toHaveBeenCalledExactlyOnceWith(DEFAULT_CONSOLE_TERMINAL_SETTINGS);
  });
});

function renderSettings(overrides: Partial<SettingsPageProps> = {}): void {
  render(<SettingsPage {...settingsProps(overrides)} />);
}

function settingsProps(overrides: Partial<SettingsPageProps> = {}): SettingsPageProps {
  return {
    settings: DEFAULT_APPLICATION_SETTINGS_STATE,
    onAppIconChange: vi.fn(),
    onThemeChange: vi.fn(),
    onReduceMotionChange: vi.fn(),
    onKeyboardShortcutChange: vi.fn(),
    onResetKeyboardShortcuts: vi.fn(),
    onTerminalChange: vi.fn(),
    ...overrides,
  };
}

function applicationSettings(
  terminal: Partial<ConsoleTerminalSettings>,
  revision = 1,
): ApplicationSettingsState {
  return {
    ...DEFAULT_APPLICATION_SETTINGS_STATE,
    revision,
    terminal: {
      ...DEFAULT_CONSOLE_TERMINAL_SETTINGS,
      ...terminal,
    },
  };
}
