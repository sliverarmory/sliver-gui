import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { supportsWindowsAcrylic } from "../main/window-options.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const CLEANUP_TIMEOUT_MS = 5_000;

test("window transparency is enabled by default and its global switch applies and survives restart", { timeout: 60_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-transparency-"));
  const artifacts = join(repositoryRoot, "artifacts", "window-transparency");
  const persistedPath = join(root, "client", "gui", "application-settings.json");
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  let failure: unknown;
  const abort = () => { application?.process().kill("SIGKILL"); };
  context.signal.addEventListener("abort", abort, { once: true });
  const launch = () => electron.launch({
    args: [
      "--enable-sandbox",
      join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
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
  try {
    application = await launch();
    let page = await application.firstWindow();
    await openSettings(page);
    const toggle = page.getByRole("switch", { name: "Disable window transparency", exact: true });
    assert.equal(await toggle.isChecked(), false);
    await assertSetting(page, false);
    await assertNativeBackground(application, false);

    await page.getByText("Disable window transparency", { exact: true }).click();
    await assertSetting(page, true);
    assert.equal(await toggle.isChecked(), true);
    await assertNativeBackground(application, true);
    for (const theme of ["light", "dark"] as const) {
      const label = theme === "light" ? "Light" : "Dark";
      await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: label, exact: true }).click();
      await page.locator(`html.${theme}`).waitFor();
      await page.waitForFunction(async (expected) => {
        const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
        return (await api.getApplicationSettings()).theme === expected;
      }, theme);
      await assertNativeBackground(application, true);
      await page.screenshot({ path: join(artifacts, `settings-opaque-${theme}.png`), animations: "disabled" });
    }
    const persisted = JSON.parse(await readFile(persistedPath, "utf8"));
    assert.equal(persisted.disableWindowTransparency, true);
    assert.equal(persisted.terminal.transparentWindows, true, "global switch must preserve the terminal preference");

    await cleanupOwnedApplication(application, "window transparency restart", CLEANUP_TIMEOUT_MS);
    application = undefined;
    application = await launch();
    page = await application.firstWindow();
    await openSettings(page);
    await assertSetting(page, true);
    assert.equal(await page.getByRole("switch", { name: "Disable window transparency", exact: true }).isChecked(), true);
    await assertNativeBackground(application, true);

    await page.getByText("Disable window transparency", { exact: true }).click();
    await assertSetting(page, false);
    await assertNativeBackground(application, false);
    assert.equal(JSON.parse(await readFile(persistedPath, "utf8")).disableWindowTransparency, false);
    const connections = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls);
    assert.equal(connections, 0, "appearance smoke must never connect to an operator server");
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    context.signal.removeEventListener("abort", abort);
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "window transparency", CLEANUP_TIMEOUT_MS)
        .catch((error) => cleanupFailures.push(error));
    }
    await rm(root, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Window transparency E2E cleanup failed");
      if (failure) {
        attachCleanupFailure(failure, cleanupError);
        console.error("Failed to clean window transparency E2E resources", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
});

async function openSettings(page: Page): Promise<void> {
  page.setDefaultTimeout(10_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
  await savedConfigurations.waitFor();
  await page.keyboard.press("Escape");
  await savedConfigurations.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Application menu, offline" }).click();
  const menu = page.locator('[role="menu"][aria-label="Application and current server actions"]');
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await page.getByRole("switch", { name: "Disable window transparency", exact: true }).waitFor();
}

async function assertSetting(page: Page, disabled: boolean): Promise<void> {
  await page.waitForFunction(async (expected) => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return (await api.getApplicationSettings()).disableWindowTransparency === expected;
  }, disabled);
  await page.getByRole("switch", { name: "Disable window transparency", exact: true, checked: disabled, disabled: false }).waitFor();
}

async function assertNativeBackground(application: ElectronApplication, disabled: boolean): Promise<void> {
  const state = await application.evaluate(({ BrowserWindow, nativeTheme }) => ({
    background: BrowserWindow.getAllWindows()[0]?.getBackgroundColor().toLowerCase(),
    dark: nativeTheme.shouldUseDarkColors,
  }));
  if (disabled || (process.platform !== "darwin" && !supportsWindowsAcrylic())) {
    assert.equal(state.background, state.dark ? "#09090b" : "#fafafa");
  } else {
    assert.match(state.background ?? "", /^#0{6}(?:00)?$/u,
      "enabled native glass must have a transparent client background");
  }
}
