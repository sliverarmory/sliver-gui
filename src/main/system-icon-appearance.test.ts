import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSystemIconAppearance,
  readLinuxSystemIconAppearance,
  readWindowsSystemIconAppearance,
} from "./system-icon-appearance.js";

class NativeTheme extends EventEmitter {
  shouldUseDarkColorsForSystemIntegratedUI = false;
  shouldUseDarkColors = true;
  themeSource = "dark";
}

afterEach(() => vi.useRealTimers());

describe("system icon appearance", () => {
  it("reads macOS user defaults independently of the forced application theme", () => {
    const nativeTheme = new NativeTheme();
    const preferences = {
      getUserDefault: vi.fn().mockReturnValue(""),
      subscribeNotification: vi.fn((_event: string, _listener: () => void) => 42),
      unsubscribeNotification: vi.fn(),
    };
    const appearance = createSystemIconAppearance({
      platform: "darwin", nativeTheme, systemPreferences: preferences,
    });
    const changed = vi.fn();
    expect(appearance.isDark()).toBe(false);
    expect(preferences.getUserDefault).toHaveBeenCalledWith("AppleInterfaceStyle", "string");
    appearance.start(changed);
    expect(preferences.subscribeNotification).toHaveBeenCalledWith(
      "AppleInterfaceThemeChangedNotification", expect.any(Function),
    );

    preferences.getUserDefault.mockReturnValue("Dark");
    preferences.subscribeNotification.mock.calls[0]?.[1]();
    expect(appearance.isDark()).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
    nativeTheme.emit("updated");
    expect(changed).toHaveBeenCalledOnce();
    expect(nativeTheme.themeSource).toBe("dark");

    appearance.dispose();
    appearance.dispose();
    expect(preferences.unsubscribeNotification).toHaveBeenCalledExactlyOnceWith(42);
    expect(nativeTheme.listenerCount("updated")).toBe(0);
  });

  it("reads the Windows system preference at startup before trusting Electron's uninitialized cache", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
    const readWindowsAppearance = vi.fn().mockResolvedValue(false);
    const appearance = createSystemIconAppearance({ platform: "win32", nativeTheme, readWindowsAppearance });
    const changed = vi.fn();
    expect(appearance.isDark()).toBe(true);
    appearance.start(changed);
    appearance.start(changed);
    expect(appearance.isDark()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(false);
    expect(readWindowsAppearance).toHaveBeenCalledOnce();
    expect(nativeTheme.listenerCount("updated")).toBe(1);
    nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
    nativeTheme.shouldUseDarkColors = false;
    nativeTheme.themeSource = "light";
    nativeTheme.emit("updated");
    expect(appearance.isDark()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(nativeTheme.themeSource).toBe("light");
    appearance.dispose();
  });

  it("does not display a light Windows app theme while the system theme is dark", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = false;
    const appearance = createSystemIconAppearance({
      platform: "win32", nativeTheme, readWindowsAppearance: vi.fn().mockResolvedValue(true),
    });
    const changed = vi.fn();
    appearance.start(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    appearance.dispose();
  });

  it("does not let a stale Windows startup read overwrite a newer native update", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    let finishRead: ((dark: boolean) => void) | undefined;
    const readWindowsAppearance = vi.fn((_signal: AbortSignal) => new Promise<boolean>((resolve) => { finishRead = resolve; }));
    const appearance = createSystemIconAppearance({ platform: "win32", nativeTheme, readWindowsAppearance });
    const changed = vi.fn();
    appearance.start(changed);
    nativeTheme.shouldUseDarkColorsForSystemIntegratedUI = true;
    nativeTheme.emit("updated");
    expect(readWindowsAppearance.mock.calls[0]?.[0].aborted).toBe(true);
    finishRead?.(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    appearance.dispose();
  });

  it("aborts the Windows startup read and removes its listener on disposal", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    let finishRead: ((dark: boolean) => void) | undefined;
    const readWindowsAppearance = vi.fn((_signal: AbortSignal) => new Promise<boolean>((resolve) => { finishRead = resolve; }));
    const appearance = createSystemIconAppearance({ platform: "win32", nativeTheme, readWindowsAppearance });
    const changed = vi.fn();
    appearance.start(changed);
    appearance.dispose();
    expect(readWindowsAppearance.mock.calls[0]?.[0].aborted).toBe(true);
    finishRead?.(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    expect(nativeTheme.listenerCount("updated")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("defaults to dark when the macOS appearance reader is unavailable", () => {
    const appearance = createSystemIconAppearance({ platform: "darwin", nativeTheme: new NativeTheme() });
    appearance.start(vi.fn());
    expect(appearance.isDark()).toBe(true);
    appearance.dispose();
  });

  it("polls Linux independently of app theme events and aborts outstanding reads on disposal", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    const readLinuxAppearance = vi.fn<(signal: AbortSignal) => Promise<boolean | undefined>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const appearance = createSystemIconAppearance({ platform: "linux", nativeTheme, readLinuxAppearance });
    const changed = vi.fn();
    expect(appearance.isDark()).toBe(true);
    appearance.start(changed);
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(appearance.isDark()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);

    let finishRead: ((dark: boolean) => void) | undefined;
    readLinuxAppearance.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
    nativeTheme.emit("updated");
    const signal = readLinuxAppearance.mock.calls[2]?.[0];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readLinuxAppearance).toHaveBeenCalledTimes(3);
    appearance.dispose();
    expect(signal?.aborted).toBe(true);
    finishRead?.(false);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readLinuxAppearance).toHaveBeenCalledTimes(3);
    expect(appearance.isDark()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(nativeTheme.listenerCount("updated")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns to the dark fallback when Linux appearance becomes unavailable", async () => {
    vi.useFakeTimers();
    const nativeTheme = new NativeTheme();
    const readLinuxAppearance = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("unavailable"));
    const appearance = createSystemIconAppearance({ platform: "linux", nativeTheme, readLinuxAppearance });
    appearance.start(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(false);
    nativeTheme.emit("updated");
    await vi.advanceTimersByTimeAsync(0);
    expect(appearance.isDark()).toBe(true);
    appearance.dispose();
  });
});

describe("Windows system appearance source", () => {
  it.each([["0x0", true], ["0x1", false]] as const)("reads SystemUsesLightTheme %s independently of AppsUseLightTheme", async (value, dark) => {
    const command = vi.fn().mockResolvedValue([
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      "    AppsUseLightTheme    REG_DWORD    0x1",
      `    SystemUsesLightTheme    REG_DWORD    ${value}`,
      "",
    ].join("\r\n"));
    expect(await readWindowsSystemIconAppearance(new AbortController().signal, command)).toBe(dark);
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toMatch(/\\System32\\reg\.exe$/u);
    expect(command.mock.calls[0]?.[1]).toContain("SystemUsesLightTheme");
  });

  it.each([undefined, "", "AppsUseLightTheme    REG_DWORD    0x1", "SystemUsesLightTheme    REG_SZ    0", "SystemUsesLightTheme    REG_DWORD    0x2"])("leaves unavailable or invalid registry output unknown: %s", async (output) => {
    const command = vi.fn().mockResolvedValue(output);
    expect(await readWindowsSystemIconAppearance(new AbortController().signal, command)).toBeUndefined();
  });
});

describe("Linux system appearance sources", () => {
  it.each([["1", true], ["2", false]] as const)("honors portal preference %s before desktop-specific settings", async (scheme, dark) => {
    const command = vi.fn().mockResolvedValue(`(<<uint32 ${scheme}>>, )`);
    expect(await readLinuxSystemIconAppearance(new AbortController().signal, command)).toBe(dark);
    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toBe("gdbus");
  });

  it.each([["prefer-dark", true], ["prefer-light", false]] as const)("falls back to GNOME preference %s", async (scheme, dark) => {
    const command = vi.fn().mockResolvedValueOnce("(<<uint32 0>>,)").mockResolvedValueOnce(`'${scheme}'`);
    expect(await readLinuxSystemIconAppearance(new AbortController().signal, command)).toBe(dark);
    expect(command).toHaveBeenCalledTimes(2);
  });

  it.each([["Yaru-dark", true], ["Adwaita", false]] as const)("supports GTK theme %s on older desktops", async (theme, dark) => {
    const command = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("'default'").mockResolvedValueOnce(`'${theme}'`);
    expect(await readLinuxSystemIconAppearance(new AbortController().signal, command)).toBe(dark);
  });

  it("leaves missing or malformed preferences unknown", async () => {
    const command = vi.fn().mockResolvedValue(undefined);
    expect(await readLinuxSystemIconAppearance(new AbortController().signal, command)).toBeUndefined();
    command.mockResolvedValue("unrecognized output");
    expect(await readLinuxSystemIconAppearance(new AbortController().signal, command)).toBeUndefined();
  });

  it("does not start fallback commands after cancellation", async () => {
    const controller = new AbortController();
    const command = vi.fn().mockImplementation(async () => {
      controller.abort();
      return undefined;
    });
    expect(await readLinuxSystemIconAppearance(controller.signal, command)).toBeUndefined();
    expect(command).toHaveBeenCalledOnce();
  });
});
