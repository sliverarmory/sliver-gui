import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("Report Screenshot captures every open app window into the configured directory", {
  timeout: 60_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-report-screenshot-"));
  await Promise.all(["saved", "managed", "client", "user-data", "reports"]
    .map((name) => mkdir(join(root, name))));
  const reportDirectory = join(root, "reports");
  let application: ElectronApplication | undefined;
  let testFailure: unknown;
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/application-icon-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`,
        `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`,
      ],
      cwd: repositoryRoot,
      bypassCSP: false,
      timeout: 20_000,
    });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => { ownedProcess.kill("SIGKILL"); }, { once: true });

    const page = await application.firstWindow();
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await dismissSavedConfigurations(page);

    const update = await page.evaluate(async (directory) => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const current = await api.getApplicationSettings();
      return api.updateApplicationSettings({
        expectedRevision: current.revision,
        settings: {
          theme: current.theme,
          appIcon: current.appIcon,
          reduceMotion: current.reduceMotion,
          disableWindowTransparency: current.disableWindowTransparency,
          reportScreenshotDirectory: directory,
          commandPaletteShortcut: current.commandPaletteShortcut,
          keyboardShortcuts: current.keyboardShortcuts,
          terminal: current.terminal,
          overview: current.overview,
        },
      });
    }, reportDirectory);
    assert.equal(update.ok, true, update.error ?? "Could not configure report screenshot directory");

    const menuItem = await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("view.report-screenshot");
      return { label: item?.label, accelerator: item?.accelerator };
    });
    assert.deepEqual(menuItem, { label: "Report Screenshot", accelerator: "CmdOrCtrl+Alt+S" });

    const opened = application.waitForEvent("window", { timeout: 5_000 });
    const openResult = await page.evaluate(async () =>
      (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.openWindow({ inheritConnection: false }));
    assert.equal(openResult.ok, true, openResult.error ?? "Could not open a second application window");
    const secondPage = await opened;
    secondPage.setDefaultTimeout(5_000);
    await secondPage.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 2);

    await page.locator('button[aria-label="Open command palette"]').click();
    await page.getByRole("menuitem", { name: /^Report Screenshot/u }).click();
    await page.getByText("Report screenshots saved", { exact: true }).waitFor();

    const files = await waitForReportFiles(reportDirectory, 2);
    assert.equal(files.length, 2);
    assert.equal((await readdir(reportDirectory)).length, 2, "the report directory should contain only final PNGs");
    const screenshots: Buffer[] = [];
    for (const name of files) {
      assert.match(name, /^sliver-report-[\w-]+-window-[12]\.png$/u);
      const path = join(reportDirectory, name);
      const png = await readFile(path);
      screenshots.push(png);
      assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      assert.equal(png.toString("ascii", 12, 16), "IHDR");
      assert.ok(png.readUInt32BE(16) > 0 && png.readUInt32BE(20) > 0, "captured image has nonzero dimensions");
      if (process.platform !== "win32") assert.equal((await lstat(path)).mode & 0o777, 0o600);
    }
    assert.notDeepEqual(screenshots[0], screenshots[1], "the two windows should produce different screenshots");
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const failures: unknown[] = [];
    if (application) await cleanupOwnedApplication(application, "report screenshot", 5_000)
      .catch((error) => failures.push(error));
    await rm(root, { recursive: true, force: true }).catch((error) => failures.push(error));
    if (failures.length > 0) {
      const failure = new AggregateError(failures, "Report Screenshot E2E cleanup failed");
      if (testFailure) {
        attachCleanupFailure(testFailure, failure);
        console.error(failure);
      } else throw failure;
    }
  }
});

async function dismissSavedConfigurations(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}

async function waitForReportFiles(directory: string, expected: number): Promise<string[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const files = (await readdir(directory)).filter((name) => name.endsWith(".png"));
    if (files.length === expected) return files;
    await delay(25);
  }
  throw new Error(`Expected ${expected} report screenshots in ${directory}`);
}
