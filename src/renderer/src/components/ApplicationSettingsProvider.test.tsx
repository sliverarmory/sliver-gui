import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SliverDesktopAPI } from "../../../shared/contracts";
import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  type ApplicationSettingsState,
  type ResolvedApplicationIcon,
} from "../../../shared/application-settings-contracts";
import { CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY } from "./console-terminal-settings";
import {
  ApplicationSettingsProvider,
  type ApplicationSettingsAPI,
  useApplicationSettings,
} from "./ApplicationSettingsProvider";

let media: TestMediaQueryList;

beforeEach(() => {
  media = new TestMediaQueryList(true);
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage(),
  });
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.colorScheme = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-reduce-motion");
  document.documentElement.style.colorScheme = "";
});

describe("ApplicationSettingsProvider", () => {
  it("resolves System against operating-system changes and applies it to the document", async () => {
    installSettingsAPI();
    renderProvider();

    expect(await screen.findByTestId("revision")).toHaveTextContent("0");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    media.setMatches(false);
    await waitFor(() => expect(document.documentElement).toHaveClass("light"));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("applies an explicit theme and application reduced-motion override", async () => {
    installSettingsAPI({
      getApplicationSettings: vi.fn().mockResolvedValue(applicationSettings({
        revision: 3,
        theme: "light",
        reduceMotion: true,
      })),
    });
    renderProvider();

    expect(await screen.findByTestId("revision")).toHaveTextContent("3");
    expect(document.documentElement).toHaveClass("light");
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");

    media.setMatches(true);
    expect(document.documentElement).toHaveClass("light");
  });

  it("subscribes before loading and ignores a stale initial snapshot", async () => {
    let resolveInitial!: (state: ApplicationSettingsState) => void;
    const initial = new Promise<ApplicationSettingsState>((resolve) => {
      resolveInitial = resolve;
    });
    let listener: ((state: ApplicationSettingsState) => void) | undefined;
    installSettingsAPI({
      getApplicationSettings: vi.fn(() => initial),
      onApplicationSettingsChanged: vi.fn((next) => {
        listener = next;
        return vi.fn();
      }),
    });
    renderProvider();

    listener?.(applicationSettings({ revision: 2, theme: "dark" }));
    resolveInitial(applicationSettings({ revision: 1, theme: "light" }));

    await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("2"));
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });

  it("uses an injected least-privilege settings bridge instead of window.sliver", async () => {
    const workspaceApi = installSettingsAPI();
    const injectedApi: ApplicationSettingsAPI = {
      getApplicationSettings: vi.fn().mockResolvedValue(applicationSettings({
        revision: 7,
        theme: "light",
      })),
      updateApplicationSettings: vi.fn().mockResolvedValue({
        ok: false,
        error: "Updates are not configured by this test",
      }),
      onApplicationSettingsChanged: vi.fn(() => vi.fn()),
    };

    renderProvider(injectedApi);

    expect(await screen.findByTestId("revision")).toHaveTextContent("7");
    expect(screen.getByTestId("theme")).toHaveTextContent("light");
    expect(injectedApi.onApplicationSettingsChanged).toHaveBeenCalledOnce();
    expect(workspaceApi.getApplicationSettings).not.toHaveBeenCalled();
    expect(workspaceApi.onApplicationSettingsChanged).not.toHaveBeenCalled();
  });

  it("uses the native icon independently of the renderer theme and follows live updates", async () => {
    let listener!: (icon: ResolvedApplicationIcon) => void;
    const unsubscribe = vi.fn();
    installSettingsAPI({
      getApplicationSettings: vi.fn().mockResolvedValue(applicationSettings({ theme: "dark" })),
      getApplicationIcon: vi.fn().mockResolvedValue("light"),
      onApplicationIconChanged: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
    });
    renderProvider();

    await waitFor(() => expect(screen.getByTestId("resolved-app-icon")).toHaveTextContent("light"));
    expect(document.documentElement).toHaveClass("dark");
    act(() => media.setMatches(false));
    act(() => media.setMatches(true));
    expect(screen.getByTestId("resolved-app-icon")).toHaveTextContent("light");

    act(() => listener("passion"));
    expect(screen.getByTestId("resolved-app-icon")).toHaveTextContent("passion");
    act(() => listener("dark"));
    expect(screen.getByTestId("resolved-app-icon")).toHaveTextContent("dark");
    cleanup();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("keeps a newer native icon event when the initial read arrives late", async () => {
    let resolveInitial!: (icon: ResolvedApplicationIcon) => void;
    const initial = new Promise<ResolvedApplicationIcon>((resolve) => { resolveInitial = resolve; });
    let listener!: (icon: ResolvedApplicationIcon) => void;
    const api = installSettingsAPI({
      getApplicationIcon: vi.fn(() => initial),
      onApplicationIconChanged: vi.fn((next) => {
        listener = next;
        return vi.fn();
      }),
    });
    renderProvider();

    expect(vi.mocked(api.onApplicationIconChanged).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(api.getApplicationIcon).mock.invocationCallOrder[0]!,
    );
    await act(async () => {
      listener("passion");
      resolveInitial("light");
      await initial;
    });
    expect(screen.getByTestId("resolved-app-icon")).toHaveTextContent("passion");
  });

  it("sends a complete revision-bound update and accepts the persisted response", async () => {
    const updateApplicationSettings = vi.fn(async (input) => ({
      ok: true as const,
      value: applicationSettings({
        revision: input.expectedRevision + 1,
        theme: input.settings.theme,
        appIcon: input.settings.appIcon,
        reduceMotion: input.settings.reduceMotion,
        reportScreenshotDirectory: input.settings.reportScreenshotDirectory,
      }),
    }));
    installSettingsAPI({
      getApplicationSettings: vi.fn().mockResolvedValue(applicationSettings({
        appIcon: "passion",
        reportScreenshotDirectory: "/tmp/report-screenshots",
      })),
      updateApplicationSettings,
    });
    const user = userEvent.setup();
    renderProvider();
    await screen.findByText("ready");

    await user.click(screen.getByRole("button", { name: "Use light theme" }));

    await waitFor(() => expect(screen.getByTestId("theme")).toHaveTextContent("light"));
    expect(updateApplicationSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      settings: {
        theme: "light",
        appIcon: "passion",
        reduceMotion: false,
        reportScreenshotDirectory: "/tmp/report-screenshots",
        commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
        keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
        terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      },
    });
    expect(screen.getByTestId("app-icon")).toHaveTextContent("passion");
  });

  it("persists the screenshot directory and keeps it through later changes", async () => {
    const updateApplicationSettings = vi.fn(async (input) => ({
      ok: true as const,
      value: { ...input.settings, v: APPLICATION_SETTINGS_VERSION, revision: input.expectedRevision + 1 },
    }));
    installSettingsAPI({ updateApplicationSettings });
    const user = userEvent.setup();
    renderProvider();
    await screen.findByText("ready");

    await user.click(screen.getByRole("button", { name: "Use report folder" }));
    await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("1"));
    expect(screen.getByTestId("report-directory")).toHaveTextContent("/tmp/report-screenshots");
    expect(updateApplicationSettings.mock.calls[0]?.[0].settings.reportScreenshotDirectory)
      .toBe("/tmp/report-screenshots");

    await user.click(screen.getByRole("button", { name: "Use report folder" }));
    expect(updateApplicationSettings).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Use light theme" }));
    await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("2"));
    expect(updateApplicationSettings.mock.calls[1]?.[0].settings.reportScreenshotDirectory)
      .toBe("/tmp/report-screenshots");
  });

  it("persists an icon-only update without changing the app theme", async () => {
    const updateApplicationSettings = vi.fn(async (input) => ({
      ok: true as const,
      value: applicationSettings({
        revision: input.expectedRevision + 1,
        ...input.settings,
      }),
    }));
    installSettingsAPI({ updateApplicationSettings });
    const user = userEvent.setup();
    renderProvider();
    await screen.findByText("ready");

    await user.click(screen.getByRole("button", { name: "Use Passion icon" }));

    await waitFor(() => expect(screen.getByTestId("app-icon")).toHaveTextContent("passion"));
    expect(updateApplicationSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      settings: {
        theme: "system",
        appIcon: "passion",
        reduceMotion: false,
        reportScreenshotDirectory: null,
        commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
        keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
        terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      },
    });
    expect(document.documentElement).toHaveClass("dark");
  });

  it("migrates a non-default legacy terminal preference once", async () => {
    window.localStorage.setItem(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY, JSON.stringify({
      v: 1,
      fontId: "jetbrains-mono",
      fontSize: 17,
      cursorStyle: "bar",
      cursorBlink: false,
      smoothScrolling: true,
    }));
    const updateApplicationSettings = vi.fn(async (input) => ({
      ok: true as const,
      value: {
        v: APPLICATION_SETTINGS_VERSION,
        revision: 1,
        ...input.settings,
      },
    }));
    installSettingsAPI({ updateApplicationSettings });
    renderProvider();

    await screen.findByText("ready");
    expect(updateApplicationSettings).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      settings: {
        theme: "system",
        appIcon: "auto",
        reduceMotion: false,
        reportScreenshotDirectory: null,
        commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
        keyboardShortcuts: DEFAULT_APPLICATION_SETTINGS_STATE.keyboardShortcuts,
        terminal: {
          fontId: "jetbrains-mono",
          fontSize: 17,
          cursorStyle: "bar",
          cursorBlink: false,
          smoothScrolling: true,
        },
      },
    });
    expect(screen.getByTestId("revision")).toHaveTextContent("1");
  });

  it("persists a shortcut-only change and preserves it across other preference updates", async () => {
    const updateApplicationSettings = vi.fn(async (input) => ({
      ok: true as const,
      value: { ...input.settings, v: APPLICATION_SETTINGS_VERSION, revision: input.expectedRevision + 1 },
    }));
    installSettingsAPI({ updateApplicationSettings });
    const user = userEvent.setup();
    renderProvider();
    await screen.findByText("ready");
    await user.click(screen.getByRole("button", { name: "Remap new window" }));
    await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("1"));
    expect(updateApplicationSettings.mock.calls[0]?.[0].settings.keyboardShortcuts).toEqual({ newWindow: "mod+alt+n" });
    await user.click(screen.getByRole("button", { name: "Use light theme" }));
    await waitFor(() => expect(screen.getByTestId("revision")).toHaveTextContent("2"));
    expect(updateApplicationSettings.mock.calls[1]?.[0].settings).toMatchObject({
      theme: "light", keyboardShortcuts: { newWindow: "mod+alt+n" },
    });
    await user.click(screen.getByRole("button", { name: "Remap new window" }));
    expect(updateApplicationSettings).toHaveBeenCalledTimes(2);
  });
});

