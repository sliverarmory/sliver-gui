import { useEffect } from "react";

import { isApplePlatform } from "./components/CommandPaletteShortcut";

export type NavigationDirection = "back" | "forward";

interface NavigationShortcutKeyboardEvent {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly defaultPrevented?: boolean;
  readonly isComposing?: boolean;
  readonly key: string;
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

export function navigationShortcuts(apple = isApplePlatform()) {
  const back = apple ? "mod+[" : "alt+ArrowLeft";
  const forward = apple ? "mod+]" : "alt+ArrowRight";
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
    return token.length === 1 ? token.toUpperCase() : token;
  }).join("+");
}

export function navigationDirectionFromKeyboardEvent(
  event: NavigationShortcutKeyboardEvent,
  apple = isApplePlatform(),
): NavigationDirection | undefined {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || event.ctrlKey) {
    return undefined;
  }
  if (apple ? !event.metaKey || event.altKey : !event.altKey || event.metaKey) return undefined;

  const direction = event.key === (apple ? "[" : "ArrowLeft") ? "back"
    : event.key === (apple ? "]" : "ArrowRight") ? "forward" : undefined;
  if (!direction) return undefined;

  const targets = event.composedPath?.() ?? [event.target];
  const target = targets.find((candidate): candidate is Element => candidate instanceof Element);
  const document = target?.ownerDocument ?? globalThis.document;
  if (targets.some((candidate) => candidate instanceof Element && candidate.closest(INPUT_SELECTOR))) {
    return undefined;
  }
  if (document?.activeElement?.closest(INPUT_SELECTOR)) return undefined;
  if (document && [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .some(isActiveDialog)) return undefined;

  return direction;
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
}: NavigationShortcutOptions): void {
  useEffect(() => {
    if (isDisabled) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const direction = navigationDirectionFromKeyboardEvent(event);
      if (!direction) return;
      // Consume our navigation keys at either history boundary as well, so the
      // browser cannot interpret the same gesture as document navigation.
      event.preventDefault();
      if (direction === "back" && canGoBack) goBack();
      if (direction === "forward" && canGoForward) goForward();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canGoBack, canGoForward, goBack, goForward, isDisabled]);
}
