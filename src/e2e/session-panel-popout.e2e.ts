import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";

import type { SessionPanelWindowKind, SliverDesktopAPI } from "../shared/contracts.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

const panels = [
  { id: "execution", tab: "Execution", button: "Pop out execution", region: "Execution operations" },
  { id: "files", tab: "Files", button: "Pop out file browser", region: "File browser" },
  { id: "registry", tab: "Registry", button: "Pop out registry editor", region: "Registry editor" },
] as const;

test("Execution, Files, and Registry open exact-session standalone panels and reuse their windows", {
  timeout: 180_000,
}, async () => {
  const fixture = await launchFixture(["--registry-layout-fixture", "--files-layout-fixture"]);
  const errors: string[] = [];
  fixture.application.on("window", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    const source = await openSession(fixture.application);
    source.on("pageerror", (error) => errors.push(error.message));
    const original = await snapshot(source);
    const sourceTarget = original.targetContext.activeTarget;
    assert.equal(sourceTarget?.mode, "session");
    assert.ok(sourceTarget);
    assert.equal(original.targetContext.activeTargetSummary?.os.toLowerCase(), "windows");

    for (const { id, tab, button, region } of panels) {
      await source.bringToFront();
      await source.getByRole("tab", { name: tab, exact: true }).click();
      assert.equal(await source.locator('header[aria-label="Session window header"]').count(), 0,
        "the standalone drag header must not appear in the main session window");
      const popOut = source.getByRole("button", { name: button, exact: true });
      await popOut.waitFor();
      const [window] = await Promise.all([
        fixture.application.waitForEvent("window", { timeout: 15_000 }),
        popOut.click(),
      ]);
      window.setDefaultTimeout(20_000);
      await window.waitForURL(/\?surface=session-panel$/u);
      await window.getByRole("main", { name: `Standalone ${tab} window`, exact: true }).waitFor();
      await window.getByRole("region", { name: region, exact: true }).waitFor();
      await assertStandalonePanelChrome(
        window,
        tab,
        region,
        original.targetContext.activeTargetSummary?.name ?? "",
        original.targetContext.activeTargetSummary?.hostname ?? "",
      );
      if (id === "files" || id === "registry") {
        const bounds = await window.getByRole("region", { name: region, exact: true }).boundingBox();
        assert.ok(bounds && bounds.height > 300,
          `${tab} standalone editor must fill useful vertical space (height=${bounds?.height})`);
      }

      const url = new URL(window.url());
      assert.equal(url.search, "?surface=session-panel", "the URL must contain only a static surface marker");
      assert.equal(url.hash, "");
      assert.equal(url.username, "");
      assert.equal(url.password, "");
      assert.ok(!decodeURIComponent(window.url()).includes(sourceTarget.id), "the session ID must stay out of the URL");
      assert.equal(await window.evaluate(() => (globalThis as { opener?: unknown }).opener === null), true);
      assert.equal(await window.getByRole("tablist", { name: "Session interaction sections" }).count(), 0);
      assert.equal(await window.getByRole("button", { name: button, exact: true }).count(), 0,
        "a standalone panel must not expose another pop-out button");
      for (const other of panels.filter((candidate) => candidate.id !== id)) {
        assert.equal(await window.getByRole("region", { name: other.region, exact: true }).count(), 0,
          `${tab} window must not render ${other.tab}`);
      }

      const destination = await snapshot(window);
      const destinationTarget = destination.targetContext.activeTarget;
      assert.equal(destinationTarget?.mode, "session");
      assert.equal(destinationTarget.id, sourceTarget.id);
      assert.equal(destinationTarget.backendEpoch, sourceTarget.backendEpoch);
      assert.equal(destinationTarget.fingerprint, sourceTarget.fingerprint);
      assert.equal(destination.connection.incarnation, original.connection.incarnation);
      await assertSandboxedWindow(fixture.application, window.url());

      await source.bringToFront();
      await popOut.click();
      const repeated = await source.evaluate(async (panel) => (
        await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.openSessionPanelWindow({ panel })
      ), id as SessionPanelWindowKind);
      assert.equal(repeated.ok, true, repeated.error ?? "the panel should reuse its window");
      assert.equal(fixture.application.windows().filter((candidate) =>
        !candidate.isClosed() && candidate.url().includes("?surface=session-panel")).length, 1,
      "a repeated pop-out request must focus the same native window");
      assert.equal(await source.getByRole("tab", { name: tab, exact: true }).getAttribute("aria-selected"), "true");
      assert.equal(await source.getByRole("region", { name: region, exact: true }).count(), 1,
        "popping out a panel must leave the source editor in place");
      const sourceAfter = await snapshot(source);
      assert.equal(sourceAfter.targetContext.activeTarget?.id, sourceTarget.id);
      assert.equal(sourceAfter.targetContext.activeTarget?.fingerprint, sourceTarget.fingerprint);
      if (id === "files") await verifyRemoteTextEditorFromFiles(fixture.application, window);
      await window.close();
    }
    assert.deepEqual(errors, []);
  } finally {
    await fixture.application.close().catch(() => undefined);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("Execution history and captured output sync between the session and its pop-out", {
  timeout: 120_000,
}, async () => {
  const fixture = await launchFixture([]);
  const errors: string[] = [];
  fixture.application.on("window", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  try {
    const source = await openSession(fixture.application);
    source.on("pageerror", (error) => errors.push(error.message));
    await source.getByRole("tab", { name: "Execution", exact: true }).click();

    const sourceHistory = source.getByRole("navigation", { name: "Process execution history", exact: true });
    const sourceOutput = source.getByRole("region", { name: "Process execution history and output", exact: true });
    const sourceForm = source.getByRole("region", { name: "Execute a subprocess", exact: true });
    await sourceForm.waitFor();
    await runProcess(sourceForm, "/usr/bin/printf", "first-run");
    await sourceOutput.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await assertProcessResult(source, sourceOutput);

    // The new window must hydrate an execution that completed before it existed.
    const [popOut] = await Promise.all([
      fixture.application.waitForEvent("window", { timeout: 15_000 }),
      source.getByRole("button", { name: "Pop out execution", exact: true }).click(),
    ]);
    popOut.setDefaultTimeout(20_000);
    await popOut.getByRole("main", { name: "Standalone Execution window", exact: true }).waitFor();
    const popOutHistory = popOut.getByRole("navigation", { name: "Process execution history", exact: true });
    const popOutOutput = popOut.getByRole("region", { name: "Process execution history and output", exact: true });
    await popOutHistory.getByRole("row", { name: /\/usr\/bin\/printf first-run/u }).waitFor();
    await popOutOutput.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    await assertProcessResult(popOut, popOutOutput);
    await assertReadableProcessOutput(popOut, popOutOutput);
    await assertExecutionPopOutResizes(fixture.application, popOut, popOutOutput);
    assert.equal(await popOutHistory.getByRole("row").count(), 2,
      "the pop-out must include the execution that completed before it opened");

    await popOutHistory.getByRole("row", { name: "New Execution", exact: true }).click();
    const popOutForm = popOut.getByRole("region", { name: "Execute a subprocess", exact: true });
    await popOutForm.waitFor();
    await runProcess(popOutForm, "/usr/bin/id", "second-run");
    await popOutOutput.getByRole("heading", { name: "/usr/bin/id second-run", exact: true }).waitFor();
    await assertProcessResult(popOut, popOutOutput);

    // The main view can keep its own selection while still receiving the new run.
    const secondInSource = sourceHistory.getByRole("row", { name: /\/usr\/bin\/id second-run/u });
    await secondInSource.waitFor();
    await secondInSource.click();
    await sourceOutput.getByRole("heading", { name: "/usr/bin/id second-run", exact: true }).waitFor();
    await assertProcessResult(source, sourceOutput);
    await assertReadableProcessOutput(source, sourceOutput);
    assert.equal(await sourceHistory.getByRole("row").count(), 3);
    assert.equal(await popOutHistory.getByRole("row").count(), 3);
    const executions = await fixture.application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods
      .filter((method) => method === "executeSession").length);
    assert.equal(executions, 2, "history synchronization must not execute the process again");

    await sourceOutput.getByRole("button", { name: "Clear selected", exact: true }).click();
    await popOutHistory.getByRole("row", { name: /\/usr\/bin\/id second-run/u }).waitFor({ state: "detached" });
    await popOutOutput.getByRole("heading", { name: "/usr/bin/printf first-run", exact: true }).waitFor();
    assert.equal(await popOutHistory.getByRole("row").count(), 2);

    await popOutOutput.getByRole("button", { name: "Clear history", exact: true }).click();
    await sourceHistory.getByRole("row", { name: /\/usr\/bin\/printf first-run/u }).waitFor({ state: "detached" });
    await sourceForm.waitFor();
    assert.equal(await sourceHistory.getByRole("row").count(), 1);
    assert.equal(await popOutHistory.getByRole("row").count(), 1);
    assert.deepEqual(errors, []);
  } finally {
    await fixture.application.close().catch(() => undefined);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test("Registry pop-out is rejected for a non-Windows session", { timeout: 120_000 }, async () => {
  const fixture = await launchFixture([]);
  try {
    const source = await openSession(fixture.application);
    const current = await snapshot(source);
    assert.equal(current.targetContext.activeTargetSummary?.os.toLowerCase(), "darwin");
    assert.equal(await source.getByRole("tab", { name: "Registry", exact: true }).count(), 0);
    const windowsBefore = fixture.application.windows().length;
    const result = await source.evaluate(async () => (
      await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.openSessionPanelWindow({ panel: "registry" })
    ));
    assert.equal(result.ok, false);
    assert.ok(result.error, "the non-Windows Registry request must return a failure reason");
    assert.equal(fixture.application.windows().length, windowsBefore);
  } finally {
    await fixture.application.close().catch(() => undefined);
    await rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

async function launchFixture(flags: readonly string[]): Promise<{
  application: ElectronApplication;
  temporaryRoot: string;
}> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-session-panel-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  await Promise.all([savedConfigDirectory, managedConfigDirectory, userDataDirectory, consoleClientRootDirectory]
    .map((directory) => mkdir(directory, { recursive: true })));
  await writeFile(join(savedConfigDirectory, "session-panel-e2e-operator.cfg"), fakeOperatorConfig(), { mode: 0o600 });
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
        ...flags,
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

async function snapshot(page: Page): Promise<Awaited<ReturnType<SliverDesktopAPI["getSnapshot"]>>> {
  return page.evaluate(() => (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.getSnapshot());
}

async function runProcess(form: ReturnType<Page["getByRole"]>, path: string, args: string): Promise<void> {
  await form.getByLabel("Executable path").fill(path);
  await form.getByRole("textbox", { name: "Arguments", exact: true }).fill(args);
  await form.getByRole("button", { name: "Execute", exact: true }).click();
}

async function assertProcessResult(page: Page, output: ReturnType<Page["getByRole"]>): Promise<void> {
  const transcript = page.getByLabel("Execution output transcript", { exact: true });
  await transcript.waitFor();
  assert.match(await transcript.textContent() ?? "", /deterministic M4 process stdout/u);
  const details = output.locator('dl[aria-label="Execution details"]');
  await details.waitFor();
  assert.match(await details.innerText(), /Exit code\s+0/u);
  assert.match(await details.innerText(), /Process ID\s+43001/u);
}

async function assertReadableProcessOutput(page: Page, output: ReturnType<Page["getByRole"]>): Promise<void> {
  const requestId = (await output.locator('dl[aria-label="Execution details"] dd').nth(2).innerText()).trim();
  assert.ok(requestId && requestId !== "Pending", "the peer window must show the execution request ID");
  const read = await page.evaluate(async (id) => {
    const result = await (globalThis as unknown as { sliver: SliverDesktopAPI }).sliver.readExecutionOutput({
      requestId: id,
      stream: "stdout",
    });
    return {
      ok: result.ok,
      error: result.error,
      stdout: result.value ? new TextDecoder().decode(result.value.data) : undefined,
    };
  }, requestId);
  assert.equal(read.ok, true, read.error ?? "the peer window must be authorized to read captured output");
  assert.match(read.stdout ?? "", /deterministic M4 process stdout/u);
}

async function assertStandalonePanelChrome(
  page: Page,
  title: string,
  regionName: string,
  sessionName: string,
  hostname: string,
): Promise<void> {
  assert.ok(sessionName && hostname, "the fixture must provide session and host names");
  const main = page.getByRole("main", { name: `Standalone ${title} window`, exact: true });
  const header = page.locator('header[aria-label="Session window header"]');
  const region = page.getByRole("region", { name: regionName, exact: true });
  await header.waitFor();

  const headerText = await header.innerText();
  assert.ok(headerText.includes(title), `${title} header must identify the panel`);
  assert.ok(headerText.includes(sessionName), `${title} header must identify the session`);
  assert.ok(headerText.includes(hostname), `${title} header must identify the host`);
  const dragRegion = await header.evaluate((element) => (
    globalThis as unknown as {
      getComputedStyle: (target: unknown) => { getPropertyValue: (name: string) => string };
    }
  ).getComputedStyle(element).getPropertyValue("-webkit-app-region"));
  assert.equal(dragRegion.trim(), "drag", `${title} header must be a native window drag target`);

  const [viewport, mainBounds, headerBounds, regionBounds] = await Promise.all([
    page.evaluate(() => ({
      width: (globalThis as unknown as { innerWidth: number }).innerWidth,
      height: (globalThis as unknown as { innerHeight: number }).innerHeight,
    })),
    main.boundingBox(),
    header.boundingBox(),
    region.boundingBox(),
  ]);
  assert.ok(mainBounds && headerBounds && regionBounds, `${title} standalone layout must be measurable`);
  assert.ok(headerBounds.y <= 2,
    `${title} header must begin at the top of the window without a titlebar spacer (y=${headerBounds.y})`);
  assert.ok(headerBounds.height >= 28 && headerBounds.height <= 64,
    `${title} header must stay slim (height=${headerBounds.height})`);
  assert.ok(Math.abs(regionBounds.y - (headerBounds.y + headerBounds.height)) <= 2,
    `${title} panel must begin immediately below its header`);
  assert.ok(Math.abs(regionBounds.x - mainBounds.x) <= 2 && regionBounds.x <= 2,
    `${title} panel must meet the left window edge (x=${regionBounds.x})`);
  assert.ok(Math.abs((regionBounds.x + regionBounds.width) - viewport.width) <= 2,
    `${title} panel must meet the right window edge`);
  assert.ok(Math.abs((regionBounds.y + regionBounds.height) - viewport.height) <= 2,
    `${title} panel must meet the bottom window edge`);
}

async function assertExecutionPopOutResizes(
  application: ElectronApplication,
  page: Page,
  workspace: ReturnType<Page["getByRole"]>,
): Promise<void> {
  const nativeWindow = await application.browserWindow(page);
  const main = page.getByRole("main", { name: "Standalone Execution window", exact: true });
  const operations = page.getByRole("region", { name: "Execution operations", exact: true });
  const historyRail = workspace.locator("aside").first();
  const terminal = page.locator('[aria-label="Execution output terminal"]');
  await terminal.locator("canvas").waitFor();

  const terminalHeights: number[] = [];
  for (const [width, height] of [[1440, 950], [1024, 768]]) {
    await nativeWindow.evaluate((window, size) => window.setSize(size.width, size.height), { width, height });
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, width);
    const [mainBounds, operationsBounds, workspaceBounds, historyBounds, terminalBounds] = await Promise.all([
      main.boundingBox(), operations.boundingBox(), workspace.boundingBox(), historyRail.boundingBox(), terminal.boundingBox(),
    ]);
    assert.ok(mainBounds && operationsBounds && workspaceBounds && historyBounds && terminalBounds,
      `Execution layout must be measurable at ${width}×${height}`);
    const mainBottom = mainBounds.y + mainBounds.height;
    const operationsBottom = operationsBounds.y + operationsBounds.height;
    const workspaceBottom = workspaceBounds.y + workspaceBounds.height;
    assert.ok(mainBottom - operationsBottom >= -1 && mainBottom - operationsBottom <= 32,
      `Execution must fill the standalone window at ${width}×${height}; bottom gap=${mainBottom - operationsBottom}`);
    assert.ok(operationsBottom - workspaceBottom >= -1 && operationsBottom - workspaceBottom <= 40,
      `Process workspace must fill Execution at ${width}×${height}; bottom gap=${operationsBottom - workspaceBottom}`);
    assertContained(historyBounds, workspaceBounds, `Execution history at ${width}×${height}`);
    assertContained(terminalBounds, workspaceBounds, `Execution terminal at ${width}×${height}`);
    terminalHeights.push(terminalBounds.height);
  }
  assert.ok(terminalHeights[0]! - terminalHeights[1]! > 50,
    `Execution terminal must resize with the window; heights=${terminalHeights.join(", ")}`);
}

function assertContained(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
  label: string,
): void {
  assert.ok(child.width > 0 && child.height > 0, `${label} must have positive size`);
  assert.ok(child.x >= parent.x - 1 && child.y >= parent.y - 1, `${label} must start inside its workspace`);
  assert.ok(child.x + child.width <= parent.x + parent.width + 1,
    `${label} must fit horizontally inside its workspace`);
  assert.ok(child.y + child.height <= parent.y + parent.height + 1,
    `${label} must fit vertically inside its workspace`);
}

async function assertSandboxedWindow(application: ElectronApplication, expectedUrl: string): Promise<void> {
  const preferences = await application.evaluate(({ BrowserWindow }, url) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url);
    if (!window) throw new Error("Expected a standalone session panel BrowserWindow");
    const settings = (window.webContents as unknown as {
      getLastWebPreferences(): Record<string, unknown>;
    }).getLastWebPreferences();
    return {
      contextIsolation: settings["contextIsolation"],
      nodeIntegration: settings["nodeIntegration"],
      nodeIntegrationInWorker: settings["nodeIntegrationInWorker"] ?? false,
      nodeIntegrationInSubFrames: settings["nodeIntegrationInSubFrames"],
      sandbox: settings["sandbox"],
      webSecurity: settings["webSecurity"],
      webviewTag: settings["webviewTag"],
    };
  }, expectedUrl);
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

async function verifyRemoteTextEditorFromFiles(application: ElectronApplication, filesWindow: Page): Promise<void> {
  const before = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods
    .filter((method) => method === "downloadFileSession").length);
  const browser = filesWindow.getByRole("region", { name: "File browser", exact: true });
  const file = browser.getByRole("row").filter({ hasText: "E2EFile081.txt" });
  const opened = application.waitForEvent("window", { timeout: 15_000 });
  await file.getByRole("rowheader", { name: "E2EFile081.txt", exact: true }).click({ button: "right" });
  const menu = filesWindow.getByRole("menu", { name: "Application context menu", exact: true });
  await menu.waitFor();
  await menu.getByRole("menuitem", { name: "Edit text", exact: true }).click();
  const editor = await opened;
  try {
    editor.setDefaultTimeout(15_000);
    await editor.getByRole("heading", { name: "E2EFile081.txt", exact: true }).waitFor();
    await editor.locator(".monaco-editor").waitFor();
    assert.equal(new URL(editor.url()).search, "?surface=text-editor");
    assert.equal(await editor.getByRole("button", { name: "Save As…" }).count(), 0,
      "a remote document opened from Files must not expose a local Save As action");
    const after = await application.evaluate(() => globalThis.__SLIVER_GUI_E2E_STATE__.methods
      .filter((method) => method === "downloadFileSession").length);
    assert.ok(after > before, "the standalone Files window must read the remote file through main-owned RPC");
  } finally {
    await editor.close().catch(() => undefined);
  }
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "session-panel-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_PANEL_CA_DO_NOT_RENDER",
    certificate: "FAKE_PANEL_CERT_DO_NOT_RENDER",
    private_key: "FAKE_PANEL_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
