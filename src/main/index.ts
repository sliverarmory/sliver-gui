import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, session, shell } from "electron";

import { ConnectionRegistry } from "./connection-registry.js";
import { registerIpcHandlers } from "./ipc.js";
import { configureSessionSecurity, hardenWindow, secureWebPreferences } from "./security.js";

const registry = new ConnectionRegistry();
const windows = new Set<BrowserWindow>();
const mainBundleDirectory = import.meta.dirname;
const rendererEntryPath = join(mainBundleDirectory, "../renderer/index.html");
const developmentRendererUrl = readDevelopmentRendererUrl();
const rendererUrl = developmentRendererUrl ?? pathToFileURL(rendererEntryPath).href;

function readDevelopmentRendererUrl(): string | undefined {
  const value = process.env.ELECTRON_RENDERER_URL?.trim();
  if (!value) return undefined;

  const url = new URL(value);
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !loopbackHosts.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("ELECTRON_RENDERER_URL must be an HTTP(S) loopback URL");
  }
  return url.href;
}

function createWindow(inheritFromContentsId?: number): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    backgroundColor: "#0b0d10",
    title: "Sliver GUI",
    ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" as const } : {}),
    webPreferences: secureWebPreferences(join(mainBundleDirectory, "../preload/index.cjs")),
  });

  const contentsId = window.webContents.id;
  windows.add(window);
  registry.registerWindow(contentsId);
  if (inheritFromContentsId !== undefined) {
    registry.inheritConnection(inheritFromContentsId, contentsId);
  }

  hardenWindow(window, rendererUrl);
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    windows.delete(window);
    void registry.unregisterWindow(contentsId);
  });

  if (developmentRendererUrl) {
    void window.loadURL(developmentRendererUrl);
  } else {
    void window.loadFile(rendererEntryPath);
  }

  return window;
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Window",
          accelerator: "CmdOrCtrl+N",
          click: () => createWindow(),
        },
        {
          label: "Duplicate Connected Window",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => createWindow(BrowserWindow.getFocusedWindow()?.webContents.id),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Sliver Documentation",
          click: () => void shell.openExternal("https://sliver.sh/docs"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => createWindow());
  void app.whenReady().then(() => {
    configureSessionSecurity(session.defaultSession, developmentRendererUrl);
    registerIpcHandlers(registry, (inheritFromContentsId) => createWindow(inheritFromContentsId), rendererUrl);
    installMenu();
    createWindow();

    app.on("activate", () => {
      if (windows.size === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
