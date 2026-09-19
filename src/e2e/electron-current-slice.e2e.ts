import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import {
  IPC,
  IPC_INVOKE,
  SLIVER_DESKTOP_NON_INVOKE_API_KEYS,
  type SliverDesktopAPI,
  type SliverSnapshot,
} from "../shared/contracts.js";
import type { ApplicationSettingsState } from "../shared/application-settings-contracts.js";
import {
  CLOUD_DEPLOYMENT_IPC_INVOKE,
  type CloudDeploymentAPI,
} from "../shared/cloud-deployment-ipc.js";
import { CONSOLE_MAX_TABS_PER_WINDOW } from "../shared/console-contracts.js";
import type { SliverReleaseDownloadEvent } from "../shared/release-contracts.js";
import type { TargetOperationRecord } from "../shared/operation-contracts.js";
import type { SessionShellResourceList } from "../shared/stream-contracts.js";
import type { TargetRef } from "../shared/target-contracts.js";
import { readElectronSnapshot } from "./read-electron-snapshot.js";
import {
  E2E_AWS_DEPLOYMENT,
  E2E_AWS_DEPLOYMENT_ID,
  E2E_AWS_DEPLOYMENT_NAME,
  E2E_AZURE_CREDENTIAL_ID,
  E2E_AZURE_DEPLOYMENT,
  E2E_AZURE_DEPLOYMENT_ID,
  E2E_AZURE_DEPLOYMENT_NAME,
  E2E_AZURE_SUBSCRIPTION_ID,
  E2E_AZURE_TENANT_ID,
} from "./cloud-deployment-fixture.js";

const PRIVATE_KEY_SECRET = "FAKE_PRIVATE_KEY_M0_DO_NOT_RENDER";
const TOKEN_SECRET = "FAKE_TOKEN_M0_DO_NOT_RENDER";
const EVENT_SECRET = "FAKE_EVENT_SECRET_M0_DO_NOT_RENDER";
const TARGET_SECRET = "FAKE_TARGET_SECRET_M1_DO_NOT_RENDER";
const TASK_SECRET = "FAKE_TASK_REQUEST_SECRET_M1_DO_NOT_RENDER";
const M2_ENV_SECRET = "FAKE_M2_ENV_SECRET_DO_NOT_RENDER";
const M2_FILE_CONTENT = "FAKE_M2_FILE_CONTENT_DO_NOT_JOURNAL";
const M2_INITIAL_FILE_TEXT = `${M2_FILE_CONTENT}\nsecond deterministic line\n`;
const M2_EDITED_CONTENT = "FAKE_M2_EDITED_CONTENT_DO_NOT_JOURNAL";
const M2_SEARCH_PATTERN = "FAKE_M2_SEARCH_PATTERN_DO_NOT_JOURNAL";
const M6_LOOT_CONTENT = "FAKE_M6_LOOT_CONTENT_DO_NOT_PERSIST_IN_RENDERER";
const M6_CREDENTIAL_SECRET = "FAKE_M6_CREDENTIAL_SECRET_DO_NOT_RENDER_BY_DEFAULT";
const M4_PRIVATE_KEY_SECRET = "FAKE_M4_PRIVATE_KEY_SECRET_DO_NOT_RENDER";
const M4_SSH_STDOUT_TEXT = "deterministic M4 SSH stdout";
const M4_SSH_STDOUT = `${M4_SSH_STDOUT_TEXT}\n`;
const M4_PRIVATE_KEY_CONTENT = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  M4_PRIVATE_KEY_SECRET,
  "-----END OPENSSH PRIVATE KEY-----",
  "",
].join("\n");

test("real renderer reaches an injected fake only through frozen preload and trusted IPC", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-electron-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const consoleClientRootMarker = join(consoleClientRootDirectory, "installed-armory-package.marker");
  const selectedConfigPath = join(temporaryRoot, "chosen-m0-operator.cfg");
  const savedExistingConfigPath = join(savedConfigDirectory, "existing-m0-operator.cfg");
  const m4PrivateKeyPath = join(temporaryRoot, "m4-e2e-private.key");
  const m4SavedOutputPath = join(temporaryRoot, "m4-ssh-stdout.txt");
  const m6LootInputPath = join(temporaryRoot, "m6-loot-input.txt");
  const m6LootSavedPath = join(temporaryRoot, "m6-loot-saved.txt");
  const artifactDirectory = join(repositoryRoot, "artifacts", "e2e");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(artifactDirectory, { recursive: true }),
  ]);
  await writeFile(consoleClientRootMarker, "preserve shared client assets", { mode: 0o600 });
  await Promise.all([
    writeFile(selectedConfigPath, fakeOperatorConfig(), { mode: 0o600 }),
    writeFile(savedExistingConfigPath, fakeOperatorConfig(), { mode: 0o600 }),
  ]);
  await writeFile(m4PrivateKeyPath, M4_PRIVATE_KEY_CONTENT, { mode: 0o600 });
  await writeFile(m6LootInputPath, M6_LOOT_CONTENT, { mode: 0o600 });

  let electronApplication: ElectronApplication | undefined;
  let page: Page | undefined;
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const stylePolicyViolations: Array<{ url: string; message: string }> = [];
  const observedPages = new Set<Page>();
  const observeStylePolicy = (renderer: Page): void => {
    if (observedPages.has(renderer)) return;
    observedPages.add(renderer);
    renderer.on("console", (message) => {
      const text = message.text();
      if (/Content Security Policy/iu.test(text) && /style-src/iu.test(text)) {
        stylePolicyViolations.push({ url: renderer.url(), message: text });
      }
    });
  };
  try {
    electronApplication = await electron.launch({
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
    electronApplication.on("window", observeStylePolicy);
    for (const renderer of electronApplication.windows()) observeStylePolicy(renderer);
    page = await electronApplication.firstWindow();
    observeStylePolicy(page);
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await assertRendererSecurity(electronApplication, page);
    await page.getByRole("dialog", { name: "Saved configurations" }).waitFor();
    await verifyCloudDeploymentWindow(electronApplication, page, artifactDirectory);
    await verifyReleaseDownloadToast(electronApplication, page);
    await verifyApplicationContextMenu(electronApplication, page);

    // Replace the native chooser from outside the app immediately before the
    // production renderer invokes it. No production switch or debug IPC is
    // needed for this deterministic selection.
    await electronApplication.evaluate(({ dialog }, configPath) => {
      dialog.showOpenDialog = async () => {
        globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
        return { canceled: false, filePaths: [configPath] };
      };
    }, selectedConfigPath);
    await page.getByRole("button", {
      name: /choose.*file|open file|connect (?:from |external )file/i,
    }).click();

    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Jobs & listeners"]:visible').click();
    await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
    assert.equal(await page.getByRole("dialog", { name: "Server version mismatch" }).count(), 0);
    await page.getByText("#41", { exact: true }).waitFor();
    await page.getByText("Seeded mTLS listener", { exact: true }).waitFor();
    await assertJobActionColumnSurface(page, 41);
    await verifyCollapsedSidebar(page, artifactDirectory);

    const stateAfterConnect = await readFakeState(electronApplication);
    assert.equal(stateAfterConnect.configFactoryCalls, 1);
    assert.equal(stateAfterConnect.dialogCalls, 1);
    assert.deepEqual(stateAfterConnect.connectedConfig, {
      operator: "m0-e2e-operator",
      host: "127.0.0.1",
      port: 31337,
    });
    for (const method of ["connect", "getVersion", "jobs", "implantBuilds", "implantProfiles", "getCompiler"]) {
      assert.ok(stateAfterConnect.methods.includes(method), `expected ConnectionRegistry to call ${method}`);
    }

    await verifyApplicationSettings(electronApplication, page, artifactDirectory);

    await verifySliverConsoleWindow(
      electronApplication,
      page,
      fakeOperatorConfig(),
      artifactDirectory,
      consoleClientRootDirectory,
      consoleClientRootMarker,
    );

    await verifyM1TargetsAndOperations(
      electronApplication,
      page,
      artifactDirectory,
      m4PrivateKeyPath,
      m4SavedOutputPath,
    );

    await startAndStopMtlsListener(page);
    const stateAfterStop = await readFakeState(electronApplication);
    assert.ok(stateAfterStop.methods.includes("startMTLSListener"));
    assert.ok(stateAfterStop.methods.includes("killJob"));

    await verifyOperatorDataStores(
      electronApplication,
      page,
      artifactDirectory,
      m6LootInputPath,
      m6LootSavedPath,
    );

    const snapshotText = await page.evaluate(async () => {
      const browserGlobal = globalThis as unknown as {
        sliver: { getSnapshot(): Promise<unknown> };
      };
      return JSON.stringify(await browserGlobal.sliver.getSnapshot());
    });
    const bodyText = await page.locator("body").innerText();
    const screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "current-slice.png"),
    });
    const observableText = [bodyText, snapshotText, ...consoleMessages].join("\n");
    for (const forbidden of [
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      EVENT_SECRET,
      TARGET_SECRET,
      TASK_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
      M6_LOOT_CONTENT,
      M6_CREDENTIAL_SECRET,
      M4_PRIVATE_KEY_SECRET,
      M4_SSH_STDOUT_TEXT,
      "/Users/e2e/workspace/notes.txt",
      selectedConfigPath,
      m4PrivateKeyPath,
      m4SavedOutputPath,
    ]) {
      assert.ok(!observableText.includes(forbidden), `renderer-visible text exposed ${forbidden}`);
      assert.equal(screenshot.includes(Buffer.from(forbidden)), false, `screenshot bytes exposed ${forbidden}`);
    }
    assert.deepEqual(pageErrors, []);

    await page.getByRole("button", { name: /^Current server:/i }).click();
    assert.deepEqual(await page.getByRole("menuitem").allTextContents(), [
      "Exit app",
      "Disconnect",
      "Switch config",
      "Settings",
    ]);
    await page.getByRole("menuitem", { name: "Disconnect" }).click();
    await page.getByText("No server connected", { exact: true }).waitFor();
    assert.equal((await readFakeState(electronApplication)).disconnects, 1);
    assert.deepEqual(stylePolicyViolations, [], "all renderer surfaces must preserve styles under CSP");
  } catch (error) {
    process.stderr.write(`Style CSP violations: ${JSON.stringify(stylePolicyViolations)}\n`);
    if (page && !page.isClosed()) {
      await page.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, "current-slice-failure.png"),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    await electronApplication?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function verifyApplicationContextMenu(
  electronApplication: ElectronApplication,
  page: Page,
): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Saved configurations" });
  await dialog.getByRole("button", { name: "Import a copy" }).click();
  const input = dialog.getByRole("textbox", { name: "Local configuration name" });
  const value = "context menu selection";
  const menu = page.getByRole("menu", { name: "Application context menu" });
  const readSelection = () => input.evaluate((element) => {
    const control = element as typeof element & {
      selectionStart: number | null;
      selectionEnd: number | null;
    };
    const browserDocument = (globalThis as unknown as {
      document: { activeElement: unknown };
    }).document;
    return {
      focused: browserDocument.activeElement === control,
      start: control.selectionStart,
      end: control.selectionEnd,
    };
  });
  const originalClipboardText = await readClipboardText(electronApplication);

  try {
    await input.fill(value);
    await input.evaluate((element) => {
      const control = element as typeof element & {
        focus(): void;
        setSelectionRange(start: number, end: number): void;
      };
      control.focus();
      control.setSelectionRange(4, 4);
    });

    await input.click({ button: "right", position: { x: 8, y: 8 } });
    await menu.waitFor();
    for (const label of [
      "Undo",
      "Redo",
      "Cut",
      "Copy",
      "Paste",
      "Paste and Match Style",
      "Delete",
      "Select All",
      "Inspect Element",
    ]) {
      assert.equal(
        await menu.getByRole("menuitem", { name: label, exact: true }).count(),
        1,
        `expected the HeroUI context menu to expose ${label}`,
      );
    }

    const selectAll = menu.getByRole("menuitem", { name: "Select All", exact: true });
    assert.notEqual(await selectAll.getAttribute("aria-disabled"), "true");
    await selectAll.click();
    await menu.waitFor({ state: "hidden" });
    const selectionDeadline = Date.now() + 5_000;
    let selection = await readSelection();
    while (
      Date.now() < selectionDeadline &&
      (!selection.focused || selection.start !== 0 || selection.end !== value.length)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      selection = await readSelection();
    }
    assert.deepEqual(selection, { focused: true, start: 0, end: value.length });
    await new Promise((resolve) => setTimeout(resolve, 100));

    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    assert.deepEqual(await readSelection(), {
      focused: false,
      start: 0,
      end: value.length,
    });
    const copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
    assert.notEqual(await copy.getAttribute("aria-disabled"), "true");
    await copy.click();
    await menu.waitFor({ state: "hidden" });
    const copyDeadline = Date.now() + 5_000;
    let copied = false;
    while (Date.now() < copyDeadline && !copied) {
      copied = await readClipboardText(electronApplication) === value;
      if (!copied) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(copied, true, "context-menu Copy should reach the native clipboard");

    const pastedValue = "context menu pasted value";
    await electronApplication.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      pastedValue,
    );
    await input.evaluate((element) => {
      const control = element as typeof element & {
        focus(): void;
        select(): void;
      };
      control.focus();
      control.select();
    });
    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const paste = menu.getByRole("menuitem", { name: "Paste", exact: true });
    assert.notEqual(await paste.getAttribute("aria-disabled"), "true");
    await paste.click();
    await menu.waitFor({ state: "hidden" });
    const pasteDeadline = Date.now() + 5_000;
    let pasted = false;
    while (Date.now() < pasteDeadline && !pasted) {
      pasted = await input.inputValue() === pastedValue;
      if (!pasted) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(pasted, true, "context-menu Paste should replace the selected input value");

    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const undo = menu.getByRole("menuitem", { name: "Undo", exact: true });
    assert.notEqual(await undo.getAttribute("aria-disabled"), "true");
    await undo.click();
    await menu.waitFor({ state: "hidden" });
    const undoDeadline = Date.now() + 5_000;
    let undone = false;
    while (Date.now() < undoDeadline && !undone) {
      undone = await input.inputValue() === value;
      if (!undone) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(undone, true, "context-menu Undo should restore the previous input value");

    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const redo = menu.getByRole("menuitem", { name: "Redo", exact: true });
    assert.notEqual(await redo.getAttribute("aria-disabled"), "true");
    await redo.click();
    await menu.waitFor({ state: "hidden" });
    const redoDeadline = Date.now() + 5_000;
    let redone = false;
    while (Date.now() < redoDeadline && !redone) {
      redone = await input.inputValue() === pastedValue;
      if (!redone) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(redone, true, "context-menu Redo should restore the pasted input value");

    await electronApplication.evaluate(
      ({ clipboard }) => clipboard.writeText("clipboard-before-context-menu-cut"),
    );
    await input.evaluate((element) => {
      const control = element as typeof element & {
        focus(): void;
        select(): void;
      };
      control.focus();
      control.select();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await readSelection(), {
      focused: true,
      start: 0,
      end: pastedValue.length,
    });
    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    assert.deepEqual(await readSelection(), {
      focused: false,
      start: 0,
      end: pastedValue.length,
    });
    const cut = menu.getByRole("menuitem", { name: "Cut", exact: true });
    assert.notEqual(await cut.getAttribute("aria-disabled"), "true");
    await cut.click();
    await menu.waitFor({ state: "hidden" });
    const cutDeadline = Date.now() + 5_000;
    let cutInputCleared = false;
    let cutCopied = false;
    while (Date.now() < cutDeadline && (!cutInputCleared || !cutCopied)) {
      cutInputCleared = await input.inputValue() === "";
      cutCopied = await readClipboardText(electronApplication) === pastedValue;
      if (!cutInputCleared || !cutCopied) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(cutCopied, true, "context-menu Cut should copy the selection");
    assert.equal(cutInputCleared, true, "context-menu Cut should remove the selection");

    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const undoCut = menu.getByRole("menuitem", { name: "Undo", exact: true });
    assert.notEqual(await undoCut.getAttribute("aria-disabled"), "true");
    await undoCut.click();
    await menu.waitFor({ state: "hidden" });
    const undoCutDeadline = Date.now() + 5_000;
    let cutUndone = false;
    while (Date.now() < undoCutDeadline && !cutUndone) {
      cutUndone = await input.inputValue() === pastedValue;
      if (!cutUndone) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(cutUndone, true, "context-menu Cut should remain in Chromium's undo history");

    const unicodeValue = "A😀B";
    await input.fill(unicodeValue);
    await input.evaluate((element) => {
      const control = element as typeof element & {
        focus(): void;
        setSelectionRange(start: number, end: number): void;
      };
      control.focus();
      control.select();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const deleteSelection = menu.getByRole("menuitem", { name: "Delete", exact: true });
    assert.notEqual(await deleteSelection.getAttribute("aria-disabled"), "true");
    await deleteSelection.click();
    await menu.waitFor({ state: "hidden" });
    const deleteDeadline = Date.now() + 5_000;
    let unicodeDeleted = false;
    while (Date.now() < deleteDeadline && !unicodeDeleted) {
      unicodeDeleted = await input.inputValue() === "";
      if (!unicodeDeleted) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      unicodeDeleted,
      true,
      `context-menu Delete should remove selected Unicode text; observed ${JSON.stringify({
        selection: await readSelection(),
        value: await input.inputValue(),
      })}`,
    );

    await input.click({ button: "right", position: { x: 24, y: 8 } });
    await menu.waitFor();
    const undoDelete = menu.getByRole("menuitem", { name: "Undo", exact: true });
    assert.notEqual(await undoDelete.getAttribute("aria-disabled"), "true");
    await undoDelete.click();
    await menu.waitFor({ state: "hidden" });
    const undoDeleteDeadline = Date.now() + 5_000;
    let deleteUndone = false;
    while (Date.now() < undoDeleteDeadline && !deleteUndone) {
      deleteUndone = await input.inputValue() === unicodeValue;
      if (!deleteUndone) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(deleteUndone, true, "context-menu Delete should remain in Chromium's undo history");
  } finally {
    await electronApplication.evaluate(
      ({ clipboard }, text) => clipboard.writeText(text),
      originalClipboardText,
    );
  }

  await dialog.getByRole("button", { name: "Cancel import" }).click();
}

async function verifyCloudDeploymentWindow(
  electronApplication: ElectronApplication,
  workspacePage: Page,
  artifactDirectory: string,
): Promise<void> {
  const dialog = workspacePage.getByRole("dialog", { name: "Saved configurations" });
  const forget = dialog.getByRole("button", { name: "Forget" });
  const cloudDeployment = dialog.getByRole("button", { name: "Cloud Deployment" });
  const cancel = dialog.getByRole("button", { name: "Cancel" });
  const connect = dialog.getByRole("button", { name: "Connect", exact: true });
  const [forgetBox, cloudBox, cancelBox, connectBox] = await Promise.all([
    forget.boundingBox(),
    cloudDeployment.boundingBox(),
    cancel.boundingBox(),
    connect.boundingBox(),
  ]);
  if (!forgetBox || !cloudBox || !cancelBox || !connectBox) {
    throw new Error("Expected both saved-configuration action rows to be visible");
  }
  assert.ok(Math.abs(forgetBox.x - cloudBox.x) < 1, "Forget and Cloud Deployment must share a left edge");
  assert.ok(cloudBox.y > forgetBox.y, "Cloud Deployment must be below Forget");
  assert.ok(Math.abs(cloudBox.y - cancelBox.y) < 1, "Cloud Deployment and Cancel must share a row");
  assert.ok(Math.abs(cloudBox.y - connectBox.y) < 1, "Cloud Deployment and Connect must share a row");

  const initialWindowCount = electronApplication.windows().filter((candidate) => !candidate.isClosed()).length;
  await invokeApplicationMenuItem(
    electronApplication,
    `cloud.azure.${E2E_AZURE_DEPLOYMENT_ID}.firewall`,
  );
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  const coldAzureFirewallPage = await cloudDeploymentPage(electronApplication);
  await assertAzureFirewallDetails(coldAzureFirewallPage, artifactDirectory);
  await coldAzureFirewallPage.close();
  await waitForWindowCount(electronApplication, initialWindowCount);

  await invokeApplicationMenuItem(
    electronApplication,
    `cloud.aws.${E2E_AWS_DEPLOYMENT_ID}.firewall`,
  );
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  const coldFirewallPage = await cloudDeploymentPage(electronApplication);
  await assertAwsFirewallDetails(coldFirewallPage);
  await coldFirewallPage.close();
  await waitForWindowCount(electronApplication, initialWindowCount);

  await cloudDeployment.click();
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  const firstCloudPage = await cloudDeploymentPage(electronApplication);
  await assertCloudDeploymentSurface(electronApplication, firstCloudPage);
  await verifyManagedServerOperatorControls(firstCloudPage, artifactDirectory);
  await verifyAzureLoginForm(firstCloudPage, artifactDirectory);
  await invokeApplicationMenuItem(
    electronApplication,
    `cloud.aws.${E2E_AWS_DEPLOYMENT_ID}.firewall`,
  );
  await assertAwsFirewallDetails(firstCloudPage, artifactDirectory);
  await firstCloudPage.getByRole("button", { name: "Back to managed servers" }).click();
  await firstCloudPage.getByRole("heading", { name: "Cloud Deployment", exact: true }).waitFor();
  await verifyAwsDeploymentWizard(firstCloudPage, artifactDirectory);
  await assertCloudDeploymentThemeSync(electronApplication, workspacePage, firstCloudPage);
  await verifySshTerminalClipboard(electronApplication, firstCloudPage);
  const firstWindowId = await cloudDeploymentWindowId(electronApplication);

  await invokeApplicationMenuItem(electronApplication, "cloud.deployment");
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  assert.equal(await cloudDeploymentWindowId(electronApplication), firstWindowId);

  await workspacePage.bringToFront();
  await cloudDeployment.click();
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  assert.equal(await cloudDeploymentWindowId(electronApplication), firstWindowId);

  await firstCloudPage.close();
  await waitForWindowCount(electronApplication, initialWindowCount);
  await invokeApplicationMenuItem(electronApplication, "cloud.deployment");
  await waitForWindowCount(electronApplication, initialWindowCount + 1);
  const reopenedCloudPage = await cloudDeploymentPage(electronApplication);
  await assertCloudDeploymentSurface(electronApplication, reopenedCloudPage);
  const reopenedWindowId = await cloudDeploymentWindowId(electronApplication);
  assert.notEqual(reopenedWindowId, firstWindowId);

  await electronApplication.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try {
        return new URL(candidate.webContents.getURL()).search === "?surface=cloud-deployment";
      } catch {
        return false;
      }
    });
    if (!window) throw new Error("Expected a Cloud Deployment BrowserWindow to retire");
    (window.webContents as unknown as {
      emit(name: string, event: unknown, details: unknown): void;
    }).emit("render-process-gone", {}, { reason: "crashed", exitCode: 1 });
  });
  await waitForWindowCount(electronApplication, initialWindowCount);
  await invokeApplicationMenuItem(electronApplication, "cloud.deployment");
  const recoveredCloudPage = await cloudDeploymentPage(electronApplication);
  await assertCloudDeploymentSurface(electronApplication, recoveredCloudPage);
  assert.notEqual(await cloudDeploymentWindowId(electronApplication), reopenedWindowId);
  await recoveredCloudPage.close();
  await waitForWindowCount(electronApplication, initialWindowCount);
}

async function verifyManagedServerOperatorControls(
  cloudPage: Page,
  artifactDirectory: string,
): Promise<void> {
  await cloudPage.getByRole("button", {
    name: `Server actions for ${E2E_AWS_DEPLOYMENT_NAME}`,
    exact: true,
  }).click();
  const actions = cloudPage.getByRole("menu", {
    name: `Server actions for ${E2E_AWS_DEPLOYMENT_NAME}`,
    exact: true,
  });
  await actions.waitFor();
  assert.deepEqual(await actions.getByRole("menuitem").allTextContents(), [
    "Rename",
    "Stop",
    "Reboot",
    "Terminate",
  ]);
  await cloudPage.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "cloud-managed-server-actions.png"),
    fullPage: true,
  });
  await cloudPage.keyboard.press("Escape");
  await actions.waitFor({ state: "hidden" });

  await cloudPage.getByRole("button", {
    name: `New Operator for ${E2E_AWS_DEPLOYMENT_NAME}`,
    exact: true,
  }).click();
  await cloudPage.getByRole("heading", { level: 1, name: "New Operator", exact: true }).waitFor();
  const form = cloudPage.getByRole("form", {
    name: `New Operator for ${E2E_AWS_DEPLOYMENT_NAME}`,
    exact: true,
  });
  const permissions = form.getByRole("combobox", { name: "Permissions", exact: true });
  const publicIp = form.getByLabel("Public IP", { exact: true });
  const port = form.getByLabel("Port", { exact: true });
  assert.equal(await permissions.inputValue(), "all");
  assert.deepEqual(await permissions.getByRole("option").allTextContents(), [
    "Full access",
    "Remote builder",
    "Crackstation",
  ]);
  assert.equal(await publicIp.inputValue(), "198.51.100.24");
  assert.equal(await port.inputValue(), "31337");
  await form.getByRole("textbox", { name: "Operator Name" }).fill("e2e_operator");
  await permissions.selectOption("builder");
  await publicIp.fill("203.0.113.80");
  await port.fill("44331");
  assert.equal(await form.getByRole("button", { name: "Create Operator", exact: true }).isEnabled(), true);
  await cloudPage.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "cloud-new-operator.png"),
    fullPage: true,
  });
  await cloudPage.getByRole("button", { name: "Back to managed servers", exact: true }).click();
  await cloudPage.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor();
}

