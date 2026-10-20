import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";

test("standalone RDP window saves profiles offline behind its isolated renderer boundary", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-window-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  let application: ElectronApplication | undefined;
  let rdp: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(await readdir(join(temporary, "saved")), [], "No operator configuration is needed");
    await setSecureStorageAvailable(application, false);

    rdp = await openRdpWindow(application, errors);
    await assertRdpBoundary(application, rdp);
    const initial = await readState(rdp);
    assert.deepEqual(initial.tabs, []);
    assert.deepEqual(initial.profiles, []);
    assert.equal(initial.securePersistenceAvailable, false);
    await rdp.getByText("Your Windows desktops", { exact: true }).waitFor();
    const windowCount = application.windows().length;
    await invokeRdpMenu(application, "rdp.open");
    assert.equal(application.windows().length, windowCount, "File > Remote Desktop reuses the standalone window");

    await rdp.getByRole("button", { name: "New connection", exact: true }).click();
    const connection = rdp.getByRole("dialog", { name: "New Remote Desktop", exact: true });
    const clipboard = connection.getByRole("switch", { name: "Text clipboard", exact: true });
    assert.equal(await clipboard.isChecked(), true, "New connections enable text clipboard by default");
    assert.equal(await connection.getByText("Connect directly to a Windows computer using Network Level Authentication.", { exact: true }).count(), 0);
    assert.equal(await connection.locator('svg[data-icon="windows"]').count(), 1);
    const resolution = connection.getByLabel("Desktop resolution", { exact: true });
    assert.equal(await resolution.inputValue(), "1280x800");
    assert.equal(await connection.getByLabel("Desktop width", { exact: true }).count(), 0);
    await rdp.screenshot({ path: join(artifacts, "rdp-connect-form.png"), animations: "disabled" });
    await clipboard.press("Space");
    await assertClipboardPreference(temporary, false);
    await connection.getByRole("button", { name: "Cancel", exact: true }).click();
    await connection.waitFor({ state: "hidden" });
    await rdp.reload();
    await rdp.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    await rdp.getByRole("button", { name: "New connection", exact: true }).click();
    assert.equal(await clipboard.isChecked(), false, "The clipboard preference survives Cancel and a renderer reload");
    await resolution.selectOption("custom");
    await connection.getByLabel("Desktop width", { exact: true }).fill("199");
    await connection.getByLabel("Computer", { exact: true }).fill("https://rdp.invalid");
    await connection.getByLabel("Port", { exact: true }).fill("70000");
    await connection.getByRole("button", { name: "Save profile", exact: true }).click();
    for (const label of ["Computer", "Port", "Username", "Desktop width"]) {
      assert.equal(await connection.getByLabel(label, { exact: true }).getAttribute("aria-invalid"), "true");
      assert.ok(await connection.getByLabel(label, { exact: true }).getAttribute("aria-describedby"));
    }
    assert.deepEqual((await readState(rdp)).profiles, [], "Invalid fields must not save a profile");
    assert.deepEqual((await readState(rdp)).tabs, [], "Invalid fields must not start a connection");
    const scrollShadow = connection.locator('[data-scroll-shadow-mode="auto"]');
    assert.equal(await scrollShadow.count(), 1);
    assert.equal(await scrollShadow.evaluate((element) => element.scrollHeight > element.clientHeight), true);
    await scrollShadow.evaluate((element) => { element.scrollTop = 0; });
    await scrollShadow.and(connection.locator('[data-bottom-scroll="true"]')).waitFor();
    assert.notEqual(await scrollShadow.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).maskImage), "none");
    await rdp.screenshot({ path: join(artifacts, "rdp-form-validation.png"), animations: "disabled" });
    await scrollShadow.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await scrollShadow.and(connection.locator('[data-top-scroll="true"][data-bottom-scroll="false"]')).waitFor();
    await rdp.screenshot({ path: join(artifacts, "rdp-custom-validation.png"), animations: "disabled" });
    await connection.getByLabel("Port", { exact: true }).fill("3389");
    await resolution.selectOption("1920x1080");
    assert.equal(await connection.getByLabel("Desktop width", { exact: true }).count(), 0);
    assert.equal(await connection.getByLabel("Password", { exact: true }).inputValue(), "");
    const remember = connection.getByLabel("Remember password", { exact: true });
    assert.equal(await remember.inputValue(), "none");
    assert.deepEqual(await remember.locator("option").allTextContents(), ["Do not save", "Until the app quits", "Save securely on this device"]);
    assert.equal(await remember.locator('option[value="secure"]').isDisabled(), true);
    await connection.getByText("Secure password storage is unavailable. Passwords can be remembered until the app quits.", { exact: true }).waitFor();
    await remember.selectOption("session");
    await connection.getByLabel("Connection name", { exact: true }).fill("Offline RDP profile");
    await connection.getByLabel("Computer", { exact: true }).fill("rdp.invalid");
    await connection.getByLabel("Username", { exact: true }).fill("offline-operator");
    await connection.getByRole("button", { name: "Save profile", exact: true }).click();
    await connection.getByRole("status").filter({ hasText: "Profile saved." }).waitFor();
    assert.equal(await connection.getByLabel("Password", { exact: true }).inputValue(), "");
    const saved = await readState(rdp);
    assert.equal(saved.profiles.length, 1);
    assert.equal(saved.profiles[0]?.width, 1920);
    assert.equal(saved.profiles[0]?.height, 1080);
    assert.equal(saved.profiles[0]?.clipboard, false);
    assert.equal(saved.profiles[0]?.hasCredential, false);
    assert.equal(saved.profiles[0]?.credentialPersistence, "none", "Saving a profile never creates a credential");
    assert.deepEqual(saved.tabs, [], "Saving a profile never starts a remote session");
    const persisted = JSON.parse(await readFile(join(temporary, "client/gui/rdp.json"), "utf8")) as { profiles: Record<string, unknown>[] };
    assert.equal(persisted.profiles.length, 1);
    assert.equal(Object.hasOwn(persisted.profiles[0]!, "password"), false);
    assert.equal(Object.hasOwn(persisted.profiles[0]!, "encryptedCredential"), false);
    await connection.getByRole("button", { name: "Cancel", exact: true }).click();
    await connection.waitFor({ state: "hidden" });

    const profiles = rdp.getByRole("region", { name: "Saved profiles", exact: true });
    await profiles.getByText("Offline RDP profile", { exact: true }).waitFor();
    // This Connect button only opens the saved profile editor; no connection is submitted.
    await profiles.getByRole("button", { name: "Connect", exact: true }).click();
    const editor = rdp.getByRole("dialog", { name: "Connect to Remote Desktop", exact: true });
    assert.equal(await editor.getByLabel("Computer", { exact: true }).inputValue(), "rdp.invalid");
    assert.equal(await editor.getByLabel("Desktop resolution", { exact: true }).inputValue(), "1920x1080");
    assert.equal(await editor.getByRole("switch", { name: "Text clipboard", exact: true }).isChecked(), false);
    assert.equal(await editor.getByLabel("Password", { exact: true }).inputValue(), "");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });

    await rdp.getByRole("button", { name: "New connection", exact: true }).click();
    assert.equal(await clipboard.isChecked(), false);
    await clipboard.press("Space");
    await assertClipboardPreference(temporary, true);
    await connection.getByRole("button", { name: "Cancel", exact: true }).click();
    await connection.waitFor({ state: "hidden" });
    await profiles.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(await editor.getByRole("switch", { name: "Text clipboard", exact: true }).isChecked(), false,
      "A saved profile keeps its explicit clipboard choice when the new-connection preference changes");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await profiles.getByRole("button", { name: "Delete Offline RDP profile", exact: true }).click();
    const deletion = rdp.getByRole("dialog", { name: "Delete Profile", exact: true });
    await deletion.getByRole("button", { name: "Delete profile", exact: true }).click();
    await deletion.waitFor({ state: "hidden" });
    assert.deepEqual((await readState(rdp)).profiles, []);
    assert.deepEqual(JSON.parse(await readFile(join(temporary, "client/gui/rdp.json"), "utf8")).profiles, []);
    await rdp.screenshot({ path: join(artifacts, "rdp-window-offline.png"), animations: "disabled" });

    const closed = rdp.waitForEvent("close");
    await (await application.browserWindow(rdp)).evaluate((window) => window.close());
    await closed;
    assert.equal(workspace.isClosed(), false);
    assert.equal(application.windows().filter((page) => !page.isClosed()).length, windowCount - 1);

    // Expose the available choice deterministically without using a real OS keychain.
    await setSecureStorageAvailable(application, true);
    rdp = await openRdpWindow(application, errors, workspace);
    assert.equal((await readState(rdp)).securePersistenceAvailable, true);
    await rdp.getByRole("button", { name: "New connection", exact: true }).click();
    const secureDialog = rdp.getByRole("dialog", { name: "New Remote Desktop", exact: true });
    assert.equal(await secureDialog.getByRole("switch", { name: "Text clipboard", exact: true }).isChecked(), true,
      "The clipboard preference survives closing and reopening the standalone window");
    const secureRemember = secureDialog.getByLabel("Remember password", { exact: true });
    assert.equal(await secureRemember.locator('option[value="secure"]').isDisabled(), false);
    await secureRemember.selectOption("secure");
    assert.equal(await secureDialog.getByLabel("Password", { exact: true }).inputValue(), "");
    await secureDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual((await readState(rdp)).tabs, []);
    assert.deepEqual(await readdir(join(temporary, "saved")), []);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (rdp && !rdp.isClosed()) {
      await rdp.screenshot({ path: join(artifacts, "rdp-window-offline-failure.png") }).catch(() => undefined);
      context.diagnostic(JSON.stringify({ errors, body: (await rdp.locator("body").innerText().catch(() => "<unavailable>")).slice(0, 4000) }));
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => { application?.process().kill("SIGKILL"); });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("malformed private RDP settings preserve the file and leave the operator workspace usable", { timeout: 60_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-malformed-e2e-"));
  const settingsPath = join(temporary, "client/gui/rdp.json");
  const original = Buffer.from('{"privateMarker":"RDP_MALFORMED_PRIVATE_FIXTURE","profiles":');
  let application: ElectronApplication | undefined;
  try {
    await Promise.all(["saved", "managed", "user-data", "client/gui"].map((name) => mkdir(join(temporary, name), { recursive: true })));
    await writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 });
    await writeFile(settingsPath, original, { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    const count = application.windows().length;
    const messages = await application.evaluate(({ dialog, Menu }) => new Promise<{ title: string; message: string }[]>((resolveMessage) => {
      dialog.showErrorBox = (title, message) => { resolveMessage([{ title, message }]); };
      const item = Menu.getApplicationMenu()?.getMenuItemById("rdp.open");
      if (!item?.click || !item.enabled) throw new Error("RDP menu must remain available to explain the load failure");
      item.click();
    }));
    assert.deepEqual(messages, [{ title: "Remote Desktop unavailable", message: "Remote Desktop settings could not be loaded safely. Repair or restore gui/rdp.json in the client directory, then restart the application." }]);
    assert.equal(application.windows().length, count);
    assert.equal(application.windows().some((page) => page.url().includes("surface=rdp")), false);
    assert.equal(workspace.isClosed(), false);
    assert.deepEqual(await readFile(settingsPath), original);
    assert.deepEqual(await readdir(join(temporary, "saved")), []);
  } finally {
    if (application) await application.close().catch(() => { application?.process().kill("SIGKILL"); });
    await rm(temporary, { recursive: true, force: true });
  }
});

