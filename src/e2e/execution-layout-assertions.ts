import assert from "node:assert/strict";

import type { Locator } from "playwright-core";

/** Verify the composer keeps its heading and primary actions above a fading scrollport. */
export async function assertExecutionComposerScrollLayout(
  composer: Locator,
  headingName: string,
  contentName: string,
  actionNames: readonly string[],
): Promise<void> {
  const heading = composer.getByRole("heading", { name: headingName, exact: true });
  const content = composer.getByRole("region", { name: contentName, exact: true });
  assert.equal(await content.count(), 1, `${contentName} must have one scrollport`);
  assert.equal(await content.getAttribute("data-slot"), "scroll-shadow");
  assert.equal(await content.getAttribute("data-orientation"), "vertical");
  assert.equal(await content.getAttribute("tabindex"), "0");
  assert.equal(await content.getByRole("heading", { name: headingName, exact: true }).count(), 0,
    `${headingName} must sit outside the scrollport`);

  const actions = actionNames.map((name) => composer.getByRole("button", { name, exact: true }));
  for (let index = 0; index < actionNames.length; index += 1) {
    const name = actionNames[index]!;
    assert.equal(await actions[index]!.count(), 1, `${name} must appear in the composer header`);
    assert.equal(await content.getByRole("button", { name, exact: true }).count(), 0,
      `${name} must sit outside the scrollport`);
  }

  // Constrain the form body so even a short fixture exercises both fade edges.
  const originalStyle = await content.evaluate((element) => {
    const original = { height: element.style.height, flex: element.style.flex };
    element.style.height = "96px";
    element.style.flex = "none";
    element.dispatchEvent(new Event("scroll"));
    return original;
  });
  try {
    await composer.locator('[data-slot="scroll-shadow"][data-bottom-scroll="true"]').waitFor();
    const topState = await content.evaluate((element) => ({
      overflow: element.scrollHeight > element.clientHeight,
      mask: element.ownerDocument.defaultView!.getComputedStyle(element).maskImage,
    }));
    assert.equal(topState.overflow, true, `${contentName} must scroll when constrained`);
    assert.match(topState.mask, /linear-gradient/u, `${contentName} must fade at the bottom`);

    const headingBounds = await heading.boundingBox();
    const actionBounds = await Promise.all(actions.map((action) => action.boundingBox()));
    assert.ok(headingBounds && actionBounds.every(Boolean), "Composer header must be measurable");
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await composer.locator('[data-slot="scroll-shadow"][data-top-scroll="true"]').waitFor();
    const bottomMask = await content.evaluate((element) =>
      element.ownerDocument.defaultView!.getComputedStyle(element).maskImage);
    assert.match(bottomMask, /linear-gradient/u, `${contentName} must fade at the top`);
    assert.equal(await heading.isVisible(), true, `${headingName} must stay visible while the form scrolls`);
    const scrolledHeadingBounds = await heading.boundingBox();
    assert.ok(scrolledHeadingBounds && Math.abs(scrolledHeadingBounds.y - headingBounds.y) <= 1,
      `${headingName} must stay fixed while the form scrolls`);
    for (let index = 0; index < actions.length; index += 1) {
      const bounds = await actions[index]!.boundingBox();
      assert.ok(bounds && Math.abs(bounds.y - actionBounds[index]!.y) <= 1,
        `${actionNames[index]} must stay fixed while the form scrolls`);
    }
  } finally {
    await content.evaluate((element, original) => {
      element.style.height = original.height;
      element.style.flex = original.flex;
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    }, originalStyle);
  }
}

