import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { readBoundedRegularFile } from "../main/secure-file.js";
import type { RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";
import { parseRdpConnect, rdpInteger, rdpRecord, rdpString } from "../shared/rdp-validation.js";

const configFile = process.env["SLIVER_RDP_REMOTE_SCREEN_E2E_CONFIG_FILE"];
type LoginStep = { readonly key: string } | { readonly click: { readonly x: number; readonly y: number } }
  | { readonly text: "username" | "password" } | { readonly waitMs: number };
const navigationKeys = new Set(["Control+Alt+Delete", "Tab", "Shift+Tab", "Enter", "Escape", "Control+a", "Backspace",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "Space"]);

/** Explicit opt-in only. The private config names a disposable desktop and an independently verified certificate.
 * loginSteps uses remote framebuffer coordinates and credential placeholders, never literal secret text.
 * Existing rdp-live.e2e.ts is the separate default-NLA success control.
 */
test("RDP remote-screen sign-in renders before credentials, then logs in or rejects an NLA-only server", {
  skip: !configFile, timeout: 240_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const bytes = (await readBoundedRegularFile(configFile!, { label: "Remote-screen RDP live test configuration", maxBytes: 32_768, requirePrivateMode: true })).data;
  let raw: Record<string, unknown>;
  try { raw = rdpRecord(JSON.parse(bytes.toString("utf8"))); }
  catch { throw new Error("Invalid private remote-screen test configuration"); }
  finally { bytes.fill(0); }
  // These credentials belong only to the test driver. The connection dialog never receives them.
  const config = parseRdpConnect({ ...raw, signInMode: "nla" });
  const fingerprint = rdpString(raw["fingerprint"], 64).toLowerCase();
  const scenario = raw["scenario"];
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || !config.password || !config.clipboard
    || (scenario !== "login" && scenario !== "nla-required")) {
    throw new Error("Remote-screen test requires a fingerprint, password, clipboard enabled, and login or nla-required scenario");
  }
  const loginUsername = raw["loginUsername"] === undefined
    ? config.domain ? `${config.domain}\\${config.username}` : config.username : rdpString(raw["loginUsername"], 512);
  const loginSteps = parseLoginSteps(raw["loginSteps"]);
  const holdBeforeLogin = rdpInteger(Number(process.env["SLIVER_RDP_REMOTE_SCREEN_E2E_HOLD_BEFORE_LOGIN_MS"] ?? "0"), 0, 60_000);
  const artifactPrefix = process.env["SLIVER_RDP_REMOTE_SCREEN_E2E_ARTIFACT_PREFIX"] ?? `rdp-remote-screen-${scenario}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/iu.test(artifactPrefix)) throw new Error("Invalid remote-screen test artifact prefix");
  const artifacts = join(repositoryRoot, "artifacts", "e2e");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-remote-screen-e2e-"));
  const marker = `Remote-screen RDP clipboard ${randomUUID()} — café Ω 日本語`;
  const keyboardMarker = `Remote-screen keyboard ${randomUUID()}`;
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let savedClipboard = false;
  let restoringClipboard: Promise<void> | undefined;
  let result: Record<string, unknown> | undefined;
  let failure: unknown;
  let phase = "setup";
  let credentialsSent = false;
  let certificateReviewed = false;
  let rendererErrors = 0;
  const stopClipboardSync = async (): Promise<void> => {
    if (!application) return;
    try {
      if (page && !page.isClosed()) await page.evaluate(async () => {
        const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
        const current = await api.getState();
        if (!current.ok) throw new Error("Cannot read RDP state during cleanup");
        for (const tab of current.value.tabs) if (tab.state !== "disconnected" && tab.state !== "failed") {
          if (!(await api.disconnect(tab.id)).ok) throw new Error("Cannot disconnect RDP during cleanup");
        }
      });
    } catch {
      await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
    }
  };
  const restoreClipboard = (): Promise<void> => {
    if (!application || !savedClipboard) return Promise.resolve();
    return restoringClipboard ??= application.evaluate(async ({ clipboard }) => {
      const target = globalThis as unknown as { __rdpRemoteScreenClipboard?: Electron.ClipboardItem[] };
      if (target.__rdpRemoteScreenClipboard?.length) await clipboard.write(target.__rdpRemoteScreenClipboard);
      else await clipboard.clear();
      delete target.__rdpRemoteScreenClipboard;
    }).then(() => { savedClipboard = false; }).catch((error: unknown) => { restoringClipboard = undefined; throw error; });
  };
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await rm(join(artifacts, `${artifactPrefix}-result.json`), { force: true });
    await rm(join(artifacts, `${artifactPrefix}-login-screen.png`), { force: true });
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
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read();
      const snapshot = await Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
      ))));
      (globalThis as unknown as { __rdpRemoteScreenClipboard: Electron.ClipboardItem[] }).__rdpRemoteScreenClipboard = snapshot;
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
    // Store counts only: remote error strings may contain account or host data.
    page.on("pageerror", () => rendererErrors++);
    page.on("console", (message) => { if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) rendererErrors++; });
    await page.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    const window = await application.browserWindow(page);
    assert.deepEqual(await window.evaluate((win) => {
      const preferences = win.webContents.getLastWebPreferences();
      return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
    }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
    await page.getByRole("button", { name: "Configuration", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Configuration", exact: true });
    assert.equal(await settings.getByRole("switch", { name: "Transparent clipboard", exact: true }).isChecked(), false);
    await settings.getByRole("button", { name: "Done", exact: true }).click();
    await settings.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "New connection", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Remote Desktop" });
    const remoteScreen = dialog.getByRole("switch", { name: "Sign in on the remote screen", exact: true });
    assert.equal(await remoteScreen.isChecked(), false, "New connections must default to NLA");
    await remoteScreen.press("Space");
    assert.equal(await remoteScreen.isChecked(), true);
    for (const label of ["Username", "Domain", "Password", "Remember password"]) {
      assert.equal(await dialog.getByLabel(label, { exact: true }).count(), 0, "Remote-screen mode must not ask for initial credentials");
    }
    await dialog.getByLabel("Connection name", { exact: true }).fill(config.label);
    await dialog.getByLabel("Computer", { exact: true }).fill(config.host);
    await dialog.getByLabel("Port", { exact: true }).fill(String(config.port));
    await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Custom", exact: true }).click();
    assert.equal(await dialog.getByRole("button", { name: "Desktop resolution", exact: true }).getAttribute("data-selected-value"), "custom");
    await dialog.getByLabel("Desktop width", { exact: true }).fill(String(config.width));
    await dialog.getByLabel("Desktop height", { exact: true }).fill(String(config.height));
    const clipboardSwitch = dialog.getByRole("switch", { name: "Clipboard", exact: true });
    if (!await clipboardSwitch.isChecked()) await clipboardSwitch.press("Space");
    phase = "negotiation";
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await until(async () => {
      const tab = (await state(page!)).tabs[0];
      return Boolean(tab?.review) || tab?.state === "failed";
    }, "certificate review or NLA rejection", 30_000);
    let current = await state(page);
    assert.equal(current.tabs[0]?.signInMode, "remote-screen");
    assert.ok(current.tabs[0]?.username === "" && current.tabs[0]?.domain === "", "Initial connection must have no credential identity");
    if (current.tabs[0]?.review) {
      assert.equal(current.tabs[0].review.fingerprint, fingerprint, "Certificate must match the independently verified fingerprint");
      await page.getByRole("button", { name: "Trust once", exact: true }).click();
      certificateReviewed = true;
    }
    if (scenario === "nla-required") {
      phase = "expected-nla-rejection";
      await until(async () => (await state(page!)).tabs[0]?.state === "failed", "NLA-only server rejection", 30_000);
      current = await state(page);
      assert.ok(/NLA|Network Level Authentication/iu.test(current.tabs[0]?.error ?? ""), "NLA rejection must explain the required sign-in mode");
      assert.equal(await frameCount(page), 0, "An NLA-required endpoint must not enter an unauthenticated desktop");
      result = { rejectedNlaRequiredServer: true, credentialsSent: false, desktop: false, keyboard: false, unicodeClipboardRoundTrip: false };
    } else {
      phase = "login-screen";
      assert.ok(certificateReviewed, "The login test must complete certificate verification before entering credentials");
      await until(async () => (await state(page!)).tabs[0]?.state === "active", "remote-screen connection", 30_000);
      await until(async () => (await frameCount(page!)) > 0, "pre-credential login screen", 30_000);
      await application.evaluate(({ app }) => { app.focus({ steal: true }); });
      await window.evaluate((win) => { win.show(); win.focus(); });
      await until(async () => window.evaluate((win) => win.isFocused()), "native window focus", 30_000);
      await waitForVisibleCanvas(page);
      // This is the only screen saved before desktop input is independently verified. Never capture a failed password entry.
      await page.screenshot({ path: join(artifacts, `${artifactPrefix}-login-screen.png`) });
      const preCredentialFrames = await frameCount(page);
      process.stderr.write(`${JSON.stringify({ phase: "login-screen-ready", label: config.label, holdBeforeLoginMs: holdBeforeLogin })}\n`);
      if (holdBeforeLogin) await page.waitForTimeout(holdBeforeLogin);
      const input = page.getByLabel(`Keyboard input for ${config.label}`, { exact: true });
      const capture = async (): Promise<void> => {
        await input.focus();
        await page!.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
      };
      phase = "credential-input";
      for (const step of loginSteps) {
        if ("waitMs" in step) { await page.waitForTimeout(step.waitMs); continue; }
        await capture();
        if ("key" in step) {
          if (step.key === "Control+Alt+Delete") await page.getByRole("button", { name: "Send Ctrl+Alt+Delete", exact: true }).click();
          else await page.keyboard.press(step.key);
        } else if ("click" in step) await clickRemote(page, step.click);
        else {
          credentialsSent = true;
          // The same textarea input event used by IME/paste produces typed RDP Unicode events.
          // Keep credentials out of Playwright keyboard action logs and the operating-system clipboard.
          await input.evaluate((element, text) => {
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, text);
            element.dispatchEvent(new Event("input", { bubbles: true }));
          }, step.text === "username" ? loginUsername : config.password);
        }
      }
      phase = "desktop-keyboard";
      await until(async () => (await state(page!)).tabs[0]?.clipboardReady === true, "desktop clipboard negotiation", 45_000);
      // A usable shell plus exact clipboard text is the login proof; an active transport alone is not.
      await page.waitForTimeout(2_000);
      await capture();
      await page.keyboard.press("Meta+r");
      await page.waitForTimeout(500);
      await page.keyboard.type("notepad");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1_000);
      await page.keyboard.insertText(keyboardMarker);
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+c");
      await until(async () => (await state(page!)).tabs[0]?.clipboardAvailable === true, "remote keyboard clipboard offer");
      await page.getByRole("button", { name: "Receive clipboard", exact: true }).click();
      await until(async () => await application!.evaluate(({ clipboard }) => clipboard.readText()) === keyboardMarker, "remote keyboard text");
      phase = "desktop-clipboard";
      await application.evaluate(async ({ clipboard }, value) => { await clipboard.writeText(value); }, marker);
      await page.getByRole("button", { name: "Send clipboard", exact: true }).click();
      await capture();
      await page.keyboard.press("Control+v");
      await page.waitForTimeout(300);
      await page.keyboard.press("Control+a");
      await page.keyboard.press("Control+c");
      await until(async () => (await state(page!)).tabs[0]?.clipboardAvailable === true, "remote Unicode clipboard offer");
      await application.evaluate(async ({ clipboard }) => { await clipboard.writeText("remote-screen local sentinel"); });
      await page.getByRole("button", { name: "Receive clipboard", exact: true }).click();
      await until(async () => await application!.evaluate(({ clipboard }) => clipboard.readText()) === marker, "Unicode clipboard round trip");
      // Exact marker readback establishes that this foreground Notepad document is owned by the test.
      await capture();
      await page.keyboard.press("Alt+F4");
      await page.waitForTimeout(300);
      await page.keyboard.press("Alt+n");
      result = { rejectedNlaRequiredServer: false, credentialsSent: true, preCredentialFrames, preCredentialScreenVisible: true,
        desktop: true, keyboard: true, unicodeClipboardRoundTrip: true };
    }
    phase = "disconnect";
    const tab = (await state(page)).tabs[0];
    if (tab?.state === "active") {
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await until(async () => (await state(page!)).tabs[0]?.state === "disconnected", "disconnect");
    }
    const persisted = await readFile(join(temporary, "client", "gui", "rdp.json"), "utf8").catch(() => "");
    assert.ok(!persisted.includes(config.password) && !persisted.includes(marker), "Passwords and clipboard text must not appear in plaintext persistence");
    assert.equal(rendererErrors, 0, "Renderer and CSP errors must be absent");
    const build = JSON.parse(await readFile(join(repositoryRoot, "native", "rdp", "bin", "provenance.json"), "utf8")) as {
      source: { commit: string }; buildIdentity: string; artifact: { sha256: string };
    };
    result = { ...result, scenario, label: config.label, fingerprint, width: config.width, height: config.height,
      signInMode: "remote-screen", nlaDefault: true, initialCredentialFieldsAbsent: true, initialCredentialIdentityEmpty: true,
      certificateReviewed, disconnect: tab?.state === "active", ironRdpRevision: build.source.commit,
      helperSha256: build.artifact.sha256, buildIdentity: build.buildIdentity, clientPlatform: process.platform,
      clientArchitecture: process.arch, clientKernel: release(), electronVersion: await application.evaluate(() => process.versions.electron) };
  } catch {
    // Deliberately do not print the caught error, DOM, remote error messages, or screenshots after credentials.
    failure = new Error(`Remote-screen RDP test failed during ${phase}`);
    const current = page && !page.isClosed() ? await state(page).catch(() => undefined) : undefined;
    context.diagnostic(JSON.stringify({ phase, scenario, credentialsSent, certificateReviewed, rendererErrors,
      tabs: current?.tabs.map((tab) => ({ state: tab.state, review: Boolean(tab.review) })) }));
  } finally {
    if (application) {
      try { await stopClipboardSync(); await restoreClipboard(); }
      catch { failure ??= new Error("Remote-screen test could not restore the original clipboard"); }
      try { await application.close(); }
      catch { application.process().kill("SIGKILL"); failure ??= new Error("Remote-screen test could not close Electron cleanly"); }
    }
    await rm(temporary, { recursive: true, force: true }).catch(() => { failure ??= new Error("Remote-screen test could not remove its local temporary directory"); });
  }
  if (failure) throw failure;
  assert.ok(result, "A completed scenario must produce evidence");
  await writeFile(join(artifacts, `${artifactPrefix}-result.json`), JSON.stringify({ ...result, clipboardRestored: true,
    applicationClosed: true, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
});

function parseLoginSteps(value: unknown): readonly LoginStep[] {
  if (value === undefined) return [{ key: "Control+Alt+Delete" }, { waitMs: 700 }, { text: "username" }, { key: "Tab" },
    { text: "password" }, { key: "Enter" }, { waitMs: 2_000 }];
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) throw new Error("Invalid remote-screen login steps");
  let waits = 0, passwords = 0, usernames = 0;
  const steps = value.map((raw: unknown): LoginStep => {
    const step = rdpRecord(raw);
    if (Object.keys(step).length !== 1) throw new Error("Invalid remote-screen login step");
    if (typeof step["key"] === "string" && navigationKeys.has(step["key"])) return { key: step["key"] };
    if (step["text"] === "username") { usernames++; return { text: "username" }; }
    if (step["text"] === "password") { passwords++; return { text: "password" }; }
    if (step["waitMs"] !== undefined) { const waitMs = rdpInteger(step["waitMs"], 0, 5_000); waits += waitMs; return { waitMs }; }
    if (step["click"] !== undefined) {
      const click = rdpRecord(step["click"]);
      if (Object.keys(click).some((key) => key !== "x" && key !== "y")) throw new Error("Invalid remote-screen click");
      return { click: { x: rdpInteger(click["x"], 0, 8191), y: rdpInteger(click["y"], 0, 8191) } };
    }
    throw new Error("Invalid remote-screen login step");
  });
  if (waits > 60_000 || passwords !== 1 || usernames > 1) throw new Error("Login steps require one password entry and at most one username entry");
  return steps;
}

async function clickRemote(page: Page, point: { readonly x: number; readonly y: number }): Promise<void> {
  const position = await page.locator(".rdp-screen__canvas").evaluate((element, point) => {
    const canvas = element as unknown as { width: number; height: number; getBoundingClientRect(): { x: number; y: number; width: number; height: number } };
    if (point.x >= canvas.width || point.y >= canvas.height) throw new Error("Login click is outside the remote screen");
    const box = canvas.getBoundingClientRect(), scale = Math.min(box.width / canvas.width, box.height / canvas.height);
    return { x: box.x + (box.width - canvas.width * scale) / 2 + point.x * scale,
      y: box.y + (box.height - canvas.height * scale) / 2 + point.y * scale };
  }, point);
  await page.mouse.click(position.x, position.y);
}

async function state(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const result = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!result.ok) throw new Error("Cannot read RDP state");
    return result.value;
  });
}
async function frameCount(page: Page): Promise<number> {
  const screen = page.locator(".rdp-screen");
  return await screen.count() ? Number(await screen.getAttribute("data-frame-count")) : 0;
}
async function waitForVisibleCanvas(page: Page): Promise<void> {
  let visibleSince = 0;
  await until(async () => {
    const visible = await page.locator(".rdp-screen__canvas").evaluate((element) => {
      const canvas = element as unknown as { width: number; height: number;
        getContext(type: "2d"): { getImageData(x: number, y: number, width: number, height: number): { data: Uint8ClampedArray } } | null };
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height) return false;
      const minimum = [255, 255, 255], maximum = [0, 0, 0];
      let lit = 0;
      // Read only 48 pixels, evenly spread across the frame. Neither pixel data nor screenshots
      // cross the renderer boundary until the initial black/uniform surface has been replaced.
      for (let row = 0; row < 6; row++) for (let column = 0; column < 8; column++) {
        const x = Math.min(canvas.width - 1, Math.floor((column + 0.5) * canvas.width / 8));
        const y = Math.min(canvas.height - 1, Math.floor((row + 0.5) * canvas.height / 6));
        const pixel = context.getImageData(x, y, 1, 1).data;
        if ((pixel[3] ?? 0) < 128) continue;
        if (Math.max(pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0) >= 32) lit++;
        for (let channel = 0; channel < 3; channel++) {
          minimum[channel] = Math.min(minimum[channel]!, pixel[channel]!);
          maximum[channel] = Math.max(maximum[channel]!, pixel[channel]!);
        }
      }
      return lit >= 4 && maximum.some((value, channel) => value - minimum[channel]! >= 24);
    });
    if (!visible) { visibleSince = 0; return false; }
    visibleSince ||= Date.now();
    // Keep a short settling interval so the first partially painted login frame is not the evidence image.
    return Date.now() - visibleSince >= 600;
  }, "visible pre-credential login screen", 30_000);
}
async function until(predicate: () => Promise<boolean>, description: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Remote-screen test timed out waiting for ${description}`);
}
