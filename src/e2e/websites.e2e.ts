import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { TextEditorAPI } from "../shared/text-editor-contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("hosted websites support standalone editing, row actions, and fresh browser previews", { timeout: 120_000 }, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-websites-"));
  const artifacts = join(repositoryRoot, "artifacts", "websites");
  await Promise.all(["saved", "managed", "client", "user-data", "upload"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(root, "client", "armories.json"), "[]", { mode: 0o600 });
  await writeFile(join(root, "saved", "websites.cfg"), JSON.stringify({
    operator: "websites-fixture", lhost: "127.0.0.1", lport: 31337,
    ca_certificate: "FAKE_WEBSITE_CA", certificate: "FAKE_WEBSITE_CERT",
    private_key: "FAKE_WEBSITE_KEY", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  }), { mode: 0o600 });
  const hostedHtml = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="./site.css"><script src="./site.js" defer></script>',
    '</head><body onload="window.__WEBSITE_EXECUTED__=true">',
    '<h1>Browser preview</h1><p class="website-color">Static content</p>',
    '<script>window.__WEBSITE_EXECUTED__=true;if(window.sliver)window.sliver.disconnect();</script>',
    '<img src="./pixel.png" alt="Hosted image"><p id="script-result"></p>',
    '</body></html>',
  ].join("\n");
  const stylesheet = ".website-color { color: rgb(30, 70, 120); }";
  const script = 'document.querySelector("#script-result").textContent="External script loaded";';
  await writeFile(join(root, "upload", "index.html"), hostedHtml);
  await writeFile(join(root, "upload", "site.css"), stylesheet);
  await writeFile(join(root, "upload", "site.js"), script);
  const bomText = "\uFEFFfirst\r\nsecond\r\n";
  await writeFile(join(root, "upload", "bom.txt"), bomText);
  await writeFile(join(root, "upload", "asset.bin"), Buffer.from([0, 1, 2, 0xff]));
  await mkdir(join(root, "upload", ".git"));
  await writeFile(join(root, "upload", ".git", "fixture.txt"), "Hidden directory fixture");
  await writeFile(join(root, "upload", ".nojekyll"), "Dot file fixture");
  await writeFile(join(root, "upload", "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQc6v4DwADPgHc8bhcNQAAAABJRU5ErkJggg==", "base64"));
  let application: ElectronApplication | undefined;
  let browser: Browser | undefined;
  let browserPreview: Page | undefined;
  let failure: unknown;
  try {
    application = await electron.launch({
      args: ["--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`, `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`],
      cwd: repositoryRoot, bypassCSP: false, timeout: 20_000,
    });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const page = await application.firstWindow();
    await application.evaluate(({ shell }) => {
      const state = globalThis as unknown as { __websiteExternalUrls?: string[] };
      state.__websiteExternalUrls = [];
      shell.openExternal = async (url) => { state.__websiteExternalUrls?.push(url); };
    });
    page.setDefaultTimeout(10_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const errors: string[] = [];
    const externalRequests: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (/^(?:https?:|file:|data:)/u.test(request.url())) externalRequests.push(request.url());
    });
    await page.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    const infrastructure = page.getByRole("treegrid", { name: "Operational navigation" });
    assert.equal(await infrastructure.getByRole("row", { name: "Websites" }).count(), 0);
    await infrastructure.getByRole("row", { name: "Jobs & listeners" }).click();
    await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();
    const jobsTab = page.getByRole("tab", { name: "Jobs & listeners", exact: true });
    const websitesTab = page.getByRole("tab", { name: "Websites", exact: true });
    assert.equal(await page.getByRole("button", { name: "Websites", exact: true }).count(), 0);
    assert.equal(await jobsTab.getAttribute("aria-selected"), "true");
    assert.equal(await websitesTab.getAttribute("aria-selected"), "false");
    await page.screenshot({ path: join(artifacts, "jobs-websites-tabs.png"), animations: "disabled" });
    await websitesTab.click();
    await page.getByRole("heading", { name: "Websites", exact: true, level: 1 }).waitFor();
    assert.equal(await websitesTab.getAttribute("aria-selected"), "true");
    assert.equal(await jobsTab.getAttribute("aria-selected"), "false");
    assert.equal(await infrastructure.getByRole("row", { name: "Jobs & listeners" }).getAttribute("data-current"), "true");
    await jobsTab.click();
    await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();
    await jobsTab.press("ArrowRight");
    await websitesTab.press("Enter");
    await page.getByRole("heading", { name: "Websites", exact: true, level: 1 }).waitFor();
    assert.equal(await websitesTab.getAttribute("aria-selected"), "true");

    // Native dialogs are selected in main; no renderer API receives a local path.
    await application.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
    }, join(root, "upload"));
    await page.getByRole("button", { name: "Create website", exact: true }).click();
    const createDialog = page.getByRole("dialog", { name: "Create website", exact: true });
    await createDialog.getByLabel("Website name", { exact: true }).fill("preview-test");
    await createDialog.getByRole("button", { name: "Create website", exact: true }).click();
    await createDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Import directory", exact: true }).click();
    const importDialog = page.getByRole("dialog", { name: "Import directory", exact: true });
    assert.equal(await importDialog.getByRole("checkbox", { name: "Include hidden directories", exact: true }).isChecked(), false);
    await importDialog.getByLabel("Base URL path", { exact: true }).fill("/");
    await importDialog.getByRole("button", { name: "Choose directory and upload", exact: true }).click();
    await importDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inspect /.nojekyll", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Inspect /.git/fixture.txt", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Import directory", exact: true }).click();
    assert.equal(await importDialog.getByRole("checkbox", { name: "Include hidden directories", exact: true }).isChecked(), false);
    await importDialog.getByLabel("Base URL path", { exact: true }).fill("/included/");
    await importDialog.getByText("Include hidden directories", { exact: true }).click();
    assert.equal(await importDialog.getByRole("checkbox", { name: "Include hidden directories", exact: true }).isChecked(), true);
    await page.screenshot({ path: join(artifacts, "directory-import-options.png"), animations: "disabled" });
    await importDialog.getByRole("button", { name: "Choose directory and upload", exact: true }).click();
    await importDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inspect /included/.git/fixture.txt", exact: true }).waitFor();
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    let preview = page.getByRole("dialog", { name: "/index.html", exact: true });
    const source = preview.getByLabel("Website content source", { exact: true });
    await source.waitFor();
    assert.equal(await source.evaluate((element) => Reflect.get(element, "readOnly")), true);
    const sourceLines = preview.locator(".view-lines");
    await sourceLines.filter({ hasText: /__WEBSITE_EXECUTED__/u }).waitFor();
    assert.match(await sourceLines.innerText(), /__WEBSITE_EXECUTED__/u);
    assert.ok(await sourceLines.locator('span[class*="mtk"]').count() > 5, "source has syntax tokens");
    const sourceBeforeTyping = await sourceLines.innerText();
    await source.focus();
    await page.keyboard.type("PREVIEW_MUST_STAY_READ_ONLY");
    assert.equal(await sourceLines.innerText(), sourceBeforeTyping);
    assert.equal(await preview.locator("script, iframe, webview, object, embed, img, a, form").count(), 0);
    assert.equal(await page.evaluate(() => Reflect.get(globalThis, "__WEBSITE_EXECUTED__")), undefined);
    assert.equal(await page.evaluate(async () => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot().then((snapshot) => snapshot.connection.status)), "connected");
    await page.screenshot({ path: join(artifacts, "inert-source-preview.png"), animations: "disabled" });

    for (const action of ["Edit text", "Replace from file", "Change content type", "Save copy", "Delete"]) {
      assert.equal(await preview.getByRole("button", { name: action, exact: true }).count(), 1,
        `the source modal retains its ${action} action`);
    }
    await preview.getByRole("button", { name: "Preview in browser", exact: true }).click();
    const previewUrl = await waitForExternalUrl(application, 1);
    const parsedPreview = new URL(previewUrl);
    assert.equal(parsedPreview.protocol, "http:");
    assert.equal(parsedPreview.hostname, "127.0.0.1");
    assert.notEqual(parsedPreview.port, "");
    assert.equal(parsedPreview.pathname, "/index.html");
    assert.equal(parsedPreview.username, "");
    assert.equal(parsedPreview.password, "");
    assert.equal(application.windows().length, 1, "browser preview never creates an Electron window");
    const documentResponse = await fetchPreview(previewUrl);
    assert.equal(documentResponse.status, 200);
    assert.match(documentResponse.headers.get("content-type") ?? "", /^text\/html(?:;|$)/u);
    assertUncached(documentResponse);
    assert.equal(await documentResponse.text(), hostedHtml);
    for (const [path, expected] of [["/site.css", stylesheet], ["/site.js", script]]) {
      const response = await fetchPreview(new URL(path!, previewUrl).href);
      assert.equal(response.status, 200);
      assertUncached(response);
      assert.equal(await response.text(), expected);
    }
    const binaryResponse = await fetchPreview(new URL("/asset.bin", previewUrl).href);
    assert.equal(binaryResponse.status, 200);
    assert.deepEqual(Buffer.from(await binaryResponse.arrayBuffer()), Buffer.from([0, 1, 2, 0xff]));

    // Use an owned, temporary browser profile rather than launching the operator's browser.
    const browserExecutable = [chromium.executablePath(), ...(process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : [])].find(existsSync);
    if (browserExecutable) {
      browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
      browserPreview = await browser.newPage();
      browserPreview.setDefaultTimeout(10_000);
      await browserPreview.goto(previewUrl);
      await browserPreview.getByRole("heading", { name: "Browser preview", exact: true }).waitFor();
      await browserPreview.getByText("External script loaded", { exact: true }).waitFor();
      assert.equal(await browserPreview.getByText("Static content", { exact: true })
        .evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).color), "rgb(30, 70, 120)");
      await browserPreview.getByRole("img", { name: "Hosted image", exact: true }).evaluate(async (element) => {
        await (element as unknown as { decode(): Promise<void> }).decode();
      });
      assert.deepEqual(await browserPreview.evaluate(() => ["sliver", "require", "process", "__WEBSITE_EXECUTED__"]
        .map((key) => typeof Reflect.get(globalThis, key))), ["undefined", "undefined", "undefined", "boolean"]);
      await browserPreview.screenshot({ path: join(artifacts, "browser-rendered-preview.png"), animations: "disabled" });
    } else {
      context.diagnostic("No installed Chromium executable: verified preview HTTP bytes and resources; browser rendering was unavailable.");
    }

    const exportedPath = join(root, "exported.html");
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedPath);
    await preview.getByRole("button", { name: "Save copy", exact: true }).click();
    await page.getByText("Saved index.html.", { exact: true }).waitFor();
    assert.equal(await readFile(exportedPath, "utf8"), hostedHtml);

    await preview.getByRole("button", { name: "Change content type", exact: true }).click();
    const mimeDialog = page.getByRole("dialog", { name: "Change content type", exact: true });
    await mimeDialog.getByLabel("Content type", { exact: true }).fill("text/plain; charset=utf-8");
    await mimeDialog.getByRole("button", { name: "Save content", exact: true }).click();
    await mimeDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    preview = page.getByRole("dialog", { name: "/index.html", exact: true });
    await preview.getByLabel("Website content source", { exact: true }).waitFor();
    await preview.locator(".view-lines").filter({ hasText: /__WEBSITE_EXECUTED__/u }).waitFor();
    assert.match(await preview.locator(".view-lines").innerText(), /__WEBSITE_EXECUTED__/u,
      "content-type updates preserve stored bytes");
    await preview.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("button", { name: "Actions for /index.html", exact: true }).click();
    const contentMenu = page.getByRole("menu", { name: "Actions for /index.html", exact: true });
    for (const action of ["Edit", "Replace", "Change content type", "Save copy", "Delete"]) {
      assert.equal(await contentMenu.getByRole("menuitem", { name: action, exact: true }).count(), 1);
    }
    await page.screenshot({ path: join(artifacts, "content-actions.png"), animations: "disabled" });
    const editorOpened = application.waitForEvent("window");
    await contentMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = await editorOpened;
    await prepareWebsiteEditor(application, editor, errors);
    assert.equal(await page.getByRole("dialog", { name: "Edit content", exact: true }).count(), 0,
      "editing opens the existing standalone editor instead of a modal");
    await editor.locator(".view-lines").filter({ hasText: /__WEBSITE_EXECUTED__/u }).waitFor();
    const editorInput = editor.getByRole("textbox", { name: "Document text", exact: true });
    assert.notEqual(await editorInput.getAttribute("aria-readonly"), "true");
    assert.ok(await editor.locator('.view-lines span[class*="mtk"]').count() > 5, "editor has real syntax tokens");
    assert.equal(await editor.evaluate(() => Reflect.get(globalThis, "__WEBSITE_EXECUTED__")), undefined,
      "hosted scripts stay inert in the standalone editor");
    await editor.screenshot({ path: join(artifacts, "standalone-website-editor.png"), animations: "disabled" });
    await editorInput.focus();
    await editor.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await editor.keyboard.insertText("Updated website content");
    await editor.getByText("Unsaved changes", { exact: true }).waitFor();
    const nativeEditor = await application.browserWindow(editor);
    await waitUntil(async () => (await nativeEditor.evaluate((window) => window.getTitle())).startsWith("● "));
    const editorId = await nativeEditor.evaluate((window) => window.id);
    const closePrompts = await application.evaluate(({ BrowserWindow, dialog }, windowId) => {
      const original = dialog.showMessageBoxSync;
      const prompts: string[] = [];
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args[args.length - 1] as { message: string; buttons: string[] };
        prompts.push(options.message);
        return options.buttons.indexOf("Cancel");
      };
      try { BrowserWindow.fromId(windowId)!.close(); }
      finally { dialog.showMessageBoxSync = original; }
      return prompts;
    }, editorId);
    assert.equal(closePrompts.length, 1);
    assert.match(closePrompts[0]!, /^Discard changes to /u);
    assert.equal(editor.isClosed(), false, "canceling the native close preserves the unsaved website draft");
    await editor.getByText("Unsaved changes", { exact: true }).waitFor();
    assert.equal(await (await fetchPreview(previewUrl)).text(), hostedHtml, "the draft does not change hosted content before Save");
    await editor.screenshot({ path: join(artifacts, "monaco-content-editor.png"), animations: "disabled" });
    await application.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { __websiteOverwriteTitles?: string[] };
      state.__websiteOverwriteTitles = [];
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args[args.length - 1] as { title: string; buttons: string[] };
        if (options.title !== "Replace hosted content?") throw new Error("Unexpected native website confirmation");
        state.__websiteOverwriteTitles?.push(options.title);
        const response = options.buttons.indexOf("Replace content");
        if (response < 0) throw new Error("Missing website overwrite confirmation");
        return { response, checkboxChecked: false };
      };
    });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.getByText("Saved", { exact: true }).waitFor();
    assert.deepEqual(await application.evaluate(() =>
      (globalThis as unknown as { __websiteOverwriteTitles?: string[] }).__websiteOverwriteTitles), ["Replace hosted content?"]);
    await closeWebsiteEditor(application, editor);
    const updatedResponse = await fetchPreview(previewUrl, { headers: { "If-None-Match": "old-content", "If-Modified-Since": new Date().toUTCString() } });
    assert.equal(updatedResponse.status, 200, "conditional requests must still fetch fresh content");
    assertUncached(updatedResponse);
    assert.equal(updatedResponse.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await updatedResponse.text(), "Updated website content", "the existing browser URL fetches the saved bytes");
    if (browserPreview) {
      await browserPreview.reload();
      await browserPreview.getByText("Updated website content", { exact: true }).waitFor();
    }
    await page.getByRole("button", { name: "Preview website", exact: true }).click();
    const directPreviewUrl = await waitForExternalUrl(application, 2);
    assert.equal(new URL(directPreviewUrl).pathname, "/index.html", "website preview opens its index path");
    assert.equal(await page.getByRole("dialog", { name: "/index.html", exact: true }).count(), 0,
      "website preview opens the browser without requiring the source modal");
    await page.screenshot({ path: join(artifacts, "website-header-actions.png"), animations: "disabled" });
    assert.equal(await (await fetchPreview(directPreviewUrl)).text(), "Updated website content");
    await page.getByRole("button", { name: "Actions for /index.html", exact: true }).click();
    await page.getByRole("menu", { name: "Actions for /index.html", exact: true })
      .getByRole("menuitem", { name: "Save copy", exact: true }).click();
    await page.getByText("Saved index.html.", { exact: true }).waitFor();
    assert.equal(await readFile(exportedPath, "utf8"), "Updated website content");
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    preview = page.getByRole("dialog", { name: "/index.html", exact: true });
    await preview.getByLabel("Website content source", { exact: true }).waitFor();
    await preview.locator(".view-lines").filter({ hasText: /Updated/u }).waitFor();
    assert.match((await preview.locator(".view-lines").innerText()).replaceAll("\u00a0", " "), /Updated website content/u);
    await preview.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("button", { name: "Inspect /asset.bin", exact: true }).click();
    const binaryPreview = page.getByRole("dialog", { name: "/asset.bin", exact: true });
    assert.match(await binaryPreview.getByLabel("Website content hex", { exact: true }).textContent() ?? "", /00 01 02 ff/u);
    assert.equal(await binaryPreview.getByRole("button", { name: "Edit text", exact: true }).isDisabled(), true);
    await binaryPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await page.getByRole("button", { name: "Actions for /asset.bin", exact: true }).click();
    const binaryMenu = page.getByRole("menu", { name: "Actions for /asset.bin", exact: true });
    // Unknown extensions use the server's default textual MIME, but the bytes
    // still must be validated before an editor can open.
    await binaryMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await page.getByText("The website editor requires complete, valid UTF-8 text", { exact: true }).waitFor();
    assert.equal(application.windows().length, 1, "binary bytes must not open a text editor window");
    await page.getByRole("button", { name: "Actions for /asset.bin", exact: true }).click();
    const replacement = Buffer.from([0xff, 0xfe, 0x02, 0x00]);
    const replacementPath = join(root, "replacement.bin");
    await writeFile(replacementPath, replacement);
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, replacementPath);
    await binaryMenu.getByRole("menuitem", { name: "Replace", exact: true }).click();
    const replaceDialog = page.getByRole("dialog", { name: "Replace content", exact: true });
    await replaceDialog.getByRole("button", { name: "Choose file and upload", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Replace hosted content?", exact: true })
      .getByRole("button", { name: "Replace content", exact: true }).click();
    await replaceDialog.waitFor({ state: "hidden" });
    const replacedResponse = await fetchPreview(new URL("/asset.bin", directPreviewUrl).href);
    assert.equal(replacedResponse.status, 200);
    assert.deepEqual(Buffer.from(await replacedResponse.arrayBuffer()), replacement);
    await page.getByRole("button", { name: "Actions for /asset.bin", exact: true }).click();
    await page.getByRole("menu", { name: "Actions for /asset.bin", exact: true })
      .getByRole("menuitem", { name: "Change content type", exact: true }).click();
    await mimeDialog.getByLabel("Content type", { exact: true }).fill("application/x-fixture");
    await mimeDialog.getByRole("button", { name: "Save content", exact: true }).click();
    await mimeDialog.waitFor({ state: "hidden" });
    const retypedResponse = await fetchPreview(new URL("/asset.bin", directPreviewUrl).href);
    assert.equal(retypedResponse.headers.get("content-type"), "application/x-fixture");
    assert.deepEqual(Buffer.from(await retypedResponse.arrayBuffer()), replacement);
    await page.getByRole("button", { name: "Actions for /asset.bin", exact: true }).click();
    assert.equal(await binaryMenu.getByRole("menuitem", { name: "Edit", exact: true }).getAttribute("aria-disabled"), "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Preview /pixel.png", exact: true }).click();
    const imagePreviewUrl = await waitForExternalUrl(application, 3);
    const imageResponse = await fetchPreview(imagePreviewUrl);
    assert.equal(imageResponse.status, 200);
    assert.match(imageResponse.headers.get("content-type") ?? "", /^image\/png(?:;|$)/u);
    assertUncached(imageResponse);
    assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), await readFile(join(root, "upload", "pixel.png")));
    await page.screenshot({ path: join(artifacts, "website-content.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Actions for /asset.bin", exact: true }).click();
    await page.getByRole("menu", { name: "Actions for /asset.bin", exact: true }).getByRole("menuitem", { name: "Delete", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete hosted content?", exact: true }).getByRole("button", { name: "Delete content", exact: true }).click();
    await page.getByRole("button", { name: "Inspect /asset.bin", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inspect /bom.txt", exact: true }).click();
    const bomEditorOpened = application.waitForEvent("window");
    await page.getByRole("dialog", { name: "/bom.txt", exact: true }).getByRole("button", { name: "Edit text", exact: true }).click();
    const bomEditor = await bomEditorOpened;
    await prepareWebsiteEditor(application, bomEditor, errors);
    await bomEditor.locator(".view-lines").filter({ hasText: /second/u }).waitFor();
    await bomEditor.getByRole("textbox", { name: "Document text", exact: true }).focus();
    await bomEditor.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
    await bomEditor.keyboard.insertText("!");
    await bomEditor.getByRole("button", { name: "Save", exact: true }).click();
    await bomEditor.getByText("Saved", { exact: true }).waitFor();
    await closeWebsiteEditor(application, bomEditor);
    const bomResponse = await fetchPreview(new URL("/bom.txt", imagePreviewUrl).href);
    assert.equal(bomResponse.status, 200);
    assert.deepEqual(Buffer.from(await bomResponse.arrayBuffer()), Buffer.from(`${bomText}!`, "utf8"),
      "editing preserves the UTF-8 BOM exactly once and the existing CRLF line endings");
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    const addTextDialog = page.getByRole("dialog", { name: "Add text content", exact: true });
    await addTextDialog.getByLabel("URL path", { exact: true }).fill("/created.txt");
    await addTextDialog.getByLabel("Content type", { exact: true }).fill("text/plain; charset=utf-8");
    assert.equal(await addTextDialog.locator(".monaco-editor, textarea").count(), 0,
      "the Add text modal collects destination metadata only");
    const createEditorOpened = application.waitForEvent("window");
    await addTextDialog.getByRole("button", { name: "Open editor", exact: true }).click();
    await addTextDialog.waitFor({ state: "hidden" });
    const createEditor = await createEditorOpened;
    await prepareWebsiteEditor(application, createEditor, errors);
    await createEditor.getByRole("textbox", { name: "Document text", exact: true }).focus();
    await createEditor.keyboard.insertText("Created website content");
    await createEditor.getByRole("button", { name: "Save", exact: true }).click();
    await createEditor.getByText("Saved", { exact: true }).waitFor();
    await closeWebsiteEditor(application, createEditor);
    await page.getByRole("button", { name: "Inspect /created.txt", exact: true }).waitFor();
    const createdResponse = await fetchPreview(new URL("/created.txt", imagePreviewUrl).href);
    assert.equal(createdResponse.status, 200);
    assert.equal(createdResponse.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await createdResponse.text(), "Created website content");
    assert.deepEqual(await application.evaluate(() =>
      (globalThis as unknown as { __websiteOverwriteTitles?: string[] }).__websiteOverwriteTitles),
    ["Replace hosted content?", "Replace hosted content?"], "creating a new path needs no overwrite confirmation");
    await page.getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete website?", exact: true }).getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("button", { name: /^preview-test/u }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /^landing/u }).click();
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    await page.getByRole("dialog", { name: "/index.html", exact: true }).getByRole("button", { name: "Preview in browser", exact: true }).click();
    const closingPreviewUrl = await waitForExternalUrl(application, 4);
    assert.match(await (await fetchPreview(closingPreviewUrl)).text(), /Welcome/u);
    await page.evaluate(async () => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.disconnect());
    await assert.rejects(fetchPreview(closingPreviewUrl), "disconnect revokes the loopback server");
    assert.equal(page.url(), "sliver://app/index.html");
    assert.equal(application.windows().length, 1);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = error;
    await application?.windows()[0]?.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => {});
    for (const editor of application?.windows().slice(1) ?? []) {
      if (!editor.isClosed()) await editor.screenshot({ path: join(artifacts, "editor-failure.png"), animations: "disabled" }).catch(() => {});
    }
    throw error;
  } finally {
    await browser?.close();
    await application?.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (...args: unknown[]) => {
        const options = args[args.length - 1] as { buttons?: string[] };
        return Math.max(0, options.buttons?.indexOf("Discard Changes") ?? 0);
      };
    }).catch(() => {});
    try { if (application) await cleanupOwnedApplication(application, "website fixture", 5_000); }
    catch (error) { if (failure) attachCleanupFailure(failure, error); else throw error; }
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForExternalUrl(application: ElectronApplication, expectedCount: number): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const urls = await application.evaluate(() =>
      (globalThis as unknown as { __websiteExternalUrls?: string[] }).__websiteExternalUrls ?? []);
    if (urls.length >= expectedCount) {
      assert.equal(urls.length, expectedCount);
      return urls[expectedCount - 1]!;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected browser preview URL ${expectedCount}`);
}

function fetchPreview(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, cache: "no-store", signal: AbortSignal.timeout(5_000) });
}

function assertUncached(response: Response): void {
  assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
  assert.equal(response.headers.get("etag"), null);
  assert.equal(response.headers.get("last-modified"), null);
}

async function prepareWebsiteEditor(application: ElectronApplication, page: Page, errors: string[]): Promise<void> {
  page.setDefaultTimeout(10_000);
  page.on("dialog", (dialog) => { void dialog.accept().catch(() => undefined); });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator(".monaco-editor").waitFor();
  // The existing editor uses Monaco's native EditContext accessibility element,
  // which intentionally has no layout box until focused.
  await page.getByRole("textbox", { name: "Document text", exact: true }).waitFor({ state: "attached" });
  assert.equal(new URL(page.url()).searchParams.get("surface"), "text-editor");
  assert.deepEqual(await page.evaluate(() => {
    const state = globalThis as unknown as { textEditor: TextEditorAPI; sliver?: unknown; network?: unknown; armory?: unknown };
    return { frozen: Object.isFrozen(state.textEditor), sliver: typeof state.sliver,
      network: typeof state.network, armory: typeof state.armory };
  }), { frozen: true, sliver: "undefined", network: "undefined", armory: "undefined" });
  const document = await page.evaluate(() =>
    (globalThis as unknown as { textEditor: TextEditorAPI }).textEditor.getDocument());
  assert.equal(document.ok, true);
  if (document.ok) {
    assert.equal(document.value.website, true, "the editor keeps its main-owned website save destination");
    assert.equal(document.value.readOnly, false);
  }
  assert.equal(await page.getByRole("button", { name: "Open…", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Save As…", exact: true }).count(), 0);
  const native = await application.browserWindow(page);
  assert.deepEqual(await native.evaluate((window) => {
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
}

async function closeWebsiteEditor(application: ElectronApplication, page: Page): Promise<void> {
  const native = await application.browserWindow(page);
  const closed = page.waitForEvent("close", { timeout: 10_000 });
  await native.evaluate((window) => window.close());
  await closed;
}

async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Website editor state did not settle");
}
