import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import { readBoundedRegularFile } from "../main/secure-file.js";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { NetworkForwardingAPI, NetworkSocks5ProxySummary } from "../shared/network-forwarding-contracts.js";
import { rdpNetworkingKey, type RdpNetworking, type RdpConnectInput, type RdpWindowAPI, type RdpWindowState } from "../shared/rdp-contracts.js";
import { parseRdpConnect, rdpRecord, rdpString } from "../shared/rdp-validation.js";

const configFile = process.env["SLIVER_RDP_SOCKS_E2E_CONFIG_FILE"];
interface Fixture {
  connection: RdpConnectInput & { password: string };
  fingerprint: string;
  operatorConfigPath: string;
  sessionId: string;
  sessionHostname: string;
  rdpHostname?: string;
  proxyAuthentication: boolean;
  routeMode: "managed" | "manual" | "session";
}

/** Explicit opt-in for an operator-selected disposable lab only. No server policy is changed.
 * Private JSON: RdpConnectInput fields (NLA, clipboard=true, persistence=none), fingerprint,
 * operatorConfigPath, exact sessionId/sessionHostname, optional rdpHostname and
 * proxyAuthentication (default true). Run one fixture at a time: this uses the OS clipboard.
 * Launches the production entry point and real native helper, with no fake runtime or backend.
 */
