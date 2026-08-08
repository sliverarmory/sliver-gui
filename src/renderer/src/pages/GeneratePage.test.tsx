import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { disconnectedSnapshot } from "../../../shared/contracts";
import { GeneratePage, parseNumberInput } from "./GeneratePage";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  cleanup();
});

describe("GeneratePage action footer", () => {
  it("keeps the reusable profile form and build actions outside the scrolling form body", () => {
    render(<GeneratePage snapshot={disconnectedSnapshot()} />);

    const profileField = screen.getByRole("textbox", { name: "Reusable profile name" });
    const footer = profileField.closest("footer");

    expect(footer).not.toBeNull();
    if (!footer) throw new Error("Reusable profile field is not inside the Generate footer");

    expect(footer).toHaveClass("generate-page__footer");
    expect(footer).toHaveAccessibleName("Generate actions");
    expect(within(footer).getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Save profile" })).toBeInTheDocument();
    expect(within(footer).getByRole("button", { name: "Generate and save" })).toBeInTheDocument();

    const scrollingContent = footer.previousElementSibling;
    expect(scrollingContent).toHaveClass("generate-page__content");
    expect(scrollingContent).not.toContainElement(footer);
  });
});

describe("GeneratePage numeric input parsing", () => {
  it("accepts finite numbers and rejects values that would poison typed form state", () => {
    expect(parseNumberInput("31337")).toBe(31_337);
    expect(parseNumberInput("1.5")).toBe(1.5);
    expect(parseNumberInput("not-a-number")).toBeUndefined();
    expect(parseNumberInput("Infinity")).toBeUndefined();
  });
});
