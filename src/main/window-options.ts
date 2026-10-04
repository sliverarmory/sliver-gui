import { release } from "node:os";
import type { BrowserWindowConstructorOptions } from "electron";

import { secureWebPreferences } from "./security.js";

const TRANSPARENT_WINDOW_COLOR = "#00000000";
export const CLOUD_DEPLOYMENT_SESSION_PARTITION = "sliver-cloud-deployment";
export const NETWORK_SESSION_PARTITION = "sliver-network";
export const TEXT_EDITOR_SESSION_PARTITION = "sliver-text-editor";
export const DARK_NATIVE_WINDOW_COLOR = "#09090b";
export const LIGHT_NATIVE_WINDOW_COLOR = "#fafafa";
export const DARK_TITLE_BAR_SYMBOL_COLOR = "#f4f4f5";
export const LIGHT_TITLE_BAR_SYMBOL_COLOR = "#18181b";

export function nativeWindowBackgroundColor(dark: boolean): string {
  return dark ? DARK_NATIVE_WINDOW_COLOR : LIGHT_NATIVE_WINDOW_COLOR;
}

/** A general-purpose local text editor with its own minimal preload and session. */
export function textEditorWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1120,
    height: 780,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: "Text Editor",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: {
      ...secureWebPreferences(preload),
      partition: TEXT_EDITOR_SESSION_PARTITION,
    },
  };
}

export function titleBarSymbolColor(dark: boolean): string {
  return dark ? DARK_TITLE_BAR_SYMBOL_COLOR : LIGHT_TITLE_BAR_SYMBOL_COLOR;
}

/**
 * Keep the native surface transparent so renderer alpha can reveal the desktop.
 * Native background materials provide the platform blur beneath translucent
 * renderer regions; Linux falls back to the renderer's glass treatment.
 * Windows requires a frameless window for transparency, while the title-bar
 * overlay restores the native window controls on Windows and Linux.
 */
export function mainWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    transparent: true,
    backgroundColor: TRANSPARENT_WINDOW_COLOR,
    title: "Sliver GUI",
    titleBarStyle: platform === "darwin" ? "hiddenInset" : "hidden",
    ...(platform === "darwin"
      ? {
          vibrancy: "sidebar" as const,
          visualEffectState: "followWindow" as const,
        }
      : {}),
    ...(platform === "win32"
      ? {
          frame: false,
          backgroundMaterial: "acrylic" as const,
        }
      : {}),
    ...(platform !== "darwin"
      ? {
          ...(icon ? { icon } : {}),
          titleBarOverlay: {
            color: TRANSPARENT_WINDOW_COLOR,
            symbolColor: titleBarSymbolColor(dark),
            height: 72,
          },
        }
      : {}),
    webPreferences: {
      ...secureWebPreferences(preload),
      zoomFactor: 1,
    },
  };
}

/**
 * A standalone native window for the Cloud Deployment workspace. The surface
 * is intentionally independent from an operator connection while its cloud
 * management workflow remains usable without an operator connection.
 */
export function cloudDeploymentWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: "Cloud Deployment",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: {
      ...secureWebPreferences(preload),
      partition: CLOUD_DEPLOYMENT_SESSION_PARTITION,
    },
  };
}

/** A connection-bound manager for client and server-owned network forwards. */
export function networkWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: "Network",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: {
      ...secureWebPreferences(preload),
      partition: NETWORK_SESSION_PARTITION,
    },
  };
}

/**
 * A focused native window for the managed-shell surface. It deliberately uses
 * the platform title bar instead of the workspace's translucent custom chrome,
 * so the terminal receives an unambiguous draggable region and native close
 * semantics on every supported desktop.
 */
export function sessionShellWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "Managed Shells",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  };
}

/** A focused, connection-bound session editor with native close controls. */
export function sessionPanelWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "Session Panel",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  };
}

/** Native blur is available on macOS and Windows 11 22H2 or newer. */
export function supportsTerminalTransparency(platform: NodeJS.Platform = process.platform, osRelease = release()): boolean {
  if (platform === "darwin") return true;
  if (platform !== "win32") return false;
  const [major = 0, , build = 0] = osRelease.split(".").map(Number);
  return major > 10 || (major === 10 && build >= 22621);
}

function terminalWindowChrome(platform: NodeJS.Platform, dark: boolean, transparent: boolean, osRelease: string): BrowserWindowConstructorOptions {
  if (!supportsTerminalTransparency(platform, osRelease)) return {};
  // Keep a transparent native surface available so the setting can change live.
  return {
    transparent: true,
    backgroundColor: transparent ? TRANSPARENT_WINDOW_COLOR : nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? {
      titleBarStyle: "hiddenInset" as const,
      ...(transparent ? { vibrancy: "sidebar" as const } : {}),
      visualEffectState: "followWindow" as const,
    } : {
      frame: false,
      titleBarStyle: "hidden" as const,
      backgroundMaterial: transparent ? "acrylic" as const : "none" as const,
      titleBarOverlay: { color: transparent ? TRANSPARENT_WINDOW_COLOR : nativeWindowBackgroundColor(dark),
        symbolColor: titleBarSymbolColor(dark), height: 48 },
    }),
  };
}

/**
 * A main-owned native-client console. It uses native controls and an opaque
 * renderer URL; profile paths and credentials are supplied only to the PTY in
 * Electron main and never become BrowserWindow options.
 */
export function consoleWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
  transparent = true,
  osRelease = release(),
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "Sliver Console",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    ...terminalWindowChrome(platform, dark, transparent, osRelease),
    webPreferences: secureWebPreferences(preload),
  };
}

/**
 * A dedicated SSH terminal host. Connections and credentials stay owned by
 * Electron main; the sandboxed renderer receives only revocable byte streams.
 */
export function sshWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
  transparent = true,
  osRelease = release(),
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 540,
    show: false,
    title: "SSH",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    ...terminalWindowChrome(platform, dark, transparent, osRelease),
    webPreferences: secureWebPreferences(preload),
  };
}

/**
 * A native, full-size window for one target interaction workspace. Target
 * identity is never encoded in these options or the renderer URL; Electron
 * main binds the destination window to the source window's exact active target
 * before loading the static interaction surface.
 */
export function interactionWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1360,
    height: 900,
    minWidth: 840,
    minHeight: 640,
    show: false,
    title: "Interact",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: secureWebPreferences(preload),
  };
}

/** A local-only package manager with no operator or execution bridge. */
export function armoryWindowOptions(
  preload: string,
  platform: NodeJS.Platform = process.platform,
  icon?: string,
  dark = true,
): BrowserWindowConstructorOptions {
  return {
    width: 1180,
    height: 840,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: "Armory",
    backgroundColor: nativeWindowBackgroundColor(dark),
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    ...(platform !== "darwin" && icon ? { icon } : {}),
    webPreferences: { ...secureWebPreferences(preload), partition: ARMORY_SESSION_PARTITION },
  };
}

export const ARMORY_SESSION_PARTITION = "sliver-armory";
