import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";

import { attachCleanupFailure, cleanupOwnedApplication } from "./packaged-application-update-support.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const backShortcut = process.platform === "darwin" ? "Meta+[" : "Alt+ArrowLeft";
const forwardShortcut = process.platform === "darwin" ? "Meta+]" : "Alt+ArrowRight";

test("window navigation supports pointer, keyboard and palette actions without drag-region overlap", {
  timeout: 90_000,
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "sliver-gui-window-navigation-"));
  const artifacts = join(repositoryRoot, "artifacts", "window-navigation");
  await Promise.all(["saved", "managed", "client", "user-data"].map((name) => mkdir(join(root, name))));
  await mkdir(artifacts, { recursive: true });
  let application: ElectronApplication | undefined;
  let page: Page | undefined;
  let testFailed = false;
  let testFailure: unknown;
  try {
    // Empty, temporary configuration directories keep this test offline. The
    // fixture uses the production application and renderer without a server.
    application = await electron.launch({
      args: [
        "--enable-sandbox",
        join(repositoryRoot, ".e2e-dist/src/e2e/application-icon-main.js"),
        `--repository-root=${repositoryRoot}`,
        `--saved-config-directory=${join(root, "saved")}`,
        `--managed-config-directory=${join(root, "managed")}`,
        `--user-data-directory=${join(root, "user-data")}`,
        `--console-client-root-directory=${join(root, "client")}`,
      ],
      cwd: repositoryRoot,
      bypassCSP: false,
      timeout: 20_000,
    });
    const ownedProcess = application.process();
    context.signal.addEventListener("abort", () => { ownedProcess.kill("SIGKILL"); }, { once: true });
    page = await application.firstWindow();
    page.setDefaultTimeout(5_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const configurations = page.getByRole("dialog", { name: "Saved configurations" });
    await configurations.waitFor();
    await page.keyboard.press("Escape");
    await configurations.waitFor({ state: "hidden" });
    await expectView(page, "Overview");

    const navigation = page.getByRole("navigation", { name: "Window navigation" });
    const back = navigation.getByRole("button", { name: "Go back", exact: true });
    const forward = navigation.getByRole("button", { name: "Go forward", exact: true });
    await expectHistory(page, false, false);
    assert.equal(await back.getAttribute("aria-keyshortcuts"), backShortcut);
    assert.equal(await forward.getAttribute("aria-keyshortcuts"), forwardShortcut);
    await assertDragRegionsExcludeNavigation(page);
    await openPalette(page);
    await expectPaletteHistory(page, false, false);
    await closePalette(page);

    await openSettings(page);
    await expectHistory(page, true, false);

    // Native drag regions must exclude the controls throughout the ordinary
    // sidebar animation, not only once its final width has settled.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const label of ["Collapse sidebar", "Expand sidebar"] as const) {
      await assertSidebarAnimationExcludesNavigation(page, navigation.getByRole("button", { name: label }));
    }
    await page.emulateMedia({ reducedMotion: "reduce" });

    // Exercise the SVG and the button edges in both sidebar layouts. These
    // renderer input events verify the action handlers, not native hit testing.
    // The separate geometry assertion guards against overlapping native drag
    // rectangles; OS-level pointer testing is still needed for release QA.
    for (const collapsed of [false, true]) {
      if (collapsed) {
        await clickAt(page, navigation.getByRole("button", { name: "Collapse sidebar" }), "corner");
        await navigation.getByRole("button", { name: "Expand sidebar" }).waitFor();
        await page.locator('.app-shell[data-state="collapsed"]').waitFor();
      }
      await assertDragRegionsExcludeNavigation(page);
      for (const target of ["icon", "edge", "corner"] as const) {
        await clickAt(page, back, target);
        await expectView(page, "Overview");
        await expectHistory(page, false, true);
        await clickAt(page, forward, target);
        await expectView(page, "Settings");
        await expectHistory(page, true, false);
      }
      await page.screenshot({
        path: join(artifacts, collapsed ? "sidebar-collapsed.png" : "sidebar-expanded.png"),
        animations: "disabled",
      });
    }
    await clickAt(page, navigation.getByRole("button", { name: "Expand sidebar" }), "icon");
    await navigation.getByRole("button", { name: "Collapse sidebar" }).waitFor();
    await page.locator('.app-shell[data-state="expanded"]').waitFor();
    await assertDragRegionsExcludeNavigation(page);

    // Platform shortcuts must work repeatedly, including at either boundary.
    await back.focus();
    await page.keyboard.press(backShortcut);
    await expectView(page, "Overview");
    await expectHistory(page, false, true);
    await page.keyboard.press(backShortcut);
    await expectView(page, "Overview");
    await page.keyboard.press(forwardShortcut);
    await expectView(page, "Settings");
    await expectHistory(page, true, false);
    await page.keyboard.press(forwardShortcut);
    await expectView(page, "Settings");

    await openPalette(page);
    await expectPaletteHistory(page, true, false);
    await page.getByRole("searchbox", { name: "Search commands" }).fill("Go back");
    await page.keyboard.press(backShortcut);
    assert.equal(await page.getByRole("dialog", { name: "Command palette" }).isVisible(), true);
    // The page is aria-hidden while the modal is open, so use its visible DOM
    // heading to verify the shortcut did not navigate behind the palette.
    assert.equal(await page.locator("#settings-page-heading").isVisible(), true);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
    await expectView(page, "Overview");
    await openPalette(page);
    await expectPaletteHistory(page, false, true);
    await page.getByRole("searchbox", { name: "Search commands" }).fill("Go forward");
    await page.getByRole("menuitem", { name: /^Go forward\b/u }).click();
    await expectView(page, "Settings");

    // A real editable field, the shortcut recorder, and a modal must keep their
    // own keyboard input while application history is available.
    await page.getByRole("tab", { name: "Terminal", exact: true }).click();
    const fontSize = page.getByRole("textbox", { name: "Font size", exact: true });
    await fontSize.focus();
    await page.keyboard.press(backShortcut);
    await expectView(page, "Settings");
    assert.equal(await fontSize.evaluate((element) => element === element.ownerDocument.activeElement), true);
    await page.getByRole("tab", { name: "Keyboard Shortcuts", exact: true }).click();
    await page.getByRole("button", { name: "Change shortcut for Open command palette", exact: true }).click();
    const shortcutRecorder = page.getByRole("button", { name: "Cancel changing shortcut for Open command palette", exact: true });
    await shortcutRecorder.waitFor();
    await page.keyboard.press(backShortcut);
    await expectView(page, "Settings");
    assert.equal(await shortcutRecorder.getAttribute("aria-pressed"), "true");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Saved configurations", exact: true }).click();
    await configurations.waitFor();
    await page.keyboard.press(backShortcut);
    assert.equal(await configurations.isVisible(), true);
    assert.equal(await page.locator("#settings-page-heading").isVisible(), true);
    await page.keyboard.press("Escape");
    await configurations.waitFor({ state: "hidden" });

    // Create Overview -> Settings -> Overview, go back, then choose a fresh
    // Overview entry. This replaces the forward branch without adding a
    // duplicate when the already-current page is chosen again.
    await runPaletteCommand(page, "Overview");
    await expectView(page, "Overview");
    await back.click();
    await expectView(page, "Settings");
    await expectHistory(page, true, true);
    await runPaletteCommand(page, "Overview");
    await expectView(page, "Overview");
    await expectHistory(page, true, false);
    await runPaletteCommand(page, "Overview");
    await back.click();
    await expectView(page, "Settings");
    await back.click();
    await expectView(page, "Overview");
    await expectHistory(page, false, true);

    const calls = await application.evaluate(() => ({
      connections: globalThis.__SLIVER_GUI_E2E_STATE__.configFactoryCalls,
      methods: globalThis.__SLIVER_GUI_E2E_STATE__.methods,
      consoles: globalThis.__SLIVER_GUI_E2E_STATE__.console.spawns.length,
    }));
    assert.deepEqual(calls, { connections: 0, methods: [], consoles: 0 }, "navigation must remain offline");
  } catch (error) {
    testFailed = true;
    testFailure = error;
    await page?.screenshot({ path: join(artifacts, "failure.png"), animations: "disabled" }).catch(() => undefined);
    throw error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (application) {
      await cleanupOwnedApplication(application, "window navigation", 5_000)
        .catch((error) => cleanupFailures.push(error));
    }
    await rm(root, { recursive: true, force: true }).catch((error) => cleanupFailures.push(error));
    if (cleanupFailures.length > 0) {
      const cleanupError = new AggregateError(cleanupFailures, "Window navigation E2E cleanup failed");
      if (testFailed) {
        attachCleanupFailure(testFailure, cleanupError);
        console.error("Failed to clean window navigation E2E resources", cleanupError);
      } else {
        throw cleanupError;
      }
    }
  }
});

