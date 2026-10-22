import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { NetworkForwardingAPI } from "../shared/network-forwarding-contracts.js";
import type { RdpConnectionOptions, RdpSocks5Proxy, RdpWindowAPI, RdpWindowState } from "../shared/rdp-contracts.js";

test("RDP imports profiles and creates or selects managed session routes without connecting", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-profiles-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const sourcePassword = "FIXTURE_SAVED_RDP_PASSWORD_DO_NOT_IMPORT";
  const files = {
    first: join(temporary, "Dropped first.rdp"),
    picker: join(temporary, "Imported account prompt.rdp"),
    invalid: join(temporary, "Unsupported gateway.rdp"),
    second: join(temporary, "Dropped 日本語.rdp"),
    opened: join(temporary, "Opened by OS.rdp"),
  };
  let application: ElectronApplication | undefined;
  let rdp: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await Promise.all([
      writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 }),
      writeFile(join(temporary, "saved/rdp-session-route.cfg"), JSON.stringify({ operator: "rdp-session-route-e2e", lhost: "127.0.0.1", lport: 31337,
        ca_certificate: "FAKE_ROUTE_CA_DO_NOT_RENDER", certificate: "FAKE_ROUTE_CERT_DO_NOT_RENDER",
        private_key: "FAKE_ROUTE_KEY_DO_NOT_RENDER", token: "FAKE_TOKEN_M0_DO_NOT_RENDER" }), { mode: 0o600 }),
      writeFile(files.first, "full address:s:first.test\r\nusername:s:LAB\\operator\r\nredirectclipboard:i:1\r\n", { mode: 0o600 }),
      writeFile(files.picker, `full address:s:account.test:3390\r\ndesktopwidth:i:1920\r\ndesktopheight:i:1080\r\npassword 51:b:${sourcePassword}\r\n`, { mode: 0o600 }),
      writeFile(files.invalid, "full address:s:gateway-target.test\r\ngatewayhostname:s:gateway.test\r\ngatewayusagemethod:i:1\r\n", { mode: 0o600 }),
      writeFile(files.second, Buffer.from("\uFEFFfull address:s:unicode.test\r\nusername:s:operator\r\n", "utf16le"), { mode: 0o600 }),
      writeFile(files.opened, "full address:s:opened.test\r\naudiomode:i:2\r\n", { mode: 0o600 }),
    ]);
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => ownedProcess.kill("SIGKILL"), { once: true });
    application.on("window", (page) => {
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    });
    const workspace = await application.firstWindow();
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    const opened = application.waitForEvent("window"); void opened.catch(() => undefined);
    await application.evaluate(({ Menu }) => {
      const menu = Menu.getApplicationMenu()?.getMenuItemById("network.rdp");
      if (!menu?.click || !menu.enabled) throw new Error("Remote Desktop menu is unavailable");
      menu.click();
    });
    rdp = await opened;
    await rdp.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    await rdp.getByText("Your Windows desktops", { exact: true }).waitFor();
    assert.deepEqual((await readState(rdp)).profiles, []);
    assert.equal(await rdp.evaluate(() => typeof (globalThis as unknown as { require?: unknown }).require), "undefined");

    await dropNativeFiles(rdp, [files.first], join(artifacts, "rdp-profile-import-drop.png"));
    await rdp.getByRole("button", { name: "Connect to Dropped first", exact: true }).waitFor();
    let current = await waitForProfiles(rdp, 1);
    assert.equal(current.profiles[0]!.username, "operator");
    assert.equal(current.profiles[0]!.domain, "LAB");
    assert.equal(current.profiles[0]!.clipboard, true);
    assert.deepEqual(current.tabs, [], "Dropping a profile must not connect");

    await application.evaluate(({ dialog }, filePaths) => {
      dialog.showOpenDialog = (async (_owner, options) => {
        assertImportPicker(options);
        return { canceled: false, filePaths };
      }) as typeof dialog.showOpenDialog;
      function assertImportPicker(options: Electron.OpenDialogOptions | undefined): void {
        if (options?.title !== "Import RDP profiles" || !options.properties?.includes("multiSelections") ||
          options.filters?.[0]?.extensions.join() !== "rdp") throw new Error("Unexpected RDP import picker options");
      }
    }, [files.picker, files.invalid]);
    await rdp.getByRole("button", { name: "Import .rdp", exact: true }).click();
    const summary = rdp.getByRole("dialog", { name: "RDP import results", exact: true });
    await summary.waitFor();
    assert.match(await summary.innerText(), /1 of 2 profiles imported/u);
    assert.match(await summary.innerText(), /Saved passwords were not imported/u);
    assert.match(await summary.innerText(), /RD Gateway/u);
    assert.equal((await summary.innerText()).includes(sourcePassword), false);
    await rdp.screenshot({ path: join(artifacts, "rdp-profile-import-results.png"), animations: "disabled" });
    await summary.getByRole("button", { name: "Done", exact: true }).click();
    await summary.waitFor({ state: "hidden" });
    current = await waitForProfiles(rdp, 2);
    const imported = current.profiles.find((profile) => profile.host === "account.test")!;
    assert.equal(imported.username, ""); assert.equal(imported.port, 3390);
    assert.equal(imported.hasCredential, false); assert.equal(imported.credentialPersistence, "none");
    assert.deepEqual(current.tabs, []);
    await rdp.getByRole("button", { name: "Connect to Imported account prompt", exact: true }).click();
    const editor = rdp.getByRole("dialog", { name: "Edit Remote Desktop", exact: true });
    await editor.waitFor();
    assert.equal(await editor.getByLabel("Username", { exact: true }).inputValue(), "");
    assert.equal(await editor.getByLabel("Computer", { exact: true }).inputValue(), "account.test");
    assert.equal(await editor.getByRole("button", { name: "Networking", exact: true }).getAttribute("aria-expanded"), "false");
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });

    await dropNativeFiles(rdp, [files.second]);
    await rdp.getByRole("button", { name: "Connect to Dropped 日本語", exact: true }).waitFor();
    assert.deepEqual((await waitForProfiles(rdp, 3)).tabs, [], "A native drop into populated profiles must not connect");

    await application.evaluate(async (_electron, paths) => {
      const openFiles = (globalThis as unknown as { __SLIVER_GUI_E2E_OPEN_RDP_FILES__?: (files: readonly string[]) => Promise<void> }).__SLIVER_GUI_E2E_OPEN_RDP_FILES__;
      if (!openFiles) throw new Error("The fake-main OS import hook is unavailable");
      await openFiles(paths);
    }, [files.opened]);
    await summary.waitFor();
    assert.match(await summary.innerText(), /Opened by OS\.rdp/u);
    await summary.getByRole("button", { name: "Done", exact: true }).click();
    await summary.waitFor({ state: "hidden" });
    await waitForProfiles(rdp, 4);
    await rdp.reload();
    await rdp.getByRole("button", { name: "Connect to Opened by OS", exact: true }).waitFor();
    assert.equal(await summary.count(), 0, "A renderer reload does not replay OS import results");

    const proxy: RdpSocks5Proxy = { id: "socks5-10000000-0000-4000-8000-000000000001", label: "Workstation", host: "127.0.0.1", port: 1080, authentication: "username-password", available: true };
    const stopped: RdpSocks5Proxy = { ...proxy, id: "socks5-10000000-0000-4000-8000-000000000002", label: "Stopped workstation", port: 1081, available: false };
    await publishProxyInventory(application, await readState(rdp), [proxy, stopped]);
    await rdp.getByRole("button", { name: "Connect to Imported account prompt", exact: true }).click();
    await editor.waitFor();
    await editor.getByRole("button", { name: "Networking", exact: true }).click();
    const route = editor.getByRole("button", { name: "Connection route", exact: true });
    assert.equal(await routeValue(route), "");
    await route.click();
    assert.deepEqual(await routeMenuValues(rdp), ["", "manual", proxy.id, stopped.id], "Independent Network Manager proxy choices remain available");
    assert.equal(await routeMenuItem(rdp, stopped.id).isDisabled(), true);
    await routeMenuItem(rdp, proxy.id).click();
    await routeMenuItem(rdp, proxy.id).waitFor({ state: "hidden" });
    await editor.evaluate((element) => { for (const animation of element.getAnimations({ subtree: true })) { try { animation.finish(); } catch { /* Infinite decorative animations do not affect the form's geometry. */ } } });
    await editor.locator('[data-scroll-shadow-mode="auto"]').evaluate((element) => { element.scrollTo({ top: element.scrollHeight, behavior: "instant" }); });
    assert.equal(Math.round((await editor.boundingBox())?.width ?? 0), 640, "The connection dialog uses the wider responsive desktop size");
    await rdp.screenshot({ path: join(artifacts, "rdp-profile-networking.png"), animations: "disabled" });
    await editor.getByRole("button", { name: "Save profile", exact: true }).click();
    await waitForProfileRoute(rdp, imported.id, proxy.id);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await rdp.reload();
    await rdp.getByRole("button", { name: "Connect to Imported account prompt", exact: true }).click();
    await editor.waitFor();
    assert.equal(await routeValue(route), proxy.id, "The saved route survives a renderer reload");
    await route.click();
    assert.equal(await routeMenuItem(rdp, proxy.id).innerText(), "Saved SOCKS5 proxy (unavailable)");
    await rdp.keyboard.press("Escape");
    await routeMenuItem(rdp, proxy.id).waitFor({ state: "hidden" });
    await editor.getByRole("switch", { name: "Sign in on the remote screen", exact: true }).press("Space");
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await editor.getByText("The selected SOCKS5 proxy is unavailable. Choose an available proxy or Direct.", { exact: true }).waitFor();
    assert.deepEqual((await readState(rdp)).tabs, [], "A missing proxy cannot silently connect directly");
    await publishProxyInventory(application, await readState(rdp), [{ ...proxy, available: false }]);
    await route.click();
    assert.equal(await routeMenuItem(rdp, proxy.id).isDisabled(), true);
    assert.match(await routeMenuItem(rdp, proxy.id).innerText(), /unavailable/u);
    await rdp.keyboard.press("Escape");
    await routeMenuItem(rdp, proxy.id).waitFor({ state: "hidden" });
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    assert.deepEqual((await readState(rdp)).tabs, [], "A stopped proxy cannot silently connect directly");
    await selectRoute(rdp, route, "");
    await editor.getByRole("switch", { name: "Sign in on the remote screen", exact: true }).press("Space");
    assert.equal(await editor.getByRole("switch", { name: "Sign in on the remote screen", exact: true }).isChecked(), false);
    await editor.getByRole("button", { name: "Save profile", exact: true }).click();
    await waitForProfileRoute(rdp, imported.id, undefined);
    assert.equal((await readState(rdp)).profiles.find((profile) => profile.id === imported.id)?.signInMode, undefined);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();

    // Session choices use production inventory, opaque capabilities, registry,
    // and forwarding controller; only the backend's SOCKS implementation is fake.
    await focusPage(application, workspace);
    const workspaceConnected = await workspace.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const listed = await api.listSavedConfigs();
      if (!listed.ok || listed.value.length !== 1) throw new Error("Expected one fake operator configuration");
      const connected = await api.connectSavedConfig(listed.value[0]!.id);
      return { ok: connected.ok, error: connected.ok ? "" : connected.error };
    });
    assert.equal(workspaceConnected.ok, true, workspaceConnected.error.replace(/FAKE_[A-Z0-9_]+/gu, "[fixture credential]").replaceAll(temporary, "[test directory]"));
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await waitUntil(async () => (await readState(rdp!)).socks5Sessions?.some((session) => session.label === "m1-session") === true,
      "The live fake session did not become an RDP route choice");
    const sessions = (await readState(rdp)).socks5Sessions!;
    assert.equal(sessions.length, 1, "Only the active session is eligible; the seeded beacon is excluded");
    const via = sessions[0]!;
    assert.match(via.id, /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(via.sessionId, "m1_session");
    assert.equal(via.hostname, "m1-session-host");
    await focusPage(application, rdp);
    // Prior saves can leave a toast over the menu's final row. Let its ordinary
    // dismissal complete before opening the modal so the screenshot is unobscured.
    await rdp.mouse.move(0, 0);
    await waitUntil(async () => await rdp!.locator('[data-slot="toast"]').count() === 0,
      "Prior RDP notifications did not dismiss before capturing the route menu");
    await rdp.getByRole("button", { name: "Connect to Imported account prompt", exact: true }).click();
    await editor.waitFor();
    await editor.getByRole("button", { name: "Networking", exact: true }).click();
    const viaValue = `session:${via.id}`;
    await route.scrollIntoViewIfNeeded();
    await route.click();
    const viaItem = routeMenuItem(rdp, viaValue);
    await viaItem.scrollIntoViewIfNeeded();
    assert.equal(await viaItem.getByText("Via m1-session · m1-session-host", { exact: true }).isVisible(), true);
    assert.equal(await viaItem.getByText("Session ID: m1_session", { exact: true }).isVisible(), true);
    const routeMenu = rdp.getByRole("menu", { name: "Connection route", exact: true });
    const initialRouteChoices = await routeMenuValues(rdp);
    assert.deepEqual(initialRouteChoices, ["", "manual", viaValue]);
    await waitForVisibleRouteMenu(routeMenu);
    await rdp.screenshot({ path: join(artifacts, "rdp-session-route-menu.png"), animations: "disabled" });
    assert.equal(await editor.getByText("Use a SOCKS5 proxy created in Networking to reach this computer through a Sliver session.", { exact: true }).count(), 0);
    await viaItem.click();
    await viaItem.waitFor({ state: "hidden" });
    await waitUntil(async () => /^socks5-/u.test(await routeValue(route)), "Selecting Via did not choose the created proxy");
    const createdId = await routeValue(route);
    let starts = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.socks5Starts);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.id, createdId); assert.equal(starts[0]!.sessionId, "m1_session");
    assert.deepEqual(starts[0]!.requestedBind, { host: "127.0.0.1", port: 0 });
    assert.equal(starts[0]!.bind.host, "127.0.0.1"); assert.ok(starts[0]!.bind.port > 0);
    assert.equal(starts[0]!.authentication, "username-password");
    assert.ok(starts[0]!.usernameBytes > 0 && starts[0]!.passwordBytes > 0, "Session routing must generate proxy authentication in main");
    const created = (await readState(rdp)).socks5Proxies!.find((proxy) => proxy.id === createdId)!;
    assert.equal(created.available, true); assert.equal(created.authentication, "username-password");
    assert.equal(created.viaSessionId, via.id, "Main associates the auto-created proxy with its opaque Via choice");
    assert.deepEqual({ host: created.host, port: created.port }, starts[0]!.bind);
    assert.equal(created.label.split(" · ").at(-1), via.hostname, "The managed proxy display identifies the session hostname");
    const selectedRouteLabel = `${created.label} — ${created.host}:${created.port}`;
    assert.equal(await route.innerText(), selectedRouteLabel);
    await route.click();
    assert.deepEqual(await routeMenuValues(rdp), initialRouteChoices, "Creating a Via proxy must not add an extra route option");
    assert.equal(await routeMenuItem(rdp, createdId).count(), 0);
    assert.equal(await viaItem.getAttribute("aria-checked"), "true", "The original Via choice stays checked");
    await viaItem.click();
    await viaItem.waitFor({ state: "hidden" });
    await waitUntil(async () => await routeValue(route) === createdId, "Reselecting the session did not reuse its proxy");
    starts = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.socks5Starts);
    assert.equal(starts.length, 1, "Selecting the same live session deduplicates its managed proxy");
    assert.equal(await route.innerText(), selectedRouteLabel);
    await route.click();
    assert.deepEqual(await routeMenuValues(rdp), initialRouteChoices, "Reselecting Via keeps the route menu stable");
    assert.equal(await viaItem.getAttribute("aria-checked"), "true");
    await rdp.keyboard.press("Escape");
    await routeMenu.waitFor({ state: "hidden" });
    await editor.getByRole("button", { name: "Save profile", exact: true }).click();
    await waitForProfileRoute(rdp, imported.id, createdId);
    assert.deepEqual((await readState(rdp)).profiles.find((profile) => profile.id === imported.id)!.networking, { kind: "socks5", proxyId: createdId });
    await rdp.screenshot({ path: join(artifacts, "rdp-session-route.png"), animations: "disabled" });
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor.waitFor({ state: "hidden" });
    await rdp.reload();
    await rdp.getByRole("button", { name: "Connect to Imported account prompt", exact: true }).click();
    await editor.waitFor();
    assert.equal((await readState(rdp)).socks5Proxies?.find((proxy) => proxy.id === createdId)?.viaSessionId, via.id);
    assert.equal(await routeValue(route), createdId);
    assert.equal(await route.innerText(), selectedRouteLabel, "The selected route display survives reloading and reopening the dialog");
    await route.click();
    assert.deepEqual(await routeMenuValues(rdp), initialRouteChoices, "Updated inventory must not expose the auto-created proxy as a second option");
    assert.equal(await viaItem.getAttribute("aria-checked"), "true");
    assert.equal(await viaItem.getByText("Via m1-session · m1-session-host", { exact: true }).isVisible(), true);
    assert.equal(await viaItem.getByText("Session ID: m1_session", { exact: true }).isVisible(), true);
    await waitForVisibleRouteMenu(routeMenu);
    await rdp.screenshot({ path: join(artifacts, "rdp-session-route-reopened-menu.png"), animations: "disabled" });
    await rdp.keyboard.press("Escape");
    await routeMenu.waitFor({ state: "hidden" });

    const networkOpened = application.waitForEvent("window"); void networkOpened.catch(() => undefined);
    await editor.getByRole("button", { name: "Open Network manager", exact: true }).click();
    const network = await networkOpened;
    await network.getByRole("tab", { name: /^SOCKS5\b/u }).waitFor();
    const inventory = await network.evaluate(async () => (globalThis as unknown as { network: NetworkForwardingAPI }).network.list({}));
    assert.equal(inventory.ok, true);
    if (inventory.ok) {
      const proxy = inventory.value.socks5Proxies.find((proxy) => proxy.id === createdId);
      assert.equal(proxy?.sessionId, "m1_session"); assert.equal(proxy?.state.status, "listening");
      assert.equal(proxy?.authentication, "username-password");
    }
    const networkClosed = network.waitForEvent("close"); void networkClosed.catch(() => undefined);
    await (await application.browserWindow(network)).evaluate((window) => window.close());
    await networkClosed;
    await focusPage(application, workspace);
    assert.equal(await workspace.evaluate(async () => (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.disconnect()).ok), true);
    await waitUntil(async () => (await readState(rdp!)).socks5Sessions?.length === 0, "Disconnected session choices were not removed");
    assert.equal((await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.socks5Starts))[0]!.closed, true);
    await focusPage(application, rdp);
    await waitUntil(async () => await route.innerText() === `${selectedRouteLabel} (unavailable)`,
      "The disconnected route did not retain its endpoint and unavailable state");
    assert.equal(await routeValue(route), createdId, "Disconnecting the session must not silently select Direct");
    await route.click();
    assert.deepEqual(await routeMenuValues(rdp), initialRouteChoices, "The unavailable Via fallback must not introduce a duplicate proxy choice");
    assert.equal(await viaItem.isDisabled(), true);
    assert.equal(await viaItem.getAttribute("aria-checked"), "true");
    assert.match(await viaItem.innerText(), /m1-session-host.*\(unavailable\)/u);
    assert.equal(await routeMenuItem(rdp, createdId).count(), 0);
    await waitForVisibleRouteMenu(routeMenu);
    await rdp.screenshot({ path: join(artifacts, "rdp-session-route-unavailable-menu.png"), animations: "disabled" });
    await rdp.keyboard.press("Escape");
    await routeMenu.waitFor({ state: "hidden" });
    // A stale capability still fails at the real main boundary even if a caller
    // retained it before the authoritative disconnect removed the live choice.
    const staleStart = await rdp.evaluate(async (id) => (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.startSessionProxy(id), via.id);
    assert.equal(staleStart.ok, false);
    if (!staleStart.ok) assert.equal(staleStart.error, "The selected Sliver session is no longer available. Select it again.");
    assert.equal(await routeValue(route), createdId);
    assert.equal(await route.innerText(), `${selectedRouteLabel} (unavailable)`);
    assert.equal((await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.socks5Starts)).length, 1);
    assert.deepEqual((await readState(rdp)).tabs, []);
    assert.equal(managedProxyId((await readState(rdp)).profiles.find((profile) => profile.id === imported.id)?.networking), createdId);
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    const persisted = await readFile(join(temporary, "client/gui/rdp.json"), "utf8");
    assert.equal(persisted.includes(sourcePassword), false);
    assert.equal(persisted.includes(temporary), false, "Imported profiles do not retain local source paths");
    assert.deepEqual((await readState(rdp)).tabs, []);
    assert.deepEqual(errors, []);
  } catch (error) {
    await rdp?.screenshot({ path: join(artifacts, "rdp-profiles-failure.png") }).catch(() => undefined);
    if (rdp) process.stderr.write(`RDP profile E2E: ${(await rdp.locator("body").innerText().catch(() => "unavailable")).slice(0, 6000)}\n`);
    throw error;
  } finally {
    await application?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("RDP manual SOCKS profiles preserve the form and use the main-owned transport", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporary = await mkdtemp(join(tmpdir(), "sliver-rdp-manual-socks-e2e-"));
  const artifacts = join(repositoryRoot, "artifacts/e2e");
  const username = "manual-proxy-user", proxyPassword = "FAKE_MANUAL_PROXY_PASSWORD_DO_NOT_PERSIST";
  const windowsPassword = "FAKE_WINDOWS_PASSWORD_DO_NOT_PERSIST";
  const destination = "rdp-only-through-proxy.invalid", label = "Manual SOCKS desktop";
  const peer = await startSocksPeer(username, proxyPassword);
  let application: ElectronApplication | undefined, rdp: Page | undefined;
  const errors: string[] = [];
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporary, name))));
    await mkdir(artifacts, { recursive: true });
    await writeFile(join(temporary, "client/armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporary, "saved/manual-socks-operator.cfg"), JSON.stringify({
      operator: "manual-socks-e2e-operator", lhost: "127.0.0.1", lport: 31337,
      ca_certificate: "FAKE_MANUAL_SOCKS_CA_DO_NOT_RENDER", certificate: "FAKE_MANUAL_SOCKS_CERT_DO_NOT_RENDER",
      private_key: "FAKE_MANUAL_SOCKS_KEY_DO_NOT_RENDER", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"), `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporary, "saved")}`, `--managed-config-directory=${join(temporary, "managed")}`,
        `--user-data-directory=${join(temporary, "user-data")}`, `--console-client-root-directory=${join(temporary, "client")}`,
        "--rdp-manual-socks-fixture"],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => { void peer.close(); ownedProcess.kill("SIGKILL"); }, { once: true });
    const workspace = await application.firstWindow();
    await focusPage(application, workspace);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Cancel", exact: true }).click();
    const opened = application.waitForEvent("window"); void opened.catch(() => undefined);
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById("network.rdp");
      if (!item?.click) throw new Error("RDP menu is unavailable");
      item.click();
    });
    rdp = await opened;
    rdp.setDefaultTimeout(15_000);
    rdp.on("pageerror", (error) => errors.push(error.message));
    rdp.on("console", (message) => { if (/Content Security Policy/iu.test(message.text())) errors.push(message.text()); });
    await rdp.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    await focusPage(application, rdp);
    await rdp.getByRole("button", { name: "New connection", exact: true }).first().click();
    const newEditor = rdp.getByRole("dialog", { name: "New Remote Desktop", exact: true });
    await newEditor.getByLabel("Connection name", { exact: true }).fill(label);
    await newEditor.getByLabel("Computer", { exact: true }).fill(destination);
    await newEditor.getByLabel("Username", { exact: true }).fill("operator");
    await newEditor.getByRole("button", { name: "Networking", exact: true }).click();
    await selectRoute(rdp, newEditor.getByRole("button", { name: "Connection route", exact: true }), "manual");
    await newEditor.getByLabel("Proxy address", { exact: true }).fill("127.0.0.1");
    await newEditor.getByLabel("Proxy port", { exact: true }).fill(String(peer.port));
    await newEditor.getByLabel("Proxy username", { exact: true }).fill(username);
    await newEditor.getByRole("button", { name: "Open Network manager", exact: true }).click();
    await newEditor.getByText("Connect to a Sliver server before opening Network", { exact: true }).waitFor();
    assert.equal(await newEditor.isVisible(), true, "The disconnected error preserves the connection form");
    assert.equal(application.windows().filter((page) => page.url().includes("surface=network")).length, 0);
    await focusPage(application, workspace);
    const connectedWorkspace = await workspace.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const profiles = await api.listSavedConfigs();
      if (!profiles.ok || profiles.value.length !== 1 || profiles.value[0]!.availability !== "available") {
        throw new Error("The manual SOCKS test requires exactly one fake operator profile");
      }
      const result = await api.connectSavedConfig(profiles.value[0]!.id);
      return { ok: result.ok, error: result.ok ? "" : result.error };
    });
    const connectionError = connectedWorkspace.error.replaceAll(temporary, "[test directory]")
      .replace(/FAKE_[A-Z0-9_]+/gu, "[fixture credential]").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 512);
    assert.equal(connectedWorkspace.ok, true, `The production workspace bridge must connect the fake backend: ${connectionError}`);
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await focusPage(application, rdp);
    const networkOpened = application.waitForEvent("window"); void networkOpened.catch(() => undefined);
    await newEditor.getByRole("button", { name: "Open Network manager", exact: true }).click();
    const network = await networkOpened;
    network.setDefaultTimeout(15_000);
    await network.getByRole("tab", { name: /^SOCKS5\b/u }).waitFor();
    assert.equal(network.url(), "sliver://app/index.html?surface=network");
    assert.equal(await network.getByRole("tab", { name: /^SOCKS5\b/u }).getAttribute("aria-selected"), "true");
    const networkContext = await network.evaluate(async () => (globalThis as unknown as { network: NetworkForwardingAPI }).network.getContext());
    assert.equal(networkContext.ok, true);
    if (networkContext.ok) assert.equal(networkContext.value.connection.status, "connected", "The Network manager inherits the connected workspace backend");
    assert.equal(await newEditor.isVisible(), true, "Opening the Network manager preserves the connection form");
    await focusPage(application, rdp);
    assert.equal(await newEditor.getByLabel("Connection name", { exact: true }).inputValue(), label);
    assert.equal(await routeValue(newEditor.getByRole("button", { name: "Connection route", exact: true })), "manual");
    assert.equal(await newEditor.getByLabel("Proxy port", { exact: true }).inputValue(), String(peer.port));
    assert.equal(await newEditor.getByLabel("Proxy username", { exact: true }).inputValue(), username);
    await newEditor.getByLabel("Proxy password", { exact: true }).fill(proxyPassword);
    await newEditor.getByRole("button", { name: "Save profile", exact: true }).click();
    const saved = (await waitForProfiles(rdp, 1)).profiles[0]!;
    const expectedRoute = { kind: "socks5-manual", host: "127.0.0.1", port: peer.port, username };
    assert.deepEqual(saved.networking, expectedRoute);
    assert.equal(saved.hasCredential, false);
    let persisted = await readFile(join(temporary, "client/gui/rdp.json"), "utf8");
    assert.equal(persisted.includes(proxyPassword), false, "Saving a profile must never save the proxy password");
    assert.deepEqual((await readState(rdp)).tabs, []);
    await newEditor.getByRole("button", { name: "Cancel", exact: true }).click();
    await rdp.reload();
    await rdp.getByRole("button", { name: `Connect to ${label}`, exact: true }).click();
    const editor = rdp.getByRole("dialog", { name: "Edit Remote Desktop", exact: true });
    await editor.waitFor();
    assert.equal(await routeValue(editor.getByRole("button", { name: "Connection route", exact: true })), "manual");
    assert.equal(await editor.getByLabel("Proxy address", { exact: true }).inputValue(), "127.0.0.1");
    assert.equal(await editor.getByLabel("Proxy port", { exact: true }).inputValue(), String(peer.port));
    assert.equal(await editor.getByLabel("Proxy username", { exact: true }).inputValue(), username);
    assert.equal(await editor.getByLabel("Proxy password", { exact: true }).inputValue(), "", "Reload asks for a fresh proxy password");
    await editor.getByLabel("Password", { exact: true }).fill(windowsPassword);
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    assert.equal(peer.requests.length, 0, "A missing proxy password cannot begin a connection");
    assert.deepEqual((await readState(rdp)).tabs, []);
    await editor.getByLabel("Proxy password", { exact: true }).fill(proxyPassword);
    await editor.evaluate((element) => { for (const animation of element.getAnimations({ subtree: true })) { try { animation.finish(); } catch { /* Decorative animation. */ } } });
    await editor.locator('[data-scroll-shadow-mode="auto"]').evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "instant" }));
    await rdp.screenshot({ path: join(artifacts, "rdp-manual-socks-profile.png"), animations: "disabled" });
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await waitUntil(async () => (await readState(rdp!)).tabs[0]?.state === "active", "Manual SOCKS connection did not become active");
    assert.deepEqual(peer.requests, [{ host: destination, port: 3389, authenticated: true }]);
    assert.equal(peer.failed, false);
    const audit = await readManualAudit(application);
    assert.equal(audit.echoes, 1, "The fake native helper must exchange data through the production relay");
    assert.equal(audit.connections.length, 1);
    const connected = audit.connections[0]!;
    assert.equal(connected.host, destination); assert.equal(connected.port, 3389);
    assert.equal(connected.connectAddress?.host, "127.0.0.1");
    assert.ok((connected.connectAddress?.port ?? 0) > 0);
    assert.notEqual(connected.connectAddress?.port, peer.port, "Native connects to the main-owned relay, not the SOCKS protocol listener");
    assert.equal(connected.proxyPasswordForwarded, false); assert.equal(connected.networkingForwarded, false);
    assert.equal(connected.passwordSupplied, true);
    const tab = (await readState(rdp)).tabs[0]!;
    assert.deepEqual(tab.networking, expectedRoute);
    assert.equal(JSON.stringify(await readState(rdp)).includes(proxyPassword), false);
    await peer.close();
    await waitUntil(async () => (await readState(rdp!)).tabs[0]?.state === "failed", "Closing the manual SOCKS peer must terminate RDP");
    const rejected = await rdp.evaluate(async ({ tabId, password, proxyPassword }) =>
      (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.reconnect({ tabId, password, proxyPassword }),
    { tabId: tab.id, password: windowsPassword, proxyPassword });
    assert.equal(rejected.ok, false, "An unavailable manual proxy must fail without a direct connection");
    assert.equal((await readManualAudit(application)).connections.length, 1, "Proxy failure must not launch another native connection");
    persisted = await readFile(join(temporary, "client/gui/rdp.json"), "utf8");
    assert.equal(persisted.includes(proxyPassword), false); assert.equal(persisted.includes(windowsPassword), false);
    assert.deepEqual(errors, []);
  } catch (error) {
    await rdp?.screenshot({ path: join(artifacts, "rdp-manual-socks-failure.png") }).catch(() => undefined);
    throw error;
  } finally {
    await peer.close();
    await application?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

async function focusPage(application: ElectronApplication, page: Page): Promise<void> {
  await application.evaluate(({ app }) => app.focus({ steal: true }));
  await (await application.browserWindow(page)).evaluate((window) => { window.show(); window.focus(); });
  await page.bringToFront();
}

async function readManualAudit(application: ElectronApplication) {
  return application.evaluate(() => ({ connections: globalThis.__SLIVER_GUI_E2E_STATE__.rdpConnections,
    echoes: globalThis.__SLIVER_GUI_E2E_STATE__.rdpRelayEchoes }));
}

async function waitUntil(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(25); }
  throw new Error(message);
}