async function setSecureStorageAvailable(application: ElectronApplication, available: boolean): Promise<void> {
  await application.evaluate(({ safeStorage }, enabled) => {
    safeStorage.isEncryptionAvailable = () => enabled;
    if (process.platform === "linux") safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    safeStorage.encryptString = () => { throw new Error("Offline RDP profile test must not encrypt credentials"); };
    safeStorage.decryptString = () => { throw new Error("Offline RDP profile test must not decrypt credentials"); };
  }, available);
}

async function invokeRdpMenu(application: ElectronApplication, id = "network.rdp"): Promise<void> {
  await application.evaluate(({ Menu }, menuId) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById(menuId);
    if (!item?.click || !item.enabled) throw new Error("Standalone Remote Desktop menu is unavailable");
    item.click();
  }, id);
}

async function openRdpWindow(application: ElectronApplication, errors: string[], workspace?: Page): Promise<Page> {
  const opened = application.waitForEvent("window");
  // Keep cleanup from masking a failed palette/menu action with an unhandled
  // window-event rejection. The awaited promise still propagates open failures.
  void opened.catch(() => undefined);
  if (workspace) {
    await workspace.bringToFront();
    await workspace.getByLabel("Open command palette", { exact: true }).click();
    await workspace.getByRole("searchbox", { name: "Search commands" }).fill("rdp");
    await workspace.screenshot({
      path: resolve(import.meta.dirname, "../../../artifacts/e2e/rdp-command-palette.png"),
      animations: "disabled",
    });
    await workspace.getByRole("menuitem", { name: /^Remote Desktop/u }).click();
  } else {
    await invokeRdpMenu(application);
  }
  const page = await opened;
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
  await page.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
  return page;
}

