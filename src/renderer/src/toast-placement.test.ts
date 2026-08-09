/// <reference types="node" />
// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererEntry = readFileSync(new URL("./main.tsx", import.meta.url), "utf8");

describe("global toast placement", () => {
  it("anchors every application toast at the bottom center", () => {
    expect(rendererEntry).toContain('<Toast.Provider placement="bottom" maxVisibleToasts={4} />');
    expect(rendererEntry).not.toContain('placement="bottom end"');
  });
});
