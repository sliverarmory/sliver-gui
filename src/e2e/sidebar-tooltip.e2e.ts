import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright-core";

import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

test("collapsed sidebar shows a disabled navigation label on hover", { timeout: 45_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-sidebar-tooltip-"));
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) =>
    mkdir(join(temporaryRoot, name))));
  let application: ElectronApplication | undefined;
  let testFailure: unknown;
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/application-icon-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`,
        `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${join(temporaryRoot, "client")}`,
      ],
      cwd: repositoryRoot,
      bypassCSP: false,
      timeout: 20_000,
    });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => { ownedProcess.kill("SIGKILL"); }, { once: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(8_000);
    const configurations = page.getByRole("dialog", { name: "Saved configurations" });
    await configurations.waitFor();
    await page.keyboard.press("Escape");
    await configurations.waitFor({ state: "hidden" });
    const windowNavigation = page.getByRole("navigation", { name: "Window navigation" });
    await windowNavigation.getByRole("button", { name: "Collapse sidebar" }).click();
    await windowNavigation.getByRole("button", { name: "Expand sidebar" }).waitFor();
    await page.locator('.app-shell[data-state="collapsed"]').waitFor();

    const generate = page.getByRole("row", { name: "Generate" });
    assert.equal(await generate.getAttribute("aria-disabled"), "true");
    const trigger = generate.locator("[data-slot=tooltip-trigger]");
    assert.equal(await trigger.count(), 1);
    await trigger.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await tooltip.innerText(), /Generate/u);
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "sidebar tooltip", 5_000)
        .catch((error) => cleanupFailures.push(error));
    }
    await rm(temporaryRoot, { recursive: true, force: true })
      .catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Sidebar tooltip E2E cleanup failed");
      if (testFailure) attachCleanupFailure(testFailure, cleanupError);
      else throw cleanupError;
    }
  }
});
