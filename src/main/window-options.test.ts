// @vitest-environment node

import { describe, expect, it } from "vitest";

import { mainWindowOptions } from "./window-options.js";

describe("main window transparency", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "uses a transparent native surface on %s without weakening renderer isolation",
    (platform) => {
      const options = mainWindowOptions("/absolute/preload.js", platform);

      expect(options).toMatchObject({
        transparent: true,
        backgroundColor: "#00000000",
        webPreferences: {
          preload: "/absolute/preload.js",
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
    },
  );

  it("uses native glass materials on macOS and Windows", () => {
    const mac = mainWindowOptions("/preload.js", "darwin");
    const windows = mainWindowOptions("/preload.js", "win32");
    const linux = mainWindowOptions("/preload.js", "linux");

    expect(mac).toMatchObject({
      titleBarStyle: "hiddenInset",
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    });
    expect(mac).not.toHaveProperty("frame");
    expect(mac).not.toHaveProperty("titleBarOverlay");
    expect(mac).not.toHaveProperty("backgroundMaterial");

    expect(windows).toMatchObject({
      frame: false,
      backgroundMaterial: "acrylic",
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        symbolColor: "#f4f4f5",
        height: 72,
      },
    });
    expect(windows).not.toHaveProperty("vibrancy");

    expect(linux).toMatchObject({
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#00000000",
        height: 72,
      },
    });
    expect(linux).not.toHaveProperty("vibrancy");
    expect(linux).not.toHaveProperty("backgroundMaterial");
  });
});
