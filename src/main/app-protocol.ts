import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { productionContentSecurityPolicy } from "./security.js";

export const APP_SCHEME = "sliver";
export const APP_RENDERER_URL = "sliver://app/index.html";
export const APP_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Only built renderer assets are public; main, preload, and user files are not. */
export function createAppProtocolHandler(
  rendererDirectory: string,
  fetchFile: (url: string) => Promise<Response>,
): (request: Request) => Promise<Response> {
  const root = resolve(rendererDirectory);

  return async (request) => {
    const headers = new Headers({
      "Content-Security-Policy": productionContentSecurityPolicy(),
      "X-Content-Type-Options": "nosniff",
    });
    const reject = (status: number): Response => new Response(null, { status, headers });
    if (request.method !== "GET" && request.method !== "HEAD") {
      headers.set("Allow", "GET, HEAD");
      return reject(405);
    }

    let pathname: string;
    try {
      const url = new URL(request.url);
      if (
        url.protocol !== `${APP_SCHEME}:` || url.host !== "app" ||
        url.username !== "" || url.password !== ""
      ) return reject(403);
      // Decode once, rejecting alternate separators and Windows drive/ADS paths.
      if (/%2f|%5c/iu.test(url.pathname)) return reject(400);
      pathname = decodeURIComponent(url.pathname);
      if (!pathname.startsWith("/") || /[\\\0:]/u.test(pathname)) return reject(400);
    } catch {
      return reject(400);
    }

    const filePath = resolve(root, `.${pathname}`);
    if (!isWithin(root, filePath)) return reject(403);
    try {
      // realpath also works inside Electron ASAR archives. Check again after
      // resolution so a link in an unpacked renderer cannot expose other files.
      const [realRoot, realFile] = await Promise.all([realpath(root), realpath(filePath)]);
      if (!isWithin(realRoot, realFile)) return reject(403);
      if (!(await stat(realFile)).isFile()) return reject(404);

      const response = await fetchFile(pathToFileURL(realFile).href);
      if (!response.ok) {
        await response.body?.cancel();
        return reject(404);
      }
      headers.set("Content-Type", CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream");
      if (request.method === "HEAD") {
        await response.body?.cancel();
        return new Response(null, { status: 200, headers });
      }
      return new Response(response.body, { status: 200, headers });
    } catch {
      // Do not expose local paths or filesystem error details to the renderer.
      return reject(404);
    }
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
