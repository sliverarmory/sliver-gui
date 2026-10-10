import { generate, parse as parseCss, tokenTypes, walk, type CssNode, type Declaration } from "css-tree";
import { defaultTreeAdapter, html, parse, type DefaultTreeAdapterTypes, type TreeAdapter } from "parse5";

export const WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const WEBSITE_RENDERED_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'none'", "style-src 'unsafe-inline'", "img-src data:",
  "connect-src 'none'", "font-src 'none'", "media-src 'none'", "object-src 'none'",
  "frame-src 'none'", "child-src 'none'", "worker-src 'none'", "base-uri 'none'", "form-action 'none'", "sandbox",
].join("; ");

const LIMITS = Object.freeze({ htmlBytes: 1024 * 1024, rasterBytes: 8 * 1024 * 1024, nodes: 10_000,
  depth: 80, attributes: 64, attributeCharacters: 8192, cssCharacters: 64 * 1024,
  cssTokens: 20_000, cssNesting: 16, declarations: 2000, rules: 500, imageEdge: 4096, imagePixels: 8_000_000 });

const ELEMENTS = new Set(("a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup " +
  "dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i ins kbd " +
  "li main mark nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td " +
  "tfoot th thead time tr u ul var wbr").split(" "));
const VOID_ELEMENTS = new Set(["br", "col", "hr", "wbr"]);
const GLOBAL_ATTRIBUTES = new Set(["id", "class", "title", "lang", "dir"]);
const CSS_PROPERTIES = new Set(("color background-color font font-family font-size font-style font-weight font-variant " +
  "line-height letter-spacing word-spacing text-align text-decoration text-decoration-color text-decoration-line " +
  "text-decoration-style text-indent text-transform text-overflow white-space word-break overflow-wrap " +
  "border border-top border-right border-bottom border-left border-color border-style border-width border-radius " +
  "border-top-color border-right-color border-bottom-color border-left-color border-top-style border-right-style " +
  "border-bottom-style border-left-style border-top-width border-right-width border-bottom-width border-left-width " +
  "border-top-left-radius border-top-right-radius border-bottom-left-radius border-bottom-right-radius " +
  "margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left " +
  "width min-width max-width height min-height max-height box-sizing display visibility opacity overflow overflow-x overflow-y " +
  "vertical-align float clear position top right bottom left flex flex-basis flex-direction flex-grow flex-shrink flex-wrap " +
  "align-items align-content align-self justify-content justify-items justify-self order gap row-gap column-gap " +
  "grid-template-columns grid-template-rows grid-column grid-row grid-auto-flow list-style-type list-style-position " +
  "border-collapse border-spacing table-layout caption-side empty-cells").split(" "));
const CSS_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "calc", "min", "max", "clamp"]);
const CSS_UNITS = new Set(["px", "em", "rem", "ex", "ch", "vw", "vh", "vmin", "vmax", "fr", "pt", "pc", "cm", "mm", "in", "deg", "rad", "grad", "turn"]);

class PreviewLimitError extends Error {}
interface CssBudget { characters: number; tokens: number; declarations: number; rules: number; }

