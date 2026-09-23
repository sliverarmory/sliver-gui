import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { ApplicationContextMenuAPI } from "../shared/application-context-menu-contracts.js";
import type { TextEditorAPI } from "../shared/text-editor-contracts.js";
import { cleanupOwnedApplication } from "./packaged-application-update-support.js";

const modifier = process.platform === "darwin" ? "Meta" : "Control";

test("standalone text editor edits local UTF-8 files with real Monaco and protects unsaved changes", {
  timeout: 120_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-text-editor-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts", "e2e");
  const filePath = join(temporary, "document.xml");
  const shellPath = join(temporary, "deploy.sh");
  const powershellPath = join(temporary, "deploy.ps1");
  const pythonPath = join(temporary, "deploy.py");
  const rustPath = join(temporary, "main.rs");
  const copyPath = join(temporary, "document-copy.xml");
  const binaryPath = join(temporary, "binary.xml");
  const initial = '<?xml version="1.0" encoding="UTF-8"?>\n<note>Local café document</note>\n';
  const shell = '#!/usr/bin/env bash\nif [[ -n "$HOME" ]]; then\n  echo "$HOME"\nfi\n';
  const powershell = 'if ($env:USERPROFILE) {\n  Get-ChildItem -Path $env:USERPROFILE\n}\n';
  const python = 'def greet(name: str) -> str:\n    return f"Hello, {name}"\n';
  const rust = 'fn main() {\n    println!("Hello from Rust");\n}\n';
  const initialBytes = utf8WithBomAndCrlf(initial);
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let previousClipboard: string | undefined;
  let assertionsPassed = false;
  const errors: string[] = [];

  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(temporary, "client", "armories.json"), "[]", { mode: 0o600 });
    await writeFile(filePath, initialBytes);
    await writeFile(shellPath, shell, "utf8");
    await writeFile(powershellPath, powershell, "utf8");
    await writeFile(pythonPath, python, "utf8");
    await writeFile(rustPath, rust, "utf8");
    await writeFile(binaryPath, Buffer.from("<note>\u0000binary</note>", "utf8"));
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 25_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => { ownedProcess.kill("SIGKILL"); }, { once: true });
    previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(10_000);
    const configurations = workspace.getByRole("dialog", { name: "Saved configurations" });
    await configurations.getByRole("button", { name: "Cancel", exact: true }).click();
    const owner = await application.browserWindow(workspace);
    const ownerId = await owner.evaluate((window) => window.id);
    const opened = application.waitForEvent("window", { timeout: 10_000 });
    await invokeEditorMenu(application, ownerId);
    page = await opened;
    page.setDefaultTimeout(10_000);
    // Electron's native close guard decides whether unloading is allowed.
    // A permitted unload can destroy the CDP session before Playwright's
    // automatic beforeunload response completes, so settle that race here.
    page.on("dialog", (dialog) => { void dialog.accept().catch(() => undefined); });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) errors.push(message.text());
    });
    await page.getByRole("heading", { name: "Untitled", exact: true }).waitFor();
    await page.locator(".monaco-editor").waitFor();
    await waitUntil(() => page!.getByRole("button", { name: "Undo", exact: true }).isEnabled());
    const headerBounds = await page.locator(".text-editor-header").boundingBox();
    assert.ok(headerBounds, "The compact editor header must be rendered");
    assert.ok(headerBounds.y <= 1, `The editor header must start at the viewport top; received ${headerBounds.y}px`);
    assert.ok(headerBounds.height <= 56, `The editor header must remain compact; received ${headerBounds.height}px`);
    if (process.platform === "darwin") {
      const titleBounds = await page.getByRole("heading", { name: "Untitled", exact: true }).boundingBox();
      assert.ok(titleBounds, "The editor filename must be rendered");
      assert.ok(titleBounds.x >= 88,
        `The editor filename must clear the macOS window controls; received ${titleBounds.x}px`);
    }
    await waitUntil(() => page!.locator(".monaco-editor .minimap").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0;
    }));
    assert.equal(new URL(page.url()).searchParams.get("surface"), "text-editor");
    const bridge = await page.evaluate(() => {
      const browser = globalThis as unknown as {
        applicationContextMenu: ApplicationContextMenuAPI;
        textEditor: TextEditorAPI;
        sliver?: unknown;
        network?: unknown;
        armory?: unknown;
      };
      return { frozen: Object.isFrozen(browser.textEditor), keys: Object.keys(browser.textEditor).sort(),
        contextMenuFrozen: Object.isFrozen(browser.applicationContextMenu),
        contextMenuKeys: Object.keys(browser.applicationContextMenu).sort(),
        sliver: typeof browser.sliver, network: typeof browser.network, armory: typeof browser.armory };
    });
    assert.deepEqual(bridge, {
      frozen: true, keys: [
        "getApplicationSettings",
        "getDocument",
        "getEditorSettings",
        "onApplicationSettingsChanged",
        "onEditorSettingsChanged",
        "onRemoteOverwriteRequested",
        "openFile",
        "respondToRemoteOverwrite",
        "save",
        "setDirty",
        "updateEditorSettings",
      ],
      contextMenuFrozen: true,
      contextMenuKeys: ["executeAction", "onMenuRequested", "setOpen"],
      sliver: "undefined", network: "undefined", armory: "undefined",
    });
    const nativeWindow = await application.browserWindow(page);
    const nativeId = await nativeWindow.evaluate((window) => window.id);
    assert.deepEqual(await nativeWindow.evaluate((window) => {
      const preferences = window.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }), { sandbox: true, contextIsolation: true, nodeIntegration: false });

    await chooseOpenFile(application, filePath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "document.xml", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Document language", exact: true }).inputValue(), "xml");
    assert.equal(await documentText(application, page), initial);

    await chooseOpenFile(application, shellPath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "deploy.sh", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Document language", exact: true }).inputValue(), "shell");
    assert.equal(await documentText(application, page), shell);
    await waitUntil(async () => page!.locator(".view-lines .view-line", { hasText: "if [[" })
      .locator("span > span").count().then((count) => count > 1));

    await chooseOpenFile(application, powershellPath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "deploy.ps1", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Document language", exact: true }).inputValue(), "powershell");
    assert.equal(await documentText(application, page), powershell);
    await waitUntil(async () => page!.locator(".view-lines .view-line", { hasText: "$env:USERPROFILE" })
      .first().locator("span > span").count().then((count) => count > 1));

    await chooseOpenFile(application, pythonPath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "deploy.py", exact: true }).waitFor();
    await waitUntil(async () => page!.getByRole("combobox", { name: "Document language", exact: true }).inputValue()
      .then((value) => value === "python"));
    assert.equal(await documentText(application, page), python);
    await waitUntil(async () => page!.locator(".view-lines .view-line", { hasText: "def greet" })
      .locator("span > span").count().then((count) => count > 1));

    await chooseOpenFile(application, rustPath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "main.rs", exact: true }).waitFor();
    await waitUntil(async () => page!.getByRole("combobox", { name: "Document language", exact: true }).inputValue()
      .then((value) => value === "rust"));
    assert.equal(await documentText(application, page), rust);
    await waitUntil(async () => page!.locator(".view-lines .view-line", { hasText: "fn main" })
      .locator("span > span").count().then((count) => count > 1));
    assert.equal(await page.getByRole("option", { name: "Python", exact: true }).count(), 1);
    assert.equal(await page.getByRole("option", { name: "Rust", exact: true }).count(), 1);
    assert.equal(await page.getByRole("option", { name: "Go", exact: true }).count(), 1);

    await chooseOpenFile(application, filePath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("heading", { name: "document.xml", exact: true }).waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Document language", exact: true }).inputValue(), "xml");
    assert.equal(await documentText(application, page), initial);

    await verifyEditorContextMenu(application, page, initial);

    // A text-looking extension cannot make binary content editable.
    await chooseOpenFile(application, binaryPath);
    await page.getByRole("button", { name: "Open…", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /Only text files.*binary/iu }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "document.xml", exact: true }).isVisible(), true);
    assert.equal(await documentText(application, page), initial);

    const saved = initial.replace("Local café document", "Edited café document");
    await replaceDocument(application, page, saved);
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await page.keyboard.press(`${modifier}+s`);
    await page.getByText("Saved", { exact: true }).waitFor();
    assert.deepEqual(await readFile(filePath), utf8WithBomAndCrlf(saved), "Save must preserve the original UTF-8 BOM and CRLF endings");

    const edited = '<?xml version="1.0" encoding="UTF-8"?>\n<note>\n  <title>alpha alpha café</title>\n' +
      `  <message>${"A local editor keeps document changes explicit. ".repeat(28)}</message>\n</note>\n`;
    await replaceDocument(application, page, edited);
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await page.getByRole("combobox", { name: "Document language", exact: true }).selectOption("plaintext");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    assert.equal(await documentText(application, page), saved, "Changing language must preserve the existing undo history");
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    assert.equal(await documentText(application, page), edited);
    await page.getByRole("combobox", { name: "Document language", exact: true }).selectOption("xml");

    const controls = page.getByRole("group", { name: "Editor controls", exact: true });
    await controls.getByRole("button", { name: "Commands", exact: true }).click();
    const commandPalette = page.locator(".quick-input-widget");
    await commandPalette.waitFor({ state: "visible" });
    const commandInput = commandPalette.locator("input").first();
    assert.equal(await commandInput.evaluate((element) => element === element.ownerDocument.activeElement), true,
      "The Monaco command palette must receive keyboard focus");
    await waitUntil(async () => (await commandPalette.locator(".monaco-list-row").count()) > 0);
    await page.keyboard.press("Escape");
    await commandPalette.waitFor({ state: "hidden" });
    await controls.getByRole("button", { name: "Find", exact: true }).click();
    const find = page.locator(".find-widget").getByRole("textbox", { name: "Find", exact: true });
    await find.fill("alpha");
    await find.selectText();
    await find.click({ button: "right" });
    const findContextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await findContextMenu.waitFor();
    for (const label of ["Cut", "Copy", "Paste", "Select All", "Inspect Element"]) {
      assert.equal(await findContextMenu.getByRole("menuitem", { name: label, exact: true }).count(), 1,
        `Find input must expose native ${label}`);
    }
    await application.evaluate(({ clipboard }) => clipboard.writeText("find copy sentinel"));
    await findContextMenu.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await waitUntil(async () => await application!.evaluate(({ clipboard }) => clipboard.readText()) === "alpha");
    await findContextMenu.waitFor({ state: "hidden" });
    await find.press("End");
    await find.pressSequentially("x");
    await page.keyboard.press(`${modifier}+z`);
    assert.equal(await find.inputValue(), "alpha", "Undo in Find must edit its input instead of the document");
    assert.equal(await documentText(application, page), edited);
    await page.locator(".find-widget").getByText(/of 2$/u).waitFor();
    await controls.getByRole("button", { name: "Replace", exact: true }).click();
    await page.locator(".find-widget").getByRole("textbox", { name: "Replace", exact: true }).fill("beta");
    await page.locator(".find-widget").getByRole("button", { name: /^Replace All/u }).click();
    await page.keyboard.press("Escape");
    const replaced = edited.replaceAll("alpha", "beta");
    assert.equal(await documentText(application, page), replaced);
    await controls.getByRole("button", { name: "Word Wrap", exact: true }).click();
    await waitUntil(async () => (await controls.getByRole("button", { name: "Word Wrap", exact: true })
      .getAttribute("aria-pressed")) === "true");
    await waitUntil(async () => (await page!.locator(".view-lines .view-line").count()) > replaced.split("\n").length);
    if (process.platform === "darwin") {
      const undo = controls.getByRole("button", { name: "Undo", exact: true });
      await undo.hover();
      const tooltip = page.getByRole("tooltip").filter({ hasText: /^Undo ·/u });
      await tooltip.waitFor();
      const tooltipText = await tooltip.innerText();
      assert.match(tooltipText, /⌘/u, "Editor tooltips must use the macOS Command symbol");
      assert.doesNotMatch(tooltipText, /\bCommand\b/u,
        "Editor tooltips must not spell out the macOS Command key");
    }

    await controls.getByRole("button", { name: "Editor settings", exact: true }).click();
    const settingsDialog = page.getByRole("dialog", { name: "Editor settings", exact: true });
    await settingsDialog.waitFor();
    const settingsScrollShadow = settingsDialog.locator('[data-scroll-shadow-size="28"]');
    await settingsScrollShadow.waitFor();
    assert.equal(await settingsScrollShadow.getAttribute("data-orientation"), "vertical",
      "The editor settings body must use a vertical HeroUI ScrollShadow");
    await settingsDialog.getByRole("button", { name: /Font family/u }).click();
    await page.getByRole("option", { name: "JetBrains Mono", exact: true }).click();
    const fontSize = settingsDialog.getByRole("textbox", { name: "Font size", exact: true });
    await fontSize.fill("18");
    await settingsDialog.getByText("Sticky scroll", { exact: true }).click();
    await settingsDialog.getByRole("button", { name: "Save", exact: true }).click();
    await settingsDialog.waitFor({ state: "hidden" });
    await waitUntil(() => page!.locator(".view-lines").evaluate((element) => {
      const browser = globalThis as unknown as { getComputedStyle(element: unknown): { fontFamily: string; fontSize: string } };
      const style = browser.getComputedStyle(element);
      return style.fontSize === "18px" && style.fontFamily.includes("JetBrains Mono");
    }));
    const settingsPath = join(temporary, "client", "gui", "text-editor-settings.json");
    const persistedSettings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    assert.equal(persistedSettings["fontId"], "jetbrains-mono");
    assert.equal(persistedSettings["fontSize"], 18);
    assert.equal(persistedSettings["fontLigatures"], true);
    assert.equal(persistedSettings["wordWrap"], true);
    assert.equal(persistedSettings["stickyScroll"], true);
    if (process.platform !== "win32") {
      assert.equal((await stat(settingsPath)).mode & 0o777, 0o600, "Editor settings must remain private");
    }
    assert.match(await page.getByLabel("Editor status", { exact: true }).innerText(), /Ln \d+, Col \d+/u);

    await chooseSaveFile(application, null);
    await page.getByRole("button", { name: "Save As…", exact: true }).click();
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    assert.deepEqual(await readFile(filePath), utf8WithBomAndCrlf(saved), "Canceling Save As must leave the source file unchanged");
    await chooseSaveFile(application, copyPath);
    await page.getByRole("button", { name: "Save As…", exact: true }).click();
    await page.getByRole("heading", { name: "document-copy.xml", exact: true }).waitFor();
    await page.getByText("Saved", { exact: true }).waitFor();
    assert.deepEqual(await readFile(copyPath), utf8WithBomAndCrlf(replaced));
    assert.deepEqual(await readFile(filePath), utf8WithBomAndCrlf(saved), "Save As must not change the previous document destination");

    await nativeWindow.evaluate((window) => window.setSize(800, 680));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 800);
    assert.equal(await page.getByLabel("Text editor workspace", { exact: true }).evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    assert.equal(await controls.evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await page.getByRole("textbox", { name: "Document text", exact: true }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+Home");
    await page.getByLabel("Editor status", { exact: true }).getByText("Ln 1, Col 1", { exact: true }).waitFor();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator("html.dark").waitFor();
    await page.screenshot({ path: join(artifacts, "text-editor.png"), animations: "disabled" });

    const unsaved = replaced.replace("beta beta", "Unsaved local draft");
    await replaceDocument(application, page, unsaved);
    await page.getByText("Unsaved changes", { exact: true }).waitFor();
    await waitUntil(async () => (await nativeWindow.evaluate((window) => window.getTitle())).startsWith("● "));
    assert.deepEqual(await requestNativeClose(application, nativeId, "Cancel", "quit"), ["Discard changes to document-copy.xml?"]);
    assert.equal(page.isClosed(), false, "Canceling Quit must retain the dirty editor");
    assert.equal(workspace.isClosed(), false, "Canceling Quit must retain the workspace");
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    assert.equal(await documentText(application, page), unsaved, "Canceling Quit must preserve the draft and working editor");
    assert.deepEqual(await requestNativeClose(application, nativeId, "Cancel"), ["Discard changes to document-copy.xml?"]);
    assert.equal(page.isClosed(), false);
    assert.equal(await documentText(application, page), unsaved, "Cancel must retain the unsaved draft");
    assert.deepEqual(await readFile(copyPath), utf8WithBomAndCrlf(replaced));
    const closed = page.waitForEvent("close", { timeout: 10_000 });
    assert.deepEqual(await requestNativeClose(application, nativeId, "Discard Changes"), ["Discard changes to document-copy.xml?"]);
    await closed;
    assert.deepEqual(await readFile(copyPath), utf8WithBomAndCrlf(replaced), "Discard must not save the draft");

    const reopenedEvent = application.waitForEvent("window", { timeout: 10_000 });
    await invokeEditorMenu(application, ownerId);
    const reopened = await reopenedEvent;
    reopened.setDefaultTimeout(10_000);
    await reopened.locator(".monaco-editor").waitFor();
    await waitUntil(() => reopened.locator(".view-lines").evaluate((element) => {
      const browser = globalThis as unknown as { getComputedStyle(element: unknown): { fontFamily: string; fontSize: string } };
      const style = browser.getComputedStyle(element);
      return style.fontSize === "18px" && style.fontFamily.includes("JetBrains Mono");
    }));
    assert.equal(await reopened.getByRole("button", { name: "Word Wrap", exact: true }).getAttribute("aria-pressed"), "true");
    const reopenedNative = await application.browserWindow(reopened);
    const reopenedClosed = reopened.waitForEvent("close", { timeout: 10_000 });
    await reopenedNative.evaluate((window) => window.close());
    await reopenedClosed;
    assert.deepEqual(errors, [], "The standalone editor must have no page or CSP errors");
    assertionsPassed = true;
  } catch (error) {
    context.diagnostic(JSON.stringify(errors));
    if (page && !page.isClosed()) {
      context.diagnostic((await page.locator("body").innerText()).slice(-6000));
      await page.screenshot({ path: join(artifacts, "text-editor-failure.png") }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (application) {
      if (previousClipboard !== undefined) await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), previousClipboard).catch(() => undefined);
      // Test failure can leave an intentional dirty draft. Accept its native
      // discard prompt before invoking the bounded owned-process cleanup.
      await application.evaluate(({ dialog }) => {
        dialog.showMessageBoxSync = (...args: unknown[]) => {
          const options = args[args.length - 1] as { buttons?: string[] };
          return Math.max(0, options.buttons?.indexOf("Discard Changes") ?? 0);
        };
      }).catch(() => undefined);
      const ownedProcess = application.process();
      await cleanupOwnedApplication(application, "Text Editor E2E", 5_000);
      if (assertionsPassed) assert.equal(ownedProcess.signalCode, null, "The application must quit gracefully");
    }
    await rm(temporary, { recursive: true, force: true });
  }
});

