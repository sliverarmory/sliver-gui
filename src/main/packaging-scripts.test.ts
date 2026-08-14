// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("native distribution packaging", () => {
  it("routes CI platform and publish arguments directly to electron-builder", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const workflow = readFileSync(
      resolve(rootDir, ".github/workflows/build-and-release.yml"),
      "utf8",
    );

    expect(packageJson.scripts?.["predist"]).toBe(
      "npm run build:licenses && npm run build && npm run verify:release-content",
    );
    expect(packageJson.scripts?.["dist"]).toBe("electron-builder");
    expect(packageJson.scripts?.["postdist"]).toBe("npm run verify:packaged-content");
    expect(workflow).toContain("run: npm run predist");
    expect(workflow).toContain(
      "run: node ./node_modules/electron-builder/cli.js ${{ matrix.build_args }} --publish never",
    );
    expect(workflow).toContain("run: npm run postdist");
    expect(workflow).not.toContain("npm run dist --");
  });
});
