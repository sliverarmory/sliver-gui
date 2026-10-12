// @vitest-environment node
import { EventEmitter } from "node:events";
import { request } from "node:http";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(async (_url: string) => {}) }));
vi.mock("electron", () => ({ shell: { openExternal: mocks.openExternal } }));
import { WebsitePreviewInvalidatedError, WebsitePreviewServer, type WebsitePreviewContent } from "./website-preview-server.js";
import type { WebsiteRenderedPreview } from "../shared/website-contracts.js";

let controller: WebsitePreviewServer;
beforeEach(() => { mocks.openExternal.mockReset(); controller = new WebsitePreviewServer(); });
afterEach(() => controller.dispose());
function owner(id = 1): BrowserWindow {
  return Object.assign(new EventEmitter(), { isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), { id, isDestroyed: () => false }),
  }) as unknown as BrowserWindow;
}
const input = { name: "landing", path: "/pages/index.html" };
function content(text: string, contentType = "text/html"): WebsitePreviewContent {
  return { bytes: new TextEncoder().encode(text), contentType };
}
function openedUrl(): string { return mocks.openExternal.mock.calls.at(-1)![0]; }
function get(url: string, options: { method?: string; path?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; bytes: Buffer }>((resolve, reject) => {
    const req = request(url, { method: options.method ?? "GET", headers: options.headers, ...(options.path ? { path: options.path } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("local website browser preview", () => {
  it("publishes owner-scoped lifecycle status and stops only the requested owner's server", async () => {
    const updates: Array<{ ownerId: number; preview: WebsiteRenderedPreview | null }> = [];
    controller.setChangeListener((ownerId) => updates.push({ ownerId, preview: controller.getOwnerPreview(ownerId) }));
    expect(controller.getOwnerPreview(1)).toBeNull();
    await controller.open(owner(1), input, async () => content("first"), () => {}, "website-id");
    const firstUrl = openedUrl();
    expect(controller.getOwnerPreview(1)).toEqual({ ...input, origin: new URL(firstUrl).origin, url: firstUrl });
    const copy = controller.getOwnerPreview(1)!;
    copy.name = "tampered";
    expect(controller.getOwnerPreview(1)?.name).toBe(input.name);
    await controller.open(owner(2), { ...input, name: "other" }, async () => content("second"), () => {}, "other-id");
    const secondUrl = openedUrl();
    controller.closeOwner(1);
    expect(controller.getOwnerPreview(1)).toBeNull();
    await expect(get(firstUrl)).rejects.toThrow();
    expect((await get(secondUrl)).bytes.toString()).toBe("second");
    expect(updates.map(({ ownerId, preview }) => [ownerId, preview?.name ?? null])).toEqual([
      [1, "landing"], [2, "other"], [1, null],
    ]);
    controller.closeOwner(1);
    expect(updates).toHaveLength(3);
    controller.dispose();
    expect(updates.at(-1)).toEqual({ ownerId: 2, preview: null });
  });

  it("reuses the active website origin but revokes it when the website identity changes", async () => {
    const sameOwner = owner();
    await controller.open(sameOwner, input, async () => content("first"), () => {}, "website-id");
    const firstUrl = openedUrl();
    const nextInput = { ...input, path: "/another file.html" };
    await controller.open(sameOwner, nextInput, async () => content("fresh"), () => {}, "website-id");
    const reopened = openedUrl();
    expect(new URL(reopened).origin).toBe(new URL(firstUrl).origin);
    expect(controller.getOwnerPreview(1)).toEqual({ ...nextInput, origin: new URL(firstUrl).origin, url: reopened });
    expect((await get(firstUrl)).bytes.toString()).toBe("fresh");
    await controller.open(sameOwner, input, async () => content("replacement"), () => {}, "replacement-id");
    expect(new URL(openedUrl()).origin).not.toBe(new URL(firstUrl).origin);
    await expect(get(firstUrl)).rejects.toThrow();
    expect((await get(openedUrl())).bytes.toString()).toBe("replacement");
  });

  it("clears running status when opening fails or the owner is destroyed", async () => {
    const updated = vi.fn();
    controller.setChangeListener(updated);
    mocks.openExternal.mockRejectedValueOnce(new Error("No browser"));
    await expect(controller.open(owner(), input, async () => content("ok"), () => {}, "website-id"))
      .rejects.toThrow("No browser");
    expect(controller.getOwnerPreview(1)).toBeNull();
    expect(updated).toHaveBeenCalledTimes(2);
    const activeOwner = owner();
    await controller.open(activeOwner, input, async () => content("ok"), () => {}, "website-id");
    activeOwner.webContents.emit("destroyed");
    expect(controller.getOwnerPreview(1)).toBeNull();
    expect(updated).toHaveBeenCalledTimes(4);
  });

  it("revokes changed website identities without letting a late request stop a replacement preview", async () => {
    const activeOwner = owner();
    await controller.open(activeOwner, input, async () => {
      throw new WebsitePreviewInvalidatedError("Website replaced");
    }, () => {}, "website-id");
    await expect(get(openedUrl())).rejects.toThrow();
    expect(controller.getOwnerPreview(1)).toBeNull();

    let rejectContent!: (reason: Error) => void;
    const fetchContent = vi.fn(() => new Promise<WebsitePreviewContent>((_resolve, reject) => { rejectContent = reject; }));
    await controller.open(activeOwner, input, fetchContent, () => {}, "website-id");
    const pending = expect(get(openedUrl())).rejects.toThrow();
    await vi.waitFor(() => expect(fetchContent).toHaveBeenCalledOnce());
    await controller.open(activeOwner, { ...input, name: "replacement" }, async () => content("replacement"), () => {}, "replacement-id");
    const replacementUrl = openedUrl();
    rejectContent(new WebsitePreviewInvalidatedError("Old website replaced"));
    await pending;
    expect(controller.getOwnerPreview(1)?.name).toBe("replacement");
    expect((await get(replacementUrl)).bytes.toString()).toBe("replacement");
  });

  it("opens a loopback URL and serves fresh exact bytes and MIME types for documents and site resources", async () => {
    let source = '<h1>First</h1><script src="/app.js"></script><link rel="stylesheet" href="../style.css">';
    const delivered: Uint8Array[] = [];
    const fetchContent = vi.fn(async (path: string) => {
      const value = path === input.path ? content(source) : path === "/app.js" ? content("window.active = true;", "text/javascript")
        : path === "/style.css" ? content("body {color: red}", "text/css") : path === "/image.png" ? { bytes: Uint8Array.of(1, 2, 3), contentType: "image/png" } : undefined;
      if (value) delivered.push(value.bytes);
      return value;
    });
    await controller.open(owner(), input, fetchContent, () => {}, "website-id");
    const url = openedUrl();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/pages\/index\.html$/u);
    const first = await get(url);
    expect(first.status).toBe(200);
    expect(first.bytes.toString()).toBe(source);
    expect(first.headers["content-type"]).toBe("text/html");
    expect(first.headers["cache-control"]).toContain("no-store");
    expect(first.headers["pragma"]).toBe("no-cache");
    expect(first.headers["etag"]).toBeUndefined();
    expect(first.headers["last-modified"]).toBeUndefined();
    expect(first.headers["content-security-policy"]).toContain("worker-src 'none'");
    expect(first.headers["content-security-policy"]).toContain("script-src 'self' 'unsafe-inline'");
    expect(first.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(first.headers["x-content-type-options"]).toBe("nosniff");
    expect((await get(new URL("/app.js", url).href)).bytes.toString()).toBe("window.active = true;");
    expect((await get(new URL("/style.css", url).href)).headers["content-type"]).toBe("text/css");
    expect((await get(new URL("/image.png", url).href)).bytes).toEqual(Buffer.from([1, 2, 3]));
    expect((await get(new URL("/missing", url).href)).status).toBe(404);
    source = "<h1>Edited</h1>";
    const updated = await get(url, { headers: { "If-None-Match": "old", "If-Modified-Since": new Date().toUTCString(), Range: "bytes=0-2" } });
    expect(updated.status).toBe(200);
    expect(updated.bytes.toString()).toBe(source);
    const head = await get(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.bytes.length).toBe(0);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(source)));
    expect(fetchContent).toHaveBeenCalledTimes(7);
    expect(delivered.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  it("encodes literal percent signs, Unicode and spaces and ignores cache-busting queries", async () => {
    const fetchContent = vi.fn(async () => content("ok"));
    await controller.open(owner(), { name: "landing", path: "/file 100%/日本.txt" }, fetchContent, () => {}, "website-id");
    const url = openedUrl();
    expect(url).toContain("/file%20100%25/%E6%97%A5%E6%9C%AC.txt");
    expect((await get(`${url}?version=2`)).status).toBe(200);
    expect(fetchContent).toHaveBeenCalledWith("/file 100%/日本.txt");
  });

  it("serves valid Unicode paths through their full percent-encoded HTTP request target", async () => {
    const path = `/${"日".repeat(2042)}.html`;
    expect(path.length).toBe(2048);
    const fetchContent = vi.fn(async () => content("long Unicode path"));
    await controller.open(owner(), { name: "landing", path }, fetchContent, () => {}, "website-id");
    const url = openedUrl();
    expect(new URL(url).pathname.length).toBeGreaterThan(18 * 1024 - 100);
    const response = await get(`${url}?version=2`);
    expect(response.status).toBe(200);
    expect(response.bytes.toString()).toBe("long Unicode path");
    expect(fetchContent).toHaveBeenCalledExactlyOnceWith(path);
  });

  it("rejects cross-origin, mutation, worker, malformed paths and hostile hosts before fetching", async () => {
    const fetchContent = vi.fn(async () => content("private"));
    await controller.open(owner(), input, fetchContent, () => {}, "website-id");
    const url = openedUrl();
    for (const headers of [
      { Host: "evil.test" }, { Origin: "https://evil.test" }, { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" },
      { "Service-Worker": "script" }, { "Sec-Fetch-Dest": "serviceworker" }, { "Sec-Fetch-Dest": "worker" },
    ]) expect((await get(url, { headers })).status).toBe(403);
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
      const response = await get(url, { method });
      expect(response.status).toBe(405);
      expect(response.headers["allow"]).toBe("GET, HEAD");
    }
    for (const path of ["//evil.test/file", "/../private", "/%2e%2e/private", "/file%2Fprivate", "/file%5Cprivate", "/%00private", "/%broken", "http://evil.test/file", "/file#fragment"]) {
      expect((await get(url, { path })).status, path).toBe(400);
    }
    expect(fetchContent).not.toHaveBeenCalled();
    expect((await get(url, { headers: { Origin: new URL(url).origin, "Sec-Fetch-Site": "same-origin" } })).status).toBe(200);
  });

  it("clears bytes and rejects invalid backend headers or backend failures without exposing details", async () => {
    const bad = content("private", "text/html\r\nSet-Cookie: secret");
    const fetchContent = vi.fn(async () => bad);
    await controller.open(owner(), input, fetchContent, () => {}, "website-id");
    const response = await get(openedUrl());
    expect(response.status).toBe(502);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(bad.bytes.every((byte) => byte === 0)).toBe(true);
    fetchContent.mockRejectedValueOnce(new Error("private backend credentials"));
    expect((await get(openedUrl())).bytes.toString()).not.toContain("credentials");
  });

  it("closes replaced previews and cleans up on owner destruction, disconnect, disposal and open failure", async () => {
    const firstOwner = owner();
    await controller.open(firstOwner, input, async () => content("ok"), () => {}, "website-id");
    const old = openedUrl();
    await controller.open(firstOwner, { ...input, name: "replacement" }, async () => content("new"), () => {}, "website-id");
    await expect(get(old)).rejects.toThrow();
    const current = openedUrl();
    firstOwner.webContents.emit("destroyed");
    await expect(get(current)).rejects.toThrow();
    await controller.open(owner(), input, async () => content("ok"), () => {}, "website-id");
    const detached = openedUrl();
    controller.closeOwner(1);
    await expect(get(detached)).rejects.toThrow();
    mocks.openExternal.mockRejectedValueOnce(new Error("No browser"));
    await expect(controller.open(owner(), input, async () => content("ok"), () => {}, "website-id")).rejects.toThrow("No browser");
    await expect(get(openedUrl())).rejects.toThrow();
    await controller.open(owner(), input, async () => content("ok"), () => {}, "website-id");
    controller.dispose();
    await expect(get(openedUrl())).rejects.toThrow();
    await expect(controller.open(owner(), input, async () => content("ok"), () => {}, "website-id")).rejects.toThrow("unavailable");
  });

  it("settles pending opens when owners disappear or a concurrent open replaces them", async () => {
    const vanished = owner();
    const opening = controller.open(vanished, input, async () => content("ok"), () => {}, "website-id");
    vanished.webContents.emit("destroyed");
    await expect(opening).rejects.toThrow("closed");
    expect(mocks.openExternal).not.toHaveBeenCalled();
    const replacementOwner = owner();
    const first = controller.open(replacementOwner, input, async () => content("first"), () => {}, "website-id");
    const firstResult = expect(first).rejects.toThrow("closed");
    const second = controller.open(replacementOwner, input, async () => content("second"), () => {}, "website-id");
    await firstResult;
    await second;
    expect((await get(openedUrl())).bytes.toString()).toBe("second");
  });

  it("limits preview count and revalidates connection binding after fetching", async () => {
    for (const id of [1, 2, 3, 4]) await controller.open(owner(id), input, async () => content("ok"), () => {}, "website-id");
    await expect(controller.open(owner(5), input, async () => content("ok"), () => {}, "website-id")).rejects.toThrow("existing website preview");
    let current = true;
    const bytes = content("stale");
    await controller.open(owner(1), input, async () => { current = false; return bytes; }, () => {
      if (!current) throw new Error("Connection changed");
    }, "website-id");
    await expect(get(openedUrl())).rejects.toThrow();
    expect(bytes.bytes.every((byte) => byte === 0)).toBe(true);
    await expect(get(openedUrl())).rejects.toThrow();
  });

  it("queues ordinary browser resource bursts while bounding live backend requests", async () => {
    const pending: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    const fetchContent = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
      return content("resource");
    });
    await controller.open(owner(), input, fetchContent, () => {}, "website-id");
    const requests = Array.from({ length: 12 }, () => get(openedUrl()));
    for (const expected of [4, 8, 12]) {
      await vi.waitFor(() => expect(fetchContent).toHaveBeenCalledTimes(expected));
      for (const release of pending.splice(0)) release();
    }
    expect((await Promise.all(requests)).every((response) => response.status === 200)).toBe(true);
    expect(peak).toBe(4);
  });

  it("clears in-flight bytes when a preview is revoked during its backend request", async () => {
    let resolveContent: ((value: WebsitePreviewContent) => void) | undefined;
    const fetchContent = vi.fn(() => new Promise<WebsitePreviewContent>((resolve) => { resolveContent = resolve; }));
    await controller.open(owner(), input, fetchContent, () => {}, "website-id");
    const pending = get(openedUrl());
    const result = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetchContent).toHaveBeenCalledOnce());
    controller.closeOwner(1);
    const bytes = content("late");
    resolveContent!(bytes);
    await result;
    await vi.waitFor(() => expect(bytes.bytes.every((byte) => byte === 0)).toBe(true));
  });
});
