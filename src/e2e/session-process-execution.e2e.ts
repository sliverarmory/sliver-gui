import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import type { SliverDesktopAPI } from "../shared/contracts.js";
import { assertExecutionComposerScrollLayout, assertExecutionOutputLayout } from "./execution-layout-assertions.js";

const PROCESS_STDOUT = "deterministic M4 process stdout";

test("session Process executes into Ghostty and retains navigable in-memory history", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-process-execution-e2e-"));
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
  await writeFile(
    join(savedConfigDirectory, "process-execution-e2e-operator.cfg"),
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
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));

    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();

    const form = page.getByRole("region", { name: "Execute a subprocess", exact: true });
    const outputPanel = page.getByRole("region", { name: "Process execution history and output", exact: true });
    const history = page.getByRole("navigation", { name: "Process execution history", exact: true });
    const newExecution = history.getByRole("row", { name: "New Execution", exact: true });
    await form.waitFor();
    await history.waitFor();
    await assertExecutionComposerScrollLayout(form, "Execute a subprocess", "Process execution content", ["Execute"]);
    await assertProcessRailBesideContent(outputPanel, history, form);
    assert.equal(await newExecution.count(), 1, "New Execution must always head the history rail");
    assert.equal(await history.getByRole("row").count(), 1,
      "an empty history must still show New Execution");
    assert.equal(await form.getByRole("textbox", { name: "Executable path" }).count(), 1);
    const argumentsField = form.getByRole("textbox", { name: "Arguments" });
    assert.equal(await argumentsField.count(), 1);
    assert.equal(await argumentsField.evaluate((element) => element.tagName), "INPUT",
      "process arguments must use a single-line text field");
    const execute = form.getByRole("button", { name: "Execute", exact: true });
    const executeBounds = await execute.boundingBox();
    const pathBounds = await form.getByRole("textbox", { name: "Executable path" }).boundingBox();
    assert.ok(executeBounds && pathBounds && executeBounds.y + executeBounds.height <= pathBounds.y + 2,
      "Execute must appear above the command fields");
    assert.equal(await form.getByRole("switch", { name: /Capture output/u }).isChecked(), true,
      "the session Process form must capture output by default");
    assert.equal(await form.getByRole("switch", { name: /Run in background/u }).count(), 1,
      "execution options must be available inline");
    assert.equal(await form.getByRole("spinbutton", { name: "Timeout seconds" }).count(), 1);
    assert.equal(await form.getByRole("button", { name: "Execution options", exact: true }).count(), 0);
    assert.equal(await page.getByRole("dialog", { name: "Execution options", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Open: Execute process", exact: true }).count(), 0,
      "the previous Process action card must be absent");
    await page.screenshot({
      animations: "disabled",
      fullPage: true,
      path: join(screenshotDirectory, "session-process-new-execution.png"),
    });

    await form.getByLabel("Executable path").fill("/usr/bin/printf");
    await argumentsField.fill('"unfinished');
    await execute.click();
    assert.match(await form.getByRole("alert").innerText(), /quote/iu);
    assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?" }).count(), 0,
      "malformed arguments must stop direct execution");
    assert.equal(await fakeMethodCount(application, "executeSession"), 0);

    await runProcess(form, page, "/usr/bin/printf", "first-run");
    await form.waitFor({ state: "hidden" });
    const terminal = page.locator('[aria-label="Execution output terminal"]');
    await assertGhosttyOutput(page, terminal);
    await assertProcessDetails(outputPanel);
    await assertProcessRailBesideContent(outputPanel, history, terminal);
    await assertEmbeddedProcessViewport(page, outputPanel, terminal);
    await assertExecutionOutputLayout(outputPanel, history, terminal, "Process");
    assert.equal(await history.getByRole("row").count(), 2,
      "the completed execution must appear directly below New Execution");
    await page.screenshot({
      animations: "disabled",
      path: join(screenshotDirectory, "session-process-execution.png"),
    });
    await page.locator(".app-content").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({
      animations: "disabled",
      path: join(screenshotDirectory, "session-process-execution-top.png"),
    });
    assert.equal(await fakeMethodCount(application, "executeSession"), 1);

    await assertReadOnlyTerminalContextMenu(application, page, terminal);

    await newExecution.click();
    await form.waitFor();
    await assertProcessRailBesideContent(outputPanel, history, form);
    await runProcess(form, page, "/usr/bin/id", '"second run" escaped\\ space');
    await outputPanel.getByText("History · 2", { exact: true }).waitFor();
    await form.waitFor({ state: "hidden" });
    await assertGhosttyOutput(page, terminal);
    assert.equal(await fakeMethodCount(application, "executeSession"), 2);
    assert.equal(await history.getByRole("row").count(), 3);
    await assertVerticalHistoryBesideTerminal(outputPanel, history, terminal);
    const historyItems = history.getByRole("row");
    assert.equal(await historyItems.nth(0).innerText(), "New Execution");
    assert.match(await historyItems.nth(1).innerText(), /\/usr\/bin\/id/u,
      "the most recent execution must sit below New Execution");
    assert.match(await historyItems.nth(2).innerText(), /\/usr\/bin\/printf/u,
      "the older execution must follow the most recent one");
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    const olderBounds = await historyItems.nth(2).boundingBox();
    assert.ok(olderBounds, "the older process history item must be visible");
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
    await copyMenu.waitFor({ state: "hidden" });
    await waitForClipboard(application, "deterministic M4 process stdout\n");
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();
    const lootMenu = await openOlderMenu();
    await lootMenu.getByRole("menuitem", { name: "Add stdout to Loot", exact: true }).click();
    await page.getByText("Output added to Loot", { exact: true }).waitFor();
    assert.equal(await fakeMethodCount(application, "lootAdd"), 1);
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await historyItems.nth(2).click();
    await outputPanel.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await assertGhosttyOutput(page, terminal);
    await historyItems.nth(1).click();
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("navigation", { name: "Process execution history", exact: true }).waitFor();
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await outputPanel.getByRole("button", { name: "Clear selected", exact: true }).click();
    await outputPanel.getByText("History · 1", { exact: true }).waitFor();
    await outputPanel.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await outputPanel.getByRole("button", { name: "Clear history", exact: true }).click();
    await form.waitFor();
    assert.equal(await history.getByRole("row").count(), 1,
      "clearing history must retain the New Execution option");
    await assertProcessRailBesideContent(outputPanel, history, form);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows session Process retains tasklist output across an in-flight session revision", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-windows-process-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const executablePath = String.raw`C:\Windows\System32\tasklist.exe`;
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(savedConfigDirectory, "windows-process-e2e-operator.cfg"),
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
        "--registry-layout-fixture",
      ],
      bypassCSP: false,
      chromiumSandbox: true,
      cwd: repositoryRoot,
    } as Parameters<typeof electron.launch>[0] & { chromiumSandbox: true });

    const page = await application.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    const savedConfigurations = page.getByRole("dialog", { name: "Saved configurations" });
    await savedConfigurations.waitFor();
    await savedConfigurations.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await page.locator('[aria-label="Sessions"]:visible').click();
    await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
    await page.getByRole("button", { name: "Interact with m1-session", exact: true }).click();
    await page.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();

    const form = page.getByRole("region", { name: "Execute a subprocess", exact: true });
    const history = page.getByRole("navigation", { name: "Process execution history", exact: true });
    const outputPanel = page.getByRole("region", { name: "Process execution history and output", exact: true });
    await form.waitFor();
    assert.equal(await form.getByRole("textbox", { name: "Executable path" }).inputValue(),
      String.raw`C:\Windows\System32\cmd.exe`, "Windows should offer a native executable default");
    assert.equal(await form.getByRole("switch", { name: /Capture output/u }).isChecked(), true);
    assert.equal(await form.getByRole("switch", { name: /Run in background/u }).isChecked(), false);

    const initialSessionRevision = await page.evaluate(async () => (
      await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()
    ).domains.sessions.revision);
    await page.evaluate((revision) => {
      const scope = globalThis as unknown as {
        sliver: SliverDesktopAPI;
        __processSessionRevisionObserved?: number;
        __processSessionRevisionUnsubscribe?: () => void;
      };
      scope.__processSessionRevisionObserved = revision;
      scope.__processSessionRevisionUnsubscribe = scope.sliver.onSnapshotChanged((snapshot) => {
        scope.__processSessionRevisionObserved = snapshot.domains.sessions.revision;
      });
    }, initialSessionRevision);
    await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.holdNextProcessResponse());
    try {
      await runProcess(form, page, executablePath, "");
      await waitForProcessResponseHold(application);
      const heldSessionRevision = await waitForSessionRevision(page, initialSessionRevision);
      assert.ok(heldSessionRevision > initialSessionRevision,
        "main must refresh the same session while its process response is held");
      await page.waitForFunction((revision) => (
        (globalThis as unknown as { __processSessionRevisionObserved?: number })
          .__processSessionRevisionObserved ?? -1
      ) >= revision, heldSessionRevision);
      // Let React commit the refreshed target reference before the remote result returns.
      await page.evaluate(() => new Promise<void>((resolve) => {
        const browser = globalThis as unknown as { requestAnimationFrame(callback: () => void): number };
        browser.requestAnimationFrame(() => browser.requestAnimationFrame(() => resolve()));
      }));
      assert.equal(await outputPanel.getByText(/The selected target changed before this result/u).count(), 0);
    } finally {
      await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_CONTROL__.releaseProcessResponseHold());
      await page.evaluate(() => {
        (globalThis as unknown as { __processSessionRevisionUnsubscribe?: () => void })
          .__processSessionRevisionUnsubscribe?.();
      }).catch(() => undefined);
    }
    await form.waitFor({ state: "hidden" });
    await outputPanel.getByRole("heading", { name: executablePath, exact: true }).waitFor();
    await assertGhosttyOutput(page, page.locator('[aria-label="Execution output terminal"]'));
    await assertProcessDetails(outputPanel);
    assert.equal(await outputPanel.getByText(/The selected target changed before this result/u).count(), 0,
      "a revision-only session refresh must not quarantine the completed result");
    assert.equal(await outputPanel.getByText("Outcome unknown", { exact: true }).count(), 0);
    assert.equal(await history.getByRole("row").count(), 2,
      "the Windows execution must appear below New Execution");
    assert.match(await history.getByRole("row").nth(1).innerText(), /tasklist\.exe/u);

    const expectedCall = {
      sessionId: "m1_session",
      options: {
        path: executablePath,
        args: [],
        output: true,
        background: false,
        envInheritance: false,
        env: {},
        useToken: false,
        hideWindow: false,
      },
      timeoutSeconds: 60,
    };
    const calls = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.processCalls);
    assert.deepEqual(calls, [expectedCall],
      "the exact Windows path and default options must reach the fake Sliver client");

    await history.getByRole("row", { name: "New Execution", exact: true }).click();
    await form.waitFor();
    await runProcess(form, page, `"${executablePath}"`, "");
    await form.waitFor({ state: "hidden" });
    await outputPanel.getByRole("heading", { name: executablePath, exact: true }).waitFor();
    assert.equal(await history.getByRole("row").count(), 3);
    assert.deepEqual(
      await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.processCalls),
      [expectedCall, expectedCall],
      "a pasted quoted Windows path must reach the fake Sliver client without literal quotes",
    );
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertProcessRailBesideContent(
  workspace: Locator,
  history: Locator,
  content: Locator,
): Promise<void> {
  const workspaceBounds = await workspace.boundingBox();
  const historyBounds = await history.boundingBox();
  const contentBounds = await content.boundingBox();
  assert.ok(workspaceBounds && historyBounds && contentBounds,
    "the history rail and selected content must be visible");
  assert.ok(historyBounds.width <= Math.min(300, workspaceBounds.width * 0.35),
    "the history rail must use a narrow part of the workspace");
  assert.ok(historyBounds.x + historyBounds.width <= contentBounds.x + 2,
    "the history rail must sit to the left of the selected content");
}

