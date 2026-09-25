import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BofCatalog, BofDirectorySelection, BofExecutionRecord } from "../../../shared/bof-contracts";
import type { OperationResult, SliverDesktopAPI } from "../../../shared/contracts";
import type { SessionSummary, TargetRef } from "../../../shared/target-contracts";
import { BofExecutionView } from "./BofExecutionView";

vi.mock("../components/ExecutionOutputTerminal", () => ({
  ExecutionOutputTerminal: ({ bytes }: { bytes: Uint8Array }) => (
    <pre aria-label="Execution output transcript">{new TextDecoder().decode(bytes)}</pre>
  ),
}));

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: () => undefined });
  Object.defineProperty(Element.prototype, "releasePointerCapture", { configurable: true, value: () => undefined });
});

afterAll(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(Element.prototype, "getAnimations");
  Reflect.deleteProperty(Element.prototype, "setPointerCapture");
  Reflect.deleteProperty(Element.prototype, "releasePointerCapture");
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "sliver");
  Reflect.deleteProperty(navigator, "clipboard");
});

const target: SessionSummary = {
  mode: "session", id: "bof-session", name: "target", hostname: "target", hostId: "host-1", username: "operator",
  os: "windows", arch: "amd64", transport: "mtls", remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444", executable: "C:\\sliver.exe", version: "1.7.6",
  locale: "en-US", integrity: "user", burned: false, pid: 42, liveness: "active",
};

const targetRef: TargetRef = {
  mode: "session", id: target.id, backendEpoch: 7, domainRevision: 3, fingerprint: "a".repeat(64),
};

const catalog: BofCatalog = {
  target: targetRef,
  warnings: [],
  commands: [
    {
      id: "sa-dir/sa-dir", packageName: "Directory Listing (SA)", commandName: "sa-dir",
      description: "List directory contents", available: true,
      arguments: [
        { name: "targetdir", description: "Directory path", type: "string", optional: true, default: "." },
        { name: "subdirs", description: "Recurse into subdirectories", type: "short", optional: true, default: 0 },
      ],
    },
    {
      id: "sa-nslookup/sa-nslookup", packageName: "NS Lookup (SA)", commandName: "sa-nslookup",
      description: "Resolve a hostname", available: true,
      arguments: [
        { name: "hostname", description: "Hostname to resolve", type: "string", optional: false },
        { name: "server", description: "Optional DNS server", type: "string", optional: true },
        { name: "type", description: "DNS record type", type: "short", optional: true, default: 1, choices: ["1", "5", "28"] },
      ],
    },
    {
      id: "inject/inject", packageName: "Injection", commandName: "inject", description: "Use a local file",
      available: true,
      arguments: [
        { name: "pid", description: "Target process ID", type: "integer", optional: false },
        { name: "bin", description: "Shellcode file", type: "file", optional: false },
      ],
    },
  ],
};

function installApi(initialRows: BofExecutionRecord[] = []) {
  let rows: BofExecutionRecord[] = initialRows;
  let revision = 1;
  let currentTargetRef = targetRef;
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  const api = {
    listInstalledBofs: vi.fn(async () => ({ ok: true as const, value: { ...catalog, target: currentTargetRef } })),
    chooseBofDirectory: vi.fn(async (): Promise<OperationResult<BofDirectorySelection | null>> => ({ ok: true, value: null })),
    chooseBofArgumentFile: vi.fn(async () => ({ ok: true as const, value: { token: "file-token-1", fileName: "payload.bin", size: 8 } })),
    runBof: vi.fn(async ({ commandId }: { commandId: string }) => {
      const record: BofExecutionRecord = {
        id: `run-${revision}`, startedAt: "2026-09-25T11:00:00.000Z", commandId,
        commandName: commandId.split("/")[1] ?? commandId, state: "completed",
        stdout: { data: new TextEncoder().encode("BOF stdout\n"), truncated: false },
        stderr: { data: new TextEncoder().encode("BOF stderr\n"), truncated: false },
      };
      rows = [record, ...rows];
      revision += 1;
      return {
        ok: true as const,
        value: {
          ...record,
          stdout: { data: Uint8Array.from(record.stdout!.data), truncated: false },
          stderr: { data: Uint8Array.from(record.stderr!.data), truncated: false },
        },
      };
    }),
    listBofExecutionHistory: vi.fn(async () => ({
      ok: true as const,
      value: {
        target: currentTargetRef, revision,
        records: rows.map((record) => ({
          ...record,
          ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
          ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
        })),
      },
    })),
    clearBofExecutionHistory: vi.fn(async ({ id }: { id?: string }) => {
      rows = id ? rows.filter((record) => record.id !== id) : [];
      revision += 1;
      return { ok: true as const };
    }),
    getBofExecutionResult: vi.fn(async ({ id }: { id: string }) => ({ ok: true as const, value: rows.find((record) => record.id === id) })),
    saveBofOutput: vi.fn(async () => ({ ok: true as const, value: { saved: true, fileName: "bof-stdout.txt" } })),
    addBofOutputToLoot: vi.fn(async () => ({ ok: true as const, value: { name: "BOF output" } })),
    onBofExecutionHistoryChanged: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api as unknown as SliverDesktopAPI });
  return {
    api,
    clipboard,
    setRows(next: BofExecutionRecord[]) {
      rows = next;
      revision += 1;
    },
    setTarget(nextTargetRef: TargetRef, nextRows: BofExecutionRecord[], nextRevision: number) {
      currentTargetRef = nextTargetRef;
      rows = nextRows;
      revision = nextRevision;
    },
  };
}

