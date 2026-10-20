import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { RdpConnectInput, RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";

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
    await profiles.getByRole("button", { name: "Connect to Offline RDP profile", exact: true }).click();
    const passwordPrompt = rdp.getByRole("dialog", { name: "Connect to Offline RDP profile", exact: true });
    await passwordPrompt.waitFor();
    assert.equal(await passwordPrompt.getByLabel("Password", { exact: true }).inputValue(), "");
    assert.equal(await passwordPrompt.getByLabel("Computer", { exact: true }).count(), 0);
    assert.deepEqual((await readState(rdp)).tabs, [], "A profile without a saved credential asks for a password before connecting");
    await passwordPrompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await passwordPrompt.waitFor({ state: "hidden" });

    const profileMenu = await openSavedProfileMenu(rdp, profiles.getByRole("button", { name: "Connect to Offline RDP profile", exact: true }));
    await profileMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = rdp.getByRole("dialog", { name: "Edit Remote Desktop", exact: true });
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
    await openSavedProfileMenu(rdp, profiles.getByRole("button", { name: "Connect to Offline RDP profile", exact: true }));
    await profileMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
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

test("saved RDP connections display private frame previews after restart and remain usable at narrow widths", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-previews-e2e-"));
  const settingsPath = join(temporary, "client/gui/rdp.json");
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const profiles = [
    { id: "preview-design", label: "DESIGN-PC", host: "design.example.invalid", username: "designer", domain: "STUDIO" },
    { id: "preview-build", label: "BUILD-SERVER", host: "build.example.invalid", username: "builder", domain: "LAB" },
    { id: "preview-lab", label: "LAB-DESKTOP", host: "lab.example.invalid", username: "operator", domain: "LAB" },
    { id: "preview-qa", label: "QA-WINDOWS", host: "qa.example.invalid", username: "tester", domain: "LAB" },
    { id: "preview-staging", label: "STAGING-VM", host: "staging.example.invalid", username: "admin", domain: "" },
    { id: "preview-support", label: "SUPPORT-PC", host: "support.example.invalid", username: "support", domain: "STUDIO" },
  ].map((profile) => ({ ...profile, port: 3389, width: 1280, height: 800, clipboard: true, scaleMode: "fit" }));
  const previewPath = (id: string): string => `${settingsPath}.preview-${createHash("sha256").update(id).digest("hex")}.json`;
  let application: ElectronApplication | undefined;
  let rdp: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client/gui"].map((name) => mkdir(join(temporary, name), { recursive: true })));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 });
    await writeFile(settingsPath, JSON.stringify({ version: 1, profiles, pins: [] }), { mode: 0o600 });
    application = await launchOfflineRdpApplication(repositoryRoot, temporary);
    let ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    // These synthetic desktop images contain no real remote-screen information.
    const previewImages = await createPreviewFixtures(application);
    await application.close();
    application = undefined;
    await Promise.all(previewImages.map((dataUrl, index) => {
      const profile = profiles[index]!;
      return writeFile(previewPath(profile.id), JSON.stringify({
        version: 1,
        identity: JSON.stringify([`${profile.host}:${profile.port}`, profile.username, profile.domain]),
        preview: { dataUrl, capturedAt: "2026-10-19T20:00:00.000Z", width: 480, height: 300 },
      }), { mode: 0o600 });
    }));

    application = await launchOfflineRdpApplication(repositoryRoot, temporary);
    ownedProcess = application.process();
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    rdp = await openRdpWindow(application, errors);
    await setRdpTheme(rdp, "light");
    const saved = rdp.getByRole("region", { name: "Saved profiles", exact: true });
    await saved.getByRole("heading", { name: "Saved Connections", exact: true }).waitFor();
    const cards = saved.locator(".rdp-profile-card");
    assert.equal(await cards.count(), profiles.length);
    assert.equal(await saved.getByText("No preview yet", { exact: true }).count(), 3);
    for (const profile of profiles.slice(0, 3)) {
      const preview = saved.getByRole("img", { name: `Last saved desktop for ${profile.label}`, exact: true });
      await preview.waitFor();
      assert.equal(await preview.evaluate(async (image) => {
        const raster = image as unknown as { decode(): Promise<void>; complete: boolean; naturalWidth: number; naturalHeight: number };
        await raster.decode();
        return raster.complete && raster.naturalWidth === 480 && raster.naturalHeight === 300;
      }), true, "A persisted preview is decoded as an actual image");
    }
    const initialState = await readState(rdp);
    assert.equal(initialState.profiles.filter(({ preview }) => preview).length, 3);
    assert.deepEqual(initialState.tabs, [], "Browsing saved connections does not contact any RDP server");
    const firstBounds = await cards.nth(0).boundingBox();
    const secondBounds = await cards.nth(1).boundingBox();
    assert.ok(firstBounds && secondBounds);
    assert.ok(secondBounds.x > firstBounds.x && Math.abs(secondBounds.y - firstBounds.y) <= 1, "Saved connections use a multi-column preview grid");
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections.png"), animations: "disabled" });
    await setRdpTheme(rdp, "dark");
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections-dark.png"), animations: "disabled" });

    const profileMenu = await openSavedProfileMenu(rdp, saved.getByRole("button", { name: "Connect to DESIGN-PC", exact: true }));
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connection-menu.png"), animations: "disabled" });
    await profileMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = rdp.getByRole("dialog", { name: "Edit Remote Desktop", exact: true });
    assert.equal(await editor.getByLabel("Computer", { exact: true }).inputValue(), "design.example.invalid");
    assert.equal(await editor.getByLabel("Password", { exact: true }).inputValue(), "");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });

    await rdp.getByRole("button", { name: "Saved profiles", exact: true }).click();
    const picker = rdp.getByRole("dialog", { name: "Saved Connections", exact: true });
    await picker.waitFor();
    assert.equal(await picker.locator(".rdp-profile-card").count(), profiles.length);
    assert.equal(await picker.getByRole("img", { name: "Last saved desktop for DESIGN-PC", exact: true }).count(), 1);
    assert.equal(await picker.locator(".rdp-profile-grid").evaluate((grid) => grid.scrollWidth <= grid.clientWidth + 1), true);
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections-picker.png"), animations: "disabled" });
    await picker.locator('[data-slot="modal-footer"]').getByRole("button", { name: "Close", exact: true }).click();
    await picker.waitFor({ state: "hidden" });

    const nativeWindow = await application.browserWindow(rdp);
    await nativeWindow.evaluate((window) => window.setSize(800, 700));
    await rdp.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 800);
    assert.equal(await saved.locator(".rdp-profile-grid").evaluate((grid) => grid.scrollWidth <= grid.clientWidth + 1), true);
    assert.equal(await rdp.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1), true);
    const gridBounds = await saved.locator(".rdp-profile-grid").boundingBox();
    assert.ok(gridBounds);
    for (let index = 0; index < profiles.length; index += 1) {
      const bounds = await cards.nth(index).boundingBox();
      assert.ok(bounds);
      assert.ok(bounds.x >= gridBounds.x - 1 && bounds.x + bounds.width <= gridBounds.x + gridBounds.width + 1,
        "Every saved connection fits within the narrow grid");
    }
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections-narrow.png"), animations: "disabled" });
    await nativeWindow.evaluate((window) => { window.setMinimumSize(540, 600); window.setSize(540, 700); });
    await rdp.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 540);
    assert.equal(await saved.locator(".rdp-profile-grid").evaluate((grid) => grid.scrollWidth <= grid.clientWidth + 1), true);
    assert.equal(await rdp.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth + 1), true);
    const stackedFirst = await cards.nth(0).boundingBox();
    const stackedSecond = await cards.nth(1).boundingBox();
    assert.ok(stackedFirst && stackedSecond);
    assert.ok(Math.abs(stackedFirst.x - stackedSecond.x) <= 1 && stackedSecond.y > stackedFirst.y,
      "Preview cards reflow to one column when space is limited");
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections-compact.png"), animations: "disabled" });
    await rdp.reload();
    await saved.getByRole("img", { name: "Last saved desktop for DESIGN-PC", exact: true }).waitFor();
    assert.equal((await readState(rdp)).profiles.filter(({ preview }) => preview).length, 3, "Preview state survives a renderer reload");
    await nativeWindow.evaluate((window) => { window.setMinimumSize(800, 600); window.setSize(1380, 900); });

    await openSavedProfileMenu(rdp, saved.getByRole("button", { name: "Connect to BUILD-SERVER", exact: true }));
    await profileMenu.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await editor.getByLabel("Computer", { exact: true }).fill("replacement.example.invalid");
    await editor.getByRole("button", { name: "Save profile", exact: true }).click();
    await editor.getByRole("status").filter({ hasText: "Profile saved." }).waitFor();
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    assert.equal(await saved.getByRole("img", { name: "Last saved desktop for BUILD-SERVER", exact: true }).count(), 0,
      "Changing the endpoint clears the old desktop preview");
    await assert.rejects(readFile(previewPath("preview-build")), { code: "ENOENT" });

    await openSavedProfileMenu(rdp, saved.getByRole("button", { name: "Connect to DESIGN-PC", exact: true }));
    await profileMenu.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deletion = rdp.getByRole("dialog", { name: "Delete Profile", exact: true });
    await deletion.getByRole("button", { name: "Delete profile", exact: true }).click();
    await deletion.waitFor({ state: "hidden" });
    assert.equal(await saved.getByRole("button", { name: "Connect to DESIGN-PC", exact: true }).count(), 0);
    await assert.rejects(readFile(previewPath("preview-design")), { code: "ENOENT" });
    const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as { profiles: { id: string }[] };
    assert.equal(persisted.profiles.some(({ id }) => id === "preview-design"), false);
    assert.deepEqual((await readState(rdp)).tabs, []);
    assert.deepEqual(await readdir(join(temporary, "saved")), []);
    assert.deepEqual(errors, []);
  } catch (error) {
    if (rdp && !rdp.isClosed()) {
      await rdp.screenshot({ path: join(artifacts, "rdp-saved-connections-failure.png") }).catch(() => undefined);
      context.diagnostic(JSON.stringify({ errors, body: (await rdp.locator("body").innerText().catch(() => "<unavailable>")).slice(0, 4000) }));
    }
    throw error;
  } finally {
    if (application) await application.close().catch(() => { application?.process().kill("SIGKILL"); });
    await rm(temporary, { recursive: true, force: true });
  }
});

