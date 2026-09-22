import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication } from "playwright-core";

import { E2E_AZURE_CREDENTIAL_ID } from "./cloud-deployment-fixture.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("DNS manager browses zones and manages records through the isolated cloud bridge", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-dns-"));
  const artifacts = join(repositoryRoot, "artifacts", "cloud-dns");
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  let failure: unknown;
  try {
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`,
        `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`,
        "--dns-fixture",
      ],
      cwd: repositoryRoot,
      bypassCSP: false,
    });
    const workspace = await application.firstWindow();
    const windowOpened = application.waitForEvent("window");
    await workspace.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Cloud Deployment" }).click();
    const page = await windowOpened;
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (/Content Security Policy/iu.test(message.text())) errors.push(message.text());
    });
    await page.getByRole("tab", { name: /^Servers\s*2$/u }).waitFor();
    const dnsTab = page.getByRole("tab", { name: /^DNS\b/u });
    await page.getByRole("tab", { name: /^DNS\s*3$/u }).waitFor();
    await dnsTab.click();
    await page.getByRole("button", { name: "example.test", exact: true }).waitFor();
    await page.getByRole("button", { name: "second.test", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit www.example.test A", exact: true }).count(), 0,
      "DNS opens with zones before records");
    await page.screenshot({ path: join(artifacts, "zones.png"), animations: "disabled" });

    await page.getByRole("button", { name: "example.test", exact: true }).click();
    await page.getByRole("button", { name: "Edit www.example.test A", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit www.second.test A", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Delete example.test NS", exact: true }).count(), 0);
    await page.screenshot({ path: join(artifacts, "zone-records.png"), animations: "disabled" });

    await page.getByRole("button", { name: "All records", exact: true }).click();
    await page.getByRole("button", { name: "Edit www.second.test A", exact: true }).waitFor();
    await page.getByRole("button", { name: "Edit www.example.test A", exact: true }).waitFor();
    const [deleteBounds, toolbarBounds] = await Promise.all([
      page.getByRole("button", { name: "Delete www.example.test A", exact: true }).boundingBox(),
      page.getByRole("button", { name: "Add record", exact: true }).boundingBox(),
    ]);
    assert.ok(deleteBounds && toolbarBounds && deleteBounds.x + deleteBounds.width <= toolbarBounds.x + toolbarBounds.width + 1,
      "record actions must fit within the DNS content at the default window width");
    await page.screenshot({ path: join(artifacts, "all-records.png"), animations: "disabled" });

    await page.getByRole("button", { name: "Add record", exact: true }).click();
    const create = page.getByRole("dialog", { name: "Add DNS Record", exact: true });
    await create.getByLabel("Record name", { exact: true }).fill("qa");
    await create.getByLabel("Values", { exact: true }).fill("192.0.2.44");
    await page.screenshot({ path: join(artifacts, "add-record.png"), animations: "disabled" });
    await create.getByRole("button", { name: "Add record", exact: true }).click();
    await create.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Edit qa.example.test A", exact: true }).click();
    const edit = page.getByRole("dialog", { name: "Edit DNS Record", exact: true });
    await edit.getByLabel("TTL (seconds)", { exact: true }).fill("600");
    await edit.getByLabel("Values", { exact: true }).fill("192.0.2.45\n192.0.2.46");
    await edit.getByRole("button", { name: "Save changes", exact: true }).click();
    await edit.waitFor({ state: "hidden" });
    await page.getByText("192.0.2.45", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Delete qa.example.test A", exact: true }).click();
    const remove = page.getByRole("dialog", { name: "Delete DNS Record", exact: true });
    await remove.getByRole("button", { name: "Delete record", exact: true }).click();
    await remove.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Edit qa.example.test A", exact: true }).waitFor({ state: "hidden" });

    await page.getByRole("combobox", { name: "DNS account", exact: true }).selectOption(E2E_AZURE_CREDENTIAL_ID);
    await page.getByRole("button", { name: "azure.test", exact: true }).waitFor();
    await page.getByRole("button", { name: "azure.test", exact: true }).click();
    await page.getByRole("button", { name: "Edit www.azure.test A", exact: true }).waitFor();
    await page.screenshot({ path: join(artifacts, "azure-records.png"), animations: "disabled" });
    assert.deepEqual(errors, []);
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls), 0,
      "DNS fixture must never connect to an operator server");
  } catch (error) {
    failure = error;
    if (application) {
      const page = application.windows().find((candidate) => candidate.url().includes("surface=cloud-deployment"));
      await page?.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => undefined);
    }
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) await cleanupOwnedApplication(application, "DNS manager", 5_000).catch((error) => cleanupFailures.push(error));
    await rm(root, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "DNS E2E cleanup failed");
      if (failure) attachCleanupFailure(failure, cleanupError);
      else throw cleanupError;
    }
  }
});
