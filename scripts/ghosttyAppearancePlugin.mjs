import { createHash } from "node:crypto";

// ghostty-web 0.4.0 has an alpha canvas, but paints every default-background
// cell opaque and never clears a row before repainting it. Keep this small
// renderer-only adaptation tied to the exact reviewed package source.
export const GHOSTTY_APPEARANCE_SOURCE_SHA256 = "078b3fe37e4ef469d3f3d7772ee263070f8613e5a6f5ff305c85778907f45e72";

export function adaptGhosttyAppearance(source) {
  if (createHash("sha256").update(source).digest("hex") !== GHOSTTY_APPEARANCE_SOURCE_SHA256) {
    throw new Error("Ghostty's renderer source changed; review its appearance adapter before upgrading");
  }
  let code = source;
  const replaceOnce = (expected, replacement) => {
    if (code.split(expected).length !== 2) throw new Error("Ghostty's appearance adapter no longer matches its source");
    code = code.replace(expected, replacement);
  };

  replaceOnce("  rgbToCSS(A, B, g) {", `  paintDefaultBackground(x, y, width, height) {
    this.ctx.clearRect(x, y, width, height);
    this.ctx.fillStyle = this.theme.background;
    this.ctx.globalAlpha = this.theme.backgroundOpacity ?? 1;
    this.ctx.fillRect(x, y, width, height);
    this.ctx.globalAlpha = 1;
  }
  rgbToCSS(A, B, g) {`);
  replaceOnce("this.ctx.fillStyle = this.theme.background, this.ctx.fillRect(0, 0, g, E);", "this.paintDefaultBackground(0, 0, g, E);");
  replaceOnce("this.ctx.fillStyle = this.theme.background, this.ctx.fillRect(0, E, g * this.metrics.width, this.metrics.height);", "this.paintDefaultBackground(0, E, g * this.metrics.width, this.metrics.height);");
  replaceOnce("C.fillStyle = this.theme.background, C.fillRect(w - 2, 0, i + 6, I)", "this.paintDefaultBackground(w - 2, 0, i + 6, I)");
  replaceOnce("this.ctx.fillStyle = this.theme.background, this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);", "this.paintDefaultBackground(0, 0, this.canvas.width, this.canvas.height);");

  // The pinned WASM exposes resolved RGB, not background provenance. Cells
  // matching the default background inherit its opacity, including an explicit
  // ANSI background with the same RGB. Colored cells and text stay opaque.
  replaceOnce("    let i = A.bg_r, w = A.bg_g, s = A.bg_b;", `    if (this.theme.backgroundOpacity < 1 && !(A.flags & e.INVERSE)) {
      const color = "#" + [A.bg_r, A.bg_g, A.bg_b].map(value => value.toString(16).padStart(2, "0")).join("");
      if (color === this.theme.background.toLowerCase()) return;
    }
    let i = A.bg_r, w = A.bg_g, s = A.bg_b;`);
  replaceOnce("i === 0 && w === 0 && s === 0 || (this.ctx.fillStyle = this.rgbToCSS(i, w, s), this.ctx.fillRect(E, C, I, this.metrics.height))", "(this.ctx.fillStyle = this.rgbToCSS(i, w, s), this.ctx.fillRect(E, C, I, this.metrics.height))");

  // The WASM ABI uses zero for an unset color, then masks configured RGB to
  // 24 bits. Preserve explicit black with a nonzero high byte, so #000000 is
  // distinct from an absent color without changing the pinned WASM binary.
  replaceOnce("return Number.isNaN(E) ? 0 : E;", "return Number.isNaN(E) ? 0 : E || 0x01000000;");
  replaceOnce("return g << 16 | E << 8 | C;", "return (g << 16 | E << 8 | C) || 0x01000000;");

  // Upstream accepts cursorAccent but never paints a block cursor's glyph.
  replaceOnce("  renderCellText(A, B, g) {", "  renderCellText(A, B, g, foregroundOverride) {");
  replaceOnce("this.ctx.fillStyle = this.theme.selectionForeground;", "this.ctx.fillStyle = foregroundOverride ?? this.theme.selectionForeground;");
  replaceOnce("this.ctx.fillStyle = this.rgbToCSS(M, a, h);", "this.ctx.fillStyle = foregroundOverride ?? this.rgbToCSS(M, a, h);");
  replaceOnce(`      case "block":
        this.ctx.fillRect(g, E, this.metrics.width, this.metrics.height);
        break;`, `      case "block": {
        this.ctx.fillRect(g, E, this.metrics.width, this.metrics.height);
        const cell = this.currentBuffer?.getLine(B)?.[A];
        if (cell) this.renderCellText(cell, A, B, this.theme.cursorAccent);
        break;
      }`);
  return code;
}

/** @returns {import("vite").Plugin} */
export function ghosttyAppearancePlugin() {
  return {
    name: "ghostty-terminal-appearance",
    enforce: "pre",
    transform(source, id) {
      if (!id.replaceAll("\\", "/").split("?")[0]?.endsWith("/ghostty-web/dist/ghostty-web.js")) return null;
      return { code: adaptGhosttyAppearance(source), map: null };
    },
  };
}
