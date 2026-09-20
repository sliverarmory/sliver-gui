import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APPLICATION_SETTINGS_STATE } from "../../shared/application-settings-contracts";
import type { ScriptTaskManagerAPI, ScriptTaskManagerSnapshot } from "../../shared/script-task-manager-contracts";
import type { ScriptConsoleRecord } from "../../shared/script-runtime-protocol";

vi.mock("./components/ScriptOutputTerminal", () => ({
  ScriptOutputTerminal: ({ records, resetKey, runtimeApi }: { records: readonly ScriptConsoleRecord[]; resetKey: string; runtimeApi: ScriptTaskManagerAPI }) =>
    <pre aria-label="Script output transcript" data-reset={resetKey} data-dedicated-api={runtimeApi === window.scriptTasks}>{records.map((record) => record.text).join("\n")}</pre>,
  scriptOutputText: (records: readonly ScriptConsoleRecord[]) => records.map((record) => record.text + "\n").join(""),
}));
import { ScriptTaskManagerWindowApp } from "./ScriptTaskManagerWindowApp";

const FIRST = "09cf16dd-3f93-48c1-8abc-03c07a530a72";
const SECOND = "630c1683-d71d-45c0-8d06-4b7b348c83ce";
const snapshot: ScriptTaskManagerSnapshot = {
  scripts: [
    { id: FIRST, name: "Hello World", dirty: true, conflict: false },
    { id: SECOND, name: "Second", dirty: false, conflict: false, state: { status: "running", elapsedMs: 0 } },
  ],
  selectedId: FIRST, records: [{ level: "log", sequence: 0, text: "shared output" }], outputReset: 1, pending: false,
};
function setup() {
  let listener: (state: ScriptTaskManagerSnapshot) => void = () => undefined;
  const unsubscribe = vi.fn();
  const api: ScriptTaskManagerAPI = {
    open: vi.fn(async () => ({ ok: true as const })),
    getState: vi.fn(async () => ({ ok: true as const, value: snapshot })),
    publish: vi.fn(async () => ({ ok: true as const })),
    command: vi.fn(async () => ({ ok: true as const })),
    ownerReady: vi.fn(async () => ({ ok: true as const })),
    onChanged: vi.fn((next) => { listener = next; return unsubscribe; }),
    onCommand: vi.fn(() => vi.fn()), onHostRequested: vi.fn(() => vi.fn()), onEditRequested: vi.fn(() => vi.fn()),
    getTerminalRuntime: vi.fn(async () => ({ ok: false as const, error: "Not used by this test" })),
    getApplicationSettings: vi.fn(async () => DEFAULT_APPLICATION_SETTINGS_STATE),
    onApplicationSettingsChanged: vi.fn(() => vi.fn()),
  };
  Object.defineProperty(window, "scriptTasks", { configurable: true, value: api });
  return { api, unsubscribe, emit: (state: ScriptTaskManagerSnapshot) => act(() => listener(state)) };
}
afterEach(() => { cleanup(); Reflect.deleteProperty(window, "scriptTasks"); });

describe("ScriptTaskManagerWindowApp", () => {
  it("uses shared state and targeted commands without an editor or separate runtime", async () => {
    const { api, emit, unsubscribe } = setup();
    const view = render(<ScriptTaskManagerWindowApp />);
    expect(await screen.findByRole("button", { name: "Run Hello World" })).toBeInTheDocument();
    expect(screen.getByText("1 running")).toBeInTheDocument();
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("shared output");
    expect(screen.getByLabelText("Script output transcript")).toHaveAttribute("data-dedicated-api", "true");
    expect(screen.queryByRole("textbox", { name: "Script source" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Run Hello World" }));
    expect(api.command).toHaveBeenLastCalledWith({ type: "run", id: FIRST });
    await userEvent.click(screen.getByRole("button", { name: "Stop Second" }));
    expect(api.command).toHaveBeenLastCalledWith({ type: "stop", id: SECOND });
    await userEvent.click(screen.getByRole("button", { name: "Select Second" }));
    expect(api.command).toHaveBeenLastCalledWith({ type: "select", id: SECOND });
    emit({ ...snapshot, selectedId: SECOND, records: [{ level: "log", sequence: 0, text: "other console" }], outputReset: 2 });
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("other console");
    expect(screen.getByLabelText("Script output transcript")).toHaveAttribute("data-reset", `${SECOND}:2`);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(api.command).toHaveBeenLastCalledWith({ type: "clear", id: SECOND });
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("retains a newer pushed snapshot when the initial request finishes late", async () => {
    const { api, emit } = setup();
    let finish!: (value: Awaited<ReturnType<ScriptTaskManagerAPI["getState"]>>) => void;
    vi.mocked(api.getState).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<ScriptTaskManagerWindowApp />);
    emit({ ...snapshot, records: [{ level: "log", sequence: 0, text: "newer" }] });
    await act(async () => finish({ ok: true, value: snapshot }));
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("newer");
  });

  it("keeps Stop available during a pending editor mutation and reports command failures", async () => {
    const { api, emit } = setup();
    render(<ScriptTaskManagerWindowApp />);
    await screen.findByRole("button", { name: "Run Hello World" });
    emit({ ...snapshot, pending: true });
    expect(screen.getByRole("button", { name: "Run Hello World" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop Second" })).not.toBeDisabled();
    vi.mocked(api.command).mockResolvedValueOnce({ ok: false, error: "The script window closed." });
    await userEvent.click(screen.getByRole("button", { name: "Stop Second" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The script window closed."));
  });

  it("filters scripts while rendering names and output as literal text", async () => {
    const { emit } = setup();
    render(<ScriptTaskManagerWindowApp />);
    await screen.findByRole("button", { name: "Run Hello World" });
    emit({ ...snapshot, scripts: [{ id: FIRST, name: "<b>literal</b>", dirty: false, conflict: false }], records: [] });
    expect(screen.getByRole("button", { name: "Select <b>literal</b>" })).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search scripts" }), "missing");
    expect(screen.getByText("No matching scripts.")).toBeInTheDocument();
  });
});
