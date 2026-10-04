import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../../shared/application-settings-contracts";
import type { GhosttySettingsAPI, GhosttySettingsSnapshot } from "../../../shared/ghostty-settings-contracts";
import { ApplicationSettingsProvider } from "./ApplicationSettingsProvider";
import { GhosttyThemeSettings } from "./GhosttyThemeSettings";

const snapshot: GhosttySettingsSnapshot = {
  configPath: "/home/test/.sliver-client/gui/ghostty/config",
  themesDirectory: "/home/test/.sliver-client/gui/ghostty/themes",
  theme: "",
  themes: [{ name: "Nord", path: "/home/test/.config/ghostty/themes/Nord" }],
  light: { palette: {} },
  dark: { palette: {} },
  diagnostics: [],
  revision: 1,
  nativeTerminalTransparency: true,
};

beforeEach(() => {
  window.localStorage.clear();
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
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(window, "ghosttySettings");
});

describe("GhosttyThemeSettings", () => {
  it("shows installed and custom selections and saves theme changes immediately", async () => {
    const user = userEvent.setup();
    const custom = { ...snapshot, theme: "light:Day,dark:Night" };
    const bridge = installBridge(custom);
    renderSettings();
    await screen.findByText(custom.configPath);

    await user.click(screen.getByRole("button", { name: /Terminal theme/u }));
    expect(screen.getByRole("option", { name: custom.theme })).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Nord" }));
    await waitFor(() => expect(bridge.setTheme).toHaveBeenCalledWith("Nord"));
    await waitFor(() => expect(screen.getByRole("button", { name: /Terminal theme/u })).toHaveTextContent("Nord"));

    await user.click(screen.getByRole("button", { name: /Terminal theme/u }));
    await user.click(screen.getByRole("option", { name: "Application default" }));
    await waitFor(() => expect(bridge.setTheme).toHaveBeenLastCalledWith(""));
  });

  it("opens the managed config editor and reloads the preview and visible diagnostics", async () => {
    const user = userEvent.setup();
    const bridge = installBridge(snapshot);
    const reloaded: GhosttySettingsSnapshot = {
      ...snapshot,
      revision: 2,
      dark: { foreground: "#e0e1e2", background: "#112233", palette: {} },
      diagnostics: [{ source: snapshot.configPath, line: 4, severity: "warning", message: "This color option is unavailable in the web renderer." }],
    };
    bridge.reloadConfig.mockResolvedValue(reloaded);
    renderSettings();
    await screen.findByText(snapshot.configPath);

    await user.click(screen.getByRole("button", { name: "Edit Ghostty config" }));
    expect(bridge.editConfig).toHaveBeenCalledExactlyOnceWith();
    await user.click(screen.getByRole("button", { name: "Reload themes" }));
    expect(bridge.reloadConfig).toHaveBeenCalledExactlyOnceWith();
    await screen.findByText(reloaded.diagnostics[0]!.message);
    expect(screen.getByRole("img", { name: "Terminal theme preview" })).toHaveStyle({ backgroundColor: "#112233", color: "#e0e1e2" });
    expect(screen.getByText(`${snapshot.configPath}:4`)).toBeInTheDocument();
  });

  it("keeps the current theme selected and explains a rejected save", async () => {
    const user = userEvent.setup();
    const bridge = installBridge(snapshot);
    bridge.setTheme.mockResolvedValue({ ok: false, error: "The config could not be written." });
    renderSettings();
    await screen.findByText(snapshot.configPath);

    await user.click(screen.getByRole("button", { name: /Terminal theme/u }));
    await user.click(screen.getByRole("option", { name: "Nord" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The config could not be written.");
    expect(screen.getByRole("button", { name: /Terminal theme/u })).toHaveTextContent("Application default");
  });

  it("updates the selected theme when a config edit is broadcast", async () => {
    const bridge = installBridge(snapshot);
    renderSettings();
    await screen.findByText(snapshot.configPath);
    act(() => bridge.emit({ ...snapshot, revision: 2, theme: "Nord" }));
    expect(screen.getByRole("button", { name: /Terminal theme/u })).toHaveTextContent("Nord");
    expect(bridge.setTheme).not.toHaveBeenCalled();
  });
});

function renderSettings(): void {
  const api = {
    getApplicationSettings: async () => ({ ...DEFAULT_APPLICATION_SETTINGS_STATE, theme: "dark" as const }),
    onApplicationSettingsChanged: () => () => undefined,
  };
  render(<ApplicationSettingsProvider api={api}><GhosttyThemeSettings /></ApplicationSettingsProvider>);
}

function installBridge(initial: GhosttySettingsSnapshot) {
  let listener: ((state: GhosttySettingsSnapshot) => void) | undefined;
  let revision = initial.revision;
  const bridge = {
    getConfig: vi.fn(async () => initial),
    reloadConfig: vi.fn(async () => initial),
    editConfig: vi.fn(async () => ({ ok: true as const })),
    setTheme: vi.fn<GhosttySettingsAPI["setTheme"]>(async (theme) => ({ ok: true, value: { ...initial, revision: ++revision, theme } })),
    onChanged: vi.fn((next: (state: GhosttySettingsSnapshot) => void) => {
      listener = next;
      return () => { listener = undefined; };
    }),
    emit: (state: GhosttySettingsSnapshot) => listener?.(state),
  };
  Object.defineProperty(window, "ghosttySettings", { configurable: true, value: bridge });
  return bridge;
}
