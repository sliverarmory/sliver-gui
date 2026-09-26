import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

test("Beacons fills the catalog with live timing and opens the beacon async workspace", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacons-table-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const screenshotDirectory = join(repositoryRoot, "artifacts", "e2e", "beacons-table");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(screenshotDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(savedConfigDirectory, "beacons-table-e2e-operator.cfg"),
    fakeOperatorConfig(),
    { mode: 0o600 },
  );

  let application: ElectronApplication | undefined;
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
        "--beacons-table-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(2000, 950));
    await page.getByRole("dialog", { name: "Saved configurations" }).getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    for (const width of [1440, 1024]) {
      await nativeWindow.evaluate((window, nextWidth) => window.setSize(nextWidth, 768), width);
      await page.waitForFunction((expectedWidth) => (
        globalThis as unknown as { innerWidth: number }
      ).innerWidth === expectedWidth, width);
      await assertTargetCatalogScrollLayout(page, "Sessions", join(screenshotDirectory, `sessions-scrolled-${width}.png`));
    }
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
    for (const width of [1440, 1024]) {
      await nativeWindow.evaluate((window, nextWidth) => window.setSize(nextWidth, 768), width);
      await page.waitForFunction((expectedWidth) => (
        globalThis as unknown as { innerWidth: number }
      ).innerWidth === expectedWidth, width);
      await assertTargetCatalogScrollLayout(page, "Beacons", join(screenshotDirectory, `beacons-scrolled-${width}.png`));
    }
    await nativeWindow.evaluate((window) => window.setSize(2000, 950));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 2000);

    const catalog = page.locator('.targets-page[data-presentation="catalog"]');
    const inventoryFrame = catalog.locator('[aria-labelledby="target-inventory-heading"]').locator("..");
    const table = page.getByRole("grid", { name: "Sliver beacons", exact: true });
    const row = table.getByRole("row").filter({ hasText: "m1-beacon" });
    await row.getByRole("button", { name: "Interact with m1-beacon", exact: true }).waitFor();
    for (const name of ["Last check-in", "Next check-in", "Interval / jitter", "Tasks"]) {
      await table.getByRole("columnheader", { name, exact: true }).waitFor();
    }
    assert.equal(await inventoryFrame.getByRole("complementary").count(), 0, "the beacon catalog must omit the detail sidebar");

    for (const width of [2000, 1440]) {
      await nativeWindow.evaluate((window, nextWidth) => window.setSize(nextWidth, 950), width);
      await page.waitForFunction((expectedWidth) => (
        globalThis as unknown as { innerWidth: number }
      ).innerWidth === expectedWidth, width);
      await assertCatalogWidth(page, width);
    }

    const nextCheckinColumnIndex = await table.getByRole("columnheader", { name: "Next check-in", exact: true }).evaluate((header) => {
      const ariaIndex = header.getAttribute("aria-colindex");
      if (ariaIndex) return Number(ariaIndex);
      return Array.from(header.parentElement!.querySelectorAll('[role="columnheader"]')).indexOf(header) + 1;
    });
    const nextCheckinCell = row.locator('[role="gridcell"], [role="rowheader"]').nth(nextCheckinColumnIndex - 1);
    const initialCountdown = await nextCheckinCell.innerText();
    assert.match(initialCountdown, /^In /u, "the next check-in cell must lead with a realtime countdown");
    await page.waitForFunction(({ columnIndex, initial }) => {
      const documentObject = (globalThis as unknown as {
        document: {
          querySelector(selector: string): {
            querySelectorAll(selector: string): ArrayLike<{
              textContent: string | null;
              querySelectorAll(selector: string): ArrayLike<{ innerText: string }>;
            }>;
          } | null;
        };
      }).document;
      const grid = documentObject.querySelector('[role="grid"][aria-label="Sliver beacons"]');
      const beaconRow = Array.from(grid?.querySelectorAll('[role="row"]') ?? [])
        .find((candidate) => candidate.textContent?.includes("m1-beacon"));
      const cell = beaconRow?.querySelectorAll('[role="gridcell"], [role="rowheader"]')[columnIndex - 1];
      return cell !== undefined && cell.innerText !== initial;
    }, { columnIndex: nextCheckinColumnIndex, initial: initialCountdown }, { timeout: 5_000 });
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacons-table.png") });
    await assertResponsiveStatus(page, screenshotDirectory);

    await row.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByText("Beacons", { exact: true }).waitFor();
    await breadcrumbs.getByText("m1-beacon", { exact: true }).waitFor();
    const workspaceNavigation = page.locator('header[aria-label="Beacon workspace navigation"]');
    await workspaceNavigation.getByRole("button", { name: "Back to live beacons", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Async task workspace", exact: true }).count(), 0, "the beacon workspace must use compact breadcrumbs instead of a large header");
    await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
    assert.equal(await table.count(), 0, "the beacon interaction must replace the catalog");
    assert.equal(await page.getByRole("region", { name: "Managed Shells", exact: true }).count(), 0);
    await assertBeaconWorkspaceHeader(application, page, screenshotDirectory, "beacon-header", 960);
    await assertBeaconBreadcrumbSwitching(application, page, screenshotDirectory);
    await assertBeaconPopoutSwitching(application, page, screenshotDirectory, rendererErrors);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-interaction.png") });

    await page.getByRole("button", { name: "Back to live beacons", exact: true }).click();
    await table.getByRole("button", { name: "Interact with m1-beacon", exact: true }).waitFor();
    await table.getByRole("button", { name: "Interact with m2-beacon", exact: true }).waitFor();
    assert.equal(await inventoryFrame.getByRole("complementary").count(), 0, "returning from Interact must keep the catalog sidebar absent");
    assert.equal(await breadcrumbs.count(), 0);
    await assertCatalogWidth(page, 1440);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertTargetCatalogScrollLayout(
  page: Page,
  label: "Sessions" | "Beacons",
  screenshotPath: string,
): Promise<void> {
  const catalog = page.locator('.targets-page[data-presentation="catalog"]');
  const header = catalog.locator("header.targets-page__header");
  const content = catalog.getByRole("region", { name: `${label} content`, exact: true });
  const inventory = content.locator('[aria-labelledby="target-inventory-heading"]');
  await content.waitFor();
  assert.equal(await content.getAttribute("data-slot"), "scroll-shadow", `${label} content must use HeroUI ScrollShadow`);
  assert.equal(await content.getAttribute("data-orientation"), "vertical");
  assert.equal(await content.locator("header.targets-page__header").count(), 0, `${label} header must sit outside the scrollport`);
  await content.getByRole("heading", { name: "All target operations", exact: true }).waitFor();
  await content.getByRole("heading", { name: "Operator presence", exact: true }).waitFor();

  const fixedElements = [
    header.locator(".eyebrow"),
    header.getByRole("heading", { name: label, exact: true }),
    header.locator("p"),
    header.getByText(new RegExp(`^\\d+ ${label.toLowerCase()}$`, "u")),
    header.getByText(/^\d+ online operators$/u),
    header.getByRole("button", { name: "Maintenance", exact: true }),
  ];
  await content.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await catalog.locator('[aria-label="' + label + ' content"][data-bottom-scroll="true"]').waitFor();
  const before = await Promise.all(fixedElements.map((element) => element.boundingBox()));
  const inventoryBefore = await inventory.boundingBox();
  const contentBounds = await content.boundingBox();
  assert.ok(before.every(Boolean) && inventoryBefore && contentBounds, `${label} layout must be measurable`);
  assert.ok(before.every((bounds) => bounds!.y + bounds!.height <= contentBounds.y + 1),
    `${label} header must remain above the scrolling content`);
  const top = await content.evaluate((element) => ({
    overflow: element.scrollHeight > element.clientHeight,
    mask: element.ownerDocument.defaultView!.getComputedStyle(element).maskImage,
  }));
  assert.equal(top.overflow, true, `${label} fixture must overflow the actual window viewport`);
  assert.match(top.mask, /linear-gradient/u, `${label} content must fade at the bottom before scrolling`);
  try {
    const scrollTop = await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
      return element.scrollTop;
    });
    assert.ok(scrollTop > 0, `${label} content must scroll`);
    await catalog.locator('[aria-label="' + label + ' content"][data-top-scroll="true"]').waitFor();
    const mask = await content.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).maskImage);
    assert.match(mask, /linear-gradient/u, `${label} content must fade beneath the fixed header after scrolling`);
    assert.notEqual(mask, top.mask, `${label} fade must change to reflect the scrolled edge`);
    const after = await Promise.all(fixedElements.map((element) => element.boundingBox()));
    for (let index = 0; index < fixedElements.length; index += 1) {
      assert.equal(await fixedElements[index]!.isVisible(), true, `${label} header element ${index} must remain visible`);
      assert.ok(after[index] && Math.abs(after[index]!.y - before[index]!.y) <= 1,
        `${label} header element ${index} must stay fixed while the content scrolls`);
    }
    const inventoryAfter = await inventory.boundingBox();
    assert.ok(inventoryAfter && Math.abs(inventoryBefore.y - inventoryAfter.y - scrollTop) <= 1,
      `${label} inventory must move with the scrolling content`);
    assert.equal(await page.locator(".app-content").evaluate((element) => element.scrollTop), 0,
      `${label} body must scroll independently of the surrounding app content`);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
  } finally {
    await content.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
  }
}

