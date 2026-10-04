import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

test("Session content fills wide windows and Managed Shells resizes with the viewport", { timeout: 120_000 }, async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const temporaryRoot = await mkdtemp(join(tmpdir(), "sliver-gui-shell-layout-e2e-"));
  const savedConfigDirectory = join(temporaryRoot, "saved-configs");
  const managedConfigDirectory = join(temporaryRoot, "managed-configs");
  const userDataDirectory = join(temporaryRoot, "user-data");
  const consoleClientRootDirectory = join(temporaryRoot, "sliver-client-root");
  const screenshotDirectory = join(repositoryRoot, "artifacts", "e2e", "session-width");
  await Promise.all([
    mkdir(savedConfigDirectory, { recursive: true }),
    mkdir(managedConfigDirectory, { recursive: true }),
    mkdir(userDataDirectory, { recursive: true }),
    mkdir(consoleClientRootDirectory, { recursive: true }),
    mkdir(screenshotDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(savedConfigDirectory, "shell-layout-e2e-operator.cfg"),
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

    const sessionPage = page.locator('.app-content:has(> .session-workspace[data-presentation="embedded"])');
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    const filesBrowser = page.getByRole("region", { name: "File browser", exact: true });
    await filesBrowser.waitFor();
    await nativeWindow.evaluate((window) => window.setSize(2000, 950));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 2000);
    await assertSessionWidth(page, filesBrowser, "embedded Files at 2000px");
    await page.getByRole("tab", { name: "Execution", exact: true }).click();
    const execution = page.getByRole("region", { name: "Execution operations", exact: true });
    await execution.waitFor();
    await assertSessionWidth(page, execution, "embedded Execution at 2000px");
    await page.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-wide.png") });
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await filesBrowser.waitFor();
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 1440);
    const desktopFilesBottomGap = await bottomGap(sessionPage, filesBrowser);
    await nativeWindow.evaluate((window) => window.setSize(1024, 768));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 1024);
    const compactFilesBottomGap = await bottomGap(sessionPage, filesBrowser);
    await nativeWindow.evaluate((window) => window.setSize(1440, 950));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 1440);
    await page.getByRole("tab", { name: "Shell", exact: true }).click();

    const shellPanel = page.getByRole("region", { name: "Managed Shells", exact: true });
    const inventory = shellPanel.getByRole("complementary", { name: "Managed shell inventory", exact: true });
    const terminalSurface = shellPanel.locator("[data-terminal-surface]");
    await shellPanel.waitFor();
    await inventory.waitFor();
    await terminalSurface.waitFor();
    await shellPanel.getByText("No managed shells", { exact: true }).waitFor();

    await shellPanel.getByRole("button", { name: "New shell", exact: true }).first().click();
    const terminal = shellPanel.getByRole("textbox", { name: "Interactive shell for m1-session", exact: true });
    await terminal.waitFor();
    await terminal.locator("canvas").waitFor();

    const firstHeight = await assertFixedShellLayout(sessionPage, shellPanel, inventory, terminalSurface, terminal, desktopFilesBottomGap, "1440×950");
    await nativeWindow.evaluate((window) => window.setSize(1024, 768));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 1024);
    const secondHeight = await assertFixedShellLayout(sessionPage, shellPanel, inventory, terminalSurface, terminal, compactFilesBottomGap, "1024×768");
    assert.ok(firstHeight - secondHeight > 50, `Managed Shells must shrink with the window; before=${firstHeight}, after=${secondHeight}`);
    await nativeWindow.evaluate((window) => window.setSize(2000, 950));
    await page.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 2000);
    await assertSessionWidth(page, shellPanel, "embedded Shell at 2000px");
    await assertFixedShellLayout(sessionPage, shellPanel, inventory, terminalSurface, terminal, desktopFilesBottomGap, "2000×950");

    const [dedicated] = await Promise.all([
      application.waitForEvent("window", { timeout: 15_000 }),
      page.getByRole("button", { name: "Pop out interaction", exact: true }).click(),
    ]);
    dedicated.setDefaultTimeout(20_000);
    dedicated.on("pageerror", (error) => rendererErrors.push(error.message));
    await dedicated.getByRole("main", { name: "Dedicated interaction window", exact: true }).waitFor();
    await dedicated.getByRole("heading", { name: "m1-session", exact: true }).waitFor();
    const dedicatedWindow = await application.browserWindow(dedicated);
    await dedicatedWindow.evaluate((window) => window.setSize(2000, 950));
    await dedicated.waitForFunction((expectedWidth) => (
      globalThis as unknown as { innerWidth: number }
    ).innerWidth === expectedWidth, 2000);
    for (const { tab, region } of [
      { tab: "Files", region: "File browser" },
      { tab: "Execution", region: "Execution operations" },
      { tab: "Shell", region: "Managed Shells" },
    ]) {
      await dedicated.getByRole("tab", { name: tab, exact: true }).click();
      const panel = dedicated.getByRole("region", { name: region, exact: true });
      await panel.waitFor();
      await assertSessionWidth(dedicated, panel, `dedicated ${tab} at 2000px`);
      if (tab === "Execution") {
        await dedicated.screenshot({ animations: "disabled", path: join(screenshotDirectory, "session-dedicated-wide.png") });
      }
    }
    await dedicated.close();
    assert.deepEqual(rendererErrors, []);
  } finally {
    await application?.close().catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function assertSessionWidth(page: Page, panel: Locator, label: string): Promise<void> {
  const layout = await page.locator(".session-workspace").evaluate((workspace) => {
    const view = workspace.ownerDocument.defaultView!;
    const measure = (element: typeof workspace) => {
      const bounds = element.getBoundingClientRect();
      const style = view.getComputedStyle(element);
      return {
        left: bounds.left,
        width: bounds.width,
        contentLeft: bounds.left + element.clientLeft + Number.parseFloat(style.paddingLeft),
        contentWidth: element.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight),
      };
    };
    const viewport = workspace.parentElement!;
    const content = workspace.querySelector(".session-workspace__panel-content, .session-workspace__viewport")!;
    return {
      viewport: measure(viewport),
      workspace: measure(workspace),
      frames: [
        ".session-workspace__trail-frame",
        ".session-workspace__summary-frame",
        ".session-workspace__tabs-frame",
      ].map((selector) => ({ selector, ...measure(workspace.querySelector(selector)!) })),
      content: measure(content),
      tabPanel: measure(workspace.querySelector(`.session-workspace__${workspace.getAttribute("data-selected-panel")}-panel`)!),
    };
  });
  assert.ok(layout.viewport.contentWidth > 1440, `${label} must exercise a viewport wider than the previous cap`);
  assert.ok(Math.abs(layout.workspace.left - layout.viewport.contentLeft) <= 1 &&
    Math.abs(layout.workspace.width - layout.viewport.contentWidth) <= 1,
  `${label} workspace must fill its available width: ${JSON.stringify(layout)}`);
  for (const frame of [...layout.frames, { selector: "session panel content", ...layout.content }]) {
    assert.ok(Math.abs(frame.left - layout.workspace.contentLeft) <= 1 &&
      Math.abs(frame.width - layout.workspace.contentWidth) <= 1,
    `${label} ${frame.selector} must fill the workspace without side gaps: ${JSON.stringify(frame)}`);
  }
  assert.ok(Math.abs(layout.tabPanel.left - layout.content.contentLeft) <= 1 &&
    Math.abs(layout.tabPanel.width - layout.content.contentWidth) <= 1,
  `${label} tab panel must fill the content width: ${JSON.stringify(layout.tabPanel)}`);
  const bounds = await panel.boundingBox();
  assert.ok(bounds, `${label} panel must be measurable`);
  assert.ok(Math.abs(bounds.x - layout.tabPanel.contentLeft) <= 1 &&
    Math.abs(bounds.width - layout.tabPanel.contentWidth) <= 1,
  `${label} panel must fill the tab panel width inside its padding: ${JSON.stringify({ bounds, tabPanel: layout.tabPanel })}`);
}

