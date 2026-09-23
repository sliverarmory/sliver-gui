import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEXT_EDITOR_SETTINGS,
  DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
  DEFAULT_TEXT_EDITOR_SETTINGS_VALUES,
  isTextEditorFontId,
  isTextEditorLineNumbers,
  isTextEditorRenderWhitespace,
  parsePersistedTextEditorSettingsState,
  parseTextEditorSettingsState,
  parseTextEditorSettingsUpdateInput,
  parseTextEditorSettingsValues,
  TEXT_EDITOR_FONTS,
  TEXT_EDITOR_FONT_SIZE_MAX,
  TEXT_EDITOR_FONT_SIZE_MIN,
  TEXT_EDITOR_SETTINGS_VERSION,
  TEXT_EDITOR_TAB_SIZE_MAX,
  TEXT_EDITOR_TAB_SIZE_MIN,
  type TextEditorSettingsValues,
} from "./text-editor-settings-contracts.js";

const settings: TextEditorSettingsValues = {
  fontId: "jetbrains-mono",
  fontSize: 17,
  tabSize: 4,
  insertSpaces: false,
  minimap: false,
  wordWrap: true,
  lineNumbers: "relative",
  renderWhitespace: "all",
  stickyScroll: true,
  bracketPairColorization: false,
  fontLigatures: true,
};

describe("text editor settings contracts", () => {
  it("defines frozen behavior-preserving defaults and every bundled terminal font", () => {
    expect(DEFAULT_TEXT_EDITOR_SETTINGS).toBe(DEFAULT_TEXT_EDITOR_SETTINGS_VALUES);
    expect(DEFAULT_TEXT_EDITOR_SETTINGS_STATE).toEqual({
      v: 1,
      revision: 0,
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
    expect(Object.isFrozen(DEFAULT_TEXT_EDITOR_SETTINGS_VALUES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_TEXT_EDITOR_SETTINGS_STATE)).toBe(true);
    expect(TEXT_EDITOR_FONTS).toEqual([
      { id: "fira-code", label: "Fira Code", family: "Fira Code" },
      { id: "jetbrains-mono", label: "JetBrains Mono", family: "JetBrains Mono" },
      { id: "cascadia-mono", label: "Cascadia Mono", family: "Cascadia Mono" },
      { id: "source-code-pro", label: "Source Code Pro", family: "Source Code Pro" },
    ]);
  });

  it("strictly parses and freezes values, versioned state and revision-bound updates", () => {
    const values = parseTextEditorSettingsValues(settings);
    const state = parseTextEditorSettingsState({
      v: TEXT_EDITOR_SETTINGS_VERSION,
      revision: 7,
      ...settings,
    });
    const persisted = parsePersistedTextEditorSettingsState(state);
    const update = parseTextEditorSettingsUpdateInput({ expectedRevision: 7, settings });

    expect(values).toEqual(settings);
    expect(state).toEqual({ v: 1, revision: 7, ...settings });
    expect(persisted).toEqual(state);
    expect(update).toEqual({ expectedRevision: 7, settings });
    expect(Object.isFrozen(values)).toBe(true);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(update)).toBe(true);
    expect(Object.isFrozen(update.settings)).toBe(true);
  });

  it.each(TEXT_EDITOR_FONTS)("accepts the bundled $label font", ({ id }) => {
    expect(isTextEditorFontId(id)).toBe(true);
    expect(parseTextEditorSettingsValues({ ...settings, fontId: id }).fontId).toBe(id);
  });

  it.each(["on", "relative", "off"])("accepts the %s line-number mode", (lineNumbers) => {
    expect(isTextEditorLineNumbers(lineNumbers)).toBe(true);
    expect(parseTextEditorSettingsValues({ ...settings, lineNumbers }).lineNumbers).toBe(lineNumbers);
  });

  it.each(["none", "selection", "boundary", "trailing", "all"])(
    "accepts the %s whitespace mode",
    (renderWhitespace) => {
      expect(isTextEditorRenderWhitespace(renderWhitespace)).toBe(true);
      expect(parseTextEditorSettingsValues({ ...settings, renderWhitespace }).renderWhitespace).toBe(renderWhitespace);
    },
  );

  it.each([
    [TEXT_EDITOR_FONT_SIZE_MIN, TEXT_EDITOR_TAB_SIZE_MIN],
    [TEXT_EDITOR_FONT_SIZE_MAX, TEXT_EDITOR_TAB_SIZE_MAX],
  ])("accepts bounded font size %i and tab size %i", (fontSize, tabSize) => {
    expect(parseTextEditorSettingsValues({ ...settings, fontSize, tabSize })).toMatchObject({ fontSize, tabSize });
  });

  it.each([
    null,
    [],
    { ...settings, extra: true },
    { ...settings, fontId: "system" },
    { ...settings, fontSize: TEXT_EDITOR_FONT_SIZE_MIN - 1 },
    { ...settings, fontSize: TEXT_EDITOR_FONT_SIZE_MAX + 1 },
    { ...settings, fontSize: 13.5 },
    { ...settings, tabSize: TEXT_EDITOR_TAB_SIZE_MIN - 1 },
    { ...settings, tabSize: TEXT_EDITOR_TAB_SIZE_MAX + 1 },
    { ...settings, tabSize: 2.5 },
    { ...settings, insertSpaces: "yes" },
    { ...settings, minimap: 1 },
    { ...settings, wordWrap: "on" },
    { ...settings, lineNumbers: "interval" },
    { ...settings, renderWhitespace: "everywhere" },
    { ...settings, stickyScroll: null },
    { ...settings, bracketPairColorization: "yes" },
    { ...settings, fontLigatures: 1 },
  ])("rejects invalid text editor values %#", (value) => {
    expect(() => parseTextEditorSettingsValues(value)).toThrow("Invalid text editor settings");
  });

  it.each([
    { v: 2, revision: 0, ...settings },
    { v: 1, revision: -1, ...settings },
    { v: 1, revision: 1.5, ...settings },
    { v: 1, revision: 0, ...settings, extra: true },
    { v: 1, revision: 0, ...settings, fontId: "system" },
  ])("rejects invalid state %#", (value) => {
    expect(() => parseTextEditorSettingsState(value)).toThrow("Invalid text editor settings state");
    expect(() => parsePersistedTextEditorSettingsState(value)).toThrow("Invalid persisted text editor settings state");
  });

  it.each([
    { settings },
    { expectedRevision: -1, settings },
    { expectedRevision: 0, settings, extra: true },
    { expectedRevision: 0, settings: { ...settings, extra: true } },
    { expectedRevision: 0, settings: { ...settings, fontSize: 100 } },
  ])("rejects invalid update input %#", (value) => {
    expect(() => parseTextEditorSettingsUpdateInput(value)).toThrow("Invalid text editor settings update");
  });
});
