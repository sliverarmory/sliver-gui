import { randomBytes } from "node:crypto";
import { BrowserWindow, session, type Session } from "electron";
import type { WebsiteContentInput } from "../shared/website-contracts.js";
import { registerIsolatedWebsitePreviewSession } from "./navigation-security.js";
import {
  buildWebsiteRenderedPreview, WEBSITE_RENDERED_PREVIEW_CSP, WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES,
} from "./website-rendered-preview.js";

export const WEBSITE_PREVIEW_SCHEME = "website-preview";
export const WEBSITE_PREVIEW_SCHEME_PRIVILEGES = Object.freeze({ standard: true, secure: true, supportFetchAPI: false });
const MAX_PREVIEW_WINDOWS = 4;

export interface WebsitePreviewController {
  open(owner: BrowserWindow, input: WebsiteContentInput, bytes: Uint8Array, contentType: string, assertBinding: () => void): Promise<void>;
  closeOwner(contentsId: number): void;
  dispose(): void;
}

interface PreviewWindow {
  window: BrowserWindow;
  owner: BrowserWindow;
  session: Session;
  revoke: () => void;
  document: Uint8Array;
  ownerDestroyed: () => void;
  closed: boolean;
}

/** Serves sanitized static documents in windows that have no application preload or IPC identity. */
export class WebsitePreviewWindows implements WebsitePreviewController {
  readonly #windows = new Map<number, PreviewWindow>();
  #disposed = false;

  async open(
    owner: BrowserWindow, _input: WebsiteContentInput, bytes: Uint8Array, contentType: string, assertBinding: () => void,
  ): Promise<void> {
    assertBinding();
    if (this.#disposed || owner.isDestroyed() || owner.webContents.isDestroyed()) throw new Error("Website preview owner is unavailable");
    const rendered = buildWebsiteRenderedPreview({ bytes, contentType });
    const document = new TextEncoder().encode(rendered.html);
    if (document.byteLength > WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES) {
      document.fill(0);
      throw new Error("Rendered website preview exceeds the document limit");
    }
    const ownerId = owner.webContents.id;
    this.closeOwner(ownerId);
    if (this.#windows.size >= MAX_PREVIEW_WINDOWS) {
      document.fill(0);
      throw new Error("Close an existing website preview before opening another");
    }
    const token = randomBytes(32).toString("hex");
    const documentUrl = `${WEBSITE_PREVIEW_SCHEME}://${token}/document`;
    const isolatedSession = session.fromPartition(`website-preview-${token}`, { cache: false });
    let revoke = (): void => {};
    let state: PreviewWindow | undefined;
    try {
      revoke = registerIsolatedWebsitePreviewSession(isolatedSession, documentUrl);
      isolatedSession.setPermissionCheckHandler(() => false);
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      isolatedSession.setDevicePermissionHandler(() => false);
      isolatedSession.on("will-download", (event) => event.preventDefault());
      isolatedSession.protocol.handle(WEBSITE_PREVIEW_SCHEME, (request) => {
        try {
          assertBinding();
          if (!state || state.closed || request.method !== "GET" || request.url !== documentUrl) {
            return new Response(null, { status: 404 });
          }
          return new Response(new Uint8Array(state.document), {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": WEBSITE_RENDERED_PREVIEW_CSP,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
              "Referrer-Policy": "no-referrer",
            },
          });
        } catch { return new Response(null, { status: 410 }); }
      });
      assertBinding();
      const window = new BrowserWindow({
        title: "Website preview", width: 1100, height: 800, show: false, parent: owner, autoHideMenuBar: true,
        webPreferences: {
          session: isolatedSession, nodeIntegration: false, nodeIntegrationInWorker: false,
          nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
          javascript: false, plugins: false, devTools: false, webviewTag: false, spellcheck: false,
          navigateOnDragDrop: false, allowRunningInsecureContent: false, experimentalFeatures: false,
        },
      });
      state = {
        window, owner, session: isolatedSession, revoke, document, closed: false,
        ownerDestroyed: () => this.closeOwner(ownerId),
      };
      this.#windows.set(ownerId, state);
      owner.webContents.once("destroyed", state.ownerDestroyed);
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      const prevent = (event: { preventDefault(): void }): void => event.preventDefault();
      window.webContents.on("will-navigate", prevent);
      window.webContents.on("will-frame-navigate", prevent);
      window.webContents.on("will-redirect", prevent);
      window.webContents.on("will-attach-webview", prevent);
      window.webContents.on("page-title-updated", (event) => event.preventDefault());
      window.on("page-title-updated", (event) => event.preventDefault());
      window.webContents.once("render-process-gone", () => this.closeOwner(ownerId));
      window.once("closed", () => this.#clean(ownerId, state!));
      await window.loadURL(documentUrl);
      assertBinding();
      if (state.closed || this.#windows.get(ownerId) !== state) throw new Error("Website preview was closed");
      window.setTitle("Website preview");
      window.show();
    } catch (error) {
      if (state) this.#clean(ownerId, state);
      else {
        revoke();
        document.fill(0);
        isolatedSession.protocol.unhandle(WEBSITE_PREVIEW_SCHEME);
        void isolatedSession.clearStorageData().catch(() => undefined);
        void isolatedSession.clearCache().catch(() => undefined);
      }
      throw error;
    }
  }

  closeOwner(contentsId: number): void {
    const state = this.#windows.get(contentsId);
    if (state) this.#clean(contentsId, state);
  }

  dispose(): void {
    this.#disposed = true;
    for (const [ownerId, state] of this.#windows) this.#clean(ownerId, state);
  }

  #clean(ownerId: number, state: PreviewWindow): void {
    if (state.closed) return;
    state.closed = true;
    state.revoke();
    if (this.#windows.get(ownerId) === state) this.#windows.delete(ownerId);
    state.owner.webContents.removeListener("destroyed", state.ownerDestroyed);
    state.document.fill(0);
    state.session.protocol.unhandle(WEBSITE_PREVIEW_SCHEME);
    if (!state.window.isDestroyed()) state.window.destroy();
    void state.session.clearStorageData().catch(() => undefined);
    void state.session.clearCache().catch(() => undefined);
  }
}
