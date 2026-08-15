// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
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
    expect(workflow).toContain(
      "DEBUG: ${{ runner.os == 'Windows' && 'pw:browser' || '' }}",
    );
    expect(workflow).not.toContain("npm run dist --");
  });

  it("routes workflow verifier flags directly to their Node scripts", () => {
    const rootDir = resolve(import.meta.dirname, "../..");
    const packageJson = JSON.parse(
      readFileSync(resolve(rootDir, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const verifierScripts = Object.entries(packageJson.scripts ?? {})
      .filter(([name, command]) => name.startsWith("verify:") && command.startsWith("node ./scripts/"))
      .map(([name]) => name);
    const workflowsDirectory = resolve(rootDir, ".github/workflows");

    for (const workflowName of readdirSync(workflowsDirectory).filter((name) => /\.ya?ml$/u.test(name))) {
      const workflow = readFileSync(resolve(workflowsDirectory, workflowName), "utf8");
      for (const scriptName of verifierScripts) {
        expect(workflow, `${workflowName} must invoke ${scriptName} directly when passing flags`).not.toMatch(
          new RegExp(`npm\\s+run\\s+${escapeRegularExpression(scriptName)}\\s+--`, "u"),
        );
      }
    }

    const releaseWorkflow = readFileSync(resolve(workflowsDirectory, "build-and-release.yml"), "utf8");
    const privateUpdaterWorkflow = readFileSync(resolve(workflowsDirectory, "private-updater-e2e.yml"), "utf8");
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyReleaseVersion\.mjs/gu)).toHaveLength(3);
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyReleaseSigningEnvironment\.mjs/gu)).toHaveLength(2);
    expect(releaseWorkflow.match(/node \.\/scripts\/verifyUpdateArtifacts\.mjs/gu)).toHaveLength(4);
    expect(privateUpdaterWorkflow.match(/node \.\/scripts\/verifyUpdateArtifacts\.mjs/gu)).toHaveLength(6);
  });
});

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
