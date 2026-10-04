// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  ARMORY_SESSION_PARTITION,
  armoryWindowOptions,
  CLOUD_DEPLOYMENT_SESSION_PARTITION,
  NETWORK_SESSION_PARTITION,
  cloudDeploymentWindowOptions,
  consoleWindowOptions,
  interactionWindowOptions,
  mainWindowOptions,
  networkWindowOptions,
  sessionPanelWindowOptions,
  sessionShellWindowOptions,
  sshWindowOptions,
  supportsTerminalTransparency,
  TEXT_EDITOR_SESSION_PARTITION,
  textEditorWindowOptions,
} from "./window-options.js";

describe("standalone text editor window", () => {
  it.each(["darwin", "linux", "win32"] as const)("retains a dedicated sandbox and native controls on %s", (platform) => {
    const options = textEditorWindowOptions("/text-editor.cjs", platform, "/brand.png", false);
    expect(options).toMatchObject({
      title: "Text Editor", show: false, width: 1120, height: 780,
      minWidth: 720, minHeight: 480, backgroundColor: "#fafafa",
      webPreferences: {
        preload: "/text-editor.cjs", partition: TEXT_EDITOR_SESSION_PARTITION,
        nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false,
      },
    });
    if (platform === "darwin") expect(options.titleBarStyle).toBe("hiddenInset");
    else expect(options).toMatchObject({ icon: "/brand.png" });
    expect(options).not.toHaveProperty("parent");
    expect(options).not.toHaveProperty("frame");
  });
});

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
          zoomFactor: 1,
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

  it("uses a readable title-bar symbol color for each application theme", () => {
    expect(mainWindowOptions("/preload.js", "linux", undefined, true)).toMatchObject({
      titleBarOverlay: { symbolColor: "#f4f4f5" },
    });
    expect(mainWindowOptions("/preload.js", "linux", undefined, false)).toMatchObject({
      titleBarOverlay: { symbolColor: "#18181b" },
    });
  });
});

