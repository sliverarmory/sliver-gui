import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { CloudDeploymentAPI } from "../shared/cloud-deployment-ipc.js";
import {
  E2E_AWS_DEPLOYMENT,
  E2E_AZURE_DEPLOYMENT,
  E2E_AZURE_SUBSCRIPTION_ID,
} from "./cloud-deployment-fixture.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const APPLICATION_CLEANUP_TIMEOUT_MS = 5_000;
const SSH_IDENTITY_PRIVATE_KEY_MARKER = "E2E_SSH_IDENTITY_PRIVATE_KEY_DO_NOT_RENDER";
const SESSION_MENU_LABELS = ["Interact", "Interact in new window", "Rename", "Close Session", "Kill Session"] as const;

for (const hosting of ["unmanaged", "aws", "azure"] as const) {
  test(`Overview renders ${hosting} infrastructure with its real layout worker and read-only inspection`, {
    timeout: 90_000,
  }, async (context) => {
    const repositoryRoot = resolve(import.meta.dirname, "../../..");
    const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-overview-e2e-"));
    const artifactDirectory = join(repositoryRoot, "artifacts", "overview-e2e");
    let application: ElectronApplication | undefined;
    let page: Page | undefined;
    let testFailed = false;
    let testFailure: unknown;
    const rendererErrors: string[] = [];
    const workerUrls = new Set<string>();

    try {
      await Promise.all([
        ...["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporaryRoot, name))),
        mkdir(artifactDirectory, { recursive: true }),
      ]);
      await writeFile(join(temporaryRoot, "client", "armories.json"), "[]", { mode: 0o600 });
      await writeFile(join(temporaryRoot, "saved", "overview-fixture.cfg"), JSON.stringify({
        operator: "overview-fixture",
        lhost: "127.0.0.1",
        lport: 31337,
        ca_certificate: "FAKE_OVERVIEW_CA",
        certificate: "FAKE_OVERVIEW_CERT",
        private_key: "FAKE_OVERVIEW_KEY",
        token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
      }), { mode: 0o600 });

      // This is the in-process synthetic backend; the test starts no remote target,
      // listener, cloud operation, tunnel, console, or target command.
      application = await electron.launch({
        args: [
          "--enable-sandbox",
          join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
          `--repository-root=${repositoryRoot}`,
          `--saved-config-directory=${join(temporaryRoot, "saved")}`,
          `--managed-config-directory=${join(temporaryRoot, "managed")}`,
          `--user-data-directory=${join(temporaryRoot, "user-data")}`,
          `--console-client-root-directory=${join(temporaryRoot, "client")}`,
          ...(hosting === "unmanaged" ? [] : [`--overview-cloud-fixture=${hosting}`]),
          ...(hosting === "aws" ? ["--overview-software-fixture"] : []),
        ],
        cwd: repositoryRoot,
        timeout: 20_000,
        bypassCSP: false,
        chromiumSandbox: true,
      } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
      const electronProcess = application.process();
      context.signal.addEventListener("abort", () => { electronProcess.kill("SIGKILL"); }, { once: true });
      page = await application.firstWindow();
      page.setDefaultTimeout(15_000);
      page.on("pageerror", (error) => rendererErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" || /Content Security Policy|Refused to.*worker/iu.test(message.text())) {
          rendererErrors.push(message.text());
          context.diagnostic(message.text());
        }
      });
      page.on("worker", (worker) => workerUrls.add(worker.url()));
      for (const worker of page.workers()) workerUrls.add(worker.url());
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
      await setTheme(page, "light");
      await page.getByRole("dialog", { name: "Saved configurations" })
        .getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
      await page.getByTestId("topology-graph").waitFor();

      const sessionNode = page.getByTestId("topology-node").filter({ hasText: /m1-session(?:-host)?/u });
      const beaconNode = page.getByTestId("topology-node").filter({ hasText: /m1-beacon(?:-host)?/u });
      const inspector = page.getByRole("complementary", { name: "Infrastructure details", exact: true });
      await sessionNode.waitFor();
      await beaconNode.waitFor();
      if (hosting !== "unmanaged") {
        const cloud = page.locator(`.topology-enclosure[data-provider="${hosting}"]`);
        await cloud.waitFor();
        assert.match(await cloud.innerText(), hosting === "aws" ? /AWS.*us-west-2/u : /Azure.*Resource group/u);
      }
      if (hosting === "aws") {
        const redirector = page.getByTestId("topology-node").filter({
          has: page.locator(".topology-node__kind", { hasText: "http redirector" }),
        });
        await redirector.waitFor();
        assert.equal(await page.locator(".topology-node__kind")
          .filter({ hasText: /^(?:public endpoint|local listener)$/u }).count(), 0);
        assert.match(await redirector.innerText(), /Caddy/u);
        const dnsLabel = redirector.locator(".topology-node__subtitle");
        assert.equal(await dnsLabel.isVisible(), true);
        assert.match(await dnsLabel.innerText(), /c2\.example\.test/u);
        await redirector.click();
        assert.match(await inspector.innerText(), /https:\/\/c2\.example\.test/u);
        assert.match(await inspector.innerText(), /127\.0\.0\.1:8000/u);
      }
      await page.waitForFunction(() => {
        const browser = globalThis as unknown as {
          document: { querySelectorAll(selector: string): ArrayLike<{ style: { transform: string } }> };
        };
        const nodes = Array.from(browser.document.querySelectorAll(".react-flow__node"));
        return nodes.length >= 4 && new Set(nodes.map((node) => node.style.transform)).size >= 4;
      });
      assert.ok([...workerUrls].some((url) => /^sliver:\/\/app\//u.test(url) && /worker/iu.test(url)),
        `the real bundled layout worker must run under the application CSP: ${JSON.stringify([...workerUrls])}`);
      assert.equal(await page.getByRole("button", { name: "Fit view", exact: true }).isEnabled(), true);
      await page.locator('[data-slot="toast"]').filter({ hasText: "Connected" }).waitFor({ state: "hidden" });
      const initialViewport = await page.locator(".react-flow__viewport").evaluate((element) => element.style.transform);
      await page.getByRole("button", { name: "Fit view", exact: true }).click();
      await page.evaluate(async () => {
        const browser = globalThis as unknown as { requestAnimationFrame: (callback: () => void) => number };
        await new Promise<void>((resolve) => browser.requestAnimationFrame(() => browser.requestAnimationFrame(() => resolve())));
      });
      assert.equal(await page.locator(".react-flow__viewport").evaluate((element) => element.style.transform), initialViewport,
        "the initial rendered graph must already use Fit view");
      assert.equal(await page.getByRole("button", { name: "Zoom in", exact: true }).innerText(), "+");
      assert.equal(await page.getByRole("button", { name: "Zoom out", exact: true }).innerText(), "−");

      await sessionNode.click({ button: "right" });
      const contextMenu = page.getByRole("menu", { name: "Application context menu" });
      await contextMenu.waitFor();
      for (const name of SESSION_MENU_LABELS) {
        assert.equal(await contextMenu.getByRole("menuitem", { name, exact: true }).isVisible(), true);
      }
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      if (hosting === "unmanaged") {
        // The real client waits for its first event before reporting connected.
        // Successful inventory reads remain current during that quiet period.
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connecting"));
        const awaitingEvents = page.getByText("Awaiting events", { exact: true });
        const notices = page.locator('[aria-label="Topology data status"]');
        await awaitingEvents.waitFor();
        assert.equal(await notices.count(), 0, "routine event-stream status must not render a notice area");
        assert.equal(await page.getByText("Waiting for the first live event. Inventory continues to refresh periodically.", { exact: true }).count(), 0);
        assert.equal(await page.getByText(/Live updates are unavailable/u).count(), 0);
        assert.equal(await sessionNode.getAttribute("data-freshness"), "current");
        assert.equal(await beaconNode.getAttribute("data-freshness"), "current");
        await page.screenshot({ path: join(artifactDirectory, "overview-awaiting-first-event.png"), animations: "disabled" });
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connected"));
        await awaitingEvents.waitFor({ state: "hidden" });
        await page.getByText("Live", { exact: true }).waitFor();

        // A stopped event stream keeps the real registry connection degraded
        // and the main-issued session reference valid while graph data is stale.
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("stopped"));
        const staleSession = page.locator('[data-testid="topology-node"][data-freshness="stale"]')
          .filter({ hasText: /m1-session(?:-host)?/u });
        await staleSession.waitFor();
        await notices.waitFor();
        assert.equal(await notices.isVisible(), true, "a stopped event stream must keep its warning notice visible");
        assert.ok(await notices.locator('[data-severity="warning"]').count() > 0);
        assert.match(await staleSession.innerText(), /Last known: active.*stale/iu);
        const degradedStatus = await page.evaluate(async () =>
          (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()).connection.status);
        assert.equal(degradedStatus, "degraded");
        await staleSession.click({ button: "right" });
        await contextMenu.waitFor();
        for (const name of SESSION_MENU_LABELS) {
          assert.equal(await contextMenu.getByRole("menuitem", { name, exact: true }).isVisible(), true,
            `a stale display label must not hide ${name} for a valid degraded session reference`);
        }
        await page.screenshot({ path: join(artifactDirectory, "overview-unmanaged-stale-menu.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });

        // The event stream retry does not invalidate the registry's existing
        // usable connection or main-issued session reference. Open and dismiss
        // menus only; the final backend audit forbids target commands.
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("retrying"));
        await page.getByText("Last known state", { exact: true }).waitFor();
        const reconnectingStatus = await page.evaluate(async () =>
          (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()).connection.status);
        assert.equal(reconnectingStatus, "reconnecting");
        await staleSession.click({ button: "right" });
        await contextMenu.waitFor();
        for (const name of SESSION_MENU_LABELS) {
          const entry = contextMenu.getByRole("menuitem", { name, exact: true });
          assert.equal(await entry.isVisible(), true,
            `event-stream retry must not hide ${name} for a retained main-issued session reference`);
          assert.equal(await entry.isEnabled(), true,
            `event-stream retry must retain the valid main-issued authority for ${name}`);
        }
        await page.screenshot({ path: join(artifactDirectory, "overview-unmanaged-reconnecting-menu.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });
        const hitTargets = [
          { label: "title", locator: staleSession.locator("strong") },
          { label: "icon", locator: staleSession.locator(".topology-node__icon") },
          { label: "status", locator: staleSession.locator(".topology-node__status") },
          { label: "subtitle", locator: staleSession.locator(".topology-node__subtitle") },
          { label: "background", locator: staleSession, position: { x: 10, y: 10 } },
        ];
        for (const hit of hitTargets) {
          await hit.locator.click({ button: "right", ...("position" in hit ? { position: hit.position } : {}) });
          await contextMenu.waitFor();
          for (const name of SESSION_MENU_LABELS) {
            const entry = contextMenu.getByRole("menuitem", { name, exact: true });
            assert.equal(await entry.isVisible(), true,
              `right-clicking the session ${hit.label} must retain the ${name} entry`);
            assert.equal(await entry.isEnabled(), true,
              `right-clicking the session ${hit.label} must retain valid authority for ${name}`);
          }
          await page.keyboard.press("Escape");
          await contextMenu.waitFor({ state: "hidden" });
        }
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connected"));
        await page.locator('[data-testid="topology-node"][data-freshness="current"]')
          .filter({ hasText: /m1-session(?:-host)?/u }).waitFor();
      }
      await beaconNode.click({ button: "right" });
      await contextMenu.waitFor();
      await assertInteractionEntries(contextMenu);
      assert.equal(await contextMenu.getByRole("menuitem", { name: "Rename", exact: true }).count(), 0,
        "session actions must not leak onto other infrastructure nodes");
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      await verifyServerContextMenuNavigation(application, page, hosting, artifactDirectory, rendererErrors);
      await page.screenshot({ path: join(artifactDirectory, `overview-${hosting}-graph.png`), animations: "disabled" });
      if (hosting !== "unmanaged") await verifyCloudAndInstanceMetadata(page, hosting, artifactDirectory);
      if (hosting === "aws") {
        await setTheme(page, "dark");
        await page.screenshot({ path: join(artifactDirectory, "overview-aws-graph-dark.png"), animations: "disabled" });
        await sessionNode.click();
        await inspector.waitFor();
        const nativeWindow = await application.browserWindow(page);
        const originalSize = await nativeWindow.evaluate((window) => window.getSize());
        const originalWidth = await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth);
        await nativeWindow.evaluate((window) => window.setSize(1000, 760));
        await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 1000);
        await page.getByRole("button", { name: "Fit view", exact: true }).click();
        assert.equal(await page.locator(".overview-toolbar").evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth), true,
          "Overview filters must fit the compact viewport");
        const inspectorBounds = await inspector.boundingBox();
        assert.ok(inspectorBounds && inspectorBounds.x >= 0 && inspectorBounds.x + inspectorBounds.width <= 1000,
          "the compact inspector must remain inside the window");
        await page.screenshot({ path: join(artifactDirectory, "overview-aws-compact-dark.png"), animations: "disabled" });
        await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
        await page.waitForFunction((width) => (globalThis as unknown as { innerWidth: number }).innerWidth === width, originalWidth);
        await inspector.getByRole("button", { name: "Close", exact: true }).click();
        await setTheme(page, "light");
      }

      const search = page.getByLabel("Search infrastructure", { exact: true });
      await search.fill("m1-session");
      await sessionNode.waitFor();
      await beaconNode.waitFor({ state: "hidden" });
      await sessionNode.click();
      await inspector.waitFor();
      assert.match(await inspector.innerText(), /m1-session/u);
      assert.match(await inspector.innerText(), /mtls/iu);
      await search.fill("");
      await beaconNode.waitFor();

      await chooseFilter(page, "Infrastructure type", "Beacon");
      await beaconNode.waitFor();
      await sessionNode.waitFor({ state: "hidden" });
      await chooseFilter(page, "Infrastructure type", "All types");
      await sessionNode.waitFor();
      await chooseFilter(page, "Status", "Inactive");
      await sessionNode.waitFor({ state: "hidden" });
      await beaconNode.waitFor({ state: "hidden" });
      await chooseFilter(page, "Status", "All states");
      await sessionNode.waitFor();
      await beaconNode.waitFor();

      if (hosting !== "unmanaged") {
        const cloud = page.locator(`.topology-enclosure[data-provider="${hosting}"]`);
        const server = page.getByTestId("topology-node").filter({
          has: page.locator(".topology-node__kind").filter({ hasText: /^server$/u }),
        });
        const allNodes = await page.getByTestId("topology-node").count();
        await page.getByRole("button", { name: /Infrastructure type/u }).click();
        const types = page.getByRole("listbox", { name: "Infrastructure type", exact: true });
        await types.getByRole("option", { name: "Cloud", exact: true }).click();
        assert.equal(await types.isVisible(), true);
        assert.equal(await types.getByRole("option", { name: "Server", exact: true }).getAttribute("aria-selected"), "true");
        await page.keyboard.press("Escape");
        await types.waitFor({ state: "hidden" });
        await cloud.waitFor({ state: "hidden" });
        await server.waitFor();
        await sessionNode.waitFor();
        await beaconNode.waitFor();
        assert.equal(await page.getByTestId("topology-node").count(), allNodes - 1,
          "excluding the cloud enclosure must preserve its selected server as a standalone node");
        await chooseFilter(page, "Infrastructure type", "All types");
        await cloud.waitFor();
      }

      await page.getByRole("button", { name: "List", exact: true }).click();
      await page.getByTestId("topology-graph").waitFor({ state: "hidden" });
      const resources = page.getByRole("table", { name: "Infrastructure resources", exact: true });
      assert.match(await resources.innerText(), /m1-session/u);
      assert.match(await resources.innerText(), /m1-beacon/u);
      await resources.getByRole("button", { name: "m1-beacon-host", exact: true }).click();
      assert.match(await inspector.innerText(), /m1-beacon/u);
      await page.screenshot({ path: join(artifactDirectory, `overview-${hosting}-list.png`), animations: "disabled" });
      await page.getByRole("button", { name: "Graph", exact: true }).click();
      await page.getByTestId("topology-graph").waitFor();
      await page.getByRole("button", { name: "Reset layout", exact: true }).click();
      await sessionNode.waitFor();
      await beaconNode.waitFor();

      if (hosting === "unmanaged") {
        if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close", exact: true }).click();
        await verifyInteractionNavigation(application, page, "session", artifactDirectory, rendererErrors);
        await verifyInteractionNavigation(application, page, "beacon", artifactDirectory, rendererErrors);
        // Disconnect only this in-process fake adapter. The retained display
        // retains menu labels but must not carry usable session capabilities.
        const disconnected = await page.evaluate(() =>
          (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.disconnect());
        assert.ok(disconnected.ok);
        assert.equal(disconnected.value.connection.status, "disconnected");
        const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
        await savedConfigurations.getByRole("button", { name: "Cancel", exact: true }).click();
        await savedConfigurations.waitFor({ state: "hidden" });
        await page.getByText("Last known state", { exact: true }).waitFor();
        await sessionNode.click({ button: "right" });
        await contextMenu.waitFor();
        for (const name of SESSION_MENU_LABELS) {
          const entry = contextMenu.getByRole("menuitem", { name, exact: true });
          assert.equal(await entry.isVisible(), true,
            `the disconnected retained graph must keep the ${name} label`);
          assert.equal(await entry.isEnabled(), false,
            `the disconnected retained graph must disable ${name}`);
        }
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });
      }

      const state = await application.evaluate(() => ({
        methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
        disconnects: globalThis.__SLIVER_GUI_E2E_STATE__.disconnects,
        tasks: globalThis.__SLIVER_GUI_E2E_STATE__.tasks,
        openSessionRequests: globalThis.__SLIVER_GUI_E2E_STATE__.openSessionRequests,
        executionCalls: globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.callCounts,
        consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
        sshSessions: globalThis.__SLIVER_GUI_E2E_STATE__.ssh.length,
      }));
      const allowedMethods = new Set([
        "connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler",
        "getOperators", "getSessions", "getBeacons", "getPivotGraph", "getExternalBuilders", "getCrackstations",
        "lootAll", "credentialsAll",
        ...(hosting === "unmanaged" ? ["getBeaconTasks", "disconnect"] : []),
      ]);
      assert.deepEqual(state.methods.filter((method) => !allowedMethods.has(method)), [],
        "Overview navigation must only read inventory and the selected workspace's existing task list");
      assert.deepEqual(state.tasks, []);
      assert.deepEqual(state.openSessionRequests, []);
      assert.deepEqual(state.executionCalls, {});
      assert.equal(state.disconnects, hosting === "unmanaged" ? 1 : 0);
      assert.equal(state.consoles, 0);
      assert.equal(state.sshSessions, 0);
      assert.deepEqual(rendererErrors, []);
      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /FAKE_[A-Z0-9_]*(?:SECRET|TOKEN|KEY)|secret-path/u);
      assert.equal(body.includes(SSH_IDENTITY_PRIVATE_KEY_MARKER), false,
        "the materialized SSH private key must not reach rendered content");
      assert.equal(rendererErrors.join("\n").includes(SSH_IDENTITY_PRIVATE_KEY_MARKER), false,
        "the materialized SSH private key must not reach renderer errors");
      assert.equal(JSON.stringify(state).includes(SSH_IDENTITY_PRIVATE_KEY_MARKER), false,
        "the materialized SSH private key must not reach renderer-observable state");
    } catch (error) {
      testFailed = true;
      testFailure = error;
      if (page && !page.isClosed()) {
        await page.screenshot({ path: join(artifactDirectory, `overview-${hosting}-failure.png`), animations: "disabled" })
          .catch(() => undefined);
      }
      throw error;
    } finally {
      const cleanupFailures: unknown[] = [];
      if (application) {
        await cleanupOwnedApplication(application, "Overview", APPLICATION_CLEANUP_TIMEOUT_MS)
          .catch((error) => cleanupFailures.push(error));
      }
      await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
      if (cleanupFailures.length > 0) {
        const cleanupError = new AggregateError(cleanupFailures, "Overview E2E cleanup failed");
        if (testFailed) {
          attachCleanupFailure(testFailure, cleanupError);
          console.error("Failed to clean Overview E2E resources", cleanupError);
        } else {
          throw cleanupError;
        }
      }
    }
  });
}

