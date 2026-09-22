import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "@heroui-pro/react/sidebar";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApplicationZoomAPI } from "../../../shared/application-zoom-contracts";
import { SidebarZoomControls } from "./SidebarZoomControls";

afterEach(() => {
  cleanup();
});

function zoomBridge(initialFactor: number) {
  let factor = initialFactor;
  let listener: ((value: number) => void) | undefined;
  const unsubscribe = vi.fn(() => { listener = undefined; });
  const api = {
    getFactor: vi.fn(() => factor),
    reset: vi.fn(() => { factor = 1; }),
    onChanged: vi.fn((next: (value: number) => void) => {
      listener = next;
      return unsubscribe;
    }),
  } satisfies ApplicationZoomAPI;
  return {
    api,
    unsubscribe,
    emit: (value: number) => {
      factor = value;
      act(() => listener?.(value));
    },
  };
}

describe("SidebarZoomControls", () => {
  it("reads the window zoom, follows external changes, and unsubscribes when unmounted", () => {
    const bridge = zoomBridge(1.25);
    const rendered = render(<Sidebar.Provider collapsible="icon" open><SidebarZoomControls api={bridge.api} /></Sidebar.Provider>);
    const controls = screen.getByRole("group", { name: "Window zoom" });
    expect(within(controls).getByText("125%")).toBeVisible();
    expect(bridge.api.getFactor).toHaveBeenCalled();
    expect(bridge.api.onChanged).toHaveBeenCalledExactlyOnceWith(expect.any(Function));

    bridge.emit(0.9);
    expect(within(controls).getByText("90%")).toBeVisible();
    bridge.emit(1.234);
    expect(within(controls).getByText("123%")).toBeVisible();
    expect(bridge.api.reset).not.toHaveBeenCalled();
    rendered.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([true, false])("keeps the percentage and reset available with sidebar open=%s", async (open) => {
    const user = userEvent.setup();
    const bridge = zoomBridge(0.9);
    render(<Sidebar.Provider collapsible="icon" open={open}><SidebarZoomControls api={bridge.api} /></Sidebar.Provider>);
    const controls = screen.getByRole("group", { name: "Window zoom" });
    expect(within(controls).getByText("90%")).toBeVisible();
    const reset = within(controls).getByRole("button", { name: "Reset zoom" });
    expect(reset).toBeEnabled();
    await user.click(reset);
    expect(bridge.api.reset).toHaveBeenCalledExactlyOnceWith();
    expect(within(controls).getByText("100%")).toBeVisible();
    expect(reset).toBeDisabled();
    await user.click(reset);
    expect(bridge.api.reset).toHaveBeenCalledOnce();

    bridge.emit(1.25);
    expect(within(controls).getByText("125%")).toBeVisible();
    expect(reset).toBeEnabled();
  });

  it("omits zoom controls when no application zoom bridge is available", () => {
    render(<Sidebar.Provider collapsible="icon" open><SidebarZoomControls /></Sidebar.Provider>);
    expect(screen.queryByRole("group", { name: "Window zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();
  });
});
