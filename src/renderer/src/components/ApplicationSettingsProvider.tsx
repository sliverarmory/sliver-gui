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
  parseApplicationSettingsState,
  parseApplicationSettingsValues,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
  type ApplicationSettingsValues,
  type ApplicationTheme,
} from "../../../shared/application-settings-contracts";
import type { OperationResult } from "../../../shared/contracts";
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
  readonly resolvedTheme: ResolvedApplicationTheme;
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
  updateApplicationSettings(
    input: ApplicationSettingsUpdateInput,
  ): Promise<OperationResult<ApplicationSettingsState>>;
  onApplicationSettingsChanged(listener: (state: ApplicationSettingsState) => void): () => void;
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
  const [settings, setSettings] = useState<ApplicationSettingsState>(DEFAULT_APPLICATION_SETTINGS_STATE);
  const [isReady, setIsReady] = useState(false);
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
          !sameTerminalSettings(current.terminal, legacyTerminal)
        ) {
          const migrated = await settingsApi.updateApplicationSettings({
            expectedRevision: current.revision,
            settings: {
              theme: current.theme,
              reduceMotion: current.reduceMotion,
              commandPaletteShortcut: current.commandPaletteShortcut,
              terminal: legacyTerminal,
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
        const response = await settingsApi.updateApplicationSettings({
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
    isReady,
    isSaving: savingCount > 0,
    updateSettings,
  }), [isReady, resolvedTheme, savingCount, settings, updateSettings]);

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
    reduceMotion: state.reduceMotion,
    commandPaletteShortcut: state.commandPaletteShortcut,
    terminal: state.terminal,
  });
}

function sameSettings(left: ApplicationSettingsValues, right: ApplicationSettingsValues): boolean {
  return left.theme === right.theme &&
    left.reduceMotion === right.reduceMotion &&
    left.commandPaletteShortcut === right.commandPaletteShortcut &&
    left.terminal.fontId === right.terminal.fontId &&
    left.terminal.fontSize === right.terminal.fontSize &&
    left.terminal.cursorStyle === right.terminal.cursorStyle &&
    left.terminal.cursorBlink === right.terminal.cursorBlink &&
    left.terminal.smoothScrolling === right.terminal.smoothScrolling;
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
    left.smoothScrolling === right.smoothScrolling;
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
