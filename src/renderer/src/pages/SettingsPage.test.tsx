import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("switch", { name: "Reduce motion" })).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Terminal" }));

    expect(screen.getByRole("heading", { name: "Terminal Appearance" })).toBeInTheDocument();
    expect(screen.getByText("Applied to every console and managed shell window.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Font size" })).toHaveValue("13");
    expect(screen.getByRole("button", { name: "Reset defaults" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("applies app-wide theme and motion choices directly", async () => {
    const user = userEvent.setup();
    const onThemeChange = vi.fn();
    const onReduceMotionChange = vi.fn();
    renderSettings({ onThemeChange, onReduceMotionChange });

    const system = screen.getByRole("radio", { name: "System" });
    expect(system).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Light" }));
    await user.click(screen.getByRole("switch", { name: "Reduce motion" }));

    expect(onThemeChange).toHaveBeenCalledExactlyOnceWith("light");
    expect(onReduceMotionChange).toHaveBeenCalledExactlyOnceWith(true);
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
    onThemeChange: vi.fn(),
    onReduceMotionChange: vi.fn(),
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