/** Builds static display data only; callers must use the separate, unprivileged preview window. */
export function buildWebsiteRenderedPreview(input: {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}): { readonly html: string; readonly kind: "html" | "raster" } {
  const mime = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mime === "image/png" || mime === "image/jpeg") {
    if (!input.bytes.byteLength || input.bytes.byteLength > LIMITS.rasterBytes) throw new Error("Rendered images must be no larger than 8 MiB");
    const dimensions = mime === "image/png" ? pngDimensions(input.bytes) : jpegDimensions(input.bytes);
    const source = `data:${mime};base64,${Buffer.from(input.bytes).toString("base64")}`;
    return { kind: "raster", html: documentHtml("", `<img alt="Hosted image preview" width="${dimensions.width}" height="${dimensions.height}" style="max-width:100%;height:auto" src="${source}">`) };
  }
  if (mime !== "text/html" && mime !== "application/xhtml+xml") {
    throw new Error("Rendered preview supports HTML, PNG, and JPEG content. Use source or hex preview for other types.");
  }
  if (input.bytes.byteLength > LIMITS.htmlBytes) throw new Error("Rendered HTML previews are limited to 1 MiB");
  let source: string;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); }
  catch { throw new Error("Rendered HTML preview requires valid UTF-8 content"); }
  const document = parse(source, { scriptingEnabled: false, treeAdapter: boundedTreeAdapter() });
  const htmlElement = document.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "html");
  const head = htmlElement?.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "head");
  const body = htmlElement?.childNodes.find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node && node.tagName === "body");
  const cssBudget: CssBudget = { characters: 0, tokens: 0, declarations: 0, rules: 0 };
  let visited = 0;
  const render = (node: DefaultTreeAdapterTypes.Node, depth: number): string => {
    if (++visited > LIMITS.nodes || depth > LIMITS.depth) throw new PreviewLimitError("HTML preview exceeds its node or nesting limit");
    if (defaultTreeAdapter.isTextNode(node)) return escapeHtml(node.value);
    if (!defaultTreeAdapter.isElementNode(node) || node.namespaceURI !== html.NS.HTML) return "";
    if (node.tagName === "style") {
      const raw = node.childNodes.filter(defaultTreeAdapter.isTextNode).map((child) => child.value).join("");
      const css = sanitizeCss(raw, "stylesheet", cssBudget);
      return css ? `<style>${css.replaceAll("<", "\\3c ")}</style>` : "";
    }
    if (!ELEMENTS.has(node.tagName)) return "";
    const attributes = safeAttributes(node, cssBudget);
    return `<${node.tagName}${attributes}>${VOID_ELEMENTS.has(node.tagName) ? "" : `${node.childNodes.map((child) => render(child, depth + 1)).join("")}</${node.tagName}>`}`;
  };
  const headHtml = (head?.childNodes ?? []).filter((node) => "tagName" in node && node.tagName === "style").map((node) => render(node, 0)).join("");
  const bodyHtml = (body?.childNodes ?? []).map((node) => render(node, 0)).join("");
  return { kind: "html", html: documentHtml(headHtml, bodyHtml, body ? safeAttributes(body, cssBudget) : "") };
}

function documentHtml(head: string, body: string, bodyAttributes = ""): string {
  const output = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${escapeHtml(WEBSITE_RENDERED_PREVIEW_CSP)}"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Static website preview</title>${head}</head><body${bodyAttributes}>${body}</body></html>`;
  if (Buffer.byteLength(output, "utf8") > WEBSITE_RENDERED_PREVIEW_MAX_OUTPUT_BYTES) throw new PreviewLimitError("Rendered preview exceeds its output size limit");
  return output;
}

function boundedTreeAdapter(): TreeAdapter<DefaultTreeAdapterTypes.DefaultTreeAdapterMap> {
  let created = 0;
  let openElements = 0;
  const count = (): void => { if (++created > LIMITS.nodes) throw new PreviewLimitError("HTML preview exceeds its node limit"); };
  return {
    ...defaultTreeAdapter,
    createElement(tagName, namespace, attributes) {
      count();
      if (attributes.length > LIMITS.attributes || attributes.some((attribute) => attribute.value.length > LIMITS.attributeCharacters)) {
        throw new PreviewLimitError("HTML preview exceeds its attribute limit");
      }
      return defaultTreeAdapter.createElement(tagName, namespace, attributes);
    },
    createCommentNode(value) { count(); return defaultTreeAdapter.createCommentNode(value); },
    insertText(parent, text) { count(); defaultTreeAdapter.insertText(parent, text); },
    insertTextBefore(parent, text, reference) { count(); defaultTreeAdapter.insertTextBefore(parent, text, reference); },
    adoptAttributes(element, attributes) {
      if (element.attrs.length + attributes.length > LIMITS.attributes || attributes.some((attribute) => attribute.value.length > LIMITS.attributeCharacters)) {
        throw new PreviewLimitError("HTML preview exceeds its attribute limit");
      }
      defaultTreeAdapter.adoptAttributes(element, attributes);
    },
    onItemPush() { if (++openElements > LIMITS.depth) throw new PreviewLimitError("HTML preview exceeds its nesting limit"); },
    onItemPop() { openElements--; },
  };
}

