import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OperationResult, SliverDesktopAPI } from "../../shared/contracts";
import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
} from "../../shared/application-settings-contracts";
import type {
  ConsoleTabCloseResult,
  ConsoleTabLaunchContext,
  ConsoleWindowLaunchContext,
} from "../../shared/console-contracts";
import type { TerminalRuntimeAsset } from "../../shared/stream-contracts";
import type { GhosttySettingsSnapshot } from "../../shared/ghostty-settings-contracts";
import type { GhosttyTerminalAppearance } from "./components/GhosttyTerminal";
import { CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY } from "./components/console-terminal-settings";
import { ApplicationSettingsProvider } from "./components/ApplicationSettingsProvider";
import { renderWithApplicationContextMenu } from "./application-context-menu-test-utils";

const openConsoleTransport = vi.fn();

vi.mock("./components/console-terminal-transport", () => ({
  ConsoleTerminalTransport: {
    open: (...args: unknown[]) => openConsoleTransport(...args),
  },
}));

vi.mock("./components/GhosttyTerminal", () => ({
  GhosttyTerminal: (props: {
    appearance?: GhosttyTerminalAppearance;
    ariaLabel: string;
    onClose?: (reason?: string) => void;
    onError?: (error: Error) => void;
  }) => (
    <section
      aria-label={props.ariaLabel}
      data-background-opacity={props.appearance?.theme?.backgroundOpacity ?? 1}
      data-cursor-blink={String(props.appearance?.cursorBlink)}
      data-cursor-style={props.appearance?.cursorStyle}
      data-font-family={props.appearance?.fontFamily}
      data-font-size={props.appearance?.fontSize}
      data-smooth-scroll-duration={props.appearance?.smoothScrollDuration}
      data-theme-background={props.appearance?.theme?.background}
      data-terminal-mock
    >
      <button type="button" onClick={() => props.onClose?.("Sliver client exited with code 7")}>Exit client</button>
      <button type="button" onClick={() => props.onError?.(new Error("Ghostty failed"))}>Fail terminal</button>
    </section>
  ),
}));

import {
  ConsoleWindowApp,
  resetConsoleWindowStateForTest,
} from "./ConsoleWindowApp";

const initialTab: ConsoleTabLaunchContext = {
  tabId: "a".repeat(43),
  attachmentToken: "t".repeat(43),
  label: "Console 1",
};
const secondTab: ConsoleTabLaunchContext = {
  tabId: "b".repeat(43),
  attachmentToken: "u".repeat(43),
  label: "Console 2",
};
const launchContext: ConsoleWindowLaunchContext = {
  kind: "console",
  configName: "Production operator",
  shortcutModifier: "Command",
  initialTab,
};

beforeEach(() => {
  resetConsoleWindowStateForTest();
  openConsoleTransport.mockReset();
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "ghosttySettings");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  window.localStorage.clear();
});