/** Check the shared Process and BOF output layout in an actual Electron renderer. */
export async function assertExecutionOutputLayout(
  workspace: Locator,
  history: Locator,
  terminal: Locator,
  label: string,
): Promise<void> {
  const [workspaceBounds, railBounds, terminalBounds, terminalHostBounds] = await Promise.all([
    workspace.boundingBox(),
    workspace.locator("aside").first().boundingBox(),
    terminal.locator("xpath=..").boundingBox(),
    terminal.boundingBox(),
  ]);
  assert.ok(workspaceBounds && railBounds && terminalBounds && terminalHostBounds,
    `${label} layout must be measurable`);

  const rightGap = workspaceBounds.x + workspaceBounds.width - terminalBounds.x - terminalBounds.width;
  const bottomGap = workspaceBounds.y + workspaceBounds.height - terminalBounds.y - terminalBounds.height;
  const leftGap = terminalBounds.x - railBounds.x - railBounds.width;
  const topGap = terminalBounds.y - workspaceBounds.y;
  assert.ok(rightGap >= 0 && rightGap <= 2,
    `${label} terminal border must reach the workspace right border; gap=${rightGap}`);
  assert.ok(bottomGap >= 0 && bottomGap <= 2,
    `${label} terminal must reach the workspace bottom border; gap=${bottomGap}`);
  assert.ok(leftGap >= 12,
    `${label} terminal must retain its left inset from the history rail; inset=${leftGap}`);
  assert.ok(topGap >= 24,
    `${label} terminal must retain its top inset below the output controls; inset=${topGap}`);
  assert.ok(terminalHostBounds.x >= terminalBounds.x + 1 &&
    terminalHostBounds.y >= terminalBounds.y + 1 &&
    terminalHostBounds.x + terminalHostBounds.width <= terminalBounds.x + terminalBounds.width - 1 &&
    terminalHostBounds.y + terminalHostBounds.height <= terminalBounds.y + terminalBounds.height - 1,
  `${label} terminal content must remain inside its visible border`);

  const shadow = history.locator('[data-slot="scroll-shadow"]');
  assert.equal(await shadow.count(), 1, `${label} history must use one HeroUI ScrollShadow`);
  assert.equal(await shadow.getAttribute("data-orientation"), "vertical");
  const newExecution = history.getByRole("row", { name: "New Execution", exact: true });
  const historyRows = shadow.getByRole("row");
  assert.equal(await newExecution.count(), 1, `${label} must keep New Execution in the history rail`);
  assert.equal(await shadow.getByRole("row", { name: "New Execution", exact: true }).count(), 0,
    `${label} must keep New Execution outside the fading history scrollport`);
  assert.ok(await historyRows.count() >= 1, `${label} must have a history entry to check`);
  assert.equal(await history.getByRole("row").count(), await historyRows.count() + 1,
    `${label} execution history rows must all be inside the scrollport`);

  const [newExecutionBounds, firstHistoryBounds, shadowBounds] = await Promise.all([
    newExecution.boundingBox(), historyRows.first().boundingBox(), shadow.boundingBox(),
  ]);
  assert.ok(newExecutionBounds && firstHistoryBounds && shadowBounds,
    `${label} fixed and scrolling history rows must be measurable`);
  const newExecutionBottom = newExecutionBounds.y + newExecutionBounds.height;
  const historySpacing = firstHistoryBounds.y - newExecutionBottom;
  assert.ok(newExecutionBottom <= shadowBounds.y + 2,
    `${label} New Execution must sit above the scrollport`);
  assert.ok(historySpacing >= -1 && historySpacing <= 12,
    `${label} history must start close below New Execution; gap=${historySpacing}`);

  // The fake histories are intentionally short. Constrain only the history
  // scrollport so one entry exercises both ends of its overflow fade.
  const originalMaxHeight = await shadow.evaluate((element) => {
    const original = element.style.maxHeight;
    element.style.maxHeight = "32px";
    return original;
  });
  try {
    await history.locator('[data-slot="scroll-shadow"][data-bottom-scroll="true"]').waitFor();
    const topState = await shadow.evaluate((element) => ({
      overflow: element.scrollHeight > element.clientHeight,
      mask: element.ownerDocument.defaultView!.getComputedStyle(element).maskImage,
    }));
    assert.equal(topState.overflow, true, `${label} history should overflow the constrained scrollport`);
    assert.match(topState.mask, /linear-gradient/u, `${label} history should fade at the bottom`);

    await shadow.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll"));
    });
    await history.locator('[data-slot="scroll-shadow"][data-top-scroll="true"]').waitFor();
    const bottomMask = await shadow.evaluate((element) =>
      element.ownerDocument.defaultView!.getComputedStyle(element).maskImage);
    assert.match(bottomMask, /linear-gradient/u, `${label} history should fade at the top`);
    assert.equal(await newExecution.isVisible(), true,
      `${label} New Execution must remain visible while the history scrolls`);
    const scrolledNewExecutionBounds = await newExecution.boundingBox();
    assert.ok(scrolledNewExecutionBounds && Math.abs(scrolledNewExecutionBounds.y - newExecutionBounds.y) <= 1,
      `${label} New Execution must remain fixed while the history scrolls`);
  } finally {
    await shadow.evaluate((element, value) => {
      element.style.maxHeight = value;
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    }, originalMaxHeight);
  }
}

interface TerminalCanvasGeometry {
  frameHeight: number;
  hostHeight: number;
  canvasHeight: number;
  frameToHostBottomGap: number;
  hostToCanvasBottomGap: number;
}

