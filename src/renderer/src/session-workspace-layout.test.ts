/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("Session workspace sticky summary layout", () => {
  it("lets the embedded workspace fill its scroll pane", () => {
    expect(styles).toMatch(
      /\.app-content:has\(>\s*\.session-workspace\[data-presentation="embedded"\]\)\s*\{[^}]*padding:\s*0\s+0\s+5rem;/s,
    );
    expect(styles).toMatch(
      /\.app-content:has\(>\s*\.session-workspace\[data-presentation="embedded"\]\)\s*>\s*\.session-workspace\[data-presentation="embedded"\]\s*\{[^}]*max-width:\s*none;/s,
    );
  });

  it("pins the session chrome above scrolling panel content", () => {
    expect(styles).toMatch(
      /\.session-workspace\[data-presentation="embedded"\]\s+\.session-workspace__sticky\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*z-index:\s*[1-9]\d*;/s,
    );
  });

  it("expands and squares the summary only while stuck", () => {
    expect(styles).toMatch(
      /\[data-stuck="true"\]\s+\.session-workspace__summary-frame\s*\{[^}]*max-width:\s*none;[^}]*padding-inline:\s*0;/s,
    );
    expect(styles).toMatch(
      /\[data-stuck="true"\]\s+\.session-workspace__summary\s*\{[^}]*border-radius:\s*0;/s,
    );
  });

  it("reveals the scroll shadow when the chrome sticks", () => {
    expect(styles).toMatch(
      /\.session-workspace__sticky\[data-stuck="true"\]::after\s*\{[^}]*opacity:\s*1;/s,
    );
  });
});
