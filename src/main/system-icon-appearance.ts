import { execFile } from "node:child_process";
import { win32 as windowsPath } from "node:path";

const LINUX_POLL_INTERVAL_MS = 10_000;
const COMMAND_TIMEOUT_MS = 1_500;

interface SystemIconNativeTheme {
  readonly shouldUseDarkColorsForSystemIntegratedUI: boolean;
  on(event: "updated", listener: () => void): unknown;
  removeListener(event: "updated", listener: () => void): unknown;
}

interface SystemIconPreferences {
  getUserDefault(key: string, type: "string"): string;
  subscribeNotification(event: string, listener: () => void): number;
  unsubscribeNotification(id: number): void;
}

interface SystemIconAppearanceOptions {
  readonly platform?: NodeJS.Platform;
  readonly nativeTheme: SystemIconNativeTheme;
  readonly systemPreferences?: SystemIconPreferences | undefined;
  readonly readLinuxAppearance?: (signal: AbortSignal) => Promise<boolean | undefined>;
  readonly readWindowsAppearance?: (signal: AbortSignal) => Promise<boolean | undefined>;
}

export interface SystemIconAppearance {
  isDark(): boolean;
  start(onChanged: () => void): void;
  dispose(): void;
}

/** Reads the OS preference without changing Electron's independently selected UI theme. */
export function createSystemIconAppearance(options: SystemIconAppearanceOptions): SystemIconAppearance {
  const platform = options.platform ?? process.platform;
  const readLinuxAppearance = options.readLinuxAppearance ?? readLinuxSystemIconAppearance;
  const readWindowsAppearance = options.readWindowsAppearance ?? readWindowsSystemIconAppearance;
  let dark = readNativeAppearance();
  let onChanged: (() => void) | undefined;
  let notificationId: number | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let pendingRead: AbortController | undefined;
  let disposed = false;

  function readNativeAppearance(): boolean {
    try {
      if (platform === "darwin") {
        const preference = options.systemPreferences?.getUserDefault("AppleInterfaceStyle", "string");
        // macOS removes this default in light mode; an unavailable reader stays dark.
        if (preference === "" || preference?.toLowerCase() === "light") return false;
        return true;
      }
    } catch {
      // Unsupported appearance APIs must not prevent application startup.
    }
    return true;
  }

  function update(nextDark: boolean): void {
    if (disposed || nextDark === dark) return;
    dark = nextDark;
    onChanged?.();
  }

  async function refreshCommandAppearance(): Promise<void> {
    if (pendingRead || disposed) return;
    const controller = new AbortController();
    pendingRead = controller;
    let nextDark: boolean | undefined;
    try {
      nextDark = await (platform === "win32" ? readWindowsAppearance : readLinuxAppearance)(controller.signal);
    } catch {
      // Missing tools, unavailable desktop services and timeouts use the dark fallback.
    } finally {
      pendingRead = undefined;
    }
    if (!controller.signal.aborted) update(nextDark ?? true);
  }

  function refresh(): void {
    if (disposed) return;
    if (platform === "linux" || platform === "win32") void refreshCommandAppearance();
    else update(readNativeAppearance());
  }

  function onNativeThemeUpdated(): void {
    if (disposed) return;
    if (platform !== "win32") {
      refresh();
      return;
    }
    // Electron initializes its separate Windows system theme cache immediately before
    // emitting "updated". Before this event its getter can return the app theme instead.
    pendingRead?.abort();
    let nextDark = true;
    try {
      nextDark = options.nativeTheme.shouldUseDarkColorsForSystemIntegratedUI !== false;
    } catch {
      // Unavailable system appearance retains the dark fallback.
    }
    update(nextDark);
  }

  return {
    isDark: () => dark,
    start(listener) {
      if (disposed || onChanged) return;
      onChanged = listener;
      options.nativeTheme.on("updated", onNativeThemeUpdated);
      if (platform === "darwin") {
        try {
          notificationId = options.systemPreferences?.subscribeNotification(
            "AppleInterfaceThemeChangedNotification",
            refresh,
          );
        } catch {
          // NativeTheme updates remain available if distributed notifications are unavailable.
        }
      }
      if (platform === "linux") {
        // An app UI override can suppress native theme changes, so also read the OS periodically.
        pollTimer = setInterval(refresh, LINUX_POLL_INTERVAL_MS);
        pollTimer.unref?.();
      }
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (onChanged) options.nativeTheme.removeListener("updated", onNativeThemeUpdated);
      if (notificationId !== undefined) {
        try {
          options.systemPreferences?.unsubscribeNotification(notificationId);
        } catch {
          // Continue cleanup when the native notification service has already stopped.
        }
      }
      if (pollTimer) clearInterval(pollTimer);
      pendingRead?.abort();
      onChanged = undefined;
    },
  };
}

type ReadSystemCommand = (
  file: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<string | undefined>;

/** Read the system theme directly because Electron's Windows cache can be unset at startup. */
export async function readWindowsSystemIconAppearance(
  signal: AbortSignal,
  readCommand: ReadSystemCommand = readSystemCommand,
): Promise<boolean | undefined> {
  const output = await readCommand(
    windowsPath.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe"),
    [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize",
      "/v", "SystemUsesLightTheme", "/t", "REG_DWORD",
    ],
    signal,
  );
  if (signal.aborted) return undefined;
  const value = output?.match(/^\s*SystemUsesLightTheme\s+REG_DWORD\s+(0x[0-9a-f]+|\d+)\s*$/imu)?.[1];
  if (value === undefined) return undefined;
  const usesLightTheme = Number(value);
  if (usesLightTheme === 0) return true;
  if (usesLightTheme === 1) return false;
  return undefined;
}

/** Portal preferences cover multiple desktops; GNOME's settings also cover older Ubuntu versions. */
export async function readLinuxSystemIconAppearance(
  signal: AbortSignal,
  readCommand: ReadSystemCommand = readSystemCommand,
): Promise<boolean | undefined> {
  const portal = await readCommand("gdbus", [
    "call", "--session", "--dest", "org.freedesktop.portal.Desktop",
    "--object-path", "/org/freedesktop/portal/desktop",
    // Read is supported by portal v1, including Ubuntu 22.04.
    "--method", "org.freedesktop.portal.Settings.Read",
    "org.freedesktop.appearance", "color-scheme",
  ], signal);
  if (signal.aborted) return undefined;
  const portalScheme = portal?.match(/\buint32\s+(\d+)\b/u)?.[1];
  if (portalScheme === "1") return true;
  if (portalScheme === "2") return false;

  const colorScheme = unquote(await readCommand("gsettings", [
    "get", "org.gnome.desktop.interface", "color-scheme",
  ], signal));
  if (signal.aborted) return undefined;
  if (colorScheme === "prefer-dark") return true;
  if (colorScheme === "prefer-light") return false;

  const gtkTheme = unquote(await readCommand("gsettings", [
    "get", "org.gnome.desktop.interface", "gtk-theme",
  ], signal));
  if (signal.aborted || !gtkTheme) return undefined;
  return /(?:^|[-_:])dark(?:$|[-_:])/iu.test(gtkTheme);
}

function unquote(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text?.match(/^['"](.+)['"]$/u)?.[1];
}

function readSystemCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<string | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: "utf8",
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4_096,
      signal,
      windowsHide: true,
    }, (error, stdout) => resolve(error ? undefined : stdout));
  });
}
