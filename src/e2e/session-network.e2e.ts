import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

test("Network separates interfaces and netstat with opt-in refresh", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-network-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    savedConfigDirectory,
    managedConfigDirectory,
    userDataDirectory,
    consoleClientRootDirectory,
    artifactDirectory,
  ].map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(savedConfigDirectory, "network-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  const rendererErrors: string[] = [];
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
        `--console-client-root-directory=${consoleClientRootDirectory}`,
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });

    page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Network", exact: true }).click();

    const network = page.getByRole("region", { name: "Network", exact: true });
    const tabs = network.getByRole("tablist", { name: "Network views", exact: true });
    const interfacesTab = tabs.getByRole("tab", { name: "Interfaces", exact: true });
    const netstatTab = tabs.getByRole("tab", { name: "Netstat", exact: true });
    const connections = network.getByRole("grid", { name: "Session network connections", exact: true });
    await network.getByText("en0", { exact: true }).waitFor();
    await waitForFakeMethodCount(application, "netstatSession", 1);
    assert.equal(await interfacesTab.getAttribute("aria-selected"), "true");
    assert.equal(await netstatTab.getAttribute("aria-selected"), "false");
    assert.equal(await connections.isVisible(), false, "the Interfaces tab must not show the netstat grid");
    const tabBounds = await tabs.boundingBox();
    assert.ok(tabBounds && tabBounds.height <= 30, "the Network tab bar must use compact sizing");

    const initialCounts = await networkMethodCounts(application);
    await network.getByRole("button", { name: "Refresh interfaces", exact: true }).click();
    await waitForFakeMethodCount(application, "ifconfigSession", initialCounts.interfaces + 1);
    await network.getByText("en0", { exact: true }).waitFor();
    assert.deepEqual(await networkMethodCounts(application), {
      interfaces: initialCounts.interfaces + 1,
      netstat: initialCounts.netstat,
    }, "manual interface refresh must only refresh interfaces");
    await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "session-network-interfaces.png") });

    await netstatTab.click();
    await connections.getByText("ESTABLISHED", { exact: true }).waitFor();
    assert.equal(await network.getByText("en0", { exact: true }).isVisible(), false,
      "the Netstat tab must not show interface cards");
    const autoRefresh = network.getByRole("switch", { name: "Auto-refresh", exact: true });
    const autoRefreshField = network.locator('[data-slot="switch"]');
    const autoRefreshTrack = autoRefreshField.locator('[data-slot="switch-control"]');
    const interval = network.getByRole("textbox", { name: "Refresh interval (seconds)", exact: true });
    const filter = network.getByRole("searchbox", { name: "Filter netstat connections", exact: true });
    const matchingQuery = "SvM2sSn eStB";
    assert.equal(await autoRefresh.isChecked(), false, "auto-refresh must start disabled");
    assert.equal(await interval.inputValue(), "10");
    await filter.fill(matchingQuery);
    await connections.getByText("ESTABLISHED", { exact: true }).waitFor();
    await filter.fill("no-matching-connection");
    await connections.getByText("ESTABLISHED", { exact: true }).waitFor({ state: "hidden" });
    await filter.fill("");
    await connections.getByText("ESTABLISHED", { exact: true }).waitFor();
    await interval.fill("1");
    await interval.press("Tab");
    assert.equal(await interval.inputValue(), "1");

    const beforeDisabledWait = await networkMethodCounts(application);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.deepEqual(await networkMethodCounts(application), beforeDisabledWait,
      "changing the interval must not enable polling");
    await network.getByRole("button", { name: "Refresh netstat", exact: true }).click();
    await waitForFakeMethodCount(application, "netstatSession", beforeDisabledWait.netstat + 1);
    assert.deepEqual(await networkMethodCounts(application), {
      interfaces: beforeDisabledWait.interfaces,
      netstat: beforeDisabledWait.netstat + 1,
    }, "manual netstat refresh must only refresh connections");

    await autoRefreshTrack.click();
    assert.equal(await autoRefresh.isChecked(), true);
    await filter.fill(matchingQuery);
    await waitForFakeMethodCount(application, "netstatSession", beforeDisabledWait.netstat + 3);
    assert.equal(await filter.inputValue(), matchingQuery, "automatic refresh must retain the filter");
    await connections.getByText("ESTABLISHED", { exact: true }).waitFor();
    assert.equal((await networkMethodCounts(application)).interfaces, beforeDisabledWait.interfaces,
      "automatic netstat refresh must not refresh interfaces");
    await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "session-network-netstat.png") });

    await interfacesTab.click();
    const beforeHiddenWait = await networkMethodCounts(application);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.deepEqual(await networkMethodCounts(application), beforeHiddenWait,
      "auto-refresh must pause while the Interfaces tab is selected");
    await netstatTab.click();
    assert.equal(await autoRefresh.isChecked(), true);
    assert.equal(await filter.inputValue(), matchingQuery, "switching Network tabs must retain the filter");
    await waitForFakeMethodCount(application, "netstatSession", beforeHiddenWait.netstat + 1);
    await autoRefresh.press("Space");
    assert.equal(await autoRefresh.isChecked(), false);
    const beforeStoppedWait = await networkMethodCounts(application);
    await new Promise((resolve) => setTimeout(resolve, 1_250));
    assert.deepEqual(await networkMethodCounts(application), beforeStoppedWait,
      "turning auto-refresh off must stop polling");

    for (const [width, height] of [[1440, 950], [1024, 768]] as const) {
      await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
      await page.waitForFunction((expectedWidth) => (globalThis as unknown as { innerWidth: number }).innerWidth === expectedWidth, width);
      await assertHorizontalLayout(network, [tabs, filter, interval, autoRefreshField], width);
      await assertSwitchLayout(autoRefreshField, width);
      await interfacesTab.click();
      await assertHorizontalLayout(network, [tabs], width);
      await netstatTab.click();
    }

    assert.deepEqual(rendererErrors, [], "the Network views must not emit renderer errors");
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, "session-network-failure.png"),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertHorizontalLayout(network: Locator, controls: Locator[], width: number): Promise<void> {
  const panel = await network.boundingBox();
  assert.ok(panel);
  assert.ok(panel.x >= 0 && panel.x + panel.width <= width + 1,
    `the Network panel must fit horizontally at ${width}px`);
  const overflow = await network.evaluate((element) => element.scrollWidth - element.clientWidth);
  assert.ok(overflow <= 1, `the Network panel must not overflow horizontally at ${width}px`);
  for (const control of controls) {
    const box = await control.boundingBox();
    assert.ok(box);
    assert.ok(box.x >= panel.x && box.x + box.width <= panel.x + panel.width + 1,
      `the Network controls must stay within the panel at ${width}px`);
  }
}

