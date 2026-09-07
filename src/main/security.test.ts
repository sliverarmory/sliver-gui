// @vitest-environment node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { BrowserWindow, Session, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  configureSessionSecurity,
  developmentContentSecurityPolicy,
  hardenWindow,
  isTrustedRendererUrl,
  productionContentSecurityPolicy,
  secureWebPreferences,
} from "./security.js";

function parsePolicy(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      if (!name) throw new Error(`Invalid CSP directive: ${part}`);
      return [name, values];
    }),
  );
}

function expectStrictJavaScriptPolicy(policy: string): void {
  const directives = parsePolicy(policy);
  const scriptValues = [
    ...(directives.get("script-src") ?? []),
    ...(directives.get("script-src-elem") ?? []),
    ...(directives.get("script-src-attr") ?? []),
  ];

  expect(directives.get("script-src-attr")).toEqual(["'none'"]);
  expect(scriptValues).not.toContain("'unsafe-inline'");
  expect(scriptValues).not.toContain("'unsafe-eval'");
  expect(directives.get("script-src")).toContain("'wasm-unsafe-eval'");
  expect(directives.get("script-src-elem")).not.toContain("'wasm-unsafe-eval'");
  expect(scriptValues.every((value) => !value.startsWith("data:"))).toBe(true);
  expect(directives.get("worker-src")).toEqual(["'none'"]);
}