describe("ConsoleWindowApp", () => {
  it("claims the initial tab and renders its Fira Code terminal with accessible window actions", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const api = installAPI();

    renderWithApplicationContextMenu(
      <StrictMode>
        <ConsoleWindowApp />
      </StrictMode>,
    );

    expect(await screen.findByRole("main", { name: "Sliver client console window" })).toBeInTheDocument();
    const tabList = screen.getByRole("tablist", { name: "Sliver console tabs" });
    expect(tabList).toBeInTheDocument();
    const initialTabButton = screen.getByRole("tab", { name: /Console 1 Connected/u });
    expect(initialTabButton).toHaveAttribute("aria-selected", "true");
    expect(initialTabButton).toHaveAccessibleName("Console 1 Connected, shortcut Command+1");
    expect(initialTabButton).toHaveTextContent("⌘1");
    expect(screen.getByRole("button", { name: "Terminal settings" })).toBeInTheDocument();
    const terminal = screen.getByRole("region", {
      name: "Sliver client Console 1 using Production operator",
    });
    expect(terminal).toHaveAttribute("data-font-family", '"Fira Code", monospace');
    expect(terminal).toHaveAttribute("data-font-size", "13");
    expect(terminal).toHaveAttribute("data-smooth-scroll-duration", "0");

    const terminalSurface = screen.getByRole("region", { name: "Console terminal" });
    expect(terminalSurface).toContainElement(terminal);
    expect(screen.getByRole("main")).toHaveAttribute("data-transparent", "false");

    expect(api.claimConsoleWindow).toHaveBeenCalledOnce();
    expect(api.getTerminalRuntime).toHaveBeenCalledOnce();
    expect(openConsoleTransport).toHaveBeenCalledOnce();
    expect(openConsoleTransport).toHaveBeenCalledWith({ attachmentToken: initialTab.attachmentToken });
    expect(document.title).toBe("Sliver console — Production operator — Console 1");
  });

  it("applies app-wide terminal, theme, and reduced-motion changes to an open console", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const api = installAPI({
      applicationSettings: {
        ...DEFAULT_APPLICATION_SETTINGS_STATE,
        revision: 1,
        theme: "light",
        reduceMotion: true,
        terminal: {
          ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
          fontSize: 18,
          cursorBlink: true,
          smoothScrolling: true,
        },
      },
    });

    renderWithApplicationContextMenu(
      <ApplicationSettingsProvider>
        <ConsoleWindowApp />
      </ApplicationSettingsProvider>,
    );

    const terminal = await screen.findByRole("region", {
      name: "Sliver client Console 1 using Production operator",
    });
    await waitFor(() => expect(terminal).toHaveAttribute("data-font-size", "18"));
    expect(terminal).toHaveAttribute("data-cursor-blink", "false");
    expect(terminal).toHaveAttribute("data-smooth-scroll-duration", "0");
    expect(terminal).toHaveAttribute("data-theme-background", "#fafafa");

    act(() => api.listeners.applicationSettings?.({
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 2,
      theme: "dark",
      terminal: {
        ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
        fontSize: 20,
      },
    }));

    await waitFor(() => expect(terminal).toHaveAttribute("data-font-size", "20"));
    expect(terminal).toHaveAttribute("data-cursor-blink", "true");
    expect(terminal).toHaveAttribute("data-theme-background", "#1e1e1e");
  });

  it.each([true, false])("updates native transparency and theme without reconnecting the console (supported=%s)", async (supported) => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const api = installAPI();
    let onChanged: ((state: GhosttySettingsSnapshot) => void) | undefined;
    const theme = { background: "#112233", foreground: "#ddeeff", backgroundOpacity: 0.65, palette: {} };
    const config: GhosttySettingsSnapshot = {
      configPath: "/test/.sliver-client/gui/ghostty/config",
      themesDirectory: "/test/.sliver-client/gui/ghostty/themes",
      theme: "Test",
      themes: [],
      dark: theme,
      light: theme,
      diagnostics: [],
      revision: 1,
      nativeTerminalTransparency: supported,
    };
    Object.defineProperty(window, "ghosttySettings", {
      configurable: true,
      value: {
        getConfig: async () => config,
        onChanged: (listener: typeof onChanged) => {
          onChanged = listener;
          return () => undefined;
        },
      },
    });
    renderWithApplicationContextMenu(<ApplicationSettingsProvider><ConsoleWindowApp /></ApplicationSettingsProvider>);
    const terminal = await screen.findByRole("region", { name: "Sliver client Console 1 using Production operator" });
    await waitFor(() => expect(terminal).toHaveAttribute("data-background-opacity", supported ? "0.65" : "1"));
    expect(screen.getByRole("main")).toHaveAttribute("data-transparent", String(supported));

    act(() => api.listeners.applicationSettings?.({
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 1,
      terminal: { ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal, transparentWindows: false },
    }));
    expect(screen.getByRole("main")).toHaveAttribute("data-transparent", "false");
    expect(terminal).toHaveAttribute("data-background-opacity", "1");
    act(() => onChanged?.({ ...config, revision: 2, dark: { ...theme, background: "#223344" }, light: { ...theme, background: "#223344" } }));
    expect(terminal).toHaveAttribute("data-theme-background", "#223344");
    expect(openConsoleTransport).toHaveBeenCalledOnce();
    expect(transport.close).not.toHaveBeenCalled();
  });

  it("adds and switches tabs while every Ghostty instance stays mounted and inactive tabs are inert", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openConsoleTransport
      .mockResolvedValueOnce(firstTransport)
      .mockResolvedValueOnce(secondTransport);
    const api = installAPI({
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
    });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    fireEvent.click(screen.getByRole("button", { name: "New console tab" }));

    const secondTabButton = await screen.findByRole("tab", { name: /Console 2 Connected/u });
    expect(secondTabButton).toHaveAttribute("aria-selected", "true");
    expect(secondTabButton).toHaveAccessibleName("Console 2 Connected, shortcut Command+2");
    expect(secondTabButton).toHaveTextContent("⌘2");
    expect(api.createConsoleTab).toHaveBeenCalledOnce();
    expect(openConsoleTransport).toHaveBeenLastCalledWith({ attachmentToken: secondTab.attachmentToken });
    expect(document.querySelectorAll("[data-terminal-mock]")).toHaveLength(2);

    const firstPanel = document.querySelector(`[data-console-terminal-tab-id="${initialTab.tabId}"]`);
    const secondPanel = document.querySelector(`[data-console-terminal-tab-id="${secondTab.tabId}"]`);
    expect(firstPanel).toHaveAttribute("aria-hidden", "true");
    expect(firstPanel).toHaveAttribute("inert");
    expect(secondPanel).toHaveAttribute("aria-hidden", "false");
    expect(secondPanel).not.toHaveAttribute("inert");

    fireEvent.click(screen.getByRole("tab", { name: /Console 1 Connected/u }));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");
    expect(document.querySelectorAll("[data-terminal-mock]")).toHaveLength(2);
    expect(firstTransport.close).not.toHaveBeenCalled();
    expect(secondTransport.close).not.toHaveBeenCalled();
  });

  it("renames the exact background tab from its scoped context menu without changing selection", async () => {
    const user = userEvent.setup();
    openConsoleTransport.mockResolvedValueOnce(fakeTransport()).mockResolvedValueOnce(fakeTransport());
    const api = installAPI({ createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)) });
    const rendered = renderWithApplicationContextMenu(<ConsoleWindowApp />);
    const firstTabButton = await screen.findByRole("tab", { name: /Console 1 Connected/u });

    await user.click(screen.getByRole("button", { name: "New console tab" }));
    const secondTabButton = await screen.findByRole("tab", { name: /Console 2 Connected/u });
    expect(secondTabButton).toHaveAttribute("aria-selected", "true");
    expect(document.title).toBe("Sliver console — Production operator — Console 2");

    fireEvent.contextMenu(firstTabButton, { clientX: 40, clientY: 24 });
    rendered.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Rename",
      "Inspect Element",
    ]);
    await user.click(within(menu).getByRole("menuitem", { name: "Rename" }));

    const dialog = await screen.findByRole("dialog", { name: "Rename tab" });
    const input = within(dialog).getByRole("textbox", { name: "Tab name" });
    expect(input).toHaveValue("Console 1");
    await user.clear(input);
    await user.type(input, "  Primary  {Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename tab" })).not.toBeInTheDocument());
    const renamedTab = screen.getByRole("tab", { name: /Primary Connected/u });
    expect(renamedTab).toHaveAttribute("aria-selected", "false");
    expect(secondTabButton).toHaveAttribute("aria-selected", "true");
    expect(document.querySelector(
      '[data-terminal-mock][aria-label="Sliver client Primary using Production operator"]',
    )).toBeInTheDocument();
    expect(document.title).toBe("Sliver console — Production operator — Console 2");
    expect(api.createConsoleTab).toHaveBeenCalledOnce();
    expect(api.closeConsoleTab).not.toHaveBeenCalled();

    await user.click(renamedTab);
    await waitFor(() => expect(document.title).toBe("Sliver console — Production operator — Primary"));
  });

  it("dismisses Rename when the native close command removes its active tab", async () => {
    const user = userEvent.setup();
    openConsoleTransport.mockResolvedValueOnce(fakeTransport()).mockResolvedValueOnce(fakeTransport());
    const api = installAPI({
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
      closeConsoleTab: vi.fn().mockResolvedValue(ok<ConsoleTabCloseResult>({ remainingTabs: 1 })),
    });
    const rendered = renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    await user.click(screen.getByRole("button", { name: "New console tab" }));
    const secondTabButton = await screen.findByRole("tab", { name: /Console 2 Connected/u });
    fireEvent.contextMenu(secondTabButton, { clientX: 40, clientY: 24 });
    rendered.contextMenu.emit();
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("dialog", { name: "Rename tab" })).toBeInTheDocument();

    act(() => api.listeners.closeTab?.());

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename tab" })).not.toBeInTheDocument());
    expect(screen.queryByRole("tab", { name: /Console 2/u })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");
    expect(document.title).toBe("Sliver console — Production operator — Console 1");
    expect(api.closeConsoleTab).toHaveBeenCalledWith(secondTab.tabId);
  });

  it("captures Command shortcuts before a focused Ghostty terminal can consume them", async () => {
    openConsoleTransport.mockResolvedValueOnce(fakeTransport()).mockResolvedValueOnce(fakeTransport());
    const api = installAPI({ createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)) });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    const firstTerminal = screen.getByRole("region", {
      name: "Sliver client Console 1 using Production operator",
    });
    const downstreamKeydown = vi.fn();
    firstTerminal.addEventListener("keydown", downstreamKeydown);
    const newTabShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyT",
      key: "t",
      metaKey: true,
    });
    act(() => expect(firstTerminal.dispatchEvent(newTabShortcut)).toBe(false));
    expect(downstreamKeydown).not.toHaveBeenCalled();
    await screen.findByRole("tab", { name: /Console 2 Connected/u });
    expect(api.createConsoleTab).toHaveBeenCalledOnce();

    const secondTerminal = screen.getByRole("region", {
      name: "Sliver client Console 2 using Production operator",
    });
    secondTerminal.addEventListener("keydown", downstreamKeydown);
    const shortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "1",
      metaKey: true,
    });
    act(() => expect(secondTerminal.dispatchEvent(shortcut)).toBe(false));
    expect(downstreamKeydown).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: /Console 2 Connected/u }));
    const repeatedShortcut = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "Digit1",
      key: "1",
      metaKey: true,
      repeat: true,
    });
    act(() => expect(secondTerminal.dispatchEvent(repeatedShortcut)).toBe(false));
    expect(downstreamKeydown).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /Console 2 Connected/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it.each(["Command", "Control"] as const)("updates %s tab shortcuts and labels in an open console", async (modifier) => {
    openConsoleTransport.mockResolvedValue(fakeTransport());
    const api = installAPI({
      claimConsoleWindow: async () => ok({ ...launchContext, shortcutModifier: modifier }),
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
    });
    renderWithApplicationContextMenu(
      <ApplicationSettingsProvider>
        <ConsoleWindowApp />
      </ApplicationSettingsProvider>,
    );
    const terminal = await screen.findByRole("region", {
      name: "Sliver client Console 1 using Production operator",
    });
    const primary = modifier === "Command" ? { metaKey: true } : { ctrlKey: true };
    const key = (code: string, value: string, modifiers: KeyboardEventInit = {}) => new KeyboardEvent("keydown", {
      bubbles: true, cancelable: true, code, key: value, ...primary, ...modifiers,
    });
    const downstreamKeydown = vi.fn();
    terminal.addEventListener("keydown", downstreamKeydown);

    act(() => api.listeners.applicationSettings?.({
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 1,
      keyboardShortcuts: { terminalNewTab: "mod+shift+j", terminalTab1: "mod+alt+1" },
    }));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAccessibleName(
      `Console 1 Connected, shortcut ${modifier === "Command" ? "Command+Option" : "Ctrl+Alt"}+1`,
    );
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveTextContent(
      modifier === "Command" ? "⌘⌥1" : "Ctrl+Alt+1",
    );
    act(() => expect(terminal.dispatchEvent(key("KeyT", "t"))).toBe(true));
    expect(downstreamKeydown).toHaveBeenCalledOnce();
    expect(api.createConsoleTab).not.toHaveBeenCalled();

    act(() => expect(terminal.dispatchEvent(key("KeyJ", "J", { shiftKey: true }))).toBe(false));
    await screen.findByRole("tab", { name: /Console 2 Connected/u });
    expect(api.createConsoleTab).toHaveBeenCalledOnce();
    expect(downstreamKeydown).toHaveBeenCalledOnce();
    act(() => expect(terminal.dispatchEvent(key("Digit1", "1"))).toBe(true));
    expect(screen.getByRole("tab", { name: /Console 2 Connected/u })).toHaveAttribute("aria-selected", "true");
    act(() => expect(terminal.dispatchEvent(key("Digit1", "1", { altKey: true }))).toBe(false));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");

    act(() => api.listeners.applicationSettings?.({ ...DEFAULT_APPLICATION_SETTINGS_STATE, revision: 2 }));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveTextContent(
      modifier === "Command" ? "⌘1" : "Ctrl+1",
    );
    act(() => expect(terminal.dispatchEvent(key("Digit1", "1", { altKey: true }))).toBe(true));
    act(() => expect(terminal.dispatchEvent(key("Digit1", "1"))).toBe(false));
  });

  it("closes only the active tab and selects its nearest sibling", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openConsoleTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    const closeConsoleTab = vi.fn().mockResolvedValue(ok<ConsoleTabCloseResult>({ remainingTabs: 1 }));
    installAPI({
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
      closeConsoleTab,
    });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });
    fireEvent.click(screen.getByRole("button", { name: "New console tab" }));
    await screen.findByRole("tab", { name: /Console 2 Connected/u });

    fireEvent.click(screen.getByRole("button", { name: "Close active console tab" }));

    await waitFor(() => expect(screen.queryByRole("tab", { name: /Console 2/u })).not.toBeInTheDocument());
    expect(closeConsoleTab).toHaveBeenCalledWith(secondTab.tabId);
    expect(secondTransport.close).toHaveBeenCalledOnce();
    expect(firstTransport.close).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");
  });

  it("relabels positional shortcuts after a preceding tab closes", async () => {
    openConsoleTransport.mockResolvedValueOnce(fakeTransport()).mockResolvedValueOnce(fakeTransport());
    installAPI({
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
      closeConsoleTab: vi.fn().mockResolvedValue(ok<ConsoleTabCloseResult>({ remainingTabs: 1 })),
    });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });
    fireEvent.click(screen.getByRole("button", { name: "New console tab" }));
    await screen.findByRole("tab", { name: /Console 2 Connected/u });
    fireEvent.click(screen.getByRole("tab", { name: /Console 1 Connected/u }));

    fireEvent.click(screen.getByRole("button", { name: "Close active console tab" }));

    const remaining = await screen.findByRole("tab", { name: /Console 2 Connected/u });
    expect(remaining).toHaveAccessibleName("Console 2 Connected, shortcut Command+1");
    expect(remaining).toHaveTextContent("⌘1");
  });

  it("keeps an authorized empty window after the last tab closes and can create another tab", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openConsoleTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    const api = installAPI({
      closeConsoleTab: vi.fn().mockResolvedValue(ok<ConsoleTabCloseResult>({ remainingTabs: 0 })),
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
    });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    fireEvent.click(screen.getByRole("button", { name: "Close active console tab" }));

    expect(await screen.findByText("No console tabs")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close active console tab" })).toBeDisabled();
    expect(firstTransport.close).toHaveBeenCalledOnce();
    expect(api.closeConsoleTab).toHaveBeenCalledWith(initialTab.tabId);

    fireEvent.click(screen.getByText("New console tab"));
    expect(await screen.findByRole("tab", { name: /Console 2 Connected/u })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(secondTransport.close).not.toHaveBeenCalled();
  });

  it("keeps a failed-close tab visible and connected so the operator can retry", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const closeConsoleTab = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: "Console cleanup is still pending" })
      .mockResolvedValueOnce(ok<ConsoleTabCloseResult>({ remainingTabs: 0 }));
    installAPI({ closeConsoleTab });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    fireEvent.click(screen.getByRole("button", { name: "Close active console tab" }));

    expect(await screen.findByText("Console tab could not be closed")).toBeInTheDocument();
    expect(screen.getByText("Console cleanup is still pending")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toBeInTheDocument();
    expect(transport.close).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close active console tab" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Console 1/u })).not.toBeInTheDocument());
    expect(closeConsoleTab).toHaveBeenCalledTimes(2);
    expect(transport.close).toHaveBeenCalledOnce();
  });

  it("scopes exit notices and terminal failures to their exact tab", async () => {
    openConsoleTransport.mockResolvedValueOnce(fakeTransport()).mockResolvedValueOnce(fakeTransport());
    installAPI({ createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)) });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });
    fireEvent.click(screen.getByRole("button", { name: "New console tab" }));
    await screen.findByRole("tab", { name: /Console 2 Connected/u });

    fireEvent.click(screen.getByRole("button", { name: "Exit client" }));
    const exitNotice = screen.getByRole("alert");
    expect(screen.getByText("Console process exited")).toBeInTheDocument();
    expect(screen.getByText("Sliver client exited with code 7")).toBeInTheDocument();
    expect(exitNotice).toHaveClass("bg-overlay", "text-overlay-foreground", "shadow-overlay");
    expect(exitNotice).not.toHaveClass("opacity-80", "bg-warning-soft");
    expect(screen.getByRole("tab", { name: /Console 2 Exited/u })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /Console 1 Connected/u }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Fail terminal" }));
    expect(screen.getByText("Terminal unavailable")).toBeInTheDocument();
    expect(screen.getByText("Ghostty failed")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-terminal-mock]")).toHaveLength(2);
  });

  it.each(["toolbar", "native menu"])("opens settings from the %s and applies validated settings to every tab", async (source) => {
    const user = userEvent.setup();
    openConsoleTransport.mockResolvedValue(fakeTransport());
    const api = installAPI();
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    const terminal = await screen.findByRole("region", {
      name: "Sliver client Console 1 using Production operator",
    });

    if (source === "toolbar") {
      await user.click(screen.getByRole("button", { name: "Terminal settings" }));
    } else {
      act(() => api.listeners.settings?.());
    }
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terminal Settings" })).toBeInTheDocument();
    expect(screen.getAllByText("Fira Code").length).toBeGreaterThan(0);

    const fontSize = screen.getByRole("textbox", { name: "Font size" });
    await user.clear(fontSize);
    await user.type(fontSize, "18");
    await user.click(screen.getByRole("switch", { name: "Smooth scrolling" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(terminal).toHaveAttribute("data-font-size", "18"));
    expect(terminal).toHaveAttribute(
      "data-smooth-scroll-duration",
      String(100),
    );
    expect(JSON.parse(window.localStorage.getItem(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY) ?? "null"))
      .toMatchObject({ v: 1, fontId: "fira-code", fontSize: 18, smoothScrolling: true });
  });

  it("handles native new-tab and close-tab commands through the same bounded actions", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openConsoleTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    const api = installAPI({
      createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)),
      closeConsoleTab: vi.fn().mockResolvedValue(ok<ConsoleTabCloseResult>({ remainingTabs: 1 })),
    });
    renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });

    act(() => api.listeners.newTab?.());
    await screen.findByRole("tab", { name: /Console 2 Connected/u });
    act(() => api.listeners.selectTab?.(0));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");
    act(() => api.listeners.selectTab?.(9));
    expect(screen.getByRole("tab", { name: /Console 1 Connected/u })).toHaveAttribute("aria-selected", "true");
    act(() => api.listeners.selectTab?.(1));
    expect(screen.getByRole("tab", { name: /Console 2 Connected/u })).toHaveAttribute("aria-selected", "true");
    act(() => api.listeners.closeTab?.());
    await waitFor(() => expect(screen.queryByRole("tab", { name: /Console 2/u })).not.toBeInTheDocument());

    expect(api.createConsoleTab).toHaveBeenCalledOnce();
    expect(api.closeConsoleTab).toHaveBeenCalledWith(secondTab.tabId);
  });

  it("fails closed when a generic window cannot claim the console", async () => {
    const api = installAPI({
      claimConsoleWindow: vi.fn().mockResolvedValue({
        ok: false,
        error: "This window has no console capability",
      }),
    });

    renderWithApplicationContextMenu(<ConsoleWindowApp />);

    expect(await screen.findByText("Sliver console unavailable")).toBeInTheDocument();
    expect(screen.getByText("This window has no console capability")).toBeInTheDocument();
    expect(openConsoleTransport).not.toHaveBeenCalled();
    expect(api.createConsoleTab).not.toHaveBeenCalled();
  });

  it("closes the initial native transport when the Ghostty runtime cannot load", async () => {
    const transport = fakeTransport();
    openConsoleTransport.mockResolvedValue(transport);
    const api = installAPI({
      getTerminalRuntime: vi.fn().mockResolvedValue({
        ok: false,
        error: "Ghostty runtime failed integrity verification",
      }),
    });

    renderWithApplicationContextMenu(<ConsoleWindowApp />);

    expect(await screen.findByText("Sliver console unavailable")).toBeInTheDocument();
    expect(screen.getByText("Ghostty runtime failed integrity verification")).toBeInTheDocument();
    await waitFor(() => expect(transport.close).toHaveBeenCalledOnce());
    act(() => api.listeners.newTab?.());
    expect(api.createConsoleTab).not.toHaveBeenCalled();
    expect(openConsoleTransport).toHaveBeenCalledOnce();
  });

  it("closes every attached transport when the dedicated window unmounts", async () => {
    const firstTransport = fakeTransport();
    const secondTransport = fakeTransport();
    openConsoleTransport.mockResolvedValueOnce(firstTransport).mockResolvedValueOnce(secondTransport);
    installAPI({ createConsoleTab: vi.fn().mockResolvedValue(ok(secondTab)) });
    const rendered = renderWithApplicationContextMenu(<ConsoleWindowApp />);
    await screen.findByRole("tab", { name: /Console 1 Connected/u });
    fireEvent.click(screen.getByRole("button", { name: "New console tab" }));
    await screen.findByRole("tab", { name: /Console 2 Connected/u });

    rendered.unmount();

    expect(firstTransport.close).toHaveBeenCalledOnce();
    expect(secondTransport.close).toHaveBeenCalledOnce();
  });
});