async function startSocksPeer(username: string, password: string) {
  const sockets = new Set<Socket>();
  const requests: { host: string; port: number; authenticated: boolean }[] = [];
  let failed = false, closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => undefined);
    void (async () => {
      const greeting = await readSocket(socket, 2), methods = await readSocket(socket, greeting[1]!);
      if (greeting[0] !== 5 || !methods.equals(Buffer.from([2]))) throw new Error("Unexpected SOCKS method");
      socket.write(Buffer.from([5, 2]));
      const auth = await readSocket(socket, 2), name = await readSocket(socket, auth[1]!);
      const length = (await readSocket(socket, 1))[0]!, secret = await readSocket(socket, length);
      const authenticated = auth[0] === 1 && name.equals(Buffer.from(username)) && secret.equals(Buffer.from(password));
      name.fill(0); secret.fill(0);
      socket.write(Buffer.from([1, authenticated ? 0 : 1]));
      if (!authenticated) throw new Error("Unexpected SOCKS credentials");
      const request = await readSocket(socket, 4);
      if (!request.equals(Buffer.from([5, 1, 0, 3]))) throw new Error("The logical destination must be sent as proxy DNS");
      const hostLength = (await readSocket(socket, 1))[0]!, host = (await readSocket(socket, hostLength)).toString("utf8");
      const port = (await readSocket(socket, 2)).readUInt16BE();
      requests.push({ host, port, authenticated });
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      socket.pipe(socket);
    })().catch(() => { if (!closing) failed = true; socket.destroy(); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Manual SOCKS fixture did not listen");
  return { port: address.port, requests, get failed() { return failed; }, close(): Promise<void> {
    return closing ??= new Promise<void>((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); });
  } };
}

