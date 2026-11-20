// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  APPLICATION_SETTINGS_VERSION,
  DEFAULT_APPLICATION_LANGUAGE,
  DEFAULT_APPLICATION_SETTINGS_STATE,
  DEFAULT_APPLICATION_SETTINGS_VALUES,
  DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
  DEFAULT_APPLICATION_RDP_SETTINGS,
  resolveApplicationLanguage,
  type ApplicationIcon,
  type ApplicationSettingsState,
  type ApplicationSettingsUpdateInput,
} from "../shared/application-settings-contracts.js";
import {
  ApplicationSettingsStore,
  STALE_APPLICATION_SETTINGS_ERROR,
} from "./application-settings.js";

let temporaryDirectory = "";
let settingsPath = "";
const defaultPersistedSettings = persistedSettings(DEFAULT_APPLICATION_SETTINGS_STATE);
const { language: _language, ...preLanguageSettings } = defaultPersistedSettings;

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

  it("uses the detected language when starting with no settings file", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath, "fr");
    expect(store.getState()).toMatchObject({ language: "system", systemLanguage: "fr" });
    expect(resolveApplicationLanguage(store.getState())).toBe("fr");
    await expect(lstat(settingsPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("loads an exact private current-version file", async () => {
    const persisted = {
      v: APPLICATION_SETTINGS_VERSION,
      revision: 9,
      language: "uk",
      theme: "dark",
      appIcon: "passion",
      reduceMotion: true,
      disableWindowTransparency: true,
      reportScreenshotDirectory: join(temporaryDirectory, "reports"),
      commandPaletteShortcut: "mod+shift+p",
      keyboardShortcuts: { newWindow: "mod+alt+n", terminalCloseTab: "mod+shift+e" },
      terminal: {
        fontId: "source-code-pro",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: false,
        smoothScrolling: true,
        transparentWindows: false,
      },
      overview: { kinds: ["future-kind", "operator"], statuses: ["healthy"], lightning: true,
        sidebarDisabled: true, presentation: "list" },
      rdp: { clipboard: false, transparentClipboard: false },
    };
    await writeFile(settingsPath, JSON.stringify(persisted), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toEqual({ ...persisted, systemLanguage: DEFAULT_APPLICATION_LANGUAGE });
    expect(Object.isFrozen(store.getState())).toBe(true);
    expect(Object.isFrozen(store.getState().terminal)).toBe(true);
    expect(Object.isFrozen(store.getState().overview)).toBe(true);
  });

  it("migrates version-ten settings to the detected language and keeps an explicit English override", async () => {
    const previous = { ...preLanguageSettings, v: 10, revision: 6, theme: "dark", reduceMotion: true };
    await writeFile(settingsPath, JSON.stringify(previous), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath, "fr");
    expect(store.getState()).toEqual({ ...previous, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: "fr" });
    expect(resolveApplicationLanguage(store.getState())).toBe("fr");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);
    const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
    const update = await store.update({ expectedRevision: revision, settings: { ...settings, language: "en" } });
    expect(update).toEqual({
      ok: true,
      value: { ...settings, v: APPLICATION_SETTINGS_VERSION, revision: 7, language: "en", systemLanguage: "fr" },
    });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));

    const reloaded = await ApplicationSettingsStore.load(settingsPath, "ja");
    expect(reloaded.getState()).toMatchObject({ language: "en", systemLanguage: "ja", revision: 7, theme: "dark" });
    expect(resolveApplicationLanguage(reloaded.getState())).toBe("en");
    await expect(reloaded.update({ expectedRevision: 7, settings })).resolves.toMatchObject({
      ok: true, value: { language: "system", systemLanguage: "ja", revision: 8 },
    });
    expect(resolveApplicationLanguage(reloaded.getState())).toBe("ja");

    const restarted = await ApplicationSettingsStore.load(settingsPath, "uk");
    expect(restarted.getState()).toMatchObject({ language: "system", systemLanguage: "uk", revision: 8, theme: "dark" });
    expect(resolveApplicationLanguage(restarted.getState())).toBe("uk");
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(restarted.getState()));
  });

  it("migrates a version-five file and retains its existing settings", async () => {
    const { overview: _overview, disableWindowTransparency: _disableTransparency, rdp: _rdp, ...previousSettings } = preLanguageSettings;
    const previous = { ...previousSettings, v: 5, revision: 12, theme: "dark", appIcon: "passion" };
    await writeFile(settingsPath, JSON.stringify(previous), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState()).toEqual({ ...previous, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, disableWindowTransparency: false, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS, rdp: DEFAULT_APPLICATION_RDP_SETTINGS });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);
    const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
    await expect(store.update({ expectedRevision: revision, settings: {
      ...settings, overview: { kinds: ["future-kind"], statuses: ["inactive"], lightning: true,
        sidebarDisabled: true, presentation: "list" },
    } })).resolves.toMatchObject({ ok: true, value: { revision: 13, v: APPLICATION_SETTINGS_VERSION } });
    const reloaded = await ApplicationSettingsStore.load(settingsPath);
    expect(reloaded.getState()).toMatchObject({ revision: 13, theme: "dark", appIcon: "passion",
      overview: { kinds: ["future-kind"], statuses: ["inactive"], lightning: true,
        sidebarDisabled: true, presentation: "list" } });
  });

  it("migrates version-seven settings with native transparency enabled without changing disk on load", async () => {
    const { disableWindowTransparency: _disableTransparency, rdp: _rdp, ...previousSettings } = preLanguageSettings;
    const previous = {
      ...previousSettings,
      v: 7,
      revision: 23,
      theme: "dark",
      appIcon: "passion",
      terminal: { ...previousSettings.terminal, fontSize: 21, transparentWindows: false },
      overview: { kinds: ["future-kind"], statuses: ["warning"], lightning: true,
        sidebarDisabled: true, presentation: "list" },
    };
    await writeFile(settingsPath, JSON.stringify(previous), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toEqual({ ...previous, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, disableWindowTransparency: false, rdp: DEFAULT_APPLICATION_RDP_SETTINGS });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);
  });

  it("migrates version-eight settings and persists a disabled RDP clipboard preference across reloads", async () => {
    const { rdp: _rdp, ...previousSettings } = preLanguageSettings;
    const previous = {
      ...previousSettings,
      v: 8,
      revision: 42,
      theme: "dark",
      disableWindowTransparency: true,
      terminal: { ...previousSettings.terminal, fontSize: 22 },
    };
    await writeFile(settingsPath, JSON.stringify(previous), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    let store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState()).toEqual({ ...previous, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, rdp: { clipboard: true, transparentClipboard: false } });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);

    for (const clipboard of [false, true]) {
      const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
      const result = await store.update({
        expectedRevision: revision,
        settings: { ...settings, rdp: { clipboard, transparentClipboard: !clipboard } },
      });
      expect(result).toEqual({
        ok: true,
        value: { ...previous, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, revision: revision + 1, rdp: { clipboard, transparentClipboard: !clipboard } },
      });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));
      store = await ApplicationSettingsStore.load(settingsPath);
      expect(store.getState()).toEqual(result.value);
    }
  });

  it("migrates version-four settings and persists a custom screenshot directory", async () => {
    const { reportScreenshotDirectory: _directory, overview: _overview, disableWindowTransparency: _disableTransparency, rdp: _rdp, ...previousSettings } = preLanguageSettings;
    await writeFile(settingsPath, JSON.stringify({ ...previousSettings, v: 4 }), { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState()).toEqual({ ...DEFAULT_APPLICATION_SETTINGS_STATE });

    const reportScreenshotDirectory = join(temporaryDirectory, "screenshots");
    const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
    const result = await store.update({
      expectedRevision: revision,
      settings: { ...settings, reportScreenshotDirectory },
    });
    expect(result).toMatchObject({ ok: true, value: { v: APPLICATION_SETTINGS_VERSION, revision: 1, reportScreenshotDirectory } });
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

  it("migrates version-two preferences and saves the current version on the next update", async () => {
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
    expect(store.getState()).toEqual({ ...previous, terminal: { ...previous.terminal, transparentWindows: true }, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, disableWindowTransparency: false, appIcon: "auto", keyboardShortcuts: {}, reportScreenshotDirectory: null, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS, rdp: DEFAULT_APPLICATION_RDP_SETTINGS });
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(previous);

    const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
    const result = await store.update({ expectedRevision: revision, settings: { ...settings, appIcon: "passion" } });
    expect(result).toEqual({
      ok: true,
      value: { ...previous, terminal: { ...previous.terminal, transparentWindows: true }, v: APPLICATION_SETTINGS_VERSION, language: "system", systemLanguage: DEFAULT_APPLICATION_LANGUAGE, disableWindowTransparency: false, revision: 10, appIcon: "passion", keyboardShortcuts: {}, reportScreenshotDirectory: null, overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS, rdp: DEFAULT_APPLICATION_RDP_SETTINGS },
    });
    const reloaded = await ApplicationSettingsStore.load(settingsPath);
    expect(reloaded.getState()).toEqual(result.value);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));
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
      v: APPLICATION_SETTINGS_VERSION,
      revision: 9,
      language: "system",
      systemLanguage: DEFAULT_APPLICATION_LANGUAGE,
      theme: "dark",
      appIcon: "auto",
      reduceMotion: true,
      disableWindowTransparency: false,
      reportScreenshotDirectory: null,
      commandPaletteShortcut: "mod+k",
      keyboardShortcuts: {},
      overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
      rdp: DEFAULT_APPLICATION_RDP_SETTINGS,
      terminal: {
        fontId: "source-code-pro",
        fontSize: 18,
        cursorStyle: "underline",
        cursorBlink: false,
        smoothScrolling: true,
        transparentWindows: true,
      },
    });
  });

  it.each([
    "not-json",
    JSON.stringify({ v: APPLICATION_SETTINGS_VERSION }),
    JSON.stringify({ ...defaultPersistedSettings, systemLanguage: "uk" }),
    JSON.stringify({ ...defaultPersistedSettings, language: "pt" }),
    JSON.stringify({ ...defaultPersistedSettings, extra: true }),
    JSON.stringify({ ...defaultPersistedSettings, theme: "sepia" }),
    JSON.stringify({ ...defaultPersistedSettings, appIcon: "system" }),
  ])("falls back to defaults for corrupt or unsupported state %#", async (contents) => {
    await writeFile(settingsPath, contents, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(settingsPath, 0o600);

    const store = await ApplicationSettingsStore.load(settingsPath);

    expect(store.getState()).toBe(DEFAULT_APPLICATION_SETTINGS_STATE);
  });

  it("falls back safely when the settings path is a symbolic link", async () => {
    const target = join(temporaryDirectory, "target.json");
    await writeFile(target, JSON.stringify(defaultPersistedSettings), { mode: 0o600 });
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
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));
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
    expect(reloaded.getState()).toMatchObject({ v: APPLICATION_SETTINGS_VERSION, revision: 1, appIcon, theme: "system" });
  });

  it("persists disabling and re-enabling native transparency across disk reloads", async () => {
    let store = await ApplicationSettingsStore.load(settingsPath);
    expect(store.getState().disableWindowTransparency).toBe(false);

    for (const disableWindowTransparency of [true, false]) {
      const { v: _version, revision, systemLanguage: _systemLanguage, ...settings } = store.getState();
      const result = await store.update({
        expectedRevision: revision,
        settings: { ...settings, disableWindowTransparency },
      });

      expect(result).toMatchObject({ ok: true, value: { disableWindowTransparency, revision: revision + 1 } });
      expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));
      store = await ApplicationSettingsStore.load(settingsPath);
      expect(store.getState()).toEqual(result.value);
    }
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
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual(persistedSettings(store.getState()));
  });

  it("flushes a queued overview update before shutdown", async () => {
    const store = await ApplicationSettingsStore.load(settingsPath);
    const update = store.update({
      expectedRevision: 0,
      settings: {
        ...DEFAULT_APPLICATION_SETTINGS_VALUES,
        overview: {
          kinds: ["beacon"],
          statuses: ["inactive"],
          lightning: true,
          sidebarDisabled: true,
          presentation: "list",
        },
      },
    });

    await store.flush();
    expect((await update).ok).toBe(true);
    expect(JSON.parse(await readFile(settingsPath, "utf8"))).toMatchObject({
      overview: {
        kinds: ["beacon"],
        statuses: ["inactive"],
        lightning: true,
        sidebarDisabled: true,
        presentation: "list",
      },
    });
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

function persistedSettings({ systemLanguage: _systemLanguage, ...settings }: ApplicationSettingsState): Omit<ApplicationSettingsState, "systemLanguage"> {
  return settings;
}

function updateInput(
  expectedRevision: number,
  overrides: Partial<Pick<ApplicationSettingsUpdateInput["settings"], "theme" | "appIcon" | "reduceMotion" | "disableWindowTransparency">>,
): ApplicationSettingsUpdateInput {
  return {
    expectedRevision,
    settings: {
      language: DEFAULT_APPLICATION_SETTINGS_VALUES.language,
      theme: overrides.theme ?? DEFAULT_APPLICATION_SETTINGS_STATE.theme,
      appIcon: overrides.appIcon ?? DEFAULT_APPLICATION_SETTINGS_STATE.appIcon,
      reduceMotion: overrides.reduceMotion ?? DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
      disableWindowTransparency: overrides.disableWindowTransparency ?? DEFAULT_APPLICATION_SETTINGS_STATE.disableWindowTransparency,
      reportScreenshotDirectory: DEFAULT_APPLICATION_SETTINGS_STATE.reportScreenshotDirectory,
      commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
      keyboardShortcuts: {},
      terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
      overview: DEFAULT_APPLICATION_OVERVIEW_SETTINGS,
      rdp: DEFAULT_APPLICATION_RDP_SETTINGS,
    },
  };
}
