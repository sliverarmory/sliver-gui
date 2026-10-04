import type { ApplicationSettingsValues } from "../../shared/application-settings-contracts";
import {
  matchesKeyboardShortcut,
  resolveKeyboardShortcut,
} from "../../shared/keyboard-shortcuts";
import { formatCommandPaletteShortcut } from "./components/CommandPaletteShortcut";

const TERMINAL_TAB_ACTIONS = [
  "terminalTab1", "terminalTab2", "terminalTab3", "terminalTab4", "terminalTab5",
  "terminalTab6", "terminalTab7", "terminalTab8", "terminalTab9", "terminalTab10",
] as const;

type TerminalKeyboardShortcut =
  | { readonly type: "new-tab" }
  | { readonly type: "select-tab"; readonly index: number };

export function terminalKeyboardShortcutForEvent(
  settings: ApplicationSettingsValues,
  event: KeyboardEvent,
  apple: boolean,
): TerminalKeyboardShortcut | undefined {
  if (event.isComposing) return undefined;
  if (matchesKeyboardShortcut(resolveKeyboardShortcut("terminalNewTab", settings, apple), event, apple)) {
    return { type: "new-tab" };
  }
  const index = TERMINAL_TAB_ACTIONS.findIndex((action) =>
    matchesKeyboardShortcut(resolveKeyboardShortcut(action, settings, apple), event, apple));
  return index < 0 ? undefined : { type: "select-tab", index };
}

export function terminalTabShortcutLabels(
  index: number,
  settings: ApplicationSettingsValues,
  apple: boolean,
): { readonly accessible: string; readonly display: string } {
  const action = TERMINAL_TAB_ACTIONS[index];
  if (!action) return { accessible: "", display: "" };
  const formatted = formatCommandPaletteShortcut(resolveKeyboardShortcut(action, settings, apple), apple);
  return {
    accessible: formatted.replaceAll(" + ", "+"),
    display: apple
      ? formatted.replaceAll("Command", "⌘").replaceAll("Option", "⌥").replaceAll("Shift", "⇧").replaceAll(" + ", "")
      : formatted.replaceAll(" + ", "+"),
  };
}
