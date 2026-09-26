import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { DEFAULT_APPLICATION_SETTINGS_STATE, type ApplicationSettingsState } from "../../../shared/application-settings-contracts";
import type { DotNetCatalog } from "../../../shared/dotnet-contracts";
import type { SliverDesktopAPI } from "../../../shared/contracts";
import type { AssemblySource, DotNetExecutionRecord, ExecuteAssemblyDraft, ExecutionActionResult, ExecutionCapability } from "../../../shared/execution-contracts";
import type { SessionSummary, TargetRef } from "../../../shared/target-contracts";
import { renderWithApplicationContextMenu as render } from "../application-context-menu-test-utils";
import { ApplicationSettingsProvider, type ApplicationSettingsAPI } from "../components/ApplicationSettingsProvider";
import { DotNetExecutionView } from "./DotNetExecutionView";

vi.mock("../components/ExecutionOutputTerminal", () => ({
  ExecutionOutputTerminal: ({ bytes, className }: { bytes: Uint8Array; className?: string }) => (
    <pre aria-label="Execution output transcript" className={className}>{new TextDecoder().decode(bytes)}</pre>
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
});

const target: SessionSummary = {
  mode: "session", id: "dotnet-session", name: "target", hostname: "target", hostId: "host-1", username: "operator",
  os: "windows", arch: "amd64", transport: "mtls", remoteAddress: "10.0.0.8:4444",
  activeC2: "mtls://10.0.0.8:4444", executable: "C:\\sliver.exe", version: "1.7.6",
  locale: "en-US", integrity: "user", burned: false, pid: 42, liveness: "active",
};

const targetRef: TargetRef = {
  mode: "session", id: target.id, backendEpoch: 7, domainRevision: 3, fingerprint: "a".repeat(64),
};

const catalog: DotNetCatalog = {
  target: targetRef,
  assemblies: [{
    id: "aliases/seatbelt", commandName: "seatbelt", packageName: "Seatbelt",
    description: "Host survey", fileName: "Seatbelt.exe", isDll: false, available: true,
  }, {
    id: "aliases/sharpview", commandName: "sharpview", packageName: "SharpView",
    description: "Directory survey", fileName: "SharpView.dll", isDll: true, available: true,
  }],
};

const capability: ExecutionCapability = {
  operationId: "execution.assembly", available: true, modes: ["session"], platforms: ["windows"],
  risk: "high-opsec", confirmationRequired: true, credentialBearing: false, artifacts: [],
};

function historyRecord(id: string, assemblyName: string, args: readonly string[], stdout?: string): DotNetExecutionRecord {
  const bytes = new TextEncoder().encode(stdout ?? "");
  return {
    id,
    startedAt: "2026-09-25T20:00:00.000Z",
    assemblyName,
    args,
    sourceKind: "armory",
    state: "completed",
    result: {
      requestId: id, operationId: "execution.assembly", state: "completed", message: "Assembly execution completed.",
      output: bytes.length ? [{
        handle: `output-${id}`, suggestedFileName: "assembly.txt", mediaType: "text/plain",
        size: bytes.length, expiresAt: new Date(Date.now() + 60_000).toISOString(),
        stream: "stdout", truncated: false,
      }] : [],
    },
    ...(bytes.length ? { stdout: { data: bytes, truncated: false } } : {}),
  };
}

function installApi(initialHistory: readonly DotNetExecutionRecord[] = []) {
  let history = initialHistory;
  let revision = 1;
  const api = {
    listDotNetAssemblies: vi.fn(async () => ({ ok: true as const, value: catalog })),
    chooseDotNetAssemblyFile: vi.fn(async () => ({
      ok: true as const,
      value: { token: "local-assembly-token", fileName: "Tool.dll", size: 256, isDll: true },
    })),
    listDotNetExecutionHistory: vi.fn(async () => ({ ok: true as const, value: {
      target: targetRef, revision,
      records: history.map((record) => ({
        ...record,
        args: [...record.args],
        ...(record.stdout ? { stdout: { ...record.stdout, data: Uint8Array.from(record.stdout.data) } } : {}),
        ...(record.stderr ? { stderr: { ...record.stderr, data: Uint8Array.from(record.stderr.data) } } : {}),
      })),
    } })),
    clearDotNetExecutionHistory: vi.fn(async (input: { id?: string }) => {
      history = input.id ? history.filter((record) => record.id !== input.id) : [];
      revision += 1;
      return { ok: true as const };
    }),
    onDotNetExecutionHistoryChanged: vi.fn(() => () => undefined),
    saveExecutionResult: vi.fn(async () => ({ ok: true as const, value: { saved: true, fileName: "assembly.txt" } })),
    addExecutionOutputToLoot: vi.fn(async () => ({ ok: true as const, value: { name: "assembly-stdout" } })),
    getExecutionResult: vi.fn(async (input: { requestId: string }) => ({
      ok: true as const,
      value: { requestId: input.requestId, operationId: "execution.assembly" as const, state: "completed" as const, message: "Done" },
    })),
  };
  Object.defineProperty(window, "sliver", { configurable: true, value: api as unknown as SliverDesktopAPI });
  return api;
}

async function selectAssembly(user: ReturnType<typeof userEvent.setup>, command: string): Promise<void> {
  const form = screen.getByRole("region", { name: "Execute a .NET assembly" });
  const trigger = form.querySelector<HTMLElement>('[data-slot="autocomplete-trigger"]');
  expect(trigger).not.toBeNull();
  await user.click(trigger!);
  const search = await screen.findByRole("searchbox", { name: "Search assemblies" });
  await user.type(search, command);
  await user.click(await screen.findByRole("option", { name: new RegExp(command, "iu") }));
}

describe(".NET execution view", () => {
  it("uses the current terminal font for assembly arguments and host process, including later changes", async () => {
    installApi();
    const initialSettings: ApplicationSettingsState = {
      ...DEFAULT_APPLICATION_SETTINGS_STATE,
      revision: 1,
      terminal: { ...DEFAULT_APPLICATION_SETTINGS_STATE.terminal, fontId: "jetbrains-mono" },
    };
    let onSettingsChanged: ((state: ApplicationSettingsState) => void) | undefined;
    const settingsApi: ApplicationSettingsAPI = {
      getApplicationSettings: vi.fn(async () => initialSettings),
      onApplicationSettingsChanged: vi.fn((listener) => {
        onSettingsChanged = listener;
        return () => undefined;
      }),
    };
    render(
      <ApplicationSettingsProvider api={settingsApi}>
        <DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />
      </ApplicationSettingsProvider>,
    );

    const argumentsField = screen.getByRole("textbox", { name: "Assembly arguments" });
    const hostProcessField = screen.getByRole("textbox", { name: /^Host process$/u });
    await waitFor(() => {
      expect(argumentsField).toHaveStyle({ fontFamily: '"JetBrains Mono", monospace' });
      expect(hostProcessField).toHaveStyle({ fontFamily: '"JetBrains Mono", monospace' });
    });
    act(() => onSettingsChanged?.({
      ...initialSettings,
      revision: 2,
      terminal: { ...initialSettings.terminal, fontId: "cascadia-mono" },
    }));
    expect(argumentsField).toHaveStyle({ fontFamily: '"Cascadia Mono", monospace' });
    expect(hostProcessField).toHaveStyle({ fontFamily: '"Cascadia Mono", monospace' });
  });

  it("selects an Armory assembly and submits quoted CLI arguments as argv", async () => {
    const user = userEvent.setup();
    const api = installApi();
    const onPrepare = vi.fn<(draft: ExecuteAssemblyDraft, source: AssemblySource) => Promise<void>>(async () => undefined);
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={onPrepare} />);
    await waitFor(() => expect(api.listDotNetAssemblies).toHaveBeenCalledOnce());

    const form = screen.getByRole("region", { name: "Execute a .NET assembly" });
    expect(form).toHaveTextContent("2 assemblies for windows/amd64. Type to search or browse.");
    await selectAssembly(user, "seatbelt");
    expect(form).toHaveTextContent("Host survey");
    expect(form).not.toHaveTextContent("2 assemblies for windows/amd64. Type to search or browse.");
    await user.type(screen.getByRole("textbox", { name: "Assembly arguments" }), "-group 'all users' --verbose");
    await user.click(screen.getByRole("button", { name: "Execute" }));

    expect(onPrepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      operationId: "execution.assembly",
      args: ["-group", "all users", "--verbose"],
      process: "notepad.exe",
      architecture: "x84",
      isDll: false,
      timeoutSeconds: 60,
    }), { kind: "armory", id: "aliases/seatbelt" });
  });

  it("uses a HeroUI architecture selector and submits the selected architecture", async () => {
    const user = userEvent.setup();
    installApi();
    const onPrepare = vi.fn<(draft: ExecuteAssemblyDraft, source: AssemblySource) => Promise<void>>(async () => undefined);
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={onPrepare} />);

    const architectureTrigger = screen.getByRole("button", { name: /Assembly architecture$/u });
    expect(architectureTrigger).toHaveTextContent("AnyCPU (x84)");
    await user.click(architectureTrigger);
    await user.click(await screen.findByRole("option", { name: "x64" }));
    expect(architectureTrigger).toHaveTextContent("x64");

    await selectAssembly(user, "seatbelt");
    await user.click(screen.getByRole("button", { name: "Execute" }));
    expect(onPrepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ architecture: "x64" }), { kind: "armory", id: "aliases/seatbelt" });
  });

  it("opens a local DLL, requires its entrypoint, and forwards in-process options", async () => {
    const user = userEvent.setup();
    const api = installApi();
    const onPrepare = vi.fn<(draft: ExecuteAssemblyDraft, source: AssemblySource) => Promise<void>>(async () => undefined);
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={onPrepare} />);

    await user.click(screen.getByRole("button", { name: "Open assembly file" }));
    await waitFor(() => expect(api.chooseDotNetAssemblyFile).toHaveBeenCalledOnce());
    expect(screen.getByText("Tool.dll")).toBeInTheDocument();
    const form = screen.getByRole("region", { name: "Execute a .NET assembly" });
    expect(form).toHaveTextContent("Local file · 256 B");
    expect(form).not.toHaveTextContent("2 assemblies for windows/amd64. Type to search or browse.");
    await user.type(screen.getByRole("textbox", { name: "Assembly arguments" }), "-path \"C:\\Program Files\\Tool\"");
    await user.click(screen.getByRole("button", { name: "Execute" }));
    expect(onPrepare).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("DLL assemblies require a class and method");

    await user.type(screen.getByRole("textbox", { name: "Class name" }), "Example.Tool");
    await user.type(screen.getByRole("textbox", { name: "Method name" }), "Run");
    await user.click(screen.getByRole("switch", { name: /Run in process/u }));
    await user.type(screen.getByRole("textbox", { name: ".NET runtime" }), "v4.0.30319");
    await user.click(screen.getByRole("switch", { name: "AMSI bypass" }));
    await user.click(screen.getByRole("button", { name: "Execute" }));

    expect(onPrepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      args: ["-path", "C:\\Program Files\\Tool"],
      className: "Example.Tool",
      method: "Run",
      isDll: true,
      inProcess: true,
      runtime: "v4.0.30319",
      amsiBypass: true,
    }), { kind: "file", token: "local-assembly-token" });
    expect(screen.queryByText("Tool.dll")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Execute" })).toBeDisabled();
  });

  it("warns about the child-loader CLI limit", async () => {
    const user = userEvent.setup();
    installApi();
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);

    await user.type(screen.getByRole("textbox", { name: "Assembly arguments" }), "x".repeat(257));
    expect(screen.getByRole("alert")).toHaveTextContent("limits joined assembly arguments to 256 bytes");
    await user.clear(screen.getByRole("textbox", { name: "Assembly arguments" }));
    await user.type(screen.getByRole("textbox", { name: "Assembly arguments" }), "é".repeat(129));
    expect(screen.getByRole("alert")).toHaveTextContent("These 258 bytes may be truncated");
    await user.click(screen.getByRole("switch", { name: /Run in process/u }));
    expect(screen.queryByText(/limits joined assembly arguments to 256 bytes/u)).not.toBeInTheDocument();
  });

  it("keeps the composer and selected-result headers above the scroll-shadowed content", async () => {
    const user = userEvent.setup();
    installApi([historyRecord("first-request", "seatbelt.exe", ["alpha"], "captured output")]);
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);

    const rail = await screen.findByRole("navigation", { name: ".NET execution history" });
    const historyRow = await within(rail).findByRole("row", { name: /seatbelt\.exe/u });
    await user.click(within(rail).getByRole("row", { name: "New Execution" }));

    const composer = screen.getByRole("region", { name: "Execute a .NET assembly" });
    const content = within(composer).getByRole("region", { name: ".NET execution content" });
    const composerHeader = within(composer).getByRole("heading", { name: "Execute a .NET assembly" }).closest("header");
    expect(content).toHaveAttribute("data-slot", "scroll-shadow");
    expect(content).toHaveAttribute("data-scroll-shadow-size", "28");
    expect(content).toHaveAttribute("tabindex", "0");
    expect(content).toHaveClass("min-h-0", "flex-1", "overflow-y-auto", "overscroll-contain");
    expect(composerHeader).not.toBeNull();
    expect(composerHeader?.parentElement).toBe(composer);
    expect(composerHeader).toHaveClass("sticky", "top-0", "z-10", "bg-surface");
    expect(composerHeader).toContainElement(within(composer).getByRole("button", { name: "Execute" }));
    expect(content).not.toContainElement(composerHeader);
    expect(content).toContainElement(within(composer).getByRole("textbox", { name: "Assembly arguments" }));

    content.scrollTop = 64;
    await user.click(historyRow);
    const details = screen.getByRole("region", { name: ".NET execution details" });
    const resultHeader = within(details).getByRole("heading", { name: "seatbelt.exe" }).closest("header");
    expect(resultHeader?.parentElement).toBe(details);
    expect(resultHeader).toHaveClass("sticky", "top-0", "z-10", "bg-surface");
    expect(resultHeader).toContainElement(within(details).getByRole("button", { name: "Clear selected" }));
    expect(content).not.toContainElement(resultHeader);
    expect(content).toContainElement(within(details).getByLabelText("Execution details"));
    expect(content).not.toHaveClass("pb-4", "sm:pb-5");
    const transcript = within(details).getByLabelText("Execution output transcript");
    expect(transcript.parentElement).toHaveClass("flex", "flex-1", "flex-col");
    expect(transcript).toHaveClass("min-h-0", "flex-1");
    await user.click(within(details).getByRole("radio", { name: "Stderr" }));
    expect(within(details).getByRole("status", { name: "" })).toHaveClass("min-h-40", "flex-1");
    expect(content.scrollTop).toBe(0);
  });

  it("shows the BOF-style history rail, restores earlier arguments and output, and clears history", async () => {
    const user = userEvent.setup();
    const first = historyRecord("first-request", "seatbelt.exe", ["alpha", "two words"], "first stdout\n");
    const latest = historyRecord("latest-request", "sharpview.dll", ["beta"], "latest stdout\n");
    const api = installApi([latest, first]);
    const result: ExecutionActionResult = latest.result!;
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} result={result} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);

    const workspace = screen.getByRole("region", { name: ".NET assembly execution" });
    const rail = await screen.findByRole("navigation", { name: ".NET execution history" });
    await waitFor(() => expect(workspace).toHaveTextContent("History · 2"));
    const details = await screen.findByRole("region", { name: ".NET execution details" });
    expect(details).toHaveTextContent("sharpview.dll");
    expect(within(details).getByLabelText("Execution details")).toHaveTextContent("Assembly");
    expect(within(details).getByLabelText("Execution details")).toHaveTextContent("Arguments");
    expect(within(details).queryByText("Source", { exact: true })).not.toBeInTheDocument();
    expect(within(details).queryByText("Request", { exact: true })).not.toBeInTheDocument();
    expect(details).not.toHaveTextContent("Assembly execution completed.");
    expect(within(details).getByLabelText("Execution output transcript")).toHaveTextContent("latest stdout");
    await user.click(within(rail).getByRole("row", { name: /seatbelt\.exe/u }));
    expect(details).toHaveTextContent('alpha "two words"');
    expect(within(details).getByLabelText("Execution output transcript")).toHaveTextContent("first stdout");
    await user.click(within(details).getByRole("button", { name: "Save stdout" }));
    expect(api.saveExecutionResult).toHaveBeenCalledExactlyOnceWith({ requestId: "first-request", stream: "stdout" });

    await user.click(within(rail).getByRole("row", { name: "New Execution" }));
    expect(screen.getByRole("region", { name: "Execute a .NET assembly" })).toBeInTheDocument();
    await user.click(within(workspace).getByRole("button", { name: "Clear history" }));
    await waitFor(() => expect(workspace).toHaveTextContent("History · 0"));
    expect(api.clearDotNetExecutionHistory).toHaveBeenCalledExactlyOnceWith({});
  });

  it("rejects a history snapshot for another exact target and clears its output bytes", async () => {
    const stale = historyRecord("stale-request", "old-tool.exe", ["secret"], "old output\n");
    const api = installApi();
    api.listDotNetExecutionHistory.mockResolvedValueOnce({ ok: true, value: {
      target: { ...targetRef, id: "other-session" }, revision: 10, records: [{ ...stale, args: [...stale.args] }],
    } });
    render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);

    await waitFor(() => expect(api.listDotNetExecutionHistory).toHaveBeenCalledOnce());
    expect(screen.getByRole("region", { name: ".NET assembly execution" })).toHaveTextContent("History · 0");
    expect(screen.queryByText("old-tool.exe")).not.toBeInTheDocument();
    expect([...stale.stdout!.data]).toEqual(new Array(stale.stdout!.data.length).fill(0));
  });

  it("adds the selected output and a right-clicked history row to Loot independently", async () => {
    const user = userEvent.setup();
    const selected = historyRecord("selected-request", "selected.exe", ["selected"], "selected stdout\n");
    const clicked = historyRecord("clicked-request", "clicked.exe", ["clicked"], "clicked stdout\n");
    const api = installApi([selected, clicked]);
    const view = render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);
    const details = await screen.findByRole("region", { name: ".NET execution details" });
    await waitFor(() => expect(within(details).getByLabelText("Execution output transcript")).toHaveTextContent("selected stdout"));

    const rail = screen.getByRole("navigation", { name: ".NET execution history" });
    fireEvent.contextMenu(within(rail).getByRole("row", { name: /clicked\.exe/u }));
    view.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    await user.click(within(menu).getByRole("menuitem", { name: "Add stdout to Loot" }));
    await waitFor(() => expect(api.addExecutionOutputToLoot).toHaveBeenCalledWith({ requestId: "clicked-request", stream: "stdout", name: "" }));
    expect(within(details).getByLabelText("Execution output transcript")).toHaveTextContent("selected stdout");

    await user.click(within(details).getByRole("button", { name: "Add stdout to Loot" }));
    await waitFor(() => expect(api.addExecutionOutputToLoot).toHaveBeenCalledWith({ requestId: "selected-request", stream: "stdout", name: "" }));
  });

  it("disables Loot actions when the retained output artifact has expired", async () => {
    const expired = historyRecord("expired-request", "expired.exe", [], "retained stdout\n");
    const record: DotNetExecutionRecord = {
      ...expired,
      result: { ...expired.result!, output: expired.result!.output!.map((item) => ({ ...item, expiresAt: "2020-01-01T00:00:00.000Z" })) },
    };
    const api = installApi([record]);
    const view = render(<DotNetExecutionView capability={capability} isExecuting={false} isPreparing={false} isRefreshing={false} target={target} targetRef={targetRef} onPrepare={async () => undefined} />);
    const details = await screen.findByRole("region", { name: ".NET execution details" });
    expect(within(details).getByRole("button", { name: "Add stdout to Loot" })).toBeDisabled();
    expect(details).toHaveTextContent("Saving and Loot are unavailable after the output expires");

    const rail = screen.getByRole("navigation", { name: ".NET execution history" });
    fireEvent.contextMenu(within(rail).getByRole("row", { name: /expired\.exe/u }));
    view.contextMenu.emit();
    const menu = await screen.findByRole("menu", { name: "Application context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Add stdout to Loot" })).toHaveAttribute("aria-disabled", "true");
    expect(api.addExecutionOutputToLoot).not.toHaveBeenCalled();
  });
});
