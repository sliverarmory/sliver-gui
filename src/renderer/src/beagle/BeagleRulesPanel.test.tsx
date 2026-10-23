import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { BeagleMutationResult } from "../../../shared/beagle-contracts";
import type { OperationResult } from "../../../shared/contracts";
import { parseBeagleRuleConfiguration, type BeagleRuleConfiguration, type BeagleRulePreview } from "../../../shared/beagle-rules";
import { BeagleRulesPanel } from "./BeagleRulesPanel";

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
afterEach(cleanup);

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
    expect(screen.getByRole("status")).toHaveTextContent("Rules saved and applied");
    expect(screen.getByRole("combobox", { name: "Rule label" })).toHaveTextContent("Tag_Observed");
    expect(screen.queryByRole("option", { name: "User" })).not.toBeInTheDocument();
  });

  it("keeps failed saves visible and rejects invalid priority before IPC", async () => {
    const bridge = api(); bridge.applyRules.mockResolvedValue({ ok: false, error: "Selector failed; previous rules retained." });
    render(<BeagleRulesPanel api={bridge} projectId="project" labels={[]} onApplied={vi.fn()} onInspectObject={vi.fn()} />);
    await screen.findByRole("checkbox", { name: "Enable rule" });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), { target: { value: "-1" } });
    await userEvent.click(screen.getByRole("button", { name: "Save and apply rules" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Invalid Beagle rule enablement or priority");
    expect(bridge.applyRules).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), { target: { value: "1" } });
    await userEvent.click(screen.getByRole("button", { name: "Save and apply rules" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("previous rules retained");
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
