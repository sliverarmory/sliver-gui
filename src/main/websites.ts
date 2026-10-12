import { createHash } from "node:crypto";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { clientpb } from "sliver-script";
import {
  WEBSITE_LIMITS,
  parseWebsiteContentInput,
  type ImportWebsiteFilesInput,
  type WebsiteContentDetail,
  type WebsiteContentSummary,
  type WebsiteDetail,
  type WebsiteNameInput,
  type WebsiteSummary,
} from "../shared/website-contracts.js";
import { readBoundedRegularFile } from "./secure-file.js";
import { sniffLootMediaMimeType } from "./loot-media.js";

function bounded(value: string, max: number, label: string): string {
  if (value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`Invalid server website ${label}`);
  return value;
}
export function websiteSize(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(value)) throw new Error("Invalid server website content size");
  return BigInt(value);
}
export function clearWebsiteContents(site: clientpb.Website): void {
  for (const item of Object.values(site.Contents)) item.Content.fill(0);
}
export function assertWebsiteCatalogBudget(
  sites: clientpb.Website[], name: string, additions: Record<string, clientpb.WebContent>, expectedId?: string,
): void {
  const current = sites.find((site) => site.Name === name);
  if (expectedId !== undefined && current?.ID !== expectedId) throw new Error("The website changed; refresh before uploading");
  const predicted = clientpb.Website.create({
    ID: current?.ID || "00000000-0000-0000-0000-000000000000", Name: name,
    Contents: { ...current?.Contents, ...Object.fromEntries(Object.entries(additions).map(([path, item]) => [path,
      clientpb.WebContent.create({ ...item, ID: item.ID || "00000000-0000-0000-0000-000000000000",
        WebsiteID: current?.ID || "00000000-0000-0000-0000-000000000000", Sha256: item.Sha256 || "0".repeat(64) }),
    ])) },
  });
  // Include the entire protobuf envelope and replacement semantics, not just the selected file.
  const encoded = clientpb.Websites.encode({ Websites: [...sites.filter((site) => site.Name !== name), predicted] }).finish();
  try {
    if (encoded.byteLength > WEBSITE_LIMITS.catalogBytes) {
      throw new Error("Website content would exceed the 31 MiB catalog budget. Remove unused content before uploading; the server includes all website bytes in inventory replies.");
    }
  } finally { encoded.fill(0); }
}
export function websiteContentSummary(item: clientpb.WebContent): WebsiteContentSummary {
  websiteSize(item.Size);
  return {
    id: bounded(item.ID, 256, "content ID"),
    path: bounded(item.Path, WEBSITE_LIMITS.pathCharacters, "path"),
    contentType: bounded(item.ContentType, WEBSITE_LIMITS.contentTypeCharacters, "content type"),
    sizeBytes: item.Size,
    sha256: bounded(item.Sha256, 256, "digest"),
    originalFile: bounded(item.OriginalFile, WEBSITE_LIMITS.pathCharacters, "original filename"),
  };
}
export function websiteSummary(site: clientpb.Website): WebsiteSummary {
  let total = 0n;
  for (const item of Object.values(site.Contents)) total += websiteSize(item.Size);
  return {
    id: bounded(site.ID, 256, "ID"), name: bounded(site.Name, WEBSITE_LIMITS.nameCharacters, "name"),
    contentCount: Object.keys(site.Contents).length, totalSizeBytes: String(total),
  };
}
export function websiteDetail(site: clientpb.Website, expectedName: string): WebsiteDetail {
  if (site.Name !== expectedName) throw new Error("The server returned a different website");
  const items = Object.values(site.Contents).sort((a, b) => a.Path.localeCompare(b.Path));
  return {
    site: websiteSummary(site),
    contents: items.slice(0, WEBSITE_LIMITS.detailEntries).map(websiteContentSummary),
    truncated: items.length > WEBSITE_LIMITS.detailEntries,
  };
}
export function findWebsiteContent(site: clientpb.Website, name: string, path: string): clientpb.WebContent {
  if (site.Name !== name) throw new Error("The server returned a different website");
  const item = Object.values(site.Contents).find((content) => content.Path === path);
  if (!item) throw new Error("The website content no longer exists; refresh the website");
  return item;
}
export function websiteContentBytes(item: clientpb.WebContent): Uint8Array {
  const size = websiteSize(item.Size);
  if (size > BigInt(WEBSITE_LIMITS.artifactBytes) || item.Content.byteLength > WEBSITE_LIMITS.artifactBytes) {
    throw new Error("Website content exceeds the 32 MiB artifact limit");
  }
  if (BigInt(item.Content.byteLength) !== size) throw new Error("The server did not return complete website content");
  if (item.Sha256 && (!/^[0-9a-f]{64}$/iu.test(item.Sha256) ||
      createHash("sha256").update(item.Content).digest("hex") !== item.Sha256.toLowerCase())) {
    throw new Error("Website content does not match its server digest; refresh and try again");
  }
  return item.Content;
}
export function websiteContentPreview(item: clientpb.WebContent): WebsiteContentDetail {
  const summary = websiteContentSummary(item);
  const size = websiteSize(item.Size);
  if (size > BigInt(WEBSITE_LIMITS.artifactBytes) || item.Content.byteLength > WEBSITE_LIMITS.artifactBytes) {
    return { item: summary, previewState: "too-large", preview: new Uint8Array(), truncated: true };
  }
  if (BigInt(item.Content.byteLength) !== size) {
    return { item: summary, previewState: "unavailable", preview: new Uint8Array(), truncated: false };
  }
  websiteContentBytes(item);
  if (!item.Content.byteLength) return { item: summary, previewState: "empty", preview: new Uint8Array(), truncated: false };
  if (item.Content.byteLength > WEBSITE_LIMITS.previewBytes) {
    return {
      item: summary, previewState: "binary",
      preview: new Uint8Array(item.Content.subarray(0, WEBSITE_LIMITS.binaryPreviewBytes)), truncated: true,
    };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(item.Content);
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
      return { item: summary, previewState: "text", preview: new Uint8Array(item.Content), truncated: false };
    }
  } catch { /* Binary content is represented only as an inert hex preview. */ }
  return {
    item: summary, previewState: "binary",
    preview: new Uint8Array(item.Content.subarray(0, WEBSITE_LIMITS.binaryPreviewBytes)),
    truncated: item.Content.byteLength > WEBSITE_LIMITS.binaryPreviewBytes,
  };
}