test("saved RDP cards connect directly and request only missing passwords without contacting a server", { timeout: 60_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-profile-actions-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const remembered = {
    id: "remembered-desktop", label: "Remembered desktop", host: "remembered.example.invalid", port: 3391,
    username: "operator", domain: "LAB", width: 1920, height: 1080, clipboard: false, scaleMode: "actual",
    encryptedCredential: "RUlFX0ZJWFRVUkVfTk9UX0FfUkVBTF9DUkVERU5USUFM",
  };
  const prompted = { ...remembered, id: "prompted-desktop", label: "Password required desktop", host: "prompted.example.invalid",
    encryptedCredential: undefined };
  let application: ElectronApplication | undefined;
  let rdp: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client/gui"].map((name) => mkdir(join(temporary, name), { recursive: true })));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporary, "client/gui/rdp.json"), JSON.stringify({ version: 1, profiles: [remembered, prompted], pins: [] }), { mode: 0o600 });
    application = await launchOfflineRdpApplication(repositoryRoot, temporary);
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    await setSecureStorageAvailable(application, true);
    // Intercept this disposable application's IPC boundary before any card can
    // connect. The real main handler and native runtime are never invoked.
    await application.evaluate(({ ipcMain }) => {
      const probe = globalThis as unknown as { rdpConnectRequests: RdpConnectInput[] };
      probe.rdpConnectRequests = [];
      ipcMain.removeHandler("sliver:rdp:connect");
      ipcMain.handle("sliver:rdp:connect", (_event, input: RdpConnectInput) => {
        probe.rdpConnectRequests.push(input);
        return { ok: false, error: "Offline RDP connection intercepted." };
      });
    });
    rdp = await openRdpWindow(application, errors);
    const saved = rdp.getByRole("region", { name: "Saved profiles", exact: true });
    const rememberedCard = saved.getByRole("button", { name: "Connect to Remembered desktop", exact: true });
    await rememberedCard.click();
    await waitForConnectRequests(application, 1);
    assert.equal(await rdp.getByRole("dialog").count(), 0, "A remembered connection starts without opening any form");
    const expected = {
      host: remembered.host, port: remembered.port, username: remembered.username, domain: remembered.domain,
      width: remembered.width, height: remembered.height, clipboard: remembered.clipboard,
      label: remembered.label, scaleMode: remembered.scaleMode, profileId: remembered.id, persistence: "secure",
    };
    assert.deepEqual((await readConnectRequests(application))[0], expected,
      "Direct connect sends only stored connection options and requests the main-owned credential");
    await rdp.getByRole("alert").filter({ hasText: "Offline RDP connection intercepted." }).waitFor();

    const profileMenu = await openSavedProfileMenu(rdp, rememberedCard);
    await profileMenu.getByRole("menuitem", { name: "Connect", exact: true }).click();
    await waitForConnectRequests(application, 2);
    assert.deepEqual((await readConnectRequests(application))[1], expected);
    assert.equal(await rdp.getByRole("dialog").count(), 0, "The context-menu Connect action also bypasses the editor");
    await rememberedCard.and(saved.locator('[aria-disabled="false"]')).waitFor();

    await saved.getByRole("button", { name: "Connect to Password required desktop", exact: true }).focus();
    await saved.getByRole("button", { name: "Connect to Password required desktop", exact: true }).press("Enter");
    const passwordPrompt = rdp.getByRole("dialog", { name: "Connect to Password required desktop", exact: true });
    await passwordPrompt.waitFor();
    assert.equal((await readConnectRequests(application)).length, 2, "A missing credential is requested before IPC");
    assert.equal(await passwordPrompt.getByLabel("Password", { exact: true }).inputValue(), "");
    for (const label of ["Computer", "Username", "Connection name", "Desktop resolution"]) {
      assert.equal(await passwordPrompt.getByLabel(label, { exact: true }).count(), 0, "The connection prompt does not reopen profile settings");
    }
    assert.equal(await passwordPrompt.getByLabel("Remember password", { exact: true }).inputValue(), "none");
    await rdp.screenshot({ path: join(artifacts, "rdp-saved-connection-password.png"), animations: "disabled" });
    await passwordPrompt.getByLabel("Password", { exact: true }).fill("inert-offline-password");
    await passwordPrompt.getByLabel("Remember password", { exact: true }).selectOption("session");
    await passwordPrompt.getByRole("button", { name: "Connect", exact: true }).click();
    await waitForConnectRequests(application, 3);
    assert.deepEqual((await readConnectRequests(application))[2], {
      ...expected, host: prompted.host, label: prompted.label, profileId: prompted.id,
      password: "inert-offline-password", persistence: "session",
    });
    await passwordPrompt.getByRole("button", { name: "Cancel", exact: true }).click();
    await passwordPrompt.waitFor({ state: "hidden" });
    assert.deepEqual((await readState(rdp)).tabs, [], "The offline IPC probe never starts the RDP runtime");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (rdp && !rdp.isClosed()) await rdp.screenshot({ path: join(artifacts, "rdp-saved-connection-actions-failure.png") }).catch(() => undefined);
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

async function openSavedProfileMenu(page: Page, card: Locator): Promise<Locator> {
  await card.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Application context menu", exact: true });
  await menu.waitFor();
  for (const label of ["Connect", "Edit", "Delete"]) {
    assert.equal(await menu.getByRole("menuitem", { name: label, exact: true }).count(), 1);
  }
  return menu;
}

async function readConnectRequests(application: ElectronApplication): Promise<RdpConnectInput[]> {
  return application.evaluate(() => (globalThis as unknown as { rdpConnectRequests: RdpConnectInput[] }).rdpConnectRequests);
}

async function waitForConnectRequests(application: ElectronApplication, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await readConnectRequests(application)).length < count) {
    if (Date.now() >= deadline) throw new Error(`Expected ${count} intercepted RDP connection requests`);
    await delay(25);
  }
  assert.equal((await readConnectRequests(application)).length, count);
}