test("production RDP traverses an app-managed SOCKS5 proxy and fails closed when it stops", {
  skip: configFile ? false : "Set SLIVER_RDP_SOCKS_E2E_CONFIG_FILE to an explicitly authorized private lab fixture",
  timeout: 300_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const fixture = await readFixture(configFile!);
  const { connection, fingerprint } = fixture;
  const prefix = process.env["SLIVER_RDP_SOCKS_E2E_ARTIFACT_PREFIX"] ?? "rdp-socks-live";
  if (!/^[a-z0-9][a-z0-9_-]{0,80}$/iu.test(prefix)) throw new Error("Invalid RDP SOCKS artifact prefix");
  await access(join(repositoryRoot, "dist/main/index.js"));
  const root = await mkdtemp(join(tmpdir(), "sliver-rdp-socks-live-"));
  const home = join(root, "home"), clientRoot = join(root, "client"), userData = join(root, "user-data");
  const artifacts = join(repositoryRoot, "artifacts/e2e"), resultPath = join(artifacts, `${prefix}-result.json`);
  const keyboardMarker = `RDP SOCKS keyboard ${randomBytes(6).toString("hex")}`;
  const unicodeMarker = `RDP SOCKS clipboard ${randomBytes(6).toString("hex")} — café Ω 日本語`;
  const unicodeSuffix = ` keyboard-${randomBytes(6).toString("hex")}`;
  const proxyCredentials = fixture.proxyAuthentication ? {
    username: `rdp-e2e-${randomBytes(6).toString("hex")}`, password: randomBytes(24).toString("base64url"),
  } : undefined;
  let application: ElectronApplication | undefined, workspace: Page | undefined, rdp: Page | undefined, network: Page | undefined;
  let proxyId: string | undefined, profileId: string | undefined;
  let clipboardSaved = false, remoteDocumentVerified = false;
  let restoringClipboard: Promise<void> | undefined;
  let primaryFailure: unknown, result: Record<string, unknown> | undefined;
  let rendererErrorCount = 0, stage = "prepare";
  const advance = (next: string): void => { stage = next; process.stdout.write(`RDP SOCKS live stage: ${next}\n`); };
  const diagnosticError = (error: unknown): string => {
    let text = error instanceof Error ? error.stack ?? error.message : "Unknown test failure";
    for (const value of [connection.password, proxyCredentials?.password, proxyCredentials?.username,
      fixture.operatorConfigPath, configFile, root]) {
      if (value) for (const variant of [value, JSON.stringify(value).slice(1, -1)]) text = text.replaceAll(variant, "[redacted]");
    }
    return text.slice(0, 8_000);
  };
  const cleanupFailures: Error[] = [];
  const restoreClipboard = (): Promise<void> => {
    if (!application || !clipboardSaved) return Promise.resolve();
    return restoringClipboard ??= application.evaluate(async ({ clipboard }) => {
      const owned = globalThis as unknown as { __rdpSocksClipboard?: Electron.ClipboardItem[] };
      if (owned.__rdpSocksClipboard?.length) await clipboard.write(owned.__rdpSocksClipboard);
      else await clipboard.clear();
      delete owned.__rdpSocksClipboard;
    }).then(() => { clipboardSaved = false; }).catch((error: unknown) => { restoringClipboard = undefined; throw error; });
  };
  const disconnectTabs = async (): Promise<void> => {
    if (!rdp || rdp.isClosed()) return;
    await rdp.evaluate(async () => {
      const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
      const state = await api.getState();
      if (!state.ok) throw new Error("RDP cleanup state unavailable");
      for (const tab of state.value.tabs) {
        if (!(await api.closeTab(tab.id)).ok) throw new Error("RDP cleanup could not close a test tab");
      }
    });
  };
  const stopProxy = async (): Promise<void> => {
    if (!proxyId) return;
    if (!network || network.isClosed()) throw new Error("Test proxy cleanup window unavailable");
    const stopped = await network.evaluate(async (id) => {
      const api = (globalThis as unknown as { network: NetworkForwardingAPI }).network;
      const listed = await api.list({});
      if (!listed.ok) return false;
      if (!listed.value.socks5Proxies.some((proxy) => proxy.id === id)) return true;
      if (!(await api.stopSocks5Proxy(id)).ok) return false;
      const remaining = await api.list({});
      return remaining.ok && !remaining.value.socks5Proxies.some((proxy) => proxy.id === id);
    }, proxyId);
    if (!stopped) throw new Error("Test-owned SOCKS proxy did not close");
    proxyId = undefined;
  };
  try {
    await Promise.all([mkdir(home, { recursive: true, mode: 0o700 }), mkdir(join(clientRoot, "configs"), { recursive: true, mode: 0o700 }),
      mkdir(userData, { recursive: true, mode: 0o700 }), mkdir(artifacts, { recursive: true })]);
    await rm(resultPath, { force: true });
    const operator = (await readBoundedRegularFile(fixture.operatorConfigPath, {
      label: "RDP SOCKS operator profile", maxBytes: 4 * 1024 * 1024, requirePrivateMode: true,
    })).data;
    try { await writeFile(join(clientRoot, "configs/isolated-rdp-socks.cfg"), operator, { mode: 0o600 }); }
    finally { operator.fill(0); }
    await writeFile(join(clientRoot, "armories.json"), "[]", { mode: 0o600 });
    advance("launch-production");
    application = await electron.launch({
      args: ["--enable-sandbox", ...(process.platform === "darwin" ? ["--password-store=basic", "--use-mock-keychain"] : []),
        join(repositoryRoot, "dist/main/index.js"), `--user-data-dir=${userData}`],
      cwd: repositoryRoot, timeout: 30_000, bypassCSP: false, chromiumSandbox: true,
      env: isolatedEnvironment(home, clientRoot),
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => {
      const emergencyCleanup = async (): Promise<void> => {
        // Disable focus-driven synchronization, then restore clipboard first. A
        // failed cleanup action must not skip independent actions that follow it.
        await application!.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); }).catch(() => undefined);
        await restoreClipboard().catch(() => undefined);
        await disconnectTabs().catch(() => undefined);
        await stopProxy().catch(() => undefined);
      };
      void Promise.race([emergencyCleanup(), delay(2_000)])
        .finally(() => ownedProcess.kill("SIGKILL"));
    }, { once: true });
    await application.evaluate(async ({ clipboard, ClipboardItem }) => {
      const items = await clipboard.read();
      const snapshot = await Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(
        await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
      ))));
      (globalThis as unknown as { __rdpSocksClipboard: Electron.ClipboardItem[] }).__rdpSocksClipboard = snapshot;
    });
    clipboardSaved = true;
    workspace = await application.firstWindow();
    workspace.setDefaultTimeout(20_000);
    advance("operator-focus");
    await focusWindow(application, workspace);
    advance("operator-dialog");
    const saved = workspace.getByRole("dialog", { name: "Saved configurations" });
    await saved.waitFor();
    advance("operator-config-inventory");
    const configCount = await workspace.evaluate(async () => {
      const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.listSavedConfigs();
      return result.ok ? result.value?.filter((config) => config.availability === "available").length : -1;
    });
    assert.equal(configCount, 1, "Only the isolated operator profile may be connected");
    advance("operator-select-profile");
    const options = saved.getByRole("option");
    await options.first().waitFor();
    assert.equal(await options.count(), 1);
    if (await options.first().getAttribute("aria-selected") !== "true") await options.first().click();
    await until(async () => await options.first().getAttribute("aria-selected") === "true", "The isolated operator profile was not selected");
    advance("operator-connect");
    const operatorConnection = await workspace.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const listed = await api.listSavedConfigs();
      if (!listed.ok || listed.value.length !== 1 || listed.value[0]!.availability !== "available") {
        throw new Error("The isolated operator profile inventory changed");
      }
      const connected = await api.connectSavedConfig(listed.value[0]!.id);
      return { ok: connected.ok, error: connected.ok ? "" : connected.error };
    });
    if (!operatorConnection.ok) throw new Error(`Operator connection failed: ${operatorConnection.error}`);
    advance("operator-dialog-close");
    await saved.waitFor({ state: "hidden" });
    advance("operator-version-check");
    const mismatch = workspace.getByRole("dialog", { name: "Server version mismatch" });
    if (await mismatch.count()) await mismatch.getByRole("button", { name: "Continue" }).click();
    advance("operator-overview");
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    advance("open-network");
    network = await openSurface(application, workspace, "network.socks5", "surface=network");
    network.setDefaultTimeout(20_000);
    advance("exact-session-proxy");
    await until(async () => network!.evaluate(async ({ id, hostname }) => {
      const context = await (globalThis as unknown as { network: NetworkForwardingAPI }).network.getContext();
      return context.ok && context.value.sessions.items.some(({ session }) => session.id === id &&
        session.hostname.toLowerCase() === hostname.toLowerCase() && session.liveness === "active");
    }, { id: fixture.sessionId, hostname: fixture.sessionHostname }), "The exact authorized session did not become available", 30_000);
    let started: NetworkSocks5ProxySummary | undefined;
    if (fixture.routeMode !== "session") started = await network.evaluate(async ({ id, hostname, authentication }) => {
      const api = (globalThis as unknown as { network: NetworkForwardingAPI }).network;
      const context = await api.getContext();
      if (!context.ok) throw new Error("Session inventory unavailable");
      const entry = context.value.sessions.items.find(({ session }) => session.id === id &&
        session.hostname.toLowerCase() === hostname.toLowerCase() && session.liveness === "active");
      if (!entry || entry.ref.mode !== "session" || entry.ref.id !== id) throw new Error("Authorized session changed");
      const result = await api.startSocks5Proxy({ session: entry.ref, bind: { host: "127.0.0.1", port: 0 },
        ...(authentication ? { authentication } : {}), connectTimeoutSeconds: 30, closeTimeoutSeconds: 5,
        maxConnections: 4, maxBufferedBytesPerConnection: 1024 * 1024 });
      if (!result.ok) throw new Error("Could not start the test-owned managed SOCKS proxy");
      return result.value;
    }, { id: fixture.sessionId, hostname: fixture.sessionHostname, authentication: proxyCredentials });
    if (started) proxyId = started.id;
    rdp = await openSurface(application, workspace, "rdp.open", "surface=rdp");
    rdp.setDefaultTimeout(20_000);
    rdp.on("pageerror", () => rendererErrorCount++);
    rdp.on("console", (message) => { if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) rendererErrorCount++; });
    await rdp.getByRole("heading", { name: "Remote Desktop", exact: true }).waitFor();
    await assertRdpBoundary(application, rdp);
    if (started) await until(async () => (await rdpState(rdp!)).socks5Proxies?.some((proxy) => proxy.id === proxyId && proxy.available) === true,
      "The managed proxy did not appear in RDP");
    await focusWindow(application, rdp);
    await rdp.getByRole("button", { name: "New connection", exact: true }).first().click();
    const editor = rdp.getByRole("dialog", { name: "New Remote Desktop", exact: true });
    await editor.waitFor();
    await fillConnection(editor, connection);
    await editor.getByRole("button", { name: "Networking", exact: true }).click();
    const route = editor.getByRole("button", { name: "Connection route", exact: true });
    if (fixture.routeMode === "session") {
      advance("select-via-session");
      const sessionName = await network.evaluate(async (id) => {
        const context = await (globalThis as unknown as { network: NetworkForwardingAPI }).network.getContext();
        if (!context.ok) throw new Error("Session inventory unavailable");
        const entry = context.value.sessions.items.find(({ session }) => session.id === id);
        if (!entry) throw new Error("Authorized session changed");
        return ((entry.session.name !== entry.session.id ? entry.session.name : "") || entry.session.hostname || "Sliver session")
          .replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 256);
      }, fixture.sessionId);
      const candidates = (await rdpState(rdp)).socks5Sessions?.filter((session) => session.sessionId === fixture.sessionId) ?? [];
      assert.equal(candidates.length, 1, "The exact authorized session must have one RDP route choice");
      const session = candidates[0]!;
      assert.equal(session.label, sessionName);
      assert.equal(session.hostname.toLowerCase(), fixture.sessionHostname.toLowerCase());
      const value = `session:${session.id}`;
      await route.scrollIntoViewIfNeeded();
      await route.click();
      const via = routeMenuItem(rdp, value);
      await via.scrollIntoViewIfNeeded();
      const displayName = session.hostname && session.hostname.toLowerCase() !== session.label.toLowerCase()
        ? `${session.label} · ${session.hostname}` : session.label;
      assert.equal(await via.getByText(`Via ${displayName}`, { exact: true }).isVisible(), true);
      assert.equal(await via.getByText(`Session ID: ${fixture.sessionId}`, { exact: true }).isVisible(), true);
      await rdp.screenshot({ path: join(artifacts, `${prefix}-route-menu.png`), animations: "disabled" });
      await via.click();
      await via.waitFor({ state: "hidden" });
      await until(async () => /^socks5-/u.test(await routeValue(route)), "Via selection did not create and select a proxy");
      proxyId = await routeValue(route);
      started = await proxyState(network, proxyId);
      assert.equal((await rdpState(rdp)).socks5Proxies?.find((proxy) => proxy.id === proxyId)?.viaSessionId, session.id);
      await route.click();
      assert.equal(await routeMenuItem(rdp, proxyId).count(), 0, "The auto-created proxy must not add a second menu choice");
      assert.equal(await via.getAttribute("aria-checked"), "true");
      await rdp.keyboard.press("Escape");
      await via.waitFor({ state: "hidden" });
    }
    assert.ok(started && proxyId, "The selected route must have a managed listener");
    assert.equal(started.sessionId, fixture.sessionId);
    assert.equal(started.bind.host, "127.0.0.1");
    assert.ok(started.bind.port > 0 && started.bind.port <= 65535);
    assert.equal(started.state.status, "listening");
    assert.equal(started.authentication, fixture.routeMode === "session" || fixture.proxyAuthentication ? "username-password" : "none");
    const selectedRoute: RdpNetworking = fixture.routeMode === "manual"
      ? { kind: "socks5-manual", host: started.bind.host, port: started.bind.port,
        ...(proxyCredentials ? { username: proxyCredentials.username } : {}) }
      : { kind: "socks5", proxyId };
    if (fixture.routeMode !== "session") await selectRoute(rdp, route, fixture.routeMode === "manual" ? "manual" : proxyId);
    if (selectedRoute.kind === "socks5-manual") {
      await editor.getByLabel("Proxy address", { exact: true }).fill(selectedRoute.host);
      await editor.getByLabel("Proxy port", { exact: true }).fill(String(selectedRoute.port));
      if (proxyCredentials) await setPrivateInput(editor.getByLabel("Proxy username", { exact: true }), proxyCredentials.username);
    }
    assert.equal(await routeValue(route), fixture.routeMode === "manual" ? "manual" : proxyId);
    await editor.getByRole("button", { name: "Save profile", exact: true }).click();
    await until(async () => (await rdpState(rdp!)).profiles.length === 1, "The routed profile was not saved");
    profileId = (await rdpState(rdp)).profiles[0]!.id;
    assert.deepEqual((await rdpState(rdp)).profiles[0]!.networking, selectedRoute);
    await setPrivateInput(editor.getByLabel("Password", { exact: true }), connection.password);
    if (fixture.routeMode === "manual" && proxyCredentials) {
      await setPrivateInput(editor.getByLabel("Proxy password", { exact: true }), proxyCredentials.password);
    }
    advance("certificate-review");
    await editor.getByRole("button", { name: "Connect", exact: true }).click();
    await until(async () => Boolean((await rdpState(rdp!)).tabs[0]?.review), "RDP did not present the configured server certificate", 45_000);
    const review = (await rdpState(rdp)).tabs[0]!.review!;
    assert.equal(review.fingerprint, fingerprint, "The proxy must reach the exact authorized RDP certificate");
    assert.equal(review.host, connection.host, "Certificate review must retain the logical destination");
    assert.equal(review.port, connection.port);
    await rdp.getByRole("button", { name: "Trust and remember", exact: true }).click();
    advance("active-desktop");
    await until(async () => (await rdpState(rdp!)).tabs[0]?.state === "active", "RDP did not become active through SOCKS", 45_000);
    await until(async () => await frameCount(rdp!) > 0, "RDP did not render a desktop");
    // Protocol activation precedes Windows reconnecting the user's desktop and rdpclip.
    await until(async () => (await rdpState(rdp!)).tabs[0]?.clipboardReady === true, "RDP clipboard did not initialize", 60_000);
    let tab = (await rdpState(rdp)).tabs[0]!;
    assert.equal(tab.host, connection.host); assert.deepEqual(tab.networking, selectedRoute);
    const persisted = JSON.parse(await readFile(join(clientRoot, "gui/rdp.json"), "utf8")) as {
      pins: { endpoint: string; fingerprint: string }[];
    };
    assert.ok(persisted.pins.some((pin) => pin.endpoint === `${connection.host}:${connection.port}|${rdpNetworkingKey(selectedRoute)}` && pin.fingerprint === fingerprint),
      "The certificate pin must belong to the original destination and selected route");
    await until(async () => {
      const traffic = await proxyState(network!, proxyId!);
      return traffic.state.bytesToTarget > 0 && traffic.state.bytesFromTarget > 4096;
    }, "The managed proxy did not carry more than 4 KiB of desktop traffic");
    const trafficBeforeInput = (await proxyState(network, proxyId!)).state;

    advance("keyboard");
    await captureInput(application, rdp, connection.label);
    // A newly logged-in Windows desktop can still be initializing its shell.
    await delay(2_000);
    const beforeRun = await frameCount(rdp);
    await rdp.keyboard.press("Meta+r");
    await until(async () => await frameCount(rdp!) > beforeRun, "Windows Run did not repaint");
    await delay(2_000);
    await rdp.keyboard.press("Control+a");
    await rdp.keyboard.insertText("notepad.exe");
    await delay(500);
    await rdp.keyboard.press("Enter");
    const beforeNotepad = await frameCount(rdp);
    await until(async () => await frameCount(rdp!) > beforeNotepad, "Notepad did not repaint");
    await delay(2_000);
    await rdp.keyboard.insertText(keyboardMarker);
    await rdp.keyboard.press("Control+a"); await rdp.keyboard.press("Control+c");
    await until(async () => (await rdpState(rdp!)).tabs[0]?.clipboardAvailable === true, "Remote typed text was not offered to the clipboard");
    await rdp.getByRole("button", { name: "Receive clipboard", exact: true }).click();
    await until(async () => application!.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, keyboardMarker),
      "The exact keyboard marker did not return from Notepad");
    remoteDocumentVerified = true;
    advance("unicode-clipboard");
    await application.evaluate(async ({ clipboard }, text) => { await clipboard.writeText(text); }, unicodeMarker);
    await rdp.getByRole("button", { name: "Send clipboard", exact: true }).click();
    await captureInput(application, rdp, connection.label);
    await rdp.keyboard.press("Control+v"); await delay(500);
    await rdp.keyboard.press("Control+End");
    await rdp.keyboard.type(unicodeSuffix, { delay: 30 });
    await rdp.keyboard.press("Control+a"); await rdp.keyboard.press("Control+c");
    await until(async () => (await rdpState(rdp!)).tabs[0]?.clipboardAvailable === true, "Unicode text was not offered from Windows");
    // Release capture before replacing local clipboard so automatic send cannot echo the sentinel.
    await rdp.getByRole("button", { name: "Receive clipboard", exact: true }).focus();
    await application.evaluate(async ({ clipboard }) => { await clipboard.writeText("RDP SOCKS local sentinel"); });
    await rdp.getByRole("button", { name: "Receive clipboard", exact: true }).click();
    await until(async () => application!.evaluate(async ({ clipboard }, expected) => await clipboard.readText() === expected, unicodeMarker + unicodeSuffix),
      "Unicode clipboard text did not round-trip through SOCKS");
    await until(async () => {
      const after = (await proxyState(network!, proxyId!)).state;
      return after.bytesToTarget > trafficBeforeInput.bytesToTarget && after.bytesFromTarget > trafficBeforeInput.bytesFromTarget;
    }, "Keyboard and Unicode clipboard interaction did not add traffic in both proxy directions");
    const trafficAfterInput = (await proxyState(network, proxyId!)).state;
    await rdp.screenshot({ path: join(artifacts, `${prefix}-desktop.png`), animations: "disabled" });
    await closeRemoteDocument(application, rdp, connection.label);
    remoteDocumentVerified = false;

    advance("renderer-reattach");
    const tabId = tab.id, attempt = tab.attempt;
    await rdp.reload();
    await until(async () => await frameCount(rdp!) > 0, "Reloaded RDP did not reattach");
    tab = (await rdpState(rdp)).tabs[0]!;
    assert.equal(tab.id, tabId); assert.equal(tab.attempt, attempt); assert.equal(tab.state, "active");
    assert.deepEqual(tab.networking, selectedRoute);
    const traffic = await proxyState(network, proxyId!);
    const usedProxyId = proxyId!;
    advance("proxy-stop");
    await stopProxy();
    await until(async () => (await rdpState(rdp!)).tabs[0]?.state === "failed", "Stopping the managed proxy did not fail the RDP session");
    await until(async () => !(await rdpState(rdp!)).socks5Proxies?.some((proxy) => proxy.id === usedProxyId && proxy.available),
      "The stopped proxy remained available to RDP");
    await delay(1_000);
    tab = (await rdpState(rdp)).tabs[0]!;
    assert.equal(tab.attempt, attempt, "Route loss must not reconnect directly");
    assert.equal(tab.state, "failed");
    assert.match(tab.error ?? "", /SOCKS|proxy|transport|connection/iu);
    advance("stale-route-rejection");
    await focusWindow(application, rdp);
    await rdp.getByRole("button", { name: "Saved profiles", exact: true }).click();
    await rdp.getByRole("button", { name: `Connect to ${connection.label}`, exact: true }).click();
    // No-auth manual routes can use the saved profile's ordinary Windows
    // password prompt; authenticated or unavailable managed routes use the editor.
    const passwordOnly = selectedRoute.kind === "socks5-manual" && selectedRoute.username === undefined;
    const stale = rdp.getByRole("dialog", { name: passwordOnly ? `Connect to ${connection.label}` : "Edit Remote Desktop", exact: true });
    await stale.waitFor();
    assert.deepEqual((await rdpState(rdp)).profiles.find((profile) => profile.id === profileId)?.networking, selectedRoute);
    if (!passwordOnly) assert.equal(await routeValue(stale.getByRole("button", { name: "Connection route", exact: true })), fixture.routeMode === "manual" ? "manual" : usedProxyId);
    await setPrivateInput(stale.getByLabel("Password", { exact: true }), connection.password);
    if (fixture.routeMode === "manual" && proxyCredentials) {
      await setPrivateInput(stale.getByLabel("Proxy password", { exact: true }), proxyCredentials.password);
    }
    await stale.getByRole("button", { name: "Connect", exact: true }).click();
    if (fixture.routeMode === "manual") await stale.getByRole("alert").filter({ hasText: /SOCKS/iu }).waitFor();
    else await stale.getByText("The selected SOCKS5 proxy is unavailable. Choose an available proxy or Direct.", { exact: true }).waitFor();
    await stale.getByRole("button", { name: "Cancel", exact: true }).click();
    const afterUiRejected = await rdpState(rdp);
    assert.equal(afterUiRejected.tabs.length, 1, "The rejected saved profile must not create a direct connection");
    assert.equal(afterUiRejected.tabs[0]!.id, tabId);
    assert.equal(afterUiRejected.tabs[0]!.attempt, attempt);
    assert.equal(afterUiRejected.tabs[0]!.state, "failed");
    assert.deepEqual(afterUiRejected.tabs[0]!.networking, selectedRoute);
    const rejected = await rdp.evaluate(async (input) => {
      const api = (globalThis as unknown as { rdp: RdpWindowAPI }).rdp;
      const result = await api.connect(input);
      return { rejected: !result.ok, error: result.ok ? "" : result.error };
    }, { ...connection, profileId, networking: selectedRoute,
      ...(fixture.routeMode === "manual" && proxyCredentials ? { proxyPassword: proxyCredentials.password } : {}) });
    assert.equal(rejected.rejected, true, "Main must reject a stale proxy even if the renderer guard is bypassed");
    assert.match(rejected.error, /SOCKS|proxy/iu);
    const afterRejected = await rdpState(rdp);
    assert.equal(afterRejected.tabs.length, 1); assert.equal(afterRejected.tabs[0]!.attempt, attempt);
    assert.equal(afterRejected.tabs[0]!.state, "failed");
    assert.equal(rendererErrorCount, 0, "RDP renderer emitted an error or CSP violation");
    const savedText = await readFile(join(clientRoot, "gui/rdp.json"), "utf8");
    assert.ok(!savedText.includes(connection.password) && (!proxyCredentials || !savedText.includes(proxyCredentials.password)) &&
      !savedText.includes(unicodeMarker), "Secrets must not appear in plaintext profile persistence");
    const build = JSON.parse(await readFile(join(repositoryRoot, "native/rdp/bin/provenance.json"), "utf8")) as {
      source: { commit: string }; buildIdentity: string; artifact: { sha256: string };
    };
    result = { originalHost: connection.host, originalPort: connection.port, ...(fixture.rdpHostname ? { rdpHostname: fixture.rdpHostname } : {}),
      pivotSessionId: fixture.sessionId, pivotHostname: fixture.sessionHostname, selectedProxyId: usedProxyId,
      routeMode: fixture.routeMode, proxyAuthentication: started.authentication, proxyBind: started.bind,
      bytesToTarget: traffic.state.bytesToTarget, bytesFromTarget: traffic.state.bytesFromTarget,
      inputBytesToTarget: trafficAfterInput.bytesToTarget - trafficBeforeInput.bytesToTarget,
      inputBytesFromTarget: trafficAfterInput.bytesFromTarget - trafficBeforeInput.bytesFromTarget,
      proxyTotalConnections: traffic.state.totalConnections, logicalCertificateHost: review.host, fingerprint,
      productionApplication: true, nativeRuntime: true, nlaLogin: true, desktopFrame: true, keyboard: true,
      unicodeClipboardRoundTrip: true, rendererReattach: true, routeStopFailedSession: true,
      staleProfileUiBlocked: true, staleRouteMainRejected: true, noDirectFallbackObserved: true,
      ironRdpRevision: build.source.commit, helperSha256: build.artifact.sha256, buildIdentity: build.buildIdentity,
      clientPlatform: process.platform, clientArchitecture: process.arch, clientKernel: release(),
      electronVersion: await application.evaluate(() => process.versions.electron) };
  } catch (error) {
    primaryFailure = error;
    const failedPage = rdp && !rdp.isClosed() ? rdp : workspace;
    await failedPage?.screenshot({ path: join(artifacts, `${prefix}-failure.png`), animations: "disabled" }).catch(() => undefined);
    const snapshot = rdp && !rdp.isClosed() ? await rdpState(rdp).catch(() => undefined) : undefined;
    context.diagnostic(JSON.stringify({ stage, error: diagnosticError(error), rendererErrorCount,
      tabs: snapshot?.tabs.map((tab) => ({ state: tab.state, attempt: tab.attempt,
        error: tab.error ? diagnosticError(new Error(tab.error)) : undefined, certificateReview: Boolean(tab.review) })) }));
  } finally {
    if (application) {
      if (remoteDocumentVerified && rdp && !rdp.isClosed()) {
        try { await closeRemoteDocument(application, rdp, connection.label); }
        catch { cleanupFailures.push(new Error("Could not close the verified test Notepad document")); }
      }
      try { await disconnectTabs(); } catch { cleanupFailures.push(new Error("Could not close all test RDP tabs")); }
      if (profileId && rdp && !rdp.isClosed()) {
        try {
          const deleted = await rdp.evaluate(async (id) => (await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.deleteProfile(id)).ok, profileId);
          if (!deleted) throw new Error("Profile cleanup rejected");
        } catch { cleanupFailures.push(new Error("Could not delete the test-owned RDP profile")); }
      }
      try { await stopProxy(); } catch { cleanupFailures.push(new Error("Could not stop the test-owned managed SOCKS proxy")); }
      try {
        await application.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.hide(); });
        await restoreClipboard();
      } catch { cleanupFailures.push(new Error("Could not restore the original local clipboard")); }
      try { await application.close(); }
      catch { application.process().kill("SIGKILL"); cleanupFailures.push(new Error("Could not close the production test application cleanly")); }
    }
    try { await rm(root, { recursive: true, force: true }); }
    catch { cleanupFailures.push(new Error("Could not remove the isolated test profile directory")); }
  }
  if (primaryFailure !== undefined || cleanupFailures.length) {
    // Never include raw bridge/process errors: they can contain private paths or server messages.
    for (const failure of cleanupFailures) context.diagnostic(failure.message);
    throw new Error(`Live RDP SOCKS test failed at ${stage}${cleanupFailures.length ? "; cleanup was incomplete" : ""}`);
  }
  assert.ok(result, "A successful live SOCKS test must produce evidence");
  await writeFile(resultPath, JSON.stringify({ ...result, proxyStopped: true, profileDeleted: true, clipboardRestored: true,
    applicationClosed: true, isolatedRootRemoved: true, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
});

async function readFixture(path: string): Promise<Fixture> {
  if (!isAbsolute(path)) throw new Error("RDP SOCKS fixture must be an absolute private file path");
  const bytes = (await readBoundedRegularFile(path, { label: "RDP SOCKS live fixture", maxBytes: 32_768, requirePrivateMode: true })).data;
  try {
    const raw = rdpRecord(JSON.parse(bytes.toString("utf8")));
    const connection = parseRdpConnect(raw);
    const fingerprint = rdpString(raw["fingerprint"], 64).toLowerCase();
    const operatorConfigPath = rdpString(raw["operatorConfigPath"], 4096);
    const sessionId = rdpString(raw["sessionId"], 80), sessionHostname = rdpString(raw["sessionHostname"], 253);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint) || !isAbsolute(operatorConfigPath) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(sessionId) ||
      connection.password === undefined || connection.signInMode === "remote-screen" || !connection.clipboard ||
      connection.persistence !== "none" || connection.networking || connection.profileId || connection.temporaryId ||
      (raw["routeMode"] !== undefined && raw["routeMode"] !== "managed" && raw["routeMode"] !== "manual" && raw["routeMode"] !== "session") ||
      (raw["proxyAuthentication"] !== undefined && typeof raw["proxyAuthentication"] !== "boolean")) throw new Error("Invalid fixture");
    return { connection: { ...connection, password: connection.password }, fingerprint, operatorConfigPath, sessionId, sessionHostname,
      ...(raw["rdpHostname"] === undefined ? {} : { rdpHostname: rdpString(raw["rdpHostname"], 253) }),
      proxyAuthentication: raw["proxyAuthentication"] !== false, routeMode: raw["routeMode"] === "session" ? "session" : raw["routeMode"] === "manual" ? "manual" : "managed" };
  } catch { throw new Error("Invalid private RDP SOCKS fixture; use NLA, clipboard=true, persistence=none, an exact certificate and session"); }
  finally { bytes.fill(0); }
}

