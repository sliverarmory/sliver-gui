import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { chromium, _electron as electron, type Browser, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { TextEditorAPI } from "../shared/text-editor-contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

interface WebsiteDropOverwritePrompt {
  ownerId: number;
  title: string;
  type: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
}

interface WebsiteDropOverwriteState {
  __websiteDropOverwritePrompts: WebsiteDropOverwritePrompt[];
  __websiteDropOverwriteResponse?: (response: number) => void;
}

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
  await writeFile(join(root, "upload", ".empty-marker"), "");
  await writeFile(join(root, "upload", "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGOQc6v4DwADPgHc8bhcNQAAAABJRU5ErkJggg==", "base64"));
  const droppedText = "A file dropped at the website root";
  const droppedHtml = "<!doctype html><h1>Dropped website document</h1>";
  const droppedCss = "body { color: rgb(20, 40, 60); }";
  const droppedScript = 'document.body.dataset.dropped = "yes";';
  const droppedNested = "Nested directory content";
  const droppedDirectory = join(root, "drop-folder");
  const droppedFile = join(root, "drop-note.txt");
  const droppedExtraFile = join(root, "drop-extra.txt");
  const droppedApprovedFile = join(root, "drop-approved.txt");
  const droppedSkippedNewFile = join(root, "drop-skipped-new.txt");
  const droppedReplacementText = "A replacement approved in the overwrite prompt";
  const droppedApprovedText = "A new file uploaded with the approved replacement";
  const droppedSkippedNewText = "A new file uploaded while existing files are skipped";
  await mkdir(join(droppedDirectory, "nested"), { recursive: true });
  await mkdir(join(droppedDirectory, ".private"));
  await Promise.all([
    writeFile(droppedFile, droppedText),
    writeFile(droppedExtraFile, "A second file in the same native drop"),
    writeFile(join(droppedDirectory, "dropped.html"), droppedHtml),
    writeFile(join(droppedDirectory, "dropped.css"), droppedCss),
    writeFile(join(droppedDirectory, "dropped.js"), droppedScript),
    writeFile(join(droppedDirectory, "dropped.png"), await readFile(join(root, "upload", "pixel.png"))),
    writeFile(join(droppedDirectory, "nested", "drop-data.txt"), droppedNested),
    writeFile(join(droppedDirectory, ".private", "hidden.txt"), "Hidden directory stays local"),
    writeFile(join(droppedDirectory, ".drop-marker"), "A dropped dot file"),
    writeFile(join(droppedDirectory, ".empty-drop-marker"), ""),
    writeFile(join(droppedDirectory, "nested", "empty.txt"), ""),
  ]);
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
    assert.equal(await page.getByRole("button", { name: "Inspect /.empty-marker", exact: true }).count(), 0,
      "native directory imports skip empty marker files while importing non-empty content");
    await page.getByRole("button", { name: "Import directory", exact: true }).click();
    assert.equal(await importDialog.getByRole("checkbox", { name: "Include hidden directories", exact: true }).isChecked(), false);
    await importDialog.getByLabel("Base URL path", { exact: true }).fill("/included/");
    await importDialog.getByText("Include hidden directories", { exact: true }).click();
    assert.equal(await importDialog.getByRole("checkbox", { name: "Include hidden directories", exact: true }).isChecked(), true);
    await page.screenshot({ path: join(artifacts, "directory-import-options.png"), animations: "disabled" });
    await importDialog.getByRole("button", { name: "Choose directory and upload", exact: true }).click();
    await importDialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Inspect /included/.git/fixture.txt", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Inspect /included/.empty-marker", exact: true }).count(), 0,
      "including hidden directories does not import empty files");

    // CDP supplies native-backed File objects, including a directory root, without a file picker.
    await application.evaluate(({ dialog }) => {
      const state = globalThis as unknown as { __websiteDropDialogCalls?: number };
      state.__websiteDropDialogCalls = 0;
      dialog.showOpenDialog = async () => {
        state.__websiteDropDialogCalls = (state.__websiteDropDialogCalls ?? 0) + 1;
        return { canceled: true, filePaths: [] };
      };
    });
    const websiteDropTarget = page.locator(".drop-zone__area").filter({
      has: page.getByRole("button", { name: "Upload files or directories to preview-test", exact: true }),
    });
    await observeWebsiteUploadPending(websiteDropTarget);
    const writesBeforeSingleDrop = await websiteWriteCount(application);
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.holdWebsiteAddContent());
    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedFile]);
    await waitForHeldWebsiteWrite(application);
    await page.getByText("Uploading website content…", { exact: true }).waitFor();
    await assertNoWebsiteUploadProgress(page);
    assert.equal(await websiteWriteCount(application), writesBeforeSingleDrop,
      "a single native drop remains pending before its write completes");
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseWebsiteAddContentHold());
    await page.getByRole("button", { name: "Inspect /drop-note.txt", exact: true }).waitFor();
    await page.getByText("Uploading website content…", { exact: true }).waitFor({ state: "hidden" });
    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedExtraFile]);
    await page.getByRole("button", { name: "Inspect /drop-extra.txt", exact: true }).waitFor();
    await page.getByText("Uploading website content…", { exact: true }).waitFor({ state: "hidden" });
    const writesBeforeDirectoryDrop = await websiteWriteCount(application);
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.holdWebsiteAddContent(1));
    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedDirectory], join(artifacts, "website-directory-drop.png"));
    await waitForHeldWebsiteWrite(application);
    await assertWebsiteUploadProgress(page, 1, 6);
    assert.equal(await websiteWriteCount(application), writesBeforeDirectoryDrop + 1,
      "directory progress counts only the first acknowledged file while the second write is held");
    await page.screenshot({ path: join(artifacts, "website-upload-progress.png"), animations: "disabled" });
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseWebsiteAddContentHold());
    for (const path of ["/dropped.html", "/dropped.css", "/dropped.js", "/dropped.png", "/nested/drop-data.txt", "/.drop-marker"]) {
      await page.getByRole("button", { name: `Inspect ${path}`, exact: true }).waitFor();
    }
    await page.getByText("Website content uploaded.", { exact: true }).waitFor();
    assert.equal(await websiteWriteCount(application), writesBeforeDirectoryDrop + 6,
      "each non-empty directory file is uploaded once");
    await assertNoWebsiteUploadProgress(page);
    assert.equal(await websiteDropTarget.getAttribute("data-e2e-upload-pending"), "observed",
      "native drops display upload progress before completing");
    assert.equal(await page.getByRole("button", { name: "Inspect /drop-folder/dropped.html", exact: true }).count(), 0,
      "dropping a directory maps its contents directly beneath the website root");
    assert.equal(await page.getByRole("button", { name: "Inspect /.private/hidden.txt", exact: true }).count(), 0,
      "native directory drops skip hidden subdirectories by default");
    for (const path of ["/.empty-drop-marker", "/nested/empty.txt"]) {
      assert.equal(await page.getByRole("button", { name: `Inspect ${path}`, exact: true }).count(), 0,
        "directory drops skip empty files at every depth without failing the upload");
    }
    assert.equal(await page.getByRole("button", { name: /^preview-test/u }).getAttribute("aria-pressed"), "true");
    assert.equal(await application.evaluate(() =>
      (globalThis as unknown as { __websiteDropDialogCalls?: number }).__websiteDropDialogCalls), 0,
    "native drops upload immediately without opening a file picker");
    assert.equal((await page.locator("body").innerText()).includes(droppedDirectory), false,
      "native source paths are not rendered");

    await application.evaluate(({ dialog }) => {
      const state = globalThis as unknown as WebsiteDropOverwriteState;
      state.__websiteDropOverwritePrompts = [];
      dialog.showMessageBox = async (...args: unknown[]) => {
        const options = args[args.length - 1] as Omit<WebsiteDropOverwritePrompt, "ownerId">;
        if (options.title !== "Overwrite website files?") throw new Error("Unexpected native dropped-file confirmation");
        state.__websiteDropOverwritePrompts.push({
          ownerId: (args[0] as { id: number }).id,
          title: options.title, type: options.type, message: options.message, detail: options.detail,
          buttons: options.buttons, defaultId: options.defaultId, cancelId: options.cancelId,
        });
        if (state.__websiteDropOverwriteResponse) throw new Error("Overlapping dropped-file confirmations");
        return new Promise<{ response: number; checkboxChecked: boolean }>((resolve) => {
          state.__websiteDropOverwriteResponse = (response) => {
            delete state.__websiteDropOverwriteResponse;
            resolve({ response, checkboxChecked: false });
          };
        });
      };
    });
    await writeFile(droppedFile, droppedReplacementText);
    await writeFile(droppedApprovedFile, droppedApprovedText);
    const writesBeforeOverwrite = await websiteWriteCount(application);
    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedFile, droppedApprovedFile]);
    const overwritePrompt = await waitForWebsiteDropOverwrite(application, 1);
    await page.getByText("Uploading website content…", { exact: true }).waitFor();
    await assertNoWebsiteUploadProgress(page);
    await page.screenshot({ path: join(artifacts, "website-uploading.png"), animations: "disabled" });
    const ownerId = await (await application.browserWindow(page)).evaluate((window) => window.id);
    assert.equal(overwritePrompt.ownerId, ownerId, "overwrite confirmation belongs to the source window");
    assert.equal(overwritePrompt.title, "Overwrite website files?");
    assert.equal(overwritePrompt.type, "warning");
    assert.deepEqual(overwritePrompt.buttons, ["Cancel", "Overwrite", "Skip existing"]);
    assert.equal(overwritePrompt.defaultId, 0, "the safe default is Cancel");
    assert.equal(overwritePrompt.cancelId, 0);
    assert.match(overwritePrompt.message, /preview-test/u);
    assert.match(overwritePrompt.message, /\b1\b/u);
    assert.match(overwritePrompt.detail, /\/drop-note\.txt/u);
    assert.match(overwritePrompt.detail, /Overwrite replaces these files and uploads any new files in this drop/u);
    assert.match(overwritePrompt.detail, /Cancel leaves the website unchanged/u);
    assert.equal(overwritePrompt.detail.includes(droppedFile), false, "the confirmation lists website paths, not local source paths");
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite,
      "no part of a mixed new-and-existing drop uploads before the decision");
    assert.equal(await readWebsiteText(page, "/drop-note.txt"), droppedText);
    assert.equal(await page.getByRole("button", { name: "Inspect /drop-approved.txt", exact: true }).count(), 0);
    await resolveWebsiteDropOverwrite(application, 0);
    await page.getByText("Uploading website content…", { exact: true }).waitFor({ state: "hidden" });
    await assertNoWebsiteUploadProgress(page);
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite, "Cancel uploads none of the dropped batch");
    assert.equal(await readWebsiteText(page, "/drop-note.txt"), droppedText, "Cancel preserves the existing file bytes");
    assert.equal(await page.getByRole("button", { name: "Inspect /drop-approved.txt", exact: true }).count(), 0);
    assert.deepEqual(await page.locator(".websites-page").getByRole("alert").allTextContents(), [],
      "canceling an overwrite does not display a website error");

    await writeFile(droppedSkippedNewFile, droppedSkippedNewText);
    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedFile, droppedSkippedNewFile]);
    const skipPrompt = await waitForWebsiteDropOverwrite(application, 2);
    assert.deepEqual(skipPrompt.buttons, ["Cancel", "Overwrite", "Skip existing"]);
    assert.match(skipPrompt.detail, /\/drop-note\.txt/u);
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite);
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.holdWebsiteAddContent());
    await resolveWebsiteDropOverwrite(application, 2);
    await waitForHeldWebsiteWrite(application);
    await assertWebsiteUploadProgress(page, 0, 1);
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite,
      "Skip existing excludes the conflicting file from the total and waits for the new file to finish");
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseWebsiteAddContentHold());
    await page.getByRole("button", { name: "Inspect /drop-skipped-new.txt", exact: true }).waitFor();
    await page.getByRole("progressbar", { name: "Website upload progress", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite + 1,
      "Skip existing uploads the new part of the staged batch once");
    assert.equal(await readWebsiteText(page, "/drop-note.txt"), droppedText,
      "Skip existing preserves conflicting website bytes");
    assert.equal(await readWebsiteText(page, "/drop-skipped-new.txt"), droppedSkippedNewText);
    assert.equal(await page.getByRole("button", { name: "Inspect /drop-approved.txt", exact: true }).count(), 0,
      "Skip existing does not revive files from a canceled drop");
    assert.deepEqual(await page.locator(".websites-page").getByRole("alert").allTextContents(), [],
      "skipping existing files does not display a website error");

    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedFile]);
    await waitForWebsiteDropOverwrite(application, 3);
    await assertNoWebsiteUploadProgress(page);
    await resolveWebsiteDropOverwrite(application, 2);
    await page.getByText("Uploading website content…", { exact: true }).waitFor({ state: "hidden" });
    await assertNoWebsiteUploadProgress(page);
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite + 1,
      "Skip existing performs no write when every dropped path already exists");
    assert.equal(await readWebsiteText(page, "/drop-note.txt"), droppedText);
    assert.deepEqual(await page.locator(".websites-page").getByRole("alert").allTextContents(), [],
      "an all-existing skip finishes without a website error");

    await dropNativeWebsitePaths(page, websiteDropTarget, [droppedFile, droppedApprovedFile]);
    const approvedPrompt = await waitForWebsiteDropOverwrite(application, 4);
    assert.deepEqual(approvedPrompt, overwritePrompt);
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite + 1);
    await writeFile(droppedFile, "Local edits after confirmation opened are not part of the staged drop");
    await writeFile(droppedApprovedFile, "Later local edits must not replace the staged new file");
    await resolveWebsiteDropOverwrite(application, 1);
    await page.getByRole("button", { name: "Inspect /drop-approved.txt", exact: true }).waitFor();
    await page.getByText("Website content uploaded.", { exact: true }).waitFor();
    assert.equal(await websiteWriteCount(application), writesBeforeOverwrite + 3,
      "Overwrite uploads each file in the original staged batch once without another drop");
    assert.equal(await readWebsiteText(page, "/drop-note.txt"), droppedReplacementText);
    assert.equal(await readWebsiteText(page, "/drop-approved.txt"), droppedApprovedText);
    assert.deepEqual(await page.locator(".websites-page").getByRole("alert").allTextContents(), [],
      "approving an overwrite does not display a website error");
    assert.equal(await page.getByRole("button", { name: /^preview-test/u }).getAttribute("aria-pressed"), "true");

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
    for (const [path, expected, mime] of [
      ["/drop-note.txt", droppedReplacementText, /^text\/plain(?:;|$)/u],
      ["/drop-approved.txt", droppedApprovedText, /^text\/plain(?:;|$)/u],
      ["/drop-skipped-new.txt", droppedSkippedNewText, /^text\/plain(?:;|$)/u],
      ["/drop-extra.txt", "A second file in the same native drop", /^text\/plain(?:;|$)/u],
      ["/dropped.html", droppedHtml, /^text\/html(?:;|$)/u],
      ["/dropped.css", droppedCss, /^text\/css(?:;|$)/u],
      ["/dropped.js", droppedScript, /^(?:application|text)\/javascript(?:;|$)/u],
      ["/nested/drop-data.txt", droppedNested, /^text\/plain(?:;|$)/u],
    ] as const) {
      const response = await fetchPreview(new URL(path, previewUrl).href);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", mime);
      assert.equal(await response.text(), expected, "native drops preserve the approved file bytes");
    }
    const droppedImageResponse = await fetchPreview(new URL("/dropped.png", previewUrl).href);
    assert.equal(droppedImageResponse.status, 200);
    assert.match(droppedImageResponse.headers.get("content-type") ?? "", /^image\/png(?:;|$)/u);
    assert.deepEqual(Buffer.from(await droppedImageResponse.arrayBuffer()), await readFile(join(root, "upload", "pixel.png")));
    assert.equal((await fetchPreview(new URL("/.private/hidden.txt", previewUrl).href)).status, 404);
    assert.equal((await fetchPreview(new URL("/drop-folder/dropped.html", previewUrl).href)).status, 404);
    for (const path of ["/.empty-marker", "/included/.empty-marker", "/.empty-drop-marker", "/nested/empty.txt"]) {
      assert.equal((await fetchPreview(new URL(path, previewUrl).href)).status, 404,
        "empty files skipped during directory import are absent from the preview server");
    }

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
    const localPreviewButton = page.getByRole("button", { name: "Local preview", exact: true });
    const localPreview = page.getByRole("dialog", { name: "Local preview", exact: true });
    assert.equal(await localPreview.count(), 0, "the local server controls stay closed until requested");
    await localPreviewButton.click();
    await localPreview.getByText("Running", { exact: true }).waitFor();
    await localPreview.getByText("Hosting preview-test", { exact: true }).waitFor();
    await localPreview.getByText(previewUrl, { exact: true }).waitFor();
    await localPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await localPreview.waitFor({ state: "hidden" });
    assert.equal((await fetchPreview(previewUrl)).status, 200, "closing the controls keeps the preview server running");
    await page.getByRole("button", { name: "Open preview", exact: true }).click();
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

    // Selecting a different website leaves the active server clearly identified.
    await page.getByRole("button", { name: /^landing/u }).click();
    await page.getByRole("button", { name: "Preview website", exact: true }).waitFor();
    assert.equal(await localPreview.count(), 0);
    await page.screenshot({ path: join(artifacts, "local-preview-toolbar.png"), animations: "disabled" });
    await localPreviewButton.click();
    await localPreview.getByText("Hosting preview-test", { exact: true }).waitFor();
    await localPreview.getByText(imagePreviewUrl, { exact: true }).waitFor();
    assert.equal((await fetchPreview(imagePreviewUrl)).status, 200);
    await page.screenshot({ path: join(artifacts, "local-preview-running.png"), animations: "disabled" });
    await localPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await localPreview.waitFor({ state: "hidden" });

    // The main-owned server and its controls survive leaving the Websites tab.
    await jobsTab.click();
    await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();
    await websitesTab.click();
    await page.getByRole("heading", { name: "Websites", exact: true, level: 1 }).waitFor();
    await page.getByRole("button", { name: /^preview-test/u }).click();
    await page.getByPlaceholder("Search websites", { exact: true }).fill("preview-test");
    await page.getByRole("button", { name: /^preview-test/u }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^landing/u }).count(), 0);
    await localPreviewButton.click();
    await localPreview.getByText("Running", { exact: true }).waitFor();
    await localPreview.getByText("Hosting preview-test", { exact: true }).waitFor();
    await localPreview.getByText(imagePreviewUrl, { exact: true }).waitFor();
    const previewWebsiteDropdown = localPreview.getByRole("button", { name: /Preview website/u });
    await previewWebsiteDropdown.click();
    await page.getByRole("option", { name: "landing", exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, "local-preview-dropdown.png"), animations: "disabled" });
    await page.getByRole("option", { name: "landing", exact: true }).click();
    const switchedPreviewUrl = await waitForExternalUrl(application, 4);
    assert.equal(new URL(switchedPreviewUrl).pathname, "/index.html");
    assert.notEqual(new URL(switchedPreviewUrl).origin, new URL(imagePreviewUrl).origin);
    await localPreview.getByText("Hosting landing", { exact: true }).waitFor();
    await localPreview.getByText(switchedPreviewUrl, { exact: true }).waitFor();
    assert.match(await (await fetchPreview(switchedPreviewUrl)).text(), /Welcome/u);
    await assert.rejects(fetchPreview(imagePreviewUrl), "switching websites revokes the previous loopback server");
    await page.screenshot({ path: join(artifacts, "local-preview-switched.png"), animations: "disabled" });
    await localPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await localPreview.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: /^preview-test/u }).getAttribute("aria-pressed"), "true",
      "the preview dropdown changes the running website without changing the website selected for editing");
    assert.equal(await page.getByPlaceholder("Search websites", { exact: true }).inputValue(), "preview-test",
      "the preview dropdown includes websites hidden by the sidebar filter");
    await localPreviewButton.click();

    await localPreview.getByRole("button", { name: "Stop server", exact: true }).click();
    await localPreview.getByText("Stopped", { exact: true }).waitFor();
    assert.equal(await localPreview.getByText(switchedPreviewUrl, { exact: true }).count(), 0);
    await assert.rejects(fetchPreview(switchedPreviewUrl), "Stop server closes the loopback listener");
    await previewWebsiteDropdown.getByText("Choose a website", { exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, "local-preview-stopped.png"), animations: "disabled" });

    await previewWebsiteDropdown.click();
    await page.getByRole("option", { name: "landing", exact: true }).click();
    const restartedPreviewUrl = await waitForExternalUrl(application, 5);
    await localPreview.getByText("Running", { exact: true }).waitFor();
    await localPreview.getByText("Hosting landing", { exact: true }).waitFor();
    await localPreview.getByRole("button", { name: "Open in browser", exact: true }).click();
    assert.equal(await waitForExternalUrl(application, 6), restartedPreviewUrl,
      "opening the active preview retains its running server and URL");
    assert.match(await (await fetchPreview(restartedPreviewUrl)).text(), /Welcome/u);
    await localPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await localPreview.waitFor({ state: "hidden" });
    assert.equal((await fetchPreview(restartedPreviewUrl)).status, 200);

    await page.getByPlaceholder("Search websites", { exact: true }).fill("");
    await page.getByRole("button", { name: /^landing/u }).waitFor();

    // Website context actions target the clicked row without changing the editing selection.
    const landingWebsite = page.getByRole("button", { name: /^landing/u });
    const contextWebsite = page.getByRole("button", { name: /^preview-test/u });
    const websiteContextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await landingWebsite.click();
    await contextWebsite.click({ button: "right" });
    await websiteContextMenu.getByRole("menuitem", { name: "Preview website", exact: true }).waitFor();
    await websiteContextMenu.getByRole("menuitem", { name: "Delete website", exact: true }).waitFor();
    assert.equal(await websiteContextMenu.getByRole("menuitem", { name: "Stop preview server", exact: true }).count(), 0,
      "a website that is not being previewed has no stop action");
    await page.screenshot({ path: join(artifacts, "website-selector-context-menu.png"), animations: "disabled" });
    await websiteContextMenu.getByRole("menuitem", { name: "Preview website", exact: true }).click();
    await websiteContextMenu.waitFor({ state: "hidden" });
    let contextPreviewUrl = await waitForExternalUrl(application, 7);
    assert.equal(new URL(contextPreviewUrl).pathname, "/index.html");
    assert.equal(await (await fetchPreview(contextPreviewUrl)).text(), "Updated website content",
      "the website context menu previews its clicked row rather than the selected website");
    assert.equal(await landingWebsite.getAttribute("aria-pressed"), "true");
    assert.equal(await contextWebsite.getAttribute("aria-pressed"), "false");

    await contextWebsite.click({ button: "right" });
    const stopPreviewAction = websiteContextMenu.getByRole("menuitem", { name: "Stop preview server", exact: true });
    await stopPreviewAction.waitFor();
    assert.equal(await stopPreviewAction.locator('svg[data-icon="stop"]').count(), 1,
      "the running website's stop action uses the stop icon");
    await page.screenshot({ path: join(artifacts, "website-selector-stop-preview.png"), animations: "disabled" });
    await stopPreviewAction.click();
    await websiteContextMenu.waitFor({ state: "hidden" });
    await localPreviewButton.click();
    await localPreview.getByText("Stopped", { exact: true }).waitFor();
    await assert.rejects(fetchPreview(contextPreviewUrl), "the website context menu stops its loopback server");
    await localPreview.getByRole("button", { name: "Close", exact: true }).last().click();
    await localPreview.waitFor({ state: "hidden" });
    assert.equal(await landingWebsite.getAttribute("aria-pressed"), "true",
      "stopping the clicked website leaves the editing selection unchanged");
    assert.equal(await contextWebsite.getAttribute("aria-pressed"), "false");

    await contextWebsite.click({ button: "right" });
    await websiteContextMenu.getByRole("menuitem", { name: "Preview website", exact: true }).waitFor();
    assert.equal(await stopPreviewAction.count(), 0, "a stopped website no longer has a stop action");
    await websiteContextMenu.getByRole("menuitem", { name: "Preview website", exact: true }).click();
    await websiteContextMenu.waitFor({ state: "hidden" });
    contextPreviewUrl = await waitForExternalUrl(application, 8);
    assert.equal(await (await fetchPreview(contextPreviewUrl)).text(), "Updated website content");

    await contextWebsite.click({ button: "right" });
    await websiteContextMenu.getByRole("menuitem", { name: "Delete website", exact: true }).click();
    const deleteWebsiteDialog = page.getByRole("alertdialog", { name: "Delete website?", exact: true });
    await deleteWebsiteDialog.getByText("Delete preview-test and all its hosted content? Listeners using this website will no longer serve its content.", { exact: true }).waitFor();
    await deleteWebsiteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await deleteWebsiteDialog.waitFor({ state: "hidden" });
    assert.equal(await landingWebsite.getAttribute("aria-pressed"), "true",
      "canceling context-menu deletion preserves the website selected for editing");
    assert.equal(await contextWebsite.count(), 1);
    assert.equal(await (await fetchPreview(contextPreviewUrl)).text(), "Updated website content",
      "canceling context-menu deletion preserves the clicked website and its running preview");

    await page.getByRole("button", { name: /^preview-test/u }).click();
    await page.getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("alertdialog", { name: "Delete website?", exact: true }).getByRole("button", { name: "Delete website", exact: true }).click();
    await page.getByRole("button", { name: /^preview-test/u }).waitFor({ state: "hidden" });
    await assert.rejects(fetchPreview(contextPreviewUrl), "deleting the previewed website revokes its loopback server");
    await page.getByRole("button", { name: /^landing/u }).click();
    await page.getByRole("button", { name: "Inspect /index.html", exact: true }).click();
    await page.getByRole("dialog", { name: "/index.html", exact: true }).getByRole("button", { name: "Preview in browser", exact: true }).click();
    const closingPreviewUrl = await waitForExternalUrl(application, 9);
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
      (globalThis as unknown as WebsiteDropOverwriteState).__websiteDropOverwriteResponse?.(0);
      globalThis.__SLIVER_GUI_E2E_CONTROL__?.releaseWebsiteAddContentHold();
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

