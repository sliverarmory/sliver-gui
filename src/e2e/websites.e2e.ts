import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("hosted websites support CRUD, read-only source, and isolated static rendering", { timeout: 90_000 }, async (context) => {
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
  const hostile = [
    "<!doctype html><html><head>",
    '<base href="https://website-preview.invalid/">',
    '<meta http-equiv="refresh" content="0;url=https://website-preview.invalid/redirect">',
    '<style>@import url("https://website-preview.invalid/style");</style>',
    '</head><body onload="window.__WEBSITE_EXECUTED__=true">',
    '<h1>Rendered safely</h1><p style="color:rgb(30,70,120)">Static content</p>',
    '<script>window.__WEBSITE_EXECUTED__=true;window.sliver.disconnect();fetch("https://website-preview.invalid/leak");</script>',
    '<img src="https://website-preview.invalid/image" onerror="window.__WEBSITE_EXECUTED__=true">',
    '<iframe src="file:///etc/passwd"></iframe><object data="https://website-preview.invalid/object"></object>',
    '<svg onload="window.__WEBSITE_EXECUTED__=true"><image href="https://website-preview.invalid/svg"/></svg>',
    '<a href="javascript:window.__WEBSITE_EXECUTED__=true">unsafe link</a>',
    '<form action="https://website-preview.invalid/form"><input autofocus></form>',
    '</body></html>',
  ].join("\n");
  await writeFile(join(root, "upload", "index.html"), hostile);
  await writeFile(join(root, "upload", "asset.bin"), Buffer.from([0, 1, 2, 0xff]));
  await mkdir(join(root, "upload", ".git"));
  await writeFile(join(root, "upload", ".git", "fixture.txt"), "Hidden directory fixture");
  await writeFile(join(root, "upload", ".nojekyll"), "Dot file fixture");
  await writeFile(join(root, "upload", "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQc6v4DwADPgHc8bhcNQAAAABJRU5ErkJggg==", "base64"));
  let application: ElectronApplication | undefined;
  let failure: unknown;
  try {
    application = await electron.launch({
      args: ["--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`, `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`],
      cwd: repositoryRoot, bypassCSP: false, timeout: 20_000,
    });
    const process = application.process();
    context.signal.addEventListener("abort", () => process.kill("SIGKILL"), { once: true });
    const page = await application.firstWindow();
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
    await page.getByRole("treegrid", { name: "Operational navigation" }).getByRole("row", { name: "Websites" }).click();
    await page.getByRole("heading", { name: "Websites", exact: true, level: 1 }).waitFor();

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

    const renderedPromise = application.waitForEvent("window");
    await preview.getByRole("button", { name: "Rendered preview", exact: true }).click();
    const rendered = await renderedPromise;
    rendered.setDefaultTimeout(10_000);
    rendered.on("request", (request) => {
      if (/^(?:https?:|file:)/u.test(request.url())) externalRequests.push(request.url());
    });
    await rendered.getByRole("heading", { name: "Rendered safely", exact: true }).waitFor();
    assert.match(rendered.url(), /^website-preview:\/\/[a-f0-9]{64}\/document$/u);
    assert.equal(await rendered.locator("script, iframe, webview, object, embed, img, form, input, svg, base, link").count(), 0);
    assert.equal(await rendered.locator("[href], [src], [onload], [onerror], [autofocus]").count(), 0);
    assert.equal(await rendered.getByText("Static content", { exact: true }).evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).color), "rgb(30, 70, 120)");
    assert.deepEqual(await rendered.evaluate(() => ["sliver", "require", "process", "__WEBSITE_EXECUTED__"].map((key) => typeof Reflect.get(globalThis, key))), ["undefined", "undefined", "undefined", "undefined"]);
    const renderedWindow = await application.browserWindow(rendered);
    const isolation = await renderedWindow.evaluate((window) => {
      const preferences = window.webContents.getLastWebPreferences();
      return {
        javascript: preferences.javascript, sandbox: preferences.sandbox,
        contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
        webSecurity: preferences.webSecurity, webviewTag: preferences.webviewTag,
        preload: preferences.preload,
        preloads: window.webContents.session.getPreloadScripts(), persistent: window.webContents.session.isPersistent(),
      };
    });
    assert.deepEqual(isolation, {
      javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, webviewTag: false, preload: undefined, preloads: [], persistent: false,
    });
    assert.equal(await renderedWindow.evaluate(async (window) => {
      window.webContents.openDevTools();
      await new Promise((resolve) => setTimeout(resolve, 100));
      return window.webContents.isDevToolsOpened();
    }), false);
    const blockedLoads = await renderedWindow.evaluate(async (window) => {
      const urls = ["sliver://app/index.html", "file:///etc/passwd", "https://website-preview.invalid/escape", "data:text/html,escape"];
      return Promise.all(urls.map(async (url) => {
        try { await window.loadURL(url); return false; } catch { return true; }
      }));
    });
    assert.deepEqual(blockedLoads, [true, true, true, true]);
    assert.equal(await renderedWindow.evaluate((window) => window.getTitle()), "Website preview");
    await rendered.screenshot({ path: join(artifacts, "isolated-rendered-preview.png"), animations: "disabled" });
    await rendered.close();

    const exportedPath = join(root, "exported.html");
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, exportedPath);
    await preview.getByRole("button", { name: "Save copy", exact: true }).click();
    await page.getByText("Saved index.html.", { exact: true }).waitFor();
    assert.equal(await readFile(exportedPath, "utf8"), hostile);

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
    await preview.getByRole("button", { name: "Edit text", exact: true }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit content", exact: true });
    assert.equal(await editDialog.getByLabel("Content source", { exact: true }).inputValue(), hostile);
    await editDialog.getByLabel("Content source", { exact: true }).fill("Updated website content");
    await editDialog.getByRole("button", { name: "Save content", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Replace hosted content?", exact: true }).getByRole("button", { name: "Replace content", exact: true }).click();
    await editDialog.waitFor({ state: "hidden" });
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
    await page.getByRole("button", { name: "Inspect /pixel.png", exact: true }).click();
    const imagePreviewPromise = application.waitForEvent("window");
    await page.getByRole("dialog", { name: "/pixel.png", exact: true }).getByRole("button", { name: "Rendered preview", exact: true }).click();
    const imagePreview = await imagePreviewPromise;
    const image = imagePreview.getByRole("img", { name: "Hosted image preview", exact: true });
    await image.waitFor();
    await image.evaluate(async (element) => {
      const raster = element as unknown as { decode(): Promise<void> };
      await raster.decode();
    });
    assert.equal(await image.evaluate((element) => Reflect.get(element, "naturalWidth")), 1);
    await imagePreview.close();
    await page.getByRole("dialog", { name: "/pixel.png", exact: true }).getByRole("button", { name: "Close", exact: true }).last().click();
    await page.screenshot({ path: join(artifacts, "website-content.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Delete /asset.bin", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete hosted content?", exact: true }).getByRole("button", { name: "Delete content", exact: true }).click();
    await page.getByRole("button", { name: "Inspect /asset.bin", exact: true }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete website?", exact: true }).getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("button", { name: /^preview-test/u }).waitFor({ state: "hidden" });
    await page.getByRole("button", { name: /^landing/u }).click();
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    const closingPreviewPromise = application.waitForEvent("window");
    await page.getByRole("dialog", { name: "/index.html", exact: true }).getByRole("button", { name: "Rendered preview", exact: true }).click();
    const closingPreview = await closingPreviewPromise;
    await closingPreview.getByRole("heading", { name: "Welcome", exact: true }).waitFor();
    const closedPromise = closingPreview.waitForEvent("close");
    await page.evaluate(async () => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.disconnect());
    await closedPromise;
    assert.equal(page.url(), "sliver://app/index.html");
    assert.equal(application.windows().length, 1);
    assert.deepEqual(externalRequests, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    failure = error;
    await application?.windows()[0]?.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => {});
    throw error;
  } finally {
    try { if (application) await cleanupOwnedApplication(application, "website fixture", 5_000); }
    catch (error) { if (failure) attachCleanupFailure(failure, error); else throw error; }
    await rm(root, { recursive: true, force: true });
  }
});