function renderView(): void {
  render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

async function chooseBof(
  user: ReturnType<typeof userEvent.setup>,
  composer: HTMLElement,
  searchTerm: string,
  optionName: RegExp,
): Promise<void> {
  const trigger = composer.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]');
  expect(trigger).not.toBeNull();
  await user.click(trigger!);
  const search = await screen.findByRole("searchbox", { name: "Search BOFs" });
  await user.clear(search);
  await user.type(search, searchTerm);
  await user.click(await screen.findByRole("option", { name: optionName }));
}

describe("BOF execution view", () => {
  it("preserves the open autocomplete search through a routine target domain revision update", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    const trigger = composer.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]');
    expect(trigger).not.toBeNull();
    await user.click(trigger!);
    const search = await screen.findByRole("searchbox", { name: "Search BOFs" });
    await user.type(search, "direc");

    const refreshedTargetRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const refresh = deferred<Awaited<ReturnType<typeof api.listInstalledBofs>>>();
    api.listInstalledBofs.mockReturnValueOnce(refresh.promise);
    setTarget(refreshedTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={target} targetRef={refreshedTargetRef} />);

    await waitFor(() => expect(api.listInstalledBofs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("searchbox", { name: "Search BOFs" })).toBe(search);
    expect(search).toHaveFocus();
    expect(search).toHaveValue("direc");
    await user.type(search, "tory");

    await act(async () => {
      refresh.resolve({ ok: true, value: { ...catalog, target: refreshedTargetRef } });
    });
    expect(screen.getByRole("searchbox", { name: "Search BOFs" })).toBe(search);
    expect(search).toHaveFocus();
    expect(search).toHaveValue("directory");
    expect(screen.getByRole("option", { name: /sa-dir/iu })).toBeInTheDocument();
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("preserves the selected BOF and argument draft through a routine target domain revision update", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "hostname", /sa-nslookup/iu);
    const hostname = within(composer).getByRole("textbox", { name: "hostname" });
    await user.type(hostname, "draft.example");

    const refreshedTargetRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const refresh = deferred<Awaited<ReturnType<typeof api.listInstalledBofs>>>();
    api.listInstalledBofs.mockReturnValueOnce(refresh.promise);
    setTarget(refreshedTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={target} targetRef={refreshedTargetRef} />);

    await waitFor(() => expect(api.listInstalledBofs).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("textbox", { name: "hostname" })).toBe(hostname);
    expect(hostname).toHaveFocus();
    expect(hostname).toHaveValue("draft.example");
    expect(within(composer).getByRole("button", { name: "Execute" })).toBeDisabled();
    await user.type(hostname, ".com");

    await act(async () => {
      refresh.resolve({ ok: true, value: { ...catalog, target: refreshedTargetRef } });
    });
    expect(screen.getByRole("textbox", { name: "hostname" })).toBe(hostname);
    expect(hostname).toHaveFocus();
    expect(hostname).toHaveValue("draft.example.com");
    expect(within(composer).getByRole("button", { name: "Execute" })).toBeEnabled();
    expect(composer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("sa-nslookup");
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("clears the selected BOF and argument draft when the target identity changes", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "hostname", /sa-nslookup/iu);
    await user.type(within(composer).getByRole("textbox", { name: "hostname" }), "draft.example");

    const nextTarget = { ...target, id: "other-session", hostname: "other-target" };
    const nextTargetRef: TargetRef = { ...targetRef, id: nextTarget.id, fingerprint: "b".repeat(64) };
    setTarget(nextTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={nextTarget} targetRef={nextTargetRef} />);

    const nextComposer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    expect(within(nextComposer).queryByRole("textbox", { name: "hostname" })).not.toBeInTheDocument();
    expect(nextComposer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("Select a BOF");
    await chooseBof(user, nextComposer, "hostname", /sa-nslookup/iu);
    expect(within(nextComposer).getByRole("textbox", { name: "hostname" })).toHaveValue("");
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("preserves the open autocomplete search and argument draft when a background catalog refresh fails", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "hostname", /sa-nslookup/iu);
    const hostname = within(composer).getByRole("textbox", { name: "hostname" });
    const execute = within(composer).getByRole("button", { name: "Execute" });
    await user.type(hostname, "draft.example");
    await user.click(composer.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]')!);
    const search = await screen.findByRole("searchbox", { name: "Search BOFs" });
    await user.clear(search);
    await user.type(search, "directory");

    const refreshedTargetRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    api.listInstalledBofs.mockRejectedValueOnce(new Error("Catalog refresh interrupted."));
    setTarget(refreshedTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={target} targetRef={refreshedTargetRef} />);

    expect(await screen.findByText("Catalog refresh interrupted.")).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search BOFs" })).toBe(search);
    expect(search).toHaveFocus();
    expect(search).toHaveValue("directory");
    expect(hostname).toBeInTheDocument();
    expect(hostname).toHaveValue("draft.example");
    expect(execute).toBeInTheDocument();
    expect(execute).toBeDisabled();
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("clears the selected BOF and argument draft when its catalog argument schema changes", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "hostname", /sa-nslookup/iu);
    await user.type(within(composer).getByRole("textbox", { name: "hostname" }), "draft.example");

    const refreshedTargetRef = { ...targetRef, domainRevision: targetRef.domainRevision + 1 };
    const changedCatalog: BofCatalog = {
      ...catalog,
      target: refreshedTargetRef,
      commands: catalog.commands.map((command) => command.id === "sa-nslookup/sa-nslookup"
        ? { ...command, arguments: command.arguments.map((argument, index) => index === 0 ? { ...argument, name: "domain" } : argument) }
        : command),
    };
    api.listInstalledBofs.mockResolvedValueOnce({ ok: true, value: changedCatalog });
    setTarget(refreshedTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={target} targetRef={refreshedTargetRef} />);

    await waitFor(() => expect(composer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("Select a BOF"));
    expect(within(composer).queryByRole("textbox", { name: "hostname" })).not.toBeInTheDocument();
    expect(within(composer).queryByRole("textbox", { name: "domain" })).not.toBeInTheDocument();
    await chooseBof(user, composer, "hostname", /sa-nslookup/iu);
    expect(within(composer).getByRole("textbox", { name: "domain" })).toHaveValue("");
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("opens a BOF directory and renders its manifest arguments for execution", async () => {
    const user = userEvent.setup();
    const { api } = installApi();
    const localCommand = {
      id: "local_1234/local-probe", packageName: "Local Probe", commandName: "local-probe",
      description: "Probe a directory", available: true,
      arguments: [{ name: "query", description: "Query text", type: "wstring" as const, optional: false }],
    };
    api.chooseBofDirectory.mockResolvedValueOnce({
      ok: true,
      value: {
        catalog: { ...catalog, commands: [...catalog.commands, localCommand] },
        selectedCommandId: localCommand.id,
      },
    });
    renderView();
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await user.click(within(composer).getByRole("button", { name: "Open BOF directory" }));
    await waitFor(() => expect(composer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("local-probe"));
    expect(within(composer).getByRole("textbox", { name: "query" })).toHaveValue("");
    await user.type(within(composer).getByRole("textbox", { name: "query" }), "example.local");
    await user.click(within(composer).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.runBof).toHaveBeenCalledWith({
      commandId: localCommand.id, arguments: ["example.local"], timeoutSeconds: 60,
    }));
  });

  it("keeps the current BOF and argument draft when directory selection is canceled", async () => {
    const user = userEvent.setup();
    const { api } = installApi();
    renderView();
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "directory contents", /sa-dir/iu);
    const argument = within(composer).getByRole("textbox", { name: "targetdir (optional)" });
    await user.clear(argument);
    await user.type(argument, "C:\\draft");
    await user.click(within(composer).getByRole("button", { name: "Open BOF directory" }));
    await waitFor(() => expect(api.chooseBofDirectory).toHaveBeenCalledOnce());
    expect(argument).toHaveValue("C:\\draft");
    expect(composer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("sa-dir");
  });

  it("ignores a directory selection returned after the target changes", async () => {
    const user = userEvent.setup();
    const { api, setTarget } = installApi();
    const picker = deferred<OperationResult<BofDirectorySelection | null>>();
    api.chooseBofDirectory.mockReturnValueOnce(picker.promise);
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await user.click(within(composer).getByRole("button", { name: "Open BOF directory" }));

    const nextTarget = { ...target, id: "other-session", hostname: "other-target" };
    const nextTargetRef: TargetRef = { ...targetRef, id: nextTarget.id, fingerprint: "b".repeat(64) };
    setTarget(nextTargetRef, [], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={nextTarget} targetRef={nextTargetRef} />);
    await act(async () => picker.resolve({
      ok: true,
      value: {
        catalog: { ...catalog, commands: [{
          id: "local_1234/local-probe", packageName: "Local Probe", commandName: "local-probe",
          description: "Probe", available: true, arguments: [],
        }] },
        selectedCommandId: "local_1234/local-probe",
      },
    }));

    expect(composer.querySelector('[data-slot="autocomplete-trigger"]')).toHaveTextContent("Select a BOF");
    expect(within(composer).getByRole("button", { name: "Open BOF directory" })).toBeEnabled();
    expect(api.runBof).not.toHaveBeenCalled();
  });

  it("renders manifest arguments for two installed BOFs and passes ordered typed values", async () => {
    const user = userEvent.setup();
    const { api } = installApi();
    renderView();
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "directory contents", /sa-dir/iu);
    expect(within(composer).getByRole("textbox", { name: "targetdir (optional)" })).toHaveValue(".");
    expect(within(composer).getByRole("spinbutton", { name: "subdirs (optional)" })).toHaveValue(0);
    await user.clear(within(composer).getByRole("textbox", { name: "targetdir (optional)" }));
    await user.type(within(composer).getByRole("textbox", { name: "targetdir (optional)" }), "C:\\Users");
    await user.clear(within(composer).getByRole("spinbutton", { name: "subdirs (optional)" }));
    await user.type(within(composer).getByRole("spinbutton", { name: "subdirs (optional)" }), "1");
    await user.click(within(composer).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.runBof).toHaveBeenCalledWith({ commandId: "sa-dir/sa-dir", arguments: ["C:\\Users", 1], timeoutSeconds: 60 }));
    expect(await screen.findByRole("region", { name: "BOF execution history and output" })).toHaveTextContent("BOF stdout");

    await user.click(within(screen.getByRole("navigation", { name: "BOF execution history" })).getByRole("row", { name: "New Execution" }));
    const nextComposer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, nextComposer, "Resolve a hostname", /sa-nslookup/iu);
    await user.type(within(nextComposer).getByRole("textbox", { name: "hostname" }), "example.com");
    await user.selectOptions(within(nextComposer).getByRole("combobox", { name: "type" }), "28");
    await user.click(within(nextComposer).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.runBof).toHaveBeenCalledWith({ commandId: "sa-nslookup/sa-nslookup", arguments: ["example.com", null, 28], timeoutSeconds: 60 }));
  });

  it("uses an opaque file token and keeps Process style output actions", async () => {
    const user = userEvent.setup();
    const { api, clipboard } = installApi();
    renderView();
    const composer = await screen.findByRole("region", { name: "Execute an Armory BOF" });
    await chooseBof(user, composer, "inject", /inject/iu);
    await user.type(within(composer).getByRole("spinbutton", { name: "pid" }), "4242");
    await user.click(within(composer).getByRole("button", { name: "Choose file for bin" }));
    expect(api.chooseBofArgumentFile).toHaveBeenCalledWith({ commandId: "inject/inject", index: 1 });
    expect(await within(composer).findByText("payload.bin")).toBeInTheDocument();
    await user.click(within(composer).getByRole("button", { name: "Execute" }));
    await waitFor(() => expect(api.runBof).toHaveBeenCalledWith({ commandId: "inject/inject", arguments: [4242, "file-token-1"], timeoutSeconds: 60 }));
    const actions = await screen.findByRole("group", { name: "Output actions" });
    await user.click(within(actions).getByRole("button", { name: "Copy output" }));
    expect(clipboard.writeText).toHaveBeenCalledWith("BOF stdout\n");
    await user.click(within(actions).getByRole("button", { name: "Save stdout" }));
    expect(api.saveBofOutput).toHaveBeenCalledWith({ id: "run-1", stream: "stdout" });
    await user.click(within(actions).getByRole("button", { name: "Add stdout to Loot" }));
    expect(api.addBofOutputToLoot).toHaveBeenCalledWith({ id: "run-1", stream: "stdout", name: "" });
    await user.click(screen.getByRole("radio", { name: "Stderr" }));
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("BOF stderr");
    await user.click(screen.getByRole("switch", { name: "Ignore stderr" }));
    expect(screen.queryByRole("radio", { name: "Stderr" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Execution output transcript")).toHaveTextContent("BOF stdout");
  });

  it("automatically refreshes a selected submitted BOF and stops polling after completion", async () => {
    const pending: BofExecutionRecord = {
      id: "beacon-run-1", startedAt: "2026-09-25T11:00:00.000Z",
      commandId: "sa-dir/sa-dir", commandName: "sa-dir", state: "submitted", taskId: "task-1",
    };
    const { api, setRows } = installApi([pending]);
    api.getBofExecutionResult.mockImplementation(async () => {
      const completed: BofExecutionRecord = {
        ...pending, state: "completed",
        stdout: { data: new TextEncoder().encode("beacon BOF completed\n"), truncated: false },
      };
      setRows([completed]);
      return {
        ok: true as const,
        value: { ...completed, stdout: { ...completed.stdout!, data: Uint8Array.from(completed.stdout!.data) } },
      };
    });
    renderView();
    expect(await screen.findByRole("button", { name: "Refresh result" })).toBeInTheDocument();
    await waitFor(() => expect(api.getBofExecutionResult).toHaveBeenCalledWith({ id: pending.id }), { timeout: 6_000 });
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("beacon BOF completed");
    const callsAfterCompletion = api.getBofExecutionResult.mock.calls.length;
    expect(screen.queryByRole("button", { name: "Refresh result" })).not.toBeInTheDocument();
    expect(callsAfterCompletion).toBe(1);
  });

  it("cancels a submitted BOF polling timer when its view unmounts", async () => {
    const pending: BofExecutionRecord = {
      id: "beacon-run-2", startedAt: "2026-09-25T11:00:00.000Z",
      commandId: "sa-dir/sa-dir", commandName: "sa-dir", state: "submitted", taskId: "task-2",
    };
    const { api } = installApi([pending]);
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    try {
      const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
      expect(await screen.findByRole("button", { name: "Refresh result" })).toBeInTheDocument();
      const pollingTimer = setTimeoutSpy.mock.results.find((result, index) =>
        setTimeoutSpy.mock.calls[index]?.[1] === 3_000 && result.type === "return")?.value;
      expect(pollingTimer).toBeDefined();
      view.unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(pollingTimer);
      expect(api.getBofExecutionResult).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it("replaces high-revision target history with a lower-revision new target without exposing old output", async () => {
    const first: BofExecutionRecord = {
      id: "target-a-run", startedAt: "2026-09-25T11:00:00.000Z", commandId: "sa-dir/sa-dir",
      commandName: "sa-dir", state: "completed",
      stdout: { data: new TextEncoder().encode("private target A output"), truncated: false },
    };
    const second: BofExecutionRecord = {
      id: "target-b-run", startedAt: "2026-09-25T11:01:00.000Z", commandId: "sa-nslookup/sa-nslookup",
      commandName: "sa-nslookup", state: "completed",
      stdout: { data: new TextEncoder().encode("target B output"), truncated: false },
    };
    const nextTarget = { ...target, id: "other-session", hostname: "other-target" };
    const nextTargetRef: TargetRef = {
      ...targetRef, id: nextTarget.id, domainRevision: 1, fingerprint: "b".repeat(64),
    };
    const { setTarget } = installApi([first]);
    setTarget(targetRef, [first], 90);
    const view = render(<BofExecutionView isRefreshing={false} target={target} targetRef={targetRef} />);
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("private target A output");

    setTarget(nextTargetRef, [second], 1);
    view.rerender(<BofExecutionView isRefreshing={false} target={nextTarget} targetRef={nextTargetRef} />);
    expect(screen.queryByText("private target A output")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Execution output transcript")).toHaveTextContent("target B output");
    expect(within(screen.getByRole("navigation", { name: "BOF execution history" })).queryByRole("row", { name: "sa-dir" })).not.toBeInTheDocument();
  });
});
