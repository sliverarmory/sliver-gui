import { describe, expect, it } from "vitest";

import {
  KEYBOARD_SHORTCUT_DEFINITIONS,
  defaultKeyboardShortcut,
  isKeyboardShortcut,
  keyboardShortcutConflict,
  keyboardShortcutFromEvent,
  keyboardShortcutToAccelerator,
  keyboardShortcutsEqual,
  matchesKeyboardShortcut,
  parseKeyboardShortcutOverrides,
  resolveKeyboardShortcut,
  type KeyboardShortcutEvent,
  type KeyboardShortcutSettings,
} from "./keyboard-shortcuts.js";

const defaults: KeyboardShortcutSettings = { commandPaletteShortcut: "mod+k", keyboardShortcuts: {} };

function event(overrides: Partial<KeyboardShortcutEvent> = {}): KeyboardShortcutEvent {
  return { key: "k", code: "KeyK", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe("keyboard shortcut catalog", () => {
  it.each([true, false])("keeps all original defaults valid without overlapping active actions (Apple: %s)", (apple) => {
    for (const { id } of KEYBOARD_SHORTCUT_DEFINITIONS) {
      const shortcut = defaultKeyboardShortcut(id, apple);
      expect(isKeyboardShortcut(shortcut)).toBe(true);
      expect(resolveKeyboardShortcut(id, defaults, apple)).toBe(shortcut);
      expect(keyboardShortcutConflict(id, shortcut, defaults, apple)).toBeUndefined();
    }
    expect(defaultKeyboardShortcut("navigateBack", apple)).toBe(apple ? "mod+[" : "alt+arrowleft");
    expect(defaultKeyboardShortcut("navigateForward", apple)).toBe(apple ? "mod+]" : "alt+arrowright");
    expect(defaultKeyboardShortcut("textEditorOpen", apple)).toBe("mod+o");
    expect(defaultKeyboardShortcut("textEditorSaveAs", apple)).toBe("mod+shift+s");
    expect(defaultKeyboardShortcut("textEditorSave", apple)).toBe("mod+s");
    expect(defaultKeyboardShortcut("textEditorUndo", apple)).toBe("mod+z");
    expect(defaultKeyboardShortcut("textEditorRedo", apple)).toBe(apple ? "mod+shift+z" : "mod+y");
    expect(defaultKeyboardShortcut("textEditorFind", apple)).toBe("mod+f");
    expect(defaultKeyboardShortcut("textEditorReplace", apple)).toBe("mod+alt+f");
    expect(defaultKeyboardShortcut("textEditorWordWrap", apple)).toBe("alt+z");
    expect(defaultKeyboardShortcut("textEditorCommandPalette", apple)).toBe("f1");
    expect(defaultKeyboardShortcut("terminalTab10", apple)).toBe("mod+0");
  });

  it("resolves overrides independently and preserves the existing palette field", () => {
    const settings = { commandPaletteShortcut: "mod+shift+p", keyboardShortcuts: { newWindow: "mod+alt+n" } };
    expect(resolveKeyboardShortcut("newWindow", settings, true)).toBe("mod+alt+n");
    expect(resolveKeyboardShortcut("commandPalette", settings, true)).toBe("mod+shift+p");
    expect(resolveKeyboardShortcut("duplicateWindow", settings, true)).toBe("mod+shift+n");
  });

  it("detects global and local conflicts while permitting different window scopes", () => {
    expect(keyboardShortcutConflict("commandPalette", "mod+n", defaults, true)).toContain("New window");
    expect(keyboardShortcutConflict("terminalCloseTab", "mod+1", defaults, true)).toContain("Select terminal tab 1");
    expect(keyboardShortcutConflict("refreshServer", "mod+k", defaults, true)).toContain("Open command palette");
    expect(keyboardShortcutConflict("openConsole", "mod+t", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("terminalNewTab", "mod+t", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("commandPalette", "mod+s", defaults, true)).toContain("Save file");
    expect(keyboardShortcutConflict("terminalNewTab", "mod+s", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("commandPalette", "mod+n", {
      ...defaults, keyboardShortcuts: { newWindow: "mod+alt+n" },
    }, true)).toBeUndefined();
  });

  it("checks platform-specific defaults when detecting conflicts", () => {
    expect(keyboardShortcutConflict("commandPalette", "mod+[", defaults, true)).toContain("Go back");
    expect(keyboardShortcutConflict("commandPalette", "mod+[", defaults, false)).toBeUndefined();
    expect(keyboardShortcutConflict("commandPalette", "alt+arrowleft", defaults, false)).toContain("Go back");
    expect(keyboardShortcutConflict("commandPalette", "mod+shift+c", defaults, false)).toContain("reserved");
    expect(keyboardShortcutConflict("commandPalette", "mod+shift+c", defaults, true)).toBeUndefined();
  });

  it("preserves native window commands while allowing the terminal's owned close binding", () => {
    expect(keyboardShortcutConflict("refreshServer", "mod+w", defaults, true)).toContain("reserved");
    expect(keyboardShortcutConflict("openConsole", "mod+w", defaults, false)).toContain("reserved");
    expect(keyboardShortcutConflict("newWindow", "mod+w", defaults, true)).toContain("reserved");
    expect(keyboardShortcutConflict("terminalCloseTab", "mod+w", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("terminalCloseTab", "mod+w", defaults, false)).toBeUndefined();
    expect(keyboardShortcutConflict("refreshServer", "mod+`", defaults, true)).toContain("reserved");
    expect(keyboardShortcutConflict("refreshServer", "mod+shift+`", defaults, true)).toContain("reserved");
    expect(keyboardShortcutConflict("refreshServer", "mod+`", defaults, false)).toBeUndefined();
  });

  it.each(["navigateBack", "navigateForward", "openConsole"] as const)("keeps F5 from reloading behind a blocked %s action", (action) => {
    const settings = { ...defaults, keyboardShortcuts: { refreshServer: "f6" } };
    expect(keyboardShortcutConflict(action, "f5", settings, true)).toBe("F5 is reserved for server refresh and native window commands.");
    expect(keyboardShortcutConflict(action, "f5", settings, false)).toBe("F5 is reserved for server refresh and native window commands.");
    expect(() => parseKeyboardShortcutOverrides({ [action]: "f5" })).toThrow("Invalid keyboard shortcuts");
  });

  it("allows F5 for native window commands after the refresh binding changes", () => {
    const settings = { ...defaults, keyboardShortcuts: { refreshServer: "f6" } };
    expect(keyboardShortcutConflict("newWindow", "f5", settings, true)).toBeUndefined();
    expect(parseKeyboardShortcutOverrides({ newWindow: "f5", refreshServer: "f6" })).toEqual({ newWindow: "f5", refreshServer: "f6" });
    expect(keyboardShortcutConflict("refreshServer", "f5", defaults, true)).toBeUndefined();
  });

  it.each(["mod+c", "mod+v", "mod+shift+v", "mod+z", "mod+shift+z", "mod+a", "mod+q", "mod+m", "mod+r", "mod+shift+r", "mod+-", "mod+=", "mod+shift+i", "mod+alt+i", "alt+f4", "f11", "f12"])("protects system shortcut %s from new assignments", (shortcut) => {
    expect(keyboardShortcutConflict("refreshServer", shortcut, defaults, true)).toContain("reserved");
    expect(() => parseKeyboardShortcutOverrides({ refreshServer: shortcut })).toThrow("Invalid keyboard shortcuts");
  });

  it("allows only the text editor's owned undo and redo bindings through the reserved-shortcut guard", () => {
    expect(keyboardShortcutConflict("textEditorUndo", "mod+z", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("textEditorRedo", "mod+shift+z", defaults, true)).toBeUndefined();
    expect(keyboardShortcutConflict("textEditorRedo", "mod+y", defaults, false)).toBeUndefined();
    expect(parseKeyboardShortcutOverrides({
      textEditorUndo: "mod+z",
      textEditorRedo: "mod+shift+z",
    })).toEqual({ textEditorUndo: "mod+z", textEditorRedo: "mod+shift+z" });
    expect(keyboardShortcutConflict("textEditorFind", "mod+z", defaults, true)).toContain("reserved");
    expect(() => parseKeyboardShortcutOverrides({ textEditorFind: "mod+z" })).toThrow("Invalid keyboard shortcuts");
  });
});

describe("keyboard shortcut event handling", () => {
  it("uses Command on macOS and Ctrl elsewhere with exact modifiers", () => {
    expect(keyboardShortcutFromEvent(event({ metaKey: true }), true)).toBe("mod+k");
    expect(keyboardShortcutFromEvent(event({ ctrlKey: true }), false)).toBe("mod+k");
    expect(matchesKeyboardShortcut("mod+k", event({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(keyboardShortcutFromEvent(event({ ctrlKey: true }), true)).toBeUndefined();
    expect(keyboardShortcutFromEvent(event({ metaKey: true }), false)).toBeUndefined();
    expect(keyboardShortcutFromEvent(event({ metaKey: true, ctrlKey: true }), true)).toBeUndefined();
    expect(keyboardShortcutFromEvent(event({ metaKey: true, isComposing: true }), true)).toBeUndefined();
    expect(matchesKeyboardShortcut("mod+1", event({ metaKey: true, key: "1", code: "Numpad1" }), true)).toBe(false);
  });

  it("normalizes shifted punctuation and non-ASCII Alt keys using physical key codes", () => {
    expect(keyboardShortcutFromEvent(event({ metaKey: true, shiftKey: true, key: "{", code: "BracketLeft" }), true)).toBe("mod+shift+[");
    expect(keyboardShortcutFromEvent(event({ metaKey: true, shiftKey: true, key: "!", code: "Digit1" }), true)).toBe("mod+shift+1");
    expect(keyboardShortcutFromEvent(event({ metaKey: true, altKey: true, key: "π", code: "KeyP" }), true)).toBe("mod+alt+p");
    expect(keyboardShortcutFromEvent(event({ key: "ArrowLeft", code: "ArrowLeft", altKey: true }), false)).toBe("alt+arrowleft");
    expect(keyboardShortcutFromEvent(event({ key: "F5", code: "F5" }), false)).toBe("f5");
  });

  it.each([
    event(),
    event({ shiftKey: true }),
    event({ key: "Escape", code: "Escape", metaKey: true }),
    event({ key: "Control", code: "ControlLeft", ctrlKey: true }),
    event({ key: " ", code: "Space", metaKey: true }),
  ])("does not record plain typing, modifier keys, Escape, or system spaces %#", (input) => {
    expect(keyboardShortcutFromEvent(input, true)).toBeUndefined();
  });

  it.each([
    ["mod+shift+n", "CmdOrCtrl+Shift+N"],
    ["alt+arrowleft", "Alt+Left"],
    ["mod+,", "CmdOrCtrl+,"],
    ["mod+[", "CmdOrCtrl+["],
    ["f5", "F5"],
  ])("translates %s to the native accelerator %s", (shortcut, accelerator) => {
    expect(keyboardShortcutToAccelerator(shortcut)).toBe(accelerator);
  });
});

describe("keyboard shortcut overrides", () => {
  it("parses and freezes a bounded map without modifying the input", () => {
    const input = { newWindow: "mod+alt+n", terminalSettings: "mod+;", refreshServer: "f6" };
    const parsed = parseKeyboardShortcutOverrides(input);
    expect(parsed).toEqual(input);
    expect(parsed).not.toBe(input);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it.each([null, [], { commandPalette: "mod+p" }, { typo: "mod+p" }, { newWindow: undefined }, { newWindow: "Mod+P" }, { newWindow: "alt+mod+p" }, { newWindow: "mod+mod+p" }, { newWindow: "shift+p" }, { newWindow: "p" }, { newWindow: "mod+escape" }, { newWindow: "mod+ " }])("rejects unknown actions and malformed bindings %#", (value) => {
    expect(() => parseKeyboardShortcutOverrides(value)).toThrow("Invalid keyboard shortcuts");
  });

  it("compares maps by their contents, independently of insertion order", () => {
    expect(keyboardShortcutsEqual({ newWindow: "mod+p", refreshServer: "f6" }, { refreshServer: "f6", newWindow: "mod+p" })).toBe(true);
    expect(keyboardShortcutsEqual({ newWindow: "mod+p" }, {})).toBe(false);
    expect(keyboardShortcutsEqual({ newWindow: "mod+p" }, { newWindow: "mod+o" })).toBe(false);
  });
});
