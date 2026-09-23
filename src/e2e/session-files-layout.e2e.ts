import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  _electron as electron,
  type ElectronApplication,
  type JSHandle,
  type Locator,
  type Page,
} from "playwright-core";

const editorModifier = process.platform === "darwin" ? "Meta" : "Control";

test("Files keeps folders and entries independently scrollable inside a fixed session viewport", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-files-layout-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  const droppedUploadPath = join(temporaryRoot, "DroppedUpload.bin");
  const droppedUploadBytes = Buffer.from("SLIVER_GUI_E2E_DROP_UPLOAD_BYTES\n", "utf8");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(savedConfigDirectory, "files-layout-e2e-operator.cfg"),
    fakeOperatorConfig(),
    { mode: 0o600 },
  );
  await writeFile(droppedUploadPath, droppedUploadBytes, { mode: 0o600 });

  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  const rendererErrors: string[] = [];
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
        `--console-client-root-directory=${consoleClientRootDirectory}`,
        "--files-layout-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });

    page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));

    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Files", exact: true }).click();

    const browser = page.getByRole("region", { name: "File browser", exact: true });
    const entriesGrid = page.getByRole("grid", { name: "Files in /Users/e2e/workspace", exact: true });
    const count = page.getByText("Loaded 100 of 105 items · bounded", { exact: true });
    await browser.waitFor();
    await entriesGrid.waitFor();
    await count.waitFor();
    assert.equal(await browser.getByRole("textbox", { name: "Remote path", exact: true }).inputValue(), "/Users/e2e/workspace");
    await browser.getByRole("button", { name: "Up one folder", exact: true }).waitFor();
    await browser.getByRole("button", { name: "Go", exact: true }).waitFor();
    const modes = browser.getByRole("radiogroup", { name: "Filesystem mode" });
    for (const name of ["Browser", "Search", "Mounts"]) {
      await modes.getByRole("radio", { name, exact: true }).waitFor();
    }

    const rows = entriesGrid.locator('[data-slot="table-body"] [data-slot="table-row"]');
    assert.equal(await rows.count(), 100, "the first Files page must render all 100 bounded rows");
    await entriesGrid.getByText("E2EFolder001", { exact: true }).waitFor();
    await entriesGrid.getByText("E2EFile100.txt", { exact: true }).waitFor();
    assert.equal(await entriesGrid.getByText("E2EFile101.txt", { exact: true }).count(), 0);

    const firstFileRow = entriesGrid.getByRole("row").filter({ hasText: "E2EFile081.txt" });
    await firstFileRow.getByRole("button", { name: "More actions for E2EFile081.txt", exact: true }).click();
    const rowActions = page.getByRole("menu").filter({
      has: page.getByRole("menuitem", { name: "Download", exact: true }),
    });
    await rowActions.waitFor();
    assert.deepEqual((await rowActions.getByRole("menuitem").allTextContents()).slice(0, 3), [
      "Download",
      "Add to Loot",
      "Inspect file",
    ]);
    await page.keyboard.press("Escape");
    await rowActions.waitFor({ state: "hidden" });

    const downloadedPath = join(temporaryRoot, "E2EFile081.txt");
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: false, filePath: outputPath };
      };
    }, downloadedPath);
    const fileName = firstFileRow.getByRole("rowheader", { name: "E2EFile081.txt", exact: true });
    await fileName.click({ button: "right" });
    let contextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await contextMenu.waitFor();
    assert.deepEqual((await contextMenu.getByRole("menuitem").allTextContents()).slice(0, 4), [
      "Download",
      "Add to Loot",
      "Edit text",
      "Upload replacement",
    ]);
    await contextMenu.getByRole("menuitem", { name: "Download", exact: true }).click();
    await page.getByText("File saved", { exact: true }).waitFor();
    await waitForFakeMethodCount(application, "downloadFileSession", 1);
    assert.deepEqual(await readFile(downloadedPath), Buffer.alloc(2_048, 0x41));
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls), 1);

    await fileName.click({ button: "right" });
    contextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await contextMenu.waitFor();
    await contextMenu.getByRole("menuitem", { name: "Add to Loot", exact: true }).click();
    await page.getByText("File added to loot", { exact: true }).waitFor();
    await waitForFakeMethodCount(application, "downloadFileSession", 2);
    await waitForFakeMethodCount(application, "lootAdd", 1);

    const sessionPage = page.locator('.app-content:has(> .session-workspace[data-presentation="embedded"])');
    const foldersScroll = browser.locator('[data-files-scroll-region="folders"]');
    const entriesScroll = browser.locator('[data-files-scroll-region="entries"] [data-slot="table-scroll-container"]');
    await foldersScroll.waitFor();
    await entriesScroll.waitFor();

    for (const [width, height] of [[1440, 950], [1024, 768]]) {
      await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
      await page.waitForFunction((expectedWidth) => (globalThis as unknown as { innerWidth: number }).innerWidth === expectedWidth, width);
      await Promise.all([setScroll(foldersScroll, 0), setScroll(entriesScroll, 0)]);
      await assertFixedLayout(sessionPage, browser, foldersScroll, entriesScroll, count, `${width}×${height}`);
    }

    await browser.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByText("Loaded 105 of 105 items", { exact: true }).waitFor();
    await entriesGrid.getByText("E2EFile105.txt", { exact: true }).waitFor();
    assert.equal(await rows.count(), 105, "Load more must append the remaining five file rows");
    assert.equal(await browser.getByRole("button", { name: "Load more", exact: true }).count(), 0);

    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 1440);
    await Promise.all([setScroll(foldersScroll, 0), setScroll(entriesScroll, 0)]);
    await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "session-files-layout.png") });

    await browser.getByRole("button", { name: "New folder", exact: true }).click();
    const newFolderDialog = page.getByRole("dialog", { name: "New folder", exact: true });
    await newFolderDialog.getByRole("textbox", { name: "New folder name", exact: true }).fill("cancelled-e2e-folder");
    await newFolderDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await newFolderDialog.waitFor({ state: "hidden" });
    assert.equal(await rows.count(), 105, "Cancelling folder creation must preserve the current listing");
    assert.equal(await entriesGrid.getByText("cancelled-e2e-folder", { exact: true }).count(), 0);

    await modes.getByRole("radio", { name: "Search", exact: true }).click();
    await browser.getByRole("heading", { name: "Search file contents", exact: true }).waitFor();
    assert.equal(await browser.getByRole("textbox", { name: "Search path", exact: true }).inputValue(), "/Users/e2e/workspace");
    await modes.getByRole("radio", { name: "Mounts", exact: true }).click();
    await browser.getByRole("grid", { name: "Session mounts", exact: true }).getByText("Macintosh HD", { exact: true }).waitFor();
    await modes.getByRole("radio", { name: "Browser", exact: true }).click();
    await entriesGrid.waitFor();
    await page.getByText("Loaded 105 of 105 items", { exact: true }).waitFor();

    const remotePath = browser.getByRole("textbox", { name: "Remote path", exact: true });
    await remotePath.fill("/Users/e2e");
    await remotePath.press("Enter");
    const parentGrid = browser.getByRole("grid", { name: "Files in /Users/e2e", exact: true });
    await parentGrid.getByText("This directory is empty.", { exact: true }).waitFor();
    assert.equal(await remotePath.inputValue(), "/Users/e2e");
    await browser.getByRole("button", { name: "Up one folder", exact: true }).click();
    const usersGrid = browser.getByRole("grid", { name: "Files in /Users", exact: true });
    await usersGrid.getByText("This directory is empty.", { exact: true }).waitFor();
    assert.equal(await remotePath.inputValue(), "/Users");
    await remotePath.fill("/Users/e2e/workspace");
    await remotePath.press("Enter");
    await entriesGrid.waitFor();
    await count.waitFor();
    assert.equal(await rows.count(), 100, "Returning to a directory must start with its first bounded page");

    const folderTree = browser.getByRole("treegrid", { name: "Remote folders", exact: true });
    await folderTree.getByText("E2EFolder001", { exact: true }).click();
    await browser.getByRole("grid", { name: "Files in /Users/e2e/workspace/E2EFolder001", exact: true })
      .getByText("This directory is empty.", { exact: true }).waitFor();
    assert.equal(await folderTree.getByText("E2EFolder002", { exact: true }).count(), 1,
      "navigating into one folder must retain previously discovered siblings");
    await browser.getByRole("button", { name: "Refresh directory", exact: true }).click();
    await folderTree.getByText("E2EFolder002", { exact: true }).waitFor({ state: "detached" });
    assert.equal(await folderTree.getByText("E2EFolder002", { exact: true }).count(), 0,
      "refreshing a directory must clear previously discovered branches");

    await remotePath.fill("/Users/e2e/workspace");
    await remotePath.press("Enter");
    await entriesGrid.waitFor();
    await count.waitFor();

    const dialogCallsBeforeDrop = await application.evaluate(
      () => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls,
    );
    await application.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: true, filePaths: [] };
      };
    });

    const dropInput = await installDroppedFileInput(page, droppedUploadPath);
    const dataTransfer = await createDroppedFileTransfer(dropInput);
    const dropArea = browser.getByLabel(
      "Upload a local file to /Users/e2e/workspace",
      { exact: true },
    );
    await dropArea.dispatchEvent("dragenter", { dataTransfer });
    await browser.getByText("Drop to upload", { exact: true }).waitFor();
    await browser.getByText("One file, up to 64 MiB", { exact: true }).waitFor();
    await dropArea.dispatchEvent("dragover", { dataTransfer });
    await dropArea.dispatchEvent("drop", { dataTransfer });

    const uploadDialog = page.getByRole("dialog", { name: "Upload file", exact: true });
    await uploadDialog.waitFor();
    await uploadDialog.getByText("DroppedUpload.bin", { exact: true }).waitFor();
    const remoteDestination = uploadDialog.getByRole("textbox", {
      name: /^Remote destination folder/iu,
    });
    assert.equal(await remoteDestination.inputValue(), "/Users/e2e/workspace");
    await uploadDialog.getByText("Existing files are not overwritten.", { exact: true }).waitFor();
    assert.equal(
      await uploadDialog.getByRole("checkbox", { name: /overwrite/iu }).count(),
      0,
      "drop uploads must not expose an overwrite option",
    );
    assert.equal((await uploadDialog.innerText()).includes(droppedUploadPath), false,
      "the native source path must not be rendered");
    const markAsIOC = uploadDialog.getByRole("checkbox", { name: "Mark as IOC", exact: true });
    assert.equal(await markAsIOC.isChecked(), false);
    await markAsIOC.press("Space");
    assert.equal(await markAsIOC.isChecked(), true);
    await uploadDialog.getByRole("button", { name: "Upload", exact: true }).click();
    await uploadDialog.waitFor({ state: "hidden" });
    await dataTransfer.dispose();
    await dropInput.evaluate((element) => element.remove());

    await page.getByText("Upload complete", { exact: true }).waitFor();
    await waitForFakeMethodCount(application, "uploadSession", 1);
    assert.equal(
      await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls),
      dialogCallsBeforeDrop,
      "a dropped file must not open the native file picker",
    );
    assert.deepEqual(
      await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.uploads),
      [{
        path: "/Users/e2e/workspace",
        fileName: "DroppedUpload.bin",
        destination: "/Users/e2e/workspace/DroppedUpload.bin",
        size: droppedUploadBytes.length,
        sha256: createHash("sha256").update(droppedUploadBytes).digest("hex"),
        isIOC: true,
        isDirectory: false,
        overwrite: false,
      }],
    );

    await page.getByText("Loaded 100 of 106 items · bounded", { exact: true }).waitFor();
    await browser.getByRole("button", { name: "Load more", exact: true }).click();
    await page.getByText("Loaded 106 of 106 items", { exact: true }).waitFor();
    const uploadedRow = entriesGrid.getByRole("row").filter({ hasText: "DroppedUpload.bin" });
    const uploadedFileName = uploadedRow.getByRole("rowheader", { name: "DroppedUpload.bin", exact: true });
    await uploadedFileName.waitFor();

    const uploadedDownloadPath = join(temporaryRoot, "downloaded-DroppedUpload.bin");
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: false, filePath: outputPath };
      };
    }, uploadedDownloadPath);
    // A hovered upload toast can cover rows near the bottom of the viewport.
    await page.mouse.move(0, 0);
    await page.getByText("Upload complete", { exact: true }).waitFor({ state: "hidden" });
    await uploadedFileName.click({ button: "right" });
    contextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await contextMenu.waitFor();
    await contextMenu.getByRole("menuitem", { name: "Download", exact: true }).click();
    await waitForFakeMethodCount(application, "downloadFileSession", 3);
    await waitForFileBytes(uploadedDownloadPath, droppedUploadBytes);
    assert.deepEqual(rendererErrors, []);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, "session-files-layout-failure.png"),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Files opens a remote text file in standalone Monaco and confirms each overwrite", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-remote-editor-e2e-"));
  const remotePath = "/Users/e2e/workspace/E2EFile081.txt";
  const savedPath = join(temporaryRoot, "remote-editor-result.txt");
  const original = "A".repeat(2_048);
  const updated = "Edited in standalone Monaco \u2603\n";
  const operatorConfig = fakeOperatorConfig();
  const originalSha256 = createHash("sha256").update(original).digest("hex");
  const updatedSha256 = createHash("sha256").update(updated).digest("hex");
  const backendId = createHash("sha256").update(operatorConfig).digest("hex");
  await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporaryRoot, name))));
  await writeFile(join(temporaryRoot, "saved", "remote-editor-e2e-operator.cfg"), operatorConfig, { mode: 0o600 });
  await writeFile(join(temporaryRoot, "client", "armories.json"), "[]", { mode: 0o600 });

  let application: ElectronApplication | undefined;
  let editor: Page | undefined;
  let previousClipboard: string | undefined;
  const rendererErrors: string[] = [];
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`,
        `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${join(temporaryRoot, "client")}`,
        "--files-layout-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    previousClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    workspace.on("pageerror", (error) => rendererErrors.push(error.message));
    await workspace.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await workspace.locator('[aria-label="Sessions"]:visible').click();
    await workspace.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await workspace.getByRole("tab", { name: "Files", exact: true }).click();
    const browser = workspace.getByRole("region", { name: "File browser", exact: true });
    const file = browser.getByRole("row").filter({ hasText: "E2EFile081.txt" });
    const opened = application.waitForEvent("window", { timeout: 15_000 });
    await file.getByRole("rowheader", { name: "E2EFile081.txt", exact: true }).click({ button: "right" });
    const contextMenu = workspace.getByRole("menu", { name: "Application context menu", exact: true });
    await contextMenu.waitFor();
    await contextMenu.getByRole("menuitem", { name: "Edit text", exact: true }).click();
    editor = await opened;
    editor.setDefaultTimeout(15_000);
    editor.on("dialog", (dialog) => { void dialog.accept().catch(() => undefined); });
    editor.on("pageerror", (error) => rendererErrors.push(error.message));
    await editor.getByRole("heading", { name: "E2EFile081.txt", exact: true }).waitFor();
    await editor.locator(".monaco-editor").waitFor();
    await editor.getByRole("button", { name: "Undo", exact: true }).waitFor({ state: "visible" });
    assert.equal(new URL(editor.url()).searchParams.get("surface"), "text-editor");
    assert.equal(await remoteEditorText(application, editor), original);
    assert.equal(await editor.getByRole("button", { name: "Save As…" }).count(), 0,
      "a remote document must not offer a local Save As path");

    await replaceRemoteEditorText(application, editor, updated);
    await editor.getByText("Unsaved changes", { exact: true }).waitFor();
    const nativeDialogCalls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const overwriteReview = editor.getByRole("alertdialog", { name: "Overwrite remote file?", exact: true });
    await overwriteReview.waitFor();
    const reviewText = await overwriteReview.innerText();
    for (const expected of [
      remotePath,
      "m1-session",
      "m1-session-host",
      "m1_session",
      "remote-editor-e2e-operator",
      backendId,
      originalSha256,
      updatedSha256,
    ]) {
      assert.ok(reviewText.includes(expected), `the overwrite review must include ${expected}`);
    }
    assert.ok(!reviewText.includes(updated), "the overwrite review must not expose edited file contents");
    await overwriteReview.getByRole("button", { name: "Cancel", exact: true }).click();
    await overwriteReview.waitFor({ state: "hidden" });
    await editor.getByText("Unsaved changes", { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls), nativeDialogCalls,
      "the HeroUI overwrite review must not invoke a native dialog");
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.uploads.length), 0,
      "canceling the overwrite must not upload data");
    assert.equal(await remoteEditorText(application, editor), updated, "canceling must preserve the edited draft");

    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await overwriteReview.waitFor();
    assert.equal(await overwriteReview.innerText(), reviewText, "the second save must require the same complete review");
    await overwriteReview.getByRole("button", { name: "Overwrite file", exact: true }).click();
    await overwriteReview.waitFor({ state: "hidden" });
    await editor.getByText("Saved", { exact: true }).waitFor();
    await waitForFakeMethodCount(application, "uploadSession", 1);
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls), nativeDialogCalls,
      "confirming the HeroUI overwrite review must not invoke a native dialog");
    const uploads = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.uploads);
    assert.equal(uploads.length, 1);
    assert.deepEqual({
      destination: uploads[0]?.destination,
      size: uploads[0]?.size,
      sha256: uploads[0]?.sha256,
      overwrite: uploads[0]?.overwrite,
    }, {
      destination: remotePath,
      size: Buffer.byteLength(updated, "utf8"),
      sha256: updatedSha256,
      overwrite: true,
    });

    await editor.close();
    await application.evaluate(({ dialog }, outputPath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: outputPath });
    }, savedPath);
    await file.getByRole("button", { name: "More actions for E2EFile081.txt", exact: true }).click();
    await workspace.getByRole("menuitem", { name: "Download", exact: true }).click();
    await waitForFileBytes(savedPath, Buffer.from(updated, "utf8"));
    assert.deepEqual(rendererErrors, [], "the remote editor must not produce renderer errors");
  } finally {
    if (application) {
      if (previousClipboard !== undefined) {
        await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard).catch(() => undefined);
      }
      await application.close().catch(() => undefined);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function replaceRemoteEditorText(application: ElectronApplication, editor: Page, text: string): Promise<void> {
  await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), text);
  await editor.getByRole("textbox", { name: "Document text", exact: true }).focus();
  await editor.keyboard.press(`${editorModifier}+a`);
  await editor.keyboard.press(`${editorModifier}+v`);
}

async function remoteEditorText(application: ElectronApplication, editor: Page): Promise<string> {
  const sentinel = `remote-editor-clipboard-${Date.now()}`;
  await application.evaluate(({ clipboard }, value) => clipboard.writeText(value), sentinel);
  await editor.getByRole("textbox", { name: "Document text", exact: true }).focus();
  await editor.keyboard.press(`${editorModifier}+a`);
  await editor.keyboard.press(`${editorModifier}+c`);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const text = await application.evaluate(({ clipboard }) => clipboard.readText());
    if (text !== sentinel) return text.replace(/\r\n/gu, "\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out copying the remote editor document");
}

async function assertFixedLayout(
  sessionPage: Locator,
  browser: Locator,
  foldersScroll: Locator,
  entriesScroll: Locator,
  count: Locator,
  size: string,
): Promise<void> {
  const pageLayout = await sessionPage.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return {
      scrollRange: element.scrollHeight - element.clientHeight,
      scrollTop: element.scrollTop,
      bottom: element.getBoundingClientRect().bottom,
      right: element.getBoundingClientRect().right,
    };
  });
  const browserLayout = await browser.boundingBox();
  assert.ok(browserLayout);
  assert.ok(pageLayout.scrollRange <= 1 && pageLayout.scrollTop <= 1, `Files must not scroll the session page at ${size}`);
  assert.ok(browserLayout.y + browserLayout.height <= pageLayout.bottom + 1, `Files must fit vertically at ${size}`);
  assert.ok(browserLayout.x + browserLayout.width <= pageLayout.right + 1, `Files must fit horizontally at ${size}`);

  const header = entriesScroll.getByRole("columnheader").first();
  const headerBefore = await header.boundingBox();
  const countBefore = await count.boundingBox();
  assert.ok(headerBefore && countBefore);
  assert.ok(countBefore.y + countBefore.height <= pageLayout.bottom + 1, `The listing count must be visible at ${size}`);

  const folderMaximum = await setScroll(foldersScroll, "end");
  assert.ok(folderMaximum > 0, `The folder pane must own vertical scrolling at ${size}`);
  assert.deepEqual(await scrollState(sessionPage, foldersScroll, entriesScroll), {
    page: 0, folders: folderMaximum, entries: 0,
  }, `Scrolling folders must not move entries or the session page at ${size}`);

  const entriesMaximum = await setScroll(entriesScroll, "end");
  assert.ok(entriesMaximum > 0, `The entries table must own vertical scrolling at ${size}`);
  assert.deepEqual(await scrollState(sessionPage, foldersScroll, entriesScroll), {
    page: 0, folders: folderMaximum, entries: entriesMaximum,
  }, `Scrolling entries must not move folders or the session page at ${size}`);

  const headerAfter = await header.boundingBox();
  const countAfter = await count.boundingBox();
  assert.ok(headerAfter && countAfter);
  assert.ok(Math.abs(headerBefore.y - headerAfter.y) <= 1, `The table header must stay fixed while entries scroll at ${size}`);
  assert.ok(Math.abs(countBefore.y - countAfter.y) <= 1, `The listing count must stay fixed while panes scroll at ${size}`);
}

async function installDroppedFileInput(page: Page, sourcePath: string): Promise<Locator> {
  await page.evaluate(() => {
    const documentObject = (globalThis as unknown as {
      document: {
        createElement(tagName: "input"): {
          type: string;
          hidden: boolean;
          setAttribute(name: string, value: string): void;
        };
        body: { append(node: unknown): void };
      };
    }).document;
    const input = documentObject.createElement("input");
    input.type = "file";
    input.hidden = true;
    input.setAttribute("data-e2e-drop-source", "");
    documentObject.body.append(input);
  });
  const input = page.locator("input[data-e2e-drop-source]");
  await input.setInputFiles(sourcePath);
  return input;
}

async function createDroppedFileTransfer(input: Locator): Promise<JSHandle<unknown>> {
  return input.evaluateHandle((element) => {
    const file = (element as unknown as { files?: ArrayLike<unknown> }).files?.[0];
    if (!file) {
      throw new Error("Dropped-file fixture is unavailable");
    }
    const DataTransferConstructor = (globalThis as unknown as {
      DataTransfer: new() => { items: { add(file: unknown): void } };
    }).DataTransfer;
    const transfer = new DataTransferConstructor();
    transfer.items.add(file);
    const item = (transfer as unknown as { items: ArrayLike<object> }).items[0];
    if (item) {
      // Chromium exposes webkitGetAsEntry for every DataTransferItem, but it
      // returns null for a file programmatically copied from an input. Native
      // filesystem drags return an entry. DataTransferList returns a fresh
      // wrapper on access, so patch its prototype for this isolated page and
      // let React Aria consume the same OS-backed File via getAsFile().
      Object.defineProperty(Object.getPrototypeOf(item) as object, "webkitGetAsEntry", {
        configurable: true,
        value: () => ({ isFile: true, isDirectory: false }),
      });
    }
    return transfer;
  });
}

async function waitForFileBytes(
  path: string,
  expected: Buffer,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const actual = await readFile(path).catch(() => undefined);
    if (actual?.equals(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for exact file bytes at ${path}`);
}

