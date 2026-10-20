import type { RdpInputEvent } from "../../../../shared/rdp-contracts";

interface KeyboardInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  getModifierState?(key: string): boolean;
}

const SCAN_CODES: Readonly<Record<string, number>> = {
  Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05,
  Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a,
  Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14,
  KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22,
  KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27,
  Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30,
  KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35,
  ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39,
  CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e,
  F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44,
  NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48,
  Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c,
  Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50,
  Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, IntlBackslash: 0x56,
  F11: 0x57, F12: 0x58, NumpadEnter: 0xe01c, ControlRight: 0xe01d,
  NumpadDivide: 0xe035, PrintScreen: 0xe037, AltRight: 0xe038,
  Home: 0xe047, ArrowUp: 0xe048, PageUp: 0xe049, ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d, End: 0xe04f, ArrowDown: 0xe050, PageDown: 0xe051,
  Insert: 0xe052, Delete: 0xe053, MetaLeft: 0xe05b, MetaRight: 0xe05c,
  ContextMenu: 0xe05d,
};

export class DesktopKeyboard {
  readonly #pressed = new Map<string, number>();

  keyDown(event: KeyboardInput): readonly RdpInputEvent[] {
    if (event.isComposing || event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") return [];
    const altGraph = event.getModifierState?.("AltGraph") === true;
    if ([...event.key].length === 1 && ((!event.ctrlKey && !event.altKey && !event.metaKey) || altGraph)) {
      // Unicode preserves the locally chosen keyboard layout. Physical scancodes
      // remain necessary for shortcuts, navigation and modifier transitions.
      return unicodeInputs(event.key);
    }
    const code = SCAN_CODES[event.code];
    if (code === undefined) return [];
    if (event.repeat && /^(Control|Shift|Alt|Meta)/u.test(event.code)) return [];
    this.#pressed.set(event.code, code);
    return [scanCodeInput(code, true)];
  }

  keyUp(event: Pick<KeyboardInput, "code">): readonly RdpInputEvent[] {
    const code = this.#pressed.get(event.code);
    if (code === undefined) return [];
    this.#pressed.delete(event.code);
    return [scanCodeInput(code, false)];
  }

  releaseAll(): void {
    this.#pressed.clear();
  }
}

function scanCodeInput(code: number, down: boolean): RdpInputEvent {
  return { kind: "key", scanCode: code & 0xff, extended: code > 0xff, down };
}

export function desktopPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  width: number,
  height: number,
): { x: number; y: number } | undefined {
  if (bounds.width <= 0 || bounds.height <= 0 || width < 1 || height < 1 ||
    ![clientX, clientY, bounds.left, bounds.top, bounds.width, bounds.height, width, height].every(Number.isFinite)) return undefined;
  return {
    x: Math.min(width - 1, Math.max(0, Math.floor((clientX - bounds.left) * width / bounds.width))),
    y: Math.min(height - 1, Math.max(0, Math.floor((clientY - bounds.top) * height / bounds.height))),
  };
}

export function specialKeyInputs(kind: "ctrl-alt-delete" | "windows"): readonly RdpInputEvent[] {
  const codes = kind === "windows" ? [0xe05b] : [0x1d, 0x38, 0xe053];
  return [...codes.map((code) => scanCodeInput(code, true)), ...[...codes].reverse().map((code) => scanCodeInput(code, false))];
}

export function unicodeInputs(text: string): readonly RdpInputEvent[] {
  return [...text].flatMap((character): RdpInputEvent[] => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint < 0x20 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return [];
    return [{ kind: "unicode", codePoint, down: true }, { kind: "unicode", codePoint, down: false }];
  });
}
