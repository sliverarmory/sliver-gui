import type { BrowserWindowConstructorOptions } from "electron";

import { secureWebPreferences } from "./security.js";

const TRANSPARENT_WINDOW_COLOR = "#00000000";

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
          titleBarOverlay: {
            color: TRANSPARENT_WINDOW_COLOR,
            symbolColor: "#f4f4f5",
            height: 72,
          },
        }
      : {}),
    webPreferences: secureWebPreferences(preload),
  };
}