async function verifyAzureLoginForm(cloudPage: Page, artifactDirectory: string): Promise<void> {
  await cloudPage.getByRole("tab", { name: /^Credentials/u }).click();
  await cloudPage.getByRole("button", { name: "Add Credential", exact: true }).click();
  await cloudPage.getByRole("combobox", { name: "Provider", exact: true }).selectOption("azure");
  await cloudPage.getByRole("combobox", { name: "Azure Authentication", exact: true }).selectOption("login");
  await cloudPage.getByRole("textbox", { name: "Directory (Tenant) ID", exact: true }).waitFor();
  await cloudPage.getByRole("textbox", { name: "Application (Client) ID", exact: true }).waitFor();
  assert.equal(await cloudPage.getByRole("button", { name: "Save Credential", exact: true }).isDisabled(), true);

  // The fixture refuses real authentication. This still exercises the native
  // renderer -> preload -> trusted main handler and its error recovery.
  await cloudPage.getByRole("button", { name: "Sign In to Azure", exact: true }).click();
  await cloudPage.getByText("Azure login is disabled in this E2E fixture", { exact: true }).waitFor();
  assert.equal(await cloudPage.getByRole("combobox", { name: "Azure Authentication", exact: true }).isEnabled(), true);
  await cloudPage.screenshot({ path: join(artifactDirectory, "azure-login-form.png"), fullPage: true });
  await cloudPage.getByRole("button", { name: "Close Form", exact: true }).click();
  await cloudPage.getByRole("tab", { name: /^Deployments/u }).click();
}

async function assertAwsFirewallDetails(cloudPage: Page, artifactDirectory?: string): Promise<void> {
  await cloudPage.getByRole("heading", {
    level: 1,
    name: E2E_AWS_DEPLOYMENT_NAME,
    exact: true,
  }).waitFor();
  await cloudPage.getByRole("button", { name: "Copy Instance ID", exact: true }).waitFor();
  await cloudPage.getByRole("heading", { name: "Firewall rules", exact: true }).waitFor();
  const firewallGrid = cloudPage.getByRole("grid", { name: "Inbound firewall rules" });
  await firewallGrid.waitFor();
  await assertFirewallAccentRendered(firewallGrid, "danger", "AWS public HTTP rule");
  await cloudPage.getByRole("button", {
    name: "Allow current IP 198.51.100.77/32",
  }).waitFor();
  if (artifactDirectory) {
    await cloudPage.screenshot({ path: join(artifactDirectory, "cloud-firewall-aws-add-current-ip.png"), fullPage: true });
  }
  await cloudPage.getByRole("tab", { name: /^Outbound/u }).click();
  const outboundGrid = cloudPage.getByRole("grid", { name: "Outbound firewall rules" });
  await outboundGrid.waitFor();
  await assertFirewallAccentRendered(outboundGrid, "danger", "AWS all-IPv4 rule");
  assert.equal(
    await cloudPage.getByRole("heading", { name: "Cloud Deployment", exact: true }).count(),
    0,
    "native Firewall navigation must not stop at the Cloud Deployment dashboard",
  );
}

async function assertAzureFirewallDetails(cloudPage: Page, artifactDirectory?: string): Promise<void> {
  await cloudPage.getByRole("heading", {
    level: 1,
    name: E2E_AZURE_DEPLOYMENT_NAME,
    exact: true,
  }).waitFor();
  await cloudPage.getByRole("heading", { name: "Virtual machine summary", exact: true }).waitFor();
  await cloudPage.getByText("Microsoft Azure", { exact: false }).first().waitFor();
  await cloudPage.getByRole("heading", { name: "Firewall rules", exact: true }).waitFor();
  const firewallGrid = cloudPage.getByRole("grid", { name: "Inbound firewall rules" });
  await firewallGrid.waitFor();
  await firewallGrid.getByText("Current IP", { exact: true }).waitFor();
  await assertFirewallAccentRendered(firewallGrid, "success", "Azure current-IP rule");
  assert.equal(await cloudPage.getByRole("button", { name: /Allow current IP/u }).count(), 0);
  if (artifactDirectory) {
    await cloudPage.screenshot({ path: join(artifactDirectory, "cloud-firewall-azure-current-ip.png"), fullPage: true });
  }
}

async function assertFirewallAccentRendered(
  grid: Locator,
  accent: "danger" | "success",
  label: string,
): Promise<void> {
  const marker = grid.locator(`[data-firewall-rule-accent="${accent}"]`);
  assert.equal(await marker.count(), 1, `${label} must have one ${accent} accent marker`);
  const row = marker.locator("xpath=ancestor::*[@role='row'][1]");
  const firstCell = row.locator("td").first();
  const style = await firstCell.evaluate((element) => {
    const computed = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (!computed) return { backgroundColor: "", boxShadow: "" };
    return { backgroundColor: computed.backgroundColor, boxShadow: computed.boxShadow };
  });
  assert.notEqual(style.backgroundColor, "rgba(0, 0, 0, 0)", `${label} must render a visible row background`);
  assert.notEqual(style.boxShadow, "none", `${label} must render a visible edge accent`);
}

async function verifyAwsDeploymentWizard(
  cloudPage: Page,
  artifactDirectory: string,
): Promise<void> {
  await cloudPage.getByRole("button", { name: "New Deployment", exact: true }).click();
  await cloudPage.getByRole("textbox", { name: "Deployment Name" }).fill("e2e-aws-control");
  await cloudPage.getByRole("button", { name: "Continue", exact: true }).click();

  const instanceType = cloudPage.getByRole("button", { name: /Instance Type/u });
  await instanceType.waitFor();
  await instanceType.click();
  for (const name of [
    "t3.micro", "t3.small", "t3.medium", "t3.large", "t3.xlarge",
    "t4g.micro", "t4g.small", "t4g.medium", "t4g.large", "t4g.xlarge",
  ]) {
    await cloudPage.getByRole("option", { name: new RegExp(`^${name.replace(".", "\\.")}`, "u") }).waitFor();
  }
  await assertTextContains(
    cloudPage.getByRole("option", { name: /^t3\.micro/u }),
    "2 vCPU · 1 GiB · x86-64",
  );
  await assertTextContains(
    cloudPage.getByRole("option", { name: /^t4g\.xlarge/u }),
    "4 vCPU · 16 GiB · Arm64",
  );
  await cloudPage.getByRole("option", { name: /^t4g\.small/u }).click();

  const machineImage = cloudPage.getByRole("button", { name: /Machine Image/u });
  await assertTextContains(machineImage, "Ubuntu 24.04 LTS");
  await assertTextContains(machineImage, "Arm64");
  await machineImage.click();
  await assertTextContains(
    cloudPage.getByRole("option", { name: /^Ubuntu 24\.04 LTS/u }),
    "ami-aaaaaaaaaaaaaaaaa · Arm64 · SSH user ubuntu",
  );
  await assertTextContains(
    cloudPage.getByRole("option", { name: /^Amazon Linux 2023/u }),
    "ami-bbbbbbbbbbbbbbbbb · Arm64 · SSH user ec2-user",
  );
  const amazonLinuxOption = cloudPage.getByRole("option", { name: /^Amazon Linux 2023/u });
  await amazonLinuxOption.click();
  assert.equal(await cloudPage.getByRole("textbox", { name: "Linux SSH Username" }).inputValue(), "ec2-user");
  // HeroUI keeps the animated popover mounted briefly after selection. Close
  // it explicitly so subsequent control clicks exercise the page, not the
  // retiring overlay.
  await cloudPage.keyboard.press("Escape");
  await amazonLinuxOption.waitFor({ state: "hidden" });

  const manualAmi = cloudPage.getByRole("switch", { name: /^Enter AMI manually/u });
  await manualAmi.press("Space");
  await cloudPage.getByRole("textbox", { name: "AMI ID" }).waitFor();
  assert.equal(await machineImage.count(), 0);
  await manualAmi.press("Space");
  await cloudPage.getByRole("button", { name: /Machine Image/u }).waitFor();

  const vpc = cloudPage.getByRole("button", { name: /VPC/u });
  await vpc.click();
  await cloudPage.getByRole("option", { name: /^Create a new VPC/u }).waitFor();
  await cloudPage.getByRole("option", { name: /^default · vpc-0123456789abcdef0/u }).waitFor();
  await cloudPage.getByRole("option", { name: /^operations · vpc-11111111111111111/u }).click();
  const subnet = cloudPage.getByRole("button", { name: /Subnet/u });
  await assertTextContains(subnet, "operations-private");

  await vpc.click();
  await cloudPage.getByRole("option", { name: /^Create a new VPC/u }).click();
  assert.equal(await cloudPage.getByRole("textbox", { name: "VPC CIDR" }).inputValue(), "10.0.0.0/16");
  assert.equal(await cloudPage.getByRole("textbox", { name: "Subnet CIDR" }).inputValue(), "10.0.1.0/24");
  assert.equal(await subnet.count(), 0);

  const sshKey = cloudPage.getByRole("button", { name: /SSH Key/u });
  await sshKey.click();
  await cloudPage.getByRole("option", { name: /^Credential key \(managed\)/u }).waitFor();
  await assertTextContains(
    cloudPage.getByRole("option", { name: /^operator-existing/u }),
    "Matches credential key",
  );
  const nonmatchingKey = cloudPage.getByRole("option", { name: /^unusable-key/u });
  assert.equal(await nonmatchingKey.getAttribute("aria-disabled"), "true");
  await assertTextContains(nonmatchingKey, "Unavailable — public key does not match this credential.");
  await cloudPage.getByRole("option", { name: /^operator-existing/u }).click();

  const elasticIp = cloudPage.getByRole("switch", { name: /^Elastic IP/u });
  assert.equal(await elasticIp.isChecked(), true);
  await cloudPage.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "cloud-aws-infrastructure.png"),
  });

  await cloudPage.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(
    await cloudPage.getByRole("textbox", { name: "SSH Source CIDRs" }).inputValue(),
    "198.51.100.77/32",
  );
  assert.equal(
    await cloudPage.getByRole("textbox", { name: "Operator Source CIDRs" }).inputValue(),
    "198.51.100.77/32",
  );
}

async function assertTextContains(locator: Locator, expected: string): Promise<void> {
  assert.ok((await locator.innerText()).includes(expected), `expected ${JSON.stringify(expected)} in control text`);
}

async function cloudDeploymentPage(electronApplication: ElectronApplication): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const page = electronApplication.windows().find((candidate) => {
      if (candidate.isClosed()) return false;
      try {
        return new URL(candidate.url()).search === "?surface=cloud-deployment";
      } catch {
        return false;
      }
    });
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Cloud Deployment renderer surface");
}

async function cloudDeploymentWindowId(electronApplication: ElectronApplication): Promise<number> {
  return electronApplication.evaluate(({ BrowserWindow }) => {
    const matches = BrowserWindow.getAllWindows().filter((candidate) => {
      try {
        return new URL(candidate.webContents.getURL()).search === "?surface=cloud-deployment";
      } catch {
        return false;
      }
    });
    if (matches.length !== 1 || !matches[0]) {
      throw new Error(`Expected one Cloud Deployment BrowserWindow, received ${matches.length}`);
    }
    return matches[0].id;
  });
}

async function assertCloudDeploymentSurface(
  electronApplication: ElectronApplication,
  cloudPage: Page,
): Promise<void> {
  await cloudPage.getByRole("heading", { name: "Cloud Deployment", exact: true }).waitFor();
  const deploymentsTab = cloudPage.getByRole("tab", { name: /^Deployments\b/ });
  const credentialsTab = cloudPage.getByRole("tab", { name: /^Credentials\b/ });
  await Promise.all([deploymentsTab.waitFor(), credentialsTab.waitFor()]);
  assert.equal(await deploymentsTab.getAttribute("aria-selected"), "true");
  const newDeploymentButtons = cloudPage.getByRole("button", { name: "New Deployment", exact: true });
  await Promise.all([
    cloudPage.getByRole("heading", { name: "Managed Servers", exact: true }).waitFor(),
    cloudPage.getByRole("heading", { name: E2E_AWS_DEPLOYMENT_NAME, exact: true }).waitFor(),
    cloudPage.getByRole("heading", { name: E2E_AZURE_DEPLOYMENT_NAME, exact: true }).waitFor(),
    newDeploymentButtons.first().waitFor(),
    cloudPage.getByRole("button", { name: "Refresh cloud deployments", exact: true }).waitFor(),
  ]);
  assert.ok(await newDeploymentButtons.count() >= 1, "expected the deployment dashboard to offer creation");
  assert.equal(
    await cloudPage.getByText("Cloud deployment workflows will be available here in a future update.", {
      exact: true,
    }).count(),
    0,
  );
  assert.equal(await cloudPage.title(), "Cloud Deployment");
  assert.equal(await cloudPage.getByText("Jobs & listeners", { exact: true }).count(), 0);
  const url = new URL(cloudPage.url());
  assert.equal(url.search, "?surface=cloud-deployment");
  assert.equal(url.hash, "");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(await cloudPage.evaluate(() => (
    globalThis as unknown as { opener?: unknown }
  ).opener === null), true);
  assert.equal(await cloudPage.evaluate(() => typeof (
    globalThis as unknown as { sliver?: unknown }
  ).sliver), "undefined");
  const bridge = await cloudPage.evaluate(() => {
    const value = (globalThis as unknown as { cloudDeployment?: object }).cloudDeployment;
    return {
      frozen: value ? Object.isFrozen(value) : false,
      keys: value ? Object.keys(value).sort() : [],
    };
  });
  assert.deepEqual(bridge, {
    frozen: true,
    keys: [
      ...Object.keys(CLOUD_DEPLOYMENT_IPC_INVOKE),
      "onChanged",
      "onNavigationRequested",
      "onThemeChanged",
    ].sort(),
  });
  const cloudSnapshot = await cloudPage.evaluate(async () => (
    globalThis as unknown as { cloudDeployment: CloudDeploymentAPI }
  ).cloudDeployment.getSnapshot());
  assert.deepEqual(cloudSnapshot, {
    ok: true,
    value: {
      state: {
        v: 1,
        revision: 1,
        deployments: [E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT],
      },
      credentials: [
        {
          id: "0f24a4da-28c1-4d94-a66d-eb224892745d",
          provider: "aws",
          label: "E2E AWS profile",
          persistence: "secure",
          createdAt: "2026-09-06T18:00:00.000Z",
          defaultRegion: "us-west-2",
          sshUsername: "ubuntu",
          profileName: "default",
        },
        {
          id: E2E_AZURE_CREDENTIAL_ID,
          provider: "azure",
          label: "E2E Azure CLI",
          persistence: "secure",
          createdAt: "2026-09-06T18:10:00.000Z",
          defaultLocation: "eastus",
          subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
          tenantId: E2E_AZURE_TENANT_ID,
          sshUsername: "azureuser",
        },
      ],
      secureCredentialStorage: true,
      refreshErrors: [],
      awsProfiles: [{ name: "default", region: "us-west-2" }],
      awsProfileDiscoveryError: null,
      azureAccounts: [{
        subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
        name: "E2E Subscription",
        tenantId: E2E_AZURE_TENANT_ID,
        homeTenantId: E2E_AZURE_TENANT_ID,
        isDefault: true,
        cloudName: "AzureCloud",
      }],
      azureAccountDiscoveryError: null,
      provisioningTranscripts: [],
    },
  });
  const refreshedCloud = await cloudPage.evaluate(async () => (
    globalThis as unknown as { cloudDeployment: CloudDeploymentAPI }
  ).cloudDeployment.refreshDeployments());
  assert.deepEqual(refreshedCloud, {
    ok: true,
    value: {
      state: { v: 1, revision: 1, deployments: [E2E_AWS_DEPLOYMENT, E2E_AZURE_DEPLOYMENT] },
      refreshErrors: [],
    },
  });
  const azureDiscovery = await cloudPage.evaluate(async ({ credentialId, location }) => {
    const api = (globalThis as unknown as { cloudDeployment: CloudDeploymentAPI }).cloudDeployment;
    return {
      accounts: await api.discoverAzureAccounts(),
      options: await api.discoverAzureOptions({ credentialId, location }),
    };
  }, { credentialId: E2E_AZURE_CREDENTIAL_ID, location: "eastus" });
  assert.deepEqual(azureDiscovery, {
    accounts: {
      ok: true,
      value: [{
        subscriptionId: E2E_AZURE_SUBSCRIPTION_ID,
        name: "E2E Subscription",
        tenantId: E2E_AZURE_TENANT_ID,
        homeTenantId: E2E_AZURE_TENANT_ID,
        isDefault: true,
        cloudName: "AzureCloud",
      }],
    },
    options: {
      ok: true,
      value: {
        location: "eastus",
        vmSizes: [{ name: "Standard_B2s", vCpuCount: 2, memoryMiB: 4_096 }],
        images: [{
          reference: "Canonical:ubuntu-24_04-lts:server:latest",
          label: "Ubuntu Server 24.04 LTS",
          architecture: "x64",
          sshUsername: "azureuser",
        }],
        virtualNetworks: [],
        subnets: [],
      },
    },
  });
  const clipboardState = await cloudPage.evaluate(async () => {
    const clipboard = (globalThis.navigator as unknown as {
      clipboard?: { readText(): Promise<string> };
    }).clipboard;
    if (!clipboard) return { available: false, readDenied: true };
    try {
      await clipboard.readText();
      return { available: true, readDenied: false };
    } catch {
      return { available: true, readDenied: true };
    }
  });
  assert.deepEqual(clipboardState, { available: true, readDenied: true });

  const state = await electronApplication.evaluate(({ BrowserWindow, session }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => {
      try {
        return new URL(candidate.webContents.getURL()).search === "?surface=cloud-deployment";
      } catch {
        return false;
      }
    });
    if (!window) throw new Error("Expected a Cloud Deployment BrowserWindow");
    const preferences = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      title: window.getTitle(),
      parent: window.getParentWindow()?.id ?? null,
      modal: window.isModal(),
      visible: window.isVisible(),
      usesDedicatedSession: window.webContents.session === session.fromPartition("sliver-cloud-deployment"),
      usesDefaultSession: window.webContents.session === session.defaultSession,
      preferences: {
        contextIsolation: preferences["contextIsolation"],
        nodeIntegration: preferences["nodeIntegration"],
        nodeIntegrationInWorker: preferences["nodeIntegrationInWorker"] ?? false,
        nodeIntegrationInSubFrames: preferences["nodeIntegrationInSubFrames"],
        sandbox: preferences["sandbox"],
        webSecurity: preferences["webSecurity"],
        webviewTag: preferences["webviewTag"],
      },
    };
  });
  assert.deepEqual(state, {
    title: "Cloud Deployment",
    parent: null,
    modal: false,
    visible: true,
    usesDedicatedSession: true,
    usesDefaultSession: false,
    preferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
}

async function assertCloudDeploymentThemeSync(
  electronApplication: ElectronApplication,
  workspacePage: Page,
  cloudPage: Page,
): Promise<void> {
  const initialSettings = await workspacePage.evaluate(() => (
    globalThis as unknown as { sliver: SliverDesktopAPI }
  ).sliver.getApplicationSettings());
  const rendererMarker = "cloud-deployment-theme-state";
  await cloudPage.evaluate((marker) => {
    (globalThis as unknown as { cloudDeploymentStateMarker?: string }).cloudDeploymentStateMarker = marker;
  }, rendererMarker);
  try {
    await setApplicationTheme(workspacePage, "light");
    await cloudPage.locator("html.light[data-theme='light']").waitFor();

    await setApplicationTheme(workspacePage, "dark");
    await cloudPage.locator("html.dark[data-theme='dark']").waitFor();
    assert.equal(await cloudPage.evaluate(() => (
      globalThis as unknown as { cloudDeploymentStateMarker?: string }
    ).cloudDeploymentStateMarker), rendererMarker);
  } finally {
    await setApplicationTheme(workspacePage, initialSettings.theme);
    const restoredDark = await electronApplication.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    await cloudPage.locator(
      restoredDark ? "html.dark[data-theme='dark']" : "html.light[data-theme='light']",
    ).waitFor();
  }
}

async function setApplicationTheme(
  workspacePage: Page,
  theme: ApplicationSettingsState["theme"],
): Promise<void> {
  const result = await workspacePage.evaluate(async (nextTheme) => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    const current = await api.getApplicationSettings();
    return api.updateApplicationSettings({
      expectedRevision: current.revision,
      settings: {
        theme: nextTheme,
        appIcon: current.appIcon,
        reduceMotion: current.reduceMotion,
        commandPaletteShortcut: current.commandPaletteShortcut,
        keyboardShortcuts: current.keyboardShortcuts,
        terminal: current.terminal,
      },
    });
  }, theme);
  assert.equal(result.ok, true, result.error ?? `Expected application theme ${theme} to save`);
}

