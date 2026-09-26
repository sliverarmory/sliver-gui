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
    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();

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

    await row.getByRole("button", { name: "Interact with m1-beacon", exact: true }).click();
    await page.getByRole("heading", { name: "Async task workspace", exact: true }).waitFor();
    await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
    assert.equal(await table.count(), 0, "the beacon interaction must replace the catalog");
    assert.equal(await page.getByRole("region", { name: "Managed Shells", exact: true }).count(), 0);

    await page.getByRole("button", { name: "Back to live beacons", exact: true }).click();
    await table.getByRole("button", { name: "Interact with m1-beacon", exact: true }).waitFor();
    assert.equal(await inventoryFrame.getByRole("complementary").count(), 0, "returning from Interact must keep the catalog sidebar absent");
    assert.equal(await page.getByRole("heading", { name: "Async task workspace", exact: true }).count(), 0);
    await assertCatalogWidth(page, 1440);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

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
      inventoryAvailable: content(catalog),
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
  `Beacons table must fill the catalog width at ${viewportWidth}px: ${JSON.stringify(layout)}`);
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
