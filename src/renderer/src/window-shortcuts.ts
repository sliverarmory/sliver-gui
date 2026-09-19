import { useEffect } from "react";

import { isApplePlatform } from "./components/CommandPaletteShortcut";
import { isApplicationShortcutContextBlocked } from "./navigation-shortcuts";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import { matchesKeyboardShortcut, resolveKeyboardShortcut, type KeyboardShortcutSettings } from "../../shared/keyboard-shortcuts";

export const NEW_WINDOW_SHORTCUT = "mod+n";
export const DUPLICATE_WINDOW_SHORTCUT = "mod+shift+n";
export const OPEN_CONSOLE_SHORTCUT = "mod+t";

interface ConsoleShortcutOptions {
  readonly isEnabled: boolean;
  readonly onOpenConsole: () => void;
  readonly settings?: KeyboardShortcutSettings;
}

export function useConsoleShortcut({ isEnabled, onOpenConsole, settings = DEFAULT_APPLICATION_SETTINGS_STATE }: ConsoleShortcutOptions): void {
  useEffect(() => {
    if (!isEnabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented || event.repeat || event.isComposing
      ) return;
      const apple = isApplePlatform();
      if (!matchesKeyboardShortcut(resolveKeyboardShortcut("openConsole", settings, apple), event, apple) ||
        isApplicationShortcutContextBlocked(event)) return;

      event.preventDefault();
      onOpenConsole();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEnabled, onOpenConsole, settings]);
}