function safeAttributes(element: DefaultTreeAdapterTypes.Element, budget: CssBudget): string {
  const attributes: string[] = [];
  for (const attribute of element.attrs) {
    if (attribute.namespace || attribute.prefix) continue;
    const { name, value } = attribute;
    if (name === "style") {
      const css = sanitizeCss(value, "declarationList", budget);
      if (css) attributes.push(`style="${escapeHtml(css)}"`);
    } else if (GLOBAL_ATTRIBUTES.has(name) && (name !== "dir" || ["ltr", "rtl", "auto"].includes(value))) {
      attributes.push(`${name}="${escapeHtml(value)}"`);
    } else if (["colspan", "rowspan", "span", "start", "value"].includes(name) && /^-?[0-9]{1,3}$/u.test(value)) {
      attributes.push(`${name}="${value}"`);
    } else if (name === "scope" && ["row", "col", "rowgroup", "colgroup"].includes(value)) {
      attributes.push(`scope="${value}"`);
    } else if ((name === "open" && element.tagName === "details") || (name === "reversed" && element.tagName === "ol")) {
      attributes.push(name);
    }
  }
  return attributes.length ? ` ${attributes.join(" ")}` : "";
}

function sanitizeCss(source: string, context: "stylesheet" | "declarationList", budget: CssBudget): string {
  budget.characters += source.length;
  if (budget.characters > LIMITS.cssCharacters) throw new PreviewLimitError("HTML preview exceeds its CSS size limit");
  let ast: CssNode;
  let nesting = 0;
  try {
    ast = parseCss(source, {
      context, positions: false, parseValue: true, parseCustomProperty: false,
      onToken(type) {
        if (++budget.tokens > LIMITS.cssTokens) throw new PreviewLimitError("HTML preview exceeds its CSS token limit");
        if ([tokenTypes.Function, tokenTypes.LeftParenthesis, tokenTypes.LeftCurlyBracket, tokenTypes.LeftSquareBracket].includes(type)) {
          if (++nesting > LIMITS.cssNesting) throw new PreviewLimitError("HTML preview exceeds its CSS nesting limit");
        } else if ([tokenTypes.RightParenthesis, tokenTypes.RightCurlyBracket, tokenTypes.RightSquareBracket].includes(type)) nesting = Math.max(0, nesting - 1);
      },
    });
  } catch (error) {
    if (error instanceof PreviewLimitError) throw error;
    return "";
  }
  if (ast.type === "DeclarationList") return sanitizeDeclarations(ast.children, budget);
  if (ast.type !== "StyleSheet") return "";
  const rules: string[] = [];
  for (const rule of ast.children) {
    if (++budget.rules > LIMITS.rules) throw new PreviewLimitError("HTML preview exceeds its CSS rule limit");
    if (rule.type !== "Rule" || rule.prelude.type !== "SelectorList" || !safeSelector(rule.prelude)) continue;
    const declarations = sanitizeDeclarations(rule.block.children, budget);
    if (declarations) rules.push(`${generate(rule.prelude)}{${declarations}}`);
  }
  return rules.join("");
}

function sanitizeDeclarations(nodes: Iterable<CssNode>, budget: CssBudget): string {
  const declarations: string[] = [];
  for (const node of nodes) {
    if (++budget.declarations > LIMITS.declarations) throw new PreviewLimitError("HTML preview exceeds its CSS declaration limit");
    if (node.type !== "Declaration" || !safeDeclaration(node)) continue;
    declarations.push(`${node.property.toLowerCase()}:${generate(node.value)}`);
  }
  return declarations.join(";");
}

function safeDeclaration(declaration: Declaration): boolean {
  const property = declaration.property.toLowerCase();
  if (!CSS_PROPERTIES.has(property) || declaration.value.type !== "Value") return false;
  if (property === "position" && !["static", "relative"].includes(generate(declaration.value))) return false;
  let safe = true;
  let nodes = 0;
  walk(declaration.value, (node) => {
    if (++nodes > 128) { safe = false; return walk.skip; }
    switch (node.type) {
      case "Value": case "WhiteSpace": break;
      case "Identifier": if (!/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/u.test(node.name)) safe = false; break;
      case "Hash": if (!/^[a-fA-F0-9]{3,8}$/u.test(node.value)) safe = false; break;
      case "Number": case "Percentage": if (!Number.isFinite(Number(node.value)) || Math.abs(Number(node.value)) > 4096) safe = false; break;
      case "Dimension": if (!CSS_UNITS.has(node.unit.toLowerCase()) || !Number.isFinite(Number(node.value)) || Math.abs(Number(node.value)) > 4096) safe = false; break;
      case "String": if (property !== "font-family" && property !== "font") safe = false;
        if (node.value.length > 256 || /[<>\u0000-\u001f]/u.test(node.value)) safe = false; break;
      case "Operator": if (![",", "/", "+", "-", "*"].includes(node.value.trim())) safe = false; break;
      case "Function": if (!CSS_FUNCTIONS.has(node.name.toLowerCase())) safe = false; break;
      default: safe = false;
    }
    return undefined;
  });
  return safe;
}

