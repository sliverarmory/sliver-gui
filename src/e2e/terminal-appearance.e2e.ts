import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { GhosttySettingsAPI } from "../shared/ghostty-settings-contracts.js";
import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import { cleanupOwnedApplication } from "./packaged-application-update-support.js";

// Uses only the injected fake console. No real server or SSH connection.
test("terminal themes, native glass toggle and Monaco config saves work under CSP", { timeout: 90_000 }, async (context) => {
  const root = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-terminal-appearance-"));
  const client = join(temporary, "client");
  const configPath = join(client, "gui", "ghostty", "config");
  const artifacts = join(root, "artifacts", "e2e", "terminal-appearance");
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  let application: ElectronApplication | undefined;
  let workspace: Page | undefined;
  let previousClipboard: string | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client/gui/ghostty/themes"].map((name) => mkdir(join(temporary, name), { recursive: true })));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(client, "armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporary, "saved", "appearance.cfg"), JSON.stringify({
      operator: "appearance-fixture", lhost: "127.0.0.1", lport: 31337,
      ca_certificate: "FAKE_CA", certificate: "FAKE_CERT", private_key: "FAKE_KEY", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });
    await writeFile(configPath, "# Shared with Ghostty\n", { mode: 0o600 });
    await writeFile(join(client, "gui", "ghostty", "themes", "Smoke"),
      "background = #202630\nforeground = #d8dee9\ncursor-color = #88c0d0\ncursor-text = #202630\nselection-background = #4c566a\nselection-foreground = #ffffff\npalette = 2=#a3be8c\nbackground-opacity = 0.75\n", { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(root, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${root}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${client}`],
      cwd: root, bypassCSP: false, chromiumSandbox: true, timeout: 25_000,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const owned = application.process();
    context.signal.addEventListener("abort", () => { owned.kill("SIGKILL"); }, { once: true });
    previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    const observe = (page: Page): void => {
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    };
    application.on("window", observe);
    workspace = await application.firstWindow();
    observe(workspace);
    const nativeWorkspace = await application.browserWindow(workspace);
    await nativeWorkspace.evaluate((window) => { window.show(); window.focus(); window.webContents.focus(); });
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await workspace.getByRole("dialog", { name: "Saved configurations" }).waitFor({ state: "hidden" });
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await workspace.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const { v: _version, revision, ...settings } = await api.getApplicationSettings();
      await api.updateApplicationSettings({ expectedRevision: revision, settings: { ...settings, theme: "dark" } });
    });
    await workspace.locator("html.dark").waitFor();
    const [terminal] = await Promise.all([
      application.waitForEvent("window", { timeout: 12_000 }),
      workspace.getByRole("button", { name: "Open Sliver console", exact: true }).click(),
    ]);
    await terminal.locator('[data-terminal-state="ready"]').waitFor();
    const modal = terminal.getByRole("dialog", { name: "Terminal Settings", exact: true });
    const nativeTerminal = await application.browserWindow(terminal);
    const originalSize = await nativeTerminal.evaluate((window) => window.getContentSize());
    for (const [width, height] of [[1180, 780], [720, 540]] as const) {
      await nativeTerminal.evaluate((window, size) => window.setContentSize(size.width, size.height), { width, height });
      const before: ApplicationSettingsState = await workspace.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings());
      await terminal.getByRole("button", { name: "Terminal settings", exact: true }).click();
      await modal.waitFor();
      const editConfig = modal.getByRole("button", { name: "Edit Ghostty config", exact: true });
      await editConfig.scrollIntoViewIfNeeded();
      await terminal.screenshot({ path: join(artifacts, `terminal-settings-modal-${height}.png`), animations: "disabled" });
      // Clicking the visible labels checks hit testing through the scroll and
      // clipping ancestors; hidden input state alone missed the collapsed group.
      await modal.getByText("Blinking cursor", { exact: true }).click();
      await modal.getByText("Smooth scrolling", { exact: true }).click();
      assert.equal(await modal.getByRole("switch", { name: "Blinking cursor", exact: true }).isChecked(), !before.terminal.cursorBlink);
      assert.equal(await modal.getByRole("switch", { name: "Smooth scrolling", exact: true }).isChecked(), !before.terminal.smoothScrolling);
      const editBounds = await editConfig.boundingBox();
      assert.ok(editBounds && editBounds.height >= 32, "The config editor button must retain its usable height");
      await modal.getByRole("button", { name: "Save", exact: true }).click();
      await modal.waitFor({ state: "hidden" });
      const saved: ApplicationSettingsState = await workspace.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings());
      assert.equal(saved.terminal.cursorBlink, !before.terminal.cursorBlink);
      assert.equal(saved.terminal.smoothScrolling, !before.terminal.smoothScrolling);
      await terminal.getByRole("button", { name: "Terminal settings", exact: true }).click();
      assert.equal(await modal.getByRole("switch", { name: "Blinking cursor", exact: true }).isChecked(), saved.terminal.cursorBlink);
      assert.equal(await modal.getByRole("switch", { name: "Smooth scrolling", exact: true }).isChecked(), saved.terminal.smoothScrolling);
      await modal.getByRole("button", { name: "Cancel", exact: true }).click();
      await modal.waitFor({ state: "hidden" });
    }
    await nativeTerminal.evaluate((window, size) => window.setContentSize(size[0]!, size[1]!), originalSize);
    const initial = await workspace.evaluate(() => (globalThis as unknown as { ghosttySettings: GhosttySettingsAPI }).ghosttySettings.getConfig());
    assert.equal(initial.configPath, configPath);
    assert.ok(initial.themes.some(({ name }) => name === "Smoke"));
    assert.equal(await canvasBackgroundAlpha(terminal), initial.nativeTerminalTransparency ? 0 : 255);
    const defaultAlpha = initial.nativeTerminalTransparency ? 56 : 255;
    assert.equal(await compositedBackgroundAlpha(application, terminal), defaultAlpha,
      "The default terminal tint must leave the native glass visible");
    assert.equal(await compositedBackgroundAlpha(application, terminal, ".terminal-window__toolbar"), defaultAlpha,
      "The toolbar must use the same glass tint as the terminal body");
    await terminal.screenshot({ path: join(artifacts, "console-default-glass.png"), animations: "disabled", omitBackground: true });

    await workspace.getByRole("button", { name: /^(?:Application menu,|Current server:)/u }).click();
    await workspace.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await workspace.getByRole("tab", { name: "Terminal", exact: true }).click();
    await workspace.getByRole("button", { name: /Terminal theme/u }).click();
    await workspace.getByRole("option", { name: "Smoke", exact: true }).click();
    await terminal.waitForFunction(() => {
      const doc = (globalThis as unknown as { document: { querySelector(selector: string): { style: { getPropertyValue(key: string): string } } | null } }).document;
      return doc.querySelector(".terminal-window")?.style.getPropertyValue("--terminal-background") === "#202630";
    });
    await terminal.locator('[data-terminal-state="ready"]').waitFor();
    const transparentAlpha = await canvasBackgroundAlpha(terminal);
    assert.equal(transparentAlpha, initial.nativeTerminalTransparency ? 0 : 255);
    const glassPixel = await compositedBackgroundAlpha(application, terminal);
    assert.equal(glassPixel, initial.nativeTerminalTransparency ? 191 : 255,
      "The full terminal background must retain the configured opacity after CSS compositing");
    assert.equal(await compositedBackgroundAlpha(application, terminal, ".terminal-window__toolbar"), initial.nativeTerminalTransparency ? 191 : 255);
    await terminal.screenshot({ path: join(artifacts, "console-glass.png"), animations: "disabled", omitBackground: true });
    await workspace.screenshot({ path: join(artifacts, "terminal-settings.png"), animations: "disabled" });

    await workspace.getByText("Transparent terminal windows", { exact: true }).click();
    await workspace.getByRole("button", { name: "Save", exact: true }).click();
    await terminal.locator('.terminal-window[data-transparent="false"]').waitFor();
    await terminal.locator('[data-terminal-state="ready"]').waitFor();
    assert.equal(await canvasBackgroundAlpha(terminal), 255);
    assert.equal(await compositedBackgroundAlpha(application, terminal), 255);
    await terminal.screenshot({ path: join(artifacts, "console-opaque.png"), animations: "disabled" });

    const openedEditor = application.waitForEvent("window");
    await workspace.getByRole("button", { name: "Edit Ghostty config", exact: true }).click();
    const editor = await openedEditor;
    await editor.locator(".monaco-editor").waitFor();
    const text = "# Shared with Ghostty\ntheme = Smoke\nbackground = #112233\nforeground = #eeeeee\n";
    await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
    await editor.getByRole("textbox", { name: "Document text", exact: true }).focus();
    await editor.keyboard.press(`${modifier}+a`);
    await editor.keyboard.press(`${modifier}+v`);
    await editor.getByText("Unsaved changes", { exact: true }).waitFor();
    await editor.keyboard.press(`${modifier}+s`);
    await editor.getByText("Saved", { exact: true }).waitFor();
    assert.equal(await readFile(configPath, "utf8"), text);
    await terminal.waitForFunction(() => {
      const doc = (globalThis as unknown as { document: { querySelector(selector: string): { style: { getPropertyValue(key: string): string } } | null } }).document;
      return doc.querySelector(".terminal-window")?.style.getPropertyValue("--terminal-background") === "#112233";
    });
    await editor.screenshot({ path: join(artifacts, "ghostty-config-editor.png"), animations: "disabled" });
    const current = await workspace.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings());
    assert.equal(current.terminal.transparentWindows, false);
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length), 1,
      "Appearance updates must preserve the existing console process");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (workspace && !workspace.isClosed()) await workspace.screenshot({ path: join(artifacts, "failure.png") }).catch(() => undefined);
    console.error("Renderer errors:", errors);
    throw error;
  } finally {
    if (application) {
      if (previousClipboard !== undefined) await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard).catch(() => undefined);
      await cleanupOwnedApplication(application, "Terminal Appearance E2E", 5_000);
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

async function canvasBackgroundAlpha(page: Page): Promise<number> {
  return await page.locator('[data-terminal-state="ready"] canvas').first().evaluate((element) => {
    const canvas = element as unknown as { width: number; height: number; getContext(kind: string): { getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray } } };
    return canvas.getContext("2d").getImageData(canvas.width - 4, canvas.height - 4, 1, 1).data[3] ?? -1;
  });
}

async function compositedBackgroundAlpha(
  application: ElectronApplication,
  page: Page,
  selector = '[data-terminal-state="ready"] canvas',
): Promise<number> {
  const bounds = await page.locator(selector).first().boundingBox();
  assert.ok(bounds);
  const screenshot = await page.screenshot({
    clip: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height - 4, width: 1, height: 1 },
    animations: "disabled",
    omitBackground: true,
  });
  return await application.evaluate(({ nativeImage }, base64) =>
    nativeImage.createFromBuffer(Buffer.from(base64, "base64")).toBitmap()[3] ?? -1, screenshot.toString("base64"));
}