async function invokeApplicationMenuItem(
  electronApplication: ElectronApplication,
  itemId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const invoked = await electronApplication.evaluate(({ BrowserWindow, Menu }, id) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (!item || typeof item.click !== "function") return false;
      Reflect.apply(item.click, item, [item, BrowserWindow.getFocusedWindow(), {}]);
      return true;
    }, itemId);
    if (invoked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected native application menu item ${itemId}`);
}

async function assertRendererSecurity(electronApplication: ElectronApplication, page: Page): Promise<void> {
  const expectedApiKeys = [
    ...Object.keys(IPC_INVOKE),
    ...SLIVER_DESKTOP_NON_INVOKE_API_KEYS,
  ].sort();
  const rendererState = await page.evaluate(async () => {
    const browserGlobal = globalThis as unknown as {
      applicationContextMenu: object;
      sliver: object;
      process?: unknown;
      require?: unknown;
    };
    let externalFetchBlocked = false;
    try {
      await fetch("https://example.invalid/sliver-gui-e2e");
    } catch {
      externalFetchBlocked = true;
    }
    return {
      contextMenuApiFrozen: Object.isFrozen(browserGlobal.applicationContextMenu),
      contextMenuApiKeys: Object.keys(browserGlobal.applicationContextMenu).sort(),
      apiFrozen: Object.isFrozen(browserGlobal.sliver),
      apiKeys: Object.keys(browserGlobal.sliver).sort(),
      externalFetchBlocked,
      nodeProcessType: typeof browserGlobal.process,
      nodeRequireType: typeof browserGlobal.require,
    };
  });
  assert.deepEqual(rendererState.apiKeys, expectedApiKeys);
  assert.deepEqual(rendererState.contextMenuApiKeys, ["executeAction", "onMenuRequested", "setOpen"]);
  assert.equal(rendererState.contextMenuApiFrozen, true);
  assert.equal(rendererState.apiFrozen, true);
  assert.equal(rendererState.externalFetchBlocked, true);
  assert.equal(rendererState.nodeProcessType, "undefined");
  assert.equal(rendererState.nodeRequireType, "undefined");

  const preferences = await electronApplication.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected an application window");
    const prefs = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      contextIsolation: prefs["contextIsolation"],
      nodeIntegration: prefs["nodeIntegration"],
      nodeIntegrationInWorker: prefs["nodeIntegrationInWorker"] ?? false,
      nodeIntegrationInSubFrames: prefs["nodeIntegrationInSubFrames"],
      sandbox: prefs["sandbox"],
      webSecurity: prefs["webSecurity"],
      webviewTag: prefs["webviewTag"],
    };
  });
  assert.deepEqual(preferences, {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
  });
}

async function verifyCollapsedSidebar(page: Page, artifactDirectory: string): Promise<void> {
  const sidebar = page.locator(".sidebar.app-sidebar").first();
  const appHeader = page.locator(".app-header");
  const navigation = page.getByRole("navigation", { name: "Window navigation" });

  await navigation.getByRole("button", { name: "Collapse sidebar", exact: true }).click();
  await page.locator('.sidebar.app-sidebar[data-state="collapsed"]').first().waitFor();
  assert.equal(await sidebar.getAttribute("data-state"), "collapsed");
  await waitForSidebarWidth(page, "--sidebar-width-collapsed");

  const brand = sidebar.locator(".brand-mark");
  const brandHeader = sidebar.locator('[data-slot="sidebar-header"]');
  const sessions = sidebar.locator('[data-slot="sidebar-menu-item"][aria-label="Sessions"]');
  const sessionsContent = sessions.locator('[data-slot="sidebar-menu-item-content"]');
  const applicationMenu = sidebar.getByRole("button", { name: /^Current server:/i });
  const applicationMenuIcon = applicationMenu.locator(".connection-summary__menu-icon");
  const [sidebarBox, brandBox, brandHeaderBox, navigationBox, sessionsBox, sessionsContentBox, menuBox, menuIconBox] =
    await Promise.all([
      sidebar.boundingBox(),
      brand.boundingBox(),
      brandHeader.boundingBox(),
      navigation.boundingBox(),
      sessions.boundingBox(),
      sessionsContent.boundingBox(),
      applicationMenu.boundingBox(),
      applicationMenuIcon.boundingBox(),
    ]);

  assert.ok(sidebarBox, "collapsed sidebar must have measurable geometry");
  assert.ok(brandBox, "collapsed brand mark must have measurable geometry");
  assert.ok(brandHeaderBox, "collapsed brand header must have measurable geometry");
  assert.ok(navigationBox, "window navigation must have measurable geometry");
  assert.ok(sessionsBox, "collapsed Sessions row must have measurable geometry");
  assert.ok(sessionsContentBox, "collapsed Sessions content must have measurable geometry");
  assert.ok(menuBox, "collapsed application menu must have measurable geometry");
  assert.ok(menuIconBox, "collapsed application menu icon must have measurable geometry");

  const sidebarCenter = sidebarBox.x + sidebarBox.width / 2;
  assert.ok(
    Math.abs(brandBox.width - brandBox.height) <= 0.5,
    `collapsed brand mark must remain square (${brandBox.width}x${brandBox.height})`,
  );
  assert.ok(
    Math.abs(brandBox.x + brandBox.width / 2 - sidebarCenter) <= 0.5,
    "collapsed brand mark must be horizontally centered",
  );
  const brandNavigationGap = brandHeaderBox.y - (navigationBox.y + navigationBox.height);
  assert.ok(
    brandNavigationGap >= -0.5 && brandNavigationGap <= 8.5,
    `sidebar brand block must stay immediately below the window navigation controls (${brandNavigationGap}px gap)`,
  );
  assert.ok(
    Math.abs(sessionsContentBox.width - sessionsContentBox.height) <= 0.5,
    `collapsed nav target must be square (${sessionsContentBox.width}x${sessionsContentBox.height})`,
  );
  assert.ok(
    Math.abs(sessionsContentBox.x + sessionsContentBox.width / 2 - sidebarCenter) <= 0.5,
    "collapsed nav target must be horizontally centered",
  );
  assert.ok(
    Math.abs(menuBox.width - menuBox.height) <= 0.5,
    `collapsed application menu must be square (${menuBox.width}x${menuBox.height})`,
  );
  assert.ok(
    Math.abs(menuBox.x + menuBox.width / 2 - sidebarCenter) <= 0.5,
    "collapsed application menu must be horizontally centered",
  );
  assert.ok(
    Math.abs(menuIconBox.x + menuIconBox.width / 2 - sidebarCenter) <= 1.5,
    `collapsed application menu icon must be horizontally centered (${menuIconBox.x + menuIconBox.width / 2 - sidebarCenter}px offset)`,
  );

  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "sidebar-collapsed.png"),
  });

  await page.mouse.move(sessionsContentBox.x + 4, sessionsContentBox.y + 4);
  const sessionsTooltip = page.getByRole("tooltip").filter({ hasText: "Sessions" });
  await sessionsTooltip.waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "sidebar-collapsed-tooltip.png"),
  });
  await appHeader.hover();
  await sessionsTooltip.waitFor({ state: "hidden" });

  await sessions.click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const operations = sidebar.locator('[data-slot="sidebar-menu-item"][aria-label="Jobs & listeners"]');
  await operations.click();
  await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();

  await applicationMenu.hover();
  const applicationMenuTooltip = page.getByRole("tooltip").filter({ hasText: "Application menu" });
  await applicationMenuTooltip.waitFor();
  await appHeader.hover();
  await applicationMenuTooltip.waitFor({ state: "hidden" });

  await applicationMenu.click();
  assert.equal(await applicationMenu.getAttribute("aria-expanded"), "true");
  const applicationActions = page.locator(
    '[role="menu"][aria-label="Application and current server actions"]',
  );
  await applicationActions.waitFor();
  assert.deepEqual(await applicationActions.getByRole("menuitem").allTextContents(), [
    "Exit app",
    "Disconnect",
    "Switch config",
    "Settings",
  ]);
  await page.keyboard.press("Escape");
  await applicationActions.waitFor({ state: "hidden" });

  const expandSidebar = navigation.getByRole("button", { name: "Expand sidebar", exact: true });
  await expandSidebar.waitFor();
  await expandSidebar.click();
  await page.locator('.sidebar.app-sidebar[data-state="expanded"]').first().waitFor();
  assert.equal(await sidebar.getAttribute("data-state"), "expanded");
  await waitForSidebarWidth(page, "--sidebar-width");
}

async function waitForSidebarWidth(
  page: Page,
  cssVariable: "--sidebar-width" | "--sidebar-width-collapsed",
): Promise<void> {
  await page.waitForFunction((variable) => {
    type BrowserElement = { getBoundingClientRect(): { width: number } };
    const browser = globalThis as unknown as {
      document: { querySelector(selector: string): BrowserElement | null };
      getComputedStyle(element: BrowserElement): { getPropertyValue(name: string): string };
    };
    const element = browser.document.querySelector(".sidebar.app-sidebar");
    if (!element) return false;
    const expectedWidth = Number.parseFloat(browser.getComputedStyle(element).getPropertyValue(variable));
    return Math.abs(element.getBoundingClientRect().width - expectedWidth) <= 0.5;
  }, cssVariable);
}

async function sendNativeApplicationShortcut(
  electronApplication: ElectronApplication,
  page: Page,
  key: string,
  options: { readonly shift?: boolean; readonly control?: boolean } = {},
): Promise<void> {
  const sent = await electronApplication.evaluate(
    ({ app, BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === input.url,
      );
      if (!window) return false;

      app.focus({ steal: true });
      window.show();
      window.focus();
      window.webContents.focus();
      const modifiers: Array<"meta" | "control" | "shift"> = [
        input.control ? "control" : process.platform === "darwin" ? "meta" : "control",
        ...(input.shift ? ["shift" as const] : []),
      ];
      window.webContents.sendInputEvent({
        type: "keyDown",
        keyCode: input.key,
        modifiers,
      });
      window.webContents.sendInputEvent({
        type: "keyUp",
        keyCode: input.key,
        modifiers,
      });
      return true;
    },
    { key, shift: options.shift ?? false, control: options.control ?? false, url: page.url() },
  );
  assert.equal(sent, true, `expected a native Electron window for ${page.url()}`);
}

async function sendNativeContextMenu(
  electronApplication: ElectronApplication,
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const sent = await electronApplication.evaluate(
    ({ app, BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === input.url,
      );
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
    },
    { ...point, url: page.url() },
  );
  assert.equal(sent, true, `expected a native Electron window for ${page.url()}`);
}

async function verifyApplicationSettings(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  await page.getByRole("button", { name: /^Current server:/i }).click();
  await page.getByRole("menuitem", { name: "Settings" }).click();
  await page.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  assert.equal(await page.getByRole("tab", { name: "General" }).getAttribute("aria-selected"), "true");

  await page.getByRole("radiogroup", { name: "Color theme" }).getByRole("radio", { name: "Light" }).click();
  await page.locator("html.light[data-theme='light']").waitFor();
  await page.getByText("Reduce motion", { exact: true }).click();
  await page.locator("html[data-reduce-motion='true']").waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "application-settings-general-light.png"),
  });

  const primaryModifier = process.platform === "darwin" ? "Meta" : "Control";
  await sendNativeApplicationShortcut(electronApplication, page, "K");
  const commandPalette = page.getByRole("dialog", { name: "Command palette" });
  await commandPalette.waitFor({ timeout: 5_000 });
  assert.equal(
    await commandPalette.getByRole("menuitem").count(),
    18,
    "the connected workspace should expose the bounded app command catalog",
  );
  await commandPalette.getByRole("menuitem", { name: /^Overview\b/u }).waitFor();
  await commandPalette.getByRole("menuitem", { name: /^Go back\b/u }).waitFor();
  await commandPalette.getByRole("menuitem", { name: /^Go forward\b/u }).waitFor();
  await commandPalette.getByRole("menuitem", { name: /Cloud Deployment/u }).waitFor();
  await page.keyboard.press("Escape");
  await commandPalette.waitFor({ state: "hidden" });

  await page.getByRole("tab", { name: "Keyboard Shortcuts", exact: true }).click();
  await page.getByRole("button", { name: "Change shortcut for Open command palette", exact: true }).click();
  await page.getByRole("button", { name: "Cancel changing shortcut for Open command palette", exact: true }).waitFor();
  await page.keyboard.press(`${primaryModifier}+Shift+p`);
  await waitForApplicationSettings(
    page,
    (candidate) => candidate.commandPaletteShortcut === "mod+shift+p",
  );
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "application-settings-keyboard.png"),
  });

  await sendNativeApplicationShortcut(electronApplication, page, "K");
  await page.waitForTimeout(150);
  assert.equal(await commandPalette.count(), 0, "the replaced shortcut must stop opening the palette");
  await sendNativeApplicationShortcut(electronApplication, page, "P", { shift: true });
  await commandPalette.waitFor();
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "command-palette.png"),
  });
  await sendNativeApplicationShortcut(electronApplication, page, "P", { shift: true });
  await commandPalette.waitFor({ state: "hidden" });

  await page.getByRole("tab", { name: "Terminal" }).click();
  await page.getByText("Smooth scrolling", { exact: true }).click();
  await page.getByRole("button", { name: "Save" }).click();
  const settings = await waitForApplicationSettings(
    page,
    (candidate) => candidate.theme === "light" &&
      candidate.reduceMotion &&
      candidate.commandPaletteShortcut === "mod+shift+p" &&
      candidate.terminal.smoothScrolling,
  );
  await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "application-settings-terminal-light.png"),
  });

  assert.equal(settings.theme, "light");
  assert.equal(settings.reduceMotion, true);
  assert.equal(settings.commandPaletteShortcut, "mod+shift+p");
  assert.equal(settings.terminal.smoothScrolling, true);
  assert.ok(settings.revision >= 4);

  const native = await electronApplication.evaluate(({ BrowserWindow, nativeTheme }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      background: window?.getBackgroundColor().toLowerCase(),
      shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
      themeSource: nativeTheme.themeSource,
    };
  });
  assert.equal(native.themeSource, "light");
  assert.equal(native.shouldUseDarkColors, false);
  assert.match(native.background ?? "", /^#0{6}(?:00)?$/u);
}

async function verifyOperatorDataStores(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
  lootInputPath: string,
  lootSavedPath: string,
): Promise<void> {
  await page.locator('[aria-label="Loot"]:visible').click();
  await page.getByRole("heading", { name: "Loot", exact: true }).waitFor();
  await page.getByText("incident-notes", { exact: true }).waitFor();
  await page.getByText("browser-memory", { exact: true }).waitFor();
  assert.ok((await readFakeState(electronApplication)).methods.includes("lootAll"));

  await page.getByRole("button", { name: "Inspect incident-notes", exact: true }).click();
  const seededLootDialog = page.getByRole("dialog", { name: "incident-notes", exact: true });
  await seededLootDialog.waitFor();
  await seededLootDialog.getByText("Deterministic loot preview.", { exact: false }).waitFor();
  assert.ok((await readFakeState(electronApplication)).methods.includes("lootContent"));
  await seededLootDialog.getByRole("button", { name: "Close", exact: true }).last().click();

  await electronApplication.evaluate(({ dialog }, inputPath) => {
    dialog.showOpenDialog = async () => {
      globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
      return { canceled: false, filePaths: [inputPath] };
    };
  }, lootInputPath);
  await page.getByRole("button", { name: "Add local file", exact: true }).click();
  const addLootDialog = page.getByRole("dialog", { name: "Add local loot", exact: true });
  await addLootDialog.waitFor();
  await addLootDialog.getByRole("textbox", { name: "Display name", exact: true }).fill("e2e-local-loot");
  await addLootDialog.getByRole("button", { name: "Choose file and add", exact: true }).click();
  const localLootRow = page.getByRole("row").filter({ hasText: "e2e-local-loot" });
  await localLootRow.waitFor();
  await waitForFakeMethodCount(electronApplication, "lootAdd", 1);

  await electronApplication.evaluate(({ dialog }, outputPath) => {
    dialog.showSaveDialog = async () => {
      globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
      return { canceled: false, filePath: outputPath };
    };
  }, lootSavedPath);
  await page.getByRole("button", { name: "Save e2e-local-loot", exact: true }).click();
  // The row already contains m6-loot-input.txt, so waiting for that filename
  // does not prove the async native save has committed. The success toast is
  // emitted only after the main process finishes the private file write.
  await page.getByText("Loot saved", { exact: true }).waitFor();
  assert.equal(await readFile(lootSavedPath, "utf8"), M6_LOOT_CONTENT);
  const savedLootStats = await lstat(lootSavedPath);
  assert.equal(savedLootStats.isFile(), true);
  if (process.platform !== "win32") assert.equal(savedLootStats.mode & 0o777, 0o600);

  await page.getByRole("button", { name: "Rename e2e-local-loot", exact: true }).click();
  const renameDialog = page.getByRole("dialog", { name: "Rename loot", exact: true });
  await renameDialog.getByRole("textbox", { name: "Display name", exact: true }).fill("e2e-renamed-loot");
  await renameDialog.getByRole("button", { name: "Rename", exact: true }).click();
  await page.locator('[aria-label="Sliver loot"]').getByText("e2e-renamed-loot", { exact: true }).waitFor();

  const renamedLootRow = page.getByRole("row").filter({ hasText: "e2e-renamed-loot" });
  await renamedLootRow.getByRole("button", { name: "Delete e2e-renamed-loot", exact: true }).click();
  const lootDelete = page.getByRole("alertdialog", { name: "Delete e2e-renamed-loot?", exact: true });
  await lootDelete.getByRole("button", { name: "Delete loot", exact: true }).click();
  await renamedLootRow.waitFor({ state: "detached" });

  await page.locator('[aria-label="Credentials"]:visible').click();
  await page.getByRole("heading", { name: "Credentials", exact: true }).waitFor();
  await page.getByText("ACME\\alice", { exact: true }).waitFor();
  await page.getByText("svc-backup", { exact: true }).waitFor();
  const redactedBody = await page.locator("body").innerText();
  assert.ok(!redactedBody.includes("FAKE_CREDENTIAL_SECRET_DO_NOT_RENDER_BY_DEFAULT"));
  assert.ok(!redactedBody.includes("8846f7eaee8fb117ad06bdd830b7586c"));

  await page.getByRole("button", { name: "Add credential", exact: true }).click();
  const addCredentialDialog = page.getByRole("dialog", { name: "Add credential", exact: true });
  await addCredentialDialog.getByRole("textbox", { name: "Username", exact: true }).fill("e2e-created");
  const plaintextInput = addCredentialDialog.getByLabel("Plaintext value", { exact: true });
  await plaintextInput.pressSequentially(M6_CREDENTIAL_SECRET);
  assert.equal(await plaintextInput.inputValue(), M6_CREDENTIAL_SECRET);
  const addCredentialButton = addCredentialDialog.getByRole("button", { name: "Add credential", exact: true });
  await addCredentialButton.press("Enter");
  await page.getByText("Credential added", { exact: true }).waitFor();
  const createdCredentialRow = page.getByRole("row").filter({ hasText: "e2e-created" });
  await createdCredentialRow.waitFor();
  assert.ok(!(await page.locator("body").innerText()).includes(M6_CREDENTIAL_SECRET));
  await waitForFakeMethodCount(electronApplication, "credentialAdd", 1);

  await createdCredentialRow.getByRole("button", { name: "View credential", exact: true }).click();
  const credentialDialog = page.getByRole("dialog", { name: "e2e-created", exact: true });
  await credentialDialog.waitFor();
  await credentialDialog.getByText("Redacted", { exact: true }).waitFor();
  await credentialDialog.getByRole("button", { name: "Reveal", exact: true }).first().click();
  await credentialDialog.getByText(M6_CREDENTIAL_SECRET, { exact: true }).waitFor();
  await credentialDialog.getByRole("button", { name: "Hide", exact: true }).click();
  await credentialDialog.getByText(M6_CREDENTIAL_SECRET, { exact: true }).waitFor({ state: "detached" });
  await credentialDialog.getByRole("button", { name: "Copy", exact: true }).first().click();
  await credentialDialog.getByRole("button", { name: "Clear clipboard", exact: true }).click();
  await credentialDialog.getByRole("button", { name: "Done", exact: true }).click();

  const credentialScreenshot = await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "operator-data-stores.png"),
  });
  assert.ok(!(await page.locator("body").innerText()).includes(M6_CREDENTIAL_SECRET));
  assert.equal(credentialScreenshot.includes(Buffer.from(M6_CREDENTIAL_SECRET)), false);

  await createdCredentialRow.getByRole("button", { name: "Delete credential", exact: true }).click();
  const credentialDelete = page.getByRole("alertdialog", { name: "Delete e2e-created?", exact: true });
  await credentialDelete.getByRole("button", { name: "Delete credential", exact: true }).click();
  await createdCredentialRow.waitFor({ state: "detached" });

  const state = await readFakeState(electronApplication);
  for (const method of [
    "lootAll",
    "lootContent",
    "lootAdd",
    "lootUpdate",
    "lootRemove",
    "credentialsAll",
    "credentialById",
    "credentialAdd",
    "credentialRemove",
  ]) {
    assert.ok(state.methods.includes(method), `expected the operator-data journey to call ${method}`);
  }
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners", exact: true }).waitFor();
}

async function verifySliverConsoleWindow(
  electronApplication: ElectronApplication,
  sourcePage: Page,
  activeConfig: string,
  artifactDirectory: string,
  clientRootDirectory: string,
  clientRootMarker: string,
): Promise<void> {
  const existingWindows = new Set(electronApplication.windows());
  const initialWindowCount = existingWindows.size;
  const initialState = await readFakeState(electronApplication);
  const initialSpawnCount = initialState.console.spawns.length;
  const initialKillCount = initialState.console.kills;
  const shortcutLabelModifier = process.platform === "darwin" ? "Command" : "Ctrl";
  const shortcutKeyModifier = process.platform === "darwin" ? "Meta" : "Control";

  await sourcePage.locator('button[aria-label="Open Sliver console"]').click();
  const consolePage = await waitForConsoleWindow(electronApplication, existingWindows);
  const pageErrors: string[] = [];
  consolePage.on("pageerror", (error) => pageErrors.push(error.message));
  const rootDirectories: string[] = [];

  try {
    assert.equal(new URL(consolePage.url()).search, "?surface=console");
    await consolePage.getByRole("main", { name: "Sliver client console window", exact: true }).waitFor();
    await consolePage.getByLabel(
      "Sliver client consoles using chosen-m0-operator.cfg",
      { exact: true },
    ).waitFor();
    await consolePage.getByRole("tab", { name: /Console 1.*Connected/iu }).waitFor();

    const firstTerminal = consolePage.getByRole("textbox", {
      name: "Sliver client Console 1 using chosen-m0-operator.cfg",
      exact: true,
    });
    await firstTerminal.waitFor();
    await consolePage.locator('[data-terminal-state="ready"]').waitFor();
    await consolePage.locator("html.light[data-theme='light'][data-reduce-motion='true']").waitFor();
    assert.equal(
      await consolePage.locator('[data-terminal-state="ready"]').evaluate((element) =>
        (globalThis as unknown as {
          getComputedStyle(target: unknown): { backgroundColor: string };
        }).getComputedStyle(element).backgroundColor),
      "rgb(250, 250, 250)",
    );
    const embeddedFontLoads = await consolePage.evaluate(async (families) => {
      const browserDocument = (globalThis as unknown as {
        document: { fonts: { load(value: string): Promise<unknown[]>; check(value: string): boolean } };
      }).document;
      return Object.fromEntries(await Promise.all(families.map(async (family) => [
        family,
        (await browserDocument.fonts.load(`13px "${family}"`)).length > 0 &&
          browserDocument.fonts.check(`13px "${family}"`),
      ])));
    }, ["Fira Code", "JetBrains Mono", "Cascadia Mono", "Source Code Pro"]);
    assert.deepEqual(embeddedFontLoads, {
      "Fira Code": true,
      "JetBrains Mono": true,
      "Cascadia Mono": true,
      "Source Code Pro": true,
    });
    assert.equal(await consolePage.getByRole("tab").count(), 1);
    assert.equal(await consolePage.locator(".tabs.tabs--secondary").count(), 1);
    assert.equal(await consolePage.locator("[data-console-terminal-tab-id]").count(), 1);
    const terminalRegionClass = await consolePage
      .getByRole("region", { name: "Console terminal" })
      .getAttribute("class");
    assert.ok(!terminalRegionClass?.split(/\s+/u).includes("p-2"), "terminal surface must be full bleed");

    const firstSpawnedState = await waitForConsoleState(
      electronApplication,
      (state) => state.console.spawns.length === initialSpawnCount + 1,
      "one native console spawn",
    );
    const firstSpawn = firstSpawnedState.console.spawns[initialSpawnCount];
    assert.ok(firstSpawn, "the first console tab must spawn one PTY");
    rootDirectories.push(firstSpawn.rootDirectory);
    assert.deepEqual(firstSpawn.args, ["--disable-wg"]);
    assert.equal(firstSpawn.cwd, firstSpawn.rootDirectory);
    assert.equal(firstSpawn.clientRootDirectory, clientRootDirectory);
    assert.equal(firstSpawn.configPath, join(firstSpawn.rootDirectory, "configs", "active.cfg"));
    assert.equal(firstSpawn.historyPath, join(firstSpawn.rootDirectory, "history"));
    assert.equal(firstSpawn.disableConsoleLogs, "1");
    assert.notEqual(firstSpawn.clientRootDirectory, firstSpawn.rootDirectory);
    assert.deepEqual(firstSpawn.configEntries, ["active.cfg"]);
    assert.equal(
      firstSpawn.configSha256,
      createHash("sha256").update(activeConfig).digest("hex"),
      "the PTY must receive the exact active profile selected by the source window",
    );
    assert.equal(
      await pathExists(firstSpawn.rootDirectory),
      true,
      "the first private console root must exist while its tab is open",
    );

    const writesBeforeCommandPalette = [...firstSpawn.writes];
    await firstTerminal.focus();
    await sendNativeApplicationShortcut(electronApplication, consolePage, "P", { shift: true });
    const sourceCommandPalette = sourcePage.getByRole("dialog", { name: "Command palette" });
    await sourceCommandPalette.waitFor();
    const paletteShortcutState = await readFakeState(electronApplication);
    assert.deepEqual(
      paletteShortcutState.console.spawns[initialSpawnCount]?.writes,
      writesBeforeCommandPalette,
      "the app command shortcut must not reach the focused console PTY",
    );
    await sourcePage.keyboard.press("Escape");
    await sourceCommandPalette.waitFor({ state: "hidden" });
    await consolePage.bringToFront();

    const firstWritesBeforeNewTabShortcut = [...firstSpawn.writes];
    await firstTerminal.focus();
    assert.equal(await firstTerminal.evaluate((element) =>
      (globalThis as unknown as { document: { activeElement: unknown } })
        .document.activeElement === element), true);
    await firstTerminal.press(`${shortcutKeyModifier}+t`);
    await consolePage.getByRole("tab", { name: /Console 2.*Connected/iu }).waitFor();
    const twoTabState = await waitForConsoleState(
      electronApplication,
      (state) => state.console.spawns.length === initialSpawnCount + 2,
      "a second native console spawn",
    );
    const secondSpawn = twoTabState.console.spawns[initialSpawnCount + 1];
    assert.ok(secondSpawn, "the second console tab must spawn its own PTY");
    assert.deepEqual(
      twoTabState.console.spawns[initialSpawnCount]?.writes,
      firstWritesBeforeNewTabShortcut,
      "the new-tab shortcut must not reach the focused Ghostty PTY",
    );
    assert.deepEqual(secondSpawn.writes, [], "one new-tab shortcut must create exactly one untouched PTY");
    rootDirectories.push(secondSpawn.rootDirectory);
    assert.notEqual(secondSpawn.rootDirectory, firstSpawn.rootDirectory);
    assert.deepEqual(secondSpawn.args, ["--disable-wg"]);
    assert.deepEqual(secondSpawn.configEntries, ["active.cfg"]);
    assert.equal(secondSpawn.configSha256, firstSpawn.configSha256);
    assert.equal(await pathExists(secondSpawn.rootDirectory), true);
    assert.equal(await consolePage.getByRole("tab").count(), 2);
    assert.equal(await consolePage.locator("[data-console-terminal-tab-id]").count(), 2);
    assert.equal(await consolePage.locator("[data-console-terminal-tab-id][inert]").count(), 1);
    await consolePage.getByRole("tab", {
      name: new RegExp(`Console 1.*shortcut ${shortcutLabelModifier}\\+1`, "iu"),
    }).waitFor();
    await consolePage.getByRole("tab", {
      name: new RegExp(`Console 2.*shortcut ${shortcutLabelModifier}\\+2`, "iu"),
    }).waitFor();

    const secondTerminal = consolePage.getByRole("textbox", {
      name: "Sliver client Console 2 using chosen-m0-operator.cfg",
      exact: true,
    });
    await secondTerminal.waitFor();
    await secondTerminal.focus();
    assert.equal(await secondTerminal.evaluate((element) =>
      (globalThis as unknown as { document: { activeElement: unknown } })
        .document.activeElement === element), true);
    const shortcutWritesBefore = [
      [...firstSpawn.writes],
      [...secondSpawn.writes],
    ];
    await secondTerminal.press(`${shortcutKeyModifier}+1`);
    await waitForSelectedConsoleTab(consolePage, /Console 1/iu);
    await firstTerminal.press(`${shortcutKeyModifier}+2`);
    await waitForSelectedConsoleTab(consolePage, /Console 2/iu);
    const shortcutState = await readFakeState(electronApplication);
    assert.deepEqual(
      [
        shortcutState.console.spawns[initialSpawnCount]?.writes,
        shortcutState.console.spawns[initialSpawnCount + 1]?.writes,
      ],
      shortcutWritesBefore,
      "console tab shortcuts must not reach either Ghostty PTY",
    );

    const firstWritesBefore = firstSpawn.writes.length;
    await secondTerminal.pressSequentially("version");
    await secondTerminal.press("Enter");
    const commandState = await waitForConsoleState(
      electronApplication,
      (state) => {
        const selectedSpawn = state.console.spawns[initialSpawnCount + 1];
        return selectedSpawn?.writes.join("").includes("version\r") === true &&
          selectedSpawn.resizes.length > 0;
      },
      "Ghostty input and its debounced resize to reach the selected console tab",
    );
    assert.equal(commandState.console.spawns[initialSpawnCount]?.writes.length, firstWritesBefore);
    assert.ok(commandState.console.spawns[initialSpawnCount + 1]?.resizes.length);

    await verifyTerminalClipboard(
      electronApplication,
      consolePage,
      secondTerminal,
      "Sliver",
      async () => (await readFakeState(electronApplication)).console.spawns.map(({ writes }) => writes),
      initialSpawnCount + 1,
    );

    const processStateBeforeRename = await readFakeState(electronApplication);
    const firstTabBeforeRename = consolePage.getByRole("tab", {
      name: new RegExp(`Console 1.*shortcut ${shortcutLabelModifier}\\+1`, "iu"),
    });
    const secondTabBeforeRename = consolePage.getByRole("tab", {
      name: new RegExp(`Console 2.*shortcut ${shortcutLabelModifier}\\+2`, "iu"),
    });
    const contextMenu = consolePage.getByRole("menu", { name: "Application context menu" });
    await firstTabBeforeRename.click({ button: "right" });
    await contextMenu.waitFor();
    assert.equal(
      await contextMenu.getByRole("menuitem", { name: "Rename", exact: true }).count(),
      1,
      "a console tab context menu must expose its scoped Rename action",
    );
    assert.equal(
      await contextMenu.getByRole("menuitem", { name: "Inspect Element", exact: true }).count(),
      1,
      "a console tab context menu must retain Inspect Element",
    );
    await contextMenu.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await contextMenu.waitFor({ state: "hidden" });

    const renameDialog = consolePage.getByRole("dialog", { name: "Rename tab", exact: true });
    await renameDialog.waitFor();
    const renameInput = renameDialog.getByRole("textbox", { name: /Tab name/iu });
    assert.equal(await renameInput.inputValue(), "Console 1");
    await renameInput.fill("Primary console");
    await renameInput.press("Enter");
    await renameDialog.waitFor({ state: "hidden" });

    const renamedFirstTab = consolePage.getByRole("tab", {
      name: new RegExp(`Primary console.*shortcut ${shortcutLabelModifier}\\+1`, "iu"),
    });
    await renamedFirstTab.waitFor();
    assert.equal(await renamedFirstTab.getAttribute("aria-selected"), "false");
    assert.equal(await secondTabBeforeRename.getAttribute("aria-selected"), "true");
    assert.equal(
      await consolePage.title(),
      "Sliver console — chosen-m0-operator.cfg — Console 2",
      "renaming a background tab must not select it",
    );
    const processStateAfterRename = await readFakeState(electronApplication);
    assert.equal(processStateAfterRename.console.spawns.length, processStateBeforeRename.console.spawns.length);
    assert.equal(processStateAfterRename.console.kills, processStateBeforeRename.console.kills);
    assert.deepEqual(
      processStateAfterRename.console.spawns.map(({ writes }) => writes),
      processStateBeforeRename.console.spawns.map(({ writes }) => writes),
      "renaming a tab must not write to or restart a console PTY",
    );

    await renamedFirstTab.click();
    await waitForSelectedConsoleTab(consolePage, /Primary console/iu);
    assert.equal(await consolePage.title(), "Sliver console — chosen-m0-operator.cfg — Primary console");
    await secondTabBeforeRename.click();
    await waitForSelectedConsoleTab(consolePage, /Console 2/iu);

    const clipboardBeforeResume = await readClipboardText(electronApplication);
    try {
      await secondTerminal.locator("canvas").dblclick({ position: { x: 12, y: 8 } });
      await electronApplication.evaluate(({ clipboard }) => clipboard.writeText("before-console-resume"));
      await verifyConsoleWindowResume(electronApplication, sourcePage, consolePage);
      assert.equal(await renamedFirstTab.getAttribute("aria-selected"), "false");
      assert.equal(await secondTabBeforeRename.getAttribute("aria-selected"), "true");
      assert.equal(await consolePage.title(), "Sliver console — chosen-m0-operator.cfg — Console 2");

      const resumedCanvasBounds = await secondTerminal.locator("canvas").boundingBox();
      assert.ok(resumedCanvasBounds);
      await sendNativeContextMenu(electronApplication, consolePage, {
        x: resumedCanvasBounds.x + 12,
        y: resumedCanvasBounds.y + 8,
      });
      await contextMenu.waitFor();
      const copy = contextMenu.getByRole("menuitem", { name: "Copy", exact: true });
      assert.notEqual(await copy.getAttribute("aria-disabled"), "true");
      await copy.click();
      await contextMenu.waitFor({ state: "hidden" });
      const clipboardDeadline = Date.now() + 5_000;
      let resumedSelection = "";
      while (Date.now() < clipboardDeadline) {
        resumedSelection = await readClipboardText(electronApplication);
        if (resumedSelection === "Sliver") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(
        resumedSelection,
        "Sliver",
        "reopening the window must preserve Ghostty output and its existing text selection",
      );
    } finally {
      await electronApplication.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardBeforeResume);
    }

    await consolePage.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "console-tabs.png"),
    });
    await consolePage.bringToFront();
    await invokeConsoleMenuItem(electronApplication, "console.settings");
    const settingsDialog = consolePage.getByRole("dialog", { name: "Terminal Settings" });
    await settingsDialog.waitFor();
    await settingsDialog.getByText("Fira Code", { exact: true }).first().waitFor();
    assert.equal(await settingsDialog.getByRole("switch", { name: "Smooth scrolling" }).isChecked(), true);
    await consolePage.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "console-tabs-settings.png"),
    });
    await settingsDialog.getByRole("button", { name: "Cancel" }).click();

    await consolePage.getByRole("button", { name: "Close active console tab" }).click();
    await consolePage.getByRole("tab", { name: /Primary console.*Connected/iu }).waitFor();
    const oneTabState = await waitForConsoleState(
      electronApplication,
      (state) => state.console.kills === initialKillCount + 1,
      "second console tab cleanup",
    );
    assert.equal(oneTabState.console.spawns[initialSpawnCount]?.kills, 0);
    assert.equal(oneTabState.console.spawns[initialSpawnCount + 1]?.kills, 1);
    await waitForPathRemoval(secondSpawn.rootDirectory);
    assert.equal(await pathExists(firstSpawn.rootDirectory), true);

    await consolePage.getByRole("button", { name: "Close active console tab" }).click();
    await consolePage.getByText("No console tabs", { exact: true }).waitFor();
    await waitForConsoleState(
      electronApplication,
      (state) => state.console.kills === initialKillCount + 2,
      "last console tab cleanup",
    );
    await waitForPathRemoval(firstSpawn.rootDirectory);
    assert.equal(consolePage.isClosed(), false, "an empty console window must remain reusable");
    const emptyNewTabButton = consolePage
      .getByRole("region", { name: "Console terminal" })
      .getByRole("button", { name: "New console tab" });
    await emptyNewTabButton.waitFor();
    await emptyNewTabButton.click();
    await consolePage.getByRole("tab", { name: /Console 3.*Connected/iu }).waitFor();
    const reusedWindowState = await waitForConsoleState(
      electronApplication,
      (state) => state.console.spawns.length === initialSpawnCount + 3,
      "a console spawn from the reusable empty window",
    );
    const thirdSpawn = reusedWindowState.console.spawns[initialSpawnCount + 2];
    assert.ok(thirdSpawn, "the reused console window must spawn a fresh PTY");
    rootDirectories.push(thirdSpawn.rootDirectory);
    assert.notEqual(thirdSpawn.rootDirectory, firstSpawn.rootDirectory);
    assert.notEqual(thirdSpawn.rootDirectory, secondSpawn.rootDirectory);
    assert.deepEqual(thirdSpawn.args, ["--disable-wg"]);
    assert.deepEqual(thirdSpawn.configEntries, ["active.cfg"]);
    assert.equal(thirdSpawn.configSha256, firstSpawn.configSha256);
    assert.equal(await pathExists(thirdSpawn.rootDirectory), true);

    const lastTabOrdinalAtCap = 3 + CONSOLE_MAX_TABS_PER_WINDOW - 1;
    for (let ordinal = 4; ordinal <= lastTabOrdinalAtCap; ordinal += 1) {
      await consolePage.getByRole("button", { name: "New console tab" }).click();
      await consolePage.getByRole("tab", {
        name: new RegExp(`Console ${ordinal}.*Connected`, "iu"),
      }).waitFor();
      const atOrdinal = await waitForConsoleState(
        electronApplication,
        (state) => state.console.spawns.length === initialSpawnCount + ordinal,
        `native console spawn ${ordinal} while filling the tab cap`,
      );
      const spawn = atOrdinal.console.spawns[initialSpawnCount + ordinal - 1];
      assert.ok(spawn, `console tab ${ordinal} must own a PTY`);
      rootDirectories.push(spawn.rootDirectory);
      assert.equal(spawn.configSha256, firstSpawn.configSha256);
    }
    assert.equal(await consolePage.getByRole("tab").count(), CONSOLE_MAX_TABS_PER_WINDOW);
    await consolePage.getByRole("tab", {
      name: new RegExp(`Console ${lastTabOrdinalAtCap}.*shortcut ${shortcutLabelModifier}\\+0`, "iu"),
    }).waitFor();
    const lastTerminal = consolePage.getByRole("textbox", {
      name: `Sliver client Console ${lastTabOrdinalAtCap} using chosen-m0-operator.cfg`,
      exact: true,
    });
    await lastTerminal.focus();
    assert.equal(await lastTerminal.evaluate((element) =>
      (globalThis as unknown as { document: { activeElement: unknown } })
        .document.activeElement === element), true);
    const capWritesBefore = (await readFakeState(electronApplication)).console.spawns
      .map(({ writes }) => [...writes]);
    await lastTerminal.press(`${shortcutKeyModifier}+1`);
    await waitForSelectedConsoleTab(consolePage, /Console 3/iu);
    const firstTerminalAtCap = consolePage.getByRole("textbox", {
      name: "Sliver client Console 3 using chosen-m0-operator.cfg",
      exact: true,
    });
    await firstTerminalAtCap.press(`${shortcutKeyModifier}+0`);
    await waitForSelectedConsoleTab(
      consolePage,
      new RegExp(`Console ${lastTabOrdinalAtCap}`, "iu"),
    );
    assert.deepEqual(
      (await readFakeState(electronApplication)).console.spawns.map(({ writes }) => writes),
      capWritesBefore,
      "first and tenth tab shortcuts must not reach any Ghostty PTY",
    );

    await electronApplication.evaluate(() => {
      globalThis.__SLIVER_GUI_E2E_CONTROL__.holdNextConsoleExit();
    });
    await consolePage.getByRole("button", { name: "Close active console tab" }).click();
    await waitForConsoleState(
      electronApplication,
      (state) => state.console.kills === initialKillCount + 3,
      "the held native console shutdown to begin",
    );
    const spawnCountAtCap = initialSpawnCount + lastTabOrdinalAtCap;
    const rejectedShortcutWritesBefore = (await readFakeState(electronApplication)).console.spawns
      .map(({ writes }) => [...writes]);
    await lastTerminal.focus();
    await lastTerminal.press(`${shortcutKeyModifier}+t`);
    await consolePage.getByText(
      `A Sliver console window supports at most ${CONSOLE_MAX_TABS_PER_WINDOW} tabs`,
      { exact: true },
    ).waitFor();
    const rejectedAtCap = await readFakeState(electronApplication);
    assert.equal(
      rejectedAtCap.console.spawns.length,
      spawnCountAtCap,
      "a closing native runtime must remain admitted against the process cap",
    );
    assert.deepEqual(
      rejectedAtCap.console.spawns.map(({ writes }) => writes),
      rejectedShortcutWritesBefore,
      "a rejected new-tab shortcut must not reach any Ghostty PTY",
    );

    await electronApplication.evaluate(() => {
      globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseConsoleExitHold();
    });
    await consolePage.getByRole("tab", {
      name: new RegExp(`Console ${lastTabOrdinalAtCap}.*Connected`, "iu"),
    }).waitFor({ state: "detached" });
    const closedAtCapRoot = rootDirectories.at(-1);
    assert.ok(closedAtCapRoot);
    await waitForPathRemoval(closedAtCapRoot);

    const replacementOrdinal = lastTabOrdinalAtCap + 1;
    await consolePage.getByRole("button", { name: "New console tab" }).click();
    await consolePage.getByRole("tab", {
      name: new RegExp(`Console ${replacementOrdinal}.*Connected`, "iu"),
    }).waitFor();
    const replacementState = await waitForConsoleState(
      electronApplication,
      (state) => state.console.spawns.length === spawnCountAtCap + 1,
      "a replacement console spawn after held shutdown completes",
    );
    const replacementSpawn = replacementState.console.spawns[spawnCountAtCap];
    assert.ok(replacementSpawn);
    rootDirectories.push(replacementSpawn.rootDirectory);
    assert.equal(replacementSpawn.configSha256, firstSpawn.configSha256);
    assert.equal(await consolePage.getByRole("tab").count(), CONSOLE_MAX_TABS_PER_WINDOW);
    assert.deepEqual(pageErrors, []);

    await verifyConsoleWindowResume(electronApplication, sourcePage, consolePage);
    await waitForSelectedConsoleTab(consolePage, new RegExp(`Console ${replacementOrdinal}`, "iu"));
    assert.equal(await consolePage.getByRole("tab").count(), CONSOLE_MAX_TABS_PER_WINDOW);

    for (let remaining = CONSOLE_MAX_TABS_PER_WINDOW; remaining > 0; remaining -= 1) {
      await consolePage.getByRole("button", { name: "Close active console tab" }).click();
      await waitForConsoleState(
        electronApplication,
        (state) => state.console.kills === initialKillCount + 3 + CONSOLE_MAX_TABS_PER_WINDOW - remaining + 1,
        "explicit console tab cleanup after reopening the window",
      );
    }
    await consolePage.getByText("No console tabs", { exact: true }).waitFor();
    for (const rootDirectory of rootDirectories) await waitForPathRemoval(rootDirectory);
    assert.deepEqual(pageErrors, []);
  } finally {
    await electronApplication.evaluate(() => {
      globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseConsoleExitHold();
    }).catch(() => undefined);
    if (!consolePage.isClosed()) {
      await electronApplication.browserWindow(consolePage).then(async (nativeWindow) => {
        try {
          await nativeWindow.evaluate((window) => window.destroy());
        } finally {
          await nativeWindow.dispose();
        }
      }).catch(() => undefined);
    }
  }

  const closedState = await waitForConsoleState(
    electronApplication,
    (state) => state.console.kills === initialKillCount + CONSOLE_MAX_TABS_PER_WINDOW + 3,
    "all explicitly closed console tabs to finish cleanup",
  );
  assert.equal(
    closedState.console.spawns.length,
    initialSpawnCount + CONSOLE_MAX_TABS_PER_WINDOW + 3,
  );
  assert.equal(closedState.console.spawns.at(-1)?.kills, 1);
  assert.equal(rootDirectories.length, CONSOLE_MAX_TABS_PER_WINDOW + 3);
  assert.equal(
    await readFile(clientRootMarker, "utf8"),
    "preserve shared client assets",
    "private console cleanup must never remove or alter the shared Sliver client root",
  );
  await waitForWindowCount(electronApplication, initialWindowCount);
}

async function verifyReleaseDownloadToast(
  electronApplication: ElectronApplication,
  page: Page,
): Promise<void> {
  const base = {
    downloadId: "8e577480-5dc2-4dde-aa58-23c8f1770627",
    artifact: "server",
    os: "linux",
    arch: "amd64",
  } as const;
  await sendReleaseDownloadEvent(electronApplication, { ...base, status: "started" });
  await page.getByText("Downloading Sliver server · Linux / amd64", { exact: true }).waitFor();
  const progress = page.getByRole("progressbar", { name: /Downloading Sliver server/ });
  await progress.waitFor();
  assert.equal(await progress.getAttribute("aria-valuenow"), null);

  await sendReleaseDownloadEvent(electronApplication, {
    ...base,
    status: "progress",
    version: "v1.7.3",
    fileName: "sliver-server_linux-amd64",
    receivedBytes: 25 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
  });
  await page.getByText("25% · 25.0 MB / 100.0 MB", { exact: true }).waitFor();
  assert.equal(await progress.getAttribute("aria-valuenow"), "25");

  await sendReleaseDownloadEvent(electronApplication, {
    ...base,
    status: "completed",
    version: "v1.7.3",
    fileName: "sliver-server_linux-amd64",
    receivedBytes: 100 * 1024 * 1024,
    totalBytes: 100 * 1024 * 1024,
  });
  await page.getByText("Download complete", { exact: true }).waitFor();
  await page.getByText("sliver-server_linux-amd64 was saved to Downloads.", { exact: true }).waitFor();
}

async function sendReleaseDownloadEvent(
  electronApplication: ElectronApplication,
  event: SliverReleaseDownloadEvent,
): Promise<void> {
  await electronApplication.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error("Expected an application window");
    window.webContents.send(input.channel, input.event);
  }, { channel: IPC.releaseDownloadChanged, event });
}

async function verifyM1TargetsAndOperations(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
  m4PrivateKeyPath: string,
  m4SavedOutputPath: string,
): Promise<void> {
  const initial = await rendererSnapshot(page);
  assert.deepEqual(initial.sessions.map(({ id, name }) => ({ id, name })), [
    { id: "m1_session", name: "m1-session" },
  ]);
  assert.deepEqual(initial.beacons.map(({ id, name }) => ({ id, name })), [
    { id: "m1_beacon", name: "m1-beacon" },
  ]);
  assert.deepEqual(initial.operators.map(({ name, online }) => ({ name, online })), [
    { name: "m0-e2e-operator", online: true },
    { name: "m1-read-only-observer", online: true },
  ]);
  assert.equal(initial.sessions[0]?.remoteAddress, "127.0.0.1:41001");
  assert.equal(initial.beacons[0]?.activeC2, "https://127.0.0.1:4445");

  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const sessionsGrid = page.locator('[aria-label="Sliver sessions"]');
  await sessionsGrid.getByText("m1-session", { exact: true }).waitFor();
  assert.equal(await sessionsGrid.getByText("m1-beacon", { exact: true }).count(), 0);
  const sessionRef = requireTargetRef(initial, "session");
  const beaconRef = requireTargetRef(initial, "beacon");
  await page.getByRole("row", { name: /m1-session/i }).click();
  await waitForSnapshot(page, (snapshot) => snapshot.targetContext.activeTarget?.id === sessionRef.id);
  await verifyM2SessionWorkspace(
    electronApplication,
    page,
    artifactDirectory,
    m4PrivateKeyPath,
    m4SavedOutputPath,
    sessionRef,
    beaconRef,
  );

  const sessionPing = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.equal(sessionPing.mode, "session");
  assert.equal(sessionPing.state, "completed");
  assert.deepEqual(sessionPing.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation completed",
  });
  assert.equal(sessionPing.ownership.origin, "local");
  assert.equal(sessionPing.disposition?.kind, "structured-detail");

  const sessionMutation = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: "SLIVER_GUI_M1_E2E",
    value: "session-value",
  }));
  assert.equal(sessionMutation.state, "completed");
  assert.equal((await readFakeState(electronApplication)).environment["SLIVER_GUI_M1_E2E"], "session-value");

  await verifyM2SessionActivityAndBack(page);

  // Moving through unrelated renderer views must not mutate main-owned target
  // selection or its epoch-bound reference.
  await page.locator('[aria-label="Generate"]:visible').click();
  await page.getByRole("heading", { name: "Generate implant" }).waitFor();
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_session");

  await page.locator('[aria-label="Sessions"]:visible').click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.locator('[aria-label="Sliver sessions"]').getByText("m1-session", { exact: true }).waitFor();
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const beaconsGrid = page.locator('[aria-label="Sliver beacons"]');
  assert.equal(await beaconsGrid.getByText("m1-session", { exact: true }).count(), 0);
  await beaconsGrid.getByText("m1-beacon", { exact: true }).waitFor();
  await page.getByRole("row", { name: /m1-beacon/i }).click();
  const selectedBeacon = await waitForSnapshot(
    page,
    (snapshot) => snapshot.targetContext.activeTarget?.id === beaconRef.id,
  );
  assert.deepEqual(
    selectedBeacon.targetContext.capabilities.find(({ id }) => id === "beacon.open-session"),
    { id: "beacon.open-session", available: true },
    "a safe main-owned C2 endpoint must enable beacon session conversion",
  );
  await verifyBeaconAsyncTaskWorkspace(electronApplication, page, beaconRef);
  await verifyInteractionWindowPopout(electronApplication, page, "beacon", "m1-beacon", artifactDirectory);
  await verifyM4BeaconExecution(electronApplication, page);

  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const queuedPing = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.equal(queuedPing.mode, "beacon");
  assert.equal(queuedPing.state, "submitted");
  assert.deepEqual(queuedPing.progress, {
    completedUnits: 2,
    totalUnits: 3,
    message: "Waiting for beacon task delivery",
  });
  const fakeAfterBeaconPing = await readFakeState(electronApplication);
  assert.ok(
    queuedPing.taskId,
    `beacon ping must expose an exact task correlation ID; state=${queuedPing.state}; ` +
      `message=${queuedPing.message ?? "none"}; fake=${JSON.stringify({
        tasks: fakeAfterBeaconPing.tasks,
        methods: fakeAfterBeaconPing.methods.slice(-8),
      })}`,
  );
  const awaitingPing = await waitForOperation(page, queuedPing.requestId, "running");
  assert.equal(awaitingPing.taskId, queuedPing.taskId);
  assert.deepEqual(awaitingPing.progress, {
    completedUnits: 2,
    totalUnits: 3,
    message: "Waiting for authoritative task completion",
  });
  await page.locator('[aria-label="Generate"]:visible').click();
  await page.getByRole("heading", { name: "Generate implant" }).waitFor();
  await electronApplication.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, true);
  }, queuedPing.taskId!);
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const completedPing = await waitForOperation(page, queuedPing.requestId, "completed");
  assert.equal(completedPing.taskId, queuedPing.taskId);
  assert.equal(completedPing.disposition?.kind, "structured-detail");
  assert.deepEqual(completedPing.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation completed",
  });
  const completedPingRow = page.getByRole("row").filter({ hasText: queuedPing.requestId });
  await completedPingRow.waitFor();
  await completedPingRow.getByText("Completed", { exact: true }).waitFor();

  const completedTasks = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
  assert.equal(completedTasks.ok, true);
  const correlatedTask = completedTasks.value?.items.find((task) => task.taskId === queuedPing.taskId);
  assert.equal(correlatedTask?.localRequestId, queuedPing.requestId);
  assert.equal(correlatedTask?.ownership.origin, "local");
  assert.equal(correlatedTask?.state, "completed");
  const taskDetail = await invokeSliver(page, "getBeaconTask", { taskId: queuedPing.taskId! });
  assert.equal(taskDetail.ok, true);
  assert.equal(taskDetail.value?.disposition?.kind, "structured-detail");

  const openSession = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "beacon.open-session",
    delaySeconds: 2,
  }));
  assert.equal(openSession.state, "submitted");
  assert.deepEqual(openSession.progress, {
    completedUnits: 2,
    totalUnits: 3,
    message: "Waiting for beacon task delivery",
  });
  assert.ok(openSession.taskId, "session conversion must retain its exact task binding");
  assert.deepEqual((await readFakeState(electronApplication)).openSessionRequests.at(-1), {
    beaconId: "m1_beacon",
    c2s: ["https://operator:FAKE_TARGET_SECRET_M1_DO_NOT_RENDER@127.0.0.1:4445/secret-path"],
    delayNanoseconds: "2000000000",
  });
  const completedOpenSession = await waitForOperation(page, openSession.requestId, "completed");
  assert.equal(completedOpenSession.taskId, openSession.taskId);
  assert.equal(completedOpenSession.disposition?.kind, "inline-text");

  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const cancelable = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.env-set",
    name: "SLIVER_GUI_M1_CANCEL",
    value: "cancel-me",
  }));
  assert.ok(cancelable.taskId);
  const canceled = requireOperation(await invokeSliver(page, "cancelTargetOperation", {
    requestId: cancelable.requestId,
  }));
  assert.equal(canceled.state, "canceled");
  assert.deepEqual(canceled.progress, {
    completedUnits: 3,
    totalUnits: 3,
    message: "Operation canceled",
  });
  assert.equal(
    (await readFakeState(electronApplication)).tasks.find((task) => task.id === cancelable.taskId)?.state,
    "canceled",
  );
  const canceledTasks = await invokeSliver(page, "listBeaconTasks", { limit: 100 });
  assert.equal(canceledTasks.ok, true);
  assert.equal(
    canceledTasks.value?.items.find((task) => task.taskId === cancelable.taskId)?.state,
    "canceled",
    "the authoritative task inventory must confirm cancellation",
  );

  const operationPage = await invokeSliver(page, "listTargetOperations", { limit: 1 });
  assert.equal(operationPage.ok, true);
  assert.ok(
    (operationPage.value?.page.total ?? 0) >= 30,
    "the unified history must retain the M1 records and the exercised M2 workbench activity",
  );
  assert.equal(operationPage.value?.page.truncated, true);
  assert.match(operationPage.value?.page.nextCursor ?? "", /^operation:v1:/u);
  const nextOperationPage = await invokeSliver(page, "listTargetOperations", {
    cursor: operationPage.value!.page.nextCursor!,
    limit: 1,
  });
  assert.equal(nextOperationPage.ok, true);
  assert.equal(nextOperationPage.value?.items.length, 1);
  assert.notEqual(nextOperationPage.value?.items[0]?.requestId, operationPage.value?.items[0]?.requestId);

  const taskPage = await invokeSliver(page, "listBeaconTasks", { limit: 1 });
  assert.equal(taskPage.ok, true);
  assert.equal(taskPage.value?.page.total, 5);
  assert.equal(taskPage.value?.page.truncated, true);
  assert.match(taskPage.value?.page.nextCursor ?? "", /^task:v2:/u);
  const nextTaskPage = await invokeSliver(page, "listBeaconTasks", {
    cursor: taskPage.value!.page.nextCursor!,
    limit: 1,
  });
  assert.equal(nextTaskPage.ok, true);
  assert.equal(nextTaskPage.value?.items.length, 1);
  assert.notEqual(nextTaskPage.value?.items[0]?.taskId, taskPage.value?.items[0]?.taskId);

  // Complete a held task without its server event, interrupt the event stream,
  // and prove the connected transition reconciles authoritative task state.
  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const reconnectTask = requireOperation(await invokeSliver(page, "submitTargetOperation", {
    operationId: "target.ping",
  }));
  assert.ok(reconnectTask.taskId);
  await electronApplication.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, false);
    globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("retrying");
  }, reconnectTask.taskId!);
  await waitForSnapshot(page, (snapshot) => snapshot.connection.status === "reconnecting");
  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.setEventStreamStatus("connected");
  });
  await waitForOperation(page, reconnectTask.requestId, "completed");
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
  await page.locator('[aria-label="Beacons"]:visible').click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const reconnectRow = page.getByRole("row").filter({ hasText: reconnectTask.requestId });
  await reconnectRow.waitFor();
  await reconnectRow.getByText("Completed", { exact: true }).waitFor();

  const windowCount = electronApplication.windows().length;
  await page.getByRole("button", { name: "New window options" }).click();
  await page.getByRole("menuitem", { name: "Same server" }).click();
  const secondPage = await waitForAdditionalWindow(electronApplication, windowCount, page);
  await secondPage.getByRole("heading", { name: "Overview", exact: true }).waitFor();
  try {
    const secondSnapshot = await rendererSnapshot(secondPage);
    const secondSessionRef = requireTargetRef(secondSnapshot, "session");
    const secondSelection = await invokeSliver(secondPage, "selectTarget", secondSessionRef);
    assert.equal(secondSelection.ok, true);
    assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_beacon");
    assert.equal((await rendererSnapshot(secondPage)).targetContext.activeTarget?.id, "m1_session");

    const secondPing = requireOperation(await invokeSliver(secondPage, "submitTargetOperation", {
      operationId: "target.ping",
    }));
    assert.equal(secondPing.state, "completed");
    assert.equal(secondPing.ownership.origin, "local");
    assert.notEqual(
      secondPing.ownership.origin === "local" ? secondPing.ownership.ownerWindowId : undefined,
      sessionPing.ownership.origin === "local" ? sessionPing.ownership.ownerWindowId : undefined,
    );
    const firstHistory = await invokeSliver(page, "listTargetOperations", { limit: 100 });
    assert.equal(firstHistory.ok, true);
    assert.ok(!firstHistory.value?.items.some((operation) => operation.requestId === secondPing.requestId));

    await secondPage.locator('[aria-label="Sessions"]:visible').click();
    await secondPage.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await secondPage.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await secondPage.getByRole("heading", { name: "m1-session", exact: true }).waitFor();

    // Leave a second-window shell detached, then remove its exact session.
    // Target disappearance must close the main-owned resource and quarantine
    // every renderer surface that could otherwise retain stale terminal data.
    await secondPage.getByRole("tab", { name: "Shell", exact: true }).click();
    await secondPage.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();
    const secondShellStarts = fakeMethodCount(await readFakeState(electronApplication), "startShellSession");
    await secondPage.getByRole("button", { name: "New shell", exact: true }).first().click();
    await waitForFakeMethodCount(electronApplication, "startShellSession", secondShellStarts + 1);
    await secondPage.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).waitFor();
    await secondPage.getByText("Attached", { exact: true }).waitFor();
    await secondPage.getByRole("tab", { name: "Overview", exact: true }).click();

    const closePlan = await invokeSliver(secondPage, "prepareTargetAction", { actionId: "session.close" });
    assert.equal(closePlan.ok, true);
    assert.equal(closePlan.value?.impact.targets.length, 1);
    assert.equal(closePlan.value?.impact.targets[0]?.id, "m1_session");
    assert.match(closePlan.value?.impact.warning ?? "", /interactive connection without killing the remote process/i);
    assert.ok(closePlan.value?.token, "destructive action review must issue a one-use confirmation token");

    await secondPage.getByRole("button", { name: "Session actions", exact: true }).click();
    await secondPage.getByRole("menuitem", { name: "Close Session", exact: true }).click();
    const closeReview = secondPage.getByRole("dialog", { name: /review close session/i });
    await closeReview.waitFor();
    const closeReviewText = await closeReview.innerText();
    assert.ok(closeReviewText.includes("m1-session"));
    assert.ok(closeReviewText.includes("m1_session"));
    assert.match(closeReviewText, /one-use review is bound to the exact backend epoch and target set/i);
    await closeReview.getByRole("button", { name: "Cancel", exact: true }).click();
    await closeReview.waitFor({ state: "hidden" });

    const shellClosesBeforeTargetLoss = fakeMethodCount(await readFakeState(electronApplication), "shell.close");
    const closeResult = await invokeSliver(secondPage, "executeTargetActionPlan", {
      token: closePlan.value!.token,
    });
    assert.equal(closeResult.ok, true);
    assert.equal(closeResult.value?.outcomes[0]?.status, "succeeded");
    await waitForFakeMethodCount(electronApplication, "shell.close", shellClosesBeforeTargetLoss + 1);
    await secondPage.getByRole("heading", { name: "Session workspace unavailable", exact: true }).waitFor();
    assert.equal(
      await secondPage.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).count(),
      0,
      "session loss must dispose the stale terminal surface",
    );
    assert.equal(await secondPage.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);
    const replay = await invokeSliver(secondPage, "executeTargetActionPlan", {
      token: closePlan.value!.token,
    });
    assert.equal(replay.ok, false, "destructive confirmation tokens must be one-use");
  } finally {
    await secondPage.close().catch(() => undefined);
  }
  await page.locator('[aria-label="Jobs & listeners"]:visible').click();
  await page.getByRole("heading", { name: "Jobs & listeners" }).waitFor();
}

async function verifyInteractionWindowPopout(
  electronApplication: ElectronApplication,
  sourcePage: Page,
  mode: "session" | "beacon",
  expectedName: string,
  artifactDirectory: string,
): Promise<void> {
  const sourceSnapshot = await rendererSnapshot(sourcePage);
  const sourceTarget = sourceSnapshot.targetContext.activeTarget;
  assert.equal(sourceTarget?.mode, mode);
  assert.ok(sourceTarget, `expected an active ${mode} before popping out its interaction workspace`);

  const existingWindows = new Set(electronApplication.windows());
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const observeWindow = (candidate: Page): void => {
    candidate.on("pageerror", (error) => pageErrors.push(error.message));
    candidate.on("request", (request) => {
      if (/^https?:/iu.test(request.url())) externalRequests.push(request.url());
    });
    candidate.on("websocket", (socket) => externalRequests.push(socket.url()));
  };
  electronApplication.on("window", observeWindow);

  let popout: Page | undefined;
  try {
    if (mode === "session") {
      await sourcePage.getByRole("button", { name: "Sessions, switch session", exact: true }).click();
      await sourcePage.getByRole("menuitemradio", { name: /m1-session/iu }).waitFor();
      await sourcePage.screenshot({
        animations: "disabled",
        path: join(artifactDirectory, "session-breadcrumb-dropdown.png"),
      });
      await sourcePage.keyboard.press("Escape");
    }
    await sourcePage.getByRole("button", { name: "Pop out interaction", exact: true }).click();
    popout = await waitForInteractionWindow(electronApplication, existingWindows);
    await popout.locator('[aria-label="Dedicated interaction window"]').waitFor();
    await popout.getByRole("heading", { name: expectedName, exact: true }).first().waitFor();
    if (mode === "session") {
      await popout.getByRole("navigation", { name: "Session workspace breadcrumbs", exact: true }).waitFor();
      await popout.getByRole("tablist", { name: "Session interaction sections", exact: true }).waitFor();
    } else {
      await popout.getByRole("heading", { name: "Async task workspace", exact: true }).waitFor();
      await popout.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
      await popout.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
      await popout.getByRole("heading", { name: "Task completion", exact: true }).waitFor();
      assert.equal(
        await popout.getByRole("heading", { name: "All target operations", exact: true }).count(),
        0,
        "the beacon popout must use the task-focused interaction surface",
      );
      assert.equal(
        await popout.getByRole("heading", { name: "Operator presence", exact: true }).count(),
        0,
        "the beacon popout must not retain the catalog sidebar content",
      );
    }
    await popout.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, `interaction-${mode}.png`),
    });

    assert.equal(
      await popout.locator('[aria-label="Operational navigation"]').count(),
      0,
      "a dedicated interaction window must not render the application sidebar",
    );
    assert.equal(
      await popout.getByRole("button", { name: "New window options", exact: true }).count(),
      0,
      "a dedicated interaction window must not render generic window chrome",
    );
    assert.equal(
      await popout.getByRole("button", { name: "Pop out interaction", exact: true }).count(),
      0,
      "a dedicated interaction window must not recursively expose another popout action",
    );
    if (mode === "beacon") {
      assert.equal(
        await popout.locator('[aria-label="Sliver beacons"]').count(),
        0,
        "the beacon interaction window must not retain the target catalog",
      );
      assert.equal(
        await popout.getByRole("button", { name: "Background target", exact: true }).count(),
        0,
        "the dedicated beacon must stay focused on its exact target",
      );
    }

    const popoutUrl = popout.url();
    const parsedPopoutUrl = new URL(popoutUrl);
    assert.equal(parsedPopoutUrl.searchParams.get("surface"), "interaction");
    assert.equal(parsedPopoutUrl.search, "?surface=interaction", "the interaction URL must use one static marker only");
    assert.equal(parsedPopoutUrl.hash, "", "the interaction URL must not carry fragment launch data");
    assert.equal(parsedPopoutUrl.username, "");
    assert.equal(parsedPopoutUrl.password, "");
    const decodedPopoutUrl = decodeURIComponent(popoutUrl);
    for (const forbidden of [
      sourceTarget.id,
      sourceTarget.fingerprint,
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      EVENT_SECRET,
      TARGET_SECRET,
      TASK_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
    ]) {
      assert.ok(!decodedPopoutUrl.includes(forbidden), `interaction-window URL exposed ${forbidden}`);
    }
    assert.equal(await popout.evaluate(() => (
      globalThis as unknown as { opener?: unknown }
    ).opener === null), true);

    const popoutWindowState = await electronApplication.evaluate(({ BrowserWindow }, expectedUrl) => {
      const interactionWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === expectedUrl,
      );
      if (!interactionWindow) throw new Error("Expected a dedicated interaction BrowserWindow");
      const preferences = (interactionWindow.webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>;
      }).getLastWebPreferences();
      return {
        isVisible: interactionWindow.isVisible(),
        preferences: {
          contextIsolation: preferences["contextIsolation"],
          nodeIntegration: preferences["nodeIntegration"],
          nodeIntegrationInWorker: preferences["nodeIntegrationInWorker"] ?? false,
          nodeIntegrationInSubFrames: preferences["nodeIntegrationInSubFrames"],
          sandbox: preferences["sandbox"],
          webSecurity: preferences["webSecurity"],
          webviewTag: preferences["webviewTag"],
        },
      };
    }, popoutUrl);
    assert.equal(popoutWindowState.isVisible, true, "the ready interaction BrowserWindow must be visible");
    assert.deepEqual(popoutWindowState.preferences, {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });

    const destinationSnapshot = await rendererSnapshot(popout);
    assert.deepEqual(
      stableTargetIdentity(destinationSnapshot.targetContext.activeTarget),
      stableTargetIdentity(sourceTarget),
      "the dedicated window must start on the source window's exact target identity",
    );
    assert.equal(destinationSnapshot.connection.server, sourceSnapshot.connection.server);
    assert.equal(destinationSnapshot.connection.epoch, sourceSnapshot.connection.epoch);

    if (mode === "session") {
      const sourceShells = await invokeSliver(sourcePage, "listSessionShells", {});
      assert.equal(sourceShells.ok, true, sourceShells.error ?? "source shell inventory failed");
      assert.ok((sourceShells.value?.resources.length ?? 0) > 0, "the source must own a shell for the isolation proof");
      const destinationShells = await invokeSliver(popout, "listSessionShells", {});
      assert.equal(destinationShells.ok, true, destinationShells.error ?? "destination shell inventory failed");
      assert.deepEqual(destinationShells.value?.resources, [], "whole-workspace popout must not copy shell ownership");
      const sourceShellsAfterOpen = await invokeSliver(sourcePage, "listSessionShells", {});
      assert.deepEqual(
        sourceShellsAfterOpen.value?.resources.map(({ resourceId }) => resourceId),
        sourceShells.value?.resources.map(({ resourceId }) => resourceId),
        "whole-workspace popout must leave exact shell ownership in the source window",
      );

      const historyBeforePing = await invokeSliver(popout, "listTargetOperations", { limit: 100 });
      assert.equal(historyBeforePing.ok, true, historyBeforePing.error ?? "destination operation history failed");
      const existingRequestIds = new Set(
        historyBeforePing.value?.items.map(({ requestId }) => requestId) ?? [],
      );
      await popout.getByRole("button", { name: "Run ping", exact: true }).click();
      const destinationPing = await waitForNewTargetOperation(popout, existingRequestIds, "target.ping");
      const destinationHistory = await invokeSliver(popout, "listTargetOperations", { limit: 100 });
      assert.equal(destinationHistory.ok, true, destinationHistory.error ?? "destination operation history failed");
      assert.ok(
        destinationHistory.value?.items.some((operation) => operation.requestId === destinationPing.requestId),
        "the dedicated interaction must retain its own submitted operation",
      );
      const sourceHistory = await invokeSliver(sourcePage, "listTargetOperations", { limit: 100 });
      assert.equal(sourceHistory.ok, true, sourceHistory.error ?? "source operation history failed");
      assert.ok(
        !sourceHistory.value?.items.some((operation) => operation.requestId === destinationPing.requestId),
        "dedicated interaction operations must remain destination-window-owned",
      );
    } else {
      await popout.getByRole("button", { name: "Queue task", exact: true }).waitFor();
    }

    const replacementMode = mode === "session" ? "beacon" : "session";
    const replacementTarget = requireTargetRef(destinationSnapshot, replacementMode);
    const replacement = await invokeSliver(popout, "selectTarget", replacementTarget);
    assert.equal(replacement.ok, false, "a dedicated interaction window must reject cross-mode retargeting");
    assert.deepEqual(
      stableTargetIdentity((await rendererSnapshot(popout)).targetContext.activeTarget),
      stableTargetIdentity(sourceTarget),
      "a rejected cross-mode request must leave the exact destination target selected",
    );

    const background = await invokeSliver(popout, "backgroundTarget");
    assert.equal(background.ok, true, background.error ?? "destination target-loss setup failed");
    await popout.getByRole("heading", {
      name: mode === "session" ? "Session workspace unavailable" : "Beacon interaction unavailable",
      exact: true,
    }).waitFor();
    const sourceTargetAfterLoss = (await rendererSnapshot(sourcePage)).targetContext.activeTarget;
    assert.deepEqual(
      stableTargetIdentity(sourceTargetAfterLoss),
      stableTargetIdentity(sourceTarget),
      "destination target loss must not change the source window's exact target",
    );

    await popout.reload();
    await popout.locator('[aria-label="Dedicated interaction window"]').waitFor();
    await popout.getByRole("heading", { name: expectedName, exact: true }).first().waitFor();
    const restoredSnapshot = await waitForSnapshot(
      popout,
      (snapshot) => targetsHaveSameStableIdentity(snapshot.targetContext.activeTarget, sourceTarget),
    );
    assert.deepEqual(
      stableTargetIdentity(restoredSnapshot.targetContext.activeTarget),
      stableTargetIdentity(sourceTarget),
      "reload must reclaim the main-owned launch identity instead of repinning from renderer state",
    );
    assert.equal(
      await popout.getByRole("button", { name: "Pop out interaction", exact: true }).count(),
      0,
      "a reloaded dedicated interaction window must remain non-recursive",
    );
    assert.deepEqual(externalRequests, [], "the dedicated interaction window must remain network inert");
  } finally {
    electronApplication.off("window", observeWindow);
    await popout?.close().catch(() => undefined);
  }
  assert.deepEqual(pageErrors, []);
}

async function verifyBeaconAsyncTaskWorkspace(
  electronApplication: ElectronApplication,
  page: Page,
  beaconRef: TargetRef,
): Promise<void> {
  await page.getByRole("heading", { name: "Async task workspace", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Queue a beacon task", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Task queue", exact: true }).waitFor();
  await page.getByRole("heading", { name: "Task completion", exact: true }).waitFor();

  const command = page.locator('[data-slot="autocomplete-trigger"]:visible');
  await command.click();
  const search = page.getByRole("searchbox", { name: "Search beacon commands", exact: true });
  await search.fill("list directory");
  await page.getByRole("option", { name: /List directory/iu }).click();
  const path = page.locator('input[name="path"]:visible');
  await path.fill("/Users/e2e/workspace");

  const beforeQueue = await readFakeState(electronApplication);
  const existingTaskIds = new Set(beforeQueue.tasks.map((task) => task.id));
  const lsCalls = fakeMethodCount(beforeQueue, "lsBeacon");
  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  await page.getByRole("button", { name: "Queue task", exact: true }).click();
  await waitForFakeMethodCount(electronApplication, "lsBeacon", lsCalls + 1);

  const queuedTask = await waitForNewFakeBeaconTask(
    electronApplication,
    existingTaskIds,
    "LsReq",
  );
  assert.equal(queuedTask.beaconId, beaconRef.id);
  assert.equal(queuedTask.state, "pending");

  const queue = page.getByRole("grid", { name: "Beacon task queue", exact: true });
  const queuedRow = queue.getByRole("row").filter({ hasText: queuedTask.id });
  await queuedRow.waitFor();
  await queuedRow.getByText("Pending", { exact: true }).waitFor();
  await page.getByText("Waiting for the beacon", { exact: true }).waitFor();

  await electronApplication.evaluate((_electron, taskId) => {
    globalThis.__SLIVER_GUI_E2E_CONTROL__.completeTask(taskId, true);
  }, queuedTask.id);
  await queuedRow.getByText("Completed", { exact: true }).waitFor();
  await page.getByText("Directory listing", { exact: true }).waitFor();
  await page.getByRole("cell", { name: "notes.txt", exact: true }).first().waitFor();
  await page.getByText("projects", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Back to live beacons", exact: true }).click();
  await page.getByRole("heading", { name: "Beacons", exact: true }).waitFor();
  const beaconsGrid = page.locator('[aria-label="Sliver beacons"]');
  await beaconsGrid.getByText("m1-beacon", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("heading", { name: "Async task workspace", exact: true }).count(),
    0,
    "Back from Beacon Interact must return to the live beacon catalog",
  );

  await activateDataGridRow(
    page.getByRole("row", { name: /m1-beacon/iu }),
    "m1-beacon",
    page.getByRole("heading", { name: "Async task workspace", exact: true }),
  );
}

async function verifyM2SessionWorkspace(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
  m4PrivateKeyPath: string,
  m4SavedOutputPath: string,
  sessionRef: TargetRef,
  beaconRef: TargetRef,
): Promise<void> {
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  await page.getByRole("tablist", { name: "Session interaction sections" }).waitFor();
  assert.equal(
    await page.getByText("Selected session", { exact: true }).count(),
    0,
    "session row activation must replace the legacy selected-session card with a dedicated route",
  );

  await page.getByRole("heading", { name: "Identity", exact: true }).waitFor();
  await page.getByText("m1-session-host", { exact: true }).first().waitFor();
  await page.getByText("Screenshot unavailable", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Network", exact: true }).count(), 0);

  await page.getByRole("tab", { name: "Network", exact: true }).click();
  await page.getByRole("heading", { name: "Network", exact: true }).waitFor();
  await page.getByText("en0", { exact: true }).waitFor();
  await page.getByText("ESTABLISHED", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const filesystemMode = page.getByRole("radiogroup", { name: "Filesystem mode" });
  await filesystemMode.waitFor();
  const filesGrid = page.getByRole("grid", { name: "Files in /Users/e2e/workspace" });
  await filesGrid.waitFor();
  await filesGrid.getByText("notes.txt", { exact: true }).waitFor();
  await filesGrid.getByText("projects", { exact: true }).waitFor();

  const notesRow = filesGrid.getByRole("row").filter({ hasText: "notes.txt" });
  const inspector = page.getByRole("dialog", { name: "notes.txt", exact: true });
  await activateDataGridRow(notesRow, "notes.txt", inspector);
  const fileViews = inspector.getByRole("radiogroup", { name: "File view" });
  await inspector.getByText(M2_INITIAL_FILE_TEXT, { exact: true }).waitFor();
  let downloadCount = fakeMethodCount(await readFakeState(electronApplication), "downloadFileSession");

  await fileViews.getByRole("radio", { name: "Head", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await fileViews.getByRole("radio", { name: "Tail", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await fileViews.getByRole("radio", { name: "Hex", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await inspector.getByText(Buffer.from(M2_INITIAL_FILE_TEXT, "utf8").toString("hex"), { exact: true }).waitFor();
  await fileViews.getByRole("radio", { name: "Cat", exact: true }).click();
  downloadCount += 1;
  await waitForFakeMethodCount(electronApplication, "downloadFileSession", downloadCount);
  await inspector.getByText(M2_INITIAL_FILE_TEXT, { exact: true }).waitFor();

  await inspector.getByRole("button", { name: "Edit", exact: true }).click();
  await inspector.getByRole("textbox", { name: "UTF-8 text", exact: true }).fill(M2_EDITED_CONTENT);
  await inspector.getByRole("button", { name: "Review save", exact: true }).click();
  const saveDialog = page.getByRole("alertdialog", { name: "Save changes to this remote file?", exact: true });
  await saveDialog.waitFor();
  const saveReviewText = await saveDialog.innerText();
  assert.ok(saveReviewText.includes("/Users/e2e/workspace/notes.txt"));
  assert.match(saveReviewText, /plan payload sha-256/i);
  assert.ok(!saveReviewText.includes(M2_EDITED_CONTENT), "review metadata must not echo staged editor content");
  await saveDialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await saveDialog.waitFor({ state: "hidden" });
  await waitForFakeMethodCount(electronApplication, "uploadSession", 1);
  await page.keyboard.press("Escape");
  await inspector.waitFor({ state: "hidden" });

  await activateDataGridRow(notesRow, "notes.txt", inspector);
  await inspector.getByText(M2_EDITED_CONTENT, { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await inspector.waitFor({ state: "hidden" });

  await page.getByLabel("New folder name").fill("m2-e2e-folder");
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  const createdFolderRow = filesGrid.getByRole("row").filter({ hasText: "m2-e2e-folder" });
  await createdFolderRow.waitFor();
  await createdFolderRow.getByRole("button", { name: "More actions for m2-e2e-folder", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Delete/u }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "Delete this remote item?", exact: true });
  await deleteDialog.waitFor();
  const reviewText = await deleteDialog.innerText();
  assert.ok(reviewText.includes("/Users/e2e/workspace/m2-e2e-folder"));
  assert.match(reviewText, /backend.*payload change invalidates it/i);
  await deleteDialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await deleteDialog.waitFor({ state: "hidden" });
  await createdFolderRow.waitFor({ state: "hidden" });

  await selectRadioOption(filesystemMode.getByRole("radio", { name: "Search", exact: true }));
  await page.getByRole("textbox", { name: "Search path", exact: true }).fill("/Users/e2e/workspace");
  await page.getByRole("textbox", { name: "Pattern", exact: true }).fill(M2_SEARCH_PATTERN);
  const grepCalls = fakeMethodCount(await readFakeState(electronApplication), "grepSession");
  const searchButton = page.getByRole("button", { name: "Search", exact: true });
  await waitForRendererCommit(searchButton);
  assert.equal(await searchButton.isEnabled(), true, "the populated filesystem search must be actionable");
  await searchButton.click();
  await waitForFakeMethodCount(electronApplication, "grepSession", grepCalls + 1);
  const searchGrid = page.getByRole("grid", { name: "Filesystem search results" });
  await searchGrid.waitFor();
  await searchGrid.getByText("/Users/e2e/workspace/match-001.txt", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more matches", exact: true }).click();
  await searchGrid.getByText("/Users/e2e/workspace/match-105.txt", { exact: true }).waitFor();

  await filesystemMode.getByRole("radio", { name: "Storage", exact: true }).click();
  const mountsGrid = page.getByRole("grid", { name: "Session mounts" });
  await mountsGrid.waitFor();
  await mountsGrid.getByText("Macintosh HD", { exact: true }).waitFor();
  await page.getByText("Memory files unavailable", { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Processes", exact: true }).click();
  const processesGrid = page.getByRole("grid", { name: "Session processes" });
  await processesGrid.waitFor();
  await processesGrid.getByText("launchd", { exact: true }).waitFor();
  await processesGrid.getByText("sliver-m2-session", { exact: true }).waitFor();
  await page.getByText("Loaded 100 of 108 processes · bounded", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more processes", exact: true }).click();
  await page.getByText("Loaded 108 of 108 processes", { exact: true }).waitFor();

  const processViews = page.getByRole("radiogroup", { name: "Process view" });
  await processViews.getByRole("radio", { name: "Tree", exact: true }).click();
  const processTree = page.getByRole("grid", { name: "Session process tree" });
  await processTree.waitFor();
  await processTree.getByText("launchd", { exact: true }).waitFor();
  await processTree.getByText("sliver-m2-session", { exact: true }).waitFor();
  await processTree.getByText("zsh", { exact: true }).waitFor();
  const screenshotStateText = await page.locator("body").innerText();
  for (const forbidden of [M2_ENV_SECRET, M2_FILE_CONTENT, M2_EDITED_CONTENT, M2_SEARCH_PATTERN]) {
    assert.ok(!screenshotStateText.includes(forbidden), `M2 visual QA state exposed ${forbidden}`);
  }
  const m2Screenshot = await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "m2-session-workbench.png"),
  });
  for (const forbidden of [M2_ENV_SECRET, M2_FILE_CONTENT, M2_EDITED_CONTENT, M2_SEARCH_PATTERN]) {
    assert.equal(m2Screenshot.includes(Buffer.from(forbidden)), false, `M2 screenshot bytes exposed ${forbidden}`);
  }
  await processViews.getByRole("radio", { name: "List", exact: true }).click();
  await processesGrid.waitFor();
  await page.getByRole("searchbox", { name: "Filter processes" }).fill("zsh");
  await page.getByText("Loaded 1 of 1 processes matching “zsh”", { exact: true }).waitFor();
  await processesGrid.getByText("zsh", { exact: true }).waitFor();
  assert.equal(await processesGrid.getByText("launchd", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("radiogroup", { name: "Process inventory" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Dump process /u }).count(), 0);

  await page.getByRole("tab", { name: "Environment", exact: true }).click();
  const environmentGrid = page.getByRole("grid", { name: "Session environment variables" });
  await environmentGrid.waitFor();
  await environmentGrid.getByText("HOME", { exact: true }).waitFor();
  await environmentGrid.getByText("/Users/e2e", { exact: true }).waitFor();
  await page.getByText("Loaded 100 of 108 environment variables · bounded", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Load more variables", exact: true }).click();
  await page.getByText("Loaded 108 of 108 environment variables", { exact: true }).waitFor();
  await environmentGrid.getByText("M2_PAGE_105", { exact: true }).waitFor();
  const sensitiveRow = environmentGrid.getByRole("row").filter({ hasText: "SLIVER_GUI_M2_API_TOKEN" });
  await sensitiveRow.waitFor();
  await sensitiveRow.getByText("Sensitive", { exact: true }).waitFor();
  assert.equal(await page.getByText(M2_ENV_SECRET, { exact: true }).count(), 0);
  await sensitiveRow.getByRole("button", {
    name: "Reveal SLIVER_GUI_M2_API_TOKEN",
    exact: true,
  }).click();
  await sensitiveRow.getByText(M2_ENV_SECRET, { exact: true }).waitFor();

  await page.getByRole("tab", { name: "Overview", exact: true }).click();
  assert.ok(!(await page.locator("body").innerText()).includes(M2_ENV_SECRET));
  const state = await readFakeState(electronApplication);
  for (const method of [
    "ifconfigSession",
    "netstatSession",
    "pwdSession",
    "lsSession",
    "downloadFileSession",
    "uploadSession",
    "grepSession",
    "mkdirSession",
    "rmSession",
    "mountsSession",
    "psSession",
    "listEnvSession",
    "revealEnvSession",
  ]) {
    assert.ok(state.methods.includes(method), `expected the M2 workbench to call ${method}`);
  }
  assert.equal(state.dialogCalls, 1, "the M2 journey must not invoke native file dialogs");
  assert.ok(!state.methods.includes("currentTokenOwnerSession"), "Darwin must quarantine the Windows-only token owner RPC");
  assert.ok(!state.methods.includes("screenshotSession"), "Darwin must quarantine the unsupported screenshot RPC");
  assert.ok(!state.methods.includes("processDumpSession"), "Darwin must quarantine the unsupported process dump RPC");
  assert.ok(!state.methods.includes("servicesSession"), "Darwin must quarantine Windows service inventory RPCs");
  assert.ok(!state.methods.includes("memfilesListSession"), "Darwin must quarantine Linux memory-file RPCs");

  await verifyM3SessionTerminal(electronApplication, page, artifactDirectory);
  await verifyM4SessionExecution(
    electronApplication,
    page,
    artifactDirectory,
    m4PrivateKeyPath,
    m4SavedOutputPath,
    sessionRef,
    beaconRef,
  );
}

async function verifyM4SessionExecution(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
  m4PrivateKeyPath: string,
  m4SavedOutputPath: string,
  sessionRef: TargetRef,
  beaconRef: TargetRef,
): Promise<void> {
  await page.getByRole("tab", { name: "Execution", exact: true }).click();
  await page.getByRole("heading", { name: "Execution workbench", exact: true }).waitFor();

  const childrenCalls = fakeMethodCount(await readFakeState(electronApplication), "executeChildrenSession");
  await page.getByRole("button", { name: "Open: Background children", exact: true }).click();
  const childrenGrid = page.getByRole("grid", { name: "Background child processes", exact: true });
  await childrenGrid.waitFor();
  await childrenGrid.getByText("/usr/bin/printf", { exact: true }).waitFor();
  await childrenGrid.getByText("/usr/bin/sleep", { exact: true }).waitFor();
  await waitForFakeMethodCount(electronApplication, "executeChildrenSession", childrenCalls + 1);

  await page.getByRole("radio", { name: "Remote", exact: true }).click();
  await page.getByRole("button", { name: "Open: SSH command", exact: true }).click();
  const configuration = page.getByRole("dialog", { name: "SSH command", exact: true });
  await configuration.waitFor();
  await configuration.getByLabel("Remote hostname").fill("m4-hop.internal");
  await configuration.getByLabel("Username").fill("m4-operator");
  await configuration.getByLabel("Remote command").fill("/usr/bin/id\n-u");
  await configuration.getByLabel("Authentication").click();
  await page.getByRole("option", { name: "Private key chosen during Review", exact: true }).click();
  await configuration.getByRole("region", { name: "Native file selection", exact: true }).waitFor();

  await electronApplication.evaluate(({ dialog }, privateKeyPath) => {
    dialog.showOpenDialog = async () => {
      globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
      return { canceled: false, filePaths: [privateKeyPath] };
    };
  }, m4PrivateKeyPath);
  await configuration.getByRole("button", { name: "Review", exact: true }).click();

  const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
  await review.waitFor();
  const reviewText = await review.innerText();
  assert.ok(reviewText.includes("m1-session"), "M4 review must name the exact selected session");
  assert.ok(reviewText.includes("session:m1_session"), "M4 review must include the exact target ID");
  assert.match(reviewText, /m0-e2e-operator@127\.0\.0\.1:31337/u);
  assert.match(reviewText, /m4-e2e-private\.key/u);
  assert.match(reviewText, /SHA-256 [a-f0-9]{64}/u);
  assert.ok(!reviewText.includes(m4PrivateKeyPath), "native paths must remain in the main process");
  assert.ok(!reviewText.includes(M4_PRIVATE_KEY_SECRET), "native file bytes must not enter review metadata");

  const sshCalls = fakeMethodCount(await readFakeState(electronApplication), "runSshSession");
  await review.getByRole("button", { name: "Execute", exact: true }).click();
  const latestExecution = page.getByRole("region", { name: "Latest execution", exact: true });
  await latestExecution.waitFor();
  await latestExecution.getByText("Remote SSH command completed.", { exact: true }).waitFor();
  await latestExecution.getByText("Completed", { exact: true }).waitFor();
  const saveStdout = latestExecution.getByRole("button", { name: "Save stdout", exact: true });
  await saveStdout.waitFor();
  await waitForFakeMethodCount(electronApplication, "runSshSession", sshCalls + 1);

  await electronApplication.evaluate(({ dialog }, outputPath) => {
    dialog.showSaveDialog = async () => {
      globalThis.__SLIVER_GUI_E2E_STATE__.dialogCalls += 1;
      return { canceled: false, filePath: outputPath };
    };
  }, m4SavedOutputPath);
  await saveStdout.click();
  await page.getByText("Output saved", { exact: true }).waitFor();
  await page.getByText("m4-ssh-stdout.txt", { exact: true }).waitFor();
  assert.deepEqual(await readFile(m4SavedOutputPath), Buffer.from(M4_SSH_STDOUT));

  const afterSsh = await readFakeState(electronApplication);
  assert.equal(afterSsh.m4Audit.artifactInputs, 1);
  assert.equal(afterSsh.m4Audit.credentialInputs, 1);
  assert.ok(afterSsh.m4Audit.artifactInputBytes > 0);
  assert.equal(afterSsh.m4Audit.artifactInputBytes, afterSsh.m4Audit.credentialInputBytes);
  assert.ok(afterSsh.m4Audit.zeroizedCopies >= 2);
  assert.equal(afterSsh.m4Audit.retainedSensitiveInputs, 0);

  const m4BodyText = await page.locator("body").innerText();
  assert.ok(!m4BodyText.includes(M4_PRIVATE_KEY_SECRET));
  assert.ok(!m4BodyText.includes(m4PrivateKeyPath));
  assert.ok(!m4BodyText.includes(M4_SSH_STDOUT_TEXT));
  assert.ok(!m4BodyText.includes(m4SavedOutputPath));
  const m4Screenshot = await page.screenshot({
    animations: "disabled",
    path: join(artifactDirectory, "m4-session-execution.png"),
  });
  assert.equal(m4Screenshot.includes(Buffer.from(M4_PRIVATE_KEY_SECRET)), false);
  assert.equal(m4Screenshot.includes(Buffer.from(m4PrivateKeyPath)), false);
  assert.equal(m4Screenshot.includes(Buffer.from(M4_SSH_STDOUT_TEXT)), false);
  assert.equal(m4Screenshot.includes(Buffer.from(m4SavedOutputPath)), false);

  // A reviewed plan is quarantined as soon as the main-owned exact target
  // changes, without dispatching the stale operation.
  await page.getByRole("radio", { name: "Process", exact: true }).click();
  await page.getByRole("button", { name: "Open: Execute process", exact: true }).click();
  const staleConfiguration = page.getByRole("dialog", { name: "Execute process", exact: true });
  await staleConfiguration.getByLabel("Executable path").fill("/usr/bin/printf");
  await staleConfiguration.getByLabel("Arguments").fill("stale-m4-plan");
  await staleConfiguration.getByRole("button", { name: "Review", exact: true }).click();
  const staleReview = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
  await staleReview.waitFor();
  const executeCalls = fakeMethodCount(await readFakeState(electronApplication), "executeSession");

  const currentBeacon = requireTargetRef(await rendererSnapshot(page), "beacon");
  assert.equal(currentBeacon.id, beaconRef.id);
  const selectedBeacon = await invokeSliver(page, "selectTarget", currentBeacon);
  assert.equal(selectedBeacon.ok, true, selectedBeacon.error ?? "selecting the M4 beacon failed");
  await staleReview.waitFor({ state: "hidden" });
  await page.getByRole("heading", { name: "Session workspace unavailable", exact: true }).waitFor();
  assert.equal(fakeMethodCount(await readFakeState(electronApplication), "executeSession"), executeCalls);

  const currentSession = requireTargetRef(await rendererSnapshot(page), "session");
  assert.equal(currentSession.id, sessionRef.id);
  const selectedSession = await invokeSliver(page, "selectTarget", currentSession);
  assert.equal(selectedSession.ok, true, selectedSession.error ?? "restoring the M4 session failed");
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  await page.getByRole("tablist", { name: "Session interaction sections", exact: true }).waitFor();
}

async function verifyM4BeaconExecution(
  electronApplication: ElectronApplication,
  page: Page,
): Promise<void> {
  await page.getByRole("button", { name: "Show advanced execution", exact: true }).click();
  await page.getByRole("heading", { name: "Execution workbench", exact: true }).waitFor();
  await page.getByRole("button", { name: "Open: Execute process", exact: true }).click();

  const configuration = page.getByRole("dialog", { name: "Execute process", exact: true });
  await configuration.getByLabel("Executable path").fill("/usr/bin/printf");
  await configuration.getByLabel("Arguments").fill("beacon-m4-submitted");
  await configuration.getByRole("button", { name: "Review", exact: true }).click();
  const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
  await review.waitFor();
  const reviewText = await review.innerText();
  assert.ok(reviewText.includes("m1-beacon"));
  assert.ok(reviewText.includes("beacon:m1_beacon"));
  assert.match(reviewText, /m0-e2e-operator@127\.0\.0\.1:31337/u);
  assert.ok(!reviewText.includes(TARGET_SECRET));

  await electronApplication.evaluate(() => {
    globalThis.__SLIVER_GUI_E2E_STATE__.holdNextBeaconTask = true;
  });
  const beaconExecuteCalls = fakeMethodCount(await readFakeState(electronApplication), "executeBeacon");
  await review.getByRole("button", { name: "Execute", exact: true }).click();
  const latestExecution = page.getByRole("region", { name: "Latest execution", exact: true });
  await latestExecution.waitFor();
  await latestExecution.getByText("Submitted", { exact: true }).waitFor();
  await latestExecution.getByText("The reviewed operation was submitted to the selected target.", { exact: true }).waitFor();
  await waitForFakeMethodCount(electronApplication, "executeBeacon", beaconExecuteCalls + 1);
  const afterBeacon = await readFakeState(electronApplication);
  const submittedTask = afterBeacon.tasks.at(-1);
  assert.equal(submittedTask?.beaconId, "m1_beacon");
  assert.equal(submittedTask?.description, "ExecuteReq");
  assert.equal(submittedTask?.state, "pending");
  assert.equal(afterBeacon.m4Audit.retainedSensitiveInputs, 0);

  await page.getByRole("button", { name: "Hide advanced execution", exact: true }).click();
  await page.getByRole("heading", { name: "Execution workbench", exact: true }).waitFor({ state: "hidden" });
}

async function activateDataGridRow(
  row: ReturnType<Page["getByRole"]>,
  visibleName: string,
  expectedSurface: ReturnType<Page["getByRole"]>,
): Promise<void> {
  await row.getByText(visibleName, { exact: true }).click();
  try {
    await expectedSurface.waitFor({ timeout: 5_000 });
  } catch {
    // React Aria exposes Enter as the deterministic row action. This fallback
    // avoids viewport-dependent clicks landing in a trailing action cell.
    await row.press("Enter");
    await expectedSurface.waitFor();
  }
}

async function verifyTerminalClipboard(
  application: ElectronApplication,
  page: Page,
  terminal: Locator,
  selectedWord: string,
  readWrites: () => Promise<string[][]>,
  selectedRuntimeIndex: number,
): Promise<void> {
  const clipboardBefore = await readClipboardText(application);
  const contextMenu = page.getByRole("menu", { name: "Application context menu" });
  const canvas = terminal.locator("canvas");
  const initialWrites = await readWrites();
  const openMenu = async (): Promise<void> => {
    const bounds = await canvas.boundingBox();
    assert.ok(bounds);
    await sendNativeContextMenu(application, page, { x: bounds.x + 12, y: bounds.y + 8 });
    await contextMenu.waitFor();
  };
  const assertClipboard = async (expected: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    let actual = "";
    while (Date.now() < deadline) {
      actual = await readClipboardText(application);
      if (actual === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(actual, expected, "explicit terminal Copy must use Ghostty's highlighted text");
  };
  const waitForSelectedWrites = async (expected: string[]): Promise<void> => {
    const deadline = Date.now() + 5_000;
    let latest: string[][] = [];
    while (Date.now() < deadline) {
      latest = await readWrites();
      if (JSON.stringify(latest[selectedRuntimeIndex]) === JSON.stringify(expected)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.deepEqual(latest[selectedRuntimeIndex], expected,
      "each explicit paste/control key must reach the selected fake runtime exactly once");
    for (const [index, writes] of latest.entries()) {
      if (index !== selectedRuntimeIndex) {
        assert.deepEqual(writes, initialWrites[index], "clipboard actions must not reach another terminal tab");
      }
    }
  };
  try {
    await page.bringToFront();
    await application.evaluate(({ clipboard }) => clipboard.writeText("before-terminal-selection"));
    await canvas.dblclick({ position: { x: 12, y: 8 } });
    await assertClipboard("before-terminal-selection");
    await openMenu();
    assert.equal(await contextMenu.getByRole("menuitem").count(), 3);
    for (const label of ["Copy", "Paste", "Inspect Element"]) {
      assert.equal(await contextMenu.getByRole("menuitem", { name: label, exact: true }).count(), 1);
    }
    const copy = contextMenu.getByRole("menuitem", { name: "Copy", exact: true });
    assert.notEqual(await copy.getAttribute("aria-disabled"), "true");
    await copy.click();
    await contextMenu.waitFor({ state: "hidden" });
    await assertClipboard(selectedWord);
    assert.deepEqual(await readWrites(), initialWrites, "selection and Copy must not write to the terminal");

    const pasted = "context-clipboard-marker";
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), pasted);
    await openMenu();
    await contextMenu.getByRole("menuitem", { name: "Paste", exact: true }).click();
    await contextMenu.waitFor({ state: "hidden" });
    const expectedWrites = [...initialWrites[selectedRuntimeIndex]!, pasted];
    await waitForSelectedWrites(expectedWrites);

    // The native terminal interrupt remains a terminal byte, even while
    // clipboard shortcuts are handled by the enclosing application surface.
    await terminal.focus();
    await sendNativeApplicationShortcut(application, page, "C", { control: true });
    expectedWrites.push("\u0003");
    await waitForSelectedWrites(expectedWrites);

    await application.evaluate(({ clipboard }) => clipboard.writeText("before-terminal-copy-shortcut"));
    await canvas.dblclick({ position: { x: 12, y: 8 } });
    await assertClipboard("before-terminal-copy-shortcut");
    await terminal.focus();
    await sendNativeApplicationShortcut(application, page, "C", { shift: process.platform !== "darwin" });
    await assertClipboard(selectedWord);
    await waitForSelectedWrites(expectedWrites);

    const shortcutPaste = "shortcut-clipboard-marker";
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), shortcutPaste);
    await terminal.focus();
    await sendNativeApplicationShortcut(application, page, "V", { shift: process.platform !== "darwin" });
    expectedWrites.push(shortcutPaste);
    await waitForSelectedWrites(expectedWrites);
  } finally {
    if (!page.isClosed()) {
      await page.keyboard.press("Escape").catch(() => undefined);
      await contextMenu.waitFor({ state: "hidden" }).catch(() => undefined);
    }
    await application.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore);
  }
}

async function verifySshTerminalClipboard(application: ElectronApplication, cloudPage: Page): Promise<void> {
  const windowOpened = application.waitForEvent("window");
  const opened = await cloudPage.evaluate(async (deploymentId) => (
    globalThis as unknown as { cloudDeployment: CloudDeploymentAPI }
  ).cloudDeployment.openSshWindow({ deploymentId }), E2E_AWS_DEPLOYMENT_ID);
  assert.equal(opened.ok, true);
  const sshPage = await windowOpened;
  try {
    assert.equal(new URL(sshPage.url()).search, "?surface=ssh");
    await sshPage.locator('[data-terminal-state="ready"]').waitFor();
    await sshPage.getByRole("button", { name: "New SSH tab", exact: true }).click();
    await sshPage.getByRole("button", {
      name: new RegExp(`Connect to ${E2E_AZURE_DEPLOYMENT_NAME}`),
    }).click();
    await sshPage.locator('[data-ssh-terminal-tab-id][inert]').waitFor({ state: "attached" });
    const activeTerminal = sshPage.locator('[data-ssh-terminal-tab-id]:not([inert])')
      .getByRole("textbox", { name: /^SSH session /u });
    await activeTerminal.waitFor();
    await activeTerminal.locator("canvas").waitFor();
    await verifyTerminalClipboard(
      application,
      sshPage,
      activeTerminal,
      "Managed",
      async () => (await readFakeState(application)).ssh.map(({ writes }) => writes),
      1,
    );
    await sshPage.getByRole("button", { name: "Close active SSH tab", exact: true }).click();
    await sshPage.locator('[data-ssh-terminal-tab-id][inert]').waitFor({ state: "detached" });
    await sshPage.getByRole("button", { name: "Close active SSH tab", exact: true }).click();
    await sshPage.locator("[data-ssh-terminal-tab-id]").waitFor({ state: "detached" });
  } finally {
    await sshPage.close();
    await cloudPage.bringToFront();
  }
}

async function verifyM3SessionTerminal(
  electronApplication: ElectronApplication,
  page: Page,
  artifactDirectory: string,
): Promise<void> {
  const externalNetworkRequests: string[] = [];
  const observeRequest = (request: { url(): string }) => {
    if (/^https?:/iu.test(request.url())) externalNetworkRequests.push(request.url());
  };
  page.on("request", observeRequest);
  try {
    await installM3HostEffectGuards(page);
    await page.getByRole("tab", { name: "Shell", exact: true }).click();
    await page.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();
    await page.getByText("No managed shells", { exact: true }).waitFor();

    const initialState = await readFakeState(electronApplication);
    const initialShellStarts = fakeMethodCount(initialState, "startShellSession");
    const initialEarlyPrompts = fakeMethodCount(initialState, "shell.early-output");
    const initialResizes = fakeMethodCount(initialState, "shell.resize");
    await page.getByRole("button", { name: "New shell", exact: true }).first().click();
    await waitForFakeMethodCount(electronApplication, "startShellSession", initialShellStarts + 1);
    await waitForFakeMethodCount(electronApplication, "shell.early-output", initialEarlyPrompts + 1);

    const terminal = page.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true });
    await terminal.waitFor();
    await page.getByText("Attached", { exact: true }).waitFor();
    await waitForFakeMethodCount(electronApplication, "shell.resize", initialResizes + 1);
    assert.equal(await page.getByRole("button", { name: "Focus", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Stats", exact: true }).count(), 1);
    assert.equal(await page.getByText("Bytes in", { exact: true }).count(), 0, "statistics must not consume terminal layout space");

    const focusedTerminalDom = await terminal.evaluate((host) => {
      const browser = globalThis as unknown as {
        document: { activeElement: unknown };
        getComputedStyle: (element: unknown) => { caretColor: string };
      };
      const canvas = host.querySelector("canvas");
      const hostRect = host.getBoundingClientRect();
      const canvasRect = canvas?.getBoundingClientRect();
      const terminalRootRect = host.closest("[data-terminal-state]")?.getBoundingClientRect();
      const terminalSurfaceRect = host.closest("[data-terminal-surface]")?.getBoundingClientRect();
      return {
        active: browser.document.activeElement === host,
        canvasCount: host.querySelectorAll("canvas").length,
        canvasLeftInset: canvasRect ? canvasRect.left - hostRect.left : Number.NaN,
        canvasTopInset: canvasRect ? canvasRect.top - hostRect.top : Number.NaN,
        caretColor: browser.getComputedStyle(host).caretColor,
        contentEditable: host.getAttribute("contenteditable"),
        terminalBottomGap: terminalRootRect && terminalSurfaceRect
          ? terminalSurfaceRect.bottom - terminalRootRect.bottom
          : Number.NaN,
        textareaCount: host.querySelectorAll("textarea").length,
      };
    });
    assert.equal(focusedTerminalDom.active, true, "the interactive shell host must retain keyboard focus");
    assert.equal(focusedTerminalDom.contentEditable, "true");
    assert.equal(focusedTerminalDom.canvasCount, 1, "Ghostty must retain its canvas-rendered cursor");
    assert.ok(Math.abs(focusedTerminalDom.canvasLeftInset) <= 0.5, "the terminal canvas must be flush with the left edge");
    assert.ok(Math.abs(focusedTerminalDom.canvasTopInset) <= 0.5, "the terminal canvas must be flush beneath the toolbar");
    assert.ok(Math.abs(focusedTerminalDom.terminalBottomGap) <= 1, "the terminal must fill space previously occupied by inline statistics");
    assert.equal(focusedTerminalDom.textareaCount, 1, "Ghostty must retain its hidden input surface");
    assert.match(
      focusedTerminalDom.caretColor,
      /^(?:rgba\(0, 0, 0, 0\)|transparent)$/u,
      "Chromium's native contenteditable caret must be transparent",
    );

    const contextMenu = page.getByRole("menu", { name: "Application context menu" });
    const terminalClipboardText = await readClipboardText(electronApplication);
    const shellWritesBeforeContextMenu = fakeMethodCount(
      await readFakeState(electronApplication),
      "shell.write",
    );
    await page.evaluate(() => {
      const testWindow = globalThis as unknown as {
        applicationContextMenu: {
          onMenuRequested(listener: (request: {
            items: readonly ({ type: "separator" } | { type: "action"; kind: string })[];
          }) => void): () => void;
        };
        __disposeTerminalContextMenuProbe?: () => void;
        __terminalContextMenuKinds?: readonly string[];
      };
      testWindow.__disposeTerminalContextMenuProbe?.();
      delete testWindow.__terminalContextMenuKinds;
      testWindow.__disposeTerminalContextMenuProbe =
        testWindow.applicationContextMenu.onMenuRequested((request) => {
          testWindow.__terminalContextMenuKinds = request.items.flatMap((item) =>
            item.type === "action" ? [item.kind] : []
          );
        });
    });
    try {
      await contextMenu.waitFor({ state: "hidden" });
      const terminalCanvasBounds = await terminal.locator("canvas").boundingBox();
      assert.ok(terminalCanvasBounds, "the Ghostty canvas must have native input bounds");
      await sendNativeContextMenu(electronApplication, page, {
        x: terminalCanvasBounds.x + 8,
        y: terminalCanvasBounds.y + 8,
      });
      await page.waitForFunction(() => Array.isArray(
        (globalThis as unknown as { __terminalContextMenuKinds?: unknown })
          .__terminalContextMenuKinds,
      ));
      assert.deepEqual(
        await page.evaluate(() => (
          globalThis as unknown as { __terminalContextMenuKinds?: readonly string[] }
        ).__terminalContextMenuKinds),
        ["inspect"],
        "the main process must mint only Inspect for the actual Ghostty canvas",
      );
      await contextMenu.waitFor();
      const inspectTerminalCanvas = contextMenu.getByRole(
        "menuitem",
        { name: "Inspect Element", exact: true },
      );
      await inspectTerminalCanvas.waitFor();
      assert.equal(
        await inspectTerminalCanvas.count(),
        1,
        "the terminal context menu must retain Inspect Element",
      );
      for (const label of ["Undo", "Redo", "Cut", "Copy", "Paste", "Delete", "Select All"]) {
        assert.equal(
          await contextMenu.getByRole("menuitem", { name: label, exact: true }).count(),
          0,
          `the terminal context menu must not expose ${label}`,
        );
      }
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      await waitForRendererCommit(terminal);

      await page.evaluate(() => {
        delete (globalThis as unknown as { __terminalContextMenuKinds?: readonly string[] })
          .__terminalContextMenuKinds;
      });
      // The preload's isolated-world classifier must remain authoritative after
      // renderer DOM tampering; renderer-side filtering is presentation only.
      await terminal.evaluate((host) => {
        host.removeAttribute("data-application-context-menu-policy");
      });
      const terminalTextarea = terminal.locator("textarea");
      // Ghostty consumes Shift+F10 as terminal input on Linux. Exercise the
      // real textarea with a native pointer request on every platform instead.
      const originalTerminalTextareaStyle = await terminalTextarea.evaluate((element) => {
        const originalStyle = element.style.cssText;
        const bounds = element.parentElement?.getBoundingClientRect();
        element.style.position = "fixed";
        element.style.left = `${(bounds?.left ?? 0) + 8}px`;
        element.style.top = `${(bounds?.top ?? 0) + 8}px`;
        element.style.width = "8px";
        element.style.height = "8px";
        element.style.clipPath = "none";
        element.style.pointerEvents = "auto";
        element.style.zIndex = "2147483647";
        return originalStyle;
      });
      await waitForRendererCommit(terminalTextarea);
      const terminalTextareaBounds = await terminalTextarea.boundingBox();
      assert.ok(
        terminalTextareaBounds && terminalTextareaBounds.width > 0 && terminalTextareaBounds.height > 0,
        "the Ghostty textarea must have nonzero native input bounds",
      );
      await sendNativeContextMenu(electronApplication, page, {
        x: terminalTextareaBounds.x + terminalTextareaBounds.width / 2,
        y: terminalTextareaBounds.y + terminalTextareaBounds.height / 2,
      });
      await page.waitForFunction(() => Array.isArray(
        (globalThis as unknown as { __terminalContextMenuKinds?: unknown })
          .__terminalContextMenuKinds,
      ));
      assert.deepEqual(
        await page.evaluate(() => (
          globalThis as unknown as { __terminalContextMenuKinds?: readonly string[] }
        ).__terminalContextMenuKinds),
        ["inspect"],
        "the main process must mint only Inspect after the renderer policy marker is removed",
      );
      await contextMenu.waitFor();
      const inspectTerminalTextarea = contextMenu.getByRole(
        "menuitem",
        { name: "Inspect Element", exact: true },
      );
      await inspectTerminalTextarea.waitFor();
      assert.equal(
        await inspectTerminalTextarea.count(),
        1,
        "the textarea-targeted terminal context menu must retain Inspect Element",
      );
      for (const label of ["Undo", "Redo", "Cut", "Copy", "Paste", "Delete", "Select All"]) {
        assert.equal(
          await contextMenu.getByRole("menuitem", { name: label, exact: true }).count(),
          0,
          `the textarea-targeted terminal context menu must not expose ${label}`,
        );
      }
      await page.keyboard.press("Escape");
      await contextMenu.waitFor({ state: "hidden" });
      await terminalTextarea.evaluate((element, originalStyle) => {
        element.style.cssText = originalStyle;
      }, originalTerminalTextareaStyle);
      assert.equal(
        await readClipboardText(electronApplication) === terminalClipboardText,
        true,
        "opening and dismissing the terminal context menu must not change the clipboard",
      );
      assert.equal(
        fakeMethodCount(await readFakeState(electronApplication), "shell.write"),
        shellWritesBeforeContextMenu,
        "opening and dismissing the terminal context menu must not write to the PTY",
      );
    } finally {
      await page.evaluate(() => {
        const testWindow = globalThis as unknown as {
          __disposeTerminalContextMenuProbe?: () => void;
          __terminalContextMenuKinds?: readonly string[];
        };
        testWindow.__disposeTerminalContextMenuProbe?.();
        delete testWindow.__disposeTerminalContextMenuProbe;
        delete testWindow.__terminalContextMenuKinds;
      });
      await terminal.evaluate((host) => {
        host.setAttribute("data-application-context-menu-policy", "inspect-only");
      });
      await electronApplication.evaluate(
        ({ clipboard }, text) => clipboard.writeText(text),
        terminalClipboardText,
      );
    }
    await waitForNonZeroTerminalMetric(page, "Bytes in");

    const mountedManagedShells = page.locator("#session-shells-heading");
    const mountedTerminalSurface = page.locator('[aria-label="Interactive shell for m1-session"]');
    const attachedInventoryBeforeTabSwitch = await invokeSliver(page, "listSessionShells", {});
    assert.equal(
      attachedInventoryBeforeTabSwitch.ok,
      true,
      attachedInventoryBeforeTabSwitch.error ?? "managed-shell inventory failed before the tab switch",
    );
    const [attachedResourceBeforeTabSwitch] = attachedInventoryBeforeTabSwitch.value?.resources ?? [];
    assert.ok(attachedResourceBeforeTabSwitch, "the attached managed shell must exist before switching tabs");
    assert.equal(attachedResourceBeforeTabSwitch.state, "attached");

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    assert.equal(
      await mountedManagedShells.count(),
      1,
      "the managed-shell panel must remain mounted while another workspace tab is active",
    );
    assert.equal(
      await mountedManagedShells.isHidden(),
      true,
      "Managed Shells must not be visible outside the Shell tab",
    );
    assert.equal(
      await mountedTerminalSurface.count(),
      1,
      "the terminal surface must remain mounted so its scrollback survives tab changes",
    );
    assert.equal(
      await mountedTerminalSurface.isHidden(),
      true,
      "the preserved terminal surface must be hidden outside the Shell tab",
    );
    const attachedInventoryAfterTabSwitch = await invokeSliver(page, "listSessionShells", {});
    assert.equal(
      attachedInventoryAfterTabSwitch.ok,
      true,
      attachedInventoryAfterTabSwitch.error ?? "managed-shell inventory failed while the Shell tab was hidden",
    );
    assert.equal(attachedInventoryAfterTabSwitch.value?.resources.length, 1);
    assert.equal(
      attachedInventoryAfterTabSwitch.value?.resources[0]?.resourceId,
      attachedResourceBeforeTabSwitch.resourceId,
      "switching tabs must preserve the exact managed-shell resource",
    );
    assert.equal(attachedInventoryAfterTabSwitch.value?.resources[0]?.state, "attached");

    await page.getByRole("tab", { name: "Shell", exact: true }).click();
    await mountedManagedShells.waitFor({ state: "visible" });
    await mountedTerminalSurface.waitFor({ state: "visible" });

    const initialWhoamiCommands = fakeMethodCount(await readFakeState(electronApplication), "shell.command.whoami");
    try {
      await terminal.pressSequentially("whoami");
      await terminal.press("Enter", { timeout: 2_000 });
    } catch (error) {
      const calls = (await readFakeState(electronApplication)).methods.slice(-20).join(", ");
      throw new Error(`Ghostty input surface disappeared; recent fake calls: ${calls}`, { cause: error });
    }
    await waitForFakeMethodCount(electronApplication, "shell.command.whoami", initialWhoamiCommands + 1);

    const initialHostileCommands = fakeMethodCount(
      await readFakeState(electronApplication),
      "shell.command.hostile-output",
    );
    await terminal.pressSequentially("m3-hostile-output");
    await terminal.press("Enter");
    await waitForFakeMethodCount(
      electronApplication,
      "shell.command.hostile-output",
      initialHostileCommands + 1,
    );
    await waitForNonZeroTerminalMetric(page, "Bytes out");

    const m3Screenshot = await page.screenshot({
      animations: "disabled",
      path: join(artifactDirectory, "m3-session-terminal.png"),
    });
    for (const forbidden of [
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      TARGET_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
      "MACHINE_CLIPBOARD_PROBE",
      "HOSTILE_DOWNLOAD_PROBE",
    ]) {
      assert.equal(m3Screenshot.includes(Buffer.from(forbidden)), false, `M3 screenshot bytes exposed ${forbidden}`);
    }
    assert.deepEqual(await readM3HostEffects(page), emptyM3HostEffects());
    assert.deepEqual(externalNetworkRequests, [], "terminal output must not initiate an external network request");

    await page.getByRole("button", { name: "Detach", exact: true }).click();
    await page.getByText("Shell is not attached", { exact: true }).waitFor();
    assert.equal(await terminal.count(), 0, "detaching must dispose the terminal surface and its payload-bearing state");

    const detachedInventory = await invokeSliver(page, "listSessionShells", {});
    assert.equal(detachedInventory.ok, true, detachedInventory.error ?? "managed-shell inventory failed");
    assert.equal(detachedInventory.value?.resources.length, 1);
    const [detachedResource] = detachedInventory.value?.resources ?? [];
    assert.ok(detachedResource, "the detached managed shell must remain in the exact source-window inventory");
    const shellStartsBeforeSelection = fakeMethodCount(
      await readFakeState(electronApplication),
      "startShellSession",
    );
    await page
      .getByRole("complementary", { name: "Managed shell inventory", exact: true })
      .getByText("Shell 1", { exact: true })
      .click();
    await page.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).waitFor();
    await page.getByText("Attached", { exact: true }).waitFor();
    assert.equal(
      fakeMethodCount(await readFakeState(electronApplication), "startShellSession"),
      shellStartsBeforeSelection,
      "selecting a detached shell must attach the exact resource without starting another remote shell",
    );
    assert.equal(
      await page.getByRole("button", { name: "Attach", exact: true }).count(),
      0,
      "shell selection replaces the former select-then-Attach interaction",
    );
    const initialPwdCommands = fakeMethodCount(await readFakeState(electronApplication), "shell.command.pwd");
    const reattachedTerminal = page.getByRole("textbox", {
      name: "Interactive shell for m1-session",
      exact: true,
    });
    await reattachedTerminal.pressSequentially("pwd");
    await reattachedTerminal.press("Enter");
    await waitForFakeMethodCount(electronApplication, "shell.command.pwd", initialPwdCommands + 1);

    await verifyInteractionWindowPopout(
      electronApplication,
      page,
      "session",
      "m1-session",
      artifactDirectory,
    );

    await verifyM3ManagedShellPopout(
      electronApplication,
      page,
      detachedResource.resourceId,
      externalNetworkRequests,
    );

    const initialShellCloses = fakeMethodCount(await readFakeState(electronApplication), "shell.close");
    await page
      .getByRole("toolbar", { name: "Terminal actions", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    const closeReview = page.getByRole("alertdialog", { name: "Close this managed shell?", exact: true });
    await closeReview.waitFor();
    const closeReviewText = await closeReview.innerText();
    assert.match(closeReviewText, /closes the local managed stream/i);
    assert.match(closeReviewText, /bounded best-effort exit and logout requests/i);
    assert.match(closeReviewText, /does not confirm remote process termination/i);
    await closeReview.getByRole("button", { name: "Close shell", exact: true }).click();
    await waitForFakeMethodCount(electronApplication, "shell.close", initialShellCloses + 1);
    await page.getByText("No managed shells", { exact: true }).waitFor();
    await page.getByText("No shell selected", { exact: true }).waitFor();
    assert.deepEqual(await readM3HostEffects(page), emptyM3HostEffects());
    assert.deepEqual(externalNetworkRequests, [], "the M3 journey must remain network inert");
    assert.equal(
      (await readFakeState(electronApplication)).dialogCalls,
      1,
      "terminal output and shell lifecycle actions must not invoke a native dialog",
    );
  } finally {
    page.off("request", observeRequest);
  }
}

async function verifyM3ManagedShellPopout(
  electronApplication: ElectronApplication,
  sourcePage: Page,
  resourceId: string,
  externalNetworkRequests: string[],
): Promise<void> {
  const sourceInventory = await invokeSliver(sourcePage, "listSessionShells", {});
  assert.equal(sourceInventory.ok, true, sourceInventory.error ?? "source managed-shell inventory failed");
  assert.deepEqual(sourceInventory.value?.resources.map((resource) => resource.resourceId), [resourceId]);

  const initialWindowCount = electronApplication.windows().length;
  const initialShellStarts = fakeMethodCount(await readFakeState(electronApplication), "startShellSession");
  const popoutPageErrors: string[] = [];
  const observeWindow = (candidate: Page): void => {
    candidate.on("pageerror", (error) => popoutPageErrors.push(error.message));
    candidate.on("request", (request) => {
      if (/^https?:/iu.test(request.url())) externalNetworkRequests.push(request.url());
    });
  };
  electronApplication.on("window", observeWindow);

  let popout: Page | undefined;
  try {
    await sourcePage.getByRole("button", { name: "Pop out managed shells", exact: true }).click();
    popout = await waitForManagedShellWindow(electronApplication, initialWindowCount, sourcePage);
    await popout.locator('[data-presentation="dedicated"]').waitFor();
    await popout.getByRole("heading", { name: "Managed Shells", exact: true }).waitFor();
    assert.equal(
      await popout.locator('[aria-label="Operational navigation"]').count(),
      0,
      "the dedicated managed-shell window must not render the full application sidebar",
    );
    assert.equal(
      await popout.getByRole("button", { name: "New window options", exact: true }).count(),
      0,
      "the dedicated managed-shell window must not render generic application chrome",
    );
    assert.equal(
      await popout.getByRole("button", { name: "Pop out managed shells", exact: true }).count(),
      0,
      "a managed-shell popout must not recursively expose another popout action",
    );

    const popoutUrl = popout.url();
    const parsedPopoutUrl = new URL(popoutUrl);
    assert.equal(parsedPopoutUrl.searchParams.get("surface"), "managed-shells");
    const decodedPopoutUrl = decodeURIComponent(popoutUrl);
    const targetFingerprint = (await rendererSnapshot(sourcePage)).targetContext.activeTarget?.fingerprint;
    for (const forbidden of [
      resourceId,
      "m1_session",
      targetFingerprint,
      PRIVATE_KEY_SECRET,
      TOKEN_SECRET,
      EVENT_SECRET,
      TARGET_SECRET,
      TASK_SECRET,
      M2_ENV_SECRET,
      M2_FILE_CONTENT,
      M2_EDITED_CONTENT,
      M2_SEARCH_PATTERN,
    ]) {
      if (forbidden) assert.ok(!decodedPopoutUrl.includes(forbidden), `managed-shell URL exposed ${forbidden}`);
    }
    assert.doesNotMatch(
      decodedPopoutUrl,
      /(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?:$|[^A-Za-z0-9_-])/u,
      "managed-shell URL must not contain an opaque resource or attachment capability",
    );
    assert.equal(await popout.evaluate(() => (
      globalThis as unknown as { opener?: unknown }
    ).opener === null), true);

    const popoutPreferences = await electronApplication.evaluate(({ BrowserWindow }, expectedUrl) => {
      const managedShellWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === expectedUrl,
      );
      if (!managedShellWindow) throw new Error("Expected a dedicated managed-shell BrowserWindow");
      const preferences = (managedShellWindow.webContents as unknown as {
        getLastWebPreferences(): Record<string, unknown>;
      }).getLastWebPreferences();
      return {
        contextIsolation: preferences["contextIsolation"],
        nodeIntegration: preferences["nodeIntegration"],
        nodeIntegrationInWorker: preferences["nodeIntegrationInWorker"] ?? false,
        nodeIntegrationInSubFrames: preferences["nodeIntegrationInSubFrames"],
        sandbox: preferences["sandbox"],
        webSecurity: preferences["webSecurity"],
        webviewTag: preferences["webviewTag"],
      };
    }, popoutUrl);
    assert.deepEqual(popoutPreferences, {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });

    const popoutTerminal = popout.getByRole("textbox", {
      name: "Interactive shell for m1-session",
      exact: true,
    });
    await popoutTerminal.waitFor();
    await popout.getByText("Attached", { exact: true }).first().waitFor();
    assert.equal(
      fakeMethodCount(await readFakeState(electronApplication), "startShellSession"),
      initialShellStarts,
      "popping out must move and reattach the exact shell rather than starting a new remote process",
    );

    const destinationInventory = await invokeSliver(popout, "listSessionShells", {});
    assert.equal(
      destinationInventory.ok,
      true,
      destinationInventory.error ?? "destination managed-shell inventory failed",
    );
    assert.deepEqual(destinationInventory.value?.resources.map((resource) => resource.resourceId), [resourceId]);
    const emptiedSourceInventory = await invokeSliver(sourcePage, "listSessionShells", {});
    assert.equal(emptiedSourceInventory.ok, true, emptiedSourceInventory.error ?? "source inventory failed");
    assert.deepEqual(emptiedSourceInventory.value?.resources, []);
    assert.equal(
      await sourcePage.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true }).count(),
      0,
      "the source terminal surface must be disposed after ownership moves to the dedicated window",
    );

    const rejectedSourceAction = await invokeSliver(sourcePage, "actOnSessionShell", {
      resourceId,
      action: "close",
    });
    assert.equal(rejectedSourceAction.ok, false, "the old source renderer must not act on the transferred shell");
    assert.match(rejectedSourceAction.error ?? "", /unavailable|window|renderer|resource/iu);

    await installM3HostEffectGuards(popout);
    const pwdCommands = fakeMethodCount(await readFakeState(electronApplication), "shell.command.pwd");
    await popoutTerminal.pressSequentially("pwd");
    await popoutTerminal.press("Enter");
    await waitForFakeMethodCount(electronApplication, "shell.command.pwd", pwdCommands + 1);
    const hostileCommands = fakeMethodCount(
      await readFakeState(electronApplication),
      "shell.command.hostile-output",
    );
    await popoutTerminal.pressSequentially("m3-hostile-output");
    await popoutTerminal.press("Enter");
    await waitForFakeMethodCount(
      electronApplication,
      "shell.command.hostile-output",
      hostileCommands + 1,
    );
    assert.deepEqual(await readM3HostEffects(popout), emptyM3HostEffects());
    assert.deepEqual(externalNetworkRequests, [], "the dedicated terminal window must remain network inert");

    await sourcePage.getByRole("button", { name: "Pop out managed shells", exact: true }).click();
    await waitForWindowCount(electronApplication, initialWindowCount + 1);
    assert.equal(
      electronApplication.windows().filter((candidate) => candidate !== sourcePage && !candidate.isClosed()).length,
      1,
      "opening the same managed-shell popout twice must focus the existing dedicated window",
    );
    assert.deepEqual(await readM3HostEffects(sourcePage), emptyM3HostEffects());

    const shellClosesBeforeRedock = fakeMethodCount(await readFakeState(electronApplication), "shell.close");
    const popoutClosed = popout.waitForEvent("close");
    await electronApplication.evaluate(({ BrowserWindow }, expectedUrl) => {
      const managedShellWindow = BrowserWindow.getAllWindows().find(
        (candidate) => candidate.webContents.getURL() === expectedUrl,
      );
      if (!managedShellWindow) throw new Error("Expected a dedicated managed-shell BrowserWindow to close");
      managedShellWindow.close();
    }, popoutUrl);
    await popoutClosed;
    popout = undefined;
    // BrowserWindow.close() does not synchronously guarantee which surviving
    // Electron window receives the next native pointer sequence. Re-activate
    // the source before exercising the re-docked shell so React Aria does not
    // discard the first press as background-window activation.
    await sourcePage.bringToFront();
    const redockedInventory = await waitForSessionShellInventory(sourcePage, 1);
    assert.deepEqual(redockedInventory.resources.map((resource) => resource.resourceId), [resourceId]);
    assert.equal(
      fakeMethodCount(await readFakeState(electronApplication), "shell.close"),
      shellClosesBeforeRedock,
      "closing a dedicated window must re-dock its shell without closing the remote process",
    );
    assert.equal(
      fakeMethodCount(await readFakeState(electronApplication), "startShellSession"),
      initialShellStarts,
      "re-docking must not recreate the remote shell",
    );

    const sourceInventoryPanel = sourcePage.getByRole("complementary", {
      name: "Managed shell inventory",
      exact: true,
    });
    await sourceInventoryPanel.getByText("Shell 1", { exact: true }).waitFor();
    await sourceInventoryPanel.getByText("Shell 1", { exact: true }).click();
    await sourcePage.getByRole("textbox", {
      name: "Interactive shell for m1-session",
      exact: true,
    }).waitFor();
    await sourcePage
      .locator('[data-shell-terminal-resource-id]:not([inert]) [data-terminal-state="ready"]')
      .waitFor();
    await sourcePage.getByText("Attached", { exact: true }).first().waitFor();
  } finally {
    electronApplication.off("window", observeWindow);
    await popout?.close().catch(() => undefined);
  }
  assert.deepEqual(popoutPageErrors, []);
}

interface M3HostEffects {
  clipboardWrites: number;
  dialogs: number;
  downloads: number;
  fetches: number;
  notifications: number;
  windowOpens: number;
}

function emptyM3HostEffects(): M3HostEffects {
  return {
    clipboardWrites: 0,
    dialogs: 0,
    downloads: 0,
    fetches: 0,
    notifications: 0,
    windowOpens: 0,
  };
}

async function installM3HostEffectGuards(page: Page): Promise<void> {
  await page.evaluate(() => {
    const effects = {
      clipboardWrites: 0,
      dialogs: 0,
      downloads: 0,
      fetches: 0,
      notifications: 0,
      windowOpens: 0,
    };
    const browserGlobal = globalThis as unknown as {
      __SLIVER_GUI_M3_HOST_EFFECTS__: typeof effects;
      alert: (message?: unknown) => void;
      confirm: (message?: unknown) => boolean;
      document: { createElement(name: string): object };
      fetch: typeof fetch;
      open: (...args: unknown[]) => unknown;
      prompt: (message?: unknown, defaultValue?: string) => string | null;
    };
    browserGlobal.__SLIVER_GUI_M3_HOST_EFFECTS__ = effects;

    const originalFetch = globalThis.fetch.bind(globalThis);
    browserGlobal.fetch = ((...args: Parameters<typeof fetch>) => {
      effects.fetches += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    browserGlobal.open = (() => {
      effects.windowOpens += 1;
      return null;
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        readText: async () => "",
        writeText: async () => {
          effects.clipboardWrites += 1;
        },
      },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: function NotificationProbe() {
        effects.notifications += 1;
      },
    });
    browserGlobal.alert = () => {
      effects.dialogs += 1;
    };
    browserGlobal.confirm = () => {
      effects.dialogs += 1;
      return false;
    };
    browserGlobal.prompt = () => {
      effects.dialogs += 1;
      return null;
    };
    const anchorPrototype = Object.getPrototypeOf(browserGlobal.document.createElement("a")) as { click(): void };
    anchorPrototype.click = function blockedM3Download() {
      effects.downloads += 1;
    };
  });
}

async function readM3HostEffects(page: Page): Promise<M3HostEffects> {
  return page.evaluate(() => structuredClone(
    (globalThis as unknown as { __SLIVER_GUI_M3_HOST_EFFECTS__: M3HostEffects })
      .__SLIVER_GUI_M3_HOST_EFFECTS__,
  ));
}

async function waitForNonZeroTerminalMetric(
  page: Page,
  label: "Bytes in" | "Bytes out",
  timeoutMs = 10_000,
): Promise<void> {
  await page.getByRole("button", { name: "Stats", exact: true }).click();
  const statistics = page.getByRole("dialog", { name: "Shell statistics", exact: true });
  await statistics.waitFor();
  const metric = statistics.getByText(label, { exact: true }).locator("..").locator("dd");
  const deadline = Date.now() + timeoutMs;
  let latest = "missing";
  try {
    while (Date.now() < deadline) {
      latest = (await metric.textContent().catch(() => null))?.trim() ?? "missing";
      if (latest !== "missing" && latest !== "0") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${label} did not become non-zero; latest value was ${latest}`);
  } finally {
    await statistics.getByRole("button", { name: "Close", exact: true }).last().click();
    await statistics.waitFor({ state: "detached" });
  }
}

