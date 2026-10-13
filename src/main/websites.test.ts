// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientpb } from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBSITE_LIMITS } from "../shared/website-contracts.js";
import { assertWebsiteCatalogBudget, clearWebsiteContents, readDroppedWebsiteImport, readWebsiteImport, websiteContentBytes, websiteContentPreview, websiteDetail } from "./websites.js";
import * as secureFile from "./secure-file.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function temporary(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "website-import-")); directories.push(path); return path;
}
const importInput = { name: "landing", path: "/static/", contentType: "", overwrite: false, directory: true };

describe("hosted website data boundary", () => {
  it("bounds the entire encoded catalog and subtracts replaced content", () => {
    const huge = clientpb.WebContent.create({ Path: "/a", Size: String(WEBSITE_LIMITS.catalogBytes - 100), Content: Buffer.alloc(WEBSITE_LIMITS.catalogBytes - 100) });
    const site = clientpb.Website.create({ Name: "landing", ID: "site-id", Contents: { "/a": huge } });
    const added = clientpb.WebContent.create({ Path: "/b", Size: "256", Content: Buffer.alloc(256) });
    expect(() => assertWebsiteCatalogBudget([site], "landing", { "/b": added }, "site-id")).toThrow(/31 MiB catalog/);
    expect(() => assertWebsiteCatalogBudget([site], "landing", { "/a": clientpb.WebContent.create({ ...added, Path: "/a" }) }, "site-id")).not.toThrow();
    expect(() => assertWebsiteCatalogBudget([site], "new", { "/b": added })).toThrow(/31 MiB catalog/);
    expect(() => assertWebsiteCatalogBudget([site], "landing", {}, "recreated-id")).toThrow(/website changed/);
    clearWebsiteContents(site);
  });

  it("keeps HTML inert, caps binary previews, rejects missing or corrupt bytes, and scrubs response bytes", () => {
    const html = Buffer.from("<script>window.open('https://example.test')</script>");
    const item = clientpb.WebContent.create({ Path: "/", ContentType: "text/html", Size: String(html.length), Content: html });
    const preview = websiteContentPreview(item);
    expect(preview.previewState).toBe("text");
    expect(Buffer.from(preview.preview).toString()).toBe(html.toString());
    const site = clientpb.Website.create({ Name: "landing", Contents: { "/": item } });
    expect(websiteDetail(site, "landing").contents[0]).not.toHaveProperty("Content");
    clearWebsiteContents(site);
    expect(html.every((byte) => byte === 0)).toBe(true);
    expect(preview.preview.some((byte) => byte !== 0)).toBe(true);
    expect(websiteContentPreview(clientpb.WebContent.create({ Size: "4" })).previewState).toBe("unavailable");
    expect(() => websiteContentBytes(clientpb.WebContent.create({ Size: "4" }))).toThrow(/complete/);
    expect(() => websiteContentBytes(clientpb.WebContent.create({ Size: "1", Content: Buffer.from("a"), Sha256: "0".repeat(64) }))).toThrow(/digest/);
    const binary = websiteContentPreview(clientpb.WebContent.create({ Size: "8192", Content: Buffer.alloc(8192, 0xff) }));
    expect(binary).toMatchObject({ previewState: "binary", truncated: true });
    expect(binary.preview.length).toBe(WEBSITE_LIMITS.binaryPreviewBytes);
  });

  it("loads an entire directory before upload, preserving paths and applying a total size bound", async () => {
    const root = await temporary();
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "index.html"), "<h1>Site</h1>");
    await writeFile(join(root, "nested", "file "), Buffer.from([0, 1, 2]));
    const binding = vi.fn();
    const contents = await readWebsiteImport(root, importInput, binding);
    expect(Object.keys(contents)).toEqual(["/static/index.html", "/static/nested/file "]);
    expect(contents["/static/nested/file "]!.Content).toEqual(Buffer.from([0, 1, 2]));
    expect(binding).toHaveBeenCalled();
    for (const content of Object.values(contents)) content.Content.fill(0);
  });

  it.each(["native", "drop"] as const)("skips empty files throughout a %s directory import", async (mode) => {
    const root = await temporary();
    await mkdir(join(root, "assets", "nested"), { recursive: true });
    await writeFile(join(root, ".nojekyll"), "");
    await writeFile(join(root, "index.html"), "<h1>Site</h1>");
    await writeFile(join(root, "assets", "empty.css"), "");
    await writeFile(join(root, "assets", "style.css"), "body{}");
    await writeFile(join(root, "assets", "nested", "empty.js"), "");
    await writeFile(join(root, "assets", "nested", "script.js"), "window.site=true;");
    const contents = mode === "native"
      ? await readWebsiteImport(root, importInput, () => {})
      : await readDroppedWebsiteImport([root], { name: "landing" }, () => {});
    const prefix = mode === "native" ? "/static" : "";
    expect(Object.keys(contents).sort()).toEqual([
      `${prefix}/assets/nested/script.js`, `${prefix}/assets/style.css`, `${prefix}/index.html`,
    ]);
    expect(Object.values(contents).every((item) => item.Content.byteLength > 0)).toBe(true);
    expect(Buffer.from(contents[`${prefix}/index.html`]!.Content).toString()).toBe("<h1>Site</h1>");
    for (const item of Object.values(contents)) item.Content.fill(0);
  });

  it.each(["native", "drop"] as const)("rejects a %s directory with no included non-empty files", async (mode) => {
    const root = await temporary();
    await mkdir(join(root, "nested"));
    await mkdir(join(root, ".private"));
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "nested", "empty.js"), "");
    await writeFile(join(root, ".private", "not-uploaded.txt"), "hidden");
    const created = vi.spyOn(clientpb.WebContent, "create");
    try {
      const reading = mode === "native"
        ? readWebsiteImport(root, importInput, () => {})
        : readDroppedWebsiteImport([root], { name: "landing" }, () => {});
      await expect(reading).rejects.toThrow(/no non-empty files to upload/);
      expect(created).not.toHaveBeenCalled();
    } finally { created.mockRestore(); }
  });

  it.each(["native", "drop"] as const)("still rejects an explicitly selected empty %s file", async (mode) => {
    const root = await temporary();
    const file = join(root, "empty.txt");
    await writeFile(file, "");
    const reading = mode === "native"
      ? readWebsiteImport(file, { ...importInput, directory: false, path: "/empty.txt" }, () => {})
      : readDroppedWebsiteImport([file], { name: "landing" }, () => {});
    await expect(reading).rejects.toThrow(/Empty content/);
  });

  it.each(["native", "drop"] as const)("does not follow symbolic links to empty files during %s directory imports", async (mode) => {
    const root = await temporary();
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "index.html"), "<h1>Site</h1>");
    await symlink(join(root, "empty.txt"), join(root, "linked.txt"));
    const reading = mode === "native"
      ? readWebsiteImport(root, importInput, () => {})
      : readDroppedWebsiteImport([root], { name: "landing" }, () => {});
    await expect(reading).rejects.toThrow(/symbolic links/);
  });

  it("skips a directory file that becomes empty after traversal metadata was read", async () => {
    const root = await temporary();
    const emptyAfterStat = join(root, "emptied.txt");
    await writeFile(emptyAfterStat, "content before traversal");
    await writeFile(join(root, "index.html"), "<h1>Retained</h1>");
    const canonicalEmptyFile = await realpath(emptyAfterStat);
    const readFile = secureFile.readBoundedRegularFile;
    const reading = vi.spyOn(secureFile, "readBoundedRegularFile").mockImplementation(async (path, options) => {
      if (path === canonicalEmptyFile) await truncate(path, 0);
      return readFile(path, options);
    });
    try {
      const contents = await readDroppedWebsiteImport([root], { name: "landing" }, () => {});
      expect(reading).toHaveBeenCalledWith(canonicalEmptyFile, expect.anything());
      expect(Object.keys(contents)).toEqual(["/index.html"]);
      expect(Buffer.from(contents["/index.html"]!.Content).toString()).toBe("<h1>Retained</h1>");
      for (const item of Object.values(contents)) item.Content.fill(0);
    } finally { reading.mockRestore(); }
  });

  it.each([{}, { includeHiddenDirectories: false }])(
    "skips hidden child directories at every level but imports dot files with option %j", async (option) => {
      const root = await temporary();
      await mkdir(join(root, ".git"));
      await mkdir(join(root, "nested", ".cache"), { recursive: true });
      await mkdir(join(root, "assets.v1"));
      await writeFile(join(root, ".git", "config"), "private git configuration");
      // A skipped directory is never traversed or included in the import.
      await writeFile(join(root, "nested", ".cache", "empty"), "");
      await writeFile(join(root, ".nojekyll"), "keep");
      await writeFile(join(root, "nested", ".env"), "keep");
      await writeFile(join(root, "assets.v1", "style.css"), "body{}");
      const contents = await readWebsiteImport(root, { ...importInput, ...option }, () => {});
      expect(Object.keys(contents).sort()).toEqual([
        "/static/.nojekyll", "/static/assets.v1/style.css", "/static/nested/.env",
      ]);
      for (const content of Object.values(contents)) content.Content.fill(0);
    },
  );

  it("imports hidden directories recursively when explicitly enabled", async () => {
    const root = await temporary();
    await mkdir(join(root, ".git", ".nested"), { recursive: true });
    await mkdir(join(root, "assets", ".cache"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "git configuration");
    await writeFile(join(root, ".git", ".nested", "file"), "nested");
    await writeFile(join(root, "assets", ".cache", "index"), "cache");
    const contents = await readWebsiteImport(root, { ...importInput, includeHiddenDirectories: true }, () => {});
    expect(Object.keys(contents).sort()).toEqual([
      "/static/.git/.nested/file", "/static/.git/config", "/static/assets/.cache/index",
    ]);
    for (const content of Object.values(contents)) content.Content.fill(0);
  });

  it("traverses an explicitly selected hidden root while skipping its hidden descendants", async () => {
    const parent = await temporary();
    const root = join(parent, ".selected");
    await mkdir(join(root, ".cache"), { recursive: true });
    await writeFile(join(root, ".cache", "ignored"), "private cache");
    await writeFile(join(root, "index.html"), "<h1>Selected site</h1>");
    const contents = await readWebsiteImport(root, importInput, () => {});
    expect(Object.keys(contents)).toEqual(["/static/index.html"]);
    for (const content of Object.values(contents)) content.Content.fill(0);
  });

  it("still rejects a dot-prefixed symbolic link rather than traversing it", async () => {
    const root = await temporary();
    await mkdir(join(root, "actual"));
    await writeFile(join(root, "actual", "file"), "data");
    await symlink(join(root, "actual"), join(root, ".linked-directory"));
    await expect(readWebsiteImport(root, importInput, () => {})).rejects.toThrow(/symbolic links/);
  });

  it("imports mixed dropped files and directory contents at the website root with automatic MIME", async () => {
    const root = await temporary();
    const directory = join(root, "site");
    await mkdir(join(directory, "assets"), { recursive: true });
    await mkdir(join(directory, ".private"));
    await writeFile(join(directory, "index.html"), "<h1>Site</h1>");
    await writeFile(join(directory, "assets", "app.JS"), "window.site = true;");
    await writeFile(join(directory, "assets", "style.css"), "body {}");
    await writeFile(join(directory, "assets", "mark.SVG"), "<svg/>");
    await writeFile(join(directory, ".private", "secret"), "ignored");
    await writeFile(join(directory, ".well-known-file"), "included");
    const loose = join(root, "loose.bin");
    await writeFile(loose, Buffer.from([0, 255, 128, 7]));
    const onDirectory = vi.fn();
    const contents = await readDroppedWebsiteImport([loose, directory], { name: "landing" }, () => {}, onDirectory);
    expect(onDirectory).toHaveBeenCalledOnce();
    expect(Object.keys(contents).sort()).toEqual([
      "/.well-known-file", "/assets/app.JS", "/assets/mark.SVG", "/assets/style.css", "/index.html", "/loose.bin",
    ]);
    expect(contents["/index.html"]!.ContentType).toBe("text/html; charset=utf-8");
    expect(contents["/assets/app.JS"]!.ContentType).toBe("text/javascript; charset=utf-8");
    expect(contents["/assets/style.css"]!.ContentType).toBe("text/css; charset=utf-8");
    expect(contents["/assets/mark.SVG"]!.ContentType).toBe("image/svg+xml");
    expect(contents["/.well-known-file"]!.ContentType).toBe("text/plain; charset=utf-8");
    expect(contents["/loose.bin"]!.ContentType).toBe("application/octet-stream");
    expect(contents["/loose.bin"]!.Content).toEqual(Buffer.from([0, 255, 128, 7]));
    for (const item of Object.values(contents)) item.Content.fill(0);
  });

  it("sniffs extensionless HTML and media while keeping unknown binary content inert", async () => {
    const root = await temporary();
    await writeFile(join(root, "home"), "<!doctype html><html><body>Preview</body></html>");
    await writeFile(join(root, "image"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await writeFile(join(root, "binary"), Buffer.from([0xff, 0xfe, 0, 1]));
    const contents = await readDroppedWebsiteImport([root], { name: "landing" }, () => {});
    expect(contents["/home"]!.ContentType).toBe("text/html; charset=utf-8");
    expect(contents["/image"]!.ContentType).toBe("image/png");
    expect(contents["/binary"]!.ContentType).toBe("application/octet-stream");
    for (const item of Object.values(contents)) item.Content.fill(0);
  });

  it("rejects duplicate destinations across dropped roots and wipes already-read content", async () => {
    const root = await temporary();
    await mkdir(join(root, "first"));
    await mkdir(join(root, "second"));
    await writeFile(join(root, "first", "index.html"), "<h1>First</h1>");
    await writeFile(join(root, "second", "index.html"), "<h1>Second</h1>");
    const created = vi.spyOn(clientpb.WebContent, "create");
    try {
      await expect(readDroppedWebsiteImport([join(root, "first"), join(root, "second")], { name: "landing" }, () => {}))
        .rejects.toThrow(/Multiple dropped files.*\/index.html/);
      expect(created).toHaveBeenCalledOnce();
      expect(created.mock.results[0]!.value.Content.every((byte: number) => byte === 0)).toBe(true);
    } finally { created.mockRestore(); }
  });

  it("bounds the combined file count across all dropped directories", async () => {
    const root = await temporary();
    await mkdir(join(root, "first"));
    await mkdir(join(root, "second"));
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
      join(root, index < 250 ? "first" : "second", `file-${index}.txt`), "x",
    )));
    await expect(readDroppedWebsiteImport([join(root, "first"), join(root, "second")], { name: "landing" }, () => {}))
      .rejects.toThrow(/500-file/);
  });

  it("bounds the combined byte size across all dropped files", async () => {
    const root = await temporary();
    const first = join(root, "first.bin");
    const second = join(root, "second.bin");
    await writeFile(first, "x");
    await writeFile(second, "x");
    await truncate(first, WEBSITE_LIMITS.artifactBytes / 2);
    await truncate(second, WEBSITE_LIMITS.artifactBytes / 2 + 1);
    await expect(readDroppedWebsiteImport([first, second], { name: "landing" }, () => {}))
      .rejects.toThrow(/32 MiB batch limit/);
  });

  it("rejects top-level dropped symbolic links and invalid URL filenames", async () => {
    const root = await temporary();
    await writeFile(join(root, "actual"), "content");
    await symlink(join(root, "actual"), join(root, "linked"));
    await expect(readDroppedWebsiteImport([join(root, "linked")], { name: "landing" }, () => {}))
      .rejects.toThrow(/symbolic link/);
    await writeFile(join(root, "fragment#file"), "content");
    await expect(readDroppedWebsiteImport([join(root, "fragment#file")], { name: "landing" }, () => {}))
      .rejects.toThrow(/Website paths/);
  });

  it("verifies a server SHA-256 before exporting bytes", () => {
    const data = Buffer.from("verified");
    expect(websiteContentBytes(clientpb.WebContent.create({
      Content: data, Size: String(data.length), Sha256: createHash("sha256").update(data).digest("hex"),
    }))).toBe(data);
  });
});
