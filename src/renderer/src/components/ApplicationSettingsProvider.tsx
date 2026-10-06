import type { GhosttySettingsSnapshot } from "../../../shared/ghostty-settings-contracts";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "@heroui/react";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  isResolvedApplicationIcon,
  parseApplicationSettingsState,
  parseApplicationSettingsValues,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
  type ApplicationSettingsValues,
  type ApplicationTheme,
  type ResolvedApplicationIcon,
} from "../../../shared/application-settings-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { keyboardShortcutsEqual } from "../../../shared/keyboard-shortcuts";
import {
  CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY,
  loadConsoleTerminalSettings,
  type ConsoleTerminalSettings,
} from "./console-terminal-settings";

export type ResolvedApplicationTheme = Exclude<ApplicationTheme, "system">;
export type ApplicationSettingsUpdater = (
  current: ApplicationSettingsValues,
) => ApplicationSettingsValues;

export interface ApplicationSettingsContextValue {
  readonly settings: ApplicationSettingsState;
  readonly ghosttyConfig?: GhosttySettingsSnapshot | undefined;
  readonly nativeTerminalTransparency: boolean;
  readonly resolvedTheme: ResolvedApplicationTheme;
  readonly resolvedAppIcon: ResolvedApplicationIcon;
  readonly isReady: boolean;
  readonly isSaving: boolean;
  updateSettings(updater: ApplicationSettingsUpdater): Promise<boolean>;
}

/**
 * Least-privilege bridge used by renderer surfaces that only need shared
 * application appearance. The workspace supplies window.sliver by default;
 * isolated surfaces can inject their dedicated preload API instead.
 */
export interface ApplicationSettingsAPI {
  getApplicationSettings(): Promise<ApplicationSettingsState>;
  updateApplicationSettings?(
    input: ApplicationSettingsUpdateInput,
  ): Promise<OperationResult<ApplicationSettingsState>>;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
  getApplicationIcon?(): Promise<ResolvedApplicationIcon>;
  onApplicationIconChanged?(listener: (icon: ResolvedApplicationIcon) => void): () => void;
}

const ApplicationSettingsContext = createContext<ApplicationSettingsContextValue | undefined>(undefined);

export function initializeRendererTheme(): void {
  const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
  applyRendererTheme(dark);
}

export function applyRendererTheme(dark: boolean): void {
  applyDocumentSettings(dark ? "dark" : "light", false);
}

