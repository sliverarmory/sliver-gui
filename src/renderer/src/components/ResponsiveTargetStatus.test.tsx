import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResponsiveTargetStatus } from "./ResponsiveTargetStatus";

interface TestObserver {
  callback: ResizeObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

let availableWidth: number;
let badgeWidth: number;
let observers: TestObserver[];

beforeEach(() => {
  availableWidth = 120;
  badgeWidth = 72;
  observers = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.classList.contains("target-status-cell") ? availableWidth : badgeWidth;
    return new DOMRect(0, 0, width, 24);
  });
  vi.stubGlobal("ResizeObserver", class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();

    constructor(readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resizeTo(width: number): void {
  availableWidth = width;
  act(() => {
    for (const observer of observers) {
      observer.callback([], observer as unknown as ResizeObserver);
    }
  });
}

describe("ResponsiveTargetStatus", () => {
  it("shows the full status when its single-line badge fits, including at the available width", () => {
    const rendered = render(<ResponsiveTargetStatus label="On time" color="success" />);

    expect(screen.getByText("On time")).toBeVisible();
    expect(screen.queryByRole("img", { name: "On time" })).not.toBeInTheDocument();
    resizeTo(badgeWidth);
    expect(screen.getByText("On time")).toBeVisible();
    expect(screen.queryByRole("img", { name: "On time" })).not.toBeInTheDocument();

    const wrapper = rendered.container.querySelector(".target-status-cell");
    const badge = rendered.container.querySelector(".target-status-cell__badge");
    expect(wrapper).not.toBeNull();
    expect(badge).not.toBeNull();
    expect(observers.some((observer) => observer.observe.mock.calls.some(([element]) => element === wrapper))).toBe(true);
    expect(observers.some((observer) => observer.observe.mock.calls.some(([element]) => element === badge))).toBe(true);
  });

  it.each(["success", "danger", "warning", "default"] as const)("preserves the %s status color and accessible label in a narrow cell", (color) => {
    availableWidth = 48;
    render(<ResponsiveTargetStatus label="On time" color={color} />);

    const dot = screen.getByRole("img", { name: "On time" });
    expect(dot).toBeVisible();
    expect(dot).toHaveClass("target-status-cell__dot");
    expect(dot).toHaveAttribute("data-color", color);
    expect(dot).toHaveAttribute("title", "On time");
    expect(screen.getByText("On time").closest(".target-status-cell__badge")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("On time").closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("restores the readable badge when the cell widens and compacts it again when space shrinks", () => {
    availableWidth = 40;
    render(<ResponsiveTargetStatus label="On time" color="success" />);
    expect(screen.getByRole("img", { name: "On time" })).toBeVisible();

    resizeTo(120);
    expect(screen.queryByRole("img", { name: "On time" })).not.toBeInTheDocument();
    expect(screen.getByText("On time")).toBeVisible();

    resizeTo(40);
    expect(screen.getByRole("img", { name: "On time" })).toBeVisible();
    expect(screen.getByText("On time").closest(".target-status-cell__badge")).toHaveAttribute("aria-hidden", "true");
  });

  it("remeasures a changing status and keeps the compact label and color current", () => {
    availableWidth = 90;
    const rendered = render(<ResponsiveTargetStatus label="On time" color="success" />);
    expect(screen.getByText("On time")).toBeVisible();

    badgeWidth = 112;
    rendered.rerender(<ResponsiveTargetStatus label="Overdue" color="warning" />);
    const dot = screen.getByRole("img", { name: "Overdue" });
    expect(dot).toHaveAttribute("data-color", "warning");
    expect(dot).toHaveAttribute("title", "Overdue");
    expect(screen.queryByRole("img", { name: "On time" })).not.toBeInTheDocument();
    expect(screen.getByText("Overdue").closest(".target-status-cell__badge")).toHaveAttribute("aria-hidden", "true");

    badgeWidth = 48;
    rendered.rerender(<ResponsiveTargetStatus label="Lost" color="danger" />);
    expect(screen.getByText("Lost")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("disconnects its measurements when unmounted", () => {
    const rendered = render(<ResponsiveTargetStatus label="On time" color="success" />);
    expect(observers.length).toBeGreaterThan(0);
    rendered.unmount();
    for (const observer of observers) expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
