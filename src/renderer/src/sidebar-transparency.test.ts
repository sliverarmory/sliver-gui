/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("sidebar glass styles", () => {
  it("uses a translucent neutral surface with a frosted glass treatment", () => {
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\s*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--color-surface\) 22%, transparent\);/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\s*\{[^}]*backdrop-filter:\s*blur\(28px\) saturate\(135%\);/s,
    );
    expect(styles).toMatch(/inset -1px 0 0 color-mix\(in srgb, white 8%, transparent\)/);
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\s*>\s*\.sidebar__header,[^{]+\{\s*background:\s*transparent;/s,
    );
    expect(styles).toMatch(
      /\.app-sidebar \.connection-summary\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-surface-secondary\) 32%, transparent\);/s,
    );
    expect(styles).toMatch(
      /\.app-sidebar \.sidebar__menu-item\[data-current="true"\] \.sidebar__menu-item-content\s*\{[^}]*background-color:\s*color-mix\(in srgb, var\(--color-surface\) 46%, transparent\);/s,
    );
  });

  it("uses a stronger translucent treatment for the mobile drawer", () => {
    expect(styles).toMatch(
      /\.sidebar__mobile\.app-sidebar\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--color-surface\) 28%, transparent\);/s,
    );
    expect(styles).toMatch(
      /\.sidebar__mobile-dialog:has\(>\s*\.sidebar__mobile\.app-sidebar\)\s*\{[^}]*backdrop-filter:\s*blur\(28px\) saturate\(135%\);/s,
    );
  });

  it("keeps the desktop brand header draggable and collapsed disabled items tooltip-capable", () => {
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\s*>\s*\.brand-block\s*\{[^}]*-webkit-app-region:\s*drag;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\[data-state="collapsed"\]\s+\.sidebar__menu-item\[aria-disabled="true"\]\s*\{[^}]*pointer-events:\s*auto;/s,
    );
    expect(styles).toMatch(
      /button,\s*input,\s*textarea,\s*select\s*\{[^}]*-webkit-app-region:\s*no-drag;/s,
    );
    expect(styles).toMatch(
      /\.sidebar\.app-sidebar\[data-state="collapsed"\]\s+\.connection-summary--trigger\s*\{[^}]*justify-content:\s*center;[^}]*gap:\s*0;[^}]*padding-inline:\s*0;/s,
    );
  });
});
