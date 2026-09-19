import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const artifacts = join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "sliver-gui-keyboard-shortcuts-artifacts");

test("keyboard shortcuts can be searched, recorded, persisted and reset without connecting", {
  timeout: 90_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-keyboard-shortcuts-"));
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
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
    page = await application.firstWindow();
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const windowId = await (await application.browserWindow(page)).evaluate((window) => window.id);
    await openSettings(page);
    await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: "Dark", exact: true }).click();
    await page.locator("html.dark").waitFor();
    await page.waitForFunction(async () => (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings()).theme === "dark");
    await page.getByRole("tab", { name: "Keyboard Shortcuts", exact: true }).click();
    assert.equal(await page.getByRole("tab", { name: "Command Palette", exact: true }).count(), 0);
    const shortcutSettings = page.getByRole("region", { name: "Keyboard Shortcuts", exact: true });
    await shortcutSettings.waitFor();
    for (const group of ["Application", "Navigation", "Terminal", "Terminal tabs"]) {
      await shortcutSettings.getByText(group, { exact: true }).waitFor();
    }
    const search = page.getByRole("searchbox", { name: "Search shortcuts" });
    await search.fill("terminal tab 10");
    await shortcutSettings.getByRole("group", { name: "Select terminal tab 10", exact: true }).waitFor();
    assert.equal(await shortcutSettings.getByRole("group", { name: "New window", exact: true }).count(), 0);
    await search.fill("no matching shortcut");
    await shortcutSettings.getByText("No shortcuts match your search.").waitFor();
    await search.fill("");

    // The real recorder must suppress native menu accelerators long enough to
    // report the conflict, without accidentally creating another workspace.
    await focusWindow(application, windowId);
    await recordShortcut(page, "Open command palette");
    await sendNativeChord(application, windowId, "N");
    await shortcutSettings.getByRole("alert").filter({ hasText: "already assigned to New window" }).waitFor();
    await assertStableWindowCount(application, 1);
    await page.keyboard.press("Escape");

    await focusWindow(application, windowId);
    await recordShortcut(page, "New window");
    await sendNativeChord(application, windowId, "O", true);
    await waitForNewWindowShortcut(page, "mod+shift+o");
    assert.equal(await newWindowAccelerator(application), "CmdOrCtrl+Shift+O");
    await assertStableWindowCount(application, 1);

    // Reload exercises loading the persisted settings into a new DOM.
    await page.reload();
    await openSettings(page);
    await page.getByRole("tab", { name: "Keyboard Shortcuts", exact: true }).click();
    await waitForNewWindowShortcut(page, "mod+shift+o");
    assert.equal(await newWindowAccelerator(application), "CmdOrCtrl+Shift+O");
    const persisted = JSON.parse(await readFile(join(root, "user-data", "application-settings.json"), "utf8"));
    assert.equal(persisted.keyboardShortcuts.newWindow, "mod+shift+o");
    assert.equal(persisted.theme, "dark");
    await sendNativeChord(application, windowId, "N");
    await assertStableWindowCount(application, 1);
    assert.equal(await nativeAcceleratorCount(application, "CmdOrCtrl+N"), 0);
    assert.equal(await nativeAcceleratorCount(application, "CmdOrCtrl+Shift+O"), 1);
    const opened = application.waitForEvent("window", { timeout: 5_000 });
    // Electron's synthetic webContents/CDP key events reach the recorder but
    // bypass Cocoa's native menu key equivalents. Check the actual registered
    // accelerator, then invoke its exact callback; OS keyboard dispatch is not
    // claimed by this test and requires a separate native input smoke test.
    await invokeNewWindowMenuItem(application, windowId, "CmdOrCtrl+Shift+O");
    const extraWindow = await opened;
    await extraWindow.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await assertStableWindowCount(application, 2);
    await extraWindow.close();
    await assertStableWindowCount(application, 1);

    await focusWindow(application, windowId);
    await page.getByRole("button", { name: "Reset all to defaults", exact: true }).click();
    await waitForNewWindowShortcut(page, undefined);
    assert.equal(await newWindowAccelerator(application), "CmdOrCtrl+N");
    const reset = await page.evaluate(async () => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings());
    assert.deepEqual(reset.keyboardShortcuts, {});
    assert.equal(reset.commandPaletteShortcut, "mod+k");
    assert.equal(reset.theme, "dark", "reset shortcuts must preserve appearance settings");
    assert.equal(await page.getByRole("button", { name: "Reset all to defaults", exact: true }).isDisabled(), true);
    await sendNativeChord(application, windowId, "O", true);
    await assertStableWindowCount(application, 1);
    assert.equal(await nativeAcceleratorCount(application, "CmdOrCtrl+Shift+O"), 0);
    assert.equal(await nativeAcceleratorCount(application, "CmdOrCtrl+N"), 1);
    const defaultOpened = application.waitForEvent("window", { timeout: 5_000 });
    await invokeNewWindowMenuItem(application, windowId, "CmdOrCtrl+N");
    const defaultWindow = await defaultOpened;
    await defaultWindow.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await assertStableWindowCount(application, 2);
    await defaultWindow.close();
    await assertStableWindowCount(application, 1);
    await focusWindow(application, windowId);

    await application.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.setSize(1440, 1020), windowId);
    await page.screenshot({ path: join(artifacts, "keyboard-shortcuts-desktop.png"), animations: "disabled" });
    await application.evaluate(({ BrowserWindow }, id) => {
      const window = BrowserWindow.fromId(id);
      // The production workspace minimum is 960 px. Temporarily reduce only
      // this isolated fixture window's minimum to stress the responsive layout.
      window?.setMinimumSize(800, 680);
      window?.setSize(820, 1000);
    }, windowId);
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 820);
    await page.screenshot({ path: join(artifacts, "keyboard-shortcuts-narrow.png"), animations: "disabled" });
    const overflow = await shortcutSettings.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
    assert.equal(overflow, false, "shortcut settings should fit the narrow viewport");
    const calls = await application.evaluate(() => ({
      connections: globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls,
      methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
      consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
    }));
    assert.deepEqual(calls, { connections: 0, methods: [], consoles: 0 });
    context.diagnostic(`Offline counters: ${JSON.stringify(calls)}; screenshots: ${artifacts}`);
    context.diagnostic("Native menu accelerators and exact registered callbacks verified; OS-level menu key dispatch is outside synthetic Electron input coverage.");
  } catch (error) {
    testFailure = error;
    await page?.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => undefined);
    throw error;
  } finally {
    const failures: unknown[] = [];
    if (application) await cleanupOwnedApplication(application, "keyboard shortcuts", 5_000).catch((error) => failures.push(error));
    await rm(root, { recursive: true, force: true }).catch((error) => failures.push(error));
    if (failures.length > 0) {
      const failure = new AggregateError(failures, "Keyboard shortcuts E2E cleanup failed");
      if (testFailure) {
        attachCleanupFailure(testFailure, failure);
        console.error(failure);
      } else throw failure;
    }
  }
});