async function websiteWriteCount(application: ElectronApplication): Promise<number> {
  return application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods
    .filter((method) => method === "websiteAddContent" || method === "websiteUpdateContent").length);
}

async function waitForHeldWebsiteWrite(application: ElectronApplication): Promise<void> {
  await waitUntil(async () => application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.websiteAddContentHeld));
}

async function assertWebsiteUploadProgress(page: Page, completed: number, total: number): Promise<void> {
  await page.getByText(`Uploading ${Math.min(completed + 1, total)} of ${total} ${total === 1 ? "file" : "files"}`, { exact: true }).waitFor();
  const progress = page.getByRole("progressbar", { name: "Website upload progress", exact: true });
  await progress.waitFor();
  assert.equal(await progress.getAttribute("aria-valuemin"), "0");
  assert.equal(await progress.getAttribute("aria-valuemax"), String(total));
  assert.equal(await progress.getAttribute("aria-valuenow"), String(completed));
  assert.equal(await progress.getAttribute("aria-valuetext"), `${completed} of ${total} ${total === 1 ? "file" : "files"} uploaded`);
}

async function assertNoWebsiteUploadProgress(page: Page): Promise<void> {
  assert.equal(await page.getByRole("progressbar", { name: "Website upload progress", exact: true }).count(), 0);
  assert.equal(await page.getByText(/^Uploading \d+ of \d+ files?$/u).count(), 0);
}

