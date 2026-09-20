import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

test("Registry keeps the session page fixed while its keys and values scroll independently", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-registry-layout-e2e-"));
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
  await writeFile(
    join(savedConfigDirectory, "registry-layout-e2e-operator.cfg"),
    fakeOperatorConfig(),
    { mode: 0o600 },
  );

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
        "--registry-layout-fixture",
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
    await page.getByRole("tab", { name: "Registry", exact: true }).click();

    const editor = page.getByRole("region", { name: "Registry editor", exact: true });
    const valuesGrid = page.getByRole("grid", { name: "Registry values in HKCU", exact: true });
    await editor.waitFor();
    await valuesGrid.waitFor();
    await page.getByText("Loaded 100 of 105 subkeys · bounded", { exact: true }).waitFor();
    await page.getByText("Loaded 100 of 105 values · bounded", { exact: true }).waitFor();

    const valueRows = valuesGrid.locator('[data-slot="table-body"] [data-slot="table-row"]');
    assert.equal(await valueRows.count(), 100, "the first Registry page must render all 100 rows eagerly");
    await valuesGrid.getByText("E2EValue001", { exact: true }).waitFor();
    await valuesGrid.getByText("E2EValue100", { exact: true }).waitFor();
    assert.equal(
      await valuesGrid.getByText("E2EValue101", { exact: true }).count(),
      0,
      "Registry must not render entries beyond the first bounded page",
    );

    const sessionPage = page.locator(
      '.app-content:has(> .session-workspace[data-presentation="embedded"])',
    );
    const keyScroll = editor.locator('[data-registry-scroll-region="keys"]');
    const valuesScrollRegion = editor.locator('[data-registry-scroll-region="values"]');
    const valuesScroll = valuesScrollRegion.locator('[data-slot="table-scroll-container"]');
    await keyScroll.waitFor();
    await valuesScroll.waitFor();

    const [pageLayout, editorLayout] = await Promise.all([
      sessionPage.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          scrollRange: element.scrollHeight - element.clientHeight,
          scrollTop: element.scrollTop,
          bottom: element.getBoundingClientRect().bottom,
        };
      }),
      editor.evaluate((element) => ({ bottom: element.getBoundingClientRect().bottom })),
    ]);
    assert.ok(
      pageLayout.scrollRange <= 1 && pageLayout.scrollTop <= 1,
      `Registry must not make the session page scroll; range=${pageLayout.scrollRange}, top=${pageLayout.scrollTop}`,
    );
    assert.ok(
      editorLayout.bottom <= pageLayout.bottom + 1,
      `Registry editor must fit inside the session viewport; editor=${editorLayout.bottom}, viewport=${pageLayout.bottom}`,
    );

    const initialScroll = await scrollState(sessionPage, keyScroll, valuesScroll);
    assert.equal(initialScroll.page, 0);
    assert.equal(initialScroll.keys, 0);
    assert.equal(initialScroll.values, 0);

    const keyMaximum = await scrollToEnd(keyScroll);
    assert.ok(keyMaximum > 0, "the Registry key browser must own vertical scrolling");
    const afterKeys = await scrollState(sessionPage, keyScroll, valuesScroll);
    assert.equal(afterKeys.page, 0, "scrolling Registry keys must not move the session page");
    assert.equal(afterKeys.keys, keyMaximum);
    assert.equal(afterKeys.values, 0, "scrolling Registry keys must not move the values table");

    const valuesMaximum = await scrollToEnd(valuesScroll);
    assert.ok(valuesMaximum > 0, "the Registry values table must own vertical scrolling");
    const afterValues = await scrollState(sessionPage, keyScroll, valuesScroll);
    assert.equal(afterValues.page, 0, "scrolling Registry values must not move the session page");
    assert.equal(afterValues.keys, keyMaximum, "scrolling Registry values must not move the key browser");
    assert.equal(afterValues.values, valuesMaximum);

    await page.getByRole("button", { name: "Load more values", exact: true }).click();
    await page.getByText("Loaded 105 of 105 values", { exact: true }).waitFor();
    await valuesGrid.getByText("E2EValue105", { exact: true }).waitFor();
    assert.equal(await valueRows.count(), 105, "Load more must append the final five Registry rows");
    assert.equal(
      await page.getByRole("button", { name: "Load more values", exact: true }).count(),
      0,
      "Load more must disappear after the full Registry inventory is loaded",
    );
    assert.deepEqual(rendererErrors, []);
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, "session-registry-layout-failure.png"),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function scrollToEnd(locator: Locator): Promise<number> {
  return locator.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
}

async function scrollState(
  sessionPage: Locator,
  keyScroll: Locator,
  valuesScroll: Locator,
): Promise<{ page: number; keys: number; values: number }> {
  const [page, keys, values] = await Promise.all([
    sessionPage.evaluate((element) => element.scrollTop),
    keyScroll.evaluate((element) => element.scrollTop),
    valuesScroll.evaluate((element) => element.scrollTop),
  ]);
  return { page, keys, values };
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "registry-layout-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_REGISTRY_CA_DO_NOT_RENDER",
    certificate: "FAKE_REGISTRY_CERT_DO_NOT_RENDER",
    private_key: "FAKE_REGISTRY_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