async function expectView(page: Page, name: "Overview" | "Settings"): Promise<void> {
  await page.getByRole("heading", { name, exact: true }).waitFor();
}

async function expectHistory(page: Page, canGoBack: boolean, canGoForward: boolean): Promise<void> {
  const navigation = page.getByRole("navigation", { name: "Window navigation" });
  await navigation.getByRole("button", { name: "Go back", exact: true, disabled: !canGoBack }).waitFor();
  await navigation.getByRole("button", { name: "Go forward", exact: true, disabled: !canGoForward }).waitFor();
}

async function expectPaletteHistory(page: Page, canGoBack: boolean, canGoForward: boolean): Promise<void> {
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const back = palette.getByRole("menuitem", { name: /^Go back\b/u, disabled: !canGoBack });
  const forward = palette.getByRole("menuitem", { name: /^Go forward\b/u, disabled: !canGoForward });
  await back.waitFor();
  await forward.waitFor();
  await back.locator("kbd").waitFor();
  await forward.locator("kbd").waitFor();
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Application menu, offline" }).click();
  const menu = page.locator('[role="menu"][aria-label="Application and current server actions"]');
  await menu.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expectView(page, "Settings");
}

async function openPalette(page: Page): Promise<void> {
  await page.getByLabel("Open command palette", { exact: true }).click();
  await page.getByRole("dialog", { name: "Command palette" }).waitFor();
}