async function invokeEditorMenu(application: ElectronApplication, windowId: number): Promise<void> {
  await waitUntil(async () => application.evaluate(({ BrowserWindow, Menu }, id) => {
    const window = BrowserWindow.fromId(id);
    const item = Menu.getApplicationMenu()?.getMenuItemById("text-editor.new");
    if (!window || !item) return false;
    window.show(); window.focus();
    Reflect.apply(item.click, item, [item, window, {}]);
    return true;
  }, windowId));
}

async function chooseOpenFile(application: ElectronApplication, path: string): Promise<void> {
  await application.evaluate(({ dialog }, selectedPath) => {
    const original = dialog.showOpenDialog;
    dialog.showOpenDialog = async () => {
      dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [selectedPath] };
    };
  }, path);
}

async function chooseSaveFile(application: ElectronApplication, path: string | null): Promise<void> {
  await application.evaluate(({ dialog }, selectedPath) => {
    const original = dialog.showSaveDialog;
    dialog.showSaveDialog = async () => {
      dialog.showSaveDialog = original;
      return selectedPath === null ? { canceled: true, filePath: "" } : { canceled: false, filePath: selectedPath };
    };
  }, path);
}

async function requestNativeClose(application: ElectronApplication, windowId: number, response: string, action: "close" | "quit" = "close"): Promise<string[]> {
  return application.evaluate(({ app, BrowserWindow, dialog }, request) => {
    const original = dialog.showMessageBoxSync;
    const prompts: string[] = [];
    dialog.showMessageBoxSync = (...args: unknown[]) => {
      const options = args[args.length - 1] as { message: string; buttons: string[] };
      prompts.push(options.message);
      const index = options.buttons.indexOf(request.response);
      if (index < 0) throw new Error(`Missing close response ${request.response}`);
      return index;
    };
    try {
      if (request.action === "quit") app.quit();
      else BrowserWindow.fromId(request.windowId)!.close();
      return prompts;
    }
    finally { dialog.showMessageBoxSync = original; }
  }, { windowId, response, action });
}

