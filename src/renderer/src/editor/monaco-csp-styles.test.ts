import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MONACO_CSP_SOURCE_HASHES, monacoCspPlugin } from "../../../../scripts/monacoCspPlugin.mjs";
import { createMonacoMarkupFragment, createMonacoStyleElement } from "./monaco-csp-styles";

afterEach(() => {
  document.head.querySelectorAll("style").forEach((style) => style.remove());
  vi.restoreAllMocks();
});

describe("Monaco strict CSP styles", () => {
  it("updates only CSSOM while keeping the actual style element text empty", () => {
    vi.spyOn(CSSStyleSheet.prototype, "replaceSync").mockImplementation(function (this: CSSStyleSheet, css: string) {
      while (this.cssRules.length) this.deleteRule(0);
      if (css) this.insertRule(css, 0);
    });
    const style = createMonacoStyleElement(document.head);
    style.textContent = ".monaco-editor { color: red; }";
    expect(style.sheet?.cssRules).toHaveLength(1);
    expect(style.sheet?.cssRules[0]?.cssText).toContain("color: red");
    expect(style.childNodes).toHaveLength(0);
    expect(style.innerHTML).toBe("");
    expect(style.textContent).toBe(".monaco-editor { color: red; }");
    style.textContent = ".monaco-editor { color: blue; }";
    expect(style.sheet?.cssRules).toHaveLength(1);
    expect(style.sheet?.cssRules[0]?.cssText).toContain("color: blue");
    style.textContent = "";
    expect(style.sheet?.cssRules).toHaveLength(0);
    style.remove();
    expect(style.isConnected).toBe(false);
  });

  it("retains constructed rules before attachment and across detached widget reuse", async () => {
    vi.spyOn(CSSStyleSheet.prototype, "replaceSync").mockImplementation(function (this: CSSStyleSheet, css: string) {
      while (this.cssRules.length) this.deleteRule(0);
      if (css) this.insertRule(css, 0);
    });
    const widget = document.createElement("div");
    const style = createMonacoStyleElement(widget);
    const sheet = style.sheet as CSSStyleSheet;
    style.textContent = ".suggest-widget { color: red; }";
    sheet.insertRule(".suggest-widget.selected { color: blue; }", 1);
    expect(document.adoptedStyleSheets ?? []).not.toContain(sheet);
    document.body.appendChild(widget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.adoptedStyleSheets).toContain(sheet);
    widget.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.adoptedStyleSheets).not.toContain(sheet);
    document.body.appendChild(widget);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.adoptedStyleSheets).toContain(sheet);
    expect(style.sheet).toBe(sheet);
    expect(sheet.cssRules).toHaveLength(2);
    style.remove();
    expect(document.adoptedStyleSheets).not.toContain(sheet);
    widget.remove();
  });

  it("keeps shadow-root styles scoped and removes them with their host", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const style = createMonacoStyleElement(shadow);
    const sheet = style.sheet;
    expect(shadow.adoptedStyleSheets).toContain(sheet);
    expect(document.adoptedStyleSheets).not.toContain(sheet);
    host.remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.adoptedStyleSheets).not.toContain(sheet);
  });

  it("applies inert layout attributes without rewriting user source text", () => {
    const fragment = createMonacoMarkupFragment('<div data-monaco-style="top:21px"><span>const text = \' style="color:red" &lt;script&gt;\';</span></div>');
    const line = fragment.firstElementChild as HTMLElement;
    expect(line.style.top).toBe("21px");
    expect(line.hasAttribute("data-monaco-style")).toBe(false);
    expect(line.textContent).toBe('const text = \' style="color:red" <script>\';');
    expect(line.querySelector("script")).toBeNull();
  });

  it("restores fullwidth, injected-text, and SVG layout declarations through CSSOM", () => {
    const fragment = createMonacoMarkupFragment(
      '<div data-monaco-style="width:120px">'
      + '<span class="mtkfullwidth" data-monaco-style="width:16px">字</span>'
      + '<span data-monaco-style="display:inline-block;box-sizing:border-box;white-space:nowrap;width:2em;"></span>'
      + '<svg data-monaco-style="bottom:0;position:absolute;width:120px;height:20px" viewBox="0 0 120 20" xmlns="http://www.w3.org/2000/svg"><path d="M 0 0 L 4 4 Z" /></svg>'
      + '</div>',
    );
    const line = fragment.firstElementChild as HTMLElement;
    const fullwidth = line.children[0] as HTMLElement;
    const injected = line.children[1] as HTMLElement;
    const svg = line.children[2] as SVGElement;
    expect(line.style.width).toBe("120px");
    expect(fullwidth.textContent).toBe("字");
    expect(fullwidth.style.width).toBe("16px");
    expect(injected.style.width).toBe("2em");
    expect(injected.style.display).toBe("inline-block");
    expect(injected.style.boxSizing).toBe("border-box");
    expect(injected.style.whiteSpace).toBe("nowrap");
    expect(svg.style.position).toBe("absolute");
    expect(svg.style.height).toBe("20px");
    expect(svg.querySelector("path")?.getAttribute("d")).toBe("M 0 0 L 4 4 Z");
    expect(fragment.querySelector("[data-monaco-style]")).toBeNull();
  });

  it.each(Object.keys(MONACO_CSP_SOURCE_HASHES))("adapts the exact pinned Monaco source at %s", (suffix) => {
    const path = resolve(`node_modules/monaco-editor/esm/vs/${suffix}`);
    const source = readFileSync(path, "utf8");
    const transform = monacoCspPlugin().transform;
    if (typeof transform !== "function") throw new Error("Missing transform hook");
    const context = { error: (message: string): never => { throw new Error(message); } };
    const result = transform.call(context as never, source, path);
    expect(result).toEqual(expect.objectContaining({ code: expect.stringContaining("createMonacoStyleElement") }));
    if (suffix.includes("domStylesheets") || suffix.includes("contextview")) {
      expect((result as { code: string }).code).not.toContain("document.createElement('style')");
    } else {
      expect((result as { code: string }).code).not.toMatch(/(?<!data-monaco-)style="/);
    }
    expect(() => transform.call(context as never, "changed upstream source", path)).toThrow("Monaco's stylesheet source changed");
    expect(transform.call(context as never, source, "/some-other-package/domStylesheets.js")).toBeNull();
  });
});
