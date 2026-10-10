// @vitest-environment node
import { EventEmitter } from "node:events";
import type { App, BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  application: undefined as EventEmitter | undefined,
  windows: [] as Array<BrowserWindow & { options: BrowserWindowConstructorOptions; loadedUrl: string }>,
  sessions: [] as Session[],
  nextId: 100,
  sanitized: "<!doctype html><h1>Safe static content</h1>",
}));

vi.mock("./website-rendered-preview.js", () => ({
  buildWebsiteRenderedPreview: vi.fn(() => ({ html: mocks.sanitized, kind: "html" })),
  WEBSITE_RENDERED_PREVIEW_CSP: "sandbox; default-src 'none'; script-src 'none'; style-src 'unsafe-inline'",
  WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES: 16 * 1024 * 1024,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    session: {
      fromPartition: vi.fn((partition: string) => {
        const result = Object.assign(new EventEmitter(), {
          partition,
          isPersistent: () => false,
          registerPreloadScript: vi.fn(() => "navigation-preload-id"),
          unregisterPreloadScript: vi.fn(),
          webRequest: { onBeforeRequest: vi.fn() },
          protocol: { handle: vi.fn(), unhandle: vi.fn() },
          setPermissionCheckHandler: vi.fn(), setPermissionRequestHandler: vi.fn(), setDevicePermissionHandler: vi.fn(),
          clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {}),
        });
        mocks.sessions.push(result as unknown as Session);
        mocks.application!.emit("session-created", result);
        return result;
      }),
    },
    BrowserWindow: class extends EventEmitter {
      readonly webContents;
      readonly options;
      destroyed = false;
      loadedUrl = "";
      constructor(options: BrowserWindowConstructorOptions) {
        super(); this.options = options;
        this.webContents = Object.assign(new EventEmitter(), {
          id: mocks.nextId++, session: options.webPreferences!.session, getType: () => "window",
          isDestroyed: () => this.destroyed, setWindowOpenHandler: vi.fn(),
          loadURL: vi.fn(async (url: string) => { this.loadedUrl = url; }), loadFile: vi.fn(),
        });
        mocks.windows.push(this as unknown as typeof mocks.windows[number]);
        mocks.application!.emit("web-contents-created", {}, this.webContents);
      }
      setMenu = vi.fn();
      setTitle = vi.fn();
      show = vi.fn();
      isDestroyed = () => this.destroyed;
      loadURL = (url: string) => this.webContents.loadURL(url);
      destroy = () => { this.destroyed = true; this.emit("closed"); };
    },
  };
});

import { installApplicationNavigationSecurity } from "./navigation-security.js";
import { WebsitePreviewWindows } from "./website-preview-windows.js";

let controller: WebsitePreviewWindows;
beforeEach(() => {
  mocks.windows.splice(0); mocks.sessions.splice(0); mocks.nextId = 100;
  mocks.application = new EventEmitter();
  installApplicationNavigationSecurity(mocks.application as App, "/application/navigation.cjs");
  controller = new WebsitePreviewWindows();
});
afterEach(() => controller.dispose());

function owner(id = 1): BrowserWindow {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
  }) as unknown as BrowserWindow;
}
const input = { name: "landing", path: "/index.html" };
const source = new TextEncoder().encode("<script>active()</script><h1>Source</h1>");

function handler(session: Session): (request: Request) => Response {
  const handle = vi.mocked(session.protocol.handle);
  return handle.mock.calls[0]![1] as (request: Request) => Response;
}

describe("isolated rendered website preview windows", () => {
  it("loads only sanitized content through a private exact URL with no preload, JS, node, or app navigation", async () => {
    await controller.open(owner(), input, source, "text/html", () => {});
    const window = mocks.windows[0]!;
    expect(window.options.webPreferences).toMatchObject({
      sandbox: true, contextIsolation: true, webSecurity: true, javascript: false,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      plugins: false, devTools: false, webviewTag: false,
    });
    expect(window.options.webPreferences).not.toHaveProperty("preload");
    expect(window.options.title).toBe("Website preview");
    expect(window.setTitle).toHaveBeenCalledWith("Website preview");
    const nativeTitleUpdate = { preventDefault: vi.fn() };
    window.emit("page-title-updated", nativeTitleUpdate, "Attacker-controlled title");
    expect(nativeTitleUpdate.preventDefault).toHaveBeenCalledOnce();
    const isolated = mocks.sessions[0]!;
    expect(isolated.unregisterPreloadScript).toHaveBeenCalledWith("navigation-preload-id");
    expect(window.loadedUrl).toMatch(/^website-preview:\/\/[0-9a-f]{64}\/document$/u);
    const response = handler(isolated)(new Request(window.loadedUrl));
    expect(await response.text()).toBe(mocks.sanitized);
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
    expect(handler(isolated)(new Request(`${window.loadedUrl}?other=1`)).status).toBe(404);
    expect(handler(isolated)(new Request(window.loadedUrl, { method: "POST" })).status).toBe(404);
    await expect(window.webContents.loadURL("sliver://app/index.html")).rejects.toThrow();
    await expect(window.webContents.loadURL("file:///tmp/raw.html")).rejects.toThrow();
    await expect(window.webContents.loadURL("https://example.test")).rejects.toThrow();
    for (const name of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview", "page-title-updated"]) {
      const event = { url: window.loadedUrl, isMainFrame: true, preventDefault: vi.fn() };
      window.webContents.emit(name, event);
      expect(event.preventDefault).toHaveBeenCalled();
    }
    const permission = vi.mocked(isolated.setPermissionRequestHandler).mock.calls[0]![0]!;
    const callback = vi.fn();
    permission(window.webContents, "notifications", callback, {} as never);
    expect(callback).toHaveBeenCalledWith(false);
    expect(vi.mocked(isolated.setPermissionCheckHandler).mock.calls[0]![0]!(null, "notifications", "", {} as never)).toBe(false);
    const download = { preventDefault: vi.fn() };
    isolated.emit("will-download", download);
    expect(download.preventDefault).toHaveBeenCalled();
  });

  it("replaces per-owner previews, limits global count, and revokes protocol access on owner destruction", async () => {
    const firstOwner = owner();
    await controller.open(firstOwner, input, source, "text/html", () => {});
    const first = mocks.windows[0]!;
    const firstSession = mocks.sessions[0]!;
    await controller.open(firstOwner, input, source, "text/html", () => {});
    expect(first.isDestroyed()).toBe(true);
    expect(firstSession.protocol.unhandle).toHaveBeenCalledWith("website-preview");
    expect(handler(firstSession)(new Request(first.loadedUrl)).status).toBe(404);
    for (const id of [2, 3, 4]) await controller.open(owner(id), input, source, "text/html", () => {});
    await expect(controller.open(owner(5), input, source, "text/html", () => {})).rejects.toThrow(/existing website preview/);
    firstOwner.webContents.emit("destroyed");
    expect(mocks.windows[1]!.isDestroyed()).toBe(true);
    expect(mocks.sessions[1]!.clearStorageData).toHaveBeenCalled();
    expect(mocks.sessions[1]!.clearCache).toHaveBeenCalled();
  });

  it("revalidates connection binding before serving a document", async () => {
    let current = true;
    await controller.open(owner(), input, source, "text/html", () => { if (!current) throw new Error("Connection changed"); });
    current = false;
    expect(handler(mocks.sessions[0]!)(new Request(mocks.windows[0]!.loadedUrl)).status).toBe(410);
    controller.closeOwner(1);
    expect(mocks.windows[0]!.isDestroyed()).toBe(true);
  });
});
