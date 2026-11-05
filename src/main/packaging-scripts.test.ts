// @vitest-environment node

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { readWorkflow, repositoryRoot, workflowStep } from "../tests/workflow-fixtures.js";

const release = readWorkflow("build-and-release.yml");
const updater = readWorkflow("private-updater-e2e.yml");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("native distribution wiring", () => {
  it("stages native dependencies with the Electron runtime and forwards builder arguments", () => {
    expect(parse(readFileSync(resolve(repositoryRoot, "electron-builder.yml"), "utf8"))).toMatchObject({
      npmRebuild: false,
      beforePack: "scripts/stageNodePtyForElectron.mjs",
    });
    expect(packageJson.scripts["predist"]?.split(/\s*&&\s*/u)).toEqual([
      "npm run build:rdp", "npm run build:licenses", "npm run prepare:node-pty", "npm run build:console",
      "npm run build", "npm run verify:release-content",
    ]);
    expect(packageJson.scripts["dist"]).toBe("electron-builder");
    expect(packageJson.scripts["postdist"]).toBe("npm run verify:packaged-content");
    expect(packageJson.scripts["pretest:e2e:packaged-update"]).toBeUndefined();
    const commands = release.jobs["build"]!.steps!.flatMap(({ run }) => run ? [run] : []);
    const prepare = commands.indexOf("npm run predist");
    const build = commands.indexOf("node ./node_modules/electron-builder/cli.js ${{ matrix.build_args }} --publish never");
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(prepare);
    expect(commands.indexOf("npm run postdist")).toBeGreaterThan(build);
    expect(workflowStep(release, "Exercise packaged mTLS application")).toMatchObject({ "timeout-minutes": 10 });
  });

  it("requires successful application E2E before publishing", () => {
    expect(release.jobs["release"]!.needs).toEqual(expect.arrayContaining(["application-e2e", "build", "release-request"]));
    expect(release.jobs["release"]!.if).not.toMatch(/\b(?:always|failure|cancelled)\s*\(/u);
  });

  it("passes verifier flags to Node instead of through npm argument parsing", () => {
    const names = Object.entries(packageJson.scripts)
      .filter(([name, command]) => name.startsWith("verify:") && command.startsWith("node ./scripts/"))
      .map(([name]) => name);
    for (const file of readdirSync(resolve(repositoryRoot, ".github/workflows")).filter((name) => /\.ya?ml$/u.test(name))) {
      for (const job of Object.values(readWorkflow(file).jobs)) {
        for (const step of job.steps ?? []) {
          for (const name of names) {
            expect(step.run ?? "", `${file}: ${step.name ?? "unnamed"}`).not.toMatch(new RegExp(`npm\\s+run\\s+${name}\\s+--`, "u"));
          }
        }
      }
    }
  });

  it("bounds trust setup and always schedules teardown on its matching platform", () => {
    for (const [setup, cleanup, platform, shell] of [
      ["Generate one ephemeral self-signed macOS identity", "Remove ephemeral private signing material", "macOS", "bash"],
      ["Trust the ephemeral macOS public certificate", "Remove ephemeral macOS trust", "macOS", "bash"],
      ["Generate one ephemeral self-signed Windows identity", "Remove ephemeral Windows private signing material", "Windows", "pwsh"],
      ["Trust the ephemeral Windows public certificate", "Remove ephemeral Windows trust", "Windows", "pwsh"],
    ] as const) {
      expect(workflowStep(updater, setup)).toMatchObject({ shell, if: `runner.os == '${platform}'`, "timeout-minutes": 10 });
      expect(workflowStep(updater, cleanup)).toMatchObject({ shell, if: `always() && runner.os == '${platform}'` });
      if (platform === "macOS") expect(workflowStep(updater, cleanup)["timeout-minutes"]).toBe(2);
    }
    expect(updater.jobs["cleanup"]).toMatchObject({
      needs: ["prepare", "build", "publish", "native_update"],
      if: "always() && needs.prepare.result == 'success'",
    });
    expect(workflowStep(updater, "Verify credential-free release context").env).not.toHaveProperty("GH_TOKEN");
  });
});
