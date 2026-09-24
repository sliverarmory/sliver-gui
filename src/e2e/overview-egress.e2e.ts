import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const SHARED_IP = "198.51.100.10";
const OTHER_IP = "203.0.113.20";
const SESSIONS = ["overview-egress-alpha", "overview-egress-beta", "overview-egress-gamma"] as const;
const BEACON = "overview-egress-beacon";

test("Overview groups passive session and beacon inventory by incoming IP with distinct labeled connections", {
  timeout: 90_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-overview-egress-e2e-"));
  const artifactDirectory = join(repositoryRoot, "artifacts", "overview-e2e");
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let testFailed = false;
  let testFailure: unknown;
  const rendererErrors: string[] = [];

  try {
    await Promise.all([
      ...["saved", "managed", "user-data", "client"].map((name) => mkdir(join(temporaryRoot, name))),
      mkdir(artifactDirectory, { recursive: true }),
    ]);
    await writeFile(join(temporaryRoot, "client", "armories.json"), "[]", { mode: 0o600 });
    await writeFile(join(temporaryRoot, "saved", "overview-fixture.cfg"), JSON.stringify({
      operator: "overview-fixture", lhost: "127.0.0.1", lport: 31337,
      ca_certificate: "FAKE_OVERVIEW_CA", certificate: "FAKE_OVERVIEW_CERT",
      private_key: "FAKE_OVERVIEW_KEY", token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });

    // Inventory is synthetic and in process. This journey exercises only passive
    // rendering, filtering, and inspection; it never starts a remote target.
    application = await electron.launch({
      args: [
        "--enable-sandbox", join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`,
        `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${join(temporaryRoot, "client")}`,
        "--overview-egress-fixture",
      ],
      cwd: repositoryRoot, timeout: 20_000, bypassCSP: false, chromiumSandbox: true,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const electronProcess = application.process();
    context.signal.addEventListener("abort", () => { electronProcess.kill("SIGKILL"); }, { once: true });
    page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || /Content Security Policy|Refused to.*worker/iu.test(message.text())) {
        rendererErrors.push(message.text());
      }
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await useDarkTheme(page);
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const snapshot = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot();
      return snapshot.domains.sessions.status === "ready" && snapshot.domains.beacons.status === "ready";
    });
    const sourceSnapshot = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
    assert.equal(sourceSnapshot.sessions.length, 3);
    assert.equal(sourceSnapshot.beacons.length, 1);
    assert.equal(sourceSnapshot.targetContext.selectableTargets.length, 4);
    for (const label of [...SESSIONS, BEACON, SHARED_IP, OTHER_IP]) await nodeByLabel(page, label).waitFor();
    await page.locator('[data-slot="toast"]').filter({ hasText: "Connected" }).waitFor({ state: "hidden" });
    await fitGraph(page);

    const shared = nodeByLabel(page, SHARED_IP);
    const other = nodeByLabel(page, OTHER_IP);
    assert.match(await shared.innerText(), /Egress IP · 3 nodes/u);
    assert.match(await other.innerText(), /Egress IP · 1 node/u);
    assert.equal(await page.locator(".topology-enclosure").count(), 2,
      "each unique IP must have its own enclosure, regardless of source port or session/beacon kind");
    for (const label of [SESSIONS[0], SESSIONS[1], BEACON]) await assertContained(page, shared, label);
    await assertContained(page, other, SESSIONS[2]);

    const groupedEdges = await egressEdgeIds(page);
    assert.equal(groupedEdges.length, 2, "the server must have one distinct incoming-IP connection per group");
    const sourcePoints = await Promise.all(groupedEdges.map(async (id) => {
      const path = await page!.getByTestId(id).locator(".react-flow__edge-path").getAttribute("d");
      return path?.match(/^M[^A-Za-z]+/u)?.[0];
    }));
    assert.ok(sourcePoints.every(Boolean));
    assert.equal(new Set(sourcePoints).size, 2,
      "connections for distinct incoming IPs must leave the server at separate points");
    const resourceBounds = await Promise.all((await page.locator(".topology-node").all()).map((node) => node.boundingBox()));
    for (const edgeId of groupedEdges) {
      const label = await page.getByTestId(edgeId).locator(".react-flow__edge-text").boundingBox();
      assert.ok(label);
      assert.equal(resourceBounds.some((node) => node && label.x < node.x + node.width
        && label.x + label.width > node.x && label.y < node.y + node.height && label.y + label.height > node.y), false,
      "incoming-IP connection labels must not be obscured by resource cards");
    }
    const destinations = new Set<string>();
    for (const edgeId of groupedEdges) {
      await page.getByTestId(edgeId).press("Enter");
      await page.getByRole("heading", { name: "Connection details", exact: true }).waitFor();
      assert.equal(await inspectorProperty(page, "From"), sourceSnapshot.connection.server);
      const destination = await inspectorProperty(page, "To");
      destinations.add(destination);
      const edgeText: string = (await page.getByTestId(edgeId).textContent()) ?? "";
      assert.ok(edgeText.includes(destination), "the connection label must include its incoming IP");
      assert.match(edgeText, /mTLS/u);
      if (destination === SHARED_IP) assert.match(edgeText, /HTTPS/u);
    }
    assert.deepEqual([...destinations].sort(), [SHARED_IP, OTHER_IP].sort());
    await closeInspector(page);
    await fitGraph(page);
    await shared.locator(".topology-enclosure__heading").click();
    assert.equal(await inspectorProperty(page, "Egress IP"), SHARED_IP);
    assert.equal(await page.getByRole("complementary", { name: "Infrastructure details", exact: true }).getByRole("button").count(), 1,
      "the aggregate inspector must remain passive and expose only its close button");
    await closeInspector(page);
    await fitGraph(page);
    await page.screenshot({ path: join(artifactDirectory, "overview-egress-groups-dark.png"), animations: "disabled" });
    await verifySidebarControls(application, page, groupedEdges[0]!, artifactDirectory);

    const search = page.getByLabel("Search infrastructure", { exact: true });
    await search.fill(SHARED_IP);
    await other.waitFor({ state: "hidden" });
    for (const label of [SESSIONS[0], SESSIONS[1], BEACON]) await nodeByLabel(page, label).waitFor();
    assert.equal(await nodeByLabel(page, SESSIONS[2]).count(), 0);
    assert.equal((await egressEdgeIds(page)).length, 1);
    await search.fill(SESSIONS[1]);
    await nodeByLabel(page, SESSIONS[0]).waitFor({ state: "hidden" });
    await nodeByLabel(page, BEACON).waitFor({ state: "hidden" });
    assert.match(await shared.innerText(), /Egress IP · 1 node/u,
      "search must recompute grouping from the visible inventory without reviving hidden siblings");
    await fitGraph(page);
    await assertContained(page, shared, SESSIONS[1]);
    await page.screenshot({ path: join(artifactDirectory, "overview-egress-search.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await nodeByLabel(page, BEACON).waitFor();
    await page.getByRole("button", { name: /Infrastructure type/u }).click();
    const typeList = page.getByRole("listbox", { name: "Infrastructure type", exact: true });
    await typeList.waitFor();
    // Default excludes offline operators, so first select all, then clear all.
    await typeList.getByRole("option", { name: "All types", exact: true }).click();
    await typeList.getByRole("option", { name: "All types", exact: true }).click();
    await typeList.getByRole("option", { name: "Session", exact: true }).click();
    await page.keyboard.press("Escape");
    await typeList.waitFor({ state: "hidden" });
    await nodeByLabel(page, BEACON).waitFor({ state: "hidden" });
    for (const label of [...SESSIONS, SHARED_IP, OTHER_IP]) await nodeByLabel(page, label).waitFor();
    assert.match(await shared.innerText(), /Egress IP · 2 nodes/u);
    assert.equal(await page.getByTestId("topology-node").count(), 5,
      "session-only filtering retains IP enclosures without restoring the hidden server, beacon, or operator");
    assert.equal((await egressEdgeIds(page)).length, 0, "a hidden server must not leave a dangling group connection");
    await fitGraph(page);
    await page.screenshot({ path: join(artifactDirectory, "overview-egress-sessions-only.png"), animations: "disabled" });

    const finalSnapshot = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
    assert.deepEqual(finalSnapshot.sessions, sourceSnapshot.sessions);
    assert.deepEqual(finalSnapshot.beacons, sourceSnapshot.beacons);
    assert.deepEqual(finalSnapshot.targetContext.selectableTargets, sourceSnapshot.targetContext.selectableTargets);
    const audit = await application.evaluate(() => ({
      methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
      tasks: globalThis.__SLIVER_GUI_E2E_STATE__.tasks,
      openSessionRequests: globalThis.__SLIVER_GUI_E2E_STATE__.openSessionRequests,
      executionCalls: globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.callCounts,
      consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
      sshSessions: globalThis.__SLIVER_GUI_E2E_STATE__.ssh.length,
    }));
    const allowedMethods = new Set([
      "connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler",
      "getOperators", "getSessions", "getBeacons", "getPivotGraph", "getExternalBuilders", "getCrackstations",
    ]);
    assert.deepEqual(audit.methods.filter((method) => !allowedMethods.has(method)), []);
    assert.deepEqual(audit.tasks, []);
    assert.deepEqual(audit.openSessionRequests, []);
    assert.deepEqual(audit.executionCalls, {});
    assert.equal(audit.consoles, 0);
    assert.equal(audit.sshSessions, 0);
    assert.deepEqual(rendererErrors, []);
  } catch (error) {
    testFailed = true;
    testFailure = error;
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifactDirectory, "overview-egress-failure.png"), animations: "disabled" }).catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) await cleanupOwnedApplication(application, "Overview egress", 5_000).catch((error) => cleanupFailures.push(error));
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length) {
      const cleanupError = new AggregateError(cleanupFailures, "Overview egress E2E cleanup failed");
      if (testFailed) attachCleanupFailure(testFailure, cleanupError);
      else throw cleanupError;
    }
  }
});

function nodeByLabel(page: Page, label: string): Locator {
  return page.getByTestId("topology-node").filter({ has: page.locator("strong").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") }) });
}

async function verifySidebarControls(application: ElectronApplication, page: Page, edgeId: string, artifactDirectory: string): Promise<void> {
  const inspector = page.getByRole("complementary", { name: "Infrastructure details", exact: true });
  const disableSidebar = page.getByRole("switch", { name: "Disable sidebar", exact: true });
  assert.equal(await disableSidebar.isChecked(), false, "the graph sidebar must remain enabled by default");
  await changeViewport(page);
  const manuallyChanged = await viewportTransform(page);
  await graphNode(page, SESSIONS[0]).press("Enter");
  await inspector.getByRole("heading", { name: SESSIONS[0], exact: true }).waitFor();
  await waitForGraphPaint(page);
  const automaticallyFitted = await viewportTransform(page);
  assert.notEqual(automaticallyFitted, manuallyChanged,
    "opening the inspector must refit the graph even after a manual viewport change");
  await fitGraph(page);
  assert.equal(await viewportTransform(page), automaticallyFitted,
    "opening the inspector must match Fit view for the resized canvas");
  await assertOutsideInspector(page);
  await page.screenshot({ path: join(artifactDirectory, "overview-egress-inspector-auto-fit.png"), animations: "disabled" });

  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await waitForGraphPaint(page);
  const inspectorViewport = await viewportTransform(page);
  await graphNode(page, SESSIONS[1]).press("Enter");
  await inspector.getByRole("heading", { name: SESSIONS[1], exact: true }).waitFor();
  await waitForGraphPaint(page);
  assert.equal(await viewportTransform(page), inspectorViewport,
    "changing the inspected resource while the sidebar is open must preserve the user's viewport");

  await page.getByText("Disable sidebar", { exact: true }).click();
  assert.equal(await disableSidebar.isChecked(), true);
  await inspector.waitFor({ state: "hidden" });
  assert.equal(await nodeByLabel(page, SESSIONS[1]).getAttribute("data-selected"), "true",
    "disabling the sidebar must preserve the existing graph selection");
  await graphNode(page, SESSIONS[0]).press("Enter");
  assert.equal(await nodeByLabel(page, SESSIONS[0]).getAttribute("data-selected"), "true");
  assert.equal(await inspector.count(), 0, "node selection must not reopen a disabled sidebar");
  await page.getByTestId(edgeId).press("Enter");
  await page.getByTestId(edgeId).and(page.locator(".selected")).waitFor();
  assert.equal(await inspector.count(), 0, "edge selection must not reopen a disabled sidebar");
  await disableSidebar.press("Space");
  assert.equal(await disableSidebar.isChecked(), false);
  await inspector.getByRole("heading", { name: "Connection details", exact: true }).waitFor();
  await waitForGraphPaint(page);
  await assertOutsideInspector(page);
  await disableSidebar.press("Space");
  await inspector.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "List", exact: true }).click();
  const resources = page.getByRole("table", { name: "Infrastructure resources", exact: true });
  await resources.getByRole("button", { name: SESSIONS[0], exact: true }).click();
  await inspector.getByRole("heading", { name: SESSIONS[0], exact: true }).waitFor();
  await page.screenshot({ path: join(artifactDirectory, "overview-egress-list-sidebar.png"), animations: "disabled" });
  await closeInspector(page);
  await page.getByRole("button", { name: "Graph", exact: true }).click();
  await page.getByTestId("topology-graph").waitFor();
  assert.equal(await disableSidebar.isChecked(), true,
    "returning from List must retain the graph sidebar preference");
  await disableSidebar.press("Space");
  await fitGraph(page);

  const nativeWindow = await application.browserWindow(page);
  const originalSize = await nativeWindow.evaluate((window) => window.getSize());
  const originalWidth = await page.evaluate(() => (globalThis as unknown as { innerWidth: number }).innerWidth);
  try {
    await nativeWindow.evaluate((window) => window.setSize(1000, 760));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth <= 1000);
    await fitGraph(page);
    await changeViewport(page);
    await graphNode(page, SHARED_IP).press("Enter");
    await inspector.getByRole("heading", { name: SHARED_IP, exact: true }).waitFor();
    await waitForGraphPaint(page);
    const compactAutomaticFit = await viewportTransform(page);
    await fitGraph(page);
    assert.equal(await viewportTransform(page), compactAutomaticFit,
      "automatic compact-window fitting must match Fit view with the overlaid inspector");
    await assertOutsideInspector(page);
    assert.equal(await page.locator(".overview-toolbar").evaluate((toolbar) => toolbar.scrollWidth <= toolbar.clientWidth), true,
      "the sidebar switch and filters must fit the compact toolbar");
    await page.screenshot({ path: join(artifactDirectory, "overview-egress-compact-inspector.png"), animations: "disabled" });
  } finally {
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    await page.waitForFunction((width) => (globalThis as unknown as { innerWidth: number }).innerWidth === width, originalWidth);
  }
  await closeInspector(page);
  await fitGraph(page);
}

function graphNode(page: Page, label: string): Locator {
  return page.locator(".react-flow__node").filter({ has: nodeByLabel(page, label) });
}

async function viewportTransform(page: Page): Promise<string> {
  return page.locator(".react-flow__viewport").evaluate((element) => element.style.transform);
}

async function waitForGraphPaint(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const browser = globalThis as unknown as { requestAnimationFrame: (callback: () => void) => number };
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => browser.requestAnimationFrame(resolve));
    }
  });
}

async function changeViewport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const bounds = await page.locator(".react-flow__pane").boundingBox();
  assert.ok(bounds);
  await page.mouse.move(bounds.x + 24, bounds.y + 24);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 84, bounds.y + 54, { steps: 5 });
  await page.mouse.up();
  await waitForGraphPaint(page);
}

async function assertOutsideInspector(page: Page): Promise<void> {
  const inspector = await page.getByRole("complementary", { name: "Infrastructure details", exact: true }).boundingBox();
  const graph = await page.getByTestId("topology-graph").boundingBox();
  assert.ok(inspector && graph);
  for (const node of await page.getByTestId("topology-node").all()) {
    const bounds = await node.boundingBox();
    assert.ok(bounds);
    assert.ok(bounds.x >= graph.x - 1 && bounds.x + bounds.width <= inspector.x + 1,
      "fitted graph resources and enclosures must remain within the visible area beside the inspector");
  }
}

async function assertContained(page: Page, group: Locator, label: string): Promise<void> {
  const enclosure = await group.boundingBox();
  const member = await nodeByLabel(page, label).boundingBox();
  assert.ok(enclosure && member);
  assert.ok(member.x >= enclosure.x && member.y >= enclosure.y
    && member.x + member.width <= enclosure.x + enclosure.width + 1
    && member.y + member.height <= enclosure.y + enclosure.height + 1,
  `${label} must remain visibly inside its incoming-IP enclosure`);
}

async function egressEdgeIds(page: Page): Promise<string[]> {
  const ids = await page.locator(".react-flow__edge").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")!));
  return ids.filter((id) => decodeURIComponent(id.slice("rf__edge-".length)).includes("/egress-connection/"));
}

async function inspectorProperty(page: Page, label: string): Promise<string> {
  return page.getByRole("complementary", { name: "Infrastructure details", exact: true })
    .locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd").innerText();
}

async function closeInspector(page: Page): Promise<void> {
  await page.getByRole("complementary", { name: "Infrastructure details", exact: true })
    .getByRole("button", { name: "Close", exact: true }).click();
}

async function fitGraph(page: Page): Promise<void> {
  await page.getByRole("status").filter({ hasText: "Arranging infrastructure" }).waitFor({ state: "hidden" });
  assert.equal(await page.locator('.topology-graph__message[role="alert"]').count(), 0);
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.evaluate(async () => {
    const browser = globalThis as unknown as { requestAnimationFrame: (callback: () => void) => number };
    await new Promise<void>((resolve) => browser.requestAnimationFrame(() => browser.requestAnimationFrame(resolve)));
  });
}

async function useDarkTheme(page: Page): Promise<void> {
  const updated = await page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    const settings = await api.getApplicationSettings();
    return api.updateApplicationSettings({
      expectedRevision: settings.revision,
      settings: {
        theme: "dark", appIcon: settings.appIcon, reduceMotion: settings.reduceMotion,
        reportScreenshotDirectory: settings.reportScreenshotDirectory,
        commandPaletteShortcut: settings.commandPaletteShortcut, keyboardShortcuts: settings.keyboardShortcuts,
        terminal: settings.terminal,
      },
    });
  });
  assert.ok(updated.ok);
  await page.locator("html.dark").waitFor();
}
