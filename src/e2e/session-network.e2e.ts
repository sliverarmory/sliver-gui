import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

test("Session network, process details, and zoom controls", { timeout: 120_000 }, async () => {
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

    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await connections.getByText("sliver-m2-session (41001)", { exact: true }).click({ button: "right" });
    const contextMenu = page.getByRole("menu", { name: "Application context menu", exact: true });
    await contextMenu.getByRole("menuitem", { name: "Go to Process", exact: true }).click();
    const processes = page.getByRole("region", { name: "Processes", exact: true });
    const processFilter = processes.getByRole("searchbox", { name: "Filter processes", exact: true });
    const processesGrid = processes.getByRole("grid", { name: "Session processes", exact: true });
    const processRows = processesGrid.locator('[data-slot="table-body"] [data-slot="table-row"]');
    await processes.getByText("Loaded 1 of 1 processes matching “pid:41001”", { exact: true }).waitFor();
    assert.equal(await page.getByRole("tab", { name: "Processes", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await processFilter.inputValue(), "pid:41001");
    assert.equal(await processRows.count(), 1, "Go to Process must select the exact PID without its children");
    await processesGrid.getByText("sliver-m2-session", { exact: true }).waitFor();
    const processDetail = processes.getByRole("region", { name: "sliver-m2-session", exact: true });
    await processDetail.getByText("PID 41001", { exact: true }).waitFor();
    await processDetail.getByText("/usr/local/bin/sliver-m2-session --m2-e2e", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "session-network-go-to-process.png") });

    await processFilter.fill("owner:e2e-user");
    await processes.getByText("Loaded 100 of 108 processes matching “owner:e2e-user” · bounded", { exact: true }).waitFor();
    assert.equal(await processRows.count(), 100, "owner search must match the fixture's owner across the bounded inventory");
    await processFilter.fill("owner:sliver-m2-session");
    await processesGrid.getByText("No processes match this search.", { exact: true }).waitFor();
    assert.equal(await processRows.count(), 0, "owner search must not match the executable name");

    await processFilter.fill("owner:e2e-user");
    await processes.getByText("Loaded 100 of 108 processes matching “owner:e2e-user” · bounded", { exact: true }).waitFor();
    const processGridPane = processes.locator(".session-processes-grid");
    const processGridScroll = processGridPane.locator('[data-slot="table-scroll-container"]');
    const detailsPane = processes.locator(".session-process-details");
    const closeDetails = processes.getByRole("button", { name: "Close process details", exact: true });
    const selectedProcessName = processesGrid.getByText("sliver-m2-session", { exact: true });
    await selectedProcessName.click();
    await processDetail.waitFor();
    for (const [width, height] of [[1440, 950], [1024, 768]] as const) {
      await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
      await page.waitForFunction((expectedWidth) => (globalThis as unknown as { innerWidth: number }).innerWidth === expectedWidth, width);
      await processGridScroll.evaluate((element) => { element.scrollTop = 0; element.scrollLeft = 0; });
      await assertProcessSplitLayout(page, processGridPane, processGridScroll, detailsPane, closeDetails, width);
      const resizeHandle = processes.getByLabel("Resize process details", { exact: true });
      const handleBounds = await resizeHandle.boundingBox();
      const detailsWidth = (await detailsPane.boundingBox())?.width;
      const scrolledPosition = await processGridScroll.evaluate((element) => element.scrollTop);
      assert.ok(handleBounds && detailsWidth);
      const handleX = handleBounds.x + handleBounds.width / 2;
      const handleY = handleBounds.y + handleBounds.height / 2;
      await page.mouse.move(handleX, handleY);
      await page.mouse.down();
      await page.mouse.move(handleX - 48, handleY, { steps: 5 });
      await page.mouse.up();
      assert.ok(((await detailsPane.boundingBox())?.width ?? 0) > detailsWidth + 1,
        "dragging the split handle must resize process details");
      assert.equal(await processGridScroll.evaluate((element) => element.scrollTop), scrolledPosition,
        "resizing process details must preserve the table scroll position");
      const splitWidth = (await processGridPane.boundingBox())?.width;
      assert.ok(splitWidth);
      await closeDetails.click();
      await detailsPane.waitFor({ state: "hidden" });
      const fullWidth = (await processGridPane.boundingBox())?.width;
      assert.ok(fullWidth && fullWidth > splitWidth + 100, "closing process details must restore the table width");
      const closedScroll = await processGridScroll.evaluate((element) => ({
        position: element.scrollTop,
        maximum: element.scrollHeight - element.clientHeight,
      }));
      assert.ok(Math.abs(closedScroll.position - Math.min(scrolledPosition, closedScroll.maximum)) <= 1,
        "closing process details must preserve table scrolling within the new viewport bounds");
      await processGridScroll.evaluate((element) => { element.scrollTop = 0; element.scrollLeft = 0; });
      await selectedProcessName.click();
      await processDetail.getByText("PID 41001", { exact: true }).waitFor();
      await page.screenshot({ animations: "disabled", path: join(artifactDirectory, `session-processes-split-${width}.png`) });
    }

    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    const zoomRegion = page.getByRole("group", { name: "Window zoom", exact: true });
    const resetZoom = zoomRegion.getByRole("button", { name: "Reset zoom", exact: true });
    for (const zoom of [1, 0.9, 1.1]) {
      await nativeWindow.evaluate((window, factor) => window.webContents.setZoomFactor(factor), zoom);
      await page.waitForFunction((expectedWidth) => Math.abs((globalThis as unknown as { innerWidth: number }).innerWidth - expectedWidth) <= 2, 1440 / zoom);
      await zoomRegion.getByText(`Zoom ${Math.round(zoom * 100)}%`, { exact: true }).waitFor();
      await processGridScroll.evaluate((element) => { element.scrollTop = 600; });
      await detailsPane.locator(":scope > .overflow-auto").evaluate((element) => { element.scrollTop = 80; });
      const gridBounds = await processGridPane.boundingBox();
      assert.ok(gridBounds);
      const viewport = await page.evaluate(() => {
        const windowObject = globalThis as unknown as { innerWidth: number; innerHeight: number };
        return { width: windowObject.innerWidth, height: windowObject.innerHeight };
      });
      for (const point of [
        { x: Math.round(gridBounds.x + 35), y: Math.round(gridBounds.y + 65) },
        { x: Math.round(gridBounds.x + Math.min(gridBounds.width - 30, 320)), y: Math.round(gridBounds.y + 130) },
      ]) {
        await page.mouse.click(point.x, point.y, { button: "right" });
        await assertContextMenuPosition(contextMenu, point, viewport, false, zoom);
        await page.keyboard.press("Escape");
        await contextMenu.waitFor({ state: "hidden" });
      }
      const corner = { x: viewport.width - 10, y: viewport.height - 10 };
      await page.mouse.click(corner.x, corner.y, { button: "right" });
      await assertContextMenuPosition(contextMenu, corner, viewport, true, zoom);
      await page.screenshot({ animations: "disabled", path: join(artifactDirectory, `session-context-menu-corner-${zoom}.png`) });
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
    }
    await resetZoom.click();
    await zoomRegion.getByText("Zoom 100%", { exact: true }).waitFor();
    assert.equal(await nativeWindow.evaluate((window) => window.webContents.getZoomFactor()), 1,
      "the sidebar Reset zoom control must restore the native window zoom");

    const invokedZoomIn = await application.evaluate(({ BrowserWindow, Menu }, url) => {
      const focusedWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url);
      if (!focusedWindow) return false;
      focusedWindow.focus();
      focusedWindow.webContents.focus();
      const pendingMenus = [Menu.getApplicationMenu()];
      while (pendingMenus.length > 0) {
        for (const item of pendingMenus.pop()?.items ?? []) {
          if (item.role?.toLowerCase() === "zoomin") {
            // Electron's native role wrapper takes the focused webContents as its third argument.
            Reflect.apply(item.click, item, [{}, focusedWindow, focusedWindow.webContents]);
            return true;
          }
          if (item.submenu) pendingMenus.push(item.submenu);
        }
      }
      return false;
    }, page.url());
    assert.equal(invokedZoomIn, true, "the application View menu must expose native Zoom In");
    let menuZoom = 1;
    const zoomDeadline = Date.now() + 5_000;
    while (menuZoom <= 1 && Date.now() < zoomDeadline) {
      menuZoom = await nativeWindow.evaluate((window) => window.webContents.getZoomFactor());
      if (menuZoom <= 1) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(menuZoom > 1, "the View menu Zoom In role must change native zoom");
    await zoomRegion.getByText(`Zoom ${Math.round(menuZoom * 100)}%`, { exact: true }).waitFor();
    await resetZoom.click();
    await zoomRegion.getByText("Zoom 100%", { exact: true }).waitFor();
    assert.equal(await nativeWindow.evaluate((window) => window.webContents.getZoomFactor()), 1);

    await page.getByRole("button", { name: /^Current server:/i }).click();
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
    await nativeWindow.evaluate((window) => window.webContents.setZoomFactor(0.9));
    await zoomRegion.getByText("Zoom 90%", { exact: true }).waitFor();
    for (const theme of ["Dark", "Light"]) {
      await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: theme, exact: true }).click();
      await page.locator(`html.${theme.toLowerCase()}[data-theme='${theme.toLowerCase()}']`).waitFor();
      await settleVisualTransitions(zoomRegion);
      const screenshot = await nativeWindow.evaluate(async (window) =>
        (await window.webContents.capturePage()).toPNG().toString("base64"));
      await writeFile(join(artifactDirectory, `sidebar-window-zoom-90-${theme.toLowerCase()}.png`), Buffer.from(screenshot, "base64"));
    }
    await nativeWindow.evaluate((window) => window.setSize(1024, 768));
    await page.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Expand sidebar", exact: true }).waitFor();
    await zoomRegion.getByText("Zoom 90%", { exact: true }).waitFor();
    await settleVisualTransitions(zoomRegion);
    await page.waitForFunction((element) => element !== null &&
      Math.abs(element.getBoundingClientRect().width - 56) <= 1, await page.locator(".app-sidebar:visible").elementHandle());
    const collapsedBounds = await zoomRegion.boundingBox();
    const resetBounds = await resetZoom.boundingBox();
    assert.ok(collapsedBounds && resetBounds && resetBounds.x >= collapsedBounds.x &&
      resetBounds.x + resetBounds.width <= collapsedBounds.x + collapsedBounds.width + 1,
    "the zoom reset control must fit within the collapsed sidebar");
    const collapsedScreenshot = await nativeWindow.evaluate(async (window) =>
      (await window.webContents.capturePage()).toPNG().toString("base64"));
    await writeFile(join(artifactDirectory, "sidebar-window-zoom-90-collapsed.png"), Buffer.from(collapsedScreenshot, "base64"));
    await resetZoom.click();
    await zoomRegion.getByText("Zoom 100%", { exact: true }).waitFor();
    assert.equal(await resetZoom.isEnabled(), false, "Reset zoom must be disabled at 100%");

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

