import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { ScriptDocument } from "../../../shared/script-contracts";
import type { ScriptConsoleRecord, ScriptRunState } from "../../../shared/script-runtime-protocol";

interface FakeRunner {
  callbacks: { onOutput(records: readonly ScriptConsoleRecord[]): void; onState(state: ScriptRunState): void };
  run: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}
const runners = vi.hoisted(() => ({ instances: [] as FakeRunner[] }));
vi.mock("../scripting/script-runner", () => ({
  ScriptRunner: class {
    running = false;
    constructor(readonly callbacks: FakeRunner["callbacks"]) { runners.instances.push(this); }
    run = vi.fn(() => { this.running = true; this.callbacks.onState({ status: "running", elapsedMs: 0 }); });
    stop = vi.fn(() => {
      if (!this.running) return;
      this.running = false;
      this.callbacks.onState({ status: "stopped", elapsedMs: 1 });
    });
    dispose = vi.fn();
  },
}));
vi.mock("../components/CodeEditor", () => ({
  CodeEditor: ({ value, onChange, ariaLabel }: { value: string; onChange(value: string): void; ariaLabel: string }) =>
    <textarea aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} />,
}));
vi.mock("../components/ScriptOutputTerminal", () => ({
  ScriptOutputTerminal: ({ records }: { records: readonly ScriptConsoleRecord[] }) => <pre aria-label="Script output transcript">{records.map((record) => record.text).join("\n")}</pre>,
  scriptOutputText: (records: readonly ScriptConsoleRecord[]) => records.map((record) => `${record.text}\n`).join(""),
}));

import { ScriptEditorPage } from "./ScriptEditorPage";
import { renderWithApplicationContextMenu as render, type ApplicationContextMenuTestRender } from "../application-context-menu-test-utils";

const FIRST_ID = "09cf16dd-3f93-48c1-8abc-03c07a530a72";
const SECOND_ID = "630c1683-d71d-45c0-8d06-4b7b348c83ce";
const INITIAL_SOURCE = 'console.log("Hello, world!");\n';

function setup() {
  const documents = new Map<string, ScriptDocument>([[FIRST_ID, { id: FIRST_ID, name: "Hello World", source: INITIAL_SOURCE, revision: "a".repeat(64) }]]);
  let revision = 0;
  let changed = (): void => undefined;
  const nextRevision = (): string => (++revision).toString(16).padStart(64, "0");
  const api = {
    listScripts: vi.fn(async () => ({ ok: true as const, value: { scripts: [...documents.values()].map(({ id, name, revision }) => ({ id, name, revision })), warnings: [] } })),
    readScript: vi.fn(async ({ id }: { id: string }) => ({ ok: true as const, value: { ...documents.get(id)! } })),
    createScript: vi.fn(async ({ name, source }: { name: string; source: string }) => {
      const document = { id: SECOND_ID, name, source, revision: nextRevision() };
      documents.set(document.id, document);
      return { ok: true as const, value: document };
    }),
    saveScript: vi.fn(async ({ id, source }: { id: string; source: string; expectedRevision: string }) => {
      const document = { ...documents.get(id)!, source, revision: nextRevision() };
      documents.set(id, document);
      return { ok: true as const, value: document };
    }),
    renameScript: vi.fn(async ({ id, name }: { id: string; name: string; expectedRevision: string }) => {
      const document = { ...documents.get(id)!, name, revision: nextRevision() };
      documents.set(id, document);
      return { ok: true as const, value: document };
    }),
    deleteScript: vi.fn(async ({ id }: { id: string; expectedRevision: string }) => { documents.delete(id); return { ok: true as const }; }),
    exportScript: vi.fn(async (_input: { name: string; source: string }) => ({ ok: true as const, value: { canceled: false } })),
    importScript: vi.fn<SliverDesktopAPI["importScript"]>(async () => ({ ok: true, value: { canceled: true } })),
    getScriptRuntime: vi.fn(async () => ({ ok: true as const, value: { version: "test", sha256: "b".repeat(64), bytes: new Uint8Array([0, 97, 115, 109]) } })),
    setScriptEditorDirty: vi.fn(async (_dirty: boolean) => ({ ok: true as const })),
    onScriptsChanged: vi.fn((listener: () => void) => { changed = listener; return vi.fn(); }),
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api as unknown as SliverDesktopAPI });
  return { api, documents, changed: () => changed() };
}
function runner(): FakeRunner { return runners.instances[runners.instances.length - 1]!; }
async function source(): Promise<HTMLTextAreaElement> { return screen.findByRole("textbox", { name: "Script source" }); }
async function action(name: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Script actions" }));
  await user.click(await screen.findByRole("menuitem", { name }));
}
function wideViewport(): void {
  const media = window.matchMedia("(min-width: 960px)");
  vi.stubGlobal("matchMedia", () => ({ ...media, matches: true }));
}
async function contextMenu(view: ApplicationContextMenuTestRender, scriptName: string): Promise<HTMLElement> {
  fireEvent.contextMenu(screen.getByRole("button", { name: `Open ${scriptName}` }));
  view.contextMenu.emit();
  return screen.findByRole("menu", { name: "Application context menu" });
}

