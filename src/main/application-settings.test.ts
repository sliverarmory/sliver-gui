// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
  DEFAULT_APPLICATION_SETTINGS_VALUES,
  type ApplicationIcon,
  type ApplicationSettingsUpdateInput,
} from "../shared/application-settings-contracts.js";
import {
  ApplicationSettingsStore,
  STALE_APPLICATION_SETTINGS_ERROR,
} from "./application-settings.js";

let temporaryDirectory = "";
let settingsPath = "";

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "sliver-gui-application-settings-"));
  settingsPath = join(temporaryDirectory, "settings.json");
});

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("ApplicationSettingsStore", () => {
  it("uses deeply frozen defaults when the explicit file is missing", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.filePath).toBe(settingsPath);
    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Object.isFrozen(store.getState().terminal)).toBe(true);
  });

  it("loads an exact private version-five file", async () => {
    const persisted = {
      v: 5,
      revision: 9,
      theme: "dark",
      appIcon: "passion",
      reduceMotion: true,
      reportScreenshotDirectory: join(temporaryDirectory, "reports"),
      commandPaletteShortcut: "mod+shift+p",
      keyboardShortcuts: { newWindow: "mod+alt+n", terminalCloseTab: "mod+shift+e" },
      terminal: {
        fontId: "source-code-pro",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: false,
        smoothScrolling: true,
      },
    };
    await writeFile(settingsPath, JSON.stringify(persisted), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toEqual(persisted);
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Object.isFrozen(store.getState().terminal)).toBe(true);
  });

  it("migrates version-four settings and persists a custom screenshot directory", async () => {
    const { reportScreenshotDirectory: _directory, ...previousSettings } = DEFAULT_APPLICATION_SETTINGS_STATE;
    await writeFile(settingsPath, JSON.stringify({ ...previousSettings, v: 4 }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState()).toEqual({ ...DEFAULT_APPLICATION_SETTINGS_STATE });

    const reportScreenshotDirectory = join(temporaryDirectory, "screenshots");
    const { v: _version, revision, ...settings } = store.getState();
    const result = await store.update({
      expectedRevision: revision,
      settings: { ...settings, reportScreenshotDirectory },
    });
    expect(result).toMatchObject({ ok: true, value: { v: 5, revision: 1, reportScreenshotDirectory } });
    const reloaded = await ApplicationSettingsStore.load(settingsPath);
    expect(reloaded.getState().reportScreenshotDirectory).toBe(reportScreenshotDirectory);
  });

  it.runIf(process.platform !== "win32")("rejects a screenshot path that is only absolute on another platform", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);
    const result = await store.update({
      expectedRevision: 0,
      settings: { ...DEFAULT_APPLICATION_SETTINGS_VALUES, reportScreenshotDirectory: "C:\\Reports" },
    });
    expect(result).toEqual({ ok: false, error: "The application settings update is invalid." });
    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    await expect(lstat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("migrates version-two preferences and saves version five on the next update", async () => {
    const previous = {
      v: 2,
      revision: 9,
      theme: "light",
      reduceMotion: true,
      commandPaletteShortcut: "mod+alt+shift+p",
      terminal: {
        fontId: "cascadia-mono",
        fontSize: 19,
        cursorStyle: "bar",
        cursorBlink: false,
        smoothScrolling: true,
      },
    };
    await writeFile(settingsPath, JSON.stringify(previous), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState()).toEqual({ ...previous, v: 5, appIcon: "auto", keyboardShortcuts: {}, reportScreenshotDirectory: null });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);

    const { v: _version, revision, ...settings } = store.getState();
    const result = await store.update({ expectedRevision: revision, settings: { ...settings, appIcon: "passion" } });
    expect(result).toEqual({
      ok: true,
      value: { ...previous, v: 5, revision: 10, appIcon: "passion", keyboardShortcuts: {}, reportScreenshotDirectory: null },
    });
    const reloaded = await ApplicationSettingsStore.load(settingsPath);
    expect(reloaded.getState()).toEqual(result.value);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(result.value);
  });

  it("migrates an exact private version-one file without discarding preferences", async () => {
    await writeFile(settingsPath, JSON.stringify({
      v: 1,
      revision: 9,
      theme: "dark",
      reduceMotion: true,
      terminal: {
        fontId: "source-code-pro",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: false,
        smoothScrolling: true,
      },
    }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toEqual({
      v: 5,
      revision: 9,
      theme: "dark",
      appIcon: "auto",
      reduceMotion: true,
      reportScreenshotDirectory: null,
      commandPaletteShortcut: "mod+k",
      keyboardShortcuts: {},
      terminal: {
        fontId: "source-code-pro",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: false,
        smoothScrolling: true,
      },
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ v: 6 }),
    JSON.stringify({ ...DEFAULT_APPLICATION_SETTINGS_STATE, extra: true }),
    JSON.stringify({ ...DEFAULT_APPLICATION_SETTINGS_STATE, theme: "sepia" }),
    JSON.stringify({ ...DEFAULT_APPLICATION_SETTINGS_STATE, appIcon: "system" }),
  ])("falls back to defaults for corrupt or unsupported state %#", async (contents) => {
    await writeFile(settingsPath, contents, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
  });

  it("falls back safely when the settings path is a symbolic link", async () => {
    const target = join(temporaryDirectory, "target.json");
    await writeFile(target, JSON.stringify(DEFAULT_APPLICATION_SETTINGS_STATE), { mode: 0o600 });
    await symlink(target, settingsPath);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
  });

  it("persists a bounded private JSON file atomically before publishing state", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);
    const result = await store.update(updateInput(0, {
      theme: "light",
      reduceMotion: true,
    }));

    expect(result).toEqual({
      ok: true,
      value: {
        ...DEFAULT_APPLICATION_SETTINGS_STATE,
        revision: 1,
        theme: "light",
        reduceMotion: true,
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

  it.each<ApplicationIcon>(["auto", "light", "dark", "passion"])("persists and reloads the %s icon choice", async (appIcon) => {
    const store = await ApplicationSettingsStore.load(settingsPath);

    const result = await store.update(updateInput(0, { appIcon }));

    expect(result.ok).toBe(true);
    const reloaded = await ApplicationSettingsStore.load(settingsPath);
    expect(reloaded.getState()).toMatchObject({ v: 5, revision: 1, appIcon, theme: "system" });
  });

  it("rejects stale revisions without changing memory or disk", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);
    const first = await store.update(updateInput(0, { theme: "dark" }));
    expect(first.ok).toBe(true);
    const persistedBefore = await readFile(settingsPath, "utf8");

    const stale = await store.update(updateInput(0, { theme: "light" }));

    expect(stale).toEqual({ ok: false, error: STALE_APPLICATION_SETTINGS_ERROR });
    expect(store.getState().theme).toBe("dark");
    expect(store.getState().revision).toBe(1);
    expect(await readFile(settingsPath, "utf8")).toBe(persistedBefore);
  });

  it("serializes simultaneous updates so only the current revision commits", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);

    const [first, second] = await Promise.all([
      store.update(updateInput(0, { theme: "light" })),
      store.update(updateInput(0, { theme: "dark" })),
    ]);

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, error: STALE_APPLICATION_SETTINGS_ERROR });
    expect(store.getState()).toMatchObject({ revision: 1, theme: "light" });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(store.getState());
  });

  it("rejects malformed updates without persisting them", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);
    const malformed = {
      expectedRevision: 0,
      settings: {
        theme: "dark",
        appIcon: "auto",
        reduceMotion: false,
        commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
        terminal: { ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal, fontSize: 100 },
      },
    } as unknown as ApplicationSettingsUpdateInput;

    await expect(store.update(malformed)).resolves.toEqual({
      ok: false,
      error: "The application settings update is invalid.",
    });
    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
    await expect(lstat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires an explicit file path", async () => {
    await expect(ApplicationSettingsStore.load("")).rejects.toThrow(
      "A bounded application settings file path is required",
    );
  });
});

function updateInput(
  expectedRevision: number,
  overrides: Partial<Pick<ApplicationSettingsUpdateInput["settings"], "theme" | "appIcon" | "reduceMotion">>,
): ApplicationSettingsUpdateInput {
  return {
    expectedRevision,
    settings: {
      theme: overrides.theme ?? DEFAULT_APPLICATION_SETTINGS_STATE.theme,
      appIcon: overrides.appIcon ?? DEFAULT_APPLICATION_SETTINGS_STATE.appIcon,
      reduceMotion: overrides.reduceMotion ?? DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
      reportScreenshotDirectory: DEFAULT_APPLICATION_SETTINGS_STATE.reportScreenshotDirectory,
      commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
      keyboardShortcuts: {},
      terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
    },
  };
}
