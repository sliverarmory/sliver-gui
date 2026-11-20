import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cleanupTimeout = 5_000;

test("application language updates open windows and survives restart", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-language-"));
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  let application: ElectronApplication | undefined;
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
  });

  try {
    application = await launch();
    const page = await application.firstWindow();
    await dismissConnectionPicker(page);
    await page.getByRole("button", { name: "New window options" }).click();
    const [secondWindow] = await Promise.all([
      application.waitForEvent("window"),
      page.getByRole("menuitem", { name: "Different server" }).click(),
    ]);
    await dismissConnectionPicker(secondWindow);
    await openSettings(page, "Application menu, offline", "Settings");
    await page.getByRole("button", { name: /Application language/u }).click();
    assert.deepEqual(await page.getByRole("option").allTextContents(),
      ["English", "Español", "Français", "日本語", "Українська"]);
    await page.getByRole("option", { name: "Español" }).click();
    const locales = [
      { language: "es", heading: "Configuración", selector: /Idioma de la aplicación/u, next: "Français" },
      { language: "fr", heading: "Paramètres", selector: /Langue de l’application/u, next: "Українська" },
      { language: "uk", heading: "Налаштування", selector: /Мова інтерфейсу/u, next: "日本語" },
    ];
    for (const { language, heading, selector, next } of locales) {
      await expectLanguage(page, language, heading);
      await secondWindow.locator(`html[lang=${language}]`).waitFor();
      await page.getByRole("button", { name: selector }).click();
      await page.getByRole("option", { name: next }).click();
    }
    await expectLanguage(page, "ja", "設定");
    await secondWindow.locator("html[lang=ja]").waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls), 0);

    await cleanupOwnedApplication(application, "language restart", cleanupTimeout);
    application = await launch();
    const reopened = await application.firstWindow();
    await dismissConnectionPicker(reopened);
    await reopened.locator("html[lang=ja]").waitFor();
    await reopened.getByRole("button", { name: /コマンドパレット/u }).click();
    const palette = reopened.getByRole("dialog", { name: /コマンドパレット/u });
    await palette.getByRole("searchbox", { name: /検索/u }).fill("表示言語");
    await palette.getByRole("menuitem", { name: /^設定/u }).click();
    await reopened.getByRole("heading", { name: "設定", exact: true }).waitFor();
    await reopened.getByRole("button", { name: /表示言語/u }).click();
    await reopened.getByRole("option", { name: "English" }).click();
    await expectLanguage(reopened, "en", "Settings");
  } finally {
    try {
      if (application) await cleanupOwnedApplication(application, "application language", cleanupTimeout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function dismissConnectionPicker(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const picker = page.getByRole("dialog", { name: "Saved configurations" });
  await picker.waitFor();
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
}

async function openSettings(page: Page, menu: string, heading: string): Promise<void> {
  await page.getByRole("button", { name: menu }).click();
  await page.getByRole("menuitem", { name: heading, exact: true }).click();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}

async function expectLanguage(page: Page, language: string, heading: string): Promise<void> {
  await page.locator(`html[lang=${language}]`).waitFor();
  await page.getByRole("heading", { name: heading, exact: true }).waitFor();
}
