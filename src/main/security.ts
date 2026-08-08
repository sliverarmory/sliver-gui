import { fileURLToPath } from "node:url";

import type { BrowserWindow, Session, WebPreferences } from "electron";

export function productionContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-elem 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
  ].join("; ");
}

export function developmentContentSecurityPolicy(devServerUrl: string): string {
  const origin = new URL(devServerUrl).origin;
  const websocketOrigin = origin.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    `script-src 'self' ${origin}`,
    `script-src-elem 'self' ${origin}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' ${origin} data: blob:`,
    "font-src 'self' data:",
    `connect-src 'self' ${origin} ${websocketOrigin}`,
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'none'",
  ].join("; ");
}

export function secureWebPreferences(preload: string): WebPreferences {
  return {
    preload,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function configureSessionSecurity(session: Session, devServerUrl?: string): void {
  const csp = devServerUrl
    ? developmentContentSecurityPolicy(devServerUrl)
    : productionContentSecurityPolicy();

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders["Content-Security-Policy"] = [csp];
    callback({ responseHeaders });
  });

  session.setPermissionCheckHandler(() => false);
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setDevicePermissionHandler(() => false);
}

export function isTrustedRendererUrl(candidateUrl: string, expectedRendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(expectedRendererUrl);

    if (expected.protocol === "file:") {
      return candidate.protocol === "file:" && fileURLToPath(candidate) === fileURLToPath(expected);
    }

    if (expected.protocol !== "http:" && expected.protocol !== "https:") return false;
    return candidate.protocol === expected.protocol && candidate.origin === expected.origin;
  } catch {
    return false;
  }
}

export function hardenWindow(window: BrowserWindow, rendererUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isTrustedRendererUrl(url, rendererUrl)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}
