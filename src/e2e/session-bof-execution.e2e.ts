import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import { assertExecutionComposerScrollLayout, assertExecutionOutputLayout } from "./execution-layout-assertions.js";

test("session and beacon BOFs render Armory arguments, dispatch packed invocations, and capture output", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-bof-execution-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const screenshotDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(screenshotDirectory, { recursive: true }),
  ]);
  await writeFile(join(savedConfigDirectory, "bof-execution-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await Promise.all([
    writeBofFixture(consoleClientRootDirectory, "sa-dir", "dir", "inert-sa-dir-bof-object", [
      { name: "targetdir", type: "string", desc: "Directory to list", optional: true, default: "." },
      { name: "subdirs", type: "short", desc: "Include subdirectories", optional: true, default: 0 },
    ]),
    writeBofFixture(consoleClientRootDirectory, "sa-nslookup", "nslookup", "inert-sa-nslookup-bof-object", [
      { name: "hostname", type: "string", desc: "Hostname to query", optional: false },
      { name: "server", type: "string", desc: "DNS server", optional: true },
      { name: "type", type: "short", desc: "Record type", optional: true, default: 1 },
    ]),
  ]);

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
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));

    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    const savedOption = savedConfigurations.getByRole("option", { name: /bof-execution-e2e-operator/iu });
    await savedOption.waitFor();
    if (await savedOption.getAttribute("aria-selected") !== "true") await savedOption.click();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();

    const workspace = page.getByRole("region", { name: "BOF execution history and output" });
    const history = workspace.getByRole("navigation", { name: "BOF execution history" });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF" });
    await form.waitFor();
    assert.equal(await history.getByRole("row").count(), 1);
    assert.equal(await workspace.getByRole("row", { name: "New Execution", exact: true }).count(), 1);

    await selectInstalledBof(page, form, "sa-dir");
    await assertExecutionComposerScrollLayout(form, "Execute an Armory BOF", "BOF execution content", [
      "Refresh BOFs", "Open BOF directory", "Execute",
    ]);
    assert.equal(await form.getByRole("textbox", { name: /targetdir/u }).inputValue(), ".");
    assert.equal(await form.getByRole("spinbutton", { name: /subdirs/u }).inputValue(), "0");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-new-execution.png") });
    await form.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/BOF e2e");
    await form.getByRole("spinbutton", { name: /subdirs/u }).fill("2");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic sa-dir stdout");
    await assertExecutionOutputLayout(workspace, history, workspace.locator('[aria-label="Execution output terminal"]'), "BOF");
    assert.equal(await history.getByRole("row").count(), 2);
    assert.equal(await workspace.getByRole("button", { name: "Save stdout" }).count(), 1);
    assert.equal(await workspace.getByRole("button", { name: "Add stdout to Loot" }).count(), 1);
    await workspace.getByRole("button", { name: "Copy output" }).click();
    await assertClipboard(application, "deterministic sa-dir stdout\n");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-dir-output.png") });

    await history.getByRole("row", { name: "New Execution", exact: true }).click();
    await form.waitFor();
    await selectInstalledBof(page, form, "sa-nslookup");
    assert.equal(await form.getByRole("textbox", { name: /hostname/u }).count(), 1);
    assert.equal(await form.getByRole("spinbutton", { name: /type/u }).inputValue(), "1");
    await form.getByRole("textbox", { name: /hostname/u }).fill("localhost");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic sa-nslookup stdout");
    await workspace.getByRole("radio", { name: "Stderr" }).click();
    await assertOutput(workspace, "deterministic sa-nslookup stderr");
    await workspace.getByRole("button", { name: "Copy output" }).click();
    await assertClipboard(application, "deterministic sa-nslookup stderr\n");
    assert.equal(await history.getByRole("row").count(), 3);
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-bof-nslookup-output.png") });

    const olderExecution = history.getByRole("row").nth(2);
    await olderExecution.scrollIntoViewIfNeeded();
    const olderBounds = await olderExecution.boundingBox();
    assert.ok(olderBounds, "the older BOF history item must be visible");
    const openOlderMenu = async (): Promise<Locator> => {
      await sendNativeContextMenu(application!, page, {
        x: olderBounds.x + olderBounds.width / 2,
        y: olderBounds.y + olderBounds.height / 2,
      });
      const menu = page.getByRole("menu", { name: "Application context menu" });
      await menu.waitFor();
      return menu;
    };
    const copyMenu = await openOlderMenu();
    await copyMenu.getByRole("menuitem", { name: "Copy output", exact: true }).click();
    await assertClipboard(application, "deterministic sa-dir stdout\n");
    await assertOutput(workspace, "deterministic sa-nslookup stderr");
    const lootMenu = await openOlderMenu();
    await lootMenu.getByRole("menuitem", { name: "Add stdout to Loot", exact: true }).click();
    await page.getByText("Output added to Loot", { exact: true }).waitFor();
    assert.equal(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods.filter((name) => name === "lootAdd").length), 1);
    await assertOutput(workspace, "deterministic sa-nslookup stderr");

    const calls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls);
    assert.deepEqual(calls, [
      {
        targetMode: "session", targetId: "m1_session",
        objectSha256: sha256Of("inert-sa-dir-bof-object"),
        objectHex: Buffer.from("inert-sa-dir-bof-object").toString("hex"),
        argumentsHex: packedArguments([stringArgument("/tmp/BOF e2e"), shortArgument(2)]).toString("hex"),
        entrypoint: "go", timeoutSeconds: 60,
      },
      {
        targetMode: "session", targetId: "m1_session",
        objectSha256: sha256Of("inert-sa-nslookup-bof-object"),
        objectHex: Buffer.from("inert-sa-nslookup-bof-object").toString("hex"),
        argumentsHex: packedArguments([stringArgument("localhost"), stringArgument(""), shortArgument(1)]).toString("hex"),
        entrypoint: "go", timeoutSeconds: 60,
      },
    ]);

    await page.locator('[aria-label="Beacons"]:visible').click();
    await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
    await page.getByRole("row", { name: /m1-beacon/iu }).click();
    await page.getByRole("heading", { name: "m1-beacon", exact: true }).waitFor();
    const beaconComposer = page.locator('[aria-labelledby="beacon-command-heading"]');
    await beaconComposer.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
    await beaconComposer.locator('[data-slot="autocomplete-trigger"]').first().click();
    await page.getByRole("searchbox", { name: "Search beacon commands", exact: true }).fill("Execution");
    await page.getByRole("option", { name: /^Execution/iu }).click();
    const executionTypes = beaconComposer.getByRole("tablist", { name: "Execution type", exact: true });
    await executionTypes.getByRole("tab", { name: "BOFs", exact: true }).click();
    const beaconForm = beaconComposer.getByRole("region", { name: "Execute an Armory BOF", exact: true });
    await beaconForm.waitFor();
    await beaconComposer.screenshot({ animations: "disabled", path: join(screenshotDirectory, "beacon-bof-compact-tabs.png") });
    const beaconTasks = page.getByRole("region", { name: "Beacon tasks", exact: true });
    const queueTab = beaconTasks.getByRole("tab", { name: "Task queue", exact: true });
    const outputTab = beaconTasks.getByRole("tab", { name: "Task output", exact: true });
    await beaconTasks.getByRole("grid", { name: "Beacon task queue", exact: true }).waitFor();
    await selectInstalledBof(page, beaconForm, "sa-dir");
    await beaconForm.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/beacon-BOF");
    await beaconComposer.getByRole("button", { name: "Queue task", exact: true }).click();
    await waitForFakeBofTaskCompletion(application);
    const beaconTask = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.tasks.find((task) =>
      task.beaconId === "m1_beacon" && task.description === "CallExtensionReq" && task.state === "completed"));
    assert.ok(beaconTask, "the beacon BOF must complete as an exact asynchronous task");
    await queueTab.click();
    const queueRow = beaconTasks.getByRole("grid", { name: "Beacon task queue", exact: true })
      .getByRole("row").filter({ hasText: beaconTask.id });
    await queueRow.getByText("Completed", { exact: true }).waitFor();
    await queueRow.click();
    assert.equal(await outputTab.getAttribute("aria-selected"), "true", "a completed BOF row must open its task output");
    const output = beaconTasks.getByRole("tabpanel", { name: "Task output", exact: true })
      .getByRole("article", { name: `Task output ${beaconTask.id}`, exact: true });
    await assertOutput(output, "deterministic sa-dir stdout");
    const beaconCalls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls);
    assert.deepEqual(beaconCalls.at(-1), {
      targetMode: "beacon", targetId: "m1_beacon",
      objectSha256: sha256Of("inert-sa-dir-bof-object"),
      objectHex: Buffer.from("inert-sa-dir-bof-object").toString("hex"),
      argumentsHex: packedArguments([stringArgument("/tmp/beacon-BOF"), shortArgument(0)]).toString("hex"),
      entrypoint: "go", timeoutSeconds: 60,
    });
    assert.deepEqual(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.legacyBofCalls), [],
      "a built-in BOF must not register or invoke the legacy loader");
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("BOF history and output sync between the session and its execution pop-out", { timeout: 120_000 }, async () => {
  const fixture = await launchBofPopoutFixture();
  const rendererErrors: string[] = [];
  fixture.application.on("window", (page) => page.on("pageerror", (error) => rendererErrors.push(error.message)));
  try {
    const source = await openSession(fixture.application);
    source.on("pageerror", (error) => rendererErrors.push(error.message));
    await source.getByRole("tab", { name: "Execution", exact: true }).click();
    await source.getByRole("radio", { name: "BOFs", exact: true }).click();
    const sourceWorkspace = source.getByRole("region", { name: "BOF execution history and output", exact: true });
    const sourceHistory = sourceWorkspace.getByRole("navigation", { name: "BOF execution history", exact: true });
    const sourceForm = sourceWorkspace.getByRole("region", { name: "Execute an Armory BOF", exact: true });
    await selectInstalledBof(source, sourceForm, "sa-dir");
    await sourceForm.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/from-main");
    await sourceForm.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(sourceWorkspace, "deterministic sa-dir stdout");
    assert.equal(await sourceHistory.getByRole("row").count(), 2);

    // A new window must load a BOF that ran before the window was opened.
    const [popOut] = await Promise.all([
      fixture.application.waitForEvent("window", { timeout: 15_000 }),
      source.getByRole("button", { name: "Pop out execution", exact: true }).click(),
    ]);
    popOut.setDefaultTimeout(20_000);
    await popOut.getByRole("main", { name: "Standalone Execution window", exact: true }).waitFor();
    await popOut.getByRole("radio", { name: "BOFs", exact: true }).click();
    const popOutWorkspace = popOut.getByRole("region", { name: "BOF execution history and output", exact: true });
    const popOutHistory = popOutWorkspace.getByRole("navigation", { name: "BOF execution history", exact: true });
    const firstInPopOut = popOutHistory.getByRole("row", { name: /sa-dir/u });
    await firstInPopOut.waitFor();
    await firstInPopOut.click();
    await assertOutput(popOutWorkspace, "deterministic sa-dir stdout");
    await popOutWorkspace.getByRole("button", { name: "Copy output", exact: true }).click();
    await assertClipboard(fixture.application, "deterministic sa-dir stdout\n");
    assert.equal(await popOutHistory.getByRole("row").count(), 2);

    await popOutHistory.getByRole("row", { name: "New Execution", exact: true }).click();
    const popOutForm = popOutWorkspace.getByRole("region", { name: "Execute an Armory BOF", exact: true });
    await selectInstalledBof(popOut, popOutForm, "sa-nslookup");
    await popOutForm.getByRole("textbox", { name: /hostname/u }).fill("from-popout.example");
    await popOutForm.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(popOutWorkspace, "deterministic sa-nslookup stdout");

    // The source keeps its selection until the operator selects the peer's run.
    await assertOutput(sourceWorkspace, "deterministic sa-dir stdout");
    const secondInSource = sourceHistory.getByRole("row", { name: /sa-nslookup/u });
    await secondInSource.waitFor();
    await secondInSource.click();
    await assertOutput(sourceWorkspace, "deterministic sa-nslookup stdout");
    await sourceWorkspace.getByRole("button", { name: "Copy output", exact: true }).click();
    await assertClipboard(fixture.application, "deterministic sa-nslookup stdout\n");
    assert.equal(await sourceHistory.getByRole("row").count(), 3);
    assert.equal(await popOutHistory.getByRole("row").count(), 3);
    const calls = await fixture.application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls);
    assert.deepEqual(calls.map((call) => call.argumentsHex), [
      packedArguments([stringArgument("/tmp/from-main"), shortArgument(0)]).toString("hex"),
      packedArguments([stringArgument("from-popout.example"), stringArgument(""), shortArgument(1)]).toString("hex"),
    ], "cross-window synchronization must not dispatch either BOF again or alter its arguments");

    await sourceWorkspace.getByRole("button", { name: "Clear selected", exact: true }).click();
    await popOutHistory.getByRole("row", { name: /sa-nslookup/u }).waitFor({ state: "detached" });
    await assertOutput(popOutWorkspace, "deterministic sa-dir stdout");
    assert.equal(await popOutHistory.getByRole("row").count(), 2);

    await popOutWorkspace.getByRole("button", { name: "Clear history", exact: true }).click();
    await sourceHistory.getByRole("row", { name: /sa-dir/u }).waitFor({ state: "detached" });
    await sourceWorkspace.getByRole("region", { name: "Execute an Armory BOF", exact: true }).waitFor();
    assert.equal(await sourceHistory.getByRole("row").count(), 1);
    assert.equal(await popOutHistory.getByRole("row").count(), 1);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await fixture.application.close().catch(() => undefined);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("an operator-selected BOF directory renders its manifest and dispatches its object and arguments", { timeout: 120_000 }, async () => {
  const fixture = await launchBofPopoutFixture();
  const directory = join(fixture.temporaryRoot, "operator working copy");
  const objectPath = join(directory, "dist", "local.o");
  const marker = "inert-sa-dir-bof-object";
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(objectPath, marker);
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    name: "Local Probe", package_name: "local-probe", version: "1.0.0",
    commands: [{ command_name: "local-probe", help: "Local directory fixture", entrypoint: "go", bof_executor: "reflektor",
      files: [{ os: "darwin", arch: "arm64", path: "/dist/local.o" }],
      arguments: [{ name: "targetdir", type: "string", desc: "Directory to list", optional: false },
        { name: "subdirs", type: "short", desc: "Include subdirectories", optional: true, default: 0 }] }],
  }));
  const rendererErrors: string[] = [];
  try {
    const page = await openSession(fixture.application);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();
    const workspace = page.getByRole("region", { name: "BOF execution history and output", exact: true });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF", exact: true });
    await form.waitFor();
    await fixture.application.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [selectedPath] })) as typeof dialog.showOpenDialog;
    }, directory);
    await form.getByRole("button", { name: "Open BOF directory", exact: true }).click();
    await form.getByRole("textbox", { name: /targetdir/u }).waitFor();
    assert.match(await form.innerText(), /local-probe/u);
    await form.getByRole("textbox", { name: /targetdir/u }).fill("/tmp/local-e2e");
    await form.getByRole("spinbutton", { name: /subdirs/u }).fill("7");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic sa-dir stdout");
    await workspace.getByRole("button", { name: "Copy output", exact: true }).click();
    await assertClipboard(fixture.application, "deterministic sa-dir stdout\n");
    assert.deepEqual(await fixture.application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.bofCalls), [{
      targetMode: "session", targetId: "m1_session",
      objectSha256: sha256Of(marker), objectHex: Buffer.from(marker).toString("hex"),
      argumentsHex: packedArguments([stringArgument("/tmp/local-e2e"), shortArgument(7)]).toString("hex"),
      entrypoint: "go", timeoutSeconds: 60,
    }]);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await fixture.application.close().catch(() => undefined);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows session BOFs dispatch a legacy installed COFF loader", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-legacy-bof-e2e-"));
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
  await writeFile(join(savedConfigDirectory, "legacy-bof-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await writeLegacyBofFixtures(consoleClientRootDirectory);

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
        "--registry-layout-fixture",
        "--bof-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    const savedOption = savedConfigurations.getByRole("option", { name: /legacy-bof-e2e-operator/iu });
    await savedOption.waitFor();
    if (await savedOption.getAttribute("aria-selected") !== "true") await savedOption.click();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("radio", { name: "BOFs", exact: true }).click();

    const workspace = page.getByRole("region", { name: "BOF execution history and output" });
    const form = workspace.getByRole("region", { name: "Execute an Armory BOF" });
    await selectInstalledBof(page, form, "legacy-probe");
    await form.getByRole("textbox", { name: /marker/u }).fill("legacy-e2e");
    await form.getByRole("button", { name: "Execute", exact: true }).click();
    await assertOutput(workspace, "deterministic legacy BOF stdout");

    const object = Buffer.from("inert-legacy-bof-object");
    const inner = packedArguments([stringArgument("legacy-e2e")]);
    const expectedEnvelope = packedArguments([stringArgument("go"), dataArgument(object), dataArgument(inner)]);
    assert.deepEqual(await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.legacyBofCalls), [
      {
        phase: "register", targetMode: "session", targetId: "m1_session",
        loaderHex: Buffer.from("inert-coff-loader").toString("hex"),
        init: "", os: "windows", timeoutSeconds: 60,
      },
      {
        phase: "call", targetMode: "session", targetId: "m1_session",
        loaderHex: Buffer.from("inert-coff-loader").toString("hex"),
        argumentsHex: expectedEnvelope.toString("hex"), exportName: "LoadAndRun", timeoutSeconds: 60,
      },
    ]);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function selectInstalledBof(page: Page, form: Locator, commandName: string): Promise<void> {
  await form.locator('[data-slot="autocomplete-trigger"]').click();
  const search = page.getByRole("searchbox", { name: "Search BOFs", exact: true });
  await search.fill(commandName);
  await page.getByRole("option", { name: new RegExp(commandName, "u") }).click();
}

async function launchBofPopoutFixture(): Promise<{ application: ElectronApplication; temporaryRoot: string }> {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-bof-popout-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([savedConfigDirectory, managedConfigDirectory, userDataDirectory, consoleClientRootDirectory]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(savedConfigDirectory, "bof-popout-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
  await Promise.all([
    writeBofFixture(consoleClientRootDirectory, "sa-dir", "dir", "inert-sa-dir-bof-object", [
      { name: "targetdir", type: "string", desc: "Directory to list", optional: true, default: "." },
      { name: "subdirs", type: "short", desc: "Include subdirectories", optional: true, default: 0 },
    ]),
    writeBofFixture(consoleClientRootDirectory, "sa-nslookup", "nslookup", "inert-sa-nslookup-bof-object", [
      { name: "hostname", type: "string", desc: "Hostname to query", optional: false },
      { name: "server", type: "string", desc: "DNS server", optional: true },
      { name: "type", type: "short", desc: "Record type", optional: true, default: 1 },
    ]),
  ]);
  try {
    const application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/fake-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${savedConfigDirectory}`,
        `--managed-config-directory=${managedConfigDirectory}`,
        `--user-data-directory=${userDataDirectory}`,
        `--console-client-root-directory=${consoleClientRootDirectory}`,
        "--bof-execution-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });
    return { application, temporaryRoot };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function openSession(application: ElectronApplication): Promise<Page> {
  const page = await application.firstWindow();
  page.setDefaultTimeout(20_000);
  const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
  await savedConfigurations.waitFor();
  await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  return page;
}

async function assertOutput(workspace: Locator, text: string): Promise<void> {
  const transcript = workspace.getByLabel("Execution output transcript");
  try {
    await transcript.waitFor({ timeout: 10_000 });
  } catch {
    throw new Error(`BOF output transcript did not appear. Workspace: ${(await workspace.innerText()).slice(0, 2_000)}`);
  }
  assert.match(await transcript.textContent() ?? "", new RegExp(text, "u"));
  await workspace.locator('[aria-label="Execution output terminal"] canvas').waitFor();
}

async function sendNativeContextMenu(
  application: ElectronApplication,
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const sent = await application.evaluate(({ app, BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === input.url);
    if (!window) return false;
    app.focus({ steal: true });
    window.show();
    window.focus();
    window.webContents.focus();
    const event = {
      x: Math.max(0, Math.round(input.x)),
      y: Math.max(0, Math.round(input.y)),
      button: "right" as const,
      clickCount: 1,
    };
    window.webContents.sendInputEvent({ type: "mouseDown", ...event });
    window.webContents.sendInputEvent({ type: "mouseUp", ...event });
    return true;
  }, { ...point, url: page.url() });
  assert.equal(sent, true, `expected a native Electron window for ${page.url()}`);
}

async function assertClipboard(application: ElectronApplication, expected: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  let actual = "";
  do {
    actual = await application.evaluate(({ clipboard }) => clipboard.readText());
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert.equal(actual, expected);
}

async function waitForFakeBofTaskCompletion(application: ElectronApplication): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const complete = await application.evaluate(() =>
      globalThis.__SLIVER_GUI_E2E_STATE__.tasks.some((task) =>
        task.beaconId === "m1_beacon" && task.description === "CallExtensionReq" && task.state === "completed"));
    if (complete) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fake CallExtensionReq task for m1_beacon did not complete");
}

async function writeBofFixture(root: string, name: string, objectName: string, marker: string, args: readonly object[]): Promise<void> {
  const directory = join(root, "extensions", name);
  const artifact = `dist/darwin/arm64/${objectName}.o`;
  await mkdir(join(directory, "dist", "darwin", "arm64"), { recursive: true });
  await writeFile(join(directory, artifact), marker);
  await writeFile(join(directory, "extension.json"), JSON.stringify({
    name,
    package_name: name,
    version: "1.0.0",
    commands: [{
      command_name: name,
      help: `E2E ${name} manifest fixture`,
      entrypoint: "go",
      bof_executor: "reflektor",
      depends_on: "coff-loader",
      files: [{ os: "darwin", arch: "arm64", path: `/${artifact}` }],
      arguments: args,
    }],
  }));
}

async function writeLegacyBofFixtures(root: string): Promise<void> {
  const extensions = join(root, "extensions");
  const loader = join(extensions, "coff-loader");
  const bof = join(extensions, "legacy-probe");
  await Promise.all([mkdir(loader, { recursive: true }), mkdir(join(bof, "dist", "windows", "amd64"), { recursive: true })]);
  await Promise.all([
    writeFile(join(loader, "COFFLoader.x64.dll"), "inert-coff-loader"),
    writeFile(join(loader, "extension.json"), JSON.stringify({
      name: "coff-loader", command_name: "coff-loader", help: "E2E COFF loader",
      entrypoint: "LoadAndRun", files: [{ os: "windows", arch: "amd64", path: "/COFFLoader.x64.dll" }],
    })),
    writeFile(join(bof, "dist", "windows", "amd64", "probe.o"), "inert-legacy-bof-object"),
    writeFile(join(bof, "extension.json"), JSON.stringify({
      name: "legacy-probe", command_name: "legacy-probe", help: "E2E legacy BOF",
      entrypoint: "go", depends_on: "coff-loader", bof_executor: "coff-loader",
      files: [{ os: "windows", arch: "amd64", path: "/dist/windows/amd64/probe.o" }],
      arguments: [{ name: "marker", type: "string", desc: "E2E marker", optional: false }],
    })),
  ]);
}

function packedArguments(argumentsBytes: readonly Buffer[]): Buffer {
  const body = Buffer.concat(argumentsBytes);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

function stringArgument(value: string): Buffer {
  const data = Buffer.from(`${value}\0`, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

function dataArgument(data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(data.length);
  return Buffer.concat([length, data]);
}

function shortArgument(value: number): Buffer {
  const data = Buffer.alloc(2);
  data.writeInt16LE(value);
  return data;
}

function sha256Of(value: string): string {
  // The adapter must name BOF data by SHA-256, as Sliver's console does.
  return createHash("sha256").update(value).digest("hex");
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "bof-execution-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_BOF_CA_DO_NOT_RENDER",
    certificate: "FAKE_BOF_CERT_DO_NOT_RENDER",
    private_key: "FAKE_BOF_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
