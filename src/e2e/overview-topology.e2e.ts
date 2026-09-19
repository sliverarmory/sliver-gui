import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const SESSION_MENU_LABELS = ["Interact", "Interact in new window", "Rename", "Close Session", "Kill Session"] as const;
const SESSION_HOSTS = ["overview-relay-a", "overview-relay-b", "overview-relay-c", "overview-deepest", "overview-branch"] as const;
const OPERATORS = ["overview-fixture", "overview-online-observer", "overview-offline-observer"] as const;
const RELAY = "Sessionless relay";
const BUILDERS = ["overview-builder-linux", "overview-builder-windows"] as const;
const CRACKSTATION_IDS = ["8fd48f35-c2c2-4d62-8584-8cd274486301", "8fd48f35-c2c2-4d62-8584-8cd274486302"] as const;

test("Overview renders passive operators, services, and a nested relay hierarchy without target actions", {
  timeout: 90_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-overview-topology-e2e-"));
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
      operator: "overview-fixture",
      lhost: "127.0.0.1",
      lport: 31337,
      ca_certificate: "FAKE_OVERVIEW_CA",
      certificate: "FAKE_OVERVIEW_CERT",
      private_key: "FAKE_OVERVIEW_KEY",
      token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
    }), { mode: 0o600 });

    // All inventory is seeded inside fake-main. No remote server, target,
    // listener, tunnel, console, or target operation is started by this journey.
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(temporaryRoot, "saved")}`,
        `--managed-config-directory=${join(temporaryRoot, "managed")}`,
        `--user-data-directory=${join(temporaryRoot, "user-data")}`,
        `--console-client-root-directory=${join(temporaryRoot, "client")}`,
        "--overview-pivot-fixture",
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await useDarkTheme(page);
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const snapshot = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot();
      return snapshot.pivotTopology?.status === "ready"
        && snapshot.domains.sessions.status === "ready"
        && snapshot.domains.operators.status === "ready"
        && snapshot.infrastructureServices?.builders.status === "ready"
        && snapshot.infrastructureServices.crackstations.status === "ready";
    });
    const snapshot = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
    assert.equal(snapshot.pivotTopology?.entries.length, 6);
    assert.equal(snapshot.sessions.length, 5);
    assert.equal(snapshot.operators.length, 3);
    assert.equal(snapshot.targetContext.selectableTargets.length, 5);
    assert.equal(snapshot.targetContext.selectableTargets.some((target) => target.id === "103"), false,
      "the sessionless relay must never acquire a selectable target reference");
    const builders = snapshot.infrastructureServices!.builders.items;
    const crackstations = snapshot.infrastructureServices!.crackstations.items;
    assert.deepEqual(builders.map((builder) => builder.id).sort(), [...BUILDERS].sort());
    assert.deepEqual(crackstations.map((station) => station.id).sort(), [...CRACKSTATION_IDS].sort());
    assert.equal(new Set(crackstations.map((station) => station.name)).size, 1,
      "distinct crackstation host identities must remain separate even when their display names match");

    for (const hostname of SESSION_HOSTS) await nodeByLabel(page, hostname).waitFor();
    await nodeByLabel(page, RELAY).waitFor();
    for (const name of OPERATORS) await nodeByLabel(page, name).waitFor();
    assert.equal(await nodeByLabel(page, "overview-offline-observer").getAttribute("data-status"), "inactive");
    assert.equal(await nodeByLabel(page, "overview-online-observer").getAttribute("data-status"), "healthy");
    for (const id of BUILDERS) await serviceNode(page, "external-builder", id).waitFor();
    for (const id of CRACKSTATION_IDS) await serviceNode(page, "crackstation", id).waitFor();
    assert.equal(await nodeByLabel(page, "overview-crackstation").count(), 2);
    assert.equal(await page.getByTestId("topology-node").count(), 15);
    await page.locator('[data-slot="toast"]').filter({ hasText: "Connected" }).waitFor({ state: "hidden" });
    await fitGraph(page);

    const expectedHops = new Map([
      ["101", [snapshot.connection.server!, "overview-relay-a"]],
      ["102", ["overview-relay-a", "overview-relay-b"]],
      ["103", ["overview-relay-b", RELAY]],
      ["104", [RELAY, "overview-relay-c"]],
      ["105", ["overview-relay-c", "overview-deepest"]],
      ["106", ["overview-relay-b", "overview-branch"]],
    ]);
    const renderedEdges = await edgeTestIds(page);
    const hopEdges = renderedEdges.filter((id) => decodeEdgeId(id).includes("/pivot-hop/"));
    assert.equal(hopEdges.length, expectedHops.size);
    for (const [peerId, expected] of expectedHops) {
      const testId = hopEdges.find((id) => decodeEdgeId(id).endsWith(`/pivot-hop/${peerId}`));
      assert.ok(testId, `the observed link to peer ${peerId} must be rendered`);
      assert.deepEqual(await inspectEdge(page, testId), expected,
        "each rendered edge must preserve its observed direct parent without a server shortcut");
    }
    const operatorEdges = renderedEdges.filter((id) => decodeEdgeId(id).includes("/operator-presence/"));
    assert.equal(operatorEdges.length, 3);
    for (const testId of operatorEdges) {
      const [from, to] = await inspectEdge(page, testId);
      assert.ok(OPERATORS.some((name) => name === from));
      assert.equal(to, snapshot.connection.server);
      assert.equal(await inspectorProperty(page, "State"), "unknown",
        "operator presence must not imply measured network traffic");
    }
    const serviceEdges = renderedEdges.filter((id) => /\/(?:external-builder-registration|crackstation-connection)\//u.test(decodeEdgeId(id)));
    assert.equal(serviceEdges.length, 4);
    for (const testId of serviceEdges) {
      const [from, to] = await inspectEdge(page, testId);
      assert.ok([...BUILDERS, "overview-crackstation"].some((name) => name === from));
      assert.equal(to, snapshot.connection.server);
      assert.equal(await inspectorProperty(page, "State"), "unknown",
        "registered infrastructure must not imply measured traffic or active work");
    }
    assert.equal(renderedEdges.length, expectedHops.size + operatorEdges.length + serviceEdges.length + 1,
      "only observed hops, service and operator associations, and this client's server link belong in the graph");
    await closeInspector(page);
    await fitGraph(page);

    for (const [kind, entries] of [["external-builder", builders], ["crackstation", crackstations]] as const) {
      for (const service of entries) {
        const node = serviceNode(page, kind, service.id);
        await node.click();
        assert.equal(await inspectorProperty(page, kind === "external-builder" ? "Builder name" : "Host UUID"), service.id);
        assert.equal(await inspectorProperty(page, "Operating system"), service.os);
        assert.equal(await inspectorProperty(page, "Architecture"), service.arch);
        assert.equal(await inspectorProperty(page, "Reported operator"), service.operatorName);
        assert.equal(await inspectorProperty(page, "Status"), kind === "external-builder" ? "Registered" : "Connected");
        if (service.version) assert.equal(await inspectorProperty(page, "Version"), service.version);
        assert.equal(await page.getByRole("complementary", { name: "Infrastructure details", exact: true }).getByRole("button").count(), 1,
          "passive service inspectors expose only the close button");
        await closeInspector(page);
        await fitGraph(page);
      }
    }

    const menu = page.getByRole("menu", { name: "Application context menu" });
    for (const hostname of SESSION_HOSTS) {
      await nodeByLabel(page, hostname).click({ button: "right" });
      await menu.waitFor();
      for (const name of SESSION_MENU_LABELS) {
        assert.equal(await menu.getByRole("menuitem", { name, exact: true }).isEnabled(), true);
      }
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
    }
    const graphPage = page;
    const passiveNodes = [
      ...[RELAY, ...OPERATORS].map((label) => nodeByLabel(graphPage, label)),
      ...BUILDERS.map((id) => serviceNode(graphPage, "external-builder", id)),
      ...CRACKSTATION_IDS.map((id) => serviceNode(graphPage, "crackstation", id)),
    ];
    for (const node of passiveNodes) {
      await node.click({ button: "right" });
      await menu.waitFor();
      for (const name of SESSION_MENU_LABELS) {
        assert.equal(await menu.getByRole("menuitem", { name, exact: true }).count(), 0,
          "passive relay, operator, and service metadata must not expose target actions");
      }
      await page.keyboard.press("Escape");
      await menu.waitFor({ state: "hidden" });
    }
    await page.screenshot({ path: join(artifactDirectory, "overview-nested-topology-dark.png"), animations: "disabled" });

    const allNodeLabels = ["This client", snapshot.connection.server!, ...SESSION_HOSTS, RELAY,
      ...OPERATORS, ...BUILDERS, "overview-crackstation", "overview-crackstation"];
    const typeList = await openFilter(page, "Infrastructure type");
    await assertAllOptionsSelected(typeList);
    await toggleFilter(typeList, "All types");
    await expectNodeLabels(page, []);
    await toggleFilter(typeList, "All types");
    await expectNodeLabels(page, allNodeLabels);
    await assertAllOptionsSelected(typeList);
    await toggleFilter(typeList, "All types");
    await toggleFilter(typeList, "External Builder");
    await expectNodeLabels(page, BUILDERS);
    assert.equal(await edgeTestIds(page).then((edges) => edges.length), 0,
      "unselected server and client categories must not return as connection context");
    await toggleFilter(typeList, "Crackstation");
    await expectNodeLabels(page, [...BUILDERS, "overview-crackstation", "overview-crackstation"]);
    assert.equal(await typeList.getByRole("option", { name: "All types", exact: true }).getAttribute("aria-selected"), "false");
    assert.equal(await typeList.getByRole("option", { name: "External Builder", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await typeList.getByRole("option", { name: "Crackstation", exact: true }).getAttribute("aria-selected"), "true");
    await toggleFilter(typeList, "External Builder");
    await expectNodeLabels(page, ["overview-crackstation", "overview-crackstation"]);
    await toggleFilter(typeList, "Operator");
    await expectNodeLabels(page, [...OPERATORS, "overview-crackstation", "overview-crackstation"]);
    await page.screenshot({ path: join(artifactDirectory, "overview-types-multiselect.png"), animations: "disabled" });
    await closeFilter(page, typeList);

    const stateList = await openFilter(page, "Status");
    await assertAllOptionsSelected(stateList);
    await toggleFilter(stateList, "All states");
    await expectNodeLabels(page, []);
    await toggleFilter(stateList, "Healthy");
    await expectNodeLabels(page, ["overview-fixture", "overview-online-observer", "overview-crackstation", "overview-crackstation"]);
    await toggleFilter(stateList, "Inactive");
    await expectNodeLabels(page, [...OPERATORS, "overview-crackstation", "overview-crackstation"]);
    assert.equal(await stateList.getByRole("option", { name: "Healthy", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await stateList.getByRole("option", { name: "Inactive", exact: true }).getAttribute("aria-selected"), "true");
    await page.screenshot({ path: join(artifactDirectory, "overview-states-multiselect.png"), animations: "disabled" });
    await toggleFilter(stateList, "Healthy");
    await expectNodeLabels(page, ["overview-offline-observer"]);
    await closeFilter(page, stateList);

    await page.getByLabel("Search infrastructure", { exact: true }).fill("no-matching-infrastructure");
    await expectNodeLabels(page, []);
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expectNodeLabels(page, allNodeLabels);
    assert.equal(await page.getByLabel("Search infrastructure", { exact: true }).inputValue(), "");
    for (const label of ["Infrastructure type", "Status"]) {
      const list = await openFilter(page, label);
      await assertAllOptionsSelected(list);
      await closeFilter(page, list);
    }
    await page.getByRole("button", { name: "List", exact: true }).click();
    await page.getByTestId("topology-graph").waitFor({ state: "hidden" });
    const resources = page.getByRole("table", { name: "Infrastructure resources", exact: true });
    for (const name of BUILDERS) {
      const row = resources.getByRole("row").filter({ has: page.getByRole("button", { name, exact: true }) });
      await row.waitFor();
      assert.match(await row.innerText(), /External Builder\s+Registered\s+current/u);
    }
    const stationRows = resources.getByRole("row").filter({ has: page.getByRole("button", { name: "overview-crackstation", exact: true }) });
    assert.equal(await stationRows.count(), 2);
    const listedStationIds: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const row = stationRows.nth(index);
      assert.match(await row.innerText(), /Crackstation\s+Connected\s+current/u);
      await row.getByRole("button", { name: "overview-crackstation", exact: true }).click();
      listedStationIds.push(await inspectorProperty(page, "Host UUID"));
    }
    assert.deepEqual(listedStationIds.sort(), [...CRACKSTATION_IDS].sort());
    await closeInspector(page);
    await page.screenshot({ path: join(artifactDirectory, "overview-infrastructure-services-list.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Graph", exact: true }).click();
    await page.getByTestId("topology-graph").waitFor();
    await fitGraph(page);

    await page.getByLabel("Search infrastructure", { exact: true }).fill("overview-deepest");
    await nodeByLabel(page, "overview-branch").waitFor({ state: "hidden" });
    for (const label of ["This client", snapshot.connection.server!, "overview-relay-a", "overview-relay-b", RELAY, "overview-relay-c", "overview-deepest"]) {
      await nodeByLabel(page, label).waitFor();
    }
    assert.equal(await page.getByTestId("topology-node").count(), 7);
    for (const name of OPERATORS) assert.equal(await nodeByLabel(page, name).count(), 0);
    for (const id of BUILDERS) assert.equal(await serviceNode(page, "external-builder", id).count(), 0);
    for (const id of CRACKSTATION_IDS) assert.equal(await serviceNode(page, "crackstation", id).count(), 0);
    await page.getByText("1 matches · connection context included", { exact: true }).waitFor();
    const filteredEdges = await edgeTestIds(page);
    assert.equal(filteredEdges.length, 6);
    assert.equal(filteredEdges.some((id) => decodeEdgeId(id).endsWith("/pivot-hop/106")), false);
    for (const peerId of ["101", "102", "103", "104", "105"]) {
      assert.ok(filteredEdges.some((id) => decodeEdgeId(id).endsWith(`/pivot-hop/${peerId}`)));
    }
    await fitGraph(page);
    const filteredPath = ["This client", snapshot.connection.server!, "overview-relay-a", "overview-relay-b", RELAY, "overview-relay-c", "overview-deepest"];
    for (let index = 1; index < filteredPath.length; index += 1) {
      const from = await nodeByLabel(page, filteredPath[index - 1]!).boundingBox();
      const to = await nodeByLabel(page, filteredPath[index]!).boundingBox();
      assert.ok(from && to && to.x > from.x + from.width,
        "the completed filtered layout must retain each hop in order without overlapping cards");
    }
    await page.screenshot({ path: join(artifactDirectory, "overview-nested-topology-filtered.png"), animations: "disabled" });

    const audit = await application.evaluate(() => ({
      methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
      tasks: globalThis.__SLIVER_GUI_E2E_STATE__.tasks,
      openSessionRequests: globalThis.__SLIVER_GUI_E2E_STATE__.openSessionRequests,
      executionCalls: globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.callCounts,
      consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
      sshSessions: globalThis.__SLIVER_GUI_E2E_STATE__.ssh.length,
      disconnects: globalThis.__SLIVER_GUI_E2E_STATE__.disconnects,
    }));
    const allowedMethods = new Set([
      "connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler",
      "getOperators", "getSessions", "getBeacons", "getPivotGraph", "getExternalBuilders", "getCrackstations",
    ]);
    assert.deepEqual(audit.methods.filter((method) => !allowedMethods.has(method)), []);
    assert.ok(audit.methods.includes("getPivotGraph"));
    assert.ok(audit.methods.includes("getExternalBuilders"));
    assert.ok(audit.methods.includes("getCrackstations"));
    assert.deepEqual(audit.tasks, []);
    assert.deepEqual(audit.openSessionRequests, []);
    assert.deepEqual(audit.executionCalls, {});
    assert.equal(audit.consoles, 0);
    assert.equal(audit.sshSessions, 0);
    assert.equal(audit.disconnects, 0);
    assert.deepEqual(rendererErrors, []);
    assert.doesNotMatch(await page.locator("body").innerText(), /FAKE_[A-Z0-9_]*(?:SECRET|TOKEN|KEY)|secret-path/u);
  } catch (error) {
    testFailed = true;
    testFailure = error;
    if (page && !page.isClosed()) {
      await page.screenshot({ path: join(artifactDirectory, "overview-nested-topology-failure.png"), animations: "disabled" }).catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "Overview topology", 5_000).catch((error) => cleanupFailures.push(error));
    }
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length) {
      const cleanupError = new AggregateError(cleanupFailures, "Overview topology E2E cleanup failed");
      if (testFailed) {
        attachCleanupFailure(testFailure, cleanupError);
        console.error("Failed to clean Overview topology E2E resources", cleanupError);
      } else throw cleanupError;
    }
  }
});

function nodeByLabel(page: Page, label: string): Locator {
  return page.getByTestId("topology-node").filter({ has: page.locator("strong").filter({ hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}$`, "u") }) });
}