function isolatedEnvironment(home: string, clientRoot: string): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => typeof value === "string" &&
    !name.startsWith("SLIVER_") && !name.startsWith("ELECTRON_") && !name.startsWith("NODE_") && !name.startsWith("PLAYWRIGHT_")));
  return { ...inherited, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"),
    SLIVER_CLIENT_ROOT_DIR: clientRoot, SLIVER_CLIENT_DIR: clientRoot };
}

async function focusWindow(application: ElectronApplication, page: Page): Promise<void> {
  await application.evaluate(({ app }) => app.focus({ steal: true }));
  const window = await application.browserWindow(page);
  await window.evaluate((window) => { window.show(); window.focus(); });
  await page.bringToFront();
  await until(async () => window.evaluate((window) => window.isFocused()), "The test window did not receive OS focus");
}

async function openSurface(application: ElectronApplication, owner: Page, menuId: string, query: string): Promise<Page> {
  await focusWindow(application, owner);
  const opened = application.waitForEvent("window");
  await application.evaluate(({ BrowserWindow, Menu }, { menuId, ownerUrl }) => {
    const menu = Menu.getApplicationMenu()?.getMenuItemById(menuId);
    const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === ownerUrl);
    if (!menu?.click || !window) throw new Error("Application menu is unavailable");
    menu.click(menu, window, {} as Electron.KeyboardEvent);
  }, { menuId, ownerUrl: owner.url() });
  const page = await opened;
  await until(async () => page.url().includes(query), "The requested application surface did not open");
  return page;
}

