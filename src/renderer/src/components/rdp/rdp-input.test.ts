import { describe, expect, it } from "vitest";
import { DesktopKeyboard, desktopPoint, specialKeyInputs, unicodeInputs } from "./rdp-input";

function key(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: "a", code: "KeyA", ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false, repeat: false,
    getModifierState: () => false, ...overrides } as KeyboardEvent;
}

describe("remote desktop input", () => {
  it("sends layout-aware Unicode including supplementary characters with paired transitions", () => {
    const keyboard = new DesktopKeyboard();
    expect(keyboard.keyDown(key({ key: "é" }))).toEqual([{ kind: "unicode", codePoint: 233, down: true }, { kind: "unicode", codePoint: 233, down: false }]);
    expect(unicodeInputs("😀")).toEqual([{ kind: "unicode", codePoint: 0x1f600, down: true }, { kind: "unicode", codePoint: 0x1f600, down: false }]);
    expect(keyboard.keyUp(key())).toEqual([]);
    expect(unicodeInputs("\u0000\ud800")).toEqual([]);
  });

  it("uses physical extended scancodes for shortcuts and releases only pressed keys", () => {
    const keyboard = new DesktopKeyboard();
    expect(keyboard.keyDown(key({ key: "Control", code: "ControlRight", ctrlKey: true }))).toEqual([{ kind: "key", scanCode: 0x1d, extended: true, down: true }]);
    expect(keyboard.keyDown(key({ ctrlKey: true }))).toEqual([{ kind: "key", scanCode: 0x1e, extended: false, down: true }]);
    expect(keyboard.keyUp(key())).toEqual([{ kind: "key", scanCode: 0x1e, extended: false, down: false }]);
    keyboard.releaseAll();
    expect(keyboard.keyUp(key({ code: "ControlRight" }))).toEqual([]);
  });

  it("maps a macOS Command-R gesture to the complete Windows Run shortcut", () => {
    const keyboard = new DesktopKeyboard();
    expect([
      ...keyboard.keyDown(key({ key: "Meta", code: "MetaLeft", metaKey: true })),
      ...keyboard.keyDown(key({ key: "r", code: "KeyR", metaKey: true })),
      ...keyboard.keyUp(key({ code: "KeyR" })),
      ...keyboard.keyUp(key({ code: "MetaLeft" })),
    ]).toEqual([
      { kind: "key", scanCode: 0x5b, extended: true, down: true },
      { kind: "key", scanCode: 0x13, extended: false, down: true },
      { kind: "key", scanCode: 0x13, extended: false, down: false },
      { kind: "key", scanCode: 0x5b, extended: true, down: false },
    ]);
  });

  it("leaves composition to the text-input path and does not repeat modifiers", () => {
    const keyboard = new DesktopKeyboard();
    expect(keyboard.keyDown(key({ isComposing: true }))).toEqual([]);
    expect(keyboard.keyDown(key({ key: "Dead" }))).toEqual([]);
    expect(keyboard.keyDown(key({ key: "Shift", code: "ShiftLeft", repeat: true }))).toEqual([]);
    expect(keyboard.keyDown(key({ key: "@", ctrlKey: true, altKey: true, getModifierState: (name) => name === "AltGraph" }))[0]).toEqual({ kind: "unicode", codePoint: 64, down: true });
  });

  it("maps high-DPI/scaled coordinates and clamps captured drags to the desktop", () => {
    expect(desktopPoint(510, 270, { left: 10, top: 20, width: 1000, height: 500 }, 2000, 1000)).toEqual({ x: 1000, y: 500 });
    expect(desktopPoint(-5, 900, { left: 10, top: 20, width: 1000, height: 500 }, 2000, 1000)).toEqual({ x: 0, y: 999 });
    expect(desktopPoint(1, 2, { left: 0, top: 0, width: 0, height: 100 }, 2000, 1000)).toBeUndefined();
    expect(desktopPoint(NaN, 2, { left: 0, top: 0, width: 100, height: 100 }, 2000, 1000)).toBeUndefined();
  });

  it("releases secure-attention modifiers in reverse order", () => {
    expect(specialKeyInputs("ctrl-alt-delete")).toEqual([
      { kind: "key", scanCode: 0x1d, extended: false, down: true },
      { kind: "key", scanCode: 0x38, extended: false, down: true },
      { kind: "key", scanCode: 0x53, extended: true, down: true },
      { kind: "key", scanCode: 0x53, extended: true, down: false },
      { kind: "key", scanCode: 0x38, extended: false, down: false },
      { kind: "key", scanCode: 0x1d, extended: false, down: false },
    ]);
  });
});