function renderProvider(api?: ApplicationSettingsAPI): void {
  render(
    <ApplicationSettingsProvider {...(api ? { api } : {})}>
      <SettingsProbe />
    </ApplicationSettingsProvider>,
  );
}

function SettingsProbe(): React.JSX.Element {
  const context = useApplicationSettings();
  if (!context) return <span>missing</span>;
  return (
    <div>
      <span>{context.isReady ? "ready" : "loading"}</span>
      <span data-testid="revision">{context.settings.revision}</span>
      <span data-testid="theme">{context.settings.theme}</span>
      <span data-testid="app-icon">{context.settings.appIcon}</span>
      <span data-testid="report-directory">{context.settings.reportScreenshotDirectory ?? "Desktop"}</span>
      <span data-testid="resolved-app-icon">{context.resolvedAppIcon}</span>
      <button
        type="button"
        onClick={() => void context.updateSettings((current) => ({ ...current, theme: "light" }))}
      >
        Use light theme
      </button>
      <button
        type="button"
        onClick={() => void context.updateSettings((current) => ({ ...current, appIcon: "passion" }))}
      >
        Use Passion icon
      </button>
      <button
        type="button"
        onClick={() => void context.updateSettings((current) => ({
          ...current, reportScreenshotDirectory: "/tmp/report-screenshots",
        }))}
      >
        Use report folder
      </button>
      <button
        type="button"
        onClick={() => void context.updateSettings((current) => ({
          ...current, keyboardShortcuts: { ...current.keyboardShortcuts, newWindow: "mod+alt+n" },
        }))}
      >
        Remap new window
      </button>
    </div>
  );
}

