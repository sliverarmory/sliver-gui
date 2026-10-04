import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { NetworkForwardingAPI } from "../shared/network-forwarding-contracts.js";

const SOCKS_PASSWORD = "NETWORK_E2E_PASSWORD_DO_NOT_RENDER";

test("native Network window manages port forwards, reverse forwards, and SOCKS5", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-network-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "network-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
  const rendererErrors: string[] = [];
  const stylePolicyViolations: string[] = [];
  const observedRenderers = new Set<Page>();
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
    const observe = (page: Page): void => {
      if (observedRenderers.has(page)) return;
      observedRenderers.add(page);
      observeRenderer(page, rendererErrors, stylePolicyViolations);
    };
    application.on("window", observe);
    for (const page of application.windows()) observe(page);

    const workspace = await application.firstWindow();
    workspace.setDefaultTimeout(15_000);
    await workspace.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await workspace.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await workspace.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await workspace.locator('[aria-label="Jobs & listeners"]:visible').click();
    await workspace.getByRole("heading", { name: "Jobs & listeners" }).waitFor();

    const initialWindowCount = liveWindowCount(application);
    await invokeApplicationMenuItem(application, workspace, "network.socks5");
    const network = await networkPage(application);
    network.setDefaultTimeout(15_000);
    await assertNetworkWindowBoundary(application, network);
    assert.equal(liveWindowCount(application), initialWindowCount + 1);
    const socksTab = network.getByRole("tab", { name: /^SOCKS5\b/ });
    await waitForSelectedTab(socksTab);
    await assertNetworkStickyTabs(application, network, artifactDirectory);

    const networkWindowId = await nativeNetworkWindowId(application);
    await invokeApplicationMenuItem(application, workspace, "network.port-forward");
    const portForwardTab = network.getByRole("tab", { name: /^Port Forward\b/ });
    await waitForSelectedTab(portForwardTab);
    assert.equal(await nativeNetworkWindowId(application), networkWindowId);
    assert.equal(network.url(), "sliver://app/index.html?surface=network");
    assert.equal(await network.getByRole("button", { name: /m1-session.*Session/iu }).count(), 0);
    await network.getByRole("button", { name: "Add port forward", exact: true }).click();
    const portDialog = network.getByRole("dialog", { name: "Port Forward", exact: true });
    await portDialog.waitFor();
    await portDialog.getByRole("button", { name: /m1-session.*Session/iu }).waitFor();
    assert.equal(await portDialog.getByLabel("Local bind port", { exact: true }).inputValue(), "0");
    await network.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "network-add-modal.png"),
    });
    await portDialog.getByRole("button", { name: "Start", exact: true }).click();
    await waitForFakeMethodCount(application, "startPortForward", 1);
    await network.getByText("127.0.0.1:45550", { exact: true }).first().waitFor();

    await invokeApplicationMenuItem(application, network, "network.socks5");
    await waitForSelectedTab(socksTab);
    assert.equal(await nativeNetworkWindowId(application), networkWindowId);
    assert.equal(liveWindowCount(application), initialWindowCount + 1);
    assert.equal(network.url(), "sliver://app/index.html?surface=network");
    await network.getByRole("button", { name: "Add SOCKS5 proxy", exact: true }).click();
    const socksDialog = network.getByRole("dialog", { name: "SOCKS5 Proxy", exact: true });
    await socksDialog.waitFor();
    const authenticationSwitch = socksDialog.getByRole("switch", { name: /Require authentication/u });
    await socksDialog.getByText("Require authentication", { exact: true }).click();
    assert.equal(await authenticationSwitch.isChecked(), true);
    await socksDialog.getByLabel("Username", { exact: true }).fill("network-e2e");
    await socksDialog.getByLabel("Password", { exact: true }).fill(SOCKS_PASSWORD);
    await socksDialog.getByRole("button", { name: "Start", exact: true }).click();
    await waitForFakeMethodCount(application, "startSocks5Proxy", 1);
    await network.getByText("Username + password", { exact: true }).waitFor();
    assert.equal((await network.locator("body").innerText()).includes(SOCKS_PASSWORD), false);

    await invokeApplicationMenuItem(application, network, "network.reverse-port-forward");
    const reverseTab = network.getByRole("tab", { name: /^Reverse Port Forward\b/ });
    await waitForSelectedTab(reverseTab);
    assert.equal(await nativeNetworkWindowId(application), networkWindowId);
    assert.equal(network.url(), "sliver://app/index.html?surface=network");
    await network.getByRole("button", { name: "Add reverse port forward", exact: true }).click();
    const reverseDialog = network.getByRole("dialog", { name: "Reverse Port Forward", exact: true });
    await reverseDialog.waitFor();
    await reverseDialog.getByLabel("Destination port", { exact: true }).fill("8443");
    await reverseDialog.getByRole("button", { name: "Start", exact: true }).click();
    await waitForFakeMethodCount(application, "startReversePortForward", 1);
    await network.getByText("#7001", { exact: true }).waitFor();
    await network.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "network-window.png"),
    });

    const reverseStop = network.getByRole("button", { name: /^Stop reverse port forward\b/ });
    const reverseStopAppearance = await reverseStop.evaluate((button) => ({
      dangerSoft: button.classList.contains("button--danger-soft"),
      pinnedCell: button.closest("td")?.hasAttribute("data-pinned") ?? false,
    }));
    assert.deepEqual(reverseStopAppearance, { dangerSoft: true, pinnedCell: false });
    await reverseStop.click();
    await network.getByRole("alertdialog", { name: "Stop reverse listener #7001?", exact: true })
      .getByRole("button", { name: "Stop forward", exact: true }).click();
    await waitForFakeMethodCount(application, "stopReversePortForward", 1);

    await invokeApplicationMenuItem(application, network, "network.socks5");
    await waitForSelectedTab(socksTab);
    await network.getByRole("button", { name: /^Stop SOCKS5 proxy\b/ }).click();
    await network.getByRole("alertdialog", { name: "Stop SOCKS5 proxy?", exact: true })
      .getByRole("button", { name: "Stop forward", exact: true }).click();
    await waitForFakeMethodCount(application, "stopSocks5Proxy", 1);

    await invokeApplicationMenuItem(application, network, "network.port-forward");
    await waitForSelectedTab(portForwardTab);
    await network.getByRole("button", { name: /^Stop port forward\b/ }).click();
    await network.getByRole("alertdialog", { name: "Stop port forward?", exact: true })
      .getByRole("button", { name: "Stop forward", exact: true }).click();
    await waitForFakeMethodCount(application, "stopPortForward", 1);

    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(stylePolicyViolations, []);
  } catch (error) {
    if (application) {
      const diagnostics = await Promise.all(application.windows().map(async (page) => ({
        url: page.url(),
        body: (await page.locator("body").innerText().catch(() => "<unavailable>")).slice(0, 4_000),
      })));
      const methods = await readFakeMethods(application).catch(() => []);
      process.stderr.write(`Network E2E diagnostics: ${JSON.stringify({ diagnostics, methods: methods.slice(-40) })}\n`);
    }
    throw error;
  } finally {
    await application?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertNetworkStickyTabs(
  application: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page);
  const originalBounds = await nativeWindow.evaluate((window) => ({
    size: window.getSize(),
    minimumSize: window.getMinimumSize(),
  }));
  const originalViewport = await page.evaluate(() => {
    const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
    return { width: viewport.innerWidth, height: viewport.innerHeight };
  });
  const content = page.locator("main.network-window-scroll");
  const tabs = page.locator(".network-window-tabs");
  const navigation = page.locator(".network-window-tabs__nav");
  const header = content.locator("header").first();

  try {
    await nativeWindow.evaluate((window) => {
      window.setMinimumSize(640, 240);
      window.setContentSize(800, 300);
    });
    await page.waitForFunction(() => {
      const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return viewport.innerWidth === 800 && viewport.innerHeight === 300;
    });

    for (const [index, name] of [/^Port Forward\b/u, /^Reverse Port Forward\b/u, /^SOCKS5\b/u].entries()) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      await waitForSelectedTab(tab);
      await content.evaluate((element) => { element.scrollTop = 0; });
      const panel = page.getByRole("tabpanel");
      const [viewport, initialNavigation, initialPanel, tabsBounds] = await Promise.all([
        content.boundingBox(), navigation.boundingBox(), panel.boundingBox(), tabs.boundingBox(),
      ]);
      assert.ok(viewport && initialNavigation && initialPanel && tabsBounds);
      assert.ok(initialNavigation.y > viewport.y, "Network tabs must initially follow the page header");
      assert.ok(Math.abs(initialNavigation.width - tabsBounds.width) < 1,
        "the sticky Network navigation must cover the full content width");
      assert.equal(await content.evaluate((element) => element.scrollHeight > element.clientHeight), true,
        "the compact Network window must exercise vertical scrolling");

      await content.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const [pinnedNavigation, scrolledHeader, scrolledPanel, scrolledRefresh] = await Promise.all([
        navigation.boundingBox(), header.boundingBox(), panel.boundingBox(),
        page.getByRole("button", { name: "Refresh", exact: true }).boundingBox(),
      ]);
      assert.ok(pinnedNavigation && Math.abs(pinnedNavigation.y - viewport.y) < 1,
        "Network tabs must stick to the top of the scrolling viewport");
      assert.ok(scrolledHeader && scrolledHeader.y + scrolledHeader.height <= viewport.y,
        "the Network heading, status, and description must scroll away");
      assert.ok(scrolledRefresh && scrolledRefresh.y + scrolledRefresh.height <= viewport.y,
        "Refresh must scroll away with the Network header");
      assert.ok(scrolledPanel && scrolledPanel.y < initialPanel.y &&
        scrolledPanel.y < pinnedNavigation.y + pinnedNavigation.height,
      "Network panel content must pass beneath the pinned tabs");
      const appearance = await navigation.evaluate((element) => {
        const view = globalThis as unknown as {
          getComputedStyle(element: unknown, pseudo?: string): {
            backgroundColor: string; backgroundImage: string; pointerEvents: string;
          };
        };
        const shadow = view.getComputedStyle(element, "::after");
        return {
          background: view.getComputedStyle(element).backgroundColor,
          viewportBackground: view.getComputedStyle(element.closest("main")).backgroundColor,
          shadow: shadow.backgroundImage,
          shadowPointerEvents: shadow.pointerEvents,
        };
      });
      assert.equal(appearance.background, appearance.viewportBackground,
        "the sticky navigation must use the opaque viewport background");
      assert.notEqual(appearance.background, "rgba(0, 0, 0, 0)");
      assert.match(appearance.shadow, /linear-gradient/u,
        "content passing below the tabs must have a scroll shadow");
      assert.equal(appearance.shadowPointerEvents, "none", "the shadow must not intercept content interactions");
      if (index === 0) {
        await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "network-sticky-tabs.png") });
      }

      await content.evaluate((element) => { element.scrollTop = 0; });
      const restoredNavigation = await navigation.boundingBox();
      assert.ok(restoredNavigation && Math.abs(restoredNavigation.y - initialNavigation.y) < 1,
        "scrolling back must restore Network tabs below the header");
    }
  } finally {
    await content.evaluate((element) => { element.scrollTop = 0; });
    await nativeWindow.evaluate((window, bounds) => {
      window.setMinimumSize(bounds.minimumSize[0]!, bounds.minimumSize[1]!);
      window.setSize(bounds.size[0]!, bounds.size[1]!);
    }, originalBounds);
    await page.waitForFunction((original) => {
      const viewport = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return viewport.innerWidth === original.width && viewport.innerHeight === original.height;
    }, originalViewport);
  }
}