async function readSocket(socket: Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stop = (): void => { cleanup(); reject(new Error("Manual SOCKS fixture socket closed")); };
    const read = (): void => {
      const value = socket.read(length) as Buffer | null;
      if (value !== null) { cleanup(); resolve(Buffer.from(value)); }
      else if (socket.destroyed || socket.readableEnded) stop();
    };
    const cleanup = (): void => { socket.off("readable", read); socket.off("close", stop); socket.off("end", stop); };
    socket.on("readable", read); socket.once("close", stop); socket.once("end", stop); read();
  });
}

function routeMenuItem(page: Page, value: string): Locator {
  return page.locator(`[role="menuitemradio"][data-route-value=${JSON.stringify(value)}]`);
}

async function routeMenuValues(page: Page): Promise<(string | null)[]> {
  return page.getByRole("menu", { name: "Connection route", exact: true }).getByRole("menuitemradio")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-route-value")));
}

async function waitForVisibleRouteMenu(menu: Locator): Promise<void> {
  await waitUntil(async () => menu.evaluate((element) => {
    const view = element.ownerDocument.defaultView!;
    return [element, ...element.querySelectorAll('[role="menuitemradio"]')].every((item) => {
      const bounds = item.getBoundingClientRect();
      const hit = element.ownerDocument.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return bounds.top >= 0 && bounds.bottom <= view.innerHeight && bounds.left >= 0 && bounds.right <= view.innerWidth &&
        hit !== null && (item.contains(hit) || item.getAttribute("aria-disabled") === "true" && element.contains(hit));
    });
  }), "The full route menu must be visible and unobscured before its screenshot");
}

