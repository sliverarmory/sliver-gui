import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { ApplicationContextMenuAPI } from "../shared/application-context-menu-contracts.js";

test("Armory, Network, and Cloud Deployment use native context menus in isolated windows", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-auxiliary-context-menu-e2e-"));
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  let application: ElectronApplication | undefined;
  let originalClipboard: string | undefined;
  const rendererErrors: string[] = [];
  const observedPages = new Set<Page>();

  try {
    await Promise.all([
      ...["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporaryRoot, name))),
      mkdir(artifactDirectory, { recursive: true }),
    ]);
    await writeFile(join(temporaryRoot, "client", "armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporaryRoot, "saved", "context-menu-fixture.cfg"), JSON.stringify({
      operator: "context-menu-fixture", lhost: "127.0.0.1", lport: 31337,
      ca_certificate: "FAKE_CONTEXT_MENU_CA", certificate: "FAKE_CONTEXT_MENU_CERT",
      private_key: "FAKE_CONTEXT_MENU_KEY", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`, `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`, `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${join(temporaryRoot, "client")}`],
      cwd: repositoryRoot, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
    const observe = (page: Page): void => {
      if (observedPages.has(page)) return;
      observedPages.add(page);
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => rendererErrors.push(error.message));
      page.on("console", (message) => {
        if (/Content Security Policy/iu.test(message.text())) rendererErrors.push(message.text());
      });
    };
    application.on("window", observe);
    for (const page of application.windows()) observe(page);
    const workspace = await application.firstWindow();
    await workspace.getByRole("dialog", { name: "Saved configurations" }).waitFor();

    // Each form is local and discarded. The injected cloud controller rejects mutations.
    await workspace.getByRole("button", { name: "Cloud Deployment", exact: true }).click();
    const cloud = await surfacePage(application, "cloud-deployment");
    await cloud.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor();
    await assertBridge(cloud);
    await cloud.getByRole("tab", { name: /^Credentials/u }).click();
    await cloud.getByRole("button", { name: "Add Credential", exact: true }).click();
    await verifyTextEditing(application, cloud, cloud.getByLabel("Label", { exact: true }), "Cloud", artifactDirectory);
    await cloud.getByLabel("AWS Authentication", { exact: true }).selectOption("access-keys");
    await verifyPasswordMenu(application, cloud, cloud.getByLabel("Secret Access Key", { exact: true }));
    await cloud.getByLabel("Provider", { exact: true }).selectOption("azure");
    await verifyTextEditing(application, cloud, cloud.getByLabel("Label", { exact: true }), "Azure");
    await cloud.close();
    await workspace.getByRole("button", { name: "Cloud Deployment", exact: true }).click();
    const reopenedCloud = await surfacePage(application, "cloud-deployment");
    await assertInspectionMenu(reopenedCloud, reopenedCloud.getByRole("heading", { name: "Managed Servers", exact: true }));
    await reopenedCloud.close();

    await invokeMenu(application, workspace, "armory.manage");
    const armory = await surfacePage(application, "armory");
    await armory.getByRole("tab", { name: /^Manage/u }).waitFor();
    await assertBridge(armory);
    await verifyTextEditing(application, armory, armory.getByRole("searchbox", { name: "Search packages" }), "Armory", artifactDirectory);
    await armory.getByRole("tab", { name: /^Armories/u }).click();
    await armory.getByRole("button", { name: "Add Armory", exact: true }).click();
    const armoryDialog = armory.getByRole("dialog", { name: "Add Armory Source", exact: true });
    await verifyPasswordMenu(application, armory, armoryDialog.getByLabel("Authorization", { exact: true }));
    await armoryDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await armory.close();
    await invokeMenu(application, workspace, "armory.manage");
    const reopenedArmory = await surfacePage(application, "armory");
    await assertInspectionMenu(reopenedArmory, reopenedArmory.getByRole("heading", { name: "Armory", exact: true }));
    await reopenedArmory.close();

    // The connection uses fake-main's in-process client; no sockets or forwards are started.
    await workspace.getByRole("button", { name: "Connect", exact: true }).click();
    await workspace.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
    await invokeMenu(application, workspace, "network.socks5");
    const network = await surfacePage(application, "network");
    await network.getByRole("heading", { name: "Network", exact: true }).waitFor();
    await assertBridge(network);
    await network.getByRole("button", { name: "Add SOCKS5 proxy", exact: true }).click();
    const networkDialog = network.getByRole("dialog", { name: "SOCKS5 Proxy", exact: true });
    await networkDialog.getByText("Require authentication", { exact: true }).click();
    await verifyTextEditing(application, network, networkDialog.getByLabel("Username", { exact: true }), "Network", artifactDirectory);
    await verifyPasswordMenu(application, network, networkDialog.getByLabel("Password", { exact: true }));
    await networkDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await network.close();
    await invokeMenu(application, workspace, "network.socks5");
    const reopenedNetwork = await surfacePage(application, "network");
    await assertInspectionMenu(reopenedNetwork, reopenedNetwork.getByRole("heading", { name: "Network", exact: true }));
    const methods = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods);
    assert.equal(methods.some((method) => /^start(?:PortForward|ReversePortForward|Socks5Proxy)$/u.test(method)), false);
    assert.deepEqual(rendererErrors, []);
  } finally {
    if (application && originalClipboard !== undefined) {
      await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard).catch(() => undefined);
    }
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertBridge(page: Page): Promise<void> {
  const bridge = await page.evaluate(() => {
    const browser = globalThis as unknown as { applicationContextMenu?: ApplicationContextMenuAPI; sliver?: unknown };
    return {
      frozen: Object.isFrozen(browser.applicationContextMenu),
      keys: Object.keys(browser.applicationContextMenu ?? {}).sort(),
      mainBridge: typeof browser.sliver,
    };
  });
  assert.deepEqual(bridge, {
    frozen: true, keys: ["executeAction", "onMenuRequested", "setOpen"], mainBridge: "undefined",
  });
}

async function verifyTextEditing(
  application: ElectronApplication,
  page: Page,
  input: Locator,
  name: string,
  artifactDirectory?: string,
): Promise<void> {
  const selectedValue = `${name} selection`;
  const pastedValue = `${name} pasted value`;
  const originalValue = await input.inputValue();
  const menu = page.getByRole("menu", { name: "Application context menu" });
  await input.fill(selectedValue);
  await selectInput(input);
  await input.click({ button: "right", position: { x: 24, y: 8 } });
  await menu.waitFor();
  for (const label of ["Copy", "Paste", "Select All", "Inspect Element"]) {
    assert.equal(await menu.getByRole("menuitem", { name: label, exact: true }).count(), 1);
  }
  const copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
  assert.notEqual(await copy.getAttribute("aria-disabled"), "true");
  if (artifactDirectory) {
    await page.screenshot({ path: join(artifactDirectory, `${name.toLowerCase()}-context-menu.png`), animations: "disabled" });
  }
  await copy.click();
  await menu.waitFor({ state: "hidden" });
  await waitFor(async () => await application.evaluate(({ clipboard }) => clipboard.readText()) === selectedValue,
    `${name} Copy reaches the native clipboard`);
  await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), pastedValue);
  await selectInput(input);
  await input.click({ button: "right", position: { x: 24, y: 8 } });
  await menu.waitFor();
  const paste = menu.getByRole("menuitem", { name: "Paste", exact: true });
  assert.notEqual(await paste.getAttribute("aria-disabled"), "true");
  await paste.click();
  await menu.waitFor({ state: "hidden" });
  await waitFor(async () => await input.inputValue() === pastedValue, `${name} Paste updates its original input`);
  await input.fill(originalValue);
}

async function verifyPasswordMenu(application: ElectronApplication, page: Page, input: Locator): Promise<void> {
  const originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  await input.fill("inert-password-fixture");
  await selectInput(input);
  await input.click({ button: "right", position: { x: 24, y: 8 } });
  const menu = page.getByRole("menu", { name: "Application context menu" });
  await menu.waitFor();
  for (const label of ["Copy", "Cut"]) {
    assert.equal(await menu.getByRole("menuitem", { name: label, exact: true }).getAttribute("aria-disabled"), "true",
      `${label} must remain disabled in password inputs`);
  }
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), originalClipboard);
  await input.fill("");
}

async function assertInspectionMenu(page: Page, target: Locator): Promise<void> {
  await target.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Application context menu" });
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem", { name: "Inspect Element", exact: true }).count(), 1);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
}

async function selectInput(input: Locator): Promise<void> {
  await input.evaluate((element) => {
    const control = element as typeof element & { focus(): void; select(): void };
    control.focus();
    control.select();
  });
}

async function surfacePage(application: ElectronApplication, surface: string): Promise<Page> {
  let page: Page | undefined;
  await waitFor(async () => {
    page = application.windows().find((candidate) => !candidate.isClosed() &&
      candidate.url() === `sliver://app/index.html?surface=${surface}`);
    return Boolean(page);
  }, `${surface} window opens`);
  return page!;
}

async function invokeMenu(application: ElectronApplication, page: Page, itemId: string): Promise<void> {
  await waitFor(() => application.evaluate(({ BrowserWindow, Menu }, input) => {
    const focused = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === input.url);
    const item = Menu.getApplicationMenu()?.getMenuItemById(input.itemId);
    if (!focused || !item || typeof item.click !== "function") return false;
    focused.show();
    focused.focus();
    focused.webContents.focus();
    Reflect.apply(item.click, item, [item, focused, {}]);
    return true;
  }, { itemId, url: page.url() }), `${itemId} menu is available`);
}

async function waitFor(predicate: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out: ${description}`);
}