export function ApplicationSettingsProvider({
  api,
  children,
}: {
  readonly api?: ApplicationSettingsAPI;
  readonly children: ReactNode;
}): React.JSX.Element {
  const settingsApi = api ?? window.sliver;
  const [ghosttyConfig, setGhosttyConfig] = useState<GhosttySettingsSnapshot>();
  useEffect(() => {
    const bridge = window.ghosttySettings;
    if (!bridge) return;
    let active = true;
    let revision = -1;
    const acceptConfig = (state: GhosttySettingsSnapshot): void => {
      if (!active || state.revision < revision) return;
      revision = state.revision;
      setGhosttyConfig(state);
    };
    const unsubscribe = bridge.onChanged(acceptConfig);
    void bridge.getConfig().then(acceptConfig).catch(() => undefined);
    return () => { active = false; unsubscribe(); };
  }, []);
  const [settings, setSettings] = useState<ApplicationSettingsState>(DEFAULT_APPLICATION_SETTINGS_STATE);
  const [isReady, setIsReady] = useState(false);
  const [resolvedAppIcon, setResolvedAppIcon] = useState<ResolvedApplicationIcon>("dark");
  const [savingCount, setSavingCount] = useState(0);
  const [systemDark, setSystemDark] = useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true,
  );
  const settingsRef = useRef(settings);
  const updateQueueRef = useRef<Promise<void>>(Promise.resolve());

  const accept = useCallback((next: ApplicationSettingsState): void => {
    if (next.revision < settingsRef.current.revision) return;
    settingsRef.current = next;
    setSettings(next);
  }, []);

  useEffect(() => {
    let active = true;
    const unsubscribe = settingsApi.onApplicationSettingsChanged((next) => {
      if (active) accept(next);
    });
    void (async () => {
      try {
        const loaded = parseApplicationSettingsState(await settingsApi.getApplicationSettings());
        if (!active) return;
        accept(loaded);

        const current = settingsRef.current;
        const legacyTerminal = loadLegacyTerminalSettings();
        if (
          current.revision === 0 &&
          legacyTerminal &&
          settingsApi.updateApplicationSettings &&
          !sameTerminalSettings(current.terminal, legacyTerminal)
        ) {
          const migrated = await settingsApi.updateApplicationSettings({
            expectedRevision: current.revision,
            settings: {
              theme: current.theme,
              appIcon: current.appIcon,
              reduceMotion: current.reduceMotion,
              disableWindowTransparency: current.disableWindowTransparency,
              reportScreenshotDirectory: current.reportScreenshotDirectory,
              commandPaletteShortcut: current.commandPaletteShortcut,
              keyboardShortcuts: current.keyboardShortcuts,
              terminal: legacyTerminal,
              overview: current.overview,
            },
          });
          if (!active) return;
          if (migrated.ok && migrated.value) accept(parseApplicationSettingsState(migrated.value));
          else accept(parseApplicationSettingsState(await settingsApi.getApplicationSettings()));
        }
      } catch (error: unknown) {
        if (!active) return;
        toast.danger("Settings unavailable", {
          description: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (active) setIsReady(true);
      }
    })();
    return () => {
      active = false;
      unsubscribe();
    };
  }, [accept, settingsApi]);

  useEffect(() => {
    // Electron's media query follows the app theme override. The main process
    // resolves the icon against the OS appearance used by the Dock instead.
    if (!settingsApi.getApplicationIcon || !settingsApi.onApplicationIconChanged) return;
    let active = true;
    let receivedChange = false;
    const unsubscribe = settingsApi.onApplicationIconChanged((icon) => {
      if (!active || !isResolvedApplicationIcon(icon)) return;
      receivedChange = true;
      setResolvedAppIcon(icon);
    });
    void settingsApi.getApplicationIcon().then((icon) => {
      if (active && !receivedChange && isResolvedApplicationIcon(icon)) setResolvedAppIcon(icon);
    }).catch(() => {
      // Retain the dark packaged fallback until the next native icon update.
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [settingsApi]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const update = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  const resolvedTheme: ResolvedApplicationTheme = settings.theme === "system"
    ? systemDark ? "dark" : "light"
    : settings.theme;

  useLayoutEffect(() => {
    applyDocumentSettings(resolvedTheme, settings.reduceMotion);
  }, [resolvedTheme, settings.reduceMotion]);

  const updateSettings = useCallback((updater: ApplicationSettingsUpdater): Promise<boolean> => {
    const updateApplicationSettings = settingsApi.updateApplicationSettings;
    if (!updateApplicationSettings) return Promise.resolve(false);
    let resolveResult!: (saved: boolean) => void;
    const result = new Promise<boolean>((resolve) => {
      resolveResult = resolve;
    });
    updateQueueRef.current = updateQueueRef.current.then(async () => {
      setSavingCount((count) => count + 1);
      try {
        const current = settingsRef.current;
        const currentValues = settingsValues(current);
        const next = parseApplicationSettingsValues(updater(currentValues));
        if (sameSettings(currentValues, next)) {
          resolveResult(true);
          return;
        }
        const response = await updateApplicationSettings({
          expectedRevision: current.revision,
          settings: next,
        });
        if (!response.ok || !response.value) {
          toast.danger("Settings not saved", {
            description: response.error ?? "The application settings could not be updated.",
          });
          const latest = await settingsApi.getApplicationSettings();
          accept(parseApplicationSettingsState(latest));
          resolveResult(false);
          return;
        }
        accept(parseApplicationSettingsState(response.value));
        resolveResult(true);
      } catch (error: unknown) {
        toast.danger("Settings not saved", {
          description: error instanceof Error ? error.message : String(error),
        });
        resolveResult(false);
      } finally {
        setSavingCount((count) => Math.max(0, count - 1));
      }
    }).catch(() => {
      resolveResult(false);
    });
    return result;
  }, [accept, settingsApi]);

  const value = useMemo<ApplicationSettingsContextValue>(() => ({
    settings,
    resolvedTheme,
    ghosttyConfig,
    nativeTerminalTransparency: ghosttyConfig?.nativeTerminalTransparency ?? false,
    resolvedAppIcon,
    isReady,
    isSaving: savingCount > 0,
    updateSettings,
  }), [ghosttyConfig, isReady, resolvedAppIcon, resolvedTheme, savingCount, settings, updateSettings]);

  return (
    <ApplicationSettingsContext.Provider value={value}>
      {children}
    </ApplicationSettingsContext.Provider>
  );
}

export function useApplicationSettings(): ApplicationSettingsContextValue | undefined {
  return useContext(ApplicationSettingsContext);
}

function settingsValues(state: ApplicationSettingsState): ApplicationSettingsValues {
  return Object.freeze({
    theme: state.theme,
    appIcon: state.appIcon,
    reduceMotion: state.reduceMotion,
    disableWindowTransparency: state.disableWindowTransparency,
    reportScreenshotDirectory: state.reportScreenshotDirectory,
    commandPaletteShortcut: state.commandPaletteShortcut,
    keyboardShortcuts: state.keyboardShortcuts,
    terminal: state.terminal,
    overview: state.overview,
  });
}

function sameSettings(left: ApplicationSettingsValues, right: ApplicationSettingsValues): boolean {
  return left.theme === right.theme &&
    left.appIcon === right.appIcon &&
    left.reduceMotion === right.reduceMotion &&
    left.disableWindowTransparency === right.disableWindowTransparency &&
    left.reportScreenshotDirectory === right.reportScreenshotDirectory &&
    left.commandPaletteShortcut === right.commandPaletteShortcut &&
    keyboardShortcutsEqual(left.keyboardShortcuts, right.keyboardShortcuts) &&
    left.terminal.fontId === right.terminal.fontId &&
    left.terminal.fontSize === right.terminal.fontSize &&
    left.terminal.cursorStyle === right.terminal.cursorStyle &&
    left.terminal.cursorBlink === right.terminal.cursorBlink &&
    left.terminal.smoothScrolling === right.terminal.smoothScrolling &&
    left.terminal.transparentWindows === right.terminal.transparentWindows &&
    sameOverviewSettings(left.overview, right.overview);
}

function sameOverviewSettings(left: ApplicationSettingsValues["overview"], right: ApplicationSettingsValues["overview"]): boolean {
  const sameSelection = (a: string | readonly string[], b: string | readonly string[]): boolean =>
    typeof a === "string" || typeof b === "string"
      ? a === b
      : a.length === b.length && a.every((item, index) => item === b[index]);
  return sameSelection(left.kinds, right.kinds) &&
    sameSelection(left.statuses, right.statuses) &&
    left.lightning === right.lightning &&
    left.sidebarDisabled === right.sidebarDisabled &&
    left.presentation === right.presentation;
}

function loadLegacyTerminalSettings(): ConsoleTerminalSettings | undefined {
  try {
    if (window.localStorage.getItem(CONSOLE_TERMINAL_SETTINGS_STORAGE_KEY) === null) return undefined;
    return loadConsoleTerminalSettings(window.localStorage);
  } catch {
    return undefined;
  }
}

function sameTerminalSettings(
  left: ConsoleTerminalSettings,
  right: ConsoleTerminalSettings,
): boolean {
  return left.fontId === right.fontId &&
    left.fontSize === right.fontSize &&
    left.cursorStyle === right.cursorStyle &&
    left.cursorBlink === right.cursorBlink &&
    left.smoothScrolling === right.smoothScrolling &&
    left.transparentWindows === right.transparentWindows;
}

function applyDocumentSettings(theme: ResolvedApplicationTheme, reduceMotion: boolean): void {
  const root = document.documentElement;
  root.classList.toggle("light", theme === "light");
  root.classList.toggle("dark", theme === "dark");
  root.dataset["theme"] = theme;
  if (reduceMotion) root.dataset["reduceMotion"] = "true";
  else delete root.dataset["reduceMotion"];
  root.style.colorScheme = theme;
}