function serviceNode(page: Page, kind: "external-builder" | "crackstation", id: string): Locator {
  const suffix = encodeURIComponent(`/${kind}/${encodeURIComponent(id)}`);
  return page.locator(`.react-flow__node[data-id$="${suffix}"]`).getByTestId("topology-node");
}

async function openFilter(page: Page, label: string): Promise<Locator> {
  await page.getByRole("button", { name: new RegExp(label, "u") }).click();
  const list = page.getByRole("listbox", { name: label, exact: true });
  await list.waitFor();
  assert.equal(await list.getAttribute("aria-multiselectable"), "true");
  return list;
}

async function toggleFilter(list: Locator, option: string): Promise<void> {
  await list.getByRole("option", { name: option, exact: true }).click();
  assert.equal(await list.isVisible(), true, "the dropdown must stay open while toggling multiple options");
}

async function assertAllOptionsSelected(list: Locator): Promise<void> {
  for (const option of await list.getByRole("option").all()) {
    assert.equal(await option.getAttribute("aria-selected"), "true", `expected ${await option.innerText()} to be selected`);
  }
}

async function closeFilter(page: Page, list: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
}

async function expectNodeLabels(page: Page, labels: readonly string[]): Promise<void> {
  await page.waitForFunction((expected) => {
    const browser = globalThis as unknown as {
      document: { querySelectorAll: (selector: string) => ArrayLike<{ textContent: string | null }> };
    };
    const actual = Array.from(browser.document.querySelectorAll('[data-testid="topology-node"] strong'), (node) => node.textContent).sort();
    return JSON.stringify(actual) === JSON.stringify(expected);
  }, [...labels].sort());
}

