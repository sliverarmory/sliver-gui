import { describe, expect, it } from "vitest";
import {
  WEBSITE_DROPPED_MAX_LOCAL_PATH_LENGTH, WEBSITE_LIMITS, isWebsiteTextContentType,
  parseDroppedWebsiteFilesIpcRequest, parseImportWebsiteFilesInput, parseListWebsitesInput,
  parseOpenWebsiteTextEditorInput, parseSaveWebsiteTextInput, parseWebsiteContentInput, parseWebsiteNameInput, parseUpdateWebsiteContentTypeInput,
} from "./website-contracts.js";

describe("website IPC contracts", () => {
  it("preserves exact website names and bounded native paths for dropped files and directories", () => {
    const request = { sourcePaths: ["/private/operator/index.html ", "C:\\operator\\assets", "D:/site/index.html", "\\\\server\\share\\site"], input: { name: " public " } };
    const parsed = parseDroppedWebsiteFilesIpcRequest(request);
    expect(parsed).toEqual(request);
    expect(parsed.sourcePaths).not.toBe(request.sourcePaths);
    expect(parseDroppedWebsiteFilesIpcRequest({ sourcePaths: Array.from({ length: WEBSITE_LIMITS.importFiles }, (_, index) => `/site/${index}`), input: { name: "public" } }).sourcePaths).toHaveLength(WEBSITE_LIMITS.importFiles);
  });

  it.each(["", "relative.html", "C:relative.html", "\\relative.html", "\\\\server", "/file\n", "/file\0", "/file\u007f", "/" + "a".repeat(WEBSITE_DROPPED_MAX_LOCAL_PATH_LENGTH), null, 42])(
    "rejects invalid native dropped source path %j", (sourcePath) => {
      expect(() => parseDroppedWebsiteFilesIpcRequest({ sourcePaths: [sourcePath], input: { name: "public" } })).toThrow();
    },
  );

  it.each([
    { sourcePaths: [] },
    { sourcePaths: "/site/index.html" },
    { sourcePaths: [undefined] },
    { sourcePaths: new Array(1) },
    { sourcePaths: Array.from({ length: WEBSITE_LIMITS.importFiles + 1 }, () => "/site/index.html") },
    { input: { name: " " } },
    { input: { name: "public", sourcePath: "/override" } },
    { input: { name: "public", overwrite: true } },
    { sourcePath: "/override" },
    { websiteId: "another-website" },
  ])("rejects malformed dropped website envelope %j", (input) => {
    expect(() => parseDroppedWebsiteFilesIpcRequest({ sourcePaths: ["/site/index.html"], input: { name: "public" }, ...input })).toThrow();
  });

  it("accepts exact editor targets and textual creation metadata", () => {
    expect(parseOpenWebsiteTextEditorInput({ name: " site ", path: "/a ", mode: "edit" }))
      .toEqual({ name: " site ", path: "/a ", mode: "edit" });
    expect(parseOpenWebsiteTextEditorInput({ name: "site", path: "/a", mode: "create", contentType: " text/html " }))
      .toEqual({ name: "site", path: "/a", mode: "create", contentType: "text/html" });
  });
  it.each([
    { mode: "edit", contentType: "text/html" },
    { mode: "edit", text: "injected" },
    { mode: "create" },
    { mode: "create", contentType: "image/png" },
    { mode: "create", contentType: "" },
    { mode: "other" },
    { mode: "edit", path: "/../a" },
    { mode: "edit", sourcePath: "/etc/passwd" },
  ])("rejects invalid editor request %j", (input) => {
    expect(() => parseOpenWebsiteTextEditorInput({ name: "site", path: "/a", ...input })).toThrow();
  });
  it.each(["text/html; charset=utf-8", "text/plain", "application/json", "application/ld+json", "image/svg+xml", "application/xhtml+xml", "application/javascript"])("recognizes textual MIME %s", (mime) => {
    expect(isWebsiteTextContentType(mime)).toBe(true);
  });
  it.each(["image/png", "application/pdf", "application/octet-stream", ""])("does not classify binary MIME %s as editable text", (mime) => {
    expect(isWebsiteTextContentType(mime)).toBe(false);
  });
  it("defaults directory imports to skipping hidden directories and accepts explicit boolean choices", () => {
    const input = { name: "landing", path: "/", contentType: "", overwrite: false, directory: true };
    expect(parseImportWebsiteFilesInput(input)).toEqual({ ...input, includeHiddenDirectories: false });
    for (const includeHiddenDirectories of [false, true]) {
      expect(parseImportWebsiteFilesInput({ ...input, includeHiddenDirectories }))
        .toEqual({ ...input, includeHiddenDirectories });
    }
  });

  it.each([undefined, null, "false", "true", 0, 1, [], {}])(
    "rejects a nonboolean hidden-directory option %j", (includeHiddenDirectories) => {
      expect(() => parseImportWebsiteFilesInput({
        name: "landing", path: "/", contentType: "", overwrite: false, directory: true, includeHiddenDirectories,
      })).toThrow(/includeHiddenDirectories must be a boolean/);
    },
  );

  it("accepts bounded named website content while preserving exact URL paths", () => {
    expect(parseWebsiteContentInput({ name: " landing ", path: "/folder/file " }))
      .toEqual({ name: " landing ", path: "/folder/file " });
    expect(parseWebsiteNameInput({ name: " landing " })).toEqual({ name: " landing " });
    expect(() => parseWebsiteNameInput({ name: "   " })).toThrow();
    expect(parseSaveWebsiteTextInput({
      name: "landing", path: "/index.html", contentType: "text/html; charset=utf-8",
      text: "<script>alert(1)</script>", overwrite: false,
    }).text).toContain("<script>");
  });

  it.each(["index.html", "//host/path", "/../secret", "/a/./b", "/a\\b", "/a?q=1", "/a#fragment", "/a\n"])(
    "rejects noncanonical or control-bearing content path %s", (path) => {
      expect(() => parseWebsiteContentInput({ name: "landing", path })).toThrow();
    },
  );

  it("rejects arbitrary local paths, extra fields, invalid MIME and oversized UTF-8 payloads", () => {
    expect(() => parseImportWebsiteFilesInput({
      name: "landing", path: "/", contentType: "", overwrite: false, directory: true, sourcePath: "/etc/passwd",
    })).toThrow();
    expect(() => parseWebsiteNameInput({ name: "landing", id: "other-site" })).toThrow();
    expect(() => parseUpdateWebsiteContentTypeInput({ name: "landing", path: "/", contentType: "text/html\r\nX: true" })).toThrow();
    expect(() => parseSaveWebsiteTextInput({
      name: "landing", path: "/", contentType: "text/html", overwrite: false,
      text: "é".repeat(WEBSITE_LIMITS.previewBytes / 2 + 1),
    })).toThrow();
    expect(() => parseListWebsitesInput({ limit: 201 })).toThrow();
    expect(() => parseListWebsitesInput({ cursor: "1e6" })).toThrow();
    expect(() => parseListWebsitesInput(Object.create({ query: "inherited" }) as unknown)).toThrow();
  });
});
