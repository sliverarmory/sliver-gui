import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

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

    const form = page.getByRole("region", { name: "Run a process", exact: true });
    const outputPanel = page.getByRole("region", { name: "Process execution history and output", exact: true });
    await form.waitFor();
    await assertStackedProcessSections(form, outputPanel);
    assert.equal(await form.getByRole("textbox", { name: "Executable path" }).count(), 1);
    const argumentsField = form.getByRole("textbox", { name: "Arguments" });
    assert.equal(await argumentsField.count(), 1);
    assert.equal(await argumentsField.evaluate((element) => element.tagName), "INPUT",
      "process arguments must use a single-line text field");
    assert.equal(await form.getByRole("switch", { name: /Capture output/u }).count(), 0,
      "optional execute settings must stay out of the compact command form");
    await form.getByRole("button", { name: "Execution options", exact: true }).click();
    const options = page.getByRole("dialog", { name: "Execution options", exact: true });
    await options.waitFor();
    assert.equal(await options.getByRole("switch", { name: /Capture output/u }).isChecked(), true,
      "the session Process form must capture output by default");
    await options.getByRole("button", { name: "Done", exact: true }).click();
    await options.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Open: Execute process", exact: true }).count(), 0,
      "the previous Process action card must be absent");

    await form.getByLabel("Executable path").fill("/usr/bin/printf");
    await argumentsField.fill('"unfinished');
    await form.getByRole("button", { name: "Review command", exact: true }).click();
    assert.match(await form.getByRole("alert").innerText(), /quote/iu);
    assert.equal(await page.getByRole("alertdialog", { name: "Execute this reviewed action?" }).count(), 0,
      "malformed arguments must stop command review");
    assert.equal(await fakeMethodCount(application, "executeSession"), 0);

    await runProcess(form, page, "/usr/bin/printf", "first-run");
    const terminal = page.locator('[aria-label="Execution output terminal"]');
    await assertGhosttyOutput(page, terminal);
    await assertProcessDetails(outputPanel);
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

    await runProcess(form, page, "/usr/bin/id", '"second run" escaped\\ space', 2);
    await outputPanel.getByText("History · 2", { exact: true }).waitFor();
    await assertGhosttyOutput(page, terminal);
    assert.equal(await fakeMethodCount(application, "executeSession"), 2);
    const history = page.getByRole("navigation", { name: "Process execution history", exact: true });
    assert.equal(await history.getByRole("button").count(), 2);
    await assertVerticalHistoryBesideTerminal(outputPanel, history, terminal);
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await outputPanel.getByRole("button", { name: "Older", exact: true }).click();
    await outputPanel.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await assertGhosttyOutput(page, terminal);
    await outputPanel.getByRole("button", { name: "Newer", exact: true }).click();
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    await page.getByRole("navigation", { name: "Process execution history", exact: true }).waitFor();
    await outputPanel.getByRole("heading", { name: '/usr/bin/id "second run" "escaped space"', exact: true }).waitFor();

    await outputPanel.getByRole("button", { name: "Clear selected", exact: true }).click();
    await outputPanel.getByText("History · 1", { exact: true }).waitFor();
    await outputPanel.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await outputPanel.getByRole("button", { name: "Clear history", exact: true }).click();
    await outputPanel.getByText("Run a process to see its output and execution history here.", { exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "Process execution history", exact: true }).count(), 0);
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertStackedProcessSections(form: Locator, outputPanel: Locator): Promise<void> {
  const formBounds = await form.boundingBox();
  const outputBounds = await outputPanel.boundingBox();
  assert.ok(formBounds && outputBounds, "the process form and output panel must be visible");
  assert.ok(outputBounds.y >= formBounds.y + formBounds.height - 2,
    "Output must begin below the full-width process form");
  assert.ok(Math.abs(outputBounds.x - formBounds.x) <= 4,
    "the process form and output panel must align along their left edges");
  assert.ok(Math.abs(outputBounds.width - formBounds.width) <= 8,
    "the process form and output panel must span the same width");
  assert.ok(formBounds.height <= 340,
    "the desktop process form must remain compact with optional settings in the modal");
}

async function assertVerticalHistoryBesideTerminal(
  outputPanel: Locator,
  history: Locator,
  terminal: Locator,
): Promise<void> {
  const panelBounds = await outputPanel.boundingBox();
  const headingBounds = await outputPanel.getByRole("heading", { name: "Output", exact: true }).boundingBox();
  const historyBounds = await history.boundingBox();
  const terminalBounds = await terminal.boundingBox();
  const entries = history.getByRole("button");
  const firstBounds = await entries.nth(0).boundingBox();
  const secondBounds = await entries.nth(1).boundingBox();
  assert.ok(panelBounds && headingBounds && historyBounds && terminalBounds && firstBounds && secondBounds,
    "history entries and the Ghostty terminal must have measurable bounds");
  assert.ok(terminalBounds.y - headingBounds.y <= 260,
    "the output header and run details must leave the terminal near the top of the panel");
  assert.ok(historyBounds.width <= Math.min(300, panelBounds.width * 0.3),
    "the history rail must use a narrow part of the output panel");
  assert.ok(historyBounds.x + historyBounds.width <= terminalBounds.x + 2,
    "the history rail must sit to the left of the terminal");
  assert.ok(secondBounds.y >= firstBounds.y + firstBounds.height - 2,
    "history entries must stack vertically");
  assert.ok(Math.abs(secondBounds.x - firstBounds.x) <= 4,
    "history entries must share the same left edge");
}

async function runProcess(form: Locator, page: Page, path: string, args: string, expectedArgCount = 1): Promise<void> {
  await form.getByLabel("Executable path").fill(path);
  await form.getByLabel("Arguments").fill(args);
  await form.getByRole("button", { name: "Review command", exact: true }).click();
  const review = page.getByRole("alertdialog", { name: "Execute this reviewed action?", exact: true });
  await review.waitFor();
  const reviewText = await review.innerText();
  assert.ok(reviewText.includes(path));
  assert.match(reviewText, new RegExp(`Arguments\\s+${expectedArgCount}`, "u"));
  await review.getByRole("button", { name: "Execute", exact: true }).click();
  await review.waitFor({ state: "hidden" });
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