function decodeEdgeId(testId: string): string {
  return decodeURIComponent(testId.slice("rf__edge-".length));
}

async function edgeTestIds(page: Page): Promise<string[]> {
  return page.locator(".react-flow__edge").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-testid")!));
}

async function inspectEdge(page: Page, testId: string): Promise<string[]> {
  await page.getByTestId(testId).press("Enter");
  await page.getByTestId(testId).and(page.locator(".selected")).waitFor();
  await page.getByRole("complementary", { name: "Infrastructure details", exact: true }).getByRole("heading", { name: "Connection details", exact: true }).waitFor();
  return [await inspectorProperty(page, "From"), await inspectorProperty(page, "To")];
}

async function inspectorProperty(page: Page, label: string): Promise<string> {
  return page.getByRole("complementary", { name: "Infrastructure details", exact: true })
    .locator("dl > div").filter({ has: page.getByText(label, { exact: true }) }).locator("dd").innerText();
}

async function closeInspector(page: Page): Promise<void> {
  const inspector = page.getByRole("complementary", { name: "Infrastructure details", exact: true });
  if (await inspector.isVisible()) await inspector.getByRole("button", { name: "Close", exact: true }).click();
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
        commandPaletteShortcut: settings.commandPaletteShortcut, keyboardShortcuts: settings.keyboardShortcuts,
        terminal: settings.terminal,
      },
    });
  });
  assert.ok(updated.ok);
  await page.locator("html.dark").waitFor();
}