async function assertVerticalHistoryBesideTerminal(
  outputPanel: Locator,
  history: Locator,
  terminal: Locator,
): Promise<void> {
  const panelBounds = await outputPanel.boundingBox();
  const headingBounds = await outputPanel.getByRole("heading").first().boundingBox();
  const historyBounds = await history.boundingBox();
  const terminalBounds = await terminal.boundingBox();
  const entries = history.getByRole("row");
  const newBounds = await entries.nth(0).boundingBox();
  const firstBounds = await entries.nth(1).boundingBox();
  const secondBounds = await entries.nth(2).boundingBox();
  assert.ok(panelBounds && headingBounds && historyBounds && terminalBounds && newBounds && firstBounds && secondBounds,
    "history entries and the Ghostty terminal must have measurable bounds");
  assert.ok(terminalBounds.y - headingBounds.y <= 260,
    "the output header and run details must leave the terminal near the top of the panel");
  assert.ok(historyBounds.width <= Math.min(300, panelBounds.width * 0.3),
    "the history rail must use a narrow part of the output panel");
  assert.ok(historyBounds.x + historyBounds.width <= terminalBounds.x + 2,
    "the history rail must sit to the left of the terminal");
  assert.ok(firstBounds.y >= newBounds.y + newBounds.height - 2,
    "the most recent run must sit below New Execution");
  assert.ok(secondBounds.y >= firstBounds.y + firstBounds.height - 2,
    "history entries must stack vertically");
  assert.ok(Math.abs(newBounds.x - firstBounds.x) <= 4,
    "New Execution and history entries must share the same left edge");
  assert.ok(Math.abs(secondBounds.x - firstBounds.x) <= 4,
    "history entries must share the same left edge");
}