function observeRenderer(page: Page, errors: string[], styleViolations: string[]): void {
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (/Content Security Policy/iu.test(text) && /style-src/iu.test(text)) styleViolations.push(text);
  });
}

async function assertNetworkWindowBoundary(
  application: ElectronApplication,
  page: Page,
): Promise<void> {
  await page.getByRole("heading", { name: "Network", exact: true }).waitFor();
  const bridge = await page.evaluate(async () => {
    const browser = globalThis as unknown as {
      network?: NetworkForwardingAPI;
      sliver?: unknown;
      cloudDeployment?: unknown;
      ssh?: unknown;
      applicationContextMenu?: unknown;
    };
    const context = await browser.network?.getContext();
    return {
      frozen: Object.isFrozen(browser.network),
      keys: Object.keys(browser.network ?? {}).sort(),
      sessionKeys: context?.ok && context.value?.sessions.items[0]
        ? Object.keys(context.value.sessions.items[0].session).sort()
        : [],
      sliver: typeof browser.sliver,
      cloudDeployment: typeof browser.cloudDeployment,
      ssh: typeof browser.ssh,
      applicationContextMenu: {
        frozen: Object.isFrozen(browser.applicationContextMenu),
        keys: Object.keys(browser.applicationContextMenu ?? {}).sort(),
      },
    };
  });
  assert.equal(bridge.frozen, true);
  assert.equal(bridge.sliver, "undefined");
  assert.equal(bridge.cloudDeployment, "undefined");
  assert.equal(bridge.ssh, "undefined");
  assert.deepEqual(bridge.applicationContextMenu, {
    frozen: true,
    keys: ["executeAction", "onMenuRequested", "setOpen"],
  });
  assert.deepEqual(bridge.sessionKeys, ["arch", "hostname", "id", "liveness", "name", "os", "username"]);
  assert.deepEqual(bridge.keys, [
    "getApplicationSettings",
    "getContext",
    "list",
    "onApplicationSettingsChanged",
    "onChanged",
    "onNavigationRequested",
    "startPortForward",
    "startReversePortForward",
    "startSocks5Proxy",
    "stopPortForward",
    "stopReversePortForward",
    "stopSocks5Proxy",
  ]);

  const native = await application.evaluate(({ BrowserWindow, session }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try {
        return new URL(candidate.webContents.getURL()).search === "?surface=network";
      } catch {
        return false;
      }
    });
    if (!window) throw new Error("Expected one native Network window");
    const preferences = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      url: window.webContents.getURL(),
      title: window.getTitle(),
      parent: window.getParentWindow()?.id ?? null,
      modal: window.isModal(),
      visible: window.isVisible(),
      dedicatedSession: window.webContents.session === session.fromPartition("sliver-network"),
      defaultSession: window.webContents.session === session.defaultSession,
      contextIsolation: preferences["contextIsolation"],
      nodeIntegration: preferences["nodeIntegration"],
      sandbox: preferences["sandbox"],
      webSecurity: preferences["webSecurity"],
    };
  });
  assert.equal(native.url, "sliver://app/index.html?surface=network");
  assert.equal(native.title, "Network");
  assert.equal(native.parent, null);
  assert.equal(native.modal, false);
  assert.equal(native.visible, true);
  assert.equal(native.dedicatedSession, true);
  assert.equal(native.defaultSession, false);
  assert.equal(native.contextIsolation, true);
  assert.equal(native.nodeIntegration, false);
  assert.equal(native.sandbox, true);
  assert.equal(native.webSecurity, true);
}

