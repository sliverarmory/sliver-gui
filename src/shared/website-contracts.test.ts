import { describe, expect, it } from "vitest";
import {
  WEBSITE_LIMITS, parseImportWebsiteFilesInput, parseListWebsitesInput,
  parseSaveWebsiteTextInput, parseWebsiteContentInput, parseWebsiteNameInput, parseUpdateWebsiteContentTypeInput,
} from "./website-contracts.js";

describe("website IPC contracts", () => {
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