async function assertBeaconBreadcrumbSwitching(
  application: ElectronApplication,
  page: Page,
  screenshotDirectory: string,
): Promise<void> {
  const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
  const trigger = breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true });
  const menu = page.getByRole("menu", { name: "Beacons, switch beacon", exact: true });
  const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
  await queue.getByText("No tasks queued", { exact: true }).waitFor();

  await trigger.click();
  const current = menu.getByRole("menuitemradio", { name: /m1-beacon/u });
  await current.waitFor();
  assert.equal(await current.getAttribute("aria-checked"), "true", "the active beacon must be selected in the breadcrumb menu");
  await current.getByText("m1-beacon — Current", { exact: true }).waitFor();
  await menu.getByRole("menuitemradio", { name: /m2-beacon/u }).waitFor();
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-breadcrumb-menu.png") });
  const beforeCurrent = await application.evaluate(() => [...globalThis.__SLIVER_GUI_E2E_STATE__.methods]);
  await current.click();
  await menu.waitFor({ state: "hidden" });
  await breadcrumbs.getByText("m1-beacon", { exact: true }).waitFor();
  assert.deepEqual(await application.evaluate(() => [...globalThis.__SLIVER_GUI_E2E_STATE__.methods]), beforeCurrent,
    "choosing the current beacon must leave the backend selection untouched");

  await trigger.click();
  await menu.getByRole("menuitemradio", { name: /m2-beacon/u }).click();
  await breadcrumbs.getByText("m2-beacon", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "m2-beacon", exact: true }).waitFor();
  await queue.getByText("No tasks queued", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "m1-beacon", exact: true }).count(), 0,
    "switching must replace the beacon detail as well as the breadcrumb");

  await trigger.click();
  const secondCurrent = menu.getByRole("menuitemradio", { name: /m2-beacon/u });
  await secondCurrent.waitFor();
  assert.equal(await secondCurrent.getAttribute("aria-checked"), "true");
  await secondCurrent.getByText("m2-beacon — Current", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });

  // Queue only against the isolated fake adapter and confirm the exact beacon
  // identity follows the breadcrumb selection into the async task workspace.
  await application.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  await page.getByRole("button", { name: "Queue task", exact: true }).click();
  await queue.getByText("Pending", { exact: true }).waitFor();
  const queuedTasks = await application.evaluate(() => [...globalThis.__SLIVER_GUI_E2E_STATE__.tasks]);
  assert.equal(queuedTasks.length, 1);
  assert.equal(queuedTasks[0]?.beaconId, "m2_beacon", "task submission must use the newly selected beacon");
  assert.equal(queuedTasks[0]?.state, "pending");
  await page.getByText("Waiting for the beacon", { exact: true }).waitFor();

  await trigger.click();
  await menu.getByRole("menuitemradio", { name: /m1-beacon/u }).click();
  await breadcrumbs.getByText("m1-beacon", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
  await queue.getByText("No tasks queued", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Select a task", exact: true }).waitFor();
  assert.equal(await queue.getByText(queuedTasks[0]!.id, { exact: true }).count(), 0,
    "switching back must clear the other beacon's task queue and completion selection");
}

async function assertBeaconPopoutSwitching(
  application: ElectronApplication,
  sourcePage: Page,
  screenshotDirectory: string,
  rendererErrors: string[],
): Promise<void> {
  const observeWindow = (candidate: Page): void => {
    candidate.on("pageerror", (error) => rendererErrors.push(error.message));
  };
  application.on("window", observeWindow);
  let popout: Page | undefined;
  try {
    [popout] = await Promise.all([
      application.waitForEvent("window", { timeout: 15_000 }),
      sourcePage.getByRole("button", { name: "Pop out interaction", exact: true }).click(),
    ]);
    popout.setDefaultTimeout(20_000);
    await popout.locator('[aria-label="Dedicated interaction window"]').waitFor();
    const breadcrumbs = popout.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByText("m1-beacon", { exact: true }).waitFor();
    await popout.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    const nativeWindow = await application.browserWindow(popout);
    assert.equal(await nativeWindow.evaluate((window) => window.getTitle()), "Interact — m1-beacon");
    await assertBeaconWorkspaceHeader(application, popout, screenshotDirectory, "beacon-popout-header", 840);

    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    const menu = popout.getByRole("menu", { name: "Beacons, switch beacon", exact: true });
    await menu.getByRole("menuitemradio", { name: /m2-beacon/u }).click();
    await breadcrumbs.getByText("m2-beacon", { exact: true }).waitFor();
    await popout.getByRole("heading", { name: "m2-beacon", exact: true }).waitFor();
    assert.equal(await nativeWindow.evaluate((window) => window.getTitle()), "Interact — m2-beacon",
      "switching the popout beacon must update its native window title");
    await popout.getByRole("grid", { name: "Beacon task queue", exact: true }).getByText("Pending", { exact: true }).waitFor();
    await sourcePage.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true })
      .getByText("m1-beacon", { exact: true }).waitFor();
    await sourcePage.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    assert.equal(await sourcePage.getByRole("heading", { name: "m2-beacon", exact: true }).count(), 0,
      "retargeting the popout must leave the main window on its original beacon");
    assert.equal(await popout.getByRole("button", { name: "Pop out interaction", exact: true }).count(), 0,
      "the popout must keep its beacon selector without offering another popout");
    await popout.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-popout-switch.png") });
  } finally {
    application.off("window", observeWindow);
    await popout?.close().catch(() => undefined);
    await sourcePage.bringToFront();
  }
}