test("Overview toolbar choices survive an application restart", { timeout: 90_000 }, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-overview-preferences-e2e-"));
  const clientRoot = join(temporaryRoot, "client");
  const expected = {
    kinds: ["beacon"], statuses: ["inactive"], lightning: true,
    sidebarDisabled: true, presentation: "list",
  } as const;
  let application: ElectronApplication | undefined;
  let testFailure: unknown;
  const launch = async (): Promise<ElectronApplication> => {
    const launched = await electron.launch({
      args: [
        "--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`,
        `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${clientRoot}`,
      ],
      cwd: repositoryRoot, timeout: 20_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const electronProcess = launched.process();
    context.signal.addEventListener("abort", () => electronProcess.kill("SIGKILL"), { once: true });
    return launched;
  };
  try {
    await Promise.all(["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporaryRoot, name))));
    await writeFile(join(clientRoot, "armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporaryRoot, "saved", "overview-fixture.cfg"), JSON.stringify({
      operator: "overview-fixture", lhost: "127.0.0.1", lport: 31337,
      ca_certificate: "FAKE_OVERVIEW_CA", certificate: "FAKE_OVERVIEW_CERT",
      private_key: "FAKE_OVERVIEW_KEY", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });

    application = await launch();
    let page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await chooseFilter(page, "Infrastructure type", "Beacon");
    await chooseFilter(page, "Status", "Inactive");
    await page.getByText("Lightning", { exact: true }).click();
    await page.getByText("Disable sidebar", { exact: true }).click();
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.waitForFunction(async (target) => {
      const state = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings();
      return JSON.stringify(state.overview) === JSON.stringify(target);
    }, expected);
    const settingsPath = join(clientRoot, "gui", "application-settings.json");
    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")).overview, expected);
    await cleanupOwnedApplication(application, "Overview preferences restart", APPLICATION_CLEANUP_TIMEOUT_MS);
    application = undefined;

    application = await launch();
    page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    await page.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.getByRole("button", { name: "List", exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
    assert.match(await page.getByRole("button", { name: /Infrastructure type/u }).innerText(), /Beacon/u);
    assert.match(await page.getByRole("button", { name: /Status/u }).innerText(), /Inactive/u);
    assert.equal(await page.getByRole("switch", { name: "Lightning", exact: true }).isChecked(), true);
    assert.equal(await page.getByRole("switch", { name: "Disable sidebar", exact: true }).isChecked(), true);
    assert.deepEqual((await page.evaluate(async () =>
      (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings()).overview)), expected);
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) await cleanupOwnedApplication(application, "Overview preferences", APPLICATION_CLEANUP_TIMEOUT_MS)
      .catch((error) => cleanupFailures.push(error));
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length) {
      const cleanupError = new AggregateError(cleanupFailures, "Overview preferences E2E cleanup failed");
      if (testFailure) attachCleanupFailure(testFailure, cleanupError);
      else throw cleanupError;
    }
  }
});

async function verifyServerContextMenuNavigation(
  application: ElectronApplication,
  page: Page,
  hosting: "unmanaged" | "aws" | "azure",
  artifactDirectory: string,
  rendererErrors: string[],
): Promise<void> {
  const server = page.getByTestId("topology-node").filter({
    has: page.locator(".topology-node__kind").filter({ hasText: /^server$/u }),
  });
  const menu = page.getByRole("menu", { name: "Application context menu" });
  const powerLabel = hosting === "unmanaged" ? "Start" : "Stop";
  const labels = ["View Jobs/Listeners", "SSH", "Copy SSH Command", "Firewall", "Deploy Redirector (Local)", "Add Operator", "Rename", "Copy Public IP", powerLabel, "Reboot", "Terminate"];
  const originalWindows = application.windows().length;
  await server.click({ button: "right" });
  await menu.waitFor();
  assert.deepEqual((await menu.getByRole("menuitem").allTextContents()).slice(0, labels.length), labels,
    "the server context menu must keep navigation before its power controls");
  const orderedItems = await menu.locator('[role="menuitem"], [role="separator"], hr').evaluateAll((items) =>
    items.map((item) => item.getAttribute("role") === "separator" || item.tagName === "HR"
      ? "separator" : item.textContent?.trim()));
  assert.deepEqual(orderedItems.slice(0, 13), [
    "View Jobs/Listeners", "SSH", "Copy SSH Command", "Firewall", "Deploy Redirector (Local)", "Add Operator", "separator", "Rename", "Copy Public IP", "separator", powerLabel, "Reboot", "Terminate",
  ], "real separators must divide access, metadata, and lifecycle actions");
  assert.equal(await menu.getByRole("menuitem", { name: "View Jobs/Listeners", exact: true }).isEnabled(), true);
  for (const name of labels.slice(1)) {
    assert.equal(await menu.getByRole("menuitem", { name, exact: true }).isEnabled(), hosting !== "unmanaged",
      `${hosting} server action ${name} must respect its managed association`);
  }
  await page.screenshot({ path: join(artifactDirectory, `overview-${hosting}-server-menu.png`), animations: "disabled" });

  // Jobs navigation reuses this workspace. No listener or server action is submitted.
  await menu.getByRole("menuitem", { name: "View Jobs/Listeners", exact: true }).click();
  await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();
  assert.equal(application.windows().length, originalWindows);
  await page.locator('[aria-label="Overview navigation"]').getByRole("row", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await server.waitFor();
  if (hosting === "unmanaged") return;

  const deployment = hosting === "aws" ? E2E_AWS_DEPLOYMENT : E2E_AZURE_DEPLOYMENT;
  // Capture only this isolated fixture's write without reading or changing the
  // user's clipboard. The real menu still crosses the preload/main boundary.
  await application.evaluate(({ clipboard }) => {
    const state = globalThis as unknown as {
      __overviewClipboardCapture?: { originalWriteText: typeof clipboard.writeText; writes: string[] };
    };
    if (state.__overviewClipboardCapture) throw new Error("Overview clipboard capture is already installed");
    const writes: string[] = [];
    state.__overviewClipboardCapture = { originalWriteText: clipboard.writeText, writes };
    clipboard.writeText = (text) => { writes.push(text); };
  });
  try {
    await server.click({ button: "right" });
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: "Copy SSH Command", exact: true }).click();
    await page.getByText("SSH command copied to clipboard", { exact: true }).waitFor();
    await server.click({ button: "right" });
    await menu.waitFor();
    await menu.getByRole("menuitem", { name: "Copy Public IP", exact: true }).click();
    await page.getByText("Public IP copied to clipboard", { exact: true }).waitFor();
    const clipboardWrites = await application.evaluate(() => {
      const state = globalThis as unknown as { __overviewClipboardCapture?: { writes: string[] } };
      return state.__overviewClipboardCapture?.writes ?? [];
    });
    const expectedSshCommand = hosting === "aws"
      ? `ssh -i ~/.ssh/sliver-gui/${deployment.name} -p 22 fixture@192.0.2.10`
      : `ssh -i ~/.ssh/sliver-gui/${deployment.name} -p 22 azureuser@203.0.113.42`;
    assert.deepEqual(clipboardWrites, [expectedSshCommand, deployment.runtime.publicIpAddress]);
    assert.equal(application.windows().length, originalWindows, "copying server details must not open a window");
  } finally {
    await application.evaluate(({ clipboard }) => {
      const state = globalThis as unknown as {
        __overviewClipboardCapture?: { originalWriteText: typeof clipboard.writeText; writes: string[] };
      };
      if (state.__overviewClipboardCapture) {
        clipboard.writeText = state.__overviewClipboardCapture.originalWriteText;
        delete state.__overviewClipboardCapture;
      }
    });
  }
  const observeCloudWindow = (candidate: Page): void => {
    candidate.on("pageerror", (error) => rendererErrors.push(error.message));
    candidate.on("console", (message) => {
      if (message.type() === "error" || /Content Security Policy/iu.test(message.text())) {
        rendererErrors.push(message.text());
      }
    });
  };
  application.on("window", observeCloudWindow);
  let cloudPage: Page | undefined;
  try {
    for (const destination of ["Add Operator", "Firewall", "Deploy Redirector (Local)", "Rename"] as const) {
      await server.click({ button: "right" });
      await menu.waitFor();
      [cloudPage] = await Promise.all([
        application.waitForEvent("window", { timeout: 15_000 }),
        menu.getByRole("menuitem", { name: destination, exact: true }).click(),
      ]);
      cloudPage.setDefaultTimeout(15_000);
      await cloudPage.waitForURL(/\?surface=cloud-deployment$/u);
      assert.equal(application.windows().length, originalWindows + 1);
      if (destination === "Add Operator") {
        await cloudPage.getByRole("heading", { level: 1, name: "New Operator", exact: true }).waitFor();
        const form = cloudPage.getByRole("form", { name: `New Operator for ${deployment.name}`, exact: true });
        await form.waitFor();
        assert.equal(await form.getByRole("textbox", { name: "Operator Name" }).inputValue(), "");
        assert.equal(await form.getByLabel("Public IP", { exact: true }).inputValue(), deployment.runtime.publicIpAddress);
        assert.equal(await form.getByLabel("Port", { exact: true }).inputValue(), String(deployment.spec.multiplayerPort));
        assert.equal(await form.getByRole("button", { name: "Create Operator", exact: true }).isDisabled(), true);
      } else if (destination === "Firewall") {
        await cloudPage.getByRole("heading", { level: 1, name: deployment.name, exact: true }).waitFor();
        await cloudPage.getByRole("heading", { name: "Firewall rules", exact: true }).waitFor();
        await cloudPage.getByRole("grid", { name: "Inbound firewall rules", exact: true }).waitFor();
      } else if (destination === "Deploy Redirector (Local)") {
        await cloudPage.getByRole("heading", { level: 1, name: "Managed software", exact: true }).waitFor();
        await cloudPage.getByRole("region", { name: "Managed software content", exact: true }).waitFor();
        if (hosting === "aws") {
          await cloudPage.getByRole("button", { name: "Add software" }).click();
          const domainTabs = cloudPage.locator('[data-slot="tabs-list-container"]').filter({
            has: cloudPage.getByRole("tablist", { name: "Domain source" }),
          });
          const stripBounds = await domainTabs.boundingBox();
          assert.ok(stripBounds, "DNS tab strip must be visible");
          for (const label of ["Manual DNS", "Cloud DNS"]) {
            const tab: Locator = cloudPage.getByRole("tab", { name: label, exact: true });
            const bounds: { x: number; y: number; width: number; height: number } | null = await tab.boundingBox();
            assert.ok(bounds, `${label} tab must be visible`);
            assert.ok(bounds.x >= stripBounds.x - 1 && bounds.x + bounds.width <= stripBounds.x + stripBounds.width + 1,
              `${label} must fit in the visible tab strip`);
            const whiteSpace: string = await tab.evaluate((element: unknown) => (globalThis as unknown as {
              getComputedStyle(element: unknown): { whiteSpace: string };
            }).getComputedStyle(element).whiteSpace);
            assert.equal(whiteSpace, "nowrap", `${label} must stay on one line`);
          }
          await domainTabs.screenshot({
            path: join(artifactDirectory, "overview-aws-software-domain-tabs.png"),
            animations: "disabled",
          });
          await cloudPage.getByRole("tab", { name: "Cloud DNS", exact: true }).click();
          await cloudPage.getByRole("combobox", { name: "Public zone" }).selectOption("ZEXAMPLE");
          await cloudPage.getByRole("combobox", { name: "DNS record setup" }).selectOption("create");
          await cloudPage.getByRole("textbox", { name: "Subdomains to create" }).fill("c2");
          const plannedDomain = "c2.example.test";
          await cloudPage.getByText(`${plannedDomain} → ${deployment.runtime.publicIpAddress}`, { exact: true }).waitFor();
          await cloudPage.getByText("Cloud DNS will create missing A records with TTL 300 seconds:", { exact: true }).waitFor();
          await cloudPage.getByRole("region", { name: "Managed software content" }).screenshot({
            path: join(artifactDirectory, "overview-aws-software-create-dns.png"),
            animations: "disabled",
          });
          await cloudPage.getByRole("button", { name: "Review deployment" }).click();
          await cloudPage.getByRole("heading", { name: "Review deployment" }).waitFor();
          await cloudPage.getByText(`https://${plannedDomain}`, { exact: true }).waitFor();
          await cloudPage.getByText(`Cloud DNS will create missing A records for ${plannedDomain} pointing to ${deployment.runtime.publicIpAddress} (TTL 300 seconds), then wait up to 2 minutes for DNS propagation.`, { exact: true }).waitFor();
          await cloudPage.getByText("Records created during deployment stay in Cloud DNS if installation fails or this redirector is removed.", { exact: true }).waitFor();
          await cloudPage.getByRole("button", { name: "Install Caddy", exact: true }).click();
          await cloudPage.getByRole("heading", { name: "Installing Caddy", exact: true }).waitFor();
          const installationSteps = cloudPage.getByRole("list", { name: "Installation steps" });
          await installationSteps.waitFor();
          for (const label of [
            "Prepare public DNS",
            "Prepare localhost listener",
            "Configure public firewall",
            "Install software over SSH",
            "Verify public endpoint",
          ]) await installationSteps.getByText(label, { exact: true }).waitFor();
          await cloudPage.getByRole("region", { name: "SSH installation output" }).waitFor();
          await cloudPage.getByText("c2.example.test points to this server", { exact: true }).waitFor();
          await cloudPage.getByText("Caddy installation finished", { exact: true }).waitFor();
          await cloudPage.getByRole("alert").filter({
            hasText: "E2E fixture stopped at verification; no cloud or SSH changes were made",
          }).waitFor();
          const installSnapshot = await cloudPage.evaluate(async (deploymentId) => {
            const api = (globalThis as unknown as {
              cloudDeployment: Pick<CloudDeploymentAPI, "getSoftwareInstallProgress">;
            }).cloudDeployment;
            const result = await api.getSoftwareInstallProgress({ deploymentId });
            if (!result.ok || !result.value) return null;
            return {
              status: result.value.status,
              events: result.value.events.map(({ step, status, message }) => ({ step, status, message })),
              stdout: result.value.events.flatMap(({ output }) => output?.stream === "stdout"
                ? [new TextDecoder().decode(output.chunk)] : []).join(""),
            };
          }, deployment.id);
          assert.equal(installSnapshot?.status, "failed");
          assert.deepEqual(installSnapshot?.events.filter(({ status }) => status === "complete").map(({ step }) => step),
            ["dns", "listener", "firewall", "ssh"]);
          assert.match(installSnapshot?.stdout ?? "", /E2E fixture: installing Caddy package/u);
          const softwareContent = cloudPage.getByRole("region", { name: "Managed software content" });
          await softwareContent.evaluate((element) => { element.scrollTop = 0; });
          await softwareContent.screenshot({
            path: join(artifactDirectory, "overview-aws-software-install-progress.png"),
            animations: "disabled",
          });
          await cloudPage.getByRole("region", { name: "SSH installation output" }).scrollIntoViewIfNeeded();
          await softwareContent.screenshot({
            path: join(artifactDirectory, "overview-aws-software-install-output.png"),
            animations: "disabled",
          });
          await cloudPage.getByRole("button", { name: "Back to software" }).click();
          await cloudPage.getByRole("heading", { level: 1, name: "Managed software", exact: true }).waitFor();
          await cloudPage.getByRole("button", { name: "View last install log" }).click();
          await cloudPage.getByRole("heading", { name: "Installing Caddy", exact: true }).waitFor();
          await cloudPage.getByRole("button", { name: "Back to software" }).click();
        }
      } else {
        const rename = cloudPage.getByRole("dialog", { name: "Rename Instance", exact: true });
        await rename.waitFor();
        assert.equal(await rename.getByRole("textbox", { name: /^Name/u }).inputValue(), deployment.name);
        assert.equal(await rename.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
      }
      await cloudPage.screenshot({
        path: join(artifactDirectory, `overview-${hosting}-server-${destination === "Add Operator" ? "operator" : destination === "Deploy Redirector (Local)" ? "software" : destination.toLowerCase()}.png`),
        animations: "disabled",
      });
      // The software install above runs only against the in-process fake
      // controller. Never submit a real rename, operator, lifecycle, firewall,
      // cloud DNS, or SSH operation from this journey.
      if (destination === "Rename") {
        const rename = cloudPage.getByRole("dialog", { name: "Rename Instance", exact: true });
        await rename.getByRole("button", { name: "Cancel", exact: true }).click();
        await rename.waitFor({ state: "hidden" });
      }
      await cloudPage.close();
      cloudPage = undefined;
      await page.bringToFront();
      assert.equal(application.windows().length, originalWindows);
      await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    }
  } finally {
    application.off("window", observeCloudWindow);
    await cloudPage?.close();
  }
}

async function verifyCloudAndInstanceMetadata(
  page: Page,
  provider: "aws" | "azure",
  artifactDirectory: string,
): Promise<void> {
  const cloud = page.locator(`.topology-enclosure[data-provider="${provider}"]`);
  const server = page.locator(".topology-node").filter({
    has: page.locator(".topology-node__kind").filter({ hasText: /^server$/u }),
  });
  const inspector = page.getByRole("complementary", { name: "Infrastructure details", exact: true });
  const record = provider === "aws" ? E2E_AWS_DEPLOYMENT : E2E_AZURE_DEPLOYMENT;
  const expectedCloud: Record<string, string> = provider === "aws" ? {
    "Provider": "AWS",
    "Region": E2E_AWS_DEPLOYMENT.spec.region,
    "VPC ID": E2E_AWS_DEPLOYMENT.runtime.vpcId!,
  } : {
    "Provider": "Azure",
    "Subscription ID": E2E_AZURE_SUBSCRIPTION_ID,
    "Resource group": E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName!,
    "Resource group ID": `/subscriptions/${E2E_AZURE_SUBSCRIPTION_ID}/resourceGroups/${E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName}`,
    "Virtual network": `${E2E_AZURE_DEPLOYMENT.name}-vnet`,
    "Virtual network ID": E2E_AZURE_DEPLOYMENT.runtime.vnetId!,
    "Virtual network resource group": E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName!,
    "Virtual network CIDR": E2E_AZURE_DEPLOYMENT.spec.managedVnetCidr!,
  };
  const expectedInstance: Record<string, string> = {
    "Deployment": record.name,
    "Instance name": record.name,
    "Instance state (cached)": record.runtime.instanceState,
    "Public IP": record.runtime.publicIpAddress!,
    "Private IP": record.runtime.privateIpAddress!,
    "Subnet ID": record.runtime.subnetId!,
    "Instance metadata updated": record.updatedAt,
    ...(provider === "aws" ? {
      "Instance ID": E2E_AWS_DEPLOYMENT.runtime.instanceId!,
      "Region": E2E_AWS_DEPLOYMENT.spec.region,
      "Availability zone": E2E_AWS_DEPLOYMENT.runtime.availabilityZone!,
      "Instance size": E2E_AWS_DEPLOYMENT.spec.instanceType,
      "Instance health (cached)": "ok",
    } : {
      "Instance ID": E2E_AZURE_DEPLOYMENT.runtime.vmId!,
      "Location": E2E_AZURE_DEPLOYMENT.spec.location,
      "Instance size": E2E_AZURE_DEPLOYMENT.spec.vmSize,
    }),
  };

  // The cloud represents a shared infrastructure scope, not this deployment.
  // Inspect the actual rendered properties, not an independently built model.
  await cloud.locator(".topology-enclosure__heading").click();
  await inspector.waitFor();
  await inspector.getByRole("heading", {
    name: provider === "aws" ? E2E_AWS_DEPLOYMENT.runtime.vpcId! : E2E_AZURE_DEPLOYMENT.runtime.resourceGroupName!,
    exact: true,
  }).waitFor();
  const cloudProperties = await inspectorProperties(inspector);
  for (const [label, value] of Object.entries(expectedCloud)) {
    assert.equal(cloudProperties[label], value, `${provider} cloud must expose ${label}`);
  }
  assert.equal(cloudProperties["Status"], provider === "aws" ? "VPC" : "Resource group");
  assert.equal(cloudProperties["Cloud metadata updated"], record.updatedAt);
  for (const label of [
    "Deployment", "Instance ID", "Instance name", "Availability zone", "Subnet ID", "Instance size",
    "Instance state (cached)", "Instance health (cached)", "Public IP", "Private IP", "Instance metadata updated",
    ...(provider === "azure" ? ["Region", "Location"] : []),
  ]) {
    assert.equal(cloudProperties[label], undefined, `${provider} cloud must not expose instance property ${label}`);
  }
  for (const value of [record.name, record.runtime.publicIpAddress, record.runtime.privateIpAddress, expectedInstance["Instance size"]]) {
    assert.ok(!Object.values(cloudProperties).includes(value!), `${provider} cloud must not retain instance value ${value}`);
  }
  await page.screenshot({ path: join(artifactDirectory, `overview-${provider}-cloud-inspector.png`), animations: "disabled" });
  await inspector.getByRole("button", { name: "Close", exact: true }).click();

  // Preserve the graph's enclosure when details move to its instance child.
  const cloudBounds = await cloud.boundingBox();
  const serverBounds = await server.boundingBox();
  assert.ok(cloudBounds && serverBounds);
  assert.ok(serverBounds.x >= cloudBounds.x && serverBounds.y >= cloudBounds.y &&
    serverBounds.x + serverBounds.width <= cloudBounds.x + cloudBounds.width + 1 &&
    serverBounds.y + serverBounds.height <= cloudBounds.y + cloudBounds.height + 1,
  `${provider} server must remain enclosed by its cloud scope`);
  assert.equal(await server.locator(".topology-node__text strong").textContent(), expectedInstance["Instance name"],
    `${provider} server must display its instance name instead of its endpoint`);
  await server.click();
  await inspector.getByRole("heading", { name: expectedInstance["Instance name"]!, exact: true }).waitFor();
  const instanceProperties = await inspectorProperties(inspector);
  for (const [label, value] of Object.entries(expectedInstance)) {
    assert.equal(instanceProperties[label], value, `${provider} instance must expose ${label}`);
  }
  assert.equal(instanceProperties["Status"], "Connected", "server connectivity remains distinct from cached instance state");
  for (const label of [
    "VPC ID", "VPC CIDR", "Subscription ID", "Resource group", "Resource group ID", "Virtual network",
    "Virtual network ID", "Virtual network resource group", "Virtual network CIDR", "Cloud metadata updated",
  ]) {
    assert.equal(instanceProperties[label], undefined, `${provider} instance must not duplicate cloud property ${label}`);
  }
  await page.screenshot({ path: join(artifactDirectory, `overview-${provider}-instance-inspector.png`), animations: "disabled" });
  await inspector.getByRole("button", { name: "Close", exact: true }).click();
}

async function inspectorProperties(inspector: Locator): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const row of await inspector.locator(".overview-properties > div").all()) {
    const label = await row.locator("dt").innerText();
    assert.equal(result[label], undefined, `inspector property ${label} must not be duplicated`);
    result[label] = await row.locator("dd").innerText();
  }
  return result;
}

async function assertInteractionEntries(menu: Locator): Promise<void> {
  const entries = menu.getByRole("menuitem");
  assert.equal(await entries.nth(0).innerText(), "Interact");
  assert.equal(await entries.nth(1).innerText(), "Interact");
  assert.equal(await entries.nth(1).getAttribute("aria-label"), "Interact in new window");
  for (const name of ["Interact", "Interact in new window"]) {
    assert.equal(await menu.getByRole("menuitem", { name, exact: true }).isEnabled(), true);
  }
}

async function verifyInteractionNavigation(
  application: ElectronApplication,
  page: Page,
  mode: "session" | "beacon",
  artifactDirectory: string,
  rendererErrors: string[],
): Promise<void> {
  const snapshot = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
  const summary = (mode === "session" ? snapshot.domains.sessions.items : snapshot.domains.beacons.items)[0];
  assert.ok(summary);
  const expected = snapshot.targetContext.selectableTargets.find((target) => target.mode === mode && target.id === summary.id);
  assert.ok(expected, "the fixture must provide an exact main-issued selectable target");
  const node = page.getByTestId("topology-node").filter({ hasText: summary.hostname });
  const menu = page.getByRole("menu", { name: "Application context menu" });
  const originalWindows = application.windows().length;

  // These entries navigate only. Leave every operation form and action alone.
  await node.click({ button: "right" });
  await menu.waitFor();
  await assertInteractionEntries(menu);
  await menu.getByRole("menuitem", { name: "Interact", exact: true }).click();
  await assertInteractionWorkspace(page, mode, summary.name);
  assert.equal(application.windows().length, originalWindows, "Interact must reuse the current window");
  const current = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
  assert.deepEqual(current.targetContext.activeTarget, expected);
  await page.locator('[aria-label="Overview navigation"]').getByRole("row", { name: "Overview", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await node.waitFor();

  const observePopout = (candidate: Page): void => {
    candidate.on("pageerror", (error) => rendererErrors.push(error.message));
    candidate.on("console", (message) => {
      if (message.type() === "error" || /Content Security Policy|Refused to.*worker/iu.test(message.text())) {
        rendererErrors.push(message.text());
      }
    });
  };
  application.on("window", observePopout);
  let popout: Page | undefined;
  try {
    await node.click({ button: "right" });
    await menu.waitFor();
    await assertInteractionEntries(menu);
    await page.screenshot({ path: join(artifactDirectory, `overview-${mode}-interact-menu.png`), animations: "disabled" });
    [popout] = await Promise.all([
      application.waitForEvent("window", { timeout: 15_000 }),
      menu.getByRole("menuitem", { name: "Interact in new window", exact: true }).click(),
    ]);
    popout.setDefaultTimeout(15_000);
    await popout.waitForURL(/\?surface=interaction$/u);
    await popout.locator('[aria-label="Dedicated interaction window"]').waitFor();
    await assertInteractionWorkspace(popout, mode, summary.name);
    assert.equal(application.windows().length, originalWindows + 1);
    const destination = await popout.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
    assert.deepEqual(destination.targetContext.activeTarget, expected);
    assert.equal(new URL(popout.url()).search, "?surface=interaction");
    assert.equal(new URL(popout.url()).hash, "");
    assert.equal(await popout.locator('[aria-label="Overview navigation"]').count(), 0);
    assert.equal(await popout.getByRole("button", { name: "Pop out interaction", exact: true }).count(), 0);
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await popout.screenshot({ path: join(artifactDirectory, `overview-${mode}-interact-window.png`), animations: "disabled" });
  } finally {
    application.off("window", observePopout);
    await popout?.close();
  }
  await page.bringToFront();
  assert.equal(application.windows().length, originalWindows);
}

async function assertInteractionWorkspace(page: Page, mode: "session" | "beacon", name: string): Promise<void> {
  if (mode === "session") {
    await page.getByRole("heading", { name, exact: true }).first().waitFor();
    await page.getByRole("navigation", { name: "Session workspace breadcrumbs", exact: true }).waitFor();
    await page.getByRole("tablist", { name: "Session interaction sections", exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Overview", exact: true }).getAttribute("aria-selected"), "true");
  } else {
    await page.getByRole("heading", { name: "Async task workspace", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
  }
}

async function chooseFilter(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(label, "u") }).click();
  const list = page.getByRole("listbox", { name: label, exact: true });
  await list.waitFor();
  assert.equal(await list.getAttribute("aria-multiselectable"), "true");
  const allLabel = label === "Infrastructure type" ? "All types" : "All states";
  const all = list.getByRole("option", { name: allLabel, exact: true });
  if (await all.getAttribute("aria-selected") !== "true") await all.click();
  if (option !== allLabel) {
    await all.click();
    await list.getByRole("option", { name: option, exact: true }).click();
  }
  assert.equal(await list.isVisible(), true, "multiselect filters stay open after changing choices");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
}

async function setTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  const updated = await page.evaluate(async (nextTheme) => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    const current = await api.getApplicationSettings();
    return api.updateApplicationSettings({
      expectedRevision: current.revision,
      settings: {
        theme: nextTheme,
        appIcon: current.appIcon,
        reduceMotion: current.reduceMotion,
        reportScreenshotDirectory: current.reportScreenshotDirectory,
        commandPaletteShortcut: current.commandPaletteShortcut,
        keyboardShortcuts: current.keyboardShortcuts,
        terminal: current.terminal,
        overview: current.overview,
      },
    });
  }, theme);
  assert.equal(updated.ok, true);
  await page.locator(`html.${theme}`).waitFor();
}