async function routeValue(trigger: Locator): Promise<string> {
  const value = await trigger.getAttribute("data-route-value");
  assert.notEqual(value, null, "The Connection route button must expose the selected route");
  return value!;
}

async function selectRoute(page: Page, trigger: Locator, value: string): Promise<void> {
  await trigger.click();
  const item = routeMenuItem(page, value);
  await item.click();
  await item.waitFor({ state: "hidden" });
}

async function readState(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const result = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}

async function waitForProfiles(page: Page, count: number): Promise<RdpWindowState> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const state = await readState(page);
    if (state.profiles.length === count) return state;
    if (Date.now() > deadline) throw new Error(`Expected ${count} imported RDP profiles`);
    await delay(25);
  }
}

async function waitForProfileRoute(page: Page, id: string, proxyId: string | undefined): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (managedProxyId((await readState(page)).profiles.find((profile) => profile.id === id)?.networking) === proxyId) return;
    if (Date.now() > deadline) throw new Error("The selected RDP route was not saved");
    await delay(25);
  }
}

function managedProxyId(route: RdpConnectionOptions["networking"]): string | undefined {
  return route?.kind === "socks5" ? route.proxyId : undefined;
}

async function publishProxyInventory(application: ElectronApplication, state: RdpWindowState, proxies: readonly RdpSocks5Proxy[]): Promise<void> {
  // Only discovery is mocked. Profile imports, native-file conversion, parsing,
  // IPC validation, and profile persistence use their production implementations.
  await application.evaluate(({ BrowserWindow }, next) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().includes("surface=rdp"));
    if (!window) throw new Error("The RDP window is unavailable");
    window.webContents.send("sliver:rdp:state:changed", next);
  }, { ...state, socks5Proxies: proxies });
}