async function assertEmbeddedProcessViewport(
  page: Page,
  workspace: Locator,
  terminal: Locator,
): Promise<void> {
  const viewport = page.locator(
    '.session-workspace[data-presentation="embedded"][data-selected-panel="execution"] .session-workspace__panel-content',
  );
  const operations = page.getByRole("region", { name: "Execution operations", exact: true });
  const [viewportBounds, operationsBounds, workspaceBounds, terminalBounds] = await Promise.all([
    viewport.boundingBox(), operations.boundingBox(), workspace.boundingBox(), terminal.boundingBox(),
  ]);
  assert.ok(viewportBounds && operationsBounds && workspaceBounds && terminalBounds,
    "embedded Execution viewport, workspace, and output terminal must be measurable");
  const viewportBottom = viewportBounds.y + viewportBounds.height;
  const operationsBottom = operationsBounds.y + operationsBounds.height;
  const workspaceBottom = workspaceBounds.y + workspaceBounds.height;
  assert.ok(viewportBottom - operationsBottom >= -1 && viewportBottom - operationsBottom <= 24,
    `Execution must fill the session content viewport; bottom gap=${viewportBottom - operationsBottom}`);
  assert.ok(operationsBottom - workspaceBottom >= -1 && operationsBottom - workspaceBottom <= 40,
    `Process workspace must fill Execution with modest padding; bottom gap=${operationsBottom - workspaceBottom}`);
  assert.ok(terminalBounds.x >= workspaceBounds.x - 1 && terminalBounds.y >= workspaceBounds.y - 1 &&
    terminalBounds.x + terminalBounds.width <= workspaceBounds.x + workspaceBounds.width + 1 &&
    terminalBounds.y + terminalBounds.height <= workspaceBottom + 1,
  "The output terminal must stay inside the embedded Process workspace");
  assert.ok(workspaceBottom - terminalBounds.y - terminalBounds.height <= 40,
    `The output terminal must use the available Process workspace height; bottom gap=${workspaceBottom - terminalBounds.y - terminalBounds.height}`);
}

