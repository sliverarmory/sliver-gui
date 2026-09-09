import type { App, Session, WebContents } from "electron";

import { APP_RENDERER_URL } from "./app-protocol.js";
import { isTrustedRendererUrl } from "./security.js";

const guardedApplications = new WeakSet<App>();

/** Install before creating app windows so every window, view, and session is guarded. */
export function installApplicationNavigationSecurity(application: App, navigationPreloadPath: string): void {
  if (guardedApplications.has(application)) return;
  guardedApplications.add(application);
  const guardedSessions = new WeakSet<Session>();

  const guardSession = (session: Session): void => {
    if (guardedSessions.has(session)) return;
    guardedSessions.add(session);
    // Session preloads run before each window's own preload, including for
    // future windows/views which have no application-specific preload at all.
    session.registerPreloadScript({ type: "frame", filePath: navigationPreloadPath });
    // This is the sole onBeforeRequest listener: Electron replaces an existing
    // listener rather than composing them. Only document loads are restricted;
    // main-process fetches, downloads, and renderer assets retain their policies.
    session.webRequest.onBeforeRequest((details, callback) => {
      const cancel = details.resourceType === "subFrame"
        ? !isDevToolsNavigation(details.url, details.webContents)
        : details.resourceType === "mainFrame" && !allowsNavigation(details.url, details.webContents);
      callback({ cancel });
    });
  };

  application.on("session-created", guardSession);
  application.on("web-contents-created", (_event, contents) => {
    // Also covers sessions created before this hook was installed.
    guardSession(contents.session);
    // Electron's loadURL/loadFile APIs bypass will-navigate. Request-level
    // cancellation alone can still replace the page with a Chromium error
    // document, while about:/data: loads may not issue a request at all.
    // Reject before dispatch so accidental main-process loads keep the app UI.
    const loadURL = contents.loadURL.bind(contents);
    contents.loadURL = (url, options) => allowsNavigation(url, contents)
      ? loadURL(url, options)
      : Promise.reject(new Error("Application views may only load the Sliver renderer"));
    contents.loadFile = () => Promise.reject(new Error("Application views may only load the Sliver renderer"));
    const preventUntrustedNavigation = (event: {
      url: string; isMainFrame: boolean; preventDefault(): void;
    }): void => {
      // Application frames are disallowed, matching the renderer's frame-src
      // 'none' CSP. Blank initial child contexts never host app documents.
      const allowed = event.isMainFrame === false
        ? isDevToolsNavigation(event.url, contents)
        : allowsNavigation(event.url, contents);
      if (!allowed) event.preventDefault();
    };
    contents.on("will-navigate", preventUntrustedNavigation);
    contents.on("will-frame-navigate", preventUntrustedNavigation);
    contents.on("will-redirect", preventUntrustedNavigation);
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

function allowsNavigation(url: string, contents?: WebContents): boolean {
  return isTrustedRendererUrl(url, APP_RENDERER_URL) || isDevToolsNavigation(url, contents);
}

function isDevToolsNavigation(url: string, contents?: WebContents): boolean {
  // Electron's own DevTools frontend is a remote WebContents, not an app view.
  // Keep its bundled UI usable without allowing app windows to load devtools:.
  if (!contents || contents.isDestroyed() || contents.getType() !== "remote") return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "devtools:" && parsed.host === "devtools" &&
      parsed.pathname.startsWith("/bundled/") &&
      parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}
