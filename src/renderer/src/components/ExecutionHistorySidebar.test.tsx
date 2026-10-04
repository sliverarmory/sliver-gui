import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { faCircleCheck, faCopy } from "@fortawesome/free-solid-svg-icons";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";

import {
  APPLICATION_CONTEXT_MENU_VERSION,
  type ApplicationContextMenuAPI,
  type ApplicationContextMenuRequest,
} from "../../../shared/application-context-menu-contracts";
import { ApplicationContextMenu } from "./ApplicationContextMenu";
import { ExecutionHistorySidebar } from "./ExecutionHistorySidebar";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
});

afterEach(cleanup);

it("keeps history rows selectable and scopes right-click actions to the clicked execution", async () => {
  const onSelect = vi.fn();
  const copyFirst = vi.fn();
  const copySecond = vi.fn();
  let menuListener: ((request: ApplicationContextMenuRequest) => void) | undefined;
  const contextMenuAPI: ApplicationContextMenuAPI = {
    onMenuRequested: vi.fn((listener) => {
      menuListener = listener;
      return vi.fn();
    }),
    executeAction: vi.fn(async () => true),
    setOpen: vi.fn(async () => true),
  };

  render(
    <ApplicationContextMenu api={contextMenuAPI}>
      <ExecutionHistorySidebar
        executionKeyPrefix="execution:"
        items={[
          {
            id: "first",
            title: "first.exe",
            startedAt: "2026-09-25T12:00:00.000Z",
            stateLabel: "Completed",
            statusIcon: faCircleCheck,
            statusColor: "text-success",
            contextActions: [{ id: "copy-first", label: "Copy first output", icon: faCopy, onAction: copyFirst }],
          },
          {
            id: "second",
            title: "second.exe",
            startedAt: "2026-09-25T12:01:00.000Z",
            stateLabel: "Completed",
            statusIcon: faCircleCheck,
            statusColor: "text-success",
            contextActions: [{ id: "copy-second", label: "Copy second output", icon: faCopy, onAction: copySecond }],
          },
        ]}
        label="Execution history"
        newExecutionKey="new-execution"
        selectedId={undefined}
        onClearAll={vi.fn()}
        onSelect={onSelect}
      />
    </ApplicationContextMenu>,
  );

  const first = screen.getByText("first.exe");
  const second = screen.getByText("second.exe");
  fireEvent.click(first);
  expect(onSelect).toHaveBeenCalledWith("first");

  fireEvent.contextMenu(second, { clientX: 40, clientY: 24 });
  expect(menuListener).toBeDefined();
  act(() => menuListener?.({
    v: APPLICATION_CONTEXT_MENU_VERSION,
    requestId: "10000000-0000-4000-8000-000000000001",
    x: 40,
    y: 24,
    items: [{
      type: "action",
      actionId: "20000000-0000-4000-8000-000000000001",
      kind: "inspect",
      label: "Inspect Element",
      enabled: true,
    }],
  }));

  const menu = await screen.findByRole("menu", { name: "Application context menu" });
  expect(within(menu).getByRole("menuitem", { name: "Copy second output" })).toBeInTheDocument();
  expect(within(menu).queryByRole("menuitem", { name: "Copy first output" })).not.toBeInTheDocument();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy second output" }));
  await waitFor(() => expect(copySecond).toHaveBeenCalledOnce());
  expect(copyFirst).not.toHaveBeenCalled();
});