describe("Network window", () => {
  it("uses standalone native chrome and its dedicated hardened preload partition", () => {
    const options = networkWindowOptions("/network-preload.js", "linux", "/brand.png");
    expect(options).toMatchObject({
      title: "Network",
      width: 1280,
      height: 840,
      minWidth: 880,
      minHeight: 640,
      show: false,
      backgroundColor: "#09090b",
      icon: "/brand.png",
      webPreferences: {
        preload: "/network-preload.js",
        partition: NETWORK_SESSION_PARTITION,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    });
    expect(JSON.stringify(options)).not.toMatch(/sessionId|password|destination|forwardId/iu);
  });

  it("uses the resolved application theme for its native background", () => {
    expect(networkWindowOptions("/network-preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
  });
});

describe("Cloud Deployment window", () => {
  it("uses standalone native chrome while preserving hardened renderer preferences", () => {
    const options = cloudDeploymentWindowOptions("/cloud-preload.js", "linux", "/brand.png");

    expect(options).toMatchObject({
      title: "Cloud Deployment",
      width: 1180,
      height: 780,
      minWidth: 800,
      minHeight: 600,
      show: false,
      backgroundColor: "#09090b",
      icon: "/brand.png",
      webPreferences: {
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        partition: CLOUD_DEPLOYMENT_SESSION_PARTITION,
        preload: "/cloud-preload.js",
      },
    });
    expect(options).not.toHaveProperty("parent");
    expect(options).not.toHaveProperty("transparent");
    expect(options).not.toHaveProperty("titleBarOverlay");
  });

  it("uses the resolved application theme for its native background", () => {
    expect(cloudDeploymentWindowOptions("/cloud-preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
  });
});

describe.each([
  ["Armory", armoryWindowOptions],
  ["Cloud Deployment", cloudDeploymentWindowOptions],
  ["Network", networkWindowOptions],
] as const)("%s title bar", (_name, windowOptions) => {
  it.each(["darwin", "linux", "win32"] as const)(
    "retains native window controls and uses inset chrome only on macOS (%s)",
    (platform) => {
      const options = windowOptions("/preload.js", platform, "/brand.png");

      if (platform === "darwin") {
        expect(options.titleBarStyle).toBe("hiddenInset");
        expect(options).not.toHaveProperty("icon");
      } else {
        expect(options).not.toHaveProperty("titleBarStyle");
        expect(options.icon).toBe("/brand.png");
      }
      expect(options).not.toHaveProperty("frame");
      expect(options).not.toHaveProperty("titleBarOverlay");
    },
  );
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

  it("uses the resolved application theme for its native background", () => {
    expect(sessionShellWindowOptions("/preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
  });
});

describe("session panel window", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "uses native controls and a sandboxed operator preload on %s",
    (platform) => {
      const options = sessionPanelWindowOptions("/absolute/preload.js", platform, "/brand.png");

      expect(options).toMatchObject({
        show: false,
        backgroundColor: "#09090b",
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
      expect(options.title).toEqual(expect.any(String));
      expect(options.width).toBeGreaterThanOrEqual(720);
      expect(options.height).toBeGreaterThanOrEqual(540);
      expect(options).not.toHaveProperty("parent");
      expect(options).not.toHaveProperty("frame");
      expect(options).not.toHaveProperty("titleBarOverlay");
      if (platform === "darwin") expect(options).not.toHaveProperty("icon");
      else expect(options.icon).toBe("/brand.png");
      expect(JSON.stringify(options)).not.toMatch(/sessionId|targetFingerprint|backendEpoch|remotePath/iu);
    },
  );

  it("uses the resolved application theme for its native background", () => {
    expect(sessionPanelWindowOptions("/preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
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

  it("uses the resolved application theme for its native background", () => {
    expect(consoleWindowOptions("/preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
  });
});

describe("SSH window", () => {
  it("uses native chrome and a dedicated hardened preload", () => {
    const options = sshWindowOptions("/ssh-preload.js", "linux", "/brand.png");

    expect(options).toMatchObject({
      title: "SSH",
      width: 1180,
      height: 780,
      minWidth: 720,
      minHeight: 540,
      show: false,
      backgroundColor: "#09090b",
      icon: "/brand.png",
      webPreferences: {
        preload: "/ssh-preload.js",
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
      },
    });
    expect(JSON.stringify(options)).not.toMatch(/privateKey|passphrase|credentialId/u);
  });

  it("uses the resolved application theme for its native background", () => {
    expect(sshWindowOptions("/ssh-preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
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

  it("uses the resolved application theme for its native background", () => {
    expect(interactionWindowOptions("/preload.js", "linux", undefined, false).backgroundColor)
      .toBe("#fafafa");
  });
});


describe("Armory window", () => {
  it.each(["darwin", "linux", "win32"] as const)("isolates local package management on %s", (platform) => {
    const options = armoryWindowOptions("/armory.cjs", platform, "/icon.png");
    expect(options).toMatchObject({
      title: "Armory", show: false,
      webPreferences: {
        preload: "/armory.cjs", partition: ARMORY_SESSION_PARTITION,
        sandbox: true, contextIsolation: true, nodeIntegration: false,
        nodeIntegrationInSubFrames: false, webSecurity: true, webviewTag: false,
      },
    });
    expect(options).not.toHaveProperty("parent");
    expect(options).not.toHaveProperty("transparent");
  });
});


describe("terminal native glass", () => {
  it.each([consoleWindowOptions, sshWindowOptions])("uses live-toggleable macOS chrome and preserves isolation", (optionsFor) => {
    expect(optionsFor("/preload.cjs", "darwin", undefined, true, true)).toMatchObject({
      transparent: true, backgroundColor: "#00000000", vibrancy: "sidebar", titleBarStyle: "hiddenInset",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    const opaque = optionsFor("/preload.cjs", "darwin", undefined, true, false);
    expect(opaque.backgroundColor).toBe("#09090b");
    expect(opaque.vibrancy).toBeUndefined();
    expect(opaque.titleBarStyle).toBe("hiddenInset");
  });

  it("limits acrylic to supported Windows builds and leaves Linux opaque", () => {
    expect(supportsTerminalTransparency("win32", "10.0.22000")).toBe(false);
    expect(supportsTerminalTransparency("win32", "10.0.22621")).toBe(true);
    expect(supportsTerminalTransparency("linux", "6.12.0")).toBe(false);
    expect(sshWindowOptions("/preload.cjs", "win32", undefined, true, true, "10.0.22621")).toMatchObject({
      frame: false, backgroundMaterial: "acrylic", backgroundColor: "#00000000", titleBarOverlay: { height: 48 },
    });
    expect(consoleWindowOptions("/preload.cjs", "win32", undefined, false, false, "10.0.22621")).toMatchObject({
      backgroundMaterial: "none", backgroundColor: "#fafafa",
    });
    for (const [platform, release] of [["linux", "6.12.0"], ["win32", "10.0.22000"]] as const) {
      const options = consoleWindowOptions("/preload.cjs", platform, undefined, true, true, release);
      expect(options.transparent).toBeUndefined();
      expect(options.backgroundMaterial).toBeUndefined();
    }
  });
});
