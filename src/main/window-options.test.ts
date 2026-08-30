// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  consoleWindowOptions,
  interactionWindowOptions,
  mainWindowOptions,
  sessionShellWindowOptions,
} from "./window-options.js";

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
    const mac = mainWindowOptions("/preload.js", "darwin", "/brand.png");
    const windows = mainWindowOptions("/preload.js", "win32", "/brand.png");
    const linux = mainWindowOptions("/preload.js", "linux", "/brand.png");

    expect(mac).toMatchObject({
      titleBarStyle: "hiddenInset",
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
    });
    expect(mac).not.toHaveProperty("frame");
    expect(mac).not.toHaveProperty("titleBarOverlay");
    expect(mac).not.toHaveProperty("backgroundMaterial");
    expect(mac).not.toHaveProperty("icon");

    expect(windows).toMatchObject({
      frame: false,
      backgroundMaterial: "acrylic",
      icon: "/brand.png",
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
      icon: "/brand.png",
      titleBarOverlay: {
        color: "#00000000",
        height: 72,
      },
    });
    expect(linux).not.toHaveProperty("vibrancy");
    expect(linux).not.toHaveProperty("backgroundMaterial");
  });
});

describe("managed-shell window", () => {
  it("uses focused native chrome while preserving the hardened renderer preferences", () => {
    const options = sessionShellWindowOptions("/absolute/preload.js", "linux", "/brand.png");

    expect(options).toMatchObject({
      title: "Managed Shells",
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 540,
      show: false,
      icon: "/brand.png",
      webPreferences: {
        preload: "/absolute/preload.js",
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    expect(options).not.toHaveProperty("parent");
  });
});

describe("Sliver console window", () => {
  it("uses native chrome and never encodes profile material in window options", () => {
    const options = consoleWindowOptions("/absolute/preload.js", "linux", "/brand.png");

    expect(options).toMatchObject({
      title: "Sliver Console",
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 540,
      show: false,
      backgroundColor: "#09090b",
      icon: "/brand.png",
      webPreferences: {
        preload: "/absolute/preload.js",
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(JSON.stringify(options)).not.toMatch(/config|operator|certificate|token/iu);
  });
});

describe("interaction window", () => {
  it("uses dedicated native chrome while preserving hardened renderer preferences", () => {
    const options = interactionWindowOptions("/absolute/preload.js", "linux", "/brand.png");

    expect(options).toMatchObject({
      title: "Interact",
      width: 1360,
      height: 900,
      minWidth: 840,
      minHeight: 640,
      show: false,
      backgroundColor: "#09090b",
      icon: "/brand.png",
      webPreferences: {
        preload: "/absolute/preload.js",
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    expect(options).not.toHaveProperty("parent");
    expect(options).not.toHaveProperty("transparent");
    expect(options).not.toHaveProperty("titleBarOverlay");
  });
});
