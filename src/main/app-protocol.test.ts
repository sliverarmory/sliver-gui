// @vitest-environment node

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_RENDERER_URL,
  APP_SCHEME,
  APP_SCHEME_PRIVILEGES,
  createAppProtocolHandler,
} from "./app-protocol.js";
import { productionContentSecurityPolicy } from "./security.js";

let directory: string;
let rendererDirectory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "sliver-gui-app-protocol-"));
  rendererDirectory = join(directory, "renderer");
  await mkdir(join(rendererDirectory, "assets"), { recursive: true });
  await writeFile(join(rendererDirectory, "index.html"), "<!doctype html><title>Sliver</title>");
  await writeFile(join(directory, "outside.txt"), "outside the renderer directory");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function createHandler() {
  const fetchFile = vi.fn(async (url: string) => new Response(
    new Uint8Array(await readFile(new URL(url))),
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Security-Policy": "default-src *",
      },
    },
  ));
  return {
    fetchFile,
    handle: createAppProtocolHandler(rendererDirectory, fetchFile),
  };
}

describe("application asset protocol", () => {
  it("defines a standard secure scheme with fetch support and no security bypasses", () => {
    expect(APP_SCHEME).toBe("sliver");
    expect(APP_RENDERER_URL).toBe("sliver://app/index.html");
    expect(APP_SCHEME_PRIVILEGES).toEqual({
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    });
  });

  it("serves the entry document with authoritative security headers", async () => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(APP_RENDERER_URL));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<!doctype html><title>Sliver</title>");
    expect(response.headers.get("content-type")).toMatch(/^text\/html(?:;|$)/u);
    expect(response.headers.get("content-security-policy")).toBe(productionContentSecurityPolicy());
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fetchFile).toHaveBeenCalledOnce();
    expect(fileURLToPath(fetchFile.mock.calls[0]![0])).toBe(
      await realpath(join(rendererDirectory, "index.html")),
    );
  });

  it.each([
    ["application.js", "export const ready = true;", /^(?:application|text)\/javascript(?:;|$)/u],
    ["application.css", "body { color: white; }", /^text\/css(?:;|$)/u],
    ["terminal.wasm", "wasm fixture", /^application\/wasm(?:;|$)/u],
    ["terminal.woff2", "font fixture", /^font\/woff2(?:;|$)/u],
    ["icon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\" />", /^image\/svg\+xml(?:;|$)/u],
  ])("serves %s with a usable MIME type", async (name, body, mimeType) => {
    await writeFile(join(rendererDirectory, "assets", name), body);
    const { handle } = createHandler();

    const response = await handle(new Request(`sliver://app/assets/${name}`));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(mimeType);
    expect(await response.text()).toBe(body);
  });

  it("resolves encoded asset names while ignoring query parameters and document fragments", async () => {
    await writeFile(join(rendererDirectory, "assets", "font name.css"), "/* font */");
    const { handle } = createHandler();

    const response = await handle(new Request("sliver://app/assets/font%20name.css?v=1#font"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/* font */");
  });

  it("returns HEAD metadata without an asset body", async () => {
    const { handle } = createHandler();

    const response = await handle(new Request(APP_RENDERER_URL, { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html(?:;|$)/u);
    expect(response.headers.get("content-security-policy")).toBe(productionContentSecurityPolicy());
    expect(await response.text()).toBe("");
  });

  it.each(["POST", "PUT", "DELETE", "OPTIONS"])("rejects the %s method before opening a file", async (method) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(APP_RENDERER_URL, { method }));

    expect(response.status).toBe(405);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each([
    "sliver://other/index.html",
    "sliver://app.example/index.html",
    "sliver://app:1234/index.html",
  ])("rejects an untrusted authority in %s", async (url) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(url));

    expect(response.status).toBe(403);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each(["file:///index.html", "https://app/index.html"])("rejects a different scheme in %s", async (url) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(url));

    expect([400, 403]).toContain(response.status);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each([
    "sliver://app/%",
    "sliver://app/%00index.html",
    "sliver://app/C:/outside.txt",
    "sliver://app/C%3A/outside.txt",
    "sliver://app/index.html:alternate-stream",
  ])("rejects an invalid decoded path in %s", async (url) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(url));

    expect(response.status).toBe(400);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each([
    "sliver://app/assets/%2e%2e%2f%2e%2e%2foutside.txt",
    "sliver://app/%2e%2e%5coutside.txt",
  ])("keeps decoded paths inside the renderer directory for %s", async (url) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(url));

    expect([400, 403]).toContain(response.status);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.each(["missing.html", "assets"])("returns 404 for the non-file asset %s", async (path) => {
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request(`sliver://app/${path}`));

    expect(response.status).toBe(404);
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("rejects file and directory links that resolve outside the renderer directory", async () => {
    await symlink(join(directory, "outside.txt"), join(rendererDirectory, "outside.txt"));
    await symlink(directory, join(rendererDirectory, "linked-directory"));
    const { handle, fetchFile } = createHandler();

    for (const path of ["outside.txt", "linked-directory/outside.txt"]) {
      const response = await handle(new Request(`sliver://app/${path}`));
      expect(response.status).toBe(403);
    }
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("rejects links into a sibling directory sharing the renderer prefix", async () => {
    const siblingDirectory = `${rendererDirectory}-private`;
    await mkdir(siblingDirectory);
    await writeFile(join(siblingDirectory, "private.txt"), "private fixture");
    await symlink(siblingDirectory, join(rendererDirectory, "sibling"));
    const { handle, fetchFile } = createHandler();

    const response = await handle(new Request("sliver://app/sibling/private.txt"));

    expect(response.status).toBe(403);
    expect(fetchFile).not.toHaveBeenCalled();
  });
});