async function assertBeaconWorkspaceHeader(
  application: ElectronApplication,
  page: Page,
  screenshotDirectory: string,
  screenshotPrefix: string,
  narrowWidth: number,
): Promise<void> {
  const summary = page.locator('header[aria-label="Beacon summary"]');
  const trigger = summary.getByRole("button", { name: "Beacon details", exact: true });
  const details = page.getByRole("complementary", { name: "Beacon details", exact: true });
  await summary.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
  await summary.getByText("On time", { exact: true }).waitFor();
  await summary.getByText("e2e-user on m1-beacon-host", { exact: true }).waitFor();
  await summary.getByText("m1_beacon", { exact: true }).waitFor();
  for (const [label, value] of [["Platform", "darwin/arm64"], ["Process", "41002"]] as const) {
    const field = summary.getByText(label, { exact: true }).locator("..");
    assert.equal(await field.locator("dd").innerText(), value);
  }
  const checkin = summary.getByText("Last check-in", { exact: true }).locator("..");
  assert.match(await checkin.locator("dd").innerText(), /\d{1,2}:\d{2}/u,
    "the beacon summary must show its reported last check-in time");
  const nextCheckin = summary.getByText("Next check-in", { exact: true }).locator("..").locator("dd");
  const initialCountdown = await nextCheckin.innerText();
  assert.match(initialCountdown, /^\d/u, "the beacon header must show a realtime countdown without an In prefix");
  assert.match((await nextCheckin.getAttribute("title")) ?? "", /\d{1,2}:\d{2}/u,
    "the beacon header countdown must retain the next check-in timestamp on hover");
  await page.waitForFunction((initial) => {
    const documentObject = (globalThis as unknown as {
      document: {
        querySelectorAll(selector: string): ArrayLike<{
          querySelector(selector: string): { textContent: string | null } | null;
        }>;
      };
    }).document;
    const field = Array.from(documentObject.querySelectorAll('header[aria-label="Beacon summary"] dl > div'))
      .find((candidate) => candidate.querySelector("dt")?.textContent === "Next check-in");
    const countdown = field?.querySelector("dd")?.textContent?.trim();
    return countdown !== undefined && countdown !== initial;
  }, initialCountdown, { timeout: 5_000 });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false", "beacon details must start collapsed");
  assert.equal(await details.isVisible(), false);
  await assertBeaconHeaderLayout(page);
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `${screenshotPrefix}.png`) });
  await summary.screenshot({ animations: "disabled", path: join(screenshotDirectory, `${screenshotPrefix}-summary.png`) });

  await trigger.click();
  await details.waitFor();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  await details.getByText("Transport", { exact: true }).waitFor();
  await details.getByRole("switch", { name: "Watch active beacon", exact: true }).waitFor();
  await details.getByRole("button", { name: "Kill target", exact: true }).waitFor();
  await details.getByRole("button", { name: "Remove beacon", exact: true }).waitFor();
  await page.getByRole("button", { name: "Queue task", exact: true }).waitFor();
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `${screenshotPrefix}-expanded.png`) });
  await trigger.click();
  await details.waitFor({ state: "hidden" });
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");

  const nativeWindow = await application.browserWindow(page);
  const originalSize = await nativeWindow.evaluate((window) => window.getSize());
  try {
    await nativeWindow.evaluate((window, width) => window.setSize(width, 768), narrowWidth);
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, narrowWidth);
    await assertBeaconHeaderLayout(page);
    const overflow = await summary.evaluate((header) => {
      const bounds = header.getBoundingClientRect();
      return {
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
        outsideChildren: Array.from(header.querySelectorAll("h1, p, dt, dd, button") as ArrayLike<typeof header>)
          .filter((child) => {
            const childBounds = child.getBoundingClientRect();
            return childBounds.left < bounds.left - 1 || childBounds.right > bounds.right + 1;
          }).map((child) => child.textContent ?? child.getAttribute("aria-label")),
      };
    });
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1 && overflow.outsideChildren.length === 0,
      `the beacon summary must fit the narrow viewport: ${JSON.stringify(overflow)}`);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `${screenshotPrefix}-narrow.png`) });
  } finally {
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, originalSize[0]);
  }
}