async function readState(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const result = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}

async function assertClipboardPreference(temporary: string, expected: boolean): Promise<void> {
  const settingsPath = join(temporary, "client/gui/application-settings.json");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { rdp?: { clipboard?: boolean } };
      if (settings.rdp?.clipboard === expected) return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) throw new Error(`Text clipboard preference ${expected} was not persisted to application settings`);
    await delay(25);
  }
}

async function assertRdpBoundary(application: ElectronApplication, page: Page): Promise<void> {
  assert.equal(page.url(), "sliver://app/index.html?surface=rdp");
  const bridge = await page.evaluate(() => {
    const browser = globalThis as unknown as Record<string, unknown>;
    return { frozen: Object.isFrozen(browser["rdp"]), unavailable: ["sliver", "network", "ssh", "cloudDeployment", "require", "ipcRenderer"].map((key) => typeof browser[key]),
      keys: Object.keys(browser["rdp"] as object).sort() };
  });
  assert.equal(bridge.frozen, true);
  assert.deepEqual(bridge.unavailable, Array(6).fill("undefined"));
  assert.deepEqual(bridge.keys, ["attach", "clipboard", "closeTab", "connect", "deleteProfile", "disconnect", "getApplicationSettings", "getState",
    "onApplicationSettingsChanged", "onStateChanged", "openRdpStream", "reconnect", "renameTab", "respondToCertificate", "saveProfile", "selectTab", "setInputCapture", "toggleFullscreen", "updateApplicationSettings"]);
  const native = await (await application.browserWindow(page)).evaluate((window) => {
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration,
      webSecurity: preferences.webSecurity, parent: window.getParentWindow()?.id ?? null, modal: window.isModal() };
  });
  assert.deepEqual(native, { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, parent: null, modal: false });
  assert.equal(await application.evaluate(({ BrowserWindow, session }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === "sliver://app/index.html?surface=rdp");
    return window?.webContents.session === session.fromPartition("sliver-rdp") && window.webContents.session !== session.defaultSession;
  }), true);
  const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert.match(policy ?? "", /(?:^|;)\s*connect-src 'none'(?:;|$)/u);
  assert.match(policy ?? "", /(?:^|;)\s*object-src 'none'(?:;|$)/u);
  assert.doesNotMatch(policy ?? "", /'unsafe-inline'|'unsafe-eval'/u);
}
