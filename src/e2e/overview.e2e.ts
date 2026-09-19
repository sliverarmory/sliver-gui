import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const APPLICATION_CLEANUP_TIMEOUT_MS = 5_000;

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
      await page.getByRole("button", { name: "Connect", exact: true }).click();
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
        assert.match(await cloud.innerText(), hosting === "aws" ? /AWS.*us-west-2/u : /Azure.*eastus/u);
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
      for (const name of ["Rename", "Close Session", "Kill Session"]) {
        assert.equal(await contextMenu.getByRole("menuitem", { name, exact: true }).isVisible(), true);
      }
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      if (hosting === "unmanaged") {
        // A stopped event stream keeps the real registry connection degraded
        // and the main-issued session reference valid while graph data is stale.
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("stopped"));
        const staleSession = page.locator('[data-testid="topology-node"][data-freshness="stale"]')
          .filter({ hasText: /m1-session(?:-host)?/u });
        await staleSession.waitFor();
        assert.match(await staleSession.innerText(), /Last known: active.*stale/iu);
        const degradedStatus = await page.evaluate(async () =>
          (await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()).connection.status);
        assert.equal(degradedStatus, "degraded");
        await staleSession.click({ button: "right" });
        await contextMenu.waitFor();
        for (const name of ["Rename", "Close Session", "Kill Session"]) {
          assert.equal(await contextMenu.getByRole("menuitem", { name, exact: true }).isVisible(), true,
            `a stale display label must not hide ${name} for a valid degraded session reference`);
        }
        await page.screenshot({ path: join(artifactDirectory, "overview-unmanaged-stale-menu.png"), animations: "disabled" });
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });

        // Reconnecting still quarantines session actions. Only open and dismiss
        // menus in this journey; the final backend audit forbids target calls.
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("retrying"));
        await page.getByText("Last known state", { exact: true }).waitFor();
        await staleSession.click({ button: "right" });
        await contextMenu.waitFor();
        for (const name of ["Rename", "Close Session", "Kill Session"]) {
          assert.equal(await contextMenu.getByRole("menuitem", { name, exact: true }).count(), 0);
        }
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });
        await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connected"));
        await page.locator('[data-testid="topology-node"][data-freshness="current"]')
          .filter({ hasText: /m1-session(?:-host)?/u }).waitFor();
      }
      await beaconNode.click({ button: "right" });
      await contextMenu.waitFor();
      assert.equal(await contextMenu.getByRole("menuitem", { name: "Rename", exact: true }).count(), 0,
        "session actions must not leak onto other infrastructure nodes");
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      await page.screenshot({ path: join(artifactDirectory, `overview-${hosting}-graph.png`), animations: "disabled" });
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

      const state = await application.evaluate(() => ({
        methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
        tasks: globalThis.__SLIVER_GUI_E2E_STATE__.tasks,
        consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
        sshSessions: globalThis.__SLIVER_GUI_E2E_STATE__.ssh.length,
      }));
      const allowedMethods = new Set([
        "connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler",
        "getOperators", "getSessions", "getBeacons",
      ]);
      assert.deepEqual(state.methods.filter((method) => !allowedMethods.has(method)), [],
        "Overview must only read the existing connection inventory");
      assert.deepEqual(state.tasks, []);
      assert.equal(state.consoles, 0);
      assert.equal(state.sshSessions, 0);
      assert.deepEqual(rendererErrors, []);
      const body = await page.locator("body").innerText();
      assert.doesNotMatch(body, /FAKE_[A-Z0-9_]*(?:SECRET|TOKEN|KEY)|secret-path/u);
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

async function chooseFilter(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(label, "u") }).click();
  const list = page.getByRole("listbox");
  await page.getByRole("option", { name: option, exact: true }).click();
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
        commandPaletteShortcut: current.commandPaletteShortcut,
        terminal: current.terminal,
      },
    });
  }, theme);
  assert.equal(updated.ok, true);
  await page.locator(`html.${theme}`).waitFor();
}