describe("Electron content security policy", () => {
  it("locks production JavaScript to packaged self resources", () => {
    const policy = productionContentSecurityPolicy();
    const directives = parsePolicy(policy);

    expectStrictJavaScriptPolicy(policy);
    expect(directives.get("default-src")).toEqual(["'self'"]);
    expect(directives.get("script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(directives.get("script-src-elem")).toEqual(["'self'"]);
    expect(directives.get("connect-src")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("allows only the exact development server origins without unsafe JavaScript", () => {
    const policy = developmentContentSecurityPolicy("http://127.0.0.1:5173/app");
    const directives = parsePolicy(policy);

    expectStrictJavaScriptPolicy(policy);
    expect(directives.get("script-src")).toEqual([
      "'self'",
      "'wasm-unsafe-eval'",
      "http://127.0.0.1:5173",
    ]);
    expect(directives.get("script-src-elem")).toEqual([
      "'self'",
      "http://127.0.0.1:5173",
    ]);
    expect(directives.get("connect-src")).toEqual([
      "'self'",
      "http://127.0.0.1:5173",
      "ws://127.0.0.1:5173",
    ]);
  });

  it("installs the strict policy as a response header and denies permissions", () => {
    type HeadersCallback = (
      details: { responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
    ) => void;

    let headersCallback: HeadersCallback | undefined;
    type PermissionCheck = (
      contents: WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl?: string; isMainFrame: boolean },
    ) => boolean;
    type PermissionRequest = (
      contents: WebContents,
      permission: string,
      callback: (allowed: boolean) => void,
      details: { requestingUrl: string; isMainFrame: boolean },
    ) => void;
    let permissionCheck: PermissionCheck | undefined;
    let permissionRequest: PermissionRequest | undefined;
    let devicePermission: (() => boolean) | undefined;
    const electronSession = {
      webRequest: {
        onHeadersReceived: vi.fn((callback: HeadersCallback) => {
          headersCallback = callback;
        }),
      },
      setPermissionCheckHandler: vi.fn((callback: PermissionCheck) => {
        permissionCheck = callback;
      }),
      setPermissionRequestHandler: vi.fn(
        (callback: PermissionRequest) => {
          permissionRequest = callback;
        },
      ),
      setDevicePermissionHandler: vi.fn((callback: () => boolean) => {
        devicePermission = callback;
      }),
    };

    configureSessionSecurity(electronSession as unknown as Session);

    let responseHeaders: Record<string, string[]> | undefined;
    expect(headersCallback).toBeTypeOf("function");
    headersCallback?.(
      { responseHeaders: { "X-Test": ["preserved"] } },
      (response) => {
        responseHeaders = response.responseHeaders;
      },
    );

    expect(responseHeaders?.["X-Test"]).toEqual(["preserved"]);
    expect(responseHeaders?.["Content-Security-Policy"]).toEqual([productionContentSecurityPolicy()]);
    expect(permissionCheck?.(null, "clipboard-read", "file://", {
      requestingUrl: "file:///tmp/untrusted.html",
      isMainFrame: true,
    })).toBe(false);
    expect(devicePermission?.()).toBe(false);

    const permissionResult = vi.fn();
    permissionRequest?.({} as WebContents, "camera", permissionResult, {
      requestingUrl: "file:///tmp/untrusted.html",
      isMainFrame: true,
    });
    expect(permissionResult).toHaveBeenCalledWith(false);
  });

  it("allows only explicit clipboard permissions from the exact trusted main frame", () => {
    type PermissionCheck = (
      contents: WebContents | null,
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl?: string; isMainFrame: boolean },
    ) => boolean;
    type PermissionRequest = (
      contents: WebContents,
      permission: string,
      callback: (allowed: boolean) => void,
      details: { requestingUrl: string; isMainFrame: boolean },
    ) => void;
    let permissionCheck: PermissionCheck | undefined;
    let permissionRequest: PermissionRequest | undefined;
    const electronSession = {
      webRequest: { onHeadersReceived: vi.fn() },
      setPermissionCheckHandler: vi.fn((callback: PermissionCheck) => {
        permissionCheck = callback;
      }),
      setPermissionRequestHandler: vi.fn((callback: PermissionRequest) => {
        permissionRequest = callback;
      }),
      setDevicePermissionHandler: vi.fn(),
    };
    const trustedRendererUrl = pathToFileURL(resolve("dist/renderer/index.html")).href;
    const trustedContents = {
      isDestroyed: () => false,
      getURL: () => `${trustedRendererUrl}?window=1`,
    } as unknown as WebContents;
    configureSessionSecurity(
      electronSession as unknown as Session,
      undefined,
      trustedRendererUrl,
    );

    for (const permission of ["clipboard-read", "clipboard-sanitized-write"]) {
      expect(permissionCheck?.(trustedContents, permission, "file://", {
        requestingUrl: `${trustedRendererUrl}#terminal`,
        isMainFrame: true,
      })).toBe(true);
      const allowed = vi.fn();
      permissionRequest?.(trustedContents, permission, allowed, {
        requestingUrl: `${trustedRendererUrl}#terminal`,
        isMainFrame: true,
      });
      expect(allowed).toHaveBeenCalledWith(true);
    }

    expect(permissionCheck?.(trustedContents, "notifications", "file://", {
      requestingUrl: trustedRendererUrl,
      isMainFrame: true,
    })).toBe(false);
    expect(permissionCheck?.(trustedContents, "clipboard-read", "file://", {
      requestingUrl: trustedRendererUrl,
      isMainFrame: false,
    })).toBe(false);
    expect(permissionCheck?.(trustedContents, "clipboard-read", "file://", {
      requestingUrl: pathToFileURL(resolve("dist/renderer/other.html")).href,
      isMainFrame: true,
    })).toBe(false);
  });
});

describe("Electron BrowserWindow hardening", () => {
  it("trusts only the packaged renderer entry or the configured development origin", () => {
    const rendererUrl = pathToFileURL(resolve("dist/renderer/index.html")).href;
    const siblingUrl = pathToFileURL(resolve("dist/renderer/other.html")).href;

    expect(isTrustedRendererUrl(`${rendererUrl}?window=2#builds`, rendererUrl)).toBe(true);
    expect(isTrustedRendererUrl(siblingUrl, rendererUrl)).toBe(false);
    expect(isTrustedRendererUrl("file:///tmp/index.html", rendererUrl)).toBe(false);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/builds", "http://127.0.0.1:5173")).toBe(true);
    expect(isTrustedRendererUrl("http://127.0.0.1:5173.evil.test/", "http://127.0.0.1:5173")).toBe(false);
  });

  it("returns explicit secure web preferences", () => {
    const preferences = secureWebPreferences("/absolute/preload.js");

    expect(preferences).toMatchObject({
      preload: "/absolute/preload.js",
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });

  });

  it("denies new windows, webviews, external navigation, and origin-prefix attacks", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const setWindowOpenHandler = vi.fn();
    const window = {
      webContents: {
        setWindowOpenHandler,
        on: vi.fn((name: string, callback: (...args: unknown[]) => void) => handlers.set(name, callback)),
      },
    };

    hardenWindow(window as unknown as BrowserWindow, "http://127.0.0.1:5173");

    const openHandler = setWindowOpenHandler.mock.calls[0]?.[0] as (() => { action: string }) | undefined;
    expect(openHandler?.()).toEqual({ action: "deny" });

    const navigate = handlers.get("will-navigate");
    const allowedEvent = { preventDefault: vi.fn() };
    navigate?.(allowedEvent, "http://127.0.0.1:5173/generate");
    expect(allowedEvent.preventDefault).not.toHaveBeenCalled();

    const externalEvent = { preventDefault: vi.fn() };
    navigate?.(externalEvent, "https://example.test/");
    expect(externalEvent.preventDefault).toHaveBeenCalledOnce();

    const prefixAttackEvent = { preventDefault: vi.fn() };
    navigate?.(prefixAttackEvent, "http://127.0.0.1:5173.evil.test/");
    expect(prefixAttackEvent.preventDefault).toHaveBeenCalledOnce();

    const redirect = handlers.get("will-redirect");
    const redirectEvent = { preventDefault: vi.fn() };
    redirect?.(redirectEvent, "https://example.test/");
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();

    const attachWebview = handlers.get("will-attach-webview");
    const webviewEvent = { preventDefault: vi.fn() };
    attachWebview?.(webviewEvent);
    expect(webviewEvent.preventDefault).toHaveBeenCalledOnce();
  });

  it("can pin a utility window to one exact renderer surface", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const window = {
      webContents: {
        setWindowOpenHandler: vi.fn(),
        on: vi.fn((name: string, callback: (...args: unknown[]) => void) => handlers.set(name, callback)),
      },
    };
    const rendererUrl = "http://127.0.0.1:5173";
    const cloudUrl = `${rendererUrl}/?surface=cloud-deployment`;
    hardenWindow(window as unknown as BrowserWindow, rendererUrl, cloudUrl);
    const navigate = handlers.get("will-navigate");

    const exactSurface = { preventDefault: vi.fn() };
    navigate?.(exactSurface, `${cloudUrl}#placeholder`);
    expect(exactSurface.preventDefault).not.toHaveBeenCalled();

    const workspace = { preventDefault: vi.fn() };
    navigate?.(workspace, `${rendererUrl}/`);
    expect(workspace.preventDefault).toHaveBeenCalledOnce();

    const differentSurface = { preventDefault: vi.fn() };
    navigate?.(differentSurface, `${rendererUrl}/?surface=interaction`);
    expect(differentSurface.preventDefault).toHaveBeenCalledOnce();
  });
});