/** Read a native-dialog selection while preserving its explicit destination and MIME behavior. */
export async function readWebsiteImport(
  selectedPath: string,
  input: ImportWebsiteFilesInput,
  assertBinding: () => void,
): Promise<Record<string, clientpb.WebContent>> {
  return readWebsiteImportBatch([{ sourcePath: selectedPath, ...input }], input, assertBinding);
}

/** Read paths resolved from genuine dropped files by the isolated preload bridge. */
export async function readDroppedWebsiteImport(
  sourcePaths: string[], input: WebsiteNameInput, assertBinding: () => void,
): Promise<Record<string, clientpb.WebContent>> {
  if (!sourcePaths.length || sourcePaths.length > WEBSITE_LIMITS.importFiles) {
    throw new Error("Website import requires between 1 and 500 files or directories");
  }
  return readWebsiteImportBatch(sourcePaths.map((sourcePath) => ({ sourcePath })), input, assertBinding);
}

interface WebsiteImportSelection {
  sourcePath: string;
  /** Undefined selects automatic dropped-file destination, type and MIME. */
  directory?: boolean;
  path?: string;
  contentType?: string;
  includeHiddenDirectories?: boolean;
}

async function readWebsiteImportBatch(
  selections: WebsiteImportSelection[], input: WebsiteNameInput, assertBinding: () => void,
): Promise<Record<string, clientpb.WebContent>> {
  const contents: Record<string, clientpb.WebContent> = Object.create(null) as Record<string, clientpb.WebContent>;
  let total = 0;
  let entries = 0;
  const addFile = async (file: string, urlPath: string, contentType: string | undefined, skipEmpty = false): Promise<void> => {
    if (Object.hasOwn(contents, urlPath)) throw new Error(`Multiple dropped files use the website path ${urlPath}`);
    if (Object.keys(contents).length >= WEBSITE_LIMITS.importFiles) throw new Error("Website import exceeds the 500-file limit");
    if (total >= WEBSITE_LIMITS.artifactBytes) throw new Error("Website import exceeds the 32 MiB batch limit");
    parseWebsiteContentInput({ name: input.name, path: urlPath });
    const read = await readBoundedRegularFile(file, {
      label: "Website content (32 MiB batch limit)", maxBytes: WEBSITE_LIMITS.artifactBytes - total,
    });
    try {
      assertBinding();
      if (!read.data.byteLength) {
        if (skipEmpty) return;
        throw new Error("Empty content cannot be uploaded by this Sliver server; select a non-empty file");
      }
      total += read.data.byteLength;
      contents[urlPath] = clientpb.WebContent.create({
        Path: urlPath, ContentType: contentType ?? websiteImportContentType(file, read.data), Content: read.data,
        Size: String(read.data.byteLength), OriginalFile: basename(file),
      });
    } catch (error) { read.data.fill(0); throw error; }
  };
  try {
    for (const selection of selections) {
      const selectedInfo = await lstat(selection.sourcePath);
      assertBinding();
      const directory = selection.directory ?? selectedInfo.isDirectory();
      if (selectedInfo.isSymbolicLink() || (directory ? !selectedInfo.isDirectory() : !selectedInfo.isFile())) {
        throw new Error("Website import must select a regular file or directory, not a symbolic link or special file");
      }
      const root = await realpath(selection.sourcePath);
      assertBinding();
      const canonicalInfo = await lstat(root);
      assertBinding();
      if (canonicalInfo.isSymbolicLink() || canonicalInfo.dev !== selectedInfo.dev || canonicalInfo.ino !== selectedInfo.ino) {
        throw new Error("Website import selection changed while being opened");
      }
      const basePath = selection.path ?? (directory ? "/" : `/${basename(selection.sourcePath)}`);
      const walk = async (currentDirectory: string, depth: number): Promise<void> => {
        if (depth > 32) throw new Error("Website import directory nesting exceeds the limit");
        const children = await readdir(currentDirectory, { withFileTypes: true });
        assertBinding();
        for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
          if (++entries > WEBSITE_LIMITS.importFiles * 2) throw new Error("Website import contains too many directory entries");
          if (child.isDirectory() && child.name.startsWith(".") && !selection.includeHiddenDirectories) continue;
          const childPath = join(currentDirectory, child.name);
          const childInfo = await lstat(childPath);
          assertBinding();
          if (childInfo.isSymbolicLink() || (!childInfo.isFile() && !childInfo.isDirectory())) {
            throw new Error("Website directory import does not follow symbolic links or special files");
          }
          // Empty marker files are common in website directories. The server
          // cannot store them, so exclude them without blocking the other files.
          if (childInfo.isFile() && childInfo.size === 0) continue;
          // Recheck directory type after lstat in case a file became a hidden directory.
          if (childInfo.isDirectory() && child.name.startsWith(".") && !selection.includeHiddenDirectories) continue;
          const canonical = await realpath(childPath);
          assertBinding();
          const localPath = relative(root, canonical);
          if (!localPath || localPath === ".." || localPath.startsWith(`..${sep}`) || isAbsolute(localPath)) {
            throw new Error("Website import file escaped the selected directory");
          }
          if (childInfo.isDirectory()) await walk(canonical, depth + 1);
          else await addFile(canonical, `${basePath.replace(/\/$/u, "")}/${localPath.split(sep).join("/")}`, selection.contentType, true);
        }
      };
      if (directory) await walk(root, 0);
      else await addFile(root, basePath, selection.contentType);
    }
    if (!Object.keys(contents).length) throw new Error("The selected website directories contain no non-empty files to upload");
    return contents;
  } catch (error) {
    for (const item of Object.values(contents)) item.Content.fill(0);
    throw error;
  }
}

const WEBSITE_EXTENSION_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".xhtml": "application/xhtml+xml",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".map": "application/json", ".webmanifest": "application/manifest+json",
  ".xml": "application/xml", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm", ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg",
  ".mp4": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
};

/** Prefer known web extensions, then byte signatures, then bounded UTF-8 detection. */
function websiteImportContentType(file: string, data: Uint8Array): string {
  const extensionType = WEBSITE_EXTENSION_CONTENT_TYPES[extname(file).toLowerCase()];
  if (extensionType) return extensionType;
  const mediaType = sniffLootMediaMimeType(data);
  if (mediaType) return mediaType;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, 512), { stream: data.byteLength > 512 });
    if (!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
      if (/^\s*(?:<!doctype html(?:\s|>)|<html(?:\s|>))/iu.test(text)) return "text/html; charset=utf-8";
      return "text/plain; charset=utf-8";
    }
  } catch { /* Unknown non-text data is downloaded rather than interpreted as markup. */ }
  return "application/octet-stream";
}
