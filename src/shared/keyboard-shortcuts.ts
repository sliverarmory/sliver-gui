export const KEYBOARD_SHORTCUT_DEFINITIONS = [
  { id: "commandPalette", label: "Open command palette", description: "Find pages and common application actions.", group: "Application", scope: "global" },
  { id: "newWindow", label: "New window", description: "Open a new application window.", group: "Application", scope: "global" },
  { id: "duplicateWindow", label: "New window for this server", description: "Open another window connected to the current server.", group: "Application", scope: "global" },
  { id: "openConsole", label: "Open console", description: "Open the console for the connected server.", group: "Application", scope: "application" },
  { id: "navigateBack", label: "Go back", description: "Return to the previous application page.", group: "Navigation", scope: "application" },
  { id: "navigateForward", label: "Go forward", description: "Return to the next application page.", group: "Navigation", scope: "application" },
  { id: "refreshServer", label: "Refresh server", description: "Refresh the connected server's information.", group: "Navigation", scope: "application" },
  { id: "textEditorOpen", label: "Open file", description: "Open a local file in the standalone text editor.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorSaveAs", label: "Save file as", description: "Save the current document to a new local file.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorSave", label: "Save file", description: "Save the current document or overwrite its remote file.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorUndo", label: "Undo edit", description: "Undo the last text editor change.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorRedo", label: "Redo edit", description: "Redo the last text editor change.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorFind", label: "Find in file", description: "Find text in the current document.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorReplace", label: "Replace in file", description: "Find and replace text in the current document.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorWordWrap", label: "Toggle word wrap", description: "Turn editor word wrapping on or off.", group: "Text Editor", scope: "text-editor" },
  { id: "textEditorCommandPalette", label: "Open editor command palette", description: "Find and run Monaco editor commands.", group: "Text Editor", scope: "text-editor" },
  { id: "terminalNewTab", label: "New terminal tab", description: "Open a new tab in the terminal window.", group: "Terminal", scope: "terminal" },
  { id: "terminalCloseTab", label: "Close terminal tab", description: "Close the active terminal tab.", group: "Terminal", scope: "terminal" },
  { id: "terminalSettings", label: "Terminal settings", description: "Open settings from the terminal window.", group: "Terminal", scope: "terminal" },
  { id: "terminalCloseWindow", label: "Close terminal window", description: "Close the terminal window and its tabs.", group: "Terminal", scope: "terminal" },
  { id: "terminalTab1", label: "Select terminal tab 1", description: "Switch to the first terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab2", label: "Select terminal tab 2", description: "Switch to the second terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab3", label: "Select terminal tab 3", description: "Switch to the third terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab4", label: "Select terminal tab 4", description: "Switch to the fourth terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab5", label: "Select terminal tab 5", description: "Switch to the fifth terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab6", label: "Select terminal tab 6", description: "Switch to the sixth terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab7", label: "Select terminal tab 7", description: "Switch to the seventh terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab8", label: "Select terminal tab 8", description: "Switch to the eighth terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab9", label: "Select terminal tab 9", description: "Switch to the ninth terminal tab.", group: "Terminal tabs", scope: "terminal" },
  { id: "terminalTab10", label: "Select terminal tab 10", description: "Switch to the tenth terminal tab.", group: "Terminal tabs", scope: "terminal" },
] as const;

export type KeyboardShortcutAction = (typeof KEYBOARD_SHORTCUT_DEFINITIONS)[number]["id"];
export type KeyboardShortcutOverrides = Readonly<Partial<Record<Exclude<KeyboardShortcutAction, "commandPalette">, string>>>;

export interface KeyboardShortcutSettings {
  readonly commandPaletteShortcut: string;
  readonly keyboardShortcuts: KeyboardShortcutOverrides;
}

export interface KeyboardShortcutEvent {
  readonly key: string;
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
}

