import { useEffect } from "react";

import { isApplePlatform } from "./components/CommandPaletteShortcut";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import { matchesKeyboardShortcut, resolveKeyboardShortcut, type KeyboardShortcutSettings } from "../../shared/keyboard-shortcuts";

export type NavigationDirection = "back" | "forward";

interface NavigationShortcutKeyboardEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly key: string;
  readonly code?: string;
  readonly metaKey: boolean;
  readonly repeat?: boolean;
  readonly shiftKey: boolean;
  readonly target?: EventTarget | null;
  readonly composedPath?: () => EventTarget[];
}

interface NavigationShortcutOptions {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly goBack: () => void;
  readonly goForward: () => void;
  readonly isDisabled?: boolean;
  readonly settings?: KeyboardShortcutSettings;
}

const INPUT_SELECTOR = [
  "input",
  "textarea",
  "select",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="combobox"]',
  "[data-terminal-state]",
  '[data-command-palette-shortcut-recorder="true"]',
].join(",");

export function navigationShortcuts(apple = isApplePlatform(), settings: KeyboardShortcutSettings = DEFAULT_APPLICATION_SETTINGS_STATE) {
  const back = resolveKeyboardShortcut("navigateBack", settings, apple);
  const forward = resolveKeyboardShortcut("navigateForward", settings, apple);
  return {
    back: { shortcut: back, ariaKeyShortcuts: shortcutAriaKeyShortcuts(back, apple) },
    forward: { shortcut: forward, ariaKeyShortcuts: shortcutAriaKeyShortcuts(forward, apple) },
  };
}

export function shortcutAriaKeyShortcuts(shortcut: string, apple = isApplePlatform()): string {
  return shortcut.split("+").map((token) => {
    if (token === "mod") return apple ? "Meta" : "Control";
    if (token === "alt") return "Alt";
    if (token === "shift") return "Shift";
    if (token.toLowerCase().startsWith("arrow")) return `Arrow${token.slice(5, 6).toUpperCase()}${token.slice(6)}`;
    if (/^f\d+$/u.test(token)) return token.toUpperCase();
    return token.length === 1 ? token.toUpperCase() : token;
  }).join("+");
}

export function navigationDirectionFromKeyboardEvent(
  event: NavigationShortcutKeyboardEvent,
  apple = isApplePlatform(),
  settings: KeyboardShortcutSettings = DEFAULT_APPLICATION_SETTINGS_STATE,
): NavigationDirection | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing) {
    return undefined;
  }
  const direction = matchesKeyboardShortcut(resolveKeyboardShortcut("navigateBack", settings, apple), event, apple) ? "back"
    : matchesKeyboardShortcut(resolveKeyboardShortcut("navigateForward", settings, apple), event, apple) ? "forward" : undefined;
  if (!direction) return undefined;
  if (isApplicationShortcutContextBlocked(event)) return undefined;

  return direction;
}

export function isApplicationShortcutContextBlocked(
  event: Pick<NavigationShortcutKeyboardEvent, "target" | "composedPath">,
): boolean {
  const targets = event.composedPath?.() ?? [event.target];
  const target = targets.find((candidate): candidate is Element => candidate instanceof Element);
  const document = target?.ownerDocument ?? globalThis.document;
  if (targets.some((candidate) => candidate instanceof Element && candidate.closest(INPUT_SELECTOR))) {
    return true;
  }
  if (document?.activeElement?.closest(INPUT_SELECTOR)) return true;
  if (document && [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .some(isActiveDialog)) return true;

  return false;
}

function isActiveDialog(dialog: Element): boolean {
  if (dialog.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let element: Element | null = dialog; element; element = element.parentElement) {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style?.display === "none" || style?.visibility === "hidden") return false;
  }
  return true;
}

export function useNavigationShortcuts({
  canGoBack,
  canGoForward,
  goBack,
  goForward,
  isDisabled = false,
  settings = DEFAULT_APPLICATION_SETTINGS_STATE,
}: NavigationShortcutOptions): void {
  useEffect(() => {
    if (isDisabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = navigationDirectionFromKeyboardEvent(event, isApplePlatform(), settings);
      if (!direction) return;
      // Consume our navigation keys at either history boundary as well, so the
      // browser cannot interpret the same gesture as document navigation.
      event.preventDefault();
      if (direction === "back" && canGoBack) goBack();
      if (direction === "forward" && canGoForward) goForward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoBack, canGoForward, goBack, goForward, isDisabled, settings]);
}