async function setScroll(locator: Locator, destination: number | "end"): Promise<number> {
  return locator.evaluate((element, target) => {
    element.scrollTop = target === "end" ? element.scrollHeight : target;
    return element.scrollTop;
  }, destination);
}

async function scrollState(
  sessionPage: Locator,
  foldersScroll: Locator,
  entriesScroll: Locator,
): Promise<{ page: number; folders: number; entries: number }> {
  const [page, folders, entries] = await Promise.all([
    sessionPage.evaluate((element) => element.scrollTop),
    foldersScroll.evaluate((element) => element.scrollTop),
    entriesScroll.evaluate((element) => element.scrollTop),
  ]);
  return { page, folders, entries };
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "files-layout-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_FILES_CA_DO_NOT_RENDER",
    certificate: "FAKE_FILES_CERT_DO_NOT_RENDER",
    private_key: "FAKE_FILES_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}

async function waitForFakeMethodCount(
  application: ElectronApplication,
  method: string,
  minimum: number,
  timeoutMilliseconds = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  let latest = 0;
  while (Date.now() < deadline) {
    const methods = await application.evaluate(() => [...globalThis.__SLIVER_GUI_E2E_STATE__.methods]);
    latest = methods.filter((candidate) => candidate === method).length;
    if (latest >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${method} call ${minimum}; observed ${latest}`);
}