async function assertFixedShellLayout(
  sessionPage: Locator,
  shellPanel: Locator,
  inventory: Locator,
  terminalSurface: Locator,
  terminal: Locator,
  filesBottomGap: number,
  size: string,
): Promise<number> {
  const viewport = await sessionPage.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const bounds = element.getBoundingClientRect();
    return {
      scrollRange: element.scrollHeight - element.clientHeight,
      scrollTop: element.scrollTop,
      bottom: bounds.bottom,
      right: bounds.right,
    };
  });
  const [panelBounds, inventoryBounds, terminalBounds, terminalHostBounds] = await Promise.all([
    shellPanel.boundingBox(),
    inventory.boundingBox(),
    terminalSurface.boundingBox(),
    terminal.boundingBox(),
  ]);
  assert.ok(panelBounds && inventoryBounds && terminalBounds && terminalHostBounds, `Shell layout must be measurable at ${size}`);
  assert.ok(viewport.scrollRange <= 1 && viewport.scrollTop <= 1, `Shell must not scroll the session page at ${size}`);

  const panelBottom = panelBounds.y + panelBounds.height;
  const bottomGap = viewport.bottom - panelBottom;
  assert.ok(filesBottomGap >= -1 && filesBottomGap <= 20, `Files must fill the session viewport at ${size}; gap=${filesBottomGap}`);
  assert.ok(Math.abs(bottomGap - filesBottomGap) <= 1, `Managed Shells must match the Files viewport fill at ${size}; shell gap=${bottomGap}, files gap=${filesBottomGap}`);
  assert.ok(panelBounds.x + panelBounds.width <= viewport.right + 1, `Managed Shells must fit horizontally at ${size}`);
  assertContained(inventoryBounds, panelBounds, `Shell inventory at ${size}`);
  assertContained(terminalBounds, panelBounds, `Terminal surface at ${size}`);
  assertContained(terminalHostBounds, terminalBounds, `Terminal host at ${size}`);
  return panelBounds.height;
}