async function assertBeaconHeaderLayout(page: Page): Promise<void> {
  const layout = await page.locator('header[aria-label="Beacon summary"]').evaluate((header) => {
    const summaryBounds = header.parentElement!.getBoundingClientRect();
    const container = header.parentElement!.parentElement!;
    const containerBounds = container.getBoundingClientRect();
    const style = container.ownerDocument.defaultView!.getComputedStyle(container);
    const taskBounds = container.querySelector('[aria-labelledby="beacon-command-heading"]')!.getBoundingClientRect();
    return {
      summary: { left: summaryBounds.left, right: summaryBounds.right, bottom: summaryBounds.bottom },
      content: {
        left: containerBounds.left + container.clientLeft + Number.parseFloat(style.paddingLeft),
        right: containerBounds.left + container.clientLeft + container.clientWidth - Number.parseFloat(style.paddingRight),
      },
      taskTop: taskBounds.top,
    };
  });
  assert.ok(Math.abs(layout.summary.left - layout.content.left) <= 1 &&
    Math.abs(layout.summary.right - layout.content.right) <= 1,
  `the beacon summary must fill the workspace width: ${JSON.stringify(layout)}`);
  assert.ok(layout.summary.bottom <= layout.taskTop,
    "the beacon summary must sit above the task workspace");
}

