import { describe, expect, it, vi } from "vitest";

import { externalWebHref, isSafeExternalWebUrl, openExternalWebUrl } from "./external-web-url.js";

describe("external web URLs", () => {
  it.each([
    ["https://example.test/docs", "https://example.test/docs"],
    [" HTTP://LOCALHOST:8080/index.html?version=2#main ", "http://localhost:8080/index.html?version=2#main"],
    ["http://127.0.0.1:49152/assets/my%20file.html", "http://127.0.0.1:49152/assets/my%20file.html"],
    ["https://[::1]:8443/", "https://[::1]:8443/"],
    ["https://Example.test:443/a?text=%25", "https://example.test/a?text=%25"],
  ])("canonicalizes and opens %s", async (value, expected) => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    expect(externalWebHref(value)).toBe(expected);
    expect(isSafeExternalWebUrl(value)).toBe(true);
    await expect(openExternalWebUrl(value, openExternal)).resolves.toBeUndefined();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each([
    "", "javascript:alert(1)", "data:text/html,test", "file:///tmp/preview", "ftp://example.test/",
    "sliver://app/index.html", "//example.test/path", "example.test/path", "/path",
    "http:", "https://", "https:example.test", "https:/example.test", "https:///example.test",
    "https://user:password@example.test/", "https://user@example.test/", "https://:password@example.test/",
    "https://@example.test/", "https://example.test:65536/", "http://[::1/", "https://bad host/path",
    "https://example.test\\path", "http:\\example.test/path", "https://exam\tple.test/path",
    "https://exam\nple.test/path", "\nhttps://example.test/", "https://example.test/\r",
    "https://example.test/\u0000", "https://example.test/\u007f", "https://example.test/\u0085",
    "https://example.test/a b", "https://example.test/a\u00a0b", "https://example.test/%",
    "https://example.test/%2", "https://example.test/%zz",
  ])("rejects unsafe or malformed URL %j before opening", async (value) => {
    const openExternal = vi.fn(async (_url: string) => undefined);
    expect(externalWebHref(value)).toBeUndefined();
    expect(isSafeExternalWebUrl(value)).toBe(false);
    await expect(openExternalWebUrl(value, openExternal)).rejects.toThrow(TypeError);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("waits for browser opening and propagates its failure to the caller", async () => {
    let reject!: (error: Error) => void;
    const openExternal = vi.fn(() => new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    const onSettled = vi.fn();
    const opening = openExternalWebUrl("http://localhost:49152/", openExternal);
    void opening.then(onSettled, onSettled);
    await Promise.resolve();
    expect(onSettled).not.toHaveBeenCalled();
    reject(new Error("Browser failed"));
    await expect(opening).rejects.toThrow("Browser failed");
  });
});