async function bottomGap(viewport: Locator, section: Locator): Promise<number> {
  const [viewportBounds, sectionBounds] = await Promise.all([viewport.boundingBox(), section.boundingBox()]);
  assert.ok(viewportBounds && sectionBounds, "Session panel geometry must be measurable");
  return viewportBounds.y + viewportBounds.height - sectionBounds.y - sectionBounds.height;
}

function assertContained(
  child: { x: number; y: number; width: number; height: number },
  parent: { x: number; y: number; width: number; height: number },
  label: string,
): void {
  assert.ok(child.width > 0 && child.height > 0, `${label} must have positive size`);
  assert.ok(child.x >= parent.x - 1 && child.y >= parent.y - 1, `${label} must start inside its parent`);
  assert.ok(child.x + child.width <= parent.x + parent.width + 1, `${label} must fit horizontally; child=${JSON.stringify(child)}, parent=${JSON.stringify(parent)}`);
  assert.ok(child.y + child.height <= parent.y + parent.height + 1, `${label} must fit vertically; child=${JSON.stringify(child)}, parent=${JSON.stringify(parent)}`);
}

function fakeOperatorConfig(): string {
  return JSON.stringify({
    operator: "shell-layout-e2e-operator",
    lhost: "127.0.0.1",
    lport: 31337,
    ca_certificate: "FAKE_SHELL_CA_DO_NOT_RENDER",
    certificate: "FAKE_SHELL_CERT_DO_NOT_RENDER",
    private_key: "FAKE_SHELL_KEY_DO_NOT_RENDER",
    token: "FAKE_TOKEN_M0_DO_NOT_RENDER",
  });
}
