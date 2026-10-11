import { createServer, validateHeaderValue, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { shell, type BrowserWindow } from "electron";
import { parseWebsiteContentInput, parseUpdateWebsiteContentTypeInput, WEBSITE_LIMITS, type WebsiteContentInput } from "../shared/website-contracts.js";
import { openExternalWebUrl } from "./external-web-url.js";

const MAX_PREVIEW_SERVERS = 4;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_PENDING_REQUESTS = 32;
// A BMP character expands to nine ASCII characters when its UTF-8 bytes are escaped.
const MAX_REQUEST_TARGET_CHARACTERS = WEBSITE_LIMITS.pathCharacters * 9 + 2048;
export const WEBSITE_PREVIEW_CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:", "font-src 'self' data:", "media-src 'self' data: blob:",
  "connect-src 'self'", "worker-src 'none'", "child-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri 'self'", "form-action 'none'", "frame-ancestors 'none'", "sandbox allow-scripts allow-same-origin",
].join("; ");

/** The returned bytes belong to the preview server and are cleared after the response. */
export interface WebsitePreviewContent { bytes: Uint8Array; contentType: string; }
export type FetchWebsitePreviewContent = (path: string) => Promise<WebsitePreviewContent | undefined>;
export interface WebsitePreviewController {
  open(owner: BrowserWindow, input: WebsiteContentInput, fetchContent: FetchWebsitePreviewContent, assertBinding: () => void): Promise<void>;
  closeOwner(contentsId: number): void;
  dispose(): void;
}
interface PreviewServer {
  server: Server;
  owner: BrowserWindow;
  ownerDestroyed: () => void;
  origin: string;
  closed: boolean;
  ready: boolean;
  activeRequests: number;
  pendingRequests: Array<(allowed: boolean) => void>;
}

/** Hosted bytes only enter the default browser, never an Electron application view. */
export class WebsitePreviewServer implements WebsitePreviewController {
  readonly #servers = new Map<number, PreviewServer>();
  #disposed = false;

