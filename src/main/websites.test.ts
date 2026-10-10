// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientpb } from "sliver-script";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WEBSITE_LIMITS } from "../shared/website-contracts.js";
import { assertWebsiteCatalogBudget, clearWebsiteContents, readWebsiteImport, websiteContentBytes, websiteContentPreview, websiteDetail } from "./websites.js";

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

  it("rejects empty files and symbolic links without producing an upload", async () => {
    const root = await temporary();
    await writeFile(join(root, "empty"), "");
    await expect(readWebsiteImport(root, importInput, () => {})).rejects.toThrow(/Empty content/);
    await rm(join(root, "empty"));
    await writeFile(join(root, "actual"), "data");
    await symlink(join(root, "actual"), join(root, "link"));
    await expect(readWebsiteImport(root, importInput, () => {})).rejects.toThrow(/symbolic links/);
  });

  it.each([{}, { includeHiddenDirectories: false }])(
    "skips hidden child directories at every level but imports dot files with option %j", async (option) => {
      const root = await temporary();
      await mkdir(join(root, ".git"));
      await mkdir(join(root, "nested", ".cache"), { recursive: true });
      await mkdir(join(root, "assets.v1"));
      await writeFile(join(root, ".git", "config"), "private git configuration");
      // A skipped directory is never traversed, even if its contents would reject an import.
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

  it("verifies a server SHA-256 before exporting bytes", () => {
    const data = Buffer.from("verified");
    expect(websiteContentBytes(clientpb.WebContent.create({
      Content: data, Size: String(data.length), Sha256: createHash("sha256").update(data).digest("hex"),
    }))).toBe(data);
  });
});