async function verifyEditorContextMenu(
  application: ElectronApplication,
  page: Page,
  original: string,
): Promise<void> {
  const editor = page.getByRole("textbox", { name: "Document text", exact: true });
  const status = page.getByLabel("Editor status", { exact: true });
  const replacement = "Edited through the application context menu";
  const originalModelLength = original.replace(/\r\n|\r|\n/gu, "\r\n").length;

  await editor.focus();
  await page.keyboard.press("ArrowRight");
  let menu = await openEditorContextMenu(page);
  for (const label of ["Undo", "Redo", "Cut", "Copy", "Paste", "Delete", "Select All", "Inspect Element"]) {
    assert.equal(await menu.getByRole("menuitem", { name: label, exact: true }).count(), 1,
      `Monaco context menu must expose ${label}`);
  }
  if (process.platform === "darwin") {
    const undoText = await menu.getByRole("menuitem", { name: "Undo", exact: true }).innerText();
    assert.match(undoText, /⌘/u, "Editor context-menu shortcuts must use the macOS Command symbol");
    assert.doesNotMatch(await menu.innerText(), /\bCommand\b/u,
      "Editor context-menu shortcuts must not spell out the macOS Command key");
  }
  await menu.getByRole("menuitem", { name: "Select All", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  await waitUntil(() => editor.evaluate((element) => element === element.ownerDocument.activeElement));
  await page.keyboard.insertText("x");
  await status.getByText("1 characters", { exact: true }).waitFor();
  await page.keyboard.press(`${modifier}+z`);
  await waitUntil(async () => await documentText(application, page) === original);

  await editor.focus();
  await page.keyboard.press(`${modifier}+a`);
  menu = await openEditorContextMenu(page);
  await application.evaluate(({ clipboard }) => clipboard.writeText("copy action sentinel"));
  await menu.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await waitUntil(async () => (await application.evaluate(({ clipboard }) => clipboard.readText()))
    .replace(/\r\n/gu, "\n") === original);

  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), replacement);
  await editor.focus();
  await page.keyboard.press(`${modifier}+a`);
  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Paste", exact: true }).click();
  await status.getByText(`${replacement.length} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), replacement);

  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await status.getByText(`${originalModelLength} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), original);

  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Redo", exact: true }).click();
  await status.getByText(`${replacement.length} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), replacement);

  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await status.getByText("0 characters", { exact: true }).waitFor();

  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await status.getByText(`${replacement.length} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), replacement);

  await editor.focus();
  await page.keyboard.press(`${modifier}+a`);
  await application.evaluate(({ clipboard }) => clipboard.writeText("cut sentinel"));
  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Cut", exact: true }).click();
  await status.getByText("0 characters", { exact: true }).waitFor();
  await waitUntil(async () => await application.evaluate(({ clipboard }) => clipboard.readText()) === replacement);

  menu = await openEditorContextMenu(page);
  await menu.getByRole("menuitem", { name: "Undo", exact: true }).click();
  await status.getByText(`${replacement.length} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), replacement);
  await page.keyboard.press(`${modifier}+z`);
  await status.getByText(`${originalModelLength} characters`, { exact: true }).waitFor();
  assert.equal(await documentText(application, page), original);
  await page.getByText("Saved", { exact: true }).waitFor();
}

async function openEditorContextMenu(page: Page) {
  await page.locator(".monaco-editor .view-lines").click({
    button: "right",
    position: { x: 120, y: 18 },
  });
  const menu = page.getByRole("menu", { name: "Application context menu", exact: true });
  await menu.waitFor();
  return menu;
}

async function replaceDocument(application: ElectronApplication, page: Page, text: string): Promise<void> {
  // Paste a complete document as a user would; insertText dispatches it as one
  // typed character event and can activate XML's angle-bracket auto-closing.
  await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await page.getByRole("textbox", { name: "Document text", exact: true }).focus();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+v`);
}

async function documentText(application: ElectronApplication, page: Page): Promise<string> {
  const sentinel = `text-editor-clipboard-${Date.now()}`;
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), sentinel);
  await page.getByRole("textbox", { name: "Document text", exact: true }).focus();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+c`);
  let text = sentinel;
  await waitUntil(async () => {
    text = await application.evaluate(({ clipboard }) => clipboard.readText());
    return text !== sentinel;
  });
  return text.replace(/\r\n/gu, "\n");
}

function utf8WithBomAndCrlf(text: string): Buffer {
  return Buffer.from(`\ufeff${text.replace(/\r\n|\r|\n/gu, "\r\n")}`, "utf8");
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("Timed out waiting for the text editor state");
}
