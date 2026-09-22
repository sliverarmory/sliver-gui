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

  it.each([true, false])("shows the percentage and reset only away from 100% with sidebar open=%s", async (open) => {
    const user = userEvent.setup();
    const bridge = zoomBridge(1);
    render(<Sidebar.Provider collapsible="icon" open={open}><SidebarZoomControls api={bridge.api} /></Sidebar.Provider>);
    expect(screen.queryByRole("group", { name: "Window zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();

    bridge.emit(0.9);
    const controls = screen.getByRole("group", { name: "Window zoom" });
    expect(within(controls).getByText("90%")).toBeVisible();
    const reset = within(controls).getByRole("button", { name: "Reset zoom" });
    expect(reset).toBeEnabled();
    await user.click(reset);
    expect(bridge.api.reset).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole("group", { name: "Window zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();
    expect(screen.queryByText("100%")).not.toBeInTheDocument();

    bridge.emit(1.25);
    expect(screen.getByText("125%")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reset zoom" })).toBeEnabled();

    bridge.emit(1);
    expect(screen.queryByRole("group", { name: "Window zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();
    expect(bridge.api.reset).toHaveBeenCalledOnce();
  });

  it("omits zoom controls when no application zoom bridge is available", () => {
    render(<Sidebar.Provider collapsible="icon" open><SidebarZoomControls /></Sidebar.Provider>);
    expect(screen.queryByRole("group", { name: "Window zoom" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset zoom" })).not.toBeInTheDocument();
  });
});