function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

function runtime(): TerminalRuntimeAsset {
  return {
    version: "0.4.0",
    sha256: "a".repeat(64),
    bytes: new Uint8Array([0, 97, 115, 109]),
  };
}

function fakeTransport() {
  return {
    close: vi.fn(),
    getSnapshot: vi.fn(),
    resize: vi.fn(),
    send: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    subscribeState: vi.fn(() => vi.fn()),
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

interface ConsoleTestListeners {
  newTab?: () => void;
  closeTab?: () => void;
  selectTab?: (index: number) => void;
  settings?: () => void;
  applicationSettings?: (settings: ApplicationSettingsState) => void;
}

function installAPI(overrides: Partial<{
  claimConsoleWindow: () => Promise<OperationResult<ConsoleWindowLaunchContext>>;
  createConsoleTab: () => Promise<OperationResult<ConsoleTabLaunchContext>>;
  closeConsoleTab: (tabId: string) => Promise<OperationResult<ConsoleTabCloseResult>>;
  getTerminalRuntime: () => Promise<OperationResult<TerminalRuntimeAsset>>;
  applicationSettings: ApplicationSettingsState;
}> = {}) {
  const listeners: ConsoleTestListeners = {};
  const api = {
    claimConsoleWindow: vi.fn(overrides.claimConsoleWindow ?? (async () => ok(launchContext))),
    createConsoleTab: vi.fn(overrides.createConsoleTab ?? (async () => ({
      ok: false as const,
      error: "No additional tab fixture",
    }))),
    closeConsoleTab: vi.fn(overrides.closeConsoleTab ?? (async () => ok({ remainingTabs: 0 }))),
    getTerminalRuntime: vi.fn(overrides.getTerminalRuntime ?? (async () => ok(runtime()))),
    getApplicationSettings: vi.fn(async () =>
      overrides.applicationSettings ?? DEFAULT_APPLICATION_SETTINGS_STATE),
    updateApplicationSettings: vi.fn<SliverDesktopAPI["updateApplicationSettings"]>(async () => ({
      ok: false,
      error: "Application settings updates are not part of this console test",
    })),
    onApplicationSettingsChanged: vi.fn((listener: (settings: ApplicationSettingsState) => void) => {
      listeners.applicationSettings = listener;
      return vi.fn();
    }),
    onConsoleNewTabRequested: vi.fn((listener: () => void) => {
      listeners.newTab = listener;
      return vi.fn();
    }),
    onConsoleCloseTabRequested: vi.fn((listener: () => void) => {
      listeners.closeTab = listener;
      return vi.fn();
    }),
    onConsoleSelectTabRequested: vi.fn((listener: (index: number) => void) => {
      listeners.selectTab = listener;
      return vi.fn();
    }),
    onConsoleSettingsRequested: vi.fn((listener: () => void) => {
      listeners.settings = listener;
      return vi.fn();
    }),
    listeners,
  };
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api,
  });
  return api;
}
