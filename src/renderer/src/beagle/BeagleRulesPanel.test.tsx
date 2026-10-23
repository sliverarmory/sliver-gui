import { cleanup, fireEvent, render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, toast } from "@heroui/react";
import { useState, type ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeagleMutationResult } from "../../../shared/beagle-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { parseBeagleRuleConfiguration, type BeagleRuleConfiguration, type BeagleRulePreview } from "../../../shared/beagle-rules";
import { BeagleRulesPanel, type BeagleRulesDraft } from "./BeagleRulesPanel";

const configuration = parseBeagleRuleConfiguration({ groups: [{ label: "Tag_Tier_Zero", seeds: [{ type: "objectid", value: "group" }], enabled: false, priority: 7, expansion: "children", tier: true, exclusions: ["excluded"] }] });
const mutation: BeagleMutationResult = { state: { runtime: { available: true, version: "0.1.0", source: "local" }, projects: [], selectedProjectId: "project", stats: null }, report: {} };
const preview: BeagleRulePreview = { selected: { Tag_Tier_Zero: ["user"] }, counts: { Tag_Tier_Zero: 101 }, missingObjectids: ["missing"], missingTotal: 1, truncated: true };
function api() {
  return {
    getRules: vi.fn(async (): Promise<OperationResult<BeagleRuleConfiguration>> => ({ ok: true, value: configuration })),
    previewRules: vi.fn(async (): Promise<OperationResult<BeagleRulePreview>> => ({ ok: true, value: preview })),
    applyRules: vi.fn(async (): Promise<OperationResult<BeagleMutationResult>> => ({ ok: true, value: mutation })),
  };
}
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterAll(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "getAnimations"); });
afterEach(() => { cleanup(); toast.clear(); });
function render(ui: ReactNode) {
  return renderComponent(ui, { wrapper: ({ children }) => <>{children}<Toast.Provider placement="bottom" maxVisibleToasts={4} /></> });
}