async function assertResponsiveStatus(page: Page, screenshotDirectory: string): Promise<void> {
  const table = page.getByRole("grid", { name: "Sliver beacons", exact: true });
  const row = table.getByRole("row").filter({ hasText: "m1-beacon" });
  const badge = row.locator(".target-status-cell__badge");
  await badge.waitFor({ state: "attached" });
  const statusLabel = (await badge.textContent())!.trim();
  const savedStyles = await table.evaluate((grid) => {
    const headers = Array.from(grid.querySelectorAll('[role="columnheader"]') as ArrayLike<typeof grid>);
    const statusIndex = headers.findIndex((header) => header.textContent?.trim() === "Status");
    const widths = headers.map((header) => header.getBoundingClientRect().width);
    return {
      grid: grid.getAttribute("style"),
      gridWidth: grid.getBoundingClientRect().width,
      statusIndex,
      widths,
      cells: Array.from(grid.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="rowheader"]') as ArrayLike<typeof grid>)
        .map((cell) => cell.getAttribute("style")),
    };
  });
  const setStatusWidth = async (columnWidth: number): Promise<void> => {
    await table.evaluate((grid, { original, width: nextWidth }) => {
      // Fix the actual table columns at their measured widths, then vary
      // Status to exercise the same available-space constraint as zooming.
      const statusWidth = original.widths[original.statusIndex]!;
      grid.style.setProperty("table-layout", "fixed", "important");
      grid.style.setProperty("min-width", "0", "important");
      grid.style.setProperty("width", `${original.gridWidth - statusWidth + nextWidth}px`, "important");
      for (const gridRow of grid.querySelectorAll('[role="row"]')) {
        const cells = Array.from(gridRow.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="rowheader"]'));
        cells.forEach((cell, index) => {
          const style = (cell as typeof grid).style;
          const width = index === original.statusIndex ? nextWidth : original.widths[index]!;
          style.setProperty("width", `${width}px`, "important");
          style.setProperty("min-width", "0", "important");
          style.setProperty("max-width", `${width}px`, "important");
          if (index === original.statusIndex) {
            style.setProperty("padding-inline", "12px", "important");
            style.setProperty("overflow", "hidden", "important");
          }
        });
      }
    }, { original: savedStyles, width: columnWidth });
  };
  try {
    await setStatusWidth(180);
    await badge.waitFor({ state: "visible" });
    assert.equal(await row.getByRole("img", { name: statusLabel, exact: true }).count(), 0, "a wide column must show the full status badge");

    await setStatusWidth(52);
    const dot = row.getByRole("img", { name: statusLabel, exact: true });
    await dot.waitFor({ state: "visible" });
    assert.equal(await dot.getAttribute("data-color"), "success", "compact On time status must retain its success color");
    assert.equal(await dot.getAttribute("title"), statusLabel, "the dot must expose its full status on hover");
    assert.equal(await badge.isVisible(), false, "the full badge must hide when it would not fit");
    const measurement = await badge.evaluate((element) => {
      const view = element.ownerDocument.defaultView!;
      return {
        whiteSpace: view.getComputedStyle(element).whiteSpace,
        badgeWidth: element.getBoundingClientRect().width,
        availableWidth: element.parentElement!.getBoundingClientRect().width,
      };
    });
    assert.equal(measurement.whiteSpace, "nowrap", "status text must never wrap");
    assert.ok(measurement.badgeWidth > measurement.availableWidth, "the dot must be caused by the available cell width");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacons-status-compact.png") });

    await setStatusWidth(180);
    await badge.waitFor({ state: "visible" });
    assert.equal(await row.getByRole("img", { name: statusLabel, exact: true }).count(), 0, "widening the column must restore the full status badge");
  } finally {
    await table.evaluate((grid, original) => {
      if (original.grid === null) grid.removeAttribute("style");
      else grid.setAttribute("style", original.grid);
      Array.from(grid.querySelectorAll('[role="columnheader"], [role="gridcell"], [role="rowheader"]') as ArrayLike<typeof grid>)
        .forEach((cell, index) => {
          const style = original.cells[index];
          if (style === null || style === undefined) cell.removeAttribute("style");
          else cell.setAttribute("style", style);
        });
    }, savedStyles);
  }
}

