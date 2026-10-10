export type WebsitePreviewLanguage = "html" | "css" | "javascript" | "typescript" | "json" | "xml" | "markdown" | "yaml" | "plaintext";

/** Remote metadata can choose only a bundled, syntax-only tokenizer. */
export function websitePreviewLanguage(contentType: string, path: string): WebsitePreviewLanguage {
  const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "text/css") return "css";
  if (/^(?:text|application)\/(?:javascript|ecmascript)$/u.test(mime)) return "javascript";
  if (mime === "text/typescript" || mime === "application/typescript") return "typescript";
  if (mime === "application/json" || mime.endsWith("+json")) return "json";
  if (mime === "text/xml" || mime === "application/xml" || mime.endsWith("+xml")) return "xml";
  if (mime === "text/markdown") return "markdown";
  if (mime === "application/yaml" || mime === "text/yaml") return "yaml";
  const extension = path.split("/").at(-1)?.split(".").at(-1)?.toLowerCase();
  const extensions: Readonly<Record<string, WebsitePreviewLanguage>> = {
    html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript", cjs: "javascript",
    ts: "typescript", json: "json", xml: "xml", svg: "xml", md: "markdown", markdown: "markdown", yml: "yaml", yaml: "yaml",
  };
  return extension && Object.hasOwn(extensions, extension) ? extensions[extension] ?? "plaintext" : "plaintext";
}

/** Strip dynamic embedded-language selection from trusted grammars before registering aliases. */
export function isolateWebsitePreviewGrammar(value: unknown): unknown {
  if (value instanceof RegExp || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(isolateWebsitePreviewGrammar);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "nextEmbedded") {
      const embedded = entry === "@pop" ? "@pop"
        : entry === "text/javascript" ? "website-preview-javascript"
        : entry === "text/css" ? "website-preview-css" : "website-preview-plaintext";
      return [key, embedded];
    }
    return [key, isolateWebsitePreviewGrammar(entry)];
  }));
}