async function readWebsiteText(page: Page, path: string): Promise<string> {
  const bytes = await page.evaluate(async (contentPath) => {
    const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver
      .getWebsiteContent({ name: "preview-test", path: contentPath });
    if (!result.ok) throw new Error(result.error);
    return Array.from(result.value.preview);
  }, path);
  return Buffer.from(bytes).toString("utf8");
}

async function waitForWebsiteDropOverwrite(application: ElectronApplication, count: number): Promise<WebsiteDropOverwritePrompt> {
  await waitUntil(async () => application.evaluate((_electron, expected) =>
    (globalThis as unknown as WebsiteDropOverwriteState).__websiteDropOverwritePrompts.length === expected, count));
  return application.evaluate((_electron, index) =>
    (globalThis as unknown as WebsiteDropOverwriteState).__websiteDropOverwritePrompts[index]!, count - 1);
}

async function resolveWebsiteDropOverwrite(application: ElectronApplication, response: number): Promise<void> {
  await application.evaluate((_electron, decision) => {
    const resolve = (globalThis as unknown as WebsiteDropOverwriteState).__websiteDropOverwriteResponse;
    if (!resolve) throw new Error("No pending website overwrite confirmation");
    resolve(decision);
  }, response);
}

async function dropNativeWebsitePaths(page: Page, target: Locator, paths: string[], screenshotPath?: string): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  assert.ok(bounds, "the selected website exposes a visible upload target");
  const viewport = await page.evaluate(() => {
    const state = globalThis as unknown as { innerWidth: number; innerHeight: number };
    return { width: state.innerWidth, height: state.innerHeight };
  });
  const left = Math.max(0, bounds.x);
  const top = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width);
  const bottom = Math.min(viewport.height, bounds.y + bounds.height);
  assert.ok(right > left && bottom > top, "the website upload target intersects the viewport");
  const point = { x: (left + right) / 2, y: top + Math.min(80, (bottom - top) / 2) };
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  const session = await page.context().newCDPSession(page);
  let dropped = false;
  try {
    await page.mouse.move(point.x, point.y);
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
    await page.getByText("Drop to upload to preview-test", { exact: true }).waitFor();
    if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: "disabled" });
    await session.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
    dropped = true;
  } finally {
    if (!dropped) await session.send("Input.dispatchDragEvent", { type: "dragCancel", ...point, data }).catch(() => {});
    await session.detach();
  }
}

async function observeWebsiteUploadPending(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    const browser = element.ownerDocument.defaultView as unknown as {
      MutationObserver: new(callback: () => void) => {
        observe(target: unknown, options: { childList: boolean; subtree: boolean; characterData: boolean }): void;
        disconnect(): void;
      };
    };
    const observer = new browser.MutationObserver(() => {
      if ([...element.ownerDocument.querySelectorAll('[role="status"]')]
        .some((status) => status.textContent?.includes("Uploading website content…"))) {
        element.setAttribute("data-e2e-upload-pending", "observed");
        observer.disconnect();
      }
    });
    observer.observe(element.ownerDocument.body, { childList: true, subtree: true, characterData: true });
  });
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