async function dropNativeFiles(page: Page, paths: string[], screenshotPath?: string): Promise<void> {
  const target: Locator = page.locator(".drop-zone__area");
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  assert.ok(bounds, "Saved connections expose a visible native drop target");
  const viewport = await page.evaluate(() => {
    const view = globalThis as unknown as { innerWidth: number; innerHeight: number };
    return { width: view.innerWidth, height: view.innerHeight };
  });
  const left = Math.max(0, bounds.x), top = Math.max(0, bounds.y);
  const right = Math.min(viewport.width, bounds.x + bounds.width), bottom = Math.min(viewport.height, bounds.y + bounds.height);
  assert.ok(right > left && bottom > top);
  const point = { x: (left + right) / 2, y: top + Math.min(80, (bottom - top) / 2) };
  const data = { items: [], files: paths, dragOperationsMask: 1 };
  const session = await page.context().newCDPSession(page);
  let dropped = false;
  try {
    await page.mouse.move(point.x, point.y);
    await session.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
    await session.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
    await page.getByText("Drop .rdp files to import profiles", { exact: true }).waitFor();
    if (screenshotPath) await page.screenshot({ path: screenshotPath, animations: "disabled" });
    await session.send("Input.dispatchDragEvent", { type: "drop", ...point, data });
    dropped = true;
  } finally {
    if (!dropped) await session.send("Input.dispatchDragEvent", { type: "dragCancel", ...point, data }).catch(() => undefined);
    await session.detach();
  }
}