async function runProcess(form: Locator, page: Page, path: string, args: string): Promise<void> {
  await form.getByLabel("Executable path").fill(path);
  await form.getByLabel("Arguments").fill(args);
  await form.getByRole("button", { name: "Execute", exact: true }).click();
  assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true }).count(), 0,
    "Execute must dispatch without a confirmation dialog");
}

async function waitForProcessResponseHold(application: ElectronApplication): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.processResponseHeld)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the fake Windows process response was never held after execution dispatch");
}

async function waitForSessionRevision(page: Page, previousRevision: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  let currentRevision = previousRevision;
  while (Date.now() < deadline) {
    currentRevision = await page.evaluate(async () => (
      await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot()
    ).domains.sessions.revision);
    if (currentRevision > previousRevision) return currentRevision;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`the held process did not refresh the session revision (before ${previousRevision}, after ${currentRevision})`);
}

async function assertGhosttyOutput(page: Page, terminal: Locator): Promise<void> {
  const transcript = page.getByLabel("Execution output transcript");
  await transcript.waitFor();
  assert.match(await transcript.textContent() ?? "", /deterministic M4 process stdout/u);
  await terminal.locator("canvas").waitFor();
  await page.locator('[data-terminal-state="ready"] [aria-label="Execution output terminal"]').waitFor();
  assert.equal(await terminal.getAttribute("contenteditable"), "true",
    "the captured output must be rendered by the real Ghostty host");
}

