import type { OperatorDataPageSummary } from "./operator-data-contracts.js";

export const WEBSITE_LIMITS = Object.freeze({
  nameCharacters: 256,
  pathCharacters: 2048,
  contentTypeCharacters: 256,
  previewBytes: 1024 * 1024,
  binaryPreviewBytes: 4096,
  artifactBytes: 32 * 1024 * 1024,
  // The pinned server includes content in inventory replies (SDK limit: 32 MiB).
  catalogBytes: 31 * 1024 * 1024,
  importFiles: 500,
  detailEntries: 2000,
  pageSize: 100,
  maxPageSize: 200,
} as const);

export interface WebsiteSummary { id: string; name: string; contentCount: number; totalSizeBytes: string; }
export interface WebsiteContentSummary {
  id: string;
  path: string;
  contentType: string;
  sizeBytes: string;
  sha256: string;
  originalFile: string;
}
export interface WebsiteDetail { site: WebsiteSummary; contents: WebsiteContentSummary[]; truncated: boolean; }
export interface WebsiteCatalogPage { items: WebsiteSummary[]; page: OperatorDataPageSummary; }
export interface ListWebsitesInput { query?: string; cursor?: string; limit?: number; }
export interface WebsiteNameInput { name: string; }
export interface WebsiteContentInput extends WebsiteNameInput { path: string; }
export interface UpdateWebsiteContentTypeInput extends WebsiteContentInput { contentType: string; }
export interface SaveWebsiteTextInput extends UpdateWebsiteContentTypeInput { text: string; overwrite: boolean; }
export interface ImportWebsiteFilesInput extends UpdateWebsiteContentTypeInput {
  overwrite: boolean;
  directory: boolean;
  includeHiddenDirectories?: boolean;
}
export interface WebsiteContentDetail {
  item: WebsiteContentSummary;
  previewState: "text" | "binary" | "too-large" | "unavailable" | "empty";
  preview: Uint8Array;
  truncated: boolean;
}
export interface WebsiteExportResult { saved: boolean; fileName: string; size: number; }

function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("Website input must be an object");
  }
  const input = value as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(input, key)) ||
      Object.keys(input).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError("Unexpected website input fields");
  }
  return input;
}

function string(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  const result = value.trim();
  if (!allowEmpty && !result) throw new TypeError(`${label} is required`);
  return result;
}

function name(value: unknown): string {
  string(value, "website name", WEBSITE_LIMITS.nameCharacters);
  // Existing website names are exact server keys, including surrounding spaces.
  return value as string;
}
function path(value: unknown): string {
  string(value, "website path", WEBSITE_LIMITS.pathCharacters);
  // A URL path is an exact server key. Whitespace in filenames is meaningful.
  const result = value as string;
  if (!result.startsWith("/") || result.startsWith("//") || /[\\?#]/u.test(result) ||
      result.split("/").some((part) => part === "." || part === "..")) {
    throw new TypeError("Website paths must be absolute URL paths without query, fragment, or traversal");
  }
  return result;
}
function contentType(value: unknown): string {
  const result = string(value, "content type", WEBSITE_LIMITS.contentTypeCharacters, true);
  if (result && !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+(?:\s*;[^\r\n]*)?$/u.test(result)) {
    throw new TypeError("Content type must be a MIME type");
  }
  return result;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean`);
  return value;
}

export function parseListWebsitesInput(value: unknown): ListWebsitesInput {
  const input = record(value, [], ["query", "cursor", "limit"]);
  const result: ListWebsitesInput = {};
  if (input["query"] !== undefined) result.query = string(input["query"], "query", 256, true);
  if (input["cursor"] !== undefined) {
    const cursor = string(input["cursor"], "cursor", 16);
    if (!/^(0|[1-9][0-9]*)$/u.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new TypeError("Invalid cursor");
    result.cursor = cursor;
  }
  if (input["limit"] !== undefined) {
    const limit = input["limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > WEBSITE_LIMITS.maxPageSize) {
      throw new TypeError("Invalid website page limit");
    }
    result.limit = limit;
  }
  return result;
}
export function parseWebsiteNameInput(value: unknown): WebsiteNameInput {
  const input = record(value, ["name"]);
  return { name: name(input["name"]) };
}
export function parseWebsiteContentInput(value: unknown): WebsiteContentInput {
  const input = record(value, ["name", "path"]);
  return { name: name(input["name"]), path: path(input["path"]) };
}
export function parseUpdateWebsiteContentTypeInput(value: unknown): UpdateWebsiteContentTypeInput {
  const input = record(value, ["name", "path", "contentType"]);
  return { name: name(input["name"]), path: path(input["path"]), contentType: contentType(input["contentType"]) };
}
export function parseSaveWebsiteTextInput(value: unknown): SaveWebsiteTextInput {
  const input = record(value, ["name", "path", "contentType", "text", "overwrite"]);
  if (typeof input["text"] !== "string" || input["text"].length > WEBSITE_LIMITS.previewBytes ||
      new TextEncoder().encode(input["text"]).byteLength > WEBSITE_LIMITS.previewBytes) {
    throw new TypeError("Website text exceeds the editor limit");
  }
  return {
    name: name(input["name"]), path: path(input["path"]), contentType: contentType(input["contentType"]),
    text: input["text"], overwrite: boolean(input["overwrite"], "overwrite"),
  };
}
export function parseImportWebsiteFilesInput(value: unknown): ImportWebsiteFilesInput {
  const input = record(value, ["name", "path", "contentType", "overwrite", "directory"], ["includeHiddenDirectories"]);
  return {
    name: name(input["name"]), path: path(input["path"]), contentType: contentType(input["contentType"]),
    overwrite: boolean(input["overwrite"], "overwrite"), directory: boolean(input["directory"], "directory"),
    includeHiddenDirectories: Object.hasOwn(input, "includeHiddenDirectories")
      ? boolean(input["includeHiddenDirectories"], "includeHiddenDirectories") : false,
  };
}
