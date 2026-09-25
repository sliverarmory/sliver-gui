import assert from "node:assert/strict";

import type { Locator } from "playwright-core";

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