async function closePalette(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
}

async function runPaletteCommand(page: Page, label: "Overview"): Promise<void> {
  await openPalette(page);
  await page.getByRole("searchbox", { name: "Search commands" }).fill(label);
  await page.getByRole("menuitem", { name: new RegExp(`^${label}\\b`, "u") }).click();
  await page.getByRole("dialog", { name: "Command palette" }).waitFor({ state: "hidden" });
}

async function clickAt(page: Page, button: Locator, target: "icon" | "edge" | "corner"): Promise<void> {
  const rectangle = await (target === "icon" ? button.locator("svg") : button).boundingBox();
  assert.ok(rectangle, "navigation control must have a visible pointer target");
  await page.mouse.click(
    rectangle.x + (target === "corner" ? 4 : target === "edge" ? 2 : rectangle.width / 2),
    rectangle.y + (target === "corner" ? 4 : rectangle.height / 2),
  );
}

interface NavigationDragInspection {
  readonly region: string;
  readonly overlaps: readonly unknown[];
  readonly sidebarBounds: { readonly width: number };
}

async function assertDragRegionsExcludeNavigation(page: Page): Promise<void> {
  const result = await page.evaluate<NavigationDragInspection>(inspectNavigationDragRegions);
  assertNoDragOverlap(result);
}

async function assertSidebarAnimationExcludesNavigation(page: Page, toggle: Locator): Promise<void> {
  const sampling = page.evaluate<NavigationDragInspection[]>(`(async () => {
    const frames = [];
    const start = performance.now();
    do {
      frames.push(${inspectNavigationDragRegions});
      await new Promise(requestAnimationFrame);
    } while (performance.now() - start < 500);
    return frames;
  })()`);
  await clickAt(page, toggle, "icon");
  const frames = await sampling;
  for (const frame of frames) assertNoDragOverlap(frame);
  const widths = frames.map((frame) => frame.sidebarBounds.width);
  const minimum = Math.min(...widths);
  const maximum = Math.max(...widths);
  assert.ok(
    widths.some((width) => width > minimum + 0.1 && width < maximum - 0.1),
    `ordinary-motion check must sample intermediate sidebar widths: ${JSON.stringify(widths)}`,
  );
}

function assertNoDragOverlap(result: NavigationDragInspection): void {
  assert.equal(result.region, "no-drag", "the complete toolbar must accept native pointer events");
  assert.deepEqual(
    result.overlaps,
    [],
    `native drag rectangles must not overlap the navigation toolbar: ${JSON.stringify(result)}`,
  );
}

// Electron's native drag rectangles do not respect DOM stacking. Inspect
// every visible drag rectangle, including those behind the toolbar, rather
// than treating Playwright's successful renderer click as native proof.
const inspectNavigationDragRegions = `(() => {
    const navigation = document.querySelector('.window-navigation');
    if (!navigation) throw new Error('Window navigation is missing');
    const navigationBounds = navigation.getBoundingClientRect();
    const overlaps = Array.from(document.querySelectorAll('*')).flatMap((element) => {
      const style = getComputedStyle(element);
      if (style.getPropertyValue('-webkit-app-region') !== 'drag' ||
          style.display === 'none' || style.visibility === 'hidden') return [];
      const bounds = element.getBoundingClientRect();
      const intersects = bounds.width > 0 && bounds.height > 0 &&
        bounds.left < navigationBounds.right && bounds.right > navigationBounds.left &&
        bounds.top < navigationBounds.bottom && bounds.bottom > navigationBounds.top;
      return intersects ? [{
        element: element.tagName.toLowerCase() + '.' + element.className,
        bounds: bounds.toJSON(),
        overlapWidth: Math.min(bounds.right, navigationBounds.right) - Math.max(bounds.left, navigationBounds.left),
        overlapHeight: Math.min(bounds.bottom, navigationBounds.bottom) - Math.max(bounds.top, navigationBounds.top),
      }] : [];
    });
    return {
      region: getComputedStyle(navigation).getPropertyValue('-webkit-app-region'),
      overlaps,
      navigationBounds: navigationBounds.toJSON(),
      sidebarBounds: document.querySelector('.sidebar.app-sidebar')?.getBoundingClientRect().toJSON(),
      sidebarState: document.querySelector('.app-shell')?.getAttribute('data-state'),
      dragRegion: (() => {
        const drag = document.querySelector('.app-header-drag-region');
        if (!drag) return null;
        const style = getComputedStyle(drag);
        return {
          bounds: drag.getBoundingClientRect().toJSON(),
          insetInlineStart: style.insetInlineStart,
          left: style.left,
          transition: style.transition,
        };
      })(),
    };
  })()`;
