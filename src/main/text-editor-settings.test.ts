// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
  DEFAULT_TEXT_EDITOR_SETTINGS_VALUES,
  type TextEditorSettingsUpdateInput,
  type TextEditorSettingsValues,
} from "../shared/text-editor-settings-contracts.js";
import {
  STALE_TEXT_EDITOR_SETTINGS_ERROR,
  TEXT_EDITOR_SETTINGS_MAX_BYTES,
  TextEditorSettingsStore,
} from "./text-editor-settings.js";

let temporaryDirectory = "";
let settingsPath = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-text-editor-settings-"));
  settingsPath = join(temporaryDirectory, "text-editor-settings.json");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("TextEditorSettingsStore", () => {
  it("uses the frozen defaults when the explicit file is missing", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);

    expect(store.filePath).toBe(settingsPath);
    expect(store.getState()).toBe(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
    expect(Object.isFrozen(store.getState())).toBe(true);
  });

  it("loads an exact private version-one file", async () => {
    const persisted = {
      v: 1,
      revision: 9,
      fontId: "source-code-pro",
      fontSize: 18,
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
    await writeFile(settingsPath, JSON.stringify(persisted), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await TextEditorSettingsStore.load(settingsPath);

    expect(store.getState()).toEqual(persisted);
    expect(Object.isFrozen(store.getState())).toBe(true);
  });

  it.each([
    "not-json",
    JSON.stringify({ v: 2 }),
    JSON.stringify({ ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, extra: true }),
    JSON.stringify({ ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE, fontId: "system" }),
    "x".repeat(TEXT_EDITOR_SETTINGS_MAX_BYTES + 1),
  ])("falls back to defaults for corrupt, unsupported, or oversized state", async (contents) => {
    await writeFile(settingsPath, contents, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await TextEditorSettingsStore.load(settingsPath);

    expect(store.getState()).toBe(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
  });

  it("falls back safely when the settings path is a symbolic link", async () => {
    const target = join(temporaryDirectory, "target.json");
    await writeFile(target, JSON.stringify(DEFAULT_TEXT_EDITOR_SETTINGS_STATE), { mode: 0o600 });
    await symlink(target, settingsPath);

    const store = await TextEditorSettingsStore.load(settingsPath);

    expect(store.getState()).toBe(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
  });

  it("persists a bounded private JSON file atomically before publishing state", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);
    const result = await store.update(updateInput(0, {
      fontId: "cascadia-mono",
      fontSize: 20,
      minimap: false,
      stickyScroll: true,
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        ...DEFAULT_TEXT_EDITOR_SETTINGS_STATE,
        revision: 1,
        fontId: "cascadia-mono",
        fontSize: 20,
        minimap: false,
        stickyScroll: true,
      },
    });
    expect(store.getState()).toBe(result.value);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(result.value);
    const stats = await lstat(settingsPath);
    expect(stats.isFile()).toBe(true);
    expect(stats.isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o600);
    expect(await readdir(temporaryDirectory)).toEqual([basename(settingsPath)]);
  });

  it("reloads every saved editor preference", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);
    const settings: TextEditorSettingsValues = {
      fontId: "jetbrains-mono",
      fontSize: 16,
      tabSize: 8,
      insertSpaces: false,
      minimap: false,
      wordWrap: true,
      lineNumbers: "off",
      renderWhitespace: "trailing",
      stickyScroll: true,
      bracketPairColorization: false,
      fontLigatures: true,
    };

    const result = await store.update({ expectedRevision: 0, settings });
    const reloaded = await TextEditorSettingsStore.load(settingsPath);

    expect(result).toEqual({ ok: true, value: { v: 1, revision: 1, ...settings } });
    expect(reloaded.getState()).toEqual(result.value);
  });

  it("rejects stale revisions without changing memory or disk", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);
    const first = await store.update(updateInput(0, { fontSize: 18 }));
    expect(first.ok).toBe(true);
    const persistedBefore = await readFile(settingsPath, "utf8");

    const stale = await store.update(updateInput(0, { fontSize: 20 }));

    expect(stale).toEqual({ ok: false, error: STALE_TEXT_EDITOR_SETTINGS_ERROR });
    expect(store.getState()).toMatchObject({ revision: 1, fontSize: 18 });
    expect(await readFile(settingsPath, "utf8")).toBe(persistedBefore);
  });

  it("serializes simultaneous updates so only the current revision commits", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);

    const [first, second] = await Promise.all([
      store.update(updateInput(0, { fontSize: 14 })),
      store.update(updateInput(0, { fontSize: 15 })),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: STALE_TEXT_EDITOR_SETTINGS_ERROR });
    expect(store.getState()).toMatchObject({ revision: 1, fontSize: 14 });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(store.getState());
  });

  it("rejects malformed updates without persisting them", async () => {
    const store = await TextEditorSettingsStore.load(settingsPath);
    const malformed = {
      expectedRevision: 0,
      settings: { ...DEFAULT_TEXT_EDITOR_SETTINGS_VALUES, fontSize: 100 },
    } as unknown as TextEditorSettingsUpdateInput;

    await expect(store.update(malformed)).resolves.toEqual({
      ok: false,
      error: "The text editor settings update is invalid.",
    });
    expect(store.getState()).toBe(DEFAULT_TEXT_EDITOR_SETTINGS_STATE);
    await expect(lstat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an explicit file path", async () => {
    await expect(TextEditorSettingsStore.load("")).rejects.toThrow(
      "A bounded text editor settings file path is required",
    );
  });
});

function updateInput(
  expectedRevision: number,
  overrides: Partial<TextEditorSettingsValues>,
): TextEditorSettingsUpdateInput {
  return {
    expectedRevision,
    settings: { ...DEFAULT_TEXT_EDITOR_SETTINGS_VALUES, ...overrides },
  };
}