  async open(
    owner: BrowserWindow, input: WebsiteContentInput, fetchContent: FetchWebsitePreviewContent, assertBinding: () => void,
  ): Promise<void> {
    const parsed = parseWebsiteContentInput(input);
    assertBinding();
    if (this.#disposed || owner.isDestroyed() || owner.webContents.isDestroyed()) throw new Error("Website preview owner is unavailable");
    const ownerId = owner.webContents.id;
    this.closeOwner(ownerId);
    if (this.#servers.size >= MAX_PREVIEW_SERVERS) throw new Error("Close an existing website preview before opening another");
    const server = createServer({ maxHeaderSize: 32 * 1024, requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 1000 });
    const state: PreviewServer = {
      server, owner, origin: "", closed: false, ready: false, activeRequests: 0, pendingRequests: [],
      ownerDestroyed: () => this.closeOwner(ownerId),
    };
    this.#servers.set(ownerId, state);
    owner.webContents.once("destroyed", state.ownerDestroyed);
    server.maxConnections = 64;
    server.setTimeout(30_000, (socket) => socket.destroy());
    server.on("request", (request, response) => { void this.#serve(state, request, response, parsed.name, fetchContent, assertBinding); });
    server.on("upgrade", (_request, socket) => socket.destroy());
    server.on("connect", (_request, socket) => socket.destroy());
    server.on("error", () => this.#clean(ownerId, state));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          state.ready = true;
          server.removeListener("error", reject);
          if (state.closed) server.close(() => {});
          resolve();
        });
      });
      assertBinding();
      if (state.closed || this.#servers.get(ownerId) !== state) throw new Error("Website preview was closed");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Website preview did not bind a local port");
      state.origin = `http://127.0.0.1:${address.port}`;
      const path = parsed.path.split("/").map(encodeURIComponent).join("/");
      await openExternalWebUrl(`${state.origin}${path}`, (url) => shell.openExternal(url));
      assertBinding();
      if (state.closed) throw new Error("Website preview was closed");
    } catch (error) {
      this.#clean(ownerId, state);
      // An owner can disappear while listen() is pending; close again after it settles.
      server.close(() => {});
      throw error;
    }
  }

  closeOwner(contentsId: number): void {
    const state = this.#servers.get(contentsId);
    if (state) this.#clean(contentsId, state);
  }

  dispose(): void {
    this.#disposed = true;
    for (const [ownerId, state] of this.#servers) this.#clean(ownerId, state);
  }

  #clean(ownerId: number, state: PreviewServer): void {
    if (state.closed) return;
    state.closed = true;
    if (this.#servers.get(ownerId) === state) this.#servers.delete(ownerId);
    state.owner.webContents.removeListener("destroyed", state.ownerDestroyed);
    for (const pending of state.pendingRequests.splice(0)) pending(false);
    // Closing before the listening event can suppress that event and strand open().
    if (state.ready) state.server.close(() => {});
    state.server.closeAllConnections();
  }

  async #serve(
    state: PreviewServer, request: IncomingMessage, response: ServerResponse, name: string,
    fetchContent: FetchWebsitePreviewContent, assertBinding: () => void,
  ): Promise<void> {
    // No validators, ranges, or cached bytes: every successful request reads current backend content.
    response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    response.setHeader("Pragma", "no-cache");
    response.setHeader("Expires", "0");
    response.setHeader("Content-Security-Policy", WEBSITE_PREVIEW_CSP);
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), clipboard-read=(), clipboard-write=()");
    const fail = (status: number, message: string): void => {
      if (response.destroyed) return;
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(request.method === "HEAD" ? undefined : message);
    };
    if (state.closed || !state.origin) { fail(410, "Website preview is no longer available"); return; }
    if (request.headers.host !== state.origin.slice("http://".length) ||
        (request.headers.origin !== undefined && request.headers.origin !== state.origin) ||
        (request.headers["sec-fetch-site"] !== undefined && !["none", "same-origin"].includes(String(request.headers["sec-fetch-site"])))) {
      fail(403, "Website preview requests must use their local origin"); return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD"); fail(405, "Website previews are read-only"); return;
    }
    if (request.headers["service-worker"] !== undefined ||
        ["serviceworker", "sharedworker", "worker"].includes(String(request.headers["sec-fetch-dest"]))) {
      fail(403, "Workers are disabled for website previews"); return;
    }
    let path: string;
    try {
      const target = request.url ?? "";
      // Inspect the raw target before URL parsing can normalize traversal or backslashes.
      if (!target.startsWith("/") || target.startsWith("//") || /[\\#\u0000-\u0020\u007f]/u.test(target) || target.length > MAX_REQUEST_TARGET_CHARACTERS) throw new Error("Invalid target");
      const rawPath = target.split("?", 1)[0]!;
      if (/%(?:2f|5c)/iu.test(rawPath)) throw new Error("Encoded separators are not paths");
      path = parseWebsiteContentInput({ name, path: decodeURIComponent(rawPath) }).path;
    } catch { fail(400, "Invalid website preview path"); return; }
    if (state.pendingRequests.length >= MAX_PENDING_REQUESTS) { fail(503, "Website preview is busy; retry shortly"); return; }
    if (!await this.#acquireRequest(state, response)) return;
    let content: WebsitePreviewContent | undefined;
    const assertCurrent = (): void => {
      try { assertBinding(); }
      catch (error) { this.#clean(state.owner.webContents.id, state); throw error; }
    };
    try {
      if (state.closed || response.destroyed) return;
      assertCurrent();
      content = await fetchContent(path);
      assertCurrent();
      if (state.closed || response.destroyed) { fail(410, "Website preview is no longer available"); return; }
      if (!content) { fail(404, "Website content was not found"); return; }
      if (content.bytes.byteLength > WEBSITE_LIMITS.artifactBytes) throw new Error("Preview content exceeds the limit");
      const contentType = parseUpdateWebsiteContentTypeInput({ name, path, contentType: content.contentType }).contentType || "application/octet-stream";
      validateHeaderValue("Content-Type", contentType);
      response.writeHead(200, { "Content-Type": contentType, "Content-Length": content.bytes.byteLength });
      await new Promise<void>((resolve) => {
        const finished = (): void => {
          response.removeListener("finish", finished);
          response.removeListener("close", finished);
          resolve();
        };
        response.once("finish", finished);
        response.once("close", finished);
        response.end(request.method === "HEAD" ? undefined : content!.bytes);
      });
    } catch {
      if (!response.headersSent) fail(502, "Website content could not be retrieved; refresh the website in Sliver Desktop");
      else response.destroy();
    } finally {
      content?.bytes.fill(0);
      const next = state.pendingRequests.shift();
      if (next) next(true);
      else state.activeRequests--;
    }
  }

  #acquireRequest(state: PreviewServer, response: ServerResponse): Promise<boolean> {
    if (state.closed || response.destroyed) return Promise.resolve(false);
    if (state.activeRequests < MAX_CONCURRENT_REQUESTS) {
      state.activeRequests++;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const admitted = (allowed: boolean): void => {
        response.removeListener("close", abandoned);
        resolve(allowed);
      };
      const abandoned = (): void => {
        const index = state.pendingRequests.indexOf(admitted);
        if (index !== -1) state.pendingRequests.splice(index, 1);
        admitted(false);
      };
      state.pendingRequests.push(admitted);
      response.once("close", abandoned);
    });
  }
}