async function settleVisualTransitions(locator: Locator): Promise<void> {
  await locator.evaluate(async (element) => {
    const view = element.ownerDocument.defaultView;
    if (!view) return;
    await new Promise<void>((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())));
    const animations = element.ownerDocument.getAnimations() as Array<{
      effect: { getComputedTiming(): { iterations: number } } | null;
      finished: Promise<unknown>;
    }>;
    await Promise.all(animations
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function assertContextMenuPosition(
  menu: Locator,
  point: { x: number; y: number },
  viewport: { width: number; height: number },
  corner: boolean,
  zoom: number,
): Promise<void> {
  await menu.waitFor();
  // Wait for the popover's entry animation before measuring its final anchor.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const bounds = await menu.boundingBox();
  assert.ok(bounds);
  assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 &&
    bounds.y + bounds.height <= viewport.height + 1, `context menus must remain inside the viewport at ${zoom} zoom`);
  const anchorX = corner ? bounds.x + bounds.width : bounds.x;
  const anchorY = corner ? bounds.y + bounds.height : bounds.y;
  assert.ok(Math.abs(anchorX - point.x) <= 4 && Math.abs(anchorY - point.y) <= 4,
    `context menu anchor (${anchorX}, ${anchorY}) must follow pointer (${point.x}, ${point.y}) at ${zoom} zoom`);
}

async function assertProcessSplitLayout(
  page: Page,
  grid: Locator,
  gridScroll: Locator,
  details: Locator,
  close: Locator,
  width: number,
): Promise<void> {
  const viewportHeight = await page.evaluate(() => (globalThis as unknown as { innerHeight: number }).innerHeight);
  const gridBounds = await grid.boundingBox();
  const detailBounds = await details.boundingBox();
  const closeBounds = await close.boundingBox();
  assert.ok(gridBounds && detailBounds && closeBounds);
  assert.ok(gridBounds.height >= 100, `the process table must retain at least 100px of visible inventory at ${width}px`);
  assert.ok(gridBounds.x + gridBounds.width <= detailBounds.x + 1,
    `process details must sit beside the table at ${width}px`);
  for (const bounds of [gridBounds, detailBounds, closeBounds]) {
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 &&
      bounds.y >= 0 && bounds.y + bounds.height <= viewportHeight + 1,
    `the process split and close control must fit in the viewport at ${width}px`);
  }

  const maximumScroll = await gridScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  assert.ok(maximumScroll > 0, `all 100 processes must scroll inside the table at ${width}px`);
  assert.deepEqual(await details.boundingBox(), detailBounds,
    `scrolling the process inventory must not move details at ${width}px`);
  assert.deepEqual(await close.boundingBox(), closeBounds,
    `scrolling the process inventory must not move its close control at ${width}px`);
  const detailScroll = details.locator(":scope > .overflow-auto");
  const detailScrollRange = await detailScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { maximum: element.scrollHeight - element.clientHeight, actual: element.scrollTop };
  });
  if (detailScrollRange.maximum > 0) {
    assert.ok(detailScrollRange.actual > 0, `overflowing process details must scroll independently at ${width}px`);
    assert.deepEqual(await close.boundingBox(), closeBounds,
      `scrolling process details must leave their close control visible at ${width}px`);
    assert.equal(await gridScroll.evaluate((element) => element.scrollTop), maximumScroll,
      `scrolling process details must not move the inventory at ${width}px`);
  }
  await detailScroll.evaluate((element) => { element.scrollTop = 0; });
  const sessionPage = page.locator('.app-content:has(> .session-workspace[data-presentation="embedded"])');
  const pageOverflow = await sessionPage.evaluate((element) => element.scrollHeight - element.clientHeight);
  assert.ok(pageOverflow <= 1, `the Processes view must not scroll the outer workspace at ${width}px`);
}

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