async function assertProcessDetails(outputPanel: Locator): Promise<void> {
  const details = outputPanel.locator('dl[aria-label="Execution details"]');
  await details.waitFor();
  assert.match(await details.innerText(), /Exit code\s+0/u);
  assert.match(await details.innerText(), /Process ID\s+43001/u);
}

async function assertReadOnlyTerminalContextMenu(
  application: ElectronApplication,
  page: Page,
  terminal: Locator,
): Promise<void> {
  const canvas = terminal.locator("canvas");
  await canvas.scrollIntoViewIfNeeded();
  await page.bringToFront();
  await application.evaluate(({ clipboard }) => clipboard.writeText("before-process-selection"));
  await canvas.dblclick({ position: { x: 12, y: 8 } });
  const bounds = await canvas.boundingBox();
  assert.ok(bounds, "Ghostty's canvas must have native input bounds");
  await sendNativeContextMenu(application, page, { x: bounds.x + 12, y: bounds.y + 8 });

  const menu = page.getByRole("menu", { name: "Application context menu" });
  await menu.waitFor();
  const copy = menu.getByRole("menuitem", { name: "Copy", exact: true });
  const paste = menu.getByRole("menuitem", { name: "Paste", exact: true });
  await copy.waitFor();
  await paste.waitFor();
  assert.notEqual(await copy.getAttribute("aria-disabled"), "true",
    "right-click Copy must be enabled when Ghostty has a selection");
  assert.equal(await paste.getAttribute("aria-disabled"), "true",
    "the output-only terminal must not allow Paste");
  assert.equal(await menu.getByRole("menuitem", { name: "Inspect Element", exact: true }).count(), 1);
  await copy.click();
  await menu.waitFor({ state: "hidden" });
  const deadline = Date.now() + 5_000;
  let copied = "";
  while (Date.now() < deadline) {
    copied = await application.evaluate(({ clipboard }) => clipboard.readText());
    if (copied.length > 0 && PROCESS_STDOUT.includes(copied.trim())) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Copy must use Ghostty's selected output; got ${JSON.stringify(copied)}`);
}

async function sendNativeContextMenu(
  application: ElectronApplication,
  page: Page,
  point: { readonly x: number; readonly y: number },
): Promise<void> {
  const sent = await application.evaluate(({ app, BrowserWindow }, input) => {
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
  }, { ...point, url: page.url() });
  assert.equal(sent, true, `expected a native Electron window for ${page.url()}`);
}

async function waitForClipboard(application: ElectronApplication, expected: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let actual = "";
  while (Date.now() < deadline) {
    actual = await application.evaluate(({ clipboard }) => clipboard.readText());
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(actual, expected);
}

async function fakeMethodCount(application: ElectronApplication, method: string): Promise<number> {
  return application.evaluate((_electron, name) =>
    globalThis.__SLIVER_GUI_E2E_STATE__.methods.filter((candidate) => candidate === name).length,
  method);
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "process-execution-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_PROCESS_CA_DO_NOT_RENDER",
    certificate: "FAKE_PROCESS_CERT_DO_NOT_RENDER",
    private_key: "FAKE_PROCESS_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