beforeEach(() => {
  runners.instances = [];
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Reflect.deleteProperty(Element.prototype, "getAnimations"); });

describe("ScriptEditorPage", () => {
  it("reveals a retained unsaved draft from a hidden page and handles repeated Keep Editing requests", async () => {
    const { documents, api } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "keep this unsaved source" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), SECOND_ID);
    await waitFor(() => expect(editor).toHaveValue("2;"));
    view.rerender(<ScriptEditorPage active={false} revealUnsavedRequest={1} />);
    expect(screen.queryByRole("heading", { name: "Script Editor" })).not.toBeInTheDocument();
    view.rerender(<ScriptEditorPage active revealUnsavedRequest={1} />);
    expect(await source()).toHaveValue("keep this unsaved source");
    expect(screen.getByRole("combobox", { name: "Select script" })).toHaveValue(FIRST_ID);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), SECOND_ID);
    expect(editor).toHaveValue("2;");
    view.rerender(<ScriptEditorPage active revealUnsavedRequest={2} />);
    expect(editor).toHaveValue("keep this unsaved source");
    expect(api.saveScript).not.toHaveBeenCalled();
    expect(api.setScriptEditorDirty).toHaveBeenLastCalledWith(true);
  });

  it("keeps the current dirty draft and output while dismissing script dialogs and search filters", async () => {
    const { documents, api } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    fireEvent.change(await source(), { target: { value: "first dirty source" } });
    await userEvent.click(screen.getByRole("button", { name: "Open Second" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Script source" })).toHaveValue("2;"));
    fireEvent.change(await source(), { target: { value: "second dirty source" } });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runner().run).toHaveBeenCalledOnce());
    act(() => runner().callbacks.onOutput([{ sequence: 0, level: "log", text: "retained output" }]));
    const stops = runner().stop.mock.calls.length;
    fireEvent.change(screen.getByRole("searchbox", { name: "Search scripts" }), { target: { value: "missing" } });
    await action("Delete");
    expect(await screen.findByRole("alertdialog")).toHaveTextContent("Second");
    view.rerender(<ScriptEditorPage active revealUnsavedRequest={1} />);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(await source()).toHaveValue("second dirty source");
    expect(screen.getByRole("button", { name: "Open Second" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("searchbox", { name: "Search scripts" })).toHaveValue("");
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("retained output");
    expect(runner().stop).toHaveBeenCalledTimes(stops);
    expect(api.deleteScript).not.toHaveBeenCalled();
  });

  it("waits for an in-flight script operation before selecting an unsaved draft", async () => {
    const { documents, api } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "unsaved first source" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), SECOND_ID);
    await waitFor(() => expect(editor).toHaveValue("2;"));
    let finish!: (value: Awaited<ReturnType<typeof api.exportScript>>) => void;
    api.exportScript.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await action("Export…");
    await waitFor(() => expect(api.exportScript).toHaveBeenCalledWith({ name: "Second", source: "2;" }));
    view.rerender(<ScriptEditorPage active revealUnsavedRequest={1} />);
    expect(editor).toHaveValue("2;");
    expect(screen.getByRole("combobox", { name: "Select script" })).toBeDisabled();
    await act(async () => finish({ ok: true, value: { canceled: true } }));
    expect(editor).toHaveValue("unsaved first source");
    expect(screen.getByRole("combobox", { name: "Select script" })).toHaveValue(FIRST_ID);
    expect(api.saveScript).not.toHaveBeenCalled();
  });

  it("offers all five row actions with the same icons in both menus", async () => {
    setup();
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    await source();
    const expected = [
      ["Rename", "pen"], ["Duplicate", "copy"], ["Export…", "file-export"],
      ["Reload from disk", "rotate-right"], ["Delete", "trash-can"],
    ] as const;
    const menu = await contextMenu(view, "Hello World");
    for (const [name, icon] of expected) {
      expect(within(menu).getByRole("menuitem", { name }).querySelector("svg")).toHaveAttribute("data-icon", icon);
    }
    expect(within(menu).getByRole("menuitem", { name: "Delete" })).toHaveClass("menu-item--danger");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Script actions" }));
    const dropdown = await screen.findByRole("menu", { name: "Script actions" });
    for (const [name, icon] of expected) {
      expect(within(dropdown).getByRole("menuitem", { name }).querySelector("svg")).toHaveAttribute("data-icon", icon);
    }
    expect(within(dropdown).getByRole("menuitem", { name: "Delete" })).toHaveClass("menu-item--danger");
  });

  it.each(["Rename", "Reload from disk", "Delete"])("targets an uncached row for %s without interrupting the selected script", async (operation) => {
    const { api, documents } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "keep this draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runner().run).toHaveBeenCalledOnce());
    act(() => runner().callbacks.onOutput([{ sequence: 0, level: "log", text: "keep this output" }]));
    const stops = runner().stop.mock.calls.length;
    const menu = await contextMenu(view, "Second");
    await userEvent.click(within(menu).getByRole("menuitem", { name: operation }));
    if (operation === "Rename") {
      expect(await screen.findByRole("textbox", { name: "Script name" })).toHaveValue("Second");
      fireEvent.change(screen.getByRole("textbox", { name: "Script name" }), { target: { value: "Renamed second" } });
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(api.renameScript).toHaveBeenCalledWith({ id: SECOND_ID, name: "Renamed second", expectedRevision: "b".repeat(64) }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    } else {
      const dialog = await screen.findByRole("alertdialog");
      expect(dialog).toHaveTextContent("Second");
      await userEvent.click(within(dialog).getByRole("button", { name: operation === "Delete" ? "Delete" : "Reload" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      if (operation === "Delete") expect(api.deleteScript).toHaveBeenCalledWith({ id: SECOND_ID, expectedRevision: "b".repeat(64) });
      else expect(api.readScript).toHaveBeenLastCalledWith({ id: SECOND_ID });
    }
    expect(editor).toHaveValue("keep this draft");
    expect(screen.getByRole("button", { name: "Open Hello World" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("keep this output");
    expect(runner().stop).toHaveBeenCalledTimes(stops);
    expect(api.saveScript).not.toHaveBeenCalled();
  });

  it.each(["Export…", "Duplicate"])("uses the clicked row's cached unsaved source for %s", async (operation) => {
    const { api, documents } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    await source();
    await userEvent.click(screen.getByRole("button", { name: "Open Second" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Script source" })).toHaveValue("2;"));
    fireEvent.change(await source(), { target: { value: "unsaved second" } });
    await userEvent.click(screen.getByRole("button", { name: "Open Hello World" }));
    const reads = api.readScript.mock.calls.length;
    const menu = await contextMenu(view, "Second");
    await userEvent.click(within(menu).getByRole("menuitem", { name: operation }));
    if (operation === "Export…") {
      await waitFor(() => expect(api.exportScript).toHaveBeenCalledWith({ name: "Second", source: "unsaved second" }));
      expect(await source()).toHaveValue(INITIAL_SOURCE);
    } else {
      expect(await screen.findByRole("textbox", { name: "Script name" })).toHaveValue("Second copy");
      await userEvent.click(screen.getByRole("button", { name: "Save copy" }));
      await waitFor(() => expect(api.createScript).toHaveBeenCalledWith({ name: "Second copy", source: "unsaved second" }));
    }
    expect(api.readScript).toHaveBeenCalledTimes(reads);
    expect(api.saveScript).not.toHaveBeenCalled();
  });

  it.each(["unavailable", "changed"])("does not retarget an uncached row that becomes %s", async (failure) => {
    const { api, documents } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    const menu = await contextMenu(view, "Second");
    if (failure === "unavailable") {
      vi.mocked(window.sliver.readScript).mockResolvedValueOnce({ ok: false, error: "This script is no longer available." });
    } else {
      documents.set(SECOND_ID, { ...documents.get(SECOND_ID)!, revision: "c".repeat(64) });
    }
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText(failure === "unavailable" ? "This script is no longer available." : "This script changed since the menu opened. Open its menu again.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(api.deleteScript).not.toHaveBeenCalled();
    expect(editor).toHaveValue(INITIAL_SOURCE);
  });

  it("disables other row actions while an uncached script is loading for export", async () => {
    const { api, documents } = setup();
    const second = { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) };
    documents.set(SECOND_ID, second);
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    let finish!: (value: Awaited<ReturnType<typeof api.readScript>>) => void;
    api.readScript.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const menu = await contextMenu(view, "Second");
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Export…" }));
    await waitFor(() => expect(api.readScript).toHaveBeenLastCalledWith({ id: SECOND_ID }));
    expect(screen.getByRole("button", { name: "Open Hello World" })).toBeDisabled();
    const blockedMenu = await contextMenu(view, "Hello World");
    for (const name of ["Rename", "Duplicate", "Export…", "Reload from disk", "Delete"]) {
      expect(within(blockedMenu).getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    await userEvent.keyboard("{Escape}");
    await act(async () => finish({ ok: true, value: second }));
    await waitFor(() => expect(api.exportScript).toHaveBeenCalledWith({ name: "Second", source: "2;" }));
    expect(editor).toHaveValue(INITIAL_SOURCE);
    expect(api.deleteScript).not.toHaveBeenCalled();
  });

  it("disables renaming a conflicted draft in both menus while retaining copy and export", async () => {
    const { documents, changed } = setup();
    wideViewport();
    const view = render(<ScriptEditorPage active />);
    fireEvent.change(await source(), { target: { value: "unsaved" } });
    documents.set(FIRST_ID, { ...documents.get(FIRST_ID)!, revision: "c".repeat(64) });
    act(changed);
    await screen.findByText(/changed in another window/u);
    const menu = await contextMenu(view, "Hello World");
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toHaveAttribute("aria-disabled", "true");
    for (const name of ["Duplicate", "Export…"]) expect(within(menu).getByRole("menuitem", { name })).not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Script actions" }));
    expect(await screen.findByRole("menuitem", { name: "Rename" })).toHaveAttribute("aria-disabled", "true");
  });

  it("exports the current draft without saving or clearing its dirty state", async () => {
    const { api } = setup();
    render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "console.log('export this draft');" } });
    await action("Export…");
    await waitFor(() => expect(api.exportScript).toHaveBeenCalledWith({ name: "Hello World", source: "console.log('export this draft');" }));
    expect(api.saveScript).not.toHaveBeenCalled();
    expect(editor).toHaveValue("console.log('export this draft');");
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(runner().run).not.toHaveBeenCalled();
  });

  it("imports and selects a saved copy without executing it or losing another draft", async () => {
    const { api, documents } = setup();
    const imported: ScriptDocument = { id: SECOND_ID, name: "Imported", source: "console.log('imported');", revision: "b".repeat(64) };
    api.importScript.mockImplementationOnce(async () => {
      documents.set(SECOND_ID, imported);
      return { ok: true, value: { canceled: false, script: imported } };
    });
    render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "keep my unsaved draft" } });
    await userEvent.click(screen.getByRole("button", { name: "Import script" }));
    await waitFor(() => expect(editor).toHaveValue(imported.source));
    expect(screen.getByText("Saved", { exact: true })).toBeInTheDocument();
    expect(runner().run).not.toHaveBeenCalled();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), FIRST_ID);
    expect(editor).toHaveValue("keep my unsaved draft");
  });

  it("keeps the draft on canceled import/export and reports transfer failures", async () => {
    const { api } = setup();
    api.exportScript.mockResolvedValueOnce({ ok: true, value: { canceled: true } });
    render(<ScriptEditorPage active />);
    const editor = await source();
    await action("Export…");
    await waitFor(() => expect(api.exportScript).toHaveBeenCalledOnce());
    await userEvent.click(screen.getByRole("button", { name: "Import script" }));
    await waitFor(() => expect(api.importScript).toHaveBeenCalledOnce());
    expect(editor).toHaveValue(INITIAL_SOURCE);
    api.importScript.mockResolvedValueOnce({ ok: false, error: "The selected script is too large." });
    await userEvent.click(screen.getByRole("button", { name: "Import script" }));
    expect(await screen.findByText("The selected script is too large.")).toBeInTheDocument();
    vi.mocked(window.sliver.exportScript).mockResolvedValueOnce({ ok: false, error: "Could not export this script." });
    await action("Export…");
    expect(await screen.findByText("Could not export this script.")).toBeInTheDocument();
    expect(editor).toHaveValue(INITIAL_SOURCE);
  });

  it("retries a failed document read even when the catalog revision has not changed", async () => {
    const { api } = setup();
    vi.mocked(window.sliver.readScript).mockResolvedValueOnce({ ok: false, error: "Could not read this script." });
    render(<ScriptEditorPage active />);
    expect(await screen.findByText("Could not read this script.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await source()).toHaveValue(INITIAL_SOURCE);
    expect(api.readScript).toHaveBeenCalledTimes(2);
  });

  it("edits only a draft, explicitly saves by ID/revision, and protects unsaved window close", async () => {
    const { api } = setup();
    render(<ScriptEditorPage active />);
    const editor = await source();
    expect(editor.value).toBe(INITIAL_SOURCE);
    fireEvent.change(editor, { target: { value: "console.log('draft');" } });
    expect(api.saveScript).not.toHaveBeenCalled();
    await waitFor(() => expect(api.setScriptEditorDirty).toHaveBeenLastCalledWith(true));
    const close = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(close);
    expect(close.defaultPrevented).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.saveScript).toHaveBeenCalledWith({ id: FIRST_ID, source: "console.log('draft');", expectedRevision: "a".repeat(64) }));
    await waitFor(() => expect(api.setScriptEditorDirty).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const savedClose = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(savedClose);
    expect(savedClose.defaultPrevented).toBe(false);
  });

  it("runs a snapshot of the unsaved buffer, retains later edits, and stops on leaving the page", async () => {
    setup();
    const view = render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "console.log('snapshot');" } });
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(runner().run).toHaveBeenCalledWith(expect.objectContaining({ scriptId: FIRST_ID, source: "console.log('snapshot');" })));
    expect(screen.getByText("Unsaved snapshot")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "console.log('next run');" } });
    expect(screen.getByText("Edited since run")).toBeInTheDocument();
    act(() => runner().callbacks.onOutput([{ sequence: 0, level: "log", text: "snapshot" }]));
    expect(screen.getByLabelText("Script output transcript")).toHaveTextContent("snapshot");
    view.rerender(<ScriptEditorPage active={false} />);
    expect(runner().stop).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Script Editor" })).not.toBeInTheDocument();
    view.rerender(<ScriptEditorPage active />);
    expect((await source()).value).toBe("console.log('next run');");
    expect(screen.getByText(/Stopped/u)).toBeInTheDocument();
    view.unmount();
    expect(runner().dispose).toHaveBeenCalledOnce();
  });

  it("does not start a run if runtime loading finishes after navigation away", async () => {
    const { api } = setup();
    let finish!: (value: Awaited<ReturnType<typeof api.getScriptRuntime>>) => void;
    api.getScriptRuntime.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = render(<ScriptEditorPage active />);
    await source();
    await userEvent.click(screen.getByRole("button", { name: "Run" }));
    view.rerender(<ScriptEditorPage active={false} />);
    await act(async () => finish({ ok: true, value: { version: "test", sha256: "b".repeat(64), bytes: new Uint8Array([1]) } }));
    expect(runner().run).not.toHaveBeenCalled();
  });

  it("retains drafts across script selection and marks external changes without overwriting them", async () => {
    const { documents, changed, api } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    render(<ScriptEditorPage active />);
    const originalEditor = await source();
    fireEvent.change(originalEditor, { target: { value: "my unsaved edit" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), SECOND_ID);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Script source" })).toHaveValue("2;"));
    expect(await source()).toBe(originalEditor);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Select script" }), FIRST_ID);
    expect(await source()).toHaveValue("my unsaved edit");
    documents.set(FIRST_ID, { ...documents.get(FIRST_ID)!, source: "external edit", revision: "c".repeat(64) });
    act(changed);
    expect(await screen.findByText(/changed in another window/u)).toBeInTheDocument();
    expect(await source()).toHaveValue("my unsaved edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(api.saveScript).not.toHaveBeenCalled();
    await action("Reload from disk");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Script source" })).toHaveValue("external edit"));
    expect(screen.queryByText(/changed in another window/u)).not.toBeInTheDocument();
  });

  it("creates, renames, duplicates current edits, and deletes through explicit dialogs", async () => {
    const { api } = setup();
    render(<ScriptEditorPage active />);
    await source();
    await action("Rename");
    const name = screen.getByRole("textbox", { name: "Script name" });
    fireEvent.change(name, { target: { value: "../../display name" } });
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(api.renameScript).toHaveBeenCalledWith({ id: FIRST_ID, name: "../../display name", expectedRevision: "a".repeat(64) }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.change(await source(), { target: { value: "console.log('copy this draft');" } });
    await action("Duplicate");
    await userEvent.click(screen.getByRole("button", { name: "Save copy" }));
    await waitFor(() => expect(api.createScript).toHaveBeenCalledWith({ name: "../../display name copy", source: "console.log('copy this draft');" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await action("Delete");
    await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.deleteScript).toHaveBeenCalledWith(expect.objectContaining({ id: SECOND_ID })));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "New script" }));
    await userEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.createScript).toHaveBeenLastCalledWith({ name: "Untitled script", source: "" }));
  });

  it("keeps edits made during Save dirty after the saved snapshot returns", async () => {
    const { api } = setup();
    let finish!: (value: Awaited<ReturnType<typeof api.saveScript>>) => void;
    api.saveScript.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<ScriptEditorPage active />);
    const editor = await source();
    fireEvent.change(editor, { target: { value: "first edit" } });
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.change(editor, { target: { value: "later edit" } });
    await act(async () => finish({ ok: true, value: { id: FIRST_ID, name: "Hello World", source: "first edit", revision: "c".repeat(64) } }));
    expect(editor).toHaveValue("later edit");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(api.setScriptEditorDirty).toHaveBeenLastCalledWith(true);
  });

  it.each(["Rename", "Delete", "Reload from disk"] as const)("keeps %s bound to its opening document after an external deletion", async (operation) => {
    const { api, documents, changed } = setup();
    documents.set(SECOND_ID, { id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
    render(<ScriptEditorPage active />);
    const editor = await source();
    await action(operation);
    documents.delete(FIRST_ID);
    act(changed);
    await waitFor(() => expect(editor).toHaveValue("2;"));

    const failure = { ok: false as const, error: "The original script no longer exists." };
    if (operation === "Rename") {
      vi.mocked(window.sliver.renameScript).mockResolvedValueOnce(failure);
      fireEvent.change(screen.getByRole("textbox", { name: "Script name" }), { target: { value: "Renamed" } });
      await userEvent.click(screen.getByRole("button", { name: "Rename" }));
      await waitFor(() => expect(api.renameScript).toHaveBeenCalledWith({ id: FIRST_ID, name: "Renamed", expectedRevision: "a".repeat(64) }));
      expect(api.createScript).not.toHaveBeenCalled();
    } else if (operation === "Delete") {
      vi.mocked(window.sliver.deleteScript).mockResolvedValueOnce(failure);
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Hello World");
      await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(api.deleteScript).toHaveBeenCalledWith({ id: FIRST_ID, expectedRevision: "a".repeat(64) }));
    } else {
      vi.mocked(window.sliver.readScript).mockResolvedValueOnce(failure);
      expect(screen.getByRole("alertdialog")).toHaveTextContent("Hello World");
      await userEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Reload" }));
      await waitFor(() => expect(api.readScript).toHaveBeenLastCalledWith({ id: FIRST_ID }));
    }
    expect(documents.get(SECOND_ID)).toEqual({ id: SECOND_ID, name: "Second", source: "2;", revision: "b".repeat(64) });
  });
});