async function launchOfflineRdpApplication(repositoryRoot: string, temporary: string): Promise<ElectronApplication> {
  return electron.launch({
    args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
      join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
      `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
      `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
    cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
  } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
}

async function createPreviewFixtures(application: ElectronApplication): Promise<string[]> {
  return application.evaluate(({ nativeImage }) => [0, 1, 2].map((variant) => {
    const width = 480, height = 300;
    const bitmap = Buffer.alloc(width * height * 4);
    const fill = (left: number, top: number, boxWidth: number, boxHeight: number, red: number, green: number, blue: number): void => {
      for (let y = top; y < Math.min(top + boxHeight, height); y += 1) {
        for (let x = left; x < Math.min(left + boxWidth, width); x += 1) {
          const offset = (y * width + x) * 4;
          bitmap[offset] = blue; bitmap[offset + 1] = green; bitmap[offset + 2] = red; bitmap[offset + 3] = 255;
        }
      }
    };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const glow = Math.max(0, 1 - Math.hypot(x - 350, y - 110) / 400);
        fill(x, y, 1, 1, 9 + variant * 12, 24 + Math.round(glow * 50), 52 + Math.round(glow * 96) - variant * 15);
      }
    }
    // A synthetic desktop, with a terminal on one card and an application on another.
    fill(0, 280, width, 20, 12, 20, 34);
    for (let icon = 0; icon < 5; icon += 1) fill(176 + icon * 28, 285, 12, 10, 82 + icon * 16, 154, 204);
    for (let icon = 0; icon < 3; icon += 1) {
      fill(14, 18 + icon * 49, 16, 17, 123, 184, 219);
      fill(11, 39 + icon * 49, 24, 3, 184, 211, 233);
    }
    if (variant !== 2) {
      fill(74, 36, 354, 211, 18, 28, 43);
      fill(75, 37, 352, 22, 43, 58, 78);
      fill(85, 46, 92, 4, 183, 201, 221);
      fill(406, 44, 8, 8, 121, 142, 166);
      if (variant === 0) {
        fill(75, 60, 352, 186, 236, 241, 247);
        fill(75, 60, 74, 186, 216, 226, 238);
        for (let row = 0; row < 6; row += 1) fill(86, 78 + row * 22, 48, 5, 127, 146, 172);
        fill(165, 77, 137, 8, 49, 72, 101);
        for (let row = 0; row < 4; row += 1) {
          fill(165, 103 + row * 29, 243, 21, 250, 252, 255);
          fill(173, 111 + row * 29, 76 + row * 15, 4, 159, 177, 199);
        }
      } else {
        for (let row = 0; row < 10; row += 1) fill(88, 77 + row * 13, 38 + (row * 47) % 270, 4,
          row % 3 === 0 ? 117 : 188, row % 3 === 0 ? 212 : 204, row % 3 === 0 ? 175 : 223);
      }
    }
    return `data:image/jpeg;base64,${nativeImage.createFromBitmap(bitmap, { width, height }).toJPEG(85).toString("base64")}`;
  }));
}

