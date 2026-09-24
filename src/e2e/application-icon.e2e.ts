import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { ApplicationIcon } from "../shared/application-settings-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS = 5_000;

test("app icon settings apply, follow system appearance and survive restart", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-icons-"));
  const userData = join(root, "user-data");
  const artifacts = join(repositoryRoot, "artifacts", "app-icons");
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  let testFailed = false;
  let testFailure: unknown;
  const launch = () => electron.launch({
    args: [
      "--enable-sandbox",
      join(repositoryRoot, ".e2e-dist/src/e2e/application-icon-main.js"),
      `--repository-root=${repositoryRoot}`,
      `--saved-config-directory=${join(root, "saved")}`,
      `--managed-config-directory=${join(root, "managed")}`,
      `--user-data-directory=${userData}`,
      `--console-client-root-directory=${join(root, "client")}`,
    ],
    cwd: repositoryRoot,
    bypassCSP: false,
  });
  try {
    application = await launch();
    let page = await application.firstWindow();
    await openSettings(page);
    await chooseIcon(page, "light");
    await assertNativeIcon(application, "icon1a-light.png");
    await page.screenshot({ path: join(artifacts, "sidebar-light-icon.png"), animations: "disabled" });
    await chooseIcon(page, "dark");
    await assertNativeIcon(application, "icon1a-dark.png");
    await page.screenshot({ path: join(artifacts, "sidebar-dark-icon.png"), animations: "disabled" });
    await chooseIcon(page, "passion");
    await assertNativeIcon(application, "passion.png");

    // This changes only the app's theme, never the computer's appearance.
    await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: "Light" }).click();
    await page.locator("html.light").waitFor();
    await waitForTheme(page, "light");
    await assertNativeIcon(application, "passion.png");
    await page.screenshot({ path: join(artifacts, "settings-light.png"), animations: "disabled" });

    if (process.platform === "darwin") {
      // Simulate native notifications inside this isolated Electron process.
      // The Dock API remains real; the user's OS settings are never modified.
      await setMacSystemAppearance(application, true);
      await chooseIcon(page, "auto");
      await assertNativeIcon(application, "icon1a-dark.png");
      await setMacSystemAppearance(application, false);
      await assertNativeIcon(application, "icon1a-light.png");
      await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: "Dark" }).click();
      await page.locator("html.dark").waitFor();
      await waitForTheme(page, "dark");
      await assertNativeIcon(application, "icon1a-light.png");
    }

    await chooseIcon(page, "passion");
    await page.screenshot({ path: join(artifacts, "settings-dark.png"), animations: "disabled" });
    const persisted = JSON.parse(await readFile(join(root, "client", "gui", "application-settings.json"), "utf8"));
    assert.equal(persisted.appIcon, "passion");
    await cleanupOwnedApplication(application, "application icon restart", APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS);
    application = undefined;
    application = await launch();
    page = await application.firstWindow();
    await openSettings(page);
    await assertNativeIcon(application, "passion.png");
    assert.equal(await page.getByRole("radiogroup", { name: "App icon" })
      .getByRole("radio", { name: "Passion" }).getAttribute("aria-checked"), "true");
    await chooseIcon(page, "light");
    await assertNativeIcon(application, "icon1a-light.png");
    const connections = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls);
    assert.equal(connections, 0, "icon smoke must never connect to an operator server");
  } catch (error) {
    testFailed = true;
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(
        application,
        "application icon",
        APPLICATION_CLEANUP_SETTLE_TIMEOUT_MS,
      ).catch((error) => cleanupFailures.push(error));
    }
    await rm(root, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Application icon E2E cleanup failed");
      if (testFailed) {
        attachCleanupFailure(testFailure, cleanupError);
        console.error("Failed to clean application icon E2E resources", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
});

async function openSettings(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
  await savedConfigurations.waitFor();
  await page.keyboard.press("Escape");
  await savedConfigurations.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Application menu, offline" }).click();
  const applicationMenu = page.locator(
    '[role="menu"][aria-label="Application and current server actions"]',
  );
  await applicationMenu.waitFor();
  await applicationMenu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await applicationMenu.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
}

async function waitForTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.waitForFunction(async (expected) => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return (await api.getApplicationSettings()).theme === expected;
  }, theme);
  const label = theme === "light" ? "Light" : "Dark";
  await page.getByRole("radiogroup", { name: "Color theme" })
    .getByRole("radio", { name: label, checked: true, disabled: false }).waitFor();
}

async function chooseIcon(page: Page, value: ApplicationIcon): Promise<void> {
  const label = value[0]!.toUpperCase() + value.slice(1);
  await page.getByRole("radiogroup", { name: "App icon" }).getByRole("radio", { name: label, exact: true }).click();
  await page.waitForFunction(async (expected) => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return (await api.getApplicationSettings()).appIcon === expected;
  }, value);
}

async function assertNativeIcon(application: ElectronApplication, name: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let actualName = "";
  while (Date.now() < deadline) {
    const paths = await application.evaluate(() => (globalThis as unknown as { iconPaths: string[] }).iconPaths);
    actualName = basename(paths.at(-1) ?? "");
    if (actualName === name) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(actualName, name);
  const page = await application.firstWindow();
  await page.waitForFunction((expected) => {
    const document = (globalThis as unknown as {
      document: { querySelectorAll(selector: string): ArrayLike<{
        currentSrc: string;
        src: string;
        complete: boolean;
        naturalWidth: number;
        naturalHeight: number;
      }> };
    }).document;
    const icons = Array.from(document.querySelectorAll(".brand-mark__image"));
    return icons.length > 0 && icons.every((icon) => {
      const fileName = new URL(icon.currentSrc || icon.src).pathname.split("/").at(-1) ?? "";
      return fileName.startsWith(expected.stem) && icon.complete &&
        icon.naturalWidth === expected.width && icon.naturalHeight === expected.height;
    });
  }, {
    stem: name.slice(0, -4),
    width: name === "passion.png" ? 618 : 1514,
    height: name === "passion.png" ? 417 : 1514,
  });
}

async function setMacSystemAppearance(application: ElectronApplication, dark: boolean): Promise<void> {
  await application.evaluate(({ nativeTheme, systemPreferences }, nextDark) => {
    const original = systemPreferences.getUserDefault.bind(systemPreferences);
    systemPreferences.getUserDefault = ((key: string, type: "string") => key === "AppleInterfaceStyle"
      ? nextDark ? "Dark" : ""
      : original(key, type)) as typeof systemPreferences.getUserDefault;
    nativeTheme.emit("updated");
  }, dark);
}