function safeSelector(selector: CssNode): boolean {
  let safe = true;
  let nodes = 0;
  walk(selector, (node) => {
    if (++nodes > 128) { safe = false; return walk.skip; }
    switch (node.type) {
      case "SelectorList": case "Selector": break;
      case "TypeSelector": if (node.name !== "*" && !/^[a-zA-Z][a-zA-Z0-9-]{0,63}$/u.test(node.name)) safe = false; break;
      case "ClassSelector": case "IdSelector": if (!/^[a-zA-Z_-][a-zA-Z0-9_-]{0,127}$/u.test(node.name)) safe = false; break;
      case "Combinator": if (![" ", ">", "+", "~"].includes(node.name)) safe = false; break;
      case "PseudoClassSelector": if (node.children !== null || !["first-child", "last-child", "only-child", "empty"].includes(node.name)) safe = false; break;
      default: safe = false;
    }
    return undefined;
  });
  return safe;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}

function checkDimensions(width: number, height: number): { width: number; height: number } {
  if (!width || !height || width > LIMITS.imageEdge || height > LIMITS.imageEdge || width * height > LIMITS.imagePixels) {
    throw new Error("Rendered images must fit within 4096 pixels per edge and 8 million pixels total");
  }
  return { width, height };
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      data.readUInt32BE(8) !== 13 || data.toString("ascii", 12, 16) !== "IHDR") throw new Error("Invalid PNG image header");
  const dimensions = checkDimensions(data.readUInt32BE(16), data.readUInt32BE(20));
  let offset = 8;
  let chunks = 0;
  let imageData = false;
  while (offset + 12 <= data.length) {
    if (++chunks > 4096) throw new Error("PNG image exceeds the chunk limit");
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    if (length > data.length - offset - 12 || (type === "IHDR" && offset !== 8) || ["acTL", "fcTL", "fdAT"].includes(type)) throw new Error("Invalid or animated PNG content");
    offset += length + 12;
    if (type === "IDAT") imageData = true;
    if (type === "IEND") {
      if (length !== 0 || offset !== data.length || !imageData) throw new Error("Invalid PNG image structure");
      return dimensions;
    }
  }
  throw new Error("Incomplete PNG image");
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) throw new Error("Invalid JPEG image header");
  let offset = 2;
  let segments = 0;
  let scan = false;
  let sawScan = false;
  let dimensions: { width: number; height: number } | undefined;
  while (offset < data.length) {
    if (scan) { while (offset < data.length && data[offset] !== 0xff) offset++; }
    if (data[offset++] !== 0xff) throw new Error("Invalid JPEG marker");
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++];
    if (marker === undefined) break;
    if (scan && (marker === 0 || (marker >= 0xd0 && marker <= 0xd7))) continue;
    scan = false;
    if (++segments > 4096) throw new Error("JPEG image exceeds the segment limit");
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || offset !== data.length) throw new Error("Invalid JPEG image structure");
      return dimensions;
    }
    // Exclude DNL (late dimension changes), hierarchical frames and uncommon extensions.
    if (![0xc0, 0xc1, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xfe].includes(marker) && !(marker >= 0xe0 && marker <= 0xef)) {
      throw new Error("Unsupported JPEG marker");
    }
    if (offset + 2 > data.length) break;
    const length = data.readUInt16BE(offset);
    if (length < 2 || length > data.length - offset) throw new Error("Invalid JPEG segment");
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (dimensions || length < 8 || data[offset + 2] !== 8 || !data[offset + 7] || data[offset + 7]! > 4 || length !== 8 + 3 * data[offset + 7]!) {
        throw new Error("Unsupported JPEG frame");
      }
      dimensions = checkDimensions(data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
    }
    if (marker === 0xda && (!dimensions || length < 8 || !data[offset + 2] || data[offset + 2]! > 4 || length !== 6 + 2 * data[offset + 2]!)) {
      throw new Error("Invalid JPEG scan");
    }
    offset += length;
    if (marker === 0xda) { scan = true; sawScan = true; }
  }
  throw new Error("Incomplete JPEG image");
}
