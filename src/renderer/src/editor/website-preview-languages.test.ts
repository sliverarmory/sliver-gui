import { describe, expect, it } from "vitest";
import { isolateWebsitePreviewGrammar, websitePreviewLanguage } from "./website-preview-languages";

describe("website preview syntax selection", () => {
  it.each([
    ["text/html; charset=utf-8", "/index.txt", "html"],
    ["application/xhtml+xml", "/site", "html"],
    ["image/svg+xml", "/image", "xml"],
    ["application/ld+json", "/data", "json"],
    ["text/css", "/style", "css"],
    ["application/javascript", "/script", "javascript"],
    ["text/plain", "/assets/main.ts", "typescript"],
    ["text/markdown", "/README", "markdown"],
    ["text/plain", "/config.yaml", "yaml"],
    ["javascript:alert(1)", "file:///etc/passwd", "plaintext"],
    ["text/plain", "/constructor", "plaintext"],
    ["text/plain", "/__proto__", "plaintext"],
    ["text/plain", "https://remote.invalid/script.js?import=evil", "plaintext"],
  ])("maps %s and %s to the bundled %s grammar", (mime, path, expected) => {
    expect(websitePreviewLanguage(mime, path)).toBe(expected);
  });

  it("rewrites every embedded grammar to an isolated fixed ID, preserving trusted expressions and regexes", () => {
    const expression = /<script/u;
    const grammar = { tokenizer: { root: [
      [expression, { nextEmbedded: "text/javascript" }],
      [/style/u, { nextEmbedded: "text/css" }],
      [/dynamic/u, { nextEmbedded: "$S2" }],
      [/unknown/u, { nextEmbedded: "typescript" }],
      [/end/u, { nextEmbedded: "@pop" }],
    ] } };
    const isolated = isolateWebsitePreviewGrammar(grammar) as typeof grammar;
    expect(isolated.tokenizer.root.map((row) => (row[1] as { nextEmbedded: string }).nextEmbedded)).toEqual([
      "website-preview-javascript", "website-preview-css", "website-preview-plaintext", "website-preview-plaintext", "@pop",
    ]);
    expect(isolated.tokenizer.root[0]?.[0]).toBe(expression);
    expect(grammar.tokenizer.root[0]?.[1]).toEqual({ nextEmbedded: "text/javascript" });
  });
});