async function assertSwitchLayout(field: Locator, width: number): Promise<void> {
  const label = await field.locator('[data-slot="label"]').boundingBox();
  const track = await field.locator('[data-slot="switch-control"]').boundingBox();
  assert.ok(label && track);
  assert.ok(label.x + label.width <= track.x,
    `the auto-refresh label must appear to the left of its track at ${width}px`);
  assert.ok(Math.abs(label.y + label.height / 2 - track.y - track.height / 2) <= 2,
    `the auto-refresh label and track must remain vertically aligned at ${width}px`);
}

async function networkMethodCounts(application: ElectronApplication): Promise<{ interfaces: number; netstat: number }> {
  return application.evaluate(() => {
    const methods = globalThis.__SLIVER_GUI_E2E_STATE__.methods;
    return {
      interfaces: methods.filter((method) => method === "ifconfigSession").length,
      netstat: methods.filter((method) => method === "netstatSession").length,
    };
  });
}

async function waitForFakeMethodCount(
  application: ElectronApplication,
  method: string,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let latest = 0;
  while (Date.now() < deadline) {
    latest = await application.evaluate((_electron, expectedMethod) =>
      globalThis.__SLIVER_GUI_E2E_STATE__.methods.filter((candidate) => candidate === expectedMethod).length, method);
    if (latest >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${method} call ${minimum}; observed ${latest}`);
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "network-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_NETWORK_CA_DO_NOT_RENDER",
    certificate: "FAKE_NETWORK_CERT_DO_NOT_RENDER",
    private_key: "FAKE_NETWORK_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
