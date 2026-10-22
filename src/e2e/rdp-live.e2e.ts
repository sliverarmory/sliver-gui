import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";
import { readBoundedRegularFile } from "../main/secure-file.js";
import { parseRdpConnect, rdpRecord, rdpString } from "../shared/rdp-validation.js";

const configFile = process.env["SLIVER_RDP_E2E_CONFIG_FILE"];

/** Explicit opt-in only: this test logs into a disposable Windows desktop. */
test("standalone RDP logs in, renders, types, round-trips Unicode clipboard, and reattaches", {
  skip: !configFile, timeout: 180_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const bytes = (await readBoundedRegularFile(configFile!, { label: "RDP live test configuration", maxBytes: 32_768, requirePrivateMode: true })).data;
  let raw: Record<string, unknown>;
  try { raw = rdpRecord(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new Error("Invalid private RDP live test configuration"); }
  finally { bytes.fill(0); }
  const config = parseRdpConnect(raw);
  const fingerprint = rdpString(raw["fingerprint"], 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || config.password === undefined || config.signInMode === "remote-screen") throw new Error("Live NLA test requires an exact certificate fingerprint and password");
  const artifactPrefix = process.env["SLIVER_RDP_E2E_ARTIFACT_PREFIX"] ?? "rdp-live";
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/iu.test(artifactPrefix)) throw new Error("Invalid live RDP test artifact prefix");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts", "e2e");
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let savedClipboard = false;
  let restoringClipboard: Promise<void> | undefined;
  let result: Record<string, unknown> | undefined;
  let primaryFailure = false;
  const errors: string[] = [];
  const marker = `Sliver RDP clipboard test ${Date.now()} — café Ω 日本語`;
  const restoreClipboard = (): Promise<void> => {
    if (!application || !savedClipboard) return Promise.resolve();
    return restoringClipboard ??= application.evaluate(async ({ clipboard }) => {
      const target = globalThis as unknown as { __rdpLivePreviousClipboard?: Electron.ClipboardItem[] };
      if (target.__rdpLivePreviousClipboard?.length) await clipboard.write(target.__rdpLivePreviousClipboard);
      else await clipboard.clear();
      delete target.__rdpLivePreviousClipboard;
    }).then(() => { savedClipboard = false; }).catch((error: unknown) => { restoringClipboard = undefined; throw error; });
  };
  const stopClipboardSync = async (): Promise<void> => {
    if (!application) return;
    try {
      if (page && !page.isClosed()) await page.evaluate(async () => {
        const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
        const current = await api.getState();
        if (!current.ok) throw new Error("Unable to read RDP state before restoring clipboard");
        for (const tab of current.value.tabs) if (tab.state !== "disconnected" && tab.state !== "failed") {
          if (!(await api.disconnect(tab.id)).ok) throw new Error("Unable to disconnect RDP before restoring clipboard");
        }
      });
    } catch {
      await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    }
  };
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await rm(join(artifacts, `${artifactPrefix}-result.json`), { force: true });
    await writeFile(join(temporary, "client", "armories.json"), "[]", { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => {
      void Promise.race([stopClipboardSync().then(restoreClipboard).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2_000))]).finally(() => { ownedProcess.kill("SIGKILL"); });
    }, { once: true });
    // Materialize all formats before any test write; native clipboard items can otherwise be deferred.
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read();
      const snapshot = await Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
      ))));
      (globalThis as unknown as { __rdpLivePreviousClipboard: Electron.ClipboardItem[] }).__rdpLivePreviousClipboard = snapshot;
    });
    savedClipboard = true;
    const workspace = await application.firstWindow();
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    const opened = application.waitForEvent("window");
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("rdp.open");
      if (!item?.click) throw new Error("RDP File menu is missing");
      item.click();
    });
    page = await opened;
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    await page.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    const window = await application.browserWindow(page);
    assert.deepEqual(await window.evaluate((win) => {
      const preferences = win.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
    assert.deepEqual(await page.evaluate(() => ({ rdp: typeof (globalThis as unknown as { rdp: unknown }).rdp,
      sliver: typeof (globalThis as unknown as { sliver?: unknown }).sliver, require: typeof (globalThis as unknown as { require?: unknown }).require })),
    { rdp: "object", sliver: "undefined", require: "undefined" });
    await page.getByRole("button", { name: "New connection", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Remote Desktop" });
    assert.equal(await dialog.getByRole("switch", { name: "Sign in on the remote screen", exact: true }).isChecked(), false,
      "The live control must use the default NLA mode");
    await dialog.getByLabel("Connection name", { exact: true }).fill(config.label);
    await dialog.getByLabel("Computer", { exact: true }).fill(config.host);
    await dialog.getByLabel("Port", { exact: true }).fill(String(config.port));
    await dialog.getByLabel("Username", { exact: true }).fill(config.username);
    await dialog.getByLabel("Domain", { exact: true }).fill(config.domain);
    await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Custom", exact: true }).click();
    assert.equal(await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).getAttribute("data-selected-value"), "custom");
    await dialog.getByLabel("Desktop width", { exact: true }).fill(String(config.width));
    await dialog.getByLabel("Desktop height", { exact: true }).fill(String(config.height));
    const clipboardSwitch = dialog.getByRole("switch", { name: "Clipboard", exact: true });
    if (await clipboardSwitch.isChecked() !== config.clipboard) await clipboardSwitch.press("Space");
    assert.equal(await clipboardSwitch.isChecked(), config.clipboard);
    // Keep authentication values out of Playwright action logs and assertion output.
    await dialog.getByLabel("Password", { exact: true }).evaluate((element, password) => {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, password);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, config.password);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await until(async () => (await state(page!)).tabs.some((tab) => Boolean(tab.review)), 30_000);
    let current = await state(page);
    assert.equal(current.tabs[0]?.review?.fingerprint, fingerprint, "The live endpoint certificate must match the explicitly configured fingerprint");
    await page.getByRole("button", { name: "Trust once", exact: true }).click();
    await until(async () => (await state(page!)).tabs[0]?.state === "active", 30_000);
    await until(async () => Number(await page!.locator('.rdp-screen[data-active], .rdp-viewer[data-active="true"] .rdp-screen').first().getAttribute("data-frame-count")) > 0);
    await until(async () => (await state(page!)).tabs[0]?.clipboardReady === true, 20_000);
    const input = page.getByLabel(`Keyboard input for ${config.label}`, { exact: true });
    await application.evaluate(({ app }) => app.focus({ steal: true }));
    await window.evaluate((win) => { win.show(); win.focus(); });
    await until(async () => await window.evaluate((win) => win.isFocused()));
    await input.focus();
    await page.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
    const beforeRun = Number(await page.locator(".rdp-screen").getAttribute("data-frame-count"));
    await page.keyboard.press("Meta+r");
    await until(async () => Number(await page!.locator(".rdp-screen").getAttribute("data-frame-count")) > beforeRun);
    // A visible remote shell window must finish its opening animation before typing.
    await page.waitForTimeout(400);
    await page.keyboard.type("notepad");
    await page.keyboard.press("Enter");
    // Wait for the remote window to repaint before delivering the test text.
    const before = Number(await page.locator(".rdp-screen").getAttribute("data-frame-count"));
    await until(async () => Number(await page!.locator(".rdp-screen").getAttribute("data-frame-count")) > before);
    await page.waitForTimeout(500);
    await page.keyboard.insertText("Sliver RDP keyboard test");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    await until(async () => (await state(page!)).tabs[0]?.clipboardAvailable === true);
    await page.getByRole("button", { name: "Receive clipboard", exact: true }).click();
    await until(async () => await application!.evaluate(({ clipboard }) => clipboard.readText()) === "Sliver RDP keyboard test");
    await application.evaluate(async ({ clipboard }, text) => { await clipboard.writeText(text); }, marker);
    await page.getByRole("button", { name: "Send clipboard", exact: true }).click();
    await input.focus();
    await page.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
    await page.keyboard.press("Control+v");
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+c");
    await until(async () => (await state(page!)).tabs[0]?.clipboardAvailable === true);
    await application.evaluate(async ({ clipboard }) => { await clipboard.writeText("local clipboard sentinel"); });
    await page.getByRole("button", { name: "Receive clipboard", exact: true }).click();
    await until(async () => await application!.evaluate(({ clipboard }) => clipboard.readText()) === marker, 15_000);
    await page.screenshot({ path: join(artifacts, `${artifactPrefix}-desktop.png`) });

    // Discard only this test's unsaved Notepad document before disconnecting.
    await input.focus();
    await page.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
    await page.keyboard.press("Alt+F4");
    await page.waitForTimeout(300);
    await page.keyboard.press("Alt+n");

    current = await state(page);
    const sessionId = current.tabs[0]!.id, attempt = current.tabs[0]!.attempt;
    await page.reload();
    await until(async () => Number(await page!.locator(".rdp-screen").getAttribute("data-frame-count")) > 0);
    current = await state(page);
    assert.equal(current.tabs[0]?.id, sessionId);
    assert.equal(current.tabs[0]?.attempt, attempt, "Renderer reload must reattach without reauthentication");
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await until(async () => (await state(page!)).tabs[0]?.state === "disconnected");
    const persisted = await readFile(join(temporary, "client", "gui", "rdp.json"), "utf8").catch(() => "");
    assert.ok(!persisted.includes(config.password) && !persisted.includes(marker), "Passwords and clipboard text must not appear in plaintext persistence");
    assert.deepEqual(errors, []);
    const build = JSON.parse(await readFile(join(repositoryRoot, "native", "rdp", "bin", "provenance.json"), "utf8")) as {
      source: { commit: string }; buildIdentity: string; artifact: { sha256: string };
    };
    result = { host: config.host, port: config.port, fingerprint, width: config.width, height: config.height,
      ironRdpRevision: build.source.commit, helperSha256: build.artifact.sha256, buildIdentity: build.buildIdentity,
      clientPlatform: process.platform, clientArchitecture: process.arch, clientKernel: release(),
      electronVersion: await application.evaluate(() => process.versions.electron),
      nlaLogin: true, desktop: true, keyboard: true, unicodeClipboardRoundTrip: true, rendererReattach: true, disconnect: true };
  } catch (error) {
    primaryFailure = true;
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifacts, `${artifactPrefix}-failure.png`) }).catch(() => undefined);
      const snapshot = await state(page).catch(() => undefined);
      context.diagnostic(JSON.stringify({ tabs: snapshot?.tabs.map(({ state, review }) => ({ state, review: Boolean(review) })),
        alertCount: await page.getByRole("alert").count().catch(() => 0), errorCount: errors.length }));
    }
    throw error;
  } finally {
    let cleanupFailure: Error | undefined;
    if (application) {
      try { await stopClipboardSync(); await restoreClipboard(); }
      catch { cleanupFailure = new Error("Live RDP test could not restore the original clipboard"); }
      await application.close().catch(() => { application?.process().kill("SIGKILL"); cleanupFailure ??= new Error("Live RDP test could not close Electron cleanly"); });
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => { cleanupFailure ??= new Error("Live RDP test could not remove its temporary directory"); });
    if (cleanupFailure) {
      if (!primaryFailure) throw cleanupFailure;
      context.diagnostic(cleanupFailure.message);
    }
  }
  assert.ok(result, "A successful live test must produce evidence");
  await writeFile(join(artifacts, `${artifactPrefix}-result.json`), JSON.stringify({ ...result, clipboardRestored: true,
    applicationClosed: true, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
});

async function state(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const result = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}
async function until(predicate: () => Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("RDP live condition timed out");
}
