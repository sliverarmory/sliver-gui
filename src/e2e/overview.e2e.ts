import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import {
  E2E_AWS_DEPLOYMENT,
  E2E_AZURE_DEPLOYMENT,
  E2E_AZURE_SUBSCRIPTION_ID,
} from "./cloud-deployment-fixture.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const APPLICATION_CLEANUP_TIMEOUT_MS = 5_000;
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
        assert.match(await cloud.innerText(), hosting === "aws" ? /AWS.*us-west-2/u : /Azure.*Resource group/u);
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
    "Instance name": provider === "aws" ? record.name : E2E_AZURE_DEPLOYMENT.runtime.vmName!,
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
  await server.click();
  await inspector.getByRole("heading", { name: "127.0.0.1:31337", exact: true }).waitFor();
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
        keyboardShortcuts: current.keyboardShortcuts,
        terminal: current.terminal,
      },
    });
  }, theme);
  assert.equal(updated.ok, true);
  await page.locator(`html.${theme}`).waitFor();
}
