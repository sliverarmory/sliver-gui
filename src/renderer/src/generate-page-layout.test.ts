/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("Generate page sticky footer layout", () => {
  it("gives Generate a dedicated scroll region above a persistent footer", () => {
    expect(styles).toMatch(
      /\.app-content\.app-content--generate\s*\{[^}]*overflow:\s*hidden;[^}]*padding:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.generate-page\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto;/s,
    );
    expect(styles).toMatch(
      /\.generate-page__content\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.generate-page__footer\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/s,
    );
  });
});
