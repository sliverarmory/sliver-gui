import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
import type { SliverDesktopAPI } from "../shared/contracts.js";
import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

test("command palette searches live targets by name and opens their workspaces with the keyboard", {
  timeout: 90_000,
}, async (context) => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-palette-targets-e2e-"));
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
  await writeFile(join(savedConfigDirectory, "palette-targets.cfg"), JSON.stringify({
    operator: "palette-targets-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_PALETTE_CA_DO_NOT_RENDER",
    certificate: "FAKE_PALETTE_CERT_DO_NOT_RENDER",
    private_key: "FAKE_PALETTE_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  }), { mode: 0o600 });

  let application: ElectronApplication | undefined;
  let testFailure: unknown;
  const rendererErrors: string[] = [];
  const stopApplication = (): void => { application?.process().kill("SIGTERM"); };
  context.signal.addEventListener("abort", stopApplication, { once: true });
  try {
    // The isolated fake adapter supplies both targets. This test never contacts
    // a Sliver server or submits a command to a real session or beacon.
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
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const nativeWindow = await application.browserWindow(page);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.getByRole("dialog", { name: "Saved configurations" })
      .getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();

    const palette = await openPalette(page);
    const search = palette.getByRole("searchbox", { name: "Search commands", exact: true });
    await search.fill("m1-");
    await palette.getByRole("menuitem", { name: /^m1-session\b/u }).waitFor();
    await palette.getByRole("menuitem", { name: /^m1-beacon\b/u }).waitFor();
    assert.equal(await palette.getByRole("menuitem").count(), 2);
    await palette.getByText("Sessions", { exact: true }).waitFor();
    await palette.getByText("Beacons", { exact: true }).waitFor();
    await page.screenshot({ animations: "disabled", path: join(artifactDirectory, "command-palette-targets.png") });

    await search.fill("m1-session");
    await chooseOnlyResult(search, palette);
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tablist", { name: "Session interaction sections", exact: true }).waitFor();
    await assertActiveTarget(page, "session", "m1_session");

    // A server-side metadata update must refresh an already open palette.
    // Use the typed bridge against the fake adapter so the normal main-owned
    // snapshot event drives the update without adding test-only renderer APIs.
    await openPalette(page);
    await search.fill("renamed-palette-session");
    await palette.getByText("No commands found.", { exact: true }).waitFor();
    const rename = await page.evaluate(async () => (
      (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.submitTargetOperation({
        operationId: "target.rename",
        name: "renamed-palette-session",
      })
    ));
    assert.equal(rename.ok, true, rename.error ?? "the fake session rename should succeed");
    await palette.getByRole("menuitem", { name: /^renamed-palette-session\b/u }).waitFor();
    assert.equal(await palette.getByText("m1-session", { exact: true }).count(), 0);
    await chooseOnlyResult(search, palette);
    await page.getByRole("heading", { name: "renamed-palette-session", exact: true }).waitFor();
    await assertActiveTarget(page, "session", "m1_session");

    await openPalette(page);
    await search.fill("m1-beacon");
    await chooseOnlyResult(search, palette);
    await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    await page.getByRole("heading", { name: "Beacon command", exact: true }).waitFor();
    await page.getByRole("navigation", { name: "Beacon workspace breadcrumbs", exact: true }).waitFor();
    await assertActiveTarget(page, "beacon", "m1_beacon");
    assert.deepEqual(rendererErrors, []);
  } catch (error) {
    testFailure = error;
    throw error;
  } finally {
    context.signal.removeEventListener("abort", stopApplication);
    const failures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "command palette targets", 5_000)
        .catch((error) => failures.push(error));
    }
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error) => failures.push(error));
    if (failures.length > 0) {
      const failure = new AggregateError(failures, "Command palette targets E2E cleanup failed");
      if (testFailure) {
        attachCleanupFailure(testFailure, failure);
        console.error(failure);
      } else throw failure;
    }
  }
});

async function openPalette(page: Page): Promise<Locator> {
  await page.locator('.app-header button[aria-label="Open command palette"]').click();
  const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
  await palette.waitFor();
  return palette;
}

async function chooseOnlyResult(search: Locator, palette: Locator): Promise<void> {
  await palette.getByRole("menuitem").waitFor();
  assert.equal(await palette.getByRole("menuitem").count(), 1);
  await search.press("ArrowDown");
  await search.press("Enter");
  await palette.waitFor({ state: "hidden" });
}

async function assertActiveTarget(page: Page, mode: "session" | "beacon", id: string): Promise<void> {
  const snapshot = await page.evaluate(async () => (
    (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()
  ));
  assert.equal(snapshot.targetContext.activeTarget?.mode, mode);
  assert.equal(snapshot.targetContext.activeTarget?.id, id);
}
