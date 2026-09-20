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
    }
    expect(() => transform.call(context as never, "changed upstream source", path)).toThrow("Monaco's stylesheet source changed");
    expect(transform.call(context as never, source, "/some-other-package/domStylesheets.js")).toBeNull();
  });
});