/** Ghostty paints its text viewport and scrollbar in the same canvas. */
export async function assertExecutionTerminalCanvasTracksResize(
  terminal: Locator,
  label: string,
): Promise<void> {
  const initial = await waitForTerminalCanvasGeometry(terminal, canvasFillsHost, `${label} initial canvas to fit`);
  const originalStyle = await terminal.evaluate((host, height) => {
    const frame = host.parentElement!;
    const original = { height: frame.style.height, flex: frame.style.flex };
    frame.style.flex = "none";
    frame.style.height = `${height}px`;
    return original;
  }, initial.frameHeight);
  try {
    // Resize again in the microtask that observes the first canvas fit. This
    // exercises the addon guard that used to discard a resize within 50 ms.
    await resizeFrameDuringFirstFit(terminal, initial.frameHeight + 80, initial.frameHeight + 160);
    const grown = await waitForTerminalCanvasGeometry(terminal,
      (geometry) => geometry.frameHeight >= initial.frameHeight + 159 &&
        geometry.canvasHeight >= initial.canvasHeight + 100 && canvasFillsHost(geometry),
      `${label} canvas to fit after consecutive pane growth`);
    assertCanvasFillsHost(grown, label);

    await resizeFrameDuringFirstFit(terminal, initial.frameHeight + 80, initial.frameHeight);
    const shrunk = await waitForTerminalCanvasGeometry(terminal,
      (geometry) => Math.abs(geometry.frameHeight - initial.frameHeight) <= 1 &&
        geometry.canvasHeight <= grown.canvasHeight - 100 && canvasFillsHost(geometry),
      `${label} canvas to fit after consecutive pane shrink`);
    assertCanvasFillsHost(shrunk, label);
  } finally {
    await terminal.evaluate((host, original) => {
      const frame = host.parentElement!;
      frame.style.height = original.height;
      frame.style.flex = original.flex;
    }, originalStyle);
  }
}

async function resizeFrameDuringFirstFit(terminal: Locator, firstHeight: number, nextHeight: number): Promise<void> {
  await terminal.evaluate((host, heights) => new Promise<void>((resolve, reject) => {
    const frame = host.parentElement!;
    const canvas = host.querySelector("canvas")!;
    const initialCanvasHeight = canvas.getBoundingClientRect().height;
    const BrowserMutationObserver = (host.ownerDocument.defaultView as unknown as {
      MutationObserver: new (callback: () => void) => {
        disconnect: () => void;
        observe: (target: unknown, options: { attributes: boolean; attributeFilter: string[] }) => void;
      };
    }).MutationObserver;
    const observer = new BrowserMutationObserver(() => {
      if (Math.abs(canvas.getBoundingClientRect().height - initialCanvasHeight) < 40) return;
      observer.disconnect();
      clearTimeout(timer);
      frame.style.height = `${heights.nextHeight}px`;
      resolve();
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Ghostty canvas did not fit the first pane height ${heights.firstHeight}`));
    }, 5_000);
    observer.observe(canvas, { attributes: true, attributeFilter: ["height", "style"] });
    frame.style.height = `${heights.firstHeight}px`;
  }), { firstHeight, nextHeight });
}

async function waitForTerminalCanvasGeometry(
  terminal: Locator,
  accepts: (geometry: TerminalCanvasGeometry) => boolean,
  description: string,
): Promise<TerminalCanvasGeometry> {
  const deadline = Date.now() + 10_000;
  let geometry: TerminalCanvasGeometry | null = null;
  do {
    geometry = await terminal.evaluate((host): TerminalCanvasGeometry | null => {
      const frame = host.parentElement;
      const canvas = host.querySelector("canvas");
      if (!frame || !canvas) return null;
      const frameBounds = frame.getBoundingClientRect();
      const hostBounds = host.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      return {
        frameHeight: frameBounds.height,
        hostHeight: hostBounds.height,
        canvasHeight: canvasBounds.height,
        frameToHostBottomGap: frameBounds.bottom - hostBounds.bottom,
        hostToCanvasBottomGap: hostBounds.bottom - canvasBounds.bottom,
      };
    });
    if (geometry && accepts(geometry)) return geometry;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${description}; last geometry=${JSON.stringify(geometry)}`);
}

function canvasFillsHost(geometry: TerminalCanvasGeometry): boolean {
  // Ghostty fits whole character rows, leaving at most one partial row.
  return Math.abs(geometry.frameHeight - geometry.hostHeight) <= 3 &&
    geometry.frameToHostBottomGap >= 0 && geometry.frameToHostBottomGap <= 3 &&
    geometry.hostToCanvasBottomGap >= -1 && geometry.hostToCanvasBottomGap <= 32;
}

function assertCanvasFillsHost(geometry: TerminalCanvasGeometry, label: string): void {
  assert.ok(canvasFillsHost(geometry),
    `${label} Ghostty canvas must fill its host within one character row; geometry=${JSON.stringify(geometry)}`);
}
