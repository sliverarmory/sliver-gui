import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeagleAnalysisDiagnostics } from "../../../shared/beagle-diagnostics";
import { BeagleAnalysisWarnings } from "./BeagleAnalysisWarnings";

const diagnostics: BeagleAnalysisDiagnostics = { version: 1, errors: [], localGroupAmbiguities: [
  { computer: "computer", suffix: "-544", relationshipKind: "AdminTo", selectedGroup: "computer-544", candidateGroups: [
    { objectid: "computer-544", directMembers: ["selected-member"] }, { objectid: "builtin-544", directMembers: ["other-member"] },
  ] },
] };
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterAll(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "getAnimations"); });
afterEach(cleanup);

describe("BeagleAnalysisWarnings", () => {
  it("distinguishes an unchecked project from a valid report with no choices", () => {
    const { rerender } = render(<BeagleAnalysisWarnings diagnostics={undefined} onInspectObject={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Run Analyze to check this project");
    rerender(<BeagleAnalysisWarnings diagnostics={{ version: 1, errors: [], localGroupAmbiguities: [] }} onInspectObject={vi.fn()} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("explains native selection and the CE boundary, shows separate memberships and inspects objects", async () => {
    const inspect = vi.fn();
    render(<BeagleAnalysisWarnings diagnostics={diagnostics} onInspectObject={inspect} />);
    const region = screen.getByRole("region", { name: "Analysis diagnostics" });
    expect(region).toHaveTextContent("BloodHound CE may select a different candidate");
    expect(region).toHaveTextContent("Candidate memberships are not combined");
    await userEvent.click(screen.getByRole("button", { name: "AdminTo on computer" }));
    expect(await screen.findByText("selected-member")).toBeVisible();
    expect(screen.getByText("other-member")).toBeVisible();
    expect(screen.getByText("Selected by Beagle")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Inspect affected computer" }));
    await userEvent.click(screen.getByRole("button", { name: "Inspect group computer-544" }));
    await userEvent.click(screen.getByRole("button", { name: "Inspect group builtin-544" }));
    expect(inspect.mock.calls).toEqual([["computer"], ["computer-544"], ["builtin-544"]]);
  });

  it("keeps validation warnings visible alongside valid choices and disables object actions while busy", async () => {
    const inspect = vi.fn();
    render(<BeagleAnalysisWarnings diagnostics={{ ...diagnostics, errors: ["Some choices were omitted."] }} onInspectObject={inspect} disabled />);
    expect(screen.getByRole("alert")).toHaveTextContent("Analysis diagnostics are incomplete");
    expect(screen.getByRole("alert")).toHaveTextContent("Some choices were omitted.");
    await userEvent.click(screen.getByRole("button", { name: "AdminTo on computer" }));
    for (const button of within(screen.getByRole("region", { name: "Analysis diagnostics" })).getAllByRole("button", { name: /Inspect/ })) {
      expect(button).toBeDisabled();
    }
    expect(inspect).not.toHaveBeenCalled();
  });
});