function routeMenuItem(page: Page, value: string): Locator {
  return page.locator(`[role="menuitemradio"][data-route-value=${JSON.stringify(value)}]`);
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

async function fillConnection(editor: Locator, connection: RdpConnectInput): Promise<void> {
  assert.equal(await editor.getByRole("switch", { name: "Sign in on the remote screen", exact: true }).isChecked(), false);
  for (const [label, value] of [["Connection name", connection.label], ["Computer", connection.host], ["Port", String(connection.port)],
    ["Username", connection.username], ["Domain", connection.domain]] as const) {
    await setPrivateInput(editor.getByLabel(label, { exact: true }), value);
  }
  await editor.getByRole("button", { name: "Desktop resolution", exact: true }).click();
  await editor.page().getByRole("menuitemradio", { name: "Custom", exact: true }).click();
  assert.equal(await editor.getByRole("button", { name: "Desktop resolution", exact: true }).getAttribute("data-selected-value"), "custom");
  await editor.getByLabel("Desktop width", { exact: true }).fill(String(connection.width));
  await editor.getByLabel("Desktop height", { exact: true }).fill(String(connection.height));
  const clipboard = editor.getByRole("switch", { name: "Clipboard", exact: true });
  if (!await clipboard.isChecked()) await clipboard.press("Space");
}

async function setPrivateInput(input: Locator, value: string): Promise<void> {
  await input.evaluate((element, text) => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!.call(element, text);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

async function assertRdpBoundary(application: ElectronApplication, page: Page): Promise<void> {
  assert.deepEqual(await (await application.browserWindow(page)).evaluate((window) => {
    const preferences = window.webContents.getLastWebPreferences();
    return { sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration };
  }), { sandbox: true, contextIsolation: true, nodeIntegration: false });
  assert.deepEqual(await page.evaluate(() => ({ rdp: typeof (globalThis as unknown as { rdp: unknown }).rdp,
    sliver: typeof (globalThis as unknown as { sliver?: unknown }).sliver, require: typeof (globalThis as unknown as { require?: unknown }).require })),
  { rdp: "object", sliver: "undefined", require: "undefined" });
}

async function captureInput(application: ElectronApplication, page: Page, label: string): Promise<void> {
  await focusWindow(application, page);
  await page.getByLabel(`Keyboard input for ${label}`, { exact: true }).focus();
  await page.locator('.rdp-screen[data-input-capture="captured"]').waitFor();
}

async function closeRemoteDocument(application: ElectronApplication, page: Page, label: string): Promise<void> {
  await captureInput(application, page, label);
  await page.keyboard.press("Alt+F4"); await delay(400); await page.keyboard.press("Alt+n"); await delay(300);
}

async function rdpState(page: Page): Promise<RdpWindowState> {
  return page.evaluate(async () => {
    const state = await (globalThis as unknown as { rdp: RdpWindowAPI }).rdp.getState();
    if (!state.ok) throw new Error("RDP state unavailable");
    return state.value;
  });
}

async function proxyState(page: Page, id: string): Promise<NetworkSocks5ProxySummary> {
  return page.evaluate(async (id) => {
    const result = await (globalThis as unknown as { network: NetworkForwardingAPI }).network.list({});
    if (!result.ok) throw new Error("Proxy inventory unavailable");
    const proxy = result.value.socks5Proxies.find((proxy) => proxy.id === id);
    if (!proxy) throw new Error("The test proxy disappeared");
    return proxy;
  }, id);
}

async function frameCount(page: Page): Promise<number> {
  return Number(await page.locator(".rdp-screen").getAttribute("data-frame-count"));
}

async function until(predicate: () => Promise<boolean>, message: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return;
    await delay(100);
  }
  throw new Error(message);
}
