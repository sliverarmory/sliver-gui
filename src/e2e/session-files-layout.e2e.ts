import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

test("Files keeps folders and entries independently scrollable inside a fixed session viewport", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-files-layout-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
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
    assert.deepEqual((await contextMenu.getByRole("menuitem").allTextContents()).slice(0, 2), [
      "Download",
      "Add to Loot",
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
