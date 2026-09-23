import {
  CONSOLE_TERMINAL_FONTS,
  isConsoleTerminalFontId,
  type ConsoleTerminalFontId,
} from "./application-settings-contracts.js";

export const TEXT_EDITOR_SETTINGS_VERSION = 1 as const;
export const TEXT_EDITOR_FONT_SIZE_MIN = 8;
export const TEXT_EDITOR_FONT_SIZE_MAX = 32;
export const TEXT_EDITOR_TAB_SIZE_MIN = 1;
export const TEXT_EDITOR_TAB_SIZE_MAX = 8;

/** The standalone editor reuses every monospace font already bundled for terminals. */
export const TEXT_EDITOR_FONTS = CONSOLE_TERMINAL_FONTS;

export type TextEditorFontId = ConsoleTerminalFontId;
export type TextEditorLineNumbers = "on" | "relative" | "off";
export type TextEditorRenderWhitespace = "none" | "selection" | "boundary" | "trailing" | "all";

export interface TextEditorSettingsValues {
  readonly fontId: TextEditorFontId;
  readonly fontSize: number;
  readonly tabSize: number;
  readonly insertSpaces: boolean;
  readonly minimap: boolean;
  readonly wordWrap: boolean;
  readonly lineNumbers: TextEditorLineNumbers;
  readonly renderWhitespace: TextEditorRenderWhitespace;
  readonly stickyScroll: boolean;
  readonly bracketPairColorization: boolean;
  readonly fontLigatures: boolean;
}

export interface TextEditorSettingsState extends TextEditorSettingsValues {
  readonly v: typeof TEXT_EDITOR_SETTINGS_VERSION;
  readonly revision: number;
}

export interface TextEditorSettingsUpdateInput {
  readonly expectedRevision: number;
  readonly settings: TextEditorSettingsValues;
}

export const DEFAULT_TEXT_EDITOR_SETTINGS_VALUES: TextEditorSettingsValues = Object.freeze({
  fontId: "fira-code",
  fontSize: 13,
  tabSize: 2,
  insertSpaces: true,
  minimap: true,
  wordWrap: false,
  lineNumbers: "on",
  renderWhitespace: "selection",
  stickyScroll: false,
  bracketPairColorization: true,
  fontLigatures: false,
});

/** Concise UI-facing alias for the persisted values without version metadata. */
export const DEFAULT_TEXT_EDITOR_SETTINGS = DEFAULT_TEXT_EDITOR_SETTINGS_VALUES;

export const DEFAULT_TEXT_EDITOR_SETTINGS_STATE: TextEditorSettingsState = Object.freeze({
  v: TEXT_EDITOR_SETTINGS_VERSION,
  revision: 0,
  ...DEFAULT_TEXT_EDITOR_SETTINGS_VALUES,
});

const LINE_NUMBER_VALUES = new Set<TextEditorLineNumbers>(["on", "relative", "off"]);
const RENDER_WHITESPACE_VALUES = new Set<TextEditorRenderWhitespace>([
  "none",
  "selection",
  "boundary",
  "trailing",
  "all",
]);
const SETTINGS_VALUE_KEYS = [
  "fontId",
  "fontSize",
  "tabSize",
  "insertSpaces",
  "minimap",
  "wordWrap",
  "lineNumbers",
  "renderWhitespace",
  "stickyScroll",
  "bracketPairColorization",
  "fontLigatures",
] as const;
const SETTINGS_STATE_KEYS = ["v", "revision", ...SETTINGS_VALUE_KEYS] as const;
const UPDATE_INPUT_KEYS = ["expectedRevision", "settings"] as const;

export function isTextEditorFontId(value: unknown): value is TextEditorFontId {
  return isConsoleTerminalFontId(value);
}

export function isTextEditorLineNumbers(value: unknown): value is TextEditorLineNumbers {
  return typeof value === "string" && LINE_NUMBER_VALUES.has(value as TextEditorLineNumbers);
}

export function isTextEditorRenderWhitespace(value: unknown): value is TextEditorRenderWhitespace {
  return typeof value === "string" && RENDER_WHITESPACE_VALUES.has(value as TextEditorRenderWhitespace);
}

export function parseTextEditorSettingsValues(value: unknown): TextEditorSettingsValues {
  if (!hasExactKeys(value, SETTINGS_VALUE_KEYS)) throw new TypeError("Invalid text editor settings");
  if (
    !isTextEditorFontId(value["fontId"]) ||
    !isBoundedInteger(value["fontSize"], TEXT_EDITOR_FONT_SIZE_MIN, TEXT_EDITOR_FONT_SIZE_MAX) ||
    !isBoundedInteger(value["tabSize"], TEXT_EDITOR_TAB_SIZE_MIN, TEXT_EDITOR_TAB_SIZE_MAX) ||
    typeof value["insertSpaces"] !== "boolean" ||
    typeof value["minimap"] !== "boolean" ||
    typeof value["wordWrap"] !== "boolean" ||
    !isTextEditorLineNumbers(value["lineNumbers"]) ||
    !isTextEditorRenderWhitespace(value["renderWhitespace"]) ||
    typeof value["stickyScroll"] !== "boolean" ||
    typeof value["bracketPairColorization"] !== "boolean" ||
    typeof value["fontLigatures"] !== "boolean"
  ) {
    throw new TypeError("Invalid text editor settings");
  }
  return Object.freeze({
    fontId: value["fontId"],
    fontSize: value["fontSize"] as number,
    tabSize: value["tabSize"] as number,
    insertSpaces: value["insertSpaces"],
    minimap: value["minimap"],
    wordWrap: value["wordWrap"],
    lineNumbers: value["lineNumbers"],
    renderWhitespace: value["renderWhitespace"],
    stickyScroll: value["stickyScroll"],
    bracketPairColorization: value["bracketPairColorization"],
    fontLigatures: value["fontLigatures"],
  });
}

export function parseTextEditorSettingsState(value: unknown): TextEditorSettingsState {
  if (
    !hasExactKeys(value, SETTINGS_STATE_KEYS) ||
    value["v"] !== TEXT_EDITOR_SETTINGS_VERSION ||
    !isRevision(value["revision"])
  ) {
    throw new TypeError("Invalid text editor settings state");
  }
  let settings: TextEditorSettingsValues;
  try {
    settings = parseTextEditorSettingsValues(Object.fromEntries(
      SETTINGS_VALUE_KEYS.map((key) => [key, value[key]]),
    ));
  } catch {
    throw new TypeError("Invalid text editor settings state");
  }
  return Object.freeze({
    v: TEXT_EDITOR_SETTINGS_VERSION,
    revision: value["revision"] as number,
    ...settings,
  });
}

export function parsePersistedTextEditorSettingsState(value: unknown): TextEditorSettingsState {
  try {
    return parseTextEditorSettingsState(value);
  } catch {
    throw new TypeError("Invalid persisted text editor settings state");
  }
}

export function parseTextEditorSettingsUpdateInput(value: unknown): TextEditorSettingsUpdateInput {
  if (!hasExactKeys(value, UPDATE_INPUT_KEYS) || !isRevision(value["expectedRevision"])) {
    throw new TypeError("Invalid text editor settings update");
  }
  let settings: TextEditorSettingsValues;
  try {
    settings = parseTextEditorSettingsValues(value["settings"]);
  } catch {
    throw new TypeError("Invalid text editor settings update");
  }
  return Object.freeze({
    expectedRevision: value["expectedRevision"] as number,
    settings,
  });
}

function isRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function hasExactKeys<const Key extends string>(
  value: unknown,
  keys: readonly Key[],
): value is Record<Key, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
