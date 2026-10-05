import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright-core";

import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const screenshotPath = join(repositoryRoot, "artifacts", "e2e", "windows-native-glass.png");

test("Windows workspace displays native menus and theme-matched caption color", {
  skip: process.platform !== "win32",
  timeout: 60_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-windows-menu-"));
  let application: ElectronApplication | undefined;
  let testFailure: unknown;
  try {
    await Promise.all(["saved", "managed", "client", "user-data"]
      .map((name) => mkdir(join(root, name))));
    application = await electron.launch({
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
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => {
      if (ownedProcess.exitCode === null && ownedProcess.signalCode === null) {
        ownedProcess.kill("SIGKILL");
      }
    }, { once: true });

    const page = await application.firstWindow();
    const configurations = page.getByRole("dialog", { name: "Saved configurations" });
    await configurations.waitFor();
    const menuItems = await application.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()?.items.map((item) => ({
        label: item.label,
        hasSubmenu: (item.submenu?.items.length ?? 0) > 0,
      })) ?? []);
    for (const label of ["File", "Edit"]) {
      assert.ok(menuItems.some((item) => item.label === label && item.hasSubmenu),
        `the installed application menu must contain ${label} with actions`);
    }

    const window = await application.browserWindow(page);
    const nativeChrome = await window.evaluate((mainWindow) => ({
      visible: mainWindow.isVisible(),
      menuBarVisible: mainWindow.isMenuBarVisible(),
      menuBarAutoHide: mainWindow.isMenuBarAutoHide(),
      topInset: mainWindow.getContentBounds().y - mainWindow.getBounds().y,
    }));
    assert.equal(nativeChrome.visible, true, "the workspace window must be shown");
    assert.equal(nativeChrome.menuBarVisible, true, "the native menu bar must be visible");
    assert.equal(nativeChrome.menuBarAutoHide, false, "the native menu bar must remain visible without Alt");
    assert.ok(nativeChrome.topInset > 0,
      `native title and menu chrome must sit above the renderer (top inset: ${nativeChrome.topInset})`);

    // The sidebar must leave alpha for the Windows acrylic backdrop to show through.
    const sidebarBackground = await page.evaluate(() => {
      const browser = globalThis as unknown as {
        document: {
          querySelector(selector: string): object | null;
          createElement(tag: "canvas"): {
            width: number;
            height: number;
            getContext(type: "2d"): {
              fillStyle: string;
              fillRect(x: number, y: number, width: number, height: number): void;
              getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray };
            } | null;
          };
        };
        getComputedStyle(element: object): { backgroundColor: string };
      };
      const sidebar = browser.document.querySelector(".sidebar.app-sidebar");
      if (!sidebar) throw new Error("Expected the workspace sidebar");
      const color = browser.getComputedStyle(sidebar).backgroundColor;
      const canvas = browser.document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Could not measure the sidebar background alpha");
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return { color, alpha: context.getImageData(0, 0, 1, 1).data[3]! / 255 };
    });
    assert.ok(sidebarBackground.alpha < 1,
      `the sidebar background must be translucent for acrylic (computed: ${sidebarBackground.color})`);

    await page.keyboard.press("Escape");
    await configurations.waitFor({ state: "hidden" });
    await mkdir(join(repositoryRoot, "artifacts", "e2e"), { recursive: true });
    await page.screenshot({ path: screenshotPath, animations: "disabled" });

    await page.getByRole("button", { name: "Application menu, offline" }).click();
    const applicationMenu = page.locator('[role="menu"][aria-label="Application and current server actions"]');
    await applicationMenu.waitFor();
    await applicationMenu.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();

    for (const { label, theme, captionColor } of [
      { label: "Dark", theme: "dark", captionColor: "#1f1f1f" },
      { label: "Light", theme: "light", captionColor: "#ffffff" },
    ] as const) {
      await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: label }).click();
      await page.locator(`html.${theme}[data-theme='${theme}']`).waitFor();
      const deadline = Date.now() + 5_000;
      let accentColor: string | boolean = false;
      do {
        const value = await window.evaluate((mainWindow) => mainWindow.getAccentColor());
        accentColor = typeof value === "string" ? value.toLowerCase() : value;
        if (accentColor === captionColor) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      } while (Date.now() < deadline);
      assert.equal(accentColor, captionColor, `${label} mode must set the native Windows caption color`);

      const menuBar = await window.evaluate((mainWindow) => ({
        visible: mainWindow.isMenuBarVisible(),
        autoHide: mainWindow.isMenuBarAutoHide(),
      }));
      assert.deepEqual(menuBar, { visible: true, autoHide: false },
        `${label} mode must preserve the visible native menu bar`);
    }
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "Windows native menu", 5_000)
        .catch((error) => cleanupFailures.push(error));
    }
    await rm(root, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Windows native menu E2E cleanup failed");
      if (testFailure) {
        attachCleanupFailure(testFailure, cleanupError);
        console.error("Failed to clean Windows native menu E2E resources", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
});