type SettingsAPI = Pick<
  SliverDesktopAPI,
  "getApplicationSettings" | "updateApplicationSettings" | "onApplicationSettingsChanged" |
  "getApplicationIcon" | "onApplicationIconChanged"
>;

function installSettingsAPI(overrides: Partial<SettingsAPI> = {}): SettingsAPI {
  const api: SettingsAPI = {
    getApplicationSettings: vi.fn().mockResolvedValue(DEFAULT_APPLICATION_SETTINGS_STATE),
    getApplicationIcon: vi.fn().mockResolvedValue("dark"),
    onApplicationIconChanged: vi.fn(() => vi.fn()),
    updateApplicationSettings: vi.fn().mockResolvedValue({
      ok: false,
      error: "Updates are not configured by this test",
    }),
    onApplicationSettingsChanged: vi.fn(() => vi.fn()),
    ...overrides,
  };
  Object.defineProperty(window, "sliver", {
    configurable: true,
    value: api as SliverDesktopAPI,
  });
  return api;
}

function applicationSettings(
  overrides: Partial<Pick<ApplicationSettingsState, "revision" | "theme" | "appIcon" | "reduceMotion" | "reportScreenshotDirectory">>,
): ApplicationSettingsState {
  return {
    ...DEFAULT_APPLICATION_SETTINGS_STATE,
    ...overrides,
  };
}

class TestMediaQueryList {
  matches: boolean;
  readonly media = "(prefers-color-scheme: dark)";
  readonly onchange = null;
  readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: string, listener: (event: MediaQueryListEvent) => void): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) listener({ matches } as MediaQueryListEvent);
  }
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}
