// @vitest-environment node

import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_APPLICATION_SETTINGS_STATE,
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

  it("loads an exact private version-two file", async () => {
    const persisted = {
      v: 2,
      revision: 9,
      theme: "dark",
      reduceMotion: true,
      commandPaletteShortcut: "mod+shift+p",
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
      v: 2,
      revision: 9,
      theme: "dark",
      reduceMotion: true,
      commandPaletteShortcut: "mod+k",
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
    JSON.stringify({ v: 3 }),
    JSON.stringify({ ...DEFAULT_APPLICATION_SETTINGS_STATE, extra: true }),
    JSON.stringify({ ...DEFAULT_APPLICATION_SETTINGS_STATE, theme: "sepia" }),
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
  overrides: Partial<Pick<ApplicationSettingsUpdateInput["settings"], "theme" | "reduceMotion">>,
): ApplicationSettingsUpdateInput {
  return {
    expectedRevision,
    settings: {
      theme: overrides.theme ?? DEFAULT_APPLICATION_SETTINGS_STATE.theme,
      reduceMotion: overrides.reduceMotion ?? DEFAULT_APPLICATION_SETTINGS_STATE.reduceMotion,
      commandPaletteShortcut: DEFAULT_APPLICATION_SETTINGS_STATE.commandPaletteShortcut,
      terminal: DEFAULT_APPLICATION_SETTINGS_STATE.terminal,
    },
  };
}