async function assertCatalogWidth(page: Page, viewportWidth: number): Promise<void> {
  const layout = await page.locator('.targets-page[data-presentation="catalog"]').evaluate((catalog) => {
    const view = catalog.ownerDocument.defaultView!;
    const content = (element: typeof catalog) => {
      const bounds = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);
      return {
        left: bounds.left + element.clientLeft + Number.parseFloat(style.paddingLeft),
        width: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      };
    };
    const inventoryBounds = catalog.querySelector('[aria-labelledby="target-inventory-heading"]')!.getBoundingClientRect();
    const catalogBounds = catalog.getBoundingClientRect();
    return {
      available: content(catalog.parentElement!),
      catalog: { left: catalogBounds.left, width: catalogBounds.width },
      inventoryAvailable: content(catalog.querySelector(".targets-page__viewport")!),
      inventory: { left: inventoryBounds.left, width: inventoryBounds.width },
    };
  });
  const expectedWidth = Math.min(layout.available.width, 1440);
  const expectedLeft = layout.available.left + (layout.available.width - expectedWidth) / 2;
  assert.ok(Math.abs(layout.catalog.left - expectedLeft) <= 1 &&
    Math.abs(layout.catalog.width - expectedWidth) <= 1,
  `Beacons must use the centered catalog width at ${viewportWidth}px: ${JSON.stringify(layout)}`);
  assert.ok(Math.abs(layout.inventory.left - layout.inventoryAvailable.left) <= 1 &&
    Math.abs(layout.inventory.width - layout.inventoryAvailable.width) <= 1,
  `Beacons table must fill the scrollport width at ${viewportWidth}px: ${JSON.stringify(layout)}`);
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "beacons-table-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_BEACONS_CA_DO_NOT_RENDER",
    certificate: "FAKE_BEACONS_CERT_DO_NOT_RENDER",
    private_key: "FAKE_BEACONS_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
