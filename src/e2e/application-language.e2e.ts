import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import { cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const cleanupTimeout = 5_000;

test("application follows system language and preserves explicit changes across windows and restart", { timeout: 60_000 }, async () => {
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
      "--preferred-system-languages=de-DE,fr-CA,es-MX",
    ],
    cwd: repositoryRoot,
    bypassCSP: false,
  });

  try {
    application = await launch();
    const page = await application.firstWindow();
    await dismissConnectionPicker(page);
    await page.locator("html[lang=fr]").waitFor();
    await page.getByText("Console opérateur", { exact: true }).waitFor();
    await openSettings(page, "Menu de l’application, hors connexion", "Paramètres");
    await page.getByRole("button", { name: "Options de la nouvelle fenêtre" }).click();
    const [secondWindow] = await Promise.all([
      application.waitForEvent("window"),
      page.getByRole("menuitem", { name: "Autre serveur" }).click(),
    ]);
    await dismissConnectionPicker(secondWindow);
    await secondWindow.locator("html[lang=fr]").waitFor();
    await page.getByRole("button", { name: /Langue de l’application/u }).click();
    assert.deepEqual(await page.getByRole("option").allTextContents(),
      ["Langue du système", "English", "Español", "Français", "日本語", "Українська"]);
    assert.equal(await page.getByRole("option", { name: "Langue du système" }).getAttribute("aria-selected"), "true");
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
    await secondWindow.getByRole("button", { name: /コマンドパレット/u }).click();
    const palette = secondWindow.getByRole("dialog", { name: /コマンドパレット/u });
    await palette.getByRole("searchbox", { name: /検索/u }).fill("表示言語");
    await palette.getByRole("menuitem", { name: /^設定/u }).click();
    await expectLanguage(secondWindow, "ja", "設定");
    await secondWindow.getByRole("button", { name: /表示言語/u }).click();
    await secondWindow.getByRole("option", { name: "English" }).click();
    await expectLanguage(secondWindow, "en", "Settings");
    await expectLanguage(page, "en", "Settings");
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls), 0);

    await cleanupOwnedApplication(application, "language restart", cleanupTimeout);
    application = await launch();
    const reopened = await application.firstWindow();
    await dismissConnectionPicker(reopened);
    await openSettings(reopened, "Application menu, offline", "Settings");
    await expectLanguage(reopened, "en", "Settings");
    await reopened.getByRole("button", { name: /Application language/u }).click();
    assert.equal(await reopened.getByRole("option", { name: "English" }).getAttribute("aria-selected"), "true");
    await reopened.getByRole("option", { name: "System language" }).click();
    await expectLanguage(reopened, "fr", "Paramètres");
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