async function setRdpTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const result = await page.evaluate(async (nextTheme) => {
    const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
    const current = await api.getApplicationSettings();
    return api.updateApplicationSettings({
      expectedRevision: current.revision,
      settings: {
        theme: nextTheme, appIcon: current.appIcon, reduceMotion: current.reduceMotion,
        disableWindowTransparency: current.disableWindowTransparency,
        reportScreenshotDirectory: current.reportScreenshotDirectory,
        commandPaletteShortcut: current.commandPaletteShortcut, keyboardShortcuts: current.keyboardShortcuts,
        terminal: current.terminal, overview: current.overview, rdp: current.rdp,
      },
    });
  }, theme);
  assert.equal(result.ok, true, result.error ?? `Expected RDP theme ${theme} to save`);
  await page.locator(`html.${theme}`).waitFor();
}

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
      keys: Object.keys(browser["rdp"] as object).sort(),
      contextMenuFrozen: Object.isFrozen(browser["applicationContextMenu"]),
      contextMenuKeys: Object.keys(browser["applicationContextMenu"] as object).sort() };
  });
  assert.equal(bridge.frozen, true);
  assert.deepEqual(bridge.unavailable, Array(6).fill("undefined"));
  assert.deepEqual(bridge.keys, ["attach", "clipboard", "closeTab", "connect", "deleteProfile", "disconnect", "getApplicationSettings", "getState",
    "onApplicationSettingsChanged", "onStateChanged", "openRdpStream", "reconnect", "renameTab", "respondToCertificate", "savePreview", "saveProfile", "selectTab", "setInputCapture", "toggleFullscreen", "updateApplicationSettings"]);
  assert.equal(bridge.contextMenuFrozen, true);
  assert.deepEqual(bridge.contextMenuKeys, ["executeAction", "onMenuRequested", "setOpen"]);
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