async function openSettings(page: Page): Promise<void> {
  const configurations = page.getByRole("dialog", { name: "Saved configurations" });
  await configurations.waitFor();
  await page.keyboard.press("Escape");
  await configurations.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Application menu, offline", exact: true }).click();
  await page.locator('[role="menu"][aria-label="Application and current server actions"]')
    .getByRole("menuitem", { name: "Settings", exact: true }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
}

async function recordShortcut(page: Page, label: string): Promise<void> {
  await page.getByRole("button", { name: `Change shortcut for ${label}`, exact: true }).click();
  await page.getByRole("button", { name: `Cancel changing shortcut for ${label}`, exact: true }).waitFor();
}

async function waitForNewWindowShortcut(page: Page, shortcut: string | undefined): Promise<void> {
  await page.waitForFunction(async (expected) => {
    const settings = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings();
    return settings.keyboardShortcuts.newWindow === expected;
  }, shortcut);
}

async function focusWindow(application: ElectronApplication, id: number): Promise<void> {
  await application.evaluate(({ app, BrowserWindow }, windowId) => {
    const window = BrowserWindow.fromId(windowId);
    app.focus({ steal: true });
    window?.show();
    window?.focus();
    window?.webContents.focus();
  }, id);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await application.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.isFocused(), id)) return;
    await delay(25);
  }
  throw new Error("Owned shortcut window did not receive native focus");
}

async function sendNativeChord(application: ElectronApplication, id: number, key: string, shift = false): Promise<void> {
  await focusWindow(application, id);
  await application.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.fromId(input.id);
    if (!window) throw new Error("Owned shortcut window is unavailable");
    const modifiers: Array<"meta" | "control" | "shift"> = [process.platform === "darwin" ? "meta" : "control"];
    if (input.shift) modifiers.push("shift");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: input.key, modifiers });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: input.key, modifiers });
  }, { id, key, shift });
}

async function newWindowAccelerator(application: ElectronApplication): Promise<string | undefined> {
  return application.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.find((item) => item.label === "File")
    ?.submenu?.items.find((item) => item.label === "New Window")?.accelerator ?? undefined);
}

async function nativeAcceleratorCount(application: ElectronApplication, accelerator: string): Promise<number> {
  return application.evaluate(({ Menu }, expected) => {
    const pending = [...(Menu.getApplicationMenu()?.items ?? [])];
    let matches = 0;
    for (const item of pending) {
      if (item.accelerator === expected) matches += 1;
      if (item.submenu) pending.push(...item.submenu.items);
    }
    return matches;
  }, accelerator);
}

async function invokeNewWindowMenuItem(application: ElectronApplication, id: number, accelerator: string): Promise<void> {
  await application.evaluate(({ BrowserWindow, Menu }, input) => {
    const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === "File")
      ?.submenu?.items.find((entry) => entry.label === "New Window");
    const window = BrowserWindow.fromId(input.id);
    if (!item || item.accelerator !== input.accelerator || !window) throw new Error("Expected owned New Window menu callback");
    Reflect.apply(item.click, item, [item, window, { triggeredByAccelerator: true }]);
  }, { id, accelerator });
}

async function assertStableWindowCount(application: ElectronApplication, expected: number): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await delay(50);
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), expected);
  }
}