describe("BeagleRulesPanel", () => {
  it("loads saved enablement and priority, edits multiline selectors, previews without applying and invalidates edited previews", async () => {
    const bridge = api(); const inspect = vi.fn(); const applied = vi.fn();
    render(<BeagleRulesPanel api={bridge} projectId="project" labels={[]} onApplied={applied} onInspectObject={inspect} />);
    expect(await screen.findByRole("checkbox", { name: "Enable rule" })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Priority" })).toHaveValue(7);
    await userEvent.click(screen.getByRole("checkbox", { name: "Enable rule" }));
    const selectors = screen.getByRole("textbox", { name: "Object ID selectors (one per line)" });
    await userEvent.clear(selectors); await userEvent.type(selectors, "first{enter}second{enter}");
    await userEvent.click(screen.getByRole("button", { name: "Preview all rules" }));
    expect(await screen.findByLabelText("Rule preview")).toHaveTextContent("Tag_Tier_Zero: 101 objects");
    expect(screen.getByLabelText("Rule preview")).toHaveTextContent("Counts are complete");
    expect(screen.getByRole("alert")).toHaveTextContent("1 selector object IDs were not found");
    expect(bridge.previewRules).toHaveBeenCalledWith({ configuration: { groups: [{ ...configuration.groups[0], enabled: true, seeds: [{ type: "objectid", value: "first" }, { type: "objectid", value: "second" }] }] } });
    expect(bridge.applyRules).not.toHaveBeenCalled(); expect(applied).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "user" })); expect(inspect).toHaveBeenCalledWith("user");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), { target: { value: "3" } });
    expect(screen.queryByLabelText("Rule preview")).not.toBeInTheDocument();
  });

  it("restores unsaved selectors, selected label and preview after inspecting an object unmounts the editor", async () => {
    const bridge = api();
    function Owner() {
      const [draft, setDraft] = useState<BeagleRulesDraft>();
      const [open, setOpen] = useState(true);
      return <><button onClick={() => setOpen(true)}>Reopen rules</button>{open ? <BeagleRulesPanel api={bridge} projectId="project" labels={["Tag_Observed"]} draft={draft} onDraftChange={setDraft}
        onApplied={vi.fn()} onInspectObject={() => setOpen(false)} /> : null}</>;
    }
    render(<Owner />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    fireEvent.change(screen.getByRole("textbox", { name: "Object ID selectors (one per line)" }), { target: { value: "unsaved-first\nunsaved-second" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Rule label" }), "Tag_Observed");
    await userEvent.click(screen.getByRole("button", { name: "Add rule for Tag_Observed" }));
    await userEvent.click(screen.getByRole("button", { name: "Preview all rules" }));
    await screen.findByLabelText("Rule preview");
    await userEvent.click(screen.getByRole("button", { name: "user" }));
    expect(screen.queryByRole("region", { name: "Label rules" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reopen rules" }));
    expect(screen.getByRole("combobox", { name: "Rule label" })).toHaveValue("Tag_Observed");
    expect(screen.getByLabelText("Rule preview")).toHaveTextContent("Tag_Tier_Zero: 101 objects");
    expect(screen.getByRole("status")).toHaveTextContent("Preview only");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Rule label" }), "Tag_Tier_Zero");
    expect(screen.getByRole("textbox", { name: "Object ID selectors (one per line)" })).toHaveValue("unsaved-first\nunsaved-second");
    expect(bridge.getRules).toHaveBeenCalledTimes(1);
    expect(bridge.applyRules).not.toHaveBeenCalled();
  });

  it("rejects another project's draft and never publishes its selectors under the new project", async () => {
    const bridge = api(), onDraftChange = vi.fn();
    const draft: BeagleRulesDraft = { projectId: "project", configuration: { groups: [{ ...configuration.groups[0]!, seeds: [{type: "objectid", value: "private-draft"}] }] }, label: "Tag_Tier_Zero", preview, status: "Unsaved rule changes" };
    const props = { api: bridge, labels: [], draft, onDraftChange, onApplied: vi.fn(), onInspectObject: vi.fn() };
    const { rerender } = render(<BeagleRulesPanel {...props} projectId="project" />);
    expect(screen.getByRole("textbox", { name: "Object ID selectors (one per line)" })).toHaveValue("private-draft");
    expect(bridge.getRules).not.toHaveBeenCalled();
    onDraftChange.mockClear();
    rerender(<BeagleRulesPanel {...props} projectId="other" />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Object ID selectors (one per line)" })).toHaveValue("group"));
    expect(screen.queryByLabelText("Rule preview")).not.toBeInTheDocument();
    expect(onDraftChange.mock.calls[0]).toEqual([undefined]);
    expect(onDraftChange.mock.calls.filter(([value]) => value !== undefined).every(([value]) => value.projectId === "other" && value.configuration.groups[0].seeds[0].value === "group")).toBe(true);
  });

  it("saves enablement, Cypher, exclusions and direction through the typed operation", async () => {
    const bridge = api(); const applied = vi.fn();
    render(<BeagleRulesPanel api={bridge} projectId="project" labels={["Tag_Observed", "User"]} onApplied={applied} onInspectObject={vi.fn()} />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    await userEvent.click(screen.getByRole("button", { name: "Add Cypher selector" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Cypher selector 1" }), { target: { value: "MATCH (u:User) RETURN u" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Expansion direction" }), "all");
    await userEvent.click(screen.getByRole("button", { name: "Save and apply rules" }));
    await waitFor(() => expect(applied).toHaveBeenCalledWith(mutation));
    expect(bridge.applyRules).toHaveBeenCalledWith({ configuration: { groups: [{ ...configuration.groups[0], expansion: "all", seeds: [...configuration.groups[0]!.seeds, { type: "cypher", value: "MATCH (u:User) RETURN u" }] }] } });
    expect(screen.queryByText("Rules saved and applied")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Rule label" })).toHaveTextContent("Tag_Observed");
    expect(screen.queryByRole("option", { name: "User" })).not.toBeInTheDocument();
  });

  it("shows validation and failed saves in toasts outside the form without inserting reload controls", async () => {
    const bridge = api(); bridge.applyRules.mockResolvedValue({ ok: false, error: "Selector failed; previous rules retained." });
    render(<BeagleRulesPanel api={bridge} projectId="project" labels={[]} onApplied={vi.fn()} onInspectObject={vi.fn()} />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), { target: { value: "-1" } });
    await userEvent.click(screen.getByRole("button", { name: "Save and apply rules" }));
    const validationError = await screen.findByText("Invalid Beagle rule enablement or priority");
    expect(screen.getByRole("region", { name: "Label rules" })).not.toContainElement(validationError);
    expect(screen.queryByRole("button", { name: "Reload label rules" })).not.toBeInTheDocument();
    expect(bridge.applyRules).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), { target: { value: "1" } });
    await userEvent.click(screen.getByRole("button", { name: "Save and apply rules" }));
    const saveError = await screen.findByText("Selector failed; previous rules retained.");
    expect(screen.getByRole("region", { name: "Label rules" })).not.toContainElement(saveError);
    expect(screen.queryByRole("button", { name: "Reload label rules" })).not.toBeInTheDocument();
  });

  it("reloads failed initial loads from the toast action and clears the stale notification", async () => {
    const bridge = api(); bridge.getRules.mockResolvedValueOnce({ ok: false, error: "Rules could not be read." });
    render(<BeagleRulesPanel api={bridge} projectId="project" labels={[]} onApplied={vi.fn()} onInspectObject={vi.fn()} />);
    expect(await screen.findByText("Rules could not be read.")).toBeInTheDocument();
    const form = screen.getByRole("region", { name: "Label rules" });
    expect(within(form).queryByRole("button", { name: "Reload label rules" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reload label rules" }));
    expect(await screen.findByRole("checkbox", { name: "Enable rule" })).toBeEnabled();
    expect(bridge.getRules).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText("Rules could not be read.")).not.toBeInTheDocument());
  });

  it("closes errors from the previous project instead of carrying them into a different project", async () => {
    const bridge = api(); bridge.getRules.mockResolvedValueOnce({ ok: false, error: "Previous project could not be read." });
    const props = { api: bridge, labels: [], onApplied: vi.fn(), onInspectObject: vi.fn() };
    const { rerender } = render(<BeagleRulesPanel {...props} projectId="project" />);
    await screen.findByText("Previous project could not be read.");
    rerender(<BeagleRulesPanel {...props} projectId="other" />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    await waitFor(() => expect(screen.queryByText("Previous project could not be read.")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Reload label rules" })).not.toBeInTheDocument();
  });

  it("ignores previews from a previous project", async () => {
    const bridge = api(); let complete!: (value: OperationResult<BeagleRulePreview>) => void;
    bridge.previewRules.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const props = { api: bridge, labels: [], onApplied: vi.fn(), onInspectObject: vi.fn() };
    const { rerender } = render(<BeagleRulesPanel {...props} projectId="project" />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    await userEvent.click(screen.getByRole("button", { name: "Preview all rules" }));
    rerender(<BeagleRulesPanel {...props} projectId="other" />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    complete({ ok: true, value: preview });
    await waitFor(() => expect(screen.queryByText("Evaluating label rules…")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Rule preview")).not.toBeInTheDocument();
  });
  it("announces native work and retains the request when the parent disables other actions", async () => {
    const bridge = api(); let complete!: (value: OperationResult<BeagleRulePreview>) => void;
    bridge.previewRules.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const onBusyChange = vi.fn();
    const props = { api: bridge, projectId: "project", labels: [], onApplied: vi.fn(), onInspectObject: vi.fn(), onBusyChange };
    const { rerender } = render(<BeagleRulesPanel {...props} />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    await userEvent.click(screen.getByRole("button", { name: "Preview all rules" }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    rerender(<BeagleRulesPanel {...props} disabled />);
    complete({ ok: true, value: preview });
    expect(await screen.findByLabelText("Rule preview")).toHaveTextContent("Tag_Tier_Zero: 101 objects");
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(bridge.getRules).toHaveBeenCalledTimes(1);
  });
});