const ACTION_IDS = new Set<string>(KEYBOARD_SHORTCUT_DEFINITIONS.map(({ id }) => id));
const RENDERER_ONLY_ACTIONS = new Set<string>(["navigateBack", "navigateForward", "openConsole"]);
const MODIFIER_ORDER = ["mod", "alt", "shift"] as const;
const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/",
  Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`", Minus: "-", Equal: "=",
};
const RESERVED_SHORTCUTS = new Set([
  "alt+f4", "mod+a", "mod+c", "mod+v", "mod+shift+v", "mod+x", "mod+y", "mod+z", "mod+shift+z",
  "mod+h", "mod+alt+h", "mod+m", "mod+q", "mod+r", "mod+shift+r",
  "mod+-", "mod+=", "mod+shift+=", "mod+alt+i", "mod+shift+i", "f11", "f12",
]);

export function defaultKeyboardShortcut(action: KeyboardShortcutAction, apple: boolean): string {
  switch (action) {
    case "commandPalette": return "mod+k";
    case "newWindow": return "mod+n";
    case "duplicateWindow": return "mod+shift+n";
    case "navigateBack": return apple ? "mod+[" : "alt+arrowleft";
    case "navigateForward": return apple ? "mod+]" : "alt+arrowright";
    case "refreshServer": return "f5";
    case "textEditorOpen": return "mod+o";
    case "textEditorSaveAs": return "mod+shift+s";
    case "textEditorSave": return "mod+s";
    case "textEditorUndo": return "mod+z";
    case "textEditorRedo": return apple ? "mod+shift+z" : "mod+y";
    case "textEditorFind": return "mod+f";
    case "textEditorReplace": return "mod+alt+f";
    case "textEditorWordWrap": return "alt+z";
    case "textEditorCommandPalette": return "f1";
    case "openConsole":
    case "terminalNewTab": return "mod+t";
    case "terminalCloseTab": return "mod+w";
    case "terminalSettings": return "mod+,";
    case "terminalCloseWindow": return "mod+shift+w";
    default: return `mod+${Number(action.slice("terminalTab".length)) % 10}`;
  }
}

export function resolveKeyboardShortcut(
  action: KeyboardShortcutAction,
  settings: KeyboardShortcutSettings,
  apple: boolean,
): string {
  if (action === "commandPalette") return settings.commandPaletteShortcut;
  return settings.keyboardShortcuts[action] ?? defaultKeyboardShortcut(action, apple);
}

/** Canonical storage syntax. Assignment conflicts are checked separately so older preferences survive migrations. */
export function isKeyboardShortcut(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || value !== value.toLowerCase()) return false;
  const tokens = value.split("+");
  const key = tokens.at(-1);
  if (!key || !isShortcutKey(key)) return false;
  const modifiers = tokens.slice(0, -1);
  const expectedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.includes(modifier));
  if (modifiers.length !== expectedModifiers.length || modifiers.some((modifier, index) => modifier !== expectedModifiers[index])) return false;
  return modifiers.includes("mod") || modifiers.includes("alt") || (modifiers.length === 0 && isFunctionKey(key));
}

export function keyboardShortcutFromEvent(event: KeyboardShortcutEvent, apple: boolean): string | undefined {
  if (event.isComposing || (apple ? event.ctrlKey : event.metaKey)) return undefined;
  const key = normalizeShortcutKey(event.key, event.code ?? "");
  if (!key) return undefined;
  const shortcut = [
    ...((apple ? event.metaKey : event.ctrlKey) ? ["mod"] : []),
    ...(event.altKey ? ["alt"] : []),
    ...(event.shiftKey ? ["shift"] : []),
    key,
  ].join("+");
  return isKeyboardShortcut(shortcut) ? shortcut : undefined;
}

export function matchesKeyboardShortcut(shortcut: string, event: KeyboardShortcutEvent, apple: boolean): boolean {
  return isKeyboardShortcut(shortcut) && keyboardShortcutFromEvent(event, apple) === shortcut;
}

export function keyboardShortcutToAccelerator(shortcut: string): string {
  if (!isKeyboardShortcut(shortcut)) throw new TypeError("Invalid keyboard shortcut");
  return shortcut.split("+").map((token) => {
    if (token === "mod") return "CmdOrCtrl";
    if (token === "alt") return "Alt";
    if (token === "shift") return "Shift";
    if (token.startsWith("arrow")) return token.slice(5).replace(/^./u, (letter) => letter.toUpperCase());
    return token.toUpperCase();
  }).join("+");
}

export function keyboardShortcutConflict(
  action: KeyboardShortcutAction,
  shortcut: string,
  settings: KeyboardShortcutSettings,
  apple: boolean,
): string | undefined {
  if (!isKeyboardShortcut(shortcut)) return "Choose a modified letter, number, arrow or punctuation key, or a function key.";
  const definition = KEYBOARD_SHORTCUT_DEFINITIONS.find(({ id }) => id === action);
  if (!definition) return "Unknown keyboard shortcut action.";
  if (shortcut === "f5" && RENDERER_ONLY_ACTIONS.has(action)) {
    return "F5 is reserved for server refresh and native window commands.";
  }
  if (
    isReservedKeyboardShortcut(action, shortcut) ||
    (!apple && shortcut === "mod+shift+c") ||
    (definition.scope !== "terminal" && shortcut === "mod+w") ||
    (apple && (shortcut === "mod+`" || shortcut === "mod+shift+`"))
  ) {
    return "This shortcut is reserved for standard system or editing commands.";
  }
  const conflict = KEYBOARD_SHORTCUT_DEFINITIONS.find((candidate) => candidate.id !== action &&
    (definition.scope === "global" || candidate.scope === "global" || definition.scope === candidate.scope) &&
    resolveKeyboardShortcut(candidate.id, settings, apple) === shortcut);
  return conflict ? `This shortcut is already assigned to ${conflict.label}.` : undefined;
}

export function parseKeyboardShortcutOverrides(value: unknown): KeyboardShortcutOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid keyboard shortcuts");
  const result: Partial<Record<Exclude<KeyboardShortcutAction, "commandPalette">, string>> = {};
  for (const [id, shortcut] of Object.entries(value)) {
    if (id === "commandPalette" || !ACTION_IDS.has(id) || !isKeyboardShortcut(shortcut) || isReservedKeyboardShortcut(id, shortcut) ||
      (shortcut === "f5" && RENDERER_ONLY_ACTIONS.has(id))) {
      throw new TypeError("Invalid keyboard shortcuts");
    }
    result[id as Exclude<KeyboardShortcutAction, "commandPalette">] = shortcut;
  }
  return Object.freeze(result);
}

export function keyboardShortcutsEqual(a: KeyboardShortcutOverrides, b: KeyboardShortcutOverrides): boolean {
  const keys = Object.keys(a) as (keyof KeyboardShortcutOverrides)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function normalizeShortcutKey(key: string, code: string): string | undefined {
  // Keep number-row tab shortcuts distinct from terminal keypad input.
  if (code.startsWith("Numpad")) return undefined;
  const normalized = key.toLowerCase();
  if (isShortcutKey(normalized)) return normalized;
  const letter = /^Key([A-Z])$/u.exec(code)?.[1];
  if (letter) return letter.toLowerCase();
  const digit = /^Digit([0-9])$/u.exec(code)?.[1];
  if (digit) return digit;
  if (isFunctionKey(code.toLowerCase())) return code.toLowerCase();
  return PUNCTUATION_CODES[code];
}

function isShortcutKey(value: string): boolean {
  return /^[a-z0-9]$/u.test(value) || isFunctionKey(value) ||
    /^arrow(?:left|right|up|down)$/u.test(value) || Object.values(PUNCTUATION_CODES).includes(value);
}

function isFunctionKey(value: string): boolean {
  return /^f(?:[1-9]|1[0-9]|2[0-4])$/u.test(value);
}

function isReservedKeyboardShortcut(action: string, shortcut: string): boolean {
  if (!RESERVED_SHORTCUTS.has(shortcut)) return false;
  if (action === "textEditorUndo" && shortcut === "mod+z") return false;
  if (action === "textEditorRedo" && (shortcut === "mod+shift+z" || shortcut === "mod+y")) return false;
  return true;
}