async function verifyM2SessionActivityAndBack(page: Page): Promise<void> {
  await page.getByRole("tab", { name: "Activity", exact: true }).click();
  const activityGrid = page.getByRole("grid", { name: "Session activity" });
  await activityGrid.waitFor();
  await activityGrid.getByText("Ping", { exact: true }).waitFor();
  await activityGrid.getByText("Set environment variable", { exact: true }).waitFor();
  await activityGrid.getByText("Stage text changes", { exact: true }).waitFor();
  const savedFileActivity = activityGrid.getByRole("row").filter({ hasText: "Save text file" });
  await savedFileActivity.waitFor();
  await savedFileActivity.getByText("Completed", { exact: true }).waitFor();
  const activityText = await activityGrid.innerText();
  for (const forbidden of [
    M2_ENV_SECRET,
    M2_FILE_CONTENT,
    M2_EDITED_CONTENT,
    M2_SEARCH_PATTERN,
    "/Users/e2e/workspace/notes.txt",
  ]) {
    assert.ok(!activityText.includes(forbidden), `Activity exposed sensitive operation input ${forbidden}`);
  }
  assert.doesNotMatch(activityText, /\/(?:Users|private|tmp|var)\//u, "Activity must not expose local or remote paths");

  await page.getByRole("button", { name: "Back to live sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  const sessionsGrid = page.locator('[aria-label="Sliver sessions"]');
  await sessionsGrid.getByText("m1-session", { exact: true }).waitFor();
  assert.equal(await page.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);
  assert.equal(await page.getByText("Selected session", { exact: true }).count(), 0);

  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  const beaconRef = requireTargetRef(await rendererSnapshot(page), "beacon");
  const switchResult = await invokeSliver(page, "selectTarget", beaconRef);
  assert.equal(switchResult.ok, true);
  await page.getByRole("heading", { name: "Session workspace unavailable", exact: true }).waitFor();
  const quarantinedText = await page.locator("body").innerText();
  assert.ok(!quarantinedText.includes(M2_FILE_CONTENT));
  assert.ok(!quarantinedText.includes(M2_EDITED_CONTENT));
  assert.equal(await page.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);

  await page.getByRole("button", { name: "Back to sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
  await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
  assert.equal((await rendererSnapshot(page)).targetContext.activeTarget?.id, "m1_session");
  await page.getByRole("button", { name: "Back to live sessions", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
}

async function rendererSnapshot(page: Page): Promise<SliverSnapshot> {
  return invokeSliver(page, "getSnapshot");
}

type SliverMethod = keyof SliverDesktopAPI;
type SliverMethodArgs<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: infer Args) => unknown ? Args : never;
type SliverMethodResult<Method extends SliverMethod> =
  SliverDesktopAPI[Method] extends (...args: never[]) => infer Result ? Awaited<Result> : never;

async function invokeSliver<Method extends SliverMethod>(
  page: Page,
  method: Method,
  ...args: SliverMethodArgs<Method>
): Promise<SliverMethodResult<Method>> {
  return page.evaluate(async ({ method: rendererMethod, args: rendererArgs }) => {
    const api = (globalThis as unknown as { sliver: Record<string, (...values: unknown[]) => Promise<unknown>> }).sliver;
    return api[rendererMethod]!(...rendererArgs);
  }, { method, args }) as Promise<SliverMethodResult<Method>>;
}

function requireTargetRef(snapshot: SliverSnapshot, mode: "session" | "beacon"): TargetRef {
  const target = snapshot.targetContext.selectableTargets.find((candidate) => candidate.mode === mode);
  assert.ok(target, `expected a selectable ${mode}`);
  return target;
}

function stableTargetIdentity(target: TargetRef | null | undefined): Pick<
  TargetRef,
  "mode" | "id" | "backendEpoch" | "fingerprint"
> | undefined {
  if (!target) return undefined;
  return {
    mode: target.mode,
    id: target.id,
    backendEpoch: target.backendEpoch,
    fingerprint: target.fingerprint,
  };
}

function targetsHaveSameStableIdentity(
  left: TargetRef | null | undefined,
  right: TargetRef | null | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode &&
    left.id === right.id &&
    left.backendEpoch === right.backendEpoch &&
    left.fingerprint === right.fingerprint;
}

function requireOperation(result: Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>>): TargetOperationRecord;
function requireOperation(result: Awaited<ReturnType<SliverDesktopAPI["cancelTargetOperation"]>>): TargetOperationRecord;
function requireOperation(
  result: Awaited<ReturnType<SliverDesktopAPI["submitTargetOperation"]>> |
    Awaited<ReturnType<SliverDesktopAPI["cancelTargetOperation"]>>,
): TargetOperationRecord {
  assert.equal(result.ok, true, result.error ?? "operation request failed");
  assert.ok(result.value, "operation result must include a record");
  return result.value;
}

async function waitForOperation(
  page: Page,
  requestId: string,
  state: TargetOperationRecord["state"],
  timeoutMs = 15_000,
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  let latest: TargetOperationRecord | undefined;
  while (Date.now() < deadline) {
    const result = await invokeSliver(page, "getTargetOperation", { requestId });
    if (result.ok && result.value) {
      latest = result.value;
      if (latest.state === state) return latest;
      if (["failed", "canceled", "partial", "outcome-unknown", "target-disappeared"].includes(latest.state)) {
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Operation ${requestId} did not reach ${state}; latest state was ${latest?.state ?? "missing"}`);
}

async function waitForNewTargetOperation(
  page: Page,
  existingRequestIds: ReadonlySet<string>,
  operationId: TargetOperationRecord["operationId"],
  timeoutMs = 15_000,
): Promise<TargetOperationRecord> {
  const deadline = Date.now() + timeoutMs;
  let latestError = "missing";
  while (Date.now() < deadline) {
    const result = await invokeSliver(page, "listTargetOperations", { limit: 100 });
    if (result.ok && result.value) {
      const operation = result.value.items.find((candidate) => (
        candidate.operationId === operationId && !existingRequestIds.has(candidate.requestId)
      ));
      if (operation) return operation;
      latestError = "no new matching operation";
    } else {
      latestError = result.error ?? "unknown operation-history error";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No new ${operationId} operation appeared; latest result was ${latestError}`);
}

async function waitForSnapshot(
  page: Page,
  predicate: (snapshot: SliverSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<SliverSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await rendererSnapshot(page);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for renderer snapshot state");
}

async function waitForAdditionalWindow(
  electronApplication: ElectronApplication,
  previousCount: number,
  firstPage: Page,
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = electronApplication.windows();
    const additional = pages.find((candidate) => candidate !== firstPage);
    if (pages.length > previousCount && additional) return additional;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for inherited application window");
}

async function waitForInteractionWindow(
  electronApplication: ElectronApplication,
  existingWindows: ReadonlySet<Page>,
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const interaction = electronApplication.windows().find((candidate) => {
      if (existingWindows.has(candidate) || candidate.isClosed()) return false;
      try {
        return new URL(candidate.url()).search === "?surface=interaction";
      } catch {
        return false;
      }
    });
    if (interaction) return interaction;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for a dedicated interaction window");
}

async function waitForConsoleWindow(
  electronApplication: ElectronApplication,
  existingWindows: ReadonlySet<Page>,
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const consolePage = electronApplication.windows().find((candidate) => {
      if (existingWindows.has(candidate) || candidate.isClosed()) return false;
      try {
        return new URL(candidate.url()).search === "?surface=console";
      } catch {
        return false;
      }
    });
    if (consolePage) return consolePage;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the dedicated Sliver console window");
}

async function verifyConsoleWindowResume(
  application: ElectronApplication,
  sourcePage: Page,
  consolePage: Page,
): Promise<void> {
  const stateBefore = await readFakeState(application);
  const windowsBefore = application.windows();
  const titleBefore = await consolePage.title();
  const readTabs = (): Promise<unknown> => consolePage.getByRole("tab").evaluateAll((tabs) =>
    tabs.map((tab) => ({
      id: tab.getAttribute("id"),
      label: tab.getAttribute("aria-label"),
      selected: tab.getAttribute("aria-selected"),
      text: tab.textContent,
    })));
  const tabsBefore = await readTabs();
  const terminalsBefore = await consolePage.locator("[data-console-terminal-tab-id]").elementHandles();
  const nativeWindow = await application.browserWindow(consolePage);
  try {
    const hiddenWindow = await nativeWindow.evaluate((window) => {
      const id = window.id;
      window.close();
      const destroyed = window.isDestroyed();
      return { id, destroyed, visible: !destroyed && window.isVisible() };
    });
    assert.equal(hiddenWindow.destroyed, false, "native window close must retain the console BrowserWindow");
    assert.equal(hiddenWindow.visible, false, "native window close must hide the console BrowserWindow");
    assert.equal(consolePage.isClosed(), false, "native window close must keep the console renderer alive");
    const hiddenState = await readFakeState(application);
    assert.equal(hiddenState.console.kills, stateBefore.console.kills, "hiding the console must not kill a PTY");
    assert.equal(hiddenState.console.spawns.length, stateBefore.console.spawns.length);
    for (const spawn of stateBefore.console.spawns.filter(({ kills }) => kills === 0)) {
      assert.equal(await pathExists(spawn.rootDirectory), true, "a hidden console tab must retain its private root");
    }

    await sourcePage.bringToFront();
    await sourcePage.locator('button[aria-label="Open Sliver console"]').click();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !await nativeWindow.evaluate((window) => window.isVisible())) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.deepEqual(
      await nativeWindow.evaluate((window) => ({ id: window.id, visible: window.isVisible() })),
      { id: hiddenWindow.id, visible: true },
      "opening Console Client again must show the existing native window",
    );
    assert.deepEqual(application.windows(), windowsBefore, "reopening Console Client must reuse the same Page");
    assert.equal(await consolePage.title(), titleBefore);
    assert.deepEqual(await readTabs(), tabsBefore, "reopening must preserve tab names, ordering, and active selection");
    for (const terminal of terminalsBefore) {
      assert.equal(
        await terminal.evaluate((element) => element.isConnected),
        true,
        "reopening must preserve each existing Ghostty terminal element",
      );
    }
    const reopenedState = await readFakeState(application);
    assert.equal(reopenedState.console.spawns.length, stateBefore.console.spawns.length, "reopening must not spawn another PTY");
    assert.equal(reopenedState.console.kills, stateBefore.console.kills, "reopening must not clean up retained tabs");
    assert.deepEqual(
      reopenedState.console.spawns.map(({ writes }) => writes),
      stateBefore.console.spawns.map(({ writes }) => writes),
      "closing and reopening the window must not write to any console PTY",
    );
  } finally {
    await nativeWindow.dispose();
    await Promise.all(terminalsBefore.map((terminal) => terminal.dispose()));
  }
}

async function waitForManagedShellWindow(
  electronApplication: ElectronApplication,
  previousCount: number,
  sourcePage: Page,
): Promise<Page> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const pages = electronApplication.windows();
    for (const candidate of pages) {
      if (candidate === sourcePage || candidate.isClosed()) continue;
      const isDedicated = await candidate.locator('[data-presentation="dedicated"]').count().catch(() => 0);
      if (pages.length > previousCount && isDedicated === 1) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the dedicated managed-shell window");
}

async function waitForWindowCount(
  electronApplication: ElectronApplication,
  expectedCount: number,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  while (Date.now() < deadline) {
    latest = electronApplication.windows().filter((candidate) => !candidate.isClosed()).length;
    if (latest === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Application window count did not settle at ${expectedCount}; latest count was ${latest}`);
}

async function invokeConsoleMenuItem(
  electronApplication: ElectronApplication,
  itemId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const invoked = await electronApplication.evaluate(({ app, BrowserWindow, Menu }, id) => {
      const consoleWindow = BrowserWindow.getAllWindows().find((window) => {
        try {
          return new URL(window.webContents.getURL()).search === "?surface=console";
        } catch {
          return false;
        }
      });
      if (!consoleWindow) return false;
      app.focus({ steal: true });
      consoleWindow.show();
      consoleWindow.focus();
      consoleWindow.webContents.focus();
      const invokeFocusedMenuItem = (): boolean => {
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const item = Menu.getApplicationMenu()?.getMenuItemById(id);
        if (focusedWindow !== consoleWindow || !item || typeof item.click !== "function") return false;
        Reflect.apply(item.click, item, [item, focusedWindow, {}]);
        return true;
      };
      if (invokeFocusedMenuItem()) return true;

      // macOS automation can leave Electron visible but inactive even after
      // app.focus({ steal: true }). Emit the same BrowserWindow focus event
      // under a narrowly scoped getFocusedWindow shim so production rebuilds
      // and invokes its exact native Terminal menu deterministically.
      const descriptor = Object.getOwnPropertyDescriptor(BrowserWindow, "getFocusedWindow");
      if (!descriptor?.configurable) return false;
      try {
        Object.defineProperty(BrowserWindow, "getFocusedWindow", {
          configurable: true,
          value: () => consoleWindow,
        });
        consoleWindow.emit("focus");
        return invokeFocusedMenuItem();
      } finally {
        Object.defineProperty(BrowserWindow, "getFocusedWindow", descriptor);
      }
    }, itemId);
    if (invoked) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const diagnostic = await electronApplication.evaluate(({ app, BrowserWindow, Menu }) => ({
    active: app.isActive(),
    focusedUrl: BrowserWindow.getFocusedWindow()?.webContents.getURL(),
    menuIds: Menu.getApplicationMenu()?.items.flatMap((item) => [
      item.id,
      ...(item.submenu?.items.map((child) => child.id) ?? []),
    ]),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      focused: window.isFocused(),
      visible: window.isVisible(),
      url: window.webContents.getURL(),
    })),
  }));
  throw new Error(`Timed out waiting for native console menu item ${itemId}: ${JSON.stringify(diagnostic)}`);
}

async function waitForSelectedConsoleTab(
  page: Page,
  name: RegExp,
  timeoutMs = 10_000,
): Promise<void> {
  const tab = page.getByRole("tab", { name });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await tab.getAttribute("aria-selected") === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for selected console tab ${String(name)}`);
}

async function selectRadioOption(option: Locator, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await option.getAttribute("aria-checked") === "true") return;
    await option.click();
    if (await option.getAttribute("aria-checked") === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out selecting radio option ${await option.textContent() ?? "unknown"}`);
}

async function waitForRendererCommit(locator: Locator): Promise<void> {
  await locator.evaluate(() => new Promise<void>((resolveCommit) => {
    const browserGlobal = globalThis as unknown as {
      requestAnimationFrame(callback: () => void): number;
    };
    browserGlobal.requestAnimationFrame(() => {
      browserGlobal.requestAnimationFrame(() => resolveCommit());
    });
  }));
}

async function waitForApplicationSettings(
  page: Page,
  predicate: (settings: ApplicationSettingsState) => boolean,
  timeoutMs = 10_000,
): Promise<ApplicationSettingsState> {
  const deadline = Date.now() + timeoutMs;
  let latest = await page.evaluate(async () => {
    const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
    return api.getApplicationSettings();
  }) as ApplicationSettingsState;
  while (Date.now() < deadline) {
    latest = await page.evaluate(async () => {
      const api = (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver;
      return api.getApplicationSettings();
    }) as ApplicationSettingsState;
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for application settings revision after ${latest.revision}`);
}

async function waitForConsoleState(
  electronApplication: ElectronApplication,
  predicate: (state: FakeStateSnapshot) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<FakeStateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readFakeState(electronApplication);
  while (Date.now() < deadline) {
    latest = await readFakeState(electronApplication);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${description}; observed ${latest.console.spawns.length} spawn(s), ` +
      `${latest.console.writes.length} write(s), ${latest.console.kills} kill(s)`,
  );
}

async function waitForPathRemoval(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await pathExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Private console root was not removed: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function waitForSessionShellInventory(
  page: Page,
  expectedCount: number,
  timeoutMs = 10_000,
): Promise<SessionShellResourceList> {
  const deadline = Date.now() + timeoutMs;
  let latestError = "missing";
  let latestCount = -1;
  while (Date.now() < deadline) {
    const result = await invokeSliver(page, "listSessionShells", {});
    if (result.ok && result.value) {
      latestCount = result.value.resources.length;
      if (latestCount === expectedCount) return result.value;
      latestError = "none";
    } else {
      latestError = result.error ?? "unknown inventory error";
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Managed-shell inventory did not settle at ${expectedCount}; ` +
      `latest count was ${latestCount}, latest error was ${latestError}`,
  );
}

async function startAndStopMtlsListener(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New listener" }).click();
  const dialog = page.getByRole("dialog", { name: "Start a listener" });
  await dialog.getByRole("textbox", { name: "Bind host" }).fill("127.0.0.1");
  const port = dialog.getByRole("textbox", { name: "Listener port" });
  await port.fill("18888");
  await dialog.getByRole("button", { name: "Start listener" }).click();
  await page.getByText("#42", { exact: true }).waitFor();
  await page.getByText("Playwright-created mTLS listener", { exact: true }).waitFor();

  await page.getByRole("button", { name: "Stop job 42" }).click();
  const confirmation = page.getByRole("alertdialog", { name: /stop this reviewed server job/i });
  await confirmation.waitFor();
  const confirmationText = await confirmation.innerText();
  for (const expected of [
    "127.0.0.1:31337",
    "m0-e2e-operator",
    "chosen-m0-operator.cfg",
    "Shared by 1 application window",
    "Job #42",
    "port 18888",
  ]) {
    assert.ok(confirmationText.includes(expected), `stop confirmation omitted ${expected}`);
  }
  await confirmation.getByRole("button", { name: "Stop job #42" }).click();
  await page.getByText("#42", { exact: true }).waitFor({ state: "detached" });
}

async function assertJobActionColumnSurface(page: Page, jobId: number): Promise<void> {
  const layout = await page.getByRole("button", { name: `Stop job ${jobId}` }).evaluate((button) => {
    type ProbeElement = {
      clientLeft: number;
      clientWidth: number;
      closest(selector: string): ProbeElement | null;
      getAttribute(name: string): string | null;
      getBoundingClientRect(): { bottom: number; height: number; left: number; right: number; top: number; width: number };
      parentElement: ProbeElement | null;
      previousElementSibling: ProbeElement | null;
      querySelector(selector: string): ProbeElement | null;
    };
    const browser = globalThis as unknown as {
      getComputedStyle(element: unknown): { backgroundColor: string };
    };
    const actionCell = (button as unknown as ProbeElement).closest('[role="gridcell"]');
    const row = actionCell?.closest('[role="row"]');
    const gridRoot = actionCell?.closest('[data-slot="data-grid"]');
    const scrollContainer = gridRoot?.querySelector('[data-slot="table-scroll-container"]');
    const card = gridRoot?.parentElement;
    const actionHeader = gridRoot?.querySelector('[role="columnheader"]:last-child');
    const adjacentHeader = actionHeader?.previousElementSibling;
    if (!actionCell || !row || !gridRoot || !scrollContainer || !card || !actionHeader || !adjacentHeader) return null;

    const actionRect = actionCell.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const scrollRect = scrollContainer.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const visibleRightEdge = Math.min(
      rowRect.right,
      scrollRect.left + scrollContainer.clientLeft + scrollContainer.clientWidth,
    );
    return {
      actionBackground: browser.getComputedStyle(actionCell).backgroundColor,
      actionHeaderBackground: browser.getComputedStyle(actionHeader).backgroundColor,
      adjacentHeaderBackground: browser.getComputedStyle(adjacentHeader).backgroundColor,
      cardBackground: browser.getComputedStyle(card).backgroundColor,
      pinned: actionCell.getAttribute("data-pinned"),
      actionWidth: actionRect.width,
      visibleRightEdgeDelta: Math.abs(actionRect.right - visibleRightEdge),
      horizontalCenterDelta: Math.abs(
        (buttonRect.left + buttonRect.width / 2) - (actionRect.left + actionRect.width / 2),
      ),
      verticalCenterDelta: Math.abs(
        (buttonRect.top + buttonRect.height / 2) - (actionRect.top + actionRect.height / 2),
      ),
    };
  });

  assert.ok(layout, "expected an actions cell and adjacent table cells");
  assert.equal(layout.actionBackground, layout.cardBackground);
  assert.equal(layout.actionHeaderBackground, layout.adjacentHeaderBackground);
  assert.equal(layout.pinned, "end");
  assert.ok(layout.actionWidth >= 70 && layout.actionWidth <= 88, `unexpected action width ${layout.actionWidth}`);
  assert.ok(
    layout.visibleRightEdgeDelta <= 8,
    `action column missed visible grid edge by ${layout.visibleRightEdgeDelta}px`,
  );
  assert.ok(layout.horizontalCenterDelta <= 1, `stop action was horizontally off-center by ${layout.horizontalCenterDelta}px`);
  assert.ok(layout.verticalCenterDelta <= 1, `stop action was vertically off-center by ${layout.verticalCenterDelta}px`);
}

async function readFakeState(electronApplication: ElectronApplication): Promise<FakeStateSnapshot> {
  return readElectronSnapshot(() =>
    electronApplication.evaluate(() => structuredClone(globalThis.__SLIVER_GUI_E2E_STATE__))
  );
}

function readClipboardText(electronApplication: ElectronApplication): Promise<string> {
  return readElectronSnapshot(() =>
    electronApplication.evaluate(({ clipboard }) => clipboard.readText())
  );
}

function fakeMethodCount(state: FakeStateSnapshot, method: string): number {
  return state.methods.filter((candidate) => candidate === method).length;
}

async function waitForFakeMethodCount(
  electronApplication: ElectronApplication,
  method: string,
  minimum: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latest = 0;
  let latestMethods: string[] = [];
  while (Date.now() < deadline) {
    const state = await readFakeState(electronApplication);
    latestMethods = state.methods;
    latest = fakeMethodCount(state, method);
    if (latest >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for ${method} call ${minimum}; observed ${latest}; ` +
      `recent fake calls: ${latestMethods.slice(-20).join(", ") || "none"}`,
  );
}

async function waitForNewFakeBeaconTask(
  electronApplication: ElectronApplication,
  existingTaskIds: ReadonlySet<string>,
  description: string,
  timeoutMs = 10_000,
): Promise<FakeStateSnapshot["tasks"][number]> {
  const deadline = Date.now() + timeoutMs;
  let latestTasks: FakeStateSnapshot["tasks"] = [];
  while (Date.now() < deadline) {
    latestTasks = (await readFakeState(electronApplication)).tasks;
    const task = latestTasks.find((candidate) =>
      !existingTaskIds.has(candidate.id) && candidate.description === description
    );
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Timed out waiting for a new ${description} beacon task; ` +
      `observed: ${JSON.stringify(latestTasks)}`,
  );
}

interface FakeStateSnapshot {
  configFactoryCalls: number;
  dialogCalls: number;
  methods: string[];
  disconnects: number;
  ssh: Array<{ writes: string[]; closed: boolean }>;
  holdNextBeaconTask: boolean;
  sessionName: string;
  beaconName: string;
  environment: Record<string, string>;
  openSessionRequests: Array<{ beaconId: string; c2s: string[]; delayNanoseconds: string }>;
  tasks: Array<{ id: string; beaconId: string; state: string; description: string }>;
  m4Audit: {
    callCounts: Record<string, number>;
    artifactInputs: number;
    artifactInputBytes: number;
    credentialInputs: number;
    credentialInputBytes: number;
    zeroizedCopies: number;
    remoteServiceStarts: number;
    remoteServiceRemovals: number;
    retainedSensitiveInputs: number;
  };
  console: {
    spawns: Array<{
      executable: string;
      args: string[];
      cwd: string;
      rootDirectory: string;
      clientRootDirectory: string;
      configPath: string;
      historyPath: string;
      disableConsoleLogs: string;
      configEntries: string[];
      configSha256: string;
      writes: string[];
      resizes: Array<{ columns: number; rows: number }>;
      kills: number;
    }>;
    writes: string[];
    resizes: Array<{ columns: number; rows: number }>;
    kills: number;
  };
  connectedConfig?: { operator: string; host: string; port: number };
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "m0-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_CA_M0_DO_NOT_RENDER",
    certificate: "FAKE_CERT_M0_DO_NOT_RENDER",
    private_key: PRIVATE_KEY_SECRET,
    token: TOKEN_SECRET,
  });
}
