// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { adaptGhosttyAppearance } from "../../../../scripts/ghosttyAppearancePlugin.mjs";

let runtime: typeof import("ghostty-web");
let upstreamSource: string;
beforeAll(async () => {
  upstreamSource = await readFile(resolve("node_modules/ghostty-web/dist/ghostty-web.js"), "utf8");
  // Exercise the actual transformed package, not a duplicate renderer mock.
  runtime = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(adaptGhosttyAppearance(upstreamSource)).toString("base64")}`) as typeof runtime;
});
afterEach(() => vi.unstubAllGlobals());

describe("pinned Ghostty appearance adapter", () => {
  it("rejects unreviewed package source", () => {
    expect(() => adaptGhosttyAppearance(`${upstreamSource}\n`)).toThrow("renderer source changed");
  });

  it.each([0, 0.5])("clears rows at background opacity %s and keeps text and explicit colored backgrounds opaque", (backgroundOpacity) => {
    const { renderer, operations, buffer } = fixtureRenderer(backgroundOpacity);
    renderer.render(buffer, true);
    const firstPaint = operations.filter((entry) => entry.kind === "background");
    expect(firstPaint).toEqual([
      { kind: "background", color: "#123456", alpha: backgroundOpacity },
      { kind: "background", color: "rgb(255, 0, 0)", alpha: 1 },
    ]);
    expect(operations.filter((entry) => entry.kind === "text")).toEqual([
      { kind: "text", color: "rgb(200, 210, 220)", alpha: 1, text: "A" },
      { kind: "text", color: "rgb(200, 210, 220)", alpha: 1, text: "B" },
    ]);
    renderer.render(buffer, true);
    expect(operations.filter((entry) => entry.kind === "clear")).toHaveLength(2);
    renderer.dispose();
  });

  it("honors selection foreground and block cursor text colors", () => {
    const { renderer, operations, buffer } = fixtureRenderer();
    renderer.setSelectionManager({
      hasSelection: () => true,
      getSelectionCoords: () => ({ startCol: 0, startRow: 0, endCol: 0, endRow: 0 }),
      getDirtySelectionRows: () => new Set(),
      clearDirtySelectionRows: () => undefined,
    } as unknown as Parameters<typeof renderer.setSelectionManager>[0]);
    renderer.render(buffer, true);
    expect(operations).toContainEqual({ kind: "text", color: "#aabbcc", alpha: 1, text: "A" });
    operations.length = 0;
    buffer.getCursor = () => ({ x: 0, y: 0, visible: true });
    renderer.render(buffer, true);
    expect(operations.at(-1)).toEqual({ kind: "text", color: "#ccbbaa", alpha: 1, text: "A" });
    renderer.dispose();
  });

  it("preserves explicit black in the pinned WASM configuration", async () => {
    const bytes = await readFile(resolve("node_modules/ghostty-web/ghostty-vt.wasm"));
    const { instance } = await WebAssembly.instantiate(bytes, { env: { log: () => undefined } });
    const ghostty = new runtime.Ghostty(instance);
    const terminal = new runtime.Terminal({ ghostty, theme: { foreground: "#000000", background: "#000000", red: "#000000" } });
    const config = (terminal as unknown as { buildWasmConfig(): { fgColor: number; bgColor: number; palette: number[] } }).buildWasmConfig();
    expect(config.fgColor).toBe(0x01000000);
    expect(config.bgColor).toBe(0x01000000);
    expect(config.palette[1]).toBe(0x01000000);
    const parser = ghostty.createTerminal(2, 1, config);
    parser.write("A\x1b[31mB");
    parser.update();
    for (const cell of parser.getLine(0) ?? []) {
      expect([cell.fg_r, cell.fg_g, cell.fg_b, cell.bg_r, cell.bg_g, cell.bg_b]).toEqual([0, 0, 0, 0, 0, 0]);
    }
    parser.free();
  });
});

function fixtureRenderer(backgroundOpacity = 0.5) {
  const operations: Array<{ kind: string; color?: string; alpha?: number; text?: string }> = [];
  const context = {
    fillStyle: "", globalAlpha: 1,
    measureText: () => ({ width: 10, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 3 }),
    clearRect() { operations.push({ kind: "clear" }); },
    fillRect() { operations.push({ kind: "background", color: this.fillStyle, alpha: this.globalAlpha }); },
    fillText(text: string) { operations.push({ kind: "text", color: this.fillStyle, alpha: this.globalAlpha, text }); },
  };
  const canvas = { getContext: () => context, width: 20, height: 15, style: {} };
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("window", { devicePixelRatio: 1 });
  const renderer = new runtime.CanvasRenderer(canvas as unknown as HTMLCanvasElement, {
    theme: {
      background: "#123456", foreground: "#c8d2dc", selectionForeground: "#aabbcc", cursorAccent: "#ccbbaa",
      backgroundOpacity,
    } as Parameters<typeof runtime.CanvasRenderer.prototype.setTheme>[0],
  });
  const line = [0, 1].map((index) => ({
    codepoint: 65 + index, fg_r: 200, fg_g: 210, fg_b: 220,
    bg_r: index ? 255 : 0x12, bg_g: index ? 0 : 0x34, bg_b: index ? 0 : 0x56,
    flags: 0, width: 1, hyperlink_id: 0, grapheme_len: 0,
  }));
  const buffer = {
    getCursor: () => ({ x: 0, y: 0, visible: false }),
    getDimensions: () => ({ cols: 2, rows: 1 }),
    isRowDirty: () => true,
    getLine: () => line,
    clearDirty: () => undefined,
  };
  return { renderer, operations, buffer };
}