async function networkPage(application: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = application.windows().find((candidate) => {
      if (candidate.isClosed()) return false;
      try {
        return candidate.url() === "sliver://app/index.html?surface=network";
      } catch {
        return false;
      }
    });
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the Network renderer surface");
}

async function nativeNetworkWindowId(application: ElectronApplication): Promise<number> {
  return application.evaluate(({ BrowserWindow }) => {
    const matches = BrowserWindow.getAllWindows().filter((candidate) => {
      try {
        return candidate.webContents.getURL() === "sliver://app/index.html?surface=network";
      } catch {
        return false;
      }
    });
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(`Expected one Network BrowserWindow, received ${matches.length}`);
    }
    return matches[0].id;
  });
}

async function invokeApplicationMenuItem(
  application: ElectronApplication,
  focusedPage: Page,
  itemId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const invoked = await application.evaluate(({ BrowserWindow, Menu }, input) => {
      const focused = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === input.focusedUrl,
      );
      if (!focused) return false;
      focused.show();
      focused.focus();
      focused.webContents.focus();
      const item = Menu.getApplicationMenu()?.getMenuItemById(input.itemId);
      if (!item || typeof item.click !== "function") return false;
      Reflect.apply(item.click, item, [item, focused, {}]);
      return true;
    }, { focusedUrl: focusedPage.url(), itemId });
    if (invoked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected native application menu item ${itemId}`);
}

async function waitForSelectedTab(tab: ReturnType<Page["getByRole"]>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await tab.getAttribute("aria-selected") === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the native Network tab request");
}

function liveWindowCount(application: ElectronApplication): number {
  return application.windows().filter((candidate) => !candidate.isClosed()).length;
}

async function readFakeMethods(application: ElectronApplication): Promise<string[]> {
  return application.evaluate(() => [...globalThis.__SLIVER_GUI_E2E_STATE__.methods]);
}

async function waitForFakeMethodCount(
  application: ElectronApplication,
  method: string,
  minimum: number,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  let methods: string[] = [];
  while (Date.now() < deadline) {
    methods = await readFakeMethods(application);
    if (methods.filter((candidate) => candidate === method).length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${method}; recent calls: ${methods.slice(-20).join(", ")}`);
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
