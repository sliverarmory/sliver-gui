// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("secure development runtime", () => {
  it("launches a production-built renderer without a Vite dev server or HMR", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const developmentCommand = packageJson.scripts?.["dev"];

    expect(developmentCommand).toContain("npm run build");
    expect(developmentCommand).toContain("electron-vite preview --skipBuild");
    expect(developmentCommand).not.toMatch(/electron-vite\s+dev/);
  });
});
