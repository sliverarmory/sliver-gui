import type { BrowserWindow, Session, WebContents, WebPreferences } from "electron";

// React Aria injects this fixed pressable touch-action stylesheet. Authorize
// only its exact contents; arbitrary inline styles remain blocked.
const REACT_ARIA_PRESSABLE_STYLE_HASH = "'sha256-38RhXrc7EdReTKsOm23ZPOCUgniTUUcjky8QOOrQx6o='";
// Authorize only an empty stylesheet. The pinned Monaco adapter populates its
// CSSOM from trusted editor code; arbitrary inline CSS remains unauthorized.
const EMPTY_EDITOR_STYLE_HASH = "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='";

export function productionContentSecurityPolicy(): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "script-src-elem 'self'",
    "script-src-attr 'none'",
    `style-src 'self' ${REACT_ARIA_PRESSABLE_STYLE_HASH} ${EMPTY_EDITOR_STYLE_HASH}`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    // Dedicated layout workers are emitted as local renderer assets by Vite.
    "worker-src 'self'",
  ].join("; ");
}

export function developmentContentSecurityPolicy(devServerUrl: string): string {
  const origin = new URL(devServerUrl).origin;
  const websocketOrigin = origin.replace(/^http/, "ws");
  return [
    "default-src 'none'",
    `script-src 'self' 'wasm-unsafe-eval' ${origin}`,
    `script-src-elem 'self' ${origin}`,
    "script-src-attr 'none'",
    `style-src 'self' ${REACT_ARIA_PRESSABLE_STYLE_HASH} ${EMPTY_EDITOR_STYLE_HASH}`,
    `img-src 'self' ${origin} data: blob:`,
    "font-src 'self'",
    `connect-src 'self' ${origin} ${websocketOrigin}`,
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "worker-src 'self'",
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

export function configureSessionSecurity(
  session: Session,
  devServerUrl?: string,
  trustedRendererUrl?: string,
): void {
  const csp = devServerUrl
    ? developmentContentSecurityPolicy(devServerUrl)
    : productionContentSecurityPolicy();

  session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders["Content-Security-Policy"] = [csp];
    callback({ responseHeaders });
  });

  session.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details) => (
    permitsExplicitClipboard(
      webContents,
      permission,
      details.requestingUrl,
      details.isMainFrame,
      trustedRendererUrl,
    )
  ));
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permitsExplicitClipboard(
      webContents,
      permission,
      "requestingUrl" in details ? details.requestingUrl : undefined,
      "isMainFrame" in details && details.isMainFrame,
      trustedRendererUrl,
    ));
  });
  session.setDevicePermissionHandler(() => false);
}

function permitsExplicitClipboard(
  webContents: WebContents | null,
  permission: string,
  requestingUrl: string | undefined,
  isMainFrame: boolean,
  trustedRendererUrl: string | undefined,
): boolean {
  if (
    !trustedRendererUrl ||
    !webContents ||
    webContents.isDestroyed() ||
    !isMainFrame ||
    (permission !== "clipboard-read" && permission !== "clipboard-sanitized-write") ||
    !requestingUrl
  ) return false;
  return isTrustedRendererUrl(webContents.getURL(), trustedRendererUrl) &&
    isTrustedRendererUrl(requestingUrl, trustedRendererUrl);
}

export function isTrustedRendererUrl(candidateUrl: string, expectedRendererUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(expectedRendererUrl);

    if (!["sliver:", "http:", "https:"].includes(expected.protocol)) return false;
    // Node treats custom schemes as opaque origins. Compare URL components
    // explicitly so another sliver host cannot share the renderer's trust.
    if (
      candidate.protocol !== expected.protocol ||
      candidate.hostname !== expected.hostname ||
      candidate.port !== expected.port ||
      candidate.username !== "" || candidate.password !== "" ||
      expected.username !== "" || expected.password !== ""
    ) return false;

    return expected.protocol !== "sliver:" || candidate.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function hardenWindow(
  window: BrowserWindow,
  rendererUrl: string,
  exactRendererUrl?: string,
): void {
  const allowsNavigation = (url: string): boolean => exactRendererUrl === undefined
    ? isTrustedRendererUrl(url, rendererUrl)
    : isSameRendererDocument(url, exactRendererUrl);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!allowsNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (!allowsNavigation(event.url)) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!allowsNavigation(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
}

export function isSameRendererDocument(candidateUrl: string, expectedUrl: string): boolean {
  try {
    const candidate = new URL(candidateUrl);
    const expected = new URL(expectedUrl);
    return isTrustedRendererUrl(candidateUrl, expectedUrl) &&
      candidate.pathname === expected.pathname &&
      candidate.search === expected.search;
  } catch {
    return false;
  }
}
