import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, BrowserWindow, Menu, session, shell } from "electron";

import { ConnectionRegistry } from "./connection-registry.js";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc.js";
import { configureSessionSecurity, hardenWindow } from "./security.js";
import { mainWindowOptions } from "./window-options.js";

export interface StartApplicationOptions {
  registry?: ConnectionRegistry;
  rendererEntryPath?: string;
  preloadPath?: string;
  developmentRendererUrl?: string;
}

export interface ApplicationHandle {
  createWindow(inheritFromContentsId?: number): BrowserWindow;
  stop(): Promise<void>;
}

/**
 * Compose the trusted Electron main process. Tests may inject an in-memory
 * backend by importing this module from a test-only main entry; the production
 * entrypoint always uses the real ConnectionRegistry defaults.
 */
export async function startApplication(options: StartApplicationOptions = {}): Promise<ApplicationHandle> {
  const registry = options.registry ?? new ConnectionRegistry();
  const mainBundleDirectory = import.meta.dirname;
  const rendererEntryPath = options.rendererEntryPath ?? join(mainBundleDirectory, "../renderer/index.html");
  const preloadPath = options.preloadPath ?? join(mainBundleDirectory, "../preload/index.cjs");
  // Packaged applications always trust their immutable file entry. A caller's
  // inherited environment must never redirect production IPC trust to even a
  // loopback web origin.
  const developmentRendererUrl = app.isPackaged
    ? undefined
    : options.developmentRendererUrl ?? readDevelopmentRendererUrl();
  const rendererUrl = developmentRendererUrl ?? pathToFileURL(rendererEntryPath).href;
  const windows = new Set<BrowserWindow>();
  const pendingWindowCleanup = new Set<Promise<void>>();

  function createWindow(inheritFromContentsId?: number): BrowserWindow {
    const window = new BrowserWindow(mainWindowOptions(preloadPath));
    const contentsId = window.webContents.id;
    windows.add(window);
    registry.registerWindow(contentsId);
    if (inheritFromContentsId !== undefined) {
      registry.inheritConnection(inheritFromContentsId, contentsId);
    }

    hardenWindow(window, rendererUrl);
    window.once("ready-to-show", () => window.show());
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        void registry.closeWindowStreams(contentsId, "navigation").catch(() => undefined);
      }
    });
    window.webContents.on("render-process-gone", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
    });
    window.webContents.on("destroyed", () => {
      void registry.closeWindowStreams(contentsId, "renderer-gone").catch(() => undefined);
    });
    window.on("closed", () => {
      windows.delete(window);
      const cleanup = registry.unregisterWindow(contentsId).catch(() => undefined);
      pendingWindowCleanup.add(cleanup);
      void cleanup.finally(() => pendingWindowCleanup.delete(cleanup));
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

  const onActivate = (): void => {
    if (windows.size === 0) createWindow();
  };
  const onWindowAllClosed = (): void => {
    if (process.platform !== "darwin") app.quit();
  };

  await app.whenReady();
  configureSessionSecurity(session.defaultSession, developmentRendererUrl, rendererUrl);
  registerIpcHandlers(registry, (inheritFromContentsId) => createWindow(inheritFromContentsId), rendererUrl);
  installMenu();
  app.on("activate", onActivate);
  app.on("window-all-closed", onWindowAllClosed);
  createWindow();

  return {
    createWindow,
    async stop(): Promise<void> {
      app.removeListener("activate", onActivate);
      app.removeListener("window-all-closed", onWindowAllClosed);
      unregisterIpcHandlers();
      for (const window of [...windows]) {
        await registry.closeWindowStreams(window.webContents.id, "application-shutdown").catch(() => undefined);
        window.close();
      }
      await Promise.allSettled([...pendingWindowCleanup]);
    },
  };
}

export function readDevelopmentRendererUrl(): string | undefined {
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
