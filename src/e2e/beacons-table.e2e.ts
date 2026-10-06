import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";

test("Beacons fills the catalog with live timing and opens the beacon async workspace", { timeout: 120_000 }, async () => {
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
  await writeBeaconExecutionFixtures(consoleClientRootDirectory);

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
        "--beacon-execution-fixture",
        "--bof-execution-fixture",
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
    await page.getByRole("heading", { name: "Beacon command", exact: true }).waitFor();
    const taskViews = page.getByRole("tablist", { name: "Beacon task views", exact: true });
    await taskViews.waitFor();
    assert.deepEqual((await taskViews.getByRole("tab").allTextContents()).map((label) => label.trim()),
      ["Task output", "Task queue"]);
    assert.equal(await taskViews.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await table.count(), 0, "the beacon interaction must replace the catalog");
    assert.equal(await page.getByRole("region", { name: "Managed Shells", exact: true }).count(), 0);
    await assertBeaconWorkspaceHeader(application, page, screenshotDirectory, "beacon-header", 960);
    await assertBeaconBreadcrumbSwitching(application, page, screenshotDirectory);
    await assertBeaconTaskViews(application, page, screenshotDirectory);
    await assertBeaconPopoutSwitching(application, page, screenshotDirectory, rendererErrors);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-interaction.png") });
    await assertBeaconExecutionCommands(application, page, screenshotDirectory);

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

test("beacon commands bind six management operations to the selected target", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacon-management-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "beacon-management.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
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
        "--beacon-management-denial-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
    await composer.getByRole("heading", { name: "Beacon command", exact: true }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "Manage beacon", exact: true }).count(), 0,
      "management commands must live in the existing beacon command picker");
    assert.equal(await page.locator(".beacon-interaction-workspace__controls > section").count(), 1,
      "the command picker must be the only control card");

    const openCommands = async (): Promise<Locator> => {
      const search = page.getByRole("searchbox", { name: "Search beacon commands", exact: true });
      if (!await search.isVisible()) {
        await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
      }
      await search.waitFor();
      return search;
    };
    const search = await openCommands();
    for (const label of [
      "Ping", "Rename", "Set environment variable", "Unset environment variable",
      "Reconfigure beacon", "Open session",
    ]) {
      await search.fill(label);
      await page.getByRole("option", { name: new RegExp(`^${label}\\b`, "u") }).waitFor();
    }

    const selectCommand = async (label: string): Promise<void> => {
      const search = await openCommands();
      await search.fill(label);
      await page.getByRole("option", { name: new RegExp(`^${label}\\b`, "u") }).click();
      await search.waitFor({ state: "hidden" });
    };
    const submitQueued = async (
      label: string,
      operationId: TargetOperationRecord["operationId"],
      description: string,
      fill: () => Promise<void> = async () => undefined,
    ): Promise<TargetOperationRecord> => {
      await selectCommand(label);
      await fill();
      const existingIds = new Set((await managementOperations(page)).map(({ requestId }) => requestId));
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await composer.getByRole("button", { name: "Queue task", exact: true }).click();
      const operation = await waitForManagementOperation(page, existingIds, operationId);
      assert.equal(operation.mode, "beacon");
      assert.equal(operation.target.id, "m1_beacon");
      assert.ok(operation.taskId, `${label} must retain the exact queued task ID`);
      assert.ok(["submitted", "running"].includes(operation.state), `${label}: ${operation.state}`);
      const task = await application!.evaluate((_electron, taskId) => (
        globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => candidate.id === taskId)
      ), operation.taskId);
      assert.equal(task?.description, description);
      assert.equal(task?.beaconId, "m1_beacon");
      assert.equal(task?.state, "pending");
      const status = composer.getByRole("status", { name: "Beacon command status", exact: true });
      await status.waitFor();
      assert.ok((await status.innerText()).includes(`Task ID: ${operation.taskId}`),
        "the existing command card must show the exact queued task ID");
      await page.getByRole("tab", { name: "Task queue", exact: true }).click();
      const queuedRow = page.getByRole("grid", { name: "Beacon task queue", exact: true })
        .getByRole("row").filter({ hasText: operation.taskId });
      await queuedRow.waitFor();
      await queuedRow.click();
      await page.getByRole("tabpanel", { name: "Task output", exact: true })
        .getByRole("article", { name: `Task output ${operation.taskId}`, exact: true }).waitFor();
      await application!.evaluate((_electron, taskId) => {
        globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId);
      }, operation.taskId);
      const completed = await waitForManagementState(page, operation.requestId, "completed");
      assert.equal(completed.taskId, operation.taskId);
      return completed;
    };

    await submitQueued("Ping", "target.ping", "Ping");
    await submitQueued("Set environment variable", "target.env-set", "SetEnvReq", async () => {
      await page.getByRole("textbox", { name: "Variable name", exact: true }).fill("BC02_E2E_VALUE");
      await page.getByRole("textbox", { name: "Variable value", exact: true }).fill("first-value");
    });
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.environment["BC02_E2E_VALUE"]), "first-value");
    await submitQueued("Unset environment variable", "target.env-unset", "UnsetEnvReq", async () => {
      await page.getByRole("textbox", { name: "Variable name", exact: true }).fill("BC02_E2E_VALUE");
    });
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.environment["BC02_E2E_VALUE"]), undefined);
    await submitQueued("Reconfigure beacon", "beacon.reconfigure", "ReconfigureReq", async () => {
      await page.getByRole("spinbutton", { name: "Reconnect seconds", exact: true }).fill("7");
      await page.getByRole("spinbutton", { name: "Interval seconds", exact: true }).fill("11");
      await page.getByRole("spinbutton", { name: "Jitter seconds", exact: true }).fill("3");
    });
    assert.deepEqual(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.reconfigureRequests.at(-1)), {
      beaconId: "m1_beacon",
      options: {
        reconnectIntervalNanoseconds: "7000000000",
        intervalNanoseconds: "11000000000",
        jitterNanoseconds: "3000000000",
      },
      timeoutSeconds: 60,
    });
    await submitQueued("Open session", "beacon.open-session", "OpenSession", async () => {
      await page.getByRole("spinbutton", { name: "Delay seconds", exact: true }).fill("4");
    });
    const openRequest = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.openSessionRequests.at(-1));
    assert.equal(openRequest?.beaconId, "m1_beacon");
    assert.equal(openRequest?.delayNanoseconds, "4000000000");
    assert.equal(openRequest?.c2s.length, 1);

    await selectCommand("Rename");
    await page.getByRole("textbox", { name: "New target name", exact: true }).fill("bc02-renamed");
    const beforeRename = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.length);
    const existingIds = new Set((await managementOperations(page)).map(({ requestId }) => requestId));
    await composer.getByRole("button", { name: "Rename beacon", exact: true }).click();
    const rename = await waitForManagementOperation(page, existingIds, "target.rename");
    assert.equal(rename.state, "completed", "server-side rename must finish synchronously");
    assert.equal(rename.taskId, undefined, "rename must not claim a beacon task");
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.length), beforeRename);
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.beaconName), "bc02-renamed");
    const renameStatus = composer.getByRole("status", { name: "Beacon command status", exact: true });
    await renameStatus.waitFor();
    assert.match(await renameStatus.innerText(), /Rename · Completed · Request ID: /u);
    assert.doesNotMatch(await renameStatus.innerText(), /Task ID:/u,
      "a synchronous rename must not claim a queued task in the command card");

    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: /m2-beacon/u }).click();
    await breadcrumbs.getByText("m2-beacon", { exact: true }).waitFor();
    const commandStatus = composer.getByRole("status", { name: "Beacon command status", exact: true });
    await commandStatus.waitFor({ state: "hidden" });
    assert.equal(await commandStatus.count(), 0,
      "switching targets must discard the previous beacon's command result");
    await selectCommand("Open session");
    const denied = composer.getByRole("button", { name: "Queue task", exact: true });
    assert.equal(await denied.isDisabled(), true);
    await page.getByText("This beacon has no supported authoritative C2 endpoint for session conversion.", { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.openSessionRequests.length), 1,
      "a disabled capability must not dispatch another session conversion");
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("BC-03 beacon commands retain read results and reviewed Windows actions in task output", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacon-bc03-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "beacon-bc03.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
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
        "--beacon-execution-fixture",
        "--beacon-bc03-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
    const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
    const queueTab = page.getByRole("tab", { name: "Task queue", exact: true });

    const selectCommand = async (label: string): Promise<void> => {
      await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
      const search = page.getByRole("searchbox", { name: "Search beacon commands", exact: true });
      await search.fill(label);
      await page.getByRole("option", { name: new RegExp(`^${label}\\b`, "u") }).click();
    };
    const queueTask = async (description: string, reviewed = false): Promise<string> => {
      const before = await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await composer.getByRole("button", { name: "Queue task", exact: true }).click();
      if (reviewed) {
        const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
        await review.waitFor();
        assert.deepEqual(await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id)), before,
          "a reviewed identity action must not dispatch before confirmation");
        await review.getByRole("button", { name: "Execute", exact: true }).click();
      }
      const deadline = Date.now() + 10_000;
      let task: { id: string; beaconId: string; description: string } | undefined;
      while (!task && Date.now() < deadline) {
        task = await application!.evaluate((_electron, knownIds) =>
          globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !knownIds.includes(candidate.id)), before);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(task, `${description} must create an exact beacon task; composer: ${await composer.innerText()}; M4 calls: ${JSON.stringify(await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.callCounts))}`);
      assert.equal(task.description, description);
      await queueTab.click();
      await queue.getByRole("row").filter({ hasText: task.id }).getByText("Pending", { exact: true }).waitFor();
      return task.id;
    };
    const completeAndOpen = async (taskId: string): Promise<Locator> => {
      await application!.evaluate((_electron, id) => globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(id, true), taskId);
      await queueTab.click();
      const row = queue.getByRole("row").filter({ hasText: taskId });
      await row.getByText("Completed", { exact: true }).waitFor();
      await row.click();
      await assertBeaconOutputFocus(page, taskId);
      return page.getByRole("article", { name: `Task output ${taskId}`, exact: true });
    };

    for (const label of ["Background children", "Windows privileges", "Run as", "Make token", "Impersonate", "Revert identity"]) {
      await selectCommand(label);
    }
    await selectCommand("Windows privileges");
    await composer.getByText("This execution command is unavailable for the selected beacon.", { exact: true }).waitFor();
    assert.equal(await composer.getByRole("button", { name: "Queue task", exact: true }).isDisabled(), true,
      "a Windows-only read must not dispatch from a Darwin beacon");
    await selectCommand("Background children");
    const childrenTaskId = await queueTask("ExecuteChildrenReq");
    const children = await completeAndOpen(childrenTaskId);
    await children.getByRole("region", { name: "Background children", exact: true })
      .getByText("/usr/bin/printf", { exact: true }).waitFor();
    await children.getByRole("button", { name: "Load more", exact: true }).click();
    await children.getByText("/usr/bin/fixture-child-50", { exact: true }).waitFor();

    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: /windows-execution-beacon/u }).click();
    await page.getByRole("heading", { name: "windows-execution-beacon", exact: true }).waitFor();

    await selectCommand("Windows privileges");
    const privilegeTaskId = await queueTask("GetPrivsReq");
    const privileges = await completeAndOpen(privilegeTaskId);
    await privileges.getByRole("region", { name: "Windows privileges", exact: true })
      .getByText("SeDebugPrivilege", { exact: true }).waitFor();
    await privileges.getByRole("button", { name: "Load more", exact: true }).click();
    await privileges.getByText("FixturePrivilege50", { exact: true }).waitFor();

    await selectCommand("Run as");
    assert.match(await composer.innerText(), /Username/u, `Run as form missing: ${await composer.innerText()}`);
    assert.ok(await composer.locator('input[name="username"]').count(),
      `Run as native username input missing: ${await composer.innerText()}`);
    await composer.locator('input[name="username"]').fill("fixture-user");
    await composer.getByLabel("Password", { exact: true }).fill("BC03_E2E_SECRET_DO_NOT_RENDER");
    await composer.locator('input[name="process"]').fill("C:\\Windows\\System32\\whoami.exe");
    const runAsTaskId = await queueTask("RunAsReq", true);
    const runAs = await completeAndOpen(runAsTaskId);
    const runAsOutput = runAs.getByRole("region", { name: "Beacon execution output", exact: true });
    await runAsOutput.locator('[data-terminal-state="ready"]').waitFor();
    assert.equal(await runAsOutput.getByLabel("Execution output transcript", { exact: true }).textContent(),
      "deterministic M4 run-as output\n");
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.retainedSensitiveInputs), 0);
    assert.equal((await page.locator("body").innerText()).includes("BC03_E2E_SECRET_DO_NOT_RENDER"), false);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("BC-05 beacon reads use the command picker and exact task output", { timeout: 150_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacon-bc05-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "beacon-bc05.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
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
        "--beacon-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
    const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });

    const selectCommand = async (label: string): Promise<void> => {
      await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
      const search = page.getByRole("searchbox", { name: "Search beacon commands", exact: true });
      await search.fill(label);
      await page.getByRole("option", { name: new RegExp(`^${label} (?:Filesystem|Networking|Environment|Identity|Processes)\\b`, "u") }).click();
      await page.keyboard.press("Escape");
    };
    const submitAndOpen = async (description: string): Promise<Locator> => {
      const knownIds = await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await composer.getByRole("button", { name: "Queue task", exact: true }).click();
      const deadline = Date.now() + 10_000;
      let task: { id: string; beaconId: string; description: string } | undefined;
      while (!task && Date.now() < deadline) {
        task = await application!.evaluate((_electron, existing) =>
          globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !existing.includes(candidate.id)), knownIds);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(task, `${description} must queue from the existing beacon command card: ${await composer.innerText()}`);
      assert.equal(task.description, description);
      await page.getByRole("tab", { name: "Task queue", exact: true }).click();
      const row = queue.getByRole("row").filter({ hasText: task.id });
      await row.getByText("Pending", { exact: true }).waitFor();
      await application!.evaluate((_electron, taskId) => globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId), task.id);
      await row.getByText("Completed", { exact: true }).waitFor();
      await row.click();
      await assertBeaconOutputFocus(page, task.id);
      return page.getByRole("article", { name: `Task output ${task.id}`, exact: true });
    };

    await selectCommand("Process ID");
    await composer.getByText("41002", { exact: true }).waitFor();
    assert.equal(await composer.getByRole("button", { name: "Queue task", exact: true }).count(), 0);
    await selectCommand("Current identity");
    await composer.getByText("e2e-user", { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.length), 0);

    await selectCommand("Environment variables");
    await composer.getByRole("textbox", { name: "Filter by variable name (optional)", exact: true }).fill("BC05_VISIBLE");
    assert.match(await (await submitAndOpen("EnvReq")).innerText(), /BC05_VISIBLE/u);
    await selectCommand("Network connections");
    assert.match(await (await submitAndOpen("NetstatReq")).innerText(), /192\.0\.2\.25/u);
    await selectCommand("List processes");
    await composer.getByText("Include full process details", { exact: true }).click();
    const processOutput = await submitAndOpen("PsReq");
    await processOutput.getByRole("textbox", { name: "Filter owner" }).fill("analyst");
    await processOutput.getByRole("cell", { name: "python3", exact: true }).waitFor();
    assert.equal(await processOutput.getByRole("cell", { name: "launchd", exact: true }).count(), 0);
    await processOutput.getByRole("textbox", { name: "Filter owner" }).fill("");
    await processOutput.getByText("Process tree", { exact: true }).click();
    assert.match(await processOutput.innerText(), /↳/u, "process tree must use this task's decoded parent IDs");
    await selectCommand("Mounts");
    assert.match(await (await submitAndOpen("MountReq")).innerText(), /Fixture volume/u);
    await selectCommand("Read file");
    assert.match(await composer.innerText(), /File path/u, "Read file must expose its path form");
    await composer.getByRole("textbox", { name: /^File path/u }).fill("/Users/e2e/workspace/notes.txt");
    assert.match(await (await submitAndOpen("DownloadReq")).innerText(), /deterministic BC-05 cat output/u);
    await selectCommand("Read file head");
    await composer.getByRole("textbox", { name: /^File path/u }).fill("/Users/e2e/workspace/notes.txt");
    assert.match(await (await submitAndOpen("DownloadReq")).innerText(), /deterministic BC-05 head output/u);
    await selectCommand("Read file tail");
    await composer.getByRole("textbox", { name: /^File path/u }).fill("/Users/e2e/workspace/notes.txt");
    assert.match(await (await submitAndOpen("DownloadReq")).innerText(), /deterministic BC-05 tail output/u);
    await selectCommand("Search files");
    await composer.getByRole("textbox", { name: /^Search path/u }).fill("/Users/e2e/workspace");
    await composer.getByRole("textbox", { name: /^Search pattern/u }).fill("fixture");
    assert.match(await (await submitAndOpen("GrepReq")).innerText(), /fixture appears in fixture text/u);

    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: /windows-execution-beacon/u }).click();
    await page.getByRole("heading", { name: "windows-execution-beacon", exact: true }).waitFor();
    await selectCommand("Current identity");
    assert.match(await (await submitAndOpen("CurrentTokenOwnerReq")).innerText(), /fixture-token-owner/u);

    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: /linux-execution-beacon/u }).click();
    await page.getByRole("heading", { name: "linux-execution-beacon", exact: true }).waitFor();
    await selectCommand("Memory files");
    assert.match(await (await submitAndOpen("MemfilesListReq")).innerText(), /m2-memory-cache\.bin/u);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("beacon Details render complete tables, file text, and execution streams in a wide modal", { timeout: 90_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacon-response-details-e2e-"));
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
  await writeFile(join(savedConfigDirectory, "beacon-response-details.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
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
        "--beacon-response-details-fixture",
        "--beacon-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
    const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
    const dialog = page.getByRole("dialog", { name: /^(Directory listing|File contents|Process execution)$/u });

    const selectCommand = async (label: string): Promise<void> => {
      await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
      const search = page.getByRole("searchbox", { name: "Search beacon commands", exact: true });
      await search.fill(label);
      await page.getByRole("option", { name: label === "Execution" ? /^Execution\b/u : new RegExp(`^${label} Filesystem\\b`, "u") }).click();
      await page.keyboard.press("Escape");
    };
    const assertTaskTitle = async (container: Locator, label: string, icon: string, rawType: string): Promise<void> => {
      const title = container.getByRole("heading", { name: label, exact: true });
      await title.waitFor();
      assert.equal(await container.getByText(label, { exact: true }).count(), 1,
        "each task must have one friendly primary title without a duplicate result title");
      assert.equal(await title.locator(`svg[data-icon="${icon}"]`).count(), 1,
        "the task icon must appear inside the primary title");
      assert.equal((await container.innerText()).includes(rawType), false,
        "protocol task types must stay out of visible task output");
    };
    const submitAndOpen = async (
      label: string,
      icon: string,
      rawType: string,
      reviewed = false,
    ): Promise<{ taskId: string; preview: Locator }> => {
      const knownIds = await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await composer.getByRole("button", { name: "Queue task", exact: true }).click();
      if (reviewed) {
        const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
        await review.getByRole("button", { name: "Execute", exact: true }).click();
        await review.waitFor({ state: "hidden" });
      }
      const deadline = Date.now() + 10_000;
      let task: { id: string; beaconId: string } | undefined;
      while (!task && Date.now() < deadline) {
        task = await application!.evaluate((_electron, existing) =>
          globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !existing.includes(candidate.id)), knownIds);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(task && task.beaconId === "m1_beacon", "the selected beacon must own the queued response");
      assert.match(task.id, /^[0-9a-f-]{36}$/u, "the Details fixture must exercise a full task GUID");
      const preview = page.getByRole("article", { name: `Task output ${task.id}`, exact: true });
      await preview.getByText("Waiting for the beacon", { exact: true }).waitFor();
      await assertTaskTitle(preview, label, icon, rawType);
      await page.getByRole("tab", { name: "Task queue", exact: true }).click();
      const row = queue.getByRole("row").filter({ hasText: task.id });
      await row.getByText("Pending", { exact: true }).waitFor();
      await row.getByText(label, { exact: true }).waitFor();
      assert.equal(await row.locator(`svg[data-icon="${icon}"]`).count(), 1,
        "pending queue rows must show the task icon beside the friendly label");
      assert.equal((await row.innerText()).includes(rawType), false,
        "protocol task types must stay out of the task queue");
      await application!.evaluate((_electron, taskId) => globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId), task.id);
      await row.getByText("Completed", { exact: true }).waitFor();
      await row.getByText(label, { exact: true }).waitFor();
      await row.click();
      await preview.getByRole("button", { name: "Details", exact: true }).waitFor();
      await assertTaskTitle(preview, label, icon, rawType);
      assert.equal((await preview.innerText()).includes(task.id), false, "compact output must omit the task GUID");
      await page.waitForFunction(() => {
        const document = (globalThis as unknown as { document: { querySelector(selector: string): unknown } }).document;
        return document.querySelector('[data-slot="toast"]') === null;
      }, undefined, { timeout: 10_000 });
      return { taskId: task.id, preview };
    };
    const assertModalLayout = async (width: number): Promise<void> => {
      await nativeWindow.evaluate((window, nextWidth) => window.setSize(nextWidth, 950), width);
      await page.waitForFunction((expectedWidth) => (
        globalThis as unknown as { innerWidth: number }
      ).innerWidth === expectedWidth, width);
      const bounds = await dialog.boundingBox();
      assert.ok(bounds, "the Details modal must have a measurable layout");
      assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= width - 8,
        `the modal must fit the ${width}px viewport with side margins: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 950,
        `the modal must remain fully inside the viewport: ${JSON.stringify(bounds)}`);
      if (width === 1440) assert.ok(bounds.width >= 1000, "the full output modal must use the available desktop width");
      const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth);
      assert.ok(overflow <= 1, "the modal itself must not clip overflowing content horizontally");
    };

    await selectCommand("List directory");
    const directory = await submitAndOpen("Directory listing", "folder-open", "LsReq");
    await directory.preview.getByRole("cell", { name: "details-row-000.txt", exact: true }).waitFor();
    await assertTaskTitle(directory.preview, "Directory listing", "folder-open", "LsReq");
    assert.equal(await directory.preview.getByRole("cell", { name: "details-row-299.txt", exact: true }).count(), 0,
      "the compact directory preview must remain limited to its first 256 rows");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-directory-task-title.png") });
    await directory.preview.getByRole("button", { name: "Details", exact: true }).click();
    await dialog.getByText("Task GUID", { exact: true }).waitFor();
    await dialog.getByText(directory.taskId, { exact: true }).waitFor();
    await assertTaskTitle(dialog, "Directory listing", "folder-open", "LsReq");
    const directorySection = dialog.getByRole("region", { name: "Files", exact: true });
    const directoryTable = directorySection.getByRole("table", { name: "Files", exact: true });
    await directoryTable.getByRole("cell", { name: "details-row-000.txt", exact: true }).waitFor();
    await assertTaskTitle(dialog, "Directory listing", "folder-open", "LsReq");
    for (const column of ["Name", "Type", "Size", "Modified", "Mode"]) {
      await directoryTable.getByRole("columnheader", { name: column, exact: true }).waitFor();
    }
    const directoryNames: string[] = [];
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      await directoryTable.getByRole("cell", { name: `details-row-${String(pageNumber * 100).padStart(3, "0")}.txt`, exact: true }).waitFor();
      directoryNames.push(...await directoryTable.getByRole("cell", { name: /^details-row-\d{3}\.txt$/u }).allTextContents());
      if (pageNumber < 2) await directorySection.getByRole("button", { name: "Next", exact: true }).click();
    }
    assert.equal(new Set(directoryNames).size, 300, "all 300 rows must be reachable through table paging");
    await directoryTable.getByRole("cell", { name: "details-row-299.txt", exact: true }).waitFor();
    assert.equal(await directorySection.getByRole("button", { name: "Next", exact: true }).isEnabled(), false);
    await directorySection.getByRole("searchbox", { name: "Filter Files", exact: true }).fill("details-row-299.txt");
    await directoryTable.getByRole("cell", { name: "details-row-299.txt", exact: true }).waitFor();
    assert.equal(await directoryTable.getByRole("cell", { name: /^details-row-\d{3}\.txt$/u }).count(), 1,
      "the full result filter must find a row beyond the compact preview limit");
    assert.equal((await dialog.innerText()).includes('"Files":'), false, "Details must render a directory table instead of its JSON envelope");
    await directorySection.getByRole("searchbox", { name: "Filter Files", exact: true }).fill("");
    await directoryTable.getByRole("cell", { name: "details-row-000.txt", exact: true }).waitFor();
    await assertModalLayout(1440);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-full-directory-response.png") });
    await assertModalLayout(1024);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-full-directory-response-narrow.png") });
    await assertModalLayout(1440);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await selectCommand("Read file");
    await composer.getByRole("textbox", { name: /^File path/u }).fill("/Users/e2e/workspace/full-response.txt");
    const file = await submitAndOpen("File contents", "file-arrow-down", "DownloadReq");
    await file.preview.getByRole("button", { name: "Details", exact: true }).click();
    await dialog.getByText(file.taskId, { exact: true }).waitFor();
    await assertTaskTitle(dialog, "File contents", "file-arrow-down", "DownloadReq");
    const fileContents = dialog.locator('pre[aria-label="File contents"]');
    await fileContents.filter({ hasText: "DETAILS_TEXT_TAIL" }).waitFor();
    await assertTaskTitle(dialog, "File contents", "file-arrow-down", "DownloadReq");
    assert.equal(await fileContents.textContent(), `DETAILS_TEXT_START\n${"Complete task response line.\n".repeat(3500)}DETAILS_TEXT_TAIL\n`,
      "Details must automatically load and render the exact multiline file, including its tail beyond 64K");
    assert.equal(await dialog.getByRole("button", { name: "Next", exact: true }).count(), 0,
      "text output must not require navigation through JSON character pages");
    assert.equal((await dialog.innerText()).includes('"Data":'), false, "file output must omit the transport JSON envelope");
    await assertModalLayout(1440);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-full-text-response.png") });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });

    await selectCommand("Execution");
    await composer.getByRole("tab", { name: "Process", exact: true }).waitFor();
    await composer.getByRole("textbox", { name: /^Executable path/u }).fill("/usr/bin/printf");
    await composer.getByRole("textbox", { name: "Arguments", exact: true }).fill("details");
    const execution = await submitAndOpen("Process execution", "terminal", "ExecuteReq", true);
    await execution.preview.getByRole("button", { name: "Details", exact: true }).click();
    await assertTaskTitle(dialog, "Process execution", "terminal", "ExecuteReq");
    try {
      await dialog.locator('pre[aria-label="Standard output"]').waitFor();
    } catch (error) {
      throw new Error(`The process Details must render its output streams: ${await dialog.innerText()}`, { cause: error });
    }
    assert.equal(await dialog.locator('pre[aria-label="Standard output"]').textContent(), "deterministic M4 process stdout\n");
    assert.equal(await dialog.locator('pre[aria-label="Standard error"]').textContent(), "deterministic beacon process stderr\n");
    await assertTaskTitle(dialog, "Process execution", "terminal", "ExecuteReq");
    assert.equal((await dialog.innerText()).includes('"Stdout":'), false, "execution output must render decoded streams instead of JSON");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-full-execution-response.png") });
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("BC-08 beacon Registry and service tasks keep Windows review and task output bound", { timeout: 150_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-beacon-bc08-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "beacon-bc08.cfg"), fakeOperatorConfig(), { mode: 0o600 });

  let application: ElectronApplication | undefined;
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
        "--beacon-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(15_000);
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
    const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
    const queueTab = page.getByRole("tab", { name: "Task queue", exact: true });
    const selectCommand = async (label: string): Promise<void> => {
      await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
      await page.getByRole("searchbox", { name: "Search beacon commands", exact: true }).fill(label);
      await page.getByRole("option", { name: new RegExp(`^${label}\\b`, "u") }).click();
    };
    const newTask = async (knownIds: string[], description: string): Promise<string> => {
      const deadline = Date.now() + 10_000;
      let task: { id: string; description: string; beaconId: string } | undefined;
      while (!task && Date.now() < deadline) {
        task = await application!.evaluate((_electron, before) =>
          globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !before.includes(candidate.id)), knownIds);
        if (!task) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(task, `${description} must queue an exact task: ${await composer.innerText()}`);
      assert.equal(task.description, description);
      assert.equal(task.beaconId, "windows_execution_beacon");
      return task.id;
    };
    const completeAndOpen = async (taskId: string): Promise<Locator> => {
      await queueTab.click();
      const row = queue.getByRole("row").filter({ hasText: taskId });
      await row.getByText("Pending", { exact: true }).waitFor();
      await application!.evaluate((_electron, id) => globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(id), taskId);
      await row.getByText("Completed", { exact: true }).waitFor();
      await row.click();
      await assertBeaconOutputFocus(page, taskId);
      return page.getByRole("article", { name: `Task output ${taskId}`, exact: true });
    };
    const queueRead = async (description: string): Promise<Locator> => {
      const knownIds = await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await composer.getByRole("button", { name: "Queue task", exact: true }).click();
      return completeAndOpen(await newTask(knownIds, description));
    };
    const reviewMutation = async (description: string): Promise<Locator> => {
      const knownIds = await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
      await composer.getByRole("button", { name: "Review task", exact: true }).click();
      const review = page.getByRole("alertdialog", { name: "Queue this reviewed beacon mutation?", exact: true });
      await review.waitFor();
      assert.deepEqual(await application!.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id)), knownIds,
        "review must not dispatch a beacon task before confirmation");
      await application!.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
      await review.getByRole("button", { name: "Queue reviewed task", exact: true }).click();
      return completeAndOpen(await newTask(knownIds, description));
    };

    await selectCommand("List registry subkeys");
    await composer.getByText("Registry and service commands require a Windows beacon.", { exact: true }).waitFor();
    assert.equal(await composer.getByRole("button", { name: "Queue task", exact: true }).isDisabled(), true);
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.length), 0);

    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: /windows-execution-beacon/u }).click();
    await page.getByRole("heading", { name: "windows-execution-beacon", exact: true }).waitFor();

    await selectCommand("List registry subkeys");
    await composer.getByRole("textbox", { name: "Registry path" }).fill("Software\\Fixture");
    await composer.getByRole("textbox", { name: "Host (optional)" }).fill("fixture-host");
    const subkeys = await queueRead("RegistrySubKeyListReq");
    await subkeys.getByRole("cell", { name: "FixtureChild", exact: true }).waitFor();

    await selectCommand("Read registry value");
    await composer.getByRole("textbox", { name: "Registry path" }).fill("Software\\Fixture");
    await composer.getByRole("textbox", { name: "Value name" }).fill("FixtureMode");
    assert.match(await (await queueRead("RegistryReadReq")).innerText(), /fixture-registry-value-FixtureMode/u);

    await selectCommand("List services");
    const services = await queueRead("ServicesReq");
    await services.getByRole("cell", { name: "Spooler", exact: true }).waitFor();
    await services.getByRole("cell", { name: "Running", exact: true }).first().waitFor();

    await selectCommand("Service information");
    await composer.getByRole("textbox", { name: "Service name" }).fill("Spooler");
    assert.match(await (await queueRead("ServiceDetailReq")).innerText(), /Print Spooler/u);

    await selectCommand("Write registry value");
    await composer.getByRole("textbox", { name: "Registry path" }).fill("Software\\Fixture");
    await composer.getByRole("textbox", { name: "Value name" }).fill("FixtureMode");
    await composer.getByRole("button", { name: /Registry value type/u }).click();
    await page.getByRole("option", { name: "Binary", exact: true }).click();
    await composer.getByRole("textbox", { name: "Hexadecimal bytes" }).fill("AABB");
    const writeOutput = await reviewMutation("RegistryWriteReq");
    assert.match(await writeOutput.innerText(), /Not verified; requery the target/u);
    assert.match(await writeOutput.innerText(), /Read the registry or service state again/u);

    await selectCommand("Stop service");
    await composer.getByRole("textbox", { name: "Service name" }).fill("Spooler");
    const stopOutput = await reviewMutation("StopServiceReq");
    assert.match(await stopOutput.innerText(), /Not verified; requery the target/u);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function managementOperations(page: Page): Promise<TargetOperationRecord[]> {
  return page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    const result = await api.listTargetOperations({ limit: 100 });
    if (!result.ok || !result.value) throw new Error(result.error ?? "Could not read target operations");
    return result.value.items;
  });
}

async function waitForManagementOperation(
  page: Page,
  existingIds: ReadonlySet<string>,
  operationId: TargetOperationRecord["operationId"],
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const operation = (await managementOperations(page)).find((candidate) =>
      candidate.operationId === operationId && !existingIds.has(candidate.requestId));
    if (operation) return operation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the ${operationId} management operation`);
}

async function waitForManagementState(
  page: Page,
  requestId: string,
  state: TargetOperationRecord["state"],
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const operation = (await managementOperations(page)).find((candidate) => candidate.requestId === requestId);
    if (operation?.state === state) return operation;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for management operation ${requestId} to reach ${state}`);
}

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
  await page.getByRole("tab", { name: "Task queue", exact: true }).click();
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

  await page.getByRole("button", { name: "Beacon details", exact: true }).click();
  await page.getByRole("complementary", { name: "Beacon details", exact: true }).waitFor();
  await page.screenshot({ animations: "disabled" });
  await trigger.click();
  await scrollBeaconWorkspaceToBottom(page);
  await menu.getByRole("menuitemradio", { name: /m2-beacon/u }).click();
  await breadcrumbs.getByText("m2-beacon", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "m2-beacon", exact: true }).waitFor();
  await assertBeaconWorkspaceScrollReset(page);
  assert.equal(await page.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true",
    "switching beacons must restore the default output tab");
  await page.getByRole("tab", { name: "Task queue", exact: true }).click();
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
  assert.equal(await page.getByRole("tab", { name: "Task queue", exact: true }).getAttribute("aria-selected"), "true",
    "newly queued pending tasks must leave the queue tab selected");
  await queue.getByRole("row").filter({ hasText: queuedTasks[0]!.id }).click();
  assert.equal(await page.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true",
    "choosing a pending task must jump to its status in output history");
  await assertBeaconOutputFocus(page, queuedTasks[0]!.id);
  await page.getByText("Waiting for the beacon", { exact: true }).waitFor();

  await trigger.click();
  await menu.getByRole("menuitemradio", { name: /m1-beacon/u }).click();
  await breadcrumbs.getByText("m1-beacon", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true",
    "switching the exact beacon must restore the default output tab");
  await page.getByRole("heading", { name: "No task output", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Task queue", exact: true }).click();
  await queue.getByText("No tasks queued", { exact: true }).waitFor();
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
    const taskTabs = popout.getByRole("tablist", { name: "Beacon task views", exact: true });
    const pwdTask = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks
      .find((task) => task.beaconId === "m1_beacon" && task.description === "PwdReq" && task.state === "completed"));
    assert.ok(pwdTask);
    assert.equal(await taskTabs.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true");
    await taskTabs.getByRole("tab", { name: "Task queue", exact: true }).click();
    await popout.getByRole("grid", { name: "Beacon task queue", exact: true })
      .getByRole("row").filter({ hasText: pwdTask.id }).click();
    const output = popout.getByRole("tabpanel", { name: "Task output", exact: true });
    await assertBeaconOutputFocus(popout, pwdTask.id);
    await output.getByRole("article", { name: `Task output ${pwdTask.id}`, exact: true })
      .getByText("/Users/e2e/workspace", { exact: true }).waitFor();
    assert.equal(await output.locator("article[data-task-id]").count(), 3, "popouts must load the full completed output history");
    assert.equal(await taskTabs.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true");
    await popout.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-popout-task-output.png") });
    await taskTabs.getByRole("tab", { name: "Task queue", exact: true }).click();
    await popout.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-popout-task-queue.png") });

    await popout.getByRole("button", { name: "Beacon details", exact: true }).click();
    await popout.getByRole("complementary", { name: "Beacon details", exact: true }).waitFor();
    await popout.screenshot({ animations: "disabled" });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await scrollBeaconWorkspaceToBottom(popout);
    const menu = popout.getByRole("menu", { name: "Beacons, switch beacon", exact: true });
    await menu.getByRole("menuitemradio", { name: /m2-beacon/u }).click();
    await breadcrumbs.getByText("m2-beacon", { exact: true }).waitFor();
    await popout.getByRole("heading", { name: "m2-beacon", exact: true }).waitFor();
    await assertBeaconWorkspaceScrollReset(popout);
    assert.equal(await nativeWindow.evaluate((window) => window.getTitle()), "Interact — m2-beacon",
      "switching the popout beacon must update its native window title");
    assert.equal(await taskTabs.getByRole("tab", { name: "Task output", exact: true }).getAttribute("aria-selected"), "true");
    await taskTabs.getByRole("tab", { name: "Task queue", exact: true }).click();
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

async function assertBeaconExecutionCommands(
  application: ElectronApplication,
  page: Page,
  screenshotDirectory: string,
): Promise<void> {
  const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
  const queueTab = page.getByRole("tab", { name: "Task queue", exact: true });
  const originalSettings = await page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getApplicationSettings());
  const originalClipboard = await application.evaluate(({ clipboard }) => clipboard.readText());
  const nativeWindow = await application.browserWindow(page);
  const originalSize = await nativeWindow.evaluate((window) => window.getSize());
  const selectExecution = async (): Promise<Locator> => {
    await composer.locator('[data-slot="autocomplete-trigger"]').first().click();
    await page.getByRole("searchbox", { name: "Search beacon commands", exact: true }).fill("Execution");
    await page.getByRole("option", { name: /^Execution/iu }).click();
    const tabs = composer.getByRole("tablist", { name: "Execution type", exact: true });
    await tabs.getByRole("tab", { name: "Process", exact: true }).waitFor();
    return tabs;
  };
  const switchBeacon = async (name: string): Promise<void> => {
    const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
    await breadcrumbs.getByRole("button", { name: "Beacons, switch beacon", exact: true }).click();
    await page.getByRole("menu", { name: "Beacons, switch beacon", exact: true })
      .getByRole("menuitemradio", { name: new RegExp(name, "u") }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await assertBeaconWorkspaceScrollReset(page);
  };
  const queueExecution = async (beaconId: string, description: string, reviewed: boolean): Promise<string> => {
    await queueTab.click();
    const before = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
    await application.evaluate(() => { globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true; });
    await composer.getByRole("button", { name: "Queue task", exact: true }).click();
    if (reviewed) {
      const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
      await review.waitFor();
      assert.deepEqual(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id)), before,
        "a prepared process must not dispatch until its exact-target review is confirmed");
      await review.getByRole("button", { name: "Execute", exact: true }).click();
      await review.waitFor({ state: "hidden" });
    }
    const deadline = Date.now() + 5_000;
    let task: { id: string; beaconId: string; description: string; state: string } | undefined;
    while (!task && Date.now() < deadline) {
      task = await application.evaluate((_electron, knownIds) => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !knownIds.includes(candidate.id)), before);
      if (!task) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(task, "the fake execution adapter must return a new asynchronous task");
    assert.equal(task.beaconId, beaconId);
    assert.equal(task.description, description);
    assert.equal(task.state, "pending");
    await page.getByRole("grid", { name: "Beacon task queue", exact: true })
      .getByRole("row").filter({ hasText: task.id }).getByText("Pending", { exact: true }).waitFor();
    assert.equal(await queueTab.getAttribute("aria-selected"), "true", "execution submission must keep the queue selected");
    return task.id;
  };
  const completeAndOpen = async (taskId: string, stdout: string, stderr?: string): Promise<Locator> => {
    await application.evaluate((_electron, id) => globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(id, true), taskId);
    await queueTab.click();
    const row = page.getByRole("grid", { name: "Beacon task queue", exact: true }).getByRole("row").filter({ hasText: taskId });
    await row.getByText("Completed", { exact: true }).waitFor();
    await row.click();
    await assertBeaconOutputFocus(page, taskId);
    const article = page.getByRole("article", { name: `Task output ${taskId}`, exact: true });
    const execution = article.getByRole("region", { name: "Beacon execution output", exact: true });
    await execution.locator('[data-terminal-state="ready"]').waitFor();
    assert.equal(await execution.getByLabel("Execution output transcript", { exact: true }).textContent(), stdout);
    assert.equal(await execution.getByLabel("Execution output terminal", { exact: true }).locator("canvas").count(), 1,
      "decoded task output must render in the native Ghostty terminal");
    if (stderr !== undefined) {
      await execution.getByRole("radio", { name: "Stderr", exact: true }).click();
      await waitForExecutionStream(execution, "Stderr", stderr);
      await execution.locator('[data-terminal-state="ready"]').waitFor();
      assert.equal(await execution.getByLabel("Execution output transcript", { exact: true }).textContent(), stderr);
      await execution.getByRole("button", { name: "Copy output", exact: true }).click();
      assert.equal(await application.evaluate(({ clipboard }) => clipboard.readText()), stderr,
        "copying a task's stderr must use that exact decoded stream");
      await execution.locator('[data-slot="segment"]').evaluate(async (element) => {
        const animations: Array<{ finished: Promise<unknown> }> = element.getAnimations({ subtree: true });
        await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
      });
      await execution.getByRole("radio", { name: "Stdout", exact: true }).click();
      await waitForExecutionStream(execution, "Stdout", stdout);
      await execution.locator('[data-terminal-state="ready"]').waitFor();
    }
    return article;
  };
  try {
    let types = await selectExecution();
    assert.equal(await types.getByRole("tab", { name: ".NET", exact: true }).count(), 0, ".NET must be absent on macOS beacons");
    assert.equal(await types.getByRole("tab", { name: "Reflective DLL", exact: true }).count(), 0);
    assert.equal(await composer.getByRole("switch", { name: "Use current token", exact: true }).count(), 0);
    assert.equal(await composer.getByRole("spinbutton", { name: "Parent process ID", exact: true }).count(), 0);
    await composer.getByRole("textbox", { name: /^Executable path/u }).fill("/usr/bin/printf");
    await composer.getByRole("textbox", { name: "Arguments", exact: true }).fill('native "two words"');
    const processTask = await queueExecution("m1_beacon", "ExecuteReq", true);
    const macCall = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.beaconProcessCalls.at(-1));
    assert.equal(macCall?.beaconId, "m1_beacon");
    assert.deepEqual(macCall?.options.args, ["native", "two words"]);
    const processArticle = await completeAndOpen(processTask, "deterministic M4 process stdout\n", "deterministic beacon process stderr\n");
    await assertBeaconTaskColumns(page);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-process-output.png") });

    await types.getByRole("tab", { name: "BOFs", exact: true }).click();
    await composer.getByRole("region", { name: "Execute an Armory BOF", exact: true })
      .locator('[data-slot="autocomplete-trigger"]').click();
    await page.getByRole("searchbox", { name: "Search BOFs", exact: true }).fill("sa-nslookup");
    await page.getByRole("option", { name: /^sa-nslookup/u }).click();
    await composer.getByRole("textbox", { name: /^hostname/u }).fill("localhost");
    const bofTask = await queueExecution("m1_beacon", "CallExtensionReq", false);
    const bofCall = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls.at(-1));
    assert.equal(bofCall?.targetMode, "beacon");
    assert.equal(bofCall?.targetId, "m1_beacon");
    assert.equal(bofCall?.entrypoint, "go");
    const bofArticle = await completeAndOpen(bofTask, "deterministic sa-nslookup stdout\n", "deterministic sa-nslookup stderr\n");
    assert.equal(await page.getByRole("tabpanel", { name: "Task output", exact: true }).locator("article[data-task-id]").count(), 5,
      "completed process and BOF terminals must coexist with the earlier ordinary task history");
    await processArticle.scrollIntoViewIfNeeded();
    await processArticle.locator('[data-terminal-state="ready"]').waitFor();
    assert.equal(await processArticle.getByLabel("Execution output transcript", { exact: true }).textContent(), "deterministic M4 process stdout\n",
      "switching another result's stream must preserve the process output");
    await bofArticle.scrollIntoViewIfNeeded();
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-execution-history.png") });

    await switchBeacon("linux-execution-beacon");
    types = await selectExecution();
    assert.equal(await types.getByRole("tab", { name: ".NET", exact: true }).count(), 0, ".NET must be absent on Linux beacons");
    assert.equal(await types.getByRole("tab", { name: "Reflective DLL", exact: true }).count(), 0);
    assert.equal(await composer.getByRole("switch", { name: "Hide window", exact: true }).count(), 0);
    assert.equal(await composer.getByRole("spinbutton", { name: "Parent process ID", exact: true }).count(), 0);
    assert.equal(await composer.getByRole("textbox", { name: /^Executable path/u }).inputValue(), "/bin/sh",
      "switching the exact target must reset the process form to its platform default");

    await switchBeacon("windows-execution-beacon");
    types = await selectExecution();
    await types.getByRole("tab", { name: ".NET", exact: true }).waitFor();
    await types.getByRole("tab", { name: "Reflective DLL", exact: true }).waitFor();
    await composer.getByRole("textbox", { name: /^Executable path/u }).fill("C:\\Windows\\System32\\cmd.exe");
    await composer.getByRole("textbox", { name: "Arguments", exact: true }).fill('/d /c "echo inert"');
    await composer.getByText("Use current token", { exact: true }).click();
    await composer.getByText("Hide window", { exact: true }).click();
    assert.equal(await composer.getByRole("switch", { name: "Use current token", exact: true }).isChecked(), true);
    assert.equal(await composer.getByRole("switch", { name: "Hide window", exact: true }).isChecked(), true);
    await composer.getByRole("spinbutton", { name: "Parent process ID", exact: true }).fill("4242");
    await composer.getByRole("textbox", { name: "Environment overrides", exact: true }).fill("BEACON_FIXTURE=inert");
    const beforeInvalidWindowsOptions = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.beaconProcessCalls.length);
    await composer.getByRole("button", { name: "Queue task", exact: true }).click();
    await composer.getByRole("alert").getByText("Windows token, hidden, and parent-PID execution cannot include environment overrides", { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.beaconProcessCalls.length), beforeInvalidWindowsOptions,
      "unsupported Windows execution option combinations must fail before dispatch");
    await composer.getByRole("textbox", { name: "Environment overrides", exact: true }).fill("");
    const windowsTask = await queueExecution("windows_execution_beacon", "ExecuteWindowsReq", true);
    const windowsCall = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.beaconProcessCalls.at(-1));
    assert.equal(windowsCall?.beaconId, "windows_execution_beacon");
    assert.deepEqual(windowsCall?.options.args, ["/d", "/c", "echo inert"]);
    assert.equal(windowsCall?.options.useToken, true);
    assert.equal(windowsCall?.options.hideWindow, true);
    assert.equal(windowsCall?.options.parentPid, 4242);
    assert.deepEqual(windowsCall?.options.env, {});
    await completeAndOpen(windowsTask, "deterministic M4 process stdout\n", "deterministic beacon process stderr\n");
    await assertBeaconTaskColumns(page);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-windows-process.png") });

    await types.getByRole("tab", { name: ".NET", exact: true }).click();
    await composer.getByRole("region", { name: "Execute a .NET assembly", exact: true })
      .locator('[data-slot="autocomplete-trigger"]').click();
    await page.getByRole("searchbox", { name: "Search assemblies", exact: true }).fill("args-demo");
    await page.getByRole("option", { name: /^args-demo/u }).click();
    await composer.getByRole("textbox", { name: "Assembly arguments", exact: true }).fill('--fixture "two words"');
    const assemblyTask = await queueExecution("windows_execution_beacon", "InvokeExecuteAssemblyReq", false);
    const assemblyCall = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.assemblyCalls.at(-1));
    assert.equal(assemblyCall?.targetMode, "beacon");
    assert.equal(assemblyCall?.targetId, "windows_execution_beacon");
    assert.deepEqual(assemblyCall?.options?.arguments, ["--fixture", "two words"]);
    const assemblyArticle = await completeAndOpen(assemblyTask, "deterministic M4 assembly output\n");
    const terminal = assemblyArticle.getByLabel("Execution output terminal", { exact: true });
    for (const theme of ["light", "dark"] as const) {
      const saved = await page.evaluate(async (nextTheme) => {
        const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
        const current = await api.getApplicationSettings();
        return api.updateApplicationSettings({ expectedRevision: current.revision, settings: {
          theme: nextTheme, appIcon: current.appIcon, reduceMotion: current.reduceMotion,
          disableWindowTransparency: current.disableWindowTransparency,
          reportScreenshotDirectory: current.reportScreenshotDirectory,
          commandPaletteShortcut: current.commandPaletteShortcut, keyboardShortcuts: current.keyboardShortcuts,
          terminal: { ...current.terminal, fontSize: 18 }, overview: current.overview,
        } });
      }, theme);
      assert.equal(saved.ok, true, saved.error ?? "application appearance settings must save");
      const expectedBackground = theme === "light" ? "rgb(250, 250, 250)" : "rgb(30, 30, 30)";
      const deadline = Date.now() + 5_000;
      let background = "";
      while (background !== expectedBackground && Date.now() < deadline) {
        background = await terminal.evaluate((element) => element.ownerDocument.defaultView!.getComputedStyle(element).backgroundColor);
        if (background !== expectedBackground) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(background, expectedBackground, "beacon task terminals must follow live application appearance settings");
      await assemblyArticle.locator('[data-terminal-state="ready"]').waitFor();
      assert.equal(await assemblyArticle.getByLabel("Execution output transcript", { exact: true }).textContent(), "deterministic M4 assembly output\n");
      await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `beacon-dotnet-output-${theme}.png`) });
    }
    await nativeWindow.evaluate((window) => window.setSize(960, 768));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 960);
    await assertBeaconTaskColumns(page);
    await queueTab.click();
    await page.getByRole("grid", { name: "Beacon task queue", exact: true }).getByRole("row").filter({ hasText: assemblyTask }).click();
    await assertBeaconOutputFocus(page, assemblyTask);
    await assemblyArticle.locator('[data-terminal-state="ready"]').waitFor();
    const canvas = await terminal.locator("canvas").boundingBox();
    const terminalBounds = await terminal.boundingBox();
    assert.ok(canvas && terminalBounds && canvas.width <= terminalBounds.width + 1,
      "Ghostty canvas must resize within the narrow task output card");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-dotnet-output-narrow.png") });
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.m4Audit.retainedSensitiveInputs), 0);
  } catch (error) {
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-execution-error.png") }).catch(() => undefined);
    console.error("Beacon execution composer at failure:", await composer.innerText().catch(() => "unavailable"));
    console.error("Focused element at failure:", await composer.evaluate((element) => {
      const active = element.ownerDocument.activeElement;
      return active ? { tag: active.tagName, role: active.getAttribute("role"), label: active.getAttribute("aria-label"),
        taskId: active.getAttribute("data-task-id"), articleTaskId: active.closest("article")?.getAttribute("data-task-id") } : null;
    }).catch(() => null));
    throw error;
  } finally {
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), originalClipboard);
    await page.evaluate(async (settings) => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      const current = await api.getApplicationSettings();
      return api.updateApplicationSettings({ expectedRevision: current.revision, settings });
    }, { theme: originalSettings.theme, appIcon: originalSettings.appIcon, reduceMotion: originalSettings.reduceMotion,
      disableWindowTransparency: originalSettings.disableWindowTransparency,
      reportScreenshotDirectory: originalSettings.reportScreenshotDirectory,
      commandPaletteShortcut: originalSettings.commandPaletteShortcut, keyboardShortcuts: originalSettings.keyboardShortcuts,
      terminal: originalSettings.terminal, overview: originalSettings.overview });
    await nativeWindow.evaluate((window, size) => window.setSize(size[0], size[1]), originalSize);
    await page.waitForFunction((width) => (globalThis as unknown as { innerWidth: number }).innerWidth === width, originalSize[0]);
    if (await page.getByRole("heading", { name: "m1-beacon", exact: true }).count() === 0) {
      await switchBeacon("m1-beacon");
    }
  }
}

async function waitForExecutionStream(execution: Locator, name: "Stdout" | "Stderr", text: string): Promise<void> {
  const radio = execution.getByRole("radio", { name, exact: true });
  const transcript = execution.getByLabel("Execution output transcript", { exact: true });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await radio.getAttribute("aria-checked") === "true" && await transcript.textContent() === text) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(await radio.getAttribute("aria-checked"), "true", `${name} must be selected`);
  assert.equal(await transcript.textContent(), text, `${name} must display the matching decoded stream`);
}

async function assertBeaconTaskViews(
  application: ElectronApplication,
  page: Page,
  screenshotDirectory: string,
): Promise<void> {
  const tabs = page.getByRole("tablist", { name: "Beacon task views", exact: true });
  const queueTab = tabs.getByRole("tab", { name: "Task queue", exact: true });
  const outputTab = tabs.getByRole("tab", { name: "Task output", exact: true });
  const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
  const output = page.getByRole("tabpanel", { name: "Task output", exact: true });
  await outputTab.click();
  const existingIds = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
  await application.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  await page.getByRole("button", { name: "Queue task", exact: true }).click();
  const findNewTask = () => application.evaluate((_electron, previousIds) => (
    globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((task) => !previousIds.includes(task.id))
  ), existingIds);
  const deadline = Date.now() + 20_000;
  let newTask = await findNewTask();
  while (!newTask && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    newTask = await findNewTask();
  }
  assert.ok(newTask && newTask.beaconId === "m1_beacon" && newTask.state === "pending");
  await output.getByRole("article", { name: `Task output ${newTask.id}`, exact: true })
    .getByText("Waiting for the beacon", { exact: true }).waitFor();
  assert.equal(await outputTab.getAttribute("aria-selected"), "true", "submission must preserve the output tab");
  await output.getByRole("button", { name: "Cancel task", exact: true }).waitFor();
  await queueTab.click();
  await queue.getByText("Pending", { exact: true }).waitFor();
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-task-queue-pending.png") });

  await outputTab.click();
  await output.getByText("Waiting for the beacon", { exact: true }).waitFor();
  await output.getByRole("button", { name: "Cancel task", exact: true }).waitFor();
  await queueTab.click();
  await application.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, true);
  }, newTask.id);
  const completedRow = queue.getByRole("row").filter({ hasText: newTask.id });
  await completedRow.getByText("Completed", { exact: true }).waitFor();
  assert.equal(await queueTab.getAttribute("aria-selected"), "true",
    "a task finishing in the background must keep the queue tab selected");
  for (const label of ["Task", "State", "Created"]) {
    await queue.getByRole("columnheader", { name: label, exact: true }).waitFor();
  }
  assert.deepEqual((await queue.getByRole("columnheader").allTextContents()).map((label) => label.trim()),
    ["Task", "State", "Created"], "the dedicated task queue must show only task, state, and creation time");
  await assertBeaconTaskColumns(page);
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-task-queue-completed.png") });

  await completedRow.click();
  await output.waitFor();
  assert.equal(await outputTab.getAttribute("aria-selected"), "true", "clicking a completed task must open its output tab");
  await assertBeaconOutputFocus(page, newTask.id);
  const pwdOutput = output.getByRole("article", { name: `Task output ${newTask.id}`, exact: true });
  await pwdOutput.getByText("/Users/e2e/workspace", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Task completion", exact: true }).count(), 0);
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-task-output.png") });

  await queueTab.click();
  await completedRow.click();
  await output.waitFor();
  await assertBeaconOutputFocus(page, newTask.id);
  await queueTab.click();

  const completedIds = [newTask.id];
  for (const commandName of ["List directory", "Network interfaces"]) {
    await page.locator('[data-slot="autocomplete-trigger"]:visible').click();
    await page.getByRole("searchbox", { name: "Search beacon commands", exact: true }).fill(commandName);
    await page.getByRole("option", { name: new RegExp(commandName, "iu") }).click();
    const previousIds = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.map((task) => task.id));
    await application.evaluate(() => {
      globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
    });
    await page.getByRole("button", { name: "Queue task", exact: true }).click();
    await queue.getByText("Pending", { exact: true }).waitFor();
    const task = await application.evaluate((_electron, ids) => (
      globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((candidate) => !ids.includes(candidate.id))
    ), previousIds);
    assert.ok(task && task.beaconId === "m1_beacon");
    completedIds.push(task.id);
    await application.evaluate((_electron, taskId) => {
      globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, true);
    }, task.id);
    await queue.getByRole("row").filter({ hasText: task.id }).getByText("Completed", { exact: true }).waitFor();
    assert.equal(await queueTab.getAttribute("aria-selected"), "true");
  }

  // Open the history manually: each completed result must load as its row
  // becomes visible without requiring a queue click.
  await outputTab.click();
  for (const taskId of completedIds) {
    await output.getByRole("article", { name: `Task output ${taskId}`, exact: true }).waitFor();
  }
  await pwdOutput.scrollIntoViewIfNeeded();
  await pwdOutput.getByText("/Users/e2e/workspace", { exact: true }).waitFor();
  const directoryOutput = output.getByRole("article", { name: `Task output ${completedIds[1]}`, exact: true });
  await directoryOutput.scrollIntoViewIfNeeded();
  await directoryOutput.getByRole("cell", { name: "notes.txt", exact: true }).first().waitFor();
  const directoryRows = directoryOutput.getByRole("table").getByRole("row");
  await directoryOutput.getByRole("group", { name: "Directory sort" }).getByRole("button", { name: "Size" }).click();
  assert.match(await directoryRows.nth(1).innerText(), /projects/u, "directory size sort must apply to this task's decoded rows");
  await directoryOutput.getByText("Reverse", { exact: true }).click();
  assert.match(await directoryRows.nth(1).innerText(), /notes\.txt/u, "reverse size sort must remain local to this task");
  const networkOutput = output.getByRole("article", { name: `Task output ${completedIds[2]}`, exact: true });
  await networkOutput.scrollIntoViewIfNeeded();
  await networkOutput.getByText("en0", { exact: true }).waitFor();
  assert.equal(await networkOutput.getByText("lo0", { exact: true }).count(), 0, "default interface view hides loopback-only adapters");
  await networkOutput.getByText("Show all interface addresses", { exact: true }).click();
  await networkOutput.getByText("lo0", { exact: true }).waitFor();
  assert.equal(await output.locator("article[data-task-id]").count(), 3, "the output tab must retain every completed result");
  assert.equal(await output.locator("dt").filter({ hasText: /^(Origin|Created|Sent|Completed)$/u }).count(), 0,
    "output history must omit the old task metadata block");
  const history = output.locator('[aria-label="Beacon task outputs"]');
  assert.equal(await history.getAttribute("data-slot"), "scroll-shadow");
  const scrollRange = await history.evaluate((element) => ({
    maximum: element.scrollHeight - element.clientHeight,
    overflowY: element.ownerDocument.defaultView!.getComputedStyle(element).overflowY,
  }));
  assert.ok(scrollRange.maximum > 0 && scrollRange.overflowY === "auto",
    "the completed result list must scroll within its bounded output history");
  await history.evaluate((element) => { element.scrollTop = 0; });
  const visibleOutputs = await history.evaluate((element) => {
    const viewport = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll("article[data-task-id]") as ArrayLike<typeof element>)
      .filter((article) => {
        const bounds = article.getBoundingClientRect();
        return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
      }).length;
  });
  assert.ok(visibleOutputs >= 2, "the output history must show multiple completed results together");
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-task-output-history.png") });

  const historyIds = await history.locator("article[data-task-id]")
    .evaluateAll((articles) => articles.map((article) => article.getAttribute("data-task-id")!));
  const firstId = historyIds[0]!;
  const lastId = historyIds.at(-1)!;
  assert.notEqual(firstId, lastId);
  const positions: number[] = [];
  for (const taskId of [firstId, lastId]) {
    await queueTab.click();
    await queue.getByRole("row").filter({ hasText: taskId }).click();
    await assertBeaconOutputFocus(page, taskId);
    positions.push(await history.evaluate((element) => element.scrollTop));
  }
  assert.ok(positions[1]! > positions[0]!, "queue clicks must scroll to the matching early or late history entry");
  await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-task-output-history-jump.png") });
  await assertNarrowBeaconOutputJump(application, page, newTask.id, join(screenshotDirectory, "beacon-task-output-narrow-jump.png"));
  await assertBeaconTaskVerticalLayout(application, page, screenshotDirectory);
}

async function assertBeaconTaskVerticalLayout(
  application: ElectronApplication,
  page: Page,
  screenshotDirectory: string,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page);
  const originalSize = await nativeWindow.evaluate((window) => window.getSize());
  const viewport = page.locator(":is(.app-content, .interaction-window__content):has(.beacon-workspace)");
  const card = page.locator(".beacon-task-views");
  const queueTab = page.getByRole("tab", { name: "Task queue", exact: true });
  const outputTab = page.getByRole("tab", { name: "Task output", exact: true });
  const readLayout = async () => card.evaluate((element) => {
    const scrollport = element.closest(".app-content, .interaction-window__content")!;
    const workspace = element.closest(".beacon-workspace")!;
    const cardBounds = element.getBoundingClientRect();
    const controlsBounds = workspace.querySelector(".beacon-interaction-workspace__controls")!.getBoundingClientRect();
    const viewportBounds = scrollport.getBoundingClientRect();
    const body = workspace.querySelector(".beacon-workspace__body-frame")!;
    const gutter = Number.parseFloat(body.ownerDocument.defaultView!.getComputedStyle(body).paddingBottom);
    const panel = element.querySelector('[role="tabpanel"]:not([hidden])')!;
    const panelBounds = panel.getBoundingClientRect();
    const scroll = panel.querySelector('[data-slot="table-scroll-container"], [aria-label="Beacon task outputs"]')!;
    const scrollBounds = scroll.getBoundingClientRect();
    return {
      card: { top: cardBounds.top, bottom: cardBounds.bottom, height: cardBounds.height },
      controlsBottom: controlsBounds.bottom,
      viewportBottom: viewportBounds.top + scrollport.clientHeight,
      gutter,
      panelBottom: panelBounds.bottom,
      scroll: { top: scrollBounds.top, bottom: scrollBounds.bottom, height: scrollBounds.height },
      footerTop: panel.querySelector('[aria-live="polite"]')?.parentElement?.getBoundingClientRect().top,
    };
  });
  try {
    const heights: { content: number; queue: number; output: number; card: number }[] = [];
    for (const height of [950, 1250]) {
      await nativeWindow.evaluate((window, nextHeight) => window.setSize(1440, nextHeight), height);
      const contentSize = await nativeWindow.evaluate((window) => window.getContentSize());
      await page.waitForFunction((expectedSize) => {
        const viewportSize = globalThis as unknown as { innerWidth: number; innerHeight: number };
        return viewportSize.innerWidth === expectedSize[0] && viewportSize.innerHeight === expectedSize[1];
      }, contentSize);
      await viewport.evaluate((element) => { element.scrollTop = 0; });
      await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
      await queueTab.click();
      await page.screenshot({ animations: "disabled" });
      await assertBeaconTaskColumns(page);
      const queue = await readLayout();
      const expectedBottom = Math.max(queue.controlsBottom, queue.viewportBottom - queue.gutter);
      assert.ok(Math.abs(queue.card.bottom - expectedBottom) <= 2,
        `the right task card must fill the controls column or remaining window height: ${JSON.stringify(queue)}`);
      assert.ok(Math.abs(queue.panelBottom - queue.card.bottom) <= 2 && queue.footerTop !== undefined &&
        Math.abs(queue.scroll.bottom - queue.footerTop) <= 2,
      `the task queue must fill the card below its controls and above its footer: ${JSON.stringify(queue)}`);
      await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `beacon-task-queue-fill-${height}.png`) });

      await outputTab.click();
      const output = await readLayout();
      assert.ok(Math.abs(output.card.height - queue.card.height) <= 1 &&
        Math.abs(output.scroll.bottom - output.panelBottom) <= 2 &&
        Math.abs(output.panelBottom - output.card.bottom) <= 2,
      `output history must fill the same right card below its tabs: ${JSON.stringify(output)}`);
      heights.push({ content: contentSize[1]!, queue: queue.scroll.height, output: output.scroll.height, card: output.card.height });
      await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `beacon-task-output-fill-${height}.png`) });
    }
    if (heights[1]!.content > heights[0]!.content + 200) {
      assert.ok(heights[1]!.queue > heights[0]!.queue + 200 &&
        heights[1]!.output > heights[0]!.output + 200 && heights[1]!.card > heights[0]!.card + 200,
      `both task views must grow with a taller native window instead of retaining a fixed height: ${JSON.stringify(heights)}`);
    }
  } finally {
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    const restoredContentSize = await nativeWindow.evaluate((window) => window.getContentSize());
    await page.waitForFunction((size) => {
      const viewportSize = globalThis as unknown as { innerWidth: number; innerHeight: number };
      return viewportSize.innerWidth === size[0] && viewportSize.innerHeight === size[1];
    }, restoredContentSize);
    await queueTab.click();
    await viewport.evaluate((element) => { element.scrollTop = 0; });
    await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
  }
}

async function assertNarrowBeaconOutputJump(
  application: ElectronApplication,
  page: Page,
  taskId: string,
  screenshotPath: string,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page);
  const originalSize = await nativeWindow.evaluate((window) => window.getSize());
  const viewport = page.locator(":is(.app-content, .interaction-window__content):has(.beacon-workspace)");
  const queueTab = page.getByRole("tab", { name: "Task queue", exact: true });
  try {
    await queueTab.click();
    await nativeWindow.evaluate((window) => window.setSize(960, 768));
    await page.waitForFunction(() => (globalThis as unknown as { innerWidth: number }).innerWidth === 960);
    const row = page.getByRole("grid", { name: "Beacon task queue", exact: true })
      .getByRole("row").filter({ hasText: taskId });
    const focused = await row.evaluate((element) => {
      element.focus({ preventScroll: true });
      return element.ownerDocument.activeElement === element;
    });
    assert.equal(focused, true, "the queue entry must support keyboard activation");
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
    const [rowBefore, viewportBefore] = await Promise.all([row.boundingBox(), viewport.boundingBox()]);
    assert.ok(rowBefore && viewportBefore && rowBefore.y >= viewportBefore.y + viewportBefore.height,
      "the narrow fixture must place the focused queue entry below the outer viewport");

    // Native keyboard activation leaves scrolling to the workspace; an automated
    // pointer click would scroll the queue row into view before the action.
    await page.keyboard.press("Enter");
    await assertBeaconOutputFocus(page, taskId);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
    const path = page.getByRole("article", { name: `Task output ${taskId}`, exact: true })
      .getByText("/Users/e2e/workspace", { exact: true });
    const pathBounds = await path.boundingBox();
    const visibleBounds = await viewport.evaluate((element) => {
      const viewportBounds = element.getBoundingClientRect();
      const summaryBounds = element.querySelector('header[aria-label="Beacon summary"]')!.getBoundingClientRect();
      const history = element.querySelector('[aria-label="Beacon task outputs"]')!;
      const historyBounds = history.getBoundingClientRect();
      return {
        top: Math.max(viewportBounds.top, summaryBounds.bottom),
        bottom: viewportBounds.top + element.clientHeight,
        scrollTop: element.scrollTop,
        maximumScroll: element.scrollHeight - element.clientHeight,
        history: { top: historyBounds.top, bottom: historyBounds.bottom, scrollTop: history.scrollTop },
      };
    });
    assert.ok(pathBounds && pathBounds.y >= visibleBounds.top - 1 &&
      pathBounds.y + pathBounds.height <= visibleBounds.bottom + 1,
    `a narrow queue jump must show the matching result below the summary inside the window: ${JSON.stringify({ pathBounds, visibleBounds })}`);
    await assertBeaconTaskColumns(page);
    await page.screenshot({ animations: "disabled", path: screenshotPath });
  } finally {
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    await page.waitForFunction((width) => (globalThis as unknown as { innerWidth: number }).innerWidth === width, originalSize[0]);
    await queueTab.click();
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
  }
}

async function assertBeaconOutputFocus(page: Page, taskId: string): Promise<void> {
  const article = page.getByRole("article", { name: `Task output ${taskId}`, exact: true });
  await article.waitFor();
  await page.waitForFunction((expectedId) => (
    globalThis as unknown as {
      document: { activeElement: { getAttribute(name: string): string | null } | null };
    }
  ).document.activeElement?.getAttribute("data-task-id") === expectedId, taskId, { timeout: 5_000 });
  const visible = await article.evaluate((element) => {
    const history = element.closest('[aria-label="Beacon task outputs"]')!;
    const bounds = element.getBoundingClientRect();
    const viewport = history.getBoundingClientRect();
    return bounds.top < viewport.bottom && bounds.bottom > viewport.top;
  });
  assert.equal(visible, true, "the focused task output must be visible inside the history scrollport");
}

async function assertBeaconTaskColumns(page: Page): Promise<void> {
  const composer = page.locator('[aria-labelledby="beacon-command-heading"]');
  const controls = page.locator(".beacon-interaction-workspace__controls");
  const card = page.locator(".beacon-task-views");
  assert.equal(await page.getByRole("heading", { name: "Advanced execution", exact: true }).count(), 0,
    "dedicated beacon workspaces must omit advanced execution");
  assert.equal(await page.getByRole("button", { name: /^(Show|Hide) advanced execution$/u }).count(), 0);
  assert.equal(await page.getByRole("heading", { name: "Execution workbench", exact: true }).count(), 0);
  assert.equal(await card.count(), 1, "beacon queue and output must share one card");
  assert.equal(await card.getByRole("tablist", { name: "Beacon task views", exact: true }).count(), 1);
  const [composerBounds, controlsBounds, cardBounds] = await Promise.all([
    composer.boundingBox(), controls.boundingBox(), card.boundingBox(),
  ]);
  assert.ok(composerBounds && controlsBounds && cardBounds, "beacon controls and task views must have measurable layouts");
  const layout = await card.evaluate((element) => {
    const workspace = element.closest(".beacon-workspace")!;
    const viewport = element.closest(".app-content, .interaction-window__content")!;
    const body = workspace.querySelector(".beacon-workspace__body-frame")!;
    const gutter = Number.parseFloat(body.ownerDocument.defaultView!.getComputedStyle(body).paddingBottom);
    return {
      viewportWidth: element.ownerDocument.defaultView!.innerWidth,
      cardOverflow: element.scrollWidth - element.clientWidth,
      workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
      remainingBottom: viewport.getBoundingClientRect().top + viewport.clientHeight - gutter - viewport.scrollTop,
    };
  });
  if (layout.viewportWidth >= 1280) {
    const commandWidthRatio = composerBounds.width / (composerBounds.width + cardBounds.width);
    assert.ok(Math.abs(commandWidthRatio - 0.4) <= 0.002,
      `wide beacon workspaces must split command/task columns 40/60 excluding their gap: ${JSON.stringify({ composerBounds, cardBounds, commandWidthRatio })}`);
    assert.ok(cardBounds.x >= composerBounds.x + composerBounds.width && Math.abs(cardBounds.y - composerBounds.y) <= 1,
      "the task queue/output card must sit in the right column beside the composer");
    assert.ok(Math.abs(cardBounds.y + cardBounds.height - Math.max(controlsBounds.y + controlsBounds.height, layout.remainingBottom)) <= 2,
      `the right task card must fill the controls column or remaining window height in main and popout workspaces: ${JSON.stringify({ cardBounds, controlsBounds, layout })}`);
  } else {
    assert.ok(cardBounds.y >= controlsBounds.y + controlsBounds.height && Math.abs(cardBounds.x - controlsBounds.x) <= 1 &&
      Math.abs(cardBounds.width - controlsBounds.width) <= 1,
    "narrow beacon layouts must stack the task views beneath the controls column");
  }
  assert.ok(layout.cardOverflow <= 1 && layout.workspaceOverflow <= 1,
    `the unified task views must remain inside the available width: ${JSON.stringify(layout)}`);
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
  await assertBeaconTaskColumns(page);
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
    await nativeWindow.evaluate((window, width) => window.setSize(width, 768), originalSize[0]);
    await page.waitForFunction(() => (globalThis as unknown as { innerHeight: number }).innerHeight === 768);
    await assertBeaconHeaderScrollLayout(page, join(screenshotDirectory, `${screenshotPrefix}-scrolled.png`));
    await nativeWindow.evaluate((window, width) => window.setSize(width, 768), narrowWidth);
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, narrowWidth);
    await assertBeaconHeaderLayout(page);
    await assertBeaconTaskColumns(page);
    const overflow = await summary.evaluate((header) => {
      const bounds = header.getBoundingClientRect();
      const paddingRight = Number.parseFloat(header.ownerDocument.defaultView!.getComputedStyle(header).paddingRight);
      return {
        clientWidth: header.clientWidth,
        scrollWidth: header.scrollWidth,
        triggerRight: header.querySelector('button[aria-label="Beacon details"]')!.getBoundingClientRect().right,
        contentRight: bounds.right - paddingRight,
        outsideChildren: Array.from(header.querySelectorAll("h1, p, dt, dd, button") as ArrayLike<typeof header>)
          .filter((child) => {
            const childBounds = child.getBoundingClientRect();
            return childBounds.left < bounds.left - 1 || childBounds.right > bounds.right + 1;
          }).map((child) => child.textContent ?? child.getAttribute("aria-label")),
      };
    });
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1 && overflow.outsideChildren.length === 0,
      `the beacon summary must fit the narrow viewport: ${JSON.stringify(overflow)}`);
    assert.ok(Math.abs(overflow.triggerRight - overflow.contentRight) <= 1,
      "the beacon detail chevron must remain aligned right when narrow header content wraps");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, `${screenshotPrefix}-narrow.png`) });
    await assertBeaconHeaderScrollLayout(page, join(screenshotDirectory, `${screenshotPrefix}-narrow-scrolled.png`));
  } finally {
    await nativeWindow.evaluate((window, size) => window.setSize(size[0]!, size[1]!), originalSize);
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, originalSize[0]);
  }
}

async function assertBeaconHeaderLayout(page: Page): Promise<void> {
  const layout = await page.locator('header[aria-label="Beacon summary"]').evaluate((header) => {
    const summaryBounds = header.getBoundingClientRect();
    const workspace = header.closest(".beacon-workspace")!;
    const container = workspace.querySelector(".beacon-workspace__body-frame")!;
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

async function assertBeaconHeaderScrollLayout(page: Page, screenshotPath: string): Promise<void> {
  const viewport = page.locator(":is(.app-content, .interaction-window__content):has(.beacon-workspace)");
  const sticky = page.locator(".beacon-workspace__sticky");
  const summary = page.locator('header[aria-label="Beacon summary"]');
  const breadcrumbs = page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true });
  const task = page.locator('[aria-labelledby="beacon-command-heading"]');
  const details = page.getByRole("complementary", { name: "Beacon details", exact: true });
  const trigger = summary.getByRole("button", { name: "Beacon details", exact: true });
  const readLayout = async () => summary.evaluate((header) => {
    const scrollport = header.closest(".app-content, .interaction-window__content")!;
    const stickyElement = header.closest(".beacon-workspace__sticky")!;
    const viewportBounds = scrollport.getBoundingClientRect();
    const summaryBounds = header.getBoundingClientRect();
    const view = header.ownerDocument.defaultView!;
    const shadow = view.getComputedStyle(stickyElement, "::after");
    return {
      viewport: {
        top: viewportBounds.top + scrollport.clientTop,
        left: viewportBounds.left + scrollport.clientLeft,
        right: viewportBounds.left + scrollport.clientLeft + scrollport.clientWidth,
        bottom: viewportBounds.top + scrollport.clientTop + scrollport.clientHeight,
      },
      summary: { top: summaryBounds.top, left: summaryBounds.left, right: summaryBounds.right, bottom: summaryBounds.bottom },
      radius: Number.parseFloat(view.getComputedStyle(header).borderTopLeftRadius),
      shadow: { opacity: Number.parseFloat(shadow.opacity), background: shadow.backgroundImage },
      scrollTop: scrollport.scrollTop,
      maximumScroll: scrollport.scrollHeight - scrollport.clientHeight,
    };
  });

  await viewport.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
  await trigger.click();
  await details.waitFor();
  // Finish the disclosure animation before comparing document-flow geometry.
  await page.screenshot({ animations: "disabled" });
  const before = await readLayout();
  const taskBefore = await task.boundingBox();
  assert.ok(taskBefore && before.summary.top > before.viewport.top && before.radius > 0,
    "the resting beacon header must have rounded corners below the breadcrumbs");
  assert.ok(before.summary.left > before.viewport.left && before.summary.right < before.viewport.right,
    "the resting beacon header must retain the workspace gutters");
  assert.equal(before.shadow.opacity, 0, "the beacon header shadow must be hidden before scrolling");
  assert.equal(await sticky.getByRole("complementary", { name: "Beacon details", exact: true }).count(), 0,
    "expanded details must belong to the scrolling body instead of the sticky summary");
  const firstScroll = Math.ceil(before.summary.top - before.viewport.top + 120);
  assert.ok(before.maximumScroll > firstScroll + 40, "the beacon fixture must scroll beyond the header");

  try {
    await viewport.evaluate((element, nextTop) => {
      element.scrollTop = nextTop;
      element.dispatchEvent(new Event("scroll"));
    }, firstScroll);
    await page.locator('.beacon-workspace__sticky[data-stuck="true"]').waitFor();
    const pinned = await readLayout();
    const taskPinned = await task.boundingBox();
    const breadcrumbsPinned = await breadcrumbs.boundingBox();
    assert.ok(Math.abs(pinned.summary.top - pinned.viewport.top) <= 1,
      "the beacon summary must stick to the actual scrollport top");
    assert.ok(Math.abs(pinned.summary.left - pinned.viewport.left) <= 1 &&
      Math.abs(pinned.summary.right - pinned.viewport.right) <= 1,
    `the pinned beacon summary must span the scrollport width: ${JSON.stringify(pinned)}`);
    assert.equal(pinned.radius, 0, "the pinned beacon summary must have square corners");
    assert.match(pinned.shadow.background, /linear-gradient/u, "the pinned beacon header must fade the scrolling content");
    assert.equal(pinned.shadow.opacity, 1, "the pinned beacon header must show its scroll shadow");
    const headerHeightChange = (before.summary.bottom - before.summary.top) - (pinned.summary.bottom - pinned.summary.top);
    assert.ok(taskPinned && Math.abs(taskBefore.y - taskPinned.y - pinned.scrollTop - headerHeightChange) <= 2,
      `the beacon task body must scroll beneath the summary: ${JSON.stringify({ before, pinned, taskBefore, taskPinned })}`);
    assert.ok(breadcrumbsPinned && breadcrumbsPinned.y + breadcrumbsPinned.height <= pinned.viewport.top,
      "beacon breadcrumbs must scroll away above the pinned summary");

    await viewport.evaluate((element, nextTop) => {
      element.scrollTop = nextTop;
      element.dispatchEvent(new Event("scroll"));
    }, firstScroll + 40);
    const further = await readLayout();
    const taskFurther = await task.boundingBox();
    assert.ok(Math.abs(further.summary.top - pinned.summary.top) <= 1 &&
      taskFurther && taskPinned && taskFurther.y < taskPinned.y,
    "further scrolling must move the task body while keeping the beacon summary fixed");
    await page.screenshot({ animations: "disabled", path: screenshotPath });

    for (const control of [
      details.getByRole("switch", { name: "Watch active beacon", exact: true }),
      details.getByRole("button", { name: "Remove beacon", exact: true }),
    ]) {
      await control.evaluate((element) => {
        const scrollport = element.closest(".app-content, .interaction-window__content")!;
        const header = scrollport.querySelector('header[aria-label="Beacon summary"]')!;
        scrollport.scrollTop += element.getBoundingClientRect().top - header.getBoundingClientRect().bottom - 20;
        scrollport.dispatchEvent(new Event("scroll"));
      });
      const expanded = await readLayout();
      const controlBounds = await control.boundingBox();
      assert.ok(Math.abs(expanded.summary.top - expanded.viewport.top) <= 1 && controlBounds &&
        controlBounds.y >= expanded.summary.bottom && controlBounds.y + controlBounds.height <= expanded.viewport.bottom,
      "expanded beacon controls must remain reachable beneath the compact pinned summary");
    }
    await page.screenshot({ animations: "disabled", path: screenshotPath.replace(/\.png$/u, "-expanded.png") });
    await trigger.click();
    await details.waitFor({ state: "hidden" });
  } finally {
    await viewport.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
  }
  const restored = await readLayout();
  assert.ok(Math.abs(restored.summary.top - before.summary.top) <= 1 &&
    Math.abs(restored.summary.left - before.summary.left) <= 1 &&
    Math.abs(restored.summary.right - before.summary.right) <= 1 && restored.radius === before.radius,
  "scrolling to the top must restore the beacon header position, gutters, and rounded corners");
  assert.equal(restored.shadow.opacity, 0, "scrolling to the top must hide the beacon header shadow");
}

async function scrollBeaconWorkspaceToBottom(page: Page): Promise<void> {
  await page.locator(":is(.app-content, .interaction-window__content):has(.beacon-workspace)").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.locator('.beacon-workspace__sticky[data-stuck="true"]').waitFor();
}

async function assertBeaconWorkspaceScrollReset(page: Page): Promise<void> {
  await page.locator('.beacon-workspace__sticky[data-stuck="false"]').waitFor();
  const scrollTop = await page.locator(":is(.app-content, .interaction-window__content):has(.beacon-workspace)")
    .evaluate((element) => element.scrollTop);
  assert.equal(scrollTop, 0, "switching the exact beacon must restore the workspace scroll position");
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

async function writeBeaconExecutionFixtures(root: string): Promise<void> {
  const bofDirectory = join(root, "extensions", "sa-nslookup");
  const platforms = [{ os: "darwin", arch: "arm64" }, { os: "linux", arch: "amd64" }, { os: "windows", arch: "amd64" }];
  const files = [];
  for (const platform of platforms) {
    const directory = join(bofDirectory, "dist", platform.os, platform.arch);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "nslookup.o"), "inert-sa-nslookup-bof-object", { mode: 0o600 });
    files.push({ ...platform, path: `/dist/${platform.os}/${platform.arch}/nslookup.o` });
  }
  await writeFile(join(bofDirectory, "extension.json"), JSON.stringify({
    name: "sa-nslookup",
    package_name: "sa-nslookup",
    version: "1.0.0",
    commands: [{
      command_name: "sa-nslookup",
      help: "Inert beacon execution argument fixture",
      entrypoint: "go",
      bof_executor: "reflektor",
      files,
      arguments: [{ name: "hostname", type: "string", desc: "Hostname to query", optional: false }],
    }],
  }), { mode: 0o600 });
  const assemblyDirectory = join(root, "aliases", "args-demo");
  await mkdir(join(assemblyDirectory, "dist", "windows", "amd64"), { recursive: true });
  await writeFile(join(assemblyDirectory, "dist", "windows", "amd64", "args-demo.exe"), "inert-armory-dotnet-assembly", { mode: 0o600 });
  await writeFile(join(assemblyDirectory, "alias.json"), JSON.stringify({
    name: "Argument Demo",
    command_name: "args-demo",
    version: "1.0.0",
    help: "Inert beacon .NET argument fixture",
    is_assembly: true,
    files: [{ os: "windows", arch: "amd64", path: "/dist/windows/amd64/args-demo.exe" }],
  }), { mode: 0o600 });
}
