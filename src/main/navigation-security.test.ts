// @vitest-environment node

import { EventEmitter } from "node:events";

import type { App, Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import { installApplicationNavigationSecurity } from "./navigation-security.js";

const APP_URL = "sliver://app/index.html";
const BLOCKED_URLS = [
  "https://example.test/",
  "http://127.0.0.1:5173/",
  "file:///tmp/index.html",
  "data:text/html,benign",
  "blob:sliver://app/fixture",
  "about:blank",
  "javascript:void(0)",
  "sliver://other/index.html",
  "sliver://app.example.test/index.html",
  "sliver://app:123/index.html",
  "sliver://user@app/index.html",
  "sliver://:password@app/index.html",
  "sliver://app/other.html",
  "not a URL",
];

function sessionFixture() {
  const onBeforeRequest = vi.fn<Session["webRequest"]["onBeforeRequest"]>();
  const registerPreloadScript = vi.fn();
  const session = { webRequest: { onBeforeRequest }, registerPreloadScript } as unknown as Session;
  return {
    session,
    onBeforeRequest,
    registerPreloadScript,
    request(url: string, resourceType: string, webContents?: WebContents) {
      const callback = vi.fn();
      const listener = onBeforeRequest.mock.calls[0]?.[0];
      if (typeof listener !== "function") throw new Error("Request guard was not installed");
      listener({ url, resourceType, webContents } as Electron.OnBeforeRequestListenerDetails, callback);
      expect(callback).toHaveBeenCalledOnce();
      return callback.mock.calls[0]?.[0];
    },
  };
}

function contentsFixture(session: Session, type = "window") {
  return Object.assign(new EventEmitter(), {
    session,
    getType: () => type,
    isDestroyed: () => false,
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(async (_url: string, _options?: Electron.LoadURLOptions) => undefined),
    loadFile: vi.fn(async (_path: string) => undefined),
  });
}

describe("global application navigation security", () => {
  it.each(["window", "browserView", "webview", "offscreen", "remote"])(
    "guards new %s contents before its first load, including previously created sessions",
    (type) => {
      const application = new EventEmitter();
      installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
      const { session, onBeforeRequest } = sessionFixture();
      const contents = contentsFixture(session, type);
      application.emit("web-contents-created", {}, contents);
      expect(onBeforeRequest).toHaveBeenCalledOnce();

      for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
        for (const isMainFrame of [true, false]) {
          for (const url of BLOCKED_URLS) {
            const event = { url, isMainFrame, preventDefault: vi.fn() };
            contents.emit(name, event);
            expect(event.preventDefault, `${name}: ${url}`).toHaveBeenCalledOnce();
          }
          for (const url of [APP_URL, `${APP_URL}?surface=network`, `${APP_URL}#settings`]) {
            const event = { url, isMainFrame, preventDefault: vi.fn() };
            contents.emit(name, event);
            expect(event.preventDefault, `${name}: ${url}`).toHaveBeenCalledTimes(isMainFrame ? 0 : 1);
          }
        }
      }
      const popup = contents.setWindowOpenHandler.mock.calls[0]?.[0];
      for (const url of [APP_URL, ...BLOCKED_URLS]) {
        expect(popup({ url })).toEqual({ action: "deny" });
      }
      const event = { preventDefault: vi.fn() };
      contents.emit("will-attach-webview", event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    },
  );

  it("guards fresh partitions, only once per app and session", () => {
    const application = new EventEmitter();
    installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
    installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
    expect(application.listenerCount("web-contents-created")).toBe(1);
    expect(application.listenerCount("session-created")).toBe(1);

    for (let partition = 0; partition < 2; partition += 1) {
      const fixture = sessionFixture();
      application.emit("session-created", fixture.session);
      application.emit("web-contents-created", {}, contentsFixture(fixture.session));
      application.emit("web-contents-created", {}, contentsFixture(fixture.session, "browserView"));
      expect(fixture.onBeforeRequest).toHaveBeenCalledOnce();
      expect(fixture.registerPreloadScript).toHaveBeenCalledExactlyOnceWith({
        type: "frame", filePath: "/app/preload/navigation.cjs",
      });
      for (const resourceType of ["mainFrame", "subFrame"]) {
        for (const url of BLOCKED_URLS) {
          expect(fixture.request(url, resourceType)).toEqual({ cancel: true });
        }
        expect(fixture.request(`${APP_URL}?surface=armory#packages`, resourceType))
          .toEqual({ cancel: resourceType === "subFrame" });
      }
    }
  });

  it("rejects main-process loads before dispatch and forwards trusted load options", async () => {
    const application = new EventEmitter();
    installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
    const { session } = sessionFixture();
    const contents = contentsFixture(session);
    const loadURL = contents.loadURL;
    const loadFile = contents.loadFile;
    application.emit("web-contents-created", {}, contents);

    for (const url of BLOCKED_URLS) {
      await expect(contents.loadURL(url)).rejects.toThrow("Application views may only load the Sliver renderer");
    }
    await expect(contents.loadFile("/tmp/index.html")).rejects.toThrow("Application views may only load the Sliver renderer");
    expect(loadURL).not.toHaveBeenCalled();
    expect(loadFile).not.toHaveBeenCalled();

    const url = `${APP_URL}?surface=network#settings`;
    const options = { extraHeaders: "X-Test: preserved" };
    await expect(contents.loadURL(url, options)).resolves.toBeUndefined();
    expect(loadURL).toHaveBeenCalledWith(url, options);
  });


  it("leaves assets, main-process network requests and downloads to their existing policies", () => {
    const application = new EventEmitter();
    installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
    const fixture = sessionFixture();
    application.emit("session-created", fixture.session);
    for (const resourceType of ["script", "stylesheet", "image", "font", "xhr", "other", "webSocket"]) {
      for (const url of ["sliver://app/assets/app.js", "https://example.test/download", "file:///tmp/app.js"]) {
        expect(fixture.request(url, resourceType)).toEqual({ cancel: false });
      }
    }
  });

  it("allows only the bundled DevTools frontend on Electron's remote contents", () => {
    const application = new EventEmitter();
    installApplicationNavigationSecurity(application as App, "/app/preload/navigation.cjs");
    const fixture = sessionFixture();
    for (const type of ["remote", "window", "browserView"]) {
      const contents = contentsFixture(fixture.session, type);
      application.emit("web-contents-created", {}, contents);
      for (const url of [
        "devtools://devtools/bundled/inspector.html",
        "devtools://devtools/remote/inspector.html",
        "devtools://devtools/other.html",
        "devtools://other/bundled/inspector.html",
        "devtools://devtools:123/bundled/inspector.html",
        "devtools://user@devtools/bundled/inspector.html",
        "https://example.test/",
      ]) {
        const allowed = type === "remote" && url === "devtools://devtools/bundled/inspector.html";
        const event = { url, preventDefault: vi.fn() };
        contents.emit("will-navigate", event);
        expect(event.preventDefault).toHaveBeenCalledTimes(allowed ? 0 : 1);
        expect(fixture.request(url, "mainFrame", contents as unknown as WebContents))
          .toEqual({ cancel: !allowed });
      }
    }
  });
});
